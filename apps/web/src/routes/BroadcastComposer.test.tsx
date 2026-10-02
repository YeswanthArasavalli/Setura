import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ApiError } from "@/lib/errors";
import { validateBroadcast, type BroadcastType } from "@/routes/BroadcastComposer";
import type {
  AlertListResponseBody,
  CommandCenterBroadcastResponse,
} from "@/types/api";

/**
 * C2b Broadcast Composer page guarantees.
 *
 * The transport + exact request-body shape (tenant in header only, optional
 * fields omitted, deterministic backend idempotency so no client key) are pinned
 * in `commandCenter.test.ts` and the real-HTTP backend suite. These tests pin
 * what ONLY the page owns: the compose → preview → confirm → queued flow, the
 * role visibility, client-side validation of the exact backend limits, the
 * honest queued-not-delivered outcome wording, single in-flight submit, error
 * surfacing, and that no recipient/phone ever leaves the composer.
 */

const bq = vi.fn();
const bd = vi.fn();
const bc = vi.fn();
const ban = vi.fn();
const ba = vi.fn();
vi.mock("@/api/commandCenter", () => ({
  broadcastQueueSummary: (...a: unknown[]) => bq(...a),
  broadcastDoctorDelay: (...a: unknown[]) => bd(...a),
  broadcastClosure: (...a: unknown[]) => bc(...a),
  broadcastAdminNotice: (...a: unknown[]) => ban(...a),
  broadcastAlert: (...a: unknown[]) => ba(...a),
}));

const bookingsCall = vi.fn();
const doctorNamesCall = vi.fn();
vi.mock("@/api/reads", () => ({
  listTodaysBookings: (...a: unknown[]) => bookingsCall(...a),
  listDoctorNames: (...a: unknown[]) => doctorNamesCall(...a),
}));

const alertCenterCall = vi.fn();
vi.mock("@/api/alertCenter", () => ({
  fetchAlertCenter: (...a: unknown[]) => alertCenterCall(...a),
}));

const actingCall = vi.fn();
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

const { BroadcastComposer } = await import("@/routes/BroadcastComposer");

function ok(
  enqueued = 1,
  kind = "queue_summary",
): CommandCenterBroadcastResponse {
  return { action: "broadcast_queue_summary", broadcast: { kind, enqueued } };
}

const emptyAlertList: AlertListResponseBody = {
  action: "list",
  center: {
    alerts: [],
    counts: { open: 0, acknowledged: 0, escalated: 0, critical_open: 0 },
  },
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/broadcast"]}>
      <Routes>
        <Route path="/admin/broadcast" element={<BroadcastComposer />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.current = { role: "hospital_admin", hospitalId: "h-1" };
  // Default context: no active sessions, no open alerts; both reads resolve.
  bookingsCall.mockResolvedValue([]);
  doctorNamesCall.mockResolvedValue(new Map());
  alertCenterCall.mockResolvedValue(emptyAlertList);
  actingCall.mockResolvedValue(null);
  for (const fn of [bq, bd, bc, ban, ba]) fn.mockResolvedValue(ok());
});

describe("authorization visibility", () => {
  it("renders the composer for hospital_admin", () => {
    renderPage();
    expect(screen.getByTestId("type-queue_summary")).toBeInTheDocument();
  });

  it("renders the composer for global_admin", async () => {
    auth.current = { role: "global_admin", hospitalId: "h-1" };
    renderPage();
    expect(screen.getByTestId("type-queue_summary")).toBeInTheDocument();
  });

  it("denies the composer to a receptionist and sends nothing", () => {
    auth.current = { role: "receptionist", hospitalId: "h-1" };
    renderPage();
    expect(screen.queryByTestId("type-queue_summary")).toBeNull();
    expect(screen.getByText(/restricted to hospital and global administrators/i))
      .toBeInTheDocument();
    expect(bq).not.toHaveBeenCalled();
  });

  it("denies the composer to a doctor", () => {
    auth.current = { role: "doctor", hospitalId: "h-1" };
    renderPage();
    expect(screen.queryByTestId("to-preview")).toBeNull();
  });
});

