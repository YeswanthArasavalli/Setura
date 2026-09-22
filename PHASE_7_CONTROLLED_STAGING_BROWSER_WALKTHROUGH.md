# PHASE 7 — CONTROLLED STAGING BROWSER WALKTHROUGH

## 1. Objective
Perform a real, evidence-driven browser walkthrough against the **existing
STAGING** backend and upgrade core-journey workflow evidence from
`PROVEN LOCAL` to `PROVEN STAGING` **where the browser can actually prove it**.
This is not an audit. No production was touched.

## 2. Environment
- Real browser against the live deployed frontend; DevTools Console + Network
  observed throughout; no mocked backend, no fake API responses, no unit-test
  substitution for browser evidence.
- A first-run viewport limitation (window minimized for part of one run) was
  worked around with scripted DOM interaction plus a11y snapshots and live
  Network/Console inspection; the login, doctor-dropdown and completion states
  were then re-captured with real clicks and screenshots once the viewport
  returned. Functional results are genuine.

## 3. Exact staging frontend URL
`https://setura-delta.vercel.app`

## 4. Backend / staging project identity
- **Confirmed by network inspection, not by an old report:** every data/auth/
  function request went to `https://gzcqasntcbqqmgsoikms.supabase.co`
  (Supabase project `setura-staging`, ref `gzcqasntcbqqmgsoikms`).
- Programmatic scan of all resource URLs for `localhost` / `127.0.0.1` /
  `setura.in` returned **zero matches** at every checkpoint; the shipped JS
  bundle contains exactly one Supabase ref and **0** occurrences of
  `setura.in`. **No production target is in use.**
- Auth: `POST /auth/v1/token?grant_type=password` → 200; `POST /auth/v1/logout`
  → 204. Client key is a public publishable key.

## 5. Accounts / roles used (identities only — no credentials listed)
- Receptionist — `reception@surya.test` (Surya Hospital, `hospital_id …0001`,
  display "Ravi Kumar").
- Doctor — `dr@surya.test` (Surya Hospital, display "Dr. Anitha Rao").
- Second-tenant receptionist — `reception-b@surya.test` (Tenant B,
  `hospital_id …0002`) — used only for the isolation check.
All are the repository's documented deterministic seed identities. Passwords are
deliberately not recorded here or anywhere in this report.

## 6. Browser / environment
Chromium-based automation browser against the live staging origin; Console and
Network panels captured at three checkpoints.

## 7. Reception results
`PROVEN STAGING` — sign-in succeeded, redirected to `/reception`, dashboard
("Welcome, Ravi Kumar", role `receptionist`) loaded today's bookings read from
`bookings` under RLS. **Zero console errors, zero app-produced non-2xx, zero
CORS/auth failures.**

## 8. Patient results
`PROVEN STAGING` — patients are created implicitly by the Walk-in/Appointment
form (dedupe lookup on name/phone), then appear in Patients search and in
history. Test patient `STAGING WALKTHROUGH TEST` (phone `9999999999`) was
created and is retrievable with its visit history.
Note: there is **no standalone "add patient" UI** — by design, not a defect.

## 9. Walk-in results
`PROVEN STAGING` for the booking mechanics: submit issued
`POST /functions/v1/create-booking` → **201**, produced **Token 6**, a booking
`Ref D0CDFE982FC3C03C`, status `booked`, source `walkin`, date `2026-09-22`.
DB row carries `assigned_doctor_id …00a3` and a `queue_session_id`.

## 10. Doctor assignment results
`PROVEN LOCAL ONLY` (not on staging) — on staging the picker still rendered
`General Medicine · General Medicine` with **no doctor name**, and the
embedded `doctor_specializations…profiles(full_name)` returned `profiles: null`
for the receptionist. Root cause: **migration 61 is applied only to the local
DB and is NOT deployed to staging**, and the deployed bundle predates the
in-repo label fix. Assignment itself worked (correct doctor UUID persisted).

## 11. Token results
`PROVEN STAGING` — Token 6 generated and displayed on the confirmation page.
`DEFECT FOUND (minor, deploy-independent)`: the confirmation shows **neither
the assigned doctor nor the queue/session**, so reception cannot tell from that
page whether the walk-in entered a queue (the queue board does show it).

