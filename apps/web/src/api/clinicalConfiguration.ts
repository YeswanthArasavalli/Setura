import { supabase } from "@/lib/supabase";
import { callFunction } from "@/lib/api";
import type { ClinicalConfigurationResponseBody } from "@/types/api";

/**
 * WS-ONBOARD-4 - Doctor, Department, Schedule & Leave Configuration boundary.
 *
 * Two deliberately different transports, matching the established console:
 *
 *  1. READS go straight to PostgREST under RLS (like `api/reads.ts`). The
 *     tenant's `departments`, `doctor_departments`, `doctor_schedules` and
 *     `doctor_leaves` rows carry SELECT-only policies
 *     (`is_global_admin() OR user_has_hospital_access(hospital_id)`, plus the
 *     pre-existing migration-03 read policies on schedules/leaves), so the
 *     browser can see its own tenant's configuration and nothing else. The
 *     `authenticated` role holds SELECT and NO write privilege on the two new
 *     tables - there is no client path that mutates a department row.
 *
 *  2. WRITES go through the `clinical-configuration` Edge Function, which
 *     re-resolves the JWT, re-checks `requireRole` + X-Hospital-ID, enforces
 *     the Idempotency-Key guard and calls the service-role-only SECURITY
 *     DEFINER RPCs of migration 68. The frontend owns NOTHING of the write
 *     path: no overlap maths, no version arithmetic, no tenant assumption.
 *
 * Fields the availability/token runtime does not consume
 * (`doctor_schedules.buffer_minutes`, `is_walkin_allowed`,
 * `doctor_leaves.auto_cancel_bookings`, `rejection_reason`, `metadata`) are
 * NOT selected and NOT editable here. Surfacing a control that changes no
 * behavior would be a fake configuration screen; those columns stay owned by
 * the runtime workstream that consumes them.
 */

const FN = "clinical-configuration";

// ─── Read shapes (RLS-projected columns only) ────────────────────────────────

export interface ClinicalDepartmentRow {
  id: string;
  name: string;
  code: string;
  description: string | null;
  isActive: boolean;
  /** Optimistic-concurrency version; send back as `expectedVersion`. */
  version: number;
}

export interface ClinicalSpecializationRow {
  doctorId: string;
  name: string;
  /** Informational: the collected booking fee comes from the fee policy /
   *  hospital settings, never from this column (migrations 28/35). */
  consultationFee: number;
  averageConsultationMinutes: number;
}

export interface ClinicalDoctorRow {
  doctorId: string;
  /** Null when the caller's RLS cannot see the profile - a global_admin with
   *  no role row in this hospital is exactly that case, and the label
   *  degrades to the specialization / id prefix, as the booking picker
   *  already does (see `listHospitalDoctors`). */
  fullName: string | null;
  normalizedPhone: string | null;
  isActive: boolean;
  specializations: ClinicalSpecializationRow[];
  departmentIds: string[];
}

export interface ClinicalScheduleRow {
  id: string;
  doctorId: string;
  /** 0 = Sunday … 6 = Saturday, exactly as the DB CHECK allows. */
  weekday: number;
  startTime: string;
  endTime: string;
  maxTokens: number;
  averageConsultationMinutes: number;
  isActive: boolean;
}

export interface ClinicalLeaveRow {
  id: string;
  doctorId: string;
  startDate: string;
  endDate: string;
  leaveType: string;
  leaveStatus: string;
  reason: string | null;
  notes: string | null;
  approvedAt: string | null;
}

export interface ClinicalConfigurationSnapshot {
  hospitalId: string;
  departments: ClinicalDepartmentRow[];
  doctors: ClinicalDoctorRow[];
  schedules: ClinicalScheduleRow[];
  leaves: ClinicalLeaveRow[];
}

function asArray<T>(rows: unknown): T[] {
  return (rows ?? []) as T[];
}

