# PHASE 7 — G7-02 DEPLOYMENT TRANSPORT & PRODUCTION ARCHITECTURE PLAN

Planning/architecture deliverable (2026-09-19). **No production action,
no credential creation, no deployment, no Git initialization or
remote changes were performed.** G7-01 and G7-07 are closed and are
not reopened here.

Status vocabulary: PROVEN · IMPLEMENTED · BLOCKED · DEFERRED ·
NOT IMPLEMENTED.

---

## 1. Executive result

**The single most important discovery of this session invalidates a
core G7-02 premise.** The reconciliation (and AGENTS.md §13) recorded:

> "The working tree is NOT a Git repository (no `.git`, confirmed by two
> independent methods)."

Direct verification on 2026-09-19 shows this is **no longer true**:

```text
.git exists; git rev-parse → true
remote origin → https://github.com/YeswanthArasavalli/Setura.git (HTTPS, no embedded credentials)
5 commits, main == origin/main:
  12123c3 2026-09-19 Add staff web frontend and security S1 tests   (HEAD, main, origin/main)
  40d6b4a 2026-09-19 Fix booking refund and E1 runtime issues
  dc21741 2026-09-19 Fix worker lifecycle and scheduler regressions
  cf046f6 2026-09-04 Fix fail_job_v2 dead-letter handling
  e593d1b 2026-09-03 Initial Setura project import
534 tracked files; 5 untracked (this session's Phase 7 reports/logs)
```

Therefore G7-02 is no longer "choose and install a transport" — the
transport **exists and already carries the whole tree**. What remains,
and what this document specifies, is:

1. **Hygiene remediation before anything deploys** — the repository
   currently tracks ~280 generated/local-only files (§3, §4) including
   `supabase/.temp/linked-project.json` and 11 session logs, and has no
   root `.gitignore` (only `apps/web/.gitignore`).
2. A **migration-immutability mechanism** that is now implementable
   (checksum ledger + CI) — with the honest caveat that history before
   2026-09-03 can never be proven, and **exactly one post-addition
   migration edit is already visible in history** (§6).
3. The full CI→staging→production pipeline design (§5–§13), rollback
   playbook (§11), gates (§12), and the exact boundary of what requires
   explicit user authorization (§23).

Executive classification: **PLANNED — NOT IMPLEMENTED.**

---

## 2. Current transport state (verified)

| Aspect | State | Evidence |
| --- | --- | --- |
| Git repository | EXISTS (was recorded absent; superseded) | `git rev-parse`, `.git` listing |
| Remote | GitHub, HTTPS, `main` pushed, in sync | `git remote -v`, `origin/main` at HEAD |
| History depth | 5 commits, bulk-import shape (whole phases per commit) | `git log` |
| Root `.gitignore` | **MISSING** | `git ls-files '*.gitignore'` → only `apps/web/.gitignore` |
| Tracked local artifacts | 70 `graphify-out/`, 116 `.qoder/` (repowiki), 95 `.remember/` + `.ua/`, 11 root/session `*.log`, `supabase/.temp/cli-latest`, `supabase/.temp/linked-project.json`, `supabase/.branches/_current_branch`, `apps/web/install.log` (verify) | `git ls-files` counts |
| Tracked secrets | None found — only `.env.example` files (placeholders) | `git ls-files` env/log filter |
| `apps/web/dist`, `node_modules`, `.env.local` | NOT tracked (apps/web/.gitignore covers them) | pathspec query returned none |
| CI | `.github/workflows/ci.yml` on `main`; **whether Actions runs on GitHub: UNPROVEN** (not queried — external system) | ci.yml; no workflow-run evidence gathered |
| Deploy stage | none | ci.yml stops at tests |

`supabase/.temp/linked-project.json` deserves emphasis: it records
which hosted project the CLI was **linked** to. Its presence in a
public-capable remote is a project-ref disclosure (not a credential),
and it makes `supabase db push --local`-style accidents *more*, not
less, dangerous. It must exit tracking (§4).

---

## 3. Repository structure (actual tree → proposed tracked set)

The current physical structure is already correct and should NOT be
reorganized (it matches `ARCHITECTURE.md`, command authority lives in
`deno.json`, and moving files now would break the verified reports).
What needs changing is only the **tracked/untracked boundary**:

```text
TRACK (source of truth)                 UNTRACK (local-only / generated / session)
├── .github/workflows/ci.yml            ├── .remember/            (agent scratch, logs, .gitignore'd itself)
├── apps/web/            (source, e2e,  ├── .ua/                  (tooling cache incl. scratch JS)
│                        configs,        ├── supabase/.temp/       (CLI link state)
│                        .env.example)   ├── supabase/.branches/   (CLI branch state)
├── supabase/functions/  (27 + _shared) ├── *.log at root          (session evidence; archive to docs/evidence/ if to be kept)
├── supabase/migrations/ (01–56)        ├── graphify-out/cache/    (regenerable)
├── supabase/snippets/                   ├── apps/web/install.log
├── supabase/config.toml                 └── (nothing else — dist/ and node_modules already excluded)
├── supabase/seed.sql      (local demo —
│                          tracked by design)
├── tests/                 (unit + integration + utils)
├── scripts/               (gen_types, validate_migrations)
├── docs/                  (contracts, security docs)
├── *.md root reports      (project record — keep tracked)
├── AGENTS.md / CLAUDE.md / ARCHITECTURE.md / ROADMAP.md
├── .env.example           (placeholders only)
└── deno.json / deno.lock
```

**Genuinely contested artifacts — recorded as decisions, not silently
resolved:**

- `graphify-out/` + `GRAPH_REPORT.md`: the navigation index.
  Committing it is defensible (auditable graph history); ignoring it
  treats it as regenerable tooling. → **DEFERRED (D8)**.
- `.qoder/repowiki/` (116 generated wiki files): generated
  documentation already contradicted at least one tracked fact (§21 of
  the reconciliation). Recommend untracking → **DEFERRED (D9)**.

Generated source that **stays tracked**: `supabase/functions/_shared/
database.generated.ts` — it is compiled against, type-checked in CI,
and drift-checked by `deno task gen:types:check`.

## 4. Git / version-control strategy

1. **Strategy:** continue with the existing repo + remote (it already
   mirrors the tree). Do not re-import. First commit after approval is
   a **hygiene commit**: add a root `.gitignore` (patterns: `.remember/`,
   `.ua/`, `supabase/.temp/`, `supabase/.branches/`, `*.log` with
   explicit `!` allows for any evidence logs kept by decision), then
   `git rm --cached` the ~280 local-only files. Nothing is deleted from
   disk; history is never rewritten.
2. **Branches:** `main` = deployable trunk, always green. Short-lived
   `feature/*` or `fix/*` branches per work package; no long-lived
   develop branch (single team, CI-enforced merge is the gate).
3. **Protected `main`:** require PR, require `CI` checks green, forbid
   force-push and deletion, require admin approval for changes touching
   `supabase/migrations/**` (migration PRs get senior review).
4. **PR requirements:** two green jobs (existing `quality` + `stack`),
   one human review, and — once §5 adds them — the migration-checksum
   gate and privilege-ACL lint.
5. **Migration immutability:** enforced by the checksum ledger (§6),
   not by convention.
6. **Release tagging:** signed annotated tags `vMAJOR.MINOR.PATCH`;
   `DEPLOYMENT_VERSION` secret MUST equal the deployed tag (the tree
   already plumbs `DEPLOYMENT_VERSION` into every structured log line —
   this is what makes deployed-version evidence possible).
7. **Deployment provenance:** every deploy records
   `commit SHA + tag + migration manifest hash + function deploy log +
   frontend build hash` into an append-only release record (a
   `docs/releases/` entry or the Supabase dashboard audit). No deploy
   from an untagged commit.
8. **Rollback reference:** always the previous tag (§11).
9. **CI checks:** §5.
10. **Production approval:** GitHub "environment" `production` with
   required approver(s); the deploy job cannot run without interactive
   approval — this converts "explicit user authorization" into a
   technical control instead of a promise.

---

## 5. CI architecture (design — not implemented)

### PR validation (must fail the PR, no advisory steps)

```text
existing:  fmt:check · lint · check · validate:migrations · unit tests
           supabase start + deno task test:integration (full 19-suite stack job)
add:       migration checksum-ledger verification (§6)
add:       frontend: npm ci && npm run typecheck && npm run build && npm run test (vitest)
add:       dependency audit: `npm audit --audit-level=high` (apps/web) and
           deno.lock URL pinning check (no unpinned http imports outside lock)
add:       privilege lint: grep new/changed migrations for CREATE OR REPLACE /
           CREATE FUNCTION SECURITY DEFINER without an accompanying REVOKE
           (mechanical F16-04 guard)
```

