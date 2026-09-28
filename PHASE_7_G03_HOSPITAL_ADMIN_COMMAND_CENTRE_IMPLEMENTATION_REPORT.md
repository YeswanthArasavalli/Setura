# PHASE 7 — G-03 HOSPITAL ADMIN COMMAND CENTRE — IMPLEMENTATION REPORT

Frontend-only implementation of the selected next product gap **G-03 —
Hospital Admin Command Centre (read-only operational overview)**, per the
authoritative investigation `PHASE_7_NEXT_PRODUCT_GAP_INVESTIGATION_REPORT.md`
and the phase specification supplied for this session.

---

## 1. Scope

Strictly the G-03 frontend: a bounded, read-only admin surface consuming the
already-proven `command-center` Edge Function's five read actions
(`overview`, `timeline`, `predictive`, `sla_dashboard`, `system_health`).
`broadcast_*` actions were neither wrapped, referenced in code paths, nor
invoked. No backend, SQL, migration, RLS, RPC, Edge Function, config, secret,
staging or production change was made or needed.

## 2. Authorization

Operations performed inside the authorized set only: React/TypeScript source,
frontend tests, API wrapper, route configuration, presentation components and
this report. Read-only inspection of backend source, migration 47/14/17/58 SQL
definitions and the backend integration suite. Read-only local commands
(`typecheck`, `test`, `build`, `deno check/lint/validate:migrations`,
integration suites, secret scan) and read-only browser validation against the
local stack. No file-rewriting repo task (`fmt`, `gen:types`) and no
destructive task (`db:reset`) was run.

## 3. Baseline

```text
HEAD == 0ec8586b3b5b72dd4fcb06c9e5239a89103dc156   (verified via git rev-parse)
```

Pre-existing working-tree state at session start (NOT produced by G-03):
`M PHASE_7_NEXT_PRODUCT_GAP_INVESTIGATION_REPORT.md`, untracked
`PHASE_7_G02_COMMIT_STAGING_DEPLOYMENT_PREFLIGHT_REPORT.md` and
`PHASE_7_G02_CONTROLLED_STAGING_VALIDATION_REPORT.md`.

Note: the session contract asserted the tree was not a Git repository; direct
inspection shows it now is (a `git rev-parse HEAD` returns the spec's baseline
hash and `git status` resolves cleanly). The baseline was therefore verified
by the strongest available method.

## 4. Source reconciliation (spec §3)

Verified against actual source before writing any code — not from the
investigation report:

- `apps/web/src/App.tsx` — role routing via `RequireRole`, `Landing()` sent
  BOTH admin roles to `/reception` (the exact problem §7 names).
- `apps/web/src/components/AppShell.tsx` — declarative `NAV` items filtered by
  `staff.role`.
- `apps/web/src/auth/RequireRole.tsx` — UX guard; `global_admin` passes every
  role list by design; backend remains authoritative.
- `apps/web/src/auth/context.ts` — `global_admin` seeded with a NULL-hospital
  role row resolves `hospitalId: null`.
- `apps/web/src/lib/api.ts` — `callFunction` is the single authenticated
  Edge-Function boundary: user JWT + apikey + `X-Hospital-ID` from the caller
  options; envelope-typed errors (`ApiError`), `describeError` kinds.
- Shared UI: `Card`, `Badge` (+ `statusVariant`), `Button`, `Table`, the
  `useEffect`+`describeError` read pattern of `ReceptionDashboard`/
  `Notifications`, and the `statuses.ts` wrapper + `statuses.test.ts` /
  `Notifications.test.tsx` test conventions.
- `supabase/functions/command-center/index.ts` — read, never modified.
- `tests/integration/enterprise_command_center.test.ts` — read for the proven
  contract (exact fixture values, `Number()`-coerced numerics, shaped
  SLA/predictive payloads).

## 5. Backend contract (reused, not re-invented)

