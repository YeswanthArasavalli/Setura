# SETURA — Phase 7, Part 3A: Owner Decisions + Pre-Production Remediation

Date: 2026-09-21 (UTC+5:30 session)
Baseline: continues from `PHASE_7_PART_3_PRODUCTION_GO_LIVE_READINESS_PLAN.md`
(the authoritative Part 3 planning document). This package is **PRE-PRODUCTION
ONLY**: it resolves decisions and produces the exact technical remediation plan
required BEFORE any provisioning. **No production action, no staging secret
change, no applied-migration edit, no code/behavior modification** was
performed or is proposed for immediate execution here.

Every financial/scheduler/CORS claim below was re-derived from the **actual
source** (migrations, Edge Functions, `env.ts`, `cors.ts`), not from prior
reports. File:line citations are given so each claim is independently checkable.

Classification vocabulary (status columns only):
**PROVEN · IMPLEMENTED · BLOCKED · DEFERRED · NOT IMPLEMENTED · UNPROVEN.**

---

## 1. Executive summary

The five P0 pre-production items resolve as follows:

- **D16 (financial policy) is the highest dependency and is genuinely a
  business ruling, not an engineering bug.** The source shows the system is
  **internally inconsistent about its own money model**: it charges the patient
  the *full* `total_amount_snapshot` (create-payment-order `index.ts:191`), but
  treats `booking_fee_inr` (platform fee only) as the refund basis on two of
  three refund paths, and recognizes ledger revenue + settlement at booking
  **INSERT** rather than at payment **capture**. Which model is correct is the
  owner's decision. §3 maps it precisely and §4/§5 separate technical
  correctness from accounting policy. **Do not implement until decided.**
- **D5 (backup/DR):** nothing exists; retention engine (migration 23) prunes
  data with **no** counterpart backup. PITR/backup availability is
  tier-dependent. **Owner + paid-tier decision required.**
- **D6 (worker trigger):** `run-cron-minute/index.ts:386` gates the worker wake
  on `ENABLE_WORKER_TRIGGER === true`; the shipped default is `false`
  (`.env.example:16`), so a documented-default production deploy would
  **enqueue jobs but never process them**. Two architectures compared in §7;
  no winner declared.
- **D13 (domain):** the domain is a hard input to six coupled configuration
  surfaces; `setura.in`/`app.setura.in` are only the current *example* defaults
  (`env.ts:214`). Final domain is the owner's.
- **Staging CORS (§9):** a one-line, owner-approved staging `ALLOWED_ORIGINS`
  secret update. **Verified current value, exact change and rollback shown;
  NOT applied.**

Everything else is classified in §10 so this package does not spiral into a
re-audit. Production remains **BLOCKED** behind the decisions above plus the
owner's provisioning authorization.

---

## 2. Current Part 3 baseline (carried forward, not re-audited)

From `PHASE_7_PART_3_PRODUCTION_GO_LIVE_READINESS_PLAN.md` §2 (all re-verified
against the tree this session): Git repo at `56065ed` (=main=origin/main),
root `.gitignore` present, 399 tracked files, 58 migrations + 58-line
`MANIFEST.sha256`, 26 Edge Functions + `_shared`, Postgres 17, `site_url` =
localhost, `jwt_expiry` = 3600, `ENABLE_WORKER_TRIGGER=false`, CI has 4
test/validate jobs and **no deploy stage**, no `CODEOWNERS`, staging backend +
frontend **PROVEN (hosted staging only)**. Production does not exist.

The five P0 items below were the plan's §23 blockers; this document is the
resolution/remediation pass for exactly those.

---

## 3. D16 — Financial decision analysis (source-derived map)

### 3.1 Money columns on `bookings` (definitions from source)

| Column | Written by | Meaning (per source) |
| --- | --- | --- |
| `platform_fee_snapshot` | `create_booking` (mig 54) = `COALESCE(p_platform_fee,0)` | SETURA platform fee |
| `booking_fee_inr` | `create_booking` (mig 54:184) = `COALESCE(p_platform_fee,0)` | column comment: "The fee SETURA charges the patient and collects via Razorpay. This is the ONLY money SETURA receives." — refund basis for cancellation paths |
| `receptionist_fee_snapshot` | `create_booking` | receptionist incentive |
| `hospital_fee_snapshot` | `create_booking` | hospital/consultation share |
| `total_amount_snapshot` | `create_booking` (`v_total` = platform+receptionist+hospital, mig 54:137-140) | full amount |
| `consultation_fee_inr`, `paid_online` | mig 28 | display/reporting |
| `gateway_fee_inr`, `gst_amount_inr` | `capture_payment` (mig 34:199-200) | Razorpay MDR + GST, recorded at **capture** |

