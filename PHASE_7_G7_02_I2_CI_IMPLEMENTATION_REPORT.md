# PHASE 7 — G7-02 I-2 CI/CD & RELEASE-CONTROL — IMPLEMENTATION REPORT

Execution date: 2026-09-19.
Work package: **G7-02 I-2 — CI/CD & Release-Control Layer** (extension of
`PHASE_7_G7_02_DEPLOYMENT_ARCHITECTURE.md` §21 I-2, following the closed I-1
hygiene package G7-03).

Status vocabulary: IMPLEMENTED · PROVEN (local) · PARTIALLY IMPLEMENTED ·
BLOCKED (environment) · UNPROVEN · PRE-EXISTING · FAIL · NOT PERFORMED.

> This package is **CI/CD implementation only**. It deploys nothing, creates no
> credential, provisions no environment, initializes no Git repo, changes no
> Git remote, and edits no application SQL / RLS / financial / worker /
> scheduler / Edge Function / frontend business behavior.

---

## 1. Scope

Authorized and implemented:

* CI workflow extensions (`.github/workflows/ci.yml`)
* migration-manifest enforcement (`scripts/validate_migration_manifest.ts`)
* frontend CI validation (new `frontend` job + `scripts/check_frontend_secrets.ts`)
* privilege linting (F16-04 mechanical guard — reused, not re-implemented; §6)
* consolidated regression path (curated `deno task test:consolidated`)
* release validation + provenance manifest (`scripts/release_manifest.ts`)
* dependency / lockfile integrity checks
* a self-test for the CI tooling itself (`tests/unit/migration_manifest_guard.test.ts`)

Explicitly out of scope (NOT performed): branch protection, GitHub environments,
staging/production, Supabase provisioning, secrets/Vault, DNS, frontend hosting,
Razorpay/Meta/SMTP, pilot onboarding, and any `git push`.

## 2. Baseline (re-verified this session, not assumed)

```text
git rev-parse --is-inside-work-tree        -> true
HEAD -> main                                -> 1b5bcb250a25bcbd5c2d1300ffeb6e96ec8fc12a
origin/main == origin/HEAD                  -> dfd98e74313498750c5d6b0611b27f23659b5df0
remote origin                               -> https://github.com/YeswanthArasavalli/Setura.git
G7-03 hygiene commit (main, unpushed)       -> "chore(hygiene): G7-03 repository hygiene + migration immutability baseline"
supabase/migrations                         -> 56 files, 01–56 sequential
MANIFEST.sha256 self-hash (reproduced)      -> 6efa633c8f427deebfa1ff63c8f1add321c2f0e75bbc8c7ad60c73d634c28d4e
```

`main` is one commit ahead of `origin/main` (the G7-03 hygiene commit). The
manifest self-hash recorded by G7-03 was reproduced byte-for-byte by this
session's provenance generator (§9) — deterministic-manifest evidence.

## 3. Existing CI inspected (before change)

`ci.yml` had **two jobs**: `quality` (fmt:check · lint · check ·
validate:migrations · unit tests) and `stack` (supabase start · migration
verify · `test:integration`). Both were preserved intact; no working check was
removed. `deno.json` command authority was extended additively (§5). Per the
brief §5 the pipeline was **extended, not replaced**, and no parallel CI
architecture was created.

## 4. Files changed

| File | Change |
| --- | --- |
| `.github/workflows/ci.yml` | Extended: 2 → 4 jobs (`quality`, `frontend`, `stack`, `release-validation`); added manifest + append-only, frontend, supply-chain, consolidated-regression and provenance steps |
| `scripts/validate_migration_manifest.ts` | NEW — migration-manifest integrity + append-only verifier |
| `scripts/check_frontend_secrets.ts` | NEW — built-bundle secret & source-map scanner |
| `scripts/release_manifest.ts` | NEW — release-candidate provenance manifest generator |
| `tests/unit/migration_manifest_guard.test.ts` | NEW — 10 unit tests proving the verifier's decision logic |
| `deno.json` | +4 tasks (`test:consolidated`, `validate:migration-manifest`, `check:frontend-secrets`, `release:manifest`) |
| `.gitignore` | +`release/` (generated provenance is never a committed source artifact) |
| `PHASE_7_PRODUCTION_READINESS_RECONCILIATION.md` | Factual update to G7-02 CI / manifest-enforcement / frontend-CI / provenance rows only |

