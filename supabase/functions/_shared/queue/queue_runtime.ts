/**
 * _shared/queue/queue_runtime.ts
 *
 * Phase 1.2 — queue runtime service layer.
 *
 * Wraps the migration-43 control RPCs (pause, resume, recall, skip,
 * restore, mark absent, manual call) with their side effects:
 * WhatsApp queue intelligence, SLA refresh and operational event
 * recording.
 *
 * Idempotency model:
 *   - The SQL RPCs are optimistic: repeating an operation after it
 *     succeeded returns ok=false (or the idempotent flag) instead of
 *     mutating state twice.
 *   - Every WhatsApp enqueue uses a deterministic idempotency key and
 *     enqueue_job collapses duplicates via ON CONFLICT.
 *
 * Nothing here keeps in-memory state: the database is the single
 * source of truth, so any client can recover via getQueueSnapshot().
 */

import type { DbClient } from "../db.ts";
import { formatE164 } from "../phone.ts";
import type { Logger } from "../logger.ts";
import type { Json } from "../database.generated.ts";

/** Statuses that still participate in the live queue. */
export const QUEUE_ACTIVE_STATUSES = [
  "booked",
  "checked_in",
  "waiting",
  "called",
];

/** Feature flag gating proactive queue WhatsApp notifications. */
const QUEUE_UPDATES_FLAG = "whatsapp_queue_updates";

/** Cap on proactive position updates per queue advance. */
const POSITION_NOTIFY_LIMIT = 3;

export interface QueueSessionRow {
  id: string;
  hospital_id: string;
  doctor_id: string | null;
  session_date: string;
  is_active: boolean;
  is_paused: boolean;
  pause_reason: string | null;
  current_live_token: number;
  max_tokens: number;
}

interface BookingNotifyRow {
  id: string;
  patient_name: string;
  patient_phone: string | null;
  token_number: number | null;
  status: string;
}

export interface PauseResult {
  paused: boolean;
  already_paused: boolean;
}

export interface ResumeResult {
  resumed: boolean;
  already_running: boolean;
}

export interface RecallResult {
  ok: boolean;
  reason?: string;
  booking_id?: string;
  token_number?: number;
  patient_name?: string;
  patient_phone?: string;
}

export interface SkipResult {
  ok: boolean;
  reason?: string;
  token_number?: number;
  was_current?: boolean;
}

export interface RestoreResult {
  ok: boolean;
  reason?: string;
  token_number?: number;
}

export interface AbsentResult {
  ok: boolean;
  reason?: string;
  token_number?: number;
}

export interface CallResult {
  ok: boolean;
  reason?: string;
  idempotent?: boolean;
  booking_id?: string;
  token_number?: number;
  current_status?: string;
}

export interface DelayResult {
  ok: boolean;
  already_delayed: boolean;
  delay_minutes?: number;
  event_id?: string;
}

export interface ClearDelayResult {
  ok: boolean;
  already_clear: boolean;
  cleared?: boolean;
  previous_minutes?: number;
  event_id?: string;
}

/** One newly-fired operational alert from evaluate_queue_health. */
export interface QueueHealthAlert {
  alert_id: string;
  hospital_id: string;
  queue_session_id: string | null;
  alert_key: string;
  severity: string;
  current_value: number;
  threshold_value: number;
  message: string;
}

export interface QueueHealthSummary {
  evaluated_at: string;
  sessions_evaluated: number;
  new_alerts: QueueHealthAlert[];
}

export interface SnapshotHealth {
  delay_active: boolean;
  delay_expected_minutes: number;
  actual_avg_consultation_minutes: number;
  throughput_per_hour: number;
  avg_estimated_wait_minutes: number;
  estimated_completion_at: string;
  last_progress_at: string;
  stalled_minutes: number;
  paused_minutes: number;
}

export interface SnapshotWaitingEntry {
  booking_id: string;
  token_number: number;
  patient_name: string;
  status: string;
  position: number;
  estimated_wait_minutes: number;
}

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
  waiting: SnapshotWaitingEntry[];
  counts: Record<string, number>;
  estimated_wait_next_minutes: number;
  health?: SnapshotHealth;
  generated_at: string;
}

// ─── Snapshot / recovery ─────────────────────────────────────────────────────

/**
 * Full queue state reconstruction from the database alone.
 * Returns null when the session does not exist.
 */
