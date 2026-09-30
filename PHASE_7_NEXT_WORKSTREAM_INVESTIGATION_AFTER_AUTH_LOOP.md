# SETURA Hospital OS

## Post-Auth-Loop Next Workstream Investigation

**Phase:** 7 — Next Workstream Investigation after the Auth App-Shell Loop (DISCOVERY ONLY)
**Date:** 2026-09-30
**Mode:** Strictly read-only. No source, SQL, migration, test, config, deployment,
staging-data, secret, commit or push was performed. The only file written in this
phase is this required report.

---

### 1. Investigation Status

**COMPLETE.** All six carried candidates (A–F) were re-verified against current
source, current tests and the repository's own recorded runtime evidence.
Classification vocabulary per AGENTS.md §5; the brief's eight-class taxonomy
(PRODUCT GAP / BUG / SECURITY GAP / EVIDENCE GAP / PRODUCTION READINESS GAP /
INTENTIONAL DEFERRAL / DOCUMENTATION-GIT DEBT / TEST-TOOLING ARTIFACT) is applied
to every finding.

**Exactly one next workstream is selected in §10.** No implementation was done.

Runtime status for this session: the local Supabase stack was NOT started and no
browser/network probe was performed. Every runtime claim below is either (a)
re-verified static source/test/config evidence, or (b) cited from an in-repo
report and explicitly labelled *cited, not re-executed*. Items that would need
runtime proof and did not get it are marked
**NOT VERIFIED IN THIS INVESTIGATION**.

---

### 2. Repository Baseline

| Item | Verified value | Method (this session) |
| --- | --- | --- |
| Branch | `main` | `git` |
| HEAD | `da5332efab5583a957f645a4a5c145ec42c46c5b` — "Staff booking reschedule + G-06 closure" | `git rev-parse HEAD`, `git log -1` |
| origin/main | `da5332e` (== HEAD, in sync) | `git log --oneline` decoration |
| Modified (uncommitted) source | `apps/web/src/auth/AuthProvider.tsx` (+46/−11) — the CLOSED auth-loop fix | `git status --short`, `git diff --stat`, full diff read |
| Untracked | `apps/web/src/auth/AuthProvider.test.tsx`, the auth-loop implementation report, the G-07 staging report, the post-G-07 gap investigation, and `_authloop_*` / `authloop_*.png` evidence artifacts; `.vercel/`; numerous root-level `g07_*.png`, `*.log` evidence files | `git status --short` |
| Migrations | 64 files (`03` … `57+` range inspected; highest referenced: `57_phase2_scheduler_pg_net_timeout.sql`) | directory + targeted grep |
| Edge Functions | 26 + `_shared` (re-listed this session) | `Get-ChildItem supabase/functions` |
| Frontend routes | 11 reachable routes; `apps/web/src/routes/` contains 13 route modules (×3 co-located test files) | `App.tsx` read + directory listing |

**Baseline note (carried, now repo-recorded):** AGENTS.md §13's "not a Git
repository", "no scheduler", "P0-01 unfixed" and "`fmt:check` fails on 8
markdown files" snapshot statements are **stale**. `PHASE_7_PART_3C_…` §
"stale baseline" table already reconciled this: the tree IS a Git repo;
`pg_cron` 1.6.4 + `pg_net` 0.20.0 are installed with `setura_cron_minute`
firing autonomously 1040+ times **on the local stack**; P0-01 was fixed by
migration `51_p0e_claim_jobs_v2_lease_fix.sql`; `deno.json` now excludes
`**/*.md` from fmt. This investigation re-confirmed the scheduler wiring
directly in migrations 53/57 and `run-cron-minute/index.ts` (see §6 Candidate B).

---

### 3. Closed Workstreams

Per brief §1–§2; each was **not reopened**. A quick source spot-check confirmed
the closed surfaces still exist at HEAD and no later commit touched them:

```text
G-03 — Hospital Admin Command Centre        PROVEN STAGING — CLOSED
G-05 — Hospital Admin Audit & Compliance    PROVEN STAGING — CLOSED
G-06 — Executive / Operational Reports      PROVEN STAGING — CLOSED
G-07 — Staff Booking Reschedule             PROVEN STAGING — CLOSED
Auth App-Shell Request/Remount Loop         PROVEN STAGING — CLOSED
```

