# SETURA Phase 1.2 Completion Report — Queue Runtime & Live Operations

**Status:** ✅ COMPLETE & CERTIFIED **Date:** 2026-08-11 **Scope:** Phase 1.2 —
Queue Runtime & Live Operations **Prior state:** Phase 0, 0.5 and 1.1 complete
and certified; backend architecture frozen.

## Executive Summary

Phase 1.2 turns the hospital OP queue from a booking database into a real-time
operational system. Reception advances the queue, doctors drive the consultation
state machine, patients receive WhatsApp queue intelligence, display screens
receive Realtime broadcasts without polling, analytics receive accurate
operational events, and every operation is race-safe and idempotent.

| Capability                  | Implementation                                                                      | Evidence                     |
| --------------------------- | ----------------------------------------------------------------------------------- | ---------------------------- |
| Queue display runtime       | Live token + pause state on `queue_sessions`, `queue_runtime_events` Realtime table | Migrations 43, tests 1/3/9   |
| Queue control API           | New `queue-control` endpoint over 7 idempotent SQL RPCs                             | Endpoint + tests 3–6, 10     |
| Doctor live workflow        | Shared transition table; enforced `waiting→called→in_consultation→completed`        | `booking_state.ts`, test 7   |
| Queue recovery              | `get_queue_snapshot` full state reconstruction from DB alone                        | Migration 43 §7, test 8      |
| Wait-time engine            | Position × doctor throughput estimates inside the snapshot                          | Migration 43 §7, test 8      |
| Operational metrics         | `booking_events` trigger feed + `skipped_bookings` rollup column (no new analytics) | Migration 43 §9, test 5      |
| SLA integration             | `trigger_sla_refresh` debounced enqueue on called/started/completed/no-show/cancel  | Migration 43 §8, test 11     |
| Concurrency hardening       | SKIP LOCKED advance, `FOR UPDATE` locks, optimistic guards, 5-way stress test       | Tests 2, 12                  |
| WhatsApp queue intelligence | Position/pause/resume/skip/restore/recall notifications over existing job queue     | `queue_runtime.ts`, tests 10 |
| Testing                     | 16 new integration tests incl. concurrent stress, race and isolation                | `queue_runtime.test.ts`      |

**No architecture redesign. No breaking API changes. No duplicate booking or
queue logic.**

## Architecture Changes

All changes are additive. The single source of truth for queue mutation remains
the `advance_queue` SKIP LOCKED primitive; control operations are new optimistic
RPCs beside it. Nothing keeps in-memory state: the database is the runtime, so
any client recovers by reading it.

### New modules

- `supabase/functions/_shared/booking_state.ts` — single source of truth for
  booking status transitions (extracted from `update-booking-status`; adds the
  `skipped → waiting` restore path).
- `supabase/functions/_shared/queue/queue_runtime.ts` — Phase 1.2 queue runtime
  service layer: control RPC wrappers, WhatsApp queue intelligence, debounced
  SLA refresh, snapshot/recovery accessor and queue-completion recording.
- `supabase/functions/queue-control/index.ts` — new live queue control endpoint
  (`pause`, `resume`, `recall`, `skip`, `restore`, `mark_absent`, `call`,
  `snapshot`) for receptionist / hospital_admin / global_admin roles with
  hospital isolation checks, audit and usage counters.

### Reused foundation (unchanged contracts)

`create_booking`, `advance_queue` (hardened, same signature),
`queue-next-patient`, `update-booking-status`, `carry-forward-tokens`,
`send-whatsapp-message` (incl. free-text session messages and
`please_come_now`), `process-whatsapp-webhook`, `run-background-worker`
(`compute_sla` job type already existed), `run-cron-minute`,
`compute_sla_tracking`, `write_audit_log`, Realtime publication mutation
pattern, `enqueue_job` idempotency framework, feature flags.

**No worker or cron changes were required**: `trigger_sla_refresh` enqueues the
existing `compute_sla` job type; the worker already dispatches it.

### Modified endpoints

- `queue-next-patient` — pause guard (422 `Queue is paused`), defense-in- depth
  handling of the RPC `QUEUE_PAUSED` error, debounced SLA refresh per advance,
  proactive position updates to the next waiting patients, idempotent
  `queue_completed` event on exhaustion.
- `update-booking-status` — imports the shared transition table (doctor workflow
  enforcement unchanged), debounced SLA refresh on
  called/in_consultation/completed/no_show/cancelled using the booking's own
  appointment date.
- `_shared/whatsapp/whatsapp_queue_flow.ts` — queue-status replies now report
  `PAUSED` state alongside token, patients ahead and estimated wait.
