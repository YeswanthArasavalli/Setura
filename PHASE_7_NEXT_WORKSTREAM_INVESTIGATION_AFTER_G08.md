# PHASE 7 — NEXT WORKSTREAM INVESTIGATION AFTER G-08

**Phase:** 7 — Next Workstream Investigation after G-08 (READ-ONLY INVESTIGATION)
**Date:** 2026-10-01
**Role:** Independent senior enterprise architect / security / release-readiness
investigator
**Discipline:** BLOCKED ≠ PASS · UNPROVEN ≠ PASS · LOCAL ≠ STAGING ≠ PRODUCTION.
No numerical rankings. One defensible next boundary selected.

Investigation only. **No source, SQL, migration, RLS, grant, SECURITY DEFINER,
Edge Function, frontend, test, config, deployment, staging-data, fixture, role,
password, user, hospital, commit or push change was made.** The only file
written in this phase is this required report. Read-only inspection plus two
non-mutating staging probes (a `supabase functions list` read and two `OPTIONS`
CORS preflights) were used — neither changes any state.

---

## 1. Investigation Scope

Starting from the post-G-08 baseline, identify the **single highest-value
unresolved product / engineering / production-readiness workstream** to
implement next, classify every candidate against the required taxonomy, and
select one boundary with concrete source/runtime evidence. The previously
carried candidates (Alert Triage, Finance/Collections, Doctor
Schedule/Leave, Production Readiness/Autonomy, Git/Doc hygiene, Auth-loop) were
**reassessed from current source and current staging state**, not assumed still
correct. The closed workstreams (G-03/G-05/G-06/G-07/Auth-loop/G-08) were not
reopened absent a concrete regression.

## 2. Baseline

Verified against the actual Git repository this session (`git` commands
succeeded; the AGENTS.md §13 "not a Git repository" statement is stale and was
reported, not silently reconciled — see §12):

```text
HEAD          = df4101f45a6d5484970c362341a5fc95e84d586d  (git rev-parse HEAD)
HEAD subject  = "Add read-only global admin portfolio dashboard (G-08)"
origin/main   = df4101f   (HEAD -> main, origin/main, origin/HEAD)
auth-loop fix = 18cfefc   "Preserve proven auth app-shell request-loop fix"
prior         = da5332e   "Staff booking reschedule + G-06 closure"
```

Matches the task's stated baseline exactly (§1). `git status --short` shows
**only untracked evidence artifacts** (Phase 7 reports, `g07_*/g08_*/authloop_*`
PNGs, `_*` logs/scripts, `.vercel/`) — **zero tracked source modifications**.
Repository shape: 63 migrations (01–63), 26 Edge Functions + `_shared`,
`apps/web` React 18.3 + Vite console with 12 reachable routes.

## 3. Closed Workstreams

Reaffirmed as CLOSED from their own reports; **no regression found** and none
reopened:

```text
G-03  Hospital Admin Command Centre          PROVEN STAGING — CLOSED
G-05  Hospital Admin Audit & Compliance      PROVEN STAGING — CLOSED
G-06  Executive / Operational Reports        PROVEN STAGING — CLOSED
G-07  Staff Booking Reschedule               PROVEN STAGING — CLOSED
AUTH  App-Shell Request/Remount Loop         PROVEN STAGING — CLOSED
G-08  Global Admin Portfolio Dashboard       PROVEN STAGING — CLOSED
```

G-08 staging verification (`PHASE_7_G08_STAGING_VERIFICATION_REPORT.md`)
redeployed `executive-analytics` v7 → v8, fixed the CORS preflight
(`apikey`/`X-Client-Info`/`Vary: Origin`), passed the global-admin browser
journey with **1 portfolio + 1 benchmark + 1 bounded hospitals read**, **~182 s
idle / 0 unexpected requests**, Refresh = exactly +1 portfolio +1 benchmark,
unauthorized roles = **0** analytics calls, G-03/G-05/G-06/G-07 smoke passed,
production untouched. That the idle count is now 0 independently re-confirms the
auth-loop closure has not regressed.

## 4. Current Architecture Snapshot

The platform shape is unchanged and correct (SQL-first, thin Edge Functions over
canonical RPCs, DB-enforced tenancy, immutable ledger, atomic token engine,
append-only audit). The roadmap's four structural blockers have progressed since
the 2026-09-02 snapshot:

- **Frontend now exists** (roadmap B3 "no frontend" is superseded): the staff
  console covers reception/doctor/queue/booking + four admin surfaces
  (`/admin`, `/admin/audit`, `/admin/reports`, `/admin/portfolio`).
- **Scheduler is implemented** (roadmap B1/P0-02): migration 53 registers
  `setura_cron_minute` + `setura_cron_nightly` via `pg_cron` + `pg_net` firing
  the existing machine endpoints — **NPD-05 is effectively decided** (pg_cron +
  pg_net per roadmap §11). It is **fail-closed by construction** until Vault
  secrets + base URL are provisioned, so autonomous firing remains
  environment-blocked, not code-blocked.
- **Worker crash-recovery wiring** exists (migrations 50/51/52/53 wire the v2
  reclaim chain into `run_scheduled_tasks`), and the **financial-correctness
  wave has landed** (migration 54 `booking_fee_writer` closes the P0-04
  no-writer chain; 59 revenue-at-capture; 60 refund unification).

Remaining structural gap that matters for *this* selection: several
backend-proven read capabilities have **no reachable UI**, and the async
autonomy/production track is an **owner-decision / environment** track, not a
product-frontier slot (§11).

## 5. Current Frontend Surface

`apps/web/src`:
- `App.tsx` routes: `/login`, `/reception`(+book/walk-in/patients/notifications),
  `/queue`, `/doctor`, `/admin`, `/admin/audit`, `/admin/reports`,
  `/admin/portfolio`, `/bookings/:bookingId`. One `AppShell` layout route behind
  a role-union `RequireRole`; per-route guards are UX-only.
- `auth/`: `AuthProvider.tsx`, `RequireRole.tsx`, `context.ts`
  (`resolveStaffContext`). `components/AppShell.tsx`.
- API wrappers (`api/`): `commandCenter`, `enterpriseReports`,
  `executiveReports`, `portfolio`, `reads`, `booking`, `cancellations`,
  `reschedule`, `statuses`, `doctorOps`, `queue`.
- **Re-verified this session:** grep of `apps/web/src` for `alert-center` and
  `financial-command-center` returns **0 matches** — neither backend surface is
  reachable from the client today. `executive-analytics` is now consumed
  (G-08 `api/portfolio.ts`).
- Mutation surfaces: booking, walk-in, reschedule, cancel, queue-control,
  doctor-ops, clinical notes. Read-only surfaces: the four admin views +
  notifications/queue/patients reads.

## 6. Current Backend Surface

26 Edge Functions (inventory listed this session). Frontend-consumed:
`create-booking`, `cancel-booking`, `update-booking-status`,
`reschedule-booking`, `queue-control`, `doctor-operations`, `command-center`,
`enterprise-reports`, `executive-analytics`. Machine-only: worker, cron-minute,
cron-nightly, WhatsApp, payment/refund/settlement, rollups, SLA, monitoring,
carry-forward, queue-next.

**Implemented-but-UI-unconsumed** (re-verified by grep = 0 client call sites):

| Function | Purpose | Roles | Read/Mutate | HTTP-proven? | Staging version |
| --- | --- | --- | --- | --- | --- |
| `alert-center` | list/analytics + acknowledge/assign/resolve/escalate/suppress | hospital_admin, global_admin | **both** | **YES** (`enterprise_command_center.test.ts:1417` ack audited + cross-tenant 403) | v7 (2026-09-20) |
| `financial-command-center` | overview / forecast / reconciliation | hospital_admin, global_admin | **read-only** | **NO** (grep `"financial-command-center"` in `tests/` = 0) | v7 (2026-09-20) |

Both are stale v7 (predating the shared CORS fix now in
`_shared/cors.ts:20-31`), which is exactly the G-08 blocker class — see §8/§9.

## 7. Current Database / RPC Surface

- **Finance:** `get_financial_command_center(UUID, DATE)`,
  `get_revenue_forecast(UUID, DATE)`, `get_reconciliation_summary(UUID,DATE,DATE)`
  — defined migration 47, hardened/`CREATE OR REPLACE`d in 48/49, all
  **`REVOKE … FROM PUBLIC, anon, authenticated; GRANT EXECUTE … TO
  service_role`** (`48_privilege_hardening.sql:579-599`). They are
  **server-authoritative aggregates** over the immutable ledger / daily
  collection entries / settlements / refunds; the client cannot call them
  directly (PostgREST-denied) — only via the service-role Edge Function, which
  enforces role + `X-Hospital-ID`. SQL-direct proven
  (`enterprise_command_center.test.ts:727-780`) and privilege-census proven
  (`privilege_isolation.test.ts:743-921`). Money-derivation cluster the roadmap
  flagged (P0-04 / partial-refund / revenue recognition) has since been
  materially addressed by migrations 54/59/60.
