# SETURA — Phase 7, Part 3: Production Go-Live Architecture & Readiness Plan

Date: 2026-09-21 (UTC+5:30 session)
Scope: **architecture + readiness PLAN ONLY.** No production deployment, no
production project creation, no production migration push, no Edge Function
deploy, no secret creation, no Razorpay/Meta/SMTP activation, no DNS change,
no staff provisioning, no real patient/pilot data, no real payment. Every
one of those remains explicitly unauthorized in this package.

Method: authoritative reports were used as **evidence pointers**, then the
critical current-state claims were re-verified against the actual repository,
config and source (see §2). Local/staging evidence is never converted into a
production claim.

Classification vocabulary (only these words are used in status columns):
**PROVEN · IMPLEMENTED · BLOCKED · DEFERRED · NOT IMPLEMENTED · UNPROVEN.**
Words such as READY / GOOD / SAFE / PRODUCTION READY / COMPLETE are not used
as status unless a specific piece of evidence supports the exact statement.

---

## 1. Executive summary

SETURA has a verified **local** stack and a verified **hosted staging**
backend + frontend (Part 2). What does **not** exist is any production
environment. Production go-live is therefore gated not by unknown
architecture but by **provisioning actions that only the owner can authorize**
(create production project, provision secrets, register live webhooks, buy a
domain) and by **genuine business-policy decisions** (revenue recognition,
retention/backup tier, worker-trigger default, fee-refund basis).

Key reconciliations against the Part 3 brief's "verified state":

- The Git-transport premise is **corrected** (as G7-02 already found): the
  working tree **is** a Git repository. `HEAD = origin/main = main =
  56065ed`, 399 tracked files, a root `.gitignore` exists. The AGENTS.md §13
  "not a Git repo" line is stale and superseded.
- The working tree is **NOT clean**: exactly one file is modified —
  `PHASE_7_PART_2_STAGING_DEPLOYMENT_REPORT.md` (a prior-session report). It
  is unrelated to this plan and is left untouched.
- **One live staging gap is BLOCKED / owner decision (§below):**
  `queue-control` from `https://setura-delta.vercel.app` is CORS-blocked
  because staging `ALLOWED_ORIGINS` does not include that origin. This
  package does not modify Supabase secrets.

Bottom line: a controlled, auditable, reversible LOCAL → STAGING → PRODUCTION
path is **designable now** with no invariant weakened. Execution is
authorization-gated at every external step. **Production readiness is NOT
claimed.** Overall status: **PLANNED — NOT IMPLEMENTED.**

---

## 2. Current verified state (re-verified this session)

| Fact | Value | How verified | Status vs brief |
| --- | --- | --- | --- |
| Git repo | exists, remote GitHub `YeswanthArasavalli/Setura` (private) | `git rev-parse`, `git log` | brief CORRECT (AGENTS §13 stale) |
| HEAD / main / origin/main | all `56065ed` | `git log --oneline -5` | CORRECT |
| Working tree | 1 modified file (`PHASE_7_PART_2...REPORT.md`) | `git status --porcelain` | brief said "clean except documented report change" — CONSISTENT |
| Tracked files | 399 | `git ls-files \| count` | hygiene committed |
| Root `.gitignore` | present | `Test-Path` | hygiene done |
| Migrations | 58 (`01…58`) | directory count | CORRECT |
| `MANIFEST.sha256` | 58 lines | line count | CORRECT (56→58 in Part 2) |
| Edge Functions | 26 + `_shared` (27 dirs) | directory count | CORRECT |
| Postgres major | 17 | `config.toml:36` | CORRECT |
| Auth `site_url` | `http://127.0.0.1:3000` (localhost) | `config.toml:154` | NOT IMPLEMENTED (prod) |
| `jwt_expiry` | 3600 s | `config.toml:160` | default — decision D12 pending |
| `ENABLE_WORKER_TRIGGER` (example) | `false` | `.env.example:16` | P0-03 still open |
| `ALLOWED_ORIGINS` (example) | `setura.in`, `app.setura.in` | `.env.example:17` | must match real domain at deploy |
| `APP_ENV` default | `production` | `.env.example:4` | local runs must override |
| CI jobs | `quality`, `frontend`, `stack`, `release-validation` | `ci.yml` | 4 jobs in source; GitHub Actions run status UNPROVEN |
| CODEOWNERS | absent | recursive glob | NOT IMPLEMENTED |
| Vercel project | `setura` (`prj_PZq3TlY28vzz3hF6x0TKpvxK6gMH`), root dir `apps/web`, prod alias `setura-delta.vercel.app` | Part 2 §12 (config-only fix) | DO NOT recreate / re-change root dir |
| Staging backend | ref `gzcqasntcbqqmgsoikms`, ap-south-1, 58 migrations, 94/94 RLS, 139 policies, scheduler+worker PROVEN hosted | Part 2 §1,§4 | PROVEN (staging only) |
| GoTrue seed defects | fixed at source (`seed.sql` `auth.identities` INSERT + `email_change*` values) | grep `seed.sql` L62/L90/L96 | source fix committed (D3) |

Handed-off but **not re-audited** (Part 2 evidence, treated as pointers): the
five hosted defect fixes D1–D5, credential rotation, deployed-bundle secret
scan (0 real secrets), live UI E1 6/6, UI tenant isolation A↔B zero leakage.

---

## 3. Target production architecture (logical)

```
                    ┌───────────────────────────────────────────┐
  Browser (SPA)     │  Vercel  (apps/web)   custom domain+HTTPS  │
                    └───────────────┬───────────────────────────┘
                                    │ VITE_SUPABASE_URL + ANON key (public only)
                                    ▼
                    ┌───────────────────────────────────────────┐
  Edge (verify_jwt) │  Supabase production project (Postgres 17) │
   26 Edge Functions│  Auth/GoTrue · PostgREST · Storage · RT · Realtime │
                    │  58 migrations · RLS · RPCs · pg_cron · pg_net · Vault │
                    └───────────────┬───────────────────────────┘
        machine endpoints (--no-verify-jwt / config.toml per-fn):
        run-cron-minute · run-cron-nightly · run-background-worker ·
        send-reminders · process-whatsapp-webhook · verify-payment
                                    │
   pg_cron(minute+nightly) → scheduler_fire → pg_net → run-cron-minute
                                                  → send-reminders
                                                  → run-background-worker (if ENABLE_WORKER_TRIGGER)
   External:  Razorpay ⇄ verify-payment (HMAC)   Meta ⇄ process-whatsapp-webhook (HMAC)
              SMTP ⇄ GoTrue (reset/invite)        Observability ⇄ logs/metrics transport
```