**No SQL, RLS, financial, worker, scheduler, Edge Function, or frontend
business-logic file was modified.**

## 5. Migration-manifest enforcement

`scripts/validate_migration_manifest.ts` performs the §8 battery: enumerates
`*.sql`, parses `NN_` prefixes, detects duplicate prefixes, detects ordering
violations, computes SHA-256 (`crypto.subtle`), loads `MANIFEST.sha256`,
compares expected vs current hashes, detects files present-on-disk-but-absent-
from-manifest and manifest-entries-with-no-file, emits deterministic (sorted)
output, and exits non-zero on any integrity failure.

Append-only model (brief §9): the verifier accepts a **new migration only when
the manifest is extended in the same change**. `--update` performs that extend
deterministically **without editing any existing line**, so a legitimate
migration never forces a history edit. In a PR, the `quality` job additionally
runs the verifier with `--baseline-manifest` extracted from the PR base commit
(`git show <base_sha>:…/MANIFEST.sha256`). That baseline comparison is what
enforces "01–56 hashes unchanged": editing an already-baselined migration **and
rewriting its manifest line** is still caught as `baseline-modified`, and a
migration inserted before/between the baseline is caught as `baseline-insert`.
The manifest is not required to stay byte-identical forever — it must only
evolve by appending.

CI MFAIL conditions implemented: changed listed hash · disappeared file · file
absent from manifest · out-of-order insert · duplicate numeric prefix · invalid
ordering · stale/unreproducible manifest. Historical edits **before** the G7-03
baseline remain unprovable and are **not** claimed to be detectable (brief §7).

## 6. Privilege lint (F16-04 mechanical guard)

The brief §10 warned against a fragile grep. The repository already owns a
non-fragile guard: `scripts/validate_migrations.ts` implements PRIVILEGE
REGRESSION DETECTION rules P1–P8 over whole SQL **statements** (comments and
dollar-quoted bodies stripped), with `PRIVILEGE_BASELINE = 48`. For any
post-baseline migration it fails (ERROR) when a **new** `SECURITY DEFINER`
routine ships without an explicit GRANT/REVOKE naming it (P1) or without `SET
search_path` (P2). That is exactly the F16-04 obligation
("a new/resignatured SECURITY DEFINER function needs its own explicit REVOKE").

Decision: **reuse the existing primitive; do not build a competing grep.** The
`quality` job runs `deno task validate:migrations` and the guard is named as an
explicit pipeline step for auditability.

Honest limitations (reported, not hidden):

* The guard is a **full-repo static** check over post-baseline migrations, not a
  changed-files diff. A PR that adds `57_*.sql` with an under-privileged
  `SECURITY DEFINER` function therefore fails CI today; scoping to changed files
  adds no safety and was not built.
* `CREATE OR REPLACE` of an existing signature preserves the prior ACL and is
  (correctly) not flagged — a reshape that genuinely changes privileges must
  still state them.
* The static lint does **not** replace the runtime catalog privilege verification
  (Gate G / G7-04), which stays production-BLOCKED. CI green here is not a
  privilege-safety certification.

## 7. Frontend CI

New `frontend` job runs, in order: `npm ci` (fails if `package-lock.json` and
`package.json` disagree — lockfile integrity), `npm run typecheck`,
`npm run build` (production build with placeholder public `VITE_*` values only),
`npm run test` (vitest), then `deno run scripts/check_frontend_secrets.ts dist
--deny-sourcemaps`.

