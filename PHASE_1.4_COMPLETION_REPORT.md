# SETURA Phase 1.4 Completion Report — Doctor & Clinical Operations

**Status:** ✅ COMPLETE & CERTIFIED **Date:** 2026-08-11 **Scope:** Phase 1.4 —
Doctor & Clinical Operations **Prior state:** Phase 0, 0.5, 1.1, 1.2 and 1.3
complete and certified; backend architecture frozen.

## Executive Summary

Phase 1.4 makes SETURA a complete doctor operations platform: a doctor can run
an entire OP consultation day — open a session, call patients, consult, take
breaks, handle emergencies, write clinical notes and close out — entirely
through SETURA, with accurate timing, throughput analytics, auditability and
operational safety. Everything is additive, built on the frozen queue runtime,
booking state machine, job queue, SLA, audit and analytics infrastructure.

| Deliverable                      | Implementation                                                                                         | Evidence                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| 1. Doctor session management     | `open_doctor_session` / `close_doctor_session` RPCs + `break`/`resume` over the pause engine           | Migration 46 §5, tests 1–2, 8       |
| 2. Clinical queue operations     | `call_next`/`recall`/`skip`/`restore`/`mark_absent` reuse Phase 1.2 primitives; emergency insertion    | Migration 46 §7, tests 5, 7         |
| 3. Consultation lifecycle        | `start_consultation` / `complete_consultation` / `return_to_waiting` RPCs + trigger-stamped timestamps | Migration 46 §6, tests 3–5          |
| 4. Clinical notes infrastructure | `consultation_notes` append-only table + `save_consultation_note` RPC                                  | Migration 46 §3/§8, tests 10–11     |
| 5. Doctor dashboard API          | `get_doctor_dashboard` composed over `get_queue_snapshot` health + doctor-day statistics               | Migration 46 §9, test 9             |
| 6. Operational safeguards        | One-active-consultation unique partial index, `FOR UPDATE` locking, idempotency, RLS/grants, audit     | Migration 46 §4, tests 6, 10, 13–15 |

**No architecture redesign. No duplicate queue or booking state logic. No
breaking API changes. All clinical actions idempotent, audited and
tenant-isolated.**

## Architecture Changes

All changes are additive. Consultation state lives on `bookings` via the
existing status trigger (which stamps `consultation_started_at` /
`consultation_completed_at`); session control reuses `queue_sessions` and the
Phase 1.2 pause engine; notifications reuse `enqueue_job`; SLA refresh reuses
`trigger_sla_refresh`; every action is recorded through `record_queue_event` and
`write_audit_log`.

### Deliverable 1 — Doctor session management

- `open_doctor_session(hospital, doctor, date?, max_tokens?, actor?)` —
  `FOR UPDATE` locked, idempotent (`already_open` converges on the existing
  session; concurrent opens converge via unique-violation fallback), records a
  `session_started` event. Refuses reopen after close (`session_already_ended`).
- `close_doctor_session(session, actor?, reason?)` — idempotent
  (`already_closed`), reports `waiting_remaining`, records `session_ended` with
  metadata (`early`, `reason`). Early closure notifies every waiting patient via
  WhatsApp free-text jobs keyed `wa_q_close_{session}_{booking}`.
- **Break/resume** reuses the existing pause engine (`runPauseQueue` /
  `runResumeQueue`): paused queues block `advance_queue` with `QUEUE_PAUSED`,
  record `paused`/`resumed` events and enqueue `wa_q_paused_*` /
  `wa_q_resumed_*` notifications.
- **Session recovery:** `open_doctor_session` converges on the day's existing
  session, and `get_doctor_dashboard` reconstructs full state from the database
  — a reconnecting doctor resumes exactly where they left off.

### Deliverable 2 — Clinical queue operations

- `call_next` reuses the `advance_queue` RPC (priority-aware, event-recorded);
  `recall`, `skip`, `restore`, `mark_absent` reuse the Phase 1.2 runtime
  primitives (`runRecallCurrentToken`, `runSkipToken`, `runRestoreToken`,
  `runMarkAbsent`). No queue logic duplicated.
- `insert_emergency_patient(session, name, phone?, reason?, actor?,
  idempotency_key?)`
  — creates a booking at token `MAX+1` with `priority_score = 100` so
  `advance_queue` calls it next, records an `emergency_inserted` event, dedupes
  on the idempotency key.

### Deliverable 3 — Consultation lifecycle

- `start_consultation` — `FOR UPDATE` locked, refuses wrong statuses with typed
  reasons (`session_not_active`, `booking_not_in_session`, `booking_status_{x}`,
  `another_consultation_active`), idempotent for the already-started booking.
  The bookings status trigger stamps `consultation_started_at`.
- `complete_consultation` — stamps `consultation_completed_at`, returns
  `duration_minutes` (rounded 0.1), enqueues an SLA refresh job
  (`sla_{hospital}_{date}_{bucket}`, collapsed by `trigger_sla_refresh`).
