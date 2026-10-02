# GEN-TYPES & REPOSITORY HYGIENE REMEDIATION — REPORT

Workstream: post-C2 maintenance/remediation (Track A generated types,
Track B repository hygiene). C2 was **not** reopened.

## 1. Executive Summary

**CLEANLY RESOLVED**

- Track A: `database.generated.ts` drift independently verified and safely
  regenerated. `deno task gen:types:check` now PASSes.
- Track B: repo-wide `lint` and `fmt:check` now PASS with narrow, justified
  changes only (one `.gitignore` rule, three disposable scratch artifacts
  removed, four exact files reformatted). No product behavior changed.

## 2. Baseline

| Item | Value |
| --- | --- |
| HEAD | `0fceb50b0ca9b9971af1bebb3938583b78ace4dd` (`main`) — matches expected baseline |
| Last commit | `0fceb50 Add Hospital Operations Analytics Read Surface (G-11)` |
| Migration frontier (disk) | `64_c2_alert_rpc_locked_snapshot.sql` (64 migrations) |
| Migration frontier (live local DB registry) | `64` (top of `supabase_migrations.schema_migrations`) |
| Local Supabase stack | running; `supabase_db_setura` healthy, `supabase_edge_runtime_setura` up (verified by container state, not exit codes) |

Pre-existing working-tree state at start (owner's uncommitted C2 closure,
NOT created or altered by this task): modified `supabase/functions/alert-center/index.ts`,
`tests/integration/alert_center_http.test.ts`,
`tests/integration/enterprise_command_center.test.ts`,
`graphify-out/cache/stat-index.json`; untracked migration 64 + C2 report set.
This task added no changes to any of these.

## 3. Generated Types Investigation

- Exact command: `deno task gen:types:check`
  → `deno run --allow-run=supabase --allow-read scripts/gen_types.ts --check`.
- Mechanism: shells out to `supabase gen types typescript --local` against the
  live local DB; compares bytes to
  `supabase/functions/_shared/database.generated.ts`; also enforces
  BOM-less UTF-8. Output path is the committed file.
- Baseline reproduction: **FAIL exit 1** — `database.generated.ts is stale`.
- Independent temporary generation (§5.4): a throwaway script mirroring
  `gen_types.ts` decode/normalize/header logic wrote to a temp file only; the
  committed file was untouched. Byte-fair diff vs the committed file:

  **Exactly one hunk, 4 added lines, zero deletions:**

  ```ts
  user_is_same_hospital_doctor: {
    Args: { p_user_id: string }
    Returns: boolean
  }
  ```

- Classification of every difference: **PRE-EXISTING DRIFT = EXPECTED CURRENT
  SCHEMA** — the `Functions` type entry for the SECURITY DEFINER function
  created by migration 61 `staff_doctor_directory_read` and re-defined
  (same signature) by migration 62 `staff_doctor_directory_read_convergence`.
  Root cause: the committed snapshot predates migration 61 and was never
  regenerated; function existence/signature is generator-visible.
- Migration 64 contribution: **NONE**. The diff contains no alert-RPC delta;
  migration 64 replaces function bodies with identical signatures and
  `jsonb` returns, which are invisible to the generator. Confirmed
  independently, agreeing with `C2_ALERT_LIFECYCLE_CLOSURE_VERIFICATION.md` §7/§8.
- Migrations 62/63 contribution: 62 is a same-signature `CREATE OR REPLACE`
  (no additional delta); 63 is pure GRANT/REVOKE (invisible to the generator).
- Ownership: migration-61 workstream (staff doctor directory read),
  pre-existing, non-C2.

## 4. Generated Types Changes

- File changed: `supabase/functions/_shared/database.generated.ts`.
- Action: `deno task gen:types` (Outcome A — regeneration produces only the
  legitimate current-schema change).
- Post-regeneration `git diff` of the file: exactly the 4-line
  `user_is_same_hospital_doctor` block; byte-identical to the independently
  temp-generated file (same git blob hash `5945c62`).
- Schema basis: live local DB at migration 64; function present in
  `pg_proc` (count=1 verified before regeneration).
- No forbidden techniques used (no @ts-ignore, no check disabling, no
  hand-editing, no exclusions added).
