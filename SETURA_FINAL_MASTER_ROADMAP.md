# SETURA FINAL MASTER ROADMAP

**Status:** AUTHORITATIVE — the single roadmap followed from this point onward.
**Date:** 2026-09-02
**Basis:** five parallel domain investigations (hospital core, async infrastructure, financial/comms, security/platform, verification-ledger distillation) reconciled against direct source verification of 49 migrations, 26 Edge Functions, 16 test files, the Graphify structural report, the Phase 1.6 / Gate 3R evidence base, and `CROSS_PHASE_GAP_REGISTER.md` (the canonical finding register: 4 P0 · 13 P1 · 15 P2 · 10 P3 · 6 NPD = 48 entries).

**Evidence caveat that governs this whole document.** Docker/runtime was unavailable on this machine during investigation, so no fresh runtime probing occurred. Every claim below rests on (a) direct source/migration inspection, and (b) the recorded Phase 1.6 / Gate 3R runtime evidence — including the Gate 3R Step-2 suite result (11 files, 162 tests, 151 pass / 11 environment-fail), which is **project-lead assertion, not a re-readable log** (the suite log is absent from the repository — recorded in `PHASE_1.6_GATE_3R_POE_2.md` §3). Where "PROVEN" is used, it means proven at one of those levels, never at production. The repository is not a Git repository; CI reachability is unmeasurable from this tree.

---

## 1. EXECUTIVE SUMMARY

SETURA is a **substantially implemented, locally security-verified hospital backend that cannot yet run itself, cannot yet refund money correctly, and has no user-facing client**. It is not a prototype — the depth of the SQL layer (139 live RLS policies, 213 SETURA-owned routines, immutable financial ledger, atomic token engine, append-only audit) is production-grade engineering — but it is also not a deployable product, for four reasons that no amount of existing code fixes by itself:

1. **Nothing executes autonomously.** No scheduler exists (P0-02) and the deployed default configuration (`ENABLE_WORKER_TRIGGER=false`, P0-03) means the background worker never runs. Of 157 historically pending jobs, zero were ever claimed. The worker's crash-recovery path is dead in **both** its v1 and v2 forms (P0-01), its dead-letter insert references a column that doesn't exist (`19:741` inserts `job_id`; `06:166` defines `original_job_id`), and `run-cron-nightly` triggers the worker with the **wrong secret** (`run-cron-nightly/index.ts:296` sends `SUPABASE_SERVICE_KEY.slice(-20)`; the worker expects `CRON_SECRET` → guaranteed 401).
2. **Refunds compute ₹0 for every booking created after migration 28.** `bookings.booking_fee_inr` has no runtime writer — the only writer in 49 migrations is migration 28's one-time backfill; `idempotent_create_booking` (migration 16) resolves fees but passes only `platform_fee`/`receptionist_fee`/`hospital_fee` into `create_booking`; and `calculate_refund_amount` (`29:201`) reads `booking_fee_inr` as the refund basis (P0-04 — confirmed by direct source verification, upgraded from "reporting gap" to refund-path defect).
3. **There is no frontend.** Zero client code exists; CORS hardcodes `setura.in`. Receptionists, doctors and administrators have nothing to open. Whatever else is true, a hospital OS with no console cannot be piloted by staff.
4. **It has never been deployed.** No deploy pipeline, no `[functions]` config, unknown production JWT boundary (P1-09/NPD-05), production privilege state UNPROVEN, live Razorpay/Meta paths untested by design locally.

Against that: the **hospital core loop is genuinely proven** at integration level — booking state machine with idempotency and terminal guards, atomic token allocation (upsert conflict-arbiter), queue runtime with 5-way concurrent advance and skip/recall/restore races (952-line test), doctor workflow with immutable consultation notes and single-active-consultation (the only Edge Function tested over real HTTP, 1245-line test), deterministic WhatsApp conversational engine (25+ tests, canonical-RPC reuse, no LLM), and a financial ledger whose immutability is enforced by trigger + `WITH CHECK(false)` RLS. The security boundary was verified at catalog **and** runtime locally (179 locked routines confirmed denied via SQLSTATE 42501; 22/22 privilege tests). This is a strong foundation — the shortest safe path is to **fix the execution chain, prove it through three behavioral gates (W1/E1/S1), settle six product decisions, build the staff console, and deploy** — not to rewrite anything.

**Headline numbers:** 49 migrations · 26 Edge Functions · 16 test files (5 unit / 11 integration, 162 declared integration tests) · 191 unique SQL routines, 52 of which (~27%) have no product caller (P2-11) · 479 public routines of which 213 SETURA-owned · 139 live RLS policies · 4 P0, 13 P1, 15 P2, 10 P3, 6 NPD open findings — of which Gate 3R's runtime run directly tested approximately **1 of the 17 P0/P1 findings** (P1-11, partial). Everything else on the critical list is UNFIXED and UNPROVEN at runtime.

**The shortest safe path, in one line each** (§11 has the full ordering):
fix the confirmed execution defects → pass gate W1 (worker lifecycle) → decide + install the scheduler (NPD-05) → pass gate E1 (hospital journey incl. partial refunds) → pass gate S1 (security hardening) → build the staff frontend → production readiness → pilot.

---

## 2. VERIFIED CURRENT STATE

Classification uses exactly seven categories: **COMPLETE/PROVEN** · **IMPLEMENTED BUT UNPROVEN** · **PARTIALLY IMPLEMENTED** · **BROKEN** · **BLOCKED** · **NOT IMPLEMENTED** · **DEFERRED**. "PROVEN" always means at the highest evidence level actually achieved (integration test against the real local stack, or recorded Gate 1–3R runtime measurement) — never production.

### 2.1 Subsystem classification

