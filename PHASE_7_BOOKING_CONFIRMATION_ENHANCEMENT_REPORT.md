# PHASE 7 — Booking Confirmation Enhancement — Validation Report

Status: **implementation COMMITTED + PUSHED; staging write-path PROVEN; validation
report pending commit (see §17).**

This report is documentation produced AFTER the authorized implementation commit.
Per instruction, the report is NOT committed — the implementation is.

---

## 1. Objective

Improve the post-creation confirmation a receptionist sees after creating an
appointment/walk-in so it accurately reflects the REAL booking response:

Patient · Doctor · Token · Queue status · Booking reference (+ appointment date
and estimated wait where the backend actually returns them).

Frontend-only. No backend, SQL, migration, RLS, financial, queue/token, CORS or
Vercel-setting changes. Then validate on the existing staging-backed alias and
commit + push the two implementation files under explicit authorization.

## 2. Source investigation (before implementing)

- Edge Function: `supabase/functions/create-booking/index.ts`. On success
  (201) and on idempotent replay (200) it returns
  `successResponse({ bookingId, tokenNumber, bookingReference,
  estimatedWaitMinutes, patientId, appointmentDate, queueSessionId, fees })`.
- Canonical type: `supabase/functions/_shared/types.ts` →
  `CreateBookingResponse`. Frontend mirror: `apps/web/src/types/api.ts`.
- SQL `create_booking` (`02_atomic_token_engine_&_bookings.sql`) persists
  `token_number`, `booking_reference`, `queue_session_id`, `appointment_date`
  and fee snapshots — but NOT `estimated_wait_minutes`.
- Read surfaces: `apps/web/src/api/reads.ts` → `listHospitalDoctors`
  (`HospitalDoctorOption.label`) and `getBooking`.

## 3. Backend response fields — verified behavior

| Field | Source | Notes |
| --- | --- | --- |
| `bookingId` | booking row | used for Open Booking navigation |
| `tokenNumber` | booking row | live-issued token |
| `bookingReference` | booking row | generated reference (real format, not UUID) |
| `appointmentDate` | booking row | ISO date |
| `queueSessionId` | booking row | **non-null ONLY when `doctorId` was provided**; null otherwise |
| `estimatedWaitMinutes` | computed via `estimate_wait_minutes` RPC | **response-only; NOT persisted** — must be carried from the live response, not re-derived |
| `fees` | fee snapshots | present in the response but deliberately NOT displayed |

Key consequence: because `estimatedWaitMinutes` is response-only, the
confirmation must snapshot the live response (as implemented) rather than
navigate-and-read BookingDetail, or the wait figure would be lost.

## 4. Implementation

- `BookingForm` captures the live `CreateBookingResponse` into a local
  immutable `Confirmation` snapshot on success and renders an inline
  confirmation card INSTEAD of navigating immediately.
- Doctor label is resolved from the already-loaded assignable-doctor read
  surface (never fabricated; `"No doctor assigned"` when none selected).
- Queue truthfulness: `queued = queueSessionId !== null`. Queued → badge
  "In queue" + "Added to the doctor's live queue" + Queue session row +
  Est. wait row (only when the response returned a value). Not queued →
  badge "Not queued" + "No queue assignment — not callable from the Doctor
  Console", and NO Queue session / Est. wait rows.
- Actions: "Open Booking" navigates to `/bookings/:bookingId` (canonical
  BookingDetail, unchanged); "Create Another" resets the form and the
  `useAsyncAction` idempotency key for a genuinely new submission.
- Fees are neither displayed nor recomputed. No `undefined` / `null` /
  `[object Object]` rendered (empty reference falls back to `—`).
- The Queue session row renders the FULL `queueSessionId` UUID (verified in
  source; the browser walkthrough observed the same).

## 5. Exact changed files

```
apps/web/src/components/BookingForm.tsx       (+150 / -3)
apps/web/src/components/BookingForm.test.tsx  (+151 / -2)
2 files changed, 299 insertions(+), 5 deletions(-)
```

Backend, migrations, RLS, CORS, secrets, Vercel settings: unchanged.
BookingDetail: unchanged. `.vercelignore`: confirmed UNTRACKED / not part of
this commit (transient preview scaffold from the prior attempt; removed).

## 6. Local test results (pre-commit gate — STEP 4)

