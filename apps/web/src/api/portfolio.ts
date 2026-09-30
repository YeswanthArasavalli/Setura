import { supabase } from "@/lib/supabase";
import { callFunction } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import type {
  BenchmarksResponseBody,
  PortfolioResponseBody,
} from "@/types/api";

/**
 * Read-only boundary over the EXISTING `executive-analytics` global actions
 * (Phase 7 G-08 global admin portfolio dashboard).
 *
 * These are the two `GLOBAL_ACTIONS` of the analytics Edge Function —
 * `portfolio` → `get_portfolio_dashboard` and `benchmarks` →
 * `get_cross_hospital_benchmarks`. Both RPCs are tenant-FREE: the cross-hospital
 * aggregation happens entirely server-side in SQL, so the console makes ONE
 * request per action and never loops over hospitals, never fans out per tenant
 * and never computes a benchmark, rank or total in the browser.
 *
 * Authorization is NOT a client concern. `executive-analytics` runs
 * `resolveAuth` → `requireRole([hospital_admin, global_admin])` → the
 * `GLOBAL_ACTIONS` check, and answers anything that is not a `global_admin`
 * with 403 FORBIDDEN before an RPC is touched (proved by the backend's own
 * real-HTTP suite, `ent http: auth gates enforce roles and portfolio scope`).
 * The `/admin/portfolio` route guard below is a UX boundary only.
 *
 * The header friction is real and preserved rather than hidden: the current
 * contract demands `X-Hospital-ID` even for these tenant-free actions, so the
 * caller must supply the authenticated session's tenant context. Tenant travels
 * ONLY in that header (`callFunction` sets it) — never in the body — and no
 * privileged key ever reaches the browser.
 */

/** Optional single-day override for the portfolio snapshot. When absent the
 *  RPC applies its own `CURRENT_DATE` default, which the console mirrors
 *  rather than invents. */
export interface PortfolioOptions {
  date?: string;
}

/** Optional trailing-window override for the benchmarks (backend `DATE_RE`:
 *  `YYYY-MM-DD`). Absent dates are omitted so the RPC defaults apply. */
export interface BenchmarksOptions {
  fromDate?: string;
  toDate?: string;
}

/** The hospital the console uses purely to satisfy the contract header. */
export interface ActingHospitalContext {
  hospitalId: string;
  hospitalName: string;
}

/**
 * Resolve an ACTING hospital context for a global admin whose own account
 * carries no hospital (the seeded `global_admin` reality: `role_hospital_consistency`
 * forbids a `global_admin` grant from holding a `hospital_id`, so such an
 * account can never have a native tenant).
 *
 * This is NOT a data read for display: it exists only because the current
 * `executive-analytics` contract demands `X-Hospital-ID` even for the
 * tenant-free global actions. It is one bounded SELECT under RLS —
 * `hospitals_read` is `(is_global_admin() OR user_has_hospital_access(id))`,
 * so only an already-authorized global admin sees anything — asking for the
 * single smallest row (`limit 1`, ordered by name). No hospital list, no
 * fan-out, and the returned id is used ONLY as the header value the backend
 * itself documents as non-escalating: `resolveAuth` treats a hospital the
 * caller has no grant in as the global-admin path, and both RPCs ignore the
 * tenant entirely. The UI states this context openly rather than hiding it.
 */
export async function fetchActingHospitalContext(): Promise<ActingHospitalContext | null> {
  const { data, error } = await supabase
    .from("hospitals")
    .select("id,name")
    .order("name", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new ApiError({
      code: error.code ?? "INVALID_RESPONSE",
      message: "Could not resolve the hospital context the service requires.",
      status: error.code === "42501" ? 403 : 500,
    });
  }

  if (!data) return null;
  return { hospitalId: data.id as string, hospitalName: data.name as string };
}

/** Request the all-hospitals portfolio dashboard for `date` (or the backend
 *  default day). */
export function fetchGlobalPortfolio(
  hospitalId: string,
  options: PortfolioOptions = {},
): Promise<PortfolioResponseBody> {
  return callFunction<PortfolioResponseBody>(
    "executive-analytics",
    {
      action: "portfolio",
      ...(options.date ? { date: options.date } : {}),
    },
    { hospitalId },
  );
}

/** Request the cross-hospital benchmarks for the window (or the backend's
 *  trailing-30-day default). */
export function fetchCrossHospitalBenchmarks(
  hospitalId: string,
  options: BenchmarksOptions = {},
): Promise<BenchmarksResponseBody> {
  return callFunction<BenchmarksResponseBody>(
    "executive-analytics",
    {
      action: "benchmarks",
      ...(options.fromDate ? { fromDate: options.fromDate } : {}),
      ...(options.toDate ? { toDate: options.toDate } : {}),
    },
    { hospitalId },
  );
}
