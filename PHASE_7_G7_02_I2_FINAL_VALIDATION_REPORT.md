# PHASE 7 — G7-02 I-2 FINAL VALIDATION REPORT

Scope: **PART A (A1–A8)** of the G7-02 I-2 final fix + I-3 package. This report
records what was re-checked against the *actual* repository/runtime state, what
was fixed, and what remains pre-existing or environment-blocked. It follows the
AGENTS.md evidence discipline: a claim is stated only at the level actually
proven, and `BLOCKED`/`UNPROVEN` are never promoted to `PASS`.

All commands were run locally on Deno 2.8.3 / Windows. No push, no deploy, no
credential creation, no applied-migration edit, no RLS/auth/financial/worker/
scheduler logic change was performed.

---

## A1 — Git state reconciliation (report baseline was STALE)

The incoming spec asserted `main = aa766eb`, `origin/main = dfd98e74`, "local
main is two commits ahead," and "No push performed." The **actual** state
(`git status`, `git rev-parse`, `git diff origin/main...HEAD`) is:

```text
HEAD        = 514c33758a0a692f86d3d60c5f7581650a1250b1  ("graphify")
origin/main = 514c33758a0a692f86d3d60c5f7581650a1250b1
ahead = 0   behind = 0   working tree clean
remote: https://github.com/YeswanthArasavalli/Setura.git
```

Commit history (`git log --oneline -5`):

```text
514c337 (HEAD -> main, origin/main, origin/HEAD) graphify
aa766eb ci: implement G7-02 release validation pipeline
1b5bcb2 chore(hygiene): G7-03 repository hygiene + migration immutability baseline
dfd98e7 Add Phase 7 readiness and worker-reclaim reports
12123c3 Add staff web frontend and security S1 tests
```

Findings:

1. **A push HAS already occurred.** `origin/main` == local `main` == `514c337`.
   The spec's "no push performed / two commits ahead" premise is out of date.
   The two intended commits (`1b5bcb2`, `aa766eb`) and a third `514c337`
   ("graphify") are all on the remote.
2. **The I-2 commit `aa766eb` is correctly scoped** (verified by per-commit
   file census): 3 `scripts/`, `deno.json`, `tests/`, `.github/workflows/ci.yml`,
   `.gitignore`, and 2 report `.md` files. **0 `graphify-out/` files and 0 `.sql`
   files** are in it. graphify-out changes live in the separate `514c337` commit,
   so they are outside the I-2 commit as required.
3. **No application SQL/RLS/business logic** changed in any of the three commits:
   `git show --name-only` filtered for `.sql$` returns empty across all three.
   The hygiene commit's only `supabase/` touch was the additive
   `supabase/migrations/MANIFEST.sha256` plus removal of transient
   `supabase/.temp` / `supabase/.branches` local CLI state.

> Because the I-2 commits are already on `origin/main`, spec B11's stop
> condition ("I-3 blocked if it needs a push first") does not apply — no push is
> required to reach the remote baseline. (No push was performed in this session.)

---

## A2 — CI workflow + scripts inspected against the report

Files read: `.github/workflows/ci.yml`, `deno.json`,
`scripts/validate_migration_manifest.ts`, `scripts/check_frontend_secrets.ts`,
`scripts/release_manifest.ts`, `tests/unit/migration_manifest_guard.test.ts`.

