import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type {
  CommandCenterOverviewResponse,
  CommandCenterPredictiveResponse,
  CommandCenterSlaResponse,
  CommandCenterSystemHealthResponse,
  CommandCenterTimelineResponse,
} from "@/types/api";

/**
 * The read-only Command Centre surface (Phase 7 G-03).
 *
 * Only the two boundaries are mocked: the command-center API wrapper (its
 * request shape is pinned in commandCenter.test.ts; live behavior is proven
 * by the backend's own real-HTTP suite) and the auth context. The tests pin
 * the required UX guarantees: real backend values render, loading / empty /
 * error are distinct, a single section failure does not destroy the others,
 * string-vs-number NUMERIC serialisation is coerced safely, and the surface
 * contains no mutation control whatsoever.
 */
const overview = vi.fn();
const timeline = vi.fn();
const predictive = vi.fn();
const sla = vi.fn();
const systemHealth = vi.fn();

vi.mock("@/api/commandCenter", () => ({
  fetchCommandCenterOverview: (h: string) => overview(h),
  fetchCommandCenterTimeline: (h: string) => timeline(h),
  fetchCommandCenterPredictive: (h: string) => predictive(h),
  fetchCommandCenterSla: (h: string) => sla(h),
  fetchCommandCenterSystemHealth: (h: string) => systemHealth(h),
}));
vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({
    hospitalId: "h-1",
    staff: { fullName: "Ada Admin", role: "hospital_admin", hospitalId: "h-1" },
  }),
}));

const { AdminCommandCentre } = await import("@/routes/AdminCommandCentre");

// ─── Fixtures: real shapes of the five read responses ─────────────────────────

const overviewOk: CommandCenterOverviewResponse = {
  action: "overview",
  overview: {
    hospital_id: "h-1",
    date: "2026-09-28",
    patients: {
      total_today: 7,
      waiting: 2,
      called: 1,
      in_consultation: 1,
      completed: 3,
      cancelled: 0,
      no_shows: 1,
      skipped: 0,
      checked_in: 0,
      // PostgREST may deliver NUMERIC as a string — display must coerce.
      avg_wait_minutes: "12.5",
      avg_consultation_minutes: null,
    },
    queues: {
      active_sessions: 2,
      paused_queues: 1,
      delayed_doctors: 0,
      stalled_queues: 0,
      active_consultations: 1,
      doctor_availability: null,
    },
    sla: { status: "no_data" },
    finance: {
      revenue_today: "300",
      platform_fee_today: 30,
      refunds_today: 0,
      pending_payments: 2,
      outstanding_settlements: "0",
    },
    alert_activity: { recent_alerts_24h: 4 },
    generated_at: "2026-09-28T10:00:00Z",
  },
  scores: {
    hospital_id: "h-1",
    date: "2026-09-28",
    congestion_score: 40,
    delay_score: 0,
    risk_score: 30,
    health_score: 85,
    patient_experience_score: 70,
    inputs: {
      waiting: 2,
      capacity: 50,
      active_sessions: 2,
      delayed_sessions: 0,
      open_alerts_24h: 3,
      avg_wait_minutes: "12.5",
    },
  },
};

const timelineOk: CommandCenterTimelineResponse = {
  action: "timeline",
  timeline: {
    hospital_id: "h-1",
    from: "2026-09-27T10:00:00Z",
    to: "2026-09-28T10:00:00Z",
    events: [
      {
        ts: "2026-09-28T09:30:00Z",
        category: "alert",
        event_type: "sla_breach",
        severity: "warning",
        entity_type: "alert",
        entity_id: "a-1",
        doctor_id: null,
        queue_session_id: null,
        metadata: { message: "Wait exceeded threshold", current_value: 10 },
      },
      {
        ts: "2026-09-28T08:00:00Z",
        category: "booking",
        event_type: "created",
        severity: "info",
        entity_type: "booking",
        entity_id: "b-1",
        doctor_id: null,
        queue_session_id: null,
        metadata: null,
      },
    ],
  },
};

const slaOk: CommandCenterSlaResponse = {
  action: "sla_dashboard",
  sla: {
    date: "2026-09-28",
    summary: { tracked: 1, in_breach: 1, avg_breach_wait_minutes: "55.2" },
    hospitals_in_breach: [
      {
        hospital_id: "h-1",
        hospital_name: "General Hospital",
        avg_wait_minutes: 55.2,
        completion_rate_pct: "80.0",
        sla_wait_breached: true,
        sla_completion_breached: false,
      },
    ],
    trend_14d: [],
  },
};

const healthOk: CommandCenterSystemHealthResponse = {
  action: "system_health",
  health: {
    queueHealth: [
      {
        queue_type: "job_queue",
        pending_count: 5,
        processing_count: 1,
        failed_count: 0,
        dead_count: 0,
        oldest_pending_age: "0 days 00:12:00",
        avg_attempts: 1.2,
        throughput_last_hour: 42,
      },
    ],
    materializedViews: null,
    deadLetterQueue: [],
    openAlerts: 3,
  },
};

const predictiveOk: CommandCenterPredictiveResponse = {
  action: "predictive",
  predictions: {
    hospital_id: "h-1",
    date: "2026-09-28",
    queue_predictions: {
      waiting_now: 2,
      completed_now: 3,
      predicted_no_shows_today: "0.4",
      avg_consultation_minutes: 12,
      predicted_wait_next_minutes: "24.5",
      predicted_queue_exhaustion_minutes: "24",
    },
    financial_predictions: null,
  },
};

function resolveAll() {
  overview.mockResolvedValue(overviewOk);
  timeline.mockResolvedValue(timelineOk);
  predictive.mockResolvedValue(predictiveOk);
  sla.mockResolvedValue(slaOk);
  systemHealth.mockResolvedValue(healthOk);
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin"]}>
      <Routes>
        <Route path="/admin" element={<AdminCommandCentre />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveAll();
});

