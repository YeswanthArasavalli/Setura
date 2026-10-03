# WS-ONBOARD-3 — Integration Configuration & Secure Credential Management
## Implementation Report

Status vocabulary per AGENTS.md §5 and prompt §44. Every status below is tied
to a command that was actually executed this session against the real local
Supabase stack.

---

## 1. Executive summary

WS-ONBOARD-3 gives an authorized SETURA administrator a frontend surface to
configure a hospital's supported external integrations (Razorpay +
Meta/WhatsApp) — public identifiers, enablement, connection testing and
platform-global credential rotation — with **NO SQL edit, NO source edit and NO
ordinary per-hospital env-var edit**. Secrets are written to Supabase Vault
through a service-role-only path and can **NEVER be read back by the browser**.

The credential model follows, rather than reinvents, the existing repository:
provider secrets stay **platform-global** (`RAZORPAY_KEY_SECRET` /
`META_ACCESS_TOKEN` were always single platform env vars); only **public
per-hospital identifiers** are editable per tenant. A new `integration_config`
row is projected onto the **existing** `hospital_settings` runtime columns the
payment/WhatsApp engines already read, so the runtime consumes configuration
without a rewrite.

Outcome: **IMPLEMENTED + LOCALLY INTEGRATION VERIFIED** (DB 24 + Edge HTTP 15 +
unit 16 + frontend 18 all PASS) with **LIVE PROVIDER VERIFICATION UNPROVEN**
and **PRODUCTION UNPROVEN**.

## 2. Existing architecture discovered

- Razorpay secret is supplied from `Env.RAZORPAY_KEY_SECRET` (platform-global);
  `create-payment-order` / `process-refund` read it directly. Per-hospital Razorpay
  state lives only in `hospital_settings.razorpay_key_id` + `payment_enabled`.
- Meta/WhatsApp token is supplied from `Env.META_ACCESS_TOKEN` (platform-global);
  `send-whatsapp-message` reads it. Per-hospital state lives in
  `hospital_settings.meta_phone_number_id`, `meta_waba_id`, `whatsapp_number`.
- Supabase **Vault** is the established secure store (migrations 53 / 57 already
  read `vault.decrypted_secrets`). Reused — no second secret system built.
- Existing primitives reused: `getServiceClient()`, `resolveAuth()`,
  `requireRole()`, `logAuditEvent`/`write_audit_log`, `successResponse`/
  `handleErrorResponse`/`handleCors`, `withIdempotency`/`extractIdempotencyKey`,
  Zod validation, the WS-ONBOARD-2 two-boundary authorization + versioned
  optimistic-concurrency pattern.

## 3. Exact files created

- `supabase/migrations/67_integration_configuration.sql`
- `supabase/functions/integration-configuration/index.ts`
- `supabase/functions/_shared/integration_secrets.ts`
- `tests/integration/integration_configuration.test.ts` (24 tests)
- `tests/integration/integration_configuration_http.test.ts` (15 tests)
- `tests/unit/integration_secrets.test.ts` (16 tests)
- `apps/web/src/api/integrations.ts`
- `apps/web/src/routes/IntegrationConfiguration.tsx`
- `apps/web/src/routes/IntegrationConfiguration.test.tsx` (18 tests)

## 4. Exact files modified

- `supabase/functions/_shared/audit.ts` — added the 5 integration action types
  to the `AuditActionType` union.
- `supabase/functions/create-payment-order/index.ts` — Razorpay key secret now
  resolved via `getRazorpayKeySecret(db, logger)` (Vault-first, env fallback).
- `supabase/functions/process-refund/index.ts` — same Razorpay resolver.
- `supabase/functions/send-whatsapp-message/index.ts` — Meta token now resolved
  via `getMetaAccessToken(db, logger)` (Vault-first, env fallback).
- `supabase/functions/_shared/database.generated.ts` — regenerated
  (`deno task gen:types`) to register the 5 RPCs + `integration_config`.
