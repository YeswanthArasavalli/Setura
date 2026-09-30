# SETURA — PHASE 7: NEXT PRODUCT GAP INVESTIGATION AFTER G-05 PROVEN STAGING
## Fresh Read-Only Discovery

**Phase:** 7 — Next Product Gap Investigation (DISCOVERY ONLY)
**Date:** 2026-09-29
**Status:** COMPLETE — STOP. No source, SQL, migration, RLS, grant, RPC, Edge
Function, frontend, test, deployment, staging-data, secret, commit or push
performed. Read-only git inspection, current source/migration/test census and
current-report review only.
**Supersedes:** `PHASE_7_NEXT_PRODUCT_GAP_INVESTIGATION_REPORT.md` (the
post-G-03 investigation at baseline `0cb2800`), whose selected candidate —
Hospital Admin Audit & Compliance Viewer (G-05) — has since been implemented at
`a02200f` ("Add Hospital Admin Audit & Compliance Viewer (G-05 frontend)") and
closed as **PROVEN STAGING**. That report's baseline and selection are now
STALE / RESOLVED; this is a fresh investigation against `a02200f`.

---

## 1. Executive Summary

After G-05, the hospital-admin / global-admin persona has two live,
staging-proven, read-only surfaces: the Command Centre (`/admin`, G-03) and the
Audit & Compliance viewer (`/admin/audit`, G-05). Both are layered over the same
`enterprise-reports` / `command-center` Edge Functions.

The largest remaining **evidence-supported, bounded** product gap is that the
**`generate` action of `enterprise-reports` — the eight executive/operational
report types — is still completely unreachable from the product UI.** G-05
deliberately wrapped only the six audit/compliance read actions and left
`generate` out (its `financial`/`settlement` types render money figures). The
operational/executive report types (`daily_hospital`, `weekly_operations`,
`monthly_executive`, `doctor_performance`, `sla`, `audit`) contain no money
figures, are already HTTP-integration-proven through the real Edge Function, and
require **no new backend and no redeployment** — `enterprise-reports` was
specifically refreshed to staging during G-05 and is therefore **NOT** one of
the eight stale functions.

The recommended next gap is a **read-only Executive / Operational Reports
viewer** — a frontend-only surface over the already-proven, already-fresh
`enterprise-reports.generate` action, explicitly restricted to the six
non-financial report types. It is the most justified candidate because it is the
direct sibling of the just-closed G-05 (same function, same role gate, same
tenant model, already redeployed), carries the highest evidence strength of any
remaining gap, and introduces no SQL/RLS/grant/SECURITY DEFINER/source change
and no deployment drift. Implementation is **not** started here.

---

## 2. Current Baseline (verified)

| Check | Verified value |
| --- | --- |
| Branch | `main` |
| HEAD | `a02200f1aeb9007de8bf1b96c967d9c489dab204` |
| origin/main | `a02200f1aeb9007de8bf1b96c967d9c489dab204` (== HEAD) |
| HEAD subject | `Add Hospital Admin Audit & Compliance Viewer (G-05 frontend)` |
| Prior G-03 baseline | `0cb2800` ("Add Admin Command Centre (G-03) frontend & reports") — confirmed present in history |
| Working tree | `git status` clean **except** 1 untracked file: `PHASE_7_G05_HOSPITAL_ADMIN_AUDIT_COMPLIANCE_IMPLEMENTATION_REPORT.md` (left uncommitted, per §6 of the brief) |
| Staging Supabase | `setura-staging` / ref `gzcqasntcbqqmgsoikms` / `ap-south-1` |
| Staging frontend | `https://setura-delta.vercel.app` |

**CONFLICT REPORTED (not silently reconciled):** AGENTS.md §13 still asserts "the
working tree is NOT a Git repository (no `.git`)". This is **out of date** — the
tree is now a functional Git repository (`git status` / `git branch` / `git log`
/ `git rev-parse` all succeed, `HEAD == origin/main == a02200f`). The two prior
investigation reports already noted the same. Git inspection was used and
succeeded; no git command "fixed" or mutated anything. **GIT: UNCHANGED.**

