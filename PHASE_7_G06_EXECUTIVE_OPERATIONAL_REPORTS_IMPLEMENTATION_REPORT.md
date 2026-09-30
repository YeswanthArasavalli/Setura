# SETURA — PHASE 7 G-06 IMPLEMENTATION REPORT
## Executive / Operational Reports Viewer

> Evidence standard: each claim is labelled **IMPLEMENTED**, **STATICALLY
> VERIFIED**, **UNIT VERIFIED**, **INTEGRATION VERIFIED**, **RUNTIME VERIFIED**,
> **PROVEN STAGING**, **BLOCKED** or **UNPROVEN** per `AGENTS.md §5`. BLOCKED is
> never converted into PASS.

---

## 1. Executive Summary

G-06 is a **Class B — frontend reachability** gap. The `enterprise-reports`
`generate` backend was already implemented and HTTP-integration-proven; this
phase adds a strictly read-only **Executive / Operational Reports viewer** at
`/admin/reports` that exposes **exactly the six approved non-financial report
types** over the existing Edge Function, with no backend, SQL, RLS, grant or
deployment changes.

**Status: IMPLEMENTED · STATICALLY VERIFIED · UNIT VERIFIED. Integration /
local-browser / staging-browser runtime proof is BLOCKED this session
(Docker daemon not running; no commit/deploy authorization or staging
credentials). Therefore G-06 is NOT PROVEN STAGING and completion is not
claimed.**

---

## 2. Baseline

| Item | Value | Status |
| --- | --- | --- |
| `HEAD` | `a02200f1aeb9007de8bf1b96c967d9c489dab204` | verified |
| `origin/main` | `a02200f…` (== HEAD) | verified |
| Branch | `main` | verified |
| Working tree at start | clean except two untracked G-05 report files | verified |

Verified with `git rev-parse HEAD`, `git rev-parse origin/main`, `git branch`,
`git status`, `git log`. Baseline matched the spec's expectation exactly.

> Note: `AGENTS.md §13` records this tree as "NOT a Git repository." That
> snapshot is stale for the current session — the tree **is** a Git repo
> (confirmed by `git rev-parse --is-inside-work-tree` → `true`). This report
> reflects the actual runtime state, not the cached snapshot.

**Pre-existing untracked files (NOT part of G-06, NOT to be committed):**
`PHASE_7_G05_HOSPITAL_ADMIN_AUDIT_COMPLIANCE_IMPLEMENTATION_REPORT.md`,
`PHASE_7_NEXT_PRODUCT_GAP_INVESTIGATION_AFTER_G05.md`.

**Staging / frontend (from spec, not independently exercised this session):**
`setura-staging` (`gzcqasntcbqqmgsoikms`, `ap-south-1`); frontend
`https://setura-delta.vercel.app`.

---

## 3. Scope — the six approved report types

Implemented (UI-visible):

```text
daily_hospital
weekly_operations
monthly_executive
doctor_performance
sla
audit
```

Excluded (unreachable from the console):

```text
financial
settlement
```

---

## 4. Backend Contract Verification (actual source, not assumed)

Read from `supabase/functions/enterprise-reports/index.ts`,
`supabase/functions/_shared/response.ts`, migration
`49_phase_1_5_defect_fixes.sql` (`generate_executive_report` — the authoritative
`CREATE OR REPLACE` over migration 47), and
`tests/integration/enterprise_command_center.test.ts`.

**Request** — `POST /functions/v1/enterprise-reports`
- Headers: `apikey`, `Authorization: <user JWT>`, **`X-Hospital-ID`** (required;
  missing → `ValidationError` 422). Tenant is verified server-side by
  `resolveAuth(req, hospitalId)` + `requireRole([hospital_admin, global_admin])`.
- Body (zod `Schema`): `{ action: "generate", reportType ∈ 8-type enum,
  format? ∈ "json"|"csv"|"pdf_ready", fromDate? /YYYY-MM-DD/, toDate?
  /YYYY-MM-DD/ }`. `reportType` is required for `generate`.

**Response envelope** (`successResponse`): `{ success, data, correlationId,
timestamp }`; `callFunction` returns `data`. For json format, `data = {
action: "generate", format, report }` where `report` is the RPC JSONB:

```jsonc
{
  "ok": true,
  "report_type": "<type>",
  "hospital_id": "<uuid>",
  "from_date": "<date>",
  "to_date": "<date>",
  "columns": ["<top-level keys of data>"],
  "data": { /* report-specific, see §7 */ },
  "generated_at": "<timestamp>"
}
```

Rejection variant (`ok:false`, unknown type) is converted by the Edge Function
into a **422 `VALIDATION_ERROR`**; a cross-tenant header with a valid JWT for
another hospital yields **403 `FORBIDDEN`**. Generation is audited as
`executive_report`. These are proven by the backend's own HTTP suite (lines
1477–1535) — **INTEGRATION VERIFIED at the backend layer** (by the existing
suite), not re-run this session.

