import { describe, expect, it } from "vitest";
import { paymentStatus } from "./paymentStatus";

/**
 * The single authoritative payment-label mapping used by BOTH the reception
 * list and BookingDetail (Phase 7 payment-status UX fix). These are pure
 * function tests over an already-fetched booking row: no read path, no fee
 * computation and no financial rule is exercised here.
 */
describe("paymentStatus (Phase 7 payment-status UX)", () => {
  it("reads a zero-fee unpaid booking as no payment required, not pending", () => {
    expect(
      paymentStatus({ payment_completed: false, booking_fee_inr: 0 }),
    ).toEqual({
      key: "no_payment_required",
      label: "No payment required",
      variant: "outline",
    });
  });

  it("reads a non-zero unpaid booking as payment pending", () => {
    expect(
      paymentStatus({ payment_completed: false, booking_fee_inr: 20 }),
    ).toEqual({
      key: "pending",
      label: "Payment pending",
      variant: "secondary",
    });
  });

  it("reads a captured payment as paid", () => {
    expect(
      paymentStatus({ payment_completed: true, booking_fee_inr: 20 }),
    ).toEqual({ key: "paid", label: "Paid", variant: "success" });
  });

  // CRITICAL ORDERING GUARD: payment_completed is evaluated first so a paid
  // state can never be hidden behind "No payment required".
  it("never hides a paid booking behind the zero-fee branch", () => {
    const status = paymentStatus({
      payment_completed: true,
      booking_fee_inr: 0,
    });
    expect(status.key).toBe("paid");
    expect(status.label).toBe("Paid");
    expect(status.label).not.toBe("No payment required");
  });

  // null is a data anomaly, NOT a zero fee: it must not become an all-clear.
  it("treats a null fee as pending because null is not zero", () => {
    expect(
      paymentStatus({ payment_completed: false, booking_fee_inr: null }),
    ).toEqual({
      key: "pending",
      label: "Payment pending",
      variant: "secondary",
    });
  });

  // Same guard expressed as an undefined projection: a field the row never
  // carried must not be coerced into a zero fee either.
  it("treats an absent fee as pending for the same reason", () => {
    const missing = undefined as unknown as number | null;
    expect(paymentStatus({ payment_completed: false, booking_fee_inr: missing }).key).toBe(
      "pending",
    );
  });

  it("ignores everything except the two authoritative fields", () => {
    // A large hospital-side total must not make an unpaid zero-fee booking
    // look payable, and must not change a paid one (D16: SETURA collects only
    // the booking fee, so total_amount_snapshot is display-only).
    const row = {
      payment_completed: false,
      booking_fee_inr: 0,
      total_amount_snapshot: 500,
    };
    expect(paymentStatus(row).key).toBe("no_payment_required");
  });
});