`POST /functions/v1/command-center`, body `{ action, ...optional }`, requires
`X-Hospital-ID`; server enforces `requireRole(["hospital_admin","global_admin"])`
and tenant membership (`resolveAuth`). Response envelope `data` per action,
mirrored 1:1 into `apps/web/src/types/api.ts` from the SQL that produces it
(migration 47 for four actions; migrations 58/17/14 for `system_health`
components):

| action | `data` shape (source of truth) |
| --- | --- |
| `overview` | `{ action, overview: get_hospital_command_center(), scores: get_operational_scores() }` — patients/queues/sla/finance/alert_activity/generated_at; scores 0–100 + inputs. `queues`/`sla` can be NULL (aggregate over zero rows); `sla` may be `{status:"no_data"}`. |
| `timeline` | `{ action, timeline: { hospital_id, from, to, events[] } }` — event: `ts, category, event_type, severity(info|warning|critical), entity_type, entity_id, doctor_id, queue_session_id, metadata`. Default window 24h, limit 100. |
| `predictive` | `{ action, predictions: { hospital_id, date, queue_predictions, financial_predictions(get_revenue_forecast) } }` — deterministic backend projections. |
| `sla_dashboard` | `{ action, sla: { date, summary(tracked,in_breach,avg_breach_wait_minutes), hospitals_in_breach[], trend_14d[] } }`. |
| `system_health` | `{ action, health: { queueHealth[], materializedViews[], deadLetterQueue[], openAlerts } }` — the three RPC components are pass-through and may be NULL. |

Contract fidelity notes: PostgreSQL NUMERIC/INTERVAL values may arrive
serialised as strings (the backend suite itself coerces with `Number()`), so
typed fields are `number | string` (`JsonNumeric`) and the UI coerces through
one display helper — no field was invented, guessed or normalized away.

## 6. Frontend architecture

New files:

- `apps/web/src/api/commandCenter.ts` — five thin read wrappers over the
  established `callFunction`; module exports ONLY those five; no broadcast
  wrapper exists, so the surface is structurally read-only.
- `apps/web/src/routes/AdminCommandCentre.tsx` — the bounded V1 page (header +
  five independent sections).
- `apps/web/src/types/api.ts` — command-centre contract types appended
  (existing types untouched).
- Tests: `apps/web/src/App.test.tsx`, `apps/web/src/api/commandCenter.test.ts`,
  `apps/web/src/routes/AdminCommandCentre.test.tsx`.

Modified: `apps/web/src/App.tsx` (route + landing),
`apps/web/src/components/AppShell.tsx` (nav entry).

No new authorization mechanism, no second API transport, no direct PostgREST
access to command-centre internals, no client-side business logic.

## 7. Route changes

Route choice: **`/admin`** — documented decision. The existing convention is
flat top-level role surfaces (`/reception`, `/doctor`, `/queue`); `/admin`
fits that convention and is the spec's first preferred option.

- `ADMIN_ROLES = ["hospital_admin", "global_admin"]`; `/admin` is wrapped in
  the existing `RequireRole` with those roles.
- `Landing()`: `hospital_admin` and `global_admin` now redirect to `/admin`;
  `receptionist → /reception` and `doctor → /doctor` are unchanged; no booking
  route was altered.
- The outer shell guard gained `...ADMIN_ROLES` so `global_admin` reaches the
  admin surface by the explicit role list rather than only by the guard's
  global-admin special case.
- Nav: one new entry `Command Centre → /admin`, visible only to
  `hospital_admin` / `global_admin`.

## 8. Role behavior

Frontend routing/UX boundary (backend remains authoritative):

- hospital_admin, global_admin → `/admin` renders.
- receptionist → `/admin` redirects to `/` → `/reception`; doctor → `/doctor`.
  Verified in unit tests AND in the live browser pass (redirect observed, zero
  `command-center` requests fired).
- global_admin with no hospital membership row (the seeded `root@setura.test`
  reality): the route is reachable, and the page short-circuits to
  "No hospital tenant is attached to your account." — the established console
  behavior. It issues no request and no hospital may be typed in; see §18.

## 9. API wrapper

