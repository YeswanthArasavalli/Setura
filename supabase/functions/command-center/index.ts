/**
 * command-center/index.ts
 *
 * Phase 1.5 — Hospital Command Center API.
 *
 * Actions:
 *   overview                 live hospital overview (patients, queues,
 *                            SLA, finance) + operational scores
 *   timeline                 chronological hospital event stream
 *   predictive               predictive operations analytics
 *   sla_dashboard            live SLA dashboard for the hospital
 *   system_health            monitoring infrastructure health
 *   broadcast_queue_summary  WhatsApp queue summary to active patients
 *   broadcast_doctor_delay   WhatsApp doctor-delay notice to patients
 *   broadcast_closure        WhatsApp hospital-closure notice
 *   broadcast_admin_notice   WhatsApp operational notice to admins
 *
 * Read actions are aggregation pass-throughs over the SQL command
 * center layer (migration 47); no business logic is recomputed at
 * the edge. Broadcasts reuse the enqueue_job WhatsApp pipeline with
 * deterministic idempotency keys and are audited.
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
  type AdminBroadcastKind,
  broadcastAdminOperational,
  broadcastAlertToAdmins,
  broadcastDoctorDelay,
  broadcastHospitalClosure,
  broadcastQueueSummary,
} from "../_shared/enterprise/broadcasts.ts";

const ENDPOINT = "command-center";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const ADMIN_ACTIONS = [
  "overview",
  "timeline",
  "predictive",
  "sla_dashboard",
  "system_health",
  "broadcast_queue_summary",
  "broadcast_doctor_delay",
  "broadcast_closure",
  "broadcast_admin_notice",
  "broadcast_alert",
] as const;

type CommandCenterAction = typeof ADMIN_ACTIONS[number];

const ADMIN_BROADCAST_KINDS = [
  "daily_summary",
  "sla_breach",
  "congestion",
  "operational_notice",
] as const;

const Schema = z.object({
  action: z.enum(ADMIN_ACTIONS),

  date: z.string().regex(DATE_RE).optional(),

  // timeline filters
  fromTs: z.string().datetime().optional(),
  toTs: z.string().datetime().optional(),
  eventTypes: z.array(z.string().max(64)).max(20).optional(),
  severity: z.enum(["info", "warning", "critical"]).optional(),
  doctorId: z.string().uuid().optional(),
  queueSessionId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(500).optional(),

  // broadcast payloads
  alertId: z.string().uuid().optional(),
  delayMinutes: z.number().int().min(1).max(1440).optional(),
  reason: z.string().max(200).optional(),
  kind: z.enum(ADMIN_BROADCAST_KINDS).optional(),
  message: z.string().max(500).optional(),
}).refine(
  (v) =>
    v.action !== "broadcast_queue_summary" &&
      v.action !== "broadcast_doctor_delay" ||
    typeof v.queueSessionId === "string",
  {
    message: "queueSessionId is required for this action",
    path: ["queueSessionId"],
  },
).refine(
  (v) =>
    v.action !== "broadcast_doctor_delay" ||
    typeof v.delayMinutes === "number",
  {
    message: "delayMinutes is required for broadcast_doctor_delay",
    path: ["delayMinutes"],
  },
).refine(
  (v) =>
    v.action !== "broadcast_admin_notice" ||
    (typeof v.kind === "string" && typeof v.message === "string"),
  {
    message: "kind and message are required for broadcast_admin_notice",
    path: ["kind"],
  },
).refine(
  (v) => v.action !== "broadcast_alert" || typeof v.alertId === "string",
  {
    message: "alertId is required for broadcast_alert",
    path: ["alertId"],
  },
);

/** Loads a queue session and enforces hospital ownership. */
async function loadBroadcastSession(
  db: ReturnType<typeof getServiceClient>,
  queueSessionId: string,
  hospitalId: string,
) {
  const { data, error } = await db
    .from("queue_sessions")
    .select("id, hospital_id, current_live_token")
    .eq("id", queueSessionId)
    .maybeSingle();

  if (error) {
    throw new InternalError("Failed to load queue session", {
      error: error.message,
    });
  }

  if (!data) {
    throw new ValidationError("Queue session not found", {
      queueSessionId: ["Not found"],
    });
  }

  if (data.hospital_id !== hospitalId) {
    throw new ForbiddenError("Session belongs to different hospital");
  }

  return data as {
    id: string;
    hospital_id: string;
    current_live_token: number | null;
  };
}

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

  let action: CommandCenterAction | undefined;

  try {
    const hospitalId = req.headers.get("X-Hospital-ID");

    if (!hospitalId) {
      throw new ValidationError("Missing X-Hospital-ID header", {
        header: ["Required"],
      });
    }

    const auth = await resolveAuth(req, hospitalId, logger);

    requireRole(auth, ["hospital_admin", "global_admin"]);

    const body = await parseBody(req, Schema);

    action = body.action;

    const db = getServiceClient();

    /**
     * Overview: live command center snapshot plus composite scores.
     * Read-only aggregation, no audit.
     */
    if (body.action === "overview") {
      const { data: overview, error: ccErr } = await db.rpc(
        "get_hospital_command_center",
        {
          p_hospital_id: hospitalId,
          ...(body.date ? { p_date: body.date } : {}),
        },
      );

      if (ccErr) {
        throw new InternalError("Command center aggregation failed", {
          error: ccErr.message,
        });
      }

      const { data: scores, error: scErr } = await db.rpc(
        "get_operational_scores",
        {
          p_hospital_id: hospitalId,
          ...(body.date ? { p_date: body.date } : {}),
        },
      );

      if (scErr) {
        throw new InternalError("Operational scores failed", {
          error: scErr.message,
        });
      }

      metrics.timing("request.total", elapsedMs(trace));
      metrics.flush(logger);

      return successResponse(
        { action: "overview", overview, scores },
        trace.correlationId,
        req,
      );
    }

    /**
     * Timeline: chronological hospital event stream with filters.
     */
    if (body.action === "timeline") {
      const { data: timeline, error: tlErr } = await db.rpc(
        "get_hospital_timeline",
        {
          p_hospital_id: hospitalId,
          ...(body.fromTs ? { p_from_ts: body.fromTs } : {}),
          ...(body.toTs ? { p_to_ts: body.toTs } : {}),
          ...(body.eventTypes ? { p_event_types: body.eventTypes } : {}),
          ...(body.severity ? { p_severity: body.severity } : {}),
          ...(body.doctorId ? { p_doctor_id: body.doctorId } : {}),
          ...(body.queueSessionId
            ? { p_queue_session_id: body.queueSessionId }
            : {}),
          ...(body.limit ? { p_limit: body.limit } : {}),
        },
      );

      if (tlErr) {
        throw new InternalError("Timeline aggregation failed", {
          error: tlErr.message,
        });
      }

      metrics.timing("request.total", elapsedMs(trace));
      metrics.flush(logger);

      return successResponse(
        { action: "timeline", timeline },
        trace.correlationId,
        req,
      );
    }

    /**
     * Predictive: deterministic projections over live throughput.
     */
    if (body.action === "predictive") {
      const { data: predictions, error: prErr } = await db.rpc(
        "get_predictive_insights",
        {
          p_hospital_id: hospitalId,
          ...(body.date ? { p_date: body.date } : {}),
        },
      );

      if (prErr) {
        throw new InternalError("Predictive analytics failed", {
          error: prErr.message,
        });
      }

      metrics.timing("request.total", elapsedMs(trace));
      metrics.flush(logger);

      return successResponse(
        { action: "predictive", predictions },
        trace.correlationId,
        req,
      );
    }

    /**
     * SLA dashboard: hospital-scoped breach and trend view.
     */
    if (body.action === "sla_dashboard") {
      const { data: sla, error: slaErr } = await db.rpc(
        "get_sla_dashboard",
        {
          p_hospital_id: hospitalId,
          ...(body.date ? { p_date: body.date } : {}),
        },
      );

      if (slaErr) {
        throw new InternalError("SLA dashboard failed", {
          error: slaErr.message,
        });
      }

      metrics.timing("request.total", elapsedMs(trace));
      metrics.flush(logger);

      return successResponse(
        { action: "sla_dashboard", sla },
        trace.correlationId,
        req,
      );
    }

    /**
     * System health: reuse monitoring infrastructure (queue health,
     * MV freshness, DLQ) plus open alert count. Read-only.
     */
    if (body.action === "system_health") {
      const { data: queueHealth } = await db.rpc("get_queue_health");
      const { data: mvHealth } = await db.rpc("get_mv_refresh_health");
      const { data: dlqSummary } = await db.rpc("get_dlq_summary");

      const { count: openAlerts, error: alertErr } = await db
        .from("alert_events")
        .select("*", { count: "exact", head: true })
        .eq("is_resolved", false)
        .eq("hospital_id", hospitalId);

      if (alertErr) {
        throw new InternalError("Alert count failed", {
          error: alertErr.message,
        });
      }

      metrics.timing("request.total", elapsedMs(trace));
      metrics.flush(logger);

      return successResponse(
        {
          action: "system_health",
          health: {
            queueHealth,
            materializedViews: mvHealth,
            deadLetterQueue: dlqSummary,
            openAlerts: openAlerts ?? 0,
          },
        },
        trace.correlationId,
        req,
      );
    }

    /**
     * Broadcasts: fan out operational WhatsApp notices. Every
     * enqueue carries a deterministic idempotency key, so repeats
     * are safe. Audited as operational_alert.
     */
    let broadcastResult: { kind: string; enqueued: number };

    if (body.action === "broadcast_queue_summary") {
      const session = await loadBroadcastSession(
        db,
        body.queueSessionId!,
        hospitalId,
      );

      const enqueued = await broadcastQueueSummary(db, session, logger);

      broadcastResult = { kind: "queue_summary", enqueued };
    } else if (body.action === "broadcast_doctor_delay") {
      const session = await loadBroadcastSession(
        db,
        body.queueSessionId!,
        hospitalId,
      );

      const enqueued = await broadcastDoctorDelay(
        db,
        session,
        body.delayMinutes!,
        body.reason ?? null,
        logger,
      );

      broadcastResult = { kind: "doctor_delay", enqueued };
    } else if (body.action === "broadcast_closure") {
      const sessionDate = body.date ??
        new Date().toISOString().slice(0, 10);

      const enqueued = await broadcastHospitalClosure(
        db,
        hospitalId,
        sessionDate,
        body.reason ?? null,
        logger,
      );

      broadcastResult = { kind: "hospital_closure", enqueued };
    } else if (body.action === "broadcast_alert") {
      const { data: alertRow, error: alertErr } = await db
        .from("alert_events")
        .select("id, hospital_id, alert_key, severity, message")
        .eq("id", body.alertId!)
        .maybeSingle();

      if (alertErr) {
        throw new InternalError("Failed to load alert", {
          error: alertErr.message,
        });
      }

      if (!alertRow) {
        throw new ValidationError("Alert not found", {
          alertId: ["Not found"],
        });
      }

      if (alertRow.hospital_id !== hospitalId) {
        throw new ForbiddenError("Alert belongs to different hospital");
      }

      const enqueued = await broadcastAlertToAdmins(
        db,
        alertRow as {
          id: string;
          hospital_id: string;
          alert_key: string;
          severity: string;
          message: string | null;
        },
        logger,
      );

      broadcastResult = { kind: "alert_broadcast", enqueued };
    } else {
      const enqueued = await broadcastAdminOperational(
        db,
        hospitalId,
        body.kind as AdminBroadcastKind,
        body.message!,
        logger,
      );

      broadcastResult = { kind: `admin_${body.kind}`, enqueued };
    }

    await logAuditEvent(
      {
        hospitalId,
        actorUserId: auth.userId,
        entityType: "whatsapp_broadcast",
        actionType: "operational_alert",
        severity: "medium",
        oldData: null,
        newData: {
          action: body.action,
          broadcast: broadcastResult,
          reason: body.reason ?? null,
        },
      },
      logger,
    );

    metrics.increment(`command_center.${body.action}`);
    metrics.timing("request.total", elapsedMs(trace));
    metrics.flush(logger);

    return successResponse(
      { action: body.action, broadcast: broadcastResult },
      trace.correlationId,
      req,
    );
  } catch (err) {
    metrics.increment("command_center.error");

    logger.error("command-center failed", err, {
      action,
      durationMs: elapsedMs(trace),
    });

    return handleErrorResponse(err, trace.correlationId, req);
  }
});
