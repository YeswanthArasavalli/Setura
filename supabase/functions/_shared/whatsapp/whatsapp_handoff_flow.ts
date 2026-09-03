/**
 * _shared/whatsapp/whatsapp_handoff_flow.ts
 *
 * Phase 1.1 — human handoff. A conversation is handed to staff
 * when the patient asks, when intents repeatedly fail, or when
 * a flow errors. Conversations must never get stuck.
 */

import type {
  FlowContext,
  FlowResult,
} from "./whatsapp_conversation_engine.ts";

const HANDOFF_REPLY =
  "I'm connecting you with our staff. Someone from the hospital will respond here shortly. You can also call us directly if this is urgent.";

/** Patient identity used for WhatsApp-originated audit rows. */
export const WA_PATIENT_ACTOR = "whatsapp_patient";

export type HandoffReason =
  | "patient_requested"
  | "repeated_unknown_intent"
  | "repeated_flow_failure"
  | "flow_error";

export function escalateToHandoff(
  ctx: FlowContext,
  reason: HandoffReason,
): Promise<FlowResult> {
  ctx.metrics.increment(`wa.handoff.${reason}`);

  // Surface the conversation for staff: unread count is already
  // incremented on every inbound message; the handoff state row
  // carries the reason for the dashboard.
  return Promise.resolve({
    state: "handoff",
    context: {
      reason,
      phone: ctx.phone,
      handed_off_at: new Date().toISOString(),
    },
    replies: [HANDOFF_REPLY],
    ttlMinutes: 120,
  });
}
