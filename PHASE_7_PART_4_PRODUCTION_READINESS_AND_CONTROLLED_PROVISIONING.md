# PHASE 7 — PART 4: PRODUCTION READINESS + CONTROLLED PROVISIONING

Scope authority: the PART 4 specification (transition from PRE-PRODUCTION
ENGINEERING to CONTROLLED PRODUCTION PROVISIONING, under a hard safety boundary:
**no production mutation without explicit owner authorization**, and D13 domain
selection as a precondition). Certification vocabulary is the Part 3 set —
**PROVEN · IMPLEMENTED · BLOCKED · DEFERRED · NOT IMPLEMENTED · UNPROVEN** —
and LOCAL ≠ STAGING ≠ PRODUCTION, IMPLEMENTED ≠ PROVEN throughout.

**Headline result:** PART 4 was executed strictly on the *read-only / static*
side of the §2 safety boundary. Every §6–§25 provisioning action is a production
mutation gated behind owner decisions that are **not yet made** (D13 domain,
D5 plan authorization, project-creation authorization). No production project,
secret, migration, Edge deploy, domain, DNS, Auth, webhook, staff account, or
payment was created or touched. The provisioning plan is finalized and the
static preconditions that *can* be proven locally are proven; the live gates
remain BLOCKED/UNPROVEN pending owner sign-off (§27, §29).

---

## 1. Executive Summary

Verified against the actual repository, Git state, Supabase CLI/project state,
Vercel config, migrations, Edge Functions, and env surface (not stale reports):

- The Part 3C baseline holds and was re-confirmed read-only:
  `validate:migrations` → **0 errors / 4 known `[duplicate-objects]` warnings**
  (documented baseline, not new); `validate:migration-manifest` → **60
  migrations / 60 manifest lines / 0 integrity issues**.
- The tree **is** a Git repository (HEAD `0bb2d90` on `main`, clean except this
  report; remote `origin/main` present). AGENTS §13's "not a git repository"
  claim is STALE (already corrected in Part 3B §3; re-confirmed here).
- The linked Supabase project is **`setura-staging` (`gzcqasntcbqqmgsoikms`,
  South Asia / Mumbai)**. `supabase projects list` shows NO production Setura
  project — the only sibling is an unrelated `PrepOS` project. **Production
  project does not exist** (§6 precondition unmet).
- **D13 (production domain) is NOT SELECTED.** The strings `setura.in` /
  `app.setura.in` remain placeholders (`.env.example`, and the `env.ts`
  production *fallback* — see §5 risk note). Per §3, `D13 = BLOCKED` and all
  domain-dependent configuration stops here.
- **D5 (backup/PITR) plan capability is now concretely known** (§4): Supabase
  PITR is a **paid add-on at $100 / month per 7-day retention window**, on top
  of Pro (daily backups 7 days) / Team (14 days) / Enterprise (>28-day
  available). The required **≥30-day retention** therefore needs Enterprise-tier
  or a multi-increment PITR decision — this is an owner purchase decision, not
  an engineering task, and RPO/RTO remain **UNPROVEN** (no live PITR target).
- Frontend bundle hygiene scanner (`check:frontend-secrets`) reports **0 secret
  hits, 0 source maps** on the current `dist`, but that `dist` is a **local**
  build (contains `localhost`) — it is NOT a production bundle, so the §14
  production-bundle proof is **UNPROVEN** until a real production build is
  produced against D13/D-final env (§14).

Production readiness is **NOT claimed**. See §27 gate matrix and §29 blockers.

## 2. Part 3C Baseline

`PHASE_7_PART_3C_…` established (and this phase re-verified where read-only):
F3B-01 fixed and deployed to staging v9; P0-01 lease persistence PROVEN
(migration 51 + runtime); D6 scheduler tick / transport / fail-closed / v2 crash
recovery PROVEN, with the **authenticated worker-wake execution BLOCKED** (needs
Edge-runtime `CRON_SECRET`/`ENABLE_WORKER_TRIGGER`/`WORKER_SECRET`, which can
only be injected via `supabase secrets set` against the **linked staging**
project — out of scope to mutate); D5 logical restore drill EXECUTED (DB restore
≈5.35 s; app layer faithful; **pg_cron + Vault + Edge config do NOT survive a
logical DB restore**) with **RPO/RTO UNPROVEN** (no PITR). Full regression green
(unit 91/91, integration 226/226, frontend 17/17, E2E PASS). Part 4 does not
re-run that regression; it consumes it as the known-good local/staging baseline
for the production comparison the owner must eventually authorize (§8).

