import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ApiError } from "@/lib/errors";
import type {
  AlertAnalyticsResponseBody,
  AlertEventRow,
  AlertListResponseBody,
} from "@/types/api";

/**
 * The read-only Alert-Center surface (Phase 7 G-10).
 *
 * Mocked boundaries: the two `alert-center` read wrappers (their exact request
 * shape and tenant-in-header-only are pinned in `alertCenter.test.ts`; live
 * transport, the role gate, cross-tenant isolation and the service-role-only
 * RPC boundary are all proven by the backend real-HTTP suite
 * `alert_center_http.test.ts`) and the auth context. These tests pin the PAGE's
 * own guarantees:
 *
 *  - exactly one read per action per explicit load and NO polling or remount
 *    double-fire; a single manual Refresh is the only other trigger;
 *  - the server's counts and analytics render verbatim — the page shows the
 *    server's own whole-tenant `open` count even though it does not equal the
 *    number of returned rows (proof there is no client-side counting, §16);
 *  - a NULL / empty read says "no data" honestly and an error is an error,
 *    never a fabricated zero or empty success (§18);
 *  - mutation controls render ONLY for hospital_admin / global_admin, are
 *    hidden from receptionist / doctor, and every attempt re-reads the server
 *    (reconcile) rather than trusting optimistic local state (§9/§11);
 *  - a tenant-less global admin reuses the G-08 acting-context exactly once and
 *    discloses the scope, while an unresolved context waits honestly issuing zero
 *    alert-center requests.
 */
