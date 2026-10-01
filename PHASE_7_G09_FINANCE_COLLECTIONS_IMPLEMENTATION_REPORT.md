# PHASE 7 — G-09 FINANCE / COLLECTIONS READ SURFACE — IMPLEMENTATION REPORT

Status line: **G-09 — LOCAL INTEGRATION VERIFIED · STAGING — NOT YET PROVEN · PRODUCTION — UNTOUCHED**

This report documents an implementation-only workstream. No backend business
logic, SQL, migration, RLS or grant was changed. Staging was not deployed and
production was not touched (§25). No closed workstream was reopened except the
minimal regression smoke in §18 (§23).

---

## 1. Objective

Make the existing, server-authoritative financial/collections backend
(`supabase/functions/financial-command-center/index.ts`, three read-only
actions over `get_financial_command_center`, `get_revenue_forecast`,
`get_reconciliation_summary`) reachable through a controlled, read-only
Hospital Admin frontend surface, and close the HTTP-path evidence gap by adding
a real-Edge-Runtime integration test that exercises
HTTP → Edge Function → auth → role gate → tenant resolution → service-role RPC →
response (not a mock and not a direct-RPC substitute).

Two primary goals only: (1) real HTTP-path integration coverage for
`financial-command-center`; (2) a read-only Finance / Collections frontend
surface for `hospital_admin` + `global_admin`.

## 2. Baseline

- Branch: `main`
- Baseline HEAD: `df4101f` — "Add read-only global admin portfolio dashboard (G-08)"
- Prior workstreams CLOSED and not reopened: G-03, G-05, G-06, G-07, the auth
  request/remount loop fix, G-08.
- The tree is a Git working tree (`git rev-parse --is-inside-work-tree` → true),
  which supersedes the older AGENTS.md §13 note that described it as non-Git.
  Current runtime state is authoritative (§5).

## 3. Files inspected

Backend / shared primitives:
- `supabase/functions/financial-command-center/index.ts` (canonical flow, three actions, `X-Hospital-ID` checked before `resolveAuth`, reconciliation trailing-30-day default, `successResponse` envelope).
- `supabase/functions/_shared/auth.ts` (`resolveAuth`, `requireRole` semantics).
- `supabase/functions/_shared/errors.ts` (error code → HTTP status map).
- `supabase/functions/_shared/database.generated.ts` (financial RPC signatures — read only).

Existing tests reused as pattern/precedent:
- `tests/integration/enterprise_command_center.test.ts` (real-HTTP pattern: `getLocalStatus`, `bootstrap`, `createAuthUser`/`tokenFor`, `callFn`, per-run isolation).
- `tests/integration/privilege_isolation.test.ts` (Category B/C/D direct-RPC denial already proven for the three financial RPCs).

Frontend:
- `apps/web/src/api/portfolio.ts`, `apps/web/src/routes/AdminPortfolio.tsx` (canonical read-only route + `fetchActingHospitalContext`).
- `apps/web/src/routes/AdminReports.tsx`, `apps/web/src/App.tsx`, `apps/web/src/components/AppShell.tsx`, `apps/web/src/types/api.ts`, `apps/web/src/lib/errors.ts`.
- `apps/web/src/api/portfolio.test.ts`, `apps/web/src/routes/AdminPortfolio.test.tsx` (test patterns).
- The G-09 implementation-only specification.

## 4. Files changed

Backend source: **none** (§24). The only backend-adjacent addition is a new
integration test file.

Added:
- `tests/integration/financial_command_center_http.test.ts` (real-HTTP integration test).
- `apps/web/src/api/financial.ts` (thin API wrapper).
- `apps/web/src/api/financial.test.ts`.
- `apps/web/src/routes/AdminFinancial.tsx` (read-only surface).
- `apps/web/src/routes/AdminFinancial.test.tsx`.

