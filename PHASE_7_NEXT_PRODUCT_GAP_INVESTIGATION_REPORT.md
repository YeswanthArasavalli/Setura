# SETURA — PHASE 7: NEXT PRODUCT GAP INVESTIGATION
## Fresh Source-First Product Capability Audit After G-02 Closure

**Phase:** 7 — Next Product Gap Investigation (INVESTIGATION ONLY)
**Date:** 2026-09-28
**Status:** COMPLETE — no source, SQL, migration, RLS, Edge Function, test,
deployment, staging-data, commit or push performed. Two read-only staging
catalog/metadata queries and one read-only local inspection were run.
**Supersedes:** the previous content of this file (post-C1 investigation,
baseline `a9aa774`), whose selected candidate — booking-status closure
(check-in + no-show) — has since been implemented at `0ec8586`
("feat: add booking status closure controls") and closed as PROVEN STAGING.
That report's baseline and selection are **STALE / RESOLVED**; this is a fresh
investigation against `0ec8586`.

---

## 1. Scope

Read-only determination of the next highest-value, bounded, backend-supported
product gap after G-02. Performed this session:

- Git branch/HEAD/origin/status/log (read-only)
- Current frontend source (`apps/web/src`: `App.tsx`, routes, `api/`, `lib/`,
  components) rebuilt from source, not from any older inventory
- Current backend source: 26 Edge Functions (`supabase/functions`), `_shared`
- Migration census (RLS policies, function grants, RPC definitions)
- Integration/unit test census (`tests/`), including real-HTTP invocation
  semantics of `callFn`
- Live **staging** verification (SELECT-only) via `supabase db query --linked`
  and read-only `supabase functions list --project-ref`

Not performed (mutation-forbidden): any booking / status / payment / refund /
queue / worker / notification / schedule / audit mutation; no staging data
touched; no Edge Function was invoked.

---

## 2. Investigation Rules

Source-first, evidence-driven, conservative. Truth hierarchy applied: actual
source/SQL → live catalog/runtime → executed integration tests → reports.
Where the prior report's conclusions were reused (e.g. the reschedule defect),
they were **re-verified against current source and live staging**, not trusted.
Statements are classified IMPLEMENTED / STATICALLY VERIFIED / UNIT VERIFIED /
INTEGRATION VERIFIED / RUNTIME / STAGING / PRODUCTION / UNPROVEN / BLOCKED.
Local results are not claimed as production. No numerical scoring is used.

---

## 3. Current Git Baseline (PROVEN)

| Check | Verified value |
| --- | --- |
| Branch | `main` |
| HEAD | `0ec8586b3b5b72dd4fcb06c9e5239a89103dc156` |
| origin/main | `0ec8586b3b5b72dd4fcb06c9e5239a89103dc156` (equal to HEAD) |
| HEAD subject | `feat: add booking status closure controls` |
| Tracked working-tree changes | 0 modified tracked files |
| Untracked | 2 report `.md` files only (`PHASE_7_G02_COMMIT_STAGING_DEPLOYMENT_PREFLIGHT_REPORT.md`, `PHASE_7_G02_CONTROLLED_STAGING_VALIDATION_REPORT.md`) |

Recent history: `0ec8586` (G-02) → `a9aa774` (C1 cancellation) →
`037bcf1` (notifications delivery UI).

Note (AGENTS.md §13 correction): the tree **is** a Git repository as of this
session (git status/branch/log all functional). The older "not a Git repo"
baseline note no longer holds and was not relied upon. **D-COMMIT-1 was not
touched**; no commit, push, amend, rebase or history rewrite was performed.
**GIT: UNCHANGED.**

---

## 4. Current Staging Baseline (PROVEN / observed)

| Item | Value | Verification |
| --- | --- | --- |
| Staging Supabase | `setura-staging` | linked project |
| Project ref | `gzcqasntcbqqmgsoikms` | used for live queries |
| Staging frontend | `https://setura-delta.vercel.app` | prior report pointer (not re-resolved this session) |
| Edge Functions deployed | 25 functions ACTIVE | `supabase functions list` — observed |
| `command-center` | ACTIVE v7 (2026-09-20) | observed via functions list |
| Live `bookings` columns | `cancellation_reason`, `cancelled_at` present; `rescheduled_at`/`rescheduled_by` ABSENT | SELECT-only `information_schema.columns` |

