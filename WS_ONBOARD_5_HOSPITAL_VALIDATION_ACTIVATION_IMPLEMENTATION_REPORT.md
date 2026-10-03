# WS-ONBOARD-5 — Hospital Configuration Validation & Activation — Implementation Report

## 1. Executive outcome

WS-ONBOARD-5 closes the final two steps of the SETURA operator onboarding flow —
**Validate configuration → Activate hospital** — which the source proved were
never built. It adds, entirely additively:

- `hospitals.activated_at` (nullable `TIMESTAMPTZ`) — the explicit go-live marker.
- `validate_hospital_configuration(UUID, UUID)` — a read-only, service-role-only
  SECURITY DEFINER completeness checklist.
- `set_hospital_activation(UUID, UUID, BOOLEAN)` — the canonical, row-locked,
  readiness-gated activation / de-activation write.
- The `hospital-activation` Edge Function (global_admin, tenant-free, target in
  body), reusing the existing auth / idempotency / audit / response primitives.
- A `global_admin` frontend surface (list → validate → activate/de-activate).

Nothing about current runtime behavior changes for existing tenants: the column
defaults to `NULL`, and the only mutated business field is the pre-existing
operational `hospitals.is_active` flag.

## 2. Gap discovered (live + source evidence, not a stale report)

Inspected the current source rather than the (stale) readiness report:

- `provision_hospital` (migration 65) does **not** set `hospitals.is_active`; every
  tenant is born with the column default `is_active = true`.
- `is_active` is system-managed and rejected by the WS-ONBOARD-2 configuration
  allowlist (migration 66); **no surface ever flips it**. Its only real consumer
  is the operational `active_hospitals` count (migration 47). It is **not** a
  booking gate (availability is governed by `doctor_schedules` + feature flags).
- There is **no activation timestamp** anywhere, so the go-live review could not
  be recorded.
- Consequently the last two boxes of the owner-stated flow (`Validate
  configuration → Activate hospital`) had no implementation.

Because `is_active` is only an operational flag today, adding validation +
activation introduces real capability **without inventing booking/product policy**.

## 3. Scope

Migration 71 (one additive column + two SECURITY DEFINER RPCs + F16-04 grants +
audit action-type registration), the `hospital-activation` Edge Function, the
frontend API wrapper / route / types / nav+route registration, and DB + HTTP +
frontend tests.

## 4. Non-scope (deliberately NOT done)

- Gating the booking / availability engine on `is_active` — a new product rule.
- Treating live Razorpay / Meta credentials as a **blocking** readiness check —
  integration/settings presence is reported **informationally** only.
- Any change to WS-ONBOARD-1..4, WS-SEC-1, G-03..G-11, C2/C2b, G7-13, G7-16, or
  the blocked WS-OPS-1 (their files, including migration 70, were left untouched).
- No production/staging deployment, secrets or provider validation.

## 5. Architecture fit

Follows the canonical SETURA shape (AGENTS.md §6):

```
HTTP → resolveAuth → requireRole(global_admin) → validate body
  ├─ read  mode : validate_hospital_configuration RPC (read-only checklist)
  └─ write mode : existing api_idempotency_keys registry
                  → set_hospital_activation RPC (row-locked, readiness-gated)
                  → logAuditEvent (mutations only)
```

Reuses `getServiceClient`, `resolveAuth`, `requireRole`, `handleCors`,
`parseBody`, `extractIdempotencyKey`, `withIdempotency`, `logAuditEvent`,
`successResponse`, `handleErrorResponse` and the `SeturError` hierarchy
unchanged. No parallel auth / idempotency / audit / tenant system was created.
The frontend reuses `callFunction`, `useAsyncAction` (mints + reuses a stable
idempotency key), `fetchActingHospitalContext` (transport-only acting id, reused
from the G-08 / WS-ONBOARD-1 pattern) and `describeError`.

## 6. Files changed

New:
- `supabase/migrations/71_ws_onboard_5_hospital_validation_activation.sql`
- `supabase/functions/hospital-activation/index.ts`
- `apps/web/src/api/activation.ts`
- `apps/web/src/api/activation.test.ts`
- `apps/web/src/routes/HospitalActivation.tsx`
- `apps/web/src/routes/HospitalActivation.test.tsx`
- `tests/integration/hospital_activation.test.ts`
- `tests/integration/hospital_activation_http.test.ts`

