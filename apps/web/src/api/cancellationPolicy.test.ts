import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/errors";

/**
 * WS-CONF-1 — the `cancellation-policy` browser boundary. Only `callFunction`
 * is mocked: these tests pin exactly WHAT leaves the console for the two
 * surfaces and nothing more.
 *
 *  - `getCancellationPolicy` is a READ: exact `mode:"read"`, the acting
 *    hospital only in the shared transport header, and NO Idempotency-Key;
 *  - `updateCancellationPolicy` is the MUTATION: exact `mode:"update"`, the
 *    expected version and the field-level patch in the body, and a stable
 *    Idempotency-Key always forwarded;
 *  - an absent patch is OMITTED from the body (never sent as `{}` vs a key
 *    the backend treats differently), and the tenant id never rides in the
 *    body — tenancy is the transport header resolved server-side;
 *  - backend refusals (403/409/422) propagate unchanged.
 *
 * Live transport, JWT role authorization, the RPC version check and audit are
 * proven by the backend real-HTTP + DB suites, not here.
 */
const callFunction = vi.fn();
vi.mock("@/lib/api", () => ({
  callFunction: (...a: unknown[]) => callFunction(...a),
}));

const { getCancellationPolicy, updateCancellationPolicy } = await import(
  "@/api/cancellationPolicy"
);

beforeEach(() => {
  callFunction.mockReset();
});

describe("getCancellationPolicy (read)", () => {
  it("posts the exact read body with the hospital only in the header", async () => {
    callFunction.mockResolvedValue({
      hospitalId: "h-1",
      version: 1,
      policy: {},
      history: [],
    });
    await getCancellationPolicy("h-1");

    expect(callFunction).toHaveBeenCalledTimes(1);
    const [fn, body, opts] = callFunction.mock.calls[0]!;
    expect(fn).toBe("cancellation-policy");
    expect(body).toEqual({ mode: "read" });
    expect(opts).toEqual({ hospitalId: "h-1" });
  });

  it("sends NO Idempotency-Key: a read is not a mutation", async () => {
    callFunction.mockResolvedValue({ hospitalId: "h-1", version: 1 });
    await getCancellationPolicy("h-1");
    const opts = callFunction.mock.calls[0]![2] as Record<string, unknown>;
    expect("idempotencyKey" in opts).toBe(false);
  });

  it("propagates a backend refusal unchanged", async () => {
    const err = new ApiError({
      code: "FORBIDDEN",
      message: "Not authorized for this cancellation policy",
      status: 403,
    });
    callFunction.mockRejectedValue(err);
    await expect(getCancellationPolicy("h-1")).rejects.toBe(err);
  });
});

describe("updateCancellationPolicy (mutation)", () => {
  it("posts the exact update body and forwards the key", async () => {
    callFunction.mockResolvedValue({
      hospitalId: "h-1",
      version: 2,
      updated: true,
    });
    await updateCancellationPolicy("h-1", "key-abc", {
      expectedVersion: 1,
      patch: { full_refund_within_minutes: 45, notes: "Longer window" },
    });

    const [fn, body, opts] = callFunction.mock.calls[0]!;
    expect(fn).toBe("cancellation-policy");
    expect(body).toEqual({
      mode: "update",
      expectedVersion: 1,
      patch: { full_refund_within_minutes: 45, notes: "Longer window" },
    });
    expect(opts).toEqual({ hospitalId: "h-1", idempotencyKey: "key-abc" });
  });

  it("omits the patch entirely when none was supplied", async () => {
    callFunction.mockResolvedValue({
      hospitalId: "h-1",
      version: 2,
      updated: false,
    });
    await updateCancellationPolicy("h-1", "key-xyz", { expectedVersion: 2 });
    const [, body] = callFunction.mock.calls[0]!;
    expect(body).toEqual({ mode: "update", expectedVersion: 2 });
    expect("patch" in (body as Record<string, unknown>)).toBe(false);
  });

  it("never carries the hospital id inside the body", async () => {
    callFunction.mockResolvedValue({ hospitalId: "h-1", version: 3 });
    await updateCancellationPolicy("h-1", "k", {
      expectedVersion: 2,
      patch: { same_day_refund_percentage: 10 },
    });
    const [, body, opts] = callFunction.mock.calls[0]!;
    expect(JSON.stringify(body)).not.toMatch(/hospital/i);
    expect((opts as Record<string, unknown>).hospitalId).toBe("h-1");
  });

  it("propagates a 409 concurrency refusal unchanged", async () => {
    const err = new ApiError({
      code: "DB_CONCURRENCY_ERROR",
      message: "Policy was changed by someone else. Reload and try again.",
      status: 409,
    });
    callFunction.mockRejectedValue(err);
    await expect(
      updateCancellationPolicy("h-1", "k", {
        expectedVersion: 1,
        patch: { notes: "stale" },
      }),
    ).rejects.toBe(err);
  });

  it("propagates a 422 validation refusal unchanged", async () => {
    const err = new ApiError({
      code: "VALIDATION_ERROR",
      message: "Policy rejected",
      status: 422,
    });
    callFunction.mockRejectedValue(err);
    await expect(
      updateCancellationPolicy("h-1", "k", {
        expectedVersion: 1,
        patch: { same_day_refund_percentage: 150 },
      }),
    ).rejects.toBe(err);
  });
});