Region: `ap-south-1` (matches staging and the India-market posture: INR,
Razorpay, +91 E.164 normalization). Production MUST be created on Postgres 17
to match `config.toml.major_version` and the tested migration chain.

---

## 4. Production environment matrix

| Layer | Staging today | Production target | Gap class |
| --- | --- | --- | --- |
| Supabase project | `gzcqasntcbqqmgsoikms` (disposable) | separate production project (does NOT exist) | REQUIRES AUTHORIZATION |
| Data | disposable seed | real hospital/patient data | REQUIRES AUTHORIZATION + DATA POLICY (§15) |
| Frontend origin | `*.vercel.app` preview + `setura-delta` | `app.setura.in` (or chosen domain) | REQUIRES AUTHORIZATION (DNS) |
| `ALLOWED_ORIGINS` | 2 preview + localhost | production domain(s) | CONFIG (see §23 blocker) |
| Auth `site_url`/redirects | localhost | production origin | CONFIG |
| SMTP | none (inbucket) | real provider | REQUIRES AUTHORIZATION |
| Razorpay | none | live keys + webhook | REQUIRES AUTHORIZATION |
| Meta | none | live BCP + webhook + templates | REQUIRES AUTHORIZATION |
| Scheduler/Vault | provisioned (secrets died with session) | re-provisioned production secrets | REQUIRES AUTHORIZATION |
| Backup/PITR | none | per D5 tier | DECISION + CONFIG |

---

## 5. Supabase production architecture

| Element | State | Notes |
| --- | --- | --- |
| Project structure (single project, multi-tenant via `hospital_id`+RLS) | IMPLEMENTED | proven shape on staging |
| Region ap-south-1 | READY TO CONFIGURE (project creation) | matches staging |
| PostgreSQL 17 | IMPLEMENTED (chain targets 17) | production must pin 17 |
| Extensions pg_cron / pg_net / Vault | IMPLEMENTED in migrations (53 IF NOT EXISTS) · UNPROVEN hosted | D7: verify at provisioning; migration 53 premise `cron.database_name='postgres'` verified local only |
| Migrations 01–58 | IMPLEMENTED (files) · PROVEN (applied to staging) · NOT IMPLEMENTED (prod) | additive only; no applied migration edited |
| Migration immutability | IMPLEMENTED (baseline `MANIFEST.sha256`) · enforcement in CI NOT IMPLEMENTED | `validate:migration-manifest` runs in `quality` job locally; GitHub exec UNPROVEN |
| RLS | IMPLEMENTED · PROVEN (hosted staging: 94/94, 139 policies) · UNPROVEN (prod) | never weaken to deploy |
| Functions / triggers / indexes / enums | IMPLEMENTED · PROVEN (staging catalog) | 78 triggers, 339 indexes, 35 enums observed on staging |
| Storage | IMPLEMENTED (buckets in migrations) · not exercised with real assets | UNPROVEN in prod |
| Realtime | IMPLEMENTED (queue/subscription channels) · UNPROVEN prod | |
| pg_cron jobs (minute + nightly) | IMPLEMENTED · PROVEN (staging live firing) · NOT IMPLEMENTED prod | |
| Edge Functions (26) | IMPLEMENTED · PROVEN (deployed + executed on staging) · NOT IMPLEMENTED prod | verify_jwt config below |

**verify_jwt boundary (critical at deploy):** cloud default is
`verify_jwt = true`; `config.toml` declares no `[functions]` override, so the
six machine endpoints (pg_net/Kong/Meta/Razorpay callers) must each get
`verify_jwt = false` **via a version-controlled `[functions.<name>]` entry**,
not a blind flag flip. Their own secrets (`X-Cron-Secret`, `X-Worker-Secret`,
Meta HMAC, Razorpay HMAC) remain the real gate. The Kong-401-masking trap
means smoke assertions must check the function-level error body/SQLSTATE, not
just an HTTP status. The remaining 20 functions keep JWT verification.
`send-whatsapp-message` is worker-dispatched (not browser) — verify invokers
before changing its config. Status of this whole sub-item: **READY TO
CONFIGURE / requires per-function verification at deploy.**

Do NOT claim a hosted production Supabase exists. It does **NOT** exist.

---

## 6. Authentication architecture

Requirements for production (all CONFIG, none are code changes):

- Staff auth: email/password + `user_roles` + DB-side `resolveStaffContext`
  — IMPLEMENTED + PROVEN (hosted staging login 200 + JWT).
- Identity records: `auth.identities` must exist for every `auth.users` row
  — defect FOUND and FIXED at source in `seed.sql` (D3).
- Email confirmation policy & password reset: require real SMTP (§11) —
  password reset is **BLOCKED** until SMTP exists.
- Session policy / `jwt_expiry`: default 3600 s; hospital shift reality is a
  decision (D12) — UNPROVEN/undecided.
- Redirect URLs / site URL: `site_url` + `additional_redirect_urls` are
  localhost today; must equal final frontend origin — NOT IMPLEMENTED.
- Staff provisioning / tenant association / role assignment: only mechanism
  today is `seed.sql` (local-demo). A production onboarding path (admin RPC
  or dashboard runbook) is **NOT IMPLEMENTED** (gap G7-08).
- Deactivated staff / emergency admin access: role hierarchy exists
  (receptionist/doctor/hospital_admin/global_admin); an explicit break-glass
  admin runbook is **DEFERRED**.

**GoTrue seed defects — final classification (D3):** root cause was the seed
shape (missing `auth.identities`; GoTrue v2.197 scanning NULL `email_change*`
as non-nullable), **not** a GoTrue product bug. Fix applied at source and
committed (Class A). Because it is fixed in `seed.sql`, a fresh production DB
seeded the same way is protected. Residual risk: production should NOT use
`seed.sql` at all (§15) — so the defect is moot for real provisioning, but the
classification is recorded so it is not re-litigated. Status: **IMPLEMENTED
(source fix)**; production provisioning path **NOT IMPLEMENTED**.

