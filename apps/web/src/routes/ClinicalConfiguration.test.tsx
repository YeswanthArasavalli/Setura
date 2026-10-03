import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ApiError } from "@/lib/errors";
import type {
  ClinicalConfigurationSnapshot,
  ClinicalDepartmentRow,
  ClinicalDoctorRow,
  ClinicalLeaveRow,
  ClinicalScheduleRow,
} from "@/api/clinicalConfiguration";
import type { ClinicalConfigurationResponseBody } from "@/types/api";

/**
 * WS-ONBOARD-4 - Clinical Configuration frontend.
 *
 * The write path itself (JWT, requireRole, tenant cross-check, idempotency,
 * RPC, audit) is certified by the integration + real-HTTP Edge suites. These
 * tests pin what only THIS layer can pin:
 *
 *  - the exported pure helpers mirror the exact limits the RPCs and Zod enforce
 *    (name/code lengths, weekday 0..6, start < end, end >= start, 10-15 digit
 *    phone, fee/minute ranges), so the client pre-check never disagrees with
 *    the server;
 *  - overlap is deliberately NOT approximated client-side, because the DB
 *    exclusion constraints ignore `is_active` / status and a local guess would
 *    be wrong - the server's 409 must be shown, not prevented by a weaker rule;
 *  - the UX guard hides the surface from a non-admin and fires no read at all;
 *  - ONE read serves all four tabs (a tab switch is not a refetch), and the
 *    navigation is one entry, not four;
 *  - every mutation goes through the Edge Function wrapper with a required
 *    idempotency key, trimmed values and the version the SERVER returned;
 *  - the doctor initial password is write-only: it is cleared from state after
 *    a successful create and never appears in the rendered document;
 *  - a 409 / 422 from the server is surfaced honestly, never as a success
 *    banner.
 */

const INITIAL_SECRET = "InitialPassw0rd!";

const readCall = vi.fn();
const deptCreateCall = vi.fn();
const deptUpdateCall = vi.fn();
const deptStatusCall = vi.fn();
const doctorCreateCall = vi.fn();
const doctorUpdateCall = vi.fn();
const scheduleUpsertCall = vi.fn();
const scheduleDeleteCall = vi.fn();
const leaveUpsertCall = vi.fn();
const leaveCancelCall = vi.fn();

vi.mock("@/api/clinicalConfiguration", () => ({
  getClinicalConfiguration: (hospitalId: string) => readCall(hospitalId),
  createDepartment: (hospitalId: string, key: string, input: unknown) =>
    deptCreateCall(hospitalId, key, input),
  updateDepartment: (hospitalId: string, key: string, input: unknown) =>
    deptUpdateCall(hospitalId, key, input),
  setDepartmentStatus: (hospitalId: string, key: string, input: unknown) =>
    deptStatusCall(hospitalId, key, input),
  createDoctor: (hospitalId: string, key: string, input: unknown) =>
    doctorCreateCall(hospitalId, key, input),
  updateDoctor: (hospitalId: string, key: string, input: unknown) =>
    doctorUpdateCall(hospitalId, key, input),
  upsertSchedule: (hospitalId: string, key: string, input: unknown) =>
    scheduleUpsertCall(hospitalId, key, input),
  deleteSchedule: (hospitalId: string, key: string, input: unknown) =>
    scheduleDeleteCall(hospitalId, key, input),
  upsertLeave: (hospitalId: string, key: string, input: unknown) =>
    leaveUpsertCall(hospitalId, key, input),
  cancelLeave: (hospitalId: string, key: string, leaveId: string) =>
    leaveCancelCall(hospitalId, key, leaveId),
}));

const auth = vi.hoisted(() => ({
  current: {
    role: "hospital_admin" as
      | "global_admin"
      | "hospital_admin"
      | "doctor"
      | "receptionist",
    hospitalId: "h-1" as string | null,
  },
}));
vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({
    hospitalId: auth.current.hospitalId,
    staff: {
      fullName: "Admin",
      role: auth.current.role,
      hospitalId: auth.current.hospitalId,
    },
  }),
}));