const centerCall = vi.fn();
const analyticsCall = vi.fn();
const actingCall = vi.fn();
const ackCall = vi.fn();
const resolveCall = vi.fn();
const escalateCall = vi.fn();
const suppressCall = vi.fn();
vi.mock("@/api/alertCenter", () => ({
  fetchAlertCenter: (h: string, o?: unknown) => centerCall(h, o),
  fetchAlertAnalytics: (h: string, o?: unknown) => analyticsCall(h, o),
  acknowledgeAlert: (...a: unknown[]) => ackCall(...a),
  resolveAlert: (...a: unknown[]) => resolveCall(...a),
  escalateAlert: (...a: unknown[]) => escalateCall(...a),
  suppressAlert: (...a: unknown[]) => suppressCall(...a),
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

const { AdminAlerts } = await import("@/routes/AdminAlerts");

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/alerts"]}>
      <Routes>
        <Route path="/admin/alerts" element={<AdminAlerts />} />
      </Routes>
    </MemoryRouter>,
  );
}

function row(over: Partial<AlertEventRow>): AlertEventRow {
  return {
    id: crypto.randomUUID(),
    hospital_id: "h-1",
    alert_key: "queue_backlog_pending",
    alert_category: "queue",
    severity: "warning",
    current_value: 55,
    threshold_value: 50,
    message: "Pending jobs above threshold",
    is_resolved: false,
    acknowledged_at: null,
    assigned_to: null,
    escalated_at: null,
    created_at: "2026-09-30T10:00:00+00:00",
    resolved_at: null,
    ...over,
  };
}

// The server `open` count (7) is deliberately UNRELATED to the number of
// returned rows (2), so rendering 7 proves the page never counts rows itself.
const listOk: AlertListResponseBody = {
  action: "list",
  center: {
    alerts: [
      row({}),
      row({
        alert_key: "dlq_unresolved_critical",
        severity: "critical",
        message: "Dead-letter backlog",
        escalated_at: "2026-09-30T11:00:00+00:00",
      }),
    ],
    counts: { open: 7, acknowledged: 3, escalated: 1, critical_open: 2 },
  },
};

const analyticsOk: AlertAnalyticsResponseBody = {
  action: "analytics",
  analytics: {
    summary: { total: 12, resolved: 5, avg_resolution_minutes: 42.5 },
    by_alert_key: [
      {
        alert_key: "queue_backlog_pending",
        total: 12,
        resolved: 5,
        avg_resolution_minutes: 42.5,
      },
    ],
  },
};

beforeEach(() => {
  centerCall.mockReset().mockResolvedValue(listOk);
  analyticsCall.mockReset().mockResolvedValue(analyticsOk);
  actingCall.mockReset().mockResolvedValue(null);
  ackCall
    .mockReset()
    .mockResolvedValue({ action: "acknowledge", alertId: "x", result: { ok: true } });
  resolveCall
    .mockReset()
    .mockResolvedValue({ action: "resolve", alertId: "x", result: { ok: true } });
  escalateCall
    .mockReset()
    .mockResolvedValue({ action: "escalate", alertId: "x", result: { ok: true } });
  suppressCall
    .mockReset()
    .mockResolvedValue({ action: "suppress", result: { ok: true, suppression_id: "s-1" } });
  auth.current.role = "hospital_admin";
  auth.current.hospitalId = "h-1";
});

describe("AdminAlerts surface", () => {
  it("loads both read actions once on mount with the session tenant", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Alert Inbox")).toBeInTheDocument());
    expect(centerCall).toHaveBeenCalledTimes(1);
    expect(analyticsCall).toHaveBeenCalledTimes(1);
    expect(centerCall.mock.calls[0][0]).toBe("h-1");
    // A session that already carries a tenant never pays for a context read.
    expect(actingCall).not.toHaveBeenCalled();
    expect(screen.getByText("h-1")).toBeInTheDocument();
    expect(screen.getByText(/taken from your session/i)).toBeInTheDocument();
  });

  it("shows an explicit loading state for both sections before the reads land", () => {
    centerCall.mockReturnValue(new Promise(() => {}));
    analyticsCall.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByText("Loading alerts…")).toBeInTheDocument();
    expect(screen.getByText("Loading analytics…")).toBeInTheDocument();
  });

  it("renders the server counts, the rows and the analytics", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Alert Analytics")).toBeInTheDocument());

    expect(screen.getByText("Alert Inbox")).toBeInTheDocument();
    // The rows themselves.
    expect(screen.getByText("Pending jobs above threshold")).toBeInTheDocument();
    expect(screen.getByText("Dead-letter backlog")).toBeInTheDocument();
    // The by-key analytics table. `queue_backlog_pending` also appears as a row
    // key in the list table, so assert on presence rather than a single match.
    expect(screen.getAllByText("queue_backlog_pending").length)
      .toBeGreaterThanOrEqual(1);
    expect(screen.getByText("dlq_unresolved_critical")).toBeInTheDocument();
  });

  it("renders the server's whole-tenant open count, never a row count", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Alert Inbox")).toBeInTheDocument());
    // 7 comes ONLY from `counts.open`; the two returned rows can never produce
    // it, so its presence proves no `alerts.length` counting in the browser.
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument(); // acknowledged
    // The summary total (12) and resolved (5) are the server's, not derived.
    // Each value appears in BOTH the summary tiles and the by-key row, so the
    // assertion is on their presence, never a client-side recompute.
    expect(screen.getAllByText("12").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("5").length).toBeGreaterThanOrEqual(1);
  });

  it("keeps a real 0 as 0 and renders an absent analytics average as a dash", async () => {
    analyticsCall.mockResolvedValue({
      action: "analytics",
      analytics: {
        summary: { total: 0, resolved: 0, avg_resolution_minutes: null },
        by_alert_key: [],
      },
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("Alert Analytics")).toBeInTheDocument());
    // Zero counts stay "0", never "—"; a NULL average is an honest dash.
    expect(screen.getAllByText("0").length).toBeGreaterThan(0);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText(/no alerts in this window/i)).toBeInTheDocument();
  });

  it("says so when the alert list is legitimately empty, without inventing rows", async () => {
    centerCall.mockResolvedValue({
      action: "list",
      center: {
        alerts: [],
        counts: { open: 0, acknowledged: 0, escalated: 0, critical_open: 0 },
      },
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("No alerts found.")).toBeInTheDocument(),
    );
    // The other section is unaffected.
    expect(screen.getByText("queue_backlog_pending")).toBeInTheDocument();
  });

  it("shows a failed section as an error while the other still renders", async () => {
    analyticsCall.mockRejectedValue(
      new ApiError({ code: "INTERNAL", message: "analytics failed", status: 500 }),
    );
    renderPage();
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
    expect(screen.getByText(/server could not complete/i)).toBeInTheDocument();
    expect(screen.getByText("Alert Inbox")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("never dresses a role denial up as an empty dashboard", async () => {
    centerCall.mockRejectedValue(
      new ApiError({ code: "ROLE_INSUFFICIENT", message: "no", status: 403 }),
    );
    renderPage();
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
    expect(screen.getByText(/do not have permission/i)).toBeInTheDocument();
    expect(screen.queryByText("No alerts found.")).toBeNull();
  });

  it("renders mutation controls for admins and hides them from non-admins", async () => {
    // hospital_admin sees the full mutation affordance set.
    renderPage();
    await waitFor(() => expect(screen.getByText("Alert Inbox")).toBeInTheDocument());
    expect(
      screen.getByRole("button", { name: /Acknowledge alert queue_backlog_pending/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Resolve alert queue_backlog_pending/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Escalate alert queue_backlog_pending/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Suppress alerts for key queue_backlog_pending/ }),
    ).toBeInTheDocument();
  });

  it("offers no per-field action the server already recorded (D1 fields)", async () => {
    // The second row is already escalated → no Escalate control for it, but the
    // independent acknowledge / resolve controls remain (D1: fields independent).
    renderPage();
    await waitFor(() => expect(screen.getByText("Alert Inbox")).toBeInTheDocument());
    expect(
      screen.queryByRole("button", { name: /Escalate alert dlq_unresolved_critical/ }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: /Acknowledge alert dlq_unresolved_critical/ }),
    ).toBeInTheDocument();
  });

  it("polls nothing, and a single Refresh issues exactly one more bounded cycle", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Alert Inbox")).toBeInTheDocument());
    expect(centerCall).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 150));
    expect(centerCall).toHaveBeenCalledTimes(1);
    expect(analyticsCall).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(centerCall).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 150));
    expect(centerCall).toHaveBeenCalledTimes(2);
    expect(analyticsCall).toHaveBeenCalledTimes(2);
  });

  it("resolves the acting context once for a tenant-less global admin and discloses it", async () => {
    auth.current.role = "global_admin";
    auth.current.hospitalId = null;
    actingCall.mockResolvedValue({ hospitalId: "ctx-9", hospitalName: "Context Hospital" });
    renderPage();

    await waitFor(() => expect(screen.getByText("Alert Inbox")).toBeInTheDocument());
    expect(actingCall).toHaveBeenCalledTimes(1);
    expect(centerCall.mock.calls[0][0]).toBe("ctx-9");
    expect(screen.getByText("ctx-9")).toBeInTheDocument();
    expect(
      screen.getByText(/your account has no hospital of its own/i),
    ).toBeInTheDocument();

    await new Promise((r) => setTimeout(r, 150));
    expect(centerCall).toHaveBeenCalledTimes(1);
    expect(actingCall).toHaveBeenCalledTimes(1);
  });

  it("waits honestly and issues zero alert requests while the context is unresolved", () => {
    auth.current.role = "global_admin";
    auth.current.hospitalId = null;
    actingCall.mockReturnValue(new Promise(() => {}));
    renderPage();

    expect(screen.getByText(/waiting for the hospital context/i)).toBeInTheDocument();
    expect(centerCall).not.toHaveBeenCalled();
    expect(analyticsCall).not.toHaveBeenCalled();
    expect(screen.queryByText("Loading alerts…")).toBeNull();
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
    expect(centerCall).not.toHaveBeenCalled();
  });
});

