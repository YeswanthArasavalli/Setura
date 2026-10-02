# SETURA — S1-A Candidate Provenance Report

Investigation class: **READ-ONLY provenance forensics**. No implementation, no
migration, no ref alteration, no database mutation was performed. This file is
the only artifact created by the investigation.

---

## 1. Baseline

| Item | Verified value |
| --- | --- |
| Strict HEAD | `0fceb50b0ca9b9971af1bebb3938583b78ace4dd` ("Add Hospital Operations Analytics Read Surface (G-11)", amended) |
| Current branch | `main` |
| Working tree (before = after) | `M graphify-out/cache/stat-index.json` (pre-existing, untouched) + pre-existing untracked report/log/png artifacts; **zero source-file changes made by this investigation** |
| Remotes | `origin → https://github.com/YeswanthArasavalli/Setura.git` (fetch and push) |
| Remote `main` (live, via `git ls-remote origin`) | `90100aaba1a6bf637c44540e1107f886bf14c1e3` = G-09 commit; **local `main` is 2 commits ahead; remote hosts only `main` — no other branch, no tag** |
| All refs (`git show-ref` / `for-each-ref`) | `refs/heads/main`, `refs/remotes/origin/HEAD`, `refs/remotes/origin/main` — nothing else |
| Tags | none |
| Stash list | empty |
| Worktrees (`git worktree list`, `.git/worktrees`) | single worktree `D:/Projects/datasets/setura` |

Note: the number `0fceb50` matches the S1-A "expected baseline", but it is the
tip of local `main` — not a predecessor of any candidate branch. The reflog
shows it was produced by `commit (amend)` chains of G-10/G-11 work
(`c1b2c40 → 1787232 → 0fceb50`), all ordinary SETURA read-surface history.

## 2. Candidate Discovery

| Candidate | Found? | Location | Relation to HEAD | Evidence |
| --- | --- | --- | --- | --- |
| `748d1f1d19842a896e8850081210294f42d2325e` (atomicity authority) | NO | nowhere accessible | unknown object | `git cat-file -t` (full, 7- and 8-char prefixes): "could not get object info" |
| `837e389e3d394d56714c61fc7a3fa2fcad6118d4` (implementation) | NO | nowhere accessible | unknown object | same method, same result |
| `6d59b88993af51912b2ef80a29b47219a9bf6478` (documentation) | NO | nowhere accessible | unknown object | same method, same result |
| `c10712d1759818e004f950204242062b86be4d1b` (S1-A start) | NO | nowhere accessible | unknown object | same method, same result |
| branch `c2_s1_revision_candidate` | NO | not local, not on `origin` | — | `git branch -a`, `git show-ref`, live `git ls-remote origin` (only `refs/heads/main`) |

Searches for the literal strings `c2_s1_revision_candidate`, `748d1f1d`,
`837e389e`, `6d59b889`, `c10712d1`, `alert_lifecycle_atomicity`,
`c2_activity_source_message`, `historical_backfill`,
`migration_order_assertions` across `.md/.txt/.json/.ps1` files (≤2 MB,
excluding `node_modules`, `.git`, `graphify-out`, `dist`, `.vercel`) in all of:
`d:/Projects/datasets/setura`, `d:/Projects/datasets/setura-app`,
`d:/Projects/datasets/setura-analysis`, `d:/Projects/datasets/setura_backup`,
`d:/Projects/setura`, `d:/Projects/setura - github`, `d:/Projects/setura_phase2`
→ **zero hits**.

### Object forensics (`git fsck --full --no-reflogs`)

- 82 dangling blobs: all examined by content probe; the only alert-related one
  is `8d0127e3` = the G-10 Alert-Center **read-surface** report (pre-atomicity,
  unrelated to S1-A).
