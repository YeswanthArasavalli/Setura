# SETURA — WS-OPS-1 HAPPY-PATH SOAK + compute_sla INVESTIGATION REPORT

Evidence vocabulary per AGENTS.md §5: IMPLEMENTED · STATICALLY VERIFIED ·
UNIT VERIFIED · INTEGRATION VERIFIED · **RUNTIME VERIFIED (staging)** ·
PRODUCTION VERIFIED · UNPROVEN · BLOCKED · FAIL. No claim is upgraded beyond
the evidence that produced it. Staging project: `setura-staging`
(`gzcqasntcbqqmgsoikms`). No secret value was read or printed.

---

## 1. Executive Summary

Both WS-OPS-1 objectives are resolved on **live staging**:

1. **Worker happy-path is now STAGING RUNTIME VERIFIED.** A real
   provider-independent `compute_sla` job flowed
   `enqueue → scheduler/worker wake → claim → lease → execute → completed`
   and reached terminal `status = completed`. `completed_jobs` moved from **0
   to 1**. This is a short controlled **smoke** proof, NOT a ≥24h soak (§6).

2. **The 7 `compute_sla` dead-letters are a REAL implementation defect
   (CASE B), now FIXED and verified.** Root cause: `compute_sla_tracking`
   derived `sla_wait_breached` as `v_avg_wait > v_wait_threshold`, which is
   `NULL` (SQL three-valued logic) whenever a (hospital, date) has no
   qualifying wait samples, violating the `NOT NULL` column. Fixed by the
   additive migration `73_ws_ops1_compute_sla_null_wait_fix.sql` (guarded
   derivation mirroring the sibling `sla_completion_breached`). No constraint
   was weakened; no provider credentials were added.

**Final status (§17): both**
`COMPUTE_SLA DEFECT CONFIRMED — FIXED AND VERIFIED` **and**
`WS-OPS-1 PARTIALLY VERIFIED — 24H SOAK REMAINS`.

---

## 2. Starting Staging State (carried from prior verification)

Migrations 01–72 on both sides, zero drift; migration 73 did not exist.
pg_cron + pg_net installed; scheduler 1441 succeeded / 0 failed over a rolling
24h. 32/32 Edge Functions deployed. Worker claim/lease/retry/DLQ runtime
proven. `ever_completed = 0`; 77 dead jobs (70 WhatsApp + 7 compute_sla).
Provider secrets (`META_*`, `RAZORPAY_*`) intentionally absent. This session
re-observed `completed=0`, `dead=77`, `pending=0`, **2 distinct job types**
before applying any change.

---

## 3. Worker Happy-Path Investigation

Staging exposes only two job types: `send_whatsapp_message` (fails at the
provider 401 boundary — credentials absent **by design**, §6 constraint) and
`compute_sla`. `compute_sla` is therefore the only existing **benign,
provider-independent** job able to reach a green terminal state — but it was
blocked by the §8 defect. Fixing the defect and proving the happy path are
the same action; no production behaviour was altered to fabricate a pass.

## 4. Soak Harness Inspection

`scripts/ws_ops1_autonomy_soak.ts` (`deno task soak:autonomy`) was inspected,
not modified. Key facts:

- It **REFUSES to run unless the API host is loopback** (`isLocal()` gate;
  `Deno.exit(3)` otherwise, lines 73–80 / 475–478) and derives its connection
  from local `supabase status`. It is deliberately **local observation
  tooling and cannot point at staging**. It was therefore NOT usable for the
  staging happy-path requirement.
- Modes: `status` (armed/fail-closed snapshot), `soak` (samples metrics while
  pg_cron drains on its own; asserts monotonic-completion + no orphaned leases),
  `interrupt` (§16 crash→reclaim via the real RPCs). It writes no secret and
  never invokes Meta/Razorpay.
- Because it cannot target staging, the staging happy-path was proven with the
  **real production primitives** instead: `trigger_sla_refresh` (the genuine
  producer) + the autonomous pg_cron → `run-background-worker` path.

## 5. Happy-Path Execution (staging, RUNTIME VERIFIED)

Enqueued a benign `compute_sla` job through the real producer:

```sql
SELECT public.trigger_sla_refresh('00000000-0000-4000-8000-000000000001',
                                  '2026-10-01');   -- job a163c3d4-3e46-465f-b435-3c40701bdd51
```

2026-10-01 has **zero bookings** — exactly the shape that used to crash. The
autonomous worker woke, claimed, leased, executed and completed it.

## 6. SMOKE TEST vs 24H SOAK (kept separate)

```text
SMOKE TEST (happy path):  PASS   — one real job reached terminal completed (§7)
24H HAPPY-PATH SOAK:      UNPROVEN / NOT PERFORMED
```

A genuine unattended ≥24h soak was **not** run in this execution window and
was **not** fabricated. The smoke result proves *the happy path works*; it does
**not** prove *a 24-hour soak completed*. The soak harness itself cannot target
staging (§4), so a staging soak needs a dedicated controlled run — see §15.

