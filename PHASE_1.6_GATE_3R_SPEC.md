# PHASE 1.6 — GATE 3R SPECIFICATION

## Gate 3R — Runtime & Integration Verification Successor

**Document status.** ACTIVE SPECIFICATION. Persisted before any Gate 3R
measurement.

**Created.** 2026-08-23, under the project-lead decision authorizing
Option C of the Gate 3 closure decision analysis (PART 2).

> **Gate 3R is a newly authorized successor verification gate. It is NOT a
> reconstruction of historical Gate 3 and does not claim to recover its
> missing requirements.**

**Execution state at the time of writing: NOT STARTED.** No Gate 3R step
has been executed. No measurement in this file has been taken. Every
value quoted here is either a citation of prior gate evidence or a
statement of what a step is required to capture.

**Current execution state (superseding the paragraph above, which is
retained as the record of this file's state when persisted):** project-lead
execution authorization was granted 2026-08-23 (§7, §8 Amendment 2), and
Gate 3R execution began at Step 1 on 2026-08-23. Measurements taken during
execution are recorded in `PHASE_1.6_GATE_3R_REPORT.md`, not in this
specification.

**Governing documents.** `CLAUDE.md` (repository operating contract,
outranks this file); `PHASE_1.6_SPEC.md` (phase governance — gate
inventory, evidence vocabulary, certification rules, correction ledger,
persistence rules); `deno.json` (command authority);
`CROSS_PHASE_GAP_REGISTER.md` (canonical finding source).

**Authority for this file.** It is a documentation write. No source file,
migration, test, privilege, RLS policy, configuration, database row,
container or prior deliverable was modified to produce it.

---

## 1. WHY GATE 3R EXISTS

Historical Gate 3 is frozen at **PARTIALLY COMPLETE — NOT CERTIFIED**.
Steps 0, 1, 2, 4 and 7 completed; the objectives of Steps 3, 5, 6 and 8
could not be recovered from persisted project artifacts and are recorded
as UNRECOVERABLE (`PHASE_1.6_SPEC.md` §5,
`PHASE_1.6_RUNTIME_TEST_REPORT.md`).

Frozen means closed. Remaining runtime and integration verification
therefore happens in a successor gate with its own persisted
specification — the successor-gate rule, `PHASE_1.6_SPEC.md` §12.5.

### 1.1 What Gate 3R inherits, and what it does not

**Inherits by citation, without re-measurement:** Gate 0's canonical
finding-ID scheme; Gate 2's full privilege census; the 139 public-policy
count as an **unattested carry-forward figure** (§Step 5 *Inputs* — cited
at Gate 2 but not measured there); Gate 3's completed-step evidence,
including the `privilege_isolation.test.ts` result of 22 passed / 0 failed;
and F16-01…F16-07 as recorded in `PHASE_1.6_FINDINGS_LOG.md`.

**Does not inherit:** any objective, scope, step boundary, success
criterion or exclusion from historical Gate 3 Steps 3, 5, 6 or 8. Those
are unrecoverable and are not reconstructed here.

### 1.2 Numbering disclaimer

Gate 3R's steps are numbered **1–7**. Historical Gate 3's steps were
numbered **0–8**. **No correspondence exists between the two numberings
and none may be asserted.** Gate 3R Step 3 is not historical Gate 3
Step 3. Gate 3R Step 5 is not historical Gate 3 Step 5. The seven steps
below derive solely from PART 4 of the Option C authorization.

## 2. OBJECTIVE

> Establish reproducible local runtime and integration evidence for the
> currently unproven SETURA backend behaviours that are executable
> against the committed local stack, without claiming production
> verification.

Four clauses, each load-bearing:

- **reproducible** — every result must carry the exact command and the
  exact captured output, so a later session can re-run it without
  re-deriving the method.
- **local runtime and integration evidence** — the target verification
  levels are RUNTIME VERIFIED and INTEGRATION VERIFIED
  (`PHASE_1.6_SPEC.md` §8.1). Not STATICALLY VERIFIED, which the project
  already has in quantity.
- **executable against the committed local stack** — a requirement that
  cannot be executed locally is out of scope and is recorded as out of
  scope, not attempted and not silently dropped.
- **without claiming production verification** — no Gate 3R result may be
  restated as production evidence. No deployment exists.

## 3. SCOPE

### 3.1 In scope

- Measuring local environment and runtime readiness, per-service.
- Executing the complete committed integration suite via `deno.json`.
- Executing the committed unit suite as a control.
- Attributing every failure to one of five classes, with evidence.
- Recording exact codes (`42501`, `PGRST301`, `PGRST202`, `0A000`),
  exact counts, exact container fields, exact plan nodes.
- Classifying F16-01, F16-02, F16-03 and the production limitations.
- Scoping — and, where genuinely locally executable, closing — the
  UNPROVEN cross-phase requirements.

### 3.2 Out of scope

Restating `PHASE_1.6_SPEC.md` §2.2 with the Gate-3R-specific additions:

- **All product remediation.** Explicitly: do not fix P0-01, do not
  implement a scheduler (P0-02 / NPD-05), do not change P0-03's
  `ENABLE_WORKER_TRIGGER` default, do not add a `booking_fee_inr` writer
  (P0-04), do not change F16-04 privileges, do not change the F16-01
  Docker restart policy, do not change RLS, do not change queue or worker
  architecture (PART 12).
- **Modifying any test.** Not to fix a failure, not to strengthen an
  assertion, not to correct the F16-07 comment, not to widen F16-06
  coverage. F16-05 and F16-06 are recorded, not repaired.
- **`supabase db reset`** and every other destructive database operation.
- **Creating secrets**, real or dummy, without separate authorization
  (§4.4).
- **Deploying anything.** No production access.
- **`deno task fmt`, `deno task gen:types`** — they rewrite files.
- **Assigning final severity**, or allocating IDs into
  `CROSS_PHASE_GAP_REGISTER.md`. Gate 8's authority.
- **Creating F16-08 from structural suspicion.** OBS-1 and OBS-2 stay
  observations absent evidence of an actual defect (PART 11,
  `PHASE_1.6_SPEC.md` §11.5).
- **Gate 7's questions.** Architectural intent of RLS coverage, and the
  per-policy `pg_policies` audit, belong to Gate 7.
- **Gate 4's work.** Local secret provisioning.
- **Gate 8's work.** Register updates, including the stale matrix rows
  Step 6 identifies.

### 3.3 Boundary rule carried forward

Restarting a stopped container restores the measuring instrument and is
in scope. Changing that container's configuration alters the thing being
measured and is out of scope. **Starting `supabase_edge_runtime_setura`
does not fix F16-01 and must never be reported as fixing it.**

## 4. GATE-WIDE RULES

These bind every step. A step's own prohibitions add to these; they never
subtract.

### 4.1 Evidence rules

1. **HTTP status alone is never privilege evidence.** `42501` =
   PostgreSQL privilege denial; `PGRST301` = JWT decoding failure. Both
   surface as 401. The `code` field is the discriminator
   (`PHASE_1.6_SPEC.md` §8.4, `CLAUDE.md` §24).
2. **Declared ≠ passed.** A count read from source is a count of
   declarations.
3. **Partial ≠ whole.** If 8 of 11 files execute, the record says 8 of 11.
4. **Enqueued ≠ executed.** A `job_queue` row proves enqueueing only.
5. **Exit 0 ≠ service up.** Per-service state must be measured.
6. **Empty result ≠ RLS filtering.** Use `EXPLAIN` under `SET ROLE`; zero
   applicable policies compile to `Result … One-Time Filter: false`.
7. **Local ≠ production.** Permanently.
8. **A number without a citation is not evidence.**

### 4.2 Failure-classification rule

Every failure must be classified as exactly one of: **implementation
failure · environment failure · fixture failure · test assertion weakness
· pre-existing issue**, with the evidence that supports the
classification.

**Never silently classify a failure as a test problem** (PART 6). The
default classification of an unexplained failure is *unclassified,
pending investigation* — not "test issue".

Where a failure is attributable to a known condition, attribute it and
say so: a failure in one of the three Edge-dependent files while Edge
Runtime is down is attributable to F16-01 and **must not be recorded as a
product defect** (`PHASE_1.6_FINDINGS_LOG.md:71-77`).

### 4.3 Stop conditions

Halt the gate and report, rather than proceeding, if any of these arise:

1. A test failure appears to require source modification to resolve.
2. A local-only dummy secret appears genuinely required (→ §4.4).
3. A destructive database operation appears necessary.
4. A scheduler architecture decision becomes necessary (NPD-05 — project
   lead's decision, `CLAUDE.md` §15, §30).
5. Production credentials or production access appear necessary.
6. Evidence materially contradicts an existing Phase 1.6 report — except
   where a step already defines the handling for that specific
   divergence, in which case follow the step (Step 1 success criterion 4
   for the F16-01 `RestartPolicy` comparison; Step 5 failure criteria for
   a live policy count differing from the carried-forward figure; Step 5's
   **Branch B** for a per-table applicable-policy count measured non-zero
   against the carried-forward zero-policy premise — Branch B is a defined
   outcome that satisfies the step, and it does **not** halt the gate).
7. A step's specification proves incomplete once execution starts —
   update the specification first (`PHASE_1.6_SPEC.md` §12.2 rule 5).

Do not resolve any of these silently.

### 4.4 Secret-handling procedure

Do NOT create a real `.env`. Do NOT invent production secrets.

If a local-only dummy secret is genuinely required for a specific test,
**stop before creating it** and report: which test requires it, which
variable, why it is required, and whether the test can be meaningfully
executed without it. Then wait for authorization (PART 7).

Current evidence says this will not arise: a search of the whole `tests/`
tree for the seven relevant variables returns zero matches, and the one
test at the worker-secret boundary
(`whatsapp_lifecycle.test.ts:389-407`) asserts 403 for the header's
**absence**, so it requires the secret to stay missing
(`PHASE_1.6_SPEC.md` §14.4). If execution contradicts that, the procedure
above applies — the contradiction does not authorize the shortcut.

### 4.5 Step ordering and dependencies

Steps 1 → 2 are strictly ordered: Step 1 is the precondition for Step 2
(PART 6 requires confirming Edge Runtime reachability and local stack
state before running the suite).

Steps 3, 4 and 5 consume Step 2's execution rather than re-running the
suite. This is deliberate: `deno task test:integration` runs the whole
`tests/integration/` directory in one invocation, so a separate
per-file re-run would duplicate execution and risk double-counting — the
exact error that produced contradiction C-1 (`PHASE_1.6_SPEC.md` §10.2).
Where a step needs a targeted re-run, it says so and states why.

Steps 6 and 7 are analysis steps and may proceed even if Step 2 is
BLOCKED, because their inputs are prior measurements and static
artifacts. Step 7 in particular must be delivered even in a fully-blocked
run — a blocked gate still owes an accurate classification of what
blocked it.

### 4.6 Non-substitution rule

No step may satisfy its success criteria using another step's evidence.
Step 4 may not certify privilege denial from Step 2's aggregate pass
count; it must show the per-case codes. Step 5 may not certify
default-deny from Gate 2's policy count; the count is an input, not the
proof.

---

## STEP 1 — ENVIRONMENT / RUNTIME READINESS

### Objective

Establish, per service, whether the committed local stack is in a state
that can support integration execution — and record F16-01's state as
found. Target level: RUNTIME VERIFIED for the environment's own state.
This step proves nothing about SETURA product behaviour; it establishes
whether later steps' results are attributable to the product at all.

### Inputs

- `supabase/config.toml` — the committed stack definition.
- `PHASE_1.6_FINDINGS_LOG.md:43-86` (F16-01), `:87-109` (F16-02),
  `:111-128` (F16-03) — the prior environment findings, for comparison.
- `PHASE_1.6_SPEC.md` §14 — the blocker baseline.
- `deno.json` — command authority.

### Authorized commands / actions

- `supabase status`, `supabase status -o json`.
- `docker ps -a`, `docker inspect` on Supabase containers, reading the
  fields named under *Expected evidence*.
- `docker logs` on `supabase_edge_runtime_setura` and
  `supabase_vector_setura`, tail only.
- `docker start supabase_edge_runtime_setura` — permitted as an
  environment action to restore the measuring instrument (§3.3).
- `supabase start` if the stack is down.
- An unauthenticated HTTP probe of the Edge Functions endpoint to
  establish routing reachability.
- A read-only database connectivity probe (e.g. `select 1`, extension
  state) via the local connection reported by `supabase status`.
  **Not a `pg_policies` count.** Step 5 is the authoritative and only
  measurement point for the live policy catalog; taking a count here would
  create two measurements of one figure and invite Step 5 to cite Step 1's
  instead of taking its own, which §4.6 forbids.
- `ls .env*`, `ls supabase/functions/.env*` — to record F16-02's state.

### Prohibited actions

- Changing any container's `RestartPolicy`, or any other container
  configuration (PART 12).
- Recreating or removing containers; `docker compose down`, `supabase
  stop --no-backup`, or any operation that discards volumes.
- `supabase db reset` or any destructive database operation.
- Creating `.env` or any secret file (§4.4).
- Editing `supabase/config.toml`.
- Querying or counting `pg_policies`. That measurement belongs to Step 5
  and to Step 5 only (§4.6).
- Reporting a started container as evidence that F16-01 is fixed.
- Reporting `supabase start` exit 0 as evidence that any service is up.

### Expected evidence

- Per Supabase container: name, `State.Status`, `State.ExitCode`,
  `State.Error`, `State.OOMKilled`, `RestartCount`, `HostConfig.RestartPolicy.Name`,
  health where present, and `FinishedAt` for any exited container.
- `supabase status` output, including which services are reported stopped.
- Edge Functions endpoint probe: HTTP status and body. A `401` with
  `Missing authorization header` originating from
  `file:///var/tmp/sb-compile-edge-runtime/root/index.ts` is the
  platform's own gate rejecting an unauthenticated probe — it indicates
  the runtime is **up and routing**, and is **not** an application fault
  (`PHASE_1.6_FINDINGS_LOG.md:64-70`).
- Database probe result, proving connectivity.
- **Edge Runtime's current `HostConfig.RestartPolicy.Name` recorded
  verbatim, whatever its value**, alongside at least three peer services
  for contrast. The measurement is of the *current* state; this
  specification does not presuppose any particular value.
- The current value **compared against the F16-01 baseline** of
  `RestartPolicy=no` (`PHASE_1.6_FINDINGS_LOG.md:43-86`), with the
  comparison's outcome stated explicitly as either *unchanged* or
  *differs*, and any difference recorded verbatim and classified.
- Presence/absence listing of `.env*` paths.
- Vector's current `RestartCount` and health.

### Success criteria

PASS requires all of:

1. Database reachable and accepting read-only queries.
2. `supabase_edge_runtime_setura` running, and the endpoint probe showing
   the runtime routing requests (per the evidence note above).
3. Per-service state captured for every Supabase container.
4. Edge Runtime's current `RestartPolicy` captured verbatim with peer
   contrast, and compared against F16-01's baseline of `no`. **The
   governing principle: Gate 3R observes the current state; it does not
   require the environment to remain defective in order for Step 1 to
   PASS.** Either comparison outcome satisfies this criterion, provided it
   is recorded and classified:
   - **If `RestartPolicy=no` remains** — F16-01 recurrence is confirmed.
     Record it as found, and do **not** report it as remediated.
   - **If the value differs** — record the observed value verbatim. Do
     **not** automatically classify the difference as remediation. Do
     **not** infer that the environment was repaired unless the evidence
     establishes *how and why* the state changed; absent such evidence the
     correct classification is *changed, cause unestablished*. F16-01's
     disposition remains Gate 8's to assign, and its severity remains
     PROPOSED either way.
   - In neither case is any container configuration changed by Gate 3R
     (see *Prohibited actions*). Starting a stopped container is not
     remediation and is never reported as such (§3.3).
5. F16-02's and F16-03's states recorded as found.

### Failure criteria

- **FAIL** — the database is unreachable, or a service is in a state that
  contradicts prior findings without explanation. FAIL here is an
  *environment* FAIL and must be labelled as such; it is not a product
  FAIL. **Exception:** an Edge Runtime `RestartPolicy` differing from
  F16-01's baseline is **not** a FAIL under this criterion — success
  criterion 4 defines its handling (record verbatim, classify as
  *changed, cause unestablished* absent evidence of how and why).
- **BLOCKED** — Docker or the Supabase CLI cannot be invoked, or the Edge
  Runtime cannot be brought up after a permitted `docker start`. BLOCKED
  is not FAIL (`PHASE_1.6_SPEC.md` §8.1).
- If Edge Runtime cannot be started: Step 1 is PARTIAL, Step 3 becomes
  BLOCKED, and Step 2 proceeds with the three Edge-dependent files'
  results pre-attributed to F16-01 under §4.2.

### Deliverable location

`PHASE_1.6_GATE_3R_REPORT.md` §1 — "Environment and runtime readiness".

---

## STEP 2 — FULL INTEGRATION SUITE EXECUTION

### Objective

Execute the complete committed integration suite and record exactly what
executed, exactly what passed, and exactly what failed. Target level:
INTEGRATION VERIFIED, bounded strictly by what the suite's assertions
actually assert. This step closes matrix row F-11 if it succeeds.

Historical position: 1 of 11 files had ever been executed
(`privilege_isolation.test.ts`). `NEXT_PHASE_READINESS_REPORT.md:1143` —
"The integration suite was never executed" — is accurate for the other
10.

### Inputs

- `deno.json` `test:integration` → `deno test --allow-net --allow-env
  --allow-run tests/integration/`. Command authority; the flags are not
  to be altered.
- `deno.json` `test` → `deno test --allow-env tests/unit/`, as a control.
- The 11 files enumerated in `PHASE_1.6_SPEC.md` §11.2.
- `CROSS_PHASE_REQUIREMENTS_MATRIX.md:120` — "162 cases counted
  statically". A declaration count (§4.1 rule 2).
- Step 1's readiness result — a hard precondition.

### Authorized commands / actions

- `deno task test:integration`.
- `deno task test` (unit control).
- Re-running the suite once if the first run is inconclusive for an
  environment reason, with both runs recorded.
- Per-file invocation of the same command form, **only** where needed to
  attribute a failure or to obtain per-file counts the aggregate output
  does not expose — recorded as a targeted re-run, not as a second suite
  execution.
- `deno task validate:migrations`, `deno task lint`, `deno task check`,
  `deno task fmt:check`, `deno task gen:types:check` — read-only
  baselines.

### Prohibited actions

- Modifying any test file, fixture, or helper — for any reason,
  including to fix a failure (PART 6, PART 12).
- Adding, removing or changing Deno permission flags to make a test pass.
- Skipping, filtering or `--ignore`-ing a file to obtain a cleaner
  result. If a file must be excluded, that is a stop condition (§4.3),
  not a decision.
- `supabase db reset`, seeding, truncating, or otherwise resetting
  database state to obtain a pass. Existing state is preserved (PART 6).
- Creating secrets (§4.4).
- Reporting the static 162 as a passed count.
- Aggregating a partial run into a total.
- Classifying any failure as a test problem without evidence (§4.2).

### Expected evidence

- The exact command invoked, verbatim.
- **Exact file count discovered by the runner**, compared against the 11
  files enumerated statically. A divergence is itself a finding.
- **Exact test count executed**, compared against the static 162. Deno
  reports passed / failed / ignored / measured; all four are captured.
- **Per-file** pass/fail breakdown, and which files ran at all. Note that
  the task specifies no `--parallel`, so files are expected to execute
  sequentially; if a file aborts, later files' status must be recorded as
  executed-or-not rather than assumed.
- For every failure: the test name, the file, the assertion that failed,
  the full error including any `code`, and the classification under §4.2
  with its supporting evidence.
- Total wall-clock and any timeout.
- The unit-suite control result.
- Read-only baseline results, compared against
  `PHASE_1.6_SPEC.md` §11.4 (`validate:migrations` 0 errors + 4
  pre-existing `[duplicate-objects]` warnings; `fmt:check` failing on 8
  root markdown files, zero source files — plus any files added by this
  authorization, which is expected and is not a finding).

### Success criteria

**Measurement-status** PASS (axis 1 below) requires all of:

1. All 11 files discovered and executed.
2. Executed test count recorded and reconciled against the static 162,
   with any divergence explained.
3. Zero failures — **or** every failure classified under §4.2 with
   evidence.
4. The record states what the suite proves in terms of its assertions
   only, and does not claim more (PART 4 Step 2).

#### Step 2 reports two independent axes — never one

Step 2 produces **two separate statements**, and the report must present
both. Collapsing them is a §4.1 violation and, at gate level, grounds for
FAIL (§5.2.5, "contradictory or unsupported evidence").

**Axis 1 — STEP 2 MEASUREMENT STATUS.** PASS means the complete
integration suite was executed and its outcome was completely and
accurately measured, reconciled, and classified according to this
specification. This is a statement about the *integrity of the
measurement* and nothing else.

**Axis 2 — PRODUCT TEST OUTCOME.** The actual test result, recorded
independently. It may contain any of: zero failures · failures · blocked
files · partial execution. This is a statement about the *product and its
tests*.

The two axes are independent. A suite that runs fully and reports failures
— each classified under §4.2 with evidence — is a **successful
measurement**: measurement status PASS, product outcome "N failures".

**A Step 2 measurement PASS must never be restated, summarized, quoted or
carried forward as "all integration tests passed", "the integration suite
passed", or any equivalent.** A future auditor reading "Step 2 = PASS"
must be unable to derive a product claim from it. Wherever the Step 2
status appears in the report, the product outcome appears alongside it.

Conversely, product failures alone do not reduce the measurement status
(§5.2.6).

### Failure criteria

- **FAIL** — the suite cannot complete, or files silently fail to execute,
  or counts cannot be reconciled.
- **BLOCKED** — Step 1 did not reach readiness; or execution is prevented
  by tooling, permissions, or a missing prerequisite. Record the exact
  blocker and its shape.
- **PARTIAL** — some files execute and others do not. Record N of 11
  explicitly. A partial run may not be reported as "the suite was run".

### Deliverable location

`PHASE_1.6_GATE_3R_REPORT.md` §2 — "Full integration suite execution",
with the per-file table as §2.1 and the failure classification as §2.2.

---

## STEP 3 — EDGE-DEPENDENT RUNTIME VERIFICATION

### Objective

Determine whether the integration paths that traverse Edge Runtime
actually executed against a live Edge Runtime, and attribute their
results correctly between the product and the environment. Target level:
RUNTIME VERIFIED for the Edge invocation path — or a clean F16-01
attribution where the runtime was down.

**Precondition on scope, per PART 4 Step 3** ("Only if they are actually
part of the current integration suite"): all three named files are
confirmed present in `tests/integration/` and are therefore inside
`deno task test:integration`'s scope. The condition is satisfied; the
files are in scope.

### Inputs

- Step 1's Edge Runtime readiness result and endpoint probe.
- Step 2's per-file execution record.
- The three Edge-invoking files and their invocation sites, established
  statically by Gate 3: `tests/integration/whatsapp_lifecycle.test.ts:392`,
  `tests/integration/enterprise_command_center.test.ts:234`,
  `tests/integration/doctor_operations.test.ts:376`
  (`PHASE_1.6_FINDINGS_LOG.md:71-77`).
- F16-01 as recorded, `PHASE_1.6_FINDINGS_LOG.md:43-86`.
- `whatsapp_lifecycle.test.ts:389-407` — the worker-secret boundary case,
  which asserts 403 for the **absence** of the header (§4.4).

### Authorized commands / actions

- Reading Step 2's output for these three files.
- A targeted re-run of one of the three files, per §4.5, where the
  aggregate output does not permit attribution.
- `docker logs supabase_edge_runtime_setura`, tail, to correlate a
  failure with runtime state.
- Re-checking Edge Runtime state after Step 2, to detect an exit during
  the run — this matters because `RestartPolicy=no` makes any mid-run exit
  permanent.
- Static reading of the three files to determine what each Edge
  invocation asserts.

### Prohibited actions

- Modifying any of the three files, including the 403 assertion.
- Changing Edge Runtime configuration, environment, or restart policy.
- Providing a secret to make the 403 case exercise a different path
  (§4.4) — that assertion is correct as written and depends on absence.
- Recording an F16-01-attributable failure as a product defect (§4.2).
- Recording the platform's own `Missing authorization header` log line as
  an application fault (`PHASE_1.6_FINDINGS_LOG.md:64-70`).
- Claiming any Edge Function is production-verified.
- Inferring that the remaining 8 files are Edge-independent. Gate 3
  established that exactly these three invoke Edge Functions; the other 8
  are recorded as "not established", which is not a proof of independence
  (`PHASE_1.6_SPEC.md` §11.2).

### Expected evidence

- For each of the three files: executed or not; per-test pass/fail; and
  for each failure, the HTTP status **and** response body **and** any
  `code`.
- Edge Runtime state immediately before and immediately after Step 2,
  with `State.Status`, `State.ExitCode` and `FinishedAt`. A transition
  from running to exited during the run is a material observation and a
  second independent instance of F16-01's mechanism.
- Correlation of any Edge-path failure with runtime state at that moment.
- An explicit attribution line per failure: product vs F16-01
  environment.
- What each Edge invocation actually asserts, so the record does not
  overstate the path's coverage.

### Success criteria

PASS requires all of:

1. All three files executed, with Edge Runtime confirmed up before and
   after.
2. Every Edge-path result attributed, with evidence, to product or
   environment.
3. The 403 worker-secret case's result recorded with its dependency on
   secret absence stated explicitly.
4. No claim exceeding what the invocations assert.

### Failure criteria

- **FAIL** — an Edge invocation fails while Edge Runtime is confirmed up
  and healthy, and the failure is not attributable to the environment.
  That is a genuine product observation and is classified as an
  implementation failure under §4.2.
- **BLOCKED** — Edge Runtime is down for the run, or exits mid-run. All
  three files' Edge-path results are then attributed to F16-01, recorded
  BLOCKED rather than FAIL, and F16-01 gains a further recurrence
  instance.
- **NOT APPLICABLE** does not apply to this step: the files are in scope.

### Deliverable location

`PHASE_1.6_GATE_3R_REPORT.md` §3 — "Edge-dependent runtime verification",
with the attribution table as §3.1.

---

## STEP 4 — SECURITY / PRIVILEGE REGRESSION VERIFICATION

### Objective

Record the exact executed result of the security regression suite, and
determine — from per-case error codes, not from HTTP status — whether its
denial assertions were satisfied by PostgreSQL privilege denial or by
JWT-layer rejection. Target level: INTEGRATION VERIFIED for the suite's
result; and, for F16-05, a determination of whether the known weakness
was actually realized at runtime.

This step does **not** re-open P1-11. The privilege boundary itself is
independently established by Gate 2's catalog census plus runtime
`42501`, and that does not depend on this suite
(`PHASE_1.6_SPEC.md` §4 Gate 2, §14.7).

### Inputs

- `tests/integration/privilege_isolation.test.ts` — ~1,900 lines, **22**
  tests.
- **Carried-forward result: 22 passed / 0 failed**, measured by historical
  Gate 3 Step 4. **Recorded as 22. Never as 34** (PART 4 Step 4;
  contradiction C-1, `PHASE_1.6_SPEC.md` §10.2).
- Step 2's execution of the same file inside the full-suite run.
- F16-05 as recorded, `PHASE_1.6_FINDINGS_LOG.md:161-189` — the assertion
  helpers accept `jwt` and `no suitable key` as denial signatures.
- F16-06 as recorded, `PHASE_1.6_FINDINGS_LOG.md:191-230` — probe-site
  counts.
- The mechanism sites: `messageOf` at `:205-213`; `assertRpcDenied` at
  `:241-246`; `assertTableDenied` at `:1237-1239`; positive controls in
  separate `Deno.test` blocks at `:571` and `:1711`; the documented
  unreachable 4-argument `capture_payment` overload at `:648-653`.
- Gate 2's census: 4 Category A · 145 Category B · 10 B-trigger · 10
  Category C · 24 Category D = 193 routines; 179 locked.

### Authorized commands / actions

- Reading Step 2's output for this file.
- A targeted re-run of this file alone, per §4.5, to obtain per-case
  detail the aggregate output does not expose. **Both** results are
  recorded — the isolated run's result, whatever its value, and the
  in-suite result — because a divergence between them is itself evidence
  about fixture interference, not noise to be reconciled away. **This
  specification does not presuppose any particular value for the isolated
  run's result.** The 22 passed / 0 failed figure under *Inputs* is
  historical Gate 3's measurement carried forward, not an expected outcome
  for this run; 22 remains the canonical **case count**, and reporting the
  suite as 34 cases remains prohibited (see *Prohibited actions*).
- Read-only catalog queries to re-confirm a specific routine's ACL where
  a case's attribution is ambiguous: `pg_proc.proacl`,
  `has_function_privilege()`.
- Static reading of the suite to count probe sites.

### Prohibited actions

- Modifying the suite. Specifically: not strengthening `assertRpcDenied`
  or `assertTableDenied` to remove the `jwt` acceptance (that is F16-05's
  remediation and belongs to a remediation phase), not widening coverage
  (F16-06), not correcting the "193 RLS policies" comment at `:565-570`
  (F16-07).
- Changing any grant, revoke, or privilege (PART 12).
- **Using HTTP status as privilege evidence.** A 401 alone proves nothing
  in either direction.
- Reporting the suite as 34 cases, or as a suite separate from
  `test:integration` — it is one of that task's 11 files.
- Restating probe-site counts as runtime coverage. 40 of 179 is a count
  of **sites in source**, not executed probes
  (`PHASE_1.6_FINDINGS_LOG.md:220-222`).
- Claiming F16-05 resolved because all 22 tests passed. Passing is
  consistent with both a genuine denial and a JWT failure; that is the
  entire finding.
- Claiming production privilege verification.

### Expected evidence

- Exact executed result: passed / failed / ignored, per test name.
- **Per denial case: the response `code`.** `42501` → PostgreSQL
  privilege denial. `PGRST301` with "None of the keys was able to decode
  the JWT" or "No suitable key or wrong key type" → JWT decoding failure,
  which means the request never reached the database and the privilege
  boundary was not exercised. `PGRST202` → function not resolvable.
  `0A000` → trigger function invoked directly.
- The Category A positive control's result (`:571`), which establishes
  whether the fixture token resolved to `hospital_admin` at all. Its
  limitation is recorded: it lives in a different `Deno.test`, so its
  success does not prevent Category B/C/D denials from passing spuriously
  (`PHASE_1.6_FINDINGS_LOG.md:176-180`).
- **F16-05 determination**, stated as one of: NOT REALIZED (every
  authenticated-half denial carried `42501`); REALIZED (at least one
  carried a JWT signature); or UNPROVEN (codes unavailable). The `anon`
  half is unaffected by construction — no Authorization header is sent, so
  the JWT channel is unreachable.
- **F16-06 executed counts**, separating: static probe sites · probes
  actually executed · denials that passed · denials that failed · probes
  blocked or unreachable. **Do not inflate coverage.**
- The two legitimate documented exclusions restated as legitimate: the
  4-argument `capture_payment` overload (unreachable through PostgREST
  because any 4-key payload also matches the 5-argument overload via its
  default), and the 10 B-trigger routines (structurally non-callable,
  proven by Gate 2 via `PGRST202` for both `anon` and `service_role` and
  `0A000` on direct invocation).

### Success criteria

PASS requires all of:

1. The exact executed result recorded, as 22 cases.
2. Every denial case's `code` captured, or its absence explicitly
   recorded as a limitation.
3. F16-05 given one of the three determinations above, with evidence.
4. F16-06's five counts recorded separately and un-inflated.
5. No HTTP-status-only privilege claim anywhere in the record.

### Failure criteria

- **FAIL** — a denial that previously passed now fails, or a routine that
  should be locked is executable. Either is a security-boundary
  observation and a stop condition under §4.3 item 6.
- **BLOCKED** — per-case codes cannot be obtained. F16-05's determination
  is then UNPROVEN, exactly as historical Gate 3 left it; that is an
  acceptable outcome and must not be dressed up as resolution.
- **A determination of F16-05 REALIZED is not a FAIL of this step.** It is
  a successful measurement of a known test-quality gap, and it does not
  imply any privilege boundary is broken — Gate 2 proves the boundary
  independently.

### Deliverable location

`PHASE_1.6_GATE_3R_REPORT.md` §4 — "Security and privilege regression",
with the per-case code table as §4.1, the F16-05 determination as §4.2,
and the F16-06 count table as §4.3.

---

## STEP 5 — RUNTIME RLS / DEFAULT-DENY VERIFICATION

### Objective

Measure, first-hand, the applicable-policy count for each of the five
fixed-scope tables; then establish at runtime, and independently of row
counts, what that measured posture actually produces — for a table measured
at zero applicable policies, whether it denies non-bypass roles — and,
**separately and by different evidence**, that the one explicitly-REVOKEd
contrast table denies at the grant layer. Target level: RUNTIME VERIFIED
for the measured policy posture of all five tables; RUNTIME VERIFIED for
default-deny **behaviour** on those Class A tables measured at zero
applicable policies; and RUNTIME VERIFIED for **grant-layer denial** on the
contrast table. The results are reported distinctly and none substitutes for
another.

**"The four zero-policy tables" is the carried-forward premise this step
tests, not an input it assumes** — see *Fixed scope* and *Measurement
order*.

**This step verifies behaviour, not architecture.** Whether a table
*ought* to have policies, and whether relying on RLS alone is
architecturally intended, are Gate 7's questions and are out of scope
here (PART 4 Step 5, `PHASE_1.6_SPEC.md` §4 Gate 7).

### Inputs

- **Carried forward: 139 public policies.** Attribution, stated precisely
  because it bears on how a delta must be read: the figure's only
  persisted appearance is `PRIVILEGE_RUNTIME_VERIFICATION.md:446`, in
  Gate 2's *"Scope limits, stated explicitly"* section, in a sentence whose
  subject is Gate 1 — *"Gate 1 measured 93/93 tables with RLS enabled;
  whether the 139 policies are individually correct is not asserted
  here."* **Gate 2 therefore cited the figure; it did not independently
  measure it.** Nor can Gate 1 be confirmed as its origin: Gate 1 has no
  persisted deliverable (`PHASE_1.6_SPEC.md` §4, Gate 1 · Tier B), the
  figure appears nowhere in `PHASE_1.6_FINDINGS_LOG.md`, and that log's
  F16-07 entry at `:250` positively records the live count as
  **"UNMEASURED"** with `:256` waiting on it. **Conclusion: 139 is an
  unattested carry-forward figure whose originating measurement is not
  persisted.** It is preserved as an input and not re-derived (PART 4
  Step 5), but it must not be cited as established Gate 2 evidence, and a
  live count differing from it is not evidence of drift (see *Failure
  criteria*).
- Contradiction C-2 (`PHASE_1.6_SPEC.md` §10.3): the "193 RLS policies"
  comment is a routine count; the static upper bound on live policies is
  ≤ 144 from 144 `CREATE POLICY` / 130 `DROP POLICY` with zero
  dynamically generated policies.
- OBS-1 and OBS-2, and the five tables' RLS provenance
  (`PHASE_1.6_SPEC.md` §11.5): `whatsapp_delivery_logs`,
  `settlement_items`, `rate_limit_rules`, `blocked_devices` — the four
  zero-policy tables retaining broad grants; and `consultation_notes`,
  which carries explicit REVOKEs at
  `46_doctor_clinical_operations.sql:984-987`.
- The row-count-independent discriminator: zero applicable policies
  compile to plan node `Result … One-Time Filter: false`, visible via
  `EXPLAIN` under `SET ROLE` (`PHASE_1.6_SPEC.md` §8.4).

### Fixed scope

Exactly these five tables, and no others. The scope is fixed here so it
cannot expand during execution:

| Table | RLS provenance | Grant posture | Zero-policy status |
|---|---|---|---|
| `whatsapp_delivery_logs` | `04_whatsapp_messaging_engine.sql:740-741` ENABLE, `:755-756` FORCE | broad grants retained (OBS-1) | Carried-forward premise; applicable-policy count measured independently by this step |
| `settlement_items` | `07_settlement_engine.sql:584-585` ENABLE, `:596-597` FORCE | broad grants retained (OBS-1) | Carried-forward premise; applicable-policy count measured independently by this step |
| `rate_limit_rules` | `09_abuse_protection_&_rate_limiting.sql:630-631` / `:651-652` | broad grants retained (OBS-1, OBS-2) | Carried-forward premise; applicable-policy count measured independently by this step |
| `blocked_devices` | `09_abuse_protection_&_rate_limiting.sql:642-643` / `:663-664` | broad grants retained (OBS-1, OBS-2) | Carried-forward premise; applicable-policy count measured independently by this step |
| `consultation_notes` | `46_doctor_clinical_operations.sql:174` ENABLE | explicit REVOKEs `:984-987` — contrast case | Carried-forward premise; applicable-policy count measured independently by this step |

**On the phrase "zero-policy".** Throughout this step, and throughout this
specification, "the four zero-policy tables" is a **carried-forward premise
and a naming convention — not a measured fact.** The provenance cited above
proves `ENABLE`/`FORCE ROW LEVEL SECURITY` only. **RLS enabled, and RLS
forced, do not prove zero applicable policies.** No persisted Phase 1.6
measurement establishes the applicable-policy count for any of these five
tables: Gate 1 has no persisted deliverable, and the only persisted policy
figure at all — 139 — is unattested and table-agnostic (see *Inputs*).

The applicable-policy count for each of the five tables is therefore
**measured independently and first-hand by this step**, and the evidence
criteria are selected *after* that measurement, by the branch logic under
*Expected evidence*. The premise is a starting hypothesis this step tests.
The scope is fixed; the premise is not established.

### Measurement order

This order is mandatory. A step that applies an evidence criterion before
measuring the count it depends on has presupposed its own result.

1. **Measure** the applicable-policy count for each of the five fixed-scope
   tables, first-hand, from `pg_policies` (plus `pg_class.relrowsecurity` /
   `relforcerowsecurity`). Step 1 takes no such count and none may be cited
   from it (§4.6, §Step 1 *Prohibited actions*).
2. **Record** the actual measured count per table, verbatim, whatever its
   value — including a non-zero value.
3. **Branch** on the measured count: Branch A for zero, Branch B for
   non-zero (*Expected evidence*, below).
4. **Apply** only the branch's evidence criteria. Do not apply Branch A's
   criteria to a table measured non-zero, and do not apply Branch B's to a
   table measured zero.

### Authorized commands / actions

- Read-only catalog queries: `pg_policies`, `pg_class.relrowsecurity`,
  `pg_class.relforcerowsecurity`, `pg_roles.rolbypassrls`, table ACLs via
  `relacl` or `information_schema.role_table_grants`.
- `EXPLAIN` on a `SELECT` against each in-scope table under `SET ROLE
  anon` and `SET ROLE authenticated`, inside a transaction that is rolled
  back.
- `RESET ROLE` / transaction rollback after each probe.
- A live `pg_policies` count — the first persisted first-hand measurement
  of this figure (see *Inputs*) — to test whether the carried-forward 139
  holds and to supply C-2's correct value.
- A first-hand per-table applicable-policy query over `pg_policies` for
  each of the five fixed-scope tables. This is the measurement that selects
  Branch A or Branch B (*Measurement order*), and it is taken here, not
  imported from Step 1 or Gate 2 (§4.6).

### Prohibited actions

- `CREATE POLICY`, `DROP POLICY`, `ALTER POLICY`, `ALTER TABLE … ROW
  LEVEL SECURITY`, `GRANT`, `REVOKE` — any RLS or grant change (PART 12).
- Any write to any in-scope table, including inside a rolled-back
  transaction. Probes are `SELECT`/`EXPLAIN` only.
- Inferring RLS filtering from an empty result set. A `200 []` under
  `anon` proves nothing if the table is empty — the prior session's
  `service_role` control returned `[]` from the same tables, proving
  emptiness rather than filtering.
- **Representing `consultation_notes`' grant-layer denial as proof of RLS
  default-deny behaviour.** The two mechanisms are distinct and must be
  reported distinctly. Equally: do not treat the four Class A tables'
  plan-level RLS evidence as proof of anything about grant-layer
  enforcement.
- Counting `consultation_notes` toward the Class A default-deny result, or
  reporting "five tables demonstrate RLS default-deny". Four are the
  Class A candidates, and how many of those four actually demonstrate
  default-deny is what this step measures; the fifth is a contrast case and
  is never one of them.
- **Creating F16-08.** Not from a broad grant on an RLS-enabled table,
  not from an unreferenced table, not from OBS-1 or OBS-2, not from any
  structural suspicion (PART 11). A finding requires evidence of an actual
  defect.
- **Creating any finding ID solely because a measured applicable-policy
  count is non-zero** — i.e. because Branch B was selected rather than
  Branch A. The premise not holding is a fact about this specification's
  carried-forward premise, not a fact about the product (*Expected
  evidence*, Branch B).
- **Declaring the required plan-level evidence "technically inapplicable"**
  for a Class A table measured at zero policies. The only defined outcomes
  are Branch A satisfied, FAIL, or a BLOCKED sub-measurement recorded with
  its exact error (*Failure criteria*). Row counts remain prohibited as a
  substitute in every case.
- Citing Step 1 for any policy count. Step 1 takes none (§Step 1
  *Prohibited actions*), and Step 5 may not import one regardless (§4.6).
- Deciding whether zero-policy coverage is architecturally correct
  (Gate 7).
- Expanding scope beyond the five tables.
- Restating a policy count as an audit. A count is not V-03's per-policy
  audit (§Step 6).

### Expected evidence

The five in-scope tables divide into **two evidence classes** because they
are denied by **two different enforcement mechanisms**. The classes have
different evidence requirements and must not be merged.

**Common to all five:**

- Live `pg_policies` public count, compared against the carried-forward
  figure.
- Per table: `relrowsecurity`, `relforcerowsecurity`, **the first-hand
  measured applicable-policy count**, and effective grants for `anon` and
  `authenticated`. The measured count is recorded before any evidence
  criterion is applied (*Measurement order*).
- Which roles carry `rolbypassrls`, so the scope of the guarantee is
  stated precisely — default-deny binds non-bypass roles only.

**Class A — the four candidate zero-policy tables.**
`whatsapp_delivery_logs`, `settlement_items`, `rate_limit_rules`,
`blocked_devices`. These retain broad grants, so the probing role reaches
the planner and RLS is the operative mechanism.

- Per table per role (`anon`, `authenticated`): the `EXPLAIN` plan, with
  the presence or absence of `One-Time Filter: false` quoted verbatim.
- Then, **per table, whichever branch the measured count selects.** The
  count is measured first; the criterion follows from it.

**Branch A — measured applicable-policy count = 0.**

- Default-deny is established by **plan-level RLS evidence**: the `EXPLAIN`
  plan under each role must contain `Result … One-Time Filter: false`,
  quoted verbatim. **Never by row count** (§4.1 rule 6).
- If that plan node is absent while the measured count is zero, the
  measurement **FAILs** (see *Failure criteria*) — that is the genuine
  defect case, and the exact plan is recorded as the evidence for it.
- There is no discretion to declare the plan evidence inapplicable. If a
  technical condition genuinely prevents obtaining an `EXPLAIN` plan for a
  Class A table at all, that is a **BLOCKED sub-measurement** under
  *Failure criteria* — recorded with the exact error and the exact
  condition, never satisfied by an alternative that this specification has
  not defined, and never satisfied by a row count.

**Branch B — measured applicable-policy count > 0.**

The carried-forward premise did not hold for that table. This is a
**measurement result about the specification's premise**, not a product
observation.

- Record the measured count, the policies themselves (name, command, roles,
  `qual` / `with_check`), and the observed `EXPLAIN` plan verbatim.
- Classify the table's result as: **POLICY POSTURE DIFFERS FROM
  CARRIED-FORWARD PREMISE.**
- **`One-Time Filter: false` is not required and its absence is not a
  FAIL.** A table with a genuine applicable policy correctly does not
  compile to an unconditional false filter; requiring it would manufacture
  a defect out of correct behaviour.
- The classification is **not**: a product defect · proof of drift · proof
  that RLS is correct · proof that RLS is incorrect · permission to create
  a new finding ID.
- **Creating a finding ID solely because a live applicable-policy count is
  non-zero is prohibited** (see *Prohibited actions*). This mirrors exactly
  the treatment of the unattested 139 figure: a first-hand measurement
  diverging from an unattested carried-forward figure is a measurement, not
  a defect (see *Inputs*, *Failure criteria*).
- Branch B **satisfies** this step's success criterion for that table. The
  step's obligation is to measure and record accurately, not to obtain a
  particular value.
- Whether such a table's policies are individually correct is **not**
  assessed here — that is V-03's per-policy audit and Gate 7's scope
  (§Step 6, `PHASE_1.6_SPEC.md` §4 Gate 7).

**Class B — `consultation_notes`, the grant-layer contrast case.** This
table is *intentionally different*: explicit REVOKEs exist at
`46_doctor_clinical_operations.sql:984-987`. It is in scope to demonstrate
a **different enforcement mechanism**, not to add a fifth RLS datapoint.

- The applicable **grant-layer denial** caused by the explicit REVOKEs,
  captured verbatim — whichever form it takes.
- **A plan node is not required for this table.** A REVOKE may cause the
  probing role to be denied at the SQL parser/planner stage before an
  `EXPLAIN` plan can be produced at all — e.g. `permission denied for
  relation consultation_notes` (SQLSTATE `42501`). **If that occurs,
  capturing that denial error itself is the required grant-layer evidence,
  and it fully satisfies this table's criteria. The absence of a plan node
  for `consultation_notes` must not be recorded as a missing measurement,
  a BLOCKED sub-measurement, or a gap.**
- An explicit statement that this is a **contrast case demonstrating a
  different enforcement mechanism** from Class A.
- The grant-layer denial must **not** be represented as proof of RLS
  default-deny behaviour — see the prohibition below.

### Success criteria

PASS requires all of:

1. Live policy count obtained and reconciled with the carried-forward
   figure.
2. **Per-table applicable-policy count measured first-hand and recorded
   before any evidence criterion is applied** (*Measurement order*), for all
   five tables, and not cited from Step 1 or from Gate 2 (§4.6).
3. **Class A — the four candidate zero-policy tables**
   (`whatsapp_delivery_logs`, `settlement_items`, `rate_limit_rules`,
   `blocked_devices`) probed under both roles, with the branch selected by
   each table's measured count and its criteria applied:
   - **Branch A (measured 0)** — default-deny established by **plan-level
     RLS evidence**: `One-Time Filter: false` present and quoted verbatim.
     Never by row count.
   - **Branch B (measured > 0)** — the count, the policies, and the plan
     recorded, and the table classified **POLICY POSTURE DIFFERS FROM
     CARRIED-FORWARD PREMISE**. This satisfies the criterion. No
     `One-Time Filter: false` is required, and no finding ID is created.
4. **Class B — `consultation_notes`** verified and documented as the
   grant-layer contrast case: the applicable denial caused by the explicit
   REVOKEs is captured. **Satisfied either by a plan showing the denial or
   by the parser/planner-stage denial error itself; a plan node is not
   required for this table, and its absence is not a missing
   measurement.**
5. The report states explicitly that `consultation_notes` is a **contrast
   case demonstrating a different enforcement mechanism**, and does
   **not** represent its grant-layer denial as proof of RLS default-deny
   behaviour.
6. OBS-1 and OBS-2 still recorded as observations, not findings.
7. Behaviour and architectural intent kept separate throughout.

### Failure criteria

- **FAIL** — a **Class A** table **whose applicable-policy count was
  measured as zero** returns rows, or produces a plan without
  `One-Time Filter: false`, under `anon` or `authenticated`. That would be
  a genuine defect and a stop condition (§4.3 item 6). Only then would a
  new finding ID be warranted, and its severity would still be PROPOSED.
  **This criterion applies to Branch A only.** A table measured at a
  non-zero applicable-policy count is on Branch B and cannot FAIL under it.
- **A non-zero measured applicable-policy count on a Class A table is not
  a FAIL.** It is Branch B: a measurement result classified **POLICY
  POSTURE DIFFERS FROM CARRIED-FORWARD PREMISE**, recorded with its count,
  policies and plan. It does not by itself create a finding ID, does not
  prove drift, and proves nothing about whether RLS is correct or
  incorrect (*Expected evidence*, Branch B).
- **FAIL — Class B** only if `consultation_notes` returns rows under
  `anon` or `authenticated`, i.e. neither the grant layer nor RLS denied
  access. A parser/planner-stage denial without a plan is the **expected**
  result and is a PASS, not a FAIL.
- **BLOCKED** — the database is unreachable, or `SET ROLE` is not
  permitted by the available connection. **BLOCKED sub-measurement** — a
  Class A table's applicable-policy count or `EXPLAIN` plan cannot be
  obtained at all, for a technical condition recorded verbatim with its
  exact error. A BLOCKED sub-measurement is recorded as blocked; it is
  never converted into a PASS by substituting evidence this specification
  has not defined, and never by a row count.
- A live policy count differing from the carried-forward figure is **not**
  a FAIL. It is a measurement; record it, and record the delta and its
  likely cause — including the possibility that the carried-forward figure
  was never independently attested (see *Inputs*), in which case this
  step's count is the first persisted measurement rather than evidence of
  drift.

### Deliverable location

`PHASE_1.6_GATE_3R_REPORT.md` §5 — "Runtime RLS and default-deny", with
the per-table plan evidence as §5.1 and the preserved observations as
§5.2.

---

## STEP 6 — REMAINING CROSS-PHASE RUNTIME VERIFICATION

### Objective

Identify which currently-UNPROVEN cross-phase requirements can genuinely
be executed against the committed local stack, close those, and record the
rest as out of scope **with the reason** — rather than leaving them
ambiguously open. Target level: varies per requirement and is stated per
requirement below.

**Selection discipline, per PART 4 Step 6:** do not test an item merely
because it exists. Each requirement below carries four mandatory
statements — why it is in scope, what it proves, what it cannot prove, and
the exact evidence required.

**The UNPROVEN universe is twelve rows, not nine.**
`CROSS_PHASE_REQUIREMENTS_MATRIX.md` carries twelve `UNP` rows, enumerated
under *Inputs*. All twelve are dispositioned by this step. Nine of them are
the locally-relevant subset named in `CROSS_PHASE_GAP_REGISTER.md:584`;
that register sentence describes a subset and presupposes the twelve — it
does not set the size of the universe (see *Inputs*).

### Inputs

- `CROSS_PHASE_GAP_REGISTER.md` — canonical finding source. §6.3 at
  `:580-587` lists the measurements that would resolve specific findings.
  `:589-591`: "Nine of the twelve UNPROVEN matrix rows are unverified
  claims, not defects. No certification should be granted or revoked on
  them in either direction."
  **How that sentence is to be read.** The nine are the rows enumerated at
  `:584` — F-01, F-02, F-03, F-11, V-03, N5-02, N5-03, N5-04, and N1-10
  ("partially") — the locally-relevant / unverified-claim subset. The
  sentence says "nine of the twelve", so it presupposes twelve; it does
  **not** mean the UNPROVEN universe is nine. The remaining three rows —
  Z-03, R-08, V-07 — fall outside that sentence. No certification is
  granted or revoked on them here either, but the authority for that is
  this step's own exclusion, not the register's statement.
- `CROSS_PHASE_REQUIREMENTS_MATRIX.md` — the **twelve** UNPROVEN rows:
  F-01 `:110`, F-02 `:111`, F-03 `:112`, F-11 `:120`, **Z-03 `:152`**,
  **R-08 `:215`**, V-03 `:330`, **V-07 `:334`**, N1-10 `:395`, N5-02
  `:519`, N5-03 `:520`, N5-04 `:521`. The count is corroborated by the
  matrix's own per-set tallies, which sum independently to twelve: F 4
  (`:130`), Z 1 (`:161`), R 1 (`:217`), V 2 (`:337`), N1 1 (`:397`), N5 3
  (`:531`).
- Steps 1–5's results.
- Gate 2's census, for N5-02/03/04.

### Selection table

| Row | Requirement | Disposition |
|---|---|---|
| F-01 | Local stack starts | **IN SCOPE** — closed by Step 1 |
| F-11 | Integration harness exists and runs | **IN SCOPE** — closed by Step 2 |
| V-03 | Security audit over `pg_policies` | **PARTIAL** — count only; per-policy audit is Gate 7 |
| N5-02 | Category B (145) not executable by `anon`/`authenticated` | **ALREADY MEASURED** (Gate 2) — documentation lag, not an open measurement |
| N5-03 | Category C (10) restricted | **ALREADY MEASURED** (Gate 2) |
| N5-04 | Category D (24) restricted | **ALREADY MEASURED** (Gate 2) |
| F-03 | `supabase functions serve` starts without import errors | **OUT OF SCOPE** — see below |
| Z-03 | API contracts frozen (request/response shapes per endpoint) | **OUT OF SCOPE / NOT CLOSED BY STEP 2** — see below |
| F-02 | All migrations apply cleanly to a fresh database | **EXCLUDED** — requires `db:reset` |
| R-08 | Refund concurrent with settlement produces a consistent result | **EXCLUDED — NOT LOCALLY CLOSABLE** — no committed concurrency test exists |
| V-07 | DR test: Meta API outage → retry + DLQ | **EXCLUDED — NOT LOCALLY CLOSABLE** — no committed outage-simulation test exists |
| N1-10 | Endpoint reachable by Meta in production | **PERMANENTLY OUT OF SCOPE** |

**Twelve rows.** This table is the complete UNPROVEN universe, not the
locally-relevant subset of it.

### Per-requirement specification

**F-01 — local stack starts.**
*In scope because* Step 1 measures it directly.
*Proves* the committed stack comes up on this host.
*Cannot prove* that every service is healthy, that it comes up on another
host, or that F16-01 is absent — the F16-01 caveat travels with this row
permanently.
*Evidence required* Step 1's per-service state capture.

**F-11 — integration harness exists and runs.**
*In scope because* Step 2 executes the suite.
*Proves* the harness runs and, per file, what its assertions assert.
*Cannot prove* the suite is adequate. F16-06's coverage gap is
independent of F-11 and is not closed by it.
*Evidence required* Step 2's file count, test count, and per-file result.

**V-03 — security audit over `pg_policies`.**
*In scope, partially, because* Step 5 obtains a live policy count and
per-table evidence for five tables.
*Proves* the count; the first-hand applicable-policy count for each of the
five tables; whichever of default-deny behaviour (Branch A) or a differing
policy posture (Branch B) each Class A table's measured count selects; and
grant-layer denial on `consultation_notes` — the latter by a different
mechanism, not as a fifth default-deny datapoint.
*Cannot prove* the per-policy correctness audit the requirement actually
asks for — reviewing each of the live policies for correct tenant
predicates is Gate 7's scope and is not attempted here.
*Evidence required* Step 5's outputs, plus an explicit statement that
V-03 remains PARTIAL after Gate 3R, with the residue named as Gate 7's.

**N5-02, N5-03, N5-04 — Category B / C / D restriction.**
*In scope only as a reconciliation, not as a measurement.* Gate 2 already
established all three at catalog level (`pg_proc.proacl`) and at runtime
(SQLSTATE `42501`) — 145 Category B, 10 Category C, 24 Category D, all
with `anon`/`authenticated` EXECUTE confirmed absent.
*Proves* nothing new; Gate 3R adds no measurement here.
*Cannot prove* production privilege state.
*Evidence required* a citation of Gate 2's census, plus an explicit
statement that the matrix rows' UNPROVEN status is a **documentation lag**
predating Gate 2. **Gate 3R does not re-measure them merely because a
stale row says UNPROVEN, and does not flip the rows** — updating the
matrix is a Gate 8 register action.
*Note* F16-06's coverage gap concerns the *test suite's* probe coverage,
not the catalog boundary. The boundary is proven; the suite's coverage of
it is not. These must not be conflated in either direction.

**F-03 — `supabase functions serve` starts without import errors.**
*Out of scope because* the literal command in the requirement,
`supabase functions serve`, is a distinct process from the containerized
`supabase_edge_runtime_setura` that Step 1 measures. `deno task check`
passing across the functions is a static proxy only and does not exercise
the Deno edge runtime (`CROSS_PHASE_REQUIREMENTS_MATRIX.md:112`).
*Would prove, if authorized* that the functions load without import
errors under the CLI's own serve path.
*Cannot prove* production function loading.
*Disposition* remains UNPROVEN after Gate 3R. Running the literal command
is not authorized by this specification; requesting it is a separate
authorization.

**Z-03 — API contracts frozen (request/response shapes per endpoint).**
*Out of scope, and specifically **not closed by Step 2**, because* the
requirement asks for a frozen contract, and the matrix records that no such
artifact exists: "No contract-schema artifact, no OpenAPI document, no
response-shape snapshot test found anywhere in the repository. Shapes are
asserted only inside individual integration tests"
(`CROSS_PHASE_REQUIREMENTS_MATRIX.md:152`). Step 2 does change that row's
test-evidence cell, which currently reads "integration suite **not run**" —
but executing tests that assert shapes inline does not freeze a contract.
**Step 2 must not be cited as closing Z-03.**
*Would prove, if authorized* nothing further here — the missing element is
an artifact, not a measurement, so no authorization of a command closes it.
*Cannot prove* that endpoint shapes are frozen, versioned, or
backward-compatible.
*Evidence required* the matrix cell quoted above, plus — if Step 2's result
is recorded against this row at all — an explicit statement that it records
*the suite ran*, not *the contract is frozen*.
*Disposition* remains UNPROVEN after Gate 3R. **Gate 3R does not create the
missing artifact.** Authoring an OpenAPI document, a response-shape
snapshot test, or any equivalent committed contract artifact is remediation,
not verification (`PHASE_1.6_SPEC.md` §1), and is outside this gate (§3.2).
The artifact's absence is an absent measurement, not a product defect; no
finding ID is created for it.

**F-02 — migrations apply cleanly to a fresh database.**
*Excluded because* the only measurement that closes it is `supabase db
reset` against migrations 01→49 on a fresh database
(`CROSS_PHASE_GAP_REGISTER.md:580-587`). That is destructive; PART 6
requires preserving existing database state; PART 12 forbids `db:reset`
absent separate authorization; `CLAUDE.md` §2 and §22 classify it
destructive.
*Disposition* remains UNPROVEN after Gate 3R **by design, not by
omission.** `deno task validate:migrations` (Step 2's read-only baseline)
is a static validator and is not a substitute — its 4 pre-existing
`[duplicate-objects]` warnings are known and are not new findings.

**R-08 — refund concurrent with settlement produces a consistent result.**
*Excluded because* no committed test exercises the interaction, and
authoring one is outside Gate 3R scope. The matrix records a real
concurrency design on one side —
"`create_platform_revenue_summary` (`33:176`) uses `pg_advisory_xact_lock` +
duplicate rejection + row locking" — and then records that its "interaction
with a simultaneous `confirm_refund_processed` is not exercised anywhere",
with test evidence "**no concurrency test exists**"
(`CROSS_PHASE_REQUIREMENTS_MATRIX.md:215`).
*Would prove, if authorized* whether the two paths interleave safely under
genuine concurrency.
*Cannot prove* anything from the present static evidence in either
direction: a locking design being present is not proof that this specific
interleaving is safe, and the absence of a test is not proof that it is
unsafe.
*Evidence required* the matrix cells quoted above, and the exclusion
reason. No new measurement.
*Disposition* remains UNPROVEN after Gate 3R, **by exclusion, not by
measurement.** **Gate 3R does not create a concurrency test.** The existing
locking design must not be cited as evidence of correctness, and the
missing test must not be recorded as a defect or given a finding ID.

**V-07 — DR test: Meta API outage → retry + DLQ.**
*Excluded because* no committed test simulates the outage, and authoring one
is outside Gate 3R scope. The matrix records that "Retry + DLQ logic is
verified present (W-04/W-06); no outage-simulation test exists and the path
has never been executed against a failing provider", with test evidence
"none" (`CROSS_PHASE_REQUIREMENTS_MATRIX.md:334`).
*Would prove, if authorized* whether the retry and dead-letter path actually
executes end-to-end when the provider fails.
*Cannot prove* anything beyond presence. W-04/W-06 establish that the logic
exists — STATICALLY VERIFIED at best — and that level is not
interconvertible with RUNTIME VERIFIED (`PHASE_1.6_SPEC.md` §8.1).
*Evidence required* the matrix cells quoted above, and the exclusion
reason. No new measurement.
*Disposition* remains UNPROVEN after Gate 3R, **by exclusion, not by
measurement.** **Gate 3R does not create such a test.** Presence of the
retry/DLQ logic must not be reported as disaster-recovery verification, and
the missing test must not be recorded as a defect or given a finding ID.

**N1-10 — endpoint reachable by Meta in production.**
*Permanently out of scope.* Production reachability cannot be established
from a local stack under any authorization, because no deployment exists.
*Disposition* UNPROVEN, permanently, from this working tree. Recorded as
a production limitation in Step 7, not as an open local measurement.

### Authorized commands / actions

- Reading the register and matrix.
- Reading Steps 1–5's results.
- Read-only catalog queries needed to reconcile a Gate 2 figure that a
  Step 6 statement depends on.

### Prohibited actions

- `supabase db reset`, or any attempt to satisfy F-02.
- Running `supabase functions serve` (not authorized here).
- Editing `CROSS_PHASE_REQUIREMENTS_MATRIX.md` or
  `CROSS_PHASE_GAP_REGISTER.md`. Register and matrix updates are Gate 8's
  (`PHASE_1.6_SPEC.md` §7.4, §10.1).
- Marking a row PASS that Gate 3R did not itself measure — cite Gate 2
  instead, and say it is a citation.
- Granting or revoking certification on the nine "unverified claims, not
  defects" rows in either direction
  (`CROSS_PHASE_GAP_REGISTER.md:589-591`). Those nine are the rows
  enumerated at `:584`; the register's protection covers exactly them.
- **Granting or revoking certification on Z-03, R-08 or V-07 either.** They
  are outside the register sentence's nine, but they are excluded by this
  step, which is its own sufficient reason to leave them untouched.
- **Creating a finding ID for Z-03, R-08 or V-07 because the artifact or
  test they require does not exist.** A missing artifact or a missing test
  is an absent measurement, not a product defect (PART 11 — a finding
  requires evidence of an actual defect; the same rule that keeps OBS-1 and
  OBS-2 observations, §3.2).
- **Creating the artifact or test that Z-03, R-08 or V-07 would need.** No
  OpenAPI or contract-snapshot artifact, no concurrency test, no
  outage-simulation test. That is remediation and is outside this gate
  (`PHASE_1.6_SPEC.md` §1).
- Citing Step 2's execution as closing Z-03.
- Testing an item merely because it appears in the register.
- Adding requirements to the selection table during execution without
  first updating this specification (§4.3 item 7).

### Expected evidence

- The selection table above, restated with each row's actual outcome.
- For each in-scope row: the four mandatory statements, plus the evidence
  captured.
- For each excluded row: the exclusion reason and the authority for it.
- A proposed Gate 8 action list — which matrix rows and register entries
  need updating, and to what — written as a **proposal**, with no file
  edited.

### Success criteria

PASS requires all of:

1. Every one of the **twelve** UNPROVEN rows dispositioned, none left
   silent. Twelve is the complete universe (see *Inputs*); dispositioning
   nine is not sufficient.
2. Each in-scope row carrying all four mandatory statements.
3. Each excluded row carrying its reason and authority.
4. No matrix or register file modified.
5. No row upgraded on evidence Gate 3R did not produce or properly cite.

### Failure criteria

- **FAIL** — a row is dispositioned without one of the four statements, or
  a disposition is unsupported by evidence.
- **BLOCKED** — Steps 1–5 produced insufficient evidence to disposition an
  in-scope row. That row is then recorded BLOCKED individually; it does
  not block the step.

### Deliverable location

`PHASE_1.6_GATE_3R_REPORT.md` §6 — "Cross-phase runtime verification",
with the disposition table as §6.1 and the proposed Gate 8 action list as
§6.2.

---

## STEP 7 — ENVIRONMENT LIMITATION CLASSIFICATION

### Objective

Classify the environment conditions and production limitations that bound
every other Gate 3R result, so that no environment condition is mistaken
for a product defect and no product defect is excused as an environment
condition. Target level: classification, not measurement.

**Mandatory deliverable.** Step 7 must be delivered even if Steps 1–6 are
wholly BLOCKED (§4.5). A blocked gate still owes an accurate account of
what blocked it.

### Inputs

- F16-01 — `PHASE_1.6_FINDINGS_LOG.md:43-86`.
- F16-02 — `:87-109`.
- F16-03 — `:111-128`.
- `PHASE_1.6_SPEC.md` §14 — the blocker baseline, including the
  not-a-Git-repository condition.
- Steps 1–6's observed states.

### Required classifications

**F16-01 — Edge Runtime `RestartPolicy=no`.**
*Class* environment / tooling. Supabase CLI container-creation behaviour.
**Not a SETURA product defect.**
*State to record* whether it recurred during Gate 3R; whether Edge Runtime
was started as an environment action; whether it exited during the run;
the `RestartPolicy` value as found, with peer contrast.
*Bounding effect* the three Edge-dependent files' results are attributable
to it when the runtime is down.
*Prohibited* reporting a `docker start` as a fix; changing the policy;
reporting the platform's own `Missing authorization header` log line as an
application fault.

**F16-02 — no local secrets.**
*Class* environment. DEFERRED to Gate 4.
*State to record* the `.env*` listing as found; whether any Gate 3R test
actually required a secret; the outcome of the 403 worker-secret case,
which depends on the secret's absence.
*Prohibited* creating any secret file; converting a Gate 4 deferral into
Gate 3R work. If execution shows a secret genuinely required, §4.4's
stop-and-report procedure applies.

**F16-03 — Vector crash-loop.**
*Class* environment, external to SETURA. Root cause is Vector's inability
to reach the Docker socket on this Windows host (`code: 101, kind:
NetworkUnreachable`). Vector ships logs to Logflare/analytics only. **Not
a SETURA defect.** No Gate 3R step depends on it.
*State to record* current `RestartCount` and health, for continuity with
Gate 3's observation.
*Prohibited* reading Vector's unhealthy state as a stack-wide failure;
attempting to repair it.

**Production verification limitations.**
*Class* structural, permanent from this working tree.
*To record explicitly* no deployment exists, therefore: production
privilege state is UNPROVEN; production scheduling is UNPROVEN and is
additionally a design decision (P0-02 / NPD-05, no scheduler has ever been
created — `pg_cron` present but `installed_version` NULL, zero `pg_net`
scheduling calls, no external scheduler configuration); production
endpoint reachability (N1-10) is UNPROVEN; production secret provisioning
is outside Phase 1.6 entirely. The working tree is not a Git repository,
so CI reachability is **provably unmeasurable**, not merely unknown.
*Prohibited* converting any local Gate 3R PASS into a production claim.

**Product findings that Gate 3R measures but does not repair.**
Restate, with PROPOSED severities and no remediation: P0-01
(`claim_jobs_v2` omits `lease_expires_at`, so crash recovery cannot
reclaim v2-claimed jobs), P0-02, P0-03, P0-04, F16-04, F16-05, F16-06,
F16-07. Worker baseline for continuity: 157 pending jobs, zero claimed,
zero worker IDs, zero lease timestamps, zero registry rows, zero
heartbeats, zero worker-lease rows, zero dead-letter rows — enqueueing
proven, execution not.

### Authorized commands / actions

- `docker inspect` / `docker ps -a` re-reads for current state.
- `ls .env*`, `ls supabase/functions/.env*`.
- Reading Steps 1–6's results.

### Prohibited actions

- **Converting environment recovery into product remediation** (PART 4
  Step 7). This is the step's central prohibition.
- Changing any container configuration.
- Creating secrets.
- Repairing Vector.
- Assigning final severity (Gate 8).
- Escalating or de-escalating F16-01 without recurrence evidence.
  `PHASE_1.6_FINDINGS_LOG.md:82-83` notes escalation may be warranted if
  it recurs and blocks runtime proof of P0-02 or P0-03 — that is a Gate 8
  judgement informed by Gate 3R's record, not a Gate 3R decision.

### Expected evidence

- One classification block per item above, each stating: class, state as
  found, bounding effect on Gate 3R's results, and disposition
  (OPEN / DEFERRED / NOT REMEDIATED, with PROPOSED severity where one
  exists).
- An explicit attribution ledger: every Gate 3R failure or BLOCKED
  result, mapped to the condition responsible.
- An explicit "not proven by Gate 3R" list.

### Success criteria

PASS requires all of:

1. F16-01, F16-02, F16-03 and the production limitations each classified.
2. Every Gate 3R failure or BLOCKED result attributed to a named
   condition.
3. No environment condition reported as a product defect, and no product
   defect excused as environmental.
4. No severity assigned beyond PROPOSED.
5. The step delivered regardless of Steps 1–6's outcomes.

### Failure criteria

- **FAIL** — an attribution is missing, or a classification contradicts
  the evidence.
- **BLOCKED** cannot apply. The step's inputs are prior records and
  static artifacts; it is always deliverable.

### Deliverable location

`PHASE_1.6_GATE_3R_REPORT.md` §7 — "Environment limitation
classification", with the attribution ledger as §7.1 and the
"not proven by Gate 3R" list as §7.2.

---

## 5. GATE 3R CERTIFICATION CRITERIA

### 5.1 Per-step certification

Each step is certified independently as PASS / FAIL / BLOCKED / PARTIAL,
against its own success and failure criteria. No step's certification may
rest on another step's evidence (§4.6).

### 5.2 Gate-level certification

Gate 3R's gate-level status is exactly one of **PASS · PARTIAL · BLOCKED ·
FAIL**. §5.1's per-step statuses and this gate-level status are distinct
scales: a step's PARTIAL does not by itself set the gate's status, and the
gate's status is derived by the rules below.

All four statuses describe the **integrity of the Gate 3R verification
record**. None of them describes the health of the product (§5.2.6).

#### 5.2.1 Record-integrity conditions

These nine conditions govern whether the record is *sound*. They are
referenced by every status below.

1. All seven steps were executed against this persisted specification,
   unmodified — or modified only with the modification recorded as a
   change before the changed work proceeded (`PHASE_1.6_SPEC.md` §12.2
   rule 5).
2. Every step reached a status defined in §5.1, and every BLOCKED or
   PARTIAL step has its blocker or its boundary recorded exactly and its
   shape characterized.
3. `PHASE_1.6_GATE_3R_REPORT.md` exists and contains all seven step
   sections plus the §13.1 report structure required by
   `PHASE_1.6_SPEC.md`.
4. Every numeric claim carries a citation.
5. Every failure carries a §4.2 classification with evidence.
6. No claim exceeds its evidence's verification level
   (`PHASE_1.6_SPEC.md` §8.1).
7. No production claim appears anywhere.
8. No severity beyond PROPOSED appears anywhere.
9. No source file, migration, test, privilege, RLS policy or container
   configuration was modified.

#### 5.2.2 PASS

The Gate 3R evidence record is complete and sound for all seven steps,
with every required measurement either completed successfully or handled
through a **permitted BLOCKED** condition as defined by the closed list
below — one that does not make the record unsound.

Requires: all nine §5.2.1 conditions hold, and every step reached PASS or
reached a permitted BLOCKED whose blocker is recorded exactly.

##### Permitted BLOCKED conditions — closed list

"Permitted BLOCKED" means exactly and only what this table permits. **This
is a closed list. A BLOCKED condition not enumerated here as permitted is
not permitted, and the gate cannot PASS with it.** There is no general rule
that a recorded blocker is an acceptable one; recording a blocker
accurately keeps the *record* sound (§5.2.1 condition 2), which is a
separate question from whether the gate may PASS.

| Step | May a BLOCKED here coexist with a Gate 3R PASS? | Gate-level consequence if this step is BLOCKED |
|---|---|---|
| Step 1 — environment / runtime readiness | **NO** | Gate 3R **BLOCKED**. Step 1 is Step 2's precondition (§4.5); if the stack's state cannot be established, nothing downstream is attributable. |
| Step 2 — full integration suite | **NO — no exception** | Gate 3R **BLOCKED**. See the invariant below. |
| Step 3 — Edge-dependent files | **YES**, and only for the already-defined F16-01 Edge/environment condition, subject to the four conditions below | Gate 3R may still PASS, carrying the qualification required by §5.3. |
| Step 4 — security / privilege regression | **NO** | Step 4's own *Failure criteria* already define an unobtainable-per-case-code BLOCKED as "an acceptable outcome" for the step; at gate level that is an incomplete required measurement in a sound record, i.e. **PARTIAL** (§5.2.3), not PASS. |
| Step 5 — runtime RLS / default-deny | **NO** | Gate 3R **BLOCKED**. A BLOCKED sub-measurement on one Class A table likewise leaves a required measurement incomplete — at gate level **PARTIAL** if the rest of Step 5 executed, never PASS. |
| Step 6 — remaining cross-phase verification | **NO** | Step 6's own *Failure criteria* record an individually-BLOCKED row without blocking the step; a Step 6 BLOCKED as a whole is an incomplete required measurement, i.e. **PARTIAL**. |
| Step 7 — environment limitation classification | **not applicable** | Step 7 is mandatory in every run including a fully-blocked one (§4.5, §5.2.4). It has no permitted BLOCKED; non-delivery is a §5.2.1 condition 3 failure and therefore **FAIL**. |

**The four conditions on a permitted Step 3 BLOCKED.** All four must hold,
or the BLOCKED is not permitted:

1. The blocker is F16-01, the already-defined Edge/environment condition,
   and it is **explicitly recorded** with the evidence Step 1 requires —
   `State.Status`, `State.ExitCode`, `FinishedAt`,
   `HostConfig.RestartPolicy.Name` — not asserted.
2. Step 3's remaining evidence obligations are **accurately recorded**,
   including which of the three Edge-dependent files did and did not
   execute (§4.1 rule 3 — *partial ≠ whole*).
3. **No product failure is inferred from the environment condition.** A
   failure in an Edge-dependent file while Edge Runtime is down is
   attributed to F16-01 and is not recorded as a product defect (§4.2).
4. **No false product certification is created.** The report states, at
   every point where the Edge-dependent path's status appears, that the
   path was **not** runtime-verified; and §5.3's PASS statement carries the
   corresponding qualification. F16-01's severity remains PROPOSED and its
   disposition remains Gate 8's (§3.2).

**The invariant: NO GATE 3R PASS IF STEP 2 IS BLOCKED.**

Step 2 is the full integration-suite measurement. If Step 2 is BLOCKED the
required integration measurement did not meaningfully execute, and three
things follow, each independently sufficient:

- Steps 3, 4 and 5 consume Step 2's execution rather than re-running the
  suite (§4.5), so their evidence base is absent too.
- §5.3's statement of what a PASS means — "the local integration suite was
  executed in full" — would be false, and a PASS may never assert work that
  did not execute.
- The gate's own scope (§2) would be unmeasured.

Therefore: **Step 2 BLOCKED → Gate 3R BLOCKED.** No exception, no
qualification, and no combination of other steps' PASSes overrides it.

#### 5.2.3 PARTIAL

At least one required measurement was executed and produced valid
evidence, but one or more required measurements could not be completed.
The resulting record remains sound, bounded, and accurately classified.

Requires: all nine §5.2.1 conditions hold; at least one step produced
valid evidence; and every incomplete measurement is recorded as
incomplete, with its boundary stated explicitly (§4.1 rule 3 — *partial ≠
whole*).

**PARTIAL must not be treated as FAIL.** It is a sound record of an
incomplete measurement. It must equally not be reported, summarized or
carried forward as PASS.

#### 5.2.4 BLOCKED

A prerequisite environment or tooling condition prevents meaningful
execution of the required measurement scope. The blocker and its exact
shape are recorded.

**A blocked gate is not a product FAIL and is not a governance-record
FAIL.** A blocked gate still delivers Step 7 (§Step 7 — mandatory
regardless of Steps 1–6) and still delivers an accurate partial record.

#### 5.2.5 FAIL

The Gate 3R record itself is unsound, or violates the evidence and
governance rules persisted in this specification. Any one of the
following is sufficient:

- an unclassified failure (§4.2);
- an uncited number (§4.1 rule 8);
- a partial result aggregated into a total (§4.1 rule 3);
- a status-only privilege claim (§4.1 rule 1);
- a modified test (§5.2.1 condition 9, PART 12);
- contradictory or unsupported evidence;
- any other direct violation of the persisted Gate 3R evidence rules.

A failure of any §5.2.1 condition is also a FAIL. The bullets above are
the specific named forms; §5.2.1 is the general test. Where several apply,
FAIL is recorded once, with every contributing cause named.

**A step reaching FAIL does not by itself make the gate FAIL.** A step FAIL
that is accurately measured, classified and recorded is a *sound record* of
a failure — §5.2.1 condition 2 is satisfied by it. The gate FAILs when the
*record* is defective, not when the thing measured is.

#### 5.2.6 Precedence, and what these statuses are not

Precedence, highest first: **FAIL** (record unsound — overrides every
other status, including a gate that would otherwise be BLOCKED) →
**BLOCKED** (record sound, but the environment prevented meaningful
execution of the required scope) → **PARTIAL** (record sound, some
required measurements complete, others not) → **PASS**.

**A Step 2 BLOCKED fixes the gate at BLOCKED**, per the invariant in
§5.2.2, unless the record is also unsound — in which case FAIL takes
precedence, as above. A Step 2 BLOCKED can never resolve to PARTIAL or
PASS, however many other steps PASSed.

**A product or test failure does not automatically make Gate 3R FAIL.**
Gate 3R FAIL is specifically about the integrity of the Gate 3R
verification record. A suite that executes completely and reports
failures, each classified under §4.2 with evidence, is a *sound record* —
its gate-level contribution is PASS even though the product outcome
contains failures (§Step 2 — measurement status vs product outcome).

### 5.3 What a Gate 3R PASS does and does not mean

**A PASS is only available at all if Step 2 actually executed the full
required suite.** If Step 2 is BLOCKED, Gate 3R is BLOCKED (§5.2.2
invariant, §5.2.6) and none of the statements below may be made. In
particular, **nothing in this section may be read as implying that the
integration suite executed, in any run where Step 2 did not execute it.**

**A PASS means** — each clause holding only because the corresponding step
actually executed and produced the evidence its criteria require:

- the local integration suite was executed in full, and its results are
  accurately recorded and correctly attributed — a statement about the
  measurement, not about the tests' outcome (§Step 2, axis 1 vs axis 2).
  This clause is available only where Step 2 reached PASS; it is
  unavailable, and must not be paraphrased into the record, where Step 2 was
  BLOCKED — and where Step 2 was BLOCKED there is no PASS to qualify;
- the security regression suite's exact result is known, with its per-case
  codes captured — **or their unavailability recorded as a limitation and
  F16-05's determination left UNPROVEN** (§Step 4 *Failure criteria*), never
  dressed up as resolution;
- the five fixed-scope tables' applicable-policy counts were measured
  first-hand, and each Class A table's result is recorded on the branch its
  measured count selected: **Branch A** — runtime default-deny demonstrated
  at plan level; or **Branch B** — policy posture recorded as differing from
  the carried-forward premise, which is a measurement result and not a
  defect (§Step 5). `consultation_notes` is separately documented as the
  grant-layer contrast case;
- all twelve UNPROVEN cross-phase rows are dispositioned (§Step 6);
- and the environment's limitations are classified (§Step 7).

**Qualifications a PASS may carry.** A PASS is not necessarily unqualified.
Where §5.2.2's closed list permitted a BLOCKED — the F16-01 Step 3 case is
the only one it permits — the PASS carries that qualification explicitly at
every point the affected path's status appears, and the affected path is
stated as **not runtime-verified**. A qualified PASS is a sound record of a
bounded measurement; it is never reported, summarized or carried forward as
an unqualified one.

**A PASS does not mean:** the product is production ready; the test suite
is adequate (F16-05 and F16-06 remain open); the privilege boundary is
production-verified; migrations apply cleanly to a fresh database (F-02
excluded); a scheduler exists (P0-02); the worker executes jobs (P0-01,
P0-03); `booking_fee_inr` has a writer (P0-04); F16-04's privilege
discipline gap is closed; or historical Gate 3 is certified — it never
will be (`PHASE_1.6_SPEC.md` §5.4).

**A PASS certifies a measurement, not a product.**

### 5.4 What Gate 3R explicitly leaves open

| Item | State after a Gate 3R PASS | Owner |
|---|---|---|
| F-02 (fresh-database migration apply) | UNPROVEN — `db:reset` excluded | separate authorization |
| F-03 (`supabase functions serve`) | UNPROVEN — command not authorized | separate authorization |
| N1-10 (production reachability) | UNPROVEN — permanently local-infeasible | production phase |
| Z-03 (frozen API contract artifact) | UNPROVEN — no artifact exists; not closed by Step 2; Gate 3R does not create one | remediation phase |
| R-08 (refund/settlement concurrency) | UNPROVEN — no committed concurrency test; not locally closable | remediation phase |
| V-07 (Meta outage → retry + DLQ DR test) | UNPROVEN — no committed outage-simulation test; not locally closable | remediation phase |
| V-03 (per-policy audit) | PARTIAL — count, 4-table default-deny, 1-table grant-layer contrast only | Gate 7 |
| OBS-1, OBS-2 | observations, not findings | Gate 7 |
| F16-02 (local secrets) | DEFERRED | Gate 4 |
| P0-02 / P0-03 runtime proof | not attempted | Gate 5 |
| Gate 6 | UNDEFINED — no evidence of scope | project lead |
| All severities, matrix and register updates | PROPOSED / un-updated | Gate 8 |
| F16-05, F16-06 remediation | measured, not repaired | remediation phase |

## 6. DELIVERABLES

| Artifact | Status |
|---|---|
| `PHASE_1.6_GATE_3R_SPEC.md` | this file — persisted |
| `PHASE_1.6_GATE_3R_REPORT.md` | **not created** — Gate 3R has not executed |

No other file is created or modified by Gate 3R. In particular: no
historical report is rewritten (`PHASE_1.6_SPEC.md` §10.1), no matrix or
register is updated (Gate 8), and `CLAUDE.md` is not touched.

## 7. EXECUTION AUTHORIZATION STATE

| Prerequisite | State |
|---|---|
| `PHASE_1.6_SPEC.md` persisted | YES |
| `PHASE_1.6_GATE_3R_SPEC.md` persisted | YES — this file |
| Historical Gate 3 frozen and recorded | YES — `PHASE_1.6_RUNTIME_TEST_REPORT.md` |
| All seven steps specified against the eight-field template | YES |
| Step list and certification criteria presented to the project lead | YES — presented, reviewed, and authorized 2026-08-23 |
| Governance review completed | YES — verdict NOT READY — REQUIRES GOVERNANCE CORRECTION, 2026-08-23 |
| Governance corrections applied | YES — Amendment 1 (§8), 2026-08-23, R-1 … R-4 |
| Governance re-verification | YES — verdict READY FOR PROJECT-LEAD EXECUTION AUTHORIZATION, 2026-08-23 |
| Project-lead execution go-ahead | **AUTHORIZED** |
| Gate 3R execution authorization | **AUTHORIZED** |
| Authorization date | **2026-08-23** |
| Authorization record | Amendment 2, §8 |
| **Gate 3R execution begun** | **YES — Step 1, 2026-08-23** |

### Authorization scope

**Execute Gate 3R Steps 1–7 exactly according to the current
`PHASE_1.6_GATE_3R_SPEC.md`. No scope expansion is authorized.**

The authorization is bounded to executing this specification as written,
post-Amendment 1. It does not authorize: application remediation; SQL
migration changes; RLS policy changes; GRANT/REVOKE changes; test
modifications; scheduler implementation; worker architecture changes;
production testing; production deployment; severity assignment outside
Gate 8; creation of new finding IDs except where a step explicitly permits
it and the evidence meets that step's rules; or any change to historical
Gate 3's status, which remains **PARTIALLY COMPLETE — NOT CERTIFIED**
(§1).

### Authorization history

Per PART 14 of the Option C authorization, the specifications were to be
persisted and verified, and the step list and certification criteria
presented, **before** any Gate 3R execution — with an explicit instruction
to stop before running the full integration suite in that same turn. That
boundary was observed: at the time this file was first persisted, and
throughout Amendment 1, Gate 3R execution had not started.

**Amendment 1 was not an execution authorization.** Applying the
governance corrections was authorized as specification correction only,
and at the close of Amendment 1 the execution authorization was recorded
as **PENDING**. That record stands as historically accurate.

The authorization was granted separately and subsequently, by explicit
project-lead go-ahead on 2026-08-23, following the governance
re-verification. It is recorded as **Amendment 2** in §8. Amendment 2
changes the authorization state only; it changes no requirement, no step,
no criterion and no finding.

---

## 8. CHANGE-CONTROL HISTORY

This section records corrections made to this specification after it was
first persisted. It exists so that the corrections are visible as
corrections. **The original defects are not erased and are not presented as
though they never existed** (`PHASE_1.6_SPEC.md` §10.1, §12.2 rule 5).

### Amendment 1 — 2026-08-23 — governance-review corrections R-1 … R-4

**Trigger.** An independent governance/readiness review of this file
returned **NOT READY — REQUIRES GOVERNANCE CORRECTION**, identifying four
governance/evidence-discipline defects (D-1 … D-4) and one non-blocking
auditability caveat (D-5). The review required corrections R-1 … R-4. The
project lead adopted that review as the correction authority and authorized
**specification correction only** — explicitly not Gate 3R execution.

**Scope of this amendment.** Governance and evidence discipline. It changes
what the specification *requires of an executor*. It changes no gate
numbering, no certification philosophy, no finding severity, no historical
evidence, no runtime configuration, and no code, SQL, test, RLS policy or
grant. No new finding was created.

| Correction | Defect addressed | Affected sections | Correction applied | Reason | Date | Status |
|---|---|---|---|---|---|---|
| **R-1** | **D-1** — Step 6 represented the UNPROVEN universe as nine rows; `CROSS_PHASE_REQUIREMENTS_MATRIX.md` contains twelve. Z-03, R-08 and V-07 were neither dispositioned nor named as excluded, contradicting Step 6's own Objective and success criterion 1. | Step 6 *Objective*, *Inputs*, *Selection table*, *Per-requirement specification*, *Prohibited actions*, *Success criteria* item 1; §5.4; and `PHASE_1.6_SPEC.md` §11.3 | The universe is stated as **twelve** throughout, with all twelve rows line-cited and corroborated by the matrix's per-set tallies. Z-03 added as **OUT OF SCOPE / NOT CLOSED BY STEP 2**; R-08 and V-07 added as **EXCLUDED — NOT LOCALLY CLOSABLE**; each with the four mandatory statements, an explicit prohibition on creating the artifact or test it would need, and an explicit prohibition on creating a finding ID for its absence. The register's "nine of the twelve" sentence is explained as naming a subset that presupposes twelve, not as defining the universe. Success criterion 1 now requires twelve. Three rows added to §5.4. | A gate that claims to disposition the UNPROVEN universe must disposition the actual universe. Nine of twelve is a silent exclusion of three rows, and Step 6's own criterion forbids leaving a row silent. | 2026-08-23 | **APPLIED** |
| **R-2** | **D-2** — Step 5 presupposed zero applicable policies on the four Class A tables before measuring the live catalog. The cited migrations prove `ENABLE`/`FORCE` only. This created a **false-FAIL** path (a table with a genuine policy correctly lacks `One-Time Filter: false` → FAIL → a spurious finding) and a **false-PASS** path (the undefined "where technically applicable" escape, with row counts prohibited and no alternative defined). | Step 5 *Objective*, *Fixed scope* (+ new *Measurement order*), *Authorized commands / actions*, *Prohibited actions*, *Expected evidence*, *Success criteria*, *Failure criteria*; §4.3 item 6; Step 1 *Authorized commands / actions* and *Prohibited actions* | Zero-policy status relabelled a **carried-forward premise**, with a per-table column saying so and a paragraph stating that RLS enabled/forced does not prove zero policies. A mandatory four-step **measure → record → branch → apply** order added. **Branch A** (measured 0) requires `One-Time Filter: false`; **Branch B** (measured > 0) is classified **POLICY POSTURE DIFFERS FROM CARRIED-FORWARD PREMISE**, explicitly not a product FAIL, not drift, not proof either way about RLS, and explicitly **not** permission to create a finding ID — mirroring the treatment of the unattested 139 figure. "Where technically applicable" **removed** at both occurrences and replaced by the branch logic plus a defined BLOCKED sub-measurement; declaring the evidence "technically inapplicable" is now prohibited, and row counts remain prohibited as a substitute. FAIL narrowed to Branch A only. §4.3 item 6 extended so Branch B does not spuriously halt the gate. The `pg_policies` count **removed** from Step 1's authorized actions and prohibited there, resolving the Step 1 / Step 5 duplicate-measurement hazard in favour of Step 5 as the single authoritative measurement point (§4.6). | Measurement must precede the criterion that depends on it. A specification that presupposes its own result can convert correct product behaviour into a recorded defect, and can equally let an executor escape the required evidence by declaring it inapplicable. | 2026-08-23 | **APPLIED** |
| **R-3** | **D-3** — §5.2.2 conditioned a gate PASS on "an explicitly permitted BLOCKED condition" and "a permitted BLOCKED", but no permitted condition was defined anywhere in the file. As written it admitted a gate PASS with Step 2 BLOCKED, while §5.3 asserted that a PASS means the suite "was executed in full". | §5.2.2 (new *Permitted BLOCKED conditions — closed list*), §5.2.6, §5.3 | §5.2.2 now carries a **closed list**: per step, whether a BLOCKED there may coexist with a gate PASS, and the gate-level consequence if it does not. **Step 2 BLOCKED → Gate 3R BLOCKED, no exception**, stated as a named invariant with its three independent reasons. Step 3 BLOCKED is the **only** permitted case, restricted to the already-defined F16-01 condition and subject to four stated conditions. All other steps: not permitted; Step 7 has no permitted BLOCKED at all. §5.2.6 states that a Step 2 BLOCKED fixes the gate at BLOCKED unless the record is also unsound. §5.3 rewritten so the "executed in full" clause is available only where Step 2 reached PASS, with an explicit rule that nothing in the section may be read as implying execution that did not occur, plus a *Qualifications a PASS may carry* paragraph. | An undefined permission is an open permission. A PASS must never be able to assert work that did not execute, and the closed list makes the misreading structurally unavailable rather than merely discouraged. | 2026-08-23 | **APPLIED** |
| **R-4** | **D-4** — Step 4's *Authorized commands / actions* said "**Both** results are recorded — the isolated 22/22 and the in-suite result", presupposing the value of a measurement not yet taken. This reproduces the error class of contradiction C-1 (`PHASE_1.6_SPEC.md` §10.2). | Step 4 *Authorized commands / actions* | Replaced with "the isolated run's result, whatever its value, and the in-suite result", plus an explicit statement that this specification does not presuppose any particular value for the isolated run's result, and that the 22 passed / 0 failed figure under *Inputs* is historical Gate 3's carried-forward measurement rather than an expected outcome. **22 remains the canonical case count and the prohibition on reporting 34 is unchanged.** | A specification must not name the result it expects to measure. 22/22 is one possible measured outcome, not a target. | 2026-08-23 | **APPLIED** |

**Non-blocking item recorded, not corrected.** The review's **D-5** observed
that this file's "PART N" citations are ambiguous, because
`CROSS_PHASE_AUDIT_REPORT.md` carries its own PART 11 (`:837`), PART 12
(`:927`) and PART 14 (`:1055`) with different content, and because the
Option C authorization those citations refer to is not persisted as a
repository artifact — it exists in the authorizing conversation only, which
by GOV-01 (`PHASE_1.6_SPEC.md` §15.1) is not an artifact. D-5 is recorded
here as a **non-blocking auditability caveat** and is deliberately **not**
corrected by a broad rewrite (minimal-change principle). Two things bound
it: every substantive prohibition the PART citations carry is also stated in
full in this persisted file, so no requirement depends on resolving a
citation; and Document control now states the disambiguation rule
explicitly. **No new authorization document was created, and no claim is
made that one exists.**

**What this amendment did not change.** Historical Gate 3 remains
**PARTIALLY COMPLETE — NOT CERTIFIED** (§1). Gate 8 remains the sole
authority for final severity assignment (§3.2). Every severity remains
**PROPOSED**. Gate numbering is unchanged (1–7, §1.2). §4.1's eight evidence
rules, §4.2's five failure classes, §4.4's secret-handling procedure, and
Steps 2, 3 and 7 are unchanged. No finding was created, retired or
re-severitied. `CROSS_PHASE_REQUIREMENTS_MATRIX.md` and
`CROSS_PHASE_GAP_REGISTER.md` were **not** modified — they are the source
artifacts being reconciled, and updating them is Gate 8's action.
**Gate 3R execution state is unchanged: NOT STARTED.**

### Amendment 2 — 2026-08-23 — project-lead execution authorization

**Trigger.** The governance re-verification of this file, following
Amendment 1, returned **READY FOR PROJECT-LEAD EXECUTION AUTHORIZATION**.
The project lead then gave an explicit execution go-ahead.

**Scope of this amendment.** Authorization state only. It records that the
go-ahead was given, on what date, and over what scope. **It changes no
requirement, no step, no objective, no input, no authorized or prohibited
action, no expected evidence, no success or failure criterion, no
certification rule, no finding, and no severity.** No code, SQL, test, RLS
policy, grant, migration or container configuration was changed to produce
it.

| Field | Value |
|---|---|
| Amendment | 2 |
| Type | Execution authorization — no specification content changed |
| Project-lead execution go-ahead | **AUTHORIZED** |
| Gate 3R execution authorization | **AUTHORIZED** |
| Authorization date | **2026-08-23** |
| Authorization scope | Execute Gate 3R Steps 1–7 exactly according to the current `PHASE_1.6_GATE_3R_SPEC.md`. **No scope expansion is authorized.** |
| Specification version authorized | this file as at Amendment 1 (governance corrections R-1 … R-4 applied) |
| Affected sections | §7 (authorization state, scope, history); this §8 entry; Document control |
| Reason | Governance re-verification returned READY FOR PROJECT-LEAD EXECUTION AUTHORIZATION; the project lead exercised that authority explicitly. |
| Status | **APPLIED** |

**Prohibitions restated by the authorization.** The go-ahead explicitly
carried forward, as still prohibited unless this specification expressly
permits them: application remediation; SQL migration changes; RLS policy
changes; GRANT/REVOKE changes; test modifications; scheduler
implementation; worker architecture changes; production testing;
production deployment; severity assignment outside Gate 8; creation of new
finding IDs absent explicit specification permission and conforming
evidence; treating environment defects as product defects or the converse;
converting UNPROVEN into VERIFIED without the required evidence;
converting PARTIAL into PASS; converting BLOCKED into PASS except under
the exact closed list in §5.2.2; and claiming production verification from
local evidence.

**What this amendment did not change.** Historical Gate 3 remains
**PARTIALLY COMPLETE — NOT CERTIFIED** (§1) — the authorization
explicitly instructed that it not be rewritten. Gate 8 remains the sole
authority for final severity assignment (§3.2). Every severity remains
**PROPOSED**. Gate numbering is unchanged (1–7, §1.2). Amendment 1's
corrections R-1 … R-4 stand as applied and are not revisited. The
UNPROVEN universe remains **twelve** rows (Step 6). Step 5's
measure-first order and Branch A / Branch B logic are unchanged. Step 4's
canonical case count remains **22, never 34**, and remains not
presupposed. §5.2.2's closed list, including **Step 2 BLOCKED → Gate 3R
BLOCKED**, is unchanged. `CROSS_PHASE_REQUIREMENTS_MATRIX.md` and
`CROSS_PHASE_GAP_REGISTER.md` were **not** modified.

**Authorization is not a result.** This amendment records permission to
execute. It records no measurement, asserts no step outcome, and does not
imply that any Gate 3R step will PASS. Gate 3R's verdict is determined
solely by §5's certification criteria applied to evidence actually
captured during execution.

---

## Document control

| Property | Value |
|---|---|
| Gate | 3R — Runtime & Integration Verification Successor |
| Authority | Project-lead Option C authorization, 2026-08-23, PARTS 2–7 and 11–14 |
| "PART N" citations | Throughout this file, "PART N" always means a PART of the Phase 1.6 Gate 3R Option C authorization above — never a PART of `CROSS_PHASE_AUDIT_REPORT.md`, which numbers its own PARTs differently. That authorization is not persisted as a repository artifact; see §8's D-5 caveat. |
| Reconstruction claim | **NONE** — explicitly not a reconstruction of historical Gate 3 |
| Step numbering | 1–7, unrelated to historical Gate 3's 0–8 |
| Outranked by | `CLAUDE.md`, then `PHASE_1.6_SPEC.md` |
| Amendments | Amendment 1 — 2026-08-23 — governance corrections R-1 … R-4 (§8); Amendment 2 — 2026-08-23 — project-lead execution authorization (§8) |
| Execution state | IN EXECUTION — began at Step 1, 2026-08-23 |
| Execution authorization | **AUTHORIZED** — project lead, 2026-08-23, Steps 1–7, no scope expansion (§7, §8 Amendment 2) |
| Files modified to produce it | none |
| Files modified by Amendment 1 | this file; `PHASE_1.6_SPEC.md` §11.3 |
| Files modified by Amendment 2 | this file only |
| Product state changed | none |