- `_shared/audit.ts` — additive `queue_control` audit action type.

## Migration Summary

### 43_queue_runtime.sql (applied, 1131 lines)

1. `queue_sessions` additive columns: `is_paused`, `paused_at`, `pause_reason`.
   The row update doubles as the Realtime broadcast.
2. `queue_runtime_events` — append-only operational log (`advanced`, `paused`,
   `resumed`, `recalled`, `skipped`, `restored`, `absent_marked`,
   `manually_called`, `queue_completed`), hospital- immutable trigger, RLS,
   added to `supabase_realtime` publication so displays receive completion/pause
   events without polling.
3. `record_queue_event` — internal event recorder with tenant attribution from
   the session.
4. `advance_queue` hardened — pause guard (`RAISE 'QUEUE_PAUSED'`), `started_at`
   initialization, `advanced` event recording; SKIP LOCKED pick semantics
   unchanged.
5. `pause_queue` / `resume_queue` — idempotent (`already_paused` /
   `already_running` result flags).
6. Control RPCs, all optimistic + idempotent: `recall_current_token`,
   `skip_queue_token`, `restore_queue_token`, `mark_patient_absent`,
   `call_queue_token`.
7. `get_queue_snapshot` — recovery primitive and wait-time engine: session
   state, currently-called token, ordered waiting list with positions and
   `position × avg_consultation_minutes` estimates (doctor throughput from
   `doctor_schedules`, 10 min fallback), status counts.
8. `trigger_sla_refresh` — enqueues one `compute_sla` job per hospital per
   5-minute bucket via the `enqueue_job` idempotency conflict, so event bursts
   collapse into a single recompute.
9. Analytics: `analytics_weekly_rollups.skipped_bookings` column;
   `compute_weekly_rollup` recreated byte-identical to migration 21 plus the
   skipped count.
10. Grants: control RPCs service_role-only; snapshot also readable by
    authenticated clients (display/doctor/reception recovery).

### 44_queue_runtime_flag.sql (applied)

Global feature flag `whatsapp_queue_updates` (default **on**) gating the
proactive queue WhatsApp notifications; hospitals can opt out without a deploy.

## Runtime Flow Diagram

```text
Reception                     Edge layer                         Database (single source of truth)
─────────                     ──────────                         ─────────────────────────────────
Advance ───────────► queue-next-patient ──── pause guard ────► advance_queue (SKIP LOCKED, FOR UPDATE)
                     │                                          ├─ bookings: called + called_at
                     │                                          ├─ queue_sessions.current_live_token
                     │                                          └─ queue_runtime_events: 'advanced'
                     ├─ broadcastQueueAdvance ──────────────► queue_sessions UPDATE ══► Realtime ══► displays
                     ├─ notifyQueuePositions ───────────────► job_queue (wa_q_pos_*, deduped)
                     ├─ trigger_sla_refresh ────────────────► job_queue (compute_sla, 5-min bucket)
                     └─ WhatsApp patient_called ────────────► job_queue (wa_called_*)
                                                                        │
Doctor ────────────► update-booking-status ─ shared TRANSITIONS ──► bookings optimistic update (.eq status)
                     │  waiting→called→in_consultation→completed        ├─ booking_events (analytics feed)
                     ├─ broadcastQueueAdvance                            └─ trigger_sla_refresh
                     └─ NOTIFY_ON templates ─────────────────────────► job_queue
                                                                        │
Reception controls ► queue-control ─► runPauseQueue/runResumeQueue ──► pause_queue / resume_queue (idempotent)
                     │                runRecall / runSkip / ...        ├─ queue_sessions.is_paused ══► Realtime
                     │                runRestore / runMarkAbsent       ├─ queue_runtime_events ══► Realtime
                     │                runCallToken                     └─ bookings optimistic status guards
                     └─ snapshot in response ◄── get_queue_snapshot (full reconstruction)
                                                                        │
Patients ◄══ WhatsApp: position / called-now / estimated wait / pause / resume / skip / restore
Displays ◄══ Realtime: queue_sessions (token, pause) + queue_runtime_events (completion, pause)
Analytics ◄─ booking_events trigger + queue_runtime_events + rollups (skipped_bookings) + sla_daily_tracking

Recovery: any crash/refresh/reconnect → get_queue_snapshot(session) rebuilds the exact live state.
```

## Test Coverage (new)

`tests/integration/queue_runtime.test.ts` — 16 tests, all green:

| Area                  | Test                                                                              |
| --------------------- | --------------------------------------------------------------------------------- |
| Advancement           | next-token call + event + tenant attribution; priority_score override             |
| Concurrency stress    | 5-way simultaneous advance → exactly tokens 1–5 called, no duplicates             |
| Pause/resume          | blocks advance (`QUEUE_PAUSED`), idempotent repeat, resume restores flow          |
| Recall                | returns called booking, repeats safely, one `please_come_now` job per recall      |
| Skip/restore/absent   | idempotent refusals, skipped token excluded from advance, booking_events feed     |
| Manual call           | order override, idempotent flag, no duplicate notification, unknown token refusal |
| Doctor workflow       | shared transition matrix: happy path, invalid shortcuts, terminal states          |
| Snapshot/recovery     | full reconstruction, positions, linear wait estimates, counts, null contract      |
| Queue completion      | recorded exactly once on exhaustion                                               |
| WhatsApp intelligence | one pause/resume job per waiting patient; repeat pause adds none                  |
| SLA integration       | burst collapses to one `compute_sla` job per 5-minute bucket                      |
| Race hardening        | skip vs terminal transition: exactly one writer wins                              |
| Isolation             | foreign-tenant booking not controllable through another session                   |
| Cleanup               | zero leftover fixtures                                                            |

## Certification Gate Results

| Gate                                                | Result                                  |
| --------------------------------------------------- | --------------------------------------- |
| `supabase db reset` (migrations 01→44 + seed)       | ✅ clean apply                          |
| `deno task check` (all functions + tests + scripts) | ✅ 0 errors                             |
| `deno lint` (57 files)                              | ✅ 0 warnings                           |
| `deno fmt --check` (225 files)                      | ✅                                      |
| `deno task validate:migrations`                     | ✅ 0 errors (3 pre-existing warnings)   |
| Unit tests                                          | ✅ 37 passed / 0 failed                 |
| All existing integration tests                      | ✅ 61 passed / 0 failed                 |
| New queue runtime tests                             | ✅ 16 passed / 0 failed                 |
| Concurrent queue stress tests                       | ✅ included (5-way advance + skip race) |

**Total: 77/77 integration, 37/37 unit.**

### Issues found and fixed during Phase 1.2

1. `deno task gen:types` failed on Windows with a docker-log pipe error; types
   regenerated by invoking `supabase gen types typescript --local` directly into
   `Out-File`.
2. RPC JSONB results needed `as unknown as` conversions against the generated
   `Json` types; `pause_queue` reason param normalized `null → undefined`.
3. One test call site missed the `logger` argument and two fixture inserts
   missed null assertions — caught by `deno check` before execution.
4. `PHASE_1.1_COMPLETION_REPORT.md` had drifted from `deno fmt` — re-formatted
   to keep the gate green.

## Compliance Notes

- **No architecture redesign:** control RPCs sit beside `advance_queue`;
  Realtime still flows through published-table mutations; worker and cron
  untouched.
- **No breaking API changes:** `advance_queue(UUID)`, `queue-next-patient` and
  `update-booking-status` request/response contracts preserved (additive fields
  only: `queueCompletedEvent`, snapshot).
- **No duplicate booking/queue logic:** token advancement still happens only
  inside `advance_queue`; doctor transitions still enforced by one shared table;
  WhatsApp delivery still flows through `job_queue` → `send-whatsapp-message`.
- **Multi-tenant isolation:** control RPCs match on
  `(booking_id, queue_session_id)`; events inherit hospital from the session;
  endpoint rejects cross-hospital sessions; explicit isolation test.
- **Audit immutability:** all control actions audited via `write_audit_log`
  (`queue_control` / `token_advance`); queue events table is append-only with
  hospital-immutable trigger.
- **Financial isolation:** untouched — no payment/settlement paths changed.
- **Idempotency:** every control RPC returns explicit already-done flags; every
  WhatsApp/SLA enqueue uses a deterministic key collapsed by
  `enqueue_job ON CONFLICT`; completion event recorded once.

## Files Changed

**Migrations (new):** `43_queue_runtime.sql`, `44_queue_runtime_flag.sql`

**New modules:** `supabase/functions/_shared/booking_state.ts`,
`supabase/functions/_shared/queue/queue_runtime.ts`,
`supabase/functions/queue-control/index.ts`,
`tests/integration/queue_runtime.test.ts`

**Modified:** `queue-next-patient/index.ts`, `update-booking-status/index.ts`,
`_shared/whatsapp/whatsapp_queue_flow.ts`, `_shared/audit.ts`,
`_shared/database.generated.ts` (regenerated)

---

**Success criterion:** after Phase 1.2, SETURA can run a hospital OP queue live
throughout the day with synchronized reception, doctors, patients, WhatsApp,
realtime displays, and analytics. ✅
