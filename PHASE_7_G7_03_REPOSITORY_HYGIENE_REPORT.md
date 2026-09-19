# PHASE 7 — G7-03 REPOSITORY HYGIENE & RELEASE BASELINE — EVIDENCE REPORT

Execution date: 2026-09-19.
Work package: **G7-03 — Repository Hygiene & Release Baseline** (`I-1` of
`PHASE_7_G7_02_DEPLOYMENT_ARCHITECTURE.md`).

Status vocabulary: PROVEN · IMPLEMENTED · BLOCKED · UNPROVEN · FAIL ·
NOT APPLICABLE · DEFERRED.

Scope honored: repository hygiene + migration immutability baseline only.
**No push, no remote change, no CI/CD, no staging, no production, no
credentials, no hosted deployment, no source/SQL/RLS/business-logic edit,
no history rewrite, no force-push.**

---

## 1. Executive result

**G7-03: COMPLETE — REPOSITORY HYGIENE + RELEASE BASELINE ESTABLISHED
(LOCAL COMMIT PREPARED; NOT PUSHED).**

A root `.gitignore` now exists, 218 confirmed local/generated/session
artifacts were removed from Git tracking (without deletion from disk), a
fully verified forward-immutability baseline
(`supabase/migrations/MANIFEST.sha256`, 56 migrations) was created, and
the tracked set was reduced from 539 → 321 files. Zero application source
or migration SQL content changed. One governance decision (D8) was
deliberately left deferred, not silently resolved.

---

## 2. Baseline before changes

Pre-hygiene HEAD (independently re-verified this session):

```text
git rev-parse --is-inside-work-tree  → true
HEAD                                  → dfd98e74313498750c5d6b0611b27f23659b5df0
branch                                → main
main == origin/main == origin/HEAD    → yes
tracked files (git ls-files)          → 539
root .gitignore                       → ABSENT (only apps/web/.gitignore)
```

Commit history (6 commits, `git log --oneline`):

```text
dfd98e7 (HEAD -> main, origin/main, origin/HEAD) Add Phase 7 readiness and worker-reclaim reports
12123c3 Add staff web frontend and security S1 tests
40d6b4a Fix booking refund and E1 runtime issues
dc21741 Fix worker lifecycle and scheduler regressions
cf046f6 Fix fail_job_v2 dead-letter handling
e593d1b Initial Setura project import
```

> Note vs G7-02 §1: G7-02 recorded 5 commits / 534 tracked files. The tree
> has since advanced by one commit (`dfd98e7`, the Phase 7 readiness +
> worker-reclaim reports) to 6 commits / 539 tracked. Recorded, not
> smoothed over.

---

## 3. Git repository verification

`.git` exists and `git rev-parse --is-inside-work-tree` returns `true`.
**This supersedes the stale AGENTS.md §13 claim that "the working tree is
NOT a Git repository."** Per the §5 truth hierarchy, runtime evidence
(the Git binary against the actual tree) outranks the documentation note.
G7-02 §1 already corrected this premise; G7-03 re-confirmed it.

## 4. Remote verification

```text
origin  https://github.com/YeswanthArasavalli/Setura.git (fetch)
origin  https://github.com/YeswanthArasavalli/Setura.git (push)
main == origin/main == origin/HEAD (all at dfd98e7)
```

Remote is a personal-account GitHub repo over HTTPS with **no embedded
credentials**. The remote was NOT modified, NOT queried for write, and NOT
pushed to during this package.

## 5. Tracked artifact inventory (before hygiene)

| Path | Tracked before | Classification |
| --- | --- | --- |
| `.remember/` | 0 (already ignored by its own `.gitignore`) | local scratch |
| `.ua/` | 95 | tooling cache (Understand-Anything) |
| `.qoder/repowiki/` | 116 | generated wiki (D9) |
| `supabase/.temp/` | 2 (`cli-latest`, `linked-project.json`) | Supabase CLI local state |
| `supabase/.branches/` | 1 (`_current_branch`) | Supabase CLI local state |
| root/session `*.log` | 13 | mixed — see §9 |
| `graphify-out/` | 70 | navigation index (D8) |
| `GRAPH_REPORT.md` | 1 | navigation index (D8) |
| application source / tests / migrations / functions / frontend / configs / root `*.md` reports / `.env.example` / CI | remainder | TRACKED — source of truth |

## 6. `.gitignore` changes

A root `.gitignore` was **created** (none existed). It ignores only
local/generated/tooling artifacts:

```text
.remember/
.ua/
.qoder/
supabase/.temp/
supabase/.branches/
node_modules/
*.log            # with explicit `!` allow-list for cited evidence logs
```

