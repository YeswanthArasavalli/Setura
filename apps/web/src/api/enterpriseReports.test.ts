import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/errors";

/**
 * The G-05 read boundary. Only `callFunction` is mocked: the tests pin WHAT
 * leaves the console — the exact `enterprise-reports` audit/compliance
 * action, the authenticated tenant context via the shared header mechanism,
 * the deliberate ABSENCE of the `generate` action (money-sensitive report
 * types are out of scope, investigation §12) or any idempotency key, and
 * untouched error propagation — not the transport itself (covered by lib/api
 * and the real-HTTP backend suite `enterprise_command_center.test.ts`).
 */
const callFunction = vi.fn();
vi.mock("@/lib/api", () => ({
  callFunction: (...a: unknown[]) => callFunction(...a),
}));

const {
  fetchAuditIntegrity,
  fetchAuditSearch,
  fetchDoctorOpsIntegrity,
  fetchIntegrationMatrix,
  fetchQueueIntegrity,
  fetchSettlementIntegrity,
} = await import("@/api/enterpriseReports");

beforeEach(() => {
  callFunction.mockReset().mockResolvedValue({ ok: true });
});

describe("enterprise-reports audit/compliance read wrappers", () => {
  it("posts each exact read action through the shared function caller", async () => {
    await fetchAuditSearch("h-1");
    await fetchAuditIntegrity("h-1");
    await fetchSettlementIntegrity("h-1");
    await fetchQueueIntegrity("h-1", "s-1");
    await fetchDoctorOpsIntegrity("h-1", "d-1");
    await fetchIntegrationMatrix("h-1");

    expect(callFunction.mock.calls.map((c) => c[1])).toEqual([
      { action: "audit_search" },
      { action: "audit_integrity" },
      { action: "settlement_integrity" },
      { action: "queue_integrity", queueSessionId: "s-1" },
      { action: "doctor_ops_integrity", doctorId: "d-1" },
      { action: "integration_matrix" },
    ]);
    for (const call of callFunction.mock.calls) {
      expect(call[0]).toBe("enterprise-reports");
    }
  });

  it("maps optional filters 1:1 onto backend body fields, omitting absent ones", async () => {
    await fetchAuditSearch("h-1", {
      entityType: "booking",
      actionType: "created",
      correlationId: "c-1",
      fromTs: "2026-09-22T00:00:00.000Z",
      toTs: "2026-09-29T00:00:00.000Z",
      limit: 500,
    });
    expect(callFunction.mock.calls[0][1]).toEqual({
      action: "audit_search",
      entityType: "booking",
      actionType: "created",
      correlationId: "c-1",
      fromTs: "2026-09-22T00:00:00.000Z",
      toTs: "2026-09-29T00:00:00.000Z",
      limit: 500,
    });

    // An undefined optional must not appear as an explicit null/undefined
    // key — the backend schema distinguishes "absent" from "present".
    await fetchDoctorOpsIntegrity("h-1", "d-1");
    expect(callFunction.mock.calls[1][1]).toEqual({
      action: "doctor_ops_integrity",
      doctorId: "d-1",
    });

    await fetchIntegrationMatrix("h-1", "2026-09-29");
    expect(callFunction.mock.calls[2][1]).toEqual({
      action: "integration_matrix",
      date: "2026-09-29",
    });
  });

  it("sends the tenant only through the shared callFunction context, never the body", async () => {
    await fetchAuditSearch("h-1", { entityType: "booking" });

    // The established pattern: exactly { hospitalId } in the options, so the
    // tenant travels in the X-Hospital-ID header that callFunction sets.
    expect(callFunction.mock.calls[0][2]).toEqual({ hospitalId: "h-1" });
    const [, body] = callFunction.mock.calls[0] as [string, Record<string, unknown>];
    expect(JSON.stringify(body)).not.toMatch(/hospital/i);
  });

  it("sends no idempotency key: these are reads, and replays must not be framed as mutations", async () => {
    await fetchAuditIntegrity("h-1");

    const opts = callFunction.mock.calls[0][2] as Record<string, unknown>;
    expect("idempotencyKey" in opts).toBe(false);
  });

  it("never references the generate action anywhere in the wrapper layer", async () => {
    // Exhaustive surface check: the module exposes ONLY the six audit /
    // compliance read wrappers, and no request they can produce generates a
    // report — the financial/settlement report types stay unreachable from
    // this console.
    const module = await import("@/api/enterpriseReports");
    expect(Object.keys(module).sort()).toEqual([
      "fetchAuditIntegrity",
      "fetchAuditSearch",
      "fetchDoctorOpsIntegrity",
      "fetchIntegrationMatrix",
      "fetchQueueIntegrity",
      "fetchSettlementIntegrity",
    ]);

    await fetchAuditSearch("h-1", { limit: 1000 });
    await fetchAuditIntegrity("h-1");
    await fetchSettlementIntegrity("h-1");
    await fetchQueueIntegrity("h-1", "s-1");
    await fetchDoctorOpsIntegrity("h-1", "d-1", "2026-09-29");
    await fetchIntegrationMatrix("h-1", "2026-09-29");
    for (const call of callFunction.mock.calls) {
      const body = call[1] as { action: string };
      expect(body.action).not.toBe("generate");
      expect(JSON.stringify(body)).not.toMatch(/reportType/);
    }
  });

  it("propagates backend errors unchanged — no silent swallowing into empty data", async () => {
    const err = new ApiError({
      code: "FORBIDDEN",
      message: "You do not have permission to perform this action.",
      status: 403,
    });
    callFunction.mockRejectedValue(err);

    await expect(fetchAuditSearch("h-1")).rejects.toBe(err);
    await expect(fetchAuditIntegrity("h-1")).rejects.toBe(err);
  });

  it("resolves with the backend envelope payload verbatim", async () => {
    const payload = {
      action: "audit_search",
      results: { hospital_id: "h-1", entries: [] },
    };
    callFunction.mockResolvedValue(payload);

    await expect(fetchAuditSearch("h-1")).resolves.toBe(payload);
  });
});
