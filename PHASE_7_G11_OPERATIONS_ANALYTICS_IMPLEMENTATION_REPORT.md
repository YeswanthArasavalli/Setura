# PHASE 7 — G-11: HOSPITAL OPERATIONS ANALYTICS READ SURFACE — IMPLEMENTATION REPORT

Classification: FRONTEND REACHABILITY GAP — implementation-only session.
Scope discipline: LOCAL implementation and LOCAL integration proof. No staging
deployment, no production touch (spec §1/§33).

---

## 1. Objective

Expose the two EXISTING tenant-scoped `executive-analytics` read actions
(`daily_operations`, `doctor_rankings`) through a protected, read-only
frontend surface at `/admin/operations` for `hospital_admin` and
`global_admin`, without changing any backend/security architecture.

## 2. Baseline

- Branch `main`, HEAD `88df4fc` ("Add Alert-Center Read Surface (G-10)") —
  the expected baseline; verified before any edit.
- Working tree otherwise carried only untracked logs/PNGs/temp artifacts and
  a modified `graphify-out/cache/stat-index.json` (never staged).
- Frontend test baseline 339/339; `validate:migrations` baseline 0 errors +
  4 pre-existing `[duplicate-objects]` warnings.

## 3. Existing Backend Contract (inspected, NOT modified)

- `supabase/functions/executive-analytics/index.ts`: `X-Hospital-ID` is
  required BEFORE auth (missing → 422 `VALIDATION_ERROR`); `resolveAuth` +
  `requireRole(["hospital_admin","global_admin"])` (→ 403
  `ROLE_INSUFFICIENT` / `HOSPITAL_ACCESS_DENIED`); `GLOBAL_ACTIONS` is only
  `{portfolio, benchmarks}`; `daily_operations` → RPC
  `get_daily_operations_dashboard(p_hospital_id, p_date?)`; `doctor_rankings`
  → RPC `get_doctor_rankings(p_hospital_id, p_from_date?, p_to_date?)`; date
  fields validated by `^\d{4}-\d{2}-\d{2}$`.
- Migration 47 §6 RPC shapes: `hourly_trend`/`rankings`/`utilization_heatmap`
  COALESCE'd to `[]`; rates NULL via `NULLIF`; `sla` can be a full object, a
  `compliant`-only variant, or NULL; `doctor_throughput` nullable; ranks are
  SQL `RANK()` values. Defaults: `p_date` = CURRENT_DATE, window =
  CURRENT_DATE−29 → CURRENT_DATE.
- Migration 47 §13: both RPCs GRANT EXECUTE to `service_role` only;
  migration 49 preserves that ACL (verified by grep, no re-grant).

## 4. Files Inspected

`executive-analytics/index.ts`, migrations 47/49, `_shared/auth.ts`,
`_shared/validation.ts` behavior via source, `apps/web/src/lib/api.ts`,
`lib/errors.ts`, `api/portfolio.ts`, `api/financial.ts`,
`api/executiveReports.ts`, `api/alertCenter.ts`, `routes/AdminFinancial.tsx`,
`routes/AdminPortfolio.tsx`, `App.tsx`, `AppShell.tsx`, `types/api.ts`,
`App.test.tsx`, `api/financial.test.ts`, `routes/AdminFinancial.test.tsx`,
`tests/integration/alert_center_http.test.ts`,
`tests/integration/enterprise_command_center.test.ts`, `deno.json`, CI
workflow, `PHASE_7_NEXT_WORKSTREAM_INVESTIGATION_AFTER_G10.md`.

## 5. Files Changed

Created:
- `apps/web/src/api/operations.ts` (86 lines)
- `apps/web/src/routes/AdminOperations.tsx` (611 lines)
- `apps/web/src/api/operations.test.ts` (10 tests)
- `apps/web/src/routes/AdminOperations.test.tsx` (16 tests)
- `tests/integration/executive_analytics_operations_http.test.ts` (14 Deno tests)
- this report

