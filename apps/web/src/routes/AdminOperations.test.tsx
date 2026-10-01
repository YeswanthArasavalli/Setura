import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ApiError } from "@/lib/errors";
import type {
  DailyOperationsResponseBody,
  DoctorRankingsResponseBody,
} from "@/types/api";

/**
 * The read-only Hospital Operations Analytics surface (Phase 7 G-11).
 *
 * Mocked boundaries: the two `executive-analytics` read wrappers (their exact
 * request shape and tenant-in-header-only are pinned in `operations.test.ts`;
 * live transport, the role gate, cross-tenant isolation and the
 * service-role-only RPC boundary are all proven by the backend real-HTTP suite
 * `executive_analytics_operations_http.test.ts`) and the auth context. These
 * tests pin the PAGE's own guarantees:
 *
 *  - exactly one read per action per explicit load and NO polling or remount
 *    double-fire; a single manual Refresh is the only other trigger;
 *  - the server's aggregates and ranks render verbatim — rows appear in the
 *    ORDER AND RANKS THE SERVER RETURNED, proving no client-side sorting or
 *    ranking (§13);
 *  - each section fails / empties independently; a NULL payload says "no data"
 *    and an error is an error, never a fabricated empty success (§16);
 *  - `0` stays `0` and an absent value stays `—`, including the SLA
 *    `compliant`-only untracked variant (§17);
 *  - a tenant-less global admin reuses the G-08/G-09 acting context exactly
 *    once and the scope is disclosed, while an unresolved context waits honest
 *    with zero executive-analytics requests;
 *  - the surface is READ-ONLY: the only control is Refresh.
 */
const dailyCall = vi.fn();
const rankingsCall = vi.fn();
const actingCall = vi.fn();
vi.mock("@/api/operations", () => ({
  fetchDailyOperations: (h: string, o?: unknown) => dailyCall(h, o),
  fetchDoctorRankings: (h: string, o?: unknown) => rankingsCall(h, o),
}));
vi.mock("@/api/portfolio", () => ({
  fetchActingHospitalContext: () => actingCall(),
}));

