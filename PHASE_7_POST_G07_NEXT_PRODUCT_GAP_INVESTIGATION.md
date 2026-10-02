# SETURA — PHASE 7: POST-G-07 NEXT PRODUCT GAP INVESTIGATION
## Fresh Read-Only Discovery

**Phase:** 7 — Next Product Gap Investigation after G-07 (DISCOVERY ONLY)
**Date:** 2026-09-30
**Status:** COMPLETE — STOP. No source, SQL, migration, RLS, grant, RPC, Edge
Function, frontend, test, deployment, staging-data, secret, commit or push
performed. Read-only git inspection, current source/test/report review and
prior-gate runtime evidence only. No new browser/network probing was performed;
the defect evidence is the G-07 staging walkthrough's recorded observation
(§6), re-verified against current source.

---

## 1. Executive Summary

After G-03, G-05, G-06 and G-07 are closed, SETURA's staff console covers the
patient/reception/doctor/hospital-admin core journeys and three admin read
surfaces. The remaining unresolved items split cleanly into three kinds:

1. **A confirmed, unbounded, app-wide runtime DEFECT** — the auth-refresh /
   remount / request loop observed live on the deployed staging production
   build during the G-07 walkthrough (`/admin` alone: 477 → 533 requests in
   ~1 minute while idle). It degrades every authenticated surface, is a real
   cost/compute leak against Supabase (PostgREST reads + Edge Function POSTs),
   will be present the first day any hospital pilots the product, and is
   directly caused by the same app-shell machinery that three closed
   workstreams (G-03/G-05/G-06) all render through.
2. **Optional read-surface PRODUCT GAPS** whose backends already exist but are
   unexposed: global-admin portfolio, alert triage, finance/collections read,
   doctor schedule/leave. None breaks anything today; two of them depend on
   stale staging artifacts and one (finance) has an unfilled HTTP-test gap and
   money sensitivity.
3. **The standing autonomy blocker (roadmap B1)** — dead worker wiring and
   absent scheduler (P0-01…P0-04, P1-07). Real, but partially gated by the
   pending NPD-05 product decision and by explicitly deferred production
   infrastructure work; it is not a frontend gap and the brief forbids
   treating an intentional deferral as the next product workstream.

**Recommended next workstream: the authenticated app-shell request/remount
loop (Candidate G) — a DEFECT, root-cause-then-fix, frontend-only.** It is the
only candidate that is simultaneously *confirmed at runtime*, *unbounded*,
*app-wide*, *without a non-deferral blocker*, and *actively degrading surfaces
the product has just certified*. Full evidence, classification and the
implementation boundary are below. Investigation only — nothing implemented.

---

## 2. Baseline Verification

| Check | Verified value | Method |
| --- | --- | --- |
| Branch | `main` | `git branch --show-current` |
| HEAD | `da5332efab5583a957f645a4a5c145ec42c46c5b` | `git rev-parse HEAD` |
| HEAD subject | `Staff booking reschedule + G-06 closure` | `git log -1` |
| origin/main | `da5332e` (== HEAD) | `git log --oneline` decoration |
| Remote | `https://github.com/YeswanthArasavalli/Setura.git` | `git remote -v` |
| Working tree (source) | `git diff --stat HEAD -- supabase apps/web tests deno.json` → **empty**: no source modifications | read-only git |
| Working tree (root) | Untracked items are evidence artifacts only (G-07 report, `g07_*.png` screenshots, logs) | `git status --short` |

**Closure evidence (each verified in its own report; full audits NOT
repeated):**

```text
G-03 — Hospital Admin Command Centre      PROVEN STAGING — CLOSED
G-05 — Audit & Compliance Viewer          PROVEN STAGING — CLOSED
G-06 — Executive / Operational Reports    PROVEN STAGING — CLOSED
        (PHASE_7_G06_..._REPORT.md §: "G-06 = PROVEN STAGING — CLOSED
         (with two documented, non-G-06 findings)"; baseline a02200f)
G-07 — Staff Booking Reschedule           PROVEN STAGING — CLOSED
        (implemented at da5332e using Option B: no migration, no schema
         change; backend repaired, staging v7→v8 redeploy; admin &
         receptionist staging success, doctor denial + tenant guards
         verified; PHASE_7_G07_STAGING_AND_BROWSER_VERIFICATION_REPORT.md)
```

