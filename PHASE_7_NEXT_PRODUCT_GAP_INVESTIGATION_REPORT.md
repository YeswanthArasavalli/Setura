# SETURA — PHASE 7: NEXT PRODUCT GAP INVESTIGATION
## Fresh Source-First Product Capability Audit After C1 Closure

**Phase:** 7 — Next Product Gap Investigation (INVESTIGATION ONLY)
**Date:** 2026-09-28
**Status:** COMPLETE — no source, SQL, migration, RLS, Edge Function, test, deployment, commit or push performed.
**Supersedes:** the previous content of this file (24-09-2026, baseline `037bcf1`), whose selected candidate — the booking cancellation control surface (C1) — has since been implemented at `a9aa774` and closed. That report's git baseline and selection are **STALE / RESOLVED**; this is a fresh investigation against `a9aa774`.

---

## 1. Executive Summary

C1 (booking cancellation) is CLOSED and is not reopened by this report. A fresh
source-first census of the current frontend (9 routes), the current backend
(26 Edge Functions, 63 migrations) and the live staging schema found one
staff-facing workflow whose **entire backend already exists, is integration-proven
over real HTTP, needs zero new SQL/RPC/RLS/SECURITY DEFINER, and has zero UI**:

> **Reception-side booking-status closure: check-in and no-show marking via the
> existing `update-booking-status` Edge Function (frontend-only).**

Today `QueueBoard` exposes queue actions (`call`, `skip`, `restore`,
`mark_absent`) and `BookingDetail` exposes cancellation, but a receptionist has
no way to check a patient in from the booking surface, and **no way at all** to
mark a future-dated `booked` appointment as `no_show` — `mark_absent` only works
on rows of a live same-day queue session. The `booked → no_show` transition is
supported by the canonical state machine, is already exercised by integration
tests over real HTTP, feeds four downstream systems (analytics, rollups,
operational SLA monitoring, enterprise command centre), and is the only
no-show writer outside the queue path.

The investigation also surfaced **one new objective defect** (§6, G-01): the
`reschedule-booking` Edge Function writes `bookings.rescheduled_at` /
`rescheduled_by`, and **neither column exists in the local schema nor in live
staging** (both verified by direct SELECT-only catalog queries). The HTTP
reschedule path therefore cannot currently succeed; reschedule is eliminated as
a candidate (backend not ready) and recorded for a follow-up phase.

**NEXT SELECTED PRODUCT GAP: booking-status closure surface (check-in +
no-show) on `update-booking-status` — FRONTEND-ONLY.**

---

## 2. Investigation Scope

Read-only, per task rules. Performed:

- Git branch/HEAD/origin/status, migration count, `validate:migrations`
  (read-only task), linked-project metadata, Vercel deployment listing
- Current frontend source (`apps/web/src`: routes, api, lib, App.tsx, nav)
- Current backend source (`supabase/functions`: 26 functions, `_shared` state
  machine, queue runtime), migration census (RLS policies, grants, RPCs)
- Integration/unit test census (`tests/`)
- Live **local** runtime reads via `docker exec … psql` (SELECT-only)
- Live **staging** reads via `supabase db query --linked` (SELECT-only, two
  queries)

Not performed (mutation-forbidden): any booking/status/payment/queue/worker/
notification action; no staging data was touched.

---

## 3. Baseline Reconciliation

| Check | Expected (task) | Verified | Classification |
| --- | --- | --- | --- |
| Branch | main | `main` | PROVEN |
| HEAD / origin/main | `a9aa774f4620…d2b1` | both equal `a9aa774f4620b45541ccc18dce4f31d92e82d2b1` | PROVEN |
| HEAD subject | "feat: add booking cancellation control surface" | exact match | PROVEN |
| Tracked working-tree changes | — | 0 modified tracked files; 15 untracked (phase reports, screenshots, `c1_cancel_pre_state.json`) | PROVEN |
| Migrations | — | 63 files; `validate:migrations` → 0 errors, the 4 known pre-existing `[duplicate-objects]` warnings | PROVEN |
| Linked Supabase project | `setura-staging` / `gzcqasntcbqqmgsoikms` | `.temp/linked-project.json` matches; two live SELECT-only queries succeeded against the linked remote | PROVEN |
| Staging backend | `https://gzcqasntcbqqmgsoikms.supabase.co` | reachable via CLI login-role (queries returned rows) | PROVEN |
| Vercel project | `setura` | `.vercel/project.json` → project `setura`, org `team_xQHrRH4w4Z56xJ6PBuXOficc` | IMPLEMENTED (metadata) |
| Current frontend deployment | alias `setura-delta.vercel.app` | `vercel ls setura` listed Production deployments, newest **Ready** ~3d old — but resolved under the **personal** scope `yeswantharasavallis-projects/setura`, not the team id in `project.json`. Alias itself not re-resolved this session. | UNPROVEN (scope mismatch noted; deployment freshness corroborated) |
| Local stack | — | running (11 containers up; `supabase_vector_setura` restarting — not used here) | PROVEN |
| Production | none | none claimed; untouched | NOT TOUCHED |
| Previous report baseline | — | `037bcf1` (24-09), selection since implemented and closed | STALE / RESOLVED |

