# PHASE 7 — C1 Commit + Controlled Staging Deployment + Read-Only Preflight

Two-phase task: **Phase A** commit and deploy the already-implemented,
locally-proven C1 booking-cancellation frontend to the **existing** staging
Vercel project; **Phase B** perform a strictly **read-only** staging preflight
to decide whether a genuinely safe controlled cancellation could later be
performed. The actual cancellation was **NOT performed** (prohibited by this
task, and independently gated by unresolved R1 prerequisites).

Evidence vocabulary used: `PROVEN · IMPLEMENTED · PROVEN LOCAL · PROVEN STAGING
· NOT OBSERVED · NOT TESTED · BLOCKED · UNPROVEN · NOT IMPLEMENTED · DEFERRED BY
OWNER · STALE / RESOLVED`.

---

## A. Baseline

| Item | Value |
| --- | --- |
| Branch | `main` |
| Pre-commit HEAD / origin/main | `037bcf10c8387452ed7d8dc9c60a83b7f7052f62` |
| Git repo present | Yes (`origin` = `https://github.com/YeswanthArasavalli/Setura.git`). *AGENTS.md §13 "not a Git repo" baseline is now STALE / RESOLVED — superseded by direct measurement.* |
| Linked Supabase project | `setura-staging` / `gzcqasntcbqqmgsoikms` (South Asia Mumbai) |
| Existing Vercel project | `setura`, alias `https://setura-delta.vercel.app`, Git-connected to `main` |
| Staging Supabase URL (frontend) | `https://gzcqasntcbqqmgsoikms.supabase.co` |

## B. C1 source verification (pre-commit)

Working tree contained exactly the intended C1 changes and nothing else:

- Modified (6): `types/api.ts`, `api/reads.ts`, `routes/BookingDetail.tsx`,
  `routes/ReceptionDashboard.tsx`, `routes/BookingDetail.test.tsx`,
  `api/reads.test.ts`.
- New code (4): `api/cancellations.ts`, `api/cancellations.test.ts`,
  `lib/cancellationStatus.ts`, `lib/cancellationStatus.test.ts`.
- `git diff --check`: clean. `git diff -- supabase/`: **EMPTY** — backend,
  migrations, functions, RLS, grants, RPCs untouched.
- No backend / migration / cancel-booking / documentation-drift / fmt fixes were
  attempted (per non-goals).

Classification: **PROVEN** (working-tree inspection).

## C. Regression before commit (re-run first-hand this session)

| Command | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm test` (apps/web) | **11 files / 116 tests passed** |
| `npm run build` | built — `index-De4OX1oG.js` 467.63 kB |
| `deno task test` | **97 passed / 0 failed** |
| `deno task test:integration` | **246 passed / 0 failed** (Edge Runtime confirmed `Up` first) |
| `deno task lint` | clean (95 files) |
| `deno task check` | clean |
| `deno task validate:migrations` | 63 files, 0 errors, 4 pre-existing `[duplicate-objects]` warnings |
| secret scan (`check_frontend_secrets.ts apps/web/dist --deny-sourcemaps`) | **0 hits, 0 source maps** |
| `git diff --check` | clean |
| `deno task fmt:check` | FAIL on the known **pre-existing** `tests/integration/consultation_notes_read.test.ts` — **not formatted** (not authorized to rewrite). |

No new failure appeared. Classification: **PROVEN LOCAL**.

## D. Commit

- Hash: **`a9aa774f4620b45541ccc18dce4f31d92e82d2b1`** (`037bcf1..a9aa774`).
- Message: `feat: add booking cancellation control surface`.
- Contents: exactly 12 files (10 C1 source/test files + the 2 authoritative C1
  reports: implementation + staging-validation). `+1772 / −7`.
- Staged by explicit path. **No `git add .`.** Unrelated historical `PHASE_7_*.md`
  reports, logs, `.env` files and scratch artifacts were **not** included.

Classification: **PROVEN** (`git show --stat`).

## E. Push

- `git push origin main` → `037bcf1..a9aa774 main -> main` (normal push).
- No force / rebase / history rewrite / reset / clean.
- Verified after push: `HEAD == origin/main == a9aa774…`; tracked tree clean.

Classification: **PROVEN**.

## F. Vercel deployment result

- The existing `setura` project is Git-connected and **auto-built from the
  pushed `main` commit**: a new **Production** deployment
  `setura-3dj5a80yl-…vercel.app` appeared with status **Ready** within seconds
  of the push.
- Served through the unchanged existing alias `https://setura-delta.vercel.app`.
- No new project, no domain change, no secret created/rotated, no local
  `.env.local` injected; the build used Vercel's configured env vars.

