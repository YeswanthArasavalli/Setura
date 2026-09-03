---
kind: business_term
name: Business Glossary
category: business_term
scope:
  - "**"
---

### SETURA

- Definition：The project codename for the v1.0 Enterprise Execution Plan — a
  multi-tenant hospital management system built on Supabase with a queue engine,
  atomic token booking, payment/settlement engines, background workers,
  analytics rollups, audit logging, RLS security, and WhatsApp messaging
  infrastructure.
- Aliases：setura、SETURA v1.0

### Phase 0

- Definition：The Foundation phase of SETURA v1.0: stand up the local Supabase
  stack, verify all migrations apply cleanly, regenerate TypeScript database
  types, create the test harness, produce deterministic idempotent seed data,
  and set up the CI skeleton. It is a prerequisite gate before any feature work
  begins.
- Aliases：foundation phase

### Phase 0.5

- Definition：Architecture and code freeze checkpoint immediately after Phase 0.
  All database schema, generated types, API contracts, coding standards, logging
  format, audit format, RLS pattern, and error format are locked; no new code
  may enter without explicit amendment.
- Aliases：architecture freeze

### Edge Function

- Definition：A serverless Deno function deployed under
  `supabase/functions/<name>/index.ts` and executed by the Supabase Edge
  Runtime. Each function implements one RPC or webhook handler (e.g.,
  `create-booking`, `send-whatsapp-message`, `process-refund`,
  `run-cron-nightly`).
- Aliases：function、edge func

### migration

- Definition：An ordered SQL file under `supabase/migrations/NN_<name>.sql` that
  mutates the Postgres schema. Migrations are applied sequentially by
  `supabase start` / `supabase db reset`; the current set contains 39 files
  covering foundation, bookings, scheduling, WhatsApp, queues, settlement,
  analytics, rate limiting, audit, presence, hospital configuration, payments,
  dead-letter queue, partitioning, idempotency, monitoring, role permissions,
  and more.
- Aliases：schema migration、SQL migration

### seed

- Definition：Deterministic, idempotent bootstrap data loaded after migrations
  via `supabase/db reset`. The current seed creates one hospital, four
  users/roles (doctor, receptionist, hospital admin, global admin), hospital
  settings, working hours, fee policy, queue configuration, and feature flags —
  using fixed UUIDs and `ON CONFLICT` guards so repeated runs are safe.
- Aliases：seed data、seed.sql

### RLS

- Definition：Row-Level Security policies enforced at the Postgres level, scoped
  per tenant via `hospital_id` claims and checked against `current_user_role()`.
  The codebase ships 176 policies and treats this pattern as frozen for all
  subsequent phases.
- Aliases：row-level security、RLS policy

### audit_action_types

- Definition：A registry table that constrains audit log entries to pre-approved
  action categories (e.g., `payment`, `booking`, etc.). New audit actions must
  be registered here rather than free-typed; the audit format is frozen and
  requires structured JSON with correlation_id, hospital_id, and actor_id.
- Aliases：audit registry、action types

### DLQ

- Definition：Dead Letter Queue — a fallback store for jobs/messages that have
  exhausted retries or hit permanent failures (e.g., WhatsApp permanent fail
  codes). Used by the WhatsApp messaging engine and background worker pipeline
  to surface irrecoverable errors for inspection.
- Aliases：dead letter queue

### SeturaError

- Definition：The project's structured error hierarchy used throughout Edge
  Functions instead of raw `throw new Error()`. Errors carry typed status codes
  and are wrapped by a central response envelope; the format is part of the
  frozen API contract.
- Aliases：error hierarchy
