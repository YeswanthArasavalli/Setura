# SETURA — Architecture

**Status:** Frozen as of Phase 1.4; extended additively by the Phase 1.5
enterprise intelligence layer. **Scope:** Hospital queue management, booking,
payments, settlements, WhatsApp operations, analytics, and executive command
center on a multi-tenant Supabase backend.

---

## 1. System overview

SETURA is a multi-tenant hospital operations platform. All business logic lives
in PostgreSQL (SECURITY DEFINER RPCs, triggers, constraints); Deno edge
functions provide authorized HTTP APIs, orchestration, and notification
side-effects. There is no application-side state: every number a client sees is
derived from the database.

```
                 ┌──────────────────────────────────────────┐
WhatsApp         │              Supabase                    │
Business API ◄───┤  Postgres: engines, RPCs, audit, RLS     │
     ▲           │  Realtime: queue/presence channels       │
     │           │  Storage / Auth: users, JWTs             │
webhook ─────────┤                                          │
                 └───────▲────────────────▲─────────────────┘
                         │ RPC / queries  │ enqueue_job
           ┌─────────────┴───┐    ┌───────┴────────────┐
           │ Edge functions  │    │ Background worker   │
           │ (Deno, HTTP)    │    │ (run-background-    │
           │                 │    │  worker + crons)     │
           └─────────────────┘    └────────────────────┘
```

Principles:

- **SQL-first aggregation.** Dashboards, reports, and integrity checks are RPCs;
  edge functions never recompute business numbers.
- **Idempotency everywhere.** Mutating endpoints claim an idempotency key;
  background jobs and WhatsApp enqueues carry deterministic keys.
- **Immutable evidence.** `audit_logs` and `financial_ledger` are protected by
  triggers; updates and deletes are rejected at the database level.
- **Best-effort side-effects.** Notification failures never fail the operation
  that caused them.

---

## 2. Technology stack

| Layer        | Technology                                       |
| ------------ | ------------------------------------------------ |
| Database     | PostgreSQL 15 (Supabase local stack)             |
| Edge runtime | Deno (Supabase Edge Functions)                   |
| Validation   | zod v3.22.4                                      |
| Realtime     | Supabase Realtime (queue advance, presence)      |
| Jobs         | `background_jobs` table + claiming worker        |
| Scheduling   | `run-cron-minute` / `run-cron-nightly` crons     |
| Messaging    | WhatsApp Cloud API via `send-whatsapp-message`   |
| Tests        | Deno std asserts, integration suite on the stack |

---

## 3. Multi-tenant security model

- Every tenant is a `hospitals` row; all operational tables carry `hospital_id`
  with FK + index.
- **Row Level Security** scopes direct table access for `anon`/`authenticated`
  roles; privileged flows use the service-role client inside edge functions.
- **`resolveAuth(req, hospitalId)`** validates the JWT, resolves the user's role
  for the hospital (`user_roles`), and enforces hospital membership. Global
  admins bypass hospital membership checks.
- **`requireRole(auth, roles)`** enforces action-level authorization.
- Cross-hospital aggregation RPCs (portfolio, benchmarks, platform SLA) are
  exposed only through global-admin-gated endpoints.
- Roles: `global_admin`, `hospital_admin`, `doctor`, `receptionist` (+ platform
  service roles for workers).

---

## 4. Core engines (frozen)

### 4.1 Booking engine

`create-booking`, `reschedule-booking`, `cancel-booking`,
`update-booking-status`, `carry-forward-tokens`. Bookings follow a strict state
machine (`_shared/booking_state.ts`):

```
booked → checked_in → waiting → called → in_consultation → completed
   │           │          │        │
   └───────────┴──────────┴────────┴──→ cancelled / no_show / skipped
```

Invalid transitions are rejected both at the edge and by SQL guards. Bookings
are deduplicated by patient phone per hospital; tokens are allocated atomically
per queue session.

### 4.2 Queue runtime

