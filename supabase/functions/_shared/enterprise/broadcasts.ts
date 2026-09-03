/**
 * enterprise/broadcasts.ts — Operational WhatsApp broadcast layer.
 *
 * Completes the Phase 3 deferred operational intelligence:
 *
 *   - queue summary broadcasts      (broadcastQueueSummary)
 *   - operational alert broadcasts  (broadcastAlertToAdmins)
 *   - doctor delay broadcasts       (broadcastDoctorDelay)
 *   - hospital closure broadcasts   (broadcastHospitalClosure)
 *   - admin operational broadcasts  (broadcastAdminOperational)
 *
 * All broadcasts reuse the existing `enqueue_job` → send_whatsapp_message
 * pipeline. Nothing here computes business numbers: queue state comes
 * from bookings/queue_sessions, alert text comes from alert_events.
 *
 * Every enqueue carries a deterministic idempotency key, so re-running
 * a broadcast never duplicates a message. All functions are
 * best-effort: notification failures log a warning and never fail the
 * calling operation.
 *
 * Patient-facing broadcasts are gated on the `whatsapp_queue_updates`
 * feature flag; admin-facing broadcasts always deliver.
 */

import type { DbClient } from "../db.ts";
import type { Logger } from "../logger.ts";
import { formatE164 } from "../phone.ts";
import { QUEUE_ACTIVE_STATUSES } from "../queue/queue_runtime.ts";

const QUEUE_UPDATES_FLAG = "whatsapp_queue_updates";

/** Admin broadcast kinds for operational notices. */
export type AdminBroadcastKind =
  | "daily_summary"
  | "sla_breach"
  | "congestion"
  | "operational_notice";

interface BroadcastBookingRow {
  id: string;
  patient_name: string | null;
  patient_phone: string | null;
  token_number: number | null;
}

interface AdminContact {
  id: string;
  normalized_phone: string;
}

interface BroadcastSession {
  id: string;
  hospital_id: string;
  current_live_token: number | null;
}

interface BroadcastAlert {
  id: string;
  hospital_id: string;
  alert_key: string;
  severity: string;
  message: string | null;
}

// ─── Enqueue primitive ─────────────────────────────────────────────────────

/**
 * Enqueues one WhatsApp broadcast job. Mirrors the queue_runtime
 * primitive; the metadata source marks enterprise broadcasts so the
 * worker audit trail can attribute them.
 */
