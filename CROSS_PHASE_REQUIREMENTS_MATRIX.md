# SETURA — CROSS-PHASE REQUIREMENTS MATRIX

**Phase 0 → Phase 1.5 · Independent read-only reconciliation**
**Audit date:** 2026-08-21
**Auditor stance:** Principal Enterprise Architect / Security Architect / Backend
Architect / Database Architect / QA & Validation Lead / Product Systems Auditor
**Mandate rules in force:** RULE 1 (read-only), RULE 2 (completion reports are
evidence, not truth), RULE 3 (requirement → implementation → call path → runtime
effect → test → status), RULE 4 (single explicit status per requirement), RULE 5
(no derived percentage without a stated derivation), PART 27 (evidence standard —
`UNPROVEN`, never `PASS`, where verification was not possible).

---

## 0. HOW THIS MATRIX WAS CONSTRUCTED (RULE 5 derivation)

### 0.1 Requirement sources

Requirements were extracted from committed artifacts only. No requirement was
invented, and none was dropped because a later document stopped mentioning it
(PART 20 constraint).

| Set    | Source of the requirement                                                                                        | Rows |
| ------ | ---------------------------------------------------------------------------------------------------------------- | ---- |
| **F**  | `ROADMAP.md:25-39` — Phase 0 Foundation (5 tasks, expanded to their certification-gate sub-clauses)              | 19   |
| **Z**  | `ROADMAP.md:43-66` — Phase 0.5 Architecture Freeze (8 freeze categories + deliverable + amendment gate)          | 10   |
| **W**  | `ROADMAP.md:72-119` — Phase 1.1 WhatsApp Reliability (as written in the locked roadmap)                          | 8    |
| **R**  | `ROADMAP.md:123-156` — Phase 1.2 Refund Consistency                                                              | 8    |
| **T**  | `ROADMAP.md:160-186` — Phase 1.3 Retention                                                                       | 5    |
| **S**  | `ROADMAP.md:190-228` — Phase 1.4 Subscription Platform                                                            | 8    |
| **I**  | `ROADMAP.md:232-266` — Phase 2 Integration Hardening (11 checks + matrix deliverable)                             | 12   |
| **V**  | `ROADMAP.md:270-291` — Phase 2.5 Enterprise Validation (6 checks + gate + deliverable)                            | 8    |
| **C**  | `ROADMAP.md:295-318` — Phase 3 Incoming WhatsApp Consumer (in-scope items + explicit out-of-scope items)          | 6    |
| **N1** | Executed "Phase 1.1" — WhatsApp inbound/conversational subsystem (migrations 42, 44; `process-whatsapp-webhook`)  | 10   |
| **N2** | Executed "Phase 1.2" — queue runtime (migration 43; `queue-control`, `queue-next-patient`, `compute-sla`)         | 10   |
| **N3** | Executed "Phase 1.3" — retention / usage (migrations 45, 15, 22)                                                  | 8    |
| **N4** | Executed "Phase 1.4" — enterprise command centre & analytics (migrations 46, 47)                                  | 8    |
| **N5** | Executed "Phase 1.5" — privilege hardening (migrations 48, 49; `PHASE_1.5_*` reports)                             | 12   |
| **X**  | Cross-cutting architectural commitments asserted in `ARCHITECTURE.md` and enforced by `scripts/validate_migrations.ts` | 15   |
|        | **TOTAL REQUIREMENTS AUDITED**                                                                                    | **147** |

### 0.2 Why two parallel 1.1–1.5 sets exist (W/R/T/S vs N1–N5)

`ROADMAP.md` — the document the repository itself labels as locked — defines
Phase 1.1 = WhatsApp Reliability, 1.2 = Refund Consistency, 1.3 = Retention,
1.4 = Subscription Platform. The work **actually executed** under the labels
"Phase 1.1"–"Phase 1.5" is a different set of subsystems (inbound WhatsApp, queue
runtime, retention, enterprise command centre, privilege hardening).
`ROADMAP.md` contains **zero occurrences of the string "1.5"**.

Both sets are therefore audited. Auditing only the executed set would silently
retire the roadmap's commitments; auditing only the roadmap set would ignore
shipped code. See `ARCHITECTURAL_DRIFT_REGISTER.md` D-01.

### 0.3 Status vocabulary (RULE 4 — exactly one per row)

| Code    | Meaning                                                                              |
| ------- | ------------------------------------------------------------------------------------ |
| **VC**  | VERIFIED COMPLETE — implementation + call path + evidence all confirmed in this audit |
| **PC**  | PARTIALLY COMPLETE — some clauses met, others not                                     |
| **UNP** | IMPLEMENTED BUT UNPROVEN — code exists; behaviour could not be verified              |
| **BRK** | IMPLEMENTED BUT BROKEN — code exists and demonstrably cannot achieve the requirement |
| **MIS** | MISSING — no implementation                                                          |
| **SUP** | SUPERSEDED — deliberately replaced by a later, verified decision                     |
| **DUP** | DUPLICATED / CONFLICTING — two implementations disagree                              |
| **OOS** | OUT OF SCOPE for Phase ≤ 1.5                                                         |
| **NPD** | NEEDS PRODUCT DECISION — cannot be classified without a business ruling              |

### 0.4 Evidence limitation declared up front (PART 27)

Docker Desktop was **not running** for the duration of this audit
(`docker ps` → `failed to connect to the docker API at
npipe:////./pipe/dockerDesktopLinuxEngine`). Starting the stack would mutate
shared local state and was refused under RULE 1. Consequently:

- `supabase db reset`, `supabase start`, `supabase functions serve` — **not run**
- `deno task test:integration` (162 cases) — **not run**
- All `pg_catalog` / `pg_policies` / `information_schema` / PostgREST assertions —
  **not run**

Every requirement whose only proof would be one of the above is recorded **UNP**,
never VC. Static gates that *were* executed are named in §0.5.

### 0.5 Static gates executed by this audit (read-only)

| Command                            | Result                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `deno task validate:migrations`    | **49 files, 0 errors, 4 warnings**                                        |
| `deno fmt --check`                 | **259 files, exit 0**                                                     |
| `deno lint`                        | **75 files, clean**                                                       |
| `deno task check`                  | **0 errors**                                                              |
| `deno task test` (unit)            | **65 passed / 0 failed, 905 ms**                                          |
| `deno task test:integration`       | **NOT RUN** — stack unavailable                                           |

The 4 validator warnings are: `dashboard_presence` (11 + 20),
`check_partition_readiness` (15 + 22), `partition_health` view (15 + 22),
`idx_alert_events_open` (`24:140` + `47:83`). Every phase report from 0.5 through
1.4 states "3 pre-existing warnings". The correct count at HEAD is **4**.

---

## 1. SET F — PHASE 0 FOUNDATION (19 requirements)

Source: `ROADMAP.md:25-39`. Certification gate: "harness runs, all 37 migrations
apply cleanly to a fresh DB, `supabase functions serve` starts without import
errors."

| ID   | Requirement                                                        | Earliest promise    | Implementation / evidence                                                                                    | Test evidence                              | Status  |
| ---- | ------------------------------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | ------- |
| F-01 | Local Supabase stack starts (`supabase start`)                      | ROADMAP.md:27       | `supabase/config.toml` complete (api, db, auth, realtime, storage, edge_runtime); `major_version = 17` (`:36`) | none — requires Docker                     | **UNP** |
| F-02 | All migrations apply cleanly to a fresh database                    | ROADMAP.md:27,37    | 49 migration files present; validator passes 49/49 with 0 errors; zero destructive statements found            | `supabase db reset` **not run**            | **UNP** |
| F-03 | `supabase functions serve` starts without import errors             | ROADMAP.md:39       | `deno task check` → 0 errors across 26 functions (partial proxy only — does not exercise the Deno edge runtime) | not run                                    | **UNP** |
| F-04 | Applied migrations recorded in a registry                           | mig 26 (`:33`)      | `migration_registry` + `record_migration` (`26:219`, `26:317`) + `take_deployment_snapshot` (`26:479`); backfill `26:520-546` seeds only 2 rows; only migrations 01, 26, 39, 48, 49 ever register → **5 / 49 ≈ 10 %** | none                                       | **PC**  |
| F-05 | Types generated from live schema; single source of truth            | ROADMAP.md:29-31    | `_shared/database.generated.ts` ("Generated by `deno task gen:types` — do not hand-edit") **and** hand-maintained `_shared/types.ts` (328 L, "mirror SQL enums exactly"). Both are imported by production code | `gen:types:check` exists in `deno.json`; CI never invokes it | **PC**  |
| F-06 | Type-check gate: `deno task check` = 0 errors                      | ROADMAP.md:33       | Executed this audit → **0 errors**                                                                            | CI `.github/workflows` runs it (blocking)  | **VC**  |
| F-07 | Format gate: `deno fmt --check` clean                              | ROADMAP.md:33       | Executed → **259 files, exit 0**                                                                               | CI blocking                                | **VC**  |
| F-08 | Lint gate: `deno lint` clean                                       | ROADMAP.md:33       | Executed → **75 files, clean**                                                                                 | CI blocking                                | **VC**  |
| F-09 | Migration validator gate                                           | `scripts/validate_migrations.ts` | Executed → 49 files, 0 errors, 4 warnings; check 7 `privilege-regression` active; `PRIVILEGE_BASELINE = 48`        | CI blocking                                | **VC**  |
| F-10 | Unit test harness exists and runs                                  | ROADMAP.md:33       | Executed → **65 passed / 0 failed**                                                                            | 65 assertions across `tests/unit/`         | **VC**  |
| F-11 | Integration test harness exists and runs                           | ROADMAP.md:33       | `tests/integration/` — **162 cases counted statically**                                                        | execution **not run** (Docker)             | **UNP** |
| F-12 | Seed: 1 hospital                                                   | ROADMAP.md:35       | `supabase/seed.sql` INSERT `hospitals`                                                                         | consumed by integration fixtures           | **VC**  |
| F-13 | Seed: hospital settings + queue config                             | ROADMAP.md:35       | `seed.sql` INSERT `hospital_settings`, `queue_configs`                                                          | —                                          | **VC**  |
| F-14 | Seed: working hours                                                | ROADMAP.md:35       | `seed.sql` INSERT `hospital_working_hours`                                                                      | —                                          | **VC**  |
| F-15 | Seed: booking fee policy                                           | ROADMAP.md:35       | `seed.sql` INSERT `booking_fee_policies`                                                                        | —                                          | **VC**  |
| F-16 | Seed: 1 doctor + specialization + schedule                         | ROADMAP.md:35       | `seed.sql` INSERT `profiles`, `doctor_specializations`, `doctor_schedules`                                       | —                                          | **VC**  |
| F-17 | Seed: 1 receptionist                                               | ROADMAP.md:35       | `seed.sql` INSERT `profiles` + `user_roles`                                                                     | —                                          | **VC**  |
| F-18 | Seed: 1 global_admin                                               | ROADMAP.md:35       | `seed.sql` INSERT `profiles` + `user_roles` (all 4 rows `is_primary = true`, `seed.sql:145-155`)                 | —                                          | **VC**  |
| F-19 | CI pipeline exists and blocks on failure                           | ROADMAP.md:37       | GitHub Actions workflow runs fmt + lint + check + validate:migrations + unit tests; all blocking                | self-evidencing                            | **VC**  |

