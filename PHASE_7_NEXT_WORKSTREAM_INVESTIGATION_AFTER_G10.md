# SETURA HOSPITAL OS
# PHASE 7 — POST-G-10 NEXT WORKSTREAM INVESTIGATION
# INVESTIGATION-ONLY — NOTHING IMPLEMENTED

This document is the required §19 report. It is an **INVESTIGATION-ONLY**
deliverable. No source, SQL, migration, RLS, grant, Edge Function or frontend
file was modified. No deployment was made and production was not touched.

---

## 1. Executive Summary

G-10 (Alert-Center Read Surface) is closed and its implementation commit is the
current `HEAD`. Every synchronous **read** surface an admin needs over the
enterprise primitives is now reachable from the console **except one**: the
tenant-scoped **Hospital Operations Analytics** read actions
`daily_operations` and `doctor_rankings` exposed by the existing
`executive-analytics` Edge Function. They are backend-complete, integration-
tested against the real stack and privilege-isolated, but have **zero frontend
caller** — the console consumes only `portfolio`/`benchmarks` (G-08) from that
function, and consumes `weekly_operations`/`monthly_executive`/
`doctor_performance` through a *different* function (`enterprise-reports`
`generate`, G-06), which is a report-generation surface, not the operational
dashboard read.

Selected next workstream:

```text
G-11 — Hospital Operations Analytics Read Surface
```

Classification: **FRONTEND REACHABILITY GAP**. Status:
**READY FOR IMPLEMENTATION** (backend/security is already proven; the only
missing artifact is a browser-reachable read view + its API wrapper + tests,
mirroring the exact G-03/G-05/G-06/G-08/G-09/G-10 pattern).

---

## 2. Current Baseline

Authoritative completed workstreams (locked, per task §1/§5):

```text
G-03 — PROVEN STAGING — CLOSED
G-05 — PROVEN STAGING — CLOSED
G-06 — PROVEN STAGING — CLOSED
G-07 — PROVEN STAGING — CLOSED
G-08 — PROVEN STAGING — CLOSED
G-09 — PROVEN STAGING — CLOSED
G-10 — PROVEN STAGING — CLOSED
AUTH — proven auth app shell / request loop — CLOSED
```

---

## 3. G-10 Closure Confirmation

G-10 delivers `/admin/alerts` over `alert-center` `list` + `analytics` only,
verified staging (hospital_admin/global_admin 200; receptionist/doctor 403;
missing X-Hospital-ID 422; anonymous 401; cross-tenant 403) and in-browser.
G-10 is not reopened or retested here. Its deliberate scope exclusion (alert
lifecycle **mutations**) is carried forward as candidate C2 below — not as a
G-10 defect.

---

## 4. Repository State (stale-state detection — task §3)

Commands actually run in this session:

```text
git rev-parse HEAD        -> 88df4fceaa1dce6df39cadd9d53a3cd2435368b2
git branch --show-current -> main
git log --oneline -1      -> 88df4fc Add Alert-Center Read Surface (G-10)
```

- `HEAD` **exactly equals** the G-10 commit `88df4fc` the task declares. The
  repository has NOT moved forward past G-10.
- `git status --short` shows **no tracked source modifications**. The only
  entries are untracked investigation reports, staging screenshots and
  `graphify-out/cache/**` generated artifacts. No `M` line touches
  `apps/`, `supabase/` or `tests/`.
- `origin/main` is one commit behind (`90100aa` G-09); `88df4fc` is local HEAD
  on `main` and not yet pushed. This is a push state, not a code divergence —
  the working tree content matches G-10.

Note (AGENTS.md §13): the historical "not a Git repository" observation no
longer holds — the tree is now a real Git repository with a `main` branch and
history. This is reported as a factual change to a prior baseline claim, not
silently reconciled.

**The source tree is the authority for everything below.**

---

## 5. Frontend Surface Inventory