## 12. Queue results
`PROVEN STAGING` for membership/position: `POST /functions/v1/queue-control` →
200; the walk-in appears at **position 1** as `Token 6 · STAGING WALKTHROUGH
TEST · booked`. `PROVEN LOCAL ONLY` for the doctor-name queue label — staging
shows the synthesized `Session 1` (stale bundle; local QueueBoard fix not
deployed). `queue_sessions.session_name` is `NULL` in staging data.

## 13. Doctor workflow results
`PROVEN STAGING` — as `dr@surya.test`: dashboard "Doctor console" listed the
patient (Pos 1, Token 6); **Call next** moved `booked → called` and emptied the
waiting list; all actions routed to
`POST /functions/v1/doctor-operations` → 200.

## 14. Consultation results
`PROVEN STAGING` — **Start consultation** moved `called → in consultation`;
separate "Consultation note" and "Diagnosis summary" fields saved via
`doctor-operations` (`save_note`) → 200; **Complete** moved the booking to
`completed` with real DB timestamps (`consultation_started_at` and
`consultation_completed_at` ~30 s apart) and cleared the live queue.
`DEFECT FOUND (completeness)`: saved note/diagnosis are persisted but **not
surfaced in any staff UI** — `BookingDetail` renders only booking/billing
fields, and there is no doctor-facing history route. Persistence is
`PROVEN STAGING`; in-app readability of clinical notes is `NOT IMPLEMENTED`.

## 15. Finance results
`PROVEN STAGING (display/state)` and consistent with **D16**: the completed
booking showed **Payment = Pending**, Platform/Booking/Hospital/Total fee
snapshot = ₹0 for SETURA-side fees, and the hospital consultation fee
(`₹300` on the specialization) kept separate from SETURA's platform fee — i.e.
no incorrect full-consultation amount presented as SETURA revenue.
`BLOCKED BY EXTERNAL DEPENDENCY` for any live capture: **no Razorpay request
was fired and no money moved** (no credentials authorized).

## 16. History results
`PROVEN STAGING` — the completed visit is retrievable:
`/bookings/49a019c8-…` shows Status `completed`, Token 6, Source `walkin`,
Date `2026-09-22`, and both consultation timestamps.

## 17. Tenant-isolation result
`PROVEN STAGING` — logged in as `reception-b@surya.test` (Tenant B `…0002`):
dashboard 0 bookings; patients search by name AND by phone → "No matches";
queue "No active queue sessions today"; a **direct deep-link to Tenant A's
booking id** rendered "Booking not found or not visible to your account" backed
by `GET /rest/v1/bookings?hospital_id=eq.…0002&id=eq.…` → **200 with an empty
result set** (correct RLS tenant-filter shape — no data leak, no 5xx, no
existence leak). Zero foreign rows visible. Re-login as reception confirmed
Token 6 as `completed` and left the environment clean.

## 18. Console / network observations
`PROVEN STAGING` — zero console messages (errors/warnings/logs) at all three
checkpoints; every app request 2xx (200, or 204 logout); backend host was
staging-only; **no CORS failures, no auth failures, no localhost/production
requests, no secrets in request URLs**. Two `4xx`s seen were the automation
probing REST directly (wrong apikey/column guesses), never from the app.

## 19. Backend-state verification
Browser evidence corroborated against staging DB/API:
`create-booking` 201 → booking row exists (doctor + queue_session set);
queue-control 200 → position 1; doctor-operations 200 chain → status
`booked→called→in consultation→completed` with `consultation_started_at` /
`consultation_completed_at` persisted; foreign-tenant booking read → empty set.
No staging schema was altered to make the walkthrough pass.

## 20. Defects found
1. **Doctor-name visibility + loading state + queue session label** render the
   pre-fix behavior on staging (`No doctors available` flash; `General Medicine
   · General Medicine`; `Session 1`). These are **already fixed in the
   workspace/local** (migration 61 + `BookingForm.tsx` + `reads.ts` +
   `QueueBoard.tsx`); staging simply runs a **stale build + a DB missing
   migration 61**. Classification: **deploy gap**, not a new code defect.