**Set F tally:** VC 13 · PC 2 · UNP 4 · BRK 0 · MIS 0 · SUP 0 · DUP 0 · OOS 0 · NPD 0 = **19**

**Set F verdict:** The *gate* half of Phase 0 is genuinely complete and is
enforced by CI on every push — this is real, verified engineering. The
*environment* half (F-01/02/03) is unverifiable in this audit and has never been
proven by any artifact in the repository either: no phase report contains the
output of a fresh `supabase db reset` against migrations 01→49 (reports cite
01→41 at the latest). Two supporting subsystems are half-built: the migration
registry the repo built for itself is 10 % populated, and the "single source of
truth" for types is in fact two sources with no automated divergence guard.

---

## 2. SET Z — PHASE 0.5 ARCHITECTURE FREEZE (10 requirements)

Source: `ROADMAP.md:43-66`. Gate: "No code changes after this checkpoint that
modify frozen contracts without explicit amendment."

| ID   | Requirement                                                                                  | Earliest promise | Implementation / evidence                                                                                                                                                                       | Test evidence                       | Status  |
| ---- | -------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------- |
| Z-01 | **Schema freeze** — "Finalize all 37 migration tables + enums. No new tables/columns in Phase 1+. Evidence of Lock: Migration 37 is the last schema change." | ROADMAP.md:45-47 | **Breached.** Post-37 DDL measured: **5 new tables** (`whatsapp_conversation_states` 42, `queue_runtime_events` 43, `consultation_notes` 46, `alert_activity_log` 47, `alert_suppressions` 47), **17 new columns** (38 ×2, 43 ×4, 45 ×3, 47 ×8), **1 new enum value** (`42:25` `whatsapp_message_status` ADD VALUE `'received'`). Migrations 40, 41, 48 contain **0 DDL** — Phase 0.5's own "no schema changes" sub-claim is true; the breach is in 38 and 42–47 | none                                | **PC**  |
| Z-02 | **Type contract** — `_shared/types.ts` is the source of truth; "No hand-edited type overrides"                                                              | ROADMAP.md:49-51 | Two coexisting sources (see F-05). `types.ts` is entirely hand-maintained and contains hand-written enum mirrors. Spot-check: `BookingStatus` (10 values) matches `01_foundation.sql:34-45` exactly — currently in sync                                             | no divergence test in CI            | **PC**  |
| Z-03 | **API contracts** frozen (request/response shapes per endpoint)                                                                                             | ROADMAP.md:53    | No contract-schema artifact, no OpenAPI document, no response-shape snapshot test found anywhere in the repository. Shapes are asserted only inside individual integration tests                  | integration suite **not run**       | **UNP** |
| Z-04 | **Coding standards** documented and followed                                                                                                               | ROADMAP.md:55    | `ARCHITECTURE.md` + consistent `_shared/` module structure across all 26 functions; fmt/lint gates enforce mechanically                                                                          | F-07, F-08 executed clean           | **VC**  |
| Z-05 | **Logging format** — structured logger, no ad-hoc console output                                                                                            | ROADMAP.md:57    | Repository-wide `console.*` count = **2**, both inside the logger itself (`_shared/logger.ts:92`, `:94`). Every other call site uses the structured logger                                        | verified by exhaustive grep         | **VC**  |
| Z-06 | **Audit format** — registered action types from migration 36                                                                                                | ROADMAP.md:59    | Migration 36 action-type registry present; `audit_logs` append-only (mutation triggers); `search_audit_logs` + `verify_audit_integrity` wired to `enterprise-reports`                              | integration coverage exists (not run) | **VC**  |
| Z-07 | **RLS pattern** — `hospital_id` claim + `current_user_role()`, "No exceptions", 176 existing policies                                                        | ROADMAP.md:61    | Pattern is followed by RLS policies, but the **authorization model is three-way inconsistent**: `has_permission()` unions all roles at a hospital; `current_user_role()` reduces to least privilege (`is_primary DESC, level ASC`); `_shared/auth.ts::selectRole()` denies outright when no row is primary. Policy count could not be verified (`pg_policies` unreachable) | `multi_role_auth.test.ts` test 6 documents the divergence | **PC**  |
| Z-08 | **Error format** — `SeturaError` hierarchy; "No raw `throw new Error()`"                                                                                     | ROADMAP.md:63    | **0** raw `throw new Error(` in the 20 user-facing endpoints. **24** occurrences remain, all inside the 5 machine functions (`run-cron-*`, `run-background-worker`, `send-*`)                      | none targeting the constraint       | **PC**  |
| Z-09 | **Deliverable:** `ARCHITECTURE.md`                                                                                                                          | ROADMAP.md:65    | Exists and is substantial, but states **"PostgreSQL 15"** where `config.toml:36` sets `major_version = 17`, and describes a 37-migration schema where HEAD has 49                                  | none                                | **PC**  |
| Z-10 | **Gate:** any post-freeze contract change carries an explicit amendment record                                                                               | ROADMAP.md:66    | **No amendment artifact exists.** No file records the 5 tables / 17 columns / 1 enum value added after the freeze, nor authorises them. `migration_registry` — the mechanism that could have recorded it — holds 5 of 49 rows | none                                | **MIS** |

**Set Z tally:** VC 3 · PC 5 · UNP 1 · BRK 0 · **MIS 1** · SUP 0 · DUP 0 · OOS 0 · NPD 0 = **10**

**Set Z verdict:** The freeze was **declared but not held, and its breach was
never recorded.** The mechanical contracts (logging, coding standards, audit
format) held well — those are enforced by tooling. Every contract that depended
on human discipline plus a governance artifact (schema freeze, amendment record,
API contract, type single-source) is partial or missing. Z-10 is the structurally
most serious row in this set: the *gate itself* — the thing that was supposed to
make the freeze meaningful — has no implementation.

---

## 3. SET W — ROADMAP PHASE 1.1: WHATSAPP RELIABILITY (8 requirements)

Source: `ROADMAP.md:72-119`. This is the roadmap's *own* Phase 1.1, distinct from
the executed "Phase 1.1" (set N1).

| ID   | Requirement                                                                             | Earliest promise  | Implementation / evidence                                                                                                                                                                    | Test evidence                                                        | Status |
| ---- | --------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------ |
| W-01 | Durable outbound message store with a status lifecycle                                   | ROADMAP.md:74     | `whatsapp_messages` (mig 04) with `message_status` enum: `queued → processing → sent / failed / retrying / permanently_failed` (+ `received` added in `42:25`)                                     | `whatsapp_lifecycle.test.ts` (9 cases)                               | **VC** |
| W-02 | Worker-driven send consumer                                                              | ROADMAP.md:76     | `supabase/functions/send-whatsapp-message/index.ts` (863 L), invoked as a job handler from `run-background-worker` (497 L) via `_shared/worker.ts`                                               | integration cases exist (**not run**)                                | **VC** |
| W-03 | **`booking.whatsapp_confirmation_sent = true` within 30 seconds of booking**              | ROADMAP.md:~90    | Column written at `send-whatsapp-message/index.ts:665` and `carry-forward-tokens/index.ts:352`. The **30-second SLA is unattainable as configured**: nothing schedules the worker (`.env.example` ships `ENABLE_WORKER_TRIGGER=false`; no `pg_cron`, no `cron.schedule`, no scheduler config, no deploy workflow) | no test asserts the latency bound                                    | **PC** |
| W-04 | Exponential backoff on retryable failures: `POWER(2, retry_count)`                        | ROADMAP.md:~95    | `schedule_whatsapp_retry` — `04_whatsapp_messaging_engine.sql:598`, backoff at `04:649` `POWER(2, v_retry_count)::INTEGER`. Called from `send-whatsapp-message/index.ts:785-786`. Same pattern replicated at `05:495`, `06:426`, `06:436`, `19:786` | `whatsapp_lifecycle.test.ts`                                          | **VC** |
| W-05 | Permanent Meta error codes 131047 / 131051 / 131052 / 131053 / 131056 → no retry           | ROADMAP.md:~100   | `send-whatsapp-message/index.ts:285-290` `permanentCodes` set — all five codes, exact match; `isPermanentFail` at `:300`; terminal write `message_status: "permanently_failed"` at `:747`         | unit coverage of the code set                                        | **VC** |
| W-06 | Retry exhaustion routes to a dead-letter queue                                            | ROADMAP.md:~105   | Two independent paths: (a) message-level — `schedule_whatsapp_retry` returns `false` when exhausted → `metrics.increment("whatsapp.bookkeeping.retries_exhausted")` (`:802`); (b) job-level — handler throws → `fail_job_v2` → `dead_letter_jobs` insert on attempt exhaustion | `fail_job_v2` exhaustion path verified statically; no test exercises the DLQ insert for WhatsApp | **VC** |
| W-07 | **"Failed messages visible in DLQ within 5 minutes"**                                     | ROADMAP.md:~110   | `get_dlq_summary` exists and **is wired** (`command-center/index.ts`). Visibility latency again depends on the unscheduled worker (W-03) — with `ENABLE_WORKER_TRIGGER=false` and no cron, a failure never reaches the DLQ at all | none                                                                 | **PC** |
| W-08 | Idempotent send — a retried job must not send a duplicate message                         | ROADMAP.md:~85    | `enqueue_job` deterministic idempotency keys + `idempotency_keys` table; `register_webhook_event_v2` payload-hash dedupe on the inbound side                                                    | `whatsapp_lifecycle.test.ts:12,277,282,296` exercise `register_webhook_event_v2` | **VC** |

**Set W tally:** VC 6 · PC 2 · UNP 0 · BRK 0 · MIS 0 · SUP 0 · DUP 0 · OOS 0 · NPD 0 = **8**

