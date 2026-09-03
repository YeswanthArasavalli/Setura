# SETURA — CROSS-PHASE GAP REGISTER

**Consolidated defect and gap register, Phase 0 → Phase 1.5**
**Audit date:** 2026-08-21 · **Read-only audit — no remediation performed**
**Companion to:** `CROSS_PHASE_REQUIREMENTS_MATRIX.md` (147 requirements),
`ARCHITECTURAL_DRIFT_REGISTER.md`, `CERTIFICATION_RECONCILIATION.md`,
`NEXT_PHASE_READINESS_REPORT.md`, `CROSS_PHASE_AUDIT_REPORT.md`

---

## 0. SEVERITY DEFINITIONS

Severity is assigned by **consequence in a real hospital handling real money**,
not by engineering effort to fix.

| Severity | Definition                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **P0**   | Blocks production deployment. Causes silent loss of patient-affecting work or patient money, or means a core subsystem never runs at all. |
| **P1**   | Deploy-blocking for a paying hospital. Financial incorrectness, an unauthenticated or unreachable integration, or an unproven security boundary. |
| **P2**   | Serious but survivable with documented operational compensation. Commercial controls unenforceable, wrong dashboard figures, dead surface area. |
| **P3**   | Correctness of documentation, consistency, hygiene. No runtime impact on money or patients.                                              |
| **NPD**  | Cannot be assigned a severity by engineering — requires a business ruling first. Listed separately in §5.                                 |

**Counts:** P0 = **4** · P1 = **13** · P2 = **15** · P3 = **10** · NPD = **6** —
**48 register entries.**

Every entry states file path and line, the call path, the runtime consequence, and
the evidence class. Where a claim could not be executed, the entry says
**UNPROVEN** and does not assert a catalog fact (PART 27).

---

## 1. P0 — PRODUCTION BLOCKING (4)

### P0-01 — Job crash recovery is dead end to end

| Field                | Detail                                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Requirement**      | I-06, V-06 — `ROADMAP.md:~258`, `~288` ("Simulate worker crash mid-lease → verify job reclaimed")                                                                                                                                            |
| **Location**         | `supabase/functions/_shared/worker.ts:107` → `claim_jobs_v2` (mig 19); reclaimer `reclaim_stale_jobs` (mig 06); v1 comparison `06:283`                                                                                                        |
| **Defect**           | The runtime claim path `claim_jobs_v2` **never populates `job_queue.lease_expires_at`**. The only wired reclaimer filters `WHERE status = 'processing' AND lease_expires_at < now()`. `NULL < now()` evaluates to NULL, so the predicate never matches. |
| **Call path**        | `run-cron-minute` → `run_scheduled_tasks()` → `reclaim_stale_jobs(10)` → **reclaims nothing, ever**                                                                                                                                          |
| **Dead alternative** | `run_worker_crash_recovery`, `detect_crashed_workers`, `reclaim_crashed_worker_jobs` are v2-aware and correct — and have **no caller anywhere**. References exist only in migration 19, generated types, and docs                              |
| **Regression origin**| v1 `claim_jobs` **did** set the column (`06:283`). Migration 19 introduced `claim_jobs_v2` without it. This is a regression, not an omission                                                                                                  |
| **Consequence**      | Any worker crash, timeout, container recycle or deploy mid-job **permanently orphans** every in-flight job in `processing`. Since the job queue is the sole WhatsApp send path and the sole `process_incoming_whatsapp` consumer, orphaned jobs mean **patient confirmations and inbound patient messages are silently lost with no alert and no recovery** |
| **Test evidence**    | **None.** The only test named for crash recovery (`tests/integration/whatsapp_lifecycle.test.ts:310-340`) covers `reclaim_stale_whatsapp_processing` — a different subsystem on a different table                                              |
| **Contradicted claim**| `CROSS_CHECK_REPORT.md:175` explicitly certifies this capability as working. `stop_worker` (mig 39) contains a comment referencing `recover_crashed_worker_jobs`, a function that does not exist                                              |
| **Evidence class**   | Static trace, closed at every layer — **CONFIRMED**, not inferred                                                                                                                                                                            |

### P0-02 — Nothing schedules any cron or worker endpoint

| Field             | Detail                                                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Requirement**   | I-12, and by dependency W-03, W-07, T-04, N3-07, N1-07, V-05                                                                                                                                                        |
| **Location**      | `supabase/config.toml` — **no `[functions]` section, no schedule block**; no `pg_cron` extension; no `cron.schedule(...)` call in any of the 49 migrations; no deploy workflow in `.github/`                            |
| **Defect**        | Four endpoints — `run-cron-minute` (532 L), `run-cron-nightly` (373 L), `send-reminders` (449 L), `run-background-worker` (497 L) — are designed to be invoked on a timer. **No committed artifact configures any timer.** |
| **Consequence**   | With the repository as committed: no reminders, no queue metric snapshots, no MV refresh, no retention purge, no stale-job reclamation, no SLA computation, no WhatsApp delivery. Every time-based behaviour in SETURA is inert |
| **Only reference**| `.qoder/repowiki` prose states an external scheduler *should* be configured. Prose in a wiki directory is not a deployment artifact                                                                                    |
| **Evidence class**| Exhaustive negative search across migrations, config, workflows — **CONFIRMED** for the repository. Whether a scheduler exists out-of-band in production is **UNPROVEN**                                              |

