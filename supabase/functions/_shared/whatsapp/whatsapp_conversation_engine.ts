/**
 * _shared/whatsapp/whatsapp_conversation_engine.ts
 *
 * Phase 1.1 — orchestrator for the WhatsApp-first patient
 * experience. Consumes one inbound message, advances the
 * hospital-scoped / phone-scoped state machine, dispatches to
 * the flow modules, and enqueues session-text replies through
 * the existing send pipeline.
 *
 * Rules honored:
 *   - no duplicate booking logic (reuses create_booking RPC,
 *     get_effective_fees, is_doctor_available, initiate_refund,
 *     recalculate_queue_position — same primitives the REST
 *     endpoints use)
 *   - deterministic intent routing (no LLMs)
 *   - state expires automatically; never gets stuck (handoff)
 */

import type { getServiceClient } from "../db.ts";
import { formatE164 } from "../phone.ts";
import { logAuditEvent } from "../audit.ts";
import type { Logger } from "../logger.ts";
import type { Json } from "../types.ts";
import { classifyIntent, type Intent } from "./whatsapp_intent_router.ts";
import {
  continueBookingFlow,
  startBookingFlow,
} from "./whatsapp_booking_flow.ts";
import { handleQueueLookup } from "./whatsapp_queue_flow.ts";
import {
  continueRescheduleFlow,
  startRescheduleFlow,
} from "./whatsapp_reschedule_flow.ts";
import { continueCancelFlow, startCancelFlow } from "./whatsapp_cancel_flow.ts";
import {
  escalateToHandoff,
  WA_PATIENT_ACTOR,
} from "./whatsapp_handoff_flow.ts";

export type Db = ReturnType<typeof getServiceClient>;

export type ConversationStateName =
  | "idle"
  | "booking"
  | "selecting_doctor"
  | "selecting_date"
  | "confirming"
  | "rescheduling"
  | "cancellation"
  | "queue_lookup"
  | "handoff";

export interface MetricSink {
  increment(name: string): void;
}

export interface HospitalWaConfig {
  displayName: string;
  greeting: string;
  queueWording: string;
  language: string;
  maxAdvanceBookingDays: number;
}

export interface FlowContext {
  db: Db;
  logger: Logger;
  metrics: MetricSink;
  hospitalId: string;
  phone: string;
  text: string;
  metaMessageId: string;
  conversationId: string;
  patientId: string | null;
  config: HospitalWaConfig;
}

export interface FlowResult {
  state: ConversationStateName;
  context: Record<string, unknown>;
  replies: string[];
  ttlMinutes?: number;
}

export interface InboundMessage {
  hospitalId: string;
  phone: string;
  text: string;
  metaMessageId: string;
}

export interface ProcessResult {
  duplicate: boolean;
  intent: Intent | "flow_continuation";
  state: ConversationStateName;
  repliesEnqueued: number;
}

/** Consecutive unknown inputs before a human handoff. */
export const HANDOFF_UNKNOWN_THRESHOLD = 3;
const DEFAULT_TTL_MINUTES = 30;

const DEFAULT_GREETING =
  "Hello! Welcome to {hospital}. I can help you book an appointment, check your queue status, reschedule or cancel. What would you like to do?";

const HELP_MENU = "You can say:\n" +
  "• *book* — book an appointment\n" +
  "• *status* — check your token / queue position\n" +
  "• *reschedule* — move your appointment\n" +
  "• *cancel* — cancel your appointment\n" +
  "• *help* — see this menu again";

const FLAG_DISABLED_REPLY =
  "Our WhatsApp assistant is currently unavailable. Please call the hospital directly for assistance.";

const UNKNOWN_REPLY =
  "Sorry, I didn't understand that. Type *help* to see what I can do.";

/** Simple {placeholder} interpolation for configurable wording. */
export function fill(
  template: string,
  vars: Record<string, string | number | null | undefined>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = vars[key];
    return v === null || v === undefined ? "" : String(v);
  });
}

/** Loads per-hospital conversational customization. */
export async function loadHospitalWaConfig(
  db: Db,
  hospitalId: string,
): Promise<HospitalWaConfig> {
  const config: HospitalWaConfig = {
    displayName: "our hospital",
    greeting: DEFAULT_GREETING,
    queueWording: "Queue update",
    language: "en",
    maxAdvanceBookingDays: 7,
  };

  const [{ data: hs }, { data: hospital }] = await Promise.all([
    db
      .from("hospital_settings")
      .select("display_name, preferred_language, metadata")
      .eq("hospital_id", hospitalId)
      .maybeSingle(),
    db
      .from("hospitals")
      .select("name, max_advance_booking_days")
      .eq("id", hospitalId)
      .maybeSingle(),
  ]);

  const hospitalRow = hospital as {
    name?: string;
    max_advance_booking_days?: number;
  } | null;
  if (hospitalRow?.name) config.displayName = hospitalRow.name;
  if (hospitalRow?.max_advance_booking_days) {
    config.maxAdvanceBookingDays = hospitalRow.max_advance_booking_days;
  }

  const settings = hs as {
    display_name?: string | null;
    preferred_language?: string | null;
    metadata?: Record<string, unknown> | null;
  } | null;
  if (settings?.display_name) config.displayName = settings.display_name;
  if (settings?.preferred_language) {
    config.language = settings.preferred_language;
  }
  const meta = settings?.metadata ?? {};
  if (typeof meta.wa_greeting === "string" && meta.wa_greeting) {
    config.greeting = meta.wa_greeting;
  }
  if (typeof meta.wa_queue_wording === "string" && meta.wa_queue_wording) {
    config.queueWording = meta.wa_queue_wording;
  }

  return config;
}