### 3.2 Answer set (the brief's numbered questions)

1. **Booking amount calculated:** `create_booking` `v_total =
   COALESCE(platform,0)+COALESCE(receptionist,0)+COALESCE(hospital,0)` →
   `total_amount_snapshot` (mig 54:137-140).
2. **Booking fee (platform) calculated:** `p_platform_fee` from hospital fee
   policy, stored in **both** `platform_fee_snapshot` and `booking_fee_inr`
   (mig 54:183-184).
3. **Payment amount calculated:** `create-payment-order` reads
   `total_amount_snapshot` → `amountInr` → paise `Math.round(amountInr*100)`
   (`index.ts:191-211`); stores `payment_orders.amount_inr = total_amount`.
   **The patient is charged the FULL total.**
4. **Refund amount calculated:** three different bases (see §3.3).
5. **Settlement adjustment calculated:** `confirm_refund_processed`
   (mig 41:100-112) zeroes the **entire** `daily_collection_entries` row
   (platform/receptionist/hospital/total all → 0) when a refund is processed,
   **only if `is_settled = false`**; already-settled periods are left intact.
6. **Ledger revenue recorded:** two triggers + capture:
   - `trg_booking_ledger` (mig 13:479, `AFTER INSERT … WHEN
     total_amount_snapshot > 0`) → `write_booking_ledger_entries` inserts
     `platform_fee_credit` (mig 13:436) + `receptionist_incentive_credit`
     (mig 13:459) at **booking INSERT**.
   - `capture_payment` (mig 34) → `booking_fee_collected` + `gateway_fee_debit`
     + `gst_debit` at **payment capture**.
   - `confirm_refund_processed` (mig 13/41) → `refund_debit` at **refund**.
   - `trg_auto_create_collection` (mig 07:306, `AFTER INSERT … **FOR EACH ROW,
     NO WHEN**`) → creates a `daily_collection_entries` row at **every booking
     INSERT** regardless of payment.

### 3.3 Scenario matrix (behavior actually coded)

| Scenario | What the source does |
| --- | --- |
| Paid booking (Razorpay) | charged `total_amount_snapshot`; capture writes `booking_fee_collected`+`gateway_fee_debit`+`gst_debit`; ledger credits + DCE already existed from INSERT |
| Unpaid booking (total>0, never paid) | INSERT **already** wrote `platform_fee_credit`+`receptionist_incentive_credit` + a DCE row → revenue/settlement counted with **no payment** (NPD-02) |
| WhatsApp booking | `create_booking` supplies fees → nonzero `total_amount_snapshot` → same INSERT-time revenue + DCE, no payment order (NPD-02 gap) |
| Cancelled before payment | `cancel-booking` refund only fires if `payment_completed` (line 265-268); no money moved; but INSERT-time ledger credits + DCE **already** recorded remain |
| Full refund via process-refund | refunds `total_amount_snapshot` (`index.ts:208-211`); writes `refund_debit` for that amount; zeroes DCE if unsettled |
| Full cancel via cancel-booking / WhatsApp | refunds `booking_fee_inr` **only** (`cancel-booking:269-272`, comment "Refund ONLY booking fee"); patient charged total but refunded platform fee → **hospital/receptionist portions not returned** |
| Partial refund | `process-refund` `fullRefund:false, amountInr:x` → refunds x (capped ≤ total by `initiate_refund:700`); but `confirm_refund_processed` **zeroes the WHOLE DCE** → settlement over-adjusted for a partial refund (P1-02/P1-10) |
| Duplicate refund | Edge `withIdempotency` + `process-refund` existing-refund check (`:234-252`); `confirm_refund_processed` guard returns FALSE if already `processed` (mig 41:48-50) → no duplicate ledger. `initiate_refund` itself does not dedup multiple pending partial rows — Edge layer is the guard |
| Payment failure | order stays `initiated/pending`; INSERT-time ledger credits + DCE already present → phantom revenue/settlement for an uncaptured payment (NPD-02) |

