/**
 * _shared/whatsapp/whatsapp_cancel_flow.ts
 *
 * Phase 1.1 — cancel a booking through WhatsApp.
 *
 * Mirrors the cancel-booking endpoint primitives: optimistic
 * status guard, refund via initiate_refund (booking fee only),
 * queue recalculation via recalculate_queue_position. Refund
 * amount honors the hospital's cancellation_policies same-day
 * percentage when a policy row exists.
 */

import { logAuditEvent } from "../audit.ts";
import { classifyIntent } from "./whatsapp_intent_router.ts";
import type {
  Db,
  FlowContext,
  FlowResult,
} from "./whatsapp_conversation_engine.ts";
import {
  escalateToHandoff,
  WA_PATIENT_ACTOR,
} from "./whatsapp_handoff_flow.ts";
import { todayIso } from "./whatsapp_booking_flow.ts";

const CANCELLABLE_STATUSES = ["booked", "checked_in", "waiting", "called"];

const MAX_STEP_RETRIES = 3;

const CANCELLATION_REASON = "Cancelled by patient via WhatsApp";

export interface CancelFlowState {
  step: "confirm";
  bookingId?: string;
  status?: string;
  date?: string;
  token?: number | null;
  paymentCompleted?: boolean;
  bookingFee?: number;
  queueSessionId?: string | null;
  promptCount?: number;
}

interface CancellableRow {
  id: string;
  status: string;
  appointment_date: string;
  token_number: number | null;
  payment_completed: boolean;
  booking_fee_inr: number | null;
  queue_session_id: string | null;
}

