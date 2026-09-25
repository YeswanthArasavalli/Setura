/**
 * Cancellation presentation (Phase 7 booking cancellation surface).
 *
 * Centralises the wording and the client input boundary shared by the booking
 * detail page and the reception dashboard so the two cannot drift. This module
 * is PRESENTATION ONLY by contract:
 *
 *   - it owns NO authorization. `cancel-booking` applies `requireRole` +
 *     `X-Hospital-ID` + the tenant equality check server-side; the role gate in
 *     the route only decides whether a control is rendered.
 *   - it owns NO state machine. `canOfferCancellation` hides a control the
 *     backend would certainly reject; the backend's transition guard,
 *     optimistic `.eq("status", current)` check and idempotent replay remain
 *     the only authority over whether a booking became cancelled.
 *   - it owns NO financial rule. `mayOfferRefund` decides whether a checkbox
 *     appears; it never computes, requests or renders an amount, and
 *     `refundInitiated` from the backend response stays authoritative.
 */

/** Shared short label for a cancelled booking (list + detail must agree). */
export const CANCELLATION_LABEL = "Cancelled";

/**
 * Statuses `cancel-booking` will not transition from: its `UNCANCELLABLE`
 * list (`completed`, `no_show`, `rescheduled`) plus `cancelled`, which is the
 * idempotent replay branch rather than an action.
 */
const CANCELLATION_INELIGIBLE: readonly string[] = [
  "completed",
  "no_show",
  "rescheduled",
  "cancelled",
];

/** Whether the cancel control may be offered at all for this status. */
export function canOfferCancellation(status: string): boolean {
  return !CANCELLATION_INELIGIBLE.includes(status);
}

/** Server-compatible input boundary (zod `.min(3).max(500)`). */
export const CANCELLATION_REASON_MIN = 3;
export const CANCELLATION_REASON_MAX = 500;

/**
 * Validate a cancellation reason exactly as the backend will, WITHOUT altering
 * it: no trim, no case change, no whitespace collapse, so the text staff typed
 * is character-for-character the text submitted. Returns null when acceptable.
 */
export function cancellationReasonError(reason: string): string | null {
  if (reason.length < CANCELLATION_REASON_MIN) {
    return `Reason must be at least ${CANCELLATION_REASON_MIN} characters.`;
  }
  if (reason.length > CANCELLATION_REASON_MAX) {
    return `Reason must be at most ${CANCELLATION_REASON_MAX} characters.`;
  }
  return null;
}

/** The authoritative fields already on the booking read. */
export interface CancellationOutcomeInput {
  status: string;
  cancellation_reason: string | null;
  cancelled_at: string | null;
}

export interface CancellationOutcome {
  label: string;
  /** Verbatim staff text; null when the row carries none (the column is
   *  nullable and the refund path can also write it). */
  reason: string | null;
  /** Raw database timestamp; null when the row carries none. */
  cancelledAt: string | null;
}

/**
 * Non-null only for a booking the database itself reports as cancelled. A
 * non-cancelled booking never renders a cancellation outcome, so a stale or
 * absent reason can never imply a cancellation that did not happen.
 */
export function cancellationOutcome(
  row: CancellationOutcomeInput,
): CancellationOutcome | null {
  if (row.status !== "cancelled") return null;
  return {
    label: CANCELLATION_LABEL,
    reason: row.cancellation_reason ?? null,
    cancelledAt: row.cancelled_at ?? null,
  };
}

/**
 * Offer the refund checkbox only when a refund is even conceivable: the payment
 * was captured AND a non-zero SETURA booking fee exists. `booking_fee_inr` is
 * nullable in the client projection, so a missing fee must not reveal the
 * control — the same "null is not zero" discipline the payment badge uses.
 */
export function mayOfferRefund(row: {
  payment_completed: boolean;
  booking_fee_inr: number | null;
}): boolean {
  return row.payment_completed === true && (row.booking_fee_inr ?? 0) > 0;
}

/**
 * Wording for the refund line after a cancellation attempt. `undefined` means
 * the backend did not report the field (the already-cancelled replay), which
 * must never be rendered as "No refund requested", and "initiated" is not the
 * same claim as "refunded" — settlement of a refund is a separate backend
 * outcome this surface does not observe.
 */
export function refundOutcomeLabel(refundInitiated: boolean | undefined): string {
  if (refundInitiated === true) return "Refund initiated";
  if (refundInitiated === false) return "No refund requested";
  return "Refund outcome not reported for this booking";
}
