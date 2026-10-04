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