Routes defined in `apps/web/src/App.tsx` (all gated client-side as a UX
boundary; the Edge Function is authoritative):

| Route | Component | Roles (UX guard) | Backing Edge Function |
| --- | --- | --- | --- |
| `/reception` | ReceptionDashboard | receptionist, hospital_admin | command-center / reads |
| `/reception/book` | BookAppointment | receptionist, hospital_admin | create-booking |
| `/reception/walk-in` | WalkIn | receptionist, hospital_admin | create-booking / queue |
| `/reception/patients` | Patients | receptionist, hospital_admin | direct table reads |
| `/reception/notifications` | Notifications | receptionist, hospital_admin | reads (delivery status) |
| `/queue` | QueueBoard | receptionist, hospital_admin | queue-control |
| `/doctor` | DoctorConsole | doctor, hospital_admin | doctor-operations |
| `/bookings/:id` | BookingDetail | (in-shell) | cancel/reschedule/status/reads |
| `/admin` | AdminCommandCentre | hospital_admin, global_admin | command-center |
| `/admin/audit` | AdminAudit | hospital_admin, global_admin | enterprise-reports |
| `/admin/reports` | AdminReports | hospital_admin, global_admin | enterprise-reports (generate) |
| `/admin/financial` | AdminFinancial | hospital_admin, global_admin | financial-command-center |
| `/admin/portfolio` | AdminPortfolio | global_admin only | executive-analytics (portfolio/benchmarks) |
| `/admin/alerts` | AdminAlerts | hospital_admin, global_admin | alert-center (list/analytics) |

Edge Functions actually invoked from the frontend (confirmed via
`callFunction("<name>", …)` in `apps/web/src/api/*`):

```text
alert-center  cancel-booking  command-center  create-booking
doctor-operations  enterprise-reports  executive-analytics
financial-command-center  queue-control  reschedule-booking
update-booking-status
```

---

## 6. Edge Function Inventory (26 functions)

Consumed-by-frontend vs machine/backend-only:

| Function | Purpose | Read/Write | Frontend caller | Notes |
| --- | --- | --- | --- | --- |
| alert-center | alert list/analytics + lifecycle | READ + WRITE | list/analytics ONLY | **5 write actions have no UI (C2)** |
| executive-analytics | operations & portfolio analytics | READ | portfolio/benchmarks ONLY | **`daily_operations` + `doctor_rankings` have NO UI (C1)** |
| command-center | live operational dashboard + broadcasts | READ + WRITE | yes (overview/timeline/predictive/sla/health) | distinct actions from exec-analytics |
| enterprise-reports | audit/integrity + report `generate` | READ | yes | `weekly/monthly/doctor_performance` as generated reports |
| financial-command-center | finance reads | READ | yes (overview/forecast/reconciliation) | all three consumed (G-09) |
| create-booking / cancel-booking / reschedule-booking / update-booking-status / queue-control / doctor-operations | booking & clinical lifecycle | WRITE | yes | consumed |
| create-payment-order | payment order | WRITE | **none** | patient online-booking path, not an admin surface |
| verify-payment | gateway webhook verify | WRITE | **none** | webhook/machine endpoint |
| process-refund | refund engine | WRITE | **none** | financial mutation engine (C3) |
| settlement-engine | settlement rollup | WRITE | **none** | background/financial (C3) |
| send-reminders / carry-forward-tokens / compute-sla / refresh-rollups | scheduled jobs | WRITE | **none** | cron/background; scheduler is owner-blocked (C6) |
| run-background-worker / run-cron-minute / run-cron-nightly / monitoring-health-check | machine endpoints | control | **none** | infra, secret-gated |
| process-whatsapp-webhook / send-whatsapp-message | WhatsApp integration | WRITE | **none** | webhook/outbound engine |