Modified (all additive; verified via `git diff`):
- `supabase/functions/_shared/audit.ts` — `hospital_activation` added to `AuditActionType`
- `supabase/functions/_shared/database.generated.ts` — regenerated (`gen:types:check` PASS)
- `supabase/migrations/MANIFEST.sha256` — `+2 / -0` (migration 71 hash; validate PASS)
- `apps/web/src/types/api.ts` — 5 activation interfaces
- `apps/web/src/App.tsx` — `/admin/activation` route under `GLOBAL_ADMIN_ROLES`
- `apps/web/src/components/AppShell.tsx` — global_admin nav entry

Unrelated pre-existing uncommitted files (WS-OPS-1 / WS-SEC-1, incl. migration 70,
`deno.json`, soak artifacts) were **not** created or modified by this workstream.

## 7. Database changes

- `ALTER TABLE public.hospitals ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;`
- `validate_hospital_configuration` (STABLE, SECURITY DEFINER,
  `SET search_path = public`, `row_security = off`): refuses non-global_admin /
  NULL actor (42501) and missing/soft-deleted tenant (22023); returns
  `{ok, hospital_id, ready, checks[]}`. Blocking checks:
  `has_active_department` / `has_active_doctor` / `has_active_schedule`;
  informational: `settings_present`. `ready = dept AND doctor AND schedule`.
- `set_hospital_activation` (VOLATILE, SECURITY DEFINER): re-verifies actor
  global_admin (42501); locks the target row `FOR UPDATE`; activation **refuses
  (22023)** unless validation `ready`; sets `is_active = true` and
  `activated_at = coalesce(activated_at, now())`; already-active → reason
  `already_active` (no-op); de-activation flips `is_active = false` with no
  readiness gate. Returns `{ok, reason, hospital_id, is_active, activated_at}`.
- Registers audit action type `hospital_activation` (category `system`,
  severity `high`) `ON CONFLICT DO NOTHING`.

## 8. Security

- **Two-boundary authorization**: the Edge layer gates on the JWT-resolved
  `global_admin` role; each RPC independently re-checks the actor in
  `user_roles` and raises 42501. `auth.uid()` is NULL under the service-role JWT,
  so the JWT actor id is passed explicitly and re-verified server-side.
- **F16-04 (explicit REVOKE on new SECURITY DEFINER functions)**: both functions
  carry their own `REVOKE ALL ... FROM PUBLIC / anon / authenticated` +
  `GRANT EXECUTE ... TO service_role`. Proven against the live catalog:

  | function | anon EXECUTE | authenticated EXECUTE | service_role EXECUTE |
  |---|---|---|---|
  | `validate_hospital_configuration` | f | f | t |
  | `set_hospital_activation` | f | f | t |
- **Tenancy**: this is a cross-tenant global action; the target id is body-supplied
  and never trusted for *who acts*; only the actor's global_admin membership is
  authoritative. No client-side hospital trust.
- No secret/credential is read, written, returned or logged.

## 9. Idempotency

- `validate` is a read: no Idempotency-Key required or accepted.
- `activate` / `deactivate` require an `Idempotency-Key`
  (`extractIdempotencyKey(req, true)` → missing key is a 400), replayed through
  the existing `withIdempotency` / `api_idempotency_keys` registry (no new
  mechanism). Flipping `is_active` is additionally naturally idempotent
  (already-active → `already_active` no-op). The HTTP suite proves a replayed key
  returns the stored result and adds **no** second audit event.

## 10. Auditability

Mutations log one `hospital_activation` audit event **inside** the idempotency
handler (so a replay never double-records), capturing actor, hospital, entity,
intent (`oldData.mode`) and resulting state (`newData.{isActive,reason,activatedAt}`)
— no secrets. Reads are never audited. The DB row (`is_active`) stays the source
of truth; audit is not a second business-state store.

## 11. Tests (exact commands + results, live local stack)

| Command | Result |
|---|---|
| `deno test .../hospital_activation.test.ts` (DB/RPC, live local stack) | **12 passed / 0 failed** |
| `deno test .../hospital_activation_http.test.ts` (Edge over real HTTP) | **10 passed / 0 failed** |
| `deno test privilege_isolation + hospital_provisioning + hospital_activation` | **48 passed / 0 failed** |
| `npx vitest run` (frontend, includes 11 api + 8 route new tests) | **531 passed / 37 files / 0 failed** |

