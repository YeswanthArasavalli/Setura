# PHASE 7 G-02 — RECEPTION BOOKING STATUS CLOSURE (CHECK-IN + NO-SHOW) — IMPLEMENTATION REPORT

Frontend-only implementation of the G-02 gap selected in
`PHASE_7_NEXT_PRODUCT_GAP_INVESTIGATION_REPORT.md`, on top of the existing,
integration-proven `update-booking-status` Edge Function. No backend, SQL,
migration, RLS, financial or notification code was modified.

---

## 1. Executive Summary

Reception-side closure of a booking as `checked_in` or `no_show` is now
available in the staff console on the booking detail page. The surface reuses
the canonical `update-booking-status` endpoint unchanged: confirmation before
every mutation, backend response + refetch as the only authority, intrinsic
replay (`changed:false`) rendered as a completed outcome, and no claim of
WhatsApp delivery. 145 frontend tests pass (24 new), the full 246-test
integration suite passes against the local stack, and an end-to-end local
browser walkthrough proved both mutations, the state-reactive visibility and
the doctor-side absence of controls. Staging received a READ-ONLY preflight
only; no staging mutation, deploy, commit or push was performed.

## 2. Scope

IN scope (all delivered): `api/statuses.ts` thin client module, contract types
in `types/api.ts`, presentation predicates in `lib/statusClosure.ts`, the
"Visit status" card in `BookingDetail.tsx` with confirmation panels and an
optional no-show note, focused unit/component tests, local validation, local
browser walkthrough, read-only staging preflight, this report.

OUT of scope (untouched, per spec): reschedule (separate defect P-RESCH-01),
cancellation behavior changes, queue controls, finance UI, doctor
leave/schedule, waiting/called manual controls, the backend itself.

## 3. Baseline

- Git HEAD = `a9aa774f4620b45541ccc18dce4f31d92e82d2b1` (= origin/main),
  re-verified at the end of this phase (`git rev-parse HEAD`).
- Backend endpoint `update-booking-status` IMPLEMENTED and integration-proven
  before this phase (E1 06, S1 05/S1 12); reused unchanged.
- Local Supabase stack running; Edge Runtime had exited (F16-01) and was
  restarted during this phase (environment action, not a code change).

## 4. Source Reconciliation

Phase A verified before writing any code:

- `BookingDetail.tsx` (532 lines at baseline) already owned the C1
  cancellation pattern: `useAsyncAction` + confirmation panel + refetch after
  every attempt + `describeError` surface. The new card mirrors it.
- `_shared/booking_state.ts`: `booked → [checked_in, cancelled, no_show,
  skipped]`, `checked_in → [waiting, cancelled, no_show]`,
  TERMINAL = `{completed, cancelled, no_show, rescheduled}`. Frontend
  visibility predicates mirror exactly this for the reception surface.
- `update-booking-status/index.ts`: zod body `{bookingId, newStatus,
  notes?: string.max(500)}`; `requireRole(receptionist, hospital_admin,
  global_admin, doctor-restricted)`; optimistic `.eq("status", current)`;
  `changed:false` replay when current === next; no `Idempotency-Key` reading
  anywhere in the file.
- `lib/api.ts` `callFunction` supplies Bearer JWT, `apikey` and
  `X-Hospital-ID`; `lib/errors.ts` maps 422→validation, 403→forbidden,
  409→conflict, 0→network.
- `ReceptionDashboard.tsx` links every row to `/bookings/:id` (line 151) —
  BookingDetail is therefore the sole action surface; the optional dashboard
  affordance was deliberately skipped (it would duplicate logic).

## 5. Backend Contract Reuse

The frontend calls only `POST functions/v1/update-booking-status` with the
documented body. Server remains the only authority on: role check, tenant
membership + `X-Hospital-ID` equality, transition legality, terminal-state
refusal, optimistic concurrency, audit (`booking_status_change`), SLA refresh,
no-show WhatsApp job enqueue (`wa_booking_no_show_<id>` dedup key) and
realtime broadcast. Zero business rules were re-implemented client-side —
`lib/statusClosure.ts` only decides whether a control is *rendered*.

## 6. Files Changed

| File | Change | Lines |
| --- | --- | --- |
| `apps/web/src/types/api.ts` | MODIFIED — added `ReceptionStatusUpdate`, `UpdateBookingStatusRequest/Response` | +26 |
| `apps/web/src/api/statuses.ts` | NEW — thin `updateBookingStatus()` client | 47 |
| `apps/web/src/lib/statusClosure.ts` | NEW — presentation-only predicates/labels | 68 |
| `apps/web/src/routes/BookingDetail.tsx` | MODIFIED — "Visit status" card, handlers, role gate | +216/−1 |
| `apps/web/src/api/statuses.test.ts` | NEW — 6 boundary tests | 95 |
| `apps/web/src/lib/statusClosure.test.ts` | NEW — visibility-matrix/label tests | 99 |
| `apps/web/src/routes/BookingDetail.test.tsx` | MODIFIED — 15-test status-closure describe block | +278 |