- `return_to_waiting` — clears the stale start timestamp and returns the patient
  to the waiting pool; re-callable.
- Daily doctor statistics (completed count, avg wait, avg consultation,
  throughput) are computed in `get_doctor_dashboard` from real timestamp pairs;
  queue utilization = issued tokens / `max_tokens`.

### Deliverable 4 — Clinical notes infrastructure

`consultation_notes` (append-only): `booking_id` (FK CASCADE), `hospital_id` (FK
CASCADE), `doctor_id` (SET NULL), `notes`, `diagnosis_summary`, `prescription`
(JSONB array placeholder), `follow_up_date`, `attachments` (JSONB array
placeholder). Immutability is layered three deep:

1. A mutation trigger raises `consultation_notes is append-only` on direct
   UPDATE/DELETE — depth-aware: at trigger depth > 1 (FK cascade context) it
   returns OLD so cascade deletes proceed. (`RETURN NULL` at cascade depth
   silently skips the child delete and orphans rows — a PostgreSQL RI pitfall
   found and documented during testing.)
2. Explicit privileges: Supabase's default ALL grants to
   anon/authenticated/service_role are revoked; service_role gets INSERT+SELECT
   only.
3. RLS enabled with no policies denies any residual direct access.

`save_consultation_note` is the only writer (SECURITY DEFINER, audited as
`clinical_note`). Multiple notes per consultation are allowed (append-only,
never edited).

### Deliverable 5 — Doctor dashboard API

`get_doctor_dashboard(doctor, hospital)` (STABLE) composes
`get_queue_snapshot`'s health block with doctor-day statistics:

`has_session`, `current_patient`, `next_patients` (next five), counts (`waiting`
/ `called` / `completed`), `avg_wait_minutes`, `avg_consultation_minutes`, pause
state (`is_paused`, `reason`), delay state, `queue_utilization`, and
`session_health` (stalled/paused minutes, throughput, estimated completion).
Idle doctors get `has_session: false` — never another doctor's data.

### Deliverable 6 — Operational safeguards

- **One active consultation per doctor:** unique partial index on
  `bookings(assigned_doctor_id) WHERE status = 'in_consultation'` is the final
  arbiter when two transitions race (test 6 proves exactly one winner).
- **Concurrency safety:** all transitions `FOR UPDATE`-locked with typed refusal
  reasons.
- **Idempotency:** every RPC converges on repeat; the endpoint registers
  `clinical_action` in the audit log with correlation ids.
- **Cross-hospital isolation:** RPCs verify booking↔session hospital match
  (`booking_not_in_session`); the endpoint enforces role membership via
  `resolveAuth` + `requireRole` + hospital-access checks.
- **Audit:** every clinical action written as `clinical_action`, every note as
  `clinical_note` (both registered under the `operations` category).
- **SLA + queue intelligence integration:** completion triggers SLA refresh;
  dashboard exposes the live health block; pause/delay/stall detection from
  Phase 1.3 applies to doctor sessions unchanged.

## SQL Migration

### 46_doctor_clinical_operations.sql (applied from clean reset, 1026 lines, pure ASCII)

1. `queue_runtime_events.event_type` CHECK extended additively with
   `session_started`, `session_ended`, `emergency_inserted`.
2. `audit_action_types`: `clinical_action` and `clinical_note` registered
   (`ON CONFLICT DO NOTHING`).
3. `consultation_notes` table, indexes, depth-aware immutability trigger, RLS,
   explicit privilege revokes/grants.
4. `uq_one_active_consultation_per_doctor` unique partial index.
5. `open_doctor_session` / `close_doctor_session`.
6. `start_consultation` / `complete_consultation` / `return_to_waiting`.
7. `insert_emergency_patient`.
8. `save_consultation_note`.
9. `get_doctor_dashboard` (STABLE).
10. Grants: all new RPCs service_role-only.

Generated types refreshed (`database.generated.ts` covers the new RPCs and
table).

## Shared Runtime Modules

`supabase/functions/_shared/queue/queue_runtime.ts` extended (no signature
changes to existing exports):

- `runOpenDoctorSession` / `runCloseDoctorSession` — RPC wrappers; close fans
  out early-closure WhatsApp notifications per waiting patient.
- `runStartConsultation` / `runCompleteConsultation` / `runReturnToWaiting` —
  RPC wrappers; completion triggers the SLA refresh.
- `runInsertEmergencyPatient` — RPC wrapper with idempotency key passthrough.
- `runSaveConsultationNote` — append-only note writer wrapper.
- `getDoctorDashboard` — dashboard RPC wrapper.

## Edge Function

New `doctor-operations/index.ts` — one endpoint, 15 actions: `start_session`,
`end_session`, `break`, `resume`, `call_next`, `recall`, `skip`, `restore`,
`mark_absent`, `start_consultation`, `complete_consultation`,
`return_to_waiting`, `emergency_insert`, `save_note`, `dashboard`.

