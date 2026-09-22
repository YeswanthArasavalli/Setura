# PHASE 7 — PART 5A: D5 RESOLUTION + AUTHORIZED PRODUCTION ENVIRONMENT PROVISIONING

**Execution state:** D5 = **DEFERRED BY OWNER** (deliberate deferral at the
product-completion / controlled-validation stage; the D5 technical requirement
is preserved, not weakened). No production infrastructure created, no production
mutation, no source modification, no staging mutation, no Enterprise purchase,
no external backup built, no production patient data. This session performed
read-only reconciliation (Git/Supabase-link state) plus official platform
verification of Supabase backup/PITR capability, recorded the owner's D5
deferral, and advanced to the next explicit authorization gate (§5) without
assuming any provisioning authorization (Part 5A §1).

**Date:** 2026-09-22
**Discipline:** Per Part 5A §27 — BLOCKED ≠ PASS, UNPROVEN ≠ PASS, deployment ≠
runtime proof, LOCAL ≠ STAGING ≠ PRODUCTION. No credentials, domains, or
production evidence invented.

---

## 1. Current State (verified, read-only)

| Item | Value | Evidence | Status |
| --- | --- | --- | --- |
| Git HEAD | `0bb2d90` (`0bb2d909f98768016c7aae2c3b48a6e19242440b`) | `git rev-parse --short HEAD` | PROVEN (local repo) |
| Branch / remote | `main`, `origin/main` = `0bb2d90` (in sync) | `git rev-parse --abbrev-ref HEAD`, `git rev-parse --short origin/main` | PROVEN (local repo) |
| Working tree | clean except untracked Part 4 / Part 5 report artifacts | `git status --short` | PROVEN (local repo) |
| Linked Supabase project | `gzcqasntcbqqmgsoikms` = **setura-staging** | `supabase/.temp/project-ref` | PROVEN (STAGING, never reuse as prod) |
| Production Supabase project | does not exist | Part 5 §4; no prod ref anywhere in tree | BLOCKED (not authorized) |
| Migrations (source) | 01–60 present, `validate:migrations` 0 errors, 4 pre-existing duplicate-object warnings, manifest 60/60, 0 integrity issues | Part 5 §6 (carried forward) | source READY / prod BLOCKED |

AGENTS.md §13 "not a Git repository" baseline is **outdated** — `.git` exists
and the tree tracks GitHub (`origin/main` in sync). Reconciled against live state.

## 2. D13 Decision

**D13 = DEFERRED BY OWNER** (carried forward, unchanged this session). No custom
domain exists. Temporary frontend origin for controlled validation =
`https://setura-delta.vercel.app` (currently targets **STAGING** backend, NOT a
production-backend frontend). No domains invented (`setura.in` /
`app.setura.in` placeholders left unmodified). Final Auth `site_url`, CORS
allow-list, Meta/Razorpay production webhooks, and final SMTP sender remain
deferred until the owner selects a canonical domain.

## 3. D5 Decision  —  **DEFERRED BY OWNER**

**Requirement (Part 5A §3, PRESERVED — implementation deferred, not weakened):**
RPO ≤ 15 min AND RTO ≤ 4 h AND retention ≥ 30 days.

**Official platform verification (Supabase docs, retrieved 2026-09-22):**

| Fact | Value | Source |
| --- | --- | --- |
| PITR worst-case RPO | ~2 minutes (WAL archived every 2 min; more frequent under load) | supabase.com/docs/guides/platform/backups |
| Self-serve PITR recovery-retention tiers | **7 / 14 / 28 days** only | backups + manage-your-usage/point-in-time-recovery |
| Self-serve PITR monthly cost | ~$100 (7d) / ~$200 (14d) / ~$400 (28d) | manage-your-usage/point-in-time-recovery |
| Daily-backup retention by plan | Pro 7d · Team 14d · Enterprise up to 30d | supabase.com/features/database-backups |
| PITR ↔ daily backups | Enabling PITR **stops** daily backups (cannot stack within one project) | backups |
| PITR prerequisite | ≥ Small compute add-on | backups |
| Restore downtime (RTO) | Depends on DB size; not a fixed published figure | backups |

