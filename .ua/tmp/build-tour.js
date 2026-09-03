const fs = require("fs");

const tour = [
  {
    order: 1,
    title: "Project Overview & Operating Contract",
    description: "Begin with ARCHITECTURE.md to learn SETURA's SQL-first design: all business logic lives in PostgreSQL (SECURITY DEFINER RPCs, triggers, constraints), while Deno edge functions are a thin HTTP orchestration layer. CLAUDE.md is the operating contract for anyone working in the repo: it defines the non-negotiables (security, multi-tenancy, financial correctness, auditability), the established architecture primitives, and the truth hierarchy. Read these two together to understand both what SETURA is and how to work in it.",
    nodeIds: ["document:ARCHITECTURE.md", "document:CLAUDE.md"]
  },
  {
    order: 2,
    title: "Database Foundation Migration",
    description: "Every SETURA feature builds on migration 01_foundation.sql, which runs first. It enables pgcrypto/uuid-ossp/pg_trgm/citext, defines the core enums (user_role_type, booking_status, booking_source), installs the set_updated_at() trigger helper, and — most importantly — the prevent_hospital_id_update() guard. This guard enforces multi-tenancy at the database level: hospital_id columns become effectively immutable. Understanding this file is a prerequisite for every later migration.",
    nodeIds: ["file:supabase/migrations/01_foundation.sql"]
  },
  {
    order: 3,
    title: "Atomic Token & Booking Engine",
    description: "The booking engine (migration 02) introduces bookings, booking_events, queue_sessions, and hospital_daily_counters. The architectural centerpiece is atomic token allocation via INSERT ... ON CONFLICT DO UPDATE RETURNING — the only safe way to allocate per-doctor daily tokens under concurrent load. Patient deduplication by (hospital_id, normalized_phone) is also enforced here. This migration is what makes 'booked → checked_in → waiting → called → in_consultation → completed' a state machine, not just a status string.",
    nodeIds: ["file:supabase/migrations/02_atomic_token_engine_&_bookings.sql"]
  },
  {
    order: 4,
    title: "Authentication, Authorization & Tenancy",
    description: "Every edge function in SETURA starts with auth.ts. resolveAuth() verifies the JWT via Supabase Auth, loads the profile, queries user_roles for hospital membership, and applies the role hierarchy (global_admin > hospital_admin > doctor > receptionist). requireRole() is the action-level guard, and requireHospitalAccess() enforces tenant isolation. Paired with errors.ts (18 SeturError subclasses), this pair is the security boundary — no edge function may bypass it, and no database RPC should be exposed without an equivalent check.",
    nodeIds: [
      "file:supabase/functions/_shared/auth.ts",
      "file:supabase/functions/_shared/errors.ts"
    ],
    languageLesson: "ROLE_HIERARCHY is encoded as a numeric precedence in TypeScript so the highest-privilege role always wins across multiple user_roles rows. The withAuth wrapper composes resolveAuth + error handling so each handler is a single concern."
  },
  {
    order: 5,
    title: "API & Error Contracts",
    description: "Every endpoint returns the same JSON envelope defined in response.ts: { success, data, correlationId, timestamp }. handleErrorResponse is the outermost catch-block handler, turning any SeturError into a typed HTTP response with CORS headers. docs/API_CONTRACTS.md formalizes the request/response shape, the Idempotency-Key header convention, and the X-Hospital-ID header requirement. docs/ERROR_CONTRACT.md enumerates the error taxonomy — auth, booking, queue, idempotency, rate limit, infrastructure. Read these together to know what every endpoint must look like on the wire.",
    nodeIds: [
      "file:supabase/functions/_shared/response.ts",
      "document:docs/API_CONTRACTS.md",
      "document:docs/ERROR_CONTRACT.md"
    ]
  },
  {
    order: 6,
    title: "Idempotency, Audit & Privilege Hardening",
    description: "Three non-negotiable safety layers. idempotency.ts implements the withIdempotency wrapper around the api_idempotency_keys table so a retried POST returns the original response instead of double-mutating. audit.ts exposes logAuditEvent which writes to the trigger-enforced append-only audit_logs — UPDATE and DELETE are rejected at the database level. Migration 48_privilege_hardening.sql documents the F16-04 caveat: a new or resignatured SECURITY DEFINER function does not automatically lose its PUBLIC grant, so each one needs its own explicit REVOKE.",
    nodeIds: [
      "file:supabase/functions/_shared/idempotency.ts",
      "file:supabase/functions/_shared/audit.ts",
      "file:supabase/migrations/48_privilege_hardening.sql"
    ],
    languageLesson: "Idempotency in SETURA is two-layered: the api_idempotency_keys registry stores response payloads for HTTP replay, while the bookings/payments tables carry unique-constraint idempotency keys as a backstop. Both must be in place to handle retries, double-clicks, and webhook redeliveries safely."
  },
  {
    order: 7,
    title: "Edge Runtime: Booking Creation",
    description: "create-booking/index.ts is the canonical example of the full SETURA edge pipeline (documented in the file header as 16 numbered steps). It runs: CORS preflight, idempotency claim, JWT+role+hospital validation, zod body parsing, rate limit (phone+IP), hospital open/holiday rules, doctor availability, queue capacity, phone blocklist, find-or-create patient, atomic token allocation, WhatsApp confirmation enqueue, notification enqueue, audit log, idempotency completion, typed response. Every other mutating edge function in the repo is a variation of this pattern — study it once, reuse it everywhere.",
    nodeIds: ["file:supabase/functions/create-booking/index.ts"]
  },
  {
    order: 8,
    title: "Edge Runtime: Live Queue Control",
    description: "queue-control/index.ts is the live-queue API for receptionists and doctors. Its ten actions — pause, resume, recall, skip, restore, mark_absent, call, delay, clear_delay, snapshot — all run through SECURITY DEFINER RPCs that enforce one-active-consultation-per-doctor and append to queue_runtime_events (migration 43). Every action is idempotent via deterministic keys, so a double-tap or network retry is safe. This is also the read path for queue displays and the write path for analytics rollups.",
    nodeIds: [
      "file:supabase/functions/queue-control/index.ts",
      "file:supabase/migrations/43_queue_runtime.sql"
    ]
  },
  {
    order: 9,
    title: "Edge Runtime: Payment & Settlement Engines",
    description: "Money flows are split across two engines. create-payment-order/index.ts integrates Razorpay: it creates a payment_orders row, calls Razorpay's Orders API, and returns the short_id the patient pays against (migration 13_payment_engine.sql). settlement-engine/index.ts is the financial close: it computes hospital_settlements + settlement_items from platform fees and exposes snapshot endpoints for finance dashboards (migration 07_settlement_engine.sql). Together they bridge an external PSP and the append-only financial_ledger, which the daily_collection_entries table materializes for every dashboard and report.",
    nodeIds: [
      "file:supabase/functions/create-payment-order/index.ts",
      "file:supabase/functions/settlement-engine/index.ts",
      "file:supabase/migrations/13_payment_engine.sql",
      "file:supabase/migrations/07_settlement_engine.sql"
    ]
  },
  {
    order: 10,
    title: "WhatsApp Conversation Engine",
    description: "WhatsApp is a first-class patient channel. Inbound flow: process-whatsapp-webhook verifies the Meta HMAC signature, deduplicates via webhook_events, and hands the message to whatsapp_conversation_engine.ts, which loads/updates whatsapp_conversation_states (migration 42) and routes through the deterministic intent router — no LLM, only keyword matching with explicit handoff on ambiguity. Each intent dispatches to a flow module (book/cancel/reschedule/queue/handoff), which delegates the actual mutation to the canonical booking/cancel RPCs — never duplicating business logic. Outbound flow: send-whatsapp-message is invoked by the background worker, calls the Meta Cloud API, writes delivery logs, and retries with DLQ on exhaustion.",
    nodeIds: [
      "file:supabase/functions/process-whatsapp-webhook/index.ts",
      "file:supabase/functions/send-whatsapp-message/index.ts",
      "file:supabase/functions/_shared/whatsapp/whatsapp_conversation_engine.ts",
      "file:supabase/functions/_shared/whatsapp/whatsapp_intent_router.ts",
      "file:supabase/migrations/42_whatsapp_conversational_engine.sql"
    ]
  },
  {
    order: 11,
    title: "Background Worker & Cron",
    description: "Off-thread work in SETURA is job-based, not timer-based per task. run-background-worker/index.ts uses claim_jobs_v2 with SKIP LOCKED to atomically lease work, heartbeat to worker_heartbeat_log, and route to a payload handler; failures retry with backoff and ultimately land in dead_letter_jobs. run-cron-minute/index.ts is the per-minute orchestrator that enqueues reminder, rollup, health-check, and partition-automation jobs (requires CRON_SECRET). The shared worker.ts module owns the lease/heartbeat/retry primitives reused by every processor. Note: as of Phase 1.6, no scheduler is installed locally (P0-02), so this layer is testable but not yet self-driving.",
    nodeIds: [
      "file:supabase/functions/run-background-worker/index.ts",
      "file:supabase/functions/run-cron-minute/index.ts",
      "file:supabase/functions/_shared/worker.ts"
    ]
  },
  {
    order: 12,
    title: "Test Suite, Commands & Local Operations",
    description: "SETURA tests run against the real local Supabase stack — no mocks for database or RPC behavior. The privilege_isolation.test.ts proves the SECURITY DEFINER boundary by asserting SQLSTATE 42501 (not 401) for anon/authenticated callers; whatsapp_conversational.test.ts exercises the full intent-to-delegation path; refund_sync.test.ts verifies process-refund keeps financial_ledger and daily_collection_entries consistent. deno.json defines the 10 authoritative tasks (validate:migrations, test, test:integration, gen:types:check, etc.) and .env.example lists the 21 placeholders (CRON_SECRET, WORKER_SECRET, META_APP_SECRET, RAZORPAY_KEY_SECRET, etc.) — no .env exists in the repo, so local runs need clearly-fake values, never real secrets.",
    nodeIds: [
      "file:tests/integration/privilege_isolation.test.ts",
      "file:tests/integration/whatsapp_conversational.test.ts",
      "file:tests/integration/refund_sync.test.ts",
      "config:deno.json",
      "config:.env.example"
    ],
    languageLesson: "Deno tasks replace npm scripts entirely: there is no package.json, Makefile, or justfile. fmt and gen:types rewrite files and are never run casually — only check variants (fmt:check, gen:types:check) are read-only and safe for CI."
  }
];

fs.writeFileSync("d:/Projects/datasets/setura/.ua/intermediate/tour.json", JSON.stringify(tour, null, 2));
console.log("Wrote tour with", tour.length, "steps");
console.log("Steps:");
tour.forEach(s => console.log("  " + s.order + ". " + s.title));