**Auth-loop closure evidence (re-verified this session, static part):** the
working-tree diff of `AuthProvider.tsx` matches exactly the mechanism described
in `PHASE_7_AUTH_APP_SHELL_REQUEST_LOOP_IMPLEMENTATION_REPORT.md` §3 — an
`authedUserRef` guard so same-user routine auth events update session state
without `setLoading(true)` tree teardown; fail-cleared marker on missing staff
context; stale-result guard. The runtime half (idle 0-request windows, 11/11
targeted tests, 246/246 frontend suite, staging before/after experiment) is
**cited from that report, not re-executed here**.

**One open consequence of closure (→ Candidate F):** the proven fix and its test
file are **uncommitted**; `origin/main` does not contain them even though the
deployed staging bundle does. This is a real risk asymmetry (see §6 F, §11).

---

### 4. Current Architecture Snapshot

Verified this session against current source:

- **Frontend (`apps/web/src`)**: React + Vite. All privileged reads go through
  `lib/api.ts:callFunction` (user JWT + `X-Hospital-ID` header) or PostgREST
  SELECT under RLS via `api/reads.ts`. Frontend-consumed Edge Functions:
  `create-booking`, `queue-control`, `doctor-operations`, `cancel-booking`,
  `update-booking-status`, `reschedule-booking`, `command-center`,
  `enterprise-reports`. `api/executiveReports.ts` was checked specifically
  because its name is confusable: it wraps **`enterprise-reports` generate**
  (G-06), NOT `executive-analytics`.
- **Backend with zero UI call sites (re-verified by grep this session):**
  `executive-analytics`, `alert-center`, `financial-command-center` — a combined
  pattern grep over `apps/web/src` for these three names (plus "portfolio")
  returned **0 matches**.
- **`executive-analytics` contract (read directly):** 7 actions
  (`daily_operations`, `weekly_operations`, `monthly_executive`,
  `doctor_performance`, `doctor_rankings`, `portfolio`, `benchmarks`).
  `portfolio` + `benchmarks` are `GLOBAL_ACTIONS` — rejected for non-
  `global_admin` at `index.ts:114-118`; both call tenant-free RPCs
  (`get_portfolio_dashboard`, `get_cross_hospital_benchmarks` — no
  `p_hospital_id` parameter, `index.ts:268-316`). Every action, including the
  global ones, still **requires the `X-Hospital-ID` header**
  (`index.ts:98-104`) and runs `resolveAuth(req, hospitalId)`.
  `_shared/auth.ts:206-228`: a `global_admin` (NULL-hospital role row) passes
  `resolveAuth` for ANY hospital header; `requireRole` lets `global_admin`
  through unconditionally (`:274`).
- **`financial-command-center` contract (read directly):** 3 actions
  (`overview`, `forecast`, `reconciliation`) → RPCs
  `get_financial_command_center`, `get_revenue_forecast`,
  `get_reconciliation_summary`; auth = `resolveAuth` +
  `requireRole(["hospital_admin","global_admin"])` (`index.ts:80-82`).
- **Autonomy chain:** `run-cron-minute` calls `run_scheduled_tasks` (RPC,
  `:145-156`), evaluates queue health and notifies admins of newly fired
  alerts (`:315-334`), and conditionally wakes the worker gated on
  `ENABLE_WORKER_TRIGGER` (`:379-419`). Migration 53 registers the pg_cron
  minute/nightly schedules and wires `run_worker_crash_recovery` into
  `run_scheduled_tasks` (`:292-307`), with explicit
  `REVOKE`/`GRANT service_role` on the RPC (`:317-322`) — consistent with the
  F16-04 standing obligation.
- **Doctor scheduling SQL:** tables since migration 03; migration 31 added
  leave-management columns/indexes and the read RPCs `is_doctor_available`,
  `get_doctor_availability_reason`, `get_doctor_unavailable_dates`. A grep for
  any leave/schedule **write** RPC across all migrations
  (`request|create|approve|cancel|add|set|record|submit`-prefixed functions on
  leave/schedule/absence) returned **none** — writes today would be direct
  table mutations.

