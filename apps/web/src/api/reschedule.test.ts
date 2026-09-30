import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The reschedule mutation boundary (G-07). Only `callFunction` is mocked: the
 * test pins WHAT leaves the console — the exact backend body, the authenticated
 * tenant context and a backend-acceptable idempotency key — not the transport
 * itself (covered by lib/api's own behaviour and the integration suite's real
 * dispatch against `reschedule-booking`).
 */
const callFunction = vi.fn();
vi.mock("@/lib/api", () => ({
  callFunction: (...a: unknown[]) => callFunction(...a),
}));

const { rescheduleBooking } = await import("@/api/reschedule");

const outcome = {
  originalBookingId: "b-1",
  newBookingId: "b-2",
  newTokenNumber: 12,
  newDate: "2026-10-03",
};

beforeEach(() => {
  callFunction.mockReset().mockResolvedValue(outcome);
});

describe("rescheduleBooking", () => {
  it("posts the exact backend contract through the shared function caller", async () => {
    await rescheduleBooking(
      { bookingId: "b-1", newDate: "2026-10-03", reason: "Patient travelling" },
      "h-1",
      "11111111-1111-4111-8111-111111111111",
    );

    expect(callFunction).toHaveBeenCalledWith(
      "reschedule-booking",
      { bookingId: "b-1", newDate: "2026-10-03", reason: "Patient travelling" },
      {
        hospitalId: "h-1",
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
      },
    );
  });

  it("mints a UUID-v4 idempotency key when the caller supplies none", async () => {
    await rescheduleBooking({ bookingId: "b-1", newDate: "2026-10-03" }, "h-1");

    const opts = callFunction.mock.calls[0][2] as { idempotencyKey: string };
    // The shared idempotency layer rejects anything but a bare UUID v4, so a
    // scoped or prefixed key would fail the submission outright.
    expect(opts.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("sends no tenant id, no fee and no doctor override unless requested", async () => {
    await rescheduleBooking({ bookingId: "b-1", newDate: "2026-10-03" }, "h-1");

    const [, body] = callFunction.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    // `newDoctorId` and `reason` are optional and omitted when absent, so the
    // backend keeps the original doctor and records no reason.
    expect(Object.keys(body).sort()).toEqual(["bookingId", "newDate"]);
    // Tenant travels ONLY in the X-Hospital-ID context callFunction adds.
    expect(JSON.stringify(body)).not.toMatch(/hospital|amount|inr|fee/i);
  });

  it("includes newDoctorId only when the caller requests a reassignment", async () => {
    await rescheduleBooking(
      { bookingId: "b-1", newDate: "2026-10-03", newDoctorId: "d-2" },
      "h-1",
    );

    const [, body] = callFunction.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(body).toEqual({
      bookingId: "b-1",
      newDate: "2026-10-03",
      newDoctorId: "d-2",
    });
  });

  it("resolves with the backend's structured outcome unchanged", async () => {
    const res = await rescheduleBooking(
      { bookingId: "b-1", newDate: "2026-10-03" },
      "h-1",
    );

    // No client-side rewriting: the new booking/token/date come from the server.
    expect(res).toEqual(outcome);
  });
});