Follows `api/statuses.ts` exactly: `callFunction("command-center", { action },
{ hospitalId })`. Tenant travels ONLY in the `X-Hospital-ID` header derived
from the authenticated staff session; no body tenant field, no URL/query
hospital override, no `Idempotency-Key` (reads), no service-role key, no
secret. Pinned by `commandCenter.test.ts` (exact action bodies, options
surface, absence of broadcast/idempotency, error passthrough, verbatim payload
resolution).

## 10. UI sections (bounded V1)

Header: page title, admin name, session-derived tenant id, "Last updated"
stamp, single Refresh control. Sections, each an independent read:

1. **Operational Overview** — patients/queues/finance stat grids, SLA status,
   24h alert activity, snapshot date, backend `generated_at`, and the five
   operational scores. NULL sub-objects render as stated absences
   ("No queue sessions today."), never as fabricated zeroes.
2. **SLA Dashboard** — summary, breach table, 14-day trend, all rendered from
   backend values; no SLA math exists in React.
3. **System Health** — open alerts, job-queue rows, materialized-view rows,
   DLQ rows; NULL components render "Not reported.", empty arrays render
   their own empty state; no second health engine.
4. **Operational Timeline** — read-only event table (time, category, event,
   severity badge, entity type, and the message string ONLY when the backend
   metadata supplies one). No actor/patient names or severities are invented;
   metadata objects are never stringified into the DOM.
5. **Predictive Insights** — rendered because the backend response is already
   a clean flat, labelled structure; queue projections and the embedded
   revenue forecast are shown verbatim with an explicit "no client-side
   forecasting" description. No recommendation, no severity assignment, no
   extrapolation.

## 11. Loading / empty / error / partial-failure behavior

Per section: `Loading…` until its own outcome (never fake zeroes); success
renders actual values; a valid-but-empty response renders a distinct empty
message; a failure renders a `role="alert"` with `describeError` text — 403 /
422 / 500 / network are never converted to "No data". The five reads use
`Promise.allSettled`, so one failure degrades only its own section (proven by
a dedicated partial-failure test and by design being per-section state).
"Last updated" is stamped only after a completed round with at least one
success; a fully failed round leaves "Not yet fetched". Manual refresh only —
no polling introduced.

## 12. Security review (spec §19)

- Source grep over every changed/created file for
  `service_role|SERVICE_ROLE|SECRET|secret|RAZORPAY|META_APP|Bearer ey|broadcast`:
  only two comment mentions documenting that broadcasts are NOT wrapped. Zero
  secret material.
- Built bundle scan via `scripts/check_frontend_secrets.ts`: **3 artifacts in
  dist, 0 secret hits, 0 source maps**. Additional bundle grep for
  `service_role|secret|broadcast_|CRON|WORKER_SECRET`: no match.
- No hospital-ID authorization bypass path exists: tenant derives from the
  session only; `/admin?hospital_id=…` has no reader in the code.
- Runtime evidence: live browser capture shows the admin surface emits exactly
  the five read actions and nothing else; receptionist/doctor sessions emit
  ZERO command-center requests.
- No financial mutation, no broadcast invocation: structurally impossible —
  the wrapper module exposes only five reads (test-enforced export list).

## 13. Test coverage (spec §20 mapping)

New: 25 tests in 3 files (suite total 145 → **170, all passing**).

| Spec item | Test |
| --- | --- |
| 1–2 admin roles reach route | `App.test.tsx` landing + direct-URL tests (both roles) |
| 3–4 receptionist/doctor blocked | `App.test.tsx` redirect tests (no admin page rendered) |
| 5–6 correct action + request shape | `commandCenter.test.ts` exact-bodies + options-surface tests |
| 7 no broadcast action | export-list + action-prefix assertions |
| 8 error propagation | rejects-unchanged test |
| 9–13 section rendering success | five per-section tests (overview/timeline/SLA/health/predictive) |
| 14–16 loading / empty / error | three dedicated tests |
| 17 partial failure | SLA-fails-others-render test |
| 18 no mutation calls | "only control is Refresh" test |
| 19 no secret/undefined exposure | leak test (`undefined` / `[object` / `null` never rendered) |
| Nav visibility | Command Centre link present for admins, absent for receptionist/doctor |