Mismatch recorded (not silently reconciled): the Vercel scope discrepancy above.
It does not affect any gap conclusion.

---

## 4. Current Frontend Capability Map

Rebuilt from `src/App.tsx`, `src/routes/`, `src/api/`, `src/components/` —
not from any older inventory.

| Route | Roles | Reads | Mutations | Backend dependency | Tests |
| --- | --- | --- | --- | --- | --- |
| `/login` | public | — | auth | Supabase Auth | — |
| `/reception` | receptionist, hospital_admin | today's bookings, status counts, waiting list, current token | **none** | `reads.ts` (PostgREST) | unit (`reads.test.ts`) |
| `/reception/book` | receptionist, hospital_admin | doctors, patients | create booking | `create-booking` | component + integration |
| `/reception/walk-in` | receptionist, hospital_admin | as above | create walk-in | `create-booking` | integration (E1) |
| `/reception/patients` | receptionist, hospital_admin | patient search/history | none | `reads.ts` | unit |
| `/reception/notifications` | receptionist, hospital_admin | delivery status | none | `reads.ts` | `Notifications.test.tsx` |
| `/queue` | receptionist, hospital_admin | queue snapshot | `call`, `skip`, `restore`, `mark_absent` | `queue-control` | `reads`/integration |
| `/doctor` | doctor, hospital_admin | dashboard, session | start/end session, break/resume, call_next, notes, diagnosis, complete | `doctor-operations` | integration (E1) |
| `/bookings/:bookingId` | any shell role | booking, payment flags, cancellation fields | **cancel only** (reception roles; reason + refund opt-in) | `cancel-booking` | `BookingDetail.test.tsx`, `cancellations.test.ts`, staging (C1) |

Structural facts verified this session:

- Frontend calls exactly four Edge Functions: `create-booking`, `queue-control`,
  `doctor-operations`, `cancel-booking` (`src/api/*.ts` grep).
- **Zero direct client table writes** in `apps/web/src`
  (`.insert/.update/.delete/.upsert` grep: 0 matches). All mutation posture is
  Edge-Function-mediated — relevant to candidate G-03 below.
- No admin/settings, finance, reporting, audit, schedule/leave or staff-
  management route exists in `App.tsx`.

---

## 5. Backend Capability Census

26 Edge Functions exist. Consumed by frontend: 4. The rest are backend-only or
system paths. Capability map (rows required by the task):

