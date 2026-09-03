# SETURA Phase 1.3 Completion Report — Operations & Exception Management

**Status:** ✅ COMPLETE & CERTIFIED **Date:** 2026-08-11 **Scope:** Security
baseline freeze + Phase 1.3 — Operations & Exception Management **Prior state:**
Phase 0, 0.5, 1.1 and 1.2 complete and certified; backend architecture frozen.

## Executive Summary

Phase 1.3 makes SETURA capable of running a real hospital OP day when things go
wrong: doctors run late, queues congest, pauses overrun and SLAs breach. The
happy path (Phase 1.2) is untouched; everything new sits on top of the existing
queue runtime, alert infrastructure, job queue, cron and audit systems.

| Deliverable                   | Implementation                                                                                        | Evidence                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------- |
| 1. Doctor delay management    | `delay/clear_delay` queue-control actions over `mark_doctor_delay` / `clear_doctor_delay` RPCs        | Migration 45 §1/§5, tests 1–3     |
| 2. Dynamic queue intelligence | Recreated `get_queue_snapshot` with delay-aware estimates + live `health` block                       | Migration 45 §6, test 4           |
| 3. Queue congestion alerts    | `evaluate_queue_health` in cron-minute over `fire_alert` (1h dedupe) + admin WhatsApp notifications   | Migration 45 §7, tests 5–8        |
| 4. Operational safety         | Stall/pause detection with incident events + recovery suggestions, SLA breach alerts, audited actions | Migration 45 §5/§7, tests 5–8, 10 |
| Security baseline freeze      | Phone validation/normalization before PostgREST `.or()` filter construction                           | `whatsapp_queue_flow.ts`          |

**No architecture redesign. No duplicate queue or booking logic. No breaking API
changes. All mutations idempotent. All operational actions audited. All alerts
tenant-isolated.**

## Step 0 — Security Baseline Freeze

The single open security finding from the lightweight scan is closed:

- `whatsapp_queue_flow.ts` now sanitizes `ctx.phone` (strip non-digits except a
  leading `+`) and validates it against `^\+?\d{7,15}$` **before** any PostgREST
  `.or()` filter is constructed. Invalid phones receive a polite rejection
  reply; no query ever sees an unvalidated value, eliminating PostgREST operator
  injection through the phone parameter.
- HMAC verification and the webhook pipeline are unchanged.
- Gates after the fix: `deno fmt` (228 files), `deno lint`, `deno task check`,
  WhatsApp integration suites — all green. The security baseline is frozen.

## Architecture Changes

All changes are additive. The database remains the queue runtime: delay state
lives on `queue_sessions` (broadcast to displays via the existing Realtime
publication, exactly like pause state), alerts flow through migration 24's
`alert_thresholds` / `alert_events` / `fire_alert` infrastructure, and all
notifications reuse the `enqueue_job` idempotency framework.

### Deliverable 1 — Doctor delay management

- `queue_sessions` gains `delay_expected_minutes` (CHECK 1..720 or NULL),
  `delay_started_at`, `delay_reason`. Row mutation broadcasts to queue displays
  automatically through the existing publication.
- `mark_doctor_delay(session, minutes, reason, actor)` — `FOR UPDATE` locked,
  idempotent: identical (minutes, reason) returns `already_delayed`; changed
  values update and record a `doctor_delayed` event with the actor.
- `clear_doctor_delay(session, actor)` — idempotent (`already_clear`), records
  `delay_cleared` with `previous_minutes`.
- Waiting patients are notified via WhatsApp free-text jobs keyed
  `wa_q_delay_{session}_{booking}_{minutes}` — re-notification happens only when
  the delay value actually changes.

### Deliverable 2 — Dynamic queue intelligence

`get_queue_snapshot` recreated with the **same signature** (backward
compatible):

- Waiting estimates now include declared delay: `position × avg + delay`.
- `estimated_wait_next_minutes = avg + delay`.
- New additive `health` block: `delay_active`, `delay_expected_minutes`,
  `actual_avg_consultation_minutes` (from real
  `consultation_started_at/completed_at` pairs), `throughput_per_hour`,
  `avg_estimated_wait_minutes`, `estimated_completion_at`, `last_progress_at`,
  `stalled_minutes`, `paused_minutes`.
- WhatsApp queue-status replies are delay-aware: they report the declared delay
  and fold it into the estimated wait.