| Check | Result |
| --- | --- |
| `npm run typecheck` (`tsc --noEmit`) | PASS |
| `npm run build` | PASS |
| `npm run test` (vitest) | 42 passed / 0 failed (6 files) |
| `git diff --check` | PASS (clean) |
| `check_frontend_secrets.ts apps/web/dist --deny-sourcemaps` | 0 secret hits / 0 source maps |

Added tests assert: queued render verbatim + no auto-navigation; null-queue
honest negative path (Not queued / No doctor assigned / no Est. wait / full
uuid absent / no null-text); no fee values rendered; Open Booking →
`/bookings/b-1`; Create Another resets the form.

## 7. Deployment details (STEP 8)

Commit + normal fast-forward push: `5f5fbd7..62ba96e main -> main`
(no force / rebase / amend). The existing Git-connected Vercel project
`setura` auto-built the committed `main` revision.

- Deployment: `dpl_FKqWgoWH5gBCay4ZLAjFNTg6n59w`
- Target: **production**, Status: **Ready**, Build duration: 11s
- Aliases: `https://setura-delta.vercel.app` (unchanged staging-backed alias),
  `https://setura-git-main-...vercel.app`, `https://setura-...vercel.app`
- No new project, no env/settings changes; staging `VITE_*` supplied by the
  existing Project Environment Variables.

## 8. Cloud bundle verification (STEP 9)

Served asset `https://setura-delta.vercel.app/assets/index-HgCrI9r9.js`
(459,118 B):

