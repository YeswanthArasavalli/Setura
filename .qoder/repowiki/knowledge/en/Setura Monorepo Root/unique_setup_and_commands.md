`deno task check` type-checks the entire repo (functions, scripts, tests);
`deno task test` runs unit tests; `deno task test:integration` requires a
running local Supabase stack started via `supabase start`;
`deno task validate:migrations` validates migration files; `deno task gen:types`
regenerates `supabase/functions/_shared/database.generated.ts` from the local
schema.