`check_frontend_secrets.ts` scans the **built bundle** (the trustworthy surface,
because Vite inlines `import.meta.env` at build time) for forbidden server
markers — `SUPABASE_SERVICE_ROLE_KEY`, a `"role":"service_role"` JWT claim,
`RAZORPAY_KEY_SECRET`, `META_APP_SECRET`, `CRON_SECRET`, `WORKER_SECRET`, and
the Vault-held `setura_scheduler_api_key` / `setura_cron_secret` — and reports
any emitted `.map` source-map files (fatal under `--deny-sourcemaps`). CI uses
placeholder/local-safe values only; **no secret was added**.

Source-map policy: the current production build emits **no** source maps
(Vite default `build.sourcemap` is `false`); `apps/web/vite.config.ts` was not
modified (§4 prohibits behavior edits). The `--deny-sourcemaps` flag
mechanically enforces that documented policy, and the source-map config choice
itself is recorded here rather than silently changed.

## 8. Consolidated regression

`deno task test:consolidated` runs one curated set against a single freshly
reset stack: **E1** (`hospital_core_journey`), **W1** (`worker_lifecycle`,
`worker_lease_persistence`, `worker_job_failure`), **scheduler**
(`scheduler_autonomy`), **financial** (`booking_fee_refund`, `refund_sync`,
`settlement_record_payment`) and **security** (`security_s1`). It is executed in
the `release-validation` job (a release check), while the PR-blocking `stack`
job continues to run the full `test:integration`. This separates PR checks from
release checks (brief §12) and does not turn every expensive/manual check into
per-PR CI.

Scheduler boundary (brief §15): the consolidated path exercises the already
locally-proven deterministic scheduler behavior (`scheduler_autonomy`, G7-07).
It does **not** and cannot prove a production scheduler; that remains a later
deployment gate.

## 9. Release validation / provenance

`deno task release:manifest` writes `release/manifest.json` (git-ignored,
CI-regenerated) with: `commit_sha`, `branch`, `tag`, `source_revision`,
`migration_manifest_sha256`, `migration_count`, `frontend_build_hash`, a
`results` block (`backend`/`frontend`/`security`/`worker`/`scheduler`/
`financial`/`build`), `generated_at`, plus an explicit
`deployment: "NOT PERFORMED"`.

Integrity properties, all locally observed:

* Inputs come from CLI flags → env vars → honest default `UNPROVEN`; an
  unrecognised status token degrades to `UNPROVEN`, **never** to `PASS`.
* `migration_manifest_sha256` reproduced G7-03's recorded hash
  `6efa633c…` exactly (deterministic).
* `deployment` is hard-coded `NOT PERFORMED`; no field asserts a production or
  staging deployment. Only commit/branch/tag names, hashes and counts appear —
  **no secret values**.
* In the `release-validation` job the PASS-valued manifest is emitted only under
  `if: success()`; a failed regression emits the UNPROVEN-default manifest
  instead. BLOCKED/UNPROVEN are never promoted to PASS.

Versioning (brief §18): only the validation/provenance **mechanism** was built;
the existing `DEPLOYMENT_VERSION` plumb-through was not redesigned and no release
tag was created or pushed.

## 10. GitHub Actions safety

The workflow triggers on `push:main`, `pull_request`, `workflow_dispatch` and
contains **no** `supabase db push`, `supabase functions deploy`, `supabase
secrets set`, no `environment:` (production/staging) declaration, and no deploy
step. It is VALIDATE-ONLY (brief §19). The only `supabase` use is the existing
local `supabase start`. Failure policy: no `|| true` on a check's verdict, no
`continue-on-error`, no downgraded security step, no weakened assertion. The one
`|| true` in the drift-check step guards a *re-run* of `deno task check` whose
verdict is already enforced by the dedicated Type-check step; the gate that
follows (`git diff --exit-code deno.lock`) fails the job on real lockfile drift.

## 11. Local test results (evidence)

Backend / CI tooling (all run in this environment):