**Set W verdict:** The **message-engine logic is genuinely and precisely built to
contract** — the backoff formula, the five permanent codes, and the terminal
status are exactly what `ROADMAP.md` specified, verified line by line. This is
the best requirement-to-code fidelity found anywhere in the audit. What fails is
not the logic but its **execution environment**: both time-bounded criteria
(W-03's 30 seconds, W-07's 5 minutes) are unreachable because the worker that
runs this logic has no scheduler and is disabled by the documented default
configuration. Correct code that never runs satisfies no SLA.

---

## 4. SET R — ROADMAP PHASE 1.2: REFUND CONSISTENCY (8 requirements)

Source: `ROADMAP.md:123-156`.

| ID   | Requirement                                                                           | Earliest promise    | Implementation / evidence                                                                                                                                                                                                                                       | Test evidence                                                    | Status  |
| ---- | ------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------- |
| R-01 | **On successful refund set `bookings.payment_status_detail = 'refund_processed'`**      | ROADMAP.md:~130     | **No writer exists.** The column was created with a CHECK enumerating `refund_initiated / refund_processed / refund_failed` (`28:51-61`). Exhaustive search for writers of `payment_status_detail` yields exactly one runtime assignment: `34_payment_ledger_cleanup.sql:198` → `'payment_captured'`. `confirm_refund_processed` (mig 41) updates `payment_refunds`, `payment_orders`, `financial_ledger`, `daily_collection_entries` — and **never touches `bookings`** | none                                                             | **MIS** |
| R-02 | **On failed refund set `payment_status_detail = 'refund_failed'` and log it**           | ROADMAP.md:~132     | Same as R-01 — the state is unreachable. `'refund_initiated'`, `'payment_initiated'` and `'payment_failed'` are likewise never written at runtime (only the one-time backfill at `28:87-94` sets `not_applicable` / `payment_captured` / `awaiting_payment`)         | none                                                             | **MIS** |
| R-03 | Every confirmed refund writes a `refund_debit` ledger entry                             | ROADMAP.md:~135     | `confirm_refund_processed` (mig 41) → `INSERT INTO public.financial_ledger` (body line 52). Ledger is append-only (`prevent_ledger_mutation` + `trg_ledger_no_update` / `trg_ledger_no_delete`)                                                                    | `refund_sync.test.ts`                                            | **VC**  |
| R-04 | Razorpay refund webhook is received and processed                                       | ROADMAP.md:~140     | Handler exists (`verify-payment/index.ts`, webhook branch selected at `:204-205` by `X-Razorpay-Signature` presence, fail-closed 403). **But the HMAC uses the wrong secret**: `:63` computes `hmacSha256(rawBody, Env.RAZORPAY_KEY_SECRET)`. Razorpay signs webhooks with a separate dashboard-configured webhook secret. **No `RAZORPAY_WEBHOOK_SECRET` exists** in `_shared/env.ts`, `.env.example`, or anywhere in the repo → every genuine Razorpay webhook is rejected 403 unless an operator deliberately sets the two secrets equal | no test supplies a real Razorpay webhook signature                | **BRK** |
| R-05 | Refund correctly reduces settlement / outstanding balance                                | ROADMAP.md:~145     | `confirm_refund_processed` (mig 41, body line 78) **zeroes** `platform_fee`, `receptionist_fee`, `hospital_fee` and `total_amount` on all unsettled `daily_collection_entries` rows for the booking — **regardless of the refund amount**. A ₹10 refund on a ₹100 booking erases the full ₹100 of fee accrual | `refund_sync.test.ts` covers **full refunds only**                | **BRK** |
| R-06 | `cancel-booking` issues a refund when one is due                                        | ROADMAP.md:~148     | Gate is `if (refundAmount > 0)`, and `refundAmount` derives from `bookings.booking_fee_inr` — a column with **no runtime writer**. Its only assignment is the one-time backfill `28:81-86` (`WHERE booking_fee_inr = 0 AND payment_completed = true`). Same dead gate in `whatsapp_cancel_flow` (`state.paymentCompleted && (state.bookingFee ?? 0) > 0`). `calculate_refund_amount` (mig 29) reads the same column | `whatsapp_conversational.test.ts:838` **masks** the defect with a hand-set fixture value | **BRK** |
| R-07 | Refund replay protection — a refund cannot be issued twice                               | ROADMAP.md:~150     | `confirm_refund_processed` (mig 41): `IF v_refund.refund_status = 'processed' THEN RETURN FALSE` (body lines 22, 27). Real guard, correctly placed before any mutation                                                                                            | `refund_sync.test.ts` asserts the replay case                    | **VC**  |
| R-08 | Refund concurrent with settlement produces a consistent result                           | ROADMAP.md:~153     | `create_platform_revenue_summary` (`33:176`) uses `pg_advisory_xact_lock` + duplicate rejection + row locking — a real concurrency design. Interaction with a simultaneous `confirm_refund_processed` is not exercised anywhere                                     | **no concurrency test exists**                                    | **UNP** |

**Set R tally:** VC 2 · PC 0 · UNP 1 · **BRK 3** · **MIS 2** · SUP 0 · DUP 0 · OOS 0 · NPD 0 = **8**

**Set R verdict:** **This is the weakest requirement set in the audit — 5 of 8
rows are broken or missing.** The refund subsystem's *ledger discipline* is
excellent (append-only, replay-guarded, advisory-locked). Its *reachability* is
not: two of three refund entry paths are gated on a column nothing writes, the
webhook path verifies against the wrong secret, partial refunds over-adjust
settlement, and the two headline status transitions the roadmap named as Phase
1.2's success criteria have no writer at all. `refund_sync.test.ts` passes
because it tests the full-refund happy path from a hand-constructed fixture —
this is a case where a green test actively conceals a production defect (PART 17).

---

## 5. SET T — ROADMAP PHASE 1.3: RETENTION (5 requirements)

Source: `ROADMAP.md:160-186`.

| ID   | Requirement                                            | Earliest promise | Implementation / evidence                                                                                                                                                                       | Test evidence                              | Status |
| ---- | ------------------------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------ |
| T-01 | Retention policy configured per data class              | ROADMAP.md:162   | Retention configuration tables + policy rows (migrations 15, 22, 45)                                                                                                                             | `usage_retention.test.ts`                  | **VC** |
| T-02 | Purge / anonymisation routines implemented              | ROADMAP.md:~168  | Retention purge routines present in migration 45 with per-class cut-offs                                                                                                                          | `usage_retention.test.ts`                  | **VC** |
| T-03 | Retention reporting available to operators              | ROADMAP.md:~175  | `get_retention_report` — one of only **two** of the 11 test-only routines with genuine functional coverage                                                                                        | `usage_retention.test.ts` (functional)     | **VC** |
| T-04 | Retention runs on a schedule                            | ROADMAP.md:~180  | Nightly step exists inside `run-cron-nightly` (373 L), but **nothing invokes `run-cron-nightly`** — no `pg_cron`, no `cron.schedule`, no scheduler configuration, no deploy workflow. Only `.qoder/repowiki` prose says an external scheduler "should" be configured | none                                       | **PC** |
| T-05 | Audit-log partitioning supports retention              | ROADMAP.md:~184  | **Advisory only.** `plan_partitions` inserts `'planned'` manifest rows; `generate_audit_log_partition_ddl` emits DDL text; **nothing executes it**; no table in the schema is actually partitioned. `check_partition_readiness()` nonetheless returns `'Partitions will auto-create'` | `generate_audit_log_partition_ddl` has REVOKE-only coverage | **PC** |

**Set T tally:** VC 3 · PC 2 · UNP 0 · BRK 0 · MIS 0 · SUP 0 · DUP 0 · OOS 0 · NPD 0 = **5**

**Set T verdict:** Retention is the **most honestly complete of the four roadmap
1.x sets** — the policy model, the purge routines and the report are all real and
functionally tested. Both partial rows share one root cause with the rest of the
system: the absence of any scheduler, plus a partition subsystem that reports
success while creating nothing.

---

## 6. SET S — ROADMAP PHASE 1.4: SUBSCRIPTION PLATFORM (8 requirements)

Source: `ROADMAP.md:190-228`. Named success criterion: *"Hospital on Starter plan
(50 bookings/month) gets blocked on #51."*

| ID   | Requirement                                                          | Earliest promise    | Implementation / evidence                                                                                                                                     | Test evidence                                   | Status  |
| ---- | -------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------- |
| S-01 | Subscription plan + hospital-subscription schema                      | ROADMAP.md:192      | `subscription_plans`, `hospital_subscriptions` and related tables present                                                                                      | `usage_retention.test.ts` (partial)             | **VC**  |
| S-02 | Per-booking usage recording                                          | ROADMAP.md:~196     | `create-booking/index.ts:649` → `record_subscription_usage`. Real runtime call path                                                                             | integration coverage exists (**not run**)        | **VC**  |
| S-03 | `get_subscription_limits()` RPC                                      | ROADMAP.md:~200     | Function exists. **Zero production callers** — appears only in `privilege_isolation.test.ts` REVOKE assertions                                                   | REVOKE-assertion only                            | **PC**  |
| S-04 | `is_subscription_active()` RPC                                       | ROADMAP.md:~204     | Function exists. **Zero production callers** — REVOKE-assertion coverage only                                                                                  | REVOKE-assertion only                            | **PC**  |
| S-05 | **`check_booking_limit()` RPC (ROADMAP item 5)**                      | ROADMAP.md:~208     | **The function does not exist.** Exhaustive search across all 49 migrations, 26 edge functions, generated types and tests returns no definition and no reference | none                                            | **MIS** |
| S-06 | **`create-booking` returns HTTP 429 when the quota is exceeded (ROADMAP item 6)** | ROADMAP.md:~212     | **No quota gate exists in `create-booking` (688 L).** It records usage (S-02) but never reads a limit and never returns 429. The stated criterion "blocked on #51" is unachievable | none                                            | **MIS** |
| S-07 | Plan-change capability                                               | ROADMAP.md:~218     | `change_subscription_plan` exists; **no edge function exposes it** — not among the 26 functions' RPC call sets                                                   | REVOKE-assertion only                            | **PC**  |
| S-08 | Usage / limit visibility for administrators                           | ROADMAP.md:~222     | `get_subscription_usage` exists and has functional coverage, but is **not surfaced by any dashboard RPC** — absent from the `command-center`, `financial-command-center`, `executive-analytics` and `enterprise-reports` call maps | `usage_retention.test.ts` (functional)          | **PC**  |

**Set S tally:** VC 2 · PC 4 · UNP 0 · BRK 0 · **MIS 2** · SUP 0 · DUP 0 · OOS 0 · NPD 0 = **8**