## 7. Worker Evidence (job a163c3d4-…, live staging)

| Field | Value |
| --- | --- |
| id | `a163c3d4-3e46-465f-b435-3c40701bdd51` |
| job_type | `compute_sla` (provider-independent) |
| final status | **completed** |
| attempt_count | 1 / 5 (first try, no retry) |
| worker_id | `9f872d70-8ab0-4d45-b2c6-4d4c57afee82` (claim + lease owner) |
| created_at | 2026-10-04T03:00:55.708Z (enqueue) |
| processing_started_at | 2026-10-04T03:00:56.620Z (wake + claim) |
| lease_expires_at | 2026-10-04T03:02:56.620Z (lease held) |
| processing_completed_at | 2026-10-04T03:00:56.863Z (success) |
| last_error | null |
| side effect | `sla_daily_tracking(hosp1, 2026-10-01)` written: `avg_wait_minutes = NULL`, `sla_wait_breached = false` → **real execution, not a no-op** |
| `completed_jobs_total` (all types) | 0 → **1** |

Happy-path matrix:

```text
claim                PASS (worker_id set)
lease                PASS (lease_expires_at set)
execute              PASS (processing_started → completed; row written)
successful completion PASS (status = completed)
retry                PASS (prior staging telemetry; this job needed none)
DLQ                  PASS (prior staging 77→dead proven)
24H HAPPY-PATH SOAK  NOT PERFORMED (see §6)
```

## 8. compute_sla Root-Cause Investigation

Full path traced:

```text
producer: trigger_sla_refresh (mig 43) / verify-payment / refresh-rollups / run-cron-nightly
  → payload {hospital_id, date?}
  → job_queue (compute_sla)
  → worker run-background-worker case "compute_sla" (index.ts L235-285)
  → RPC public.compute_sla_tracking(p_hospital_id, p_date)  (mig 38 L127-240)
  → INSERT/UPSERT public.sla_daily_tracking
  → NOT NULL constraint failure on sla_wait_breached
```

The failing write (migration 38, unchanged values except the guard):

```sql
sla_wait_breached = v_avg_wait > v_wait_threshold          -- unsound
sla_completion_breached = v_completion IS NOT NULL
    AND v_completion < v_completion_threshold              -- already guarded
```

`v_avg_wait = AVG(...) FILTER (WHERE checked_in_at IS NOT NULL AND called_at
IS NOT NULL)`. When a (hospital, date) has no booking with BOTH check-in and
call, `v_avg_wait` is NULL, `NULL > 45` is NULL, and the INSERT supplies an
explicit NULL (the column DEFAULT never applies to an explicitly-listed
column) → `23502` on the `NOT NULL` column. The sibling completion flag was
already guarded; the wait flag was not — an asymmetry, not intended behaviour.

## 9. Evidence for Classification — CASE B (real defect)

- **Live staging data proof** — the 7 dead jobs all target hospital
  `00000000-…-000000000001`, dates 2026-09-21 (×2), 09-22 (×4), 09-28 (×1):

  | date | total bookings | wait samples | avg_wait |
  | --- | --- | --- | --- |
  | 2026-09-21 | 4 | 0 | NULL |
  | 2026-09-22 | 3 | 0 | NULL |
  | 2026-09-28 | 3 | 0 | NULL |

  These are **valid, non-corrupt bookings in a normal state** (checked in but
  not yet called / no completed cycle) — not a broken fixture.
- **Live catalog** — `information_schema.columns` → `sla_daily_tracking.
  sla_wait_breached` `is_nullable = NO`.
- **Dead-letter telemetry** — all 7: `status=dead`, `attempt_count=5/5`,
  `last_error = null value in column "sla_wait_breached" … violates not-null
  constraint`.
- **Local negative control** — the new regression test, run against a stack
  still at migration 72, reproduced the exact `23502` on both the zero-wait and
  empty-day cases (breach-detection case passed).
- **Contract argument** — the producer enqueues one `compute_sla` job per
  hospital per bucket regardless of data completeness; any hospital on a quiet
  or not-yet-run day reaches the same NULL. Therefore valid production data
  reaches the defect → **CASE B**, not CASE A.

## 10. Code Changes (exact files)

- `supabase/migrations/73_ws_ops1_compute_sla_null_wait_fix.sql` — NEW.
  `CREATE OR REPLACE FUNCTION public.compute_sla_tracking(UUID, DATE)` with the
  wait-breach guarded: `v_avg_wait IS NOT NULL AND v_avg_wait >
  v_wait_threshold`. Same signature → existing SECURITY DEFINER ACL carries
  over; re-asserts migration 38's `row_security=off` + `REVOKE PUBLIC` +
  `GRANT authenticated, service_role`. Body otherwise byte-faithful to mig 38.
- `supabase/migrations/MANIFEST.sha256` — append-only, one line added via
  `validate_migration_manifest.ts --update` (no prior line touched).