- **Alerts:** `fire_alert` (24), `fire_managed_alert` / suppression wrapper +
  `resolve_alert` + activity log (47), `evaluate_queue_health` (45).
  `evaluate_queue_health` **is** invoked from `run-cron-minute/index.ts:319`
  (`evaluateQueueHealth`) — organic alert *generation* is wired, but only fires
  when the minute scheduler actually runs, which is currently gated behind
  unprovisioned Vault secrets.
- **Doctor schedule/leave:** `doctor_schedules`/`_blocks`/`doctor_leaves`/
  `doctor_availability_overrides` (mig 03), enhanced in mig 31 with
  `doctor_hospital_holidays`, `is_doctor_available`,
  `get_doctor_availability_reason`, `get_doctor_unavailable_dates` (read RPCs,
  `GRANT … TO authenticated`). RLS manage policies allow
  `doctor_leaves_manage` / `doctor_sched_manage` writes by
  `hospital_admin`/`global_admin`/owning doctor **directly against the table** —
  there is **no Edge-Function/RPC write path, so no audit event, no idempotency,
  and no approval state machine** for leave. Migration 31 has zero
  request/approve/deny/record write functions (grep = 0).
- Migrations 55 (token-capacity daily sum), 61–63 (staff doctor-directory /
  consultation-note read grants) are recent read-side additive changes.

## 8. Candidate A — Alert Triage

Backend is the strongest of the unexposed surfaces: `alert-center` is
**HTTP-integration-proven** for read + the acknowledge mutation + cross-tenant
denial + audit landing, and its RPCs already enforce state transitions and
activity-log writes server-side, reusing canonical primitives.

Classification: **CONFIRMED PRODUCT GAP** (frontend reachability), **plus two
load-bearing frictions**:
1. **It is a MUTATION surface** (acknowledge/assign/resolve/escalate/suppress).
   A triage UI therefore inherits idempotency, audit, and state-transition test
   obligations the read candidates do not — a materially larger, higher-risk
   boundary, and the `suppress`/`escalate` paths have thinner test coverage than
   `acknowledge`.