**Set S verdict:** Subscription is **metering without enforcement**. Usage is
faithfully recorded on every booking; nothing ever reads it to make a decision.
The two roadmap items that constitute the actual commercial control — the
`check_booking_limit()` RPC and the 429 in `create-booking` — are the only two
rows here that are outright MISSING, and they are precisely the two that the
roadmap wrote a testable success criterion for. Commercially this means **plan
tiers are currently unenforceable**: a hospital on any plan can book without
limit. Four further routines exist but are unreachable, so the subsystem's
surface area overstates its capability by roughly a factor of three.

---

## 7. SET I — ROADMAP PHASE 2: INTEGRATION HARDENING (12 requirements)

Source: `ROADMAP.md:232-266`. `ROADMAP.md:487-507` marks Phase 2 as the
dependency that **"blocks everything."** Phase 2 was never executed; the work
labelled 1.1–1.5 was performed instead. These requirements are therefore audited
as outstanding commitments, not as failures of a completed phase.

| ID   | Requirement                                                                        | Earliest promise | Implementation / evidence                                                                                                                                                                                | Test evidence                              | Status  |
| ---- | ---------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------- |
| I-01 | **Deliverable: integration matrix — 8 workflows × 6 verification checks**            | ROADMAP.md:266   | No such document exists. A partial mechanism does: `verify_integration_matrix` RPC, wired to `enterprise-reports`. It has never been run in any recorded form                                              | none                                       | **PC**  |
| I-02 | `create-booking` creates the `payment_order` **atomically** with the booking          | ROADMAP.md:~236  | **Not implemented.** `create-booking` (688 L) creates no payment order; order creation is a separate endpoint (`create-payment-order`, 406 L). Booking and payment order therefore cannot be atomic         | none                                       | **MIS** |
| I-03 | **"Verify `run-cron-nightly` does NOT wake worker (nightly tasks are synchronous)"** | ROADMAP.md:~248  | **Actively contradicted by the code.** `run-cron-nightly/index.ts:296` posts to `run-background-worker` (step 9) — the exact behaviour the requirement forbids. It additionally sends the wrong credential (I-07) | none                                       | **MIS** |
| I-04 | MV refresh uses `CONCURRENTLY`                                                       | ROADMAP.md:~252  | `refresh_single_mv` (`17:497`) issues `REFRESH MATERIALIZED VIEW CONCURRENTLY` for each of the five views (`17:529-541`); each MV carries the required unique index                                          | none                                       | **VC**  |
| I-05 | MV refresh order respects dependencies                                               | ROADMAP.md:~254  | `refresh_analytics_views_ordered` (`17:597`) uses an explicit ordered array ending in `mv_revenue_forecast`, which reads `mv_daily_hospital_stats` in its own body (`08:345`) — the ordering is necessary and correct | none                                       | **VC**  |
| I-06 | **Worker crash → in-flight job reclaimed**                                            | ROADMAP.md:~258  | **Dead end-to-end.** `claim_jobs_v2` (the runtime path, `_shared/worker.ts:107`) never populates `job_queue.lease_expires_at`. The wired reclaimer `reclaim_stale_jobs` (mig 06) filters `WHERE status='processing' AND lease_expires_at < now()` — `NULL < now()` is NULL, so it reclaims nothing, ever. The v2-aware `run_worker_crash_recovery` / `detect_crashed_workers` / `reclaim_crashed_worker_jobs` have **no caller anywhere**. v1 `claim_jobs` *did* set the column (`06:283`) — this is a regression introduced by migration 19 | **none.** The only test named for crash recovery (`whatsapp_lifecycle.test.ts:310-340`) covers `reclaim_stale_whatsapp_processing`, a different subsystem | **BRK** |
| I-07 | All cron endpoints authenticated with `CRON_SECRET`                                   | ROADMAP.md:~240  | `run-cron-minute:352,392` uses the correct secret. `run-cron-nightly:296` sends `Env.SUPABASE_SERVICE_KEY.slice(-20)` as `X-Cron-Secret`, while `run-background-worker:301` compares against `Env.CRON_SECRET` → **nightly step 9 always 403** | none                                       | **PC**  |
| I-08 | Webhook idempotency holds across provider retries                                     | ROADMAP.md:~244  | `register_webhook_event_v2` + payload hash; Razorpay dedupe keyed on the payment id (stronger than event-id dedupe); `idempotency_keys` table                                                              | `whatsapp_lifecycle.test.ts`               | **VC**  |
| I-09 | Queue advance is safe under concurrency                                               | ROADMAP.md:~246  | `advance_queue` uses `FOR UPDATE SKIP LOCKED`                                                                                                                                                             | integration coverage exists (**not run**)   | **VC**  |
| I-10 | Realtime channel publishes queue state                                                | ROADMAP.md:~250  | `43_queue_runtime.sql:111-112` adds `queue_runtime_events` to the `supabase_realtime` publication; `:118-119` ENABLE + FORCE RLS; policy `queue_events_service` at `:124`                                    | none                                       | **VC**  |
| I-11 | Settlement engine functions end to end                                               | ROADMAP.md:~260  | **`settlement-engine`'s `record_payment` action always returns HTTP 500.** Migration 33 reduced `record_settlement_payment` to a permanent `RAISE NOTICE 'DEPRECATED…'; RETURN FALSE;`, and the edge function throws `InternalError("Settlement payment RPC returned false")` at `:418` | none covering `record_payment`             | **BRK** |
| I-12 | Cron schedules are configured and active                                             | ROADMAP.md:~238  | **Nothing schedules anything.** No `pg_cron` extension, no `cron.schedule` call, no `[functions]` or schedule block in `config.toml`, no deploy workflow. All four machine endpoints (`run-cron-minute`, `run-cron-nightly`, `send-reminders`, `run-background-worker`) rely entirely on an external caller that no artifact configures | none                                       | **MIS** |

**Set I tally:** VC 5 · PC 2 · UNP 0 · **BRK 2** · **MIS 3** · SUP 0 · DUP 0 · OOS 0 · NPD 0 = **12**

**Set I verdict:** Phase 2 was labelled in the roadmap as the phase that
**"blocks everything"**, and the audit substantiates that judgement. The
individual integration primitives are strong — SKIP LOCKED, `CONCURRENTLY` in
dependency order, payload-hash idempotency, Realtime with FORCE RLS are all
correctly built and independently verified here. What is missing is exactly the
*hardening* Phase 2 existed to perform: nothing schedules the system (I-12),
crash recovery is inert (I-06), one documented negative constraint is violated by
shipped code (I-03), the settlement write path returns 500 by construction
(I-11), and the verification deliverable that would have caught all of this was
never produced (I-01).

---

## 8. SET V — ROADMAP PHASE 2.5: ENTERPRISE VALIDATION (8 requirements)

Source: `ROADMAP.md:270-291`. Stated certification gate: *"All 6 checks pass. If
any check fails, fix before Phase 3/4A."* `ROADMAP.md:487-507` describes Phase 2.5
as the phase that **"verifies freeze held."**

| ID   | Requirement                                                     | Earliest promise | Implementation / evidence                                                                                                                                                                     | Test evidence | Status  |
| ---- | --------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------- |
| V-01 | API contract freeze diff                                        | ROADMAP.md:~274  | No contract baseline and no diff artifact exists anywhere in the repository (see Z-03)                                                                                                          | none          | **MIS** |
| V-02 | DB migration freeze verified via `supabase db diff`              | ROADMAP.md:~276  | Never run; no recorded output. Had it been run it would have surfaced the Z-01 breach (5 tables / 17 columns / 1 enum value added after migration 37)                                             | none          | **MIS** |
| V-03 | Security audit over `pg_policies`                               | ROADMAP.md:~280  | RLS is enabled and FORCE'd in the migrations, and migrations 48 §11 / 49 §5 contain self-proving assertion blocks. The catalog-level enumeration the requirement asks for could not be executed (Docker down) and no recorded output exists | none          | **UNP** |
| V-04 | Performance benchmark — p50 / p95 / p99                         | ROADMAP.md:~284  | No benchmark harness, no recorded latency numbers, no load-test script                                                                                                                          | none          | **MIS** |
| V-05 | Observability verification                                      | ROADMAP.md:~286  | Real components exist: `monitoring-health-check` (230 L, `global_admin`-gated), `alert-center` (405 L), `queue_metrics_snapshots` + `write_queue_metrics_snapshot` (mig 17), `get_mv_refresh_health`, `get_dlq_summary`. None has been *verified* end to end, and the snapshot writer runs only from the unscheduled `run_scheduled_tasks` | none          | **PC**  |
| V-06 | **DR test: worker crash mid-lease → job reclaimed**              | ROADMAP.md:~288  | The capability itself is broken (I-06), so the test could not pass if written. It is not written                                                                                                | none          | **BRK** |
| V-07 | **DR test: Meta API outage → retry + DLQ**                       | ROADMAP.md:~290  | Retry + DLQ logic is verified present (W-04/W-06); no outage-simulation test exists and the path has never been executed against a failing provider                                              | none          | **UNP** |
| V-08 | **Deliverable: Enterprise Validation Report**                    | ROADMAP.md:291   | Does not exist                                                                                                                                                                                | none          | **MIS** |

**Set V tally:** VC 0 · PC 1 · UNP 2 · BRK 1 · **MIS 4** · SUP 0 · DUP 0 · OOS 0 · NPD 0 = **8**

**Set V verdict:** **Set V has zero VERIFIED COMPLETE rows — the only set in the
audit with none.** Phase 2.5 was the roadmap's designated proof phase: the step
that would have verified the freeze held, that contracts had not drifted, that
crash recovery worked, and that performance was characterised. It was skipped
entirely. Every defect this audit found in sets I and R is a defect Phase 2.5 was
specifically designed to catch — V-02 would have caught Z-01, V-06 would have
caught I-06, V-01 would have caught Z-03. The absence of this phase is the single
best explanation for why the other gaps survived to HEAD undetected.

---

## 9. SET C — ROADMAP PHASE 3: INCOMING WHATSAPP CONSUMER (6 requirements)

Source: `ROADMAP.md:295-318`. Phase 3 is marked **Descoped**, with an explicit
in-scope list and an explicit out-of-scope list. Execution order
(`ROADMAP.md:476-484`) places Phase 3 **after** 2 and 2.5.

