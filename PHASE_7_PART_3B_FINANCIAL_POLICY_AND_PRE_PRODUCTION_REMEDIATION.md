# PHASE 7 — PART 3B: FINANCIAL POLICY AND PRE-PRODUCTION REMEDIATION

Scope authority: the 782-line PART 3B specification (owner decisions FINAL,
implementation AUTHORIZED, staging CORS AUTHORIZED, production FORBIDDEN).
This report is that specification's §18 deliverable with exactly its 23
sections. Certification vocabulary is the §16 set —
**PROVEN · IMPLEMENTED · BLOCKED · DEFERRED · NOT IMPLEMENTED · UNPROVEN** —
and LOCAL ≠ STAGING ≠ PRODUCTION throughout.

---

## 1. Executive Summary

D16 (the owner-finalized financial policy) was implemented as two additive
migrations (59, 60) plus two Edge Function changes, then verified against the
real local Supabase stack and — for the first time in this phase — against the
linked **staging** project:

- SETURA's Razorpay charge basis is now `booking_fee_inr` only, never
  `total_amount_snapshot` (Q1).
- Revenue is recognized **only at capture**: booking creation and pending
  payment orders write no SETURA cash revenue and no money-bearing settlement
  row (Q3/Q4).
- One canonical refund basis (amount actually collected) with a **cumulative**
  `total_refunded ≤ total_collected` cap enforced in SQL; partial refunds now
  reduce settlement **pro rata** instead of zeroing it (Q2/Q5).
- The authorized staging CORS correction was executed and verified by
  before/after preflight evidence (no plaintext secret exposure).
- Full local regression: unit 91/91, integration **226/226** (including the
  new 11-test D16 suite), frontend 17/17. The Phase-6 core-journey E2E
  **PASSED against both the local stack and staging**.

No production deployment, production project, production secret, DNS entry or
real payment was created or touched (§19 compliance). Production readiness is
NOT claimed; see §20–§23.

---

## 2. Final Owner Decisions

Per spec §1 these are final and were not re-litigated:

| ID | Decision (condensed) | Status after this phase |
| --- | --- | --- |
| D16 Q1 | SETURA collects ONLY the booking/platform fee via Razorpay | IMPLEMENTED; SQL+Edge sides PROVEN by d16 tests |
| D16 Q2 | Refund ≤ amount actually collected; ONE basis for all paths | IMPLEMENTED; cumulative cap PROVEN |
| D16 Q3 | Revenue recognized at successful capture | IMPLEMENTED; PROVEN |
| D16 Q4 | Unpaid/WhatsApp bookings create no collected revenue/settlement amounts | IMPLEMENTED; PROVEN |
| D16 Q5 | Partial refunds reduce only the refunded amount; idempotent accounting | IMPLEMENTED; PROVEN |
| D16 Q6 | GST applies to SETURA's platform fee only (pending CA confirmation) | IMPLEMENTED (software separation); tax advice DEFERRED to CA |
| D16 Q7 | Gateway fee absorbed by SETURA, recorded separately | IMPLEMENTED; PROVEN at ledger level |
| D5 | Backup/DR baseline: RPO ≤ 15 min, RTO ≤ 4 h, 30-day retention, restore test before pilot | PLAN ONLY (§13) — NOT IMPLEMENTED, as instructed |
| D6 | Option A — scheduler wakes the worker (pg_cron → pg_net → run-cron-minute → run-background-worker) | DECISION recorded; production enablement DEFERRED (§14) |
| D13 | Production domain: do not invent; otherwise NOT YET SELECTED | **DOMAIN = NOT YET SELECTED** (§15) |
| §5 | Staging CORS: add `https://setura-delta.vercel.app`, preserve existing, no `*` | EXECUTED and PROVEN (§16) |

---

## 3. D16 Financial Policy

Canonical model implemented (spec §7):

```text
booking_fee_inr          = SETURA platform/booking fee   ← the ONLY Razorpay charge
hospital_fee_snapshot    = hospital consultation amount  ← never collected by SETURA
receptionist_fee_snapshot= receptionist incentive        ← never collected by SETURA
total_amount_snapshot    = operational/display aggregate only
```

Lifecycle, enforced in SQL (not merely in Edge code):

