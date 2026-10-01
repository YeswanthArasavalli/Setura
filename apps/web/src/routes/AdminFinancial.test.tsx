import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ApiError } from "@/lib/errors";
import type {
  FinancialOverviewResponseBody,
  ReconciliationResponseBody,
  RevenueForecastResponseBody,
} from "@/types/api";

/**
 * The read-only Finance / Collections surface (Phase 7 G-09).
 *
 * Mocked boundaries: the three `financial-command-center` read wrappers (their
 * exact request shape and tenant-in-header-only are pinned in
 * `financial.test.ts`; live transport, the role gate, cross-tenant isolation
 * and the service-role-only RPC boundary are all proven by the backend real-HTTP
 * suite `financial_command_center_http.test.ts`) and the auth context. These
 * tests pin the PAGE's own guarantees:
 *
 *  - exactly one read per action per explicit load and NO polling or remount
 *    double-fire; a single manual Refresh is the only other trigger;
 *  - the server's aggregates render verbatim — the page shows the server's own
 *    NET value even when it matches no arithmetic of the other displayed
 *    figures (proof there is no client-side financial calculation, §10);
 *  - currency formatting is presentation-only (§12): `125000` → `₹1,25,000`,
 *    `0` → `₹0`, an absent value → `—` (§11 null-vs-zero);
 *  - each section fails / empties independently; a NULL payload says "no data"
 *    and an error is an error, never a fabricated `₹0` or empty success (§14);
 *  - a tenant-less global admin reuses the G-08 acting-context exactly once and
 *    the scope is disclosed, while an unresolved context waits honestly issuing
 *    zero financial requests.
 */
const overviewCall = vi.fn();
const forecastCall = vi.fn();
const reconCall = vi.fn();
const actingCall = vi.fn();
vi.mock("@/api/financial", () => ({
  fetchFinancialOverview: (h: string, o?: unknown) => overviewCall(h, o),
  fetchRevenueForecast: (h: string, o?: unknown) => forecastCall(h, o),
  fetchReconciliationSummary: (h: string, o?: unknown) => reconCall(h, o),
}));
vi.mock("@/api/portfolio", () => ({
  fetchActingHospitalContext: () => actingCall(),
}));

const auth = vi.hoisted(() => ({
  current: { role: "hospital_admin" as string | null, hospitalId: "h-1" as string | null },
}));
vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({
    staff: auth.current.role
      ? {
        fullName: "Test Admin",
        role: auth.current.role,
        hospitalId: auth.current.hospitalId,
      }
      : null,
    hospitalId: auth.current.hospitalId,
  }),
}));

const { AdminFinancial } = await import("@/routes/AdminFinancial");

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/financial"]}>
      <Routes>
        <Route path="/admin/financial" element={<AdminFinancial />} />
      </Routes>
    </MemoryRouter>,
  );
}

// net_collections (337) is deliberately unrelated to any combination of the
// other displayed figures, so rendering it proves the page never re-derives a
// total, refund or fee in the browser (§10).
const overviewOk: FinancialOverviewResponseBody = {
  action: "overview",
  financial: {
    hospital_id: "h-1",
    date: "2026-09-30",
    daily_collections: {
      total_collected: 125000,
      platform_fee: 12500,
      hospital_fee: 100000,
      receptionist_fee: 12500,
      refunds: 0,
      net_collections: 337,
      online_payments: 5,
      offline_payments: 0,
      pending_payments: 2,
    },
    settlement_intelligence: {
      outstanding_balance: 50000,
      aging_buckets: { current: 20000, overdue_8_30: 10000, overdue_31_plus: 20000 },
      overdue_count: 3,
      partial_payments: 0,
      collection_velocity_days: null,
      recent_settlements: null,
    },
    reconciliation: null,
  },
};

