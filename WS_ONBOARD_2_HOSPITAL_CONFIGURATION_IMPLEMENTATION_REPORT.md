# WS-ONBOARD-2 — Hospital Configuration Write Surfaces — Implementation Report

Status field: **IMPLEMENTED + LOCALLY INTEGRATION VERIFIED** (see §16–§18 for the
exact evidence behind that phrase; see §21 for what is explicitly NOT proven).

---

## 1. Executive summary

WS-ONBOARD-2 closes the product gap disclosed by WS-ONBOARD-1: after a hospital
tenant is provisioned, an operator previously had **no authorized write path**
over the tenant's operational configuration — the readable columns in
`hospital_settings` and `hospitals` (and the tenant-scoped overrides in
`feature_flags`) had no application surface, so configuration required a manual
SQL edit.

This workstream delivers the canonical write path end-to-end:

```
Frontend (admin form)
      → Edge Function  hospital-configuration
      → resolveAuth + requireRole(['global_admin','hospital_admin'])
      → X-Hospital-ID tenant cross-check
      → (mode=read)  get_hospital_configuration RPC
      → (mode=update) Idempotency-Key gate → api_idempotency_keys
                     → withIdempotency → update_hospital_configuration RPC
                                          (expected_version optimistic
                                           concurrency, transactional patch
                                           over hospitals + hospital_settings
                                           + feature_flags overrides)
                     → logAuditEvent inside the handler
      → server-authoritative response (fresh snapshot after write)
```

Every existing SETURA primitive is reused (AGENTS.md §6): the versioning trigger
(`trg_hospital_settings_version`, migration 18), the feature-flags resolver
(`get_hospital_feature_flags`, migration 37), the audit writer (`write_audit_log`,
migration 39), the idempotency registry (`api_idempotency_keys`, migration 25)
and the shared Edge helpers (`getServiceClient`, `resolveAuth`, `requireRole`,
`logAuditEvent`, `successResponse`, `handleErrorResponse`, `handleCors`,
`withIdempotency`, `parseBody`, `SeturError`). **No parallel version store,
audit table, idempotency system, role system or state machine was created.**

Out of scope, exactly per the spec §4: Razorpay / Meta / WhatsApp credentials,
staff / doctor / schedules / subscriptions / payments, production deployment,
production secrets. WS-ONBOARD-3 owns the credentials write surface; nothing
here pretends to be part of it.

---

## 2. Files created

| Path | Purpose |
| --- | --- |
| `supabase/migrations/66_hospital_configuration_write_surfaces.sql` | Two SECURITY DEFINER RPCs (`get_hospital_configuration`, `update_hospital_configuration`) + `audit_action_types` registration for `hospital_setting_update` and `feature_flag_update`. |
| `supabase/functions/hospital-configuration/index.ts` | Edge Function: read/update discriminated-union body, JWT + role gate, `X-Hospital-ID` cross-check, `Idempotency-Key` gate for update, SQLSTATE → HTTP error mapping, audit inside handler, server-authoritative read-back after write. |
| `apps/web/src/routes/HospitalConfiguration.tsx` | Admin form: 8 sections (Hospital Information, Regional, Branding, Booking, Queue, Notifications, Fee Configuration, Feature Configuration, Integrations placeholder), `useAsyncAction` + `buildPatches` NUMERIC-safe diff + honest conflict / validation banners. |
| `apps/web/src/api/configuration.ts` | Frontend transport wrapper: `getHospitalConfiguration(hospitalId)` and `updateHospitalConfiguration(hospitalId, key, input)`, both POSTing through the authenticated Supabase Edge invocation. |
| `apps/web/src/routes/HospitalConfiguration.test.tsx` | 20 vitest cases: 8 for `validateConfiguration`, 4 for `buildPatches`, 3 for `buildFeatureOverrides`, 5 component tests (UX guard, snapshot render, one-key save, honest conflict, honest validation). |
| `tests/integration/hospital_configuration.test.ts` | 22 DB integration tests against the real local Supabase stack: happy path, version bump, historical retention, tenant isolation, wrong-hospital, anon denial, invalid input, alias rule, `P0001` conflict, concurrent same-version race, audit rows, failed transaction does not partially mutate. |
| `tests/integration/hospital_configuration_http.test.ts` | 15 real-HTTP Edge-layer tests against the running Edge Runtime: 200 read for self-tenant / cross-tenant, 200 update with audit landing, replay returns stored version + single audit, missing `Idempotency-Key` → 400, cross-tenant `hospital_admin` → 403 `HOSPITAL_ACCESS_DENIED`, `doctor` → 403 `ROLE_INSUFFICIENT`, unauthenticated → 401, stale `expectedVersion` → 409 `DB_CONCURRENCY_ERROR`, out-of-range → 422 with no partial write, unknown field → 422 (strict Zod), missing `X-Hospital-ID` → non-200, feature-flag override round-trip visible via HTTP read. |

