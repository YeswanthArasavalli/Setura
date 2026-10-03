# SETURA — MIGRATION STATE RECONCILIATION — LOCAL

**Date:** 2026-10-03
**Scope:** Reconcile the local `supabase_migrations.schema_migrations`
registry against the migrations that already exist as files on disk and whose
objects already exist in the running local database.
**Trigger:** `WS_CONF_1_HOSPITAL_CANCELLATION_POLICY_CONFIGURATION_IMPLEMENTATION_REPORT.md`
§5 + §9 (item 2) — `supabase db push` misbehaved because migrations 71 and 72
were applied out-of-band but not recorded in the tracking registry.
**Tier reached:** LOCALLY VERIFIED. Nothing deployed. Nothing pushed. No
historical migration file was edited. No data was modified.

Final status block:

```text
MIGRATION STATE RECONCILED — LOCALLY VERIFIED
```

---

## 1. What was actually inconsistent

Repository state (before):

| Layer | Value |
| --- | --- |
| `supabase/migrations/*.sql` on disk | 72 files (01 … 72) |
| `supabase/migrations/MANIFEST.sha256` | 72 lines, hashes match |
| `supabase_migrations.schema_migrations` (LOCAL DB) | 70 rows, `max(version)=70` |
| Live local catalog | Migration 71 + 72 objects all present (see §3) |
| `supabase migration list --local` (before repair) | Rows 71 / 72 shown with Local set but the Remote (local-DB tracking) column blank |
| `supabase db push --dry-run --local` (before repair) | Would attempt to re-apply 71 and 72 (this is the drift WS-CONF-1 recorded) |

Diagnosis class: **tracking metadata drift** — objects were applied directly
via `psql` during WS-CONF-1 (documented in its report §5), but the Supabase
CLI's migration-tracking table was never told they had been applied. Nothing
about the actual database, schema, functions, ACLs or business data was wrong.
This is exactly the pre-condition the WS-CONF-1 report warned must be closed
before any future `db push`-based environment build.

## 2. Non-negotiables honoured

Per task contract §4 + §5 and `AGENTS.md` §11:

- Historical migration files `01 … 72` were **not** edited, renamed, deleted
  or regenerated. Their SHA-256 hashes in `MANIFEST.sha256` were not touched.
- No `supabase db reset` was run. No `db:push` was executed against any
  environment (only `--dry-run`).
- No migration was rerun. No business data was modified. No function was
  recreated, resignatured or re-granted.
- The reconciliation used only the repository/Supabase-supported mechanism
  (`supabase migration repair --status applied --local`) — no hand-edits to
  `supabase_migrations.schema_migrations`.
- Nothing was pushed to a linked/remote/staging/production project. Local only.

## 3. Proof the objects already exist (measure, do not assume)

Task §6 + §7 required verifying migration 71 and 72's objects against the
live catalog, not merely trusting that their files exist. All measurements
below were taken against the running local Supabase Postgres via
`supabase db query` on 2026-10-03.

### 3.1 Migration 71 — WS-ONBOARD-5 objects

| Object | Verification | Result |
| --- | --- | --- |
| `public.hospitals.activated_at` column | `information_schema.columns` | PRESENT (TIMESTAMPTZ, nullable) |
| `public.validate_hospital_configuration(uuid, uuid)` | `pg_proc` join `pg_namespace` | PRESENT |
| ↳ `prosecdef` | `pg_proc.prosecdef` | `true` (SECURITY DEFINER, matches migration 71 §2) |
| ↳ `proconfig` | `pg_proc.proconfig` | `{search_path=public, row_security=off}` ✓ |
| ↳ `proacl` | `pg_proc.proacl` | `{postgres=X/postgres, service_role=X/postgres}` — `anon` / `authenticated` EXECUTE **absent** ✓ (F16-04 discipline) |
| `public.set_hospital_activation(uuid, uuid, boolean)` | `pg_proc` | PRESENT |
| ↳ `prosecdef` / `proconfig` / `proacl` | same shape | Identical ✓ |
| `audit_action_types` row `hospital_activation` | `SELECT ... WHERE action_type='hospital_activation'` | PRESENT · severity `high` · category `system` ✓ |

