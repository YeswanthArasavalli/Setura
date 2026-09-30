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
 */
export type CommandCenterReadAction =
  | "overview"
  | "timeline"
  | "predictive"
  | "sla_dashboard"
  | "system_health";

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
