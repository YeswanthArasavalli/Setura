/**
 * audit.ts — Audit event writing (integrates with Script 10 audit_logs table)
 *
 * Audit events are written fire-and-forget in the sense that a failed
 * audit write never fails the booking, queue or payment operation that
 * produced it. Fire-and-forget is NOT silent:
 *
 *   - `write_audit_log` returns a PostgREST error object rather than
 *     throwing, so the error is inspected explicitly. Previously it was
 *     never read, and an invalid `entity_id` cast made governance
 *     events vanish with no log line and no metric.
 *   - A non-UUID `entityId` or `actorUserId` is no longer sent into a
 *     UUID column. The value is preserved under `newData.entityRef` /
 *     `newData.actorRef` and the row is written with a NULL id, so the
 *     event still lands. (`actorUserId: "system"` is the real case:
 *     `audit_logs.actor_user_id` is a UUID with an FK to `profiles`.)
 *   - Every failure is logged at error level and, when a collector is
 *     supplied, counted as `audit.write_failed`.
 *
 * The rule this module enforces: a governance event must never silently
 * disappear.
 */

import { getServiceClient } from "./db.ts";
import type { Logger } from "./logger.ts";
import type { MetricsCollector } from "./metrics.ts";
import type { Json } from "./types.ts";

export type AuditActionSeverity = "low" | "medium" | "high" | "critical";

export type AuditActionType =
  | "login"
  | "booking_create"
  | "booking_status_change"
  | "booking_cancel"
  | "token_advance"
  | "queue_control"
  | "clinical_action"
  | "clinical_note"
  | "alert_center"
  | "compliance_check"
  | "executive_report"
  | "operational_alert"
  | "carry_forward"
  | "settlement_create"
  | "settlement_paid"
  | "payment_capture"
  | "payment_refund"
  | "payment_order_created"
  | "role_assign"
  | "hospital_setting_update"
  | "feature_flag_update"
  | "patient_merge"
  | "admin_action"
  | "hospital_provision"
  | "whatsapp_send"
  | "integration_config_update"
  | "integration_enabled"
  | "integration_disabled"
  | "integration_connection_tested"
  | "integration_secret_rotated"
  | "department_create"
  | "department_update"
  | "department_status_change"
  | "doctor_create"
  | "doctor_update"
  | "doctor_status_change"
  | "doctor_department_assignment"
  | "doctor_schedule_create"
  | "doctor_schedule_update"
  | "doctor_schedule_delete"
  | "doctor_leave_create"
  | "doctor_leave_update"
  | "doctor_leave_cancel"
  | "worker_crash_recovery";

export interface AuditEvent {
  hospitalId?: string | null;
  /**
   * Must be a UUID: `audit_logs.actor_user_id` is a UUID column with a
   * foreign key to `profiles`. A synthetic actor name (`"system"`) is
   * moved to `newData.actorRef` and the row is written with a NULL
   * actor, which the column allows.
   */
  actorUserId: string;
  entityType: string;
  /**
   * Must be a UUID: `audit_logs.entity_id` is a UUID column. A
   * non-UUID identifier (a report type, a check name, a Meta
   * `wamid.*`) is moved to `newData.entityRef` instead of being cast.
   */
  entityId?: string | null;
  actionType: AuditActionType;
  severity?: AuditActionSeverity;
  oldData?: Record<string, unknown> | null;
  newData?: Record<string, unknown> | null;
  notes?: string;
}

/** Result of an audit write. Callers may ignore it; nothing throws. */
export type AuditWriteOutcome =
  | {
    ok: true;
    /**
     * True when a non-UUID entityId or actorUserId was relocated into
     * newData. The event landed; the reference is preserved as data.
     */
    coerced: boolean;
  }
  | {
    ok: false;
    reason: "rpc_error" | "exception";
    message: string;
  };

/**
 * Any 8-4-4-4-12 hex string, which is exactly what PostgreSQL's uuid
 * input accepts in canonical form. Deliberately not restricted to
 * RFC 4122 versions/variants: the database is the authority on what
 * casts, and `gen_random_uuid()` values are all this shape.
 */
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** True when `value` can be cast to a PostgreSQL uuid. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * Writes an audit event.
 *
 * Never throws and never rejects. Returns the outcome so a caller that
 * cares can react; ignoring the return value is safe and is what most
 * call sites do.
 *
 * Pass `metrics` wherever a collector exists: an audit gap then shows
 * up as `audit.write_failed` instead of only as a log line.
 */
export async function logAuditEvent(
  event: AuditEvent,
  logger: Logger,
  metrics?: MetricsCollector,
): Promise<AuditWriteOutcome> {
  // A non-UUID reference is data, not an identifier. Keep it, but keep
  // it out of the UUID columns, which would reject the whole INSERT.
  let entityId: string | undefined = event.entityId ?? undefined;
  let actorId: string | undefined = event.actorUserId ?? undefined;
  let newData = event.newData;
  let coerced = false;

  if (entityId !== undefined && !isUuid(entityId)) {
    newData = { ...(newData ?? {}), entityRef: entityId };
    coerced = true;

    logger.warn("Audit entityId is not a UUID; recorded as entityRef", {
      actionType: event.actionType,
      entityType: event.entityType,
      entityRef: entityId,
    });

    metrics?.increment("audit.entity_id_coerced");
    entityId = undefined;
  }

  if (actorId !== undefined && !isUuid(actorId)) {
    newData = { ...(newData ?? {}), actorRef: actorId };
    coerced = true;

    logger.warn("Audit actorUserId is not a UUID; recorded as actorRef", {
      actionType: event.actionType,
      entityType: event.entityType,
      actorRef: actorId,
    });

    metrics?.increment("audit.actor_id_coerced");
    actorId = undefined;
  }

  try {
    const db = getServiceClient();

    // Omitted arguments are safe here: migration 39 redefined
    // write_audit_log so that every parameter carries DEFAULT NULL, so
    // PostgREST resolves the call from whichever names are present and
    // an absent id becomes SQL NULL.
    const { error } = await db.rpc("write_audit_log", {
      p_hospital_id: event.hospitalId ?? undefined,
      p_actor_id: actorId,
      p_entity_type: event.entityType,
      p_entity_id: entityId,
      p_action: event.actionType,
      p_severity: event.severity ?? "low",
      p_old_data: event.oldData as unknown as Json | undefined,
      p_new_data: newData as unknown as Json | undefined,
      p_notes: event.notes ?? undefined,
    });

    if (error) {
      // supabase-js resolves rather than throws on a PostgREST error.
      // Reading `error` is the whole point: this branch is where
      // audit events used to disappear.
      logger.error("Audit write rejected by database", error, {
        actionType: event.actionType,
        entityType: event.entityType,
        severity: event.severity ?? "low",
      });

      metrics?.increment("audit.write_failed");

      return { ok: false, reason: "rpc_error", message: error.message };
    }

    metrics?.increment("audit.write_ok");

    return { ok: true, coerced };
  } catch (err) {
    logger.error("Failed to write audit event (non-fatal)", err, {
      actionType: event.actionType,
      entityType: event.entityType,
    });

    metrics?.increment("audit.write_failed");

    return {
      ok: false,
      reason: "exception",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
