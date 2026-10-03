# WS-CONF-1 — Hospital Cancellation Policy Configuration — Implementation Report

**Workstream:** WS-CONF-1 — Hospital Cancellation Policy Configuration
**Date:** 2026-10-03
**Tier reached:** INTEGRATION VERIFIED + RUNTIME VERIFIED (LOCAL) — NOT staging, NOT production
**Status:** CLOSED at the local tier

---

## 1. Objective

Close the Priority-1 technical-completion gap: a hospital's cancellation / refund
policy (`cancellation_policies`, migration 29) is read by the live refund engine
(`calculate_refund_amount`) and the WhatsApp cancellation flow, and every column
is operator-relevant — but until this workstream **no authorized write path
existed**. The only INSERTs in the repository are the auto-create trigger
(`trg_auto_cancellation_policy`) and a one-time backfill; configuring a real
hospital's policy required a developer to run raw SQL. WS-CONF-1 gives
`hospital_admin` (own tenant) and `global_admin` (any tenant) a canonical,
atomic, authorized, versioned and audited read/write surface plus an admin UI.

## 2. Scope decision (what was inspected first)

- Verified the gap against CURRENT source and the live local DB (grep of all
  INSERT/UPDATE sites for `cancellation_policies`; `pg_proc` census), not a
  stale report.
- Selected over fee-policy work (overlaps closed WS-ONBOARD-2
  `hospital_settings`) and over anything touching closed workstreams
  (WS-ONBOARD-1..5, WS-SEC-1, G-03..G-11, C2/C2b, G7-13, G7-16, WS-OPS-1).
- **IN scope:** migration 72 (two RPCs), `cancellation-policy` Edge Function,
  one audit action type, frontend api boundary + route + nav/route
  registration, DB + HTTP + frontend tests.
- **OUT of scope (would invent policy or reopen closed work):** any change to
  refund-calculation semantics (`calculate_refund_amount`, NPD-01 GST ruling),
  migration 29 itself, WhatsApp flow changes, D16 financial policy, staging or
  production deployment.

## 3. Design (reuse of established primitives, AGENTS.md §6/§7)

| Concern | Owner (pre-existing) | WS-CONF-1 role |
| --- | --- | --- |
| Policy storage + CHECKs | `cancellation_policies` (mig 29) | configures, never redefines |
| Version history | `trg_cancel_policy_history` (mig 29) | RPC bumps `version`; the existing trigger records the prior snapshot |
| Audit | `logAuditEvent` → `write_audit_log` (mig 36/39) | one `cancellation_policy_update` (high) event per successful mutation |
| Idempotency | `api_idempotency_keys` + `withIdempotency` (mig 25) | update mode requires `Idempotency-Key` |
| Tenant isolation | RLS (FORCE) + `resolveAuth(X-Hospital-ID)` | intact; RPC re-checks independently |
| Roles | `requireRole(['global_admin','hospital_admin'])` | reused verbatim |

Security posture (F16-04 standing rule): both new functions are SECURITY
DEFINER with `SET search_path=public`, `row_security=off`, their OWN explicit
`REVOKE` from PUBLIC / anon / authenticated and `GRANT` to service_role only.
DB-layer authorization is defense-in-depth: each RPC re-checks that
`p_actor_user_id` holds `global_admin` OR `hospital_admin` scoped to
`p_hospital_id` (else SQLSTATE 42501); client-supplied hospital identity never
drives tenancy.

Deliberate error-code choices: optimistic `expected_version` conflict raises
**P0001** (not 40001 — PostgREST treats class-40 as retryable and would turn a
benign conflict into a client timeout) → HTTP 409 `DB_CONCURRENCY_ERROR`;
unknown/system keys and range/tier violations → **22023** → HTTP 422; missing
row (after actor authorization passed) → **P0002** → HTTP 403 without
disclosure.

## 4. Changes

### 4.1 `supabase/migrations/72_ws_conf_1_cancellation_policy_configuration.sql` (new)
- `get_cancellation_policy(p_actor_user_id, p_hospital_id) RETURNS JSONB`
  (STABLE): authorize → load row → compose `{ok, hospital_id, version, policy,
  history[]}` (recent 20 history snapshots, `created_at DESC`).
- `update_cancellation_policy(p_actor_user_id, p_hospital_id,
  p_expected_version, p_patch) RETURNS JSONB` (VOLATILE): authorize →
  `SELECT … FOR UPDATE` → expected-version check (P0001) → reject
  unknown/system-managed keys (22023) → cast + range-validate each editable
  field → enforce the `valid_refund_tiers` ordering (full ≤ partial) →
  `UPDATE … version = version + 1` (CHECK violations caught → 22023, PostgreSQL
  text never leaked) → `{ok, reason: updated|noop, hospital_id, version}`.