### Pre-release (main, on every merge)

```text
all PR checks + consolidated regression (E1, W1, scheduler, financial,
S1 subsets run against one freshly reset stack) + gen:types:check
```

### Release candidate

```text
build artifacts (frontend dist bundle, function bundle) → checksums →
deployment manifest {tag, SHA, migration manifest hash, secret NAMES
list (never values)} → tag v…
```

### Staging (auto on tag)

```text
linked staging project: db push → secrets verify (names only) →
functions deploy → smoke suite (§16 subset) → privilege census vs
expected TSV
```

### Production (NEVER automatic)

```text
required approval gate → same manifest as staging, byte-identical
artifacts → deploy → verification battery → release record commit
```

Current classification for everything in this section: **NOT
IMPLEMENTED** (design only; the two existing jobs in `ci.yml` are
IMPLEMENTED but their GitHub execution status is UNPROVEN from this
tree).

---

## 6. Migration deployment & immutability

**Apply method:** `supabase db push` against the linked project (it
records versions in `supabase_migrations.schema_migrations`) *plus* the
existing internal `public.migration_registry` ledger. Note two known
local friction facts from prior sessions: `db push` failed
authentication-free on this machine ("Cannot find project ref" without
`--local`, hangs with it); CI must therefore use the CLI with explicit
`--workdir`/project-ref in a clean Linux environment, and the
`docker cp … psql -f` path remains the documented local fallback, never
the production path.

**Immutability detection — checksum ledger:**

1. Commit `supabase/migrations/MANIFEST.sha256` listing
   `sha256  NN_name.sql` for all applied migrations.
2. CI fails if any manifest-listed file's hash changes (**edited**), if
   a listed file disappears (**deleted**), if a new migration sorts
   *before or between* already-manifested numbers (**reordered /
   out-of-order insert**), if two files share a numeric prefix
   (**duplicate number**), or if `migration_registry` (queried on
   staging/production) contains an id with no file or vice versa
   (**missing**).
3. A new migration may only append after the last manifest entry, and
   the PR that adds it must extend the manifest.

**What can currently be proven (honest boundary):**

- **Provable since 2026-09-03:** `git log --diff-filter=M` over
  `supabase/migrations/` shows **exactly one post-addition edit:
  `53_phase2_scheduler_and_autonomous_recovery.sql` in `40d6b4a`
  (2026-09-19)**. Consistent with the Phase 2 record: migration 53 was
  rewritten in-session (the `cleanup_stale_presence` ambiguity fix) and
  re-applied to the live DB **before** any release, with the same-day
  commits reflecting it. It is not a case of a long-applied migration
  being silently edited, but it **is** a violation of the rule as
  stated going forward, and is recorded here rather than smoothed over.
- **Unprovable forever:** any edits before the 2026-09-03 bulk import.
  The initial commit's content hash is the only baseline; pre-import
  drift cannot be detected. The migration files' own embedded
  verifications (52/53/54/55 self-check blocks) are the compensating
  evidence that they apply cleanly as committed.
- **Baseline action:** generate `MANIFEST.sha256` from the current tree
  at first approval — that moment becomes the provable baseline
  ("immutability from day N"), without fabricating a claim about
  earlier days.

---

## 7. Edge Function deployment

- 27 functions under `supabase/functions/` deploy via
  `supabase functions deploy` (all) from `main`/tag. `deno.lock` pins
  every esm.sh/std URL — supply-chain provenance is already good.
- **Shared modules** (`_shared/**`, incl. `database.generated.ts`) are
  bundled per function by the CLI at deploy; a missing secret does not
  fail deploy but **fails cold start** (`env.ts` throws on
  `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY`) →
  secrets must be set *before* the function smoke test, which must
  therefore run against a cold invocation.
