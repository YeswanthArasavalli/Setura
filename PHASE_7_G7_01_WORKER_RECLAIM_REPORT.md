# PHASE 7 — G7-01 WORKER CRASH-RECLAIM INVESTIGATION & RESOLUTION

Work-package deliverable for the Phase 7 G7-01 targeted session
(2026-09-19). Scope: diagnose and resolve the worker crash-reclaim
failure, then close G7-07 with one targeted scheduler run. **No
production system was touched, no credentials created, no deployment
infrastructure modified, G7-02 not started.**

Status vocabulary: PROVEN · IMPLEMENTED · BLOCKED · DEFERRED ·
NOT IMPLEMENTED.

---

## 1. Executive result

```text
G7-01 RESOLVED — no code change required (stale evidence artifact)
G7-07 RESOLVED — committed local passing log + live pg_cron proof
```

The crash-reclaim invariant is **PROVEN (local)** against the current
live database: the target suite passes **4/4**, including *"a crashed
worker's in-flight job is reclaimed (not stranded)"*, and the worker
regression suites pass **7/7**. Zero product files and zero tests were
modified this session.

---

## 2. Original failure

- Evidence cited by the reconciliation: `_w1_test.log` (root), run
  2026-09-18, result `FAILED | 3 passed | 1 failed`.
- Failing scenario: `w1: a crashed worker's in-flight job is reclaimed
  (not stranded)` (`tests/integration/worker_lifecycle.test.ts:350`).
- Exact recorded error (log lines 49–66): the RPC call
  `client.rpc("detect_crashed_workers")` returned
  `SQLSTATE 42702 — column reference "worker_type" is ambiguous …
  It could refer to either a PL/pgSQL variable or a table column`,
  failing `assertEquals(detectError, null)` at test line 391.

---

## 3. Root cause

Classification of **why the reconciliation recorded a live FAIL**:

```text
TEST / EVIDENCE STALENESS (not a current PRODUCT, ENVIRONMENT or TOOLING defect)
```

The classification of the **historical defect the log actually caught**
was genuine and is PRODUCT — but it was already fixed before this
session:

1. `detect_crashed_workers()` as originally defined in migration 19
   declared `RETURNS TABLE (crashed_worker_id TEXT, worker_type TEXT,
   …)` while its `RETURNING worker_id, worker_type, …` list used the
   unqualified name `worker_type`, which collides with the PL/pgSQL OUT
   variable → 42702 on every execution. This is exactly the error in
   the log.
2. **Migration 52** (`52_w1_detect_crashed_workers_ambiguity_fix.sql`)
   redefines the function with table-qualified `RETURNING` columns and
   **functionally executes it inside the migration's own verification
   (§3.4)** — a database where migration 52 is applied *cannot* still
   have the failing definition.
3. Timestamps prove the log is a pre-fix snapshot: `_w1_test.log` was
   written **2026-09-18 23:28:33**, while the final revisions of
   `worker_lifecycle.test.ts` (23:32:52) and
   `52_w1_detect_crashed_workers_ambiguity_fix.sql` (23:32:51) landed
   ~4 minutes **later**. The failing run predates the current state of
   the very files it exercises.
4. The Phase 2 completion record (worker/scheduler session memory)
   independently states W1 went green (6/6) after migration 53 wiring
   — consistent with the log being stale rather than the fix failing.

Live-database confirmation (queried this session, before any repro):

```text
pg_proc: exactly ONE detect_crashed_workers() overload, and
pg_get_functiondef(...) LIKE '%worker_registry.worker_type%' = t
(qualified / fixed definition)

migration_registry:
  51_p0e_claim_jobs_v2_lease_fix              | applied
  52_w1_detect_crashed_workers_ambiguity_fix  | applied
  53_phase2_scheduler_and_autonomous_recovery | applied

claim_jobs_v2 live definition sets job_queue lease
(...lease_expires_at = now() + ...) = t   → P0-01/migration 51 fix is
actually present in the running schema, not just on disk.
```

Reproduction under the current state (§4 of the work package): the
failing scenario now **passes**; the 42702 is no longer reproducible by
any path in the suite.

---

## 4. Files changed

```text
None (product or test source).
```

New artifacts written this session are evidence logs only:

- `_g701_repro1.log` — targeted W1 reproduction (4/4 pass).
- `_g701_regression_worker.log` — worker regression suites (7/7 pass).
- `_g707_scheduler.log` — scheduler-autonomy suite (3/3 pass).
- `PHASE_7_G7_01_WORKER_RECLAIM_REPORT.md` — this report.

`PHASE_7_PRODUCTION_READINESS_RECONCILIATION.md` was updated to move
G7-01/G7-07 to their reconciled statuses (documentation sync, no code).