const auth = vi.hoisted(() => ({
  current: {
    role: "hospital_admin" as string | null,
    hospitalId: "h-1" as string | null,
  },
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

const { AdminOperations } = await import("@/routes/AdminOperations");

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/operations"]}>
      <Routes>
        <Route path="/admin/operations" element={<AdminOperations />} />
      </Routes>
    </MemoryRouter>,
  );
}

// The fixtures mirror the REAL response contract (migration 47 §6). The
// rankings arrive with `completed` values 20 / 7 / 10 — neither ascending nor
// descending — so asserting this DOM order proves the page renders the
// server's own order and never re-sorts by a client metric (§13).
const dailyOk: DailyOperationsResponseBody = {
  action: "daily_operations",
  dashboard: {
    hospital_id: "h-1",
    date: "2026-09-28",
    hourly_trend: [
      { hour: 9, bookings: 12, completed: 10 },
      { hour: 10, bookings: 7, completed: 0 },
    ],
    operations: {
      total_bookings: 19,
      completed: 10,
      cancellation_rate_pct: 5.3,
      no_show_rate_pct: 0,
      avg_wait_minutes: "22.5",
      avg_consultation_minutes: null,
      doctor_throughput: [
        { doctor_id: "d-1", completed: 6 },
        { doctor_id: "d-2", completed: 0 },
      ],
    },
    sla: {
      compliant: false,
      avg_wait_minutes: 24.1,
      completion_rate_pct: 78.9,
    },
  },
};

const rankingsOk: DoctorRankingsResponseBody = {
  action: "doctor_rankings",
  rankings: {
    hospital_id: "h-1",
    from_date: "2026-09-01",
    to_date: "2026-09-30",
    rankings: [
      {
        doctor_id: "d-1",
        completed: 20,
        total_assigned: 25,
        avg_consultation_minutes: 14.2,
        load_pct: 41.7,
        throughput_rank: 1,
        efficiency_rank: 2,
      },
      {
        doctor_id: "d-2",
        completed: 7,
        total_assigned: 7,
        avg_consultation_minutes: null,
        load_pct: 11.7,
        throughput_rank: 4,
        efficiency_rank: 1,
      },
      {
        doctor_id: "d-3",
        completed: 10,
        total_assigned: 18,
        avg_consultation_minutes: 11.0,
        load_pct: 30.0,
        throughput_rank: 2,
        efficiency_rank: 3,
      },
    ],
    utilization_heatmap: [
      { doctor_id: "d-1", weekday: 1, completed: 4 },
      { doctor_id: "d-1", weekday: 2, completed: 0 },
    ],
  },
};

beforeEach(() => {
  dailyCall.mockReset().mockResolvedValue(dailyOk);
  rankingsCall.mockReset().mockResolvedValue(rankingsOk);
  actingCall.mockReset().mockResolvedValue(null);
  auth.current.role = "hospital_admin";
  auth.current.hospitalId = "h-1";
});

describe("AdminOperations surface", () => {
  it("loads the two read actions once on mount with the session tenant", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("19")).toBeInTheDocument());
    expect(dailyCall).toHaveBeenCalledTimes(1);
    expect(rankingsCall).toHaveBeenCalledTimes(1);
    expect(dailyCall.mock.calls[0][0]).toBe("h-1");
    expect(rankingsCall.mock.calls[0][0]).toBe("h-1");
    // A session that already carries a tenant never pays for a context read.
    expect(actingCall).not.toHaveBeenCalled();
    expect(screen.getByText("h-1")).toBeInTheDocument();
    expect(screen.getByText(/taken from your session/i)).toBeInTheDocument();
  });

  it("shows an explicit loading state for every section before the reads land", () => {
    dailyCall.mockReturnValue(new Promise(() => {}));
    rankingsCall.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByText("Loading daily operations…")).toBeInTheDocument();
    expect(screen.getByText("Loading rankings…")).toBeInTheDocument();
  });

  it("renders the daily operations and rankings sections with server values", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("19")).toBeInTheDocument());

    expect(screen.getByText("Hospital Operations")).toBeInTheDocument();
    expect(screen.getByText("Doctor Rankings")).toBeInTheDocument();

    // Section-identifying server values, rendered verbatim. The daily
    // date and the rankings window are distinct fixture values so each
    // text is pinned to the section that owns it.
    expect(screen.getByText("2026-09-28")).toBeInTheDocument();
    expect(screen.getByText("2026-09-30")).toBeInTheDocument();
    expect(screen.getByText("5.3")).toBeInTheDocument();
    expect(screen.getByText("22.5")).toBeInTheDocument();
    expect(screen.getByText("24.1")).toBeInTheDocument();
    expect(screen.getByText("78.9")).toBeInTheDocument();
    expect(screen.getByText("41.7")).toBeInTheDocument();
  });

  it("renders the server ranking order and ranks verbatim, never a client re-sort", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("41.7")).toBeInTheDocument());

    // The server order is d-1, d-2, d-3 (completed 20, 7, 10 — unsorted).
    // Scoped to the rankings table: the throughput and heatmap tables
    // legitimately repeat the same doctor ids elsewhere on the page.
    const table = screen.getByText("Throughput rank").closest("table")!;
    const rows = within(table)
      .getAllByText(/^d-[123]$/)
      .map((el) => el.textContent);
    expect(rows).toEqual(["d-1", "d-2", "d-3"]);

    // The ranks are the server's RANK() values, not positions recomputed in
    // the browser: d-2 shows throughput_rank 4 while listed second, and no
    // client-side 1/2/3 sequence replaces it.
    expect(within(table).getByText("4")).toBeInTheDocument();
  });

  it("keeps 0 a real zero and renders absent values as an honest dash", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("19")).toBeInTheDocument());

    // Real zeros (no_show_rate_pct, hourly completed, throughput completed,
    // heatmap completed) stay "0", never "—".
    expect(screen.getAllByText("0").length).toBeGreaterThanOrEqual(4);
    // The NULL avg_consultation (operations) is an honest absence.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("renders the SLA compliant-only untracked variant honestly", async () => {
    dailyCall.mockResolvedValue({
      action: "daily_operations",
      dashboard: {
        ...dailyOk.dashboard!,
        sla: { compliant: null },
      },
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("19")).toBeInTheDocument());
    expect(screen.getByText("Compliant")).toBeInTheDocument();
    // A null compliant is "not assessed", rendered as —, never "no"/false.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("shows honest empty states without inventing rows", async () => {
    dailyCall.mockResolvedValue({
      action: "daily_operations",
      dashboard: {
        ...dailyOk.dashboard!,
        hourly_trend: [],
        operations: { ...dailyOk.dashboard!.operations, doctor_throughput: null },
      },
    });
    rankingsCall.mockResolvedValue({
      action: "doctor_rankings",
      rankings: { ...rankingsOk.rankings!, rankings: [], utilization_heatmap: [] },
    });
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByText(/no bookings were created in any hour/i),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/no doctor-assigned bookings for this date/i)).toBeInTheDocument();
    expect(screen.getByText(/no ranked doctors for this window/i)).toBeInTheDocument();
    expect(screen.getByText(/no utilization cells for this window/i)).toBeInTheDocument();
    // Real zero summaries still render alongside the empty states.
    expect(screen.getByText("19")).toBeInTheDocument();
  });

  it("treats a NULL payload as no data, not an error", async () => {
    dailyCall.mockResolvedValue({ action: "daily_operations", dashboard: null });
    rankingsCall.mockResolvedValue({ action: "doctor_rankings", rankings: null });
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByText("No daily operations data available."),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("No doctor rankings data available.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a failed section as an error while the other still renders", async () => {
    rankingsCall.mockRejectedValue(
      new ApiError({ code: "INTERNAL", message: "rankings failed", status: 500 }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText(/server could not complete/i)).toBeInTheDocument();
    expect(screen.getByText("19")).toBeInTheDocument();
  });

  it("never dresses a role denial up as an empty dashboard", async () => {
    dailyCall.mockRejectedValue(
      new ApiError({ code: "ROLE_INSUFFICIENT", message: "no", status: 403 }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText(/do not have permission/i)).toBeInTheDocument();
    expect(
      screen.queryByText("No daily operations data available."),
    ).toBeNull();
  });

  it("polls nothing, and a single Refresh issues exactly one more bounded cycle", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("19")).toBeInTheDocument());
    expect(dailyCall).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 150));
    expect(dailyCall).toHaveBeenCalledTimes(1);
    expect(rankingsCall).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(dailyCall).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 150));
    expect(dailyCall).toHaveBeenCalledTimes(2);
    expect(rankingsCall).toHaveBeenCalledTimes(2);
  });

  it("forwards date controls only on explicit Refresh, omitted when empty", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("19")).toBeInTheDocument());
    // Initial cycle: empty inputs → options carry no date keys at all (§14).
    expect(dailyCall.mock.calls[0][1]).toEqual({ date: undefined });
    expect(rankingsCall.mock.calls[0][1]).toEqual({
      fromDate: undefined,
      toDate: undefined,
    });

    await userEvent.type(screen.getByLabelText("Daily operations date"), "2026-09-15");
    await userEvent.type(screen.getByLabelText("Rankings from"), "2026-09-02");
    // Typing alone must NOT fire a request (§15).
    expect(dailyCall).toHaveBeenCalledTimes(1);
    expect(rankingsCall).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(dailyCall).toHaveBeenCalledTimes(2));
    expect(dailyCall.mock.calls[1][1]).toEqual({ date: "2026-09-15" });
    expect(rankingsCall.mock.calls[1][1]).toEqual({
      fromDate: "2026-09-02",
      toDate: undefined,
    });
  });

  it("is read-only: the only control is Refresh", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("19")).toBeInTheDocument());
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Refresh"]);
  });

  it("resolves the acting context once for a tenant-less global admin and discloses it", async () => {
    auth.current.role = "global_admin";
    auth.current.hospitalId = null;
    actingCall.mockResolvedValue({
      hospitalId: "ctx-9",
      hospitalName: "Context Hospital",
    });
    renderPage();

    await waitFor(() => expect(screen.getByText("19")).toBeInTheDocument());
    expect(actingCall).toHaveBeenCalledTimes(1);
    expect(dailyCall.mock.calls[0][0]).toBe("ctx-9");
    expect(rankingsCall.mock.calls[0][0]).toBe("ctx-9");
    expect(screen.getByText("ctx-9")).toBeInTheDocument();
    expect(
      screen.getByText(/your account has no hospital of its own/i),
    ).toBeInTheDocument();

    await new Promise((r) => setTimeout(r, 150));
    expect(dailyCall).toHaveBeenCalledTimes(1);
    expect(actingCall).toHaveBeenCalledTimes(1);
  });

  it("waits honestly and issues zero analytics requests while the context is unresolved", () => {
    auth.current.role = "global_admin";
    auth.current.hospitalId = null;
    actingCall.mockReturnValue(new Promise(() => {}));
    renderPage();

    expect(screen.getByText(/waiting for the hospital context/i)).toBeInTheDocument();
    expect(dailyCall).not.toHaveBeenCalled();
    expect(rankingsCall).not.toHaveBeenCalled();
    expect(screen.queryByText("Loading daily operations…")).toBeNull();
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
    expect(dailyCall).not.toHaveBeenCalled();
    expect(rankingsCall).not.toHaveBeenCalled();
  });
});