| Subsystem | Category | Basis (file:line where load-bearing) |
|---|---|---|
| Booking state machine + idempotency | **COMPLETE/PROVEN** | Canonical TS machine `_shared/booking_state.ts`; idempotency_key UNIQUE; terminal-state guard; proven by queue/doctor/WhatsApp integration tests. Caveat: transitions live only in TypeScript — no SQL CHECK/trigger equivalent (accepted design, monitor for drift) |
| Token engine (`generate_next_token`) | **COMPLETE/PROVEN** (with one open race) | Atomic `INSERT ON CONFLICT DO UPDATE … RETURNING` (`02:31-64`), UNIQUE (queue_session_id, token_number); 5-way concurrency proven. Open: `create_booking` RPC's lookup→allocate→insert window (`02:446-562`) is not single-transaction — a crash can orphan a consumed token |
| Queue runtime + control (pause/resume/recall/skip/restore/mark_absent/call) | **COMPLETE/PROVEN** | Idempotent via deterministic event keys; append-only `queue_runtime_events`; `evaluate_queue_health` 5 alert conditions; 952-line integration test incl. skip-vs-terminal race |
| Doctor clinical workflow | **COMPLETE/PROVEN** | `consultation_notes` immutable (pg_trigger_depth exception, service-role-only `46:984-988`); `uq_one_active_consultation_per_doctor`; doctor-operations is the only Edge Function tested over real HTTP (1245-line test) |
| WhatsApp conversational engine (intent routing, flows, dedup, state) | **COMPLETE/PROVEN** | Deterministic keyword router (no LLM, by design); booking/cancel/reschedule flows reuse canonical RPCs (`create_booking`, `initiate_refund`, `recalculate_queue_position`); 25+ conversational tests incl. replay + tenant isolation |
| WhatsApp webhook signature verification | **COMPLETE/PROVEN** | Fail-closed 4-reason check; 16/16 unit tests incl. RFC 4231 vector; never returns 200 on bad signature |
| WhatsApp outbound queue (claim, backoff, reconciliation) | **COMPLETE/PROVEN** | SKIP LOCKED claim, exponential backoff `POWER(2, retry_count)`, permanent-fail codes, delivery reconciliation; 8 lifecycle tests incl. worker-secret 403 and tenant isolation |
| WhatsApp actual delivery to Meta | **IMPLEMENTED BUT UNPROVEN** | Real `graph.facebook.com` v19.0 calls exist; no live-path test (by design locally); production HMAC untested |
| Financial ledger | **COMPLETE/PROVEN** | Immutable by trigger (`prevent_ledger_mutation` `13:391-404`) + RLS `WITH CHECK(false)` (`13:957-960`); reconciliation summary consistent |
| Payment engine — DB side (orders, capture, webhook dedup) | **COMPLETE/PROVEN** | Dual-path HMAC verification, constant-time compare, all webhooks 200 (retry-safe), verified by SQL-direct integration tests |
| Payment engine — Razorpay live HTTP | **IMPLEMENTED BUT UNPROVEN** | REAL HTTP in create-payment-order (`:64-102`) and process-refund (`:65-76`); immediate `confirm_refund_processed` if status="processed" (`:288-295`); live gateway untested by design; P1-01 secret-naming, P1-03 discarded boolean |
| Refund engine | **PARTIALLY IMPLEMENTED** | Full refunds correct. Partial refunds over-zero the whole DCE row (migration 41 zeroes entire row on any refund), undercount platform revenue in settlement summaries (`33:224-228` sums zeroed DCE); refund basis inconsistent across 3 paths (P1-10); `payment_status_detail` refund transitions have no writer (P1-08); and P0-04 makes `calculate_refund_amount` return ₹0 for all post-migration-28 bookings |
| Settlement engine | **PARTIALLY IMPLEMENTED** | Platform-revenue-summary model implemented (migration 33 semantic shift — record-settlement-payment is a deliberate NO-OP `33:146-163`); D-3 fix verified in enterprise tests; but `record_payment` endpoint always HTTP 500 (P1-04) and partial-refund undercount stands |
| Subscription / usage | **PARTIALLY IMPLEMENTED** | Accounting-only by design: 4 plans seeded, auto-trial trigger, atomic usage recording with month rollover (`40:30-146`); `change_subscription_plan` never charges; `razorpay_subscription_id` unused; plan limits unenforceable (P2-01) |
| Hospital configuration / fee engine | **PARTIALLY IMPLEMENTED** | `get_effective_fees` (mig 12→35) is the live resolver but excludes GST; GST-aware `get_booking_fee` (mig 28) has **no caller** (P2-11/NPD-01); `booking_fee_inr` never written at runtime (P0-04); extended-hours override doesn't refresh daily capacity in `get_remaining_token_capacity` (cross-file drift, UNPROVEN) |
| Background worker — happy-path execution loop | **IMPLEMENTED BUT UNPROVEN** | Full loop implemented (claim v2, lease rows, heartbeat 10s, MAX_RUNTIME 115s, batch 5); **no test anywhere proves claim→execute→complete end-to-end** |
| Background worker — crash recovery | **BROKEN** | v2: `claim_jobs_v2` never sets `lease_expires_at` (`19:535-547`); `reclaim_crashed_worker_jobs` needs `detect_crashed_workers()` which has **zero callers**; `run_worker_crash_recovery` never called. v1: `reclaim_stale_jobs` (`06:474`) filters `lease_expires_at < now()` so v2's NULL rows never match, and its only caller is unscheduled. Dead in both paths (P0-01, worse than the register records) |
| Background worker — dead-lettering | **BROKEN** | `fail_job_v2` inserts `job_id` (`19:739-746`) into a table whose column is `original_job_id` (`06:166`, NOT NULL UNIQUE); no RENAME/ALTER exists in any migration (exhaustive grep). Any retry-exhausted job **fails its dead-letter insert** |
| Job types | **PARTIALLY IMPLEMENTED** | `create_partition` is declared (`run-background-worker/index.ts:34`) but has no switch case (`:411-431`) → throws "Unsupported job type"; partitions are never created at runtime (`is_auto_enabled` false). Two competing dead-letter tables exist (06 vs 14) with only v2 having a retry path |
| Scheduler | **NOT IMPLEMENTED** | Stronger than "inactive": `pg_cron` available but not installed (`installed_version` NULL), zero `pg_net` scheduling, no external scheduler, no deploy config. Nothing in SETURA runs periodically (P0-02, design decision NPD-05 pending) |
| Retention / cleanup | **PARTIALLY IMPLEMENTED** | `run_retention_cleanup` is a stub (`23:294-321`); 24 seeded retention policies are inert |
| Nightly maintenance | **PARTIALLY IMPLEMENTED + 2 defects** | `run-cron-nightly` reimplements SQL `run_nightly_tasks` in TypeScript (P2-12 — the SQL version is dead); Step 9 triggers the worker with the wrong secret (P1-07) — which is also a documented architecture violation (P2-09: fixing the secret alone would *activate* the prohibited nightly worker wake) |
| Analytics / rollups / SLA | **IMPLEMENTED BUT UNPROVEN** | `compute_sla` job handler, `refresh-rollups`, debounced SLA refresh, queue-health alerts all implemented; nothing schedules them, so no runtime proof; command-center read paths are separately proven |
| Enterprise reporting / command centers | **COMPLETE/PROVEN** | Thin RPC pass-throughs over live tables; full-HTTP integration tests: dashboards, 8 report types, alerts, broadcasts, D-3 integrity, auth gates (worker-independent read path) |
| Alert center | **PARTIALLY IMPLEMENTED** | `fire_alert` has no scheduled evaluator; authorization errors surface as 500 not 403 (P3-01) |
| API idempotency registry (migration 25) | **PARTIALLY IMPLEMENTED** | Seeded with 9 endpoints but **unused by any Edge Function**; booking/webhook/job dedup (which is used) is separately proven |
| AuthN / AuthZ / RLS / privilege boundary | **COMPLETE/PROVEN locally** | `resolveAuth()` least-privilege fail-closed; 139 live policies; Gate 2 census: 179 locked routines confirmed denied at catalog (`proacl`) and runtime (SQLSTATE 42501); `privilege_isolation` 22/22 twice. Caveats: F16-05 (test can accept a JWT-layer 401 as denial proof on the authenticated half — boundary itself separately proven), F16-06 (~47/179 ≈ 26% denial coverage), production state UNPROVEN |
| Audit system | **COMPLETE/PROVEN** | Trigger-enforced immutability; audit_reliability unit tests |
| Worker/queue tenancy | **COMPLETE/PROVEN** | FORCE RLS on job_queue (hospital_admin/global_admin) and dead_letter_jobs (global-admin only) (`06:488-532`) |
| Secrets management | **NOT IMPLEMENTED (as deployment practice)** | No `.env` exists locally (correct); `.env.example` defaults deploy a non-processing system (P0-03); production secret provisioning undefined |
| Frontend (any client) | **NOT IMPLEMENTED** | No client code of any kind; CORS hardcodes `setura.in` |
| CI/CD | **PARTIALLY IMPLEMENTED** | Quality + stack jobs exist; integration suite not in CI; no deploy job; unmeasurable from this non-Git tree |
| Observability | **PARTIALLY IMPLEMENTED** | Metrics/tracing/request-logger code exists in `_shared`; `monitoring-health-check` endpoint exists; `SENTRY_DSN` never initialized; no scheduled health evaluation |
| Privilege-hardening mechanism (F16-04) | **PARTIALLY IMPLEMENTED** | Migration 48's fail-closed default-privilege guarantee does not hold (PUBLIC never revoked; `supabase_admin` grantor rows skipped); migration 49's four functions are safe only because `CREATE OR REPLACE` preserved prior ACLs. **Standing obligation:** every new/re-signatured SECURITY DEFINER function needs its own explicit REVOKE, verified in the catalog |

