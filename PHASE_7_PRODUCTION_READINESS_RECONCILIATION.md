# PHASE 7 — PRODUCTION READINESS RECONCILIATION

Phase 7 working-session deliverable: a factual production-readiness
inventory and gap register. **No implementation, no deployment, no
credential creation occurred in this session.**

Status vocabulary (exact words required by the Phase 7 brief):
`PROVEN · IMPLEMENTED · BLOCKED · DEFERRED · NOT IMPLEMENTED`.

Verification hierarchy per AGENTS.md §5: source/SQL inspected first;
completion reports used only as pointers; local evidence is never
converted into production evidence.

---

## 1. Executive summary

The Phase 0–6 claim in the Phase 7 brief reconciles against the
repository with three corrections and one regression finding:

- **Corrections to the stale AGENTS.md §13 baseline.** Three of the four
  AGENTS.md "known open findings" now have remediation migrations on
  disk: P0-01 → migration 51 (`claim_jobs_v2` lease fix), P0-02 →
  migration 53 (pg_cron + pg_net scheduler with Vault-provisioned
  secrets), P0-04 → migration 54 (`booking_fee_inr` runtime writer).
  These are IMPLEMENTED; their local runtime proof is partially logged
  (see §8–§9), and production proof remains BLOCKED (no deployment
  exists). P0-03 (`ENABLE_WORKER_TRIGGER=false`) is still valid in the
  current `.env.example` (line 16).
- **Regression finding — RESOLVED same-day by the G7-01 work
  package.** The most recent logged W1 worker run in this tree —
  `_w1_test.log`, 2026-09-18 — ends **`FAILED | 3 passed | 1 failed`**:
  *"a crashed worker's in-flight job is reclaimed (not stranded)"*
  (`tests/integration/worker_lifecycle.test.ts:350`). Diagnosis
  (2026-09-19, `PHASE_7_G7_01_WORKER_RECLAIM_REPORT.md`): the log is a
  **stale snapshot** written 23:28:33, ~4 minutes before the final
  revisions of the test and migration 52 (23:32:51); the recorded 42702
  came from migration 19's ambiguous `RETURNING`, which the live
  catalog no longer contains. Fresh runs: W1 **4/4**, worker regression
  **7/7**. Crash recovery is therefore **PROVEN (local)**; the Phase 7
  brief's "Phase 1 COMPLETE" claim is now supported.
- **Missing reports.** No Phase 1 (worker) or Phase 2 (scheduler)
  completion report exists in the repository; their evidence is
  migrations 50–53, four worker/scheduler integration suites, and the
  root logs. The brief's "Phase 1/2 complete" therefore rests on
  partial evidence: IMPLEMENTED and locally tested, with one logged
  failing test (above) and no committed completion report.

Everything else: the backend core journey, financial correctness wave,
S1 security certification and Phase 6 console are locally
PROVEN/WITH-BLOCKED-EXTERNAL per their completion reports. **Zero
production infrastructure exists**: no deploy pipeline, no production
Supabase project, no provisioned secrets, no configured
backup/recovery, no external error tracking, no scheduler/Vault
provisioning. `LOCAL PASS ≠ PRODUCTION PASS` holds across every line of
this document.

---

## 2. Current architecture (verified against source)

- **Data plane:** 56 migrations (`supabase/migrations/01…56`),
  PostgreSQL 17 (`config.toml` `major_version = 17`), RLS-enforced
  multi-tenancy, canonical RPCs behind every mutation.
- **Compute plane:** 27 Edge Functions under `supabase/functions/`
  over shared primitives (`env.ts` typed validation, `db.ts`
  `getServiceClient()`, `auth.ts` `resolveAuth()`/`requireRole()`,
  `audit.ts`, `response.ts`, `errors.ts`, `idempotency.ts`,
  `cron_auth.ts`, `webhook_signature.ts`, `logger/metrics/tracing`,
  `worker.ts`).
- **Autonomy layer:** `job_queue` + `claim_jobs_v2` + worker lease/
  registry + canonical `dead_letter_jobs` DLQ (migrations 06/19/50–52);
  pg_cron + pg_net scheduler firing `run-cron-minute` /
  `run-cron-nightly` machine endpoints (migration 53).
- **Integrations:** Razorpay (`create-payment-order`, `verify-payment`,
  `process-refund` → `api.razorpay.com`), Meta WhatsApp Cloud API
  (`process-whatsapp-webhook` HMAC-verified, `send-whatsapp-message`).
- **Frontend:** `apps/web/` React + Vite + TS thin client (Phase 6),
  38 modules, no business logic, anon-key + JWT only.
- **CI:** `.github/workflows/ci.yml` = quality + local-stack test jobs
  only. No deploy stage. (Tree is not a Git repo — CI reachability
  unmeasurable, AGENTS.md §13.)

---

## 3. Phase 0–6 state (report claims vs. repository evidence)

