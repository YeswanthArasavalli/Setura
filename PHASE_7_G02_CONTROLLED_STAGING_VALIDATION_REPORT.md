# PHASE 7 G-02 — CONTROLLED STAGING CHECK-IN + NO-SHOW VALIDATION — REPORT

Follows `PHASE_7_G02_COMMIT_STAGING_DEPLOYMENT_PREFLIGHT_REPORT.md`
(R1 SAFE TO PROCEED = YES). This phase executed the FIRST actual staging
mutation for G-02: exactly two authorized state transitions, each with one
deliberate idempotent replay, plus read-only isolation, browser and census
verification. No source, test, SQL, migration, backend, secret or production
change was made. The only file created by this phase is this report.

---

## 1. Authorization Scope

Strictly limited by spec to:

1. ONE controlled staging check-in on booking `eb701e56-0df6-4ecb-9fb5-83b81f7fae8b`
2. ONE controlled staging no-show on booking `f7918ac1-b327-40c8-b1bd-9ad06ef02968`
3. ONE deliberate idempotent replay of each

via `POST /functions/v1/update-booking-status` only. Every other mutation
category (create/cancel/reschedule/queue/token/payment/refund/fee/patient/
hospital/settings/Vault/secrets/scheduler/worker/RLS/Edge Function/deploy/
production) was forbidden and NOT performed. All forbidden-category activity
during the phase was read-only (SELECT, `secrets list` names/digests, auth
token acquisition, browser GETs).

## 2. Environment Identity

| Field | Value |
| --- | --- |
| Git | branch `main`, `HEAD == origin/main == 0ec8586b3b5b72dd4fcb06c9e5239a89103dc156` ("feat: add booking status closure controls") |
| Staging frontend | `https://setura-delta.vercel.app` (deployment `dpl_2yV1TnpSZVju51ddUguToFtGjiha`, Ready) |
| Staging Supabase | project `setura-staging`, ref `gzcqasntcbqqmgsoikms` |
| Tenant A | Surya hospital `00000000-0000-4000-8000-000000000001` |
| Actor | receptionist `reception@surya.test` (Ravi Kumar), JWT acquired via `POST /auth/v1/token` |

## 3. Execution-Time Safety Recheck

**Global BEFORE census (SELECT-only, taken before any mutation):**
bookings 14 · patients 13 · hospitals 5 · job_queue 72 · notification_queue 0 ·
audit_logs 46 · payment_orders 0 · payment_refunds 0 · financial_ledger 0 ·
daily_collection_entries 14 · queue_sessions 2.
Status census: booked 6 · completed 5 · cancelled 1 · skipped 2
(checked_in 0, no_show 0).

**Provider boundary recheck (immediately before the no-show, read-only):**
no `META_*` Edge Function secret, no `RAZORPAY_*` provider secret
(names/digests only, values never printed), `hospital_settings`
`meta_phone_number_id NULL` / `meta_waba_id NULL`, `vault.secrets` contains
only `setura_cron_secret` and `setura_scheduler_api_key`. Boundary unchanged
from preflight → safe to proceed; no real Meta credentials exist.

## 4. Booking A Fresh Pre-State

Verified immediately before mutation (not relying on earlier preflight):
`eb701e56-0df6-4ecb-9fb5-83b81f7fae8b` — status `booked`, tenant `…0001`,
synthetic patient "Conf Validation Patient 2", all financial fields at the
safety baseline: `booking_fee_inr 0.00`, `payment_completed false`, 0 payment
orders, 0 refunds, 0 ledger rows, 0 prior status-change events,
`cancelled_at NULL`. Pre-state correct → mutation authorized.

## 5. Check-In Request

`POST https://gzcqasntcbqqmgsoikms.supabase.co/functions/v1/update-booking-status`
Headers: receptionist Bearer JWT, `X-Hospital-ID: 00000000-0000-4000-8000-000000000001`,
publishable apikey. Body exactly
`{"bookingId":"eb701e56-0df6-4ecb-9fb5-83b81f7fae8b","newStatus":"checked_in"}`
— no payment/fee/hospital_id/refund/WhatsApp/note fields.

**Response: HTTP 200** · `status: checked_in` · `changed: true` ·
correlationId `bc727535…` · timestamp `2026-09-28T14:53:13.383Z`.

## 6. Check-In Post-State

READ-ONLY verified: `status = checked_in`; booking ID, hospital, patient,
payment state, fee, orders (0), refunds (0), ledger (0) all unchanged;
`updated_at = 2026-09-28 14:53:13.211031+00`. No notification job enqueued
for check-in (as expected — check-in has no WhatsApp side effect).