Zero-frontend-caller analysis (task §7): the UI-intended functions with genuine
unreachable reads are **`executive-analytics`** (`daily_operations`,
`doctor_rankings`). The remaining zero-caller functions are all
write/machine/webhook engines that are **not** safe generic UI exposes —
either background-driven (worker/cron), credential-gated (webhook/machine), or
financial-mutation engines requiring dedicated scoping (C3).

---

## 7. Database / RPC Capability Review

`executive-analytics` is a thin pass-through over the SQL analytics layer
defined in migration `47_enterprise_command_center.sql`, with privilege hardening
in `49_phase_1_5_defect_fixes.sql`. The two candidate reads:

```text
public.get_daily_operations_dashboard(UUID, DATE)
public.get_doctor_rankings(UUID, DATE, DATE)
```

Both are SECURITY DEFINER, hospital-scoped by `p_hospital_id`, reachable to the
browser only through the Edge Function's service-role client. Their EXECUTE is
not granted to `anon`/`authenticated` (locked-routine category, verified by the
Gate 2 privilege census and `privilege_isolation.test.ts`). Classification:
**fully implemented backend read primitive · missing frontend reachability ·
backend-only by design at the DB boundary (correct) · safe to expose through the
existing Edge Function action (already authorized there).** No SQL/RLS/grant
change is required for a read surface.

---

## 8. Security Review (task §10)

For the selected candidate (C1, read-only):

| Question | Answer |
| --- | --- |
| Exposes patient data? | No — aggregate operations metrics / doctor ranking counts, hospital-scoped |
| Crosses tenant boundary? | No — `X-Hospital-ID` header + `p_hospital_id`; `daily_operations`/`doctor_rankings` are tenant-scoped (not in `GLOBAL_ACTIONS`) |
| New write path? | No — read-only |
| New SECURITY DEFINER logic? | No — RPCs already exist |
| Bypass existing invariant? | No |
| New RLS / grants? | No |
| Audit logging needed? | No (read; matches G-03/G-08/G-09/G-10 read surfaces which are not audited) |
| Idempotency needed? | N/A (read) |
| Involves money? | No (operational counts, not financial) |
| External credentials? | No |

Server-side enforcement already present in `executive-analytics/index.ts`:
`resolveAuth` + `requireRole(["hospital_admin","global_admin"])`, mandatory
`X-Hospital-ID`, and a `GLOBAL_ACTIONS` gate (403 for non-`global_admin` on
`portfolio`/`benchmarks`) that does **not** apply to the tenant-scoped
`daily_operations`/`doctor_rankings`. The candidate is therefore
**security-ready**; it introduces no new authorization surface.

---

## 9. Financial Review (task §11)

No financial mutation is proposed. `financial-command-center` reads are fully
consumed by G-09 (no residual finance read action). Remaining financial
capabilities (`process-refund`, `settlement-engine`, `create-payment-order`,
`verify-payment`) are **write engines** and are deliberately NOT folded into a
read-surface workstream — see candidate C3. The business rule (SETURA collects
only the booking/platform fee; refund ≤ SETURA-collected; revenue only after
capture) is untouched by G-11.

---

## 10. Production / Infrastructure Review (task §12)

Owner/environment blockers (NOT product gaps, ineligible as next workstream):
production Supabase instance/domain, production Vault/secrets, scheduler
activation (P0-02/NPD-05 — no `pg_cron`/`pg_net` invocation exists), worker
activation default (`ENABLE_WORKER_TRIGGER=false`, P0-03), `claim_jobs_v2`
lease-recovery regression (P0-01), backup/DR, production deployment, and the
production privilege re-verification. G-11 requires none of these.

---

## 11. Candidate Workstreams

### C1 — Hospital Operations Analytics Read Surface  ← SELECTED
- **Evidence:** `executive-analytics` exposes `daily_operations` and
  `doctor_rankings`; frontend grep shows both appear **only** in
  `enterprise-reports` `generate` report types (different function/surface) and
  in `types`/tests — **never** as an `executive-analytics` dashboard read from
  any `apps/web/src/api/*` wrapper.