export async function getQueueSnapshot(
  db: DbClient,
  queueSessionId: string,
): Promise<QueueSnapshot | null> {
  const { data, error } = await db.rpc("get_queue_snapshot", {
    p_queue_session_id: queueSessionId,
  });

  if (error) {
    throw new Error(`get_queue_snapshot failed: ${error.message}`);
  }

  return (data as QueueSnapshot | null) ?? null;
}

// ─── SLA refresh (debounced) ─────────────────────────────────────────────────

/**
 * Enqueues a debounced compute_sla job. Best-effort: SLA refresh must
 * never fail a queue operation.
 */
export async function triggerSlaRefresh(
  db: DbClient,
  hospitalId: string,
  date: string | null,
  logger: Logger,
): Promise<void> {
  try {
    const { error } = await db.rpc("trigger_sla_refresh", {
      p_hospital_id: hospitalId,
      ...(date ? { p_date: date } : {}),
    });

    if (error) {
      logger.warn("SLA refresh enqueue failed", {
        hospitalId,
        error: error.message,
      });
    }
  } catch (err) {
    logger.warn("SLA refresh enqueue failed", { hospitalId, err });
  }
}

// ─── WhatsApp enqueue primitive ──────────────────────────────────────────────

interface WhatsAppEnqueueOptions {
  hospitalId: string;
  idemKey: string;
  phone: string;
  bookingId?: string;
  templateName?: string;
  text?: string;
  patientName?: string;
  tokenNumber?: number | null;
  priority?: "low" | "normal" | "high" | "critical";
}

/**
 * Enqueues one WhatsApp message job with a deterministic idempotency
 * key. Best-effort: notification failures never fail the operation.
 */
async function enqueueWhatsApp(
  db: DbClient,
  opts: WhatsAppEnqueueOptions,
  logger: Logger,
): Promise<void> {
  try {
    const { error } = await db.rpc("enqueue_job", {
      p_job_type: "send_whatsapp_message",

      p_payload: {
        ...(opts.templateName
          ? { template_name: opts.templateName }
          : { text: opts.text }),
        phone: opts.phone,
        booking_id: opts.bookingId,
        patient_name: opts.patientName,
        token_number: opts.tokenNumber,
      },

      p_priority: opts.priority ?? "normal",

      p_scheduled_at: new Date().toISOString(),

      p_idempotency_key: opts.idemKey,

      p_hospital_id: opts.hospitalId,

      p_booking_id: opts.bookingId,

      p_metadata: { source: "queue_runtime" },
    });

    if (error) {
      logger.warn("Queue WhatsApp enqueue failed", {
        idemKey: opts.idemKey,
        error: error.message,
      });
    }
  } catch (err) {
    logger.warn("Queue WhatsApp enqueue failed", {
      idemKey: opts.idemKey,
      err,
    });
  }
}

/** True when proactive queue WhatsApp updates are enabled. */
async function queueUpdatesEnabled(
  db: DbClient,
  hospitalId: string,
): Promise<boolean> {
  const { data } = await db.rpc("is_feature_enabled", {
    p_hospital_id: hospitalId,
    p_flag_key: QUEUE_UPDATES_FLAG,
  });

  return data === true;
}

// ─── Proactive queue intelligence ────────────────────────────────────────────

/**
 * Notifies every queue-active patient with a phone about a pause or
 * resume. Idempotent per (kind, session, booking) via the job key.
 */
export async function notifyQueuePauseChange(
  db: DbClient,
  session: QueueSessionRow,
  kind: "paused" | "resumed",
  logger: Logger,
): Promise<number> {
  if (!(await queueUpdatesEnabled(db, session.hospital_id))) {
    return 0;
  }

  const { data, error } = await db
    .from("bookings")
    .select("id, patient_name, patient_phone, token_number, status")
    .eq("queue_session_id", session.id)
    .in("status", QUEUE_ACTIVE_STATUSES)
    .eq("is_deleted", false)
    .not("patient_phone", "is", null);

  if (error) {
    logger.warn("Pause notify booking lookup failed", {
      queueSessionId: session.id,
      error: error.message,
    });
    return 0;
  }

  const bookings = (data ?? []) as BookingNotifyRow[];
  let enqueued = 0;

  for (const booking of bookings) {
    if (!booking.patient_phone) continue;

    const text = kind === "paused"
      ? `The doctor's queue is temporarily paused${
        session.pause_reason ? ` (${session.pause_reason})` : ""
      }. Please stay at the hospital; we will inform you when it resumes. Your token: ${booking.token_number}.`
      : `The doctor's queue has resumed. Now serving token ${session.current_live_token}. Your token: ${booking.token_number}. Please be ready.`;

    await enqueueWhatsApp(
      db,
      {
        hospitalId: session.hospital_id,
        idemKey: `wa_q_${kind}_${session.id}_${booking.id}`,
        phone: await formatE164(db, booking.patient_phone, session.hospital_id),
        bookingId: booking.id,
        text,
        priority: "normal",
      },
      logger,
    );

    enqueued++;
  }

  return enqueued;
}