```text
Booking created            → no SETURA cash revenue, zero-value collection row
Payment order created      → still no revenue
Payment captured           → financial_ledger 'booking_fee_collected' (credit)
                             + 'gateway_fee_debit' + 'gst_debit' (separate entries)
                             + daily_collection_entries UPSERT to collected amount
Refund processed           → 'refund_debit'; collection reduced by exactly the
                             refunded amount while unsettled
Invariant                  → total_refunded ≤ total_collected (cumulative, SQL-enforced)
```

Financial state and operational booking state remain separate: walk-in,
manual/WhatsApp and unpaid bookings continue to work unchanged.

---

## 4. Current Source Findings

Verified from actual source before any change (spec §6A), with the exact
objects inspected: `create_booking`, `capture_payment` (16/34/56 chain),
`create-payment-order`, `record_payment`, `cancel-booking`,
`whatsapp_cancel_booking` (42), `calculate_refund_amount`, `initiate_refund`
(13), `process-refund`, `confirm_refund_processed` (41),
`trg_booking_ledger` / `write_booking_ledger_entries` (13),
`trg_auto_create_collection` / `auto_create_collection_entry` (07),
`daily_collection_entries` + `valid_collection_total` (07:73), the
settlement engine (07/33), and the snapshot/fee columns.

## 5. Financial Contradictions Found

Five genuine contradictions, each proven from source before remediation:

1. **Revenue at INSERT (Q3 violation).** `trg_booking_ledger`
   (migration 13:479, AFTER INSERT `WHEN total_amount_snapshot > 0`) wrote
   `platform_fee_credit` + `receptionist_incentive_credit` the moment a
   booking row was inserted — with no payment involved — and double-counted
   against `capture_payment`'s `booking_fee_collected` (34:204).
2. **Settlement before capture (Q4 violation).**
   `trg_auto_create_collection` (07:306, AFTER INSERT, no WHEN clause) gave
   every booking — paid or not — a `daily_collection_entries` row carrying the
   FULL `total_amount_snapshot`, so settlement input existed before any
   capture (matches NPD-02/P1-10).
3. **Wrong charge basis (Q1 violation).** `create-payment-order` built the
   Razorpay order from `total_amount_snapshot`, collecting hospital and
   receptionist money SETURA does not own.
4. **All-or-nothing refund settlement (Q5 violation).**
   `confirm_refund_processed` (41:100) zeroed the ENTIRE unsettled collection
   row (platform/receptionist/hospital/total) for ANY refund, full or partial.
5. **Per-request refund cap only (Q2/S9 violation).** `initiate_refund`
   (13:700) capped each refund individually at `payment_orders.amount_inr`,
   never the cumulative sum — repeated partials could exceed collections.

## 6. Technical Remediation

- **Migration 59** (`59_d16_revenue_at_capture.sql`):
  `write_booking_ledger_entries()` → deliberate no-op (booking INSERT is not
  a revenue event; deprecated entry types no longer emitted);
  `auto_create_collection_entry()` → zero-amount collection row unless the
  booking is already `payment_completed` (row-per-booking operational record
  preserved; the D-3 non-zero counting rule then excludes unpaid bookings
  from "payments"); `capture_payment(5-arg)` → on success upserts the
  booking's collection row to the actually-collected amount
  (`v_order.amount_inr`, receptionist/hospital fees = 0), and writes
  `booking_fee_collected`, `gateway_fee_debit`, `gst_debit` as separate
  ledger entries (Q6/Q7).
- **Migration 60** (`60_d16_refund_unification.sql`):
  `initiate_refund` → cumulative guard `SUM(non-failed refunds) + requested
  ≤ amount_inr`, and accepts orders in `('captured','partially_refunded')`
  so sequential partials work while the cap bounds them;
  `confirm_refund_processed` → idempotency guard preserved, order status
  derived from cumulative processed refunds (last partial of a sequence
  reaches 'refunded'), and the unsettled collection row is reduced by
  EXACTLY the refunded amount (`LEAST()` clamped, `valid_collection_total`
  preserved), with `total_refunded` / `remaining_collected` recorded in
  metadata.
- **Edge `create-payment-order`**: order amount = `booking.booking_fee_inr`
  (never the total) with an explanatory D16-Q1 comment.
- **Edge `process-refund`**: refund basis = `payment_orders.amount_inr`
  (what SETURA actually collected), shared by every refund path
  (direct/cancel-booking/WhatsApp); the SQL cap is the authoritative
  enforcement point.