- `tests/integration/compute_sla_null_wait.test.ts` — NEW regression suite (4
  tests): zero-wait→false, empty-day→false, above-threshold→true,
  below-threshold→false, plus cleanup.
- This report.

No Edge Function, no other migration (01–72 untouched; 71/72 not rerun), and
no provider credential was changed.

## 11. Database Changes

Migration 73 (function redefinition) applied:
- **Local**: `supabase migration up` → applied; MANIFEST.sha256 skipped by the
  CLI name pattern.
- **Staging**: `supabase db push --linked` → applied; `migration list --linked`
  before showed 73 local-only (zero other drift). `pg_get_functiondef` on
  staging confirms the guard expression `v_avg_wait IS NOT NULL AND v_avg_wait >
  v_wait_threshold` is present.

No table, column, constraint, RLS or grant change. **The NOT NULL constraint
was NOT weakened; no DEFAULT/COALESCE suppression hack was introduced** (§12
respected).

## 12. Tests Executed (exact counts, this session)

| Scope | Command | Result |
| --- | --- | --- |
| compute_sla regression, **pre-fix** (local @ mig 72) | `deno test … compute_sla_null_wait.test.ts` | **2 failed / 2 passed** — reproduced 23502 on zero-wait + empty-day |
| compute_sla regression, **post-fix** (local @ mig 73) | same | **4 passed / 0 failed** |
| Queue + compute_sla integration | `deno test … queue_runtime queue_operations compute_sla_null_wait` | **32 passed / 0 failed** |
| Unit suite | `deno test tests/unit/` | **113 passed / 0 failed** |
| validate:migrations | `deno task validate:migrations` | 0 errors, 6 pre-existing warnings |
| validate:migration-manifest | `deno task validate:migration-manifest` | 73 migrations / 73 lines, **0 integrity issues** |
| Static gates (new files) | `deno fmt --check`, `deno lint`, `deno check` | clean (line endings normalised) |

The historical **537/537 integration baseline is a prior LOCAL figure and was
NOT re-run in full this session** — it is not claimed as a this-session result.

## 13. Staging Runtime Evidence (post-fix)

- Direct RPC on the exact failing inputs — `compute_sla_tracking(hosp1,
  2026-09-21/22/28)` via `db query --linked` → exit 0, no `23502`.
- Rows now present: `sla_wait_breached = false` for all three (avg_wait NULL).
- Fresh producer-driven job `a163c3d4-…` → `status = completed` (§7).
- `completed_jobs_total` (all types) = **1** (was 0).

## 14. Known Limitations

- 24h soak not performed (§6). The soak harness cannot target staging (§4).
- The **7 historical dead jobs remain terminal `dead`** — expected; the fix is
  forward-looking and their exact inputs are now proven to succeed. Re-draining
  them would require explicit admin re-queue (not required for the objective).
- Staging writes were limited to: migration 73 (function), SLA rollup rows for
  the recomputed dates, and 1 completed job. All are legitimate computed state;
  no patient PII was exposed and no immutable financial record was touched.

## 15. Remaining Blockers (exact)

- **24H staging soak**: needs either (a) a soak harness variant permitted to
  point at a controlled staging project (the current one is loopback-locked by
  design), or (b) an owner-approved ≥24h controlled staging run observing
  monotonic completions. Owner decision required before any PASS on soak.
- Provider (WhatsApp/Razorpay) happy-path and end-to-end authenticated journey
  remain out of scope for this workstream (prompt §15).

## 16. Local vs Staging vs Production

LOCAL:
- Migration 73 applied; compute_sla regression 4/4; queue+compute_sla 32/32;
  unit 113/113; manifest + migration validation clean. INTEGRATION VERIFIED.

STAGING (`setura-staging`, live this session):
- Migration 73 pushed; function guard present in `pg_get_functiondef`.
- Previously failing inputs now succeed; SLA rows written `breached=false`.
- Worker happy-path: 1 job `completed` with full claim/lease/execute telemetry;
  `completed_jobs_total` 0→1. RUNTIME VERIFIED (smoke). 24h soak NOT performed.

PRODUCTION:
- **UNPROVEN.** No production project/deploy. Staging results must NOT be read
  as production readiness.

## 17. Final Status

```text
COMPUTE_SLA DEFECT CONFIRMED — FIXED AND VERIFIED
WS-OPS-1 PARTIALLY VERIFIED — 24H SOAK REMAINS
```

Worker happy-path (enqueue→claim→lease→execute→completed) is staging
RUNTIME VERIFIED via a real benign job. The `compute_sla` dead-letter is a
proven CASE B defect, fixed by additive migration 73, verified locally
(negative-control + regression), on the queue/worker suites, and on live
staging. No constraint weakened, no provider credential added, no migration
73 without genuine requirement, no closed work reopened, and no move to
Razorpay / WhatsApp / frontend / production from this workstream.
