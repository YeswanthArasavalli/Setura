# PHASE 7 — PART 3C: AUTONOMY + FINANCIAL EDGE COMPLETION + DISASTER RECOVERY

Scope authority: the PART 3C specification (financial Edge consistency, worker
lease correctness, scheduler autonomy, backup/restore validation, then full
regression and staging re-verification; **production deployment FORBIDDEN**).
This is that specification's §30 deliverable with exactly its 30 sections.
Certification vocabulary is the §3 set —
**PROVEN · IMPLEMENTED · BLOCKED · DEFERRED · NOT IMPLEMENTED · UNPROVEN** —
and LOCAL ≠ STAGING ≠ PRODUCTION and IMPLEMENTED ≠ PROVEN throughout.

---

## 1. Executive Summary

PART 3C set out to close F3B-01, P0-01, D6 and D5. Source-first investigation
(§4/§7/§11) changed the shape of three of those four, because the authoritative
previous state carried by `PHASE_7_PART_3B_…` §14 and `AGENTS.md` §13 was
**materially stale** relative to the actual repository and runtime:

- **F3B-01** was real and is now **fixed**: the `process-refund` Edge prefetch
  matched only `payment_status = 'captured'`; it now routes `captured` **and**
  `partially_refunded` (the exact set migration 60's `initiate_refund`
  accepts), so sequential partial refunds reach the canonical SQL guard instead
  of being rejected at the Edge boundary. Deployed to **staging v9** with JWT
  posture intact.
- **P0-01 (lease)** was **already implemented** by `51_p0e_claim_jobs_v2_lease_fix.sql`
  and is **runtime-PROVEN** against the live local stack. No new migration was
  created (creating one would have duplicated an existing primitive).
- **D6 (Option A)** was **already implemented** by `53_phase2_scheduler_and_autonomous_recovery.sql`
  (+ 57). At runtime pg_cron is installed and the `setura_cron_minute` job has
  fired **autonomously 1040+ times**; crash recovery is wired into
  `run_scheduled_tasks` and reclaims a crashed worker's v2 job. The scheduler →
  fire → pg_net → Kong → `run-cron-minute` **transport** and the endpoint's
  **fail-closed** secret gate were proven live (HTTP 403). The final
  *authenticated worker wake* (claim → complete driven by the HTTP trigger)
  stays **BLOCKED**: it needs Edge-runtime `CRON_SECRET`/`ENABLE_WORKER_TRIGGER`,
  and in this staging-linked local setup those can only be set with
  `supabase secrets set`, which targets the **linked project (staging)** — not
  safe or in-scope to mutate.
- **D5** was **executed for the first time** as a real logical backup + isolated
  restore + validation drill (measured DB restore ≈ 5.35 s; application layer
  restored byte-for-byte-equivalent counts including 139 RLS policies). The
  PITR-based **RPO ≤ 15 min** and the **full operational RTO ≤ 4 h** remain
  **UNPROVEN** — this environment has no continuous WAL/PITR archival and no
  production/staging project to restore from, and the isolated DB was validated
  at the SQL level rather than driven through the live Auth+Edge app journey.

Regression after all changes: **unit 91/91, integration 226/226, frontend
17/17, local E2E PASSED**, migrations/manifest/fmt/check green. No production
artifact was created or touched (§3). Production readiness is NOT claimed.

---

## 2. Scope

In scope and executed: F3B-01 Edge fix + tests; P0-01 source+runtime
verification; D6 source+runtime verification and safe autonomy evidence; D5
backup/restore drill; repository housekeeping; full regression; staging
re-verification of the F3B-01 change.

Explicitly out of scope (per §3 safety rules, NOT performed): production project
creation, production migration/Edge/secret/domain/DNS configuration, live
Razorpay/Meta/SMTP credentials, real payments, production frontend deploy, any
edit to an applied migration, RLS/auth weakening, or deleting/weakening tests.

---

## 3. Baseline from Part 3B