**Confirmed non-uniform shapes:** the six reports do **not** share one `data`
shape (verified against migration 49 §CASE and the test's `"supports all 8
report types"` loop) — hence the structural renderer (§17 approach below).

---

## 5. Files Changed

New:
- `apps/web/src/api/executiveReports.ts` — thin `generate` wrapper + allow-list.
- `apps/web/src/routes/AdminReports.tsx` — the read-only viewer.
- `apps/web/src/api/executiveReports.test.ts` — wrapper contract tests.
- `apps/web/src/routes/AdminReports.test.tsx` — viewer UX tests.

Modified (additive only):
- `apps/web/src/App.tsx` — `/admin/reports` route under `ADMIN_ROLES` guard.
- `apps/web/src/components/AppShell.tsx` — admin-only "Executive Reports" nav item.
- `apps/web/src/types/api.ts` — G-06 types (`ExecutiveReportType`, `JsonValue`,
  `ExecutiveReportPayload`, `GenerateReportResponseBody`).
- `apps/web/src/App.test.tsx` — G-06 routing boundary tests + AdminReports stub.

**Backend / SQL / RLS / grants / Edge Functions: ZERO changes** (confirmed by
`git diff --stat`: 4 files, +135 lines, all frontend).

---

## 6. Frontend Implementation

- **Route:** `/admin/reports`, guarded by `RequireRole roles={[hospital_admin,
  global_admin]}` (UX layer only; backend remains authoritative).
- **Navigation:** "Executive Reports" item shown only to `hospital_admin` /
  `global_admin`; receptionist and doctor never see the entry.
- **API wrapper:** a **SEPARATE** module (`executiveReports.ts`), deliberately
  NOT `enterpriseReports.ts`. The G-05 module's own test
  (`"never references the generate action anywhere in the wrapper layer"`) pins
  that it exposes exactly six read wrappers and never `generate`; adding
  `generate` there would have broken the G-05 boundary. `generateExecutiveReport`
  takes `reportType: ExecutiveReportType` (financial/settlement excluded at the
  type level) **and** a runtime allow-list guard (defends against a cast),
  builds `{ action: "generate", reportType, fromDate?, toDate? }`, sends the
  tenant only via the shared `callFunction` header context, uses no idempotency
  key, and propagates errors unchanged.
- **Types:** dynamic `data` typed as `JsonValue` (no `any`), not forced into an
  invented uniform schema.
- **Renderer:** walks the **actual returned keys**. Nested objects render as
  key/value blocks; an array of records renders as a table whose columns are the
  rows' **own** keys (never a fabricated fixed schema); scalars format
  truthfully.
- **Role guards:** route guard + backend `requireRole` (defense in depth).

---

## 7. Report Types — request / response / UI / validation

| Type | Request | `data` top-level sections (from migration 49) |
| --- | --- | --- |
| `daily_hospital` | `generate` (+ optional from/to) | patients, queues, sla, finance, alert_activity |
| `weekly_operations` | same | rollup, incidents, doctor_productivity |
| `monthly_executive` | same | rollup, sla_trend, settlements |
| `doctor_performance` | same (date range meaningful) | rankings, utilization_heatmap |
| `sla` | same | summary, hospitals_in_breach, trend_14d |
| `audit` | same (date range meaningful) | audit_coverage (array) |

UI: each of the six is an independent card with its own **idle / loading /
success / empty / error** state and an explicit **Generate report** button
(generated only on click, never on mount/keystroke/poll).

**Staging result: NOT OBSERVED** (see §14/§18).

---

## 8. Financial Boundary

- Standalone `financial` and `settlement` report types are **not** exposed: the
  parameter type is a 6-value union, and the runtime allow-list throws before any
  network call. **UNIT VERIFIED**
  (`executiveReports.test.ts` "refuses the out-of-scope financial and settlement
  report types at runtime").
- **No financial mutation** path exists: the only request is the read `generate`
  action; no idempotency key; no booking/queue/patient/payment/refund control.
  **UNIT VERIFIED** (route test "contains no mutation control").
- **No client-side business math:** the viewer renders backend fields verbatim
  and computes no revenue/SLA%/score/total (§15).

> **Honest nuance (NOT a hidden financial surface):** `daily_hospital` embeds a
> `finance` rollup and `monthly_executive` embeds a `settlements` rollup. These
> are backend-computed aggregate fields **inside the two approved operational /
> executive report types**, not the excluded standalone `financial`/`settlement`
> report types, and they are displayed without any client-side calculation or
> mutation. The investigation classified these six as "non-financial report
> types," which is accurate at the report-TYPE level; the boundary G-06 enforces
> (and the spec defines in §4/§8/§38) is the report-type allow-list, which is
> upheld. Flagged here rather than silently redacted, because stripping these
> backend fields would alter the report's real structure (§7/§15).

---

## 9. Security

- **Role isolation:** route guard + backend `requireRole([hospital_admin,
  global_admin])`. **UNIT VERIFIED** at the routing layer
  (`App.test.tsx` G-06 block: receptionist/doctor denied, admins allowed).
- **Tenant isolation:** tenant travels only in the `X-Hospital-ID` header from
  the authenticated session; body never carries a hospital field (**UNIT
  VERIFIED**). Server-side cross-tenant 403 / missing-header 422 are the
  backend's own proven behavior (**INTEGRATION VERIFIED at backend layer, not
  re-run this session**).
- **Service-role safety:** the browser uses anon key + user JWT only. No
  privileged key in the built bundle — **STATICALLY VERIFIED** via dist scan for
  `service_role` / `SERVICE_ROLE_KEY`: **NO_SERVICE_ROLE_IN_BUNDLE**.

---

## 10. Testing

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | **PASS** |
| Build | `npm run build` (`tsc --noEmit && vite build`) | **PASS** |
| Unit (G-06 targeted) | `vitest run` on 4 files | **43 passed** |
| Unit (full frontend) | `npm test` | **221 passed / 20 files** |
| Integration regression | `deno … test:integration` (`enterprise_command_center.test.ts`) | **BLOCKED** |

G-06 tests cover: exact request body per type; 1:1 date mapping with absent-key
omission; header-only tenant; no idempotency key; runtime rejection of
financial/settlement; error propagation; verbatim resolution; six-cards/no-money
surface; zero requests on mount; no request on date keystroke; one request per
click; truthful 0-vs-dash rendering; isolated failure (report A error doesn't
crash the page; others remain usable); empty data → "No data."; tenant-less
account → truthful no-tenant state + zero requests; no mutation control.

The full suite also re-confirmed the G-05 boundary
(`enterpriseReports.test.ts` and the AdminAudit "no wrapper call ever carries
the generate action") stayed green — **no regression to G-03/G-05**.

---

## 11. Browser Staging Validation

**BLOCKED / NOT OBSERVED.** See §14 and §18. A real staging browser pass needs
(a) the code deployed to `setura-delta.vercel.app` pointing at staging Supabase,
and (b) seeded staging login credentials for hospital_admin / receptionist /
doctor / global_admin plus a browser harness. Deployment requires a commit/push,
which `spec §35` gates until staging verification is complete (circular) and
which was **not authorized** in this session. Not claimed.

---

## 12. Network Safety

**STATICALLY/UNIT VERIFIED (design):** the only request the viewer can produce is
`POST enterprise-reports {action:"generate", reportType ∈ 6}`. No payment,
refund, booking/queue/patient/doctor mutation, WhatsApp, worker or scheduler call
path exists from this UI (route test asserts no mutation control; wrapper test
asserts the exact body). Live staging network capture: **NOT OBSERVED**.

---

## 13. Console Cleanliness

Unit tests surfaced no application console errors (only pre-existing React Router
v7 future-flag **warnings**, unrelated to G-06). Real-browser console capture:
**NOT OBSERVED** (staging not exercised).

---

## 14. Deployment

`enterprise-reports` **NOT redeployed** — G-05 deployment remained fresh;
`spec §3/§34` explicitly forbid a precautionary redeploy and no live CORS/drift
evidence exists to justify one. No other Edge Function was touched. The frontend
was **not** deployed to staging/production this session (no commit/push
authorization; §35 gate).

---

## 15. Production

```text
PRODUCTION NOT TOUCHED
```

---

## 16. Acceptance Gate (A1–A23)

| Gate | Criterion | Result |
| --- | --- | --- |
| A1 | Hospital admin can open `/admin/reports` | **UNIT VERIFIED** (routing) · runtime UNPROVEN |
| A2 | Reports nav visible only to admin roles | **UNIT VERIFIED** |
| A3 | All six approved report types available | **UNIT VERIFIED** |
| A4 | No financial/settlement type exposed | **UNIT VERIFIED** |
| A5 | Each report generates via existing contract | **UNIT VERIFIED** (request shape) · runtime **BLOCKED** |
| A6 | Real staging data renders correctly | **BLOCKED / NOT OBSERVED** |
| A7 | Null/zero/empty semantics truthful | **UNIT VERIFIED** |
| A8 | Receptionist cannot access route | **UNIT VERIFIED** |
| A9 | Doctor cannot access route | **UNIT VERIFIED** |
| A10 | Denied roles issue zero requests | **UNIT VERIFIED** |
| A11 | Tenant isolation proven | **BACKEND INTEGRATION VERIFIED (prior)** · not re-run; frontend layer UNIT VERIFIED |
| A12 | Missing/invalid tenant → backend contract | **BACKEND VERIFIED (prior)** · not re-run this session |
| A13 | Global-admin behavior truthful | **UNIT VERIFIED** (no-tenant state) · staging NOT OBSERVED |
| A14 | No service-role credential reaches browser | **STATICALLY VERIFIED** (bundle scan) |
| A15 | No financial mutation | **UNIT VERIFIED** |
| A16 | No booking/queue/patient mutation | **UNIT VERIFIED** |
| A17 | No WhatsApp/worker/scheduler activity | **UNIT VERIFIED** (design) |
| A18 | No unexpected console errors/warnings | **PARTIAL** (unit: none) · browser NOT OBSERVED |
| A19 | No duplicate/polling request loop | **UNIT VERIFIED** |
| A20 | Existing integration tests remain green | **BLOCKED** (Docker daemon not running) |
| A21 | Typecheck passes | **PASS** |
| A22 | Build passes | **PASS** |
| A23 | Evidence report complete | **PASS** (this document) |

Because mandatory runtime gates (A5 runtime, A6, A20, and the staging portions of
A11/A12/A13/A18) are **BLOCKED / NOT OBSERVED**, **G-06 = NOT PROVEN STAGING**.

---

## 17. Definition of Done

Done when the six report types render real staging data for hospital_admin via
browser proof, tenant isolation and cross-tenant 403 are re-observed on staging,
the integration regression is green against a running stack, and console/network
are clean. Frontend/static/unit portions are complete; runtime/browser portions
are not.

---

## 18. Remaining Limitations

- **No screenshots / no live staging run.** Not captured (stack/deploy
  unavailable this session).
- **Integration regression (`enterprise_command_center.test.ts`) BLOCKED:**
  `docker ps` failed to connect to the Docker Desktop Linux engine pipe, so the
  local Supabase stack and `deno test:integration` cannot run. Classified
  **environment**, not product.
- **Global-admin tenant context:** the seeded global admin has `hospital_id =
  null`; `generate_executive_report` requires a tenant UUID, so the viewer shows
  a truthful "no hospital tenant" state and issues zero requests. No hospital was
  invented. Whether global/portfolio (tenant-less) reporting should exist is a
  product/backend decision outside G-06's no-backend-change scope.
- **Report-specific staging data availability:** per-report staging richness
  (e.g. whether a given day has queue/patient rows) was not observed.
- **Nested finance/settlement rollups** inside `daily_hospital` /
  `monthly_executive` are rendered as returned (see §8) — flagged, not hidden.
- **No commit / no push / no deploy** performed (§35).

---

## 19. Final Status

```text
G-03: PROVEN STAGING — CLOSED
G-05: PROVEN STAGING — CLOSED

G-06: NOT PROVEN STAGING (frontend IMPLEMENTED + STATICALLY + UNIT VERIFIED;
      integration/local-browser/staging-browser BLOCKED this session)

IMPLEMENTED: /admin/reports executive & operational reports viewer (read-only)
REPORT TYPES: daily_hospital, weekly_operations, monthly_executive,
              doctor_performance, sla, audit
FINANCIAL / SETTLEMENT REPORTS: EXCLUDED (type-level + runtime allow-list)
FRONTEND: 4 new + 4 additive-modified files (see §5)
BACKEND SOURCE CHANGED: NO
ENTERPRISE-REPORTS REDEPLOYED: NO
DATABASE / RLS CHANGED: NO
OTHER EDGE FUNCTIONS DEPLOYED: NO
FINANCIAL MUTATIONS: NONE
WHATSAPP: NOT TOUCHED
WORKER / SCHEDULER: NOT TOUCHED
PRODUCTION: NOT TOUCHED

TESTS: typecheck PASS · build PASS · unit 221 passed (43 G-06) ·
       integration BLOCKED (Docker daemon down)
STAGING: NOT OBSERVED (no deploy authorization / credentials this session)
TENANT ISOLATION: backend contract unchanged & previously integration-verified;
                  frontend header-only tenancy UNIT VERIFIED; runtime re-run BLOCKED
ROLE ISOLATION: UNIT VERIFIED (route guard) · backend requireRole unchanged
SECURITY: no service-role in bundle (static) · no mutations · allow-list enforced
CONSOLE / NETWORK: unit-clean & design-safe; live browser capture NOT OBSERVED
GIT: baseline a02200f (== origin/main) on main; G-06 changes are uncommitted;
     two unrelated G-05 report files remain untracked and must not be committed
EVIDENCE REPORT: this file

FINAL STATUS: NOT PROVEN STAGING
STOP: YES
```
