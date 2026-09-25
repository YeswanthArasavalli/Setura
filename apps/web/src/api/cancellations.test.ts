import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The cancellation mutation boundary (Phase 7). Only `callFunction` is mocked:
 * the test pins WHAT leaves the console — the exact three-field backend body,
 * the authenticated tenant context and a backend-acceptable idempotency key —
 * not the transport itself (covered by lib/api's own behaviour and the
 * integration suite's real dispatch against `cancel-booking`).
 */
const callFunction = vi.fn();
vi.mock("@/lib/api", () => ({
  callFunction: (...a: unknown[]) => callFunction(...a),
}));

const { cancelBooking } = await import("@/api/cancellations");

const replay = {
  bookingId: "b-1",
  cancelled: true,
  alreadyCancelled: false,
  refundInitiated: false,
};

beforeEach(() => {
  callFunction.mockReset().mockResolvedValue(replay);
});

describe("cancelBooking", () => {
  it("posts the exact backend contract through the shared function caller", async () => {
    await cancelBooking(
      {
        bookingId: "b-1",
        cancellationReason: "Patient unwell",
        initiateRefund: true,
      },
      "h-1",
      "11111111-1111-4111-8111-111111111111",
    );

    expect(callFunction).toHaveBeenCalledWith(
      "cancel-booking",
      {
        bookingId: "b-1",
        cancellationReason: "Patient unwell",
        initiateRefund: true,
      },
      {
        hospitalId: "h-1",
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
      },
    );
  });

  it("mints a UUID-v4 idempotency key when the caller supplies none", async () => {
    await cancelBooking(
      {
        bookingId: "b-1",
        cancellationReason: "Duplicate entry",
        initiateRefund: false,
      },
      "h-1",
    );

    const opts = callFunction.mock.calls[0][2] as { idempotencyKey: string };
    // The shared idempotency layer rejects anything but a bare UUID v4, so a
    // scoped or prefixed key would fail the submission outright.
    expect(opts.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("sends no tenant id, no fee and no refund amount in the body", async () => {
    await cancelBooking(
      {
        bookingId: "b-1",
        cancellationReason: "Cancelled at reception",
        initiateRefund: false,
      },
      "h-1",
    );

    const [, body] = callFunction.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(Object.keys(body).sort()).toEqual([
      "bookingId",
      "cancellationReason",
      "initiateRefund",
    ]);
    // Tenant travels ONLY in the X-Hospital-ID context callFunction adds; any
    // hospital/amount field here would be a second, client-trusted source.
    expect(JSON.stringify(body)).not.toMatch(/hospital|amount|inr|fee/i);
  });

  it("resolves with the backend's structured outcome unchanged", async () => {
    const already = {
      bookingId: "b-1",
      cancelled: true,
      alreadyCancelled: true,
    };
    callFunction.mockResolvedValue(already);

    const res = await cancelBooking(
      {
        bookingId: "b-1",
        cancellationReason: "Duplicate entry",
        initiateRefund: false,
      },
      "h-1",
    );

    // No client-side rewriting: `refundInitiated` stays absent on a replay.
    expect(res).toEqual(already);
    expect("refundInitiated" in res).toBe(false);
  });
});
