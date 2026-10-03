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

// ─── provision-hospital (WS-ONBOARD-1 tenant provisioning) ───────────────────

/** Success-envelope `data` for the `provision-hospital` Edge Function. Mirrors
 *  the server-authoritative identity it returns after the atomic tenant RPC.
 *  The frontend owns NO provisioning logic — it only types what the backend
 *  already returns. */
export interface ProvisionHospitalResponseBody {
  hospitalId: string;
  name: string;
  slug: string;
  created: boolean;
}

// ─── hospital-configuration (WS-ONBOARD-2 configuration write surfaces) ────

/** Server-authoritative snapshot of a hospital's editable configuration.
 *  Mirrors `get_hospital_configuration` (migration 66). The frontend owns
 *  NO business rules — it only types what the backend returns. */
export interface HospitalConfigurationHospitalSnapshot {
  id: string;
  slug: string;
  name: string;
  name_te: string | null;
  phone: string | null;
  email: string | null;
  country: string;
  state: string;
  district: string | null;
  town: string;
  address: string | null;
  timezone: string;
  online_booking_enabled: boolean;
  max_advance_booking_days: number;
}

export interface HospitalConfigurationSettingsSnapshot {
  display_name: string | null;
  logo_url: string | null;
  platform_fee_online: string | number;
  platform_fee_whatsapp: string | number;
  receptionist_fee: string | number;
  booking_fee_amount: string | number;
  online_booking_fee_enabled: boolean;
  default_consultation_fee_inr: string | number | null;
  collect_consultation_at_hospital: boolean;
  gst_enabled: boolean;
  gst_percentage: string | number;
  gst_registration_number: string | null;
  max_tokens_per_day: number;
  allow_walkin_tokens: boolean;
  allow_online_booking: boolean;
  allow_carry_forward: boolean;
  queue_display_enabled: boolean;
  send_whatsapp_confirmation: boolean;
  send_whatsapp_reminder: boolean;
  send_feedback_request: boolean;
  reminder_before_minutes: number;
  preferred_language: string;
  timezone: string;
  metadata: Record<string, unknown>;
  updated_at: string;
  updated_by: string | null;
}

export interface HospitalConfigurationFeatureFlagView {
  flag_key: string;
  display_name: string | null;
  description: string | null;
  is_enabled: boolean;
  is_override: boolean;
}

/** `data` for the `mode: "read"` response of the hospital-configuration
 *  Edge Function. */
export interface HospitalConfigurationReadResponseBody {
  hospitalId: string;
  version: number;
  hospital: HospitalConfigurationHospitalSnapshot;
  settings: HospitalConfigurationSettingsSnapshot;
  featureFlags: HospitalConfigurationFeatureFlagView[];
}

/** `data` for the `mode: "update"` response. */
export interface HospitalConfigurationUpdateResponseBody {
  hospitalId: string;
  version: number;
  updated: boolean;
}

// ─── integration-configuration (WS-ONBOARD-3 secure credential management) ───

/** Supported integration providers. Platform-global secrets; per-hospital
 *  public identifiers only (see migration 67). */
export type IntegrationProvider = "razorpay" | "meta_whatsapp";

/** The complete sanitized connection-test vocabulary. It never carries a
 *  credential or a raw provider body. */
export type ConnectionTestStatus =
  | "CONNECTED"
  | "INVALID_CREDENTIAL"
  | "UNAUTHORIZED"
  | "PROVIDER_UNAVAILABLE"
  | "CONFIGURATION_INVALID";

/** One per-hospital integration row. Frontend-safe: contains only public
 *  identifiers + lifecycle bookkeeping, NEVER a secret or a secret_ref. */
export interface IntegrationConfigView {
  provider: IntegrationProvider;
  public_identifier: string | null;
  waba_id: string | null;
  contact_number: string | null;
  enabled: boolean;
  status: string;
  last_tested_at: string | null;
  last_test_status: ConnectionTestStatus | null;
  last_rotated_at: string | null;
  version: number;
}

/** Platform-global secret PRESENCE marker only. The plaintext is never
 *  returned to the browser. */
export interface PlatformSecretPresence {
  provider: IntegrationProvider;
  secret_present: boolean;
  last_rotated_at: string | null;
}

/** `data` for the integration-configuration `mode: "read"` response. */
export interface IntegrationConfigurationReadResponseBody {
  hospitalId: string;
  integrations: IntegrationConfigView[];
  platformSecrets: PlatformSecretPresence[];
}

/** `data` for the `mode: "update"` response. */
export interface IntegrationUpdateResponseBody {
  provider: IntegrationProvider;
  version: number;
  status: string;
}

/** `data` for the `mode: "test"` response. */
export interface IntegrationTestResponseBody {
  provider: IntegrationProvider;
  result: ConnectionTestStatus;
  message: string;
}

/** `data` for the `mode: "rotate_secret"` response. Never echoes the value. */
export interface IntegrationRotateSecretResponseBody {
  provider: IntegrationProvider;
  secret_present: boolean;
  last_rotated_at: string | null;
}

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

// ─── reschedule-booking (Schema / successResponse) ───────────────────────────