Deliberately NOT ignored: project source, tests, migrations, Edge
Functions, shared modules, frontend source, configuration, scripts, CI
workflow, `.env.example`, the migration `MANIFEST.sha256`, and the
authoritative root-level `*.md` evidence reports. `graphify-out/` is
present only as a **commented** line because D8 is deferred (§8); an
active ignore rule would misrepresent the deferred decision as resolved.

A generic `*.log` blanket was avoided as an evidence-hiding risk: the nine
run logs cited by Phase 7 completion reports are explicitly allow-listed
(`!_e1_run*.log`, `!_g701_*.log`, `!_g707_scheduler.log`,
`!_w1_test.log`, `!_integration_full.log`) so they remain trackable.

## 7. Files removed from tracking

`git rm --cached` (index-only; **nothing deleted from disk** — verified by
`Test-Path` returning True for representative paths afterwards):

| Group | Count |
| --- | --- |
| `.ua/` | 95 |
| `.qoder/repowiki/` | 116 |
| `supabase/.temp/` | 2 |
| `supabase/.branches/` | 1 |
| disposable tool-dump logs (`_fmtcheck.log` [28 MB], `_fmtsrc.log`, `supabase-reset.log`, `supabase-start.log`) | 4 |
| **Total removed from tracking** | **218** |

Tracked files: **539 → 321**.

`supabase/.temp/linked-project.json` (hosted-project link reference — local
environment state, not a credential) is now untracked per §8 of G7-02.
`graphify-out/` (70) was intentionally NOT untracked (D8 deferred).

## 8. Session-log classification (§9 of the brief)

- **A — disposable tool dumps (untracked):** `_fmtcheck.log` (28 MB
  generated format dump — also the single largest tracked blob),
  `_fmtsrc.log`, `supabase-reset.log`, `supabase-start.log`. Pure command
  stdout with no unique evidentiary role beyond what reports already
  summarize.
- **B — authoritative run evidence (retained tracked, allow-listed):**
  `_e1_run1..4.log`, `_g701_repro1.log`, `_g701_regression_worker.log`,
  `_g707_scheduler.log`, `_w1_test.log`, `_integration_full.log` — cited
  by the G7-01/G7-07/Phase 6 completion reports (e.g. `_g701_repro1.log
  4/4`, `_g701_regression_worker.log 7/7`). Per the brief these were NOT
  relocated (moving them would alter evidence provenance for no hygiene
  benefit).

The **general evidence-log retention policy remains open decision D15** —
this package made only the narrow technical removal of non-evidentiary
dumps and preserved everything the reports depend on.

## 9. Graphify decision — D8 — DEFERRED (not silently resolved)

`graphify-out/` + `GRAPH_REPORT.md` were **left tracked**. Inspection:
the index is reproducible (generated by the Graphify tool), but AGENTS.md
§4 designates it the repository's canonical navigation layer, and the
committed dated snapshots (`2026-08-23/`, `2026-08-27/`) carry historical
audit value. Whether to version it is genuinely a project-governance
workflow decision, not a pure hygiene call, and G7-02 explicitly recorded
it as DEFERRED. Per the brief's §6 instruction, uncertainty is **not**
pretended to be resolved: **D8 — DEFERRED.**

## 10. Qoder decision — D9 — RESOLVED (untracked)

`.qoder/repowiki/` (116 files) is generated documentation. Verified: it is
**not** a build input, **not** a runtime input, **not** referenced by CI,
and the only non-generated references to `.qoder` anywhere are inside other
generated artifacts (`graphify-out/manifest.json`). Its removal changes no
product behavior. This is a pure repository-hygiene decision, so it was
resolved technically: **untracked, files preserved on disk.**
**D9 — RESOLVED (untrack).**

## 11. Secret scan

Repository-wide scan of tracked files (`git ls-files` + content grep) for
`.env`/`.env.local`, private keys, service-role keys, Razorpay/Meta
secrets, `CRON_SECRET`/`WORKER_SECRET`, SMTP/database passwords, tokens
and embedded credentials:

- Tracked env files: `.env.example`, `apps/web/.env.example` — **placeholder
  values only.**
- `apps/web/.env.local`: present on disk but **not tracked** (covered by
  `apps/web/.gitignore`).
- No private keys, service-role keys, or gateway/webhook secret values in
  any tracked file.
- One literal JWT in `apps/web/e2e/core_journey.mjs` is the standard
  Supabase **local demo anon key** (`iss=supabase-demo`, `role=anon`,
  env-overridable); an anon key is public-by-design under RLS and is not a
  secret. The accompanying local seed password is the well-known
  `seed.sql` demo value, not a production credential.

