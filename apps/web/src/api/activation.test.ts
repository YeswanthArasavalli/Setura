import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/errors";

/**
 * WS-ONBOARD-5 — the `hospital-activation` browser boundary. Only `callFunction`
 * and the `supabase.from` client are mocked: these tests pin exactly WHAT leaves
 * the console for the three surfaces and nothing more.
 *
 *  - `listHospitalsForActivation` is a plain RLS-scoped READ of `hospitals`
 *    (one bounded query, the projected columns the UI needs, deleted tenants
 *    filtered out, ordered by name) and turns a read failure into an ApiError
 *    with the correct status (42501 → 403, anything else → 500) rather than a
 *    silent empty list;
 *  - `validateHospitalConfiguration` is a READ: exact `mode:"validate"`, the
 *    TARGET id only in the body, the acting id only in the shared transport
 *    header, and NO Idempotency-Key;
 *  - `setHospitalActivation` is the MUTATION: activate/deactivate map to the
 *    exact mode, the target travels in the body, the acting id in the header,
 *    and a stable Idempotency-Key is always forwarded.
 *
 * Live transport, JWT role authorization and the readiness invariant are proven
 * by the backend real-HTTP + DB suites, not here.
 */
const callFunction = vi.fn();
vi.mock("@/lib/api", () => ({
  callFunction: (...a: unknown[]) => callFunction(...a),
}));

const from = vi.fn();
vi.mock("@/lib/supabase", () => ({ supabase: { from } }));

const {
  listHospitalsForActivation,
  setHospitalActivation,
  validateHospitalConfiguration,
} = await import("@/api/activation");

function listBuilder(result: { data: unknown; error: unknown }) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "is"]) b[m] = vi.fn(() => b);
  b.order = vi.fn(() => Promise.resolve(result));
  return b;
}

beforeEach(() => {
  callFunction.mockReset();
  from.mockReset();
});

describe("listHospitalsForActivation (RLS read)", () => {
  it("issues one bounded, deleted-filtered, name-ordered read and returns rows", async () => {
    const b = listBuilder({
      data: [{ id: "h-1", name: "A", slug: "a", is_active: false, activated_at: null, deleted_at: null }],
      error: null,
    });
    from.mockReturnValue(b);

    const rows = await listHospitalsForActivation();

    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("hospitals");
    expect(b.select).toHaveBeenCalledWith(
      "id,name,slug,is_active,activated_at,deleted_at",
    );
    expect(b.is).toHaveBeenCalledWith("deleted_at", null);
    expect(b.order).toHaveBeenCalledWith("name", { ascending: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("h-1");
  });

  it("treats a null data set as an empty list, not an error", async () => {
    from.mockReturnValue(listBuilder({ data: null, error: null }));
    await expect(listHospitalsForActivation()).resolves.toEqual([]);
  });

  it("maps a privilege denial to a 403 ApiError, not a silent empty list", async () => {
    from.mockReturnValue(
      listBuilder({ data: null, error: { code: "42501", message: "denied" } }),
    );
    await expect(listHospitalsForActivation()).rejects.toBeInstanceOf(ApiError);
    await expect(listHospitalsForActivation()).rejects.toMatchObject({
      status: 403,
    });
  });

  it("maps any other read failure to a 500 ApiError", async () => {
    from.mockReturnValue(listBuilder({ data: null, error: { code: "PGRST" } }));
    await expect(listHospitalsForActivation()).rejects.toMatchObject({
      status: 500,
    });
  });
});

describe("validateHospitalConfiguration (read)", () => {
  it("posts the exact validate action with the target in the BODY only", async () => {
    callFunction.mockResolvedValue({ mode: "validate", result: { ready: true } });
    const payload = { mode: "validate", hospitalId: "target-9" };
    await validateHospitalConfiguration("acting-1", "target-9");

    expect(callFunction).toHaveBeenCalledTimes(1);
    const [fn, body, opts] = callFunction.mock.calls[0]!;
    expect(fn).toBe("hospital-activation");
    expect(body).toEqual(payload);
    // The acting id never leaks into the body; the target never rides a header.
    expect(JSON.stringify(body)).not.toMatch(/acting/i);
    expect(opts).toEqual({ hospitalId: "acting-1" });
  });

  it("sends NO Idempotency-Key: validation is a read", async () => {
    callFunction.mockResolvedValue({ mode: "validate", result: { ready: false } });
    await validateHospitalConfiguration("acting-1", "target-9");
    const opts = callFunction.mock.calls[0]![2] as Record<string, unknown>;
    expect("idempotencyKey" in opts).toBe(false);
  });

  it("propagates a backend refusal unchanged", async () => {
    const err = new ApiError({
      code: "FORBIDDEN",
      message: "Activation requires global admin access",
      status: 403,
    });
    callFunction.mockRejectedValue(err);
    await expect(
      validateHospitalConfiguration("acting-1", "target-9"),
    ).rejects.toBe(err);
  });
});

describe("setHospitalActivation (mutation)", () => {
  it("maps activate=true to the activate mode and forwards the key", async () => {
    callFunction.mockResolvedValue({
      hospitalId: "target-9",
      isActive: true,
      reason: "activated",
      activatedAt: "2026-10-03T00:00:00Z",
    });
    await setHospitalActivation("acting-1", "key-abc", "target-9", true);

    const [fn, body, opts] = callFunction.mock.calls[0]!;
    expect(fn).toBe("hospital-activation");
    expect(body).toEqual({ mode: "activate", hospitalId: "target-9" });
    expect(opts).toEqual({ hospitalId: "acting-1", idempotencyKey: "key-abc" });
  });

  it("maps activate=false to the deactivate mode", async () => {
    callFunction.mockResolvedValue({
      hospitalId: "target-9",
      isActive: false,
      reason: "deactivated",
      activatedAt: null,
    });
    await setHospitalActivation("acting-1", "key-def", "target-9", false);

    const [, body, opts] = callFunction.mock.calls[0]!;
    expect(body).toEqual({ mode: "deactivate", hospitalId: "target-9" });
    expect(opts).toEqual({ hospitalId: "acting-1", idempotencyKey: "key-def" });
  });

  it("keeps the acting context out of the body and the target out of the header", async () => {
    callFunction.mockResolvedValue({ hospitalId: "t", isActive: true, reason: "ok", activatedAt: null });
    await setHospitalActivation("acting-1", "key-xyz", "target-9", true);
    const [, body, opts] = callFunction.mock.calls[0]!;
    expect((body as Record<string, unknown>).hospitalId).toBe("target-9");
    expect((opts as Record<string, unknown>).hospitalId).toBe("acting-1");
  });

  it("propagates a readiness refusal (422) unchanged", async () => {
    const err = new ApiError({
      code: "VALIDATION_ERROR",
      message: "Hospital is not ready to activate",
      status: 422,
    });
    callFunction.mockRejectedValue(err);
    await expect(
      setHospitalActivation("acting-1", "key", "target-9", true),
    ).rejects.toBe(err);
  });
});
