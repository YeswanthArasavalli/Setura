import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ApiError } from "@/lib/errors";

/**
 * WS-ONBOARD-5 — Hospital Activation page.
 *
 * The browser owns NO activation authority (that is proven by the backend
 * DB + real-HTTP suites). These tests pin the page's OWN guarantees:
 *
 *  - the global-admin route guard renders a restricted message for a non-admin
 *    and never renders the tenant list (a UX boundary only);
 *  - a global_admin sees the live tenants read from the RLS-scoped list;
 *  - selecting a tenant + "Validate configuration" calls the read wrapper with
 *    (acting-context, target) and renders the SERVER-computed readiness badge
 *    and checklist verbatim;
 *  - Activate stays disabled while the server says the tenant is NOT ready and
 *    enables once it is READY — the readiness gate is the server's, echoed here;
 *  - a successful activation posts the mutation once, renders the server state
 *    honestly and reloads the list;
 *  - a rejected activation renders the client-safe error, never a fabricated
 *    success.
 *
 * Auth, the acting-context fetch and the activation wrappers are mocked at
 * their module boundary; the wrapper request shapes are pinned in
 * `activation.test.ts` and live transport/authorization by the Edge suite.
 */
const listCall = vi.fn();
const validateCall = vi.fn();
const activateCall = vi.fn();
const actingCall = vi.fn();