Modified (frontend only):
- `apps/web/src/types/api.ts` (financial response types appended).
- `apps/web/src/App.tsx` (`/admin/financial` route guarded by `ADMIN_ROLES`).
- `apps/web/src/components/AppShell.tsx` ("Finance / Collections" nav entry, admin roles only).
- `apps/web/src/App.test.tsx` (G-09 routing/nav boundary tests; existing G-03/G-05/G-06/G-08 tests preserved unchanged).

## 5. Backend changes

**Zero.** No migration, RLS policy, grant, `SECURITY DEFINER` function, or
financial business-logic change was made (§24). The pre-existing
`financial-command-center` Edge Function and its three service-role-only RPCs
were consumed as-is. The HTTP test surfaced no backend defect, so no STOP
condition was triggered and no silent fix was applied.

## 6. Frontend changes

- `api/financial.ts`: three thin fetchers (`fetchFinancialOverview`,
  `fetchRevenueForecast`, `fetchReconciliationSummary`) over the shared
  `callFunction<T>` transport. Tenant is sent ONLY as the `X-Hospital-ID`
  header, never in the body; optional dates are omitted when absent; no
  idempotency key (read-only).
- `AdminFinancial.tsx`: three independent read-only sections
  (Overview / Revenue Forecast / Reconciliation) with an explicit
  idle/loading/success/error state model. Presentation-only rendering of server
  values (§10): the page never sums, subtracts or re-derives any amount.
  Currency formatting is the single allowed transformation. Null-vs-zero is
  preserved (§11): `0` renders as `0`/`₹0`, absence renders as `—`, using
  explicit null checks (`display()`/`money()`), never `value || "—"`. INR
  grouping is deterministic (`formatIndian()`), avoiding `Intl` ICU variance.
  Date model mirrors the backend (§13): overview/forecast take one optional
  day; reconciliation takes an optional from/to window; blanks defer to the
  RPC's own defaults; no browser-local date substitution.

## 7. HTTP-path integration test

`tests/integration/financial_command_center_http.test.ts` — self-contained
fixtures (two hospitals, `hospital_admin` A/B, `receptionist`, `doctor`, a
tenant-less `global_admin`, and one `daily_collection_entries` source row for
hospital A) driven against the live local Edge Runtime via
`POST /functions/v1/financial-command-center`. **13 tests, all passing** (see
§15). It proves the real request path end-to-end, including that the response
carries the server's own aggregate (`daily_collections.total_collected === 4200`),
not a browser computation.

## 8. Authorization matrix (proven over real HTTP)

| Actor | Request | Result |
| --- | --- | --- |
| `hospital_admin` (own tenant) | overview / forecast / reconciliation | 200 + server aggregates |
| `global_admin` (valid `X-Hospital-ID`) | overview | 200 — per existing G-08 bounded acting-context contract (no invented tenant) |
| `receptionist` | all three actions | 403 `ROLE_INSUFFICIENT` |
| `doctor` | all three actions | 403 `ROLE_INSUFFICIENT` |
| any (missing `X-Hospital-ID`) | overview | 422 `VALIDATION_ERROR` |
| anonymous (no JWT) | overview | 401 `UNAUTHORIZED` (status-only assertion, per F16-05 caution) |
| explicit `date` input | overview / reconciliation | honored; server echoes the requested day |

## 9. Tenant-isolation evidence

`hospital_admin` of tenant B requesting tenant A's finances is rejected
`403 HOSPITAL_ACCESS_DENIED` (fail-closed) and reads nothing; the seeded
collection row for hospital A is never visible through hospital B's context.
Defense remains DB-enforced via `resolveAuth` + service-role RPC tenant checks —
no client-supplied hospital ID is trusted.

## 10. RPC privilege evidence

- Reused `privilege_isolation.test.ts` (**22/22 pass**): Category B/C/D RPCs
  (including the three financial RPCs) are refused for `anon` and
  `authenticated` and still work for `service_role`.
- The new HTTP test adds a self-contained probe: client roles calling the three
  financial RPCs directly through PostgREST are denied
  (`401`/`403` + permission-denied / does-not-exist / 42501). A `404` is treated
  as a test defect, not a pass.
