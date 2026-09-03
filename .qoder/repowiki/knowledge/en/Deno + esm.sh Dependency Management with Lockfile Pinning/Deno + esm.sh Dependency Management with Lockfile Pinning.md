---
kind: dependency_management
name: Deno + esm.sh Dependency Management with Lockfile Pinning
category: dependency_management
scope:
  - "**"
source_files:
  - deno.json
  - deno.lock
---

## What system/approach is used

This repository uses **Deno** as its runtime and package manager. Dependencies
are declared via a single root `deno.json` configuration file using the
`imports` map, which maps import specifiers to pinned remote URLs. The project
does not use npm/yarn/pnpm; there are no `package.json`, `node_modules`, or Go
module files. Instead, it relies on Deno's built-in dependency resolution
against CDN registries (`deno.land/x`, `esm.sh`) and the JSR registry (for
`@std/*` packages).

A `deno.lock` lockfile is committed alongside `deno.json`, pinning every
transitive dependency by SHA-256 integrity hash. This ensures reproducible
builds across environments without vendoring source code into the repo.

## Key files and packages

- `deno.json` — central dependency manifest. Declares compiler options, task
  scripts, formatter/lint exclusions, and the `imports` map that aliases
  top-level dependencies.
- `deno.lock` — deterministic lockfile (version `5`). Records exact resolved
  URLs, redirects, and integrity hashes for all direct and transitive
  dependencies.
- `supabase/functions/_shared/database.generated.ts` — generated types (excluded
  from lint/fmt); regenerated via the `gen:types` task using
  `supabase gen types`.

Direct dependencies in scope:

- `zod` v3.22.4 imported from `https://deno.land/x/zod@v3.22.4/mod.ts`
- `@supabase/supabase-js` v2.39.7 imported from
  `https://esm.sh/@supabase/supabase-js@2.39.7`
- `@std/yaml` v1.0.5 pulled from JSR (`jsr:@std/yaml@1.0.5`)

Transitive dependencies are resolved through `esm.sh` (e.g.,
`@supabase/node-fetch`, `ws`, `bufferutil`, `utf-8-validate`,
`webidl-conversions`, `whatwg-url`, `tr46`, `node-gyp-build`) and
`deno.land/std@0.224.0/assert`.

## Architecture and conventions

1. **Centralized aliasing**: All third-party imports go through the `imports`
   map in `deno.json`. Code inside `supabase/functions/*/index.ts` and tests
   imports these libraries via the short specifier (`zod`,
   `@supabase/supabase-js`) rather than raw URLs, keeping import statements
   clean while still pinning versions at the manifest level.

2. **CDN-based resolution with locking**: Dependencies are fetched at runtime
   from CDNs (`deno.land/x`, `esm.sh`, `jsr.io`) but made deterministic via
   `deno.lock`. The lockfile records both the original specifier and any
   redirect chains (the `redirects` section) plus per-file integrity hashes
   under `remote` and `jsr` sections.

3. **No vendoring**: No `vendor/` directory or checked-in copies of third-party
   source exist. Reproducibility comes entirely from the lockfile.

4. **Generated artifacts excluded**: `database.generated.ts` lives under
   `supabase/functions/_shared/` and is explicitly excluded from both
   `fmt.exclude` and `lint.exclude` so regeneration does not trigger
   formatting/lint noise.

5. **Task-driven lifecycle**: `deno.json` tasks encapsulate dependency-related
   operations:
   - `check` runs `deno check` over all function entrypoints, scripts, and tests
     to validate imports resolve.
   - `test` / `test:integration` run the Deno test runner with appropriate
     permissions.
   - `validate:migrations` runs a custom migration validator script.
   - `gen:types` regenerates Supabase TypeScript types into
     `database.generated.ts`.
   - `db:reset` resets the local Supabase database.

6. **CI integration**: `.github/workflows/ci.yml` drives the same Deno toolchain
   in GitHub Actions, ensuring CI uses the same dependency resolution as local
   development.

## Conventions and constraints

- **Pin via `imports` map**: New third-party packages should be added to the
  `imports` block in `deno.json` with an explicit versioned URL (e.g.,
  `"pkg": "https://deno.land/x/pkg@vX.Y.Z/mod.ts"`), not bare unversioned URLs.
- **Lockfile must stay in sync**: Because `deno.lock` is committed, any change
  to `deno.json` (adding/removing/upgrading a dependency) requires regenerating
  the lockfile (`deno cache` / `deno install`) and committing the updated
  `deno.lock` to keep builds deterministic.
- **Use short specifiers in code**: Source files import via the alias defined in
  `deno.json` (`import { z } from "zod"`;
  `import { createClient } from "@supabase/supabase-js"`), never via full CDN
  URLs directly in business logic.
- **JSR packages use `jsr:` protocol**: Standard library utilities come from JSR
  (`@std/*`) and are resolved via the `jsr:` specifier recorded in the
  lockfile's `specifiers`/`jsr` sections.
- **Generated files are ignored by tooling**: `database.generated.ts`,
  `supabase/.temp/`, and `supabase/.branches/` are excluded from formatting and
  linting so they do not interfere with developer workflows.
- **Strict compiler settings enforced globally**: `strict`, `noImplicitAny`, and
  `noImplicitReturns` are enabled in `compilerOptions`, constraining how
  dependencies can be consumed in typed code.