No snapshot padding; routing tests stub only page modules so the REAL
`RequireRole`, route table and `Landing` are what's under test.

## 14. Local validation

All read-only tasks, exact results:

| Check | Result |
| --- | --- |
| `npm run typecheck` (tsc --noEmit) | PASS |
| `npm test` (vitest) | PASS — 16 files, 170/170 tests |
| `npm run build` | PASS (119 modules, no source maps emitted) |
| `deno task check` | exit 0 |
| `deno task lint` | exit 0 (Checked 95 files) |
| `deno task validate:migrations` | 0 errors, 4 pre-existing duplicate-object WARNINGS (baseline, not re-reported as defects) |
| `deno task test` (unit) | 97 passed, 0 failed |
| `enterprise_command_center.test.ts` (real HTTP, local stack) | **23 passed, 0 failed** |
| `deno task test:integration` (full suite) | **246 passed, 0 failed** (`_g03_integration_regression.log`) |
| `deno fmt --check` | FAIL — 2 pre-existing files at baseline HEAD (`c1_cancel_pre_state.json` line endings, `tests/integration/consultation_notes_read.test.ts`), both untouched by G-03 (`git status` clean on them); zero G-03 files implicated |
| `supabase db diff` | BLOCKED (tooling): shadow-DB replay fails in migration 55's seed verification DO block — a pre-existing local seed/CLI condition; G-03 modified no SQL and never touched the live DB. Backend-unchanged is instead proven by git (see §17) |

Pre-existing failures were identified, classified as NOT G-03-caused, and left
unrepaired per the spec.

## 15. Browser validation (local stack, real Edge Functions)

- **hospital_admin** (`admin@surya.test`): login → lands on `/admin`; all five
  sections load with live tenant data (e.g. Bookings today 20, Completed 4,
  Cancelled 12, Health score 100, DLQ empty, timeline events rendered);
  "Last updated" timestamp advances on Refresh; **0 console errors**; network
  capture on refresh = exactly 5 `POST /functions/v1/command-center` with
  bodies `{overview|sla_dashboard|system_health|timeline|predictive}` — 0
  payment/refund/booking/queue mutations, 0 WhatsApp/broadcast calls.
- **global_admin** (`root@setura.test`): lands on `/admin`; backend contract
  reality observed — seeded global_admin has NULL-hospital grants, so the page
  correctly shows the no-tenant short-circuit and issues 0 requests (§18).
- **receptionist** / **doctor**: land on `/reception` / `/doctor`; no Command
  Centre nav entry; direct `/admin` navigation redirects away; ZERO
  command-center requests observed.

## 16. Files changed

Modified: `apps/web/src/App.tsx` (+19/−4), `apps/web/src/components/AppShell.tsx`
(+3), `apps/web/src/types/api.ts` (+228).
Created: `apps/web/src/api/commandCenter.ts`,
`apps/web/src/routes/AdminCommandCentre.tsx`, `apps/web/src/api/commandCenter.test.ts`,
`apps/web/src/routes/AdminCommandCentre.test.tsx`, `apps/web/src/App.test.tsx`,
this report, `_g03_integration_regression.log` (validation evidence).

## 17. Backend unchanged proof

`git status --porcelain` after all work lists changes ONLY under
`apps/web/src/` plus the three pre-existing root report files of §3.
`supabase/`, `tests/`, `scripts/`, `deno.json`, `.github/` — zero modified,
zero added. The full backend integration suite passes unchanged (246/246),
which is only possible because no backend behavior moved. The §22 expectation
"supabase diff = empty" is met by this direct-inspection proof; the CLI diff
itself is BLOCKED by the pre-existing shadow-DB condition of §14 and was not
silently worked around.

## 18. Known limitations

