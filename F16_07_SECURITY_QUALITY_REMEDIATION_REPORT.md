# F16-07 — Security Quality Remediation Report

**Final status: F16-07 — CLEANLY RESOLVED**

---

## 1. Exact F16-07 issue (authoritative source)

Defined in `PHASE_1.6_FINDINGS_LOG.md` §F16-07: the comment in
`tests/integration/privilege_isolation.test.ts` states that migration 48 §3
keeps four SECURITY DEFINER helpers executable by `anon`/`authenticated`
"because **193 RLS policies** call them". 193 is the SECURITY DEFINER
**routine** count, not a policy count (live policies are statically bounded
≤ 144). Class: Documentation. Proposed severity: P3. Blast radius: comment
only — "No assertion depends on it."

The carried-forward findings-log line "Correct value: UNMEASURED" was
superseded: `PHASE_1.6_RUNTIME_TEST_REPORT.md` §4.3 (Gate 3 Step 2,
certified PASS) records the live count as **139 public policies**, whose
persisted attestation is Gate 2's line at
`PRIVILEGE_RUNTIME_VERIFICATION.md:446`, corroborated by the static bound
≤ 144. AGENTS.md §13 states the remediation obligation exactly: "corrected:
live count is 139 … comment still needs fixing in source, not fixed here."
G7_13 §10 explicitly declined to absorb this fix, leaving it as the separate
targeted action performed here.

## 2. Baseline

- Branch `main`, HEAD `0fceb50` ("Add Hospital Operations Analytics Read
  Surface (G-11)"); `origin/main` at `90100aa` (2 local commits ahead).
- Working tree carried pre-existing changes (C2, hygiene, G7-13, G-UI).
  None were reset, checked out, cleaned, stashed, rebased, reverted or
  cherry-picked. The target file already had pre-existing G7-13 modifications,
  which were preserved; the edit was applied on top.

## 3. Root cause

A comment conflated routines with policies (unit confusion). No runtime or
assertion depended on the number.

## 4. Files changed (this task only)

- `tests/integration/privilege_isolation.test.ts` — 5 comment lines rewritten
  (the single F16-07 target; the only source occurrence of the bad claim).
- `F16_07_SECURITY_QUALITY_REMEDIATION_REPORT.md` — this report.

## 5. Implementation

The JSDoc above `Deno.test("privilege: Category A RLS helpers remain
callable")` now reads "because the live RLS policies (139 as measured in
Gate 1's pg_policies census) call them" instead of "because 193 RLS policies
call them". No other line touched.

Scoping check: `scripts/validate_migrations.ts:489` and
`supabase/migrations/48_privilege_hardening.sql:28,37,456` also mention "193"
but correctly as the SECURITY DEFINER **function/routine** count — not the
F16-07 defect; deliberately left unchanged. Migration 48 is a historical
artifact (§11: never edit applied migrations).

## 6. Security impact

None weakening. The change is a comment; grants, RLS, `SECURITY DEFINER`
behavior, the four open Category A helpers and every denial boundary are
byte-identical. It improves the security documentation's accuracy so the
open-by-design grant is justified by the correct measured policy count.
No credentials, tokens or PII introduced or logged.

## 7. Tests executed

- `deno test --allow-net --allow-env --allow-run
  tests/integration/privilege_isolation.test.ts` against the live local
  Supabase stack (`supabase start`, stack confirmed up before the run):
  **25 passed | 0 failed** — actually executed, INTEGRATION VERIFIED.
  Run a second time after the final comment-wording correction, with the
  same result (25 passed | 0 failed), so the reported outcome matches the
  exact final file content.

## 8. Static validation

- `deno fmt --check tests/integration/privilege_isolation.test.ts` — pass.
- `deno lint tests/integration/privilege_isolation.test.ts` — pass.
- `deno check tests/integration/privilege_isolation.test.ts` — pass (exit 0).
  (IDE-reported "Cannot find name 'Deno'" diagnostics are the IDE TS server
  lacking the Deno environment — pre-existing, unrelated to a comment edit,
  and refuted by the clean `deno check`/lint/fmt runs.)

## 9. Regression validation

The full privilege suite passing covers the applicable security-regression
cases without re-manufacturing them: Category A helpers allowed for
anon/admin/clerk (authorized-role → allowed), Category B/C/D RPC denials for
anon and authenticated (anonymous → denied, low-privilege → denied),
tenant-isolation scope checks (cross-tenant → denied), and the alerts
admin-path/suppression-scope tests. No assertion changed, so passing after
the edit proves no behavioral drift.

## 10. Environment limitations

- The local stack was **down** at baseline. To execute §7 honestly it was
  started, tested against, then stopped — twice (initial run and final-content
  re-run) — leaving the environment in its pre-task state. Local runtime only;
  **not** production verification.
- No staging/production execution performed or claimed.

## 11. Diff boundary

`git diff` after the task shows the same 15 pre-existing modified files as at
baseline plus this task's comment edit inside
`privilege_isolation.test.ts` (the file's other ~875 inserted lines are
pre-existing G7-13 work, not this task's). All `_f1607_*` scratch logs created
during this session were deleted; `git status` shows no new artifacts beyond
this report. Every F16-07 line is confined to the one comment block.

## 12. Remaining unrelated work (unchanged, out of scope)

Pre-existing working-tree changes (C2, G-UI, hygiene, G7-13) remain as the
owner left them. Remaining known items per PHASE_7_NEXT_WORKSTREAM_READINESS_REPORT:
G7-16 branch-protection enforcement, root scratch-artifact hygiene (DEFERRED),
D8 graphify-out tracking (DEFERRED), production provisioning/credentials
(NPD-01 set), F16-01/04 standing obligations, P0-01…P0-04 (each with their own
gate, not this task). No commit was created; no push performed.