### Deliverable 3 — Queue congestion alerts

`evaluate_queue_health()` runs as cron-minute step 1e and scans today's active
sessions:

| Alert key               | Condition                       | Severity | Default threshold |
| ----------------------- | ------------------------------- | -------- | ----------------- |
| `queue_wait_exceeded`   | avg estimated wait              | warning  | 45 min            |
| `queue_length_exceeded` | waiting count                   | warning  | 25 patients       |
| `queue_stalled`         | no progress while patients wait | critical | 20 min            |
| `queue_pause_exceeded`  | pause duration                  | warning  | 30 min            |
| `queue_throughput_low`  | observed consultations/hour     | warning  | 3 per hour        |
| `sla_wait_breach`       | `sla_daily_tracking` avg wait   | warning  | 60 min            |

- Thresholds resolve hospital override → global default → fallback
  (`resolve_alert_threshold`); hospitals self-serve overrides via existing
  `alert_thresholds` rows.
- `try_fire_queue_alert` pre-checks open duplicates and returns the new alert
  payload or NULL, preserving `fire_alert`'s 1-hour dedupe while letting the
  evaluator record incidents exactly once.
- New alerts trigger WhatsApp operational notifications to the hospital's
  admins, keyed `wa_ops_alert_{alert_id}_{admin}` (critical alerts enqueue at
  high priority) — idempotent per alert id.
- Metrics: `queue.health.alerts` counter + `queue.health.new_alerts` gauge;
  results appear in the cron-minute `queue_health` summary.

### Deliverable 4 — Operational safety

- **Stuck queue detection:** stall is measured from the last
  `advanced`/`manually_called` event (falling back to session start), only while
  patients are waiting and the queue is not paused.
- **Recovery suggestions:** each `stalled_detected` incident event carries a
  `recovery_suggestion` (recall / manual call / pause-resume guidance) and
  `stalled_minutes`.
- **SLA breach alerts:** per-hospital from `sla_daily_tracking`, reused
  unchanged.
- **Admin intervention tracking:** delay/clear_delay and all prior control
  actions are written to the immutable audit log; `queue_control` and
  `operational_alert` are registered in `audit_action_types` under the new
  `operations` category.
- **Incident recording:** `stalled_detected` and `pause_exceeded_detected`
  events on `queue_runtime_events` — one per alert, never duplicated on
  re-evaluation.

### Reused foundation (unchanged contracts)

`get_queue_snapshot` signature, `record_queue_event`, `queue_runtime_events`,
`fire_alert` / `alert_thresholds` / `alert_events` (migration 24),
`sla_daily_tracking` + `compute_sla`, `enqueue_job` idempotency,
`run-background-worker`, `run-cron-minute` schedule, `write_audit_log`, Realtime
publication, WhatsApp free-text session messages, feature flags.

**No parallel queue engine.** No booking logic duplicated. Worker unchanged.

## SQL Migration

### 45_queue_operations.sql (applied from clean reset, 999 lines, pure ASCII)

1. `queue_sessions` additive delay columns + CHECK.
2. `queue_runtime_events.event_type` CHECK extended additively with
   `doctor_delayed`, `delay_cleared`, `stalled_detected`,
   `pause_exceeded_detected`.
3. `audit_action_types` category CHECK extended with `operations`;
   `queue_control` (Phase 1.2 backfill) and `operational_alert` registered.
4. Six global threshold defaults (`ON CONFLICT DO NOTHING` — never overrides
   existing rows).
5. `resolve_alert_threshold` (STABLE) and `try_fire_queue_alert` helpers.
6. `mark_doctor_delay` / `clear_doctor_delay` control RPCs.
7. `get_queue_snapshot` recreated, same signature, additive keys.
8. `evaluate_queue_health()` evaluator.
9. Grants: all new RPCs service_role-only.

Generated types refreshed (`database.generated.ts` covers all five new RPCs).

## Shared Runtime Modules

`supabase/functions/_shared/queue/queue_runtime.ts` extended (no signature
changes to existing exports):

- `runMarkDoctorDelayed` / `runClearDoctorDelay` — RPC wrappers + patient
  notification fan-out on first/changed delay only.