- 4 dangling commits, each identified:
  - `c1b2c409…` and `17872324…` — pre-amend duplicates of the G-11 commit
    (parent `88df4fc` = G-10); ordinary local history.
  - `82255d69…` — orphaned stash-style commit ("WIP on main: da5332e Staff
    booking reschedule + G-06 closure", 2026-09-30); touches only
    `apps/web/src/auth/AuthProvider.tsx`. Not atomicity work.
  - `247910d9…` — "chore(hygiene): G7-03 repository hygiene" (2026-09-19),
    parent `dfd98e7`; ordinary local history.
- **No unreachable commit or blob carries any atomicity content.**
- No `.bundle`/`.patch`/`.diff`/`.zip`/`.tar*` artifacts exist in the workspace
  search set. `setura-app` is a separate git repo (HEAD `84d6bfa`, only
  `main`; none of the candidate hashes resolve there).

### Remote fetch

Not performed — `git ls-remote origin` (read-only, network) proved the only
remote branch is `main` at `90100aa`. Fetching could not produce the candidate.
`HEAD` before and after the investigation is identical; no ref was altered.

## 3. Authority Files

| File | Found? | Source | Verified content? |
| --- | --- | --- | --- |
| `supabase/functions/_shared/rpc/admin_alerts.ts` | NO | — | — (no `rpc/` dir exists in `_shared/`) |
| `supabase/functions/_shared/rpc/admin_alerts.sql` | NO | — | — |
| `supabase/functions/_shared/rpc/admin_alerts.test.ts` | NO | — | — |
| `supabase/functions/_shared/admin_notification_center.ts` | NO | — | — |
| `tests/integration/alert_lifecycle_atomicity.test.ts` | NO | — | — |
| `supabase/migrations/50_c2_activity_source_message.sql` | NO | — | — |
| `supabase/migrations/51_alert_lifecycle_atomicity.sql` | NO | — | — |
| `supabase/migrations/52_alert_lifecycle_historical_backfill.sql` | NO | — | — (not on disk, not in any commit) |
| `supabase/migrations/53_l0_migration_order_assertions.sql` | NO | — | — |
| `docs/superpowers/specs/2026-07-25-c2-alert-lifecycle-atomicity-design.md` | NO | — | — (`docs/superpowers/` does not exist; `docs/` contains only `security/`, `API_CONTRACTS.md`, `ERROR_CONTRACT.md`) |

Exhaustive tree survey: all **43 commits** reachable from `--all` plus the 4
dangling commits were listed with `git ls-tree -r` and grepped for
`admin_alerts.|admin_notification_center|alert_lifecycle|c2_activity_source|historical_backfill|migration_order_assertions|_shared/rpc` →
**0 hits in every tree of the entire object database's commit graph**. The
atomicity backend has never existed in any commit, reachable or not, in this
repository.

What genuinely exists for alerts is only the **pre-atomicity C2 Phase-1
surface**: `supabase/functions/alert-center/index.ts`, migration
`47_enterprise_command_center.sql` (non-atomic lifecycle RPCs), and the
frontend `apps/web/src/api/alertCenter.ts(.test.ts)` /
`apps/web/src/routes/AdminAlerts.tsx(.test.tsx)`.

## 4. Migration Lineage

Actual local `supabase/migrations/` numbering at HEAD:

| # | Actual file | Candidate expects |
| --- | --- | --- |
| 47 | `47_enterprise_command_center.sql` | (same — shared base) |
| 48 | `48_privilege_hardening.sql` | — |
| 49 | `49_phase_1_5_defect_fixes.sql` | — |
| 50 | `50_p0a_fail_job_v2_dead_letter_fix.sql` | `50_c2_activity_source_message.sql` |
| 51 | `51_p0e_claim_jobs_v2_lease_fix.sql` | `51_alert_lifecycle_atomicity.sql` |
| 52 | `52_w1_detect_crashed_workers_ambiguity_fix.sql` | `52_alert_lifecycle_historical_backfill.sql` |
| 53 | `53_phase2_scheduler_and_autonomous_recovery.sql` | `53_l0_migration_order_assertions.sql` |
| 54–60+ | booking-fee writer, scheduler, payment/D16 migrations | — |

Findings:

- The candidate lineage `50 → 51 → 52 → 53` **collides on all four numbers**
  with unrelated, already-committed worker/lease/scheduler migrations that
  continue past them (54–60+). The candidate therefore branched from a
  *different* migration history than this repository's — it is not a
  successor of `0fceb50`, whose tree already contains 50–60+.
- **NEVER recreate the missing S1-A migrations under numbers 50–53 locally.**
  Those numbers are occupied; the Supabase CLI applies by prefix order and the
  shadow-history would misversion against every environment that already
  applied the real 50–53.
- The candidate migrations are not legitimately recoverable from this machine
  by any Git mechanism, because no object containing them exists here.

## 5. Candidate Architecture

**NOT FOUND — section intentionally empty.** No commit, tree, blob, worktree,
stash, bundle, patch, archive, sibling checkout, or remote ref contains the
atomic RPC architecture, `admin_alerts.ts`/`.sql` transport,
`admin_notification_center.ts`, `OK`/`ALREADY`/`ROLLBACK_FAILED` semantics,
snapshot/`n_completed` semantics, or the atomicity integration test. Per §14 of
the investigation contract, no greenfield reconstruction or inference from
S1-A prose was performed.

## 6. Provenance Classification

```text
CANDIDATE NOT FOUND
```

(Checked, in order: remote branch ✗ · remote tag ✗ · reachable object ✗ ·
unreachable/dangling object ✗ · other local ref ✗ · other worktree ✗ · stash ✗ ·
bundle/patch/archive ✗ · sibling workspace directories ✗ · documented external
artifact path ✗.)

## 7. S1-A Readiness

```text
BLOCKED — CANDIDATE MISSING
```

Second, independent blocker that survives even if a candidate is later located:
**BLOCKED — MIGRATION LINEAGE DIVERGED** (§4). Any recovered candidate must be
renumbered/reconciled against real migrations 50–60+ through an explicit,
owner-visible migration strategy — not applied as-is.

## 8. Exact Unblock Requirement

One of the following authority sources must be supplied by the owner (in
decreasing preference):

1. **A real artifact containing the candidate**: a remote, URL, bundle, patch,
   archive or machine path that actually hosts commits `748d1f1d…`,
   `837e389e…`, `6d59b889…`, `c10712d1…` or branch
   `c2_s1_revision_candidate` (with `50_c2_activity_source_message.sql`,
   `51_alert_lifecycle_atomicity.sql`, `_shared/rpc/admin_alerts.*`,
   `admin_notification_center.ts`, `alert_lifecycle_atomicity.test.ts`).
   This repository's `origin` (`YeswanthArasavalli/Setura`, only `main` @
   `90100aa`) does not host it.