interface StateRow {
  state: ConversationStateName;
  context: Record<string, unknown>;
  unknown_count: number;
}

async function loadState(
  db: Db,
  hospitalId: string,
  phone: string,
): Promise<StateRow | null> {
  const { data, error } = await db.rpc("get_conversation_state", {
    p_hospital_id: hospitalId,
    p_phone: phone,
  });

  if (error) throw new Error(`State load failed: ${error.message}`);

  const rows = data as unknown as Array<StateRow> | null;
  return rows && rows.length > 0 ? rows[0] : null;
}

async function persistState(
  db: Db,
  ctx: FlowContext,
  result: FlowResult,
  intent: Intent | "flow_continuation",
  unknownCount: number,
): Promise<void> {
  const { error } = await db.rpc("set_conversation_state", {
    p_hospital_id: ctx.hospitalId,
    p_phone: ctx.phone,
    p_state: result.state,
    p_context: result.context as unknown as Json,
    p_ttl_minutes: result.ttlMinutes ?? DEFAULT_TTL_MINUTES,
    p_last_intent: intent === "flow_continuation" ? undefined : intent,
    p_unknown_count: unknownCount,
    p_handoff_reason: result.state === "handoff"
      ? String(result.context.reason ?? "unknown")
      : undefined,
  });

  if (error) {
    ctx.logger.warn("Conversation state persist failed", {
      hospitalId: ctx.hospitalId,
      phone: ctx.phone.slice(-4),
      error: error.message,
    });
  }
}

async function enqueueReplies(
  db: Db,
  ctx: FlowContext,
  replies: string[],
): Promise<number> {
  let enqueued = 0;

  for (let i = 0; i < replies.length; i++) {
    const idemKey = `reply_${ctx.metaMessageId}_${i}`;

    const { error } = await db.rpc("enqueue_job", {
      p_job_type: "send_whatsapp_message",
      p_payload: {
        text: replies[i],
        phone: await formatE164(db, ctx.phone, ctx.hospitalId),
        hospital_id: ctx.hospitalId,
        idem_key: idemKey,
      },
      p_priority: "high",
      p_scheduled_at: new Date().toISOString(),
      p_idempotency_key: idemKey,
      p_hospital_id: ctx.hospitalId,
    });

    if (error) {
      ctx.logger.warn("Reply enqueue failed", {
        hospitalId: ctx.hospitalId,
        error: error.message,
        index: i,
      });
    } else {
      enqueued++;
    }
  }

  return enqueued;
}

/** True when the intent should interrupt an in-progress flow. */
function isFlowSwitch(state: ConversationStateName, intent: Intent): boolean {
  const inFlow = state !== "idle" && state !== "handoff" &&
    state !== "queue_lookup";
  if (!inFlow) return false;

  const flowForIntent: Record<string, ConversationStateName[]> = {
    booking: ["booking", "selecting_doctor", "selecting_date", "confirming"],
    reschedule: ["rescheduling"],
    cancel: ["cancellation"],
  };

  const strong: Intent[] = ["book", "reschedule", "cancel", "handoff"];
  return strong.includes(intent) &&
    !flowForIntent[intent]?.includes(state);
}

/**
 * Main entry point: process one inbound WhatsApp text message.
 * Returns a summary for metrics/logging; replies are enqueued
 * as worker jobs (Meta is never called inline).
 */