/**
 * After an advance, sends position + estimated-wait updates to the
 * first few waiting patients. Keys include the position, so a patient
 * is only re-notified when their position actually changes.
 */
export async function notifyQueuePositions(
  db: DbClient,
  session: QueueSessionRow,
  logger: Logger,
): Promise<number> {
  if (!(await queueUpdatesEnabled(db, session.hospital_id))) {
    return 0;
  }

  let snapshot: QueueSnapshot | null;

  try {
    snapshot = await getQueueSnapshot(db, session.id);
  } catch (err) {
    logger.warn("Position notify snapshot failed", {
      queueSessionId: session.id,
      err,
    });
    return 0;
  }

  if (!snapshot) return 0;

  const phones = new Map<string, BookingNotifyRow>();

  const { data } = await db
    .from("bookings")
    .select("id, patient_name, patient_phone, token_number, status")
    .in(
      "id",
      snapshot.waiting
        .slice(0, POSITION_NOTIFY_LIMIT)
        .map((w) => w.booking_id),
    );

  for (const row of ((data ?? []) as BookingNotifyRow[])) {
    phones.set(row.id, row);
  }

  let enqueued = 0;

  for (
    const entry of snapshot.waiting.slice(0, POSITION_NOTIFY_LIMIT)
  ) {
    const booking = phones.get(entry.booking_id);

    if (!booking?.patient_phone) continue;

    await enqueueWhatsApp(
      db,
      {
        hospitalId: session.hospital_id,
        idemKey: `wa_q_pos_${session.id}_${booking.id}_${entry.position}`,
        phone: await formatE164(db, booking.patient_phone, session.hospital_id),
        bookingId: booking.id,
        text:
          `Queue update: you are #${entry.position} in line (token ${entry.token_number}). Estimated wait ~${entry.estimated_wait_minutes} min.`,
        priority: "normal",
      },
      logger,
    );

    enqueued++;
  }

  return enqueued;
}

/**
 * Notifies every queue-active patient with a phone that the doctor
 * is running late. Keys include the delay minutes, so patients are
 * re-notified only when the delay actually changes.
 */
export async function notifyDoctorDelay(
  db: DbClient,
  session: QueueSessionRow,
  minutes: number,
  logger: Logger,
): Promise<number> {
  if (!(await queueUpdatesEnabled(db, session.hospital_id))) {
    return 0;
  }

  const { data, error } = await db
    .from("bookings")
    .select("id, patient_name, patient_phone, token_number, status")
    .eq("queue_session_id", session.id)
    .in("status", QUEUE_ACTIVE_STATUSES)
    .eq("is_deleted", false)
    .not("patient_phone", "is", null);

  if (error) {
    logger.warn("Delay notify booking lookup failed", {
      queueSessionId: session.id,
      error: error.message,
    });
    return 0;
  }

  const bookings = (data ?? []) as BookingNotifyRow[];
  let enqueued = 0;

  for (const booking of bookings) {
    if (!booking.patient_phone) continue;

    const text =
      `Update: the doctor is running about ${minutes} minutes late. Your estimated wait time has been updated. Your token: ${booking.token_number}. Please stay near the waiting area.`;

    await enqueueWhatsApp(
      db,
      {
        hospitalId: session.hospital_id,
        idemKey: `wa_q_delay_${session.id}_${booking.id}_${minutes}`,
        phone: await formatE164(db, booking.patient_phone, session.hospital_id),
        bookingId: booking.id,
        text,
        priority: "normal",
      },
      logger,
    );

    enqueued++;
  }

  return enqueued;
}

// ─── Control operations ──────────────────────────────────────────────────────