### P0-03 — The worker is unreachable under the documented default configuration

| Field             | Detail                                                                                                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Requirement**   | W-02, W-03, N1-07                                                                                                                                                                                                               |
| **Location**      | `.env.example` ships **`ENABLE_WORKER_TRIGGER=false`** as the documented default; `run-cron-nightly/index.ts:296` (wrong secret, see P1-07); no scheduler (P0-02)                                                                 |
| **Defect**        | Three independent barriers stand between a queued job and the worker, and **all three are closed simultaneously** in the committed configuration: the trigger flag is off by default, no timer invokes the cron that would trigger it, and the one nightly code path that does attempt to wake it authenticates incorrectly |
| **Consequence**   | An operator following `.env.example` verbatim gets a system in which **no WhatsApp message is ever sent and no inbound WhatsApp message is ever processed** — while `create-booking` returns HTTP 200 and enqueues successfully. The failure is completely silent at the API boundary |
| **Why P0 and not P1** | This is not a degraded mode. WhatsApp is the patient-facing communication channel for a hospital queue system; bookings confirm to nobody. Combined with P0-01, jobs that do somehow start are also unrecoverable                 |
| **Evidence class**| `.env.example` read in full (21 keys, no `RAZORPAY_WEBHOOK_SECRET`, `ENABLE_WORKER_TRIGGER=false` present) — **CONFIRMED**                                                                                                        |

### P0-04 — `bookings.booking_fee_inr` has no runtime writer, disabling two of three refund paths

| Field             | Detail                                                                                                                                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Requirement**   | R-06, C-03                                                                                                                                                                                                                                    |
| **Location**      | Column created mig 28; **only assignment is the one-time backfill at `28:81-86`** (`SET booking_fee_inr = COALESCE(platform_fee_snapshot, 0) WHERE booking_fee_inr = 0 AND payment_completed = true`)                                             |
| **Defect**        | No INSERT and no UPDATE anywhere in the 49 migrations or 26 edge functions writes this column at runtime. `create-booking` does not set it. It therefore remains at its `0` default for every booking created after migration 28 was applied      |
| **Dead gates**    | (a) `cancel-booking/index.ts` — `if (refundAmount > 0)` where `refundAmount` derives from this column → **always false**; (b) `whatsapp_cancel_flow` — `if (state.paymentCompleted && (state.bookingFee ?? 0) > 0)` → **always false**; (c) `calculate_refund_amount` (mig 29) reads the same column |
| **Consequence**   | A patient who paid a booking fee and then cancels — through the receptionist UI **or** through WhatsApp — is **not refunded, and no error is raised**. The cancellation succeeds; the money silently stays with SETURA. Only the third path (`process-refund`, which uses `total_amount_snapshot`) can actually refund |
| **Test masking**  | `tests/integration/whatsapp_conversational.test.ts:838` sets the fee **by hand in the fixture**, so the test passes against a value production never produces. This is a green test concealing a live money defect                                |
| **Evidence class**| Exhaustive writer search + gate inspection — **CONFIRMED**                                                                                                                                                                                     |

---

## 2. P1 — DEPLOY-BLOCKING FOR A PAYING HOSPITAL (13)

### P1-01 — Razorpay webhook HMAC verified with the wrong secret

- **Requirement:** R-04, X-06
- **Location:** `supabase/functions/verify-payment/index.ts:63` —
  `const expected = await hmacSha256(rawBody, Env.RAZORPAY_KEY_SECRET);`
- **Defect:** Razorpay signs webhooks with a **separate, dashboard-configured
  webhook secret**, not the API key secret. **No `RAZORPAY_WEBHOOK_SECRET` exists**
  in `_shared/env.ts`, `.env.example`, or anywhere in the repository.
- **Branch selection:** `:204-205` — `isWebhook = !!req.headers.get("X-Razorpay-Signature")`.
  The branch is correctly **fail-closed** (403 on mismatch), which is why the wrong
  secret produces a hard failure rather than a bypass.
- **Consequence:** every genuine Razorpay webhook returns **403**. Webhook-driven
  captures and refund confirmations never process. The frontend
  `order_id|payment_id` flow at `:72-110` is unaffected — it correctly uses the key
  secret — so the defect is invisible until a payment relies on the webhook.
- **Contrast:** Meta's webhook uses `META_APP_SECRET` correctly. The correct
  pattern exists in the same codebase.
- **Evidence class:** CONFIRMED (code read + exhaustive env search)

### P1-02 — Partial refunds over-adjust settlement

- **Requirement:** R-05
- **Location:** `confirm_refund_processed` (mig 41), body line 78 —
  `UPDATE public.daily_collection_entries`
- **Defect:** zeroes `platform_fee`, `receptionist_fee`, `hospital_fee` **and**
  `total_amount` on all unsettled DCE rows for the booking, **regardless of the
  refund amount**.
- **Consequence:** a ₹10 partial refund against a ₹100 booking erases the entire
  ₹100 of fee accrual. Hospital settlement, receptionist incentive and platform
  revenue are all understated. Because DCE feeds
  `create_platform_revenue_summary` (`33:176`), the error propagates into settled
  financials.