### 3.4 Refund-path basis table (P1-10, verbatim bases)

| Path | Actor | Refund basis | Source |
| --- | --- | --- | --- |
| `calculate_refund_amount` (tiered %) | receptionist | `booking_fee_inr` × policy % | mig 29:201 |
| `cancel-booking` | receptionist/admin | `booking_fee_inr` (full) | `index.ts:269-272` |
| WhatsApp cancel flow | patient | `booking_fee_inr` | mig 54 header (:14) |
| `process-refund` | hospital_admin/global_admin | `total_amount_snapshot` | `index.ts:208-211` |
| **What the patient actually paid** | — | **`total_amount_snapshot`** | `create-payment-order:191` |

### 3.5 Field → real-world meaning (which column means what)

| Concept | Current column | Consistent? |
| --- | --- | --- |
| Customer charge | `total_amount_snapshot` (`payment_orders.amount_inr`) | yes |
| SETURA platform fee | `platform_fee_snapshot` / `booking_fee_inr` | duplicated value |
| Hospital consultation amount | `hospital_fee_snapshot` | yes |
| Receptionist incentive | `receptionist_fee_snapshot` | yes |
| Gateway fee | `gateway_fee_inr` (config `razorpay_gateway_fee_pct` default 2.0) | captured only at capture |
| Collected cash | `booking_fee_collected` ledger (at capture) vs `daily_collection_entries.total_amount` (at INSERT) | **two different notions of "collected"** |
| Recognized revenue | `platform_fee_credit`+`receptionist_incentive_credit` (at INSERT) | conflicts with capture-basis |
| Refundable amount | `booking_fee_inr` (cancel paths) vs `total_amount_snapshot` (process-refund) | **inconsistent** |

### 3.6 THE core contradiction the owner must settle

`booking_fee_inr` is documented as "the ONLY money SETURA receives" and is the
cancellation refund basis, **yet** `create-payment-order` charges the patient
the full `total_amount_snapshot`. Both cannot be true. This single question
gates P1-10 and much of NPD-02:

> **Does SETURA collect only the platform fee via Razorpay, or the full
> consultation total (platform + receptionist + hospital), settling the other
> shares later?**

### 3.7 Business policy decision table (D16) — owner decides, do NOT pre-select

| Question | Current behavior | Possible policy choices | Technical consequence | Owner decision |
| --- | --- | --- | --- | --- |
| Q1 What does the patient pay at checkout? | full `total_amount_snapshot` | (a) platform fee only, (b) full total | choose basis for `create-payment-order` amount | **OPEN** |
| Q2 What is refundable on cancel? | `booking_fee_inr` (2 paths) vs `total` (1 path) | (a) what was actually charged, (b) platform fee only, (c) policy % of charged | unify refund basis across all 3 paths + tests | **OPEN** |
| Q3 Revenue recognition point | booking INSERT (ledger credits + DCE) | (a) at INSERT, (b) at payment capture, (c) accrual vs cash | move `write_booking_ledger_entries`/DCE trigger to fire on capture, or add `WHEN payment_completed` | **OPEN** |
| Q4 Unpaid/WhatsApp bookings in revenue/settlement | counted as revenue & collected | (a) exclude until paid, (b) keep as booked-revenue | DCE WHEN clause + reconciliation semantics | **OPEN** |
| Q5 Settlement on partial refund | whole DCE zeroed | (a) zero only refunded share, (b) keep full-zero | change mig 41 `confirm_refund_processed` settlement sync to prorate | **OPEN** |
| Q6 GST (NPD-01) | `gst_debit` at capture, config-driven | (a) SETURA is GST-liable on platform fee, (b) hospital liable | affects `gst_amount_inr` basis | **OPEN** |
| Q7 Gateway fee bearer | `gateway_fee_debit` at capture | (a) SETURA absorbs, (b) passed to hospital in settlement | settlement share math | **OPEN** |

**The final policy is NOT chosen in this document.**

### 3.8 Code/migration changes required *after* the owner decides (do not build yet)