describe("compose fields per broadcast type", () => {
  it("queue update shows a session picker and no message box", async () => {
    bookingsCall.mockResolvedValue([
      { queue_session_id: "sess-9", assigned_doctor_id: null },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("bc-session")).toBeInTheDocument());
    expect(screen.queryByTestId("bc-message")).toBeNull();
  });

  it("doctor delay shows minutes + reason", async () => {
    renderPage();
    await userEvent.click(screen.getByTestId("type-doctor_delay"));
    expect(screen.getByTestId("bc-delay")).toBeInTheDocument();
    expect(screen.getByTestId("bc-reason")).toBeInTheDocument();
  });

  it("admin notice shows the category picker and message box", async () => {
    renderPage();
    await userEvent.click(screen.getByTestId("type-admin_notice"));
    expect(screen.getByTestId("bc-kind")).toBeInTheDocument();
    expect(screen.getByTestId("bc-message")).toBeInTheDocument();
  });

  it("closure requires no session (backend resolves the audience)", async () => {
    renderPage();
    await userEvent.click(screen.getByTestId("type-closure"));
    expect(screen.queryByTestId("bc-session")).toBeNull();
    expect(screen.getByTestId("bc-date")).toBeInTheDocument();
  });
});

describe("client validation blocks review", () => {
  it("queue update without a session shows a field error and stays on compose", async () => {
    renderPage();
    await userEvent.click(screen.getByTestId("to-preview"));
    expect(screen.getByTestId("field-error")).toBeInTheDocument();
    expect(screen.queryByTestId("confirm-queue")).toBeNull();
  });

  it("admin notice without a message is rejected", async () => {
    renderPage();
    await userEvent.click(screen.getByTestId("type-admin_notice"));
    await userEvent.selectOptions(screen.getByTestId("bc-kind"), "congestion");
    await userEvent.click(screen.getByTestId("to-preview"));
    expect(screen.getByText(/enter the notice message/i)).toBeInTheDocument();
    expect(screen.queryByTestId("confirm-queue")).toBeNull();
  });

  it("doctor delay with a blank session is rejected even with valid minutes", async () => {
    renderPage();
    await userEvent.click(screen.getByTestId("type-doctor_delay"));
    await userEvent.type(screen.getByTestId("bc-delay"), "20");
    await userEvent.click(screen.getByTestId("to-preview"));
    expect(screen.getByText(/select the queue session/i)).toBeInTheDocument();
  });
});

describe("validateBroadcast mirrors the exact backend limits", () => {
  const base = {
    queueSessionId: "s-1",
    delayMinutes: "15",
    reason: "",
    closureDate: "",
    noticeKind: "" as const,
    message: "",
    alertId: "",
  };

  it("accepts a bounded doctor delay and rejects out-of-range values", () => {
    expect(
      validateBroadcast("doctor_delay" as BroadcastType, {
        ...base,
        noticeKind: "",
      }),
    ).toEqual({});
    for (const bad of ["0", "1441", "-5", "abc", "12.5", ""]) {
      expect(
        Object.keys(
          validateBroadcast("doctor_delay" as BroadcastType, {
            ...base,
            delayMinutes: bad,
          }),
        ),
      ).toContain("delayMinutes");
    }
  });

  it("rejects an admin notice message over 500 chars", () => {
    const errors = validateBroadcast("admin_notice" as BroadcastType, {
      ...base,
      noticeKind: "congestion",
      message: "x".repeat(501),
    });
    expect(Object.keys(errors)).toContain("message");
  });

  it("requires an alert selection for the alert broadcast", () => {
    expect(
      validateBroadcast("alert" as BroadcastType, base),
    ).toHaveProperty("alertId");
  });
});