**Result: No tracked secrets found; placeholders / local-demo values only.**
No SECRET-EXPOSURE stop condition triggered.

> Honest caveat: this scan covers the **current tracked set**. The
> now-untracked artifacts (e.g. `linked-project.json`) and the pre-existing
> 28 MB `_fmtcheck.log` remain in **historical commits**; they still exist
> in Git history (see §13 / no-history-rewrite).

## 12. Migration inventory & MANIFEST.sha256 baseline

`supabase/migrations/` enumerated: **56 migrations, `01`–`56`,
sequential** — no missing numbers, no duplicate numeric prefixes, no
out-of-order inserts, no malformed filenames, no stray non-`.sql` files.
On-disk count (56) == tracked count (56). Migration SQL was **not**
modified.

Created `supabase/migrations/MANIFEST.sha256`: one
`<sha256>␣␣<filename>` line per migration, deterministic lexicographic
(== numeric, all two-digit-prefixed) ordering, lowercase hex, basename
only, self-excluded.

```text
MANIFEST.sha256 self-hash (SHA-256):
6efa633c8f427deebfa1ff63c8f1add321c2f0e75bbc8c7ad60c73d634c28d4e
baseline HEAD at generation: dfd98e74313498750c5d6b0611b27f23659b5df0
```

## 13. Manifest verification (§14 battery)

Independent re-hash of every listed file against disk:

```text
mismatches      = 0
missing files   = 0
manifest-only   = 0   (no on-disk migration absent from manifest)
ordering        = deterministic (verified non-decreasing)
lines           = 56  (= migration count)
validate:migrations = 0 errors, 4 warnings (matches documented baseline)
```

**Forward immutability baseline established from this commit.** This
manifest does **not** prove historical immutability before this point.

**Migration history fact (preserved, not hidden):** `git log`
`--diff-filter=M` shows exactly one post-addition migration edit —
`53_phase2_scheduler_and_autonomous_recovery.sql` in commit `40d6b4a`
(2026-09-19), the known in-session Phase 2 correction re-applied before
any release. The correct statement is: **historical migration immutability
before the available Git baseline (2026-09-03) is not fully provable;
forward immutability is established from this approved manifest baseline.**
No corrective migration was written and migration 53 was left untouched.

## 14. Application / source integrity checks

| Check | Command | Result | Hygiene-caused? |
| --- | --- | --- | --- |
| Whitespace/conflict lint | `git diff --check` | **clean (exit 0)** | — |
| Source content vs HEAD | `git diff HEAD --stat -- supabase/functions tests apps/web/src scripts .github` | **empty — zero source changed** | No |
| Migration validation | `deno task validate:migrations` | **0 errors, 4 pre-existing `[duplicate-objects]` warnings** | No |
| Format check | `deno fmt --check` | **FAIL: 143/304 unformatted** (pre-existing) | No |
| Lint | `deno lint` | **8 pre-existing problems (2 auto-fixable), 129 files** | No |
| Type check | `deno task check` | **BLOCKED** — hangs fetching remote `esm.sh` deps in this sandbox | No |

**Why the format/lint results are not regressions.** `deno fmt`/`deno lint`
scan the **filesystem**, which is independent of Git tracking, and
`deno.json`'s fmt `exclude` covers only `database.generated.ts`,
`supabase/.temp/`, `supabase/.branches/`. The 143 unformatted files are
predominantly the Phase 6 `apps/web` TSX source and generated
`graphify-out` / `.qoder` / `.ua` markdown already on disk — none authored
or touched by this hygiene package. This **supersedes** the older AGENTS
§13 "fmt:check fails on 8 root markdown files" note (that baseline predates
the committed web frontend).

The type-check (`deno task check`) could not complete because dependency
resolution over the network hangs in this environment
(failure class: **environment/network**). It was **not** retried in a loop.
Because this package provably changed **zero** `.ts`/`.tsx`/`.sql` file
(§14 source-vs-HEAD diff is empty), the type-check outcome is unaffected by
the hygiene changes; its absolute pass/fail is recorded **UNPROVEN in this
environment / BLOCKED on network**, not claimed green.

`fmt` and `db:reset` were **not** run (file-rewriting / destructive, not
authorized by this package). No source was edited to force any check green.

## 15. Git diff review (pre-commit)

Staged change set is exclusively hygiene:

```text
218 files changed, 154656 deletions(-)   (all `git rm --cached` index deletions)
```

