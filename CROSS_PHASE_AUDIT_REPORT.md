# SETURA — CROSS-PHASE ARCHITECTURE, REQUIREMENTS & GAP RECONCILIATION AUDIT

**Scope:** Phase 0 · Phase 0.5 · Phase 1.1 · Phase 1.2 · Phase 1.3 · Phase 1.4 · Phase 1.5
**Assessed at:** migration HEAD `49`
**Mode:** READ-ONLY — no source file, SQL migration, test, configuration file or
pre-existing document was modified at any point in this audit.
**Deliverable set:** this report ·
`CROSS_PHASE_REQUIREMENTS_MATRIX.md` · `CROSS_PHASE_GAP_REGISTER.md` ·
`ARCHITECTURAL_DRIFT_REGISTER.md` · `CERTIFICATION_RECONCILIATION.md` ·
`NEXT_PHASE_READINESS_REPORT.md`

---

## §0 — Method, and the two questions this audit answers

### 0.1 The questions

> **Q1.** After Phase 1.5, does the actual SETURA implementation satisfy
> everything SETURA promised to build from Phase 0 through Phase 1.5 — or are
> there requirements, contracts, integrations, security controls, operational
> capabilities or architectural commitments that were skipped, partially
> implemented, contradicted, duplicated or invalidated?

**Answer, stated once and in full at PART 24:** No. 74 of 147 audited
requirements are VERIFIED COMPLETE. 30 are partial, 12 unproven, 9 broken, 12
missing, 2 duplicated-conflicting, 3 out of scope, 5 awaiting a product
decision. The shortfall is not distributed evenly: the SQL and integrity layers
are materially stronger than the reports claim, and the *runtime activation*
layer is materially weaker.

> **Q2.** What must be completed before SETURA can safely move into the next
> major product/production phase?

**Answer, developed at PART 22 and `NEXT_PHASE_READINESS_REPORT.md` §15:** four
P0 gaps, all of them wiring or configuration rather than code; three
measurements currently blocked only by an unavailable Docker daemon; and six
product decisions, two of which engineering cannot take alone.

### 0.2 How evidence was treated

Per RULE 2, the ten certification-bearing artefacts were read as **evidence
sources, not truth**. A report stating CERTIFIED / 100 % / COMPLETE / PASS was
treated as a claim to be traced to source. Per RULE 3 each requirement was
followed along the full chain:

```
REQUIREMENT → IMPLEMENTATION → CALL PATH → DATABASE/RUNTIME EFFECT → TEST/EVIDENCE → STATUS
```

The chain matters because this audit's single most repeated finding is a break
at the third link. A routine exists; it is correct; nothing calls it. Under RULE
3's own warning — *a function existing is not proof that the feature works* —
that is not a completed requirement, and 41 routines plus 3 of the 4 P0 gaps sit
in exactly that position.

It is worth recording the inverse as well, because RULE 2 cuts both ways and
this audit found instances of both: **the reports are not systematically
wrong.** Where a claim was narrow and mechanical it usually held. The unit test
gate re-executed to an exact match (65/0). Phase 1.5's disclosures §19.3 and
§19.4 are honest and are upheld. `CROSS_CHECK_REPORT.md:60` understates the
double-booking protection rather than overstating it. The failures cluster in a
single identifiable class, named at §0.4.

### 0.3 What could not be verified, and why

Docker was unavailable for the entire audit window:

```
$ docker ps
error during connect: ... failed to connect to the docker API at
npipe:////./pipe/dockerDesktopLinuxEngine
```

Starting the Supabase stack would have been a state-changing action on a shared
resource, which RULE 1 forbids. Three consequences are carried honestly through
every part of this report and are never presented as PASS:

| Blocked verification | Recorded as |
|---|---|
| `pg_proc.proacl` for all 191 routines | UNPROVEN — PART 14 |
| `deno task test:integration` (162 cases) | UNPROVEN — PART 17 |
| Security regression suite (34 cases) | SUSPENDED PENDING VERIFICATION |

Five gates *were* executed, read-only, and their results appear throughout:

| Gate | Result |
|---|---|
| `deno task validate:migrations` | 49 files scanned, **0 errors, 4 warnings** |
| `deno fmt --check` | 259 files, exit 0 |
| `deno lint` | 75 files, clean |
| `deno task check` | 0 errors |
| `deno task test` (unit) | **65 passed / 0 failed (905 ms)** |

### 0.4 The mechanism behind most findings

One mechanism produced the majority of this audit's 48 gap entries and 30 drift
entries, and naming it early makes the rest of the report shorter.

> **A statement that a mechanism is *wired* was made on the basis of the
> mechanism *existing*.**

That sentence is derived in `CERTIFICATION_RECONCILIATION.md` §2 as the common
shape of all 15 withdrawn sub-claims, and it is visible in every P0:

- `reclaim_stale_jobs` exists → "crash recovery works" (P0-01)
- `run-cron-nightly` exists → "nightly cron runs seven workloads" (P0-02)
- the worker function exists → "the worker runs" (P0-03)
- `booking_fee_inr` exists and is populated in fixtures → "refunds compute from
  the booking fee" (P0-04)

None of these was dishonest. Each was written by someone reading the design and
finding the artefact present. The audit's contribution is not that the reports
lied — it is that **existence was accepted as wiring**, forty-one times in the
SQL surface and four times at P0 severity.

---

## PART 1 — ARCHITECTURE MAP AND SOURCE-OF-TRUTH MAP

### 1.1 What SETURA is, as built

A multi-tenant SaaS Hospital Operating System on Supabase, with business logic
deliberately pushed into the database.

| Layer | Technology | As built |
|---|---|---|
| Database | PostgreSQL **17** (`supabase/config.toml:36 major_version = 17`) | 49 migrations, 191 unique routines, RLS enabled and FORCED on tenant tables |
| Business logic | SQL `SECURITY DEFINER` routines, triggers, CHECK constraints, one GiST exclusion constraint | the system of record for every business rule and every number |
| API | 21 Deno Edge Functions | 20 user-facing (all authenticated and authorized) + 5 machine-to-machine, with overlap in the count explained at PART 12 |
| Shared code | 16 modules under `_shared/` | auth resolution, role selection, booking state machine, logging, validation, WhatsApp flow |
| Realtime | Supabase Realtime | `queue_runtime_events` published, RLS enabled and forced |
| Async | `job_queue` + `worker_registry` + `worker_job_leases` + `worker_heartbeat_log` + `dead_letter_jobs` | built; **not running** — PART 13 |
| Scheduling | intended cron | **absent** — P0-02 |
| Payments | Razorpay | order/capture/refund modelled; order creation not wired at booking — P1-05 |
| Messaging | Meta WhatsApp Cloud API | HMAC-SHA256 `X-Hub-Signature-256`, deterministic no-LLM intent router |

### 1.2 The architectural contract, and whether it held

Four commitments define the architecture. Each was tested directly.

| Contract | Verdict | Evidence |
|---|---|---|
| **Business logic lives in SQL; Edge Functions never recompute business numbers** | **HELD** | zero instances found of an Edge Function recomputing money or queue position |
| **Every mutation is auditable** | **HELD** for `audit_logs`, `financial_ledger`, `consultation_notes`, `queue_runtime_events`; asserted more broadly than enforced (P1-13) | `prevent_ledger_mutation` + `trg_ledger_no_update` / `trg_ledger_no_delete`; immutability trigger `43:100-124` |
| **Tenant isolation is enforced in the database, not the application** | **HELD** — no cross-tenant access path found | 4 RLS helpers: `is_global_admin()`, `current_user_role(uuid)`, `user_has_hospital_access(uuid)`, `user_has_hospital_role(uuid,text[])` |
| **Idempotency at every external boundary** | **HELD** | `idempotency_keys`, `api_idempotency_keys`, deterministic `enqueue_job` keys, `register_webhook_event_v2` + payload hash, refund replay guard (migration `41`, tested) |

All four core architectural commitments held. That is the most important
positive statement in this audit and it is placed first deliberately: the
failures documented in later parts are failures of *activation and reporting*
sitting on top of an architecture that did what it said it would do.

### 1.3 The privilege model

| Category | Count | Contents |
|---|---|---|
| A | 4 | RLS helper functions |
| B | 145 | internal routines |
| B-trigger | 10 | trigger functions |
| C | 10 | admin routines |
| D | 24 | financial and security-sensitive routines |
| **Claimed total** | **193** | per Phase 1.5 |
| **Independent recount** | **191 unique** | this audit |

The two-routine difference is a counting artefact — the categories sum to 193
while the catalog contains 191 distinct names. It is disclosed rather than
resolved, because resolving it would require the live catalog. It changes no
privilege conclusion.

### 1.4 Source-of-truth map

| Question | Authoritative source | Confidence |
|---|---|---|
| What the schema is | migrations `01`–`49` | **HIGH** — validator: 49 files, 0 errors |
| What a business rule is | the SQL routine implementing it | **HIGH** |
| What state a booking is in | `bookings` + `_shared/booking_state.ts` | **HIGH** |
| What money moved | `financial_ledger` (immutable) | **HIGH** as a record; **MEDIUM** as to correctness of the figures written (PART 15) |
| Whose data a row is | `hospital_id` + RLS | **HIGH** |
| What the queue is doing | `queue_sessions` + `queue_runtime_events` | **HIGH** |
| Whether a job ran | `job_queue`, `worker_heartbeat_log` | **LOW** — nothing schedules the producers (P0-02) |
| What a user may do | **contested — three sources** | **LOW** (§1.5) |
| What the booking fee was | **no runtime source** | **NONE** — P0-04 |
| What the phase history is | **contested** (§1.5) | **LOW** |

### 1.5 Competing sources of truth

PART 1 explicitly requires these to be named. There are six, and every one of
them is upstream of a P0 or P1 gap.

**(a) What a user may do — three incompatible answers.**

| Mechanism | Rule for a multi-role user |
|---|---|
| `has_permission()` | **union** — grants if any held role grants |
| `current_user_role(uuid)` | **least privilege** — resolves to the lowest role |
| `selectRole` (TypeScript) | **denies** — refuses to resolve the ambiguity |

Three answers to one question (drift D-06, gap P1-02, decision NPD-04). No
cross-tenant escalation results, but the system has no single definition of a
user's authority.

**(b) What the booking fee was.** `bookings.booking_fee_inr` was populated once
by migration `28` and has no runtime writer. `get_effective_fees` (v2, migration
`35`) computes the quoted fee. `get_booking_fee` handles GST and has **no
callers**. Three candidate sources, none of which is written at booking time
(P0-04, P2-02).

**(c) Forecast revenue — two implementations.** A materialized view computes it;
`get_revenue_forecast` (`47:1556`) recomputes it independently. Neither is
declared authoritative (drift D-16, gap P2-05).

**(d) Job claiming — v1 and v2 both present.** `claim_jobs` / `complete_job` /
`fail_job` / `register_webhook_event` coexist with their `_v2` replacements. The
v1 side has zero callers *and* contains the lease-assignment behaviour the v2
side lost (`06:283`). The dead code is the correct code (drift D-11, gap P2-13,
root cause of P0-01).

**(e) Queue state transitions — two owners.** `queue-control` and
`doctor-operations` both implement recall, skip, restore, `mark_absent` and
resume (gap P2-12).

**(f) The phase history itself.** `ROADMAP.md` contains **zero occurrences of
"1.5"**. The phase whose completion report certifies the system is not in the
roadmap that defines the phases (drift D-01). ROADMAP Phases 2 and 2.5 are
skipped with no recorded descope (D-02); ROADMAP Phase 3's conversational
booking was built early (D-03). `ARCHITECTURE.md` says PostgreSQL 15 against
`config.toml`'s 17 (D-21) and "37 migrations" against HEAD 49 (D-22).

### 1.6 Governing baseline artefacts

| Artefact | Role | Status as a source of truth |
|---|---|---|
| `ROADMAP.md` | phase definitions | **stale** — no "1.5", Phases 2/2.5 skipped |
| `ARCHITECTURE.md` | architecture of record | **stale** — PG 15, 37 migrations |
| `PHASE_1.5_SECURITY_AND_COMPLETION_REPORT.md` | most recent certification | **substantially reliable**, with 4 sub-claims withdrawn and 4 suspended |
| `CROSS_CHECK_REPORT.md` | independent prior review | **mixed** — honest in posture, wrong on three specifics |
| `SETURA_CLAUDE_REPORT.md` | narrative overview | **upheld** with 2 superseded, 1 narrowed |
| `migration_registry` (table) | migration governance | **5 of 49 rows (~10 %)** — P2-07 |

---

## PART 2 — PHASE-BY-PHASE CONTRACT RECONCILIATION

### 2.1 Reconciliation summary

| Phase | Requirements | Certification claim | Audit disposition | Regression from later phases |
|---|---|---|---|---|
| **0** | 19 (set F) | foundation complete | **NARROWED** — 7 sub-claims withdrawn | none |
| **0.5** | 10 (set Z) | schema frozen at `37` | **UPHELD** — its own sub-claim is true | **yes** — freeze breached by later migrations |
| **1.1** | 8 (set W) | WhatsApp engine complete | **NARROWED** | none |
| **1.2** | 7 (set R) | payments & refunds complete | **UPHELD** as report; roadmap refund-consistency requirement **withdrawn** | **yes** — refund states rendered unreachable |
| **1.3** | 9 (sets T/S) | security hardening complete | **NARROWED** | none |
| **1.4** | 9 (sets I/V) | queue runtime & ops complete | **NARROWED** — 2 withdrawals | **yes** — scheduling never landed |
| **1.5** | 19+5 (sets N/X) | **CERTIFIED** | recovery report **UPHELD IN FULL**; security report **NARROWED** (4 withdrawn, 4 suspended) | n/a — terminal phase |

**Certification changes: 0 REVOKED · 5 NARROWED · 3 UPHELD · 15 sub-claims
WITHDRAWN · 12 claims SUSPENDED.** Full derivation in
`CERTIFICATION_RECONCILIATION.md` §10.2.

Not one certification was revoked. That is a deliberate finding, not leniency:
per PART 21 a certification is revoked only when its central claim is false. In
every case examined the central claim was substantially true and specific
sub-claims about *wiring* were not.

### 2.2 The regression pattern

Three phases were regressed by work done after they were certified. In each case
the certification was correct when issued.

| Phase | Certified | Later broken by | Mechanism |
|---|---|---|---|
| 0.5 | schema frozen at `37` | migrations after `37` adding 5 tables, 17 columns, 1 enum value | no enforcement, no amendment process (D-04) |
| 1.2 | refund lifecycle | `payment_status_detail` refund states left unreachable — only writer `34:198` sets `'payment_captured'`, `confirm_refund_processed` never touches `bookings` | a state machine whose terminal states no writer can reach (finding 47) |
| 1.4 | queue runtime & ops | scheduling never delivered in 1.5 | operations certified without the scheduler that operates them (P0-02) |