Classification: **PROVEN STAGING** (deployment of the C1 surface).

## G. Deployed bundle verification

Live alias now serves a **new** asset `index-BQs2aA0T.js` (previously
`index-DCO78ejs.js`).

- **C1 markers PRESENT** in the deployed bundle: `Cancel booking`,
  `Confirm cancellation`, `cancellation_reason`, `alreadyCancelled`,
  `booking_cancelled`, `Keep booking`. (String presence alone is not functional
  proof — see K for the functional read-only proof.)
- **Staging Supabase URL present**: `gzcqasntcbqqmgsoikms`. Only the public
  publishable key is embedded: `sb_publishable_kGZYS-4Xe4woRIfe-WubVg_4n2SGTzn`.
- **No secrets / no service role value**: no `eyJ….eyJ` JWT tokens; no full
  `sb_secret_…` value; no `service_role` key value; no Razorpay / Meta / SMTP /
  CRON / WORKER / Vault secret value; no local demo JWT (`supabase-demo`).
  - Nuance (recorded, not a defect): the literal strings `localhost`,
    `127.0.0.1`, `service_role`, `sb_secret_` DO appear, but only as
    **stock `supabase-js` library constants** — e.g. the GoTrue default
    `http://localhost:9999`, a local-host allowlist
    `push("localhost","127.0.0.1","[::1]")`, and key-prefix detection
    `startsWith("sb_publishable_")||startsWith("sb_secret_")`. They are NOT the
    app's configured backend (which is the staging URL) and carry no secret
    value. Verified by inspecting each match's surrounding context.
- **No source maps** (`sourceMappingURL` absent).

Classification: **PROVEN STAGING** (bundle identity + secret hygiene).

## H. Staging credentials availability

- **AVAILABLE and VERIFIED.** Read-only browser login to
  `https://setura-delta.vercel.app` succeeded with the documented deterministic
  seed account `reception@surya.test` (receptionist "Ravi Kumar") and loaded the
  `/reception` dashboard. (Credentials are the repository's seeded test
  identities, not invented.)

Classification: **PROVEN STAGING** (a receptionist-role staging account exists
and authenticates).

## I. Safe test booking availability

- A **candidate** cancellable booking was observed read-only in the UI: booking
  `1533cce8-fc5b-4a64-8d41-4afc0b1d2c9a`, status `booked`, token 1, patient
  display "Verify Patient", phone `9859006423`, ₹0 / "No payment required".
- However, **staging DB read access is NOT available to this task**:
  `SUPABASE_DB_URL` exists only as a masked Edge Function secret (digest shown,
  value not retrievable), and there is no authorized remote query path.
  Therefore the booking's patient/phone **cannot be proven non-real**, and no
  authoritative pre-state record (`hospital_id`, `patient_id`, exact
  `cancellation_reason`/`cancelled_at`, tenancy) could be captured. The task
  explicitly forbids cancelling "an arbitrary booking merely because it is
  visible."
- No row was fabricated.

Classification: designated **SAFE test booking = NOT PROVEN** (candidate exists
but is not guaranteed-safe) → **BLOCKED** pending staging DB read.

## J. Meta / WhatsApp safety classification

Staging Edge Function secret **names** (values not printed) are:
`ALLOWED_ORIGINS, CRON_SECRET, ENABLE_WORKER_TRIGGER, SUPABASE_ANON_KEY,
SUPABASE_DB_URL, SUPABASE_JWKS, SUPABASE_PUBLISHABLE_KEYS,
SUPABASE_SECRET_KEYS, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL, WORKER_SECRET`.

- **No `META_*` / WhatsApp / Razorpay secret is provisioned at the Edge
  boundary**, so a `send_whatsapp_message` job could not authenticate to Meta
  Cloud via edge secret. `.env.example` carries only placeholders (`EAA…`).
