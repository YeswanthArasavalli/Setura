/**
 * alert-center/index.ts
 *
 * Phase 1.5 — Enterprise Alert Management API.
 *
 * Actions:
 *   list         alert center with status/severity/category filters
 *   analytics    alert volume + resolution analytics per alert key
 *   acknowledge  mark an alert acknowledged (idempotent)
 *   assign       assign an alert to a team member (idempotent)
 *   resolve      resolve an alert with notes
 *   escalate     escalate an alert (raises severity to critical)
 *   suppress     open a suppression window for an alert key
 *
 * Mutations run through the SECURITY DEFINER alert RPCs (migration
 * 47), which own the state transitions and activity log writes; the
 * edge layer only authorizes, enforces hospital isolation, and
 * audits. Hospital admins operate their hospital's alerts; global
 * admins may operate any hospital's alerts but must still scope via
 * the X-Hospital-ID header.
 */

import { handleCors } from "../_shared/cors.ts";
import { requireRole, resolveAuth } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/db.ts";
import { createRequestLogger } from "../_shared/logger.ts";
import { createTraceContext, elapsedMs } from "../_shared/tracing.ts";
import { createMetrics } from "../_shared/metrics.ts";
import { isUuid, logAuditEvent } from "../_shared/audit.ts";
import { handleErrorResponse, successResponse } from "../_shared/response.ts";
import {
  ForbiddenError,
  InternalError,
  ValidationError,
} from "../_shared/errors.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { parseBody } from "../_shared/validation.ts";

const ENDPOINT = "alert-center";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const ALERT_ACTIONS = [
  "list",
  "analytics",
  "acknowledge",
  "assign",
  "resolve",
  "escalate",
  "suppress",
] as const;

type AlertAction = typeof ALERT_ACTIONS[number];

/** Actions that target a specific alert row. */
const ALERT_TARGET_ACTIONS = new Set<AlertAction>([
  "acknowledge",
  "assign",
  "resolve",
  "escalate",
]);

const Schema = z.object({
  action: z.enum(ALERT_ACTIONS),

  // list filters
  status: z.enum(["open", "all", "resolved"]).optional(),
  severity: z.enum(["info", "warning", "critical"]).optional(),
  category: z.string().max(64).optional(),
  limit: z.number().int().min(1).max(200).optional(),

  // analytics range
  fromDate: z.string().regex(DATE_RE).optional(),
  toDate: z.string().regex(DATE_RE).optional(),

  // mutation targets
  alertId: z.string().uuid().optional(),
  assigneeId: z.string().uuid().optional(),
  notes: z.string().max(1000).optional(),

  // suppression window
  alertKey: z.string().min(3).max(128).optional(),
  activeUntil: z.string().datetime().optional(),
  reason: z.string().max(200).optional(),
}).refine(
  (v) => !ALERT_TARGET_ACTIONS.has(v.action) || typeof v.alertId === "string",
  {
    message: "alertId is required for this action",
    path: ["alertId"],
  },
).refine(
  (v) => v.action !== "assign" || typeof v.assigneeId === "string",
  {
    message: "assigneeId is required for assign",
    path: ["assigneeId"],
  },
).refine(
  (v) =>
    v.action !== "suppress" ||
    (typeof v.alertKey === "string" && typeof v.activeUntil === "string"),
  {
    message: "alertKey and activeUntil are required for suppress",
    path: ["alertKey"],
  },
);

interface AlertRow {
  id: string;
  hospital_id: string;
  alert_key: string;
  severity: string;
  message: string | null;
  is_resolved: boolean;
  acknowledged_at: string | null;
  assigned_to: string | null;
  escalated_at: string | null;
}

