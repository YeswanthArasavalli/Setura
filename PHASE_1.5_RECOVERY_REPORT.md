# SETURA PHASE 1.5 RECOVERY REPORT

**Method:** read-only investigation against a freshly reset local database
(`supabase db reset`, exit 0, 47/47 migrations, seed OK), with the edge runtime
live (26 functions, edge-runtime 1.73.13). Every number below was executed, not
inferred. No project file has been modified in this phase.

---

## 1. Current repository state

| Dimension            | Value                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Working tree         | `d:\Projects\datasets\setura`, not a git repository — no VCS history, no diff baseline, no rollback                 |
| Docker / local stack | Running. All containers healthy except `supabase_vector_setura` (restart loop, log-shipping only, non-blocking)     |
| Live PostgreSQL      | 17.6; `config.toml` `major_version = 17`                                                                            |
| Phase 1.5 status     | Substantially implemented, not certifiable. ~85% functional, 4 real defects, 1 critical platform-wide security hole |
| Completion report    | `PHASE_1.5_COMPLETION_REPORT.md` does not exist — correct; must not exist until gates pass                          |

---

## 2. Migration count

47 files, `01_*` → `47_enterprise_command_center.sql`. Latest =
`47_enterprise_command_center.sql` (80,912 b). All 47 recorded in
`supabase_migrations.schema_migrations`. No duplicate numbers, no gaps. Next
free number is 48.

---

## 3. Edge function count

26 deployed functions plus `_shared`. `_shared` holds 20 modules + 3
subdirectories (`enterprise/`, `queue/`, `whatsapp/`); `enterprise/` contains
exactly one module, `broadcasts.ts`.

---

## 4. SQL function count

479 functions in schema `public`.

---

## 5. SECURITY DEFINER count

193. Of those, 191 are EXECUTE-able by both `anon` and `authenticated`. Only 2
     are protected: `stop_worker(TEXT,BOOLEAN)` and
     `recalculate_queue_position(UUID)` — both from migration 39, the only
     migration that used the correct pattern.

---

## 6. Test count

| Suite                   | Files                                   | Result                            |
| ----------------------- | --------------------------------------- | --------------------------------- |
| Unit                    | 3                                       | 37 passed / 0 failed              |
| Integration             | 9                                       | 128 total → 121 passed / 7 failed |
| Phase 1.5 integration   | 1 (`enterprise_command_center.test.ts`) | 23 tests → 16 passed / 7 failed   |
| Prior-phase integration | 8                                       | 105 passed / 0 failed             |

All 7 failures are inside Phase 1.5. Every prior phase still passes — the frozen
platform is intact.

**Correction to the prior investigation:** `deno task test:integration`
type-checks before running, and the type error below aborts the whole task, so
zero integration tests execute via the task. The 121/7 split was obtained with
`--no-check`. My earlier report understated this.

---

## 7. Exact Phase 1.5 artifacts (verified, not assumed)

| Artifact       | Count      | Detail                                                                                                                      |
| -------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| Migration      | 1          | `47_enterprise_command_center.sql`, 13 sections, additive only                                                              |
| RPCs           | 31         | Verbatim list in the matrix below — the prior count of 31 is confirmed                                                      |
| New tables     | 2          | `alert_activity_log`, `alert_suppressions`                                                                                  |
| Altered tables | 1          | `alert_events` +8 columns (`acknowledged_at/by`, `assigned_to/at`, `escalated_at/by`, `resolution_notes`, `alert_category`) |
| Indexes        | 3 declared | 2 created; `idx_alert_events_open` silently skipped (see item 13)                                                           |
| Edge functions | 5          | `command-center`, `executive-analytics`, `financial-command-center`, `alert-center`, `enterprise-reports`                   |
| Shared modules | 1          | `_shared/enterprise/broadcasts.ts`                                                                                          |
| Tests          | 23         | all in `tests/integration/enterprise_command_center.test.ts`                                                                |
| Contract docs  | 2          | `docs/API_CONTRACTS.md` §2–§8 and `ARCHITECTURE.md` — both already document all 5 endpoints in detail                       |

---

## 8. Requirements: DONE / PARTIAL / MISSING / BROKEN