- **verify-jwt:** `config.toml` declares no `[functions]` section, so
  cloud default is verify_jwt=true. The six machine/webhook endpoints
  are authenticated by their own secrets (`X-Cron-Secret`,
  `X-Worker-Secret`, Meta HMAC, Razorpay HMAC) and are called by
  pg_net/Kong or Meta — **they require `--no-verify-jwt`** (or a
  per-function `[functions.<name>] verify_jwt = false` entry in
  config.toml, which is preferable because it is version-controlled):
  `run-cron-minute`, `run-cron-nightly`, `run-background-worker`,
  `send-reminders`, `process-whatsapp-webhook`, `verify-payment`.
  ⚠️ Known trap (recorded in repo experience): with verify_jwt=true,
  Kong 401s *mask* the functions' fail-closed checks — smoke tests
  must assert the function-level error body, not just the status.
  Remaining 21 functions keep verify_jwt=true (browser JWTs).
  Internal service-to-service dispatches (`run-background-worker →
  send-whatsapp-message` with `X-Worker-Secret`) need the same config
  decision recorded before deploy (send-whatsapp-message is dispatched
  by the worker, not the browser) — **verify against actual invokers
  at implementation time; do not flip flags blindly.**
- **Env requirements:** the full matrix from the reconciliation §6
  (`env.ts` is the authority). All provisioned via
  `supabase secrets set` (platform), never in code.

## 8. Frontend deployment

Verified facts: build = `npm run build` (`tsc --noEmit && vite
build`); output = `apps/web/dist/`; env = `VITE_SUPABASE_URL` +
`VITE_SUPABASE_ANON_KEY` only; routing = `react-router-dom` v6 client
routes (`/login`, `/reception`, `/doctor`, `/queue`, `/bookings/:id`) →
**SPA fallback (index.html rewrite) is mandatory**; dev server 5173 is
the only currently whitelisted origin in local CORS.

Hosting candidates (factual, none selected):

| Candidate | SPA fallback | Build-time env | Preview deploys | Notes for SETURA |
| --- | --- | --- | --- | --- |
| Cloudflare Pages | yes | yes | yes | free tier generous; GitHub integration |
| Vercel | yes (`react` framework preset) | yes | yes | zero-config for Vite |
| Netlify | yes (`_redirects`) | yes | yes | comparable |
| Supabase hosting | currently static-storage-based beta; SPA support limited | — | — | check current capability at decision time |
| Self-hosted (nginx on VM) | yes (manual) | manual | manual | full control, full ops burden — contrary to SaaS pilot posture |

Recommendation (subject to D10): any of the first three satisfies the
technical requirements; selection criteria are the custom domain
(`app.setura.in`), TLS automation, and deploy-provenance hooks.
Source-map policy: production builds currently emit default Vite
sourcemap behavior — **production builds must set
`build.sourcemap: false`** (or upload maps privately) since thin-client
error handling (§ Phase 6) was designed assuming no backend detail
leaks; public maps partially undo that. Cache: hashed assets are
immutable by default; `index.html` must be `no-cache` so a rollback
reaches users.

---

## 9. Secret architecture

```text
Developer/local          apps/web/.env.local + local supabase start        (git-ignored; fake local values only)
        ↓ never promoted
CI                       GitHub Actions encrypted secrets + environments   (per-env scoping)
        ↓ never printed
Edge Functions           Supabase platform secrets (supabase secrets set)  (names in manifest; values never)
        ↓ separate system
Database scheduler       Supabase Vault (vault.decrypted_secrets)          (setura_scheduler_api_key, setura_cron_secret — migration 53)
        ↓ never mixed
Frontend                 build-time VITE_* PUBLIC values ONLY              (URL + anon key)
```

Explicit confirmation (Phase 6 §H boundary preserved):
`SUPABASE_SERVICE_ROLE_KEY`, `RAZORPAY_KEY_SECRET`, `META_APP_SECRET`,
`CRON_SECRET`, `WORKER_SECRET` — and the Vault-held
`setura_scheduler_api_key` — **must never appear in the browser
bundle, in `VITE_*` variables, in `git ls-files`, in CI logs, or in
`migration_registry` text.** `RAZORPAY_KEY_ID` and the anon key are the
only credential-shaped values that may be client-visible (anon key is
public by design under RLS).

## 10. Vault architecture

- Vault lives **inside the database**; it is provisioned per environment
  by an operator action (SQL/dashboard), never by a committed migration
  (migrations must not carry secret values — the current chain already
  complies: migration 53 only *reads* named secrets).