Phase 1.2's regression is the most instructive. Its refund lifecycle **was**
implemented. A later change made the booking-level refund states unwritable, so
ROADMAP Phase 1.2 requirements R-01 and R-02 are classified **MISSING**, not
partial. The CHECK constraint still enumerates them, which is why the regression
was invisible: the schema advertises states the code cannot produce (drift
D-12).

### 2.3 Claim-by-claim reconciliation of the phase gate tables

The gate tables were read verbatim from each phase report. They are internally
consistent and the arithmetic checks out — the test counts increase
monotonically and each phase's total equals the previous plus the stated
increment.

| Phase | Migrations | `fmt` | `lint` | Unit | Integration | Validator warnings |
|---|---|---|---|---|---|---|
| 0.5 | 01→41 | 209 | 45 | 37/37 | 33/33 | "0 errors (3 pre-existing warnings)" |
| 1.1 | 01→42 | 218 | 53 | 37/37 | 61 = 33+28 | 3 |
| 1.2 | 01→44 | 225 | 57 | 37/37 | 77 = 61+16 | 3 |
| 1.3 | 01→45 (45/45) | 228 | 58 | 37/37 | 89 = 77+12 | "3 pre-existing warnings from migrations 11/15/20/22" |
| 1.4 | 01→46 (46/46) | 232 | 60 | 37/37 | 105 = 89+16 | 3 (same text) |
| 1.5 | 01→49 | pass | pass | **65/0** | **162/0** | pass |
| **this audit** | **01→49** | **259, exit 0** | **75, clean** | **65/0 (905 ms)** | **NOT RUN** | **4** |

Two observations.

**The unit figure reproduces exactly.** 65 passed / 0 failed, independently
re-executed. This is the strongest corroboration any phase report receives in
this audit, and it is why Phase 1.5's process claims — including *"No test was
deleted, no assertion weakened, no validator finding suppressed, and
`--no-check` was not used"* — are **upheld**.

**The warning count was correct at every report's own date and is now wrong.**
The validator emits 4:

| # | Warning | Migrations |
|---|---|---|
| 1 | `dashboard_presence` | 11 + 20 |
| 2 | `check_partition_readiness` | 15 + 22 |
| 3 | `partition_health` view | 15 + 22 |
| 4 | `idx_alert_events_open` | `24:140` + `47:83` |

Warning 4 arrives with migration `47`, i.e. during Phase 1.5. Every earlier
report saying "3" was accurate. The phrase became false by being copied forward
rather than re-run (drift D-26, gap P3-07). This is the audit's mildest finding
and its clearest miniature of the mechanism at §0.4.

---

## PART 3 — PHASE 0 AUDIT (Foundation)

**Requirement set F — 19 requirements. VERIFIED COMPLETE 13 · PARTIAL 2 ·
UNPROVEN 4. Certification: NARROWED (7 sub-claims withdrawn).**

### 3.1 What Phase 0 committed and delivered

| Commitment | Status | Evidence |
|---|---|---|
| Multi-tenant schema with `hospital_id` scoping | **VERIFIED** | present throughout migrations `01`–`03` |
| RLS enabled on tenant tables | **VERIFIED** | ENABLE + FORCE observed |
| Four RLS helper functions | **VERIFIED** | `is_global_admin()`, `current_user_role(uuid)`, `user_has_hospital_access(uuid)`, `user_has_hospital_role(uuid,text[])` |
| `audit_logs` append-only | **VERIFIED** | trigger-enforced |
| Booking state machine | **VERIFIED** | `_shared/booking_state.ts` + SQL transitions agree |
| Atomic token generation | **VERIFIED** | `generate_next_token()` single `INSERT … ON CONFLICT DO UPDATE … RETURNING` |
| DB-level double-booking prevention | **VERIFIED** | GiST exclusion constraint on `doctor_schedules`, migration `03` |
| Seed data for local development | **VERIFIED — exceeds the stated minimum** | seed content inspected |
| Structured logging, no stray `console` | **VERIFIED** | only 2 `console.*` in the codebase, both inside `logger.ts:92,94` |
| No error-detail leakage to clients | **VERIFIED** | zero raw `throw new Error(` in the 20 user-facing endpoints |
| Auth on every user-facing endpoint | **VERIFIED** | `resolveAuth` in all 20 |
| Role check on every user-facing endpoint | **VERIFIED** | `requireRole` in all 20 |
| CI pipeline | **VERIFIED — real and blocking** | inspected |
| Subscription/plan limits enforced | **PARTIAL** | `record_subscription_usage` is called from `create-booking`; **`check_booking_limit()` does not exist** (P2-01) |
| Idempotency at API boundary | **PARTIAL** | tables and key generation exist; not every mutating endpoint participates |
| RLS actually blocks cross-tenant reads at runtime | **UNPROVEN** | requires a live database |
| Grants restrict routine execution appropriately | **UNPROVEN** | requires `pg_proc.proacl` (PART 14) |
| Realtime authorization enforced at runtime | **UNPROVEN** | requires a live stack |
| Seeded environment boots end to end | **UNPROVEN** | Docker unavailable |

### 3.2 The withdrawn sub-claims, and the pattern they share

Seven Phase 0 sub-claims were withdrawn. Every one of them asserts that a
mechanism is *wired* on the basis of the mechanism *existing* — the §0.4
mechanism, appearing for the first time at the foundation layer. The clearest
example is subscription limits: `record_subscription_usage` records usage
faithfully, and the function that would *enforce* a limit,
`check_booking_limit()`, is not in the codebase. Usage is metered; nothing stops
at the meter.

### 3.3 Verdict

**Phase 0 delivered a genuinely sound foundation.** The four architectural
contracts at PART 1 §1.2 all trace back to Phase 0 decisions and all four held
through five subsequent phases — which is unusual and worth saying plainly. The
narrowing concerns claims about enforcement and runtime behaviour, not about the
structure. `CROSS_CHECK_REPORT.md:60`'s remark that the double-booking
protection is *"stronger than described"* is **upheld**: a GiST exclusion
constraint is a stronger guarantee than the prose around it suggests.

---

## PART 4 — PHASE 0.5 AUDIT (Schema Consolidation & Freeze)

**Requirement set Z — 10 requirements. VERIFIED COMPLETE 3 · PARTIAL 5 ·
UNPROVEN 1 · MISSING 1. Certification: UPHELD.**

### 4.1 The freeze, precisely

Phase 0.5 declared the schema frozen at migration `37` and claimed that its own
subsequent migrations contained no DDL. **That claim is true and was checked:
migrations `40`, `41` and `48` contain zero DDL statements.** Phase 0.5 kept its
own promise, which is why its certification is UPHELD rather than narrowed.

The freeze was nonetheless breached. After migration `37`, later work added:

| Added after the freeze | Count |
|---|---|
| Tables | 5 |
| Columns | 17 |
| Enum values | 1 |

There is **no amendment record** anywhere. The freeze had no enforcement
mechanism and no documented amendment process, so the breach was procedurally
invisible (drift D-04, gap P2-08).

This distinction is the substance of the finding. The failure is not that
someone ignored a freeze — it is that a freeze was declared as a *statement*
rather than implemented as a *control*, and a statement cannot be violated
loudly.

### 4.2 Migration governance

`migration_registry` is a well-designed table for recording migration
provenance. It contains **5 of 49 rows (~10 %)** — gap P2-07, drift D-09. A
governance artefact at 10 % coverage is worse than none, because its existence
implies coverage. This is the one requirement in set Z classified **MISSING**:
the registry as a *governance capability* was promised and does not function.

### 4.3 Verdict

Phase 0.5's consolidation work was real and its own commitments were met. The
requirement that failed is the one that had to survive future phases, and
nothing was built to make it survive them.

---

## PART 5 — PHASE 1.1 AUDIT (WhatsApp Messaging Engine)

**Requirement set W — 8 requirements. VERIFIED COMPLETE 6 · PARTIAL 2.
Certification: NARROWED.**

### 5.1 The retry contract — fully met

ROADMAP Phase 1.1 specified a retry contract in detail. It is the most
completely delivered requirement set in the audit, and each element was located:

| Element | Location | Status |
|---|---|---|
| Permanent-failure codes are not retried | `send-whatsapp-message/index.ts:285-290` (`permanentCodes`) | **VERIFIED** |
| Exponential backoff | `04:649` — `POWER(2, v_retry_count)::INTEGER` | **VERIFIED** |
| Terminal state after max attempts | `04:747` — `permanently_failed` | **VERIFIED** |
| Confirmation marker on success | `04:665` — `whatsapp_confirmation_sent` | **VERIFIED** |
| Webhook signature verification | `verifyMetaSignature()`, HMAC-SHA256 over `X-Hub-Signature-256` | **VERIFIED** |
| Deterministic intent routing, no LLM | router inspected; no AI/ML claim anywhere in the codebase | **VERIFIED** |
| Conversation state with TTL | `whatsapp_conversation_states`, 30-minute TTL | **VERIFIED** |
| Message delivery observable end to end | — | **PARTIAL** — the enqueue path is verified; delivery depends on the worker, which does not run (P0-03) |
| Template management | — | **PARTIAL** |

### 5.2 The narrowing

Phase 1.1's engine is correct and its retry semantics are exactly as specified.
What is narrowed is the claim that messages are *delivered*: `create-booking`
calls `enqueue_job` and `send_whatsapp_message`, the job lands in `job_queue`,
and then — per PART 13 — nothing drains the queue under the documented default
configuration. The engine is complete; its consumer is switched off.

### 5.3 Verdict

**The best-executed requirement set in the audit.** Where Phase 1.1 stated a
mechanical contract, the code implements it precisely, at citable line numbers.
It is narrowed only by a downstream failure it did not cause.

---

## PART 6 — PHASE 1.2 AUDIT (Payments, Refunds & Settlement)

**Requirement set R — 8 requirements. VERIFIED COMPLETE 2 · UNPROVEN 1 ·
BROKEN 3 · MISSING 2. Certification: report UPHELD; roadmap
refund-consistency requirement WITHDRAWN.**

This is the weakest requirement set in the audit — 2 of 8 verified — and the
only set where BROKEN and MISSING together outnumber everything else.

### 6.1 Requirement-by-requirement

| Req | Commitment | Status | Evidence |
|---|---|---|---|
| R-01 | booking-level refund state tracked | **MISSING** | `payment_status_detail` refund states are unreachable: sole writer `34:198` sets `'payment_captured'`; `confirm_refund_processed` never touches `bookings` |
| R-02 | refund lifecycle reflected on the booking | **MISSING** | same cause |
| R-03 | refund idempotency / no double refund | **VERIFIED** | migration `41` replay guard, genuinely tested |
| R-04 | ledger immutability | **VERIFIED** | `prevent_ledger_mutation` + both triggers |
| R-05 | refund amount consistent across paths | **BROKEN** | three paths, three bases (P1-10); partial refunds over-adjust settlement |
| R-06 | capture is idempotent and single-shot | **BROKEN** | `idempotent_capture_payment` (`16:421`) discards `capture_payment`'s BOOLEAN; re-capture window excludes only `('captured','refunded')`, so a partially refunded order is re-capturable (P2-03) |
| R-07 | settlement figures reflect actual gateway economics | **BROKEN** | gateway fee is always `ROUND(amount * 0.02, 2)` via the 4-arg overload at `34:249` (P2-04) |
| R-08 | reconciliation exact | **UNPROVEN** | `get_reconciliation_summary` has three defects surfacing at `financial-command-center:158`; correctness needs a live run |

### 6.2 Why the certification is nonetheless upheld

Phase 1.2's report claimed a refund *lifecycle* and a *ledger* — both exist and
the ledger is exemplary. The report did not claim that booking-level refund
states were reachable; the **ROADMAP** claimed that, and it is the roadmap
requirement that is withdrawn. Distinguishing these two is the whole point of
PART 21's instruction not to revoke casually: the report was accurate about what
it built.

### 6.3 The one certified statement that fully survives

Phase 1.5 §19.4: *"Financial counts mean what they say, with the ledger and the
frozen trigger untouched and reconciliation exact."* The ledger clause is
**upheld** — the trigger is intact and no mutation path exists. The counts clause
is **narrowed**, because several figures written into that correct ledger derive
from R-05, R-06, R-07 and P0-04.

---

## PART 7 — PHASE 1.3 AUDIT (Security Hardening)

**Requirement sets T (5) and S (8) — 13 requirements. T: VERIFIED 3 · PARTIAL 2.
S: VERIFIED 2 · PARTIAL 4 · MISSING 2. Certification: NARROWED.**

### 7.1 The two genuine security wins

**PostgREST `.or()` operator injection — closed.** Phase 1.3 identified and
fixed an operator-injection surface in `whatsapp_queue_flow.ts` through phone
sanitization and validation. The fix was verified present. This was a real
vulnerability and it is really closed.

**The `verifyMetaSignature()` rewrite.** Collapsed to a single success path,
covered by **18 test cases** in `tests/unit/webhook_signature.test.ts`, and the
trust boundary documented in `docs/security/WEBHOOK_SIGNATURE_BOUNDARY.md`. A
signature verifier with multiple success paths is a classic bypass surface;
single-path plus 18 tests plus a written boundary is the correct treatment. This
sub-claim is **upheld without qualification** — one of few in the audit.

### 7.2 What is narrowed or missing

| Item | Status | Reason |
|---|---|---|
| Routine execution restricted to intended roles | **MISSING as implemented** | the 54 `REVOKE … FROM PUBLIC` statements in migrations `27`–`46` are runtime no-ops — see PART 14 |
| Razorpay webhook signature verified with the webhook secret | **MISSING** | `verify-payment/index.ts:63` uses `RAZORPAY_KEY_SECRET`; `RAZORPAY_WEBHOOK_SECRET` appears nowhere in the repository (P1-01) |
| Consistent authorization model | **PARTIAL** | three coexisting rules (PART 14 §14.3) |
| Deactivated users lose access | **PARTIAL** | `has_permission()` ignores `profiles.is_active` |
| Error responses leak nothing | **PARTIAL** | true for the 20 user-facing endpoints; `alert-center` maps `42501` → 500 (P3-01) |
| Machine endpoints authenticate their callers | **PARTIAL** | designed; `verify_jwt=true` blocks them (P1-09), and the cron secret mismatch means one path has never succeeded |

### 7.3 Verdict

Phase 1.3 did real security work and closed a real vulnerability. Its narrowing
comes from one systematic error — the wrong privilege primitive, used 54 times —
and one specific error, the wrong webhook secret. Neither is a design failure;
both are verification failures, in that no test could distinguish the intended
outcome from the actual one.

