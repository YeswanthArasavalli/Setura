# SETURA Phase 1.1 — Completion Report

**Phase:** 1.1 — WhatsApp pilot implementation (WhatsApp-first patient
experience) **Status:** ✅ CERTIFIED **Scope:** SETURA transformed from
WhatsApp-notified into WhatsApp-operated: patients book, check queue status,
reschedule, cancel and get human handoff entirely through WhatsApp.
**Constraints honored:** Frozen architecture respected. No duplicate booking
logic — every flow reuses the existing RPCs (`create_booking`,
`reschedule_booking` primitives, `cancel_booking` primitives, `initiate_refund`,
`recalculate_queue_position`, `is_doctor_available`, `get_effective_fees`).
Deterministic intent classification only — no LLMs. Multi-tenant isolation,
idempotency, and audit behavior preserved.

---

## 1. Executive Summary

Phase 1.1 adds a conversational layer on top of the frozen backend. Inbound
WhatsApp text messages are recorded idempotently, classified by a deterministic
intent router, executed through a hospital-scoped / phone-scoped conversation
state machine with automatic expiry, and answered through the existing WhatsApp
delivery pipeline. All state transitions, flow steps and escalations are driven
by reusable flow modules that call the same RPCs the REST endpoints use.

| Deliverable                     | Resolution                                                                                     | Verified            |
| ------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------- |
| WhatsApp booking flow           | Name → doctor → date → confirm state machine; token via `create_booking`; confirmation reply   | 8 integration tests |
| Queue status flow               | Token, live token, patients ahead, estimated wait from live queue session + doctor schedule    | 4 integration tests |
| Reschedule flow                 | Validation (window/holiday/working hours/doctor), optimistic status guard, new token           | 5 integration tests |
| Cancellation flow               | Cancel + conditional refund (`initiate_refund`) + queue recalculation + confirmation           | 4 integration tests |
| Conversational state management | `whatsapp_conversation_states` table, TTL expiry (RPC + minute-cron sweep), hospital+phone key | 7 integration tests |
| Deterministic intent detection  | Keyword/regex router (EN + Telugu hints), date parser, name/choice extractors                  | unit + integration  |
| Human handoff                   | Patient request, repeated unknown intent, repeated flow failure, flow error → handoff state    | integration tests   |
| Hospital customization          | Greeting, queue wording, language, booking window from `hospital_settings` + `hospitals`       | config loader       |

---

## 2. Changes Delivered

### 2.1 New migration

**`supabase/migrations/42_whatsapp_conversational_engine.sql`**

- `whatsapp_message_status` gains additive `'received'` value for inbound
  messages.
- `whatsapp_conversation_states` — hospital-scoped, phone-scoped state machine:
  `state` CHECK-constrained to
  `idle / booking / selecting_doctor / selecting_date / confirming /
  rescheduling / cancellation / queue_lookup / handoff`,
  JSONB `context` (object-only), `last_intent`, `unknown_count`,
  `handoff_reason`, `expires_at` (default 30 min),
  `UNIQUE (hospital_id, phone_number)`, hospital-id immutability trigger,
  partial index on active expiries.
- `record_incoming_whatsapp_message` — idempotent inbound persistence (Meta
  message id replay → `is_duplicate: true`), conversation upsert, best-effort
  patient link by normalized phone.
- `get_conversation_state` — resets expired rows to idle in place before
  returning, so every consumer sees a consistent view.
- `set_conversation_state` — TTL-aware upsert of state/context/intent.
- `expire_conversation_states` — cron-driven sweep of expired non-idle rows.
- `whatsapp_conversation` feature flag (global default ON; per-hospital override
  without a deploy).
- Grants limited to `service_role` (write) / `authenticated` (read).

### 2.2 New modules (`supabase/functions/_shared/whatsapp/`)

