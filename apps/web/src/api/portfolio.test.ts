import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/errors";

/**
 * The G-08 global read boundary over `executive-analytics`. Only
 * `callFunction` is mocked: these tests pin WHAT leaves the console for the two
 * tenant-free global actions — the exact `portfolio` / `benchmarks` action
 * names, optional dates mapped 1:1 onto the backend body fields and omitted
 * when absent (so the RPC defaults apply rather than a browser-invented date),
 * the authenticated tenant carried ONLY in the shared header, the absence of
 * any idempotency key (both are reads), and untouched error propagation.
 *
 * They also pin the shape the page depends on: the backend envelope payload is
 * returned verbatim, including a legitimate `portfolio: null`, and the
 * contract-required acting context comes from one bounded RLS read of at most a
 * single hospital row rather than an unbounded directory.
 *
 * Live transport and role authorization are proven by the backend's real-HTTP
 * suite (`enterprise_command_center.test.ts` → "ent http: auth gates enforce
 * roles and portfolio scope"), which asserts hospital_admin → portfolio is 403
 * FORBIDDEN while global_admin → portfolio succeeds.
 */
const callFunction = vi.fn();
vi.mock("@/lib/api", () => ({
  callFunction: (...a: unknown[]) => callFunction(...a),
}));

// Only the client boundary is mocked for the acting-context read: the query
// builder shape itself is what these tests pin (real RLS behaviour against the
// live stack is covered by the local runtime proof, not here).
const from = vi.fn();
vi.mock("@/lib/supabase", () => ({ supabase: { from } }));

const {
  fetchActingHospitalContext,
  fetchCrossHospitalBenchmarks,
  fetchGlobalPortfolio,
} = await import("@/api/portfolio");

function contextBuilder(result: { data: unknown; error: unknown }) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "order", "limit"]) b[m] = vi.fn(() => b);
  b.maybeSingle = vi.fn(() => Promise.resolve(result));
  return b;
}

beforeEach(() => {
  callFunction.mockReset().mockResolvedValue({ action: "portfolio" });
  from.mockReset();
});

