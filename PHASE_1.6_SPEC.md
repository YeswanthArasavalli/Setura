# PHASE 1.6 — AUTHORITATIVE GOVERNANCE SPECIFICATION

**Document status.** ACTIVE. This is the authoritative governance
specification for Phase 1.6.

**Created.** 2026-08-23, under the project-lead decision authorizing
Option C of the Gate 3 closure decision analysis.

**Authority for this file.** PART 9 of the Option C authorization
("Create `PHASE_1.6_SPEC.md`. This must become the authoritative Phase
1.6 governance specification."). It is a documentation write. No source
file, migration, test, privilege, RLS policy, configuration, database
row, container, or prior deliverable was modified to produce it.

**Relationship to `CLAUDE.md`.** Subordinate. `CLAUDE.md` is the
repository operating contract and outranks this file on every point it
addresses. Where this file is silent, `CLAUDE.md` governs. This file was
not permitted to modify `CLAUDE.md` and did not.

**Why this file exists.** Phase 1.6 executed a nine-step Gate 3 against a
step list that was never written to any repository file. The list existed
only in conversation context, that context was compacted, and four of the
nine step definitions were destroyed. The findings those steps produced
survived — because a durability snapshot was authorized mid-gate — but
the specification that produced them did not. This file is the repair:
from here forward, no Phase 1.6 gate step may exist only in conversation.
The governance finding is recorded as **GOV-01** in §12.

---

## 1. PHASE OBJECTIVE

Phase 1.6 is a **verification and governance phase**. Its objective is:

> Determine, from evidence, exactly what the SETURA backend has and has
> not been proven to do — and record that determination in a form that
> outlives any single working session.

Phase 1.6 is explicitly **not** a remediation phase. It does not fix
defects, implement missing subsystems, choose product architecture, or
advance the product's completion state. It measures, classifies, and
records.

Three consequences follow, and they are binding:

1. **Phase 1.6 may lower a claim but not raise a product's capability.**
   It can demote "verified" to "unproven" on evidence. It cannot make an
   unimplemented feature exist.
2. **Phase 1.6 may not repair a defect it discovers.** Discovery and
   remediation are separate phases. A defect found here is classified and
   registered, then left alone.
3. **Phase 1.6's own output is subject to the same evidence discipline it
   applies to prior phases.** A Phase 1.6 report claiming a measurement
   must cite the measurement.

## 2. SCOPE

### 2.1 In scope

- Reading and reconciling existing phase, audit, security, readiness,
  requirements-matrix and gap-register documents.
- Establishing a single canonical finding-ID scheme and a crosswalk from
  the competing schemes (delivered: `FINDING_ID_RECONCILIATION.md`).
- Local database and catalog measurement: `pg_proc.proacl`,
  `has_function_privilege()`, `pg_policies`, `pg_class.relrowsecurity`,
  table ACLs, extension state, job-queue state.
- Local container and runtime measurement: Docker inspection, Supabase
  service state, restart policies, container environment.
- Executing the committed test suites against the committed local stack.
- Static reading of test sources to determine whether a test proves what
  it claims to prove.
- Classifying every finding as product defect, test-quality gap,
  test-coverage gap, documentation defect, environment/tooling condition,
  governance defect, or product/architecture decision.
- Recording environment actions performed, per `CLAUDE.md` §32.

### 2.2 Out of scope

Out of scope for the whole of Phase 1.6, not merely for one gate:

- Any product remediation. Named explicitly: P0-01 (`claim_jobs_v2`
  lease), P0-02 (scheduler), P0-03 (`ENABLE_WORKER_TRIGGER`), P0-04
  (`booking_fee_inr` writer), F16-04 (privilege REVOKE discipline),
  F16-01 (Edge Runtime restart policy).
- Any change to RLS policies, table grants, function grants, queue
  architecture, or worker architecture.
- Any change to a test intended to obtain a passing result.
- Any deployment, any production access, any production credential.
- Creating real secrets. Local-only dummy values require separate
  explicit authorization before creation (§14.4).
- `supabase db reset` and every other destructive database operation,
  absent separate explicit authorization.
- `deno task fmt` and `deno task gen:types`, which rewrite files
  (`CLAUDE.md` §2). Their read-only counterparts `fmt:check` and
  `gen:types:check` are in scope.
- Choosing a scheduler architecture. That is NPD-05, a product decision
  reserved to the project lead (`CLAUDE.md` §15).
- Modifying `CLAUDE.md`.
- Modifying `graph_report.md` or `graphify-out/` (`CLAUDE.md` §6).

### 2.3 Scope boundary that is easy to get wrong

**Restarting a stopped container is an environment action inside scope.
Changing that container's restart policy is remediation outside scope.**
The first restores the measuring instrument; the second alters the thing
being measured. F16-01 is the live case: Edge Runtime may be started so
that Edge-dependent tests can run, and the fact that it carries
`RestartPolicy=no` must be recorded unchanged.

## 3. GATE INVENTORY

Phase 1.6 executed a **measurement-first Gate 0–8 scheme**. That scheme
was never enumerated in any repository file before this one. §4 records
what can be attested about each gate and, critically, distinguishes
gates whose definitions are supported by a persisted deliverable from
gates whose scope is known only by inference from a forward-pointer.

| Gate | Name (as attested) | Execution state | Definition source | Deliverable |
|---|---|---|---|---|
| 0 | Finding-ID reconciliation | EXECUTED | Persisted deliverable | `FINDING_ID_RECONCILIATION.md` |
| 1 | Local stack bring-up and environment measurement | EXECUTED | Findings only — no persisted step list | none (findings only) |
| 2 | Privilege census (catalog + runtime) | EXECUTED | Persisted deliverable | `PRIVILEGE_RUNTIME_VERIFICATION.md` |
| 3 | Runtime & integration verification | **PARTIALLY COMPLETE — NOT CERTIFIED** | Partially destroyed (see §5) | `PHASE_1.6_FINDINGS_LOG.md`, `PHASE_1.6_RUNTIME_TEST_REPORT.md` |
| 3R | Runtime & Integration Verification Successor | NOT STARTED | Persisted deliverable (this authorization) | `PHASE_1.6_GATE_3R_SPEC.md` |
| 4 | Local secret provisioning | NOT STARTED | Forward-pointer only | not authored |
| 5 | Worker / scheduler runtime proof | NOT STARTED | Forward-pointer only | not authored |
| 6 | **UNDEFINED** | NOT STARTED | **No evidence of scope exists** | not authored |
| 7 | RLS and table-privilege verification | NOT STARTED | Forward-pointer only | not authored |
| 8 | Severity assignment and register update | NOT STARTED | Forward-pointer only | not authored |

Two entries in that table are governance statements rather than
scheduling statements:

- **Gate 6 is UNDEFINED.** No persisted artifact anywhere in this
  repository states or implies a scope for Gate 6. It is not "planned but
  undocumented"; there is no evidence it was ever scoped. It must not be
  given a definition by inference from its number, from Gate 5, from
  Gate 7, or from the remediation-first scheme in
  `NEXT_PHASE_READINESS_REPORT.md` §15.2 (see §10.4, contradiction C-3).
- **Gates 4, 5, 7 and 8 have scope but not step lists.** Their scope is
  attested only by forward-pointers written during earlier gates. Under
  §12 that is insufficient to begin execution. Each requires its own
  persisted specification first, exactly as Gate 3R did.

## 4. GATE 0–8 DEFINITIONS

Each definition below states its **evidence tier**, which controls how
much weight the definition carries.

- **Tier A — attested by persisted deliverable.** The gate produced a
  file, and that file states its own purpose. The definition is
  reconstructable from the repository at any time.
- **Tier B — attested by findings only.** The gate produced findings that
  are recorded, and the findings imply the scope, but no step list was
  ever persisted.
- **Tier C — attested by forward-pointer only.** Another gate's
  deliverable says "deferred to Gate N", which establishes that Gate N
  has a subject, but not what its steps are.
- **Tier D — no attestation.** No evidence of scope exists.

### Gate 0 — Finding-ID reconciliation · Tier A

**Subject.** The repository carried three incompatible finding-ID schemes
that collided on 10 of 13 P1 IDs. Gate 0 fixed
`CROSS_PHASE_GAP_REGISTER.md` as canonical and built the crosswalk.

**Attestation.** `FINDING_ID_RECONCILIATION.md:3` self-identifies as
"Phase 1.6 · Gate 0 deliverable". `:307` states "Gate 0 is about labels."
`PRIVILEGE_RUNTIME_VERIFICATION.md:7` states "This document uses the
canonical Register scheme fixed by Gate 0", confirming Gate 0's output
was consumed downstream.

**State.** EXECUTED. Deliverable persisted. Not superseded.

### Gate 1 — Local stack bring-up and environment measurement · Tier B

**Subject, as implied by its findings.** Bring the committed local
Supabase stack up and measure what actually came up: per-service
container state, exit codes, restart counts, health, container
environment contents, and the presence or absence of local secret files.

**Attestation.** `PHASE_1.6_FINDINGS_LOG.md:30`: "F16-01, F16-02 and
F16-03 originate in Gate 1." Those three findings are, respectively:
`supabase start` exiting 0 while Edge Runtime stayed down; no `.env`
existing and Edge Runtime holding zero SETURA secrets; and
`supabase_vector_setura` crash-looping. Their subject matter is the
attestation.

**State.** EXECUTED. **No step list was ever persisted.** Gate 1 is
therefore a second instance of the GOV-01 pattern (§12), milder than
Gate 3's because no Gate 1 step definition is known to be missing — but
equally unable to prove its own completeness. **Gate 1 must not be
represented as certified.**

### Gate 2 — Privilege census (catalog + runtime) · Tier A

**Subject.** Establish the SETURA-owned database privilege boundary at
the catalog level and at runtime, and thereby resolve P1-11 ("The
privilege boundary from Phase 1.5 is unproven",
`CROSS_PHASE_GAP_REGISTER.md:252`).

**What it measured.** Of 479 public routines: 213 SETURA-owned, 266
extension-owned (stock Supabase, not assessed). Within the 213: 4
Category A RLS helpers with full EXECUTE by design; 179 locked B/C/D
routines with `anon`/`authenticated` EXECUTE confirmed absent both in
`pg_proc.proacl` and at runtime via SQLSTATE `42501`; 10 trigger-only
routines structurally non-callable through PostgREST regardless of
catalog grants; 9 locked plus 3 deliberately-open `SECURITY INVOKER`
helpers. Also discovered: F16-04, the default-privilege discipline gap.

**Cited but not measured here.** The figure of 139 public RLS policies
appears in this gate's deliverable at
`PRIVILEGE_RUNTIME_VERIFICATION.md:446` — but inside its *"Scope limits,
stated explicitly"* section, in a sentence whose subject is Gate 1 and
which expressly declines to assert the policies' correctness. Gate 2
**cited** the figure; it did not measure it. Its origin is not established
by any persisted artifact (§10.3).

**Attestation.** `PRIVILEGE_RUNTIME_VERIFICATION.md` in full.

**State.** EXECUTED. Deliverable persisted. Its measurements are
citable as established evidence by later gates without re-measurement.

### Gate 3 — Runtime & integration verification · partially Tier A

See §5. Frozen. Not certified.

### Gate 3R — Runtime & Integration Verification Successor · Tier A

See §6 and `PHASE_1.6_GATE_3R_SPEC.md`.

### Gate 4 — Local secret provisioning · Tier C

**Subject, as attested.** `PHASE_1.6_FINDINGS_LOG.md:103-109` records
F16-02 as "DEFERRED to Gate 4" and states "Local secret provisioning is
Gate 4 scope. Production secret provisioning remains a separate open
item outside Phase 1.6."

**What is NOT attested.** Which variables, what values, which tests
consume them, what authorization gate precedes creation, and whether any
file is created at all. None of that may be inferred.

**Interaction with Gate 3R.** Gate 3R Step 7 classifies F16-02; it does
not provision anything. If Gate 3R execution finds that a specific test
genuinely requires a specific variable, the response is to **stop and
report**, per §14.4 — not to widen Gate 3R into Gate 4.

**State.** NOT STARTED. Step list NOT AUTHORED. May not begin until
persisted.

### Gate 5 — Worker / scheduler runtime proof · Tier C

**Subject, as attested.** `PHASE_1.6_FINDINGS_LOG.md:82-83` notes that
F16-01 "may warrant escalation if it recurs during Gate 4 or Gate 5 and
blocks runtime proof of P0-02 or P0-03." P0-02 is the absent scheduler;
P0-03 is `ENABLE_WORKER_TRIGGER=false`. Gate 5's subject is therefore
runtime proof concerning those two — and only that much is attested.

**What is NOT attested.** Whether Gate 5 proves, disproves, or merely
characterizes them; whether it touches `claim_jobs_v2` / P0-01; and
whether it requires the scheduler decision (NPD-05) to be made first.

**Hard constraint carried forward.** Gate 5 cannot choose a scheduler
architecture. That is NPD-05, reserved to the project lead
(`CLAUDE.md` §15, §30).

**State.** NOT STARTED. Step list NOT AUTHORED.

### Gate 6 — UNDEFINED · Tier D

**No repository artifact states or implies a scope for Gate 6.**

This is a deliberate, evidence-based blank. It must not be filled by:

- inference from the number 6;
- interpolation between Gate 5 and Gate 7;
- the remediation-first Gate 6 in `NEXT_PHASE_READINESS_REPORT.md`
  §15.2, which belongs to a different and non-executed scheme (§10.4);
- any conversation-only recollection (§15).

If Gate 6 is to exist, the project lead defines it and it is persisted
before execution, as a new authorization.

**State.** UNDEFINED.

### Gate 7 — RLS and table-privilege verification · Tier C

**Subject, as attested.** `PRIVILEGE_RUNTIME_VERIFICATION.md:445` defers
RLS and table-privilege matters to Gate 7. The Gate 3 evidence
collection on zero-policy tables was explicitly labelled as collected
"for Gate 7", not for Gate 3 conclusions.

**Inputs already collected and preserved for it.** OBS-1 and OBS-2, both
recorded in §11.5 of this file. Neither is a finding.

**Boundary against Gate 3R.** Gate 3R Step 5 verifies runtime
default-deny behaviour only, within the scope its own specification
fixes. Architectural intent — whether a given table *ought* to have
policies — is Gate 7's question, not Gate 3R's.

**State.** NOT STARTED. Step list NOT AUTHORED.

### Gate 8 — Severity assignment and register update · Tier C

**Subject, as attested.** Four independent forward-pointers in
`PRIVILEGE_RUNTIME_VERIFICATION.md` (`:105`, `:415`, `:988`, `:1050`)
plus every "PROPOSED — NOT FINAL" severity in
`PHASE_1.6_FINDINGS_LOG.md` assign final severity and register updating
to Gate 8.

**Therefore, binding on all earlier gates.** No gate before Gate 8 may
assign a final severity, and no gate before Gate 8 may allocate an ID in
`CROSS_PHASE_GAP_REGISTER.md` (§7.3 explains why the second follows from
the first).

**State.** NOT STARTED. Step list NOT AUTHORED.

## 5. GATE 3 HISTORICAL STATUS

### 5.1 Frozen status

**Historical Gate 3 status: PARTIALLY COMPLETE — NOT CERTIFIED.**

This status is frozen. It is not provisional, not pending further work,
and not upgradeable. Gate 3R does not upgrade it — Gate 3R is a separate
gate with its own separate status.

### 5.2 Step-level record

| Step | Status | Attestation |
|---|---|---|
| Step 0 | COMPLETE | `PHASE_1.6_FINDINGS_LOG.md:9` self-identifies as "Step 0 of the Gate 3 resumption instruction" |
| Step 1 | COMPLETE | Named at `PHASE_1.6_FINDINGS_LOG.md:84` (recovery and endpoint confirmation) |
| Step 2 | COMPLETE | Named at `PHASE_1.6_FINDINGS_LOG.md:256` (live `pg_policies` count) |
| Step 3 | **UNRECOVERABLE** | never named in any persisted artifact |
| Step 4 | COMPLETE | Named at `PHASE_1.6_FINDINGS_LOG.md:187` and `:229` (privilege-suite execution) |
| Step 5 | **UNRECOVERABLE** | never named in any persisted artifact |
| Step 6 | **UNRECOVERABLE** | never named in any persisted artifact |
| Step 7 | COMPLETE | Named at `PHASE_1.6_FINDINGS_LOG.md:84` (post-test recheck) |
| Step 8 | **UNRECOVERABLE** | never named in any persisted artifact |

### 5.3 The unrecoverability statement

> The original objectives of Steps 3, 5, 6 and 8 could not be recovered
> from persisted project artifacts. They are therefore not reconstructed,
> not inferred and not treated as failed.

Each clause of that sentence is operative:

- **not reconstructed** — no objective has been written for them.
- **not inferred** — their numbers, neighbours, and the remediation-first
  scheme's identically-numbered gates are all rejected as sources.
- **not treated as failed** — FAIL is an evidence class that requires
  evidence. There is no evidence these steps failed. There is no evidence
  they succeeded either. The correct classification is UNRECOVERABLE,
  which is a statement about the *record*, not about the *work*.

### 5.4 Certification impact

1. **Historical Gate 3 must never be represented as fully certified.**
   Not by a later report, not by a summary table, not by a completion
   claim, not after Gate 3R passes. This prohibition has no expiry.
2. **Gate 3's completed steps remain fully citable.** Steps 0, 1, 2, 4
   and 7 produced real evidence; that evidence is not tainted by the
   missing step definitions and does not need re-measurement. In
   particular the `privilege_isolation.test.ts` result of **22 passed /
   0 failed** stands as an executed integration result.
3. **Gate 3 cannot be reopened.** A frozen gate is closed. Further
   runtime and integration verification happens in Gate 3R.
4. **The four unrecoverable steps do not block Phase 1.6.** They are a
   permanent gap in the record. Phase 1.6 proceeds through Gate 3R.

### 5.5 Gate 3's deliverable

`PHASE_1.6_RUNTIME_TEST_REPORT.md` is the Gate 3 closure record. It
carries the frozen status, the step-level record, the completed steps'
evidence, and the unrecoverability statement. `CLAUDE.md` §17 already
referenced that filename as "Gate 3, once complete"; the closure record
resolves that reference rather than creating a second competing file.

## 6. GATE 3R DEFINITION

**Name.** Gate 3R — Runtime & Integration Verification Successor.

**Specification.** `PHASE_1.6_GATE_3R_SPEC.md`, persisted before any
Gate 3R measurement, per PART 2 and PART 5 of the authorization.

**Non-reconstruction clause.** Gate 3R is a newly authorized successor
verification gate. It is NOT a reconstruction of historical Gate 3 and
does not claim to recover its missing requirements.

**Objective.**

> Establish reproducible local runtime and integration evidence for the
> currently unproven SETURA backend behaviours that are executable
> against the committed local stack, without claiming production
> verification.

**Steps.** Seven, each fully specified in `PHASE_1.6_GATE_3R_SPEC.md`
against the eight-field template in §12.3:

1. Environment / runtime readiness
2. Full integration suite execution
3. Edge-dependent runtime verification
4. Security / privilege regression verification
5. Runtime RLS / default-deny verification
6. Remaining cross-phase runtime verification
7. Environment limitation classification

**Numbering.** Gate 3R's steps are numbered 1–7 and are **unrelated** to
historical Gate 3's steps 0–8. Gate 3R Step 3 is not historical Gate 3
Step 3. No correspondence exists or may be asserted.

**Execution state at the time of writing.** NOT STARTED.

## 7. FINDING-ID AUTHORITY

### 7.1 Canonical source

`CROSS_PHASE_GAP_REGISTER.md` is the canonical finding source for
SETURA, per `CLAUDE.md` §18 and per Gate 0's reconciliation. Its scheme
is severity-prefixed:

| Prefix | Meaning | Count |
|---|---|---|
| `P0-NN` | blocker | 4 |
| `P1-NN` | high | 13 |
| `P2-NN` | medium | 15 |
| `P3-NN` | low | 10 |
| `NPD-NN` | non-product decision (product/architecture decision) | 6 |
| | **total entries** | **48** |

There is no `GOV`, `F16`, `OBS`, `C-` or other prefix in that register.

### 7.2 Non-canonical schemes

`CROSS_PHASE_AUDIT_REPORT.md` and `NEXT_PHASE_READINESS_REPORT.md` use a
different internal numbering that collides with the register on 10 of 13
P1 IDs. Consult `FINDING_ID_RECONCILIATION.md` before citing any P1/P2
finding from either. Never silently merge findings across schemes
(`CLAUDE.md` §18).

### 7.3 Phase 1.6's own working IDs, and why they are not register IDs

Phase 1.6 uses three working prefixes that are **not** register IDs:

- **`F16-NN`** — Phase 1.6 findings, F16-01 through F16-07, defined in
  `PHASE_1.6_FINDINGS_LOG.md`. Every severity is PROPOSED.
- **`OBS-N`** — Phase 1.6 observations that are explicitly **not**
  findings. See §11.5.
- **`GOV-NN`** — Phase 1.6 governance findings. GOV-01 is defined in
  §12.1 of this file. Severity PROPOSED.

**Why these are not allocated into the register.** In that register the
ID *is* the severity — allocating `P1-14` or `P2-16` to GOV-01 would
assign it a severity of P1 or P2 as an unavoidable side effect of
choosing the identifier. PART 10 of the authorization forbids that: "Do
not assign severity beyond PROPOSED. Gate 8 remains the authority for
final severity." The two instructions can only be satisfied
simultaneously by defining the finding here at PROPOSED and deferring
register allocation to Gate 8, which is the gate that holds severity
authority. The same reasoning applies to F16-01…F16-07: they remain
outside the register until Gate 8 places them in it.

### 7.4 Prohibitions

- Do not create a new `F16-NN` ID without evidence of an actual defect.
  Specifically: **do not create F16-08 from structural suspicion**, from
  an unreferenced table, from a broad grant on an RLS-protected table, or
  from any Graphify signal (`CLAUDE.md` §6, and PART 11 of the
  authorization).
- Do not renumber, merge, split or retire an existing ID outside Gate 8.
- Do not assign a final severity outside Gate 8.

## 8. EVIDENCE VOCABULARY

### 8.1 Verification levels

These are ordered, and **never interconvertible** (`CLAUDE.md` §3):

| Level | Means | Does NOT mean |
|---|---|---|
| IMPLEMENTED | code exists | it runs, or is reachable |
| STATICALLY VERIFIED | source/catalog inspection supports the claim | it executed |
| UNIT VERIFIED | a unit test executed and passed | integration behaviour |
| INTEGRATION VERIFIED | an integration test executed against the real local stack and passed | production behaviour |
| RUNTIME VERIFIED | the behaviour was observed executing | it is scheduled, or durable |
| PRODUCTION VERIFIED | observed in production | — |
| UNPROVEN | no evidence either way | it is broken |
| BLOCKED | measurement was attempted and prevented | it failed |
| FAIL | measured, and wrong | — |

### 8.2 Certification classes

PASS · FAIL · BLOCKED · UNPROVEN · NOT APPLICABLE.

**PARTIAL** — additionally available at *step* and *gate* level for
gate-internal status only (`PHASE_1.6_GATE_3R_SPEC.md` §5.1, §5.2.3): at
least one required measurement produced valid evidence while one or more
others could not be completed, and the record remains sound, bounded and
accurately classified. Constraints on its use:

- PARTIAL is **not** a substitute for any of the five classes above when
  reporting a *requirement's* or *finding's* state. Those remain
  `CLAUDE.md` §24's vocabulary.
- **PARTIAL must never be reported, summarized or carried forward as
  PASS**, and **must not be treated as FAIL** (§9 rule 9).
- A PARTIAL gate has not certified. §9 rule 2 still governs.

### 8.3 Finding states

OPEN · DEFERRED · NOT REMEDIATED · RESOLVED · UNRECOVERABLE.

UNRECOVERABLE is a statement about the *record*, not about the work, and
applies to specifications, not to defects.

### 8.4 Discriminators that must be preserved verbatim

These are the specific measurement rules Phase 1.6 established. Losing
any one of them silently converts a weaker claim into a stronger one.

**Privilege denial vs authentication failure.**

- `42501` = PostgreSQL privilege denial. The request reached the database
  and the database refused it.
- `PGRST301` (with "None of the keys was able to decode the JWT" / "No
  suitable key or wrong key type") = PostgREST JWT decoding failure. The
  request never reached the database.
- **HTTP status alone must never be used as privilege evidence.** Both
  cases return 401. The `code` field is the discriminator, not the
  status. This is `CLAUDE.md` §24 and the mechanism of F16-05.
- `PGRST202` = function not resolvable through PostgREST.
- `0A000` = trigger function invoked directly.

**Enqueue vs execution.** ENQUEUED → CLAIMED → PROCESSING → COMPLETED /
FAILED / DEAD-LETTERED. A row in `job_queue` proves enqueueing only. Do
not claim a worker executed because a job was enqueued (`CLAUDE.md` §14,
§34).

**Container start vs service health.** `supabase start` exiting 0 does
not prove any given service is up; F16-01 is the proven counter-example.
Per-service state must be measured. Separately: starting a container
does not change its `RestartPolicy`.

**Row absence vs RLS filtering.** An empty PostgREST result under `anon`
does not prove RLS filtered anything — the table may simply be empty.
The row-count-independent discriminator is `EXPLAIN` under `SET ROLE`,
where zero applicable policies compile to `Result … One-Time Filter:
false`.

**Static count vs executed count.** A test-case count obtained by reading
source is a count of *declarations*. A passed count requires execution.
`CLAUDE.md` §24: "A declared test count does NOT equal a passed test
count."

**Local vs production.** No local result may be restated as production
verification. No deployment exists.

## 9. CERTIFICATION RULES

1. **Evidence must match the claim.** The claim's verification level may
   not exceed the level of the evidence cited for it (§8.1).
2. **A gate certifies only if every one of its steps has a persisted
   definition and a recorded result.** A gate with an undefined step
   cannot certify, regardless of how its defined steps performed. This is
   the rule historical Gate 3 fails, and it is the reason its status is
   PARTIALLY COMPLETE — NOT CERTIFIED rather than PASS.
3. **A failure is never certified as a test problem by default.** Every
   failure must be classified as: implementation failure · environment
   failure · fixture failure · test assertion weakness · pre-existing
   issue. The classification requires evidence. "Never silently classify
   a failure as a test problem" (PART 6).
4. **A passing test certifies only what it asserts.** Reading assertions
   to determine what a passing test actually proves is part of the
   testing standard, not optional diligence (`CLAUDE.md` §21). F16-05 and
   F16-06 are the products of applying it.
5. **BLOCKED is a real outcome and must be reported as such.** If Docker
   is unavailable, report BLOCKED. If secrets are unavailable, report
   machine-endpoint execution BLOCKED. If no scheduler exists, report
   MISSING / DESIGN DECISION — not "inactive" (`CLAUDE.md` §24).
6. **Local certification is bounded.** Every Phase 1.6 certification is
   local-only. Production remains UNPROVEN across the board because no
   deployment exists.
7. **Severity is Gate 8's.** Every severity written before Gate 8 is
   PROPOSED — NOT FINAL, and must be labelled so at the point of use.
8. **The word CERTIFIED is reserved.** Use it only when the defined gates
   genuinely passed (`CLAUDE.md` §33).
9. **PARTIAL is neither PASS nor FAIL.** A partial measurement with a
   sound, bounded, accurately-classified record is PARTIAL (§8.2). It must
   never be reported, summarized or carried forward as PASS, and must not
   be downgraded to FAIL — FAIL is reserved for a record that is itself
   unsound. A PARTIAL gate has not certified.
10. **Measurement integrity and product correctness are separate
    statements.** A gate or step may soundly measure a failing product: the
    measurement's status and the product's outcome are reported on
    independent axes, and neither may be restated as the other
    (`PHASE_1.6_GATE_3R_SPEC.md` §5.2.6 and Step 2).

## 10. HISTORICAL ADDENDUM RULES

### 10.1 The rule

**Historical reports are not rewritten.** They are historical artifacts
and must remain historically attributable. A wrong number in a completed
report is evidence of what was believed at that time, and destroying it
destroys the audit trail that makes the correction meaningful.

Corrections are recorded **here**, in this specification, keyed to the
exact file and line of the erroneous statement. This file is the
Phase 1.6 correction ledger.

**No append into a historical file is authorized at this time.** PART 8
of the authorization made the C-1 addendum conditional ("only if
necessary and explicitly authorized by this prompt"), asked that C-2 be
*proposed*, and asked that C-3 be *documented*. None of the three
requires editing a historical file, and PART 13 forbids unnecessary
duplicate reports. Recording all three here satisfies all three
instructions with zero historical mutation and zero new files.

### 10.2 Contradiction C-1 — the 34-case security regression suite

**The claim.** `PHASE_1.5_SECURITY_AND_COMPLETION_REPORT.md:914` lists,
inside its §19.1 gate table, a "Security regression suite pass — 34/0" as
a gate distinct from `deno task test` (65/0) and `deno task
test:integration` (162/0).

**The measurement.** The security regression suite is
`tests/integration/privilege_isolation.test.ts`. It contains **22**
tests. `PHASE_1.5_SECURITY_AND_COMPLETION_REPORT.md:595` (§11) says so
directly — "1,900 lines, 22 tests, real PostgreSQL, no mocked
authorization … Result: 22 passed / 0 failed" — and `:28` repeats "22
tests, DB-level". Gate 3 Step 4 executed the file and measured **22
passed / 0 failed**.

**Why 34 is a phantom, proven from the same document.** Line `:919` of
that report totals the full test run as "227 passed / 0 failed". 65 + 162
= 227 exactly. A genuinely separate 34-case suite would have made the
total 261. The report's own arithmetic excludes it. Further, the file is
under `tests/integration/`, so its cases are already inside the 162 — it
was double-counted as a separate gate, and the count was also wrong.

**Propagation.** `CROSS_PHASE_AUDIT_REPORT.md:82`, `:670` and `:1339`
carry "34" forward as SUSPENDED / never executed.
`NEXT_PHASE_READINESS_REPORT.md:1088-1089` names "the security regression
suite (34 cases)" as a measurement-gate item.

**Correction of record.** The security regression suite is 22 cases, not
34. It has been executed: 22 passed / 0 failed. It is not a suite
separate from `test:integration`; it is one of that task's 11 files.

**Historical files affected and left unmodified.**
`PHASE_1.5_SECURITY_AND_COMPLETION_REPORT.md:914`;
`CROSS_PHASE_AUDIT_REPORT.md:82`, `:670`, `:1339`;
`NEXT_PHASE_READINESS_REPORT.md:1088-1089`.

**Binding rule.** Gate 3R Step 4 records 22, never 34 (PART 4).

### 10.3 Contradiction C-2 — 193 RLS policies vs 139

**The claim.** `tests/integration/privilege_isolation.test.ts:565-570`
states in a comment that migration 48 §3 keeps four `SECURITY DEFINER`
helpers executable by `anon` and `authenticated` "because 193 RLS
policies call them".

**The measurement.** 193 is the **SECURITY DEFINER routine** count, not a
policy count: 4 Category A + 145 Category B + 10 B-trigger + 10
Category C + 24 Category D = 193, matching both
`docs/security/RPC_PRIVILEGE_CLASSIFICATION.tsv` (193 data rows) and
Gate 2's live `pg_proc` census. The competing figure of **139** public
policies is documented at `PRIVILEGE_RUNTIME_VERIFICATION.md:446`; its
provenance is examined below, because it is weaker than a measurement.

**Provenance of the 139 — attribution stated precisely.** The figure's
only persisted appearance anywhere in the repository is
`PRIVILEGE_RUNTIME_VERIFICATION.md:446`. It sits in Gate 2's *"Scope
limits, stated explicitly"* section, in a sentence whose subject is Gate 1:
*"Gate 1 measured 93/93 tables with RLS enabled; whether the 139 policies
are individually correct is not asserted here."* Three consequences
follow:

1. **Gate 2 did not independently measure it.** The sentence cites the
   figure while explicitly declining to assert anything about it, in a
   section enumerating what Gate 2 did *not* assess.
2. **Gate 1 cannot be confirmed as its origin either.** Gate 1 has no
   persisted deliverable (§4, Gate 1 · Tier B), and 139 appears nowhere in
   `PHASE_1.6_FINDINGS_LOG.md`.
3. **The originating measurement is not persisted.** 139 is therefore an
   **unattested carry-forward figure**, not established evidence. It must
   not be cited as "measured by Gate 2", nor as "measured by Gate 1".

**Independent static bound.** All migrations together contain 144
`CREATE POLICY` and 130 `DROP POLICY` statements, with zero dynamically
generated policies. Live policies are therefore bounded at ≤ 144, so the
figure cannot be 193 under any interpretation.

**Correction of record.** The comment's 193 is a unit confusion —
routines reported as policies — and this holds regardless of the 139's
provenance, because the independent static bound of ≤ 144 alone refutes
193. The best currently-recorded value for the live public policy count is
139, carried forward as unattested pending Gate 3R Step 5's first-hand
measurement.

**Withdrawn internal statement.** An earlier draft of this section
described `PHASE_1.6_FINDINGS_LOG.md:250` — which records the correct
value as "UNMEASURED" — as "already inaccurate when written, because Gate 2
had measured 139". **That characterization is withdrawn.** On inspection,
Gate 2 cited rather than measured the figure (see *Provenance* above), and
the findings log's own `:256` records the live count as *"Waiting on:
Gate 3 Step 2 … BLOCKED"*. Read as a statement about *first-hand persisted
measurement*, `:250`'s "UNMEASURED" was defensible, not erroneous. The
findings log remains unmodified either way, consistent with §10.1; what
changes here is only this file's characterization of it.

**Blast radius.** The 193 appears in a code comment. No assertion depends
on it. This is F16-07, a documentation finding, PROPOSED P3.

**Historical files affected and left unmodified.**
`tests/integration/privilege_isolation.test.ts:565-570` — a source file,
and under PART 12 no test may be modified during Gate 3R;
`PHASE_1.6_FINDINGS_LOG.md:250` — now understood as defensible rather than
erroneous, per the withdrawal above, and unmodified in either case.

**Divergence with the frozen Gate 3 closure record, recorded not
resolved.** `PHASE_1.6_RUNTIME_TEST_REPORT.md:185`, `:203` and `:361`
carry the earlier attribution — "Gate 2 had measured 139". That file is
**frozen** (§5, §10.1) and is deliberately **not** edited to match this
section. The divergence is therefore recorded here, in the correction
ledger, which is where §10.1 requires corrections to live. Anyone reading
the closure record's 139 attribution should read this section alongside
it. Reconciling the frozen text, if ever desired, is Gate 8's call and
requires separate authorization.

**Binding rule.** Gate 3R Step 5 carries forward 139 (PART 4) **as an
unattested figure**, and produces the first persisted first-hand count. A
divergence between the two is a measurement, not drift, and not a FAIL
(`PHASE_1.6_GATE_3R_SPEC.md` Step 5 *Failure criteria*).

### 10.4 Contradiction C-3 — two incompatible gate schemes

**The two schemes.**

- **Measurement-first Gate 0–8.** The scheme actually executed. Before
  this file it was never enumerated in any repository artifact — it
  existed only as gate *references* scattered across deliverables
  (`FINDING_ID_RECONCILIATION.md:3`, `PRIVILEGE_RUNTIME_VERIFICATION.md:7`,
  `:105`, `:415`, `:445`, `:988`, `:1050`, `PHASE_1.6_FINDINGS_LOG.md:9`,
  `:30`, `:83`, `:84`, `:187`, `:229`, `:256`). §3 and §4 of this file
  are its first enumeration.
- **Remediation-first Gate 1–7.** `NEXT_PHASE_READINESS_REPORT.md`
  §15.2, `:1060-1154`: Gate 1 Restore the runtime · Gate 2 Restore crash
  recovery (P0-01) · Gate 3 Restore financial truth (P0-04, P1-05,
  P1-10, P2-03, P2-04) at `:1079` · Gate 4 Measure what is unproven ·
  Gate 5 Authorization decision · Gate 6 Product decisions · Gate 7
  Governance repair.

**They collide on every shared number.** Executed Gate 2 was a privilege
census; remediation-first Gate 2 was crash-recovery repair. Executed
Gate 3 was runtime/integration verification; remediation-first Gate 3
was financial remediation. The schemes are not two views of one plan.

**Correction of record.** **The remediation-first numbering in
`NEXT_PHASE_READINESS_REPORT.md` §15.2 was not the executed Gate 0–8
specification.** It is a proposal that was never adopted as the gate
scheme. It remains a valid record of proposed remediation sequencing and
its content is not repudiated — only its numbering is disclaimed as an
authority for interpreting executed gates.

**`NEXT_PHASE_READINESS_REPORT.md` is not rewritten** (PART 8).

**Binding rules.**

1. When a repository artifact says "Gate N" with no scheme qualifier and
   was written during Phase 1.6 execution, it means measurement-first
   Gate N as defined in §4.
2. A remediation-first gate number may never be used to infer a
   measurement-first gate's scope. This is the specific prohibition that
   keeps Gate 6 UNDEFINED (§4, Gate 6).
3. Future gate references cite the scheme explicitly.

### 10.5 Correction-ledger index

| ID | Subject | Wrong value | Measured value | Class |
|---|---|---|---|---|
| C-1 | security regression suite size | 34 cases, separate gate | 22 cases, inside `test:integration`, 22/0 executed | documentation |
| C-2 | RLS policy count in test comment | 193 policies | routines = 193; live policies ≤ 144 static bound, 139 carried forward unattested pending Step 5 | documentation (F16-07) |
| C-3 | gate numbering | remediation-first 1–7 read as executed | measurement-first 0–8 executed | governance |

## 11. REQUIREMENT → EVIDENCE → TEST MAPPING

### 11.1 Command authority

`deno.json` is the command authority (`CLAUDE.md` §2). It defines exactly
10 tasks. There is no `package.json`, `Makefile` or `justfile`.

| Task | Command | Safety |
|---|---|---|
| `validate:migrations` | `deno run --allow-read scripts/validate_migrations.ts` | read-only |
| `fmt:check` | `deno fmt --check` | read-only |
| `lint` | `deno lint` | read-only |
| `check` | `deno check scripts/*.ts tests/unit/*.ts tests/integration/*.ts tests/utils/*.ts supabase/functions/*/index.ts` | read-only |
| `test` | `deno test --allow-env tests/unit/` | read-only vs repo |
| `test:integration` | `deno test --allow-net --allow-env --allow-run tests/integration/` | touches local DB state |
| `gen:types:check` | `deno run --allow-run=supabase --allow-read scripts/gen_types.ts --check` | read-only |
| `fmt` | `deno fmt` | **REWRITES FILES** |
| `gen:types` | `deno run --allow-run=supabase --allow-read --allow-write scripts/gen_types.ts` | **REWRITES `database.generated.ts`** |
| `db:reset` | `supabase db reset` | **DESTRUCTIVE** |

The last three require explicit task authorization. `db:reset` is not
authorized for Gate 3R.

### 11.2 The integration suite

`test:integration` resolves to `tests/integration/`, which contains
exactly **11** files:

| # | File | Edge Runtime dependency |
|---|---|---|
| 1 | `local_stack.test.ts` | not established |
| 2 | `multi_role_auth.test.ts` | not established |
| 3 | `privilege_isolation.test.ts` | **none** — statically confirmed to invoke no Edge Function |
| 4 | `queue_operations.test.ts` | not established |
| 5 | `queue_runtime.test.ts` | not established |
| 6 | `refund_sync.test.ts` | not established |
| 7 | `usage_retention.test.ts` | not established |
| 8 | `whatsapp_conversational.test.ts` | not established |
| 9 | `whatsapp_lifecycle.test.ts` | **yes** — `:392` |
| 10 | `enterprise_command_center.test.ts` | **yes** — `:234` |
| 11 | `doctor_operations.test.ts` | **yes** — `:376` |

The Edge-dependency column is a Gate 3 static finding: exactly three
files invoke Edge Functions. "Not established" means no invocation was
found for that file and no exhaustive per-file audit was performed —
it is not a proof of independence.

`CROSS_PHASE_REQUIREMENTS_MATRIX.md:120` records **162 cases counted
statically** across those 11 files. That is a declaration count, not a
passed count (§8.4).

**Execution state.** 1 of 11 files executed (`privilege_isolation.test.ts`,
22/22 passed, Gate 3 Step 4). 10 of 11 files never executed.
`NEXT_PHASE_READINESS_REPORT.md:1143` — "The integration suite was never
executed" — remains accurate for those 10.

### 11.3 UNPROVEN requirements and their local executability

From `CROSS_PHASE_REQUIREMENTS_MATRIX.md`. This table is the input to
Gate 3R Step 6; the per-requirement scoping rationale lives in
`PHASE_1.6_GATE_3R_SPEC.md`.

**The matrix carries twelve UNPROVEN rows, and all twelve are listed
below.** Twelve is the complete universe, corroborated by the matrix's own
per-set tallies, which sum independently to twelve: F 4 (`:130`), Z 1
(`:161`), R 1 (`:217`), V 2 (`:337`), N1 1 (`:397`), N5 3 (`:531`).

| Row | Requirement | Locally executable? |
|---|---|---|
| F-01 `:110` | Local Supabase stack starts | YES — satisfied locally, with the F16-01 caveat |
| F-02 `:111` | All migrations apply cleanly to a fresh database | **NO** — requires `supabase db reset`, destructive, not authorized |
| F-03 `:112` | `supabase functions serve` starts without import errors | PARTIAL — `deno task check` is a proxy only; the literal command differs from the containerized runtime |
| F-11 `:120` | Integration harness exists and runs | YES — this is Gate 3R Step 2 |
| Z-03 `:152` | API contracts frozen (request/response shapes per endpoint) | **NO** — the missing element is a committed contract artifact, not a measurement; running the suite does not freeze a contract |
| R-08 `:215` | Refund concurrent with settlement produces a consistent result | **NO** — no committed concurrency test exists; authoring one is remediation |
| V-03 `:330` | Security audit over `pg_policies` | PARTIAL — a count is not a per-policy audit; full scope is Gate 7 |
| V-07 `:334` | DR test: Meta API outage → retry + DLQ | **NO** — no committed outage-simulation test exists; authoring one is remediation |
| N1-10 `:395` | Endpoint reachable by Meta in production | **NO** — production reachability is unprovable locally, permanently |
| N5-02 `:519` | Category B (145) not executable by `anon`/`authenticated` | ALREADY MEASURED by Gate 2 |
| N5-03 `:520` | Category C (10) restricted | ALREADY MEASURED by Gate 2 |
| N5-04 `:521` | Category D (24) restricted | ALREADY MEASURED by Gate 2 |

**On Z-03, R-08 and V-07.** These three are the rows that
`CROSS_PHASE_GAP_REGISTER.md:589-591`'s sentence — "Nine of the twelve
UNPROVEN matrix rows are unverified claims, not defects" — does *not* cover.
That sentence names the nine enumerated at `:584`; it says "nine of the
twelve", so it presupposes twelve rather than defining the universe as nine.
The three are not locally closable for a reason distinct from the nine's:
each needs an artifact or test that does not exist in the repository, and
authoring one is remediation, not verification (§1). Gate 3R therefore
dispositions them as excluded, creates nothing to close them, and records no
finding for their absence — a missing test is an absent measurement, not a
product defect.

**On N5-02/03/04.** Gate 2's `pg_proc.proacl` census plus runtime SQLSTATE
`42501` confirmation already establishes these at catalog and runtime
level. Their UNPROVEN status in the matrix is a **documentation lag**, not
an open measurement — the matrix predates Gate 2 and has not been updated
because updating it is a Gate 8 register action. Gate 3R must not
re-measure them merely because a stale row says UNPROVEN, and must not
silently flip the rows either.

**On F-02.** `CROSS_PHASE_GAP_REGISTER.md:580-587` §6.3 lists "Run
`supabase db reset` against 01→49 on a fresh database" as a measurement
that would resolve F-02. It is excluded from Gate 3R: PART 6 requires
preserving existing database state, PART 12 forbids `db:reset` absent
separate authorization, and `CLAUDE.md` §2/§22 classify it destructive.
F-02 therefore remains UNPROVEN after Gate 3R by design, not by omission.

**Correction record.** This subsection previously listed **nine** rows and
presented them as the whole UNPROVEN universe, omitting Z-03, R-08 and V-07.
It was corrected on 2026-08-23 under governance correction **R-1**, recorded
in full in `PHASE_1.6_GATE_3R_SPEC.md` §8 (Amendment 1). The omission is
recorded here as a correction rather than silently overwritten (§10.1,
§12.2 rule 5). `CROSS_PHASE_REQUIREMENTS_MATRIX.md` was **not** modified —
it already carried all twelve rows correctly, and it is the source artifact
being reconciled.

### 11.4 Baseline command results

Last full run, to be re-confirmed rather than assumed:

- `validate:migrations` — passes, 0 errors, 4 `[duplicate-objects]`
  warnings. The warnings are pre-existing and are **not** new defects; do
  not re-report them as findings.
- `fmt:check` — fails on exactly 8 root markdown files, all Phase 1.6
  audit/reconciliation documents, zero source files. Cosmetic. Do not fix
  unasked (`CLAUDE.md` §2, §17). New governance files created under this
  authorization may add to that count; that is expected and is not a
  finding.

### 11.5 Preserved observations — NOT findings

**OBS-1.** Four zero-policy tables retain broad grants and rely on RLS as
the current barrier. Provenance of their RLS state, found by multiline
matching: `whatsapp_delivery_logs` —
`04_whatsapp_messaging_engine.sql:740-741` ENABLE, `:755-756` FORCE;
`settlement_items` — `07_settlement_engine.sql:584-585` ENABLE,
`:596-597` FORCE; `rate_limit_rules` —
`09_abuse_protection_&_rate_limiting.sql:630-631` / `:651-652`;
`blocked_devices` — same file `:642-643` / `:663-664`. A fifth table,
`consultation_notes` (`46_doctor_clinical_operations.sql:174` ENABLE), is
distinguished from the other four: it carries explicit REVOKEs at `:984`
(PUBLIC), `:985` (anon), `:986` (authenticated), `:987` (service_role).

**OBS-2.** `blocked_devices` and `rate_limit_rules` appear unreferenced.
An index exists at `09_abuse_protection_&_rate_limiting.sql:111`.

**Status of both.** OBSERVATION. Not a finding. Not a defect. Not a
vulnerability. Collected as input for Gate 7.

**Prohibition.** Do not convert either into a finding without evidence of
an actual defect. Do not create F16-08 from structural suspicion (PART 11).
A broad grant on an RLS-enabled table is not by itself a defect —
zero-applicable-policy RLS is default-deny for non-bypass roles, so the
grant is not the operative control. Establishing whether relying on RLS
alone is *architecturally intended* is Gate 7's question.

## 12. RULES PREVENTING UNDOCUMENTED GATE STEPS

### 12.1 GOV-01 — a gate was executed against a specification that was never persisted

**Finding statement.** Phase 1.6 Gate 3 was executed against a nine-step
specification (Steps 0–8) that was never written to any repository file.
The specification existed only in conversation context. That context was
compacted, and the objectives of Steps 3, 5, 6 and 8 were destroyed.

**Evidence.**

- Searching every root markdown file for step references yields matches
  only for Steps 0, 1, 2, 4 and 7, all inside
  `PHASE_1.6_FINDINGS_LOG.md` (`:9`, `:84`, `:187`, `:229`, `:256`).
  Steps 3, 5, 6 and 8 are never named anywhere.
- `PHASE_1.6_FINDINGS_LOG.md:13-14` states the Gate 3 report is "still
  unwritten pending Steps 1-8", proving a nine-step list existed and was
  being tracked at that time.
- The same file at `:1-11` self-describes as a *durability snapshot*
  written because six of seven findings "had no written record anywhere in
  this repository and survived only in conversation context that has
  already been compacted once."

**Root cause.** The durability mechanism was applied to the gate's
*findings* and not to the gate's *specification*. Findings were
recognized as at risk; the specification that generated them was not.

**Blast radius.**

- Gate 3 cannot certify (§9 rule 2) and is frozen PARTIALLY COMPLETE —
  NOT CERTIFIED.
- Four step objectives are permanently unrecoverable.
- Gate 1 is a milder instance: executed, no persisted step list, and so
  unable to prove its own completeness — although no Gate 1 step is known
  to be missing.
- Gates 0 and 2 are unaffected: each produced a persisted deliverable
  that states its own purpose.

**Class.** Governance / process defect. **Not a product defect.** No
SETURA source file, migration, test, privilege or runtime behaviour is
implicated. No product certification changes because of GOV-01 — what
changes is the confidence that can be placed in Gate 3's completeness.

**Proposed severity.** PROPOSED — NOT FINAL. Final assignment and formal
register allocation are Gate 8 actions, per §7.3 and PART 10.

**Remediation status.** Structurally addressed by §12.2–§12.4 of this
file and by the existence of `PHASE_1.6_GATE_3R_SPEC.md`. The historical
loss itself is not remediable.

### 12.2 The persistence rule

**No Phase 1.6 gate step may exist only in conversation.**

Concretely, for every gate from Gate 3R onward:

1. The gate's full step list is written to a repository file **before any
   measurement for that gate begins.**
2. Each step is specified against the eight-field template in §12.3,
   completely. A step with an empty field is an incomplete step.
3. **A step whose specification is incomplete must not be executed**
   (PART 5).
4. The specification file is committed to disk, not held in a scratch
   buffer, not held in a tool result, not held in a plan.
5. If a gate's scope changes mid-execution, the specification file is
   updated before the changed work proceeds — and the change is recorded
   as a change, not as though it had always been the plan.

### 12.3 The step-specification template

Every step must define all eight fields:

| Field | Requirement |
|---|---|
| **Objective** | What the step establishes, in evidence terms — which verification level it can reach for which claim |
| **Inputs** | The exact files, prior measurements and citations the step consumes |
| **Authorized commands/actions** | Enumerated. Anything not listed is not authorized |
| **Prohibited actions** | Explicit, including the near-misses most likely to be attempted |
| **Expected evidence** | The specific artifacts the step must capture — codes, counts, container fields, plan nodes |
| **Success criteria** | What constitutes PASS |
| **Failure criteria** | What constitutes FAIL, and what constitutes BLOCKED instead of FAIL |
| **Deliverable location** | The exact file and section the result is written to |

### 12.4 Anti-inference rules

When a step definition is missing, the following are **not** valid
sources for reconstructing it, and each has been explicitly rejected:

- the step's number, or its position relative to defined neighbours;
- an identically-numbered gate or step in a different scheme — in
  particular the remediation-first scheme in
  `NEXT_PHASE_READINESS_REPORT.md` §15.2 (§10.4);
- a forward-pointer in an unrelated deliverable;
- the findings the step is presumed to have produced;
- a plausible narrative of what the gate "must have" covered;
- any recollection not backed by a persisted artifact.

**A missing step definition is recorded as UNRECOVERABLE and left
unrecovered.** UNRECOVERABLE is neither PASS nor FAIL, because both would
be claims about work for which no evidence exists.

### 12.5 Successor-gate rule

When a gate is frozen with unrecoverable steps, its remaining work is
**not** resumed inside that gate. A successor gate is created with:

- a new name and a new step numbering, explicitly disclaimed as
  unrelated to the frozen gate's numbering;
- an explicit statement that it is not a reconstruction;
- its own persisted specification, written in full before execution;
- explicit reuse-by-citation of the frozen gate's completed evidence, so
  that valid measurements are not discarded.

Gate 3R is the instance. Its steps are numbered 1–7 and correspond to
nothing in historical Gate 3.

## 13. COMPLETION REPORT REQUIREMENTS

### 13.1 Required structure

Every Phase 1.6 gate report must contain, in this order:

1. **Header block** — gate name, status in the §8.2 vocabulary,
   authorization citation, and an explicit statement of what was and was
   not modified to produce the report.
2. **Step-by-step record** — one section per step, each stating: the
   step's specified objective (quoted from the gate spec), what was
   executed, the exact evidence captured, and the resulting classification.
3. **Evidence appendix or inline citations** — exact commands, exact
   output, exact codes and counts. A number without a citation is not
   evidence.
4. **Findings** — each with class, status, PROPOSED severity, and what it
   is waiting on.
5. **Explicitly not proven** — a list of everything the gate could have
   been mistaken for proving, and did not prove.
6. **Environment actions** — per `CLAUDE.md` §32: what was done, why,
   whether persistent repository state changed, whether it is
   reproducible, whether it affects certification.
7. **Certification statement** — PASS / FAIL / BLOCKED / UNPROVEN, with
   the §9 rule that justifies it.

### 13.2 Prohibitions on reports

- Do not report a step as complete without a persisted specification for
  it.
- Do not aggregate a partial result into a total. If 8 of 11 files ran,
  the report says 8 of 11 — it does not report the suite as run.
- Do not report a declared count as a passed count.
- Do not report an environment failure as a product failure, or the
  reverse.
- Do not restate BLOCKED as FAIL, or FAIL as BLOCKED.
- Do not assign a final severity (Gate 8's authority).
- Do not modify a historical report to agree with a new measurement
  (§10.1).

### 13.3 Report inventory

| File | Gate | Status |
|---|---|---|
| `FINDING_ID_RECONCILIATION.md` | 0 | complete, persisted |
| `PRIVILEGE_RUNTIME_VERIFICATION.md` | 2 | complete, persisted |
| `PHASE_1.6_FINDINGS_LOG.md` | 3 (Step 0) | complete, persisted — durability snapshot of F16-01…F16-07 |
| `PHASE_1.6_RUNTIME_TEST_REPORT.md` | 3 | closure record — frozen PARTIALLY COMPLETE — NOT CERTIFIED |
| `PHASE_1.6_SPEC.md` | phase-level | this file |
| `PHASE_1.6_GATE_3R_SPEC.md` | 3R | specification persisted; execution NOT STARTED |
| Gate 3R report | 3R | not created — Gate 3R has not executed |

Gate 1 has no report. That is a consequence of GOV-01, recorded here so
the absence is attributable rather than merely noticed later.

## 14. CURRENT KNOWN BLOCKERS

Blockers are stated as of 2026-08-23. Each must be re-verified rather than
assumed at the time it becomes relevant (`CLAUDE.md` §17).

### 14.1 Repository is not a Git repository

No `.git` directory exists, confirmed by two independent methods
including a control probe. Therefore: no tracked/untracked status may be
claimed for any file, no commit history may be cited, and CI reachability
is **provably unmeasurable from this working tree** — not merely unknown.

**Effect on Phase 1.6.** No gate may cite Git state as evidence. New
governance files cannot be described as committed in the Git sense; they
are persisted to disk.

### 14.2 F16-01 — Edge Runtime has `RestartPolicy=no`

`supabase_edge_runtime_setura` carries `RestartPolicy=no` while every
other Supabase container carries `unless-stopped` (verified individually
on `supabase_db_setura`, `supabase_kong_setura`, `supabase_rest_setura`,
`supabase_auth_setura`, `supabase_vector_setura`). Any Edge Runtime exit
is therefore permanent while every other service self-heals — observed
when the Docker daemon cycled during Gate 3.

**Class.** Environment / tooling. **Not a SETURA product defect.**

**Effect on Phase 1.6.** Blocks the three Edge-dependent integration
files whenever the container is down. Failures in those three while Edge
Runtime is down are attributable to F16-01 and **must not be recorded as
product defects**. `privilege_isolation.test.ts` invokes no Edge
Function, so its results can never be attributed to F16-01.

**Not authorized.** Changing the restart policy (PART 12). Starting the
container is permitted; that does not fix F16-01 and must not be
reported as fixing it.

### 14.3 F16-03 — `supabase_vector_setura` crash-loops

`ExitCode=0`, `RestartCount=15`, `Health=unhealthy`, still restarting
during Gate 3. Root cause external to SETURA: Vector cannot reach the
Docker socket on this Windows host (`code: 101, kind:
NetworkUnreachable`). Vector only ships logs to Logflare/analytics.

**Effect on Phase 1.6.** None. No gate depends on it. **Not a SETURA
defect.** Its unhealthy state must not be read as a stack-wide failure.

### 14.4 F16-02 — no local secrets exist

Only `.env.example` exists; no `.env`, no `supabase/functions/.env*`. The
Edge Runtime container holds no SETURA application secrets — none of
`CRON_SECRET`, `WORKER_SECRET`, `RAZORPAY_KEY_SECRET`, `META_APP_SECRET`,
`ENABLE_WORKER_TRIGGER`, `WORKER_LEASE_SECS`,
`RAZORPAY_WEBHOOK_SECRET`.

**Measured effect on the test suite.** A search of the entire `tests/`
tree for those seven variables returns **zero matches**. The one test
touching the worker-secret boundary
(`tests/integration/whatsapp_lifecycle.test.ts:389-407`) asserts HTTP 403
for the **absence** of the header, and therefore requires the secret to
stay missing. `tests/integration/privilege_isolation.test.ts:67-84`
derives all configuration from `supabase status -o json` and reads no
environment variable.

**Therefore.** No currently-known integration outcome is changed by
providing these secrets. F16-02 is DEFERRED to Gate 4.

**Binding procedure if Gate 3R execution contradicts this.** If a
specific test proves to require a specific variable, **stop before
creating anything** and report: which test, which variable, why it is
required, and whether the test can be meaningfully executed without it.
Then wait for authorization (PART 7). Do not create a real `.env`. Do not
invent production secrets. Do not proceed on the assumption that a
dummy value is harmless.

### 14.5 Machine-endpoint and production execution

No deployment exists. Every production-scoped requirement is permanently
UNPROVEN from this working tree — N1-10 (Meta reachability in production)
is the canonical example. Production privilege state, production
scheduling and production secret provisioning are all outside Phase 1.6.

### 14.6 Destructive operations not authorized

`supabase db reset` / `deno task db:reset` is not authorized. This is
what keeps F-02 UNPROVEN (§11.3). `deno task fmt` and `deno task
gen:types` rewrite files and are not authorized casually (`CLAUDE.md`
§2).

### 14.7 Product findings that constrain interpretation but are not repaired here

| ID | What | Phase 1.6 treatment |
|---|---|---|
| P0-01 | `claim_jobs_v2` does not populate `lease_expires_at`; crash recovery cannot reclaim v2-claimed jobs | measure only; do not fix |
| P0-02 | no scheduler exists — `pg_cron` available but `installed_version` NULL, zero `pg_net` scheduling calls, no external scheduler config | report MISSING / DESIGN DECISION (NPD-05); do not choose an architecture |
| P0-03 | `ENABLE_WORKER_TRIGGER=false` in `.env.example` deploys a non-processing system by default | measure only |
| P0-04 | `booking_fee_inr` has no runtime writer; only a one-time backfill (migration 28) | measure only |
| F16-04 | migration 48's fail-closed default-privilege guarantee does not hold — PUBLIC never revoked, `supabase_admin` grantor rows skipped; migration 49's four functions are safe only because `CREATE OR REPLACE` preserved the prior ACL | do not change privileges; the explicit-REVOKE mandate in `CLAUDE.md` §23 governs future work |
| F16-05 | `privilege_isolation.test.ts` can accept a JWT-failure 401 as privilege-denial proof on the authenticated half | test-quality gap; the boundary itself is independently proven by Gate 2, so this does not reopen P1-11 |
| F16-06 | Category B denial coverage is 7 of 145 (~5%); overall locked-routine probe coverage 40 of 179 (22.3%) — a count of probe **sites**, not runtime results | test-coverage gap; do not modify the test |
| F16-07 | the "193 RLS policies" comment (§10.3) | documentation; 193 is the routine count, live policy count carried forward as 139 unattested pending Gate 3R Step 5 |

**Worker runtime baseline.** 157 pending jobs, zero claimed, zero worker
IDs, zero lease timestamps, zero worker-registry rows, zero heartbeat
rows, zero worker-lease rows, zero dead-letter rows. Enqueueing is proven;
execution is not. Do not treat one as the other.

All severities above are **PROPOSED — NOT FINAL** (Gate 8).

## 15. EXPLICIT PROHIBITION ON CONVERSATION-ONLY REQUIREMENTS

This section is the direct consequence of GOV-01 and is the most binding
rule in this file.

### 15.1 The prohibition

**A requirement, gate step, scope decision, authorization, measurement
result, finding, severity, or exclusion that exists only in conversation
does not exist.**

It may not be executed against, cited as evidence, relied on as
authorization, or reported as complete. Conversation context is not a
repository artifact: it is mutable, non-addressable, and provably
destructible — this project has already lost four step definitions to it.

### 15.2 What follows for execution

- **Before executing:** the step's specification must be readable from a
  file on disk. If it cannot be read from disk, it is not authorized,
  regardless of how clearly it was stated in conversation.
- **While executing:** evidence is written down as it is obtained, not
  retained for a later write-up. The Gate 3 findings survived only
  because a mid-gate durability snapshot was authorized; that was luck
  in the form of an exception, and must not be relied on again.
- **After executing:** the result is written to the deliverable location
  named in the step specification.

### 15.3 What follows for citation

A citation must resolve to a file, and where a specific claim is
involved, to a line. "Established earlier", "as previously determined",
and "per the prior analysis" are not citations. If a fact was established
in conversation and never written down, then either write it down with its
evidence or treat it as unproven.

### 15.4 What follows for authorization

Authorization is scoped by the persisted specification, not by tone,
momentum, or adjacency. Specifically:

- Authorization for one gate does not extend to the next.
- Authorization to *measure* something never implies authorization to
  *fix* it.
- Authorization to start a container does not imply authorization to
  reconfigure it.
- Authorization to run a test does not imply authorization to modify it.
- An action's being obviously useful is not authorization.

### 15.5 Self-application

This file is itself subject to §15. Every factual claim it makes about
the repository is cited to a file and, where a specific value is at
stake, to a line. The three corrections in §10 are recorded with the
exact locations of the statements they correct. Where evidence does not
exist — Gate 6's scope, the four unrecoverable Gate 3 steps, the correct
value that should replace 193 in the test comment — this file says so
rather than filling the gap.

---

## Document control

| Property | Value |
|---|---|
| Authority | Project-lead Option C authorization, 2026-08-23, PART 9 |
| Supersedes | nothing — first enumeration of the measurement-first Gate 0–8 scheme |
| Superseded by | nothing |
| Outranked by | `CLAUDE.md` |
| Canonical for | Phase 1.6 gate definitions, gate status, evidence vocabulary, certification rules, correction ledger, persistence rules |
| Not canonical for | finding IDs (`CROSS_PHASE_GAP_REGISTER.md`), finding-ID crosswalk (`FINDING_ID_RECONCILIATION.md`), privilege measurements (`PRIVILEGE_RUNTIME_VERIFICATION.md`), F16 findings (`PHASE_1.6_FINDINGS_LOG.md`), commands (`deno.json`) |
| Files modified to produce it | none |
| Product state changed | none |
