/**
 * _shared/whatsapp/whatsapp_queue_flow.ts
 *
 * Phase 1.1 — queue status lookup. Replies with the patient's
 * token, the current live token, patients ahead and an estimated
 * wait time. Read-only: never mutates bookings or the queue.
 *
 * Trigger keywords (see intent router): queue / token / status /
 * my turn / how long / am I next ...
 */

import type {
  FlowContext,
  FlowResult,
} from "./whatsapp_conversation_engine.ts";
import { todayIso } from "./whatsapp_booking_flow.ts";

/** Statuses that still participate in the live queue. */
const QUEUE_ACTIVE_STATUSES = ["booked", "checked_in", "waiting", "called"];

const FALLBACK_AVG_CONSULTATION_MINUTES = 10;

/** E.164-like shape: optional leading '+', then 7-15 digits. */
const VALID_PHONE = /^\+?\d{7,15}$/;

/**
 * Normalizes and validates a phone before it may enter a PostgREST
 * `.or()` filter string. Strips whitespace/separators and any '+'
 * that is not the leading character, then enforces the E.164-like
 * shape. Returns null for anything that cannot be a phone number,
 * which removes PostgREST operator injection from the filter path.
 */
function sanitizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim()
    .replace(/[^\d+]/g, "")
    .replace(/(?!^)\+/g, "");
  return VALID_PHONE.test(cleaned) ? cleaned : null;
}

interface QueueBookingRow {
  id: string;
  status: string;
  token_number: number | null;
  appointment_date: string;
  queue_session_id: string | null;
  assigned_doctor_id: string | null;
}