describe("preview → confirm → queued", () => {
  it("shows type, recipient scope and no invented count on the preview", async () => {
    bookingsCall.mockResolvedValue([
      {
        queue_session_id: "sess-9",
        assigned_doctor_id: "doc-1",
      },
    ]);
    doctorNamesCall.mockResolvedValue(new Map([["doc-1", "Dr. Rao"]]));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("bc-session")).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByTestId("bc-session"), "sess-9");
    await userEvent.click(screen.getByTestId("to-preview"));

    expect(screen.getByTestId("confirm-queue")).toBeInTheDocument();
    // Recipient scope is described, and no "sending to N" count is fabricated.
    expect(screen.getByText(/every patient currently active/i)).toBeInTheDocument();
    expect(screen.queryByText(/sending to \d+/i)).toBeNull();
  });

  it("queues a queue-summary with the exact tenant + session", async () => {
    bookingsCall.mockResolvedValue([
      { queue_session_id: "sess-9", assigned_doctor_id: null },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("bc-session")).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByTestId("bc-session"), "sess-9");
    await userEvent.click(screen.getByTestId("to-preview"));
    await userEvent.click(screen.getByTestId("confirm-queue"));

    await waitFor(() => expect(bq).toHaveBeenCalledWith("h-1", "sess-9"));
    expect(screen.getByTestId("queued-badge")).toHaveTextContent(
      /broadcast queued/i,
    );
  });

  it("omits a blank reason for doctor delay and sends minutes", async () => {
    bookingsCall.mockResolvedValue([
      { queue_session_id: "sess-9", assigned_doctor_id: null },
    ]);
    renderPage();
    await userEvent.click(screen.getByTestId("type-doctor_delay"));
    await waitFor(() => expect(screen.getByTestId("bc-session")).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByTestId("bc-session"), "sess-9");
    await userEvent.type(screen.getByTestId("bc-delay"), "20");
    await userEvent.click(screen.getByTestId("to-preview"));
    await userEvent.click(screen.getByTestId("confirm-queue"));

    await waitFor(() =>
      expect(bd).toHaveBeenCalledWith("h-1", {
        queueSessionId: "sess-9",
        delayMinutes: 20,
      }),
    );
  });

  it("sends admin notice kind + message verbatim", async () => {
    renderPage();
    await userEvent.click(screen.getByTestId("type-admin_notice"));
    await userEvent.selectOptions(screen.getByTestId("bc-kind"), "sla_breach");
    await userEvent.type(screen.getByTestId("bc-message"), "Ward B breach");
    await userEvent.click(screen.getByTestId("to-preview"));
    await userEvent.click(screen.getByTestId("confirm-queue"));

    await waitFor(() =>
      expect(ban).toHaveBeenCalledWith("h-1", {
        kind: "sla_breach",
        message: "Ward B breach",
      }),
    );
  });

  it("sends the alert id for an alert broadcast", async () => {
    alertCenterCall.mockResolvedValue({
      action: "list",
      center: {
        alerts: [
          {
            id: "alert-7",
            hospital_id: "h-1",
            alert_key: "queue_backlog",
            alert_category: "queue",
            severity: "critical",
            current_value: 5,
            threshold_value: 1,
            message: "backlog",
            is_resolved: false,
            acknowledged_at: null,
            assigned_to: null,
            escalated_at: null,
            created_at: "2026-10-01T00:00:00Z",
            resolved_at: null,
          },
        ],
        counts: { open: 1, acknowledged: 0, escalated: 0, critical_open: 1 },
      },
    });
    renderPage();
    await userEvent.click(screen.getByTestId("type-alert"));
    await waitFor(() => expect(screen.getByTestId("bc-alert")).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByTestId("bc-alert"), "alert-7");
    await userEvent.click(screen.getByTestId("to-preview"));
    await userEvent.click(screen.getByTestId("confirm-queue"));

    await waitFor(() => expect(ba).toHaveBeenCalledWith("h-1", { alertId: "alert-7" }));
  });

  it("renders the server enqueued count honestly and NEVER claims delivery", async () => {
    bq.mockResolvedValue(ok(3, "queue_summary"));
    bookingsCall.mockResolvedValue([
      { queue_session_id: "sess-9", assigned_doctor_id: null },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("bc-session")).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByTestId("bc-session"), "sess-9");
    await userEvent.click(screen.getByTestId("to-preview"));
    await userEvent.click(screen.getByTestId("confirm-queue"));

    await waitFor(() =>
      expect(screen.getByTestId("queued-summary")).toHaveTextContent(/3 messages/i),
    );
    // Never a positive delivery claim — only an accept/queue one.
    expect(screen.getByTestId("queued-badge")).toHaveTextContent(/queued/i);
    expect(screen.queryByText(/delivery confirmed/i)).toBeNull();
    expect(screen.queryByText(/successfully delivered/i)).toBeNull();
    expect(screen.queryByText(/whatsapp delivered/i)).toBeNull();
  });

  it("shows a 0 enqueued count as an honest result, not a failure", async () => {
    bq.mockResolvedValue(ok(0, "queue_summary"));
    bookingsCall.mockResolvedValue([
      { queue_session_id: "sess-9", assigned_doctor_id: null },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("bc-session")).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByTestId("bc-session"), "sess-9");
    await userEvent.click(screen.getByTestId("to-preview"));
    await userEvent.click(screen.getByTestId("confirm-queue"));

    await waitFor(() =>
      expect(screen.getByTestId("queued-summary")).toHaveTextContent(
        /queued 0 messages/i,
      ),
    );
    expect(screen.queryByTestId("broadcast-error")).toBeNull();
  });

  it("compose another resets back to the compose stage", async () => {
    bookingsCall.mockResolvedValue([
      { queue_session_id: "sess-9", assigned_doctor_id: null },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("bc-session")).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByTestId("bc-session"), "sess-9");
    await userEvent.click(screen.getByTestId("to-preview"));
    await userEvent.click(screen.getByTestId("confirm-queue"));
    await waitFor(() => expect(screen.getByTestId("queued-badge")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("compose-another"));
    expect(screen.getByTestId("to-preview")).toBeInTheDocument();
    expect(screen.queryByTestId("queued-badge")).toBeNull();
  });
});