export interface RescheduleBookingRequest {
  bookingId: string;
  /** New appointment date, YYYY-MM-DD. The backend owns every validation —
   *  booking window, holiday, working hours and doctor availability — the
   *  console never recomputes or assumes any of them. */
  newDate: string;
  /** OPTIONAL reassignment. Omitted (or undefined) → `reschedule-booking`
   *  keeps the booking's original assigned doctor. */
  newDoctorId?: string;
  /** OPTIONAL staff free text. The backend caps it at 500 characters. */
  reason?: string;
}

export interface RescheduleBookingResponse {
  originalBookingId: string;
  newBookingId: string;
  newTokenNumber: number;
  newDate: string;
}

// ─── update-booking-status (Schema / successResponse) ───────────────────────

/**
 * The two lifecycle closures this console owns. `update-booking-status`
 * accepts more statuses, but every other transition belongs to the queue
 * runtime (QueueBoard) or the doctor console — not the reception surface.
 */
export type ReceptionStatusUpdate = "checked_in" | "no_show";

export interface UpdateBookingStatusRequest {
  bookingId: string;
  newStatus: ReceptionStatusUpdate;
  /** Optional free text (backend: `.max(500)`, stored in booking metadata).
   *  Omitted entirely when empty — an absent key is not the same as "". */
  notes?: string;
}