- `apps/web/src/types/api.ts` — WS-ONBOARD-3 response-body types (+66).
- `apps/web/src/App.tsx` — route `/admin/integrations` + import.
- `apps/web/src/components/AppShell.tsx` — "Integrations" nav entry.
- `supabase/migrations/MANIFEST.sha256` — migration 67 appended via canonical
  `validate_migration_manifest.ts --update` (append-only).

## 5. Integration architecture

```
Frontend (admin)
   → integration-configuration Edge Function
       resolveAuth → requireRole(['hospital_admin','global_admin'])
       → tenant cross-check → Zod validation
       → service-role SECURITY DEFINER RPC (migration 67)
           integration_config (FORCE RLS) + project → hospital_settings
           Vault write via platform_integration_secret marker
       → audit (sanitized) → replay-safe idempotency → sanitized response
Runtime (payment / WhatsApp Edge)
   → integration_secrets resolver (Vault-first, env-fallback)
```

## 6. Razorpay architecture

Razorpay credentials are **platform-global** — confirmed from `Env.RAZORPAY_KEY_SECRET`
and the single-account payment/settlement/refund/ledger design (prompt §6/§41).
WS-ONBOARD-3 therefore does NOT introduce per-hospital merchant accounts and does
NOT touch financial logic. A hospital edits only its public `razorpay_key_id`
(`public_identifier`) and `payment_enabled` (`enabled`); the key secret is the
platform Vault secret `setura_razorpay_key_secret`, rotated by global_admin only.

## 7. WhatsApp / Meta architecture

Meta access token is **platform-global** (`Env.META_ACCESS_TOKEN` → Vault secret
`setura_meta_access_token`, global_admin rotation only). Per-hospital public
identifiers — `meta_phone_number_id` (`public_identifier`), `meta_waba_id`
(`waba_id`) and `whatsapp_number` (`contact_number`) — are edited by the hospital
admin. The WhatsApp engine, queue, worker and conversational flow are unchanged;
only the token source now goes through the resolver (env fallback preserved).

## 8. Secret-storage architecture

Supabase Vault (reused). `platform_integration_secret` stores only a stable
opaque `secret_name` + a `secret_present` presence marker + `last_rotated_at`;
it is `FORCE ROW LEVEL SECURITY` with a **service_role-only** policy. The
plaintext never lives in a normal column. The stable Vault names are
`setura_razorpay_key_secret` and `setura_meta_access_token`.

## 9. Secret write path

`rotate_secret` → Edge `resolveAuth` + `requireRole(['global_admin'])` → Zod
(provider allowlist; secret non-empty, ≤1024) → `set_integration_secret` RPC:
re-checks the caller is global_admin (else 42501), looks up the registered
`secret_name` (unregistered → P0002), upserts Vault via `vault.create_secret` /
`vault.update_secret`, flips `secret_present` and stamps `last_rotated_at`, then
audits `integration_secret_rotated` (severity critical) with NO value. Response
returns presence only.

## 10. Secret read restrictions

No frontend operation retrieves a secret. `get_integration_configuration`
returns per-hospital public identifiers + lifecycle status + platform-global
`secret_present` markers only. `resolve_integration_secret` is the ONLY Vault
read path and is service-role-only (anon/authenticated EXECUTE revoked; proven
42501 at runtime). It is never imported into or reachable from browser code.

## 11. Secret rotation

Vault upsert replaces the value; `last_rotated_at` advances. A stale credential
cannot be retrieved afterward because no read path returns any value — proven by
the HTTP suite (read-after-rotate response body and audit blob both exclude the
recognizable fake secret). Rotation is idempotency-guarded so a replay cannot
rotate twice.

## 12. Test-connection implementation

Server-side in the Edge Function. `testRazorpayConnection` / `testMetaConnection`
call the provider with the resolved credential (Basic / Bearer header) and map
the HTTP status to a **sanitized enum**
(`CONNECTED | INVALID_CREDENTIAL | UNAUTHORIZED | PROVIDER_UNAVAILABLE |
CONFIGURATION_INVALID`) via `mapHttpStatusToTestResult`. `record_integration_test_result`
persists the sanitized outcome WITHOUT bumping the version. No credential, raw
body or Authorization header crosses the boundary; no business state is mutated.