All would be **new additive migrations** (never edits to applied 07/13/16/29/34/41/54):
- **If Q1=(a) platform-fee-only charge:** additive change so `create-payment-order`
  charges `booking_fee_inr`; reconcile `payment_orders.amount_inr` meaning.
- **Q2 unify refund basis:** one canonical `refund_basis_amount` source
  (RPC or column) consumed by all three paths + `initiate_refund`; parity tests
  for full, partial, duplicate, pre-payment cancel.
- **Q3/Q4 revenue point:** additive migration replacing the INSERT-time ledger
  writer + `trg_auto_create_collection` semantics with capture-conditioned
  writes (e.g. `WHEN (payment_completed)` or move into `capture_payment`), plus
  a backfill/correction for any rows already double-counted; reconciliation
  summary re-derived on the new basis.
- **Q5 settlement proration:** additive change to `confirm_refund_processed`
  settlement sync to subtract only the refunded portion, with partial-refund
  settlement tests (currently untested).
- Each new SECURITY DEFINER function must restate its own REVOKE/GRANT
  (F16-04) and add a `pg_proc.proacl` self-check (the mig 54 pattern).

---

## 4. P1-10 — Technical analysis

P1-10 is a **technical-correctness defect whose fix is blocked on the D16
policy ruling.** Verified concretely:
- Same patient action ("cancel a paid booking") yields different refund amounts
  depending on which UI/actor triggers it (§3.4) — an objective inconsistency.
- `initiate_refund` caps refund at `payment_orders.amount_inr` (=`total`), so a
  `booking_fee_inr`-based refund of a `total`-based payment is always ≤ paid —
  the patient is silently **under-refunded** on the receptionist/WhatsApp cancel
  paths relative to what they were charged.
- Partial refunds over-adjust settlement (whole DCE zeroed) — §3.3/§3.5, and the
  partial case is untested (`refund_sync.test.ts` covers full only).
- Migration 54 fixed the *zero* refund (P0-04) but its own header explicitly
  states it does **not** resolve the basis inconsistency (P1-10) and defers
  NPD-02 (mig 54:66-72). Status: **IMPLEMENTED** that `booking_fee_inr` is
  written; the basis unification is **NOT IMPLEMENTED** / **BLOCKED** on D16.

---

## 5. NPD-02 — Accounting-policy analysis

Revenue/settlement is recognized at booking **INSERT**, not capture:
- `trg_auto_create_collection` (mig 07:306) has **no `WHEN` clause** → every
  booking creates a `daily_collection_entries` row that feeds settlement.
- `write_booking_ledger_entries` (mig 13:410) fires `AFTER INSERT` when
  `total_amount_snapshot > 0` → credits platform + receptionist revenue before
  any money is collected; unpaid/WhatsApp bookings therefore inflate revenue and
  the settlement/outstanding base.
- Meanwhile gateway-fee and GST entries are written only at capture
  (`capture_payment`, mig 34) — so the ledger already mixes an INSERT-basis
  (revenue) with a capture-basis (fees/tax).

This is **not** an unambiguous engineering defect: some businesses legitimately
recognize "booked revenue" at booking. It is an **accounting policy** (the
revenue-recognition point + GST treatment) that must be ruled by the owner
(Q3/Q4/Q6 above). Once ruled, the technical change is well-defined (§3.8).
Status: mechanically **IMPLEMENTED**, policy **DEFERRED**.

---

## 6. D5 — Backup / disaster recovery decision analysis

Verified repository facts:
- No backup/PITR/restore/DR definition exists anywhere in the tree.
- Migration 23 retention/cleanup engine **prunes** data; migration 15/22
  partition automation. Neither has a counterpart backup obligation.
- `financial_ledger` is immutable by trigger (mig 13:378-404). Any restore must
  preserve or correctly re-derive this history; migration rollback is
  forward-fix only.

