Integration tests require a running local Supabase stack started with
`supabase start` and are executed via `deno task test:integration`; unit tests
run standalone with `deno test tests/unit/` and must import
`../utils/setup_env.ts` as the very first import so fake env vars exist before
`env.ts` evaluates.
