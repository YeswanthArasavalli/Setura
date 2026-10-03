# WS-OPS-1 — Worker & Scheduler Autonomy + 24-Hour Soak

## Implementation Report

Date: 2026-10-03 · Environment: real local Supabase stack (Docker) · Scope:
WS-OPS-1 only. No closed workstream was reopened.

---

## 1. Executive outcome

The worker and scheduler **code is already complete and correct** — it is not a
gap. The real, and only, gap for WS-OPS-1 is **activation and evidence**: in the
live local stack the autonomy chain is provably **fail-closed / unprovisioned**,
so nothing has ever drained unattended, and no continuous soak has been run.

What this workstream delivered:

- A precise, evidence-backed classification of the existing worker/scheduler
  against the 20 questions in §5 of the task.
- The genuinely-missing **concurrent double-claim** integration test (§8/§22).
- The genuinely-missing **autonomy/soak harness** — a repeatable tool that
  verifies the Edge Runtime is really serving, detects armed vs fail-closed
  scheduler state, samples the §18 soak metrics to durable JSONL evidence, and
  runs the §16 interruption/recovery scenario against the real recovery RPCs.
- A **real local runtime proof** of the segments that can be proven without
  live provider credentials: cron fires autonomously; the fire function is
  fail-closed by design; the worker endpoint is served; claim/lease/complete/
  retry/backoff/DLQ/crash-recovery/idempotency/concurrency all pass integration;
  and interruption→reclaim→re-claim→complete passes at runtime.

**The ≥24-hour armed soak is NOT achieved and is marked UNPROVEN** (§17/§30).
The full unattended drain of the provider-carrying job mix is **BLOCKED** on
operator provisioning + live provider credentials that are intentionally
unproven locally (WS-ONBOARD-3). This report does not claim otherwise.

Classification summary (see §24 for the authoritative gate log):

| Capability | Classification |
| --- | --- |
| Worker engine (claim/lease/complete/fail/retry/backoff/DLQ/crash recovery) | IMPLEMENTED + INTEGRATION VERIFIED |
| Atomic concurrent claim (no double-claim) | IMPLEMENTED + INTEGRATION VERIFIED (new test) |
| Interruption → reclaim → re-claim → complete | IMPLEMENTED + RUNTIME VERIFIED (local) |
| Scheduler registration + autonomous cron firing | IMPLEMENTED + RUNTIME VERIFIED (cron ticks) |
| Scheduler fire → authenticated worker wake | IMPLEMENTED, FAIL-CLOSED BY DESIGN, UNPROVEN end-to-end (unprovisioned) |
| Unattended drain of the real job backlog | UNPROVEN / BLOCKED (no operator provisioning + provider creds) |
| ≥24-hour continuous soak | UNPROVEN (harness ready; not run armed) |
| Staging / Production | UNPROVEN (no deployment) |

---

## 2. Starting architecture (unchanged, confirmed)

PostgreSQL/Supabase-native. One queue (`job_queue`), one worker engine (v2:
`claim_jobs_v2` / `complete_job_v2` / `fail_job_v2`), one scheduler (pg_cron +
pg_net). No Redis/BullMQ/external orchestrator was introduced (§4 honoured). The
Edge Function → shared primitives (`_shared/worker.ts`) → SQL RPC → DB invariant
shape is preserved.

---

## 3. Existing worker/scheduler implementation discovered

Source inspected (not assumed):

- `supabase/functions/_shared/worker.ts` — `registerWorker`, `claimJobs`
  (`claim_jobs_v2`), `completeJob`/`failJob` (`*_v2`), `startHeartbeatLoop`,
  `processJob`. Heartbeat + per-job lease model documented in-file.
- `supabase/functions/run-background-worker/index.ts` — the worker entrypoint.
  Gates on `X-Cron-Secret` (constant-time), registers a per-invocation worker id,
  runs `MAX_RUNTIME=115s` claim→process→(complete|fail) loop over JOB_TYPES
  `{send_whatsapp_message, process_incoming_whatsapp, send_notification,
  refresh_analytics, compute_sla}`. `create_partition` was already removed as an
  orphan type (documented).
