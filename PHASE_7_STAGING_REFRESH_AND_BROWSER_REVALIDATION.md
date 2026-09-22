# PHASE 7 — STAGING REFRESH AND BROWSER REVALIDATION

**Date:** 2026-09-22 · **Scope:** STAGING ONLY (`setura-staging` / `gzcqasntcbqqmgsoikms`)
**Successor to:** `PHASE_7_CONTROLLED_STAGING_BROWSER_WALKTHROUGH.md` (which found staging stale)

---

## 1. Authorization

Owner explicitly authorized a staging-only refresh:

1. Apply migration 61 to STAGING (`setura-staging`, ref `gzcqasntcbqqmgsoikms`).
2. Rebuild the frontend containing the doctor-name directory/picker, loading/
   error/empty picker states, de-duplicated doctor label, and QueueBoard
   doctor-name labeling.
3. Redeploy the **existing** staging-backed Vercel frontend
   (`https://setura-delta.vercel.app`) — no second Vercel project.
4. Re-run the controlled browser walkthrough for the affected flows.
5. Run a full regression (schema + frontend both changed).

Strict boundary honored: no production project, infrastructure, secrets,
users, or data; no live Razorpay; no real money; no production Meta/WhatsApp
or SMTP; no domain purchase; **D5 and D13 remain `DEFERRED BY OWNER`**.

## 2. Pre-flight State

| Check | Result |
| --- | --- |
| Linked project | `supabase/.temp/linked-project.json` → ref `gzcqasntcbqqmgsoikms`, name `setura-staging` — STAGING confirmed |
| Git | branch `main`, HEAD `79b74f7` ("Fix doctor directory and CORS issues"), `main == origin/main` |
| Migration 61 in source | Present (`61_staff_doctor_directory_read.sql`) |
| **61 NOT already applied to staging** | **FAILED — see below** |
| Manifest/hash state | 61/61 consistent before this phase |
| Frontend fixes in committed source | `reads.ts` (`label` + `listDoctorNames`), `BookingForm.tsx` (`doctorsState`), `QueueBoard.tsx` (imports `listDoctorNames`) — all present at HEAD |
| Vercel linkage | `apps/web/.vercel/project.json` → projectId `prj_PZq3TlY28vzz3hF6x0TKpvxK6gMH`, project `setura` (the existing one) |

**Pre-flight gate #5 failure (stopped and escalated).** Direct catalog query on
staging (`supabase db query --linked`): `schema_migrations` records version 61,
policy `profiles_staff_read_doctors` exists, but `user_is_same_hospital_doctor`
**does not exist** (`helper_fn=0`, `max_applied=61`). Staging had therefore
already run **61's ORIGINAL broken content** — the inlined `user_roles`
self-join, which is inert because `user_roles_read` (01) exposes only a user's
own role rows. The workspace copy of 61 was later corrected, but a recorded
migration version is never re-run by `supabase db push` and must not be edited
in place. Options were presented to the owner; **the owner chose an additive
convergence migration 62** (no historical migration edited).

## 3. Migration 62 Application (authorized substitute for "apply 61")

Created `supabase/migrations/62_staff_doctor_directory_read_convergence.sql`
(ASCII-only, idempotent, converges any environment to the intended end state):

- `CREATE OR REPLACE FUNCTION public.user_is_same_hospital_doctor(UUID)` —
  `LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public`, plus
  `ALTER FUNCTION … SET row_security = off` (mirrors the established
  `user_has_hospital_access` pattern from 01).
- Explicit `REVOKE ALL … FROM PUBLIC; REVOKE ALL … FROM anon; GRANT EXECUTE
  … TO authenticated` on the new signature (F16-04: new/resignatured SECURITY
  DEFINER functions get their own REVOKE).
- `DROP POLICY IF EXISTS profiles_staff_read_doctors; CREATE POLICY … FOR
  SELECT TO authenticated USING (public.user_is_same_hospital_doctor(id))` —
  replaces staging's stale broken policy.

