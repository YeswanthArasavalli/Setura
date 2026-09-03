/**
 * _shared/whatsapp/whatsapp_reschedule_flow.ts
 *
 * Phase 1.1 — reschedule an existing booking through WhatsApp.
 *
 * Validation mirrors the reschedule-booking endpoint: booking
 * must be reschedulable, the new date must be within the booking
 * window, not a holiday, hospital open, doctor available. The old
 * booking is marked rescheduled with an optimistic status guard
 * and the new booking is created through the atomic create_booking
 * RPC — no booking logic is duplicated.
 */

import { logAuditEvent } from "../audit.ts";
import { classifyIntent, parseDateInput } from "./whatsapp_intent_router.ts";
import type {
  FlowContext,
  FlowResult,
} from "./whatsapp_conversation_engine.ts";
import {
  escalateToHandoff,
  WA_PATIENT_ACTOR,
} from "./whatsapp_handoff_flow.ts";
import { todayIso, validateAppointmentDate } from "./whatsapp_booking_flow.ts";

const RESCHEDULABLE_STATUSES = ["booked", "checked_in", "waiting"];

type BookingSource =
  | "online"
  | "manual_free"
  | "manual_whatsapp"
  | "walkin";

const MAX_STEP_RETRIES = 3;

export interface RescheduleFlowState {
  step: "date" | "confirm";
  bookingId?: string;
  status?: string;
  oldDate?: string;
  doctorId?: string | null;
  patientId?: string | null;
  patientName?: string | null;
  patientPhone?: string | null;
  bookingSource?: string | null;
  platformFee?: number;
  receptionistFee?: number;
  hospitalFee?: number;
  newDate?: string;
  promptCount?: number;
}

interface ReschedulableRow {
  id: string;
  status: string;
  appointment_date: string;
  assigned_doctor_id: string | null;
  patient_id: string | null;
  patient_name: string | null;
  patient_phone: string | null;
  booking_source: string | null;
  platform_fee_snapshot: number | null;
  receptionist_fee_snapshot: number | null;
  hospital_fee_snapshot: number | null;
}