- `supabase/functions/run-cron-minute/index.ts` — the minute machine endpoint.
  Calls `run_scheduled_tasks` (master SQL scheduler), WhatsApp stale reclaim +
  retry sweep, conversation expiry, queue health, reminders, then **optionally**
  wakes `run-background-worker` only when `ENABLE_WORKER_TRIGGER==="true"`, and
  finally `run_health_check`.
- Migrations already remediated the historical AGENTS §13 findings — the baseline
  is stale. Confirmed present and applied:
  - **50** `fail_job_v2` dead-letter key fix (P0-A).
  - **51** `claim_jobs_v2` persists `job_queue.lease_expires_at` (P0-E — the
    AGENTS P0-01 crash-recovery regression is FIXED at the mechanical half).
  - **52** `detect_crashed_workers` ambiguity fix.
  - **53** pg_cron + pg_net scheduler (`scheduler_fire_minute/nightly`) and the
    wiring of `run_worker_crash_recovery` into `run_scheduled_tasks` (NPD-05).
  - **57** raise the minute-fire pg_net budget to 20000 ms.
  - **58** queue-health negative-age fix.
- Scheduler security (migration 53): fire functions read the API key + cron
  secret from **Supabase Vault** (`setura_scheduler_api_key`,
  `setura_cron_secret`) and the base URL from `public.scheduler_http_config`
  (owner-only, RLS, `base_url` default NULL). **Fail-closed by construction**: if
  any of base_url / key / secret is absent, the fire returns
  `{fired:false, reason:"not_provisioned"}` and enqueues ZERO HTTP request.

---

## 4. Actual gap identified (from source + live DB, not assumed)

Live local stack measurements (docker exec psql + service-role RPC + HTTP probe):

- `cron.job`: `setura_cron_minute` = `* * * * *` **active**, `setura_cron_nightly`
  = `0 3 * * *` **active**.
- `cron.job_run_details`: **5382 rows**, latest `status=succeeded` one per minute
  → pg_cron **is firing autonomously**.
- `scheduler_http_config.base_url` = **NULL**; `vault.decrypted_secrets` contains
  only `setura_razorpay_key_secret` (no `setura_scheduler_api_key` /
  `setura_cron_secret`). → the minute fire **fail-closes** and never POSTs.
- Edge Runtime container env exposes only `SUPABASE_URL=http://kong:8000`; **no**
  `CRON_SECRET` / `WORKER_SECRET` / `ENABLE_WORKER_TRIGGER`. → both machine
  endpoints fail-closed (HTTP 403, proven by live probe — served, not 404/502).
- `job_queue`: **2056 pending, 0 processing, 0 completed, 0 dead**;
  `worker_job_leases` = **0**; `worker_registry` = **0**; `dead_letter_jobs` = 0.

Conclusion: the machinery is real and correct, but it is **not armed** and has
never processed a job unattended in this environment. The missing capability is
therefore:

1. **Autonomy activation** — an operator provisioning step (base_url + Vault
   secrets + edge `CRON_SECRET`/`WORKER_SECRET`/`ENABLE_WORKER_TRIGGER`) that is
   deliberately out-of-band and depends on live provider credentials for a
   faithful drain. This is the correct fail-closed default, not a code defect.
2. **A repeatable soak / evidence harness** — none existed (only prose report
   references to "24-hour soak").
3. **A concurrency (double-claim) test** — the existing suites drive a single
   worker; none proved two workers cannot both own one job.

No worker or scheduler **source** change was warranted (§4/§28: implement only
the missing capability).

---

## 5. Files created

- `scripts/ws_ops1_autonomy_soak.ts` — the autonomy/soak/interruption harness
  (modes `status` | `soak` | `interrupt`). Read-only + evidence-producing;
  refuses to run against any non-loopback API host; never writes or reads a
  secret from the repo; never calls Meta/Razorpay.
- `tests/integration/worker_concurrent_claim.test.ts` — concurrent double-claim
  proof (§8/§22).
- `ws_ops1_soak.jsonl` — soak evidence artifact (generated by the harness).

## 6. Files modified

- `deno.json` — added the `soak:autonomy` task (command authority) and added
  `worker_concurrent_claim.test.ts` to the `test:consolidated` curated gate so
  the new concurrency proof runs in the authoritative consolidated suite.