**Regression check of closed work:** commits after each closure are the
closures themselves (`0cb2800` → `a02200f` → `9f4a2c8` → `da5332e`); no later
change touched G-03/G-05/G-06 surfaces. The G-07 walkthrough explicitly
re-observed Command Centre rendering during its own session (§6.7) — the pages
still **work**; the defect found there is the request loop, not a functional
regression. **NO REGRESSION in G-03/G-05/G-06/G-07 functionality.**

**CONFLICT REPORTED (not silently reconciled):** AGENTS.md §13 still asserts
"the working tree is NOT a Git repository (no `.git`)". This is out of date —
git inspection succeeded fully this session (HEAD `da5332e` == origin/main).
The two prior investigations recorded the same conflict. AGENTS.md was not
modified (read-only phase).

---

## 3. Repository / Architecture State (current, verified)

- **Frontend** (`apps/web`): React 18.3 + Vite 5 + `@supabase/supabase-js`
  ^2.45.4, `react-router-dom` ^6.26.2. 11 reachable routes in `App.tsx`
  (login, reception ×5, queue, doctor, `/admin`, `/admin/audit`,
  `/admin/reports`, `/bookings/:id`). One `AppShell` layout route guarded by a
  role-union `RequireRole`; per-route `RequireRole` guards are UX-only. All
  privileged reads go through `lib/api.ts:callFunction` (user JWT +
  `X-Hospital-ID` header) or PostgREST SELECT under RLS via `api/reads.ts`;
  zero direct client table writes.
- **Backend**: 26 Edge Functions + `_shared` (inventory re-listed this
  session). Frontend-consumed: `create-booking`, `queue-control`,
  `doctor-operations`, `cancel-booking`, `update-booking-status`,
  `reschedule-booking` (new in G-07), `command-center`, `enterprise-reports`.
  Implemented-but-not-UI-consumed: `executive-analytics`, `alert-center`,
  `financial-command-center` — re-verified this session: grep of
  `apps/web/src` for those three names returns **0 call sites**.
  Machine/backend-only: worker, cron, WhatsApp, payment/refund/settlement,
  rollups, SLA, monitoring, carry-forward, queue-next.
- **SQL**: 64 migration files; doctor scheduling tables exist since
  migration 03 (`doctor_schedules`, `doctor_schedule_blocks`, `doctor_leaves`,
  `doctor_availability_overrides`) with **no UI surface** (re-verified).
  `rescheduled_at`/`rescheduled_by` remain **absent from all migrations**
  (count = 0) — consistent with the closed G-07 Option-B decision (the reschedule
  feature was deliberately built without them; this is NOT a reopened defect).

---

## 4. Hospital Workflow Coverage

| Journey | Coverage today | Remaining break points |
| --- | --- | --- |
| Patient/reception | registration → booking → check-in → token → queue → consultation → completion/cancel/no-show → **reschedule (G-07)** → notification status → payment status → history: IMPLEMENTED + REACHABLE | app-wide request churn degrades every page (G) |
| Doctor | login → console → call/skip/complete → notes: REACHABLE | own schedule/leave **read** ❌ no UI; **write** ❌ no audited path (deferred candidates) |
| Hospital admin | Command Centre, Audit, Reports: REACHABLE | loop hits `/admin` hardest (G); finance/collections read ❌; alert triage ❌ |
| Global admin | admin surfaces only render with an attached tenant; **portfolio / cross-tenant** ❌ no UI despite HTTP-proven `executive-analytics` | B + stale staging artifact |

---

## 5. Required Investigation: the Command Centre / app-shell request loop

### A. Is it reproducible?

**Reproduced once, live, on the deployed staging production build** during the
G-07 browser walkthrough: Vercel `https://setura-delta.vercel.app`
(`/assets/index-CYlPfH8B.js`, a real production bundle — not a Vite dev
server, so HMR/dev-mode is excluded as the cause). Evidence
(`PHASE_7_G07_STAGING_AND_BROWSER_VERIFICATION_REPORT.md` §6.7, §8):

```text
/admin idle page: request count 477 → 533 in ~1 minute
repeated identical GET /rest/v1/profiles
repeated identical GET /rest/v1/user_roles
repeated POST /functions/v1/command-center
  (overview · sla_dashboard · system_health · timeline · predictive)
booking-detail pages: repeated profiles / user_roles / booking /
  consultation_notes reads
"No application JS errors/exceptions" — the loop is silent, not an
exception storm.
```