No commit, push, amend, rebase or reset was performed.

---

## 3. G-03 Closure

```text
G-03 = PROVEN STAGING — CLOSED
```

Command Centre (`/admin`) treated as CLOSED. Not reopened, not re-investigated,
not modified.

---

## 4. G-05 Closure

```text
G-05 = PROVEN STAGING — CLOSED
```

Audit & Compliance viewer (`/admin/audit`) treated as CLOSED. Not reopened, not
redesigned. Its minor UX polish (noted in the G-05 report) is explicitly **NOT**
added here. Its investigation is **NOT** repeated. Confirmed from the G-05
report: frontend-only, `generate` deliberately not wrapped, one targeted staging
redeploy of `enterprise-reports`, no backend/SQL/RLS/grant/SECURITY DEFINER
change, A1–A20 PASS.

---

## 5. Current Frontend Inventory (rebuilt from `App.tsx` + `AppShell.tsx` + `api/`)

| Route | Roles (`RequireRole`) | Screen | Class |
| --- | --- | --- | --- |
| `/login` | public | Login | IMPLEMENTED + REACHABLE |
| `/` (index, in shell) | reception ∪ doctor ∪ admin | Landing (role redirect) | IMPLEMENTED + REACHABLE |
| `/reception` | receptionist, hospital_admin | ReceptionDashboard | IMPLEMENTED + REACHABLE |
| `/reception/book` | receptionist, hospital_admin | BookAppointment | IMPLEMENTED + REACHABLE |
| `/reception/walk-in` | receptionist, hospital_admin | WalkIn | IMPLEMENTED + REACHABLE |
| `/reception/patients` | receptionist, hospital_admin | Patients | IMPLEMENTED + REACHABLE |
| `/reception/notifications` | receptionist, hospital_admin | Notifications | IMPLEMENTED + REACHABLE |
| `/queue` | receptionist, hospital_admin | QueueBoard | IMPLEMENTED + REACHABLE |
| `/doctor` | doctor, hospital_admin | DoctorConsole | IMPLEMENTED + REACHABLE |
| `/admin` | hospital_admin, global_admin | AdminCommandCentre (G-03) | IMPLEMENTED + REACHABLE |
| `/admin/audit` | hospital_admin, global_admin | AdminAudit (G-05) | IMPLEMENTED + REACHABLE |
| `/bookings/:bookingId` | shell roles | BookingDetail | IMPLEMENTED + REACHABLE |

**Navigation coverage** (`AppShell.tsx` `NAV`): Dashboard, Appointment, Walk-in,
Patients, Notifications, Queue/Tokens, Doctor Console, **Command Centre**
(admin roles only), **Audit & Compliance** (admin roles only). No nav entry and
no route exists for executive/operational reports, finance/collections, alerts,
or global-admin portfolio.

**Edge Functions the frontend actually calls** (grep of `apps/web/src`, traced to
`callFunction(...)`): `create-booking`, `queue-control`, `doctor-operations`,
`cancel-booking`, `update-booking-status` (via `api/statuses.ts`),
`command-center`, `enterprise-reports` (G-05). Reads are PostgREST SELECT under
RLS (`api/reads.ts`); there are zero direct client table writes; all mutations
are Edge-Function mediated.

**Not consumed anywhere in the UI** (0 call sites): `executive-analytics`,
`alert-center`, `financial-command-center`, `reschedule-booking`, and — within
`enterprise-reports` — the `generate` action / report types (the G-05 wrapper
exports exactly six audit/compliance functions; `generate` is intentionally
absent, verified in `api/enterpriseReports.ts` and its exhaustive-surface unit
test).

**Direct-link behavior:** every admin route is `RequireRole`-guarded client-side
and re-enforced server-side by the Edge Function's `requireRole`.

---

## 6. Current Backend Inventory (26 Edge Functions; role/auth posture)