| ID   | Requirement                                                                | Earliest promise | Implementation / evidence                                                                                                                                                                          | Test evidence                        | Status  |
| ---- | -------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------- |
| C-01 | STATUS intent handled                                                      | ROADMAP.md:~300  | Implemented in `process-whatsapp-webhook` (662 L) via the deterministic intent router. **Built during the executed "Phase 1.1" — ahead of its scheduled phase**                                       | `whatsapp_conversational.test.ts`    | **VC**  |
| C-02 | QUEUE / POSITION intent handled                                            | ROADMAP.md:~302  | Implemented; same router. Also built ahead of schedule                                                                                                                                              | `whatsapp_conversational.test.ts`    | **VC**  |
| C-03 | CANCEL intent, **"offer cancellation via payment links"**                   | ROADMAP.md:~304  | Cancel flow exists, but (a) its refund branch is gated on `booking_fee_inr`, which nothing writes (R-06), and (b) **no WhatsApp flow creates a payment order or payment link at all** — so the "via payment links" clause has no implementation | `whatsapp_conversational.test.ts:838` uses a hand-set fee fixture | **PC**  |
| C-04 | **Conversational booking flow — explicitly OUT OF SCOPE, "defer to post-pilot"** | ROADMAP.md:~314  | **Built anyway** during the executed "Phase 1.1": `whatsapp_conversation_states` (mig 42) with 30-minute TTL, multi-turn state machine, booking creation from chat. This is descoped scope that shipped | `whatsapp_conversational.test.ts`    | **OOS** |
| C-05 | Multilingual templates (`name_te`) — out of scope, deferred                  | ROADMAP.md:~316  | Correctly **not** built. No `name_te` column, no locale resolution. All templates are single-language                                                                                                | n/a                                  | **OOS** |
| C-06 | Full NLP / intent detection — out of scope, deferred                        | ROADMAP.md:~318  | Correctly **not** built. The router is deterministic keyword matching with no model call — the right decision for a clinical system and consistent with the descoping                                 | n/a                                  | **OOS** |

**Set C tally:** VC 2 · PC 1 · UNP 0 · BRK 0 · MIS 0 · SUP 0 · DUP 0 · **OOS 3** · NPD 0 = **6**

**Set C verdict:** Phase 3 exhibits **scope inversion**: a phase scheduled to run
*after* the two blocking hardening phases was partly delivered *before* them, and
the specific capability the roadmap singled out as deferrable — the conversational
booking flow — is the one that shipped. The two genuine deferrals (multilingual,
NLP) were honoured, and the deterministic router is the architecturally sound
choice. But C-04 represents effort spent on descoped work while Phase 2's
"blocks everything" items (I-06, I-12) remained unaddressed, and C-03's payment
link — the mechanism that would make WhatsApp cancellation financially coherent —
was not built.

---

## 10. SET N1 — EXECUTED "PHASE 1.1": INBOUND WHATSAPP (10 requirements)

Source: the work actually shipped under the label "Phase 1.1" — migrations 42 and
44, `process-whatsapp-webhook`, `docs/security/WEBHOOK_SIGNATURE_BOUNDARY.md`.

| ID    | Requirement                                                       | Earliest promise                       | Implementation / evidence                                                                                                                                                                                        | Test evidence                                             | Status  |
| ----- | ----------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------- |
| N1-01 | Meta webhook endpoint with HMAC-SHA256 verification                | PHASE_1.1 scope / D-2                  | `_shared/webhook_signature.ts::verifyMetaSignature()`; handler `process-whatsapp-webhook/index.ts` (662 L)                                                                                                          | `tests/unit/webhook_signature.test.ts` — 18 cases, **executed and passing** | **VC**  |
| N1-02 | Signature verification is **fail-closed**, with typed rejections    | D-2                                    | Exactly one success path; four typed rejection constants: `secret_missing` → 500, `signature_missing` / `signature_malformed` / `signature_invalid` → 403. The previous fail-open `if (appSecret && signature)` is gone | 18 unit cases cover all five outcomes                     | **VC**  |
| N1-03 | Raw request bytes verified **before** `JSON.parse`                  | D-2                                    | `await req.text()` is HMAC'd before parsing — re-serialisation would alter the digest. Comparison is constant-time (length check on a fixed-length public digest, then a full-width XOR fold)                          | asserted in `webhook_signature.test.ts`                   | **VC**  |
| N1-04 | Conversation state store with a 30-minute TTL                       | PHASE_1.1 scope                        | `whatsapp_conversation_states` (mig 42) with TTL expiry                                                                                                                                                            | `whatsapp_conversational.test.ts`                         | **VC**  |
| N1-05 | Deterministic, no-LLM intent router                                 | PHASE_1.1 scope                        | Keyword-based routing inside `process-whatsapp-webhook`; no model invocation anywhere in the repository                                                                                                             | `whatsapp_conversational.test.ts`                         | **VC**  |
| N1-06 | Inbound event dedupe by payload hash                                | PHASE_1.1 scope                        | `register_webhook_event_v2` (mig 19) with payload hashing — strictly stronger than event-id dedupe because it survives provider id reuse                                                                             | `whatsapp_lifecycle.test.ts:12,277,282,296`               | **VC**  |
| N1-07 | Inbound messages processed by the background worker                 | PHASE_1.1 scope                        | `process_incoming_whatsapp` is a job handler in `run-background-worker`. **The job queue is its only consumer**, and the worker is unreachable under the documented default configuration (`ENABLE_WORKER_TRIGGER=false`, no scheduler, nightly trigger 403) | none end to end                                           | **PC**  |
| N1-08 | Inbound message persisted with `received` status                    | mig 42                                 | `42:25` `ALTER TYPE public.whatsapp_message_status ADD VALUE IF NOT EXISTS 'received'`; rows written by the webhook handler                                                                                          | `whatsapp_lifecycle.test.ts`                              | **VC**  |
| N1-09 | Conversational flow can create a booking                            | PHASE_1.1 scope                        | Booking is created, and a `daily_collection_entries` row plus `platform_fee_credit` / `receptionist_incentive_credit` ledger entries are written — **but no payment order or payment link is created in any WhatsApp path**, so revenue is recognised against an uncollectable booking | `whatsapp_conversational.test.ts`                         | **PC**  |
| N1-10 | Endpoint is reachable by Meta in production                         | D-2 / `WEBHOOK_SIGNATURE_BOUNDARY.md`  | `supabase/config.toml` has **no `[functions]` section at all**, so `verify_jwt = true` is the effective default; Meta sends no `Authorization` header. No `--no-verify-jwt` and no deploy invocation exists in the repository. The project's own document concludes: *"Production JWT boundary requires deployment verification. Do not invent a production configuration."* | none possible                                             | **UNP** |

**Set N1 tally:** VC 7 · PC 2 · **UNP 1** · BRK 0 · MIS 0 · SUP 0 · DUP 0 · OOS 0 · NPD 0 = **10**

**Set N1 verdict:** The **security half of this phase is exemplary** — N1-01/02/03
are the highest-quality work in the codebase: a single success path, typed
rejection reasons, raw-byte verification, constant-time comparison, no logging of
secrets, and 18 executed unit tests covering every outcome. The accompanying
`WEBHOOK_SIGNATURE_BOUNDARY.md` is an unusually honest engineering document that
declines to assert a production fact it cannot prove — this audit endorses both
its reasoning and its refusal to modify `config.toml` on a guess. The phase's two
weaknesses are inherited rather than local: the worker that consumes inbound
messages is unscheduled (N1-07), and the conversational booking it creates has no
payment mechanism (N1-09).

---

## 11. SET N2 — EXECUTED "PHASE 1.2": QUEUE RUNTIME (10 requirements)

Source: migration 43, `queue-control`, `queue-next-patient`, `compute-sla`.

| ID    | Requirement                                              | Earliest promise | Implementation / evidence                                                                                                            | Test evidence                            | Status |
| ----- | -------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ------ |
| N2-01 | Append-only queue event log                              | mig 43           | `queue_runtime_events` (`43:100`) — immutable by design                                                                                | integration coverage (**not run**)       | **VC** |
| N2-02 | Queue events published over Realtime                     | mig 43           | `43:111-112` adds the table to the `supabase_realtime` publication                                                                    | none                                     | **VC** |
| N2-03 | ENABLE + FORCE row-level security on the event log        | mig 43           | `43:118-119` both statements present; policy `queue_events_service` at `43:124`                                                        | `privilege_isolation.test.ts` (not run)  | **VC** |
| N2-04 | Tenant field immutable after insert                      | mig 43           | `trg_queue_events_hospital_immutable` BEFORE UPDATE → `prevent_hospital_id_update()` (`43:100-124`)                                    | none                                     | **VC** |
| N2-05 | Concurrent-safe queue advance                            | mig 43           | `advance_queue` with `FOR UPDATE SKIP LOCKED`                                                                                          | integration coverage (**not run**)       | **VC** |
| N2-06 | Pause / delay sessions                                   | mig 43           | `queue_sessions` + pause/delay RPCs, wired to `queue-control` (392 L, 10 actions)                                                       | integration coverage (**not run**)       | **VC** |
| N2-07 | Live queue snapshot for clients                          | mig 43           | `get_queue_snapshot`, wired to `queue-control` / `queue-next-patient` (514 L)                                                           | integration coverage (**not run**)       | **VC** |
| N2-08 | Event recording RPC wired to callers                     | mig 43           | `record_queue_event`, called from the queue endpoints                                                                                  | integration coverage (**not run**)       | **VC** |
| N2-09 | SLA computation triggered from queue activity            | mig 43           | `trigger_sla_refresh` + `compute-sla` (203 L, `hospital_admin` / `global_admin`); `compute_sla_tracking` also reachable via `refresh-rollups` | integration coverage (**not run**)       | **VC** |
| N2-10 | Booking state machine transitions enforced               | mig 01 / 43      | `_shared/booking_state.ts` + DB-side guards: `booked → checked_in → waiting → called → in_consultation → completed`, plus `cancelled` / `no_show` / `rescheduled` / `skipped`, with `skipped → waiting` re-entry. `BookingStatus` in `_shared/types.ts` matches `01_foundation.sql:34-45` exactly | `booking_state` unit tests (executed)    | **VC** |

**Set N2 tally:** VC 10 · PC 0 · UNP 0 · BRK 0 · MIS 0 · SUP 0 · DUP 0 · OOS 0 · NPD 0 = **10**

**Set N2 verdict:** **The strongest set in the audit — 10 of 10 VERIFIED
COMPLETE, and the only set with no qualification of any kind.** Every commitment
has an implementation, a live call path from a role-gated endpoint, and a
correctly-constructed security boundary. `queue_runtime_events` is the single best
example of the intended SETURA pattern executed fully: append-only, tenant-scoped,
immutability-triggered, ENABLE + FORCE RLS, and Realtime-published — all four
properties present in one 25-line migration block. The queue subsystem is the
part of SETURA that is genuinely production-shaped. Its integration tests remain
unexecuted in this audit (Docker), but unlike other sets the static evidence is
complete and mutually corroborating at every layer.