| Backend capability | Exists | Auth boundary | Tested | Frontend exposed | Staging proven |
| --- | --- | --- | --- | --- | --- |
| Booking creation | `create-booking`, `create_booking` RPC | resolveAuth+requireRole | integration | yes | yes (prior phases) |
| Cancellation | `cancel-booking` | receptionist/admin roles | integration + staging (C1) | yes | PROVEN STAGING |
| Rescheduling | `reschedule-booking` + WhatsApp engine path | receptionist/admin roles | engine-only | **no** | **see G-01 — HTTP path statically FAILS (missing columns)** |
| No-show (queue) | `queue-control mark_absent → mark_patient_absent` (`43_queue_runtime.sql:558`) | reception roles | integration | yes (QueueBoard button) | partial (UI closed list) |
| No-show / check-in / status closure (non-queue) | `update-booking-status` full state machine | receptionist+admin+doctor(restricted) | **integration over real HTTP** (E1 06; S1 05/S1 ownership 403s) | **no** | NOT TESTED |
| Queue control | `queue-control` | reception roles | integration | yes | yes |
| Doctor operations | `doctor-operations` | doctor roles | integration | yes | yes |
| Consultation | doctor-operations + RPCs | doctor roles | integration | yes | yes |
| Clinical notes | notes actions | doctor roles | integration | yes | closed item 11 |
| Payments | `create-payment-order`, `verify-payment` | server-verified | integration + local validation reports | read surfaces only | PROVEN LOCAL |
| Refunds | `initiate_refund` via cancel; `process-refund` | canonical engines | integration | display only | closed items 4/22 |
| Settlements | `settlement-engine` | backend | integration | **no** | NOT OBSERVED |
| Outstanding balances | financial RPC set | backend | integration | **no** | NOT OBSERVED |
| Financial ledger | `financial_ledger` RPCs | backend | integration | read badges only | PROVEN LOCAL |
| Daily collection | collection RPCs | backend | integration | **no** | NOT OBSERVED |
| Audit logs | `audit_events`, `logAuditEvent`, `write_audit_log`, `get_audit_coverage_report` | RLS | integration | **no viewer** | NOT OBSERVED |
| Notifications | notification queue + delivery status | RLS | integration | yes | closed item 16 |
| WhatsApp | engine + webhook HMAC | signature boundary | integration | delivery UI | closed item 16 |
| Doctor schedules | `doctor_schedules` (+RLS read/manage) | RLS | engine-tested | **no** | NOT OBSERVED |
| Doctor leave | `doctor_leaves`, `doctor_hospital_holidays`, availability RPCs | RLS | engine-tested | **no** | tables PROVEN STAGING (SELECT) |
| Slot availability | `is_doctor_available`, `get_doctor_availability_reason`, `get_doctor_unavailable_dates` — GRANTed to `authenticated` (`31:271-272,370-371,472-473`) | function grants | integration (WA reschedule) | consumed server-side at booking | PROVEN LOCAL |
| Fee configuration | fee snapshots + resolver | backend | integration | **no admin UI** | CASE A per fee report |
| Analytics | `executive-analytics`, rollups (`21`) | backend | integration | **no** | NOT OBSERVED |
| Alerts/SLA | `alert-center`, `compute-sla`, `no_show_rate_pct` (`24:414`) | backend | integration | **no** | NOT OBSERVED |
| Carry-forward | `carry-forward-tokens`, `carry_forwarded_from` (column present local+staging) | backend | integration | partial | PROVEN LOCAL |
| Worker controls | `run-background-worker` et al. | secrets | integration | no (by design) | closed items 1/2 |
| Hospital settings | `hospital_settings`, working hours, holidays | RLS | integration | **no UI** | NOT OBSERVED |
| Staff management | membership tables + `user_has_hospital_access` | RLS | integration | **no UI** | NOT OBSERVED |
| Role management | role model | RLS | integration | **no UI** | NOT OBSERVED |
| Reporting | `enterprise-reports`, `command-center`, `financial-command-center` | backend | integration | **no** | NOT OBSERVED |

No mutation endpoint was called.

---

## 6. RLS / Authorization Census (candidate-relevant extract)

Verified in migration source (03, 31) and function grants:

| Surface | Read policy | Manage policy | Notes |
| --- | --- | --- | --- |
| `doctor_schedules` | `doctor_sched_read` — global_admin or hospital member | `doctor_sched_manage` (FOR ALL) — admin **or owning doctor** | triggers: updated_at + hospital-immutable (`03:165-176`) |
| `doctor_leaves` | `doctor_leaves_read` — hospital member | `doctor_leaves_manage` (FOR ALL) — admin or `doctor_id = auth.uid()` | DB overlap exclusion `no_overlapping_doctor_leaves` (`03:269-270`); hospital-immutable trigger (`03:289-292`) |
| `doctor_availability_overrides` | `doctor_override_read` | `doctor_override_manage` (FOR ALL) | exercised by WA reschedule integration |
| `doctor_hospital_holidays` | `dhh_read` — hospital member | `dhh_manage` (FOR ALL) — admin only (`31:484-492`) | |
| `is_doctor_available` etc. | `REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE TO authenticated` | — | explicit REVOKE posture preserved (`31:271-272`) |
| `bookings` status closure | frontend already reads bookings under existing RLS; mutations go through `update-booking-status` (resolveAuth + `requireRole(["receptionist","hospital_admin","doctor","global_admin"])` + hospital-equality check + doctor sub-restriction) | — | no new read surface needed |

