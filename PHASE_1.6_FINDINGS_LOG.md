# PHASE 1.6 — F16 FINDINGS LOG (DURABILITY SNAPSHOT)

**Purpose.** This file is a durability snapshot of the F16-series findings raised
during Phase 1.6 Gates 0-3. It exists because six of the seven findings had no
written record anywhere in this repository and survived only in conversation
context that has already been compacted once.

**Authorization.** Written under an explicit, narrow exception to Gate 3's
measurement-only posture, authorized as Step 0 of the Gate 3 resumption
instruction. It is a documentation write. No source file, migration, test,
privilege, configuration, or prior deliverable was modified to produce it.

**What this file is not.** It is not the Gate 3 report
(`PHASE_1.6_RUNTIME_TEST_REPORT.md`, still unwritten pending Steps 1-8). It is
not the Gate 8 register update. It contains no new analysis beyond what was
already established when it was written, no severity assignments, and no
remediation. Every severity below is **PROPOSED — NOT FINAL**; assignment
belongs to Gate 8.

## Canonical-ID provenance

Only **F16-04** had a prior repository citation before this file existed:
`PRIVILEGE_RUNTIME_VERIFICATION.md:412` and `:978`.

**F16-01, F16-02, F16-03, F16-05, F16-06 and F16-07 are first written to a
repository file by this step.** Before it, they existed only in conversation.
This was established by searching every root markdown file for `F16-0[0-9]`,
which returned exactly two hits, both for F16-04.

F16-01, F16-02 and F16-03 originate in Gate 1. F16-04 originates in Gate 2.
F16-05, F16-06 and F16-07 originate in Gate 3's static read of
`tests/integration/privilege_isolation.test.ts`.

## Status vocabulary

This file uses the vocabulary already established in prior gates and introduces
none. Evidence classes: **PASS**, **FAIL**, **BLOCKED**, **UNPROVEN**, **NOT
APPLICABLE**. Finding-level states: **OPEN**, **DEFERRED**, **NOT REMEDIATED**,
**RESOLVED**.

---

## F16-01 — `supabase start` reports success while Edge Runtime stays down

- **Finding statement (Gate 1 wording).** `supabase start` exited **0** and
  printed "supabase local development setup is running", yet `supabase status`
  simultaneously reported `supabase_edge_runtime_setura` among its stopped
  services. Success exit code and actual service availability diverge.
- **Gate 1 evidence.** `ExitCode=255`, `OOMKilled=false`, `Error=""`,
  `RestartCount=0`, `FinishedAt=2026-08-21T04:56:39Z`. No panic and no
  out-of-memory kill.
- **Gate 3 evidence — mechanism proven.** Second independent exit observed:
  `ExitCode=255`, `Error=`, `OOM=false`,
  `FinishedAt=2026-08-22T06:09:05.122045435Z`, **`RestartPolicy=no`**. Every
  other Supabase container carries `RestartPolicy=unless-stopped`, verified
  individually on `supabase_db_setura`, `supabase_kong_setura`,
  `supabase_rest_setura`, `supabase_auth_setura` and `supabase_vector_setura`.
  Edge Runtime alone has no restart policy, so any exit is permanent while every
  other service self-heals. This was demonstrated when the Docker daemon itself
  cycled during Gate 3 (`npipe:////./pipe/dockerDesktopLinuxEngine: The system
  cannot find the file specified`, then `ServerVersion 29.6.2` roughly fifteen
  minutes later): all `unless-stopped` services returned as "Up 23 minutes
  (healthy)" and Edge Runtime did not.
- **Explicitly not a crash indicator.** The container's last log lines are
  `Error: Missing authorization header at getAuthToken
  (file:///var/tmp/sb-compile-edge-runtime/root/index.ts:86:11)`. That path is
  the Supabase platform's own main worker, not SETURA code, and the message is
  P1-09's platform gate rejecting unauthenticated probes. It is **not** evidence
  of an application fault and must not be reported as one. No causal link
  between those log lines and exit 255 has been established.
