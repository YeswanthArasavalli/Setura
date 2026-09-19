# PHASE 6 — STAFF FRONTEND / OPERATIONAL CONSOLE

Thin React client over the already-proven SETURA backend (Edge Functions →
RPCs → PostgreSQL/RLS). The frontend owns **no business logic**; every
privileged operation calls an existing endpoint. All verification below is
against the **local** Supabase stack and is **not** production verification.

Status vocabulary per AGENTS.md §5: PROVEN · IMPLEMENTED · BLOCKED · DEFERRED ·
NOT IMPLEMENTED. No percentages. No production-readiness claim.

---

## A. Executive result

A real hospital employee can, **through the browser, against the live local
backend**:

- Sign in (Supabase Auth) as a receptionist or a doctor and be routed to the
  console their **database-resolved role** allows.
- On the reception dashboard, see today's real bookings and live stats read
  from the `bookings` table under RLS.
- Register/find a patient and create a **walk-in** or **appointment**; the
  backend allocates the token, applies the fee snapshot and de-dupes the
  patient by phone.
- Assign a doctor so the booking enters that doctor's **callable queue**.
- Open the **queue board**, see the live snapshot, and pause/resume intake.
- As the doctor: see the waiting queue, **call next**, **start consultation**,
  **save a note**, and **complete** the consultation.
- See the booking's **payment/billing snapshot state** and the consultation
  timestamps, and view a patient's full authorized **history**.

Proven by: a scripted real-backend E2E (19 checks, all PASS) replaying the
exact HTTP contracts the `api/` layer sends, **and** a browser-driven pass
through the actual React UI (9/9 checkpoints, zero console errors).

---

## B. Implemented screens (routes / components)

| Route | Component | Purpose |
| --- | --- | --- |
| `/login` | `routes/Login.tsx` | Email/password sign-in; role+tenant resolved after auth. |
| `/` (index) | `App.tsx → Landing` | Role redirect: doctor → `/doctor`, staff → `/reception`. |
| `/reception` | `routes/ReceptionDashboard.tsx` | Today's bookings + waiting/current/completed stats. |
| `/reception/book` | `routes/BookAppointment.tsx` | Appointment (`manual_free`) via shared `BookingForm`. |
| `/reception/walk-in` | `routes/WalkIn.tsx` | Walk-in (`walkin`) via shared `BookingForm`. |
| `/reception/patients` | `routes/Patients.tsx` | Search patients + full visit history. |
| `/queue` | `routes/QueueBoard.tsx` | Live snapshot, session selector, intake controls. |
| `/doctor` | `routes/DoctorConsole.tsx` | Start session → call → consult → note → complete. |
| `/bookings/:bookingId` | `routes/BookingDetail.tsx` | Status, token, payment/billing snapshot, consult times. |

Shared: `components/AppShell.tsx` (role-filtered nav + tenant display +
sign-out), `components/BookingForm.tsx` (find-existing + patient fields +
**doctor picker** + double-submit guard), `components/ui/*` (button, card,
input/textarea, label, badge+statusVariant, table), `auth/{AuthProvider,
RequireRole,context}`, `hooks/useAsyncAction`.

38 TypeScript/TSX modules under `apps/web/src`.

---

## C. API integration (frontend → backend mapping)

No endpoint was invented. Every mapping below was read from the backend source
and exercised at runtime.