**Finding:** No single standard self-serve Supabase tier satisfies retention
≥ 30 days AND RPO ≤ 15 min simultaneously. Max self-serve PITR retention = 28
days (< 30), and Enterprise "up to 30 days" is stated for **daily** backups
(≈24 h RPO, which fails ≤ 15 min). Enabling PITR disables daily backups, so the
two cannot be combined in one project.

**Owner decision this session:** **D5 = DEFERRED BY OWNER** (a deliberate
deferral, recorded distinctly from a passive block). The two viable
configurations remain technically valid but unfunded and unselected:
- Option A — Enterprise + negotiated PITR recovery retention > 28-day self-serve
  cap (contact Supabase sales) — the only single managed path meeting all three.
- Option B — Pro/Team + 28-day PITR (RPO ~2 min) PLUS scheduled logical/WAL-G
  archives to independent object storage to reach ≥ 30-day restorable history.

**Reason (owner-stated):** SETURA is currently in product completion and
controlled validation, not commercial operation. There is no real-world customer
demand yet that justifies committing to Supabase Enterprise or building and
operating an independent long-retention backup architecture. The product will
first be completed, the full system validated, and prepared for real-world
release; the production backup architecture that satisfies the original D5
requirements will be selected and funded when there is real demand and SETURA is
being prepared for actual customer/hospital operations.

**This deferral does NOT weaken or change the D5 technical requirement** — RPO ≤
15 min · RTO ≤ 4 h · retention ≥ 30 days are preserved verbatim for the eventual
production launch; only its *implementation* is deferred. Accordingly: D5 is NOT
marked PROVEN; production DR readiness is NOT claimed; no production
infrastructure is created solely to satisfy D5; Enterprise is NOT purchased; no
external backup system is built now; no production patient data is created. Only
work that is safe and independent of D5 continues.

## 4. Owner Authorizations

| Gate | Authorized this session? | Effect |
| --- | --- | --- |
| A. D5 backup/PITR plan | **DEFERRED BY OWNER** (not resolved, not weakened) | Production provisioning that depends on a selected backup plan is on hold; only D5-independent work continues |
| B. Create ONE production Supabase project | NO — owner held the gate | Presented this session; owner elected to keep production on hold |
| C. Production migrations 01–60 | NO | BLOCKED (separate gate §7/§8) |
| D. Production Edge Function deployment | NO | BLOCKED (separate gate §9) |
| E. Production secret provisioning | NO | BLOCKED (separate gate §10) |

D5 was DEFERRED (no backup plan selected), so the §5 production-project
authorization cannot be exercised "using the selected D5 plan" and is therefore
presented as the next explicit gate rather than assumed. B/C/D/E remain
separately authorization-gated; none is requested or performed this session, and
no production infrastructure is created to satisfy a deferred D5.

## 5. Production Project — NOT CREATED (owner held this gate)

The §5 gate was explicitly presented to the owner this session and the owner
elected to **keep production on hold** (consistent with the D5 deferral posture:
complete the product and validate the system first). No production Supabase
project created and none will be created without a separate future explicit
authorization. Only linked project is STAGING (`gzcqasntcbqqmgsoikms`), which
per §5 must never be reused, converted, or deleted as/for production.

## 6. Database — BLOCKED

No production environment → Postgres version, `pg_cron`/`pg_net`, extensions,
timezone, RLS/Auth/Storage/Realtime health cannot be baselined. Local/staging
values are not production evidence (§27).

## 7. Migrations — BLOCKED (production) / source READY

Not applied to production. Source readiness carried forward from Part 5 §6
(01–60, 0 errors, 4 documented pre-existing duplicate-object warnings, 60/60
manifest, 0 integrity issues).

## 8. Schema Census — BLOCKED

No production DB. Reference baseline (≈103 tables / 481 functions / 139 RLS
policies / 81 triggers / 35 enums / 60 migration rows) is for later comparison
only; platform-object differences must be explained when eventually measured,
not assumed.

