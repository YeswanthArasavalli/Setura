# PHASE 7 — Payment Status UX Investigation Report

**Phase type:** INVESTIGATION ONLY — no source change, no SQL change, no database
mutation, no deployment, no commit, no push.
**Date:** 2026-09-24
**Baseline:** `HEAD == origin/main == 449ba1193b116d68bcc62227fc99e98d8c9f3822` (`449ba11`)

**Concrete question answered:** can SETURA's existing BookingDetail payment
state be made semantically accurate for ₹0 vs non-zero bookings using existing
authoritative data, without touching financial logic?

**Answer: YES.** A frontend-only change is sufficient for the ₹0 / non-zero /
paid classification; no backend change is required for it. A backend
read-surface gap does exist, but only for refund / partial-refund
classification, and this phase recommends NOT closing it.

**Prior phases reused as established evidence, not reopened:** Fee Configuration
Investigation (₹0 walk-in is EXPECTED staging configuration, online ₹20 is
PROVEN), Online Non-Zero Payment Validation (staging correctly BLOCKED: no
online entry point + `payment_enabled=false`), Local Deterministic Online
Financial Validation (₹20 chain PROVEN locally, 32/32 targeted regression PASS,
gateway creation BLOCKED at the external boundary).

---

## 1. Objective

Determine, source-first, whether the staff UI communicates accurately when a
SETURA payment is actually required, and whether that can be fixed entirely
inside the frontend read surface that already exists — without touching any
financial rule.

---

## 2. Current BookingDetail behavior

Exact trace followed:

```
BookingDetail.tsx        apps/web/src/routes/BookingDetail.tsx:42
   ↓  getBooking(hospitalId, bookingId)
reads.ts                 apps/web/src/api/reads.ts:122-134
   ↓  supabase.from("bookings").select(BOOKING_SELECT)     ← PostgREST, under RLS
bookings table           fee snapshot + payment columns
   ↓  row.payment_completed
payment badge            apps/web/src/routes/BookingDetail.tsx:163-167
```

The badge is a pure two-way derivation:

```tsx
<Badge variant={row.payment_completed ? "success" : "secondary"}>
  {row.payment_completed ? "Paid" : "Pending"}
</Badge>
```

**No other field feeds the badge** — not `booking_fee_inr`, not
`payment_status_detail`, not `booking_source`. `payment_status_detail` is
rendered separately and verbatim as an optional "Detail" row (lines 168-170);
the money lines (lines 171-179) are display-only and do not affect the badge.