- Required rows before the scheduler can do anything beyond fail-closed
  no-op: `setura_scheduler_api_key` (a key permitted to call
  `/functions/v1/*`), `setura_cron_secret` (must equal the platform
  `CRON_SECRET`), and non-secret `public.scheduler_http_config`
  base-URL = the project's functions URL.
- Rotation runbook (design): update Vault + platform secret together,
  then one manual `SELECT scheduler_fire_minute()` proves the pair.
- Production Vault state today: **NOT IMPLEMENTED** (no production DB).

---

## 11. Scheduler & worker deployment sequence (dependency-checked)

Scheduler first, worker inside its tick — this ordering comes from the
actual architecture (migration 53's minute job fires `run-cron-minute`,
which conditionally wakes `run-background-worker` only when
`ENABLE_WORKER_TRIGGER=true`):

```text
9a. scheduler: create Vault secrets → set scheduler_http_config →
    verify cron.job exists on hosted project (D7) → observe
    cron.job_run_details succeeds ≥ 2 consecutive minutes →
    verify run-cron-minute 200s with X-Cron-Secret (and 403 fail-closed
    without it — the Kong-401 trap means checking the BODY)
9b. worker: decide D6; if true: set ENABLE_WORKER_TRIGGER +
    WORKER_SECRET, confirm job_queue pending→completed movement and
    dead_letter_jobs stays empty under normal load
```

A deployment where the scheduler runs while
`ENABLE_WORKER_TRIGGER=false` produces *exactly the symptoms AGENTS §13
recorded locally* (pending jobs forever) — D6 is therefore a
go-live-blocking decision, not a cosmetic default.

## 12. Auth configuration deployment

Ordering constraint: **D3 (GoTrue seed NULL defect) must be resolved
before the first production staff accounts are created**, because the
defect class (GoTrue scanning NULL columns it expects defaulted) would
otherwise reproduce at pilot sign-in. Required config at this step:
`site_url` + `additional_redirect_urls` = final frontend origin;
`jwt_expiry` decision (3600 s default vs hospital shift reality);
SMTP provider + sender policy for password reset and staff invites.
All values are configuration, none are code; **status NOT IMPLEMENTED**.

---

## 13. External integrations (staged, each gated by user authorization)

```text
Razorpay: test-mode keys → staging webhook registration → real
          payment/refund round-trip in test mode → live keys →
          production webhook (payment.captured / refund.processed) →
          one minimal-value live transaction.  [BLOCKED until authorized]
Meta:     business app + WhatsApp BCP → dev-number webhook on staging
          callback (GET verify + POST HMAC) → template approval →
          pilot opt-in flow → production callback.     [BLOCKED]
SMTP:     provider + DKIM/SPF for setura.in → reset-email round-trip
          test on staging.                              [BLOCKED]
```

Rationale for staging-before-live everywhere: signature handling,
order creation, refunds, delivery and 429 storms were explicitly
listed as untested-by-design locally (master roadmap §uncertainties 3).

## 14. Production smoke tests (post-deploy battery)

```text
S1  unauthenticated GET/POST to every function ⇒ expected auth error body (not just status)
S2  machine endpoints: wrong secret ⇒ 403 with function-level error shape
S3  privilege catalog re-measure vs RPC_PRIVILEGE_MODEL classification (closes G7-04)
S4  fresh-reset equivalence: migrations applied count == manifest == 56(+N)
S5  one authenticated staff login ⇒ role resolution ⇒ RLS cross-tenant read = 0 rows
S6  E1 through console: walk-in→token→queue→doctor→consult→snapshot→history
S7  enqueue→claim→complete through the real scheduler+worker path (autonomy proof)
S8  DLQ visible + monitoring-health-check + alert-center reachable and reporting
S9  rollback artifact availability verified (previous tag pullable/buildable)
```

E1-in-production (S6) is the Phase 7 acceptance line; until it passes,
every production claim stays BLOCKED.

## 15. Rollback strategy