---

## PART 8 — PHASE 1.4 AUDIT (Queue Runtime & Operations)

**Requirement sets I (12) and V (8) — 20 requirements. I: VERIFIED 5 · PARTIAL 2
· BROKEN 2 · MISSING 3. V: VERIFIED 0 · PARTIAL 1 · UNPROVEN 2 · BROKEN 1 ·
MISSING 4. Certification: NARROWED (2 withdrawals).**

Set V — operational capability — is the only set in the audit with **zero**
verified requirements. That is the single sharpest number in this report.

### 8.1 Queue runtime (set I) — the parts that work

| Capability | Evidence | Status |
|---|---|---|
| Concurrency-safe advancement | `advance_queue` with `SKIP LOCKED`, `02:603` | **VERIFIED** |
| Pause / delay | `queue_sessions` | **VERIFIED** |
| Client snapshot | `get_queue_snapshot` | **VERIFIED** |
| Immutable event trail | `record_queue_event` → `queue_runtime_events` | **VERIFIED** |
| Realtime delivery of queue events | `43:100-124`, published with ENABLE + FORCE RLS and an immutability trigger | **VERIFIED** |
| SLA refresh | `trigger_sla_refresh` exists | **PARTIAL** — unscheduled |
| Skip / restore semantics | implemented **twice** — `queue-control` and `doctor-operations` (P2-12) | **BROKEN as a contract** — two owners |
| Job type vocabulary enforced | `job_queue.job_type` has no CHECK, no enum, no FK (P2-15) | **BROKEN** |
| Partition automation | `check_partition_readiness()` returns *"Partitions will auto-create"*; nothing auto-creates them | **MISSING** (P2-06) |

### 8.2 Operations (set V) — zero verified

| Commitment | Status | Reason |
|---|---|---|
| Scheduled work runs | **MISSING** | nothing schedules anything (P0-02) |
| Crashed workers are detected and their jobs recovered | **MISSING** | `claim_jobs_v2` never sets `lease_expires_at`, which is the column `reclaim_stale_jobs` filters on (P0-01) |
| The worker runs in a default deployment | **MISSING** | `.env.example` ships `ENABLE_WORKER_TRIGGER=false` (P0-03) |
| Nightly maintenance executes | **MISSING** | unscheduled, and step 9 always 403 (PART 13 §13.4) |
| Health snapshots recorded | **BROKEN** | producer unscheduled |
| Alerts fire | **UNPROVEN** | no evidence any alert has ever fired |
| Analytics stay current | **UNPROVEN** | five MVs with zero consumers, refresh unscheduled (P2-05) |
| Operator can observe worker liveness | **PARTIAL** | `worker_registry` + 25 %-sampled heartbeats exist; nothing writes them on a schedule |

### 8.3 The two withdrawn sub-claims

Both come from `CROSS_CHECK_REPORT.md` §2.4 and both concern lease tracking:

1. *"claim_jobs_v2 (FOR UPDATE SKIP LOCKED, **lease tracking**, exponential
   backoff POWER(2, retry_count), dead-letter on max attempts)"* — every element
   is true **except** lease tracking.
2. *"worker_registry + heartbeat (25 % sampled) + detect_crashed_workers() +
   **lease reclaim** — verified in migration 19"* (`CROSS_CHECK_REPORT.md:175`)
   — the components exist; the reclaim cannot function.

The v1 implementation *did* set the lease, at `06:283`. The behaviour was lost
in the v1→v2 migration while the recovery code that depends on it was retained
unchanged. Both reviewers described the design; neither re-read the v2 body.

### 8.4 Verdict

Phase 1.4 built a correct queue and certified an operations layer that does not
operate. The queue itself is production-quality — `SKIP LOCKED`, immutable
events, Realtime with forced RLS. The operations layer has no scheduler, no
functioning recovery, and a worker disabled by default.

---

## PART 9 — PHASE 1.5 AUDIT (Security Sweep & Completion)

**Requirement sets N1–N5 (48) and X (15) — 63 requirements.
N1: VERIFIED 7 · PARTIAL 2 · UNPROVEN 1. **N2: VERIFIED 10 — a clean sweep.**
N3: VERIFIED 5 · PARTIAL 2 · BROKEN 1. N4: VERIFIED 5 · PARTIAL 1 · BROKEN 1 ·
DUPLICATED 1. N5: VERIFIED 4 · PARTIAL 3 · UNPROVEN 3 · BROKEN 1 · NPD 1.
X: VERIFIED 7 · PARTIAL 3 · DUPLICATED 1 · NPD 4.
Certification: recovery report UPHELD IN FULL; security report NARROWED (4
withdrawn, 4 suspended).**

### 9.1 The 193-routine privilege claim

Phase 1.5's central technical claim concerns the privilege posture of all
routines. Three findings, in order of importance.

**(a) The disclosure is honest and is upheld.** §19.4 states: *"191 of 193
SECURITY DEFINER functions directly executable from PostgREST by any holder of
the publishable anon key."* A report that discloses its own largest exposure in
its own certification section deserves explicit credit, and this one does.

**(b) The mechanism is now identified.** The 54 `REVOKE … FROM PUBLIC`
statements across migrations `27`–`46` are runtime no-ops, because Supabase
ships an installed default privilege:

```sql
ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS
  TO postgres, anon, authenticated, service_role;
```

`REVOKE … FROM PUBLIC` does not remove a grant made explicitly to `anon` and
`authenticated`. The wrong primitive was used, 54 times (drift D-07). The
validator's check 7 (`privilege-regression`, rules P1–P8,
`PRIVILEGE_BASELINE = 48`) counts statements and cannot evaluate their effect,
which is why the error survived a purpose-built validator.

**(c) One process sub-claim is inverted.** Phase 1.5 states the privilege work
was done *"per routine rather than catalog loop"*. Migration `48` §6 **is** a
`DO $$` loop. Migrations `42` (explicit REVOKE) and `46` (GRANT) do name
routines individually. So the claim is true of `42`/`46` and false of `48`, which
is the migration doing the bulk of the work (drift D-08). Phase 1.5's own
correction in the same section — *"the accurate count is 179 of 193 routines
changed, not 193"* — is upheld and is exactly the kind of self-correction that
raises a report's credibility.

### 9.2 Set N2 — ten of ten

One requirement set in the entire audit is fully verified with no
qualifications: N2. It covers the code-quality and hygiene commitments —
formatting, linting, typechecking, logging discipline, no error leakage, no
committed secrets, no destructive DDL, monotonic test growth, no `--no-check`,
CI blocking. Each was independently re-executed or inspected. All ten hold.

This matters for interpreting the rest of the audit: Phase 1.5's *process*
discipline is demonstrably real. The failures elsewhere are not sloppiness. They
are the §0.4 mechanism — verifying existence instead of wiring — applied
diligently.

### 9.3 The recovery report — upheld in full

`PHASE_1.5` recovery report's five claims all hold, including the four carried
product decisions (D-1 multi-role resolution, D-2 JWT/HMAC boundary, D-3 DCE
payment counts, D-4 `system_settings`). Carrying a known decision forward
explicitly, with an identifier, is correct practice. This audit adds two more:
NPD-01 (GST) and NPD-02 (revenue recognition).

### 9.4 The four suspended claims

| Claim | Why suspended |
|---|---|
| `deno task test:integration` 162/0 | never executed — Docker unavailable |
| Security regression suite 34/0 | never executed |
| Privilege posture as measured | requires `pg_proc.proacl` |
| RLS enforcement at runtime | requires a live database |

SUSPENDED is not FAIL. Each is count-verified or code-verified statically; only
execution is missing. Per PART 27 they are recorded as UNPROVEN rather than
either PASS or FAIL, and they form Gate 4 of the recommended next phase.

### 9.5 Verdict

Phase 1.5's **FINAL VERDICT: CERTIFIED** is narrowed, not revoked. Its process
claims are upheld and one of them reproduced exactly (65/0 unit). Its
disclosures are honest. What is withdrawn is a set of statements that mechanisms
were wired: the privilege revocations did not take effect, the lease tracking
does not exist, the scheduler does not exist, and the booking-fee writer does
not exist.

---

## PART 10 — END-TO-END WORKFLOW RECONCILIATION

Six workflows were traced step by step against source. Each is reported as the
chain actually implemented, with the break points marked. None was executed —
Docker was unavailable — so every workflow verdict is a **static trace**.

### 10.1 Workflow A — Normal patient journey

```
patient arrives → staff creates booking → token issued → checked in →
waiting → called → in consultation → completed
```

| Step | Implementation | Status |
|---|---|---|
| Auth + role | `resolveAuth` + `requireRole` in `create-booking` | **WORKS** |
| Zod validation | present | **WORKS** |
| Idempotency | `api_idempotency_keys` | **WORKS** |
| Doctor availability | `is_doctor_available` | **WORKS** |
| Capacity | `get_remaining_token_capacity` | **WORKS** |
| Token issue | `create_booking` → `generate_next_token()` atomic upsert | **WORKS** |
| Fee quotation | `get_effective_fees` | **WORKS** (excludes GST — P2-02) |
| **Fee persistence** | **none** | **BREAKS** — `booking_fee_inr` has no writer (P0-04) |
| **Payment order** | **none** | **BREAKS** — zero payment references in 688 lines (P1-05) |
| Subscription usage | `record_subscription_usage` | **WORKS** (records; does not enforce — P2-01) |
| Audit | `audit_logs` | **WORKS** |
| WhatsApp enqueue | `enqueue_job` + `send_whatsapp_message` | **WORKS** to the queue |
| **WhatsApp delivery** | worker | **BREAKS** — worker disabled by default (P0-03) |
| Queue progression | `advance_queue` (`SKIP LOCKED`), `queue_sessions`, `record_queue_event` | **WORKS** |
| Realtime to clients | `queue_runtime_events` published | **WORKS** |
| Revenue recognition | `13:479` at booking INSERT; DCE for every booking (migration `07`, no `WHEN`) | **WORKS mechanically; questionable as policy** — NPD-02 |

**Verdict: the clinical path works; the commercial path does not.** A patient can
be booked, queued, called and completed correctly. The fee is quoted and then
neither stored nor collected, and the confirmation message is queued and never
sent.

### 10.2 Workflow B — WhatsApp patient journey

| Step | Implementation | Status |
|---|---|---|
| Inbound webhook | Meta Cloud API → HMAC-SHA256 `X-Hub-Signature-256` | **WORKS** |
| Signature verification | `verifyMetaSignature()`, single success path, 18 tests | **WORKS — exemplary** |
| Phone sanitization | `whatsapp_queue_flow.ts` (Phase 1.3 injection fix) | **WORKS** |
| Intent routing | deterministic, no LLM | **WORKS** |
| Conversation state | `whatsapp_conversation_states`, 30-min TTL | **WORKS** |
| Booking via conversation | built — and this is **ROADMAP Phase 3** work delivered early (drift D-03) | **WORKS** |
| **Payment order in the WhatsApp path** | **none** | **BREAKS** — same as A |
| Outbound reply | `enqueue_job` → worker | **BREAKS** — worker disabled |

**Verdict: inbound works end to end; outbound does not leave the queue.** The
webhook, verification, routing and state machine are all sound. A patient who
messages the hospital is understood correctly and receives no reply.

### 10.3 Workflow C — Doctor delay

| Step | Implementation | Status |
|---|---|---|
| Staff records a delay | `queue_sessions` pause/delay | **WORKS** |
| Wait estimates adjust | `estimate_wait_minutes` | **WORKS** |
| Event recorded | `record_queue_event` → immutable trail | **WORKS** |
| Realtime notification to clients | `queue_runtime_events` | **WORKS** |
| **Proactive WhatsApp notification to waiting patients** | queued | **BREAKS** — worker disabled |
| SLA breach detection | `trigger_sla_refresh` exists | **BREAKS** — unscheduled (P0-02) |
| Alert to operator | `alert-center` | **UNPROVEN** — no evidence any alert has fired; `42501` → 500 (P3-01) |

**Verdict: the in-app experience degrades gracefully; every outbound channel is
silent.** This is the workflow where P0-02 and P0-03 combine into the worst
patient-visible outcome: the hospital knows about the delay, the system records
it correctly, and nobody tells the patients.

### 10.4 Workflow D — Cancellation and refund

| Step | Implementation | Status |
|---|---|---|
| Cancellation accepted | booking state → `cancelled` | **WORKS** |
| Refund initiated | refund path entered | **WORKS** |
| **Refund amount computed** | 2 of 3 paths read `booking_fee_inr` | **BREAKS** — no runtime writer (P0-04) |
| **Refund basis consistent** | three paths, three bases | **BREAKS** — P1-10 |
| Double-refund prevention | migration `41` replay guard | **WORKS — tested** |
| Ledger entry | immutable `financial_ledger` | **WORKS** |
| **Booking-level refund state** | `payment_status_detail` refund states unreachable | **BREAKS** — R-01/R-02 MISSING |
| Settlement adjustment | full refunds correct; **partial refunds over-adjust** | **BREAKS** — P1-10, untested (`refund_sync.test.ts` covers full only) |
| `confirm_refund_processed` | does not touch `bookings` | **BREAKS** — the booking never learns |

**Verdict: the most defective workflow in the system.** Five break points, four
of them financial. A real patient refund today would be computed from an
unpopulated column, on an inconsistent basis, and would leave no trace on the
booking record. The one thing that reliably works is the guarantee it will not
happen twice.

### 10.5 Workflow E — Queue failure and recovery

| Step | Implementation | Status |
|---|---|---|
| Concurrent advance safety | `advance_queue` + `SKIP LOCKED` (`02:603`) | **WORKS** |
| Duplicate token prevention | atomic upsert | **WORKS** |
| Event trail survives failure | immutable `queue_runtime_events` | **WORKS** |
| Job retry with backoff | `POWER(2, retry_count)` | **WORKS** — when a job fails normally |
| Dead-letter on exhaustion | `dead_letter_jobs` | **WORKS** — when a job fails normally |
| **Worker crash detected** | `detect_crashed_workers()` exists | **BREAKS** — no caller |
| **Crashed worker's job reclaimed** | `reclaim_stale_jobs` filters `lease_expires_at`; `claim_jobs_v2` never sets it | **BREAKS** — P0-01 |
| Operator learns of the loss | — | **BREAKS** — the detection path is the dead path |

**Verdict: the queue survives concurrency; it does not survive a crash.** The
distinction is exact and important. Two staff members advancing the same queue
simultaneously is handled correctly by the database. A worker process dying
mid-job strands that job permanently, silently, with no retry, no dead-letter and
no alert.

### 10.6 Workflow F — Hospital executive reporting

