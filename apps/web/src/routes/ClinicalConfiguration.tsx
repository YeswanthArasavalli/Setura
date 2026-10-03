import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/auth/AuthProvider";
import {
  cancelLeave,
  createDepartment,
  createDoctor,
  deleteSchedule,
  getClinicalConfiguration,
  setDepartmentStatus,
  updateDepartment,
  updateDoctor,
  upsertLeave,
  upsertSchedule,
  type ClinicalConfigurationSnapshot,
  type ClinicalDepartmentRow,
  type ClinicalDoctorRow,
  type ClinicalLeaveRow,
  type ClinicalScheduleRow,
  type ClinicalSpecializationInput,
} from "@/api/clinicalConfiguration";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { describeError } from "@/lib/errors";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";

/**
 * WS-ONBOARD-4 - Doctor, Department, Schedule & Leave Configuration.
 *
 * One page, four tabs, one navigation entry: a newly provisioned hospital
 * configures its operational clinical data here, with no SQL, no source edit
 * and no developer insert. The four domains are deliberately on ONE route
 * because they are one workflow (a department exists to receive doctors, a
 * doctor exists to hold schedules, a schedule is what leave suspends) and four
 * nav entries would be duplicate navigation.
 *
 * What this page does NOT own (spec §4/§10/§19):
 *   - No write reaches a table from the browser. Every mutation is a POST to
 *     the `clinical-configuration` Edge Function, which re-resolves the JWT,
 *     re-checks `requireRole` + the X-Hospital-ID tenant, replays through the
 *     idempotency system and calls a service-role SECURITY DEFINER RPC
 *     (migration 68). The route guard below is a UX boundary only.
 *   - No optimistic-concurrency contract is invented: a department edit sends
 *     the version it loaded as `expectedVersion`, and the server's P0001
 *     becomes the established HTTP 409 that `describeError` surfaces verbatim.
 *   - No fake controls. Every field here maps to a column the availability /
 *     token / booking runtime actually reads. Columns it does not consume
 *     (buffer minutes, walk-in flag, auto-cancel-bookings, rejection reason,
 *     metadata) are absent by design - see the api module header.
 *
 * The runtime effect is real and is proven by the integration + smoke suite:
 * saving an active schedule for a weekday makes that doctor bookable on that
 * weekday, and recording approved leave blocks them for the date range with
 * the availability reason "Doctor on approved leave".
 */

// ─── Shared vocabulary (mirrors the server's own limits) ─────────────────────

/** `doctor_schedules.weekday` is CHECK 0..6 with PostgreSQL `EXTRACT(DOW)`
 *  semantics: 0 is Sunday. Not ISO - the engine reads the stored integer. */
export const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** The migration-31 `doctor_leave_type` labels, mirrored so a bad value is a
 *  UI message rather than a round trip. The RPC re-checks against pg_enum. */
export const LEAVE_TYPE_OPTIONS = [
  { value: "annual_leave", label: "Annual leave" },
  { value: "sick_leave", label: "Sick leave" },
  { value: "conference", label: "Conference" },
  { value: "emergency", label: "Emergency" },
  { value: "personal", label: "Personal" },
  { value: "other", label: "Other" },
] as const;

export type FieldErrors = Record<string, string>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

/** PostgreSQL TIME comes back as HH:MM:SS; the input type="time" speaks HH:MM. */
export function hhmm(value: string): string {
  return TIME_RE.test(value) ? value : value.slice(0, 5);
}

/** Compare two HH:MM values honestly, without letting "10:00" vs "10:00:00"
 *  look like an ordering the server would reject. */
export function timeIsBefore(a: string, b: string): boolean {
  return a < b;
}

// ─── Departments ─────────────────────────────────────────────────────────────

export interface DepartmentBuffer {
  name: string;
  code: string;
  description: string;
}

export const EMPTY_DEPARTMENT: DepartmentBuffer = {
  name: "",
  code: "",
  description: "",
};

export function departmentBufferFrom(
  row: ClinicalDepartmentRow | undefined,
): DepartmentBuffer {
  return {
    name: row?.name ?? "",
    code: row?.code ?? "",
    description: row?.description ?? "",
  };
}

/** Mirrors migration 68's CHECKs and the Zod limits, so the client pre-check
 *  can never disagree with what the RPC enforces. Trimming happens here
 *  because the server trims too. */
export function validateDepartment(buf: DepartmentBuffer): FieldErrors {
  const errors: FieldErrors = {};
  const name = buf.name.trim();
  const code = buf.code.trim();
  if (name.length < 2) errors.name = "Name must be at least 2 characters.";
  else if (name.length > 120) errors.name = "Name must be 120 characters or fewer.";
  if (!code) errors.code = "Code is required.";
  else if (code.length > 32) errors.code = "Code must be 32 characters or fewer.";
  if (buf.description.trim().length > 500) {
    errors.description = "Description must be 500 characters or fewer.";
  }
  return errors;
}

export function isDepartmentDirty(
  base: DepartmentBuffer,
  buf: DepartmentBuffer,
): boolean {
  return (
    base.name.trim() !== buf.name.trim() ||
    base.code.trim() !== buf.code.trim() ||
    base.description.trim() !== buf.description.trim()
  );
}

export function departmentName(
  departments: ClinicalDepartmentRow[],
  id: string,
): string {
  return departments.find((d) => d.id === id)?.name ?? id.slice(0, 8);
}

