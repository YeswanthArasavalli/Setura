# PHASE 7 — LOCAL DETERMINISTIC ONLINE ₹20 PAYMENT-ORDER PATH VALIDATION
## Financial Runtime Proof — LOCAL ONLY

**Type:** Local runtime validation (read-mostly; controlled local test data only).
**Date:** 2026-09-23
**Environment:** Local Supabase stack, project `setura`, API `http://127.0.0.1:54321`.
**Git at start:** `HEAD == origin/main == 449ba11` (branch `main`).
**Scope boundary honoured:** no production/staging change, no config change, no
new feature, no new migration, no source/SQL change, no Vercel/GitHub change,
no commit, no push, no real Razorpay call, no capture, no refund, no money moved.

---

## 1. Objective

Prove, using the real local Supabase/PostgreSQL + Edge Function integration
stack, the already-implemented online financial chain end-to-end:

```text
online booking → get_effective_fees() → booking_fee_online ₹20
   → create_booking() → booking_fee_inr ₹20 → platform_fee_snapshot ₹20
   → create-payment-order → amountInr ₹20 → amountPaise 2000
   → payment order path → NO revenue before capture
```

This is deterministic runtime proof of the application/database chain, not a
unit test of arithmetic, and not a re-open of the staging investigation.

## 2. Prior staging blocker context (not reopened)

`PHASE_7_ONLINE_NONZERO_PAYMENT_ORDER_VALIDATION_REPORT.md` concluded: staging
online fee config PROVEN (₹20), source chain PROVEN statically, but the deployed
staging app has no online booking entry point and `payment_enabled=false`, so the
staging payment-order runtime proof was BLOCKED. This phase does not revisit that
finding; it establishes the equivalent proof locally.

## 3. Environment

- Docker Desktop was not running at session start; it was started and the daemon
  confirmed ready. The Supabase stack containers existed but `supabase_edge_runtime_setura`,
  `imgproxy` and `pooler` were stopped (the documented `RestartPolicy=no` behaviour
  for Edge Runtime). A `supabase stop` + `supabase start` (data preserved on the
  project docker volume — **not** a `db reset`) brought every service back.
- Edge Runtime was then verified actually running (`docker ps`:
  `supabase_edge_runtime_setura | Up`), not merely trusted from an exit code.
- Tooling: supabase CLI 2.100.1, deno 2.8.3, docker 29.6.2.

## 4. Local fee configuration (`booking_fee_policies`, seeded hospital `…000001`)

| booking_fee_enabled | booking_fee_online | booking_fee_whatsapp | booking_fee_walkin |
| --- | --- | --- | --- |
| true | 20.00 | 10.00 | 0.00 |

`hospital_settings` for the same hospital: `allow_online_booking = true`,
`payment_enabled = false`.

`booking_fee_enabled = true` and `booking_fee_online = 20.00` — the expected
configuration is present, read live, not assumed.

**Classification: EXPECTED CONFIGURATION present — PROVEN (local).**

## 5. Runtime fee-resolution result

Real SQL resolver, real local DB (not source inspection):

```sql
SELECT * FROM get_effective_fees('00000000-0000-4000-8000-000000000001', 'online');
```

| platform_fee | receptionist_fee | hospital_fee | total_amount |
| --- | --- | --- | --- |
| 20.00 | 0.00 | 0.00 | 20.00 |

**ONLINE FEE RESOLUTION = PROVEN LOCAL (runtime).**

## 6. Online create-booking result (real Edge Function path)

The `create-booking` Edge Function was invoked over HTTP (the harness that wires
`get_effective_fees → create_booking`), authenticated as the seeded
`hospital_admin` (`admin@surya.test`) with `X-Hospital-ID` and a UUID-v4
`Idempotency-Key`:

- **HTTP 201**
- `bookingId = 15a0df2d-705c-4163-9ca4-69268faed638`
- `tokenNumber = 13`, `bookingReference = 9A12912A0BE176E5`
- `patientId = 85538f94-0af4-4eea-b90e-e40ce00a87ca`
- `queueSessionId = null`
- Edge-Function-resolved `fees`: `platformFee = 20`, `receptionistFee = 0`,
  `hospitalFee = 0`, `totalAmount = 20`
- `Idempotency-Key = 5bf491f5-bcb6-41cc-ac8b-01665ef158c5`

Exactly ONE controlled booking was created.

**ONLINE BOOKING CREATION = PROVEN LOCAL (runtime, via Edge Function).**

## 7. Booking snapshot evidence (read back from the local DB)

| field | value |
| --- | --- |
| booking_source | online |
| booking_fee_inr | 20.00 |
| platform_fee_snapshot | 20.00 |
| receptionist_fee_snapshot | 0.00 |
| hospital_fee_snapshot | 0.00 |
| total_amount_snapshot | 20.00 |
| payment_completed | false |
| status | booked |
| idempotency_key | 5bf491f5-… (persisted) |