export async function processInboundMessage(
  db: Db,
  input: InboundMessage,
  logger: Logger,
  metrics: MetricSink,
): Promise<ProcessResult> {
  const base = {
    hospitalId: input.hospitalId,
    phone: input.phone,
    metaMessageId: input.metaMessageId,
  };

  // 1. Idempotent inbound persistence (also upserts conversation)
  const { data: recorded, error: recordError } = await db.rpc(
    "record_incoming_whatsapp_message",
    {
      p_hospital_id: input.hospitalId,
      p_phone: input.phone,
      p_meta_message_id: input.metaMessageId,
      p_text: input.text,
    },
  );

  if (recordError) {
    throw new Error(`Inbound recording failed: ${recordError.message}`);
  }

  const record = recorded as {
    conversation_id: string;
    patient_id?: string | null;
    is_duplicate: boolean;
  };

  metrics.increment("wa.inbound.received");

  if (record.is_duplicate) {
    metrics.increment("wa.inbound.duplicate_skipped");
    return {
      duplicate: true,
      intent: "unknown",
      state: "idle",
      repliesEnqueued: 0,
    };
  }

  const config = await loadHospitalWaConfig(db, input.hospitalId);

  const ctx: FlowContext = {
    db,
    logger,
    metrics,
    hospitalId: input.hospitalId,
    phone: input.phone,
    text: input.text,
    metaMessageId: input.metaMessageId,
    conversationId: record.conversation_id,
    patientId: record.patient_id ?? null,
    config,
  };

  // 2. Feature flag gate — polite fallback, state untouched
  const { data: flagEnabled } = await db.rpc("is_feature_enabled", {
    p_hospital_id: input.hospitalId,
    p_flag_key: "whatsapp_conversation",
  });

  if (flagEnabled === false) {
    metrics.increment("wa.inbound.flag_disabled");
    await enqueueReplies(db, ctx, [FLAG_DISABLED_REPLY]);
    return {
      duplicate: false,
      intent: "unknown",
      state: "idle",
      repliesEnqueued: 1,
    };
  }

  // 3. Load state (expired rows are reset to idle by the RPC)
  const stateRow = await loadState(db, input.hospitalId, input.phone);
  const state: ConversationStateName = stateRow?.state ?? "idle";
  const flowState = stateRow?.context ?? {};
  let unknownCount = stateRow?.unknown_count ?? 0;

  const intent = classifyIntent(input.text);
  let result: FlowResult;
  let effectiveIntent: Intent | "flow_continuation" = intent;

  const bookingStates: ConversationStateName[] = [
    "booking",
    "selecting_doctor",
    "selecting_date",
    "confirming",
  ];

  try {
    if (state === "handoff") {
      // Handed-off conversations stay with staff; acknowledge only.
      result = {
        state: "handoff",
        context: flowState,
        replies: [
          "Our staff has been notified and will respond here shortly. Thank you for your patience.",
        ],
        ttlMinutes: 120,
      };
    } else if (
      bookingStates.includes(state) && !isFlowSwitch(state, intent)
    ) {
      effectiveIntent = "flow_continuation";
      result = await continueBookingFlow(ctx, state, flowState);
    } else if (state === "rescheduling" && !isFlowSwitch(state, intent)) {
      effectiveIntent = "flow_continuation";
      result = await continueRescheduleFlow(ctx, flowState);
    } else if (state === "cancellation" && !isFlowSwitch(state, intent)) {
      effectiveIntent = "flow_continuation";
      result = await continueCancelFlow(ctx, flowState);
    } else {
      // Intent-driven dispatch (also handles flow switches)
      switch (intent) {
        case "book":
          unknownCount = 0;
          result = await startBookingFlow(ctx);
          break;
        case "queue_status":
          unknownCount = 0;
          result = await handleQueueLookup(ctx);
          break;
        case "reschedule":
          unknownCount = 0;
          result = await startRescheduleFlow(ctx);
          break;
        case "cancel":
          unknownCount = 0;
          result = await startCancelFlow(ctx);
          break;
        case "handoff":
          unknownCount = 0;
          result = await escalateToHandoff(ctx, "patient_requested");
          break;
        case "help":
          unknownCount = 0;
          result = {
            state,
            context: flowState,
            replies: [HELP_MENU],
          };
          break;
        case "greeting":
          unknownCount = 0;
          result = {
            state: "idle",
            context: {},
            replies: [
              fill(config.greeting, { hospital: config.displayName }),
              HELP_MENU,
            ],
          };
          break;
        default: {
          unknownCount += 1;
          metrics.increment("wa.intent.unknown");

          if (unknownCount >= HANDOFF_UNKNOWN_THRESHOLD) {
            result = await escalateToHandoff(ctx, "repeated_unknown_intent");
          } else {
            result = {
              state: "idle",
              context: {},
              replies: [UNKNOWN_REPLY],
            };
          }
        }
      }
    }
  } catch (err) {
    // Never leave the conversation stuck: failures escalate.
    logger.error("Flow execution failed; escalating to handoff", {
      ...base,
      error: err instanceof Error ? err.message : String(err),
    });
    metrics.increment("wa.flow.error");
    result = await escalateToHandoff(ctx, "flow_error");
  }

  metrics.increment(`wa.intent.${effectiveIntent}`);
  metrics.increment(`wa.state.${result.state}`);

  await persistState(db, ctx, result, effectiveIntent, unknownCount);

  if (result.state === "handoff") {
    try {
      await logAuditEvent(
        {
          hospitalId: input.hospitalId,
          // audit_logs.actor_user_id is a profiles UUID; WhatsApp
          // patients have none, so attribution goes into notes.
          actorUserId: null as unknown as string,
          entityType: "whatsapp_conversation",
          entityId: record.conversation_id,
          actionType: "whatsapp_send",
          severity: "medium",
          newData: {
            outcome: "handoff",
            reason: String(result.context.reason ?? "unknown"),
            phoneSuffix: input.phone.slice(-4),
          },
          notes: `actor: ${WA_PATIENT_ACTOR}`,
        },
        logger,
      );
    } catch (err) {
      logger.warn("Handoff audit failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const repliesEnqueued = await enqueueReplies(db, ctx, result.replies);

  return {
    duplicate: false,
    intent: effectiveIntent,
    state: result.state,
    repliesEnqueued,
  };
}