Frontend-consumed (7): `create-booking`, `queue-control`, `doctor-operations`,
`cancel-booking`, `update-booking-status`, `command-center`,
`enterprise-reports`.

Admin-grade read/heavy functions — implemented, role-gated, and their current
**HTTP-integration** posture (re-checked against `enterprise_command_center.test.ts`,
not inherited):

| Function | Auth | Actions | HTTP `callFn` integration proof | Staging artifact |
| --- | --- | --- | --- | --- |
| `enterprise-reports` | `resolveAuth`+`requireRole([hospital_admin,global_admin])`, `getServiceClient`, server-side `X-Hospital-ID` | `generate` (8 types: json/csv/pdf_ready), `audit_search`, `audit_integrity`, `settlement_integrity`, `queue_integrity`, `doctor_ops_integrity`, `integration_matrix` | **YES** — §14 (`:1477-1535`) generates `daily_hospital`/`sla` over HTTP, asserts json/csv/pdf_ready, unknown-type 422, and `executive_report` audit rows | **FRESH** (redeployed in G-05) |
| `executive-analytics` | role-gated; portfolio=global_admin, daily=hospital_admin | `portfolio`, `daily_operations`, … | **YES** — `:1358-1403` (role + cross-tenant scope denials, 403) | STALE (one of the eight) |
| `alert-center` | role-gated, audited | list / acknowledge / assign / escalate / resolve | **YES** — `:1435`, `:1446` (ack audited, cross-tenant 403) — **but acknowledge/resolve are MUTATIONS** | STALE |
| `financial-command-center` | `resolveAuth`+`requireRole([hospital_admin,global_admin])`, `getServiceClient` | `overview`, `forecast`, `reconciliation` | **NO HTTP-path test found** — RPC-level only (`grep callFn("financial-command-center")` = 0) | STALE |

Backend/system-only (unchanged, not UI candidates): `settlement-engine`,
`carry-forward-tokens`, `compute-sla`, `monitoring-health-check`,
`refresh-rollups`, `run-background-worker`, `run-cron-minute`,
`run-cron-nightly`, `send-reminders`, `send-whatsapp-message`,
`process-whatsapp-webhook`, `create-payment-order`, `verify-payment`,
`process-refund`, `reschedule-booking`, `queue-next-patient`.

Key SQL objects: `audit_logs` / `search_audit_logs` / `verify_*_integrity`;
`generate_executive_report` (the report engine RPC, tested for all 8 types at
`:1067-1108`); financial read RPCs `get_financial_command_center` /
`get_revenue_forecast` / `get_reconciliation_summary` (service_role-only);
`get_portfolio_dashboard` / `get_daily_operations_dashboard` (global/hospital
scope); doctor schedule/leave tables.

---

## 7. Current User Journey Coverage

- **PATIENT / RECEPTION / DOCTOR core** — Registration → Booking → Check-in →
  Token → Queue → Consultation → Clinical notes → Completion → Cancellation →
  Status closure → Notifications (delivery-status read) → Payment (status read)
  → History: **IMPLEMENTED + REACHABLE** (closed prior phases).
- **HOSPITAL ADMIN** — Command Centre REACHABLE (G-03). Audit & Compliance
  REACHABLE (G-05). **Executive / operational reports ❌ · SLA/executive report
  download ❌ · finance/collections read ❌ · alert triage ❌ · fee config ❌** —
  all either unreachable or absent in UI.
- **DOCTOR** — own schedule/leave **read** ❌ (RLS-readable tables, no UI; low
  standalone value); schedule/leave **write** ❌ (unaudited — security gap).
- **GLOBAL ADMIN** — Command Centre and Audit viewer render only with a hospital
  tenant attached; **portfolio / cross-tenant analytics has no UI** despite
  `executive-analytics` being HTTP-proven.

---

## 8. Current Reachability Matrix