| Phase | Brief's claim | Repository evidence | Reconciled state |
| --- | --- | --- | --- |
| 0 — hotfixes | COMPLETE | `PHASE_0.5_COMPLETION_REPORT.md` (✅ COMPLETE & CERTIFIED) | Consistent |
| 1 — worker lifecycle | COMPLETE | Migrations 50–52; `worker_lifecycle/lease_persistence/job_failure` integration suites; `_w1_test.log` = 3 passed / **1 failed** (crash reclaim) | **PARTIALLY CONSISTENT — logged failure on crash reclaim; no completion report** |
| 2 — scheduler/autonomy | COMPLETE | Migration 53; `scheduler_autonomy.test.ts`; Vault-based fire functions | IMPLEMENTED; committed runtime proof UNPROVEN (no dedicated log/report found) |
| 3 — financial correctness | COMPLETE | `PHASE_3_FINANCIAL_CORRECTNESS_REPORT.md`: "PHASE 3 COMPLETE — WITH BLOCKED EXTERNAL/ENVIRONMENT EVIDENCE"; migrations 54–56 | Consistent; report itself qualifies "NOT the whole financial wave — NPD-gated items" |
| 4 — E1 core journey | COMPLETE | `PHASE_4_E1...REPORT.md`: "PHASE 4 COMPLETE — WITH BLOCKED EXTERNAL/ENVIRONMENT EVIDENCE"; `_e1_run1..4.log` | Consistent |
| 5 — S1 security | COMPLETE | `PHASE_5_S1...REPORT.md`: "PHASE 5 COMPLETE — WITH BLOCKED EXTERNAL/ENVIRONMENT EVIDENCE" | Consistent |
| 6 — staff frontend | COMPLETE | `PHASE_6_STAFF_FRONTEND_REPORT.md`: "PHASE 6 COMPLETE — WITH BLOCKED EXTERNAL/ENVIRONMENT EVIDENCE" | Consistent |

No Phase 7 report existed before this session (glob confirmed).

---

## 4. Production-readiness matrix

| # | Requirement | Status | Basis |
| --- | --- | --- | --- |
| A | Production deployment architecture | NOT IMPLEMENTED | No deploy job in CI; no hosting/domain/infra config in tree |
| B | Secrets/configuration definition | IMPLEMENTED | `_shared/env.ts` typed fail-fast validation; `.env.example` complete |
| B′ | Production secrets provisioning | NOT IMPLEMENTED | No platform secret store content, no Vault rows outside local migration |
| C | Supabase production project | NOT IMPLEMENTED | No `supabase link`ed production project; `.temp/linked-project.json` is local-stack metadata |
| D | Edge Function deployment | NOT IMPLEMENTED | Code + shared `deno check` pass; never deployed anywhere |
| E | Migration deployment | IMPLEMENTED (files) / NOT IMPLEMENTED (applied to prod) | 56 ordered migrations; `validate:migrations` green per AGENTS baseline; production DB does not exist |
| F | Auth configuration | IMPLEMENTED (local) / NOT IMPLEMENTED (prod) | `config.toml` auth is localhost-only (site_url `127.0.0.1:3000`); no SMTP anywhere → password-reset email path BLOCKED even staging |
| G | RLS/privileges in production | BLOCKED | Gate 2 census is local-only; production catalog cannot be measured (no deployment) |
| H | Worker execution | PROVEN (local incl. crash reclaim) / NOT IMPLEMENTED (prod) | §8; G7-01 closed 2026-09-19 |
| I | Scheduler execution | PROVEN (local SQL layer) / BLOCKED (prod HTTP wake) | §9; G7-07 closed locally 2026-09-19 |
| J | Background jobs | PROVEN (local claim/complete/retry/DLQ) | `_w1_test.log` 3/4 ok; `worker_job_failure.test.ts` |
| K | Financial/payment integration | IMPLEMENTED (code) / BLOCKED (real Razorpay) | §10 |
| L | WhatsApp/Meta integration | IMPLEMENTED (code) / BLOCKED (real Meta) | §11 |
| M | Observability | IMPLEMENTED (in-code) / NOT IMPLEMENTED (external monitoring) | §12 |
| N | Error handling & recovery | IMPLEMENTED (typed error hierarchy, DLQ, fail-closed auth) | `docs/ERROR_CONTRACT.md`, `errors.ts`, migration 50 |
| O | Backup/recovery | NOT IMPLEMENTED | Nothing in tree; no policy document |
| P | Production security | BLOCKED | S1 local baseline PROVEN-with-blocked; production posture unmeasured |
| Q | Deployment rollback | NOT IMPLEMENTED (procedure) / IMPLEMENTED (tooling pieces) | migration 26 metadata/registry, migration 18 config rollback, `validate_migrations.ts` rollback-risk checks — but no deployment to roll back and no playbook |
| R | Pilot hospital preparation | NOT IMPLEMENTED | No tenant-provisioning runbook; seed.sql is local-demo only |
| S | Real-world acceptance testing | BLOCKED | Requires production + external credentials |

---

## 5. Deployment requirements (inspected, nothing deployed)

What a production deployment concretely requires, per current source:

1. **Production Supabase project** (Postgres 17 to match
   `config.toml.major_version` — cloud project must be created with the
   same major).
2. **Migration application** — `supabase db push` of the 56-file chain;
   `deno task validate:migrations` is the existing gate.