vi.mock("@/api/activation", () => ({
  listHospitalsForActivation: () => listCall(),
  validateHospitalConfiguration: (acting: string, target: string) =>
    validateCall(acting, target),
  setHospitalActivation: (
    acting: string,
    key: string,
    target: string,
    a: boolean,
  ) => activateCall(acting, key, target, a),
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

const { HospitalActivation } = await import("@/routes/HospitalActivation");

const READY_RESULT = {
  ok: true,
  hospital_id: "h-ready",
  ready: true,
  checks: [
    {
      key: "has_active_department",
      label: "Department",
      passed: true,
      blocking: true,
      detail: "1 active",
    },
    {
      key: "has_active_doctor",
      label: "Doctor",
      passed: true,
      blocking: true,
      detail: "1 active",
    },
    {
      key: "has_active_schedule",
      label: "Schedule",
      passed: true,
      blocking: true,
      detail: "1 active",
    },
    {
      key: "settings_present",
      label: "Settings",
      passed: true,
      blocking: false,
      detail: "present",
    },
  ],
};

const NOT_READY_RESULT = {
  ok: true,
  hospital_id: "h-empty",
  ready: false,
  checks: [
    {
      key: "has_active_department",
      label: "Department",
      passed: false,
      blocking: true,
      detail: "none",
    },
    {
      key: "has_active_doctor",
      label: "Doctor",
      passed: false,
      blocking: true,
      detail: "none",
    },
    {
      key: "has_active_schedule",
      label: "Schedule",
      passed: false,
      blocking: true,
      detail: "none",
    },
  ],
};

const HOSPITALS = [
  {
    id: "h-ready",
    name: "Ready Hospital",
    slug: "ready",
    is_active: false,
    activated_at: null,
    deleted_at: null,
  },
  {
    id: "h-empty",
    name: "Empty Hospital",
    slug: "empty",
    is_active: false,
    activated_at: null,
    deleted_at: null,
  },
];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/activation"]}>
      <Routes>
        <Route path="/admin/activation" element={<HospitalActivation />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  listCall.mockReset().mockResolvedValue(HOSPITALS);
  validateCall.mockReset();
  activateCall.mockReset();
  actingCall.mockReset().mockResolvedValue(null);
  auth.current.role = "global_admin";
  auth.current.hospitalId = "h-ctx-1";
});

describe("route guard", () => {
  it("hides everything from a non-global-admin (UX guard)", () => {
    auth.current.role = "receptionist";
    renderPage();
    expect(
      screen.getByText(/restricted to global administrators/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("hospital-list")).toBeNull();
    expect(listCall).not.toHaveBeenCalled();
  });
});

describe("tenant list", () => {
  it("renders the RLS-read tenants for a global_admin", async () => {
    renderPage();
    expect(await screen.findByText("Ready Hospital")).toBeInTheDocument();
    expect(screen.getByText("Empty Hospital")).toBeInTheDocument();
    expect(listCall).toHaveBeenCalledTimes(1);
  });

  it("shows the empty state when no tenants are readable", async () => {
    listCall.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText(/no hospitals found/i)).toBeInTheDocument();
  });
});

describe("validation + activation flow", () => {
  it("validates the selected tenant and renders the server readiness", async () => {
    validateCall.mockResolvedValue({ mode: "validate", result: READY_RESULT });
    renderPage();

    await screen.findByText("Ready Hospital");
    await userEvent.click(screen.getByTestId("select-h-ready"));
    await userEvent.click(screen.getByTestId("validate-btn"));

    await waitFor(() =>
      expect(validateCall).toHaveBeenCalledWith("h-ctx-1", "h-ready")
    );
    expect(await screen.findByTestId("ready-badge")).toBeInTheDocument();
    expect(screen.getByTestId("validation-panel")).toBeInTheDocument();
  });

  it("keeps Activate disabled while the server reports NOT ready", async () => {
    validateCall.mockResolvedValue({
      mode: "validate",
      result: NOT_READY_RESULT,
    });
    renderPage();

    await screen.findByText("Empty Hospital");
    await userEvent.click(screen.getByTestId("select-h-empty"));
    await userEvent.click(screen.getByTestId("validate-btn"));

    expect(await screen.findByTestId("not-ready-badge")).toBeInTheDocument();
    expect(screen.getByTestId("activate-btn")).toBeDisabled();
  });

  it("activates a ready tenant, shows the server state and reloads the list", async () => {
    validateCall.mockResolvedValue({ mode: "validate", result: READY_RESULT });
    activateCall.mockResolvedValue({
      hospitalId: "h-ready",
      isActive: true,
      reason: "activated",
      activatedAt: "2026-10-03T00:00:00Z",
    });
    renderPage();

    await screen.findByText("Ready Hospital");
    await userEvent.click(screen.getByTestId("select-h-ready"));
    await userEvent.click(screen.getByTestId("validate-btn"));
    await screen.findByTestId("ready-badge");

    const activateBtn = screen.getByTestId("activate-btn");
    expect(activateBtn).toBeEnabled();
    await userEvent.click(activateBtn);

    await waitFor(() => expect(activateCall).toHaveBeenCalledTimes(1));
    const [acting, key, target, doActivate] = activateCall.mock.calls[0]!;
    expect(acting).toBe("h-ctx-1");
    expect(typeof key).toBe("string");
    expect(target).toBe("h-ready");
    expect(doActivate).toBe(true);

    expect(
      await screen.findByTestId("activation-feedback"),
    ).toHaveTextContent(/hospital activated/i);
    // Success refreshes the list so the UI reflects the server-written state.
    await waitFor(() => expect(listCall).toHaveBeenCalledTimes(2));
  });

  it("renders an honest refusal and never a fake success", async () => {
    validateCall.mockResolvedValue({ mode: "validate", result: READY_RESULT });
    activateCall.mockRejectedValue(
      new ApiError({
        code: "VALIDATION_ERROR",
        message: "Hospital is not ready to activate",
        status: 422,
      }),
    );
    renderPage();

    await screen.findByText("Ready Hospital");
    await userEvent.click(screen.getByTestId("select-h-ready"));
    await userEvent.click(screen.getByTestId("validate-btn"));
    await screen.findByTestId("ready-badge");
    await userEvent.click(screen.getByTestId("activate-btn"));

    const feedback = await screen.findByTestId("activation-feedback");
    expect(feedback).toHaveTextContent(/not ready to activate/i);
    expect(activateCall).toHaveBeenCalledTimes(1);
  });

  it("de-activates without requiring a readiness check", async () => {
    activateCall.mockResolvedValue({
      hospitalId: "h-ready",
      isActive: false,
      reason: "deactivated",
      activatedAt: null,
    });
    renderPage();

    await screen.findByText("Ready Hospital");
    await userEvent.click(screen.getByTestId("select-h-ready"));
    // No validation run first — de-activate is always enabled.
    await userEvent.click(screen.getByTestId("deactivate-btn"));

    await waitFor(() => expect(activateCall).toHaveBeenCalledTimes(1));
    expect(activateCall.mock.calls[0]![3]).toBe(false);
    expect(
      await screen.findByTestId("activation-feedback"),
    ).toHaveTextContent(/de-activated/i);
  });
});