| Capability | Backend | UI | Role | Tenant-safe | Tested | Staging-proven | Classification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Command Centre reads | ✅ | ✅ | admin | ✅ | ✅ HTTP | ✅ | REACHABLE (G-03) |
| Audit / compliance reads | ✅ | ✅ | admin | ✅ | ✅ HTTP | ✅ | REACHABLE (G-05) |
| **Executive/operational reports (generate, non-money types)** | ✅ HTTP-proven | ❌ | admin | ✅ | ✅ HTTP (`:1477-1535`) | ✅ function fresh | **B — Frontend reachability (backend proven, no redeploy needed)** |
| Global-admin portfolio dashboard | ✅ HTTP-proven | ❌ | global_admin | ✅ (cross-tenant) | ✅ HTTP | ❌ artifact stale | B + E |
| Alert triage (list + acknowledge) | ✅ HTTP-proven | ❌ | admin | ✅ | ✅ HTTP | ❌ stale; **mutation surface** | B + E + (write) |
| Finance / collections read | ⚠️ RPC-level test only | ❌ | admin | ✅ | ❌ HTTP path untested | ❌ stale | B + E + F; financially sensitive |
| Doctor schedule/leave **read** | ✅ RLS tables | ❌ | doctor/admin | ✅ | table-level | n/a | B (low value) |
| Doctor schedule/leave **write** | ⚠️ unaudited | ❌ | doctor/admin | ✅ | ❌ | ❌ | C + D (security) |
| Reschedule | ❌ columns absent | ❌ | — | — | — | — | C — BACKEND DEFECT |
| Fee configuration admin | ✅ | ❌ | admin | ✅ | partial | ❌ | C + financial MUTATION |

---

## 9. Current Product Gaps (category A/B)

- **A — Product capability missing:** none material for the admin persona that
  is not already backend-proven; the missing pieces are reachability, not
  capability.
- **B — Frontend reachability gaps (backend already exists):** executive /
  operational reports (`generate`, non-money types); global-admin portfolio
  dashboard; alert triage list; finance/collections read; doctor schedule/leave
  read.

## 10. Security / Governance Gaps (category D)

- Doctor schedule/leave **write** has no audited Edge Function path.
- Alert acknowledge/resolve is a stateful mutation that a naive UI could expose
  without idempotency/audit — not selected this phase.
- No new trust boundary is required for the selected candidate; it reuses the
  G-05-proven server-side `requireRole` + server-side `X-Hospital-ID` model.

## 11. Financial Gaps (category — sensitive)

- `generate`'s `financial` and `settlement` report types render money figures;
  `financial-command-center` renders collection/forecast/reconciliation money.
- Business invariant: **SETURA collects ONLY the booking/platform fee; the
  hospital collects consultation fees directly.** No financial mutation is
  recommended. The selected candidate **excludes** the money report types.

## 12. Deployment Drift (category E — separated from product gaps)

Per the brief, the eight functions still carrying the stale pre-`79b74f7` CORS
artifact are: `cancel-booking`, `update-booking-status`, `queue-next-patient`,
`financial-command-center`, `executive-analytics`, `alert-center`,
`send-whatsapp-message`, `run-background-worker`. **`enterprise-reports` is NOT
among them** — it was refreshed during G-05. Do NOT mass-redeploy. The selected
candidate requires **zero** redeployment because it consumes only
`enterprise-reports` (already fresh). See §24.

---

## 13. Re-evaluation of Previous Candidates (CURRENT source, not inherited)