`docs/API_CONTRACTS.md` §2–§8 is the frozen functional contract and I treated it
as authoritative where the tests and implementation disagree.

| Area                             | RPCs                                                                                                                                                                                                    | Status                                    | Evidence                                                                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A Hospital Command Center        | `get_hospital_command_center`, `get_hospital_timeline`, `get_operational_scores`                                                                                                                        | PARTIAL — 1 BROKEN                        | Overview + scores exact against fixtures. `get_hospital_timeline` fails 100% of calls (SQLSTATE 42803). All 10 command-center actions present; timeline returns HTTP 500                               |
| B Executive Analytics            | `get_daily_operations_dashboard`, `get_weekly_dashboard`, `get_monthly_dashboard`                                                                                                                       | DONE + TESTED                             | All 7 contract actions present and passing                                                                                                                                                             |
| C Doctor Performance             | `get_doctor_performance`, `get_doctor_rankings`                                                                                                                                                         | DONE + TESTED                             | Exact: 12 min avg consult, 10 min wait, 33.3% completion, rank 1                                                                                                                                       |
| D Financial Command Center       | `get_financial_command_center`, `get_revenue_forecast`                                                                                                                                                  | PARTIAL                                   | Fee split, refunds, net, aging buckets, forecast determinism, tenant isolation all pass. `online_payments`/`offline_payments` count ₹0 placeholder rows — semantic defect (item 18)                    |
| E SLA & Operational Intelligence | `get_sla_dashboard` (+ `get_operational_scores`)                                                                                                                                                        | DONE + TESTED                             | Scores bounded 0–100; trend arrays shaped                                                                                                                                                              |
| F Alert Center                   | `is_alert_suppressed`, `log_alert_activity`, `acknowledge_alert`, `assign_alert`, `resolve_alert`, `escalate_alert`, `suppress_alerts`, `fire_managed_alert`, `get_alert_center`, `get_alert_analytics` | DONE (functionally) / PARTIAL (hardening) | Full lifecycle + dedupe + suppression windows + audit all pass. Missing index; both new tables have no RLS                                                                                             |
| G Multi-Hospital Portfolio       | `get_portfolio_dashboard`, `get_cross_hospital_benchmarks`                                                                                                                                              | DONE (functionally) / CRITICAL (security) | Aggregation exact. Reachable by unauthenticated `anon` — proven                                                                                                                                        |
| H Predictive Analytics           | `get_predictive_insights` (+ `get_revenue_forecast`)                                                                                                                                                    | DONE — honestly labelled                  | 100% deterministic arithmetic: historical rate × count, month-to-date proration with inputs disclosed. No regression, no statistics, no ML. No AI/ML claim anywhere in docs — §31 already satisfied    |
| I Executive Reports              | `generate_executive_report`                                                                                                                                                                             | PARTIAL — 2 of 8 BROKEN                   | `daily_hospital`, `weekly_operations`, `monthly_executive`, `doctor_performance`, `financial`, `sla` → OK. `settlement` and `audit` → SQLSTATE 42804. CSV/`pdf_ready` renderers OK. Audit trail broken |
| J Governance                     | `search_audit_logs`, `verify_audit_integrity`, `verify_settlement_integrity`, `verify_queue_integrity`, `verify_doctor_operations_integrity`, `verify_integration_matrix`                               | PARTIAL                                   | All 6 verifiers present and passing. `executive_report` audit entries are never written — a governance requirement silently unmet                                                                      |

### The 7 failures, individually diagnosed

