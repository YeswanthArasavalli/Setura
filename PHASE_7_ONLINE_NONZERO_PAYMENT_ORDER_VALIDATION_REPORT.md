# PHASE 7 — ONLINE NON-ZERO PAYMENT-ORDER VALIDATION REPORT

**Type:** CONTROLLED STAGING RUNTIME VALIDATION — INVESTIGATION/VALIDATION ONLY.
No source, SQL, migration, Edge Function, RLS, fee-configuration, hospital-setting,
secret, CORS, Vercel or production change was performed. No commit. No push.
**Date:** 2026-09-23
**Staging project:** `setura-staging` / `gzcqasntcbqqmgsoikms`
**Git at start and end:** `HEAD == origin/main == 449ba11`, working tree clean
apart from the two untracked Phase 7 report artifacts.

---

## 0. Outcome summary (read first)

The runtime objective — create ONE live `online` staging booking and drive it to a
₹20 / 2000-paise payment order — is **BLOCKED at the staging configuration and
application surface**, by two independent facts that the hard safety boundary
forbids changing:

1. **No online booking path exists in the deployed staging application.** The
   `apps/web` staff UI exposes only `walkin` (`WalkIn.tsx`) and `manual_free`
   (`BookAppointment.tsx`). The `BookingForm` `source` prop is hard-coded per
   route; there is no control, and no patient-facing page, that submits
   `booking_source = "online"`. The `"online"` value exists only as a
   `BookingSource` type member and is never sent by this application.
2. **`payment_enabled = false` for the staging hospital.** `create-payment-order`
   throws `ValidationError("Payment is not enabled for this hospital")` at
   index.ts L288–295, **before** any Razorpay call. The payment-order path
   therefore cannot be exercised on the current staging configuration without
   modifying a hospital setting, which the hard safety boundary prohibits.

What COULD be proven safely and read-only was proven (see below). The online
**fee-resolution** path is runtime-PROVEN at the database; the online **booking
persistence** and **payment-order** runtime steps are BLOCKED, not UNPROVEN-by-
neglect.

**No payment was captured. No real money was moved. The Razorpay external
boundary was never reached.**

---

## 1. Objective

Controlled staging-only runtime validation of the NON-ZERO ONLINE booking fee
path, proving:

```text
online booking → fee resolver → booking_fee_online = ₹20
  → booking_fee_inr = ₹20 → platform_fee_snapshot = ₹20
  → create-payment-order → ₹20 / 2000-paise order → NO revenue before capture
```

Validation only; no real Razorpay capture.

## 2. D16 financial context (restated — NOT changed)

- SETURA collects ONLY the booking/platform fee via Razorpay.
- Hospital consultation fee is collected directly by the hospital, never by SETURA.
- For this test the SETURA platform fee is ₹20; the consultation fee is separate.
- Revenue is recognized only after successful payment capture.

D16, D5 and D13 were not touched.

## 3. Source verification (Phase A — STATICALLY PROVEN)

Exact current source was re-read before any runtime work.

**3.1 Fee resolver** — `get_effective_fees(UUID, booking_source)`, live body =
migration 35 (`35_hospital_config_enhancements.sql` L133–202):

- Prefers a `booking_fee_policies` row when present:
  `booking_fee_enabled = false → 0`; otherwise `online → booking_fee_online`
  (L152–153), `manual_whatsapp → booking_fee_whatsapp`, `walkin →
  booking_fee_walkin`, else `0`.
- Fallback (`hospital_settings`) if no policy row:
  `online → COALESCE(platform_fee_online, 20)`.
- `hospital_fee` hard-coded `0` (SETURA model, L198).

**3.2 create-booking** — `supabase/functions/create-booking/index.ts`:

- Resolves fees via `db.rpc("get_effective_fees", { p_hospital_id, p_booking_source:
  body.bookingSource })` (L414–420).
- Passes the resolved platform fee into the canonical writer:
  `p_platform_fee: feeRow.platform_fee` (L455).
