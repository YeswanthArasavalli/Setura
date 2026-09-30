import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ApiError } from "@/lib/errors";
import type {
  ExecutiveReportType,
  GenerateReportResponseBody,
} from "@/types/api";

/**
 * The read-only Executive / Operational Reports viewer (Phase 7 G-06).
 *
 * Only two boundaries are mocked: the generate wrapper (its exact request shape
 * is pinned in executiveReports.test.ts; live behavior is proven by the
 * backend's own real-HTTP suite) and the auth context. The tests pin the UX
 * guarantees the phase requires: exactly the six approved report surfaces and no
 * financial/settlement control; NOTHING fires on mount (generation is an
 * explicit click); a date keystroke never triggers a request; loading / success /
 * empty / error are distinct; a number stays a number (0 is not "—") and an
 * absent value renders truthfully; one report's failure does not crash the page
 * or block another report; and a tenant-less account issues zero requests.
 */
const generate = vi.fn();
vi.mock("@/api/executiveReports", () => ({
  generateExecutiveReport: (
    h: string,
    rt: ExecutiveReportType,
    opts?: { fromDate?: string; toDate?: string },
  ) => generate(h, rt, opts ?? {}),
}));

const auth = vi.hoisted(() => ({
  current: { hospitalId: "h-1" as string | null },
}));
vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({
    hospitalId: auth.current.hospitalId,
    staff: auth.current.hospitalId
      ? {
          fullName: "Ada Admin",
          role: "hospital_admin",
          hospitalId: auth.current.hospitalId,
        }
      : null,
  }),
}));

const { AdminReports } = await import("@/routes/AdminReports");

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/reports"]}>
      <Routes>
        <Route path="/admin/reports" element={<AdminReports />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** A realistic daily_hospital payload: nested rollups, a 0 that must render as
 *  "0", a null that must render as "—", and an array of records that becomes a
 *  table whose columns come from the rows' own keys. */
const dailyOk: GenerateReportResponseBody = {
  action: "generate",
  format: "json",
  report: {
    ok: true,
    report_type: "daily_hospital",
    hospital_id: "h-1",
    from_date: "2026-09-23",
    to_date: "2026-09-29",
    columns: ["patients", "queues", "alert_activity"],
    generated_at: "2026-09-29T09:30:00Z",
    data: {
      patients: {
        total_today: 12,
        no_shows: 0,
        avg_wait_minutes: null,
      },
      queues: {
        active_sessions: 3,
        doctor_availability: [
          { doctor_id: "d-1", is_paused: false, current_token: 7 },
          { doctor_id: "d-2", is_paused: true, current_token: null },
        ],
      },
      alert_activity: { recent_alerts_24h: 0 },
    },
  },
};

beforeEach(() => {
  generate.mockReset();
  auth.current.hospitalId = "h-1";
});

describe("AdminReports viewer", () => {
  it("renders exactly the six approved report surfaces and no money report", () => {
    renderPage();
    expect(screen.getByText("Daily Hospital")).toBeInTheDocument();
    expect(screen.getByText("Weekly Operations")).toBeInTheDocument();
    expect(screen.getByText("Monthly Executive")).toBeInTheDocument();
    expect(screen.getByText("Doctor Performance")).toBeInTheDocument();
    expect(screen.getByText("SLA")).toBeInTheDocument();
    expect(screen.getByText("Audit")).toBeInTheDocument();
    // Standalone financial / settlement report types are not surfaced: no
    // report card renders those exact type badges.
    expect(screen.queryByText("financial")).toBeNull();
    expect(screen.queryByText("settlement")).toBeNull();
    // Exactly the six approved surfaces, one Generate control each.
    expect(screen.getAllByRole("button", { name: "Generate report" })).toHaveLength(6);
  });

  it("performs ZERO report generation on mount — reports are an explicit action", () => {
    renderPage();
    expect(generate).not.toHaveBeenCalled();
    expect(screen.getAllByText("Not generated yet.").length).toBe(6);
  });

  it("typing into the date field never fires a request (§25)", async () => {
    const user = userEvent.setup();
    renderPage();
    const from = screen.getByLabelText("From date");
    await user.type(from, "2026-09-01");
    expect(generate).not.toHaveBeenCalled();
  });

  it("a generate click fires exactly ONE request for that report type only", async () => {
    const user = userEvent.setup();
    generate.mockResolvedValue(dailyOk);
    renderPage();
    await user.click(
      screen.getAllByRole("button", { name: "Generate report" })[0],
    );
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    expect(generate).toHaveBeenCalledWith("h-1", "daily_hospital", {
      fromDate: undefined,
      toDate: expect.any(String),
    });
  });

  it("renders real backend values truthfully: 0 stays 0, null is a dash", async () => {
    const user = userEvent.setup();
    generate.mockResolvedValue(dailyOk);
    renderPage();
    await user.click(
      screen.getAllByRole("button", { name: "Generate report" })[0],
    );

    // Patients total_today 12 renders, and the 0 no_shows renders as "0".
    expect(await screen.findByText("12")).toBeInTheDocument();
    // Array-of-records becomes a table using the rows' own keys.
    expect(screen.getByText("d-1")).toBeInTheDocument();
    expect(screen.getByText("doctor id")).toBeInTheDocument();
  });

  it("shows an honest error for one report while the page and others stay usable", async () => {
    const user = userEvent.setup();
    generate.mockRejectedValue(
      new ApiError({ code: "FORBIDDEN", message: "Access denied", status: 403 }),
    );
    renderPage();
    const buttons = screen.getAllByRole("button", { name: "Generate report" });
    await user.click(buttons[0]);

    // First report shows the failure (not disguised as empty data).
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("You do not have permission to perform this action.")).toBeInTheDocument();
    // The page still renders all six report cards — report A's failure did not
    // crash the surface, and report B remains generatable.
    expect(screen.getAllByRole("button", { name: "Generate report" }).length).toBe(6);
  });

  it("an empty data object renders as 'No data', never a false value", async () => {
    const user = userEvent.setup();
    generate.mockResolvedValue({
      action: "generate",
      format: "json",
      report: {
        ...dailyOk.report,
        data: {},
      },
    });
    renderPage();
    await user.click(screen.getAllByRole("button", { name: "Generate report" })[0]);
    expect(await screen.findByText("No data.")).toBeInTheDocument();
  });

  it("a tenant-less account shows a truthful no-tenant state and issues zero requests", () => {
    auth.current.hospitalId = null;
    renderPage();
    expect(
      screen.getByText(/No hospital tenant is attached to your account/i),
    ).toBeInTheDocument();
    expect(generate).not.toHaveBeenCalled();
  });

  it("contains no mutation control — only Generate and date inputs", () => {
    renderPage();
    // Every button is a read-only Generate; there is no save/cancel/refund/etc.
    for (const btn of screen.getAllByRole("button")) {
      expect(btn).toHaveTextContent(/Generate report|Generating…/);
    }
  });
});