| # | Test                                                        | Cause                                                                                                                                                                                                                                                                                                                 | Verdict                                      |
| - | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 1 | `timeline streams fired alerts` :572                        | `get_hospital_timeline` puts `ORDER BY e.ts DESC LIMIT n` outside the `jsonb_agg` subquery → `42803: column "e.ts" must appear in the GROUP BY clause`. Reproduced standalone via `psql`                                                                                                                              | IMPLEMENTATION                               |
| 2 | `financial command center reconciles exactly` :705          | `offline_payments = 3`, expected 1. `trg_auto_create_collection` (migration 07) fires `AFTER INSERT` on every booking, unconditionally — hospital A has 4 DCE rows (3 trigger + 1 manual), two with NULL fees. Sums still reconcile; only the counts differ                                                           | TEST (+ semantic question, item 18)          |
| 3 | `alert center listing and analytics are tenant-scoped` :943 | `assert(Array.isArray(center))`. `get_alert_center` returns `{alerts, counts}`. `API_CONTRACTS.md` §5 says list → `center`, an object. Contract and implementation agree; the test is wrong                                                                                                                           | TEST                                         |
| 4 | `report engine supports all 8 report types` :1017           | `COALESCE(public.get_reconciliation_summary(...), '{}'::jsonb)` — that function returns `TABLE(8 cols)`, and `get_audit_coverage_report` returns `TABLE(6 cols)`. `42804`: COALESCE types `record` and `jsonb` cannot be matched. Confirmed by enumerating all 8 types                                                | IMPLEMENTATION                               |
| 5 | `executive audit search filters` :1111                      | `p_severity: "info"` — `write_audit_log` takes `audit_action_severity = low\|medium\|high\|critical`. `info` belongs to the other enum, `alert_severity_level`. Also `p_action: "admin_action"` is not in the 56-row `audit_action_types` registry. This same line is the sole cause of the `deno task check` failure | TEST (§15 resolved: implementation is right) |
| 6 | `ent http: command-center overview and timeline` :1269      | HTTP 500 — same `42803` as #1, mapped to `InternalError`                                                                                                                                                                                                                                                              | IMPLEMENTATION (duplicate of #1)             |
| 7 | `ent http: report generation json/csv/pdf-ready` :1415      | `assertGreater(auditRows.length, 0)` → 0. Edge passes `entityId: body.reportType = "daily_hospital"` into `audit_logs.entity_id`, which is UUID. `logAuditEvent` is fire-and-forget and swallows the cast error                                                                                                       | IMPLEMENTATION                               |

**Net:** 4 distinct implementation defects, 3 test defects. No requirement is
MISSING — nothing in the §4 contract is unimplemented.

---

## 9. Security findings independently verified — CONFIRMED

**P0 — 191 `SECURITY DEFINER` functions are callable by `anon` and
`authenticated`.**

