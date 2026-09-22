import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

/**
 * The walk-in form is the only place where a receptionist can unknowingly
 * create a token that no doctor can ever call: a booking without a
 * `doctorId` never attaches to a queue session. So the transient states of
 * the doctor read are safety-relevant, not cosmetic.
 *
 * The post-creation confirmation is tested here too: it must reflect the live
 * `CreateBookingResponse` faithfully (token/reference/queue/estimated wait),
 * must NOT fabricate queue membership when `queueSessionId` is null, and must
 * NOT leak any fee data (fees stay owned by BookingDetail).
 */
const listHospitalDoctors = vi.fn();
vi.mock("@/api/reads", () => ({
  listHospitalDoctors: () => listHospitalDoctors(),
  searchPatients: () => Promise.resolve([]),
}));
const createBooking = vi.fn();
vi.mock("@/api/booking", () => ({
  createBooking: (...a: unknown[]) => createBooking(...a),
}));
vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({ hospitalId: "h-1" }),
}));
const navigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigate };
});

const { BookingForm } = await import("@/components/BookingForm");

const walkInDoctors = [
  {
    doctorId: "d-1",
    specialization: "Cardiology",
    consultationFee: 500,
    doctorName: "Anitha Rao",
    label: "Anitha Rao · Cardiology",
  },
];

/** A read still in flight (never resolved inside the test body). */
function pendingRead() {
  return new Promise(() => {
    /* intentionally never settles: models the transient loading window */
  });
}

function renderForm() {
  return render(
    <MemoryRouter>
      <BookingForm
        source="walkin"
        title="Walk-in"
        description="Register a walk-in patient"
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  listHospitalDoctors.mockReset();
  createBooking.mockReset();
  navigate.mockReset();
});

describe("BookingForm doctor picker", () => {
  it("shows a pending read as pending, never as 'no doctors'", async () => {
    listHospitalDoctors.mockReturnValue(pendingRead());
    renderForm();

    const select = await screen.findByLabelText("Doctor (assigns a live queue)");
    expect(select).toHaveTextContent("Loading doctors…");
    expect(select).toBeDisabled();
    // The empty-list snapshot must not be presented as an authoritative fact.
    expect(select).not.toHaveTextContent("No doctors");
  });

  it("keeps submit disabled while the assignable-doctor list is unknown", async () => {
    listHospitalDoctors.mockReturnValue(pendingRead());
    renderForm();

    expect(await screen.findByRole("button", { name: "Loading doctors…" })).toBeDisabled();
  });

  it("offers the doctor name once the list resolves", async () => {
    listHospitalDoctors.mockResolvedValue(walkInDoctors);
    renderForm();

    const select = await screen.findByLabelText("Doctor (assigns a live queue)");
    expect(select).not.toBeDisabled();
    expect(select).toHaveTextContent("Anitha Rao · Cardiology");
    expect(screen.getByRole("button", { name: "Create walk-in & issue token" })).toBeEnabled();
  });

  it("warns loudly when a walk-in is submitted without a queue", async () => {
    listHospitalDoctors.mockResolvedValue(walkInDoctors);
    renderForm();

    const select = await screen.findByLabelText("Doctor (assigns a live queue)");
    expect(select).toHaveTextContent("— No assignment (token not queued) —");
    expect(
      screen.getByText(/does not enter any doctor's queue/),
    ).toBeInTheDocument();
  });

  it("reports a failed read as unavailable rather than as an empty roster", async () => {
    listHospitalDoctors.mockRejectedValue(new Error("network"));
    renderForm();

    const select = await screen.findByLabelText("Doctor (assigns a live queue)");
    expect(select).toHaveTextContent("Doctor list unavailable");
    expect(select).not.toHaveTextContent("No doctors on record");
  });

  it("only says 'no doctors on record' for a genuinely empty roster", async () => {
    listHospitalDoctors.mockResolvedValue([]);
    renderForm();

    const select = await screen.findByLabelText("Doctor (assigns a live queue)");
    expect(select).toHaveTextContent("No doctors on record for this hospital");
  });
});

// ─── Post-creation confirmation ──────────────────────────────────────────────

const confirmDoctors = [
  {
    doctorId: "d-1",
    specialization: "Cardiology",
    consultationFee: 500,
    doctorName: "Anitha Rao",
    label: "Anitha Rao · Cardiology",
  },
];

const queuedResponse = {
  bookingId: "b-1",
  tokenNumber: 7,
  bookingReference: "SURYA-7",
  estimatedWaitMinutes: 12,
  patientId: "p-1",
  appointmentDate: "2026-09-22",
  queueSessionId: "q-1",
  fees: {
    platformFee: 5,
    receptionistFee: 5,
    hospitalFee: 490,
    totalAmount: 500,
  },
};

/** Fill the mandatory fields and (optionally) assign the doctor, then submit. */
async function fillAndSubmit({ withDoctor }: { withDoctor: boolean }) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Patient name"), "Ramesh K");
  await user.type(screen.getByLabelText("Phone (10-digit)"), "9876543210");
  const select = await screen.findByLabelText(
    "Doctor (assigns a live queue)",
  );
  if (withDoctor) await user.selectOptions(select, "d-1");
  await user.click(
    screen.getByRole("button", { name: "Create walk-in & issue token" }),
  );
}