### 3.2 Migration 72 — WS-CONF-1 objects

| Object | Verification | Result |
| --- | --- | --- |
| `public.get_cancellation_policy(uuid, uuid)` | `pg_proc` | PRESENT · SECURITY DEFINER · `search_path=public` · `row_security=off` |
| ↳ `proacl` | `pg_proc.proacl` | `{postgres=X/postgres, service_role=X/postgres}` ✓ |
| `public.update_cancellation_policy(uuid, uuid, integer, jsonb)` | `pg_proc` | PRESENT · same security shape |
| ↳ `proacl` | `pg_proc.proacl` | `{postgres=X/postgres, service_role=X/postgres}` ✓ |
| `audit_action_types` row `cancellation_policy_update` | `SELECT ... WHERE action_type='cancellation_policy_update'` | PRESENT · severity `high` · category `system` ✓ |

Because every object each migration creates is measured as already live with
the exact ACL and configuration the migration specifies, marking 71 and 72
`applied` in the registry accurately describes reality. Task §9 forbids
marking a migration applied if its objects are absent — verified they are
present, therefore the applied status is honest, not fabricated.

### 3.3 Cross-check for other tracking drift

Task §2 instructed not to assume only 71/72 are wrong. Before repair:

- `SELECT COUNT(*), MAX(version::int), BOOL_AND(version::int BETWEEN 1 AND 72)`
  from `supabase_migrations.schema_migrations` → `70 / 70 / true`.
- `supabase migration list --local` before repair showed exactly two rows
  where the Local file existed but the local-DB tracking column was blank:
  71 and 72. Rows 01 … 70 were aligned.
- `MANIFEST.sha256` line count vs `.sql` file count → `72 / 72` (task §8
  expected result, met without any manifest edit).

No other tracking inconsistency exists.

## 4. The repair command

```
supabase migration repair --status applied --local 71 72
```

CLI output:

```text
Connecting to local database...
Repaired migration history: [71 72] => applied
Finished supabase migration repair.
```

Effect (per Supabase CLI semantics + task §4 requirements): a single INSERT
into `supabase_migrations.schema_migrations` recording version `71` and
version `72` as applied. It does NOT execute the migration files. It does
NOT recreate objects. It does NOT modify data. It only aligns the ledger
with the already-verified reality.

## 5. Post-repair proof

### 5.1 Registry is coherent

```
supabase db query "SELECT COUNT(*) AS total, MAX(version::int) AS max_v,
    BOOL_AND(version::int BETWEEN 1 AND 72) AS in_range
    FROM supabase_migrations.schema_migrations;"
```

Result:

```text
total=72  max_v=72  in_range=true
```

`supabase migration list --local` now shows every row 01 … 72 with **both**
the Local-file column and the local-DB tracking column populated.

### 5.2 A future `db push` is no longer confused

```
supabase db push --dry-run --local
```

Result:

```text
DRY RUN: migrations will *not* be pushed to the database.
Connecting to local database...
Skipping migration MANIFEST.sha256... (file name must match pattern "<timestamp>_name.sql")
Remote database is up to date.
```

"up to date" is the required post-repair signal: the CLI now sees a coherent
chain and would not attempt to reapply 71 or 72 in a future environment
build. Task §10's critical requirement is met.

### 5.3 Manifest + migration validator still pass

```
deno task validate:migrations
```

Result:

```text
Migration validation: 72 files scanned
  WARN [rollback-risk] 70_ws_sec_1_doctor_schedule_leave_direct_write_hardening.sql:72
  WARN [rollback-risk] 70_ws_sec_1_doctor_schedule_leave_direct_write_hardening.sql:75
  WARN [duplicate-objects] 20_presence_engine.sql:31
  WARN [duplicate-objects] 22_partition_automation.sql:387
  WARN [duplicate-objects] 22_partition_automation.sql:529
  WARN [duplicate-objects] 47_enterprise_command_center.sql:83
Result: 0 error(s), 6 warning(s)
```

Zero errors. Six warnings are all pre-existing and were already recorded in
prior closure reports (2 rollback-risk TRUNCATEs inside the closed WS-SEC-1
migration 70 and 4 duplicate-objects on migrations 20/22/47 that are guarded
by `IF NOT EXISTS`). No new defect. Manifest was already 72/72 correct and
was not edited.