/** Loads an alert and enforces hospital isolation. */
async function loadAuthorizedAlert(
  db: ReturnType<typeof getServiceClient>,
  alertId: string,
  hospitalId: string,
): Promise<AlertRow> {
  const { data, error } = await db
    .from("alert_events")
    .select(
      "id, hospital_id, alert_key, severity, message, is_resolved, acknowledged_at, assigned_to, escalated_at",
    )
    .eq("id", alertId)
    .maybeSingle();

  if (error) {
    throw new InternalError("Failed to load alert", {
      error: error.message,
    });
  }

  if (!data) {
    throw new ValidationError("Alert not found", {
      alertId: ["Not found"],
    });
  }

  if (data.hospital_id !== hospitalId) {
    throw new ForbiddenError("Alert belongs to different hospital");
  }

  return data as unknown as AlertRow;
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

  let action: AlertAction | undefined;

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
     * List: alert center snapshot with filters. Read-only.
     */
    if (body.action === "list") {
      const { data: center, error } = await db.rpc("get_alert_center", {
        p_hospital_id: hospitalId,
        ...(body.status ? { p_status: body.status } : {}),
        ...(body.severity ? { p_severity: body.severity } : {}),
        ...(body.category ? { p_category: body.category } : {}),
        ...(body.limit ? { p_limit: body.limit } : {}),
      });

      if (error) {
        throw new InternalError("Alert center query failed", {
          error: error.message,
        });
      }

      metrics.timing("request.total", elapsedMs(trace));
      metrics.flush(logger);

      return successResponse(
        { action: "list", center },
        trace.correlationId,
        req,
      );
    }

    /**
     * Analytics: volume and resolution stats per alert key.
     * Read-only.
     */
    if (body.action === "analytics") {
      const { data: analytics, error } = await db.rpc(
        "get_alert_analytics",
        {
          p_hospital_id: hospitalId,
          ...(body.fromDate ? { p_from_date: body.fromDate } : {}),
          ...(body.toDate ? { p_to_date: body.toDate } : {}),
        },
      );

      if (error) {
        throw new InternalError("Alert analytics failed", {
          error: error.message,
        });
      }

      metrics.timing("request.total", elapsedMs(trace));
      metrics.flush(logger);

      return successResponse(
        { action: "analytics", analytics },
        trace.correlationId,
        req,
      );
    }

    /**
     * Suppression window: pauses firing for an alert key. Hospital
     * admins suppress within their hospital; global admins may open
     * hospital-scoped windows via the header hospital.
     */
    if (body.action === "suppress") {
      const { data: result, error } = await db.rpc("suppress_alerts", {
        p_alert_key: body.alertKey!,
        p_active_until: body.activeUntil!,
        p_actor_id: auth.userId,
        p_hospital_id: hospitalId,
        ...(body.reason ? { p_reason: body.reason } : {}),
      });

      if (error) {
        throw new InternalError("Alert suppression failed", {
          error: error.message,
        });
      }

      const outcome = (result ?? {}) as Record<string, unknown>;

      if (outcome.ok !== true) {
        throw new ValidationError("Suppression window rejected", {
          activeUntil: [String(outcome.reason ?? "invalid_window")],
        });
      }

      await logAuditEvent(
        {
          hospitalId,
          actorUserId: auth.userId,
          entityType: "alert_suppression",
          // Only a real UUID reaches the UUID column. An absent
          // suppression_id must not become the empty string, which
          // fails the cast and used to discard the event silently.
          ...(isUuid(outcome.suppression_id)
            ? { entityId: outcome.suppression_id }
            : {}),
          actionType: "alert_center",
          severity: "medium",
          oldData: null,
          newData: {
            suppressionId: outcome.suppression_id ?? null,
            alertKey: body.alertKey,
            activeUntil: body.activeUntil,
            reason: body.reason ?? null,
          },
        },
        logger,
        metrics,
      );

      metrics.increment("alert_center.suppress");
      metrics.timing("request.total", elapsedMs(trace));
      metrics.flush(logger);

      return successResponse(
        { action: "suppress", result: outcome },
        trace.correlationId,
        req,
      );
    }

    /**
     * Alert lifecycle mutations: acknowledge / assign / resolve /
     * escalate. The RPCs own the transitions and the activity log.
     */
    const alert = await loadAuthorizedAlert(db, body.alertId!, hospitalId);

    const rpcArgs: Record<string, unknown> = {
      p_alert_id: body.alertId,
      p_actor_id: auth.userId,
    };

    if (body.action === "assign") {
      rpcArgs.p_assignee_id = body.assigneeId;
    }

    if (
      (body.action === "resolve" || body.action === "escalate") &&
      body.notes
    ) {
      rpcArgs.p_notes = body.notes;
    }

    const rpcName = body.action === "acknowledge"
      ? "acknowledge_alert"
      : body.action === "assign"
      ? "assign_alert"
      : body.action === "resolve"
      ? "resolve_alert"
      : "escalate_alert";

    const { data: result, error } = await db.rpc(
      rpcName,
      rpcArgs as never,
    );

    if (error) {
      // Defense-in-depth: a DB privilege denial (SQLSTATE 42501 raised by
      // has_permission in the lifecycle RPC) must fail closed as 403, never
      // leak as a 500. Any other rpc error is a genuine server fault.
      if (error.code === "42501") {
        throw new ForbiddenError(
          `Not authorized to ${body.action} this alert`,
        );
      }
      throw new InternalError(`Alert ${body.action} failed`, {
        error: error.message,
      });
    }

    const outcome = (result ?? {}) as Record<string, unknown>;

    if (outcome.ok !== true) {
      throw new ValidationError(`Alert ${body.action} rejected`, {
        alertId: [String(outcome.reason ?? "unknown")],
      });
    }

    // Audit old/new come from the RPC's locked before/after snapshot for a
    // real transition (authoritative while the row lock is held). A soft
    // already_* replay commits no change and returns no snapshot, so it
    // records a null old state plus the replayed action. The pre-read
    // `alert` is used only for authorization/isolation, never as the audit
    // snapshot (it is not lock-consistent with the mutation).
    const before = (outcome.before ?? null) as Record<string, unknown> | null;
    const after = (outcome.after ?? null) as Record<string, unknown> | null;

    await logAuditEvent(
      {
        hospitalId,
        actorUserId: auth.userId,
        entityType: "alert_event",
        entityId: alert.id,
        actionType: "alert_center",
        severity: body.action === "escalate" ? "high" : "low",
        oldData: before,
        newData: after ?? {
          action: body.action,
          already: true,
          result: outcome,
        },
      },
      logger,
    );

    metrics.increment(`alert_center.${body.action}`);
    metrics.timing("request.total", elapsedMs(trace));
    metrics.flush(logger);

    return successResponse(
      { action: body.action, alertId: alert.id, result: outcome },
      trace.correlationId,
      req,
    );
  } catch (err) {
    metrics.increment("alert_center.error");

    logger.error("alert-center failed", err, {
      action,
      durationMs: elapsedMs(trace),
    });

    return handleErrorResponse(err, trace.correlationId, req);
  }
});
