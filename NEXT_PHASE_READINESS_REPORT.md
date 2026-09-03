# SETURA — NEXT PHASE READINESS REPORT

**Scope:** Phase 0 → Phase 1.5 (inclusive), assessed as at migration HEAD `49`
**Audit mode:** READ-ONLY. No source file, migration, test, configuration file or
pre-existing document was modified to produce this report.
**Companion documents:** `CROSS_PHASE_AUDIT_REPORT.md`,
`CROSS_PHASE_REQUIREMENTS_MATRIX.md`, `CROSS_PHASE_GAP_REGISTER.md`,
`ARCHITECTURAL_DRIFT_REGISTER.md`, `CERTIFICATION_RECONCILIATION.md`

---

## §0 — What this document is, and what it deliberately is not

This is the PART 22 deliverable: a readiness assessment across twelve
dimensions, each with an explicit verdict, the evidence behind it, the gaps that
block it, and the **gate conditions** that would have to be satisfied to move
the verdict up.

Three constraints shape every verdict below.

**0.1 — Readiness is assessed against SETURA's own stated destination, not
against a generic maturity model.** SETURA is described by its own
documentation as a production-grade multi-tenant SaaS Hospital Operating System
intended for real commercial hospital deployment. That is the bar used. A
control that would be acceptable in an internal pilot but not in a paid
multi-hospital deployment is marked NOT READY, and the reason is stated.

**0.2 — "Verified" here means verified statically.** Docker was unavailable for
the entire audit window:

```
$ docker ps
error during connect: ... failed to connect to the docker API at
npipe:////./pipe/dockerDesktopLinuxEngine
```

Starting the local Supabase stack would have been a state-changing action on a
shared resource, which RULE 1 forbids. The consequence is precise and is
carried honestly through every dimension below: anything whose proof requires a
live database, a live PostgREST instance, or execution of the integration suite
is recorded as **UNPROVEN**, never as PASS. This is not a hedge — it is the
difference between "the code says X" and "the running system does X", and for
several findings in this audit that difference is exactly where the defect
lives.

**0.3 — Gate conditions are verification tasks, not designs.** Per PART 25 this
report does not propose features, and per RULE 1 it does not propose code. Where
a gate says "confirm", the correct next action is a measurement. Where a gate
says "decide", the correct next action is a product decision by a named owner —
those are enumerated as NPD-01…NPD-06 in `CROSS_PHASE_GAP_REGISTER.md` §5 and
are **not** engineering work.

### 0.4 — Verdict vocabulary

| Verdict | Meaning |
|---|---|
| **READY** | The dimension is satisfied by evidence. No P0 or P1 gap is open against it. Residual items are P2/P3 and are safe to carry into the next phase. |
| **CONDITIONALLY READY** | The dimension is substantially built and no P0 gap is open against it, but at least one P1 gap or one unproven core claim stands between it and readiness. The named gate conditions are individually small and mechanically checkable. |
| **NOT READY** | At least one P0 gap is open against the dimension, or a control the dimension depends on has been shown not to execute at runtime. A dimension is also NOT READY if its core mechanism exists but has **no runtime writer, no scheduler, or no reachable caller**. |

A dimension is never marked READY on the strength of a completion report alone.
Per RULE 2, reports were treated as evidence to be checked, and
`CERTIFICATION_RECONCILIATION.md` records the outcome of checking them: 0
certifications revoked, 5 narrowed, 3 upheld, 15 sub-claims withdrawn, 12
claims suspended pending live verification.

### 0.5 — Inputs this report consumes

| Input | Value |
|---|---|
| Requirements audited | 147 |
| VERIFIED COMPLETE | 74 (50.3 %) |
| PARTIALLY COMPLETE | 30 |
| IMPLEMENTED BUT UNPROVEN | 12 |
| IMPLEMENTED BUT BROKEN | 9 |
| MISSING | 12 |
| SUPERSEDED | 0 |
| DUPLICATED-CONFLICTING | 2 |
| OUT OF SCOPE | 3 |
| NEEDS PRODUCT DECISION | 5 |
| Gap register entries | 48 — P0 4 · P1 13 · P2 15 · P3 10 · NPD 6 |
| Drift register entries | 30 — HIGH 12 · MEDIUM 8 · LOW 10 |

The 50.3 % figure is derived, not estimated: it is 74 requirements classified
VERIFIED COMPLETE divided by 147 requirements audited, where each of the 147 is
an individually traceable row in `CROSS_PHASE_REQUIREMENTS_MATRIX.md` §1–§15
with its own evidence citation. Per RULE 5 it is **not** a product-completeness
percentage and must not be quoted as one. It is the proportion of *audited
backend and platform commitments* that survived tracing. No other percentage in
this audit is defensible and none is offered.

---

## §1 — Readiness scorecard (summary)

| # | Dimension | Verdict | Blocking gaps |
|---|---|---|---|
| 1 | Backend architectural completeness | **CONDITIONALLY READY** | — (P2-11, P2-12, P2-13) |
| 2 | Backend functional completeness | **NOT READY** | P0-04, P1-05, P1-10 |
| 3 | Data integrity & schema governance | **CONDITIONALLY READY** | P1-13, P2-08, P2-09 |
| 4 | Security posture | **NOT READY** | P1-01, P1-02, P1-09 |
| 5 | Authorization & tenancy | **CONDITIONALLY READY** | P1-02, NPD-04 |
| 6 | Financial integrity | **NOT READY** | P0-04, P1-10, P1-11, NPD-01 |
| 7 | Operational readiness (scheduling, workers, recovery) | **NOT READY** | P0-01, P0-02, P0-03 |
| 8 | Observability, alerting & monitoring | **NOT READY** | P0-02 (upstream), P2-05, P2-06 |
| 9 | Test & verification confidence | **CONDITIONALLY READY** | P2-14, integration suite unproven |
| 10 | Deployment & configuration readiness | **NOT READY** | P0-02, P0-03, P1-01, P1-09 |
| 11 | Frontend / product completeness | **NOT READY** | Out of audited scope as *built*; nothing to assess |
| 12 | Real-hospital readiness | **NOT READY** | All of the above, plus D-04, D-14 |

**Count: READY 0 · CONDITIONALLY READY 4 · NOT READY 8.** Row sum verified = 12.

The distribution is worth reading carefully, because it is not the shape of an
immature system. Four dimensions are within small, well-identified distance of
readiness, and the eight that are not fail overwhelmingly on **wiring and
scheduling**, not on absent design. `ARCHITECTURAL_DRIFT_REGISTER.md` §2.3
establishes the same point from the other direction: all four P0 gaps are
downstream of recorded drift, and **none of the four is a coding error**. The
SQL layer of this system is materially stronger than its runtime activation.

---

## §2 — Dimension 1: Backend architectural completeness

**Verdict: CONDITIONALLY READY**

### 2.1 What is proven

The declared architecture is SQL-first: business logic lives in SECURITY
DEFINER routines, triggers and constraints; Edge Functions validate, authorize
and orchestrate but never recompute business numbers. That contract is
substantially honoured, and it was checked rather than assumed.