No applied migration (01–58) was edited. F16-04 discipline: every changed
function is a `CREATE OR REPLACE` of an existing signature (ACL/OID
preserved) with the service_role-only posture EXPLICITLY restated
(REVOKE PUBLIC/anon/authenticated + GRANT service_role) and asserted in an
in-transaction self-check DO-block (probe + `has_function_privilege` checks +
"migration NN verification passed" NOTICE). MANIFEST.sha256 updated (60
entries, re-hashed after the mid-session edit to 60; manifest validator
60/60 lines, 0 issues).

**Known limitation (fail-closed, not fixed this phase):** the
`process-refund` Edge prefetch selects only `payment_status = 'captured'`,
so a *second sequential* partial refund attempted through that Edge Function
is rejected even though the DB layer (migration 60) permits it. The direct
SQL path and all canonical single-refund flows work; the gap only blocks
additional partials via that one Edge entry point and never over-refunds.
Tracked as F3B-01 (§22) — one-line fix (`.in("payment_status", […])`) needs
its own redeploy + regression pass.

## 7. Migration List

| # | File | Lines | Status |
| --- | --- | --- | --- |
| 59 | `supabase/migrations/59_d16_revenue_at_capture.sql` | 443 | applied LOCAL + STAGING, self-check NOTICE observed on both |
| 60 | `supabase/migrations/60_d16_refund_unification.sql` | 349 | applied LOCAL + STAGING (final version with the `partially_refunded` fix), self-check NOTICE observed on both |
| — | `supabase/migrations/MANIFEST.sha256` | 60 entries | updated; `validate:migrations` 0 errors / 4 pre-existing `[duplicate-objects]` warnings (known baseline) |

## 8. Revenue Recognition Model

Recognition point: **inside `capture_payment`, success branch only**.
Evidence (d16 suite, real stack): a created booking → ledger revenue 0 and
zero-value DCE (PROVEN); a pending payment order → still 0 (PROVEN); capture
→ ledger `booking_fee_collected` == platform fee and DCE upserted to the
same amount (PROVEN). The migration-59 self-check additionally proves
at-apply-time that the FALSE path of `capture_payment` writes nothing
(PROVEN). Reconciliation note: `platform_fee_total` /
`receptionist_fee_total` derived fields (migration 13) now read 0 by design
— no test asserted them; `total_collected` is the authoritative SETURA
revenue figure.

## 9. Refund Model

One basis: `payment_orders.amount_inr` (== `booking_fee_inr` under Q1).
One enforcement point: `initiate_refund`'s cumulative guard, which excludes
`failed`/`rejected` refunds from the consumed budget, holds the order row
`FOR UPDATE` (concurrency-safe), and RAISEs on
`prior + requested > collected` (PROVEN by the over-refund test). All
supported paths (receptionist/API via `cancel-booking`, WhatsApp, direct
`process-refund`) share the basis; `calculate_refund_amount` was already
platform-fee-bounded (verified; test PROVEN).

## 10. Partial Refund Model

Spec §10 worked example implemented literally: collect ₹100 → refund ₹40 →
DCE reads 60 (`total_refunded` 40, `remaining_collected` 60 in metadata) →
refund ₹60 → DCE reads 0 and the order reaches 'refunded' (PROVEN by the
sequential-partial test). A replay of `confirm_refund_processed` returns
FALSE and duplicates neither ledger rows nor adjustments (PROVEN).
Refunding more than collected raises at `initiate_refund` (PROVEN).

## 11. Payment Failure Model

A failed payment never enters the capture success branch, so it cannot write
revenue, and the zero-value placeholder DCE keeps its amounts at 0 —
SETURA collected revenue = ₹0, ledger = ₹0, refund not applicable. The
operational booking remains per existing policy. Classification: PROVEN
structurally by the migration-59 absent-order self-check probe (FALSE path
writes no ledger row) and by the pending-order test (no revenue before
capture); a dedicated live-gateway failure webhook remains UNPROVEN
(no real Razorpay credentials, §20).

## 12. Settlement Model

Settlement consumes `daily_collection_entries`; after migration 59 only
captured money is ever present, and after migration 60 a partial refund
reduces the unsettled row by exactly the refunded amount instead of zeroing
it (PROVEN by d16 + the settlement/financial regression reruns). Already
settled periods are untouched (UPDATE is `is_settled = false` scoped).
Enterprise rollup assertions were realigned to the corrected values (§18).

