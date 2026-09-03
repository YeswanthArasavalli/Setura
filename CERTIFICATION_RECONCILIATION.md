# SETURA — CERTIFICATION RECONCILIATION

**Scope:** Every certification, verdict and completeness claim made in the
repository's own reports, Phase 0 → Phase 1.5
**Deliverable:** PART 21 of the cross-phase reconciliation audit
**Status:** READ-ONLY. No report was edited. No certification was altered in any
file; this document records what an independent re-examination found.
**Companion documents:** `CROSS_PHASE_AUDIT_REPORT.md`,
`CROSS_PHASE_REQUIREMENTS_MATRIX.md`, `CROSS_PHASE_GAP_REGISTER.md`,
`ARCHITECTURAL_DRIFT_REGISTER.md`, `NEXT_PHASE_READINESS_REPORT.md`

---

## 0. METHOD AND RULES OF ENGAGEMENT

### 0.1 The instruction this section exists to honour

The audit mandate states, in PART 21: **"Do NOT revoke a certification
casually."** It also states, in RULE 2: **"Previous phase reports are EVIDENCE
SOURCES, NOT TRUTH."**

These pull in opposite directions on purpose. The resolution used here:

- A certification is **not** revoked because the phase's scope was narrow, because
  a later phase broke something, or because this audit could not re-run a gate.
- A certification **is** narrowed, and specific sub-claims **are** withdrawn, when a
  named factual assertion in the report is contradicted by the code at a cited
  location.
- Where a claim can be neither confirmed nor refuted, the outcome is
  **SUSPENDED PENDING VERIFICATION** — which is *not* a revocation and *not* a
  pass. Per PART 27: *"If something cannot be verified, write UNPROVEN, not PASS."*

### 0.2 Outcome vocabulary

| Code                                  | Meaning                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **UPHELD**                            | The claim is verified against code at a cited location. The certification stands as written.                                                 |
| **UPHELD WITH QUALIFICATION**         | The claim is true as scoped, but a dependency the report did not examine narrows what it means in practice. The certification stands; the *interpretation* narrows. |
| **NARROWED**                          | The phase certification stands for its own deliverables, but one or more named sub-claims are withdrawn. The phase is not de-certified.        |
| **WITHDRAWN**                         | A specific named sub-claim is contradicted by code at a cited location and must be retracted. Applies to sub-claims, not to whole phases.     |
| **SUSPENDED PENDING VERIFICATION**    | Confirming or refuting requires a live database. Docker was unavailable and starting it was declined under RULE 1. **Neither pass nor fail.** |

### 0.3 The declared evidence limitation

`docker ps` fails in this environment:
`failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`.
Starting the stack would be a shared-resource-modifying action inconsistent with
RULE 1, so it was not done.

**Consequence for this document:** every `supabase db reset` claim and every
`deno task test:integration` result claimed by every phase report is
**SUSPENDED PENDING VERIFICATION** — not doubted, not confirmed. These are the
largest single block of unverifiable claims in the repository, and their status is
a limitation of this audit, not a finding against the reports.

### 0.4 The gates this audit *did* execute

Five static gates were executed read-only against HEAD (migrations 01–49):