**Phase-D special class** (backend ready + RLS read exists + frontend missing +
no new SECURITY DEFINER needed): both the booking-status closure surface (G-02)
and the doctor schedule/leave read surfaces (G-03) qualify. G-03's *mutation*
half does not fit the established frontend posture (see §9).

---

## 7. Completed / Closed Areas (not reopened)

All 24 areas listed in the task baseline were treated as closed and none was
re-investigated or re-proposed. C1's controlled staging cancellation
(booking `61ac8f21-2d49-466d-b4bf-fb0cd9ac76bf`, FINAL C1 STATUS = PROVEN
STAGING) stands; the three-invocation execution-process incident is an
operational note, not a product defect, and is not counted against anything here.

---

## 8. Current Workflow Gaps (Phase E)

Receptionist: register/search ✅ · book/walk-in ✅ · see booking ✅ · cancel ✅
(C1) · see cancellation outcome ✅ · queue manage ✅ · notifications ✅ ·
payment state ✅ (read) · patient history ✅ · **reschedule ❌ (no UI, and HTTP
backend broken — G-01)** · **mark no-show outside a live same-day queue ❌** ·
**check in a patient ❌ (E1 06 proves the backend; no UI calls it)** ·
handle completed/cancelled ✅ (read).

Doctor: today's queue ✅ · call ✅ · start consultation ✅ · notes ✅ ·
diagnosis ✅ · complete ✅ · history ✅ · prior notes ✅ · **leave/unavailable
management ❌** · appointment context ✅.

Hospital admin: **operational metrics ❌ (backend exists, no UI)** ·
**collections/refunds/outstanding/settlements ❌ (read surfaces exist, no UI)** ·
**audit activity ❌ (no viewer)** · **fees ❌** · **staff ❌** · **doctors/
schedules/leave ❌** · **notification failures ✅ (delivery UI)** · incidents ❌.

Global admin: tenant inspection/audit/config/system-health — all ❌ UI
(enterprise backends exist: command-center, alert-center, monitoring).

---

## 9. Candidate Gap Inventory (Phase F)

Grouped, not ranked. Full field detail for the selected one is in §12–§16.

### Bounded / implementation-ready

**G-02 — Booking-status closure surface (check-in + no-show) — SELECTED**
- Backend: `update-booking-status` — IMPLEMENTED in full (§12 trace).
- Frontend: NOT IMPLEMENTED (zero references; `newStatus` grep: 0 hits outside tests).
- Read surface: existing `bookings` RLS + `BOOKING_SELECT`.
- Mutation surface: existing POST endpoint; replay-safe (`current === next` →
  `changed:false`, no write), concurrency-guarded (`.eq("status", current)`),
  audited (`booking_status_change`), notification-deduped
  (`wa_booking_no_show_${bookingId}`).
- Roles: receptionist/hospital_admin/global_admin drive it; doctor is
  server-restricted to `in_consultation`/`completed`, so UI hides these two
  actions for doctors.
- RLS readiness: PROVEN (integration 403/401 privilege tests S1 05 + S1
  same-tenant ownership denial asserts unchanged row).
- Financial impact: NONE — the endpoint contains no ledger/refund/payment write
  (audited source: only `enqueue_job` + `record_subscription_usage` RPCs).
- Backend changes: NO. New SQL/RPC/SECURITY DEFINER: NO. External credentials:
  NO. Frontend-only: YES.
- Why it matters: no-show is the only unclosed booking state in reception's
  daily loop; it feeds `08_analytics_engine.sql:66`, `21_analytics_rollups.sql:
  271,304`, `24_operational-monitoring_engine.sql:414` (`no_show_rate_pct`),
  `47_enterprise_command_center.sql:738,941`. Without a UI writer, every
  future-dated appointment whose patient never arrives stays `booked` forever,
  permanently skewing four reporting systems.
- Why not already closed: queue `mark_absent` (§5) requires a live same-day
  `queue_session_id` match — `mark_patient_absent` UPDATE filters
  `queue_session_id = p_queue_session_id AND status IN ('booked','checked_in',
  'waiting','called')`. Future bookings and any booking not in today's board
  have no absent affordance, and no affordance ever writes `checked_in` from
  the staff console.