## 3. Owner Decisions

| ID | Decision | State entering Part 4 | What Part 4 needs from owner |
| --- | --- | --- | --- |
| D13 | Production domain | **NOT SELECTED → BLOCKED** | Choose the exact production origin(s). No domain-coupled config (§12/§15/§16/§20) proceeds without it. |
| D5 | Backup/PITR policy | Plan target RPO ≤15m / RTO ≤4h / ≥30d retention; capability **NOT PROVISIONED** | Authorize a plan tier whose PITR window meets ≥30-day retention (see §4) and fund the restore drill on a real target. |
| D6 | Worker autonomy | Architecture IMPLEMENTED + layers below wake PROVEN; authenticated wake **BLOCKED** (staging-secret mutation unsafe) | Authorize Edge-secret provisioning on a target environment (ideally the production project, §17). |
| §6 | Production project creation | Project **does not exist** | Explicit authorization to create ONE dedicated production Supabase project. |
| §13 | Staff provisioning | No real staff | Authorization to create test/pilot users only. |

Per §2 and §3, none of these are assumed granted by the arrival of PART 4.

## 4. Production Environment

Target environment shape (not yet created):

```text
Supabase production project (region TBD; separate from staging gzcqasntcbqqmgsoikms)
  + Vercel production deployment (domain per D13)
  + fully separate secret set (STAGING ⊥ PRODUCTION, §11)
```

`supabase projects list` (runtime, this phase) proves no such project exists.
Creating it is a §6 production mutation requiring explicit authorization; it was
NOT performed. Region, compute tier, and Postgres version are owner/plan choices
to record at creation (§6 template below), never to be invented here.

## 5. Domain (D13)

**D13 = BLOCKED.** No final domain is provided. `setura.in` / `app.setura.in`
appear only as `.env.example` placeholders and the `env.ts` production fallback:

```
supabase/functions/_shared/env.ts:213-215
  ALLOWED_ORIGINS default (IS_PRODUCTION) =
    "https://setura.in,https://app.setura.in"
```

**Risk note (recorded, not silently "fixed"):** if a production project is
deployed WITHOUT setting `ALLOWED_ORIGINS`, CORS would silently fall back to
these placeholder domains rather than fail closed. The D13 hard-stop and the
§11 secret-configuration step MUST set `ALLOWED_ORIGINS` explicitly; the
never-use-`*` rule (§15) applies. Changing the `env.ts` fallback to fail-closed
is a small code change that should be a separately-authorized, tested follow-up
(not performed casually in this provisioning-planning phase). All
domain-dependent steps below stop here.

## 6. Supabase (Production Project)

Precondition chain (all currently unmet): D13 selected → D5 plan chosen → owner
explicitly authorizes creation. Only then create ONE dedicated production
project; do NOT reuse/convert staging, delete staging, or create duplicates.
Record at creation (values TBD, secrets by name only):

```text
project reference : <to record, not expose secrets>
region            : <owner choice>
database version  : <record from provisioned project>
plan              : <must satisfy D5 §4>
project status    : AVAILABLE
```

**Status: NOT IMPLEMENTED (authorization required).**

## 7. Database (Baseline)

To verify on the production project BEFORE migrations: Postgres version,
required extensions present (`pg_cron`, `pg_net`, plus those migrations 01–60
create), database settings, timezone, RLS capability, and Supabase services.
None verifiable now (no production DB). The local stack confirms the *design*
dependencies exist (Part 3C: `pg_cron` 1.6.4 + `pg_net` 0.20.0 installed), but
LOCAL ≠ PRODUCTION (§27). **Status: UNPROVEN (no target).**

