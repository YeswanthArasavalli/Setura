/**
 * Backend contract types — these MIRROR the response shapes produced by the
 * existing Edge Functions (see supabase/functions/_shared/response.ts and the
 * individual function handlers). The frontend deliberately owns NO business
 * rules; it only types what the backend already returns (Phase 6 §1/§24).
 */

// ─── Response envelope (response.ts) ─────────────────────────────────────────

export interface ApiSuccess<T> {
  success: true;
  data: T;
  correlationId: string;
  timestamp: string;
  meta?: Record<string, unknown>;
}

export interface ApiFailure {
  success: false;
  error: {
    code: string;
    message: string;
    fieldErrors?: Record<string, string[]>;
    retryable: boolean;
  };
  correlationId: string;
  timestamp: string;
}

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

// ─── Roles (auth.ts ROLE_HIERARCHY) ──────────────────────────────────────────

export type UserRole =
  | "global_admin"
  | "hospital_admin"
  | "doctor"
  | "receptionist";

// ─── create-booking (CreateBookingSchema / CreateBookingResponse) ──────────────

export type BookingSource =
  | "online"
  | "manual_free"
  | "manual_whatsapp"
  | "walkin";

export interface CreateBookingRequest {
  hospitalId: string;
  queueSessionId?: string | null;
  patientName: string;
  /** 10-digit Indian mobile; backend normalises + dedupes by it. */
  patientPhone: string;
  patientAge?: number | null;
  patientGender?: "M" | "F" | "Other" | null;
  village?: string | null;
  bloodGroup?: string | null;
  hasDiabetes?: boolean;
  hasBp?: boolean;
  bookingSource: BookingSource;
  doctorId?: string | null;
  /** YYYY-MM-DD */
  appointmentDate: string;
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

// ─── cancel-booking (Schema / successResponse) ───────────────────────────────

export interface CancelBookingRequest {
  bookingId: string;
  /** Staff free text. The backend enforces the 3–500 character boundary. */
  cancellationReason: string;
  /** Only a REQUEST for the existing backend refund path. The Edge Function
   *  decides whether a refund is valid and computes its amount (D16); the
   *  console never sends, derives or displays a refund figure. */
  initiateRefund: boolean;
}

export interface CancelBookingResponse {
  bookingId: string;
  cancelled: boolean;
  /** True on the idempotent replay of an already-cancelled booking. */
  alreadyCancelled: boolean;
  /** OPTIONAL BY CONTRACT: `cancel-booking` reports the refund outcome only on
   *  the response that actually performed the transition, so the already
   *  cancelled replay omits the field entirely. `undefined` therefore means
   *  “not reported”, never “no refund”. */
  refundInitiated?: boolean;
}

// ─── queue-control (snapshot / actions) ──────────────────────────────────────

export type QueueControlAction =
  | "pause"
  | "resume"
  | "recall"
  | "skip"
  | "restore"
  | "mark_absent"
  | "call"
  | "delay"
  | "clear_delay"
  | "snapshot";

export interface QueueControlRequest {
  queueSessionId: string;
  action: QueueControlAction;
  bookingId?: string;
  tokenNumber?: number;
  delayMinutes?: number;
  reason?: string;
}

// Mirrors QueueSnapshot in _shared/queue/queue_runtime.ts (subset used by UI).
export interface QueueSnapshot {
  session: {
    id: string;
    hospital_id: string;
    doctor_id: string | null;
    session_date: string;
    is_active: boolean;
    is_paused: boolean;
    pause_reason?: string | null;
    current_live_token: number;
    max_tokens: number;
    delay_expected_minutes?: number | null;
    delay_reason?: string | null;
    delay_started_at?: string | null;
  };
  average_consultation_minutes: number;
  currently_called: {
    booking_id: string;
    token_number: number;
    patient_name: string;
    called_at: string | null;
  } | null;
  waiting: Array<{
    booking_id: string;
    token_number: number;
    patient_name: string;
    status: string;
    position: number;
    estimated_wait_minutes: number;
  }>;
  counts: Record<string, number>;
  estimated_wait_next_minutes: number;
  generated_at: string;
}

export interface QueueControlResponse {
  action: QueueControlAction;
  queueSessionId: string;
  snapshot: QueueSnapshot;
  result?: Record<string, unknown>;
}

// ─── doctor-operations ───────────────────────────────────────────────────────

export type DoctorAction =
  | "start_session"
  | "end_session"
  | "break"
  | "resume"
  | "call_next"
  | "recall"
  | "skip"
  | "restore"
  | "mark_absent"
  | "start_consultation"
  | "complete_consultation"
  | "return_to_waiting"
  | "emergency_insert"
  | "save_note"
  | "dashboard";

export interface DoctorOperationsRequest {
  action: DoctorAction;
  queueSessionId?: string;
  bookingId?: string;
  patientName?: string;
  patientPhone?: string;
  reason?: string;
  notes?: string;
  diagnosisSummary?: string;
  followUpDate?: string;
  idempotencyKey?: string;
  doctorId?: string;
}

export interface DoctorDashboard {
  has_session: boolean;
  queue_session_id?: string;
  hospital_id?: string;
  doctor_id?: string;
  current_patient?: {
    booking_id: string;
    token_number: number | null;
    patient_name: string;
    status: string;
    called_at: string | null;
    consultation_started_at: string | null;
  } | null;
  next_patients?: Array<{
    booking_id: string;
    token_number: number | null;
    patient_name: string;
    position: number;
    estimated_wait_minutes: number | null;
  }>;
  counts?: Record<string, number>;
  avg_wait_minutes?: number | null;
  avg_consultation_minutes?: number | null;
  delay_status?: { delayed: boolean; delay_expected_minutes: number | null };
  pause_status?: { paused: boolean; reason: string | null };
  queue_utilization?: number;
  generated_at?: string;
}

export interface DoctorOperationsResponse {
  action: DoctorAction;
  queueSessionId?: string;
  result?: Record<string, unknown>;
  snapshot?: QueueSnapshot;
  dashboard?: DoctorDashboard;
}