---

## 12. SET N3 — EXECUTED "PHASE 1.3": RETENTION & USAGE (8 requirements)

Source: migrations 15, 22, 45; `usage_retention.test.ts`.

| ID    | Requirement                                        | Earliest promise | Implementation / evidence                                                                                                                                          | Test evidence                              | Status  |
| ----- | -------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | ------- |
| N3-01 | Retention reporting RPC                            | mig 45           | `get_retention_report` — genuinely functionally tested                                                                                                              | `usage_retention.test.ts` (functional)     | **VC**  |
| N3-02 | Purge routines per data class                      | mig 45           | Purge routines with per-class cut-offs                                                                                                                              | `usage_retention.test.ts`                  | **VC**  |
| N3-03 | Retention behaviour covered by tests               | PHASE_1.3 scope  | `usage_retention.test.ts` provides real functional assertions — one of only two places among the 11 test-only routines where coverage is behavioural rather than a REVOKE check | executed statically; suite **not run**     | **VC**  |
| N3-04 | Subscription usage recorded per booking            | mig 45 / 22      | `record_subscription_usage` called at `create-booking/index.ts:649`                                                                                                 | integration coverage (**not run**)         | **VC**  |
| N3-05 | Audit-log partition DDL generation                 | mig 15 / 45      | `generate_audit_log_partition_ddl` emits DDL **text**; `plan_partitions` records `'planned'` manifest rows; nothing executes either                                   | REVOKE-assertion coverage only             | **PC**  |
| N3-06 | Partition readiness reported truthfully            | mig 15 / 22      | `check_partition_readiness()` returns `'Partitions will auto-create'`. **No table in the schema is partitioned and no code path creates a partition** — the function reports a capability that does not exist. Nightly step 7 likewise reports success while creating nothing | none                                       | **BRK** |
| N3-07 | Retention executes on schedule                     | PHASE_1.3 scope  | Nightly step present in `run-cron-nightly`; **no scheduler invokes it** (I-12)                                                                                       | none                                       | **PC**  |
| N3-08 | Retention configuration per data class             | mig 15 / 45      | Configuration tables and policy rows present                                                                                                                        | `usage_retention.test.ts`                  | **VC**  |

**Set N3 tally:** VC 5 · PC 2 · UNP 0 · **BRK 1** · MIS 0 · SUP 0 · DUP 0 · OOS 0 · NPD 0 = **8**

**Set N3 verdict:** Retention as executed is **substantially real** — the policy
model, purge routines, usage metering and reporting all exist with functional test
coverage, which distinguishes this set from the surface-only subsystems elsewhere.
The one BROKEN row deserves emphasis beyond its severity: `check_partition_readiness()`
returns a **reassuring string about a capability that does not exist**. An operator
reading that output would reasonably conclude partitioning is handled. Nightly
step 7 compounds it by reporting success. This is the audit's clearest instance of
a component whose *reporting* is more complete than its *behaviour* — the failure
mode RULE 2 exists to catch.

---

## 13. SET N4 — EXECUTED "PHASE 1.4": ENTERPRISE COMMAND CENTRE (8 requirements)

Source: migrations 46, 47; `command-center`, `financial-command-center`,
`executive-analytics`, `enterprise-reports`, `alert-center`.

| ID    | Requirement                                              | Earliest promise | Implementation / evidence                                                                                                                                                                                                                                                                        | Test evidence                    | Status  |
| ----- | -------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | ------- |
| N4-01 | Hospital operational command centre                      | mig 47           | `get_hospital_command_center` + `get_hospital_timeline`, `get_operational_scores`, `get_predictive_insights` — all wired to `command-center` (503 L, `hospital_admin` / `global_admin`)                                                                                                              | integration (**not run**)        | **VC**  |
| N4-02 | Financial command centre                                 | mig 47           | `get_financial_command_center`, wired to `financial-command-center` (190 L)                                                                                                                                                                                                                        | integration (**not run**)        | **VC**  |
| N4-03 | Reconciliation KPIs are correct                          | mig 34 / 47      | **Three independent defects in `get_reconciliation_summary`, all surfaced live at `financial-command-center:158`:** (a) `total_settled` is structurally always 0 — migration 34's own header documents and accepts this; (b) `net_outstanding` double-counts gross collection against its own fee splits and then subtracts SETURA's gateway/GST costs; (c) `booking_count = COUNT(DISTINCT b.id)` over ledger rows silently excludes ₹0 bookings | none                             | **BRK** |
| N4-04 | Revenue forecast                                         | mig 08 / 47      | **Two disagreeing implementations.** `mv_revenue_forecast` (`08:314`, refreshed nightly, **zero consumers**) and `get_revenue_forecast` (`47:1556`, the wired one) compute different things from different inputs. The wired version projects from `daily_collection_entries`, and because `trg_auto_create_collection` (mig 07) writes a DCE row for **every** booking with no WHEN clause, projections include unpaid bookings | none                             | **DUP** |
| N4-05 | Materialised-view analytics layer refreshed nightly       | mig 08 / 17      | Five MVs (`mv_daily_hospital_stats` `08:48`, `mv_doctor_performance` `08:154`, `mv_peak_hour_analysis` `08:239`, `mv_village_analysis` `08:275`, `mv_revenue_forecast` `08:314`) refreshed `CONCURRENTLY` in dependency order. **All five have zero consumers** — no edge function, RPC or test reads any of them; the only read is `mv_revenue_forecast`'s own body reading `mv_daily_hospital_stats` (`08:345`) | none                             | **PC**  |
| N4-06 | Dead-letter visibility                                   | mig 47           | `get_dlq_summary`, wired to `command-center`                                                                                                                                                                                                                                                      | none                             | **VC**  |
| N4-07 | MV refresh health visibility                             | mig 17 / 47      | `get_mv_refresh_health` (`17:653`) over `mv_refresh_log`, wired to `command-center`; 26-hour staleness flag                                                                                                                                                                                        | none                             | **VC**  |
| N4-08 | Alerting with suppression                                | mig 47           | `alert_activity_log` + `alert_suppressions` (mig 47) + `alert-center` (405 L). Actor authorisation is coherent: `role_permissions` (mig 27) grants `MANAGE_HOSPITAL` to both `global_admin` (`27:77`) and `hospital_admin` (`27:97`), so migration 48's actor checks do not lock the endpoint out | none                             | **VC**  |

**Set N4 tally:** VC 5 · PC 1 · UNP 0 · **BRK 1** · MIS 0 · SUP 0 · **DUP 1** · OOS 0 · NPD 0 = **8**

**Set N4 verdict:** The command-centre **plumbing is complete and correctly
gated** — every dashboard RPC has a real caller behind `resolveAuth` +
`requireRole`, which is more than can be said for most of the SQL surface. The
problem is the **numbers themselves**. N4-03 puts three defective KPIs in front of
hospital administrators, one of which (`total_settled` ≡ 0) was knowingly shipped
and documented as acceptable in migration 34's header. N4-04 gives the same
question two answers. N4-05 refreshes five materialised views nightly, with
correct `CONCURRENTLY` semantics and correct dependency ordering, that nothing
reads. For an "enterprise command centre" the operative risk is not absence of
features but **confident presentation of wrong figures** — a dashboard that is
silently incorrect is worse than one that is visibly empty.

---

## 14. SET N5 — EXECUTED "PHASE 1.5": PRIVILEGE HARDENING (12 requirements)

Source: migrations 48 and 49, `scripts/validate_migrations.ts`,
`tests/integration/privilege_isolation.test.ts`, `tests/unit/multi_role_auth.test.ts`,
and the `PHASE_1.5_*` reports.

Privilege categories as defined by the phase itself: **A** = 4 RLS helpers
(intentionally retain PUBLIC EXECUTE), **B** = 145 internal routines, **B-trigger**
= 10 trigger routines (excluded), **C** = 10 admin routines, **D** = 24
financial/security routines. Stated total **193**.

| ID    | Requirement                                                              | Earliest promise | Implementation / evidence                                                                                                                                                                                                                                                     | Test evidence                                          | Status  |
| ----- | ------------------------------------------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------- |
| N5-01 | Category A (4 RLS helpers) deliberately retain PUBLIC EXECUTE             | mig 48 §2        | `is_global_admin()`, `current_user_role(uuid)`, `user_has_hospital_access(uuid)`, `user_has_hospital_role(uuid,text[])` — correctly exempted; revoking them would break every RLS policy that calls them                                                                          | `privilege_isolation.test.ts` (not run)                | **VC**  |
| N5-02 | Category B (145 internal routines) not executable by `anon` / `authenticated` | mig 48 §6        | Root cause correctly identified by migration 48 §1: Supabase installs `ALTER DEFAULT PRIVILEGES … GRANT EXECUTE ON FUNCTIONS TO postgres, anon, authenticated, service_role`, which makes the **54 `REVOKE … FROM PUBLIC` statements in migrations 27–46 runtime no-ops** — they revoke PUBLIC while the grants are held by named roles. Migration 48 re-issues revocations against the named roles. Whether the live catalog reflects this **cannot be verified** (Docker down; `pg_proc.proacl` unreadable) | `privilege_isolation.test.ts` asserts it; **suite not run** | **UNP** |
| N5-03 | Category C (10 admin routines) restricted                                 | mig 48 §7        | Restrictions written; same verification limitation as N5-02                                                                                                                                                                                                                    | assertions exist; **not run**                          | **UNP** |
| N5-04 | Category D (24 financial / security routines) restricted                  | mig 48 §8        | Restrictions written; same verification limitation                                                                                                                                                                                                                             | assertions exist; **not run**                          | **UNP** |
| N5-05 | Trigger routines (10) excluded from revocation                            | mig 48 §5        | Exclusion is **correct and verified statically** — trigger functions are invoked by the executor, not by a role, so revoking EXECUTE would be either inert or harmful                                                                                                            | static verification                                    | **VC**  |
| N5-06 | An integration test proves the privilege boundary                          | PHASE_1.5 scope  | `privilege_isolation.test.ts` exists with real REVOKE assertions. **But 10 of the 11 test-only routines are covered *solely* by these REVOKE checks** — `calculate_refund_amount`, `change_subscription_plan`, `current_user_has_permission`, `generate_audit_log_partition_ddl`, `get_booking_fee`, `get_platform_revenue_breakdown`, `get_subscription_limits`, `get_subscription_usage`, `get_user_permissions`, `is_subscription_active`. A REVOKE assertion proves a routine is *not callable*; it proves nothing about whether it *works* | suite **not run**                                      | **PC**  |
| N5-07 | Validator gains a privilege-regression check                              | mig 48 / scripts | `scripts/validate_migrations.ts` check 7 `privilege-regression`, rules P1–P8. **Executed this audit: 49 files, 0 errors**                                                                                                                                                        | executed                                               | **VC**  |
| N5-08 | Privilege baseline pinned to prevent regression                            | scripts          | `PRIVILEGE_BASELINE = 48` enforced by the validator; CI runs it blocking                                                                                                                                                                                                        | executed                                               | **VC**  |
| N5-09 | **Claim: revocations "written out per routine rather than as a catalog loop"** | PHASE_1.5 report | **The claim is false for the bulk.** Migration 48 §6 — the 145-routine Category B pass — is a `DO $$ … $$` **catalog loop**. Measured explicit names: **42 REVOKE**, **46 GRANT**. The per-routine form was used for the smaller high-sensitivity categories only               | none                                                   | **PC**  |
| N5-10 | Authorization model is internally consistent                              | D-1              | **Three divergent resolutions coexist:** `has_permission()` **unions** all roles held at a hospital (most-privilege); `current_user_role()` reduces via `is_primary DESC, level ASC` (**least**-privilege); `_shared/auth.ts::selectRole()` **denies outright** when no row is primary. Both "same rule" doc claims — migration 49's comment and `auth.ts`'s header — are inaccurate. No cross-tenant escalation exists; the inconsistency is intra-tenant. D-1 is an open product decision | `multi_role_auth.test.ts` test 6 proves and documents the divergence | **NPD** |
| N5-11 | Authorization failures surface to clients as 403                          | mig 48 / edges   | `alert-center` wraps RPC errors in `InternalError`, so migration 48's `42501` insufficient-privilege errors reach the client as **HTTP 500 instead of 403**                                                                                                                       | none                                                   | **BRK** |
| N5-12 | The 193-routine classification is accurate and complete                   | PHASE_1.5 report | Independent recount finds **191 unique routines**, not 193. Of those, **41 have no caller anywhere** and **11 are referenced only by tests** — i.e. **52 of 191 ≈ 27 % of the SQL surface is unreachable from any product code path**                                              | derived from exhaustive call-path tracing              | **PC**  |