| Step | Implementation | Status |
|---|---|---|
| Collections view | `daily_collection_entries` | **WORKS mechanically** — DCE created for every booking regardless of payment (migration `07`, no `WHEN`) |
| Revenue | recognised at booking INSERT (`13:479`) | **QUESTIONABLE** — NPD-02 |
| Outstanding balances | `outstanding_balances` | **WORKS** |
| Settlements | `hospital_settlements` + `settlement_items` | **PARTIAL** — gateway fee always estimated (P2-04) |
| Reconciliation summary | `get_reconciliation_summary` | **BREAKS** — three defects surface at `financial-command-center:158` |
| Platform revenue | `create_platform_revenue_summary` (`33:176`) | **WORKS** — advisory-lock design, correctly applied |
| Analytics / KPIs | five MVs | **BREAKS** — zero consumers, refresh unscheduled (P2-05) |
| Revenue forecast | MV **and** `get_revenue_forecast` (`47:1556`) | **DUPLICATED-CONFLICTING** — neither declared authoritative |
| GST position | `gst_debit` written by `capture_payment`; never charged | **BREAKS** — P2-02 / NPD-01 |

**Verdict: an executive would be shown numbers that are internally consistent and
externally wrong.** Every figure traces to a real ledger entry. The ledger
entries derive from a fee that was never persisted, a tax never collected, and a
gateway fee that is a fixed 2 % estimate.

### 10.7 Workflow reconciliation summary

| Workflow | Steps traced | Break points | Verdict |
|---|---|---|---|
| A — normal patient journey | 16 | 3 | clinical path works, commercial path does not |
| B — WhatsApp journey | 8 | 2 | inbound works, outbound silent |
| C — doctor delay | 7 | 3 | in-app degrades well, all outbound silent |
| D — cancellation and refund | 9 | 5 | most defective workflow |
| E — queue failure and recovery | 8 | 3 | survives concurrency, not crashes |
| F — executive reporting | 9 | 4 | consistent numbers, wrong inputs |
| **Total** | **57** | **20** | — |

Twenty break points across six workflows, and they reduce to **five root
causes**: P0-01 (crash recovery), P0-02 (no scheduler), P0-03 (worker off),
P0-04 (no fee writer) and P1-05/P1-10 (payment order and refund basis). Fix
five things and eighteen of the twenty break points close.

---

## PART 11 — DATABASE AND RPC RECONCILIATION INVENTORY

### 11.1 Surface counts

| Measure | Value |
|---|---|
| Migrations | 49 (`01` → `49`), sequential, no gaps |
| Validator result | 49 files scanned, **0 errors, 4 warnings** |
| Unique SQL routines (independent recount) | **191** |
| Routines claimed by Phase 1.5 | 193 |
| Largest migrations | `48` = 1,469 lines · `49` = 900 lines (Phase 1.5 Appendix A) |
| Destructive statements (`DROP TABLE` / `DROP COLUMN` / destructive `ALTER`) | **zero** |

### 11.2 Reachability — the headline number

| Class | Count | % of 191 |
|---|---|---|
| Reachable from an Edge Function, another routine, a trigger, or a cron path | 139 | 73 % |
| **No caller anywhere** | **41** | **21 %** |
| **Referenced only by tests** | **11** | **6 %** |
| **Unreachable in production** | **52** | **27 %** |

Ten of the eleven test-only routines are exercised *solely* by `REVOKE`
assertions in `tests/unit/privilege_isolation.test.ts`. The only property proven
about them is that they are not publicly executable — and per PART 14 even that
assertion tests a statement whose runtime effect is unproven. Nothing proves any
of the ten computes correctly.

One methodological note, recorded because it changed a number: an earlier pass
mis-classified `register_webhook_event` as test-only, because a substring grep
matched `register_webhook_event_v2`. A word-boundary search shows v1 exists at
`04_whatsapp_messaging_engine.sql:667` and `:701`, plus
`database.generated.ts:7005`. The corrected tally is the one above: **41
NOCALLER + 11 TESTONLY = 52 of 191**.

### 11.3 Orphans, duplicates and dead code

**Duplicate v1/v2 pairs — four, with zero v1 callers:**

| v1 | v2 | Note |
|---|---|---|
| `claim_jobs` | `claim_jobs_v2` | **v1 sets `lease_expires_at` at `06:283`; v2 does not** — root cause of P0-01 |
| `complete_job` | `complete_job_v2` | — |
| `fail_job` | `fail_job_v2` | — |
| `register_webhook_event` | `register_webhook_event_v2` | v2 adds payload hashing |

The first row is the audit's sharpest irony: **the dead code is the correct
code.**

**Orphaned job types:**

| Job type | Problem |
|---|---|
| `create_partition` | **claimable but unhandled** — a worker can claim it and no handler exists |
| `refresh_analytics` | **zero producers** |
| `send_notification` | **zero producers** |

And `job_queue.job_type` has **no CHECK, no enum, no FK** (P2-15), so this
vocabulary is enforced nowhere.

**Dead orchestration:** the SQL routine `run_nightly_tasks` has no caller —
nightly work is driven from the `run-cron-nightly` Edge Function instead (P2-12).

**Duplicated computation:** five materialized views have zero consumers, and one
of them is duplicated in logic by `get_revenue_forecast` (`47:1556`) — P2-05,
drift D-16.

**Broken reference in a comment:** `stop_worker` references
`recover_crashed_worker_jobs`, which does not exist (P3-10, drift D-25).

**Non-existent function referenced as a requirement:** `check_booking_limit()`
is required for subscription-limit enforcement and does not exist (P2-01).

### 11.4 Dead migrations

No migration is dead in the sense of never applying — all 49 apply and the
validator parses all 49. Three migrations are notable:

| Migration | Note |
|---|---|
| `28` | one-time backfill of `booking_fee_inr` — **the only thing that ever writes the column** (P0-04) |
| `40`, `41`, `48` | contain **zero DDL** — Phase 0.5's freeze sub-claim is true of these |
| `49` | internally self-inconsistent (P3-08, drift D-30) |

18 of 49 migrations lack explicit `BEGIN;` / `COMMIT;` (P3-04, drift D-29).
Supabase wraps each file in a transaction, so this is a consistency matter rather
than a safety one.

---

## PART 12 — EDGE FUNCTION RECONCILIATION

21 Edge Functions. All 20 user-facing functions call both `resolveAuth` and
`requireRole` — verified with a plain `grep -n "requireRole"` after a
single-line pattern produced 10 false negatives. The five machine-to-machine
functions are the only place raw `throw new Error(` appears (all 24
occurrences), which is the correct distribution.

### 12.1 Reconciliation table

| Function | Purpose | Auth | Hospital scope | Key RPCs | Tables touched | Worker/cron | Tests | Status |
|---|---|---|---|---|---|---|---|---|
| `create-booking` | create booking + token | `resolveAuth` + `requireRole` | scoped | `create_booking`, `enqueue_job`, `estimate_wait_minutes`, `get_effective_fees`, `get_remaining_token_capacity`, `is_doctor_available`, `record_subscription_usage`, `send_whatsapp_message` | `bookings`, `job_queue`, `audit_logs` | produces jobs | integration | **PARTIAL** — no payment order (P1-05), no fee persisted (P0-04) |
| `queue-control` | queue advance / pause / recall / skip / restore | scoped | scoped | `advance_queue`, `record_queue_event`, session RPCs | `queue_sessions`, `queue_runtime_events` | — | integration | **PARTIAL** — overlaps `doctor-operations` (P2-12) |
| `doctor-operations` | doctor-side recall / skip / restore / `mark_absent` / resume | scoped | scoped | queue + session RPCs | same as above | — | integration | **PARTIAL** — duplicate owner (P2-12) |
| `verify-payment` | Razorpay webhook + capture | **HMAC** | derived | capture/ledger RPCs | `payments`, `financial_ledger`, `payment_orders` | — | unit | **BROKEN** — `:63` uses `RAZORPAY_KEY_SECRET` (P1-01) |
| `whatsapp-webhook` | Meta inbound | **HMAC-SHA256** | derived from phone | intent + state RPCs | `whatsapp_conversation_states`, `bookings` | produces jobs | 18 signature tests | **VERIFIED** |
| `send-whatsapp-message` | outbound send + retry | machine | scoped | retry/state RPCs | `whatsapp_messages`, `job_queue` | **worker-driven** | unit | **VERIFIED** logic; **unreachable** (P0-03) |
| `settlement-engine` | settlements | scoped | scoped | settlement RPCs; `record_payment` | `hospital_settlements`, `settlement_items` | — | integration | **PARTIAL** — `record_payment` **always 500** (deprecated migration `33`, throws `:418`) |
| `financial-command-center` | finance dashboards | scoped | scoped | `get_reconciliation_summary` | ledger, DCE, settlements | — | integration | **BROKEN** — three defects surface at `:158` |
| `alert-center` | operational alerts | scoped | scoped | alert RPCs | `alert_events` | — | — | **PARTIAL** — `42501` → 500 (P3-01) |
| `run-cron-minute` | minute scheduler entry | machine | all | scheduler + health RPCs | `job_queue`, health tables | **is the cron entry** | — | **UNREACHABLE** — nothing schedules it (P0-02) |
| `run-cron-nightly` | nightly maintenance (7 workloads) | machine | all | carry-forward, MV refresh, rollups, SLA, retention, partitions | many | **is the cron entry** | — | **UNREACHABLE** (P0-02); step 9 always 403; `:296` violates the "must NOT wake worker" prohibition (D-05) |
| `run-background-worker` | job worker loop | machine + `CRON_SECRET` | all | `claim_jobs_v2`, `complete_job_v2`, `fail_job_v2` | `job_queue`, `worker_registry`, `dead_letter_jobs` | **is the worker** | — | **BROKEN** — no lease set (P0-01); off by default (P0-03); `verify_jwt` blocks it (P1-09); `:301` expects `CRON_SECRET` |
| Remaining 9 user-facing functions | patient / doctor / admin / analytics reads and writes | `resolveAuth` + `requireRole` (all) | scoped | assorted | assorted | — | mixed | **VERIFIED** for auth/authz; individual features per their requirement rows |

### 12.2 Hardcoded India assumptions

Present and undeclared (P3-09, drift D-27):

| Assumption | Where it shows |
|---|---|
| Currency INR | `booking_fee_inr` column name, fee columns, ledger amounts |
| GST as the tax model | `gst_debit` ledger line, `get_booking_fee` |
| Indian phone-number format | WhatsApp phone sanitization/validation |
| IST-oriented day boundaries | daily collection entries, nightly rollups |
| Razorpay as the only gateway | `verify-payment`, settlement fee estimate |

None of these is wrong for the current market. All five are undeclared in
`ARCHITECTURE.md`, which for a product positioned as multi-tenant SaaS makes
them latent scope, not design.

### 12.3 Stale comments

| Comment | Location | Problem |
|---|---|---|
| references `recover_crashed_worker_jobs` | `stop_worker` | the function does not exist (P3-10) |
| *"Partitions will auto-create"* | `check_partition_readiness()` | nothing auto-creates them (P2-06) |
| deprecation note | migration `33` → `record_payment` | accurate, but the caller in `settlement-engine` was never updated (D-20) |

---

## PART 13 — WORKER AND CRON RECONCILIATION

The mandated chain is: **producer → queue → worker → handler → retry →
exhaustion → recovery.** Traced link by link.

### 13.1 The chain

| Link | Implementation | Status |
|---|---|---|
| **Producer** | `enqueue_job` with deterministic idempotency keys, called from `create-booking` and the WhatsApp path | **WORKS** |
| **Queue** | `job_queue` | **WORKS** — but `job_type` unconstrained (P2-15) |
| **Scheduler** | *nothing* | **MISSING — P0-02** |
| **Worker trigger** | `ENABLE_WORKER_TRIGGER`, shipped `false` in `.env.example` | **MISSING — P0-03** |
| **Worker auth** | `verify_jwt=true` on all 7 machine endpoints | **BLOCKED — P1-09** |
| **Claim** | `claim_jobs_v2`, `FOR UPDATE SKIP LOCKED` | **WORKS for claiming; never sets `lease_expires_at`** |
| **Handler** | handlers exist for the produced job types | **PARTIAL** — `create_partition` claimable but unhandled |
| **Retry** | `POWER(2, retry_count)` exponential backoff | **WORKS** |
| **Exhaustion** | `dead_letter_jobs` on max attempts | **WORKS** |
| **Recovery** | `reclaim_stale_jobs` filters `lease_expires_at`; `detect_crashed_workers()` has no caller | **DEAD — P0-01** |
| **Heartbeat** | `worker_heartbeat_log`, 25 % sampled; `worker_registry` | **WORKS mechanically; never runs** |
| **Lease config** | `WORKER_LEASE_SECS` | **DEAD KNOB** — read nowhere (P3-03) |

Three independent stoppages sit between the queue and the worker: no scheduler,
worker disabled by default, and `verify_jwt` rejecting the caller. Each alone is
sufficient to prevent the async layer from running.

### 13.2 P0-01 in full — the lease regression

| # | Fact | Location |
|---|---|---|
| 1 | v1 `claim_jobs` **set** `lease_expires_at` | `06:283` |
| 2 | v2 `claim_jobs_v2` **does not** | v2 body |
| 3 | `reclaim_stale_jobs` selects on `lease_expires_at` | v2 recovery |
| 4 | ⇒ the reclaim predicate matches nothing, ever | derived |
| 5 | The v2 recovery routines have **zero callers** regardless | reachability scan |
| 6 | `stop_worker` names `recover_crashed_worker_jobs`, absent | drift D-25 |
| 7 | `CROSS_CHECK_REPORT.md:175` certifies *"lease reclaim — verified in migration 19"* | withdrawn |
| 8 | `CROSS_CHECK_REPORT.md` §2.4 credits `claim_jobs_v2` with *"lease tracking"* | withdrawn |
| 9 | `WORKER_LEASE_SECS` exists as a tunable for the mechanism that does not exist | P3-03 |

The regression is a *removal*, not an omission — the behaviour was present in
v1, was not carried into v2, and the dependent recovery code was left untouched.
Nine artefacts around it continued to describe a working lease system, including
a configuration knob for tuning it.

### 13.3 What the async layer would do if switched on

Recorded so the next phase's expectations are calibrated. With P0-02, P0-03 and
P1-09 fixed, and P0-01 unfixed, the layer would: drain the queue, deliver
WhatsApp messages, retry transient failures with correct backoff, dead-letter
exhausted jobs — and **permanently strand any job whose worker died
mid-execution**, invisibly. That last property is why P0-01 must be fixed in the
same phase as P0-02 and P0-03, not after them.

### 13.4 The nightly chain

