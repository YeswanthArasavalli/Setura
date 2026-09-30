import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ApiError } from "@/lib/errors";
import type {
  BenchmarksResponseBody,
  PortfolioResponseBody,
} from "@/types/api";

/**
 * The read-only Global Admin Portfolio Dashboard (Phase 7 G-08).
 *
 * Two boundaries are mocked: the portfolio wrapper (its exact request shape is
 * pinned in `portfolio.test.ts`, and live transport + role authorization are
 * proven by the backend's real-HTTP suite) and the auth context. These tests
 * pin the page's own guarantees:
 *
 *  - one request per global action per explicit load, and NO per-hospital
 *    fan-out (a 2-hospital portfolio still means 2 calls, not 4);
 *  - nothing polls or re-fires on its own (the auth-loop regression guard: an
 *    idle window produces zero further requests);
 *  - the backend's own aggregates render verbatim — `total_hospitals` and
 *    `active_hospitals` are distinct server numbers, never a browser `.length`;
 *  - `0` renders as `0`, an absent value renders as `—`, and an empty or NULL
 *    payload says "no data" instead of dressing absence up as zeroes;
 *  - one section's failure never destroys the other section or the page;
 *  - a session with the hospital context the contract demands never pays for an
 *    extra context read, and an account without one resolves it exactly once
 *    (or waits/errors honestly) while issuing zero analytics requests.
 */
const portfolioCall = vi.fn();
const benchmarksCall = vi.fn();
const actingCall = vi.fn();
vi.mock("@/api/portfolio", () => ({
  fetchGlobalPortfolio: (h: string) => portfolioCall(h),
  fetchCrossHospitalBenchmarks: (h: string) => benchmarksCall(h),
  fetchActingHospitalContext: () => actingCall(),
}));

const auth = vi.hoisted(() => ({
  current: { hospitalId: "h-1" as string | null },
}));
vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({
    hospitalId: auth.current.hospitalId,
    staff: {
      fullName: "Global Admin",
      role: "global_admin",
      hospitalId: auth.current.hospitalId,
    },
  }),
}));

