---
kind: external_dependency
name: Deno runtime for Edge Functions and tooling
slug: deno
category: external_dependency
category_hints:
  - client_constraint
scope:
  - "**"
source_files:
  - deno.json
  - .github/workflows/ci.yml
  - supabase/config.toml
---

All Edge Functions and shared modules are written in TypeScript/Deno. The
project pins Deno v2.8.3 in CI and configures the Supabase Edge Runtime to use
Deno major version 2. Tooling (`fmt`, `lint`, `check`, `test`) runs via
`deno task`. Imports for `zod` and `@supabase/supabase-js` are resolved from
esm.sh URLs declared in `deno.json imports`. Lint rule `no-import-prefix` is
excluded to allow the deployed convention of importing zod/supabase-js directly
from URL paths.