async function enqueueBroadcast(
  db: DbClient,
  opts: {
    hospitalId: string;
    idemKey: string;
    phone: string;
    text: string;
    bookingId?: string;
    patientName?: string | null;
    tokenNumber?: number | null;
    priority?: "low" | "normal" | "high" | "critical";
  },
  logger: Logger,
): Promise<void> {
  try {
    const { error } = await db.rpc("enqueue_job", {
      p_job_type: "send_whatsapp_message",
      p_payload: {
        text: opts.text,
        phone: opts.phone,
        booking_id: opts.bookingId ?? null,
        patient_name: opts.patientName ?? null,
        token_number: opts.tokenNumber ?? null,
      },
      p_priority: opts.priority ?? "normal",
      p_scheduled_at: new Date().toISOString(),
      p_idempotency_key: opts.idemKey,
      p_hospital_id: opts.hospitalId,
      p_booking_id: opts.bookingId,
      p_metadata: { source: "enterprise_broadcasts" },
    });

    if (error) {
      logger.warn("Broadcast enqueue failed", {
        idemKey: opts.idemKey,
        error: error.message,
      });
    }
  } catch (err) {
    logger.warn("Broadcast enqueue failed", { idemKey: opts.idemKey, err });
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

/** Loads the queue-active patients of a session that carry a phone. */
async function loadSessionPatients(
  db: DbClient,
  queueSessionId: string,
): Promise<BroadcastBookingRow[]> {
  const { data, error } = await db
    .from("bookings")
    .select("id, patient_name, patient_phone, token_number")
    .eq("queue_session_id", queueSessionId)
    .in("status", QUEUE_ACTIVE_STATUSES)
    .eq("is_deleted", false)
    .not("patient_phone", "is", null);

  if (error) return [];

  return (data ?? []) as BroadcastBookingRow[];
}

/** Loads hospital admin contacts with a deliverable phone. */
async function loadAdminContacts(
  db: DbClient,
  hospitalId: string,
  logger: Logger,
): Promise<AdminContact[]> {
  const { data: roles, error: rolesErr } = await db
    .from("user_roles")
    .select("user_id")
    .eq("hospital_id", hospitalId)
    .eq("role", "hospital_admin");

  if (rolesErr) {
    logger.warn("Broadcast admin lookup failed", {
      hospitalId,
      error: rolesErr.message,
    });
    return [];
  }

  const adminIds = ((roles ?? []) as Array<{ user_id: string }>)
    .map((r) => r.user_id);

  if (adminIds.length === 0) return [];

  const { data: profiles, error: profErr } = await db
    .from("profiles")
    .select("id, normalized_phone")
    .in("id", adminIds)
    .not("normalized_phone", "is", null);

  if (profErr) {
    logger.warn("Broadcast admin profile lookup failed", {
      hospitalId,
      error: profErr.message,
    });
    return [];
  }

  return (profiles ?? []) as AdminContact[];
}

// ─── Queue summary broadcast ───────────────────────────────────────────────

/**
 * Sends each queue-active patient a snapshot of the queue: now
 * serving, their token, and how many are ahead of them. Key includes
 * the live token so an unchanged queue is never re-broadcast.
 */
export async function broadcastQueueSummary(
  db: DbClient,
  session: BroadcastSession,
  logger: Logger,
): Promise<number> {
  if (!(await queueUpdatesEnabled(db, session.hospital_id))) return 0;

  const bookings = await loadSessionPatients(db, session.id);
  const nowServing = session.current_live_token ?? 0;
  let enqueued = 0;

  for (const booking of bookings) {
    if (!booking.patient_phone) continue;

    const ahead = booking.token_number !== null
      ? Math.max(0, booking.token_number - nowServing)
      : null;

    const text = ahead === null
      ? `Queue update: now serving token ${nowServing}. Your token: ${booking.token_number}.`
      : `Queue update: now serving token ${nowServing}. Your token: ${booking.token_number} — approximately ${ahead} patient${
        ahead === 1 ? "" : "s"
      } ahead of you.`;

    await enqueueBroadcast(
      db,
      {
        hospitalId: session.hospital_id,
        idemKey: `wa_q_summary_${session.id}_${booking.id}_${nowServing}`,
        phone: await formatE164(db, booking.patient_phone, session.hospital_id),
        text,
        bookingId: booking.id,
        patientName: booking.patient_name,
        tokenNumber: booking.token_number,
      },
      logger,
    );

    enqueued++;
  }

  return enqueued;
}

// ─── Doctor delay broadcast ────────────────────────────────────────────────

/**
 * Notifies queue-active patients that the doctor is running late.
 * Key includes the session, booking, and delay minutes so a new
 * delay value re-notifies but an identical one does not.
 */
export async function broadcastDoctorDelay(
  db: DbClient,
  session: BroadcastSession,
  delayMinutes: number,
  reason: string | null,
  logger: Logger,
): Promise<number> {
  if (!(await queueUpdatesEnabled(db, session.hospital_id))) return 0;

  const bookings = await loadSessionPatients(db, session.id);
  const minutes = Math.max(1, Math.round(delayMinutes));
  let enqueued = 0;

  for (const booking of bookings) {
    if (!booking.patient_phone) continue;

    const text = `The doctor is running approximately ${minutes} minute${
      minutes === 1 ? "" : "s"
    } late${
      reason ? ` (${reason})` : ""
    }. Your token: ${booking.token_number}. We apologise for the inconvenience.`;

    await enqueueBroadcast(
      db,
      {
        hospitalId: session.hospital_id,
        idemKey: `wa_q_delay_${session.id}_${booking.id}_${minutes}`,
        phone: await formatE164(db, booking.patient_phone, session.hospital_id),
        text,
        bookingId: booking.id,
        patientName: booking.patient_name,
        tokenNumber: booking.token_number,
      },
      logger,
    );

    enqueued++;
  }

  return enqueued;
}

// ─── Hospital closure broadcast ────────────────────────────────────────────

/**
 * Notifies every patient still active in today's queues that the
 * hospital is closing for the day. One message per booking per day.
 */
export async function broadcastHospitalClosure(
  db: DbClient,
  hospitalId: string,
  sessionDate: string,
  reason: string | null,
  logger: Logger,
): Promise<number> {
  if (!(await queueUpdatesEnabled(db, hospitalId))) return 0;

  const { data, error } = await db
    .from("bookings")
    .select("id, patient_name, patient_phone, token_number")
    .eq("hospital_id", hospitalId)
    .eq("booking_date", sessionDate)
    .in("status", QUEUE_ACTIVE_STATUSES)
    .eq("is_deleted", false)
    .not("patient_phone", "is", null);

  if (error) {
    logger.warn("Closure broadcast lookup failed", {
      hospitalId,
      error: error.message,
    });
    return 0;
  }

  const bookings = (data ?? []) as BroadcastBookingRow[];
  let enqueued = 0;

  for (const booking of bookings) {
    if (!booking.patient_phone) continue;

    const text = `The hospital is closing for today${
      reason ? ` (${reason})` : ""
    }. Your appointment (token ${booking.token_number}) will need to be rescheduled. Please contact the reception.`;

    await enqueueBroadcast(
      db,
      {
        hospitalId,
        idemKey: `wa_closure_${hospitalId}_${sessionDate}_${booking.id}`,
        phone: await formatE164(db, booking.patient_phone, hospitalId),
        text,
        bookingId: booking.id,
        patientName: booking.patient_name,
        tokenNumber: booking.token_number,
      },
      logger,
    );

    enqueued++;
  }

  return enqueued;
}

// ─── Admin operational broadcast ───────────────────────────────────────────

/**
 * Sends an operational notice to every hospital admin. Key includes
 * the day and kind so each notice goes out at most once per day.
 */
export async function broadcastAdminOperational(
  db: DbClient,
  hospitalId: string,
  kind: AdminBroadcastKind,
  message: string,
  logger: Logger,
): Promise<number> {
  const admins = await loadAdminContacts(db, hospitalId, logger);
  const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  let enqueued = 0;

  for (const admin of admins) {
    await enqueueBroadcast(
      db,
      {
        hospitalId,
        idemKey: `wa_admin_ops_${hospitalId}_${kind}_${today}_${admin.id}`,
        phone: await formatE164(db, admin.normalized_phone, hospitalId),
        text: `[${kind}] ${message}`,
        priority: "normal",
      },
      logger,
    );

    enqueued++;
  }

  return enqueued;
}

// ─── Operational alert broadcast ───────────────────────────────────────────

/**
 * Pushes a fired alert to the hospital admins. Keyed on the alert id
 * so re-running delivery orchestration never duplicates a message.
 */
export async function broadcastAlertToAdmins(
  db: DbClient,
  alert: BroadcastAlert,
  logger: Logger,
): Promise<number> {
  const admins = await loadAdminContacts(db, alert.hospital_id, logger);
  const detail = alert.message ? ` — ${alert.message}` : "";
  let enqueued = 0;

  for (const admin of admins) {
    await enqueueBroadcast(
      db,
      {
        hospitalId: alert.hospital_id,
        idemKey: `wa_ops_alert_bcast_${alert.id}_${admin.id}`,
        phone: await formatE164(db, admin.normalized_phone, alert.hospital_id),
        text:
          `[ALERT:${alert.severity.toUpperCase()}] ${alert.alert_key}${detail}`,
        priority: alert.severity === "critical" ? "high" : "normal",
      },
      logger,
    );

    enqueued++;
  }

  return enqueued;
}
