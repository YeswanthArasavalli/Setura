import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { BookingRow, ConsultationNoteRow } from "@/api/reads";
import { ApiError } from "@/lib/errors";

/**
 * The Consultation card on the booking detail surface (migration 63 read
 * surface). The tests pin faithful display of persisted clinical text and
 * the transient/empty/error states. Real RLS visibility is proven by the
 * integration suite (consultation_notes_read.test.ts), so here only the
 * reads boundary is mocked.
 */
const getBooking = vi.fn();
const listConsultationNotes = vi.fn();
const listDoctorNames = vi.fn();
vi.mock("@/api/reads", () => ({
  getBooking: (h: string, b: string) => getBooking(h, b),
  listConsultationNotes: (h: string, b: string) =>
    listConsultationNotes(h, b),
  listDoctorNames: (ids: string[]) => listDoctorNames(ids),
}));
// Real dispatch to `cancel-booking` (role + tenant + state re-checks) is proven
// by the integration suite; only the API boundary is mocked here.
const cancelBooking = vi.fn();
vi.mock("@/api/cancellations", () => ({
  cancelBooking: (...a: unknown[]) => cancelBooking(...a),
}));
// Role is a RENDER gate only — `requireRole` in the Edge Function stays the
// authority — so tests switch it per case.
const auth: { role: string | null } = { role: "receptionist" };
vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({ hospitalId: "h-1", role: auth.role }),
}));

const { BookingDetail } = await import("@/routes/BookingDetail");

const completedBooking: BookingRow = {
  id: "b-1",
  hospital_id: "h-1",
  queue_session_id: "q-1",
  patient_id: "p-1",
  patient_name: "Ramesh K",
  patient_phone: "9876543210",
  token_number: 7,
  status: "completed",
  booking_source: "walkin",
  assigned_doctor_id: "d-1",
  appointment_date: "2026-09-22",
  booking_reference: "SURYA-7",
  estimated_wait_minutes: 10,
  platform_fee_snapshot: 5,
  receptionist_fee_snapshot: 5,
  hospital_fee_snapshot: 490,
  total_amount_snapshot: 500,
  booking_fee_inr: 500,
  payment_completed: true,
  payment_reference: "pay_1",
  payment_status_detail: null,
  consultation_started_at: "2026-09-22T10:00:00Z",
  consultation_completed_at: "2026-09-22T10:12:00Z",
  cancellation_reason: null,
  cancelled_at: null,
  created_at: "2026-09-22T09:00:00Z",
};