| Screen | Call | Edge Function / table | Auth | Error handling |
| --- | --- | --- | --- | --- |
| Login | `signInWithPassword` | Supabase Auth | — | Invalid-credentials message surfaced. |
| Any staff screen | `resolveStaffContext` | `user_roles` + `profiles` (RLS SELECT) | Bearer JWT | Context-failure message. |
| Dashboard | `listTodaysBookings` | `bookings` (RLS SELECT) | Bearer JWT + `.eq(hospital_id)` | Banner via `describeError`. |
| Patients | `searchPatients` / `listPatientHistory` | `patients` / `bookings` (RLS) | Bearer JWT | Banner. |
| Booking form (doctor picker) | `listHospitalDoctors` | `doctor_specializations` (RLS `doctor_spec_read`) | Bearer JWT | Degrades to "No doctors available". |
| Book / Walk-in | `createBooking` | `create-booking` Edge Function | JWT + role `receptionist/doctor/hospital_admin/global_admin` + `X-Hospital-ID` + **UUID-v4 `Idempotency-Key`** | 401/403/422/409/429/5xx mapping + `fieldErrors`. |
| Queue board | `getQueueSnapshot` / `queueControl` | `queue-control` Edge Function | JWT + role + `X-Hospital-ID` | Banner; every action returns fresh snapshot. |
| Doctor console | `doctorOps.{dashboard,start_session,call_next,start_consultation,save_note,complete_consultation,recall}` | `doctor-operations` Edge Function | JWT + role `doctor/hospital_admin/global_admin` | Banner; 422 field errors. |
| Booking detail | `getBooking` | `bookings` (RLS SELECT) | Bearer JWT + `.eq(hospital_id)` | "not found or not visible" state. |

`lib/api.ts` is the single Edge Function caller: sets `apikey` (anon),
`Authorization: Bearer`, `X-Hospital-ID`, optional `Idempotency-Key`; parses the
`{success,data}` / `{success:false,error}` envelope and throws `ApiError`.

---

## D. Files changed

**New — frontend app** (`apps/web/`):
- Config: `package.json`, `tsconfig.json`, `tsconfig.node.json`,
  `vite.config.ts`, `tailwind.config.ts`, `postcss.config.js`, `index.html`,
  `.gitignore`, `.env.example`, `.env.local` (local demo anon key only).
- Source: 38 modules listed in §B (under `apps/web/src/**`).
- Real-backend E2E harness: `apps/web/e2e/core_journey.mjs`.

**Backend:** **no product files modified.** (See §E and §J.)

`database.generated.ts`, migrations, and Edge Functions were not touched. The
working tree is not a Git repo (AGENTS.md §13), so "changed" means direct file
presence/inspection, not `git diff`.

---

## E. Backend changes

**None.** The doctor-assignment gap (the one integration problem that could
have justified a new endpoint) was solved purely with an **existing** RLS read
surface (`doctor_specializations`) plus passing the already-supported
`doctorId` field of `create-booking`. No new Edge Function, RPC, migration or
grant was added, so S1 privilege posture is unchanged.

### Local environment remediation (NOT a product change)
Earlier in this work, browser/API login returned HTTP 500 from GoTrue
(`Scan error ... "email_change": converting NULL to string is unsupported`)
because the seeded `auth.users` rows have NULL in nullable, no-default columns
the running GoTrue cannot scan. This is a **local seed/environment defect**, not
a frontend or product-code issue. It was remedied with non-destructive,
local-only UPDATEs that set those columns to `''` for the 4 seed accounts. This
change lives only in the local database; it is not in any committed file and is
recorded as an open finding in §J.

---

## F. Tests — exact commands and results

