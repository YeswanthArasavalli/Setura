# WS-OPS-1 — 24H STAGING WORKER SOAK REPORT

**Execution date:** 2026-10-04 (UTC). **Soak window T0:** `2026-10-04 08:09:21+00` (pre-soak baseline census against live `setura-staging`, project ref `gzcqasntcbqqmgsoikms`).
**Earliest legitimate closure:** ≥ `2026-10-05 08:09:21+00`.
**Verdict this execution:** `WS-OPS-1 — BLOCKED` (single blocker: the ≥24h wall-clock window is in progress and cannot complete inside one session). No PASS was claimed early; no evidence was fabricated.

---

## 1. Executive Summary

The controlled ≥24h staging worker-autonomy soak was **started and is running**. Within the first minutes of the window a real, benign, provider-independent job produced by the legitimate producer `trigger_sla_refresh` flowed **enqueue → autonomous in-service worker claim → lease → execute → terminal `completed`** on live staging, with textbook lease telemetry and exactly one lease row (no duplicate execution). Scheduler continuity across the trailing 24h and the first window hour is runtime-recorded (`cron.job_run_details`: 1441 succeeded / 0 failed trailing-24h; 60/60 last hour). Worker heartbeats are live. The loopback-locked soak harness `scripts/ws_ops1_autonomy_soak.ts` was **not modified, not bypassed, and not pointed at staging**; the observation uses staging's own durable telemetry plus an hourly read-only sampler through the previously-approved `supabase db query --linked` diagnostic — exactly owner-option (b) pre-defined in `STAGING_VERIFICATION_CLOSURE_REPORT.md` §3. The PASS criteria for the FULL window can only be evaluated at closure via `_soak_close_census.sql` (already dry-run-validated live against staging).

## 2. Pre-Soak Baseline (server clock 2026-10-04 08:09:21 UTC, read-only census)

| Metric | Value |
| --- | --- |
| Migrations applied (remote) | max version 73, 73 rows — aligned local ↔ remote |
| `job_queue` by status | completed=1, dead=77, pending=0, processing=0 (depth 0) |
| `job_queue` by type/status | compute_sla/completed=1, compute_sla/dead=7, send_whatsapp_message/dead=70 |
| Trailing-24h `cron.job_run_details` | 1441 succeeded / 0 failed |
| Last-60-min cron (jobid 1, minute) | 60 runs / 60 ok |
| `cron.job` registry | jobid 1 `setura_cron_minute * * * * *` active; jobid 2 `setura_cron_nightly 0 3 * * *` active |
| `net._http_response` trailing-24h | 361 × HTTP 200 (see §12 note on pg_net response retention) |
| `worker_registry` | active=2, stopped=19,574 (per-wake instances exit cleanly), crashed=34 (historical) |
| Latest worker heartbeat | 2026-10-04 08:09:21.21 UTC (same second as census — live) |
| `worker_heartbeat_log` trailing-24h | 174 rows / 59 distinct workers |
| `worker_job_leases` | 1 row total, closed (the prior smoke job) |
| `dead_letter_jobs` | total 77, failed last-24h 0 |
| `sla_daily_tracking` | 4 rows, all zero-wait (`avg_wait_minutes=NULL`, `sla_wait_breached=false`) |
| `scheduler_http_config` | id=1, base_url present (armed scheduler) |
| Completed smoke job | `a163c3d4-…` completed 2026-10-04 03:00:56.86 UTC |

## 3. Exact Soak Method