/** Pauses the queue and notifies waiting patients. */
export async function runPauseQueue(
  db: DbClient,
  session: QueueSessionRow,
  reason: string | null,
  actorId: string,
  logger: Logger,
): Promise<PauseResult> {
  const { data, error } = await db.rpc("pause_queue", {
    p_queue_session_id: session.id,
    p_reason: reason ?? undefined,
    p_actor_id: actorId,
  });

  if (error) {
    throw new Error(`pause_queue failed: ${error.message}`);
  }

  const result = data as unknown as PauseResult;

  if (result.paused) {
    await notifyQueuePauseChange(
      db,
      { ...session, is_paused: true, pause_reason: reason },
      "paused",
      logger,
    );
  }

  return result;
}

/** Resumes the queue and notifies waiting patients. */
export async function runResumeQueue(
  db: DbClient,
  session: QueueSessionRow,
  actorId: string,
  logger: Logger,
): Promise<ResumeResult> {
  const { data, error } = await db.rpc("resume_queue", {
    p_queue_session_id: session.id,
    p_actor_id: actorId,
  });

  if (error) {
    throw new Error(`resume_queue failed: ${error.message}`);
  }

  const result = data as unknown as ResumeResult;

  if (result.resumed) {
    await notifyQueuePauseChange(
      db,
      { ...session, is_paused: false, pause_reason: null },
      "resumed",
      logger,
    );
  }

  return result;
}

/** Declares or adjusts a doctor delay and notifies waiting patients. */
export async function runMarkDoctorDelayed(
  db: DbClient,
  session: QueueSessionRow,
  minutes: number,
  reason: string | null,
  actorId: string,
  logger: Logger,
): Promise<DelayResult> {
  const { data, error } = await db.rpc("mark_doctor_delay", {
    p_queue_session_id: session.id,
    p_minutes: minutes,
    p_reason: reason ?? undefined,
    p_actor_id: actorId,
  });

  if (error) {
    throw new Error(`mark_doctor_delay failed: ${error.message}`);
  }

  const result = data as unknown as DelayResult;

  if (result.ok && !result.already_delayed) {
    await notifyDoctorDelay(db, session, minutes, logger);
  }

  return result;
}

/** Clears a doctor delay. Idempotent when no delay is active. */
export async function runClearDoctorDelay(
  db: DbClient,
  session: QueueSessionRow,
  actorId: string,
  logger: Logger,
): Promise<ClearDelayResult> {
  const { data, error } = await db.rpc("clear_doctor_delay", {
    p_queue_session_id: session.id,
    p_actor_id: actorId,
  });

  if (error) {
    throw new Error(`clear_doctor_delay failed: ${error.message}`);
  }

  const result = data as unknown as ClearDelayResult;

  if (result.ok && !result.already_clear) {
    logger.info("Doctor delay cleared", {
      sessionId: session.id,
      previousMinutes: result.previous_minutes,
      actorId,
    });
  }

  return result;
}

/** Loads the minimal booking fields needed for notifications. */
async function loadBookingForNotify(
  db: DbClient,
  bookingId: string,
): Promise<BookingNotifyRow | null> {
  const { data } = await db
    .from("bookings")
    .select("id, patient_name, patient_phone, token_number, status")
    .eq("id", bookingId)
    .maybeSingle();

  return (data as BookingNotifyRow | null) ?? null;
}

/**
 * Recalls the currently called token and re-notifies the patient via
 * the please_come_now template. The recall sequence number makes each
 * distinct recall send exactly one message while retried requests
 * dedupe on the job idempotency key.
 */
export async function runRecallCurrentToken(
  db: DbClient,
  session: QueueSessionRow,
  actorId: string,
  logger: Logger,
): Promise<RecallResult> {
  const { data, error } = await db.rpc("recall_current_token", {
    p_queue_session_id: session.id,
    p_actor_id: actorId,
  });

  if (error) {
    throw new Error(`recall_current_token failed: ${error.message}`);
  }

  const result = data as unknown as RecallResult;

  if (!result.ok || !result.booking_id) {
    return result;
  }

  const { count } = await db
    .from("queue_runtime_events")
    .select("id", { count: "exact", head: true })
    .eq("queue_session_id", session.id)
    .eq("booking_id", result.booking_id)
    .eq("event_type", "recalled");

  if (result.patient_phone) {
    await enqueueWhatsApp(
      db,
      {
        hospitalId: session.hospital_id,
        idemKey: `wa_q_recall_${result.booking_id}_${count ?? 1}`,
        phone: await formatE164(db, result.patient_phone, session.hospital_id),
        bookingId: result.booking_id,
        templateName: "please_come_now",
        patientName: result.patient_name,
        tokenNumber: result.token_number,
        priority: "critical",
      },
      logger,
    );
  }

  return result;
}