| Gate                            | Result at HEAD                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deno task validate:migrations` | **49 files scanned, 0 errors, 4 warnings**                                                                                                                                            |
| `deno fmt --check`              | **259 files, exit 0**                                                                                                                                                                 |
| `deno lint`                     | **75 files, clean**                                                                                                                                                                   |
| `deno task check`               | **0 errors**                                                                                                                                                                          |
| `deno task test` (unit)         | **65 passed / 0 failed (905 ms)**                                                                                                                                                     |
| `deno task test:integration`    | **NOT RUN** — 162 cases confirmed by static count only                                                                                                                                |

The four warnings are: `dashboard_presence` (migrations 11 + 20),
`check_partition_readiness` (15 + 22), `partition_health` view (15 + 22), and
`idx_alert_events_open` (`24:140` + `47:83`).

**This independently confirms the Phase 1.5 report's `deno task test` figure of
65/0 exactly**, and independently confirms four of its eight gates. That is the
single strongest piece of corroboration available to any phase report in this
repository, and it is credited accordingly below.

---

## 1. CERTIFICATION INVENTORY

Ten artifacts make certification-grade claims. Their self-declared status:

| Artifact                                       | Lines | Self-declared status                                                              |
| ---------------------------------------------- | ----- | --------------------------------------------------------------------------------- |
| `AUDIT_REPORT.md`                              | 536   | Technical audit; **"~85% production-ready"**; 21 subsystems marked ✅ Production-ready |
| `CROSS_CHECK_REPORT.md`                        | 271   | **"The product description is overwhelmingly honest and accurate"**; corrects 95 % → 85 % |
| `PHASE_0.5_COMPLETION_REPORT.md`               | 215   | **✅ CERTIFIED** — *"backend completeness ~85%"*                                     |
| `PHASE_1.1_COMPLETION_REPORT.md`               | 244   | **✅ CERTIFIED**                                                                    |
| `PHASE_1.2_COMPLETION_REPORT.md`               | 237   | **✅ COMPLETE & CERTIFIED**                                                          |
| `PHASE_1.3_COMPLETION_REPORT.md`               | 240   | **✅ COMPLETE & CERTIFIED** — *"Ready for the next phase"*                            |
| `PHASE_1.4_COMPLETION_REPORT.md`               | 260   | **✅ COMPLETE & CERTIFIED** — *"Ready for the next phase"*                            |
| `PHASE_1.5_RECOVERY_REPORT.md`                 | 480   | **NOT CERTIFIED** — *"~85% functional, 4 real defects, 1 critical platform-wide security hole"* |
| `PHASE_1.5_SECURITY_AND_COMPLETION_REPORT.md`  | 1034  | **FINAL VERDICT: CERTIFIED**, with three disclosures in §19.3                        |
| `SETURA_CLAUDE_REPORT.md`                      | 905   | Meta-audit: **"less certified than its documentation claims"**                        |

**Structural observation.** Two of these ten — `PHASE_1.5_RECOVERY_REPORT.md` and
`SETURA_CLAUDE_REPORT.md` — are *self-critical* documents that refused
certification and named real defects. Their existence is materially to the
project's credit and is weighed in §9 below: SETURA has an internal habit of
adversarial self-review, and it worked.

**No phase report is a marketing document.** Every one of them discloses
something. That is unusual and it changes how this reconciliation reads: the
failures found below are overwhelmingly failures of *scope* — gates that were
never designed to catch what was missed — not failures of honesty.

---

## 2. PHASE 0 — `AUDIT_REPORT.md` AND `CROSS_CHECK_REPORT.md`

Phase 0 has no completion report. Its certification-grade claims live in the two
audit documents, both of which describe a 37-migration codebase (HEAD is 49).

### 2.1 Claim-by-claim

| # | CLAIM (verbatim or close paraphrase, with location)                                                                                                                                        | ACTUAL EVIDENCE                                                                                                                                                                                                                                  | VERIFIED?  | OUTCOME                              |
| - | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ------------------------------------ |
| 1 | `CROSS_CHECK_REPORT.md:~44` — `create-booking` *"implements a 16-step validated flow (auth → role → Zod validation → idempotency → doctor availability → token generation → **payment order** → audit → WhatsApp enqueue)"* | **`create-booking/index.ts` (688 L) contains zero occurrences of `payment_order`, `payment-order`, `razorpay` or `payment_orders`.** Its eight RPC calls are `create_booking`, `enqueue_job`, `estimate_wait_minutes`, `get_effective_fees`, `get_remaining_token_capacity`, `is_doctor_available`, `record_subscription_usage`, `send_whatsapp_message`. Payment orders are created by a **separate** endpoint, `create-payment-order` (406 L). | **NO**     | **WITHDRAWN** (sub-claim)            |
| 2 | `CROSS_CHECK_REPORT.md:~178` — Background job processing: *"`claim_jobs_v2` (FOR UPDATE SKIP LOCKED, **lease tracking**, exponential backoff, dead-letter on max attempts)"*                 | `SKIP LOCKED`, backoff and dead-lettering are all real and verified. **`claim_jobs_v2` never assigns `lease_expires_at`.** The v1 `claim_jobs` does, at `06:283`. "Lease tracking" is the one item in the list that does not exist.                  | **NO**     | **WITHDRAWN** (sub-claim) — **P0-01** |
| 3 | `CROSS_CHECK_REPORT.md:175` region — Crash recovery: *"`worker_registry` + heartbeat (25 % sampled) + `detect_crashed_workers()` + **lease reclaim** — verified in migration 19"*             | `worker_registry`, the sampled heartbeat and `detect_crashed_workers()` all exist as described. **Lease reclaim cannot function:** `reclaim_stale_jobs` filters on `lease_expires_at`, which no v2 claim ever populates; the v2 recovery routines have zero callers; migration 39's `stop_worker` comments reference `recover_crashed_worker_jobs`, which does not exist (the real, uncalled routine is `reclaim_crashed_worker_jobs`). | **NO**     | **WITHDRAWN** (sub-claim) — **P0-01** |
| 4 | `CROSS_CHECK_REPORT.md:~179` — Automated monitoring: *"**Minute cron runs** master scheduler + health snapshot; **nightly cron runs** carry-forward, MV refresh, rollups, SLA, retention, partitions"* | The endpoints, RPCs and orchestration all exist and are well built. **Nothing schedules them.** No `pg_cron` job, no `cron.schedule` call, no scheduler configuration, no CI schedule targets `run-cron-nightly`, `run-cron-daily` or `run-background-worker` anywhere in 49 migrations, `config.toml`, `.github/workflows/**` or `docs/**`. | **NO**     | **WITHDRAWN** (sub-claim) — **P0-02** |
| 5 | `AUDIT_REPORT.md:377` — Booking Cancellation & Refund: **✅ Production-ready** — *"Tiered refund policy, Razorpay refund API, idempotent"*                                                     | The tiered policy (`calculate_refund_amount`, mig 29) and idempotency (mig 41 replay guard — real and tested) are genuine. But **`booking_fee_inr` has no runtime writer** after migration 28's one-time backfill, so two of three refund paths compute a zero refund on every booking created since. Additionally the refund **amount basis is inconsistent** across paths (P1-10), and partial refunds **over-adjust settlement** (P1-02). | **NO**     | **WITHDRAWN** (sub-claim) — **P0-04** |
| 6 | `AUDIT_REPORT.md:372` — Online Booking with Payment: **✅ Production-ready** — *"Razorpay integration, idempotent capture, **webhook verification**"*                                          | Razorpay integration and idempotent capture are real. **Webhook verification uses the wrong secret:** `verify-payment/index.ts:63` verifies with `RAZORPAY_KEY_SECRET`; Razorpay signs webhooks with a distinct webhook secret, and **`RAZORPAY_WEBHOOK_SECRET` appears nowhere in the repository.** Every genuine Razorpay webhook fails HMAC. | **NO**     | **WITHDRAWN** (sub-claim) — **P1-01** |
| 7 | `AUDIT_REPORT.md:381` — Analytics & Rollups: **✅ Production-ready** — *"5 MVs, weekly/monthly/quarterly/global/cohort rollups"*                                                               | All five MVs exist (`08:48`, `:154`, `:239`, `:275`, `:314`) and the refresh machinery is **correct** — `CONCURRENTLY`, unique indexes, dependency order (`17:497`, `17:597`). **No edge function, RPC or test reads any of the five.** The wired forecast, `get_revenue_forecast` (`47:1556`), computes the same question from live DCE by a different method. | Partly     | **UPHELD WITH QUALIFICATION**        |
| 8 | `AUDIT_REPORT.md:375` — Multi-Role Authorization: **✅ Production-ready** — *"4 roles, 17+ permissions, RLS enforcement, `has_permission()`"*                                                  | All components exist. But **three different role-resolution rules coexist**: `has_permission()` unions all roles; `current_user_role()` reduces via `is_primary DESC, level ASC`; `auth.ts::selectRole()` denies when no row is primary. `multi_role_auth.test.ts` test 6 demonstrates the divergence. **No cross-tenant escalation exists.** | Partly     | **UPHELD WITH QUALIFICATION**        |
| 9 | `AUDIT_REPORT.md:380` — Background Worker: **✅ Production-ready** — *"Heartbeat, crash recovery, FOR UPDATE SKIP LOCKED"*                                                                     | See #2 and #3. Additionally, `.env.example` ships **`ENABLE_WORKER_TRIGGER=false`**, so an operator following the repository's own setup produces a system where enqueued jobs are never processed at all.                                          | **NO**     | **WITHDRAWN** (sub-claim) — **P0-03** |
| 10 | `AUDIT_REPORT.md:486` — **"The backend is ~85 % production-ready."** `CROSS_CHECK_REPORT.md:17` corrects a *"~95 %"* claim down to *"realistically ~85 %"*                                    | The **downward** correction was the right instinct and was made without external pressure. This audit's independently derived figure — 74 of 147 requirements VERIFIED COMPLETE = **50.3 %** — is lower, but it measures a different thing: *requirement satisfaction with traced evidence*, not *subsystem existence*. Both numbers can be simultaneously defensible. | N/A        | **UPHELD WITH QUALIFICATION**        |
| 11 | `CROSS_CHECK_REPORT.md:31` — *"Nothing in the codebase contradicts the business model, the multi-tenant architecture claims, or the security claims."*                                        | **Multi-tenancy: upheld.** Tenant scoping holds; no cross-hospital data path was found; RLS ENABLE+FORCE is applied consistently, including on the newest tables (`43:100-124`). **Business model: contradicted** — revenue is recognised at booking INSERT (`13:479`) for *every* booking including WhatsApp bookings that have no payment mechanism, and GST is debited to the ledger but excluded from every charge. | Partly     | **NARROWED**                          |
| 12 | `CROSS_CHECK_REPORT.md:60` — *"Verdict on quality: Stronger than described. The GiST exclusion constraint means double-bookings are impossible at the database level."*                       | **Confirmed.** `doctor_schedules` GiST exclusion constraint (mig 03), `generate_next_token()` atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING` (mig 02), `advance_queue()` `FOR UPDATE SKIP LOCKED` (`02:603`). This claim is accurate and the praise is earned. | **YES**    | **UPHELD**                            |

### 2.2 Verdict on Phase 0's certification

**NARROWED.** Six named sub-claims are withdrawn (#1, #2, #3, #4, #5, #6, #9 —
seven withdrawals across six distinct defects, since #2 and #3 are the same
root cause). The documents' *architecture* claims — multi-tenancy, RLS,
concurrency safety, atomicity, immutability — are **upheld and in several cases
understated**.

**The pattern is specific and worth naming:** every withdrawn sub-claim is a
statement that a *mechanism is wired*, made on the basis of the mechanism *existing*.
`claim_jobs_v2` exists → "lease tracking". `run-cron-nightly` exists → "minute
cron runs". `calculate_refund_amount` exists → "tiered refund policy" is
production-ready. The audits read the code correctly and inferred the wiring.
This is exactly the failure mode RULE 3 was written to prevent: *"A function
existing is not proof that the feature works."*

---

## 3. PHASE 0.5 — `PHASE_0.5_COMPLETION_REPORT.md`

**Self-declared:** ✅ CERTIFIED. *"Four integration gaps closed. Backend
completeness ~85 %."*

### 3.1 Claim-by-claim

| # | CLAIM                                                                                                                     | ACTUAL EVIDENCE                                                                                                                                                                                                                                                             | VERIFIED?  | OUTCOME                            |
| - | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------- |
| 1 | `:150` — `supabase db reset` (migrations 01→41 + seed) **✅ clean apply**                                                   | Cannot be re-executed (Docker). Migrations 01–41 are present, ASCII-clean, and pass the validator with 0 errors at HEAD.                                                                                                                                                       | Cannot re-run | **SUSPENDED PENDING VERIFICATION** |
| 2 | `:154` — `deno task validate:migrations` **✅ 0 errors (3 pre-existing warnings)**                                          | 0 errors: **UPHELD**. Warning count: the validator emits **4** at HEAD. At 41 migrations the 4th warning (`idx_alert_events_open`, introduced by `47:83`) did not yet exist, so **3 was correct when written**. The figure was then copied forward unchanged through 1.1, 1.2, 1.3 and 1.4. | **YES** (as of its own date) | **UPHELD**                          |
| 3 | `:155` — Unit tests **✅ 37 passed / 0 failed**                                                                             | Not re-runnable at 41 migrations. At HEAD the unit suite is **65 passed / 0 failed**, independently executed this audit. Growth 37 → 65 is consistent with the reports' own new-test counts.                                                                                    | Consistent | **UPHELD WITH QUALIFICATION**       |
| 4 | `:156` — Integration tests **✅ 33 passed / 0 failed**                                                                      | Docker.                                                                                                                                                                                                                                                                       | Cannot re-run | **SUSPENDED PENDING VERIFICATION** |
| 5 | `:157` — Backward compatibility **✅ no endpoint request/response shape changed; new fields additive** (`messageRecordId`, `duplicate`) | Additive-only shape change is consistent with the code read. No contradicting evidence found.                                                                                                                                                                                  | **YES**    | **UPHELD**                          |
| 6 | `:158` — Immutable ledger/audit **✅ retention test asserts zero delta; refund replay adds no rows**                        | **Strongly upheld.** `prevent_ledger_mutation` plus `trg_ledger_no_update` / `trg_ledger_no_delete`; `audit_logs`, `consultation_notes` and `queue_runtime_events` all carry immutability triggers (`43:100-124` for the newest). Migration 41's refund replay guard is real: `RETURN FALSE` at body-relative lines 22 and 27, and it **is** tested. | **YES**    | **UPHELD**                          |
| 7 | `:~207` — Compliance note: **"No schema changes"** — *"extended usage counters live in the existing …"*                     | **True as scoped.** Migrations **40 and 41 contain zero DDL**, independently verified. The report's own narrower claim is correct.                                                                                                                                              | **YES**    | **UPHELD**                          |
| 8 | The architecture freeze: `ROADMAP.md:45-47` — *"Migration 37 is the last schema change"*, with an amendment gate at `:66`   | **Breached, by later phases, with no amendment ever recorded.** Post-37 DDL: **5 new tables** (`whatsapp_conversation_states` 42, `queue_runtime_events` 43, `consultation_notes` 46, `alert_activity_log` 47, `alert_suppressions` 47); **17 new columns** (38 ×2, 43 ×4, 45 ×3, 47 ×8); **1 new enum value** (`42:25` → `'received'`). | **NO** — but not by Phase 0.5 | **UPHELD** (Phase 0.5); breach attributed to 38, 42–47 |
| 9 | `:~163` — *"Issues found and fixed during test execution (evidence the suite works)"* — three named fixes including a latent migration-13 enum cast bug *"never executed before Phase 0.5"* | This is genuine and important evidence. A suite that surfaces a latent bug in a four-phase-old migration is doing real work. The three fixes are specific, plausible and independently consistent with the code.                                                                | **YES**    | **UPHELD** — and credited            |

### 3.2 Verdict on Phase 0.5's certification

**UPHELD.** Phase 0.5's own claims survive scrutiny. Its "no schema changes"
sub-claim is independently verified true. Its immutability claims are among the
best-evidenced in the repository. Its warning count was accurate *at its own
date*.

**The freeze it established was later breached — that is a finding against
migrations 38 and 42–47, and against the absence of an enforcement gate
(`supabase db diff` was never wired into CI), not against Phase 0.5.** A freeze is
only as good as its enforcement, and Phase 0.5 defined the amendment gate that
subsequent phases declined to use.

---

## 4. PHASE 1.1 — `PHASE_1.1_COMPLETION_REPORT.md`

**Self-declared:** ✅ CERTIFIED. *"SETURA transformed from WhatsApp-notified to
WhatsApp-operated: the conversation is the interface."*

### 4.1 Claim-by-claim

| # | CLAIM                                                                                                                | ACTUAL EVIDENCE                                                                                                                                                                                                                                                                                                                     | VERIFIED?  | OUTCOME                            |
| - | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------- |
| 1 | The ROADMAP Phase 1.1 WhatsApp **retry contract** — exponential backoff, permanent-failure classification, terminal state, confirmation flag | **Fully upheld, every clause.** `permanentCodes` at `send-whatsapp-message/index.ts:285-290`; `POWER(2, v_retry_count)::INTEGER` backoff at `04:649`; terminal `permanently_failed` at `04:747`; `whatsapp_confirmation_sent` at `04:665`. This is the single most completely satisfied requirement set in the entire audit.            | **YES**    | **UPHELD**                          |
| 2 | `:179-183` — Booking / queue lookup / rescheduling / cancellation from WhatsApp **✅ verified end-to-end**             | The conversational engine is real and substantial: deterministic (no-LLM) intent router, `whatsapp_conversation_states` (mig 42) with 30-minute TTL, full booking conversation. Execution evidence is integration-test-based (Docker).                                                                                                  | Code: YES; execution: cannot re-run | **UPHELD WITH QUALIFICATION**       |
| 3 | `:184` — Conversation state reliable **✅ expiry, interruption, replay, handoff**                                      | State machine and TTL exist as described. Test-based.                                                                                                                                                                                                                                                                                 | Cannot re-run | **SUSPENDED PENDING VERIFICATION** |
| 4 | `:185` — Multi-tenant isolation **✅ explicit cross-tenant test**                                                      | Cross-tenant isolation upheld everywhere it was examined statically. A dedicated test exists.                                                                                                                                                                                                                                          | Code: YES  | **UPHELD**                          |
| 5 | `:186` — No backend regression **✅ all 33 pre-existing integration tests pass**                                       | Docker.                                                                                                                                                                                                                                                                                                                               | Cannot re-run | **SUSPENDED PENDING VERIFICATION** |
| 6 | `:172` — `deno task validate:migrations` **✅ 0 errors (3 pre-existing warnings)**                                     | 0 errors upheld. The warning figure is **copied from Phase 0.5, not re-measured** — the first instance of the copy-forward. Still numerically correct at 42 migrations.                                                                                                                                                                 | Numerically yes | **UPHELD WITH QUALIFICATION**       |
| 7 | The **implicit** claim that WhatsApp booking is a complete booking path                                                | **Contradicted.** WhatsApp bookings create **no payment order at all** — `create-booking` creates none (verified: zero payment references in 688 lines) and the WhatsApp path creates none either. Yet the booking INSERT trigger (`13:479`) recognises revenue and the DCE trigger (mig 07, **no `WHEN` clause**) writes a collection entry for every booking. **Every WhatsApp booking books revenue that cannot be collected.** | **NO**     | **WITHDRAWN** (implicit sub-claim) — **P1-05** |
| 8 | `:~190` — *"Issues found and fixed during test execution"* — five named fixes including `parseDateInput` matching `dd/mm` against normalised text that strips `/` | Specific, plausible, and exactly the class of bug only real execution finds. Credited as genuine evidence the suite works.                                                                                                                                                                                                              | **YES**    | **UPHELD** — and credited            |

### 4.2 Verdict on Phase 1.1's certification

**NARROWED.** Phase 1.1 delivered its stated scope and then some — the retry
contract is the audit's cleanest full pass, and the conversational engine is real,
deterministic and tenant-isolated.

Two things narrow it:

1. **The WhatsApp booking path has no payment mechanism** (#7), and revenue is
   nonetheless recognised for it. Phase 1.1's gates tested the *conversation*
   thoroughly and never asked whether money could follow it. That is a scope gap
   in the gate design, not a false statement in the report.
2. **Phase 1.1 shipped roadmap Phase 3 work** (`SETURA_CLAUDE_REPORT.md:159`
   labels it *"certified, off-roadmap"* — accurately). Delivering a later phase
   before its financial prerequisites existed is precisely how #7 arose.

The certification stands. Its scope was the conversation; the conversation works.

---

## 5. PHASE 1.2 — `PHASE_1.2_COMPLETION_REPORT.md`

**Self-declared:** ✅ COMPLETE & CERTIFIED. Scope: *"Queue Runtime & Live
Operations"*. **Roadmap Phase 1.2 was "Refund consistency"** — this phase is
off-roadmap (`SETURA_CLAUDE_REPORT.md:160` says so, accurately).

### 5.1 Claim-by-claim

| # | CLAIM                                                                                                                                       | ACTUAL EVIDENCE                                                                                                                                                                                                                                                                                                                          | VERIFIED?  | OUTCOME                            |
| - | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------- |
| 1 | `:~27` — **"No architecture redesign. No breaking API changes. No duplicate booking or queue logic."**                                        | True **as of Phase 1.2**. `advance_queue` remained the single mutation primitive; control RPCs sit beside it. The duplication that now exists (`queue-control` and `doctor-operations` both exposing `recall`/`skip`/`restore`/`mark_absent`/`resume`) was introduced by **Phase 1.4**, not here.                                              | **YES**    | **UPHELD**                          |
| 2 | `:~31` — *"Nothing keeps in-memory state: the database is the runtime, so any client recovers by reading it."*                                | **Upheld and architecturally significant.** `get_queue_snapshot` (mig 43 §7) reconstructs full state from the database alone. `queue_runtime_events` is Realtime-published with ENABLE + FORCE RLS and an immutability trigger (`43:100-124`). This is a genuinely strong design property and it is implemented as described.                    | **YES**    | **UPHELD** — and credited            |
| 3 | Queue control API — *"7 idempotent SQL RPCs"*; concurrency hardening — *"SKIP LOCKED advance, `FOR UPDATE` locks, optimistic guards, 5-way stress test"* | The RPCs, locks and `SKIP LOCKED` primitive are all present and correct on static read. The 5-way stress test exists in `queue_runtime.test.ts`. Execution is Docker-gated.                                                                                                                                                                  | Code: YES; execution: cannot re-run | **UPHELD WITH QUALIFICATION**       |
| 4 | `:~180` — Unit tests **✅ 37/37**; integration **✅ 61 + 16 = 77/77**                                                                          | Docker. Counts are internally consistent with 1.1's 61 and this phase's 16.                                                                                                                                                                                                                                                                 | Cannot re-run | **SUSPENDED PENDING VERIFICATION** |
| 5 | `:~178` — `deno task validate:migrations` **✅ 0 errors (3 pre-existing warnings)**                                                            | 0 errors upheld. Warning figure copied forward for the second time. Numerically still correct at 44 migrations.                                                                                                                                                                                                                              | Numerically yes | **UPHELD WITH QUALIFICATION**       |
| 6 | `:~186` — *"Issues found and fixed during Phase 1.2"* — four named items, including that `PHASE_1.1_COMPLETION_REPORT.md` *"had drifted from `deno fmt`"*   | Small, honest, specific. The fourth item is a project that formats its own reports as a gate — a good sign.                                                                                                                                                                                                                                   | **YES**    | **UPHELD**                          |
| 7 | **The roadmap requirement this phase was supposed to satisfy — refund consistency (R-01, R-02: booking status and `payment_status_detail` reflect refunds)** | **MISSING, not partial.** `bookings.payment_status_detail` (`28_booking_enhancements.sql:45-100`) permits `refund_initiated` / `refund_processed` / `refund_failed`, but the **only** runtime writer anywhere is `34_payment_ledger_cleanup.sql:198` → `'payment_captured'`. `confirm_refund_processed` (mig 41) updates `payment_refunds`, `payment_orders`, `financial_ledger` and `daily_collection_entries` — and **never touches `bookings`**. The refund states are unreachable. | **NO**     | **WITHDRAWN** (roadmap requirement, not a report claim) — **P1-08** |

### 5.2 Verdict on Phase 1.2's certification

**UPHELD.** Every claim Phase 1.2 actually made about its own deliverables is
true, and two of them (#2, #3) describe work of higher quality than the report
claims for itself.

**But the roadmap requirement bearing the number "1.2" — refund consistency — was
not built by Phase 1.2 or by anything since.** This is the clearest single
instance of drift **D-01**: the phase numbers in the reports and the phase numbers
in `ROADMAP.md` refer to different work, so a requirement can be "covered by a
certified phase 1.2" and simultaneously unbuilt. Nobody made a false statement.
The index simply stopped matching, and a requirement fell through the gap.

---

## 6. PHASE 1.3 — `PHASE_1.3_COMPLETION_REPORT.md`

**Self-declared:** ✅ COMPLETE & CERTIFIED. *"Phase 1.3 certified. Ready for the
next phase."* Scope: *"Security baseline freeze + Operations & Exception
Management"*. **Roadmap Phase 1.3 was "Retention & maintenance"** — off-roadmap.

### 6.1 Claim-by-claim

| # | CLAIM                                                                                                                                                                | ACTUAL EVIDENCE                                                                                                                                                                                                                                                                                                             | VERIFIED?  | OUTCOME                            |
| - | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------- |
| 1 | `:~30` — Security baseline freeze: `whatsapp_queue_flow.ts` *"now sanitizes `ctx.phone` … and validates it against `^\+?\d{7,15}$` **before** any PostgREST `.or()` filter is constructed … eliminating PostgREST operator injection through the phone parameter"* | **Upheld.** The validation is present, is applied before filter construction, and the reasoning about PostgREST `.or()` operator injection is correct. This is a real vulnerability class, correctly identified and correctly closed.                                                                                            | **YES**    | **UPHELD** — and credited            |
| 2 | `:~40` — *"HMAC verification and the webhook pipeline are unchanged."*                                                                                                 | True — and this is where the Razorpay webhook secret defect (**P1-01**) survived. `verify-payment/index.ts:63` verifies with `RAZORPAY_KEY_SECRET`; `RAZORPAY_WEBHOOK_SECRET` appears nowhere in the repository. The phase said it did not look at HMAC, so this is **not** a false claim — it is a scope boundary that a "security baseline freeze" arguably should have crossed. | **YES** (as stated) | **UPHELD WITH QUALIFICATION**       |
| 3 | `:~222` — *"Mandatory-rule verification — Additive only: no existing column dropped, no RPC signature changed"*                                                        | **Upheld.** Zero destructive statements found across all 49 migrations (no `DROP TABLE`, no `DROP COLUMN`, no destructive `ALTER`). Migration 45 adds 3 columns; `get_queue_snapshot` keeps its signature.                                                                                                                       | **YES**    | **UPHELD**                          |
| 4 | `:~226` — *"Idempotent: delay repeat/changed/clear, alert dedupe (1h), incident once-per-alert, notification keys collapse retries — tests 2, 3, 5, 6, 10"*             | Mechanisms present on static read (`fire_alert` 1h dedupe, deterministic `enqueue_job` keys). Execution Docker-gated.                                                                                                                                                                                                            | Code: YES  | **UPHELD WITH QUALIFICATION**       |
| 5 | `:~231` — *"Multi-tenant isolation: thresholds resolve per hospital; alerts carry the session's hospital; evaluator never crosses tenants (test 9)"*                    | Upheld on static read. Consistent with every other tenancy finding in this audit.                                                                                                                                                                                                                                                 | **YES**    | **UPHELD**                          |
| 6 | `:~233` — **"No duplicate engines: every primitive reuses migrations 24/43/SLA/job infrastructure."**                                                                   | **Upheld for Phase 1.3.** However migration 47 (Phase 1.5) later re-declares `idx_alert_events_open`, already created at `24:140` — producing validator warning #4. The duplication is attributable to 47, not 45.                                                                                                                 | **YES**    | **UPHELD**                          |
| 7 | `:~211` — `deno task validate:migrations` **✅ 0 errors (3 pre-existing warnings from migrations 11/15/20/22)**                                                          | 0 errors upheld. Third copy-forward. **This is the first version to name the source migrations (11/15/20/22)** — which is more precise and matches three of the four warnings this audit measured. Numerically correct at 45 migrations.                                                                                            | **YES**    | **UPHELD**                          |
| 8 | `:~212` — `deno task test:integration` **✅ 89/89 (77 existing + 12 new; zero regressions)**                                                                            | Docker.                                                                                                                                                                                                                                                                                                                          | Cannot re-run | **SUSPENDED PENDING VERIFICATION** |
| 9 | `:240` — **"Phase 1.3 certified. Ready for the next phase."**                                                                                                          | Correct for the phase's own scope. But the roadmap requirement numbered 1.3 — **retention and maintenance automation** — depends entirely on scheduled execution, and **nothing schedules anything** (**P0-02**). `check_partition_readiness()` returns `'Partitions will auto-create'` while **no table in the schema is partitioned**. | **NO** (roadmap 1.3) | **NARROWED**                        |

### 6.2 Verdict on Phase 1.3's certification

**NARROWED.** The security baseline freeze is the best single piece of security
work certified in any phase report: a real injection class, correctly reasoned,
correctly closed, at a named location. The exception-management deliverables are
present and additive as claimed.

The narrowing is entirely #9. Everything Phase 1.3 built for *operations* assumes a
scheduler exists. None does. The phase certified the mechanism and never asked
whether the clock was connected — and `check_partition_readiness()` actively told
whoever asked that it was.

---

## 7. PHASE 1.4 — `PHASE_1.4_COMPLETION_REPORT.md`

**Self-declared:** ✅ COMPLETE & CERTIFIED. *"Phase 1.4 certified. Ready for the
next phase."* Scope: *"Doctor & Clinical Operations"*. **Roadmap Phase 1.4 was
"Subscription platform"** — off-roadmap.

### 7.1 Claim-by-claim

| # | CLAIM                                                                                                                                                        | ACTUAL EVIDENCE                                                                                                                                                                                                                                                                                                                                     | VERIFIED?  | OUTCOME                            |
| - | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------- |
| 1 | `:~33` — **"No architecture redesign. No duplicate queue or booking state logic. No breaking API changes."**                                                   | **The duplicate-logic clause is contradicted.** `doctor-operations` (610 L, 15 actions) and `queue-control` (392 L, 10 actions) **both** expose `recall`, `skip`, `restore`, `mark_absent` and `resume` — two endpoints, two role gates, one state machine. The report's own §2 describes these as *"reuse Phase 1.2 primitives"*, which is true at the **RPC** layer; the duplication is at the **endpoint/authorization** layer, which the claim does not distinguish. | **NO** (as to endpoints) | **WITHDRAWN** (sub-claim) — **P2-12** |
| 2 | `:~38` — *"Consultation state lives on `bookings` via the existing status trigger … session control reuses `queue_sessions` and the Phase 1.2 pause engine"*   | **Upheld.** No parallel state store was created. Trigger-stamped `consultation_started_at` / `consultation_completed_at`. This is genuine reuse and the right call.                                                                                                                                                                                     | **YES**    | **UPHELD**                          |
| 3 | `:~24` — Clinical notes: *"`consultation_notes` append-only table + `save_consultation_note` RPC"*                                                             | **Upheld.** `consultation_notes` (mig 46) is append-only with an immutability trigger, matching `audit_logs` and `financial_ledger`. Consistent with the architecture's stated immutability posture.                                                                                                                                                     | **YES**    | **UPHELD**                          |
| 4 | `:~26` — Operational safeguards: *"One-active-consultation unique partial index, `FOR UPDATE` locking, idempotency, RLS/grants, audit"*                        | All five present on static read. The unique partial index is a real DB-level guarantee, not application logic.                                                                                                                                                                                                                                          | **YES**    | **UPHELD**                          |
| 5 | `:~230` — *"Audited: every endpoint mutation written as `clinical_action` / `clinical_note`; notes themselves immutable — tests 10, 12, 13"*                    | Mechanisms present. Execution Docker-gated.                                                                                                                                                                                                                                                                                                             | Code: YES  | **UPHELD WITH QUALIFICATION**       |
| 6 | `:~228` — *"Backward compatible: all 89 prior integration tests and 37 unit tests pass unchanged"*; `:~232` — `test:integration` **✅ 105/105**                  | Docker.                                                                                                                                                                                                                                                                                                                                                 | Cannot re-run | **SUSPENDED PENDING VERIFICATION** |
| 7 | `:~231` — `deno task validate:migrations` **✅ 0 errors (3 pre-existing warnings from migrations 11/15/20/22)**                                                  | 0 errors upheld. **Fourth and final copy-forward, and defensibly still correct**: the 4th warning arrives with `47:83`, which postdates Phase 1.4. `SETURA_CLAUDE_REPORT.md:582` reaches the same conclusion independently.                                                                                                                               | **YES**    | **UPHELD**                          |
| 8 | `:~219` — *"Fresh `supabase db reset` (migrations 01→46 + seed)"* — **✅ 46/46 applied cleanly**                                                                 | Docker.                                                                                                                                                                                                                                                                                                                                                 | Cannot re-run | **SUSPENDED PENDING VERIFICATION** |
| 9 | **The roadmap requirement numbered 1.4 — subscription platform with enforced plan limits.** Roadmap success criterion: *"Hospital on Starter plan (50 bookings/month) gets blocked on #51"* | **`check_booking_limit()` does not exist** — exhaustive search across 49 migrations, 26 edge functions, generated types and tests. `create-booking` (688 L) has **no quota gate**; it calls `record_subscription_usage` at `:649` and nothing else. `get_subscription_limits`, `is_subscription_active`, `change_subscription_plan` and `get_subscription_usage` all exist with **zero production callers**. **Every plan tier is currently unlimited.** | **NO**     | **WITHDRAWN** (roadmap requirement) — **P2-01** |

### 7.2 Verdict on Phase 1.4's certification

**NARROWED.** The clinical-operations work is real, well-integrated and correctly
reuses the Phase 1.2 primitives at the RPC layer — a discipline many projects
abandon by their fifth phase. The append-only notes table and the
one-active-consultation index are both DB-level guarantees rather than application
conventions, which is the right instinct.

Two narrowings:

1. **"No duplicate queue or booking state logic" is false at the endpoint layer**
   (#1). Two endpoints now own five identical operations with independent role
   gates. The report's finer-grained §2 wording is accurate; the headline claim is
   not.
2. **Subscription enforcement — the roadmap's Phase 1.4 — does not exist** (#9),
   and metering without enforcement means the product's commercial model is
   currently unenforced. This is drift **D-01** again, and it is the second
   requirement (after refund consistency) to fall through the numbering gap.

---

## 8. PHASE 1.5 — TWO REPORTS

Phase 1.5 is documented twice, and the pair is the most interesting artifact in the
repository: the first report **refused** certification, and the second earned it.

### 8.1 `PHASE_1.5_RECOVERY_REPORT.md` — self-declared **NOT CERTIFIED**

| # | CLAIM                                                                                                                                                              | ACTUAL EVIDENCE                                                                                                                                                                                                                                                     | VERIFIED?  | OUTCOME                     |
| - | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------- |
| 1 | `:17` — *"Substantially implemented, not certifiable. ~85 % functional, 4 real defects, 1 critical platform-wide security hole"*                                     | This is a report that had every incentive to certify and did not. The "critical platform-wide security hole" is the PostgREST-executable `SECURITY DEFINER` surface, which migration 48 then addressed. The four defects are named specifically, with SQLSTATEs.       | **YES**    | **UPHELD** — and credited     |
| 2 | `:96` — *"`get_hospital_timeline` fails 100 % of calls (SQLSTATE 42803)"* — HTTP 500                                                                                 | Naming the exact SQLSTATE for a total-failure path is evidence of real execution, not inference. Migration 49 subsequently fixes defects of this class.                                                                                                                | **YES**    | **UPHELD**                    |
| 3 | `:103` — Predictive analytics: *"100 % deterministic arithmetic … No regression, no statistics, no ML. **No AI/ML claim anywhere in docs**"*                          | **Independently confirmed.** `get_predictive_insights` and `get_revenue_forecast` (`47:1556`) are arithmetic. No AI/ML claim was found anywhere in the repository. For a 2026 healthcare product this restraint is commercially unusual and materially honest.           | **YES**    | **UPHELD** — and credited     |
| 4 | `:472` — **"Certification status: NOT CERTIFIED."** *"Docker is available and the stack is running, so certification is not blocked — but 4 implementation defects, 3 test [failures] … stand between here and a legitimate verdict."* | The refusal is correctly reasoned and correctly scoped. It distinguishes *cannot verify* from *verified broken* — the same distinction this audit is required to make under PART 27.                                                                                     | **YES**    | **UPHELD** — and credited     |
| 5 | `:460` — Notes that the security hole affects *"functions from migrations 02–46 that were certified in earlier phases"*                                               | **Correct, and this is the recovery report's most important sentence.** It identifies that earlier certifications had asserted a privilege posture no phase had ever tested. That is precisely the class of finding RULE 2 exists to surface, and the project found it itself. | **YES**    | **UPHELD** — and credited     |

**Verdict: UPHELD in full.** No claim in this report was contradicted by anything
this audit found. Its refusal to certify was correct at its date, and the four
product decisions it opened (D-1 through D-4) **remain open** — recorded here as
NPD-04, NPD-05, NPD-06 and NPD-03.

### 8.2 `PHASE_1.5_SECURITY_AND_COMPLETION_REPORT.md` — self-declared **CERTIFIED** with three disclosures

| #  | CLAIM                                                                                                                                                                                | ACTUAL EVIDENCE                                                                                                                                                                                                                                                                                                                                                                                | VERIFIED?  | OUTCOME                            |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------- |
| 1  | `:~909` — `deno task test` **pass — 65/0**                                                                                                                                             | **Independently re-executed this audit: 65 passed / 0 failed in 905 ms. Exact match.**                                                                                                                                                                                                                                                                                                            | **YES**    | **UPHELD**                          |
| 2  | `:~906-908` — `deno fmt --check`, `deno lint`, `deno task check` — **pass**                                                                                                            | **Independently re-executed: `deno fmt --check` 259 files exit 0; `deno lint` 75 files clean; `deno task check` 0 errors.**                                                                                                                                                                                                                                                                        | **YES**    | **UPHELD**                          |
| 3  | `:~910` — `deno task validate:migrations` — **pass**                                                                                                                                   | **Independently re-executed: 49 files, 0 errors.** The report does not restate a warning count here, which is the correct choice — and it is the only phase report that avoids the copy-forward.                                                                                                                                                                                                     | **YES**    | **UPHELD**                          |
| 4  | `:~911` — `deno task test:integration` **pass — 162/0**; `:~912` — Security regression suite **pass — 34/0**                                                                            | **162 integration cases confirmed by static count.** Execution: Docker.                                                                                                                                                                                                                                                                                                                            | Count: YES; execution: cannot re-run | **SUSPENDED PENDING VERIFICATION** |
| 5  | `:~905` — Fresh `supabase db reset` (01–49) — **pass**                                                                                                                                 | Docker.                                                                                                                                                                                                                                                                                                                                                                                            | Cannot re-run | **SUSPENDED PENDING VERIFICATION** |
| 6  | `:~914` — *"No test was deleted, no assertion weakened, no validator finding suppressed, and `--no-check` was not used."*                                                                | No evidence of deletion, weakening or suppression was found. The validator gained rules rather than losing them (check 7 `privilege-regression`, rules P1–P8, `PRIVILEGE_BASELINE = 48`). **A phase that adds validator rules while certifying itself is doing the opposite of gaming its gates**, and it deserves to be said plainly.                                                                | **YES**    | **UPHELD** — and credited            |
| 7  | `:~970` — *"191 of 193 `SECURITY DEFINER` functions directly executable from PostgREST by any holder of the publishable anon key … is **closed at the database boundary**"*               | Migration 48 exists (1,469 lines) and does the work. **But the effect is UNPROVEN.** Supabase installs `ALTER DEFAULT PRIVILEGES … GRANT EXECUTE ON FUNCTIONS TO postgres, anon, authenticated, service_role`, which is why the 54 `REVOKE … FROM PUBLIC` statements in migrations 27–46 were no-ops in the first place. Confirming the new posture requires `pg_proc.proacl` from a live database. Docker was down. | **CANNOT VERIFY** | **SUSPENDED PENDING VERIFICATION** — **P1-11** |
| 8  | Routine count — **193** routines classified into categories A (4) / B (145) / B-trigger (10) / C (10) / D (24)                                                                          | **Independent recount: 191 unique routines.** The categories are coherent and the classification is sound; the total is off by two. The report's own §19.3 item 2 already narrows the *changed* count to **179 of 193**, which shows the counting was being actively re-examined.                                                                                                                     | **NO** (count) | **WITHDRAWN** (sub-claim: the number) |
| 9  | Migration 48 revokes **"per routine rather than by catalog loop"**                                                                                                                     | **`48 §6` is a `DO $$` loop.** Migrations 42 (REVOKE) and 46 (GRANT) *do* name routines explicitly. The claim describes the opposite of what shipped in the section that matters most.                                                                                                                                                                                                                | **NO**     | **WITHDRAWN** (sub-claim) — **D-08**  |
| 10 | `:~975` — *"The webhook is fail-closed."*                                                                                                                                              | **Upheld for WhatsApp, and upheld well.** `verifyMetaSignature()` in `_shared/webhook_signature.ts` has a single success path with four typed rejections (`secret_missing`→500; `signature_missing` / `signature_malformed` / `signature_invalid`→403), operates on raw bytes before `JSON.parse`, uses constant-time comparison, logs no secrets, and is covered by **18 tests** in `tests/unit/webhook_signature.test.ts`, documented at `docs/security/WEBHOOK_SIGNATURE_BOUNDARY.md`. **It does not extend to the Razorpay webhook** (P1-01), which the report does not claim it does. | **YES** (as scoped) | **UPHELD** — and credited            |
| 11 | `:~976` — *"Eight tables no longer leak across tenants, two of which previously had RLS switched off entirely."*                                                                        | Consistent with everything found statically. RLS ENABLE + FORCE is applied consistently including on the newest tables. No cross-tenant path was found anywhere in this audit.                                                                                                                                                                                                                       | **YES**    | **UPHELD**                          |
| 12 | `:~977` — *"Alert mutations authorize in the function body instead of trusting the caller."*                                                                                            | **Upheld.** Migration 48 raises `42501` in-body. Side effect the phase did not catch: `alert-center` wraps RPC errors in `InternalError`, so those `42501`s reach clients as **HTTP 500 rather than 403** (P3-01/D-28).                                                                                                                                                                               | **YES**    | **UPHELD WITH QUALIFICATION**       |
| 13 | `:~979` — *"Role resolution is deterministic and fails closed."*                                                                                                                        | **Upheld for the edge layer.** `auth.ts::selectRole()` is deterministic and denies when no row is primary. **`has_permission()` still unions across roles** — which §19.3 item 1 discloses explicitly and honestly. Residual hazard the disclosure does not cover: a single-role user whose only `user_roles` row has `is_primary = false` is **locked out**, and `seed.sql` sets all four rows `is_primary: true`, so no test exercises it (P1-12). | Partly     | **UPHELD WITH QUALIFICATION**       |
| 14 | `:~980` — **"All eight executive report types work."**                                                                                                                                  | Execution-dependent; Docker.                                                                                                                                                                                                                                                                                                                                                                        | Cannot re-run | **SUSPENDED PENDING VERIFICATION** |
| 15 | `:~981` — **"Financial counts mean what they say, with the ledger and the frozen trigger untouched and reconciliation exact."**                                                          | Ledger and trigger **untouched: upheld**. **"Reconciliation exact" is contradicted:** `get_reconciliation_summary` carries three defective KPIs, surfaced to users at `financial-command-center:158`. Upstream, revenue is recognised at booking INSERT (`13:479`) for every booking including WhatsApp bookings with no payment order, and partial refunds zero an entire DCE row (P1-02) — so the inputs to reconciliation are wrong before reconciliation runs. | **NO**     | **WITHDRAWN** (sub-claim) — **P1-06** |
| 16 | §19.3 disclosure 1 — `has_permission` unions permissions; *"not currently exploitable because the affected RPCs are `service_role`-only and the Edge layer applies `requireRole()` first"* | **Independently confirmed on both halves.** All **20 user-facing endpoints call `requireRole`** (verified by plain-text grep after a single-line grep produced false negatives on 10 of them). No cross-tenant escalation path was found. The disclosure's reasoning is correct, and its instruction — *"must be resolved before any of those RPCs is granted to `authenticated`"* — is the right gate. | **YES**    | **UPHELD** — and credited            |
| 17 | §19.3 disclosure 2 — *"Ten trigger-returning routines retain `anon` `EXECUTE` … unreachable — PostgreSQL raises `0A000` on a direct call and PostgREST does not expose them"*             | The `0A000` reasoning is sound: a trigger-returning function cannot be invoked directly. Category B-trigger = 10 matches. Confirming PostgREST non-exposure requires a live instance.                                                                                                                                                                                                                 | Reasoning: YES; runtime: cannot verify | **UPHELD WITH QUALIFICATION**       |
| 18 | §19.3 disclosure 3 — *"Index planner preference was not measured … that the planner chooses it at scale is **not** claimed."*                                                            | This is a model disclosure: it states exactly what was and was not proven, and declines the stronger claim. Nothing to reconcile.                                                                                                                                                                                                                                                                    | **YES**    | **UPHELD** — and credited            |
| 19 | Migration 49's self-documentation — header says *"Three functional defects"* then lists **four**; section *"5. VERIFICATION"* contains assertions numbered **4.1–4.10**                   | Internally inconsistent, and it undersells the work: migration 49's assertion block is **genuinely self-proving** and is among the better defensive SQL in the repository.                                                                                                                                                                                                                             | **NO** (numbering) | **WITHDRAWN** (presentational sub-claim) — **P3-08** |

### 8.3 Verdict on Phase 1.5's certification

**NARROWED — not revoked.**

Phase 1.5 is the most rigorously gated phase in the project, and it is the only
phase whose gate results this audit could **independently reproduce**: four of its
eight gates were re-executed at HEAD and matched, including the unit-test figure
of 65/0 exactly. It added validator rules while certifying itself. It disclosed
three open items when it could have omitted them. It closed a real,
platform-wide security exposure that five prior certifications had silently
assumed away.

Four sub-claims are withdrawn:

- **the routine count** (193 → **191**) — arithmetic, not substance;
- **"per routine rather than by catalog loop"** — factually inverted;
- **"reconciliation exact"** — contradicted at a cited location, and the most
  consequential of the four;
- **migration 49's internal numbering** — presentational.

And the phase's **central security claim is SUSPENDED, not refuted.** Whether the
privilege boundary is now closed is the single most important open question in the
repository, and it is answerable by one read-only catalog query against a live
database. **It should not be read as "privileges are broken."** It should be read
as: the four-phase belief was mis-founded, Phase 1.5 correctly identified that,
migration 48 addressed it, and **the result has not yet been measured.**

---

## 9. `SETURA_CLAUDE_REPORT.md` — RECONCILING THE PRIOR META-AUDIT

This 905-line document is a prior independent audit. Reconciling against it is
required because it makes claims *about the certifications*, and because where it
and this audit agree, the agreement is independent corroboration.

| #  | CLAIM                                                                                                                                                                                                       | THIS AUDIT'S FINDING                                                                                                                                                                                                                                                                                                              | AGREE?     | OUTCOME                       |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------- |
| 1  | `:14` — *"SETURA is … less certified than its documentation claims."*                                                                                                                                          | Confirmed, at a level of detail this report did not reach: **15 named sub-claims withdrawn** across the phase reports, and **12 more suspended** pending a live database.                                                                                                                                                             | **YES**    | **UPHELD**                     |
| 2  | `:163` — *"1.5 | does not exist in roadmap"*                                                                                                                                                                     | **Independently confirmed by exhaustive search: `ROADMAP.md` contains zero occurrences of the string "1.5".** This is recorded here as drift **D-01** and is the root enabler of PART 20.                                                                                                                                             | **YES**    | **UPHELD**                     |
| 3  | `:156-163` — the phase-versus-roadmap table labelling 1.1, 1.2, 1.3 and 1.4 as *"certified, off-roadmap"*, and 0.5 as *"certified (over-delivered)"*                                                            | **Independently reproduced.** Roadmap 1.2 (refund consistency), 1.3 (retention), 1.4 (subscription platform) were each replaced by different work. Two of those displaced requirements are still unbuilt — §5.1 #7 and §7.1 #9.                                                                                                          | **YES**    | **UPHELD**                     |
| 4  | `:159` — Phase 1.1 delivered *"Full conversational engine (roadmap Phase 3, explicitly descoped)"*                                                                                                              | Confirmed. Recorded as drift **D-03**, with the added consequence this report did not draw: the early-delivered path is the one with **no payment mechanism at all** (P1-05).                                                                                                                                                            | **YES**    | **UPHELD** — extended          |
| 5  | `:184` — *"ARCHITECTURE.md — Most accurate document … Two nits: says 'PostgreSQL 15' but `config.toml` sets `major_version = 17`"*                                                                              | **Independently confirmed at `supabase/config.toml:36`.** Recorded as **D-21**. Also confirmed: `_shared/types.ts` and `ARCHITECTURE.md` both still say *"37 migrations"* at a HEAD of 49 (**D-22**).                                                                                                                                     | **YES**    | **UPHELD** — extended          |
| 6  | `:582` — Phase 1.4's *"3 warnings"* figure *"was already wrong at publication time — the 4th warning arrives with migration 47, which postdates it, so 1.4's own claim is defensible"*                            | **Independently reached the same conclusion by separate reasoning.** The 4th warning is `idx_alert_events_open`, duplicated between `24:140` and `47:83`. Phase 1.4's figure is defensible; **the copy-forward across four reports without re-measurement is the finding** (**D-26**).                                                     | **YES**    | **UPHELD**                     |
| 7  | `:43-48` — *"It has never had a security review of function-level privileges, and its most recent phase has never been certified. **Recommended next step is not Phase 1.5 certification. It is a security remediation phase (call it 1.4.5)** … because certifying 1.5 as-is would stamp 'certified' on 31 anon-callable RPCs."* | **This recommendation was made, and it was followed.** Migration 48 (1,469 lines), migration 49, the 34-case security regression suite, `docs/security/PRIVILEGE_MODEL.md` and eight new validator rules are the remediation this paragraph asked for. **The project accepted an adversarial audit's central recommendation and executed it.** That is the strongest governance signal in the repository. | **YES**    | **UPHELD** — and acted upon    |
| 8  | `:18-21` — *"An entire uncertified phase exists in the repo … two certification gates currently fail — both on its own test file."*                                                                              | True at its date; **superseded** by `PHASE_1.5_SECURITY_AND_COMPLETION_REPORT.md`, which reports all eight gates passing. Four of those eight were independently re-executed and matched.                                                                                                                                                 | True then  | **SUPERSEDED** (correctly)     |
| 9  | `:581` — *"0, 0.5, 1.1, 1.2, 1.3 — ✅ Certified as documented (gates re-verifiable once Docker is up)"*                                                                                                          | **This audit narrows three of the five.** Phase 0's audit documents lose seven sub-claims; Phase 1.1 loses the implicit WhatsApp-payment claim; Phase 1.3 is narrowed on scheduling. Phase 0.5 and 1.2 are upheld. The divergence is expected — this report audited *documentation consistency*; the present audit traced *requirement → runtime effect*. | Partly     | **NARROWED**                    |
| 10 | `:110`, `:515` — test counts: *"exactly the Phase 1.4 certified figure … Adding the enterprise suite gives 128"*; *"37 cases are unchanged since certification"*                                                  | At HEAD: **65 unit** (independently executed, 0 failures) and **162 integration** (statically counted). Both figures have moved past this report; no contradiction, just elapsed time.                                                                                                                                                    | Superseded | **SUPERSEDED**                  |
| 11 | `:46-47` — *"certifying 1.5 as-is would stamp 'certified' on 31 anon-callable RPCs"* (31)                                                                                                                       | The Phase 1.5 security report states the exposure as **191 of 193** `SECURITY DEFINER` routines. This audit's recount gives **191 unique routines total**. The "31" figure is narrower — plausibly a count of a specific subset — and cannot be reconciled without the underlying working. **Neither number is contradicted; they are not the same measurement.** | Cannot reconcile | **SUSPENDED PENDING VERIFICATION** |

**Verdict on `SETURA_CLAUDE_REPORT.md`: UPHELD, with two claims superseded by
subsequent work and one narrowed.** It got the governance diagnosis right, named
the correct next phase, and was listened to. Its principal limitation is the one
it declares — it audited documents against code, not requirements against runtime
effect — which is exactly the gap the present audit was commissioned to close.

---

## 10. CONSOLIDATED CERTIFICATION DISPOSITION

### 10.1 Phase-level dispositions

| Artifact                                       | Self-declared                | THIS AUDIT'S DISPOSITION          | Sub-claims withdrawn | Claims suspended |
| ---------------------------------------------- | ---------------------------- | --------------------------------- | -------------------- | ---------------- |
| `AUDIT_REPORT.md` + `CROSS_CHECK_REPORT.md` (Phase 0) | ~85 % production-ready / "overwhelmingly honest" | **NARROWED**                      | **7**                | 0                |
| `PHASE_0.5_COMPLETION_REPORT.md`               | ✅ CERTIFIED                  | **UPHELD**                        | 0                    | 2                |
| `PHASE_1.1_COMPLETION_REPORT.md`               | ✅ CERTIFIED                  | **NARROWED**                      | **1**                | 2                |
| `PHASE_1.2_COMPLETION_REPORT.md`               | ✅ COMPLETE & CERTIFIED       | **UPHELD** (report) — roadmap requirement unbuilt | **1** (roadmap)      | 1                |
| `PHASE_1.3_COMPLETION_REPORT.md`               | ✅ COMPLETE & CERTIFIED       | **NARROWED**                      | 0                    | 1                |
| `PHASE_1.4_COMPLETION_REPORT.md`               | ✅ COMPLETE & CERTIFIED       | **NARROWED**                      | **2** (1 report + 1 roadmap) | 2        |
| `PHASE_1.5_RECOVERY_REPORT.md`                 | **NOT CERTIFIED**            | **UPHELD IN FULL**                | 0                    | 0                |
| `PHASE_1.5_SECURITY_AND_COMPLETION_REPORT.md`  | **CERTIFIED** + 3 disclosures | **NARROWED**                      | **4**                | **4**            |
| `SETURA_CLAUDE_REPORT.md`                      | Meta-audit, no certification  | **UPHELD** (2 superseded, 1 narrowed) | 0                | 1                |
|                                                |                              |                                   | **15**               | **12**           |

### 10.2 Certification changes — the answer to PART 21

| Change                                                    | Count  |
| --------------------------------------------------------- | ------ |
| Certifications **REVOKED**                                 | **0**  |
| Certifications **NARROWED** (phase stands, scope reduced)  | **5**  |
| Certifications **UPHELD** unchanged                        | **3**  |
| Named sub-claims **WITHDRAWN**                             | **15** |
| Claims **SUSPENDED PENDING VERIFICATION**                  | **12** |

**No phase certification is revoked.** Every phase delivered work that materially
matches what it said it delivered. The withdrawals are concentrated in two places
and both are structural:

- **Seven of fifteen** are in the Phase 0 audit documents, and every one is the
  same error: inferring that a mechanism is *wired* from evidence that it *exists*.
- **Two of fifteen** are roadmap requirements that no report ever claimed — they
  fell through the numbering gap (**D-01**) and were never asserted by anyone,
  which is why no gate caught them.

### 10.3 Where the certification process worked

Recorded because a reconciliation that lists only failures would misrepresent the
evidence:

| Evidence                                                                                                    | Significance                                                                                     |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `PHASE_1.5_RECOVERY_REPORT.md` **refused certification** and named four defects with SQLSTATEs                | The project's own gate said no when saying yes was available                                       |
| `SETURA_CLAUDE_REPORT.md` recommended a security remediation phase; **migrations 48 and 49 are that phase**   | An adversarial recommendation was accepted and executed, not argued with                          |
| `CROSS_CHECK_REPORT.md` **revised "~95 %" down to "~85 %"** unprompted                                       | Downward self-correction without external pressure                                                 |
| Phase 1.5 **added eight validator rules while certifying itself**                                            | The opposite of gaming a gate                                                                     |
| Phase 1.5 §19.3 **disclosed three unresolved items**, including one it could have omitted                     | The `has_permission` disclosure is the audit's own PART 14 finding, self-reported one phase earlier |
| **No AI/ML claim exists anywhere** despite a predictive-analytics feature                                     | Commercially unusual restraint in a 2026 healthcare product                                        |
| Phase 0.5 documented **three latent bugs its own suite surfaced**, including one from migration 13            | Evidence the tests do real work                                                                    |
| Four of Phase 1.5's eight gates **independently reproduced at HEAD**, unit tests matching **65/0 exactly**     | The only phase in the project whose gate results this audit could confirm directly                |

---

## 11. WHAT THIS RECONCILIATION DOES *NOT* CLAIM

1. **No phase is accused of dishonesty.** Every report discloses something against
   its own interest. The withdrawn sub-claims are inference errors and scope gaps,
   not misrepresentations. Where a report was wrong, it was wrong in the direction
   a careful engineer reading correct code would also have been wrong.

2. **The 12 suspended claims are not failures.** Nine of the twelve UNPROVEN rows in
   `CROSS_PHASE_REQUIREMENTS_MATRIX.md` are unverified claims rather than
   defects. **No certification should be granted or revoked on any of them in
   either direction.** They become answerable the moment Docker is available.

3. **The privilege boundary is not asserted to be open.** §8.2 #7 is
   **SUSPENDED**. Migration 48 is real work addressing a real, correctly-diagnosed
   exposure. Its effect has not been measured. Those are different statements from
   "it doesn't work."

4. **`has_permission()` is not called a vulnerability.** The audit's PART 14 verdict
   is **architecturally inconsistent** — explicitly not "needs redesign for security
   reasons." All 20 user-facing endpoints call `requireRole`; no cross-tenant
   escalation path was found; the affected RPCs are `service_role`-only. Phase 1.5's
   §19.3 disclosure 1 reached this conclusion first and set the correct gate.

5. **This document changed nothing.** No report was edited. No certification banner
   was altered in any file. The dispositions above are this audit's findings, not
   amendments to the artifacts (RULE 1, FINAL RULE).

---

**No source code, migration, test, configuration file or pre-existing report was
modified in the production of this reconciliation. No certification was rewritten
in place; every disposition here is recorded as a finding for the project's own
decision.**


