# PHASE 7 — G-10: Alert-Center Read Surface — Implementation Report

## 1. Objective

Expose the existing `alert-center` backend **read** capabilities through a new
protected frontend surface at `/admin/alerts`, consuming **only** `list` and
`analytics`. This is a read-only reachability workstream over an existing
backend; alert lifecycle mutations and scheduled alert generation are
intentionally out of scope.

## 2. Baseline

- HEAD at start: `90100aa` (`Add Finance / Collections Read Surface (G-09)`), branch `main` (confirmed via `git status` / `git rev-parse HEAD` / `git branch --show-current`; this working tree **is** a Git repository).
- Local Supabase stack running (`API_URL http://127.0.0.1:54321`); Edge Runtime confirmed serving.
- Closed and untouched workstreams: G-03, G-05, G-06, G-07, AUTH, G-08, G-09.

## 3. Files inspected

- `supabase/functions/alert-center/index.ts` (the read + mutation actions)
- `supabase/migrations/47_enterprise_command_center.sql` (`get_alert_center` §2, `get_alert_analytics` §2, grants §13)
- `supabase/migrations/24_operational-monitoring_engine.sql` (`alert_events` schema, `check_queue_backlog_alerts()` generator)
- `supabase/migrations/48_privilege_hardening.sql` (privilege posture around the alert RPCs)
- `apps/web/src/lib/api.ts` (`callFunction`), `apps/web/src/lib/errors.ts`
- `apps/web/src/api/financial.ts` + `commandCenter.ts` (the read-only wrapper pattern)
- `apps/web/src/routes/AdminFinancial.tsx` (+ its test) — the closest G-09 analog
- `apps/web/src/api/financial.test.ts`, `apps/web/src/types/api.ts`
- `apps/web/src/App.tsx`, `apps/web/src/components/AppShell.tsx`
- `apps/web/src/api/portfolio.ts` (`fetchActingHospitalContext` — G-08 bounded acting-context reuse)
- `tests/integration/financial_command_center_http.test.ts` (real-HTTP suite template)

## 4. Files changed

New:
- `tests/integration/alert_center_http.test.ts` — real-HTTP read + authorization suite (13 tests)
- `apps/web/src/api/alertCenter.ts` — typed read wrappers (`list` / `analytics` only)
- `apps/web/src/api/alertCenter.test.ts` — wrapper contract tests
- `apps/web/src/routes/AdminAlerts.tsx` — read-only Alert-Center surface
- `apps/web/src/routes/AdminAlerts.test.tsx` — route tests

Modified (frontend only):
- `apps/web/src/types/api.ts` — added `AlertSeverity`, `AlertEventRow`, `AlertCenterCounts`, `AlertCenterData`, `AlertListResponseBody`, `AlertAnalytics*`, `AlertAnalyticsResponseBody`
- `apps/web/src/App.tsx` — `/admin/alerts` route under `RequireRole([...ADMIN_ROLES])`
- `apps/web/src/components/AppShell.tsx` — `Alert Center` nav entry for `hospital_admin` / `global_admin` only
- `apps/web/src/App.test.tsx` — added `G-10 alert-center viewer routing boundary` suite (+6 tests), mirroring the G-09 precedent of committing route-isolation coverage in the app routing test

No backend, SQL, migration, RLS, grant, or SECURITY DEFINER file was changed.

## 5. Alert backend contract

`POST /functions/v1/alert-center`, body `{ action, ... }`, tenant in the
`X-Hospital-ID` header (never in the body).

- `list` → `data: { action: "list", center }` where
  `center = { alerts: AlertEventRow[], counts: { open, acknowledged, escalated, critical_open } }`
  (`get_alert_center`, migration 47 §2). `alerts` is `COALESCE(jsonb_agg, '[]')`;
  row fields are exactly the RPC's SELECT list. `counts` are whole-tenant
  `COUNT(*) FILTER` values, independent of the returned page.
- `analytics` → `data: { action: "analytics", analytics }` where
  `analytics = { summary: { total, resolved, avg_resolution_minutes }, by_alert_key: [{ alert_key, total, resolved, avg_resolution_minutes }] }`
  (`get_alert_analytics`, migration 47 §2). `avg_resolution_minutes` is `NULL`
  for an empty window; counts are integers.

Both RPCs are `STABLE SECURITY DEFINER` and granted **only** `TO service_role`
(migration 47 §13), mediated exclusively by the Edge Function.

## 6. Read-only boundary

- The wrapper exports **only** `fetchAlertCenter` and `fetchAlertAnalytics`. A
  test asserts `Object.keys(module)` equals exactly those two and that no
  `acknowledge` / `assign` / `resolve` / `escalate` / `suppress` export exists.
- No mutation control (not even a disabled one) is rendered; a route test asserts
  the only button on the page is `Refresh`.
- `list` filters (`status` / `severity` / `category` / `limit`) and the analytics
  `fromDate` / `toDate` window map 1:1 to server parameters; absent values are
  omitted (never empty string), so the RPC defaults apply.

