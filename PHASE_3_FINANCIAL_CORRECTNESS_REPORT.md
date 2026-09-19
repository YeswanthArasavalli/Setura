# SETURA — PHASE 3: FINANCIAL CORRECTNESS — EXECUTION REPORT

Execution model: BUILD → TARGETED TEST → FIX → INTEGRATE → PROVE → NEXT.

Scope executed: the authoritative Phase 3 critical blockers B2 (P0-04
refund basis) and the `record_payment` 500 (P1-04). Money-source
analysis, refund state machine, settlement, ledger, idempotency,
concurrency and tenant isolation were traced to source; where a fix
required an undecided product ruling (NPD-01/02/03) it was recorded,
not guessed, per CLAUDE.md §15.

Status vocabulary is per CLAUDE.md §5. Local results are NOT production
verification.

---

## A. Defects found

### A1 — P0-04 / B2 — Refunds compute ₹0 for every booking created after migration 28 — FIXED

- **Defect.** Two of the three refund paths returned ₹0 regardless of
  what the patient paid.
- **Root cause (proven from source, not assumed).**
  `bookings.booking_fee_inr` is `NUMERIC(10,2) NOT NULL DEFAULT 0`
  (added by `28_booking_enhancements.sql:24-26`) and is the refund
  basis read by:
  - `calculate_refund_amount` — `29_cancellation_policy.sql:201`
    `v_paid := COALESCE(v_booking.booking_fee_inr, 0)`;
  - `cancel-booking/index.ts:271` `Number(b.booking_fee_inr ?? 0)`;
  - `_shared/whatsapp/whatsapp_cancel_flow.ts:158,237`.
  The ONLY writer of the column across migrations 01–53 was migration
  28's one-time `UPDATE` backfill (`28:78-85`). The runtime writer
  `create_booking` (`39_schema_alignment.sql:196-241`, the current
  definition) persists `platform_fee_snapshot`,
  `receptionist_fee_snapshot`, `hospital_fee_snapshot`,
  `total_amount_snapshot` — but never `booking_fee_inr`. Because the
  column is NOT NULL DEFAULT 0, every booking created at runtime after
  migration 28 stored ₹0, so the fee-based refund paths always refunded
  ₹0.
- **Affected path.** BOOKING → (fee) → refund derivation, at the
  `create_booking` write boundary.
- **Severity.** P0 (money refunded wrong for 100% of new bookings).
- **Fix.** `54_booking_fee_writer.sql` §1: `create_booking` now writes
  `booking_fee_inr := COALESCE(p_platform_fee, 0)` — the same value it
  already stores in `platform_fee_snapshot`, matching migration 28's
  backfill formula and the column's declared meaning ("the ONLY money
  SETURA receives for this booking"). Body is otherwise byte-identical
  to migration 39; signature/parameter order unchanged, so all
  positional callers (`idempotent_create_booking`, `create-booking`,
  `reschedule-booking`, WhatsApp engine) inherit the fix. Emergency
  walk-in inserts (`insert_emergency_patient`, migration 46) collect no
  fee and correctly remain ₹0.
- **Data repair.** §3 idempotent `UPDATE` restores `booking_fee_inr`
  from `platform_fee_snapshot` for existing rows still at the DEFAULT 0
  (never overwrites a non-zero value).
- **Migration.** `supabase/migrations/54_booking_fee_writer.sql`.
- **Regression test.**
  `tests/integration/booking_fee_refund.test.ts` — INTEGRATION + RUNTIME
  VERIFIED locally (see §E).

### A2 — P1-04 — `settlement-engine` `record_payment` always HTTP 500 — ALREADY FIXED (verified, not re-reported as new)

- Source `settlement-engine/index.ts:95-114` short-circuits
  `action === "record_payment"` to `NotImplementedError` (contract 501,
  `docs/ERROR_CONTRACT.md`) BEFORE any DB access, replacing the old
  "read the migration-33 SQL no-op FALSE as a server fault" behaviour.
- Proven by `tests/unit/settlement_record_payment.test.ts` (3 tests
  pass): asserts the always-500 message is gone and that the no-op
  `record_settlement_payment` RPC is no longer called. No change made.

### A3 — P1-10 / NPD-02 — refund/collection basis inconsistency — FOUND, DEFERRED (product decision)

- `create-payment-order/index.ts:191-211` charges Razorpay the
  **`total_amount_snapshot`** (platform + receptionist + hospital fee),
  while the refund basis `booking_fee_inr` holds the **platform fee
  only**, and `process-refund/index.ts:208-211` refunds against
  `total_amount_snapshot`. These are three different monetary bases for
  one booking.
