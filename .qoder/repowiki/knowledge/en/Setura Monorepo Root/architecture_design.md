The repository is organized into sibling top-level directories —
`supabase/functions` (Edge Functions), `supabase/functions/_shared`
(cross-function shared code), `scripts` (CLI helpers), and `tests` (unit +
integration) — all governed by the root `deno.json`. That file centralizes Deno
compiler options, remote import aliases (`zod`, `@supabase/supabase-js`), and
tasks that type-check every source tree (`scripts/*.ts`, `tests/*/*.ts`,
`supabase/functions/*/index.ts`) and run unit vs. integration test suites with
different permission flags. The CI workflow in `.github/workflows/ci.yml`
enforces two parallel jobs: a `quality` job runs fmt/lint/typecheck/migration
validation/unit tests without external services, and a `stack` job boots the
local Supabase stack via `supabase start`, verifies migrations and seed data
through `psql`, then executes `deno task test:integration` against it. Generated
database types live under `supabase/functions/_shared/database.generated.ts` and
are excluded from formatting/linting, keeping generated artifacts isolated from
hand-written code.