- **Attribution map (Gate 3, static).** Only three integration files invoke Edge
  Functions: `tests/integration/whatsapp_lifecycle.test.ts:392`,
  `tests/integration/enterprise_command_center.test.ts:234`, and
  `tests/integration/doctor_operations.test.ts:376`. Failures in those three
  while Edge Runtime is down are attributable to F16-01 and must not be recorded
  as product defects. `tests/integration/privilege_isolation.test.ts` invokes no
  Edge Function, so its results can never be attributed to F16-01.
- **Class.** Supabase CLI container-creation behaviour. An environment and
  tooling finding, not a SETURA product defect.
- **Status.** OPEN. Recurred in Gate 3. Recovery attempt BLOCKED.
- **Proposed severity.** P2 (Gate 1: "operational"; Gate 3: environment/tooling
  class). **PROPOSED — NOT FINAL.** Gate 3 noted it may warrant escalation if it
  recurs during Gate 4 or Gate 5 and blocks runtime proof of P0-02 or P0-03.
- **Waiting on.** Gate 3 Step 1 (recovery and endpoint confirmation) and Step 7
  (post-test recheck). Both BLOCKED by the harness classifier outage.

## F16-02 — no `.env` exists; Edge Runtime holds zero SETURA secrets

- **Finding statement (Gate 1 wording).** No `.env` exists. `ls .env*` returns
  **only `.env.example`**, and `supabase/functions/.env*` does not exist. The
  Edge Runtime container's environment contains only platform variables
  (`PATH`, `SUPABASE_ANON_KEY`, `SUPABASE_DB_URL`, `SUPABASE_INTERNAL_*` and
  similar) and no SETURA application secrets.
- **Gate 3 evidence supporting deferral.** A search of the entire `tests/` tree
  for `CRON_SECRET`, `WORKER_SECRET`, `RAZORPAY_KEY_SECRET`, `META_APP_SECRET`,
  `ENABLE_WORKER_TRIGGER`, `WORKER_LEASE_SECS` and `RAZORPAY_WEBHOOK_SECRET`
  returns **zero matches**. The one test touching the worker-secret boundary,
  `tests/integration/whatsapp_lifecycle.test.ts:389-407`, asserts HTTP 403 for
  the **absence** of the header and therefore requires the secret to stay
  missing. `tests/integration/privilege_isolation.test.ts:67-84` derives all
  configuration from `supabase status -o json` and reads no environment
  variable. No Gate 3 outcome can be changed by providing these secrets.
- **Status.** DEFERRED to Gate 4. The deferral reasoning is evidence-complete
  and requires no further measurement.
- **Proposed severity.** Recorded in Gate 1 as BLOCKER-ENV. Not a product
  severity; **PROPOSED — NOT FINAL**, and possibly NOT APPLICABLE as a product
  finding. Gate 8 to decide.
- **Waiting on.** Nothing. Local secret provisioning is Gate 4 scope. Production
  secret provisioning remains a separate open item outside Phase 1.6.

## F16-03 — `supabase_vector_setura` crash-loops

- **Finding statement (Gate 1 wording).** `supabase_vector_setura` crash-loops:
  `ExitCode=0`, `RestartCount=15`, `Health=unhealthy`.
- **Evidence.** Root cause is external to SETURA: `Listing currently running
  containers failed. error=HyperLegacyError { err:
  hyper_util::client::legacy::Error(Connect, ConnectError("tcp connect error",
  Os { code: 101, kind: NetworkUnreachable, message: "Network unreachable" })) }`
  followed by `INFO vector_common::shutdown: All sources have finished.` Vector
  cannot reach the Docker socket on this Windows host.
- **Impact.** Vector only ships logs to Logflare/analytics. No gate depends on
  it. **Not a SETURA defect.**
- **Gate 3 observation.** Still restarting at approximately
  2026-08-22T11:38Z: `Restarting (0) 11 seconds ago`.
- **Status.** OPEN, deferred to Gate 8.
- **Proposed severity.** P3 — environmental. **PROPOSED — NOT FINAL.**
- **Waiting on.** Nothing required. An optional recheck could confirm whether
  the restart count has continued to climb.

## F16-04 — migration 49 has no default-privilege discipline

- **Prior repository citation.** `PRIVILEGE_RUNTIME_VERIFICATION.md:412` and
  `:978`. This is the only F16 finding that had a written record before this
  file.