Toolchain: Node 24 / npm 11, Vitest 2 + @testing-library/react + jsdom.
(esbuild's blocked postinstall was restored with `npm rebuild esbuild`.)

```
cd apps/web
npm run build      # tsc --noEmit && vite build
npm run test       # vitest run
```

**Build:** `tsc --noEmit` clean; `vite build` → 110 modules transformed,
`✓ built`, exit 0.

**Unit tests (frontend pure logic — 3 files, 17 tests, all pass):**
- `lib/errors.test.ts` (12): `ApiError.kind` status→intent mapping
  (0/401/403/422/409/429/500/503/other) and `describeError` never leaking raw
  backend detail for auth/forbidden/rate-limit while surfacing client-safe
  validation/conflict messages.
- `lib/idempotency.test.ts` (2): key is a **bare UUID v4** matching the backend
  regex (regression lock against the scope-prefix bug found in §J) and is
  unique across 500 calls.
- `hooks/useAsyncAction.test.ts` (3): double-click invokes the backend **once**
  and reuses one key; a fresh key only after `reset`; on failure the error is
  exposed and a retry reuses the same key.

```
Test Files  3 passed (3)
     Tests  17 passed (17)
```

---

## G. E2E evidence (the actual staff journey, real backend)

### G.1 Scripted contract-level E2E — `node apps/web/e2e/core_journey.mjs`
Replays the exact headers/bodies the `api/` layer sends. **19 checks, all PASS:**

- receptionist login → JWT; receptionist can read assignable doctors (RLS).
- walk-in **without** a doctor → 201 but **`queueSessionId: null`** (token
  issued, not in any callable queue) — the behavior that motivated the picker.
- walk-in **with** a doctor → 201, attached to a queue session, token issued.
- **replay of the same `Idempotency-Key` returns the same `bookingId`** (no dup).
- `queue-control` snapshot → the booking appears in `waiting`.
- doctor login → `start_session` → `call_next` → `start_consultation` →
  `save_note` → `complete_consultation` all 200.
- receptionist reads the booking via PostgREST/RLS: status `completed`,
  `consultation_completed_at` set; **cross-tenant filter returns 0 rows**.

```
— E2E PASSED —   (exit 0)
```

### G.2 Browser-driven E2E — actual React UI at `http://localhost:5173`
9/9 checkpoints PASS, **zero red console errors**. Screenshots:
`.remember/tmp/step1_login.png` … `step9_reception_dashboard_after.png`.

Login (reception) → dashboard (table populated) → walk-in form (doctor
selected) → submit → booking detail **token 60**, status badge, billing card →
queue board (token 60 in Waiting) → logout → doctor login → console → **Call
next** → "Now: Browser Test Patient #60" → **Start consultation** → "In
consultation" + note/diagnosis fields → back to reception: dashboard renders,
token 60 shows "in consultation". Step 9 also confirmed the **role guard**: while
still the doctor, `/reception` redirected back to `/doctor`.

This demonstrates the full §27 journey end-to-end with the backend as source of
truth (no backend mocking; external Meta/Razorpay never entered this slice).

---

## H. Security — how the frontend preserves it

- **RLS / tenant isolation:** all reads go through the anon+JWT client and are
  filtered by RLS; an explicit `hospital_id` filter is added defensively but the
  database is the boundary. Cross-tenant read probe returned 0 rows (§G.1).
- **Role authorization is server-side:** the Edge Functions re-resolve role from
  `user_roles` on every call. The client's role/tenant (from
  `resolveStaffContext`) is used **only to decide what to render** and is never
  trusted for security. A doctor hitting a reception route is blocked by the
  backend's `requireRole`; the client `RequireRole` is a UX guard, not the
  boundary.
- **JWT:** real Supabase Auth session; `Authorization: Bearer` + `apikey`
  (anon) only.
- **Service-only boundaries:** the **service-role key is never present in or sent
  from the browser**. Privileged writes (booking, queue, consultation, fees) go
  exclusively through Edge Functions that use `getServiceClient()` server-side.
- **No secrets committed:** `.env.local` holds only the deterministic public
  local demo anon key; `.env` is git-ignored; `.env.example` has placeholders.
- **Injection:** PostgREST calls use the typed client builder (parameterized
  filters); no untrusted string is interpolated into SQL.
- **Backend security was not weakened** to make the frontend easier (§25): no
  policy, grant or RLS change was made.

---

## I. External blockers (kept at their real boundary)

| Boundary | State |
| --- | --- |
| **Meta / WhatsApp** | No `META_APP_SECRET`/tokens in the local Edge Runtime; outbound confirmation/reminder jobs are **enqueued** but delivery was **not exercised**. Out of slice scope. |
| **Razorpay** | No Razorpay secrets locally; `payment_enabled=false` for the seed hospital. The console **displays** the backend's payment/fee snapshot only; no live payment was run. |
| **Production** | No deployment exists. Everything above is **local** verification. Production privilege/payment/notification state remains **UNPROVEN** and is **not** claimed. |

