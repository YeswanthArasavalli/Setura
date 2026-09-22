import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * The walk-in form is the only place where a receptionist can unknowingly
 * create a token that no doctor can ever call: a booking without a
 * `doctorId` never attaches to a queue session. So the transient states of
 * the doctor read are safety-relevant, not cosmetic.
 */
const listHospitalDoctors = vi.fn();
vi.mock("@/api/reads", () => ({
  listHospitalDoctors: () => listHospitalDoctors(),
  searchPatients: () => Promise.resolve([]),
}));
vi.mock("@/api/booking", () => ({ createBooking: vi.fn() }));
vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({ hospitalId: "h-1" }),
}));

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
