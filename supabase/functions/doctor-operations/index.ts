/**
 * doctor-operations/index.ts
 *
 * Phase 1.4 — Doctor & Clinical Operations API.
 *
 * Actions:
 *   start_session         open (or converge on) today's session
 *   end_session           end the session (incl. early closure)
 *   break                 pause consultations (doctor break)
 *   resume                resume consultations
 *   call_next             call the next patient in the queue
 *   recall                recall the currently called patient
 *   skip                  skip a patient (bookingId)
 *   restore               restore a skipped patient (bookingId)
 *   mark_absent           mark a patient absent (bookingId)
 *   start_consultation    called -> in_consultation (bookingId)
 *   complete_consultation in_consultation -> completed (bookingId)
 *   return_to_waiting     interrupted consultation back to queue
 *   emergency_insert      insert an emergency patient at the front
 *   save_note             append an immutable clinical note
 *   dashboard             read-only doctor day dashboard
 *
 * Every action is idempotent: the underlying RPCs are optimistic and
 * side-effect enqueues use deterministic idempotency keys. Doctors may
 * only operate their own session; admins may operate any session in
 * their hospital.
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
import {
  getDoctorDashboard,
  getQueueSnapshot,
  type QueueSessionRow,
  runCloseDoctorSession,
  runCompleteConsultation,
  runInsertEmergencyPatient,
  runMarkAbsent,
  runOpenDoctorSession,
  runPauseQueue,
  runRecallCurrentToken,
  runRestoreToken,
  runResumeQueue,
  runReturnToWaiting,
  runSaveConsultationNote,
  runSkipToken,
  runStartConsultation,
  triggerSlaRefresh,
} from "../_shared/queue/queue_runtime.ts";

const ENDPOINT = "doctor-operations";

const DOCTOR_ACTIONS = [
  "start_session",
  "end_session",
  "break",
  "resume",
  "call_next",
  "recall",
  "skip",
  "restore",
  "mark_absent",
  "start_consultation",
  "complete_consultation",
  "return_to_waiting",
  "emergency_insert",
  "save_note",
  "dashboard",
] as const;

type DoctorAction = typeof DOCTOR_ACTIONS[number];

const BOOKING_ACTIONS = new Set<DoctorAction>([
  "skip",
  "restore",
  "mark_absent",
  "start_consultation",
  "complete_consultation",
  "return_to_waiting",
  "save_note",
]);

/** Actions that do not target a specific queue session row. */
const SESSIONLESS_ACTIONS = new Set<DoctorAction>([
  "start_session",
  "dashboard",
]);