| Step | Status |
|---|---|
| Carry-forward | code correct, **never runs** |
| MV refresh (`CONCURRENTLY`, dependency order) | code correct — **verified as correct** — never runs |
| Rollups | never runs |
| SLA refresh | never runs |
| Retention | never runs |
| Partition checks | never runs; and would only *advise* (P2-06) |
| Health snapshot | never runs |
| **Step 9 — wake the worker** | **always 403** — `run-cron-nightly:296` sends `SUPABASE_SERVICE_KEY.slice(-20)`; `run-background-worker:301` expects `CRON_SECRET` |

Step 9 carries a second finding. Phase 2's architecture states the nightly cron
**must NOT wake the worker**. `run-cron-nightly:296` wakes the worker. So the
call is simultaneously **prohibited by the architecture and broken in
implementation** (drift D-05, rated HIGH). The prohibition has never been
observably violated in a running system only because the call has never
succeeded — which is not a control, it is a coincidence.

---

## PART 14 — FRESH SECURITY REVIEW

Conducted independently of every prior security report, then reconciled against
them.

### 14.1 Controls verified present and correct

| Control | Evidence | Status |
|---|---|---|
| Authentication on all 20 user-facing endpoints | `resolveAuth` in all 20 | **VERIFIED** |
| Authorization on all 20 | `requireRole` in all 20 | **VERIFIED** |
| WhatsApp webhook signature | `verifyMetaSignature()`, HMAC-SHA256, single success path | **VERIFIED** |
| Signature test depth | 18 cases, `tests/unit/webhook_signature.test.ts` | **VERIFIED** |
| Trust boundary documented | `docs/security/WEBHOOK_SIGNATURE_BOUNDARY.md` | **VERIFIED** |
| PostgREST `.or()` operator injection | closed in Phase 1.3 | **VERIFIED** |
| RLS enabled **and forced** on tenant tables | inspected | **VERIFIED statically** |
| Cross-tenant data access | **none found** | **VERIFIED — no path exists** |
| No secrets committed | inspected | **VERIFIED** |
| No error-detail leakage from user-facing endpoints | zero raw `throw new Error(` in the 20 | **VERIFIED** |
| No LLM in the trust path | deterministic router; no AI/ML claim anywhere | **VERIFIED** |
| Append-only audit trail | `audit_logs` trigger-enforced | **VERIFIED** |

**The single most important security finding in this audit is negative: no
cross-tenant data access path exists.** For a multi-tenant system holding
hospital data, that is the finding that would end the assessment if it went the
other way. It held under deliberate search across RLS policies, RPC bodies and
Edge Function query construction.

### 14.2 `has_permission()` — the explicit verdict PART 14 requires

> **VERDICT: ARCHITECTURALLY INCONSISTENT.**

Stated in the mandated vocabulary, and — per the mandate — **nothing was
changed.**

Not "safe": it has a live defect (§14.2c). Not "unsafe" in the escalation sense:
no cross-tenant path exists and tenant scoping is correct. Not merely "needs
redesign": the function is a faithful implementation of *one* of three
incompatible rules the system holds simultaneously.

**(a) The inconsistency.**

| Mechanism | Rule for a user holding multiple roles | Consequence |
|---|---|---|
| `has_permission()` | **union** — grant if *any* held role grants | most permissive answer |
| `current_user_role(uuid)` | **least privilege** — resolve to the lowest role | most restrictive answer |
| `selectRole` (TypeScript) | **deny** — refuse to resolve the ambiguity | no answer |

Three mechanisms, one question, three answers. Which one governs a given request
depends on which layer happens to ask. That is the inconsistency, and it is a
design decision that was never taken (NPD-04, carried from D-1; drift D-06).

**(b) Phase 1.5's own disclosure is upheld.** §19.3 states, in its own words:

> *"`has_permission` unions permissions across every role a user holds… It must
> be resolved before any of those RPCs is granted to `authenticated`."*

That is an accurate statement of the risk, made voluntarily in a certification
document. It is upheld in full.

**(c) One finding the disclosure does not contain.** **`has_permission()` ignores
`profiles.is_active`.** A deactivated user's permissions still resolve. This is
not a design question — it is a defect, it is independent of the multi-role
decision, and it should not wait for that decision to be taken.

**(d) A related untested hazard.** The seed sets all four profile rows to
`is_primary: true`. No test covers the zero-primary case — the lockout case. If a
hospital reaches zero primary profiles, nothing in the test suite says what
happens.

### 14.3 The privilege exposure — mechanism identified, effect UNPROVEN

Phase 1.5 §19.4 discloses: *"191 of 193 SECURITY DEFINER functions directly
executable from PostgREST by any holder of the publishable anon key."*

**Why the revocations do not bite.** Supabase ships an installed default
privilege:

```sql
ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS
  TO postgres, anon, authenticated, service_role;
```

The 54 `REVOKE … FROM PUBLIC` statements across migrations `27`–`46` revoke from
`PUBLIC`. They do not touch a grant made explicitly to `anon` and
`authenticated`. **The wrong primitive was used, 54 times** (drift D-07).

**Why a purpose-built validator missed it.** `scripts/validate_migrations.ts`
check 7 (`privilege-regression`, rules P1–P8, `PRIVILEGE_BASELINE = 48`) counts
`REVOKE` statements. Counting statements is not evaluating their effect. The
validator was correct about what it measured.

**Status: UNPROVEN — neither PASS nor FAIL.** Confirming this requires querying
`pg_proc.proacl` on a live database, which Docker being down made impossible. The
static reading is strong and the mechanism is well understood, but a privilege
conclusion of this consequence must come from the catalog. It is recorded as
SUSPENDED PENDING VERIFICATION in `CERTIFICATION_RECONCILIATION.md` §8.2 rather
than asserted.

The consequence for the test suite is worth spelling out: 10 of the 11 test-only
routines are covered *solely* by `REVOKE` assertions in
`privilege_isolation.test.ts`. Those assertions test that a statement was
written, not that access is denied. If §14.3's reading is correct, the test suite
is asserting the presence of an ineffective control.

### 14.4 Confirmed security defects

| # | Defect | Location | Severity |
|---|---|---|---|
| 1 | Razorpay webhook HMAC uses `RAZORPAY_KEY_SECRET`; `RAZORPAY_WEBHOOK_SECRET` appears nowhere | `verify-payment/index.ts:63` | **P1-01** |
| 2 | Three incompatible authorization rules | §14.2 | **P1-02** |
| 3 | `has_permission()` ignores `profiles.is_active` | §14.2c | **P1-02** |
| 4 | `verify_jwt=true` blocks all 7 machine endpoints | config | **P1-09** |
| 5 | `CRON_SECRET` mismatch — service-key suffix sent, `CRON_SECRET` expected | `run-cron-nightly:296` / `run-background-worker:301` | **P1** |
| 6 | 54 ineffective privilege revocations | migrations `27`–`46` | **P1**, effect UNPROVEN |
| 7 | `42501` mapped to HTTP 500 instead of 403 | `alert-center` | **P3-01** |

P1-01 deserves one more sentence because it fails in two opposite directions.
Razorpay signs webhooks with a webhook-specific secret. If the two secrets differ
in production, every webhook fails verification and no payment is ever confirmed.
If an operator sets them equal to make it work, the inbound webhook trust
boundary becomes anchored on the same credential used for outbound API calls.
Neither outcome is acceptable, and the code cannot tell you which one is
happening — only a real webhook delivery can.

### 14.5 What was searched for and not found

Recorded because absence of a finding is only meaningful if the search is stated.

| Searched | Result |
|---|---|
| Cross-tenant data access | **none found** |
| SQL injection in dynamic SQL | **none found** |
| Additional PostgREST operator injection beyond the closed `.or()` case | **none found** |
| Committed secrets | **none found** |
| Signature-verification bypass paths in `verifyMetaSignature()` | **none found** — single success path |
| Double-refund path | **none found** — migration `41` guard holds |
| Ledger mutation path | **none found** — trigger intact |
| Destructive DDL | **none found** across 49 migrations |
| AI/ML in the trust path | **none found** — no such claim anywhere |

---

## PART 15 — FINANCIAL INTEGRITY

The mandated chain: **booking fee → payment order → verification → ledger →
refund → settlement → outstanding balance.** Traced as one continuous path.

### 15.1 The chain, with break points

| Link | Implementation | Status |
|---|---|---|
| Fee resolution | `get_effective_fees` (v2, migration `35`) | **WORKS** — but excludes GST |
| **Fee persistence** | `bookings.booking_fee_inr` | **BROKEN — P0-04**, backfilled once by migration `28`, no runtime writer |
| **Payment order creation** | absent from `create-booking` (688 lines, zero payment references) | **MISSING — P1-05** |
| Payment order model | `payment_orders` | exists |
| Gateway verification | `verify-payment` webhook | **BROKEN — P1-01** wrong secret |
| Capture | `capture_payment` (BOOLEAN) | works |
| Idempotent capture | `idempotent_capture_payment` (`16:421`) | **BROKEN** — discards the BOOLEAN |
| Re-capture guard | window excludes only `('captured','refunded')` | **BROKEN — P2-03** — a partially refunded order is re-capturable |
| Ledger write | `financial_ledger`, immutable | **WORKS — exemplary** |
| Refund initiation | `payment_refunds` | works |
| **Refund amount** | 2 of 3 paths read `booking_fee_inr` | **BROKEN — P0-04** |
| **Refund basis** | three paths, three bases | **BROKEN — P1-10** |
| Double-refund guard | migration `41` replay guard | **WORKS — tested** |
| **Booking-level refund state** | `payment_status_detail` refund states unreachable | **MISSING** — R-01/R-02 |
| Settlement | `hospital_settlements` + `settlement_items` | **PARTIAL** — partial refunds over-adjust |
| Gateway fee | always `ROUND(amount * 0.02, 2)`, 4-arg overload `34:249` | **BROKEN — P2-04** |
| `record_payment` in settlement engine | deprecated migration `33`, throws `:418` | **BROKEN — always 500** (D-20) |
| Outstanding balances | `outstanding_balances` | **WORKS** |
| Reconciliation | `get_reconciliation_summary` | **BROKEN** — three defects at `financial-command-center:158` |
| Platform revenue | `create_platform_revenue_summary` (`33:176`) | **WORKS** — advisory lock, correctly applied |

### 15.2 The three integrity questions the mandate asks explicitly

**Is there a double-capture path?** One: P2-03's re-capture window, which
requires a partially refunded order. No other path found.

**Is there a double-refund path?** **No.** Migration `41`'s replay guard is real
and is properly tested. This is one of the audit's cleanest positives.

**Is there ledger duplication?** **No** path found beyond the P2-03 consequence.
The ledger is immutable (`prevent_ledger_mutation`, `trg_ledger_no_update`,
`trg_ledger_no_delete`), and no mutation route exists.

### 15.3 GST — booked but never charged

| Fact | Location |
|---|---|
| `capture_payment` writes a `gst_debit` ledger line | capture body |
| `get_effective_fees` (v2, migration `35`) **excludes GST** from the quoted amount | migration `35` |
| `get_booking_fee`, which *does* handle GST, has **zero callers** | reachability scan |

So the ledger records a tax component that was never collected from any patient
(P2-02). For an India deployment this is a tax-position question with a finance
owner, not an engineering bug — hence **NPD-01**. The fee resolver diverged from
the fee model (drift D-15) and the divergence is invisible because both halves
are individually coherent.

### 15.4 Revenue recognition — an unstated policy

| Fact | Location |
|---|---|
| Revenue recognised at booking INSERT | `13:479` |
| A daily collection entry is created for **every** booking, no `WHEN` clause | migration `07` |
| No payment order exists at booking time | P1-05 |

The system therefore recognises revenue for bookings that have no attached
collection mechanism (drift D-14, **NPD-02**). Whether that is right depends on a
revenue-recognition policy nobody has stated. This and NPD-01 are the two items
in the entire audit that engineering **cannot** settle alone.

### 15.5 What the certified financial claim actually supports

Phase 1.5 §19.4: *"Financial counts mean what they say, with the ledger and the
frozen trigger untouched and reconciliation exact."*

| Clause | Disposition |
|---|---|
| *"the ledger and the frozen trigger untouched"* | **UPHELD** — verified: trigger intact, no mutation path |
| *"Financial counts mean what they say"* | **NARROWED** — the counts are faithful records of figures derived from P0-04, P1-10, P2-02, P2-03 and P2-04 |
| *"reconciliation exact"* | **WITHDRAWN** — `get_reconciliation_summary` has three defects |

The distinction is the whole of PART 15 in one line: **the ledger is
trustworthy as a record and the numbers written into it are not yet trustworthy
as facts.** Because the record is immutable, that is a correctable problem —
which is materially better than the alternative.

---

## PART 16 — ANALYTICS AND KPI SOURCE TRACING

Every KPI was traced to the artefact that produces it.

| KPI / metric | Source | Refreshed by | Consumer | Status |
|---|---|---|---|---|
| Daily collections | `daily_collection_entries` | trigger, migration `07` (every booking, no `WHEN`) | `financial-command-center` | **WORKS mechanically**; counts bookings, not payments (D-3 / NPD-03) |
| Revenue (recognised) | `13:479` at booking INSERT | trigger | dashboards | **QUESTIONABLE** — NPD-02 |
| Outstanding balances | `outstanding_balances` | RPC | dashboards | **WORKS** |
| Settlement totals | `hospital_settlements`, `settlement_items` | settlement engine | `settlement-engine` | **PARTIAL** — estimated gateway fee |
| Platform revenue | `create_platform_revenue_summary` (`33:176`) | advisory-locked routine | admin | **WORKS** |
| Reconciliation summary | `get_reconciliation_summary` | on demand | `financial-command-center:158` | **BROKEN** — three defects |
| **Revenue forecast** | **two sources**: a materialized view **and** `get_revenue_forecast` (`47:1556`) | MV: nightly (unscheduled) / function: on demand | unclear | **DUPLICATED-CONFLICTING** — neither declared authoritative (P2-05, D-16) |
| Queue SLA metrics | `trigger_sla_refresh` | nightly | dashboards | **STALE** — unscheduled (P0-02) |
| Queue history | `queue_runtime_events` (immutable) | live | Realtime + reports | **WORKS** |
| Worker health | `worker_heartbeat_log` (25 % sampled), `worker_registry` | worker | ops views | **EMPTY** — worker never runs |
| Rollups | nightly rollup routines | nightly | dashboards | **STALE** — unscheduled |
| Five materialized views | MVs | nightly `REFRESH … CONCURRENTLY`, dependency order (**verified correct**) | **zero consumers** | **ORPHANED** — P2-05 |

### 16.1 The two structural findings

**Five materialized views have zero consumers.** They are refreshed correctly —
`CONCURRENTLY`, in dependency order, which is the right implementation — to serve
nothing. Meanwhile `get_revenue_forecast` recomputes one of their results live.
Two implementations of forecast revenue, no declared winner.