- The `create_booking` RPC (migration 54 `54_booking_fee_writer.sql` L142–189)
  persists BOTH `platform_fee_snapshot = COALESCE(p_platform_fee, 0)` (L159/183)
  AND `booking_fee_inr = COALESCE(p_platform_fee, 0)` (L160/184), plus
  receptionist/hospital/total snapshots. This is the runtime writer that closed
  the historical P0-04 gap.

**3.3 create-payment-order** — `supabase/functions/create-payment-order/index.ts`:

- `const amountInr = Number(booking.booking_fee_inr ?? 0)` (L195–198) — amount is
  the platform fee, never `total_amount_snapshot` (D16 Q1, comment L191–194).
- Positive amounts allowed; `amountInr <= 0` rejects with `"No payment required
  for this booking (zero platform fee)"` (L207–214).
- Paise conversion is correct: `const amountPaise = Math.round(amountInr * 100)`
  (L215) → ₹20 = **2000 paise**.
- Persisted `payment_orders.amount_inr = amountInr` (L345).
- Gate ordering matters: `payment_enabled` check (L288–295) runs BEFORE the
  Razorpay order call (L306) — see §12.

No discrepancies with the prior Fee Configuration Investigation were found.

## 4. Staging fee configuration (Phase B — read-only, PROVEN)

Hospital `00000000-0000-4000-8000-000000000001`:

| key | value |
| --- | --- |
| `booking_fee_enabled` | `true` |
| `booking_fee_online` | **`20.00`** |
| `booking_fee_walkin` | `0.00` |
| `booking_fee_whatsapp` | `10.00` |
| `allow_online_booking` | `true` |
| `payment_enabled` | **`false`** |

The online fee is ₹20 as expected, so the Phase B "STOP if not ₹20" condition did
not fire. However `payment_enabled = false` blocks the payment-order path
(§12). Nothing was modified.

## 5. Online booking details (Phase C/D/E)

**NOT CREATED — BLOCKED.** The deployed staging application has no online booking
entry point (§0.1). Creating the booking would have required either (a) modifying
the source to add an online route, or (b) hand-driving the Edge Function/RPC as a
synthetic path, neither of which the hard safety boundary permits, and neither of
which is "the EXISTING staging-backed application." Existing staging bookings
corroborate the surface: `booking_source` distribution is `walkin` (12) and
`manual_free` (2), **zero `online` rows**, all with `booking_fee_inr = 0.00`
(consistent with walk-in/manual_free resolving to ₹0).

## 6. Fee snapshot evidence (Phase E)

**Booking-row snapshot: UNPROVEN in staging (no online booking created).**
The snapshot chain is nonetheless statically PROVEN (§3.2) and its input — the
online resolver output — is runtime PROVEN on live staging (§4/§14 via
`get_effective_fees(...,'online') → platform_fee = 20.00`). The `create_booking`
writer's fidelity is corroborated by the 14 existing bookings, each persisting
exactly the fee its source resolves to (walkin/manual_free → 0.00).

## 7. Payment-order evidence (Phase F)

**NOT CREATED — BLOCKED (§12).** On the current staging configuration
`create-payment-order` cannot succeed regardless of booking fee, because it
rejects at `payment_enabled = false` before evaluating the amount or calling the
gateway.

## 8. Ledger / revenue pre-capture evidence (Phase G)

**NOT APPLICABLE — no payment order was created**, so there is nothing to observe
at the ledger/revenue/settlement boundary. D16 rule 4/5 (no revenue before
capture) is unaffected. No financial rows were read as a side effect of any new
transaction because no new transaction was made.

## 9. Idempotency result (Phase H)

**NOT TESTED — dependent operation (payment-order creation) is BLOCKED.** The
static idempotency design remains: `create-payment-order` reuses an existing
`initiated/pending/authorized` order for the same booking (L217–265) and wraps
the handler in `withIdempotency` (L132). Not exercised at runtime here.

## 10. Tenant isolation (Phase K)

**NOT EXERCISED.** No Tenant A booking was created, so there was no new cross-
tenant read to attempt against `reception-b@surya.test`. (Tenant isolation for the
booking surface is covered separately by the prior Phase 7 walkthrough reports and
Gate 2 privilege census — not re-proven here.)

