import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type {
  AuditIntegrityResponse,
  AuditSearchResponseBody,
  DoctorOpsIntegrityResponse,
  IntegrationMatrixResponse,
  QueueIntegrityResponse,
  SettlementIntegrityResponse,
} from "@/types/api";
import type { BookingRow, HospitalDoctorOption } from "@/api/reads";

/**
 * The read-only Audit & Compliance viewer (Phase 7 G-05).
 *
 * Only the two boundaries are mocked: the enterprise-reports API wrapper
 * (its request shape is pinned in enterpriseReports.test.ts; live behavior
 * is proven by the backend's own real-HTTP suite) and the auth context plus
 * the RLS-readable tenant directories used to fill the targeted-check
 * pickers. The tests pin the required UX guarantees: real backend values
 * render, landing performs exactly ONE search (never a request per
 * keystroke), loading / empty / error are distinct, checks are run
 * explicitly and never auto-fire, an absent target disables the run, and
 * the surface contains no mutation or report-generation control.
 */
const call = vi.fn();

vi.mock("@/api/enterpriseReports", () => ({
  fetchAuditSearch: (h: string, f: unknown) => call("audit_search", h, f),
  fetchAuditIntegrity: (h: string) => call("audit_integrity", h),
  fetchSettlementIntegrity: (h: string) => call("settlement_integrity", h),
  fetchQueueIntegrity: (h: string, s: string) => call("queue_integrity", h, s),
  fetchDoctorOpsIntegrity: (h: string, d: string, date?: string) =>
    call("doctor_ops_integrity", h, d, date),
  fetchIntegrationMatrix: (h: string, date?: string) =>
    call("integration_matrix", h, date),
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

const listTodaysBookings = vi.fn();
const listHospitalDoctors = vi.fn();
vi.mock("@/api/reads", () => ({
  listTodaysBookings: (h: string, d: string) => listTodaysBookings(h, d),
  listHospitalDoctors: (h: string) => listHospitalDoctors(h),
}));

const { AdminAudit } = await import("@/routes/AdminAudit");

// ─── Fixtures: real shapes of the six read responses ─────────────────────────

const searchOk: AuditSearchResponseBody = {
  action: "audit_search",
  results: {
    hospital_id: "h-1",
    entries: [
      {
        id: "e-1",
        actor_user_id: "11111111-1111-4111-8111-111111111111",
        entity_type: "booking",
        entity_id: "22222222-2222-4222-8222-222222222222",
        action_type: "executive_report",
        action_severity: "low",
        metadata: { correlationId: "corr-42", check: "audit_search" },
        notes: "Report generated",
        created_at: "2026-09-29T09:30:00Z",
      },
      {
        id: "e-2",
        actor_user_id: null,
        entity_type: "audit_logs",
        entity_id: null,
        action_type: "compliance_check",
        action_severity: "critical",
        metadata: null,
        notes: null,
        created_at: "2026-09-28T08:00:00Z",
      },
    ],
  },
};

const auditIntegrityOk: AuditIntegrityResponse = {
  action: "audit_integrity",
  check: "audit_integrity",
  result: {
    ok: true,
    total_entries: 57,
    orphan_actors: 0,
    registered_action_types: 12,
    unknown_action_types: 0,
  },
};

const settlementIntegrityOk: SettlementIntegrityResponse = {
  action: "settlement_integrity",
  check: "settlement_integrity",
  result: { ok: false, settlements_checked: 3, mismatches: [] },
};

const queueIntegrityOk: QueueIntegrityResponse = {
  action: "queue_integrity",
  check: "queue_integrity",
  result: {
    ok: true,
    cross_hospital_bookings: 0,
    duplicate_tokens: 0,
    parallel_consultations: 0,
  },
};

const doctorOpsIntegrityOk: DoctorOpsIntegrityResponse = {
  action: "doctor_ops_integrity",
  check: "doctor_ops_integrity",
  result: { ok: true, timestamp_order_violations: 0, completed_without_timestamp: 0 },
};

const integrationMatrixOk: IntegrationMatrixResponse = {
  action: "integration_matrix",
  check: "integration_matrix",
  result: { ok: true, collections_without_booking: 0, ledger_without_source: 0 },
};

function resolveAll() {
  call.mockImplementation((action: string) => {
    switch (action) {
      case "audit_search":
        return Promise.resolve(searchOk);
      case "audit_integrity":
        return Promise.resolve(auditIntegrityOk);
      case "settlement_integrity":
        return Promise.resolve(settlementIntegrityOk);
      case "queue_integrity":
        return Promise.resolve(queueIntegrityOk);
      case "doctor_ops_integrity":
        return Promise.resolve(doctorOpsIntegrityOk);
      default:
        return Promise.resolve(integrationMatrixOk);
    }
  });
}

const SESSION_ID = "33333333-3333-4333-8333-333333333333";

function bookingStub(overrides: Partial<BookingRow>): BookingRow {
  return {
    id: "b-1",
    queue_session_id: SESSION_ID,
    token_number: 5,
    ...overrides,
  } as BookingRow;
}

const doctorStub: HospitalDoctorOption = {
  doctorId: "44444444-4444-4444-8444-444444444444",
  specialization: "Cardiology",
  consultationFee: 300,
  doctorName: "Dr Sen",
  label: "Dr Sen · Cardiology",
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/audit"]}>
      <Routes>
        <Route path="/admin/audit" element={<AdminAudit />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveAll();
  auth.current.hospitalId = "h-1";
  listTodaysBookings.mockResolvedValue([bookingStub({})]);
  listHospitalDoctors.mockResolvedValue([doctorStub]);
});

describe("AdminAudit landing and audit search", () => {
  it("loads real audit rows on landing and renders backend values verbatim", async () => {
    renderPage();

    expect(await screen.findByText("executive_report")).toBeInTheDocument();
    // Actor UUIDs are shown shortened; a NULL actor is honestly "system".
    expect(screen.getByText("11111111…")).toBeInTheDocument();
    expect(screen.getByText("system")).toBeInTheDocument();
    // Only the known correlationId string is surfaced from metadata.
    expect(screen.getByText("corr-42")).toBeInTheDocument();
    expect(screen.getByText("compliance_check")).toBeInTheDocument();
    // The metadata OBJECT must never be stringified into the DOM.
    expect(document.body.textContent).not.toMatch(/\[object Object\]/);
    expect(document.body.textContent).not.toMatch(/correlationId":/);
    // Notes null renders as the placeholder, never "null".
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/undefined/);
    expect(text).not.toMatch(/\bnull\b/);
  });

  it("performs exactly ONE landing search — typing a filter fires nothing", async () => {
    renderPage();
    await screen.findByText("executive_report");
    expect(call.mock.calls.filter((c) => c[0] === "audit_search")).toHaveLength(1);

    await userEvent.type(screen.getByLabelText("Entity type"), "booking");
    expect(call.mock.calls.filter((c) => c[0] === "audit_search")).toHaveLength(1);
  });

  it("sends the submitted filters with the backend default window made explicit", async () => {
    renderPage();
    await screen.findByText("executive_report");

    await userEvent.type(screen.getByLabelText("Entity type"), "booking");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));

    await screen.findByText("executive_report");
    const searches = call.mock.calls.filter((c) => c[0] === "audit_search");
    expect(searches).toHaveLength(2);
    expect(searches[1][2]).toEqual({
      entityType: "booking",
      fromTs: expect.any(String),
      toTs: expect.any(String),
    });
  });

  it("shows an empty result as a stated empty, not an error", async () => {
    call.mockImplementation((action: string) =>
      action === "audit_search"
        ? Promise.resolve({
            action: "audit_search",
            results: { hospital_id: "h-1", entries: [] },
          })
        : Promise.resolve(auditIntegrityOk),
    );
    renderPage();

    expect(
      await screen.findByText(/No audit entries match this window/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("surfaces a failed search as an error, never as an empty state", async () => {
    call.mockImplementation((action: string) =>
      action === "audit_search"
        ? Promise.reject(new Error("audit search failed"))
        : Promise.resolve(auditIntegrityOk),
    );
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "audit search failed",
    );
    expect(
      screen.queryByText(/No audit entries match this window/),
    ).toBeNull();
  });

  it("states the no-tenant condition without issuing any request", () => {
    auth.current.hospitalId = null;
    renderPage();

    expect(
      screen.getByText("No hospital tenant is attached to your account."),
    ).toBeInTheDocument();
    expect(call).not.toHaveBeenCalled();
  });
});

describe("AdminAudit compliance checks", () => {
  it("never auto-runs a check: every card starts idle with zero requests beyond the landing reads", async () => {
    renderPage();
    await screen.findByText("executive_report");

    expect(screen.getAllByText("Not run yet.")).toHaveLength(5);
    expect(call.mock.calls.map((c) => c[0])).toEqual(["audit_search"]);
  });

  it("runs the tenant-wide audit integrity check on demand and renders its verdict", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("executive_report");

    const buttons = screen.getAllByRole("button", { name: "Run check" });
    await user.click(buttons[0]); // Audit Integrity card

    expect(await screen.findByText("Verdict: intact")).toBeInTheDocument();
    expect(screen.getByText("Total entries").parentElement).toHaveTextContent(
      "57",
    );
    expect(screen.getByText("Orphan actors").parentElement).toHaveTextContent("0");
    const integrityCall = call.mock.calls.find((c) => c[0] === "audit_integrity");
    expect(integrityCall?.[1]).toBe("h-1");
  });

  it("renders a failing settlement verdict honestly as violations found", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("executive_report");

    const buttons = screen.getAllByRole("button", { name: "Run check" });
    await user.click(buttons[1]); // Settlement Reconciliation Verdict card

    expect(await screen.findByText("Verdict: violations found")).toBeInTheDocument();
    expect(screen.getByText("Settlements checked").parentElement).toHaveTextContent(
      "3",
    );
  });

  it("fills the queue-session picker from the tenant's RLS-readable bookings and passes the id through", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("executive_report");

    const select = (await screen.findByLabelText("Session")) as HTMLSelectElement;
    // The directory read lands after the landing search: wait for the picker
    // to leave "loading" before pinning its content.
    await waitFor(() => expect(select.disabled).toBe(false));
    // jsdom does not expose collapsed <option> text via toHaveDisplayValue;
    // the option element itself is the observable.
    expect(
      select.querySelector("option[value]:not([value=''])")?.textContent,
    ).toBe(`Token 5 · session ${SESSION_ID.slice(0, 8)}`);
    expect(select.value).toBe(SESSION_ID);

    const buttons = screen.getAllByRole("button", { name: "Run check" });
    await user.click(buttons[3]); // Queue Session Integrity card

    expect(await screen.findByText("Cross-hospital bookings")).toBeInTheDocument();
    const qCall = call.mock.calls.find((c) => c[0] === "queue_integrity");
    expect(qCall?.[1]).toBe("h-1");
    expect(qCall?.[2]).toBe(SESSION_ID);
  });

  it("disables a targeted check when its tenant has no queue session today", async () => {
    listTodaysBookings.mockResolvedValue([]);
    renderPage();
    await screen.findByText("executive_report");

    const select = (await screen.findByLabelText("Session")) as HTMLSelectElement;
    await waitFor(() =>
      expect(select.querySelector("option")?.textContent).toBe(
        "No queue sessions today",
      ),
    );
    expect(select).toBeDisabled();
    const buttons = screen.getAllByRole("button", { name: "Run check" });
    expect(buttons[3]).toBeDisabled();
    expect(
      call.mock.calls.find((c) => c[0] === "queue_integrity"),
    ).toBeUndefined();
  });

  it("labels the doctor picker from the tenant directory and forwards doctor + date", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("executive_report");

    const select = (await screen.findByLabelText("Doctor")) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(
      select.querySelector("option[value]:not([value=''])")?.textContent,
    ).toBe("Dr Sen · Cardiology");
    expect(select.value).toBe(doctorStub.doctorId);

    const buttons = screen.getAllByRole("button", { name: "Run check" });
    await user.click(buttons[4]); // Doctor Operations Integrity card

    expect(await screen.findByText("Timestamp order violations")).toBeInTheDocument();
    const dCall = call.mock.calls.find((c) => c[0] === "doctor_ops_integrity");
    expect(dCall?.[2]).toBe(doctorStub.doctorId);
    expect(dCall?.[3]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("surfaces a failed check as its own error without destroying the search section (partial failure)", async () => {
    const user = userEvent.setup();
    call.mockImplementation((action: string) =>
      action === "integration_matrix"
        ? Promise.reject(new Error("matrix read failed"))
        : action === "audit_search"
          ? Promise.resolve(searchOk)
          : Promise.resolve(auditIntegrityOk),
    );
    renderPage();
    await screen.findByText("executive_report");

    const buttons = screen.getAllByRole("button", { name: "Run check" });
    await user.click(buttons[2]); // Integration Matrix card

    expect(await screen.findByRole("alert")).toHaveTextContent("matrix read failed");
    // The independent audit trail still renders real rows.
    expect(screen.getByText("executive_report")).toBeInTheDocument();
  });
});

describe("AdminAudit read-only guarantee", () => {
  it("no wrapper call ever carries the generate action or a report type", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("executive_report");

    const buttons = screen.getAllByRole("button", { name: "Run check" });
    // Wait until both directory pickers are populated, so no targeted Run is
    // still disabled by a directory that has not landed yet.
    await waitFor(() =>
      expect((screen.getByLabelText("Session") as HTMLSelectElement).disabled).toBe(
        false,
      ),
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Doctor") as HTMLSelectElement).disabled).toBe(
        false,
      ),
    );
    for (const b of buttons) {
      await user.click(b);
    }
    expect((await screen.findAllByText("Verdict: intact")).length).toBeGreaterThan(0);

    expect(call.mock.calls.length).toBeGreaterThan(5);
    for (const c of call.mock.calls) {
      const body = JSON.stringify(c);
      expect(c[0]).not.toBe("generate");
      expect(body).not.toMatch(/reportType/);
      expect(body).not.toMatch(/financial/);
    }
  });

  it("is read-only: the only buttons are Search, Reset and the five Run checks", async () => {
    renderPage();
    await screen.findByText("executive_report");

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(7);
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Search",
      "Reset",
      "Run check",
      "Run check",
      "Run check",
      "Run check",
      "Run check",
    ]);
  });
});
