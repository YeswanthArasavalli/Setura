# G-07 — STAGING & BROWSER VERIFICATION REPORT

Scope: **deploy + verify G-07 (Staff Booking Reschedule) on the existing
staging environment and run real-browser / runtime acceptance.** No
redesign, no implementation re-investigation, no new features, **no
production touch**. The authorized local implementation
(`PHASE_7_G07_STAFF_BOOKING_RESCHEDULE_IMPLEMENTATION_REPORT.md`) is the
baseline; this session moves it across the evidence boundary from
`INTEGRATION VERIFIED` (local) toward `PROVEN STAGING`.

Evidence vocabulary is used strictly: **PASS** = exercised *in the named
environment* and passed; **UNPROVEN** = not exercised there; **BLOCKED** =
could not be exercised due to an environment/fixture/dependency blocker;
**NOT TOUCHED** = intentionally out of scope (production). Local PASS is
never silently converted into a staging PASS.

---

## 1. Baseline before this session

| Fact | Value | Evidence |
| --- | --- | --- |
| Repo state | Working tree **clean**, `main` at `da5332e` "Staff booking reschedule + G-06 closure", in sync with `origin/main` | `git status`, `git branch -vv` |
| G-07 commit | `da5332e` dated **2026-09-30** (already committed & pushed) | `git show -s` |
| Option-B fix present in source | `reschedule-booking/index.ts` `.update()` writes only `status`/`updated_at`; **no `rescheduled_at`/`rescheduled_by`** | `Select-String` on source |
| Prior report | local: integration 13/13, Deno unit 97/97, FE 235/235 (sequential), WhatsApp 28/28 | implementation report §11 |

## 2. Deployment method (established, not invented)

- **CI** (`.github/workflows/ci.yml`) is **validate-only — it deploys
  nothing** (explicit header + §22 of
  `PHASE_7_G7_02_DEPLOYMENT_ARCHITECTURE.md`). So staging deploy is a
  deliberate, task-authorized action, not an automatic CI step.
- **Frontend**: Vercel project `setura` (root `apps/web`), auto-built from
  the pushed `main` (`da5332e`).
- **Backend Edge Function**: Supabase CLI **linked & authenticated** against
  the staging project ref `gzcqasntcbqqmgsoikms` (region ap-south-1) —
  `supabase functions deploy reschedule-booking`. This was the actual gap:
  staging `reschedule-booking` was **VERSION 7 (2026-09-20)**, i.e. it
  predated the `da5332e` fix and was **stale**.

## 3. Deploy actions performed this session

1. `npm run typecheck` (apps/web) → **exit 0**.
2. `npm run build` (apps/web) → **exit 0**, 124 modules,
   `dist/assets/index-D9fImSdf.js` produced; local bundle contains
   `reschedule-booking` + `Rescheduled`.
3. `supabase functions deploy reschedule-booking` → deployed to
   `gzcqasntcbqqmgsoikms`; `supabase functions list` now shows
   `reschedule-booking` **VERSION 8, ACTIVE, 2026-09-30**. **Backend G-07 fix
   is live on staging.**

## 4. Deployed revision & bundle verification (§8)

| Layer | Live evidence | Result |
| --- | --- | --- |
| Backend function | staging `reschedule-booking` v8 (was v7 pre-fix) | **G-07 present** |
| Frontend | live `https://setura-delta.vercel.app` → HTTP 200, references `/assets/index-CYlPfH8B.js` (509,450 bytes) | bundle contains `reschedule-booking` = **true**, `Rescheduled` = **true** |

The deployed frontend bundle is **not stale** — it carries G-07. (Hash
differs from the local build because Vercel's build environment hashes
differently; content markers are what matter and they are present.)

## 5. Staging environment