| Concern | Supabase platform can handle | SETURA must implement operationally | Needs paid/platform-tier decision |
| --- | --- | --- | --- |
| Automated DB backups | YES (tier-dependent) | verify/monitor | YES (tier) |
| PITR | YES (higher tiers only) | restore runbook + tests | YES |
| Retention vs backup conflict | no | reconcile mig 23 pruning with backup window | policy |
| Restore of pg_cron jobs | NO (a restore can silently drop `cron.job`) | re-register + verify after restore | — |
| Vault rows restore | NO guarantee | re-provision Vault + `scheduler_http_config` post-restore | — |
| Edge Function rollback | no | redeploy previous tag | — |
| Frontend rollback | Vercel immutable builds | re-point to prior build | — |
| Secret recovery/rotation | dashboard | rotation runbook | — |
| Webhook recovery | no | rely on existing idempotency + replay | — |
| Incident response | no | written runbook | — |

**RPO / RTO / retention options** (all tier-dependent; nothing purchased):
- RPO options: 24h (daily backup, lower tiers) vs minutes (PITR, higher tiers).
- RTO options: hours (restore-to-new-project + re-point) vs faster on
  enterprise read-replica options.
- Retention: PITR window (7–30 days tier-dependent) vs long-term archival dumps.
- Restore testing: mandatory periodic restore to a scratch project + verification
  battery (migrations apply count, RLS policy count, privilege census,
  scheduler/Vault re-provision).

Decision table (owner):

| Decision | Option A | Option B | Operational consequence | Owner decision |
| --- | --- | --- | --- | --- |
| Backup tier | daily physical backups (cheaper) | PITR enabled (higher tier) | A: larger data-loss window; B: minute-level RPO, higher cost | **OPEN** |
| RPO target | ≤24h | ≤15 min | drives tier selection | **OPEN** |
| RTO target | ≤4h manual restore | documented automated runbook | staffing + rehearsal cost | **OPEN** |
| Retention window | 7 days | 30+ days | storage cost + privacy exposure | **OPEN** |
| First restore test | before pilot (recommended) | after go-live | unpiloted recovery is unproven | **OPEN** |

Status: **NOT IMPLEMENTED**; policy **DEFERRED**. This becomes **BLOCKING before
real patient data** (P0, not P2, at go-live).

---

## 7. D6 — Worker trigger decision analysis

Confirmed mechanism: `run-cron-minute/index.ts:386` wakes `run-background-worker`
only when `Env.ENABLE_WORKER_TRIGGER === true`; reminders always run.
`.env.example:16` ships `false`.

| Dimension | **A: `ENABLE_WORKER_TRIGGER=true`** (scheduler wakes worker) | **B: `false` + external trigger** |
| --- | --- | --- |
| Reliability | self-contained once pg_cron fires; proven on staging | depends on external caller staying alive |
| Failure recovery | crash reclaim local-PROVEN (W1 4/4/7/7) + lease fix (mig 51/52) | external system must retry the wake |
| Operational complexity | one less moving part (no external cron) | must operate + monitor an external scheduler |
| Security | needs `WORKER_SECRET`; worker endpoint `--no-verify-jwt` | same secret boundary; extra external trust surface |
| Observability | firing visible in `cron.job_run_details` | visibility moves to the external system |
| Deployment complexity | just set secret + flag true | provision external trigger + networking |
| Cost | none beyond existing pg_cron | external service / egress |
| Dependency count | fewer (in-DB scheduler) | more (external scheduler + reachability) |
| Hospital workload behavior | worker runs every minute under load | tunable cadence externally |
| Retry behavior | worker's own retry→DLQ (mig 50) preserved | unchanged, but wake itself must be retried externally |
| Dead-letter behavior | `dead_letter_jobs` visible in DB | same DB DLQ |

Neither is declared a winner. **A** matches what is already PROVEN on staging
and minimizes dependencies; **B** gives an operator-controlled cadence but adds
a monitored external component that can itself fail silently. The choice is the
owner's (production correctness, not a cosmetic default). Status: **DEFERRED**.

---

## 8. D13 — Production domain dependency analysis

The final domain is a single owner input that fans out to every row below.
`setura.in` / `app.setura.in` are only the **example defaults** in
`env.ts:214` (`ALLOWED_ORIGINS` production default) — not a committed choice.

