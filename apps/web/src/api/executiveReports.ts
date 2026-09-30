import { callFunction } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import type {
  ExecutiveReportType,
  GenerateReportResponseBody,
} from "@/types/api";

/**
 * Read-only boundary over the EXISTING `enterprise-reports` `generate` action
 * (Phase 7 G-06 executive / operational reports viewer).
 *
 * This is a deliberately SEPARATE module from the G-05 audit/compliance wrapper
 * (`enterpriseReports.ts`): that module owns the six audit/compliance READ
 * actions and its own test proves it never issues `generate`. G-06 adds a
 * second, equally thin boundary for executive REPORT GENERATION only — a read
 * the backend already audits as `executive_report` — with no mutation path.
 *
 * The console owns no business logic and computes nothing: it renders whatever
 * the backend returns. `financial` and `settlement` are OUT OF SCOPE (phase
 * spec §4/§5/§38): the parameter type `ExecutiveReportType` structurally
 * excludes them, and the runtime allow-list below refuses them even if an
 * untyped caller or a cast reaches here — so it is impossible to request a
 * money-sensitive standalone report from this viewer.
 *
 * Tenant context travels ONLY in the `X-Hospital-ID` header that `callFunction`
 * sets from the authenticated staff session; it is never placed in the body.
 * The Edge Function re-authorizes role (`requireRole([hospital_admin,
 * global_admin])`) + tenant server-side before the RPC runs. No privileged key
 * ever reaches the browser.
 */

/** The six approved G-06 report types, as a value-level allow-list. */
export const GENERATE_REPORT_TYPES = [
  "daily_hospital",
  "weekly_operations",
  "monthly_executive",
  "doctor_performance",
  "sla",
  "audit",
] as const satisfies readonly ExecutiveReportType[];

/** Optional date window. Both are `YYYY-MM-DD` (backend `DATE_RE`); when
 *  omitted the backend applies its own defaults (last 7 days), which the
 *  console mirrors rather than invents. */
export interface GenerateReportOptions {
  fromDate?: string;
  toDate?: string;
}

/**
 * Generate one approved executive/operational report as json.
 *
 * `format` is intentionally not exposed: the viewer renders the structured
 * json payload; `csv`/`pdf_ready` would be a separate export concern and are
 * out of scope for G-06.
 */
export async function generateExecutiveReport(
  hospitalId: string,
  reportType: ExecutiveReportType,
  options: GenerateReportOptions = {},
): Promise<GenerateReportResponseBody> {
  // Runtime allow-list mirroring the type-level boundary. A typed caller can
  // never pass `financial`/`settlement`; this guards against a cast or an
  // untyped call site so the excluded report types stay unreachable (§8/§22).
  if (
    !(GENERATE_REPORT_TYPES as readonly string[]).includes(reportType)
  ) {
    throw new ApiError({
      code: "VALIDATION_ERROR",
      message: "This report type is not available in the reports viewer.",
      status: 422,
    });
  }

  return callFunction<GenerateReportResponseBody>(
    "enterprise-reports",
    {
      action: "generate",
      reportType,
      ...(options.fromDate ? { fromDate: options.fromDate } : {}),
      ...(options.toDate ? { toDate: options.toDate } : {}),
    },
    { hospitalId },
  );
}
