# SETURA HOSPITAL OS
# PHASE 7 — POST-G09 NEXT-WORKSTREAM INVESTIGATION
## READ-ONLY PRODUCT / ARCHITECTURE / EVIDENCE GAP INVESTIGATION

Status of this document: INVESTIGATION COMPLETE. No code, SQL, migration, RLS,
grant, Edge Function, frontend, test, config, staging or production state was
modified. This file is the only artifact produced.

---

## 1. Executive Summary

G-09 (Finance / Collections Read Surface) is closed and is the current
authoritative baseline. Every prior Phase 7 admin read surface
(`command-center`, `enterprise-reports`, `executive-analytics` global actions,
`financial-command-center`) is now reachable from the staff frontend.

After a fresh inspection of the tree at HEAD `90100aa`, the set of backend
capabilities that are implemented, authorized, tenant-isolated and audited but
still **unreachable from the frontend** is small. The clearest genuinely-new
product gap that is ready for additive frontend work is the **Alert-Center read
surface** (`list` + `analytics` actions of the existing `alert-center` Edge
Function), which today has zero frontend callers and represents an entire
incident-triage domain that no closed workstream covers.

The main caveat is a data-generation dependency (there is no scheduled alert
evaluator, so staging has no organic alert rows), which does not block the
reachability/authorization workstream but is documented as a deferred
environment/owner dependency. Stronger-than-expected alternatives
(remaining `executive-analytics` operational actions, Doctor schedule/leave,
financial mutation surfaces, production autonomy) are assessed and deferred in
§19 with factual reasons.

**Selected next workstream: Alert-Center Read Surface (read-only `list` +
`analytics`).** See §16 and §22.

---

## 2. Baseline

| Item | Value |
| --- | --- |
| HEAD | `90100aaba1a6bf637c44540e1107f886bf14c1e3` (`90100aa`) |
| Commit subject | `Add Finance / Collections Read Surface (G-09)` |
| Branch | `main` |
| Prior commits (recent) | `df4101f` G-08 · `18cfefc` AUTH request-loop · `da5332e` G-07/G-06 · `9f4a2c8` G-06 · `a02200f` G-05 · `0cb2800` G-03 |
| Working tree (source) | CLEAN — no tracked source/SQL/config modifications |
| Working tree (non-source) | `graphify-out/cache/stat-index.json` (M) + untracked phase reports, `*.log`, `*.png`, probe `.ps1` scripts |

**Difference documented (per §2).** The task specification assumes a Git
repository and this is now true: the tree **is** a Git repository and HEAD
matches the expected `90100aa` / `main` baseline. This contradicts the
AGENTS.md §13 note that "the working tree is NOT a Git repository (no
`.git`)." That note is now stale; the repository has since been initialised
and the G-09 commit recorded. This report follows the observed Git state. No
claim is made about remote/origin push state beyond the local `main` log —
`git log` shows the commit chain but push reachability to any hosted `origin`
was not (and, per §3, should not be) probed.

---

## 3. Read-Only Compliance

Only non-mutating operations were used: `git status/log/rev-parse/branch`,
Glob, Read, Grep, and one `Test-Path`. No command from the §2 dangerous/
file-rewriting/destructive classes was run. No migrations applied, no SQL
executed, no deploys, no staging or production access, no commits/pushes.

---

## 4. Closed Workstreams (treated immutable)

G-03 (Admin Command Centre), G-05 (Audit & Compliance Viewer), G-06
(Executive/Operational Reports Viewer), G-07 (Staff Booking Reschedule), AUTH
(app-shell request/remount loop), G-08 (Global Admin Portfolio), G-09
(Finance/Collections Read Surface). Confirmed still wired and reachable in
§17. None reopened.

---

## 5. Current Architecture Inventory

### 5.1 Frontend routes (`apps/web/src/App.tsx`)

