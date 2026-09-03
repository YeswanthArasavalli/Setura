/**
 * queue-next-patient/index.ts
 *
 * Advance queue. advance_queue() uses SKIP LOCKED internally.
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
  ForbiddenError,
  InternalError,
  ValidationError,
} from "../_shared/errors.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { parseBody } from "../_shared/validation.ts";
import { formatE164 } from "../_shared/phone.ts";
import {
  markQueueCompleted,
  notifyQueuePositions,
  triggerSlaRefresh,
} from "../_shared/queue/queue_runtime.ts";

const ENDPOINT = "queue-next-patient";

const Schema = z.object({
  queueSessionId: z.string().uuid(),
});

interface QueueSession {
  id: string;
  hospital_id: string;
  is_active: boolean;
  is_paused: boolean;
  session_date: string;
  current_live_token: number;
  max_tokens: number;
}

interface Booking {
  id: string;
  patient_name: string;
  patient_phone: string | null;
  token_number: number;
  status: string;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
    });
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
    const hospitalId = req.headers.get("X-Hospital-ID");

    if (!hospitalId) {
      throw new ValidationError(
        "Missing X-Hospital-ID header",
        {
          header: ["Required"],
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

    /**
     * Load queue session
     */
    const {
      data: session,
      error: sessErr,
    } = await db
      .from("queue_sessions")
      .select(`
        id,
        hospital_id,
        is_active,
        is_paused,
        session_date,
        current_live_token,
        max_tokens
      `)
      .eq("id", body.queueSessionId)
      .maybeSingle<QueueSession>();

    if (sessErr) {
      throw new InternalError(
        "Failed to load queue session",
        {
          error: sessErr.message,
        },
      );
    }

    if (!session) {
      throw new ValidationError(
        "Queue session not found",
        {
          queueSessionId: ["Not found"],
        },
      );
    }

    if (
      session.hospital_id !== hospitalId
    ) {
      throw new ForbiddenError(
        "Session belongs to different hospital",
      );
    }

    if (!session.is_active) {
      throw new ValidationError(
        "Queue session is not active",
        {
          queueSessionId: [
            "Session has ended",
          ],
        },
      );
    }

    // Phase 1.2: paused queues refuse to advance.
    if (session.is_paused) {
      throw new ValidationError(
        "Queue is paused",
        {
          queueSessionId: [
            "Resume the queue before advancing",
          ],
        },
      );
    }

    /**
     * Advance queue
     */
    const {
      data: newToken,
      error: advErr,
    } = await db.rpc(
      "advance_queue",
      {
        p_queue_session_id: body.queueSessionId,
      },
    );

    if (advErr) {
      logger.error(
        "advance_queue failed",
        {
          queueSessionId: body.queueSessionId,
          error: advErr.message,
        },
      );

      // Defense-in-depth: the RPC also enforces the pause guard.
      if (advErr.message.includes("QUEUE_PAUSED")) {
        throw new ValidationError(
          "Queue is paused",
          {
            queueSessionId: [
              "Resume the queue before advancing",
            ],
          },
        );
      }

      throw new InternalError(
        "Queue advance failed",
        {
          error: advErr.message,
        },
      );
    }

    /**
     * P0.3: queue operation usage (best-effort)
     */
    const { error: usageError } = await db.rpc(
      "record_subscription_usage",
      {
        p_hospital_id: hospitalId,
        p_metric: "queue_operation",
      },
    );

    if (usageError) {
      logger.warn("Queue usage counter update failed", {
        hospitalId,
        error: usageError.message,
      });
    }

    /**
     * Queue exhausted
     */
    if (
      newToken === null ||
      newToken === undefined
    ) {
      // Phase 1.2: broadcast the queue completion event
      // (idempotent - skipped when already the latest event).
      const completed = await markQueueCompleted(
        db,
        body.queueSessionId,
        logger,
      );

      if (completed) {
        await triggerSlaRefresh(
          db,
          hospitalId,
          session.session_date,
          logger,
        );
      }

      metrics.increment(
        "queue.exhausted",
      );

      metrics.timing(
        "request.total",
        elapsedMs(trace),
      );

      metrics.flush(logger);

      return successResponse(
        {
          queueExhausted: true,
          nextToken: null,
          queueCompletedEvent: completed,
          message: "No more patients in queue",
        },
        trace.correlationId,
        req,
      );
    }

    const nextToken = Number(newToken);

    /**
     * Load called booking
     */
    const {
      data: bookings,
      error: bookingErr,
    } = await db
      .from("bookings")
      .select(`
        id,
        patient_name,
        patient_phone,
        token_number,
        status
      `)
      .eq(
        "queue_session_id",
        body.queueSessionId,
      )
      .eq(
        "token_number",
        nextToken,
      )
      .eq(
        "status",
        "called",
      )
      .limit(1);

    if (bookingErr) {
      logger.warn(
        "Failed to load called booking",
        {
          error: bookingErr.message,
        },
      );
    }

    const calledBooking: Booking | null = bookings?.[0] ?? null;

    /**
     * Realtime broadcast
     * Never block queue progression.
     */
    try {
      await broadcastQueueAdvance(
        body.queueSessionId,
        nextToken,
        logger,
      );
    } catch (err) {
      logger.warn(
        "Realtime broadcast failed",
        err,
      );
    }

    /**
     * Phase 1.2: proactive position updates to the next waiting
     * patients (feature-flag gated, idempotent job keys). Never
     * block queue progression.
     */
    try {
      await notifyQueuePositions(
        db,
        {
          ...session,
          pause_reason: null,
          doctor_id: null,
        },
        logger,
      );
    } catch (err) {
      logger.warn(
        "Queue position notify failed",
        err,
      );
    }

    /**
     * Phase 1.2: debounced SLA recompute after each advance.
     */
    await triggerSlaRefresh(
      db,
      hospitalId,
      session.session_date,
      logger,
    );

    /**
     * WhatsApp notification
     * Never block queue progression.
     */
    if (
      calledBooking?.patient_phone
    ) {
      const {
        error: enqueueError,
      } = await db.rpc(
        "enqueue_job",
        {
          p_job_type: "send_whatsapp_message",

          p_payload: {
            template_name: "patient_called",

            booking_id: calledBooking.id,

            phone: await formatE164(
              db,
              calledBooking.patient_phone,
              hospitalId,
            ),

            patient_name: calledBooking.patient_name,

            token_number: nextToken,
          },

          p_priority: "critical",

          p_scheduled_at: new Date().toISOString(),

          p_idempotency_key: `wa_called_${calledBooking.id}`,

          p_hospital_id: hospitalId,

          p_booking_id: calledBooking.id,
        },
      );

      if (enqueueError) {
        logger.warn(
          "Failed to enqueue WhatsApp notification",
          {
            error: enqueueError.message,
          },
        );
      }
    }

    /**
     * Audit logging
     * Never block queue progression.
     */
    try {
      await logAuditEvent(
        {
          hospitalId,
          actorUserId: auth.userId,

          entityType: "queue_session",

          entityId: body.queueSessionId,

          actionType: "token_advance",

          severity: "low",

          oldData: {
            token: session.current_live_token,
          },

          newData: {
            token: nextToken,
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

    /**
     * Success metrics
     */
    metrics.increment(
      "queue.advanced",
    );

    metrics.record(
      "queue.next_token",
      nextToken,
    );

    metrics.timing(
      "request.total",
      elapsedMs(trace),
    );

    metrics.flush(logger);

    return successResponse(
      {
        nextToken,
        queueSessionId: body.queueSessionId,
        queueExhausted: false,
        calledBookingId: calledBooking?.id ??
          null,
        calledPatientName: calledBooking?.patient_name ??
          null,
      },
      trace.correlationId,
      req,
    );
  } catch (err) {
    metrics.increment(
      "queue.advance.error",
    );

    logger.error(
      "queue-next-patient failed",
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
});