1. **T0 read-only baseline census** (§2) via `supabase db query --linked -f _soak_probe_baseline.sql` — the already-approved read-only staging diagnostic (management API; no keys handled in this session).
2. **One legitimate producer action**: `SELECT public.trigger_sla_refresh('00000000-…-0001'::uuid, DATE '2026-10-04')` → job `b4d09b67-35ee-46fc-9693-296f2e9d8643`, enqueued 08:11:06.63 UTC. This is the canonical queue-runtime producer (migration 43 §8), debounced per 5-minute idempotency bucket — no hand-inserted `job_queue` rows, no synthetic data.
3. **Autonomous drain observation**: NO manual worker invocation. The job was claimed by the already-running, cron-woken worker instance (`run-cron-minute → run-background-worker` chain from a prior minute tick, MAX_RUNTIME 115s poll loop) at 08:11:07.94.
4. **In-window continuous evidence**: staging's own durable, timestamped telemetry (`cron.job_run_details`, `job_queue` created/processing/completed timestamps, `worker_job_leases`, `worker_registry`, `worker_heartbeat_log`, `dead_letter_jobs`) is authoritative and is NOT purged (verified: `run_retention_cleanup` has no `job_queue` DELETE).
5. **Hourly sampler** (best-effort convenience, not the primary evidence): `_soak_sampler.ps1` runs one read-only census per hour for 26h appending `_soak_samples.log`. Sampler loss (machine sleep) does not fail the soak; closure reads durable server-side telemetry.
6. **Closure procedure (owner/next session, after 2026-10-05 08:09Z)**: run `supabase db query --linked -f _soak_close_census.sql` (window-bound, pre-validated this session; self-reports `window/ok_if_ge_24h=true`) and re-run `_soak_probe_baseline.sql` for the start/end comparison; then apply §14 criteria and record the final verdict here.

## 4. Safety Controls Preserved

- `scripts/ws_ops1_autonomy_soak.ts` **byte-unchanged**; its `isLocal()` loopback guard (protects against driving/arming a non-loopback environment and against `scheduler_fire_minute` invocation outside the local stack) **not weakened, not bypassed**. The harness was never executed against staging.
- No migration created or edited (no migration 74). No RLS, Edge Function, worker, scheduler, source, frontend, or configuration change of any kind.
- No production target, no Razorpay, no Meta/WhatsApp credentials, no credential fabrication, no secret in or out of any file (only presence flags were read, e.g. `base_url_set=true`).
- Service-role-class elevation was used **only** through the pre-existing, prior-session-approved `supabase db query --linked` mechanism — required both for the read-only census and for the owner-authorized benign producer RPC. No keys were requested, exported, or exposed.
- No fabricated jobs/bookings/patients/payments/queue/SLA data; no direct `job_queue` INSERTs; exactly ONE legitimate producer call for the whole window so far.
- Scratch files (`_soak_*`) are session-local and must never be committed.

## 5. Producer Used

`trigger_sla_refresh(UUID, DATE)` (migration 43 §8) — the existing canonical, debounced, queue-runtime-owned producer that enqueues `compute_sla` jobs. One invocation this window (hospital `…0001`, date 2026-10-04). The mission's preferred producer; nothing new was created.

## 6. Scheduler Evidence

- Registered schedules live and active: minute (jobid 1) + nightly (jobid 2).
- Trailing-24h at baseline: 1441 succeeded / 0 failed; last hour 60/60 — continuous per-minute autonomy.
- First window sample 08:16:24 UTC: `cron_ok_1h=60 cron_bad_1h=0`.
- The window contains one nightly firing (03:00 UTC 2026-10-05) whose steps are direct DB RPCs (analytics MV refresh, rollups, SLA recompute, retention, subscription sync, partition scheduling, health) — extra in-window scheduler proof; closure census counts `cron_in_window/nightly_runs` (expected ≥1).
- pg_net HTTP responses: all observed 200; count is response-retention-bounded (see §12), so `cron.job_run_details` remains the authoritative firing record.
- Full-window expected-vs-actual check is a closure criterion (≥ elapsed-minutes −1 distinct minute-runs, 0 non-succeeded).

## 7. Worker Lifecycle Evidence (RUNTIME VERIFIED on live staging)

Soak job `b4d09b67-35ee-46fc-9693-296f2e9d8643`:

| Stage | Timestamp (UTC) | Evidence |
| --- | --- | --- |
| created (enqueue via producer RPC) | 08:11:06.631847 | `created_at` |
| claimed by autonomous worker | 08:11:07.938856 | `processing_started_at`, `worker_id=425cef21-5715-4433-9cfd-279df258b537`, `lease_expires_at` NOT NULL |
| lease row registered | 08:11:07.938856 | `worker_job_leases` id `dde732b4-…`, lease expiry 08:13:07.938856 (120s) |
| executed + terminal completed | 08:11:08.074095 | `processing_completed_at`, `status=completed`, `attempt_count=1/5`, lease `outcome=completed` |
| duplicate execution | none | exactly 1 lease row for the job |

Claim was performed by a worker instance that a prior pg_cron minute-tick woke — the wake chain `pg_cron → scheduler_fire_minute() → pg_net → run-cron-minute → run-background-worker → claim_jobs_v2 → complete_job_v2` operated with **zero manual worker invocation**.

## 8. Queue / Lease Evidence

- Start-of-window queue depth: pending 0, processing 0, completed 1, dead 77 (historical).
- First-hour in-window state: `done=2` (+1 soak job), `dead=77` (unchanged), depth 0, `leases_open=0`, `leases_orphan=0`.
- Lease fields correctly populated on the soak job (§7). P0-01 lease-column behavior confirmed live on staging for this job.
- End-of-window depth is a closure-census output (`queue_depth_close`).

## 9. Retry / DLQ Evidence

- In-window dead-lettering so far: **0** (`dlq_failed_in_window=0`, `dead=77` unchanged).
- The 77 dead rows are **historical, classified before this window** (70 × `send_whatsapp_message` attempt-5/5 provider-401 on absent Meta creds by design; 7 × pre-migration-73 `compute_sla` NULL-wait defect). They are NOT soak failures and closure explicitly separates in-window DLQ (`jobs_dead_in_window`, `dlq_failed_in_window`) from historical totals.
- Retry/backoff and dead-letter transitions remain proven by the existing integration suites and the historical 5/5-attempt rows; the soak does not re-test them with synthetic failures (none may be fabricated).

## 10. Worker Liveness Evidence

- Baseline: latest heartbeat same second as census query; 2 active workers; trailing-24h 174 heartbeat rows across 59 distinct worker instances.
- Hourly sampler records `hb_latest` + `workers_active` each pass; closure census aggregates `hb_in_window` rows/workers. `crashed=34` is the pre-existing historical count (baseline); closure compares against it — any **new** crashed worker inside the window must be explained.

## 11. Compute SLA Evidence

Per Phase 5 discipline: **no synthetic wait samples, no threshold/data alteration, migration 73 untouched.** Staging has 4 zero-wait `sla_daily_tracking` rows (`sla_wait_breached=false`, `avg_wait_minutes=NULL` — the fixed guard behaving correctly). The soak job exercised the exact fixed `compute_sla_tracking` path successfully to `completed` (RUNTIME VERIFIED). The `sla_wait_breached=TRUE` branch on staging remains **UNPROVEN (data-availability item)**, locally proven only — unchanged by this soak, to be closed only if legitimate staging activity naturally produces wait samples.

## 12. Failures and Anomalies

- **No soak failures so far.** Enqueue→complete latency ~1.44s; all invariants green in the first hour.
- Observation (classified, non-defect): `net._http_response` holds ~361 rows per trailing 24h vs 1440 firings — pg_net response rows are retention/pruning-bounded on hosted Supabase; treated as a secondary signal only; `cron.job_run_details` (1441/1441) is the authoritative firing record.
- Observation (cosmetic): `cron.job_run_details.return_message` renders as summary text ("1 row"); not used as pass/fail evidence.
- Note: `worker_registry.stopped≈19.6k` is expected steady-state (one short-lived worker instance per cron wake) — not a defect signal.

## 13. Start/End Comparison