No migration, no SQL, no Edge Function source, and no unrelated test was
modified.

---

## 7. Database changes

**None.** No migration was created or edited (migrations 1–69 untouched; §25
discipline respected). `validate:migration-manifest` still reports 69/69.

---

## 8. Scheduler configuration (as discovered, not invented)

- Engine: `pg_cron` (enabled by migration 53) + `pg_net` (`net.http_post`).
- Cadence: minute `* * * * *`, nightly `0 3 * * *` (both active in `cron.job`).
- Target: `scheduler_fire_minute/nightly` → authenticated POST to the **existing**
  `run-cron-minute` / `run-cron-nightly` machine endpoints. The scheduler adds no
  second queue/retry/worker path.
- Authorization: per-fire `apikey` + `X-Cron-Secret` read from Supabase Vault at
  fire time; endpoint re-checks `X-Cron-Secret` against `Env.CRON_SECRET`
  constant-time. Duplicate schedules are idempotent (unschedule by name, then
  `cron.schedule` upserts).
- Disabled-job reactivation: none found — the only cadence source is the single
  owner-only config row.
- Current state: **registered and firing, but fail-closed** (`base_url` NULL + no
  scheduler Vault secrets). Tenant-safe by design (fire is a single HTTP wake; the
  worker downstream preserves per-job `hospital_id`).

---

## 9. Worker lifecycle (canonical, confirmed)

`pending → (claim_jobs_v2) → processing → (complete_job_v2) → completed`
Failure: `processing → (fail_job_v2, attempt<max) → pending` with `scheduled_at`
backoff; `processing → (fail_job_v2, attempt>=max) → dead` + one
`dead_letter_jobs` row. Crash: `processing (worker gone) → detect_crashed_workers
→ reclaim_crashed_worker_jobs → pending`. No new states introduced.

---

## 10. Claim / lease semantics

`claim_jobs_v2` selects `FOR UPDATE SKIP LOCKED`, sets `status='processing'`,
`worker_id`, increments `attempt_count`, and (migration 51) writes a coherent
`job_queue.lease_expires_at = now()+2min` identical to the `worker_job_leases`
row. Heartbeats (`worker_heartbeat`) renew the registry lease; a non-`active`
worker cannot claim. **Concurrency proven**: the new test races two workers over a
12-job pool and asserts the claimed id-sets are disjoint, every claimed row is
`processing` owned by exactly one racer, and the DB ownership count equals the
disjoint union. Passed on the live stack.

---

## 11. Retry semantics

`fail_job_v2` retryable branch: back to `pending`, `worker_id` cleared,
`last_error` recorded, `scheduled_at` set to the future (exponential backoff),
lease closed `failed`, no DLQ. Proven by `worker_job_failure` / `worker_lifecycle`
(retry → backoff → re-claim, attempt increments, exhaustion at `max_attempts`).
No infinite retry (bounded at `max_attempts`).

---

## 12. DLQ semantics

Terminal failure inserts **exactly one** `dead_letter_jobs` row keyed by
`original_job_id` (migration 50), preserving `job_type`, `hospital_id`
(tenant), `attempt_count`, `last_error`, `payload`, `failed_at`; ON CONFLICT
deduplicates repeated terminal failures. No silent deletion; `dead` is terminal
(not re-claimed). Proven by `worker_job_failure` + `worker_lifecycle`.
Replay-from-DLQ is **not** present and was **not** built (§13: only if the
roadmap explicitly requires — it does not here).

---

## 13. Idempotency

Enqueue dedup on `p_idempotency_key` returns the same job id and keeps exactly one
row (proven in `worker_lifecycle` test 4). The worker never re-runs a `completed`
job. Per-job handlers that already carry a stable dedup key (WhatsApp
`wa_retry_<id>_<attempt>`, notification `notif_wa_<id>`, broadcast deterministic
enqueue) reuse the existing primitives; **no second idempotency system was added**
and C2b was not touched. Boundary documented (§11 of the task): where an external
provider (Meta / Razorpay) is the side effect, exactly-once depends on the
provider's own idempotency key, not the queue alone — a worker retry re-issues the
same provider idempotency key, and true end-to-end exactly-once at the provider is
only observable with live credentials (see §24 limitations).

---

## 14. Tenant isolation