## 7. P3-01 authorization verification (STOP-condition re-check)

Re-verified against the **real** Edge Runtime, not assumed. The edge handler runs
`resolveAuth` → `requireRole(["hospital_admin", "global_admin"])` **before** any
RPC, so denials never reach the SQL that the historical 500-instead-of-403 caveat
concerned. Live HTTP result:

| Case | Expected | Observed |
| --- | --- | --- |
| receptionist `list` / `analytics` | 403 | **403 `ROLE_INSUFFICIENT`** |
| doctor `list` / `analytics` | 403 | **403 `ROLE_INSUFFICIENT`** |
| missing `X-Hospital-ID` | 422 | **422 `VALIDATION_ERROR`** |
| anonymous | 401 | **401** |
| cross-tenant (adminB → hospital A) | 403 | **403 `HOSPITAL_ACCESS_DENIED`, no `data`** |

No read-path denial returned 500. The test suite raises an explicit
`G-10 BLOCKED — BACKEND AUTHORIZATION DEFECT` on any 5xx denial; none fired.
**P3-01 is satisfied; no STOP condition; no self-patch made.**

## 8. HTTP integration test

`tests/integration/alert_center_http.test.ts` drives real
`POST /functions/v1/alert-center` with genuine GoTrue password-grant JWTs against
the live local Edge Runtime. No case is mocked and no direct RPC substitutes for
HTTP. 13 tests, all passing (run twice: pre- and post-format).

## 9. Authorization matrix (proven by real HTTP)

- `hospital_admin` → `list` 200, `analytics` 200 (server-authoritative contract).
- `global_admin` → `list` 200, `analytics` 200 (existing bounded acting-context header; no tenant invented).
- `receptionist` → 403 `ROLE_INSUFFICIENT` (both actions).
- `doctor` → 403 `ROLE_INSUFFICIENT` (both actions).
- missing header → 422 · anonymous → 401 · cross-tenant → 403.

## 10. Tenant-isolation evidence

`adminB` (a valid, fully authenticated `hospital_admin` of tenant B) presenting
tenant A's header is refused **403 `HOSPITAL_ACCESS_DENIED`** for both actions,
and the failure envelope carries **no `data`** — a real database/edge tenant
denial, not a JWT-layer 401. Cross-tenant `alert_events` payload leakage is
therefore impossible at the read surface.

## 11. Alert data / fixture handling

No `alert_events` were seeded. The generator `check_queue_backlog_alerts()` has
no runtime scheduler caller (§10), so fresh fixture tenants legitimately return
zero rows; the reads still succeed with a well-formed empty `center` / `analytics`
(overhead asserted by the test). Classification:
**READ SURFACE FUNCTIONAL · DATA GENERATION DEPENDENCY DEFERRED**. No migration
or seeding architecture was invented.

## 12. Frontend API layer

`apps/web/src/api/alertCenter.ts` mirrors the G-09 `financial.ts` pattern: it
sends exactly one read action per call, no invented body fields, tenant only via
the shared `callFunction` header context, no idempotency key (both are reads),
and returns the envelope `data` verbatim.

## 13. Admin Alerts route

`apps/web/src/routes/AdminAlerts.tsx` at `/admin/alerts`, role-gated to
`hospital_admin` / `global_admin` via the existing `RequireRole` mechanism. A
tenant-less `global_admin` reuses the established G-08 `fetchActingHospitalContext`
header mechanism (resolved once, disclosed in the UI). Receptionist and doctor
cannot reach the page (route blocked; nav hidden).

## 14. UI behavior

Two cards — **Alert Inbox** (`list`) and **Alert Analytics** (`analytics`) — each
with independent `idle` / `loading` / `success` / `error` states. Rows render the
server fields (severity badge, key, category, message, resolved/open label derived
from the server `is_resolved` boolean, created timestamp). Filter/window controls
apply only on an explicit `Refresh`, never on a keystroke. No polling; a
StrictMode remount is guarded to a single initial cycle; one Refresh = one bounded
cycle.

## 15. Analytics behavior

The `counts` block and the analytics `summary` are the server's own values,
rendered verbatim. The page never computes `alerts.length`, a resolution rate, a
severity percentage or a trend (`AdminAlerts.test.tsx` renders a server `open`
count of 7 with only 2 returned rows to prove no client-side counting).

## 16. Null / empty semantics

`display()` uses explicit null checks: a real `0` renders as `0` (never `—`), an
absent value renders as `—` (never a fabricated `0`). A legitimately empty alert
list shows "No alerts found."; an empty analytics window shows "No alerts in this
window." An HTTP failure is an error banner, never dressed as an empty success.

## 17. Frontend tests

- `alertCenter.test.ts` — 10 tests: exact action names, filter 1:1 mapping + omission of absent values, header-only tenant, no idempotency key, no analytics math in the wrapper, verbatim passthrough, error propagation, and **no mutation export**.
- `AdminAlerts.test.tsx` — 13 tests: single bounded load, loading/empty/error/success states, server counts (not row counts), zero mutation controls, no polling + one Refresh cycle, and the global-admin acting-context path.
- `App.test.tsx` — +6 G-10 routing-boundary tests: both admin roles reach `/admin/alerts`; receptionist/doctor are redirected away (page never mounts, zero requests); `Alert Center` nav link is admin-only; prior G-03/G-05/G-06/G-08/G-09 routes unchanged.