| Route | Component | Role gate | Backend |
| --- | --- | --- | --- |
| `/login` | Login | public | Supabase Auth |
| `/` | Landing | staff | — |
| `/reception`, `/reception/book`, `/reception/walk-in`, `/reception/patients`, `/reception/notifications`, `/queue` | ReceptionDashboard / BookAppointment / WalkIn / Patients / Notifications / QueueBoard | receptionist | create-booking, cancel-booking, queue-control, reads (RLS), update-booking-status |
| `/doctor` | DoctorConsole | doctor | doctor-operations |
| `/admin` | AdminCommandCentre | admin (G-03) | command-center |
| `/admin/audit` | AdminAudit | admin (G-05) | enterprise-reports |
| `/admin/reports` | AdminReports | admin (G-06) | enterprise-reports `generate` |
| `/admin/financial` | AdminFinancial | admin (G-09) | financial-command-center |
| `/admin/portfolio` | AdminPortfolio | global_admin (G-08) | executive-analytics (portfolio/benchmarks) |
| `/bookings/:bookingId` | BookingDetail | staff | reads + status/cancel/reschedule |

Route count: 13 routed surfaces + login. No alert route. No doctor
schedule/leave route.

### 5.2 Edge Functions (`supabase/functions/`, 26 total)

- **Frontend-consumed:** `command-center`, `enterprise-reports`,
  `executive-analytics` (global actions only), `financial-command-center`,
  `doctor-operations`, `create-booking`, `cancel-booking`,
  `reschedule-booking`, `update-booking-status`, `queue-control`.
- **Background worker / scheduler (no frontend):** `run-background-worker`,
  `run-cron-minute`, `run-cron-nightly`, `carry-forward-tokens`,
  `compute-sla`, `refresh-rollups`, `send-reminders`.
- **Webhook / outbound (no frontend):** `process-whatsapp-webhook`,
  `send-whatsapp-message`.
- **Payment / financial engine (server/worker-invoked, no staff-frontend
  caller):** `create-payment-order`, `verify-payment`, `process-refund`,
  `settlement-engine`.
- **System/monitoring (no frontend):** `monitoring-health-check`,
  `queue-next-patient`.
- **UI-intended but ZERO frontend callers:** **`alert-center`** and the five
  remaining hospital-scoped `executive-analytics` actions.

### 5.3 Database (relevant to candidates)

- `47_enterprise_command_center.sql`: `get_alert_center(UUID,TEXT,TEXT,TEXT,INTEGER)`
  and the alert lifecycle/`fire_alert` machinery; `get_alert_analytics`.
- `24_operational-monitoring_engine.sql`: `alert_events` table + one backfill
  INSERT.
- `17_queue_monitoring_engine.sql`: `check_queue_backlog_alerts(INTEGER,INTEGER)`
  — the only alert-generating function; service-role-only; **no runtime caller**
  (see §12).
- `31_doctor_leave_management.sql` (+ earlier `doctor_leaves` /
  `doctor_availability_overrides` tables): `is_doctor_available`,
  `get_doctor_availability_reason`, `get_doctor_unavailable_dates`
  (SECURITY DEFINER reads). **No dedicated leave/schedule write RPC or Edge
  Function.**
- Financial writes live in `process-refund`, `settlement-engine`,
  `create-payment-order`, `verify-payment` — separate from the
  read-only `financial-command-center`.

---

## 6. Frontend Reachability Map