| Layer | Mechanism | Caveat |
| --- | --- | --- |
| Database | **Forward-fix only.** Supabase PITR (if tier provides — depends on D5) as the emergency path. Migrations are additive; a corrective migration, not an edit, reverses a bad change. | Migrations 15/22 partitioning + 23 retention make naive `down` scripts unsafe; NEVER assume reversal. PITR availability with pg_cron jobs + Vault rows must be verified when D5 is decided (restore can silently drop cron registrations). |
| Edge Functions | Redeploy previous tag (CLI is per-commit deterministic given lockfile); `supabase functions delete`+redeploy for statelessness | Functions hold no state; in-flight invocations drain naturally |
| Frontend | Re-point host to previous immutable build artifact | `index.html` no-cache (§8) makes this user-visible immediately |
| Configuration | Config versioning + rollback engine (migration 18) already exists for *hospital* config; platform config rollback = secret-name manifest + config.toml in Git | feature flags (37) + config versioning give per-hospital blast-radius control |
| External integrations | Re-point Razorpay/Meta webhook URLs to staging (dashboard action), which instantly pauses live side effects while the product stays readable | Webhook replay after re-point must dedup via existing idempotency (unique constraints) |
| Audit trail | Every rollback is itself an audited event + release-record entry | — |

## 16. Release strategy

CalVer-not-needed: semver tags from `main` only; RC = tag pushed →
staging auto-deploy → human approval → production. `DEPLOYMENT_VERSION`
= tag on both platform secrets and frontend build so logs from every
layer carry the same version string. Rollforward-to-fix is the default;
rollback is the exception path.

## 17. Production gates (design; current honest state)

| Gate | Definition | State now |
| --- | --- | --- |
| A repository integrity | hygiene commit done; root .gitignore; local artifacts untracked; manifest generated | **IN PROGRESS — repo exists but is dirty (§2); NOT PASS** |
| B CI green on main | both jobs + additions actually run green on GitHub | UNPROVEN (workflow file exists; run status never measured) |
| C migration validation | `validate:migrations` 0 errors + checksum ledger green + append-only | Locally green pre-ledger; ledger NOT IMPLEMENTED |
| D security regression | S1 suite + privilege tests green on release candidate | PROVEN (local) — production variant stays blocked by G |
| E financial regression | Phase 3 suites + refund/settlement green | PROVEN (local) |
| F worker/scheduler regression | W1 4/4 + 7/7 + scheduler 3/3 + live cron counters | PROVEN (local, 2026-09-19 — this session) |
| G production privilege verification | catalog census on deployed DB matches locked-routine TSV | BLOCKED (no deployment) — closes G7-04 |
| H external integration verification | Razorpay/Meta/SMTP round-trips in staging | BLOCKED (credentials) — G7-05/06 |
| I frontend E1 in production | §14 S6 pass on real domain | BLOCKED |
| J rollback readiness | previous tag builds; forward-fix migration template; PITR/backup per D5 | NOT IMPLEMENTED |

No gate is declared PASS on the production dimension by this document.

## 18. Deployment order (verified against architecture, corrects the brief's sketch)

The suggested order is *nearly* right; two dependencies change it:
Auth config (site_url) must exist **before** the frontend deploys or
callback validation fails, and Vault/base-URL must exist **before** the
scheduler can do anything, while worker-triggering must be decided
**with** the scheduler activation:

```text
1  production Supabase project (Postgres 17; D5 tier w/ PITR decided first)
2  link + extensions availability check (pg_cron/pg_net/Vault on hosted — D7 probe)
3  migrations (db push) → verify: 56/56 + registry + self-check NOTICEs
4  privilege verification battery (Gate G) — BEFORE any traffic
5  platform secrets (all names from reconciliation §6; APP_ENV=production; ALLOWED_ORIGINS=final domain)
6  Vault rows + scheduler_http_config
7  Edge Functions deploy (config.toml verify_jwt entries committed first)
8  function smoke S1–S4 (cold-start secret coverage included)
9  Auth config (site_url/redirects/jwt_expiry/SMTP)  ← moved ahead of frontend
10 scheduler activation + 2-tick autonomy observation (§11 9a)
11 worker enablement decision executed (§11 9b)
12 frontend build (tagged artifact) + hosting deploy to final domain
13 S5–S6 authenticated E1 on production
14 external integrations per §13, each with its own authorization
15 release record committed (provenance bundle)
```

## 19. Open decisions (DEFERRED — not silently resolved)

D3 GoTrue seed defect classification · D5 backup/PITR tier & retention
policy · D6 `ENABLE_WORKER_TRIGGER` production default · D7 hosted
pg_cron/pg_net/Vault behavior probe · D8 track `graphify-out/`? ·
D9 track `.qoder/repowiki/`? (recommend: no) · D10 hosting provider ·
D11 Git remote/provider confirmation (current GitHub repo is
user-owned personal account — org/transfer decision for a commercial
SaaS?) · D12 `jwt_expiry`/session policy · D13 Razorpay/Meta/SMTP
providers & credentials (user-only) · D14 branch-protection admins ·
D15 whether evidence logs (`_g701_*` etc.) belong in Git history.

