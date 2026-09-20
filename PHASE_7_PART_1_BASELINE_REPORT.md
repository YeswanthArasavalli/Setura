# SETURA Part 1 — Current-State Baseline Report

Execution date: Sunday, 2026-09-20 (a genuine Sunday run — the consolidated
suite passing today is itself a live re-proof of the E1-09 determinism fix).

Status vocabulary per package §17. Every claim below is backed by a command
actually executed in this session; historical reports were used only as
context, never as proof of current state.

---

## 1. Execution date

2026-09-20 (Sunday), local Windows machine, Deno 2.x task runner, Docker
29.6.2, live local Supabase stack.

## 2. Repository identity

- Remote: `https://github.com/YeswanthArasavalli/Setura.git` (`git remote -v`).
- User-owned personal repo (`YeswanthArasavalli/Setura`), not an org.
- Working tree **IS** a Git repository. (AGENTS.md §13's "no `.git`" note is
  out of date — superseded by direct `git` execution, all commands succeeded.)

## 3. Git state

```text
branch        = main
HEAD          = eb982a735539ed8b280ac8009f2f5a7e1f3be558
                ("Fix E1-09 determinism: anchor clinicDate")
origin/main   = eb982a7 (identical)
ahead/behind  = 0 / 0
working tree  = CLEAN (`git status --porcelain` empty; `git diff` empty)
```

The E1-09 fix, previously an uncommitted working-tree change, is now
**committed and pushed** (HEAD == origin/main). Last 10 commits inspected;
HEAD lineage: eb982a7 ← 2c53638 ← 395eaa5 ← 514c337 ← aa766eb ← 1b5bcb2 ← …

## 4. Repository inventory

| Item | Count |
| --- | --- |
| Migrations (`supabase/migrations/*.sql`) | 56 |
| Migration manifest lines (`MANIFEST.sha256`) | 56 |
| Edge Functions (`index.ts` under `supabase/functions/`, incl. `_shared`) | 26 dirs |
| Integration tests (`tests/integration/*.test.ts`) | 19 |
| Unit test files (`tests/unit/*.test.ts`) | 9 (91 tests) |
| CI workflow files | 1 (`.github/workflows/ci.yml`); no other `.github` files |
| Lockfiles | `deno.lock`, `apps/web/package-lock.json` |
| Env templates | `.env.example`, `apps/web/.env.example` (no real `.env`) |
| `deno.json` tasks | 14 (incl. `test:consolidated`, `validate:migration-manifest`, `check:frontend-secrets`, `release:manifest`) |
| Deployment-related files | NONE — no deploy workflow, no Dockerfile/deploy target in CI (validate-only by design) |

No generated/protected Graphify output was modified; no cleanup performed.

## 5. E1-09 test fix verification

Verified against the **actual commit diff** (`git show eb982a7`), not the
filename or the report:

| Check | Result |
| --- | --- |
| Sunday→Monday rollover removed | PASS — `if (d.getDay() === 0) d.setDate(+1)` deleted from `clinicDate()` |
| Fixture anchored to actual current date | PASS — `new Date()`, no offset |
| Weekday derived consistently | PASS — same `Date` object: `weekday: d.getDay()` |
| Doctor schedule uses that weekday | PASS — fixture inserts `weekday: CLINIC.weekday` (test L402/L410) |
| E1-09 invariant still checked | PASS — `assertEquals(startResult.queue_session_id, J.sessionId)` at L879 |
| No assertion weakened | PASS — diff is 1 deleted line + comment rewrite only |
| No Sunday skip | PASS — no conditional skip in file |
| No timing hack | PASS — no sleep/setTimeout introduced |
| No production API parameter added | PASS — commit touched ZERO production files (see §17) |

Commit eb982a7 file census: `tests/integration/hospital_core_journey.test.ts`
(+12/−5) and 3 root `.md` reports. `git show eb982a7 -- supabase/ apps/
scripts/ deno.json .github/` → **empty**. The E1-09 change is genuinely
test-only. NOT reverted, NOT weakened.

## 6. Unit test results

```text
deno task test  ->  91 passed | 0 failed   (exit 0, verified via $LASTEXITCODE)
```

**91/91 PASS — LOCALLY VERIFIED this session.**

## 7. Consolidated test results

Live stack confirmed running first (`docker ps`: `supabase_db_setura` healthy;
`supabase_edge_runtime_setura` Up — verified running per F16-01 discipline,
not inferred from an exit code).

```text
deno task test:consolidated  ->  58 passed | 0 failed (24s)
```

Coverage actually executed: E1 hospital_core_journey 18/18, W1
worker_lifecycle / worker_lease_persistence / worker_job_failure,
scheduler_autonomy, financial booking_fee_refund / refund_sync /
settlement_record_payment, security_s1. The "w1 deterministic failure" log
lines are the intentional self-test (job deliberately throws → retried →
dead-lettered), not a defect.