- **Backend:** complete + integration-tested (`enterprise_command_center.test.ts`)
  + privilege-isolated (`privilege_isolation.test.ts`).
- **Missing piece:** a browser read view + API wrapper + feature tests.
- **Read vs write:** READ. **Security complexity:** LOW. **Tenant:** enforced.
- **Financial:** none. **Testing burden:** low (mirrors G-09/G-10). **Staging:**
  feasible. **Dependencies:** none beyond closed work.
- **Why it matters:** it is the last admin-facing operational read primitive the
  console does not surface; an operator gets per-day throughput and doctor
  rankings without leaving the app.

### C2 — Alert Lifecycle Mutation Surface
- `alert-center` `acknowledge`/`assign`/`resolve`/`escalate`/`suppress` are fully
  implemented (requireRole, `loadAuthorizedAlert` tenant check, SECURITY DEFINER
  alert RPCs, `logAuditEvent` old/new state, zod required-field refines) but have
  no UI. Classification: **PRODUCT GAP (write)**. Deferred: it is a mutation
  surface (concurrency/idempotency/state-machine test burden), was intentionally
  de-scoped from G-10's read boundary, and task §23 explicitly excludes
  "adding alert mutations" from this session's consideration.

### C3 — Financial Mutation Workstream (refund / settlement / payment verify)
- Engines exist and are background/webhook-driven. Classification: **FINANCIAL
  WORKSTREAM · NOT READY — REQUIRES DESIGN/SECURITY INVESTIGATION** (ledger
  correctness, refund ≤ collected, idempotent partial refunds, settlement
  effects). Not a read surface; must be scoped separately.

### C4 — Doctor Schedule / Leave Management
- Read primitives exist (`is_doctor_available`, `get_doctor_availability_reason`,
  `get_doctor_unavailable_dates`); **no** leave/schedule Edge Function and **no**
  canonical leave **write** RPC. A UI would write `doctor_leaves`/
  `doctor_availability_overrides` directly, bypassing the auth→validation→audit→
  invariant layer. Classification: **BACKEND/SECURITY GAP · NOT READY — REQUIRES
  NEW BACKEND**.

### C5 — Notification / Integration Management Surface
- `process-whatsapp-webhook`, `send-whatsapp-message` are credential-gated
  engines; delivery status is already surfaced read-only on the reception
  `/reception/notifications` route. No admin-facing integration-management
  backend primitive is currently unreachable-and-intended. Classification:
  **NOT ACTUALLY A READ GAP** (no safe, backend-complete UI to expose yet).

### C6 — Production / Autonomy
- **INFRASTRUCTURE / OWNER BLOCKER** (§10). Ineligible while a self-contained
  product reachability gap exists.

---

## 12. Candidate Classification (task §14)

| ID | Classification |
| --- | --- |
| C1 | **FRONTEND REACHABILITY GAP** |
| C2 | PRODUCT GAP (write) — deferred |
| C3 | FINANCIAL WORKSTREAM — not ready |
| C4 | BACKEND/SECURITY GAP — requires new backend |
| C5 | NOT ACTUALLY A READ GAP |
| C6 | INFRASTRUCTURE / OWNER BLOCKER |

---

## 13. Selected Next Workstream

**G-11 — Hospital Operations Analytics Read Surface.**

Objective: expose the existing, tenant-scoped `executive-analytics` read actions
`daily_operations` and `doctor_rankings` to hospital/global admins through a
read-only console surface, using only the already-proven Edge Function + SECURITY
DEFINER RPCs, with no backend, SQL, RLS or grant changes.

Selection is evidence-based on §15 criteria, not subjective "best": C1 is the
only candidate that is simultaneously (a) backend-complete, (b) integration- and
privilege-verified, (c) read-only with LOW security complexity, (d) staging-
verifiable without production or secrets, (e) non-overlapping with G-03
(`command-center` live dashboard), G-06 (`enterprise-reports` generated reports)
and G-08 (`executive-analytics` portfolio/benchmarks), and (f) inside the exact
proven G-0x read-surface pattern. C2 is write/deferred; C3/C4 need new design or
backend; C5/C6 are not eligible.