/** Nearest cancellable booking (today or future) for this phone. */
async function findCancellableBooking(
  ctx: FlowContext,
): Promise<CancellableRow | null> {
  const patientFilter = ctx.patientId
    ? `patient_phone.eq.${ctx.phone},patient_id.eq.${ctx.patientId}`
    : `patient_phone.eq.${ctx.phone}`;

  const { data, error } = await ctx.db
    .from("bookings")
    .select(
      "id, status, appointment_date, token_number, payment_completed, booking_fee_inr, queue_session_id",
    )
    .eq("hospital_id", ctx.hospitalId)
    .eq("is_deleted", false)
    .in("status", CANCELLABLE_STATUSES)
    .gte("appointment_date", todayIso())
    .or(patientFilter)
    .order("appointment_date", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Booking lookup failed: ${error.message}`);

  return (data as CancellableRow | null) ?? null;
}

/**
 * Refund percentage per hospital policy. Same-day cancellations
 * use same_day_refund_percentage when a policy exists; otherwise
 * the booking fee is fully refundable.
 */
async function refundPercentage(
  db: Db,
  hospitalId: string,
  appointmentDate: string,
): Promise<number> {
  if (appointmentDate > todayIso()) return 100;

  const { data } = await db
    .from("cancellation_policies")
    .select("same_day_refund_percentage")
    .eq("hospital_id", hospitalId)
    .maybeSingle();

  const row = data as { same_day_refund_percentage: number } | null;
  return row ? Number(row.same_day_refund_percentage) : 100;
}

/** Entry point when the cancel intent arrives. */
export async function startCancelFlow(ctx: FlowContext): Promise<FlowResult> {
  const booking = await findCancellableBooking(ctx);

  if (!booking) {
    const patientFilter = ctx.patientId
      ? `patient_phone.eq.${ctx.phone},patient_id.eq.${ctx.patientId}`
      : `patient_phone.eq.${ctx.phone}`;

    const { data: recent } = await ctx.db
      .from("bookings")
      .select("status")
      .eq("hospital_id", ctx.hospitalId)
      .eq("is_deleted", false)
      .or(patientFilter)
      .order("appointment_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    const row = recent as { status: string } | null;

    if (row?.status === "cancelled") {
      return {
        state: "idle",
        context: {},
        replies: ["Your booking is already cancelled."],
      };
    }

    if (row?.status === "completed") {
      return {
        state: "idle",
        context: {},
        replies: [
          "Your last visit is already completed, so there is nothing to cancel.",
        ],
      };
    }

    return {
      state: "idle",
      context: {},
      replies: [
        "I couldn't find an active booking to cancel. Type *book* to book an appointment.",
      ],
    };
  }

  const state: CancelFlowState = {
    step: "confirm",
    bookingId: booking.id,
    status: booking.status,
    date: booking.appointment_date,
    token: booking.token_number,
    paymentCompleted: booking.payment_completed,
    bookingFee: Number(booking.booking_fee_inr ?? 0),
    queueSessionId: booking.queue_session_id,
    promptCount: 0,
  };

  return {
    state: "cancellation",
    context: { ...state },
    replies: [
      `Cancel your appointment on *${booking.appointment_date}*` +
      (booking.token_number !== null
        ? ` (token ${booking.token_number})`
        : "") +
      `? Reply *yes* to confirm or *no* to keep it.`,
    ],
  };
}

async function executeCancel(
  ctx: FlowContext,
  state: CancelFlowState,
): Promise<FlowResult> {
  const nowIso = new Date().toISOString();

  // Optimistic guard against concurrent staff/patient actions.
  const { data: updated, error: updateError } = await ctx.db
    .from("bookings")
    .update({
      status: "cancelled",
      cancellation_reason: CANCELLATION_REASON,
      cancelled_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", state.bookingId!)
    .eq("status", state.status!)
    .select("id")
    .maybeSingle();

  if (updateError) {
    throw new Error(`Cancel failed: ${updateError.message}`);
  }

  if (!updated) {
    const { data: now_ } = await ctx.db
      .from("bookings")
      .select("status")
      .eq("id", state.bookingId!)
      .maybeSingle();

    const status = (now_ as { status: string } | null)?.status;

    if (status === "cancelled") {
      return {
        state: "idle",
        context: {},
        replies: ["Your booking is already cancelled."],
      };
    }

    return {
      state: "idle",
      context: {},
      replies: [
        "Your booking changed while you were replying. Please type *cancel* to try again.",
      ],
    };
  }

  // Refund path: only when payment was completed and a booking
  // fee was charged. Amount follows the hospital's policy.
  let refundNote = "";

  if (state.paymentCompleted && (state.bookingFee ?? 0) > 0) {
    const pct = await refundPercentage(
      ctx.db,
      ctx.hospitalId,
      state.date!,
    );
    const amount = Math.round(((state.bookingFee ?? 0) * pct) / 100 * 100) /
      100;

    if (amount > 0) {
      const { error: refundError } = await ctx.db.rpc("initiate_refund", {
        p_booking_id: state.bookingId!,
        p_refund_amount_inr: amount,
        p_refund_reason: CANCELLATION_REASON,
        p_initiated_by: null as unknown as string,
      });

      if (refundError) {
        ctx.logger.warn("Refund initiation failed", {
          bookingId: state.bookingId,
          error: refundError.message,
        });
        refundNote =
          "\n\nA refund could not be started automatically. Our staff will follow up shortly.";
      } else {
        refundNote =
          `\n\nRefund of ₹${amount} has been initiated. You will get an update here once it is processed.`;
        ctx.metrics.increment("wa.cancel.refund_initiated");
      }
    } else {
      refundNote =
        "\n\nPer the hospital's same-day cancellation policy, no refund applies for this booking.";
    }
  }

  if (state.queueSessionId) {
    const { error: queueError } = await ctx.db.rpc(
      "recalculate_queue_position",
      { p_booking_id: state.bookingId! },
    );

    if (queueError) {
      ctx.logger.warn("Queue recalculation failed", {
        bookingId: state.bookingId,
        error: queueError.message,
      });
    }
  }

  ctx.metrics.increment("wa.cancel.completed");

  await logAuditEvent(
    {
      hospitalId: ctx.hospitalId,
      // audit_logs.actor_user_id is a profiles UUID; WhatsApp
      // patients have none, so attribution goes into notes.
      actorUserId: null as unknown as string,
      entityType: "booking",
      entityId: state.bookingId,
      actionType: "booking_cancel",
      severity: "medium",
      oldData: { status: state.status },
      newData: {
        status: "cancelled",
        reason: CANCELLATION_REASON,
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
      `Your appointment on ${state.date} has been cancelled.` + refundNote,
    ],
  };
}

/** Advances an in-progress cancellation with the patient's reply. */
export async function continueCancelFlow(
  ctx: FlowContext,
  raw: Record<string, unknown>,
): Promise<FlowResult> {
  const state = { ...raw } as unknown as CancelFlowState;

  if (!state.bookingId) {
    return {
      state: "idle",
      context: {},
      replies: ["Let's start again. Type *cancel* to cancel your booking."],
    };
  }

  const intent = classifyIntent(ctx.text);

  if (intent === "yes") return await executeCancel(ctx, state);

  if (intent === "no") {
    return {
      state: "idle",
      context: {},
      replies: [`Okay, your appointment on ${state.date} stays as is.`],
    };
  }

  const retries = (state.promptCount ?? 0) + 1;
  if (retries >= MAX_STEP_RETRIES) {
    return await escalateToHandoff(ctx, "repeated_flow_failure");
  }

  return {
    state: "cancellation",
    context: { ...state, promptCount: retries },
    replies: ["Please reply *yes* to cancel or *no* to keep the booking."],
  };
}