| # | Candidate | CURRENT status | Why | Current evidence | Still candidate? |
| --- | --- | --- | --- | --- | --- |
| 1 | Finance / collections read | DEFERRED | `financial-command-center` HTTP path still has **no `callFn` integration test** (grep = 0); it is a multi-view money surface; artifact stale | §6 table; RPC-level tests only | NO (weakest evidence + financial sensitivity) |
| 2 | Global-admin portfolio analytics | CANDIDATE (2nd) | `executive-analytics` is HTTP-proven (`:1358`) but cross-tenant, needs a tenant-less global-admin account for browser proof, and its staging artifact is **stale** → one redeploy | §6, test `:1358-1403` | YES, but heavier than reports |
| 3 | Executive operational reports | **SELECTED** | `enterprise-reports.generate` is HTTP-proven AND the function is already FRESH (G-05) → frontend-only, zero redeploy, zero backend risk | test `:1477-1535`; `enterpriseReports.ts` exports 6, `generate` absent | YES — strongest |
| 4 | Doctor schedule / leave | DEFERRED | read = low standalone value; write = unaudited security gap | §10, §8 | NO |
| 5 | Reschedule | ELIMINATED | `grep rescheduled_at|rescheduled_by supabase/migrations` = **0 matches** — backend columns still absent | this investigation | NO — genuine backend defect |
| 6 | Fee configuration | DEFERRED | financial MUTATION, belongs in its own gated phase | §11 | NO |

Previous candidate list was **re-derived from current source/tests**, and the
ranking changed: executive/operational reports now outranks portfolio and
finance specifically because G-05 already refreshed `enterprise-reports`.

---

## 14. Candidate Comparison (factual descriptors — no numeric scores, no artificial winner)

| Candidate | User value | Backend readiness | UI readiness | Security readiness | Financial sensitivity | Backend work | Frontend work | Evidence strength | Runtime-proof complexity | Dependencies |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Executive / operational reports | High | Ready (HTTP-proven) | Missing | Ready (G-05 role+tenant, audited) | None **if money types excluded** | None | one route + read wrapper | **Strong** (real-HTTP test) | Low (fn already fresh; local + staging browser) | **None** (no redeploy) |
| Global-admin portfolio dashboard | Medium | Ready (HTTP-proven) | Missing | Ready (global_admin, cross-tenant) | Read-only | None | one route | Strong | Medium (needs tenant-less account + 1 redeploy) | redeploy `executive-analytics` |
| Alert triage (list/ack) | Medium | Ready (HTTP-proven) | Missing | Ready for list; ack is a MUTATION | None | None | one route + mutation boundary | Strong | High (mutation idempotency/audit) | redeploy `alert-center` |
| Finance / collections read | Medium | Partial (RPC-only test) | Missing | Ready | **Sensitive (money)** | 1 fn HTTP test | one route | **Weak** (HTTP path untested) | Hard | redeploy + test gap closure |
| Doctor schedule/leave read | Low | Ready (RLS tables) | Missing | Ready (read) | None | None | one route | Medium | Low | none |
| Reschedule | Medium | **Defect (cols absent)** | Missing | — | fee-carry | additive migration + fn fix | one route | N/A | Blocked | NOT ready |

Why reports is the most justified (evidence, not subjective ranking): it is the
only remaining high-value admin gap whose backend is **both** real-HTTP
integration-proven **and** already freshly deployed; it reuses the exact G-05
template (frontend over an authorized Edge Function read path) and needs **no**
new backend, SQL, RLS, grant, SECURITY DEFINER, source change or redeployment.

---

## 15. Recommended Next Product Gap

```text
Candidate:  Executive / Operational Reports viewer — a read-only frontend over
            the EXISTING `enterprise-reports` Edge Function `generate` action,
            restricted to the NON-FINANCIAL report types (daily_hospital,
            weekly_operations, monthly_executive, doctor_performance, sla,
            audit).

Primary user: hospital_admin (and global_admin, with a hospital tenant attached).

Why it exists: SETURA already produces and HTTP-integration-tests eight
            executive/operational reports, but no UI can reach them. G-05 wired
            the audit/compliance reads and intentionally left `generate` out.
            The operational/executive report types carry no money figures.

Current backend: PROVEN and FRESH. `generate` (json/csv/pdf_ready) + audit as
            `executive_report` verified via real HTTP (test :1477-1535); the
            report engine RPC proven for all 8 types (:1067-1108);
            `enterprise-reports` was redeployed to staging during G-05.

Current frontend: MISSING. No route, no nav entry, no wrapper for `generate`.

Backend changes required: NO.
Database / RLS changes required: NO.
Deployment drift: NONE for this candidate (function already fresh).
Financial impact: NONE within scope (money report types excluded by design).
```