| Surface | How the domain is used | Where |
| --- | --- | --- |
| Vercel | custom domain + HTTPS cert | Vercel project (external) |
| Supabase Auth `site_url` | email links / OAuth redirect base | `config.toml:154` (localhost today) |
| Auth redirect URLs | `additional_redirect_urls` post-login return | `config.toml:158` |
| `ALLOWED_ORIGINS` | Edge Function CORS allow-list | `env.ts:211-215` / platform secret |
| CORS behavior | non-matching origin falls back to `ALLOWED_ORIGINS[0]` → browser blocks | `cors.ts:8-10` |
| Cookies/session | same-site/secure scope tied to origin | GoTrue config |
| Meta webhook URL | callback registered to `…/process-whatsapp-webhook` | Meta dashboard (external) |
| Razorpay webhook URL | callback to `…/verify-payment` | Razorpay dashboard (external) |
| SMTP SPF/DKIM/DMARC | must authenticate the sending domain | provider (external) |
| Frontend env vars | `VITE_SUPABASE_URL` (Supabase host) + anon key | Vercel env (browser-safe only) |

Because domain choice touches DNS (authorization), Auth config, CORS, provider
webhooks and email deliverability simultaneously, it must be **fixed once,
deliberately** before provisioning. Status: **DEFERRED (owner).**

---

## 9. Staging CORS blocker (verify → show change → STOP)

**Verified current state (source + Part 2 evidence):**
- Code path: a request from an origin not in `Env.ALLOWED_ORIGINS` gets
  `Access-Control-Allow-Origin` = `ALLOWED_ORIGINS[0]` (the fallback), which does
  not match the requester → the browser blocks it (`cors.ts:8-10`).
- `env.ts:211-215`: default allow-list is `https://setura.in,https://app.setura.in`
  (production) or localhost (dev).
- Part 2 §6/§12 set the **staging** `ALLOWED_ORIGINS` secret to the two
  `*.vercel.app` preview origins + local dev origins — it does **not** include
  `https://setura-delta.vercel.app`. So `queue-control` (and other functions)
  called from that origin are CORS-blocked. This is **NOT** the (already-fixed)
  Vercel 404.

**This is a hosted staging secret. It is NOT in the repository and its exact
live value cannot be printed from here. This package does NOT apply the change.**

Exact intended change (owner-approved, staging only, shown for authorization —
not executed):

```text
supabase secrets set \
  ALLOWED_ORIGINS="https://setura-delta.vercel.app,<existing preview origins>,<existing local dev origins>"
```
(add the production alias; retain existing entries; no wildcard unless owner
explicitly opts in)

Rollback: re-set `ALLOWED_ORIGINS` to its previous exact value (staging secret
history / recorded prior value) — instantly reversible, no data impact.

**STOP. Awaiting explicit authorization to modify the staging secret.** Status:
**BLOCKED / OWNER DECISION REQUIRED.**

---

## 10. Other open items — classification (not re-chased)

| Item | Classification | Why |
| --- | --- | --- |
| D1 doctor assignment mandatory | IMPORTANT BEFORE PILOT | product behavior; does not block provisioning |
| D2 receptionist doctor-name visibility | IMPORTANT BEFORE PILOT | privacy/RLS product ruling |
| D4 notification staff UI | CAN BE DEFERRED | UX/ops only (G7-15) |
| D8 track `graphify-out/` | CAN BE DEFERRED | hygiene preference; already tracked |
| D9 deployment architecture / CI deploy stage | BLOCKING BEFORE PRODUCTION | no deploy pipeline; GitHub env/approval config needed |
| D12 SMTP provider + session policy | BLOCKING BEFORE PRODUCTION | password reset/invite dead without it; `jwt_expiry` policy |
| D15 data retention / offboarding | BLOCKING BEFORE REAL PATIENT DATA | privacy + immutable-ledger reconciliation |
| D17 observability provider | IMPORTANT BEFORE PILOT (BLOCKING before real ops) | failures invisible outside DB (G7-10) |
| F16-04 privilege hygiene | CAN BE DEFERRED (honor per-change) | honored in mig 50-58; full CI lint is hardening |
| F16-05 JWT-401-as-denial test debt | IMPORTANT BEFORE PILOT | weakens privilege-denial *proof* quality (G7-13) |
| F16-06 locked-routine coverage ~22% | IMPORTANT BEFORE PILOT | coverage uplift (G7-13) |
| F16-07 stray "193 policies" comment | COSMETIC / NON-BLOCKING | correct count is 139; comment fix only |
| G7-08 tenant/staff provisioning path | BLOCKING BEFORE PILOT | only `seed.sql` exists (local-demo); no real onboarding |
| G7-10 external error tracking | IMPORTANT BEFORE PILOT | see D17 |
| G7-11 backup/DR | BLOCKING BEFORE REAL PATIENT DATA | see D5 |
| G7-14 load headroom (queue+worker) | IMPORTANT BEFORE PILOT | unknown at pilot volume |
| G7-15 notifications staff UI | CAN BE DEFERRED | see D4 |