2. **Organic alert generation depends on the scheduler actually firing**
   (`evaluate_queue_health` via the minute tick). With Vault secrets unprovisioned
   the deployed scheduler is fail-closed/inert (roadmap "Alert center — PARTIALLY
   IMPLEMENTED: `fire_alert` has no scheduled evaluator" is now "wired but not
   autonomously firing"), so a live triage stream would be sparse — surfacing a
   triage board over a half-alive feed proves less than it appears to.
3. `alert-center` staging is **v7 stale**; its live preflight (probed §9 method)
   omits `apikey`/`X-Client-Info`, so a browser cannot reach it without an
   authorized targeted redeploy — the same class G-08 cleared for
   `executive-analytics`.

## 9. Candidate B — Finance / Collections

`financial-command-center` exposes three **read-only, server-authoritative
aggregate** actions (overview / forecast / reconciliation) gated
`resolveAuth` + `requireRole([hospital_admin, global_admin])` +
`X-Hospital-ID`, backed by `service_role`-only RPCs the client cannot call
directly. **Nothing is recomputed at the edge or in the browser** — the exact
posture §10 requires ("prefer server-authoritative aggregates; do not recommend
any financial UI that requires the frontend to calculate/reconstruct
authoritative numbers").

Classification: **CONFIRMED PRODUCT GAP (frontend reachability) +
EVIDENCE/VERIFICATION GAP (HTTP path)**. The only real gap is that the Edge
Function itself has **no HTTP-path integration test** (grep of `tests/` = 0)
even though its RPCs are SQL-direct and privilege proven; closing that evidence
gap is small and belongs to this same boundary. Its staging artifact is v7
stale → needs an authorized targeted redeploy for a browser journey, identical to
the single deployment action G-08 already established as the pattern.

## 10. Candidate C — Doctor Schedule / Leave

Read RPCs exist and are reachable in principle; there is **no UI** and the
write path is **not a governed mutation** — leave/schedule changes would be
direct table writes under RLS with **no audit event, no idempotency, no
approval state machine**, and `doctor_id = auth.uid()` self-management of
leave rows.

Classification: read = **PRODUCT GAP** (low standalone value as its own phase);
write = **CONFIRMED SECURITY/DESIGN GAP** (an unaudited, un-idempotent,
state-less mutation path that would first need a governed SECURITY DEFINER RPC
+ Edge Function + audit + concurrency design). This is the **least contained,
highest-risk** candidate and is **not ready** for a frontend-only phase; a UI
over an ungoverned mutation path is explicitly disallowed by §9/§13.

## 11. Candidate D — Production Readiness / Autonomy

Scheduler code + worker-recovery wiring now exist (migrations 50–53); what
remains is (a) **provisioning Vault secrets + base URL** so the registered
schedules stop being a no-op, (b) a **production Supabase project**, and (c)
D5 backup/PITR and D13 domain. Per `PHASE_7_PART_5A_...`: **D5 = DEFERRED BY
OWNER** (requirement preserved, implementation deferred), D13 = DEFERRED BY
OWNER, and production gates B/C/D/E were explicitly **held by the owner**.

Classification: **INTENTIONALLY DEFERRED OWNER DECISION + ENVIRONMENT BLOCKER**.
NPD-05 is decided (pg_cron+pg_net). §7/§13 of the brief forbid converting an
intentional deferral or a no-deployment environment state into the next product
workstream; and the roadmap sequences this as its own gate chain (W1 →
autonomy), not a client-layer frontier slot.

## 12. Candidate E — Git / Documentation / Delivery Hygiene

`git` now works; AGENTS.md §13 ("working tree is NOT a Git repository") and the
§13 baseline command notes are **stale** relative to live state (repeatedly
noted in prior reports). Untracked evidence artifacts (reports, PNGs, `_*`
logs/scripts) accumulate at root; `fmt:check` fails only on root markdown
(cosmetic). None breaks a journey.

Classification: **DELIVERY/DOCUMENTATION DEBT**. Per brief §4/§6, documentation
debt must not be auto-elevated above a real product gap. Recorded, not selected.

## 13. Candidate F — Auth / Runtime Regression

Auth-loop is CLOSED; G-08's staging run independently re-measured ~182 s idle
with **0 unexpected requests**. The prior "proactive token refresh not induced
in the browser run" is not a regression — the closed defect was the
auth-event→forced-remount amplifier, whose proof is the gone-477→533 signature.

Classification: **no concrete regression discovered → NOT REOPENED**.

## 14. Newly Discovered Candidates

- **Deployment-freshness / CORS pattern:** `alert-center` and
  `financial-command-center` staging are v7 and their live preflight omits
  `apikey`/`X-Client-Info` (probed this session), the same G-08 blocker class.
  This is an **environment/deployment** precondition that travels *with*
  whichever read surface is chosen, **not a standalone workstream** — and it is
  resolved by the identical one authorized `functions deploy` action G-08
  already established.
- **Backend capabilities with no reachable UI:** `financial-command-center`
  (all 3 reads), `alert-center` (whole surface). Covered as §8/§9.
- **Frontend routes with no backend support:** none found. **RPCs/Edge Functions
  with zero callers:** `run_scheduled_tasks`'s v1 `reclaim_stale_jobs` remnants,
  the retention stub, and `create_partition` orphan remain roadmap-register items
  (P2-11/P2-13) — recorded, not a new selection. **No new product/runtime defect**
  more valuable than §9 was discovered.

## 15. Candidate Classification

| Candidate | Classification |
| --- | --- |
| A — Alert Triage | CONFIRMED PRODUCT GAP (+ mutation-scope and scheduler dependency) |
| B — Finance / Collections | CONFIRMED PRODUCT GAP + EVIDENCE/VERIFICATION GAP |
| C — Doctor Schedule read | PRODUCT GAP (low standalone value) |
| C — Doctor Schedule write | CONFIRMED SECURITY/DESIGN GAP |
| D — Production / Autonomy | INTENTIONALLY DEFERRED OWNER DECISION + ENVIRONMENT BLOCKER |
| E — Git / Doc hygiene | DELIVERY/DOCUMENTATION DEBT |
| F — Auth / Runtime | NOT A REGRESSION (closed) |
| CORS/deploy freshness | ENVIRONMENT precondition (travels with B/A, not standalone) |

## 16. Evidence Comparison

Descriptive on the documented criteria; no scores.

| Dimension | Finance read (B) | Alert triage (A) | Doctor schedule (C) | Autonomy (D) | Hygiene (E) |
| --- | --- | --- | --- | --- | --- |
| Currently broken vs missing | missing (unused) | missing (unused) | missing / **ungoverned write** | wired, decision/env-gated | stale docs |
| Backend readiness | **aggregates proven + service_role-gated; no client money math** | HTTP-proven incl. mutations | read ready; **write unaudited** | code present; firing needs Vault | N/A |
| Security readiness | **highest** — pure read, least-privilege RPCs | medium — opens a mutation surface | **lowest** — needs new governed write path | needs secret provisioning | N/A |
| Scope containment | **frontend route + 1 HTTP test** | frontend + mutation idempotency/audit tests | frontend + security/RPC design | infra/provisioning | doc edits |
| Business relevance | high — first finance/collections visibility | high once alerts stream is alive | medium (read) / high (write) | operational autonomy | reproducibility |
| Runtime provability | **read-only staging journey (safe, G-08 pattern)** | staging journey + mutation fixtures | needs write fixtures + denial proof | needs 24 h unattended + prod | N/A |
| Dependencies | one authorized redeploy (precedent set) | redeploy + live alert feed (scheduler) | audit/RPC design (new path) | **owner decision + env** | none |

Finance-read is the only candidate that is simultaneously **read-only (§10-safe,
no mutation risk), backend-proven at the SQL layer, security-complete (the RPCs
are already `service_role`-only and tenant-gated), scope-contained (frontend +
one HTTP-path test), runtime-provable via the exact read-only browser pattern
G-08 already executed, and unblocked except for a single authorized redeploy
whose precedent is established.** Alert triage is close but opens a **mutation**
surface and partly depends on an autonomously-firing scheduler; Doctor-schedule
write is an ungoverned **security gap** not ready for a frontend phase; Autonomy
is an **owner-deferral/environment** track the brief forbids auto-selecting;
Hygiene is documentation debt.

## 17. Selected Next Workstream

**Candidate B — Finance / Collections Read Surface** (a read-only hospital-admin
financial command-centre view over `financial-command-center`), preceded inside
the same boundary by closing the function's HTTP-path evidence gap.

## 18. Why It Is the Correct Next Boundary

- It fills a genuine, currently-unreachable product capability (SETURA's money
  story — daily collections, settlement aging/velocity, reconciliation, revenue
  forecast — has **no UI anywhere**), without adding any new backend business
  logic: it reuses already-proven canonical aggregates (§6 architecture rule).
- It is the **safest surface to expose** (§10): everything is a
  server-authoritative aggregate; the frontend renders numbers it cannot
  reconstruct, and the RPCs are `service_role`-only so the browser cannot even
  attempt a direct read. This is the opposite of the money-mutation risk that
  makes Doctor-schedule-write premature.
- It is **containable and provable**: frontend route + one integration test +
  one authorized redeploy + a **read-only** staging browser journey — the exact
  G-08 template — with zero RLS/grant/SECDEF/ledger change.
- It is **dependency-ready**: unlike Alert triage it does not wait on an
  autonomously-firing scheduler, and unlike Autonomy it requires no unmade owner
  decision or production infrastructure.
- It does **not** reopen closed work, bypass security, or require production.

## 19. Exact Existing Files / Functions / RPCs

- Backend: `supabase/functions/financial-command-center/index.ts` (3 actions,
  `resolveAuth` + `requireRole([hospital_admin, global_admin])`,
  `getServiceClient` RPC pass-throughs).
- RPCs: `get_financial_command_center(UUID, DATE)`, `get_revenue_forecast(UUID,
  DATE)`, `get_reconciliation_summary(UUID,DATE,DATE)` — `47` define, `48:579-599`
  grant (service_role-only), `49` re-signature fixes.
- Proven tests to extend: `tests/integration/enterprise_command_center.test.ts`
  (SQL-direct finance asserts at `:727-780`); `privilege_isolation.test.ts:743-921`.
- Frontend to add: `apps/web/src/api/financial.ts` (mirror `api/portfolio.ts` /
  `api/executiveReports.ts` pattern via `lib/api.ts:callFunction` +
  `X-Hospital-ID`), a new route `apps/web/src/routes/AdminFinancial.tsx`, a
  `RequireRole([ADMIN_ROLES])` `/admin/…` entry in `App.tsx`, an `AppShell`
  nav item, and types in `apps/web/src/types/api.ts`.

## 20. Proposed Implementation Boundary

```text
frontend:   new api/financial.ts wrapper; read-only admin route + nav + guard;
            render the three server-authoritative aggregate actions.
backend:    NO source change. ADD one HTTP-path integration test exercising
            financial-command-center over real HTTP (role gate, tenant header
            enforcement/matrix, each action's success shape) — closes the
            evidence gap without touching the function.
database:   NONE. No migration, no RLS, no grant, no SECURITY DEFINER change
            (the RPCs are already service_role-only and proven).
deployment: exactly one authorized targeted redeploy of financial-command-center
            (v7 → current) for the staging browser journey — the G-08 pattern.
            Not automatic; owner-authorized.
tests:      the new HTTP test + full frontend vitest (sequential) + existing
            integration suites untouched-and-green as regression.
```

## 21. Security Requirements

- Preserve server-side `resolveAuth` + `requireRole([hospital_admin,
  global_admin])`; the client guard is UX-only and must not be treated as
  authoritative.
- Never trust a client-supplied hospital ID: keep the `X-Hospital-ID` →
  RPC `p_hospital_id` flow that the backend already enforces; no cross-tenant
  read path introduced.
- Keep the three RPCs `service_role`-only (do NOT grant `authenticated`/`anon`).
- No client-side financial arithmetic or reconstruction — render only the
  returned aggregates (§10).
- Read-only: no mutations, so no new audit/idempotency obligation; do not widen
  the surface to settlement/refund writes.

## 22. Testing Requirements

- New integration test: `financial-command-center` over real HTTP — assert
  `hospital_admin`/`global_admin` success per action, `receptionist`/`doctor`
  **403 FORBIDDEN**, missing `X-Hospital-ID` **422**, anonymous **401**, and a
  cross-hospital read returns only the caller's tenant (or is denied).
- Frontend unit tests for `api/financial.ts` (fixtures mirroring `api/reads.fixtures.ts`)
  and the route's render/empty/error states.
- Run the full `apps/web` vitest suite; keep existing integration suites green.
- **No** weakening/deleting of any existing assertion; **no** mocking of the
  real stack to avoid runtime work.

## 23. Runtime Verification Requirements

- Local: fresh `validate:migrations` (0 errors, 4 pre-existing duplicate-object
  warnings expected), `lint`, `check`, unit; the new finance HTTP test against
  the **real local stack with Edge Runtime verified actually running** (not exit
  code — F16-01).
- Confirm the client can only reach the aggregates via the Edge Function and
  that PostgREST-direct RPC calls remain denied (42501), reusing Gate 2 posture.

## 24. Staging Requirements

- One owner-authorized targeted redeploy of `financial-command-center` (v7 →
  current source) to `setura-staging` — nothing else; no mass redeploy; no
  production.
- Read-only browser journey on `https://setura-delta.vercel.app`: hospital_admin
  sees real overview/forecast/reconciliation; receptionist/doctor reach 0
  finance calls and are guard-redirected; clean initial fan-out; idle network
  count bounded (~0) proving no auth-loop regression; console clean; G-03/G-05/
  G-06/G-07/G-08 one-action smoke as regression guard.

## 25. Dependencies / Blockers

- **Only real dependency:** the single authorized targeted redeploy (precedent
  and CLI path established by G-08). Not a code blocker.
- No NPD decision required (unlike Autonomy); no scheduler firing required
  (unlike Alert triage); no new write path required (unlike Doctor-schedule).
- Money-derivation correctness is materially addressed by migrations 54/59/60;
  this surface only *reads* those aggregates and does not depend on further
  financial-decision work to be provable.

## 26. Explicitly Deferred Work

- Production Supabase project / secrets / domain (D13) / backup-PITR (D5) /
  autonomous scheduler firing (Vault provisioning) — owner-held.
- Alert-triage UI (awaits a live autonomous alert feed and a mutation-test
  boundary), Doctor schedule/leave write (needs a governed audit/state-machine
  RPC first), Git/doc hygiene sweep, `x-error-code` header-null polish.
- Any ledger/DCE/settlement *write* or financial-mutation surface.

## 27. Risks

- Surfacing financial numbers invites assumptions about their correctness;
  mitigate by rendering only the proven server aggregates and citing the
  migration 54/59/60 basis in the report, never claiming production correctness
  from staging (§5/§10).
- The stale v7 artifact means the staging journey is blocked until the one
  authorized redeploy — treat the redeploy as an explicit owner gate, not an
  automatic action (G-08 §3 STOP precedent).
- If the new HTTP test reveals an undiscovered auth/tenant defect in the
  function, that is a CONFIRMED RUNTIME DEFECT that must be fixed in a backend
  phase *before* the UI ships — the investigation would return for
  re-authorization rather than paper over it.

## 28. Final Recommendation

```text
NEXT WORKSTREAM:
Finance / Collections Read Surface — a read-only hospital-admin financial
command-centre view (overview / forecast / reconciliation) over the existing
financial-command-center Edge Function, preceded within the same boundary by an
HTTP-path integration test for that function.

TYPE:
PRODUCT GAP (frontend reachability) + EVIDENCE/VERIFICATION GAP (missing
HTTP-path test of financial-command-center).

CURRENT STATE:
financial-command-center is implemented and gated (resolveAuth +
requireRole([hospital_admin, global_admin]) + X-Hospital-ID), backed by three
service_role-only, tenant-parameterized, server-authoritative aggregate RPCs
(get_financial_command_center / get_revenue_forecast / get_reconciliation_summary)
proven SQL-direct and by privilege census; the money-derivation cluster the
roadmap flagged is materially addressed by migrations 54/59/60. Nothing is
recomputed at the edge or client. Staging artifact is stale v7 (0 UI call sites;
grep apps/web = 0; grep tests "financial-command-center" = 0).

MISSING:
A reachable read-only admin UI for the surface, and an HTTP-path integration
test proving the Edge Function's own auth/role/tenant boundary end to end.

WHY NOW:
It is the only unresolved candidate that is simultaneously read-only (safest
per §10 — no mutation, no client money math), backend-proven, security-complete
(service_role-only tenant-gated RPCs), scope-contained (frontend + one test +
one precedent redeploy), and runtime-provable via the exact read-only staging
browser pattern just certified in G-08 — with no owner decision, no scheduler
firing, and no new write path as a precondition. Alert triage opens a mutation
surface and needs a live alert feed; Doctor-schedule-write is an ungoverned
security gap; Autonomy is an owner-deferral/environment track the brief forbids
auto-selecting; Hygiene is documentation debt.

IMPLEMENTATION BOUNDARY:
Frontend (new api wrapper + read-only route + guard + nav) + one backend
integration test. NO migration/RLS/grant/SECDEF/ledger change. One
owner-authorized targeted redeploy of financial-command-center for staging.

SECURITY BOUNDARY:
Server-side role + tenant enforcement stays authoritative; keep RPCs
service_role-only and never client-reachable directly; render only the returned
server-authoritative aggregates (no client financial reconstruction); read-only
(no mutation/audit/idempotency surface introduced); defense-in-depth RLS +
tenant check unchanged.

LOCAL VERIFICATION:
REQUIRED — real local stack with Edge Runtime confirmed actually running;
new finance HTTP test + full frontend vitest + static gates; existing
integration suites green as regression.

STAGING VERIFICATION:
REQUIRED — after the single authorized redeploy, a read-only browser journey
(hospital_admin sees real data; receptionist/doctor issue 0 finance calls and
are redirected; bounded idle network count proving no auth-loop regression;
console clean; G-03/05/06/07/08 one-action smoke).

PRODUCTION:
NOT IN SCOPE

STATUS:
READY FOR IMPLEMENTATION
```

```text
G-03  = PROVEN STAGING — CLOSED
G-05  = PROVEN STAGING — CLOSED
G-06  = PROVEN STAGING — CLOSED
G-07  = PROVEN STAGING — CLOSED
AUTH LOOP = PROVEN STAGING — CLOSED
G-08  = PROVEN STAGING — CLOSED
→ ONE next unresolved workstream selected: Finance / Collections Read Surface.
```

**READ → VERIFY → CLASSIFY → COMPARE → SELECT ONE → STOP.**
INVESTIGATION STATUS: COMPLETE — STOP. Read-only investigation; the only file
written is this report.