The D16-critical value — the SETURA-collected platform fee actually persisted on
the booking — is **₹20.00**, and `booking_fee_inr == platform_fee_snapshot == 20.00`.
Here the local fixture happens to make `total_amount_snapshot` also ₹20 because
`receptionist_fee` and `hospital_fee` are both 0 for the online source; the
authoritative charge basis is `booking_fee_inr = ₹20`, which is what the
payment-order path consumes.

**FINANCIAL SNAPSHOT = PROVEN LOCAL (runtime).**

## 8. Payment-order result

`create-payment-order` (Edge Function) for booking `15a0df2d…`:

- **HTTP 422** `VALIDATION_ERROR: "Payment is not enabled for this hospital"`.
- The request reached the amount resolution (`amountInr = Number(booking.booking_fee_inr)`
  = ₹20, passes the `amountInr <= 0` guard) and then stopped at the
  `payment_enabled` gate — **before** any network call.

This is the exact, documented local boundary. The `create-payment-order`
implementation calls the live Razorpay Orders API at a hardcoded
`https://api.razorpay.com/v1/orders`; there is **no mock/test gateway adapter**
anywhere in the codebase, and enabling `payment_enabled` is a forbidden config
change this phase. Therefore the full gateway leg cannot be executed locally
without source/config mutation.

Per the phase instruction, the payment-order **Edge Function** runtime through
the real gateway is reported as BLOCKED and is not converted into a PASS.

**PAYMENT-ORDER RUNTIME (live gateway leg) = BLOCKED BY EXTERNAL GATEWAY BOUNDARY.**

Established local internal-payment boundary (the same convention as
`d16_financial_policy.createAndCapture` and `hospital_core_journey` E1 12, which
insert a `payment_orders` row directly instead of contacting Razorpay):

- Inserted `payment_orders` row `id = 0caf3455-4b7b-4c5d-95b4-363237ca5af5`,
  `amount_inr = 20.00`, `payment_status = pending`, `gateway = razorpay`,
  `booking_id = 15a0df2d…`.
- `payment_orders.amount_inr = 20.00` — the rupee amount the D16 model charges
  (== `booking_fee_inr`) is persisted and readable at runtime.

**PAYMENT-ORDER DB ROW (amount_inr ₹20) = PROVEN LOCAL (internal boundary).**

## 9. ₹20 → 2000-paise evidence

- **Runtime (DB):** `payment_orders.amount_inr = 20.00` (rupees) — PROVEN (above).
- **Source, statically verified:** `create-payment-order` derives
  `amountPaise = Math.round(amountInr * 100)` with `amountInr = booking_fee_inr`.
  With the runtime-proven `booking_fee_inr = 20.00`, `amountPaise = Math.round(20 * 100) = 2000`.
  The `rzpOrder.amount !== amountPaise` guard confirms 2000 paise would be the
  value sent to and echoed by the gateway.
- **Runtime (gateway):** the actual 2000-paise Razorpay order creation is BLOCKED
  by the external gateway boundary (§8). No live order was opened and no
  arithmetic was fabricated into a runtime "gateway" claim.

**₹20 → 2000 paise: DB rupee amount PROVEN; paise conversion IMPLEMENTED +
statically verified; live-gateway execution BLOCKED (external boundary).**

## 10. Pre-capture financial state

After the online booking and with the pending ₹20 payment order present, and
before any capture:

| check | value |
| --- | --- |
| `financial_ledger` rows for booking | 0 |
| `booking_fee_collected` ledger sum | 0 |
| `daily_collection_entries.total_amount` | 0.00 |
| `daily_collection_entries.setura_revenue` | 0.00 |
| `daily_collection_entries.is_settled` | false |
| `bookings.payment_completed` | false |

A pending payment order does NOT create collected revenue. The zero-value DCE is
a legitimate operational placeholder, not revenue. `PAYMENT ORDER ≠ PAYMENT
CAPTURE → NO COLLECTED SETURA REVENUE` holds. Corroborated by the regression
test `D16 Q3: a pending payment order still recognises NO revenue` (passed, §14).

**NO REVENUE BEFORE CAPTURE = PROVEN LOCAL (runtime).**

## 11. Idempotency result

The `create-booking` request was replayed with the **same** `Idempotency-Key`
(`5bf491f5-…`) and **same** body through the Edge Function:

- **HTTP 201**, `meta.wasDuplicate = true`, returning the **same** `bookingId`
  `15a0df2d…` and identical fees (₹20).
- `bookings` with that key = **1** (no duplicate booking).
- `api_idempotency_keys` for that key = **1** record, `status = completed`,
  `endpoint = create-booking`.

This is the shared `withIdempotency` primitive that `create-payment-order` also
uses, so the replay-safety mechanism is proven even though the payment-order
gateway leg itself is BLOCKED. No duplicate logical payment order and no
duplicate financial charge/revenue was created (none could be — see §10). The
`payment_orders.gateway_order_id` UNIQUE constraint provides the second dedup
layer at the DB.