### 2.2 Test estate (what the 16 files actually prove)

- **Proven over real HTTP:** `doctor_operations.test.ts` is the **only** test exercising Edge Functions over HTTP; `enterprise_command_center.test.ts` also full-HTTP; `local_stack.test.ts` is smoke-only and does NOT exercise Edge Functions.
- **Proven SQL-direct:** queue runtime (concurrency, races), WhatsApp lifecycle + conversational (all flows, replay, tenant isolation), refund sync (full refunds only), usage/retention, multi-role auth (real JWTs).
- **Unit-only:** signature verification, errors, validation, response, audit reliability.
- **Never tested anywhere:** worker claim→execute→complete; retry→dead-letter; crash recovery; scheduler invocation; retention execution; partition creation; partial refunds; live gateway paths (by design); the 401-vs-42501 distinction (F16-05); ~74% of locked-routine denial paths (F16-06).
- Gate 3R Step-2 (11 files / 162 tests / 151 pass / 11 environment-fail) is **assertion-based evidence** — the suite log is absent (PoE-2 §3). The 11 failures were classified environment (Edge Runtime conditions, F16-01), not product.

### 2.3 Contradictions resolved (old reports vs current evidence)

The ledger distillation confirmed ten contradictions between historical reports and verified evidence; the roadmap adopts the **evidence side** in every case. The material ones: "34/0 security regression" is phantom arithmetic (real count 22); "193 RLS policies" is actually the SECURITY DEFINER routine count and 191 unique routines (live policy count is 139); "~85% production-ready" overstates (74/147 = 50.3% requirements VERIFIED COMPLETE); `CROSS_CHECK_REPORT`'s "lease reclaim works" is withdrawn (P0-01 proves the opposite); "3 pre-existing warnings" became 4 after migration 47; P2-09's description in the Readiness Report mischaracterized a ROADMAP prohibition violation as a CHECK-constraint issue (recorded as DOC-01 for Gate 8). **Register scheme (`CROSS_PHASE_GAP_REGISTER.md`) is canonical for all IDs**; the Audit/Readiness reports' internal P1 numbering collides on 10 of 13 IDs and must not be cited (see `FINDING_ID_RECONCILIATION.md`).

