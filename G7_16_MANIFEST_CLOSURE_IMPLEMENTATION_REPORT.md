# G7-16 — Migration-Manifest Closure Implementation Report

**Final status: G7-16 (manifest entry for migration 64) — IMPLEMENTED AND
LOCALLY VERIFIED.** The CI enforcement half was found already wired at HEAD
(directly verified, not assumed); its GitHub-side execution remains UNPROVEN
until first push, and branch protection remains an owner-side action.

---

## 1. Workstream selected

G7-16 — migration immutability assurance (`PHASE_7_PRODUCTION_READINESS_
RECONCILIATION.md` register row G7-16; `PHASE_7_NEXT_WORKSTREAM_READINESS_
REPORT.md` §9 item 7 "small hygiene gates").

## 2. Why it was implementation-ready

- Scope is defined by the register itself: manifest verification wired into CI
  + every on-disk migration manifested.
- No owner/product decision is involved (unlike C2b, C3, D6, staging
  authorization, production provisioning — all genuinely blocked).
- No credential or production-environment dependency.
- Concrete repository change: `MANIFEST.sha256` listed 63 of 64 migrations —
  migration `64_c2_alert_rpc_locked_snapshot.sql` (C2, applied and
  catalog-verified on the local DB) was unmanifested, making
  `validate:migration-manifest` fail with an `unmanifest` issue.
- The exact tool (`scripts/validate_migration_manifest.ts --update`) and the
  CI steps already exist; nothing had to be invented.

## 3. Baseline

- Branch `main`, HEAD `0fceb50` ("Add Hospital Operations Analytics Read
  Surface (G-11)"); `origin/main` at `90100aa`; local ahead 2 commits.
- Working tree carried 18 pre-existing modified files plus untracked C2 /
  G-UI / G7-13 / F16-07 / hygiene deliverables. Nothing was reset, cleaned,
  checked out, stashed, rebased, reverted or cherry-picked; all pre-existing
  changes are preserved byte-identical.

## 4. Files changed (this workstream only)

- `supabase/migrations/MANIFEST.sha256` — exactly **1 inserted line**
  (`+e98d63b6…  64_c2_alert_rpc_locked_snapshot.sql`), appended by the
  manifest tool in append-only mode with no existing line touched
  (verified via `git diff`).
- `G7_16_MANIFEST_CLOSURE_IMPLEMENTATION_REPORT.md` — this report.

## 5. Actual implementation

`deno run --allow-read --allow-write scripts/validate_migration_manifest.ts
--update` → "appended 1 entr(y|ies): 64_c2_alert_rpc_locked_snapshot.sql".
The tool recomputed the SHA-256 from the actual file bytes on disk and
maintained the lexicographic order and format contract. No source, migration,
CI or test file was modified.

**CI-enforcement half — verified already complete at HEAD, not re-implemented:
** `git show HEAD:.github/workflows/ci.yml` contains both
`Migration manifest integrity (disk <-> MANIFEST.sha256)`
(`deno task validate:migration-manifest`) and the PR-only
`Migration manifest append-only vs PR base` step (G7-02 I-2). The readiness
report's "CI enforcement not wired" characterization was checked against the
actual committed workflow and corrected here.

## 6. Tests executed (actually run, this session)

| Check | Result |
| --- | --- |
| `deno task validate:migration-manifest` | `64 migration(s), 64 manifest line(s)` — **0 integrity issue(s)** (was failing pre-fix) |
| Append-on-clean-baseline simulation (baseline = 63 committed lines + new 64) | **0 issues** — the exact CI PR scenario for this change passes |
| Negative fixture (corrupted baselined hash) | **fails with `baseline-modified`**, exit 1 — immutability guard proven live, not merely present |
| `deno test tests/unit/migration_manifest_guard.test.ts` | **10 passed / 0 failed** |
| `deno task validate:migrations` | 64 files scanned, `0 error(s), 4 warning(s)` — the 4 warnings are the pre-existing `[duplicate-objects]` baseline (AGENTS §13), not re-reported as new |
| `deno fmt --check` / `deno lint` on the manifest script | clean ("Checked 1 file", no issues) |
| `deno task test` (full unit suite) | **97 passed / 0 failed** — matches the established hygiene baseline, no regression |

## 7. Verification results

- Disk ↔ manifest reconciliation: PASS (INTEGRATION-verified against the real
  file set; the validator hashes actual bytes, not declarations).
- Append-only guarantee for this change: PASS (git diff shows a pure
  one-line addition; baseline simulation green).
- Guard effectiveness: PASS (negative fixture correctly hard-fails).

## 8. Environment limitations

- Local repository verification only. GitHub Actions execution of the manifest
  CI steps remains **UNPROVEN until the first push** (owner push
  authorization — unchanged status).
- Branch protection settings are a GitHub-side owner action (the readiness
  report's G7-16 phrasing); nothing in the repository can or should set it.
- No staging/production claim.

## 9. Diff boundary

`git status`/`git diff --stat` after the task: this workstream's only line in
the diff is the `+1` in `supabase/migrations/MANIFEST.sha256`. All other
modified/untracked files are the pre-existing C2, G-UI, hygiene, G7-13 and
F16-07 working-tree state, preserved untouched. Two temporary simulation
fixtures (`_g716_*.sha256`, `_g716_valmig.log`) were created during
verification and deleted; `git status` shows no new artifacts beyond this
report. No commit was created; no push performed.

## 10. Remaining unrelated work (unchanged, out of scope)

C2b (owner product decisions), staging verification of G-11/C2 writes (owner
authorization), financial wave (NPD-01), scheduler/worker hosted work and
production readiness (owner provisioning/credentials), GitHub Actions
execution proof and branch protection (owner push/settings), root
scratch-artifact and D8 hygiene (DEFERRED). Closed workstreams (C2, G-UI,
G7-13, F16-07, G-03…G-11) were consumed read-only and not reopened.
