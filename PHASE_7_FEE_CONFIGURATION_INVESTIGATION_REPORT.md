# PHASE 7 — FEE CONFIGURATION INVESTIGATION REPORT

**Type:** INVESTIGATION ONLY (read-only). No source, SQL, database, deployment
or Git mutation was performed.
**Date:** 2026-09-23
**Staging project:** `setura-staging` / `gzcqasntcbqqmgsoikms`
**Git at investigation:** `HEAD == origin/main == 449ba11`, working tree clean.

---

## 1. Objective

During the Booking Confirmation staging walkthrough the confirmation showed
correct operational data, the backend returned fee snapshots, fees were
intentionally not displayed, the canonical `BookingDetail` payment card showed
**Payment Pending**, and the SETURA-side fee snapshots were observed as **₹0**.

This investigation determines the exact source of the ₹0 SETURA booking/platform
fee in staging and classifies it as either **expected configuration** or a
**real product/runtime defect**. It answers:

> Why is the current staging booking fee ₹0, and is that behavior intentional or
> a defect?

## 2. D16 business model (restated, authoritative — not reopened)

1. SETURA collects ONLY the booking/platform fee through Razorpay.
2. Hospital consultation fee is collected directly by the hospital.
3. A SETURA refund cannot exceed what SETURA actually charged/collected.
4. Revenue is recognized only after successful payment capture.
5. Unpaid / WhatsApp / walk-in bookings do not create collected SETURA revenue
   or settlement.
6. Partial refunds reduce only the refunded amount and are idempotent.
7. GST applies to SETURA's platform/service fee (pending CA/tax confirmation).
8. Razorpay gateway fee is absorbed separately by SETURA.

No decision in this report changes D16, D5 or D13.

## 3. Source trace

```text
booking_fee_policies / hospital_settings   (fee configuration)
        ↓  get_effective_fees(hospital_id, booking_source)   [migration 35 body]
   platform_fee (pf)
        ↓  create-booking Edge Function  → p_platform_fee        [index.ts L455]
   create_booking(...) SECURITY DEFINER                           [migration 54]
        ↓  booking_fee_inr        := COALESCE(p_platform_fee, 0)  [migration 54 L184]
        ↓  platform_fee_snapshot  := COALESCE(p_platform_fee, 0) [migration 54 L183]
        ↓  total_amount_snapshot  := pf + rf + hf
        ↓  create-payment-order:  amountInr = booking_fee_inr     [index.ts L195]
             if amountInr <= 0  → REJECT ("No payment required")  [index.ts L207-214]
        ↓  payment capture → financial_ledger / revenue           (only on capture)
        ↓  refund basis = booking_fee_inr                          [migration 29/60]
```

Key source facts:

- **Fee resolver** `get_effective_fees` (current body = migration 35). Prefers a
  `booking_fee_policies` row when one exists, else falls back to
  `hospital_settings`:
  - policy path: `booking_fee_enabled=false → 0`; otherwise per-source
    (`online → booking_fee_online`, `manual_whatsapp → booking_fee_whatsapp`,
    `walkin → booking_fee_walkin`, else `0`).
  - fallback path: `online → COALESCE(platform_fee_online,20)`,
    `manual_whatsapp → COALESCE(platform_fee_whatsapp,10)`, **else (walkin) → 0**.
  - `hospital_fee` is hard-coded `0` by design (SETURA model).
- **Writer** `create_booking` (migration 54) sets
  `booking_fee_inr := COALESCE(p_platform_fee, 0)` — this closed the historical
  P0-04 "no runtime writer" gap. It faithfully persists whatever the resolver
  returned; it does not itself zero the fee.
- **Payment** `create-payment-order` (D16 Q1) charges `booking_fee_inr` (never
  `total_amount_snapshot`) and **rejects** a zero/negative amount with a
  `ValidationError` "No payment required for this booking (zero platform fee)".
  It therefore never creates a ₹0 gateway order and never writes a ledger/revenue
  row for a zero-fee booking.
- **Refund** basis is `booking_fee_inr` (migrations 29/54/60); a ₹0 basis yields
  a ₹0 refund — correct, since nothing was collected.

### Configuration inventory (Phase A)