`PHASE_7_PART_3B_FINANCIAL_POLICY_AND_PRE_PRODUCTION_REMEDIATION.md` records:
D16 implemented (migrations 59/60 applied LOCAL+STAGING), charge basis
`booking_fee_inr`, revenue at capture, cumulative refund cap, partial-refund
settlement correction, staging CORS corrected, and 3B's own test snapshot
(integration 226/226, unit 91/91, frontend 17/17, local+staging E2E pass). 3B
listed remaining blockers F3B-01, D6/P0-01 ("not implemented"), D5 ("not
performed"), D13 (no domain), external live integrations, no production project,
and housekeeping of six temp scripts.

**Baseline reconciliation (source-first, §4/§5).** Three carried-forward
"blockers" did not match actual source/runtime and are corrected below. This is
recorded, not silently overwritten:

| Carried claim (3B §14 / AGENTS §13) | Actual verified state | Class |
| --- | --- | --- |
| `claim_jobs_v2` does not set `lease_expires_at` (P0-01 unfixed) | Migration 51 sets `lease_expires_at = now() + interval '2 minutes'` on the claim UPDATE; runtime test passes | **STALE → PROVEN fixed** |
| No scheduler exists; `pg_cron` `installed_version` NULL; zero `pg_net` calls | `pg_cron` 1.6.4 + `pg_net` 0.20.0 installed; migrations 53/57 register `setura_cron_minute`/`setura_cron_nightly` firing `scheduler_fire_*` via `net.http_post`; 1040 succeeded minute runs | **STALE → IMPLEMENTED/PROVEN (tick)** |
| Working tree is NOT a git repository | `git status`/`git ls-files` succeed — it IS a git repo | **STALE** |
| `fmt:check` fails on 8 root markdown files | `deno fmt --check` exits 0; `deno.json` excludes `**/*.md` | **STALE / not current** |

---

## 4. F3B-01 Investigation

SOURCE: `supabase/functions/process-refund/index.ts`. The payment-order prefetch
(line ~199) was:

```ts
.eq("payment_status", "captured")
.single();
```

EXPECTED: match the refundable states the canonical SQL control accepts. ACTUAL
(migration 60 `initiate_refund`, verified at
`supabase/migrations/60_d16_refund_unification.sql:67`):

```sql
AND payment_status IN ('captured', 'partially_refunded')
```

So after ₹100 captured → ₹40 refunded → order = `partially_refunded` → the
second ₹60 refund was permitted by SQL but rejected by the Edge prefetch before
it could reach SQL. Confirmed the gap is Edge-only and fail-closed (never
over-refunds; it under-served sequential partials).

## 5. F3B-01 Fix

CHANGE (single Edge change, no invariant duplicated in TS):

```ts
.eq("booking_id", body.bookingId)
.in("payment_status", ["captured", "partially_refunded"])
.maybeSingle();
```

`.single()` → `.maybeSingle()` so a legitimately-absent refundable order is a
clean `null` handled by the existing branch (message updated to
"No refundable payment found"). The SQL cumulative `total_refunded ≤
total_collected` guard remains the authoritative control; the Edge is only a
router to it. VERIFICATION: `deno check` clean (EXIT 0); `deno task check` and
`deno fmt --check` clean; deployed to staging (§25).

## 6. F3B-01 Tests

The authoritative refund invariant is proven by the D16 integration suite
(`tests/integration/d16_financial_policy.test.ts`) against the real stack — the
same RPCs the Edge path ultimately calls:

| §7 scenario | Proven by | Result |
| --- | --- | --- |
| Full refund (capture 100 → refund 100 → refunded, remaining 0) | "D16 Q5: a full refund zeroes the collection and marks the order refunded" | PROVEN |
| Sequential partial (100 → 40 → 60 → refunded, total 100, remaining 0) | "D16 Q5: sequential partial refunds reduce the collection amount exactly" | PROVEN |
| Over-refund (100 → 70, attempt 50 → rejected) | "D16 Q2: cumulative over-refund is rejected" | PROVEN |
| Duplicate replay (no duplicate refund/ledger/settlement adjust) | "D16 Q5: replaying confirm_refund_processed is idempotent" | PROVEN |
| Failed/refused refund not consuming the budget | migration 60 `initiate_refund` excludes `failed`/`rejected` from the consumed sum (verified in SQL source) + the sequential-partial/over-refund tests | PROVEN (SQL) |

These run the DB path directly, so they always proved the invariant; the F3B-01
defect was purely that the Edge never *reached* that path for a second partial.
A **live Edge happy-path** refund test (through HTTP + a real capture) remains
**UNPROVEN locally** — `process-refund` calls the Razorpay Refunds API and no
local/staging live-gateway credentials exist (per policy). Per the testing
standard (§12) this was **not** mocked to fake a green Edge result.

---

## 7. P0-01 Investigation

Inspected migration 19 (`claim_jobs_v2` original), 51, 52, `job_queue`,
`reclaim_stale_jobs`, `run_worker_crash_recovery`, `detect_crashed_workers`, and
the W1 lease tests. Confirmed the original 19 defect described in AGENTS §13 was
**already remediated by migration 51**, which redefines `claim_jobs_v2` to write
`lease_expires_at = now() + interval '2 minutes'` on the same UPDATE that sets
`status='processing'` (transaction-stable, so it equals the
`worker_job_leases.lease_expires_at`). Migration 51 also restates the
service_role-only ACL and self-verifies in-transaction. **The gap the spec asked
to confirm does not exist in current source.**

## 8. P0-01 Fix

**No new migration created.** §10 conditions the new migration on "if the source
inspection confirms the gap"; it did not. Adding migration 61 to re-fix what
migration 51 already owns would duplicate an established primitive (AGENTS §6)
and violate migration-immutability discipline. The correct action was
independent runtime verification, below.

## 9. P0-01 Lease Invariants

Runtime-verified against the live local stack (`worker_lease_persistence.test.ts`
+ `scheduler_autonomy.test.ts`, both in §26):

- After `claim_jobs_v2`, `job_queue.lease_expires_at IS NOT NULL` — PROVEN.
- `job_queue.lease_expires_at == worker_job_leases.lease_expires_at` (one
  coherent lease) — PROVEN.
- Lease is strictly in the future (`> claimed_at`) — PROVEN.
- Lease is durable in the database and survives a logical restore (§20) — PROVEN.
- A crashed worker's v2-claimed job is reclaimable — PROVEN: `run_scheduled_tasks`
  (the minute-tick entry point) drives `run_worker_crash_recovery` →
  `detect_crashed_workers` → `reclaim_crashed_worker_jobs`; the scheduler test
  sets the job lease in the FUTURE so only the v2 path can reclaim, and asserts
  the job returns to `pending`, the worker registry row to `crashed`, and the
  lease `outcome='reclaimed'`.
- `claim_jobs_v2` EXECUTE is service_role-only (anon denied at SQLSTATE 42501,
  not a JWT-layer 401) — PROVEN.

## 10. P0-01 Tests

From `deno task test:integration` (§26) and the targeted run:
claim → processing+lease; successful completion; crash → lease age → reclaim;
second-worker reclaim; double-claim protected by `FOR UPDATE SKIP LOCKED`
(preserves the migration-19 selection unchanged); retry with backoff and
dead-letter after max attempts — all covered by `worker_lease_persistence`,
`worker_lifecycle`, `worker_job_failure` and `scheduler_autonomy` and green.
Existing W1 tests were not weakened or deleted.

---

## 11. D6 Architecture

Option A (already decided) is implemented as:

```text
pg_cron → scheduler_fire_minute → pg_net → run-cron-minute
        → (ENABLE_WORKER_TRIGGER) → run-background-worker → claim_jobs_v2
```

## 12. D6 Implementation

Implemented by migrations 53 (+ 57 pg_net timeout) — **not new work this phase**;
verified present and applied:

- `CREATE EXTENSION IF NOT EXISTS pg_cron` + two named jobs
  (`setura_cron_minute` `* * * * *`, `setura_cron_nightly` `0 3 * * *`).
- `scheduler_fire_minute/nightly()`: SECURITY DEFINER, `row_security=off`,
  service_role-only; read base URL from `scheduler_http_config` and API key +
  cron secret from **Supabase Vault** (never repo/column plaintext); issue
  authenticated `net.http_post` to the existing machine endpoint; **fail closed**
  (`{fired:false, reason:not_provisioned}`, zero HTTP) when base URL or either
  secret is absent.
- Autonomous recovery wired into `run_scheduled_tasks` (§9).

## 13. Scheduler Configuration

Runtime census (local, this phase): `pg_cron` 1.6.4 installed, `pg_net` 0.20.0
installed; `cron.job` = `setura_cron_minute`, `setura_cron_nightly`;
`scheduler_fire_minute()` currently returns `not_provisioned` because
`scheduler_http_config.base_url IS NULL` and no Vault secrets exist — the
intended default secure posture. `run-cron-minute` reads `CRON_SECRET`,
`ENABLE_WORKER_TRIGGER` and `WORKER_SECRET` from Edge runtime env; the local
Edge container has none of them (§16).

## 14. Worker Autonomy Evidence

- **pg_cron ticks autonomously**: `cron.job_run_details` shows 1040 succeeded
  `setura_cron_minute` runs, latest 2026-09-21 16:54Z (i.e. running now) —
  no manual invocation — PROVEN.
- **Transport end-to-end (provisioned, then reverted)**: with `base_url`
  temporarily pointed at `http://kong:8000` and dummy Vault secrets present
  (local-only, no staging touched), `scheduler_fire_minute()` returned
  `{fired:true,endpoint:run-cron-minute}` and `net._http_response` recorded
  **HTTP 403** from the endpoint — proving pg_cron → fire → pg_net → Kong →
  Edge delivery. Provisioning was then reverted (base_url NULL, Vault empty,
  fire back to `not_provisioned`).
- **Claim/lease/complete primitives**: PROVEN via worker tests + the §18
  scheduler recovery test (autonomous path, driven through `run_scheduled_tasks`).

## 15. Crash Recovery Evidence

`scheduler_autonomy.test.ts` "run_scheduled_tasks reclaims a crashed worker's
job" — PROVEN at runtime (§9). This is the crash → lease expiry → reclaim →
re-claimable chain. The reclaim is produced specifically by the newly wired **v2**
recovery (job lease held in the future so v1 time-based `reclaim_stale_jobs`
cannot be responsible).

## 16. D6 Security Tests / BLOCKED wake

PROVEN: `scheduler_fire_minute` service_role-only (anon → SQLSTATE 42501, not a
bare 401 — F16-05 discipline); unprovisioned fire enqueues zero HTTP
(`net.http_request_queue` count unchanged); a provisioned-but-secretless caller
is rejected by `run-cron-minute` (403); all 26 staging Edge functions keep
`verify_jwt=true`; cross-tenant isolation for worker/financial objects via the
existing suites.

**BLOCKED (autonomous authenticated wake → worker claim → completion):** driving
the *real* minute-tick wake requires the Edge runtime to hold a matching
`CRON_SECRET` and `ENABLE_WORKER_TRIGGER=true`. In this local stack (linked to
the staging project) the only supported way to inject Edge env is
`supabase secrets set`, whose help states it targets **the linked Supabase
project (staging)** — doing so would mutate the authorized staging project's
secrets, out of PART 3C scope and against §16/§17 safety. Restarting the local
Edge runtime with a custom env file additionally carries the F16-01
RestartPolicy=no hazard. Therefore D6's *authenticated HTTP worker-wake execution*
is recorded **BLOCKED / UNPROVEN**, not PASS, and not faked. The architecture and
every layer below the wake are implemented and proven.

---

## 17. D5 Backup / DR Environment

Executed against the **authorized local stack** (never production, never over the
active database). Capability available: on-demand **logical** backup
(`pg_dump -Fc`) of the running database. Capability NOT available: Supabase
continuous WAL/PITR archival and a separate restore-target project (production
does not exist).

## 18. Backup Configuration

Manual logical dump of database `postgres` to `/tmp/setura_dr_3c.dump`
(2,374,522 bytes) at backup timestamp **2026-09-21T17:02:18Z**, duration ≈ 0.4 s.
The approved production policy (daily base + WAL/PITR, 30-day retention) requires
a plan tier this environment does not provide and is therefore **NOT IMPLEMENTED
here** (would be a production/owner action, §29).

## 19. Restore Procedure

Per §22, isolated target: `CREATE DATABASE setura_dr_restore` → `pg_restore
--no-owner` into it (never overwriting the source), then validation. Restore wall
time (the measured DB-restore component): **17:02:30.65Z → 17:02:36.00Z ≈ 5.35 s**.

## 20. Restore Evidence

`pg_restore` emitted 392 non-fatal diagnostics dominated by a genuine finding:
**`pg_cron` cannot be created outside the `cron.database_name='postgres'`
database**, so the entire `cron.*` object set (job table + run history) does not
survive a logical restore into a differently-named DB. The application layer
restored faithfully:

| Object | Source | Restored | Survives? |
| --- | --- | --- | --- |
| public tables | 103 | 103 | YES |
| public functions | 481 | 481 | YES |
| RLS policies | 139 | 139 | YES |
| triggers | 81 | 81 | YES |
| enums | 35 | 35 | YES |
| `schema_migrations` rows | 60 | 60 | YES |
| `claim_jobs_v2` lease clause (P0-01) | present | present | YES |
| `initiate_refund` `partially_refunded` (D16/60) | present | present | YES |
| `scheduler_fire_minute` function | present | present | YES |
| `claim_jobs_v2` ACL (anon=false / svc=true) | intact | intact | YES |
| `cron` schema / `cron.job` schedules | present | ABSENT | **NO** |
| Vault secrets, Edge config | (cluster/platform) | NOT in logical DB | **NO** |

## 21. RPO Measurement

Approved target RPO ≤ 15 min assumes continuous WAL/PITR. This environment has
**no PITR**, so the recoverable-data point is only ever "as of the last manual
dump." There is no measured ≤15-min recovery window to report. **Actual RPO:
UNPROVEN** (no PITR capability in the available environment). Not fabricated.

## 22. RTO Measurement

The DB-restore component measured ≈ 5.35 s (well inside 4 h). The **full
operational RTO** additionally requires re-provisioning everything that did not
survive (§23) — pg_cron jobs, Vault/Edge secrets, Edge deployments/`verify_jwt`,
Auth `site_url`/redirects, Razorpay/Meta webhooks, Vercel config — plus promotion
and E1. Those steps were not exercised. **Full RTO ≤ 4 h: UNPROVEN** (only the
DB-restore sub-step measured).

## 23. Post-Restore Validation

Structural + security + financial-object + worker/scheduler-object validation on
the restored DB: PROVEN (§20). Financial invariant: no `payment_orders` row with
`total_refunded_amount_inr > amount_inr` exists on the source (query confirmed),
and the enforcement function (`initiate_refund` cumulative guard) survives
restore. **E1 application journey against the restored DB: UNPROVEN** — running
the real Login→…→History walk requires rewiring Auth + Kong + Edge runtime to the
isolated database (not performed); the SQL-layer validation is the achieved
evidence. Isolated DB and dump were removed after the drill; the shared local DB
was left in its pre-drill state (scheduler re-confirmed `not_provisioned`,
`vault.secrets = 0`).

---

## 24. Full Regression (all executed this phase, real local stack)

| Gate | Command | Result |
| --- | --- | --- |
| Migration validation | `deno task validate:migrations` | 0 errors (4 pre-existing `[duplicate-objects]` warnings — known baseline) |
| Manifest validation | `deno task validate:migration-manifest` | 60 migrations / 60 lines, 0 integrity issues |
| Unit | `deno task test` | **91 passed / 0 failed** |
| Type check | `deno task check` | clean |
| Format check | `deno task fmt:check` | clean (155 files; `**/*.md` excluded via deno.json) |
| Integration (full) | `deno task test:integration` | **226 passed / 0 failed** |
| Targeted worker/scheduler/d16 | (subset) | 25 / 25 |
| Frontend | `npm test` (apps/web) | **17 passed / 0 failed** (3 files) |
| E2E (local) | `node apps/web/e2e/core_journey.mjs` | **PASSED** (login→booking→token→queue→doctor→consultation→completion→history→cross-tenant RLS) |

No test was deleted, skipped, or weakened; the D16 suite serves the §26
"relevant D16 suite." No unexplained regressions.

## 25. Staging Verification

Only the F3B-01 Edge change was deployable to staging safely this phase:

- **Posture before:** all 26 functions `verify_jwt=true` (0 exceptions);
  `process-refund` v8 ACTIVE.
- **Deploy:** `supabase functions deploy process-refund --project-ref <staging>`
  — **no** `--no-verify-jwt` flag (§17 slip avoided).
- **Posture after:** all 26 `verify_jwt=true`; `process-refund` **v9** ACTIVE.
- **Financial D16 layer:** already staging-applied in 3B (migrations 59/60 +
  content markers); not re-touched.
- **Live refund sequence / capture on staging:** **UNPROVEN** — requires live
  Razorpay test credentials (absent by policy). Scheduler tick / worker claim on
  staging: **BLOCKED/DEFERRED** for the same Edge-secret reason as §16 (would
  mutate staging secrets). Frontend/API authenticated walkthrough from the live
  Vercel URL: UNPROVEN (unchanged from 3B; no CORS change made this phase).

## 26. Repository Housekeeping

The six PART 3B temporary staging helpers were inspected and removed:
`scripts/_staging_sql.ps1`, `_cors_verify.ps1`, `_staging_env_probe.ps1`,
`_fncheck.ps1`, `_staging_anon.ps1`, `_staging_e2e.ps1`.

- **Secrets:** none embedded — they read the management token dynamically from
  the Windows Credential Store and never echoed it; only the non-secret staging
  project ref is hardcoded.
- **Dependencies:** the only references to these filenames were their own header
  comments; no CI workflow, no `deno.json` task, no production source, no other
  script imports them.
- **Git:** all six were **untracked** (`git ls-files` empty), so removal leaves no
  history gap; nothing permanent was deleted.
- A transient post-deploy posture-check helper was created during §25 and deleted
  after use; no temporary logs were left in the tree.

## 27. Migration Integrity

Migrations `01–60` were **not edited** and **no new migration was added**
(P0-01/D6 were already implemented; F3B-01 is Edge-only). `git status` confirms
the only working-tree change attributable to PART 3C is
`supabase/functions/process-refund/index.ts`. The `MANIFEST.sha256` and
migration-60/test modifications shown are PART 3B's own uncommitted work (3B
report is likewise untracked) — not touched here. Manifest validator reports
60/60, 0 issues; sequential numbering intact; no drift.