const {
  WEEKDAY_LABELS,
  ClinicalConfiguration,
  departmentBufferFrom,
  departmentName,
  doctorBufferFrom,
  doctorLabel,
  isDepartmentDirty,
  leaveBufferFrom,
  scheduleBufferFrom,
  specializationPayloadOf,
  validateDepartment,
  validateDoctor,
  validateLeave,
  validateSchedule,
} = await import("@/routes/ClinicalConfiguration");

// ─── Fixtures: canonical server rows ─────────────────────────────────────────

function dept(over: Partial<ClinicalDepartmentRow> = {}): ClinicalDepartmentRow {
  return {
    id: "d-1",
    name: "Cardiology",
    code: "CARD",
    description: "Heart unit",
    isActive: true,
    version: 2,
    ...over,
  };
}

function doctor(over: Partial<ClinicalDoctorRow> = {}): ClinicalDoctorRow {
  return {
    doctorId: "dr-1",
    fullName: "Dr. Anitha Rao",
    normalizedPhone: "9800000000",
    isActive: true,
    specializations: [
      {
        doctorId: "dr-1",
        name: "Cardiology",
        consultationFee: 500,
        averageConsultationMinutes: 15,
      },
    ],
    departmentIds: ["d-1"],
    ...over,
  };
}

function sched(over: Partial<ClinicalScheduleRow> = {}): ClinicalScheduleRow {
  return {
    id: "s-1",
    doctorId: "dr-1",
    weekday: 1,
    startTime: "10:00:00",
    endTime: "14:00:00",
    maxTokens: 40,
    averageConsultationMinutes: 12,
    isActive: true,
    ...over,
  };
}

function leave(over: Partial<ClinicalLeaveRow> = {}): ClinicalLeaveRow {
  return {
    id: "l-1",
    doctorId: "dr-1",
    startDate: "2026-10-10",
    endDate: "2026-10-12",
    leaveType: "annual_leave",
    leaveStatus: "approved",
    reason: "Family",
    notes: null,
    approvedAt: "2026-10-01T00:00:00Z",
    ...over,
  };
}

function snap(
  over: Partial<ClinicalConfigurationSnapshot> = {},
): ClinicalConfigurationSnapshot {
  return {
    hospitalId: "h-1",
    departments: [dept()],
    doctors: [doctor()],
    schedules: [sched()],
    leaves: [leave()],
    ...over,
  };
}

function ok(
  action: ClinicalConfigurationResponseBody["action"],
  entity: ClinicalConfigurationResponseBody["entity"] = {},
): ClinicalConfigurationResponseBody {
  return { action, hospitalId: "h-1", entity };
}