Updated:
- `apps/web/src/types/api.ts` (+124-line G-11 section)
- `apps/web/src/App.tsx` (route `/admin/operations` under
  `RequireRole([...ADMIN_ROLES])`)
- `apps/web/src/components/AppShell.tsx` (NAV "Operations Analytics",
  roles hospital_admin/global_admin)
- `apps/web/src/App.test.tsx` (+6 G-11 routing-boundary tests)

ZERO backend files touched (no Edge Function, SQL, migration, RLS, grant or
SECURITY DEFINER change — git status confirms the list above is the whole
change surface).

## 6. API Wrapper

Two exports only — `fetchDailyOperations(hospitalId, {date?})` and
`fetchDoctorRankings(hospitalId, {fromDate?, toDate?})` — each a thin
`callFunction("executive-analytics", {action, ...optional dates},
{hospitalId})`. Tenant travels ONLY in the `X-Hospital-ID` header (lib/api.ts
behavior); absent dates are OMITTED from the body (backend defaults apply,
never browser-invented); no idempotency keys (reads); no other action string
is reachable (pinned by an exports-equality test and a function-source scan
forbidding `portfolio`, `benchmarks`, `weekly_operations`,
`monthly_executive`, `doctor_performance`, and every mutation action).

## 7. Route

`/admin/operations` renders `<AdminOperations/>` behind
`RequireRole([...ADMIN_ROLES])` — the same UX boundary pattern as G-06…G-10;
server-side authority remains the Edge Function's role gate.

## 8. UI Behavior

Two independently-resolved cards over one bounded `Promise.allSettled`
cycle. Truthful `idle|loading|success|error` per section; role denial or
transport failure is an error banner, never a dressed-up empty dashboard; a
NULL `dashboard`/`rankings` payload renders "no data available" (success,
honestly empty) while an error renders an alert. All values render verbatim
through `display()`: `0` stays `0`, `null`/`undefined` become `—`.

## 9. Daily Operations

Card badge `daily_operations`: date echo, Operations stats (total,
completed, cancellation/no-show rates, avg wait / avg consultation), Hourly
Trend table, Doctor Throughput table (or its honest "no doctor-assigned
bookings" NULL state), SLA stats covering all three server variants
(full object / compliant-only / NULL).

## 10. Doctor Rankings

Card badge `doctor_rankings`: window echo (`from_date`/`to_date` exactly as
the server returned them), rankings table rendered in SERVER ORDER with the
server's `throughput_rank`/`efficiency_rank` (no client sort/re-rank —
proven with an unsorted 20/7/10 fixture whose second row shows rank 4), and
the Mon–Sun utilization heatmap table.

## 11. Global Admin Acting Context

A `global_admin` session with no native tenant reuses the established
G-08/G-09 `fetchActingHospitalContext()` from `api/portfolio.ts` EXACTLY
once, discloses it ("acting context … sent as the required header"), issues
ZERO analytics requests while unresolved, and shows an honest error if no
context exists. No new context mechanism was invented; no cross-hospital
aggregation exists anywhere in the surface.

## 12. Role Isolation

- Server (real HTTP): receptionist → 403 `ROLE_INSUFFICIENT`, doctor → 403
  `ROLE_INSUFFICIENT`, both actions, fail-closed application refusals (the
  500-as-defect guard from G-10 is active in the harness).
- Client (App.test.tsx): receptionist and doctor are redirected at
  `/admin/operations` and the route never mounts (zero requests); the nav
  entry is visible to admin roles only.

## 13. Tenant Isolation

Header-only tenancy; `p_hospital_id` is server-resolved. Real HTTP proves
BOTH directions: adminA→hospitalB and adminB→hospitalA each get 403
`HOSPITAL_ACCESS_DENIED` for both actions with `data === undefined` — no
cross-tenant payload appears even inside failure envelopes. Success
responses echo the header tenant (`hospital_id`), proving the read is
scoped by the server, not filtered by the client.

## 14. PII Review