function note(
  overrides: Partial<ConsultationNoteRow> = {},
): ConsultationNoteRow {
  return {
    id: "n-1",
    booking_id: "b-1",
    doctor_id: "d-1",
    notes: "Fever since two days.",
    diagnosis_summary: "Viral fever",
    created_at: "2026-09-22T10:10:00Z",
    ...overrides,
  };
}

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={["/bookings/b-1"]}>
      <Routes>
        <Route path="/bookings/:bookingId" element={<BookingDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Wait until the booking card itself has rendered (loads first). */
async function waitForBooking() {
  await screen.findByText("Ramesh K");
}

beforeEach(() => {
  auth.role = "receptionist";
  getBooking.mockReset().mockResolvedValue(completedBooking);
  listConsultationNotes.mockReset().mockResolvedValue([note()]);
  listDoctorNames.mockReset().mockResolvedValue(
    new Map([["d-1", "Dr. Anitha Rao"]]),
  );
  cancelBooking.mockReset();
});

describe("BookingDetail consultation card", () => {
  it("renders the persisted clinical note and diagnosis faithfully", async () => {
    listConsultationNotes.mockResolvedValue([
      note({
        notes: "Fever since two days.\nCough, no breathlessness.",
        diagnosis_summary: "Viral fever",
      }),
    ]);
    renderDetail();
    await waitForBooking();

    // Exact stored text, line break preserved, no rewrite. Matched on raw
    // textContent so the stored \n must survive verbatim (pre-wrap).
    const stored = "Fever since two days.\nCough, no breathlessness.";
    const para = await screen.findByText(
      (_c, el) => el?.textContent === stored,
    );
    expect(para.tagName).toBe("P");
    expect(await screen.findByText("Viral fever")).toBeInTheDocument();
    expect(screen.getByText("Dr. Anitha Rao")).toBeInTheDocument();
  });

  it("renders every appended note of a consultation", async () => {
    listConsultationNotes.mockResolvedValue([
      note({ id: "n-1", notes: "First observation." }),
      note({ id: "n-2", notes: "Follow-up observation." }),
    ]);
    renderDetail();
    await waitForBooking();

    expect(await screen.findByText("First observation.")).toBeInTheDocument();
    expect(
      await screen.findByText("Follow-up observation."),
    ).toBeInTheDocument();
  });

  it("shows the empty-state copy for a blank note, never 'undefined'", async () => {
    listConsultationNotes.mockResolvedValue([
      note({ notes: "", diagnosis_summary: "Gastritis" }),
    ]);
    renderDetail();
    await waitForBooking();

    expect(
      await screen.findByText("No clinical notes recorded."),
    ).toBeInTheDocument();
    expect(screen.getByText("Gastritis")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/undefined|\[object/);
  });

  it("shows the empty-state copy for a null diagnosis", async () => {
    listConsultationNotes.mockResolvedValue([
      note({ diagnosis_summary: null }),
    ]);
    renderDetail();
    await waitForBooking();

    expect(await screen.findByText("No diagnosis recorded.")).toBeInTheDocument();
    expect(screen.getByText("Fever since two days.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/undefined|\[object/);
  });

  it("shows 'no notes' when the caller is not entitled to see any rows", async () => {
    // RLS answers an unauthorized read with zero rows, not an error.
    listConsultationNotes.mockResolvedValue([]);
    renderDetail();
    await waitForBooking();

    expect(
      await screen.findByText("No clinical notes recorded."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Viral fever")).toBeNull();
  });

  it("shows a loading state while the notes read is in flight", async () => {
    listConsultationNotes.mockReturnValue(
      new Promise(() => {
        /* never settles: models the transient loading window */
      }),
    );
    renderDetail();
    await waitForBooking();

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText("Viral fever")).toBeNull();
  });

  it("surfaces a failed notes read as an error, not as empty data", async () => {
    listConsultationNotes.mockRejectedValue(new Error("consultation read failed"));
    renderDetail();
    await waitForBooking();

    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent("consultation read failed");
    // An error must never masquerade as "nothing was recorded".
    expect(screen.queryByText("No clinical notes recorded.")).toBeNull();
  });

  it("omits the doctor label when the directory row is not readable", async () => {
    listDoctorNames.mockResolvedValue(new Map());
    renderDetail();
    await waitForBooking();
    await screen.findByText("Viral fever");

    expect(screen.queryByText("Dr. Anitha Rao")).toBeNull();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });

  it("keeps the existing booking and payment detail intact", async () => {
    renderDetail();
    await waitForBooking();

    expect(screen.getByText("9876543210 · Ref SURYA-7")).toBeInTheDocument();
    expect(screen.getByText("Token")).toBeInTheDocument();
    expect(screen.getAllByText("7").length).toBeGreaterThan(0);
    // ₹500 legitimately appears twice (Total and Booking fee snapshot).
    expect(screen.getAllByText("₹500").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Paid")).toBeInTheDocument();
    expect(
      screen.getByText(new Date(completedBooking.consultation_started_at!)
        .toLocaleString()),
    ).toBeInTheDocument();
  });
});

/**
 * The payment badge mapping on the detail surface (Phase 7 payment-status UX
 * fix). These pin the APPROVED three-way semantics and, above all, their
 * ORDER: `payment_completed` is evaluated before `booking_fee_inr`, so a paid
 * state can never be hidden behind "No payment required", and a null/absent fee
 * is never read as a zero fee. Pure presentation over an already-fetched row -
 * no fee is computed and no financial rule is asserted.
 */
function booking(
  overrides: Partial<BookingRow>,
): BookingRow {
  return { ...completedBooking, ...overrides };
}

async function renderWith(row: BookingRow) {
  getBooking.mockResolvedValue(row);
  renderDetail();
  await waitForBooking();
}

describe("BookingDetail payment badge (Phase 7 payment-status UX)", () => {
  it("shows 'No payment required' for an unpaid zero-fee walk-in", async () => {
    // Matches the real staging walk-in shape: fee and snapshots all zero.
    await renderWith(
      booking({
        booking_source: "walkin",
        booking_fee_inr: 0,
        platform_fee_snapshot: 0,
        receptionist_fee_snapshot: 0,
        hospital_fee_snapshot: 0,
        total_amount_snapshot: 0,
        payment_completed: false,
        payment_reference: null,
        payment_status_detail: null,
      }),
    );

    expect(screen.getByText("No payment required")).toBeInTheDocument();
    expect(screen.queryByText("Payment pending")).toBeNull();
    expect(screen.queryByText("Paid")).toBeNull();
  });

  it("shows 'Payment pending' for an unpaid non-zero booking", async () => {
    await renderWith(
      booking({
        booking_fee_inr: 20,
        platform_fee_snapshot: 20,
        total_amount_snapshot: 20,
        payment_completed: false,
        payment_reference: null,
      }),
    );

    expect(screen.getByText("Payment pending")).toBeInTheDocument();
    expect(screen.queryByText("No payment required")).toBeNull();
  });

  it("shows 'Paid' for a captured non-zero booking", async () => {
    await renderWith(
      booking({ booking_fee_inr: 20, payment_completed: true }),
    );

    expect(screen.getByText("Paid")).toBeInTheDocument();
    expect(screen.queryByText("Payment pending")).toBeNull();
    expect(screen.queryByText("No payment required")).toBeNull();
  });

  it("CRITICAL: keeps 'Paid' when a zero-fee row is also marked paid", async () => {
    // A non-runtime (fixture / offline-recognition) row can carry
    // payment_completed = true with booking_fee_inr = 0. The badge must still
    // read Paid - never an all-clear that hides collected money.
    await renderWith(
      booking({ booking_fee_inr: 0, payment_completed: true }),
    );

    expect(screen.getByText("Paid")).toBeInTheDocument();
    expect(screen.queryByText("No payment required")).toBeNull();
  });

  it("falls back to 'Payment pending' when the fee is null (null is not zero)", async () => {
    await renderWith(
      booking({ booking_fee_inr: null, payment_completed: false }),
    );

    expect(screen.getByText("Payment pending")).toBeInTheDocument();
    expect(screen.queryByText("No payment required")).toBeNull();
  });

  it("derives nothing from total_amount_snapshot", async () => {
    // Hospital-side money is display only (D16): a large total on an unpaid
    // zero-fee booking must not change the badge.
    await renderWith(
      booking({
        booking_fee_inr: 0,
        total_amount_snapshot: 500,
        hospital_fee_snapshot: 500,
        payment_completed: false,
      }),
    );

    expect(screen.getByText("No payment required")).toBeInTheDocument();
    // ₹500 legitimately renders twice (Hospital fee and Total); neither feeds
    // the badge.
    expect(screen.getAllByText("₹500").length).toBeGreaterThanOrEqual(1);
  });
});

/**
 * The cancellation control surface (Phase 7). Backend role, tenant, terminal
 * state, concurrency, refund validity and the WhatsApp enqueue are proven by
 * the integration suite; what is pinned here is everything the console owns:
 * who is offered the control, the server-compatible reason boundary, the
 * refund-request gating (a boolean only, never an amount), an idempotent replay
 * treated as success, reloading instead of optimistically mutating, honest
 * error handling, and verbatim rendering of the persisted outcome.
 */
function cancellable(overrides: Partial<BookingRow> = {}): BookingRow {
  return {
    ...completedBooking,
    status: "waiting",
    consultation_started_at: null,
    consultation_completed_at: null,
    ...overrides,
  };
}

function cancelledRow(overrides: Partial<BookingRow> = {}): BookingRow {
  return cancellable({
    status: "cancelled",
    cancellation_reason: "Patient travelled out of town",
    cancelled_at: "2026-09-22T11:00:00Z",
    ...overrides,
  });
}

async function renderAs(role: string | null, row: BookingRow) {
  auth.role = role;
  getBooking.mockResolvedValue(row);
  const rendered = renderDetail();
  await waitForBooking();
  return rendered;
}

/** Render as a receptionist and open the confirmation surface. */
async function openForm(row: BookingRow = cancellable()) {
  const rendered = await renderAs("receptionist", row);
  await userEvent.click(screen.getByRole("button", { name: "Cancel booking" }));
  return rendered;
}

/** Set a controlled textarea value in one event (keystroke-by-keystroke typing
 *  of a 500-character string is slow and adds no assertion value). */
function typeReason(value: string) {
  fireEvent.change(screen.getByLabelText("Cancellation reason"), {
    target: { value },
  });
}

describe("BookingDetail cancellation control", () => {
  it.each(["receptionist", "hospital_admin", "global_admin"])(
    "offers the cancel control to %s",
    async (role) => {
      const { unmount } = await renderAs(role, cancellable());
      expect(
        screen.getByRole("button", { name: "Cancel booking" }),
      ).toBeInTheDocument();
      unmount();
    },
  );

  it("does not offer the cancel control to a doctor", async () => {
    await renderAs("doctor", cancellable());

    expect(
      screen.queryByRole("button", { name: "Cancel booking" }),
    ).toBeNull();
    expect(screen.queryByText("Cancellation reason")).toBeNull();
    // A render gate, not data hiding: the booking itself stays visible.
    expect(screen.getByText("Ramesh K")).toBeInTheDocument();
  });

  it("does not offer the control for a state the backend will not cancel from", async () => {
    for (const status of [
      "completed",
      "no_show",
      "rescheduled",
      "cancelled",
    ]) {
      const { unmount } = await renderAs(
        "receptionist",
        status === "cancelled" ? cancelledRow() : cancellable({ status }),
      );
      expect(
        screen.queryByRole("button", { name: "Cancel booking" }),
      ).toBeNull();
      unmount();
    }
  });

  it("requires a server-compatible reason (3–500 characters) before submitting", async () => {
    await openForm();
    const submit = screen.getByRole("button", { name: "Confirm cancellation" });

    expect(submit).toBeDisabled(); // 0 characters

    typeReason("ab");
    expect(submit).toBeDisabled(); // 2 characters
    expect(screen.getByRole("alert")).toHaveTextContent(
      "at least 3 characters",
    );

    typeReason("abc"); // exactly 3 characters
    expect(submit).toBeEnabled();

    typeReason("x".repeat(200));
    expect(submit).toBeEnabled(); // comfortable middle length
    expect(screen.queryByRole("alert")).toBeNull();

    typeReason("y".repeat(501));
    expect(submit).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "at most 500 characters",
    );

    typeReason("y".repeat(500));
    expect(submit).toBeEnabled();
  });

  it("offers the refund request only for a captured payment with a non-zero fee", async () => {
    const cases: Array<[Partial<BookingRow>, boolean]> = [
      [{ payment_completed: false, booking_fee_inr: 500 }, false],
      [{ payment_completed: true, booking_fee_inr: 0 }, false],
      [{ payment_completed: true, booking_fee_inr: null }, false],
      [{ payment_completed: true, booking_fee_inr: 500 }, true],
    ];

    for (const [overrides, visible] of cases) {
      const { unmount } = await openForm(cancellable(overrides));
      const checkbox = screen.queryByLabelText("Request a refund");
      if (visible) {
        expect(checkbox).toBeInTheDocument();
        // The default must be unchecked: a refund is never implied.
        expect(checkbox).not.toBeChecked();
      } else {
        expect(checkbox).toBeNull();
      }
      unmount();
    }
  });

  it("sends a boolean refund request and never an amount", async () => {
    cancelBooking.mockResolvedValue({
      bookingId: "b-1",
      cancelled: true,
      alreadyCancelled: false,
      refundInitiated: false,
    });
    const { unmount } = await openForm(
      cancellable({ payment_completed: true, booking_fee_inr: 500 }),
    );
    typeReason("Duplicate entry");
    await userEvent.click(screen.getByLabelText("Request a refund"));
    // While the request is being made the UI explains it instead of quoting a
    // figure; after submission it reports only what the backend said.
    expect(
      screen.getByText(/Sends this request to the existing backend refund/),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm cancellation" }),
    );
    await waitFor(() => expect(cancelBooking).toHaveBeenCalledTimes(1));

    const [body, tenant, key] = cancelBooking.mock
      .calls[0] as [Record<string, unknown>, string, string];
    expect(body).toEqual({
      bookingId: "b-1",
      cancellationReason: "Duplicate entry",
      initiateRefund: true,
    });
    expect(Object.keys(body).sort()).toEqual([
      "bookingId",
      "cancellationReason",
      "initiateRefund",
    ]);
    expect(typeof body.initiateRefund).toBe("boolean");
    // Tenant travels in the header context, and the key is the UUID v4 the
    // backend idempotency layer requires.
    expect(tenant).toBe("h-1");
    expect(key).toMatch(/^[0-9a-f-]{36}$/i);
    // No money figure and no second tenant source ever leave the browser; the
    // refund request is a boolean only (D16: the backend owns the amount).
    expect(Object.keys(body).join(",")).not.toMatch(
      /amount|fee|inr|hospital/i,
    );
    expect(Object.values(body).some((v) => typeof v === "number")).toBe(false);
    unmount();
  });

  it("submits the reason character-for-character, without trimming it", async () => {
    cancelBooking.mockResolvedValue({
      bookingId: "b-1",
      cancelled: true,
      alreadyCancelled: false,
      refundInitiated: false,
    });
    const typed = "  late at night  ";
    const { unmount } = await openForm();
    typeReason(typed);
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm cancellation" }),
    );
    await waitFor(() => expect(cancelBooking).toHaveBeenCalledTimes(1));

    const [body] = cancelBooking.mock.calls[0] as [
      { cancellationReason: string },
    ];
    expect(body.cancellationReason).toBe(typed);
    unmount();
  });

  it("reloads the booking after a cancellation instead of mutating it locally", async () => {
    const waiting = cancellable();
    getBooking
      .mockReset()
      .mockResolvedValueOnce(waiting)
      .mockResolvedValueOnce(cancelledRow());
    cancelBooking.mockResolvedValue({
      bookingId: "b-1",
      cancelled: true,
      alreadyCancelled: false,
      refundInitiated: true,
    });

    auth.role = "receptionist";
    renderDetail();
    await waitForBooking();
    await userEvent.click(screen.getByRole("button", { name: "Cancel booking" }));
    typeReason("Patient travelled out of town");
    await userEvent.click(screen.getByLabelText("Request a refund"));
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm cancellation" }),
    );

    await screen.findByText(/Cancellation completed/);
    expect(cancelBooking).toHaveBeenCalledTimes(1);
    // The rendered state came from a second read, not a local write.
    expect(getBooking).toHaveBeenCalledTimes(2);
    expect(waiting.status).toBe("waiting");
    expect(screen.getByText(/Refund initiated/)).toBeInTheDocument();
    expect(
      screen.getByText("Patient travelled out of town"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(new Date("2026-09-22T11:00:00Z").toLocaleString()),
    ).toBeInTheDocument();
    // A cancelled booking no longer offers the control.
    expect(
      screen.queryByRole("button", { name: "Cancel booking" }),
    ).toBeNull();
  });

  it("treats an idempotent replay as a completed outcome, not an error", async () => {
    getBooking
      .mockReset()
      .mockResolvedValueOnce(cancellable())
      .mockResolvedValueOnce(cancelledRow());
    // `cancel-booking` omits refundInitiated on the already-cancelled replay.
    cancelBooking.mockResolvedValue({
      bookingId: "b-1",
      cancelled: true,
      alreadyCancelled: true,
    });

    auth.role = "receptionist";
    renderDetail();
    await waitForBooking();
    await userEvent.click(screen.getByRole("button", { name: "Cancel booking" }));
    typeReason("Patient travelled out of town");
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm cancellation" }),
    );

    await screen.findByText(/Cancellation already completed/);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(getBooking).toHaveBeenCalledTimes(2);
    // "not reported" must never be rendered as a refund decision.
    expect(
      screen.getByText(/Refund outcome not reported/),
    ).toBeInTheDocument();
    expect(screen.queryByText("No refund requested")).toBeNull();
  });

  it("surfaces a rejected cancellation honestly, keeps the booking visible and allows a retry", async () => {
    cancelBooking.mockRejectedValue(
      new ApiError({
        code: "CONCURRENCY_ERROR",
        message: "Booking was modified concurrently",
        status: 409,
        retryable: true,
      }),
    );
    await openForm();
    typeReason("Room swap needed");
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm cancellation" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Booking was modified concurrently");
    // The page is never blanked by a failed cancellation, and the status badge
    // still reports the reloaded database state ("waiting"), not a local edit.
    expect(screen.getByText("Ramesh K")).toBeInTheDocument();
    expect(screen.getAllByText("waiting").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Cancellation completed/)).toBeNull();
    // Staff can retry without losing what they typed.
    const submit = screen.getByRole("button", {
      name: "Confirm cancellation",
    });
    expect(submit).toBeEnabled();
    expect(screen.getByLabelText("Cancellation reason")).toHaveValue(
      "Room swap needed",
    );
    expect(getBooking).toHaveBeenCalledTimes(2);
  });

  it("renders a persisted cancellation as plain text, never as markup", async () => {
    await renderAs(
      "hospital_admin",
      cancelledRow({ cancellation_reason: "<b>not bold</b> & cancelled" }),
    );

    expect(
      await screen.findByText("<b>not bold</b> & cancelled"),
    ).toBeInTheDocument();
    expect(document.querySelector("b")).toBeNull();
    expect(
      screen.getByText(new Date("2026-09-22T11:00:00Z").toLocaleString()),
    ).toBeInTheDocument();
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
  });

  it("says no reason was recorded instead of inventing one", async () => {
    await renderAs(
      "receptionist",
      cancelledRow({ cancellation_reason: null }),
    );

    expect(
      await screen.findByText("No cancellation reason was recorded."),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/undefined|\[object/);
  });
});