- Editable allowlist (exactly the migration-29 operator columns):
  `full_refund_within_minutes`, `partial_refund_within_minutes`,
  `partial_refund_percentage`, `same_day_refund_percentage`,
  `no_show_penalty_enabled`, `no_show_penalty_amount_inr`,
  `allow_manual_full_refund`, `notes`. `id`, `hospital_id`, `version`,
  `effective_from`, `created_at`, `updated_at`, `metadata` are system-managed.
- Registers the `cancellation_policy_update` audit action type (high, system).

### 4.2 `supabase/functions/cancellation-policy/index.ts` (new)
Canonical Edge shape: `handleCors` → POST gate → `resolveAuth(req,
X-Hospital-ID)` → `requireRole` → `parseBody` (Zod discriminated union; strict
patch schema mirrors RPC limits so bad values are 422, not 500) →
read: RPC / update: `extractIdempotencyKey(req, true)` → `withIdempotency(
update RPC → logAuditEvent inside the handler)` → `successResponse` /
`handleErrorResponse`. `mapRpcError`: 42501/P0002 → 403 FORBIDDEN, P0001 → 409
DB_CONCURRENCY_ERROR, 22023/23514/22P02 → 422 VALIDATION_ERROR, else 500.

### 4.3 `supabase/functions/_shared/audit.ts`
Added `"cancellation_policy_update"` to the `AuditActionType` union.

### 4.4 Frontend (`apps/web`)
- `src/types/api.ts`: `CancellationPolicySnapshot` / `…HistoryEntry` /
  `…ReadResponseBody` / `…UpdateResponseBody`.
- `src/api/cancellationPolicy.ts`: the ONLY browser boundary; read carries no
  Idempotency-Key, update always forwards one; hospital id rides the transport
  header only, never the body.
- `src/routes/CancellationPolicy.tsx`: admin form over the tenant's policy —
  server-authoritative load, minimal field-level diff (`buildPatch`, exported
  for tests, mirrors every backend limit including the full ≤ partial tier
  rule), one stable key per logical save via `useAsyncAction`, honest banners
  ("Saved. New version N." only after server 200; 409 shown with Reload; 422
  surfaces the client-safe message), version-history card, UX role guard.
- `src/App.tsx` + `src/components/AppShell.tsx`: `/admin/cancellation-policy`
  route (guarded by `ADMIN_ROLES`) + nav entry for `hospital_admin` /
  `global_admin`.

### 4.5 Supporting
- `supabase/migrations/MANIFEST.sha256`: 72/72 lines via the canonical
  `--update` mechanism.
- `supabase/functions/_shared/database.generated.ts`: regenerated from the
  live DB after migration 72 was applied.

## 5. Migration application note (honest record)

`supabase db push` reported success but did NOT commit migration 72's functions
(migration-tracking table out of sync — 71 is likewise unregistered while its
objects exist). Migration 72 was therefore applied **directly via psql into the
live local DB** with `ON_ERROR_STOP=1`, which succeeded cleanly. The applied
local state is verified in §6. This CLI/tracking drift is a pre-existing LOCAL
environment condition, not caused by WS-CONF-1; it must be reconciled before
any staging/production application (see §9).

## 6. Verification evidence (all runs local, 2026-10-03)