### Bounded but backend-defective

**G-01 — Staff-console reschedule**
Backend Edge Function IMPLEMENTED *on paper* but **statically broken**:
`reschedule-booking/index.ts:377-382` sets `rescheduled_at`/`rescheduled_by`;
the columns exist in **neither** the local DB (catalog SELECT: only
`cancellation_reason`, `cancelled_at`, `carry_forwarded_from` present) **nor**
live staging (`supabase db query --linked`: same result). No integration test
calls this function over HTTP (test grep: the proven reschedule coverage drives
`processInboundMessage()` — a different code path). Frontend: NOT IMPLEMENTED.
Classification: backend NOT READY; a NEW DEFECT CANDIDATE is recorded (§22).
Financial impact if revived: fee snapshot carry — non-zero complexity.
Requires backend change first → eliminated by Phase-G rule 4.

### Backend-dependent / architecture-pattern

**G-03 — Doctor schedule & leave management UI (hospital_admin + doctor self)**
Tables, constraints, triggers, RLS read+manage policies and `authenticated`-
granted availability RPCs all exist (§6); all four tables PROVEN STAGING by
SELECT. Frontend: zero surface. Blocked from "frontend-only" purity: writes
would require either (a) the **first direct client-side table write** in the
app — breaking the verified "all mutations through Edge Functions +
`logAuditEvent`" posture — or (b) a new Edge Function + audit wiring;
`doctor_leaves`/`doctor_schedules` have **no audit trigger** (only
hospital-immutable), so an RLS-direct write is unaudited. Group: backend-
dependent; strongest next runner-up.

### Finance-sensitive

**G-04 — Admin finance surface (collections, outstanding, settlements, ledger,
refunds view)** — read RPCs exist and are integration-tested; requires careful
money-figure UX + grant review; larger surface than one bounded phase.

### Integration-sensitive / read-backends with no UI

**G-05 — Audit activity viewer** (admin): `audit_events` + coverage report RPC;
read-only but needs its own RLS/consumption verification.
**G-06 — Analytics / command-center / alerts dashboards** (admin/global): three
separate backend families; architecture-heavy for one phase.
**G-07 — Fee configuration admin** — financially sensitive mutations; fee
report classified current state CASE A (expected configuration).

### Deferred

Backup/DR (D5) and production domain (D13) — DEFERRED BY OWNER; nothing here
depends on them. Scheduler posture (P0-02/NPD-05) remains a design decision,
unaffected.

---

## 10. Candidate Elimination (Phase G)

| Candidate | Elimination result | Failed question(s) |
| --- | --- | --- |
| G-01 reschedule | ELIMINATED | #4 "is the backend actually ready?" — NO, missing columns proven in local **and staging** schema; HTTP path never integration-tested |
| G-03 leave/schedule mgmt | DEFERRED (not eliminated) | #6/#12 — write path needs a new mutation pattern or Edge Function + audit wiring; not safely one frontend-only phase |
| G-04 finance UI | DEFERRED | #7, #11 — money-figure UX breadth; multi-phase |
| G-05 audit viewer | DEFERRED | #5 — read-policy consumption unverified this session |
| G-06 analytics/alerts | DEFERRED | #11 — architecture-heavy |
| G-07 fee admin | DEFERRED | #7 — financial logic + policy surface |
| C1 cancellation | EXCLUDED | #1/#2 — already implemented and PROVEN STAGING; not reopened |
| Notifications/delivery, payment UX, clinical notes etc. | EXCLUDED | #1 — closed areas |
| **G-02 status closure** | **SELECTED** | passes all 12 |

---

## 11. NEXT SELECTED PRODUCT GAP

**Reception-side booking-status closure: expose `checked_in` and `no_show`
transitions (via the existing `update-booking-status` Edge Function) on the
staff console — check-in on the booking surface and no-show closure for
bookings outside a live same-day queue.**

Descriptive justification (no scoring):

1. **Real daily-workflow gap** — §8: these are the only two reception-facing
   booking states with a proven writer and no affordance. Every future no-show
   currently has no path to a terminal state.