- **Finding statement.** `supabase/migrations/49_phase_1_5_defect_fixes.sql`
  creates `SECURITY DEFINER` routines (`CREATE OR REPLACE` sites at `:260`,
  `:425`, `:620`) and contains **zero** `REVOKE` or `GRANT` statements.
- **Measured result.** No routine is currently over-exposed.
  `generate_executive_report(text, uuid, date, date)`,
  `get_financial_command_center(uuid, date)` and
  `get_hospital_timeline(uuid, timestamptz, timestamptz, text[], text, uuid,
  uuid, integer)` each measure `anon` = **false**, `authenticated` = false, with
  `proacl` = `postgres=X/postgres service_role=X/postgres`.
  `current_user_role(uuid)` measures `anon` = true and `authenticated` = true,
  which is correct because it is a Category A RLS helper.
- **Why this is still a finding.** The safe result is incidental. All four are
  `CREATE OR REPLACE` of functions that already existed before migration 48, and
  `CREATE OR REPLACE` preserves the existing ACL when the signature is
  unchanged. Each name resolves to exactly one signature and no overloads were
  created. Migration 49 inherited migration 48's lockdown rather than earning
  it. Had any signature changed, or had migration 49 added a genuinely new
  function, that routine would today be `anon`-executable with no statement
  anywhere in the repository preventing it.
- **Status.** OPEN — NOT REMEDIATED.
- **Proposed severity.** P1 — a security-boundary regression vector on the next
  schema change, in a system whose central Phase 1.5 claim is this boundary.
  **Current exposure: none.** **PROPOSED — NOT FINAL.**
- **Waiting on.** Nothing; the finding is statically complete. A fix would
  require a new migration, which §15 forbids initiating during Gate 3.

## F16-05 — a JWT failure can satisfy a privilege-denial assertion

- **Finding statement.** In `tests/integration/privilege_isolation.test.ts`,
  `assertRpcDenied` at `:240-249` accepts a 401 or 403 whose message contains
  any of `permission denied`, `insufficient`, **`jwt`**, `not authorized`, or
  `42501`. `assertTableDenied` at `:1236-1242` likewise accepts **`jwt`** or
  **`no suitable key`**. Both strings are authentication-failure signatures, not
  privilege-failure signatures.
- **Why the `anon` half is unaffected.** No Authorization header is sent for
  `anon` probes, so the JWT channel is unreachable and a 401 or `42501` there
  has no alternative explanation.
- **Why the `authenticated` half is exposed.** An expired, malformed or
  wrongly-minted fixture token yields 401 `invalid JWT`, which satisfies the
  assertion while the request never reaches the database and the privilege
  boundary is never exercised.
- **Partial mitigation, and its limit.** The Category A positive control at
  `:587-591` proves the token resolves to `hospital_admin` before the denial
  tests run. It lives in a **different** `Deno.test`, so a token failure there
  does not prevent the Category B, C and D denial tests from passing
  spuriously.
- **Not currently masking anything.** Gate 2's `pg_proc.proacl` and
  `has_function_privilege()` catalog census proves the privilege boundary
  independently of this suite.
- **Class.** Test quality.
- **Status.** OPEN. Source-proven; runtime realization UNPROVEN.
- **Proposed severity.** P2. **PROPOSED — NOT FINAL.**
- **Waiting on.** Gate 3 Step 4. Determining whether any passing case was
  satisfied by SQLSTATE `42501` versus a JWT rejection requires the actual
  per-case failure payloads. BLOCKED.

## F16-06 — Category B denial coverage is 7 of 145

- **Finding statement.** The suite's header at `:36-44` states that "Category
  B/C/D privileged RPCs are refused for anon AND authenticated", which reads as
  complete coverage and is not.
- **Measured populations.** From `docs/security/RPC_PRIVILEGE_CLASSIFICATION.tsv`
  (194 non-empty lines = 1 header + 193 data rows), matching Gate 2's live
  `pg_proc` census: Category A = 4, Category B = 145 (80 `edge_referenced`, 65
  not), B-trigger = 10, Category C = 10, Category D = 24. Sum = 193.
