import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/errors";

/**
 * The G-03 read boundary. Only `callFunction` is mocked: the tests pin WHAT
 * leaves the console — the exact `command-center` action, the authenticated
 * tenant context via the shared header mechanism, the deliberate ABSENCE of
 * any `broadcast_*` action or idempotency key, and untouched error
 * propagation — not the transport itself (covered by lib/api and the real-HTTP
 * backend suite `enterprise_command_center.test.ts`).
 */
const callFunction = vi.fn();
vi.mock("@/lib/api", () => ({
  callFunction: (...a: unknown[]) => callFunction(...a),
}));

const {
  fetchCommandCenterOverview,
  fetchCommandCenterPredictive,
  fetchCommandCenterSla,
  fetchCommandCenterSystemHealth,
  fetchCommandCenterTimeline,
} = await import("@/api/commandCenter");

beforeEach(() => {
  callFunction.mockReset().mockResolvedValue({ ok: true });
});

describe("command-center read wrappers", () => {
  it("posts each exact read action through the shared function caller", async () => {
    await fetchCommandCenterOverview("h-1");
    await fetchCommandCenterTimeline("h-1");
    await fetchCommandCenterPredictive("h-1");
    await fetchCommandCenterSla("h-1");
    await fetchCommandCenterSystemHealth("h-1");

    expect(callFunction.mock.calls.map((c) => c[1])).toEqual([
      { action: "overview" },
      { action: "timeline" },
      { action: "predictive" },
      { action: "sla_dashboard" },
      { action: "system_health" },
    ]);
    for (const call of callFunction.mock.calls) {
      expect(call[0]).toBe("command-center");
    }
  });

  it("sends the tenant only through the shared callFunction context, never the body", async () => {
    await fetchCommandCenterOverview("h-1");

    // The established pattern: exactly { hospitalId } in the options, so the
    // tenant travels in the X-Hospital-ID header that callFunction sets.
    expect(callFunction.mock.calls[0][2]).toEqual({ hospitalId: "h-1" });
    const [, body] = callFunction.mock.calls[0] as [string, Record<string, unknown>];
    expect(JSON.stringify(body)).not.toMatch(/hospital/i);
  });

  it("sends no idempotency key: these are reads, and replays must not be framed as mutations", async () => {
    await fetchCommandCenterTimeline("h-1");

    const opts = callFunction.mock.calls[0][2] as Record<string, unknown>;
    expect("idempotencyKey" in opts).toBe(false);
  });

  it("never references any broadcast_* action anywhere in the wrapper layer", async () => {
    // Exhaustive surface check: the module exposes ONLY the five read
    // wrappers, and every request they can produce carries a read action.
    const module = await import("@/api/commandCenter");
    expect(Object.keys(module).sort()).toEqual([
      "fetchCommandCenterOverview",
      "fetchCommandCenterPredictive",
      "fetchCommandCenterSla",
      "fetchCommandCenterSystemHealth",
      "fetchCommandCenterTimeline",
    ]);

    await fetchCommandCenterOverview("h-1");
    await fetchCommandCenterTimeline("h-1");
    await fetchCommandCenterPredictive("h-1");
    await fetchCommandCenterSla("h-1");
    await fetchCommandCenterSystemHealth("h-1");
    for (const call of callFunction.mock.calls) {
      const body = call[1] as { action: string };
      expect(body.action).not.toMatch(/^broadcast/);
    }
  });

  it("propagates backend errors unchanged — no silent swallowing into empty data", async () => {
    const err = new ApiError({
      code: "FORBIDDEN",
      message: "You do not have permission to perform this action.",
      status: 403,
    });
    callFunction.mockRejectedValue(err);

    await expect(fetchCommandCenterOverview("h-1")).rejects.toBe(err);
  });

  it("resolves with the backend envelope payload verbatim", async () => {
    const payload = { action: "overview", overview: null, scores: null };
    callFunction.mockResolvedValue(payload);

    await expect(fetchCommandCenterOverview("h-1")).resolves.toBe(payload);
  });
});