| Backend capability | Edge Function / RPC | Frontend caller | Role | R/W | Status |
| --- | --- | --- | --- | --- | --- |
| Admin ops overview/timeline/sla/health | command-center | AdminCommandCentre | hospital_admin/global_admin | Read | REACHABLE (G-03) |
| Audit & compliance reads | enterprise-reports | AdminAudit | admin | Read | REACHABLE (G-05) |
| Executive/operational report generation | enterprise-reports `generate` | AdminReports | admin | Read | REACHABLE (G-06) |
| Global portfolio/benchmarks | executive-analytics (portfolio, benchmarks) | AdminPortfolio | global_admin | Read | REACHABLE (G-08) |
| Finance collections reads | financial-command-center | AdminFinancial | admin | Read | REACHABLE (G-09) |
| Doctor consultation workflow | doctor-operations | DoctorConsole | doctor/admin | Mixed | REACHABLE |
| Booking create/cancel/reschedule/status | create/cancel/reschedule/update-booking-status | Reception/BookingDetail | receptionist/admin | Write | REACHABLE |
| Queue control | queue-control | QueueBoard | receptionist | Write | REACHABLE |
| **Alert center (list + analytics)** | **alert-center** | **NONE** | hospital_admin/global_admin | **Read** | **UNREACHABLE — candidate** |
| Alert lifecycle mutations | alert-center (ack/assign/resolve/escalate/suppress) | NONE | admin | Write | UNREACHABLE — deferred |
| Hospital ops analytics (daily/weekly/monthly/doctor_perf/rankings) | executive-analytics | NONE | admin | Read | UNREACHABLE — candidate/overlap w/ G-06 |
| Doctor leave/schedule management | (no canonical write surface) | NONE | admin | Write | NO BACKEND BOUNDARY — see §13 |
| Refund/settlement/payment-order/verify | process-refund / settlement-engine / create-payment-order / verify-payment | NONE (engine) | service/worker | Write | ENGINE — not a frontend read task |

---

## 7. Zero-Caller Analysis (current, post-G-09)

Updated from the pre-G-09 picture: `financial-command-center` is now consumed
by G-09 and is no longer a zero-caller. Remaining UI-intended zero-caller
capabilities:

1. **`alert-center`** — full management API, `list`/`analytics` are read-only
   and clearly UI-intended. Genuine unopened domain.
2. **`executive-analytics` hospital-scoped actions** (`daily_operations`,
   `weekly_operations`, `monthly_executive`, `doctor_performance`,
   `doctor_rankings`) — authorized reads; `weekly/monthly/doctor_performance`
   overlap the G-06 report generator's subject matter, so only
   `daily_operations` and `doctor_rankings` are non-overlapping.

Non-UI zero-callers (correctly so): worker/scheduler/webhook/payment-engine/
monitoring functions — these are background/system surfaces, not product gaps.

---

## 8. Candidate Workstreams

- **C1 — Alert-Center Read Surface** (`list` + `analytics`).
- **C2 — Remaining Executive-Analytics Operational Views**
  (`daily_operations`, `doctor_rankings`).
- **C3 — Doctor Schedule / Leave** management surface.
- **C4 — Financial Mutation / Settlement / Refund surface.**
- **C5 — Production Readiness & Autonomy** (Vault, scheduler, backup/DR, D5,
  D13, production deploy).

---

## 9. Candidate Security Classification

| Dimension | C1 Alert read | C2 Analytics | C3 Doctor leave | C4 Financial write |
| --- | --- | --- | --- | --- |
| Security completeness | COMPLETE for reads | COMPLETE for reads | INCOMPLETE (no canonical write boundary) | Backend present but write-domain |
| Tenant isolation | PROVEN (`X-Hospital-ID` + `loadAuthorizedAlert` + `get_alert_center`) | PROVEN (header-scoped, non-global actions) | UNKNOWN for write | Engine-managed |
| Authorization | PROVEN (`requireRole(["hospital_admin","global_admin"])`) | PROVEN | PARTIAL (permission exists; RPC grant path for write MISSING) | n/a |
| Auditability | N/A for reads (writes audited) | N/A (read-only by design) | MISSING for write | Required, present in engine |
| Idempotency | N/A reads (mutations documented idempotent) | N/A | n/a | Required |
| Mutation surface | READ ONLY (for this candidate) | READ ONLY | WRITE | WRITE |
| Dependencies | alert generator (scheduler) for DATA only | NONE | NEW BACKEND | canonical RPCs |

---

## 10. Candidate Runtime / Evidence Classification