- **Measured probe counts (static).** Category B: **7** probes at `:1075-1135`
  (`get_hospital_command_center`, `get_daily_operations_dashboard`,
  `get_alert_center`, `get_queue_snapshot`, `advance_queue`,
  `acknowledge_alert`, `fire_managed_alert`), all drawn from the 80
  edge-referenced routines. Category C: **10** of 10 at `:968-1033`. Category D:
  **23** of 24 at `:655-864`. B-trigger: **0** of 10.
- **The one documented exception is legitimate.** The 24th Category D routine is
  the 4-argument `capture_payment` overload, documented unreachable at
  `:648-653` because any 4-key payload also matches the 5-argument overload
  through its default, so PostgREST cannot be forced to select it. Both
  overloads are verified at the catalog level by migration 48 section 4 grants
  and section 11 check 3.
- **The B-trigger omission is also legitimate.** Gate 2 proved those 10 are
  structurally non-callable regardless of role (PGRST202 for both `anon` and
  `service_role`, and SQLSTATE `0A000` on direct SQL invocation), which is
  outside this suite's method.
- **Separately measured gap.** Migration 48 section 7 names 9 `SECURITY INVOKER`
  functions; the suite probes **5** at `:1180-1191` (`get_queue_health`,
  `get_mv_refresh_health`, `get_stuck_jobs`, `is_hospital_online`,
  `is_alert_suppressed`).
- **Static probe coverage.** 7 + 10 + 23 = **40 of the 179 locked routines**
  (145 + 10 + 24), or 22.3 percent. This is a count of probe **sites** in
  source, not a runtime result, and must not be restated as one.
- **Distinct from P2-14.** `CROSS_PHASE_GAP_REGISTER.md:483-509` covers absent
  coverage at defect sites and nominal REVOKE-based coverage of 10 of 11
  test-only routines. Neither addresses the size of the probed population.
- **Class.** Test coverage.
- **Status.** OPEN. Statically proven; runtime coverage UNPROVEN.
- **Proposed severity.** P2. **PROPOSED — NOT FINAL.**
- **Waiting on.** Gate 3 Step 4, for executed-probe counts and actual
  passed/failed denials. BLOCKED.

## F16-07 — a code comment misstates a routine count as a policy count

- **Finding statement.** `tests/integration/privilege_isolation.test.ts:565-570`
  states that migration 48 section 3 keeps four `SECURITY DEFINER` helpers
  executable by `anon` and `authenticated` "because **193 RLS policies** call
  them". 193 is the **routine** count, not a policy count.
- **Provenance of 193, proven three ways.** The classification TSV has 193 data
  rows summing 4 + 145 + 10 + 10 + 24. This matches Gate 2's live `pg_proc`
  census and Appendix D's decomposition of A (4) + B/C/D-locked (179) +
  B-trigger (10) = 193.
- **Why it cannot be a live policy count.** All migrations together contain
  **144** `CREATE POLICY` statements and **130** `DROP POLICY` statements, with
  zero dynamically generated policies (no match anywhere in `*.sql` for
  `(EXECUTE|format)\s*\(?\s*'?\s*CREATE POLICY`). Live policies are therefore
  bounded at **144 or fewer, which is less than 193**.
- **Family.** Same unit-confusion class as the 193-versus-191 dispute recorded
  against certification claim 8.
- **Blast radius.** The number appears in a comment. No assertion depends on it.
- **Correct value.** UNMEASURED. The live `pg_policies` count has not been
  obtained.
- **Class.** Documentation.
- **Status.** OPEN. The comment is proven wrong; its correct replacement value
  is unmeasured.
- **Proposed severity.** P3. **PROPOSED — NOT FINAL.**
- **Waiting on.** Gate 3 Step 2, for the live `pg_policies` count. BLOCKED.

---

## Cross-cutting note on the blocker

F16-01, F16-05, F16-06 and F16-07 each await a measurement that was blocked by a
harness-side tool-permission-classifier outage, not by any repository, Docker,
database or permission condition. The blocker manifests before a command reaches
a shell, so no exit code, stderr or Docker response exists for the blocked
attempts. It is shape-sensitive: read-only tooling and trivial shell commands
succeed while state-touching and network-touching commands fail.

None of these four findings may be advanced to PASS, RESOLVED, or a final
severity on the basis of the static evidence recorded above.