// The row keys are fixed in `listOk`, so the admin affordance is addressed by
// the alert key that appears in each button's accessible name.
const ROW_A_KEY = "queue_backlog_pending";
const ROW_A_ID = listOk.center.alerts[0].id;

function ackBtn() {
  return screen.getByRole("button", {
    name: new RegExp(`Acknowledge alert ${ROW_A_KEY}`),
  });
}

describe("AdminAlerts lifecycle mutations", () => {
  it("acknowledges through the wrapper and reconciles the server (no optimistic state)", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Alert Inbox")).toBeInTheDocument());
    expect(centerCall).toHaveBeenCalledTimes(1);

    await userEvent.click(ackBtn());

    // Exact payload: the acting tenant first, the row id second — never a
    // hospital id buried in the body (that is the wrapper's job, pinned in
    // alertCenter.test.ts).
    expect(ackCall).toHaveBeenCalledWith("h-1", ROW_A_ID);
    // Server-authoritative: the read is re-run after the attempt (§11).
    await waitFor(() => expect(centerCall).toHaveBeenCalledTimes(2));
    expect(analyticsCall).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Alert acknowledged/i)).toBeInTheDocument();
  });

  it("treats an already_acknowledged replay as success, not an error", async () => {
    ackCall.mockResolvedValue({
      action: "acknowledge",
      alertId: ROW_A_ID,
      result: { ok: true, already_acknowledged: true },
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("Alert Inbox")).toBeInTheDocument());

    await userEvent.click(ackBtn());

    expect(
      screen.getByText(/already acknowledged\. Refreshing the latest state/i),
    ).toBeInTheDocument();
    // No retry fired, and no destructive error banner appeared.
    expect(ackCall).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/do not have permission/i)).toBeNull();
  });

  it("swallows a duplicate acknowledge click while the request is in flight", async () => {
    ackCall.mockReturnValue(new Promise(() => {})); // never settles
    renderPage();
    await waitFor(() => expect(screen.getByText("Alert Inbox")).toBeInTheDocument());

    const btn = ackBtn();
    fireEvent.click(btn);
    fireEvent.click(btn);

    expect(ackCall).toHaveBeenCalledTimes(1);
  });

  it("resolves with notes and omits them when blank", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Alert Inbox")).toBeInTheDocument());

    await userEvent.click(
      screen.getByRole("button", { name: new RegExp(`^Resolve alert ${ROW_A_KEY}`) }),
    );
    await userEvent.type(screen.getByLabelText(/Notes \(optional\)/), "fixed it");
    await userEvent.click(screen.getByRole("button", { name: /Confirm resolve/ }));

    expect(resolveCall).toHaveBeenCalledWith("h-1", ROW_A_ID, "fixed it");
    await waitFor(() => expect(centerCall).toHaveBeenCalledTimes(2));
  });

  it("validates resolve notes against the 1000-char backend bound and blocks submit", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Alert Inbox")).toBeInTheDocument());

    await userEvent.click(
      screen.getByRole("button", { name: new RegExp(`^Resolve alert ${ROW_A_KEY}`) }),
    );
    const box = screen.getByLabelText(/Notes \(optional\)/) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "a".repeat(1001) } });

    expect(screen.getByText(/at most 1000 characters/i)).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: /Confirm resolve/ });
    expect(confirm).toBeDisabled();
    await userEvent.click(confirm);
    expect(resolveCall).not.toHaveBeenCalled();
  });

  it("escalates through the wrapper", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Alert Inbox")).toBeInTheDocument());

    await userEvent.click(
      screen.getByRole("button", { name: new RegExp(`Escalate alert ${ROW_A_KEY}`) }),
    );
    await userEvent.click(screen.getByRole("button", { name: /Confirm escalate/ }));

    // Blank notes are omitted (undefined), never sent as empty string.
    expect(escalateCall).toHaveBeenCalledWith("h-1", ROW_A_ID, undefined);
    await waitFor(() => expect(centerCall).toHaveBeenCalledTimes(2));
  });

  it("suppresses a key window with a deliberate confirm and no hospital in the payload", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Alert Inbox")).toBeInTheDocument());

    await userEvent.click(
      screen.getByRole("button", {
        name: new RegExp(`Suppress alerts for key ${ROW_A_KEY}`),
      }),
    );
    // The key is prefilled from the row and the confirm is inert until a
    // future window is chosen (§14).
    expect(screen.getByLabelText(/Alert key/)).toHaveValue(ROW_A_KEY);
    expect(screen.getByRole("button", { name: /Confirm suppression/ })).toBeDisabled();

    const until = "2099-01-01T00:00";
    fireEvent.change(screen.getByLabelText(/Suppress until/), {
      target: { value: until },
    });
    await userEvent.click(screen.getByRole("button", { name: /Confirm suppression/ }));

    expect(suppressCall).toHaveBeenCalledWith("h-1", {
      alertKey: ROW_A_KEY,
      activeUntil: new Date(until).toISOString(),
    });
    await waitFor(() => expect(centerCall).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/Suppression window opened/i)).toBeInTheDocument();
  });

  it("refuses a non-future suppression window", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Alert Inbox")).toBeInTheDocument());

    await userEvent.click(
      screen.getByRole("button", {
        name: new RegExp(`Suppress alerts for key ${ROW_A_KEY}`),
      }),
    );
    fireEvent.change(screen.getByLabelText(/Suppress until/), {
      target: { value: "2000-01-01T00:00" },
    });

    expect(screen.getByText(/must be for a future time/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Confirm suppression/ })).toBeDisabled();
  });

  it("never auto-retries a rejected suppression", async () => {
    suppressCall.mockRejectedValue(
      new ApiError({ code: "VALIDATION", message: "invalid_window", status: 422 }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("Alert Inbox")).toBeInTheDocument());

    await userEvent.click(
      screen.getByRole("button", {
        name: new RegExp(`Suppress alerts for key ${ROW_A_KEY}`),
      }),
    );
    fireEvent.change(screen.getByLabelText(/Suppress until/), {
      target: { value: "2099-01-01T00:00" },
    });
    await userEvent.click(screen.getByRole("button", { name: /Confirm suppression/ }));

    expect(suppressCall).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("maps server errors honestly and never leaks raw detail", async () => {
    const cases: [number, string, RegExp][] = [
      [401, "UNAUTHORIZED", /session expired/i],
      [403, "FORBIDDEN", /do not have permission/i],
      [500, "INTERNAL", /server could not complete/i],
    ];
    for (const [status, code, expected] of cases) {
      ackCall.mockReset().mockRejectedValue(
        new ApiError({ code, message: "secret sql detail", status }),
      );
      const view = renderPage();
      await waitFor(() => expect(screen.getByText("Alert Inbox")).toBeInTheDocument());
      await userEvent.click(ackBtn());
      const banner = await screen.findByRole("alert");
      expect(banner).toHaveTextContent(expected);
      // The raw backend message never reaches the user.
      expect(banner.textContent).not.toMatch(/secret sql detail/i);
      view.unmount();
    }
  });

  it("runs the mutation against the acting-hospital tenant for a global admin", async () => {
    auth.current.role = "global_admin";
    auth.current.hospitalId = null;
    actingCall.mockResolvedValue({ hospitalId: "ctx-9", hospitalName: "Context" });
    renderPage();
    await waitFor(() => expect(screen.getByText("Alert Inbox")).toBeInTheDocument());

    await userEvent.click(ackBtn());
    expect(ackCall).toHaveBeenCalledWith("ctx-9", ROW_A_ID);
  });

  it("hides every mutation control from receptionist and doctor", async () => {
    for (const role of ["receptionist", "doctor"]) {
      auth.current.role = role;
      const view = renderPage();
      await waitFor(() => expect(screen.getByText("Alert Inbox")).toBeInTheDocument());
      expect(screen.queryByText("Actions")).toBeNull();
      expect(
        screen.queryByRole("button", { name: /Acknowledge alert/ }),
      ).toBeNull();
      view.unmount();
    }
  });
});