---

## 7. Multi-tenant security architecture

Invariant: Hospital A MUST NEVER see or mutate Hospital B.

| Control | State | Evidence |
| --- | --- | --- |
| JWT claims → `hospital_id` server-resolved (never trust client hospital id) | IMPLEMENTED · PROVEN (staging) | `resolveAuth`/`requireRole` + `X-Hospital-ID` membership |
| RLS tenant isolation | IMPLEMENTED · PROVEN (staging A↔B zero leakage: UI + REST 0 foreign rows) | Part 2 §3,§6 |
| Cross-tenant mutation denial | IMPLEMENTED · PROVEN (403 `HOSPITAL_ACCESS_DENIED`) | Part 2 §3 |
| Edge Function authorization (app-level) | IMPLEMENTED · PROVEN (staging) | 403/UNAUTHORIZED responses |
| Doctor / receptionist / admin scope | IMPLEMENTED · doctor→other-doctor patient scope UNPROVEN in prod | Phase 5 S1 local |
| service-role boundary | IMPLEMENTED · PROVEN (staging catalog) | Gate 2 |
| Background worker / scheduler cross-tenant safety | IMPLEMENTED · PROVEN (staging firing) | migration 53 service_role-only fire fns |
| Webhooks / machine endpoints authenticity | IMPLEMENTED · real external delivery BLOCKED | §10,§12 |
| Privilege catalog on **production** DB | BLOCKED (no deployment) | Gate G / G7-04 |

**Remaining security evidence gaps (S1/F16) for production:**

- Production privilege catalog re-measure vs
  `RPC_PRIVILEGE_CLASSIFICATION.tsv` (G7-04) — **BLOCKED** (needs deployment).
- F16-05: `privilege_isolation.test.ts` can accept a JWT-layer 401 as
  privilege-denial proof — test-quality debt, **open**.
- F16-06: locked-routine denial coverage ~22% — **open** coverage gap.
- F16-04 discipline: honored in migrations 50–58 (explicit REVOKE per new
  SECURITY DEFINER function, e.g. migrations 57/58 restate the boundary);
  needs a mechanical CI lint to make it permanent — lint **NOT IMPLEMENTED**.
- 139 RLS policies is the verified live count (a stray "193" test comment,
  F16-07, still needs correcting — cosmetic, not fixed here).

---

## 8. Scheduler + worker architecture

Target production chain (identical to what is PROVEN on staging):

```
pg_cron (setura_cron_minute every min; nightly 0 3 * * *)
  → scheduler_fire_minute()/nightly  [fail-closed trio:
        scheduler_http_config.base_url  +  Vault setura_cron_secret
        + Vault setura_scheduler_api_key ]
  → pg_net HTTP → run-cron-minute Edge Function (X-Cron-Secret + apikey)
       → send-reminders
       → run-background-worker (only if ENABLE_WORKER_TRIGGER=true, WORKER_SECRET)
            → claim_jobs_v2 → lease/heartbeat → retry → dead_letter_jobs
```

| Element | State | Notes |
| --- | --- | --- |
| pg_cron + pg_net firing (SQL layer) | IMPLEMENTED · PROVEN (staging live; 316/0 local `cron.job_run_details`) | |
| Vault secrets + base URL | IMPLEMENTED (fail-closed) · provisioning NOT IMPLEMENTED in prod | staging secrets generated by RNG, never persisted, died with session |
| `CRON_SECRET` / `WORKER_SECRET` platform secrets | NOT IMPLEMENTED prod | must be created at provisioning (authorization) |
| Worker lifecycle claim/complete/retry/DLQ | IMPLEMENTED · PROVEN (staging live) | |
| Crash recovery / lease reclaim (`lease_expires_at`) | IMPLEMENTED (migration 51/52 fix) · PROVEN (local W1 4/4, 7/7) · hosted v2-lease NOT separately certified | P0-01 remediated in source |
| Stuck-job recovery, monitoring, alerting | IMPLEMENTED in DB (`monitoring-health-check`, `alert-center`, queue monitoring) · external alert routing NOT IMPLEMENTED | §13 |

**D6 — `ENABLE_WORKER_TRIGGER` (go-live-blocking):** shipped default is
`false`; a documented-default deploy yields a system that enqueues but never
processes jobs (the exact symptom AGENTS §13 recorded locally). Production
MUST either set it `true` **with** `WORKER_SECRET` discipline, or keep it
`false` **and** mandate an external trigger. This is a deliberate default
decision, not a cosmetic toggle. Status: **DEFERRED (owner decision).**

**D7 — hosted pg_cron/Vault behavior:** all firing evidence is local image +
staging. Whether the production project tier exposes pg_cron/Vault identically
is **UNPROVEN** — it is a provisioning-time probe, not a code decision. Do not
enable anything yet.

---

## 9. Financial architecture

Model (code-verified): SETURA collects only the booking/platform fee via
Razorpay orders. `create-payment-order` → Razorpay Orders API;
`verify-payment` HMAC-verifies callbacks against `RAZORPAY_KEY_SECRET`;
`process-refund` issues refunds; capture path fixed in migration 56; id capture
idempotent (`idempotent_capture_payment`, service_role-locked); ledger /
daily-collection / settlement / reconciliation via canonical RPCs only.

| Item | State |
| --- | --- |
| Order create / capture / verify / refund code | IMPLEMENTED · PROVEN (local contracts) |
| Idempotency / replay / duplicate-callback safety | IMPLEMENTED · PROVEN (local + staging replay) |
| Real Razorpay (test then live) | **BLOCKED** (no credentials) |
| Production webhook registration (`payment.captured`/`refund.processed`) | **NOT IMPLEMENTED** |
| `booking_fee_inr` runtime writer | IMPLEMENTED (migration 54 closes P0-04) · backfill repairs history |

**Unresolved P1-10 / NPD-02 (must NOT be silently resolved):**

