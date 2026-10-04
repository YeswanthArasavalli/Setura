# SETURA — STAGING TRANSITION & WS-OPS-1 IMPLEMENTATION / VERIFICATION REPORT

Status vocabulary used throughout (per AGENTS.md §5): IMPLEMENTED · STATICALLY
VERIFIED · UNIT VERIFIED · **INTEGRATION VERIFIED** · **RUNTIME VERIFIED
(staging)** · PRODUCTION VERIFIED · UNPROVEN · BLOCKED · FAIL. Evidence level
is stated for every claim. No claim is upgraded beyond the evidence that
produced it.

---

## 1. Executive Summary

SETURA staging is **not UNPROVEN**. Direct, read-only interrogation of the live
hosted project `setura-staging` (`gzcqasntcbqqmgsoikms`, Supabase CLI
v2.100.1, authenticated) established that the database is fully migrated, the
Edge layer is deployed, the pg_cron + pg_net scheduler is installed, registered
and has been firing successfully for **>24h continuous**, and the background
worker genuinely claims, leases, retries and dead-letters jobs.

The stale repository baseline statements — "Staging: UNPROVEN" and "no
scheduler exists" (AGENTS.md §13) — are **superseded by runtime evidence** in
this report.

Classification per prompt §6: **CASE A (staging access is available)** with
partial CASE-B completeness gaps. One concrete forward action was performed
(restoring Edge-Function parity by deploying 6 undeployed onboarding/config
functions). Everything else in this report is verification, not new
implementation.

**Final decision (prompt §21): B — STAGING PARTIALLY VERIFIED; REMAINING ITEMS
BLOCKED.** See §19.

---

## 2. Starting State (as claimed vs. as found)

Claimed by the task brief (§1): migrations 01–72 reconciled; local VERIFIED;
staging UNPROVEN; production UNPROVEN.

Found on inspection (this session):
- Git **is** now a repository with remote `origin` → `https://github.com/YeswanthArasavalli/Setura.git`, branch `main` tracking `origin/main`. (AGENTS.md §13 "not a Git repo" is outdated.)
- `.env.example` present with **placeholders only**; no root `.env` (no secret values are held locally).
- `supabase/.temp/linked-project.json` → linked to `setura-staging` (`gzcqasntcbqqmgsoikms`).
- A real `setura-staging` hosted project is reachable by the authenticated CLI.

---

## 3. Environment Availability

| Item | Evidence | Level |
| --- | --- | --- |
| Supabase staging project exists & linked | `supabase projects list` shows `setura-staging` (Mumbai), LINKED; `linked-project.json` ref `gzcqasntcbqqmgsoikms` | RUNTIME VERIFIED |
| CLI can authenticate to it | `supabase projects list`, `migration list --linked`, `functions list`, `secrets list`, `db query --linked` all succeeded | RUNTIME VERIFIED |
| DB reachable read-only | `supabase db query --linked` (Management API) returned live catalog rows | RUNTIME VERIFIED |
| Provider credentials | Staging Edge secrets contain NO `META_*` / `RAZORPAY_*` (see §6) | BLOCKED for live providers (intended per §15) |

Verdict: **CASE A**. No secret values were printed (only digests via
`secrets list`).

---

## 4. Staging Deployment

- Database migrations: already applied on staging (see §5). No `db push`, no
  `db reset`, no destructive command run.
- Edge Functions: **6 functions were deployed this session** (parity fix):
  `provision-hospital`, `hospital-configuration`, `clinical-configuration`,
  `cancellation-policy`, `integration-configuration`, `hospital-activation`.
  Before: 26/32 deployed. After: **32/32 deployed** (verified by re-listing).
- Frontend: NOT deployed/verified this session (see §16 Known Limitations).

---

## 5. Database Verification (live staging, read-only)

| Check | Result | Level |
| --- | --- | --- |
| Migration alignment Local vs Remote | `01`–`72` present on BOTH sides, zero local-only, zero remote-only | RUNTIME VERIFIED |
| Migration validation | 72 files reconciled (MANIFEST present); `MANIFEST.sha256` correctly skipped by CLI name-pattern | STATICALLY VERIFIED |
| Extensions | `pg_cron` and `pg_net` both in `pg_extension` | RUNTIME VERIFIED |
| RLS tables | 98 public tables `relrowsecurity`; 96 `relforcerowsecurity` | RUNTIME VERIFIED |
| RLS policies | 144 live policies in schema `public` | RUNTIME VERIFIED |