---

## 14. Evidence

- `git rev-parse HEAD` = `88df4fceaa1dce6df39cadd9d53a3cd2435368b2` (G-10).
- `executive-analytics/index.ts`: `ANALYTICS_ACTIONS = [daily_operations,
  weekly_operations, monthly_executive, doctor_performance, doctor_rankings,
  portfolio, benchmarks]`; `GLOBAL_ACTIONS = {portfolio, benchmarks}`; handler
  enforces `requireRole(["hospital_admin","global_admin"])` + `X-Hospital-ID`.
- Frontend `callFunction("executive-analytics", …)` calls exist only in
  `api/portfolio.ts` (`portfolio`, `benchmarks`). No wrapper posts
  `daily_operations` or `doctor_rankings`.
- `enterprise-reports` `generate` report types in `AdminReports.tsx` /
  `executiveReports.ts` are `weekly_operations`/`monthly_executive`/
  `doctor_performance` — a separate generated-report surface, not the analytics
  dashboard read.
- RPCs `get_daily_operations_dashboard(UUID, DATE)` and
  `get_doctor_rankings(UUID, DATE, DATE)` defined in migration 47, hardened 49;
  exercised by `tests/integration/enterprise_command_center.test.ts`;
  privilege-locked per `tests/integration/privilege_isolation.test.ts`.

---

## 15. Implementation Boundary (for G-11 — NOT implemented here)

| Artifact | required / not required / unknown |
| --- | --- |
| Route `/admin/operations` (or extend `/admin`) in `App.tsx` | **required** |
| New read component `apps/web/src/routes/AdminOperations.tsx` (+ `.test.tsx`) | **required** |
| API wrapper `apps/web/src/api/operations.ts` posting `{action:"daily_operations"}` and `{action:"doctor_rankings", fromDate?, toDate?}` | **required** |
| Response types in `apps/web/src/types/api.ts` | **required** |
| Edge Function change (`executive-analytics`) | **NOT required** (actions exist) |
| RPC / SQL change | **NOT required** |
| RLS change | **NOT required** |
| Grant change | **NOT required** |
| New migration | **NOT required** |
| Backend integration test | **NOT required** (already covered); add wrapper/route unit tests |

### Explicit exclusions (must NOT be implemented in G-11)
- No write/mutation action of any kind.
- No alert mutation surface (that is C2).
- No refund/settlement/payment surface (C3).
- No doctor leave/schedule UI (C4).
- No change to `executive-analytics` auth, tenant model or `GLOBAL_ACTIONS`.
- No scheduler/worker activation, no production deploy, no secrets.

---

## 16. Security Boundary (G-11)

- Roles: `hospital_admin` + `global_admin` (UX guard mirrors the server
  `requireRole`). Doctors/receptionists denied at the Edge Function.
- Tenant isolation: `X-Hospital-ID` header only (never body/URL); the two
  actions are tenant-scoped, so a `global_admin` still sees one hospital per
  request — no cross-tenant aggregation is introduced.
- Authorization: unchanged, server-side authoritative; the browser never reaches
  the RPCs directly (service-role only).
- Audit / idempotency: N/A for a read surface, consistent with G-03/G-08/G-09/
  G-10.

---

## 17. Verification Plan

- **Local:** `deno task fmt:check`, `lint`, `check`, frontend unit tests for the
  new API wrapper + route (mock `callFunction`, assert exact action bodies and
  that no mutation action is reachable).
- **Real HTTP:** hit `executive-analytics` `{action:"daily_operations"}` and
  `{action:"doctor_rankings"}` against the running local stack (Edge Runtime
  confirmed actually up per F16-01) with admin/reception/doctor/anonymous/
  missing-header and cross-tenant tokens.