- **P1-10 — refund/charge basis inconsistency.** Charges are computed from
  `total_amount_snapshot`; refunds (cancel-booking, WhatsApp cancel) are
  computed from `booking_fee_inr` (platform fee); `process-refund` refunds
  `total_amount_snapshot`. Migration 54's own header states it only makes
  `booking_fee_inr` reflect the platform fee — it does **not** reconcile the
  three bases. Partial refunds additionally **over-adjust settlement** and the
  divergent partial case is **untested** (`refund_sync.test.ts` covers full
  only). This is a **TECHNICAL-CORRECTNESS** defect whose *resolution* depends
  on the policy below.
- **NPD-02 — revenue recognition point.** Revenue is recognized at booking
  INSERT (trigger `13:479` via a DCE trigger with no `WHEN` clause), for every
  booking including unpaid/WhatsApp bookings that create no payment order.
  The ledger's meaning drifted from "money collected" to "booking created";
  settlements, reconciliation and every downstream KPI inherit it. The correct
  answer is a **BUSINESS ACCOUNTING POLICY ruling (owner, D16)**, not an
  engineering choice.

**Separation of concerns (explicit):**

- TECHNICAL CORRECTNESS: once the policy is fixed, the basis must be made
  consistent across all refund paths and settlement adjustments, and covered
  by tests — currently **NOT IMPLEMENTED** (blocked on the ruling).
- BUSINESS POLICY (D16): what "revenue" means, whether platform fee is
  recognized at booking or at capture, and GST treatment (NPD-01) — **DEFERRED
  / owner decision.** No code was changed to guess a policy.

---

## 10. WhatsApp / Meta architecture

| Element | State |
| --- | --- |
| HMAC-X-signature webhook verify (`META_APP_SECRET`), `META_WEBHOOK_VERIFY_TOKEN` handshake, unsigned rejection | IMPLEMENTED · fails closed without secrets |
| Inbound dedup / conversational engine / deterministic intent | IMPLEMENTED (migrations 04/42 + `_shared/whatsapp/*`) · unit-proven |
| Outbound enqueue → worker → dispatch | IMPLEMENTED · PROVEN up to provider call (staging: claim→retry→dead-letter) |
| E.164 normalization (`formatE164()`, no hardcoded country prefix) | IMPLEMENTED |
| Real Meta delivery / template approval / production callback / business assets | **BLOCKED** — no credentials, none fabricated |
| Tenant mapping, rate limits, delivery/read reconciliation | IMPLEMENTED (code) · UNPROVEN against real Meta |

Do not fabricate Meta evidence. Activation is a per-step owner-authorized
action (staging dev-number callback → template approval → pilot opt-in →
production callback).

---

## 11. SMTP / email architecture

Nothing is configured (staging uses no real SMTP; local uses inbucket).

Required before production email works: provider selection (D12), credentials,
verified sender, and domain authentication for the production domain
(**SPF · DKIM · DMARC**). Consumed by: password reset, staff invitations, and
any operational email notifications. Bounce handling and rate limits are
provider-side decisions. **No production SMTP setup was performed.** Status:
**NOT IMPLEMENTED** (all of it). Directly blocks §6 password-reset path.

---

## 12. Frontend / Vercel architecture

Verified production target: React/Vite → Vercel → Supabase.

- Project `setura` (`prj_PZq3TlY28vzz3hF6x0TKpvxK6gMH`) is the SAME project as
  the browser-proven deploy. Root Directory is already `apps/web` (the 404
  cause). `apps/web/vercel.json` pins framework vite, build/output `dist`, and
  the SPA catch-all rewrite. **DO NOT recreate the project. DO NOT change the
  Root Directory again. DO NOT re-investigate the 404** — it is PROVEN fixed on
  `https://setura-delta.vercel.app`.