const forecastOk: RevenueForecastResponseBody = {
  action: "forecast",
  forecast: {
    hospital_id: "h-1",
    as_of: "2026-09-30",
    projected_month_revenue: 987654,
    projected_platform_fees: 90000,
    projected_settlements: 12000,
    refund_rate_30d: 12,
    refund_impact_forecast: 4321,
    collection_forecast_next_7d: 60000,
    inputs: { mtd_revenue: 500000, days_elapsed: 30, days_in_month: 30 },
  },
};

const reconOk: ReconciliationResponseBody = {
  action: "reconciliation",
  reconciliation: [
    {
      total_collected: 200000,
      platform_fee_total: 18000,
      receptionist_fee_total: 15000,
      total_refunded: 5000,
      total_settled: 100000,
      net_outstanding: 33333,
      booking_count: 40,
      paid_booking_count: 35,
    },
  ],
};

beforeEach(() => {
  overviewCall.mockReset().mockResolvedValue(overviewOk);
  forecastCall.mockReset().mockResolvedValue(forecastOk);
  reconCall.mockReset().mockResolvedValue(reconOk);
  actingCall.mockReset().mockResolvedValue(null);
  auth.current.role = "hospital_admin";
  auth.current.hospitalId = "h-1";
});

describe("AdminFinancial surface", () => {
  it("loads the three read actions once on mount with the session tenant", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("₹1,25,000")).toBeInTheDocument());
    expect(overviewCall).toHaveBeenCalledTimes(1);
    expect(forecastCall).toHaveBeenCalledTimes(1);
    expect(reconCall).toHaveBeenCalledTimes(1);
    expect(overviewCall.mock.calls[0][0]).toBe("h-1");
    // A session that already carries a tenant never pays for a context read.
    expect(actingCall).not.toHaveBeenCalled();
    expect(screen.getByText("h-1")).toBeInTheDocument();
    expect(screen.getByText(/taken from your session/i)).toBeInTheDocument();
  });

  it("shows an explicit loading state for every section before the reads land", () => {
    overviewCall.mockReturnValue(new Promise(() => {}));
    forecastCall.mockReturnValue(new Promise(() => {}));
    reconCall.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByText("Loading overview…")).toBeInTheDocument();
    expect(screen.getByText("Loading forecast…")).toBeInTheDocument();
    expect(screen.getByText("Loading reconciliation…")).toBeInTheDocument();
  });

  it("renders the server aggregates and forecast and the reconciliation row", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("₹1,25,000")).toBeInTheDocument());

    expect(screen.getByText("Financial Overview")).toBeInTheDocument();
    expect(screen.getByText("Revenue Forecast")).toBeInTheDocument();
    expect(screen.getByText("Collections → Ledger Reconciliation")).toBeInTheDocument();

    // Forecast-only and reconciliation-only figures prove those sections.
    expect(screen.getByText("₹9,87,654")).toBeInTheDocument();
    expect(screen.getByText("₹33,333")).toBeInTheDocument();
  });

  it("renders the server's net value verbatim, never a browser re-computation", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("₹337")).toBeInTheDocument());
    // A naive client-side `total - refunds` (₹1,20,000) must NEVER appear:
    // the browser is presentation only (§10).
    expect(screen.queryByText("₹1,20,000")).toBeNull();
  });

  it("keeps 0 a real zero and renders absent values as an honest dash", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("₹1,25,000")).toBeInTheDocument());

    // Zero money (refunds) and zero counts (offline payments / partial
    // payments) stay "0" / "₹0", never "—".
    expect(screen.getAllByText("₹0").length).toBeGreaterThan(0);
    expect(screen.getAllByText("0").length).toBeGreaterThanOrEqual(2);
    // The NULL collection velocity and NULL embedded reconciliation are honest
    // absences, never a fabricated zero.
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(
      screen.getByText(/no reconciliation summary embedded/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/no settlement records/i)).toBeInTheDocument();
  });

  it("formats a NUMERIC string amount as currency without altering it", async () => {
    overviewCall.mockResolvedValue({
      action: "overview",
      financial: {
        ...overviewOk.financial!,
        daily_collections: {
          ...overviewOk.financial!.daily_collections,
          total_collected: "125000",
        },
      },
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("₹1,25,000")).toBeInTheDocument());
  });

  it("says so when reconciliation is legitimately empty, without inventing zeroes", async () => {
    reconCall.mockResolvedValue({ action: "reconciliation", reconciliation: [] });
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByText(/no reconciliation rows for this window/i),
      ).toBeInTheDocument(),
    );
    // The other two sections are unaffected.
    expect(screen.getByText("₹1,25,000")).toBeInTheDocument();
    expect(screen.getByText("₹9,87,654")).toBeInTheDocument();
  });

  it("treats a NULL overview payload as no data, not an error", async () => {
    overviewCall.mockResolvedValue({ action: "overview", financial: null });
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByText("No financial overview data available."),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("₹9,87,654")).toBeInTheDocument();
  });

  it("shows a failed section as an error while the others still render", async () => {
    forecastCall.mockRejectedValue(
      new ApiError({ code: "INTERNAL", message: "forecast failed", status: 500 }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText(/server could not complete/i)).toBeInTheDocument();
    expect(screen.getByText("₹1,25,000")).toBeInTheDocument();
    expect(screen.getByText("₹33,333")).toBeInTheDocument();
  });

  it("never dresses a role denial up as an empty dashboard", async () => {
    overviewCall.mockRejectedValue(
      new ApiError({ code: "ROLE_INSUFFICIENT", message: "no", status: 403 }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText(/do not have permission/i)).toBeInTheDocument();
    expect(screen.queryByText("No financial overview data available.")).toBeNull();
  });

  it("polls nothing, and a single Refresh issues exactly one more bounded cycle", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("₹1,25,000")).toBeInTheDocument());
    expect(overviewCall).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 150));
    expect(overviewCall).toHaveBeenCalledTimes(1);
    expect(forecastCall).toHaveBeenCalledTimes(1);
    expect(reconCall).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(overviewCall).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 150));
    expect(overviewCall).toHaveBeenCalledTimes(2);
    expect(forecastCall).toHaveBeenCalledTimes(2);
    expect(reconCall).toHaveBeenCalledTimes(2);
  });

  it("resolves the acting context once for a tenant-less global admin and discloses it", async () => {
    auth.current.role = "global_admin";
    auth.current.hospitalId = null;
    actingCall.mockResolvedValue({ hospitalId: "ctx-9", hospitalName: "Context Hospital" });
    renderPage();

    await waitFor(() => expect(screen.getByText("₹1,25,000")).toBeInTheDocument());
    expect(actingCall).toHaveBeenCalledTimes(1);
    expect(overviewCall.mock.calls[0][0]).toBe("ctx-9");
    expect(screen.getByText("ctx-9")).toBeInTheDocument();
    expect(
      screen.getByText(/your account has no hospital of its own/i),
    ).toBeInTheDocument();

    await new Promise((r) => setTimeout(r, 150));
    expect(overviewCall).toHaveBeenCalledTimes(1);
    expect(actingCall).toHaveBeenCalledTimes(1);
  });

  it("waits honestly and issues zero financial requests while the context is unresolved", () => {
    auth.current.role = "global_admin";
    auth.current.hospitalId = null;
    actingCall.mockReturnValue(new Promise(() => {}));
    renderPage();

    expect(screen.getByText(/waiting for the hospital context/i)).toBeInTheDocument();
    expect(overviewCall).not.toHaveBeenCalled();
    expect(forecastCall).not.toHaveBeenCalled();
    expect(reconCall).not.toHaveBeenCalled();
    expect(screen.queryByText("Loading overview…")).toBeNull();
  });

  it("shows an error, not a fake empty dashboard, when no context can be resolved", async () => {
    auth.current.role = "global_admin";
    auth.current.hospitalId = null;
    actingCall.mockResolvedValue(null);
    renderPage();

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(
      screen.getByText(/no hospital exists to satisfy the required context/i),
    ).toBeInTheDocument();
    expect(overviewCall).not.toHaveBeenCalled();
  });
});
