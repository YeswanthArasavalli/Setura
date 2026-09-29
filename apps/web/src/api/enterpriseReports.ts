import { callFunction } from "@/lib/api";
import type {
  AuditIntegrityResponse,
  AuditSearchFilters,
  AuditSearchResponseBody,
  DoctorOpsIntegrityResponse,
  IntegrationMatrixResponse,
  QueueIntegrityResponse,
  SettlementIntegrityResponse,
} from "@/types/api";

/**
 * Read-only boundary over the EXISTING `enterprise-reports` Edge Function
 * (Phase 7 G-05 admin audit & compliance viewer).
 *
 * The console owns nothing here: the six wrappers below send exactly the
 * audit/compliance actions the backend schema accepts, with no body fields
 * beyond what `enterprise-reports/index.ts` actually reads. Role + tenant
 * authorization is re-resolved server-side (`requireRole` + `X-Hospital-ID`
 * verification) — the tenant travels ONLY in the header `callFunction` sets
 * from the authenticated staff context, never in the body and never from the
 * URL. The `service_role`-only audit RPCs stay behind the function; no
 * privileged key ever reaches the browser.
 *
 * The backend's `generate` action is deliberately NOT wrapped: its
 * `financial`/`settlement` report types render money figures and are out of
 * scope for G-05 (investigation §12). There is no mutation path to introduce
 * by accident — every action here is a read that the backend itself audits.
 */

/** Executive audit search over `search_audit_logs` (backend default window:
 *  last 7 days; filters map 1:1 to the RPC parameters). */
export function fetchAuditSearch(
  hospitalId: string,
  filters: AuditSearchFilters = {},
): Promise<AuditSearchResponseBody> {
  return callFunction<AuditSearchResponseBody>(
    "enterprise-reports",
    { action: "audit_search", ...filters },
    { hospitalId },
  );
}

/** Audit referential-integrity verdict for the tenant (backend default
 *  window: last 1 day). */
export function fetchAuditIntegrity(
  hospitalId: string,
): Promise<AuditIntegrityResponse> {
  return callFunction<AuditIntegrityResponse>(
    "enterprise-reports",
    { action: "audit_integrity" },
    { hospitalId },
  );
}

/** Settlement-vs-items reconciliation verdict. A verdict, not a money
 *  surface: this viewer renders no financial figures. */
export function fetchSettlementIntegrity(
  hospitalId: string,
): Promise<SettlementIntegrityResponse> {
  return callFunction<SettlementIntegrityResponse>(
    "enterprise-reports",
    { action: "settlement_integrity" },
    { hospitalId },
  );
}

/** Queue-session invariant check (cross-hospital bookings, duplicate
 *  tokens, parallel consultations). */
export function fetchQueueIntegrity(
  hospitalId: string,
  queueSessionId: string,
): Promise<QueueIntegrityResponse> {
  return callFunction<QueueIntegrityResponse>(
    "enterprise-reports",
    { action: "queue_integrity", queueSessionId },
    { hospitalId },
  );
}

/** Doctor-day timestamp-consistency check (optional date, backend default:
 *  today). */
export function fetchDoctorOpsIntegrity(
  hospitalId: string,
  doctorId: string,
  date?: string,
): Promise<DoctorOpsIntegrityResponse> {
  return callFunction<DoctorOpsIntegrityResponse>(
    "enterprise-reports",
    { action: "doctor_ops_integrity", doctorId, ...(date ? { date } : {}) },
    { hospitalId },
  );
}

/** Booking → collection → ledger chain verdict for a hospital-day
 *  (optional date, backend default: today). */
export function fetchIntegrationMatrix(
  hospitalId: string,
  date?: string,
): Promise<IntegrationMatrixResponse> {
  return callFunction<IntegrationMatrixResponse>(
    "enterprise-reports",
    { action: "integration_matrix", ...(date ? { date } : {}) },
    { hospitalId },
  );
}