## 18. Full test suite

`npx vitest run` (apps/web), final run after all G-10 changes including the
`App.test.tsx` routing suite: **339 passed / 339, 28 files**, exit 0. (Two
pre-existing timing-sensitive files — `AuthProvider.test.tsx`, `BookingForm.test.tsx` —
flaked once under full parallel load mid-task and pass in isolation and on clean
reruns; neither is touched by G-10. The final full run was green.)

## 19. Typecheck

`tsc --noEmit`: exit 0. `deno check` (repo-wide including the new test): exit 0.

## 20. Build

`npm run build` (`tsc --noEmit && vite build`): exit 0, built in ~5.8s.

## 21. Migration validation

`validate:migrations`: **63 files, 0 errors, 4 warnings** — the 4 known
pre-existing `[duplicate-objects]` warnings (unchanged baseline; no migration was
modified).

## 22. Service-role scan

`check_frontend_secrets`: **0 secret hits**, 0 source maps in `dist`. No
service-role key reaches `apps/web` or the bundle.

## 23. Browser verification

**NOT PERFORMED in this implementation phase.** The read surface's behavior
(routing, role gating, rendering, empty/error states, bounded requests) is proven
by the frontend route tests, and the authorization matrix / tenant isolation is
proven by live HTTP. A controlled authenticated browser walkthrough is deferred to
the staging phase (matching the G-09 precedent), consistent with §32 (do not
deploy staging during implementation). Recorded honestly as UNPROVEN at the
browser layer.

## 24. Closed-workstream regression

- Full frontend suite green (includes G-03/G-05/G-06/G-07/G-08/G-09/AUTH route tests).
- G-09 real-HTTP suite re-run alongside G-10: 13/13 pass.
- No closed workstream, migration, grant, RLS or AuthProvider was modified.

## 25. Git commit

One focused commit `Add Alert-Center Read Surface (G-10)` staging exactly the 9
G-10 source/test files (the 5 new + `types/api.ts` + `App.tsx` + `AppShell.tsx` +
`App.test.tsx`) plus this report. Excluded: `graphify-out/cache/**`
(tool cache), and no screenshots/logs/probe artifacts.

## 26. Limitations

- Browser-layer verification deferred (see §23).
- Alert generation (`check_queue_backlog_alerts`) still has no scheduler caller —
  out of scope; the read surface is proven against empty and contract-shaped
  responses.
- Staging/production deployment not performed (per §32).

## 27. Staging status

`STAGING — NOT YET PROVEN`. Nothing was deployed.

## 28. Production status

`PRODUCTION — UNTOUCHED`.

## 29. Acceptance matrix

```
[x] alert-center backend contract inspected
[x] get_alert_center inspected
[x] get_alert_analytics inspected
[x] P3-01 read-path authz re-verified (403, not 500, via live HTTP)
[x] hospital_admin list 200
[x] hospital_admin analytics 200
[x] global_admin list 200
[x] global_admin analytics 200
[x] receptionist list 403
[x] receptionist analytics 403
[x] doctor list 403
[x] doctor analytics 403
[x] missing X-Hospital-ID rejected (422)
[x] anonymous rejected (401)
[x] cross-tenant denied (403, fail-closed)
[x] no cross-tenant payload leakage
[x] direct RPC privilege preserved (get_alert_center / get_alert_analytics denied to anon+authenticated)
[x] no SQL changes
[x] no migration changes
[x] no RLS changes
[x] no grant changes
[x] no SECURITY DEFINER changes
[x] api/alertCenter.ts created
[x] AdminAlerts.tsx created
[x] /admin/alerts route created
[x] admin navigation added
[x] hospital_admin/global_admin access
[x] receptionist/doctor route isolation
[x] list rendered server-authoritatively
[x] analytics rendered server-authoritatively
[x] no client analytics calculations
[x] no mutation controls
[x] no acknowledgement
[x] no assignment
[x] no resolve
[x] no escalation
[x] no suppression
[x] loading state
[x] empty state
[x] error state
[x] no polling
[x] bounded refresh
[x] service-role scan clean (0 hits)
[x] frontend tests pass
[x] full frontend suite passes (339)
[x] real HTTP tests pass (13)
[x] typecheck passes
[x] build passes
[x] migration validation passes (0 errors)
[x] local Edge Runtime verified (live HTTP)
[x] closed-workstream regression passes
[ ] console clean — browser walkthrough deferred to staging (see §23)
[x] focused G-10 commit created
[x] staging NOT deployed
[x] production untouched
```

## Final status

```
G-10 — LOCAL INTEGRATION VERIFIED
STAGING — NOT YET PROVEN
PRODUCTION — UNTOUCHED
```
