/**
 * Alert lifecycle MUTATION presentation helpers (G-UI).
 *
 * Mirrors the discipline of `statusClosure.ts` and `cancellationStatus.ts` and
 * is PRESENTATION ONLY by contract:
 *
 *   - it owns NO authorization. `alert-center` applies `resolveAuth` +
 *     `requireRole([hospital_admin, global_admin])` + the tenant header check
 *     server-side; the role gate in the route only decides whether a control is
 *     rendered.
 *   - it owns NO state machine. Under the frozen C2 decision D1 the four
 *     lifecycle fields (`acknowledged_at`, `assigned_to`, `is_resolved`,
 *     `escalated_at`) are INDEPENDENT, `is_resolved` is NOT terminal, and there
 *     is no REOPEN. The predicates below merely hide a control the backend has
 *     ALREADY soft-committed for that single field (an `already_*` replay would
 *     be a wasted round-trip); they assert nothing about the other fields and
 *     never invent a canonical status. The lifecycle RPCs (migration 64) remain
 *     the only authority over whether an alert changed.
 *   - it owns NO suppression semantics. Suppression is an alert-KEY window
 *     (OD-b: benign overlap, no dedupe); these helpers only validate the fields
 *     the backend `Schema` already validates.
 */

/** Server-compatible boundaries, read straight from the edge `Schema` (§15).
 *  The backend stays authoritative; the frontend only avoids sending a request
 *  it already knows will 422, and never silently truncates. */
export const ALERT_NOTES_MAX = 1000;
export const SUPPRESS_REASON_MAX = 200;
export const ALERT_KEY_MIN = 3;
export const ALERT_KEY_MAX = 128;

/** Optional resolve/escalate notes boundary (`z.string().max(1000)`). Returns
 *  null when acceptable, including for the empty string the caller omits. */
export function alertNotesError(notes: string): string | null {
  if (notes.length > ALERT_NOTES_MAX) {
    return `Notes must be at most ${ALERT_NOTES_MAX} characters.`;
  }
  return null;
}

/** Optional suppression reason boundary (`z.string().max(200)`). */
export function suppressReasonError(reason: string): string | null {
  if (reason.length > SUPPRESS_REASON_MAX) {
    return `Reason must be at most ${SUPPRESS_REASON_MAX} characters.`;
  }
  return null;
}

/** Alert-key boundary (`z.string().min(3).max(128)`). */
export function alertKeyError(alertKey: string): string | null {
  if (alertKey.length < ALERT_KEY_MIN || alertKey.length > ALERT_KEY_MAX) {
    return `Alert key must be ${ALERT_KEY_MIN}–${ALERT_KEY_MAX} characters.`;
  }
  return null;
}

/**
 * `activeUntil` boundary: the backend requires an ISO-8601 datetime
 * (`z.string().datetime()`) and a suppression window that is genuinely in the
 * future. A blank, unparseable or non-future value is rejected here so the
 * deliberate suppression never fires a request the window guard would refuse.
 * The value is the raw `datetime-local` string; the caller converts it to the
 * ISO form only once this returns null.
 */
export function activeUntilError(value: string): string | null {
  if (!value) return "Choose the time until which to suppress.";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "Enter a valid date and time.";
  }
  if (parsed.getTime() <= Date.now()) {
    return "Suppression must be for a future time.";
  }
  return null;
}

/** Convert a validated `datetime-local` string to the UTC ISO instant the
 *  backend's `.datetime()` validator and the `timestamptz` column expect. */
export function toIsoDateTime(value: string): string {
  return new Date(value).toISOString();
}

/**
 * Whether ACKNOWLEDGE is still offered for a row: presentation-only, derived
 * from the server's OWN `acknowledged_at` field. A null field means the backend
 * has not acknowledged it yet; a non-null field would only ever return an
 * `already_acknowledged` replay, so the control is hidden. Says nothing about
 * resolution / escalation (D1: the fields are independent).
 */
export function canAcknowledge(alert: {
  acknowledged_at: string | null;
}): boolean {
  return alert.acknowledged_at === null;
}

/** Whether ESCALATE is still offered, from the server's `escalated_at` field. */
export function canEscalate(alert: { escalated_at: string | null }): boolean {
  return alert.escalated_at === null;
}

/** Whether RESOLVE is still offered, from the server's `is_resolved` field. */
export function canResolve(alert: { is_resolved: boolean }): boolean {
  return alert.is_resolved === false;
}

/**
 * Wording after a lifecycle attempt, from the backend response only. `ok:true`
 * with an `already_*` flag is the intrinsic replay — already in that field's
 * state — and reads as a completed outcome, never as an error and never as a
 * trigger to retry. The page then refetches the server's authoritative state
 * regardless, so this label never claims to have changed anything itself.
 */
export function lifecycleOutcomeLabel(
  action: "acknowledge" | "resolve" | "escalate",
  already: boolean,
): string {
  if (already) {
    switch (action) {
      case "acknowledge":
        return "Alert was already acknowledged. Refreshing the latest state.";
      case "resolve":
        return "Alert was already resolved. Refreshing the latest state.";
      case "escalate":
        return "Alert was already escalated. Refreshing the latest state.";
    }
    return "Alert was already in that state. Refreshing the latest state.";
  }
  switch (action) {
    case "acknowledge":
      return "Alert acknowledged.";
    case "resolve":
      return "Alert resolved.";
    case "escalate":
      return "Alert escalated.";
  }
}

/** Reads the action-specific `already_*` flag from a lifecycle result (§12). */
export function isAlreadyAck(
  action: "acknowledge" | "resolve" | "escalate",
  result: {
    already_acknowledged?: boolean;
    already_resolved?: boolean;
    already_escalated?: boolean;
  },
): boolean {
  if (action === "acknowledge") return result.already_acknowledged === true;
  if (action === "resolve") return result.already_resolved === true;
  return result.already_escalated === true;
}
