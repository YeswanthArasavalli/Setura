---
kind: external_dependency
name: Supabase Local Stack (Postgres 17 + Edge Runtime + Auth + Storage + Realtime)
slug: supabase
category: external_dependency
category_hints:
  - vendor_identity
  - framework_behavior
scope:
  - "**"
source_files:
  - supabase/config.toml
  - supabase/migrations/
  - supabase/functions/_shared/database.generated.ts
---

SETURA is built on a self-hosted Supabase stack configured via
`supabase/config.toml` and driven by the Supabase CLI (`supabase start`,
`supabase db reset`, `supabase gen types`). The stack runs Postgres 17, an Edge
Runtime for Deno-based functions under `supabase/functions/`, Auth with JWT
expiry 3600s, Inbucket for email testing, Storage with S3 protocol enabled, and
Realtime. Migrations live in `supabase/migrations/` (currently 39 files) and are
applied sequentially; seed data is loaded from `./seed.sql`. Types are
regenerated into `supabase/functions/_shared/database.generated.ts` from the
running local DB and consumed by all Edge Functions. CI pins Deno v2.8.3 and
uses `supabase/setup-cli` to spin up the same stack for integration tests.