- **Browser:** admin sees bounded read dashboard + refresh, zero polling, zero
  mutation controls, clean console; non-admin roles redirected/denied.
- **Staging:** hospital_admin 200, global_admin 200, receptionist/doctor 403,
  missing header 422, anonymous 401, cross-tenant 403 with no data.
- **Regression:** existing `enterprise_command_center` + `privilege_isolation` +
  full frontend suite stay green.

---

## 18. STOP Conditions

Halt G-11 implementation and escalate if any of:
- `executive-analytics` `daily_operations`/`doctor_rankings` turn out to require
  a new SQL/RLS/grant change (they currently do not).
- The read exposes per-patient PII rather than aggregates (must not).
- A `global_admin` request can cross-tenant aggregate through these actions.
- Any temptation to also wire alert/financial mutations (out of scope).
- Edge Runtime cannot be confirmed running (report BLOCKED, do not fake PASS).
- Docker/secrets/production access is demanded (G-11 must be local+staging only).

---

## 19. Dependencies

None beyond the closed baseline. G-11 depends only on the already-proven
`executive-analytics` Edge Function and migration-47/49 analytics RPCs. It does
not depend on the scheduler, worker, payment gateway or any owner/environment
item.

---

## 20. Final Recommendation

Proceed with **G-11 — Hospital Operations Analytics Read Surface** as the next
Phase 7 product workstream. It is the single objectively-justified gap: a fully
implemented, integration-verified, privilege-isolated, tenant-safe **read**
capability that currently has no browser reachability, matching the exact proven
read-surface delivery pattern of G-03/G-05/G-06/G-08/G-09/G-10, and requiring no
backend, SQL, RLS, grant or production change. Defer C2 (alert mutations), C3
(financial mutations) and C4 (doctor leave) until their dedicated
write/design/security investigations are scheduled.

---

CURRENT BASELINE:
G-10 — PROVEN STAGING — CLOSED

NEXT WORKSTREAM:
G-11 — HOSPITAL OPERATIONS ANALYTICS READ SURFACE

CLASSIFICATION:
FRONTEND REACHABILITY GAP

STATUS:
READY FOR IMPLEMENTATION

WHY:
`executive-analytics` already exposes tenant-scoped, integration-tested,
privilege-locked read actions `daily_operations` and `doctor_rankings` with
server-side `requireRole(hospital_admin, global_admin)` + `X-Hospital-ID`, but no
`apps/web/src/api/*` wrapper or route posts them. It is the only remaining
backend-complete, low-security-risk, non-overlapping admin read surface,
reachable through zero backend/SQL/RLS/grant/production change.

IMPLEMENTATION BOUNDARY:
`/admin/operations` route + `AdminOperations.tsx` (+ test) + `api/operations.ts`
wrapper posting only `{action:"daily_operations"}` and
`{action:"doctor_rankings", fromDate?, toDate?}` + response types in
`types/api.ts`. Unit + real-HTTP + browser + staging verification, read-only.

EXPLICITLY OUT OF SCOPE:
alert lifecycle mutations; refund/settlement/payment-verify; doctor
leave/schedule; any Edge Function/SQL/RLS/grant/migration change; scheduler/
worker activation; production deploy or secrets; changes to `executive-analytics`
authorization or tenant model.

KEY RISKS:
accidental scope-creep into the alert write surface; exposing non-aggregate
patient data (must remain aggregates); treating local PASS as production PASS;
Edge Runtime reported up without confirming it is actually running (F16-01).

VERIFICATION REQUIRED:
fmt:check / lint / check / unit tests; real-HTTP role+tenant matrix against the
running local stack; browser read-only walkthrough (bounded refresh, zero
mutation, clean console); staging 200/403/422/401/cross-tenant matrix; full
regression suite green.

PRODUCTION:
UNTOUCHED