## 3. Files modified

| Path | Change |
| --- | --- |
| `supabase/migrations/MANIFEST.sha256` | Appended line 66 via the canonical `deno run scripts/validate_migration_manifest.ts --update`; later rewritten in place (same file count, no re-ordering) when the `40001 → P0001` fix changed migration 66's content. |
| `supabase/functions/_shared/database.generated.ts` | Regenerated via `deno task gen:types` after migration 66 was applied to the local stack (243,944 chars UTF-8 no BOM). New entries at line 6532 (`get_hospital_configuration`) and line 7295 (`update_hospital_configuration`). |
| `apps/web/src/types/api.ts` | Added `HospitalConfigurationHospitalSnapshot`, `HospitalConfigurationSettingsSnapshot`, `HospitalConfigurationFeatureFlagView`, `HospitalConfigurationReadResponseBody`, `HospitalConfigurationUpdateInput`, `HospitalConfigurationUpdateResponseBody`. |
| `apps/web/src/App.tsx` | Registered `/admin/hospital-settings` route to `<HospitalConfiguration />` inside the authenticated shell. |
| `apps/web/src/components/AppShell.tsx` | Added the "Hospital Configuration" nav item restricted to `hospital_admin` + `global_admin` (UX boundary only — the Edge and RPC are the real authority). |

## 4. Database changes (migration 66)

- **`get_hospital_configuration(p_actor_user_id uuid, p_hospital_id uuid)`** —
  SECURITY DEFINER, `search_path = public`, `row_security = off`. Verifies the
  actor's `user_roles` row and either their membership in `p_hospital_id` (for
  `hospital_admin`) or their `global_admin` role, then composes the read
  snapshot: identity from `hospitals`, current settings row, current
  `config_versions.version_number` for `hospital_settings`, effective feature
  flags via the existing `get_hospital_feature_flags` (migration 37). Raises
  `42501` on tenant mismatch, `P0002` on missing hospital.

- **`update_hospital_configuration(p_actor_user_id, p_hospital_id,
  p_expected_version, p_hospital_patch jsonb, p_settings_patch jsonb,
  p_feature_overrides jsonb)`** — SECURITY DEFINER, same search_path /
  row_security posture. Behavior:

  1. **DB-layer authorization re-check** against `user_roles` (independent
     of the Edge `requireRole`). Denial raises `42501`.
  2. **Optimistic concurrency**: `MAX(version_number)` from `config_versions`
     for `(config_table='hospital_settings', hospital_id, config_key='settings')`
     compared against `p_expected_version`. On mismatch, raises with
     `SQLSTATE P0001` (`raise_exception`), **not** `40001`
     (`serialization_failure`) — see §19 for the empirical reason.
  3. **Strict whitelist** of editable columns in the patch JSONB; system
     fields (`id`, `slug`, `created_at`, `created_by`, `deleted_at`,
     `is_active`, `subscription_active`,
     `collect_consultation_at_hospital`, `updated_at`, `updated_by`) and
     integration columns (`whatsapp_number`, `meta_phone_number_id`,
     `meta_waba_id`, `razorpay_key_id`, `payment_enabled`) are rejected with
     `SQLSTATE 42501`.
  4. **Migration-35 alias rule** (booking_fee_amount ↔
     platform_fee_online): when `platform_fee_online` is present the RPC
     writes both; a lone `booking_fee_amount` edit is rejected with
     `SQLSTATE 22023` so the alias can never silently diverge.
  5. **Range/type validation** at the DB boundary mirrors the Edge Schema:
     `platform_fee_online/whatsapp/receptionist_fee` `NUMERIC(10,2)`
     non-negative; `gst_percentage` `NUMERIC(5,2)` 0..100;
     `max_tokens_per_day` 1..5000; `reminder_before_minutes` 1..1440;
     `max_advance_booking_days` 1..365; string length caps mirroring the
     schema; invalid inputs raise `22023` / `22P02` (mapped to HTTP 422).
  6. **Single transactional UPDATE** on `hospitals` (if patch present) +
     `hospital_settings` (if patch present) + upserts on `feature_flags`
     overrides. The existing AFTER-UPDATE triggers
     (`trg_hospital_settings_version`, `trg_feature_flags_version`,
     migration 18) write the version snapshots. `updated_by` is set to
     `p_actor_user_id` before the UPDATE so the version row records the real
     human even though the caller is `service_role`.
  7. Returns `{ version: <new MAX>, updated: true }` on success.