- **Unresolved caveats:** (a) SETURA is multi-tenant and a per-tenant Meta
  credential could live in a DB/vault table rather than an edge secret — this
  cannot be ruled out without the DB read that is unavailable (I); (b)
  `ENABLE_WORKER_TRIGGER` and `WORKER_SECRET` are present, so a job could be
  claimed/processed if a tenant credential existed.

Classification: Meta boundary **PARTIALLY verified — delivery-fails-at-edge
plausible but non-real-destination NOT PROVEN**.

## K. Staging browser read-only result (NO mutation)

Read-only observation on the deployed C1 surface (nothing submitted):

| Check | Result |
| --- | --- |
| BookingDetail loads | **YES** |
| `Cancel booking` control visible for receptionist | **YES** |
| Confirmation surface opens | **YES** |
| Reason required (Confirm disabled until entered) | **YES** |
| Refund checkbox behavior (hidden for ₹0 booking) | **Correct — not shown** |
| Dismissed via `Keep booking` without cancelling | **YES** |
| Booking remained `booked` afterward | **YES** |
| Doctor-does-not-see / terminal-states-hide control | **NOT OBSERVED** this pass (proven LOCAL/unit only) |

**NOTHING was mutated. No cancellation was submitted.**

Classification: deployed C1 UI behavior **PROVEN STAGING** for the receptionist
positive path (role-visibility for allowed role + confirmation + required-reason
+ refund gating for a zero-fee booking).

## L. R1 readiness

```
R1 SAFE TO PROCEED: NO
```

| Prerequisite | Status |
| --- | --- |
| Frontend deployed | MET (G/K) |
| Staff account verified | MET (H) |
| Designated safe test booking | **NOT MET** — non-real patient/phone not provable without DB read (I) |
| Patient/phone guaranteed non-real | **NOT PROVEN** (I) |
| Meta/WhatsApp boundary fully verified | **NOT PROVEN** — edge creds absent, but per-tenant DB creds not ruled out (J) |

Per the task rule *"If ANY item is uncertain: STOP. Do not mutate staging,"* the
controlling blockers are **I** (no proven-safe booking) and **J** (per-tenant
Meta credential not ruled out), both stemming from unavailable staging DB read.

## M. Was the cancellation performed?

**NO.** The staging cancellation was **NOT PERFORMED** — prohibited by this
task and independently gated by the R1 decision (L). No WhatsApp was sent, no
provider path was exercised, no booking was mutated.

Classification: staging cancellation **NOT TESTED / deliberately NOT PERFORMED**;
real Meta/WhatsApp delivery **BLOCKED** (R1).

## N. Production status

- No production deployment performed. The Vercel `setura` "Production" target
  serves the **staging** Supabase backend (`gzcq…`) — it is not a separate
  production data plane.
- No production Supabase/Vercel created, no production credentials provisioned,
  no production domain touched.

Classification: **UNPROVEN / untouched**.

## O. D5 / D13

- D5: **DEFERRED BY OWNER** — unchanged, untouched.
- D13: **DEFERRED BY OWNER** — unchanged, no domain change.

## P. Git status

- `HEAD == origin/main == a9aa774`. Tracked working tree clean.
- Untracked (intentional, not committed): six historical `PHASE_7_*.md` reports,
  this report, and three read-only evidence screenshots
  (`staging_booking_detail.png`, `staging_cancel_confirmation_surface.png`,
  `staging_after_keep_booking.png`).
- `supabase/` diff still empty. No force push, no history rewrite.

---

## Final stop condition — all met, cancellation not performed

1. C1 committed → `a9aa774` ✔
2. C1 pushed → `HEAD == origin/main` ✔
3. Existing Vercel deployment verified Ready ✔
4. Deployed bundle verified (C1 markers present, no secrets, no source maps) ✔
5. Staging read-only preflight complete ✔
6. R1 readiness classified: **NO** ✔
7. Staging cancellation: **NOT PERFORMED** ✔
8. Production: **UNPROVEN / untouched**; D5/D13 unchanged ✔

**What remains for a future, separately-authorized controlled cancellation:**
confirm staging DB read access so a designated booking's patient/phone can be
proven non-real (resolves I), and confirm no per-tenant Meta/WhatsApp credential
can deliver to a real number (resolves J). Until then, staging cancellation
stays correctly BLOCKED and is **not** upgraded to a pass.