describe("executive-analytics portfolio wrapper", () => {
  it("posts the exact portfolio action and nothing else", async () => {
    await fetchGlobalPortfolio("h-1");
    expect(callFunction.mock.calls[0][0]).toBe("executive-analytics");
    expect(callFunction.mock.calls[1]).toBeUndefined();
    expect(callFunction.mock.calls[0][1]).toEqual({ action: "portfolio" });
  });

  it("posts the exact benchmarks action and nothing else", async () => {
    callFunction.mockResolvedValue({ action: "benchmarks" });
    await fetchCrossHospitalBenchmarks("h-1");
    expect(callFunction.mock.calls[0][0]).toBe("executive-analytics");
    expect(callFunction.mock.calls[0][1]).toEqual({ action: "benchmarks" });
  });

  it("maps an optional portfolio date 1:1 and omits it when absent", async () => {
    await fetchGlobalPortfolio("h-1", { date: "2026-09-29" });
    expect(callFunction.mock.calls[0][1]).toEqual({
      action: "portfolio",
      date: "2026-09-29",
    });

    // Absent must stay absent — an explicit null/"" would defeat the RPC default.
    await fetchGlobalPortfolio("h-1", {});
    expect(callFunction.mock.calls[1][1]).toEqual({ action: "portfolio" });
    expect("date" in (callFunction.mock.calls[1][1] as object)).toBe(false);
  });

  it("maps the optional benchmark window and omits absent bounds", async () => {
    await fetchCrossHospitalBenchmarks("h-1", {
      fromDate: "2026-09-01",
      toDate: "2026-09-29",
    });
    expect(callFunction.mock.calls[0][1]).toEqual({
      action: "benchmarks",
      fromDate: "2026-09-01",
      toDate: "2026-09-29",
    });

    await fetchCrossHospitalBenchmarks("h-1", { toDate: "2026-09-29" });
    expect(callFunction.mock.calls[1][1]).toEqual({
      action: "benchmarks",
      toDate: "2026-09-29",
    });
  });

  it("sends the tenant only through the shared header context, never the body", async () => {
    await fetchGlobalPortfolio("h-1");
    expect(callFunction.mock.calls[0][2]).toEqual({ hospitalId: "h-1" });
    const body = callFunction.mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("hospitalId");
    expect(body).not.toHaveProperty("p_hospital_id");
    expect(JSON.stringify(body)).not.toMatch(/hospital/i);

    await fetchCrossHospitalBenchmarks("h-1");
    expect(callFunction.mock.calls[1][2]).toEqual({ hospitalId: "h-1" });
    const benchmarkBody = callFunction.mock.calls[1][1] as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(benchmarkBody)).not.toMatch(/hospital/i);
  });

  it("sends no idempotency key: both global actions are reads", async () => {
    await fetchGlobalPortfolio("h-1");
    await fetchCrossHospitalBenchmarks("h-1");
    for (const call of callFunction.mock.calls) {
      const opts = call[2] as Record<string, unknown>;
      expect("idempotencyKey" in opts).toBe(false);
    }
  });

  it("issues exactly one request per action — no per-hospital fan-out", async () => {
    // Two hospitals in the portfolio must still mean two calls total, not two
    // calls per hospital: the cross-tenant aggregation is the RPC's job.
    callFunction.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === "executive-analytics"
          ? {
              action: "portfolio",
              portfolio: {
                date: "2026-09-29",
                total_hospitals: 2,
                active_hospitals: 2,
                hospitals: [],
              },
            }
          : { action: "benchmarks", benchmarks: { benchmarks: [] } },
      )
    );
    await Promise.all([
      fetchGlobalPortfolio("h-1"),
      fetchCrossHospitalBenchmarks("h-1"),
    ]);
    expect(callFunction).toHaveBeenCalledTimes(2);
  });

  it("propagates backend errors unchanged, including a privilege denial", async () => {
    const err = new ApiError({
      code: "FORBIDDEN",
      message: "Portfolio analytics require global admin access",
      status: 403,
    });
    callFunction.mockRejectedValue(err);
    await expect(fetchGlobalPortfolio("h-1")).rejects.toBe(err);
    await expect(fetchCrossHospitalBenchmarks("h-1")).rejects.toBe(err);
  });

  it("resolves with the backend payload verbatim, including a null portfolio", async () => {
    const payload = { action: "portfolio", portfolio: null };
    callFunction.mockResolvedValue(payload);
    await expect(fetchGlobalPortfolio("h-1")).resolves.toBe(payload);

    const data = {
      action: "portfolio",
      portfolio: {
        date: "2026-09-29",
        total_hospitals: 2,
        active_hospitals: 1,
        hospitals: [],
      },
    };
    callFunction.mockResolvedValue(data);
    await expect(fetchGlobalPortfolio("h-1")).resolves.toBe(data);
  });
});

describe("acting hospital context", () => {
  it("reads one bounded row under RLS and never an unbounded hospital list", async () => {
    const b = contextBuilder({
      data: { id: "ctx-1", name: "E1 Journey 0461900 A" },
      error: null,
    });
    from.mockReturnValue(b);

    await expect(fetchActingHospitalContext()).resolves.toEqual({
      hospitalId: "ctx-1",
      hospitalName: "E1 Journey 0461900 A",
    });

    // Exactly one query, one row, nothing projected beyond the header context.
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("hospitals");
    expect(b.select).toHaveBeenCalledWith("id,name");
    expect(b.limit).toHaveBeenCalledWith(1);
    expect(b.maybeSingle).toHaveBeenCalledTimes(1);
  });

  it("returns null rather than a fabricated context when nothing is readable", async () => {
    from.mockReturnValue(contextBuilder({ data: null, error: null }));
    await expect(fetchActingHospitalContext()).resolves.toBeNull();
  });

  it("turns a read failure into an ApiError, not a silent empty context", async () => {
    from.mockReturnValue(
      contextBuilder({ data: null, error: { code: "42501", message: "denied" } }),
    );

    await expect(fetchActingHospitalContext()).rejects.toBeInstanceOf(ApiError);
    await expect(fetchActingHospitalContext()).rejects.toMatchObject({
      status: 403,
    });

    from.mockReturnValue(
      contextBuilder({ data: null, error: { code: "PGRST116" } }),
    );
    await expect(fetchActingHospitalContext()).rejects.toMatchObject({
      status: 500,
    });
  });

  it("issues no analytics request while resolving the context", async () => {
    from.mockReturnValue(
      contextBuilder({ data: { id: "ctx-1", name: "A" }, error: null }),
    );
    await fetchActingHospitalContext();
    expect(callFunction).not.toHaveBeenCalled();
  });
});