describe("BookingForm confirmation", () => {
  it("confirms a queued booking from the live response without navigating away", async () => {
    listHospitalDoctors.mockResolvedValue(confirmDoctors);
    createBooking.mockResolvedValue(queuedResponse);
    renderForm();
    await fillAndSubmit({ withDoctor: true });

    expect(await screen.findByText("Walk-in created")).toBeInTheDocument();
    expect(screen.getByText("In queue")).toBeInTheDocument();
    // Doctor resolved from the existing read surface only.
    expect(screen.getByText("Anitha Rao · Cardiology")).toBeInTheDocument();
    // Verbatim response values.
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("SURYA-7")).toBeInTheDocument();
    expect(screen.getByText("q-1")).toBeInTheDocument();
    expect(screen.getByText("12 min")).toBeInTheDocument();
    expect(
      screen.getByText(/Added to the doctor's live queue/),
    ).toBeInTheDocument();
    // No immediate redirect to BookingDetail.
    expect(navigate).not.toHaveBeenCalled();
  });

  it("never claims queue membership when queueSessionId is null", async () => {
    listHospitalDoctors.mockResolvedValue(confirmDoctors);
    createBooking.mockResolvedValue({
      ...queuedResponse,
      queueSessionId: null,
      estimatedWaitMinutes: null,
    });
    renderForm();
    await fillAndSubmit({ withDoctor: false });

    expect(await screen.findByText("Not queued")).toBeInTheDocument();
    expect(
      screen.getByText(/not callable from the Doctor Console/),
    ).toBeInTheDocument();
    expect(screen.getByText("No doctor assigned")).toBeInTheDocument();
    // A null wait must not render an "Est. wait" row or a null token.
    expect(screen.queryByText("Est. wait")).toBeNull();
    expect(screen.queryByText("q-1")).toBeNull();
    expect(document.body.textContent).not.toMatch(/undefined|\[object|\bnull\b/);
  });

  it("keeps fees out of the operational confirmation", async () => {
    listHospitalDoctors.mockResolvedValue(confirmDoctors);
    createBooking.mockResolvedValue(queuedResponse);
    renderForm();
    await fillAndSubmit({ withDoctor: true });

    await screen.findByText("Walk-in created");
    expect(screen.queryByText(/₹/)).toBeNull();
    expect(screen.queryByText("500")).toBeNull();
    expect(screen.queryByText("490")).toBeNull();
  });

  it("'Open Booking' navigates to the canonical detail route", async () => {
    listHospitalDoctors.mockResolvedValue(confirmDoctors);
    createBooking.mockResolvedValue(queuedResponse);
    const user = userEvent.setup();
    renderForm();
    await fillAndSubmit({ withDoctor: true });

    await screen.findByText("Walk-in created");
    await user.click(screen.getByRole("button", { name: "Open Booking" }));
    expect(navigate).toHaveBeenCalledWith("/bookings/b-1");
  });

  it("'Create Another' returns to a fresh form without navigating", async () => {
    listHospitalDoctors.mockResolvedValue(confirmDoctors);
    createBooking.mockResolvedValue(queuedResponse);
    const user = userEvent.setup();
    renderForm();
    await fillAndSubmit({ withDoctor: true });

    await screen.findByText("Walk-in created");
    await user.click(screen.getByRole("button", { name: "Create Another" }));

    expect(
      await screen.findByRole("button", {
        name: "Create walk-in & issue token",
      }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Patient name")).toHaveValue("");
    expect(navigate).not.toHaveBeenCalled();
    await waitFor(() => expect(createBooking).toHaveBeenCalledTimes(1));
  });
});