```text
deno task validate:migration-manifest      -> 56 migration(s), 56 manifest line(s), 0 issues, exit 0
manifest verifier unit tests               -> 10 passed / 0 failed (tamper/append/reorder/dup/missing/unmanifested/determinism)
deno task test (full unit suite)           -> 91 passed / 0 failed  (was 81; +10 new, no regression)
deno task validate:migrations              -> 0 errors, 4 pre-existing [duplicate-objects] warnings
deno lint <4 new files>                    -> exit 0 (no new lint problems)
deno fmt --check <6 changed files>         -> exit 0 (no new fmt failures)
deno check <each new script>               -> exit 0
```

Frontend (real `apps/web`, node_modules present):

```text
npm run typecheck   (tsc --noEmit)          -> exit 0
npm run build       (tsc --noEmit && vite build) -> exit 0; emits index.html + 1 css + 1 js, 0 .map files
check_frontend_secrets.ts dist --deny-sourcemaps -> 3 artifact(s), 0 secret hits, 0 source maps, exit 0
npm run test        (vitest)                -> 3 files passed, 17 tests passed, exit 0
```

Functional negative probes (synthetic fixtures, throwaway dirs):

```text
manifest verifier   tampered/absent/dup/reorder/baseline-edit  -> each produces the expected error class + exit 1
release manifest    --backend PASS --security BLOCKED          -> PASS recorded, BLOCKED preserved (not promoted)
release manifest    absent inputs                              -> UNPROVEN defaults
secret scanner      leak + .map fixture                        -> secret-leak ERROR + exit 1; clean tree -> exit 0
```

## 12. Environment-blocked tests

```text
deno task check (full — imports esm.sh for Edge Functions)  -> BLOCKED (environment/network): hangs resolving remote deps in this sandbox.
   New CI scripts are self-contained (Deno + Web APIs only) and were each type-checked offline (exit 0).
deno task test:consolidated / test:integration              -> NOT EXECUTED locally: requires a running local Supabase stack, which was
   not started in this session (brief §22: do not fight the environment). Task composition is validated (all named files exist, task registered).
GitHub Actions actual execution                              -> UNPROVEN: no push was made and the remote workflow was not triggered.
```

## 13. Pre-existing failures (not introduced, not silently fixed)

* `deno fmt --check` (filesystem-wide) fails on the G7-03-recorded baseline of
  ~143 unformatted files (Phase 6 `apps/web` TSX + tracked generated markdown).
  The `quality` job's Format-check step preserves this existing check unchanged.
  Because `graphify-out/*.md` is tracked (D8 deferred), a clean GitHub checkout
  would very likely surface this pre-existing failure on the `main` pipeline.
  This is PRE-EXISTING; it was neither introduced nor "fixed" here (fixing it
  would be an unasked mass rewrite).
* `deno lint` — 8 pre-existing problems in files this package did not touch;
  unchanged. This package added zero new lint problems.

## 14. Security review

No new authorization surface, no secret handling added, RLS/privilege posture
untouched. The privilege guard was **reused**, not weakened. The frontend
scanner strengthens the §9 boundary (server-secret markers must never reach the
bundle). The workflow adds no deploy capability and grants no new privileges.
`check:frontend-secrets` matching is literal-substring over secret **names**, so
a match is either a genuine leak or a dead reference — both worth failing on;
this is a build-artifact hygiene check, not a general secret scanner.

## 15. Secret review

No secret values are read, printed, written, or committed by any new script or
workflow step. `release/manifest.json` records names/hashes/counts only. The
frontend job injects only placeholder public `VITE_*` values. `.env.example` and
`apps/web/.env.example` were not modified. `release/` is git-ignored so the
generated provenance (which embeds commit/build hashes) is never committed.

## 16. Git diff review

Staged set is limited to: `.github/workflows/ci.yml`, `deno.json`, `.gitignore`,
the three new `scripts/*.ts`, the new `tests/unit/*.test.ts`, this report, and
the reconciliation update. **No SQL / migration / Edge Function / frontend
application / RLS / financial / worker / scheduler file appears in the diff.**