| Check | Command | Result |
| --- | --- | --- |
| Live catalog ACL | `pg_proc` query in the running local DB | both functions exist, `prosecdef=t`, owner `postgres`, ACL `{postgres=X/postgres, service_role=X/postgres}` — no PUBLIC/anon/authenticated grant |
| Type check | `deno task check` | exit 0 (after one real test-file type error fixed) |
| Lint | `deno task lint` | exit 0, 122 files |
| Format | repo `deno task fmt:check` | exit 0 (only WS-CONF-1 files were touched by targeted `deno fmt`) |
| Migrations | `deno task validate:migrations` | 72 files, 0 errors, 6 warnings — 4 pre-existing `[duplicate-objects]` + 2 pre-existing `[rollback-risk]` on migration 70 (not WS-CONF-1) |
| Manifest | `validate:migration-manifest` | 72 migrations / 72 lines, 0 integrity issues |
| Types freshness | `deno task gen:types:check` | `database.generated.ts` UTF-8 and up to date |
| **New DB suite** | `deno test … cancellation_policy.test.ts` | **12 passed / 0 failed** (read authz 42501, cross-tenant 42501, version bump + history via existing trigger, stale version P0001, noop, system/unknown keys 22023, out-of-range 22023, cross-tenant write denied + target unchanged, global_admin any-tenant) |
| **New HTTP suite** | `deno test … cancellation_policy_http.test.ts` | **16 passed / 0 failed** against the live Edge Runtime (200 read/update, idempotent replay returns stored version with exactly ONE audit row, missing key 400, cross-tenant 403 HOSPITAL_ACCESS_DENIED with no DB write, doctor 403 ROLE_INSUFFICIENT, unauthenticated 401, stale 409 DB_CONCURRENCY_ERROR, out-of-range/unknown-field 422, noop `updated:false`, global_admin update on another tenant) |
| Backend regression | hospital_configuration (DB+HTTP) + booking_fee_refund + refund_sync | **45 passed / 0 failed** — no regression in the closest primitive family or in the refund-engine consumer suites |
| Backend unit | `deno task test` | 113 passed / 0 failed |
| **New frontend tests** | `vitest run` on the 2 new files | **23 passed** (api boundary payloads/keys/error propagation; `buildPatch` equivalence incl. NUMERIC string/number, every limit, tier rule; component guard/load/save/409/422/disabled-save behavior) |
| Frontend full suite | `npx vitest run` (apps/web) | **554 passed / 0 failed, 39 files** — route/nav registration caused no regression |
| Frontend types | `npx tsc --noEmit` | exit 0 |
| Edge serving | route probe: POST `/functions/v1/cancellation-policy` unauth | 401 (JWT gate) — function is served, not 404 |

Evidence classes: migration + RPCs + Edge + HTTP behavior = **INTEGRATION
VERIFIED (local real stack)** and **RUNTIME VERIFIED (local)**; frontend =
**UNIT VERIFIED (jsdom component tests) + statically type-checked**. A
one-field browser walkthrough of the new page was NOT performed this session —
recorded as UNPROVEN in §9, not claimed.

## 7. Product-gap closure

Operator path now: hospital_admin (or global_admin) signs in → nav
"Cancellation Policy" → sees the tenant's current policy + version history →
edits windows/percentages/penalties/notes → Save (idempotent, version-checked,
audited). **No developer SQL, no source edit, no environment change.**
Refund-calculation semantics are untouched: `calculate_refund_amount` remains
the sole consumer of these values; D16 is unaffected (this configures the
hospital's own policy inputs, it never moves money or edits a ledger).

## 8. Git hygiene (§20)

Nothing committed or pushed. WS-CONF-1 files: the 9 paths in §4 + 2 new test
files. The working tree additionally carries PRE-EXISTING uncommitted changes
from earlier sessions (WS-ONBOARD-5 / WS-SEC-1 / WS-OPS-1 reports, functions,
migrations 70–71, tests, and a `deno.json` edit adding
`worker_concurrent_claim` + `soak:autonomy` — verified NOT made by this
workstream) plus scratch `_conf_*` / `_tsc_conf*` logs from this session's
verification runs.

## 9. Remaining blockers / open items (NOT proven by this report)

1. **Staging/production:** UNPROVEN — nothing deployed; this is local-tier
   evidence only.
2. **Migration-tracking drift (§5):** the local `supabase_migrations`
   registry does not list 71/72 though their objects are live. Must be
   reconciled (`supabase migration repair`) before the next `db push`-based
   environment build, or migration 72 could be double-applied / skipped in a
   fresh pipeline.
3. **Browser walkthrough** of `/admin/cancellation-policy` against the live
   stack: not executed this session (component tests + real-HTTP backend cover
   the behavior; classify UI-in-a-real-browser as UNPROVEN).
4. No scheduler exists (NPD-05) and `claim_jobs_v2` lease gap (P0-01) remain
   open repo-wide — untouched by and irrelevant to this workstream.

## 10. Final status

**WS-CONF-1: IMPLEMENTED; DB contract INTEGRATION VERIFIED (local, 12/12);
HTTP contract INTEGRATION VERIFIED (local, 16/16); adjacent suites PASS
(45/45); backend unit PASS (113/113); frontend PASS (554/554 incl. 23 new);
static checks (check/lint/fmt/migrations/manifest/gen-types/tsc) all exit 0;
live local catalog ACL VERIFIED. PRODUCTION: UNPROVEN (no deployment).**