Static: the two RPCs select only hours, counts, doctor IDs and rates
(migration 47 §6) — no patient column. Runtime: the HTTP suite walks EVERY
key at ANY depth of both live responses against patient-level fragments
(`patient|name|phone|email|address|mrn|medical|diagnosis|notes`) — 0
violations. UI review: no patient identity is fetchable through the wrapper
(action allow-list + exports-equality test). No STOP condition encountered.

## 15. Unit Tests

`deno task test` (backend unit): 97 passed / 0 failed — unchanged baseline,
green after G-11.

## 16. Real HTTP Tests

`tests/integration/executive_analytics_operations_http.test.ts` against the
LOCAL runtime with genuine GoTrue password-grant JWTs: 14/14 PASS —
setup; daily contract (server-shaped, fresh tenant real zeros + NULL rates,
`sla` key present); rankings contract (arrays, default window echoed);
date-parameter mapping (explicit daily date echoed; ranged and half-open
windows echoed); global-admin single-acting-context (tenant echo proves no
aggregation); receptionist 403; doctor 403; missing header 422; anonymous
401 (F16-05 discipline: only the no-data invariant asserted, no layer
claim); cross-tenant both directions 403 + no data; PII walk; direct-RPC
privilege probes (anon + authenticated refused; 404 would be declared a
test defect); fixture cleanup. Edge Runtime was VERIFIED SERVING before the
run (F16-01: `supabase start` exited 0 while `supabase_edge_runtime_setura`
was down and returning 503; the container was started and an application-
layer JWT refusal observed before trusting any result).

## 17. Full Frontend Suite

`npx vitest run` in `apps/web`: **30 files, 371/371 passed** — baseline
339 + 32 new (operations.test.ts 10, AdminOperations.test.tsx 16,
App.test.tsx G-11 6). Includes the G-03…G-10 frontend regressions and the
auth/provider suites untouched.

## 18. Typecheck

`tsc --noEmit` (apps/web): exit 0. `deno task check`: exit 0 and provably
includes the new integration file.

## 19. Build

`npm run build` (tsc + vite): exit 0.

## 20. Migration Validation

`deno task validate:migrations`: 63 files, **0 errors**, 4 warnings — the
exact pre-existing `[duplicate-objects]` baseline; no migration was added.

## 21. Secret Scan

`deno task check:frontend-secrets`: 3 artifacts scanned in `dist`,
**0 secret hits, 0 source maps**. Targeted grep of every new/changed source
file: no hardcoded keys; the only `SERVICE_ROLE_KEY` references are the
integration harness reading local `supabase status` output dynamically
(same sanctioned pattern as all existing suites). `.env` untouched; no
secrets logged.

## 22. Auth Regression

`tests/integration/multi_role_auth.test.ts`: 12/12 PASS. AuthProvider and
`_shared/auth.ts` are UNMODIFIED; frontend auth flows remain green inside
the 371-test suite.

## 23. Closed-Workstream Regression

- `enterprise_command_center.test.ts` (owner of these RPCs' aggregate
  correctness): 23/23 PASS.
- `privilege_isolation.test.ts` (canonical RPC privilege census): 22/22
  PASS.
- fmt:check remains at the pre-existing 8-file baseline (all untouched /
  untracked artifacts); lint on tracked dirs (`supabase`, `tests`,
  `scripts`) is exit 0 — the repo-wide 1944-problem noise comes solely from
  the untracked `_authloop_served_bundle.js` leftover, not from G-11. The
  new integration file was formatted with a targeted `deno fmt` on that
  file only; no other file was rewritten.

## 24. Git Commit

One focused commit on `main`: **"Add Hospital Operations Analytics Read
Surface (G-11)"** — the direct child of the `88df4fc` baseline, recorded in
the session log — staging exactly the 4 updated + 5 new code/test files +
this report. No amend of `88df4fc`, no push, no deploy. Untracked logs,
PNGs, temp files and the `graphify-out` cache change are excluded.

## 25. Limitations

- Evidence is LOCAL runtime only. Docker/Edge availability required manual
  container start this session (F16-01 remains open as an environment
  finding).
- Cross-tenant proofs use fail-closed function-layer denials; the RPC
  privilege boundary was re-proven directly but the broad catalog census
  stays `privilege_isolation.test.ts`'s job.