- Production-target env vars exist and are browser-safe only:
  `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. Never add any secret.
- Remaining production frontend decisions/config (no repo change): final custom
  domain + HTTPS (D13), branch deployment model, deployment protection policy,
  **`build.sourcemap: false` for production** (thin-client error handling
  assumes no backend detail leaks — public maps partially undo it),
  `index.html` `no-cache` (so rollback reaches users), hashed-asset caching,
  rollback to previous immutable build.
- Preview-vs-production variable scoping and the CORS/`ALLOWED_ORIGINS`
  coupling (§23 blocker) are the two live open items.

Status: staging/preview **PROVEN**; production domain/sourcemap/cache config
**NOT IMPLEMENTED** (config only, authorization-gated).

---

## 13. Observability architecture

| Layer | State |
| --- | --- |
| Structured JSON logging with request context, metrics, tracing, request IDs | IMPLEMENTED (in-code) |
| `DEPLOYMENT_VERSION` propagation into every log line | IMPLEMENTED (plumbed) — depends on being set per deploy |
| DB-side monitoring tables/RPCs, queue monitoring, `monitoring-health-check`, `alert-center`, DLQ visibility | IMPLEMENTED |
| **External** error tracking / APM / uptime / paging / dashboards | **NOT IMPLEMENTED** |
| `SENTRY_DSN` | **DECLARED ONLY** — present in `env.ts` but referenced nowhere else in `supabase/functions/`; it is a dead placeholder |

Classification requested by the brief: `SENTRY_DSN` = **DECLARED ONLY**;
external observability = **NOT IMPLEMENTED**. Per-function, DB, scheduler,
worker, queue-depth, DLQ, payment-failure and webhook-failure **external**
monitoring must be designed and a provider chosen (D17) before real-patient
go-live. No provider was added (not authorized).

---

## 14. Backup / disaster recovery architecture

Nothing in the repository defines database backups, PITR, restore testing, or
a DR procedure. The internal retention/cleanup engine (migration 23) is data
**pruning**, not backup — it has no counterpart backup obligation.

Must be defined (D5, owner + Supabase tier):

- **RPO / RTO** targets; PITR availability (tier-dependent; a Supabase restore
  can silently drop `cron.job` registrations and Vault rows — must be
  re-verified after any restore).
- Retention reconciled with migration 23 pruning AND immutable-ledger
  preservation (a restore must never resurrect or delete audited financial
  history inconsistently).
- Recovery procedure: DB (forward-fix migration preferred; PITR as emergency
  path — NEVER edit/delete an applied migration); Edge Function redeploy from
  previous tag; frontend re-point to previous immutable build; config rollback
  via migration 18 (hospital config) + secret-name manifest + `config.toml`
  in Git; secret rotation runbook; webhook recovery via existing idempotency.
- Incident response runbook.

Status: **NOT IMPLEMENTED**; policy **DEFERRED (D5)**. Do not claim any
backup/DR capability. This becomes **P0-blocking before real patient data.**

---

## 15. Production data policy

- **Pilot data ≠ real production patient data.** This and every prior phase
  used disposable, clearly-labeled data. No real hospital or patient data may
  enter any environment authorized by this package.
- Allowed into production only after owner authorization: real staff accounts,
  real hospital config, then real patient/medical records, diagnoses, clinical
  notes, phone numbers, and financial/audit records.
- Retention / deletion / archival governed by migration 23 + a policy to be
  written (D15); **immutable financial ledger** rows are never hand-edited or
  purged — corrections go through canonical refund/settlement RPCs.
- Tenant offboarding / decommissioning runbook: **NOT IMPLEMENTED** (G7-08
  adjacent). `seed.sql` is local-demo only and MUST NOT be used to provision a
  real production tenant.
- Medical-data compliance obligations (a jurisdiction/DPDP-type determination)
  are an owner/legal input, not an engineering assumption made here.

---

## 16. Production secrets matrix

**No secret values are printed anywhere.** Names and posture only.

| Secret / var | Purpose | Env | Owner | Storage | Rotation | Browser-visible? | Required before prod? | Current status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `SUPABASE_ANON_KEY` / publishable key | client + Vault apikey | all | owner | Supabase platform / Vite | revocation dashboard | YES (public by design under RLS) | YES | IMPLEMENTED (pattern) · prod value NOT IMPLEMENTED |
| `SUPABASE_SERVICE_ROLE_KEY` | `getServiceClient` server ops | Edge only | owner | Supabase platform secrets | manual rotate | **NEVER** | YES | NOT IMPLEMENTED (prod) |
| `CRON_SECRET` / Vault `setura_cron_secret` | scheduler→function auth | Edge + Vault | owner | platform secret + Vault (paired) | update both, then `scheduler_fire_minute()` proves pair | NEVER | YES | NOT IMPLEMENTED (prod) |
| `WORKER_SECRET` | worker ⇄ dispatch auth | Edge | owner | platform secret | manual | NEVER | if D6=true | NOT IMPLEMENTED (prod) |
| Vault `setura_scheduler_api_key` | pg_net HTTP caller | DB | owner | Vault | with publishable key | NEVER | YES | NOT IMPLEMENTED (prod) |
| `RAZORPAY_KEY_ID` | order create | Edge | owner | platform secret | dashboard | key id MAY be client | for payments | BLOCKED (no creds) |
| `RAZORPAY_KEY_SECRET` | webhook HMAC verify + refunds | Edge | owner | platform secret | dashboard | NEVER | for payments | BLOCKED |
| `META_ACCESS_TOKEN` | outbound send | Edge | owner | platform secret | Meta dashboard | NEVER | for WhatsApp | BLOCKED |
| `META_APP_SECRET` | webhook HMAC verify | Edge | owner | platform secret | Meta dashboard | NEVER | for WhatsApp | BLOCKED |
| `META_WEBHOOK_VERIFY_TOKEN` | webhook handshake | Edge | owner | platform secret | manual | NEVER | for WhatsApp | BLOCKED |
| SMTP credentials | auth/reset/invite email | Auth/GoTrue | owner | Supabase Auth SMTP | provider | NEVER | for email | BLOCKED |
| Observability DSN (e.g. `SENTRY_DSN`) | error transport | Edge | owner (D17) | platform secret | provider | NEVER | ops (D17) | DECLARED ONLY / NOT IMPLEMENTED |
| `ALLOWED_ORIGINS` | CORS allow-list | Edge | owner | platform secret | config | n/a | YES (must match real domain) | IMPLEMENTED (example) — see §23 blocker |
| `APP_ENV` | env typing | Edge | owner | platform secret | n/a | n/a | YES | default `production` — must be explicit |

**Rules:** no secret in Git, CI logs, Vite/browser bundle, migration text, or
reports. Only `VITE_*` public values and the anon/publishable key and
`RAZORPAY_KEY_ID` may ever reach the client.

---

## 17. CI/CD and release architecture

Already implemented in-repo (DO NOT rebuild): `ci.yml` has 4 jobs —
`quality` (fmt/lint/check, `validate:migrations`, migration-manifest
append-only check, unit tests, privilege-guard naming), `frontend`
(npm ci/typecheck/build/vitest + built-bundle secret & sourcemap scan),
`stack` (`supabase start` + full integration), `release-validation`
(on push:main: consolidated regression + provenance manifest,
`deployment: NOT PERFORMED`).

| Concern | In repository | Needs GitHub admin (authorization) |
| --- | --- | --- |
| Branch protection on `main` | n/a | REQUIRES CONFIG |
| Required status checks | n/a | REQUIRES CONFIG |
| CODEOWNERS | **absent** | NOT IMPLEMENTED |
| Environments (staging/production) + required approvers | n/a | REQUIRES CONFIG |
| Staging approval gate | n/a | REQUIRES CONFIG |
| Production approval gate (turns "user authorization" into a technical control) | n/a | REQUIRES CONFIG |
| Migration-manifest enforcement | IMPLEMENTED (script + wired in `quality`) | GitHub run status UNPROVEN |
| F16-04 privilege lint | named guard, mechanical lint partial | NOT IMPLEMENTED (full) |
| Release provenance manifest | IMPLEMENTED (`release_manifest.ts`) | |
| Signed tags | n/a (convention designed) | NOT IMPLEMENTED |
| Deploy permissions / actual deploy job | **absent** (CI stops at tests/validation) | REQUIRES BUILD + CONFIG |
| Rollback job | absent | NOT IMPLEMENTED |

GitHub Actions **execution** on the pushed repo is **UNPROVEN** from this tree
(external system). The deploy stage (auto-staging, gated-production) is
**NOT IMPLEMENTED** — this is the primary CI/CD gap between here and a
repeatable pipeline. No GitHub settings were modified.

---

## 18. Production deployment sequence (dependency-corrected)

Ordering is derived from the architecture, correcting the brief's sketch. Two
hard dependencies: (a) Auth `site_url`/redirects must exist **before** the
frontend so callback validation passes; (b) Vault + `scheduler_http_config`
must exist **before** the scheduler can do anything, and the worker-trigger
decision is made **with** scheduler activation.

| # | Phase | Prereq | Action | Owner | Evidence | Rollback | Blocking condition | Authorization |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | Infra prep | D5,D7,D13 decisions | choose tier/domain | owner | config record | n/a | decisions open | YES |
| P2 | Provision production Supabase (PG17) | P1 | create project | owner | project ref live | delete unused project | needs owner | YES |
| P3 | Extensions availability probe (pg_cron/pg_net/Vault) | P2 | probe D7 | ops | catalog shows exts | n/a | D7 unproven | YES |
| P4 | Migrations `db push` (01–58) | P3 | apply chain | ops | `validate:migrations` 0 err + manifest + registry + self-check NOTICEs | forward-fix migration (NEVER edit applied) | — | YES |
| P5 | **Security/RLS privilege census** (Gate G) | P4 | re-measure prod catalog vs TSV | sec | catalog matches locked posture | n/a | must run **before any traffic** | YES |
| P6 | Platform secrets (+`APP_ENV=production`, `ALLOWED_ORIGINS`=domain) | P5 | set secret NAMES matrix §16 | owner | names present (values never echoed) | rotate | needs owner | YES |
| P7 | Vault rows + `scheduler_http_config` | P6 | provision scheduler creds | ops | fail-closed→ready | remove rows | needs owner | YES |
| P8 | Edge Function deploy (per-fn verify_jwt committed first) | P6 | `functions deploy` | ops | cold-start smoke | redeploy prev tag | needs owner | YES |
| P9 | Function smoke S1–S4 (auth/machine/privilege/manifest) | P8 | run battery | QA | body-level assertions | n/a | — | YES (read-only) |
| P10 | Auth config (`site_url`/redirects/`jwt_expiry`/SMTP) | P6,P9 | configure | owner | reset round-trip | revert config | SMTP=§11 blocked | YES |
| P11 | Scheduler activation + 2-tick autonomy observation | P7,P8 | enable cron | ops | 2 consecutive green ticks | disable job | D7 | YES |
| P12 | Worker enablement per D6 | P11 | set trigger+secret | owner | pending→completed movement | set false | D6 undecided | YES |
| P13 | Frontend build (tagged) + Vercel production to domain | P10 | deploy | ops | SPA served + prod env | re-point prev build | D13 domain | YES |
| P14 | Authenticated E1 on production (S5–S6) | P13 | run journey | QA | E1 pass on prod domain | frontend rollback | needs owner | YES (read-only) |
| P15 | External integrations (Razorpay then Meta then SMTP live) | P10-P12 | activate per §13-staged | owner | real round-trip | re-point webhook to staging | credentials | YES per integration |
| P16 | Staff/tenant provisioning (runbook, no seed.sql) | P14 | onboard pilot staff | owner | accounts+roles | deactivate | G7-08 runbook | YES |
| P17 | Production smoke suite (full §19) | P14-P16 | run | QA | all S1–S15 | per-area rollback | — | YES (read-only) |
| P18 | Pilot hospital (real data) | P17 + D14 | onboard pilot | owner | pilot acceptance | offboarding runbook | DATA POLICY + backup/DR (§14) | YES |
| P19 | Go-live | P18 | open to production traffic | owner | gates all PROVEN | rollback playbook | explicit final authorization | YES |
| P20 | Release record commit (tag+SHA+manifest+build hash) | P19 | provenance | ops | release entry | n/a | — | YES |

**Nothing in this sequence is executed by this package.**

---

## 19. Production smoke suite (design)

Minimal-but-serious battery; **no real financial transaction or real WhatsApp
message unless explicitly authorized** (use provider test-mode / disposable
data until then).

| # | Test | Expected | Failure result | Evidence required | Rollback implication |
| --- | --- | --- | --- | --- | --- |
| S1 | Authentication | staff login 200 + JWT; role resolves | no access | live 200 + role from DB | revert auth config |
| S2 | Tenant isolation | B reads A → 0 foreign rows | leak | RLS query result empty for A | halt traffic, re-check RLS |
| S3 | Patient registration | creates scoped patient | dup/fail | row + audit event | forward-fix |
| S4 | Appointment booking | 201 + token + reference | fail | token + booking row | n/a |
| S5 | Walk-in | token issued, queue session | unqueued silently (secondary UI finding) | token #, queue position | n/a |
| S6 | Token/queue | next-patient ordering correct | out-of-order | queue board state | n/a |
| S7 | Doctor consultation | call→start→note→complete | stuck state | timestamps + status `completed` | n/a |
| S8 | Booking fee/payment | order+capture idempotent **test-mode** | double-charge | ledger entry once only | re-point Razorpay webhook to staging |
| S9 | Notification | enqueue → (test) dispatch | silent drop | notification queue row | n/a |
| S10 | Background worker | claim→complete; DLQ empty under load | stranded jobs | worker registry + heartbeat | disable trigger |
| S11 | Scheduler | 2 consecutive ticks 200 | fail-closed no-op | `cron.job_run_details` | disable cron job |
| S12 | Audit | mutation writes immutable audit | missing event | audit row old/new state | n/a |
| S13 | Financial ledger | capture writes ledger once | drift | ledger + reconciliation | forward-fix |
| S14 | Failure/idempotency | replay same key → same effect, 1 row | duplicate | replay response + row count | n/a |
| S15 | Cross-tenant attack | 403 `HOSPITAL_ACCESS_DENIED` | success = CRITICAL | specific SQLSTATE/error body, not just 401 | halt, security review |

S15 assertion must check the SQLSTATE (e.g. 42501) / application error body,
not a bare HTTP 401, per the Kong-401-masking caveat (F16-05 lesson).

---

## 20. Rollback architecture (independent per layer)

| Layer | Mechanism | Caveat |
| --- | --- | --- |
| Database | **Forward-fix migration only** (additive corrective migration); PITR as emergency path | NEVER edit/delete an applied migration; partitioning (15/22) + retention (23) make naive `down` unsafe; a restore can drop cron/Vault registrations — re-verify |
| Migration | corrective additive migration; manifest catches drift | pre-2026-09-03 history unprovable |
| Edge Functions | redeploy previous tag (deterministic via `deno.lock`) | functions stateless; in-flight drain naturally |
| Frontend | re-point to previous immutable build | `index.html` no-cache makes it user-visible |
| Scheduler | disable pg_cron job / unset trigger | stop firing, no data loss |
| Secrets | rotate to prior/known-good value pair | Vault+platform must rotate together |
| Razorpay | re-point webhook to staging (pauses live side effects) | replay after re-point dedups via idempotency |
| Meta | re-point callback to staging | outbound queue keeps retrying safely |
| SMTP | provider switch / disable sends | |
| DNS | TTL-low pre-change so re-point is fast (owner) | no DNS change authorized here |
| Staff access | deactivate accounts via role/session controls | audit immutability preserved |
| Pilot hospital | tenant offboarding runbook (**NOT IMPLEMENTED**) | must exist before pilot |

Every rollback is itself an audited event + release-record entry.

---

## 21. Go-live gates

| Gate | Definition | Current state |
| --- | --- | --- |
| P0 | Production infrastructure exists (project+domain+tier) | **NOT IMPLEMENTED** |
| P1 | Database deployed (58 migrations applied to prod) | **NOT IMPLEMENTED** |
| P2 | RLS/privilege proven on prod catalog (Gate G) | **BLOCKED** (no deployment) |
| P3 | Auth proven (login + reset via real SMTP) | **BLOCKED** (SMTP) |
| P4 | Worker proven on prod (incl. crash reclaim) | **UNPROVEN** (local/staging only) |
| P5 | Scheduler proven on prod (2-tick autonomy) | **UNPROVEN** (staging only) |
| P6 | Financial path proven (Razorpay live, basis fixed) | **BLOCKED** + P1-10 policy open |
| P7 | External integrations proven (Meta/Razorpay/SMTP) | **BLOCKED** (credentials) |
| P8 | Frontend proven on prod domain | **NOT IMPLEMENTED** |
| P9 | Observability proven (external error tracking/alerting) | **NOT IMPLEMENTED** |
| P10 | Backup/DR proven (first restore test) | **NOT IMPLEMENTED** (D5) |
| P11 | Production smoke suite (S1–S15) proven | **NOT IMPLEMENTED** |
| P12 | Pilot authorization | **DEFERRED** (owner) |
| P13 | Go-live authorization | **DEFERRED** (owner) |

No gate is marked PASS/PROVEN on the production dimension by this document.
Staging PROVEN status is deliberately **not** promoted into any production
gate.

---

## 22. Owner decision register

Objective/architectural items were **determined here** (region=ap-south-1,
Postgres 17, verify_jwt per-function list, SPA config, forward-fix rollback
model, dependency-corrected sequence §18). The following genuinely require an
owner ruling and remain open:

| ID | Decision | Determined vs needed | Status |
| --- | --- | --- | --- |
| D1 | Doctor assignment mandatory on booking? | product ruling | DEFERRED |
| D2 | Receptionist visibility of doctor names? | privacy/RLS ruling | DEFERRED |
| D3 | GoTrue seed defect classification | **determined** (seed-shape, fixed in source §6) | RESOLVED (recorded) |
| D4 | Notification staff-UI placement | product placement | DEFERRED |
| D5 | Backup/PITR/retention tier | platform+product | DEFERRED |
| D6 | `ENABLE_WORKER_TRIGGER` prod default (true+secret vs false+external) | go-live-blocking ruling | DEFERRED |
| D7 | Hosted pg_cron/Vault behavior | provisioning **probe** | UNPROVEN |
| D8 | Track `graphify-out/`? | hygiene ruling (currently tracked) | DEFERRED |
| D9 | Production deployment architecture / CI deploy stage | approve build+GitHub config | DEFERRED |
| D10 | Razorpay production activation | authorize credentials+webhook | BLOCKED |
| D11 | Meta/WhatsApp production activation | authorize business assets | BLOCKED |
| D12 | SMTP provider (+ `jwt_expiry`/session policy) | provider + policy | DEFERRED |
| D13 | Production domain + DNS | authorize domain | DEFERRED |
| D14 | Pilot hospital selection | business | DEFERRED |
| D15 | Data retention / offboarding policy | legal/product | DEFERRED |
| D16 | Revenue recognition / fee-snapshot basis (P1-10 + NPD-02) | accounting policy | DEFERRED |
| D17 | Observability provider (replaces dead `SENTRY_DSN`) | provider | DEFERRED |

Historical note: earlier Phase-7 documents used a **different** D-numbering
(G7-02 §19). This register follows the **Part 3 brief's** D1–D17 numbering; the
content of D5/D6/D7/D8 matches the earlier gate with the same number.

---

## 23. Blocking issues

1. **§1 staging CORS gap (owner decision):** staging `ALLOWED_ORIGINS` does
   not include `https://setura-delta.vercel.app`, so `queue-control` from that
   origin is CORS-blocked. Remedy is a one-line owner-approved secrets update;
   **NOT applied** because this package forbids modifying Supabase secrets.
   Status: **BLOCKED / OWNER DECISION REQUIRED.**