**58/58 PASS — LOCALLY VERIFIED this session, on a Sunday run.** Matches the
previous verified baseline (E1 18/18, consolidated 58/58) exactly.

## 8. Frontend results

Executed in `apps/web` using the actual `package.json` scripts, exactly as the
CI `frontend` job does (build with placeholder local-safe `VITE_*` values):

```text
npm ci                       -> exit 0 (lockfile-integrity install)
typecheck (tsc --noEmit)     -> exit 0  PASS
build (tsc --noEmit && vite) -> exit 0  PASS (dist emitted, 453.42 kB JS)
vitest (npm run test)        -> 17 passed / 0 failed (3 files)  PASS
secret + source-map scan     -> 3 artifacts, 0 secret hits, 0 source maps, exit 0
```

**Frontend baseline = PASS, identical to the historical baseline.** No
frontend behavior modified.

## 9. Migration results

```text
deno task validate:migrations        -> 56 scanned, 0 errors, 4 warnings
                                       (the documented pre-existing G7-03
                                       [duplicate-objects] baseline — not new)
deno task validate:migration-manifest-> 56 migrations / 56 manifest lines /
                                       0 integrity issues
prefix sequence                      -> 1..56, no gaps, no duplicates
                                       (direct enumeration)
```

Manifest hash integrity (disk ↔ `MANIFEST.sha256`) proves **no applied
migration was modified**. `git log -- supabase/migrations` shows no migration
file change since `1b5bcb2` (the hygiene commit that created the manifest);
nothing in Part 1 edited any migration, and none was needed.

**Migration baseline = PASS / LOCALLY VERIFIED.**

## 10. CI results

Inspected `.github/workflows/ci.yml`, `deno.json`,
`scripts/validate_migration_manifest.ts`, `scripts/check_frontend_secrets.ts`,
`scripts/release_manifest.ts`. Architecture unchanged: 4 jobs (`quality`,
`frontend`, `stack`, `release-validation`), validate-only, top-level
`permissions: contents: read` (B5) present, no `|| true` /
`continue-on-error`, honest UNPROVEN release defaults.

| Category | Items |
| --- | --- |
| WHAT EXISTS | 1 workflow, 4 jobs as documented above |
| LOCALLY EXECUTABLE + PROVEN | fmt:check (150 files, exit 0), lint (91 files, 0 problems), `deno task check` (exit 0), unit 91/91, validate:migrations 0 err, manifest 0 issues, frontend npm ci/typecheck/build/vitest/scan (all green), consolidated 58/58 |
| GITHUB-ONLY | actual Actions runner execution; `release-validation` on main-push; branch protection / required checks configuration |
| CURRENTLY PROVEN | every CI step's underlying command is green locally |
| REMAINS UNPROVEN | a green workflow run observed on GitHub servers (no server evidence read in this package; no `gh`/token — see §16) |

No CI redesign attempted (out of scope). **CI baseline = IMPLEMENTED; step
commands LOCALLY VERIFIED; GitHub-execution UNPROVEN.**

## 11. Worker results

Worker integration coverage executed in §7 against the live stack:
`worker_lifecycle`, `worker_lease_persistence`, `worker_job_failure` —
**PASS** (part of 58/58). Lease persistence and failure→DLQ behavior are
proven by those executed tests. No worker implementation changed in Part 1.

Recorded, not re-litigated (pre-existing, unchanged by any recent commit):
P0-01 `claim_jobs_v2` / `lease_expires_at` crash-reclaim concern remains in the
known-findings register; the G7-01 worker-reclaim report documents the current
position. **Worker baseline = PRESERVED, suite LOCALLY VERIFIED.**

## 12. Scheduler results

`scheduler_autonomy.test.ts` executed within the consolidated pass — **PASS**.
No scheduler implementation changed in Part 1. **Scheduler baseline =
PRESERVED, LOCALLY VERIFIED.** (Production scheduling infrastructure remains a
separate design-decision item — P0-02/NPD-05 — untouched here.)

## 13. Financial results

Relevant tests exist and were executed this session (§7):
`booking_fee_refund`, `refund_sync`, `settlement_record_payment` — **PASS**.
No financial logic redesigned or modified. No real payment transactions
created; no Razorpay credentials used (none exist locally). **Financial
baseline = PRESERVED, LOCALLY VERIFIED.**

## 14. Security baseline

Current-diff census against the last verified state (commits 2c53638 +
eb982a7 + intervening docs): the only non-`tests/` files changed are root
`*.md` reports. **Zero changes** to RLS, auth, authorization, privileges,
worker authentication, scheduler authentication, financial authorization or
the frontend secret boundary. Secret scan 0 hits (§8). Security S1 suite
executed green (§7).

**SECURITY BASELINE = PRESERVED.**

## 15. Production status

```text
production deployment      = NOT PERFORMED
production credentials     = NOT CREATED BY THIS PACKAGE
production Supabase        = NOT DEPLOYED
real Razorpay              = NOT USED
real WhatsApp              = NOT USED
production SMTP            = NOT CONFIGURED
```