- Direct client RPC access therefore remains denied (§7); the browser can only
  reach the aggregates through the Edge Function's authorized path.

## 11. Frontend test results

- Focused (AdminFinancial + financial API + App routing additions): pass.
- Full frontend suite: **26 files / 310 tests passed** (see §18).
- New tests pin: exactly one read per action per explicit load with no polling
  or StrictMode remount double-fire; a single manual Refresh is the only other
  trigger; server values render verbatim (a `₹337` net appears while a naive
  `₹1,20,000 = total − refunds` never does — proof of no client-side math);
  null-vs-zero (`₹0`, `0`, `—`) and "no data" vs error; a numeric string
  amount formats without alteration; each section fails/empties independently;
  a role denial renders as an error, never as an empty dashboard; a tenant-less
  global admin reuses `fetchActingHospitalContext` exactly once with the scope
  disclosed; an unresolved context waits honestly issuing zero financial
  requests.

## 12. Full regression results

- Frontend `npm run test`: **310 passed / 26 files / 0 failed** (~19s).
- Deno integration suites executed this session: financial HTTP (13),
  privilege isolation (22), enterprise command-center smoke (23) — all green.

## 13. Typecheck result

- `npm run typecheck` (`tsc --noEmit`) — **clean**.
- `deno task check` (includes the new integration test in its file set) —
  **exit 0**. The frontend-`tsc`-context warnings on the Deno test file
  (`Deno`, remote modules, `res.json` nullability) were confirmed FALSE
  POSITIVES: `deno check` on that file passes on its own.

## 14. Build result