Migrations 71/72 were **not** rerun. No migration 73 created.

---

## 6. Edge Function Verification

- 32 functions ACTIVE on staging (verified via `functions list --output json`).
- Required Edge secrets present (names only, digests shown by CLI):
  `CRON_SECRET`, `WORKER_SECRET`, `ENABLE_WORKER_TRIGGER`, `ALLOWED_ORIGINS`,
  `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
  `SUPABASE_DB_URL`, `SUPABASE_JWKS`, `SUPABASE_PUBLISHABLE_KEYS`,
  `SUPABASE_SECRET_KEYS`.
- Provider secrets intentionally absent: no `META_*`, no `RAZORPAY_*`.
- Endpoint liveness + anonymous rejection (unauthenticated `POST`, no apikey):
  - `/provision-hospital` → **401**
  - `/hospital-activation` → **401**
  - `/run-cron-minute` → **401**
  Confirms the endpoints are live and anonymous access is denied (§8/§10). Note
  (AGENTS.md F16-05 nuance): a 401 here is the platform `verify_jwt` layer
  rejecting the missing key; it is NOT by itself proof of application-level
  privilege denial. Authenticated role/tenant probes require real user JWTs and
  remain UNPROVEN at staging HTTP level (see §16).

Level: endpoint existence + anonymous denial = RUNTIME VERIFIED; authorized-role
success path = UNPROVEN (no client-held staging keys / no test users created).

---

## 7. Frontend Verification

NOT performed at staging HTTP/browser level this session. `apps/web`
(Vite/React, `vercel.json` framework=vite) exists with its own CI job
(`.github/workflows/ci.yml` → typecheck/build/vitest/secret-scan), but a staging
frontend deployment + route walkthrough (§9) was not executed.
Status: **UNPROVEN** at staging.

---

## 8. Security Verification

Static/DB-level (RUNTIME VERIFIED on live staging):
- RLS enabled on 98 tables, forced on 96.
- 144 live RLS policies.
- Anonymous HTTP requests to protected functions rejected (401, §6).

Not performed this session (UNPROVEN at staging):
- Authenticated cross-hospital isolation via HTTP (Hospital A user reading
  Hospital B) — needs provisioned staging users/JWTs.
- Browser-direct PostgREST privilege boundary at staging — needs anon/service
  keys held locally (they are not; only placeholders).
- `SECURITY DEFINER` RPC live denial census at staging — Gate-2 catalog/privilege
  work was LOCAL; staging catalog ACL was not re-censused here.

---

## 9. Worker Verification (live staging)

| Signal | Value | Meaning |
| --- | --- | --- |
| `job_queue` total | 77 | observed job rows |
| status = `dead` | 77 | all reached terminal dead-letter |
| `processing_started_at` populated | 77 | worker actually started each |
| `worker_id` + `lease_expires_at` populated | 70/70 whatsapp, 7/7 sla | **lease persistence works (P0-01 fix holds on staging)** |
| `ever_completed` | 0 | no fully-successful job observed (§16) |
| `worker_registry` rows | 18713 | workers registered repeatedly (scheduler-driven wakes) |
| `worker_heartbeat_log` rows | 153 | heartbeat loop active |
| `worker_job_leases` rows | 0 | no lease currently held (queue drained to dead) |

Dead-letter composition (retry→exhaustion→DLQ proven at runtime):
- 70 × `send_whatsapp_message`, attempt_count 5/5 → `WhatsApp send failed (401): UNAUTHORIZED_NO_AUTH...` (Meta creds absent by design, §15).
- 7 × `compute_sla`, attempt_count 5/5 → `null value in column "sla_wait_breached" ...` (candidate defect, §16).

Required-test coverage from prompt §12, mapped to staging evidence:
1. Basic execution (claim+execute) — **PARTIAL**: claim/start/lease proven; a *successful* completion not observed (only failure paths).
2. Concurrent claiming — **UNIT/INTEGRATION VERIFIED locally; UNPROVEN as a fresh staging observation**.
3. Lease behavior — **RUNTIME VERIFIED** (lease_expires_at populated; recovery depends on it).
4. Retry — **RUNTIME VERIFIED** (attempt_count reached 5).
5. Permanent failure → terminal — **RUNTIME VERIFIED** (status `dead`).
6. Dead-letter — **RUNTIME VERIFIED**.
7. Crash recovery — **UNPROVEN** at staging (no live stranded-then-reclaimed job observed this session).
8. Scheduler auth (fail-closed) — **UNIT VERIFIED** (`_shared/cron_auth.ts`, wrong/missing→403); staging `verify_jwt` returns 401 pre-app (§6 nuance).
9. Duplicate scheduler invocation — **UNPROVEN** at staging this session.
10. Observability (diagnosable from DB) — **RUNTIME VERIFIED** (last_error, worker_id, attempt telemetry present).

---

## 10. Scheduler Verification (live staging)

| Check | Result |
| --- | --- |
| pg_cron installed | YES |
| pg_net installed | YES |
| `cron.job` registrations | jobid 1 `* * * * *` → `SELECT public.scheduler_fire_minute()`; jobid 2 `0 3 * * *` → `SELECT public.scheduler_fire_nightly()`; database `postgres`, user `postgres` |
| `cron.job_run_details` last 24h | **1441 succeeded**, 0 failed, 0 running |
| Latest minute fires | 17:06, 17:07, 17:08, 17:09, 17:10 on 2026-10-03, each `succeeded` (`1 row`) |

1441 ≈ 1440 = exactly one execution per minute across a rolling 24h window.
This is **continuous scheduler autonomy RUNTIME VERIFIED on staging**, which
directly supersedes the "no scheduler exists" baseline.

---

## 11. 24-Hour Soak

- **Scheduler layer**: a genuine ≥24h continuous runtime window IS evidenced by
  `cron.job_run_details` (1441 succeeded / 0 failed over last 24h). Recorded
  honestly as *passively observed*, not a freshly started soak.
- **Worker happy-path soak**: a controlled ≥24h soak that produces *successful*
  job completions was **NOT started** this session and cannot be completed
  within it. Per prompt §13, this status is **BLOCKED / UNPROVEN**, not PASS.
  No 24h soak result was fabricated.
  Existing scripted harness: `deno task soak:autonomy`
  (`scripts/ws_ops1_autonomy_soak.ts`) — not executed here.

---

## 12. End-to-End Hospital Journey (staging)

NOT executed this session. The journey's Edge Functions (provision → configure →
clinical-configuration → cancellation-policy → integration-configuration →
activation) are now **deployed** (parity restored), and their DB objects are
migrated, but a live authenticated walkthrough (staff login → booking → queue →
cancellation → audit → reports) requires real staging users/JWTs and would create
tenant/financial rows. Deferred to owner-authorized controlled run.
Status: **UNPROVEN** at staging.

---

## 13. Tests Executed (exact)

This session performed **no** local suite re-runs (baseline 537/537 integration
is a LOCAL figure carried from prior work; not re-verified here). Staging
evidence came from direct read-only runtime queries, not the Deno suites.

Runtime probes executed (read-only unless noted):
- `supabase projects list` · `migration list --linked` · `functions list` ·
  `secrets list` — read-only.
- `supabase db query --linked` SELECTs against `pg_extension`, `cron.job`,
  `cron.job_run_details`, `information_schema.columns/tables`, `pg_policies`,
  `pg_class`, `job_queue`, `worker_registry`, `worker_heartbeat_log`,
  `worker_job_leases` — read-only.
- Unauthenticated HTTP `POST` to 3 staging functions — read-only denial probes.
- **6 × `supabase functions deploy`** — the only WRITE action (idempotent
  Edge-layer deploy; no data/DDL mutated).

---

## 14. Files Changed

This session created/changed **no source files**. Only:
- Deployed existing source functions to staging (no file edit).
- Added this report file.

## 15. Database Changes

**None.** No `db push`/`db reset`/DDL/migration applied to staging or local.
Migrations 71/72 not rerun. Migration 73 not created.

---

## 16. Known Limitations / Candidate Findings

1. **No successful job completion observed on staging** (`ever_completed=0`). The
   worker happy-path (claim→process→success) is proven *mechanically* (start +
   lease + retry + dead) but not with a green completion on real work. Local
   integration tests cover the success path; staging happy-path soak is UNPROVEN.
2. **Candidate defect — `compute_sla` dead-letters on staging**: 7 jobs failed at
   `null value in column "sla_wait_breached"`. Per prompt §16 this is DOCUMENTED,
   not silently fixed (reproduction captured: status `dead`, attempt 5/5,
   last_error preserved). Requires investigation whether the SLA job payload or
   the `compute_sla_tracking` RPC default is at fault on staging data.
3. **HTTP authenticated security / journey not exercised** — no local plaintext
   anon/service keys (placeholders only) and no staging test users provisioned.
4. **Frontend staging not deployed/verified** this session.
5. **Provider integrations UNPROVEN (intended)** — Meta/Razorpay secrets absent;
   WhatsApp jobs correctly dead-letter at the provider 401 boundary. §15 respected.
6. **Local vs staging test parity** — the 6 newly-deployed functions were
   exercised by LOCAL integration tests; their STAGING runtime behavior (beyond
   anonymous denial) is UNVERIFIED.

---

## 17. Owner / Environment Blockers (exact action list)

- To run the WS-OPS-1 ≥24h WORKER soak and observe a successful job: authorize
  `deno task soak:autonomy` against staging (it enqueues real jobs) OR approve a
  controlled staging test-hospital + benign job producer.
- To complete §14 journey + §10 authenticated security: provision isolated
  staging test users (global-admin, hospital-A/B staff) with known creds NOT
  committed, or grant the operator a scoped management path.
- To resolve blocker #2: decide whether `compute_sla` staging failures are a real
  defect (then a scoped fix + regression) or bad staging seed data.
- To enable §15 provider foundations (only when authorized): set sandbox
  `META_*` / `RAZORPAY_*` staging secrets — currently correctly absent.

---

## 18. Local vs Staging vs Production Evidence

LOCAL:
- 537/537 integration (prior baseline), unit suites, migrations reconciled.
- Privilege/RLS catalog census (Gate 2): 139 policies at that snapshot; 213
  SETURA-owned routines boundary. (Local only.)

STAGING (`setura-staging`, live this session):
- Migrations 01–72 == local, zero drift.
- pg_cron + pg_net installed; scheduler 1441/0-fail in last 24h.
- 32/32 Edge Functions deployed (6 added this session).
- Worker lease/retry/DLQ runtime-verified; 77 dead with full telemetry.
- RLS 98 enabled / 96 forced / 144 policies; anonymous HTTP → 401.
- Provider secrets absent.

PRODUCTION:
- **UNPROVEN.** No production project, no production deploy, no production
  privilege/RLS/function/scheduler/soak evidence. Staging results must NOT be
  read as production readiness (prompt §20).

---

## 19. Final Status

**B — STAGING PARTIALLY VERIFIED; REMAINING ITEMS BLOCKED.**

Genuinely proven on staging this session: DB migration parity, scheduler
installation + >24h continuous success, worker claim/lease/retry/DLQ, Edge
secret provisioning, function parity restored, anonymous-access denial, RLS
posture. Genuinely blocked/unproven: worker happy-path ≥24h soak, authenticated
security + full hospital journey, frontend staging, provider integrations, all
of production.

---

## 20. Recommended Next Dependency

Run the WS-OPS-1 controlled **worker soak producing a successful job** against
staging (§11), then a **single authenticated end-to-end hospital journey**
(§12/§14) with owner-provisioned staging test users. Those two, plus resolving
the `compute_sla` staging dead-letter finding (§16.2), are the critical path to
upgrading "STAGING PARTIALLY VERIFIED" to "STAGING VERIFIED + RUNTIME PROVEN."
Do not open provider (WhatsApp/Razorpay) or production work until staging runtime
is closed.