const { AdminPortfolio } = await import("@/routes/AdminPortfolio");

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/portfolio"]}>
      <Routes>
        <Route path="/admin/portfolio" element={<AdminPortfolio />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Exactly what `get_portfolio_dashboard` returns for two tenants: distinct
 *  total/active counts, a real `0` revenue, a NULL outstanding balance and a
 *  NULL SLA status (no tracking row) — the semantics the page must preserve. */
const portfolioOk: PortfolioResponseBody = {
  action: "portfolio",
  portfolio: {
    date: "2026-09-30",
    total_hospitals: 2,
    active_hospitals: 1,
    hospitals: [
      {
        hospital_id: "11111111-1111-1111-1111-111111111111",
        name: "Surya Hospital",
        slug: "surya",
        is_active: true,
        bookings_today: 7,
        revenue_today: 1500,
        outstanding_balance: 250,
        sla_status: "breached",
        active_sessions: 3,
      },
      {
        hospital_id: "22222222-2222-2222-2222-222222222222",
        name: "Moon Hospital",
        slug: "moon",
        is_active: false,
        bookings_today: 0,
        revenue_today: 0,
        outstanding_balance: null,
        sla_status: null,
        active_sessions: 0,
      },
    ],
  },
};

const benchmarksOk: BenchmarksResponseBody = {
  action: "benchmarks",
  benchmarks: {
    from_date: "2026-09-01",
    to_date: "2026-09-30",
    benchmarks: [
      {
        hospital_id: "11111111-1111-1111-1111-111111111111",
        name: "Surya Hospital",
        bookings: 40,
        completed: 30,
        avg_wait_minutes: 12.5,
        avg_consultation_minutes: 18,
        efficiency_pct: 75,
        revenue_inr: 90000,
      },
      {
        hospital_id: "22222222-2222-2222-2222-222222222222",
        name: "Moon Hospital",
        bookings: 4,
        completed: 0,
        avg_wait_minutes: null,
        avg_consultation_minutes: null,
        efficiency_pct: null,
        revenue_inr: 0,
      },
    ],
  },
};

beforeEach(() => {
  portfolioCall.mockReset().mockResolvedValue(portfolioOk);
  benchmarksCall.mockReset().mockResolvedValue(benchmarksOk);
  actingCall.mockReset().mockResolvedValue(null);
  auth.current.hospitalId = "h-1";
});

describe("AdminPortfolio dashboard", () => {
  it("loads both global actions once on mount, with the session tenant", async () => {
    renderPage();
    // The slug appears only in the portfolio table; the revenue figure only in
    // the benchmarks table — so each proves its own section actually landed.
    await waitFor(() =>
      expect(screen.getByText("surya")).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByText("90000")).toBeInTheDocument(),
    );
    expect(portfolioCall).toHaveBeenCalledTimes(1);
    expect(benchmarksCall).toHaveBeenCalledTimes(1);
    expect(portfolioCall).toHaveBeenCalledWith("h-1");
    expect(benchmarksCall).toHaveBeenCalledWith("h-1");
    // A session that already carries its tenant never pays for a context read.
    expect(actingCall).not.toHaveBeenCalled();
    // And the page says where the header value came from.
    expect(screen.getByText("h-1")).toBeInTheDocument();
    expect(screen.getByText(/taken from your session/i)).toBeInTheDocument();
  });

  it("shows a clear loading state before the responses land", () => {
    portfolioCall.mockReturnValue(new Promise(() => {}));
    benchmarksCall.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByText("Loading portfolio…")).toBeInTheDocument();
    expect(screen.getByText("Loading benchmarks…")).toBeInTheDocument();
  });

  it("renders the server's own portfolio aggregates and every hospital row", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("moon")).toBeInTheDocument(),
    );

    // The two counts are separate backend aggregates, both shown as returned.
    expect(screen.getByText("Reported date")).toBeInTheDocument();
    expect(screen.getByText("Total hospitals")).toBeInTheDocument();
    expect(screen.getByText("Active hospitals")).toBeInTheDocument();
    // The portfolio date also reappears as the benchmark window's end date.
    expect(screen.getAllByText("2026-09-30").length).toBe(2);
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
    expect(screen.getByText("1")).toBeInTheDocument();

    // Both tables carry the hospital names, so the portfolio copy is found by
    // its slug / portfolio-only values rather than an ambiguous name match.
    expect(screen.getAllByText("Surya Hospital").length).toBe(2);
    expect(screen.getByText("surya")).toBeInTheDocument();
    expect(screen.getByText("breached")).toBeInTheDocument();
    expect(screen.getByText("1500")).toBeInTheDocument();
  });

  it("keeps 0 a real zero and renders absent values as an honest dash", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("moon")).toBeInTheDocument());

    // Moon's zero bookings / revenue / sessions must NOT become "—".
    expect(screen.getAllByText("0").length).toBeGreaterThanOrEqual(4);
    // Its NULL outstanding balance and missing SLA row must NOT become "0".
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    // Inactive is the backend boolean, presented, not recomputed.
    expect(screen.getByText("no")).toBeInTheDocument();
  });

  it("renders the benchmark window and rows exactly as the backend returned them", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Cross-Hospital Benchmarks")).toBeInTheDocument(),
    );

    // The window line is benchmark-only; the portfolio date is a separate
    // single 2026-09-30 stat, so the range pair proves this section.
    expect(screen.getByText(/Window:/)).toBeInTheDocument();
    expect(screen.getByText("2026-09-01")).toBeInTheDocument();
    expect(screen.getAllByText("2026-09-30").length).toBe(2);
    expect(screen.getByText("40")).toBeInTheDocument();
    expect(screen.getByText("12.5")).toBeInTheDocument();
    expect(screen.getByText("90000")).toBeInTheDocument();
  });

  it("says so when the portfolio is legitimately empty, without inventing zeroes", async () => {
    portfolioCall.mockResolvedValue({
      action: "portfolio",
      portfolio: {
        date: "2026-09-30",
        total_hospitals: 0,
        active_hospitals: 0,
        hospitals: [],
      },
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getAllByText("No portfolio data available.").length)
        .toBeGreaterThan(0),
    );
    // The portfolio table is gone (the slug appears only there); the
    // benchmarks section is unaffected.
    expect(screen.queryByText("surya")).toBeNull();
    expect(screen.queryByText("No benchmark data available.")).toBeNull();
    expect(screen.getByText("Cross-Hospital Benchmarks")).toBeInTheDocument();
  });

  it("treats a NULL portfolio payload as no data, not as an error", async () => {
    portfolioCall.mockResolvedValue({ action: "portfolio", portfolio: null });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("No portfolio data available.")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    // The other section is unaffected.
    expect(screen.getByText("Surya Hospital")).toBeInTheDocument();
  });

  it("shows a failed section as an error while the other still renders", async () => {
    benchmarksCall.mockRejectedValue(
      new ApiError({
        code: "INTERNAL",
        message: "Benchmarks failed",
        status: 500,
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

    expect(screen.getByText(/server could not complete/i)).toBeInTheDocument();
    // Partial failure: the portfolio section is untouched.
    expect(screen.getByText("Surya Hospital")).toBeInTheDocument();
    expect(screen.queryByText("Loading benchmarks…")).toBeNull();
  });

  it("never dresses a privilege denial up as an empty dashboard", async () => {
    portfolioCall.mockRejectedValue(
      new ApiError({
        code: "FORBIDDEN",
        message: "Portfolio analytics require global admin access",
        status: 403,
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText(/do not have permission/i)).toBeInTheDocument();
    expect(screen.queryByText("No portfolio data available.")).toBeNull();
  });

  it("polls nothing: an idle window after load issues zero further requests", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("surya")).toBeInTheDocument());
    expect(portfolioCall).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 150));
    expect(portfolioCall).toHaveBeenCalledTimes(1);
    expect(benchmarksCall).toHaveBeenCalledTimes(1);

    // A single explicit refresh is the only other way to re-request.
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(portfolioCall).toHaveBeenCalledTimes(2),
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(portfolioCall).toHaveBeenCalledTimes(2);
    expect(benchmarksCall).toHaveBeenCalledTimes(2);
  });

  it("resolves the acting context once for a tenant-less global admin and says so", async () => {
    auth.current.hospitalId = null;
    actingCall.mockResolvedValue({
      hospitalId: "ctx-9",
      hospitalName: "E1 Journey 0461900 A",
    });
    renderPage();

    await waitFor(() => expect(screen.getByText("surya")).toBeInTheDocument());
    expect(actingCall).toHaveBeenCalledTimes(1);
    expect(portfolioCall).toHaveBeenCalledWith("ctx-9");
    expect(benchmarksCall).toHaveBeenCalledWith("ctx-9");
    // The substituted context is disclosed, not hidden behind a session claim.
    expect(screen.getByText("ctx-9")).toBeInTheDocument();
    expect(
      screen.getByText(/your account has no hospital of its own/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/taken from your session/i)).toBeNull();

    // Still exactly one request per action, and the context read is not retried.
    await new Promise((r) => setTimeout(r, 150));
    expect(portfolioCall).toHaveBeenCalledTimes(1);
    expect(benchmarksCall).toHaveBeenCalledTimes(1);
    expect(actingCall).toHaveBeenCalledTimes(1);
  });

  it("waits honestly and issues zero analytics requests while the context is unresolved", () => {
    auth.current.hospitalId = null;
    actingCall.mockReturnValue(new Promise(() => {}));
    renderPage();

    expect(
      screen.getByText(/waiting for the hospital context/i),
    ).toBeInTheDocument();
    expect(portfolioCall).not.toHaveBeenCalled();
    expect(benchmarksCall).not.toHaveBeenCalled();
    expect(screen.queryByText("Loading portfolio…")).toBeNull();
    expect(screen.queryByText("surya")).toBeNull();
  });

  it("shows an error, not a fake empty dashboard, when no context can be resolved", async () => {
    auth.current.hospitalId = null;
    actingCall.mockResolvedValue(null);
    renderPage();

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(
      screen.getByText(/no hospital exists to satisfy the required context/i),
    ).toBeInTheDocument();
    expect(portfolioCall).not.toHaveBeenCalled();
    expect(benchmarksCall).not.toHaveBeenCalled();
    expect(screen.queryByText("No portfolio data available.")).toBeNull();
  });

  it("surfaces a failed context read as its own error", async () => {
    auth.current.hospitalId = null;
    actingCall.mockRejectedValue(
      new ApiError({
        code: "FORBIDDEN",
        message: "Could not resolve the hospital context the service requires.",
        status: 403,
      }),
    );
    renderPage();

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText(/do not have permission/i)).toBeInTheDocument();
    expect(portfolioCall).not.toHaveBeenCalled();
    expect(actingCall).toHaveBeenCalledTimes(1);
  });
});