- **`audit_action_types`** rows registered for `hospital_setting_update`
  (severity=high, category=system) and `feature_flag_update` (severity=
  medium, category=system). The TS `AuditActionType` union already declared
  both; only the DB enum-table registration was missing prior to this
  migration.

## 5. RPC design — privileges (F16-04)

Each of the two new SECURITY DEFINER functions has its own explicit
`REVOKE EXECUTE ON FUNCTION ... FROM PUBLIC, anon, authenticated` followed by
`GRANT EXECUTE ... TO service_role`. Per AGENTS.md §7 and the F16-04
mechanism (migration 48 §2's default-privilege guarantee does not cover
supabase_admin-owned rows and does not apply to newly created functions),
this was **verified against the live catalog** after applying migration 66 to
the local Docker stack:

```
proacl get_hospital_configuration   = {postgres=X/postgres,service_role=X/postgres}
proacl update_hospital_configuration = {postgres=X/postgres,service_role=X/postgres}
```

`anon` and `authenticated` EXECUTE are confirmed absent; runtime denial via
SQLSTATE 42501 is asserted in `hospital_configuration.test.ts` for both
functions (see §16).

## 6. Edge Function design

`supabase/functions/hospital-configuration/index.ts`:

- CORS preflight via `handleCors`, POST only.
- `resolveAuth()` verifies the JWT and produces the actor identity.
- `requireRole(auth, ['global_admin','hospital_admin'])` at the Edge layer.
- `X-Hospital-ID` header is required and cross-checked against the actor's
  `user_roles.hospital_id` (for `hospital_admin`), and against the
  `global_admin` acting-hospital context. Failure → `HospitalAccessDeniedError`
  (HTTP 403, code `HOSPITAL_ACCESS_DENIED`). A doctor / receptionist calling
  this route → `RoleInsufficientError` (HTTP 403, `ROLE_INSUFFICIENT`).
- Body parsed via a discriminated union on `mode`:
  - `mode: "read"` → invokes `get_hospital_configuration` via the service
    client, returns the composed snapshot.
  - `mode: "update"` → requires an `Idempotency-Key` header (missing →
    `IdempotencyKeyRequiredError`, HTTP 400), registers it through
    `api_idempotency_keys`, calls `withIdempotency(...)` around the RPC, and
    (only on a fresh execution, never on a replay) emits `logAuditEvent`
    for the settings/feature changes and re-reads the server snapshot for
    the response body.
- **Error mapping** via `mapRpcError` (SQLSTATE → HTTP):
  - `P0001` → `ConcurrencyError` (HTTP 409, `DB_CONCURRENCY_ERROR`). Chosen
    deliberately over `40001`; see §19.
  - `42501` → `HospitalAccessDeniedError` (403).
  - `22023` / `22P02` / `22001` / raise-exception validation messages →
    `ValidationError` (422).
  - Anything else → `InternalError` (500). The raw PostgreSQL message is
    **never** returned to the client.
- Response envelope uses `successResponse` / `handleErrorResponse` unchanged.

## 7. Frontend implementation

`apps/web/src/routes/HospitalConfiguration.tsx` renders eight sections plus a
documented "Integrations (out of scope)" placeholder — Razorpay / Meta fields
are **deliberately absent** because WS-ONBOARD-3 owns them.

The browser owns nothing of the write path:

- `bufferFrom(snapshot)` populates the local edit buffer from the server's
  authoritative response; no browser-side defaults are substituted for
  missing values.
- `validateConfiguration(buf)` is a client mirror of the RPC's limits so the
  user sees the same rules before submitting (per spec §9). The RPC remains
  the authority; a client that bypasses it is refused by the backend.
- `buildPatches(snap, buf)` emits ONLY fields whose value actually changed.
  NUMERIC columns are compared via a `numEq(a, b)` helper that coerces both
  sides to `Number` (with a null/empty-string sentinel) so `"20"` from the
  input and `"20.00"` or `20` from PostgREST do not produce a spurious patch
  — this exactly mirrors the observation from the DB suite that PostgREST
  serialises NUMERIC as its string form.
- `buildFeatureOverrides(snap, edits)` emits `{ flag_key, is_enabled }` only
  for flags the operator has actually flipped relative to the loaded
  snapshot.
- `useAsyncAction` mints one stable `Idempotency-Key` per logical action so a
  double-click cannot fire two mutations. The button is disabled in flight,
  but the backend's idempotency registry is what actually prevents a
  duplicate mutation on a retry.