- **Test evidence:** `tests/integration/refund_sync.test.ts` covers **full refunds
  only** — the partial case is untested.
- **Evidence class:** CONFIRMED

### P1-03 — Capture failure is indistinguishable from capture success

- **Requirement:** X-01, financial integrity (PART 15)
- **Location:** `idempotent_capture_payment` (`16:421`)
- **Defect:** `PERFORM capture_payment(...)` **discards the BOOLEAN return
  value**, then calls `complete_webhook_event` and returns `success = true`
  unconditionally.
- **Consequence:** a failed capture is recorded as a completed webhook and reported
  as success to the caller. Reconciliation cannot detect the divergence, because
  the webhook event is marked complete and will not be retried.
- **Evidence class:** CONFIRMED

### P1-04 — `settlement-engine` `record_payment` returns HTTP 500 by construction

- **Requirement:** I-11
- **Location:** `record_settlement_payment` reduced by migration 33 to a permanent
  `RAISE NOTICE 'DEPRECATED…'; RETURN FALSE;`; caller
  `supabase/functions/settlement-engine/index.ts:418` throws
  `InternalError("Settlement payment RPC returned false")`
- **Defect:** the RPC was deprecated in place without removing or redirecting its
  only caller.
- **Consequence:** the `record_payment` action of the settlement engine **always
  fails with 500**. Recording a settlement payment against a hospital is
  impossible through the API. No alternative endpoint exists.
- **Evidence class:** CONFIRMED

### P1-05 — Revenue is recognised before, and independently of, collection

- **Requirement:** X-13 (also NPD-02 — the *policy* is a product question; the
  *inconsistency* is an engineering defect)
- **Locations:** `trg_booking_ledger` (`13:479`) writes `platform_fee_credit` +
  `receptionist_incentive_credit` at **booking INSERT**; `trg_auto_create_collection`
  (mig 07) writes a DCE row for **every** booking with **no WHEN clause**;
  `create_platform_revenue_summary` (`33:176`) settles those rows
- **Defect:** there is no linkage between ledger revenue recognition and payment
  capture. WhatsApp bookings receive a non-zero `total_amount_snapshot`, and **no
  WhatsApp flow creates a payment order or payment link at all** (C-03, N1-09).
- **Consequence:** platform revenue, receptionist incentives and hospital
  settlement all accrue against bookings for which **no payment mechanism was ever
  offered to the patient**. Settlement statements will overstate amounts owed and
  earned. This also contaminates `get_revenue_forecast` (`47:1556`), which
  projects from DCE.
- **Evidence class:** CONFIRMED

### P1-06 — `get_reconciliation_summary` reports three incorrect KPIs to hospital admins

- **Requirement:** N4-03
- **Location:** `get_reconciliation_summary` (migrations 34 / 47), surfaced live at
  `supabase/functions/financial-command-center/index.ts:158`
- **Defects:**
  1. `total_settled` is **structurally always 0** — migration 34's own file header
     documents and accepts this.
  2. `net_outstanding` **double-counts** gross collection against its own fee
     splits, and then subtracts SETURA's own gateway and GST costs, which are not
     hospital-facing amounts.
  3. `booking_count = COUNT(DISTINCT b.id)` computed over ledger rows **silently
     excludes ₹0 bookings**, so walk-in and manual-free bookings vanish from the
     count.
- **Consequence:** the financial command centre presents three wrong numbers with
  full confidence to hospital administrators. A wrong figure presented
  authoritatively is operationally worse than a missing one.
- **Evidence class:** CONFIRMED (including migration 34's own acknowledgement)

### P1-07 — Nightly worker trigger authenticates with the wrong credential

- **Requirement:** I-07, X-06
- **Location:** `run-cron-nightly/index.ts:296` sends
  `Env.SUPABASE_SERVICE_KEY.slice(-20)` as the `X-Cron-Secret` header;
  `run-background-worker/index.ts:301` compares against `Env.CRON_SECRET`
- **Defect:** two different values. `run-cron-minute:352,392` uses the correct
  secret, proving the correct pattern was known.
- **Consequence:** nightly step 9 **always returns 403**. Contributes to P0-03.
- **Secondary finding:** step 9 should not exist at all — `ROADMAP.md:~248`
  required *"Verify `run-cron-nightly` does NOT wake worker (nightly tasks are
  synchronous)"* (see P2-09).
- **Evidence class:** CONFIRMED

### P1-08 — `payment_status_detail` refund transitions have no writer

- **Requirement:** R-01, R-02 — the two named success criteria of ROADMAP Phase 1.2
- **Location:** column + CHECK at `28:51-61` enumerating `refund_initiated`,
  `refund_processed`, `refund_failed`; **the only runtime assignment in the entire
  codebase** is `34_payment_ledger_cleanup.sql:198` → `'payment_captured'`
- **Defect:** `confirm_refund_processed` (mig 41) updates `payment_refunds`,
  `payment_orders`, `financial_ledger` and `daily_collection_entries` — and
  **never touches `bookings`**. Four of the eight enumerated states are
  unreachable at runtime (`payment_initiated`, `payment_failed`,
  `refund_initiated`, `refund_processed`, `refund_failed` — five, counting the
  backfill-only values separately).
