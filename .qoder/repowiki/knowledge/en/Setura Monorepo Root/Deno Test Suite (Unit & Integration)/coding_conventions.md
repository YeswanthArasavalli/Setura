- Each assertion file groups related behaviors into separate `Deno.test` blocks,
  each verifying a single invariant about errors, responses, or seeded rows.
- Assertions use `assertEquals`, `assertExists`, `assertRejects`, and
  `assertInstanceOf` from `deno.land/std` assert module rather than custom
  helpers.
- Seed-derived constants (UUIDs, emails, expected counts) are centralized in
  `tests/utils/seed_constants.ts` and referenced by name instead of hard-coded
  literals in assertions.
- Integration tests query the database via the Supabase JS client and assert
  exact row counts to prove seed idempotency (no duplicates on re-run).
- Unit tests that transitively import `_shared/env.ts` bootstrap fake
  environment variables by importing `../utils/setup_env.ts` as their first
  statement, relying on ES module import-order guarantees.