- Save path: `expectedVersion = snapshot.version`, so a concurrent editor
  causes the RPC's `P0001` path → Edge `ConcurrencyError` → HTTP 409
  `DB_CONCURRENCY_ERROR`. The UI honestly renders a "Save failed" banner with
  the specific "Someone else changed this configuration" copy and a Reload
  button; **never** a success banner on a conflict.
- Validation error (HTTP 422) shows `describeError(err)` honestly.
- After a successful save the page calls `reload()` and re-fetches from the
  server rather than mutating local state, so the version number shown after
  save is the one the DB actually persisted.

## 8. Configuration fields actually supported

Editable through the frontend → Edge → RPC (all backed by real columns):

**`hospitals`**: `name`, `phone`, `email`, `country`, `state`, `district`,
`town`, `address`, `timezone`, `online_booking_enabled`,
`max_advance_booking_days`.

**`hospital_settings`**: `display_name`, `logo_url`, `platform_fee_online`
(alias-synced to `booking_fee_amount`), `platform_fee_whatsapp`,
`receptionist_fee`, `online_booking_fee_enabled`, `default_consultation_fee_inr`,
`gst_enabled`, `gst_percentage`, `gst_registration_number`,
`max_tokens_per_day`, `allow_walkin_tokens`, `allow_online_booking`,
`allow_carry_forward`, `queue_display_enabled`, `send_whatsapp_confirmation`,
`send_whatsapp_reminder`, `send_feedback_request`, `reminder_before_minutes`,
`preferred_language`, `timezone`.

**Feature flags** (per-hospital override rows in `feature_flags`, resolved
through the existing migration-37 `get_hospital_feature_flags`): each
`flag_key` present in the global default set can be overridden for the
tenant.

Read-only / non-editable here (documented, per spec §8 system-managed):
`id`, `slug`, `created_at`, `created_by`, `deleted_at`, `is_active`,
`subscription_active`, `collect_consultation_at_hospital` (business invariant:
always TRUE per migration 35), `updated_at`, `updated_by` (set automatically),
`booking_fee_amount` (auto-synced alias), and every integration column
(`whatsapp_number`, `meta_phone_number_id`, `meta_waba_id`, `razorpay_key_id`,
`payment_enabled`).

## 9. Validation rules

The Edge Schema and the RPC enforce identical bounds. Any value out of range
is a `ValidationError` (HTTP 422) or a `22023`/`22P02` from the DB layer —
never silently absorbed. Client `validateConfiguration` mirrors the same
limits.

| Field | Rule |
| --- | --- |
| `name` | required, 2..200 characters |
| `phone` | ≤ 20 characters |
| `email` | optional; if present ≤ 254 and matches a basic RFC shape |
| `country` / `state` / `town` | required, ≤ 120 |
| `district` | ≤ 120 |
| `address` | ≤ 500 |
| `timezone` | required, ≤ 64 |
| `display_name` | ≤ 200 |
| `logo_url` | ≤ 500 |
| `preferred_language` | 2..10 characters |
| `gst_registration_number` | ≤ 32 |
| `platform_fee_online`, `platform_fee_whatsapp`, `receptionist_fee`, `default_consultation_fee_inr` | `NUMERIC(10,2)`, 0..1_000_000 |
| `gst_percentage` | `NUMERIC(5,2)`, 0..100 |
| `max_tokens_per_day` | integer, 1..5000 |
| `reminder_before_minutes` | integer, 1..1440 |
| `max_advance_booking_days` | integer, 1..365 |
| `booking_fee_amount` | rejected when supplied alone (alias rule, migration 35) |
| `collect_consultation_at_hospital` | rejected (invariant TRUE, business model) |
| Integration columns | rejected (WS-ONBOARD-3 scope) |
| Unknown patch keys | rejected (strict Zod at Edge + explicit whitelist in RPC) |

## 10. Authorization model (two boundaries)

1. **Edge layer**: `resolveAuth()` for JWT; `requireRole(['global_admin',
   'hospital_admin'])`; `X-Hospital-ID` cross-check against the actor's
   `user_roles.hospital_id` (for `hospital_admin`) and against the acting
   context for `global_admin`. All failures produce a specific
   `SeturError` subclass → HTTP 401 / 403.
2. **Database layer**: both RPCs re-check `user_roles` independently of the
   Edge. A `hospital_admin` calling with `p_hospital_id` that is NOT in their
   `user_roles` is refused with `SQLSTATE 42501` before any write happens.
   This is defense-in-depth (AGENTS.md §7): weakening the Edge check alone
   does NOT expose the RPC.