| Module                            | Responsibility                                                                                                                                                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whatsapp_conversation_engine.ts` | Orchestrator: idempotent inbound recording → feature-flag gate → state load → intent dispatch / flow continuation → persist → enqueue replies. Flow errors escalate to handoff; handoffs are audited.                                                                       |
| `whatsapp_intent_router.ts`       | Deterministic classifier (book/queue/reschedule/cancel/help/handoff/yes/no/greeting), date parser (today/tomorrow/weekday/dd-mm), name and choice extractors. No LLMs.                                                                                                      |
| `whatsapp_booking_flow.ts`        | Booking state machine (name → doctor → date → confirm), doctor menu/auto-select, date validation (past/window/holiday/working hours/`is_doctor_available`), patient upsert, `get_effective_fees` + `create_booking` with per-day idempotency key, same-day duplicate guard. |
| `whatsapp_queue_flow.ts`          | Today's booking lookup by phone/patient, status-specific replies (active/cancelled/completed/no-show/in-consultation), patients ahead + estimated wait from live token and `average_consultation_minutes`.                                                                  |
| `whatsapp_reschedule_flow.ts`     | Nearest reschedulable booking resolution, date re-validation, optimistic `status` guard against concurrent changes, fee-snapshot carry-over into the new `create_booking`, `carry_forwarded_from` link, audit trail.                                                        |
| `whatsapp_cancel_flow.ts`         | Cancellable-booking resolution, confirm step, optimistic guard, cancellation policy (`cancellation_policies.same_day_refund_percentage`), conditional `initiate_refund` for captured payments, `recalculate_queue_position`, audit trail.                                   |
| `whatsapp_handoff_flow.ts`        | Escalation to `handoff` state with reason (`patient_requested`, `repeated_unknown_intent`, `repeated_flow_failure`, `flow_error`); handed-off conversations acknowledge only.                                                                                               |

### 2.3 Edge function changes (3 functions)

| Function                | Change                                                                                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run-background-worker` | `process_incoming_whatsapp` stub replaced with the conversation engine: hospital resolution from the Meta phone-number id (fallback: single active hospital), text-only filtering, phone normalization, metrics flush. |
| `run-cron-minute`       | Step 1d: `expire_conversation_states()` sweep; expired count recorded as `wa.state.expired`.                                                                                                                           |
| `send-whatsapp-message` | Additive free-text session branch: `text` + optional `idem_key` payload sends a plain session message (`session_reply` bookkeeping) through the same single Meta sender; template path unchanged.                      |

`process-whatsapp-webhook` needed **no changes**: it already enqueues inbound
`messages` as `process_incoming_whatsapp` jobs with idempotency key
`incoming_${msgId}` (Phase 0.5 work), which the worker now consumes through the
engine.

### 2.4 Regenerated artifacts

- `supabase/functions/_shared/database.generated.ts` regenerated from the live
  local stack (migration 42 objects now typed).

---

## 3. End-to-End Flow Verification

**Booking from WhatsApp** — inbound text → webhook enqueues
`process_incoming_whatsapp` → worker runs the engine →
`record_incoming_whatsapp_message` (replay-safe) → intent `book` → name / doctor
/ date / confirm steps → `get_effective_fees` → `create_booking` (token
allocated by the atomic engine, idempotency key
`wa_book_${hospital}_${phone}_${date}`) → confirmation reply with token → reply
job consumed by `send-whatsapp-message` session-text path. ✅

**Queue lookup** — `status`/`token`/`queue`/`my turn` → today's booking resolved
by phone or patient id → live token from the booking's queue session → patients
ahead and estimated wait computed from `average_consultation_minutes` →
status-specific replies for cancelled / completed / no-show bookings. ✅

**Reschedule** — nearest reschedulable booking captured with fee snapshots → new
date validated (booking window, holiday, working hours, doctor availability) →
optimistic status guard (concurrent cancel/reschedule detected and reported,
never double-booked) → new booking via `create_booking` (idempotency key
`wa_resched_${oldId}_${newDate}`) → old booking marked `rescheduled`, new token
sent. ✅

**Cancellation** — confirm step → optimistic guard → `cancellation_reason`
recorded → refund only when a captured payment exists (`initiate_refund`,
booking fee only) → queue position recalculated → audit `booking_cancel`. ✅

**Conversation reliability** — states expire (RPC resets on read + minute-cron
sweep); strong intent interrupts an in-progress flow; 3 consecutive unknown
inputs escalate to handoff; repeated Meta message ids are hard no-ops; flow
exceptions escalate to handoff so conversations never get stuck. ✅

---

## 4. Test Coverage (per spec requirements)

| Requirement             | Tests (`tests/integration/whatsapp_conversational.test.ts`, 28 total)                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Booking — new patient   | name-first flow, patient row created hospital-scoped, token + confirmation                                                                               |
| Booking — existing      | known phone skips the name step                                                                                                                          |
| Booking — duplicate     | same-day second booking refused politely, count unchanged                                                                                                |
| Booking — idempotent    | `create_booking` replay with same key returns the same booking id                                                                                        |
| Booking — isolation     | second tenant: booking + patient + state stay in tenant B; tenant A sees zero rows                                                                       |
| Queue                   | active (token/live/ahead/wait), no booking redirect, completed report, cancelled report                                                                  |
| Reschedule — success    | old `rescheduled`, new booking + token, `carry_forwarded_from`, idempotency key                                                                          |
| Reschedule — doctor     | `doctor_availability_overrides` block → "not available", booking untouched                                                                               |
| Reschedule — closed     | hospital holiday → "holiday" rejection                                                                                                                   |
| Reschedule — invalid    | garbage date re-prompts without state loss; valid date continues                                                                                         |
| Reschedule — concurrent | staff cancel mid-flow → clean abort, no new booking, exactly one cancelled row                                                                           |
| Cancel — success        | status `cancelled`, reason "Cancelled by patient via WhatsApp"                                                                                           |
| Cancel — already        | re-cancel returns "already cancelled" without error                                                                                                      |
| Cancel — refund         | captured payment order → `initiate_refund` row with exact amount, refund mentioned in reply                                                              |
| Cancel — no refund      | unpaid booking → zero refund rows, no refund wording                                                                                                     |
| Conversation            | expiry reset, intent interruption, repeated-unknown → handoff, Meta replay no-op, explicit handoff + audit, inbound persistence, reply-job payload shape |