Every `job_queue` row carries `hospital_id`; `dead_letter_jobs` preserves it; the
handlers operate on the job's own `hospital_id`. The worker runs with service-role
internally but tenant identity stays explicit and is validated in the SQL RPC /
business layer, not by RLS alone (the DLQ/reclaim tests assert the tenant survives
failure and recovery). No cross-tenant path was found or introduced.

---

## 15. Security

- Scheduler secrets live in **Supabase Vault**, never in the repo/config table/
  logs/payload. `scheduler_http_config` is owner-only (RLS, no client grants).
- Fire functions and `run_scheduled_tasks` are `SECURITY DEFINER`,
  `row_security = off`, **service_role-only EXECUTE**; anon/authenticated denied
  (proven at catalog + runtime via SQLSTATE 42501 in `scheduler_autonomy` and the
  privilege suites — the specific denial, not a bare 401, per F16-05).
- Machine endpoints fail closed without a matching `X-Cron-Secret`; live probe
  returned **403** (served) with `CRON_SECRET` unset.
- The harness itself refuses non-loopback targets and never handles secrets.
- No new secret was created or committed. F16-04 obligation (explicit REVOKE on
  any new/changed SECURITY DEFINER function) is satisfied by migrations
  51/53/57; this workstream added no such function.

---

## 16. Observability

Existing primitives preserved: structured JSON logs with job id / type / attempt /
worker id / duration / terminal state, metrics (`worker.batch.*`,
`worker.completed/failed`, `cron.minute.*`), and `run_health_check` /
`write_queue_metrics_snapshot` on the minute tick. The harness samples §18 metrics
to `ws_ops1_soak.jsonl`. No new monitoring stack was built, and no secret / PII is
logged.

---

## 17. Interruption / recovery test (RUNTIME VERIFIED — local)

`deno task soak:autonomy interrupt` against the live stack, using the real worker
primitives + the same `run_scheduled_tasks` RPC the minute tick calls (not a mock):

```
claimed: status=processing owner=ops1-dead-…
interrupted: leases aged into the past
after recovery: status=pending owner=null        # reclaimed by run_scheduled_tasks
final_outcome: completed                         # a live worker re-claimed (attempt 2)
PASS: true   reclaimed_to_pending: true   re_claimed_by_live_worker: true
```

Nuance recorded honestly: the crash is induced by ageing the leases (the recovery
RPCs key off `now()`), which is the same signal a real vanished worker produces;
the reclaim itself is executed by the real scheduler RPC, not a stub. A kill of an
actual OS/container worker process mid-`MAX_RUNTIME` is a further environment step
not exercised here.

---

## 18. 24-hour soak methodology

Design (implemented in the harness, run with `soak` mode):

- Preconditions it checks: Edge Runtime actually serving (container inspect + HTTP
  probe), scheduler armed vs fail-closed, cron registered.
- Loop: every `--interval` seconds sample job/lease/DLQ/worker counts + queue
  depth to a JSONL artifact; **no worker is invoked by the harness** — under an
  armed stack the drain must be produced by pg_cron alone (that is the point of
  "unattended").
- Invariants asserted per window: monotonic `completed`, zero orphaned leases
  (open lease whose job left `processing`), and at summary the deltas for
  completed / DLQ / reclaimed / crashed.
- A faithful ≥24h run additionally requires the scheduler armed (operator
  provisioning) and live provider credentials so the WhatsApp / payment /
  notification job mix can actually execute rather than only fail-and-retry.

## 19. 24-hour soak evidence

A **bounded 46-second, 3-sample** window was run to prove the harness works and to
capture the true current state. Because the local scheduler is **fail-closed /
unprovisioned**, the window legitimately shows **nothing drained** (this is the
finding, not a pass):

```
{"kind":"meta","fired":false,"started_at":"2026-10-03T09:29:52.148Z","durationSec":45}
{"kind":"sample",...,"jobs_pending":2056,"jobs_processing":0,"jobs_completed":0,"dlq_rows":0,"orphaned_leases":0,"queue_depth":2056}   # x3
{"kind":"summary","samples":3,"elapsed_sec":46,"scheduler_fired":false,"completed_delta":0,"invariants_violated":[]}
```