/** Finds today's booking for this phone, any status. */
async function findTodaysBooking(
  ctx: FlowContext,
): Promise<QueueBookingRow | null> {
  const today = todayIso();

  const patientFilter = ctx.patientId
    ? `patient_phone.eq.${ctx.phone},patient_id.eq.${ctx.patientId}`
    : `patient_phone.eq.${ctx.phone}`;

  const { data, error } = await ctx.db
    .from("bookings")
    .select(
      "id, status, token_number, appointment_date, queue_session_id, assigned_doctor_id",
    )
    .eq("hospital_id", ctx.hospitalId)
    .eq("appointment_date", today)
    .eq("is_deleted", false)
    .or(patientFilter)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Booking lookup failed: ${error.message}`);

  return (data as QueueBookingRow | null) ?? null;
}

/** Current live token + pause/delay state for today (prefers the booking's session). */
async function currentLiveToken(
  ctx: FlowContext,
  preferredSessionId: string | null,
): Promise<{ live: number; paused: boolean; delayMinutes: number }> {
  const today = todayIso();

  const { data } = await ctx.db
    .from("queue_sessions")
    .select("id, current_live_token, is_paused, delay_expected_minutes")
    .eq("hospital_id", ctx.hospitalId)
    .eq("session_date", today)
    .eq("is_active", true);

  const sessions = (data ?? []) as Array<{
    id: string;
    current_live_token: number;
    is_paused: boolean;
    delay_expected_minutes: number | null;
  }>;

  if (sessions.length === 0) {
    return { live: 0, paused: false, delayMinutes: 0 };
  }

  const preferred = preferredSessionId
    ? sessions.find((s) => s.id === preferredSessionId)
    : undefined;

  const chosen = preferred ?? sessions[0];

  return {
    live: chosen.current_live_token,
    paused: chosen.is_paused,
    delayMinutes: chosen.delay_expected_minutes ?? 0,
  };
}

/** Average consultation minutes for the booking's doctor today. */
async function averageConsultationMinutes(
  ctx: FlowContext,
  doctorId: string | null,
): Promise<number> {
  if (!doctorId) return FALLBACK_AVG_CONSULTATION_MINUTES;

  const weekday = new Date().getDay();

  const { data } = await ctx.db
    .from("doctor_schedules")
    .select("average_consultation_minutes")
    .eq("doctor_id", doctorId)
    .eq("hospital_id", ctx.hospitalId)
    .eq("weekday", weekday)
    .eq("is_active", true)
    .maybeSingle();

  const row = data as { average_consultation_minutes: number } | null;
  return row?.average_consultation_minutes ??
    FALLBACK_AVG_CONSULTATION_MINUTES;
}

/** Next future booking (used when there is nothing today). */
async function findNextFutureBooking(
  ctx: FlowContext,
): Promise<{ date: string } | null> {
  const today = todayIso();

  const { data } = await ctx.db
    .from("bookings")
    .select("appointment_date")
    .eq("hospital_id", ctx.hospitalId)
    .eq("patient_phone", ctx.phone)
    .eq("is_deleted", false)
    .eq("status", "booked")
    .gt("appointment_date", today)
    .order("appointment_date", { ascending: true })
    .limit(1)
    .maybeSingle();

  const row = data as { appointment_date: string } | null;
  return row ? { date: row.appointment_date } : null;
}

/** Handles a queue-status intent for one inbound message. */
export async function handleQueueLookup(
  inputCtx: FlowContext,
): Promise<FlowResult> {
  const phone = sanitizePhone(inputCtx.phone);

  if (!phone) {
    // Reject malformed senders before any query is built: the phone
    // feeds a PostgREST `.or()` filter and must be digits-only.
    return {
      state: "queue_lookup",
      context: {},
      replies: [
        `I couldn't identify your phone number. Please contact the hospital for help.`,
      ],
      ttlMinutes: 10,
    };
  }

  // Work with the normalized phone everywhere below.
  const ctx: FlowContext = { ...inputCtx, phone };

  const booking = await findTodaysBooking(ctx);

  if (!booking) {
    const next = await findNextFutureBooking(ctx);
    const suffix = next
      ? ` Your next booking is on ${next.date}.`
      : " Type *book* to book an appointment.";
    return {
      state: "queue_lookup",
      context: {},
      replies: [`You don't have a booking for today.${suffix}`],
      ttlMinutes: 10,
    };
  }

  const hospital = ctx.config.displayName;

  switch (booking.status) {
    case "cancelled":
      return {
        state: "queue_lookup",
        context: { bookingId: booking.id },
        replies: [
          `Your booking for today was cancelled. Type *book* to book again.`,
        ],
        ttlMinutes: 10,
      };

    case "completed":
      return {
        state: "queue_lookup",
        context: { bookingId: booking.id },
        replies: [
          `Your consultation for today is completed. Thank you for visiting ${hospital}.`,
        ],
        ttlMinutes: 10,
      };

    case "no_show":
    case "skipped":
      return {
        state: "queue_lookup",
        context: { bookingId: booking.id },
        replies: [
          `Your token for today was marked as ${
            booking.status === "skipped" ? "skipped" : "no-show"
          }. Please speak to the reception desk if you are at the hospital.`,
        ],
        ttlMinutes: 10,
      };

    case "in_consultation":
      return {
        state: "queue_lookup",
        context: { bookingId: booking.id },
        replies: [
          `It's your turn now — you are in consultation. Your token is *${booking.token_number}*.`,
        ],
        ttlMinutes: 10,
      };

    case "rescheduled":
      return {
        state: "queue_lookup",
        context: { bookingId: booking.id },
        replies: [
          `Your booking for today was rescheduled. Type *status* again after the new date, or *book* for a new appointment.`,
        ],
        ttlMinutes: 10,
      };
  }

  if (!QUEUE_ACTIVE_STATUSES.includes(booking.status)) {
    return {
      state: "queue_lookup",
      context: { bookingId: booking.id },
      replies: [
        `Your booking for today is in '${booking.status}' state. Please contact the hospital for help.`,
      ],
      ttlMinutes: 10,
    };
  }

  if (booking.token_number === null) {
    return {
      state: "queue_lookup",
      context: { bookingId: booking.id },
      replies: [
        `Your booking for today is confirmed but a token has not been assigned yet. Please check back shortly.`,
      ],
      ttlMinutes: 10,
    };
  }

  const { live, paused, delayMinutes } = await currentLiveToken(
    ctx,
    booking.queue_session_id,
  );
  const ahead = Math.max(0, booking.token_number - live - 1);
  const avgMinutes = await averageConsultationMinutes(
    ctx,
    booking.assigned_doctor_id,
  );

  const pauseLine = paused
    ? `• Queue status: *PAUSED* (temporarily on hold)\n`
    : "";

  const delayLine = delayMinutes > 0
    ? `• Doctor delay: ~${delayMinutes} min\n`
    : "";

  ctx.metrics.increment("wa.queue.lookup");

  if (ahead === 0) {
    return {
      state: "queue_lookup",
      context: { bookingId: booking.id, liveToken: live },
      replies: [
        `${ctx.config.queueWording}:\n` +
        `• Your token: *${booking.token_number}*\n` +
        `• Now serving: *${live}*\n` +
        pauseLine +
        delayLine +
        `\nPlease be near the consultation room — you are next.`,
      ],
      ttlMinutes: 10,
    };
  }

  return {
    state: "queue_lookup",
    context: { bookingId: booking.id, liveToken: live },
    replies: [
      `${ctx.config.queueWording}:\n` +
      `• Your token: *${booking.token_number}*\n` +
      `• Now serving: *${live}*\n` +
      pauseLine +
      delayLine +
      `• Patients ahead: ${ahead}\n` +
      `• Estimated wait: ~${ahead * avgMinutes + delayMinutes} min`,
    ],
    ttlMinutes: 10,
  };
}