describe("AdminCommandCentre rendering", () => {
  it("renders actual overview values, coercing string-serialised numerics", async () => {
    renderPage();

    const heading = await screen.findByText("Bookings today");
    expect(heading.parentElement).toHaveTextContent("7");
    expect(screen.getByText("Waiting").parentElement).toHaveTextContent("2");
    // "12.5" (string) must appear coerced, never with quotes or NaN.
    expect(screen.getByText("Avg wait (min)").parentElement).toHaveTextContent("12.5");
    // A null backend value renders as the em-dash placeholder, never "null".
    expect(screen.getByText("Avg consultation (min)").parentElement).toHaveTextContent("—");
    // Scores are the backend's own numbers.
    expect(screen.getByText("Health score").parentElement).toHaveTextContent("85");
  });

  it("renders timeline events with severity and only string metadata messages", async () => {
    renderPage();

    expect(await screen.findByText("sla_breach")).toBeInTheDocument();
    expect(
      screen.getByText("Wait exceeded threshold"),
    ).toBeInTheDocument();
    expect(screen.getByText("created")).toBeInTheDocument();
    // The metadata OBJECT must never be stringified into the DOM.
    expect(document.body.textContent).not.toMatch(/\[object Object\]/);
    expect(document.body.textContent).not.toMatch(/current_value/);
  });

  it("renders the SLA dashboard from backend values", async () => {
    renderPage();

    expect(await screen.findByText("General Hospital")).toBeInTheDocument();
    expect(screen.getByText("Tracked").parentElement).toHaveTextContent("1");
    expect(screen.getByText("In breach").parentElement).toHaveTextContent("1");
    // Empty trend array is a stated empty, not an error.
    expect(screen.getByText("No trend data available.")).toBeInTheDocument();
  });

  it("renders system health and marks un-reported components honestly", async () => {
    renderPage();

    expect(await screen.findByText("job_queue")).toBeInTheDocument();
    expect(screen.getByText("Open alerts").parentElement).toHaveTextContent("3");
    // materializedViews came back null: omit-with-explanation, not zeroes.
    expect(screen.getByText("Materialized views")).toBeInTheDocument();
    expect(screen.getAllByText("Not reported.").length).toBeGreaterThan(0);
    // Empty DLQ is its own honest empty state.
    expect(screen.getByText("DLQ is empty.")).toBeInTheDocument();
  });

  it("renders backend predictions without inventing anything", async () => {
    renderPage();

    expect(
      await screen.findByText("Predicted no-shows today"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Predicted no-shows today").parentElement,
    ).toHaveTextContent("0.4");
    // financial_predictions was null: state absence, show no figures.
    expect(screen.getByText("No financial predictions returned.")).toBeInTheDocument();
  });

  it("shows loading placeholders before any read settles — never fake zeroes", () => {
    overview.mockReturnValue(new Promise(() => {}));
    timeline.mockReturnValue(new Promise(() => {}));
    predictive.mockReturnValue(new Promise(() => {}));
    sla.mockReturnValue(new Promise(() => {}));
    systemHealth.mockReturnValue(new Promise(() => {}));

    renderPage();

    expect(screen.getAllByText("Loading…").length).toBe(5);
  });

  it("surfaces a failed read as an error, never as an empty state", async () => {
    overview.mockRejectedValue(new Error("aggregation unavailable"));
    renderPage();

    const alerts = await screen.findAllByRole("alert");
    expect(alerts[0]).toHaveTextContent("aggregation unavailable");
    expect(screen.queryByText("No queue sessions today.")).toBeNull();
  });

  it("keeps healthy sections rendering when one section fails (partial failure)", async () => {
    sla.mockRejectedValue(new Error("sla read failed"));
    renderPage();

    // The failed section shows its own error…
    expect(await screen.findByRole("alert")).toHaveTextContent("sla read failed");
    // …while an independent section still renders real data.
    expect(await screen.findByText("Bookings today")).toBeInTheDocument();
    expect(screen.getByText("job_queue")).toBeInTheDocument();
  });

  it("re-queries every section on manual refresh and stamps a real fetch time", async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText("Bookings today");
    expect(overview).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Bookings today");
    expect(overview).toHaveBeenCalledTimes(2);
    expect(timeline).toHaveBeenCalledTimes(2);

    // The freshness claim is an actual timestamp, present only after a round.
    expect(screen.getByTestId("last-updated").textContent).toMatch(
      /Last updated \d/,
    );
  });

  it("does not stamp a last-updated time when every read failed", async () => {
    const boom = Promise.reject(new Error("down"));
    overview.mockReturnValue(boom);
    timeline.mockReturnValue(boom);
    predictive.mockReturnValue(boom);
    sla.mockReturnValue(boom);
    systemHealth.mockReturnValue(boom);
    renderPage();

    await screen.findAllByRole("alert");
    expect(screen.getByTestId("last-updated")).toHaveTextContent("Not yet fetched");
  });

  it("is read-only: the only control on the surface is Refresh", async () => {
    renderPage();
    await screen.findByText("Bookings today");

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent("Refresh");

    for (const label of [
      "Broadcast",
      "Cancel",
      "Retry job",
      "Refund",
      "Check in",
      "Reschedule",
      "Resolve alert",
    ]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
  });

  it("never leaks undefined / null / [object Object] into rendered text", async () => {
    renderPage();
    await screen.findByText("Bookings today");

    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/undefined/);
    expect(text).not.toMatch(/\[object/);
    expect(text).not.toMatch(/\bnull\b/);
  });
});