**Unrelated dirty state excluded from this commit:** `git status` lists changes
under `graphify-out/` (a regenerated navigation index, a new dated snapshot, and
cache entries). These were **not** produced by this package (no Graphify command
was run), D8 remains DEFERRED, and AGENTS.md §4 forbids touching `graphify-out/`
/ `GRAPH_REPORT.md`. They are deliberately left unstaged and uncommitted.

## 17. Commit SHA

See §21 — a single local commit was created on `main` (message
`ci: implement G7-02 release validation pipeline`); read it back with
`git log --oneline -1`. A commit cannot embed its own final SHA.

## 18. Remote SHA

`origin/main` = `dfd98e74313498750c5d6b0611b27f23659b5df0` — **unchanged**.
`main` advanced to the G7-03 hygiene commit `1b5bcb2` and now to this I-2 commit,
both local-only. No push was performed.

## 19. What was NOT performed

No `git push` · no remote/branch change · no branch protection · no GitHub
environments (staging/production) · no Supabase project create/link · no hosted
`db push`/`functions deploy`/`secrets set` · no Vault/secret creation · no DNS ·
no frontend hosting · no Razorpay/Meta/SMTP credentials or webhooks · no real
payments or WhatsApp messages · no pilot tenant · no application SQL/RLS/
financial/worker/scheduler/auth behavior change · no applied-migration edit ·
no history rewrite · no release tag.

## 20. Remaining G7 decisions (unchanged by I-2)

D3 (GoTrue seed defect) · D5 (backup/PITR tier) · D6 (`ENABLE_WORKER_TRIGGER`
prod default) · D7 (hosted pg_cron/pg_net/Vault probe) · D8 (graphify-out
tracking — still DEFERRED; unrelated graph drift left uncommitted) · D9
(resolved in G7-03: untracked) · D10 (frontend host) · D11 (remote/provider/org)
· D12 (`jwt_expiry`) · D13 (integration credentials) · D14 (branch-protection
admins) · D15 (evidence-log retention). CI/CD GitHub execution (Gate B), staging
(Gate …), and production remain to be proven in later packages (I-3+).

## 21. Final status

```text
G7-02 I-2:                       PARTIALLY IMPLEMENTED (config + local tooling IMPLEMENTED; GitHub execution UNPROVEN)

CI configuration:                IMPLEMENTED  (ci.yml extended to 4 jobs; 4 tasks registered; YAML parses cleanly)
CI GitHub execution:             UNPROVEN     (no push; workflow never triggered on GitHub)
Migration immutability enforcement:IMPLEMENTED + PROVEN locally (verifier green on real tree; failure modes unit-proven 10/10)
                                 GitHub execution UNPROVEN
Privilege lint (F16-04 guard):   REUSED existing validate:migrations P1/P2 — PROVEN as a static CI step locally; not a new grep; runtime catalog proof stays UNPROVEN (Gate G)
Frontend CI:                     PROVEN locally (typecheck · build · vitest 17/17 · secret/scan green) · GitHub execution UNPROVEN
Consolidated regression path:    IMPLEMENTED (task + composition valid) · execution BLOCKED locally (no stack) · UNPROVEN on GitHub
Release provenance:              IMPLEMENTED + PROVEN locally (deterministic; honest UNPROVEN defaults; no PASS fabrication)
                                 — mechanism only, no deployment record
Deno full type check:            BLOCKED in this environment (network/esm.sh); new scripts self-checked green offline
Pre-existing fmt/lint baseline:  UNCHANGED by I-2 (documented, not fixed, not hidden)

Production:                      NOT STARTED
Staging:                         NOT STARTED
Credentials:                     NOT CREATED
Deployment:                      NOT PERFORMED
Push:                            NOT PERFORMED
```

HARD STOP. The next possible package is **G7-02 I-3 — Branch Protection &
Environment Controls**, which must NOT start without separate authorization.