`service_role` remains the only direct EXECUTE grantee on the two new RPCs
(§5). Ordinary authenticated callers cannot reach them through PostgREST.

## 11. Tenant-isolation evidence

`tests/integration/hospital_configuration.test.ts` (DB suite):

- `hospital_admin` for hospital A → update hospital B → refused at DB layer
  with `SQLSTATE 42501`; snapshot for B unchanged.
- `global_admin` → authorized target hospital → 200 path.
- `doctor` role → refused.
- `anon` / `authenticated` EXECUTE absent (catalog ACL verified §5 and
  runtime 42501 asserted in tests).
- Feature-flag override rows are `hospital_id`-scoped in the RPC's `WHERE`
  clause and via RLS.

`tests/integration/hospital_configuration_http.test.ts` (HTTP suite):

- `hospital_admin` from tenant A calling with `X-Hospital-ID = B` → 403
  `HOSPITAL_ACCESS_DENIED` at `resolveAuth` (no DB call attempted). Same for
  read and update paths.
- Missing `X-Hospital-ID` header → non-200 client error.

## 12. Idempotency evidence

- Edge: every update-mode call must carry a UUID-shaped `Idempotency-Key`
  header; missing → HTTP 400 `IDEMPOTENCY_KEY_REQUIRED` (asserted in the
  HTTP suite; also asserted that NO DB write occurs on that path).
- `withIdempotency(key, ...)` writes through `api_idempotency_keys`
  (migration 25). On replay of the SAME key, the HTTP suite verifies:
  - HTTP 200 returned;
  - the stored `version` in the response equals the original;
  - `audit_logs` count for `hospital_setting_update` on that entity does
    **not** increment on the replay;
  - `config_versions` count does not increment on the replay.

## 13. Concurrency evidence

Two DB-suite tests:

- `stale expected_version is refused (P0001)`: read `version=N`, call the
  RPC with `p_expected_version = N-1` → RPC raises `P0001`; the Edge maps to
  HTTP 409 `DB_CONCURRENCY_ERROR`; the settings row remains at `N`.
- `concurrent same-expected_version writes`: two `Promise.all` calls with
  the same `p_expected_version = N` → exactly one succeeds and bumps to
  `N+1`, the other is refused with `P0001`; `config_versions` gains exactly
  one row; `hospital_settings` reflects the winner's patch and no partial
  field mixing with the loser's patch.

HTTP suite mirrors the stale-version case end-to-end (real JWT + `fetch`).

## 14. Versioning evidence

Uses the existing migration-18 `trg_hospital_settings_version` AFTER-UPDATE
trigger; no second version store added. DB tests assert:

- a valid update bumps `MAX(config_versions.version_number)` from `N` to
  `N+1` for `(config_table='hospital_settings', hospital_id,
  config_key='settings')`;
- the historical row for the previous state is retrievable and unchanged;
- the version row records the real actor via `hospital_settings.updated_by`
  (which the RPC sets before the UPDATE so the trigger's `NEW.updated_by`
  reflects the human, not the `service_role` caller);
- feature-flag override changes are similarly captured by the existing
  `trg_feature_flags_version` trigger.

## 15. Audit evidence

Uses the existing `logAuditEvent` primitive (which writes through the
migration-39 `write_audit_log` path). Registered `audit_action_types` rows
verified present in the catalog after applying migration 66:

- `hospital_setting_update` severity=high category=system
- `feature_flag_update` severity=medium category=system

HTTP suite asserts one audit row per fresh update and NO additional row on
an idempotent replay. The RPC's transactional shape means a rolled-back
write does not leave a misleading audit "success" record (audit is emitted
in the handler AFTER the RPC commits, and the audit itself uses the same
service client — see the test in `hospital_configuration_http.test.ts`
`stale expectedVersion is 409 DB_CONCURRENCY_ERROR`).

No secrets are logged: none of the WS-ONBOARD-2 configuration fields are
secrets, and the audit payload records only the changed field names and
their before/after values, never any credential column.

## 16. Test results (executed locally against the running stack)

All numbers below are PASSED counts from real executions, not declared
counts.