2. **The authoritative atomicity design artifact** (the referenced
   `2026-07-25-c2-alert-lifecycle-atomicity-design.md` or equivalent), if the
   intent is to re-implement the atomicity layer under correct, non-colliding
   migration numbers.
3. **Explicit owner authorization for greenfield atomicity design** — a new
   spec that defines the atomic lifecycle RPCs, transport status semantics,
   and backfill/migration-order migrations with fresh numbers after the real
   60+ sequence. This is an architectural decision and must not be taken by an
   implementation agent mid-task.

Until one of (1)–(3) exists, S1-A remains stopped. The four prose commit hashes
in the S1-A brief are, on current evidence, **not traceable to any real object
in this environment** and must be treated as unverified claims, not authority.

---

## Investigation commands used (all read-only)

`git rev-parse HEAD` · `git status --short` · `git branch --show-current` ·
`git branch -a` · `git remote -v` · `git tag --list` · `git show-ref` ·
`git for-each-ref` · `git stash list` · `git worktree list` ·
`git reflog --all` · `git log --all --oneline` · `git ls-remote origin` ·
`git cat-file -t <4 hashes × 3 prefix forms>` · `git fsck --full --no-reflogs` ·
`git show --stat <dangling commits>` · `git cat-file -p <dangling blobs>` ·
`git ls-tree -r <all 43 commits>` · filesystem
`Get-ChildItem`/`Select-String`/`Test-Path` sweeps of the project workspace.

Not used (prohibited or unnecessary): `fetch` (proved pointless by
`ls-remote`), `merge`, `checkout`, `reset`, `rebase`, `cherry-pick`, `apply`,
`stash apply/drop`, any ref creation, any file deletion, any database command.