**The ≥24-hour armed soak was NOT performed and is UNPROVEN.** Achieving it here
would require (a) arming the scheduler with an authenticated endpoint + Vault
secrets, and (b) mass-draining a 2056-job production-like backlog through the
WhatsApp/payment/notification handlers using only fake/local provider credentials
— which would both fail at the external boundary and needlessly disturb the shared
local dataset that closed workstreams depend on. That is deliberately not done.
The harness is the artifact that a real armed environment runs to produce the
24h evidence.

---

## 20. Test results (live local stack)

Worker / scheduler integration subset executed:

```
deno test ... worker_lifecycle worker_lease_persistence worker_job_failure
              worker_concurrent_claim scheduler_autonomy
ok | 15 passed | 0 failed (8s)
```

Highlights: claim→lease→complete; retry→backoff→DLQ with correct columns;
crash reclaim; enqueue idempotency; **concurrent double-claim (new)**; scheduler
crash-recovery wiring; fail-closed fire; privilege boundary (42501).

Runtime (harness): `status` → scheduler FAIL-CLOSED, worker probe **403**
(served), `RestartPolicy=no`, 2056 pending / 0 processed; `interrupt` → PASS.

## 21. Regression results

All authoritative gates green (see §24). No previously-closed suite was weakened
or rewritten. The new concurrency test only adds coverage.

## 22. Migration / manifest status

- No migration added or edited. `validate:migrations`: 0 errors, 4 pre-existing
  `[duplicate-objects]` warnings (baseline, not new).
- `validate:migration-manifest`: 69 migrations / 69 manifest lines.
- `gen:types:check`: `database.generated.ts is UTF-8 and up to date.`

## 23. Known limitations

- Live provider credentials (Meta/Razorpay) intentionally unproven locally →
  external-side-effect exactly-once and a faithful job-mix soak are not locally
  observable (documented boundary, §11/§13).
- Scheduler remains fail-closed by design until an operator arms it out-of-band.
- The interruption test induces the crash by ageing leases via the RPC's own
  `now()` clock rather than by killing a live worker process/container mid-run.
- The 24-hour soak was a bounded harness demonstration, not an armed 24-hour run.

## 24. Authoritative gate log (2026-10-03)

```
fmt:check                     Checked 190 files  (no unformatted)   PASS
lint                          Checked 115 files                      PASS
check (type)                  scripts/unit/integration/functions     PASS
test (unit)                   113 passed | 0 failed                  PASS
worker/scheduler integration  15 passed | 0 failed                   PASS
validate:migrations           0 errors, 4 pre-existing warnings       PASS
validate:migration-manifest   69 migrations, 69 manifest lines        PASS
gen:types:check               database.generated.ts UTF-8 & current   PASS
```

## 25. Staging status

**UNPROVEN.** No staging deploy performed. (Prior migrations note a hosted
staging finding for the pg_net timeout — that is a historical artifact; this
workstream did not deploy to or re-validate staging.)

## 26. Production status

**UNPROVEN.** No production deployment exists; nothing here is production
verification. Local runtime results are not production results.

## 27. Definition-of-done checklist

| DoD item (task §30) | Status |
| --- | --- |
| Worker can run unattended | UNPROVEN (fail-closed/unarmed) |
| Jobs safely claimed / concurrent workers cannot double-claim | INTEGRATION VERIFIED |
| Retries work | INTEGRATION VERIFIED |
| Terminal failures reach DLQ | INTEGRATION VERIFIED |
| Leases recover from interruption | RUNTIME VERIFIED (local) |
| Tenant context preserved | INTEGRATION VERIFIED |
| Existing idempotency semantics preserved | INTEGRATION VERIFIED |
| Scheduler configured per existing architecture | RUNTIME VERIFIED (registered + firing) |
| Scheduler invokes the worker path correctly | UNPROVEN end-to-end (fail-closed) |
| Duplicate scheduler invocation → no duplicate logical work | UNPROVEN armed (design: upsert-by-name + fail-closed; not exercised live) |
| Scheduler failures observable | IMPLEMENTED (`net._http_response`, cron status) |
| Runtime execution proven | PARTIAL (segments local; full armed chain UNPROVEN) |
| Interruption/recovery proven | RUNTIME VERIFIED (local) |
| Real ≥24-hour soak | **UNPROVEN** |
| Regression green | VERIFIED |