Production: **NOT TOUCHED** (no production project referenced, configured or
queried).

---

## 5. Frontend Route Census (rebuilt from `App.tsx`)

| Route | Roles (`RequireRole`) | Screen |
| --- | --- | --- |
| `/login` | public | Login |
| `/` (index, in shell) | reception∪doctor roles | Landing (role redirect) |
| `/reception` | receptionist, hospital_admin | ReceptionDashboard |
| `/reception/book` | receptionist, hospital_admin | BookAppointment |
| `/reception/walk-in` | receptionist, hospital_admin | WalkIn |
| `/reception/patients` | receptionist, hospital_admin | Patients |
| `/reception/notifications` | receptionist, hospital_admin | Notifications |
| `/queue` | receptionist, hospital_admin | QueueBoard |
| `/doctor` | doctor, hospital_admin | DoctorConsole |
| `/bookings/:bookingId` | shell roles | BookingDetail |

Constants (`App.tsx:15-16`): `RECEPTION_ROLES = [receptionist, hospital_admin]`,
`DOCTOR_ROLES = [doctor, hospital_admin]`. Role routing (`App.tsx:19-24`):
doctor → `/doctor`; receptionist / hospital_admin / **global_admin** →
`/reception`. **There is no dedicated admin route** — both admin roles land on
the reception console. `global_admin` can enter the shell only through
`/bookings/:bookingId` (no role guard) and the index redirect; it has no nav
entry of its own.

---

## 6. Frontend Capability Census

- Frontend calls **exactly five** Edge Functions: `create-booking`,
  `queue-control`, `doctor-operations`, `cancel-booking`, and (new, G-02)
  `update-booking-status` via `api/statuses.ts`. (`grep` of `apps/web/src` for
  the other 21 function slugs — `command-center`, `executive-analytics`,
  `enterprise-reports`, `financial-command-center`, `alert-center` — returns
  **0 matches**.)
- **Zero direct client table writes** (`.insert/.update/.delete/.upsert` in
  `apps/web/src`: 0 matches). All mutations are Edge-Function-mediated.
- Direct **reads** go through PostgREST SELECT under RLS only (`api/reads.ts`,
  whose header comment states RLS — not the client — is the enforcement
  boundary).
- No admin, settings, finance, reporting, audit, schedule/leave or
  staff-management surface exists.

---

## 7. Edge Function Census (26 functions; 25 deployed ACTIVE on staging)

Frontend-consumed (5): `create-booking`, `queue-control`, `doctor-operations`,
`cancel-booking`, `update-booking-status`.

Backend/system-only, **never called by the frontend** (21):
`command-center`, `executive-analytics`, `enterprise-reports`,
`financial-command-center`, `alert-center`, `settlement-engine`,
`carry-forward-tokens`, `compute-sla`, `monitoring-health-check`,
`refresh-rollups`, `run-background-worker`, `run-cron-minute`,
`run-cron-nightly`, `send-reminders`, `send-whatsapp-message`,
`process-whatsapp-webhook`, `create-payment-order`, `verify-payment`,
`process-refund`, `reschedule-booking`, `queue-next-patient`.

The five admin-grade read functions (`command-center`, `executive-analytics`,
`enterprise-reports`, `financial-command-center`, `alert-center`) are the
structural dead-end this investigation targets: implemented, authorized,
staging-deployed, and unreachable from the product UI.

---

## 8. Database Capability Census (candidate-relevant)

| Domain | Primary objects | Source |
| --- | --- | --- |
| Bookings | `bookings` (+ `cancellation_reason`, `cancelled_at`, `carry_forwarded_from`, `payment_status_detail`) | `01_foundation`, `28_booking_enhancements` |
| Booking status enum | `booked, checked_in, waiting, called, in_consultation, completed, cancelled, no_show, rescheduled, skipped` | `01_foundation.sql:34-44` |
| Audit | `audit_logs`, `audit_action_types` | `10_audit_&_security_engine`, `36_audit_standardization` |
| Doctor schedule | `doctor_schedules`, `doctor_leaves`, `doctor_availability_overrides`, `doctor_hospital_holidays` | `03_doctorscheduling&slotengine` |
| Financial | ledger / collections / settlement / reconciliation RPC set | `21`, financial engines, `47` |
| Command centre | composite read RPCs incl. `get_hospital_command_center`, `get_hospital_timeline`, `get_predictive_insights`, `get_sla_dashboard`, `get_queue_health`, `get_mv_refresh_health`, `get_dlq_summary` | `47_enterprise_command_center` |

