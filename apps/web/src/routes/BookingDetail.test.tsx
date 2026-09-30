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
// Same boundary discipline for the G-02 status closure: real dispatch to
// `update-booking-status` (role + tenant + state re-checks, audit, deduped
// enqueue) is proven by the integration suite (E1 06, S1 05).
const updateBookingStatus = vi.fn();
vi.mock("@/api/statuses", () => ({
  updateBookingStatus: (...a: unknown[]) => updateBookingStatus(...a),
}));
// Same boundary discipline for the G-07 staff reschedule: real dispatch to
// `reschedule-booking` (role + tenant + state + date/holiday/doctor re-checks,
// audit, deduped enqueue and the canonical create_booking) is proven by the
// integration suite.
const rescheduleBooking = vi.fn();
vi.mock("@/api/reschedule", () => ({
  rescheduleBooking: (...a: unknown[]) => rescheduleBooking(...a),
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
  updateBookingStatus.mockReset();
  rescheduleBooking.mockReset();
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

/**
 * The G-02 status-closure control surface (Phase 7). Backend role, tenant,
 * transition validity, concurrency, replay, audit and the deduped no-show
 * notification enqueue are proven by the integration suite; what is pinned
 * here is everything the console owns: who is offered which control and in
 * which state, exact request bodies, confirmation before any mutation,
 * double-fire suppression, `changed:false` as success, reload-instead-of-
 * optimistic-mutation, honest error mapping, and the absolute absence of
 * money fields and delivery claims.
 */
function booked(overrides: Partial<BookingRow> = {}): BookingRow {
  return cancellable({ status: "booked", ...overrides });
}

/** Open a status confirmation panel as receptionist. */
async function openStatusPanel(name: "Check In" | "Mark No-Show") {
  const rendered = await renderAs("receptionist", booked());
  await userEvent.click(screen.getByRole("button", { name }));
  return rendered;
}

describe("BookingDetail status-closure control", () => {
  it.each(["receptionist", "hospital_admin", "global_admin"])(
    "offers Check In and Mark No-Show to %s for a booked booking",
    async (role) => {
      const { unmount } = await renderAs(role, booked());
      expect(
        screen.getByRole("button", { name: "Check In" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Mark No-Show" }),
      ).toBeInTheDocument();
      // C1's cancellation control remains intact on the same surface.
      expect(
        screen.getByRole("button", { name: "Cancel booking" }),
      ).toBeInTheDocument();
      unmount();
    },
  );

  it("does not offer the reception controls to a doctor", async () => {
    await renderAs("doctor", booked());

    expect(screen.queryByRole("button", { name: "Check In" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark No-Show" })).toBeNull();
    // A render gate, not data hiding: the booking itself stays visible.
    expect(screen.getByText("Ramesh K")).toBeInTheDocument();
  });

  it("hides Check In once checked_in but keeps Mark No-Show", async () => {
    await renderAs("receptionist", booked({ status: "checked_in" }));

    expect(screen.queryByRole("button", { name: "Check In" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Mark No-Show" }),
    ).toBeInTheDocument();
  });

  it("offers no status control on terminal or queue-owned states", async () => {
    for (const status of [
      "completed",
      "cancelled",
      "no_show",
      "rescheduled",
      "waiting",
      "called",
      "in_consultation",
    ]) {
      const { unmount } = await renderAs("receptionist", booked({ status }));
      expect(screen.queryByRole("button", { name: "Check In" })).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Mark No-Show" }),
      ).toBeNull();
      unmount();
    }
  });

  it("requires confirmation before anything is sent", async () => {
    await openStatusPanel("Check In");

    // The panel is open, but no request has fired yet.
    expect(updateBookingStatus).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Confirm check-in" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Check this patient in\?/)).toBeInTheDocument();
  });

  it("sends the exact two-field body for check-in and reloads", async () => {
    getBooking
      .mockReset()
      .mockResolvedValueOnce(booked())
      .mockResolvedValueOnce(booked({ status: "checked_in" }));
    updateBookingStatus.mockResolvedValue({
      bookingId: "b-1",
      status: "checked_in",
      changed: true,
    });

    auth.role = "receptionist";
    renderDetail();
    await waitForBooking();
    await userEvent.click(screen.getByRole("button", { name: "Check In" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm check-in" }),
    );

    await screen.findByText(/Patient checked in/);
    const [body, tenant] = updateBookingStatus.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(body).toEqual({ bookingId: "b-1", newStatus: "checked_in" });
    expect(tenant).toBe("h-1");
    // Rendered state came from a second read, not a local write.
    expect(getBooking).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("checked in").length).toBeGreaterThan(0);
  });

  it("sends a typed no-show note verbatim; an empty note omits the key", async () => {
    updateBookingStatus.mockResolvedValue({
      bookingId: "b-1",
      status: "no_show",
      changed: true,
    });
    const { unmount } = await openStatusPanel("Mark No-Show");
    fireEvent.change(screen.getByLabelText("Note (optional)"), {
      target: { value: "  patient never travelled  " },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm no-show" }),
    );
    await waitFor(() => expect(updateBookingStatus).toHaveBeenCalledTimes(1));
    let [body] = updateBookingStatus.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(body.notes).toBe("  patient never travelled  ");
    unmount();

    updateBookingStatus.mockReset().mockResolvedValue({
      bookingId: "b-1",
      status: "no_show",
      changed: true,
    });
    const second = await openStatusPanel("Mark No-Show");
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm no-show" }),
    );
    await waitFor(() => expect(updateBookingStatus).toHaveBeenCalledTimes(1));
    [body] = updateBookingStatus.mock.calls[0] as [Record<string, unknown>];
    expect(Object.keys(body).sort()).toEqual(["bookingId", "newStatus"]);
    second.unmount();
  });

  it("treats the changed:false replay as a completed outcome, not an error", async () => {
    updateBookingStatus.mockResolvedValue({
      bookingId: "b-1",
      status: "checked_in",
      changed: false,
    });
    const { unmount } = await openStatusPanel("Check In");
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm check-in" }),
    );

    await screen.findByText(/already checked in \(no change\)/);
    expect(screen.queryByRole("alert")).toBeNull();
    unmount();
  });

  it("disables the action while the request is in flight", async () => {
    updateBookingStatus.mockReturnValue(new Promise(() => {})); // never settles
    const { unmount } = await openStatusPanel("Check In");
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm check-in" }),
    );

    const busy = screen.getByRole("button", { name: "Submitting…" });
    expect(busy).toBeDisabled();
    expect(screen.getByRole("button", { name: "Keep as is" })).toBeDisabled();
    expect(updateBookingStatus).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("surfaces a concurrency rejection honestly and reloads", async () => {
    updateBookingStatus.mockRejectedValue(
      new ApiError({
        code: "DB_CONCURRENCY_ERROR",
        message: "Booking status concurrently changed to 'cancelled'.",
        status: 409,
        retryable: true,
      }),
    );
    const { unmount } = await openStatusPanel("Check In");
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm check-in" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("concurrently changed");
    // The page is never blanked, and the fresh read drives what is shown.
    expect(screen.getByText("Ramesh K")).toBeInTheDocument();
    expect(getBooking).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Patient checked in/)).toBeNull();
    unmount();
  });

  it("maps a rejected transition (422) to the backend's own message", async () => {
    updateBookingStatus.mockRejectedValue(
      new ApiError({
        code: "VALIDATION_ERROR",
        message: "Booking in terminal state 'completed'",
        status: 422,
      }),
    );
    const { unmount } = await openStatusPanel("Check In");
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm check-in" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Booking in terminal state 'completed'",
    );
    unmount();
  });

  it("maps an authorization denial (403) without exposing internals", async () => {
    updateBookingStatus.mockRejectedValue(
      new ApiError({
        code: "FORBIDDEN",
        message: "Booking belongs to different hospital",
        status: 403,
      }),
    );
    const { unmount } = await openStatusPanel("Check In");
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm check-in" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "You do not have permission to perform this action.",
    );
    expect(alert).not.toHaveTextContent(/hospital/i);
    unmount();
  });

  it("claims no delivery and no money change anywhere on the surface", async () => {
    updateBookingStatus.mockResolvedValue({
      bookingId: "b-1",
      status: "no_show",
      changed: true,
    });
    const { unmount } = await openStatusPanel("Mark No-Show");
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm no-show" }),
    );
    await screen.findByText(/Booking marked as no-show/);

    // The backend enqueues the notification job; the console never says it
    // sent anything, and this feature touches no financial field.
    expect(document.body.textContent).not.toMatch(/whatsapp|message sent/i);
    const [body] = updateBookingStatus.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(JSON.stringify(body)).not.toMatch(/amount|fee|inr|refund/i);
    unmount();
  });
});

/**
 * The G-07 staff reschedule control surface. Backend role, tenant, reschedulable
 * state, booking-window/holiday/working-hours/doctor-availability validation,
 * the optimistic guard, idempotency, the canonical create_booking, audit and the
 * deduped notification enqueue are all proven by the integration suite; what is
 * pinned here is everything the console owns: who is offered the control and in
 * which state, that a date is required before submitting, the exact request
 * body, reloading the database state instead of optimistically mutating, and
 * honest error handling.
 */
function reschedulable(overrides: Partial<BookingRow> = {}): BookingRow {
  return {
    ...completedBooking,
    status: "booked",
    consultation_started_at: null,
    consultation_completed_at: null,
    ...overrides,
  };
}

function rescheduledRow(): BookingRow {
  return reschedulable({ status: "rescheduled" });
}

async function openRescheduleForm(row: BookingRow = reschedulable()) {
  const rendered = await renderAs("receptionist", row);
  await userEvent.click(
    screen.getByRole("button", { name: "Reschedule booking" }),
  );
  return rendered;
}

function setDate(value: string) {
  fireEvent.change(screen.getByLabelText("New appointment date"), {
    target: { value },
  });
}

describe("BookingDetail reschedule control", () => {
  it.each(["receptionist", "hospital_admin", "global_admin"])(
    "offers the reschedule control to %s",
    async (role) => {
      const { unmount } = await renderAs(role, reschedulable());
      expect(
        screen.getByRole("button", { name: "Reschedule booking" }),
      ).toBeInTheDocument();
      unmount();
    },
  );

  it("does not offer the reschedule control to a doctor", async () => {
    await renderAs("doctor", reschedulable());

    expect(
      screen.queryByRole("button", { name: "Reschedule booking" }),
    ).toBeNull();
    // A render gate, not data hiding: the booking itself stays visible.
    expect(screen.getByText("Ramesh K")).toBeInTheDocument();
  });

  it("does not offer the control for a state the backend will not reschedule from", async () => {
    for (const status of [
      "completed",
      "cancelled",
      "no_show",
      "rescheduled",
    ]) {
      const { unmount } = await renderAs(
        "receptionist",
        reschedulable({ status }),
      );
      expect(
        screen.queryByRole("button", { name: "Reschedule booking" }),
      ).toBeNull();
      unmount();
    }
  });

  it("requires a new date before the submit is enabled", async () => {
    await openRescheduleForm();
    const submit = screen.getByRole("button", {
      name: "Confirm reschedule",
    });

    expect(submit).toBeDisabled(); // no date chosen
    setDate("2026-10-03");
    expect(submit).toBeEnabled();
  });

  it("sends the date-only body, the tenant context and a UUID idempotency key", async () => {
    rescheduleBooking.mockResolvedValue({
      originalBookingId: "b-1",
      newBookingId: "b-2",
      newTokenNumber: 12,
      newDate: "2026-10-03",
    });
    const { unmount } = await openRescheduleForm();
    setDate("2026-10-03");
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm reschedule" }),
    );
    await waitFor(() => expect(rescheduleBooking).toHaveBeenCalledTimes(1));

    const [body, tenant, key] = rescheduleBooking.mock
      .calls[0] as [Record<string, unknown>, string, string];
    // No doctor override and no reason were entered, so neither is sent; the
    // backend keeps the original doctor and records no reason.
    expect(body).toEqual({ bookingId: "b-1", newDate: "2026-10-03" });
    expect(tenant).toBe("h-1");
    expect(key).toMatch(/^[0-9a-f-]{36}$/i);
    // No money figure and no second tenant source ever leave the browser.
    expect(Object.keys(body).join(",")).not.toMatch(/amount|fee|inr|hospital/i);
    expect(Object.values(body).some((v) => typeof v === "number")).toBe(false);
    unmount();
  });

  it("reloads the booking after a reschedule instead of mutating it locally", async () => {
    getBooking
      .mockReset()
      .mockResolvedValueOnce(reschedulable())
      .mockResolvedValueOnce(rescheduledRow());
    rescheduleBooking.mockResolvedValue({
      originalBookingId: "b-1",
      newBookingId: "b-2",
      newTokenNumber: 12,
      newDate: "2026-10-03",
    });

    auth.role = "receptionist";
    renderDetail();
    await waitForBooking();
    await userEvent.click(
      screen.getByRole("button", { name: "Reschedule booking" }),
    );
    setDate("2026-10-03");
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm reschedule" }),
    );

    await screen.findByText(/Rescheduled to/);
    expect(rescheduleBooking).toHaveBeenCalledTimes(1);
    // The rendered state came from a second read, not a local write.
    expect(getBooking).toHaveBeenCalledTimes(2);
    expect(screen.getByText("2026-10-03")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    // A rescheduled booking no longer offers the control.
    expect(
      screen.queryByRole("button", { name: "Reschedule booking" }),
    ).toBeNull();
  });

  it("surfaces a rejected reschedule honestly and allows a retry", async () => {
    rescheduleBooking.mockRejectedValue(
      new ApiError({
        code: "HOSPITAL_CLOSED",
        message: "Holiday on new date",
        status: 422,
      }),
    );
    await openRescheduleForm();
    setDate("2026-10-03");
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm reschedule" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Holiday on new date");
    // The page is never blanked and no false success is shown.
    expect(screen.getByText("Ramesh K")).toBeInTheDocument();
    expect(screen.queryByText(/Rescheduled to/)).toBeNull();
    // Staff can retry without losing the chosen date.
    expect(screen.getByLabelText("New appointment date")).toHaveValue(
      "2026-10-03",
    );
    expect(
      screen.getByRole("button", { name: "Confirm reschedule" }),
    ).toBeEnabled();
  });
});