---

## 28. Final status block

```text
WS-OPS-1 STATUS: BLOCKED
(the activation/soak harness and the concurrency proof are IMPLEMENTED and
 verified; the ≥24h armed soak and the armed end-to-end autonomous drain are not,
 so the Definition of Done is not fully met.)

Worker:
  IMPLEMENTED + INTEGRATION VERIFIED. Engine (claim/lease/complete/fail/retry/
  backoff/DLQ/crash-recovery) already existed and is unchanged; 15/15 worker/
  scheduler integration tests pass on the live local stack.

Scheduler:
  IMPLEMENTED + partially RUNTIME VERIFIED. pg_cron registered (minute+nightly,
  active) and firing autonomously (5382 succeeded job_run_details). Fire path is
  FAIL-CLOSED by design (base_url NULL, no scheduler Vault secrets); armed
  end-to-end wake to the worker is UNPROVEN locally.

Claim / Lease:
  INTEGRATION VERIFIED. FOR UPDATE SKIP LOCKED + coherent lease (migration 51).
  New concurrent double-claim test proves two racing workers never both own a job.

Retry / DLQ:
  INTEGRATION VERIFIED. Bounded retries with backoff; terminal failure writes
  exactly one dead_letter_jobs row (identity/tenant/error/attempt/timestamps);
  no replay-from-DLQ built (not required).

Idempotency:
  INTEGRATION VERIFIED for enqueue dedup + no completed re-run; existing
  provider-side dedup keys reused, no second idempotency system; provider-external
  exactly-once bounded by live credentials (documented).

Tenant isolation:
  INTEGRATION VERIFIED. hospital_id carried on the job and preserved through
  failure/reclaim/DLQ; service-role worker keeps tenant explicit in the SQL layer.

Security:
  IMPLEMENTED. Secrets only in Vault; fire + run_scheduled_tasks service_role-only
  (anon denied at SQLSTATE 42501); endpoints fail closed without CRON_SECRET (live
  403); harness refuses non-loopback hosts; no secret created/committed.

Interruption recovery:
  RUNTIME VERIFIED (local). Dead worker's leased job reclaimed to pending by the
  real run_scheduled_tasks minute-tick RPC, then re-claimed and completed by a live
  worker. Crash induced by lease ageing, not by killing a live process.

24-hour soak:
  UNPROVEN. Harness implemented and demonstrated (bounded 46s / 3-sample window;
  correctly shows 0 drained while fail-closed). A faithful armed ≥24h run requires
  operator provisioning + live provider credentials and was not performed.

Runtime:
  PARTIALLY VERIFIED. Edge Runtime confirmed serving (container running,
  RestartPolicy=no, worker probe 403); cron confirmed firing; segments of the chain
  proven. The full armed cron->worker->DB drain is UNPROVEN locally.

Tests:
  15/15 worker+scheduler integration passed (incl. new concurrency test);
  113/113 unit; harness interrupt PASS.

Regression:
  check / lint / fmt:check / test / test:integration(worker set) /
  validate:migrations / validate:migration-manifest / gen:types:check — all PASS.

Staging:
  UNPROVEN (not deployed/revalidated in this workstream).

Production:
  UNPROVEN (no deployment exists).

Remaining blockers:
  1. Operator provisioning of the scheduler (base_url + Vault
     setura_scheduler_api_key / setura_cron_secret + edge CRON_SECRET /
     WORKER_SECRET / ENABLE_WORKER_TRIGGER) to arm the end-to-end wake.
  2. Live provider credentials for a faithful job-mix soak and provider-side
     exactly-once proof.
  3. A real ≥24-hour continuous armed run via the harness.
```

## 29. Can WS-OPS-1 be considered CLOSED LOCALLY?

**Not fully.** The provable scope — worker/scheduler state, the concurrency proof,
interruption→recovery, the scheduler's fail-closed security posture, and the
activation/soak harness — is closed locally with evidence. The Definition-of-Done
requirements that depend on **arming the scheduler + live provider credentials + a
real ≥24-hour soak** are explicitly **UNPROVEN / BLOCKED** and are NOT claimed as
complete. No further workstream is started after this report.
