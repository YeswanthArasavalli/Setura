# SETURA — Product Description vs. Actual Codebase Cross-Verification Report

> **Report date:** 2026-08-08 **Purpose:** Verify every claim in the SETURA
> product description against the audited codebase **Codebase audited:** 16
> shared modules, 21 Edge Functions, 37 SQL migrations (~74 source files,
> ~36,000+ lines total) **Companion document:**
> [AUDIT_REPORT.md](AUDIT_REPORT.md) (full technical audit, Phases 1–11)
> **Verification method:** Full sequential read of all source files + targeted
> grep spot-checks of security/integration claims

---

## 1. Executive Verdict

**The product description is overwhelmingly honest and accurate about what
exists.** Almost every headline claim is backed by real, production-quality
code. The few gaps are:

1. **"~95% backend complete" → realistically ~85%.** Four concrete gaps remain:
   the `send-whatsapp-message` DB-state placeholder, refund→booking status sync,
   un-wired retention cron, and subscription usage counters that never update.
2. **"WhatsApp-first" → currently "WhatsApp-notified."** Outbound messaging is
   fully built; the conversational booking bot is not.
3. **"Hospital dashboards" → data exists, screens don't.** There is no frontend
   at all.

Nothing in the codebase contradicts the business model, the multi-tenant
architecture claims, or the security claims. Several systems are **stronger**
than the marketing copy suggests (queue atomics, webhook security, settlement
math, audit immutability).

---

## 2. Claim-by-Claim Verification

### 2.1 Core Product Flow ("How SETURA Works")

| Flow Step                    | Claim                                    | Verification Result                                                                                                                                                                                                                                                                                     |
| ---------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Patient books appointment    | Online appointment booking               | ✅ **CONFIRMED** — [create-booking/index.ts](supabase/functions/create-booking/index.ts) implements a 16-step validated flow (auth → role → Zod validation → idempotency → doctor availability → token generation → payment order → audit → WhatsApp enqueue)                                           |
| Booking fee paid online      | Razorpay collection of booking fee only  | ✅ **CONFIRMED** — [create-payment-order/index.ts](supabase/functions/create-payment-order/index.ts) + [verify-payment/index.ts](supabase/functions/verify-payment/index.ts); fee amounts come from `booking_fee_policies` per source ([migration 28](supabase/migrations/28_booking_enhancements.sql)) |
| Automatic token generation   | Numbered tokens per doctor/day           | ✅ **CONFIRMED** — `generate_next_token()` in [migration 02](supabase/migrations/02_atomic_token_engine_&_bookings.sql) uses `hospital_daily_counters` with `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` — race-safe under concurrency                                                              |
| Live queue management        | Real-time token tracking, "Next Patient" | ✅ **CONFIRMED** — [queue-next-patient/index.ts](supabase/functions/queue-next-patient/index.ts) → `advance_queue()` RPC using `FOR UPDATE SKIP LOCKED`; broadcasts via `_shared/realtime.ts`                                                                                                           |
| WhatsApp updates & reminders | Automatic patient messaging              | ✅ **CONFIRMED (with caveat)** — see section 2.4; sends work end-to-end, post-send DB bookkeeping is placeholder code                                                                                                                                                                                   |
| Doctor consultation          | Consultation lifecycle                   | ✅ **CONFIRMED** — [update-booking-status/index.ts](supabase/functions/update-booking-status/index.ts) implements the full state machine with optimistic locking; `consultation_started` / `consultation_completed` templates exist                                                                     |
| Analytics & reporting        | Dashboards and reports                   | ✅ **CONFIRMED (backend only)** — 5 materialized views ([migration 08](supabase/migrations/08_analytics_engine.sql)), weekly/monthly/quarterly rollups + cohort retention ([migration 21](supabase/migrations/21_analytics_rollups.sql))                                                                |

### 2.2 Feature Claims

#### 📅 Smart Appointment Booking — ✅ CONFIRMED

