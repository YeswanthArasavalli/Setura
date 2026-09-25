import { supabase } from "@/lib/supabase";

/**
 * Read-only data via PostgREST under RLS (Phase 6 §17/§21/§32).
 *
 * These tables expose SELECT policies that already scope rows to the caller's
 * hospital (patients/queue_sessions: user_has_hospital_access; bookings:
 * hospital_admin|receptionist see their hospital, doctors see assigned rows).
 * We add an explicit hospital_id filter defensively, but RLS — not the client —
 * is the enforcement boundary. Tables WITHOUT a SELECT policy for staff
 * (payment_ledger) are intentionally NOT read here; they are surfaced only
 * through Edge Functions / booking snapshot fields. consultation_notes gained
 * exactly such a staff SELECT policy in migration 63, so its note/diagnosis
 * text is read below — still through RLS only, never a service-role path.
 * notification_queue has carried a staff-readable SELECT policy since
 * migration 05 (`notif_queue_admin`, receptionist/hospital_admin +
 * global_admin, tenant-scoped), so its delivery-status lifecycle is read
 * below for the read-only Notifications surface (Phase 7).
 */

export interface PatientRow {
  id: string;
  hospital_id: string;
  full_name: string;
  normalized_phone: string;
  age: number | null;
  gender: string | null;
  village: string | null;
  total_visits: number | null;
  last_visit_date: string | null;
}

export interface BookingRow {
  id: string;
  hospital_id: string;
  queue_session_id: string | null;
  patient_id: string;
  patient_name: string;
  patient_phone: string;
  token_number: number | null;
  status: string;
  booking_source: string;
  assigned_doctor_id: string | null;
  appointment_date: string;
  booking_reference: string | null;
  estimated_wait_minutes: number | null;
  // Fee / payment snapshot written by the backend (never computed here).
  platform_fee_snapshot: number | null;
  receptionist_fee_snapshot: number | null;
  hospital_fee_snapshot: number | null;
  total_amount_snapshot: number | null;
  booking_fee_inr: number | null;
  payment_completed: boolean;
  payment_reference: string | null;
  payment_status_detail: string | null;
  consultation_started_at: string | null;
  consultation_completed_at: string | null;
  // Cancellation outcome, written by `cancel-booking` (and the refund path):
  // authoritative text + timestamp, never derived on the client.
  cancellation_reason: string | null;
  cancelled_at: string | null;
  created_at: string;
}

function asArray<T>(rows: unknown): T[] {
  return (rows ?? []) as T[];
}

/** Find-or-confirm an existing patient by name/phone fragment (tenant-scoped). */
export async function searchPatients(
  hospitalId: string,
  term: string,
  limit = 20,
): Promise<PatientRow[]> {
  const q = term.trim();
  let query = supabase
    .from("patients")
    .select(
      "id,hospital_id,full_name,normalized_phone,age,gender,village,total_visits,last_visit_date",
    )
    .eq("hospital_id", hospitalId)
    .eq("is_deleted", false)
    .limit(limit);

  if (q) {
    const like = `%${q.replace(/[%_]/g, "")}%`;
    query = query.or(`full_name.ilike.${like},normalized_phone.like.${like}`);
  }

  const { data, error } = await query;
  if (error) throw error;
  return asArray<PatientRow>(data);
}

/** Today's bookings for the reception dashboard (token/queue context). */
export async function listTodaysBookings(
  hospitalId: string,
  date: string,
): Promise<BookingRow[]> {
  const { data, error } = await supabase
    .from("bookings")
    .select(BOOKING_SELECT)
    .eq("hospital_id", hospitalId)
    .eq("appointment_date", date)
    .eq("is_deleted", false)
    .order("token_number", { ascending: true });
  if (error) throw error;
  return asArray<BookingRow>(data);
}