/** Skips a token and informs the patient. */
export async function runSkipToken(
  db: DbClient,
  session: QueueSessionRow,
  bookingId: string,
  actorId: string,
  logger: Logger,
): Promise<SkipResult> {
  const { data, error } = await db.rpc("skip_queue_token", {
    p_queue_session_id: session.id,
    p_booking_id: bookingId,
    p_actor_id: actorId,
  });

  if (error) {
    throw new Error(`skip_queue_token failed: ${error.message}`);
  }

  const result = data as unknown as SkipResult;

  if (result.ok) {
    await triggerSlaRefresh(
      db,
      session.hospital_id,
      session.session_date,
      logger,
    );

    const booking = await loadBookingForNotify(db, bookingId);

    if (booking?.patient_phone) {
      await enqueueWhatsApp(
        db,
        {
          hospitalId: session.hospital_id,
          idemKey: `wa_q_skipped_${bookingId}`,
          phone: await formatE164(
            db,
            booking.patient_phone,
            session.hospital_id,
          ),
          bookingId,
          text:
            `Your token ${booking.token_number} was skipped. Please speak to the reception desk to rejoin the queue.`,
          priority: "normal",
        },
        logger,
      );
    }
  }

  return result;
}

/** Restores a skipped patient back into the waiting pool. */
export async function runRestoreToken(
  db: DbClient,
  session: QueueSessionRow,
  bookingId: string,
  actorId: string,
  logger: Logger,
): Promise<RestoreResult> {
  const { data, error } = await db.rpc("restore_queue_token", {
    p_queue_session_id: session.id,
    p_booking_id: bookingId,
    p_actor_id: actorId,
  });

  if (error) {
    throw new Error(`restore_queue_token failed: ${error.message}`);
  }

  const result = data as unknown as RestoreResult;

  if (result.ok) {
    await triggerSlaRefresh(
      db,
      session.hospital_id,
      session.session_date,
      logger,
    );

    const booking = await loadBookingForNotify(db, bookingId);

    if (booking?.patient_phone) {
      await enqueueWhatsApp(
        db,
        {
          hospitalId: session.hospital_id,
          idemKey: `wa_q_restored_${bookingId}`,
          phone: await formatE164(
            db,
            booking.patient_phone,
            session.hospital_id,
          ),
          bookingId,
          text:
            `Good news: your token ${booking.token_number} has been restored to the queue. Please stay nearby.`,
          priority: "normal",
        },
        logger,
      );
    }
  }

  return result;
}

/** Marks a patient absent (no-show). */
export async function runMarkAbsent(
  db: DbClient,
  session: QueueSessionRow,
  bookingId: string,
  actorId: string,
  logger: Logger,
): Promise<AbsentResult> {
  const { data, error } = await db.rpc("mark_patient_absent", {
    p_queue_session_id: session.id,
    p_booking_id: bookingId,
    p_actor_id: actorId,
  });

  if (error) {
    throw new Error(`mark_patient_absent failed: ${error.message}`);
  }

  const result = data as unknown as AbsentResult;

  if (result.ok) {
    await triggerSlaRefresh(
      db,
      session.hospital_id,
      session.session_date,
      logger,
    );
  }

  return result;
}

/** Manually calls a specific token (reception override). */
export async function runCallToken(
  db: DbClient,
  session: QueueSessionRow,
  tokenNumber: number,
  actorId: string,
  logger: Logger,
): Promise<CallResult> {
  const { data, error } = await db.rpc("call_queue_token", {
    p_queue_session_id: session.id,
    p_token_number: tokenNumber,
    p_actor_id: actorId,
  });

  if (error) {
    throw new Error(`call_queue_token failed: ${error.message}`);
  }

  const result = data as unknown as CallResult;

  if (result.ok && !result.idempotent && result.booking_id) {
    await triggerSlaRefresh(
      db,
      session.hospital_id,
      session.session_date,
      logger,
    );

    const booking = await loadBookingForNotify(db, result.booking_id);

    if (booking?.patient_phone) {
      await enqueueWhatsApp(
        db,
        {
          hospitalId: session.hospital_id,
          idemKey: `wa_called_${result.booking_id}`,
          phone: await formatE164(
            db,
            booking.patient_phone,
            session.hospital_id,
          ),
          bookingId: result.booking_id,
          templateName: "patient_called",
          patientName: booking.patient_name,
          tokenNumber: result.token_number,
          priority: "critical",
        },
        logger,
      );
    }
  }

  return result;
}