| Measure | Start (2026-10-04 08:09:21Z) | End (≥2026-10-05 08:09:21Z) |
| --- | --- | --- |
| Queue depth (pending+processing) | 0 | PENDING closure census |
| completed total / by type | 1 / compute_sla=1 | PENDING (expect ≥2; soak job counted) |
| dead total / in-window | 77 / — | PENDING (expect 77 total, 0 in-window) |
| Trailing-24h cron ok/fail | 1441 / 0 | PENDING (`cron_in_window` bounds exact) |
| Heartbeat 24h rows/workers | 174 / 59 | PENDING (`hb_in_window`) |
| Open / orphan / expired leases | 0 / 0 / 0 | PENDING |
| Crashed workers (historical) | 34 | PENDING (new-in-window must be 0) |
| Soak job `b4d09b67` state | completed (08:11:08Z) | PENDING (must remain terminal `completed`, 1 lease) |

## 14. PASS / FAIL / BLOCKED / UNPROVEN Matrix

| Gate | State |
| --- | --- |
| Loopback guard preserved; harness unmodified | **PASS** |
| Legitimate producer only (no fabricated rows) | **PASS** |
| Scheduler trailing-24h + first-hour continuity | **PASS** |
| Worker claim/lease/execute/complete on real benign job (autonomous wake) | **PASS** (RUNTIME VERIFIED) |
| No duplicate execution of soak job | **PASS** (single lease) |
| In-window DLQ = 0 so far; historical 77 separated | **PASS** (so far) |
| Worker liveness (heartbeats live) | **PASS** (so far) |
| `compute_sla` fixed path completes on staging | **PASS** |
| `sla_wait_breached=TRUE` branch on staging | **UNPROVEN** (data-availability; NOT APPLICABLE to soak verdict by design, Phase 5) |
| FULL ≥24h continuous window satisfaction | **UNPROVEN — pending closure census ≥2026-10-05 08:09:21Z** |
| Soak PASS overall | **BLOCKED** solely by wall-clock duration, not by mechanism |

Closure PASS rule (all must hold at T1 ≥ T0+24h): `ok_if_ge_24h=true`; `non_succeeded=0`; `minute_runs` and `distinct_minutes` within 1 of elapsed minutes; `nightly_runs≥1`; `jobs_dead_in_window=0` and `dlq_failed_in_window=0`; soak job still `completed` with exactly 1 closed lease; `multi_lease_completed=0`; `stuck_processing=0`; `expired_open_leases=0`; `hb_in_window` non-trivial and covering; `completed_by_type_close ≥ 2`; every new anomaly classified. Any unexplained violation → FAIL (runtime defect) or BLOCKED (environment), never PASS.

## 15. Files Changed

- Source changes: **NONE.** Migration changes: **NONE** (no migration 74; manifest untouched). Edge Function changes: **NONE.** Frontend changes: **NONE.** Configuration/RLS/scheduler/worker changes: **NONE.**
- Scratch files created (session-local, DO NOT COMMIT; delete after closure): `_soak_probe_cols.sql`, `_soak_probe_baseline.sql`, `_soak_baseline.out/.err`, `_soak_netcols.out`, `_soak_enqueue.sql/.out`, `_soak_drain1.out`, `_soak_lease.sql/.out/.err`, `_soak_sample.sql`, `_soak_sampler.ps1`, `_soak_samples.log`, `_soak_close_census.sql`, `_soak_dryrun.out/.err`. This report file is the only durable document.

## 16. Final WS-OPS-1 Verdict

`WS-OPS-1 — BLOCKED`

The block is exclusively the ≥24h observation duration still in progress on a live, healthy chain; every technical prerequisite is PASS. Per the critical final rule, the loopback lock was NOT bypassed to force a green. Closure census at/after 2026-10-05 08:09:21Z upgrades the verdict to `CLOSED / STAGING VERIFIED` (if §14 criteria hold) or `FAILED` (if a genuine runtime defect surfaces).

