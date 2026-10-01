import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/errors";

/**
 * The G-10 read-only boundary over `alert-center`. Only `callFunction` is
 * mocked (live transport, the role gate, cross-tenant isolation and the
 * service-role-only RPC boundary are proven by the backend real-HTTP suite
 * `alert_center_http.test.ts`). These tests pin exactly what leaves the console
 * for the two READ actions:
 *
 *  - the exact `list` / `analytics` action names and no invented body fields;
 *  - NO mutation wrapper is reachable: the module exports nothing that could
 *    post `acknowledge` / `assign` / `resolve` / `escalate` / `suppress` (§3);
 *  - the backend filter model (§17): `list` carries optional `status` /
 *    `severity` / `category` / `limit`, `analytics` an optional `fromDate` /
 *    `toDate`, and an absent value is OMITTED (never `""`/null) so the RPC's own
 *    default applies rather than a browser-invented one;
 *  - the authenticated tenant travels ONLY in the shared header context, never
 *    in the body;
 *  - both actions are reads, so no idempotency key is ever sent;
 *  - the backend envelope payload is returned verbatim and errors propagate
 *    unchanged.
 */
const callFunction = vi.fn();
vi.mock("@/lib/api", () => ({
  callFunction: (...a: unknown[]) => callFunction(...a),
}));

const alertCenter = await import("@/api/alertCenter");
const { fetchAlertCenter, fetchAlertAnalytics } = alertCenter;

beforeEach(() => {
  callFunction.mockReset().mockResolvedValue({ action: "list" });
});

describe("alert-center read wrapper", () => {
  it("exports ONLY the two read wrappers — no mutation method exists", () => {
    expect(Object.keys(alertCenter).sort()).toEqual([
      "fetchAlertAnalytics",
      "fetchAlertCenter",
    ]);
    // None of the deferred lifecycle mutations is even name-addressable here.
    for (
      const forbidden of [
        "acknowledge",
        "assign",
        "resolve",
        "escalate",
        "suppress",
      ]
    ) {
      expect(alertCenter).not.toHaveProperty(forbidden);
      expect(alertCenter).not.toHaveProperty(`fetch${forbidden}`);
    }
  });

  it("posts the exact list action to the existing function and nothing else", async () => {
    await fetchAlertCenter("h-1");
    expect(callFunction).toHaveBeenCalledTimes(1);
    expect(callFunction.mock.calls[0][0]).toBe("alert-center");
    expect(callFunction.mock.calls[0][1]).toEqual({ action: "list" });
  });

  it("posts the exact analytics action and nothing else", async () => {
    callFunction.mockResolvedValue({ action: "analytics" });
    await fetchAlertAnalytics("h-1");
    expect(callFunction.mock.calls[0][0]).toBe("alert-center");
    expect(callFunction.mock.calls[0][1]).toEqual({ action: "analytics" });
  });

  it("maps the list filters 1:1 and omits every absent one", async () => {
    await fetchAlertCenter("h-1", {
      status: "all",
      severity: "critical",
      category: "queue",
      limit: 25,
    });
    expect(callFunction.mock.calls[0][1]).toEqual({
      action: "list",
      status: "all",
      severity: "critical",
      category: "queue",
      limit: 25,
    });

    // A filter set to undefined must be OMITTED, never sent as ""/null.
    await fetchAlertCenter("h-1", { status: "resolved" });
    const body = callFunction.mock.calls[1][1] as Record<string, unknown>;
    expect(body).toEqual({ action: "list", status: "resolved" });
    expect("severity" in body).toBe(false);
    expect("category" in body).toBe(false);
    expect("limit" in body).toBe(false);
  });

  it("maps the analytics window and omits absent bounds independently", async () => {
    await fetchAlertAnalytics("h-1", {
      fromDate: "2026-09-01",
      toDate: "2026-09-29",
    });
    expect(callFunction.mock.calls[0][1]).toEqual({
      action: "analytics",
      fromDate: "2026-09-01",
      toDate: "2026-09-29",
    });

    await fetchAlertAnalytics("h-1", { toDate: "2026-09-29" });
    const body = callFunction.mock.calls[1][1] as Record<string, unknown>;
    expect(body).toEqual({ action: "analytics", toDate: "2026-09-29" });
    expect("fromDate" in body).toBe(false);

    await fetchAlertAnalytics("h-1", {});
    expect(callFunction.mock.calls[2][1]).toEqual({ action: "analytics" });
  });

  it("sends the tenant only through the shared header context, never the body", async () => {
    await fetchAlertCenter("h-1");
    expect(callFunction.mock.calls[0][2]).toEqual({ hospitalId: "h-1" });
    const body = callFunction.mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("hospitalId");
    expect(body).not.toHaveProperty("p_hospital_id");
    expect(JSON.stringify(body)).not.toMatch(/hospital/i);

    await fetchAlertAnalytics("h-2", { fromDate: "2026-09-01" });
    expect(callFunction.mock.calls[1][2]).toEqual({ hospitalId: "h-2" });
    const analyticsBody = callFunction.mock.calls[1][1] as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(analyticsBody)).not.toMatch(/hospital/i);
  });

  it("sends no idempotency key: both alert actions are reads", async () => {
    await fetchAlertCenter("h-1");
    await fetchAlertAnalytics("h-1");
    for (const call of callFunction.mock.calls) {
      const opts = call[2] as Record<string, unknown>;
      expect("idempotencyKey" in opts).toBe(false);
    }
  });

  it("issues exactly one request per action, with no analytics math in the wrapper", async () => {
    // The body carries only the action name and the server-supported filters —
    // never a computed count, resolution rate or derived percentage (§16).
    await fetchAlertCenter("h-1", { status: "all", severity: "warning" });
    const body = callFunction.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "action",
      "severity",
      "status",
    ]);
    expect(callFunction).toHaveBeenCalledTimes(1);
  });

  it("resolves with the backend payload verbatim, including an empty center", async () => {
    const payload = {
      action: "list",
      center: {
        alerts: [],
        counts: { open: 0, acknowledged: 0, escalated: 0, critical_open: 0 },
      },
    };
    callFunction.mockResolvedValue(payload);
    await expect(fetchAlertCenter("h-1")).resolves.toBe(payload);
  });

  it("propagates backend errors unchanged, including a privilege denial", async () => {
    const err = new ApiError({
      code: "ROLE_INSUFFICIENT",
      message: "Role insufficient",
      status: 403,
    });
    callFunction.mockRejectedValue(err);
    await expect(fetchAlertCenter("h-1")).rejects.toBe(err);
    await expect(fetchAlertAnalytics("h-1")).rejects.toBe(err);
  });
});
