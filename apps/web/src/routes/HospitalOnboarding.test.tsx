import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ApiError } from "@/lib/errors";

/**
 * WS-ONBOARD-1 — Hospital Onboarding frontend.
 *
 * The browser owns NO provisioning authority (that is proven end-to-end by the
 * backend real-HTTP suite). These tests pin the page's OWN guarantees:
 *
 *  - the exported pure helpers — slugify / validateOnboarding / toProvisionInput
 *    — mirror the exact backend limits deterministically;
 *  - the global-admin route guard renders a restricted message for a non-admin
 *    (a UX boundary; the backend re-authorizes regardless);
 *  - a valid form advances Form → Review and NOTHING is submitted until confirm;
 *  - confirming submits the NORMALIZED input once and renders the
 *    SERVER-returned identity on success;
 *  - a rejected submission renders the honest client-safe error, never a
 *    fabricated success.
 *
 * Auth, the acting-context fetch and the provisioning wrapper are mocked at
 * their module boundary; the wrapper's exact request shape is pinned in
 * `onboarding.test.ts` and live transport/authorization by the Edge suite.
 */
const provisionCall = vi.fn();
const actingCall = vi.fn();
vi.mock("@/api/onboarding", () => ({
  provisionHospital: (tenant: string, key: string, input: unknown) =>
    provisionCall(tenant, key, input),
}));
vi.mock("@/api/portfolio", () => ({
  fetchActingHospitalContext: () => actingCall(),
}));

const auth = vi.hoisted(() => ({
  current: { role: "global_admin", hospitalId: "h-ctx-1" as string | null },
}));
vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({
    hospitalId: auth.current.hospitalId,
    staff: {
      fullName: "Global Admin",
      role: auth.current.role,
      hospitalId: auth.current.hospitalId,
    },
  }),
}));

const { slugify, validateOnboarding, toProvisionInput, HospitalOnboarding } =
  await import("@/routes/HospitalOnboarding");

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe("slugify", () => {
  it("lowercases, hyphenates and trims a display name", () => {
    expect(slugify("Sunrise Multi-Speciality Hospital!")).toBe(
      "sunrise-multi-speciality-hospital",
    );
  });
  it("collapses runs of separators and strips leading/trailing hyphens", () => {
    expect(slugify("  St.  Mary's -- Center  ")).toBe("st-mary-s-center");
  });
  it("caps length at 96", () => {
    expect(slugify("a".repeat(140)).length).toBeLessThanOrEqual(96);
  });
});

describe("validateOnboarding", () => {
  const base = {
    name: "",
    slug: "",
    phone: "",
    email: "",
    country: "",
    state: "",
    district: "",
    town: "",
    address: "",
    timezone: "",
  };

  it("requires name and slug", () => {
    const e = validateOnboarding({ ...base });
    expect(e.name).toBeTruthy();
    expect(e.slug).toBeTruthy();
  });

  it("accepts a valid minimal draft", () => {
    const e = validateOnboarding({ ...base, name: "Sunrise", slug: "sunrise" });
    expect(Object.keys(e)).toHaveLength(0);
  });

  it("rejects a slug that is not lowercase-alphanumeric-hyphen", () => {
    const e = validateOnboarding({
      ...base,
      name: "Sunrise",
      slug: "Bad Slug!!",
    });
    expect(e.slug).toBeTruthy();
  });

  it("rejects a malformed email but allows a blank one", () => {
    expect(
      validateOnboarding({ ...base, name: "A B", slug: "a-b", email: "nope" })
        .email,
    ).toBeTruthy();
    expect(
      Object.keys(
        validateOnboarding({ ...base, name: "A B", slug: "a-b", email: "" }),
      ),
    ).toHaveLength(0);
  });

  it("enforces the backend length ceilings", () => {
    const e = validateOnboarding({
      ...base,
      name: "x".repeat(300),
      slug: "a".repeat(200),
      address: "y".repeat(600),
      timezone: "z".repeat(80),
    });
    expect(e.name).toBeTruthy();
    expect(e.slug).toBeTruthy();
    expect(e.address).toBeTruthy();
    expect(e.timezone).toBeTruthy();
  });
});

describe("toProvisionInput", () => {
  it("trims, lowercases the slug and drops blank optionals", () => {
    const input = toProvisionInput({
      name: "  Sunrise Hospital ",
      slug: "  Sunrise-Hospital ",
      phone: "  ",
      email: "",
      country: "India",
      state: "",
      district: "",
      town: "",
      address: "",
      timezone: "",
    });
    expect(input.name).toBe("Sunrise Hospital");
    expect(input.slug).toBe("sunrise-hospital");
    expect(input.phone).toBeUndefined();
    expect(input.email).toBeUndefined();
    expect(input.state).toBeUndefined();
    expect(input.country).toBe("India");
  });
});

// ─── Component behavior ──────────────────────────────────────────────────────

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/onboarding"]}>
      <Routes>
        <Route path="/admin/onboarding" element={<HospitalOnboarding />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  provisionCall.mockReset();
  actingCall.mockReset();
  actingCall.mockResolvedValue(null);
  auth.current.role = "global_admin";
  auth.current.hospitalId = "h-ctx-1";
});

it("hides the form from a non-global-admin (UX guard)", () => {
  auth.current.role = "receptionist";
  renderPage();
  expect(
    screen.getByText(/restricted to global administrators/i),
  ).toBeInTheDocument();
  expect(screen.queryByTestId("to-review")).toBeNull();
});

it("walks Form → Review and submits only on confirm, sending normalized input", async () => {
  provisionCall.mockResolvedValue({
    hospitalId: "new-h-1",
    name: "Sunrise Hospital",
    slug: "sunrise-hospital",
    created: true,
  });
  renderPage();

  await userEvent.type(
    screen.getByTestId("ho-name"),
    "Sunrise Hospital",
  );
  // Slug auto-derives from the name.
  await userEvent.click(screen.getByTestId("to-review"));

  // Nothing is submitted just for reaching review.
  expect(provisionCall).not.toHaveBeenCalled();

  await userEvent.click(screen.getByTestId("confirm-provision"));

  await waitFor(() => expect(provisionCall).toHaveBeenCalledTimes(1));
  const [tenant, key, input] = provisionCall.mock.calls[0];
  expect(tenant).toBe("h-ctx-1");
  expect(typeof key).toBe("string");
  expect(input).toEqual(
    expect.objectContaining({
      name: "Sunrise Hospital",
      slug: "sunrise-hospital",
    }),
  );

  // Success renders the SERVER-returned identity, never a fabrication.
  expect(await screen.findByTestId("provisioned-badge")).toBeInTheDocument();
  expect(screen.getByText("new-h-1")).toBeInTheDocument();
});

it("renders an honest conflict error and never a fake success", async () => {
  provisionCall.mockRejectedValue(
    new ApiError({
      code: "DB_CONSTRAINT_VIOLATION",
      message: "A hospital with this slug already exists",
      status: 409,
    }),
  );
  renderPage();

  await userEvent.type(screen.getByTestId("ho-name"), "Dup Hospital");
  await userEvent.click(screen.getByTestId("to-review"));
  await userEvent.click(screen.getByTestId("confirm-provision"));

  const banner = await screen.findByTestId("onboarding-error");
  expect(banner).toBeInTheDocument();
  expect(banner.textContent).toMatch(/already exists/i);
  expect(screen.queryByTestId("provisioned-badge")).toBeNull();
});
