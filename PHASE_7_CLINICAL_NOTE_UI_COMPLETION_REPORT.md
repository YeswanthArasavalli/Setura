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