Completed Part 2/hosted work was NOT reopened (no regression evidence).

---

## 11. Technical remediation dependency graph

```
D16 revenue/refund policy (Q1-Q7)
   → REQUIREMENT: single canonical "what patient paid / refundable / revenue point"
   → ADDITIVE MIGRATION(S): unify refund basis + capture-conditioned revenue
     writer + prorated settlement sync (each with F16-04 REVOKE/GRANT + self-check)
   → RPC/EDGE: initiate_refund basis; cancel-booking/whatsapp/process-refund;
     write_booking_ledger_entries; auto_create_collection; confirm_refund_processed
   → TESTS: full/partial/duplicate/pre-pay cancel refunds; unpaid-booking revenue;
     settlement reconciliation; tenant + idempotency
   → STAGING VERIFICATION: financial ledger == captured cash == settlement base
   → PRODUCTION GATE P6 (financial path proven)

D5 backup/DR  → REQUIREMENT: tier+RPO+RTO decided → PITR/backup config →
   restore runbook + migration/cron/Vault re-provision steps →
   restore TEST on scratch project → GATE P10

D6 worker trigger → REQUIREMENT: A or B → secret/flag config (no code change) →
   staging 2-tick autonomy re-verify → GATE P4/P5

D13 domain → REQUIREMENT: fixed domain → Vercel+Auth site_url+redirects+
   ALLOWED_ORIGINS+Meta/Razorpay webhooks+SMTP DNS → smoke S1/S2 → GATE P3/P8

§9 CORS staging → owner auth → staging secret update → verify preflight echo →
   unblock queue-control from prod alias (staging only)
```

No production work. No applied-migration edits. All DB changes are new additive
migrations appended after 58 and reflected in `MANIFEST.sha256`.

---

## 12. Pre-production implementation sequence

1. Obtain owner rulings: **D16 (Q1–Q7), D5, D6, D13** (+ D12/D15/D17 policy).
2. Authorize the staging CORS secret change (§9) to unblock live testing.
3. Implement D16 remediation as additive migrations + unified refund basis;
   write the missing partial-refund / unpaid-revenue tests; run on the local
   stack, then redeploy to staging and re-verify the financial reconciliation
   invariant.
4. Provision backup/DR per D5; execute a first restore test to a scratch project.
5. Implement/enable D6 choice; prove 2-tick autonomy again.
6. Build the CI/CD deploy stage + GitHub environments/approvals (D9) so later
   steps are gated, not manual.
7. Fix tenant/staff provisioning runbook (G7-08) and auth config (D12/SMTP).
8. Only after all above: production provisioning per
   `PHASE_7_PART_3_..._PLAN.md` §18 — each step authorization-gated.

---

## 13. Owner decision register (this package's focus)

| ID | Decision | Determined vs needed | Classification |
| --- | --- | --- | --- |
| D16 / Q1–Q7 | money model, refund basis, revenue point, settlement proration, GST, gateway fee | business ruling | **DEFERRED — owner** |
| D5 | backup tier / RPO / RTO / retention / first-restore timing | platform+product | **DEFERRED — owner** |
| D6 | worker trigger architecture A vs B | product/ops ruling | **DEFERRED — owner** |
| D13 | production domain | owner | **DEFERRED — owner** |
| §9 | authorize staging `ALLOWED_ORIGINS` change | owner | **BLOCKED — needs auth** |
| D3 (GoTrue seed) | seed-shape defect classification | **determined** (fixed in source) | RESOLVED (recorded) |
| D7 (hosted pg_cron/Vault) | production behavior | provisioning probe | **UNPROVEN** |

---

## 14. Blocking conditions

- **B1 D16 policy undecided** → refunds/revenue/settlement cannot be made
  consistent; financial production gate cannot be certified.