function DepartmentsTab({
  hospitalId,
  departments,
  reload,
  notify,
}: {
  hospitalId: string;
  departments: ClinicalDepartmentRow[];
  reload: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const [create, setCreate] = useState<DepartmentBuffer>(EMPTY_DEPARTMENT);
  const [editId, setEditId] = useState<string | null>(null);
  const [edit, setEdit] = useState<DepartmentBuffer>(EMPTY_DEPARTMENT);
  const [errors, setErrors] = useState<FieldErrors>({});

  const createAct = useAsyncAction(async (key: string) =>
    createDepartment(hospitalId, key, {
      name: create.name.trim(),
      code: create.code.trim(),
      description: create.description.trim(),
    })
  );
  const editAct = useAsyncAction(async (key: string) => {
    if (!editId) throw new Error("No department selected");
    const base = departments.find((d) => d.id === editId);
    if (!base) throw new Error("Selected department is no longer listed");
    return updateDepartment(hospitalId, key, {
      departmentId: editId,
      expectedVersion: base.version,
      name: edit.name.trim(),
      code: edit.code.trim(),
      description: edit.description.trim(),
    });
  });
  const statusAct = useAsyncAction(
    async (key: string, row: ClinicalDepartmentRow, isActive: boolean) =>
      setDepartmentStatus(hospitalId, key, {
        departmentId: row.id,
        expectedVersion: row.version,
        isActive,
      }),
  );

  const submitCreate = async () => {
    const found = validateDepartment(create);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const res = await createAct.run();
    if (res === null) return;
    createAct.reset();
    setCreate(EMPTY_DEPARTMENT);
    notify(`Department "${create.name.trim()}" created.`);
    await reload();
  };

  const submitEdit = async () => {
    const found = validateDepartment(edit);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const res = await editAct.run();
    if (res === null) return;
    editAct.reset();
    setEditId(null);
    notify("Department updated.");
    await reload();
  };

  const toggleStatus = async (row: ClinicalDepartmentRow) => {
    const res = await statusAct.run(row, !row.isActive);
    if (res === null) return;
    statusAct.reset();
    notify(`Department "${row.name}" ${!row.isActive ? "activated" : "deactivated"}.`);
    await reload();
  };

  const editing = departments.find((d) => d.id === editId);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Departments</CardTitle>
          <CardDescription>
            A department is a named, code-identified unit of this hospital. A
            deactivated department stays assignable to historical doctors but
            refuses new assignments.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {departments.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="cc-dept-empty">
              No departments yet.
            </p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Code</TH>
                  <TH>Description</TH>
                  <TH>Status</TH>
                  <TH>Actions</TH>
                </TR>
              </THead>
              <TBody>
                {departments.map((d) => (
                  <TR key={d.id} data-testid={`cc-dept-row-${d.code}`}>
                    <TD className="font-medium">{d.name}</TD>
                    <TD className="font-mono">{d.code}</TD>
                    <TD className="text-muted-foreground">{d.description ?? "—"}</TD>
                    <TD>
                      <Badge variant={d.isActive ? "success" : "secondary"}>
                        {d.isActive ? "Active" : "Inactive"}
                      </Badge>
                      <span className="ml-2 text-xs text-muted-foreground">
                        v{d.version}
                      </span>
                    </TD>
                    <TD>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setEditId(d.id);
                            setEdit(departmentBufferFrom(d));
                            setErrors({});
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant={d.isActive ? "destructive" : "default"}
                          disabled={statusAct.running}
                          data-testid={`cc-dept-status-${d.code}`}
                          onClick={() => void toggleStatus(d)}
                        >
                          {d.isActive ? "Deactivate" : "Activate"}
                        </Button>
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          {statusAct.error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {describeError(statusAct.error)}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {editing ? (
        <Card>
          <CardHeader>
            <CardTitle>Edit {editing.name}</CardTitle>
            <CardDescription>
              Saved with version {editing.version}. If another operator wrote
              this row first, the server answers 409 and nothing is changed.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Field
              id="cc-dept-edit-name"
              label="Department name"
              value={edit.name}
              error={errors.name}
              onChange={(v) => setEdit((b) => ({ ...b, name: v }))}
            />
            <Field
              id="cc-dept-edit-code"
              label="Department code"
              value={edit.code}
              error={errors.code}
              onChange={(v) => setEdit((b) => ({ ...b, code: v }))}
            />
            <Field
              id="cc-dept-edit-description"
              label="Department description"
              value={edit.description}
              error={errors.description}
              onChange={(v) => setEdit((b) => ({ ...b, description: v }))}
            />
            <div className="flex gap-2">
              <Button
                onClick={() => void submitEdit()}
                disabled={editAct.running || !isDepartmentDirty(departmentBufferFrom(editing), edit)}
                data-testid="cc-dept-edit-save"
              >
                {editAct.running ? "Saving…" : "Save changes"}
              </Button>
              <Button variant="ghost" onClick={() => setEditId(null)}>
                Cancel
              </Button>
            </div>
            {editAct.error ? (
              <p role="alert" className="text-sm text-destructive">
                {describeError(editAct.error)}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>New department</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field
            id="cc-dept-new-name"
            label="Name"
            value={create.name}
            error={errors.name}
            onChange={(v) => setCreate((b) => ({ ...b, name: v }))}
          />
          <Field
            id="cc-dept-new-code"
            label="Code"
            hint="Unique per hospital, case-insensitive."
            value={create.code}
            error={errors.code}
            onChange={(v) => setCreate((b) => ({ ...b, code: v }))}
          />
          <Field
            id="cc-dept-new-description"
            label="Description"
            value={create.description}
            error={errors.description}
            onChange={(v) => setCreate((b) => ({ ...b, description: v }))}
          />
          <Button
            onClick={() => void submitCreate()}
            disabled={createAct.running}
            data-testid="cc-dept-create"
          >
            {createAct.running ? "Creating…" : "Create department"}
          </Button>
          {createAct.error ? (
            <p role="alert" className="text-sm text-destructive">
              {describeError(createAct.error)}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Doctors ─────────────────────────────────────────────────────────────────

export interface SpecializationBuffer {
  name: string;
  consultationFee: string;
  averageMinutes: string;
}

export interface DoctorBuffer {
  fullName: string;
  email: string;
  password: string;
  phone: string;
  isActive: boolean;
  specializations: SpecializationBuffer[];
  departmentIds: string[];
}

export const EMPTY_DOCTOR: DoctorBuffer = {
  fullName: "",
  email: "",
  password: "",
  phone: "",
  isActive: true,
  specializations: [{ name: "", consultationFee: "", averageMinutes: "" }],
  departmentIds: [],
};

export function doctorBufferFrom(
  row: ClinicalDoctorRow | undefined,
): DoctorBuffer {
  if (!row) return EMPTY_DOCTOR;
  return {
    fullName: row.fullName ?? "",
    email: "",
    password: "",
    phone: row.normalizedPhone ?? "",
    isActive: row.isActive,
    specializations: row.specializations.length > 0
      ? row.specializations.map((s) => ({
        name: s.name,
        consultationFee: String(s.consultationFee),
        averageMinutes: String(s.averageConsultationMinutes),
      }))
      : [{ name: "", consultationFee: "", averageMinutes: "" }],
    departmentIds: [...row.departmentIds],
  };
}

export function doctorLabel(doctor: ClinicalDoctorRow): string {
  return (
    doctor.fullName ??
    doctor.specializations[0]?.name ??
    `Doctor ${doctor.doctorId.slice(0, 8)}`
  );
}

/**
 * Client mirror of the Edge Function's Zod limits for the doctor actions.
 *
 * `isNew` decides two real differences, not cosmetic ones: the email and the
 * initial password belong to the auth identity created once at provisioning
 * and the update RPC has no parameter for either - so the edit form does not
 * offer to change them rather than pretending to.
 */
export function validateDoctor(buf: DoctorBuffer, isNew: boolean): FieldErrors {
  const errors: FieldErrors = {};
  const name = buf.fullName.trim();
  if (name.length < 2) errors.fullName = "Full name must be at least 2 characters.";
  else if (name.length > 200) errors.fullName = "Full name must be 200 characters or fewer.";

  if (isNew) {
    const email = buf.email.trim();
    if (!email) errors.email = "Email is required for the doctor sign-in.";
    else if (email.length > 254) errors.email = "Email must be 254 characters or fewer.";
    else if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
      errors.email = "Enter a valid email address.";
    }
    if (buf.password.length < 8) {
      errors.password = "Initial password must be at least 8 characters.";
    } else if (buf.password.length > 256) {
      errors.password = "Initial password must be 256 characters or fewer.";
    }
  }

  const phone = buf.phone.trim();
  if (phone) {
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) {
      errors.phone = "Phone must have 10-15 digits (or be left blank).";
    }
  }

  if (buf.specializations.length > 32) {
    errors.specializations = "At most 32 specializations.";
  }
  buf.specializations.forEach((s, i) => {
    const n = s.name.trim();
    if (!n) {
      if (isNew) errors.specializations = "Every doctor needs at least one named specialization.";
      else errors[`spec.${i}.name`] = "Specialization name is required.";
    } else if (n.length > 120) {
      errors[`spec.${i}.name`] = "Must be 120 characters or fewer.";
    }
    if (s.consultationFee.trim()) {
      const fee = Number(s.consultationFee);
      if (!Number.isFinite(fee) || fee < 0 || fee > 1_000_000) {
        errors[`spec.${i}.fee`] = "Fee must be a number from 0 to 1000000.";
      }
    }
    if (s.averageMinutes.trim()) {
      const m = Number(s.averageMinutes);
      if (!Number.isInteger(m) || m < 1 || m > 240) {
        errors[`spec.${i}.minutes`] = "Minutes must be a whole number from 1 to 240.";
      }
    }
  });

  return errors;
}

/** Strips the credential and the email before anything is displayed or kept
 *  in a result banner. The password never appears in the DOM after submit. */
export function specializationPayloadOf(
  rows: SpecializationBuffer[],
): ClinicalSpecializationInput[] {
  return rows
    .filter((s) => s.name.trim())
    .map((s) => ({
      name: s.name.trim(),
      ...(s.consultationFee.trim()
        ? { consultationFee: Number(s.consultationFee) }
        : {}),
      ...(s.averageMinutes.trim()
        ? { averageConsultationMinutes: Number(s.averageMinutes) }
        : {}),
    }));
}

function SpecializationEditor({
  idPrefix,
  rows,
  errors,
  onChange,
}: {
  idPrefix: string;
  rows: SpecializationBuffer[];
  errors: FieldErrors;
  onChange: (rows: SpecializationBuffer[]) => void;
}) {
  const patch = (i: number, over: Partial<SpecializationBuffer>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...over } : r)));

  return (
    <div className="space-y-2">
      <Label>Specializations</Label>
      <p className="text-xs text-muted-foreground">
        The booking picker only offers doctors with at least one specialization.
        The consultation fee entered here is the published clinical fee; the fee
        actually collected comes from the hospital fee policy.
      </p>
      {errors.specializations ? (
        <p role="alert" className="text-xs text-destructive">
          {errors.specializations}
        </p>
      ) : null}
      {rows.map((s, i) => (
        <div
          key={i}
          className="flex flex-wrap items-end gap-2"
          data-testid={`${idPrefix}-spec-row-${i}`}
        >
          <div className="min-w-40 flex-1">
            <Input
              aria-label={`Specialization ${i + 1}`}
              value={s.name}
              placeholder="Cardiology"
              onChange={(e) => patch(i, { name: e.target.value })}
            />
            {errors[`spec.${i}.name`] ? (
              <p className="text-xs text-destructive">{errors[`spec.${i}.name`]}</p>
            ) : null}
          </div>
          <div className="w-28">
            <Input
              aria-label={`Consultation fee ${i + 1}`}
              inputMode="decimal"
              value={s.consultationFee}
              placeholder="Fee"
              onChange={(e) => patch(i, { consultationFee: e.target.value })}
            />
            {errors[`spec.${i}.fee`] ? (
              <p className="text-xs text-destructive">{errors[`spec.${i}.fee`]}</p>
            ) : null}
          </div>
          <div className="w-32">
            <Input
              aria-label={`Average minutes ${i + 1}`}
              inputMode="numeric"
              value={s.averageMinutes}
              placeholder="Avg min"
              onChange={(e) => patch(i, { averageMinutes: e.target.value })}
            />
            {errors[`spec.${i}.minutes`] ? (
              <p className="text-xs text-destructive">{errors[`spec.${i}.minutes`]}</p>
            ) : null}
          </div>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Remove specialization ${i + 1}`}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="outline"
        data-testid={`${idPrefix}-spec-add`}
        onClick={() =>
          onChange([...rows, { name: "", consultationFee: "", averageMinutes: "" }])}
      >
        Add specialization
      </Button>
    </div>
  );
}

function DepartmentPicker({
  idPrefix,
  departments,
  selected,
  onChange,
}: {
  idPrefix: string;
  departments: ClinicalDepartmentRow[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  if (departments.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid={`${idPrefix}-no-departments`}>
        No departments configured yet. Create one on the Departments tab first.
      </p>
    );
  }
  return (
    <div className="space-y-1">
      <Label>Departments</Label>
      <div className="flex flex-wrap gap-3">
        {departments.map((d) => {
          const on = selected.includes(d.id);
          return (
            <label
              key={d.id}
              className="flex items-center gap-2 text-sm"
              data-testid={`${idPrefix}-dept-${d.code}`}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={!d.isActive && !on}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...selected, d.id]
                      : selected.filter((x) => x !== d.id),
                  )}
              />
              <span className={d.isActive ? "" : "text-muted-foreground"}>
                {d.name}
                {!d.isActive ? " (inactive)" : ""}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function DoctorsTab({
  hospitalId,
  snapshot,
  reload,
  notify,
}: {
  hospitalId: string;
  snapshot: ClinicalConfigurationSnapshot;
  reload: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const [create, setCreate] = useState<DoctorBuffer>(EMPTY_DOCTOR);
  const [editId, setEditId] = useState<string | null>(null);
  const [edit, setEdit] = useState<DoctorBuffer>(EMPTY_DOCTOR);
  const [createErrors, setCreateErrors] = useState<FieldErrors>({});
  const [editErrors, setEditErrors] = useState<FieldErrors>({});

  const createAct = useAsyncAction(async (key: string) =>
    createDoctor(hospitalId, key, {
      fullName: create.fullName.trim(),
      email: create.email.trim(),
      password: create.password,
      phone: create.phone.trim(),
      specializations: specializationPayloadOf(create.specializations),
      departmentIds: create.departmentIds,
    })
  );
  const editAct = useAsyncAction(async (key: string) => {
    if (!editId) throw new Error("No doctor selected");
    return updateDoctor(hospitalId, key, {
      doctorId: editId,
      fullName: edit.fullName.trim(),
      phone: edit.phone.trim(),
      isActive: edit.isActive,
      specializations: specializationPayloadOf(edit.specializations),
      departmentIds: edit.departmentIds,
    });
  });

  const submitCreate = async () => {
    const found = validateDoctor(create, true);
    setCreateErrors(found);
    if (Object.keys(found).length > 0) return;
    const res = await createAct.run();
    if (res === null) return;
    createAct.reset();
    // The credential is dropped from component state as soon as it has been
    // submitted - it is never re-rendered, never read back and never audited.
    setCreate(EMPTY_DOCTOR);
    notify(`Doctor created. They can sign in with that email and initial password.`);
    await reload();
  };

  const submitEdit = async () => {
    const found = validateDoctor(edit, false);
    setEditErrors(found);
    if (Object.keys(found).length > 0) return;
    const res = await editAct.run();
    if (res === null) return;
    editAct.reset();
    setEditId(null);
    notify("Doctor updated.");
    await reload();
  };

  const editing = snapshot.doctors.find((d) => d.doctorId === editId);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Doctors</CardTitle>
          <CardDescription>
            A doctor is one person: an auth identity, a profile and a `doctor`
            role in this hospital, created together or not at all. There is no
            second doctor catalogue.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {snapshot.doctors.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="cc-doctor-empty">
              No doctors configured yet.
            </p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Phone</TH>
                  <TH>Specializations</TH>
                  <TH>Departments</TH>
                  <TH>Status</TH>
                  <TH>Actions</TH>
                </TR>
              </THead>
              <TBody>
                {snapshot.doctors.map((d) => (
                  <TR key={d.doctorId} data-testid={`cc-doctor-row-${d.doctorId}`}>
                    <TD className="font-medium">{doctorLabel(d)}</TD>
                    <TD className="font-mono text-xs">{d.normalizedPhone ?? "—"}</TD>
                    <TD className="text-xs">
                      {d.specializations.map((s) => s.name).join(", ") || "—"}
                    </TD>
                    <TD className="text-xs">
                      {d.departmentIds
                        .map((id) => departmentName(snapshot.departments, id))
                        .join(", ") || "—"}
                    </TD>
                    <TD>
                      <Badge variant={d.isActive ? "success" : "secondary"}>
                        {d.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </TD>
                    <TD>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setEditId(d.doctorId);
                          setEdit(doctorBufferFrom(d));
                          setEditErrors({});
                        }}
                      >
                        Edit
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {editing ? (
        <Card>
          <CardHeader>
            <CardTitle>Edit {doctorLabel(editing)}</CardTitle>
            <CardDescription>
              Sign-in email cannot be changed here - the identity belongs to the
              auth provider, and this release has no email-change RPC.
              Deactivating a doctor also deactivates their active schedules in
              the same transaction, so no booking can reach a disabled doctor.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field
              id="cc-doctor-edit-name"
              label="Doctor full name"
              value={edit.fullName}
              error={editErrors.fullName}
              onChange={(v) => setEdit((b) => ({ ...b, fullName: v }))}
            />
            <Field
              id="cc-doctor-edit-phone"
              label="Doctor phone"
              value={edit.phone}
              error={editErrors.phone}
              onChange={(v) => setEdit((b) => ({ ...b, phone: v }))}
            />
            <SpecializationEditor
              idPrefix="cc-doctor-edit"
              rows={edit.specializations}
              errors={editErrors}
              onChange={(rows) => setEdit((b) => ({ ...b, specializations: rows }))}
            />
            <DepartmentPicker
              idPrefix="cc-doctor-edit"
              departments={snapshot.departments}
              selected={edit.departmentIds}
              onChange={(ids) => setEdit((b) => ({ ...b, departmentIds: ids }))}
            />
            <label className="flex items-center gap-2 text-sm" data-testid="cc-doctor-edit-active">
              <input
                type="checkbox"
                checked={edit.isActive}
                onChange={(e) => setEdit((b) => ({ ...b, isActive: e.target.checked }))}
              />
              Doctor is active (can be assigned and booked)
            </label>
            <div className="flex gap-2">
              <Button
                onClick={() => void submitEdit()}
                disabled={editAct.running}
                data-testid="cc-doctor-edit-save"
              >
                {editAct.running ? "Saving…" : "Save changes"}
              </Button>
              <Button variant="ghost" onClick={() => setEditId(null)}>
                Cancel
              </Button>
            </div>
            {editAct.error ? (
              <p role="alert" className="text-sm text-destructive">
                {describeError(editAct.error)}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Add a doctor</CardTitle>
          <CardDescription>
            Creates the sign-in identity and this hospital's clinical record for
            that person atomically. The initial password is sent once over
            HTTPS, is never displayed again and is excluded from logs and the
            audit payload.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field
            id="cc-doctor-new-name"
            label="Full name"
            value={create.fullName}
            error={createErrors.fullName}
            onChange={(v) => setCreate((b) => ({ ...b, fullName: v }))}
          />
          <Field
            id="cc-doctor-new-email"
            label="Email (sign-in)"
            value={create.email}
            error={createErrors.email}
            onChange={(v) => setCreate((b) => ({ ...b, email: v }))}
          />
          <div className="space-y-1">
            <Label htmlFor="cc-doctor-new-password">Initial password</Label>
            <Input
              id="cc-doctor-new-password"
              type="password"
              autoComplete="new-password"
              value={create.password}
              onChange={(e) => setCreate((b) => ({ ...b, password: e.target.value }))}
            />
            {createErrors.password ? (
              <p className="text-xs text-destructive">{createErrors.password}</p>
            ) : null}
          </div>
          <Field
            id="cc-doctor-new-phone"
            label="Phone"
            value={create.phone}
            error={createErrors.phone}
            onChange={(v) => setCreate((b) => ({ ...b, phone: v }))}
          />
          <SpecializationEditor
            idPrefix="cc-doctor-new"
            rows={create.specializations}
            errors={createErrors}
            onChange={(rows) => setCreate((b) => ({ ...b, specializations: rows }))}
          />
          <DepartmentPicker
            idPrefix="cc-doctor-new"
            departments={snapshot.departments}
            selected={create.departmentIds}
            onChange={(ids) => setCreate((b) => ({ ...b, departmentIds: ids }))}
          />
          <Button
            onClick={() => void submitCreate()}
            disabled={createAct.running}
            data-testid="cc-doctor-create"
          >
            {createAct.running ? "Creating…" : "Create doctor"}
          </Button>
          {createAct.error ? (
            <p role="alert" className="text-sm text-destructive">
              {describeError(createAct.error)}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Schedules ───────────────────────────────────────────────────────────────

export interface ScheduleBuffer {
  weekday: string;
  startTime: string;
  endTime: string;
  maxTokens: string;
  averageMinutes: string;
  isActive: boolean;
}

export const EMPTY_SCHEDULE: ScheduleBuffer = {
  weekday: "1",
  startTime: "",
  endTime: "",
  maxTokens: "50",
  averageMinutes: "10",
  isActive: true,
};

export function scheduleBufferFrom(
  row: ClinicalScheduleRow | undefined,
): ScheduleBuffer {
  if (!row) return EMPTY_SCHEDULE;
  return {
    weekday: String(row.weekday),
    startTime: hhmm(row.startTime),
    endTime: hhmm(row.endTime),
    maxTokens: String(row.maxTokens),
    averageMinutes: String(row.averageConsultationMinutes),
    isActive: row.isActive,
  };
}

/**
 * Mirrors the RPC's invariants AND the database's own constraints, so an
 * operator is told before a round trip what the server would refuse anyway -
 * and never told a success that the DB was about to reject:
 *   weekday 0..6 (CHECK), start < end, max tokens 1..5000, minutes 1..240.
 * Overlap is NOT reproduced here. `no_overlapping_doctor_schedules` ignores
 * `is_active` and evaluates the whole (doctor, hospital, weekday, minutes)
 * range, so a client-side approximation would be wrong; the server's exclusion
 * violation arrives as 409 and is displayed verbatim.
 */
export function validateSchedule(buf: ScheduleBuffer): FieldErrors {
  const errors: FieldErrors = {};
  const weekday = Number(buf.weekday);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    errors.weekday = "Weekday must be between Sunday and Saturday.";
  }
  if (!TIME_RE.test(buf.startTime)) errors.startTime = "Use a 24-hour HH:MM time.";
  if (!TIME_RE.test(buf.endTime)) errors.endTime = "Use a 24-hour HH:MM time.";
  if (
    !errors.startTime && !errors.endTime &&
    !timeIsBefore(buf.startTime, buf.endTime)
  ) {
    errors.endTime = "End time must be after the start time.";
  }
  const tokens = Number(buf.maxTokens);
  if (!Number.isInteger(tokens) || tokens < 1 || tokens > 5000) {
    errors.maxTokens = "Max tokens must be a whole number from 1 to 5000.";
  }
  const minutes = Number(buf.averageMinutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) {
    errors.averageMinutes = "Average minutes must be a whole number from 1 to 240.";
  }
  return errors;
}

function SchedulesTab({
  hospitalId,
  snapshot,
  reload,
  notify,
}: {
  hospitalId: string;
  snapshot: ClinicalConfigurationSnapshot;
  reload: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const [doctorId, setDoctorId] = useState<string>(
    snapshot.doctors[0]?.doctorId ?? "",
  );
  const [buf, setBuf] = useState<ScheduleBuffer>(EMPTY_SCHEDULE);
  const [editId, setEditId] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});

  const doctor = snapshot.doctors.find((d) => d.doctorId === doctorId);
  const rows = snapshot.schedules.filter((s) => s.doctorId === doctorId);

  const saveAct = useAsyncAction(async (key: string) => {
    if (!doctorId) throw new Error("Choose a doctor first");
    return upsertSchedule(hospitalId, key, {
      doctorId,
      scheduleId: editId,
      weekday: Number(buf.weekday),
      startTime: buf.startTime,
      endTime: buf.endTime,
      maxTokens: Number(buf.maxTokens),
      averageConsultationMinutes: Number(buf.averageMinutes),
      isActive: buf.isActive,
    });
  });
  const deleteAct = useAsyncAction(
    async (key: string, row: ClinicalScheduleRow) =>
      deleteSchedule(hospitalId, key, { doctorId, scheduleId: row.id }),
  );

  const submit = async () => {
    const found = validateSchedule(buf);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const res = await saveAct.run();
    if (res === null) return;
    saveAct.reset();
    setEditId(null);
    setBuf(EMPTY_SCHEDULE);
    notify(editId ? "Schedule updated." : "Schedule saved.");
    await reload();
  };

  const remove = async (row: ClinicalScheduleRow) => {
    const res = await deleteAct.run(row);
    if (res === null) return;
    deleteAct.reset();
    notify("Schedule removed. That weekday no longer produces slots.");
    await reload();
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Weekly schedules</CardTitle>
          <CardDescription>
            A schedule is the only thing that makes a doctor bookable on a
            weekday: the slot engine and the token capacity read these rows
            directly. Two windows on one weekday cannot overlap - the database
            refuses it, and the refusal is shown here rather than hidden.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="cc-schedule-doctor">Doctor</Label>
            <select
              id="cc-schedule-doctor"
              value={doctorId}
              data-testid="cc-schedule-doctor"
              onChange={(e) => {
                setDoctorId(e.target.value);
                setEditId(null);
                setBuf(EMPTY_SCHEDULE);
              }}
              className="h-10 w-full max-w-md rounded-md border border-input bg-background px-3 text-sm"
            >
              {snapshot.doctors.length === 0 ? (
                <option value="">No doctors configured</option>
              ) : null}
              {snapshot.doctors.map((d) => (
                <option key={d.doctorId} value={d.doctorId}>
                  {doctorLabel(d)}
                  {d.isActive ? "" : " (inactive)"}
                </option>
              ))}
            </select>
            {doctor && !doctor.isActive ? (
              <p className="text-xs text-warning">
                This doctor is inactive, so an active schedule will be refused
                until the doctor is reactivated.
              </p>
            ) : null}
          </div>

          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="cc-schedule-empty">
              No schedule for this doctor yet.
            </p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Weekday</TH>
                  <TH>Window</TH>
                  <TH>Max tokens</TH>
                  <TH>Avg minutes</TH>
                  <TH>Status</TH>
                  <TH>Actions</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((s) => (
                  <TR key={s.id} data-testid={`cc-schedule-row-${s.id}`}>
                    <TD>{WEEKDAY_LABELS[s.weekday]}</TD>
                    <TD className="font-mono text-xs">
                      {hhmm(s.startTime)}–{hhmm(s.endTime)}
                    </TD>
                    <TD>{s.maxTokens}</TD>
                    <TD>{s.averageConsultationMinutes}</TD>
                    <TD>
                      <Badge variant={s.isActive ? "success" : "secondary"}>
                        {s.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </TD>
                    <TD>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setEditId(s.id);
                            setBuf(scheduleBufferFrom(s));
                            setErrors({});
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={deleteAct.running}
                          data-testid={`cc-schedule-delete-${s.id}`}
                          onClick={() => void remove(s)}
                        >
                          Delete
                        </Button>
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          {deleteAct.error ? (
            <p role="alert" className="text-sm text-destructive">
              {describeError(deleteAct.error)}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{editId ? "Edit schedule" : "New schedule"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="cc-schedule-weekday">Weekday</Label>
            <select
              id="cc-schedule-weekday"
              value={buf.weekday}
              data-testid="cc-schedule-weekday"
              onChange={(e) => setBuf((b) => ({ ...b, weekday: e.target.value }))}
              className="h-10 w-full max-w-md rounded-md border border-input bg-background px-3 text-sm"
            >
              {WEEKDAY_LABELS.map((label, i) => (
                <option key={label} value={String(i)}>
                  {label}
                </option>
              ))}
            </select>
            {errors.weekday ? (
              <p className="text-xs text-destructive">{errors.weekday}</p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-3">
            <div className="space-y-1">
              <Label htmlFor="cc-schedule-start">Start</Label>
              <Input
                id="cc-schedule-start"
                type="time"
                value={buf.startTime}
                onChange={(e) => setBuf((b) => ({ ...b, startTime: e.target.value }))}
              />
              {errors.startTime ? (
                <p className="text-xs text-destructive">{errors.startTime}</p>
              ) : null}
            </div>
            <div className="space-y-1">
              <Label htmlFor="cc-schedule-end">End</Label>
              <Input
                id="cc-schedule-end"
                type="time"
                value={buf.endTime}
                onChange={(e) => setBuf((b) => ({ ...b, endTime: e.target.value }))}
              />
              {errors.endTime ? (
                <p className="text-xs text-destructive">{errors.endTime}</p>
              ) : null}
            </div>
            <div className="space-y-1">
              <Label htmlFor="cc-schedule-tokens">Max tokens</Label>
              <Input
                id="cc-schedule-tokens"
                inputMode="numeric"
                className="w-28"
                value={buf.maxTokens}
                onChange={(e) => setBuf((b) => ({ ...b, maxTokens: e.target.value }))}
              />
              {errors.maxTokens ? (
                <p className="text-xs text-destructive">{errors.maxTokens}</p>
              ) : null}
            </div>
            <div className="space-y-1">
              <Label htmlFor="cc-schedule-minutes">Avg minutes</Label>
              <Input
                id="cc-schedule-minutes"
                inputMode="numeric"
                className="w-28"
                value={buf.averageMinutes}
                onChange={(e) => setBuf((b) => ({ ...b, averageMinutes: e.target.value }))}
              />
              {errors.averageMinutes ? (
                <p className="text-xs text-destructive">{errors.averageMinutes}</p>
              ) : null}
            </div>
          </div>
          <label
            className="flex items-center gap-2 text-sm"
            data-testid="cc-schedule-active"
          >
            <input
              type="checkbox"
              checked={buf.isActive}
              onChange={(e) => setBuf((b) => ({ ...b, isActive: e.target.checked }))}
            />
            Schedule is active (produces bookable slots)
          </label>
          <Button
            onClick={() => void submit()}
            disabled={saveAct.running || !doctorId}
            data-testid="cc-schedule-save"
          >
            {saveAct.running ? "Saving…" : editId ? "Save schedule" : "Add schedule"}
          </Button>
          {saveAct.error ? (
            <p role="alert" className="text-sm text-destructive">
              {describeError(saveAct.error)}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Leave ───────────────────────────────────────────────────────────────────

export interface LeaveBuffer {
  startDate: string;
  endDate: string;
  leaveType: string;
  reason: string;
  notes: string;
}

export const EMPTY_LEAVE: LeaveBuffer = {
  startDate: "",
  endDate: "",
  leaveType: "annual_leave",
  reason: "",
  notes: "",
};

export function leaveBufferFrom(row: ClinicalLeaveRow | undefined): LeaveBuffer {
  if (!row) return EMPTY_LEAVE;
  return {
    startDate: row.startDate,
    endDate: row.endDate,
    leaveType: row.leaveType,
    reason: row.reason ?? "",
    notes: row.notes ?? "",
  };
}

/**
 * Mirrors `valid_leave_dates` (end >= start) and the RPC's length limits.
 * Overlap is again left to the server: `no_overlapping_doctor_leaves` is keyed
 * on the doctor and the date range and ignores status, so a local guess would
 * not match what the constraint enforces.
 */
export function validateLeave(buf: LeaveBuffer): FieldErrors {
  const errors: FieldErrors = {};
  if (!DATE_RE.test(buf.startDate)) errors.startDate = "Pick a start date.";
  if (!DATE_RE.test(buf.endDate)) errors.endDate = "Pick an end date.";
  if (!errors.startDate && !errors.endDate && buf.endDate < buf.startDate) {
    errors.endDate = "End date must be on or after the start date.";
  }
  if (!LEAVE_TYPE_OPTIONS.some((o) => o.value === buf.leaveType)) {
    errors.leaveType = "Choose a leave type.";
  }
  if (buf.reason.trim().length > 500) {
    errors.reason = "Reason must be 500 characters or fewer.";
  }
  if (buf.notes.trim().length > 2000) {
    errors.notes = "Notes must be 2000 characters or fewer.";
  }
  return errors;
}

function LeaveTab({
  hospitalId,
  snapshot,
  reload,
  notify,
}: {
  hospitalId: string;
  snapshot: ClinicalConfigurationSnapshot;
  reload: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const [doctorId, setDoctorId] = useState<string>(
    snapshot.doctors[0]?.doctorId ?? "",
  );
  const [buf, setBuf] = useState<LeaveBuffer>(EMPTY_LEAVE);
  const [editId, setEditId] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});

  const rows = snapshot.leaves.filter((l) => l.doctorId === doctorId);

  const saveAct = useAsyncAction(async (key: string) => {
    if (!doctorId) throw new Error("Choose a doctor first");
    return upsertLeave(hospitalId, key, {
      doctorId,
      leaveId: editId,
      startDate: buf.startDate,
      endDate: buf.endDate,
      leaveType: buf.leaveType,
      reason: buf.reason.trim(),
      notes: buf.notes.trim(),
    });
  });
  const cancelAct = useAsyncAction(
    async (key: string, row: ClinicalLeaveRow) => cancelLeave(hospitalId, key, row.id),
  );

  const submit = async () => {
    const found = validateLeave(buf);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const res = await saveAct.run();
    if (res === null) return;
    saveAct.reset();
    setEditId(null);
    setBuf(EMPTY_LEAVE);
    notify(editId ? "Leave window updated." : "Leave recorded.");
    await reload();
  };

  const cancel = async (row: ClinicalLeaveRow) => {
    const res = await cancelAct.run(row);
    if (res === null) return;
    cancelAct.reset();
    notify(
      "Leave cancelled. The dates are released, so the doctor is available again.",
    );
    await reload();
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Approved leave</CardTitle>
          <CardDescription>
            Leave recorded here is approved immediately by the acting admin,
            because approved is the only state the availability engine honours -
            a pending row would still let patients book a doctor who is away.
            Cancelling releases the dates.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="cc-leave-doctor">Doctor</Label>
            <select
              id="cc-leave-doctor"
              value={doctorId}
              data-testid="cc-leave-doctor"
              onChange={(e) => {
                setDoctorId(e.target.value);
                setEditId(null);
                setBuf(EMPTY_LEAVE);
              }}
              className="h-10 w-full max-w-md rounded-md border border-input bg-background px-3 text-sm"
            >
              {snapshot.doctors.length === 0 ? (
                <option value="">No doctors configured</option>
              ) : null}
              {snapshot.doctors.map((d) => (
                <option key={d.doctorId} value={d.doctorId}>
                  {doctorLabel(d)}
                </option>
              ))}
            </select>
          </div>

          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="cc-leave-empty">
              No leave recorded for this doctor.
            </p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Dates</TH>
                  <TH>Type</TH>
                  <TH>Status</TH>
                  <TH>Reason</TH>
                  <TH>Actions</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((l) => (
                  <TR key={l.id} data-testid={`cc-leave-row-${l.id}`}>
                    <TD className="font-mono text-xs">
                      {l.startDate} → {l.endDate}
                    </TD>
                    <TD>{l.leaveType.replace(/_/g, " ")}</TD>
                    <TD>
                      <Badge
                        variant={l.leaveStatus === "approved" ? "warning" : "secondary"}
                      >
                        {l.leaveStatus}
                      </Badge>
                    </TD>
                    <TD className="text-xs text-muted-foreground">
                      {l.reason ?? "—"}
                    </TD>
                    <TD>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setEditId(l.id);
                            setBuf(leaveBufferFrom(l));
                            setErrors({});
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={l.leaveStatus === "cancelled" || cancelAct.running}
                          data-testid={`cc-leave-cancel-${l.id}`}
                          onClick={() => void cancel(l)}
                        >
                          Cancel leave
                        </Button>
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          {cancelAct.error ? (
            <p role="alert" className="text-sm text-destructive">
              {describeError(cancelAct.error)}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{editId ? "Edit leave window" : "Record leave"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <div className="space-y-1">
              <Label htmlFor="cc-leave-start">From</Label>
              <Input
                id="cc-leave-start"
                type="date"
                value={buf.startDate}
                onChange={(e) => setBuf((b) => ({ ...b, startDate: e.target.value }))}
              />
              {errors.startDate ? (
                <p className="text-xs text-destructive">{errors.startDate}</p>
              ) : null}
            </div>
            <div className="space-y-1">
              <Label htmlFor="cc-leave-end">To</Label>
              <Input
                id="cc-leave-end"
                type="date"
                value={buf.endDate}
                onChange={(e) => setBuf((b) => ({ ...b, endDate: e.target.value }))}
              />
              {errors.endDate ? (
                <p className="text-xs text-destructive">{errors.endDate}</p>
              ) : null}
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="cc-leave-type">Type</Label>
            <select
              id="cc-leave-type"
              value={buf.leaveType}
              data-testid="cc-leave-type"
              onChange={(e) => setBuf((b) => ({ ...b, leaveType: e.target.value }))}
              className="h-10 w-full max-w-md rounded-md border border-input bg-background px-3 text-sm"
            >
              {LEAVE_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {errors.leaveType ? (
              <p className="text-xs text-destructive">{errors.leaveType}</p>
            ) : null}
          </div>
          <Field
            id="cc-leave-reason"
            label="Reason"
            value={buf.reason}
            error={errors.reason}
            onChange={(v) => setBuf((b) => ({ ...b, reason: v }))}
          />
          <Field
            id="cc-leave-notes"
            label="Notes"
            value={buf.notes}
            error={errors.notes}
            onChange={(v) => setBuf((b) => ({ ...b, notes: v }))}
          />
          <Button
            onClick={() => void submit()}
            disabled={saveAct.running || !doctorId}
            data-testid="cc-leave-save"
          >
            {saveAct.running ? "Saving…" : editId ? "Save leave" : "Record leave"}
          </Button>
          {saveAct.error ? (
            <p role="alert" className="text-sm text-destructive">
              {describeError(saveAct.error)}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Shared field ────────────────────────────────────────────────────────────

function Field({
  id,
  label,
  value,
  error,
  hint,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  error?: string | undefined;
  hint?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
      {hint && !error ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

type Tab = "departments" | "doctors" | "schedules" | "leave";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "departments", label: "Departments" },
  { id: "doctors", label: "Doctors" },
  { id: "schedules", label: "Schedules" },
  { id: "leave", label: "Leave" },
];

export function ClinicalConfiguration() {
  const { staff, hospitalId } = useAuth();
  const canAccess =
    staff?.role === "hospital_admin" || staff?.role === "global_admin";

  const [snapshot, setSnapshot] = useState<ClinicalConfigurationSnapshot | null>(
    null,
  );
  const [fatal, setFatal] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const [tab, setTab] = useState<Tab>("departments");
  const [banner, setBanner] = useState<string | null>(null);
  const hasData = useRef(false);

  /**
   * Reload the whole snapshot (one read serves all four tabs, so a write in any
   * tab refreshes the others too).
   *
   * A failed refresh WITH data already on screen keeps showing that data and
   * reports the failure separately. Reverting to a full-page spinner would
   * discard the row the operator is mid-edit on - and swallowing the error
   * would hide a genuine read failure, so neither is done.
   */
  const reload = useCallback(async () => {
    if (!hospitalId || !canAccess) return;
    setPending(true);
    try {
      const next = await getClinicalConfiguration(hospitalId);
      setSnapshot(next);
      setFatal(null);
      setRefreshError(null);
      hasData.current = true;
    } catch (err) {
      const message = describeError(err);
      if (hasData.current) setRefreshError(message);
      else setFatal(message);
    } finally {
      setPending(false);
    }
  }, [hospitalId, canAccess]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const notify = useCallback((message: string) => setBanner(message), []);

  if (!canAccess) {
    return (
      <div className="p-8 text-muted-foreground">
        Clinical configuration is for hospital administrators.
      </div>
    );
  }
  if (!hospitalId) {
    return (
      <div className="p-8 text-muted-foreground">
        Waiting for a request context (no acting hospital).
      </div>
    );
  }
  if (pending && !snapshot) {
    return <div className="p-8 text-muted-foreground">Loading clinical setup…</div>;
  }
  if (!snapshot) {
    return (
      <div className="p-8 space-y-3">
        <Badge variant="destructive">Failed to load</Badge>
        <p className="text-sm text-muted-foreground">{fatal}</p>
        <Button variant="outline" onClick={() => void reload()}>
          Retry
        </Button>
      </div>
    );
  }

  const snap = snapshot;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          Clinical Configuration
        </h1>
        <p className="text-sm text-muted-foreground">
          Hospital <span className="font-mono">{snap.hospitalId}</span> ·
          departments, doctors, weekly schedules and leave. Changes here drive
          real availability.
        </p>
      </div>

      {banner ? (
        <div
          role="status"
          className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
          data-testid="cc-banner"
        >
          <span>{banner}</span>
          <Button size="sm" variant="ghost" onClick={() => setBanner(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}

      {refreshError ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-md border border-destructive bg-destructive/5 px-3 py-2 text-sm text-destructive"
          data-testid="cc-refresh-error"
        >
          <span>
            The displayed data may be out of date: {refreshError}
          </span>
          <Button size="sm" variant="outline" onClick={() => void reload()}>
            Retry refresh
          </Button>
        </div>
      ) : null}

      <div role="tablist" className="flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            data-testid={`cc-tab-${t.id}`}
            className={
              "border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground " +
              (tab === t.id ? "border-primary text-foreground" : "")
            }
            onClick={() => {
              setTab(t.id);
              setBanner(null);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "departments" ? (
        <DepartmentsTab
          hospitalId={hospitalId}
          departments={snap.departments}
          reload={reload}
          notify={notify}
        />
      ) : null}
      {tab === "doctors" ? (
        <DoctorsTab
          hospitalId={hospitalId}
          snapshot={snap}
          reload={reload}
          notify={notify}
        />
      ) : null}
      {tab === "schedules" ? (
        <SchedulesTab
          hospitalId={hospitalId}
          snapshot={snap}
          reload={reload}
          notify={notify}
        />
      ) : null}
      {tab === "leave" ? (
        <LeaveTab
          hospitalId={hospitalId}
          snapshot={snap}
          reload={reload}
          notify={notify}
        />
      ) : null}
    </div>
  );
}