function conflict(message: string): ApiError {
  return new ApiError({
    code: "DB_CONCURRENCY_ERROR",
    message,
    status: 409,
    retryable: false,
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/clinical-configuration"]}>
      <Routes>
        <Route
          path="/admin/clinical-configuration"
          element={<ClinicalConfiguration />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

async function openTab(tab: "departments" | "doctors" | "schedules" | "leave") {
  await userEvent.click(screen.getByTestId(`cc-tab-${tab}`));
}

beforeEach(() => {
  readCall.mockReset();
  deptCreateCall.mockReset();
  deptUpdateCall.mockReset();
  deptStatusCall.mockReset();
  doctorCreateCall.mockReset();
  doctorUpdateCall.mockReset();
  scheduleUpsertCall.mockReset();
  scheduleDeleteCall.mockReset();
  leaveUpsertCall.mockReset();
  leaveCancelCall.mockReset();
  auth.current.role = "hospital_admin";
  auth.current.hospitalId = "h-1";
  readCall.mockResolvedValue(snap());
  deptCreateCall.mockResolvedValue(ok("department_create"));
  deptUpdateCall.mockResolvedValue(ok("department_update", { version: 3 }));
  deptStatusCall.mockResolvedValue(ok("department_status_change", { version: 3 }));
  doctorCreateCall.mockResolvedValue(ok("doctor_create"));
  doctorUpdateCall.mockResolvedValue(ok("doctor_update"));
  scheduleUpsertCall.mockResolvedValue(ok("schedule_upsert"));
  scheduleDeleteCall.mockResolvedValue(ok("schedule_delete"));
  leaveUpsertCall.mockResolvedValue(ok("leave_upsert"));
  leaveCancelCall.mockResolvedValue(ok("leave_cancel"));
});

// ─── Pure helpers mirror the server ──────────────────────────────────────────

describe("departmentBufferFrom / validateDepartment", () => {
  it("seeds an empty buffer for a missing row and copies null as empty text", () => {
    expect(departmentBufferFrom(undefined)).toEqual({
      name: "",
      code: "",
      description: "",
    });
    expect(
      departmentBufferFrom(dept({ description: null, name: " Neuro " })),
    ).toEqual({ name: " Neuro ", code: "CARD", description: "" });
  });

  it("applies the same bounds as the RPC CHECKs", () => {
    expect(
      Object.keys(validateDepartment({ name: "Cardiology", code: "CARD", description: "" })),
    ).toHaveLength(0);
    expect(validateDepartment({ name: " C ", code: "CARD", description: "" }).name)
      .toBeTruthy();
    expect(validateDepartment({ name: "", code: "", description: "" }).code)
      .toBeTruthy();
    expect(
      validateDepartment({ name: "x".repeat(121), code: "CARD", description: "" }).name,
    ).toBeTruthy();
    expect(
      validateDepartment({ name: "Ok", code: "c".repeat(33), description: "" }).code,
    ).toBeTruthy();
    expect(
      validateDepartment({
        name: "Ok",
        code: "C",
        description: "d".repeat(501),
      }).description,
    ).toBeTruthy();
  });

  it("treats surrounding whitespace as unchanged (the server trims too)", () => {
    const base = departmentBufferFrom(dept());
    expect(isDepartmentDirty(base, { ...base, name: "  Cardiology  " })).toBe(
      false,
    );
    expect(isDepartmentDirty(base, { ...base, code: "NEURO" })).toBe(true);
  });

  it("falls back to an id prefix for an unknown department id", () => {
    expect(departmentName([dept()], "d-1")).toBe("Cardiology");
    expect(departmentName([], "ffffffff-1111")).toBe("ffffffff");
  });
});

describe("doctorBufferFrom / validateDoctor", () => {
  it("NEVER seeds a credential or an email from the roster", () => {
    const buf = doctorBufferFrom(doctor());
    expect(buf.email).toBe("");
    expect(buf.password).toBe("");
    expect(buf.isActive).toBe(true);
    expect(buf.specializations[0]).toEqual({
      name: "Cardiology",
      consultationFee: "500",
      averageMinutes: "15",
    });
  });

  it("requires identity fields only for a NEW doctor", () => {
    const bare = doctorBufferFrom(undefined);
    expect(validateDoctor(bare, true).email).toBeTruthy();
    expect(validateDoctor(bare, true).password).toBeTruthy();
    expect(validateDoctor(bare, true).specializations).toBeTruthy();
    // The update RPC has no email/password parameter at all, so the edit form
    // must not nag about fields it cannot send.
    expect(validateDoctor(bare, false).email).toBeUndefined();
    expect(validateDoctor(bare, false).password).toBeUndefined();
  });

  it("checks email shape, phone digits and per-row specialization numbers", () => {
    const buf = {
      ...doctorBufferFrom(undefined),
      fullName: "Dr Who",
      email: "nope",
      password: "12345678",
      phone: "12345",
      specializations: [{ name: "Cards", consultationFee: "-2", averageMinutes: "999" }],
    };
    const e = validateDoctor(buf, true);
    expect(e.email).toBeTruthy();
    expect(e.phone).toBeTruthy();
    expect(e["spec.0.fee"]).toBeTruthy();
    expect(e["spec.0.minutes"]).toBeTruthy();
    expect(validateDoctor({ ...buf, phone: "+91 98765 43210" }, true).phone)
      .toBeUndefined();
  });

  it("builds the RPC specialization payload: unnamed rows dropped, blanks omitted", () => {
    expect(
      specializationPayloadOf([
        { name: "  Cardiology  ", consultationFee: "0", averageMinutes: "" },
        { name: "   ", consultationFee: "700", averageMinutes: "20" },
        { name: "Neuro", consultationFee: "", averageMinutes: "20" },
      ]),
    ).toEqual([
      { name: "Cardiology", consultationFee: 0 },
      { name: "Neuro", averageConsultationMinutes: 20 },
    ]);
  });

  it("labels a doctor without falling back to a blank", () => {
    expect(doctorLabel(doctor())).toBe("Dr. Anitha Rao");
    expect(doctorLabel(doctor({ fullName: null }))).toBe("Cardiology");
    expect(
      doctorLabel(doctor({ fullName: null, specializations: [] })),
    ).toBe("Doctor dr-1");
  });
});

describe("validateSchedule", () => {
  it("normalizes the DB TIME to the input's HH:MM", () => {
    expect(scheduleBufferFrom(sched())).toEqual({
      weekday: "1",
      startTime: "10:00",
      endTime: "14:00",
      maxTokens: "40",
      averageMinutes: "12",
      isActive: true,
    });
    expect(scheduleBufferFrom(undefined).startTime).toBe("");
  });

  it("rejects an empty or inverted window and out-of-range capacity", () => {
    const base = scheduleBufferFrom(sched());
    expect(Object.keys(validateSchedule(base))).toHaveLength(0);
    expect(validateSchedule({ ...base, endTime: "10:00" }).endTime).toBeTruthy();
    expect(validateSchedule({ ...base, startTime: "15:00" }).endTime).toBeTruthy();
    expect(validateSchedule({ ...base, weekday: "7" }).weekday).toBeTruthy();
    expect(validateSchedule({ ...base, maxTokens: "0" }).maxTokens).toBeTruthy();
    expect(validateSchedule({ ...base, averageMinutes: "241" }).averageMinutes)
      .toBeTruthy();
    expect(validateSchedule({ ...base, startTime: "9am" }).startTime).toBeTruthy();
  });

  it("orders Sunday first, matching PostgreSQL dow 0..6", () => {
    expect(WEEKDAY_LABELS[0]).toBe("Sunday");
    expect(WEEKDAY_LABELS[6]).toBe("Saturday");
  });
});

describe("validateLeave", () => {
  it("seeds from a server row and honours end >= start", () => {
    expect(leaveBufferFrom(leave())).toEqual({
      startDate: "2026-10-10",
      endDate: "2026-10-12",
      leaveType: "annual_leave",
      reason: "Family",
      notes: "",
    });
    const base = leaveBufferFrom(leave());
    expect(Object.keys(validateLeave(base))).toHaveLength(0);
    // A single-day leave is legal (valid_leave_dates allows equality).
    expect(
      Object.keys(validateLeave({ ...base, endDate: base.startDate })),
    ).toHaveLength(0);
    expect(validateLeave({ ...base, endDate: "2026-10-01" }).endDate).toBeTruthy();
    expect(validateLeave({ ...base, startDate: "10/10/2026" }).startDate)
      .toBeTruthy();
    expect(validateLeave({ ...base, leaveType: "beach" }).leaveType).toBeTruthy();
    expect(validateLeave({ ...base, reason: "r".repeat(501) }).reason).toBeTruthy();
    expect(validateLeave({ ...base, notes: "n".repeat(2001) }).notes).toBeTruthy();
  });
});

// ─── Page ────────────────────────────────────────────────────────────────────

it("hides the surface from a non-admin and never issues a read", () => {
  auth.current.role = "receptionist";
  renderPage();
  expect(
    screen.getByText(/clinical configuration is for hospital administrators/i),
  ).toBeInTheDocument();
  expect(readCall).not.toHaveBeenCalled();
});

it("stays idle without an acting hospital context", () => {
  auth.current.hospitalId = null;
  renderPage();
  expect(screen.getByText(/no acting hospital/i)).toBeInTheDocument();
  expect(readCall).not.toHaveBeenCalled();
});

it("renders the server rows and serves all four tabs from ONE read", async () => {
  renderPage();
  expect(await screen.findByText("Cardiology")).toBeInTheDocument();
  expect(screen.getByText("CARD")).toBeInTheDocument();
  expect(screen.getByText(/v2/)).toBeInTheDocument();
  expect(readCall).toHaveBeenCalledTimes(1);

  await openTab("doctors");
  expect(screen.getByText("Dr. Anitha Rao")).toBeInTheDocument();
  await openTab("schedules");
  expect(screen.getByTestId("cc-schedule-row-s-1").textContent).toContain("Monday");
  await openTab("leave");
  expect(screen.getByTestId("cc-leave-row-l-1").textContent).toContain("2026-10-10");

  expect(readCall).toHaveBeenCalledTimes(1);
});

it("degrades to an honest error state with a retry, not a silent empty screen", async () => {
  readCall.mockRejectedValueOnce(new Error("RLS read failed"));
  renderPage();
  expect(await screen.findByText(/RLS read failed/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /retry/i }));
  await waitFor(() => expect(screen.getByTestId("cc-tab-schedules")).toBeTruthy());
  expect(readCall).toHaveBeenCalledTimes(2);
});

it("creates a department with trimmed values and a required idempotency key", async () => {
  renderPage();
  await screen.findByText("Cardiology");

  await userEvent.type(screen.getByLabelText("Name"), "  Neurology  ");
  await userEvent.type(screen.getByLabelText("Code"), " NEURO ");
  await userEvent.click(screen.getByTestId("cc-dept-create"));

  await waitFor(() => expect(deptCreateCall).toHaveBeenCalledTimes(1));
  const [hospitalId, key, input] = deptCreateCall.mock.calls[0];
  expect(hospitalId).toBe("h-1");
  expect(typeof key).toBe("string");
  expect(key.length).toBeGreaterThan(0);
  expect(input).toEqual({
    name: "Neurology",
    code: "NEURO",
    description: "",
  });
  // The snapshot is refetched so the table shows the server's row, not a
  // client-side optimistic guess.
  await waitFor(() => expect(readCall).toHaveBeenCalledTimes(2));
  expect(await screen.findByTestId("cc-banner")).toBeInTheDocument();
});

it("blocks an invalid department client-side and never calls the backend", async () => {
  renderPage();
  await screen.findByText("Cardiology");

  await userEvent.type(screen.getByLabelText("Name"), "X");
  await userEvent.click(screen.getByTestId("cc-dept-create"));

  expect(deptCreateCall).not.toHaveBeenCalled();
  expect(
    await screen.findByText(/at least 2 characters/i),
  ).toBeInTheDocument();
});

it("sends the SERVER version as expectedVersion when toggling status", async () => {
  renderPage();
  await screen.findByText("Cardiology");

  await userEvent.click(screen.getByTestId("cc-dept-status-CARD"));

  await waitFor(() => expect(deptStatusCall).toHaveBeenCalledTimes(1));
  expect(deptStatusCall.mock.calls[0][2]).toEqual({
    departmentId: "d-1",
    expectedVersion: 2,
    isActive: false,
  });
  await waitFor(() => expect(readCall).toHaveBeenCalledTimes(2));
});

it("surfaces a 409 concurrency conflict verbatim and never as a success", async () => {
  deptStatusCall.mockRejectedValue(
    conflict("This record changed while you were editing. Reload and try again."),
  );
  renderPage();
  await screen.findByText("Cardiology");

  await userEvent.click(screen.getByTestId("cc-dept-status-CARD"));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("changed while you were editing");
  expect(screen.queryByTestId("cc-banner")).toBeNull();
});

it("edits a department with the loaded version and omits an unchanged save", async () => {
  renderPage();
  await screen.findByText("Cardiology");

  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(screen.getByTestId("cc-dept-edit-save")).toBeDisabled();

  await userEvent.type(screen.getByLabelText("Department description"), " (updated)");
  await waitFor(() => expect(screen.getByTestId("cc-dept-edit-save")).toBeEnabled());
  await userEvent.click(screen.getByTestId("cc-dept-edit-save"));

  await waitFor(() => expect(deptUpdateCall).toHaveBeenCalledTimes(1));
  expect(deptUpdateCall.mock.calls[0][2]).toEqual({
    departmentId: "d-1",
    expectedVersion: 2,
    name: "Cardiology",
    code: "CARD",
    description: "Heart unit (updated)",
  });
});

it("creates a doctor with the specialization payload and never re-renders the password", async () => {
  renderPage();
  await screen.findByText("Cardiology");
  await openTab("doctors");

  await userEvent.type(screen.getByLabelText("Full name"), "Dr. Rao");
  await userEvent.type(screen.getByLabelText("Email (sign-in)"), "rao@hospital.test");
  fireEvent.change(screen.getByLabelText("Initial password"), {
    target: { value: INITIAL_SECRET },
  });
  await userEvent.type(screen.getByLabelText("Phone"), "9876543210");
  await userEvent.type(screen.getByLabelText("Specialization 1"), "Cardiology");
  await userEvent.type(screen.getByLabelText("Consultation fee 1"), "600");
  expect(screen.getByLabelText("Initial password")).toHaveAttribute(
    "type",
    "password",
  );

  await userEvent.click(screen.getByTestId("cc-doctor-create"));

  await waitFor(() => expect(doctorCreateCall).toHaveBeenCalledTimes(1));
  expect(doctorCreateCall.mock.calls[0][2]).toEqual({
    fullName: "Dr. Rao",
    email: "rao@hospital.test",
    password: INITIAL_SECRET,
    phone: "9876543210",
    specializations: [{ name: "Cardiology", consultationFee: 600 }],
    departmentIds: [],
  });
  // Credential hygiene after the submit: state is cleared and the secret is
  // gone from the rendered document.
  await waitFor(() =>
    expect(screen.getByLabelText("Initial password")).toHaveValue(""),
  );
  expect(document.body.textContent ?? "").not.toContain(INITIAL_SECRET);
});

it("assigns departments to a doctor only from that hospital's list", async () => {
  readCall.mockResolvedValue(
    snap({ departments: [dept(), dept({ id: "d-2", code: "ORTH", name: "Ortho" })] }),
  );
  renderPage();
  await screen.findByText("Cardiology");
  await openTab("doctors");
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));

  const ortho = screen.getByTestId("cc-doctor-edit-dept-ORTH");
  expect(ortho.textContent).toContain("Ortho");
  await userEvent.click(ortho.querySelector("input")!);
  await userEvent.click(screen.getByTestId("cc-doctor-edit-save"));

  await waitFor(() => expect(doctorUpdateCall).toHaveBeenCalledTimes(1));
  const input = doctorUpdateCall.mock.calls[0][2];
  expect(input.doctorId).toBe("dr-1");
  expect(input.departmentIds).toEqual(["d-1", "d-2"]);
  expect(input.isActive).toBe(true);
});

it("warns when the selected doctor is inactive before a schedule is saved", async () => {
  readCall.mockResolvedValue(snap({ doctors: [doctor({ isActive: false })] }));
  renderPage();
  await screen.findByText("Cardiology");
  await openTab("schedules");
  expect(
    await screen.findByText(/inactive, so an active schedule will be refused/i),
  ).toBeInTheDocument();
});

it("saves an edited schedule with parsed numbers and the existing id", async () => {
  renderPage();
  await screen.findByText("Cardiology");
  await openTab("schedules");

  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(screen.getByLabelText("Start")).toHaveValue("10:00");
  await userEvent.click(screen.getByTestId("cc-schedule-save"));

  await waitFor(() => expect(scheduleUpsertCall).toHaveBeenCalledTimes(1));
  expect(scheduleUpsertCall.mock.calls[0][2]).toEqual({
    doctorId: "dr-1",
    scheduleId: "s-1",
    weekday: 1,
    startTime: "10:00",
    endTime: "14:00",
    maxTokens: 40,
    averageConsultationMinutes: 12,
    isActive: true,
  });
});

it("creates a schedule for another weekday and deletes a row", async () => {
  renderPage();
  await screen.findByText("Cardiology");
  await openTab("schedules");

  await userEvent.selectOptions(screen.getByTestId("cc-schedule-weekday"), "0");
  fireEvent.change(screen.getByLabelText("Start"), { target: { value: "09:00" } });
  fireEvent.change(screen.getByLabelText("End"), { target: { value: "12:00" } });
  await userEvent.click(screen.getByTestId("cc-schedule-save"));

  await waitFor(() => expect(scheduleUpsertCall).toHaveBeenCalledTimes(1));
  expect(scheduleUpsertCall.mock.calls[0][2]).toMatchObject({
    scheduleId: null,
    weekday: 0,
    startTime: "09:00",
    endTime: "12:00",
  });

  await userEvent.click(screen.getByTestId("cc-schedule-delete-s-1"));
  await waitFor(() => expect(scheduleDeleteCall).toHaveBeenCalledTimes(1));
  expect(scheduleDeleteCall.mock.calls[0][2]).toEqual({
    doctorId: "dr-1",
    scheduleId: "s-1",
  });
});

it("refuses an inverted schedule window before any network call", async () => {
  renderPage();
  await screen.findByText("Cardiology");
  await openTab("schedules");

  fireEvent.change(screen.getByLabelText("Start"), { target: { value: "16:00" } });
  fireEvent.change(screen.getByLabelText("End"), { target: { value: "08:00" } });
  await userEvent.click(screen.getByTestId("cc-schedule-save"));

  expect(scheduleUpsertCall).not.toHaveBeenCalled();
  expect(
    await screen.findByText(/end time must be after the start time/i),
  ).toBeInTheDocument();
});

it("records leave as an approved-blocking window and cancels it", async () => {
  renderPage();
  await screen.findByText("Cardiology");
  await openTab("leave");

  await fireEvent.change(screen.getByLabelText("From"), {
    target: { value: "2026-11-02" },
  });
  await fireEvent.change(screen.getByLabelText("To"), {
    target: { value: "2026-11-05" },
  });
  await userEvent.type(screen.getByLabelText("Reason"), "Conference");
  await userEvent.click(screen.getByTestId("cc-leave-save"));

  await waitFor(() => expect(leaveUpsertCall).toHaveBeenCalledTimes(1));
  expect(leaveUpsertCall.mock.calls[0][2]).toMatchObject({
    doctorId: "dr-1",
    leaveId: null,
    startDate: "2026-11-02",
    endDate: "2026-11-05",
    leaveType: "annual_leave",
    reason: "Conference",
  });

  await userEvent.click(screen.getByTestId("cc-leave-cancel-l-1"));
  await waitFor(() => expect(leaveCancelCall).toHaveBeenCalledTimes(1));
  expect(leaveCancelCall.mock.calls[0][2]).toBe("l-1");
});

it("disables cancelling a leave that is already cancelled", async () => {
  readCall.mockResolvedValue(
    snap({ leaves: [leave({ id: "l-2", leaveStatus: "cancelled" })] }),
  );
  renderPage();
  await screen.findByText("Cardiology");
  await openTab("leave");
  expect(screen.getByTestId("cc-leave-cancel-l-2")).toBeDisabled();
});

it("rejects an inverted leave window locally, without a network call", async () => {
  renderPage();
  await screen.findByText("Cardiology");
  await openTab("leave");

  fireEvent.change(screen.getByLabelText("From"), {
    target: { value: "2026-11-10" },
  });
  fireEvent.change(screen.getByLabelText("To"), {
    target: { value: "2026-11-01" },
  });
  await userEvent.click(screen.getByTestId("cc-leave-save"));

  expect(leaveUpsertCall).not.toHaveBeenCalled();
  expect(
    await screen.findByText(/end date must be on or after/i),
  ).toBeInTheDocument();
});

it("does NOT guess a leave overlap locally - the server's 409 is displayed", async () => {
  // no_overlapping_doctor_leaves is keyed on (doctor, daterange, is_deleted)
  // and ignores status, so a client-side approximation would be a weaker rule
  // than the constraint. The exclusion violation must arrive as 409.
  leaveUpsertCall.mockRejectedValue(
    new ApiError({
      code: "DB_CONSTRAINT_VIOLATION",
      message: "This time window overlaps an existing record",
      status: 409,
    }),
  );
  renderPage();
  await screen.findByText("Cardiology");
  await openTab("leave");

  fireEvent.change(screen.getByLabelText("From"), {
    target: { value: "2026-10-11" },
  });
  fireEvent.change(screen.getByLabelText("To"), {
    target: { value: "2026-10-15" },
  });
  await userEvent.click(screen.getByTestId("cc-leave-save"));

  await waitFor(() => expect(leaveUpsertCall).toHaveBeenCalledTimes(1));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("overlaps an existing record");
  expect(screen.queryByTestId("cc-banner")).toBeNull();
});

it("keeps the loaded data visible when a background refresh fails, and says so", async () => {
  renderPage();
  await screen.findByText("Cardiology");
  expect(readCall).toHaveBeenCalledTimes(1);

  // The refresh after a department toggle now fails.
  readCall.mockRejectedValueOnce(new Error("PostgREST unavailable"));
  await userEvent.click(screen.getByTestId("cc-dept-status-CARD"));

  const warn = await screen.findByTestId("cc-refresh-error");
  expect(warn.textContent).toContain("PostgREST unavailable");
  expect(warn.textContent).toContain("out of date");
  // The row is still on screen - no silent revert to a spinner.
  expect(screen.getByText("Cardiology")).toBeInTheDocument();
});