- `deno task gen:types:check` after regeneration: **PASS**
  (`database.generated.ts is UTF-8 and up to date.`).

## 5. Repository Hygiene

Enumerated failures (before changes): `deno task lint` → 1944 problems,
102 files checked; `deno task fmt:check` → 11 not-formatted files in 176.

| Artifact | Tracked? | Classification | Action | Why safe |
| --- | --- | --- | --- | --- |
| `_authloop_served_bundle.js` | untracked | Scratch/debug: downloaded served app bundle (reproducible via `_authloop_dl.ps1`); sole source of ALL 1944 lint errors; already called a "leftover" in the G-11 report | **Removed** | Disposable debug capture of a closed investigation; not evidence cited by any report |
| `_g09_status.json` | untracked | Scratch: failed console capture, not even valid JSON (`Unexpected token` in fmt parse); uncited | **Removed** | Contains no recoverable information; no report cites it |
| `_patch_root.json` | untracked | Scratch: one-off Vercel `rootDirectory` patch payload; uncited as evidence | **Removed** | Disposable, completed one-off input |
| `.vercel/project.json` | untracked | Local CLI state (machine-local projectId/orgId pointers, no secrets) | **`.gitignore` rule `.vercel/` added** (narrow, explained) | Mirrors existing `.vercel-tmp/`; standard Vercel-CLI-local state; removing it from git discovery also drops it from fmt/lint scope |
| `c1_cancel_pre_state.json` | **tracked** | Required evidence artifact (cited in `PHASE_7_C1_CONTROLLED_STAGING_CANCELLATION_REPORT.md` §5, G-02/G-03/G-05 reports) | **Reformatted only** (`deno fmt` on the exact path; line-endings diff) | NOT deleted; committed blob unchanged (git diff empty after autocrlf normalization) |
| `supabase/functions/_shared/cors.ts` | tracked | Required source; failure is **line-endings only** (`i/lf w/crlf`, local `core.autocrlf=true` from Git-for-Windows global config) | **Reformatted working copy** (LF); repo content unchanged (empty `git diff`) | Byte-level working-copy change is invisible to commits; no semantic edit |
| `supabase/functions/_shared/env.ts` | tracked | Same as cors.ts | Same as cors.ts | Same |
| `tests/integration/consultation_notes_read.test.ts` | tracked | Pre-existing genuinely-unformatted committed file (long-line wrapping; cited as pre-existing red since G-03/G-05 reports) | **`deno fmt` on the exact path** — 63-line format-only diff | Only file with a real tracked content change; format-only (deno fmt guarantee); suite re-run green (20/20) |
| Task-scratch files created by this task (`_hygiene_gen_temp.ts`, `_gen_types_temp.ts`, `_hy_lint.json`, `*.tmp`, `*.txt` summaries) | untracked | Disposable | **Removed** | Owned by this task |

`_g09_staging_matrix.ps1` / probe `.ps1` / screenshot `.png` / other untracked
`_authloop_*` remnants: NOT lint/fmt failures (deno does not check
`.ps1`/`.png`); left untouched — broader scratch-file disposition remains the
open D15 evidence-retention decision, out of this task's scope.

Results after changes: `deno task lint` → **exit 0** (99 files, 0 problems);
`deno task fmt:check` → **exit 0** (169 files). No lint/format rule or
exclusion was weakened; no source errors hidden.

## 6. Validation Matrix

| Check | Result | Evidence |
| --- | --- | --- |
| `gen:types:check` | PASS | exit 0, "UTF-8 and up to date" (was exit 1 stale) |
| typecheck (`deno task check`) | PASS | exit 0 |
| lint (`deno task lint`) | PASS | exit 0, "Checked 99 files", 0 problems |
| format (`deno task fmt:check`) | PASS | exit 0, "Checked 169 files" |
| migration validation (`deno task validate:migrations`) | PASS | exit 0; 0 errors / 4 pre-existing `[duplicate-objects]` warnings (documented baseline) |
| unit tests (`deno task test`) | PASS | 97 passed / 0 failed |
| affected integration suites | PASS | `staff_doctor_directory.test.ts` + `consultation_notes_read.test.ts`: 20 passed / 0 failed, exit 0 (live local stack) |
| C2 regression (HTTP lifecycle suite) | PASS | `alert_center_http.test.ts`: 28 passed / 0 failed, exit 0 (run because `cors.ts`/`env.ts` working copies were byte-modified; repo blobs unchanged) |