2. **Consultation note/diagnosis not readable in the UI** after save
   (genuine frontend completeness gap; D5/D13-independent).
3. **Booking confirmation omits assigned doctor + queue/session** (minor UX;
   D5/D13-independent).
4. **Observation (not proven defect):** `create-booking` latency ~20–25 s on
   staging — consistent with Edge Function cold start, not reproduced as a code
   defect.

## 21. Defects fixed
**None in this phase.** No code was changed: the only correctness gaps on
staging (#20.1) are already fixed in source and are blocked behind a
**staging deploy** (migration 61 + frontend rebuild), and #20.2/#20.3 are new
product-completeness items that the phase boundary says to surface as next
priorities rather than build inline. Per the phase rules, no production or
external credential was used as a workaround.

## 22. Regression results
No code changed during this walkthrough, so §16 requires only targeted
verification, not a full re-run. The most recent full local regression (prior
product-completion phase, against the same unmodified workspace) stands:

| Gate | Count |
| --- | --- |
| `validate:migrations` | 61 files, 0 errors, 4 baseline warnings |
| `validate:migration-manifest` | 61 / 61, 0 integrity issues |
| Deno unit | 97 passed / 0 failed |
| Full integration | 235 passed / 0 failed (incl. `staff_doctor_directory` 9/9) |
| E1 journey + D16 financial | 29 passed / 0 failed |
| Frontend vitest | 28 passed / 0 failed |
| Frontend typecheck / build | clean / exit 0 |

## 23. Remaining blockers
- **Live payment capture (Razorpay)** — `BLOCKED BY EXTERNAL DEPENDENCY`; no
  credentials, no real money.
- **Upgrade of doctor-name evidence from PROVEN LOCAL to PROVEN STAGING** —
  `BLOCKED` behind a staging deploy (migration 61 + frontend rebuild), which
  requires owner authorization.
- **Clinical-note UI surfacing / booking-confirmation doctor+queue display** —
  `NOT IMPLEMENTED` (identified, not yet built).

## 24. Production boundary statement
See §25 mandatory block. Production was not entered.

## 25. Final evidence classification (per step)

| Walkthrough step | Classification |
| --- | --- |
| Backend host = staging, no prod/localhost | PROVEN STAGING |
| Reception auth + dashboard | PROVEN STAGING |
| Patient create (implicit) / search / history | PROVEN STAGING |
| Walk-in → booking → Token 6 (201) | PROVEN STAGING |
| Doctor assignment persists in DB | PROVEN STAGING |
| Doctor **name** in picker / queue | PROVEN LOCAL ONLY (staging stale: migration 61 + build not deployed) |
| "No doctors available" loading-state fix | PROVEN LOCAL ONLY (staging stale) |
| Queue membership / position / queue-control | PROVEN STAGING |
| Doctor console: call → consult → note/diagnosis → complete | PROVEN STAGING |
| Consultation note/diagnosis readable in UI | NOT IMPLEMENTED |
| Booking confirmation shows doctor/queue | DEFECT FOUND (minor) — not fixed here |
| Completion DB state (status + timestamps) | PROVEN STAGING |
| History of completed visit | PROVEN STAGING |
| Finance display (₹0 SETURA fee, Pending) | PROVEN STAGING (consistent with D16) |
| Live payment capture | BLOCKED BY EXTERNAL DEPENDENCY |
| Tenant isolation (Tenant B sees zero A rows) | PROVEN STAGING |
| Console / network cleanliness | PROVEN STAGING |
| `create-booking` ~20–25 s latency | UNPROVEN as defect (likely cold start) |

---

## MANDATORY FINAL BOUNDARY

```text
This walkthrough proves only the staging environment.

STAGING PROOF ≠ PRODUCTION PROOF.

Production was not entered.
No production infrastructure was created.
No production credentials were provisioned.
No real money was moved.
No production patient data was created.
D5 and D13 remain DEFERRED BY OWNER.
```