| Candidate | HTTP evidence | Staging evidence | Notes |
| --- | --- | --- | --- |
| C1 Alert read | Backend is a standard Edge Function; local HTTP path testable | NOT PROVEN; staging `alert_events` has no organic generator | Seeding required for meaningful rows (same accepted pattern as G-09) |
| C2 Analytics | Pass-through SQL reads; live data exists in staging | NOT PROVEN (frontend); command-center read paths separately proven | Renders REAL staging data without seeding |
| C3 Doctor leave | No write path to test | NOT PROVEN | Would need new backend first |
| C4 Financial write | Engine exists | Not a frontend read candidate | Separate mutation workstream |

---

## 11. Dependency Analysis

- **C1:** no backend/schema/RLS/grant change for the read surface. One product
  data dependency: `check_queue_backlog_alerts` has **no caller** and the
  scheduler does not exist (roadmap P0-02 / NPD-05), so alert rows are not
  produced organically. This is an ENVIRONMENT/OWNER dependency for *data
  volume*, not a blocker for the *reachability/authorization* build.
- **C2:** none — data and reads exist now.
- **C3:** requires a NEW canonical write RPC/Edge Function + audit + state
  machine for leave/schedule (BACKEND + SECURITY dependency).
- **C4:** canonical financial engine; treat as a dedicated financial-mutation
  workstream, not a read surface.
- **C5:** owner/environment (secrets, paid infra, domain, Vault).

---

## 12. Alert-Center Reassessment (required special check — §14)

Inspected `supabase/functions/alert-center/index.ts` (405 lines) + supporting
SQL/tests.

- **Read actions:** `list` → `get_alert_center` RPC; `analytics` →
  `get_alert_analytics` RPC. Both read-only, no audit entries.
- **Write actions:** `acknowledge`, `assign`, `resolve`, `escalate` (target an
  alert, `ALERT_TARGET_ACTIONS`) and `suppress` (window by `alertKey`). These
  run through SECURITY DEFINER alert RPCs (migration 47) which own the state
  transitions and activity log; the edge layer only authorizes, enforces
  isolation and audits (`logAuditEvent`).
- **Role requirement:** `requireRole(auth, ["hospital_admin", "global_admin"])`.
- **Tenant requirement:** `X-Hospital-ID` header mandatory;
  `loadAuthorizedAlert` rejects an alert whose `hospital_id` ≠ header hospital
  (`ForbiddenError`). Global admins still scope via the header.
- **Idempotency:** mutations documented idempotent (RPC-owned transitions).
- **Organic data:** the only alert generator is
  `check_queue_backlog_alerts` (migration 17). Grep across
  `supabase/functions/` finds it referenced only in the generated types — it
  is NOT invoked by `run-cron-minute`/`run-cron-nightly`/the worker. Combined
  with the roadmap's "Alert center … `fire_alert` has no scheduled evaluator"
  and "no scheduler exists (P0-02)," staging will hold **no organically
  generated alerts**. This is a real caveat.
- **Known quality caveat (roadmap P3-01):** alert firing surfaces
  authorization errors as 500 rather than 403 on some SQL paths; the
  Edge-Function read path itself uses proper `ForbiddenError`. This must be
  re-verified during implementation, not assumed fixed.
- **CORS / deployment:** `alert-center` calls the shared, G-03-remediated
  `handleCors(req)` — same posture as the other proven surfaces. It has NOT
  been individually deployed for G-09 (only `financial-command-center` was
  deployed), so a future implementation must deploy/verify `alert-center`
  explicitly.
- **Read-only-first consumption:** YES — a frontend can consume only
  `list` + `analytics` with zero mutation exposure, mirroring the G-03/G-09
  read wrappers. Exposing `acknowledge`/`assign`/`resolve`/`escalate`/
  `suppress` would create a NEW mutation workstream (deferred).

**Verdict:** `alert-center` is the strongest genuinely-new product gap: an
entire incident-triage domain with a complete, authorized, tenant-isolated,
audited backend and zero frontend reachability. The only weakness is staging
data, addressed by the same seeding pattern already accepted for G-09.

---

## 13. Doctor Schedule / Leave Reassessment (§16)

- Read primitives exist: `is_doctor_available`,
  `get_doctor_availability_reason`, `get_doctor_unavailable_dates` (used
  inside booking/queue logic already).