### 5.4 Application behavior unchanged (regression evidence)

Task §12 required targeted regression proving the repair changed tracking
only, not behavior. Rather than a narrow subset, the full integration suite
was executed against the live local stack — this is the strongest available
local evidence and the suite was already warm:

```
deno task test:integration
→ ok | 537 passed | 0 failed (2m45s)
```

Coverage that matters for this reconciliation:

- **WS-ONBOARD-5 (`hospital_activation.test.ts`, `hospital_activation_http.test.ts`)**
  — validation + activation still pass; the WS-ONBOARD-5 RPC ACL boundary
  remains intact (already asserted inside those suites; not weakened here).
- **WS-CONF-1 (`cancellation_policy.test.ts`, `cancellation_policy_http.test.ts`)**
  — cancellation-policy read, update, version bump, optimistic conflict,
  audit, cross-tenant denial and Edge HTTP behavior all still pass.
- **Adjacent families** — clinical-configuration, hospital-configuration,
  integration-configuration, doctor-operations, booking / refund /
  settlement, worker, scheduler autonomy, privilege isolation, WhatsApp
  lifecycle — all still pass (contained inside the 537).

Because the repair is a pure metadata INSERT into
`supabase_migrations.schema_migrations` (a Supabase-owned ledger table with
no application consumer), the observed zero-diff in a 537-test integration
pass confirms the change was tracking-only, exactly as intended.

## 6. Files touched

Only one file was added to the repository. Nothing else was modified.

- **New:** `MIGRATION_STATE_RECONCILIATION.md` (this file).
- **Not touched:** every historical migration `01 … 72`, `MANIFEST.sha256`,
  any Edge Function, any test file, any frontend file, `deno.json`,
  `supabase/config.toml`, `database.generated.ts`.
- **Local-only side effects:** two new rows in the running local Postgres'
  `supabase_migrations.schema_migrations` (versions 71 and 72, `applied`).
  This is a Docker volume state change inside the local Supabase container;
  it is not a repository file change.

## 7. Prerequisites for migration 73 (task §11)

All six conditions cleared:

1. Migration 71 reconciled — ✅ registry row exists, objects verified.
2. Migration 72 reconciled — ✅ registry row exists, objects verified.
3. Manifest valid — ✅ 72 files / 72 lines / 0 errors / 4 pre-existing
   duplicate-objects warnings + 2 pre-existing rollback-risk warnings on
   closed WS-SEC-1 migration 70.
4. Migration tracking coherent — ✅ `max(version)=72`, 72 rows, no gaps.
5. Future `db push` no longer sees 71/72 as unexpected — ✅
   `db push --dry-run --local` reports "up to date".
6. Existing WS-ONBOARD-5 + WS-CONF-1 objects intact — ✅ `pg_proc` ACL +
   column presence re-measured after repair; 537 integration tests pass
   unchanged.

Migration 73 is now safe to create in a future workstream.

## 8. Remaining known limitations (honest)

1. **Local only.** Staging and production registries were not inspected or
   modified. The WS-CONF-1 report already records that nothing has been
   deployed. Production privilege state remains UNPROVEN per `AGENTS.md` §13.
2. **Not a Git repository.** `AGENTS.md` §13 records the working tree has no
   `.git`. File-change proof rests on direct inspection, not `git diff`.
3. **No push, no commit.** Per task §28, nothing was committed or pushed.
4. **`db push --dry-run` uses the "Remote" phrasing** even under `--local`.
   The reported "up to date" is against the local tracking table, matching
   `supabase migration list --local`.

## 9. Next-workstream selection state

Task §14 + §17 required selecting exactly one implementation workstream after
reconciliation. Given the current closure landscape (WS-ONBOARD-1..5,
WS-SEC-1, WS-CONF-1, WS-OPS-1 blocked for soak, G-02..G-11, C2, C2b,
G7-13, G7-16 all CLOSED locally as of this session) and inspecting the
current repository, the candidates that remain are:

| Candidate | Ready without owner input? | Reason |
| --- | --- | --- |
| NPD-05 scheduler production activation | **NO** | pg_cron + pg_net + `scheduler_fire_minute` + `scheduler_fire_nightly` are live locally (2 jobs registered) — production activation is an operator / hosting decision, not source code. |
| P0-01 `claim_jobs_v2` lease | **NO** (already closed) | Migration 51 shipped the fix; `worker_lease_persistence.test.ts::p0e` passes in the current integration suite. Reopening it would be an audit treadmill. |
| WS-OPS-1 worker autonomy + 24h soak | **NO** | Blocked by operator/runtime provisioning dependencies, already recorded in the WS-OPS-1 report. |
| Staging verification of any closed workstream | **NO** | Task §28 + prior workstream §"Staging UNPROVEN" require explicit owner authorization for controlled staging browser walks and staging projects. |
| Production deployment / domain (D13, D5) | **NO** | Explicitly DEFERRED BY OWNER per `PHASE_7_PRODUCTION_READINESS_RECONCILIATION.md`. |
| Fee configuration / refund semantics changes | **NO** | Would touch NPD-01 GST ruling or D16 financial policy — business decisions not yet ruled. |
| WhatsApp LLM intent routing | **NO** | `AGENTS.md` §10: "Do not introduce LLM intent routing unless explicitly requested." |
| Reopen a closed workstream to add features | **NO** | Task §19 forbids reopening closed work absent a proven regression, and no regression exists (537/537 pass). |

**Honest verdict:** after this session's migration reconciliation, **no
remaining workstream is unambiguously implementation-READY from the
repository side without an owner decision** (business policy, production
deployment authorization, staging authorization, or operator provisioning).

Per task §13's spirit (document the exact reason, do not invent a workaround,
do not stop pretending to certify), the correct classification for the
NEXT-WORKSTREAM portion of this session is:

```text
NEXT WORKSTREAM: BLOCKED — awaiting owner input
  (candidate list above; each row names its specific dependency)
```

The MIGRATION-STATE portion of the session completed cleanly and locally:

```text
MIGRATION STATE: RECONCILED — LOCALLY VERIFIED
```

Continuing to implement an arbitrary code change purely to avoid a "report
only" outcome would violate `AGENTS.md` §1 (extend the established
architecture against real requirements) and task §32 ("Do not invent
business policy"). The correct next action is a scoped owner decision, not
invented product surface.

## 10. Definition of Done (this session)

| DoD item | Evidence | Status |
| --- | --- | --- |
| Migration registry lists every file on disk | `SELECT COUNT(*), MAX(version::int) FROM supabase_migrations.schema_migrations` → `72, 72` | ✅ |
| Migration 71 objects measured live | `pg_proc` + `information_schema.columns` + `audit_action_types` | ✅ |
| Migration 72 objects measured live | `pg_proc` + `audit_action_types` | ✅ |
| ACL posture matches F16-04 requirement | Both new functions' `proacl` = `{postgres=X/postgres, service_role=X/postgres}`, `anon` / `authenticated` EXECUTE absent | ✅ |
| Manifest still canonical | `validate:migrations` 72 files, 0 errors; `MANIFEST.sha256` 72 lines untouched | ✅ |
| A future `db push` sees a coherent chain | `db push --dry-run --local` → "Remote database is up to date" | ✅ |
| No historical file edited | No `.sql` migration touched; verified via file inspection (tree is not a Git repository) | ✅ |
| No business data mutated | Only change is a metadata INSERT into `supabase_migrations.schema_migrations` for versions 71 and 72 | ✅ |
| Application behavior unchanged | `deno task test:integration` → 537 / 537 pass | ✅ |
| No push / no deploy / no commit | Nothing was pushed to any remote; no `git` action; no `vercel`/`supabase` remote push | ✅ |
| Next workstream selected | Blocked (see §9) — awaiting owner input | ⚠ BLOCKED |

## 11. Final status

```text
MIGRATION STATE RECONCILED — LOCALLY VERIFIED
NEXT WORKSTREAM: BLOCKED — OWNER DECISION REQUIRED
PRODUCTION: UNPROVEN (no deployment performed)
STAGING: UNPROVEN (no staging push performed)
```