---

## J. Remaining product decisions (NOT silently resolved)

1. **Walk-in/appointment doctor assignment.** `create-booking` only attaches a
   booking to a callable queue when a `doctorId` is present; a doctor-less
   booking gets a token but `queueSessionId: null` (proved in §G.1). The picker
   now makes this explicit, but whether the product should **require** a doctor
   (or route doctor-less walk-ins to a general queue) is an open decision.
2. **Doctor names for receptionists.** `profiles` is readable by self or
   `hospital_admin` only, so a receptionist's picker shows specialization, not
   the doctor's name. Exposing doctor display names to reception is a privacy/RLS
   product decision, not worked around here.
3. **Local GoTrue seed defect (§E).** Seeded `auth.users` NULL columns break
   login on the current GoTrue until remediated. Whether to fix the seed, the
   migration, or pin GoTrue is a backend/environment decision.
4. **Notifications screen** is **NOT IMPLEMENTED** in this slice; the backend
   notification jobs exist but there is no staff-facing notifications UI yet.
5. **Scheduler / worker defaults** (AGENTS.md §13: no scheduler;
   `ENABLE_WORKER_TRIGGER=false`) mean reminders/rollups do not run
   autonomously locally. Not a frontend concern but bounds what "the console
   shows real state" can prove.

---

## K. Acceptance matrix

| Phase 6 Criterion | Status | Evidence |
| --- | --- | --- |
| Authentication | PROVEN | Browser + API login (recep/doctor); §G. |
| Role-aware routing | PROVEN | Landing redirect + step-9 role-guard redirect. |
| Tenant context | PROVEN | `X-Hospital-ID` from `user_roles`; cross-tenant read empty. |
| Reception dashboard | PROVEN | Browser step 2 (RLS-sourced table+stats). |
| Patient registration | PROVEN | Walk-in created patient via `create-booking`; §G. |
| Appointment | IMPLEMENTED | `manual_free` uses the identical, runtime-proven `create-booking` path (browser run exercised `walkin`). |
| Walk-in | PROVEN | Browser steps 3–4; §G.1. |
| Token | PROVEN | Token 60 issued + shown; §G. |
| Queue | PROVEN | Snapshot shows token in Waiting; pause/resume wired. |
| Doctor console | PROVEN | Browser steps 6–8; §G.1 doctor chain 200s. |
| Consultation | PROVEN | start/complete 200; `consultation_completed_at` on read. |
| Billing/payment state | PROVEN | Booking-detail snapshot card; §G. |
| Notifications | NOT IMPLEMENTED | Out of slice scope; no staff UI (§J.4). |
| Patient history | IMPLEMENTED | `Patients.tsx` `listPatientHistory`; underlying RLS read PROVEN (same table/policy); screen not individually browser-clicked. |
| Error handling | PROVEN | Unit tests (12) for mapping/leak-safety; banners wired in every screen. |
| Duplicate submission protection | PROVEN | Unit tests (once-per-submit, stable key) + API idempotent replay. |
| Tenant isolation | PROVEN | Cross-tenant read returns 0 rows; explicit `hospital_id` filters + RLS. |
| Backend authorization preserved | PROVEN | Zero backend/security changes; server re-authorizes every call. |
| Frontend E2E journey | PROVEN | Browser 9/9 + scripted 19/19 against real backend. |

---

## L. Final status

```text
PHASE 6 COMPLETE — WITH BLOCKED EXTERNAL/ENVIRONMENT EVIDENCE
```

The core operational journey is implemented and proven end-to-end through the
real UI against the real local backend. Meta/Razorpay/production evidence is
BLOCKED/UNPROVEN at their actual external boundaries (not attempted), and the
open product decisions in §J remain unresolved by design.

This is **not** a production-readiness claim. Phase 7 is **not** started.