## 7. Check-In Audit

Exactly one new `booking_status_change` audit for booking A:
old_data.status `booked` → new_data.status `checked_in`, actor user present
(receptionist), created `2026-09-28 14:53:13.294215+00`. No other audit row
created by the check-in.

## 8. Check-In Replay

One intentional replay after post-state verification. Same endpoint, same
body. **HTTP 200 · `changed: false`** (correlationId `a3a5f8bd…`,
`2026-09-28T14:54:03Z`). Verified: status remained `checked_in`; `updated_at`
UNCHANGED (intrinsic replay — no duplicate transition); still exactly 1
status-change audit and 1 event for the transition; no financial mutation; no
notification job; no unrelated booking changes.

## 9. Booking B Fresh Pre-State

Provider recheck first (§3). Then, immediately before mutation:
`f7918ac1-b327-40c8-b1bd-9ad06ef02968` — status `booked`, tenant `…0001`,
source `walkin`, synthetic patient "E2E NoDoc 8550519", `booking_fee_inr 0.00`,
`payment_completed false`, 0 payment orders, 0 refunds, 0 ledger rows, 0 prior
status-change events, `cancelled_at NULL`. Pre-state correct → mutation
authorized.

## 10. No-Show Request

Same endpoint and headers. Body exactly
`{"bookingId":"f7918ac1-b327-40c8-b1bd-9ad06ef02968","newStatus":"no_show","notes":"Controlled staging no-show validation"}`
— note is synthetic, bounded (≤500), no financial fields; no direct WhatsApp
call; no manual job creation (backend owns the enqueue).

**Response: HTTP 200** · `status: no_show` · `changed: true` ·
correlationId `183c1b09…` · timestamp `2026-09-28T14:55:45Z`.

## 11. No-Show Post-State

READ-ONLY verified: `status = no_show`; booking ID, hospital, patient,
booking source unchanged; `booking_fee_inr 0.00`; `payment_completed false`;
payment orders 0; refunds 0; financial ledger 0; `cancelled_at NULL`
(cancellation fields untouched — no_show is not a cancellation);
`updated_at = 2026-09-28 14:55:44.761827+00`.

## 12. No-Show Note Persistence

`bookings.metadata->>'status_note'` =
`"Controlled staging no-show validation"` — verbatim, in the authoritative
backend location. (The note is additionally recorded in the audit
`new_data.notes`.) No conclusion of note loss was drawn from any unrelated
table/column.

## 13. No-Show Audit

Exactly one new `booking_status_change` audit for booking B: old `booked` →
new `no_show`, receptionist actor present, note in new_data, created
`2026-09-28 14:55:45.103366+00`.

## 14. WhatsApp Job / Delivery Boundary

Backend enqueued exactly one `send_whatsapp_message` job with dedupe key
`wa_booking_no_show_f7918ac1-b327-40c8-b1bd-9ad06ef02968`,
`related_booking_id` = booking B, status `pending`, created
`2026-09-28 14:55:45.004624+00`. Correct booking, correct synthetic patient,
correct dedupe key, no duplicate job. The no-show also enqueued the
backend-owned `compute_sla` refresh job
(`sla_…0001_2026-09-28_202609281455`, pending) — the documented backend side
effect of the authorized transition, not an unrelated mutation. The worker was
NOT manually triggered; the job remains pending.

**Classification: job enqueued; delivery NOT performed — blocked at the
provider credential boundary (no Meta credentials exist). This is NOT
"WhatsApp sent" and the patient was NOT notified.**

## 15. No-Show Replay

One intentional replay after post-state verification (same body including the
note). **HTTP 200 · `changed: false`** (correlationId `7850e83b…`,
`2026-09-28T14:56:55.249Z`). Verified: status remains `no_show`;
`cancelled_at` remains NULL; `updated_at` unchanged at
`14:55:44.761827+00`; exactly 1 status-change audit (no second); exactly 1
`wa_booking_no_show_f7918ac1…` job (no duplicate); 1 booking event; 0 orders,
0 refunds, 0 ledger rows; no unrelated booking mutation.

## 16. Tenant Isolation

Authenticated READ-ONLY as Tenant B receptionist
(`reception-b@surya.test`, hospital `00000000-0000-4000-8000-000000000002`,
Sri Venkateswara Hospital). Via PostgREST GET with the Tenant B JWT:
booking A query → **0 rows**; booking B query → **0 rows** (RLS denial);
Tenant B own bookings sample → 0 rows (tenant has no bookings — query
succeeded, so the zero is RLS/tenant scoping, not an auth failure). No Tenant
B mutation was attempted; the mutation endpoint was NOT called with Tenant B.