## 5. Database changes

```text
No backend product changes.
No migration created (none needed — migrations 51/52/53 are already the
corrective chain and are applied + live-verified).
No function, grant, trigger or table was altered.
```

---

## 6. Runtime evidence — the full reclaim lifecycle

From `_g701_repro1.log` (2026-09-19T15:20Z, real local stack). The test
drives the real shared worker primitives (`registerWorker`/`claimJobs`/
`processJob` → `claim_jobs_v2` RPCs) and reads database state directly
after every step; the only injected piece is the job handler (external
side-effect stand-in). Lifecycle steps proven, each with a direct
database assertion from `job_queue`, `worker_job_leases` and
`worker_registry`:

| # | Step | Mechanism | DB-verified by |
| --- | --- | --- | --- |
| 1 | enqueue | `enqueue_job` RPC | job row exists |
| 2 | claim by worker A (`w1-dead-*`) | `claim_jobs_v2` | `status=processing`, `worker_id=A`, `attempt_count=1`, `lease_expires_at` set |
| 3 | job in processing | — | row read back |
| 4 | simulate crash | A stops heartbeating; registry + open job lease aged 60 s into the past (deterministic — no sleeps) | update applied |
| 5 | detect | `detect_crashed_workers()` | RPC error = null (the former 42702 site); `worker_registry.status='crashed'` |
| 6 | reclaim | `reclaim_crashed_worker_jobs()` | RPC error = null; `status='pending'`, `worker_id=NULL` (unstranded) |
| 7 | lease closed | reclaim side effect | `worker_job_leases.outcome='reclaimed'` |
| 8 | worker B claims | `claim_jobs_v2` | B's claim set contains the job |
| 9 | B completes | `processJob` success | `outcome='completed'`, final row `status='completed'` |
| 10 | exactly-once | only B ever completes; A never calls complete; job is a single row moving pending→processing→pending→completed | final-state read |
| 11 | attempt/lease metadata | attempt/stamp fields read via `getJob` | asserted non-null where required |

```text
ok | 4 passed | 0 failed (3s)
```

The suite's other three scenarios (happy path, retry→DLQ, enqueue
dedup) remain green, so no assertion was weakened — nothing was
changed.

---

## 7. Regression evidence

Exact commands and results (all against the running local stack):

```text
deno test --allow-net --allow-env --allow-run tests/integration/worker_lifecycle.test.ts
  → ok | 4 passed | 0 failed (3s)                 [_g701_repro1.log]

deno test --allow-net --allow-env --allow-run tests/integration/worker_job_failure.test.ts tests/integration/worker_lease_persistence.test.ts
  → ok | 7 passed | 0 failed (3s)   [_g701_regression_worker.log]
```

(`worker_job_failure.test.ts` and `worker_lease_persistence.test.ts`
are the current equivalents of the work package's
`job_failure`/`lease_persistence` names — the repository has no
separate `job_failure.test.ts`.)

Note on exit codes: `ExitCode: 1` reported through PowerShell's
`Tee`/`Select-String` pipelines is the known shell artifact (stderr
through `2>&1`); the deno summary lines above are the authoritative
results and were captured from the same runs' full logs.

## 8. Security impact

```text
None. No grant, RLS policy, function privilege, authorization check or
lease/idempotency protection was changed.
```

Verified posture untouched: `detect_crashed_workers` /
`reclaim_crashed_worker_jobs` / `claim_jobs_v2` remain SECURITY
DEFINER, service_role-only EXECUTE (migration 52 §2 restates it; the
G7-07 anon-denial test below re-proves 42501 at runtime).

---

## 9. G7-07 — scheduler end-to-end proof

Targeted run, durable log `_g707_scheduler.log`:

```text
deno test --allow-net --allow-env --allow-run tests/integration/scheduler_autonomy.test.ts
  → ok | 3 passed | 0 failed (840ms)
     phase2: run_scheduled_tasks reclaims a crashed worker's job (v2 recovery wired in) ... ok (818ms)
     phase2: scheduler_fire_minute is a clean no-op until provisioned ... ok (8ms)
     phase2: anon cannot EXECUTE scheduler_fire_minute (SQLSTATE 42501) ... ok (7ms)
```

Live pg_cron evidence (queried this session):

```text
cron.job:
  setura_cron_minute   * * * * *   → SELECT public.scheduler_fire_minute()
  setura_cron_nightly  0 3 * * *   → SELECT public.scheduler_fire_nightly()

cron.job_run_details (setura jobs): 316 succeeded / 0 failed;
most recent runs at exact minute boundaries
(15:17, 15:18, 15:19, 15:20, 15:21 UTC — all "succeeded").
```

What this proves and what it deliberately does not:

- **PROVEN (local):** pg_cron is installed, the named schedules
  persist, and the scheduler fires **autonomously every minute** with
  zero failures; each fire executes cleanly; the minute tick's master
  scheduler `run_scheduled_tasks` demonstrably reclaims a crashed
  worker's job (the full detect→reclaim→re-claim chain running through
  the scheduled path, not just the direct RPC path); the fire
  functions fail closed when unprovisioned; anonymous callers are
  denied at the database (42501).
- **Still BLOCKED (unchanged, correctly):** the authenticated
  end-to-end HTTP wake
  (`scheduler_fire_minute → net.http_post → /functions/v1/run-cron-minute`)
  requires provisioned `CRON_SECRET`/`WORKER_SECRET` +
  `ENABLE_WORKER_TRIGGER=true` + a configured
  `scheduler_http_config` base URL. None was provisioned (per work
  package: local test configuration only, no secrets created). This
  boundary stays recorded under G7-03/G7-09.
- **Production scheduler:** BLOCKED — no deployment exists (G7-02).

G7-07 as defined by the reconciliation ("no committed passing log/
report") is **closed locally**: suite green, log committed to the tree,
live cron history measured.

---

## 10. Remaining blockers (explicitly still open)

| Gap | State after this session |
| --- | --- |
| G7-02 deployment pipeline | OPEN — requires explicit authorization |
| G7-03 production secrets/Vault provisioning | OPEN (HTTP-wake boundary above) |
| G7-04 production privilege catalog verification | OPEN — BLOCKED, no production DB |
| G7-05 real Razorpay boundary | OPEN — BLOCKED |
| G7-06 real Meta boundary | OPEN — BLOCKED |
| G7-08 tenant/staff production provisioning | OPEN — NOT IMPLEMENTED |
| G7-09 ENABLE_WORKER_TRIGGER shipped default | OPEN — decision D6 |
| G7-10 external error tracking | OPEN — NOT IMPLEMENTED |
| G7-11 backup/DR | OPEN — NOT IMPLEMENTED / DEFERRED |
| G7-12 production auth config | OPEN — NOT IMPLEMENTED |
| G7-13 F16-05/F16-06 test debts | OPEN |
| G7-14 load headroom | OPEN |
| G7-15 notifications staff UI | OPEN — NOT IMPLEMENTED |
| G7-16 migration-history assurance | OPEN — unmeasurable without Git |

Closed by this session: **G7-01** (reclaim invariant PROVEN locally)
and **G7-07** (committed local scheduler proof).

---

## 11. Evidence references

- `_w1_test.log` (stale 2026-09-18 23:28 snapshot) vs.
  `_g701_repro1.log` / `_g701_regression_worker.log` /
  `_g707_scheduler.log` (current, 2026-09-19).
- `supabase/migrations/51_p0e_claim_jobs_v2_lease_fix.sql`,
  `52_w1_detect_crashed_workers_ambiguity_fix.sql` (incl. §2 privilege
  restatement and §3.4 in-migration functional verification),
  `53_phase2_scheduler_and_autonomous_recovery.sql`.
- `tests/integration/worker_lifecycle.test.ts` (scenario 3, lines
  349–433), `worker_job_failure.test.ts`,
  `worker_lease_persistence.test.ts`, `scheduler_autonomy.test.ts`.
- Live catalog: `pg_proc` definitions, `migration_registry`,
  `cron.job`, `cron.job_run_details` (queries reproduced in §3 and §9).

---

```text
G7-01:
RESOLVED (no code change)

Root cause:
TEST (stale evidence: the log predates the final applied state of the
migration-52 fix; the underlying PRODUCT defect — migration 19's
ambiguous RETURNING — was already fixed and is live-verified in the
catalog)

Fix:
None required. Diagnosis + fresh reproduction of the full
enqueue→claim→crash→detect→reclaim→re-claim→complete invariant.

Targeted runtime:
PASS — worker_lifecycle 4/4, incl. crash-reclaim scenario
(42702 no longer reproducible)

Worker regression:
PASS — worker_job_failure + worker_lease_persistence 7/7

G7-07:
RESOLVED (local)

Scheduler runtime evidence:
scheduler_autonomy 3/3 with committed log; live pg_cron: 2 named
schedules registered, 316 succeeded / 0 failed autonomous minute runs;
run_scheduled_tasks reclaims crashed-worker jobs through the scheduled
path; fail-closed unprovisioned fire; anon EXECUTE denied 42501.
Authenticated HTTP wake remains BLOCKED by design (G7-03/G7-09).

Production:
NOT STARTED

G7-02:
OPEN — requires explicit authorization

Next permitted work:
G7-02 planning/authorization only
```