// ─── Queue completion ────────────────────────────────────────────────────────

/**
 * Records a queue_completed event when the queue runs empty.
 * Skips recording when the latest event is already queue_completed so
 * repeated advance attempts on an empty queue stay idempotent. The
 * event insert itself is the Realtime broadcast (the table is
 * published).
 */
export async function markQueueCompleted(
  db: DbClient,
  queueSessionId: string,
  logger: Logger,
): Promise<boolean> {
  try {
    const { data: latest } = await db
      .from("queue_runtime_events")
      .select("event_type")
      .eq("queue_session_id", queueSessionId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latest?.event_type === "queue_completed") {
      return false;
    }

    const { error } = await db.rpc("record_queue_event", {
      p_queue_session_id: queueSessionId,
      p_event_type: "queue_completed",
    });

    if (error) {
      logger.warn("queue_completed event insert failed", {
        queueSessionId,
        error: error.message,
      });
      return false;
    }

    return true;
  } catch (err) {
    logger.warn("queue_completed event insert failed", {
      queueSessionId,
      err,
    });
    return false;
  }
}

// ─── Operational health (Phase 1.3) ─────────────────────────────────────────

/**
 * Runs the SQL queue health evaluator (congestion, stall, pause,
 * throughput, SLA breach). Returns the summary with only the alerts
 * fired by this run, so callers can notify exactly once per alert.
 */
export async function evaluateQueueHealth(
  db: DbClient,
): Promise<QueueHealthSummary> {
  const { data, error } = await db.rpc("evaluate_queue_health");

  if (error) {
    throw new Error(`evaluate_queue_health failed: ${error.message}`);
  }

  return data as unknown as QueueHealthSummary;
}

/**
 * Enqueues WhatsApp operational notifications to the hospital admins
 * for newly-fired queue alerts. Keys are derived from the alert id,
 * so a re-run never duplicates a notification.
 */
export async function notifyAdminsOfQueueAlerts(
  db: DbClient,
  alerts: QueueHealthAlert[],
  logger: Logger,
): Promise<number> {
  let enqueued = 0;

  for (const alert of alerts) {
    const { data: roles, error: rolesErr } = await db
      .from("user_roles")
      .select("user_id")
      .eq("hospital_id", alert.hospital_id)
      .eq("role", "hospital_admin");

    if (rolesErr) {
      logger.warn("Alert admin lookup failed", {
        hospitalId: alert.hospital_id,
        error: rolesErr.message,
      });
      continue;
    }

    const adminIds = ((roles ?? []) as Array<{ user_id: string }>)
      .map((r) => r.user_id);

    if (adminIds.length === 0) continue;

    const { data: profiles, error: profErr } = await db
      .from("profiles")
      .select("id, normalized_phone")
      .in("id", adminIds)
      .not("normalized_phone", "is", null);

    if (profErr) {
      logger.warn("Alert admin profile lookup failed", {
        hospitalId: alert.hospital_id,
        error: profErr.message,
      });
      continue;
    }

    const admins = (profiles ?? []) as Array<{
      id: string;
      normalized_phone: string;
    }>;

    const text =
      `SETURA ops alert (${alert.severity.toUpperCase()}): ${alert.message}`;

    for (const admin of admins) {
      const { error } = await db.rpc("enqueue_job", {
        p_job_type: "send_whatsapp_message",

        p_payload: {
          text,
          phone: admin.normalized_phone,
        },

        p_priority: alert.severity === "critical" ? "high" : "normal",

        p_scheduled_at: new Date().toISOString(),

        p_idempotency_key: `wa_ops_alert_${alert.alert_id}_${admin.id}`,

        p_hospital_id: alert.hospital_id,

        p_metadata: {
          source: "queue_health",
          alert_key: alert.alert_key,
          alert_id: alert.alert_id,
        },
      });

      if (error) {
        logger.warn("Ops alert WhatsApp enqueue failed", {
          alertId: alert.alert_id,
          error: error.message,
        });
        continue;
      }

      enqueued++;
    }
  }

  return enqueued;
}

// ─── Phase 1.4: doctor & clinical operations ─────────────────────────────────

export interface OpenSessionResult {
  ok: boolean;
  already_open?: boolean;
  queue_session_id?: string;
  reason?: string;
}

export interface CloseSessionResult {
  ok: boolean;
  already_closed?: boolean;
  waiting_remaining?: number;
  reason?: string;
}