## 11. Browser / network health (Phase J)

**NOT EXERCISED** — no browser booking flow was driven, because the required
`online` path is absent from the application. No localhost backend, production
Supabase URL, secret, CORS error or unexpected 4xx/5xx was encountered (none was
triggered). Only read-only `supabase db query --linked` SELECTs and one read-only
`get_effective_fees(...)` function call were executed against staging.

## 12. External Razorpay boundary

The Razorpay Orders API (`https://api.razorpay.com/v1/orders`, L73) was **never
reached.** `create-payment-order` short-circuits at the `payment_enabled` guard
(L288–295) which sits before the gateway call (L306). Therefore:

```text
No payment was captured.
No real money was moved.
No Razorpay order was opened (test or live).
```

This also removed any real-money risk from the validation.

## 13. Validation artifacts

**None created.** No booking, payment order, ledger row or settlement/DCE row was
added. Nothing to preserve or clean up; staging is unchanged.

## 14. Root classification

```text
Fee configuration (online = ₹20, enabled = true) ......... PROVEN (staging read-only)
Online fee resolution (resolver → 20) ................... PROVEN (live DB, read-only
                                                          get_effective_fees(...,'online') = 20.00)
Source chain (resolver → create_booking → payment-order)  PROVEN (static: mig 35/54,
                                                          create-booking, create-payment-order)
booking_fee_inr = ₹20 on a real online booking .......... UNPROVEN in staging
                                                          (no online booking could be created)
Payment order creation .................................. BLOCKED
                                                          (payment_enabled = false; hospital
                                                          settings may not be changed)
Payment order amount = ₹20 / 2000 paise ................. BLOCKED (depends on prior)
Ledger / revenue before capture ......................... NOT APPLICABLE (no order created)
Tenant isolation ........................................ NOT EXERCISED (no new booking)
External Razorpay capture ............................... NOT TESTED BY DESIGN (boundary never reached)
Online booking path in deployed application ............. MISSING (product surface gap)
```

No DEFECT was found in the fee resolver, the booking writer, or the payment-order
amount logic. The blockers are (a) a missing application entry point for `online`
bookings and (b) a staging configuration value (`payment_enabled = false`) that
the hard safety boundary forbids changing.

## 15. Changes made

```text
No source changes
No SQL changes
No migration
No fee-configuration change
No hospital-settings change
No secret change
No CORS change
No Vercel change
No database mutation (no booking / payment order / ledger / settlement written)
No production action
No commit
No push
```

Only read-only `supabase db query --linked` SELECTs and a read-only
`get_effective_fees(...)` call were run against staging.

## 16. Git state

```text
HEAD          449ba1193b116d68bcc62227fc99e98d8c9f3822  (449ba11)
origin/main   449ba1193b116d68bcc62227fc99e98d8c9f3822  (449ba11)
working tree  clean except untracked Phase 7 report artifacts
```

This report is UNCOMMITTED. Nothing was committed or pushed.

---

## Recommended next actions (require separate authorization — none taken here)

1. **Product/application decision:** if the online non-zero fee path must be
   reachable by real users, an online/patient-facing booking entry point is
   required (the staff UI intentionally only issues walk-in / manual_free). Until
   it exists, this runtime path cannot be exercised "through the existing
   staging-backed application."
2. **Staging configuration (if a payment-order runtime check is desired):**
   `payment_enabled` would need to be `true` for the test hospital, AND a
   `razorpay_key_id`/test key environment confirmed — both are configuration/
   secret changes outside this validation-only boundary and must be authorized
   explicitly, ideally with Razorpay **test** keys so no live order is opened.
3. Alternatively, the online → ₹20 → 2000-paise chain can be proven deterministically
   in the local stack integration tests (source chain is already statically
   PROVEN; the live resolver returns ₹20) without staging config changes.

**STOP.** Validation-only phase complete; the runtime booking/payment-order steps
are BLOCKED at staging, not silently skipped. Awaiting explicit authorization
before any configuration change, product-surface work, or implementation.