## 17. Browser Verification

Real browser on `https://setura-delta.vercel.app`, strictly READ-ONLY
(§24 for method caveats). All checks PASS:

- **Receptionist / Booking A:** badge `checked in`; "Visit status" card
  present; **Check In button ABSENT** (transition already applied);
  **Mark No-Show PRESENT** (still valid from checked_in). Page buttons:
  `Mark No-Show`, `Cancel booking` (C1 surface, untouched).
- **Receptionist / Booking B:** badge `no show`; **zero buttons on the page** —
  Check In and Mark No-Show absent, and the Cancellation card absent,
  consistent with existing terminal-state (C1) behavior. The status note
  string is NOT rendered in the DOM — the current UI does not display
  `metadata.status_note`; this is a UI display observation, not note loss
  (the note is proven persisted in §12).
- **Doctor / Booking A:** no "Visit status" card, no Check In / Mark No-Show /
  Cancel booking — button inventory `[]`; status shown read-only.
- **Network audit:** zero non-GET requests except auth
  (`POST /auth/v1/token`, `POST /auth/v1/logout`); **zero requests to
  `update-booking-status`** or any other mutation endpoint; no console errors,
  no CORS errors, no app-origin 4xx/5xx.
- **Screenshots: BLOCKED** (`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE` — hidden IDE
  viewport); DOM-text extraction used as evidence instead.

## 18. Financial Safety

Before and after are identical for every financial surface:
payment_orders 0 → 0 · payment_refunds 0 → 0 · financial_ledger 0 → 0 ·
daily_collection_entries 14 → 14. Both mutated bookings retain
`booking_fee_inr 0.00`, `payment_completed false`. No financial RPC, endpoint
or row was touched.

## 19. Global Before/After Census

| Table | BEFORE | AFTER | Expected | Match |
| --- | --- | --- | --- | --- |
| bookings | 14 | 14 | unchanged | ✅ |
| patients | 13 | 13 | unchanged | ✅ |
| hospitals | 5 | 5 | unchanged | ✅ |
| notification_queue | 0 | 0 | unchanged | ✅ |
| audit_logs | 46 | 48 | +2 intended | ✅ |
| job_queue | 72 | 74 | +no-show notification | ✅ (+1 backend-owned SLA refresh, fully attributed — see §14) |
| payment_orders | 0 | 0 | unchanged | ✅ |
| payment_refunds | 0 | 0 | unchanged | ✅ |
| financial_ledger | 0 | 0 | unchanged | ✅ |
| daily_collection_entries | 14 | 14 | unchanged | ✅ |
| queue_sessions | 2 | 2 | unchanged | ✅ |

Status census: booked 6→4 · checked_in 0→1 (booking A) · no_show 0→1
(booking B); completed 5, cancelled 1, skipped 2 unchanged. **No other booking
transitioned.**

## 20. Unexpected Mutation Check

`SELECT … FROM bookings WHERE updated_at > '2026-09-28 14:40:00+00'` returns
EXACTLY the two authorized rows (A `checked_in` @ 14:53:13.211031, B `no_show`
@ 14:55:44.761827). All post-window audits (2) and jobs (2) carry timestamps
and keys attributable to the two authorized mutations. Zero unexplained rows
in any audited table. No STOP condition triggered. The browser session's
incidental note that a stale tab render of booking A showed `booked` at
session start is simply pre-refresh state of the already-executed API
check-in (updated_at proves a single 14:53:13 transition; the tab issued zero
mutations).

## 21. Git State

`HEAD == origin/main == 0ec8586` before and after; zero tracked-file
modifications; only untracked files are prior-phase reports (pre-existing
state). No commit, amend, push, force-push or history rewrite was performed.
**D-COMMIT-1 remains sealed and was NOT touched.** The only new file created
by this phase is this report, as mandated.

## 22. Production Boundary

Production was NOT touched: no production URL, production Supabase project or
production secret was addressed. All operations targeted the staging ref
`gzcqasntcbqqmgsoikms` (and the read-only staging frontend alias).

## 23. Final Classification

