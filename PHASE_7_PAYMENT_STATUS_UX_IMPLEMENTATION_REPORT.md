# PHASE 7 — Payment Status UX Implementation Report

**Phase type:** frontend-only product fix + local validation + staging
deployment + real browser validation. This follow-up session restored browser
tooling, committed and pushed the change (which is this project's staging deploy
path), then validated the deployed `setura-delta.vercel.app` in a real browser.
**Date:** 2026-09-24
**Authoritative investigation:** `PHASE_7_PAYMENT_STATUS_UX_INVESTIGATION_REPORT.md` (not reopened)
**Baseline at start:** `HEAD == origin/main == 449ba1193b116d68bcc62227fc99e98d8c9f3822` (`449ba11`)
**Implementation commit:** `59298274f9077726683ee8bf4b5bd6f6f5856f40` (`5929827`) —
`feat: clarify payment status for zero-fee bookings`, pushed to `origin/main`;
this reconciliation lands in a subsequent documentation-only commit on `main`.

**Explicit statements required by the brief:**

- **No financial logic changed.**
- **No backend read surface changed.**
- **No migration was added.**
- **No payment/refund behavior changed.**
- **No production deployment occurred.**

---

## 1. Objective

Implement the approved payment-status semantics so the staff UI communicates
whether a SETURA payment is actually required, distinguishing
`Paid` / `Payment pending` / `No payment required`, using only fields the
frontend already receives — without touching SQL, fees, payment, refund,
settlement, configuration or deployment boundaries beyond staging.

---

## 2. Approved semantics

```
payment_completed === true        →  "Paid"                 (Badge: success)
else booking_fee_inr === 0        →  "No payment required"  (Badge: outline)
else                              →  "Payment pending"      (Badge: secondary)
```

`payment_completed` is evaluated **first** — the approved safety requirement.
`null` is **not** treated as `0`. `total_amount_snapshot` is **not** an input.
**IMPLEMENTED exactly as approved.**

---

## 3. Source changes

**Pre-flight (Phase A):** `HEAD == origin/main == 449ba11`, tracked tree clean
apart from four untracked reports, and all four target files still matched the
investigation byte-for-byte in the relevant regions (badge at
`BookingDetail.tsx:163-167`, list cell at `ReceptionDashboard.tsx:134`,
`BOOKING_SELECT` at `reads.ts:261-262`, variants at `badge.tsx:8-17`).
**No material drift → proceeded.**

| File | Status | Change |
| --- | --- | --- |
| `apps/web/src/lib/paymentStatus.ts` | **NEW** (70 lines) | the single shared mapping |
| `apps/web/src/lib/paymentStatus.test.ts` | **NEW** (7 `it` blocks) | pure-function coverage of the mapping |
| `apps/web/src/routes/BookingDetail.tsx` | modified | badge now renders via the helper through a local `PaymentBadge` component; doc comment updated |
| `apps/web/src/routes/ReceptionDashboard.tsx` | modified | payment cell now `{paymentStatus(r).label}` instead of the local ternary |
| `apps/web/src/routes/BookingDetail.test.tsx` | modified | +6 badge tests in one new `describe` block; no existing test altered, weakened or deleted |

Full diff scope: `3 files changed, 122 insertions(+), 5 deletions(-)` plus the two
new untracked `src/lib/` files. `git diff --check` clean.

---

## 4. Shared helper