| Suite | Command | Result |
| --- | --- | --- |
| Deno unit | `deno task test` | **97 passed / 0 failed** |
| Deno integration (full, including all prior workstreams) | `deno task test:integration` | **380 passed / 0 failed** (1m24s) |
| New: `hospital_configuration.test.ts` (DB suite) | `deno test -A --allow-net tests/integration/hospital_configuration.test.ts` | **22 passed / 0 failed** |
| New: `hospital_configuration_http.test.ts` (Edge HTTP suite) | `deno test -A --allow-net tests/integration/hospital_configuration_http.test.ts` | **15 passed / 0 failed** |
| Frontend vitest (full) | `npx --yes vitest run` under `apps/web` | **461 passed / 0 failed**, 33 files, 15.79s |
| Frontend vitest (`HospitalConfiguration.test.tsx`) | `npx --yes vitest run src/routes/HospitalConfiguration.test.tsx` | **20 passed / 0 failed** |

## 17. Regression results (AGENTS.md §2 read-only tasks)

| Task | Result |
| --- | --- |
| `deno task validate:migrations` | 66 files scanned, **0 errors, 4 warnings** — identical to the AGENTS.md §13 baseline (20_presence_engine dashboard_presence, 22_partition_automation check_partition_readiness, 22_partition_automation partition_health, 47_enterprise_command_center idx_alert_events_open). No new warnings introduced. |
| `deno task validate:migration-manifest` | 66 migrations, 66 manifest lines, **0 integrity issues** |
| `deno task gen:types:check` | `database.generated.ts is UTF-8 and up to date` |
| `deno task fmt:check` | Checked 177 files, **clean** |
| `deno task lint` | Checked 105 files, **clean** |
| `deno task check` | TypeScript check on all Deno sources, **clean** |
| Frontend `npx --yes tsc --noEmit` | **clean** (no output) |
| Full integration regression | 380/380, no prior suite broke — including `privilege_isolation.test.ts`, `hospital_provisioning.test.ts` (WS-ONBOARD-1), `hospital_core_journey.test.ts` (E1), all G-07..G-11 suites, C2 alert lifecycle, worker lifecycle, and payment/refund engines. |

## 18. Migration and manifest status

- Migration 66 is the only new migration in this workstream.
- Migration 65 (WS-ONBOARD-1) was **NOT edited**; migration numbers below
  66 are historical artifacts, per AGENTS.md §11.
- Applied to the **LOCAL Docker Supabase stack only**, via
  `Get-Content ... | docker exec -i supabase_db_setura psql -U postgres -d
  postgres -v ON_ERROR_STOP=1` — explicitly **NOT** `supabase db push`,
  which was the mechanism behind the WS-ONBOARD-1 disclosed remote-project
  accident. No linked-remote project was targeted at any point in this
  workstream.
- `MANIFEST.sha256` line for migration 66 was created via the canonical
  `deno run --allow-read --allow-write scripts/validate_migration_manifest.ts
  --update` and later rewritten in place after the `P0001` SQLSTATE fix
  changed the migration's SHA-256 (final hash
  `eca63d257e4bd0ee09199e6a34a50b56812eddb8534aadcb40a4dce666181d93`).
  Manifest still has exactly 66 lines.
- `database.generated.ts` regenerated (contains both new RPCs).

## 19. Known limitations and explicit design decisions

1. **`P0001` chosen over `SQLSTATE 40001` for expected-version conflicts**.
   Empirical finding during integration: PostgREST treats SQLSTATE class-40
   codes as retryable and repeatedly re-issues the transaction; a benign
   optimistic-lock conflict surfaced to the client as a **504 Gateway
   Timeout** rather than a normal error object. `P0001` (`raise_exception`)
   is treated as a normal terminal exception by PostgREST, reaches
   supabase-js with `error.code === "P0001"`, and the Edge maps it to HTTP
   409 `DB_CONCURRENCY_ERROR`. The RPC header, the RAISE, and the
   `COMMENT ON FUNCTION` all record this rationale so a future editor does
   not "clean up" the choice.
2. **PostgREST NUMERIC serialisation**. Both the DB test suite and the
   frontend `buildPatches` reflect that PostgREST returns a NUMERIC column
   as its string form (`"20"` — not `"20.00"` — when scale is zero, and
   `"20.00"` when scale > 0 depending on the column). Comparisons therefore
   use `Number()` on both sides rather than `String()`.
3. **Feature flags**. Only *hospital-scoped override rows* in the existing
   `feature_flags` table (migration 37) are writable here. The set of
   available `flag_key`s is decided by the global defaults already in that
   table; WS-ONBOARD-2 does not create new flags, does not introduce a
   per-hospital flag that has no global default, and does NOT touch the
   global defaults row itself.
4. **Operating hours / holidays**. Not exposed here because the current
   schema stores them through separate tables owned by scheduling
   (migration 11). Adding a write surface for them is out of scope for
   WS-ONBOARD-2 (spec §4, staff/schedules).