| Sub-claim                      | Evidence                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Online appointment booking     | `create-booking` edge function, per-source fees (`online`, `manual_whatsapp`, `walkin`)                                                                                                                                                                                                                                                                                                                                |
| Automatic token allocation     | `generate_next_token()` atomic counter RPC; `handle_booking_status_change()` trigger emits `booking_events`                                                                                                                                                                                                                                                                                                            |
| Doctor availability management | [migration 03](supabase/migrations/03_doctorscheduling&slotengine.sql): `doctor_schedules` with **GiST exclusion constraint** (DB-level double-booking prevention), `doctor_schedule_blocks`, `doctor_leaves`, `is_doctor_available()`; enhanced in [migration 31](supabase/migrations/31_doctor_leave_management.sql) with typed leaves, approval workflow, per-doctor holidays, and `get_doctor_unavailable_dates()` |
| Rescheduling                   | [reschedule-booking/index.ts](supabase/functions/reschedule-booking/index.ts) (722 lines) — marks original `rescheduled`, creates new booking, preserves payment linkage                                                                                                                                                                                                                                               |
| Cancellation                   | [cancel-booking/index.ts](supabase/functions/cancel-booking/index.ts) + tiered refund engine `calculate_refund_amount()` ([migration 29](supabase/migrations/29_cancellation_policy.sql)) with full/partial/same-day tiers and policy version history                                                                                                                                                                  |

**Verdict on quality:** Stronger than described. The GiST exclusion constraint
means double-bookings are impossible _at the database level_, not just in
application code — most commercial systems don't do this.

#### 🏥 Live Queue Management — ✅ CONFIRMED

| Sub-claim                         | Evidence                                                                                                                                                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real-time token tracking          | `booking_events` trigger + Supabase Realtime broadcast helpers in [_shared/realtime.ts](supabase/functions/_shared/realtime.ts) (`broadcastQueueAdvance()`)                                                                |
| Receptionist queue controls       | `receptionist` role has `VIEW_QUEUE`, `CREATE_BOOKING`, `CANCEL_BOOKING` permissions ([migration 27](supabase/migrations/27_role_permissions.sql))                                                                         |
| "Next Patient" system             | `advance_queue()` uses `SELECT ... FOR UPDATE SKIP LOCKED` — verified at migration 02:603. Two receptionists clicking "next" simultaneously cannot call the same patient                                                   |
| Carry-forward of pending patients | [carry-forward-tokens/index.ts](supabase/functions/carry-forward-tokens/index.ts) with `carry_forward_pending_tokens` RPC, 7-day max gap validation, automatic `carry_forward_notice` WhatsApp enqueue per carried booking |

#### 💬 WhatsApp Automation — ✅ MOSTLY CONFIRMED (one material gap)

| Template claimed           | In `ALLOWED_TEMPLATES`?                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| Booking confirmations      | ✅ `booking_confirmation`                                                                                |
| Appointment reminders      | ✅ `appointment_reminder` (+ [send-reminders/index.ts](supabase/functions/send-reminders/index.ts) cron) |
| Patient called             | ✅ `patient_called` and `please_come_now`                                                                |
| Queue status updates       | ✅ `patient_called`, plus `consultation_started`                                                         |
| Cancellation alerts        | ✅ `booking_cancelled`                                                                                   |
| Reschedule alerts          | ✅ `booking_rescheduled`, `carry_forward_notice`                                                         |
| (bonus) Feedback/lifecycle | ✅ `feedback_request`, `consultation_completed`                                                          |

**Infrastructure confirmed:**

- HMAC-SHA256 webhook verification with constant-time comparison
  ([process-whatsapp-webhook/index.ts:59-80](supabase/functions/process-whatsapp-webhook/index.ts))
  — verified
- Webhook event deduplication with SHA-256 payload hashing
  ([migration 16](supabase/migrations/16_idempotency_hardening.sql))
