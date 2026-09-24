import type { BadgeProps } from "@/components/ui/badge";

/**
 * Payment status presentation for a booking (Phase 7 payment-status UX fix).
 *
 * The staff UI previously derived the payment badge from `payment_completed`
 * alone, so a legitimate INR 0 walk-in / manual_free booking displayed
 * "Pending" even though no SETURA payment is possible for it: `create-payment-order`
 * itself refuses a zero-fee booking with "No payment required for this booking
 * (zero platform fee)". This helper makes the UI say what the backend already
 * means. It is PRESENTATION ONLY — it owns no financial rule, computes no fee,
 * and reads no new field.
 *
 * APPROVED SEMANTICS (PHASE_7_PAYMENT_STATUS_UX_INVESTIGATION_REPORT.md §8):
 *
 *   payment_completed                 -> Paid
 *   else booking_fee_inr === 0        -> No payment required
 *   else                              -> Payment pending
 *
 * CONTRACTS that MUST NOT be "simplified":
 *   1. `payment_completed` is evaluated FIRST, deliberately. A non-runtime
 *      (fixture / offline-recognition) row can carry `payment_completed = true`
 *      with `booking_fee_inr = 0`; the UI must never hide a captured payment
 *      behind "No payment required".
 *   2. `null !== 0`. The database column is NOT NULL, but the client projection
 *      is `number | null`; a missing or null fee is therefore a data anomaly and
 *      keeps the pre-existing "Payment pending" rendering. Never coerce with
 *      `Number(value || 0)` here — that would turn missing data into "No payment
 *      required", i.e. a false financial all-clear.
 *   3. `total_amount_snapshot` is NOT an input. D16: SETURA collects only the
 *      booking/platform fee, so the total also carries money SETURA never
 *      collects and must not decide payment semantics.
 */
export type PaymentStatusKey =
  | "paid"
  | "no_payment_required"
  | "pending";

export interface PaymentStatus {
  key: PaymentStatusKey;
  /** Exact badge text. */
  label: string;
  /** Existing `Badge` variant — no new styling infrastructure. */
  variant: NonNullable<BadgeProps["variant"]>;
}

/** The minimum authoritative fields; `BookingRow` already satisfies it. */
export interface PaymentStatusInput {
  payment_completed: boolean;
  booking_fee_inr: number | null;
}

export function paymentStatus(row: PaymentStatusInput): PaymentStatus {
  if (row.payment_completed) {
    return { key: "paid", label: "Paid", variant: "success" };
  }
  // Strict comparison on purpose: null / undefined must NOT reach this branch.
  if (row.booking_fee_inr === 0) {
    return {
      key: "no_payment_required",
      label: "No payment required",
      variant: "outline",
    };
  }
  return {
    key: "pending",
    label: "Payment pending",
    variant: "secondary",
  };
}