## 8. Migrations

Static preconditions proven this phase:

- `deno task validate:migrations` → 60 files, **0 errors**, 4 known
  `[duplicate-objects]` warnings (baseline: `20`/`11`, `22`/`15` ×2, `47`/`24`).
- `deno task validate:migration-manifest` → **60/60, 0 integrity issues**.

Applied migrations are immutable (AGENTS §11); no production application was
performed. When authorized, apply `01 … 60` in order, then verify the §8 census
(schema_migrations, migration_registry, MANIFEST.sha256) and the object census
(tables / functions / triggers / indexes / enums / RLS / policies / SECURITY
DEFINER ACL) against the known-good staging/local baseline from Part 3C
(103 tables, 481 functions, 139 RLS policies, 81 triggers, 35 enums, 60
schema_migrations rows). **Status: preflight PROVEN; production application NOT
IMPLEMENTED.**

## 9. RLS

Tenant-isolation production proof (§9) cannot run without a production DB and
authorized test tenants. The policy design and local/staging proof are the
Part 3C baseline (139 live RLS policies; isolation suites green). Production
must re-prove: Tenant A SELECT own = allow; Tenant A SELECT/UPDATE/DELETE
Tenant B = deny/zero. **Status: UNPROVEN (production), PROVEN (local/staging).**

## 10. Privileges

Critical-function ACL proof against `anon` / `authenticated` / `service_role`
(booking, payments, refunds, settlement, worker, scheduler, admin) is required
on production. Part 3C re-proved `claim_jobs_v2` and `scheduler_fire_minute` are
service_role-only at runtime locally (anon denied via SQLSTATE 42501, not a
JWT-layer 401 — F16-05 discipline). **F16-04 obligation stands:** every new or
resignatured SECURITY DEFINER function needs its own explicit REVOKE; production
catalog ACL (`pg_proc.proacl`, `has_function_privilege()`) must be re-censused,
never inferred from migration text. **Status: production UNPROVEN; local
PROVEN. Known test-quality caveats F16-05/F16-06 stand (unchanged).**

## 11. Edge Functions

Inventory: **26 Edge Functions** (excluding `_shared`). Deployment inventory to
record per function before deploy: `purpose · verify_jwt · required secrets ·
caller · tenant boundary · production dependency`.

Posture requirement: default `verify_jwt=true`; never pass `--no-verify-jwt`
casually (Part 3B §19 documents an incident where it flipped two functions —
self-caught and restored). Machine/webhook endpoints
(`run-cron-minute`, `run-cron-nightly`, `process-whatsapp-webhook`,
`verify-payment`, `run-background-worker`, `send-reminders`) carry a second,
independent machine-auth layer (`X-Cron-Secret` / `X-Worker-Secret` / HMAC — see
§12 names); if JWT verification is EVER intentionally relaxed for one, its
machine-auth mechanism must be proven separately first. Current staging posture:
all 26 functions `verify_jwt=true` (Part 3C §25) — production should match that
posture, not precede it.

**Status: inventory PROVEN; production deployment NOT IMPLEMENTED.** Post-deploy
verification template (list → version → verify_jwt → unauthorized request →
authorized request → no secret leakage) is §10 of the spec, to be run only under
authorization.

## 12. Secrets

Secret inventory **by NAME only** (no values; never printed). Exact names
required by the repository (verified against
`supabase/functions/_shared/env.ts`, `cron_auth.ts`, and the payment/webhook
callers) — do NOT invent names:

```text
SUPABASE_URL                  (config, per-environment)
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
META_ACCESS_TOKEN
META_APP_SECRET               (HMAC verify — inbound webhook)
META_WEBHOOK_VERIFY_TOKEN     (webhook handshake)
META_PHONE_NUMBER_ID          (config)
META_API_VERSION              (config, default v19.0)
RAZORPAY_KEY_ID
RAZORPAY_KEY_SECRET           (also used for payment webhook HMAC in verify-payment)
CRON_SECRET                   (X-Cron-Secret; fail-closed if empty)
WORKER_SECRET                 (X-Worker-Secret)
ALLOWED_ORIGINS               (CORS allow-list; set explicitly, never *)
APP_ENV / LOG_LEVEL / DEPLOYMENT_VERSION   (non-secret config)
ENABLE_WORKER_TRIGGER         ("true" enables cron→worker wake — D6)
```