2. **No production environment exists** — every production gate (§21) is
   consequently NOT IMPLEMENTED / BLOCKED / UNPROVEN.
3. **No real credentials** — Razorpay / Meta / SMTP all **BLOCKED** by design
   (none fabricated).
4. **Policy gates block safe execution:** D16 (P1-10/NPD-02 revenue + refund
   basis) and D5 (backup/DR) and D6 (worker trigger) are prerequisites for a
   *correct* go-live, not just a *possible* one.
5. **Unproven hosting behavior:** D7 (pg_cron/Vault on production tier) can
   only be resolved by a provisioning probe.
6. **Git history scrub of `d9d7b2f`** (a previously-pushed staging secret)
   remains **DEFERRED** (destructive force-push, owner decision; staging-only
   credential, repo private, project disposable).

---

## 24. Deferred items

- D1, D2, D4, D5, D6, D8, D9, D12, D13, D14, D15, D16, D17 (§22).
- Production CI/CD deploy stage + GitHub environments/branch protection/
  CODEOWNERS (needs build + admin authorization).
- F16-05 / F16-06 privilege-test debts; F16-04 full mechanical lint; F16-07
  stray "193 policies" test comment (cosmetic).
- Tenant/staff provisioning runbook (G7-08); production privilege census
  (G7-04); external observability (G7-10); backup/DR (G7-11); production
  auth config (G7-12); load headroom test (G7-14); notifications UI (G7-15).