- Frontend: `https://setura-delta.vercel.app`
- Functions base: `https://gzcqasntcbqqmgsoikms.supabase.co/functions/v1/*`
- Fixtures used: repository deterministic seed identities —
  `admin@surya.test` (hospital_admin, tenant …0001), `reception@surya.test`
  (receptionist, …0001), `dr@surya.test` (doctor, …0001),
  `reception-b@surya.test` (receptionist, tenant …0002), all sharing the
  seed password documented in `supabase/seed.sql` (public, not a production
  secret; not reproduced here).

## 6. Real-browser / runtime results

### 6.1 Hospital admin happy path (browser)
- Login → `/admin`, role `hospital admin`, tenant …0001. **PASS**
- Open a `booked` booking (Token 1, `/bookings/1533cce8-…`) → **Reschedule**
  card + "Reschedule booking" button visible. **PASS**
- Ineligible statuses (`skipped`, `completed`) → **no** Reschedule card,
  substring "reschedul" absent. **PASS** (render gate matches
  `RESCHEDULABLE_STATUSES = [booked, checked_in, waiting]`).
- Controlled reschedule, submitted **once** (date 2026-10-02, reason
  "G-07 staging verification"): POST `…/functions/v1/reschedule-booking` →
  **HTTP 200**; success banner (captured DOM text)
  `Rescheduled to 2026-10-02 · new token 1`; original flips `booked →
  rescheduled`; **exactly one** new booking created
  (`24c70c8c-…`, booked, 2026-10-02); detail **refetched from server**
  (reload still shows `rescheduled`) — no optimistic fake state. **PASS**

### 6.2 Receptionist path (browser)
- Login → `/reception`, role `receptionist`. **Reschedule booking** visible
  on a `booked` booking (`75795f7d-…`). **PASS**
- One controlled reschedule (2026-10-05, reason "G-07 receptionist staging"):
  POST → **HTTP 200**, banner `Rescheduled to 2026-10-05 · new token 1`,
  original → `rescheduled`, exactly one new booking
  (`77e56254-…`, booked, 2026-10-05) verified by an RLS-scoped read. **PASS**

### 6.3 Doctor denial (server-side, not just UI hiding)
- Doctor console (`/doctor`) renders **no** Reschedule action; doctor also
  had **zero** RLS-visible `booked` bookings, so the exact "open a booked
  booking as doctor" UI case is fixture-**BLOCKED** (recorded, not
  fabricated).
- **Direct endpoint probe** with the doctor's JWT, valid header …0001, real
  booked bookingId → **HTTP 403**,
  body `{"error":{"code":"ROLE_INSUFFICIENT","message":"… Required:
  receptionist or hospital_admin or global_admin, actual: doctor"}}`.
  Non-mutation verified: target still `booked`; no booking created after the
  probe. **PASS** (server-side role boundary).

### 6.4 Tenant isolation
- The literal "Hospital-A user + Hospital-B booking" direction is
  fixture-**BLOCKED**: Tenant B (`…0002`) has **no bookings** in staging
  (RLS read `*/0`; corroborated by `_tmp_s10/tenant_b_check.log` and
  `PHASE_7_BOOKING_CONFIRMATION_ENHANCEMENT_REPORT.md`).
- The **same DB guard** was proven live via equivalent in-data probes, all
  denied with **zero mutations**:
  - Tenant-B actor, own header …0002, targeting a Tenant-A booking → **403
    FORBIDDEN** `{"code":"FORBIDDEN","message":"Booking belongs to different
    hospital"}` (this is the `orig.hospital_id !== hospitalId` check).
  - Tenant-B actor spoofing `X-Hospital-ID: …0001` (role not held there) →
    **403 HOSPITAL_ACCESS_DENIED**.
  - Admin-A spoofing `X-Hospital-ID: …0002` → **403
    HOSPITAL_ACCESS_DENIED**.
  - Control (valid header, non-existent bookingId) → **422 VALIDATION_ERROR
    "Booking not found"** (note: 422, not 404).
