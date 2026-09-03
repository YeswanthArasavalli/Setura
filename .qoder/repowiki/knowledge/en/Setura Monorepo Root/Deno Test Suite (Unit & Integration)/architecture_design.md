Tests are split by scope: `tests/unit/` contains pure-module smoke tests for
`errors.ts`, `response.ts`, and `validation.ts` that run without network or
database; `tests/integration/local_stack.test.ts` boots a real Supabase stack
via the CLI, dynamically imports the service client from
`supabase/functions/_shared/db.ts`, and asserts migration registry, seeded
hospital, profiles, roles, schedules, working hours, settings, fee policies,
queue configs, and feature flags. Shared fixtures live in `tests/utils/`:
`seed_constants.ts` centralizes deterministic UUIDs and expected row counts so
seed changes touch only one place, and `setup_env.ts` seeds fake Supabase
credentials before any `_shared` module loads (required because `env.ts`
validates variables eagerly at import time). Dependency direction is strictly
downward — tests import production code under `supabase/functions/_shared/*`;
there are no mocks, so integration tests exercise the actual Postgres schema.
