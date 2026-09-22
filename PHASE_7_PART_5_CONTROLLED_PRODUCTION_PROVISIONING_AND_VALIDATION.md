# PHASE 7 — PART 5: CONTROLLED PRODUCTION PROVISIONING + PRODUCTION VALIDATION

**Execution state:** STOPPED AT AUTHORIZATION GATE (D13 resolved-as-DEFERRED; no
separate production-provisioning authorization issued).
**Date:** 2026-09-21
**Operator discipline:** Per Part 5 §1, §2, §29 — no production mutation, no
source modification, no staging mutation performed. Read-only reconciliation
(§3) only.

---

## 1. Scope

Part 5 defines controlled production provisioning and production validation for
SETURA. This session executed **only** the §3 read-only pre-production
reconciliation, then honored the §2/§29 hard stop:

- D13 was resolved by the owner as **DEFERRED BY OWNER** (see §2).
- Production project creation and all production resource provisioning were
  **NOT separately authorized** in this session and remain BLOCKED.
- No production environment exists; therefore no production validation could be
  performed. Every production-facing gate is honestly recorded as BLOCKED or
  UNPROVEN — never inflated to PASS (§27).

## 2. Owner Authorizations

| Decision | Value | Effect |
| --- | --- | --- |
| **D13 (production domain)** | **DEFERRED BY OWNER** | Custom domain intentionally deferred until the system + Razorpay/Meta integrations are ready. Temporary frontend origin for controlled validation = existing Vercel production URL `https://setura-delta.vercel.app`. Do NOT invent domains; do NOT use `env.ts` placeholders. |
| **D5 (production plan/tier)** | NOT PROVIDED | BLOCKED — PITR/RPO≤15min/retention≥30d require a paid tier; not authorized or selected. |
| Production project creation | NOT AUTHORIZED | BLOCKED |
| Production migrations | NOT AUTHORIZED | BLOCKED |
| Production Edge deployment | NOT AUTHORIZED | BLOCKED |
| Production secret provisioning | NOT AUTHORIZED | BLOCKED |
| Production test users | NOT AUTHORIZED | BLOCKED |
| Razorpay TEST credentials | NOT AUTHORIZED | BLOCKED |
| Meta/WhatsApp TEST credentials | NOT AUTHORIZED | BLOCKED |
| SMTP configuration | NOT AUTHORIZED | BLOCKED |
| Production DNS / Vercel custom domain | DEFERRED (D13) | BLOCKED for final config |

**D13 mandatory downstream gates (cannot be finalized until the canonical
domain exists):** final custom-domain config; final Auth `site_url`/redirect
URLs; final CORS allow-list; Meta production webhook; Razorpay production
webhook; final SMTP sender/domain; public pilot/commercial launch where those
services require the canonical domain.

## 3. Git Baseline  — PROVEN (local repo inspection)

| Item | Value |
| --- | --- |
| HEAD | `0bb2d909f98768016c7aae2c3b48a6e19242440b` |
| Subject | "D16 financial policy and staging remediation" |
| Branch | `main`, tracking `origin/main` — **in sync** |
| Origin | `https://github.com/YeswanthArasavalli/Setura.git` |
| Working tree | clean except untracked `PHASE_7_PART_4_PRODUCTION_READINESS_AND_CONTROLLED_PROVISIONING.md` |
| Recent commits | `0bb2d90` D16 financial policy · `173c25e` D16 refunds · `56065ed` hosted staging frontend · `e5e0293` redact/census/Vercel · `71aeb1c` staging cleanup |

> AGENTS.md §13 "not a Git repository" baseline is **outdated**: `.git` exists
> and the tree is a real repo tracking GitHub. Reconciled against live state.

## 4. Production Project  — BLOCKED

No dedicated production Supabase project created (not authorized; §4 requires
explicit authorization). The only linked project is
`supabase/.temp/project-ref` = `gzcqasntcbqqmgsoikms` / **`setura-staging`** —
this is STAGING and per §1/§4 must never be reused or converted as production.

## 5. Database Baseline  — BLOCKED (production)