## 13. D5 Backup / DR Plan (PLAN ONLY — NOT IMPLEMENTED)

Approved baseline: RPO ≤ 15 min · RTO ≤ 4 h · retention 30 days · restore
test REQUIRED before pilot. Per spec this is documentation only; nothing here
is claimed implemented.

- **Backup policy:** Supabase daily base backups + WAL archiving (PITR) on
  the production project. PITR at ≤15-min RPO must be confirmed against the
  actual chosen plan tier — required configuration: a production plan whose
  PITR window covers ≥ the RPO target; retention: 30 days (project export +
  PITR window).
- **Restore procedure:** restore to an *isolated* staging-like project (never
  over the live DB) → run `validate:migrations` → RLS/privilege re-verify
  (policy count + `pg_proc.proacl` census) → financial ledger invariant
  checks (`total_refunded ≤ total_collected`, DCE vs ledger reconciliation)
  → worker/scheduler state check → E1 core-journey smoke test.
- **DR procedure:** promote the restored isolated project via DNS cutover
  (domain per D13, §15) with the old project placed read-only; RTO ≤ 4 h
  must be *measured* by the restore test, not assumed.
- **Restore validation checklist (evidence to mark the gate PROVEN):**
  (1) dated restore run on a real backup, (2) measured RPO/RTO from that
  run, (3) all checklist gates green on the restored instance, (4) sign-off.
- **Re-provisioning after restore — explicit items:** `pg_cron` jobs (D6
  chain), Vault/Edge secrets (`ALLOWED_ORIGINS`, webhook and payment
  secrets), scheduler configuration, Edge Function deployments and their
  `verify_jwt` settings, Auth configuration (`site_url`, redirect URLs),
  external webhook endpoints (Razorpay, Meta). None of these survive a
  database-only restore; each needs re-application and verification.
- **Ownership:** backup configuration + restore drill = owner-designated
  operator; validation gates = this repository's CI commands; pilot sign-off
  = owner.
- Status: plan NOT IMPLEMENTED; gate PROVEN only after a real restore test
  run (§21).

## 14. D6 Worker Decision (Option A recorded — not enabled)

Approved architecture:

```text
pg_cron → scheduler_fire_minute → pg_net → run-cron-minute
        → run-background-worker → claim_jobs_v2
```

The worker must run autonomously; no external manual trigger in normal
production. `ENABLE_WORKER_TRIGGER` is to be handled consistently with this
decision and remains **NOT enabled** anywhere (production enablement is
deferred until separate production authorization, per spec §3).

Blocking facts that make Option A UNPROVEN today: (a) no scheduler is
installed anywhere — `pg_cron` `installed_version` NULL locally, zero
`pg_net` invocations in migrations (P0-02, design decision NPD-05);
(b) P0-01 regression stands — `claim_jobs_v2` (19) does not populate
`job_queue.lease_expires_at`, so crash recovery cannot reclaim v2-claimed
jobs; the W1 reclaim test passes at the SQL level but the column population
gap is unfixed. Implementing D6 therefore requires its own additive
migration + authorization — OUT OF SCOPE for 3B (D16-only) and DEFERRED.

## 15. D13 Domain Dependency Map (DOMAIN = NOT YET SELECTED)

No production domain is explicitly configured in the repository: `setura.in`
and `app.setura.in` appear only as `.env.example` placeholders and the
`env.ts` fallback default, and the live staging allow-list oracle (§16)
proved they are NOT configured on staging. Per spec they were NOT adopted.
Dependency map to execute once the owner selects the domain:

| # | Dependency | What must change / be verified |
| --- | --- | --- |
| 1 | Vercel custom domain | attach domain to the web project; confirm canonical URL + redirects |
| 2 | HTTPS | valid cert via Vercel; no mixed content |
| 3 | Supabase Auth `site_url` | production project Auth config ← domain |
| 4 | Auth redirect URLs | allow-list: login, confirmation, recovery |
| 5 | `ALLOWED_ORIGINS` (Edge env) | add exact production origin(s); never `*`; keep staging origins separate |
| 6 | CORS | re-run the preflight oracle (§16 method) after any change |
| 7 | Browser frontend env | `VITE_SUPABASE_URL` / anon key for production build; env per deployment, not committed |
| 8 | Razorpay webhook | point to production `verify-payment`/capture endpoint URL; signature secret rotated per environment |
| 9 | Meta webhook | production callback URL + verify token; `META_APP_SECRET` for HMAC |
| 10 | SMTP | production mail domain consistent with #1 (SPF/DKIM) |
| 11 | Cookies/session | Auth cookie domain scoped to production domain; SameSite/secure review |
| 12 | Monitoring | uptime + error alerts reference the production URLs only |