2. **Backend is substantially implemented and integration-proven, not
   conjectured** — E1 06 drives this exact function over real HTTP with a real
   receptionist JWT and asserts the DB row; S1 05 and the same-tenant ownership
   test assert privilege denials with unchanged-row verification. Chosen over
   G-03 precisely because the *mutation* path here is already Edge-Function-
   mediated, audited and proven, matching the app's only existing posture.
3. **No new security boundary, no SQL, no RPC, no SECURITY DEFINER, no
   credentials** — contrast with G-01 (broken) and G-03 (unaudited writes).
4. **Zero financial surface** — verified absence of any ledger/refund write in
   the endpoint (§9 G-02).
5. **Bounded and symmetric with C1** — the cancellation surface just shipped
   (`cancellations.ts` + BookingDetail) is the proven template; same file set,
   same test harness, same controlled-staging validation playbook.
6. **Downstream integrity** — unmarked no-shows silently corrupt analytics,
   rollups, SLA and command-centre figures that already filter on `status =
   'no_show'` (§9 G-02).

No production dependency; locally and staging testable (staging requires a
future explicitly-authorized controlled mutation).

---

## 12. Deep Source Trace (Phase I)

Current UI → backend path, end to end:

1. **Current UI:** `ReceptionDashboard` renders `booked`/`checked_in`/`waiting`
   counts (read-only). `BookingDetail` shows info cards + the C1 cancel
   control. `QueueBoard` acts only on today's session rows.
2. **Frontend API:** nothing references `update-booking-status` (grep: 0);
   `newStatus` appears in no `src` file except test fixtures.
3. **Edge Function** `supabase/functions/update-booking-status/index.ts`:
   POST-only; `X-Hospital-ID` required; body `{ bookingId: uuid, newStatus:
   enum(checked_in|waiting|called|in_consultation|completed|cancelled|no_show|
   skipped), notes? ≤500 }` (`:58-75`); `resolveAuth` + `requireRole(receptionist,
   hospital_admin, doctor, global_admin)` (`:153-164`); booking fetch +
   hospital-equality `ForbiddenError` (`:222-229`); doctor sub-restriction to
   `in_consultation`/`completed` + own-patient check (`:235-264`).
4. **State machine:** shared `_shared/booking_state.ts` — `TERMINAL_STATES`
   (`:12-17`) and `TRANSITIONS` (`:25-41`): `booked → checked_in|cancelled|
   no_show|skipped`; `checked_in → waiting|cancelled|no_show`. Same-source
   rules as queue runtime — no competing machine.
5. **Idempotency/concurrency:** `current === next` → `200 {changed:false}` no
   write (`:266-278`); guarded `UPDATE … .eq("status", current)` →
   `ConcurrencyError` on lost race (`:338-395`).
6. **Side effects:** realtime broadcast (best-effort, `:397-414`); SLA refresh
   for `no_show` (`SLA_RELEVANT`, `:33-39,418-425`); `booking_no_show`
   WhatsApp job with dedupe key `wa_booking_no_show_${bookingId}`
   (`:427-478`); `logAuditEvent("booking_status_change", old/new status)`
   (`:534-568`); `record_subscription_usage` (`:591-597`).
7. **Financial impact:** none — no payment/refund/ledger call exists in the
   file (read in full, 643 lines).
8. **Response:** `{ bookingId, status, changed }`.

**Exists today:** all of 3–8, integration-proven over real HTTP.
**Missing:** only client plumbing + affordances at step 1–2 (types, api module,
confirmation UI, role-gated buttons, error mapping, unit tests).