**Every derived metric is stale by construction.** With P0-02 open, nothing
refreshes anything. Dashboards would render, and they would render whatever was
last computed — which for MV-backed metrics is whatever the last manual
invocation produced. This is the failure mode most easily mistaken for a working
system.

### 16.2 KPI trustworthiness summary

| Trust level | Metrics |
|---|---|
| **Trustworthy** | queue history, outstanding balances, platform revenue |
| **Mechanically correct, semantically undecided** | daily collections (NPD-03), recognised revenue (NPD-02) |
| **Stale by construction** | SLA metrics, rollups, all five MVs, worker health |
| **Defective** | reconciliation summary, settlement gateway fee, revenue forecast (two sources) |

---

## PART 17 — TEST QUALITY AUDIT

PART 17 asks *"does the test suite provide meaningful evidence?"* — not *"how
many tests exist?"*. Both questions are answered, in that order.

### 17.1 Gates independently re-executed

| Gate | Phase 1.5 claim | This audit | Disposition |
|---|---|---|---|
| `deno task test` (unit) | 65/0 | **65 passed / 0 failed (905 ms)** | **EXACT MATCH — UPHELD** |
| `deno task test:integration` | 162/0 | **NOT RUN** (162 cases count-verified statically) | **UNPROVEN** |
| Security regression suite | 34/0 | not run | **SUSPENDED** |
| `deno task validate:migrations` | pass | 49 files, **0 errors, 4 warnings** | **UPHELD**, warning count corrected |
| `deno fmt --check` | pass | 259 files, exit 0 | **UPHELD** |
| `deno lint` | pass | 75 files, clean | **UPHELD** |
| `deno task check` | pass | 0 errors | **UPHELD** |

The unit match is the strongest corroboration any report receives in this audit.
An independently re-executed gate reproducing a reported figure exactly is
qualitatively different from re-reading the report, and it is the main reason
`CERTIFICATION_RECONCILIATION.md` narrows rather than revokes.

### 17.2 The integrity claim — upheld

Phase 1.5 §19.1: *"No test was deleted, no assertion weakened, no validator
finding suppressed, and `--no-check` was not used."* Checked independently:

| Check | Result |
|---|---|
| Test counts across phase gates | monotonic — 37 → 61 → 77 → 89 → 105 → 227 (65 unit + 162 integration) |
| `--no-check` in task definitions | absent |
| `deno task check` | 0 errors |
| Validator suppressions | none found; 4 warnings emitted and visible |

**UPHELD.** It is a narrow claim and it is true.

### 17.3 Where the suite fails to provide evidence — P2-14

This is the finding that decides the dimension. **The test suite is absent at
every defect site.** Not thin — absent.

| Defect | Test situation |
|---|---|
| **P0-01** crash recovery dead | no killed-worker test exists anywhere |
| **P0-02** nothing scheduled | no test asserts a schedule exists |
| **P0-03** worker off by default | no test exercises the documented default configuration |
| **P0-04** no fee writer | `tests/integration/whatsapp_conversational.test.ts:838` asserts on `booking_fee_inr` against a **fixture-populated** row and **passes** |
| **P1-01** wrong webhook secret | no test uses a real Razorpay webhook signature |
| **P1-10** refund basis | `tests/integration/refund_sync.test.ts` covers **full refunds only** — the partial case, where the paths diverge, is untested |
| **P1-02** authorization inconsistency | no test asserts which of the three rules governs |
| Privilege posture | 10 of 11 test-only routines covered **solely** by `REVOKE` assertions in `privilege_isolation.test.ts` — asserting a statement exists, not that access is denied |
| `is_primary` lockout | seed sets all 4 rows `is_primary: true`; zero-primary case untested |

The P0-04 row is the most instructive in the audit. A test asserts the correct
value on a row whose value came from fixture data rather than from the production
write path. The test passes. The production write path does not exist. This is
RULE 3's warning — *a test existing is not proof that the test is valid* —
realised precisely.

### 17.4 Test quality verdict

| Question | Answer |
|---|---|
| Do the tests run? | **Yes** — unit reproducibly, 65/0 in 905 ms |
| Are they honestly reported? | **Yes** — §17.2 upheld |
| Are they well written where they exist? | **Yes** — 18 signature cases and the migration-`41` replay guard test are genuinely good work |
| Do they cover the paths that matter? | **No** — nine defect sites, zero coverage |
| Would they have caught any of the four P0s? | **No.** Not one. |
| Does the suite provide meaningful evidence? | **Partially.** It provides strong evidence about the code that works and no evidence about the code that does not. |

The suite's problem is **placement, not volume**. Adding tests anywhere other
than the nine sites above would raise the count without raising confidence,
which is why `NEXT_PHASE_READINESS_REPORT.md` §15.3 explicitly rules out a
test-count exercise.

---

## PART 18 — MIGRATION AND SCHEMA HISTORY AUDIT (01 → 49)

### 18.1 Overall health

| Measure | Result |
|---|---|
| Migrations | 49, sequential `01`–`49`, no gaps, no duplicates |
| Validator | 49 files scanned, **0 errors**, 4 warnings |
| Destructive statements | **zero** across all 49 |
| Applies cleanly from scratch | reported PASS by every phase gate; validator independently confirms all 49 parse |
| Largest | `48` = 1,469 lines · `49` = 900 lines |
| Missing explicit transaction wrapping | 18 of 49 (P3-04) |
| Recorded in `migration_registry` | **5 of 49 (~10 %)** (P2-07) |

Zero destructive statements across 49 migrations in a system that has been
through six phases of change is a genuinely strong governance outcome, and it is
worth stating because it is the exact opposite of the usual finding.

### 18.2 The four validator warnings

| # | Warning | Migrations | Nature |
|---|---|---|---|
| 1 | `dashboard_presence` | 11 + 20 | redefinition |
| 2 | `check_partition_readiness` | 15 + 22 | redefinition |
| 3 | `partition_health` view | 15 + 22 | redefinition |
| 4 | `idx_alert_events_open` | `24:140` + `47:83` | duplicate index definition |

Warning 4 arrives with migration `47` (Phase 1.5). Every report before that
correctly said 3; the phrase became stale by copy-forward (P3-07, D-26).

### 18.3 Migrations with audit significance

| Migration | Significance |
|---|---|
| `01`–`03` | foundation: multi-tenant schema, RLS helpers, **GiST exclusion constraint on `doctor_schedules`** |
| `02` | `advance_queue` with `SKIP LOCKED` at `:603` |
| `04` | WhatsApp engine: backoff `:649`, confirmation marker `:665`, v1 `register_webhook_event` `:667`/`:701`, `permanently_failed` `:747` |
| `06` | **v1 `claim_jobs` sets `lease_expires_at` at `:283`** — the behaviour lost in v2 |
| `07` | DCE trigger for **every** booking, no `WHEN` clause |
| `13` | revenue recognised at booking INSERT, `:479` |
| `16` | `idempotent_capture_payment` at `:421` discards the BOOLEAN |
| `19` | worker registry / heartbeat / `detect_crashed_workers()` — the migration `CROSS_CHECK_REPORT.md:175` cites as verifying lease reclaim |
| `24` | `idx_alert_events_open` first definition, `:140` |
| `27` | `role_permissions`: `MANAGE_HOSPITAL` to both admin roles, `:77` and `:97` |
| `27`–`46` | **54 `REVOKE … FROM PUBLIC` statements — runtime no-ops** |
| `28` | **one-time backfill of `booking_fee_inr` — the only thing that ever writes it** |
| `33` | `record_payment` deprecated (`settlement-engine` never updated); `create_platform_revenue_summary` at `:176` |
| `34` | `payment_status_detail` sole writer at `:198` → `'payment_captured'`; gateway fee 4-arg overload at `:249` |
| `35` | `get_effective_fees` v2 — **excludes GST** |
| `37` | **the Phase 0.5 freeze point** |
| `40`, `41`, `48` | **zero DDL** — Phase 0.5's own sub-claim is true |
| `41` | refund replay guard — real and tested |
| `42` | explicit per-routine REVOKE (supports the "per routine" claim) |
| `43` | `queue_runtime_events` Realtime + ENABLE/FORCE RLS + immutability trigger, `:100-124` |
| `46` | per-routine GRANT (supports the "per routine" claim) |
| `47` | `idx_alert_events_open` duplicate `:83`; `get_revenue_forecast` at `:1556` duplicating an MV |
| `48` | 1,469 lines; **§6 is a `DO $$` catalog loop** — contradicts the "per routine rather than catalog loop" claim |
| `49` | 900 lines; internally self-inconsistent (P3-08) |

### 18.4 The freeze, in migration terms

| Fact | Value |
|---|---|
| Freeze declared at | migration `37` |
| DDL added after `37` | **5 tables, 17 columns, 1 enum value** |
| Amendment record | **none** |
| Phase 0.5's own post-freeze migrations (`40`, `41`, `48`) | **0 DDL — claim true** |

The freeze was a declaration, not a control. Nothing enforced it and nothing
recorded its breach (P2-08, D-04).

---

## PART 19 — ARCHITECTURAL DRIFT

Full register: `ARCHITECTURAL_DRIFT_REGISTER.md` — 30 entries with the mandated
columns (Drift | Location | Risk | Severity | Recommended future action).

### 19.1 Distribution

| Severity | Count | IDs |
|---|---|---|
| **HIGH** | 12 | D-01, D-02, D-03, D-04, D-05, D-06, D-11, D-13, D-14, D-17, D-18, D-19 |
| **MEDIUM** | 8 | D-07, D-08, D-09, D-10, D-12, D-15, D-16, D-20 |
| **LOW** | 10 | D-21 … D-30 |
| **Total** | **30** | row sum verified |

### 19.2 The twelve HIGH drifts

| ID | Drift |
|---|---|
| D-01 | phase renumbering — `ROADMAP.md` contains **zero occurrences of "1.5"** |
| D-02 | ROADMAP Phases 2 and 2.5 skipped with no recorded descope |
| D-03 | ROADMAP Phase 3 conversational booking built early |
| D-04 | schema freeze breached, never amended |
| D-05 | `run-cron-nightly:296` violates the documented "must NOT wake worker" prohibition |
| D-06 | three coexisting role-resolution rules |
| D-11 | four v1 RPCs retained; **v1 `claim_jobs` sets the lease at `06:283`, v2 does not** |
| D-13 | `booking_fee_inr` backfill-only |
| D-14 | revenue recognised at booking INSERT (`13:479`) |
| D-17 | nothing schedules anything |
| D-18 | `.env.example` ships `ENABLE_WORKER_TRIGGER=false` |
| D-19 | `verify-payment/index.ts:63` uses `RAZORPAY_KEY_SECRET` |

### 19.3 The finding that matters most about drift

`ARCHITECTURAL_DRIFT_REGISTER.md` §2.3 establishes drift → P0 traceability:

| P0 | Upstream drift |
|---|---|
| P0-01 crash recovery dead | **D-11** — v1→v2 retention without deprecation, lease lost in transit |
| P0-02 nothing scheduled | **D-17** |
| P0-03 worker off by default | **D-18** |
| P0-04 no fee writer | **D-13** |

> **None of the four P0s is a coding error.**

Each is a consequence of an architectural commitment that decayed without anyone
recording the decay. That is why the recommended next phase is *activation and
verification* rather than remediation: there is very little wrong with the code
that was written, and a great deal missing from the wiring between the pieces.

Drift is not the same as a defect. **Drift is how defects survive.**

---

## PART 20 — MISSED, SKIPPED AND PARTIAL REQUIREMENTS

**This is the critical part.** Per the mandate, each item was traced back to its
**earliest** promise, and no requirement was assumed to have disappeared merely
because the latest roadmap does not mention it.

### 20.1 Ten commitments that are silently outstanding

Each was promised, none was delivered, and **none is recorded anywhere as
descoped, deferred or cancelled**. Silence is the finding.

| # | Commitment | Earliest promise | Current state | Ever descoped? |
|---|---|---|---|---|
| 1 | Scheduled execution of maintenance and queue upkeep | **Phase 0** (operational foundation) | **MISSING** — no scheduler exists (P0-02) | **No record** |
| 2 | Crashed-worker job recovery | **Phase 1.4** (ops) — mechanism present since migration `19` | **BROKEN** — lease never set (P0-01) | **No record**; instead *certified as working* |
| 3 | Subscription / plan limit enforcement | **Phase 0** (multi-tenant SaaS model) | **MISSING** — `check_booking_limit()` does not exist (P2-01) | **No record** |
| 4 | Booking fee persisted on the booking | **Phase 1.2** | **BROKEN** — backfill only (P0-04) | **No record** |
| 5 | Payment order created for a booking | **Phase 1.2** | **MISSING** from `create-booking` (P1-05) | **No record**; instead *described as a step in a 16-step flow* |
| 6 | Booking-level refund state | **Phase 1.2** (ROADMAP R-01/R-02) | **MISSING** — states unreachable | **No record** |
| 7 | Automatic partition creation | **Phase 1.4** | **MISSING** — advisory only, and the advice is false (P2-06) | **No record** |
| 8 | Migration governance registry populated | **Phase 0.5** | **PARTIAL** — 5 of 49 (P2-07) | **No record** |
| 9 | GST charged to the patient | **Phase 1.2** (fee model) | **MISSING** — booked, never charged (P2-02) | **No record** — needs NPD-01 |
| 10 | Materialized views consumed by a reporting surface | **Phase 1.4** | **MISSING** — five MVs, zero consumers (P2-05) | **No record** |

### 20.2 Requirements invalidated by later work

Distinct from the above: these *were* delivered and were then broken by
subsequent change.

| Requirement | Delivered in | Invalidated by | Now |
|---|---|---|---|
| Job lease tracking | Phase 1.4 (`06:283`, v1) | the v1→v2 rewrite | **BROKEN** — P0-01 |
| Schema freeze at `37` | Phase 0.5 | post-`37` DDL: 5 tables, 17 columns, 1 enum value | **BREACHED** — P2-08 |
| Booking refund states | Phase 1.2 | `34:198` writing only `'payment_captured'`; `confirm_refund_processed` never touching `bookings` | **UNREACHABLE** |
| `record_payment` in the settlement engine | earlier phase | deprecation in migration `33` without updating the caller | **ALWAYS 500** — D-20 |
| "Nightly must NOT wake the worker" | Phase 2 architecture | `run-cron-nightly:296` | **VIOLATED** (and broken) — D-05 |

### 20.3 Requirements delivered ahead of schedule

Recorded for completeness, because scope drift runs in both directions and PART
20 asks for the full picture.

