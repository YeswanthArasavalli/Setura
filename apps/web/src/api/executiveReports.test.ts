import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/errors";

/**
 * The G-06 report-generation read boundary. Only `callFunction` is mocked: the
 * tests pin WHAT leaves the console for each approved executive report — the
 * exact `generate` action + reportType, the optional date window mapped 1:1 to
 * the backend body fields, the authenticated tenant carried ONLY in the shared
 * header (never the body), the absence of any idempotency key (this is a read),
 * the structural rejection of the out-of-scope `financial` / `settlement` report
 * types, and untouched error propagation. Live transport is proven by the
 * backend's real-HTTP suite (`enterprise_command_center.test.ts`).
 */
const callFunction = vi.fn();
vi.mock("@/lib/api", () => ({
  callFunction: (...a: unknown[]) => callFunction(...a),
}));

const { generateExecutiveReport, GENERATE_REPORT_TYPES } = await import(
  "@/api/executiveReports"
);
import type { ExecutiveReportType } from "@/types/api";

beforeEach(() => {
  callFunction.mockReset().mockResolvedValue({ action: "generate" });
});

describe("executive-reports generate wrapper", () => {
  it("exposes exactly the six approved report types", () => {
    expect([...GENERATE_REPORT_TYPES].sort()).toEqual(
      [
        "audit",
        "daily_hospital",
        "doctor_performance",
        "monthly_executive",
        "sla",
        "weekly_operations",
      ].sort(),
    );
  });

  it("posts the exact generate action + reportType for each approved report", async () => {
    for (const rt of GENERATE_REPORT_TYPES) {
      await generateExecutiveReport("h-1", rt);
    }
    expect(callFunction.mock.calls.map((c) => c[1])).toEqual([
      { action: "generate", reportType: "daily_hospital" },
      { action: "generate", reportType: "weekly_operations" },
      { action: "generate", reportType: "monthly_executive" },
      { action: "generate", reportType: "doctor_performance" },
      { action: "generate", reportType: "sla" },
      { action: "generate", reportType: "audit" },
    ]);
    for (const call of callFunction.mock.calls) {
      expect(call[0]).toBe("enterprise-reports");
    }
  });

  it("maps the optional date window 1:1 and omits absent dates", async () => {
    await generateExecutiveReport("h-1", "doctor_performance", {
      fromDate: "2026-09-01",
      toDate: "2026-09-29",
    });
    expect(callFunction.mock.calls[0][1]).toEqual({
      action: "generate",
      reportType: "doctor_performance",
      fromDate: "2026-09-01",
      toDate: "2026-09-29",
    });

    // An absent date must not appear as an explicit key — the backend schema
    // distinguishes "absent" (apply default) from "present".
    await generateExecutiveReport("h-1", "sla", { toDate: "2026-09-29" });
    expect(callFunction.mock.calls[1][1]).toEqual({
      action: "generate",
      reportType: "sla",
      toDate: "2026-09-29",
    });
  });

  it("sends the tenant only through the shared header context, never the body", async () => {
    await generateExecutiveReport("h-1", "daily_hospital");
    expect(callFunction.mock.calls[0][2]).toEqual({ hospitalId: "h-1" });
    const [, body] = callFunction.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    // The tenant must not appear as a body field. (`reportType` legitimately
    // contains the substring "hospital" in `daily_hospital`, so the check
    // targets the hospitalId FIELD, not any "hospital" text.)
    expect(body).not.toHaveProperty("hospitalId");
    expect(JSON.stringify(body)).not.toMatch(/hospitalId/i);
  });

  it("sends no idempotency key: report generation is a read, not a mutation", async () => {
    await generateExecutiveReport("h-1", "audit");
    const opts = callFunction.mock.calls[0][2] as Record<string, unknown>;
    expect("idempotencyKey" in opts).toBe(false);
  });

  it("refuses the out-of-scope financial and settlement report types at runtime", async () => {
    // A cast defeats the type boundary; the runtime allow-list must still
    // reject them so they are unreachable from this console (§8/§22).
    for (const forbidden of ["financial", "settlement"] as unknown as ExecutiveReportType[]) {
      await expect(
        generateExecutiveReport("h-1", forbidden),
      ).rejects.toBeInstanceOf(ApiError);
    }
    // No backend call was made for the rejected types.
    expect(callFunction).not.toHaveBeenCalled();
  });

  it("propagates backend errors unchanged — no silent swallowing", async () => {
    const err = new ApiError({
      code: "FORBIDDEN",
      message: "Access denied",
      status: 403,
    });
    callFunction.mockRejectedValue(err);
    await expect(generateExecutiveReport("h-1", "sla")).rejects.toBe(err);
  });

  it("resolves with the backend envelope payload verbatim", async () => {
    const payload = {
      action: "generate",
      format: "json",
      report: { ok: true, report_type: "sla", data: {} },
    };
    callFunction.mockResolvedValue(payload);
    await expect(generateExecutiveReport("h-1", "sla")).resolves.toBe(payload);
  });
});