**Adjacent consumed data check:** `whatsapp_templates` is empty locally (SELECT
distinct → 0 rows); the no-show enqueue is therefore a job-queue write only
locally — identical posture to the closed C1 cancellation flow ("zero actual
WhatsApp delivery"). In production the template would resolve; this is intended
behavior, recorded under §18.

---

## 13. Existing Backend Contract (would be consumed as-is)

`POST /functions/v1/update-booking-status`
Headers: Authorization (user JWT), `X-Hospital-ID`.
Body: `{ bookingId, newStatus: "checked_in" | "no_show", notes? }`.
200: `{ bookingId, status, changed }` · 400 ValidationError (invalid
transition / terminal state) · 403 ForbiddenError (cross-tenant; doctor-role
misuse) · 409 ConcurrencyError (status changed under the actor).
Error envelope per `_shared/response.ts` / `docs/ERROR_CONTRACT.md`. No
Idempotency-Key header is required by this endpoint (replay-safety is intrinsic
via `changed:false` + optimistic guard) — the UI must still avoid double-fire
UX, mirroring the C1 double-click lesson.

## 14. Missing Product Surface

- Reception cannot check in a booked patient from the booking surface
  (`checked_in` has no UI writer at all; only E1 06 integration and the
  terminal `mark_absent` filter mention it).
- Reception cannot close a future or never-arrived booking as `no_show`
  (`mark_absent` is queue-scoped; the state machine allows `booked → no_show`
  with no consumer).
- Consequently staff cannot reach a truthful daily no-show rate from the
  console, and completed days accumulate stale `booked` rows.

---

## 15. Implementation Boundary (Phase J)

IN SCOPE: an `api/statuses.ts` client module (template: `cancellations.ts`);
types in `types/api.ts`; role-gated action buttons on `BookingDetail` (+
optional `ReceptionDashboard` row affordance) for `checked_in` and `no_show`
with a confirmation step; server-error mapping (transition/tenant/concurrency);
unit tests; local browser walkthrough.

OUT OF SCOPE: reschedule (awaiting G-01 defect resolution), cancellation
(closed), queue actions, doctor-role transitions, any payment/refund surface,
`waiting`/`called` manual setting (queue owns calling), leave/schedule
management (G-03), dashboards (G-04/06).

| Question | Answer |
| --- | --- |
| Backend changes required | **NO** — "Existing backend/read surface is sufficient; implementation can remain frontend-only." |
| SQL changes required | NO |
| RLS changes required | NO |
| SECURITY DEFINER required | NO |
| External credentials required | NO |
| Financial logic required | NO |
| Production access required | NO |
| Staging mutation required | YES *for staging validation only* (one controlled check-in/no-show on a designated synthetic booking, under a future explicit authorization — the C1 pattern); the investigation itself performed none |

## 16. Acceptance Criteria (Phase K)

LOCAL (integration already PROVEN for the endpoint; UI items NOT TESTED until implementation):
- receptionist sees exactly two new actions on a `booked` booking: Check in,
  Mark no-show; doctor role sees neither.
- Check-in → row becomes `checked_in`, badge updates, success surface; repeat
  click → `changed:false` replay, no duplicate audit/notification.
- No-show on a future `booked` booking → row `no_show`, terminal: actions
  disappear; exactly one `booking_status_change` audit event; exactly one
  deduped `send_whatsapp_message` job; zero financial rows touched.
- Invalid transition (e.g. from `completed`) → ValidationError mapped to UI,
  state unchanged.
- Cross-tenant booking id → 403/401-class denial surfaced generically, row
  unchanged (mirrors S1 05).
- Concurrency (status changed between load and click) → ConcurrencyError
  message, reload, no silent overwrite.
- Unit tests: api module body/headers shape pinned (as `cancellations.test.ts`
  pins C1); action visibility matrix per status/role.

STAGING (future phase, requires explicit mutation authorization):
- One controlled check-in + one controlled no-show on designated synthetic
  bookings, SELECT-only pre/post evidence, replay demonstration, browser
  confirmation — the C1 R1 walkthrough template. Until executed: NOT TESTED.

NOT TESTED / BLOCKED by design here:
- Real WhatsApp delivery (no provider credentials; posture identical to C1) —
  NOT TESTED.
- Production — no deployment exists — UNPROVEN.

## 17. Security / Tenant Isolation

Client adds no new trust surface: actor, membership, role, hospital-equality
and the state machine are all re-enforced server-side (trace §12.3-4). The UI
must treat button visibility as UX only; `requireRole` + `ForbiddenError` are
the boundary (already integration-proven: S1 05 asserts denial **and**
unchanged row — the exact evidence class F16-05 warns 401s alone don't give).
PII exposure unchanged (same booking fields the surface already renders).
No new grants: the endpoint is an Edge Function, not a public routine, so the
F16-04 new-SECURITY-DEFINER obligation does not apply.

## 18. Financial / Integration Impact

Zero financial mutation (source-verified). No-new-money posture mirrors C1's
"financial safety: zero financial mutation, zero refund" evidence.
Notification side effect: marking `no_show` enqueues a `booking_no_show`
WhatsApp job — in production this will eventually deliver to the patient's
registered phone. That is intended product behavior but must be an explicit,
acknowledged consequence of go-live (template provisioning belongs to the
existing WhatsApp/ops checklist, not this phase). SLA/rollup figures start
becoming truthful once the writer exists; no retroactive backfill is in scope.

## 19. Local Validation Plan

`deno task test` + focused new unit tests; local stack browser walkthrough with
receptionist/doctor JWTs against seeded data; targeted reuse of
`tests/integration/hospital_core_journey.test.ts` posture (endpoint already
green — no endpoint change to re-certify). One `fmt:check` +
`validate:migrations` regression pass.

## 20. Staging Validation Plan

After implementation and explicit authorization: select two synthetic
hospital-A bookings (one future `booked` for no-show, one for check-in),
capture SELECT-only pre-state (the `c1_cancel_pre_state.json` pattern), execute
each action exactly twice (act + replay), verify status/audit/job/dedup/
financial-zero counts, browser screenshots, then close. Until then: NOT TESTED.

## 21. Non-Goals

No reschedule revival (G-01 fix is a separate defect phase), no leave/schedule
UI (G-03), no finance/analytics dashboards, no new migration/RPC/RLS, no
cancellation changes, no worker/scheduler changes, no production access, no
WhatsApp template work.

## 22. Remaining Blockers & Newly Recorded Findings

1. **NEW FINDING (proposed ID P-RESCH-01, severity PROPOSED):**
   `reschedule-booking/index.ts` writes `bookings.rescheduled_at`/
   `rescheduled_by`; columns absent from local **and live staging** schema
   (both catalog-verified this session); no HTTP integration coverage exists.
   The staff/HTTP reschedule path must therefore fail at runtime. Static
   evidence is strong but the call itself was NOT TESTED (mutation forbidden
   here). Requires its own investigation → fix phase before any reschedule UI.
2. G-03 audit posture: `doctor_leaves`/`doctor_schedules` have no value-change
   audit trigger; any future management UI needs an audited mutation design
   first.
3. Vercel scope discrepancy (§3) should be reconciled before the next staging
   frontend deploy.
4. Staging validation of the selected gap requires a future explicit mutation
   authorization; none is granted by this report.

## 23. Final Classification

| Item | Classification |
| --- | --- |
| `update-booking-status` endpoint | INTEGRATION VERIFIED (local real HTTP) · IMPLEMENTED |
| Status-closure UI surface | NOT IMPLEMENTED |
| bookings read surface | PROVEN (in use, staging C1) |
| Tenant/privilege boundary | PROVEN LOCAL (403 + unchanged-row assertions) |
| Staging proof of the gap | NOT TESTED (no mutation permitted) |
| reschedule-booking HTTP path | FAIL (static) · NOT TESTED (runtime) · schema absence PROVEN LOCAL + PROVEN STAGING |
| Production | UNPROVEN / NOT TOUCHED |

---

CURRENT BASELINE:
a9aa774f4620b45541ccc18dce4f31d92e82d2b1

NEXT SELECTED PRODUCT GAP:
Reception-side booking-status closure surface — check-in and no-show marking via the existing, integration-proven `update-booking-status` Edge Function (frontend-only)

WHY IT IS A REAL GAP:
`checked_in` and `booked → no_show` have a fully implemented, real-HTTP integration-proven backend writer (E1 06; S1 05 privilege denials) with audit, deduped notification, SLA and concurrency protections, yet no staff UI ever calls it; queue `mark_absent` only covers live same-day queue-session rows, so future-dated no-shows can never reach a terminal state, silently skewing analytics, rollups, SLA monitoring and command-centre no-show metrics.

BACKEND STATUS:
IMPLEMENTED

FRONTEND STATUS:
NOT IMPLEMENTED

RLS / AUTHORIZATION STATUS:
PROVEN

FINANCIAL IMPACT:
NONE

EXTERNAL INTEGRATION:
NONE

IMPLEMENTATION TYPE:
FRONTEND-ONLY

LOCAL VALIDATION:
NOT TESTED

STAGING VALIDATION:
NOT TESTED

PRODUCTION:
NOT TOUCHED

D5:
DEFERRED BY OWNER

D13:
DEFERRED BY OWNER

IMPLEMENTATION AUTHORIZATION:
NOT GRANTED BY THIS INVESTIGATION

COMMIT/PUSH:
NOT PERFORMED
