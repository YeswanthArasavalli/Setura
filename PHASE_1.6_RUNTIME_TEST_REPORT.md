# PHASE 1.6 — GATE 3 RUNTIME TEST REPORT

## Historical Gate 3 — Closure Record (FROZEN)

> # PARTIALLY COMPLETE — NOT CERTIFIED

**Document status.** FROZEN. This record is closed. It is not
provisional, not pending further work, and not upgradeable.

**Created.** 2026-08-23, under the project-lead decision authorizing
Option C of the Gate 3 closure decision analysis (PART 1: "Freeze
historical Gate 3 exactly as evidenced").

**What this file is.** The closure record for historical Phase 1.6
Gate 3, and Gate 3's deliverable. `CLAUDE.md` §17 already referenced
`PHASE_1.6_RUNTIME_TEST_REPORT.md` as "Gate 3, once complete"; this file
resolves that reference rather than creating a second competing artifact.

**What this file is not.** It is not a reconstruction of Gate 3's lost
step definitions. It is not the Gate 3R specification
(`PHASE_1.6_GATE_3R_SPEC.md`). It is not the phase governance
specification (`PHASE_1.6_SPEC.md`). It contains no new measurement — every
value in it is cited to an artifact that already existed, or is recorded as
not persisted.

**Authority.** It is a documentation write. No source file, migration,
test, privilege, RLS policy, configuration, database row, container or
prior deliverable was modified to produce it. In particular
`PHASE_1.6_FINDINGS_LOG.md` was read and cited, not edited.

---

## 1. FROZEN STATUS

**Historical Gate 3 status: PARTIALLY COMPLETE — NOT CERTIFIED.**

Gate 3 was executed against a nine-step specification (Steps 0–8) that was
never written to any repository file. The specification existed only in
conversation context; that context was compacted; the objectives of four
of its nine steps were destroyed. The findings Gate 3 produced survived,
because a durability snapshot was authorized mid-gate
(`PHASE_1.6_FINDINGS_LOG.md`). The specification that produced them did
not.

Under `PHASE_1.6_SPEC.md` §9 rule 2 — a gate certifies only if every one
of its steps has a persisted definition and a recorded result — Gate 3
cannot certify. Its five completed steps produced real, sound evidence;
that evidence is unaffected by the loss. What is impossible is a claim of
gate completeness.

The governance defect is recorded as **GOV-01**, defined at
`PHASE_1.6_SPEC.md` §12.1, at **PROPOSED** severity. Final severity and
formal register allocation are Gate 8 actions.

## 2. STEP-LEVEL RECORD

| Step | Status | Attestation in persisted artifacts |
|---|---|---|
| Step 0 | **COMPLETE** | `PHASE_1.6_FINDINGS_LOG.md:9` — self-identifies as "Step 0 of the Gate 3 resumption instruction" |
| Step 1 | **COMPLETE** | named at `PHASE_1.6_FINDINGS_LOG.md:84` — "recovery and endpoint confirmation" |
| Step 2 | **COMPLETE** | named at `PHASE_1.6_FINDINGS_LOG.md:256` — the live `pg_policies` count |
| Step 3 | **UNRECOVERABLE** | never named in any persisted artifact |
| Step 4 | **COMPLETE** | named at `PHASE_1.6_FINDINGS_LOG.md:187` and `:229` — privilege-suite execution |
| Step 5 | **UNRECOVERABLE** | never named in any persisted artifact |
| Step 6 | **UNRECOVERABLE** | never named in any persisted artifact |
| Step 7 | **COMPLETE** | named at `PHASE_1.6_FINDINGS_LOG.md:84` — "post-test recheck" |
| Step 8 | **UNRECOVERABLE** | never named in any persisted artifact |

**Method by which unrecoverability was established.** Every root markdown
file was searched for Gate 3 step references. Matches exist only for
Steps 0, 1, 2, 4 and 7, all within `PHASE_1.6_FINDINGS_LOG.md` at the
lines cited above. Steps 3, 5, 6 and 8 produce no match anywhere in the
repository. Separately, `PHASE_1.6_FINDINGS_LOG.md:13-14` states the Gate 3
report was "still unwritten pending Steps 1-8" — proving a nine-step list
existed and was being tracked, which is why the four missing definitions
are recorded as lost rather than as never having existed.

## 3. UNRECOVERABILITY STATEMENT

> The original objectives of Steps 3, 5, 6 and 8 could not be recovered
> from persisted project artifacts. They are therefore not reconstructed,
> not inferred and not treated as failed.

Each clause is operative:

- **not reconstructed** — no objective has been written for any of the
  four. None appears anywhere in this file or in
  `PHASE_1.6_GATE_3R_SPEC.md`.
- **not inferred** — the following were considered and explicitly
  rejected as sources: the step numbers themselves; the defined
  neighbouring steps; the identically-numbered gates in the
  remediation-first scheme at `NEXT_PHASE_READINESS_REPORT.md` §15.2
  (`PHASE_1.6_SPEC.md` §10.4); forward-pointers in unrelated
  deliverables; the findings the steps are presumed to have produced; and
  any recollection not backed by a persisted artifact.
- **not treated as failed** — FAIL is an evidence class requiring
  evidence. No evidence exists that these steps failed. No evidence exists
  that they succeeded. UNRECOVERABLE is a statement about the **record**,
  not about the work.

## 4. COMPLETED-STEP EVIDENCE

The evidence below is Gate 3's surviving output. It remains fully citable
by later gates without re-measurement.

### 4.1 Step 0 — durability snapshot of the F16 findings

**Executed.** `PHASE_1.6_FINDINGS_LOG.md` was written, under a narrow
exception to Gate 3's measurement-only posture, because six of the seven
F16 findings "had no written record anywhere in this repository and
survived only in conversation context that has already been compacted
once" (`:3-6`).

**Result.** F16-01 through F16-07 persisted, each with finding statement,
evidence, class, status and a PROPOSED severity.

**Canonical-ID provenance recorded at `:20-32`.** Only F16-04 had a prior
repository citation (`PRIVILEGE_RUNTIME_VERIFICATION.md:412` and `:978`).
F16-01, F16-02, F16-03, F16-05, F16-06 and F16-07 were first written to a
repository file by that step.

**Assessment.** This step is the reason Gate 3's findings exist at all. It
is also the direct evidence for GOV-01: durability was applied to the
findings and not to the specification.

### 4.2 Step 1 — Edge Runtime recovery and endpoint confirmation

**Blocker history.** At the time `PHASE_1.6_FINDINGS_LOG.md` was written,
Step 1 was BLOCKED (`:84-85`) by a harness-side tool-permission-classifier
outage — a condition that manifested before a command reached a shell, so
no exit code, stderr or Docker response exists for the blocked attempts
(`:260-267`). The blocker was shape-sensitive: read-only tooling and
trivial shell commands succeeded while state-touching and network-touching
commands failed. It was **not** a repository, Docker, database or
permission condition. Step 1 was subsequently completed once the blocker
cleared, under the Gate 3 resumption authority permitting the Edge Runtime
restart.

**Evidence captured — a second independent Edge Runtime exit.**
`ExitCode=255`, `Error=` (empty), `OOMKilled=false`,
`FinishedAt=2026-08-22T06:09:05.122045435Z`, and **`RestartPolicy=no`**
(`PHASE_1.6_FINDINGS_LOG.md:52-57`).

**Evidence captured — the restart-policy asymmetry.** Every other Supabase
container carries `RestartPolicy=unless-stopped`, verified individually on
`supabase_db_setura`, `supabase_kong_setura`, `supabase_rest_setura`,
`supabase_auth_setura` and `supabase_vector_setura`. Edge Runtime alone
has no restart policy, so any exit is permanent while every other service
self-heals. This was demonstrated when the Docker daemon itself cycled
during Gate 3 (`npipe:////./pipe/dockerDesktopLinuxEngine: The system
cannot find the file specified`, then `ServerVersion 29.6.2` roughly
fifteen minutes later): all `unless-stopped` services returned as "Up 23
minutes (healthy)" and Edge Runtime did not (`:57-63`).

**Endpoint confirmation.** The container's last log lines are `Error:
Missing authorization header at getAuthToken
(file:///var/tmp/sb-compile-edge-runtime/root/index.ts:86:11)`. That path
is the Supabase platform's own main worker, not SETURA code, and the
message is the platform gate rejecting unauthenticated probes. It
indicates the runtime is up and routing. **It is not evidence of an
application fault and must not be reported as one.** No causal link
between those log lines and exit 255 has been established (`:64-70`).

**Attribution map established statically.** Exactly three integration
files invoke Edge Functions: `tests/integration/whatsapp_lifecycle.test.ts:392`,
`tests/integration/enterprise_command_center.test.ts:234`, and
`tests/integration/doctor_operations.test.ts:376`. Failures in those three
while Edge Runtime is down are attributable to F16-01 and must not be
recorded as product defects. `tests/integration/privilege_isolation.test.ts`
invokes no Edge Function, so its results can never be attributed to
F16-01 (`:71-77`).

**What Step 1 did not establish.** That F16-01 is fixed. Starting a
container does not change its `RestartPolicy`. F16-01 remains OPEN.

### 4.3 Step 2 — live policy count

**Subject.** The live `pg_policies` count, required to supply the correct
value against which the "193 RLS policies" comment in
`tests/integration/privilege_isolation.test.ts:565-570` is wrong (F16-07,
`PHASE_1.6_FINDINGS_LOG.md:256`).

**Recorded value: 139 public policies.**

**Evidence of record.** `PRIVILEGE_RUNTIME_VERIFICATION.md:446` — "the 139
policies", measured by Gate 2. The value is corroborated by an independent
static bound: all migrations together contain 144 `CREATE POLICY` and 130
`DROP POLICY` statements, with zero dynamically generated policies (no
match anywhere in `*.sql` for `(EXECUTE|format)\s*\(?\s*'?\s*CREATE
POLICY`), so live policies are bounded at ≤ 144 and cannot be 193
(`PHASE_1.6_FINDINGS_LOG.md:243-246`).

**Durability weakness, recorded rather than glossed.** No separately
persisted Gate 3 Step 2 output exists. The value's persisted attestation
is Gate 2's line, not a Gate 3 artifact. Step 2's status is COMPLETE as
frozen by the project-lead authorization; its evidence trail runs through
Gate 2's deliverable. This is a GOV-01-adjacent weakness — a completed
step whose own output was not persisted — and is recorded here so it is
attributable rather than discovered later.

**Superseded internal statement.** `PHASE_1.6_FINDINGS_LOG.md:250` states
the correct value is "UNMEASURED". That was already inaccurate when
written: Gate 2 had measured 139. The correction is recorded at
`PHASE_1.6_SPEC.md` §10.3 (contradiction C-2). **The findings log is not
edited** — historical reports are not rewritten
(`PHASE_1.6_SPEC.md` §10.1).

**What Step 2 did not establish.** A per-policy security audit. Matrix row
V-03 (`CROSS_PHASE_REQUIREMENTS_MATRIX.md:330`) asks for an audit over
`pg_policies`; a count is not an audit. That residue is Gate 7's.

### 4.4 Step 4 — security regression suite execution

**Executed.** `tests/integration/privilege_isolation.test.ts`, under the
Gate 3 resumption authority permitting that single file to be run.

**Result: 22 passed / 0 failed.**

**The count is 22, not 34.** The suite contains 22 tests.
`PHASE_1.5_SECURITY_AND_COMPLETION_REPORT.md:595` states "1,900 lines, 22
tests, real PostgreSQL, no mocked authorization … Result: 22 passed / 0
failed", and `:28` repeats "22 tests, DB-level". The "34/0" figure at
`:914` of that same report is a phantom: line `:919` totals the full run
as "227 passed / 0 failed", and 65 + 162 = 227 exactly, so the report's own
arithmetic excludes any separate 34-case suite. The file also lives under
`tests/integration/`, so its cases are already inside the 162. The full
correction is recorded at `PHASE_1.6_SPEC.md` §10.2 (contradiction C-1).
**The historical reports carrying "34" are not edited.**

**What Step 4 did not establish — F16-05.** The per-case failure payloads
were not obtained; that measurement was BLOCKED
(`PHASE_1.6_FINDINGS_LOG.md:187-189`). Therefore whether any passing
denial was satisfied by SQLSTATE `42501` (a genuine PostgreSQL privilege
denial) rather than by a JWT-layer rejection remains **UNPROVEN**. The
mechanism is real and source-proven: `assertRpcDenied` at `:241-246`
accepts `jwt` among its denial signatures, and `assertTableDenied` at
`:1237-1239` accepts `jwt` and `no suitable key`. The `anon` half is
unaffected by construction — no Authorization header is sent, so the JWT
channel is unreachable. The `authenticated` half is exposed. The Category A
positive control at `:571` proves the token resolved to `hospital_admin`,
but it lives in a **different** `Deno.test`, so its success does not
prevent Category B/C/D denials from passing spuriously.

**This does not reopen P1-11.** The privilege boundary itself is
independently established by Gate 2's `pg_proc.proacl` and
`has_function_privilege()` census plus runtime `42501` confirmation,
which does not depend on this suite.

**What Step 4 did not establish — F16-06.** Executed-probe counts were not
obtained; that measurement was BLOCKED
(`PHASE_1.6_FINDINGS_LOG.md:229-230`). The static picture is proven:
Category B **7** probe sites of 145 routines, Category C 10 of 10,
Category D 23 of 24, B-trigger 0 of 10 — totalling **40 of the 179 locked
routines, 22.3 percent**. That is a count of probe **sites in source**, not
a runtime result, and must not be restated as one (`:220-222`). Two
omissions are documented as legitimate: the 4-argument `capture_payment`
overload is unreachable through PostgREST because any 4-key payload also
matches the 5-argument overload via its default (`:648-653` of the test),
and the 10 B-trigger routines are structurally non-callable regardless of
role, proven by Gate 2 (`PGRST202` for both `anon` and `service_role`,
`0A000` on direct SQL invocation).

### 4.5 Step 7 — post-test recheck

**Blocker history.** BLOCKED at the time the findings log was written
(`:84-85`), by the same harness-side classifier outage as Step 1;
completed once that cleared.

**Evidence captured.** Container state was rechecked after test execution.
`supabase_vector_setura` was still restarting at approximately
2026-08-22T11:38Z — `Restarting (0) 11 seconds ago`
(`PHASE_1.6_FINDINGS_LOG.md:122-124`) — consistent with F16-03's
`ExitCode=0`, `RestartCount=15`, `Health=unhealthy`.

**Interaction with Step 4's result.** `privilege_isolation.test.ts`
invokes no Edge Function, so the 22/22 result is independent of Edge
Runtime state at any point during the run (`:76-77`). Vector ships logs to
Logflare/analytics only and no gate depends on it, so F16-03's state does
not bear on the result either.

## 5. FINDINGS OF RECORD

Gate 3's findings, as persisted in `PHASE_1.6_FINDINGS_LOG.md`. Every
severity is **PROPOSED — NOT FINAL**; assignment belongs to Gate 8.

| ID | Subject | Class | Status | PROPOSED severity | Originating gate |
|---|---|---|---|---|---|
| F16-01 | `supabase start` reports success while Edge Runtime stays down; `RestartPolicy=no` | environment / tooling — **not a product defect** | OPEN, recurred in Gate 3 | P2 | Gate 1 |
| F16-02 | no `.env`; Edge Runtime holds zero SETURA secrets | environment | DEFERRED to Gate 4 | BLOCKER-ENV — possibly NOT APPLICABLE as a product finding | Gate 1 |
| F16-03 | `supabase_vector_setura` crash-loops | environment, external to SETURA — **not a product defect** | OPEN, deferred to Gate 8 | P3 | Gate 1 |
| F16-04 | migration 49 has no default-privilege discipline | product — security-boundary regression vector; **current exposure: none** | OPEN — NOT REMEDIATED | P1 | Gate 2 |
| F16-05 | a JWT failure can satisfy a privilege-denial assertion | test quality | OPEN; source-proven, runtime realization UNPROVEN | P2 | Gate 3 |
| F16-06 | Category B denial coverage is 7 of 145 | test coverage | OPEN; statically proven, runtime coverage UNPROVEN | P2 | Gate 3 |
| F16-07 | a code comment misstates a routine count as a policy count | documentation | OPEN; comment proven wrong | P3 | Gate 3 |
| GOV-01 | a gate was executed against a specification that was never persisted | governance / process — **not a product defect** | OPEN; structurally addressed for future gates | PROPOSED | Gate 3 closure |

GOV-01 is defined at `PHASE_1.6_SPEC.md` §12.1. It is not allocated into
`CROSS_PHASE_GAP_REGISTER.md`: that register's ID prefix *is* its severity
scheme, so allocating an ID there would assign a severity, which PART 10
reserves to Gate 8 (`PHASE_1.6_SPEC.md` §7.3).

## 6. WHAT GATE 3 DID NOT PROVE

Stated explicitly, so that no later summary can read the completed steps
as more than they are.

- **The integration suite was not executed.** 1 of 11
  `tests/integration/` files ran. `NEXT_PHASE_READINESS_REPORT.md:1143` —
  "The integration suite was never executed" — remains accurate for the
  other 10. Matrix row F-11 (`:120`) stays UNPROVEN.
- **F16-05 was not resolved.** Per-case error codes were never obtained.
  All 22 tests passing is consistent with both a genuine `42501` denial and
  a `PGRST301` JWT failure; that ambiguity is the finding.
- **F16-06 was not resolved.** No executed-probe counts exist. The 22.3
  percent figure counts source sites.
- **F16-07's correct value was supplied but the finding was not
  remediated.** The comment still reads 193.
- **F16-01 was not fixed.** The container was started; the restart policy
  was not changed, and must not be.
- **No product defect was repaired.** P0-01, P0-02, P0-03, P0-04 and
  F16-04 are untouched, by design (`PHASE_1.6_SPEC.md` §2.2).
- **Nothing was proven about production.** No deployment exists.
- **No severity was finalized.** Gate 8's authority.
- **Migrations were not proven to apply to a fresh database.** That
  requires `supabase db reset`, which was not authorized. Matrix row F-02
  (`:111`) stays UNPROVEN.
- **Steps 3, 5, 6 and 8 proved nothing, and are not recorded as having
  failed to.** Their objectives are unknown (§3).

## 7. ENVIRONMENT ACTIONS PERFORMED

Recorded per `CLAUDE.md` §32.

| Action | Why | Persistent repository state changed | Reproducible | Affects certification |
|---|---|---|---|---|
| Started `supabase_edge_runtime_setura` | restore the measuring instrument after an exit-255 stop | no | yes — subject to F16-01 recurring | no; does not fix F16-01 |
| Read-only Docker inspection of Supabase containers | capture per-service state, exit codes, restart policies | no | yes | supports Step 1 |
| Read-only database and catalog queries | policy count, privilege state | no | yes | supports Steps 2 and 4 |
| Executed `tests/integration/privilege_isolation.test.ts` | Step 4 | no source change; touched local DB state only as the test itself does | yes | supports Step 4 |

**Not performed:** no `.env` created; no secret created, real or dummy; no
`supabase db reset`; no container reconfiguration; no `deno task fmt`; no
`deno task gen:types`; no deployment; no migration; no source, test or
privilege modification.

## 8. CERTIFICATION

**Gate 3 certification: NOT CERTIFIED.**

**Basis.** `PHASE_1.6_SPEC.md` §9 rule 2 — a gate certifies only if every
one of its steps has a persisted definition and a recorded result. Four of
nine step definitions are unrecoverable. The gate therefore cannot
certify, independently of how its five completed steps performed.

**Per-step certification.**

| Step | Certification |
|---|---|
| 0 | PASS |
| 1 | PASS — with F16-01 recorded OPEN, not remediated |
| 2 | PASS — value 139; own output not separately persisted (§4.3) |
| 3 | UNRECOVERABLE — neither PASS nor FAIL |
| 4 | PASS for the suite result (22/0); F16-05 and F16-06 sub-measurements BLOCKED |
| 5 | UNRECOVERABLE — neither PASS nor FAIL |
| 6 | UNRECOVERABLE — neither PASS nor FAIL |
| 7 | PASS |
| 8 | UNRECOVERABLE — neither PASS nor FAIL |

**Binding prohibition, without expiry.** **Historical Gate 3 must never be
represented as fully certified** — not by a later report, not by a summary
table, not by a completion claim, and not after Gate 3R passes. A Gate 3R
PASS certifies Gate 3R. It does not retroactively certify Gate 3, and
nothing can (`PHASE_1.6_SPEC.md` §5.4).

**What remains citable.** Everything in §4. The completed steps' evidence
is sound and is not tainted by the missing step definitions. It requires
no re-measurement, and Gate 3R inherits it by citation
(`PHASE_1.6_GATE_3R_SPEC.md` §1.1).

## 9. SUCCESSOR

Gate 3 is closed and cannot be reopened. Remaining runtime and integration
verification proceeds in **Gate 3R — Runtime & Integration Verification
Successor**, specified in full at `PHASE_1.6_GATE_3R_SPEC.md`.

Gate 3R is a newly authorized successor verification gate. It is NOT a
reconstruction of historical Gate 3 and does not claim to recover its
missing requirements. Its steps are numbered 1–7 and correspond to nothing
in Gate 3's 0–8; no correspondence exists or may be asserted.

**Gate 3R execution has not started.**

---

## Document control

| Property | Value |
|---|---|
| Gate | 3 (historical) |
| Status | **PARTIALLY COMPLETE — NOT CERTIFIED** — FROZEN |
| Authority | Project-lead Option C authorization, 2026-08-23, PART 1 |
| Steps complete | 0, 1, 2, 4, 7 |
| Steps unrecoverable | 3, 5, 6, 8 |
| Reconstruction performed | **NONE** |
| Superseded by | nothing — a frozen record is not superseded; Gate 3R succeeds it without replacing it |
| Outranked by | `CLAUDE.md`, then `PHASE_1.6_SPEC.md` |
| Files modified to produce it | none |
| Product state changed | none |
