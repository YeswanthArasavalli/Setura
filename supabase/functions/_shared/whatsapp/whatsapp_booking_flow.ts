/**
 * _shared/whatsapp/whatsapp_booking_flow.ts
 *
 * Phase 1.1 — WhatsApp booking flow.
 *
 *   message -> patient identified -> doctor selected ->
 *   booking created -> token assigned -> confirmation sent
 *
 * No booking logic is duplicated here: allocation happens inside
 * the atomic create_booking RPC (same path the REST endpoint
 * uses), fees come from get_effective_fees, and date checks use
 * the same hospital holiday / working-hours / doctor-availability
 * primitives as reschedule-booking.
 */

import { logAuditEvent } from "../audit.ts";
import { getWeekday, isValidAdvanceBookingDate } from "../validation.ts";
import {
  classifyIntent,
  extractChoice,
  extractName,
  parseDateInput,
} from "./whatsapp_intent_router.ts";
import type {
  ConversationStateName,
  Db,
  FlowContext,
  FlowResult,
} from "./whatsapp_conversation_engine.ts";
import {
  escalateToHandoff,
  WA_PATIENT_ACTOR,
} from "./whatsapp_handoff_flow.ts";

/** Statuses that count as a live booking for duplicate checks. */
const ACTIVE_BOOKING_STATUSES = [
  "booked",
  "checked_in",
  "waiting",
  "called",
  "in_consultation",
];

/** Invalid attempts inside one step before human handoff. */
const MAX_STEP_RETRIES = 3;

export interface BookingFlowState {
  step: "name" | "doctor" | "date" | "confirm";
  patientId?: string;
  patientName?: string;
  doctorId?: string;
  doctorName?: string;
  date?: string;
  promptCount?: number;
}

