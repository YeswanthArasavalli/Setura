import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The status-closure mutation boundary (Phase 7 G-02). Only `callFunction` is
 * mocked: the test pins WHAT leaves the console — the exact backend-schema
 * body, the authenticated tenant context and the deliberate ABSENCE of an
 * Idempotency-Key (the endpoint does not read the header; its replay safety
 * is intrinsic) — not the transport itself (covered by lib/api's own
 * behaviour and the integration suite's real HTTP dispatch against
 * `update-booking-status`, E1 06 / S1 05).
 */
const callFunction = vi.fn();
vi.mock("@/lib/api", () => ({
  callFunction: (...a: unknown[]) => callFunction(...a),
}));

const { updateBookingStatus } = await import("@/api/statuses");

const ok = { bookingId: "b-1", status: "checked_in", changed: true };

beforeEach(() => {
  callFunction.mockReset().mockResolvedValue(ok);
});

describe("updateBookingStatus", () => {
  it("posts the exact backend contract through the shared function caller", async () => {
    await updateBookingStatus({ bookingId: "b-1", newStatus: "checked_in" }, "h-1");

    expect(callFunction).toHaveBeenCalledWith(
      "update-booking-status",
      { bookingId: "b-1", newStatus: "checked_in" },
      { hospitalId: "h-1" },
    );
  });

  it("sends no Idempotency-Key: replay safety is the endpoint's own", async () => {
    await updateBookingStatus({ bookingId: "b-1", newStatus: "no_show" }, "h-1");

    const opts = callFunction.mock.calls[0][2] as Record<string, unknown>;
    expect("idempotencyKey" in opts).toBe(false);
    expect(Object.keys(opts)).toEqual(["hospitalId"]);
  });

  it("omits the notes key entirely when absent — never an empty string", async () => {
    await updateBookingStatus({ bookingId: "b-1", newStatus: "no_show" }, "h-1");

    const [, body] = callFunction.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(Object.keys(body).sort()).toEqual(["bookingId", "newStatus"]);
  });

  it("passes a typed note through verbatim, without trimming", async () => {
    const typed = "  patient never travelled  ";
    await updateBookingStatus(
      { bookingId: "b-1", newStatus: "no_show", notes: typed },
      "h-1",
    );

    const [, body] = callFunction.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.notes).toBe(typed);
    expect(Object.keys(body).sort()).toEqual([
      "bookingId",
      "newStatus",
      "notes",
    ]);
  });

  it("sends no tenant id, no fee and no money field in the body", async () => {
    await updateBookingStatus(
      { bookingId: "b-1", newStatus: "checked_in", notes: "arrived" },
      "h-1",
    );

    const [, body] = callFunction.mock.calls[0] as [string, Record<string, unknown>];
    // Tenant travels ONLY in the X-Hospital-ID context callFunction adds.
    expect(JSON.stringify(body)).not.toMatch(/hospital|amount|inr|fee|refund/i);
  });

  it("resolves with the backend's structured outcome unchanged", async () => {
    const replay = { bookingId: "b-1", status: "no_show", changed: false };
    callFunction.mockResolvedValue(replay);

    const res = await updateBookingStatus(
      { bookingId: "b-1", newStatus: "no_show" },
      "h-1",
    );

    // No client-side rewriting: `changed:false` stays the authoritative
    // no-op-success signal.
    expect(res).toEqual(replay);
  });
});