Vault-held scheduler secrets (referenced in migrations 53/57, never in repo/
column plaintext):

```text
setura_scheduler_api_key
setura_cron_secret
```

Razorpay webhook: the repository verifies the payment webhook signature using
`RAZORPAY_KEY_SECRET` (`verify-payment/index.ts`) — there is **no separate
`RAZORPAY_WEBHOOK_SECRET` symbol in code**; the spec lists it aspirationally.
Recorded as a gap to reconcile before live Razorpay (§21), not silently assumed.
SMTP credentials live in **Supabase Auth/GoTrue** config (not Edge env; §13).
`.env.example` currently ships `ENABLE_WORKER_TRIGGER=false`; production D6
enablement requires setting it `true` on the target environment (§17). STAGING
and PRODUCTION secret sets must be fully separate. **Status: inventory PROVEN
(names only); provisioning NOT IMPLEMENTED.**

## 13. Auth

Production Auth (site_url, redirect URLs, email confirmation, password recovery,
session configuration, SMTP) is **domain-dependent → BLOCKED behind D13**. The
D13/§15 dependency map in Part 3B §15 enumerates the exact items. Real staff
account creation is separately gated (§14). Verification walk (login/logout/
refresh/protected route/password recovery/tenant+role association) must run
against the production project after configuration. **Status: NOT IMPLEMENTED
(BLOCKED on D13 + project).**

## 14. Staff Provisioning

Procedure only, no real users created: Hospital → Admin → {Receptionist, Doctor,
other roles}; verify hospital membership, role, auth identity, tenant
association, RLS access. Test/pilot users only after explicit authorization.
**Status: procedure documented; execution NOT IMPLEMENTED (authorization
required).**

## 15. Frontend

Production Vercel build must carry ONLY `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY`; never service_role / CRON_SECRET / WORKER_SECRET /
Razorpay / Meta / SMTP / Vault secrets. Bundle must contain no localhost, no
staging URL, no source-map leakage, and the correct production Supabase URL. SPA
rewrites are configured (`vercel.json`: `/(.*) → /index.html`), so `/`, login,
reception, patients, queue, doctor, history must resolve.

Measured this phase: `check:frontend-secrets` → **0 secret hits, 0 source maps**
on `apps/web/dist`; **but** that `dist` still contains `localhost` → it is a
LOCAL build, not a production artifact. The §14 production-bundle proof is
therefore **UNPROVEN** until a production build is produced against the final
env. **Status: hygiene tool PROVEN; production bundle UNPROVEN (needs real
build).**

## 16. CORS

Production CORS is domain-dependent → **BLOCKED on D13**. When configured, re-run
the staging preflight oracle (Part 3B §16 method): production origin → ALLOWED;
known required origin → ALLOWED; evil origin → NOT ALLOWED (verify exact ACAO,
methods, headers, credentials behavior, no wildcard). `ALLOWED_ORIGINS` must be
set explicitly on the production project (see the §5 fallback risk). **Status:
method PROVEN (staging); production NOT IMPLEMENTED/UNPROVEN.**

## 17. Scheduler

Production chain to prove (§17): `pg_cron tick → scheduler_fire_minute → pg_net
→ run-cron-minute → worker → claim_jobs_v2 → lease → completion`, configured via
`scheduler_http_config.base_url` + Vault (`setura_scheduler_api_key`,
`setura_cron_secret`) + `CRON_SECRET`/`WORKER_SECRET`/`ENABLE_WORKER_TRIGGER=true`
on the production Edge runtime. Every layer below the authenticated wake is
IMPLEMENTED + PROVEN locally (Part 3C §14/§15). The authenticated wake is
**BLOCKED** locally only because the linked project is staging; provisioning on
the **production** project is the authorized place to prove it. A manually
triggered worker is NOT accepted as equivalent. **Status: production UNPROVEN;
requires authorized production provisioning (resolves the 3C BLOCKED by moving
to a purpose-built environment).**