Root cause is not PostgreSQL's PUBLIC default, as the prior audit stated. `\ddp`
shows Supabase installs:

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO postgres, anon, authenticated, service_role;
```

These are explicit role grants. Therefore the 54
`REVOKE ALL ON FUNCTION ... FROM PUBLIC` statements across migrations 27–46 are
runtime no-ops. Two consequences:

1. My earlier per-migration "privilege coverage" credit table was invalid and is
   withdrawn.
2. Migration 47 is not a regression from a working baseline — the baseline never
   worked. This is a platform-wide latent defect that Phase 1.5 inherited and
   widened, not created.

Only migration 39 got it right, by revoking from PUBLIC, `anon` and
`authenticated` separately.

**Live exploit, executed:**

```sql
SET LOCAL ROLE anon;
SELECT public.get_portfolio_dashboard(CURRENT_DATE)->'hospitals';
-- → data for 5 hospitals
```

Unauthenticated cross-tenant financial disclosure. Demonstrated, not inferred.

**All 17 named suspects verified `secdef=t, anon=t, auth=t`:**

- `capture_payment` — both overloads — plus `idempotent_capture_payment`.
  Payment status mutation and immutable-ledger writes reachable without
  authentication.
- `create_platform_revenue_summary(uuid, date, date, uuid)` — exposed.
- All Phase 1.5 financial, portfolio, audit-search and alert-mutation RPCs —
  exposed.

**P1 confirmed:**

- WhatsApp HMAC fails OPEN. `if (appSecret && signature)` — secret absent or
  header absent → verification skipped entirely, body processed.
  `META_APP_SECRET` is `optionalEnv`. Only 1 of the 4 §11 cases is enforced.
- `whatsapp_conversation_states`: RLS off, FORCE off, 0 policies, and
  `anon SELECT` + `authenticated INSERT` — worse than the prior audit reported.
  (0 rows today, so no live PII yet.)
- `queue_runtime_events.queue_events_read`: `{authenticated}` SELECT
  `USING (true)` — verbatim, unscoped.
- `analytics_refresh_logs`: RLS off, `anon SELECT`.
- `alert_activity_log`, `alert_suppressions`: RLS off, FORCE off, 0 policies —
  but no table grants, so unreachable via PostgREST. Defense-in-depth gap, not a
  live breach.
- `system_settings` and `role_permissions`: `{public}` SELECT `USING (true)` —
  17 rows of pricing/GST/gateway-fee config readable by `anon`.

---

## 10. Security findings DISPROVED or downgraded

| Claim                                                                | Finding                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Migration 47 caused a privilege regression"                         | Disproved. 47 followed the same ineffective pattern as 27–46. The defect predates it                                                                                                                                                     |
| "The 54 `REVOKE ... FROM PUBLIC` statements protect those functions" | Disproved. Runtime no-ops                                                                                                                                                                                                                |
| "`alert_activity_log`/`alert_suppressions` are exposed"              | Downgraded. Grant-protected; depth gap only                                                                                                                                                                                              |
| "Financial/audit tables have weak RLS"                               | Disproved. `payment_orders`, `financial_ledger`, `hospital_settlements`, `settlement_items`, `payment_refunds`, `daily_collection_entries`, `audit_logs` all correctly scoped via `is_global_admin()` / `current_user_role(hospital_id)` |
| "Edge authorization is weak"                                         | Disproved. `executive-analytics` gates portfolio/benchmarks on `global_admin`; every hospital call passes the validated header. The edge layer is correct — the RPCs simply bypass it (§24 in practice)                                  |
| "Seed fails on `hospitals_slug_key`"                                 | Not reproducible. Fresh reset seeds cleanly                                                                                                                                                                                              |
| "`consultation_notes` exposed"                                       | Disproved. RLS on, no grants                                                                                                                                                                                                             |

---

## 11. Gate status (all executed on a fresh reset)

| Gate                            | Result                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `supabase db reset`             | ✅ exit 0 — 47/47 migrations, seed OK                                                                          |
| `deno lint`                     | ✅ PASS — 69 files                                                                                             |
| `deno fmt --check`              | 🔴 FAIL — 2 of 247. `enterprise_command_center.test.ts` (pre-existing Phase 1.5) and `SETURA_CLAUDE_REPORT.md` |
| `deno task check`               | 🔴 FAIL — TS2322, `enterprise_command_center.test.ts:1121`: Type `'"info"'` is not assignable to `'"critical"  |
| `deno task validate:migrations` | ⚠️ 47 scanned, 0 errors, 4 warnings                                                                            |
| `deno task test`                | ✅ 37 passed / 0 failed                                                                                        |
| `deno task test:integration`    | 🔴 aborts at type-check → 0 tests run. With `--no-check`: 121 passed / 7 failed of 128                         |
| Security suite                  | ⛔ does not exist                                                                                              |

**Disclosure:** the second fmt failure is mine. `SETURA_CLAUDE_REPORT.md` is the
file you asked me to create last turn; unformatted markdown moved the baseline
from "1 of 246" to "2 of 247". The genuine pre-existing Phase 1.5 failure is
`enterprise_command_center.test.ts`.

### The 4 validator warnings, classified (§27 — none labelled "pre-existing" without proof)

| Warning                                    | Classification                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `dashboard_presence` in migrations 11 + 20 | Intentional — `IF NOT EXISTS` guarded; 20 is the authoritative definition |
| `check_partition_readiness` in 15 + 22     | Intentional — `CREATE OR REPLACE`; 22 supersedes                          |
| `partition_health` view in 15 + 22         | Intentional — `CREATE OR REPLACE`; 22 supersedes                          |
| `idx_alert_events_open` in 24 + 47         | 🔴 REAL DEFECT, must be resolved — see item 13                            |

Prior completion reports claim "3 pre-existing warnings." The count is now 4;
the 4th is Phase 1.5's and is a genuine bug.

---

## 12. Documentation drift