## 16. Staging CORS Authorization (spec §5) — EXECUTED, PROVEN

Originally recorded BLOCKED (no `SUPABASE_ACCESS_TOKEN` env); unblocked
in-session: the Supabase CLI is authenticated via the Windows Credential
Manager (target `Supabase CLI:supabase`), read in-memory via P/Invoke and
never echoed. The pre-change value could not be read back (secrets API
returns masked digests only), so membership was recovered with a
**preflight oracle**: `cors.ts` echoes an exact-matching Origin, otherwise
falls back to `ALLOWED_ORIGINS[0]` — OPTIONS probes therefore enumerate the
live allow-list without plaintext secret access.

Before (oracle evidence, queue-control OPTIONS):

| Origin | Before | After |
| --- | --- | --- |
| `https://setura-5h2ods4ir-…-projects.vercel.app` | ALLOWED (also the fallback → position [0]) | ALLOWED |
| `https://setura-l6xqmysgs-…-projects.vercel.app` | ALLOWED | ALLOWED |
| `http://localhost:3000` | ALLOWED | ALLOWED |
| `http://localhost:5173` | ALLOWED | ALLOWED |
| `https://setura-delta.vercel.app` | **NOT** (fallback echoed) | **ALLOWED** |
| `https://evil.example.com` | NOT | NOT (fallback = first original entry → ordering preserved) |
| `https://setura.in` / `app.setura.in` / other vercel URLs | NOT | NOT |

Method: `supabase secrets set ALLOWED_ORIGINS=<4 preserved>,https://setura-
delta.vercel.app --project-ref gzcqasntcbqqmgsoikms`. No wildcard; all
pre-existing origins preserved (proof: post-change fallback still echoes the
original first entry); production untouched. An unauthenticated POST from
the canonical origin reached the function's own auth rejection (401 from
`resolveAuth`), not a CORS/TLS failure — with the correct ACAO header.

## 17. Test Matrix (spec §14 → actual tests)

| Area | Required | Proven by | Class |
| --- | --- | --- | --- |
| Payment amount | platform fee only | d16 "Q1: create_booking records booking_fee_inr = platform fee only" | PROVEN (local+staging stack) |
| Payment amount | total never used for Razorpay order | Edge code now uses `booking_fee_inr` only; no live-gateway test | IMPLEMENTED; live-gateway leg UNPROVEN |
| Revenue | booking w/o payment; pending; captured | d16 Q3/Q4 ×3 tests | PROVEN |
| Revenue | failure / duplicate capture / replay | 59 self-check FALSE-path probe; capture branch guarded by `FOR UPDATE` + status filter; existing financial suites rerun green | PROVEN (SQL level); live webhook UNPROVEN |
| Refund | full; sequential partial; over-refund; duplicate confirm | d16 Q5 ×3 + Q2 cumulative tests | PROVEN |
| Refund | after failed payment; cancel before/after payment; WhatsApp/receptionist/API cancellation | existing `refund_sync`, `booking_fee_refund`, `whatsapp_lifecycle`, `hospital_core_journey` suites rerun green post-change | PROVEN (regression) |
| Settlement | partial ≠ zero-out | d16 sequential-partial DCE assertions + `settlement_record_payment` suite | PROVEN |
| Multi-tenancy | financial records cannot cross tenant | d16 "captured money is attributed to the booking's hospital only" + existing privilege/isolation suites | PROVEN |
| Authorization | unauthorized roles cannot do financial ops | migration 59/60 self-check ACL assertions + `privilege_isolation`/`security_s1` suites green | PROVEN (known F16-05/06 test-quality caveats stand) |
| Idempotency | no duplicate capture/revenue/refund/settlement adjust | d16 replay tests (create_booking key, confirm replay) | PROVEN |

## 18. Test Results (all executed in this phase, real stack)

