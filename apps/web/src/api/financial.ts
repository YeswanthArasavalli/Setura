import { callFunction } from "@/lib/api";
import type {
  FinancialOverviewResponseBody,
  ReconciliationResponseBody,
  RevenueForecastResponseBody,
} from "@/types/api";

/**
 * Read-only boundary over the EXISTING `financial-command-center` Edge Function
 * (Phase 7 G-09 Finance / Collections read surface).
 *
 * This wrapper owns NOTHING: each function below sends exactly one of the three
 * read actions the backend schema accepts (`FINANCE_ACTIONS` = overview /
 * forecast / reconciliation), with no body field beyond what
 * `financial-command-center/index.ts` actually reads. It performs no financial
 * arithmetic, transforms no server aggregate and invents no field — the money is
 * aggregated entirely server-side in SQL and returned verbatim.
 *
 * Authorization is NOT a client concern. The function runs `resolveAuth` →
 * `requireRole([hospital_admin, global_admin])` before any RPC, and the
 * financial RPCs (`get_financial_command_center` / `get_revenue_forecast` /
 * `get_reconciliation_summary`) are `service_role`-only at the database
 * (migration 48 §4), so a browser can never reach them directly. Tenant travels
 * ONLY in the `X-Hospital-ID` header `callFunction` sets from the authenticated
 * session — never in the body and never from the URL. No privileged key ever
 * reaches the client.
 *
 * The date model mirrors the backend exactly (§13): `overview` and `forecast`
 * take ONE optional `date`; `reconciliation` takes an optional `fromDate` /
 * `toDate` range. An absent date is OMITTED — never coerced to an empty string
 * or the browser's local day — so the RPC's own `CURRENT_DATE` / trailing-30-day
 * defaults apply rather than a client-invented business date.
 */

/** Optional single-day override shared by `overview` and `forecast`. */
export interface FinancialDayOptions {
  date?: string;
}

/** Optional trailing-window override for `reconciliation`. */
export interface FinancialRangeOptions {
  fromDate?: string;
  toDate?: string;
}

/** Financial overview for `date` (or the backend default day). */
export function fetchFinancialOverview(
  hospitalId: string,
  options: FinancialDayOptions = {},
): Promise<FinancialOverviewResponseBody> {
  return callFunction<FinancialOverviewResponseBody>(
    "financial-command-center",
    {
      action: "overview",
      ...(options.date ? { date: options.date } : {}),
    },
    { hospitalId },
  );
}

/** Revenue forecast as of `date` (or the backend default day). */
export function fetchRevenueForecast(
  hospitalId: string,
  options: FinancialDayOptions = {},
): Promise<RevenueForecastResponseBody> {
  return callFunction<RevenueForecastResponseBody>(
    "financial-command-center",
    {
      action: "forecast",
      ...(options.date ? { date: options.date } : {}),
    },
    { hospitalId },
  );
}

/** Collections→ledger reconciliation over the window (or the backend's
 *  trailing-30-day default). */
export function fetchReconciliationSummary(
  hospitalId: string,
  options: FinancialRangeOptions = {},
): Promise<ReconciliationResponseBody> {
  return callFunction<ReconciliationResponseBody>(
    "financial-command-center",
    {
      action: "reconciliation",
      ...(options.fromDate ? { fromDate: options.fromDate } : {}),
      ...(options.toDate ? { toDate: options.toDate } : {}),
    },
    { hospitalId },
  );
}