/** Full authorized history for one patient (Phase 6 §17). */
export async function listPatientHistory(
  hospitalId: string,
  patientId: string,
  limit = 50,
): Promise<BookingRow[]> {
  const { data, error } = await supabase
    .from("bookings")
    .select(BOOKING_SELECT)
    .eq("hospital_id", hospitalId)
    .eq("patient_id", patientId)
    .order("appointment_date", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return asArray<BookingRow>(data);
}

/** Single booking (billing/payment state + consultation context). */
export async function getBooking(
  hospitalId: string,
  bookingId: string,
): Promise<BookingRow | null> {
  const { data, error } = await supabase
    .from("bookings")
    .select(BOOKING_SELECT)
    .eq("hospital_id", hospitalId)
    .eq("id", bookingId)
    .maybeSingle();
  if (error) throw error;
  return (data as BookingRow) ?? null;
}

export interface ConsultationNoteRow {
  id: string;
  booking_id: string;
  doctor_id: string | null;
  notes: string;
  diagnosis_summary: string | null;
  created_at: string;
}

/**
 * Append-only clinical notes of one booking (migration 63 read surface).
 *
 * Faithful pass-through: no reformatting, no summarising, no client-side
 * inference. RLS (consultation_notes_staff_read) decides visibility — an
 * unauthorized or cross-tenant caller simply gets zero rows, so the caller
 * must never treat "empty" as "does not exist".
 */
export async function listConsultationNotes(
  hospitalId: string,
  bookingId: string,
): Promise<ConsultationNoteRow[]> {
  const { data, error } = await supabase
    .from("consultation_notes")
    .select(
      "id,booking_id,doctor_id,notes,diagnosis_summary,created_at",
    )
    .eq("hospital_id", hospitalId)
    .eq("booking_id", bookingId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return asArray<ConsultationNoteRow>(data);
}

export interface NotificationRow {
  id: string;
  hospital_id: string;
  patient_id: string | null;
  booking_id: string | null;
  channel: string;
  priority: string;
  status: string;
  recipient: string;
  title: string | null;
  retry_count: number;
  scheduled_for: string;
  sent_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  last_error: string | null;
  created_at: string;
}

/**
 * Recent notifications for the tenant (Phase 7 read-only delivery-status
 * surface).
 *
 * Reads `notification_queue` — the canonical notification lifecycle table whose
 * `channel` enum already includes WhatsApp-bound sends, so a single read gives
 * the full queued → sent → delivered / failed story for every channel without
 * touching the conversational `whatsapp_messages` engine (out of scope). RLS
 * (`notif_queue_admin`, migration 05) decides visibility: an unauthorized or
 * cross-tenant caller simply gets zero rows, so "empty" must never be read as
 * "does not exist". This is a SELECT-only surface — no retry/resend/cancel.
 */
export async function listNotifications(
  hospitalId: string,
  limit = 100,
): Promise<NotificationRow[]> {
  const { data, error } = await supabase
    .from("notification_queue")
    .select(
      "id,hospital_id,patient_id,booking_id,channel,priority,status,recipient,title,retry_count,scheduled_for,sent_at,delivered_at,failed_at,last_error,created_at",
    )
    .eq("hospital_id", hospitalId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return asArray<NotificationRow>(data);
}

export interface HospitalDoctorOption {
  doctorId: string;
  specialization: string;
  consultationFee: number;
  /** Populated whenever the caller's RLS exposes `profiles` (see
   *  `profiles_staff_read_doctors`, migration 61). We never fabricate a name
   *  client-side, so a null here means the directory row genuinely was not
   *  readable and the label falls back to the specialization. */
  doctorName: string | null;
  /** Ready-to-render picker label: the doctor name plus specialty when the
   *  name is readable, otherwise the specialization alone (name + specialty
   *  used to render as a duplicated token for single-specialty doctors). */
  label: string;
}

/**
 * List assignable doctors for the tenant (Phase 6 §10/§11).
 *
 * A booking only enters a doctor's *callable* queue when a `doctorId` is
 * supplied — `create-booking` resolves/creates the queue session solely for a
 * doctor-assigned booking, so a doctor-less walk-in gets a token but is not
 * reachable by the Doctor Console. This read uses the existing
 * `doctor_specializations` SELECT policy (`user_has_hospital_access`); the
 * doctor's human name is embedded via `profiles` and is readable by any
 * same-hospital staff member since migration 61 (it stays null only if that
 * policy is somehow not in effect, in which case the label degrades to the
 * specialization).
 */
export async function listHospitalDoctors(
  hospitalId: string,
): Promise<HospitalDoctorOption[]> {
  const { data, error } = await supabase
    .from("doctor_specializations")
    .select(
      "doctor_id,specialization_name,consultation_fee,profiles(full_name)",
    )
    .eq("hospital_id", hospitalId)
    .eq("is_deleted", false)
    .order("specialization_name", { ascending: true });
  if (error) throw error;
  const rows = asArray<{
    doctor_id: string;
    specialization_name: string;
    consultation_fee: number;
    profiles: { full_name: string | null } | null;
  }>(data);
  // A doctor may hold several specializations → collapse to one option per
  // doctor id (first specialization is representative for the picker).
  const byId = new Map<string, HospitalDoctorOption>();
  for (const r of rows) {
    if (!byId.has(r.doctor_id)) {
      const doctorName = r.profiles?.full_name ?? null;
      byId.set(r.doctor_id, {
        doctorId: r.doctor_id,
        specialization: r.specialization_name,
        consultationFee: Number(r.consultation_fee ?? 0),
        doctorName,
        label: doctorName
          ? `${doctorName} · ${r.specialization_name}`
          : r.specialization_name,
      });
    }
  }
  return [...byId.values()];
}

/**
 * Doctor id → human name for a set of ids already visible to the caller
 * (migration 61). Used to label queue sessions, which are per-doctor and
 * otherwise indistinguishable to reception. Read-only; no hospital filter is
 * applied because `profiles` is not hospital-keyed — RLS
 * (profiles_staff_read_doctors) only ever exposes doctors sharing a hospital
 * with the caller, so the result is tenant-scoped by construction.
 */
export async function listDoctorNames(
  doctorIds: string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(doctorIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase
    .from("profiles")
    .select("id,full_name")
    .in("id", ids)
    .eq("is_active", true);
  if (error) throw error;
  const names = new Map<string, string>();
  for (const r of asArray<{ id: string; full_name: string | null }>(data)) {
    if (r.full_name) names.set(r.id, r.full_name);
  }
  return names;
}

const BOOKING_SELECT =
  "id,hospital_id,queue_session_id,patient_id,patient_name,patient_phone,token_number,status,booking_source,assigned_doctor_id,appointment_date,booking_reference,estimated_wait_minutes,platform_fee_snapshot,receptionist_fee_snapshot,hospital_fee_snapshot,total_amount_snapshot,booking_fee_inr,payment_completed,payment_reference,payment_status_detail,consultation_started_at,consultation_completed_at,cancellation_reason,cancelled_at,created_at";