export interface StartConsultationResult {
  ok: boolean;
  already_started?: boolean;
  booking_id?: string;
  token_number?: number | null;
  started_at?: string | null;
  reason?: string;
}

export interface CompleteConsultationResult {
  ok: boolean;
  already_completed?: boolean;
  booking_id?: string;
  token_number?: number | null;
  duration_minutes?: number | null;
  completed_at?: string;
  reason?: string;
}

export interface ReturnToWaitingResult {
  ok: boolean;
  already_waiting?: boolean;
  booking_id?: string;
  token_number?: number | null;
  reason?: string;
}

export interface EmergencyInsertResult {
  ok: boolean;
  already_inserted?: boolean;
  booking_id?: string;
  token_number?: number;
  reason?: string;
}

export interface SaveNoteResult {
  ok: boolean;
  note_id?: string;
  booking_id?: string;
  hospital_id?: string;
  reason?: string;
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
  delay_status?: {
    delayed: boolean;
    delay_expected_minutes: number | null;
  };
  pause_status?: {
    paused: boolean;
    reason: string | null;
  };
  queue_utilization?: number;
  session_health?: SnapshotHealth;
  generated_at?: string;
}

export interface ConsultationNoteInput {
  notes: string;
  diagnosisSummary?: string | null;
  prescription?: Json[] | null;
  followUpDate?: string | null;
  attachments?: Json[] | null;
}

/**
 * Opens (or converges on) the doctor session for a hospital/doctor/day.
 * Idempotent; refuses to reopen an already-ended session.
 */
export async function runOpenDoctorSession(
  db: DbClient,
  hospitalId: string,
  doctorId: string,
  actorId: string,
  _logger: Logger,
): Promise<OpenSessionResult> {
  const { data, error } = await db.rpc("open_doctor_session", {
    p_hospital_id: hospitalId,
    p_doctor_id: doctorId,
    p_actor_id: actorId,
  });

  if (error) {
    throw new Error(`open_doctor_session failed: ${error.message}`);
  }

  return data as unknown as OpenSessionResult;
}

/**
 * Notifies queue-active patients that the session closed early.
 * Deterministic keys make the fan-out idempotent.
 */
async function notifySessionEarlyClosed(
  db: DbClient,
  session: QueueSessionRow,
  logger: Logger,
): Promise<number> {
  if (!(await queueUpdatesEnabled(db, session.hospital_id))) {
    return 0;
  }

  const { data, error } = await db
    .from("bookings")
    .select("id, patient_name, patient_phone, token_number, status")
    .eq("queue_session_id", session.id)
    .in("status", QUEUE_ACTIVE_STATUSES)
    .eq("is_deleted", false)
    .not("patient_phone", "is", null);

  if (error) {
    logger.warn("Early-close notify booking lookup failed", {
      queueSessionId: session.id,
      error: error.message,
    });
    return 0;
  }

  const bookings = (data ?? []) as BookingNotifyRow[];
  let enqueued = 0;

  for (const booking of bookings) {
    if (!booking.patient_phone) continue;

    const text =
      `Update: the doctor's OP session has closed early. Your token ${booking.token_number} could not be served today. Please contact the hospital front desk to reschedule.`;

    await enqueueWhatsApp(
      db,
      {
        hospitalId: session.hospital_id,
        idemKey: `wa_q_close_${session.id}_${booking.id}`,
        phone: await formatE164(db, booking.patient_phone, session.hospital_id),
        bookingId: booking.id,
        text,
        priority: "normal",
      },
      logger,
    );

    enqueued++;
  }

  return enqueued;
}

/**
 * Ends a doctor session (incl. early closure). Idempotent; notifies
 * remaining patients when patients were left unserved.
 */
export async function runCloseDoctorSession(
  db: DbClient,
  session: QueueSessionRow,
  actorId: string,
  reason: string | null,
  logger: Logger,
): Promise<CloseSessionResult> {
  const { data, error } = await db.rpc("close_doctor_session", {
    p_queue_session_id: session.id,
    p_actor_id: actorId,
    ...(reason ? { p_reason: reason } : {}),
  });

  if (error) {
    throw new Error(`close_doctor_session failed: ${error.message}`);
  }

  const result = data as unknown as CloseSessionResult;

  if (
    result.ok && !result.already_closed &&
    (result.waiting_remaining ?? 0) > 0
  ) {
    await notifySessionEarlyClosed(db, session, logger);
  }

  return result;
}

/**
 * Starts the consultation for a called booking. FOR UPDATE in SQL;
 * the one-active-consultation-per-doctor index rejects races with
 * reason 'another_consultation_active'.
 */
