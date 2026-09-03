- All Deno tasks and type checks are declared centrally in `deno.json` rather
  than per-directory scripts.
- Remote dependencies are pinned via `deno.json` `imports` aliases instead of
  inline URLs in source files.
- Generated artifacts (`database.generated.ts`, `supabase/.temp`,
  `supabase/.branches`) are excluded from both `deno fmt` and `deno lint`.
- Integration tests require elevated permissions
  (`--allow-net --allow-env --allow-run`) while unit tests run with minimal
  permissions.