`git diff --stat` on tracked files: 519 insertions, 1 deletion, all under
`apps/web`. `git diff --quiet -- supabase` → **ZERO diff**.

## 7. Check-In Implementation

Booked bookings show a "Check In" button → inline "Confirm check-in" panel
stating the backend will verify the booking is still in state
`<current status>` → confirm sends `{bookingId, newStatus:"checked_in"}` →
on any completion the page refetches and the badge shows server truth.
Success banner is derived from the response only ("Patient checked in").
`checked_in` never re-offers Check In (backend would answer `changed:false`;
hiding it keeps the surface honest per spec).

## 8. No-Show Implementation

`booked` and `checked_in` show "Mark No-Show" → "Confirm no-show" panel
(copy states it never changes any payment or refund) with an optional
"Note (optional)" textarea → confirm sends `{bookingId, newStatus:"no_show"}`
plus `notes` **only when non-empty** (typed text sent verbatim, empty string
never sent). The note lands server-side in `bookings.metadata.status_note`
and the audit `new_data` — confirmed in local runtime (§17). The frontend
mentions nothing about notification delivery; the no-show job is the
backend's concern.

## 9. Role / Authorization Behavior

Rendering gate (UX only): `receptionist`, `hospital_admin`, `global_admin`.
Doctor, patient and unknown roles never see the controls — proven in tests
and in the browser walkthrough on a `booked` booking. The server's
`requireRole` + tenant equality remain the authority; a UI-gate bypass would
still be rejected (403/42501 paths unchanged). The card is presentational
gate only; no client-side authorization decision affects any request.

## 10. State Visibility Matrix

| Booking status | Check In | Mark No-Show | Rationale |
| --- | --- | --- | --- |
| booked | yes | yes | backend allows both |
| checked_in | no | yes | already checked in; no-show still allowed |
| waiting / called / in_consultation | no | no | queue-owned; QueueBoard (`mark_absent`) owns these |
| completed / cancelled / no_show / rescheduled | no | no | terminal |

Enforced by `canOfferCheckIn` / `canOfferNoShow` and pinned by
`statusClosure.test.ts` against the full 10-value `pg_enum` list.

## 11. Error Handling

- 422 ValidationError (invalid/terminal transition) → server message shown,
  booking stays visible, retry allowed.
- 403 ForbiddenError → generic "You do not have permission…" only; no
  internals leaked (spec 400 case maps to the actual 422 status verified in
  `_shared/errors.ts`).
- 409 ConcurrencyError → conflict alert plus reload so the user sees current
  server truth.
- Network error (kind network) → surfaced via `describeError`, refetch still
  runs so the UI converges on reality.
No optimistic status is ever painted; error path keeps the last server state.

## 12. Double-Fire / Replay Handling

- Double-fire: buttons and confirm controls are disabled while
  `statusUpdate.running`; a test proves exactly one call with a never-resolving
  promise. `useAsyncAction` additionally guards with an in-flight ref.
- Server-side replay: `changed:false` is rendered as
  "Patient was already checked in (no change)" / "Booking was already marked
  no-show (no change)" — a success, never an error (pinned in tests).
- No `Idempotency-Key` is sent because the endpoint does not read the header;
  its replay safety is intrinsic (`changed:false` + optimistic guard). Pinned
  by `statuses.test.ts` (`"idempotencyKey" in opts === false`).

## 13. Security Review

- No secrets, tokens or keys in any new file (secret scan: 0 hits).
- Tenant id travels only via the `X-Hospital-ID` context that `callFunction`
  adds — the body contains no hospital/tenant field (pinned by regex test).
- No direct table writes anywhere in the new path: only
  `POST /functions/v1/update-booking-status`; the page's read path is the
  existing `getBooking` RPC/select.
- Notes are sent as validated strings (≤500, server zod re-validates); no SQL
  or PostgREST filter interpolation is introduced.
- Error surface strips internals (403 generic message).

## 14. Financial Safety

The request body is exactly `{bookingId, newStatus[, notes]}` — tests assert
`JSON.stringify(body)` never matches `/amount|fee|inr|refund|hospital/i`.
No financial table, RPC, ledger, refund or settlement path is referenced by
any new file. The no-show copy explicitly states payment/refund are unchanged
(honest: the backend performs no financial mutation on this transition).

## 15. WhatsApp / Side-Effect Boundary

