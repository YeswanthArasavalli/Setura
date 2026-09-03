/**
 * queue-control/index.ts
 *
 * Phase 1.2 — live queue control API.
 *
 * Actions:
 *   pause        pause the queue
 *   resume       resume the queue
 *   recall       recall the currently called token
 *   skip         skip a token (bookingId)
 *   restore      restore a skipped patient (bookingId)
 *   mark_absent  mark a patient absent (bookingId)
 *   call         manually call a specific token (tokenNumber)
 *   delay        declare/adjust a doctor delay (delayMinutes, reason)
 *   clear_delay  clear an active doctor delay
 *   snapshot     read-only full queue state (recovery primitive)
 *
 * Every action is idempotent: the underlying RPCs are optimistic and
 * side-effect enqueues use deterministic idempotency keys.
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
  ForbiddenError,
  InternalError,
  ValidationError,
} from "../_shared/errors.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { parseBody } from "../_shared/validation.ts";
import {
  getQueueSnapshot,
  type QueueSessionRow,
  runCallToken,
  runClearDoctorDelay,
  runMarkAbsent,
  runMarkDoctorDelayed,
  runPauseQueue,
  runRecallCurrentToken,
  runRestoreToken,
  runResumeQueue,
  runSkipToken,
} from "../_shared/queue/queue_runtime.ts";

const ENDPOINT = "queue-control";

const CONTROL_ACTIONS = [
  "pause",
  "resume",
  "recall",
  "skip",
  "restore",
  "mark_absent",
  "call",
  "delay",
  "clear_delay",
  "snapshot",
] as const;

type ControlAction = typeof CONTROL_ACTIONS[number];

const BOOKING_ACTIONS = new Set<ControlAction>([
  "skip",
  "restore",
  "mark_absent",
]);

const Schema = z.object({
  queueSessionId: z.string().uuid(),

  action: z.enum(CONTROL_ACTIONS),

  bookingId: z.string().uuid().optional(),

  tokenNumber: z.number().int().positive().optional(),

  delayMinutes: z.number().int().min(1).max(720).optional(),

  reason: z.string().max(200).optional(),
}).refine(
  (v) => !BOOKING_ACTIONS.has(v.action) || typeof v.bookingId === "string",
  {
    message: "bookingId is required for skip, restore and mark_absent",
    path: ["bookingId"],
  },
).refine(
  (v) => v.action !== "call" || typeof v.tokenNumber === "number",
  {
    message: "tokenNumber is required for call",
    path: ["tokenNumber"],
  },
).refine(
  (v) => v.action !== "delay" || typeof v.delayMinutes === "number",
  {
    message: "delayMinutes is required for delay",
    path: ["delayMinutes"],
  },
);

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const trace = createTraceContext(req);

  const logger = createRequestLogger(req, ENDPOINT).child({
    correlationId: trace.correlationId,
  });

  const metrics = createMetrics(ENDPOINT, trace.correlationId);

  let action: ControlAction | undefined;

  try {
    const hospitalId = req.headers.get("X-Hospital-ID");

    if (!hospitalId) {
      throw new ValidationError("Missing X-Hospital-ID header", {
        header: ["Required"],
      });
    }

    const auth = await resolveAuth(req, hospitalId, logger);

    requireRole(auth, [
      "receptionist",
      "hospital_admin",
      "global_admin",
    ]);

    const body = await parseBody(req, Schema);

    action = body.action;

    const db = getServiceClient();

    /**
     * Load queue session
     */
    const { data: session, error: sessErr } = await db
      .from("queue_sessions")
      .select(`
        id,
        hospital_id,
        doctor_id,
        session_date,
        is_active,
        is_paused,
        pause_reason,
        current_live_token,
        max_tokens
      `)
      .eq("id", body.queueSessionId)
      .maybeSingle<QueueSessionRow>();

    if (sessErr) {
      throw new InternalError("Failed to load queue session", {
        error: sessErr.message,
      });
    }

    if (!session) {
      throw new ValidationError("Queue session not found", {
        queueSessionId: ["Not found"],
      });
    }

    if (session.hospital_id !== hospitalId) {
      throw new ForbiddenError(
        "Session belongs to different hospital",
      );
    }

    /**
     * Snapshot is a recovery primitive: it must work even after the
     * session ended so displays can reconstruct the last known state.
     */
    if (body.action === "snapshot") {
      const snapshot = await getQueueSnapshot(db, session.id);

      metrics.timing("request.total", elapsedMs(trace));
      metrics.flush(logger);

      return successResponse(
        {
          action: "snapshot",
          queueSessionId: session.id,
          snapshot,
        },
        trace.correlationId,
        req,
      );
    }

    if (!session.is_active) {
      throw new ValidationError("Queue session is not active", {
        queueSessionId: ["Session has ended"],
      });
    }

    /**
     * Dispatch
     */
    let result: Record<string, unknown>;

    switch (body.action) {
      case "pause":
        result = await runPauseQueue(
          db,
          session,
          body.reason ?? null,
          auth.userId,
          logger,
        ) as unknown as Record<string, unknown>;
        break;

      case "resume":
        result = await runResumeQueue(
          db,
          session,
          auth.userId,
          logger,
        ) as unknown as Record<string, unknown>;
        break;

      case "recall":
        result = await runRecallCurrentToken(
          db,
          session,
          auth.userId,
          logger,
        ) as unknown as Record<string, unknown>;
        break;

      case "skip":
        result = await runSkipToken(
          db,
          session,
          body.bookingId!,
          auth.userId,
          logger,
        ) as unknown as Record<string, unknown>;
        break;

      case "restore":
        result = await runRestoreToken(
          db,
          session,
          body.bookingId!,
          auth.userId,
          logger,
        ) as unknown as Record<string, unknown>;
        break;

      case "mark_absent":
        result = await runMarkAbsent(
          db,
          session,
          body.bookingId!,
          auth.userId,
          logger,
        ) as unknown as Record<string, unknown>;
        break;

      case "call":
        result = await runCallToken(
          db,
          session,
          body.tokenNumber!,
          auth.userId,
          logger,
        ) as unknown as Record<string, unknown>;
        break;

      case "delay":
        result = await runMarkDoctorDelayed(
          db,
          session,
          body.delayMinutes!,
          body.reason ?? null,
          auth.userId,
          logger,
        ) as unknown as Record<string, unknown>;
        break;

      case "clear_delay":
        result = await runClearDoctorDelay(
          db,
          session,
          auth.userId,
          logger,
        ) as unknown as Record<string, unknown>;
        break;

      default:
        throw new ValidationError(`Unsupported action '${body.action}'`);
    }

    /**
     * Fresh snapshot so displays converge in one round-trip.
     */
    const snapshot = await getQueueSnapshot(db, session.id);

    /**
     * Audit (fire-and-forget inside logAuditEvent)
     */
    await logAuditEvent(
      {
        hospitalId,
        actorUserId: auth.userId,

        entityType: "queue_session",

        entityId: session.id,

        actionType: "queue_control",

        severity: body.action === "pause" || body.action === "resume" ||
            body.action === "delay" || body.action === "clear_delay"
          ? "medium"
          : "low",

        oldData: {
          is_paused: session.is_paused,
          current_live_token: session.current_live_token,
        },

        newData: {
          action: body.action,
          bookingId: body.bookingId ?? null,
          tokenNumber: body.tokenNumber ?? null,
          delayMinutes: body.delayMinutes ?? null,
          reason: body.reason ?? null,
          result,
        },
      },
      logger,
    );

    /**
     * Usage counter (best-effort)
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

    metrics.increment(`queue.control.${body.action}`);
    metrics.timing("request.total", elapsedMs(trace));
    metrics.flush(logger);

    return successResponse(
      {
        action: body.action,
        queueSessionId: session.id,
        result,
        snapshot,
      },
      trace.correlationId,
      req,
    );
  } catch (err) {
    metrics.increment("queue.control.error");

    logger.error("queue-control failed", err, {
      action,
      durationMs: elapsedMs(trace),
    });

    return handleErrorResponse(err, trace.correlationId, req);
  }
});
