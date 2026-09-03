---
kind: build_system
name: Deno + Supabase CLI Build & CI Pipeline
category: build_system
scope:
  - "**"
source_files:
  - deno.json
  - .github/workflows/ci.yml
  - supabase/config.toml
  - scripts/validate_migrations.ts
  - supabase/functions/_shared/database.generated.ts
  - tests/integration/local_stack.test.ts
---

## What system/approach is used

The project is a Deno-based monorepo whose build, linting, type-checking,
testing, and local-stack orchestration are centered around two tools:

- **Deno** (v2.8.3 pinned via GitHub Actions) — the runtime, package resolver,
  formatter (`deno fmt`), linter (`deno lint`), and test runner.
- **Supabase CLI** (`supabase start`, `supabase gen types`, `supabase db reset`)
  — boots the local Postgres 17, Edge Functions runtime, Studio, Inbucket,
  Storage, and Realtime services, applies migrations, seeds the database, and
  generates TypeScript types from the schema.

There are no Makefiles, Dockerfiles, or custom shell scripts in this repo; all
orchestration is expressed as Deno tasks and a single GitHub Actions workflow.

## Key files and packages

- `deno.json` — central task surface: `fmt`, `fmt:check`, `lint`, `check`,
  `test`, `test:integration`, `validate:migrations`, `gen:types`, `db:reset`. It
  also pins remote imports (`zod@v3.22.4`, `@supabase/supabase-js@2.39.7`),
  enforces strict compiler options, and excludes generated/temp dirs from
  formatting/linting.
- `.github/workflows/ci.yml` — two-job pipeline:
  - `quality`: checkout → setup Deno v2.8.3 → `deno fmt --check` → `deno lint` →
    `deno task check` (type-checks `scripts/*.ts`, `tests/unit/*.ts`,
    `tests/integration/*.ts`, `tests/utils/*.ts`,
    `supabase/functions/*/index.ts`) → `deno task validate:migrations` →
    `deno task test`.
  - `stack`: checkout → setup Deno + Supabase CLI → `supabase start` → verifies
    migration application via `docker exec supabase_db_setura psql ...` → runs
    `deno task test:integration` against the live stack.
- `supabase/config.toml` — declares `project_id = "setura"`, Postgres major
  version 17, seed file `./seed.sql`, Edge Runtime policy `per_worker` with
  `deno_version = 2`, and all dev-service ports (API 54321, DB 54322, Studio
  54323, etc.).
- `scripts/validate_migrations.ts` — invoked by `deno task validate:migrations`;
  validates migration dependencies, duplicates, indexes, and rollback risks.
- `supabase/migrations/01_foundation.sql … 39_schema_alignment.sql` — numbered
  SQL migration files applied by `supabase start` / `supabase db reset`.
- `supabase/functions/_shared/database.generated.ts` — generated TypeScript
  types produced by `supabase gen types typescript --local` and written into the
  shared function layer.
- `tests/unit/`, `tests/integration/local_stack.test.ts` — unit tests run
  without network access; integration tests require the full Supabase stack up
  and use `--allow-net --allow-env --allow-run`.

## Architecture and conventions

- **Single-task entry point**: every developer action goes through
  `deno task <name>` defined in `deno.json`. There is no ad-hoc script
  invocation.
- **Strict-by-default compilation**: `compilerOptions.strict`, `noImplicitAny`,
  `noImplicitReturns` are enforced globally; the CI `check` task type-checks
  every source tree including Edge Function entry points.
- **Generated code exclusion**: `database.generated.ts`, `supabase/.temp/`, and
  `supabase/.branches/` are excluded from both formatting and linting so that
  auto-generated artifacts do not break quality gates.
- **Migration-first database state**: the database schema lives in
  `supabase/migrations/*.sql` and is treated as the source of truth;
  `supabase start` applies them in order, and `deno task validate:migrations`
  asserts their integrity before tests run.
- **Two-tier testing**: unit tests (`deno task test`) run in isolation;
  integration tests (`deno task test:integration`) require the full
  `supabase start` stack and assert end-to-end behavior such as seed
  idempotency.
- **CI as a hard gate**: the workflow comment states “Failure of ANY step fails
  the pipeline. No step is advisory.” All steps are mandatory — format, lint,
  type-check, migration validation, unit tests, and integration smoke tests must
  pass on every push to `main` and every pull request.
- **Local stack naming convention**: the container name `supabase_db_setura` is
  derived from `project_id = "setura"` in `config.toml`, which the CI uses to
  `docker exec` into the DB for post-start verification.

## Conventions and constraints

- **Deno version pinning**: CI explicitly installs Deno v2.8.3 via `setup-deno`;
  Edge Functions runtime is configured to use Deno major version 2
  (`edge_runtime.deno_version = 2`).
- **Dependency resolution**: all third-party modules are resolved via Deno's
  remote import map in `deno.json` using pinned versions (`zod@v3.22.4`,
  `@supabase/supabase-js@2.39.7`); there is no `node_modules` or lockfile beyond
  `deno.lock`.
- **Edge Functions structure**: each function under
  `supabase/functions/<name>/index.ts` is independently type-checked by the
  `check` task glob `supabase/functions/*/index.ts`.
- **Secrets handling**: `config.toml` references environment variables via the
  `env(...)` syntax (e.g. `OPENAI_API_KEY`,
  `SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN`); secrets are never committed inline.
- **Branch-scoped local state**: `supabase/.branches/_current_branch` and
  `supabase/.temp/` exist to track local branch state and cached CLI artifacts;
  they are excluded from formatting/linting but are part of the local
  development workflow.
- **No packaging/release artifacts**: this repository does not produce
  deployable binaries or images; deployment is driven by pushing the Supabase
  project (migrations, functions, config) via the Supabase CLI, which is outside
  the scope of the checked-in build scripts.
