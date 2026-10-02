import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/errors";

/**
 * The command-center boundary: G-03 read wrappers + C2b broadcast wrappers.
 * Only `callFunction` is mocked: the tests pin WHAT leaves the console — the
 * exact `command-center` action and fields, the authenticated tenant context via
 * the shared header mechanism, the deliberate ABSENCE of any recipient list /
 * hospital id in a body, the ABSENCE of any client idempotency key (the backend
 * owns deterministic enqueue-job idempotency), and untouched error propagation —
 * not the transport itself (covered by lib/api and the real-HTTP backend suite
 * `enterprise_command_center.test.ts`).
 */
const callFunction = vi.fn();
vi.mock("@/lib/api", () => ({
  callFunction: (...a: unknown[]) => callFunction(...a),
}));

const {
  broadcastAdminNotice,
  broadcastAlert,
  broadcastClosure,
  broadcastDoctorDelay,
  broadcastQueueSummary,
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

describe("command-center read/broadcast module surface", () => {
  it("exposes exactly the five reads plus the five C2b broadcast wrappers", async () => {
    const module = await import("@/api/commandCenter");
    expect(Object.keys(module).sort()).toEqual([
      "broadcastAdminNotice",
      "broadcastAlert",
      "broadcastClosure",
      "broadcastDoctorDelay",
      "broadcastQueueSummary",
      "fetchCommandCenterOverview",
      "fetchCommandCenterPredictive",
      "fetchCommandCenterSla",
      "fetchCommandCenterSystemHealth",
      "fetchCommandCenterTimeline",
    ]);
  });

  it("keeps every read action free of any broadcast_* reference and vice-versa", async () => {
    await fetchCommandCenterOverview("h-1");
    await fetchCommandCenterSystemHealth("h-1");
    for (const call of callFunction.mock.calls) {
      const body = call[1] as { action: string };
      expect(body.action).not.toMatch(/^broadcast/);
    }
  });
});

describe("C2b broadcast wrappers", () => {
  it("broadcast_queue_summary sends the exact action + required session only", async () => {
    await broadcastQueueSummary("h-1", "sess-9");
    expect(callFunction.mock.calls[0][0]).toBe("command-center");
    expect(callFunction.mock.calls[0][1]).toEqual({
      action: "broadcast_queue_summary",
      queueSessionId: "sess-9",
    });
  });

  it("broadcast_doctor_delay sends session + delay and omits a blank reason", async () => {
    await broadcastDoctorDelay("h-1", {
      queueSessionId: "sess-9",
      delayMinutes: 15,
      reason: "",
    });
    expect(callFunction.mock.calls[0][1]).toEqual({
      action: "broadcast_doctor_delay",
      queueSessionId: "sess-9",
      delayMinutes: 15,
    });

    await broadcastDoctorDelay("h-1", {
      queueSessionId: "sess-9",
      delayMinutes: 30,
      reason: "traffic",
    });
    expect(callFunction.mock.calls[1][1]).toEqual({
      action: "broadcast_doctor_delay",
      queueSessionId: "sess-9",
      delayMinutes: 30,
      reason: "traffic",
    });
  });

  it("broadcast_closure omits both optional fields when unset", async () => {
    await broadcastClosure("h-1", {});
    expect(callFunction.mock.calls[0][1]).toEqual({
      action: "broadcast_closure",
    });

    await broadcastClosure("h-1", { date: "2026-10-02", reason: "power" });
    expect(callFunction.mock.calls[1][1]).toEqual({
      action: "broadcast_closure",
      date: "2026-10-02",
      reason: "power",
    });
  });

  it("broadcast_admin_notice sends kind + message (never a recipient list)", async () => {
    await broadcastAdminNotice("h-1", {
      kind: "congestion",
      message: "Ward B is congested.",
    });
    expect(callFunction.mock.calls[0][1]).toEqual({
      action: "broadcast_admin_notice",
      kind: "congestion",
      message: "Ward B is congested.",
    });
  });

  it("broadcast_alert sends alertId only (reason is not read for this action)", async () => {
    await broadcastAlert("h-1", { alertId: "alert-7" });
    expect(callFunction.mock.calls[0][1]).toEqual({
      action: "broadcast_alert",
      alertId: "alert-7",
    });
  });

  it("sends the tenant in the header context only, never in any broadcast body", async () => {
    await broadcastQueueSummary("h-1", "sess-9");
    await broadcastAdminNotice("h-1", { kind: "sla_breach", message: "m" });
    await broadcastAlert("h-1", { alertId: "a-1" });

    for (const call of callFunction.mock.calls) {
      expect(call[2]).toEqual({ hospitalId: "h-1" });
      // Defense in depth: no hospital id / recipient / phone in the body.
      const body = JSON.stringify(call[1]).toLowerCase();
      expect(body).not.toMatch(/hospital|recipient|phone|patient/);
    }
  });

  it("mints no idempotency key — the backend deterministic enqueue key owns replay safety", async () => {
    await broadcastQueueSummary("h-1", "sess-9");
    await broadcastAdminNotice("h-1", { kind: "congestion", message: "m" });
    for (const call of callFunction.mock.calls) {
      const opts = call[2] as Record<string, unknown>;
      expect("idempotencyKey" in opts).toBe(false);
    }
  });

  it("propagates a backend broadcast rejection unchanged", async () => {
    const err = new ApiError({
      code: "VALIDATION_ERROR",
      message: "Queue session not found",
      status: 422,
    });
    callFunction.mockRejectedValue(err);
    await expect(broadcastQueueSummary("h-1", "nope")).rejects.toBe(err);
  });

  it("resolves with the backend broadcast envelope (enqueued count) verbatim", async () => {
    const payload = {
      action: "broadcast_queue_summary",
      broadcast: { kind: "queue_summary", enqueued: 2 },
    };
    callFunction.mockResolvedValue(payload);
    await expect(broadcastQueueSummary("h-1", "sess-9")).resolves.toBe(payload);
  });
});
