/**
 * types.ts — Shared runtime types and Database type definitions
 *
 * Database type is generated from the live schema (all 37 migrations)
 * into database.generated.ts - regenerate with `deno task gen:types`.
 * API DTOs are separate from DB types — never leak DB columns to API responses.
 */

// ─── Database enums (mirror SQL enums exactly) ────────────────────────────────

export type UserRoleType =
  | "global_admin"
  | "hospital_admin"
  | "doctor"
  | "receptionist";

export type BookingStatus =
  | "booked"
  | "checked_in"
  | "waiting"
  | "called"
  | "in_consultation"
  | "completed"
  | "cancelled"
  | "no_show"
  | "rescheduled"
  | "skipped";

export type BookingSource =
  | "online"
  | "manual_free"
  | "manual_whatsapp"
  | "walkin";

export type NotificationChannel =
  | "whatsapp"
  | "sms"
  | "push"
  | "email"
  | "internal";
export type NotificationStatus =
  | "pending"
  | "queued"
  | "processing"
  | "sent"
  | "delivered"
  | "read"
  | "failed"
  | "retrying"
  | "cancelled"
  | "permanently_failed";
export type NotificationPriority = "low" | "medium" | "high" | "critical";

export type JobStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "dead";
export type JobPriority = "low" | "normal" | "high" | "critical";

export type SettlementStatus =
  | "pending"
  | "partially_paid"
  | "paid"
  | "overdue"
  | "disputed";

export type WaMessageStatus =
  | "queued"
  | "processing"
  | "sent"
  | "delivered"
  | "read"
  | "failed"
  | "retrying"
  | "permanently_failed";

export type WaMessageDirection = "incoming" | "outgoing";

// ─── Database table row types ─────────────────────────────────────────────────

export interface DbHospital {
  id: string;
  name: string;
  name_te: string | null;
  slug: string;
  phone: string | null;
  email: string | null;
  country: string;
  state: string;
  district: string | null;
  town: string;
  address: string | null;
  timezone: string;
  is_active: boolean;
  subscription_active: boolean;
  online_booking_enabled: boolean;
  max_advance_booking_days: number;
  deleted_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbProfile {
  id: string;
  full_name: string;
  normalized_phone: string | null;
  avatar_url: string | null;
  preferred_language: string;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbUserRole {
  id: string;
  user_id: string;
  hospital_id: string | null;
  role: UserRoleType;
  is_primary: boolean;
  created_at: string;
}

export interface DbPatient {
  id: string;
  hospital_id: string;
  full_name: string;
  normalized_phone: string;
  age: number | null;
  gender: string | null;
  village: string | null;
  blood_group: string | null;
  has_diabetes: boolean;
  has_bp: boolean;
  total_visits: number;
  last_visit_date: string | null;
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
}

export interface DbBooking {
  id: string;
  hospital_id: string;
  queue_session_id: string | null;
  patient_id: string | null;
  patient_name: string;
  patient_phone: string;
  patient_age: number | null;
  patient_gender: string | null;
  village: string | null;
  blood_group: string | null;
  has_diabetes: boolean;
  has_bp: boolean;
  token_number: number;
  priority_score: number;
  priority_flag: boolean;
  status: BookingStatus;
  booking_source: BookingSource;
  assigned_doctor_id: string | null;
  booked_by: string | null;
  appointment_date: string;
  checked_in_at: string | null;
  called_at: string | null;
  consultation_started_at: string | null;
  consultation_completed_at: string | null;
  cancelled_at: string | null;
  no_show_marked_at: string | null;
  carry_forwarded_from: string | null;
  is_carry_forward: boolean;
  cancellation_reason: string | null;
  platform_fee_snapshot: string;
  receptionist_fee_snapshot: string;
  hospital_fee_snapshot: string;
  total_amount_snapshot: string;
  payment_completed: boolean;
  payment_reference: string | null;
  whatsapp_confirmation_sent: boolean;
  whatsapp_reminder_sent: boolean;
  feedback_sent: boolean;
  estimated_wait_minutes: number | null;
  idempotency_key: string | null;
  booking_reference: string;
  metadata: Record<string, unknown>;
  is_deleted: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbQueueSession {
  id: string;
  hospital_id: string;
  doctor_id: string | null;
  session_date: string;
  session_name: string | null;
  max_tokens: number;
  current_live_token: number;
  is_active: boolean;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbHospitalSettings {
  id: string;
  hospital_id: string;
  platform_fee_online: string;
  platform_fee_whatsapp: string;
  receptionist_fee: string;
  online_booking_fee_enabled: boolean;
  max_tokens_per_day: number;
  allow_walkin_tokens: boolean;
  allow_online_booking: boolean;
  allow_carry_forward: boolean;
  send_whatsapp_confirmation: boolean;
  send_whatsapp_reminder: boolean;
  send_feedback_request: boolean;
  reminder_before_minutes: number;
  razorpay_key_id: string | null;
  payment_enabled: boolean;
  preferred_language: string;
  timezone: string;
}

export interface DbJobQueue {
  id: string;
  job_type: string;
  payload: Record<string, unknown>;
  priority: JobPriority;
  status: JobStatus;
  hospital_id: string | null;
  related_booking_id: string | null;
  scheduled_at: string;
  processing_started_at: string | null;
  processing_completed_at: string | null;
  worker_id: string | null;
  lease_expires_at: string | null;
  attempt_count: number;
  max_attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Supabase Database type (required by createClient<Database>) ─────────────
// Generated from the local database (all 37 migrations). Regenerate with:
//
//   deno task gen:types        (requires a running `supabase start` stack)
//
// Never hand-edit database.generated.ts. The API DTOs below stay
// hand-written - DB rows must never leak directly to API responses.

export type { Database, Json } from "./database.generated.ts";

// ─── API request/response DTOs ────────────────────────────────────────────────

export interface AuthContext {
  userId: string;
  hospitalId: string | null;
  role: UserRoleType | null;
  jwt: string;
  profile: DbProfile;
}

export interface RequestContext {
  correlationId: string;
  requestId: string;
  startTime: number;
  ip: string | null;
  userAgent: string | null;
  auth: AuthContext | null;
}

// Create booking request (validated by Zod in validation.ts)
export interface CreateBookingRequest {
  hospitalId: string;
  queueSessionId?: string;
  patientName: string;
  patientPhone: string;
  patientAge?: number;
  patientGender?: "M" | "F" | "Other";
  village?: string;
  bloodGroup?: string;
  hasDiabetes: boolean;
  hasBp: boolean;
  bookingSource: BookingSource;
  doctorId?: string;
  appointmentDate: string; // ISO date: "2025-06-15"
}

export interface CreateBookingResponse {
  bookingId: string;
  tokenNumber: number;
  bookingReference: string;
  estimatedWaitMinutes: number | null;
  patientId: string;
  appointmentDate: string;
  queueSessionId: string | null;
  fees: {
    platformFee: number;
    receptionistFee: number;
    hospitalFee: number;
    totalAmount: number;
  };
}

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: PaginationMeta;
}