| Evidence | Result |
|---|---|
| Migrations `01`–`49` present, sequentially numbered, no gaps | PASS |
| `deno task validate:migrations` | **49 files scanned, 0 errors, 4 warnings** |
| `deno fmt --check` | 259 files, exit 0 |
| `deno lint` | 75 files, clean |
| `deno task check` (typecheck) | 0 errors |
| Destructive statements in migrations (`DROP TABLE` / `DROP COLUMN` / destructive `ALTER`) | **zero** |
| Edge Functions recomputing money instead of calling an RPC | **zero found** |
| `console.*` outside the logging module | 2, both inside `logger.ts:92,94` (the logger itself) |
| Raw `throw new Error(` in the 20 user-facing endpoints | **zero** (all 24 occurrences are in the 5 machine-to-machine functions) |
| Unique SQL routines (independent recount) | **191** |

The last row is a correction, not a criticism: Phase 1.5 reports "193
routines". An independent recount of the catalog-defining migrations yields
**191 unique** routines. The two-routine difference is a counting artefact, it
is disclosed in `CROSS_PHASE_REQUIREMENTS_MATRIX.md` §0, and it does not change
any privilege conclusion. It is recorded because RULE 3 requires the number an
auditor can reproduce, not the number a report asserts.

### 2.2 What is not proven

**27 % of the SQL surface has no reachable caller.** Of the 191 unique
routines, **41 have no caller anywhere** in the Edge Functions, other SQL
routines, triggers, or cron paths, and a further **11 are referenced only by
tests** — 52 routines, 27 % of the surface (P2-11). Ten of those eleven
test-only routines are exercised *solely* by `REVOKE` assertions in
`tests/unit/privilege_isolation.test.ts`, meaning the only thing proven about
them is that they are not publicly executable. Nothing proves they compute
correctly.

This is not automatically waste — a platform legitimately carries routines
ahead of the client that will call them. But it is a large enough fraction that
"the backend is architecturally complete" and "the backend is architecturally
*reachable*" have become different statements, and only the first is supported.

Two further structural items stand open:

- **P2-12 — duplicated orchestration.** The SQL routine `run_nightly_tasks` is
  dead: the nightly work is driven from `run-cron-nightly` instead. Separately,
  `queue-control` and `doctor-operations` both implement recall, skip, restore,
  `mark_absent` and resume. Two code paths to the same state transition is two
  places for the state machine to diverge.
- **P2-13 — four superseded v1 RPCs retained** alongside their `_v2`
  replacements (`claim_jobs`, `complete_job`, `fail_job`,
  `register_webhook_event`), with zero callers on the v1 side. Retention is
  defensible; retention *without deprecation markers* is how P0-01 stayed
  invisible, because the v1 implementation contains the behaviour the v2
  implementation lost.

### 2.3 Gate conditions

1. Publish a reachability decision for each of the 52 unreachable routines:
   *planned client*, *internal-only*, or *retire*. This is a documentation
   action, not a code action.
2. Choose one owner per duplicated state transition in P2-12 and record which
   path is canonical.
3. Mark the four v1 routines in P2-13 as deprecated **in the catalog**, so that
   a future reader cannot mistake v1 behaviour for current behaviour.

None of these three gates requires a schema change, and none is a prerequisite
for the P0 work in §8.

---

## §3 — Dimension 2: Backend functional completeness

**Verdict: NOT READY**

### 3.1 The finding that decides this dimension

`bookings.booking_fee_inr` **has no runtime writer** (P0-04). Migration `28`
performed a one-time backfill of the column. No routine written since sets it
on new rows. The column therefore reflects, for every booking created after
migration `28` was applied, the default rather than the fee actually charged.

The consequence is not cosmetic, because two of the three refund paths compute
the refund amount from that column. With no writer, those two paths compute
refunds from a value that was never populated for the booking in question.

This is masked in the test suite. `tests/integration/whatsapp_conversational.test.ts:838`
asserts against `booking_fee_inr` on a row whose fee was set by fixture data,
not by the production write path — so the assertion passes while the production
write path does not exist. This is the single clearest instance in the audit of
RULE 3's warning that *a test existing is not proof that the test is valid*.

### 3.2 Supporting failures in the same dimension

**P1-05 — `create-booking` creates no payment order.** This was verified
directly this audit. `supabase/functions/create-booking/index.ts` is 688 lines
and contains **zero** matches for `payment_order`, `payment-order`, `razorpay`,
`create_payment` or `payment_orders`. Its eight RPC calls are, exhaustively:

```
create_booking · enqueue_job · estimate_wait_minutes · get_effective_fees
get_remaining_token_capacity · is_doctor_available
record_subscription_usage · send_whatsapp_message
```

`get_effective_fees` is called — the fee is *quoted*. Nothing then creates the
order that would let it be *collected*. This directly withdraws
`CROSS_CHECK_REPORT.md` §2.1's description of a "16-step validated flow (auth →
role → Zod validation → idempotency → doctor availability → token generation →
**payment order** → audit → WhatsApp enqueue)". The bolded step is not there.
See `CERTIFICATION_RECONCILIATION.md` §9.

**Refund states are unreachable (finding 47).** `bookings.payment_status_detail`
carries a CHECK constraint enumerating refund states, but the only writer at
`34:198` sets `'payment_captured'`, and `confirm_refund_processed` never touches
the `bookings` table at all. The refund states in that constraint cannot be
reached by any code path. This makes ROADMAP Phase 1.2's requirements R-01 and
R-02 **MISSING**, not partial — see `CROSS_PHASE_REQUIREMENTS_MATRIX.md` §4.

**P1-10 — refund basis inconsistency.** The three refund paths do not agree on
what they refund a fraction *of*, and partial refunds over-adjust settlement.
`tests/integration/refund_sync.test.ts` covers the full-refund case only, so
the partial case is untested at exactly the point where the paths diverge.

### 3.3 What is nonetheless solid here

This dimension is NOT READY, but the failure is concentrated in the payment and
refund path. Elsewhere the functional core traced cleanly:

- The **booking state machine** (`booked → checked_in → waiting → called →
  in_consultation → completed`, plus `cancelled` / `no_show` / `rescheduled` /
  `skipped`, with `skipped → waiting` re-entry) is centralised in
  `_shared/booking_state.ts` and matched by the SQL transitions.
- **Token generation** is atomic: `generate_next_token()` uses a single
  `INSERT … ON CONFLICT DO UPDATE … RETURNING`, so concurrent callers cannot
  duplicate a token.
- **Queue advancement** uses `SKIP LOCKED` (`02:603`), so two concurrent
  advances cannot call the same patient.
- **Double-booking is prevented at the database level** by a GiST exclusion
  constraint on `doctor_schedules` (migration `03`). `CROSS_CHECK_REPORT.md:60`
  calls this "stronger than described" — that sub-claim is upheld.
- The **WhatsApp retry contract** from ROADMAP 1.1 is met in full:
  `permanentCodes` at `send-whatsapp-message/index.ts:285-290`, exponential
  backoff `POWER(2, v_retry_count)::INTEGER` at `04:649`, terminal
  `permanently_failed` at `04:747`, and the `whatsapp_confirmation_sent` marker
  at `04:665`.

### 3.4 Gate conditions

1. **P0-04 must close first.** Establish a runtime writer for
   `booking_fee_inr`, then re-derive the refund paths that read it. Until then
   no refund figure produced by this system should be treated as authoritative.