## 18. Worker

Crash-proof (§18: claim → lease → simulate crash → lease expiry → reclaim →
complete; verify no duplicate completion, no stranded job, retry/dead-letter
semantics) is PROVEN at the SQL/runtime layer locally in Part 3C (`claim_jobs_v2`
sets `lease_expires_at`; `run_scheduled_tasks → run_worker_crash_recovery →
detect_crashed_workers → reclaim_crashed_worker_jobs` reclaims a v2 job). The
production execution leg is UNPROVEN (no production worker runtime). **Status:
local PROVEN; production UNPROVEN.**

## 19. Backup / PITR

**Concrete capability finding this phase** (Supabase pricing, current):

```text
Automatic daily backups: Pro 7 days · Team 14 days · Enterprise custom
Point-in-Time Recovery : NOT on Free; on Pro/Team/Enterprise it is a
                         PAID ADD-ON at $100/month per 7-day retention window
                         (Enterprise: >28-day retention available)
```

Implication for D5 (≥30-day retention, RPO ≤15m): the **base Pro/Team plan does
NOT satisfy 30-day retention**; it needs either a stacked PITR add-on (multiple
7-day increments) or the Enterprise tier. RPO ≤15m is achievable only where
continuous WAL/PITR is actually enabled on a paid plan. This is an **owner
purchase/config decision**, not code. The Part 3C logical restore drill does NOT
prove PITR. **Status: target-plan requirement CLARIFIED; PITR configuration NOT
IMPLEMENTED (no production project); RPO UNPROVEN.**

## 20. Restore

Restore drill (§19: isolated recovery target, never overwrite production;
verify data/migrations/RLS/privileges/financial invariants/worker primitives/
scheduler re-provisioning/Auth/Edge config/E1 journey; measure ACTUAL RPO/RTO)
requires a real backup from a real production project. Part 3C proved the
DB-restore component locally (≈5.35 s) and identified what does NOT survive a
logical restore (pg_cron jobs, Vault/Edge secrets, Edge deployments/verify_jwt,
Auth config, external webhooks, Vercel config). Full operational restore with
measured RTO ≤4h and a live E1-on-restored journey is **UNPROVEN**. **Status:
NOT IMPLEMENTED (needs production target + authorization).**

## 21. Razorpay

Prove in **test mode first** (§20): create order, signature verification,
payment success, duplicate webhook, payment failure, refund, duplicate refund.
D16 model (authoritative, Part 3B): `Razorpay amount = booking_fee_inr`; SETURA
revenue = platform fee only; hospital consultation fee is never SETURA revenue;
cumulative refund cap `total_refunded ≤ total_collected`. The SQL/Edge layer is
PROVEN locally (D16 suite); the live-gateway leg (real test credentials) is
UNPROVEN by policy (no credentials). Note the §12 finding: the code verifies the
payment webhook with `RAZORPAY_KEY_SECRET` (no separate webhook secret symbol) —
reconcile the actual Razorpay webhook secret configuration before go-live.
**Status: policy layer PROVEN (local); live test-mode UNPROVEN.**

## 22. Meta

Prove in test/sandbox: webhook verification (`META_WEBHOOK_VERIFY_TOKEN`), HMAC
(`META_APP_SECRET`), inbound message, outbound message, retry, duplicate event.
WhatsApp conversational/booking logic reuses canonical platform primitives
(AGENTS §10); local suites green in baseline. Live integration is UNPROVEN (no
real credentials, by policy). **Status: local PROVEN; live UNPROVEN
(authorization + credentials required).**

## 23. SMTP

Nothing is configured (staging uses no real SMTP; local uses inbucket). Password
reset / invite email are **BLOCKED until real SMTP exists** in Supabase Auth
(provider + SPF/DKIM/DMARC on the D13 domain — §5 dependency). Prove delivery,
failure, retry, correct production sender domain. **Status: NOT IMPLEMENTED /
BLOCKED (external provider + D13).**

## 24. Observability