5. **Currency / locale beyond `preferred_language`**. Not exposed because
   the existing schema does not carry per-hospital currency columns; adding
   one would invent policy (spec §23).
6. **Rollback UI**. Migration 18 stores the historical versions and the
   existing architecture supports reading them, but a first-class Rollback
   action in the admin form is NOT added here — spec §10 says "if WS-
   ONBOARD-2 requires exposing existing rollback ..."; the current product
   requirement is that configuration is *auditable and versioned*, which is
   already satisfied by `config_versions` + the audit trail. A rollback
   button would need additional concurrency + audit semantics that this
   workstream does not want to invent.
7. **Local verification only.** See §21.

## 20. Explicit scope confirmation

Out of scope and **not touched**, per spec §4:

- Razorpay credentials, Meta / WhatsApp credentials, webhook secrets,
  provider tokens, service-role keys — no column in migration 66 writes to
  any integration column, and the Edge Schema rejects them.
- Doctors / staff creation, doctor schedules, doctor leave.
- Subscription billing, payment orders, refunds, settlements, ledger — the
  only financial surface here is the fee CONFIGURATION columns
  (`platform_fee_*`, `receptionist_fee`, `default_consultation_fee_inr`,
  `gst_*`), which are read by the existing engines and were already present
  in the schema.
- Production deployment, staging deployment, production secrets, external
  provider accounts.
- Reopening G-03..G-11, C2, G7-13, G7-16, F16-07, WS-ONBOARD-1. No file
  owned by those workstreams was modified.
- The scheduler (P0-02) and the worker lease regression (P0-01) remain
  exactly as documented in AGENTS.md §13; WS-ONBOARD-2 does not touch them.

## 21. Production / staging status

**STAGING: UNPROVEN. PRODUCTION: UNPROVEN.**

All evidence in §16–§17 was produced against the developer's local Docker
Supabase stack. No staging deployment was invoked. No production project was
provisioned or linked. Per AGENTS.md §5: "a local runtime result is not
production verification." Migration 66 has NOT been pushed to any Supabase
Cloud project. No Edge Runtime deployment has been made outside the local
container.

Any claim of "certified", "production ready", "verified" beyond
"locally integration verified" is NOT supported by the evidence in this
report.

---

## Final question (spec §31)

> Can a Global Admin create a new hospital using WS-ONBOARD-1 and then
> configure that hospital's supported operational settings entirely through
> the SETURA frontend, without editing SQL, environment variables, or
> source code for that hospital?

**Yes**, for the field set enumerated in §8, subject to the explicit scope
boundaries in §20.

Evidence:

- **Create hospital**: proven by WS-ONBOARD-1 (`hospital_provisioning.test.ts`
  and `hospital_provisioning_http.test.ts`) — 380/380 integration still
  includes those suites green.
- **Configure via UI**: the `/admin/hospital-settings` route (nav visible
  to `hospital_admin` + `global_admin`) loads the composed snapshot via the
  `hospital-configuration` Edge Function's `mode: "read"` and posts updates
  via `mode: "update"`. HTTP suite test `hospital_admin reads their own
  configuration (200)` and `hospital_admin updates ... version bumps ...
  settings persist` prove the round trip on real HTTP with a real JWT.
- **No SQL edit required**: the DB integration suite performs every test
  exclusively through the two RPCs plus the existing triggers; no ad-hoc
  `UPDATE hospital_settings` is executed in any test, and the tests still
  pass.
- **No env-var edit required**: nothing in migration 66, the Edge Function
  or the frontend reads a per-hospital setting from `Deno.env`; every
  value lives in the tenant's database rows.
- **No source-code edit required**: adding a new hospital with a distinct
  configuration uses exactly the same code path — the RPC accepts a
  JSONB patch and applies only the whitelisted fields; there is no
  per-hospital branch anywhere.
- **Server-side authority is real**: catalog ACL verified (§5); tenant
  cross-check enforced at both Edge (`X-Hospital-ID` vs `user_roles`) and
  DB (`user_roles` re-check inside the RPC, SQLSTATE 42501 on mismatch);
  concurrent writers cannot silently lose updates (`P0001` optimistic
  version, HTTP 409 mapped and rendered honestly by the frontend).

Caveat: the frontend surface covers only the fields listed in §8. Integration
credentials (Razorpay / Meta) are intentionally NOT part of this answer —
WS-ONBOARD-3 owns them.

---

## Final response format (spec §32)