- **Consequence:** no operator, report or query can determine a booking's refund
  state from the booking row. The column advertises a lifecycle it does not track.
- **Evidence class:** CONFIRMED (exhaustive writer search)

### P1-09 — `verify_jwt = true` blocks all seven machine endpoints

- **Requirement:** N1-10, F-01
- **Location:** `supabase/config.toml` — **no `[functions]` section exists for any
  function**, so Supabase's default `verify_jwt = true` applies. No
  `--no-verify-jwt` anywhere in the repository. **No
  `supabase functions deploy` invocation exists in the repository.**
- **Affected:** `process-whatsapp-webhook`, `verify-payment` (webhook branch),
  `run-cron-minute`, `run-cron-nightly`, `run-background-worker`, `send-reminders`,
  `send-whatsapp-message` — none of which receives a Supabase JWT from its real
  caller.
- **Consequence:** on a deployment matching the committed configuration, the
  platform rejects these requests **before the function body runs**. Meta's
  webhook, Razorpay's webhook and every cron invocation would be refused with the
  handler never executing.
- **Status:** **UNPROVEN in production, blocking as committed.** The project's own
  `docs/security/WEBHOOK_SIGNATURE_BOUNDARY.md` reaches this conclusion for the
  Meta webhook and states: *"Production JWT boundary requires deployment
  verification. Do not invent a production configuration."* This audit endorses
  that position and generalises the finding to all seven endpoints.
- **Evidence class:** CONFIRMED for the repository; **UNPROVEN** for production

### P1-10 — Refund amount basis is inconsistent between paths

- **Requirement:** R-05, R-06
- **Locations:** `process-refund` refunds `total_amount_snapshot`;
  `cancel-booking` and `whatsapp_cancel_flow` use `booking_fee_inr`;
  `calculate_refund_amount` (mig 29) uses `booking_fee_inr`
- **Defect:** two different columns represent "the amount to refund" in different
  code paths, with no reconciliation between them and no documented rule.
- **Consequence:** even after P0-04 is fixed, the three refund paths will refund
  **different amounts for the same booking**. Fixing P0-04 without resolving this
  would convert a silent no-refund into a silent wrong-refund.
- **Evidence class:** CONFIRMED

### P1-11 — The privilege boundary from Phase 1.5 is unproven

- **Requirement:** N5-02, N5-03, N5-04
- **Location:** migration 48 §6 (Category B, 145 routines, `DO $$` catalog loop),
  §7 (Category C, 10), §8 (Category D, 24);
  `tests/integration/privilege_isolation.test.ts`
- **Status:** **UNPROVEN, not failed.** Migration 48 correctly identified the root
  cause — Supabase's installed
  `ALTER DEFAULT PRIVILEGES … GRANT EXECUTE ON FUNCTIONS TO postgres, anon,
  authenticated, service_role` makes the **54 `REVOKE … FROM PUBLIC` statements in
  migrations 27–46 runtime no-ops** — and re-issues revocations against the named
  roles.
- **Why it remains unproven:** the sole evidence is
  `privilege_isolation.test.ts`, which **could not be executed** (Docker
  unavailable), and `pg_proc.proacl` could not be read. No phase report contains
  catalog output either.
- **Consequence:** the central security claim of the most recent phase rests on an
  unexecuted test. Until the suite runs, whether `anon` can execute financial
  routines is **unknown**. This is the single highest-value verification available
  and requires no code change.
- **Evidence class:** UNPROVEN — explicitly not asserted either way

### P1-12 — `is_primary` provisioning hazard causes total Edge API lockout

- **Requirement:** N5-10, Z-07
- **Locations:** `user_roles.is_primary` defaults to **false** with **no constraint**
  guaranteeing at least one primary row per user;
  `_shared/auth.ts::selectRole()` **denies outright** when no row is primary;
  `current_user_role()` resolves via `is_primary DESC, level ASC` regardless
- **Defect:** no provisioning endpoint exists among the 26 edge functions, so roles
  are assigned out-of-band. A single role row inserted without
  `is_primary = true` locks that user out of **the entire Edge API**, while RLS
  continues to resolve them at least privilege — so the database sees a valid user
  and the API does not.
- **Consequence:** an onboarding mistake produces a user who cannot use the
  product, with a 403 that does not explain why.
- **Test evidence:** **none.** `supabase/seed.sql:145-155` seeds four `user_roles`
  rows, **all with `is_primary = true`**, so no fixture ever exercises the hazard.
- **Evidence class:** CONFIRMED (code + schema + seed)

### P1-13 — Authorization ignores account deactivation

- **Requirement:** Z-07, N5-10
- **Locations:** `has_permission()` never consults `profiles.is_active`;
  `user_roles` has **no `is_active` and no `revoked_at` column**
- **Defect:** role revocation is **DELETE-only**. Deactivating a profile does not
  remove their permissions, because the permission check does not look at the
  profile.
- **Consequence:** a deactivated staff member retains database-level permissions
  until their `user_roles` rows are physically deleted. There is no audit trail of
  revocation, because the mechanism is a row deletion rather than a state change —
  which also conflicts with the append-only auditing posture asserted elsewhere
  (X-02).
