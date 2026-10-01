import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/errors";

/**
 * The G-11 read-only boundary over the two tenant-scoped `executive-analytics`
 * actions. Only `callFunction` is mocked (live transport, role authorization,
 * tenant isolation and the service-role-only RPC boundary are proven by the
 * backend real-HTTP suite `executive_analytics_operations_http.test.ts`).
 * These tests pin exactly what leaves the console for the two read actions:
 *
 *  - the exact `daily_operations` / `doctor_rankings` action names and no
 *    invented body fields;
 *  - the backend date model (§14): `daily_operations` carries ONE optional
 *    `date`, `doctor_rankings` an optional `fromDate`/`toDate`, and an absent
 *    date is OMITTED (never `""`/null) so the RPC's own default applies rather
 *    than a browser-invented business day;
 *  - the authenticated tenant travels ONLY in the shared header context, never
 *    in the body;
 *  - both are reads, so no idempotency key is ever sent;
 *  - the backend envelope payload is returned verbatim (including a legitimate
 *    null dashboard/rankings) and errors propagate unchanged;
 *  - the wrapper exposes ONLY the two intended operations — the G-06/G-08
 *    actions (portfolio / benchmarks / weekly_operations / monthly_executive /
 *    doctor_performance) are structurally unreachable through it (§3/§4).
 */
const callFunction = vi.fn();
vi.mock("@/lib/api", () => ({
  callFunction: (...a: unknown[]) => callFunction(...a),
}));

const operationsModule = await import("@/api/operations");
const { fetchDailyOperations, fetchDoctorRankings } = operationsModule;

beforeEach(() => {
  callFunction.mockReset().mockResolvedValue({ action: "daily_operations" });
});

describe("executive-analytics operations read wrapper", () => {
  it("posts the exact daily_operations action to the existing function and nothing else", async () => {
    await fetchDailyOperations("h-1");
    expect(callFunction).toHaveBeenCalledTimes(1);
    expect(callFunction.mock.calls[0][0]).toBe("executive-analytics");
    expect(callFunction.mock.calls[0][1]).toEqual({
      action: "daily_operations",
    });
  });

  it("posts the exact doctor_rankings action and nothing else", async () => {
    callFunction.mockResolvedValue({ action: "doctor_rankings" });
    await fetchDoctorRankings("h-1");
    expect(callFunction.mock.calls[0][0]).toBe("executive-analytics");
    expect(callFunction.mock.calls[0][1]).toEqual({
      action: "doctor_rankings",
    });
  });

  it("maps the optional daily date 1:1 and omits it when absent", async () => {
    await fetchDailyOperations("h-1", { date: "2026-09-29" });
    expect(callFunction.mock.calls[0][1]).toEqual({
      action: "daily_operations",
      date: "2026-09-29",
    });

    await fetchDailyOperations("h-1", {});
    expect(callFunction.mock.calls[1][1]).toEqual({
      action: "daily_operations",
    });
    expect("date" in (callFunction.mock.calls[1][1] as object)).toBe(false);
  });

  it("maps the rankings window and omits absent bounds independently", async () => {
    await fetchDoctorRankings("h-1", {
      fromDate: "2026-09-01",
      toDate: "2026-09-29",
    });
    expect(callFunction.mock.calls[0][1]).toEqual({
      action: "doctor_rankings",
      fromDate: "2026-09-01",
      toDate: "2026-09-29",
    });

    await fetchDoctorRankings("h-1", { toDate: "2026-09-29" });
    expect(callFunction.mock.calls[1][1]).toEqual({
      action: "doctor_rankings",
      toDate: "2026-09-29",
    });
    expect("fromDate" in (callFunction.mock.calls[1][1] as object)).toBe(false);

    await fetchDoctorRankings("h-1", {});
    expect(callFunction.mock.calls[2][1]).toEqual({ action: "doctor_rankings" });
  });

  it("sends the tenant only through the shared header context, never the body", async () => {
    await fetchDailyOperations("h-1");
    expect(callFunction.mock.calls[0][2]).toEqual({ hospitalId: "h-1" });
    const body = callFunction.mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("hospitalId");
    expect(body).not.toHaveProperty("hospital_id");
    expect(body).not.toHaveProperty("p_hospital_id");
    expect(JSON.stringify(body)).not.toMatch(/hospital/i);

    await fetchDoctorRankings("h-2", { fromDate: "2026-09-01" });
    expect(callFunction.mock.calls[1][2]).toEqual({ hospitalId: "h-2" });
    const rankBody = callFunction.mock.calls[1][1] as Record<string, unknown>;
    expect(JSON.stringify(rankBody)).not.toMatch(/hospital/i);
  });

  it("sends no idempotency key: both operations actions are reads", async () => {
    await fetchDailyOperations("h-1");
    await fetchDoctorRankings("h-1");
    for (const call of callFunction.mock.calls) {
      const opts = call[2] as Record<string, unknown>;
      expect("idempotencyKey" in opts).toBe(false);
    }
  });

  it("issues exactly one request per action, with no analytics math in the wrapper", async () => {
    // The body carries only the action name and the optional date(s) the
    // backend already understands — never a computed rate, rank or total.
    await fetchDoctorRankings("h-1", {
      fromDate: "2026-09-01",
      toDate: "2026-09-29",
    });
    const body = callFunction.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "action",
      "fromDate",
      "toDate",
    ]);
    expect(callFunction).toHaveBeenCalledTimes(1);
  });

  it("resolves with the backend payload verbatim, including a null dashboard", async () => {
    const payload = { action: "daily_operations", dashboard: null };
    callFunction.mockResolvedValue(payload);
    await expect(fetchDailyOperations("h-1")).resolves.toBe(payload);

    const rankPayload = { action: "doctor_rankings", rankings: null };
    callFunction.mockResolvedValue(rankPayload);
    await expect(fetchDoctorRankings("h-1")).resolves.toBe(rankPayload);
  });

  it("propagates backend errors unchanged, including a privilege denial", async () => {
    const err = new ApiError({
      code: "ROLE_INSUFFICIENT",
      message: "Role insufficient",
      status: 403,
    });
    callFunction.mockRejectedValue(err);
    await expect(fetchDailyOperations("h-1")).rejects.toBe(err);
    await expect(fetchDoctorRankings("h-1")).rejects.toBe(err);
  });

  it("exposes ONLY the two intended read operations — no mutation, no other action", () => {
    // Value-level exports: exactly the two fetch wrappers, nothing else. An
    // untyped call site cannot reach any other executive-analytics action
    // THROUGH this module (§3/§21).
    expect(Object.keys(operationsModule).sort()).toEqual([
      "fetchDailyOperations",
      "fetchDoctorRankings",
    ]);

    // The module source itself never names a G-06/G-08 action or a mutation
    // verb, so none can be added by accident through this boundary.
    const sourceOperations = Object.values(operationsModule)
      .map((fn) => (typeof fn === "function" ? fn.toString() : ""))
      .join("\n");
    for (const forbidden of [
      "portfolio",
      "benchmarks",
      "weekly_operations",
      "monthly_executive",
      "doctor_performance",
      "acknowledge",
      "resolve",
      "refund",
    ]) {
      expect(sourceOperations).not.toContain(forbidden);
    }
  });
});