Explicitly verified this session: no `supabase db push` / `functions deploy` /
`secrets set` run, no Vercel, no stack or target created. Local stack only,
as found.

## 16. GitHub governance status

Local Git only: remote/branch/HEAD/ahead-behind recorded in §2–§3
(in sync: 0/0). Server-side state re-probed: `gh` **not installed**,
`GITHUB_TOKEN` **unset**, `GH_TOKEN` **unset**. No GitHub CLI install or
authentication was attempted (prohibited in this package). No local claim is
made about branch protection, rulesets, required checks, environments or
server secrets.

**GitHub server-side governance = UNPROVEN / BLOCKED** (unchanged from G7-02
I-3; B3–B8 remain BLOCKED, B5 in-tree `permissions: contents: read` remains
IMPLEMENTED and present at HEAD).

## 17. Changed files

Part 1 changed **ZERO repository files** (all operations were read-only or
test executions; `npm ci` only rebuilt gitignored `node_modules`, `dist`
re-emitted by the build step as CI does).

Files changed between the last verified baseline (2c53638) and current HEAD
(eb982a7), verified by per-commit census: `tests/integration/hospital_core_journey.test.ts`
(test-only E1-09 fix), `PHASE_7_E1_09_TEST_DETERMINISM_FIX_REPORT.md` (new),
and addenda to the two G7-02 I-2/I-3 reports. All documentation/test — no
production SQL, migration, Edge Function, RLS, frontend, or CI change.

## 18. Known blockers

- **B-GH:** GitHub server-side governance (branch protection, required checks,
  environments, secret enumeration) — BLOCKED: no `gh`, no admin token.
- **B-UI:** GitHub Actions has not been *observed* green on GitHub servers —
  requires repository-hosted run evidence (access-blocked).
- Environment note (non-blocking): `supabase_vector_setura` was in a
  `Restarting` loop during inspection; it did not affect any executed test
  (all suites green against the same stack). Edge Runtime was verified Up
  before testing per F16-01 discipline.

## 19. Known unproven items

- Production deployment state — NOT DEPLOYED (nothing to prove; no target exists).
- GitHub server configuration (protection/rulesets/environments/secrets) — UNPROVEN.
- CI workflow execution on GitHub runners — UNPROVEN (locally every step command is green).
- Crash-reclaim of v2-claimed jobs under a real worker crash (P0-01 register item) — carries its prior status; NOT re-proven here and NOT modified.
- Production-scale / hosted-environment behavior of any kind — UNPROVEN by definition (local verification only).

Remaining Work (observed, deliberately NOT fixed per §18): AGENTS.md §13's
"not a Git repository" statement is now stale; scheduler design decision
(NPD-05/P0-02); GitHub admin access prerequisite; P0-04 `booking_fee_inr`
runtime-writer item; optional CODEOWNERS/Dependabot/CodeQL (none exist).

## 20. Current SETURA completion position

```text
Unit                     = 91/91 PASS  (re-executed today)
Consolidated regression  = 58/58 PASS  (re-executed today, Sunday, live stack)
E1 / W1 / Scheduler / Financial / Security S1 = PASS within that run
Frontend                 = npm ci + typecheck + build + vitest 17/17 + scan 0/0 PASS
Migrations               = 56/56 manifest-clean, validator 0 errors, unmodified
CI (local commands)      = all green
CI (GitHub execution)    = UNPROVEN
GitHub governance        = BLOCKED / UNPROVEN (B5 in-tree control PROVEN at HEAD)
Production               = untouched, NOT DEPLOYED
HEAD == origin/main == eb982a7, clean tree
```

The previously verified green baseline is **exactly reproduced and re-proven
today** — no drift, no regression, no fabricated status. SETURA stands at:
locally green, reviewable, committed and pushed; the entire remaining gap to
"deployed" is staging/production provisioning, GitHub server governance and
real-integration configuration — all explicitly deferred to later parts.

## 21. Part 2 readiness

**READY (conditional).** Part 2 (staging/deployment) can start from this
trusted baseline. Prerequisites Part 2 must resolve, established by this
report:

1. GitHub server-side access (`gh`/admin token) — currently BLOCKED; required
   for branch protection, required checks, Environments and secret storage.
2. A Supabase staging/production project — NOT CREATED (correctly out of Part 1 scope).
3. Real integration credentials (Razorpay test keys, WhatsApp tokens, SMTP) — none exist locally or remotely.
4. Vercel (or equivalent) frontend hosting — NOT STARTED (correctly out of scope).
5. CI green observed on GitHub runners — must be confirmed on the first Part 2 push.

No part of this baseline requires a production-code change to start Part 2.

---

PART 1 COMPLETE — see §20 for the trusted starting point. Hard stop respected:
no deployment, no provisioning, no credential creation, no architecture
modification, Part 2 not started.