describe("single in-flight submit", () => {
  it("two rapid confirm clicks fire exactly one request", async () => {
    let resolve!: (v: CommandCenterBroadcastResponse) => void;
    bq.mockImplementation(
      () => new Promise((r) => (resolve = r)),
    );
    bookingsCall.mockResolvedValue([
      { queue_session_id: "sess-9", assigned_doctor_id: null },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("bc-session")).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByTestId("bc-session"), "sess-9");
    await userEvent.click(screen.getByTestId("to-preview"));

    fireEvent.click(screen.getByTestId("confirm-queue"));
    fireEvent.click(screen.getByTestId("confirm-queue"));
    expect(bq).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve(ok(2));
    });
    await waitFor(() => expect(screen.getByTestId("queued-badge")).toBeInTheDocument());
  });
});

describe("error surfacing", () => {
  const cases: { status: number; code: string; match: RegExp }[] = [
    { status: 401, code: "UNAUTHORIZED", match: /session expired/i },
    { status: 403, code: "FORBIDDEN", match: /do not have permission/i },
    { status: 422, code: "VALIDATION_ERROR", match: /not found/i },
    { status: 500, code: "INTERNAL", match: /could not complete/i },
  ];

  it.each(cases)(
    "surfaces a $status broadcast rejection honestly and never queues",
    async ({ status, code, match }) => {
      bq.mockRejectedValue(
        new ApiError({
          code,
          message: status === 422 ? "Queue session not found" : "err",
          status,
        }),
      );
      bookingsCall.mockResolvedValue([
        { queue_session_id: "sess-9", assigned_doctor_id: null },
      ]);
      renderPage();
      await waitFor(() => expect(screen.getByTestId("bc-session")).toBeInTheDocument());
      await userEvent.selectOptions(screen.getByTestId("bc-session"), "sess-9");
      await userEvent.click(screen.getByTestId("to-preview"));
      await userEvent.click(screen.getByTestId("confirm-queue"));

      await waitFor(() =>
        expect(screen.getByTestId("broadcast-error")).toHaveTextContent(match),
      );
      expect(screen.queryByTestId("queued-badge")).toBeNull();
    },
  );
});

describe("tenant context", () => {
  it("passes the acting hospital for a tenant-less global admin, resolved once", async () => {
    auth.current = { role: "global_admin", hospitalId: null };
    actingCall.mockResolvedValue({ hospitalId: "act-1", hospitalName: "Acting" });
    bookingsCall.mockResolvedValue([
      { queue_session_id: "sess-9", assigned_doctor_id: null },
    ]);
    renderPage();
    await waitFor(() => expect(actingCall).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("bc-session")).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByTestId("bc-session"), "sess-9");
    await userEvent.click(screen.getByTestId("to-preview"));
    await userEvent.click(screen.getByTestId("confirm-queue"));

    await waitFor(() => expect(bq).toHaveBeenCalledWith("act-1", "sess-9"));
  });

  it("waits honestly and sends nothing while the global-admin context is unresolved", async () => {
    auth.current = { role: "global_admin", hospitalId: null };
    actingCall.mockResolvedValue(null);
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByText(/waiting for the hospital context/i),
      ).toBeInTheDocument(),
    );
    expect(bq).not.toHaveBeenCalled();
  });
});

describe("PII containment", () => {
  it("never renders a patient phone number in the composer", async () => {
    // Even if a booking carried a phone, the composer only ever shows the
    // doctor-labelled session, never patient contact detail.
    bookingsCall.mockResolvedValue([
      {
        queue_session_id: "sess-9",
        assigned_doctor_id: "doc-1",
        patient_phone: "+919999999999",
      },
    ]);
    doctorNamesCall.mockResolvedValue(new Map([["doc-1", "Dr. Rao"]]));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("bc-session")).toBeInTheDocument());
    expect(screen.queryByText(/9999999999/)).toBeNull();
  });
});