```
WS-ONBOARD-2 STATUS:
IMPLEMENTED + LOCALLY INTEGRATION VERIFIED

DATABASE:
Migration 66 adds get_hospital_configuration + update_hospital_configuration
(both SECURITY DEFINER, own explicit REVOKE from PUBLIC/anon/authenticated,
GRANT to service_role only, catalog ACL verified). Registers
audit_action_types rows hospital_setting_update (high/system) and
feature_flag_update (medium/system). Applies existing triggers/RLS/audit
primitives (migrations 12/18/25/35/37/39) unchanged.
STATUS: INTEGRATION VERIFIED (local stack).

EDGE:
supabase/functions/hospital-configuration: CORS + POST + resolveAuth +
requireRole(['global_admin','hospital_admin']) + X-Hospital-ID tenant
cross-check + discriminated union on mode + Idempotency-Key gate for
update + withIdempotency + RPC call + logAuditEvent on fresh execution +
server-authoritative read-back. SQLSTATE mapped: P0001→409 DB_CONCURRENCY,
42501→403 HOSPITAL_ACCESS_DENIED, 22023/22P02/22001→422 VALIDATION_ERROR,
missing key→400 IDEMPOTENCY_KEY_REQUIRED.
STATUS: INTEGRATION VERIFIED (real HTTP, real JWT, local Edge Runtime).

FRONTEND:
/admin/hospital-settings route in the authenticated shell + AppShell nav
entry for hospital_admin + global_admin (UX only). Server-snapshot
bufferFrom + client validateConfiguration mirroring RPC limits +
buildPatches NUMERIC-safe diff + buildFeatureOverrides + useAsyncAction
(one stable key per logical action). Honest success / conflict /
validation banners. Reload from server after save.
STATUS: UNIT VERIFIED (20/20 vitest); INTEGRATION VERIFIED end-to-end via
the HTTP suite that drives the same Edge contract the frontend calls.

VERSIONING:
Reuses migration 18 trg_hospital_settings_version and
trg_feature_flags_version unchanged. RPC sets hospital_settings.updated_by
before UPDATE so version rows carry the real human. Expected-version
optimistic concurrency via p_expected_version vs MAX(version_number).
No new version store, no second trigger, no rollback redesign.
STATUS: INTEGRATION VERIFIED.

AUDIT:
logAuditEvent primitive (migration 39). Emits hospital_setting_update for
settings/hospitals patches and feature_flag_update for overrides, once per
fresh execution; idempotent replay adds zero rows.
STATUS: INTEGRATION VERIFIED.

IDEMPOTENCY:
api_idempotency_keys registry (migration 25) + withIdempotency wrapper at
the Edge layer, keyed on client-supplied Idempotency-Key. Missing key on
update → 400 with NO DB write. Replay returns stored version and does not
double-audit or double-version.
STATUS: INTEGRATION VERIFIED.

TENANT ISOLATION:
Two-boundary check: Edge cross-checks X-Hospital-ID against the actor's
user_roles (403 HOSPITAL_ACCESS_DENIED); RPC re-checks user_roles
independently (SQLSTATE 42501). Catalog ACL confirms anon/authenticated
EXECUTE absent on both new RPCs; runtime denial asserted. Cross-hospital
update attempted by hospital_admin of another tenant is refused at BOTH
layers in the test suite.
STATUS: INTEGRATION VERIFIED.

CONCURRENCY:
Optimistic expected_version. Stale version → SQLSTATE P0001 → Edge
ConcurrencyError → HTTP 409 DB_CONCURRENCY_ERROR. Concurrent
same-expected_version race: exactly one succeeds and bumps the version,
the other is refused; final state and config_versions contain no partial
mixing of the loser's patch.
STATUS: INTEGRATION VERIFIED.

TESTS:
Deno unit 97/0. Deno integration 380/0 (includes 22 new DB + 15 new HTTP).
Frontend vitest 461/0 (includes 20 new). Frontend tsc clean.

REGRESSION:
validate:migrations 66 files, 0 errors, 4 pre-existing warnings matching
the AGENTS.md baseline. validate:migration-manifest 66/66, 0 issues.
gen:types:check up to date (UTF-8 no BOM). fmt:check 177 files clean.
lint 105 files clean. check clean. No prior suite weakened; no test
deleted; no assertion loosened. WS-ONBOARD-1 / privilege_isolation /
hospital_core_journey / C2 alert lifecycle / G-07..G-11 / worker
lifecycle / payment engines all still green.

STAGING:
UNPROVEN (no staging deployment performed in this workstream).

PRODUCTION:
UNPROVEN (no production deployment performed in this workstream).

NEXT WORKSTREAM:
WS-ONBOARD-3
```
