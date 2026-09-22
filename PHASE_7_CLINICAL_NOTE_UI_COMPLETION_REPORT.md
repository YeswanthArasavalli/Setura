# PHASE 7 — CLINICAL NOTE + DIAGNOSIS UI: COMPLETION REPORT

**Date:** 2026-09-22
**Base commit:** `202f1a8` (`main == origin/main`) — work performed on top of it, UNCOMMITTED (owner review gate)
**Phase A (this file's history):** `BACKEND READ-SURFACE GAP FOUND` — investigation report, zero code changed.
**Phase C (this execution):** owner-authorized minimum backend read surface (migration 63) +
staff UI + security matrix + local & staging verification. **Outcome: COMPLETE, STOPPED
BEFORE COMMIT/PUSH** per the GIT RULE.

---

## 1. Objective (as authorized)

Expose the persisted consultation note + diagnosis to the staff who are already
entitled to the booking, via the minimum additive read surface, then display it
faithfully on the existing booking-detail surface. No new write path, no new
SECURITY DEFINER function, no behavior change to any existing reader.

## 2. Backend change — migration 63 (IMPLEMENTED · INTEGRATION VERIFIED · STAGING VERIFIED)

`supabase/migrations/63_consultation_notes_staff_read.sql` (additive, idempotent header):

- `DROP POLICY IF EXISTS` + one `CREATE POLICY consultation_notes_staff_read FOR SELECT TO authenticated`:
  `is_global_admin()` OR `current_user_role(hospital_id) IN ('hospital_admin','receptionist')`
  OR (`doctor_id = auth.uid()` AND `current_user_role(hospital_id) = 'doctor'`) —
  mirrors the established `bookings_read_admin` / `bookings_read_doctor` shape (migration 02)
  using only existing migration-01 helper primitives.
- `REVOKE ALL` from `PUBLIC`/`anon`; `GRANT SELECT` to `authenticated` (SELECT only —
  INSERT/UPDATE/DELETE remain service-role-only, preserving migration 46's append-only posture).
- No new SECURITY DEFINER routine → no F16-04 obligation; write path
  (`save_consultation_note` RPC via `doctor-operations`) untouched.
- `MANIFEST.sha256`: 63/63 lines, independently recomputed hash matches
  (`524e4a653bba3366b2ed00e4c28722b38e9fd6fdaba13634bce09fe789acc51c`),
  `validate:migration-manifest` → 0 integrity issues.

## 3. Catalog proof (Step 8) — LOCAL and STAGING

Direct catalog inspection after application (local: `docker cp` + `psql -f` +
`supabase_migrations.schema_migrations` registration of v63; staging:
`supabase db push --linked` after `migration list --linked` confirmed 61/62
recorded and 63 pending — normal machinery, no reset, no `--include-all`):

| Check | Local | Staging `gzcqasntcbqqmgsoikms` |
| --- | --- | --- |
| `consultation_notes` rowsecurity | `t` | `true` |
| SELECT policies / role / cmd | 1 / `authenticated` / `r` | 1 / `authenticated` / `r` |
| auth SELECT / INSERT / UPDATE / DELETE | `t / f / f / f` | `true / false / false / false` |
| anon SELECT | `f` | `false` |
| `save_consultation_note` EXECUTE auth / service_role | `f` / `t` | `false` / `true` |

## 4. Security matrix — integration tests (Step 7)

`tests/integration/consultation_notes_read.test.ts` — 11 tests against the real
local stack, notes written through the real `runSaveConsultationNote` path. All
11 PASS. Coverage: author-doctor verbatim read; receptionist/admin read; global
admin read; peer-doctor DENY (author-scoped); Tenant B zero rows on Tenant A +
own-tenant read; role-less user nothing; anon hard denial (SQLSTATE 42501
`permission denied for table consultation_notes`); authenticated INSERT /
UPDATE / DELETE refused; `save_consultation_note` still service-role-only;
service write still appends (multi-note, null diagnosis); teardown leftover-guard.

## 5. Staging runtime security verification (Step 10 — INTEGRATION VERIFIED, hosted)

Real staging GoTrue password-grant tokens + PostgREST against
`gzcqasntcbqqmgsoikms.supabase.co`, booking `16328001-…` (note `refresh-check`):

| Actor | Query | Observed | Verdict |
| --- | --- | --- | --- |
| `reception@surya.test` (A receptionist) | notes for booking | 200, 1 row, `refresh-check` verbatim | PROVEN |
| `dr@surya.test` (author, `…00a3`) | notes for booking | 200, 1 row | PROVEN |
| `dr@surya.test` | `doctor_id=eq.…00a4` (not author) | `*/0` rows | PROVEN DENY |
| `reception-b@surya.test` (Tenant B) | all notes / booking | `*/0` rows | PROVEN DENY |
| anon role, valid anon JWT | `select=id` | `42501 permission denied for table consultation_notes` | PROVEN DENY |
| authenticated reception | `POST` write probe | `403` refused (no row created; count stayed 5) | PROVEN DENY |

Scope sanity: Tenant A receptionist and author doctor each see exactly the 5
existing Tenant A notes; Hospital A has 0 notes authored by any other doctor.

## 6. UI (Steps 11–12 — IMPLEMENTED · UNIT VERIFIED · STAGING BROWSER VERIFIED)

- `apps/web/src/api/reads.ts`: `ConsultationNoteRow` + `listConsultationNotes()`
  (hospital-scoped select on the new RLS surface; zero-row = not-unauthorized).
- `apps/web/src/routes/BookingDetail.tsx`: new full-width **Consultation** card
  inside the existing grid. Faithful display (`whitespace-pre-wrap`, stored text
  verbatim, no summarization/LLM), per-note timestamps when multiple notes,
  doctor label resolved via the directory read and never fabricated, empty
  states `No clinical notes recorded.` / `No diagnosis recorded.`, loading
  state, error `role="alert"` (error never masquerades as empty), blank note /
  null diagnosis never render `undefined`/`null`/`[object Object]`. Existing
  patient/payment card behavior untouched.

## 7. Frontend tests (Step 13 — exact counts)

`apps/web/src/routes/BookingDetail.test.tsx` — 9 new vitest tests (verbatim
`\n` fidelity via raw-textContent matcher, multi-note, blank-note and
null-diagnosis empty states, unauthorized zero-rows, loading, error-not-empty,
missing directory name omitted, existing booking/payment fields intact).
Frontend suite: **37 passed / 0 failed** (6 files; 28 baseline + 9 new).

## 8. Regression (exact counts, real local stack)

| Suite | Result |
| --- | --- |
| `validate:migrations` | 63 files, **0 errors**, 4 warnings (pre-existing `[duplicate-objects]` baseline) |
| `validate:migration-manifest` | **63/63, 0 integrity issues** |
| `deno task check` | exit **0** |
| `deno task lint` | **95 files**, 0 problems |
| Unit tests | **97 passed / 0 failed** |
| Integration tests | **246 passed / 0 failed** (235 baseline + 11 new) |
| Frontend `vitest run` | **37 passed / 0 failed** |
| Frontend typecheck + build | exit **0** / success |
| `check_frontend_secrets.ts apps/web/dist --deny-sourcemaps` | 3 artifacts, **0 secret hits, 0 sourcemaps** |

## 9. Staging deployment + browser verification (Step 14 — PASS)

Redeployed the existing Vercel project (projectId `prj_PZq3TlY28vzz3hF6x0TKpvxK6gMH`,
alias `setura-delta.vercel.app`; no second project). Final served bundle
`index-DiLS7UrZ.js`: 2 staging-backend references, 0 localhost endpoints,
consultation-card strings present. Real-browser walkthrough (nothing mocked):

- Reception (Tenant A): Consultation card renders `refresh-check` verbatim +
  `No diagnosis recorded.` + Token 8 + completed timestamps; XHR
  `consultation_notes` → 200 with 1 row (`diagnosis_summary:null` correctly
  shown as empty state); `undefined`/`null`/`[object Object]`/`NaN` absent.
- Doctor (author): same card renders, author name resolved to `Dr. Anitha Rao`.
- Tenant B deep link to the Tenant A booking: `Booking not found or not visible
  to your account.`, zero Tenant A disclosure, `consultation_notes` → 200 `[]`.
- Console: 0 app errors; 0 app-originated 4xx/5xx.

**Deployment incidents (both resolved, worth recording):**
1. The first redeploy attempt baked in local `.env.local` values because the
   prebuilt flow supplied no production env — served bundle talked to
   `127.0.0.1:54321`. Caught by the browser pass; fixed by pulling the real
   Vercel production env and rebuilding.
2. The pulled env values are stored **double-quoted** (e.g.
   `VITE_SUPABASE_URL="https://…"`); `vite build` with process-env injection
   preserved the quotes, supabase-js rejected the URL and the SPA white-screened.
   Fixed locally by stripping quotes before build. **The stored Vercel env-var
   values still contain the wrapping quotes — any future cloud build (Git-push
   trigger) will ship a broken bundle until they are cleaned in Project
   Settings.** Owner action requested; no Vercel settings were modified.

**Non-blocking observations (not fixed — out of this phase's scope):**
transient first-login `user_roles` 401 → "No staff role" flake seen once during
earlier probing (did not recur across 3 logins in the final pass); booking
detail polls ~every 1–2 s (116 requests/30 s) — candidate for backoff before
production.

## 10. Classification

| Item | Classification |
| --- | --- |
| Migration 63 + manifest | PROVEN LOCAL (catalog + 11/11 integration) and PROVEN STAGING (catalog + hosted matrix) |
| Consultation UI | PROVEN STAGING (real browser, real data, Tenant A/B) |
| Regression | PASSED with exact counts (§8) against the real local stack |
| Production | UNPROVEN — no production deployment exists; nothing in this phase was run against production |

## 11. Scope compliance

No applied migration modified (61/62 and all earlier files untouched); no
staging reset; no direct staging SQL outside the CLI migration machinery and
read-only catalog queries; no scheduler/worker/payment/WhatsApp/booking/fee/
D5/D13 work; no commit, no push (stopped per GIT RULE, §12).

## 12. Working tree at STOP (for owner review)

See `git status --short` output recorded in the session: modified
`apps/web/src/api/reads.ts`, `apps/web/src/routes/BookingDetail.tsx`,
`supabase/migrations/MANIFEST.sha256`; new
`supabase/migrations/63_consultation_notes_staff_read.sql`,
`tests/integration/consultation_notes_read.test.ts`,
`apps/web/src/routes/BookingDetail.test.tsx`, this report
(transient `_tmp_s10/` scratch dir is not intended to be committed).

## 13. Vercel environment-variable follow-up (pre-commit config pass)

### 13.1 Reported concern

§9 incident 2 claimed the **stored** Vercel env values contain wrapping double
quotes and that any future cloud build would ship a broken bundle. This pass
set out to inspect and, if true, correct the existing project
(`setura`, `prj_PZq3TlY28vzz3hF6x0TKpvxK6gMH`, alias `setura-delta.vercel.app`)
only — no second project, no domain, no credential changes.

### 13.2 Inspection (Step 1) — secret values never echoed

`vercel env ls` + one-off `vercel env pull` (into a gitignored temp dir,
since deleted):

| Variable | Targets | Stored value | Quote state |
| --- | --- | --- | --- |
| `VITE_SUPABASE_URL` | Production, Preview | present | **unquoted** (`https://gzcqasntcbqqmgsoikms.supabase.co`) |
| `VITE_SUPABASE_ANON_KEY` | Production, Preview | present | **unquoted** (publishable `sb_pub…`, 46 chars, not echoed) |

Production and Preview hold identical staging-backed values (intentional:
backend remains STAGING). Unrelated `POSTGRES_*` / `TURBO_*` / `NX_*` vars
(Vercel-provisioned Postgres additions) were left untouched.

### 13.3 Root cause — correction of the §9 claim

The wrapping quotes are a **local-file artifact of `vercel env pull`**, which
writes every value dotenv-quoted (`KEY="value"`), combined with the local
prebuilt build path preserving those quotes when feeding process env. The
values **stored in Vercel itself were never quote-wrapped**. Therefore
**no Vercel settings were modified in this pass** (none required), and
nothing was rotated, created or deleted.

### 13.4 Cloud-build proof (Step 3)

A genuine Vercel cloud build exists and was verified via build logs —
deployment `setura-xbmsy68nz` (id `dpl_87D15vWaZDvQCqLq7KhdFcRx2xTt`,
Production, ~14 s billable build, machine iad1): Vercel cloned
`github.com/YeswanthArasavalli/Setura` `main` @ `ad47215`, ran
`tsc --noEmit && vite build` in Vercel's own environment with Vercel-injected
env vars (no committed `.env` exists; no local quote-stripping involved),
then promoted to `https://setura-delta.vercel.app`.

**Git-state deviation (recorded, not caused by this pass):** before this
session, the seven Phase C paths had already been committed and pushed as
`ad47215 "Expose consultation notes to staff + UI"` (HEAD = origin/main);
the previously stated base `202f1a8` is that commit's parent. This pass made
no commits and no pushes.

### 13.5 Bundle verification (Step 4) — served `index-DiLS7UrZ.js`

- Staging Supabase URL: present, clean (`const vb="https://gzcqasntcbqqmgsoikms.supabase.co"`
  — the quote characters are JS string delimiters; a stored wrapping quote
  would appear as an escaped `\"` inside the literal, and none does)
- Publishable anon key: present (not echoed)
- Local-stack endpoint `127.0.0.1:54321` / `localhost:54321`: **0 occurrences**
  (the few `localhost` / `127.0.0.1` / `:9999` strings in the bundle are
  supabase-js library-internal default constants and PKCE allowlists, shipped
  in every supabase-js bundle — not env injections)
- Production domain (`setura.in` or any custom domain): absent
- `service_role` / Razorpay / Meta-WhatsApp secrets: **0 occurrences**
- Source maps: 0 `sourceMappingURL` refs, no `.map` served
- Phase C clinical-note UI: `Consultation` card, `Clinical Notes`,
  `refresh-check`, `No diagnosis recorded.` strings all present

### 13.6 Controlled browser re-verification (Step 5) — cloud-built bundle

Against `https://setura-delta.vercel.app` (real browser, real staging data):

- Reception Tenant A (`reception@surya.test`): booking
  `16328001-b7ea-4a5b-a9c6-9b03d83dff2a` renders the Consultation card —
  `Clinical Notes` → `refresh-check`, Diagnosis → `No diagnosis recorded.` —
  verbatim; `consultation_notes` → 200, 1 row.
- Doctor Tenant A (`dr@surya.test`, author): same card visible; author
  resolved to `Dr. Anitha Rao`.
- Tenant B (`reception-b@surya.test`) deep link to the Tenant A booking:
  exactly `Booking not found or not visible to your account.`; DOM scan for
  every Tenant A marker (`refresh-check`, patient identifiers, `Anitha`,
  `Clinical Notes`) → 0 matches; Tenant B `consultation_notes` → 200 with
  0 Tenant A rows (hospital-scoped `…0002`).
- Console: **0 application errors**; **0 application-originated 4xx/5xx**
  across all three sessions (the previously noted `user_roles` 401 flake did
  not recur). Screenshots retained locally under `.remember/tmp/`.
- Non-blocking observation (not fixed, out of scope): on `/bookings/:id` the
  back-link targets `/reception` even for doctor-role users — candidate
  follow-up.

### 13.7 Source-file impact (Step 6)

`git status --short` / `git diff --stat` / `git diff --name-only`: clean
before this pass; the only file this pass modifies is **this report**. No
application source, migration, config or Vercel project setting was changed.
All inspection scratch files (pulled env, downloaded bundle) were deleted.

### 13.8 Classification (updated)

| Item | Classification |
| --- | --- |
| Vercel environment configuration | CORRECTED AS UNNECESSARY → verified CLEAN; no settings change needed or made; §9 incident-2 root cause reassigned to the local `env pull`/prebuilt path |
| Cloud build + env injection | PROVEN (Vercel-built `ad47215` deploy, clean bundle served on the alias) |
| Clinical-note UI | PROVEN STAGING (now on a Vercel **cloud-built** bundle) |
| Backend read surface | PROVEN STAGING (unchanged by this pass) |
| Production | UNPROVEN — untouched; D5 and D13 remain DEFERRED BY OWNER |