No frontend code touches WhatsApp, the job queue or any notification API.
No label matches `/whatsapp|sent|notified/i` (test-pinned). Locally, the
backend's own enqueue fired as designed:
`job_queue` row `send_whatsapp_message`, idempotency key
`wa_booking_no_show_c193fe8d-…` — observed READ-ONLY via psql; it remains
`pending` (worker disabled locally), which this report does not call delivery.

## 16. Local Tests

| Command | Result |
| --- | --- |
| `npm run typecheck` (`tsc --noEmit`) | PASS, 0 errors |
| `npm test` (`vitest run`) | **145 passed / 0 failed (13 files)** — was 121 before this phase; 24 new tests |
| `npm run build` (`tsc --noEmit && vite build`) | PASS; no `.map` assets, 0 `sourceMappingURL` in bundle |
| `deno run scripts/check_frontend_secrets.ts` | 0 secret hits, 0 source maps, 3 artifacts |
| `git diff --check` | clean |
| `deno task validate:migrations` | 63 files, **0 errors**, 4 known pre-existing `[duplicate-objects]` warnings |
| `deno task test:integration` (full) | **246 passed / 0 failed** |

New tests cover the spec's enumerated cases: visibility matrix (all 10
statuses × both roles), exact body shape, hospital-context-only tenancy, no
idempotency key, notes omission/verbatim, disabled-while-running, refetch on
success, `changed:false` as success, 422/403/409 mapping, no financial fields,
no delivery claims, doctor control absence, C1 cancellation controls intact.

**Integration-run anomaly (F16-01 recurred, then fixed as environment
action):** the first full integration run failed 37 edge-function tests
because `supabase_edge_runtime_setura` had exited (`RestartPolicy=no`).
`docker start` recovered it; function liveness was confirmed
(`POST update-booking-status` unauthenticated → 401 from the function layer,
not Kong), after which the same suite passed 246/246. Targeted pre-run:
`hospital_core_journey.test.ts` + `security_s1.test.ts` → 33/33 passed.
No product code changed in response to that failure.

## 17. Local Browser Validation

Dev server `http://localhost:5173` (`npm run dev`), local seed accounts, via
the Browser subagent — all steps observed against the running stack:

1. Receptionist `reception@surya.test` login → `/reception` as Ravi Kumar. PASS
2. `/bookings/c193fe8d-…` (status `booked`) → "Visit status" card with exactly
   `Check In` + `Mark No-Show`. PASS
3. Check In → "Confirm check-in" panel quoting state `booked`, "Keep as is"
   present → confirm → "Patient checked in", badge `checked in`, refetch
   observed (`POST update-booking-status` 200 → `GET bookings` 200). PASS
4. Post-check-in: `Check In` gone, `Mark No-Show` remains. PASS
5. Mark No-Show → panel quotes `checked_in`, optional note typed
   "patient never travelled" → confirm → "Booking marked as no-show". PASS