Uses the mandated shared infrastructure: `resolveAuth` (JWT → DB-authoritative
role), `requireRole` (doctor), hospital-access validation, zod body validation,
metrics counters, tracing (correlation ids), `write_audit_log` for every
mutation, and idempotency-key support on emergency insertion. Errors map to
typed statuses (401/403/422/409/500) through `fromSeturError`.

## Integration Tests — `tests/integration/doctor_operations.test.ts`

16 tests against the real local stack (no mocks, Meta never called):

1. Session open: idempotent, converges, records `session_started`.
2. Early closure: `waiting_remaining`, `session_ended` metadata, one WhatsApp
   close job per waiting patient, idempotent repeat, reopen refused.
3. Consultation start: trigger-stamped `consultation_started_at`, idempotent,
   waiting booking refused with typed reason.
4. Completion: backdated start → correct `duration_minutes`, completion
   timestamp, SLA refresh job enqueued, idempotent repeat.
5. Return to waiting: start timestamp cleared, booking re-callable.
6. **Concurrent consultation starts: exactly one wins**, loser receives
   `another_consultation_active`.
7. Emergency insertion: token MAX+1, priority 100, called first by
   `advance_queue`, idempotency-key dedupe.
8. Break/resume: paused queue blocks advance (`QUEUE_PAUSED`), events recorded,
   resume restores flow.
9. Dashboard accuracy across the day: counts, current patient, next patients,
   avg consultation, utilization, pause/delay status, idle-doctor
   `has_session: false`.
10. Clinical notes: append-only enforced (UPDATE/DELETE refused even for
    service_role), hospital attribution, second note allowed.
11. Notes cascade correctly with booking deletion (no orphaned rows).
12. Audit registry: `clinical_action` + `clinical_note` under `operations`.
13. **HTTP end-to-end:** real doctor JWT runs start_session → call_next → start
    → complete → dashboard; ≥3 audit rows attributed to the actor.
14. Doctor isolation over HTTP: another doctor's session yields 403s; own
    dashboard shows no session.
15. Hospital isolation at both endpoint (403) and RPC (`booking_not_in_session`)
    layers.
16. Cleanup guard: zero fixture sessions/bookings/hospitals remain.

Fixture notes: same-day sessions need distinct doctors
(`UNIQUE(hospital_id, doctor_id, session_date)`), so synthetic doctors are
created through the local GoTrue admin API. Doctors whose HTTP actions wrote
audit rows cannot be hard-deleted (audit_logs are immutable and their
`actor_user_id` FK is `ON DELETE SET NULL`, which the immutability trigger
rightly refuses); cleanup drops their role rows and leaves the inert
profile/auth-user residue, consistent with the frozen audit architecture.

## Certification Report

Fresh `supabase db reset` (migrations 01→46 + seed) before the final run.

| Gate                            | Result                                                            |
| ------------------------------- | ----------------------------------------------------------------- |
| `supabase db reset`             | ✅ 46/46 migrations applied cleanly                               |
| `deno fmt --check`              | ✅ 232 files                                                      |
| `deno lint`                     | ✅ 60 files, 0 problems                                           |
| `deno task check`               | ✅ 0 type errors across all scripts/tests/edge                    |
| `deno task test` (unit)         | ✅ 37/37                                                          |
| `deno task validate:migrations` | ✅ 0 errors (3 pre-existing warnings from migrations 11/15/20/22) |
| `deno task test:integration`    | ✅ **105/105** (89 existing + 16 new; zero regressions)           |

### Mandatory-rule verification

- **Additive only:** no existing column dropped, no RPC signature changed, no
  existing trigger altered; event CHECK extended additively.
- **Backward compatible:** all 89 prior integration tests and 37 unit tests pass
  unchanged; `advance_queue`, `get_queue_snapshot`, pause/resume and the booking
  status machine behave exactly as before.
- **No duplicate engines:** call/recall/skip/restore/absent reuse Phase 1.2
  primitives; pause/break reuse the pause engine; SLA, jobs, audit, events all
  reuse existing infrastructure.
- **Idempotent:** session open/close, consultation start/complete, emergency key
  dedupe, note appends — tests 1–5, 7.
- **Concurrency-safe:** one-active-consultation index + row locks — test 6.
- **Audited:** every endpoint mutation written as `clinical_action` /
  `clinical_note`; notes themselves immutable — tests 10, 12, 13.
- **Multi-tenant isolation:** endpoint 403s and RPC-level hospital checks —
  tests 14, 15.

## Outcome

SETURA can now run an entire OP consultation workflow — session open, patient
calls, consultations with exact timing, breaks, emergencies, clinical notes,
dashboard-driven decisions and early closure — race-safe, idempotent, fully
audited and tenant-isolated, without touching the frozen architecture.

**Phase 1.4 certified. Ready for the next phase.**
