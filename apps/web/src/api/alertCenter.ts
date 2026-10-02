import { callFunction } from "@/lib/api";
import type {
  AlertAnalyticsResponseBody,
  AlertLifecycleResponseBody,
  AlertListResponseBody,
  AlertSuppressResponseBody,
} from "@/types/api";

/**
 * Boundary over the EXISTING `alert-center` Edge Function (C2 alert lifecycle).
 *
 * The read half (`list` / `analytics`, Phase 7 G-10) and the admin mutation half
 * (G-UI: `acknowledge` / `resolve` / `escalate` / `suppress`) both go through the
 * SAME function the backend already exposes. This wrapper owns NOTHING: it sends
 * exactly the fields the backend `Schema` reads, omits every absent optional
 * field (never coerced to `""`/null so the server default applies), and performs
 * no counting, grouping, lifecycle arithmetic or state transition in the browser.
 * The lifecycle RPCs (migration 64) own the transitions, the state guard and the
 * activity log; the edge layer only authorizes, enforces tenant isolation and
 * audits.
 *
 * Authorization is NOT a client concern. The function runs `resolveAuth` →
 * `requireRole([hospital_admin, global_admin])` and validates the tenant header
 * BEFORE any RPC (the live HTTP suite `alert_center_http.test.ts` proves a
 * receptionist/doctor gets a fail-closed 403 `ROLE_INSUFFICIENT` and a foreign
 * tenant a 403 `HOSPITAL_ACCESS_DENIED`). The alert RPCs are `service_role`-only
 * at the database, so a browser can never reach them directly. Tenant travels
 * ONLY in the `X-Hospital-ID` header `callFunction` sets from the authenticated
 * session — never in the body and never from the URL. No privileged key ever
 * reaches the client.
 *
 * NO Idempotency-Key is sent for any action. The reads are inherently safe; for
 * the lifecycle mutations the backend owns replay safety intrinsically via its
 * state guard + soft `already_*` success (§12/§13), and `suppress` deliberately
 * has no dedupe (OD-b). The endpoint does not read the header, so minting one
 * would be an unsupported mechanism. The UI's only duplicate-submit defence is
 * disabling the control while a request is in flight.
 *
 * The soft-success contract: a lifecycle request resolves 200 with
 * `result.ok === true` on BOTH a real transition and an `already_*` replay, so
 * the caller treats it as success and refetches authoritative state — never a
 * retry and never a generic error (§12). A rejected request throws `ApiError`
 * (401/403/422/500) with the backend's already-client-safe message.
 */

/** Supported `list` filters, mapped 1:1 to `get_alert_center` parameters. */
export interface AlertListOptions {
  status?: "open" | "all" | "resolved";
  severity?: "info" | "warning" | "critical";
  category?: string;
  limit?: number;
}

/** Optional analytics window, mapped to `get_alert_analytics` date bounds. */
export interface AlertAnalyticsOptions {
  fromDate?: string;
  toDate?: string;
}

/** Suppression window target, mapped 1:1 to `suppress_alerts` parameters. */
export interface AlertSuppressOptions {
  alertKey: string;
  /** ISO-8601 datetime string the backend `z.string().datetime()` accepts. */
  activeUntil: string;
  reason?: string;
}

/** Alert-center snapshot for the tenant, with the server-computed counts. */
export function fetchAlertCenter(
  hospitalId: string,
  options: AlertListOptions = {},
): Promise<AlertListResponseBody> {
  return callFunction<AlertListResponseBody>("alert-center", {
    action: "list",
    ...(options.status ? { status: options.status } : {}),
    ...(options.severity ? { severity: options.severity } : {}),
    ...(options.category ? { category: options.category } : {}),
    ...(options.limit ? { limit: options.limit } : {}),
  }, { hospitalId });
}

/** Alert volume + resolution analytics over the window (or the backend default). */
export function fetchAlertAnalytics(
  hospitalId: string,
  options: AlertAnalyticsOptions = {},
): Promise<AlertAnalyticsResponseBody> {
  return callFunction<AlertAnalyticsResponseBody>("alert-center", {
    action: "analytics",
    ...(options.fromDate ? { fromDate: options.fromDate } : {}),
    ...(options.toDate ? { toDate: options.toDate } : {}),
  }, { hospitalId });
}

/**
 * Acknowledge one alert. `notes` is not read by the backend for this action, so
 * it is never sent. The response is a soft-success lifecycle envelope (§12).
 */
export function acknowledgeAlert(
  hospitalId: string,
  alertId: string,
): Promise<AlertLifecycleResponseBody> {
  return callFunction<AlertLifecycleResponseBody>(
    "alert-center",
    { action: "acknowledge", alertId },
    { hospitalId },
  );
}

/**
 * Resolve one alert, with optional notes (omitted when blank so the backend
 * default applies). The `is_resolved` field is independent of acknowledgement /
 * assignment / escalation under C2 decision D1 — this wrapper asserts nothing
 * about the other fields.
 */
export function resolveAlert(
  hospitalId: string,
  alertId: string,
  notes?: string,
): Promise<AlertLifecycleResponseBody> {
  return callFunction<AlertLifecycleResponseBody>(
    "alert-center",
    { action: "resolve", alertId, ...(notes ? { notes } : {}) },
    { hospitalId },
  );
}

/** Escalate one alert (raises severity to critical), optional notes. */
export function escalateAlert(
  hospitalId: string,
  alertId: string,
  notes?: string,
): Promise<AlertLifecycleResponseBody> {
  return callFunction<AlertLifecycleResponseBody>(
    "alert-center",
    { action: "escalate", alertId, ...(notes ? { notes } : {}) },
    { hospitalId },
  );
}

/**
 * Open a suppression window for an alert KEY (not one row's lifecycle). The
 * backend does NOT dedupe overlapping windows (OD-b), so this is a plain POST
 * with no idempotency key; the caller must submit deliberately and never
 * auto-retry a rejected window (§14). `reason` is omitted when blank.
 */
export function suppressAlert(
  hospitalId: string,
  options: AlertSuppressOptions,
): Promise<AlertSuppressResponseBody> {
  return callFunction<AlertSuppressResponseBody>(
    "alert-center",
    {
      action: "suppress",
      alertKey: options.alertKey,
      activeUntil: options.activeUntil,
      ...(options.reason ? { reason: options.reason } : {}),
    },
    { hospitalId },
  );
}