Reproduction was NOT re-run in this read-only session (browser walkthrough of
staging was outside this session's permitted probes); the class of behavior is
**documented, deterministic-pattern runtime evidence** from the immediately
preceding phase. Classification below therefore rests on runtime evidence
already on record plus current-source analysis.

### B. Exact trigger — source analysis (current `da5332e` source)

Facts established from source:

1. `AdminCommandCentre.tsx:140-148` — the five `command-center` POSTs fire in
   a `useEffect` keyed on `loadAll`, itself `useCallback([hospitalId])`.
   `hospitalId` is a **string**; it cannot oscillate while the tenant is
   stable. ⇒ The repeated POSTs require the **component to remount**, not a
   dependency flip. (This also rules out polling: grep of all
   `routes/*.tsx` + `components/*.tsx` for `setInterval` / Realtime
   `.channel(` returns **0**.)
2. The only code path that issues `GET profiles` + `GET user_roles` for the
   signed-in user is `resolveStaffContext()` (`auth/context.ts:61-64`), called
   only from `AuthProvider.tsx` `load()`. ⇒ The repeated auth-pair reads prove
   `load()` is being **re-invoked**, i.e. `onAuthStateChange` is firing
   repeatedly (it is the sole subscription in the app — grep confirmed).
3. `AuthProvider.tsx:69-79` — on **every** auth event, regardless of type, the
   handler calls `setLoading(true)` then re-runs `load()`. Each cycle toggles
   `loading` true→false, which makes the outer `RequireRole` (`RequireRole.tsx:21`)
   swap its rendered output between the full `RequireRole(<AppShell/>)` tree
   and a bare `<div>Loading…</div>`. A layout route's `element` switching
   component **type** at that position unmounts and remounts the entire
   `AppShell` + `<Outlet/>` subtree — which re-triggers every load-on-mount
   effect of the current page (the five Command-Centre POSTs; the
   BookingDetail reads). This matches the observed signature exactly:
   *auth-pair GETs + page-data POSTs/GETs, no JS errors, unbounded*.
4. The driver of repeated auth events is the session-refresh posture:
   `lib/supabase.ts:21-26` (`autoRefreshToken: true`) + `lib/api.ts:30`
   (every Edge-Function call re-reads `getSession()`). A refresh emits
   `TOKEN_REFRESHED` → cycle 3 repeats. Why the events arrive at a
   multi-per-minute cadence on this deployment (token TTL/skew, multi-tab
   BroadcastChannel, storage behavior) could **not** be pinned from source
   alone — that is the one link requiring runtime instrumentation.

**Conclusion (B):** two cooperating mechanisms, one proven and one to confirm:
proven — *any* auth event force-remounts the whole authenticated tree because
`loading` is toggled inside the auth callback and `RequireRole` swaps tree
types; to-confirm — what is emitting auth events at ~1 per 5–10 s on staging.
Candidate F ("auth-refresh/remount churn") and Candidate G ("Command Centre
request/remount loop") are **the same defect observed from two surfaces**: the
event source (F) and the forced-remount amplifier (G).

### C. Scope

App-wide across authenticated surfaces, worst where mount-cost is highest:
`/admin` (5 Edge-Function POSTs per cycle), `/bookings/:id` (4 reads per
cycle) — both observed. Pages whose effects key only on stable strings
(`DoctorConsole`, `Notifications`, `QueueBoard`, `Patients`, `AdminAudit`,
`AdminReports`) remount on every cycle too (source fact 3), so they refetch on
remount even though not individually observed. Not role-specific (observed as
hospital_admin and receptionist sessions); not staging-only in principle —
local runs showed the same "known auth-refresh/remount churn" carried forward
in the brief. Deterministic in production builds (observed on the deployed
bundle).

### D. Cost

Observed: ≈56 additional network requests per minute **per idle admin tab**
(477→533). Each cycle = 2 PostgREST reads + (on `/admin`) 5 Edge Function
POSTs, where each `command-center` POST executes heavy aggregate SQL
(overview/SLA/system-health/timeline/predictive). Linear in open tabs and
idle time; also burns Edge Function invocation-seconds. A dollar estimate is
deliberately **not** given (would require pricing assumptions = fabrication
risk); the unbounded, idle-time, per-tab nature is the finding.

### E. Classification

```text
CONFIRMED DEFECT (runtime-observed on the deployed staging production build,
G-07 §6.7/§8) whose precise auth-event source is PROBABLE (auto-refresh path
of supabase-js + unconditional setLoading(true) re-load in the callback);
forced-remount amplifier CONFIRMED statically in current source.
```

Not a tooling artifact (production bundle), not environment-specific
(nothing in staging config distinguishes it), not evidence-insufficient
(request-count delta is direct observation).

---

## 6. Other Candidate Workstreams (investigated, current source)

### Global Admin Portfolio Dashboard
- State: `executive-analytics` Edge Function exists; HTTP-integration-proven
  (`enterprise_command_center.test.ts:1358-1403` per G-05 investigation,
  re-cited not re-run); **0 UI call sites** (re-verified by grep).
- Classification: **PRODUCT GAP** (frontend reachability; backend exists).
- Blockers/friction: staging artifact is one of the eight stale pre-`79b74f7`
  functions → requires a redeploy; cross-tenant surface needs a tenant-less
  global_admin fixture for browser proof (staging fixture limitations are a
  known residual). Adds a capability nobody can use today; nothing is broken
  by its absence.

### Alert Triage
- State: `alert-center` exists (list/acknowledge/assign/escalate/resolve),
  HTTP-proven for read + cross-tenant denial; **0 UI call sites**; roadmap
  notes `fire_alert` has no scheduled evaluator (B1 dependency) and P3-01
  (42501→403 mapping). Acknowledge/resolve are **mutations**.
- Classification: **PRODUCT GAP** (+ partially blocked: alert *generation*
  depends on the never-scheduled evaluator, roadmap line "Alert center —
  PARTIALLY IMPLEMENTED"). Surfacing a triage UI over an alert stream that
  nothing generates autonomously would be proving a half-system.

### Finance / Collections Read
- State: `financial-command-center` exists; **no HTTP-path integration test
  found** (grep `callFn("financial-command-center")` = 0, per G-05
  investigation, unchanged — the function is still 0-call-site in UI);
  staging artifact stale; money-sensitive surface.
- Classification: **PRODUCT GAP + EVIDENCE GAP** (HTTP path unproven).
  Financial-integrity discipline requires the evidence gap closed before (or
  with) any UI; that makes it a two-part phase, not a frontend-only one.

### Doctor Schedule / Leave
- State: tables exist since migration 03 (re-verified); no UI for read; no
  audited Edge-Function path for write.
- Classification: read = **PRODUCT GAP** (low standalone value); write =
  **PRODUCT GAP + SECURITY GAP** (unaudited mutation path). Both deferred by
  the two prior investigations for the same reasons; unchanged.

### Autonomy / execution chain (roadmap B1: P0-01…P0-04, P1-07, NPD-05)
- State: unchanged per AGENTS.md §13 baseline (worker lease-recovery dead in
  v1 and v2; no scheduler; `ENABLE_WORKER_TRIGGER=false` default; nightly
  wrong-secret coupled to the P2-09 prohibition).
- Classification: **PRODUCTION-READINESS GAP / FAILING DEFECT CLASS**, with
  an **INTENTIONAL DEFERRAL** component (production infra, NPD-05 is an
  unmade product decision). The master roadmap itself sequences this as its
  own Phases 0–2 gate chain (W1 → scheduler decision → E1) — it is not a
  "next product workstream" slot; it is a parallel, decision-gated track that
  was in place before G-03…G-07 and remains open.

### Git-hygiene / documentation debt, staging fixture limits, `x-error-code`
header null on denials
- **DOCUMENTATION/GIT-HYGIENE DEBT**, **EVIDENCE/ENV limitation**, and
  **DEFECT (minor, observability polish)** respectively. None blocks a
  journey; recorded, not selected. (The `x-error-code` observation naturally
  travels *with* whichever backend phase next touches shared response
  machinery — it is not a standalone frontend phase.)

---

## 7. Frontend/Backend Contract Checks (§8 of brief)

- Backend capabilities with no reachable frontend: `executive-analytics`
  portfolio/daily reads; `alert-center` (entire surface);
  `financial-command-center` (all three reads); `enterprise-reports.generate`
  `financial`/`settlement` types (intentionally excluded by G-06); doctor
  schedule/leave tables; worker/scheduler subsystems (B1). Listed in §6.
- Frontend capabilities with missing backend support: **none found** — G-07
  Option B removed the last known contract mismatch by eliminating the
  `rescheduled_at/by` assumptions instead of adding columns; grep confirms
  neither column exists and no UI references them.
- Unused wrappers: none material found beyond the §6 surfaces (api/ files are
  all route-consumed).

---

## 8. Evidence Matrix

| Area | Status | Evidence | Gap Type | Action |
| --- | --- | --- | --- | --- |
| G-03/05/06/07 closures | PROVEN STAGING — CLOSED | own reports; git history; §2 regression check | — | none (closed) |
| Patient/staff/doctor core journeys | IMPLEMENTED + REACHABLE | routes §3; integration suites | — | none |
| Auth/remount request loop | **FAIL at runtime** (unbounded churn) | G-07 §6.7/§8 (477→533/min, deployed bundle) + source facts §5B | **DEFECT (confirmed)** | root-cause + fix (SELECTED) |
| Global-admin portfolio | backend PROVEN, UI MISSING | 0 grep call sites; test :1358 | PRODUCT GAP | later, own phase (+redeploy) |
| Alert triage | backend PROVEN, UI MISSING, generator unscheduled | 0 call sites; roadmap B1 link | PRODUCT GAP (part-blocked) | later |
| Finance/collections read | backend HTTP-UNPROVEN, UI MISSING | 0 callFn tests; stale artifact | PRODUCT + EVIDENCE GAP (sensitive) | later, tests first |
| Doctor schedule/leave | tables exist, no UI; write unaudited | mig 03 tables re-verified | PRODUCT (+SECURITY for write) | later, gated |
| Worker/scheduler autonomy (B1) | DEAD at runtime, decision-gated | AGENTS.md §13 baseline; roadmap B1 | PRODUCTION-READINESS GAP + deferrals | separate roadmap track (NPD-05) |
| `x-error-code` header null | observed on denials | G-07 §8 | DEFECT (minor) | fold into next backend phase |
| Git/docs hygiene | AGENTS.md §13 stale | §2 conflict report | DOCUMENTATION DEBT | record; not selected |

---

## 9. Candidate Comparison (factual dimensions — no scores)

| Dimension | Request/remount loop (G/F) | Portfolio (B) | Alert triage (C) | Finance read (D) | Schedule/leave (E) | Autonomy (H) |
| --- | --- | --- | --- | --- | --- | --- |
| Type | **DEFECT (confirmed)** | Product gap | Product gap | Product+evidence gap | Product/security gap | Prod-readiness gap |
| User impact today | every authenticated user, every page, idle | nobody (capability absent, none broken) | nobody (generator unscheduled) | nobody | nobody | operational/async features |
| Correctness/safety consequence | cost leak, compute waste, pilot-day credibility | none | none | none | write path unaudited | financial/ops correctness |
| Backend readiness | N/A — frontend-only | ready but **stale artifact** | ready but stale + mutation semantics | **HTTP-unproven** | read ready / write unaudited | needs product decision NPD-05 |
| Frontend effort | small, bounded (auth shell) | one route | one route + mutation boundary | one route | one/two routes | none (not UI) |
| Dependencies | none | redeploy + global_admin fixture | scheduler (B1) for full value | test gap + redeploy | audit/RPC design | **NPD-05 decision** |
| Testing complexity | low-medium (unit + staging browser + network count) | medium | high (idempotency/audit) | medium-high | high (security) | high (gates W1/E1) |
| Blocks anything | degrades all certified admin/report surfaces | nothing | nothing | nothing | nothing | async subsystem autonomy |

The loop candidate is the only one where the product **already certified
surfaces are measurably broken in the deployed build**; every product gap adds
capability nobody is currently denied. Conversely the autonomy chain, while
severe, is a decision-gated parallel track (NPD-05) with its own roadmap
phases, and the brief prohibits converting an intentional deferral into the
next product workstream by default.

---

## 10. Recommended NEXT WORKSTREAM

```text
NEXT WORKSTREAM:
Authenticated app-shell request/remount loop — root-cause and eliminate the
unbounded auth-event → forced-remount → refetch cycle (unifies carried
Candidates F and G).

TYPE:
DEFECT (confirmed at runtime on the deployed staging production build).

WHY NOW:
It is the only unresolved item proven FAILING in the product as deployed:
G-07's staging walkthrough measured 477→533 requests in ~1 minute on an idle
/admin tab of the live Vercel production bundle, with repeated profiles /
user_roles / booking / consultation_notes reads and repeated command-center
POSTs. It degrades all three just-certified admin surfaces (G-03/G-05/G-06)
and BookingDetail simultaneously, burns Supabase compute and Edge Function
invocations per open tab per idle minute, and would be present on day one of
any hospital pilot. Source analysis shows the amplifier with certainty
(§5B): any auth event toggles loading inside AuthProvider's callback, which
swaps the layout route's element type and remounts the entire authenticated
tree. Every other candidate either adds unused capability (portfolio, alerts,
finance, schedule) or is a decision-gated deferral (scheduler/NPD-05).

CURRENT STATE:
AuthProvider subscribes once to onAuthStateChange and re-runs
resolveStaffContext on every event (any type), setting loading=true each
time; RequireRole renders a different component type while loading;
AdminCommandCentre/BookingDetail refetch everything on mount; supabase-js
autoRefreshToken is enabled; callFunction re-reads getSession() per call.
Pages function correctly — this is churn, not breakage.

MISSING:
The root cause of the high-cadence auth events on staging (token TTL/skew vs
multi-tab broadcast vs storage behavior) — requires bounded runtime
instrumentation; and correct app-shell behavior: auth events must not
force-loading the shell or remount the outlet tree when a session and staff
context already exist.

AFFECTED USERS:
All authenticated roles on all in-shell pages; observed worst on
hospital_admin (/admin) and reception (booking detail).

BACKEND READINESS:
N/A — no backend change is required or permitted. All repeated reads are
already-proven endpoints behaving correctly under abuse.

FRONTEND READINESS:
Fully localized: apps/web/src/auth/AuthProvider.tsx, auth/RequireRole.tsx,
App.tsx shell composition (and api.ts read-only if instrumentation shows a
getSession() interaction). No API/contract change; no route change.

DEPENDENCIES:
None product-side. Requires a disposable staging browser walkthrough (read-
only pages) for before/after network proof; per AGENTS.md, Edge Runtime /
staging availability checks are environment matters, not code blockers.

SECURITY CONSIDERATIONS:
The fix must NOT weaken auth: session/role re-resolution on genuine sign-in,
token refresh and role change must still occur (the backend remains the
authorization authority regardless); the shell must not render privileged
routes from a stale staff context while re-resolution is in flight — loading
gates stay, they just must not swap the tree type / must not re-trigger on
non-significant events. No RLS/grant/SECURITY DEFINER surface touched.

TESTING REQUIRED:
Unit: AuthProvider event-matrix (SIGNED_IN / TOKEN_REFRESHED /
USER_UPDATED / SIGNED_OUT → expected state transitions; staff re-resolution
only where intended); RequireRole stability (same tree while session+staff
present). Existing 235-test frontend vitest suite green (sequential).
Runtime: staging browser walkthrough measuring network request delta over a
≥60 s idle period on /admin and one booking detail — the 477→533 signature
must be gone (bounded, small idle count).

IMPLEMENTATION BOUNDARY:
MAY: apps/web/src/auth/*, App.tsx shell composition, lib/supabase.ts auth
options, targeted unit tests, read-only staging probes.
MUST NOT: any migration/SQL/RLS/grant/SECURITY DEFINER change; any Edge
Function source or redeploy (including the eight stale functions — no mass
redeploy); no backend endpoint changes; no product feature added; no G-03/
G-05/G-06/G-07 functional redesign; no production deploy; no commit/push
without explicit authorization; data mutation beyond existing fixtures.
```

### Recommended Implementation Scope (for the NEXT authorized phase — NOT this one)

```text
backend:    none.
frontend:   AuthProvider auth-event handling (gate re-load/remount churn,
            preserve real re-authorization needs), shell loading-state
            composition so an auth event never swaps the layout element type
            under an existing session, minimal read-only instrumentation to
            classify the event source (removed at phase end).
tests:      unit tests for the auth-event matrix + shell stability; run the
            full frontend vitest suite; existing integration suites
            untouched-and-green as regression.
runtime:    local prod-mode build walkthrough (npm run build && preview or
            local stack) capturing network counts before/after.
staging:    controlled browser walkthrough on setura-delta: idle ≥60 s on
            /admin and one booking detail, request-delta measurement,
            console clean, all four closed surfaces (G-03/05/06/07) still
            functionally pass a one-action smoke each (regression guard,
            NOT re-audit).
```

---

## 11. Explicitly NOT Next (investigated, not selected)

- **Global-admin portfolio dashboard** — pure capability-add; nothing is
  degraded today; needs a stale-artifact redeploy plus a tenant-less
  global_admin fixture, and it would inherit the loop defect unless the loop
  is fixed first (a new cross-tenant dashboard page would remount on every
  auth event too).
- **Alert triage UI** — its generator (`fire_alert` evaluator) depends on the
  unscheduled B1 chain; a triage surface over a half-alive alert stream
  proves less, not more.
- **Finance/collections read** — weakest evidence (no HTTP-path test of
  `financial-command-center`), stale artifact, money sensitivity; must be
  preceded by its own evidence phase.
- **Doctor schedule/leave** — read: low standalone value; write: unaudited
  security-sensitive mutation path needing its own gated design.
- **Worker/scheduler autonomy (B1)** — genuine and severe, but it is the
  roadmap's own decision-gated track (NPD-05 unmade; P1-07/P2-09 must be
  resolved as a pair; production infra intentionally deferred). Selecting it
  here would repeat the roadmap's phases, not fill the post-G-07 product gap
  slot.
- **Re-auditing G-03/G-05/G-06/G-07** — no regression found (§2); treadmill
  prohibited by brief §17.
- **Git hygiene / report-artifact debt, `x-error-code` header null** —
  documentation debt and minor observability defect; record, fold into the
  next backend-touching phase.

## 12. Known Deferred Items (intentional, not defects)

- Production project/secrets/domain/rollback infrastructure (deferred until
  real-world demand; Phase 7 PART_3+ posture).
- The eight stale staging artifacts (no mass redeploy; targeted redeploy only
  when a chosen workstream needs that function).
- Scheduler architecture choice (NPD-05) — explicit product decision, reserved.
- Financial/settlement report types in UI (excluded by G-06 design).
- Staging data-fixture enrichment (doctor/Tenant-B empty fixtures).

## 13. Risks / Unknowns

- The **precise emitter** of high-cadence auth events on staging is not
  pinned from source (multi-tab BroadcastChannel, token TTL/skew, and
  storage behavior are unexcluded). The selected workstream's first step is
  bounded instrumentation; if the emitter turns out to be a GoTrue token-TTL
  **configuration**, that config change would exceed the frontend-only
  boundary and must return for re-authorization (STOP condition).
- Reproduction was not re-performed in this read-only session; the observed
  numbers are the G-07 walkthrough's record. The static amplifier (§5B fact
  3) is certain in current source regardless.
- `executive-analytics`/`alert-center` HTTP-proof citations are inherited
  from the G-05 investigation's test references (not re-executed here); they
  only support the "backend ready" column, not the selection.
- Local-stack runtime probes (docker, edge functions) were not needed and not
  performed this session; no claim of runtime state beyond cited evidence.

## 14. Final Conclusion

```text
G-03 = CLOSED · G-05 = CLOSED · G-06 = CLOSED · G-07 = CLOSED (no regression)

NEXT WORKSTREAM: Authenticated app-shell request/remount loop — root-cause
and eliminate the unbounded auth-event → forced-remount → refetch cycle.
TYPE: DEFECT (runtime-confirmed on the deployed staging production build;
amplifier statically proven in current source).
FIRST ACTION OF THAT PHASE: bounded instrumentation to identify the auth-
event emitter; THEN fix the shell so no auth event remounts a healthy
session's outlet tree; PROVE by idle-network-count before/after on staging.
NOT selected: portfolio dashboard, alert triage, finance read, doctor
schedule/leave (all capability-adds, several dependency-gated), the NPD-05
scheduler track (decision-gated deferral), and any re-audit.

READ → VERIFY → CLASSIFY → COMPARE → SELECT ONE → STOP.
INVESTIGATION STATUS: COMPLETE — STOP.
```

**Discovery only. No implementation, deployment, staging mutation, commit or
push was performed. The only file written in this phase is this required
report.**