export async function runStartConsultation(
  db: DbClient,
  session: QueueSessionRow,
  bookingId: string,
  actorId: string,
): Promise<StartConsultationResult> {
  const { data, error } = await db.rpc("start_consultation", {
    p_queue_session_id: session.id,
    p_booking_id: bookingId,
    p_actor_id: actorId,
  });

  if (error) {
    throw new Error(`start_consultation failed: ${error.message}`);
  }

  return data as unknown as StartConsultationResult;
}

/**
 * Completes the active consultation and refreshes SLA tracking.
 * Idempotent for already-completed bookings.
 */
export async function runCompleteConsultation(
  db: DbClient,
  session: QueueSessionRow,
  bookingId: string,
  actorId: string,
  logger: Logger,
): Promise<CompleteConsultationResult> {
  const { data, error } = await db.rpc("complete_consultation", {
    p_queue_session_id: session.id,
    p_booking_id: bookingId,
    p_actor_id: actorId,
  });

  if (error) {
    throw new Error(`complete_consultation failed: ${error.message}`);
  }

  const result = data as unknown as CompleteConsultationResult;

  if (result.ok && !result.already_completed) {
    await triggerSlaRefresh(
      db,
      session.hospital_id,
      session.session_date,
      logger,
    );
  }

  return result;
}

/**
 * Returns an in-consultation patient to the waiting pool (interrupted
 * consultation). Idempotent for bookings already waiting.
 */
export async function runReturnToWaiting(
  db: DbClient,
  session: QueueSessionRow,
  bookingId: string,
  actorId: string,
): Promise<ReturnToWaitingResult> {
  const { data, error } = await db.rpc("return_to_waiting", {
    p_queue_session_id: session.id,
    p_booking_id: bookingId,
    p_actor_id: actorId,
  });

  if (error) {
    throw new Error(`return_to_waiting failed: ${error.message}`);
  }

  return data as unknown as ReturnToWaitingResult;
}

/**
 * Inserts an emergency patient at the front of the queue (top
 * priority_score; advance_queue ordering calls them next).
 */
export async function runInsertEmergencyPatient(
  db: DbClient,
  session: QueueSessionRow,
  patientName: string,
  patientPhone: string | null,
  reason: string | null,
  actorId: string,
  idempotencyKey: string | null,
): Promise<EmergencyInsertResult> {
  const { data, error } = await db.rpc("insert_emergency_patient", {
    p_queue_session_id: session.id,
    p_patient_name: patientName,
    ...(patientPhone ? { p_patient_phone: patientPhone } : {}),
    ...(reason ? { p_reason: reason } : {}),
    p_actor_id: actorId,
    ...(idempotencyKey ? { p_idempotency_key: idempotencyKey } : {}),
  });

  if (error) {
    throw new Error(`insert_emergency_patient failed: ${error.message}`);
  }

  return data as unknown as EmergencyInsertResult;
}

/** Appends an immutable clinical note to a booking. */
export async function runSaveConsultationNote(
  db: DbClient,
  bookingId: string,
  doctorId: string,
  input: ConsultationNoteInput,
): Promise<SaveNoteResult> {
  const { data, error } = await db.rpc("save_consultation_note", {
    p_booking_id: bookingId,
    p_doctor_id: doctorId,
    p_notes: input.notes,
    ...(input.diagnosisSummary
      ? { p_diagnosis_summary: input.diagnosisSummary }
      : {}),
    ...(input.prescription ? { p_prescription: input.prescription } : {}),
    ...(input.followUpDate ? { p_follow_up_date: input.followUpDate } : {}),
    ...(input.attachments ? { p_attachments: input.attachments } : {}),
  });

  if (error) {
    throw new Error(`save_consultation_note failed: ${error.message}`);
  }

  return data as unknown as SaveNoteResult;
}

/**
 * Doctor day dashboard: current patient, next five, counts, wait /
 * consultation averages, delay/pause status and session health.
 */
export async function getDoctorDashboard(
  db: DbClient,
  doctorId: string,
  hospitalId: string,
): Promise<DoctorDashboard> {
  const { data, error } = await db.rpc("get_doctor_dashboard", {
    p_doctor_id: doctorId,
    p_hospital_id: hospitalId,
  });

  if (error) {
    throw new Error(`get_doctor_dashboard failed: ${error.message}`);
  }

  return data as unknown as DoctorDashboard;
}