| Document                         | State                                                                                                                                                                                                                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/API_CONTRACTS.md`          | 🟢 Accurate and complete — §2–§8 fully specify all 5 endpoints, every action, all 8 report types, and all 6 performance targets. Written at Phase 0.5 freeze as forward contract. Authoritative reference for this recovery                                                                     |
| `ARCHITECTURE.md`                | 🟡 Documents the enterprise endpoints, but says "PostgreSQL 15" — actual is 17.6. Dated Aug 11, predates migrations 40–47                                                                                                                                                                       |
| `ROADMAP.md`                     | 🔴 Zero occurrences of "1.5". Phase 1.5 does not exist in the roadmap; execution order reads `… 1.3 → 1.4 → 2 → 2.5 …`. Line 52 states "Finalize all 37 migration tables… No new tables/columns in Phase 1+. Migration 37 is the last schema change" — contradicted by 10 subsequent migrations |
| `docs/ERROR_CONTRACT.md`         | 🟡 No enterprise-endpoint error coverage                                                                                                                                                                                                                                                        |
| Migrations 38/39                 | 🟡 Excellently self-documented in their own headers; absent from every external doc                                                                                                                                                                                                             |
| Prior completion reports         | 🟢 Accurate on their own scope. All five understate the warning count (3 vs 4). Will not be rewritten (§32)                                                                                                                                                                                     |
| `PHASE_1.5_COMPLETION_REPORT.md` | 🟢 Correctly absent                                                                                                                                                                                                                                                                             |

---

## 13. `idx_alert_events_open` — confirmed collision

Three independent proofs:

1. `pg_indexes`: the live definition is migration 24's —
   `(severity, created_at DESC) WHERE is_resolved = false`. Migration 47's
   `(hospital_id, is_resolved, created_at DESC)` does not exist.
2. Reset log:
   `NOTICE (42P07): relation "idx_alert_events_open" already exists, skipping` —
   `IF NOT EXISTS` swallowed it.
3. Validator warning #4.

Phase 1.5's hospital-scoped alert index was never created. Partial mitigation:
`idx_alert_events_hospital (hospital_id, created_at DESC)` exists. Per §14 I
will not touch migration 24 and will not drop the original — the fix is a new
uniquely-named index in migration 48.

---

## 14. Migrations 38 and 39 — verified, unmodified

Both exist for sound, documented reasons and code depends on them:

**`38_missing_rpc_functions.sql`** — Phase 0 verification found two RPCs called
but never defined: `carry_forward_pending_tokens(UUID,DATE,DATE)` (called by the
`carry-forward-tokens` edge function and by migrations 11 and 17, whose
EXCEPTION handlers were silently swallowing the failure) and
`compute_sla_tracking(UUID,DATE)` (called by `compute-sla`; `sla_daily_tracking`
from migration 24 had no writer at all). Also adds the `sla_wait_breached` /
`sla_completion_breached` columns that `compute-sla/index.ts` filters on but
migration 24 never created.

**`39_schema_alignment.sql`** — aligns SQL with regenerated TS types: adds
`stop_worker` (used by `_shared/worker.ts`) and `recalculate_queue_position`
(used by `cancel-booking`); `CREATE OR REPLACE`s `create_booking` and
`write_audit_log` to add trailing parameter defaults, bodies unchanged;
registers the `payment_order_created` audit action. It is also the only
migration in the project that revokes EXECUTE correctly — the reason 2 of 193
functions are protected. Its pattern is the template for migration 48.

Both are legitimate forward repairs, not schema rewrites. Status: verified, will
not be modified, needs external documentation only.

---

## 15. Multi-role authorization — a real, reproducible lockout

Schema (verified live) has two relevant constraints:

- `unique_user_hospital_role UNIQUE (user_id, hospital_id, role)` — a user may
  legitimately hold several roles at one hospital
- `idx_primary_role UNIQUE (user_id, COALESCE(hospital_id,'000…')) WHERE is_primary = true`
  — a deliberate primary-role mechanism already exists

`_shared/auth.ts` has three `.single()` sites:

| Branch                | Line                                                   | Behaviour                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hospital-scoped role  | `:68` region → `.eq(user_id).eq(hospital_id).single()` | 🔴 No `is_primary` filter. A user with 2 roles at one hospital → `PGRST116` → `roleRow` null → falls into the global-admin branch → not global admin → `HospitalAccessDeniedError`. The user is locked out of their own hospital. |
| Global-admin fallback | `:87` → `.eq("role","global_admin").single()`          | 🟡 Two `global_admin` rows with different `hospital_id` are permitted by the constraint → denial                                                                                                                                  |
| Primary role          | `:112` → `.eq("is_primary", true).single()`            | 🟡 The partial index is keyed per-hospital, so a multi-hospital user can hold two primaries → role = null                                                                                                                         |

All three fail closed — no privilege escalation. But branch 1 is a functional
lockout that any multi-role user will hit, and it directly blocks the §G
multi-hospital story.

Per §16 I will not add a unique constraint to make `.single()` work, and will
not make a destructive schema change. The fix is in code, but the selection rule
is a product decision (item 18).

---

## 16. Proposed files to change

Nothing below has been touched.

**P0 — security**

1. `supabase/migrations/48_privilege_hardening.sql` (new)
2. `supabase/functions/process-whatsapp-webhook/index.ts` — HMAC fail-closed
   (reject when secret missing, reject when signature missing, reject when
   invalid, process when valid). Safe in both JWT worlds, so it needs no product
   decision.
3. `supabase/functions/_shared/env.ts` — `META_APP_SECRET` from `optionalEnv` →
   required where the webhook is enabled.

**P1 — Phase 1.5 functional defects**

4. `supabase/migrations/49_phase_1_5_defect_fixes.sql` (new)
5. `supabase/functions/enterprise-reports/index.ts` — line 177
   (`entityId: body.reportType`) and line 364 (`entityId: checkName`): stop
   passing non-UUIDs into `entity_id`; move the identifier into `newData`.
6. `supabase/functions/alert-center/index.ts` line 280 —
   `String(outcome.suppression_id ?? "")` yields `""` on a null, an invalid
   UUID. Latent (currently non-null), same class.
7. `supabase/functions/_shared/audit.ts` — stop silently swallowing
   malformed-audit writes; at minimum surface them as a metric so a governance
   gap can never again pass tests unnoticed.

**P1 — test defects**

8. `tests/integration/enterprise_command_center.test.ts` — `p_severity: "info"`
   → a valid `audit_action_severity`, and `p_action` → a registered action type
   (fixes the check gate too); `get_alert_center` read as `center.alerts` per
   contract; `offline_payments` expectation corrected to the true fixture
   cardinality; run `deno fmt`.

**P1 — prevention and proof**

9. `scripts/validate_migrations.ts` — privilege-regression detection per §22,
   classifying explicitly-revoked / intentionally-public / service-role-only /
   authenticated-API without false-positiving the intentional cases.
10. `tests/integration/privilege_isolation.test.ts` (new)

**P2 — auth, docs, tooling**

11. `supabase/functions/_shared/auth.ts` — multi-role resolution, pending the
    product decision below.
12. `ROADMAP.md` (Phase 1.5 absent; the "migration 37 is final" claim),
    `ARCHITECTURE.md` (PostgreSQL 15 → 17, migration count),
    `docs/ERROR_CONTRACT.md` (enterprise errors), plus a new
    security/privilege-model document covering migrations 38/39/47.
13. `deno.json` — `gen:types` uses PowerShell `Set-Content -Encoding utf8`,
    producing UTF-16LE and the fmt/lint exclusions. §20 forbids Windows-only
    encoding behaviour.
14. `SETURA_CLAUDE_REPORT.md` — format (my regression).

---

## 17. Proposed new migrations

Two, split by risk profile so they can be reviewed independently. No migration
01–47 will be edited, renamed, reordered or deleted.

**`48_privilege_hardening.sql`** — security only, no business logic changed:

- Function privilege model using migration 39's proven triple-revoke
  (`FROM PUBLIC`, `FROM anon`, `FROM authenticated`, then `GRANT` to the
  intended role), applied per §6 category: **D** financial/ledger
  (`capture_payment` ×2, `idempotent_capture_payment`,
  `create_platform_revenue_summary`, settlement mutators) → `service_role` only;
  **B** worker/cron internals → `service_role` only; **C** administrative/global
  (`get_portfolio_dashboard`, `get_cross_hospital_benchmarks`) → `service_role`
  only, reached through the edge layer that already gates `global_admin`; **A**
  genuine authenticated APIs keep `authenticated` and get an `auth.uid()` +
  membership + role check where they lack one. Classified function-by-function
  before any revoke — no blanket revocation.
- Enable + FORCE RLS with hospital-scoped policies on
  `whatsapp_conversation_states`, `analytics_refresh_logs`,
  `alert_activity_log`, `alert_suppressions`; revoke unnecessary
  `anon`/`authenticated` access; preserve service-role paths so the worker and
  admin flows keep working.
- Replace `queue_runtime_events.queue_events_read USING (true)` with a
  tenant-scoped policy.
- Create the Phase 1.5 alert index under a new unique name (e.g.
  `idx_alert_events_hospital_open`); migration 24's index left untouched.
- Reconsider `anon SELECT` on `system_settings` (pricing/GST/gateway fee).

**`49_phase_1_5_defect_fixes.sql`** — `CREATE OR REPLACE` only, no schema
change:

- `get_hospital_timeline` — move `ORDER BY`/`LIMIT` inside the aggregate
  subquery, matching the pattern `get_alert_center` already uses correctly.
- `generate_executive_report` — wrap the two set-returning helpers
  (`get_reconciliation_summary`, `get_audit_coverage_report`) into JSONB instead
  of COALESCE-ing a record against `jsonb`, restoring the settlement and audit
  report types.

---

## 18. Requires an explicit product decision

Four items. I will not guess on any of them.

**D-1 — Multi-role authorization (§16).** When a user holds two roles at the
same hospital, which applies? (a) highest privilege by `role_level`, (b) the
`is_primary` row for that hospital, (c) explicit per-request role selection. All
three are implementable in code with no schema change. My recommendation: (b)
with (a) as tie-break — `is_primary` already exists and is already uniquely
indexed, so it is the mechanism the schema was designed for. Interim behaviour
stays fail-closed and documented.

**D-2 — WhatsApp webhook JWT boundary (§11).** `config.toml` has no
`[functions.*]` block, so `verify_jwt` defaults to `true`, and nothing in the
repo passes `--no-verify-jwt`. Meta cannot present a Supabase JWT. So exactly
one of two things is true, and I cannot determine which from the repo: either
the webhook is unreachable in production and the feature is non-functional, or
JWT is disabled out-of-band at deploy time, in which case the fail-open HMAC is
the only gate and it is wide open. I need to know how Meta actually reaches the
production endpoint. The HMAC fail-closed fix is correct in both worlds and I
will proceed with it regardless; the JWT configuration decision is yours.

**D-3 — `online_payments` / `offline_payments` semantics (§29/§D).**
`trg_auto_create_collection` writes a `daily_collection_entries` row for every
booking insert, including ₹0 rows for waiting bookings. The dashboard therefore
reports 3 "offline payments" for 1 actual payment. Money totals are unaffected.
Options: (a) fix only the test to match trigger reality, (b) also filter the
counts to `total_amount > 0`. My recommendation: (b) — a financial command
center counting ₹0 placeholders as payments is a reporting inaccuracy, and §29
requires metrics to reconcile with the source tables in substance. This changes
Phase 1.5 logic only, never the frozen trigger.

**D-4 — anon read access to `system_settings`.** 17 rows including booking fees,
GST rate, and `razorpay_gateway_fee_pct`. A public pricing page may want this;
competitor-visible margin configuration may not. Needs a call before I revoke
it.

---

## Two findings I want to flag before any work begins

**The privilege defect is platform-wide, not Phase 1.5's.** Fixing it touches
functions from migrations 02–46 that were certified in earlier phases. This is
the largest-blast-radius change in the plan, and it is why I propose it as its
own migration with per-function classification rather than a sweep.

**A governance requirement was passing review while silently broken.**
`executive_report` audit entries have never been written, because
`logAuditEvent` swallows the UUID cast error. Only the integration test caught
it. That pattern — fire-and-forget audit writes with swallowed errors — is worth
treating as a systemic risk, not a one-line bug.

---

**Certification status: NOT CERTIFIED.** Docker is available and the stack is
running, so certification is not blocked — but 4 implementation defects, 3 test
defects, 3 failing gates, a critical privilege hole, and a non-existent security
suite all stand between here and a legitimate verdict.

Stopping here as instructed. No file will be modified until you approve this
report and answer D-1 through D-4 — though D-2's HMAC fix, D-3's option (b), and
every P0/P1 item other than the auth resolution can proceed on your go-ahead
alone.