- There is **no** doctor schedule/leave Edge Function and **no** canonical
  leave write RPC. A frontend leave manager would either call
  `doctor-operations` actions that do not exist, or write `doctor_leaves` /
  `doctor_availability_overrides` **directly**, bypassing
  Edge Function → authorization → validation → audit → invariant enforcement.
- Per §9's rule, that makes Doctor Schedule/Leave a **SECURITY/DESIGN GAP
  requiring new backend**, not a frontend-only candidate. Deferred.

---

## 14. Remaining Financial Capability Assessment (§15)

- `financial-command-center` exposes exactly `overview`, `forecast`,
  `reconciliation` — **all three consumed by G-09**; there is no residual
  finance *read* action.
- Remaining financial capabilities are **writes**: refunds
  (`process-refund`), settlement (`settlement-engine`), payment order/verify
  (`create-payment-order`, `verify-payment`). These are engine surfaces driven
  by the canonical payment/refund/settlement primitives and are NOT a generic
  finance dashboard. They must be scoped as a dedicated financial-mutation
  workstream with full idempotency/audit/ledger reasoning. Not selected here.

---

## 15. Production / Autonomy Assessment

Production Vault, production Supabase instance/domain, scheduler install
(P0-02/NPD-05), worker activation defaults (P0-03), backup/DR, D5, D13 and the
production deployment itself are **OWNER DECISION / ENVIRONMENT BLOCKER**
items, not product gaps, and several require secrets/paid infrastructure. Per
§12 criterion G they are not eligible to be the next workstream while a
self-contained product gap (C1) exists.

---

## 16. Recommended Next Workstream

```text
WORKSTREAM: Alert-Center Read Surface (alert-center `list` + `analytics`)
CLASSIFICATION: PRODUCT GAP (missing frontend reachability over an existing,
                authorized backend)
CURRENT STATE: Backend IMPLEMENTED + authorized + tenant-isolated + audited
               (writes); frontend reachability ZERO; not yet individually
               deployed/staging-proven.
WHY IT IS READY: Additive frontend + read-only wrappers; no backend/schema/RLS/
                 grant change; matches the proven G-03/G-09 read-surface
                 pattern; opens a new operational domain rather than extending
                 a closed one.
REQUIRED IMPLEMENTATION BOUNDARY: New route /admin/alerts + AdminAlerts
                 surface + api/alertCenter.ts read wrappers (list, analytics
                 only); role gate ADMIN_ROLES; unit tests + real-HTTP
                 integration tests (authz + tenant denial) + staging browser
                 walkthrough with seeded alert rows.
DEPENDENCIES: For full product value (populated inbox), a scheduled alert
              evaluator is required (P0-02/NPD-05) — DEFERRED and out of scope
              for the read surface; staging demonstration uses seeded fixtures.
WHAT MUST NOT BE TOUCHED: closed surfaces G-03/G-05/G-06/G-07/AUTH/G-08/G-09;
              the alert lifecycle MUTATION actions; production; the scheduler
              design decision; any SQL/RLS/grant.
```

---

## 17. Regression Check (static)

Confirmed present and role-gated in `App.tsx` at HEAD `90100aa`: `/admin`
(G-03), `/admin/audit` (G-05), `/admin/reports` (G-06), `/admin/financial`
(G-09), `/admin/portfolio` (G-08), `/doctor`, reception + `/queue` routes, and
the app-shell request loop (AUTH). API wrappers exist for each consumed
function. No closed surface appears broken. (Read-only inspection only; no
mutations, no redeploy.)

---

## 18. Proposed Implementation Boundary (NOT implemented)

- **Files likely added:** `apps/web/src/routes/AdminAlerts.tsx` (+ test),
  `apps/web/src/api/alertCenter.ts` (+ test), `apps/web/src/types/api.ts`
  (read-only contracts), route + nav entry in `App.tsx` / `AppShell.tsx`.