## 28. Remaining Blockers

1. **D6 authenticated worker-wake execution** — BLOCKED (Edge-runtime
   `CRON_SECRET`/`ENABLE_WORKER_TRIGGER` provisioning would mutate the linked
   staging project; local env-injection path is unsafe/out-of-scope). All layers
   below it are implemented + proven.
2. **D5 PITR RPO ≤ 15 min** — UNPROVEN (no continuous WAL/PITR in this
   environment; production plan does not exist). **Full operational RTO** and
   **E1-on-restored-DB** — UNPROVEN (only DB-restore measured/validated).
3. **Live external integrations** — Razorpay/Meta/SMTP test→live legs UNPROVEN
   (no real credentials, by policy).
4. **D13 production domain** — NOT YET SELECTED (owner decision).
5. **Production project** — does not exist; creation forbidden this phase.
6. Prior test-quality caveats **F16-05/F16-06** stand (unchanged; this phase did
   not touch the privilege suites).

## 29. Production Gates

Reaching a defensible "production ready" claim (NOT claimed here) requires the
owner to: select the domain (D13); provision a production project/plan meeting
D5 PITR/RPO; apply migrations 01–60 and deploy all Edge functions to production
with `verify_jwt=true`; authorize + provision the D6 Edge secrets on the
production/staging environment and prove the authenticated wake; run a D5 restore
drill **with measured RPO/RTO and a live E1**; complete live Razorpay/Meta/SMTP
round-trips; and run the full staging-equivalent regression on production. Several
gates (D6 wake, D5 RPO/RTO) need an environment this phase was not authorized to
create.