- No application source changes.
- No SQL / migration content changes.
- No Edge Function behavior changes.
- No frontend business-logic changes.
- No secrets / credentials / hosted environment state added.

Added (to be staged): `.gitignore`, `supabase/migrations/MANIFEST.sha256`,
this report, and the phase-plan doc `PHASE_7_G7_02_DEPLOYMENT_ARCHITECTURE.md`
(previously left uncommitted). Modified (to be staged):
`PHASE_7_PRODUCTION_READINESS_RECONCILIATION.md` — its outstanding edit was
**left uncommitted by the G7-02 session** (premise corrections that the tree
is now a Git repo); G7-03 adds its own hygiene facts to it. Disclosed here
rather than silently bundled.

## 16. Local commit details

Committed **locally only**; parent = pre-hygiene baseline `dfd98e7` (a
commit cannot embed its own final SHA, so it is identified by parent and
message — read it back with `git log --oneline -1`):

```text
commit          : HEAD -> main (the single G7-03 hygiene commit)
parent          : dfd98e74313498750c5d6b0611b27f23659b5df0
message         : chore(hygiene): G7-03 repository hygiene + migration
                  immutability baseline
files changed   : 223  (4 added, 1 modified, 218 removed from tracking)
diffstat        : 1091 insertions(+), 154662 deletions(-)
added           : .gitignore, supabase/migrations/MANIFEST.sha256,
                  PHASE_7_G7_02_DEPLOYMENT_ARCHITECTURE.md,
                  PHASE_7_G7_03_REPOSITORY_HYGIENE_REPORT.md
modified        : PHASE_7_PRODUCTION_READINESS_RECONCILIATION.md
removed-from-tracking : 218 (.ua 95, .qoder 116, supabase/.temp 2,
                  supabase/.branches 1, tool-dump logs 4)
source/SQL content edits in commit : 0
manifest self-hash        : 6efa633c8f427deebfa1ff63c8f1add321c2f0e75bbc8c7ad60c73d634c28d4e
tracked files after commit : 325
branch state        : main ahead of origin/main — NOT pushed
```

Nothing pushed; `origin/main` remains at `dfd98e7`.

## 17. What was NOT performed

Explicitly:

- No `git push`.
- No remote change / no remote creation / no transfer / no ownership change.
- No branch protection / no GitHub environments.
- No CI/CD implementation or deployment.
- No staging / no production Supabase project / no hosted link.
- No `supabase db push` / `functions deploy` / `secrets set` against any hosted project.
- No Vault secrets / no scheduler config change in a hosted env.
- No Razorpay / Meta / SMTP credentials.
- No webhook / DNS / frontend-hosting configuration.
- No real payments / no real WhatsApp / no pilot data.
- No application-logic / RLS / financial / worker-scheduler / auth-code edits.
- No applied-migration edit, no history rewrite, no force-push.

## 18. Remaining G7-02 decisions (NOT silently closed)

- **D8** — graphify-out tracking: **DEFERRED** (left tracked this package).
- **D9** — `.qoder/repowiki` tracking: **RESOLVED here** (technical hygiene: untracked).
- Still open, out of scope for G7-03: **D3** (GoTrue seed defect class),
  **D5** (backup/PITR tier), **D6** (`ENABLE_WORKER_TRIGGER` prod default),
  **D7** (hosted pg_cron/pg_net/Vault probe), **D10** (frontend host),
  **D11** (remote/provider/org), **D12** (`jwt_expiry`/session policy),
  **D13** (Razorpay/Meta/SMTP providers+credentials), **D14**
  (branch-protection admins), **D15** (evidence-log retention policy —
  narrowed but not closed, see §8).

## 19. Final status

```text
G7-03:
COMPLETE — REPOSITORY HYGIENE + RELEASE BASELINE ESTABLISHED
(local hygiene commit prepared; NOT pushed)

Repo hygiene:       IMPLEMENTED (verified: 0 source/SQL changes, manifest 0 mismatches)
Migration baseline: IMPLEMENTED (forward immutability from MANIFEST.sha256; historical immutability NOT claimed)
Secrets:            No tracked secrets found; placeholders only
fmt:check:          FAIL (pre-existing, filesystem-wide, not a hygiene regression) — UNCHANGED by G7-03
lint:               8 pre-existing problems — UNCHANGED by G7-03
type check:         BLOCKED in this environment (network); source untouched so outcome unaffected
D8:                 DEFERRED
D9:                 RESOLVED (untracked)

Production:   NOT STARTED
Credentials:  NOT CREATED
Deployment:   NOT PERFORMED
CI/CD:        NOT IMPLEMENTED
Push:         NOT PERFORMED
```