## 9. RLS / Tenant Isolation — BLOCKED

No production tenants/users; cross-tenant deny proofs over PostgREST and Edge
paths not performed. UI filtering alone would not be proof (§14).

## 10. Privileges / SECURITY DEFINER — BLOCKED

No production catalog census. `pg_proc.proacl` / `has_function_privilege()` for
booking/payment/refund/settlement/worker/scheduler/admin/tenant-management must
be measured on the real production DB, not inferred from migration text. F16-04
obligation applies: any new/resignatured SECURITY DEFINER function needs its own
explicit REVOKE at provisioning time.

## 11. Edge Functions — BLOCKED (production)

Not deployed. Inventory: **26** Edge Functions (excluding `_shared`). Machine
functions `run-cron-minute`, `run-cron-nightly`, `run-background-worker`,
`send-reminders`, `verify-payment`, `process-whatsapp-webhook` must each retain
independent `X-Cron-Secret` / `X-Worker-Secret` / HMAC auth. Default posture is
`verify_jwt=true`; `--no-verify-jwt` only with a documented, proven machine-auth
boundary.

## 12. Secrets — BLOCKED (production)

None provisioned. Required **names** (values never recorded) to reconcile
against code at provisioning time: core (`SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`), scheduler (`CRON_SECRET`, `WORKER_SECRET`,
`ENABLE_WORKER_TRIGGER=true`, `ALLOWED_ORIGINS`), Vault (`setura_scheduler_api_key`,
`setura_cron_secret`), Meta (`META_ACCESS_TOKEN`, `META_APP_SECRET`,
`META_WEBHOOK_VERIFY_TOKEN`, `META_PHONE_NUMBER_ID`, `META_API_VERSION`),
Razorpay (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`), config (`APP_ENV`,
`LOG_LEVEL`, `DEPLOYMENT_VERSION`). Code uses `RAZORPAY_KEY_SECRET` for payment
webhook signature — do NOT invent `RAZORPAY_WEBHOOK_SECRET`. Production and
staging secrets must remain fully separate.

## 13. Auth — BLOCKED (production)

Cannot be finalized while D13 is deferred; not configured. No staff/test users
created.

## 14. Temporary Vercel Origin — recorded, staging-backed

`https://setura-delta.vercel.app` (Vercel project `setura`, root `apps/web`)
remains the temporary controlled-validation origin. It currently targets the
STAGING backend; it is explicitly NOT the canonical production domain and must
not be represented as a production-backend frontend.

## 15. CORS — BLOCKED (final) + open finding

`env.ts` still carries the placeholder production fallback
`ALLOWED_ORIGINS = "https://setura.in,https://app.setura.in"` under `IS_PRODUCTION`.
Not modified this session (a fail-closed change is a separate, separately-tested
source change). Final allow-list is a post-D13 gate; must never be `*`.

## 16. Scheduler (D6 Autonomy) — IMPLEMENTED/PROVEN (local/staging) / UNPROVEN (production)

Scheduler autonomy is **already implemented and runtime-proven in the local/
staging stack** (Part 3C) — correcting the earlier stale "no scheduler"
baseline: `pg_cron` 1.6.4 + `pg_net` 0.20.0 installed; migrations 53/57 register
`setura_cron_minute`/`setura_cron_nightly` firing `scheduler_fire_*` via
`net.http_post`; `setura_cron_minute` fired autonomously 1040+ times; the
`pg_cron → scheduler_fire_minute → pg_net → run-cron-minute` transport and the
endpoint fail-closed secret gate were proven live (HTTP 403). **P0-01 is NOT
open** — migration 51 sets `lease_expires_at = now() + interval '2 minutes'` on
the claim UPDATE and a crashed worker's v2 job is reclaimed (runtime-proven in
local). **P0-02 is NOT "no scheduler installed"** — as above.