## 30. Final Status

```text
PART 3C COMPLETE
PRODUCTION DEPLOYMENT NOT PERFORMED
PRODUCTION READINESS NOT CLAIMED
```

Per-item classification: F3B-01 = IMPLEMENTED + PROVEN (SQL boundary) +
DEPLOYED to staging v9, live-gateway Edge leg UNPROVEN. P0-01 = PROVEN
(migration 51 + runtime). D6 = IMPLEMENTED + scheduler tick / transport /
fail-closed / recovery PROVEN; **D6 AUTONOMY (authenticated wake) = BLOCKED**.
D5 = restore drill EXECUTED + app-layer PROVEN; **D5 RPO/RTO = UNPROVEN** (no
PITR environment). Housekeeping DONE. Regression GREEN.

---

## Appendix — Deliverables

**A. Files changed:** `supabase/functions/process-refund/index.ts` (F3B-01
prefetch widened to `IN ('captured','partially_refunded')`, `.maybeSingle()`);
removed 6 untracked temp `scripts/_*.ps1` helpers.
**B. Migrations added:** none (P0-01/D6 pre-existing in 51/53/57; immutability
preserved).
**C. Local test results:** unit 91/91 · integration 226/226 · frontend 17/17 ·
E2E PASS · migrations 0 errors · manifest 60/60 · fmt+check clean ·
targeted worker/scheduler/d16 25/25.
**D. Staging test results:** `process-refund` deployed v8→v9 with all 26
functions retaining `verify_jwt=true`; D16 SQL layer unchanged from 3B; live
financial/scheduler legs UNPROVEN/BLOCKED (§25/§28).
**E. D5 RPO/RTO result:** DB-restore component measured ≈ 5.35 s and
application layer restored faithfully; RPO ≤15min UNPROVEN (no PITR); full
operational RTO ≤4h UNPROVEN.
**F. D6 autonomy result:** pg_cron autonomous tick + scheduler→endpoint
transport + fail-closed + v2 crash recovery PROVEN; authenticated worker-wake
execution BLOCKED (Edge-secret provisioning unsafe/out-of-scope here).
**G. F3B-01 result:** FIXED + deployed to staging; SQL refund invariant PROVEN;
live-gateway Edge happy path UNPROVEN (no credentials).
**H. Remaining blockers:** see §28.
**I. Exact next owner authorization required:** select the production domain
(D13); provision a D5-compliant production plan and authorize a real PITR
restore drill with live E1; and authorize D6 Edge-secret provisioning
(`CRON_SECRET`/`ENABLE_WORKER_TRIGGER`/`WORKER_SECRET`) on the target
environment so the authenticated worker wake can be proven end-to-end. The next
phase must be separately authorized.

END OF PART 3C.
