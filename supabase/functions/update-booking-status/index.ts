/**
 * update-booking-status/index.ts
 *
 * Full booking state machine.
 */

import { handleCors } from "../_shared/cors.ts";
import { requireRole, resolveAuth } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/db.ts";
import { createRequestLogger } from "../_shared/logger.ts";
import { createTraceContext, elapsedMs } from "../_shared/tracing.ts";
import { createMetrics } from "../_shared/metrics.ts";
import { logAuditEvent } from "../_shared/audit.ts";
import { broadcastQueueAdvance } from "../_shared/realtime.ts";
import { handleErrorResponse, successResponse } from "../_shared/response.ts";
import {
  ConcurrencyError,
  ForbiddenError,
  InternalError,
  ValidationError,
} from "../_shared/errors.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { parseBody } from "../_shared/validation.ts";
import { formatE164 } from "../_shared/phone.ts";
import type { BookingStatus } from "../_shared/types.ts";
import { TERMINAL_STATES, TRANSITIONS } from "../_shared/booking_state.ts";
import { triggerSlaRefresh } from "../_shared/queue/queue_runtime.ts";

const ENDPOINT = "update-booking-status";

// Status changes that affect SLA tracking (wait time, completion,
// no-show and cancellation rates).
const SLA_RELEVANT = new Set<BookingStatus>([
  "called",
  "in_consultation",
  "completed",
  "no_show",
  "cancelled",
]);

const NOTIFY_ON: Partial<
  Record<
    BookingStatus,
    string
  >
> = {
  called: "patient_called",

  in_consultation: "consultation_started",

  completed: "consultation_completed",

  cancelled: "booking_cancelled",

  no_show: "booking_no_show",
};

const Schema = z.object({
  bookingId: z.string().uuid(),

  newStatus: z.enum([
    "checked_in",
    "waiting",
    "called",
    "in_consultation",
    "completed",
    "cancelled",
    "no_show",
    "skipped",
  ]),

  notes: z.string()
    .max(500)
    .optional(),
});

interface BookingRecord {
  id: string;
  status: BookingStatus;
  hospital_id: string;
  assigned_doctor_id: string | null;
  queue_session_id: string | null;
  token_number: number | null;
  patient_name: string;
  patient_phone: string | null;
  appointment_date: string;
  metadata?:
    | Record<
      string,
      unknown
    >
    | null;
}