- Resolving which amount SETURA actually collects/refunds is the
  **NPD-02 revenue-recognition ruling** ("SETURA collects only the
  booking/platform fee; the hospital collects the consultation fee
  directly" — if enforced literally, charging `total_amount_snapshot`
  via Razorpay is itself the violation). Phase 3 §2 and CLAUDE.md §15
  forbid redesigning the money model or guessing an architecture-critical
  decision, so this is **recorded, not silently rewritten**. Migration 54
  deliberately does NOT touch the collection amount.

---

## B. Financial architecture — authoritative sources (as found)

| Concept | Authoritative source | Notes |
| --- | --- | --- |
| booking total | `bookings.total_amount_snapshot` | = platform + receptionist + hospital fee, computed in `create_booking` |
| platform/booking fee (SETURA's money) | `bookings.platform_fee_snapshot` | fee SETURA collects |
| refund basis | `bookings.booking_fee_inr` | **NOW written at creation** by `create_booking` (= platform fee); read by `calculate_refund_amount`, `cancel-booking`, `whatsapp_cancel_flow` |
| consultation fee | `bookings.consultation_fee_inr` / `hospital_fee_snapshot` | informational; collected by the hospital, never refunded by SETURA |
| Razorpay order amount | `create-payment-order` from `total_amount_snapshot` | see A3 divergence |
| captured payment | `payment_orders.amount_inr`, `payment_status='captured'` | source read by `process-refund` |
| refund record | `payment_refunds` via `initiate_refund` / `confirm_refund_processed` | dedup/idempotency proven in `refund_sync` |
| ledger | `financial_ledger` | immutable by trigger + RLS `WITH CHECK(false)`; `refund_debit` written on confirm |
| settlement | `create_platform_revenue_summary` (`action=create`) | `record_payment` retired (A2) |

**Money representation (Phase 3 §5):** NUMERIC/DECIMAL end to end
(`NUMERIC(10,2)` columns, NUMERIC RPC args). No float/double money in
the traced path. Edge Functions convert to JS `number` only at the
boundary and re-multiply to paise with `Math.round(x*100)` for the
gateway; that is the established representation and was NOT rewritten.

---

## C. Files changed

- `supabase/migrations/54_booking_fee_writer.sql` (new)
- `tests/integration/booking_fee_refund.test.ts` (new)
- `PHASE_3_FINANCIAL_CORRECTNESS_REPORT.md` (this file, new)

No applied migration was edited. No Edge Function or source file was
modified (A2 was already fixed; A3 was deliberately left for a ruling).

---

## D. Database changes

- **Function redefined:** `public.create_booking(…19 args…)` —
  SECURITY DEFINER, `SET search_path = public`, `OWNER TO postgres`.
  Adds `booking_fee_inr` to the INSERT (value `COALESCE(p_platform_fee,
  0)`). Signature unchanged.
- **Privileges (F16-04):** explicit
  `REVOKE ALL … FROM PUBLIC, anon, authenticated;` and
  `GRANT EXECUTE … TO service_role;` restated on the redefined function
  (Category B). Verified against `pg_proc` + `has_function_privilege()`
  in the migration's self-check DO block.
- **Data:** idempotent `UPDATE bookings SET booking_fee_inr =
  platform_fee_snapshot WHERE booking_fee_inr = 0 AND
  platform_fee_snapshot > 0`.
- **No new tables, columns, constraints, triggers, or RLS policies.**
- Registry row `54_booking_fee_writer` recorded with category
  `function` (matching siblings 50/51/52).

---

## E. Tests — exact commands and results

All run against the local Supabase stack (DB 54322 / API 54321 up;
imgproxy/pooler stopped, not required for RPC tests).

| Command | Result | Passed | Failed | Blocked |
| --- | --- | --- | --- | --- |
| `deno task validate:migrations` | 0 errors, 4 pre-existing `[duplicate-objects]` warnings (baseline) | — | 0 | 0 |
| `supabase migration up` | `migration 54 verification passed`, exit 0 | 1 apply | 0 | 0 |
| `deno check tests/integration/booking_fee_refund.test.ts` | exit 0 | — | 0 | 0 |
| `deno lint tests/integration/booking_fee_refund.test.ts` | exit 0 | — | 0 | 0 |
| `deno fmt --check tests/integration/booking_fee_refund.test.ts` | exit 0 (after LF normalization of the new file only) | — | 0 | 0 |
| `deno test -A tests/integration/booking_fee_refund.test.ts` | `3 passed / 0 failed` | 3 | 0 | 0 |
| `deno test -A tests/integration/refund_sync.test.ts` | `5 passed / 0 failed` (regression) | 5 | 0 | 0 |
| `deno test -A tests/unit/settlement_record_payment.test.ts` | `3 passed / 0 failed` (P1-04 already fixed) | 3 | 0 | 0 |

Migration self-check DO block asserts at apply time: function present,
still SECURITY DEFINER, `OWNER postgres`, prosrc references
`booking_fee_inr`, `service_role` has EXECUTE, `anon`/`authenticated`
do NOT.

No claim of "all tests passed" — only the specific commands above were
run. The full integration suite and the Edge-Function-over-HTTP tests
were not run (not required for this defect; see §G).

---

## F. Financial invariant evidence (Phase 3 §24)

- **Invariant 1 — no over-refund.** `process-refund` enforces
  `refundInr > totalInr → ValidationError` (`:227-231`) and
  `>= ₹1` minimum (`:213-225`). Not modified; unchanged behavior.
- **Invariant 3 — tenant isolation.** `create_booking` is called with a
  server-resolved `p_hospital_id`; Edge Functions still check
  `booking.hospital_id !== hospitalId → ForbiddenError`. Migration 54
  adds no cross-tenant path; RLS untouched; function stays
  service_role-only. `refund_sync` cross-scope test still passes.
- **Invariant 4 — idempotency.** `create_booking` still early-returns on
  a matching `idempotency_key`; backfill is idempotent (only touches
  zero rows); `confirm_refund_processed` replay guard proven by
  `refund_sync` (no duplicate ledger row).
- **Invariant 6 — ledger consistency.** Unchanged; `refund_sync` proves
  exactly one `refund_debit` per confirmed refund.
- **Invariant 2 (revenue boundary) & 5 (settlement).** Correct at the
  `booking_fee_inr` layer now (refund basis = platform fee only). The
  `total_amount_snapshot` collection divergence (A3) is the open item
  gated behind NPD-02.
- **P0-04 proof (RUNTIME).** `create_booking` RPC persisted
  `booking_fee_inr = 25` = platform fee (test 1), and
  `calculate_refund_amount` returned `refund_amount = 25`, `is_eligible
  = true` (test 2) — previously structurally ₹0.

---

## G. Remaining blockers

**PRODUCT (need recorded rulings before implementation):**
- NPD-02 — monetary basis for collection vs refund (A3 / P1-10). Not
  decided in this session.
- NPD-01 — GST-aware `get_booking_fee` vs `get_effective_fees` as the
  fee resolver (P2-11 caller-less resolver). Migration 54 uses the
  platform fee already resolved by `get_effective_fees`; a GST-inclusive
  booking fee would require the NPD-01 ruling and is out of the smallest
  correct change.
- P1-02 partial-refund DCE over-zeroing; P1-08 refund-status writers;
  P1-03 capture boolean; P1-06 reconciliation KPIs; P1-01 webhook secret
  naming — adjacent Phase 3 roadmap items, NOT started here; P0-04 was
  the designated first investigation and is closed.

**ENVIRONMENT:**
- Full `deno task test:integration` and the Edge-Function-over-HTTP
  suites were not run this session; Edge Runtime container has
  `RestartPolicy=no` (F16-01). Not required to prove P0-04 (RPC-level).

**EXTERNAL RAZORPAY:**
- `REAL RAZORPAY = BLOCKED`. No credentials locally (correctly not
  fabricated). Live order/refund HTTP paths UNPROVEN by design.

**PRODUCTION:**
- Everything above is LOCAL. Production financial state = UNPROVEN
  (no deployment).

---

## H. Final status

```text
PHASE 3 COMPLETE — WITH BLOCKED EXTERNAL/ENVIRONMENT EVIDENCE
```

Qualified: this covers the P0-04/B2 refund-basis blocker and confirms
P1-04. It is NOT the whole financial wave — the NPD-gated items in §G
(above all NPD-02 / P1-10 basis unification, P1-02, P1-08) remain open
product decisions. INTERNAL FINANCIAL CORRECTNESS for the refund basis =
PROVEN (local integration + runtime); REAL RAZORPAY = BLOCKED;
PRODUCTION = UNPROVEN. Production readiness is NOT claimed. Phase 4 is
NOT started.