- `notifyDoctorDelay` — per-waiting-patient WhatsApp text jobs.
- `evaluateQueueHealth` — evaluator RPC wrapper.
- `notifyAdminsOfQueueAlerts` — hospital-admin lookup via `user_roles` +
  `profiles.normalized_phone`, idempotent per alert id.
- Interfaces: `DelayResult`, `ClearDelayResult`, `QueueHealthAlert`,
  `QueueHealthSummary`, `SnapshotHealth`; `QueueSnapshot` extended with the
  delay fields and optional `health` block.

## Edge Function Changes

- `queue-control/index.ts` — two new actions `delay` (requires `delayMinutes`
  1..720) and `clear_delay`; same auth, isolation, audit and usage-counter
  discipline as the Phase 1.2 actions; audit severity medium.
- `run-cron-minute/index.ts` — new step 1e: evaluate queue health, notify admins
  of new alerts, emit metrics, expose `queue_health` in results.
- `_shared/whatsapp/whatsapp_queue_flow.ts` — phone validation (security
  freeze) + delay-aware status replies.

## Integration Tests — `tests/integration/queue_operations.test.ts`

12 tests against the real local stack (no mocks, Meta never called):

1. Mark delay: columns, `doctor_delayed` event, one notification per waiting
   patient.
2. Idempotent repeat (`already_delayed`); changed minutes re-notifies exactly
   once more per patient.
3. Clear delay idempotent; `delay_cleared` event with `previous_minutes`.
4. Snapshot: delay fields, `health` block, actual avg consultation time,
   delay-aware estimates (`position × avg + delay`).
5. Congestion alert fires once with hospital override threshold; re-run deduped.
6. Stall detection: critical alert + one `stalled_detected` incident with
   recovery suggestion; no duplicate incident on re-run.
7. Pause-exceeded alert + `pause_exceeded_detected` incident.
8. SLA breach alert (hospital-level, `queue_session_id = null`); deduped.
9. Multi-tenant: second hospital's own threshold fires an alert attributed to
   that tenant only.
10. Admin WhatsApp alert notifications enqueued once per alert; repeat is a
    no-op.
11. Audit registry: `queue_control` + `operational_alert` under category
    `operations`.
12. Cleanup guard: zero fixtures remain after the run.

Fixture note: same-day seed-hospital sessions need distinct doctors
(`UNIQUE(hospital_id, doctor_id, session_date)`), so the suite creates synthetic
doctors through the local GoTrue admin API and deletes them during cleanup.

## Certification Report

Fresh `supabase db reset` (migrations 01→45 + seed) before the final run.

| Gate                            | Result                                                            |
| ------------------------------- | ----------------------------------------------------------------- |
| `supabase db reset`             | ✅ 45/45 migrations applied cleanly                               |
| `deno fmt --check`              | ✅ 228 files                                                      |
| `deno lint`                     | ✅ 58 files, 0 problems                                           |
| `deno task check`               | ✅ 0 type errors across all scripts/tests/edge                    |
| `deno task test` (unit)         | ✅ 37/37                                                          |
| `deno task validate:migrations` | ✅ 0 errors (3 pre-existing warnings from migrations 11/15/20/22) |
| `deno task test:integration`    | ✅ **89/89** (77 existing + 12 new; zero regressions)             |

### Mandatory-rule verification

- **Additive only:** no existing column dropped, no RPC signature changed,
  snapshot keeps all Phase 1.2 keys.
- **Backward compatible:** `get_queue_snapshot` same signature; queue-control
  rejects unknown actions as before; cron-minute result object extended, not
  replaced.
- **Idempotent:** delay repeat/changed/clear, alert dedupe (1h), incident
  once-per-alert, notification keys collapse retries — tests 2, 3, 5, 6, 10.
- **Audited:** delay/clear_delay via `queue_control`; alerts via
  `operational_alert`; both registered in `audit_action_types` (test 11).
- **Multi-tenant isolation:** thresholds resolve per hospital; alerts carry the
  session's hospital; evaluator never crosses tenants (test 9).
- **No duplicate engines:** every primitive reuses migrations 24/43/SLA/job
  infrastructure.

## Outcome

SETURA can now operate a full OP day through doctor delays, queue congestion,
long pauses, throughput drops and SLA breaches — with consistent state,
race-safe mutations, idempotent retries, immutable audit trails and proactive
operational notifications — without touching the frozen architecture.

**Phase 1.3 certified. Ready for the next phase.**