- **Evidence class:** CONFIRMED

---

## 3. P2 — SERIOUS, SURVIVABLE WITH DOCUMENTED COMPENSATION (15)

### P2-01 — Subscription plan limits are unenforceable

- **Requirement:** S-05, S-06 — `ROADMAP.md:~208`, `~212`
- **Defect:** `check_booking_limit()` **does not exist** (exhaustive search across
  49 migrations, 26 functions, generated types, tests). `create-booking` (688 L)
  has **no quota gate** — it calls `record_subscription_usage` at `:649` and
  nothing else.
- **Consequence:** the roadmap's own success criterion — *"Hospital on Starter plan
  (50 bookings/month) gets blocked on #51"* — is unachievable. **Every plan tier is
  currently unlimited.** Usage is metered but never enforced.
- **Related dead surface:** `get_subscription_limits`, `is_subscription_active`,
  `change_subscription_plan`, `get_subscription_usage` all exist with no
  production caller.
- **Why P2 not P1:** revenue leakage is commercial, not patient-safety, and is
  detectable after the fact from the recorded usage.

### P2-02 — GST is debited to the ledger but never charged to the payer

- **Requirement:** X-12
- **Locations:** live resolver `get_effective_fees` v2 (mig 35) returns
  `total_amount = platform_fee + receptionist_fee` with **GST excluded** and
  `hospital_fee = 0`; GST-aware `get_booking_fee` (mig 28) has **no caller**;
  `create-payment-order` charges `total_amount_snapshot`; yet `capture_payment`
  writes a **`gst_debit`** ledger entry
- **Consequence:** the ledger records a GST liability against money that was never
  collected. Tax reporting derived from the ledger will not reconcile to gateway
  settlements. Also listed as **NPD-01** because the correct resolution (charge GST,
  or stop booking it) is a business decision.

### P2-03 — `capture_payment` permits re-capture of partially refunded orders

- **Requirement:** PART 15 (no double capture)
- **Location:** guard excludes only `('captured','refunded')`
- **Defect:** an order in `'partially_refunded'` state passes the guard and can be
  captured again, duplicating `booking_fee_collected`.
- **Consequence:** double-counted collection on any partially refunded booking that
  receives a second capture attempt — reachable via webhook retry once P1-01 is
  fixed.

### P2-04 — Gateway fee is always an estimate, never the actual

- **Requirement:** PART 15
- **Location:** the runtime calls the 4-argument `capture_payment` overload
  (`34:249`), leaving `p_gateway_fee_inr` NULL, which falls back to
  `ROUND(amount * 0.02, 2)`
- **Consequence:** every gateway fee in the ledger is a 2 % approximation. Real
  Razorpay fees vary by instrument (UPI, card, netbanking) and by GST treatment.
  Reconciliation against gateway statements will show a permanent, growing
  variance that no report attributes to this cause.

### P2-05 — Five materialised views have zero consumers; the forecast is duplicated

- **Requirement:** N4-04, N4-05
- **Locations:** `mv_daily_hospital_stats` (`08:48`), `mv_doctor_performance`
  (`08:154`), `mv_peak_hour_analysis` (`08:239`), `mv_village_analysis` (`08:275`),
  `mv_revenue_forecast` (`08:314`); refreshed by `refresh_analytics_views_ordered`
  (`17:597`) → `refresh_single_mv` (`17:497`)
- **Defect:** no edge function, RPC or test reads any of the five. The only read is
  `mv_revenue_forecast`'s own body reading `mv_daily_hospital_stats` (`08:345`).
  Meanwhile `get_revenue_forecast` (`47:1556`) — the **wired** forecast — computes
  the same business question from live `daily_collection_entries` using a different
  method and different inputs.
- **Consequence:** nightly compute cost and lock pressure for output nobody reads,
  plus **two divergent answers** to "what will this hospital earn this month". The
  wired one additionally inherits P1-05's unpaid-booking contamination.
- **Note:** the refresh mechanism itself is correct — `CONCURRENTLY`, unique
  indexes, dependency order. The engineering is good; the wiring is absent.

### P2-06 — Partition automation is advisory only, and misreports readiness

- **Requirement:** T-05, N3-05, N3-06
- **Defect:** `plan_partitions` inserts `'planned'` manifest rows;
  `generate_audit_log_partition_ddl` emits DDL **text**; **nothing executes
  either**; **no table in the schema is partitioned**. `check_partition_readiness()`
  nonetheless returns `'Partitions will auto-create'`, and nightly step 7 reports
  success while creating nothing.
- **Consequence:** `audit_logs` and other high-volume tables grow unpartitioned
  while the system reports that partitioning is handled. An operator reading the
  readiness output would reasonably conclude no action is needed.

### P2-07 — The migration registry the project built for itself is 10 % populated

- **Requirement:** F-04
- **Location:** `26_migration_metadata_&_registry.sql` — `migration_registry`
  (`:33`), `record_migration` (`:219` INSERT, `:317` UPDATE),
  `take_deployment_snapshot` (`:479`, invoked `:552` with `'initial-deploy-v1'`);
  backfill at `:520-546` seeds **two rows only**
