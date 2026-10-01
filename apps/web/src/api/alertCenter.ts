import { callFunction } from "@/lib/api";
import type {
  AlertAnalyticsResponseBody,
  AlertListResponseBody,
} from "@/types/api";

/**
 * Read-only boundary over the EXISTING `alert-center` Edge Function
 * (Phase 7 G-10 alert-center read surface).
 *
 * This wrapper owns NOTHING: it sends exactly the two READ actions the backend
 * schema accepts (`list` and `analytics`) — never `acknowledge` / `assign` /
 * `resolve` / `escalate` / `suppress`, which are a separate future mutation
 * workstream (§3). There is deliberately no exported wrapper that could reach a
 * mutation, so one cannot be introduced by accident, and no body field beyond
 * what `alert-center/index.ts` actually reads. It performs no counting,
 * grouping or resolution-rate arithmetic — every statistic is aggregated
 * entirely server-side in SQL and returned verbatim.
 *
 * Authorization is NOT a client concern. The function runs `resolveAuth` →
 * `requireRole([hospital_admin, global_admin])` and validates the tenant header
 * BEFORE any RPC (the live HTTP suite `alert_center_http.test.ts` proves a
 * receptionist/doctor gets a fail-closed 403 `ROLE_INSUFFICIENT` and a foreign
 * tenant a 403 `HOSPITAL_ACCESS_DENIED` — never a 500, closing the P3-01
 * caveat). The alert RPCs (`get_alert_center` / `get_alert_analytics`) are
 * `service_role`-only at the database (migration 47 §13 + migration 48
 * hardening), so a browser can never reach them directly. Tenant travels ONLY
 * in the `X-Hospital-ID` header `callFunction` sets from the authenticated
 * session — never in the body and never from the URL. No privileged key ever
 * reaches the client.
 *
 * The filter model mirrors the backend exactly (§13/§17): `list` takes optional
 * `status` / `severity` / `category` / `limit`; `analytics` takes an optional
 * `fromDate` / `toDate` range. An absent value is OMITTED — never coerced to an
 * empty string or a browser-invented default — so the RPC's own defaults
 * (`p_status = 'open'`, `p_limit = 50`, trailing-30-day window) apply.
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