export interface UpdateBookingStatusResponse {
  bookingId: string;
  /** The status the database now holds, per the backend's own write. */
  status: string;
  /** False on the intrinsic replay (already in the target state): a no-op
   *  success, never a failure. */
  changed: boolean;
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

// ─── command-center (read actions only — Phase 7 G-03) ─────────────────

/**
 * The five read actions the admin surface may invoke. The `broadcast_*`
 * actions exist on the backend but are OUT OF SCOPE for G-03 and must never
 * be sent from this console (investigation §Selection; phase spec §2/§9).
 *
 * C2b adds a SEPARATE broadcast surface (`CommandCenterBroadcastAction` below);
 * the five read wrappers stay exactly as G-03 authored them.
 */
export type CommandCenterReadAction =
  | "overview"
  | "timeline"
  | "predictive"
  | "sla_dashboard"
  | "system_health";

// ─── command-center broadcast (C2b Broadcast Composer) ────────────────

/**
 * The five broadcast actions the C2b composer may invoke over the SAME
 * `command-center` Edge Function (`broadcast_*`, Phase 1.5). Each maps 1:1 to
 * a `z.enum(ADMIN_ACTIONS)` value the backend `Schema` already accepts and the
 * backend `_shared/enterprise/broadcasts.ts` layer already implements — the
 * composer owns NOTHING of the recipient selection, message generation or
 * idempotency; those are entirely server-side.
 */
export type CommandCenterBroadcastAction =
  | "broadcast_queue_summary"
  | "broadcast_doctor_delay"
  | "broadcast_closure"
  | "broadcast_admin_notice"
  | "broadcast_alert";

/**
 * `broadcast_admin_notice` `kind` values, exactly the backend
 * `ADMIN_BROADCAST_KINDS` enum (`command-center/index.ts`). Sent verbatim; the
 * backend prefixes the delivered text with this tag.
 */
export type AdminBroadcastKind =
  | "daily_summary"
  | "sla_breach"
  | "congestion"
  | "operational_notice";

/**
 * PostgREST serialises some PostgreSQL NUMERIC/INTERVAL values as strings and
 * others as numbers (the integration suite wraps them in `Number()` for the
 * same reason). Consumers must coerce via a display helper, never assume.
 */
export type JsonNumeric = number | string;

/** Mirrors `get_hospital_command_center` (migration 47). */
export interface CommandCenterOverview {
  hospital_id: string;
  date: string;
  patients: {
    total_today: number;
    waiting: number;
    called: number;
    in_consultation: number;
    completed: number;
    cancelled: number;
    no_shows: number;
    skipped: number;
    checked_in: number;
    avg_wait_minutes: JsonNumeric | null;
    avg_consultation_minutes: JsonNumeric | null;
  } | null;
  /** NULL when the day has no queue sessions at all (aggregate over 0 rows). */
  queues: {
    active_sessions: number;
    paused_queues: number;
    delayed_doctors: number;
    stalled_queues: number;
    active_consultations: number;
    doctor_availability: Array<{
      doctor_id: string;
      session_id: string;
      is_paused: boolean;
      delay_minutes: number | null;
      current_token: number | null;
    }> | null;
  } | null;
  /** NULL with no tracking row; `{ status: "no_data" }` when unassessed. */
  sla: {
    status: "breached" | "healthy" | "no_data";
    avg_wait_minutes?: JsonNumeric | null;
    completion_rate_pct?: JsonNumeric | null;
    wait_breached?: boolean;
    completion_breached?: boolean;
  } | null;
  finance: {
    revenue_today: JsonNumeric;
    platform_fee_today: JsonNumeric;
    refunds_today: JsonNumeric;
    pending_payments: number;
    outstanding_settlements: JsonNumeric;
  } | null;
  alert_activity: { recent_alerts_24h: number } | null;
  generated_at: string;
}

/** Mirrors `get_operational_scores` (migration 47). 0–100, higher is
 *  better except risk_score. Deterministic backend formulas — never
 *  recomputed here. */
export interface OperationalScores {
  hospital_id: string;
  date: string;
  congestion_score: number;
  delay_score: number;
  risk_score: number;
  health_score: number;
  patient_experience_score: number;
  inputs: {
    waiting: number;
    capacity: number;
    active_sessions: number;
    delayed_sessions: number;
    open_alerts_24h: number;
    avg_wait_minutes: JsonNumeric;
  } | null;
}

/** One row of `get_hospital_timeline`'s `events` array (migration 47). */
export interface TimelineEvent {
  ts: string;
  category: string;
  event_type: string;
  severity: "info" | "warning" | "critical";
  entity_type: string;
  entity_id: string | null;
  doctor_id: string | null;
  queue_session_id: string | null;
  metadata: Record<string, unknown> | null;
}

export interface HospitalTimeline {
  hospital_id: string;
  from: string;
  to: string;
  events: TimelineEvent[];
}

/** Mirrors `get_predictive_insights` (migration 47) — backend-generated
 *  deterministic projections only; the console adds no prediction logic. */
export interface PredictiveInsights {
  hospital_id: string;
  date: string;
  queue_predictions: {
    waiting_now: number;
    completed_now: number;
    predicted_no_shows_today: JsonNumeric | null;
    avg_consultation_minutes: JsonNumeric | null;
    predicted_wait_next_minutes: JsonNumeric | null;
    predicted_queue_exhaustion_minutes: JsonNumeric | null;
  } | null;
  /** `get_revenue_forecast` output, embedded verbatim. */
  financial_predictions: {
    hospital_id: string;
    as_of: string;
    projected_month_revenue: JsonNumeric;
    projected_platform_fees: JsonNumeric;
    projected_settlements: JsonNumeric;
    refund_rate_30d: JsonNumeric;
    refund_impact_forecast: JsonNumeric;
    collection_forecast_next_7d: JsonNumeric;
    inputs: {
      mtd_revenue: JsonNumeric;
      days_elapsed: number;
      days_in_month: number;
    } | null;
  } | null;
}

/** Mirrors `get_sla_dashboard` (migration 47), hospital-scoped. */
export interface SlaDashboard {
  date: string;
  /** NULL when nothing is tracked for the date. */
  summary: {
    tracked: number;
    in_breach: number;
    avg_breach_wait_minutes: JsonNumeric | null;
  } | null;
  hospitals_in_breach: Array<{
    hospital_id: string;
    hospital_name: string;
    avg_wait_minutes: JsonNumeric | null;
    completion_rate_pct: JsonNumeric | null;
    sla_wait_breached: boolean;
    sla_completion_breached: boolean;
  }>;
  trend_14d: Array<{
    tracking_date: string;
    avg_wait_minutes: JsonNumeric | null;
    completion_rate_pct: JsonNumeric | null;
    hospitals_breached: number;
  }>;
}

/** `system_health` composites the monitoring RPCs (migrations 58 / 17 / 14).
 *  Each component is NULL when its RPC returned no data — the handler does
 *  not surface those errors, so absence must render as “not reported”. */
export interface SystemHealth {
  queueHealth: Array<{
    queue_type: string;
    pending_count: number;
    processing_count: number;
    failed_count: number;
    dead_count: number;
    oldest_pending_age: string | null;
    avg_attempts: JsonNumeric | null;
    throughput_last_hour: number;
  }> | null;
  materializedViews: Array<{
    view_name: string;
    last_refresh: string | null;
    duration_ms: number | null;
    last_success: boolean | null;
    row_count: number | null;
    is_stale: boolean | null;
  }> | null;
  deadLetterQueue: Array<{
    source: string;
    unresolved_count: number;
    critical_count: number;
    oldest_item_at: string | null;
  }> | null;
  openAlerts: number;
}

// Success-envelope `data` for each read action (command-center/index.ts).

export interface CommandCenterOverviewResponse {
  action: "overview";
  overview: CommandCenterOverview;
  scores: OperationalScores;
}

export interface CommandCenterTimelineResponse {
  action: "timeline";
  timeline: HospitalTimeline;
}

export interface CommandCenterPredictiveResponse {
  action: "predictive";
  predictions: PredictiveInsights;
}

export interface CommandCenterSlaResponse {
  action: "sla_dashboard";
  sla: SlaDashboard;
}

export interface CommandCenterSystemHealthResponse {
  action: "system_health";
  health: SystemHealth;
}

/**
 * Success-envelope `data` for any `broadcast_*` action
 * (`command-center/index.ts`). The backend returns
 * `{ action, broadcast: { kind, enqueued } }` where `enqueued` is the count of
 * `enqueue_job` attempts made — an ACCEPT/QUEUE count, NEVER a WhatsApp
 * delivery confirmation (§5/§6). A flag-gated patient broadcast can legitimately
 * report `enqueued: 0`; the composer renders the server's number verbatim and
 * never infers delivery from it.
 */
export interface CommandCenterBroadcastResult {
  kind: string;
  enqueued: number;
}

export interface CommandCenterBroadcastResponse {
  action: CommandCenterBroadcastAction;
  broadcast: CommandCenterBroadcastResult;
}

// ─── enterprise-reports (audit + compliance reads only — Phase 7 G-05) ─

/**
 * The six read actions the audit & compliance viewer may invoke. The
 * `generate` action exists on the backend but is OUT OF SCOPE for G-05: the
 * executive-report types include money-sensitive `financial`/`settlement`
 * payloads that belong to a separately-gated phase
 * (PHASE_7_NEXT_PRODUCT_GAP_INVESTIGATION_REPORT.md §12/§14). It must never
 * be sent from this console.
 */
export type EnterpriseReportReadAction =
  | "audit_search"
  | "audit_integrity"
  | "settlement_integrity"
  | "queue_integrity"
  | "doctor_ops_integrity"
  | "integration_matrix";

/** Client-safe subset of the `audit_action_severity` enum (migration 10). */
export type AuditSeverity = "low" | "medium" | "high" | "critical";

/** One row of `search_audit_logs`' `entries` array (migration 47). */
export interface AuditEntry {
  id: string;
  actor_user_id: string | null;
  entity_type: string;
  entity_id: string | null;
  action_type: string;
  action_severity: AuditSeverity;
  metadata: Record<string, unknown> | null;
  notes: string | null;
  created_at: string;
}

/** `search_audit_logs` JSONB payload — tenant is echoed by the backend, never
 *  supplied by the client (the header-carried session tenant is authoritative). */
export interface AuditSearchResult {
  hospital_id: string;
  entries: AuditEntry[];
}

export interface AuditSearchResponseBody {
  action: "audit_search";
  results: AuditSearchResult;
}

/** Optional filters for the audit search. Every field maps 1:1 to a
 *  `search_audit_logs` parameter the Edge Function already reads. */
export interface AuditSearchFilters {
  actorId?: string;
  entityType?: string;
  actionType?: string;
  fromTs?: string;
  toTs?: string;
  correlationId?: string;
  limit?: number;
}

/** `verify_audit_integrity` (migration 47). */
export interface AuditIntegrityResult {
  ok: boolean;
  total_entries: number;
  orphan_actors: number;
  registered_action_types: number;
  unknown_action_types: number;
}

/** One settlement reconciliation mismatch row from
 *  `verify_settlement_integrity` — a reconciliation VERDICT, not a money
 *  figure rendered for financial review (investigation §12). */
export interface SettlementMismatch {
  settlement_id: string;
  total_platform_amount: JsonNumeric;
  items_platform_total: JsonNumeric;
}

export interface SettlementIntegrityResult {
  ok: boolean;
  settlements_checked: number;
  mismatches: SettlementMismatch[];
}

/** `verify_queue_integrity` (migration 47), per queue session. */
export interface QueueIntegrityResult {
  ok: boolean;
  cross_hospital_bookings: number;
  duplicate_tokens: number;
  parallel_consultations: number;
}

/** `verify_doctor_operations_integrity` (migration 47), per doctor-day. */
export interface DoctorOpsIntegrityResult {
  ok: boolean;
  timestamp_order_violations: number;
  completed_without_timestamp: number;
}

/** `verify_integration_matrix` (migration 47), booking → collection →
 *  ledger chain for a hospital-day. */
export interface IntegrationMatrixResult {
  ok: boolean;
  collections_without_booking: number;
  ledger_without_source: number;
}

// Success-envelope `data` for each compliance read (enterprise-reports/index.ts).

export interface AuditIntegrityResponse {
  action: "audit_integrity";
  check: "audit_integrity";
  result: AuditIntegrityResult;
}

export interface SettlementIntegrityResponse {
  action: "settlement_integrity";
  check: "settlement_integrity";
  result: SettlementIntegrityResult;
}

export interface QueueIntegrityResponse {
  action: "queue_integrity";
  check: "queue_integrity";
  result: QueueIntegrityResult;
}

export interface DoctorOpsIntegrityResponse {
  action: "doctor_ops_integrity";
  check: "doctor_ops_integrity";
  result: DoctorOpsIntegrityResult;
}

export interface IntegrationMatrixResponse {
  action: "integration_matrix";
  check: "integration_matrix";
  result: IntegrationMatrixResult;
}

// ─── enterprise-reports `generate` (executive/operational reports — G-06) ─

/**
 * The SIX non-financial executive report types the G-06 viewer exposes.
 * `financial` and `settlement` exist on the backend `generate` enum but are
 * DELIBERATELY ABSENT here: this allow-list is a product/security boundary
 * (phase spec §4/§8/§38) and the wrapper makes them structurally unreachable
 * from the console.
 */
export type ExecutiveReportType =
  | "daily_hospital"
  | "weekly_operations"
  | "monthly_executive"
  | "doctor_performance"
  | "sla"
  | "audit";

/**
 * A JSON value inside the per-report `data` payload. The reporting RPC returns
 * heterogeneous nested JSONB whose top-level keys are named by `columns` and
 * differ per report type, so it is typed safely as dynamic JSON rather than
 * forced into one invented schema or an `any` (phase spec §7/§23).
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * `generate_executive_report` JSONB payload (migration 49). The stable
 * top-level contract is shared by all eight types; `data`'s shape is
 * report-specific. `reason`/`supported` appear only on the `ok: false`
 * rejection variant, which the Edge Function converts to a 422 error.
 */
export interface ExecutiveReportPayload {
  ok: boolean;
  report_type: string;
  hospital_id: string;
  from_date: string;
  to_date: string;
  columns: string[];
  data: { [key: string]: JsonValue };
  generated_at: string;
  reason?: string;
  supported?: string[];
}

/** Success-envelope `data` for `action: "generate"` (json format, the default
 *  the viewer requests) — enterprise-reports/index.ts. */
export interface GenerateReportResponseBody {
  action: "generate";
  format: "json";
  report: ExecutiveReportPayload;
}

// ─── executive-analytics global portfolio / benchmarks (G-08) ────────────────

/**
 * One hospital row of `get_portfolio_dashboard` (migration 47 §9). The fields
 * are exactly the columns the SQL selects — `bookings_today`/
 * `active_sessions` are COUNT aggregates, `revenue_today`/
 * `outstanding_balance` NUMERIC sums and `sla_status` a derived text label.
 * NUMERIC arrives as number or string depending on driver serialisation, so
 * it stays `JsonNumeric`; the console never re-derives it.
 */
export interface PortfolioHospitalRow {
  hospital_id: string;
  name: string;
  slug: string;
  is_active: boolean;
  bookings_today: number;
  revenue_today: JsonNumeric;
  /** NULL when the hospital has no `outstanding_balances` row at all — the
   *  SQL `COALESCE` only defaults the column, not the missing row. */
  outstanding_balance: JsonNumeric | null;
  /** NULL when the hospital has no SLA tracking row for the date. */
  sla_status: "breached" | "healthy" | "no_data" | null;
  active_sessions: number;
}

/**
 * `get_portfolio_dashboard` JSONB (tenant-free; global admins only). The
 * counts are server-computed over ALL hospitals — `total_hospitals` is
 * `jsonb_array_length` of the rows below and `active_hospitals` a separate
 * `COUNT(*) WHERE is_active`, so they are NOT the same number and neither is
 * derived in the browser.
 */
export interface PortfolioDashboard {
  date: string;
  total_hospitals: number;
  active_hospitals: number;
  hospitals: PortfolioHospitalRow[];
}

/** Success-envelope `data` for `action: "portfolio"`. */
export interface PortfolioResponseBody {
  action: "portfolio";
  portfolio: PortfolioDashboard | null;
}

/**
 * One row of `get_cross_hospital_benchmarks` (migration 47 §9), aggregated
 * server-side over the trailing window. `avg_*`/`efficiency_pct` are NULL when
 * the hospital has no comparable bookings in the window — an honest absence,
 * never a client-side zero.
 */
export interface CrossHospitalBenchmarkRow {
  hospital_id: string;
  name: string;
  bookings: number;
  completed: number;
  avg_wait_minutes: JsonNumeric | null;
  avg_consultation_minutes: JsonNumeric | null;
  efficiency_pct: JsonNumeric | null;
  revenue_inr: JsonNumeric;
}

/** `get_cross_hospital_benchmarks` JSONB (tenant-free; global admins only). */
export interface CrossHospitalBenchmarks {
  from_date: string;
  to_date: string;
  benchmarks: CrossHospitalBenchmarkRow[];
}

/** Success-envelope `data` for `action: "benchmarks"`. */
export interface BenchmarksResponseBody {
  action: "benchmarks";
  benchmarks: CrossHospitalBenchmarks | null;
}

// ─── financial-command-center reads (Finance / Collections — Phase 7 G-09) ───

/**
 * Read-only contracts for the EXISTING `financial-command-center` Edge
 * Function. Every field below mirrors the exact JSONB the server SQL returns
 * (migrations 13 / 47 / 49) — the console derives NONE of them. Monetary
 * NUMERIC may arrive as a `number` or a `string` depending on driver
 * serialisation, so every money field stays `JsonNumeric`; the browser only
 * ever FORMATS it for display (§12) and never re-aggregates it (§10).
 */

/** The three read actions the function accepts (`FINANCE_ACTIONS`). */
export type FinancialAction = "overview" | "forecast" | "reconciliation";

/**
 * `get_financial_command_center.daily_collections` (migration 49). The money
 * sums are `COALESCE(SUM(...), 0)` so a no-collection day is a real `0`, never
 * absence; the counts are integers. `get_financial_command_center` runs as
 * service_role only (migration 48 §4), so these figures never reach the browser
 * except THROUGH the function that already authorized the caller.
 */
export interface FinancialDailyCollections {
  total_collected: JsonNumeric;
  platform_fee: JsonNumeric;
  hospital_fee: JsonNumeric;
  receptionist_fee: JsonNumeric;
  refunds: JsonNumeric;
  net_collections: JsonNumeric;
  online_payments: number;
  offline_payments: number;
  pending_payments: number;
}

/** `settlement_intelligence.aging_buckets` (migration 49): three NUMERIC sums. */
export interface FinancialAgingBuckets {
  current: JsonNumeric;
  overdue_8_30: JsonNumeric;
  overdue_31_plus: JsonNumeric;
}

/** One `settlement_intelligence.recent_settlements` row (last 10, migration 49). */
export interface FinancialRecentSettlement {
  id: string;
  settlement_start_date: string | null;
  settlement_end_date: string | null;
  total_platform_amount: JsonNumeric;
  amount_paid_to_setura: JsonNumeric;
  remaining_due: JsonNumeric;
  settlement_status: string;
  created_at: string;
}

/**
 * `get_financial_command_center.settlement_intelligence` (migration 49).
 * `collection_velocity_days` is `ROUND(AVG(...))` over PAID settlements only,
 * so it is NULL when none have been paid — an honest absence, never a `0`.
 * `recent_settlements` is `jsonb_agg(...)`, NULL when there are no rows.
 */
export interface FinancialSettlementIntelligence {
  outstanding_balance: JsonNumeric;
  aging_buckets: FinancialAgingBuckets;
  overdue_count: number;
  partial_payments: number;
  collection_velocity_days: JsonNumeric | null;
  recent_settlements: FinancialRecentSettlement[] | null;
}

/**
 * One row of `get_reconciliation_summary` (migration 13): the 8-column
 * collections→ledger TABLE. Money columns are `COALESCE(SUM(...), 0)`; the two
 * counts are integers. The standalone `reconciliation` action returns this as an
 * ARRAY (the RPC is set-returning); the `overview` action embeds it as a single
 * object.
 */
export interface ReconciliationSummaryRow {
  total_collected: JsonNumeric;
  platform_fee_total: JsonNumeric;
  receptionist_fee_total: JsonNumeric;
  total_refunded: JsonNumeric;
  total_settled: JsonNumeric;
  net_outstanding: JsonNumeric;
  booking_count: number;
  paid_booking_count: number;
}

/** The `get_financial_command_center` JSONB (one hospital-day aggregate). */
export interface FinancialCommandCenterData {
  hospital_id: string;
  date: string;
  daily_collections: FinancialDailyCollections;
  settlement_intelligence: FinancialSettlementIntelligence;
  reconciliation: ReconciliationSummaryRow | null;
}

/** Success-envelope `data` for `action: "overview"`. */
export interface FinancialOverviewResponseBody {
  action: "overview";
  financial: FinancialCommandCenterData | null;
}

/** `get_revenue_forecast.inputs` (migration 47): the prorations' raw inputs. */
export interface RevenueForecastInputs {
  mtd_revenue: JsonNumeric;
  days_elapsed: number;
  days_in_month: number;
}

/**
 * `get_revenue_forecast` JSONB (migration 47). Every projection is computed
 * server-side (prorated MTD, 30-day refund rate, trailing-7-day collection);
 * the console renders them and never recomputes a forecast (§10).
 */
export interface RevenueForecastData {
  hospital_id: string;
  as_of: string;
  projected_month_revenue: JsonNumeric;
  projected_platform_fees: JsonNumeric;
  projected_settlements: JsonNumeric;
  refund_rate_30d: JsonNumeric;
  refund_impact_forecast: JsonNumeric;
  collection_forecast_next_7d: JsonNumeric;
  inputs: RevenueForecastInputs;
}

/** Success-envelope `data` for `action: "forecast"`. */
export interface RevenueForecastResponseBody {
  action: "forecast";
  forecast: RevenueForecastData | null;
}

/**
 * Success-envelope `data` for `action: "reconciliation"`. The RPC is
 * set-returning, so the Edge Function returns the summary as an array (a single
 * aggregate row in practice). `callFunction` returns the envelope `data`
 * verbatim; the console renders whatever rows the server returned.
 */
export interface ReconciliationResponseBody {
  action: "reconciliation";
  reconciliation: ReconciliationSummaryRow[] | null;
}

// ─── alert-center (G-10 read surface: list + analytics) ──────────────────────

/**
 * `public.alert_severity_level` (migration 24). The edge `Schema` and the
 * `get_alert_center` cast both constrain severity to exactly these values.
 */
export type AlertSeverity = "info" | "warning" | "critical";

/**
 * One `alert_events` row as returned by `get_alert_center.alerts`
 * (migration 47 §2). These are exactly the columns the RPC selects — nothing
 * invented, nothing normalized away. Nullable server fields stay nullable: an
 * unacknowledged / unassigned / un-escalated / unresolved alert carries a real
 * `null`, never a fabricated value (§13/§16). NUMERIC may serialise as a string.
 */
export interface AlertEventRow {
  id: string;
  hospital_id: string | null;
  alert_key: string;
  alert_category: string | null;
  severity: AlertSeverity;
  current_value: JsonNumeric | null;
  threshold_value: JsonNumeric | null;
  message: string;
  is_resolved: boolean;
  acknowledged_at: string | null;
  assigned_to: string | null;
  escalated_at: string | null;
  created_at: string;
  resolved_at: string | null;
}

/**
 * `get_alert_center.counts` (migration 47 §2): four server-side
 * `COUNT(*) FILTER (...)` tallies over the whole tenant (not the filtered
 * page). The console renders them verbatim and NEVER derives a count from the
 * returned rows (§16).
 */
export interface AlertCenterCounts {
  open: number;
  acknowledged: number;
  escalated: number;
  critical_open: number;
}

/**
 * The `get_alert_center` JSONB. `alerts` is `COALESCE(jsonb_agg(...), '[]')`
 * and `counts` is a `jsonb_build_object`, so BOTH are always present — a
 * healthy read never returns a null center, only an empty `alerts` array
 * (which is the honest state while `check_queue_backlog_alerts()` has no
 * runtime scheduler caller, §10/§37).
 */
export interface AlertCenterData {
  alerts: AlertEventRow[];
  counts: AlertCenterCounts;
}

/** Success-envelope `data` for `action: "list"`. */
export interface AlertListResponseBody {
  action: "list";
  center: AlertCenterData;
}

/**
 * One `get_alert_analytics.by_alert_key` row (migration 47 §2). `total` /
 * `resolved` are server `COUNT(*)`; `avg_resolution_minutes` is a
 * `ROUND(AVG(...))` NUMERIC that may serialise as a string.
 */
export interface AlertAnalyticsByKey {
  alert_key: string;
  total: number;
  resolved: number;
  avg_resolution_minutes: JsonNumeric | null;
}

/**
 * `get_alert_analytics.summary`. `total` / `resolved` are `COUNT(*)` over the
 * window (integers, `0` when empty); `avg_resolution_minutes` is
 * `ROUND(AVG(...))` and is genuinely NULL when the window has no rows — an
 * honest absence, never a `0` (§13/§16).
 */
export interface AlertAnalyticsSummary {
  total: number;
  resolved: number;
  avg_resolution_minutes: JsonNumeric | null;
}

/**
 * The `get_alert_analytics` JSONB. `by_alert_key` is
 * `COALESCE(jsonb_agg(...), '[]')` (always an array) and `summary` is a
 * `jsonb_build_object` (always present). Every statistic is computed
 * server-side; the console renders it and never recomputes a rate, total or
 * percentage in the browser (§16).
 */
export interface AlertAnalyticsData {
  summary: AlertAnalyticsSummary;
  by_alert_key: AlertAnalyticsByKey[];
}

/** Success-envelope `data` for `action: "analytics"`. */
export interface AlertAnalyticsResponseBody {
  action: "analytics";
  analytics: AlertAnalyticsData;
}

// ─── alert-center (G-UI lifecycle mutations: acknowledge / resolve / escalate /
//     suppress). These mirror the EXISTING alert-center write contract (C2, migration
//     64 + the edge `Schema`); the console invents NOTHING here. ───────────────────

/**
 * The `result` JSONB the lifecycle RPCs return for acknowledge / resolve /
 * escalate (migration 64). It is a soft-success envelope, NOT a domain object:
 *
 *   - `ok` is the commit oracle the edge layer keys its 200/422 decision on;
 *   - a REAL transition carries a locked `before` / `after` snapshot; a soft
 *     `already_*` replay commits nothing and carries NEITHER snapshot (the edge
 *     comment in `alert-center/index.ts` and `alert_center_http.test.ts` H9 both
 *     pin this), so `before` / `after` are genuinely optional;
 *   - the `already_*` flags are the idempotent-replay signal (§12): HTTP 200 +
 *     `ok:true` + `already_<action>:true` is a SUCCESS, never a failure.
 *
 * The console reads ONLY `ok` and the `already_*` flag to word its message; it
 * never treats the snapshot as authoritative and never mutates local state from
 * it — the page refetches from the server after every attempt (§11).
 */
export interface AlertLifecycleResult {
  ok: boolean;
  already_acknowledged?: boolean;
  already_assigned?: boolean;
  already_resolved?: boolean;
  already_escalated?: boolean;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

/** Success-envelope `data` for `acknowledge` / `resolve` / `escalate`. */
export interface AlertLifecycleResponseBody {
  action: "acknowledge" | "resolve" | "escalate";
  alertId: string;
  result: AlertLifecycleResult;
}

/**
 * The `suppress_alerts` JSONB (OD-b: benign overlapping windows, no dedupe and
 * no client idempotency key). `ok` gates the 200/422 decision; `suppression_id`
 * is present only on an accepted window. `reason` is the server's rejection
 * string, surfaced by the edge layer as a 422 field error rather than a result
 * the UI optimistically renders.
 */
export interface AlertSuppressResult {
  ok: boolean;
  suppression_id?: string | null;
  reason?: string;
}

/** Success-envelope `data` for `action: "suppress"`. */
export interface AlertSuppressResponseBody {
  action: "suppress";
  result: AlertSuppressResult;
}

// ─── executive-analytics tenant-scoped reads (Operations — Phase 7 G-11) ─────

/**
 * Read-only contracts for the two EXISTING tenant-scoped `executive-analytics`
 * actions (`daily_operations` / `doctor_rankings`). Every field below mirrors
 * the exact JSONB the server SQL returns (migration 47, privilege-hardened in
 * migration 49) — the console derives NONE of it. These actions are NOT the
 * G-08 `GLOBAL_ACTIONS`: each request answers for exactly one hospital, the
 * one carried in the `X-Hospital-ID` header. NUMERIC/`ROUND(...)` values may
 * serialise as strings, so they stay `JsonNumeric`.
 */

/**
 * One hour row of `get_daily_operations_dashboard.hourly_trend` (migration 47
 * §6): bookings created in that hour for the date, and how many of those are
 * `completed`. Both are `COUNT(*)` integers; the array is `COALESCE`d to `[]`,
 * so an empty trend is an honest no-bookings day, never a missing key.
 */
export interface DailyOperationsHourlyRow {
  hour: number;
  bookings: number;
  completed: number;
}

/**
 * `get_daily_operations_dashboard.operations` (migration 47 §6). Summaries are
 * `COUNT(*)` over the hospital-day (a real `0` when the day has no bookings).
 * The two `*_rate_pct` are `100.0 * COUNT / NULLIF(COUNT, 0)` — genuinely NULL
 * on a zero-booking day, never a client-side 0. The two averages are
 * `ROUND(AVG(...))` filtered to the rows that carry the timestamps, so they are
 * NULL when no booking has (yet) started or finished a consultation.
 * `doctor_throughput` is a `jsonb_agg` that is NULL when no booking in the
 * window has an assigned doctor at all.
 */
export interface DailyOperationsRates {
  total_bookings: number;
  completed: number;
  cancellation_rate_pct: JsonNumeric | null;
  no_show_rate_pct: JsonNumeric | null;
  avg_wait_minutes: JsonNumeric | null;
  avg_consultation_minutes: JsonNumeric | null;
  doctor_throughput: DoctorThroughputRow[] | null;
}

/** One `operations.doctor_throughput` row: assigned bookings and completions. */
export interface DoctorThroughputRow {
  doctor_id: string;
  completed: number;
}

/**
 * `get_daily_operations_dashboard.sla` (migration 47 §6). With a tracking row
 * the SQL object carries all three fields; with NO `sla_daily_tracking` row it
 * is built by `COALESCE(jsonb_build_object('compliant', NULL), …)`, so the
 * `compliant`-only shape is what an untracked day actually returns — the other
 * two keys are then ABSENT, not null. A null `compliant` means “not assessed”,
 * never “non-compliant”.
 */
export interface DailyOperationsSla {
  compliant: boolean | null;
  avg_wait_minutes?: JsonNumeric | null;
  completion_rate_pct?: JsonNumeric | null;
}

/** The `get_daily_operations_dashboard` JSONB (one hospital-day). */
export interface DailyOperationsDashboard {
  hospital_id: string;
  date: string;
  hourly_trend: DailyOperationsHourlyRow[];
  operations: DailyOperationsRates;
  sla: DailyOperationsSla | null;
}

/** Success-envelope `data` for `action: "daily_operations"`. */
export interface DailyOperationsResponseBody {
  action: "daily_operations";
  dashboard: DailyOperationsDashboard | null;
}

/**
 * One row of `get_doctor_rankings.rankings` (migration 47 §6), aggregated
 * server-side over the trailing window. `throughput_rank` / `efficiency_rank`
 * are SQL `RANK() OVER (...)` values computed entirely in PostgreSQL — the
 * console renders them as returned and NEVER sorts, ranks or scores a doctor
 * in the browser. `avg_consultation_minutes` is NULL when the doctor completed
 * no consultation with both timestamps in the window; `load_pct` is NULL only
 * when the whole hospital has no bookings (its `NULLIF` denominator is 0).
 */
export interface DoctorRankingRow {
  doctor_id: string;
  completed: number;
  total_assigned: number;
  avg_consultation_minutes: JsonNumeric | null;
  load_pct: JsonNumeric | null;
  throughput_rank: number;
  efficiency_rank: number;
}

/**
 * One `get_doctor_rankings.utilization_heatmap` cell (migration 47 §6):
 * completed consultations for a doctor on an ISO weekday (1 = Monday …
 * 7 = Sunday), exactly as the server groups them.
 */
export interface DoctorUtilizationCell {
  doctor_id: string;
  weekday: number;
  completed: number;
}

/** The `get_doctor_rankings` JSONB. Both arrays are `COALESCE`d to `[]`. */
export interface DoctorRankingsData {
  hospital_id: string;
  from_date: string;
  to_date: string;
  rankings: DoctorRankingRow[];
  utilization_heatmap: DoctorUtilizationCell[];
}

/** Success-envelope `data` for `action: "doctor_rankings"`. */
export interface DoctorRankingsResponseBody {
  action: "doctor_rankings";
  rankings: DoctorRankingsData | null;
}

// ─── clinical-configuration (WS-ONBOARD-4 doctor / department / schedule / leave) ──

/** The nine actions the `clinical-configuration` Edge Function accepts. Mirrors
 *  its `z.discriminatedUnion("action", …)` exactly; the boundary rejects any
 *  other value with 422, and every member is `.strict()` so an unknown field is
 *  also 422. The frontend owns NO write logic — it only names what the backend
 *  already implements (migration 68 RPCs). */
export type ClinicalConfigurationAction =
  | "department_create"
  | "department_update"
  | "department_status_change"
  | "doctor_create"
  | "doctor_update"
  | "schedule_upsert"
  | "schedule_delete"
  | "leave_upsert"
  | "leave_cancel";

/**
 * The server-echoed outcome of the action just performed.
 *
 * Every field is optional because each action populates only its own subset
 * (the RPC result objects are built per action), and an unchanged optional
 * field is OMITTED rather than null-cast. `version` is the department row's
 * POST-write optimistic-concurrency version — the value to send as
 * `expectedVersion` on the next department write.
 */
export interface ClinicalConfigurationEntity {
  /** department_* : the affected row id. */
  departmentId?: string;
  name?: string;
  code?: string;
  version?: number;
  /** doctor_* : the affected doctor profile id. */
  doctorId?: string;
  fullName?: string;
  departmentCount?: number;
  specializationCount?: number;
  /** doctor_update : schedules the server deactivated alongside the doctor. */
  schedulesDeactivated?: number;
  /** department_* and doctor_* : resulting activation state. */
  isActive?: boolean;
  /** schedule_upsert : true when the server inserted, false when it updated. */
  created?: boolean;
  /** schedule_* : 0 = Sunday … 6 = Saturday, exactly as the DB stores it. */
  weekday?: number;
  startTime?: string;
  endTime?: string;
  maxTokens?: number;
  scheduleId?: string;
  deleted?: boolean;
  startDate?: string;
  endDate?: string;
  leaveType?: string;
  /** leave_* : server-authoritative status. Admin-created leave is recorded
   *  `approved` because that is the only status the availability engine
   *  honours; a `pending` row would leave the doctor bookable. */
  leaveStatus?: string;
  leaveId?: string;
}

/** Success-envelope `data` for `clinical-configuration`. */
export interface ClinicalConfigurationResponseBody {
  action: ClinicalConfigurationAction;
  hospitalId: string;
  entity: ClinicalConfigurationEntity;
}