---

### 5. Roadmap Status

Authority: `SETURA_FINAL_MASTER_ROADMAP.md` (2026-09-02, "AUTHORITATIVE").
`ROADMAP.md` is the superseded v1.0 plan — used for nothing here.

Reconciled against the actual post-Phase-7 record (the master roadmap's own
statuses are a snapshot it explicitly warns will move, §13 thereof):

| Master-roadmap claim | Current state (evidence) |
| --- | --- |
| §1.3 "There is no frontend" | **SUPERSEDED** — `apps/web` exists with 11 routes; Phase 6/7 reports certify G-03/05/06/07 staging-proven |
| B1 "execution chain dead" (P0-01…P0-03) | **PARTLY SUPERSEDED** — P0-01 fixed (mig 51, runtime-proven local per PART 3C); scheduler exists (migs 53/57) and fires autonomously on the local stack; **remaining**: authenticated worker-wake leg BLOCKED on Edge-runtime secrets; staging-side scheduler operation UNPROVEN |
| B3 "No frontend" blocking pilot | **RESOLVED for staff console**; admin journeys now cover Command Centre/Audit/Reports; gaps are the §6 candidates |
| B5 "never deployed" | **STILL TRUE and INTENTIONAL** — Part 5 STOPPED AT AUTHORIZATION GATE: production project creation NOT AUTHORIZED; D13 domain DEFERRED BY OWNER; D5 tier NOT PROVIDED (cited from `PHASE_7_PART_5_…` §1–§2) |
| B4 six NPD decisions | NPD-05 (scheduler/JWT boundary) effectively exercised by migs 53/57 + "all 26 `verify_jwt=true`" staging posture (cited, PART 3C §staging); others (NPD-01/02/03/04/06) remain product decisions |
| Phase 6 exit "journey through console" | Substantially met per the closed-workstream reports; the four admin read journeys in brief §9 now end at Alerts / Finance visibility, which are the §6 gaps |

**No roadmap phase was invented here; no completion percentage was computed.**

---

### 6. Candidate Workstreams

#### Candidate A — Global Admin Portfolio Dashboard