async function readDepartments(
  hospitalId: string,
): Promise<ClinicalDepartmentRow[]> {
  const { data, error } = await supabase
    .from("departments")
    .select("id,name,code,description,is_active,version")
    .eq("hospital_id", hospitalId)
    .eq("is_deleted", false)
    .order("name", { ascending: true });
  if (error) throw error;
  return asArray<{
    id: string;
    name: string;
    code: string;
    description: string | null;
    is_active: boolean;
    version: number;
  }>(data).map((r) => ({
    id: r.id,
    name: r.name,
    code: r.code,
    description: r.description ?? null,
    isActive: r.is_active,
    version: r.version,
  }));
}

type RawSpecialization = {
  doctor_id: string;
  specialization_name: string;
  consultation_fee: number;
  average_consultation_minutes: number;
};
type RawAssignment = { doctor_id: string; department_id: string };
type RawSchedule = {
  id: string;
  doctor_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  max_tokens: number;
  average_consultation_minutes: number;
  is_active: boolean;
};
type RawLeave = {
  id: string;
  doctor_id: string;
  leave_start_date: string;
  leave_end_date: string;
  leave_type: string;
  leave_status: string;
  reason: string | null;
  notes: string | null;
  approved_at: string | null;
};

/**
 * The doctor roster source.
 *
 * A doctor IS `profiles` + a `user_roles('doctor')` row - there is no `doctors`
 * table and this module does not invent one. `user_roles` is not readable by a
 * hospital_admin under RLS (`user_roles_read` = own row only), so the roster is
 * assembled from the clinical tables that DO carry tenant read policies:
 * specializations, department assignments, schedules and leaves. The union is
 * the complete set of doctors with any configuration in this hospital, and
 * every doctor this page creates also gets at least one specialization row (the
 * booking picker only offers doctors that have one), so no configured doctor can
 * be missing from it.
 */
async function readClinicalRows(hospitalId: string): Promise<{
  specializations: RawSpecialization[];
  assignments: RawAssignment[];
  schedules: RawSchedule[];
  leaves: RawLeave[];
}> {
  const [spec, assign, sched, leave] = await Promise.all([
    supabase
      .from("doctor_specializations")
      .select(
        "doctor_id,specialization_name,consultation_fee,average_consultation_minutes",
      )
      .eq("hospital_id", hospitalId)
      .eq("is_deleted", false)
      .order("specialization_name", { ascending: true }),
    supabase
      .from("doctor_departments")
      .select("doctor_id,department_id")
      .eq("hospital_id", hospitalId),
    supabase
      .from("doctor_schedules")
      .select(
        "id,doctor_id,weekday,start_time,end_time,max_tokens,average_consultation_minutes,is_active",
      )
      .eq("hospital_id", hospitalId)
      .eq("is_deleted", false)
      .order("weekday", { ascending: true }),
    supabase
      .from("doctor_leaves")
      .select(
        "id,doctor_id,leave_start_date,leave_end_date,leave_type,leave_status,reason,notes,approved_at",
      )
      .eq("hospital_id", hospitalId)
      .eq("is_deleted", false)
      .order("leave_start_date", { ascending: false }),
  ]);
  for (const r of [spec, assign, sched, leave]) if (r.error) throw r.error;
  return {
    specializations: asArray<RawSpecialization>(spec.data),
    assignments: asArray<RawAssignment>(assign.data),
    schedules: asArray<RawSchedule>(sched.data),
    leaves: asArray<RawLeave>(leave.data),
  };
}

/** Profile rows for exactly the ids the clinical tables already exposed, so
 *  the read never asks RLS for anything beyond those doctors. */
async function readProfiles(
  doctorIds: string[],
): Promise<
  Map<string, { fullName: string | null; phone: string | null; isActive: boolean }>
> {
  const map = new Map<
    string,
    { fullName: string | null; phone: string | null; isActive: boolean }
  >();
  if (doctorIds.length === 0) return map;
  const { data, error } = await supabase
    .from("profiles")
    .select("id,full_name,normalized_phone,is_active")
    .in("id", doctorIds);
  if (error) throw error;
  for (const r of asArray<{
    id: string;
    full_name: string | null;
    normalized_phone: string | null;
    is_active: boolean;
  }>(data)) {
    map.set(r.id, {
      fullName: r.full_name ?? null,
      phone: r.normalized_phone ?? null,
      isActive: r.is_active,
    });
  }
  return map;
}