const Schema = z.object({
  action: z.enum(DOCTOR_ACTIONS),

  queueSessionId: z.string().uuid().optional(),

  bookingId: z.string().uuid().optional(),

  patientName: z.string().min(2).max(100).optional(),

  patientPhone: z.string().max(20).optional(),

  reason: z.string().max(200).optional(),

  notes: z.string().max(5000).optional(),

  diagnosisSummary: z.string().max(1000).optional(),

  prescription: z.array(z.any()).optional(),

  followUpDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),

  attachments: z.array(z.any()).optional(),

  idempotencyKey: z.string().max(128).optional(),

  doctorId: z.string().uuid().optional(),
}).refine(
  (v) =>
    SESSIONLESS_ACTIONS.has(v.action) || typeof v.queueSessionId === "string",
  {
    message: "queueSessionId is required for this action",
    path: ["queueSessionId"],
  },
).refine(
  (v) => !BOOKING_ACTIONS.has(v.action) || typeof v.bookingId === "string",
  {
    message: "bookingId is required for this action",
    path: ["bookingId"],
  },
).refine(
  (v) => v.action !== "emergency_insert" || typeof v.patientName === "string",
  {
    message: "patientName is required for emergency_insert",
    path: ["patientName"],
  },
).refine(
  (v) => v.action !== "save_note" || typeof v.notes === "string",
  {
    message: "notes is required for save_note",
    path: ["notes"],
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

  let action: DoctorAction | undefined;

  try {
    const hospitalId = req.headers.get("X-Hospital-ID");

    if (!hospitalId) {
      throw new ValidationError("Missing X-Hospital-ID header", {
        header: ["Required"],
      });
    }

    const auth = await resolveAuth(req, hospitalId, logger);

    requireRole(auth, ["doctor", "hospital_admin", "global_admin"]);

    const body = await parseBody(req, Schema);

    action = body.action;

    const db = getServiceClient();

    /**
     * Dashboard: doctor reads their own day; admins may inspect any
     * doctor in the hospital. Read-only, no audit required.
     */
    if (body.action === "dashboard") {
      const doctorId = auth.role === "doctor"
        ? auth.userId
        : (body.doctorId ?? auth.userId);

      const dashboard = await getDoctorDashboard(db, doctorId, hospitalId);

      metrics.timing("request.total", elapsedMs(trace));
      metrics.flush(logger);

      return successResponse(
        { action: "dashboard", dashboard },
        trace.correlationId,
        req,
      );
    }

    /**
     * Start session: doctors open their own session for today.
     */
    if (body.action === "start_session") {
      if (auth.role !== "doctor") {
        throw new ForbiddenError(
          "Only doctors can open consultation sessions",
        );
      }

      const result = await runOpenDoctorSession(
        db,
        hospitalId,
        auth.userId,
        auth.userId,
        logger,
      );

      if (!result.ok) {
        throw new ValidationError(
          result.reason === "session_already_ended"
            ? "Today's session already ended"
            : `Could not open session: ${result.reason ?? "unknown"}`,
        );
      }

      await logAuditEvent(
        {
          hospitalId,
          actorUserId: auth.userId,
          entityType: "queue_session",
          entityId: result.queue_session_id!,
          actionType: "clinical_action",
          severity: "low",
          oldData: null,
          newData: { action: "start_session", result },
        },
        logger,
      );

      metrics.increment("doctor.ops.start_session");
      metrics.timing("request.total", elapsedMs(trace));
      metrics.flush(logger);

      return successResponse(
        { action: "start_session", result },
        trace.correlationId,
        req,
      );
    }

    /**
     * Load and authorize the target session.
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
      .eq("id", body.queueSessionId!)
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

    if (auth.role === "doctor" && session.doctor_id !== auth.userId) {
      throw new ForbiddenError(
        "Doctors can only operate their own session",
      );
    }

    if (!session.is_active && body.action !== "end_session") {
      throw new ValidationError("Queue session is not active", {
        queueSessionId: ["Session has ended"],
      });
    }

    /**
     * Dispatch
     */
    let result: Record<string, unknown>;
    let entityType: "queue_session" | "booking" = "queue_session";
    let entityId = session.id;

    switch (body.action) {
      case "end_session":
        result = await runCloseDoctorSession(
          db,
          session,
          auth.userId,
          body.reason ?? null,
          logger,
        ) as unknown as Record<string, unknown>;
        break;

      case "break":
        result = await runPauseQueue(
          db,
          session,
          body.reason ?? "doctor_break",
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

      case "call_next": {
        const { data: token, error: advErr } = await db.rpc("advance_queue", {
          p_queue_session_id: session.id,
        });

        if (advErr) {
          if (advErr.message.includes("QUEUE_PAUSED")) {
            throw new ValidationError("Queue is paused", {
              queueSessionId: ["Resume the queue before calling patients"],
            });
          }
          throw new InternalError("advance_queue failed", {
            error: advErr.message,
          });
        }

        result = { token, called: token !== null };

        if (token !== null) {
          try {
            await broadcastQueueAdvance(session.id, token, logger);
          } catch (err) {
            logger.warn("Realtime broadcast failed", err);
          }
          await triggerSlaRefresh(
            db,
            hospitalId,
            session.session_date,
            logger,
          );
        }
        break;
      }

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
        entityType = "booking";
        entityId = body.bookingId!;
        break;

      case "restore":
        result = await runRestoreToken(
          db,
          session,
          body.bookingId!,
          auth.userId,
          logger,
        ) as unknown as Record<string, unknown>;
        entityType = "booking";
        entityId = body.bookingId!;
        break;

      case "mark_absent":
        result = await runMarkAbsent(
          db,
          session,
          body.bookingId!,
          auth.userId,
          logger,
        ) as unknown as Record<string, unknown>;
        entityType = "booking";
        entityId = body.bookingId!;
        break;

      case "start_consultation":
        result = await runStartConsultation(
          db,
          session,
          body.bookingId!,
          auth.userId,
        ) as unknown as Record<string, unknown>;
        entityType = "booking";
        entityId = body.bookingId!;
        break;

      case "complete_consultation":
        result = await runCompleteConsultation(
          db,
          session,
          body.bookingId!,
          auth.userId,
          logger,
        ) as unknown as Record<string, unknown>;
        entityType = "booking";
        entityId = body.bookingId!;
        break;

      case "return_to_waiting":
        result = await runReturnToWaiting(
          db,
          session,
          body.bookingId!,
          auth.userId,
        ) as unknown as Record<string, unknown>;
        entityType = "booking";
        entityId = body.bookingId!;
        break;

      case "emergency_insert":
        result = await runInsertEmergencyPatient(
          db,
          session,
          body.patientName!,
          body.patientPhone ?? null,
          body.reason ?? null,
          auth.userId,
          body.idempotencyKey ?? null,
        ) as unknown as Record<string, unknown>;
        entityType = "booking";
        entityId = (result.booking_id as string) ?? session.id;
        break;

      case "save_note": {
        const saved = await runSaveConsultationNote(
          db,
          body.bookingId!,
          auth.userId,
          {
            notes: body.notes!,
            diagnosisSummary: body.diagnosisSummary ?? null,
            prescription: body.prescription ?? null,
            followUpDate: body.followUpDate ?? null,
            attachments: body.attachments ?? null,
          },
        );

        if (!saved.ok) {
          throw new ValidationError(
            `Could not save note: ${saved.reason ?? "unknown"}`,
          );
        }

        result = saved as unknown as Record<string, unknown>;
        entityType = "booking";
        entityId = body.bookingId!;
        break;
      }

      default:
        throw new ValidationError(`Unsupported action '${body.action}'`);
    }

    /**
     * Failed transitions return structured reasons, not 500s.
     */
    if (result.ok === false && result.reason) {
      const reason = result.reason as string;

      if (reason === "another_consultation_active") {
        throw new ValidationError(
          "Another consultation is already active for this doctor",
        );
      }

      throw new ValidationError(`Action refused: ${reason}`, {
        reason: [reason],
      });
    }

    /**
     * Fresh snapshot so doctor consoles converge in one round-trip.
     */
    const snapshot = body.action === "save_note"
      ? undefined
      : await getQueueSnapshot(db, session.id);

    /**
     * Audit: every clinical action is recorded immutably.
     */
    await logAuditEvent(
      {
        hospitalId,
        actorUserId: auth.userId,

        entityType,
        entityId,

        actionType: body.action === "save_note"
          ? "clinical_note"
          : "clinical_action",

        severity: body.action === "end_session" ||
            body.action === "emergency_insert" ||
            body.action === "return_to_waiting"
          ? "medium"
          : "low",

        oldData: {
          is_paused: session.is_paused,
          current_live_token: session.current_live_token,
        },

        newData: {
          action: body.action,
          bookingId: body.bookingId ?? null,
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

    metrics.increment(`doctor.ops.${body.action}`);
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
    metrics.increment("doctor.ops.error");

    logger.error("doctor-operations failed", err, {
      action,
      durationMs: elapsedMs(trace),
    });

    return handleErrorResponse(err, trace.correlationId, req);
  }
});
