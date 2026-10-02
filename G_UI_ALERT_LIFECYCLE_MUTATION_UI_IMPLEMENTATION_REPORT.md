# SETURA — G-UI ALERT LIFECYCLE MUTATION UI — IMPLEMENTATION REPORT

Frontend implementation of the Hospital Admin **Alert Lifecycle Mutation UI**
over the EXISTING, already-verified C2 backend. This workstream added the
missing product surface; it did **not** redesign, re-audit or reopen C2.

## 1. Scope

Add the admin mutation experience (acknowledge / resolve / escalate / suppress)
to the read-only Alert Center. Assignment and reopen were intentionally excluded
(assignment deferred until an assignable-user directory exists; D1 defines no
reopen). No backend, migration, RLS, grant, RPC or C2 test was touched.

## 2. Baseline

- Git working tree: branch `main`, HEAD `0fceb50` (`Add Hospital Operations
  Analytics Read Surface (G-11)`). This tree **is** a Git repository (contrary to
  an older AGENTS.md §13 snapshot).
- Pre-existing uncommitted work (C2: `supabase/functions/alert-center/index.ts`,
  the C2 integration tests, migration 64, hygiene/G7-13 documents) was present
  before this task and was left **exactly as found** — no reset / checkout /
  clean / stash / revert was run.
- The C2 mutation backend was already implemented and locally integration-
  verified (per `C2_ALERT_LIFECYCLE_CLOSURE_VERIFICATION.md`); only the frontend
  surface was missing.

## 3. Files changed (this workstream — frontend only)

| File | Change |
| --- | --- |
| `apps/web/src/types/api.ts` | +56: soft-success lifecycle + suppress result types, mirrored from the frozen write contract. |
| `apps/web/src/api/alertCenter.ts` | +103/-20: `acknowledgeAlert` / `resolveAlert` / `escalateAlert` / `suppressAlert` wrappers; header doc updated. |
| `apps/web/src/lib/alertLifecycle.ts` | NEW (150 lines): presentation-only validation, action-availability predicates, outcome labels. |
| `apps/web/src/routes/AdminAlerts.tsx` | mutation controls, reconcile loop, role gate; copy made truthful. |
| `apps/web/src/App.tsx` | route comment updated (still `ADMIN_ROLES`-guarded). |
| `apps/web/src/components/AppShell.tsx` | nav comment updated. |
| `apps/web/src/api/alertCenter.test.ts` | updated exports test + mutation payload/omission/tenant/error tests. |
| `apps/web/src/routes/AdminAlerts.test.tsx` | extended mock + 12 mutation tests. |

The backend write-path files, migration 64, and the C2 HTTP/concurrency suites
were **not** modified by this task (they remain in the pre-existing working set).

## 4. Features implemented

- **Acknowledge** — one click, `action:"acknowledge", alertId`.
- **Resolve** — expand-to-confirm panel, optional notes (≤1000), `action:"resolve"`.
- **Escalate** — expand-to-confirm panel, optional notes, `action:"escalate"`.
- **Suppress** — deliberate panel with `alertKey` (prefilled from the row),
  future-only `activeUntil`, optional `reason` (≤200), explicit "Confirm
  suppression", copy stating it is a KEY+window action, not a row lifecycle.
- Per-field action availability derived only from the server's own
  `acknowledged_at` / `escalated_at` / `is_resolved` fields (independent per D1);
  a field already set hides its control (it would only ever replay `already_*`).

## 5. Backend contracts consumed (unchanged)

`alert-center/index.ts` + the edge `Schema` (migration 64 RPCs) — consumed
verbatim. Optional fields are OMITTED when absent (never `""`/null). The
soft-success envelope is honoured: HTTP 200 with `result.ok:true` (real
transition carries `before`/`after`; an `already_*` replay carries neither).
`42501 → 403`, `422` validation/not-found, `401` anonymous, `500` unexpected DB
are mapped through the app's existing `ApiError` / `describeError` conventions.
No new endpoint, action, state or error code was introduced.

## 6. Authorization behavior