/**
 * One snapshot for the whole page. The four tabs render from this object, so a
 * tab switch is never a second round trip and a mutation reload refreshes every
 * tab at once (a schedule write can change what the Leave tab shows for the same
 * doctor, and vice versa).
 */
export async function getClinicalConfiguration(
  hospitalId: string,
): Promise<ClinicalConfigurationSnapshot> {
  const [departments, rows] = await Promise.all([
    readDepartments(hospitalId),
    readClinicalRows(hospitalId),
  ]);

  const ids = new Set<string>();
  for (const r of rows.specializations) ids.add(r.doctor_id);
  for (const r of rows.assignments) ids.add(r.doctor_id);
  for (const r of rows.schedules) ids.add(r.doctor_id);
  for (const r of rows.leaves) ids.add(r.doctor_id);

  const profiles = await readProfiles([...ids]);

  const byDoctor = new Map<string, ClinicalDoctorRow>();
  const doctor = (id: string): ClinicalDoctorRow => {
    let row = byDoctor.get(id);
    if (!row) {
      const p = profiles.get(id);
      row = {
        doctorId: id,
        fullName: p?.fullName ?? null,
        normalizedPhone: p?.phone ?? null,
        // A vanished/unreadable profile is never presented as active.
        isActive: p?.isActive ?? false,
        specializations: [],
        departmentIds: [],
      };
      byDoctor.set(id, row);
    }
    return row;
  };

  for (const r of rows.specializations) {
    doctor(r.doctor_id).specializations.push({
      doctorId: r.doctor_id,
      name: r.specialization_name,
      consultationFee: Number(r.consultation_fee ?? 0),
      averageConsultationMinutes: Number(r.average_consultation_minutes ?? 0),
    });
  }
  for (const r of rows.assignments) {
    doctor(r.doctor_id).departmentIds.push(r.department_id);
  }

  const doctors = [...byDoctor.values()].sort((a, b) =>
    (a.fullName ?? a.doctorId).localeCompare(b.fullName ?? b.doctorId),
  );

  return {
    hospitalId,
    departments,
    doctors,
    schedules: rows.schedules.map((r) => ({
      id: r.id,
      doctorId: r.doctor_id,
      weekday: r.weekday,
      startTime: r.start_time,
      endTime: r.end_time,
      maxTokens: r.max_tokens,
      averageConsultationMinutes: r.average_consultation_minutes,
      isActive: r.is_active,
    })),
    leaves: rows.leaves.map((r) => ({
      id: r.id,
      doctorId: r.doctor_id,
      startDate: r.leave_start_date,
      endDate: r.leave_end_date,
      leaveType: r.leave_type,
      leaveStatus: r.leave_status,
      reason: r.reason ?? null,
      notes: r.notes ?? null,
      approvedAt: r.approved_at ?? null,
    })),
  };
}

// ─── Writes: the ONLY path is the Edge Function ──────────────────────────────

/** Every write takes a REQUIRED idempotency key. `useAsyncAction` supplies a
 *  stable per-submission key, so a double click or a retry replays the stored
 *  result instead of creating a second department / schedule / leave. */
function write(
  hospitalId: string,
  idempotencyKey: string,
  body: Record<string, unknown>,
): Promise<ClinicalConfigurationResponseBody> {
  return callFunction<ClinicalConfigurationResponseBody>(FN, body, {
    hospitalId,
    idempotencyKey,
  });
}

export function createDepartment(
  hospitalId: string,
  idempotencyKey: string,
  input: { name: string; code: string; description?: string | null },
): Promise<ClinicalConfigurationResponseBody> {
  return write(hospitalId, idempotencyKey, {
    action: "department_create",
    name: input.name,
    code: input.code,
    description: input.description ?? null,
  });
}

export function updateDepartment(
  hospitalId: string,
  idempotencyKey: string,
  input: {
    departmentId: string;
    expectedVersion: number;
    name: string;
    code: string;
    description: string;
  },
): Promise<ClinicalConfigurationResponseBody> {
  return write(hospitalId, idempotencyKey, {
    action: "department_update",
    departmentId: input.departmentId,
    expectedVersion: input.expectedVersion,
    name: input.name,
    code: input.code,
    // Sent even when empty: the RPC clears the column for a non-NULL empty
    // value and leaves it untouched only when the key is absent.
    description: input.description,
  });
}