- `npm run build` (`tsc --noEmit && vite build`) — **passed** ("built in
  ~4.4s"). Only a non-fatal "chunk larger than 500 kB" advisory; no error.

## 15. Local runtime result

Against the running local Supabase stack (started this session; Edge Runtime
serving was explicitly verified — a bare `supabase start` exit code was NOT
trusted, per AGENTS.md §13):
- `financial_command_center_http.test.ts`: **13 passed / 0 failed**.
- `privilege_isolation.test.ts`: **22 passed / 0 failed**.
- `deno task validate:migrations`: **0 errors**, 4 pre-existing
  `[duplicate-objects]` warnings (documented baseline; not new).
- `deno task lint` on the new file: clean ("Checked 1 file").
- `deno fmt --check` on the new file: clean after normalizing CRLF→LF; repo-wide
  count dropped 8→7, confirming G-09 introduces zero new formatting defects
  (the remaining 7 are pre-existing minified root `.js` bundle artifacts).

## 16. Browser result

Not executed this session. Verification was via real Edge-Runtime HTTP
integration + unit + build gates, not an interactive browser walkthrough of the
`/admin/financial` route. Browser verification is deferred to the explicitly
authorized G-09 staging step. No browser claim is made.

## 17. Service-role scan

`deno task check:frontend-secrets` — **0 secret hits, 0 source maps** (3 build
artifacts in `dist`). The frontend bundle embeds no service-role key, JWT
secret, or provider secret; the financial RPCs remain reachable only through
the authorized Edge Function.

## 18. Closed-workstream regression

Minimal smoke only (§23) — no closed workstream was reopened, redesigned or
retested beyond this:
- Backend: `enterprise_command_center.test.ts` **23/23 pass**, including
  "auth gates enforce roles and portfolio scope" — the shared
  auth/tenant/portfolio primitive G-09 reuses.
- Frontend: full suite **310/310 pass**, whose `App.test.tsx` covers the
  G-03/G-05/G-06/G-07/G-08 routes/nav remaining unchanged alongside G-09.
- No backend source changed, so SQL/RLS/grant behavior is byte-identical to the
  `df4101f` baseline (confirmed by `validate:migrations` and the passing
  privilege suite).

## 19. Git commit

One focused commit on `main`, staging ONLY G-09 artifacts:

`Add Finance / Collections Read Surface (G-09)`

Files in the commit: the five added files (§4), the four modified frontend
files (§4), and this report. No unrelated screenshots, probe logs, investigation
documents, generated noise, secrets or environment files were staged (`*.log`
verification artifacts are gitignored; staging was done by explicit path, never
`git add .`). No history rewrite, no force-push. The commit is local; per §25
the normal push/deploy step is a separate explicit action and was not performed.

## 20. Known limitations

- No interactive browser E2E of `/admin/financial` (§16) — deferred to the
  authorized staging step.
- Verification is LOCAL only; not a production certification.
- The repo-wide `deno fmt --check` still reports 7 pre-existing unformatted
  minified bundle artifacts unrelated to G-09 (not fixed; not asked; §2 —
  `fmt` rewrites files).
- `validate:migrations` keeps its 4 documented pre-existing duplicate-object
  warnings.

## 21. Staging status

**NOT YET PROVEN / NOT DEPLOYED.** No `supabase functions deploy` and no
staging rollout were run (§25). Staging verification is the next explicitly
authorized step.

## 22. Production status

**UNTOUCHED.** No production deployment, secret, migration or configuration was
touched.

## 23. Final acceptance matrix

| # | Criterion | Result |
| --- | --- | --- |
| 1 | Existing `financial-command-center` contract inspected | PASS |
| 2 | Existing RPCs inspected | PASS |
| 3 | Existing grants/privilege model preserved | PASS (no backend change) |
| 4 | Real HTTP integration test added | PASS (13 tests) |
| 5 | Hospital admin authorization proven | PASS (200) |
| 6 | Global admin authorization per existing contract | PASS (200, bounded acting context) |
| 7 | Receptionist denied | PASS (403) |
| 8 | Doctor denied | PASS (403) |
| 9 | Anonymous denied | PASS (401) |
| 10 | Missing tenant rejected | PASS (422) |
| 11 | Cross-tenant isolation proven | PASS (403 fail-closed) |
| 12 | Direct RPC privilege remains denied | PASS (22/22 + probe) |
| 13 | No backend financial business logic changed | PASS |
| 14 | No SQL/migrations changed | PASS |
| 15 | No RLS/grants changed | PASS |
| 16 | Financial API wrapper implemented | PASS |
| 17 | AdminFinancial route implemented | PASS |
| 18 | App routing updated | PASS |
| 19 | AppShell navigation updated | PASS |
| 20 | Three read-only financial sections implemented | PASS |
| 21 | No client-side financial calculations | PASS |
| 22 | Null-vs-zero semantics preserved | PASS |
| 23 | Explicit loading/error/empty states | PASS |
| 24 | No polling | PASS |
| 25 | No automatic refresh loop | PASS |
| 26 | Manual refresh bounded | PASS |
| 27 | Unauthorized roles make zero financial calls | PASS |
| 28 | Service-role scan clean | PASS (0 hits) |
| 29 | Frontend focused tests pass | PASS |
| 30 | Full frontend suite passes | PASS (310/310) |
| 31 | Typecheck passes | PASS |
| 32 | Build passes | PASS |
| 33 | Local Edge Runtime HTTP verification passes | PASS (serving verified) |
| 34 | Closed-workstream smoke passes | PASS (23 backend + 310 frontend) |
| 35 | Console clean | PASS (build clean; chunk advisory non-fatal) |
| 36 | No unrelated files changed | PASS |
| 37 | Focused G-09 commit created | PASS (local) |
| 38 | Implementation report created | PASS (this file) |
| 39 | Staging NOT deployed | PASS (not deployed) |
| 40 | Production untouched | PASS |

---

**FINAL STATUS**

```text
G-09 — LOCAL INTEGRATION VERIFIED
STAGING — NOT YET PROVEN
PRODUCTION — UNTOUCHED
```

STOP. The next separate step is an explicitly authorized G-09 staging
deployment + browser verification.