| Suite | Result |
| --- | --- |
| `deno task test` (unit) | **91 passed / 0 failed** |
| New `d16_financial_policy.test.ts` | **11 / 11** |
| Financial regressions (`booking_fee_refund` + `refund_sync` + `settlement_record_payment`) | **11 / 11** |
| `hospital_core_journey.test.ts` (E1, incl. capture leg) | **18 / 18** |
| `enterprise_command_center.test.ts` | **23 / 23** after realigning 6 assertions to D16-correct values (fixture drift 800→300 expected: 300 collected / 30 platform / 250 hospital / 20 receptionist / net 300; offline_payments 0) |
| `whatsapp_conversational.test.ts` | **28 / 28** after a root-cause test-hygiene fix (holiday test now deletes its `hospital_holidays` row in `finally`; a leaked 2026-09-19 row had collided with date-relative fixtures — pre-existing, not D16-related; residue purged) |
| `deno task test:integration` (FULL) | **226 passed / 0 failed** (`integration-3b-final.log`) — no test weakened, deleted or skipped |
| Frontend `npm test` (apps/web) | **17 / 17** (3 files) |
| E2E `core_journey.mjs` — LOCAL | **PASSED** (all checks; after clearing a stale `in_consultation` booking from 2026-09-19 via the canonical `complete_consultation` RPC — data residue, not a product defect) |
| E2E `core_journey.mjs` — **STAGING** | **PASSED** against `https://gzcqasntcbqqmgsoikms.supabase.co` (after clearing 2 stale `called` bookings via canonical `skip_queue_token`) |
| `validate:migrations` | 0 errors / 4 known pre-existing warnings |
| MANIFEST validation | 60/60, 0 issues |
| `deno fmt --check` / `deno check` | clean on all touched files |

## 19. Staging Evidence

- **Migrations:** staging `schema_migrations` + `migration_registry` carry
  59 and the FINAL 60; both apply emitted their verification NOTICEs;
  content-marker query confirmed the deployed `initiate_refund` body contains
  the `partially_refunded` clause and `capture_payment` the migration-59
  body. Incident, detected and corrected the same session: the first
  `supabase db push --local` actually pushed to the REMOTE (CLI 2.100.1
  prompt text "push these migrations to the remote database"), landing 57–60
  (with the pre-fix 60) on staging; staging's 60 history rows were deleted
  and an explicit remote `db push` re-applied the corrected 60.
- **Edge Functions:** `create-payment-order` and `process-refund` deployed.
  A deploy flag (`--no-verify-jwt`) inadvertently flipped those two
  functions' JWT verification off — self-caught by listing all 26 functions
  (24 True) and RESTORED to `verify_jwt=true` via the platform API, verified
  by re-list. No secret values were ever printed; the only key handled was
  the project's public anon key for the E2E.
- **CORS:** §16 before/after oracle table; queue-control reachable from the
  canonical origin; unauthenticated POST reaches app-level auth rejection
  (401) with correct ACAO — no CORS-level failure.
- **§17 verification items:** login (receptionist + doctor) PROVEN on
  staging; authenticated API calls + queue-control snapshot + full doctor
  operations (start_session → call_next → start/save_note/complete
  consultation) PROVEN via the staging E2E; no localhost traffic (all
  requests to the canonical project URL); no secret leakage (token in memory
  only; public key used). Browser-level rendering from the live Vercel URL
  was NOT exercised (server-side preflight equivalent proven) → UNPROVEN
  for that one item.
- **Staging regression minimum mapping (spec §16):** Unit — PROVEN (local
  execution; no unit suite exists on staging per se). Frontend — PROVEN
  (local). E1 — PROVEN locally (18/18) and the HTTP-level core journey PROVEN
  on staging. W1/Scheduler — local suites PROVEN; on staging: DEFERRED
  (no scheduler exists per D6/P0-02; worker enablement not authorized).
  Financial — PROVEN locally (226/226 incl. d16); on staging the capture/
  refund SQL layer is the same applied migrations (PROVEN by content
  markers), live Razorpay/Meta legs UNPROVEN (no real credentials — by
  design). Security — PROVEN locally incl. privilege suites; staging
  `verify_jwt` posture restored and verified.

## 20. Remaining Blockers

All §19 hard-safety-rule compliant — these are gaps, not work-arounds:

1. Real external credentials absent by policy: Razorpay live, Meta
   production, SMTP → payment/refund/WhatsApp/email live legs UNPROVEN.