What remains **UNPROVEN is production**: the D6 authenticated worker wake
(claim → complete driven by the HTTP trigger) and production Edge secrets/config
(P0-03 `ENABLE_WORKER_TRIGGER`/`CRON_SECRET`/`WORKER_SECRET`) are unproven
**because production does not exist**; even in the staging-linked local stack the
authenticated wake was left BLOCKED (its secrets could only target the linked
staging project, out of scope). Local/staging implementation ≠ production proof;
manual trigger ≠ autonomous production proof.

## 17. Worker — BLOCKED (production)

No **production** worker execution/crash-recovery/lease/reclaim/retry/dead-letter
proven (no production environment). Lease population and crash-reclaim are
IMPLEMENTED and runtime-proven in local/staging (Part 3C); production autonomy
depends on the §16 authenticated-wake gate. Not converted to a production PASS.

## 18. Backup / PITR (D5) — DEFERRED BY OWNER

See §3. D5 implementation is deferred (requirement preserved, not weakened) and
no production project exists → PITR enablement, retention, backup health and
recovery-point availability are all UNPROVEN. Production DR readiness is NOT
claimed.

## 19. Restore Drill — BLOCKED

Not performed (no production DB). When eventually run: restore into an isolated
target (never overwrite production), re-provision layers logical restore does NOT
cover (pg_cron, Vault, Edge deployments, Edge secrets, Auth config, Vercel,
external webhooks), then re-run E1.

## 20. Razorpay — BLOCKED

D16 policy authoritative (collect only `booking_fee_inr`; revenue = successful
capture; refund ≤ collected) but NOT exercised; TEST mode not authorized; no real
money moved. All order/capture/webhook/refund/partial/over-refund/ledger/
settlement proofs UNPROVEN for production.

## 21. Meta / WhatsApp — BLOCKED

Not authorized; no production credentials/webhooks against an invented domain.
HMAC/inbound/outbound/retry/duplicate/idempotency/tenant-isolation UNPROVEN.

## 22. SMTP — BLOCKED / DEFERRED

Sender domain depends on D13. Not configured. Invite/reset/confirmation
delivery/failure/retry UNPROVEN.

## 23. Observability — BLOCKED (production)

No production monitoring for Edge/DB/scheduler/worker/dead-letter/payment/
webhook/auth failures or uptime; no TRIGGER→ALERT→RECEIPT→ACKNOWLEDGEMENT chain
verified.

## 24. Production E1 — BLOCKED

Full patient journey with backend-state proof at each transition plus repeated
tenant isolation cannot run without a production environment. UNPROVEN.

## 25. S1–S15 Security Smoke — BLOCKED (production)

None executable against production (none exists). Each UNPROVEN. BLOCKED ≠ PASS.

## 26. Custom Domain Deferral

D13 remains intentionally DEFERRED. No domain bought or configured. When the
owner eventually selects one, the chain DNS→Vercel→HTTPS→Auth→redirects→CORS→
frontend→Razorpay webhook→Meta webhook→SMTP must be revalidated.

## 27. Pilot Gate — NOT READY

Multiple mandatory gates are **production** UNPROVEN/BLOCKED (production
project, RLS, privileges, Auth, financial, Meta, SMTP, observability, E1,
S1–S15); **D5 is DEFERRED BY OWNER** (requirement preserved, implementation
deferred); scheduler/worker are IMPLEMENTED/PROVEN only in local/staging and
remain production-unproven (§16/§17); D13 is deferred. No BLOCKED/UNPROVEN/
DEFERRED gate may be treated as a production PASS. Pilot must NOT start.

## 28. Remaining Blockers

- **D5 = DEFERRED BY OWNER (owner election; requirement preserved,
  implementation deferred).** This is the root gate. No self-serve Supabase
  config meets retention ≥ 30 d AND RPO ≤ 15 min; the two viable resolutions are
  Enterprise + >28-day custom PITR retention, or 28-day PITR + external ≥30-day
  archive. The owner deferred D5 rather than select/fund either.
- **No production-provisioning authorization** — the §5 project-creation gate
  was presented and the owner elected to hold it; §5 is specified against a
  selected D5 plan (currently deferred).