**Set N5 tally:** VC 4 · PC 3 · **UNP 3** · BRK 1 · MIS 0 · SUP 0 · DUP 0 · OOS 0 · **NPD 1** = **12**

**Set N5 verdict:** Phase 1.5 **correctly diagnosed a real and serious problem** —
that 54 `REVOKE … FROM PUBLIC` statements across migrations 27–46 had been
achieving nothing because Supabase's installed default privileges grant EXECUTE to
named roles rather than to PUBLIC. Identifying that is genuine security work, and
pinning `PRIVILEGE_BASELINE = 48` into a blocking CI check is the right way to
prevent recurrence. Two things must nonetheless be stated plainly. First, the
central claim — that the boundary now holds — is **UNPROVEN**, not false: it rests
entirely on `privilege_isolation.test.ts`, which this audit could not execute, and
`pg_proc.proacl` was unreadable. Second, one methodological claim in the phase
report is **demonstrably inaccurate** (N5-09: the 145-routine pass is a catalog
loop, not per-routine statements), and the routine count is off by two. Neither
undermines the security work; both matter under RULE 2, because they are the kind
of detail a reader would use to decide how much of the report to trust.

---

## 15. SET X — CROSS-CUTTING ARCHITECTURAL COMMITMENTS (15 requirements)

Source: `ARCHITECTURE.md` and the invariants mechanically enforced by
`scripts/validate_migrations.ts`. These commitments span every phase, so a breach
anywhere breaches the commitment.

| ID    | Requirement                                                                     | Earliest promise    | Implementation / evidence                                                                                                                                                                                                                                     | Test evidence                              | Status  |
| ----- | ------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------- |
| X-01  | **SQL-first** — edge functions never recompute business numbers                   | ARCHITECTURE.md     | Verified across all 26 functions: fees, ledger amounts, queue positions, SLA figures and settlement totals are all produced by SECURITY DEFINER RPCs. No edge function performs financial arithmetic                                                             | implicit throughout                        | **VC**  |
| X-02  | **Append-only** audit and ledger, enforced in the database                        | ARCHITECTURE.md     | `financial_ledger`: `prevent_ledger_mutation` + `trg_ledger_no_update` + `trg_ledger_no_delete`. Also immutable: `audit_logs`, `consultation_notes`, `queue_runtime_events`                                                                                      | ledger immutability tests                  | **VC**  |
| X-03  | **Tenant isolation** — no code path crosses hospitals                            | ARCHITECTURE.md     | RLS ENABLE + FORCE on tenant tables; `hospital_id` immutability triggers; every endpoint scopes through `resolveAuth`. No cross-tenant path found by inspection. (Catalog-level policy enumeration is separately UNPROVEN at F-08 / V-03)                          | `privilege_isolation.test.ts` (not run)    | **VC**  |
| X-04  | **Idempotency** on every externally-visible effect                                | ARCHITECTURE.md     | `idempotency_keys`; `enqueue_job` deterministic keys; `register_webhook_event_v2` payload hash; refund replay guard (R-07); `create_platform_revenue_summary` advisory lock + duplicate rejection                                                                | `whatsapp_lifecycle.test.ts`, `refund_sync.test.ts` | **VC**  |
| X-05  | **Every user-facing endpoint is authenticated and role-gated**                    | ARCHITECTURE.md     | **All 20 user-facing functions call `resolveAuth` + `requireRole`** — individually confirmed. Example: `verify-payment/index.ts:468-469` gates the frontend branch to `receptionist` / `hospital_admin` / `global_admin`                                          | integration coverage (**not run**)         | **VC**  |
| X-06  | **Every machine endpoint is authenticated by shared secret or HMAC**              | ARCHITECTURE.md     | Mostly true — `CRON_SECRET`, `WORKER_SECRET`, Meta HMAC all correctly applied. **Two defects:** `run-cron-nightly:296` sends `SUPABASE_SERVICE_KEY.slice(-20)` where `run-background-worker:301` expects `CRON_SECRET`; and `verify-payment:63` verifies Razorpay webhooks with `RAZORPAY_KEY_SECRET` instead of a webhook secret that does not exist in the codebase | none for either defect                     | **PC**  |
| X-07  | **Forward-only, non-destructive migration history**                              | validator P-rules   | Verified across all 49 migrations: **zero** destructive statements, **zero** `CREATE TABLE` without `IF NOT EXISTS`. Validator: 49 files, 0 errors                                                                                                              | executed                                   | **VC**  |
| X-08  | **Structured logging with no secret leakage**                                    | ARCHITECTURE.md     | 2 `console.*` calls repo-wide, both inside `_shared/logger.ts` (`:92`, `:94`). `webhook_signature.ts` does not log at all; the handler logs only a reason code — never the secret, the received signature, or the computed digest                                  | verified by exhaustive grep                | **VC**  |
| X-09  | Superseded routines are removed or documented as superseded                       | ARCHITECTURE.md     | **Four v1/v2 duplicate pairs retained with zero callers:** `claim_jobs`, `complete_job`, `fail_job`, `register_webhook_event`. All four v1 forms are live, callable definitions with no deprecation marker. The v1 `claim_jobs` is the one that *correctly* set `lease_expires_at` (`06:283`), making the retained-but-dead pair the proximate cause of I-06 | none                                       | **DUP** |
| X-10  | Every built subsystem is reachable from a product code path                       | ARCHITECTURE.md     | **52 of 191 routines (≈ 27 %) are unreachable** — 41 with no caller at all, 11 referenced only by tests. Includes whole subsystems: worker crash recovery (3 routines), subscription enforcement (4), GST-aware fee resolution (`get_booking_fee`), partition DDL generation | n/a                                        | **PC**  |
| X-11  | India-specific assumptions are explicit and documented                            | ARCHITECTURE.md     | Assumptions are pervasive and largely undocumented: INR-only amounts (`*_inr` column naming throughout), GST semantics, `+91` phone handling, IST-relative day boundaries in DCE and nightly logic, single-language templates. No locale, currency or timezone abstraction exists | none                                       | **PC**  |
| X-12  | **GST is charged on the booking fee per the fee policy**                          | mig 28 / 35         | **Contradictory.** The live resolver `get_effective_fees` v2 (mig 35) returns `total_amount = platform_fee + receptionist_fee` with **GST excluded** and `hospital_fee = 0`. The GST-aware `get_booking_fee` (mig 28) has **no caller**. `create-payment-order` charges `total_amount_snapshot` (GST-free) — yet `capture_payment` records a `gst_debit` ledger entry. So GST is booked but never collected | none                                       | **NPD** |
| X-13  | **Revenue is recognised only when collected**                                     | mig 07 / 13 / 33    | `trg_booking_ledger` (`13:479`) writes `platform_fee_credit` + `receptionist_incentive_credit` at **booking INSERT**; `trg_auto_create_collection` (mig 07) writes a DCE row for **every** booking with no WHEN clause; `create_platform_revenue_summary` (`33:176`) then settles those rows. WhatsApp bookings receive a non-zero `total_amount_snapshot` and **no payment order exists in any WhatsApp flow**, so revenue accrues against amounts that can never be collected | none                                       | **NPD** |
| X-14  | Daily collection entries count payments consistently                              | D-3                 | Carried as an explicit open product decision (D-3) in the Phase 1.5 recovery report. Interacts directly with X-13 and R-05 — partial refunds zero whole DCE rows, so DCE totals are not a reliable payment count under any interpretation | none                                       | **NPD** |
| X-15  | `system_settings` has a defined ownership and precedence model                    | D-4                 | Carried as an explicit open product decision (D-4). Seeded by `seed.sql` but with no documented precedence relative to `hospital_settings` or `feature_flags`                                                                                                    | none                                       | **NPD** |

**Set X tally:** VC 7 · PC 3 · UNP 0 · BRK 0 · MIS 0 · SUP 0 · **DUP 1** · OOS 0 · **NPD 4** = **15**

**Set X verdict:** The **structural** architectural commitments are met and are
the genuine strength of this codebase: SQL-first discipline is observed without
exception, immutability is enforced in the database rather than in application
code, all 20 user-facing endpoints are authenticated and role-gated, the migration
history is clean, and logging leaks nothing. Those are hard properties to achieve
and they were achieved.