1. **global_admin has no tenant to view locally**: with NULL-hospital role rows
   the session context yields `hospitalId: null` and the page shows the
   no-tenant message. A hospital switcher/selector is explicitly out of scope
   this phase; global-scoped backend surfaces (portfolio/benchmarks) are not
   among the five selected read actions.
2. **Dev-mode double-fetch**: React 18 StrictMode fires the initial effect
   twice locally (10 GET-equivalent POSTs on first mount). Production builds
   do not double-invoke; this is an established console-wide dev behavior, not
   a G-03 defect (observed identically on the pre-existing doctor page).
3. **Timeline detail column** shows only backend-supplied string `message`
   values; other metadata keys are intentionally not rendered (§14/§15 response
   safety), so per-category rich detail is a possible later enhancement.
4. **No filters / no auto-refresh / no charts** in V1 — manual refresh only,
   per spec §13.
5. Two SLA/predictive label strings and table headers are simple text tables;
   visual density may be refined at staging-validation UX review without
   contract change.

## 19. Staging status

NOT DEPLOYED. No staging command of any kind was executed. Deployment,
admin-login and live read verification belong to the next separately
authorized phase. Production untouched.

## 20. Production boundary

No production infrastructure, URL or credential was created, modified or
referenced. Frontend production verification is UNPROVEN by this report —
local evidence only.

## 21. Final classification

| Claim | Level |
| --- | --- |
| G-03 read UI exists per spec | **IMPLEMENTED LOCAL** |
| Contract fidelity to backend source/SQL | **STATICALLY VERIFIED** |
| Frontend behavior (routing, wrapper, states, read-only) | **UNIT VERIFIED** (170 passed) |
| Backend read contract over real HTTP (unchanged) | **INTEGRATION VERIFIED** (23 + 246 passed against local stack) |
| Admin/receptionist/doctor/global_admin flows in a real browser against the live local backend | **RUNTIME VERIFIED (LOCAL)** |
| Staging | **NOT DEPLOYED / UNPROVEN** |
| Production | **PRODUCTION UNPROVEN — NOT TOUCHED** |

```text
CURRENT BASELINE:
0ec8586b3b5b72dd4fcb06c9e5239a89103dc156

SELECTED GAP:
G-03 — Hospital Admin Command Centre

IMPLEMENTATION:
FRONTEND-ONLY

BACKEND:
UNCHANGED

MIGRATIONS:
UNCHANGED

RLS:
UNCHANGED

EDGE FUNCTIONS:
UNCHANGED

FINANCIAL:
NO FINANCIAL MUTATION

EXTERNAL PROVIDERS:
NONE USED

BROADCAST:
NOT IMPLEMENTED / NOT CALLED

LOCAL VALIDATION:
PASS — typecheck, build, vitest 170/170, deno check/lint/unit(97)/validate:migrations(0 err),
command-center integration 23/23, full integration 246/246, browser validation PASS
(hospital_admin happy path, receptionist+doctor blocked, global_admin no-tenant short-circuit)

FRONTEND TESTS:
PASS — 170/170 (25 new G-03 tests: 7 routing, 6 API wrapper, 12 rendering/state/safety)

TYPECHECK:
PASS (tsc --noEmit, exit 0)

BUILD:
PASS (vite, 119 modules, 0 source maps)

SECURITY SCAN:
PASS — 0 secret hits / 0 source maps (check_frontend_secrets over fresh dist),
clean targeted greps (source + bundle), runtime network capture shows read-only traffic only

STAGING:
NOT DEPLOYED

PRODUCTION:
NOT TOUCHED

GIT:
HEAD == 0ec8586b3b5b72dd4fcb06c9e5239a89103dc156; G-03 changes present as UNCOMMITTED
working-tree modifications/additions only (this phase forbids commit/push);
pre-existing uncommitted report files from the G-02 session remain as found

FINAL STATUS:
G-03 IMPLEMENTATION COMPLETE — AWAITING SEPARATE STAGING VALIDATION
```