2. Resolve P1-05: decide whether booking creates a payment order, or whether
   collection is deliberately deferred to a separate step, and make the
   documentation match whichever is true.
3. Reconcile the three refund bases (P1-10) to one, and extend
   `refund_sync.test.ts` to the partial-refund case.
4. Either make the refund states in `payment_status_detail` reachable or remove
   them from the CHECK — a constraint that enumerates unreachable states
   misleads every future reader.

---

## §4 — Dimension 3: Data integrity & schema governance

**Verdict: CONDITIONALLY READY**

### 4.1 What is proven

Data integrity is the strongest dimension in the system, and unlike most of the
claims in this audit it survived tracing largely intact.

| Control | Evidence | Status |
|---|---|---|
| `financial_ledger` immutable | `prevent_ledger_mutation` + `trg_ledger_no_update` + `trg_ledger_no_delete` | VERIFIED |
| `audit_logs` append-only | trigger-enforced | VERIFIED |
| `consultation_notes` append-only | trigger-enforced | VERIFIED |
| `queue_runtime_events` append-only | immutability trigger at `43:100-124` | VERIFIED |
| `queue_runtime_events` Realtime-published with ENABLE + FORCE RLS | `43:100-124` | VERIFIED |
| Double-booking prevented in DB | GiST exclusion constraint, migration `03` | VERIFIED |
| Token allocation atomic | `generate_next_token()` single-statement upsert | VERIFIED |
| Idempotency infrastructure | `idempotency_keys`, `api_idempotency_keys`, deterministic `enqueue_job` keys, `register_webhook_event_v2` + payload hash, refund replay guard (migration `41`) | VERIFIED, and the migration-41 replay guard is genuinely tested |
| Destructive DDL across `01`–`49` | zero occurrences | VERIFIED |
| MV refresh ordering | `CONCURRENTLY`, in dependency order | VERIFIED |

The append-only posture is real. This matters more than any other single
positive finding in the audit, because it is the property that makes the
system's financial history *auditable* even where the figures written into it
are wrong. A wrong number in an immutable ledger is a correctable business
problem; a wrong number in a mutable ledger is an unfalsifiable one.

### 4.2 What blocks readiness

**P2-08 — the Phase 0.5 schema freeze was breached and never amended.** After
migration `37` (the freeze point), later migrations added **5 tables, 17
columns and 1 enum value**. There is no amendment record. Notably, Phase 0.5's
*own* sub-claim is true: migrations `40`, `41` and `48` contain zero DDL. The
breach came from elsewhere in the sequence. The defect is therefore not "the
freeze was ignored" but "the freeze had no enforcement and no amendment
process", which is drift D-04.

**P2-09 — a negative constraint is contradicted.** A CHECK constraint forbids a
value that another code path can produce. Recorded in
`CROSS_PHASE_GAP_REGISTER.md` §3.

**P1-13 — append-only posture asserted more broadly than enforced.** The
enforcement in §4.1 is real for the four named tables. The claim as written in
the reports extends further than the triggers do.

**P2-15 — `job_queue.job_type` is unconstrained.** No CHECK, no enum, no FK.
Any string can be enqueued as a job type. Combined with the fact that
`create_partition` is claimable but unhandled, and `refresh_analytics` /
`send_notification` have zero producers, the queue's type vocabulary is
enforced nowhere and documented nowhere.

**P2-06 — partition automation is advisory only.** `check_partition_readiness()`
returns the message *"Partitions will auto-create"*. Nothing auto-creates them.
The function reports a capability the system does not have, which is worse than
reporting nothing.

**Migration governance is largely unrecorded.** `migration_registry` contains 5
of 49 migrations (~10 %, P2-07). The registry exists, is well-designed, and is
90 % empty.

### 4.3 Gate conditions

1. Record the post-`37` DDL as a formal amendment to the Phase 0.5 freeze, or
   state that the freeze is lifted. Either is acceptable; silence is not.
2. Resolve the P2-09 contradiction in favour of either the constraint or the
   writer, and note which.
3. Constrain `job_queue.job_type` to the vocabulary the handlers actually
   implement, or document that it is intentionally open.
4. Correct `check_partition_readiness()`'s advisory text so it does not assert
   automation that does not exist. (This is a one-string honesty fix, and it is
   listed as a gate rather than performed here because RULE 1 forbids the edit.)
5. Backfill `migration_registry` to 49/49, or delete it. A 10 %-populated
   governance table provides negative value: it looks like coverage.

---

## §5 — Dimension 4: Security posture

**Verdict: NOT READY**

### 5.1 What is proven, and it is substantial

| Control | Evidence | Status |
|---|---|---|
| All 20 user-facing endpoints authenticate | `resolveAuth` present in all 20 | VERIFIED |
| All 20 user-facing endpoints authorize | `requireRole` present in all 20 | VERIFIED |
| WhatsApp webhook signature verification | `verifyMetaSignature()`, single-success-path rewrite, HMAC-SHA256 over `X-Hub-Signature-256` | VERIFIED |
| WhatsApp signature test depth | 18 cases in `tests/unit/webhook_signature.test.ts` | VERIFIED |
| Signature boundary documented | `docs/security/WEBHOOK_SIGNATURE_BOUNDARY.md` | VERIFIED |
| PostgREST `.or()` operator injection | closed in Phase 1.3 via phone sanitization + validation in `whatsapp_queue_flow.ts` | VERIFIED |
| Intent routing contains no LLM | deterministic router; no AI/ML claim anywhere in the codebase | VERIFIED |
| RLS enabled and FORCED on tenant tables | present | VERIFIED |
| No error-detail leakage from user-facing endpoints | zero raw `throw new Error(` in the 20 | VERIFIED |

The `verifyMetaSignature()` rewrite deserves specific credit. A signature
verifier with multiple success paths is a classic bypass surface; collapsing it
to one success path and then writing 18 tests against it, *and* documenting the
trust boundary in a dedicated file, is the pattern one wants to see. That
sub-claim is upheld without qualification.

### 5.2 The three findings that block readiness

**P1-01 — the Razorpay webhook HMAC is computed with the wrong secret.**
`supabase/functions/verify-payment/index.ts:63` verifies the webhook signature
using `RAZORPAY_KEY_SECRET`. The string `RAZORPAY_WEBHOOK_SECRET` does not
appear anywhere in the repository. Razorpay signs webhooks with a
webhook-specific secret configured separately from the API key secret. As
written, either verification fails in production for every webhook, or — if the
two secrets are set to the same value to make it pass — the webhook trust
boundary is anchored on a credential that is also used for outbound API calls.
Both outcomes are wrong, and they are wrong in opposite directions, which is
why this is P1 and must be settled by measurement against a real Razorpay
webhook rather than by reading the code again.

**P1-02 — `has_permission()` is architecturally inconsistent.** Per the PART 14
mandate this is stated explicitly and no change is made.