| Target | Method | Result |
| --- | --- | --- |
| Local docker DB | `docker cp` + `psql -v ON_ERROR_STOP=1 -f` + version 62 recorded | `ALTER FUNCTION, REVOKE ×2, GRANT, DROP POLICY, CREATE POLICY`; `max_v=62` |
| **STAGING** | `supabase db push --linked` | Only 62 pending → `Applying migration 62_staff_doctor_directory_read_convergence.sql` succeeded (61 was already recorded, untouched) |

Post-apply on staging: `schema_migrations` contains 62 · `validate:migrations`
remains clean (0 errors, 4 pre-existing baseline warnings) · manifest 62/62.

## 4. ACL / Policy Verification on STAGING (catalog, not migration text)

`pg_proc` + `has_function_privilege()` + `pg_policies` queried directly on
`gzcqasntcbqqmgsoikms.supabase.co`:

| Fact | Value |
| --- | --- |
| version 62 recorded | `1` |
| helper `user_is_same_hospital_doctor(uuid)` exists | `1` |
| `prosecdef` (SECURITY DEFINER) | `true` |
| `anon` EXECUTE | **`false`** |
| `authenticated` EXECUTE | `true` |
| policy | `profiles_staff_read_doctors`, PERMISSIVE, roles `{authenticated}`, cmd `SELECT` |
| policy qual (deparsed) | `user_is_same_hospital_doctor(id)` |

Tenant boundary and SELECT-only posture proven at runtime in §7/§8: Tenant B
receives zero rows from the directory read and zero rows even when explicitly
filtering on Tenant A's hospital id or booking UUID.

## 5. Frontend Build

Changes shipped by this refresh (beyond the already-committed fixes): one
follow-up defect fix (§10) in `apps/web/src/routes/QueueBoard.tsx` — session
labels no longer prepend `"Dr. "` (the seeded `profiles.full_name` already
carries the honorific).

| Gate | Result |
| --- | --- |
| `tsc --noEmit` (apps/web typecheck) | exit **0** |
| `vitest run` (frontend unit tests) | **28 passed / 0 failed** |
| `vite build` | success, 2.52s (`dist/assets/index-CT0nvBuf.js`, 454.60 kB) |
| `scripts/check_frontend_secrets.ts` | 3 artifacts in dist, **0 secret hits, 0 source maps** |
| Staging backend URL | bundle served by `setura-delta.vercel.app` talks only to `gzcqasntcbqqmgsoikms.supabase.co` (observed in §7 network log); no localhost, no production domain |

## 6. Vercel Deployment (existing project, no second project)

Attempt 1 (from `apps/web/`) **failed**: `The specified Root Directory
"apps/web" does not exist` — the project's Root Directory setting re-resolves
against the uploaded source. The failed build never promoted;
`setura-delta.vercel.app` kept serving the previous bundle (no user-facing
harm).

Attempt 2 (correct, within "redeploy the existing project"): temporarily copied
the existing `apps/web/.vercel/project.json` linkage to repo root plus a
`.vercelignore` to slim the upload, ran `vercel deploy --prod --yes` from the
repo root. Cloud build succeeded; deployment
`setura-alx6s15sd-…vercel.app` **aliased to
`https://setura-delta.vercel.app`** (same projectId
`prj_PZq3TlY28vzz3hF6x0TKpvxK6gMH`). Temporary root files removed afterward —
working tree contains only the intended changes (§12).

Served-bundle confirmation: `setura-delta.vercel.app` HTML references
`/assets/index-pL715R-s.js`; the bundle contains `Loading doctors…` and
`Doctor list unavailable — retry before assigning`, and the compiled
`Dr. ${…}` prefix is **absent** (Dr. Dr. fix live).

## 7. Browser Re-verification (STAGING, real DOM + real network)

Full walkthrough re-run against the fresh bundle (browser subagent, nothing
mocked):

- **Bundle:** served script = `index-pL715R-s.js` (matches §6).
- **Reception login** (`reception@surya.test`): auth 200; `profiles` →
  `Ravi Kumar`; `user_roles` → `receptionist` @ hospital `…0001`; dashboard
  renders with zero console errors.
