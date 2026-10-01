import { callFunction } from "@/lib/api";
import type {
  DailyOperationsResponseBody,
  DoctorRankingsResponseBody,
} from "@/types/api";

/**
 * Read-only boundary over the two EXISTING tenant-scoped `executive-analytics`
 * read actions (Phase 7 G-11 hospital operations analytics surface).
 *
 * This wrapper owns NOTHING: it sends exactly `daily_operations` and
 * `doctor_rankings` — the only two actions exposed here — with no body field
 * beyond what `executive-analytics/index.ts` actually reads (`date` for the
 * daily dashboard, `fromDate`/`toDate` for the rankings window). There is
 * deliberately no exported wrapper for any other action: `portfolio` and
 * `benchmarks` belong to G-08 (`api/portfolio.ts`), the generated
 * `weekly_operations` / `monthly_executive` / `doctor_performance` reports to
 * G-06 (`api/executiveReports.ts` via `enterprise-reports`), and the direct
 * analytics variants of those two actions are OUT OF SCOPE for this surface
 * (investigation §15; phase spec §3/§4). No count, rate, rank or total is
 * computed here — every statistic is aggregated entirely server-side in SQL
 * (migrations 47/49) and returned verbatim.
 *
 * Authorization is NOT a client concern. The function checks the
 * `X-Hospital-ID` header, then runs `resolveAuth` →
 * `requireRole([hospital_admin, global_admin])` before any RPC, and the two
 * analytics RPCs (`get_daily_operations_dashboard` / `get_doctor_rankings`)
 * are `service_role`-only at the database (migration 49 privilege hardening),
 * so a browser can never reach them directly. Both actions are TENANT-SCOPED —
 * they are not in `GLOBAL_ACTIONS`, no cross-hospital aggregation exists on
 * this path, and a global admin's request answers for exactly the one acting
 * hospital context (the established G-08/G-09 mechanism). Tenant travels ONLY
 * in the `X-Hospital-ID` header `callFunction` sets from the authenticated
 * session — never in the body and never from the URL. No privileged key ever
 * reaches the client.
 *
 * The date model mirrors the backend exactly (§14): `daily_operations` takes
 * ONE optional `date`; `doctor_rankings` takes an optional `fromDate` /
 * `toDate` range. An absent date is OMITTED — never coerced to an empty
 * string or the browser's local day — so the RPC's own `CURRENT_DATE` /
 * trailing-30-day defaults apply rather than a client-invented business date.
 */

/** Optional single-day override for the daily operations dashboard. */
export interface DailyOperationsOptions {
  date?: string;
}

/** Optional trailing-window override for the rankings (backend `DATE_RE`:
 *  `YYYY-MM-DD`). Absent bounds are omitted so the RPC defaults apply. */
export interface DoctorRankingsOptions {
  fromDate?: string;
  toDate?: string;
}

/** Daily operations dashboard for `date` (or the backend default day). */
export function fetchDailyOperations(
  hospitalId: string,
  options: DailyOperationsOptions = {},
): Promise<DailyOperationsResponseBody> {
  return callFunction<DailyOperationsResponseBody>(
    "executive-analytics",
    {
      action: "daily_operations",
      ...(options.date ? { date: options.date } : {}),
    },
    { hospitalId },
  );
}

/** Comparative doctor rankings + utilization over the window (or the
 *  backend's trailing-30-day default). */
export function fetchDoctorRankings(
  hospitalId: string,
  options: DoctorRankingsOptions = {},
): Promise<DoctorRankingsResponseBody> {
  return callFunction<DoctorRankingsResponseBody>(
    "executive-analytics",
    {
      action: "doctor_rankings",
      ...(options.fromDate ? { fromDate: options.fromDate } : {}),
      ...(options.toDate ? { toDate: options.toDate } : {}),
    },
    { hospitalId },
  );
}