> **Verdict on `has_permission()`: ARCHITECTURALLY INCONSISTENT.**
> Not "unsafe" — no cross-tenant privilege escalation path was found, and the
> function is correctly tenant-scoped. The inconsistency is that SETURA
> contains **three coexisting and mutually incompatible rules** for resolving
> the permissions of a user who holds more than one role:
>
> | Mechanism | Rule for multi-role users |
> |---|---|
> | `has_permission()` | **Union** — grants if *any* held role grants |
> | `current_user_role(uuid)` | **Least privilege** — resolves to the lowest role |
> | `selectRole` (TypeScript) | **Denies** — refuses to resolve ambiguity |
>
> Three answers to one question is not a bug in any one of them; it is an
> unresolved design decision (NPD-04, carried from D-1). Phase 1.5's own
> disclosure §19.3 states the risk correctly and in its own words: *"`has_permission`
> unions permissions across every role a user holds… It must be resolved
> before any of those RPCs is granted to `authenticated`."* That disclosure is
> upheld. The audit adds one item the disclosure does not mention:
> **`has_permission()` ignores `profiles.is_active`**, so a deactivated user's
> permissions still resolve. That is a live authorization defect independent of
> the multi-role question.

**P1-09 — `verify_jwt=true` blocks all 7 machine-to-machine endpoints.** The
seven machine endpoints are called by cron and by webhook senders, neither of
which presents a Supabase JWT. With `verify_jwt` on, those callers are rejected
before reaching the handler. This is the same class of defect as P0-02 and P0-03
and shares their root cause: the *configuration* that activates the runtime was
never validated end-to-end.

### 5.3 The privilege claim that cannot be closed statically

Phase 1.5 §19.4 states: *"191 of 193 SECURITY DEFINER functions directly
executable from PostgREST by any holder of the publishable anon key."* That is
the honest disclosure of a real exposure, and the report deserves credit for
making it.

The audit establishes the mechanism behind it. The 54 `REVOKE … FROM PUBLIC`
statements across migrations `27`–`46` are **runtime no-ops**, because Supabase
ships an installed default privilege grant:

```sql
ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS
  TO postgres, anon, authenticated, service_role;
```

`REVOKE … FROM PUBLIC` does not remove a grant made explicitly to `anon` and
`authenticated`. The wrong primitive was used, 54 times (drift D-07). The
migration validator's check 7 (`privilege-regression`, rules P1–P8,
`PRIVILEGE_BASELINE = 48`) counts the statements but cannot evaluate their
effect.

**This is UNPROVEN, not PASS and not FAIL.** Confirming it requires querying
`pg_proc.proacl` on a live database, which Docker being down made impossible.
It is recorded as SUSPENDED PENDING VERIFICATION in
`CERTIFICATION_RECONCILIATION.md` §8.2 rather than asserted in either
direction. The static reading is strong and the mechanism is well understood,
but a privilege claim of this consequence must be settled by the catalog, not
by inference.

### 5.4 Gate conditions

1. Query `pg_proc.proacl` for all 191 routines on a freshly reset database and
   publish the actual ACL. This single measurement closes or confirms the
   largest open security question in the system.
2. Settle P1-01 against a real Razorpay webhook delivery.
3. Take the NPD-04 decision on multi-role resolution, then make all three
   mechanisms implement it.
4. Fix the `profiles.is_active` omission in `has_permission()` — this one is
   independent of the design decision and should not wait for it.
5. Resolve P1-09 by deciding the JWT/HMAC boundary (NPD-05, carried from D-2)
   and configuring `verify_jwt` per endpoint class accordingly.

---

## §6 — Dimension 5: Authorization & tenancy

**Verdict: CONDITIONALLY READY**

### 6.1 What is proven

Multi-tenant isolation is built on four RLS helper functions —
`is_global_admin()`, `current_user_role(uuid)`, `user_has_hospital_access(uuid)`
and `user_has_hospital_role(uuid, text[])` — and these are the four routines in
privilege category A. Tenant scoping traced correctly in every path examined.
`role_permissions` correctly grants `MANAGE_HOSPITAL` to both admin roles
(`27:77`, `27:97`).

Critically: **no cross-tenant data access path was found.** Not one. For a
multi-tenant system intended for commercial hospital deployment, that is the
single most important negative finding available, and it held up under
deliberate search.

### 6.2 What blocks readiness

The blocker is the three-way inconsistency documented at P1-02 above (drift
D-06), plus one untested hazard:

**The `is_primary` lockout hazard is untested.** The seed data sets all four
profile rows to `is_primary: true`. If the production intent is that exactly
one profile per hospital is primary, the seed does not model production. If
multiple primaries are legal, then the routines that assume a single primary
need review. Either way, no test covers the case where a hospital ends up with
zero primary profiles — the lockout case, which is the one that generates a
support call at 2 a.m.

### 6.3 Gate conditions

1. NPD-04 decision (as §5.4 gate 3).
2. Add coverage for the zero-primary and multiple-primary cases, and make the
   seed reflect the intended production invariant.
3. Re-run tenancy isolation tests against a live database once Docker is
   available — the static reading is clean, but RLS is a runtime control and
   `CERTIFICATION_RECONCILIATION.md` suspends its live confirmation.

---

## §7 — Dimension 6: Financial integrity

**Verdict: NOT READY**

### 7.1 The chain, traced end to end

Per PART 15 the financial path was traced as one continuous chain: booking fee →
payment order → verification → ledger → refund → settlement → outstanding
balance. Six defects sit on it.

| # | Defect | Location | Effect |
|---|---|---|---|
| 1 | `booking_fee_inr` has no runtime writer (**P0-04**) | backfill only, migration `28` | 2 of 3 refund paths compute from an unpopulated column |
| 2 | No payment order is created at booking (**P1-05**) | `create-booking/index.ts`, 688 L, zero payment references | the quoted fee is never made collectable |
| 3 | Refund basis differs across the three paths (**P1-10**) | — | partial refunds over-adjust settlement |
| 4 | `idempotent_capture_payment` discards the BOOLEAN returned by `capture_payment` | `16:421` | the capture's own success signal is thrown away |
| 5 | Gateway fee is always estimated, never actual (**P2-04**) | 4-arg overload at `34:249`, `ROUND(amount * 0.02, 2)` | every settlement carries a synthetic fee |
| 6 | Re-capture window excludes only `('captured','refunded')` (**P2-03**) | `capture_payment` | a partially refunded order can be re-captured |

Plus three reporting-level defects: `get_reconciliation_summary` has three
defects that surface at `financial-command-center:158`, and `settlement-engine`'s
`record_payment` path **always returns 500** (deprecated in migration `33`, then
throws at `:418`) — drift D-20.

### 7.2 The two structural issues that are decisions, not bugs

**GST is booked but never charged (P2-02, NPD-01).** `capture_payment` writes a
`gst_debit` ledger line. `get_effective_fees` — the v2 implementation from
migration `35` — excludes GST from the amount quoted to the patient.
`get_booking_fee`, which does handle GST, has no callers. So the ledger records
a tax component that was never collected from anyone. For an Indian hospital
deployment this is not a rounding matter; it is a tax-position question that
requires a finance owner, which is why it is NPD-01 and not a P1.

**Revenue is recognised at booking INSERT (NPD-02, drift D-14).** `13:479`
recognises revenue when the booking row is created, and migration `07` creates a
daily collection entry for **every** booking with no `WHEN` clause. Combined
with P1-05 (no payment order at booking) the system recognises revenue for
bookings that have no collection mechanism attached. Whether that is correct
depends on a revenue-recognition policy that has not been stated.

