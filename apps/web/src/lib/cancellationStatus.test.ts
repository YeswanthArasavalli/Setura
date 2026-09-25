import { describe, expect, it } from "vitest";
import {
  CANCELLATION_LABEL,
  CANCELLATION_REASON_MAX,
  CANCELLATION_REASON_MIN,
  canOfferCancellation,
  cancellationOutcome,
  cancellationReasonError,
  mayOfferRefund,
  refundOutcomeLabel,
} from "./cancellationStatus";

/**
 * The cancellation presentation helper (Phase 7). These are pure-function
 * tests over already-fetched values: they prove the helper centralises wording
 * and the client input boundary WITHOUT owning authorization, a state machine
 * or a financial rule. The canonical status list and the 3–500 boundary mirror
 * `cancel-booking`, which remains the enforcement point.
 */
describe("canOfferCancellation", () => {
  it.each(["booked", "checked_in", "waiting", "called", "in_consultation"])(
    "offers the control for the cancellable status %s",
    (status) => {
      expect(canOfferCancellation(status)).toBe(true);
    },
  );

  it.each(["completed", "no_show", "rescheduled", "cancelled"])(
    "does not offer the control for %s",
    (status) => {
      expect(canOfferCancellation(status)).toBe(false);
    },
  );

  it("offers the control for an unrecognised status because the server decides", async () => {
    // Fail-open on rendering only: a status the client has never seen is still
    // rejected or accepted by the Edge Function's own transition guard.
    expect(canOfferCancellation("some_future_state")).toBe(true);
  });
});

describe("cancellationReasonError", () => {
  it("exposes the same boundary the backend schema declares", () => {
    expect(CANCELLATION_REASON_MIN).toBe(3);
    expect(CANCELLATION_REASON_MAX).toBe(500);
  });

  it.each(["", "a", "ab"])("rejects the too-short reason %j", (reason) => {
    expect(cancellationReasonError(reason)).toMatch(/at least 3 characters/);
  });

  it.each(["abc", "Patient could not attend", "x".repeat(500)])(
    "accepts the in-range reason of length %s",
    (reason) => {
      expect(cancellationReasonError(reason)).toBeNull();
    },
  );

  it("rejects an over-long reason", () => {
    expect(cancellationReasonError("y".repeat(501))).toMatch(
      /at most 500 characters/,
    );
  });

  it("measures the text as typed, without trimming or normalising it", () => {
    // Whitespace is content here: trimming would submit something other than
    // what staff typed, and would also turn "  " into a valid empty reason.
    expect(cancellationReasonError("  ")).toMatch(/at least 3 characters/);
    expect(cancellationReasonError("  a  ")).toBeNull();
  });
});

describe("cancellationOutcome", () => {
  it("is absent for a booking the database does not report as cancelled", () => {
    // A stale reason on a live row must never read as a cancellation.
    expect(
      cancellationOutcome({
        status: "waiting",
        cancellation_reason: "Left over from an earlier attempt",
        cancelled_at: "2026-09-22T11:00:00Z",
      }),
    ).toBeNull();
  });

  it("passes the reason and timestamp through unchanged", () => {
    const outcome = cancellationOutcome({
      status: "cancelled",
      cancellation_reason: "  Patient travelled  out\nof town  ",
      cancelled_at: "2026-09-22T11:00:00Z",
    });

    expect(outcome).not.toBeNull();
    expect(outcome!.reason).toBe("  Patient travelled  out\nof town  ");
    expect(outcome!.cancelledAt).toBe("2026-09-22T11:00:00Z");
    expect(outcome!.label).toBe(CANCELLATION_LABEL);
  });

  it("reports missing fields as null instead of inventing them", () => {
    const outcome = cancellationOutcome({
      status: "cancelled",
      cancellation_reason: null,
      cancelled_at: null,
    });

    expect(outcome!.reason).toBeNull();
    expect(outcome!.cancelledAt).toBeNull();
  });
});

describe("mayOfferRefund", () => {
  it.each([
    [false, 500, false],
    [true, 0, false],
    [true, null, false],
    [false, 0, false],
    [true, 500, true],
  ] as Array<[boolean, number | null, boolean]>)(
    "payment_completed=%s with fee=%s offers the request: %s",
    (paymentCompleted, fee, expected) => {
      expect(
        mayOfferRefund({
          payment_completed: paymentCompleted,
          booking_fee_inr: fee,
        }),
      ).toBe(expected);
    },
  );
});

describe("refundOutcomeLabel", () => {
  it("says initiated, never completed", () => {
    // `refundInitiated` is the only refund fact this surface has; settlement
    // is a separate backend outcome that is not observed here.
    expect(refundOutcomeLabel(true)).toBe("Refund initiated");
    expect(refundOutcomeLabel(true)).not.toMatch(/completed|refunded/i);
  });

  it("distinguishes an explicit no-refund from an unreported outcome", () => {
    expect(refundOutcomeLabel(false)).toBe("No refund requested");
    // The already-cancelled replay omits the field; absence is not a decision.
    expect(refundOutcomeLabel(undefined)).toBe(
      "Refund outcome not reported for this booking",
    );
    expect(refundOutcomeLabel(undefined)).not.toBe("No refund requested");
  });
});