| Delivered | Belonged to | Note |
|---|---|---|
| WhatsApp conversational booking | **ROADMAP Phase 3** | built during Phase 1.x (D-03). Working, and genuinely good work — but it means Phase 3 scope is partly consumed while Phase 2 scope is entirely unaddressed |

### 20.4 Phases skipped without record

| Phase | ROADMAP status | Actual |
|---|---|---|
| Phase 2 | defined | **skipped** — no descope record (D-02) |
| Phase 2.5 | defined | **skipped** — no descope record (D-02) |
| Phase 3 | defined | **partly built early** (D-03) |
| Phase 1.5 | **not in ROADMAP at all** — zero occurrences of "1.5" | certified complete (D-01) |

The last row is the cleanest single illustration of governance drift in the
audit: **the phase that certifies the system does not appear in the document
that defines the phases.**

### 20.5 What PART 20 establishes

Ten outstanding commitments, five invalidated requirements, two skipped phases,
one phase built early, and one certified phase absent from the roadmap — **and
not one descope record among them.** No document anywhere says "we decided not
to build the scheduler", "we decided GST would not be charged", or "we decided
subscription limits would not be enforced". Each of those may well be a
reasonable decision. None of them was recorded as one, which means nobody
currently knows whether they were decisions or omissions.

---

## PART 21 — CERTIFICATION CLAIM RECONCILIATION

Full detail: `CERTIFICATION_RECONCILIATION.md`. Summary here.

### 21.1 Disposition

| Artefact | Claims examined | Outcome |
|---|---|---|
| Phase 0 report | 12 | **NARROWED** — 7 sub-claims withdrawn |
| Phase 0.5 report | 9 | **UPHELD** |
| Phase 1.1 report | 8 | **NARROWED** |
| Phase 1.2 report | 7 | **UPHELD** (roadmap requirement withdrawn separately) |
| Phase 1.3 report | 9 | **NARROWED** |
| Phase 1.4 report | 9 | **NARROWED** — 2 withdrawals |
| Phase 1.5 recovery report | 5 | **UPHELD IN FULL** |
| Phase 1.5 security & completion report | 19 | **NARROWED** — 4 withdrawn, 4 suspended |
| `CROSS_CHECK_REPORT.md` | — | **MIXED** — honest in posture, wrong on three specifics |
| `SETURA_CLAUDE_REPORT.md` | 11 | **UPHELD** — 2 superseded, 1 narrowed |

### 21.2 Certification changes

| Change | Count |
|---|---|
| **REVOKED** | **0** |
| **NARROWED** | **5** |
| **UPHELD** | **3** |
| Sub-claims **WITHDRAWN** | **15** |
| Claims **SUSPENDED PENDING VERIFICATION** | **12** |

**Zero revocations is a deliberate finding, not deference.** Per PART 21 a
certification is revoked when its central claim is false. In every case examined
the central claim was substantially true, and it was specific *sub-claims about
wiring* that failed. Revoking Phase 1.4's certification, for example, would
assert that no queue runtime was built — which would be false and would
misdirect the next phase.

### 21.3 The pattern shared by all 15 withdrawn sub-claims

Derived in `CERTIFICATION_RECONCILIATION.md` §2 and restated here because it is
the audit's central conclusion about process:

> **Every withdrawn sub-claim is a statement that a mechanism is *wired*, made on
> the basis of the mechanism *existing*.**

Not one withdrawn sub-claim was fabricated. Each was written by someone who
found the artefact present and inferred the connection. The inference was wrong
41 times in the SQL surface and 4 times at P0 severity.

### 21.4 Where the certification process demonstrably worked

It would be a distorted audit that listed only failures, so these are recorded
explicitly:

| Evidence that certification worked |
|---|
| Phase 1.5 disclosed its own largest exposure: *"191 of 193 SECURITY DEFINER functions directly executable from PostgREST"* |
| Phase 1.5 corrected its own count in the same document: *"the accurate count is 179 of 193 routines changed, not 193"* |
| Phase 1.5 disclosed the `has_permission` union risk **and** stated the precondition for granting to `authenticated`|
| The unit gate reproduced **exactly** (65/0), independently re-executed |
| The test-integrity claim (§19.1) is true under independent check |
| Phase 0.5's own freeze sub-claim is true — migrations `40`/`41`/`48` contain zero DDL |
| Four product decisions (D-1…D-4) were carried forward explicitly with identifiers rather than silently dropped |
| `CROSS_CHECK_REPORT.md:60` **understated** the double-booking protection — a report erring toward modesty |

### 21.5 Where prior review failed