- **Current state:** Backend-only, HTTP-proven; frontend absent.
- **Frontend evidence:** 0 call sites for `executive-analytics`/`portfolio` in
  `apps/web/src` (grep this session). No route in `App.tsx`. The three admin
  surfaces (`/admin`, `/admin/audit`, `/admin/reports`) all render a truthful
  "no hospital tenant attached" state for the tenant-less staging
  `global_admin` — cited from G-06 report §A13 row
  (**STAGING PROVEN**: no-tenant state, 0 requests) and consistent with
  G-03's controlled-staging observation of the same (`PHASE_7_G03_CONTROLLED_
  STAGING_VALIDATION_REPORT.md:405`).
- **Backend evidence:** full trace: route→(absent)→`api/`(absent)→
  `executive-analytics/index.ts` (global gate `:114`) → RPCs
  `get_portfolio_dashboard` / `get_cross_hospital_benchmarks` (tenant-free, no
  `p_hospital_id`). Authorization: `resolveAuth` + `requireRole` +
  `GLOBAL_ACTIONS` check; `_shared/auth.ts` global_admin semantics verified
  directly (§4).
- **Database/RLS evidence:** RPCs are service-client-invoked inside the
  function (established pattern); portfolio aggregation is server-side —
  **zero client-side computation would be needed**. Cross-tenant exposure is
  gated at the function boundary, mirroring the proven command-center/
  enterprise-reports posture.
- **Runtime/test evidence:** HTTP integration tests exist and are precise:
  `tests/integration/enterprise_command_center.test.ts:1373-1404` — hospital_admin
  requesting `portfolio` is denied (`assertErrorCode`), `globalAdmin`
  requesting `portfolio` succeeds (`okData`), hospital-scoped `daily` succeeds
  for the tenant admin, missing header fails validation. *Cited line ranges
  read this session; the suite was not re-run.*
- **Security implications:** this is the only genuine **cross-tenant read**
  surface proposed for the UI. The server-side gate exists and is
  HTTP-proven; the UI must reuse `callFunction` (user JWT) — never the service
  role, never client-side hospital iteration.
- **Known friction (exact, new precision from this session):** the endpoint
  demands `X-Hospital-ID` even for the tenant-free global actions
  (`index.ts:98-104`), while the staging `global_admin` fixture has **no
  hospital attached** (G-03/G-06 evidence). So a naive frontend cannot call
  `portfolio` as-is. Two resolution paths, one data-only: (a) attach the
  staging global_admin fixture to a hospital (fixture mutation — the
  `resolveAuth` design explicitly permits a global_admin to pass with any
  hospital header, and the RPC ignores the header's tenant); or (b) a small
  backend change to exempt `GLOBAL_ACTIONS` from the header requirement
  (exceeds a frontend-only boundary; requires its own security + grants +
  redeploy discipline).
- **Classification:** **PRODUCT GAP** (frontend reachability; backend
  IMPLEMENTED + INTEGRATION-VERIFIED at HTTP level). The header friction is an
  implementation-phase design detail with a data-only path, not a BLOCKED state.
- **Blocking dependencies:** none hard. Staging version freshness of the
  deployed `executive-analytics` artifact: **NOT VERIFIED IN THIS
  INVESTIGATION** (PART 3C records all 26 functions ACTIVE with
  `verify_jwt=true` at staging v9; per-function source-vs-deploy equality was
  not re-measured for this function).
- **What remains:** one route + one page + one thin `api/` wrapper + unit
  tests + controlled staging fixture step (path (a)) + staging browser proof
  incl. a hospital_admin denial probe.

#### Candidate B — Alert Triage

- **Current state:** Backend implemented; read + one mutation HTTP-proven;
  generator chain newly operational **on the local stack only**; UI absent.
- **Frontend evidence:** 0 call sites (grep this session).
- **Backend evidence:** `alert-center` actions
  `list/analytics/suppress/assign/acknowledge/resolve/escalate`
  (`index.ts:43-68,192-367`). Alert *generation* path re-verified as now
  wired: `run-cron-minute` evaluates queue health, consumes `summary.new_alerts`
  and calls `notifyAdminsOfQueueAlerts` (`:315-334`); migration 53 registers
  pg_cron schedules and wires crash recovery into `run_scheduled_tasks`.
- **Database/RLS evidence:** alerts tables since the monitoring engine
  (mig 17); RPC grants follow the established service-role pattern.
- **Runtime/test evidence:** HTTP ack-audit test
  (`enterprise_command_center.test.ts:1415-1437`, cited). Scheduler autonomous
  firing (1040+ fires) + fail-closed secret gate (HTTP 403) are **local-stack**
  evidence per `PHASE_7_PART_3C_…` §1; the authenticated worker-wake leg stayed
  **BLOCKED** there (Edge-runtime secrets only settable against the linked
  staging project). Staging-side scheduler operation: **NOT VERIFIED IN THIS
  INVESTIGATION**.
- **Security implications:** acknowledge/resolve/assign/escalate/suppress are
  **mutations** — each needs idempotency, audit and tenant checks proven at
  UI-integration level; open P3-01 (42501→403 mapping) lives in this function.
- **Classification:** **PRODUCT GAP**, with an **EVIDENCE GAP** component
  (alert stream autonomy proven only locally) and a minor **BUG** component
  (P3-01) riding along. The prior "generator unscheduled" blocker has
  materially shifted: the evaluator chain now exists and runs — but only the
  local-stack proof stands.
- **Blocking dependencies:** to certify a triage surface honestly, the phase
  needs either staging-side scheduler/worker evidence (secrets posture per
  PART 3C) or an explicit scope limit to manual/mutating flows with the
  autonomy claim withheld.
- **What remains:** read UI + mutation UI + mutation-boundary tests (idempotent
  ack/re-ack, tenant isolation, audit rows) + P3-01 fix + staging evidence work.
  A materially bigger surface than A, mixing reads and writes.

#### Candidate C — Finance / Collections Read Surface

- **Current state:** Backend implemented; RPC layer SQL-proven; **HTTP edge
  path unproven**; UI absent; money-sensitive.
- **Frontend evidence:** 0 call sites (grep this session).
- **Backend evidence:** 3 actions → 3 RPCs (exact names in §4);
  `requireRole(["hospital_admin","global_admin"])`; tenant parameter is
  server-applied (`p_hospital_id: hospitalId`, `index.ts:94-176`).
- **Database/RLS evidence:** the three RPCs are exercised SQL-direct in
  `enterprise_command_center.test.ts:727-780` and appear in the locked-routine
  privilege tests (`privilege_isolation.test.ts:743,760,769,907-911` — denial
  coverage). Ledger immutability is the established PROVEN primitive.
- **Runtime/test evidence:** **no HTTP `callFn("financial-command-center")`
  test exists** (grep this session: 0 matches for
  `functions/v1/(executive-analytics|alert-center|financial-command-center)`
  beyond the two functions covered) — the function wrapper itself (CORS, auth
  header handling, error mapping) is untested over HTTP.
- **Security implications:** all money values must remain server-computed
  (they already are — thin RPC pass-throughs); no client arithmetic permitted.
- **Classification:** **PRODUCT GAP + EVIDENCE GAP** (HTTP path), in a
  financially sensitive domain.
- **Blocking dependencies:** its own evidence step (HTTP integration test)
  before or alongside any UI — a two-part phase by construction.
- **What remains:** HTTP test for the edge path → route/page/wrapper →
  staging proof.

#### Candidate D — Doctor Schedule / Leave

- **Current state:** Read backend exists; **no write backend**; no UI.
- **Frontend evidence:** no schedule/leave surface; the only
  "availability" hits in `apps/web/src` are server-side-validation prose and
  an `AdminReports` data field (`doctor_availability` array in reports).
- **Backend evidence:** tables since mig 03; mig 31 read RPCs
  (`is_doctor_available`, `get_doctor_availability_reason`,
  `get_doctor_unavailable_dates`); **no leave/schedule mutation RPC anywhere
  in 64 migrations** (§4 grep).
- **Database/RLS evidence:** tenancy columns present on the tables; write
  RLS/service-role posture would need examination only when a write path is
  designed.
- **Classification:** read = **PRODUCT GAP** (low standalone value — a doctor
  can already work today; the queue/token path checks availability
  server-side, as G-07's closed flow proves); write = **PRODUCT GAP requiring
  new canonical SQL-first design** (RPC + audit action `DOCTOR_LEAVE` already
  registered in mig 36's action-type registry + privilege grants per F16-04).
- **Blocking dependencies:** design decision + new backend primitive — not
  actionable as a frontend-only phase, unlike A/B/C.
- **What remains:** an entire backend workstream (RPCs, state machine for
  leave approval if required, grants, tests) before any honest UI.

#### Candidate E — Production Readiness / Autonomy

- **Current state:** **BLOCKED by owner authorization, intentionally.**
  `PHASE_7_PART_5_…` §1–§2 (cited): D13 domain DEFERRED BY OWNER; production
  project creation / migrations / Edge deploy / secrets / test users /
  Razorpay+Meta test credentials / SMTP all NOT AUTHORIZED → BLOCKED;
  DR targets (RPO ≤15 min, RTO ≤4 h, retention ≥30 d) recorded UNPROVEN with
  the first real backup/restore drill already executed at local level
  (≈5.35 s DB restore, per PART 3C §1 — cited).
- **Classification:** **INTENTIONAL DEFERRAL / PRODUCTION READINESS GAP**,
  not a software defect (brief §5 instruction honored). The residual software
  piece (authenticated worker-wake) is blocked on secret provisioning against
  the linked staging project — an authorization/environment matter per PART 3C.
- **Actionable now?** No: any implementation phase here requires explicit
  owner authorizations that do not currently exist.

#### Candidate F — Git / Documentation Hygiene

- **Current state (re-verified this session):** the CLOSED auth-loop fix is
  **uncommitted** (`AuthProvider.tsx` modified; `AuthProvider.test.tsx` and
  five reports untracked), while the fixed bundle is already deployed to
  staging. `origin/main` therefore does NOT build the currently deployed
  staging frontend from any committed tree state. Root is littered with
  ~100 untracked evidence artifacts (`_*.log`, `*.png`, `*.ps1`).
- **Classification:** **DOCUMENTATION / GIT DEBT** — with one genuine risk
  statement: the repo→deployed-artifact equivalence is currently broken; a
  fresh clone of `origin/main` would redeploy the REMOUNT DEFECT. That is a
  reproducibility defect of the delivery chain, even though the product code
  itself is proven.
- **Blocking dependencies:** none (a commit needs only user authorization).
- **Why it is not the selected workstream:** brief §3-F explicitly directs not
  to auto-select cleanup as a product workstream. The correct treatment is
  the **first authorized action inside the next implementation phase**
  (commit the auth-loop work as its own atomic commit before layering new
  work on top), not a phase of its own.

---

### 7. Newly Discovered Gaps

Genuine discoveries of this session, beyond the carried candidate framing:

1. **A-NEW-1 (exact contract friction, Candidate A):** `executive-analytics`
   requires `X-Hospital-ID` even for tenant-free global actions
   (`index.ts:98-104`), and the staging `global_admin` fixture has no hospital
   attached (G-03/G-06 records). The prior investigations described the A
   blocker only vaguely ("needs a fixture"); the actual blocker is this header
   check, and it has a data-only resolution path that does not touch backend
   code. Classification: implementation-phase design item (PRODUCT GAP detail),
   not a defect.
2. **B-NEW-1 (blocker shift, Candidate B):** the old "alert generator has no
   scheduled evaluator" statement is **out of date at the code level**: the
   minute chain (`run_scheduled_tasks` + queue-health → `new_alerts` → admin
   notification) exists and pg_cron fires it autonomously — proven on the
   **local** stack (cited PART 3C). Candidate B's blocker is no longer missing
   code; it is staging-side autonomy evidence. Classification: EVIDENCE GAP
   (was: PRODUCT GAP + missing mechanism).
3. **F-NEW-1 (delivery-chain reproducibility):** deployed staging ≠ any
   committed tree state (auth-loop fix uncommitted). Classification:
   DOCUMENTATION/GIT DEBT with a concrete failure mode (a redeploy from
   `origin/main` reintroduces the proven-fixed defect).
4. **Baseline staleness (already repo-recorded, re-confirmed here):** the
   AGENTS.md §13 scheduler/worker statements are superseded by
   migrations 51/53/57 + PART 3C evidence. No new action; do not re-cite the
   old baseline.

No other new defects were found. Spot-checks of closed surfaces (§3) showed no
regression signal; none of the four closed workstreams is reopened.

---

### 8. Intentionally Deferred Items

Kept strictly separate from defects (all cited from in-repo records):

```text
Production project/secrets/domain/D5 tier/D13 domain — owner-deferred (PART 5 §2)
PITR-based RPO≤15min / full RTO≤4h                   — UNPROVEN pending production infra (PART 3C §1)
Authenticated worker-wake on Edge runtime            — BLOCKED on secret provisioning (PART 3C)
Financial/settlement report types in admin Reports   — excluded by G-06 design
rescheduled_at/rescheduled_by columns                — eliminated by G-07 Option B (deliberate)
Staging data-fixture enrichment                      — standing limitation
NPD-01/02/03/04/06 product rulings                   — decision gates at their roadmap phases
```

None of these was treated as the next workstream or as a defect.

---

### 9. Evidence / Tooling Limitations

- **No runtime probing this session:** the local stack was not started; no
  browser walkthrough was performed. All runtime statements are citations to
  the closed-workstream reports and PART 3C/Part 5 reports, labelled as such.
- **Staging fixtures:** the tenant-less `global_admin` is real (G-03/G-06
  records) and is precisely why Candidate A's header friction matters; any
  Candidate-A phase needs a controlled fixture step.
- **Staging artifact freshness:** per-function deployed-vs-source equality is
  known only for the functions explicitly redeployed in recent phases
  (`reschedule-booking` v8, `process-refund` v9); `executive-analytics` and
  `alert-center` freshness is **NOT VERIFIED IN THIS INVESTIGATION** — an
  implementation phase must check (read-only) before claiming staging proof.
- **Tooling conflict carried:** AGENTS.md §13's non-Git/scheduler baseline is
  stale (three consecutive investigations now record this); this report used
  live git, not the stale snapshot.
- **Cited test line ranges were read in-source this session** (they exist and
  assert what is claimed); re-execution of the suites is out of scope for a
  read-only phase.

---

### 10. Recommended Next Workstream

```text
Recommended Next Workstream:
Global Admin Portfolio Dashboard — frontend reachability for the
HTTP-proven `executive-analytics` portfolio/benchmarks surface (Candidate A).
```

**Why now — factual dimensions only, no scores:**

- **Current implementation state:** the full trace (route absent → wrapper
  absent → function → global-admin gate → tenant-free RPCs) was verified
  end-to-end this session; the backend half is not merely present but
  **HTTP-integration-proven including the privilege denial** (§6 A).
- **User-facing value:** this is the last administrative journey in brief §9
  whose user is actively shown a dead end — the staging `global_admin` logs in
  successfully today and finds *every* admin surface truthfully empty (§6 A).
  The gap is real at the user level, not hypothetical.
- **Technical readiness:** uniquely high among the candidates — read-only
  (no mutation semantics, unlike B), HTTP-path already proven (unlike C),
  no new backend primitive needed (unlike D), no missing owner authorization
  (unlike E).
- **Security implications:** favorable, not adverse — it surfaces an existing,
  tested, server-gated cross-tenant read; it adds no write path, no RLS
  change, no grant change, no new SECURITY DEFINER function (so the F16-04
  REVOKE obligation does not even arise).
- **Evidence quality:** the candidate has the strongest existing evidence of
  the four product gaps (deny + allow HTTP assertions on exactly the actions
  the UI will call).
- **Whether it unblocks later work:** it re-exercises the app-shell through a
  fourth admin surface after the auth-loop fix (regression value), and —
  matching brief §12's "whether it is actionable now" — it converts a
  fully-built backend capability into product without touching it.
- **Whether the obvious candidate is blocked:** no. The one precise friction
  (header vs tenant-less fixture, §7 A-NEW-1) has a data-only resolution path
  already precedented by earlier controlled staging-fixture steps.

**Missing pieces (exact):** one route + guard entry in `App.tsx`; one page
component under `routes/`; one thin read-only wrapper under `api/` following
the `executiveReports.ts` precedent; resolution of the `X-Hospital-ID`
friction (fixture path (a) preferred; backend path (b) only with explicit
re-authorization); unit tests (render, deny, empty-state); staging browser
proof as a global_admin plus a hospital_admin denial probe.

**Affected users:** global_admin (primary); all other roles must provably see
nothing new.

**Frontend boundary:** `apps/web/src` — `App.tsx` route table, one new route
module + test, one new `api/` wrapper + test, nav entry gated to global_admin.
**Backend boundary:** NONE by default — `executive-analytics` and its RPCs are
consumed as-is; no function edit, no redeploy unless a read-only freshness
check proves drift (then return for authorization).
**Database boundary:** NONE — no migration, no RLS change, no grants.

**Security requirements:** user-JWT calls only (never service role); no
client-side tenant aggregation or arithmetic; hospital_admin denial for
global actions must be re-proven in-browser; tenant-scoped actions stay
tenant-scoped; no secret exposure; error surface must not leak cross-tenant
data.

**Testing requirements:** co-located vitest unit tests for wrapper + page
(allow/deny/empty/error states); full frontend suite green sequentially;
targeted `enterprise_command_center` HTTP test cited (not duplicated) as
backend proof; no weakening of any existing assertion.

**Runtime verification requirements:** local stack walkthrough (or recorded
equivalent) showing portfolio data rendered from the real endpoint; Edge
Runtime liveness checked before claiming function execution (F16-01 lesson).

**Staging acceptance requirements:** controlled walkthrough on
`setura-delta` as the global_admin fixture: `/admin/portfolio` (or agreed
path) renders real portfolio + benchmarks; a hospital_admin session shows no
nav entry and a direct visit is denied by the backend gate; idle network count
bounded (auth-loop regression guard, one smoke — NOT a re-audit); zero console
errors; fixture changes minimal, recorded, and reversible.

---

### 11. Explicitly NOT Next

- **Candidate B — Alert Triage:** now *less* blocked than before (§7 B-NEW-1)
  but still requires staging-side autonomy evidence that does not exist, plus
  five mutation flows with their own idempotency/audit proof and the P3-01
  error-mapping fix. Choosing it next would certify a triage UI over an alert
  stream whose production path is only locally proven. It is the natural
  *successor* once staging autonomy evidence exists.
- **Candidate C — Finance/Collections Read:** the HTTP edge path of
  `financial-command-center` has **zero tests** (§6 C) in a money-sensitive
  domain; the discipline is evidence-first, making it a two-part phase when
  selected. Not the most actionable today.
- **Candidate D — Doctor Schedule/Leave:** the write path has no backend at
  all (§6 D); honest implementation starts with a SQL-first design decision,
  not a frontend phase.
- **Candidate E — Production Readiness:** BLOCKED pending explicit owner
  authorizations (Part 5 gate record); it is an INTENTIONAL DEFERRAL, and the
  brief forbids selecting a deferral as a product workstream.
- **Candidate F — Git/Doc Hygiene:** not a product workstream — but its one
  genuine risk (§7 F-NEW-1) must be neutralized as the **first authorized
  commit of the next implementation phase**: land the closed auth-loop work
  (AuthProvider.tsx + its test + its report) atomically before any new
  feature commit rides on top.
- **Any re-audit of G-03/G-05/G-06/G-07/auth-loop:** no regression discovered
  (§3); prohibited by brief §1.

---

### 12. Implementation Boundary for the Next Phase

```text
MAY:
- apps/web/src/App.tsx (route table), new route module + co-located tests,
  new api/ wrapper + tests, nav gating for global_admin.