Deno.serve(
  async (
    req: Request,
  ): Promise<Response> => {
    const cors = handleCors(req);

    if (cors) {
      return cors;
    }

    if (
      req.method !==
        "POST"
    ) {
      return new Response(
        "Method Not Allowed",
        {
          status: 405,
        },
      );
    }

    const trace = createTraceContext(
      req,
    );

    const logger = createRequestLogger(
      req,
      ENDPOINT,
    ).child({
      correlationId: trace.correlationId,
    });

    const metrics = createMetrics(
      ENDPOINT,
      trace.correlationId,
    );

    let bookingId:
      | string
      | undefined;

    try {
      const hospitalId = req.headers.get(
        "X-Hospital-ID",
      );

      if (!hospitalId) {
        throw new ValidationError(
          "Missing X-Hospital-ID header",
          {
            header: [
              "Required",
            ],
          },
        );
      }

      const auth = await resolveAuth(
        req,
        hospitalId,
        logger,
      );

      requireRole(auth, [
        "receptionist",
        "hospital_admin",
        "doctor",
        "global_admin",
      ]);

      const body = await parseBody(
        req,
        Schema,
      );

      bookingId = body.bookingId;

      const db = getServiceClient();

      const {
        data: booking,
        error: fetchErr,
      } = await db
        .from("bookings")
        .select(`
          id,
          status,
          hospital_id,
          assigned_doctor_id,
          queue_session_id,
          token_number,
          patient_name,
          patient_phone,
          appointment_date,
          metadata
        `)
        .eq(
          "id",
          body.bookingId,
        )
        .eq(
          "is_deleted",
          false,
        )
        .maybeSingle<BookingRecord>();

      if (fetchErr) {
        throw new InternalError(
          "Failed to load booking",
          {
            error: fetchErr.message,
          },
        );
      }

      if (!booking) {
        throw new ValidationError(
          "Booking not found",
          {
            bookingId: [
              "Not found",
            ],
          },
        );
      }

      if (
        booking.hospital_id !==
          hospitalId
      ) {
        throw new ForbiddenError(
          "Booking belongs to different hospital",
        );
      }

      const current = booking.status;

      const next = body.newStatus as BookingStatus;

      if (
        auth.role ===
          "doctor"
      ) {
        if (
          booking.assigned_doctor_id !==
            auth.userId
        ) {
          throw new ForbiddenError(
            "Doctors can only update their own patients",
          );
        }

        const doctorAllowed = new Set<
          BookingStatus
        >([
          "in_consultation",
          "completed",
        ]);

        if (
          !doctorAllowed.has(
            next,
          )
        ) {
          throw new ForbiddenError(
            `Doctors cannot set status to '${next}'`,
          );
        }
      }

      if (
        current === next
      ) {
        return successResponse(
          {
            bookingId: body.bookingId,
            status: next,
            changed: false,
          },
          trace.correlationId,
          req,
        );
      }

      if (
        TERMINAL_STATES.has(
          current,
        )
      ) {
        throw new ValidationError(
          `Booking in terminal state '${current}'`,
          {
            status: [
              `Cannot transition from '${current}'`,
            ],
          },
        );
      }

      if (
        !(
          TRANSITIONS[
            current
          ] ?? []
        ).includes(next)
      ) {
        throw new ValidationError(
          `Invalid transition: '${current}' → '${next}'`,
          {
            status: [
              `Allowed from '${current}': ${
                (
                  TRANSITIONS[
                    current
                  ] ?? []
                ).join(
                  ", ",
                ) ||
                "none"
              }`,
            ],
          },
        );
      }

      const existingMetadata = booking.metadata ??
        {};

      const updatePayload = {
        status: next,
        updated_at: new Date().toISOString(),

        ...(body.notes
          ? {
            metadata: {
              ...existingMetadata,
              status_note: body.notes,
            },
          }
          : {}),
      };

      const {
        data: updated,
        error: updErr,
      } = await db
        .from("bookings")
        .update(
          updatePayload,
        )
        .eq(
          "id",
          body.bookingId,
        )
        .eq(
          "status",
          current,
        )
        .eq(
          "is_deleted",
          false,
        )
        .select("id")
        .maybeSingle();

      if (updErr) {
        throw new InternalError(
          "Status update failed",
          {
            error: updErr.message,
          },
        );
      }

      if (!updated) {
        const {
          data: curr,
        } = await db
          .from(
            "bookings",
          )
          .select(
            "status",
          )
          .eq(
            "id",
            body.bookingId,
          )
          .maybeSingle();

        throw new ConcurrencyError(
          `Booking status concurrently changed to '${
            curr?.status ??
              "unknown"
          }'.`,
          {
            bookingId: body.bookingId,
          },
        );
      }

      if (
        booking.queue_session_id &&
        typeof booking.token_number ===
          "number"
      ) {
        try {
          await broadcastQueueAdvance(
            booking.queue_session_id,
            booking.token_number,
            logger,
          );
        } catch (err) {
          logger.warn(
            "Realtime broadcast failed",
            err,
          );
        }
      }

      // Phase 1.2: debounced SLA recompute on queue-relevant
      // transitions. Best-effort, never blocks the transition.
      if (SLA_RELEVANT.has(next)) {
        await triggerSlaRefresh(
          db,
          hospitalId,
          booking.appointment_date,
          logger,
        );
      }

      const notifTemplate = NOTIFY_ON[next];

      if (
        notifTemplate &&
        booking.patient_phone
      ) {
        const {
          error: notificationError,
        } = await db.rpc(
          "enqueue_job",
          {
            p_job_type: "send_whatsapp_message",

            p_payload: {
              template_name: notifTemplate,
              booking_id: body.bookingId,
              phone: await formatE164(
                db,
                booking.patient_phone,
                hospitalId,
              ),
              patient_name: booking.patient_name,
              token_number: booking.token_number,
            },

            p_priority: next ===
                "called"
              ? "high"
              : "normal",

            p_scheduled_at: new Date().toISOString(),

            p_idempotency_key: `wa_${notifTemplate}_${body.bookingId}`,

            p_hospital_id: hospitalId,

            p_booking_id: body.bookingId,
          },
        );

        if (
          notificationError
        ) {
          logger.warn(
            "Failed to enqueue notification",
            {
              error: notificationError.message,
              bookingId: body.bookingId,
            },
          );
        }
      }

      if (
        next ===
          "completed" &&
        booking.patient_phone
      ) {
        const feedbackAt = new Date(
          Date.now() +
            30 *
              60_000,
        ).toISOString();

        const {
          error: feedbackError,
        } = await db.rpc(
          "enqueue_job",
          {
            p_job_type: "send_whatsapp_message",

            p_payload: {
              template_name: "feedback_request",

              booking_id: body.bookingId,

              phone: await formatE164(
                db,
                booking.patient_phone,
                hospitalId,
              ),
            },

            p_priority: "low",

            p_scheduled_at: feedbackAt,

            p_idempotency_key: `wa_feedback_${body.bookingId}`,

            p_hospital_id: hospitalId,

            p_booking_id: body.bookingId,
          },
        );

        if (
          feedbackError
        ) {
          logger.warn(
            "Failed to enqueue feedback request",
            {
              error: feedbackError.message,
            },
          );
        }
      }

      try {
        await logAuditEvent(
          {
            hospitalId,

            actorUserId: auth.userId,

            entityType: "booking",

            entityId: body.bookingId,

            actionType: "booking_status_change",

            severity: next ===
                "completed"
              ? "medium"
              : "low",

            oldData: {
              status: current,
            },

            newData: {
              status: next,
              notes: body.notes,
            },
          },
          logger,
        );
      } catch (err) {
        logger.warn(
          "Audit logging failed",
          err,
        );
      }

      metrics.increment(
        `booking.status.${next}`,
      );

      metrics.record(
        "booking.transition",
        1,
      );

      metrics.record(
        "booking.token",
        booking.token_number ??
          0,
      );

      metrics.timing(
        "request.total",
        elapsedMs(trace),
      );

      // P0.3: API usage counter (best-effort)
      const { error: usageError } = await db.rpc(
        "record_subscription_usage",
        {
          p_hospital_id: hospitalId,
          p_metric: "api_call",
        },
      );

      if (usageError) {
        logger.warn("API usage counter update failed", {
          hospitalId,
          error: usageError.message,
        });
      }

      metrics.flush(
        logger,
      );

      return successResponse(
        {
          bookingId: body.bookingId,
          status: next,
          changed: true,
        },
        trace.correlationId,
        req,
      );
    } catch (err) {
      metrics.increment(
        "booking.status.error",
      );

      logger.error(
        "update-booking-status failed",
        err,
        {
          bookingId,
          durationMs: elapsedMs(
            trace,
          ),
        },
      );

      return handleErrorResponse(
        err,
        trace.correlationId,
        req,
      );
    }
  },
);