- **Defect:** only migrations **01, 26, 39, 48, 49** ever register themselves —
  **5 of 49 ≈ 10 %**.
- **Consequence:** the registry, execution log, deployment snapshots and checksum
  governance are **decorative**. They cannot answer "what is deployed here", which
  is the one question they exist to answer — and they would have been the natural
  place to record the freeze amendment that P2-08 shows is missing.

### P2-08 — The architecture freeze was breached and the breach was never recorded

- **Requirement:** Z-01, Z-10 — `ROADMAP.md:45-47` (*"Migration 37 is the last
  schema change"*), `:66` (amendment gate)
- **Measured post-freeze DDL:** **5 new tables** —
  `whatsapp_conversation_states` (42), `queue_runtime_events` (43),
  `consultation_notes` (46), `alert_activity_log` (47), `alert_suppressions` (47);
  **17 new columns** — 38 ×2, 43 ×4, 45 ×3, 47 ×8; **1 new enum value** —
  `42:25` `whatsapp_message_status` ADD VALUE `'received'`
- **Exonerating detail:** migrations **40, 41 and 48 contain zero DDL**, so Phase
  0.5's own "no schema changes in 40/41" sub-claim is **independently verified
  true**. The breach belongs to 38 and 42–47.
- **Consequence:** the freeze provided no protection, and **no artifact authorises
  or even records** the changes. `supabase db diff` (V-02) would have surfaced this;
  it was never run.

### P2-09 — A documented negative constraint is contradicted by shipped code

- **Requirement:** I-03 — `ROADMAP.md:~248`, *"Verify `run-cron-nightly` does NOT
  wake worker (nightly tasks are synchronous)"*
- **Defect:** `run-cron-nightly/index.ts:296` posts to `run-background-worker`
  (step 9) — precisely the forbidden behaviour — and does so with the wrong
  credential (P1-07).
- **Consequence:** an explicit architectural prohibition was violated without any
  recorded amendment. The violation is currently masked by the 403, which means
  fixing P1-07 in isolation would *activate* the prohibited behaviour.

### P2-10 — Booking and payment order are not created atomically

- **Requirement:** I-02 — `ROADMAP.md:~236`
- **Defect:** `create-booking` (688 L) creates no payment order; order creation is
  a separate endpoint (`create-payment-order`, 406 L).
- **Consequence:** a booking can exist with no payment order — which is exactly the
  state every WhatsApp booking is in (P1-05). Two round trips also mean a client
  crash between them leaves an unpaid, unbilled booking with revenue already
  credited to the ledger.

### P2-11 — 27 % of the SQL surface is unreachable from product code

- **Requirement:** X-10, N5-12
- **Measured:** **191 unique routines** (not the 193 claimed). **41 have no caller
  anywhere**; **11 are referenced only by tests** → **52 of 191 ≈ 27 %**.
- **Whole subsystems affected:** worker crash recovery (3 routines — the P0-01
  root cause), subscription enforcement (4), GST-aware fee resolution
  (`get_booking_fee`), partition DDL generation, `run_nightly_tasks`.
- **Consequence:** the codebase's apparent capability substantially exceeds its
  actual capability. Every one of the audit's P0/P1 findings involves a routine
  from this set — unreachable code is where defects survive undetected.

### P2-12 — Duplicated orchestration with divergent behaviour

- **Requirement:** X-09
- **Instances:**
  1. SQL `run_nightly_tasks` (migrations 11, 17) is **dead** — `run-cron-nightly`
     reimplements the whole sequence in TypeScript, so the SQL version's ordering
     and error handling are never used.
  2. `queue-control` (392 L, 10 actions) and `doctor-operations` (610 L, 15
     actions) **both** expose `recall` / `skip` / `restore` / `mark_absent` /
     `resume` — two endpoints, two role gates, one state machine.
- **Consequence:** behaviour depends on which endpoint a client happens to call.
  Fixes applied to one path silently do not apply to the other.

### P2-13 — Four superseded v1 RPCs retained as live, callable definitions

- **Requirement:** X-09
- **Pairs:** `claim_jobs` / `claim_jobs_v2`, `complete_job` / `complete_job_v2`,
  `fail_job` / `fail_job_v2`, `register_webhook_event` /
  `register_webhook_event_v2`
- **Defect:** all four v1 forms have **zero callers** and **no deprecation marker**.
- **Direct link to P0-01:** the retained v1 `claim_jobs` is the version that
  **correctly sets `lease_expires_at`** (`06:283`). The dead-but-correct
  implementation sits beside the live-but-broken one.
- **Audit note:** a prior session mis-classified `register_webhook_event` as
  test-only because a substring grep matched `register_webhook_event_v2`. A
  word-boundary search confirms v1 exists only at `04:667`, `04:701` and
  `database.generated.ts:7005`. **Corrected tally: 41 no-caller / 11 test-only of
  191.**

### P2-14 — The test suite does not cover the paths that fail

- **Requirement:** PART 17 — *"Does the test suite provide meaningful evidence?"*
- **Counted:** 162 integration cases + 65 unit cases. Unit suite **executed: 65
  passed / 0 failed**. Integration suite **NOT RUN** (Docker).
- **Coverage gaps at the exact defect sites:**
  - **no test** for `job_queue` reclamation (P0-01) — the only similarly-named test
    covers `reclaim_stale_whatsapp_processing`, a different table
  - **no test** for partial refunds (P1-02)
  - **no test** for `cancel-booking`'s refund path (P0-04)
  - **no test** for the single-role-no-primary lockout (P1-12)
  - **no test** supplies a genuine Razorpay webhook signature (P1-01)
  - **no concurrency test** for refund-versus-settlement (R-08)
- **Coverage that is nominal only:** **10 of the 11 test-only routines** are
  covered *solely* by REVOKE assertions in `privilege_isolation.test.ts` —
  `calculate_refund_amount`, `change_subscription_plan`,
  `current_user_has_permission`, `generate_audit_log_partition_ddl`,
  `get_booking_fee`, `get_platform_revenue_breakdown`, `get_subscription_limits`,
  `get_subscription_usage`, `get_user_permissions`, `is_subscription_active`. A
  REVOKE assertion proves a routine is *not callable*; it proves nothing about
  whether it works. Only `get_retention_report` and `get_subscription_usage` have
  genuine functional coverage (`usage_retention.test.ts`).
- **Active concealment:** `whatsapp_conversational.test.ts:838` hand-sets
  `booking_fee_inr`, making a green test hide P0-04.
- **Consequence:** the suite is substantial and well-constructed for the paths it
  covers, and **systematically absent** at every point where this audit found a
  P0 or P1 defect. Test count is not evidence of coverage.

### P2-15 — `job_queue.job_type` is unconstrained, with producer/handler mismatches

- **Requirement:** I-06, PART 13
- **Defects:** `job_queue.job_type` has **no CHECK constraint**;
  `create_partition` is claimable but **has no handler and no producer**;
  `refresh_analytics` and `send_notification` have **zero producers**.
- **Consequence:** a typo'd `job_type` enqueues successfully and is then claimed by
  a worker that has no handler for it, producing repeated failures until the job
  dead-letters — or, given P0-01, hangs in `processing` forever.

---

## 4. P3 — DOCUMENTATION, CONSISTENCY, HYGIENE (10)

| ID        | Gap                                                                      | Location / evidence                                                                                                                                                                    | Consequence                                                                                     |
| --------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **P3-01** | Authorization errors surface as HTTP 500 instead of 403                   | `alert-center` wraps RPC errors in `InternalError`, so migration 48's `42501` insufficient-privilege errors become 500                                                                    | Clients cannot distinguish "not allowed" from "server broken"; monitoring misattributes the cause |
| **P3-02** | Two type sources with no divergence guard                                 | Hand-maintained `_shared/types.ts` (328 L, hand-written enum mirrors) alongside generated `_shared/database.generated.ts`. `gen:types:check` exists in `deno.json`; **CI never runs it**  | Structural risk only — `BookingStatus` spot-check is currently in sync with `01_foundation.sql:34-45`. Violates the Z-02 freeze wording |
| **P3-03** | `WORKER_LEASE_SECS` is a dead configuration knob                          | Documented in `.env.example`, typed at `env.ts:173-174` as `DEFAULT_WORKER_LEASE_SECS`, re-exported at `:263`; **zero consumers**                                                        | Residue of the abandoned v1 lease path; misleads operators into believing leases are configurable — reinforces P0-01 |
| **P3-04** | 18 of 49 migrations lack explicit `BEGIN;` / `COMMIT;`                     | Missing in 01–11, 39, 42–47; present in 12–38, 40, 41, 48, 49. **The entire executed 1.1–1.4 block (42–47) is unwrapped**                                                                | Consistency drift, **not a demonstrated correctness defect** — the Supabase CLI wraps each file in a transaction |
| **P3-05** | `ARCHITECTURE.md` states the wrong database version                       | Says **PostgreSQL 15**; `supabase/config.toml:36` sets `major_version = 17`                                                                                                             | The frozen architecture document misdescribes the platform by two major versions                 |
| **P3-06** | Stale "37 migrations" comments                                            | `_shared/types.ts` header: *"generated from the live schema (all 37 migrations)"*; `ARCHITECTURE.md` likewise. HEAD has **49**                                                            | Every reader is told the schema is 12 migrations smaller than it is                              |
| **P3-07** | Validator warning count misreported in every phase report                 | Reports 0.5 → 1.4 all state *"3 pre-existing warnings"*. **Executed this audit: 4** — `dashboard_presence` (11+20), `check_partition_readiness` (15+22), `partition_health` (15+22), `idx_alert_events_open` (`24:140` + `47:83`) | A copied number that stopped being re-measured — a small instance of the RULE 2 failure mode      |
| **P3-08** | Migration 49's own documentation is internally inconsistent               | Header says *"Three functional defects"* then lists **four**; section titled *"5. VERIFICATION"* contains assertions numbered **4.1–4.10**                                                | Reduces confidence in a migration whose §5 assertion block is otherwise genuinely self-proving    |
| **P3-09** | India-specific assumptions are pervasive and undocumented                 | INR-only (`*_inr` naming throughout), GST semantics, `+91` phone handling, IST-relative day boundaries in DCE and nightly logic, single-language templates. No locale/currency/timezone abstraction | Acceptable for the stated market, but nothing states it — the constraint is invisible to a future integrator or buyer |
| **P3-10** | `stop_worker` references a function that does not exist                   | Migration 39 comments about `recover_crashed_worker_jobs`; the real (uncalled) function is `reclaim_crashed_worker_jobs`                                                                 | A maintainer following the comment finds nothing, and may conclude recovery exists — masks P0-01  |

---

## 5. NPD — REQUIRES A BUSINESS RULING BEFORE ENGINEERING (6)

These cannot be assigned a severity by engineering. Each has money attached and a
defensible answer in more than one direction.

| ID        | Question the business must answer                                                                                 | Current behaviour                                                                                                                              | Blocked work                                    |
| --------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **NPD-01** | **Is GST charged on the booking fee?**                                                                             | GST is **debited to the ledger but excluded from every charge**. `get_effective_fees` v2 (mig 35) returns `platform_fee + receptionist_fee`, GST excluded, `hospital_fee = 0`; the GST-aware `get_booking_fee` (mig 28) has no caller | P2-02, and all tax reporting                    |
| **NPD-02** | **When is revenue recognised — at booking or at collection?**                                                       | At **booking INSERT** (`13:479`), for **every** booking including WhatsApp bookings that have no payment mechanism at all                        | P1-05, settlement correctness, forecast accuracy |
| **NPD-03** | **What does a `daily_collection_entries` row count as?** (carried as **D-3**)                                       | One row per booking regardless of payment (mig 07 trigger, no WHEN clause); partial refunds zero the whole row (P1-02), so DCE is not a reliable payment count under any reading | P1-02, P1-06, forecast, settlement              |
| **NPD-04** | **How is a user with multiple roles resolved?** (carried as **D-1**)                                                | **Three different answers coexist:** `has_permission()` unions all roles (most privilege); `current_user_role()` reduces via `is_primary DESC, level ASC` (least privilege); `auth.ts::selectRole()` denies outright when no row is primary. Both "same rule" doc claims are inaccurate; `multi_role_auth.test.ts` test 6 proves the divergence. **No cross-tenant escalation exists** — the inconsistency is intra-tenant | P1-12, and the `has_permission()` verdict       |
| **NPD-05** | **What is the JWT boundary in production?** (carried as **D-2**)                                                    | Unknown. `config.toml` has no `[functions]` section; no deploy artifact exists. Either the seven machine endpoints are unreachable, or JWT is disabled out-of-band and HMAC is the only authentication | P1-09, deployment                               |
| **NPD-06** | **What owns `system_settings`, and how does it rank against `hospital_settings` / `feature_flags`?** (carried as **D-4**) | Seeded by `seed.sql`; no documented precedence model                                                                                            | Configuration correctness                        |

D-1 through D-4 were already recorded as open decisions in the Phase 1.5 recovery
report. **They remain open.** NPD-01 and NPD-02 are surfaced by this audit and
have not previously been recorded as decisions anywhere.

---

## 6. SUMMARY TABLES

### 6.1 Counts

| Severity | Count  | Character                                                                    |
| -------- | ------ | ---------------------------------------------------------------------------- |
| **P0**   | **4**  | Production blocking — silent loss of patient work or patient money            |
| **P1**   | **13** | Deploy blocking for a paying hospital — financial or security incorrectness    |
| **P2**   | **15** | Serious, survivable with documented compensation                              |
| **P3**   | **10** | Documentation, consistency, hygiene                                           |
| **NPD**  | **6**  | Awaiting a business ruling                                                    |
|          | **48** | **Total register entries**                                                    |

### 6.2 The four P0s share two root causes

| Root cause                                  | Entries              | Single corrective action                                            |
| ------------------------------------------- | -------------------- | ------------------------------------------------------------------- |
| **The queue runtime never actually runs**    | P0-01, P0-02, P0-03  | Populate `lease_expires_at` in `claim_jobs_v2` (or call the existing v2 recovery routines); configure a scheduler; reconcile the worker-trigger default |
| **A column with no writer gates the money**  | P0-04                | Write `booking_fee_inr` at booking creation — **and** first resolve P1-10, or the fix converts a silent no-refund into a silent wrong-refund |

### 6.3 Highest-leverage verifications requiring no code change

| Action                                                        | Resolves                                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Start Docker, run `deno task test:integration` (162 cases)     | P1-11 and 9 UNPROVEN matrix rows (F-01, F-02, F-03, F-11, V-03, N5-02/03/04, N1-10 partially) |
| Run `supabase db reset` against 01→49 on a fresh database      | F-02, and would surface any ordering defect introduced since migration 41         |
| Query `pg_proc.proacl` for the 145 Category B routines         | P1-11 definitively                                                              |
| Record the deployed `verify_jwt` setting in `config.toml`       | P1-09 / NPD-05                                                                  |

**Nine of the twelve UNPROVEN matrix rows are unverified claims, not defects.**
No certification should be granted or revoked on them in either direction
(PART 21).

---

**No source code, migration, test, configuration file or pre-existing document was
modified in the production of this register (RULE 1). No defect listed here was
fixed; every entry is recorded as a finding for a future remediation phase.**