Before real operations: application-error monitoring, Edge Function errors,
database monitoring, scheduler failures, worker failures, dead-letter alerts,
payment failures, webhook failures, auth failures, uptime monitoring — each with
a **real tested alert** (§23: logging ≠ observability). `alert-center` and
`monitoring-health-check` Edge Functions and the metrics/logging primitives exist
in the repo (IMPLEMENTED), but no production alerting has been fired end-to-end.
**Status: primitives IMPLEMENTED; production alert firing UNPROVEN.**

## 25. Rollback

Documented rollback (no live drill): Frontend → previous immutable Vercel
deployment. Edge Functions → previous known-good version. Database → forward
migration preferred; PITR only when appropriate and after understanding side
effects. Scheduler → disable schedule safely. External webhooks → repoint to
previous known-good endpoint. Secrets → rotate/revoke compromised credentials.
**Status: procedure documented; production drill NOT IMPLEMENTED.**

## 26. Production Smoke

Suite S1–S15 (Auth, Tenant isolation, Reception, Booking, Token, Queue, Doctor
consultation, Billing, Payment, Refund, Notification, Worker, Scheduler, Audit,
Backup/restore), each with expected/actual/evidence/status. Requires a provisioned
production environment; the E1 core journey has a **staging HTTP-level PASS** and
**local PASS** baseline (Part 3B §18 / 3C §24) but NO production run. **Status:
NOT IMPLEMENTED (BLOCKED on production environment).**

## 27. Pilot Readiness

Pilot is explicitly NOT to start automatically (§26). Preconditions — production
infrastructure, backup, restore, monitoring, financial flow, external
integrations, staff provisioning, tenant isolation, rollback — are **all
BLOCKED/UNPROVEN** because no production environment exists and D13 is
unselected. **Status: NOT READY; STOP for owner sign-off.**

### Gate Matrix (§27 mandatory gates)

| Gate | Status | Basis |
| --- | --- | --- |
| D13 domain | **BLOCKED** | not selected |
| Production Supabase project | **NOT IMPLEMENTED** | none exists (`projects list`) |
| Migrations (preflight) | **PROVEN (static)** | 0 errors; manifest 60/60 |
| Migrations (production apply) | **NOT IMPLEMENTED** | no target |
| RLS (production) | **UNPROVEN** | local/staging PROVEN only |
| Privileges (production) | **UNPROVEN** | local PROVEN; prod catalog not censused |
| Auth | **BLOCKED** | D13 + project dependency |
| Edge Functions (production deploy) | **NOT IMPLEMENTED** | inventory PROVEN (26) |
| Secrets (production) | **NOT IMPLEMENTED** | name inventory PROVEN |
| Scheduler (production wake) | **UNPROVEN/BLOCKED** | layers < wake PROVEN locally |
| Worker (production) | **UNPROVEN** | crash recovery PROVEN locally |
| Crash recovery (production) | **UNPROVEN** | PROVEN locally |
| Backup | **NOT IMPLEMENTED** | needs authorized PITR plan |
| PITR | **NOT IMPLEMENTED** | paid add-on; plan undecided |
| Measured RPO | **UNPROVEN** | no PITR target |
| Measured RTO | **UNPROVEN** | DB-restore component only (local) |
| Financial flow (live) | **UNPROVEN** | D16 PROVEN locally |
| Refunds (live) | **UNPROVEN** | SQL invariant PROVEN locally |
| External integrations | **UNPROVEN** | no live credentials (policy) |
| Observability (prod alerts) | **UNPROVEN** | primitives IMPLEMENTED |
| Rollback (drill) | **NOT IMPLEMENTED** | procedure only |
| E1 production smoke | **NOT IMPLEMENTED** | local + staging PASS only |

Any BLOCKED / UNPROVEN / NOT IMPLEMENTED row means the corresponding production
gate is **not passed**.

## 28. Remaining Blockers

1. **D13 domain NOT SELECTED** → blocks Auth, CORS, webhooks, SMTP, frontend
   env, cookies, monitoring (all domain-coupled).