Environment: all checks run against the live local Supabase stack on this
machine. **Local verification only — staging/production remain UNPROVEN and
are outside this task.**

## 7. C2 Protection

- C2 migration 64 unchanged (never edited, still untracked as at baseline).
- C2 RPCs unchanged (no SQL edited by this task beyond none).
- C2 Edge transport unchanged (`alert-center/index.ts` untouched — its
  working-copy diff is the owner's pre-existing one, identical at end).
- C2 tests unchanged (`alert_center_http.test.ts` not modified; only executed).
- C2 behavior unchanged; C2 HTTP lifecycle suite re-run green (28/28).
- The regenerated types block contains no alert-RPC change (migration-64
  functions already existed in the snapshot with identical signatures).

## 8. Remaining Issues

- RESOLVED BY THIS TASK: generated-type drift (migration-61 block); repo-wide
  lint red; repo-wide fmt red; `.vercel/` tracking gap.
- PRE-EXISTING (left, documented): untracked-but-required? — no; the large set
  of untracked scratch `.ps1`/`.png`/`.json`/`.raw`/`.txt` root artifacts and
  untracked C2-era report `.md` files (owner's commit decision); D15 evidence
  log retention policy; `graphify-out/` tracking decision D8; F16-05/F16-06
  test-quality findings (separate workstreams per closure doc).
- OUT OF SCOPE: staging/production verification; C2 commit; scheduler (NPD-05);
  P0-01..P0-04 status (not re-examined here).
- BLOCKED: none.

## 9. Final Verdict

Track A and Track B are both cleanly resolved **locally**: the four static
checks (`gen:types:check`, `check`, `lint`, `fmt:check`), migration validation,
unit tests, the two affected integration suites, and the C2 HTTP regression
suite all passed on this machine at this HEAD + working tree. No repository-
wide health claim is made beyond that evidence; CI reachability and remote
environments were not exercised by this task.

---

```text
TASK:
GEN-TYPES + REPOSITORY HYGIENE

STATUS:
CLEANLY RESOLVED

GENERATED TYPES:
Drift independently verified (single 4-line user_is_same_hospital_doctor
block from migration 61; zero migration-64 contribution); regenerated
database.generated.ts; gen:types:check PASS.

REPOSITORY HYGIENE:
lint PASS (0 problems), fmt:check PASS; one narrow .gitignore rule (.vercel/);
three disposable untracked scratch artifacts removed; four exact files
reformatted (three line-endings-only with unchanged repo blobs, one genuine
format-only fix in consultation_notes_read.test.ts).

FILES CHANGED:
supabase/functions/_shared/database.generated.ts (regenerated, +4 lines)
.gitignore (+1 narrow rule, explained)
tests/integration/consultation_notes_read.test.ts (deno fmt, format-only)
c1_cancel_pre_state.json / supabase/functions/_shared/cors.ts /
supabase/functions/_shared/env.ts (working-copy line-endings only; empty
git diff — committed content unchanged)

FILES REMOVED (untracked scratch, classified per policy):
_authloop_served_bundle.js, _g09_status.json, _patch_root.json (+ this
task's own temporary files)

FILES NOT CHANGED:
all C2 files (migrations 47/48/64, alert-center function, C2 tests, RPCs,
grants/RLS, frontend), all other source, all other migrations, deno.json
lint/fmt configuration, all reports except the new one.

VALIDATION:
gen:types:check PASS · check PASS · lint PASS · fmt:check PASS ·
validate:migrations PASS (0 errors, 4 known warnings) · unit 97/97 ·
affected integration suites 20/20 · C2 HTTP suite 28/28 (all local)

C2:
UNCHANGED — regression verified (HTTP lifecycle suite re-run green)

REMAINING PRE-EXISTING ISSUES:
root scratch-artifact disposition (D15), graphify-out tracking (D8),
F16-05/F16-06 test-quality findings, staging/production UNPROVEN.

COMMIT:
NOT CREATED

PUSH:
NOT PERFORMED

DEPLOYMENT:
NOT PERFORMED
```
