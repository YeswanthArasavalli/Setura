import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, type RenderResult } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * G-03 routing boundary: which role reaches the Command Centre surface.
 * G-05 extends the same boundary to the Audit & Compliance viewer.
 * G-08 adds the reverse case: /admin/portfolio is reachable by global_admin
 * ONLY — a hospital admin must be redirected away from the cross-tenant view.
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
vi.mock("@/routes/AdminAudit", () => ({
  AdminAudit: () => <div>ADMIN AUDIT PAGE</div>,
}));
vi.mock("@/routes/AdminReports", () => ({
  AdminReports: () => <div>ADMIN REPORTS PAGE</div>,
}));
vi.mock("@/routes/AdminPortfolio", () => ({
  AdminPortfolio: () => <div>ADMIN PORTFOLIO PAGE</div>,
}));
vi.mock("@/routes/AdminFinancial", () => ({
  AdminFinancial: () => <div>ADMIN FINANCIAL PAGE</div>,
}));
vi.mock("@/routes/AdminAlerts", () => ({
  AdminAlerts: () => <div>ADMIN ALERTS PAGE</div>,
}));
vi.mock("@/routes/AdminOperations", () => ({
  AdminOperations: () => <div>ADMIN OPERATIONS PAGE</div>,
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

describe("G-05 audit viewer routing boundary", () => {
  it("hospital_admin reaches /admin/audit directly", () => {
    setRole("hospital_admin");
    renderAt("/admin/audit");
    expect(screen.getByText("ADMIN AUDIT PAGE")).toBeInTheDocument();
  });

  it("global_admin reaches /admin/audit directly", () => {
    setRole("global_admin");
    renderAt("/admin/audit");
    expect(screen.getByText("ADMIN AUDIT PAGE")).toBeInTheDocument();
  });

  it("receptionist cannot reach /admin/audit and issues no viewer request", () => {
    setRole("receptionist");
    renderAt("/admin/audit");
    // Redirected to the reception landing: the admin page never mounts, so
    // the enterprise-reports wrapper inside it is never invoked (acceptance
    // criterion 2 — zero requests from non-admin roles).
    expect(screen.queryByText("ADMIN AUDIT PAGE")).toBeNull();
    expect(screen.getByText("RECEPTION PAGE")).toBeInTheDocument();
  });

  it("doctor cannot reach /admin/audit", () => {
    setRole("doctor");
    renderAt("/admin/audit");
    expect(screen.queryByText("ADMIN AUDIT PAGE")).toBeNull();
    expect(screen.getByText("DOCTOR PAGE")).toBeInTheDocument();
  });

  it("navigation exposes Audit & Compliance only to admin roles", () => {
    setRole("hospital_admin");
    const view = renderAt("/admin/audit");
    expect(
      screen.getByRole("link", { name: "Audit & Compliance" }),
    ).toBeInTheDocument();
    view.unmount();

    setRole("receptionist");
    renderAt("/reception");
    expect(
      screen.queryByRole("link", { name: "Audit & Compliance" }),
    ).toBeNull();

    setRole("doctor");
    renderAt("/doctor");
    expect(
      screen.queryByRole("link", { name: "Audit & Compliance" }),
    ).toBeNull();
  });

  it("G-03 routing is unchanged: admins still land on the Command Centre", () => {
    setRole("hospital_admin");
    renderAt("/");
    expect(screen.getByText("ADMIN COMMAND CENTRE PAGE")).toBeInTheDocument();
  });
});

describe("G-06 executive reports viewer routing boundary", () => {
  it("hospital_admin reaches /admin/reports directly", () => {
    setRole("hospital_admin");
    renderAt("/admin/reports");
    expect(screen.getByText("ADMIN REPORTS PAGE")).toBeInTheDocument();
  });

  it("global_admin reaches /admin/reports directly", () => {
    setRole("global_admin");
    renderAt("/admin/reports");
    expect(screen.getByText("ADMIN REPORTS PAGE")).toBeInTheDocument();
  });

  it("receptionist cannot reach /admin/reports and issues no viewer request", () => {
    setRole("receptionist");
    renderAt("/admin/reports");
    // Redirected to the reception landing: the reports page never mounts, so
    // the generate wrapper inside it is never invoked (zero requests).
    expect(screen.queryByText("ADMIN REPORTS PAGE")).toBeNull();
    expect(screen.getByText("RECEPTION PAGE")).toBeInTheDocument();
  });

  it("doctor cannot reach /admin/reports", () => {
    setRole("doctor");
    renderAt("/admin/reports");
    expect(screen.queryByText("ADMIN REPORTS PAGE")).toBeNull();
    expect(screen.getByText("DOCTOR PAGE")).toBeInTheDocument();
  });

  it("navigation exposes Executive Reports only to admin roles", () => {
    setRole("hospital_admin");
    const view = renderAt("/admin/reports");
    expect(
      screen.getByRole("link", { name: "Executive Reports" }),
    ).toBeInTheDocument();
    view.unmount();

    setRole("receptionist");
    renderAt("/reception");
    expect(
      screen.queryByRole("link", { name: "Executive Reports" }),
    ).toBeNull();

    setRole("doctor");
    renderAt("/doctor");
    expect(
      screen.queryByRole("link", { name: "Executive Reports" }),
    ).toBeNull();
  });

  it("G-03/G-05 routes remain unchanged alongside G-06", () => {
    setRole("hospital_admin");
    const view = renderAt("/admin/audit");
    expect(screen.getByText("ADMIN AUDIT PAGE")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Audit & Compliance" }),
    ).toBeInTheDocument();
    view.unmount();
  });
});

describe("G-08 global portfolio routing boundary", () => {
  it("global_admin reaches /admin/portfolio directly", () => {
    setRole("global_admin");
    renderAt("/admin/portfolio");
    expect(screen.getByText("ADMIN PORTFOLIO PAGE")).toBeInTheDocument();
  });

  it("hospital_admin is redirected away and never receives the global surface", () => {
    setRole("hospital_admin");
    renderAt("/admin/portfolio");
    // The page never mounts, so its wrappers are never invoked; the admin is
    // sent to their own landing (the Command Centre).
    expect(screen.queryByText("ADMIN PORTFOLIO PAGE")).toBeNull();
    expect(screen.getByText("ADMIN COMMAND CENTRE PAGE")).toBeInTheDocument();
  });

  it("receptionist cannot reach /admin/portfolio", () => {
    setRole("receptionist");
    renderAt("/admin/portfolio");
    expect(screen.queryByText("ADMIN PORTFOLIO PAGE")).toBeNull();
    expect(screen.getByText("RECEPTION PAGE")).toBeInTheDocument();
  });

  it("doctor cannot reach /admin/portfolio", () => {
    setRole("doctor");
    renderAt("/admin/portfolio");
    expect(screen.queryByText("ADMIN PORTFOLIO PAGE")).toBeNull();
    expect(screen.getByText("DOCTOR PAGE")).toBeInTheDocument();
  });

  it("navigation exposes Global Portfolio to global_admin only — not to hospital_admin", () => {
    setRole("global_admin");
    const globalView = renderAt("/admin/portfolio");
    expect(
      screen.getByRole("link", { name: "Global Portfolio" }),
    ).toBeInTheDocument();
    globalView.unmount();

    // The gap this closes versus G-03/G-05/G-06: a hospital admin is an ADMIN
    // but must not see (or reach) the cross-tenant portfolio.
    setRole("hospital_admin");
    const hospitalView = renderAt("/admin");
    expect(
      screen.queryByRole("link", { name: "Global Portfolio" }),
    ).toBeNull();
    expect(screen.getByRole("link", { name: "Command Centre" })).toBeInTheDocument();
    hospitalView.unmount();

    setRole("receptionist");
    renderAt("/reception");
    expect(
      screen.queryByRole("link", { name: "Global Portfolio" }),
    ).toBeNull();
  });

  it("G-03/G-05/G-06 routes and nav remain unchanged alongside G-08", () => {
    setRole("hospital_admin");
    const view = renderAt("/admin/reports");
    expect(screen.getByText("ADMIN REPORTS PAGE")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Executive Reports" }),
    ).toBeInTheDocument();
    view.unmount();

    setRole("global_admin");
    renderAt("/admin/audit");
    expect(screen.getByText("ADMIN AUDIT PAGE")).toBeInTheDocument();
    expect(screen.queryByText("ADMIN PORTFOLIO PAGE")).toBeNull();
  });
});

describe("G-09 finance / collections viewer routing boundary", () => {
  it("hospital_admin reaches /admin/financial directly", () => {
    setRole("hospital_admin");
    renderAt("/admin/financial");
    expect(screen.getByText("ADMIN FINANCIAL PAGE")).toBeInTheDocument();
  });

  it("global_admin reaches /admin/financial directly", () => {
    setRole("global_admin");
    renderAt("/admin/financial");
    expect(screen.getByText("ADMIN FINANCIAL PAGE")).toBeInTheDocument();
  });

  it("receptionist cannot reach /admin/financial and issues no financial request", () => {
    setRole("receptionist");
    renderAt("/admin/financial");
    // Redirected to the reception landing: the finance page never mounts, so
    // its financial-command-center wrappers are never invoked (zero requests).
    expect(screen.queryByText("ADMIN FINANCIAL PAGE")).toBeNull();
    expect(screen.getByText("RECEPTION PAGE")).toBeInTheDocument();
  });

  it("doctor cannot reach /admin/financial", () => {
    setRole("doctor");
    renderAt("/admin/financial");
    expect(screen.queryByText("ADMIN FINANCIAL PAGE")).toBeNull();
    expect(screen.getByText("DOCTOR PAGE")).toBeInTheDocument();
  });

  it("navigation exposes Finance / Collections to admin roles only", () => {
    setRole("hospital_admin");
    const view = renderAt("/admin/financial");
    expect(
      screen.getByRole("link", { name: "Finance / Collections" }),
    ).toBeInTheDocument();
    view.unmount();

    setRole("receptionist");
    renderAt("/reception");
    expect(
      screen.queryByRole("link", { name: "Finance / Collections" }),
    ).toBeNull();

    setRole("doctor");
    renderAt("/doctor");
    expect(
      screen.queryByRole("link", { name: "Finance / Collections" }),
    ).toBeNull();
  });

  it("G-03/G-05/G-06/G-08 routes and nav remain unchanged alongside G-09", () => {
    setRole("hospital_admin");
    const view = renderAt("/admin/reports");
    expect(screen.getByText("ADMIN REPORTS PAGE")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Executive Reports" }),
    ).toBeInTheDocument();
    // The finance entry now sits alongside the other admin-only viewers.
    expect(
      screen.getByRole("link", { name: "Finance / Collections" }),
    ).toBeInTheDocument();
    view.unmount();
  });
});

describe("G-10 alert-center viewer routing boundary", () => {
  it("hospital_admin reaches /admin/alerts directly", () => {
    setRole("hospital_admin");
    renderAt("/admin/alerts");
    expect(screen.getByText("ADMIN ALERTS PAGE")).toBeInTheDocument();
  });

  it("global_admin reaches /admin/alerts directly", () => {
    setRole("global_admin");
    renderAt("/admin/alerts");
    expect(screen.getByText("ADMIN ALERTS PAGE")).toBeInTheDocument();
  });

  it("receptionist cannot reach /admin/alerts and issues no alert-center request", () => {
    setRole("receptionist");
    renderAt("/admin/alerts");
    // Redirected to the reception landing: the alert page never mounts, so its
    // alert-center wrappers are never invoked (zero requests).
    expect(screen.queryByText("ADMIN ALERTS PAGE")).toBeNull();
    expect(screen.getByText("RECEPTION PAGE")).toBeInTheDocument();
  });

  it("doctor cannot reach /admin/alerts", () => {
    setRole("doctor");
    renderAt("/admin/alerts");
    expect(screen.queryByText("ADMIN ALERTS PAGE")).toBeNull();
    expect(screen.getByText("DOCTOR PAGE")).toBeInTheDocument();
  });

  it("navigation exposes Alert Center to admin roles only", () => {
    setRole("hospital_admin");
    const view = renderAt("/admin/alerts");
    expect(screen.getByRole("link", { name: "Alert Center" })).toBeInTheDocument();
    view.unmount();

    setRole("receptionist");
    renderAt("/reception");
    expect(screen.queryByRole("link", { name: "Alert Center" })).toBeNull();

    setRole("doctor");
    renderAt("/doctor");
    expect(screen.queryByRole("link", { name: "Alert Center" })).toBeNull();
  });

  it("prior admin routes and nav remain unchanged alongside G-10", () => {
    setRole("hospital_admin");
    const view = renderAt("/admin/financial");
    expect(screen.getByText("ADMIN FINANCIAL PAGE")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Finance / Collections" }),
    ).toBeInTheDocument();
    // The alerts entry now sits alongside the other admin-only viewers.
    expect(screen.getByRole("link", { name: "Alert Center" })).toBeInTheDocument();
    view.unmount();
  });
});

describe("G-11 operations analytics routing boundary", () => {
  it("hospital_admin reaches /admin/operations directly", () => {
    setRole("hospital_admin");
    renderAt("/admin/operations");
    expect(screen.getByText("ADMIN OPERATIONS PAGE")).toBeInTheDocument();
  });

  it("global_admin reaches /admin/operations directly", () => {
    setRole("global_admin");
    renderAt("/admin/operations");
    expect(screen.getByText("ADMIN OPERATIONS PAGE")).toBeInTheDocument();
  });

  it("receptionist cannot reach /admin/operations and issues no analytics request", () => {
    setRole("receptionist");
    renderAt("/admin/operations");
    // Redirected to the reception landing: the operations page never mounts,
    // so its executive-analytics wrappers are never invoked (zero requests).
    expect(screen.queryByText("ADMIN OPERATIONS PAGE")).toBeNull();
    expect(screen.getByText("RECEPTION PAGE")).toBeInTheDocument();
  });

  it("doctor cannot reach /admin/operations", () => {
    setRole("doctor");
    renderAt("/admin/operations");
    expect(screen.queryByText("ADMIN OPERATIONS PAGE")).toBeNull();
    expect(screen.getByText("DOCTOR PAGE")).toBeInTheDocument();
  });

  it("navigation exposes Operations Analytics to admin roles only", () => {
    setRole("hospital_admin");
    const view = renderAt("/admin/operations");
    expect(
      screen.getByRole("link", { name: "Operations Analytics" }),
    ).toBeInTheDocument();
    view.unmount();

    setRole("receptionist");
    renderAt("/reception");
    expect(
      screen.queryByRole("link", { name: "Operations Analytics" }),
    ).toBeNull();

    setRole("doctor");
    renderAt("/doctor");
    expect(
      screen.queryByRole("link", { name: "Operations Analytics" }),
    ).toBeNull();
  });

  it("prior admin routes and nav remain unchanged alongside G-11", () => {
    setRole("hospital_admin");
    const view = renderAt("/admin/alerts");
    expect(screen.getByText("ADMIN ALERTS PAGE")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Alert Center" })).toBeInTheDocument();
    // The operations entry now sits alongside the other admin-only viewers.
    expect(
      screen.getByRole("link", { name: "Operations Analytics" }),
    ).toBeInTheDocument();
    view.unmount();

    // G-08 remains global-admin-only: a hospital admin still cannot reach or
    // see the cross-tenant portfolio alongside the new G-11 entry.
    setRole("hospital_admin");
    renderAt("/admin/operations");
    expect(
      screen.queryByRole("link", { name: "Global Portfolio" }),
    ).toBeNull();
  });
});