---

## 5. Metrics and Audit Additions

**Metrics** (existing pipeline): `wa.inbound.received`,
`wa.inbound.duplicate_skipped`, `wa.inbound.flag_disabled`, `wa.state.expired`,
`wa.handoff.<reason>`, `wa.reschedule.completed`, booking/queue/cancel flow
counters.

**Audit:** WhatsApp-originated booking creates, status changes, and
cancellations are written through `logAuditEvent` with `actor_user_id = NULL`
(patients have no profile UUID) and `notes: "actor: whatsapp_patient"` for
attribution; handoffs are audited as `whatsapp_send` events on entity
`whatsapp_conversation`.

---

## 6. Certification Gate Results

| Gate                                                | Result                                         |
| --------------------------------------------------- | ---------------------------------------------- |
| `supabase db reset` (migrations 01→42 + seed)       | ✅ clean apply                                 |
| `deno fmt --check` (218 files)                      | ✅                                             |
| `deno lint` (53 files)                              | ✅                                             |
| `deno task check` (all functions + tests + scripts) | ✅ 0 errors                                    |
| `deno task validate:migrations`                     | ✅ 0 errors (3 pre-existing warnings)          |
| Unit tests                                          | ✅ 37 passed / 0 failed                        |
| Integration tests (full suite incl. pre-Phase-1.1)  | ✅ 61 passed / 0 failed (33 existing + 28 new) |
| Booking works from WhatsApp                         | ✅ verified end-to-end                         |
| Queue lookup works from WhatsApp                    | ✅ verified end-to-end                         |
| Rescheduling works from WhatsApp                    | ✅ verified end-to-end                         |
| Cancellation works from WhatsApp                    | ✅ verified end-to-end                         |
| Conversation state reliable                         | ✅ expiry, interruption, replay, handoff       |
| Multi-tenant isolation                              | ✅ explicit cross-tenant test                  |
| No backend regression                               | ✅ all 33 pre-existing integration tests pass  |

**Issues found and fixed during test execution** (evidence the suite works):

1. `parseDateInput` matched `dd/mm` against normalized text — normalization
   strips `/` and `-`, so numeric dates never parsed. Fixed to match raw text.
2. `executeReschedule` wrote a nonexistent `rescheduled_at` column — removed;
   `updated_at` is maintained by the existing bookings trigger.
3. Migration 42 header comments contained non-ASCII em-dashes — replaced to keep
   migrations pure ASCII per validation policy.
4. Isolation-test fixture left a 13th `doctor_schedules` row breaking the global
   seed invariant — test now cleans up its tenant fixtures.
5. Holiday fixture insert collided across runs — converted to conflict-safe
   upsert.

---

## 7. Compliance Notes

- **No duplicate booking logic:** every mutation goes through the same RPCs the
  REST endpoints use; fee snapshots, token generation, idempotency keys and
  queue recalculation are unchanged backend behavior.
- **No LLMs:** intent classification is keyword/regex only, fully deterministic
  and unit-testable.
- **Multi-tenant isolation:** state rows are
  `UNIQUE (hospital_id,
  phone_number)`; all flow queries are hospital-scoped;
  hospital id is immutable via trigger.
- **Idempotency:** inbound Meta message id dedupe, per-day booking keys,
  per-reschedule keys, reply-job keys `reply_${metaMessageId}_${i}`.
- **`.github/workflows/ci.yml`** untouched (user whitespace normalization
  preserved).

---

## 8. Files Changed

**New:**

- `supabase/migrations/42_whatsapp_conversational_engine.sql`
- `supabase/functions/_shared/whatsapp/whatsapp_conversation_engine.ts`
- `supabase/functions/_shared/whatsapp/whatsapp_intent_router.ts`
- `supabase/functions/_shared/whatsapp/whatsapp_booking_flow.ts`
- `supabase/functions/_shared/whatsapp/whatsapp_queue_flow.ts`
- `supabase/functions/_shared/whatsapp/whatsapp_reschedule_flow.ts`
- `supabase/functions/_shared/whatsapp/whatsapp_cancel_flow.ts`
- `supabase/functions/_shared/whatsapp/whatsapp_handoff_flow.ts`
- `tests/integration/whatsapp_conversational.test.ts` (28 tests)

**Modified:**

- `supabase/functions/run-background-worker/index.ts`
- `supabase/functions/run-cron-minute/index.ts`
- `supabase/functions/send-whatsapp-message/index.ts`
- `supabase/functions/_shared/database.generated.ts` (regenerated)

---

_Phase 1.1 certified. SETURA is now WhatsApp-operated: the conversation is the
primary patient interface, pilot-ready and backed by a green full-stack suite._