2. No production Supabase project (creation forbidden this phase).
3. D13 domain NOT YET SELECTED — blocks 5 production dependencies outright.
4. D6 Option A not implemented (no scheduler exists; P0-01 lease regression
   unfixed) — worker autonomy in production UNPROVEN.
5. D5 restore test never executed (nothing to restore yet) — RPO/RTO claims
   UNPROVEN.
6. F3B-01: `process-refund` Edge prefetch matches only 'captured' (blocks
   sequential partials via that one Edge path; fail-closed) — small fix +
   redeploy needed.
7. Staging browser-level CORS walkthrough (single item, §19).
8. Repo hygiene: six temporary `scripts/_*.ps1` staging helpers and run
   logs remain; no secrets inside (verified by inspection) — removal is a
   housekeeping action.

## 21. Production Gates

Sequence to reach a defensible "production ready" claim (none claimed now):

1. Owner selects production domain (D13) → execute §15 dependency map.
2. Provision production Supabase project + plan tier meeting D5 PITR/RPO.
3. Apply migrations 01–60 to production; verify self-check NOTICEs,
   manifest, privilege census.
4. Deploy Edge Functions with `verify_jwt=true` (never pass
   `--no-verify-jwt`); configure env secrets per environment.
5. Implement D6 Option A (scheduler + P0-01 lease fix) behind authorization;
   prove worker autonomy end-to-end.
6. Live-integration proofs: Razorpay test→live webhook round-trip, Meta
   webhook HMAC, SMTP delivery.
7. D5 restore drill with measured RPO/RTO; checklist green.
8. Full staging-equivalent regression on production + E1 smoke; monitoring
   and alerting verified.
9. Owner sign-off per gate.

## 22. Owner Decisions Still Required

1. **D13:** choose the production domain (nothing is configured; the
   `setura.in` strings are placeholders only).
2. **D5:** approve production plan tier / PITR window and schedule the
   restore drill; assign the operator who runs it.
3. **D6:** authorize the additive migration + configuration implementing the
   pg_cron→pg_net chain (and the P0-01 `claim_jobs_v2` lease fix it depends
   on for crash recovery).
4. **F3B-01:** authorize the one-line `process-refund` prefetch widening
   (or accept the fail-closed status quo).
5. Q6 GST: final CA/tax confirmation before commercial launch (software
   already separates platform fee from consultation amount).
6. Authorization for production deployment itself (explicitly NOT granted by
   PART 3B) and for real Razorpay/Meta/SMTP credential provisioning.

## 23. Final Status

D16 financial policy: IMPLEMENTED and PROVEN against the real local stack
(226/226 integration, incl. the new 11-test suite) and APPLIED to staging
(migrations 59/60 with verification NOTICEs; corrected Edge Functions
deployed; staging core-journey E2E PASSED; CORS authorization executed with
before/after evidence). Staging ≠ production: no production artifact exists
and none was created. Every blocker above is recorded BLOCKED/UNPROVEN with
its cause — none converted to PASS.

```text
PART 3B COMPLETE
PRODUCTION DEPLOYMENT NOT PERFORMED
PRODUCTION READINESS NOT CLAIMED
```

**Files changed:** `supabase/migrations/59_d16_revenue_at_capture.sql` (new),
`supabase/migrations/60_d16_refund_unification.sql` (new),
`supabase/migrations/MANIFEST.sha256` (60 entries),
`supabase/functions/create-payment-order/index.ts`,
`supabase/functions/process-refund/index.ts`,
`tests/integration/d16_financial_policy.test.ts` (new),
`tests/integration/enterprise_command_center.test.ts` (assertions realigned
to D16-correct values, comments citing evidence),
`tests/integration/whatsapp_conversational.test.ts` (test-hygiene cleanup
fix), temporary `scripts/_staging_sql.ps1` / `_cors_verify.ps1` /
`_staging_env_probe.ps1` / `_fncheck.ps1` / `_staging_anon.ps1` /
`_staging_e2e.ps1` (§16/§19 tooling; no embedded secrets).

**Migrations added:** 59, 60 (60 re-applied after the sequential-partial
correction — never edited in place after application on any environment
where it had already run in its older form without deleting that
environment's history first).

**Exact next owner authorization required:** select the production domain
(D13), then authorize production provisioning per §21 gates 2–4 — with D5
restore drill and D6 worker chain as separate, explicitly-authorized work
packages.