| Source | Kind | Value relevant to ₹0 |
| --- | --- | --- |
| `booking_fee_policies.booking_fee_online` | column, DEFAULT 20 | 20.00 in staging |
| `booking_fee_policies.booking_fee_whatsapp` | column, DEFAULT 10 | 10.00 in staging |
| `booking_fee_policies.booking_fee_walkin` | **column, DEFAULT 0** | 0.00 in staging |
| `booking_fee_policies.booking_fee_enabled` | column, DEFAULT true | true in staging |
| `hospital_settings.platform_fee_online/whatsapp/receptionist_fee` | fallback columns | used only if no policy row |
| `get_effective_fees()` | SQL resolver (migration 12 → 35) | live resolver |
| `create_booking(p_platform_fee, …)` | SQL writer (migration 54) | persists the resolved value |
| `create-booking` Edge Function | supplies `p_platform_fee` from resolver | no client-supplied fee |
| Frontend | does not send/override fee | fee is server-resolved |

A per-hospital `booking_fee_policies` row is auto-created on hospital insert by
the `auto_create_booking_fee_policy` trigger (migration 28), which inserts
**only** `hospital_id` and relies on the column DEFAULTs — so a newly
provisioned hospital starts with `booking_fee_walkin = 0` by schema design.

## 4. Staging evidence (Phase D — read-only)

Observed hospital: `00000000-0000-4000-8000-000000000001`.

`booking_fee_policies` row:

| booking_fee_enabled | online | walkin | whatsapp |
| --- | --- | --- | --- |
| true | 20.00 | **0.00** | 10.00 |

Booking fee distribution for the hospital:

| booking_source | count | min booking_fee_inr | max booking_fee_inr |
| --- | --- | --- | --- |
| walkin | 12 | 0.00 | 0.00 |
| manual_free | 2 | 0.00 | 0.00 |

Validation booking (Token 9, `7b9f1970-e80f-4186-8981-adfdf5b5a85f`):
`booking_source = walkin`, `status = completed`, `booking_fee_inr = 0.00`,
`platform_fee_snapshot = 0.00`, `receptionist_fee_snapshot = 0.00`,
`hospital_fee_snapshot = 0.00`, `total_amount_snapshot = 0.00`,
`payment_completed = false`.

Financial rows for that booking: `payment_orders = 0`,
`financial_ledger = 0`, `daily_collection_entries = 1` with
`platform_fee = 0.00, receptionist_fee = 0.00, hospital_fee = 0.00,
total_amount = 0.00` (no spurious revenue).

Discrepancy note: the phase brief referenced validation bookings "Token 9 and
Token 10". **No `token_number = 10` row exists in staging.** Only Token 9 (and
the manual_free Tokens 6/7) were found. Nothing was modified.

## 5. Source vs staging comparison (Phase E)

| Question | Source expectation | Staging observation | Classification |
| --- | --- | --- | --- |
| Platform fee config | walkin DEFAULT 0; online 20; whatsapp 10 | walkin=0, online=20, whatsapp=10, enabled=true | PROVEN |
| booking_fee_inr (walkin) | = COALESCE(p_platform_fee,0) | 0.00 for every walkin booking | PROVEN (expected) |
| platform_fee_snapshot | = p_platform_fee | 0.00 | PROVEN (expected) |
| hospital fee | hard-coded 0 | 0.00 | EXPECTED CONFIGURATION |
| receptionist fee | 0 unless manual_whatsapp | 0.00 (walkin) | EXPECTED CONFIGURATION |
| total amount | pf+rf+hf | 0.00 (walkin) | PROVEN (expected) |
| payment order (₹0) | rejected, none created | 0 payment_orders for Token 9 | PROVEN |
| payment status | payment_completed=false | false → UI badge "Pending" | IMPLEMENTED (see §8) |
| ledger / revenue | none until capture | 0 financial_ledger rows | PROVEN |
| settlement/DCE | DCE mirrors snapshot (0) | 1 DCE row, all amounts 0.00 | PROVEN (no phantom revenue) |
| online non-zero path | online → 20 via resolver | config present; no online booking exercised in staging | IMPLEMENTED (config PROVEN, runtime path UNPROVEN in staging) |

## 6. Root cause (Phase F)

**Exactly one classification: CASE A — EXPECTED STAGING CONFIGURATION.**

The ₹0 SETURA fee is the deliberate schema default for the **walk-in** booking
source (`booking_fee_policies.booking_fee_walkin NUMERIC(10,2) NOT NULL DEFAULT
0`), auto-applied per hospital by the `auto_create_booking_fee_policy` trigger.
Every booking observed in staging is `walkin` or `manual_free` — both legitimately
carry a ₹0 SETURA platform fee. The financial chain is behaving correctly:

- The resolver returned platform_fee = 0 for walk-in (matches config).
- `create_booking` faithfully persisted booking_fee_inr = 0 (matches the fee).
- `create-payment-order` correctly declined to open a ₹0 order (0 payment_orders).
- No ledger/revenue row was created (0 financial_ledger).
- The DCE mirrors ₹0 (no phantom collection).

This is **NOT a product defect** and **NOT a code/SQL bug**. It is also **not
merely an unprovisioned gap**: the presence of non-zero online (₹20) and whatsapp
(₹10) values on the same policy row proves the fee configuration path is live and
populated; walk-in is simply configured (defaulted) to ₹0.

**NO PRODUCT DEFECT — do not change code.**

## 7. Zero-fee payment behavior (Phase G)

When `booking_fee_inr = 0`, current source + staging behavior:

- **Rejects** payment-order creation (`ValidationError` "No payment required for
  this booking (zero platform fee)"); it does **not** create a ₹0 Razorpay order.
- **No** payment order, **no** payment attempt, **no** `financial_ledger` row.
- Booking remains `payment_completed = false`.
- A `daily_collection_entries` row is written mirroring the ₹0 snapshots.

No real payment and no zero-value payment was manufactured during this
investigation.

## 8. Financial safety assessment

Current behavior does **not violate D16**:

- Rule 1/2: SETURA never charges the hospital consultation fee (hospital_fee=0).
- Rule 4/5: no revenue recognized and no collected revenue recorded for the
  unpaid/₹0 walk-in booking (financial_ledger = 0; DCE = ₹0).
- Rule 3: refund basis = booking_fee_inr = ₹0 → refund cannot exceed collection.

**One non-financial display nuance (observation, not a defect, not implemented):**
`BookingDetail.tsx` renders the payment badge purely as
`row.payment_completed ? "Paid" : "Pending"`. For a booking that legitimately
requires no payment (₹0 walk-in), this shows "Payment Pending" indefinitely even
though no payment is ever due. This is a UI-truthfulness wording issue, unrelated
to the ₹0 fee source, with no financial-data impact. Flagged for a possible
future product decision; **no change made here.**

## 9. Recommended next action (only if justified)

- **Code/SQL:** none required for the ₹0 fee — behavior is expected.
- **Configuration process (recommended):** when a hospital is expected to collect
  a walk-in platform fee, set `booking_fee_policies.booking_fee_walkin` (and
  review `booking_fee_online` / `booking_fee_whatsapp`) through the proper
  admin/configuration flow rather than relying on the DEFAULT 0. Document this in
  the staging/production provisioning checklist.
- **Validation coverage (optional):** create one `online` (and/or `whatsapp`)
  staging booking to runtime-exercise the non-zero → payment-order path, since
  only the walk-in ₹0 path has been exercised in staging so far.
- **UI (optional, separate product decision):** consider a "No payment required"
  state for ₹0 bookings instead of a permanent "Pending" badge.

## 10. Changes made

```text
No source changes
No SQL changes
No database mutations
No deployment
No commit
No push
```

Only the read-only `supabase db query --linked` SELECTs above were executed
against staging.

## 11. Git state

```text
HEAD          449ba1193b116d68bcc62227fc99e98d8c9f3822
origin/main   449ba1193b116d68bcc62227fc99e98d8c9f3822
working tree  clean (only this report is new/uncommitted)
```

## 12. Final classification

```text
SOURCE BEHAVIOR ................ PROVEN (migrations 35/54, create-payment-order)
STAGING CONFIGURATION .......... PROVEN (walkin=0 default; online=20; whatsapp=10)
STAGING RUNTIME BEHAVIOR ....... PROVEN for walk-in ₹0 path
                                 UNPROVEN in staging for the online non-zero path
PRODUCT DEFECT ................. NONE for the ₹0 fee
CONFIGURATION GAP .............. Walk-in fee left at DEFAULT 0 (by design)
ROOT CAUSE ..................... CASE A — EXPECTED STAGING CONFIGURATION
```

This phase is an INVESTIGATION ONLY. STOP — awaiting explicit authorization
before any implementation, configuration change, or the optional follow-ups in §9.