- **Doctor picker states** (MutationObserver timeline): t=21.5 ms →
  **`Loading doctors…`, select `disabled=true`**; t=115.4 ms →
  **`Dr. Anitha Rao · General Medicine`**, enabled. No duplicated
  `General Medicine · General Medicine`, no false `No doctors available`
  flash, no error state.
- **Walk-in created:** `POST /functions/v1/create-booking` → **201**;
  patient `Refresh Validation`, **token 8**, bookingId
  `16328001-b7ea-4a5b-a9c6-9b03d83dff2a`, queueSessionId
  `888e0f38-f713-4b82-98b1-0ee3ae09dae4`, `wasDuplicate=false`, fees ₹0
  snapshots (staging fee config).
- **Queue board (critical label check):** session selector option text
  verbatim **`Dr. Anitha Rao`** — regex `/Dr\.\sDr\./` over `body.innerText`
  → **false**. Patient at Pos 1, Token 8, `Waiting 1`.
- **Doctor flow** (`dr@surya.test`), each `POST /functions/v1/doctor-operations`:
  `call_next` → 200 (token 8 called) · `start_consultation` → 200
  (`started_at 07:31:06Z`) · `save_note "refresh-check"` → 200 (note_id
  `ff88cd06-…`) · `complete_consultation` → 200 (`completed_at 07:31:59Z`).
- **Reception re-check:** booking 8 shows `completed` with both consultation
  timestamps; queue empties (`Waiting 0`).
- **Console errors / 4xx-5xx: none** across the journey (only normal 304
  static revalidations and 204 logout).
- Screenshots unavailable (browser tab backgrounded —
  `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`); evidence is a11y/DOM snapshots plus
  intercepted real network bodies.

## 8. Tenant Isolation (focused Tenant B re-check, post-redeploy)

Signed out of the Tenant A session (which served as control baseline: 8
bookings visible) and logged in as `reception-b@surya.test`
(receptionist @ hospital `…00000000-0000-4000-8000-000000000002`):

- Dashboard: `Today's bookings 0`, empty state `No bookings today.`
- Walk-in doctor picker: **exactly one option** —
  `No doctors on record for this hospital`; **`Dr. Anitha Rao` absent**
  (the 62 policy grants the directory read only within the reader's
  hospital).
- Direct probes with Tenant B's token: `bookings?hospital_id=eq.…0001` → 0
  rows; Tenant A's specific booking UUID → 0 rows; unfiltered `bookings` →
  0 rows; `doctor_specializations?hospital_id=eq.…0001` → 0 rows;
  `profiles?full_name=like.*Anitha*` → 0 rows; `patients?hospital_id=eq.…0001`
  → 0 rows. `hospitals` returns only Tenant B's row.
- Every app read carries a server-side `hospital_id=eq.…0002` predicate **and**
  RLS independently collapses cross-tenant filters to zero — database-enforced,
  not client-enforced.
- **Zero Tenant A rows anywhere** in Tenant B's DOM or responses; no
  cross-tenant mutation attempted (writes remain guarded by the same RLS and
  RPC checks verified in Gate 2/3R and the prior walkthrough).
- Console errors: none.

## 9. Regression Results (actual counts)

Backend (after migration 62) and frontend (after QueueBoard fix):

| Suite | Result |
| --- | --- |
| `validate:migrations` | **62 files scanned, 0 errors, 4 warnings** (pre-existing `[duplicate-objects]` baseline) |
| `validate_migration_manifest` | **62 migrations / 62 manifest lines, 0 integrity issues** |
| `deno task check` | exit **0** |
| `deno fmt --check` | no not-formatted hits reported in run output |
| `deno lint` | **Checked 94 files**, 0 problems |
| Unit tests | **97 passed / 0 failed** |
| Integration tests (real local stack) | **235 passed / 0 failed** (52s) |
| Frontend `vitest run` | **28 passed / 0 failed** |
| Frontend typecheck | exit **0** |
| Frontend build | success (2.52s) |
| Frontend secret scan | **0 hits, 0 source maps** (3 dist artifacts) |
| Relevant E1 flow | core journey re-run **live on staging** (§7): create-booking 201 → queue → doctor-operations ×4 all 200 → completion visible to reception; prior full E1+D16 run: **29 passed** |