`queue_sessions` per doctor-day; `_shared/queue/queue_runtime.ts` is the single
orchestration module used by `queue-next-patient` and `doctor-operations`.
Operations (open/close session, pause/resume, call, recall, skip, restore,
emergency insert, complete consultation) run through SECURITY DEFINER RPCs that
enforce one-active-consultation-per-doctor, token uniqueness, and event emission
into `queue_runtime_events`. Queue advance broadcasts position updates to
waiting patients over WhatsApp and pushes Realtime events for queue displays.

### 4.3 Payment & settlement engines

- `create-payment-order` / `verify-payment` integrate the PSP; payments are
  recorded in `payments` and mirrored into the **append-only
  `financial_ledger`** (double-entry style, immutable).
- `daily_collection_entries` materialize per-booking collection facts (total,
  platform fee, hospital fee, receptionist fee) used by every financial
  dashboard.
- `settlement-engine` computes `hospital_settlements` + `settlement_items` from
  platform fees; `outstanding_balances` tracks what the platform owes/is owed.
  `process-refund` writes `payment_refunds` and ledger reversal entries.

### 4.4 WhatsApp engine

Inbound webhook (`process-whatsapp-webhook`) drives an intent router and
conversation flows (`whatsapp_conversation_engine.ts`, queue lookup, cancel
flow). Outbound messaging is always queued: producers call `enqueue_job` with
`send_whatsapp_message` payloads and deterministic idempotency keys; the worker
executes `send-whatsapp-message`. Proactive patient broadcasts are gated by the
`whatsapp_queue_updates` feature flag.

### 4.5 SLA engine

`compute_sla_tracking` evaluates hospital SLA thresholds (wait time, completion
rate) per day into `sla_daily_tracking`; breaches raise alerts. Refreshes are
triggered by queue operations and cron.

### 4.6 Monitoring & alerts

`alert_events` collects fired alerts (deduplicated per hospital/key/severity
while unresolved). `monitoring-health-check` runs `run_health_check`, queue
health, MV freshness, DLQ, and partition readiness checks. `alert_activity_log`
and `alert_suppressions` (Phase 1.5) add the alert lifecycle and maintenance
windows.

### 4.7 Audit engine

`audit_logs` is append-only (trigger-enforced). Every mutating endpoint writes
an audit event via `logAuditEvent` with actor, hospital, entity, registered
action type (`audit_action_types`), severity, old/new data. Metadata carries the
correlation id for end-to-end tracing.

### 4.8 Background worker

`background_jobs` with SKIP LOCKED claiming (`run-background-worker`),
dead-letter queue, retries with backoff, and worker registry heartbeats. Cron
entry points (`run-cron-minute`, `run-cron-nightly`) schedule reminders,
rollups, SLA refresh, settlements, carry-forward, retention, and partition
automation.

### 4.9 Analytics pipeline

Raw events (booking, queue, payment) feed `analytics_daily_rollups` /
`analytics_weekly_rollups` / `analytics_monthly_rollups` via
`run_analytics_rollups`, refreshed by `refresh-rollups` under the worker.
Materialized views are refreshed in dependency order. **There is exactly one
analytics pipeline**; Phase 1.5 dashboards read the same rollups.

### 4.10 Operational hardening

Rate limiting (per-phone and per-IP), abuse protection, partitioning of hot
tables with automated partition creation, retention/cleanup engine, config
versioning & rollback, device sessions, doctor leave management, subscriptions
and feature flags.

---

## 5. Enterprise intelligence layer (Phase 1.5, additive)

Built strictly on top of the frozen engines via migration
`47_enterprise_command_center.sql`:

- **Command center RPCs** — `get_hospital_command_center`,
  `get_hospital_timeline`, `get_operational_scores`, `get_predictive_insights`
  aggregate live queue/payment/SLA state.
- **Executive dashboards** — daily/weekly/monthly RPCs read the existing rollups
  and event tables; doctor performance and rankings derive from bookings and
  queue events.
- **Financial command center** — `get_financial_command_center`,
  `get_revenue_forecast` (deterministic proration), reusing
  `get_reconciliation_summary`.
- **Alert center** — acknowledgement, assignment, resolution, escalation,
  suppression windows, analytics; delivery orchestration reuses the WhatsApp
  enqueue pipeline (`_shared/enterprise/broadcasts.ts`).
