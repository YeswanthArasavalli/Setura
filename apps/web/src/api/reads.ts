import { supabase } from "@/lib/supabase";

/**
 * Read-only data via PostgREST under RLS (Phase 6 §17/§21/§32).
 *
 * These tables expose SELECT policies that already scope rows to the caller's
 * hospital (patients/queue_sessions: user_has_hospital_access; bookings:
 * hospital_admin|receptionist see their hospital, doctors see assigned rows).
 * We add an explicit hospital_id filter defensively, but RLS — not the client —
 * is the enforcement boundary. Tables WITHOUT a SELECT policy for staff
 * (payment_ledger, notifications) are intentionally NOT read here; they are
 * surfaced only through Edge Functions / booking snapshot fields.
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

export interface HospitalDoctorOption {
  doctorId: string;
  specialization: string;
  consultationFee: number;
  /** Only populated for roles whose RLS allows reading `profiles` (e.g.
   *  hospital_admin); a receptionist sees null — so the UI must fall back to
   *  the specialization label. We never fabricate a name client-side. */
  doctorName: string | null;
}

/**
 * List assignable doctors for the tenant (Phase 6 §10/§11).
 *
 * A booking only enters a doctor's *callable* queue when a `doctorId` is
 * supplied — `create-booking` resolves/creates the queue session solely for a
 * doctor-assigned booking, so a doctor-less walk-in gets a token but is not
 * reachable by the Doctor Console. This read uses the existing
 * `doctor_specializations` SELECT policy (`user_has_hospital_access`); the
 * doctor's human name is embedded via `profiles` and will simply be null when
 * the caller's RLS does not expose it.
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
      byId.set(r.doctor_id, {
        doctorId: r.doctor_id,
        specialization: r.specialization_name,
        consultationFee: Number(r.consultation_fee ?? 0),
        doctorName: r.profiles?.full_name ?? null,
      });
    }
  }
  return [...byId.values()];
}

const BOOKING_SELECT =
  "id,hospital_id,queue_session_id,patient_id,patient_name,patient_phone,token_number,status,booking_source,assigned_doctor_id,appointment_date,booking_reference,estimated_wait_minutes,platform_fee_snapshot,receptionist_fee_snapshot,hospital_fee_snapshot,total_amount_snapshot,booking_fee_inr,payment_completed,payment_reference,payment_status_detail,consultation_started_at,consultation_completed_at,created_at";