---

## 16. Exact Proposed Scope (for the NEXT authorized phase — NOT this one)

MAY touch (frontend only):
- One new admin route in `App.tsx` (e.g. `/admin/reports`) guarded by
  `ADMIN_ROLES` + one nav entry in `AppShell.tsx`.
- One page under `apps/web/src/routes/` (read-only report viewer).
- A read wrapper addition in `apps/web/src/api/enterpriseReports.ts` exposing
  ONLY a `generate` call constrained to the six non-financial report types
  (allow-list enforced in code), passing `hospitalId` as header-only (never in
  body), with no `idempotencyKey` on reads.
- Types in `apps/web/src/types/api.ts` + focused unit tests mirroring G-05.

MUST NOT touch:
- Any migration / SQL / table / index / RLS / grant / SECURITY DEFINER / RPC /
  Edge Function **source** (source already correct and proven).
- `financial` and `settlement` report types (money figures) — excluded.
- Any of the eight stale functions; no redeployment (none is required).
- Fee config, reschedule, schedule/leave writes, alerts mutation, finance
  dashboard, notifications/WhatsApp delivery, worker/scheduler.
- Production. No commit/push without explicit authorization.

---

## 17. Security Requirements

- Server-side `requireRole([hospital_admin, global_admin])` remains the
  authoritative gate; the client `RequireRole` is UX only.
- Tenant travels ONLY via `X-Hospital-ID` set from the authenticated session and
  re-verified server-side; the `service_role`-only report RPC stays behind the
  function — no privileged key reaches the browser.
- Report generation is audited as `executive_report` (existing behavior) —
  accountability preserved; no new audit mechanism.
- Cross-tenant header must remain 403 and missing header 422 (same gates as
  G-03/G-05). No new RLS/SECURITY DEFINER/grant boundary is introduced.

## 18. Financial Requirements

- **Excluded by design:** the `financial` and `settlement` report types.
- Read-only rendering of operational/executive metadata only; no money mutation,
  no reconciliation dashboard, no fee administration.
- Reaffirm invariant: SETURA collects only the booking/platform fee; the hospital
  collects consultation fees directly.

## 19. Runtime / Staging Proof Required

- Fresh local stack: build + typecheck green; `enterprise_command_center.test.ts`
  HTTP suite stays green.
- Staging browser walkthrough as `hospital_admin`: reports route generates and
  renders at least one non-financial report (json view; csv/pdf_ready where
  feasible); receptionist/doctor have no route and issue zero `generate`
  requests; cross-tenant header → 403; missing header → 422; console/network
  clean; zero mutations.
- Local proof is **NOT** production readiness.

## 20. Acceptance Criteria

1. `hospital_admin` lands on `/admin/reports` and generates a real
   non-financial report for their tenant via `enterprise-reports.generate`.
2. `financial`/`settlement` report types are not reachable from the UI (allow-list).
3. Receptionist/doctor: no nav entry, route redirects, zero requests issued.
4. Cross-tenant → 403; missing header → 422.
5. No new SQL/RLS/grant/SECURITY DEFINER/Edge Function source change; no redeploy.
6. Existing enterprise-reports HTTP integration suite + unit tests + typecheck +
   build all pass.

## 21. Definition of Done

```text
Implementation + expected behavior + failure behavior
+ unit tests (wrapper/route, allow-list enforcement)
+ integration reuse (enterprise-reports HTTP suite kept green)
+ staging browser walkthrough + runtime proof
+ tenant isolation + role isolation + console/network cleanliness
+ evidence report
```
BLOCKED ≠ PASS. Staging proof ≠ production readiness; no production claim.

## 22. STOP CONDITIONS

Implementation must NOT begin if:
- A non-financial report type is found to render money figures (reclassify as
  financial, separate phase).