No regression appeared → no stop condition triggered.

## 10. Defects Found In This Phase

| # | Defect | Class | Disposition |
| --- | --- | --- | --- |
| D-1 | Staging's recorded migration 61 carried the ORIGINAL broken (inert self-join) content; the corrected workspace 61 could never re-run via `db push` | Deployment/divergence (pre-existing) | **FIXED** via additive convergence migration 62 (owner-approved mechanism); 61 left untouched as a historical artifact |
| D-2 | Queue board rendered **`Dr. Dr. Anitha Rao`** — the QueueBoard fix prepended `"Dr. "` while `profiles.full_name` already contains the honorific | Cosmetic, **introduced by our own fix**, first surfaced by §7's earlier pass | **FIXED** (single-line change in `QueueBoard.tsx`, comment documents why) and re-verified on staging: label is verbatim `Dr. Anitha Rao`, regex double-honorific scan negative |
| D-3 | `vercel deploy` from `apps/web/` fails against the project's `Root Directory=apps/web` setting | Tooling/deploy-process | **WORKED AROUND** by deploying from repo root with the existing project linkage; failed build never promoted. Recommend aligning the deploy invocation (or project setting) in a future CI-owned release step |

## 11. Remaining Product Gaps (NOT implemented — owner decision)

Per the stop condition, nothing below was built:

1. Booking-confirmation page still omits the assigned doctor / queue position
   (carried from the prior walkthrough).
2. Consultation note + diagnosis remain invisible in staff UI (saved via
   `doctor-operations`, never rendered).
3. All fee snapshots ₹0 with `Payment: Pending` even after completion on
   staging (fee configuration, not engine defect) — related to open finding
   P0-04 (`booking_fee_inr` has no runtime writer).
4. Minor queue semantics: dashboard "Waiting" counts only queued rows
   (tokens 1–4 `booked` but unqueued show as waiting 0); queue header "Live
   token" briefly reflected last session progress rather than max issued
   token.
5. Doctor directory is re-fetched on every Walk-in mount (no client cache) —
   the loading state is correct but visible ~90–660 ms per mount.
6. Scheduler / worker findings (P0-02, P0-03, P0-01) unchanged by this phase.
7. Pre-existing baseline noted in AGENTS §13 (4 duplicate-object migration
   warnings; `F16-07` comment fix) — untouched, not new.

## 12. Working Tree, Classification, and Production Boundary

Intended diff produced by this phase (HEAD `79b74f7`):
`supabase/migrations/62_staff_doctor_directory_read_convergence.sql` (new),
`supabase/migrations/MANIFEST.sha256` (+62 line),
`apps/web/src/routes/QueueBoard.tsx` (D-2 fix). Nothing committed in this
session; no git push performed.

### Final classification

```text
Doctor name in picker            → PROVEN STAGING
Doctor loading-state fix         → PROVEN STAGING
Queue doctor-name label          → PROVEN STAGING
Migration 62 RLS / least privilege → PROVEN STAGING
Core hospital journey            → PROVEN STAGING
Tenant isolation                 → PROVEN STAGING
```

Production remains **UNPROVEN** for every line above — nothing in this phase
was executed against, deployed to, or read from any production environment.

```text
STAGING ONLY.

Production was not entered.
D5 remains DEFERRED BY OWNER.
D13 remains DEFERRED BY OWNER.
No production infrastructure or credentials were touched.
No real money was moved.
```

**STOP.** The staging refresh and revalidation are complete. The clinical-note
UI and booking-confirmation enhancement were deliberately not implemented;
next product-completion priority is the owner's choice.