## 13. Database changes (migration 67)

- Table `integration_config` (hospital_id, provider, public_identifier, waba_id,
  contact_number, enabled, status, last_tested_at, last_test_status, version,
  timestamps, updated_by), FORCE RLS, hospital-scoped policies.
- Table `platform_integration_secret` (provider, secret_name, secret_present,
  last_rotated_at), FORCE RLS, service_role-only.
- 5 RPCs: `get_integration_configuration`, `update_integration_configuration`,
  `set_integration_secret`, `resolve_integration_secret`,
  `record_integration_test_result` — all SECURITY DEFINER, `SET search_path =
  public`, `row_security = off`.
- Optimistic-concurrency version bump; P0001 on stale, 22023 on allowlist/length
  violation, 42501 on authz.
- 5 `audit_action_types` registered.
- Per F16-04: explicit `REVOKE ... FROM PUBLIC, anon, authenticated` +
  `GRANT EXECUTE ... TO service_role` for EVERY new function.

## 14. Edge Function changes

New `integration-configuration` (modes read/update/test/rotate_secret). Three
existing runtime Edge Functions minimally rewired to the Vault-first resolver,
preserving env fallback and all platform-global behavior (public identifier and
enablement semantics untouched).

## 15. Frontend changes

`api/integrations.ts` boundary (no secret field on the metadata path);
`IntegrationConfiguration.tsx` provider-tabbed page (Razorpay / WhatsApp), per-action
`useAsyncAction`, targeted diff patch, write-only `type=password` rotate input
visible ONLY to global_admin, secret shown as PRESENCE ("Configured"/"Not
configured"), honest 409 banner; types in `types/api.ts`; route
`/admin/integrations` + nav entry, both gated to `ADMIN_ROLES`.

## 16. Authorization

Two-boundary model (prompt §18). Edge: `resolveAuth` + `requireRole`. DB: every
RPC independently re-checks actor role + tenant membership; `set/resolve`
further re-check global_admin. Route guard and nav are UX only.

## 17. Tenant isolation

`integration_config` is FORCE RLS, hospital-scoped. `update`/`record` re-check
the target hospital against the actor's membership; a doctor or a
cross-tenant admin receives SQLSTATE 42501. The `X-Hospital-ID` header is never
the boundary. Proven by the DB suite (cross-tenant + wrong-role denial) and the
HTTP suite (403 HOSPITAL_ACCESS_DENIED / ROLE_INSUFFICIENT).

## 18. Idempotency

Mutations (update/test/rotate_secret) require a UUID-v4 `Idempotency-Key`
(400 IDEMPOTENCY_KEY_REQUIRED when missing) and route through the existing
`withIdempotency`. Replay returns the stored result without re-running the RPC —
proven by a single version bump and a single audit event on replay in the HTTP
suite. Rotation replay cannot double-rotate.

## 19. Concurrency

Versioned optimistic concurrency on the `integration_config` row (locked
`FOR UPDATE`). A stale `expected_version` → P0001 → Edge `409
DB_CONCURRENCY_ERROR`. Proven: concurrent competing updates yield exactly one
winner and one conflict.

## 20. Audit

Uses the established `logAuditEvent`/`write_audit_log` primitive with the 5 new
action types (update/enabled/disabled/connection_tested/secret_rotated). Records
actor, hospital, provider, action, status and safe metadata; **never** a secret,
token, Authorization header or provider credential. Severity escalates to
critical for secret rotation.

## 21. Secret non-exposure evidence

The recognizable fake `TEST_SECRET_SHOULD_NEVER_LEAK_123456` is deliberately
stored during tests and asserted ABSENT from: the sanitized read RPC outcome,
the read HTTP response body, the update/test/rotate HTTP responses, the audit
trail blob, and the rendered frontend. It is returned ONLY through
`resolve_integration_secret` to the trusted runtime.
(All INTEGRATION/UNIT VERIFIED locally; see §23.)

## 22. Runtime compatibility

Payment/refund/WhatsApp now consume the resolver (Vault-first, env-fallback).
The integration projection writes the existing `hospital_settings` columns those
engines already read, so no engine logic changed. Regression proof:
`d16_financial_policy.test.ts` + `whatsapp_lifecycle.test.ts` — **20 PASS** —
with the local Vault cleaned so payment/WhatsApp exercise the env fallback
(pre-WS-ONBOARD-3) path.

## 23. Test results (executed this session)

- DB integration `integration_configuration.test.ts`: **24 PASS** — INTEGRATION VERIFIED.
- Edge HTTP `integration_configuration_http.test.ts`: **15 PASS** — INTEGRATION
  VERIFIED against the real local Edge Runtime (`supabase functions serve`, 29 functions).
- Unit `integration_secrets.test.ts`: **16 PASS** — UNIT VERIFIED.
- Frontend `IntegrationConfiguration.test.tsx`: **18 PASS**.

## 24. Regression results (executed this session)

- `deno task check`: clean. `deno task lint`: clean (110 files).
- `deno task fmt:check`: 0 not-formatted (183 files).
- `deno task test` (unit): **113 PASS / 0 FAIL**.
- `deno task validate:migrations`: 67 files, 0 errors, 4 pre-existing
  `[duplicate-objects]` warnings (baseline, not new).
- `deno task validate:migration-manifest`: 67/67, 0 integrity issues.
- `deno task gen:types:check`: up to date.
- `deno task check:frontend-secrets`: 0 secret hits.
- Payment/refund/WhatsApp edge regression: **20 PASS**.
- Full frontend `npx vitest run`: **479 PASS (34 files)**; `npx tsc --noEmit`: clean.

## 25. Migration / manifest status

Migration 67 is the next canonical number after WS-ONBOARD-2's 66. Migrations
65/66 were not edited. `MANIFEST.sha256` was updated append-only via the
canonical `validate_migration_manifest.ts --update`; integrity gate PASSes.

## 26. Known limitations

- Connection tests exercise the code path against **mocked/stubbed** provider
  responses locally; no real provider account was contacted.
- Per the workspace baseline: no scheduler, and the Edge Runtime container's
  `RestartPolicy=no` (F16-01) required a fresh `supabase functions serve` before
  the new function was indexed.
- Working tree is not a Git repository; verification was by direct file and
  runtime inspection, not `git diff`.

## 27. External-provider limitations

Razorpay and Meta credentials, WABA, phone-number IDs and production webhooks
are intentionally absent locally. The infrastructure is built so they can be
entered later. Mocked provider tests are NOT labeled live-provider-verified.

## 28. Explicit scope confirmation

Implemented ONLY Razorpay + Meta/WhatsApp public identifiers, enablement,
connection testing and platform-global secret rotation. Did NOT create provider
accounts, perform live payments/messages, deploy production secrets, redesign
the payment/settlement/WhatsApp engines, reopen WS-ONBOARD-1/2, or weaken
tenant isolation.

## 29. Staging status

**UNPROVEN** — nothing was pushed to or deployed on a linked remote (prompt §34).
All evidence is local.

## 30. Production status

**UNPROVEN** — no production deployment exists. Local runtime results are not
production verification.

---

## Final question (prompt §45)

Can a Global Admin create a hospital (WS-ONBOARD-1), configure its hospital
settings (WS-ONBOARD-2), then securely configure its supported Razorpay /
Meta / WhatsApp integration information (WS-ONBOARD-3) without editing SQL,
source code, or ordinary per-hospital environment variables?

**Software capability: YES** — for the fields actually implemented
(Razorpay `key_id` + enablement; Meta `phone_number_id` / `waba_id` /
`whatsapp_number` + enablement; global_admin platform-secret rotation; sanitized
connection test), a permitted admin completes the whole onboarding path from the
frontend, and the runtime consumes it via the Vault-first resolver.

**Live provider verification: NO (UNPROVEN)** — no real Razorpay/Meta account
was contacted; connection testing is proven only against mocks/stubs. This is a
distinct axis from software capability and is not claimed as verified.

---

```text
WS-ONBOARD-3 STATUS:
IMPLEMENTED (integration fields enumerated in §28); LOCALLY INTEGRATION VERIFIED

SECRET STORAGE:
Supabase Vault (reused, not duplicated); service_role-only resolve path; presence-
marker table FORCE RLS. INTEGRATION VERIFIED locally.

RAZORPAY:
Platform-global secret (env model preserved) + per-hospital public key_id +
enablement, projected onto existing hospital_settings. IMPLEMENTED + INTEGRATION
VERIFIED (config); LIVE PROVIDER UNPROVEN.

WHATSAPP / META:
Platform-global token + per-hospital phone_number_id/waba_id/whatsapp_number +
enablement, projected onto existing hospital_settings. IMPLEMENTED + INTEGRATION
VERIFIED (config); LIVE PROVIDER UNPROVEN.

DATABASE:
Migration 67: integration_config + platform_integration_secret + 5 SECURITY
DEFINER RPCs + 5 audit types; F16-04 explicit REVOKE/GRANT per function.
INTEGRATION VERIFIED locally; PRODUCTION UNPROVEN.

EDGE:
New integration-configuration (read/update/test/rotate_secret); 3 runtime
functions rewired Vault-first/env-fallback. INTEGRATION VERIFIED against real
local Edge Runtime.

FRONTEND:
api/integrations.ts + IntegrationConfiguration.tsx + types + route + nav; secret
rendered as PRESENCE only; rotate input write-only and global_admin-only.
UNIT-VERIFIED via vitest (18 PASS); full suite 479 PASS; tsc clean.

SECRET NON-EXPOSURE:
TEST_SECRET_SHOULD_NEVER_LEAK_123456 proven absent from every read/update/test/
rotate response, the audit blob and the rendered UI; returned only via the
trusted resolve path. INTEGRATION/UNIT VERIFIED locally.

AUTHORIZATION:
Two-boundary (Edge requireRole + DB actor/role re-check); set/resolve gated to
global_admin. INTEGRATION VERIFIED (42501 / 403 proven).

TENANT ISOLATION:
FORCE RLS + RPC tenant re-check; cross-tenant and wrong-role denied.
INTEGRATION VERIFIED.

IDEMPOTENCY:
Existing withIdempotency; UUID-v4 key required on mutations; replay = single
version/audit. INTEGRATION VERIFIED.

CONCURRENCY:
Versioned optimistic concurrency (row FOR UPDATE); stale → P0001 → 409.
INTEGRATION VERIFIED (one-wins/one-conflict).

AUDIT:
5 integration action types via the existing primitive; no secrets logged.
INTEGRATION VERIFIED.

TEST-CONNECTION:
Server-side, sanitized enum only, no business mutation, no credential
exfiltration. IMPLEMENTED + UNIT/INTEGRATION VERIFIED with mocks/stubs; LIVE
PROVIDER UNPROVEN.

TESTS:
DB integration 24 PASS; Edge HTTP 15 PASS; unit 16 PASS; frontend 18 PASS.

REGRESSION:
deno check/lint/fmt:check clean; unit 113 PASS; validate:migrations 0 err / 4
baseline warn; manifest 67/67 0 issues; gen:types:check current;
check:frontend-secrets 0 hits; payment+whatsapp 20 PASS; frontend 479 PASS; tsc clean.

STAGING:
UNPROVEN

PRODUCTION:
UNPROVEN

LIVE RAZORPAY:
UNPROVEN

LIVE META / WHATSAPP:
UNPROVEN

NEXT WORKSTREAM:
NOT STARTED — stop after WS-ONBOARD-3 per prompt §46.
```