- Any `generate` read is found to need a new RLS/SECURITY DEFINER boundary.
- The `enterprise-reports` staging artifact is discovered stale (contradicting
  the G-05 report) — then a single targeted redeploy must be explicitly
  authorized, and this "no-redeploy" premise re-verified before proceeding.
- Staging/production data mutation would be needed to demonstrate the flow.

## 23. Final Decision

```text
CURRENT BASELINE:
a02200f1aeb9007de8bf1b96c967d9c489dab204 (HEAD == origin/main; branch main;
working tree clean apart from the untracked G-05 report; staging setura-staging /
gzcqasntcbqqmgsoikms; frontend https://setura-delta.vercel.app)

G-03:
PROVEN STAGING — CLOSED

G-05:
PROVEN STAGING — CLOSED

NEXT PRODUCT GAP:
Executive / Operational Reports viewer — read-only frontend over the existing,
already-fresh `enterprise-reports` Edge Function `generate` action, restricted to
the non-financial report types (daily_hospital, weekly_operations,
monthly_executive, doctor_performance, sla, audit).

CLASSIFICATION:
B — Frontend reachability gap (backend proven; NO deployment drift because
enterprise-reports was refreshed in G-05)

PRIMARY USER:
hospital_admin (and global_admin with an attached hospital tenant)

WHY IT EXISTS:
Auditability/reporting is a SETURA non-negotiable and the backend already
produces and HTTP-integration-tests eight reports, but only the six
audit/compliance reads were surfaced in G-05. `generate` was deliberately left
out; its operational/executive types carry no money figures.

CURRENT BACKEND:
PROVEN + FRESH. `generate` (json/csv/pdf_ready) audited as `executive_report`,
real-HTTP tested (:1477-1535); engine RPC proven for all 8 types (:1067-1108);
function redeployed during G-05 (not one of the 8 stale).

CURRENT FRONTEND:
MISSING for reports. api/enterpriseReports.ts exposes 6 audit/compliance reads
only; `generate` intentionally absent; no route/nav.

BACKEND CHANGES REQUIRED:
NO

DATABASE/RLS CHANGES REQUIRED:
NO

DEPLOYMENT DRIFT:
NONE for this candidate (enterprise-reports already fresh). The other eight
stale functions are unrelated to this recommendation.

FINANCIAL IMPACT:
NONE within scope (financial/settlement report types explicitly excluded).

WHATSAPP:
NOT TOUCHED

SECURITY:
Reuses existing server-side requireRole + X-Hospital-ID verification +
service_role-only report RPC behind the function; no new trust boundary; adds no
RLS/SECURITY DEFINER/grant; cross-tenant 403 / missing-header 422 must stay
proven; generation already audited as executive_report.

STAGING PROOF REQUIRED:
- hospital_admin generates + renders a non-financial report; receptionist/doctor
  denied (0 requests); cross-tenant 403 / missing-header 422; console/network
  clean; 0 mutations; financial/settlement unreachable; existing
  enterprise-reports HTTP suite + unit tests + typecheck + build green.

IMPLEMENTATION SCOPE:
One `/admin/reports` route + AppShell nav entry + a read-only report page + a
`generate` wrapper (allow-listed to 6 non-financial types) in
enterpriseReports.ts + types + unit tests. Mirror the G-05 template exactly.
No SQL/RLS/RPC/SECURITY DEFINER/Edge Function source change. No redeploy.

OUT OF PROOF/SCOPE (out of scope):
financial/settlement report generation; finance/collections dashboard;
global-admin portfolio dashboard; alert triage mutations; doctor schedule/leave
writes; reschedule (backend defect); fee administration; notifications/WhatsApp;
worker/scheduler; production.

PRODUCTION:
NOT TOUCHED

INVESTIGATION STATUS:
COMPLETE — STOP
```

**Discovery only. No implementation, deployment, staging mutation, commit or push
was performed. The only file written in this phase is this required report.**