The identical rule exists in the reception list:
[`ReceptionDashboard.tsx:134`](file:///d:/Projects/datasets/setura/apps/web/src/routes/ReceptionDashboard.tsx#L134)
renders `{r.payment_completed ? "Paid" : "Pending"}`. The ambiguity is therefore
one shared rendering rule over one field, not a BookingDetail-only quirk.

Result (already classified upstream as a **UX ISSUE**, re-confirmed here — not a
financial defect): a legitimate ₹0 `walkin` / `manual_free` booking has
`booking_fee_inr = ₹0`, needs no SETURA payment, has no payment order and
expects no SETURA revenue, yet displays **"Payment Pending"**.

---

## 3. Backend read surface

**Authoritative read path:** direct PostgREST `SELECT` on the `bookings` table
under RLS. There is no RPC, no view and no Edge Function in this path — by
design, per the header comment in
[`reads.ts:3-16`](file:///d:/Projects/datasets/setura/apps/web/src/api/reads.ts#L3-L16)
(staff have no `SELECT` on `payment_ledger`; money is surfaced only through the
booking snapshot columns).

**`payment_status_detail` writer census (complete, grep over
`supabase/migrations` + `supabase/functions`):**

| Writer | Effect |
| --- | --- |
| [migration 28:87-94](file:///d:/Projects/datasets/setura/supabase/migrations/28_booking_enhancements.sql#L87-L94) | one-time backfill of NULL rows only: walkin/manual_free → `not_applicable`, paid → `payment_captured`, else `awaiting_payment` |
| migrations 34:194-202 and 59:248-256 (`capture_payment`) | sets `payment_captured` |
| `create_booking` (migration 54:142-189) | **does not include the column** |
| any Edge Function | **none** (only `database.generated.ts` type mentions) |

So every booking created by the current runtime has
`payment_status_detail = NULL`, and `not_applicable` / `awaiting_payment` are not
produced today. **`payment_status_detail` is therefore NOT a reliable
classification input; `booking_fee_inr` is** — it is
`NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (>= 0)` (migration 28:24-30) and
migration 54 made `create_booking` persist `COALESCE(p_platform_fee, 0)` into it,
repairing pre-54 rows (54:238-241) under a fail-closed self-check. It can never
be NULL in the database; only the TypeScript projection is `number | null`.

**Sufficiency for CASE 1/2/3: the existing read surface is sufficient.** No new
backend read surface is needed and none is proposed.

---

## 4. Available payment fields

From the single existing `BOOKING_SELECT`
([`reads.ts:261-262`](file:///d:/Projects/datasets/setura/apps/web/src/api/reads.ts#L261-L262)):

| Field the brief asked about | Received by frontend? | Authoritative writer |
| --- | --- | --- |
| `booking_fee_inr` | **YES** | migration 28 column · `create_booking` (migration 54) |
| `payment_completed` | **YES** | `capture_payment` only (migrations 34/59) |
| `payment_status_detail` (payment status) | **YES** (NULL at runtime) | migration 28 backfill · `capture_payment` |
| `platform_fee_snapshot` | **YES** | `create_booking` |
| `total_amount_snapshot` | **YES** | `create_booking` |
| `payment_reference` | **YES** | `capture_payment` |
| `receptionist_fee_snapshot` / `hospital_fee_snapshot` | **YES** | `create_booking` |
| payment-order status (`payment_orders.payment_status`) | **NO** | payment engine |
| payment amount / collected amount (`payment_orders.amount_inr`, ledger) | **NO** | payment engine |
| refunded amount (`payment_refunds.refund_amount_inr`) | **NO** | refund engine |
| refund status (`payment_refunds.refund_status`) | **NO** | refund engine |
| `paid_online` | **NO** (not selected) | migration 28 · `capture_payment` |

**Backend read-surface gap (stated precisely, not closed by this phase):** the
`bookings` row carries **no** refund field and no captured-amount field. Refund
state exists only on `payment_refunds` (`refund_status`, `refund_amount_inr`) and
`payment_orders` (`payment_status` enum incl. `refunded` / `partially_refunded`,
migration 13:14-24), neither of which the staff frontend reads.

---

## 5. D16 semantic mapping

D16 is used as-is, not reopened. `booking_fee_inr` is the sole SETURA charge
basis — per its own column comment: *"The fee SETURA charges the patient and
collects via Razorpay. This is the ONLY money SETURA receives for this booking."*
(migration 28:28-30).

`total_amount_snapshot` **MUST NOT** carry payment meaning in the UI: it also
includes hospital and receptionist money SETURA never collects (D16 Q1;
migration 59:38-42; `create-payment-order/index.ts:191-198`). It stays exactly
what it is today — a display line.

**`booking_fee_inr = 0` is sufficient to render "No payment required" — and that
is not a UI invention, it is already the server's own rule.**
[`create-payment-order/index.ts:207-214`](file:///d:/Projects/datasets/setura/supabase/functions/create-payment-order/index.ts#L195-L214)
rejects a zero-fee booking with a `ValidationError` whose literal message is
**"No payment required for this booking (zero platform fee)"**. Therefore:

- no `payment_orders` row can exist for a ₹0 booking (staging confirms 0 orders);
- no capture can occur, so `payment_completed` can never legitimately become
  true for a ₹0 booking on any runtime path;
- "Payment Pending" on such a booking promises a state the backend made
  unreachable — which is precisely the inaccuracy.

No backend semantics change; the UI merely stops contradicting them.

---

## 6. Observed staging examples

Target: `setura-staging`, project ref `gzcqasntcbqqmgsoikms` — verified as the
linked project via `supabase/.temp/linked-project.json` and `.temp/project-ref`;
frontend `https://setura-delta.vercel.app`.

**Method actually used: read-only `SELECT` against the staging database via
`supabase db query --linked`.** No INSERT, no UPDATE, no DELETE, no RPC, no
booking created, no configuration touched, no payment or refund activity.

Complete payment-state census of staging `bookings` (14 rows):

| booking_source | booking_fee_inr | payment_completed | payment_status_detail | count |
| --- | --- | --- | --- | --- |
| `walkin` | 0.00 | false | NULL | 12 |
| `manual_free` | 0.00 | false | NULL | 2 |

Aggregates: bookings with `booking_fee_inr > 0` = **0** ·
`payment_completed = true` = **0** · `payment_orders` rows = **0** ·
`payment_refunds` rows = **0** · RLS policies on `bookings` = **4**.

Representative row (read-only):

```
id                          1533cce8-fc5b-4a64-8d41-4afc0b1d2c9a
booking_reference           3C73AD4FBB83EF9F
booking_source              walkin        status booked
booking_fee_inr             0.00          platform_fee_snapshot     0.00
receptionist_fee_snapshot   0.00          hospital_fee_snapshot     0.00
total_amount_snapshot       0.00
payment_completed           false         paid_online              false
payment_status_detail       NULL          payment_reference        NULL
```

**Rendering outcome for these rows:** with `payment_completed = false` the
derivation in §2 is total and deterministic, so the badge is "Pending"
(`secondary` variant) while the same card shows "Total ₹0" and "Booking fee ₹0".
The underlying-field half of the requested confirmation is
**PROVEN (staging data)**.

**Pixel-level browser observation is BLOCKED — environment/tooling class, not
product.** The `browser-use` MCP bridge failed at transport level before
contacting the site (`Timed out waiting for pipe mcp-28336-556153`, 5 calls
across 3 tools); zero requests reached the application, so no login occurred and
zero data could be created. Per the operating contract the failure was
classified and not retried in a loop. The claim "the current UI displays Payment
Pending" is therefore recorded as **PROVEN BY SOURCE + staging field values**,
explicitly **NOT browser-observed**.

Two caveats a later browser pass must settle rather than assume: (i) whether the
deployed staging bundle equals `HEAD` for this component is UNPROVEN from this
tree — it is already documented that the staging frontend build predates at
least the migration-61 doctor-name fix; (ii) local-stack confirmation was also
impossible — local Supabase is not running (`127.0.0.1:54322` connection
refused) and Docker tooling is unreachable this session, so the local runtime
census is **BLOCKED**.

---

## 7. Current UI states

| # | State | What BookingDetail shows today | Evidence class |
| --- | --- | --- | --- |
| 1 | ₹0 unpaid walk-in | "Payment Pending" badge; no Detail row; Platform/Receptionist/Hospital/Total/Booking fee all ₹0 | PROVEN (source rule + 12 staging rows) |
| 2 | ₹0 `manual_free` | identical to state 1 | PROVEN (source rule + 2 staging rows) |
| 3 | non-zero unpaid | "Payment Pending" (semantically correct) | STATIC derivation PROVEN; live instance NOT OBSERVED (0 staging rows; local stack BLOCKED) |
| 4 | paid | "Paid" success badge | NOT OBSERVED on staging (0 paid rows); mocked unit fixture only (`BookingDetail.test.tsx:47,210`) |
| 5 | refunded | **no refund state at all** — only the booking `status` badge changes to "cancelled" | PROVEN ABSENT (no booking refund field; refund paths write only `status`) |
| 6 | partially refunded | **not represented** | UNPROVEN / NOT OBSERVED; would need a new read surface (§11) |

No financial state was manufactured to populate rows 3-6; the gaps remain
NOT OBSERVED / UNPROVEN.

---

## 8. Proposed UI state mapping

| # | Backend condition | Proposed render | Supportable from existing fields |
| --- | --- | --- | --- |
| 1 | `payment_completed = true` | **Paid** (`success`) | PROVEN — current behavior, unchanged |
| 2 | unpaid AND `booking_fee_inr > 0` | **Payment pending** (`secondary`) | PROVEN |
| 3 | unpaid AND `booking_fee_inr = 0` | **No payment required** (`outline`) | PROVEN — mirrors §5's server rule |
| 4 | `booking_fee_inr` absent/NULL in the client row | **Payment pending** (today's fallback) | Defensive only: DB is NOT NULL, so this is a data anomaly, not a business state — the UI must not read ₹0 semantics out of a missing value |

**Ordering refinement over the brief (the only deviation).** The brief tests
`booking_fee_inr = 0` first; the evidence favors evaluating `payment_completed`
first so "Paid" always wins over the zero-fee branch:

- for real runtime data the two orderings are identical, because
  `capture_payment` cannot run for a ₹0 booking (§5);
- but non-runtime paths do set the flag independently of the fee — migration
  59:98-100 documents a booking inserted already-paid (offline-recognition /
  fixture path), and
  [`tests/integration/booking_fee_refund.test.ts:134-137`](file:///d:/Projects/datasets/setura/tests/integration/booking_fee_refund.test.ts#L134-L137)
  sets `payment_completed = true` without touching `booking_fee_inr`;
- checking "Paid" first guarantees the change can never hide a captured payment.
  Rendering "No payment required" on a booking that genuinely has money collected
  would be the single transformation carrying real financial-communication risk,
  and ruling it out costs nothing.

This ordering is flagged for explicit approval in the implementation phase.

---

## 9. Whether frontend-only implementation is sufficient

**YES for the ₹0 / non-zero / paid classification** — every required input is
already on the row the page fetches, under an existing RLS-protected read.
**NO backend change is required, and none is recommended.**

**NO for refund classification, and this phase recommends NOT attempting it.**
Refund-aware rendering would require a new read surface over `payment_refunds` /
`payment_orders`, whose staff `SELECT` policies differ in blast radius:
`payment_orders_read` covers `hospital_admin` + `receptionist`, while
`payment_refunds_read` covers `hospital_admin` only
([migration 13:856-869, 907-913](file:///d:/Projects/datasets/setura/supabase/migrations/13_payment_engine.sql#L853-L930)).
That is a new data exposure far beyond a badge label. Record it as a known
backend read-surface gap, not as work for this UX fix.

---

## 10. Security / tenant considerations

- **No new read path is introduced.** The badge would read fields already
  returned by the single existing `getBooking` call — an authenticated
  PostgREST `SELECT` on `bookings`.
- **Existing RLS already protects the booking read** — cited from source:
  `bookings_read_admin` (`FOR SELECT USING (is_global_admin() OR
  current_user_role(hospital_id) IN ('hospital_admin','receptionist'))`) and
  `bookings_read_doctor` (`assigned_doctor_id = auth.uid() AND
  current_user_role(hospital_id) = 'doctor'`),
  [migration 02:734-759](file:///d:/Projects/datasets/setura/supabase/migrations/02_atomic_token_engine_&_bookings.sql#L734-L759).
  Live on staging: **4** policies on `bookings` (catalog count, §6), names
  matching migration 02.
- The client-side `.eq("hospital_id", hospitalId)` is defence-in-depth only; RLS
  is the enforcement boundary (`reads.ts:3-16`), and prior staging walkthroughs
  recorded a foreign-booking deep-link returning an empty RLS-filtered set with
  no leak and no 5xx.
- Payment-status text derives from fields of an already-authorized row, so it
  cannot widen exposure; the tables that *would* (`payment_refunds`,
  `payment_ledger`) stay unread.
- Nothing proposed touches a SECURITY DEFINER function, so the F16-04
  explicit-REVOKE obligation is not triggered. No security infrastructure is
  duplicated.

---

## 11. Exact recommended implementation (NOT applied in this phase)

**Scope: one rendering expression in one component, plus one optional sibling.
Zero SQL, zero backend.**

1. `apps/web/src/routes/BookingDetail.tsx:163-167` — replace the two-way badge
   with the three-way derivation of §8 (order: `payment_completed` → "Paid"; else
   `booking_fee_inr === 0` → "No payment required"; else "Payment pending"),
   reusing existing `Badge` variants `success` / `outline` / `secondary` — all
   three already exist in `apps/web/src/components/ui/badge.tsx`, so no styling
   addition is needed.
2. Leave every other row untouched: the optional "Detail" row (raw
   `payment_status_detail` when non-NULL), the fee split, "Total"
   (`total_amount_snapshot`) and "Booking fee" (`booking_fee_inr`). Derive
   nothing from `total_amount_snapshot`; remove nothing.
3. Decide explicitly whether `ReceptionDashboard.tsx:134` gets the same rule.
   Recommendation: extract the mapping into one small helper under
   `apps/web/src/lib/` and use it in both places so exactly one definition of
   the label exists. Still frontend-only.
4. No new selected column, no `BOOKING_SELECT` change, no type regeneration, no
   migration, no RPC change, no Edge Function change.
5. Tests for the implementation phase: extend
   `apps/web/src/routes/BookingDetail.test.tsx` with three fixtures
   (fee 0 + unpaid, fee 20 + unpaid, fee 20 + paid) plus one negative guard
   (fee 0 + paid must still read "Paid", pinning the §8 ordering). Vitest/RTL
   only — these are pure derivations of an already-fetched row, so no integration
   test is required and none may be weakened or deleted.

---

## 12. What MUST NOT be changed

Binding for the next phase: no new migration and no edit to any existing
migration; no change to `create_booking`, `get_effective_fees`,
`capture_payment`, `create-payment-order`, `process-refund`, `cancel-booking`,
the cumulative refund cap, settlement proration, ledger/collection logic, D16
policy, fee or hospital configuration, the `payment_status_detail` CHECK list,
staging or production configuration, Vercel settings, secrets, or any manually
mutated financial row. In particular this phase adds **no writer** for
`payment_status_detail` — making `not_applicable` / `awaiting_payment` actually
populated would be a backend behavioral change and is deliberately excluded.

---

## 13. Final classification

| Item | Classification |
| --- | --- |
| Payment data source | **PROVEN** — PostgREST `SELECT` on `bookings` snapshot columns, under RLS |
| `booking_fee_inr` available | **PROVEN** |
| `payment_completed` available | **PROVEN** |
| `payment_status_detail` available | **PROVEN available but NULL for all runtime-created bookings** — not usable as a classification input |
| ₹0 semantic classification | **PROVEN** — mirrors the existing `create-payment-order` zero-fee rule; no new financial assertion |
| non-zero pending classification | **PROVEN** statically; live non-zero instance **NOT OBSERVED** |
| paid classification | **PROVEN** as current behavior; live paid instance **NOT OBSERVED** (mocked unit fixture only) |
| refund classification | **UNPROVEN / NOT SUPPORTABLE** by the existing read surface (backend gap, intentionally not closed) |
| frontend-only fix possible | **YES** (₹0 / non-zero / paid) |
| backend change required | **NO** for the above; **YES** only to display refund state, which is not recommended |
| financial logic defect | **NONE** |
| UX issue | **CONFIRMED** |
| Browser rendering confirmation | **BLOCKED** (browser MCP transport failure) |
| Local runtime census | **BLOCKED** (stack not running; Docker tooling unreachable) |
| Anything implemented this phase | **NOTHING** — INVESTIGATION ONLY |

Vocabulary discipline: no claim of CERTIFIED, PRODUCTION VERIFIED or "works".
Staging-database-derived statements are STAGING-DATA OBSERVED; source-derived
statements are STATICALLY PROVEN; the rendered-pixel claim is NOT OBSERVED /
BLOCKED.

---

## 14. Git state

`HEAD == origin/main == 449ba11` — matches the expected baseline. Tracked tree
clean; zero source files modified by this phase. This report is untracked and is
**NOT committed** and **NOT pushed**, alongside the three untracked reports that
pre-existed this phase. **IMPLEMENTED: none. NO COMMIT. NO PUSH.**

---

## Stop condition

Investigation only. Even though a frontend-only fix is clearly appropriate, it
was **not** implemented. The next phase, if separately authorized, owns frontend
implementation, local tests, staging deployment, browser validation and
commit/push. That boundary was not crossed here.