Cannot record production Postgres version, `pg_cron`/`pg_net` availability,
extensions, timezone, RLS/Auth/Storage status: no production environment.
Local/staging values are NOT evidence of production (§27).

## 6. Migration Application  — BLOCKED (production) / source READY

Migrations were **not** applied to production (not authorized). Source-side
readiness verified (§3.B):

| Check | Command | Result |
| --- | --- | --- |
| Migration chain | `deno task validate:migrations` | 60 files scanned · **0 errors** · 4 pre-existing `[duplicate-objects]` warnings (documented baseline, not new defects) |
| Manifest integrity | `deno task validate:migration-manifest` | `supabase/migrations/MANIFEST.sha256` = 60 lines · **60 migrations / 60 manifest lines · 0 integrity issues** |
| Chain | files `01`→`60` present | 01–60 contiguous |

## 7. Schema Census  — BLOCKED (production)

Cannot perform a production census. Part 3C expected approximate baseline
(103 tables / 481 functions / 139 RLS policies / 81 triggers / 35 enums / 60
migration rows) is recorded for reference only; not verified against production
(no production DB). Legitimate platform-object differences must be explained
when eventually measured, not assumed.

## 8. RLS / Tenant Isolation  — BLOCKED (production)

No production tenants/users created (not authorized). Tenant A/B read/write/
cross-tenant-deny proofs over PostgREST and Edge paths require a production
environment. Not performed. (Staging/local RLS evidence is NOT production
evidence.)

## 9. Privileges / SECURITY DEFINER Census  — BLOCKED (production)

No production catalog census possible. `pg_proc.proacl` /
`has_function_privilege()` for booking/payment/refund/settlement/worker/
scheduler/admin/tenant-management functions must be measured against the real
production DB; production ACLs must NOT be inferred from migration text (§8,
§27). F16-04 obligation applies: any new/resignatured SECURITY DEFINER function
needs its own explicit REVOKE at provisioning time.

## 10. Edge Function Deployment  — BLOCKED (production)

Not deployed (not authorized). Inventory verified: **26** Edge Functions under
`supabase/functions/` (excluding `_shared`). The six machine/webhook functions
for the future deployment gate: `run-cron-minute`, `run-cron-nightly`,
`run-background-worker`, `send-reminders`, `verify-payment`,
`process-whatsapp-webhook`. Default posture for deployment is `verify_jwt=true`;
`--no-verify-jwt` only with a documented, proven machine-auth boundary.
Unauthorized/authorized/tenant/machine-auth/secret-leakage checks are UNPROVEN
for production.

## 11. Secrets  — BLOCKED (production)

