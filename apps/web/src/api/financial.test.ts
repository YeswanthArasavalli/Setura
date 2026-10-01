import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/errors";

/**
 * The G-09 read-only boundary over `financial-command-center`. Only
 * `callFunction` is mocked (live transport, role authorization and the
 * service-role-only RPC boundary are proven by the backend real-HTTP suite
 * `financial_command_center_http.test.ts`). These tests pin exactly what
 * leaves the console for the three read actions:
 *
 *  - the exact `overview` / `forecast` / `reconciliation` action names and no
 *    invented body fields;
 *  - the backend date model (§13): `overview`/`forecast` carry ONE optional
 *    `date`, `reconciliation` an optional `fromDate`/`toDate`, and an absent
 *    date is OMITTED (never `""`/null) so the RPC's own default applies rather
 *    than a browser-invented business day;
 *  - the authenticated tenant travels ONLY in the shared header context, never
 *    in the body;
 *  - all three are reads, so no idempotency key is ever sent;
 *  - the backend envelope payload is returned verbatim (including a legitimate
 *    `financial: null`) and errors propagate unchanged.
 */
const callFunction = vi.fn();
vi.mock("@/lib/api", () => ({
  callFunction: (...a: unknown[]) => callFunction(...a),
}));

const {
  fetchFinancialOverview,
  fetchReconciliationSummary,
  fetchRevenueForecast,
} = await import("@/api/financial");

beforeEach(() => {
  callFunction.mockReset().mockResolvedValue({ action: "overview" });
});

describe("financial-command-center read wrapper", () => {
  it("posts the exact overview action to the existing function and nothing else", async () => {
    await fetchFinancialOverview("h-1");
    expect(callFunction).toHaveBeenCalledTimes(1);
    expect(callFunction.mock.calls[0][0]).toBe("financial-command-center");
    expect(callFunction.mock.calls[0][1]).toEqual({ action: "overview" });
  });

  it("posts the exact forecast action and nothing else", async () => {
    callFunction.mockResolvedValue({ action: "forecast" });
    await fetchRevenueForecast("h-1");
    expect(callFunction.mock.calls[0][0]).toBe("financial-command-center");
    expect(callFunction.mock.calls[0][1]).toEqual({ action: "forecast" });
  });

  it("posts the exact reconciliation action and nothing else", async () => {
    callFunction.mockResolvedValue({ action: "reconciliation" });
    await fetchReconciliationSummary("h-1");
    expect(callFunction.mock.calls[0][0]).toBe("financial-command-center");
    expect(callFunction.mock.calls[0][1]).toEqual({
      action: "reconciliation",
    });
  });

  it("maps the optional overview date 1:1 and omits it when absent", async () => {
    await fetchFinancialOverview("h-1", { date: "2026-09-29" });
    expect(callFunction.mock.calls[0][1]).toEqual({
      action: "overview",
      date: "2026-09-29",
    });

    await fetchFinancialOverview("h-1", {});
    expect(callFunction.mock.calls[1][1]).toEqual({ action: "overview" });
    expect("date" in (callFunction.mock.calls[1][1] as object)).toBe(false);
  });

  it("maps the optional forecast date 1:1 and omits it when absent", async () => {
    await fetchRevenueForecast("h-1", { date: "2026-09-29" });
    expect(callFunction.mock.calls[0][1]).toEqual({
      action: "forecast",
      date: "2026-09-29",
    });

    await fetchRevenueForecast("h-1");
    expect("date" in (callFunction.mock.calls[1][1] as object)).toBe(false);
  });

  it("maps the reconciliation window and omits absent bounds independently", async () => {
    await fetchReconciliationSummary("h-1", {
      fromDate: "2026-09-01",
      toDate: "2026-09-29",
    });
    expect(callFunction.mock.calls[0][1]).toEqual({
      action: "reconciliation",
      fromDate: "2026-09-01",
      toDate: "2026-09-29",
    });

    await fetchReconciliationSummary("h-1", { toDate: "2026-09-29" });
    expect(callFunction.mock.calls[1][1]).toEqual({
      action: "reconciliation",
      toDate: "2026-09-29",
    });
    expect("fromDate" in (callFunction.mock.calls[1][1] as object)).toBe(false);

    await fetchReconciliationSummary("h-1", {});
    expect(callFunction.mock.calls[2][1]).toEqual({ action: "reconciliation" });
  });

  it("sends the tenant only through the shared header context, never the body", async () => {
    await fetchFinancialOverview("h-1");
    expect(callFunction.mock.calls[0][2]).toEqual({ hospitalId: "h-1" });
    const body = callFunction.mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("hospitalId");
    expect(body).not.toHaveProperty("p_hospital_id");
    expect(JSON.stringify(body)).not.toMatch(/hospital/i);

    await fetchReconciliationSummary("h-2", { fromDate: "2026-09-01" });
    expect(callFunction.mock.calls[1][2]).toEqual({ hospitalId: "h-2" });
    const reconBody = callFunction.mock.calls[1][1] as Record<string, unknown>;
    expect(JSON.stringify(reconBody)).not.toMatch(/hospital/i);
  });

  it("sends no idempotency key: all three financial actions are reads", async () => {
    await fetchFinancialOverview("h-1");
    await fetchRevenueForecast("h-1");
    await fetchReconciliationSummary("h-1");
    for (const call of callFunction.mock.calls) {
      const opts = call[2] as Record<string, unknown>;
      expect("idempotencyKey" in opts).toBe(false);
    }
  });

  it("issues exactly one request per action, with no financial math in the wrapper", async () => {
    // The body carries only the action name and the optional date the backend
    // already understands — never a computed total, fee or derived figure.
    await fetchFinancialOverview("h-1", { date: "2026-09-29" });
    const body = callFunction.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["action", "date"]);
    expect(callFunction).toHaveBeenCalledTimes(1);
  });

  it("resolves with the backend payload verbatim, including a null overview", async () => {
    const payload = { action: "overview", financial: null };
    callFunction.mockResolvedValue(payload);
    await expect(fetchFinancialOverview("h-1")).resolves.toBe(payload);
  });

  it("propagates backend errors unchanged, including a privilege denial", async () => {
    const err = new ApiError({
      code: "ROLE_INSUFFICIENT",
      message: "Role insufficient",
      status: 403,
    });
    callFunction.mockRejectedValue(err);
    await expect(fetchFinancialOverview("h-1")).rejects.toBe(err);
    await expect(fetchRevenueForecast("h-1")).rejects.toBe(err);
    await expect(fetchReconciliationSummary("h-1")).rejects.toBe(err);
  });
});