[`apps/web/src/lib/paymentStatus.ts`](file:///d:/Projects/datasets/setura/apps/web/src/lib/paymentStatus.ts)

```ts
export function paymentStatus(row: PaymentStatusInput): PaymentStatus {
  if (row.payment_completed) {
    return { key: "paid", label: "Paid", variant: "success" };
  }
  // Strict comparison on purpose: null / undefined must NOT reach this branch.
  if (row.booking_fee_inr === 0) {
    return { key: "no_payment_required", label: "No payment required", variant: "outline" };
  }
  return { key: "pending", label: "Payment pending", variant: "secondary" };
}
```

- Input is the **minimum** authoritative pair only:
  `{ payment_completed: boolean; booking_fee_inr: number | null }` — `BookingRow`
  already satisfies it, so **no new field, no changed select list**.
- Output is `{ key, label, variant }`, where `variant` is typed as
  `NonNullable<BadgeProps["variant"]>`, so it is checked against the **existing**
  `Badge` variants. **No new styling infrastructure.**
- The three contracts (ordering-first, `null ≠ 0`, no `total_amount_snapshot`)
  are documented in the file header as things that must not be "simplified".
- No `Number(value || 0)`-style coercion anywhere — the brief's named unsafe
  pattern is explicitly avoided and the reason is recorded in the comment.
- Located under `apps/web/src/lib/`, matching the established co-located
  `*.ts` + `*.test.ts` convention already used by `errors.ts`,
  `idempotency.ts` and `dates.ts`. **IMPLEMENTED, typecheck PASS.**

---

## 5. BookingDetail changes

[BookingDetail.tsx](file:///d:/Projects/datasets/setura/apps/web/src/routes/BookingDetail.tsx#L163-L167)
now renders:

```tsx
<Row label="Payment">
  <PaymentBadge row={row} />
</Row>
```

with a local component (placed beside the existing `Row` / `fmt` helpers) that
calls the shared mapping once:

```tsx
function PaymentBadge({ row }: { row: BookingRow }) {
  const status = paymentStatus(row);
  return <Badge variant={status.variant}>{status.label}</Badge>;
}
```

Untouched, as required: the fee split rows, "Total" (`total_amount_snapshot`),
"Booking fee" (`booking_fee_inr`), the optional `payment_status_detail` "Detail"
row, `payment_reference`, the booking `status` badge, and all consultation/
clinical rendering. **No writer was added for `payment_status_detail`, and its
CHECK constraint was not modified.** **IMPLEMENTED.**

---

## 6. ReceptionDashboard changes

[ReceptionDashboard.tsx:135](file:///d:/Projects/datasets/setura/apps/web/src/routes/ReceptionDashboard.tsx#L122-L144)
payment column changed from

```tsx
<TD>{r.payment_completed ? "Paid" : "Pending"}</TD>
```

to

```tsx
<TD>{paymentStatus(r).label}</TD>
```

**Phase D precondition verified, not assumed:** the dashboard rows are typed
`BookingRow`, produced by `listTodaysBookings`, which uses the same
`BOOKING_SELECT` that already includes `booking_fee_inr`
(`reads.ts:261-262`). So the helper could be applied **without any new backend
query or read surface**. Only one payment-status definition now exists in the
product (the helper), which is what the brief required. The old label "Pending"
is superseded by "Payment pending" in the list — the deliberate, single-source
consequence of removing the duplicate definition. **IMPLEMENTED.**

---

## 7. Test cases

Helper unit tests (`paymentStatus.test.ts`, 7):

1. `fee 0 + unpaid` → `no_payment_required` / "No payment required" / outline
2. `fee 20 + unpaid` → `pending` / "Payment pending" / secondary
3. `fee 20 + paid` → `paid` / "Paid" / success
4. **critical ordering guard:** `fee 0 + paid` → `paid`, explicitly **not**
   "No payment required"
5. `fee null + unpaid` → `pending` (`null` is not a zero fee)
6. `fee undefined + unpaid` → `pending` (absent field is not coerced)
7. extra field present (`total_amount_snapshot: 500`) on a zero-fee unpaid row →
   still `no_payment_required` (semantics not derived from the total)

BookingDetail render tests (`BookingDetail.test.tsx`, new describe block, 6):

1. zero-fee unpaid walk-in (all snapshots ₹0, matching the real staging row
   shape) → "No payment required" present; "Payment pending" and "Paid" absent
2. `fee 20` unpaid → "Payment pending"; "No payment required" absent
3. `fee 20` paid → "Paid"; both other labels absent
4. **critical negative guard** `fee 0` + `payment_completed = true` → "Paid";
   "No payment required" absent
5. `booking_fee_inr = null`, unpaid → "Payment pending"
6. zero fee with `total_amount_snapshot = 500` → still "No payment required"
   (₹500 renders as display text but does not feed the badge)

Required TEST 1-4 from Phase E are all present, plus the null defensive case.
**No existing test was deleted, skipped or weakened** — the previously existing
`keeps the existing booking and payment detail intact` test (which asserts
"Paid" and "₹500" on the paid fixture) still passes unchanged.

---

## 8. Local validation

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` (`tsc --noEmit`) | **PASS** (no diagnostics) |
| Frontend unit tests | `npm test` (`vitest run`) | **PASS — 7 files, 55/55 tests** (42 before this phase + 7 helper + 6 badge) |
| Production build | `npm run build` | **PASS** — vite 5.4.21, 111 modules, `dist/assets/index-CjDQ0K-S.js` 459.41 kB (gzip 131.17), CSS 13.40 kB, built in 7.81 s |
| Built-bundle secret scan | `deno run --allow-read ../../scripts/check_frontend_secrets.ts dist --deny-sourcemaps` | **PASS** — 3 artifacts, **0 secret hits, 0 source maps** |
| Whitespace/diff hygiene | `git diff --check` | **PASS** (no output) |

**Backend test expectations were not modified.** No Deno/Supabase source,
migration, SQL or test file is in the diff, so the backend suites were not
re-run (the brief explicitly forbids turning this into a broad audit).

---

## 9. Staging deployment

**PERFORMED via the project's own Git-connected path — no drift, no config change.**

This project's staging frontend is deployed by its **Git-connected Vercel
project** (`setura`, ref `prj_PZq3TlY28vzz3hF6x0TKpvxK6gMH`, Root Directory
`apps/web`): a push to `main` triggers the cloud build and promotes the
`setura-delta.vercel.app` alias. That is exactly what was done — commit `5929827`
pushed to `origin/main`, which triggered the build.

- Vercel build `setura-2hganjdwc-yeswantharasavallis-projects.vercel.app`
  reached **Ready** (Production, ~15 s build) and carries the alias
  `https://setura-delta.vercel.app`.
- **Deployed-bundle freshness confirmed independently:** the live
  `https://setura-delta.vercel.app` references `assets/index-Cp6ghPMO.js`, which
  contains the string `"No payment required"`. This closes the documented caveat
  that a staging bundle may predate `HEAD` — the observed browser result is
  attributable to commit `5929827`, not a stale build.

**No Vercel project, setting, environment variable, Root Directory or
`vercel.json` was created or modified; no `.vercel` config, no `--prebuilt` /
detached upload, and no deployed-vs-`HEAD` drift was introduced.** The public
staging alias corresponds to a real pushed commit.

---

## 10. Browser validation

**PERFORMED against the live staging alias `https://setura-delta.vercel.app`**
(real browser, real staging backend `gzcqasntcbqqmgsoikms.supabase.co`).

Primary acceptance test — ₹0 unpaid walk-in:

- **Reception Dashboard** (Tenant A `reception@surya.test`, hospital
  `…0001`): all **7** of today's ₹0 `walkin` / `manual_free` bookings render
  the Payment column as **"No payment required"** — none show the old generic
  "Pending", and none show "Paid".
- **BookingDetail** (Tenant A booking `1533cce8-fc5b-4a64-8d41-4afc0b1d2c9a`,
  `walkin`, every fee snapshot ₹0): the "Payment & billing" row reads
  **"No payment required"** — not "Payment pending", not "Paid". This proves
  both UI surfaces use the same shared mapping.

Data limitation honoured (read-only census, confirmed this session): staging
holds **14** bookings, **all** `booking_fee_inr = 0` and unpaid — **0** rows with
`booking_fee_inr > 0`, **0** paid rows and **0** payment orders. The secondary
states therefore **cannot** be observed without fabricating financial rows, which
is forbidden and was **not** done.

| State | Classification |
| --- | --- |
| ₹0 unpaid walk-in → "No payment required" | **PROVEN STAGING** (both BookingDetail + Reception Dashboard) |
| non-zero unpaid → "Payment pending" | **NOT OBSERVED** (0 such staging rows; fabrication forbidden) — locally **PROVEN** by unit + render tests |
| paid → "Paid" | **NOT OBSERVED** (0 such staging rows; fabrication forbidden) — locally **PROVEN** by unit + render tests, incl. the critical paid+zero-fee ordering guard |

Console during validation: **0 errors, 0 warnings.** Network: every request to
the staging backend returned **200** — **0 app-origin 4xx/5xx, 0 CORS failures,
no `localhost` / `127.0.0.1` requests.** `NOT OBSERVED` is **not** upgraded to
`PROVEN` for the two states staging cannot supply.

---

## 11. Tenant isolation

**No authorization code path changed — PROVEN by diff scope:**
`git diff --stat` / `git status --porcelain` show only
`apps/web/src/routes/{BookingDetail,ReceptionDashboard}.tsx`,
`apps/web/src/routes/BookingDetail.test.tsx` and the two new
`apps/web/src/lib/paymentStatus*` files. `apps/web/src/api/reads.ts` (including
`BOOKING_SELECT`), every migration, every RLS policy, every RPC and every Edge
Function is untouched; no query, filter or read path was added.

The badge is a pure derivation from fields of an **already RLS-authorized**
booking row (`bookings_read_admin` / `bookings_read_doctor`, migration 02:734-759
— unchanged), so it cannot widen exposure. **Runtime re-verification was
PERFORMED in the browser this session:**

- Tenant B `reception-b@surya.test` (hospital `…0002`) Reception Dashboard →
  **"No bookings today" / 0**, while Tenant A has 7 ₹0 bookings on the same
  date — no Tenant A row is visible to Tenant B.
- Tenant B **direct URL** to real Tenant A booking
  `1533cce8-fc5b-4a64-8d41-4afc0b1d2c9a` → renders **"Booking not found or not
  visible to your account."** The underlying PostgREST query
  (`…/rest/v1/bookings?…hospital_id=eq.…0002&id=eq.1533cce8…`) returned **200
  with an empty set** — no Tenant A data exposed, no error.

**Tenant isolation: PROVEN STAGING**, and the code path remains
**PRESERVED BY CONSTRUCTION (PROVEN statically)** — no RLS, query, filter or
read surface changed.

---

## 12. Security impact

- **No new secret, token or credential introduced** — PROVEN by the built-bundle
  scan (0 hits) and by direct inspection: the diff contains no key material, no
  `.env` edit and no hardcoded URL.
- Bundle label/content check after the local production build:
  `"No payment required"` **present**, `"Payment pending"` **present**,
  `"Paid"` **present**, `service_role` **absent** — 0 source maps shipped.
- No SECURITY DEFINER function, no grant, no RLS policy and no
  `payment_status_detail` CHECK constraint was touched, so the F16-04
  explicit-REVOKE obligation is not triggered.
- No frontend type was regenerated and no backend type surface changed.

---

## 13. Financial impact

**NONE.** The helper reads `payment_completed` and `booking_fee_inr` and renders
a label; it writes nothing, sends nothing, computes no fee, and never reads
`total_amount_snapshot` for semantics (D16 unchanged). No SQL, RPC, migration,
ledger, refund, settlement, `create-payment-order`, `create-booking`, fee policy
or hospital setting was modified; no payment order was created; nothing was
captured or refunded; no financial row was mutated. Test expectations on the
backend were not altered.

The one behavioral risk in this class of change — a paid booking being rendered
as "No payment required" — is structurally excluded by the ordering and pinned by
the two critical guard tests (§7 items 4 and the BookingDetail counterpart),
which pass.

---

## 14. Regression

Established frontend regression, run after the final edit:

- `npm run typecheck` → **PASS**
- `npm test` → **55/55 PASS across 7 files** (all 42 pre-existing tests still
  pass; 13 added)
- `npm run build` → **PASS**
- built-bundle secret + source-map scan → **PASS (0/0)**
- `git diff --check` → **clean**

No unrelated suite, migration validation, Deno task or repository-wide audit was
re-run: this diff contains no backend, SQL or configuration source.

---

## 15. Remaining limitations

1. **Non-zero and paid UI states cannot be observed on staging at all** (0 such
   rows exist and none may be fabricated) — permanently
   **NOT OBSERVED / NOT TESTED** in the browser for this environment,
   independent of tooling. They remain locally **PROVEN** by unit + render tests
   including the critical paid + zero-fee ordering guard.
2. Refund / partial-refund badges remain **out of scope and unimplemented**, as
   decided: they require a new backend read surface. `payment_status_detail`
   still has **no runtime writer** for `not_applicable` / `awaiting_payment`,
   unchanged and deliberately not addressed here.
3. Root-level markdown reports are not `deno fmt`-clean, consistent with the
   documented pre-existing condition; no source file is affected.

The earlier session's limitations — browser tooling BLOCKED, staging NOT
deployed and commit/push WITHHELD — are **resolved**: browser tooling was
restored, the change was committed + pushed (`5929827`), the Git-connected
Vercel build reached Ready on `setura-delta.vercel.app`, and the ₹0 walk-in
state plus tenant isolation were validated in a real browser.

---

## 16. Git state

The implementation was committed and pushed to `main` (the project's staging
deploy path). Exactly the six intended files were staged — the three modified
routes/test files, the two new `src/lib/paymentStatus*` files and this report —
and **no** unrelated historical report, generated file, `.env`, `.vercel` or
`dist` was included.

```
$ git commit -m "feat: clarify payment status for zero-fee bookings"
[main 5929827] ... 6 files changed, 691 insertions(+), 5 deletions(-)
$ git push origin main
   449ba11..5929827  main -> main
$ git rev-parse HEAD        59298274f9077726683ee8bf4b5bd6f6f5856f40
$ git rev-parse origin/main 59298274f9077726683ee8bf4b5bd6f6f5856f40
```

`HEAD == origin/main == 5929827`, working tree clean apart from four unrelated
untracked historical reports that are deliberately left out of scope. No force
push, no rebase, no history rewrite and no `git add .` was used. This report
reconciliation is committed as a subsequent documentation-only commit.

---

## Classification summary

| Item | Classification |
| --- | --- |
| Shared `paymentStatus` helper | **IMPLEMENTED** |
| BookingDetail badge via shared helper | **IMPLEMENTED** |
| ReceptionDashboard cell via shared helper (no read-surface change) | **IMPLEMENTED** |
| Approved three-way semantics + ordering | **IMPLEMENTED**, **UNIT VERIFIED** |
| `null ≠ 0` defensive handling | **IMPLEMENTED**, **UNIT VERIFIED** |
| Typecheck | **PASS** |
| Frontend unit tests | **PASS** (55/55) |
| Production build | **PASS** |
| Secret / source-map scan | **PASS** |
| Backend, SQL, migration, fee, payment, refund, settlement change | **NONE** (PROVEN by diff scope) |
| Staging deployment | **PROVEN** — commit `5929827` pushed; Vercel build Ready on `setura-delta.vercel.app`; live bundle contains "No payment required" |
| Browser validation — ₹0 unpaid walk-in | **PROVEN STAGING** (BookingDetail + Reception Dashboard) |
| Non-zero + paid states on staging | **NOT OBSERVED** (no such rows; fabrication forbidden) — locally **PROVEN** |
| Tenant isolation runtime re-check | **PROVEN STAGING** (Tenant B sees 0 Tenant A rows + foreign deep-link empty RLS); code path unchanged |
| Console / network during validation | **0 errors, 0 warnings, 0 4xx/5xx, 0 CORS, no localhost** |
| Commit / push | **DONE** — `5929827` pushed to `origin/main`; report reconciliation in a follow-up docs commit |
| Production deployment | **NONE** |