- **Backend changes:** NONE required for the read surface.
- **SQL changes:** NONE (reuse `get_alert_center`, `get_alert_analytics`).
- **Frontend changes:** read-only wrappers sending exactly `list` and
  `analytics`; hospital id travels only via the authenticated header path used
  by `callFunction`, mirroring `commandCenter.ts` / `financial.ts`.
- **Tests:** unit (wrapper shape); real-HTTP integration (hospital_admin
  success, receptionist/doctor denial, cross-tenant denial); staging browser
  walkthrough with seeded `alert_events` fixtures.
- **Local verification:** `deno task check`, `lint`, `fmt:check`, `test`,
  `test:integration` against the local stack.
- **Staging verification:** deploy `alert-center` only; full authorization
  matrix + regression of G-03…G-09; zero idle polling; zero console errors.

---

## 19. Acceptance Criteria (future gates)

1. `/admin/alerts` reachable by hospital_admin & global_admin; rejected for
   receptionist and doctor at both route and Edge-Function boundaries.
2. `list` renders filtered alert rows; `analytics` renders volume/resolution —
   server-computed, never client-derived.
3. Cross-tenant alert access denied (SQLSTATE/403 path proven, not a JWT-layer
   401 masquerading as denial — F16-05 lesson).
4. No mutation action is exposed; acknowledgement explicitly out of scope.
5. Production untouched; only `alert-center` newly deployed to staging.
6. Regression PASS for G-03/G-05/G-06/G-07/AUTH/G-08/G-09.

---

## 20. Deferred Candidates (factual reasons)

- **C2 Remaining executive-analytics ops (`daily_operations`,
  `doctor_rankings`)** — viable, no data dependency, but its subject matter
  neighbors the closed G-06 reports and risks a second-reporting-view rather
  than a new domain. Held as the fallback if alert data seeding is judged
  insufficient.
- **C3 Doctor schedule/leave** — needs a new canonical write RPC/Edge Function
  + audit + state machine; currently a security/design gap, not frontend-only.
- **C4 Financial mutation/settlement/refund surface** — write/engine domain;
  separate financial-integrity workstream.
- **C5 Production/autonomy/scheduler/Vault/DR** — owner decision + environment
  blockers; not a self-contained product gap.

---

## 21. Risks

- **Empty-data risk (C1):** without a scheduled evaluator, `alert_events` is
  not organically populated; a real admin opening the surface post-scheduler
  may see little. Mitigation: seed for staging evidence; document scheduler as
  the data-source dependency, and keep the read surface independent of it.
- **P3-01 caveat:** verify authz errors return 403 (not 500) on the read path
  during implementation; do not assume the roadmap note is fixed.
- **Deployment drift:** only `alert-center` should deploy; do not redeploy the
  other functions.
- **Scope creep:** resist wiring mutation actions into the first surface.

---

## 22. STOP CONDITIONS (for the future implementation agent)

STOP and report (do not self-patch) if any of the following is found while
building the read surface:

- `get_alert_center` / `get_alert_analytics` are missing, unauthorized to
  service role, or require a schema/RLS/grant change.
- The Edge-Function read path cannot enforce tenant isolation without editing
  SQL or grants.
- Authz failures surface as 500 in a way that would require touching the alert
  SQL engine to fix.
- Staging has no way to seed alert fixtures without a mutating migration.
- Any need to reopen a closed workstream or deploy a second function.

---

## 23. Final Recommendation

```text
NEXT WORKSTREAM: Alert-Center Read Surface (list + analytics)

CLASSIFICATION: PRODUCT GAP (frontend reachability over an existing,
                authorized, tenant-isolated backend)

STATUS: READY FOR IMPLEMENTATION
```

The Alert-Center read surface satisfies the §12 criteria: a genuine product
gap (an unopened incident-triage domain), an existing and security-complete
backend, HTTP/runtime testability through the real path, contained additive
frontend scope, minimal architectural disturbance, and no owner/environment
blocker for the reachability work itself (the scheduler/data-generation gap is
documented and deferred, exactly as the alert MUTATION surface is deferred).