## 20. Security constraints (non-negotiable in every future step)

- Least privilege at both boundaries is preserved through deploys:
  Gate G must run **before** exposing any endpoint to users; F16-04
  discipline (explicit REVOKE per new/resignatured SECURITY DEFINER
  function) becomes a mechanical CI lint.
- No secret ever transits: Git, CI logs, frontend bundle, migration
  text, or this repository's reports.
- RLS/tenancy posture is never weakened to ease deployment (a test
  that needs it is wrong, not the RLS).
- Webhook authenticity (Meta HMAC, Razorpay HMAC, cron/worker shared
  secrets) stays fail-closed; the Kong-401-masking trap means every
  auth-related smoke assertion must verify the response body/SQLSTATE.
- `supabase/.temp/linked-project.json` leaves tracking; anyone who can
  push to `main` gains deploy reach only *after* environment-approval
  controls exist — until then, treat the absence of protection as an
  open risk, not a convenience.
- Idempotency, lease, and audit invariants from §8–§12 of AGENTS.md
  apply unchanged to production traffic; a rollback must not strand
  claimed jobs (reclaim invariant is G7-01-proven locally).

## 21. Implementation plan (future sessions, each needing approval)

```text
I-1  hygiene commit: root .gitignore + rm --cached list + MANIFEST.sha256
I-2  CI extensions (§5 additions) on a feature branch, PR into main
I-3  branch protection + GitHub environments (staging/production, approvers)
I-4  staging Supabase project + full §18 run against STAGING only
I-5  D-table decisions (D3, D5, D6, D7, D10…) resolved with user
I-6  production project + §18 run with per-step approval stops
I-7  external integrations staging→live per §13
I-8  E1 production acceptance (S6) → pilot prerequisites re-check
```

## 22. What requires explicit user authorization (everything below)

1. Any `git push` beyond current state, history changes, remote changes,
   repo transfer/org move, branch protection activation.
2. The hygiene commit (untracking files is a visible history event).
3. Creating/linking any Supabase project (staging or production).
4. `supabase db push` / `functions deploy` / `secrets set` against any
   hosted project.
5. Vault row creation; `scheduler_http_config` value.
6. Razorpay/Meta/SMTP account creation, keys, webhook registration.
7. Frontend hosting account, domain DNS for `setura.in`, TLS.
8. Real test transactions or real WhatsApp messages (even test-mode).
9. Pilot hospital data onboarding.
10. Resolving any D-decision on the user's behalf is NOT authorized by
    silence — each needs an explicit ruling recorded in this file.

## 23. Executive answer to the operating question

*Can we establish a controlled, auditable, reversible path from this
exact source tree to production without weakening security, financial
correctness, tenant isolation, migration integrity, or operational
recovery?*

**Yes — and the path is now materially shorter than the reconciliation
believed, because the transport already exists.** The remaining gaps
are procedural, not architectural: repository hygiene (one commit),
CI/CD extension (design complete above, files never written), two
technical unknowns that only a provisioning session can probe (D7
hosted extension behavior; D3 seed defect), and the four credential/
project creations that are strictly user-authorized acts. Migration
integrity can be enforced mechanically from the moment a checksum
manifest is committed; security posture transfers cleanly because the
privilege boundary is catalog-verifiable per environment (Gate G).
Nothing in this design requires weakening any existing invariant.

---

```text
G7-02:
PLANNED — NOT IMPLEMENTED

Production:
NOT STARTED

Credentials:
NOT CREATED

Deployment:
NOT PERFORMED

Git:
ALREADY PRESENT (premise correction: repo + GitHub remote exist;
NOT initialized or modified by this session — hygiene/CI work is
planned, unexecuted, and authorization-gated)

Next step:
EXPLICIT USER AUTHORIZATION REQUIRED BEFORE
REPOSITORY HYGIENE CHANGES, CI/CD IMPLEMENTATION,
OR ANY DEPLOYMENT TRANSPORT ACTION
(I-1 hygiene commit is the proposed first authorized action)
```