export function todayIso(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Doctors with an active schedule at the hospital (deduped). */
export async function listActiveDoctors(
  db: Db,
  hospitalId: string,
): Promise<Array<{ id: string; name: string }>> {
  const { data, error } = await db
    .from("doctor_schedules")
    .select("doctor_id")
    .eq("hospital_id", hospitalId)
    .eq("is_active", true);

  if (error) throw new Error(`Doctor list failed: ${error.message}`);

  const ids = [
    ...new Set(
      ((data ?? []) as Array<{ doctor_id: string }>).map((r) => r.doctor_id),
    ),
  ];

  if (ids.length === 0) return [];

  const { data: profiles } = await db
    .from("profiles")
    .select("id, full_name")
    .in("id", ids);

  const names = new Map(
    ((profiles ?? []) as Array<{ id: string; full_name: string }>).map((p) => [
      p.id,
      p.full_name,
    ]),
  );

  return ids.map((id, i) => ({ id, name: names.get(id) ?? `Doctor ${i + 1}` }));
}

/**
 * Validates a requested appointment date against the hospital's
 * booking window, holidays, working hours and doctor schedule.
 * Returns a patient-facing error message, or null when valid.
 */
export async function validateAppointmentDate(
  ctx: FlowContext,
  date: string,
  doctorId: string | null,
): Promise<string | null> {
  const today = todayIso();

  if (date < today) {
    return "That date is in the past. Please choose today or a future date.";
  }

  if (!isValidAdvanceBookingDate(date, ctx.config.maxAdvanceBookingDays)) {
    return `Bookings are open only ${ctx.config.maxAdvanceBookingDays} days ahead. Please choose an earlier date.`;
  }

  const { data: holiday } = await ctx.db
    .from("hospital_holidays")
    .select("id")
    .eq("hospital_id", ctx.hospitalId)
    .eq("holiday_date", date)
    .maybeSingle();

  if (holiday) {
    return "The hospital is closed on that date (holiday). Please pick another date.";
  }

  const { data: hours } = await ctx.db
    .from("hospital_working_hours")
    .select("is_open")
    .eq("hospital_id", ctx.hospitalId)
    .eq("weekday", getWeekday(date))
    .maybeSingle();

  if (hours && !hours.is_open) {
    return "The hospital is closed on that day. Please pick another date.";
  }

  if (doctorId) {
    const { data: avail, error } = await ctx.db.rpc("is_doctor_available", {
      p_doctor_id: doctorId,
      p_hospital_id: ctx.hospitalId,
      p_date: date,
    });

    if (error) {
      throw new Error(`Doctor availability check failed: ${error.message}`);
    }

    if (!avail) {
      return "The doctor is not available on that date. Please pick another date.";
    }
  }

  return null;
}

/**
 * Resolves the patient identity for this phone number. Creates a
 * patient row on first contact once a name is known. Returns null
 * while the name is still unknown (caller prompts for it).
 */
async function ensurePatient(
  ctx: FlowContext,
  state: BookingFlowState,
): Promise<{ id: string; name: string } | null> {
  if (state.patientId) {
    return { id: state.patientId, name: state.patientName ?? "" };
  }

  if (ctx.patientId) {
    const { data } = await ctx.db
      .from("patients")
      .select("id, full_name")
      .eq("id", ctx.patientId)
      .maybeSingle();

    if (data) {
      const row = data as { id: string; full_name: string };
      state.patientId = row.id;
      state.patientName = row.full_name;
      return { id: row.id, name: row.full_name };
    }
  }

  const name = extractName(ctx.text);
  if (!name) return null;

  const { data: inserted, error } = await ctx.db
    .from("patients")
    .insert({
      hospital_id: ctx.hospitalId,
      full_name: name,
      normalized_phone: ctx.phone,
    })
    .select("id, full_name")
    .maybeSingle();

  if (inserted) {
    const row = inserted as { id: string; full_name: string };
    return { id: row.id, name: row.full_name };
  }

  // Unique (hospital_id, normalized_phone) conflict: reuse row.
  const { data: existing } = await ctx.db
    .from("patients")
    .select("id, full_name")
    .eq("hospital_id", ctx.hospitalId)
    .eq("normalized_phone", ctx.phone)
    .eq("is_deleted", false)
    .maybeSingle();

  if (existing) {
    const row = existing as { id: string; full_name: string };
    return { id: row.id, name: row.full_name };
  }

  throw new Error(`Patient creation failed: ${error?.message ?? "unknown"}`);
}

function doctorMenu(doctors: Array<{ name: string }>): string {
  const lines = doctors.map((d, i) => `${i + 1}. ${d.name}`);
  return `Please choose a doctor:\n${
    lines.join("\n")
  }\n\nReply with the doctor number.`;
}

async function proceedAfterDoctor(
  ctx: FlowContext,
  state: BookingFlowState,
): Promise<FlowResult> {
  // A date captured from an earlier message can skip the prompt.
  if (state.date) {
    const err = await validateAppointmentDate(
      ctx,
      state.date,
      state.doctorId ?? null,
    );
    if (!err) return await buildConfirmation(ctx, state);
    state.date = undefined;
    return {
      state: "selecting_date",
      context: { ...state, step: "date", promptCount: 0 },
      replies: [err],
    };
  }

  return {
    state: "selecting_date",
    context: { ...state, step: "date", promptCount: 0 },
    replies: [
      "Which date would you like? You can say *today*, *tomorrow*, a day name (e.g. *Saturday*) or a date like *15/09*.",
    ],
  };
}

async function proceedAfterPatient(
  ctx: FlowContext,
  state: BookingFlowState,
): Promise<FlowResult> {
  const doctors = await listActiveDoctors(ctx.db, ctx.hospitalId);

  if (doctors.length === 0) {
    return {
      state: "idle",
      context: {},
      replies: [
        "Sorry, no doctors are currently accepting bookings. Please contact the hospital directly.",
      ],
    };
  }

  if (doctors.length === 1) {
    state.doctorId = doctors[0].id;
    state.doctorName = doctors[0].name;
    return await proceedAfterDoctor(ctx, state);
  }

  return {
    state: "selecting_doctor",
    context: { ...state, step: "doctor", promptCount: 0 },
    replies: [doctorMenu(doctors)],
  };
}

async function buildConfirmation(
  ctx: FlowContext,
  state: BookingFlowState,
): Promise<FlowResult> {
  const { data: feeRows, error } = await ctx.db.rpc("get_effective_fees", {
    p_hospital_id: ctx.hospitalId,
    p_booking_source: "manual_whatsapp",
  });

  if (error) throw new Error(`Fee lookup failed: ${error.message}`);

  const fee = (feeRows as Array<{ total_amount: number | string }> | null)?.[0];
  const total = fee ? Number(fee.total_amount) : 0;

  const summary = `Please confirm your booking:\n` +
    `• Patient: ${state.patientName}\n` +
    (state.doctorName ? `• Doctor: ${state.doctorName}\n` : "") +
    `• Date: ${state.date}\n` +
    `• Fee: ₹${total}\n\n` +
    `Reply *yes* to confirm or *no* to cancel.`;

  return {
    state: "confirming",
    context: { ...state, step: "confirm", promptCount: 0 },
    replies: [summary],
  };
}

async function executeBooking(
  ctx: FlowContext,
  state: BookingFlowState,
): Promise<FlowResult> {
  const date = state.date!;

  // Same-day duplicate guard: an active booking already exists.
  const { data: existingRows } = await ctx.db
    .from("bookings")
    .select("token_number")
    .eq("hospital_id", ctx.hospitalId)
    .eq("patient_phone", ctx.phone)
    .eq("appointment_date", date)
    .eq("is_deleted", false)
    .in("status", ACTIVE_BOOKING_STATUSES)
    .limit(1);

  if (existingRows && existingRows.length > 0) {
    const token = (existingRows[0] as { token_number: number }).token_number;
    return {
      state: "idle",
      context: {},
      replies: [
        `You already have a booking on ${date} with token *${token}*. Type *status* to check the queue.`,
      ],
    };
  }

  const { data: feeRows, error: feeError } = await ctx.db.rpc(
    "get_effective_fees",
    {
      p_hospital_id: ctx.hospitalId,
      p_booking_source: "manual_whatsapp",
    },
  );

  if (feeError) throw new Error(`Fee lookup failed: ${feeError.message}`);

  const fee = (feeRows as
    | Array<
      { platform_fee: number; receptionist_fee: number; hospital_fee: number }
    >
    | null)?.[0];

  const idemKey = `wa_book_${ctx.hospitalId}_${ctx.phone}_${date}`;

  const { data, error } = await ctx.db.rpc("create_booking", {
    p_hospital_id: ctx.hospitalId,
    p_queue_session_id: undefined,
    p_patient_id: state.patientId ?? undefined,
    p_patient_name: state.patientName,
    p_patient_phone: ctx.phone,
    p_booking_source: "manual_whatsapp",
    p_doctor_id: state.doctorId ?? undefined,
    p_appointment_date: date,
    p_platform_fee: Number(fee?.platform_fee ?? 0),
    p_receptionist_fee: Number(fee?.receptionist_fee ?? 0),
    p_hospital_fee: Number(fee?.hospital_fee ?? 0),
    p_idempotency_key: idemKey,
  });

  if (error) throw new Error(`Booking failed: ${error.message}`);

  const rows = data as
    | Array<
      { booking_id: string; token_number: number }
    >
    | null;

  if (!rows || rows.length === 0) {
    throw new Error("Booking creation returned no result");
  }

  const nb = rows[0];

  ctx.metrics.increment("wa.booking.created");

  await logAuditEvent(
    {
      hospitalId: ctx.hospitalId,
      // audit_logs.actor_user_id is a profiles UUID; WhatsApp
      // patients have none, so attribution goes into notes.
      actorUserId: null as unknown as string,
      entityType: "booking",
      entityId: nb.booking_id,
      actionType: "booking_create",
      severity: "low",
      newData: {
        source: "manual_whatsapp",
        date,
        token: nb.token_number,
        doctorId: state.doctorId ?? null,
      },
      notes: `actor: ${WA_PATIENT_ACTOR}`,
    },
    ctx.logger,
  );

  return {
    state: "idle",
    context: {},
    replies: [
      `Booking confirmed ✅\n` +
      `• Date: ${date}\n` +
      (state.doctorName ? `• Doctor: ${state.doctorName}\n` : "") +
      `• Your token: *${nb.token_number}*\n\n` +
      `Type *status* on the day of your visit to check the live queue.`,
    ],
  };
}

/** Entry point when the booking intent arrives outside a flow. */
export async function startBookingFlow(
  ctx: FlowContext,
): Promise<FlowResult> {
  const state: BookingFlowState = { step: "name", promptCount: 0 };

  // "book appointment tomorrow" — capture the date early.
  const dateHint = parseDateInput(ctx.text);
  if (dateHint) state.date = dateHint;

  const patient = await ensurePatient(ctx, state);

  if (!patient) {
    return {
      state: "booking",
      context: { ...state, promptCount: 0 },
      replies: [
        'Sure, I can help you book an appointment. Please reply with your full name, e.g. "my name is Ravi".',
      ],
    };
  }

  state.patientId = patient.id;
  state.patientName = patient.name;

  return await proceedAfterPatient(ctx, state);
}

/** Advances an in-progress booking flow with the patient's reply. */
export async function continueBookingFlow(
  ctx: FlowContext,
  stateName: ConversationStateName,
  raw: Record<string, unknown>,
): Promise<FlowResult> {
  const state = { ...raw } as unknown as BookingFlowState;
  const retries = (state.promptCount ?? 0) + 1;

  switch (stateName) {
    case "booking": {
      // Awaiting the patient's name.
      const patient = await ensurePatient(ctx, state);

      if (!patient) {
        if (retries >= MAX_STEP_RETRIES) {
          return await escalateToHandoff(ctx, "repeated_flow_failure");
        }
        return {
          state: "booking",
          context: { ...state, promptCount: retries },
          replies: [
            'Sorry, I couldn\'t find your name. Please reply like: "my name is Ravi".',
          ],
        };
      }

      state.patientId = patient.id;
      state.patientName = patient.name;
      return await proceedAfterPatient(ctx, state);
    }

    case "selecting_doctor": {
      const doctors = await listActiveDoctors(ctx.db, ctx.hospitalId);
      const choice = extractChoice(ctx.text);

      if (!choice || choice > doctors.length) {
        if (retries >= MAX_STEP_RETRIES) {
          return await escalateToHandoff(ctx, "repeated_flow_failure");
        }
        return {
          state: "selecting_doctor",
          context: { ...state, promptCount: retries },
          replies: [doctorMenu(doctors)],
        };
      }

      state.doctorId = doctors[choice - 1].id;
      state.doctorName = doctors[choice - 1].name;
      return await proceedAfterDoctor(ctx, state);
    }

    case "selecting_date": {
      const date = parseDateInput(ctx.text);

      if (!date) {
        if (retries >= MAX_STEP_RETRIES) {
          return await escalateToHandoff(ctx, "repeated_flow_failure");
        }
        return {
          state: "selecting_date",
          context: { ...state, promptCount: retries },
          replies: [
            "I didn't understand that date. Try *today*, *tomorrow*, a day name, or dd/mm (e.g. *15/09*).",
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
          state: "selecting_date",
          context: { ...state, promptCount: 0 },
          replies: [err],
        };
      }

      state.date = date;
      return await buildConfirmation(ctx, state);
    }

    case "confirming": {
      const intent = classifyIntent(ctx.text);

      if (intent === "yes") return await executeBooking(ctx, state);

      if (intent === "no") {
        return {
          state: "idle",
          context: {},
          replies: [
            "Okay, I did not book the appointment. Type *book* whenever you need one.",
          ],
        };
      }

      if (retries >= MAX_STEP_RETRIES) {
        return await escalateToHandoff(ctx, "repeated_flow_failure");
      }

      return {
        state: "confirming",
        context: { ...state, promptCount: retries },
        replies: ["Please reply *yes* to confirm or *no* to cancel."],
      };
    }

    default:
      // Unexpected state: reset cleanly so nothing gets stuck.
      return {
        state: "idle",
        context: {},
        replies: ["Let's start again. Type *book* to book an appointment."],
      };
  }
}