- **D13 deferred** — hard-gates final Auth/CORS/webhook/SMTP/DNS/custom-domain.
- **env.ts placeholder CORS fallback** unmodified (needs separate authorization).
- Carried-forward obligations, corrected against Part 3C: **P0-01 and P0-02 are
  no longer open** — lease population/crash-reclaim (migration 51) and the
  scheduler/`pg_cron`+`pg_net` chain (migrations 53/57) are IMPLEMENTED and
  runtime-proven in local/staging. What remains is **production** proof: the D6
  authenticated worker wake and production Edge secrets/config (P0-03), and
  F16-04 (new/resignatured SECURITY DEFINER needs explicit REVOKE at production
  provisioning). None is claimed as a production PASS.

## 29. Final Status

Read-only reconciliation and official platform verification complete. The owner
elected **D5 = DEFERRED BY OWNER** (product-completion / controlled-validation
stage; the D5 requirement is preserved and only its implementation deferred), so
**no production project was created and no production resource was provisioned**.
Production provisioning stays on hold because §5 is specified against a selected
D5 plan. The next explicit authorization gate is §5 production-project creation;
B/C/D/E each still require their own separate explicit confirmation, and none is
assumed this session.

---

PART 5A COMPLETE (D5 DEFERRED BY OWNER — production provisioning on hold)

D13 DOMAIN: DEFERRED BY OWNER

TEMPORARY FRONTEND: https://setura-delta.vercel.app (targets STAGING backend; NOT
final canonical domain)

PRODUCTION BACKEND: DOES NOT EXIST — provisioning not authorized

D5: **DEFERRED BY OWNER** — implementation deferred at the product-completion /
controlled-validation stage; retention≥30d AND RPO≤15min AND RTO≤4h remain the
preserved launch requirement (NOT weakened, NOT marked PROVEN); DR readiness NOT
claimed; no Enterprise purchase; no external backup built; no production
infrastructure created solely to satisfy D5

PRODUCTION PROJECT: NOT CREATED — §5 gate presented and held by owner election
(keep production on hold); future creation needs a separate explicit authorization

MIGRATIONS: source READY (01–60, 0 errors, 4 documented warnings); production
application BLOCKED

EDGE FUNCTIONS: NOT DEPLOYED (BLOCKED); 26 inventoried, verify_jwt=true default posture

SECRETS: NOT PROVISIONED (BLOCKED); names enumerated, values never recorded

RLS: BLOCKED (production)

PRIVILEGES: BLOCKED (production)

D6 AUTONOMY: IMPLEMENTED/PROVEN (local/staging — pg_cron+pg_net, 1040+ autonomous
ticks, lease + crash-reclaim via migrations 51/53/57); UNPROVEN (production — no
project; authenticated wake + Edge secrets/config remain). P0-01/P0-02 no longer
open; P0-03 is a production-config gate. Local/staging proof ≠ production PASS.

BACKUP/PITR: DEFERRED BY OWNER / UNPROVEN (production DR readiness NOT claimed)

RPO: UNPROVEN (target ≤15 min; PITR ~2 min capable but not enabled)

RTO: UNPROVEN (target ≤4 h; not measured)

FINANCIAL: UNPROVEN (production); D16 policy authoritative, not exercised; no real money

RAZORPAY: NOT CONNECTED (TEST not authorized)

META/WHATSAPP: NOT CONNECTED (not authorized)

SMTP: BLOCKED / DEFERRED (depends on D13)

OBSERVABILITY: BLOCKED (production)

PRODUCTION E1: UNPROVEN — no production environment

S1–S15: UNPROVEN — no production environment (BLOCKED ≠ PASS)

LIVE PATIENT DATA: NOT ENABLED

LIVE COMMERCIAL OPERATIONS: NOT ENABLED

PILOT: NOT READY — BLOCKED

CUSTOM DOMAIN: DEFERRED

OWNER SIGN-OFF: D5 DEFERRED BY OWNER (requirement preserved, implementation
deferred); no production provisioning authorized or performed this session