Mutation controls render only for `hospital_admin` / `global_admin` as a
convenience (`MUTATION_ROLES`). This is **not** the security boundary — the Edge
Function re-authorizes role + tenant on every call, and an unauthorized request
that somehow occurs is surfaced honestly (401 → "session expired", 403 → "you do
not have permission"). Receptionist / doctor receive no controls (test-proven).

## 7. Tenant behavior

Tenant travels ONLY in the `X-Hospital-ID` header that `callFunction` sets from
the authenticated session (or, for a tenant-less global admin, the established
G-08 `fetchActingHospitalContext()` result — resolved at most once). No hospital
id is ever placed in a mutation body (test-proven). No arbitrary hospital id is
introduced.

## 8. UI state / reconciliation behavior

Server-authoritative, never optimistic-only. `reconcile()` re-runs the SAME two
reads (`list` + `analytics`) after every attempt — success, `already_*` replay
or rejection — so the server's counts/analytics and each row's fields are
re-read, not locally patched. Unlike the initial `load()`, `reconcile()` does not
blank the list to a LOADING state, so an in-flight outcome message is not flashed
away. Duplicate-submit protection is UI-level (`useAsyncAction` disables the
control and swallows a second in-flight click); no Idempotency-Key is sent
(the endpoint does not read it and owns replay safety intrinsically).

## 9. Test results

- `npx vitest run` (whole frontend suite): **389 passed / 0 failed** across 30
  files.
- Alert-focused: `alertCenter.test.ts` 15 passed; `AdminAlerts.test.tsx` 26
  passed (12 new mutation tests: payload shape, notes/reason/key/window
  validation, `already_*` soft success, duplicate-click, reconcile-on-mutation,
  no-hospital-in-body, acting-context tenancy, error mapping with no raw-detail
  leak, and receptionist/doctor control hiding).
- Existing C2 suites (`alert_center_http.test.ts`,
  `enterprise_command_center.test.ts`) were not run or modified by this task;
  they remain the backend proof.

## 10. Browser verification

**BLOCKED — environment/tooling.** The Docker daemon is not running
(`docker version` → cannot connect to `dockerDesktopLinuxEngine`; `docker ps`
exit 1), so no local Supabase stack (Postgres / Edge Runtime / Auth / Kong) is
reachable, and there is no root `.env` (only `apps/web/.env.local`). Live browser
verification of mutations requires the real Edge Function and seeded
`alert_events`; it cannot be performed here. Per AGENTS.md this is reported
BLOCKED, not fabricated, and **no staging/production verification is claimed.**

## 11. Build / typecheck / lint / format

- `npm run typecheck` (`tsc --noEmit`): **PASS**.
- `npm run lint` (mapped to `tsc --noEmit` in `apps/web/package.json`): **PASS**.
- `npm run build` (`tsc --noEmit && vite build`): **PASS** (built in ~5.5s).
- Format: the frontend has no separate formatter wired; no formatting gate was
  run beyond the above. (The repo-wide `deno fmt --check` covers Deno/root docs,
  not `apps/web` source, and was not in scope for this frontend-only change.)

## 12. Diff boundary

`git diff --name-only` for this workstream contains only the 8 `apps/web` files
listed in §3 (the App/AppShell edits are one-line truthfulness comments each).
The unrelated modified/untracked entries in `git status` (`.gitignore`,
`graphify-out/`, `supabase/*`, `tests/integration/*`, the C2 / hygiene / G7-13
documents) are the pre-existing working set and were NOT touched. Migration 64,
RLS and grants are untouched. No database types were regenerated.

## 13. Known limitations

- **Browser/runtime verification BLOCKED** (no local stack). Behavior is verified
  statically + by unit/component tests against mocked transport, not against a
  live Edge Function from this machine.
- Suppression is submitted with no deduplication by design (OD-b); the UI relies
  on deliberate confirm + in-flight disable, not client-side suppression dedupe.
- Under the default `status:"open"` filter, resolving an alert drops it from the
  re-read list — the disappearance is the authoritative confirmation; the
  per-row outcome message is not shown once the row leaves the filtered set.
- Assignment UI intentionally absent (no assignable-user directory yet).

## 14. Explicit statement

```text
C2 backend was not reopened or modified.
```

---

```text
G-UI — IMPLEMENTED AND LOCALLY VERIFIED
```

"Locally verified" refers to the executed automated gates in this environment
(build + typecheck + 389 frontend tests). Browser/runtime verification against a
live local stack is **BLOCKED** (§10) and is explicitly NOT claimed.