6. No delivery claim anywhere on the page (only hit for "whatsapp" is the
   booking's `manual_whatsapp` source value). PASS
7. Doctor `dr@surya.test`: same two bookings (no_show and booked) → no
   "Visit status" card, no Check In / Mark No-Show buttons. PASS
8. Console: zero errors; two pre-existing React Router future-flag warnings.

Runtime truth (READ-ONLY psql): `bookings.status='no_show'`,
`metadata->>'status_note'='patient never travelled'`, two attributed
`booking_status_change` audit rows (`actor` present), one deduped
`send_whatsapp_message` job pending. A subagent flag that the note "did not
persist" was investigated and disproven — it checked `booking_events.notes`,
a column this endpoint never writes (backend stores in `bookings.metadata`;
no defect, no action).

Screenshots: NOT CAPTURED — the IDE browser view stayed hidden
(`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`); the walkthrough ran via scripted DOM
events, which the app handled normally. Textual observations above are the
evidence.

## 18. Staging Read-Only Preflight

READ-ONLY only — zero staging mutations of any kind.

| Check | Result |
| --- | --- |
| Staging identity | Linked project `gzcqasntcbqqmgsoikms`, tenant `…0001` (Surya) |
| `bookings.metadata` column | PRESENT (notes path viable) |
| Endpoint | Already deployed before this phase (C1-era); `update_booking_status` is not an RPC — the flow is the Edge Function, called only via HTTP; nothing new to deploy at backend |
| Safe synthetic bookings | 3 × `Verify Patient` in status `booked` (e.g. `1533cce8-…`), `payment_status_detail NULL`, `consultation_fee_inr NULL`, `paid_online false` — unpaid, feeless, synthetic |
| Receptionist login | 1 receptionist account in tenant `…0001` (`reception@surya.test`, used by C1 walkthrough) |
| Provider boundary | Same posture as C1: hospital Meta IDs NULL, `whatsapp_number=919000000002` display-only, `vault.secrets` = 2 rows (cron/scheduler keys only), no Meta/Razorpay credential in vault |
| Vercel | Deployments listed under personal scope `yeswantharasavallis-projects/setura`; production bundle is the pre-G-02 build — **the new UI is NOT deployed** |

Assessment: a future controlled check-in and controlled no-show on one
synthetic `booked` staging booking would be safe **once staging-mutation
authorization is separately granted** (no-show would enqueue
`wa_booking_no_show_<id>`; with provider credentials absent the job stays
undelivered/dead-letter per existing behavior — same boundary C1 accepted).

## 19. Remaining Blockers

- Staging mutation (controlled check-in + controlled no-show) requires its own
  explicit authorization — NOT granted in this phase.
- Vercel deployment of the new frontend NOT performed (spec forbids).
- Screenshot evidence from the browser walkthrough BLOCKED by the hidden IDE
  viewport (textual evidence provided).
- Pre-existing, out of scope: P-RESCH-01 (reschedule writes non-existent
  columns), P0-01..P0-04, F16-01 recurred this phase (restarted, policy
  unchanged), F16-05/F16-06/F16-07.

## 20. Non-Goals

No reschedule, no cancellation changes, no queue changes, no finance UI, no
backend/SQL/RLS/migration changes, no Idempotency-Key protocol change, no new
state machine, no dashboard-inline affordance (justified skip: dashboard rows
already navigate to BookingDetail), no production touch, no commit/push.

## 21. Git State

- Tracked modifications: `BookingDetail.tsx`, `BookingDetail.test.tsx`,
  `types/api.ts` — all `apps/web` (diff +519/−1).
- New untracked source: `api/statuses.ts`, `api/statuses.test.ts`,
  `lib/statusClosure.ts`, `lib/statusClosure.test.ts`, this report.
- `supabase/`, `tests/`, `scripts/`, `.github/`: **zero diff**.
- COMMIT: NOT PERFORMED. PUSH: NOT PERFORMED. HEAD unchanged at `a9aa774`.
- Repository otherwise contains pre-existing untracked reports/screenshots
  from earlier phases (not created or modified by this phase except as
  listed).

## 22. Final Classification

| Layer | Classification |
| --- | --- |
| Backend (`update-booking-status`) | IMPLEMENTED (pre-existing) · UNCHANGED this phase · INTEGRATION VERIFIED locally (246/246 incl. endpoint suite) |
| Frontend surface | IMPLEMENTED · UNIT VERIFIED (145/145) · BUILD VERIFIED · PROVEN LOCAL (browser walkthrough + runtime psql reads) |
| Staging | READ-ONLY PREFLIGHT COMPLETE · feature NOT DEPLOYED · mutations NOT TESTED (not authorized) |
| Production | UNPROVEN · NOT TOUCHED |

---

CURRENT BASELINE:
a9aa774f4620b45541ccc18dce4f31d92e82d2b1

SELECTED GAP:
G-02 — Reception-side booking-status closure

IMPLEMENTED: Reception-side Check In and Mark No-Show on the booking detail
page for receptionist/hospital_admin/global_admin — confirmation-before-send,
optional verbatim no-show note (≤500, omitted when empty), backend-response +
refetch as sole authority, `changed:false` replay as success, 422/403/409
error surfaces, double-fire disabled, doctor sees no controls

BACKEND:
UNCHANGED

SQL / MIGRATIONS:
UNCHANGED

RLS:
UNCHANGED

FINANCIAL LOGIC:
UNCHANGED

EXTERNAL CREDENTIALS:
NOT USED

LOCAL VALIDATION: typecheck PASS · vitest 145/145 PASS · build PASS (0 source
maps) · secret scan 0 hits · `git diff --check` clean · validate:migrations
0 errors / 4 known warnings · integration 246/246 PASS (after F16-01 Edge
Runtime restart — environment action only)

LOCAL BROWSER: PASS — receptionist booked→checked_in→no_show round trip with
note persisted to `bookings.metadata.status_note`, deduped no-show job
observed pending, attributed audit rows; doctor sees no controls; 0 console
errors; screenshots BLOCKED (hidden IDE viewport)

STAGING:
READ-ONLY PREFLIGHT ONLY — feature NOT DEPLOYED, NO MUTATION PERFORMED,
NOT TESTED on staging

PRODUCTION:
NOT TOUCHED

D5:
DEFERRED BY OWNER

D13:
DEFERRED BY OWNER

COMMIT: NOT PERFORMED

PUSH: NOT PERFORMED

FINAL STATUS:
PROVEN LOCAL — IMPLEMENTED AND VALIDATED LOCALLY; STAGING NOT YET VALIDATED
(separate mutation authorization required); STOP CONDITION REACHED