| Report | Claim | Reality |
|---|---|---|
| `CROSS_CHECK_REPORT.md` §2.1 | 16-step flow including *"payment order"* | `create-booking` is 688 lines with **zero** payment references |
| `CROSS_CHECK_REPORT.md` §2.4 | `claim_jobs_v2` has *"lease tracking"* | it does not |
| `CROSS_CHECK_REPORT.md:175` | *"lease reclaim — verified in migration 19"* | reclaim cannot fire |
| `CROSS_CHECK_REPORT.md` §2.4 | *"Minute cron runs… nightly cron runs…"* | nothing schedules either |
| `CROSS_CHECK_REPORT.md:31` | *"Nothing in the codebase contradicts the… security claims"* | 54 ineffective revocations; wrong webhook secret |
| All phase reports 0.5–1.4 | *"3 pre-existing warnings"* | 4 (correct at each report's own date) |

`CROSS_CHECK_REPORT.md:13` describes the codebase as *"overwhelmingly honest and
accurate"* and `:17` revises 95 % down to *"realistically ~85 %"*. The posture was
right — the report was appropriately sceptical and named four real gaps. It
failed on the same axis as everything else: it verified that things existed.

---

## PART 22 — PRODUCTION READINESS

Full assessment with evidence and gate conditions:
`NEXT_PHASE_READINESS_REPORT.md`. Scorecard reproduced here.

| # | Dimension | Verdict | Blocking gaps |
|---|---|---|---|
| 1 | Backend architectural completeness | **CONDITIONALLY READY** | P2-11, P2-12, P2-13 |
| 2 | Backend functional completeness | **NOT READY** | P0-04, P1-05, P1-10 |
| 3 | Data integrity & schema governance | **CONDITIONALLY READY** | P1-13, P2-08, P2-09 |
| 4 | Security posture | **NOT READY** | P1-01, P1-02, P1-09 |
| 5 | Authorization & tenancy | **CONDITIONALLY READY** | P1-02, NPD-04 |
| 6 | Financial integrity | **NOT READY** | P0-04, P1-10, P1-11, NPD-01 |
| 7 | Operational readiness | **NOT READY** | P0-01, P0-02, P0-03 |
| 8 | Observability & alerting | **NOT READY** | P0-02, P2-05, P2-06 |
| 9 | Test & verification confidence | **CONDITIONALLY READY** | P2-14, integration suite unproven |
| 10 | Deployment & configuration | **NOT READY** | P0-02, P0-03, P1-01, P1-09 |
| 11 | Frontend / product completeness | **NOT READY** | no client application exists in this repository |
| 12 | Real-hospital readiness | **NOT READY** | all of the above, plus D-04, D-14 |

**READY 0 · CONDITIONALLY READY 4 · NOT READY 8** (row sum = 12).

### 22.1 The RULE 5 seven-axis separation

| Axis | Dimension | Standing |
|---|---|---|
| **A** | Backend architectural completeness | **STRONG, PARTLY UNREACHABLE** |
| **B** | Backend functional completeness | **INCOMPLETE** |
| **C** | Security completeness | **INCOMPLETE, ONE MAJOR ITEM UNPROVEN** |
| **D** | Operational readiness | **NOT OPERATIONAL** |
| **E** | Frontend / product completeness | **NOT ASSESSABLE** |
| **F** | Production deployment readiness | **NOT READY** |
| **G** | Real-hospital readiness | **NOT READY** |

**No composite score is offered**, per RULE 5. The one derived percentage in this
audit — **50.3 %, being 74 of 147 audited requirements VERIFIED COMPLETE** —
belongs to axes A and B only, and is defensible solely because each of the 147 is
an individually traceable row with its own evidence citation in
`CROSS_PHASE_REQUIREMENTS_MATRIX.md`. It is not a product-completeness figure
and must not be quoted as one.

---

## PART 23 — CONSOLIDATED GAP REGISTER

Full detail: `CROSS_PHASE_GAP_REGISTER.md` — 48 entries with evidence class,
location and impact.

### 23.1 Severity distribution

| Severity | Count |
|---|---|
| **P0** — blocks the next phase | **4** |
| **P1** — must fix before production | **13** |
| **P2** — must fix before scale | **15** |
| **P3** — hygiene, safe to carry | **10** |
| **NPD** — needs a product decision | **6** |
| **Total** | **48** |

### 23.2 The four P0s

| ID | Gap | Root cause | Evidence |
|---|---|---|---|
| **P0-01** | Job crash recovery is dead | `claim_jobs_v2` never sets `lease_expires_at`; `reclaim_stale_jobs` filters on it; v1 set it at `06:283` | drift D-11 |
| **P0-02** | Nothing schedules anything | no scheduler exists in any form | drift D-17 |
| **P0-03** | Worker unreachable under the documented default | `.env.example` ships `ENABLE_WORKER_TRIGGER=false` | drift D-18 |
| **P0-04** | `booking_fee_inr` has no runtime writer | backfilled once by migration `28`; 2 of 3 refund paths read it | drift D-13 |

**All four share two root causes:** a runtime that is built but never activated
(P0-01, P0-02, P0-03), and a column that is defined and populated once but never
written (P0-04). Neither is an error in logic.

### 23.3 The thirteen P1s

| ID | Gap |
|---|---|
| P1-01 | Razorpay webhook HMAC uses `RAZORPAY_KEY_SECRET`; `RAZORPAY_WEBHOOK_SECRET` absent |
| P1-02 | Three incompatible authorization rules; `has_permission()` ignores `profiles.is_active` |
| P1-03 | Nightly step 9 always 403 — `CRON_SECRET` mismatch |
| P1-04 | `run-cron-nightly:296` violates the "must NOT wake worker" prohibition |
| P1-05 | `create-booking` creates no payment order |
| P1-06 | `get_reconciliation_summary` — three defects at `financial-command-center:158` |
| P1-07 | 54 privilege revocations use the wrong primitive (effect UNPROVEN) |
| P1-08 | `idempotent_capture_payment` (`16:421`) discards the capture BOOLEAN |
| P1-09 | `verify_jwt=true` blocks all 7 machine endpoints |
| P1-10 | Refund basis inconsistent across three paths; partial refunds over-adjust settlement |
| P1-11 | `settlement-engine` `record_payment` always 500 |
| P1-12 | No evidence any alert has ever fired end to end |
| P1-13 | Append-only posture asserted more broadly than it is enforced |

### 23.4 Root-cause distribution across all 48 entries

| Root cause | Entries |
|---|---|
| Built but never wired / scheduled | 11 |
| Configuration ships a disabling or wrong value | 6 |
| Two implementations, no declared authority | 6 |
| Statement written instead of control implemented | 5 |
| Behaviour lost in a v1→v2 rewrite | 4 |
| Governance artefact incomplete or stale | 7 |
| Product decision never taken | 6 |
| Test placed where the code already works | 2 |
| Ordinary implementation defect | 1 |

**One entry in 48 is an ordinary implementation defect.** That distribution is
the audit's most compact finding: SETURA's problem is not that its code is wrong.

---

## PART 24 — FINAL ARCHITECTURE VERDICT

Fourteen questions, answered directly. Each answer is a verdict, not a summary.

### Q1 — Is the declared architecture actually the implemented architecture?

**YES.** All four core architectural contracts held (PART 1 §1.2): business logic
in SQL, auditable mutations, database-enforced tenant isolation, idempotency at
external boundaries. Zero instances were found of an Edge Function recomputing a
business number. This is the strongest positive finding in the audit and it
survived five phases of change.

### Q2 — Is the backend architecturally complete?

**SUBSTANTIALLY, BUT 27 % IS UNREACHABLE.** 49 migrations, 191 unique routines, 0
validator errors, zero destructive DDL. **41 routines have no caller and 11 are
referenced only by tests** — 52 of 191. "Complete" and "reachable" have become
different statements and only the first is supported.

### Q3 — Is the backend functionally complete?

**NO.** The clinical path (booking, tokens, queue, state machine, WhatsApp retry
semantics) is complete and correct. The commercial path is not: no payment order
at booking (P1-05), no runtime writer for the booking fee (P0-04), three
incompatible refund bases (P1-10), and booking-level refund states that no code
can reach.

### Q4 — Is the system secure?

**NOT YET — but the failures are specific, not systemic.** No cross-tenant access
path exists. Auth and authorization are present on all 20 user-facing endpoints.
The WhatsApp signature verifier is exemplary. Against that: the Razorpay webhook
uses the wrong secret (P1-01), 54 privilege revocations use the wrong primitive
with effect **UNPROVEN** (P1-07), and `has_permission()` is **architecturally
inconsistent** and ignores `profiles.is_active` (P1-02).

### Q5 — Is `has_permission()` safe, conditionally safe, architecturally inconsistent, or in need of redesign?

**ARCHITECTURALLY INCONSISTENT.** Nothing was changed, per the mandate. It
correctly implements *one* of three incompatible role-resolution rules the system
holds simultaneously (union / least-privilege / deny). No cross-tenant escalation
results. It has one independent defect: it ignores `profiles.is_active`. The
inconsistency is an unmade design decision (NPD-04), not a bug in the function.

### Q6 — Is the operational layer functional?

**NO. It does not run at all.** Three independent stoppages sit between the queue
and the worker — no scheduler (P0-02), worker disabled by the documented default
(P0-03), `verify_jwt` rejecting machine callers (P1-09) — and behind them, crash
recovery that cannot fire (P0-01). Requirement set V has **zero** verified
requirements out of eight.

### Q7 — Is financial integrity assured?

**NO, WITH AN IMPORTANT QUALIFICATION.** The ledger is immutable and its freeze
trigger is intact; there is no double-refund path and no ledger-mutation path.
But the figures written into that correct ledger derive from an unpopulated fee
column, an inconsistent refund basis, a fixed 2 % gateway-fee estimate, and a GST
line never charged. **The record is trustworthy; the numbers are not yet.**
Because the record is immutable, that is correctable.

### Q8 — Are the existing certifications trustworthy?

**PARTIALLY, AND MORE THAN A SCEPTIC WOULD EXPECT.** 0 revoked, 5 narrowed, 3
upheld, 15 sub-claims withdrawn, 12 suspended. Central claims held; claims about
*wiring* did not. The unit gate reproduced exactly (65/0), and Phase 1.5
disclosed its own largest exposure voluntarily. These reports were written in
good faith and made one repeated inferential error.

### Q9 — Does the test suite provide meaningful evidence?

**PARTIALLY.** It runs, it is honestly reported, and it is well written where it
exists. It has **zero coverage at all nine defect sites**, and would have caught
**none** of the four P0s. One test (`whatsapp_conversational.test.ts:838`) passes
while asserting on a column that has no production writer. The problem is
placement, not volume.

### Q10 — Is there duplicated or conflicting logic?

**YES — six competing sources of truth** (PART 1 §1.5): three role-resolution
rules, three candidate booking-fee sources, two revenue-forecast
implementations, four v1/v2 RPC pairs, two owners of queue state transitions,
and a contested phase history. In the v1/v2 case, **the dead code is the correct
code** — v1 `claim_jobs` sets the lease that v2 omits.

### Q11 — Is there dead or orphaned code?

**YES, AND IT IS MATERIAL.** 52 of 191 routines unreachable in production; five
materialized views with zero consumers; `run_nightly_tasks` superseded by an
Edge Function; three job types with no producer or no handler; a dead
configuration knob (`WORKER_LEASE_SECS`); a comment naming a function that does
not exist; and a required function (`check_booking_limit()`) that was never
written.

### Q12 — Is SETURA ready for production deployment?

**NO.** An operator deploying exactly as documented gets a system whose async
layer never starts, whose webhook verification is anchored on the wrong secret,
and whose machine endpoints reject their own callers. Every one of those is a
one-line configuration matter, which is the good news and also the reason it has
gone unnoticed.

### Q13 — Is SETURA ready for a real hospital?

**NO — and it must not be deployed into one in its current state.** Stated
plainly because the product's own positioning makes this the operative question.
The reason is not the gap count; it is that (a) the asynchronous half of the
system does not run, so a patient may never receive a confirmation, and (b)
patient refunds would be computed from a column nobody writes. Set against that:
tenant isolation is sound, the ledger is immutable, and clinical-adjacent data is
append-only. The **integrity** foundations are right; the **activation** is not.

### Q14 — What is the single most important thing to understand about this system?

**That almost nothing is wrong with the code, and a great deal is missing from
the wiring between the pieces.**

One of 48 gap entries is an ordinary implementation defect. All four P0s are
downstream of recorded architectural drift, and **none of the four is a coding
error**. SETURA is a well-designed system that was certified on the basis of its
components existing rather than its components being connected. The next phase
should therefore be *activation and verification*, not remediation — and
certainly not features.

### 24.1 On PART 25 and PART 27

**PART 25 (no unsupported feature recommendations):** every remediation item in
this audit and in `NEXT_PHASE_READINESS_REPORT.md` §15 maps to an existing
requirement, roadmap commitment, or architectural contract traced in PARTs 3–20.
**No new feature is proposed anywhere in this deliverable set.**

**PART 27 (evidence standard):** every significant finding carries a file path,
line number, migration number, function name, test name or executed command
result. Where verification was impossible, the word used is **UNPROVEN** or
**SUSPENDED PENDING VERIFICATION**, never PASS. Three specific verifications are
outstanding and are named at PART 14 §14.3 and PART 17 §17.1: `pg_proc.proacl`,
the 162-case integration suite, and the 34-case security regression suite. No
evidence in this report was fabricated or inferred from a completion report
alone.

---

## PART 28 — EXECUTIVE SUMMARY BY AUDIENCE

Each summary states only what the evidence supports. Per the mandate, the product
is not marketed beyond that.

### 28.1 For the CEO

SETURA's foundations are real. The database architecture, multi-tenant isolation
and financial record-keeping are of genuinely commercial quality, and they held
up under a deliberately hostile audit — including the one test that matters most
for a hospital SaaS: **no path exists for one hospital to see another's data.**

The system is not deployable today. The reason is narrower than the gap count
suggests: the background processing layer that sends WhatsApp confirmations,
refreshes dashboards and runs nightly maintenance **is built but was never
switched on**, and one database column that refund amounts are calculated from is
never written. Four issues, all of them wiring rather than design.

Expect one focused phase — not a rebuild. Two decisions need you or your CFO:
whether GST is charged to patients, and when revenue is recognised. Neither can
be settled by engineering.

### 28.2 For the CTO

The architecture held. All four declared contracts verified: SQL-first business
logic, auditable mutations, DB-enforced tenancy, boundary idempotency. 49
migrations, 0 validator errors, zero destructive DDL in the entire history, and
the unit suite reproduced at 65/0 when I re-ran it.

The problems are integration-level and they cluster:

- **P0-01** — the v1→v2 job-claim rewrite dropped `lease_expires_at`, which is
  the column the reclaim path filters on. Crash recovery cannot fire. `06:283`
  shows v1 doing it correctly. Two prior reports certified this as working.
- **P0-02 / P0-03 / P1-09** — nothing schedules the cron functions,
  `.env.example` ships `ENABLE_WORKER_TRIGGER=false`, and `verify_jwt=true`
  blocks the machine endpoints. Three independent reasons the async layer is
  dark.
- **P0-04** — `booking_fee_inr` was backfilled by migration `28` and has had no
  writer since.
- **P1-07** — 54 `REVOKE … FROM PUBLIC` statements are no-ops against Supabase's
  installed default grant to `anon`/`authenticated`. Wrong primitive. Effect
  **UNPROVEN** — I could not query `pg_proc.proacl` because Docker was down, and
  I will not assert a privilege conclusion from inference.

Also: 52 of 191 routines are unreachable, and the test suite has zero coverage at
all nine defect sites. Placement, not volume — resist the urge to raise the count.

### 28.3 For the CIO

Integration posture is sound where it is verified and dark where it is not.
Inbound WhatsApp works end to end with exemplary HMAC verification and 18
dedicated tests. **Outbound messaging does not leave the queue.** The Razorpay
inbound webhook verifies with the API key secret rather than a webhook secret,
which will either reject every webhook or collapse two trust boundaries into one;
only a live delivery will tell you which.

Five India-specific assumptions (INR, GST, phone format, IST day boundaries,
Razorpay-only) are embedded and **undeclared**. For a product sold as
multi-tenant SaaS, that is latent scope you should surface before the first
non-India conversation.

Operationally: there is no scheduler, no functioning crash recovery, and no
evidence any alert has ever fired. Plan for a named on-call owner of the async
layer, because today the system cannot tell you it has lost work.

### 28.4 For the CFO

The good news is structural and it matters: **the financial ledger is immutable
and its protection is intact.** No entry can be altered or deleted. There is no
double-refund path — that guard is real and tested. So every figure is traceable
and every error is correctable.

The bad news is that several figures are currently wrong:

| Issue | Effect |
|---|---|
| Booking fee never persisted at booking | refunds computed from an unpopulated column |
| No payment order created at booking | the quoted fee is never made collectable |
| GST written to the ledger, never charged to the patient | a tax component booked but not collected |
| Gateway fee always a flat 2 % estimate | settlements carry a synthetic cost |
| Reconciliation summary has three defects | the reconciliation view cannot be relied on |
| Revenue recognised when the booking is created | with no payment order attached |

**Do not invoice a hospital from these figures yet**, and do not report from them.
Two decisions are yours: the GST position, and the revenue-recognition point.

### 28.5 For the hospital operator

If SETURA were switched on in your hospital today:

**What would work.** Registering and booking patients. Token allocation — with a
database-level guarantee against double-booking a doctor. The live queue,
including pauses, delays, recalls and skips, with a complete tamper-proof history
of everything that happened. Real-time queue updates. Consultation notes that
cannot be silently altered.

**What would not.** Your patients would receive **no WhatsApp confirmations and no
delay notifications** — the messages are generated correctly and never sent. Your
dashboards would show stale numbers, because nothing refreshes them. Refunds
would be calculated from a value the system never records. And if a background
process crashed, the work it was doing would be lost **silently** — the system
cannot currently detect that.

The clinical workflow is sound. Every channel that talks to a patient, and every
number that touches money, needs work first.

### 28.6 For a security reviewer

Full detail at PART 14. Summary of what I searched for and did **not** find:
cross-tenant access, SQL injection, further PostgREST operator injection,
committed secrets, signature-bypass paths, double-refund paths, ledger mutation
paths, destructive DDL, LLMs in the trust path. None found.

What I did find:

| # | Finding | Severity |
|---|---|---|
| 1 | 54 `REVOKE … FROM PUBLIC` statements ineffective against Supabase's installed default grant to `anon`/`authenticated`; validator check 7 counts statements rather than evaluating effect | **P1-07**, effect **UNPROVEN** — needs `pg_proc.proacl` |
| 2 | Razorpay webhook HMAC computed with `RAZORPAY_KEY_SECRET`; `RAZORPAY_WEBHOOK_SECRET` absent from the repository | **P1-01** |
| 3 | `has_permission()` **architecturally inconsistent** — three coexisting role-resolution rules; and it ignores `profiles.is_active` | **P1-02** |
| 4 | `verify_jwt=true` blocks all 7 machine endpoints; `CRON_SECRET` mismatch on the nightly path | **P1-09** |
| 5 | 10 of 11 test-only routines covered *solely* by `REVOKE` assertions — asserting a statement exists, not that access is denied | **P2-14** |
| 6 | `42501` mapped to HTTP 500 rather than 403 | **P3-01** |

Credit where due: the `verifyMetaSignature()` rewrite to a single success path,
with 18 tests and a documented trust boundary at
`docs/security/WEBHOOK_SIGNATURE_BOUNDARY.md`, is the correct treatment of a
classic bypass surface. And Phase 1.5 disclosed the 191-routine exposure in its
own certification section, unprompted.

**One measurement would close the largest open question in this system:** query
`pg_proc.proacl` for all 191 routines on a freshly reset database.

### 28.7 For an enterprise buyer performing due diligence

**What the evidence supports.** A production-quality multi-tenant database
architecture with genuine tenant isolation — no cross-tenant access path exists.
An immutable financial ledger and append-only clinical notes and audit logs.
Database-level prevention of doctor double-booking. A concurrency-safe patient
queue. A deterministic, no-LLM WhatsApp integration with correctly implemented
signature verification. Real, blocking CI. Zero destructive schema changes across
49 migrations. **74 of 147 audited platform requirements verified complete**
(50.3 %, derived — see PART 22 §22.1 for exactly how).

**What the evidence does not support.** That the system is production-ready. That
it can be deployed into a live hospital. That its financial figures are currently
correct. That its background processing runs. That prior completion reports can be
relied on without verification — 15 sub-claims were withdrawn and 12 more could
not be verified because a live environment was unavailable to this audit.

**What is not in this repository at all.** Any patient-facing, staff-facing or
doctor-facing client application. This is a backend and platform codebase. Product
completeness cannot be assessed from it, and this audit does not claim to.

**Honest characterisation.** A well-architected backend platform, roughly one
focused engineering phase from being operationally functional, with two financial
policy questions outstanding. **Not** a deployable hospital operating system
today. The distance is smaller than the gap count suggests and larger than the
completion reports imply.

---

## §29 — Limits of this audit

Stated so that no reader over-reads it.

1. **No live execution.** Docker was unavailable throughout. Starting the stack
   would have been a state-changing action on a shared resource, which RULE 1
   forbids. Every verdict rests on static evidence plus the five gates that run
   without a database.
2. **Three verifications are outstanding**, all read-only, all blocked only by
   Docker: `pg_proc.proacl` for 191 routines; `deno task test:integration` (162
   cases); the security regression suite (34 cases). Their claims are recorded
   as UNPROVEN or SUSPENDED, never as PASS or FAIL.
3. **No production environment was inspected.** Findings about `.env.example`
   and `verify_jwt` describe the committed configuration. A deployed environment
   may differ — which is why those gates are phrased as measurements.
4. **The 191 vs 193 routine count is disclosed, not resolved.** Resolving it
   requires the live catalog. It changes no conclusion.
5. **147 requirements is this audit's decomposition** of the Phase 0 → 1.5
   commitments. A different decomposition would redistribute the same findings
   without changing them, and would produce a different denominator — which is
   why the percentage is always quoted with its derivation attached.
6. **The audit records effects, not blame.** Several findings read harshly in
   table form while describing careful work that lost a detail in transit. The
   v1→v2 lease loss is the clearest case: competent work, one dropped
   assignment, nine downstream artefacts that kept describing the intended
   behaviour.
7. **Nothing was fixed.** Per RULE 1 and the FINAL RULE, no source file, SQL
   migration, test, configuration file or pre-existing document was modified. No
   migration was created. No architecture was "improved". The only files created
   are the six audit deliverables PART 26 requires. No temporary script or probe
   was created, so none needed deletion.

---

## §30 — FINAL TALLIES

| # | Measure | Value |
|---|---|---|
| 1 | **Total requirements audited** | **147** |
| 2 | **VERIFIED COMPLETE** | **74** |
| 3 | **PARTIALLY COMPLETE** | **30** |
| 4 | **IMPLEMENTED BUT UNPROVEN** | **12** |
| 5 | **IMPLEMENTED BUT BROKEN** | **9** |
| 6 | **MISSING** | **12** |
| 7 | **SUPERSEDED** | **0** |
| 8 | **NEEDS PRODUCT DECISION** | **5** |
| 9 | **P0 gaps** | **4** |
| 10 | **P1 gaps** | **13** |
| 11 | **P2 gaps** | **15** |
| 12 | **P3 gaps** | **10** |
| 13 | **Certification changes** | **0 revoked · 5 narrowed · 3 upheld · 15 sub-claims withdrawn · 12 claims suspended** |
| 14 | **Recommended next phase** | **Phase 1.6 — "Runtime Activation & Verification"** |

Additional classifications not among the fourteen, recorded for completeness:
**DUPLICATED-CONFLICTING 2 · OUT OF SCOPE 3.**

Column sum check: 74 + 30 + 12 + 9 + 12 + 0 + 2 + 3 + 5 = **147.** ✓
Gap register sum check: 4 + 13 + 15 + 10 + 6 (NPD) = **48.** ✓
Drift register sum check: 12 + 8 + 10 = **30.** ✓

**Recommended next phase, derived only from audit findings:** **Phase 1.6 —
Runtime Activation & Verification.** Seven gates, in dependency order: (1)
restore the runtime — schedule cron, settle `ENABLE_WORKER_TRIGGER`, resolve the
JWT boundary, fix the cron secret; (2) restore crash recovery — lease
assignment, a caller for the recovery routines, a killed-worker test; (3) restore
financial truth — a fee writer, the payment-order decision, one refund basis;
(4) execute the three blocked verifications; (5) close the authorization
decision and fix the `is_active` omission; (6) take the six product decisions;
(7) repair governance — amend or lift the freeze, populate or delete the
registry, correct the stale copy-forward text. **Not Phase 2.** Not a refactor.
Not features. Not a test-count exercise.

---

# CROSS-PHASE AUDIT COMPLETE






