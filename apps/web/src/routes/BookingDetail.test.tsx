import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { BookingRow, ConsultationNoteRow } from "@/api/reads";

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
vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({ hospitalId: "h-1" }),
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
  getBooking.mockReset().mockResolvedValue(completedBooking);
  listConsultationNotes.mockReset().mockResolvedValue([note()]);
  listDoctorNames.mockReset().mockResolvedValue(
    new Map([["d-1", "Dr. Anitha Rao"]]),
  );
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
