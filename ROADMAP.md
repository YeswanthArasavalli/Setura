# SETURA v1.0 — Enterprise Execution Plan

> **Version:** 3.0 (locked — no weekly changes after finalization) **Date:**
> 2026-08-10 **Lock notice:** This roadmap is the SETURA v1.0 Enterprise
> Execution Plan. After finalization, changes require explicit approval from the
> project lead. **Basis:** [AUDIT_REPORT.md](AUDIT_REPORT.md) (74 files read) +
> [CROSS_CHECK_REPORT.md](CROSS_CHECK_REPORT.md) **Verdict on ChatGPT's v1
> roadmap:** ~80% correct. Phase ordering was right; four structural flaws fixed
> below. **Amendments applied:** Phase 0.5 (architecture freeze), Phase 4A/4B
> split, Phase 6.5 (production readiness review), i18n moved to Phase 8.

---

## 0. What Was Wrong With the v1 Roadmap

| # | Flaw                                                                                                                                                                                                                            | Evidence from Audit                                                                                                                                                                                                           | Correction                                                                                                            |
| - | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1 | **No test harness phase** — zero tests exist in repo today; Rule 3 ("certification checkpoint per phase") cannot be executed without one                                                                                        | No test files found anywhere in repository                                                                                                                                                                                    | New **Phase 0** created (2 days) before any Phase 1 work                                                              |
| 2 | **Phase 3 (conversational WhatsApp) violates its own Rule 2** — "no feature expansion unless required for production" — full conversational booking is the largest new feature in the program, placed before frontend and pilot | Incoming WA messages enqueue `process_incoming_whatsapp` job ([webhook:621](supabase/functions/process-whatsapp-webhook/index.ts#L621)) but no consumer exists                                                                | Descope to **incoming message consumer only** (queue-position query); defer full conversational booking to post-pilot |
| 3 | **Phase 5 (monitoring) treated as build-from-scratch**                                                                                                                                                                          | `run_health_check()`, `alert_thresholds`, `fire_alert()`, `system_health_snapshots`, [`monitoring-health-check`](supabase/functions/monitoring-health-check/index.ts), structured logging, correlation IDs all exist and work | Phase 5 is "extend alerting delivery channels + dashboards," not "implement monitoring"                               |
| 4 | **Missing audit-identified items entirely**                                                                                                                                                                                     | DLQ replay tooling absent; MV refresh blocks reads (no `CONCURRENTLY`); hardcoded `+91` ([carry-forward-tokens:329](supabase/functions/carry-forward-tokens/index.ts#L329)); no OpenAPI spec; settlement refund edge cases    | Added to appropriate phases below                                                                                     |

---

## Phase 0 — Foundation (NEW, 2 days)

> **Do not skip. Everything else depends on this.**

| Task                          | Detail                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| Stand up local Supabase stack | `supabase init` + `supabase start` + apply all 37 migrations sequentially                |
| Type regeneration             | `supabase gen types typescript --local > _shared/types.ts`                               |
| Test harness                  | Deno test runner config in `deno.json`; first `--allow-none` smoke test                  |
| DB seed script                | Minimum: 1 hospital, 1 doctor, 1 receptionist, 1 global_admin, working hours, fee policy |
| CI skeleton                   | GitHub Actions: `deno check --strict` on all Edge Functions + migration dry-run          |

**Certification gate:** `deno test` passes with 0 tests but harness runs; all 37
migrations apply cleanly to fresh DB; `supabase functions serve` starts without
import errors.

---

## Phase 0.5 — Architecture and Code Freeze (NEW, 1 day)

> **Freeze before building. No redesigns after this point.**

Nothing new enters the codebase without being frozen first. This checkpoint
prevents drift during subsequent phases.

| Freeze Category      | What Gets Locked                                                                               | Evidence of Lock                                          |
| -------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **Database schema**  | Finalize all 37 migration tables + enums. No new tables/columns in Phase 1+.                   | Migration 37 is the last schema change                    |
| **TypeScript types** | `_shared/types.ts` is source of truth. No hand-edited type overrides.                          | Regenerated from DB                                       |
| **API contracts**    | All Edge Function request/response shapes documented. No silent breaking changes.              | OpenAPI spec (Phase 8 documents this; shapes frozen here) |
| **Coding standards** | ESLint + Deno fmt rules locked. New code must pass CI.                                         | `.eslintrc` or `deno.json` fmt config                     |
| **Logging format**   | Structured JSON with correlation_id, hospital_id, actor_id. No `console.log`.                  | Existing pattern in `_shared/logger.ts`                   |
| **Audit format**     | `write_audit_log()` with registered action types from migration 36. No free-text action types. | `audit_action_types` registry                             |
| **RLS pattern**      | `hospital_id` claim + `current_user_role()` check. No exceptions.                              | Existing 176 policies                                     |
| **Error format**     | `SeturaError` hierarchy with status codes. No raw `throw new Error()`.                         | `_shared/errors.ts`                                       |

**Deliverable:** A `ARCHITECTURE.md` file documenting frozen decisions. Every
subsequent phase references this file when implementing.

**Certification gate:** `ARCHITECTURE.md` written, reviewed, and signed off. No
code changes after this checkpoint that modify frozen contracts without explicit
amendment.

---

## Phase 1 — Backend Completion: ~85% → ~95%

### 1.1 WhatsApp Reliability (P0 — Blocks Pilot)

**What exists (verified):**

- Meta Cloud API sender with rate-limit/permanent-fail classification ✅
- HMAC-SHA256 webhook verification with constant-time comparison ✅
- Webhook event dedup + SHA-256 payload hash ✅
- Delivery/read receipt processing ✅
- Worker-only auth (X-Worker-Secret) ✅

**What does NOT exist:**

- Post-send DB updates
  ([send-whatsapp-message/index.ts:571-577](supabase/functions/send-whatsapp-message/index.ts#L571)
  — literal placeholder comments)
- `whatsapp_messages` status transition (`queued` → `sent` → `delivered` →
  `read`)
- `bookings.whatsapp_confirmation_sent` flag update after successful send
- Retry scheduling on transient Meta errors (429, 5xx)
- Permanent failure marking (131047, 131051, 131052, 131053, 131056)
- Delivery reconciliation (webhook status → message row update)

**Implementation:**

1. Complete post-send block in `send-whatsapp-message` — update
   `whatsapp_messages.status`, store `wa_message_id`, set booking flag
2. Add retry path: on 429/5xx, re-enqueue job with `POWER(2, retry_count)`
   backoff; on permanent fail, mark message `failed` + update DLQ
3. Complete webhook status handler: map Meta statuses to `whatsapp_messages` row
   updates
4. Integration test: mock Meta API, verify full lifecycle end-to-end

**Success criteria:**

- Every outbound message has a deterministic lifecycle record
- `booking.whatsapp_confirmation_sent = true` within 30 seconds of successful
  send
- No duplicate sends for same idempotency key
- Failed messages visible in DLQ within 5 minutes

**Files to change:**

- [send-whatsapp-message/index.ts](supabase/functions/send-whatsapp-message/index.ts)
  (lines 571-577)
- [process-whatsapp-webhook/index.ts](supabase/functions/process-whatsapp-webhook/index.ts)
  (status handler)
- Possibly [migration 04](supabase/migrations/04_whatsapp_messaging_engine.sql)
  if status enum needs new values

---

### 1.2 Refund Consistency

**Gap:** [`process-refund/index.ts`](supabase/functions/process-refund/index.ts)
calls Razorpay refund API but never updates `bookings.payment_status_detail` to
`refund_processed`. Refund + booking status are disconnected.

**Implementation:**

1. After successful Razorpay refund: update
   `bookings.payment_status_detail = 'refund_processed'`
2. After failed Razorpay refund: update
   `bookings.payment_status_detail = 'refund_failed'` + log
3. Wire refund events into `financial_ledger` via `refund_debit` entry type
   (enum value exists in
   [migration 34](supabase/migrations/34_payment_ledger_cleanup.sql))
4. Add webhook handler for Razorpay refund status (currently only payment
   webhooks are processed)
5. Settlement reconciliation: verify refund reduces outstanding balance
   correctly

**Success criteria:**

- `bookings.payment_status_detail` always reflects last known refund state
- Financial ledger has matching `refund_debit` entry for every successful refund
- Outstanding balances are accurate after refund (test with concurrent refund +
  settlement)

**Files to change:**

- [process-refund/index.ts](supabase/functions/process-refund/index.ts)
- [cancel-booking/index.ts](supabase/functions/cancel-booking/index.ts) (refund
  trigger path)
- Possibly [verify-payment/index.ts](supabase/functions/verify-payment/index.ts)
  (refund webhook handler)

---

### 1.3 Retention & Maintenance

**Gap:** `run_retention_cleanup()` exists
([migration 23](supabase/migrations/23_retention_&_cleanup_engine.sql)) but is
never called.

**Implementation:**

1. Add retention step to
   [run-cron-nightly/index.ts](supabase/functions/run-cron-nightly/index.ts) —
   new step between partition scheduling and health check
2. Call `run_retention_cleanup()` RPC with `p_dry_run = false` (production) or
   `true` (staging)
3. Add cleanup metrics: rows deleted per table, duration, next scheduled run
4. Add to `monitoring-health-check` POST handler

**Success criteria:**

- Nightly cron runs retention cleanup automatically
- Cleanup results visible in `cleanup_run_log`
- No data loss: verified by checking that medical data (3650-day retention) is
  never deleted

**Files to change:**

- [run-cron-nightly/index.ts](supabase/functions/run-cron-nightly/index.ts)
- [monitoring-health-check/index.ts](supabase/functions/monitoring-health-check/index.ts)

---

### 1.4 Subscription Platform

**Gap:** Subscription columns exist
([migration 32](supabase/migrations/32_subscription_engine.sql)) but nothing
updates them:

- `current_month_bookings` — never incremented
- `current_doctor_count` — never incremented
- `current_receptionist_count` — never incremented
- `booking_limit_remaining` — never computed

**Implementation:**

1. Create trigger on `bookings` INSERT → increment `current_month_bookings` for
   hospital
2. Create trigger on `user_roles` INSERT (where role = 'doctor') → increment
   `current_doctor_count`
3. Create trigger on `user_roles` INSERT (where role = 'receptionist') →
   increment `current_receptionist_count`
4. Add monthly reset cron (1st of month) → reset `current_month_bookings` to 0
5. Create `check_booking_limit()` RPC: returns remaining bookings, or error if
   at limit
6. Wire into `create-booking`: call `check_booking_limit()` before proceeding;
   return 429 if exceeded

**Success criteria:**

- Hospital on Starter plan (50 bookings/month) gets blocked on #51
- Usage visible in dashboard
- Upgrade prompt triggered within 1 hour of limit hit

**Files to change:**

- New trigger SQL (add to migration 32 or new migration, e.g.,
  `38_subscription_enforcement.sql`)
- [create-booking/index.ts](supabase/functions/create-booking/index.ts) (add
  limit check)
- [run-cron-nightly/index.ts](supabase/functions/run-cron-nightly/index.ts)
  (monthly reset)

---

## Phase 2 — Integration Hardening

> Verify all subsystems work together. No new features — only missing wiring.

**Queue ↔ WhatsApp:**

- Verify `queue-next-patient` enqueues `patient_called` template
- Verify `update-booking-status` → `consultation_started` enqueues notification

**Booking ↔ Payments:**

- Verify `create-booking` creates `payment_order` atomically
- Verify `verify-payment` updates both `payment_orders` and `bookings`

**Booking ↔ Refunds:**

- Verify `cancel-booking` with `paid_online=true` triggers refund
- Verify refund completion updates booking status

**Payments ↔ Settlements:**

- Verify `settlement-engine` reads `financial_ledger` correctly
- Verify platform revenue summary includes gateway fee + GST deductions

**Cron ↔ Workers:**

- Verify `run-cron-minute` wakes worker when `ENABLE_WORKER_TRIGGER=true`
- Verify `run-cron-nightly` does NOT wake worker (nightly tasks are synchronous)

**Analytics ↔ Materialized Views:**

- Add `CONCURRENTLY` to MV refresh (eliminates read blocking)
- Verify refresh order respects dependencies

**Deliverable:** Integration matrix — 8 workflows × 6 verification checks each.

---

## Phase 2.5 — Enterprise Validation (NEW, 1 day)

> **Validate before frontend. Prevents frontend work from being built on
> changing APIs.**

> **Note:** Phase 0.5 froze the contracts; Phase 2.5 **verifies** they held
> through Phases 1–2 implementation. Different phases, different purpose.

| Check                          | What to verify                                                                                                                                 | Evidence                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **API contract freeze**        | All Edge Function request/response shapes match Phase 0.5 freeze document. No silent breaking changes from Phase 1 work.                       | Diff `ARCHITECTURE.md` API section vs actual Edge Function handlers |
| **Database migration freeze**  | No schema changes slipped in outside approved migration path. All 37 migrations still apply cleanly.                                           | Fresh DB apply + `supabase db diff`                                 |
| **Security audit**             | RLS policies active on all tables. No service-role leaks in user-facing paths. `SECURITY DEFINER` functions reviewed.                          | `pg_policies` check + manual code review                            |
| **Performance benchmark**      | Baseline response times for critical paths: `create-booking`, `advance_queue`, `verify-payment`. Record for regression comparison.             | p50/p95/p99 latency measurements                                    |
| **Disaster recovery test**     | Simulate worker crash mid-lease → verify job reclaimed. Simulate Meta API outage → verify retry + DLQ.                                         | Observed behavior + timing                                          |
| **Observability verification** | Every Phase 1 change emits structured logs with correlation_id. Audit trail complete for new operations. Alerts fire for tested failure modes. | Log samples + alert test                                            |

**Certification gate:** All 6 checks pass. If any check fails, fix before Phase
3/4A.

**Deliverable:** Enterprise Validation Report — pass/fail per item with
evidence.

---

## Phase 3 — Incoming WhatsApp Consumer (Descoped)

> Original v1 Phase 3 was "full conversational booking." Descoped to implement
> the missing consumer.

**Current state:** `process-whatsapp-webhook` enqueues
`process_incoming_whatsapp` jobs but no worker handler exists for this job type.

**Implementation:**

1. Create `process-incoming-whatsapp` Edge Function
2. Implement command parser for basic queries:
   - STATUS / QUEUE / POSITION → query `bookings` for caller's active booking,
     return token position + estimated wait
   - CANCEL → look up booking by phone, offer cancellation via payment links
3. Respond via `send-whatsapp-message` with template

**Out of scope (defer to post-pilot):**

- Conversational booking flow
- Multilingual templates (add `name_te` later)
- Full NLP / intent detection

---

## Phase 4A — Operational Frontend (NEW split)

> All data APIs exist; this is pure UI. Operational dashboards = frontline daily
> use.

| Dashboard     | Data source                                              | Realtime                        |
| ------------- | -------------------------------------------------------- | ------------------------------- |
| Reception     | `bookings`, `queue_sessions`, `daily_collection_entries` | `broadcastQueueAdvance()`       |
| Doctor        | `bookings`, `is_doctor_available()`                      | `broadcastQueueAdvance()`       |
| Queue display | `bookings` (token_number, status)                        | Supabase Realtime on `bookings` |

**Requirements:** Responsive, role-based routing, real-time queue updates,
mobile-first for reception/doctor.

---

## Phase 4B — Management Frontend (NEW split)

> Management dashboards = analytics, financials, monitoring. Higher complexity,
> lower urgency.

| Dashboard         | Data source                                    | Realtime  |
| ----------------- | ---------------------------------------------- | --------- |
| Analytics         | `mv_daily_stats`, rollups, SLA                 | On-demand |
| Settlement        | `hospital_settlements`, `outstanding_balances` | On-demand |
| Monitoring        | `system_health_snapshots`, `alert_events`      | On-demand |
| Audit log         | `audit_logs`, `audit_action_types`             | On-demand |
| Config management | `hospital_settings`, `feature_flags`           | On-demand |

**Requirements:** Audit log viewer, settlement reconciliation view, feature flag
management UI.

---

## Phase 5 — Operational Excellence (Reduced Scope)

> v1 roadmap assumed monitoring didn't exist. It does. Phase 5 = extend, not
> build.

**Already done (verified):**

- Health checks with computed score ✅
- Alert thresholds + firing ✅
- SLA daily tracking ✅
- Structured JSON logging ✅
- Correlation IDs ✅
- Metrics collectors ✅

**What to add:**

1. **Alert delivery:** Configure `alert_events` → notification channel
   (email/Slack/WhatsApp to ops)
2. **Dashboards:** Frontend views for `monitoring_dashboard` +
   `queue_metrics_snapshots`
3. **Incident reports:** Auto-generate incident summary on health score <
   threshold
4. **Log retention:** Wire `audit_logs` and `security_events` into retention
   engine

---

## Phase 6 — Testing & Certification

> Now meaningful because Phase 0 built the harness.

| Test type   | What to verify                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Functional  | Booking lifecycle (create → pay → token → consult → complete), queue advance, refund flow, settlement generation                         |
| Concurrency | 10 parallel `create-booking` calls → unique tokens; 2 parallel `advance_queue` calls → no double-call                                    |
| Load        | 3 hospitals × 5 receptionists × 100 bookings/hour sustained for 10 minutes                                                               |
| Failure     | Kill worker mid-job → lease expires → jobs reclaimed; Meta API 429 → retry with backoff; Razorpay timeout → no capture without signature |
| WhatsApp    | Full lifecycle: send → deliver → read; retry on 429; permanent fail → DLQ                                                                |

**Certification checklist:** Every phase, verify:

- [ ] All tests pass
- [ ] No new TypeScript strict errors
- [ ] Migrations apply cleanly
- [ ] RLS policies active
- [ ] Audit trail complete
- [ ] No regressions

---

## Phase 6.5 — Production Readiness Review (NEW, go/no-go gate)

> **This is a hard gate before pilot. No exceptions.**

| Review Item                 | What to verify                                                                                 | Pass/Fail |
| --------------------------- | ---------------------------------------------------------------------------------------------- | --------- |
| **Security review**         | OWASP top 10 audit, RLS coverage check, secrets rotation, CORS lockdown, rate limit validation | [ ]       |
| **Migration rollback test** | Every migration has a tested rollback path. Rollback + re-apply succeeds cleanly.              | [ ]       |
| **Backup restore test**     | Supabase point-in-time recovery tested end-to-end. Restore to a point, verify data integrity.  | [ ]       |
| **Load test sign-off**      | Phase 6 load test results reviewed. No OOM, no connection pool exhaustion, no deadlock.        | [ ]       |
| **Incident response drill** | Simulate: Meta API outage, Razorpay webhook delay, DB connection loss. Verify recovery.        | [ ]       |
| **Deployment rehearsal**    | Full deploy to a staging environment. Verify all 37 migrations, Edge Functions, worker, cron.  | [ ]       |
| **Feature flag freeze**     | All feature flags set to intended production values. No accidental `telemedicine=true`.        | [ ]       |

**Certification gate:** All 7 items pass. If any item fails, Phase 7 does not
start until fixed and re-tested.

---

## Phase 7 — Pilot Deployment

> Deploy one real hospital from seed data.

**Hospital:** Choose one of the 5 seeded Narsapur hospitals (Surya Hospital
recommended — first in seed).

**Steps:**

1. **Config:** Set `booking_fee_policies`, `cancellation_policies`,
   `queue_configs`, `hospital_settings` for pilot hospital
2. **Users:** Create 1 hospital_admin, 1 doctor, 1 receptionist with real
   Supabase Auth accounts
3. **WhatsApp:** Configure Meta Business account for pilot hospital (or use
   platform number)
4. **Razorpay:** Create Razorpay merchant account (or use test keys for pilot)
5. **Frontend:** Deploy to Vercel/Netlify with Supabase URL + Anon Key
6. **Smoke test:** Create real booking, pay, verify WhatsApp, advance queue
7. **Training:** Walk receptionist and doctor through dashboard
8. **Monitor:** 24-hour soak with `monitoring-health-check` running every minute
9. **Collect:** All metrics from Phase 6 + qualitative feedback

**Deliverable:** Pilot report with actual metrics, issue log, and go/no-go for
multi-hospital rollout.

---

## Phase 8 — Commercial Launch

| Item                     | Why it matters                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| Deployment automation    | New hospital setup in < 30 minutes                                                         |
| OpenAPI documentation    | Third-party integrations                                                                   |
| Backup + DR runbook      | Supabase point-in-time recovery                                                            |
| Security review          | External pen test                                                                          |
| Compliance review        | Indian healthcare data (DPDP Act 2023)                                                     |
| Onboarding guide         | Hospital admin self-serve setup                                                            |
| Pricing integration      | Razorpay subscription billing (currently schema-only)                                      |
| Support procedures       | Escalation paths, SLA definitions                                                          |
| **Internationalization** | **India-first pilot confirmed. Parameterize `+91` prefix before any non-India expansion.** |

**Internationalization note:** Hardcoded `+91` prefix
([carry-forward-tokens:329](supabase/functions/carry-forward-tokens/index.ts#L329),
[send-whatsapp-message](supabase/functions/send-whatsapp-message/index.ts)) is
correct for the India-first pilot. Before any multi-country expansion:

1. Add `phone_country_code` to `hospitals` table
2. Replace hardcoded `+91` with hospital-specific country code
3. Update WhatsApp template formatting to support international numbers
4. Verify Razorpay supports the target country's currency

---

## Execution Order (v1.0 Final)

```
Phase 0 → 0.5 → 1.1 → 1.2 → 1.3 → 1.4 → 2 → 2.5 → 3 → 4A → 4B → 5 → 6 → 6.5 → 7 → 8
  2d    1d    2d    2d    1d    2d   2d   1d   3d   5d   5d   3d   5d   1d   7d  ongoing
───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
Total: ~45 days to complete all phases (backend work + frontend + pilot prep)
```

---

## Key Dependencies

```
Phase 0 (harness)
  └→ Phase 0.5 (freeze) ← blocks all implementation
       └→ Phase 1.1 (WhatsApp) ← CRITICAL: blocks pilot
       └→ Phase 1.2 (Refunds) ← CRITICAL: blocks pilot
       └→ Phase 1.3 (Retention) ← blocks prod stability
       └→ Phase 1.4 (Subscriptions) ← blocks SaaS revenue
            └→ Phase 2 (Integration) ← blocks everything
                 └→ Phase 2.5 (Enterprise Validation) ← verifies freeze held
                      └→ Phase 3 (WA consumer) ← enhances pilot UX
                      └→ Phase 4A (Operational FE) ← required for pilot
                           └→ Phase 4B (Management FE) ← enhances pilot
                                └→ Phase 5 (Ops) ← required for pilot
                                     └→ Phase 6 (Testing) ← cert gate
                                          └→ Phase 6.5 (Prod Readiness) ← HARD GATE
                                               └→ Phase 7 (Pilot) ← go/no-go
                                                    └→ Phase 8 (Launch)
```

---

_Roadmap v1.0 Enterprise Execution Plan. Every claim anchored to file:line
evidence from audit. Amendments: Phase 0.5 freeze, Phase 4A/4B split, Phase 6.5
prod readiness gate, i18n in Phase 8._