export function setDepartmentStatus(
  hospitalId: string,
  idempotencyKey: string,
  input: {
    departmentId: string;
    expectedVersion: number;
    isActive: boolean;
  },
): Promise<ClinicalConfigurationResponseBody> {
  return write(hospitalId, idempotencyKey, {
    action: "department_status_change",
    departmentId: input.departmentId,
    expectedVersion: input.expectedVersion,
    isActive: input.isActive,
  });
}

export interface ClinicalSpecializationInput {
  name: string;
  consultationFee?: number;
  averageConsultationMinutes?: number;
}

export function createDoctor(
  hospitalId: string,
  idempotencyKey: string,
  input: {
    fullName: string;
    email: string;
    /** Initial credential. Sent over HTTPS once, never rendered again and
     *  never returned by any read; the server strips it before logging and
     *  before the audit payload. */
    password: string;
    phone?: string | null;
    specializations: ClinicalSpecializationInput[];
    departmentIds: string[];
  },
): Promise<ClinicalConfigurationResponseBody> {
  return write(hospitalId, idempotencyKey, {
    action: "doctor_create",
    fullName: input.fullName,
    email: input.email,
    password: input.password,
    phone: input.phone ?? null,
    specializations: input.specializations,
    departmentIds: input.departmentIds,
  });
}

export function updateDoctor(
  hospitalId: string,
  idempotencyKey: string,
  input: {
    doctorId: string;
    fullName: string;
    phone: string;
    isActive: boolean;
    specializations: ClinicalSpecializationInput[];
    departmentIds: string[];
  },
): Promise<ClinicalConfigurationResponseBody> {
  return write(hospitalId, idempotencyKey, {
    action: "doctor_update",
    doctorId: input.doctorId,
    fullName: input.fullName,
    phone: input.phone,
    isActive: input.isActive,
    specializations: input.specializations,
    departmentIds: input.departmentIds,
  });
}

export function upsertSchedule(
  hospitalId: string,
  idempotencyKey: string,
  input: {
    doctorId: string;
    /** Absent for a new row; the RPC inserts when NULL. */
    scheduleId?: string | null;
    weekday: number;
    startTime: string;
    endTime: string;
    maxTokens: number;
    averageConsultationMinutes: number;
    isActive: boolean;
  },
): Promise<ClinicalConfigurationResponseBody> {
  return write(hospitalId, idempotencyKey, {
    action: "schedule_upsert",
    doctorId: input.doctorId,
    scheduleId: input.scheduleId ?? null,
    weekday: input.weekday,
    startTime: input.startTime,
    endTime: input.endTime,
    maxTokens: input.maxTokens,
    averageConsultationMinutes: input.averageConsultationMinutes,
    isActive: input.isActive,
  });
}

export function deleteSchedule(
  hospitalId: string,
  idempotencyKey: string,
  input: { doctorId: string; scheduleId: string },
): Promise<ClinicalConfigurationResponseBody> {
  return write(hospitalId, idempotencyKey, {
    action: "schedule_delete",
    doctorId: input.doctorId,
    scheduleId: input.scheduleId,
  });
}

export function upsertLeave(
  hospitalId: string,
  idempotencyKey: string,
  input: {
    doctorId: string;
    leaveId?: string | null;
    startDate: string;
    endDate: string;
    leaveType: string;
    reason?: string | null;
    notes?: string | null;
  },
): Promise<ClinicalConfigurationResponseBody> {
  return write(hospitalId, idempotencyKey, {
    action: "leave_upsert",
    doctorId: input.doctorId,
    leaveId: input.leaveId ?? null,
    startDate: input.startDate,
    endDate: input.endDate,
    leaveType: input.leaveType,
    reason: input.reason ?? null,
    notes: input.notes ?? null,
  });
}

export function cancelLeave(
  hospitalId: string,
  idempotencyKey: string,
  leaveId: string,
): Promise<ClinicalConfigurationResponseBody> {
  return write(hospitalId, idempotencyKey, {
    action: "leave_cancel",
    leaveId,
  });
}