No production secrets provisioned (not authorized). Secret **names** (values
never recorded) required at provisioning time, to be reconciled against actual
code: core (`SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`), Meta (`META_ACCESS_TOKEN`, `META_APP_SECRET`,
`META_WEBHOOK_VERIFY_TOKEN`, `META_PHONE_NUMBER_ID`, `META_API_VERSION`),
Razorpay (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`), scheduler (`CRON_SECRET`,
`WORKER_SECRET`, `ENABLE_WORKER_TRIGGER=true`, `ALLOWED_ORIGINS`), Vault
(`setura_scheduler_api_key`, `setura_cron_secret`), config (`APP_ENV`,
`LOG_LEVEL`, `DEPLOYMENT_VERSION`).

> **Reconciliation note (§10 prompt / §11):** the code uses
> `RAZORPAY_KEY_SECRET` for webhook signature — do NOT invent
> `RAZORPAY_WEBHOOK_SECRET`. Production and staging secrets must remain fully
> separate.

## 12. Auth  — BLOCKED (production)

Production Auth cannot be configured while D13 is deferred (site_url, redirect
URLs, email confirmation, recovery, sessions depend on the canonical domain;
"no localhost"). Not performed. Login/logout/refresh/protected-route/
tenant-membership/role tests are UNPROVEN for production. No staff created.

## 13. Staff Provisioning  — BLOCKED

No production staff/test users created (not authorized; §12 "do not create real
staff automatically").

## 14. Frontend  — PARTIAL (temporary Vercel origin only) / production-backend BLOCKED

- Vercel project `setura` (`prj_PZq3TlY28vzz3hF6x0TKpvxK6gMH`), root
  `apps/web`, SPA rewrite `/(.*) → /index.html`. Production alias / temporary
  origin: **`https://setura-delta.vercel.app`**.
- **Important distinction:** this Vercel deployment currently targets the
  **STAGING** Supabase backend (`gzcq…supabase.co`). It is NOT a
  production-backend frontend. Calling it a production build against production
  would be false (§27).
- Frontend env contract stands: only `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_ANON_KEY` may be exposed; never service_role / CRON_SECRET /
  WORKER_SECRET / Razorpay / Meta / SMTP / Vault.

## 15. Domain / DNS  — DEFERRED (D13) / BLOCKED

Custom domain intentionally deferred by owner. No DNS/Vercel custom-domain, HTTPS
cert, or dependency-chain (DNS→Vercel→HTTPS→Auth→redirects→CORS→frontend→
Meta→Razorpay→SMTP) configuration performed. Temporary origin is the Vercel
production URL; it is explicitly NOT the eventual canonical domain.

## 16. CORS  — BLOCKED (final) + open finding

- `env.ts:211-216` still carries the placeholder production fallback
  `ALLOWED_ORIGINS = "https://setura.in,https://app.setura.in"` (when
  `IS_PRODUCTION`). Per owner instruction this fallback is **NOT** modified in
  this session (separate authorization required for a fail-closed source
  change). Recorded as a carried-forward Part 4 finding: production must not
  depend on placeholder fallback; final allow-list is a post-D13 gate and must
  never be `*`.
- evil-origin rejection and exact ACAO/headers/methods proofs are UNPROVEN.

## 17. Scheduler (D6 Autonomy)  — BLOCKED (production)

`pg_cron → scheduler_fire_minute → pg_net → run-cron-minute → send-reminders →
run-background-worker → claim_jobs_v2` autonomous chain cannot be proven in
production (no project). Manual worker trigger ≠ autonomous proof (§29 of Part
5). P0-02 (no scheduler installed) and P0-01 (`claim_jobs_v2` lease) remain as
baseline obligations to verify at provisioning; crash/lease/reclaim/retry/
dead-letter tests UNPROVEN for production.

## 18. Worker  — BLOCKED (production)

No production worker execution proven. See §17 dependencies.

## 19. Backup / PITR (D5)  — BLOCKED

D5 unresolved and no production project → PITR enablement, retention window,
backup health and restore capability are UNPROVEN. The plan "theoretically
supporting PITR" is not evidence (§27).

## 20. Restore Drill  — BLOCKED

Not performed (no production DB). When run, must restore into an isolated
target (never overwrite production) and must re-provision the layers logical
restore does NOT cover (pg_cron, Vault, Edge deployments, Edge secrets, Auth
config, Vercel config, external webhooks), then re-run E1 against the restore.

## 21. Razorpay (Financial Live Validation)  — BLOCKED

D16 policy (SETURA collects only `booking_fee_inr`; revenue = successful
capture only; refund ≤ collected) is the authoritative rule but was NOT
exercised against Razorpay (not authorized; no production). All 12 order/
payment/webhook/refund/partial/over-refund/ledger/settlement proofs are
UNPROVEN for production. No real money moved.

## 22. Meta / WhatsApp  — BLOCKED

Not authorized; no production credentials/webhooks against an invented domain.
HMAC/inbound/outbound/retry/duplicate/idempotency/tenant-isolation proofs are
UNPROVEN for production. Local mocks are not Meta readiness (§27).

## 23. SMTP  — BLOCKED / DEFERRED

Sender domain depends on D13. Not configured. SPF/DKIM/DMARC and
invite/reset/confirmation delivery/failure/retry proofs UNPROVEN.

## 24. Observability  — BLOCKED (production)

No production monitoring proven for Edge/DB/scheduler/worker/dead-letter/
payment/webhook/auth failures or uptime, and no
TRIGGER→ALERT→RECEIPT→ACKNOWLEDGEMENT chain verified in production.

## 25. Rollback  — NOT EXERCISED

Rollback procedures (frontend immutable deploy, Edge prior version, DB forward
migration, scheduler safe-disable, webhook previous endpoint, secret rotation)
were not exercised. No destructive rollback performed against production (§23).

## 26. Production E1  — BLOCKED

Full patient journey (registration → appointment/walk-in → doctor → token →
queue → call → consultation → billing → booking-fee payment → notification →
history) with backend-state proof at each step, plus repeat tenant isolation,
cannot run without a production environment. UNPROVEN.

## 27. S1–S15 Security Smoke  — BLOCKED (production)

S1 Auth … S15 Backup/restore cannot be executed against production (none
exists). Each remains UNPROVEN. BLOCKED ≠ PASS, UNPROVEN ≠ PASS.

## 28. Pilot Gate  — NOT READY

Multiple mandatory gates are BLOCKED/UNPROVEN (D5, production project, RLS,
privileges, Auth, scheduler, worker, financial, Meta, SMTP, observability, E1,
S1–S15) and D13 is deferred. No BLOCKED/UNPROVEN gate may be treated as PASS
(§24). Pilot must NOT start.

## 29. Exceptions / Blockers

- **D13 DEFERRED BY OWNER** — intentionally unblocks domain-independent work
  but hard-gates final Auth/CORS/webhook/SMTP/DNS/custom-domain and any pilot
  that requires the canonical domain.
- **No production-provisioning authorization** — this is the primary blocker
  for §4–§27. Production project creation is the first gated action.
- **env.ts placeholder CORS fallback** remains unmodified (needs separate
  authorization for a fail-closed source change).
- **Vercel origin `setura-delta.vercel.app` targets staging**, not production —
  must not be represented as a production-backend frontend.
- Baseline obligations carried forward: P0-01 (`claim_jobs_v2` lease),
  P0-02 (no scheduler), P0-03 (`ENABLE_WORKER_TRIGGER=false` default),
  F16-04 (new/resignatured SECURITY DEFINER needs explicit REVOKE).

## 30. Final Status

Reconciliation is complete and consistent with Part 4's known-good local/staging
baseline. No production provisioning or validation was possible or authorized
beyond D13's deferral classification. The next actionable step is a **separate,
explicit owner authorization** to create the single production Supabase project
(and, independently, a resolved D5 tier) — after which §5 onward can proceed
gate-by-gate.

## 31. Owner Sign-Off

NOT RECEIVED. Per §25, real pilot requires explicit owner sign-off covering
environment, project, domain, PITR/RPO/RTO, integrations, pilot tenant/staff,
and financial/patient-data/commercial authorizations. None present.

---

PART 5 COMPLETE

PRODUCTION DEPLOYMENT STATUS: NOT DEPLOYED — provisioning not authorized (BLOCKED)

PRODUCTION READINESS STATUS: NOT READY — mandatory gates BLOCKED/UNPROVEN

PRODUCTION PROJECT: DOES NOT EXIST — creation BLOCKED (not authorized)

D13 DOMAIN: DEFERRED BY OWNER — temporary origin `https://setura-delta.vercel.app` (targets STAGING backend); canonical domain mandatory gate for Auth/CORS/DNS/webhooks/SMTP/pilot

D5 BACKUP/PITR: BLOCKED — tier unresolved, no production DB; RPO≤15min / RTO≤4h / retention≥30d UNPROVEN

D6 AUTONOMY: BLOCKED (production) — no scheduler/worker autonomous chain proven; manual trigger ≠ autonomy

FINANCIAL LIVE STATUS: UNPROVEN (production) — D16 policy authoritative but not exercised; no real transactions

EXTERNAL INTEGRATIONS: NOT CONNECTED — Razorpay/Meta/SMTP production credentials not authorized; no invented domains

PRODUCTION E1: UNPROVEN — no production environment

S1–S15: UNPROVEN — no production environment (BLOCKED ≠ PASS)

LIVE PATIENT DATA: NOT ENABLED

LIVE COMMERCIAL OPERATIONS: NOT ENABLED

PILOT STATUS: BLOCKED — not ready (multiple mandatory gates BLOCKED/UNPROVEN; D13 deferred)

OWNER SIGN-OFF: REQUIRED