3. **Edge Function deploy** — 27 functions via `supabase functions
   deploy`; every function cold-starts requiring `SUPABASE_URL`,
   `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (`env.ts` fails
   fast without them).
4. **Secrets set** on the platform (`supabase secrets set`) — matrix in
   §6.
5. **Vault provisioning** for the scheduler (migration 53 reads
   `setura_scheduler_api_key`, `setura_cron_secret` from
   `vault.decrypted_secrets`; `public.scheduler_http_config` base URL
   defaults NULL → scheduler is a fail-closed no-op until provisioned).
6. **pg_cron on cloud**: migration 53's premise (`cron.database_name =
   'postgres'`) was verified against the **local image only**; hosted
   Supabase pg_cron configuration must be re-verified at deploy —
   UNPROVEN.
7. **Frontend hosting** for `apps/web` (build = `npm run build` →
   `dist/`), with prod `VITE_SUPABASE_URL` + real public anon key.
8. **Domain + HTTPS + `site_url`/redirect URLs in Auth + `ALLOWED_ORIGINS`
   alignment** (CORS default already encodes `setura.in` /
   `app.setura.in` in `env.ts`).
9. **CI/CD**: none exists (ci.yml stops at tests).
   **Premise correction (G7-02 session, 2026-09-19): the tree IS now
   a Git repository** with a pushed GitHub remote (5 commits,
   `main == origin/main`) — superseding the AGENTS.md §13 "not a Git
   repo" finding. Repository hygiene has since been performed locally in
   the **G7-03 hygiene package (2026-09-19)**: a root `.gitignore` was
   created and 218 confirmed local/generated/session artifacts were
   `git rm --cached` (tracked 539 → 321, nothing deleted from disk), and
   the forward migration-immutability baseline
   `supabase/migrations/MANIFEST.sha256` (56 migrations, 0 mismatches)
   was committed. D8 (graphify-out tracking) intentionally DEFERRED; D9
   (.qoder) untracked. The hygiene commit is **LOCAL ONLY — NOT PUSHED**
   (`PHASE_7_G7_02_DEPLOYMENT_ARCHITECTURE.md`;
   `PHASE_7_G7_03_REPOSITORY_HYGIENE_REPORT.md`).
   **G7-02 I-2 CI/CD extension (2026-09-19): the CI pipeline was
   extended (2 → 4 jobs) locally** — `quality` now enforces the
   migration manifest (`scripts/validate_migration_manifest.ts`,
   append-only vs the PR base) and names the reused F16-04 privilege
   guard; a new `frontend` job runs `npm ci`/typecheck/build/test and a
   built-bundle secret + source-map scan
   (`scripts/check_frontend_secrets.ts`); a `release-validation` job
   (push:main only) runs the consolidated regression
   (`deno task test:consolidated`) and emits a provenance manifest
   (`scripts/release_manifest.ts`, `deployment: NOT PERFORMED`).
   Verifier green on the real tree (56/56, 0 issues); +10 guard unit
   tests (91 passed / 0 failed); frontend typecheck/build/vitest green
   locally. This is **CI configuration + local tooling only**: no
   GitHub Actions execution (no push), no deploy, no environment, no
   secret. The commit is LOCAL ONLY — NOT PUSHED
   (`PHASE_7_G7_02_I2_CI_IMPLEMENTATION_REPORT.md`).

**Status: NOT IMPLEMENTED** (requirements enumerated; nothing
provisioned — per brief §7, nothing was deployed).

---

## 6. Secrets / configuration matrix

All variables below are the ones the **current** code actually reads
(`_shared/env.ts` + one direct `Deno.env.get` in `phone.ts`). No values
were printed, created, or committed.

| Variable | Read by | Required? | Current posture |
| --- | --- | --- | --- |
| `SUPABASE_URL` | every function (via `Env`) | **hard-required** (URL-validated) | example placeholder |
| `SUPABASE_ANON_KEY` | every function | **hard-required** | example placeholder |
| `SUPABASE_SERVICE_ROLE_KEY` | every function (`getServiceClient`) | **hard-required** | example placeholder; never in frontend |
| `APP_ENV` | env.ts | optional, default `production` | ⚠ default is production — local runs must set it |
| `META_ACCESS_TOKEN` / `META_APP_SECRET` / `META_WEBHOOK_VERIFY_TOKEN` / `META_PHONE_NUMBER_ID` / `META_API_VERSION` | send-whatsapp-message, process-whatsapp-webhook | optional; webhook **fails closed** without `META_APP_SECRET`/verify token | NOT PROVISIONED locally (Phase 6 §I); production = BLOCKED (needs real Meta business assets) |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | create-payment-order, verify-payment, process-refund | optional at boot; verify-payment refuses HMAC without secret | NOT PROVISIONED; production = BLOCKED |
| `CRON_SECRET` | run-cron-minute/nightly, send-reminders, run-background-worker | optional; **empty ⇒ all cron endpoints 403 (fail-closed)** | not set locally (AGENTS §13); production provisioning NOT IMPLEMENTED |
| `WORKER_SECRET` | run-background-worker ⇄ send-whatsapp-message dispatch | optional | same |
| `ENABLE_WORKER_TRIGGER` | run-cron-minute gate | optional | **still `false` in `.env.example`** — P0-03 remains open as a documented-default risk |
| `WORKER_LEASE_SECS` | worker lease math | optional, default 30 | fine |
| `LOG_LEVEL`, `DEPLOYMENT_VERSION` | logger/versioning | optional | fine |
| `SENTRY_DSN` | **declared in env.ts but referenced nowhere else in `supabase/functions/`** | — | dead placeholder → error tracking NOT IMPLEMENTED (§12) |
| `MAX_BOOKING_ADVANCE_DAYS`, `RATE_LIMIT_WINDOW_MINUTES`, `RATE_LIMIT_MAX_ATTEMPTS`, `IDEMPOTENCY_TTL_HOURS` | validation/rate limiting | optional with defaults | fine |
| `ALLOWED_ORIGINS` | cors.ts | optional; prod default `setura.in`+`app.setura.in` | must match real domain at deploy |
| `ENABLE_TRACING`, `ENABLE_METRICS` | feature flags | optional, default true | fine |
| `SETURA_DEFAULT_COUNTRY_CODE` | phone.ts | optional | note: `formatE164()` per AGENTS §10 — verify usage stays normalization-only |
| Vault: `setura_scheduler_api_key`, `setura_cron_secret` | migration 53 fire functions | fail-closed no-op until present | NOT PROVISIONED anywhere (no vault seeding exists in seed.sql path for production) |

**Frontend env** (`apps/web/.env.example`): `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY` only — public values, service-role excluded by
design. Status: IMPLEMENTED (pattern correct); production values NOT
IMPLEMENTED.

---

## 7. Database readiness

- **Ordering/completeness:** 56 sequential migrations; the corrective
  chain (48 privilege hardening, 49 Phase-1.5 fixes, 50 P0-A DLQ, 51
  P0-E lease, 52 crashed-worker ambiguity, 53 scheduler, 54 booking-fee
  writer, 55 token-capacity daily-sum, 56 payment-capture path fix) is
  all present in the chain. Fresh-reset application is what CI's
  `supabase start` + `validate:migrations` exercise.
- **Edited applied migrations:** not verifiable — no Git history
  (AGENTS.md §13). Recorded as an explicit unknown (§22).
- **Extensions:** pg_cron created `IF NOT EXISTS` in migration 53;
  pg_net relied on image-provided install. On a hosted project both
  must be re-verified — BLOCKED (no production DB).
- **Grants/privileges:** every new or resignatured SECURITY DEFINER
  function in 50–56 carries its own explicit
  `REVOKE … FROM PUBLIC, anon, authenticated` + `GRANT … TO
  service_role` (verified by grep across 50–56) — the F16-04
  obligation is being honored in current source. Production catalog
  state: BLOCKED.
- **Tenant isolation / RLS / ledger protections / partitioning /
  retention:** implemented (migrations 01/10/15/22/23/34); locally
  certified in S1; production UNPROVEN.
- **Seed for production:** `seed.sql` is local demo data — production
  tenant provisioning has no mechanism (see gap G7-08).

**Status: IMPLEMENTED (schema/migrations) · BLOCKED (production
application and catalog verification).**

---

## 8. Worker readiness

Verified from current source + last logs:

- Claim/lease/complete, retry→dead-letter with correct columns, enqueue
  dedup, AND crashed-worker reclaim: **PROVEN (local)** —
  `_g701_repro1.log` 2026-09-19 shows **4/4 ok**; the earlier
  `_w1_test.log` FAIL was stale pre-fix evidence (the recorded 42702
  came from migration 19's ambiguous `RETURNING`, already replaced live
  by migration 52, whose in-migration verification executes the real
  function).
- Auth boundaries: worker endpoints fail closed without
  `WORKER_SECRET`/`CRON_SECRET` (`cron_auth.ts` unit-proven) —
  IMPLEMENTED; production invokers do not exist yet.
- Canonical DLQ is `dead_letter_jobs` (migration 50 fix); legacy
  `dead_letter_queue` untouched, per brief §10 — no action taken.
- Production execution model: `run-background-worker` is an HTTP
  Edge Function — production requires the scheduler (or external
  trigger) to invoke it continuously; with
  `ENABLE_WORKER_TRIGGER=false` as the shipped default, a documented
  default deployment would **not process jobs** (P0-03 still open).

**Status: PROVEN (local happy-path/retry/DLQ) · FAIL (crash reclaim,
last logged run) · NOT IMPLEMENTED (production execution).**

---

## 9. Scheduler readiness

- Migration 53: pg_cron jobs `setura_cron_minute` (every minute) and a
  nightly job, firing via `net.http_post` to `run-cron-minute` /
  `run-cron-nightly` with `X-Cron-Secret` + API key read from **Vault**;
  fail-closed no-op until `scheduler_http_config` base URL and Vault
  secrets are provisioned. Fire functions are service_role-only
  (explicit REVOKE verified).
- `run-cron-minute` fans out to reminder generation and (gated by
  `ENABLE_WORKER_TRIGGER`) the background worker — verified in source.
- `scheduler_autonomy.test.ts` (integration) now has a committed
  passing log — `_g707_scheduler.log`, 2026-09-19, **3/3** — and live
  `cron.job_run_details` shows 316 succeeded / 0 failed autonomous
  `setura_cron_minute` firings (G7-07 closed locally).
- Production: pg_cron provisioning on the hosted project, Vault secret
  creation, base-URL config and external reachability of the functions
  URL are all **NOT IMPLEMENTED** (nothing to deploy to yet).

**Status: IMPLEMENTED · PROVEN (local SQL layer + autonomous firing,
2026-09-19) · production: BLOCKED.**

---

## 10. Financial readiness

- Model confirmed in code: SETURA collects only the booking/platform
  fee via Razorpay orders (`create-payment-order` → 
  `api.razorpay.com/v1/orders`); refunds via `process-refund`;
  `verify-payment` HMAC-verifies webhooks against
  `RAZORPAY_KEY_SECRET`; capture path fixed in migration 56; fee
  snapshot writer in migration 54 (closes P0-04); idempotent capture
  (`idempotent_capture_payment`, service_role-locked).
- Locally proven: Phase 3 report (COMPLETE-with-BLOCKED) +
  `booking_fee_refund`, `refund_sync`,
  `settlement_record_payment` integration suites.
- Real Razorpay (order creation, capture, webhook delivery, refunds in
  test/live mode): **BLOCKED** — no keys exist; nothing was
  manufactured.
- Razorpay production webhook registration (callback URL, event
  subscription) cannot even be staged until §5 exists: NOT IMPLEMENTED.

**Status: IMPLEMENTED (code) · PROVEN (local contracts) · BLOCKED
(real gateway) · NOT IMPLEMENTED (production wiring).**

---

## 11. WhatsApp / Meta readiness

- Code: HMAC-X-signature verification keyed by `META_APP_SECRET`,
  `META_WEBHOOK_VERIFY_TOKEN` handshake, rejection of unsigned
  requests, inbound dedup, conversational engine (migrations 04/42 +
  `_shared/whatsapp/*`), outbound jobs enqueued and dispatched by
  `send-whatsapp-message` with worker-secret boundary. Unit-proven in
  `webhook_signature.test.ts`; integration suites
  `whatsapp_conversational/lifecycle.test.ts`.
- Enqueued ≠ delivered: local evidence proves job enqueue only (Phase
  6 §I). Real Meta delivery, template approval, production callback
  URL, business-asset onboarding: **BLOCKED** (no credentials, and
  creating them is not authorized this session).

**Status: IMPLEMENTED · BLOCKED (all external boundaries).**

---

## 12. Security readiness

- Baseline reused (not re-run, per brief §13): Phase 5 S1 =
  COMPLETE-with-BLOCKED; Gate 2 local privilege census (179 locked
  routines, 42501 runtime denials); 139 live RLS policies.
- Still unproven at the production boundary, all
  **BLOCKED/UNPROVEN** by construction (no production environment):
  production privilege catalog, production JWT config, real external
  webhook behavior, intra-hospital doctor→other-doctor patient scope.
- Test-quality debts from AGENTS §13 remain open in source:
  F16-05 (`privilege_isolation.test.ts` can accept a JWT-layer 401 as
  privilege-denial) and F16-06 (~22% locked-routine coverage) —
  neither was fixed in this session; both should be resolved during
  Phase 7 targeted verification rather than a full S1 re-run.
- Positive current-source check: F16-04 discipline (explicit REVOKE on
  each new/resignatured SECURITY DEFINER function) is honored in
  migrations 50–56 (§7).
- GoTrue seed NULL defect (Phase 6 §E/§J.3) is an environment/auth
  compatibility question that directly affects production sign-in —
  open Decision 3 below.

**Status: PROVEN (local S1 scope) · BLOCKED (production posture) ·
IMPLEMENTED (privilege hygiene in new migrations).**

---

## 13. Observability readiness

- In-code (IMPLEMENTED): structured JSON logger with request context,
  metrics, tracing, request IDs (`_shared/logger|metrics|tracing`),
  `DEPLOYMENT_VERSION` tag; operational monitoring tables/RPCs
  (migration 24), queue monitoring (17), `monitoring-health-check` and
  `alert-center` Edge Functions, DLQ visibility.
- Not present: **external** error tracking — `SENTRY_DSN` is declared
  but never used (no Sentry/alerting transport in any function);
  log/metric ingestion, dashboards, paging/alert routing, uptime
  checks, queue-depth/DLQ/payment-failure/webhook-failure **monitoring
  configured anywhere outside the database itself**: NOT IMPLEMENTED.
- "Code exists" vs "production monitoring configured": only the former
  is true.

**Status: IMPLEMENTED (in-app primitives) · NOT IMPLEMENTED (external
observability and alerting).**

---

## 14. Backup / recovery readiness

Nothing in the repository defines: database backups, PITR, restore
testing, migration rollback procedure, disaster recovery, tenant
decommissioning, or retention of financial/ledger data beyond the
internal retention/cleanup engine (migration 23 — which is data
*pruning*, not backup).

Not invented here. Product/platform decisions required first (hosted
Supabase tier determines PITR/backup availability; retention windows
must be reconciled with migration 23 cleanup and immutable-ledger
preservation).

**Status: NOT IMPLEMENTED; policy = DEFERRED pending explicit product
decision (§17 D5).**

---

## 15. Auth / tenant model readiness

- Implemented and locally proven: email/password, `user_roles` +
  `resolveStaffContext` DB-side role resolution, JWT bearer on every
  Edge Function, RLS tenant resolution, role guard server-side
  (`requireRole`), receptionist/doctor/hospital_admin/global_admin
  hierarchy (migration 27 role permissions, 30 device sessions).
- Production gaps (all config, none code): `site_url` /
  `additional_redirect_urls` are localhost values in `config.toml`;
  **SMTP is not configured anywhere** → password-reset and invitation
  emails cannot work outside inbucket; session expiry policy is the
  default 3600 s (decision needed for a hospital shift-length
  product); no production account-creation flow for pilot staff —
  seed.sql is the only tenant/staff provisioning mechanism and it is
  local-demo-only.
- Patient login: not present, not added (roadmap does not require it).

**Status: IMPLEMENTED + PROVEN (local core) · NOT IMPLEMENTED
(production auth configuration and staff onboarding path).**

---

## 16. Frontend production readiness

- Build/typecheck/tests: PROVEN locally (Phase 6 §F: `tsc --noEmit`
  clean, 17/17 unit, 19/19 E2E, 9/9 browser).
- Env pattern: correct — public anon only; service-role never
  client-side (Phase 6 §H). Production values do not exist yet (they
  depend on §5).
- Missing for production: hosting target, production
  `VITE_SUPABASE_URL`/anon provisioning, CORS alignment with
  `ALLOWED_ORIGINS`, deployment configuration, source-map policy
  review, dependency-vulnerability scan (no audit tooling has been run
  in this tree). Auth persistence across token expiry is unproven
  beyond Phase 6's session checks.

**Status: PROVEN (local) · NOT IMPLEMENTED (production deployment/
configuration).**

---

## 17. Pilot prerequisites

A pilot additionally requires, none of which exist today:

1. Production deployment (§5) — prerequisite to everything below.
2. Provisioned secrets + Vault + scheduler activation (§6, §9).
3. Worker execution including **working crash reclaim** (§8 FAIL must
   become PROVEN on real infra).
4. Real Razorpay account + webhook registration (§10).
5. Real Meta business asset + webhook callback + approved templates
   (§11).
6. External error tracking + alerting at least for DLQ, payment
   failures and webhook auth failures (§13).
7. Backup/PITR decision and first restore test (§14).
8. Production privilege catalog verification (roadmap Phase 7 line:
   re-measure the 179-locked census against the deployed DB).
9. Pilot tenant provisioning runbook (hospital + staff accounts +
   config without seed.sql).
10. Load test on the queue+worker path (explicit roadmap Phase 7
    item; nothing in tree).
11. E1-through-console acceptance on production, not localhost.

**Status: NOT IMPLEMENTED.** Per brief §18, no pilot activity was
conducted or scheduled.

---

## 18. Open product decisions (not silently resolved)

| ID | Decision | Current facts (verified) | Classification |
| --- | --- | --- | --- |
| D1 | Mandatory doctor on walk-in/appointment | `create-booking` attaches to callable queue only with `doctorId`; doctor-less ⇒ token, `queueSessionId=null` (Phase 6 §G.1) | DEFERRED — product ruling needed |
| D2 | Receptionists seeing doctor names | `profiles` RLS = self/hospital_admin; picker shows specialization only | DEFERRED — privacy/RLS decision, no workaround applied |
| D3 | GoTrue seed NULL-column defect | Local-only remediation UPDATEs in Phase 6 §E; not fixed in seed/migration; affects any fresh deploy of the same seed shape | DEFERRED — must be classified (seed vs GoTrue version vs config) before production provisioning |
| D4 | Notifications staff UI | NOT IMPLEMENTED (Phase 6 §K) | DEFERRED — placement (Phase 7 vs later) is this phase's planning decision |
| D5 | Backup/PITR/retention policy | No policy in tree; retention engine prunes data (migration 23) with no counterpart backup obligation | DEFERRED — explicit platform+product decision required |
| D6 | `ENABLE_WORKER_TRIGGER` shipped default | `.env.example` = false; a documented-default deploy would not process jobs (P0-03) | DEFERRED — deliberate default choice required (true + secret discipline, or false + external trigger mandate) |
| D7 | Scheduler on hosted Supabase | migration 53 premises verified locally only (cron.database_name, extension availability) | UNPROVEN → verify at provisioning; not a code decision |

---

## 19. Gap register

Severity-prefix allocation for these entries remains a Gate 8 action
(AGENTS/roadmap); the P-levels below are this phase's working
priorities as required by the Phase 7 brief §20.

| ID | Area | Current state | Evidence | Risk | Required action | Dependencies | Production impact | Priority | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G7-01 | Worker crash recovery | RESOLVED — reclaim invariant PROVEN (local); earlier FAIL was stale pre-migration-52 evidence | `_g701_repro1.log` 4/4; `_g701_regression_worker.log` 7/7; live `pg_proc` + `migration_registry` | In-flight jobs stranded on worker crash | ~~Diagnose, fix, rerun~~ done — no code change required | local stack | Pilot can run autonomous jobs (prod execution still gated by G7-02/03/09) | P0 | CLOSED (local) |
| G7-02 | Deployment pipeline | PLANNED (architecture doc) — repo + GitHub remote exist (premise corrected); CD pipeline absent; tree hygiene incomplete | `PHASE_7_G7_02_DEPLOYMENT_ARCHITECTURE.md`; `git remote -v`; `git ls-files` counts | Nothing can reach production safely; tracked local artifacts (hygiene now committed locally — G7-03) | Hygiene commit (DONE locally) → CI/CD extension (I-2 DONE locally, unpushed; GitHub execution UNPROVEN) → staging → gated production (all authorization-gated) | user authorization | Absolute blocker for all production claims | P0 | OPEN — PLANNED (hygiene I-1 + CI/CD I-2 done locally, unpushed) |
| G7-03 | Production secrets/Vault provisioning | Placeholders only; no vault seeding path | `.env.example`; migration 53 reads Vault | Scheduler/worker/cron endpoints stay fail-closed 403 | Provisioning runbook (placeholders only) for platform secrets + Vault + `scheduler_http_config` | G7-02 | Scheduler autonomy dead | P0 | OPEN |
| G7-04 | Production privilege verification | Local-only census | Gate 2 / Phase 5 reports | Local≠prod privilege posture | Catalog re-measure on deployed DB post-migration | G7-02 | Certification gate | P0 | OPEN |
| G7-05 | Real Razorpay boundary | BLOCKED (no credentials) | Phase 3 §; Phase 6 §I | Financial flows unexercised against gateway | Razorpay test-mode then live verification (authorization required) | G7-02/03 | Revenue path | P1 | OPEN |
| G7-06 | Real Meta boundary | BLOCKED | Phase 6 §I | Delivery/templates/webhook unexercised | Meta business onboarding + callback registration | G7-02 | Patient channel | P1 | OPEN |
| G7-07 | Scheduler end-to-end proof | CLOSED locally — PROVEN (SQL layer + autonomous pg_cron firing); authenticated HTTP wake stays BLOCKED (G7-03/G7-09), production BLOCKED (G7-02) | `_g707_scheduler.log` 3/3; `cron.job_run_details` 316 succeeded / 0 failed | Cannot claim autonomous firing even locally | ~~One targeted logged run~~ done | local stack | Gates G7-03/09 | P1 | CLOSED (local) |
| G7-08 | Tenant/staff provisioning | seed.sql is local-demo only | `supabase/seed.sql`, config.toml | No way to onboard pilot hospital safely | Production onboarding runbook/RPC path review | G7-02 | Pilot impossible | P1 | OPEN |
| G7-09 | `ENABLE_WORKER_TRIGGER` default | false shipped | `.env.example:16` | Documented default deploys non-processing system (P0-03) | Decision D6 + config change + docs | G7-03 | Silent dead queue | P1 | OPEN |
| G7-10 | External error tracking | SENTRY_DSN declared, unused | grep across `supabase/functions/` | Prod failures invisible outside DB | Initialize error transport or record explicit alternative | G7-02 | Ops recovery | P2 | OPEN |
| G7-11 | Backup/DR | None | repo-wide absence | Data-loss irreversibility | Decision D5 + first restore test | G7-02 | Mandatory for real patients | P2 (P0 before go-live with real data) | OPEN |
| G7-12 | Auth production config (site_url/SMTP/reset) | localhost config; no SMTP | `config.toml` | Password reset/invitations dead in prod | Prod auth config + SMTP provisioning | G7-02 | Staff onboarding | P2 | OPEN |
| G7-13 | F16-05 / F16-06 test debts | Open in source | AGENTS §13 | Privilege-denial proof weaker than claimed | Targeted test fixes (SQLSTATE-specific asserts; coverage uplift) | none | Security certification quality | P2 | OPEN |
| G7-14 | Load headroom (queue+worker) | No load data | roadmap §uncertainty 7 | Unknown at pilot volume | Load test on queue/worker path | G7-01/02 | Scaling risk | P3 | OPEN |
| G7-15 | Notifications staff UI | NOT IMPLEMENTED | Phase 6 §J.4 | Staff cannot see notification state | Decide placement (D4), then build | D4 | UX/ops only | P3 | OPEN |
| G7-16 | Migration immutability assurance | BASELINE ESTABLISHED (2026-09-19, G7-03): `MANIFEST.sha256` committed (56 migrations, verified 0 mismatches/0 missing/0 manifest-only, deterministic); `git log --diff-filter=M` shows exactly one post-addition edit (migration 53, commit 40d6b4a — in-session rewrite re-applied before any release); pre-import (before 2026-09-03) state unprovable forever; CI enforcement of the manifest still NOT IMPLEMENTED | `supabase/migrations/MANIFEST.sha256`; `PHASE_7_G7_03_REPOSITORY_HYGIENE_REPORT.md` §12-13; `git log` | Silent schema drift only detectable from baseline date forward, and only once CI gates it | Wire manifest verification into CI (future package) | G7-02 hygiene (done locally) | Integrity assurance | P3 | OPEN (forward baseline established; CI enforcement pending) |

---

## 20. Recommended execution order

1. ~~**G7-01**~~ **CLOSED 2026-09-19** (stale-evidence diagnosis; W1
   4/4 green, no code change — `PHASE_7_G7_01_WORKER_RECLAIM_REPORT.md`).
2. ~~**G7-07**~~ **CLOSED LOCALLY 2026-09-19** (`_g707_scheduler.log`
   3/3 + 316/0 live cron firings); authenticated HTTP wake remains a
   G7-03/G7-09 boundary.
3. **G7-02** — repository + deploy-transport decision (user
   authorization required; this session performed no deployment).
4. **G7-03 → G7-04 → G7-09** — production provisioning runbook
   (placeholders only), deploy, then production privilege catalog
   verification; flip the worker-trigger default per decision D6.
5. **G7-08, G7-12** — tenant/staff provisioning + production auth
   (SMTP/reset) configuration.
6. **G7-05 / G7-06** — Razorpay and Meta staging/live verification,
   strictly with user-authorized real credentials.
7. **G7-10, G7-11** — error tracking and backup/DR before any real
   patient data.
8. **G7-13 → G7-14 → G7-15 → G7-16** — hardening, load, enhancements.
9. Consolidated regression (E1, W1, scheduler, financial, S1 subsets,
   frontend build/unit, core-journey E2E) before any Phase 7 completion
   claim.

---

## 21. Explicit blockers (external, not resolvable from this tree)

- No production Supabase project, credentials or deployment target.
- No Razorpay keys, no Meta/WhatsApp business assets, no SMTP
  provider — all intentionally un-fabricated (brief §8: placeholders
  only).
- Repository is not a Git repo → CI reachability and migration-history
  integrity are unmeasurable, not merely unknown (AGENTS §13).
- Real-pilot conduct requires the prerequisites in §17 and explicit
  user authorization per brief §25.

## 22. Explicit unknowns / UNPROVEN

- Whether W1's crash-reclaim FAIL is an implementation defect, a test
  defect, or environment drift since migrations 51–52 (not diagnosed
  this session by design).
- Whether `scheduler_autonomy.test.ts` currently passes (no committed
  passing log found).
- Hosted-Supabase behavior of pg_cron/pg_net/Vault as configured by
  migration 53 (UNPROVEN — provisioning assumption until measured).
- GoTrue seed NULL-column defect classification (D3).
- Frontend dependency-vulnerability state (no audit tooling run).
- Any production measure: privilege catalog, RLS policy count, JWT
  config, job execution, payment/webhook behavior — all UNPROVEN
  because no production environment exists.

## 23. Evidence references

Source: `supabase/functions/_shared/env.ts`, `cron_auth.ts`,
`run-cron-minute/index.ts`, `run-cron-nightly`, `run-background-worker`,
`create-payment-order`, `verify-payment`, `process-refund`,
`process-whatsapp-webhook`, `send-whatsapp-message`; migrations
`50_p0a…`, `51_p0e…`, `52_w1…`, `53_phase2…`, `54_booking_fee_writer`,
`55_token_capacity…`, `56_payment_capture…`; `supabase/config.toml`;
`.github/workflows/ci.yml`; `.env.example`; `apps/web/.env.example`.
Logs: `_w1_test.log`, `_e1_run1..4.log`. Reports:
`PHASE_{3,4,5,6}_*_REPORT.md`, `SETURA_FINAL_MASTER_ROADMAP.md`
(Phase 7 section), AGENTS.md §13 (baseline, partially stale — see §1).

---

```text
PHASE 7 RECONCILIATION STATUS

Repository inspected: YES
Roadmap reconciled: YES
Production readiness matrix: COMPLETE
Gap register: COMPLETE

P0 blockers:
(none open — G7-01 CLOSED locally 2026-09-19)
G7-02 deploy pipeline absent; repo/remote exist; hygiene DONE locally (G7-03 package, unpushed)
G7-03 production secrets + Vault provisioning absent
G7-04 production privilege catalog unverified (no deployment)

P1 blockers:
G7-05 real Razorpay boundary BLOCKED
G7-06 real Meta boundary BLOCKED
(none open — G7-07 CLOSED locally 2026-09-19)
G7-08 no production tenant/staff provisioning path
G7-09 ENABLE_WORKER_TRIGGER=false documented default (P0-03)

P2 hardening:
G7-10 external error tracking absent (SENTRY_DSN unused)
G7-11 backup/DR undefined
G7-12 production auth config (site_url/SMTP/reset) absent
G7-13 F16-05 / F16-06 test debts

Deferred decisions:
D1 doctor-assignment mandatory · D2 doctor names for reception ·
D3 GoTrue seed defect classification · D4 notifications UI placement ·
D5 backup/PITR policy · D6 worker-trigger shipped default ·
D7 hosted pg_cron/Vault behavior (verify at provisioning)

Production deployment:
NOT STARTED

Overall:
READY FOR PHASE 7 IMPLEMENTATION
(G7-01 and G7-07 closed locally 2026-09-19; next target is G7-02, which
requires an explicit user authorization decision before anything
reaches production)
```