---

## 3. ARCHITECTURE MATURITY

| Layer | Maturity | Assessment |
|---|---|---|
| Data layer (schema, RLS, triggers, ledger, state data) | **Strong — production-grade** | Deepest layer; immutability and tenancy enforced in the database, not the app. 139 live policies; SECDEF RPC boundary deliberately locked down |
| Business-logic placement (SQL-first) | **Strong** | Edge Functions are thin orchestration over RPCs; WhatsApp flows reuse canonical RPCs rather than duplicating. Keep this shape |
| Hospital core domain | **Strong, proven** | State machine, tokens, queue, doctor workflow all integration-proven |
| Financial domain | **Mixed** | Ledger itself excellent; the *derivations* above it (DCE, settlement summaries, refund basis) have a cluster of interlocking defects (P0-04, P1-02/03/04/05/06/08/10) rooted in two undecided product questions (NPD-02 revenue recognition, NPD-03 DCE semantics) |
| Async/execution layer | **Weak — the critical gap** | Code-rich (v1+v2 engines, leases, heartbeats, recovery routines) but the *wiring* is broken: nothing schedules, nothing triggers, recovery uncalled, dead-letter insert fails. ~27% of routines have no caller (P2-11) — unreachable code is where defects survive |
| Integration surface (Edge API) | **Medium** | 26 functions, consistent shared helpers, but machine endpoints have an undecided production auth boundary (P1-09/NPD-05) and no rate limiting |
| Client layer | **Absent** | No frontend of any kind |
| Ops (deploy, config, monitoring, secrets) | **Immature** | No deploy artifact, no monitoring initialization, secrets undefined for production |
| Test discipline | **Good where it exists** | Real-stack integration-first, no mocks-for-convenience — but coverage is misaligned with failure modes (P2-14: the suite doesn't cover the paths that fail — worker, refunds-partial, scheduler) |

**Architectural verdict:** the platform's *shape* is right and must not be rewritten. The gap is not architecture — it is **execution wiring, financial derivation correctness, six product decisions, and the missing client layer**.

---

## 4. CRITICAL BLOCKERS

Ordered by how many downstream capabilities each one blocks.

**B1 — The execution chain is dead (P0-01 · P0-02 · P0-03 · P1-07 · dead-letter insert · create_partition orphan).** No scheduler exists; the deployed default never triggers the worker; the nightly trigger uses the wrong secret; even with a trigger, crash recovery is dead in both v1/v2 paths and retry-exhausted jobs crash their own dead-letter insert; one declared job type throws on arrival. Every capability that depends on asynchronous processing — WhatsApp delivery, SLA computation, rollup refresh, reminders, retention, analytics — is **implemented but can never execute**. This is the single highest-leverage blocker: fixing it activates an entire already-built subsystem. Note the trap: fixing the wrong secret alone would activate the P2-09 prohibited behavior — resolve the two together.

**B2 — Refunds compute ₹0 for all new bookings (P0-04 chain).** `booking_fee_inr` has no runtime writer; `calculate_refund_amount` reads it as the refund basis; two of three refund paths always compute zero (the register independently recorded the third, basis-inconsistency, as P1-10). Any real patient money refunded today is refunded wrong — ₹0 — regardless of what was paid. Compounded by partial-refund over-zeroing (P1-02) and missing refund-status writers (P1-08).

**B3 — No frontend.** No staff console, no doctor console, no admin console, no patient app. Blocks pilot entirely (WhatsApp can carry patients, but staff cannot run a hospital through raw HTTP).

**B4 — Six product decisions pending (NPD-01 GST · NPD-02 revenue recognition · NPD-03 DCE semantics · NPD-04 multi-role resolution · NPD-05 JWT/scheduler boundary · NPD-06 settings precedence).** Each one blocks a cluster of otherwise-mechanical fixes: NPD-01/02/03 gate the financial-correctness wave; NPD-05 gates the scheduler **and** the machine-endpoint auth boundary; NPD-04 (three coexisting role-resolution answers, intra-tenant only) gates authorization cleanup.

**B5 — Never deployed (P1-09 · production privileges UNPROVEN · no deploy pipeline · secrets undefined).** Local verification must not be converted into production certification; production privilege state is unmeasured.

**B6 — Standing privilege obligation unowned (F16-04).** Every new or re-signatured SECURITY DEFINER function needs its own explicit REVOKE with catalog verification. Until this is a checklist step + CI check, every future migration silently re-opens the hole migration 48 attempted to close.

**B7 — Test-coverage misalignment (F16-05 · F16-06 · P2-14).** The suite proves the happy paths and misses exactly the paths that fail (worker lifecycle, partial refunds, scheduling, 401-vs-42501). Fixing coverage is what prevents regression of everything above.

Non-blockers explicitly de-dramatized: the 11 Gate-3R environment failures are Edge Runtime container policy (F16-01), not product code; `fmt:check` fails only on 8 root audit markdown files, cosmetic; the 4 duplicate-object migration warnings are pre-existing and recorded.

---

## 5. FINAL TARGET ARCHITECTURE

**The target is the current architecture, completed — not replaced.** No parallel systems, no rewrites, no framework changes.

1. **SQL-first unchanged.** Edge Functions stay thin: auth → validation → orchestration → canonical RPC → database invariant. All new logic goes into RPCs/tables/triggers; no business rules in Edge Functions.
2. **Execution model:** one worker engine (v2), one queue, one scheduler. The v1 engine's live remnants are either wired in or removed (P2-13 superseded RPCs). Scheduler choice is a recorded decision (§11 Phase 3): recommended **pg_cron + pg_net inside the Supabase stack** calling the machine endpoints with HMAC secrets — least new infrastructure, uses what the image already carries. Alternative: external platform cron hitting the same endpoints. Either way: **one** trigger path, secrets via platform secret store, never in repo.
3. **Financial model:** ledger stays immutable and append-only forever; DCE/settlement/refund derivations become deterministic functions of (payment, refund) events with partial-refund proportionality; NPD-02/03 rulings recorded in a governance doc and encoded once.
4. **Client layer (new):** a staff web console (receptionist + doctor + admin roles) over the existing Edge API, plus the already-proven WhatsApp channel for patients. The console reuses the same RPCs — it adds no backend logic.
5. **Security posture:** current privilege boundary (179 locked) is the baseline; F16-04 REVOKE obligation becomes an automated CI check (`has_function_privilege` catalog probe); JWT boundary decided once and recorded in `config.toml`.
6. **Worker lifecycle as a first-class product surface:** metrics on claim/execute/dead-letter/recovery counts; health endpoint reflects actual worker heartbeats (already reads `worker_job_leases`).

---

## 6. FINAL PHASED ROADMAP

Phases are dependency-ordered, not template-ordered. The historical 8-phase template is direction only — where it diverges (notably: frontend late, financial correctness before frontend), actual dependency order wins. Every phase ends at a gate or a recorded decision — no open-ended phases. Workstreams inside each phase are grouped; each item carries its canonical register ID.

### Phase 0 — Confirmed-defect hotfixes (decision-free, ~days)
**Goal: eliminate the statically-confirmed mechanical defects before any runtime proof work.**
- Fix `fail_job_v2` dead-letter insert (`19:739-746`): insert `original_job_id` (additive migration redefining the function — never edit migration 19).
- Resolve `create_partition` orphan: implement the switch case calling the existing partition-DDL routine (it currently has no caller — P2-11), **or** stop enqueueing the job type; whichever is chosen, partitions-at-runtime becomes a deliberate, tested behavior.
- Resolve P1-07 + P2-09 **together**: remove the prohibited Step-9 worker trigger from `run-cron-nightly` (nightly stays synchronous per the frozen constraint) and record the resolution in a governance doc — this kills the wrong-secret bug by removing its only use, rather than fixing the secret and activating forbidden behavior.
- Fix `settlement-engine` `record_payment` always-500 (P1-04).
- Fix `claim_jobs_v2` to populate `lease_expires_at` consistent with `worker_job_leases` (P0-01 mechanical half).
- **Exit criteria:** all fixes merged with targeted integration tests; static gates (`validate:migrations`, `lint`, `check`, unit) green; no behavior change beyond the fixes. *(Scheduler choice, worker trigger enablement, and crash-recovery wiring wait for Phase 1/3 — they are decisions, not hotfixes.)*

### Phase 1 — Worker lifecycle proof (Gate W1)
**Goal: prove the worker actually executes end-to-end, then that it survives failure.**
- Wire crash recovery: give `detect_crashed_workers` / `reclaim_crashed_worker_jobs` a real caller in the worker/minute path (P0-01 wiring half); retire or wire the dead v1 `reclaim_stale_jobs` call in `run_scheduled_tasks`.
- Single-queue truth: reconcile the two dead-letter tables (06 `dead_letter_jobs` vs 14 `dead_letter_queue`) — one canonical, one removed (P2-13-adjacent).
- Build the missing tests (P2-14): claim→execute→complete; handler failure→retry→dead-letter (now that the insert works); killed-worker→reclaim; duplicate job dedup; job-type coverage for every declared type.
- **Gate W1 (see §7) — exit criteria: PASS against the real local stack with Edge Runtime verified running (not exit-code, F16-01).**

### Phase 2 — Scheduler decision + autonomous operation (NPD-05, P0-02, P0-03)
**Goal: SETURA runs itself.**
- Make the NPD-05 ruling: pg_cron + pg_net (recommended) vs external scheduler — recorded in a governance doc with the JWT-boundary decision (they are the same surface: machine endpoints + their auth).
- Install/enable the scheduler; wire minute + nightly invocations; record the `verify_jwt` decision for the 7 machine endpoints in `config.toml` (P1-09).
- Set `ENABLE_WORKER_TRIGGER=true` in the *deployment* config (P0-03) with the trigger path proven by W1; define production secret provisioning.
- Complete `run_retention_cleanup` (currently a stub) and prove the 24 seeded policies actually purge (retention).
- **Exit criteria:** ≥24h unattended local run: minute/nightly fire at intended frequency, downstream jobs execute, worker processes them, retention purges, no manual intervention; failure/retry behavior proven by injection.

### Phase 3 — Financial correctness wave (P0-04 chain, P1-01/02/03/05/06/08/10, P2-10; needs NPD-01/02/03 rulings — schedule the rulings at phase start)
**Goal: every rupee in/out is computed correctly, including partial refunds.**
- Write `booking_fee_inr` at booking creation (P0-04): route the GST-aware `get_booking_fee` (currently caller-less) or `get_effective_fees` output into the persisted column, per the NPD-01 ruling; unify the three refund bases (P1-10) onto the persisted value.
- Partial-refund proportionality (P1-02): DCE adjustment proportional to refund amount; settle the NPD-03 DCE semantics first (what a row counts as).
- Refund status writers (P1-08); `idempotent_capture_payment` boolean handling (P1-03); reconciliation KPI fixes (P1-06); Razorpay webhook secret naming (P1-01); WhatsApp bookings without payment orders — either payment-link flow or recorded walk-in-unpaid design (P1-05/P2-10, depends on NPD-02 revenue-recognition ruling).
- **Exit criteria:** partial-refund integration tests (currently only full refunds are tested) pass; a refund of ₹50 against ₹200 leaves correct DCE, ledger, settlement summary, and platform revenue; reconciliation KPIs match hand-computed values.

### Phase 4 — Hospital journey proof (Gate E1)
**Goal: prove the complete product loop, not its parts.**
- Close the `create_booking` token-allocation race (single-transaction allocation via the proven atomic upsert).
- Fix the extended-hours/daily-cap drift in `get_remaining_token_capacity`.
- Build the E1 full-journey integration test (§7) spanning HTTP entry points, the now-proven worker (W1), and the now-correct financial legs (Phase 3).
- **Gate E1 — exit criteria: PASS.**

### Phase 5 — Security hardening (Gate S1)
**Goal: the boundary is proven, not assumed — and stays proven.**
- F16-04: explicit REVOKEs for migration 49's four functions + a CI catalog check (`has_function_privilege`) making the REVOKE obligation automatic for every future SECDEF function.
- F16-05: `assertRpcDenied` requires SQLSTATE 42501 (not any 401); F16-06: extend locked-routine denial coverage from ~26% toward ≥80% of Category B/C/D.
- P1-12 `is_primary` provisioning lockout (test it — seed currently masks it); P1-13 `profiles.is_active` honored by `has_permission()`; NPD-04 multi-role resolution ruling (one answer, recorded, encoded).
- Rate limiting on `verify-payment` webhook and auth-adjacent endpoints (currently fail-open on create-booking only); P3-01 (42501 → 403 in alert-center).
- **Gate S1 — exit criteria: PASS.**

### Phase 6 — Staff frontend (the client layer)
**Goal: a hospital can actually operate SETURA.**
- Build the staff web console over the existing Edge API: receptionist terminal (walk-in, check-in, queue view, billing), doctor console (today's queue, consultation, notes, history), admin console (config, users, monitoring) — one codebase, role-routed.
- No backend logic additions beyond what Phase 0–5 already fixed; if a gap appears, it goes into RPCs, not into the client.
- **Exit criteria:** E1's full journey executable **through the console** against the local stack by a non-engineer; WhatsApp patient channel and console staff flows interoperate (a WhatsApp booking is visible/actionable in the console, and vice versa).

### Phase 7 — Production readiness + pilot
**Goal: deployed, monitored, pilot-able.**
- Deploy pipeline (CI currently has none); production secrets provisioning; Sentry/monitoring initialization; backup/DR; load test on the queue+worker path; **production** privilege catalog verification (the local 179-locked census must be re-measured against the deployed database — local verification must never be converted into production certification).
- Gate 8: register allocation for all F16-NN/GOV-NN/OBS findings (P0–P3 prefix assignment is itself a severity decision and is reserved to Gate 8).
- P2/P3 hygiene swept in (stale comments F16-07, ARCHITECTURE.md version, unused config knobs, unreachable-routine cleanup per P2-11 where no Phase 1–5 caller was added).
- **Exit criteria: §9 checklist green → pilot hospital onboarded with real tenants, real money, real WhatsApp — under explicit "pilot, not certified" labeling until 30 days of clean operation.**

---

## 7. BEHAVIORAL GATES

Three gates, explicit acceptance criteria, no gate passes on partial evidence. **Never convert BLOCKED into PASS; never convert "looks correct" into PASS.** All gates run against the real local stack with Edge Runtime verified actually running (F16-01: exit codes lie). Evidence must be persisted (suite log committed to the repo — the PoE-2 gap never repeats).

### W1 — Worker Lifecycle Gate
Proves: **create job → claim → lease → execute → retry → dead-letter → restart recovery.**
1. A job enqueued via the real queue is claimed by a real worker within one poll interval and transitions ENQUEUED→CLAIMED→PROCESSING→COMPLETED, observable in `job_queue` + `worker_job_leases`/heartbeat.
2. A handler that always fails, retried to exhaustion, lands in `dead_letter_jobs` with correct columns (`original_job_id`, payload, `last_error`, `attempt_count`) — **the insert succeeds** (today it cannot).
3. A worker killed mid-processing has its job reclaimed within the recovery window via the wired recovery path (`lease_expires_at` populated by claim; `detect_crashed_workers` actually invoked) — no job is stranded.
4. A duplicate job (same dedup key) does not double-execute.
5. Every declared job type either executes or is explicitly removed from the declared set — zero "Unsupported job type" throws.
6. The worker's authenticated trigger returns 200 with the correct secret (and 403 with any other) — no wrong-secret path remains.
7. All of the above proven by integration tests committed to the repo, run with Edge Runtime verified up.

### E1 — End-to-End Hospital Gate
Proves: **patient → appointment/walk-in → token → queue → doctor → consultation → billing → payment → notification → history.**
1. Booking (WhatsApp-simulated and console/API) persists fees correctly at creation (`booking_fee_inr` > 0 — the P0-04 fix observable) and allocates a token with no gap/orphan under concurrent creation (race closed).
2. Walk-in check-in → queue position; call-next → in_consultation → immutable consultation notes → completed — full doctor leg over HTTP where the Edge Function is the entry point.
3. Billing → payment order → webhook verify (signature validated, replay deduped) → capture → correct ledger entry.
4. Cancellation → refund: **full and partial** — refund amount correct (₹-for-₹), DCE proportional, settlement summary and platform revenue correct, refund status written.
5. Notification: outbound WhatsApp job enqueued **and executed by the W1-proven worker**, with delivery reconciliation.
6. History: patient history queryable, cross-hospital access denied (tenant isolation re-verified in-journey).
7. Concurrent walk-ins plus skip/recall/restore races pass (extends existing queue_runtime tests).
8. Edge Runtime verified up; suite log committed.

### S1 — Security Gate
Proves: **tenant isolation → role isolation → auth → authz → RLS → webhook security → fail-closed.**
1. Cross-hospital data access denied for every role at RLS (multi_role_auth extended to the full role set).
2. Locked RPC set denies `anon` + `authenticated` with **SQLSTATE 42501 specifically** (401-as-proof eliminated — F16-05), coverage ≥80% of Category B/C/D locked routines (F16-06).
3. New/changed SECDEF functions carry verified explicit REVOKEs — proven by a CI catalog check, not by inspection (F16-04).
4. Webhooks: Meta HMAC and Razorpay HMAC fail-closed on missing/invalid/rotated signatures (never 200); replay dedup proven.
5. Machine-endpoint JWT boundary decided and recorded (`config.toml`); whichever boundary is chosen, it is tested.
6. `is_primary` provisioning lockout impossible (P1-12); deactivated users actually lose permission (P1-13); one multi-role resolution rule (NPD-04).
7. Rate limiting active on verify-payment and auth-adjacent endpoints (not fail-open).
8. Zero secrets in repo (scan); local fake-env usage documented.

---

## 8. END-TO-END PRODUCT JOURNEY

The E1 journey leg by leg, with current state. This is what a pilot hospital experiences on day one — and where it breaks today:

| Leg | Today | After phases 0–4 |
|---|---|---|
| Patient books (WhatsApp) | ✅ Proven — deterministic routing, canonical `create_booking` RPC, replay-safe | Same, with correct fee persisted |
| Patient books (online) | ⚠️ Implementable — payment order exists but booking+order not atomic (P2-10), no client | Atomic-or-explicitly-two-phase, with client |
| Walk-in via receptionist | ⚠️ API exists and queue leg is proven; no console to do it in | Console terminal, E1-proven |
| Token + queue | ✅ Proven — atomic tokens, idempotent queue ops, races tested | Allocation race closed |
| Doctor consultation | ✅ Proven — immutable notes, single active consult, HTTP-tested | Unchanged |
| Billing + payment | ⚠️ DB side proven; live gateway untested (by design); P1-01/03 open | Financial wave fixed, gateway verified in staging |
| Refund | ❌ **₹0 for all new bookings (P0-04); partial over-zeroes (P1-02)** | Correct ₹-for-₹, partial included |
| Notifications (WhatsApp outbound) | ⚠️ Queue logic proven; **worker never executes** (B1) | W1 + scheduler = actually delivered |
| Reminders / SLA / rollups | ❌ Implemented but never scheduled | Nightly/minute proven, 24h unattended |
| History | ✅ Proven with tenant isolation | Unchanged |
| Admin/finance reporting | ✅ Command centers proven (read path) | Plus settlement summaries correct under partial refunds |

The pattern is consistent and is the roadmap's core finding: **every synchronous, in-request leg of the journey is built and mostly proven; every asynchronous leg and every money-derivation leg is where the system fails.** That asymmetry is precisely what phases 0–4 attack.

---

## 9. PRODUCTION READINESS CHECKLIST

Pilot-blocking (all must be green before first real hospital):

- [ ] W1 gate PASS with committed suite log
- [ ] E1 gate PASS with committed suite log
- [ ] S1 gate PASS with committed suite log
- [ ] Scheduler operating ≥24h unattended (Phase 2 exit)
- [ ] Partial + full refunds correct against hand-computed values
- [ ] Staff console executes the full journey (Phase 6 exit)
- [ ] Deploy pipeline exists and is reproducible; `config.toml` records the JWT boundary
- [ ] Production secrets provisioned via platform secret store; repo scan clean
- [ ] **Production** privilege catalog re-verified against the deployed database (never converted from local)
- [ ] Razorpay + Meta verified in staging with real test credentials (signature, order, refund, delivery)
- [ ] Backup/DR defined; monitoring initialized (Sentry/health wired to real heartbeats)
- [ ] Rate limiting active on webhook + auth endpoints
- [ ] Retention actually purging (PII governance)
- [ ] Gate 8 register allocation done; this roadmap's status columns updated to actual
- [ ] 30-day clean-operation period before any "certified" language

Post-pilot (parallel or after): load test, P2-11 unreachable-routine cleanup, P3 hygiene, subscription billing enforcement (P2-01 — accounting-only until a billing decision), locale/currency abstraction if market expansion (P3-09).

---

## 10. DEFINITION OF DONE

**Pilot-ready** (target of Phases 0–6 + readiness items): one real hospital runs real patients through WhatsApp + staff console; tokens/queue/consultations correct; payments capture; refunds refund the right amounts; notifications deliver; the system runs unattended for a week; every mutation audited; tenant isolation proven at production, not assumed.

**Production-certified** (beyond pilot): 30+ days clean pilot operation; live-gateway edge cases (429 storms, signature rotation, partial gateway failures) exercised in staging and handled; DR restored in a drill; load target met on queue+worker path; S1's catalog check green in CI blocking merges; a second hospital onboarded (multi-tenant proof at production, not just in tests).

Explicitly **not** done until they are done: production privilege verification, live-gateway verification, scheduler-in-production (not just local), certified-language usage. Local PASS is never production PASS.

---

## 11. RECOMMENDED EXECUTION ORDER

**Tomorrow morning, first: Phase 0.** The five hotfixes are statically confirmed, decision-free, small, and each removes a known-broken path that would otherwise poison the W1 gate: the dead-letter insert, the create_partition orphan, the nightly wrong-secret/forbidden-trigger pair, the settlement-engine 500, and the `lease_expires_at` population. Nothing else in the roadmap is both this certain and this cheap.

Then, strictly in order — **move to the next phase only when the current phase's exit criteria hold** (no calendar-based advancement):

1. **Phase 0 — hotfixes** (days). Exit: fixes + targeted tests, static gates green.
2. **Phase 1 — W1 worker proof** (the first real gate). Do not start frontend, financial, or scheduler work before W1 passes — everything downstream assumes an executing worker. Exit: W1 PASS.
3. **Phase 2 — scheduler + autonomy.** Requires the NPD-05 ruling (an architecture decision — present pg_cron+pg_net recommendation with the external-cron alternative, decide once, record it; this is the one place a product decision gates engineering). Exit: 24h unattended.
4. **Phase 3 — financial correctness.** Start with the three NPD rulings (GST, revenue recognition, DCE semantics) — they are decisions, not code, and every fix in the wave is mechanical once they're made. Exit: partial-refund tests green. *Phases 3 and 4 partially overlap safely once the rulings are made.*
5. **Phase 4 — E1 journey proof.** Exit: E1 PASS.
6. **Phase 5 — S1 security hardening.** Can start in parallel with Phase 4's non-financial items (F16-04 CI check, F16-05/06 tests) — but S1's PASS verdict comes only after E1, so the journey and the boundary are proven against the same stack state. Exit: S1 PASS.
7. **Phase 6 — staff frontend.** Start **only after E1 passes** — building the client against an unproven backend wastes the build. (API-contract scaffolding may begin during Phase 5 if capacity allows; feature work waits for E1.) Exit: journey-through-console.
8. **Phase 7 — production readiness → pilot.** Exit: §9 checklist green.

**Standing workstream rules:** the anti-treadmill loop for every item — PLAN → IMPLEMENT → TARGETED TEST → FIX → INTEGRATE → PROVE → RECORD → NEXT. One finding per workstream item; every fix cites its register ID; every gate's evidence is a committed log. If an unrelated defect is found en route: classify it, record it, fix it only if it blocks current-phase correctness — otherwise it joins the register for its phase. Register allocation stays a Gate 8 action (do not mint severity-prefixed IDs to shortcut it).

**Capacity guidance:** one engineer can sequence Phases 0–1 in the first week; Phases 2–4 are where a second stream (frontend scaffolding during 5, financial tests during 3) buys real parallelism. The serial spine is 0→1→2→3→4→5→6→7 — the gates are the merge points.

---

## 12. WHAT NOT TO DO

- **Do not rewrite working subsystems.** The state machines, token engine, queue runtime, ledger, WhatsApp engine, RLS posture are proven — extend them. No competing state machine, no second worker, no application-side ledger.
- **Do not fix P1-07 alone.** Fixing the nightly secret without removing the prohibited trigger *activates* the P2-09 violation. Resolve the pair.
- **Do not choose a scheduler silently** (NPD-05 is an architecture decision) and do not let a phase silently depend on one having been chosen.
- **Do not hand-edit ledger/DCE rows to "fix" discrepancies** — fix the derivation (Phase 3) and use canonical RPCs.
- **Do not weaken any test, delete a failing test, or mock the real stack for convenience.** If the 11 environment failures reappear, fix the Edge Runtime environment (F16-01) — do not reclassify product failures as environment without evidence.
- **Do not edit applied migrations.** Every fix in this roadmap is an additive migration or source change; migration 19/41 changes are new migrations.
- **Do not claim production from local.** Production privileges, gateway behavior, and scheduler operation get re-verified at their own level (§9, §10).
- **Do not mint register IDs.** F16-NN/GOV-NN/OBS-N stay working labels; P-prefix allocation is Gate 8.
- **Do not let a gate step live in conversation** (the persistence rule): every phase definition, gate result, and suite log becomes a repo file before work proceeds.
- **Do not build the frontend before E1**, and do not put business logic in it when it is built.
- **Do not convert the ~27% caller-less routine set (P2-11) into a deletion project by reflex** — Phase 1–3 deliberately *give callers back* to recovery, partition and retention routines; delete only what remains orphaned after that.
- **Do not treat this roadmap's statuses as permanent** — §13 lists what was unverifiable at writing time; re-verify at each gate.

---

## 13. REMAINING UNKNOWNS

Honest limits of this roadmap's evidence, each with its resolution path:

1. **Runtime behavior of the worker/scheduler paths** — no fresh runtime probing was possible (Docker unavailable on this machine during investigation). Resolution: Phases 1–2 are precisely the runtime proof.
2. **The Gate 3R Step-2 suite result (151/11)** rests on project-lead assertion; its log is absent (PoE-2 §3). Resolution: Phase 1's W1 suite becomes the first fully-logged, committed run.
3. **Live Razorpay/Meta behavior** — signature handling, order creation, refunds, delivery, 429 storms: untested by design locally. Resolution: staging verification in Phase 7.
4. **Production privilege and JWT state** — unmeasured; no deployment exists. Resolution: production catalog verification, Phase 7.
5. **The six NPD rulings** — this roadmap recommends (pg_cron+pg_net; persist `get_booking_fee` semantics) but does not decide. Resolution: each is an explicit recorded decision at its phase boundary (Phase 2 for NPD-05, Phase 3 for NPD-01/02/03, Phase 5 for NPD-04, Phase 6/7 for NPD-06).
6. **CI reachability** — unmeasurable from this non-Git tree. Resolution: the Phase 7 deploy pipeline makes the tree a real repository target or documents the transport.
7. **Scale headroom** — no load data exists for the queue/worker path. Resolution: Phase 7 load test.
8. **Extended-hours daily-cap drift impact** — statically identified, runtime impact UNPROVEN. Resolution: Phase 4 test.
9. **WhatsApp bookings' payment path** — depends on NPD-02 ruling (revenue at booking vs collection). Resolution: Phase 3.

---

*End of roadmap. This document supersedes prior phase planning as the execution spine. Statuses here are the 2026-09-02 snapshot; each gate updates them in its completion report.*