- Post-probe re-check: Tenant B still empty; attacked booking unchanged.
  **PASS** (cross-tenant + fail-closed role resolution enforced server-side
  in staging); exact A→B fixture direction **BLOCKED**.

### 6.5 Failure behavior
- Past date (2026-09-28) via UI → **HTTP 422**, message `Cannot reschedule
  to past date`; booking unchanged, no new booking. **PASS**
- Same-day / too-far / holiday / doctor-unavailable were **not**
  independently exercised in staging (local integration proof retained) →
  **UNPROVEN IN STAGING**.

### 6.6 Network evidence (§11)
- Exactly **one** `POST /functions/v1/reschedule-booking` per intended
  reschedule; **no** calls to payment / refund / settlement / direct WhatsApp
  delivery / worker / scheduler.
- Headers on the deployed shared `callFunction` path: `apikey`,
  `Authorization: Bearer …`, `X-Hospital-ID`, and (for mutations)
  `Idempotency-Key` — **present**. `hospital_id` is **NOT** a trusted body
  field: the deployed bundle contains **0** occurrences of `hospital_id:`;
  tenant travels only via the `X-Hospital-ID` header. Body keys sent:
  `bookingId`, `newDate`, `reason`.
  - Honesty note: the browser network tool exposes no request-header detail
    and the header spy was installed after the first POST, so the admin
    reschedule's headers were proven via (a) the same deployed code path on
    Command-Centre reads and (b) the deployed bundle's header-construction
    code — not a literal capture of that one request.

### 6.7 Console evidence (§19)
- **No application JS errors/exceptions** across both sessions. The only
  console entries were the deliberate probe responses (`403`, `422`
  resource-load lines) from the doctor / cross-tenant tests. **CLEAN** for
  G-07.
- Known app-wide residual (NOT a G-07 defect): Command Centre (`/admin`) and
  booking-detail pages exhibit unbounded remount/refetch churn (repeated
  identical `profiles` / `user_roles` GETs and `POST command-center`
  cycles). Read-only, no data effect. Documented under §20.

### 6.8 UI/UX (§18) & regression
- No optimistic fake state; refetch after mutate; success banner truthful;
  errors visible; submit disabled until valid; repeated clicks prevented
  (single POST observed).
- Existing BookingDetail actions still render on eligible bookings:
  **Cancel booking**, **Check In**, **Mark No-Show**, alongside Reschedule —
  coexisting, not mutated. The rescheduled-into booking renders the full
  action set (normal booking). No G-07-caused regression observed.

## 7. Regression verification
- Local suite carried forward from the implementation report: Deno unit
  **97/97**, frontend **235/235** (sequential), WhatsApp **28/28**, staff
  reschedule integration **13/13**. (Not re-run this session; staging work
  added no source change — the deployed function was redeployed from the
  already-tested `da5332e`.)
- Staging browser regression: Cancel / Check-In / Mark-No-Show still render
  and are unaffected; a normal (non-rescheduled) booking behaves normally.
  **PASS** at the browser surface level.

## 8. Known residuals observed (separate defects, NOT modified here)
- **Auth-refresh / remount churn** (app-wide): confirmed live and worse than
  background noise on `/admin` (unbounded `command-center` request cycles,
  request count 477→533 in ~1 min idle). Pre-existing; tracked separately.
  Not fixed (out of scope, §20/§27).
- **`x-error-code` response header is `null`** on denials — the machine code
  (`ROLE_INSUFFICIENT`/`FORBIDDEN`/`HOSPITAL_ACCESS_DENIED`/
  `VALIDATION_ERROR`) is only in the JSON body. Recorded as an observation;
  not a G-07 blocker.
- Doctor and Tenant B fixtures lack data (no booked bookings for the doctor;
  no bookings for Tenant B) → certain literal UI directions are
  fixture-BLOCKED; equivalent probes covered the underlying guard.