The four jobs match the report: `quality`, `frontend`, `stack`,
`release-validation` (main-push / dispatch only). Release provenance uses honest
`UNPROVEN`/`NOT PERFORMED` defaults and never emits `PASS` on failure. The
`release-validation` job's consolidated task list matches `deno task
test:consolidated`.

**Discrepancy found (fixed in A8):** the `quality` job runs *unscoped*
filesystem-wide `deno fmt --check` (ci.yml `Format check`) and `deno lint`
(`Lint`). As diagnosed in A3, that scope is wrong and makes the PR-blocking job
fail on a clean checkout. The workflow header comment even claimed the package
"neither hides nor silently fixes" baseline findings — but an always-red
filesystem-wide gate is not a working gate. This is corrected below.

---

## A3 — Pre-existing fmt/lint diagnosis (classification)

`deno fmt --check` at the repo root (Deno respects `.gitignore`, which does NOT
ignore `graphify-out/`, `apps/`, or root `*.md`) reported **205 unformatted
files**. `deno lint` reported **8 problems**. Targeted per-region checks give the
definitive classification:

| Region | fmt offenders | lint offenders | nature |
| --- | --- | --- | --- |
| `supabase/functions`, `scripts`, `deno.json` | **0** | **0** (91 files checked) | Deno application source — CLEAN |
| `tests/` | 2 | 0 | Deno test source — genuine cosmetic drift |
| `graphify-out/` | 128 | — (no JS/TS) | generated navigation index |
| `apps/web/` | 48 | 8 | Vite/React frontend (separate toolchain) |
| root `*.md` | 27 (of 39) | — | prose evidence reports |

- `deno lint apps/web` in isolation surfaces sloppy-import / `no-window` /
  `require-await` Deno-runtime rules that are **false positives for browser
  bundler code** (e.g. `window` is valid in a browser; `@/…` alias imports are
  resolved by Vite, not Deno). The dedicated `frontend` CI job — not root Deno
  lint — is the correct authority for `apps/web`.
- `graphify-out/` is the protected navigation index that AGENTS.md §4 forbids
  modifying; formatting it validates nothing about the application.

**Classification of the CI failure:** `PRE-EXISTING` (the offending files predate
I-2) surfaced by a **`CI DESIGN ISSUE`** newly introduced by I-2 (the unscoped
gate). It is **not** a `NEW` application defect and **not** an `ENVIRONMENT`
failure. No genuine Deno-application defect exists other than 2 cosmetic test
formatting drifts.

---

## A4 — Migration enforcement (PASS)

```text
deno task validate:migration-manifest -> 56 migrations, 56 manifest lines, 0 integrity issues
deno test migration_manifest_guard    -> 10 passed / 0 failed
deno task validate:migrations         -> 0 errors, 4 pre-existing [duplicate-objects] warnings
```

The 4 warnings are the documented G7-03 pre-existing baseline (guarded duplicate
definitions in migrations 20/22/47), not new defects. All A4 negative cases are
proven by the guard unit tests against synthetic fixtures: modified content,
rewritten baselined hash (`baseline-modified`), removed migration (`missing`),
out-of-order insert, duplicate prefix, unmanifested file, ordering, and
determinism. No migration files were changed.

---

## A5 — Release provenance (PASS, honest defaults)

`deno task release:manifest` produced `release/manifest.json` (gitignored under
`release/`) with: `deployment = NOT PERFORMED`, every result field
(`backend`/`frontend`/`security`/`worker`/`scheduler`/`financial`/`build`) =
`UNPROVEN`, `tag`/`source_revision` = `UNPROVEN`, and the note
"BLOCKED/UNPROVEN results are never promoted to PASS." Secret-pattern scan of the
artifact returned **0 hits**. No release tag was created.

---

## A6 — Frontend CI (PASS locally)

Executed in `apps/web` (node v24 / npm 11):

```text
typecheck (tsc --noEmit)         -> PASS
build     (tsc --noEmit && vite) -> PASS (110 modules, dist emitted)
test      (vitest run)           -> 17 passed / 0 failed (3 files)
secret + source-map scan         -> 0 secret hits, 0 source maps (sourcemaps denied) -> exit 0
```

`npm ci` was executed for real in the blocker-resolution follow-up (registry
reachable: `npm ping` PONG; `npm ci` → "added 258 packages, audited 259",
exit 0), so the lockfile-integrity install step is now **locally PROVEN** as
well as typecheck / build / vitest 17-17 / secret+source-map scan. It remains
`UNPROVEN` only in the sense that it has not been observed green on GitHub.
No frontend application behavior was modified.

---

## A7 — Consolidated regression — **EXECUTED (was BLOCKED; blocker resolved)**

*First pass:* `deno task test:consolidated` was originally `BLOCKED` because the
Docker daemon was down and no result was fabricated.

*After Docker was started (same package, blocker-resolution follow-up):* the
local Supabase stack was confirmed running (`supabase_db_setura` etc.), and the
Edge Runtime container was recovered from its known F16-01 exited state
(`docker start supabase_edge_runtime_setura` → Up). The real consolidated
regression was then executed against the live stack:

```text
deno task test:consolidated  ->  FAILED | 57 passed | 1 failed (23s)
```

Coverage actually executed (runtime, not composition): E1 hospital_core_journey
(18 tests), W1 worker_lifecycle / worker_lease_persistence / worker_job_failure,
scheduler_autonomy, financial booking_fee_refund / refund_sync /
settlement_record_payment, security_s1. The `worker_lifecycle` "w1 deterministic
failure" log lines are an intentional self-test (a job deliberately throws and is
retried then dead-lettered) — not a defect.

**The single failure is `E1 09` and is a weekday test-harness issue, NOT a product
defect and NOT an I-2/I-3 regression** (source-proven):

- `clinicDate()` (`hospital_core_journey.test.ts:117`) rolls **Sunday → Monday**
  (`if (getDay() === 0) setDate(+1)`), so E1 01 books and creates the queue
  session for `CLINIC.date` (Monday).
- E1 09 calls `doctor-operations` `start_session` → `open_doctor_session`, whose
  `p_session_date` defaults to the DB `CURRENT_DATE` (Sunday).
- Different `(hospital, doctor, date)` tuple → the RPC creates a **new Sunday
  session** instead of converging on `J.sessionId`, so the
  `assertEquals(queue_session_id, J.sessionId)` at line 872 sees two different
  UUIDs.
- The run timestamp (`2026-09-20T04:50Z`) confirms the day is **Sunday**. On any
  Mon–Sat run `CLINIC.date == CURRENT_DATE` and it passes.

Cross-run data contamination was ruled out: each run mints a fresh random
hospital slug and `doctorA` UUID, and the other 17 E1 legs plus every worker /
scheduler / financial / security test passed against the same persisted DB.

No product code, migration, RLS or test assertion was changed to obtain this
classification. **Status: CONSOLIDATED REGRESSION = 57 PASS / 1 FAIL, the failure
being a pre-existing Sunday-only fixture/`CURRENT_DATE` divergence (test-harness
defect), not a product defect.** See
`PHASE_7_G7_02_I3_BRANCH_PROTECTION_ENVIRONMENT_REPORT.md` for the recommended
follow-up test fix.

> **Later-package update (2026-09-20, factual only).** The recommended test-only
> fix was subsequently applied under explicit authorization (see
> `PHASE_7_E1_09_TEST_DETERMINISM_FIX_REPORT.md`). On a genuine Sunday run the
> `clinicDate()` Sunday→Monday rollover was removed so the fixture anchors to the
> same current date the doctor-session RPC resolves via `CURRENT_DATE`; no
> production SQL/migration/Edge Function/RLS/assertion changed. Re-proof against
> the live stack:
>
> ```text
> Before: 57 PASS / 1 FAIL   ->   After: 58 PASS / 0 FAIL
> E1 in isolation: 18 PASS / 0 FAIL (two consecutive runs)
> ```
>
> The historical 57/1 evidence above is the pre-fix run and is retained as-is.

---

## A8 — Final I-2 decision & correction applied

A **safe, CI-only correction was justified** (the unscoped gate could never pass
without violating repository policy). Applied, minimal:

1. **`deno.json`** — added fmt/lint `exclude` entries for the non-Deno-managed
   subtrees: `graphify-out/` and `apps/` (both fmt+lint), plus `**/*.md` (fmt).
   No Deno application source, script or test is excluded, so no genuine Deno
   defect is hidden. This removes 176 of 205 fmt offenders and all 8 lint
   offenders by tool-scope, not suppression.
2. **`tests/integration/scheduler_autonomy.test.ts` +
   `security_s1.test.ts`** — formatted these 2 genuine Deno-source drifts
   directly (line-wrapping only; verified via `git diff` as no logic change)
   rather than scoping tests out of validation.
3. **`.github/workflows/ci.yml`** — replaced the inaccurate "neither hides nor
   fixes" header comment with an accurate description of the formatter/linter
   scope and the rationale.

### Post-correction verification (Docker-free `quality`-job steps)

```text
deno fmt --check   -> Checked 150 files, exit 0   (was: 205 unformatted)
deno lint          -> Checked 91 files,  0 problems, exit 0   (was: 8 problems)
deno task check    -> exit 0
deno task test     -> 91 passed / 0 failed
validate:migrations-> 0 errors, 4 pre-existing warnings
migration manifest -> 56/56, 0 integrity issues
deno.lock          -> unchanged (no dependency drift introduced)
```

The `quality` job's non-Docker steps are now genuinely green on the Deno-managed
source. No `|| true`, no `continue-on-error`, no weakened rule, no deleted or
downgraded check, no security gate touched.

### Not fixed (deliberately, pre-existing)

The 27 root `*.md` and 128 `graphify-out/` files remain byte-for-byte unformatted;
they are prose / protected generated output and were out-of-scope to mass-edit.
The `stack` / `release-validation` Docker steps were subsequently executed for
real against the local stack (see A7), yielding 57 pass / 1 Sunday-only
fixture fail.

---

## I-2 status

- **Locally implemented:** `IMPLEMENTED` and, after this validation, `LOCALLY
  VERIFIED` for every Docker-free gate (fmt/lint now green; migrations, manifest,
  provenance, unit suite, frontend build/test/scan all pass).
- **GitHub Actions execution:** `UNPROVEN` — the correction was committed
  (`395eaa5`) and pushed to `origin/main` by the repository owner during the
  follow-up, but the workflow run itself has not been observed green on GitHub.
- **Consolidated regression:** `EXECUTED` against the local stack — 57 pass /
  1 fail; the failure is a pre-existing **Sunday-only test-harness date
  divergence** (E1 09), not a product defect (see A7).
- **Production claim:** `NONE`. Nothing was deployed; no credential exists.