- The dashboard/rankings fixtures in the route tests are contract-shaped,
  not production-scale; ordering/rank honesty is proven by construction
  (unsorted `completed`, out-of-position `throughput_rank` 4).
- No scheduler/worker claims are made or needed; G-11 is a pure read path.

## 26. Staging Status

**NOT DEPLOYED — NOT YET PROVEN on staging** (explicit session boundary,
spec §33). No `functions deploy`, no secrets set, no schema applied to any
hosted project.

## 27. Production Status

**UNTOUCHED.** No production endpoint, secret or schema was referenced or
modified. Production readiness is not claimed by this report.

## 28. Acceptance Matrix

| Check | Expected | Observed | Status |
| --- | --- | --- | --- |
| Backend contract inspected | pass | Edge Function + migration 47 §6/§13 read first; zero backend files changed | PASS |
| daily_operations local HTTP | 200 | 200 + server-shaped dashboard, tenant echo | PASS |
| doctor_rankings local HTTP | 200 | 200 + arrays and default window echoed | PASS |
| global_admin | 200 | 200 per action with acting context; single-tenant scope | PASS |
| receptionist | 403 | 403 ROLE_INSUFFICIENT both actions | PASS |
| doctor | 403 | 403 ROLE_INSUFFICIENT both actions | PASS |
| missing X-Hospital-ID | 422 | 422 VALIDATION_ERROR | PASS |
| anonymous | 401 | 401, no envelope success, no data (layer not claimed, F16-05) | PASS |
| cross-tenant | 403 | 403 HOSPITAL_ACCESS_DENIED both directions | PASS |
| cross-tenant data leakage | none | `data === undefined` in every denial | PASS |
| unexpected patient PII | none | 0 keys matched across live responses | PASS |
| API wrapper tests | pass | 10/10 | PASS |
| AdminOperations tests | pass | 16/16 | PASS |
| App routing tests | pass | 6/6 (+ full file green) | PASS |
| no mutation controls | none | only control is Refresh (button-census test) | PASS |
| no client ranking calculation | pass | server order + server ranks rendered verbatim | PASS |
| no polling | pass | zero extra cycles after settle; timers absent | PASS |
| bounded Refresh | pass | exactly one more cycle per click | PASS |
| typecheck | pass | tsc 0, deno check 0 (file included) | PASS |
| build | pass | exit 0 | PASS |
| migration validation | 0 errors | 0 errors, 4 pre-existing warnings | PASS |
| secret scan | 0 hits | 0 hits, 0 source maps; no hardcoded keys | PASS |
| full frontend suite | green | 371/371 (339 baseline + 32 new) | PASS |
| existing integration regression | green | ent 23/23, privilege 22/22 | PASS |
| Auth regression | green | multi_role_auth 12/12 | PASS |
| staging | not deployed | nothing deployed; staging UNPROVEN | PASS (by boundary) |
| production | untouched | untouched | PASS (by boundary) |
| focused commit | created | single commit on `main` atop `88df4fc`, 10 files, 2510 insertions | PASS |

## 29. Final Status

G-11 is **IMPLEMENTED and INTEGRATION-VERIFIED LOCALLY**: the two existing
tenant-scoped executive-analytics reads are reachable from the protected
`/admin/operations` surface over the real, unmodified backend, with the
complete authorization matrix (200/403/403/422/401/403+no-data), PII
cleanliness and read-only guarantees proven by REAL HTTP execution on the
local stack, and every repo gate green at or above its documented baseline.

CERTIFICATION VOCABULARY:
- Frontend surface: IMPLEMENTED, UNIT VERIFIED, INTEGRATION VERIFIED (local).
- Real HTTP path: INTEGRATION VERIFIED (local, Edge Runtime confirmed serving).
- Staging: NOT YET PROVEN (out of scope by instruction).
- Production: UNTOUCHED / UNPROVEN.
- No STOP condition (backend change, PII, leakage, aggregation) was
  triggered at any point.