- Read-only inspection of staging function versions (executive-analytics
  freshness) before staging claims.
- One controlled staging fixture step: attach the staging global_admin test
  user to a hospital (data-only; reversible; recorded) — OR an equivalent
  documented fixture decision resolving §7 A-NEW-1 without code.
- Unit + frontend vitest suites; local prod-build walkthrough.
- Commit (with explicit authorization): first the pending auth-loop work as
  its own atomic commit, then the new feature.

MUST NOT:
- Any migration, RLS policy, grant, or SECURITY DEFINER change (F16-04
  obligation does not arise if the boundary holds).
- Any Edge Function source change or redeploy — including
  executive-analytics — without a proven freshness drift AND explicit
  re-authorization.
- Any client-side financial/tenant aggregation; any service-role usage from
  the browser; any weakening of RequireRole/RLS posture.
- Any production deploy or production secret (Part 5 gates stand).
- Any re-audit or redesign of G-03/G-05/G-06/G-07 or the auth-loop fix.
- Test deletion/weakening; bulk artifact cleanup beyond this phase's outputs.
```

---

### 13. Conclusion

SETURA's staff console is closed-loop through five certified workstreams; the
remaining landscape splits into one fully backend-proven read gap (A), one
mutation gap awaiting autonomy evidence (B), one evidence-first money gap (C),
one design-before-build gap (D), an owner-gated deferral (E), and a hygiene
risk whose correct handling is the next phase's first commit (F). The
single most important unresolved gap that can **now** be safely, concretely
implemented, tested and proven is the Global Admin Portfolio Dashboard: it
converts a proven, server-gated, HTTP-tested capability into the only product
journey whose real user currently logs in to nothing.

```text
NEXT WORKSTREAM:
Global Admin Portfolio Dashboard (frontend reachability for the
HTTP-proven executive-analytics portfolio/benchmarks surface, Candidate A;
first authorized action: atomic commit of the closed auth-loop work)

STATUS:
READY FOR IMPLEMENTATION
```

**READ → TRACE → VERIFY → CLASSIFY → COMPARE → RECOMMEND — done. No
implementation, deployment, staging mutation, commit or push was performed in
this phase.**