## 9. Production status
**NOT TOUCHED.** No production project, no production deploy, no production
env-var or DB change, no production claim. Staging evidence is not promoted
to production readiness.

## 10. Acceptance matrix

| Requirement | Local evidence | Staging / browser evidence | Status |
| --- | --- | --- | --- |
| Schema correct | 13/13 integration | deployed code; no migration (Option B); no `rescheduled_*` | **PASS** |
| Endpoint works | 13/13 integration | real staging HTTP **200** (admin + receptionist) | **PASS** |
| Hospital-admin UI | unit | browser: visible on booked, hidden on terminal, banner, server refetch | **PASS** |
| Receptionist UI | unit | browser: visible + one 200 reschedule | **PASS** |
| Doctor denial | integration | browser **direct endpoint 403 ROLE_INSUFFICIENT**, no mutation | **PASS** |
| Tenant isolation | integration | browser: cross-tenant 403 FORBIDDEN + header-spoof 403 HOSPITAL_ACCESS_DENIED, 0 mutation | **PASS** (guard); literal A→B fixture **BLOCKED** |
| Idempotency | integration | UI: one logical key per action, single POST, no duplicate | **PASS** (UI-level); staging replay **UNPROVEN** |
| Concurrency | integration (200+409) | not browser-exercised (local proof retained) | **PASS (local)** / staging **UNPROVEN** |
| Audit (1 row) | integration | not read in staging (hosted DB not exposed to these roles) | **PASS (local)** / staging **UNPROVEN** |
| Notification enqueue | integration | not read in staging (`job_queue` not observed) | **PASS (local)** / staging **UNPROVEN** |
| Failure behavior | integration | past-date 422 in staging; same-day/too-far/holiday/unavailable not exercised | **PASS** (past-date) / others **UNPROVEN** |
| Regression | 97/97 + 235/235 + 28/28 | Cancel/Check-In/No-Show still render; no G-07 regression | **PASS** |
| Browser console | N/A | no JS exceptions; only deliberate probe 403/422 | **PASS** |
| Network behavior | integration | single POST to reschedule-booking; auth/apikey/X-Hospital-ID/Idempotency present; no `hospital_id` body; no side-effect endpoints | **PASS** |
| Staging deployment | N/A | backend v8 deployed this session; frontend bundle carries G-07 | **PASS** |
| Production | N/A | intentionally untouched | **NOT TOUCHED** |

## 11. Closure decision

The §21 completion set — **deployment + real browser + real backend request +
correct result + role verification + network verification + console
verification** — was actually exercised on staging and passed:

- deploy: backend v8 + frontend bundle verified
- real browser: admin & receptionist happy paths, terminal-status gating
- real backend request: `POST /functions/v1/reschedule-booking` → **200**,
  correct DB outcome (original `rescheduled`, exactly one new booking)
- role verification: doctor **403** server-side; receptionist/admin allowed
- tenant isolation: cross-tenant **403** guard exercised live (equivalent
  direction; literal A→B fixture BLOCKED)
- network + console: verified clean and correct

The items that remain **UNPROVEN in staging** (audit row, notification
enqueue, staging replay/concurrency) are backend-side effects not exposed to
the staging browser/roles; each retains **local integration proof** and is
listed honestly rather than inflated. None is a discovered G-07 defect, and
none required a source change this session.

```text
G-07:
PROVEN STAGING — CLOSED
```

G-03 / G-05 / G-06 remain PROVEN STAGING — CLOSED (unchanged by this session).

```text
AUTH-REFRESH / REMOUNT CHURN:  KNOWN SEPARATE DEFECT — NOT MODIFIED
GIT HYGIENE:                   KNOWN DEBT — NOT MODIFIED
PRODUCTION:                    NOT TOUCHED
```

No source code was changed this session (verification-only); no commit, no
force-push, no history rewrite; `9f4a2c8` not amended. The only environment
change was the task-authorized staging `functions deploy` of
`reschedule-booking` (v7 → v8).