## 17. Remaining SETURA Blockers

Unchanged from `STAGING_VERIFICATION_CLOSURE_REPORT.md` and deliberately NOT reopened: positive authenticated staging access (owner-provided valid staging credentials), full end-to-end hospital journey on staging, provider (WhatsApp/Razorpay) live happy-path, and all production verification (D5/D13 owner-deferred). This soak addresses only the WS-OPS-1 24h worker-autonomy gate.

## 18. Next Owner Action

1. Keep the workstation powered/sampled overnight (best-effort; not strictly required — staging's durable telemetry is the authoritative record).
2. In any session **after 2026-10-05 08:09Z**, from the repo root run:
   - `supabase db query --linked -f _soak_close_census.sql`
   - `supabase db query --linked -f _soak_probe_baseline.sql` (end-state comparison)
3. Apply the §14 closure PASS rule verbatim, append the dated closure addendum to this report (single append, no rewrite), upgrade the verdict, and delete the `_soak_*` scratch files.

---

## 19. CLOSURE ADDENDUM — 2026-10-05 (dated single append; §1–§18 above preserved as historical)

**Closure census executed:** T1 = `2026-10-05 10:27:28.94 UTC` (close-census server clock); end-state baseline census `10:27:46 UTC`.
**Window:** T0 = `2026-10-04 08:09:21+00` (original, unredefined) → T1. **Actual elapsed: 26.30 hours** (`ok_if_ge_24h=true`).
**Authoritative sources:** staging durable telemetry (`cron.job_run_details`, `job_queue`, `worker_job_leases`, `worker_registry`, `dead_letter_jobs`) read read-only via `supabase db query --linked -f _soak_close_census.sql` + `_soak_probe_baseline.sql` + four targeted anomaly probes (q1–q6). No producer was re-run; no data was written during closure.

### 19.1 Closure census results (verbatim values)

| Measure | T0 (2026-10-04 08:09:21Z) | T1 (2026-10-05 ~10:27Z) | Note |
| --- | --- | --- | --- |
| cron in-window minute_runs / succeeded / non_succeeded | — | 1578 / 1578 / **0** | elapsed 1578.2 min; distinct_minutes=1578 |
| cron nightly_runs in window | — | 1 (03:00:00 succeeded, q6) | criterion met |
| Queue depth pend+proc | 0 | **0** | `queue_depth_close=0` |
| completed total | 1 | **2** | compute_sla=2 |
| Soak job `b4d09b67` | completed 08:11:08Z | **still `completed`**, att=1/5, worker 425cef21 | criterion 7 PASS |
| Soak job lease rows | 1 (dde732b4, outcome=completed) | 0 at T1 — **purged by documented 24h closed-lease retention (migration 19)** | single-lease proven by T0 capture; §19.4-D |
| dead total | 77 | 78 | +1 = new in-window job c8ee1361 |
| `jobs_created_in_window` | — | compute_sla/completed=1 (mine, legitimate) + send_whatsapp_message/dead=1 (**autonomous reminder pipeline**) | |
| `jobs_dead_in_window` (census predicate `dead AND updated_at>=T0`) | — | **4** = 1 genuine new death + 3 idempotent-replay `updated_at` touches of historical dead rows (q1/q5: no leases, attempts frozen 5/5) | §19.2 |
| `dlq_failed_in_window` | 0 | **1** (794051af → c8ee1361, failed 09:00:07Z, provider 401) | §19.2 |
| multi_lease_completed / stuck_processing / expired_open_leases | 0/0/0 | **0/0/0** | |
| hb_in_window | — | 148 rows / 55 workers; latest heartbeat 10:27:42 (4s before probe) | 1h log truncation per migration 19; boundary liveness proven |
| worker_registry crashed | 34 | 36 (+2 in-window, q3: both `jobs_claimed=0`, marked by crash-detection as designed) | §19.2-F |
| net responses in window | — | 359×200 + 1 timed_out | secondary telemetry, cron layer 0 failures |
| sla_daily_tracking | 4 zero-wait rows | +3 hospital rows for 10-04 computed 03:00 by nightly; all zero-wait `breached=false` | fixed guard healthy; TRUE branch untouched |

### 19.2 The single genuine in-window dead-letter — full root cause

At 08:30:01 UTC 2026-10-05 the **autonomous minute-tick reminder pipeline** (`run-cron-minute` → send-reminders) legitimately enqueued `send_whatsapp_message` job `c8ee1361` (idempotency key `reminder_77e56254…`, hospital …0001) — real product activity, not soak-produced, not fabricated. The worker attempted it exactly 5 times with textbook exponential backoff (leases q2: 08:30:02 → 08:32:03 → 08:36:04 → 08:44:06 → 09:00:07; +2/+4/+8/+16 min), each failing with `WhatsApp send failed (401) UNAUTHORIZED_NO_AUTH_HEADER` — the **intentionally-absent Meta credentials boundary** (§15 design posture, identical root cause to the 70 historical dead rows). It then dead-lettered exactly once and queue depth returned to 0. **Classification: C — known provider boundary / intentionally absent credential.** No runtime defect: retry, backoff, lease accounting, DLQ write and dedup all behaved per spec — this is positive in-window evidence of correct failure-path autonomy.

Three historical dead rows (`05161a4b`, `47a2b3f6`, `d17d5127`, older reminder jobs from 09-21/10-02) show `updated_at` bumped at 08:31:01 by `enqueue_job`'s documented idempotent-replay path (`ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = now()`, migration 06:237-239). q5 proves **zero lease rows and unchanged attempt_count 5/5** — they were NOT re-claimed; terminal state was never violated. Classification: B (expected historical state) + E (census predicate over-count is cosmetic).

### 19.3 §14 criterion-by-criterion closure matrix

| # | Criterion | Result |
| --- | --- | --- |
| 1 | ok_if_ge_24h = true | **PASS** (26.30h) |
| 2 | non_succeeded = 0 | **PASS** (0/1578) |
| 3 | minute_runs & distinct_minutes within 1 of elapsed | **PASS** (1578/1578 vs 1578.2) |
| 4 | nightly_runs ≥ 1 | **PASS** (1) |
| 5 | jobs_dead_in_window = 0 | **RAW FAIL** — 4 = 3 replay touches (not deaths, class B/E) + 1 genuine class-C provider-boundary death (c8ee1361) |
| 6 | dlq_failed_in_window = 0 | **RAW FAIL** — 1 genuine class-C DLQ (c8ee1361) |
| 7 | soak job terminal completed | **PASS** |
| 8 | soak job exactly 1 closed lease | **PASS (by T0 record)** — single closed lease proven at T0; row purged at T1 by documented 24h retention (class D) |
| 9 | multi_lease_completed = 0 | **PASS** |
| 10 | stuck_processing = 0 | **PASS** |
| 11 | expired_open_leases = 0 | **PASS** |
| 12 | hb_in_window non-trivial/coverage | **PASS (qualified)** — boundary liveness both ends; log natively 1h-truncated (class D) |
| 13 | completed_by_type_close ≥ 2 | **PASS** (compute_sla=2) |
| 14 | every new anomaly explicitly classified | **PASS** (§19.2, §19.4) |

### 19.4 Anomaly classification register

- **C (provider boundary):** c8ee1361 dead-letter (1 DLQ) — root-caused, zero runtime impact.
- **B (historical state):** 3 `updated_at` replay touches of old dead reminder rows; `enqueue_job` replay-suppression semantics noted for owner awareness: a reminder whose job died will never be re-enqueued under the same key (only touched) — pre-existing documented source behavior, NOT modified this closure.
- **D (hosted retention/telemetry limits):** `worker_heartbeat_log` truncated to 1h and closed `worker_job_leases` purged >24h by migration 19 `run_scheduled_tasks` (this corrects §3/§8's "durable across window" claim for those two tables — `job_queue`/DLQ/registry totals remain durable and did carry the window); pg_net responses retention-bounded (~359/1578).
- **E (cosmetic/non-authoritative):** 1 net `timed_out` with zero corresponding cron failure (function completed server-side; documented migration-57 pattern); `soak_job_leases` census cell displayed `count(*)=1` — a defect in my own census SQL branch (tableless aggregate), real lease evidence is the T0 capture + q5.
- **F (environment/observation):** in-window +2 crashed worker markers (q3): invocations killed platform-side after registration with 0 jobs claimed; crash-detection marked them exactly as designed, no job impact. Hourly sampler captured 1 of 26 planned samples (machine/session ended overnight) — anticipated in §3.5; durable telemetry remained authoritative.
- **A (genuine runtime defect):** **NONE found. No class-A event occurred anywhere in the 26.3h window.**

### 19.5 compute_sla

Fixed guard healthy throughout: T1 rows (7 total incl. 3 new hospitals computed autonomously by the 03:00 nightly) all zero-wait, `sla_wait_breached=false`, `avg_wait_minutes=NULL`, no 23502. No wait samples manufactured; migration 73 not touched. **TRUE branch: remains UNPROVEN on staging (data-availability item; NOT APPLICABLE to the soak gate per Phase 5).**

### 19.6 Final WS-OPS-1 verdict

`WS-OPS-1 — BLOCKED`

Reasoning, stated without inflation: every criterion that measures **worker/scheduler/queue autonomy correctness** passed for the full 26.3h (0 scheduler failures, correct lease/claim/complete, correct retry/backoff/DLQ, zero stuck/orphan/duplicate, soak job terminal completed). But the §14 gate 5/6 pre-registered **literal zero in-window dead/DLQ**, and one genuine class-C provider-boundary dead-letter breached it. Per the pre-registered closure rule ("violations → FAIL (runtime defect) or BLOCKED (environment), never PASS") and §10 (FAILED requires a genuine runtime defect — none exists; BLOCKED applies where the criteria cannot be met for non-defect environmental reasons), the honest verdict is BLOCKED **pending one owner adjudication**: either (a) rule class-C provider-boundary DLQs NOT APPLICABLE to gates 5/6 (on this evidence WS-OPS-1 would then be CLOSED / STAGING VERIFIED — all remaining criteria passed), or (b) change staging posture (disable reminder→WhatsApp enqueue, or supply test provider credentials) and re-run the window. No PASS was manufactured.

### 19.7 Closure change statement

During closure: **no source change, no migration (no 74), no Edge Function change, no RLS change, no scheduler/worker configuration change, no synthetic data, no producer re-run, no harness modification or bypass, no secret requested/read/printed, no production touch.** Only this dated addendum was written; the `_soak_*` scratch files were deleted after this evidence was captured here; `git status --short` afterward shows no unintended changes.

The §16 historical verdict (`BLOCKED — window in progress`) is preserved above as historical context.

---

## 20. OWNER ADJUDICATION ADDENDUM — 2026-10-05 (dated single append; §1–§19 preserved unchanged)

**Adjudication date:** 2026-10-05. **Authority:** project owner, recorded verbatim in the owner closeout instruction for WS-OPS-1.

### 20.1 Owner ruling on §19.6 option (a)

The owner adjudicated the single open question raised in §19.6 in favor of option (a):

> For WS-OPS-1 worker-autonomy verification, Class-C provider-boundary failures caused **solely by intentionally absent external provider credentials** are **NOT APPLICABLE to the zero-DLQ gate** (§14 criteria 5/6), provided: (1) the provider failure itself is expected, (2) no worker/runtime defect caused it, (3) retry/backoff behavior is correct, (4) lease accounting is correct, (5) the job reaches terminal dead state correctly, (6) no duplicate/stuck/orphan/expired execution occurs, (7) no Class-A runtime defect exists.

The 26.30h captured evidence satisfies **all seven conditions**, each already proven in §19:

1. **Expected provider failure:** `c8ee1361` failed with `WhatsApp send failed (401) UNAUTHORIZED_NO_AUTH_HEADER` — the intentionally-absent Meta credentials boundary (§15 design posture, identical root cause to the 70 historical dead rows).
2. **No worker/runtime defect caused it:** §19.4 records **zero Class-A events anywhere in the 26.3h window**.
3. **Retry/backoff correct:** exactly 5 attempts at +2/+4/+8/+16 min exponential backoff (leases q2: 08:30:02 → 08:32:03 → 08:36:04 → 08:44:06 → 09:00:07).
4. **Lease accounting correct:** 5 in-window leases all belong to `c8ee1361`; `multi_lease_completed = 0`, `stuck_processing = 0`, `expired_open_leases = 0`.
5. **Terminal dead state reached correctly:** dead-lettered exactly once (`dead_letter_jobs` row `794051af`, 09:00:07.44), queue depth returned to 0.
6. **No duplicate/stuck/orphan/expired execution:** census fields all 0 at T1; the 3 historical-row `updated_at` bumps were idempotent-replay touches only (q5: zero leases, attempts frozen 5/5).
7. **No Class-A runtime defect:** confirmed by full anomaly register.

### 20.2 Effect on the §14 matrix

Criteria 5 and 6 change from **RAW FAIL** to **NOT APPLICABLE (owner-adjudicated class-C exclusion)** for this gate. All twelve remaining criteria were already PASS (§19.3). With the adjudication applied, **every applicable §14 criterion passes**:

| Gate outcome | Before adjudication | After adjudication |
| --- | --- | --- |
| 5 jobs_dead_in_window = 0 | RAW FAIL (1 class-C death + 3 replay touches) | **NOT APPLICABLE / PASS-by-adjudication** |
| 6 dlq_failed_in_window = 0 | RAW FAIL (1 class-C DLQ) | **NOT APPLICABLE / PASS-by-adjudication** |
| 1-4, 7-14 | PASS | PASS (unchanged) |

### 20.3 Final WS-OPS-1 verdict (supersedes §19.6; §19.6 retained as the pre-adjudication record)

`WS-OPS-1 — CLOSED / STAGING VERIFIED`

The 26.30h controlled staging soak (T0 `2026-10-04 08:09:21+00` → T1 `2026-10-05 10:27:28.94+00`) is closed on durable staging telemetry: scheduler autonomy (1578/1578 minute runs, 0 non-succeeded, 1 nightly success), worker lifecycle (autonomous claim → lease → execute → completed for soak job `b4d09b67`, exactly 1 closed lease per T0 record), retry/backoff/DLQ failure-path correctness, queue hygiene (depth 0, zero stuck/orphan/expired/duplicate) and liveness all verified, **no Class-A runtime defects found**, and the single provider-boundary DLQ intentionally excluded from the zero-DLQ gate by owner adjudication.

### 20.4 Standing exclusions preserved after closure

- **compute_sla `sla_wait_breached = TRUE` branch remains UNPROVEN separately** — no legitimate staging wait samples exist; no samples were manufactured. This is a data-availability item, NOT a WS-OPS-1 soak-gate requirement, and does not reopen this verdict.
- The 77 historical dead jobs (70 × whatsapp provider-401, 7 × pre-migration-73 compute_sla NULL defect) remain Class B historical state, not soak failures.
- Production verification remains separately UNPROVEN (no deployment); this closure certifies **staging worker autonomy only**.

### 20.5 Adjudication-change statement

This addendum was produced with: **no second 24h soak run, no source change, no migration, no Edge Function change, no RLS change, no scheduler/worker behavior change, no provider credentials added, no synthetic data, no secret requested/read/printed, no production touch.** The only file modified is this report (§20 appended; §1–§19 byte-for-byte unchanged). Nothing was committed.