---

## 9. RLS / Security / Grants Census (freshly verified)

| Surface | Posture | File:line |
| --- | --- | --- |
| `command-center` fn | `resolveAuth(req, hospitalId)` + `requireRole(["hospital_admin","global_admin"])`; `getServiceClient()`; hospital resolved/verified server-side | `functions/command-center/index.ts:189-197` |
| `executive-analytics` | portfolio action = global_admin only; hospital-scoped = hospital_admin (403 proven) | test `:1374-1403` |
| `search_audit_logs` | SECURITY DEFINER, **caller-supplied hospital_id**, `REVOKE` from anon/authenticated, `GRANT … TO service_role` | `47:2185`, `48:628-632` |
| `get_audit_coverage_report` | `REVOKE` anon/authenticated, `GRANT … service_role` (36's earlier `authenticated` grant superseded) | `36:593,647-649`, `48:560-563` |
| `get_financial_command_center` | `REVOKE` anon/authenticated, `GRANT … service_role` | `48:580-582` |
| `get_reconciliation_summary` | `REVOKE` anon/authenticated, `GRANT … service_role` | `48:592-594` |
| `doctor_schedules` | `FOR SELECT USING … OR user_has_hospital_access(hospital_id)`; `doctor_sched_manage FOR ALL` | `03:639-645, 650+` |
| `doctor_leaves` | `FOR SELECT USING … OR user_has_hospital_access(hospital_id)`; `doctor_leaves_manage FOR ALL`; **no audit trigger** | `03:681-687, 692+` |

Consequence: the **admin read Edge Functions** (`command-center`,
`executive-analytics`) are safe to consume directly from an authenticated staff
client because they enforce role + tenant at the edge. The **audit and finance
read RPCs** are `service_role`-only and therefore are **not** client-callable —
a UI for them needs a new (or extended) Edge Function action, not a pure
frontend change. The doctor schedule/leave tables are client-**readable** under
RLS but not client-writable within the established audited posture.

---

## 10. Completed / Closed Capabilities (not reopened)

G-02 booking-status closure (check-in + no-show) — PROVEN STAGING at `0ec8586`.
C1 cancellation — PROVEN STAGING. Notifications delivery UI, Booking
Confirmation, Payment Status UX, Clinical Note UI, Doctor directory fix,
tenant isolation, core booking/queue/doctor/consultation journeys — all closed.
None re-investigated or re-proposed.

---

## 11. Current Workflow Map (post-G-02)

Receptionist: register/search ✅ · book/walk-in ✅ · see booking ✅ · cancel ✅ ·
check-in ✅ (G-02) · no-show ✅ (G-02) · queue ✅ · notifications ✅ · payment
read ✅ · patient history ✅ · **reschedule ❌** · **audit ❌**.

Doctor: queue ✅ · call ✅ · consult ✅ · notes ✅ · diagnosis ✅ · complete ✅ ·
history ✅ · **own schedule/leave visibility ❌**.

Hospital admin: everything a receptionist/doctor can do (shares those
consoles) · **operational command centre ❌ (backend proven + deployed, no UI)**
· **analytics ❌** · **collections/outstanding/settlements ❌** · **audit ❌** ·
**staff/schedule/leave mgmt ❌** · **fees ❌**.

Global admin: lands on `/reception`; **no admin surface at all** for
portfolio/tenant inspection/audit/system health.

---

## 12. Frontend ↔ Backend Gap Matrix

| Capability | Backend exists | Tested | RLS/auth ready | Frontend | Runtime/staging | Gap class |
| --- | --- | --- | --- | --- | --- | --- |
| Booking / cancel / status closure | ✅ | ✅ | ✅ | ✅ | STAGING | CLOSED |
| Queue / doctor / consultation | ✅ | ✅ | ✅ | ✅ | STAGING | CLOSED |
| **Admin command centre (read)** | ✅ | ✅ (HTTP) | ✅ | **❌** | **DEPLOYED STAGING** | **FRONTEND-ONLY** |
| Admin analytics (read) | ✅ | ✅ (HTTP) | ✅ | ❌ | DEPLOYED STAGING | FRONTEND-ONLY (broad) |
| Audit viewer | ✅ RPC | RPC-level | service_role only | ❌ | — | BACKEND REQUIRED (new fn action) |
| Finance / collections (read) | ✅ | ✅ | service_role only | ❌ | fn deployed | BACKEND (fn exists) + money UX |
| Doctor schedule/leave **read** | ✅ | policy | RLS-readable | ❌ | tables staging | FRONTEND-ONLY (low standalone value) |
| Doctor schedule/leave **write** | ✅ tables | partial | RLS but unaudited | ❌ | — | BACKEND REQUIRED (audit) |
| Reschedule | ⚠️ broken | engine-only | — | ❌ | **missing columns (staging)** | **BACKEND DEFECT** |
| Fee configuration admin | ✅ | ✅ | financial | ❌ | — | FINANCIAL MUTATION |

---

## 13. Candidate Set (G-03 … G-08)

### G-03 — Hospital Admin Command Centre (read-only operational overview) — **SELECTED**
- **User:** hospital_admin, global_admin.
- **Current workflow:** admins have no operational dashboard; they land on the
  reception console.
- **Missing workflow:** live hospital snapshot, composite scores, SLA dashboard,
  system health, event timeline.
- **Backend status:** IMPLEMENTED. `command-center` read actions `overview`,
  `timeline`, `predictive`, `sla_dashboard`, `system_health`
  (`index.ts:52-63`). INTEGRATION VERIFIED over **real HTTP** for
  `overview`+`timeline` (`enterprise_command_center.test.ts:1331-1356`,
  `callFn` = `fetch(.../functions/v1/${fn})` at `:233-236`), with role +
  tenant denial tests (`:1358-1413`: receptionist 403 ROLE_INSUFFICIENT,
  missing-header 422, cross-tenant 403 FORBIDDEN). STAGING: function ACTIVE v7.
- **Frontend status:** NOT IMPLEMENTED (0 references).
- **Security status:** role-gated hospital_admin/global_admin, server-side
  tenant scoping, service-role client — authorization already PROVEN.
- **Financial dependency:** NONE for the read actions.
- **External dependency:** NONE for the read actions (the `broadcast_*` actions
  that enqueue WhatsApp jobs are **explicitly out of scope**).
- **Complexity:** LOW–MEDIUM. **Risk:** LOW (read-only).
- **Why it matters:** unlocks the entire admin persona using the strongest-
  proven backend in the repo.
- **Implementation boundary:** new admin route + a read API wrapper for the 5
  command-center read actions; role-guard to hospital_admin/global_admin; no
  SQL/RLS/RPC/SECURITY DEFINER/Edge-Function change; broadcasts excluded.
- **Staging validation:** FEASIBLE — read-only, function already deployed.

### G-04 — Doctor Schedule & Leave (visibility + management)
- Tables + `FOR SELECT` RLS (client-readable) exist (`03:639-687`). A **read**
  view is frontend-only but low standalone value; **management** writes are
  `FOR ALL` under RLS but the tables have **no audit trigger**, so audited
  mutation needs a new Edge Function — breaks the "all mutations through
  audited Edge Functions" posture. Backend-dependent for the valuable half.

### G-05 — Audit Activity Viewer (admin)
- `search_audit_logs` (47:2185) + `get_audit_coverage_report` (36:593) exist,
  but are **`service_role`-only** (48:560-563, 628-632). Not client-callable.
  Requires a **new Edge Function action** (or extension of `command-center`)
  with resolveAuth+requireRole. Backend-required; still bounded + read-only.
  Strongest runner-up.

### G-06 — Finance / Collections Read Dashboard
- Read RPCs `get_financial_command_center` / `get_reconciliation_summary` are
  `service_role`-only (48:580-594); `financial-command-center` fn is deployed
  but never UI-consumed. Money-figure surface with reconciliation/settlement
  semantics — broader than one bounded phase and financially sensitive to
  display. Deferred.

### G-07 — Staff-Console Reschedule — **ELIMINATED (BACKEND DEFECT)**
- See §15. Missing columns proven in source, local migrations and **live
  staging**. Not ready for frontend.

### G-08 — Fee Configuration Admin
- Financially sensitive **mutations**; fee report classified CASE A (expected
  configuration). Deferred (financial-policy surface).

---

## 14. Candidate Elimination

| Candidate | Result | Failed criterion |
| --- | --- | --- |
| G-07 reschedule | ELIMINATED | backend not ready — columns absent (source + staging) |
| G-04 schedule/leave (write) | DEFERRED | unaudited writes → needs new Edge Function + audit |
| G-05 audit viewer | DEFERRED (runner-up) | read RPCs service_role-only → backend change needed |
| G-06 finance read | DEFERRED | money-figure breadth + service_role RPCs |
| G-08 fee admin | DEFERRED | financial mutation |
| Closed areas (G-02/C1/etc.) | EXCLUDED | already implemented & staged |
| **G-03 admin command centre** | **SELECTED** | passes all selection criteria |

---

## 15. Reschedule Backend Verification (§9 special investigation — FRESH)

Method and evidence (no mutation executed):

1. `reschedule-booking/index.ts:378-382` writes
   `{ status: "rescheduled", rescheduled_at, rescheduled_by }`.
2. `"rescheduled"` **IS** a valid enum value (`01_foundation.sql:43`) — the
   state itself is legal.
3. `rescheduled_at` / `rescheduled_by` are referenced in **zero** migrations
   (`grep` of `supabase/migrations`: 0 matches for either identifier).
4. **Live staging (SELECT-only, `--linked`)**: `bookings` columns include
   `cancellation_reason`, `cancelled_at` but **not** `rescheduled_at` /
   `rescheduled_by`.

Conclusion: the HTTP reschedule write would fail at the database with
"column does not exist". Classification: **BACKEND DEFECT — NOT READY FOR
FRONTEND IMPLEMENTATION.** To become production-ready it would need an
additive migration adding both columns (plus decision on the fee-snapshot
carry and a real-HTTP integration test). Not selected because it fails the
"backend readiness" criterion; rescheduling's product value alone is not a
reason to build a UI over a broken path.

---

## 16. Finance Investigation (§10)

Collections / payment orders / refunds / outstanding / settlements /
reconciliation read surfaces **exist** as RPCs and a deployed
`financial-command-center` Edge Function, but their read RPCs are
`service_role`-only (48:580-594), so there is **no** current authenticated
client read surface. The backend is financial-read capable but not
UI-consumed. Classification: **BACKEND EXISTS + FRONTEND ABSENT**, but the
surface is a multi-view money product (broad, financially sensitive to render
correctly) → **larger architecture phase**, not a single bounded gap. Not
mutated; not implemented this phase.

---

## 17. Audit Investigation (§11)

Admin-inspectable audit data is modelled (`audit_logs`, actor/entity/action/
severity/metadata/notes/created_at) with read RPCs `search_audit_logs` and
`get_audit_coverage_report`. Both are `service_role`-only (48), no Edge Function
exposes them to staff, and there is no frontend viewer. Filtering/search/
pagination params already exist on `search_audit_logs` (47:2185-2194, limit
clamped 1..1000). Classification: **BOUNDED but BACKEND-REQUIRED** — a small
additive Edge Function action (resolveAuth + requireRole(admin) + server-side
hospital id) then a read UI. Runner-up, not selected, because it is not
purely frontend-only.

---

## 18. Doctor Schedule / Leave Investigation (§12)

All four tables exist with `FOR SELECT` RLS readable by hospital members
(`03`) and `FOR ALL` manage policies. Read is therefore **frontend-ready via
PostgREST** (same posture as `reads.ts`); no schedule/leave management Edge
Function exists, and the tables carry **no audit trigger** (only
hospital-immutable), so audited writes would need a new Edge Function.
Classification: **read = FRONTEND-ONLY (low standalone value)**,
**write = BACKEND-REQUIRED + security-sensitive**. Deferred behind G-03 because
the useful half (management) is not safely one frontend-only phase.

---

## 19. Analytics / Admin Investigation (§13)

Daily patient/booking counts, queue metrics, doctor throughput, no-show/cancel
rates, wait times, revenue and notification metrics are **already computed**
via rollups (`21`), monitoring (`24`), command-centre (`47`) and exposed through
role-gated Edge Functions `command-center` and `executive-analytics` — the
latter INTEGRATION-PROVEN over real HTTP (portfolio global_admin-gated,
daily_operations hospital_admin — test `:1374-1403`), both deployed ACTIVE on
staging. They are **RLS/role protected** and **pure backend with no UI**.
Rather than "missing entirely", they are the most complete no-UI surfaces in
the product. G-03 selects the command-centre slice of this family as the first
bounded step; broader analytics/portfolio dashboards remain a follow-on.

---

## 20. Newly Discovered Defects / Observations

- **D-A (confirms prior G-01):** reschedule HTTP path references non-existent
  columns — source + staging verified (§15). OPEN, backend.
- **O-B:** `global_admin` has no dedicated frontend landing beyond `/reception`
  and no nav entry; the backend admin capability set is entirely unreachable.
  Not a code defect — a product-surface gap, which G-03 begins to close.
- **O-C:** `search_audit_logs` is SECURITY DEFINER with a **caller-supplied**
  `hospital_id` and no internal actor check; it is safe today only because it
  is `service_role`-only. Any future exposure **must** derive hospital_id
  server-side — recorded so a future audit-UI phase does not expose it directly.

No documentation edits made (per rules). No new backend defect beyond D-A was
found in the examined surfaces.

---

## 21. Documentation Drift

`AGENTS.md §13` states the working tree is **not** a Git repository; this
session found a functional repository with `HEAD == origin/main == 0ec8586`.
Recorded only; not modified. This does not affect any gap conclusion.

---

## 22. Risk / Dependency Matrix

| Candidate | Financial | External creds | New SQL/RLS/RPC/FN | Risk | Deterministic test | Staging-safe |
| --- | --- | --- | --- | --- | --- | --- |
| G-03 command centre (read) | NONE | NONE | NONE | LOW | YES | YES |
| G-05 audit viewer | NONE | NONE | 1 fn action | LOW | YES | YES |
| G-04 schedule/leave read/write | NONE | NONE | read 0 / write fn+audit | MED | partial | YES |
| G-06 finance read | READ-ONLY money | NONE | fn exists | MED-HIGH | harder | YES |
| G-07 reschedule | fee carry | NONE | migration + fn fix | HIGH | blocked | NO (broken) |
| G-08 fee admin | MUTATION | NONE | fn/config | HIGH | harder | policy-gated |

---

## 23. Selected Next Product Gap

> **Selected next bounded implementation candidate based on the evidence: G-03 — Hospital Admin Command Centre (read-only operational overview).**

---

## 24. Why G-03 Was Selected

1. **Real hospital workflow value** — both admin roles currently have **zero**
   dedicated surface (they land on `/reception`); the command centre is the
   primary admin operational need and is entirely unreachable today.
2. **Strongest backend readiness in the repo** — the `command-center` read path
   is INTEGRATION-PROVEN over **real HTTP** with a real `hospital_admin` JWT,
   and already **deployed ACTIVE on staging** — unlike audit/finance (locked to
   `service_role`, needing a new backend action) and unlike schedule/leave
   management (unaudited writes) and reschedule (broken).
3. **Authorization already proven** — role gate + server-side tenant scoping
   with asserted 403 role and 403 cross-tenant denials; no new security
   boundary is introduced.
4. **Bounded, frontend-only** — consumes an existing authorized Edge Function;
   no SQL / RLS / RPC / SECURITY DEFINER / Edge-Function change.
5. **Zero financial / external risk** — read actions only; the WhatsApp
   `broadcast_*` actions are explicitly excluded.
6. **Deterministic + staging-safe** — read-only, already testable with the
   existing HTTP harness; same proven template as C1 and G-02 (a frontend
   surface over an already-proven Edge Function).

---

## 25. Why Other Candidates Were Not Selected

G-07 reschedule fails backend readiness outright (broken columns, proven at
staging). G-05 audit and G-06 finance need backend work first (their read RPCs
are `service_role`-only), and finance additionally carries money-figure display
sensitivity/breadth. G-04's read half is low-value standalone while its
management half needs a new audited Edge Function. G-08 is a financial
mutation. G-03 is the only candidate that is simultaneously high-value,
already integration-proven, already staging-deployed, purely frontend-bounded,
and free of financial/external risk.

---

## 26. Exact Proposed Implementation Boundary (for a future authorized phase)

- Add one admin route (e.g. `/admin` or `/command-centre`) guarded to
  `["hospital_admin","global_admin"]`, plus a nav entry and role-landing update.
- Add a read API wrapper (mirroring `api/statuses.ts`) that POSTs to
  `functions/v1/command-center` with the read actions `overview` (and, if the
  phase scope includes them, `sla_dashboard`, `system_health`, `timeline`,
  `predictive`), passing the existing `X-Hospital-ID`/auth headers already used
  by other wrappers.
- Render read-only views. **Do not** wire `broadcast_*` actions.
- **No** migration, RLS, RPC, SECURITY DEFINER, or Edge-Function source change.

---

## 27. Proposed Local Validation (future phase)

- Unit tests for the response-parsing wrapper and role-guarding (mirroring
  `statuses.test.ts` / `BookingDetail.test.tsx` patterns).
- Reuse the existing `enterprise_command_center.test.ts` real-HTTP backend proof;
  optionally add a frontend integration assertion that a hospital_admin renders
  the overview while a receptionist cannot reach the route.

---

## 28. Proposed Staging Validation (future phase, separate authorization)

- Deploy frontend to `setura-delta.vercel.app` (no backend redeploy needed —
  `command-center` already ACTIVE v7).
- Sign in as a staging hospital_admin; confirm the read-only overview renders
  live figures; confirm a receptionist session has no route access; confirm no
  mutation, notification or WhatsApp job is produced.

---

## 29. Explicit Non-Goals

- No `broadcast_*` (WhatsApp) wiring. No finance/audit/analytics-portfolio UI.
  No schedule/leave management. No reschedule backend fix. No production work.
  No commit/push.

---

## 30. Production Boundary

Production: **NOT TOUCHED**. No production project, secret, function, domain,
user, data or transaction. Staging read-only inspection only; staging data not
modified.

---

## 31. Final Classification

G-03 backend: **IMPLEMENTED** and **INTEGRATION VERIFIED (local stack) +
DEPLOYED/ACTIVE (staging)** for the read actions. Frontend: **NOT IMPLEMENTED**.
Implementation type: **FRONTEND-ONLY**. Financial dependency: **NONE** (read
actions). External dependency: **NONE** (read actions; broadcasts excluded).
Staging validation: **FEASIBLE** with separate authorization. This investigation
performed **no implementation**.

---

## 32. Mandatory Final Block

```text
CURRENT BASELINE:
0ec8586b3b5b72dd4fcb06c9e5239a89103dc156

STAGING:
setura-staging / gzcqasntcbqqmgsoikms

PRODUCTION:
NOT TOUCHED

G-02:
PROVEN STAGING

CANDIDATES INVESTIGATED:
6

SELECTED NEXT GAP:
G-03 — Hospital Admin Command Centre (read-only operational overview)

BACKEND STATUS:
IMPLEMENTED

FRONTEND STATUS:
NOT IMPLEMENTED

SECURITY STATUS:
command-center is role-gated to hospital_admin/global_admin with server-side
resolveAuth tenant scoping; 403 role and 403 cross-tenant denials are proven by
real-HTTP integration tests; function is ACTIVE on staging. No new security
boundary required.

FINANCIAL DEPENDENCY:
NONE

EXTERNAL DEPENDENCY:
NONE (WhatsApp broadcast actions explicitly excluded)

IMPLEMENTATION TYPE:
FRONTEND-ONLY

STAGING VALIDATION:
FEASIBLE (requires separate explicit authorization)

PRODUCTION:
NOT TOUCHED

IMPLEMENTATION:
NOT PERFORMED

GIT:
UNCHANGED

FINAL STATUS:
INVESTIGATION COMPLETE — READY FOR SEPARATE IMPLEMENTATION AUTHORIZATION
```
