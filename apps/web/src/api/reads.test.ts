import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  doctorSpecRows,
  doctorSpecRowsNoProfiles,
  doctorSpecRowsNullProfile,
  profileRows,
} from "./reads.fixtures";

/**
 * The two reads that decide what a receptionist can see of the doctor
 * directory (migration 61 exposes `profiles` to same-hospital staff).
 *
 * Only the Supabase client boundary is mocked: the query builders are real
 * objects from reads.ts, so these tests pin the query shape and the
 * name/specialization fallback, not PostgREST behaviour (the integration
 * suite covers the real RLS behaviour).
 */
const from = vi.fn();
vi.mock("@/lib/supabase", () => ({ supabase: { from } }));

const { listHospitalDoctors, listDoctorNames } = await import("@/api/reads");

function builder(result: { data: unknown; error: unknown }) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "limit", "or"]) {
    b[m] = vi.fn(() => b);
  }
  b.then = (
    onFulfilled: (v: { data: unknown; error: unknown }) => unknown,
  ) => Promise.resolve(result).then(onFulfilled);
  return b;
}

beforeEach(() => {
  from.mockReset();
});

describe("listHospitalDoctors", () => {
  it("labels an option by name + specialization when profiles is readable", async () => {
    from.mockReturnValue(builder({ data: doctorSpecRows, error: null }));

    const options = await listHospitalDoctors("h-1");

    expect(options).toHaveLength(2);
    expect(options[0].label).toBe("Anitha Rao · Cardiology");
    expect(options[0].doctorId).toBe("d-1");
    // One option per doctor even when the doctor holds several specializations,
    // and the fee comes from the specialization row that was kept.
    expect(options[1].doctorId).toBe("d-2");
    expect(options[1].specialization).toBe("Pediatrics");
    expect(options[1].consultationFee).toBe(600);
  });

  it("degrades to the specialization alone when the name is not readable", async () => {
    from.mockReturnValue(
      builder({ data: doctorSpecRowsNoProfiles, error: null }),
    );

    const options = await listHospitalDoctors("h-1");

    expect(options[0].doctorName).toBe(null);
    // The old label rendered "Cardiology · Cardiology" for such rows.
    expect(options[0].label).toBe("Cardiology");
  });

  it("never renders a fabricated name when the directory row has none", async () => {
    from.mockReturnValue(
      builder({ data: doctorSpecRowsNullProfile, error: null }),
    );

    const options = await listHospitalDoctors("h-1");

    expect(options[0].doctorName).toBe(null);
    expect(options[0].label).toBe("General Medicine");
  });
});

describe("listDoctorNames", () => {
  it("queries profiles once per id set and skips nameless rows", async () => {
    const b = builder({ data: profileRows, error: null });
    from.mockReturnValue(b);

    const names = await listDoctorNames(["d-1", "d-1", "d-2", ""]);

    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("profiles");
    expect(b.in).toHaveBeenCalledWith("id", ["d-1", "d-2"]);
    expect(names.get("d-1")).toBe("Anitha Rao");
    expect(names.has("d-2")).toBe(false);
  });

  it("issues no query when there is nothing to label", async () => {
    const names = await listDoctorNames([]);
    expect(names.size).toBe(0);
    expect(from).not.toHaveBeenCalled();
  });
});