### 7.3 What is nonetheless correct

- The ledger is immutable and the freeze trigger is untouched. Phase 1.5's
  claim — *"Financial counts mean what they say, with the ledger and the frozen
  trigger untouched and reconciliation exact"* — is **upheld as to the ledger
  mechanism**, and narrowed as to the counts, because several of the numbers
  written into that correct mechanism are derived from the defects above.
- The migration-`41` refund replay guard is real and is properly tested. No
  double-refund path was found.
- No double-capture path and no ledger-duplication path was found other than
  the P2-03 re-capture window, which requires a partially refunded order.
- `create_platform_revenue_summary` (`33:176`) uses an advisory lock — a
  correct choice, correctly applied.

### 7.4 Gate conditions

1. Close P0-04. Nothing else in this dimension can be validated first, because
   the refund figures depend on it.
2. Resolve P1-05 and P1-10.
3. Decide NPD-01 (GST) with a finance owner, and NPD-02 (revenue recognition)
   with the same owner. These are the two items in the whole audit that
   engineering **cannot** resolve alone.
4. Replace the estimated gateway fee with the actual value from the gateway
   response, or relabel the column as an estimate so downstream consumers stop
   treating it as actual.
5. Perform one end-to-end reconciliation against a real gateway settlement file
   before any hospital is invoiced from these figures.

---

## §8 — Dimension 7: Operational readiness (scheduling, workers, recovery)

**Verdict: NOT READY**

This is the weakest dimension in the system and it holds three of the four P0
gaps. It is also the dimension where the gap between what is *built* and what
*runs* is widest: the machinery is present, well-designed, and largely
disconnected.

### 8.1 P0-02 — nothing schedules anything

There is no scheduler. No `pg_cron` job, no `cron.schedule` call, no external
scheduler configuration, and no deployment manifest that invokes
`run-cron-minute` or `run-cron-nightly`.

Both cron entrypoint functions exist and are correct in structure. Both are
described in the reports as running on a schedule —
`CROSS_CHECK_REPORT.md` §2.4 states *"Minute cron runs master scheduler +
health snapshot; nightly cron runs carry-forward, MV refresh, rollups, SLA,
retention, partitions"*. Every one of those seven nightly workloads is real
code. **None of them executes**, because nothing calls the function that calls
them.

Everything downstream of the scheduler is therefore dormant: carry-forward,
materialized-view refresh, rollups, SLA refresh, retention, partition checks,
the health snapshot, and the master scheduler itself.

### 8.2 P0-01 — job crash recovery is dead

This is the most consequential single finding in the audit, because the
mechanism *appears* to work, is *certified* as working, and cannot work.

The chain:

| Step | Fact | Location |
|---|---|---|
| 1 | `claim_jobs_v2` claims jobs with `FOR UPDATE SKIP LOCKED` and **never sets `lease_expires_at`** | v2 implementation |
| 2 | `reclaim_stale_jobs` finds abandoned jobs by **filtering on `lease_expires_at`** | v2 recovery |
| 3 | Therefore no job is ever reclaimable — the predicate matches nothing | derived |
| 4 | The **v1** `claim_jobs` *did* set `lease_expires_at` | `06:283` |
| 5 | The v2 recovery routines have **zero callers** in any case | reachability scan |
| 6 | `stop_worker`'s comment references `recover_crashed_worker_jobs`, **which does not exist** | drift D-25 |
| 7 | `CROSS_CHECK_REPORT.md:175` certifies this works: *"worker_registry + heartbeat (25 % sampled) + detect_crashed_workers() + lease reclaim — verified in migration 19"* | — |
| 8 | The same report describes `claim_jobs_v2` as having *"lease tracking"* | §2.4 |

Steps 7 and 8 are the withdrawn sub-claims. The lease tracking was lost in the
v1 → v2 migration; the recovery code that depends on it was retained unchanged;
and the report describing the pair was written from the design rather than from
the v2 implementation. If a worker dies mid-job in production, that job stays
claimed forever. It will not retry, it will not dead-letter, and no alert will
fire, because the detection path is the path that is dead.

The exponential-backoff and dead-letter machinery *itself* is correct —
`POWER(2, retry_count)` backoff and `dead_letter_jobs` on max attempts both
verified. They simply never receive a crashed job to act on.

### 8.3 P0-03 — the worker is unreachable under the documented default

`.env.example` ships `ENABLE_WORKER_TRIGGER=false`. An operator following the
documented configuration deploys a system in which the background worker is
never triggered. Combined with P0-02 (no scheduler) and P1-09 (`verify_jwt`
blocking machine endpoints), there are **three independent reasons** the async
layer does not run, each sufficient on its own.

### 8.4 The nightly authentication mismatch

Nightly step 9 always returns 403. `run-cron-nightly:296` sends
`SUPABASE_SERVICE_KEY.slice(-20)`; `run-background-worker:301` expects
`CRON_SECRET`. Two different values, compared for equality.

The same line is a documented-contract violation: Phase 2's architecture states
the nightly cron **must NOT wake the worker**, and `run-cron-nightly:296` wakes
the worker (drift D-05). So the call is both prohibited and broken. It has never
succeeded, which is the only reason the prohibition has not been observably
violated in a running system.

### 8.5 Queue-runtime resilience: the part that does work

| Control | Evidence | Status |
|---|---|---|
| `advance_queue` concurrency-safe | `SKIP LOCKED`, `02:603` | VERIFIED |
| Pause / delay semantics | `queue_sessions` | VERIFIED |
| Snapshot for clients | `get_queue_snapshot` | VERIFIED |
| Event recording | `record_queue_event` → immutable `queue_runtime_events` | VERIFIED |
| SLA refresh entrypoint | `trigger_sla_refresh` | VERIFIED (but unscheduled — §8.1) |
| Realtime delivery | `queue_runtime_events` published, RLS enabled and forced | VERIFIED |

Workflow E (queue failure and recovery) therefore has a correct *data* path and
no working *recovery* path: the queue itself survives concurrency correctly, and
the jobs that maintain it do not survive a worker crash.

### 8.6 Gate conditions

1. **P0-02:** commit an actual schedule for `run-cron-minute` and
   `run-cron-nightly`, then verify from `job_queue` / `worker_heartbeat_log`
   that the seven nightly workloads ran.
2. **P0-01:** restore lease assignment in the claim path so
   `reclaim_stale_jobs` has something to match, wire the v2 recovery routines to
   a caller, and prove it with a killed-worker test that asserts the job is
   re-claimed. Remove the comment naming the nonexistent function.
3. **P0-03:** decide the intended default for `ENABLE_WORKER_TRIGGER` and make
   `.env.example` express it. If `false` is intentional, document what is
   expected to trigger the worker instead.
4. Reconcile the `CRON_SECRET` mismatch, and resolve whether nightly is allowed
   to wake the worker at all (drift D-05) before making the call succeed.
5. Give `create_partition` a handler or remove it from the claimable set; give
   `refresh_analytics` and `send_notification` producers or retire them.

---

## §9 — Dimension 8: Observability, alerting & monitoring

**Verdict: NOT READY**