**IDEMPOTENCY = PROVEN LOCAL for the create-booking leg (shared primitive);
create-payment-order gateway-leg replay = BLOCKED with the gateway (§8).**

## 12. Tenant isolation result

Not duplicated here — already covered by the executed regression (§14):

- `E1 14: patient history reads respect tenant isolation (real RLS)` — PASS.
- `D16 tenancy: captured money is attributed to the booking's hospital only` — PASS.
- `E1 02: invalid input, tenant mismatch and unauthorized access are refused` — PASS.

Additionally, the locally created booking `15a0df2d…` and payment order
`0caf3455…` carry `hospital_id = 00000000-0000-4000-8000-000000000001` and no
Tenant-B financial data was created.

**TENANT ISOLATION = PROVEN (existing regression) — cited, not duplicated.**

## 13. Razorpay boundary

The Edge Runtime logs for the `create-payment-order` call contain only the
`ValidationError` at the `payment_enabled` gate; there is **no**
`fetch`/`api.razorpay.com` invocation in the log. No request was sent to
`https://api.razorpay.com` and no real/test credentials were used. The only
payment-order row was created through the established DB-side internal boundary
(direct insert), which never touches the gateway.

**NO LIVE RAZORPAY REQUEST OCCURRED = PROVEN. LOCAL MOCK/INTERNAL BOUNDARY is a
direct `payment_orders` insert, explicitly distinct from REAL RAZORPAY.**

## 14. Regression results

Targeted local integration run against the real stack
(`booking_fee_refund`, `d16_financial_policy`, `hospital_core_journey`):

```text
ok | 32 passed | 0 failed (11s)
```

Highlights directly on this chain: `P0-04` create_booking persists
`booking_fee_inr` + non-zero refund; `D16 Q1/Q3/Q4/Q5/Q6` + tenancy; and
hospital_core_journey `E1 01` (HTTP create-booking), `E1 04` (idempotent replay),
`E1 11` (fee snapshot via Edge Function), `E1 12` (capture→ledger atomic + dedup),
`E1 14` (RLS isolation). No test was weakened and no expected value was altered.

**REGRESSION = INTEGRATION VERIFIED, 32/32 PASS.**

## 15. Defects

**No genuine product defect was discovered.** The local runtime behaved exactly
as designed at every step. The only non-`PROVEN` item — the live payment-order
gateway leg — is BLOCKED by an external boundary plus the expected local config
`payment_enabled = false`, and is NOT a code/SQL bug. This phase changes no code,
SQL or configuration, so no migration/fix is proposed or authorised.

## 16. Final classification

```text
LOCAL ENVIRONMENT .............. RUNNING (Docker + Supabase + Edge Runtime verified up)
LOCAL FEE CONFIG ............... PROVEN (EXPECTED CONFIGURATION present: online ₹20, enabled true)
ONLINE FEE RESOLUTION .......... PROVEN LOCAL (get_effective_fees(online) → platform_fee 20.00)
ONLINE CREATE-BOOKING .......... PROVEN LOCAL (Edge Function HTTP 201, fees.platformFee 20)
BOOKING FINANCIAL SNAPSHOT ..... PROVEN LOCAL (booking_fee_inr 20.00 == platform_fee_snapshot 20.00)
PAYMENT-ORDER EDGE FUNCTION .... BLOCKED (external gateway boundary: hardcoded api.razorpay.com,
                               no mock adapter, payment_enabled=false; not converted to PASS)
PAYMENT-ORDER DB ROW ........... PROVEN LOCAL (payment_orders.amount_inr 20.00 via internal boundary)
₹20 → 2000 PAISE .............. DB rupee amount PROVEN; ×100 paise IMPLEMENTED + statically
                               verified; live-gateway execution BLOCKED
NO REVENUE BEFORE CAPTURE ...... PROVEN LOCAL (ledger 0, DCE rev 0/unsettled, paid false)
IDEMPOTENCY .................... PROVEN LOCAL (create-booking shared primitive); gateway-leg
                                 replay BLOCKED with the gateway
TENANT ISOLATION ............... PROVEN (existing regression cited; E1 14 / D16 tenancy / E1 02)
RAZORPAY BOUNDARY .............. PROVEN NO LIVE REQUEST (edge logs show pre-gateway refusal)
REGRESSION ..................... 32 passed / 0 failed
PRODUCT DEFECT ................. NONE
STAGING / PRODUCTION ........... UNTOUCHED (no config, code, SQL, deploy, commit, push)
```

Net effect on the online financial chain:

```text
from  STATICALLY PROVEN + STAGING BLOCKED
to    RUNTIME PROVEN LOCALLY  (fee resolution → booking → snapshot → DB payment-order row
                               → pre-capture no-revenue → idempotency → tenant isolation),
with  the live Razorpay order-creation leg correctly reported BLOCKED by the
external gateway boundary, not silently upgraded to a PASS.
```

STAGE STOP. This phase ends before any capture and before staging/production
change. Awaiting explicit authorization before any next implementation, gateway
mock work, or staging/production change.