| Item | Result |
| --- | --- |
| Staging Supabase URL present | YES — 2 refs, clean JS literal `"https://gzcqasntcbqqmgsoikms.supabase.co"` |
| Escaped-quote / wrapped-value bug | 0 (confirms the earlier "quoted env" concern does NOT reproduce in cloud builds) |
| Anon / publishable key only | YES (no service-role) |
| service-role secret | 0 (single `sb_secret_` hit is supabase-js's own prefix-validator string, not a credential) |
| Razorpay live / Meta / SMTP | 0 |
| localhost / 127.0.0.1 backend references | 0 (the few `localhost`/`127.0.0.1` matches are supabase-js library-internal `isAuthApi`/PKCE prefix constants, not a configured backend) |
| Source maps | 0 (`.js.map` refs = 0) |
| Booking Confirmation strings | present ("Walk-in created", "Appointment created", "Open Booking", "Create Another", "No queue assignment") |

## 9. Real staging browser write-path (STEP 10) — PROVEN

Target: `https://setura-delta.vercel.app` (allow-listed origin). CORS confirmed
working here (a signed-out probe POST to `create-booking` returned a structured
`IDEMPOTENCY_KEY_REQUIRED`, i.e. the function was reached, not blocked by
preflight) — this is the validation that was BLOCKED on the ephemeral preview
in the prior attempt.

Note on accounts: the identities named in the request
(`*@setura.dev` / `*@setura.in`) do NOT exist on this staging backend; the
walkthrough used the repo-documented staging seed identities
(`reception@surya.test`, `dr@surya.test`, `reception-b@surya.test`), which DO.

Tenant A receptionist — two appointment bookings (same doctor, date today):

| Field | Booking 1 | Booking 2 |
| --- | --- | --- |
| Patient / Phone | Conf Validation Patient / 9876500123 | Conf Validation Patient 2 / 9876500124 |
| Token | 9 | 10 |
| Booking reference | B50FF413F63B51DF | AB5E0208D5CC7F8F |
| Booking UUID | 61ac8f21-2d49-466d-b4bf-fb0cd9ac76bf | eb701e56-0df6-4ecb-9fb5-83b81f7fae8b |
| Queue session | 888e0f38-f713-4b82-98b1-0ee3ae09dae4 | (same open session) |
| Est. wait | 0 min | 10 min |
| POST create-booking | 201 | 201 (no 409 conflict) |

Confirmation card verified: replaced the form IN PLACE (URL stayed
`/reception/book`, no auto-navigation); header "Appointment created" + badge
"In queue"; rows Patient / Doctor / Token / Booking reference / Date / Queue
("Added to the doctor's live queue") / Queue session / Est. wait — all
verbatim from the response; **no ₹ / fee / amount text on the card** (the fee
rows appear only on the canonical BookingDetail, as before).
"Open Booking" navigated to `/bookings/61ac8f21-...` (BookingDetail consistent
with the card). "Create Another" reset to a blank form (today's date) with no
navigation.

## 10. Queue truthfulness (STEP 11) — PROVEN

The Est. wait and "In queue" claims come from a live non-null `queueSessionId`
+ backend-computed wait, not UI text. Independent proof: as the Tenant A doctor
(`dr@surya.test`), the Doctor Console live "Waiting" queue showed BOTH created
patients (Pos 1 Token 9 "Conf Validation Patient" 10m; Pos 2 Token 10 "Conf
Validation Patient 2" 20m) — confirming the bookings genuinely entered the
doctor's live queue. The negative branch (queueSessionId null → "Not queued",
"No queue assignment") is proven at unit level and matches the deployed code;
not triggered in the staging walkthrough because every created booking was
doctor-assigned.

## 11. Tenant A / Tenant B isolation (STEP 12) — PROVEN (reads)

As Tenant B receptionist (`reception-b@surya.test`, hospital `…0002`):
- Patient search for Tenant A's phone/name returned nothing (RLS-scoped to
  `…0002`; no Tenant A patient leaked).
- Direct navigation to Tenant A's booking `/bookings/61ac8f21-...` showed only
  "Booking not found or not visible to your account." (read constrained by
  `hospital_id = …0002 AND id = …`), no patient/token/doctor leakage.
- Tenant B's Doctor dropdown shows "No doctors on record for this hospital."
- No new tenants created.

## 12. Browser / network health (STEP 13)

Across the three sessions: 0 application console errors, 0 unexpected
application-origin 4xx/5xx, 0 CORS errors. (Tracking-script noise excluded;
none present.) All auth/REST/function calls that belong to the workflow
returned 200/201.

## 13. Remaining gaps / notes

- **Tenant B write-path: BLOCKED (pre-existing backend data gap, not this
  feature).** Hospital `…0002` on staging lacks `hospital_settings` and doctor
  rows, so a Tenant B create returns `500 "Hospital settings not found"`. This
  is a staging seed/data condition, independent of the frontend change; no
  partial data was written. Not fixed here (would require backend/seed changes
  out of scope).
- **"Not queued" runtime branch: UNPROVEN on staging** (every created booking
  was doctor-assigned). Covered by unit test + source; cosmetic-identical path.
- **Route observation (pre-existing, not introduced):** `/bookings/new` is not
  a real app route (real routes are `/reception/book`, `/reception/walk-in`);
  hitting `/bookings/new` falls into `/bookings/:bookingId` and BookingDetail
  issues `id=eq.new` → 400 "not found". A UUID/route guard could harden this
  later. Out of scope for this phase.
- **Production verification: NOT APPLICABLE / UNPROVEN** — this was validated
  on the staging-backed alias only; no production deployment performed.

## 14. Git state

- Predecessor HEAD / origin/main: `5f5fbd7`.
- New commit (this phase): `62ba96e45f203ed1df0ad2fcee9efe6b8f88f480`
  (`62ba96e`), message `feat: improve booking creation confirmation`,
  exactly 2 files.
- Pushed to `origin/main` (fast-forward). After push `HEAD == origin/main ==
  62ba96e` and working tree was clean.
- This report file is currently the only uncommitted change (NOT committed —
  see §17).

Recent chain:
```
62ba96e  feat: improve booking creation confirmation      (this phase)
5f5fbd7  docs: reconcile Vercel env findings in Phase C report
ad47215  Expose consultation notes to staff + UI          (Phase C)
```

## 15. Exact commit SHA

```
62ba96e45f203ed1df0ad2fcee9efe6b8f88f480
```

## 16. Classification summary

| Item | Classification |
| --- | --- |
| Frontend implementation (per approved decisions) | PROVEN |
| Typecheck / build / 42 unit tests / secret+source-map scan | PROVEN (local) |
| Committed (2 files) + pushed (fast-forward) | PROVEN |
| Git-triggered Vercel staging deploy + cloud bundle cleanliness | PROVEN (staging) |
| Real staging browser write-path (queued booking card) | PROVEN |
| Queue truthfulness (doctor live queue) | PROVEN |
| "Not queued" branch on staging | UNPROVEN (unit-tested only) |
| Tenant A / Tenant B read isolation | PROVEN |
| Tenant B booking creation | BLOCKED (pre-existing staging data gap) |
| Estimated wait carried verbatim (response-only) | PROVEN |
| Fees excluded from the confirmation | PROVEN |
| Report committed | NOT AUTHORIALIZED (left uncommitted) |
| Production verification | NOT APPLICABLE / UNPROVEN |

## 17. Post-validation gate

Implementation is committed and pushed (`62ba96e`). This validation report is
generated afterward and is intentionally left UNCOMMITTED pending separate
authorization, per the phase boundary.