The DB suite covers: privilege denial (anon/authenticated "permission denied"),
non-global_admin 42501, NULL actor 42501, missing tenant 22023, not-ready /
ready checklist, incomplete-refusal-does-not-flip, activate flips `is_active` +
`activated_at`, re-activate no-op, de-activate clears. The HTTP suite covers:
validate (ready/not-ready) 200 reads, activate 200 + real write + audit==1,
idempotent replay (no double audit), missing-key 400, incomplete 422,
hospital_admin 403 (write + read), unauthenticated 401/403.

## 12. Runtime evidence (local only)

- Edge Runtime container confirmed `Up`; `hospital-activation` endpoint returned
  401 (registered/reached) — not 404 — for an unauthenticated probe.
- Migration 71 applied to the live local DB; both RPCs' catalog ACL and the audit
  action type confirmed present (§8 table).
- All HTTP assertions executed against the live local runtime (real GoTrue
  password-grant JWTs, real `api_idempotency_keys`, real `audit_logs`).
- This is **RUNTIME VERIFIED (local)** only.

## 13. Regression

| Gate | Result |
|---|---|
| `deno fmt --check` | exit 0 (new test file reformatted) |
| `deno lint` | exit 0 (119 files) |
| `deno check` (functions + tests) | exit 0 |
| `deno task validate:migrations` | 71 files, **0 errors**, 6 warnings |
| `deno task validate:migration-manifest` | exit 0 |
| `deno task gen:types:check` | exit 0 |
| `deno task test` (unit) | **113 passed / 0 failed** |
| privilege + provisioning + activation DB | **48 passed / 0 failed** |
| `npx tsc --noEmit` (frontend) | exit 0 |
| `npx vitest run` (frontend full) | **531 passed / 0 failed** |

The 6 `validate:migrations` warnings are **all pre-existing**: the 4 documented
`[duplicate-objects]` baseline warnings (migrations 20/22/47) and 2
`[rollback-risk]` TRUNCATE warnings in migration **70** (closed WS-SEC-1).
**Migration 71 introduces zero new warnings.**

## 14. Known limitations (honest)

- Validation is a completeness checklist over a few canonical facts (department /
  doctor / schedule / settings); it is not an exhaustive operational audit.
- `is_active` remains a non-blocking operational flag; nothing in the booking /
  availability runtime consumes it, so "activate" records go-live intent and the
  flag state but does not by itself open the booking gate (that was never wired to
  `is_active`, and changing that would be a product decision, out of scope).
- Integration credential presence is informational only (real credentials arrive
  later at pilot time).

## 15. Staging status

`NOT VERIFIED` — no staging environment was exercised.

## 16. Production status

`UNPROVEN / NOT VERIFIED` — no production deployment, secrets, scheduler or
provider account exists or was touched.

## 17. Definition of Done

| Requirement | Status | Evidence |
|---|---|---|
| Activation surface exists (validate + activate) | IMPLEMENTED | migration 71 + Edge fn |
| Reuses existing auth/idempotency/audit/tenant primitives | IMPLEMENTED | §5 |
| Additive, no historical migration edited | INTEGRATION VERIFIED | `git diff` +2/-0, manifest PASS |
| F16-04 explicit REVOKE, service-role-only | RUNTIME VERIFIED (local) | catalog ACL table §8 |
| Two-boundary authorization (Edge + RPC 42501) | INTEGRATION VERIFIED | DB + HTTP suites |
| Readiness gate refuses incomplete (22023/422) | INTEGRATION VERIFIED | DB + HTTP suites |
| Idempotent replay, no double audit | INTEGRATION VERIFIED | HTTP suite |
| Audit event lands exactly once | INTEGRATION VERIFIED | HTTP suite (audit==1) |
| DB integration tests green on live local stack | INTEGRATION VERIFIED | 12/12 |
| HTTP Edge tests green on live local runtime | RUNTIME VERIFIED (local) | 10/10 |
| Frontend tests green | UNIT VERIFIED | 19 new, 531 total |
| Static + migration + unit + regression gates green | STATICALLY + UNIT VERIFIED | §13 |
| Staging verified | NOT VERIFIED | no staging |
| Production verified | UNPROVEN | no production |

## 18. Final status

```
IMPLEMENTED — CLOSED LOCALLY
```

Local evidence (live local DB + Edge Runtime + frontend suites) supports closure
for this workstream at the local tier. This is **not** a claim of staging or
production readiness, nor that SETURA as a whole is production-ready.