- **Portfolio** — `get_portfolio_dashboard`, `get_cross_hospital_benchmarks`
  (global admin only).
- **Reporting engine** — `generate_executive_report` dispatches 8 report types;
  edge renders json/csv/pdf_ready (`_shared/reporting.ts`).
- **Governance** — `search_audit_logs`, integrity verifiers (audit, settlement,
  queue, doctor operations, integration matrix).

Edge endpoints: `command-center`, `executive-analytics`,
`financial-command-center`, `alert-center`, `enterprise-reports`. All use
`resolveAuth` + `requireRole` + zod validation + tracing + metrics + audit.

Phone numbers are normalized to E.164 with hospital-specific country codes
(`_shared/phone.ts`): hospital override → platform default
(`system_settings.default_country_code`) → env → `91` fallback.

---

## 6. Edge function catalog

| Function                     | Responsibility                                                              |
| ---------------------------- | --------------------------------------------------------------------------- |
| create-booking               | Booking creation, patient dedupe, token allocation                          |
| reschedule-booking           | Move booking across dates/doctors                                           |
| cancel-booking               | Cancellation policy + refunds                                               |
| update-booking-status        | Status machine transitions                                                  |
| queue-next-patient           | Reception queue advancement                                                 |
| doctor-operations            | Doctor workflow actions (15 actions)                                        |
| create-payment-order         | PSP order creation                                                          |
| verify-payment               | PSP webhook/verification                                                    |
| process-refund               | Refund execution                                                            |
| settlement-engine            | Settlement computation/payout states                                        |
| process-whatsapp-webhook     | Inbound WhatsApp handling                                                   |
| send-whatsapp-message        | Outbound delivery (worker-invoked)                                          |
| send-reminders               | Appointment reminder enqueueing                                             |
| carry-forward-tokens         | End-of-day token carry-forward                                              |
| run-background-worker        | Job claiming worker                                                         |
| run-cron-minute / nightly    | Scheduled orchestrators                                                     |
| refresh-rollups              | Analytics rollup + MV refresh                                               |
| compute-sla                  | SLA evaluation                                                              |
| monitoring-health-check      | Platform health check                                                       |
| **command-center**           | Live overview, timeline, scores, predictive, SLA, system health, broadcasts |
| **executive-analytics**      | Daily/weekly/monthly dashboards, doctor analytics, portfolio, benchmarks    |
| **financial-command-center** | Collections, settlement intelligence, forecast, reconciliation              |
| **alert-center**             | Alert lifecycle management                                                  |
| **enterprise-reports**       | Reports (json/csv/pdf_ready) + compliance checks                            |

---

## 7. Cross-cutting conventions

Every endpoint follows the same pipeline (`_shared/`):

1. `handleCors` → preflight/response CORS headers.
2. Method guard (POST).
3. `createTraceContext` → correlation id; `createRequestLogger` child logger.
4. `createMetrics` → counters + timings, flushed to logs.
5. `X-Hospital-ID` header required; `resolveAuth` + `requireRole`.
6. `parseBody` with a zod schema.
7. Service client (`getServiceClient`) → RPCs/queries.
8. `logAuditEvent` for every mutation.
9. `successResponse` / `handleErrorResponse` envelope (`success`, `data`,
   `correlationId`, `timestamp`).

See `docs/API_CONTRACTS.md` for request/response contracts and
`docs/ERROR_CONTRACT.md` for the error taxonomy.

---

## 8. Data integrity guarantees

- **Immutability:** `audit_logs`, `financial_ledger` reject UPDATE/DELETE.
- **Idempotency:** `idempotency_keys` registry + job-level keys; retries
  converge instead of duplicating.
- **Isolation:** every query path is hospital-scoped; cross-hospital reads are
  gated to global admins.
- **Reconciliation:** settlements reconcile against settlement items and
  collection entries (verified by `verify_settlement_integrity`).
- **Retention:** partitioned tables with automated creation and cleanup;
  retention status is queryable via compliance APIs.