| Item | Classification |
| --- | --- |
| Check-in (booked → checked_in) | **PROVEN STAGING** |
| No-show (booked → no_show) | **PROVEN STAGING** |
| Check-in replay (`changed:false`) | **PROVEN STAGING** |
| No-show replay (`changed:false`) | **PROVEN STAGING** |
| Note persistence (`metadata.status_note`) | **PROVEN STAGING** |
| Note display in UI | NOT TESTED (UI does not render the note — display never claimed) |
| Audit events | **PROVEN STAGING** (exactly 2, correct transitions/actor) |
| WhatsApp no-show job | **PROVEN STAGING** (enqueued, deduped, pending) |
| WhatsApp delivery | **BLOCKED** at provider credential boundary — **NOT CLAIMED** |
| Tenant isolation | **PROVEN STAGING** (read-only RLS proof, 0 rows) |
| Financial mutation | **NONE** |
| Unrelated mutations | **NONE FOUND** |
| Browser verification | **PROVEN STAGING** (screenshots BLOCKED — environment) |
| Production | **NOT TOUCHED** |
| G-02 overall | **PROVEN STAGING** (local online) — NOT production-verified, NOT certified |

## 24. Execution Incidents

Both incidents were tooling/environment-classified. **Every ambiguous attempt
was followed by a read-only DB check BEFORE any retry (retry discipline
honored); each attempt produced ZERO unintended mutation.**

1. **Sandbox network egress block.** Initial mutation attempts inside the
   tool sandbox failed with truncated/empty responses
   (`Invoke-WebRequest`/`[System.Net]` → "connection closed on receive";
   `curl.exe` → `HTTP_STATUS=000`). DB check between EVERY attempt proved
   booking A remained `booked` with unchanged `updated_at` — nothing had
   landed. Resolution: one materially different method (same command outside
   the sandbox, user-approved escalation) → HTTP 200. No blind retry occurred.
2. **curl spaced-note word-splitting.** The no-show attempted inline via
   `curl.exe` with the multi-word note; PowerShell split the argument, the
   endpoint received truncated JSON and returned **HTTP 422 VALIDATION_ERROR**
   — a correctly rejected, non-mutating request (DB-verified booking B still
   `booked`). Resolution: mutation routed through a script that JSON-encodes
   the body via `ConvertTo-Json` → HTTP 200. The replay's first inline curl
   attempt hit the same 422 and was handled identically.

No product defect resulted from either incident; no cleanup was required or
performed.

---

## MANDATORY FINAL BLOCK

CURRENT BASELINE:
0ec8586b3b5b72dd4fcb06c9e5239a89103dc156

AUTHORIZED MUTATIONS:
2

BOOKING A:
eb701e56-0df6-4ecb-9fb5-83b81f7fae8b

EXPECTED:
booked → checked_in

ACTUAL: booked → checked_in (HTTP 200, changed:true, single transition, updated_at 14:53:13.211031+00)

BOOKING B:
f7918ac1-b327-40c8-b1bd-9ad06ef02968

EXPECTED:
booked → no_show

ACTUAL: booked → no_show (HTTP 200, changed:true, single transition, updated_at 14:55:44.761827+00)

CHECK-IN:
PROVEN STAGING

NO-SHOW:
PROVEN STAGING

CHECK-IN REPLAY:
PROVEN (HTTP 200, changed:false, updated_at unchanged, no second audit/job)

NO-SHOW REPLAY:
PROVEN (HTTP 200, changed:false, updated_at unchanged, no second audit/job, cancellation fields untouched)

AUDIT: +2 exactly (A booked→checked_in @14:53:13.294215+00; B booked→no_show @14:55:45.103366+00; receptionist actor present; 46→48)

WHATSAPP JOB: exactly 1 send_whatsapp_message, dedupe key wa_booking_no_show_f7918ac1-b327-40c8-b1bd-9ad06ef02968, status pending, no duplicate (plus 1 backend-owned compute_sla refresh attributed to the same authorized transition)

WHATSAPP DELIVERY:
NOT CLAIMED

FINANCIAL MUTATION:
NONE

TENANT ISOLATION: Tenant B JWT read-only lookup of bookings A and B returned 0 rows each via RLS; no Tenant B mutation attempted

UNRELATED MUTATIONS:
NONE FOUND (only A and B have updated_at after 14:40 UTC; all census deltas attributed)

BROWSER: reception A shows checked in / no Check In / Mark No-Show present; reception B shows no show / zero controls (terminal state); doctor sees no reception controls; zero mutation requests; no console/CORS errors; screenshots BLOCKED (viewport unavailable)

PRODUCTION:
NOT TOUCHED

GIT:
UNCHANGED FROM 0ec8586

D-COMMIT-1:
SEALED / NOT REWRITTEN

FINAL G-02 STATUS:
PROVEN STAGING
