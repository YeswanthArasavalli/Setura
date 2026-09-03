---
kind: configuration_system
name: "Supabase Edge Functions: Typed Env + DB-backed Feature Flags & Config Versioning"
category: configuration_system
scope:
  - "**"
source_files:
  - supabase/functions/_shared/env.ts
  - .env.example
  - supabase/config.toml
  - deno.json
  - tests/utils/setup_env.ts
  - supabase/migrations/18_config_versioning_&_rollback.sql
  - supabase/migrations/37_feature_flags.sql
---

## What system/approach is used

The repository uses a **two-layer configuration system**:

1. **Runtime environment variables** for process-level configuration (Supabase
   credentials, third-party API keys, feature toggles, CORS, rate limits). This
   is implemented in `supabase/functions/_shared/env.ts`, which reads from
   `Deno.env` with typed helpers (`requireEnv`, `optionalEnv`, `requireUrlEnv`,
   `optionalIntEnv`, `optionalBooleanEnv`) and fails fast at module load time if
   required values are missing.
2. **Database-backed runtime configuration** stored in Supabase Postgres,
   versioned and audited via triggers. Migrations
   `18_config_versioning_&_rollback.sql` and `37_feature_flags.sql` implement an
   append-only `config_versions` table that tracks changes to `system_settings`,
   `hospital_settings`, `feature_flags`, and `queue_configs`, with rollback
   functions and RLS policies.

Configuration is loaded per-function via Deno's `Deno.env`; there is no
centralized config file consumed by the application code beyond the Supabase CLI
config.

## Key files and packages

- `supabase/functions/_shared/env.ts` — single source of truth for all runtime
  env parsing, validation, and typed export as `Object.freeze(Env)`.
- `.env.example` — canonical list of required/optional env vars with defaults
  and comments.
- `supabase/config.toml` — Supabase local dev stack configuration (API, DB,
  Auth, Storage, Edge Runtime, Analytics).
- `deno.json` — Deno tasks that pass `--allow-env` to tests; also declares
  imports and formatter/linter exclusions.
- `tests/utils/setup_env.ts` — test bootstrap that sets minimal env before any
  `_shared` import so unit tests can run without real credentials.
- `supabase/migrations/18_config_versioning_&_rollback.sql` — creates
  `config_versions` audit table, triggers on
  `system_settings`/`hospital_settings`/`feature_flags`, rollback functions, and
  RLS.
- `supabase/migrations/37_feature_flags.sql` — seeds global feature flags, adds
  hospital-admin management policy, and exposes
  `get_hospital_feature_flags(UUID)` SQL function for resolution.
- `supabase/migrations/12_hospital_configuration_engine.sql` — defines the base
  `feature_flags` table referenced by later migrations.

## Architecture and conventions

### Environment loading pattern

- All env access goes through `env.ts`. Each variable is declared at module top
  level so validation runs on first import (fail-fast cold-start design
  documented in the file header).
- Required vs optional distinction is explicit: `requireEnv` throws
  `[env] FATAL: ... missing or empty`; `optionalEnv` returns default.
- URL env vars use `requireUrlEnv`, which validates via `new URL(value)`.
- Numeric env vars use `optionalIntEnv` with `Number.parseInt(raw, 10)` and
  throw on NaN.
- Boolean env vars accept `true`, `1`, or `yes` (case-insensitive) via
  `optionalBooleanEnv`.
- The final `Env` object is `Object.freeze(...)` and exported alongside `AppEnv`
  and `Environment` types for full type safety across functions.
- Defaults vary by environment: `LOG_LEVEL` defaults to `info` in production and
  `debug` otherwise; `ALLOWED_ORIGINS` defaults differ between prod and dev.

### Test strategy for env

Unit tests never touch `_shared/env.ts` directly; they target pure modules
(`errors.ts`, `validation.ts`, `response.ts`). For any test that transitively
imports `_shared/env.ts`, `setup_env.ts` must be imported first because ES
modules execute in import order — this is enforced by the comment block in
`setup_env.ts`.

### Database-backed configuration

- `config_versions` is an append-only immutable audit log (UPDATE/DELETE blocked
  by triggers raising `config_versions is append-only`).
- Triggers on `system_settings`, `hospital_settings`, and `feature_flags`
  automatically write version records with `previous_value` / `new_value` JSONB
  snapshots.
- Rollback is performed via
  `rollback_system_setting(key, target_version, actor, reason)` and
  `rollback_feature_flag(hospital_id, flag_key, target_version, actor, reason)`,
  which reapply old values and mark the new version as `is_rollback = true` with
  `rolled_back_from` linking back to the original version.
- A `config_change_history` view joins versions with hospitals and profiles for
  auditing.
- Row Level Security restricts `config_versions` to global admins for writes and
  hospital admins for select on hospital-scoped rows.

### Feature flags

- Global defaults have `hospital_id IS NULL`; hospital-specific overrides have
  `hospital_id IS NOT NULL`.
- Resolution order is enforced by `get_hospital_feature_flags(p_hospital_id)`:
  hospital override → global default → excluded if no row.
- Migration 37 seeds defaults for features like `online_booking`,
  `whatsapp_notifications`, `analytics_dashboard`, `telemedicine`,
  `subscription_billing`, `smart_queue`, `ai_insights`.
- Hospital admins manage their own overrides via an RLS policy
  `feature_flags_hospital_admin_manage`.

### Supabase CLI configuration

`supabase/config.toml` configures the local Supabase stack (project id, API port
54321, DB port 54322, Studio, Realtime, Auth, Storage, Edge Runtime with
`policy = "per_worker"`, Deno version 2, analytics backend postgres). Secrets
are injected via `env(VAR_NAME)` syntax (e.g.
`openai_api_key = "env(OPENAI_API_KEY)"`).

## Conventions and constraints

- **Fail-fast env**: Missing required env causes a thrown error during module
  load, not at first usage. This is enforced by `requireEnv` throwing and is
  relied upon by the test harness.
- **Single env source**: All functions import `Env` from `_shared/env.ts`; there
  is no per-function env parsing.
- **Typed exports only**: Consumers read from the frozen `Env` object, never
  call `Deno.env.get` directly, ensuring consistent validation.
- **Append-only config history**: `config_versions` cannot be updated or deleted
  (enforced by `prevent_config_version_mutation` trigger); changes are always
  new rows.
- **Rollback tracking**: Every rollback marks the new version with
  `is_rollback = true` and links `rolled_back_from` to the original version id.
- **RLS on config tables**: `config_versions` has RLS enabled and forced; only
  global admins can write, hospital admins can select their scope.
- **Feature flag resolution via SQL**: Application code should query
  `get_hospital_feature_flags(hospital_id)` rather than reading raw rows,
  ensuring correct override precedence.
- **Test env isolation**: Unit tests set `APP_ENV=test` plus minimal
  Supabase/test credentials in `setup_env.ts` before importing anything that
  touches `_shared/env.ts`.