- Secondary UI findings from Part 2 (doctor dropdown label; brief "No doctors
  available" window) — product decisions, not fixed here.

---

## 25. Exact authorization points

Each of the following is a **stop-and-get-explicit-authorization** action that
this package does **not** perform:

1. Any `git push` beyond current state; history rewrite; force-push (secret
   scrub); repo transfer/org move; branch-protection activation.
2. Creating / linking a production Supabase project.
3. `supabase db push`, `functions deploy`, `secrets set` against production.
4. Vault row creation + `scheduler_http_config` value in production.
5. Setting `ENABLE_WORKER_TRIGGER=true` and its `WORKER_SECRET`.
6. Razorpay / Meta / SMTP account creation, live keys, webhook registration.
7. Any real payment or real WhatsApp message (even test-mode).
8. Frontend hosting production config, custom domain, DNS, TLS.
9. Provisioning real production staff/tenants; onboarding a pilot hospital.
10. Loading any real patient or hospital data.
11. Every D1–D17 ruling (silence is not authorization).
12. Modifying staging `ALLOWED_ORIGINS` to unblock §23 item 1.

---

## 26. Recommended execution order

1. Resolve owner decisions that gate correctness: **D16** (revenue/refund
   basis) and **D5** (backup/DR tier) and **D6** (worker default) and **D13**
   (domain) — decisions, not deployments.
2. Fix technical consequences of D16: make refund/settlement basis consistent
   across all three paths + cover the partial case (P1-10) as additive work.
3. Close §1 CORS blocker (one authorized secrets update).
4. Build production CI/CD deploy stage + GitHub environments/branch protection
   (I-2 exists; needs deploy jobs + admin config) → prove GitHub Actions runs.
5. Provision production Supabase (P2–P3, probe D7).
6. Execute §18 sequence with per-step authorization stops.
7. Run §19 smoke suite (read-only/authorized actions only).
8. External integrations staging→live, each independently authorized.
9. Pilot hospital only after backup/DR first-restore test + observability +
   tenant-provisioning runbook exist. Then go-live.

---

## 27. Final production readiness status

```text
PRODUCTION GO-LIVE READINESS (Part 3)

Architecture          : UNDERSTOOD (designable from current source)
Plan                  : COMPLETE (this document)
Production            : NOT STARTED  (nothing deployed/created)
Real credentials      : NOT CREATED
Real patient data     : NOT LOADED
Production readiness  : NOT CLAIMED

LOCAL ≠ STAGING ≠ PRODUCTION   (all three distinct here)
CONFIGURED ≠ DEPLOYED ≠ VERIFIED ≠ BUSINESS-READY
```

**Authorization required before ANY production execution.**

---

## 28. Final status matrix (per §15 output rule)

| Area | Status | Evidence | Next Action | Authorization |
| --- | --- | --- | --- | --- |
| Git transport / repo hygiene | PROVEN | `56065ed`=main=origin; 399 files; root `.gitignore` | none | no |
| Migration chain (58) + manifest | IMPLEMENTED | files + `MANIFEST.sha256` (58); staging-applied | apply to prod | YES |
| RLS / tenant isolation | PROVEN (staging) | A↔B zero leakage; 94/94, 139 policies | prod catalog census (Gate G) | YES |
| Edge Functions (26) | IMPLEMENTED + PROVEN (staging) | deployed+executed staging | prod deploy + verify_jwt config | YES |
| Auth (login/roles/JWT) | IMPLEMENTED + PROVEN (staging) | hosted 200+JWT | prod site_url/redirects/jwt_expiry | YES |
| SMTP / password reset | NOT IMPLEMENTED | no provider anywhere | choose provider (D12)+DKIM/SPF/DMARC | YES |
| Scheduler (pg_cron/pg_net/Vault) | PROVEN (staging) | live minute+nightly firing | provision prod Vault+base URL; probe D7 | YES |
| Worker (claim/retry/DLQ) | PROVEN (staging)+local crash reclaim | W1 4/4, 7/7; live DLQ | decide+set D6; prod execution proof | YES |
| Financial engine (code/contracts) | IMPLEMENTED + PROVEN (local) | Phase 3 + suites | fix P1-10 basis post-D16 | YES |
| Revenue recognition policy (NPD-02) | DEFERRED | `13:479` at INSERT, no `WHEN` | owner ruling D16 | YES |
| Razorpay (real) | BLOCKED | no credentials | staging→live test-mode then live | YES |
| Meta / WhatsApp (real) | BLOCKED | pipeline proven to provider call only | business assets + callback + templates | YES |
| Frontend / Vercel | PROVEN (staging) | 404 fixed on `setura-delta`; E1 6/6 | prod domain+sourcemap+cache config | YES |
| §1 staging CORS origin gap | BLOCKED | `queue-control` CORS-blocked on prod alias | add origin to `ALLOWED_ORIGINS` | YES |
| Observability (in-code) | IMPLEMENTED | logger/metrics/tracing/monitoring tables | — | no |
| External monitoring / Sentry | NOT IMPLEMENTED | `SENTRY_DSN` declared, unused | choose provider (D17) | YES |
| Backup / PITR / DR | NOT IMPLEMENTED | repo-wide absence | decide D5 + first restore test | YES |
| CI/CD deploy stage | NOT IMPLEMENTED | 4 test/validate jobs only | build deploy jobs + GitHub env config | YES |
| Branch protection / CODEOWNERS | NOT IMPLEMENTED | no CODEOWNERS; external settings | configure (admin) | YES |
| Tenant/staff provisioning path | NOT IMPLEMENTED | `seed.sql` local-demo only | build prod runbook (G7-08) | YES |
| Go-live gates P0–P13 | UNPROVEN | none passable without prod env | execute §18 with stops | YES |
| Overall production readiness | NOT IMPLEMENTED | this plan is design only | await explicit authorization | YES |
