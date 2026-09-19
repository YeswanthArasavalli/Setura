/**
 * cancel-booking/index.ts
 * Cancel booking with optional refund.
 * Idempotent on already-cancelled bookings.
 */

import { handleCors } from "../_shared/cors.ts";
import { requireRole, resolveAuth } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/db.ts";
import { createRequestLogger } from "../_shared/logger.ts";
import { createTraceContext, elapsedMs } from "../_shared/tracing.ts";
import { createMetrics } from "../_shared/metrics.ts";
import { logAuditEvent } from "../_shared/audit.ts";
import { handleErrorResponse, successResponse } from "../_shared/response.ts";
import {
  ConcurrencyError,
  ForbiddenError,
  InternalError,
  ValidationError,
} from "../_shared/errors.ts";
import { parseBody } from "../_shared/validation.ts";
import type { BookingStatus } from "../_shared/types.ts";

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { formatE164 } from "../_shared/phone.ts";

const ENDPOINT = "cancel-booking";

const UNCANCELLABLE: BookingStatus[] = [
  "completed",
  "no_show",
  "rescheduled",
];

const Schema = z.object({
  bookingId: z.string().uuid(),
  cancellationReason: z
    .string()
    .min(3)
    .max(500),
  initiateRefund: z
    .boolean()
    .default(false),
});

type BookingRow = {
  id: string;
  status: BookingStatus;
  hospital_id: string;

  patient_name: string | null;
  patient_phone: string | null;

  payment_completed: boolean;

  /**
   * IMPORTANT:
   * Refund ONLY booking fee.
   * Do NOT refund consultation fee.
   */
  booking_fee_inr: number | null;

  token_number: number | null;
  appointment_date: string | null;
  queue_session_id: string | null;
};

Deno.serve(
  async (
    req: Request,
  ): Promise<Response> => {
    const cors = handleCors(req);
    if (cors) return cors;

    if (req.method !== "POST") {
      return new Response(
        "Method Not Allowed",
        { status: 405 },
      );
    }

    const trace = createTraceContext(req);

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
        "global_admin",
      ]);

      const body = await parseBody(
        req,
        Schema,
      );

      const db = getServiceClient();

      const {
        data: booking,
        error: fetchError,
      } = await db
        .from("bookings")
        .select(`
          id,
          status,
          hospital_id,
          patient_name,
          patient_phone,
          payment_completed,
          booking_fee_inr,
          token_number,
          appointment_date,
          queue_session_id
        `)
        .eq(
          "id",
          body.bookingId,
        )
        .eq(
          "is_deleted",
          false,
        )
        .maybeSingle();

      if (fetchError) {
        throw new InternalError(
          "Failed to load booking",
          {
            error: fetchError.message,
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

      const b = booking as BookingRow;

      if (
        b.hospital_id !==
          hospitalId
      ) {
        throw new ForbiddenError(
          "Booking belongs to different hospital",
        );
      }

      const current = b.status;

      if (
        current ===
          "cancelled"
      ) {
        return successResponse(
          {
            bookingId: body.bookingId,
            cancelled: true,
            alreadyCancelled: true,
          },
          trace.correlationId,
          req,
        );
      }

      if (
        UNCANCELLABLE.includes(
          current,
        )
      ) {
        throw new ValidationError(
          `Cannot cancel booking in '${current}' state`,
          {
            status: [
              `Terminal state '${current}'`,
            ],
          },
        );
      }

      const now = new Date().toISOString();

      const {
        data: updated,
        error: updateError,
      } = await db
        .from("bookings")
        .update({
          status: "cancelled",
          cancellation_reason: body.cancellationReason,
          cancelled_at: now,
          updated_at: now,
        })
        .eq(
          "id",
          body.bookingId,
        )
        .eq(
          "status",
          current,
        )
        .select("id")
        .maybeSingle();

      if (updateError) {
        throw new InternalError(
          "Cancel failed",
          {
            error: updateError.message,
          },
        );
      }

      if (!updated) {
        throw new ConcurrencyError(
          "Booking was modified concurrently",
          {
            bookingId: body.bookingId,
          },
        );
      }

      let refundInitiated = false;

      if (
        body.initiateRefund &&
        b.payment_completed
      ) {
        const refundAmount = Number(
          b.booking_fee_inr ??
            0,
        );

        if (
          refundAmount > 0
        ) {
          const {
            error: refundError,
          } = await db.rpc(
            "initiate_refund",
            {
              p_booking_id: body.bookingId,

              p_refund_amount_inr: refundAmount,

              p_refund_reason: body.cancellationReason,

              p_initiated_by: auth.userId,
            },
          );

          if (
            refundError
          ) {
            logger.warn(
              "Refund initiation failed",
              {
                bookingId: body.bookingId,
                error: refundError.message,
              },
            );
          } else {
            refundInitiated = true;
          }
        }
      }

      if (
        b.queue_session_id
      ) {
        try {
          const {
            error: queueError,
          } = await db.rpc(
            "recalculate_queue_position",
            {
              p_booking_id: body.bookingId,
            },
          );

          if (
            queueError
          ) {
            logger.warn(
              "Queue recalculation failed",
              {
                bookingId: body.bookingId,
                error: queueError.message,
              },
            );
          }
        } catch (err) {
          logger.warn(
            "Queue recalculation exception",
            err,
          );
        }
      }

      if (
        b.patient_phone
      ) {
        const {
          error: enqueueError,
        } = await db.rpc(
          "enqueue_job",
          {
            p_job_type: "send_whatsapp_message",

            p_payload: {
              template_name: "booking_cancelled",

              booking_id: body.bookingId,

              phone: await formatE164(
                db,
                b.patient_phone,
                hospitalId,
              ),

              patient_name: b.patient_name,

              token_number: b.token_number,

              cancellation_reason: body.cancellationReason,
            },

            p_priority: "high",

            p_scheduled_at: now,

            p_idempotency_key: `wa_cancel_${body.bookingId}`,

            p_hospital_id: hospitalId,

            p_booking_id: body.bookingId,
          },
        );

        if (
          enqueueError
        ) {
          logger.warn(
            "Cancellation WhatsApp enqueue failed",
            {
              bookingId: body.bookingId,
              error: enqueueError.message,
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

            actionType: "booking_cancel",

            severity: "medium",

            oldData: {
              status: current,
            },

            newData: {
              status: "cancelled",
              reason: body.cancellationReason,
              refundInitiated,
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
        "booking.cancelled",
      );

      metrics.increment(
        "booking.cancel.success",
      );

      if (
        refundInitiated
      ) {
        metrics.increment(
          "booking.cancelled.refund",
        );
      }

      metrics.timing(
        "request.total",
        elapsedMs(trace),
      );

      metrics.flush(
        logger,
      );

      return successResponse(
        {
          bookingId: body.bookingId,

          cancelled: true,

          alreadyCancelled: false,

          refundInitiated,
        },
        trace.correlationId,
        req,
      );
    } catch (err) {
      metrics.increment(
        "booking.cancel.error",
      );

      logger.error(
        "cancel-booking failed",
        err,
        {
          durationMs: elapsedMs(trace),
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