The **financial-semantics** commitments are not met, and the four NPD rows are
not oversights — they are unresolved product questions with money attached.
X-12 and X-13 together mean the system currently **books revenue it never bills
for**: GST is debited to the ledger but excluded from every charge, and platform
and incentive revenue is credited at booking time including for WhatsApp bookings
that have no payment mechanism at all. No amount of engineering can settle these;
they need a ruling from the business, which is precisely why they are classified
NPD rather than BROKEN.

---

## 16. CONSOLIDATED TALLY — ALL 147 REQUIREMENTS

### 16.1 Per-set breakdown

| Set    | Scope                                    | Rows    | VC     | PC     | UNP    | BRK   | MIS    | SUP   | DUP   | OOS   | NPD   |
| ------ | ---------------------------------------- | ------- | ------ | ------ | ------ | ----- | ------ | ----- | ----- | ----- | ----- |
| **F**  | Phase 0 Foundation                       | 19      | 13     | 2      | 4      | 0     | 0      | 0     | 0     | 0     | 0     |
| **Z**  | Phase 0.5 Architecture Freeze            | 10      | 3      | 5      | 1      | 0     | 1      | 0     | 0     | 0     | 0     |
| **W**  | ROADMAP 1.1 WhatsApp Reliability         | 8       | 6      | 2      | 0      | 0     | 0      | 0     | 0     | 0     | 0     |
| **R**  | ROADMAP 1.2 Refund Consistency           | 8       | 2      | 0      | 1      | 3     | 2      | 0     | 0     | 0     | 0     |
| **T**  | ROADMAP 1.3 Retention                    | 5       | 3      | 2      | 0      | 0     | 0      | 0     | 0     | 0     | 0     |
| **S**  | ROADMAP 1.4 Subscription Platform        | 8       | 2      | 4      | 0      | 0     | 2      | 0     | 0     | 0     | 0     |
| **I**  | ROADMAP 2 Integration Hardening          | 12      | 5      | 2      | 0      | 2     | 3      | 0     | 0     | 0     | 0     |
| **V**  | ROADMAP 2.5 Enterprise Validation        | 8       | 0      | 1      | 2      | 1     | 4      | 0     | 0     | 0     | 0     |
| **C**  | ROADMAP 3 Incoming WhatsApp (descoped)   | 6       | 2      | 1      | 0      | 0     | 0      | 0     | 0     | 3     | 0     |
| **N1** | Executed 1.1 — Inbound WhatsApp          | 10      | 7      | 2      | 1      | 0     | 0      | 0     | 0     | 0     | 0     |
| **N2** | Executed 1.2 — Queue Runtime             | 10      | 10     | 0      | 0      | 0     | 0      | 0     | 0     | 0     | 0     |
| **N3** | Executed 1.3 — Retention & Usage         | 8       | 5      | 2      | 0      | 1     | 0      | 0     | 0     | 0     | 0     |
| **N4** | Executed 1.4 — Enterprise Command Centre | 8       | 5      | 1      | 0      | 1     | 0      | 0     | 1     | 0     | 0     |
| **N5** | Executed 1.5 — Privilege Hardening       | 12      | 4      | 3      | 3      | 1     | 0      | 0     | 0     | 0     | 1     |
| **X**  | Cross-cutting architectural commitments  | 15      | 7      | 3      | 0      | 0     | 0      | 0     | 1     | 0     | 4     |
|        | **TOTAL**                                | **147** | **74** | **30** | **12** | **9** | **12** | **0** | **2** | **3** | **5** |

Column check: 74 + 30 + 12 + 9 + 12 + 0 + 2 + 3 + 5 = **147** ✓
Row check: 19+10+8+8+5+8+12+8+6+10+10+8+8+12+15 = **147** ✓

### 16.2 The only defensible percentage, and its derivation (RULE 5)

> **74 of 147 audited requirements are VERIFIED COMPLETE = 50.3 %.**

Derivation, stated in full so the figure can be checked or rejected:

- **Numerator (74):** requirements where this audit independently confirmed all
  four of — an implementation exists; a live call path reaches it from product
  code; the runtime effect matches the requirement's wording; and evidence exists
  (executed command output, or a static trace closed at every layer).
- **Denominator (147):** every requirement extracted from committed artifacts for
  Phase 0 → 1.5, **including** the roadmap phases that were skipped (I, V) and the
  descoped phase that partly shipped (C). Nothing was removed for being
  inconvenient or superseded-by-silence (PART 20).

**This number must not be quoted as "SETURA is 50 % complete."** It is not a
measure of product completeness, effort, or code volume. Under RULE 5 the five
axes do not aggregate, and they diverge sharply:

| Axis                                     | Standing                                                                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Backend architecture completeness** | **Strong.** X-01…X-05, X-07, X-08 all VC. The intended architecture is real and consistently applied                                     |
| **B. Backend functional completeness**   | **Mixed.** N2 is 10/10; R is 2/8. Function-by-function, not phase-by-phase                                                                |
| **C. Security completeness**             | **Good design, unproven enforcement.** N1-01/02/03 exemplary; N5-02/03/04 UNPROVEN; X-06 PC; N5-10 NPD                                    |
| **D. Operational readiness**             | **Not achieved.** Nothing schedules the system (I-12); crash recovery inert (I-06); worker disabled by documented default                  |
| **E. Frontend / product completeness**   | **Out of audit scope** — no frontend exists in this repository                                                                            |
| **F. Production deployment readiness**   | **Not achieved.** No deploy artifact; JWT boundary unproven (N1-10); two credential defects (X-06)                                        |
| **G. Real-hospital readiness**           | **Not achieved.** Refund paths dead (R-04/05/06); revenue recognised without collection (X-13); dashboard KPIs wrong (N4-03)              |

### 16.3 Distribution of the 33 non-VC, non-OOS, non-NPD rows by root cause

Grouping the 9 BROKEN + 12 MISSING + 12 UNPROVEN rows by *why*, rather than by
phase, shows that a small number of causes account for most of the gap:

| Root cause                                                             | Rows affected                                                | Count |
| ---------------------------------------------------------------------- | ------------------------------------------------------------ | ----- |
| **No scheduler exists** — nothing invokes any cron or worker endpoint    | W-03, W-07, T-04, N1-07, N3-07, I-12, V-05                   | **7** |
| **Docker unavailable to this audit** — verification impossible          | F-01, F-02, F-03, F-11, V-03, N5-02, N5-03, N5-04, N1-10     | **9** |
| **Phase 2 / 2.5 never executed** — the hardening and proof phases       | I-01, I-02, I-03, V-01, V-02, V-04, V-06, V-07, V-08          | **9** |
| **`booking_fee_inr` has no runtime writer**                            | R-06, C-03                                                   | **2** |
| **Wrong credential used**                                              | R-04, I-07, X-06                                             | **3** |
| **Governance artifact never produced**                                 | Z-03, Z-10, F-04, F-05                                       | **4** |
| **Reporting more complete than behaviour**                             | N3-05, N3-06, N4-03, N4-05, T-05                             | **5** |
| **Enforcement never wired to metering**                                | S-03, S-04, S-05, S-06, S-07, S-08                           | **6** |
| **Lease column never populated by the v2 claim path**                  | I-06, V-06, X-09                                             | **3** |

(Rows appear under more than one cause where genuinely multi-causal; the table
explains the gap, it does not re-partition the 147.)

Two observations follow directly and are carried into
`NEXT_PHASE_READINESS_REPORT.md`:

1. **Nine of the twelve UNPROVEN rows would be resolvable in a single afternoon**
   with Docker running. They are not defects — they are unverified claims. No
   certification should be granted or revoked on them either way (PART 21).
2. **Fixing the scheduler alone would move 7 rows** and is the highest-leverage
   single action available. Fixing the `lease_expires_at` population would move 3
   more and is the highest-severity one.

### 16.4 PART 20 — requirements traced back to their earliest promise

Per the PART 20 instruction that a requirement is not retired merely because the
latest document stopped mentioning it, the following were promised early, never
delivered, and are **absent from every subsequent phase report**. Each is carried
forward as live debt, not closed:

| Requirement                                                    | First promised     | Last mentioned              | Status today |
| -------------------------------------------------------------- | ------------------ | --------------------------- | ------------ |
| `check_booking_limit()` + 429 quota enforcement                | `ROADMAP.md:~208`  | never again                 | **MIS**      |
| `create-booking` creates `payment_order` atomically            | `ROADMAP.md:~236`  | never again                 | **MIS**      |
| `run-cron-nightly` must NOT wake the worker                    | `ROADMAP.md:~248`  | never again — code does it  | **MIS**      |
| API contract freeze + diff                                     | `ROADMAP.md:53`    | `ROADMAP.md:~274`           | **MIS**      |
| Freeze amendment record for post-37 schema changes             | `ROADMAP.md:66`    | never again                 | **MIS**      |
| Integration matrix (8 workflows × 6 checks)                    | `ROADMAP.md:266`   | never again                 | **PC**       |
| Enterprise Validation Report                                   | `ROADMAP.md:291`   | never again                 | **MIS**      |
| DR test — worker crash mid-lease                               | `ROADMAP.md:~288`  | never again                 | **BRK**      |
| Performance benchmark p50/p95/p99                              | `ROADMAP.md:~284`  | never again                 | **MIS**      |
| `payment_status_detail` refund transitions                     | `ROADMAP.md:~130`  | never again                 | **MIS**      |

**Ten early commitments are silently outstanding.** None was formally descoped;
each simply stopped being discussed after the phase renumbering described in
`ARCHITECTURAL_DRIFT_REGISTER.md` D-01.

---

## 17. CROSS-REFERENCES

- Severity assignment (P0–P3) for every BRK / MIS / DUP row: **`CROSS_PHASE_GAP_REGISTER.md`**
- Drift items (phase renumbering, freeze breach, PostgreSQL version, duplicated orchestration): **`ARCHITECTURAL_DRIFT_REGISTER.md`**
- Claim-by-claim reconciliation of the seven `PHASE_*` reports plus `CROSS_CHECK_REPORT.md`, `AUDIT_REPORT.md`, `SETURA_CLAUDE_REPORT.md`: **`CERTIFICATION_RECONCILIATION.md`**
- Gate conditions for the next phase: **`NEXT_PHASE_READINESS_REPORT.md`**
- Full narrative audit, PARTs 1–24 and 28: **`CROSS_PHASE_AUDIT_REPORT.md`**

**No source code, migration, test, configuration file or pre-existing document was
modified in the production of this matrix (RULE 1).**





