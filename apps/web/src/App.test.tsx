import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, type RenderResult } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * G-03 routing boundary: which role reaches the Command Centre surface.
 *
 * The real RequireRole guard and the real App route table / Landing dispatch
 * are under test; the auth context is mocked per-role and every page module is
 * a labelled stub, so this pins ROUTING behaviour only. Backend authorization
 * is separate and authoritative (command-center's own requireRole, proven by
 * the backend's real-HTTP suite) — this guard is the UX boundary.
 */
const auth = vi.hoisted(() => ({
  current: {
    role: "hospital_admin" as string | null,
    session: { user: { id: "u-1" } } as unknown,
    loading: false,
  },
}));

vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({
    session: auth.current.session,
    staff: auth.current.role
      ? { fullName: "Test", role: auth.current.role, hospitalId: "h-1" }
      : null,
    loading: auth.current.loading,
    error: null,
    role: auth.current.role,
    hospitalId: auth.current.role ? "h-1" : null,
    signIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));

// Page modules are stubs: this test must not drag Supabase/env or data fetches
// into a pure routing assertion. The stub labels are the observable locations.
vi.mock("@/routes/Login", () => ({ Login: () => <div>LOGIN PAGE</div> }));
vi.mock("@/routes/ReceptionDashboard", () => ({
  ReceptionDashboard: () => <div>RECEPTION PAGE</div>,
}));
vi.mock("@/routes/BookAppointment", () => ({
  BookAppointment: () => <div>BOOK PAGE</div>,
}));
vi.mock("@/routes/WalkIn", () => ({ WalkIn: () => <div>WALKIN PAGE</div> }));
vi.mock("@/routes/Patients", () => ({ Patients: () => <div>PATIENTS PAGE</div> }));
vi.mock("@/routes/Notifications", () => ({
  Notifications: () => <div>NOTIFICATIONS PAGE</div>,
}));
vi.mock("@/routes/QueueBoard", () => ({ QueueBoard: () => <div>QUEUE PAGE</div> }));
vi.mock("@/routes/DoctorConsole", () => ({
  DoctorConsole: () => <div>DOCTOR PAGE</div>,
}));
vi.mock("@/routes/BookingDetail", () => ({
  BookingDetail: () => <div>BOOKING DETAIL</div>,
}));
vi.mock("@/routes/AdminCommandCentre", () => ({
  AdminCommandCentre: () => <div>ADMIN COMMAND CENTRE PAGE</div>,
}));

const { default: App } = await import("@/App");

function renderAt(path: string): RenderResult {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

function setRole(role: string | null) {
  auth.current.role = role;
}

beforeEach(() => {
  auth.current.session = { user: { id: "u-1" } };
  auth.current.loading = false;
});

describe("G-03 role routing", () => {
  it("hospital_admin lands on the Command Centre at /admin", () => {
    setRole("hospital_admin");
    renderAt("/");
    expect(screen.getByText("ADMIN COMMAND CENTRE PAGE")).toBeInTheDocument();
  });

  it("global_admin lands on the Command Centre at /admin", () => {
    setRole("global_admin");
    renderAt("/");
    expect(screen.getByText("ADMIN COMMAND CENTRE PAGE")).toBeInTheDocument();
  });

  it("receptionist still lands on reception (unchanged) and cannot reach /admin", () => {
    setRole("receptionist");
    const landing = renderAt("/");
    expect(screen.getByText("RECEPTION PAGE")).toBeInTheDocument();

    landing.unmount();
    renderAt("/admin");
    // Redirected away: /admin never renders the admin surface for this role.
    expect(screen.queryByText("ADMIN COMMAND CENTRE PAGE")).toBeNull();
    expect(screen.getByText("RECEPTION PAGE")).toBeInTheDocument();
  });

  it("doctor still lands on the doctor console and cannot reach /admin", () => {
    setRole("doctor");
    const landing = renderAt("/");
    expect(screen.getByText("DOCTOR PAGE")).toBeInTheDocument();

    landing.unmount();
    renderAt("/admin");
    expect(screen.queryByText("ADMIN COMMAND CENTRE PAGE")).toBeNull();
    expect(screen.getByText("DOCTOR PAGE")).toBeInTheDocument();
  });

  it("admin route is directly reachable by URL for both admin roles", () => {
    setRole("hospital_admin");
    renderAt("/admin");
    expect(screen.getByText("ADMIN COMMAND CENTRE PAGE")).toBeInTheDocument();

    setRole("global_admin");
    renderAt("/admin");
    expect(screen.getAllByText("ADMIN COMMAND CENTRE PAGE").length).toBeGreaterThan(0);
  });

  it("navigation exposes Command Centre only to admin roles", () => {
    setRole("hospital_admin");
    const view = renderAt("/admin");
    expect(screen.getByRole("link", { name: "Command Centre" })).toBeInTheDocument();
    view.unmount();

    setRole("receptionist");
    renderAt("/reception");
    expect(screen.queryByRole("link", { name: "Command Centre" })).toBeNull();

    setRole("doctor");
    renderAt("/doctor");
    expect(screen.queryByRole("link", { name: "Command Centre" })).toBeNull();
  });

  it("hospital_admin keeps the existing reception and doctor entries (no regression)", () => {
    setRole("hospital_admin");
    renderAt("/admin");
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Doctor Console" })).toBeInTheDocument();
  });
});