- Delivery/read receipt processing; incoming messages enqueue a
  `process_incoming_whatsapp` job
- Worker-only sending enforced by `X-Worker-Secret` with constant-time
  comparison
- Meta rate-limit (429) and permanent-error (131047, 131051, 131052,
  131053, 131056) classification

**THE GAP:**
[send-whatsapp-message/index.ts:571-577](supabase/functions/send-whatsapp-message/index.ts#L571)
contains literal placeholder comments:

```
// ... continue with your existing
// whatsapp_messages updates,
// retry scheduling,
// permanent fail updates,
// booking flag updates,
```

Messages reach Meta, but the database is not updated afterward: the
`whatsapp_messages` row never moves to `sent`,
`bookings.whatsapp_confirmation_sent` is not set by this function, and permanent
failure never marks the message failed. **This must be fixed before pilot.**

#### 💳 Payment Management — ✅ CONFIRMED

| Sub-claim             | Evidence                                                                                                                                                                                                                                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Online fee collection | Razorpay order creation, INR/paise conversion, idempotency keys on order creation                                                                                                                                                                                                                                                             |
| Payment verification  | **Dual path** in [verify-payment/index.ts](supabase/functions/verify-payment/index.ts): (a) webhook path verifying `X-Razorpay-Signature` HMAC-SHA256 against raw body; (b) frontend path verifying `HMAC(order_id                                                                                                                            |
| Refund processing     | [process-refund/index.ts](supabase/functions/process-refund/index.ts) — Razorpay refund API, idempotent on existing refunds                                                                                                                                                                                                                   |
| Audit trail           | `financial_ledger` ([migration 13](supabase/migrations/13_payment_engine.sql)) with **BEFORE UPDATE/DELETE triggers raising exceptions** — the ledger is physically immutable; extended in [migration 34](supabase/migrations/34_payment_ledger_cleanup.sql) with `gateway_fee_debit` and `gst_debit` entries for true net-revenue accounting |

#### 👨‍⚕️ Doctor & Reception Workflow — ✅ CONFIRMED

| Sub-claim                 | Evidence                                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Doctor-specific schedules | `doctor_schedules` per (doctor, hospital, weekday)                                                                                        |
| Patient status tracking   | Full booking state machine + `booking_events` append-only event log                                                                       |
| Consultation lifecycle    | `update-booking-status` with valid-transition enforcement and optimistic locking                                                          |
| Multi-role access control | 4 roles (global_admin > hospital_admin > doctor > receptionist), 17-permission matrix, `has_permission()` for both RLS and Edge Functions |

**Accuracy note:** migration 27 documents that the doctor permission set was
_corrected_ to match actual RLS (doctors cannot create bookings — the migration
02 `bookings_insert` policy never included them). Product copy says "multi-role
access control" without making finer claims, so this is fully consistent.

#### 📊 Analytics & Monitoring — ✅ CONFIRMED (backend)

| Sub-claim                 | Evidence                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daily operational reports | `mv_daily_stats` + daily rollups                                                                                                                                                            |
| Queue performance metrics | [migration 17](supabase/migrations/17_queue_monitoring_engine.sql): `queue_metrics_snapshots`, `get_queue_health()`, `get_stuck_jobs()`, backlog alerts                                     |
| SLA tracking              | `sla_daily_tracking` + `compute_health_score()` ([migration 24](supabase/migrations/24_operational-monitoring_engine.sql)); [compute-sla/index.ts](supabase/functions/compute-sla/index.ts) |
| Hospital dashboards       | Backend data complete; **no UI exists** — see 3.2                                                                                                                                           |
| Health monitoring         | [monitoring-health-check/index.ts](supabase/functions/monitoring-health-check/index.ts): public GET uptime probe + global-admin POST deep check; `fire_alert()` + `alert_thresholds`        |

### 2.3 Multi-Tenant SaaS — ✅ CONFIRMED

- `hospital_id` on every tenant table; RLS **enabled AND forced** on all of them
  (176 ENABLE/FORCE statements verified across 32 migration files)
- `X-Hospital-ID` header validated against resolved auth context in Edge
  Functions; cross-hospital access rejected (e.g.,
  [refresh-rollups](supabase/functions/refresh-rollups/index.ts)
  hospital-isolation check)
- `hospital_id` immutability trigger `prevent_hospital_id_update` stops tenant
  reassignment
- `global_admin` is the only cross-tenant role, enforced at the DB layer
- Example seed tenants: 5 hospitals in Narsapur
  ([migration 01:528-540](supabase/migrations/01_foundation.sql#L528))
- Per-tenant config: `hospital_settings`, `booking_fee_policies`,
  `cancellation_policies`, `feature_flags` overrides, `queue_configs`

### 2.4 Security & Reliability — ✅ CONFIRMED (spot-verified)

| Claim                         | Verification                                                                                                                                                                                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Role-based access control     | `user_roles` + `role_permissions` + `has_permission()`; RLS policies reference role helpers                                                                                                                                                                                               |
| Row Level Security            | 176 ENABLE/FORCE occurrences; every new table gets RLS ✅                                                                                                                                                                                                                                 |
| Audit logging                 | Immutable `audit_logs` (modification trigger raises exception); 40+ standardized action types with severities ([migration 36](supabase/migrations/36_audit_standardization.sql)); coverage report function                                                                                |
| Idempotent payment processing | Three layers: API-level `api_idempotency_keys` with request-hash mismatch detection ([migration 25](supabase/migrations/25_api_idempotency_registry.sql)), per-booking idempotency, webhook event dedup ([migration 16](supabase/migrations/16_idempotency_hardening.sql)) — all verified |
| Background job processing     | `job_queue` + `claim_jobs_v2` (`FOR UPDATE SKIP LOCKED`, lease tracking, exponential backoff `POWER(2, retry_count)`, dead-letter on max attempts) ✅                                                                                                                                     |
| Automated monitoring          | Minute cron runs master scheduler + health snapshot; nightly cron runs carry-forward, MV refresh, rollups, SLA, retention, partitions ✅                                                                                                                                                  |
| Crash recovery                | `worker_registry` + heartbeat (25% sampled) + `detect_crashed_workers()` + lease reclaim — verified in [migration 19](supabase/migrations/19_background_worker_engine.sql)                                                                                                                |

### 2.5 Business Model — ✅ CONFIRMED (remarkably well-enforced)

The "SETURA collects booking fee only; hospital keeps consultation fee" model
isn't just marketing — the schema was **refactored to enforce it**:

- [Migration 33](supabase/migrations/33_settlement_engine_refactor.sql) header
  states the old settlement model was semantically wrong ("There is no hospital
  paying SETURA flow") and replaces it with `create_platform_revenue_summary()`;
  legacy settlement functions are deprecated with runtime NOTICEs
- [Migration 28](supabase/migrations/28_booking_enhancements.sql) column
  comments: `consultation_fee_inr` marked "INFORMATIONAL ONLY. SETURA never
  collects or processes this amount"
- [Migration 34](supabase/migrations/34_payment_ledger_cleanup.sql) deprecates
  `hospital_fee_credit` ledger type for the same reason
- GST support on the booking fee (Indian compliance) with per-hospital
  `gst_enabled`/`gst_percentage`

---

## 3. Where the Description Overstates Reality

### 3.1 "~95% Backend Complete" → ~85%

| Gap                                           | Severity | Detail                                                                                                                                          |
| --------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `send-whatsapp-message` post-send bookkeeping | 🔴 P0    | Placeholder comments at lines 571–577; message status, retries, booking flags unimplemented                                                     |
| Refund → booking status sync                  | 🟡 P1    | `process-refund` never sets `bookings.payment_status_detail = 'refund_processed'`                                                               |
| Subscription usage counters                   | 🟡 P1    | `current_month_bookings`, `current_doctor_count`, `current_receptionist_count` columns exist; nothing updates them → plan limits are unenforced |
| Retention cleanup not in nightly cron         | 🟡 P1    | `run_retention_cleanup()` exists ([migration 23](supabase/migrations/23_retention_&_cleanup_engine.sql)) but `run-cron-nightly` doesn't call it |
| `process_incoming_whatsapp` job consumer      | 🟡 P2    | Incoming WA messages are enqueued (webhook lines 618–637) but no handler interprets them into actions                                           |
| Razorpay subscription billing                 | 🟡 P2    | Schema holds `razorpay_subscription_id`; no Edge Function drives subscription invoicing                                                         |

### 3.2 "Hospital Dashboards" → no UI exists

The repository contains zero frontend code. Everything required to _power_
dashboards exists (MVs, rollups, SLA, monitoring views, realtime broadcasts),
but nothing renders them.

### 3.3 "WhatsApp-first" → "WhatsApp-notified"

Booking creation happens via `create-booking` API, not via WhatsApp
conversation. WhatsApp is a notification/alert channel (10 outbound templates)
plus a captive incoming-message queue with no consumer. The "WhatsApp-first
Hospital OS" framing is a roadmap truth, not a current-state truth.

### 3.4 "Production-grade"

Architecturally: yes (idempotency, RLS, immutability, crash recovery,
constant-time secret comparison — all verified). Operationally: not yet — no
tests, no CI/CD, no API docs, no runbooks.

---

## 4. Nothing Contradicted

The following appeared in neither description nor code, consistently (no false
promises): EHR/clinical notes, pharmacy, lab integrations, telemedicine (flag
seeded `FALSE` in [migration 37](supabase/migrations/37_feature_flags.sql)), AI
insights (flag `FALSE`), insurance claims, international phone support (Indian
`+91`/10-digit normalization assumed throughout).

---

## 5. Undersold Capabilities (code > marketing)

| Capability                                                                                                            | Why it matters                                                      |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| GiST exclusion constraint on doctor schedules                                                                         | Double-booking prevention enforced by the _database_, not app logic |
| Idempotent webhook claims with SKIP LOCKED                                                                            | Razorpay/Meta retries can never double-capture a payment            |
| Immutable financial ledger + audit logs (trigger-enforced)                                                            | Regulatory/defensible audit posture — rare in early-stage systems   |
| Config versioning with rollback ([migration 18](supabase/migrations/18_config_versioning_&_rollback.sql))             | One-call `rollback_system_setting()` / `rollback_feature_flag()`    |
| Worker crash recovery with lease reclaim                                                                              | PgBouncer-free, Supabase-native job system with real durability     |
| Cancellation policy versioning                                                                                        | Refund rules change over time without rewriting history             |
| Legal-basis annotations on retention policies ([migration 23](supabase/migrations/23_retention_&_cleanup_engine.sql)) | MCI 10-year / IT 7-year compliance awareness                        |

---

## 6. Recommended Corrections to the Product Sheet

1. Change "**Backend Architecture ~95% Complete**" → "**~85%**" and add "1 known
   P0 gap (WhatsApp post-send bookkeeping)" — or fix the gap (est. 1–2 days) and
   keep 95%.
2. Change "**WhatsApp-first**" positioning language to "WhatsApp-automated"
   until the incoming-message consumer exists.
3. Change "**Hospital dashboards**" → "**Analytics & dashboard APIs**" until the
   frontend ships.
4. Keep "Next Major Phase: Frontend + End-to-End Testing + Pilot Hospital
   Deployment" — it is exactly right, with one amendment: **fix the P0 WhatsApp
   gap and wire the retention cron _before_ pilot, not after.**

---

_Cross-verification complete. Method: full read of all 74 source files followed
by targeted grep verification of 8 high-risk security/integration claims — all
confirmed. No code was modified during this audit._