2. **No production Supabase project** → blocks §7–§26 live proofs.
3. **D5 PITR not provisioned** → RPO/RTO UNPROVEN; base Pro/Team tier does not
   meet ≥30-day retention (needs stacked add-on or Enterprise) — owner purchase.
4. **D6 authenticated wake** → BLOCKED locally (would mutate staging secrets);
   provable only on an authorized production/other target.
5. **Live external credentials** (Razorpay test→live, Meta, SMTP) → UNPROVEN by
   policy; `RAZORPAY_WEBHOOK_SECRET` name needs reconciliation with code (§12).
6. **Production frontend bundle** → §15 hygiene proof UNPROVEN until a real
   production build exists (current dist is a local build).
7. **`env.ts` `ALLOWED_ORIGINS` production fallback to placeholder domains** →
   should be made fail-closed in a separately-authorized change (§5).
8. Prior test-quality caveats **F16-05 / F16-06** stand (unchanged this phase).

## 29. Final Status

No production mutation was performed. All read-only/static verifications passed
and match the Part 3C baseline. Every live gate is BLOCKED or UNPROVEN for a
legitimate reason (no environment, no domain, no authorization) — none was
converted to PASS.

```text
PART 4 COMPLETE

PRODUCTION DEPLOYMENT STATUS: NOT PERFORMED (read-only / static verification
  only; all provisioning BLOCKED on owner decisions D13/D5 + explicit
  authorization)

PRODUCTION READINESS STATUS: NOT READY / NOT CLAIMED

LIVE PATIENT DATA: NOT ENABLED

LIVE COMMERCIAL OPERATIONS: NOT ENABLED
```

**Files changed:** this report only
(`PHASE_7_PART_4_PRODUCTION_READINESS_AND_CONTROLLED_PROVISIONING.md`, new,
untracked). No source, migration, config, or secret was modified.

**Production resources created:** none.

**Migrations applied:** none this phase.

**Secrets configured (by NAME only):** none configured; required names
inventoried in §12.

**Test results (this phase, all read-only):** `validate:migrations` → 0 errors
(4 known baseline warnings); `validate:migration-manifest` → 60/60, 0 issues;
`check:frontend-secrets` → 0 secret hits / 0 source maps (on a LOCAL build — not
a production-bundle proof). Full regression not re-run (Part 3C baseline
consumed as known-good).

**Backup/restore evidence:** none produced this phase (no production target);
Part 3C local logical restore remains the only DB-level evidence; RPO/RTO
UNPROVEN.

**Scheduler evidence:** none new; D6 layers < wake remain PROVEN locally /
BLOCKED for the authenticated wake.

**Financial evidence:** none new; D16 remains PROVEN locally, live legs
UNPROVEN.

**External integration evidence:** none; Razorpay/Meta/SMTP live legs UNPROVEN
(no credentials, by policy).

**Remaining blockers:** see §28.

**Exact owner authorization required for the next action:**

1. **Select the production domain (D13)** — the single gating decision; nothing
   domain-coupled proceeds without it.
2. **Authorize creation of ONE dedicated production Supabase project** (region,
   compute tier, and a plan/PITR configuration that satisfies D5 ≥30-day
   retention) and fund/authorize a real PITR restore drill with measured
   RPO/RTO and a live E1.
3. **Authorize production Edge-secret provisioning** (`SUPABASE_*`,
   `CRON_SECRET`, `WORKER_SECRET`, `ENABLE_WORKER_TRIGGER=true`,
   `ALLOWED_ORIGINS` set explicitly, Vault `setura_*` secrets) so the D6
   authenticated worker wake can be proven end-to-end on the production project.
4. **Authorize production migration apply (01–60) + Edge Function deployment**
   with `verify_jwt=true`, followed by the §9–§10 RLS/privilege production
   census and the §25/S1–S15 production smoke.
5. **Authorize live external integration credential provisioning** (Razorpay
   test→live, Meta, SMTP) and reconcile the Razorpay webhook secret name.
6. **Authorize staff/tenant record creation** (test/pilot users) before any
   pilot.

Do not claim success from deployment commands completing; each gate above still
requires matching evidence at the level it claims.

END OF PART 4.