### 9.1 Why this dimension inherits its verdict

Observability in SETURA is largely *derived* — health snapshots, rollups, SLA
metrics and materialized views are produced by scheduled work. With P0-02 open,
the production side of the observability pipeline does not run. The dashboards
would render, and they would render stale or empty data, which is the failure
mode most likely to be mistaken for "quiet".

### 9.2 Specific findings

**P2-05 — five materialized views have zero consumers**, and one of them is
duplicated in logic by `get_revenue_forecast` (`47:1556`). Five MVs are
refreshed (or would be, if the scheduler ran) to serve nothing, while a live
function recomputes one of their results independently. Two sources of truth for
forecast revenue, and the reports do not say which is authoritative (drift D-16).

**P2-06 — partition automation misreports itself**, as covered in §4.2. In an
observability context this is worse than elsewhere: a readiness check that
returns a false reassurance is an anti-control.

**P1-12 / alerting.** `alert-center` maps PostgreSQL error `42501`
(insufficient_privilege) to HTTP 500 rather than 403 (P3-01, drift D-28). Low
severity in isolation; in an alerting subsystem it means a permissions
misconfiguration presents as a server fault, and will be triaged as the wrong
class of incident.

**No end-to-end monitoring proof exists.** No evidence was found that any alert
has ever fired, that any health snapshot has ever been written by the scheduled
path, or that any operator-facing dashboard has been validated against a live
database. This is recorded as UNPROVEN.

### 9.3 What is built and ready to work

The instrumentation itself is sound: structured logging is centralised in
`logger.ts` with only 2 `console.*` calls in the entire codebase (both inside
the logger), worker heartbeats are sampled at 25 %, `worker_heartbeat_log` and
`worker_registry` exist and are well-modelled, and `queue_runtime_events` gives
a complete immutable event trail for the queue. This dimension is NOT READY
because of activation, not because of absence.

### 9.4 Gate conditions

1. Close P0-02, then verify a health snapshot row appears without manual
   invocation.
2. Assign each of the five MVs a consumer or retire it; name the authoritative
   forecast source.
3. Correct the partition-readiness message.
4. Map `42501` to 403.
5. Fire one alert end to end, from condition to operator-visible surface, and
   record the evidence.

---

## §10 — Dimension 9: Test & verification confidence

**Verdict: CONDITIONALLY READY**

### 10.1 The gates that were actually executed in this audit

Per PART 17 this dimension asks *"does the test suite provide meaningful
evidence?"* — not *"how many tests exist?"*. These are the gates I ran myself,
read-only:

| Gate | Result |
|---|---|
| `deno task validate:migrations` | 49 files, **0 errors, 4 warnings** |
| `deno fmt --check` | 259 files, exit 0 |
| `deno lint` | 75 files, clean |
| `deno task check` | 0 errors |
| `deno task test` (unit) | **65 passed / 0 failed (905 ms)** |
| `deno task test:integration` | **NOT RUN** — Docker unavailable |

The unit result is an **exact match** to Phase 1.5's claimed 65/0. That is the
strongest single corroboration of any completion report in this audit: an
independently re-executed gate reproducing the reported figure to the test. It
substantially raises the credibility of Phase 1.5's process claims, and it is
the main reason `CERTIFICATION_RECONCILIATION.md` narrows rather than revokes.

The integration suite's **162 cases were count-verified statically** but never
executed. Its result is UNPROVEN. Similarly the security regression suite's
34/0 is SUSPENDED PENDING VERIFICATION.

### 10.2 The warning count: a small, instructive correction

Every phase report from 0.5 through 1.4 states *"3 pre-existing warnings"*. The
validator now emits **4**:

1. `dashboard_presence` — migrations 11 + 20
2. `check_partition_readiness` — migrations 15 + 22
3. `partition_health` view — migrations 15 + 22
4. `idx_alert_events_open` — `24:140` and `47:83`

Warning 4 arrives with migration `47`. So **each report was correct at its own
date**, and the phrase became stale only because it was copied forward
unexamined (drift D-26, P3-07). This is the mildest finding in the audit and
also the clearest illustration of its central mechanism: text copied between
reports acquires authority it never earned. The same mechanism produced the
"37 migrations" figure at HEAD 49 (D-22) and the "PostgreSQL 15" claim against
`config.toml:36 major_version = 17` (D-21).

### 10.3 Where the suite does not provide evidence

**P2-14 — the test suite is absent at every defect site.** This is the finding
that matters most in this dimension. Every one of the four P0s and most of the
P1s sits in a code path with no test that would have caught it:

| Defect | Test situation |
|---|---|
| P0-01 job crash recovery dead | no killed-worker test exists |
| P0-02 nothing scheduled | no test asserts the scheduler exists |
| P0-03 worker unreachable by default | no test exercises the documented default config |
| P0-04 `booking_fee_inr` no writer | `whatsapp_conversational.test.ts:838` asserts against fixture data and **passes** |
| P1-10 refund basis | `refund_sync.test.ts` covers full refunds only |
| P1-01 webhook secret | no test uses a real Razorpay webhook signature |
| Privilege exposure | 10 of 11 test-only routines covered *solely* by `REVOKE` assertions in `privilege_isolation.test.ts` |

The suite is well-written where it exists and its 65 unit cases pass
reproducibly. Its weakness is coverage *placement*: it tests the paths that
work.

### 10.4 What Phase 1.5 claimed about test integrity, and whether it holds

Phase 1.5 §19.1 states: *"No test was deleted, no assertion weakened, no
validator finding suppressed, and `--no-check` was not used."* Checked
independently: the test counts across phases increase monotonically
(37 → 61 → 77 → 89 → 105 unit-plus-integration by phase gate), no `--no-check`
appears in the task definitions, and `deno task check` returns 0 errors.
**That claim is upheld.** It is a narrow claim and it is true.

### 10.5 Gate conditions

1. Run `deno task test:integration` and the security regression suite on a live
   stack, and publish the actual figures. This is the largest single
   verification debt in the audit.
2. Add a test at each of the seven defect sites in §10.3. The `booking_fee_inr`
   case should assert against a row created by the *production* write path.
3. Update the "3 pre-existing warnings" text to 4 wherever it is copied.

---

## §11 — Dimension 10: Deployment & configuration readiness

**Verdict: NOT READY**

### 11.1 Why

Three of the four P0s and two P1s are **configuration** defects, not code
defects:

| Gap | Configuration fact |
|---|---|
| P0-02 | no schedule is configured anywhere |
| P0-03 | `.env.example` ships `ENABLE_WORKER_TRIGGER=false` |
| P1-01 | `RAZORPAY_WEBHOOK_SECRET` is referenced by no file and set by no example |
| P1-09 | `verify_jwt=true` on all 7 machine endpoints |
| §8.4 | `CRON_SECRET` expected by the receiver, service-key suffix sent by the caller |

An operator who deploys SETURA exactly as documented gets a system in which the
async layer never starts, the webhook verification is anchored on the wrong
secret, and the machine endpoints reject their own callers. Each is a one-line
configuration matter. Collectively they are the reason this dimension is NOT
READY and the reason drift D-17 ("nothing schedules anything") and D-18
(".env.example ships the disabling default") are both rated HIGH.

### 11.2 What is ready

