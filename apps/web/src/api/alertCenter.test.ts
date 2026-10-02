import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/errors";

/**
 * The `alert-center` boundary: the G-10 reads and the G-UI lifecycle mutations.
 * Only `callFunction` is mocked (live transport, the role gate, cross-tenant
 * isolation and the service-role-only RPC boundary are proven by the backend
 * real-HTTP suite `alert_center_http.test.ts`). These tests pin exactly what
 * leaves the console:
 *
 *  - the exact `list` / `analytics` / `acknowledge` / `resolve` / `escalate` /
 *    `suppress` action names and no invented body fields;
 *  - `assign` and any `reopen` are NOT reachable (assignment deferred; D1 has no
 *    reopen), so no wrapper can accidentally post them;
 *  - the backend filter/mutation model: optional `notes` / `reason` are OMITTED
 *    when absent (never `""`/null), and `suppress` carries `alertKey` /
 *    `activeUntil`;
 *  - the authenticated tenant travels ONLY in the shared header context, never
 *    in the body;
 *  - NO action sends an Idempotency-Key: the reads are safe and the mutations
 *    own replay intrinsically (the endpoint does not read the header);
 *  - the backend envelope payload is returned verbatim and errors propagate
 *    unchanged.
 */
const callFunction = vi.fn();
vi.mock("@/lib/api", () => ({
  callFunction: (...a: unknown[]) => callFunction(...a),
}));

const alertCenter = await import("@/api/alertCenter");
const {
  acknowledgeAlert,
  escalateAlert,
  fetchAlertAnalytics,
  fetchAlertCenter,
  resolveAlert,
  suppressAlert,
} = alertCenter;

beforeEach(() => {
  callFunction.mockReset().mockResolvedValue({ action: "list" });
});

describe("alert-center wrapper", () => {
  it("exports the reads and the four lifecycle mutations, but never assign/reopen", () => {
    expect(Object.keys(alertCenter).sort()).toEqual([
      "acknowledgeAlert",
      "escalateAlert",
      "fetchAlertAnalytics",
      "fetchAlertCenter",
      "resolveAlert",
      "suppressAlert",
    ]);
    // Assignment is deferred (no assignable-user directory) and D1 has no
    // reopen — neither is even name-addressable through this wrapper.
    for (
      const forbidden of ["assign", "assignAlert", "reopen", "reopenAlert"]
    ) {
      expect(alertCenter).not.toHaveProperty(forbidden);
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

  it("sends no idempotency key for ANY action (reads or mutations)", async () => {
    await fetchAlertCenter("h-1");
    await fetchAlertAnalytics("h-1");
    await acknowledgeAlert("h-1", "a-1");
    await resolveAlert("h-1", "a-1", "done");
    await escalateAlert("h-1", "a-1");
    await suppressAlert("h-1", { alertKey: "k-abc", activeUntil: "soon" });
    for (const call of callFunction.mock.calls) {
      const opts = call[2] as Record<string, unknown>;
      expect("idempotencyKey" in opts).toBe(false);
    }
  });

  it("posts acknowledge with only the action and the target id", async () => {
    await acknowledgeAlert("h-1", "a-1");
    expect(callFunction.mock.calls[0][0]).toBe("alert-center");
    expect(callFunction.mock.calls[0][1]).toEqual({
      action: "acknowledge",
      alertId: "a-1",
    });
    expect(callFunction.mock.calls[0][2]).toEqual({ hospitalId: "h-1" });
  });

  it("maps resolve/escalate notes and omits a blank one", async () => {
    await resolveAlert("h-1", "a-1", "root cause found");
    expect(callFunction.mock.calls[0][1]).toEqual({
      action: "resolve",
      alertId: "a-1",
      notes: "root cause found",
    });

    await escalateAlert("h-1", "a-2");
    const body = callFunction.mock.calls[1][1] as Record<string, unknown>;
    expect(body).toEqual({ action: "escalate", alertId: "a-2" });
    expect("notes" in body).toBe(false);

    await resolveAlert("h-1", "a-3", undefined);
    expect(callFunction.mock.calls[2][1]).toEqual({
      action: "resolve",
      alertId: "a-3",
    });
  });

  it("maps the suppress window and omits a blank reason", async () => {
    await suppressAlert("h-1", {
      alertKey: "queue_backlog",
      activeUntil: "2026-10-02T12:00:00.000Z",
      reason: "maintenance",
    });
    expect(callFunction.mock.calls[0][1]).toEqual({
      action: "suppress",
      alertKey: "queue_backlog",
      activeUntil: "2026-10-02T12:00:00.000Z",
      reason: "maintenance",
    });

    await suppressAlert("h-1", {
      alertKey: "queue_backlog",
      activeUntil: "2026-10-02T12:00:00.000Z",
    });
    const body = callFunction.mock.calls[1][1] as Record<string, unknown>;
    expect("reason" in body).toBe(false);
  });

  it("keeps the tenant out of every mutation body, header only", async () => {
    await acknowledgeAlert("h-1", "a-1");
    await resolveAlert("h-1", "a-1", "n");
    await suppressAlert("h-1", { alertKey: "k", activeUntil: "u" });
    for (const call of callFunction.mock.calls) {
      expect(call[2]).toEqual({ hospitalId: "h-1" });
      expect(JSON.stringify(call[1])).not.toMatch(/hospital/i);
    }
  });

  it("resolves a lifecycle soft-success payload verbatim", async () => {
    const payload = {
      action: "acknowledge",
      alertId: "a-1",
      result: { ok: true, already_acknowledged: true },
    };
    callFunction.mockResolvedValue(payload);
    await expect(acknowledgeAlert("h-1", "a-1")).resolves.toBe(payload);
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
    await expect(acknowledgeAlert("h-1", "a-1")).rejects.toBe(err);
    await expect(resolveAlert("h-1", "a-1")).rejects.toBe(err);
    await expect(escalateAlert("h-1", "a-1")).rejects.toBe(err);
    await expect(
      suppressAlert("h-1", { alertKey: "k", activeUntil: "u" }),
    ).rejects.toBe(err);
  });
});