/** Nearest reschedulable booking for this phone (today+future). */
async function findReschedulableBooking(
  ctx: FlowContext,
): Promise<ReschedulableRow | null> {
  const patientFilter = ctx.patientId
    ? `patient_phone.eq.${ctx.phone},patient_id.eq.${ctx.patientId}`
    : `patient_phone.eq.${ctx.phone}`;

  const { data, error } = await ctx.db
    .from("bookings")
    .select(
      "id, status, appointment_date, assigned_doctor_id, patient_id, patient_name, patient_phone, booking_source, platform_fee_snapshot, receptionist_fee_snapshot, hospital_fee_snapshot",
    )
    .eq("hospital_id", ctx.hospitalId)
    .eq("is_deleted", false)
    .in("status", RESCHEDULABLE_STATUSES)
    .gte("appointment_date", todayIso())
    .or(patientFilter)
    .order("appointment_date", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Booking lookup failed: ${error.message}`);

  return (data as ReschedulableRow | null) ?? null;
}

/** Entry point when the reschedule intent arrives. */
export async function startRescheduleFlow(
  ctx: FlowContext,
): Promise<FlowResult> {
  const booking = await findReschedulableBooking(ctx);

  if (!booking) {
    // Distinguish "already gone" from "never existed".
    const patientFilter = ctx.patientId
      ? `patient_phone.eq.${ctx.phone},patient_id.eq.${ctx.patientId}`
      : `patient_phone.eq.${ctx.phone}`;

    const { data: recent } = await ctx.db
      .from("bookings")
      .select("status, appointment_date")
      .eq("hospital_id", ctx.hospitalId)
      .eq("is_deleted", false)
      .or(patientFilter)
      .order("appointment_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    const row = recent as
      | { status: string; appointment_date: string }
      | null;

    if (row?.status === "cancelled") {
      return {
        state: "idle",
        context: {},
        replies: [
          "Your booking was cancelled, so there is nothing to reschedule. Type *book* to book a new appointment.",
        ],
      };
    }

    if (row?.status === "completed") {
      return {
        state: "idle",
        context: {},
        replies: [
          "Your last visit is already completed. Type *book* to book a new appointment.",
        ],
      };
    }

    return {
      state: "idle",
      context: {},
      replies: [
        "I couldn't find an active booking to reschedule. Type *book* to book a new appointment.",
      ],
    };
  }

  const state: RescheduleFlowState = {
    step: "date",
    bookingId: booking.id,
    status: booking.status,
    oldDate: booking.appointment_date,
    doctorId: booking.assigned_doctor_id,
    patientId: booking.patient_id,
    patientName: booking.patient_name,
    patientPhone: booking.patient_phone,
    bookingSource: booking.booking_source,
    platformFee: Number(booking.platform_fee_snapshot ?? 0),
    receptionistFee: Number(booking.receptionist_fee_snapshot ?? 0),
    hospitalFee: Number(booking.hospital_fee_snapshot ?? 0),
    promptCount: 0,
  };

  // "reschedule to tomorrow" — the date may already be present.
  const dateHint = parseDateInput(ctx.text);
  if (dateHint) return await handleNewDate(ctx, state, dateHint);

  return {
    state: "rescheduling",
    context: { ...state },
    replies: [
      `Your appointment is on ${booking.appointment_date}. Which date would you like instead? You can say *tomorrow*, a day name, or dd/mm (e.g. *15/09*).`,
    ],
  };
}

/** Shared date validation + confirmation prompt. */
async function handleNewDate(
  ctx: FlowContext,
  state: RescheduleFlowState,
  date: string,
): Promise<FlowResult> {
  if (date === state.oldDate) {
    return {
      state: "rescheduling",
      context: { ...state, promptCount: 0 },
      replies: [
        `Your appointment is already on ${date}. Please choose a different date.`,
      ],
    };
  }

  const err = await validateAppointmentDate(
    ctx,
    date,
    state.doctorId ?? null,
  );

  if (err) {
    return {
      state: "rescheduling",
      context: { ...state, promptCount: 0 },
      replies: [err],
    };
  }

  state.newDate = date;
  state.step = "confirm";

  return {
    state: "rescheduling",
    context: { ...state, promptCount: 0 },
    replies: [
      `Move your appointment from ${state.oldDate} to *${date}*? Reply *yes* to confirm or *no* to keep the current date.`,
    ],
  };
}

async function executeReschedule(
  ctx: FlowContext,
  state: RescheduleFlowState,
): Promise<FlowResult> {
  // Optimistic guard: the booking may have changed meanwhile.
  // updated_at is maintained by the bookings trigger.
  const { data: marked, error: markError } = await ctx.db
    .from("bookings")
    .update({ status: "rescheduled" })
    .eq("id", state.bookingId!)
    .eq("status", state.status!)
    .select("id");

  if (markError) {
    throw new Error(`Reschedule failed: ${markError.message}`);
  }

  if (!marked || marked.length === 0) {
    const { data: now_ } = await ctx.db
      .from("bookings")
      .select("status")
      .eq("id", state.bookingId!)
      .maybeSingle();

    const status = (now_ as { status: string } | null)?.status;

    if (status === "rescheduled") {
      return {
        state: "idle",
        context: {},
        replies: ["Your booking was already rescheduled."],
      };
    }

    if (status === "cancelled") {
      return {
        state: "idle",
        context: {},
        replies: [
          "Your booking was cancelled before it could be rescheduled. Type *book* to book a new appointment.",
        ],
      };
    }

    return {
      state: "idle",
      context: {},
      replies: [
        "Your booking changed while you were replying. Please type *reschedule* to try again.",
      ],
    };
  }

  const idemKey = `wa_resched_${state.bookingId}_${state.newDate}`;

  const { data, error } = await ctx.db.rpc("create_booking", {
    p_hospital_id: ctx.hospitalId,
    p_queue_session_id: undefined,
    p_patient_id: state.patientId ?? undefined,
    p_patient_name: state.patientName ?? undefined,
    p_patient_phone: state.patientPhone ?? ctx.phone,
    p_booking_source:
      (state.bookingSource ?? "manual_whatsapp") as BookingSource,
    p_doctor_id: state.doctorId ?? undefined,
    p_appointment_date: state.newDate,
    p_platform_fee: state.platformFee,
    p_receptionist_fee: state.receptionistFee,
    p_hospital_fee: state.hospitalFee,
    p_idempotency_key: idemKey,
  });

  if (error) throw new Error(`Rescheduled booking failed: ${error.message}`);

  const rows = data as
    | Array<
      { booking_id: string; token_number: number }
    >
    | null;

  if (!rows || rows.length === 0) {
    throw new Error("Rescheduled booking returned no result");
  }

  const nb = rows[0];

  // Link the new booking back to the original.
  const { error: linkError } = await ctx.db
    .from("bookings")
    .update({ carry_forwarded_from: state.bookingId })
    .eq("id", nb.booking_id);

  if (linkError) {
    ctx.logger.warn("Carry-forward link failed", {
      bookingId: nb.booking_id,
      error: linkError.message,
    });
  }

  ctx.metrics.increment("wa.reschedule.completed");

  await logAuditEvent(
    {
      hospitalId: ctx.hospitalId,
      // audit_logs.actor_user_id is a profiles UUID; WhatsApp
      // patients have none, so attribution goes into notes.
      actorUserId: null as unknown as string,
      entityType: "booking",
      entityId: state.bookingId,
      actionType: "booking_status_change",
      severity: "medium",
      oldData: { status: state.status, date: state.oldDate },
      newData: {
        status: "rescheduled",
        newDate: state.newDate,
        newBookingId: nb.booking_id,
        via: "whatsapp",
      },
      notes: `actor: ${WA_PATIENT_ACTOR}`,
    },
    ctx.logger,
  );

  return {
    state: "idle",
    context: {},
    replies: [
      `Done! Your appointment is moved to *${state.newDate}*.\n` +
      `• New token: *${nb.token_number}*\n\n` +
      `Type *status* on the day to check the queue.`,
    ],
  };
}

/** Advances an in-progress reschedule flow with the patient's reply. */
export async function continueRescheduleFlow(
  ctx: FlowContext,
  raw: Record<string, unknown>,
): Promise<FlowResult> {
  const state = { ...raw } as unknown as RescheduleFlowState;

  if (!state.bookingId) {
    return {
      state: "idle",
      context: {},
      replies: ["Let's start again. Type *reschedule* to move your booking."],
    };
  }

  if (state.step === "confirm") {
    const intent = classifyIntent(ctx.text);

    if (intent === "yes") return await executeReschedule(ctx, state);

    if (intent === "no") {
      return {
        state: "idle",
        context: {},
        replies: [
          `Okay, your appointment stays on ${state.oldDate}.`,
        ],
      };
    }

    const retries = (state.promptCount ?? 0) + 1;
    if (retries >= MAX_STEP_RETRIES) {
      return await escalateToHandoff(ctx, "repeated_flow_failure");
    }

    return {
      state: "rescheduling",
      context: { ...state, promptCount: retries },
      replies: [
        "Please reply *yes* to confirm or *no* to keep the current date.",
      ],
    };
  }

  // step "date"
  const date = parseDateInput(ctx.text);

  if (!date) {
    const retries = (state.promptCount ?? 0) + 1;
    if (retries >= MAX_STEP_RETRIES) {
      return await escalateToHandoff(ctx, "repeated_flow_failure");
    }
    return {
      state: "rescheduling",
      context: { ...state, promptCount: retries },
      replies: [
        "I didn't understand that date. Try *tomorrow*, a day name (e.g. *Saturday*), or dd/mm (e.g. *15/09*).",
      ],
    };
  }

  return await handleNewDate(ctx, state, date);
}