- **CI is real and blocking.** This was checked, not assumed.
- All migrations apply cleanly from scratch, `01`–`49`, per the reported db
  reset gate — and the validator independently confirms 49 files parse with 0
  errors.
- Seed data exceeds the Phase 0 stated minimum.
- No secrets are committed to the repository.

### 11.3 Residual configuration hygiene (P3, safe to carry)

- **P3-02 / D-23** — two sources of generated types, and `gen:types:check` is
  never invoked in CI. Drift between DB schema and TypeScript types is therefore
  undetected by automation.
- **P3-03 / D-24** — `WORKER_LEASE_SECS` is a dead knob: configurable, read
  nowhere. An operator tuning it changes nothing. (It is also, pointedly, the
  knob that would matter if P0-01's lease tracking existed.)
- **P3-04 / D-29** — 18 of 49 migrations lack explicit `BEGIN;` / `COMMIT;`.
  Supabase wraps each file in a transaction, so this is stylistic rather than
  unsafe, but it is inconsistent within the same directory.
- **P3-08 / D-30** — migration `49` is internally self-inconsistent.
- **P3-09 / D-27** — India-specific assumptions (currency, GST, phone format,
  timezone) are embedded without being declared as assumptions. For a product
  positioned as multi-tenant SaaS this becomes a scoping question the moment a
  non-India tenant is contemplated.

### 11.4 Gate conditions

1. Fix the five configuration facts in §11.1 and prove each by observing the
   intended behaviour, not by re-reading the file.
2. Add `gen:types:check` to CI.
3. Either wire `WORKER_LEASE_SECS` or remove it from the configuration surface.
4. Declare the India assumptions explicitly in the architecture documentation.

---

## §12 — Dimension 11: Frontend / product completeness

**Verdict: NOT READY — and, more precisely, NOT ASSESSABLE from this codebase**

Per RULE 5 this dimension must be reported separately from backend
completeness, and per PART 27 it must be reported honestly. The honest report is
short.

The audited repository is a backend and platform codebase: 49 SQL migrations, 21
Edge Functions, 16 shared modules, a test suite, and documentation. There is no
patient-facing application, no hospital-staff console, and no doctor-facing
client in this repository to audit. Three requirements in
`CROSS_PHASE_REQUIREMENTS_MATRIX.md` §9 are classified **OUT OF SCOPE** on
exactly this basis.

What can be said:

1. **The backend does not block a frontend.** `get_queue_snapshot`, the Realtime
   publication on `queue_runtime_events`, and the 20 authenticated user-facing
   endpoints form a usable client contract.
2. **A frontend built today would surface wrong money.** Per §7, fee, refund,
   GST and settlement figures are affected by P0-04, P1-05, P1-10, P2-02 and
   P2-04. A client displaying them would be faithfully rendering incorrect
   values.
3. **A frontend built today would surface stale analytics**, per §9, because
   nothing refreshes them.
4. **27 % of the SQL surface has no caller** (P2-11), some of which is presumably
   waiting for precisely this client. That backlog is not sized anywhere.

Marking this READY would require a frontend to exist. Marking it CONDITIONALLY
READY would imply the conditions are small. Neither is true, so it is NOT READY
with the scope limitation stated plainly rather than disguised as a low score.

### 12.1 Gate conditions

1. State where the client applications live and whether they are in scope for
   the next phase. This is a scoping statement, and its absence is currently the
   largest ambiguity in assessing product completeness.
2. Do not begin building money-displaying screens until §7's gates close.

---

## §13 — Dimension 12: Real-hospital readiness

**Verdict: NOT READY**

This dimension is the one the product's own positioning makes the operative
question, so it is stated without softening.

**SETURA must not be deployed into a live hospital in its current state.**

The reasoning is not the count of open gaps — it is the *character* of four of
them.

| # | Reason | Consequence in a live hospital |
|---|---|---|
| 1 | Nothing schedules anything (P0-02) | no carry-forward, no SLA refresh, no retention, no rollups, no health snapshots. Operational state silently ages. |
| 2 | Job crash recovery is dead (P0-01) | a worker crash strands work permanently, with no retry, no dead-letter, and no alert — the detection path is itself the dead path |
| 3 | The worker is off by documented default (P0-03) | WhatsApp confirmations, notifications and async work do not run at all on a by-the-book deployment |
| 4 | `booking_fee_inr` has no writer (P0-04) | refunds to real patients computed from an unpopulated column |

Items 1–3 mean the asynchronous half of the system does not run. Item 4 means
money owed to patients is computed from a value nobody writes. In a hospital, 3
manifests as a patient who never receives a confirmation, and 4 manifests as a
refund dispute the system cannot substantiate.

Two governance facts compound this:

- **D-04 — the schema freeze was breached with no amendment record.** For a
  regulated deployment, change control that is documented but not enforced is a
  finding in its own right.
- **D-14 / NPD-02 — revenue is recognised at booking INSERT**, with a daily
  collection entry created for every booking and no payment order attached
  (P1-05). Financial reports generated on that basis will not survive scrutiny.

### 13.1 What is genuinely reassuring

It would be dishonest to close this dimension on the negatives alone, because
the evidence supports three strong statements:

1. **No cross-tenant data access path exists.** For multi-tenant hospital data,
   this is the finding that matters most, and it held under deliberate search.
2. **The financial ledger is immutable and its freeze trigger is intact.**
   Wrong figures in this system are *discoverable and correctable*. That is a
   materially different risk posture from wrong figures in a mutable store.
3. **Clinical-adjacent data is append-only.** `consultation_notes`, `audit_logs`
   and `queue_runtime_events` cannot be silently rewritten.

The system's *integrity* foundations are sound. Its *activation* is not.

### 13.2 Gate conditions

1. All four P0 gaps closed **and independently verified against a live stack**.
2. `deno task test:integration` and the security regression suite executed with
   published results.
3. `pg_proc.proacl` published for all 191 routines.
4. NPD-01 (GST) and NPD-02 (revenue recognition) decided by a finance owner.
5. One complete rehearsal of Workflow A (normal patient journey) and Workflow D
   (cancellation and refund) against a live stack, with the ledger inspected
   afterwards.
6. A named on-call owner for the async layer, since P0-01 means silent job loss
   is currently undetectable by the system itself.

---

## §14 — RULE 5 seven-axis standing summary

RULE 5 requires that backend completeness, functional completeness, security,
operations, product, deployment and real-hospital readiness be reported
*separately* and never merged into a single score. This is that separation. It
is the same table as `CROSS_PHASE_REQUIREMENTS_MATRIX.md` §16 and is reproduced
here so this report stands alone.

| Axis | Dimension | Standing | Single sentence of justification |
|---|---|---|---|
| **A** | Backend architectural completeness | **STRONG, PARTLY UNREACHABLE** | SQL-first contract honoured, 0 validator errors, zero destructive DDL — but 27 % of 191 routines have no reachable caller. |
| **B** | Backend functional completeness | **INCOMPLETE** | Queue, tokens, state machine and WhatsApp retry all verified; the payment/refund path carries P0-04, P1-05, P1-10 and two unreachable refund states. |
| **C** | Security completeness | **INCOMPLETE, ONE MAJOR ITEM UNPROVEN** | Auth/authz present on all 20 user-facing endpoints and the webhook verifier is exemplary; the 191-routine PostgREST exposure is disclosed but unmeasured, and `has_permission()` is architecturally inconsistent. |
| **D** | Operational readiness | **NOT OPERATIONAL** | Nothing is scheduled, crash recovery cannot fire, and the worker is disabled by the documented default — three independent stoppages. |
| **E** | Frontend / product completeness | **NOT ASSESSABLE** | No client application exists in this repository; three requirements are OUT OF SCOPE on that basis. |
| **F** | Production deployment readiness | **NOT READY** | Five configuration facts, each one line, prevent a by-the-book deployment from functioning. |
| **G** | Real-hospital readiness | **NOT READY** | The async half does not run and patient refunds derive from an unwritten column; tenancy isolation and ledger immutability are nonetheless sound. |

**No composite score is offered.** Per RULE 5, and because the axes fail for
unrelated reasons, averaging them would produce a number that describes nothing.
The one derived percentage in this audit — 50.3 %, being 74 of 147 audited
requirements VERIFIED COMPLETE — belongs to axes A and B only and is defined in
§0.5.

---

## §15 — Recommended next phase

Derived **only** from audit findings, per the mandate. No new feature is
proposed; every item below maps to an existing requirement, roadmap commitment
or architectural contract already traced in this audit.

### 15.1 The recommendation

**Do not start Phase 2. Run a Phase 1.6 — "Runtime Activation & Verification".**

The name matters. This is not a remediation phase in the sense of rewriting
architecture, and it is not a feature phase. Its content is: *make the built
system actually run, then measure it.* Every item is either a wiring fix, a
configuration fix, a measurement, or a product decision. None is a new
capability.

The justification is the audit's central structural finding, established
independently in `ARCHITECTURAL_DRIFT_REGISTER.md` §2.3: **all four P0 gaps are
downstream of recorded drift, and none of the four is a coding error.** They are
a lost lease assignment during a v1→v2 migration, an absent scheduler, a
disabling default in the example environment, and a backfill that was never
followed by a runtime writer. A feature phase layered on top of these would
inherit all four, and — because P0-01 disables the very mechanism that would
report async failure — would inherit them *silently*.

### 15.2 Phase 1.6 content, in dependency order

**Gate 1 — Restore the runtime (P0-02, P0-03, P1-09, `CRON_SECRET`).**
Nothing else can be verified until the system runs. Schedule the two cron
entrypoints; settle `ENABLE_WORKER_TRIGGER`; resolve the machine-endpoint JWT
boundary (NPD-05); reconcile the cron secret. Exit criterion: the seven nightly
workloads leave evidence in the database without manual invocation.

**Gate 2 — Restore crash recovery (P0-01).**
Restore lease assignment in the claim path, give the v2 recovery routines a
caller, delete the comment naming a nonexistent function. Exit criterion: a
deliberately killed worker's job is re-claimed and completed, proven by a test.

**Gate 3 — Restore financial truth (P0-04, P1-05, P1-10, P2-03, P2-04).**
Establish a runtime writer for `booking_fee_inr`; settle whether booking creates
a payment order; unify the refund basis; close the re-capture window; stop
presenting an estimated gateway fee as actual. Exit criterion: Workflow D
(cancellation and refund, including a **partial** refund) rehearsed end to end
with the ledger inspected afterwards.

**Gate 4 — Measure what is currently unproven.**
Three measurements, all read-only, all blocked today only by Docker:
`pg_proc.proacl` for 191 routines; `deno task test:integration` (162 cases); the
security regression suite (34 cases). Exit criterion: 12 SUSPENDED claims in
`CERTIFICATION_RECONCILIATION.md` §10.2 resolved to UPHELD or WITHDRAWN.

**Gate 5 — Close the authorization decision (P1-02, NPD-04).**
Decide union vs least-privilege vs deny for multi-role users, then make
`has_permission()`, `current_user_role()` and `selectRole` all implement it.
Independently and immediately: make `has_permission()` respect
`profiles.is_active`. Exit criterion: one documented rule, three conforming
implementations, tests for the deactivated-user and zero-primary cases.

**Gate 6 — Product decisions (NPD-01…NPD-06).**
Six decisions requiring named owners, two of which (GST, revenue recognition)
engineering cannot take alone. Exit criterion: each decision recorded with an
owner and a date.

**Gate 7 — Governance repair.**
Amend or lift the Phase 0.5 freeze on the record; backfill `migration_registry`
to 49/49 or delete it; correct the stale copy-forward text (4 warnings not 3, 49
migrations not 37, PostgreSQL 17 not 15); name the canonical path for each
duplicated orchestration; declare the India assumptions. Exit criterion: no
governance artefact asserts something the code contradicts.

### 15.3 What Phase 1.6 explicitly should not do

- **Not** a refactor. The architecture is sound; §2 and §4 establish this with
  evidence.
- **Not** a new-feature phase. PART 25 forbids it and the audit found no
  requirement needing new capability.
- **Not** a test-count exercise. Per §10, the suite's problem is placement, not
  volume: seven specific defect sites need coverage, and adding tests anywhere
  else would raise the count without raising confidence.
- **Not** a certification re-run. `CERTIFICATION_RECONCILIATION.md` narrowed 5
  certifications and revoked 0; the existing certifications remain valid within
  their narrowed scope, and re-issuing them before Gate 4 would repeat the exact
  error this audit documents.

### 15.4 After Phase 1.6

Once Gates 1–4 close, the P1/P2/P3 backlog (13 · 15 · 10) is ordinary
engineering work that can proceed in parallel with Phase 2 feature development.
The distinction is deliberate: the four P0s are *phase-blocking* because they
make the system's own reporting untrustworthy, and the remaining 44 gap entries
are not.

---

## §16 — Limits of this report

Stated per PART 27, so that no reader over-reads it.

1. **No live execution.** Docker was unavailable throughout. Every verdict above
   rests on static evidence — source, migrations, configuration, generated
   types, and the five gates that run without a database. Anything requiring a
   running stack is marked UNPROVEN and is listed in §15.2 Gate 4.
2. **The integration suite was never executed.** Its 162 cases were
   count-verified by reading the files. Their pass status is unknown to this
   audit, and Phase 1.5's 162/0 claim is neither confirmed nor contradicted.
3. **No production environment was inspected.** Findings about `.env.example`
   and `verify_jwt` describe the documented and committed configuration. A
   deployed environment may differ, and if it does, P0-02, P0-03 and P1-09 may
   already be mitigated there — which is precisely why their gate conditions are
   phrased as measurements.
4. **This report assesses readiness, not quality of intent.** Several findings
   read harshly in table form while describing careful work that lost a detail
   in transit — the v1→v2 lease loss being the clearest case. The audit records
   effects, not blame.
5. **Twelve dimensions is this audit's decomposition**, chosen to satisfy PART
   22 and to keep RULE 5's seven axes separable. A different decomposition would
   redistribute the same findings; it would not change them.
6. **Nothing in this audit was fixed.** Per RULE 1 and the FINAL RULE, no source
   file, migration, test, configuration file or pre-existing document was
   modified. Every "gate condition" is a description of work not yet done, not a
   record of work performed.