- **B2 D5 undecided** → no safe path to real patient data.
- **B3 D6 undecided** → a default production deploy would not process jobs.
- **B4 D13 undecided** → domain-coupled config (auth/CORS/webhooks/SMTP) cannot
  be finalized.
- **B5 staging CORS secret change unauthorized** → `queue-control` blocked on
  the production-alias frontend (staging only).
- **B6 no production environment / no credentials** → all production verification
  remains BLOCKED/UNPROVEN (unchanged from Part 3).

---

## 15. Exact next actions

1. Owner answers **D16 Q1–Q7** (§3.7), **D5** (§6), **D6** (§7), **D13** (§8).
2. Owner authorizes the staging `ALLOWED_ORIGINS` update (§9) — or explicitly
   accepts the blocker.
3. On D16 answers only: authorize a follow-up implementation package to write
   the additive migrations + tests (§3.8, §11).
4. Nothing else can advance to production until §14 B1–B4 are resolved and the
   Part 3 §25 authorization points are individually granted.

---

## 16. Explicit hard stop

No production deployment, no production/`supabase link`ed project, no
production migration push, no Edge Function deploy, no secret creation, no
staging secret change applied, no Razorpay/Meta/SMTP activation, no DNS change,
no staff/tenant provisioning, no real patient or pilot data, no real payment or
WhatsApp message, and **no financial behavior modified.** This document is
decision-analysis + a remediation plan only.

```text
PART 3A (PRE-PRODUCTION)
Decisions analyzed : D16 · D5 · D6 · D13 · §9 CORS
Financial behavior : UNCHANGED (mapped only)
Applied migrations : UNTOUCHED
Staging secret     : NOT modified (change proposed, awaiting auth)
Production         : NOT STARTED
Authorization      : REQUIRED before any execution
```

---

## 17. Final status (per §13 required output)

| Area | Status | Why | Required Decision/Action |
| --- | --- | --- | --- |
| D16 refund basis (P1-10) | BLOCKED | basis unification depends on the money-model ruling | owner D16 Q1–Q2, then additive migration |
| D16 revenue recognition (NPD-02) | DEFERRED | accounting policy, mechanically IMPLEMENTED at INSERT | owner D16 Q3–Q4 |
| D16 settlement proration (partial) | NOT IMPLEMENTED | whole DCE zeroed on any refund; untested | owner D16 Q5, then fix + tests |
| booking_fee_inr writer (P0-04) | IMPLEMENTED | mig 54 persists + backfills the column | none |
| RLS / tenant isolation | PROVEN (staging) | A↔B zero leakage; 94/94, 139 policies | prod catalog census (Gate G) |
| Migration chain (58) | IMPLEMENTED | files + manifest, staging-applied | prod apply |
| Scheduler + worker (code) | IMPLEMENTED + PROVEN (staging) | live firing + claim/retry/DLQ | prod provisioning + D6 |
| D6 worker trigger | DEFERRED | `run-cron-minute:386` gated; default false | owner D6 (A vs B) |
| Backup / PITR / DR | NOT IMPLEMENTED | nothing in tree; mig 23 prunes only | owner D5 tier + restore test |
| Production domain config | DEFERRED | fans out to 6 coupled surfaces | owner D13 |
| Staging CORS (`ALLOWED_ORIGINS`) | BLOCKED | prod alias not in staging list | owner auth (one secret update) |
| Frontend / Vercel | PROVEN (staging) | 404 fixed; E1 6/6 | prod domain/sourcemap config |
| External integrations | BLOCKED | no credentials (by design) | owner authorization |
| GoTrue seed defect (D3) | IMPLEMENTED (source fix) | seed.sql identity + email_change fix | none (provisioning avoids seed anyway) |
| CI/CD deploy stage + approvals | NOT IMPLEMENTED | 4 test jobs, no deploy/CODEOWNERS | build + GitHub config (D9) |
| Observability (external) | NOT IMPLEMENTED | `SENTRY_DSN` declared, unused | owner D17 |
| Tenant/staff provisioning path | NOT IMPLEMENTED | only `seed.sql` (local-demo) | runbook (G7-08) |
| Production readiness overall | BLOCKED | decisions + credentials + env absent | resolve §14, then authorize |
