# PHASE 7 — Payment Status UX Implementation Report

**Phase type:** frontend-only product fix + local validation. Staging deployment
and browser validation were **NOT performed** (see §10 and §15); commit/push was
therefore withheld under the phase's own stop condition.
**Date:** 2026-09-24
**Authoritative investigation:** `PHASE_7_PAYMENT_STATUS_UX_INVESTIGATION_REPORT.md` (not reopened)
**Baseline at start and at end:** `HEAD == origin/main == 449ba1193b116d68bcc62227fc99e98d8c9f3822` (`449ba11`)

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

**NOT PERFORMED — BLOCKED by the phase's own ordering and this project's
deployment topology.**

This project's staging frontend is deployed by its **Git-connected Vercel
project** (`setura`, ref `prj_PZq3TlY28vzz3hF6x0TKpvxK6gMH`, Root Directory
`apps/web`): a push to `main` triggers the cloud build and promotes the
`setura-delta.vercel.app` alias. There is therefore no way to deploy this change
to staging **without** first committing and pushing it — which the stop
condition forbids while browser validation is impossible.

The alternative (root-level CLI upload) was rejected deliberately rather than
left unexplored: running `vercel deploy --prod` from inside `apps/web` is a
known-failing path ("The specified Root Directory 'apps/web' does not exist"),
and the workaround requires staging temporary `.vercel/project.json` and
`.vercelignore` files at the repository root plus a `--prebuilt` upload. That
would place an artifact on the public staging alias that corresponds to **no
commit**, creating deployed-vs-`HEAD` drift that the next legitimate push
silently overwrites — an unacceptable evidence and recovery hazard for a UX
label change. **No Vercel setting, environment variable or project was created
or modified. No `vercel.json` change. Nothing was deployed.**

CLI sanity was checked only: Vercel CLI 59.23.2 is installed; `vercel whoami`
timed out (`Worker timed out after 10 seconds / Failed to spawn get latest
worker`), an environment/tooling condition, not a product one. `apps/web/dist/`
is a local build artifact and is gitignored (untracked-file check confirmed only
the two new `src/lib/` files are pending).

---

## 10. Browser validation

**BLOCKED — cannot be performed in this session.** Browser tooling is
unavailable: the Browser subagent is disabled by the user configuration, and the
`browser-use` MCP bridge had already failed at transport level earlier in this
same session (`Timed out waiting for pipe mcp-28336-556153`, before any request
reached the site). No login, navigation, screenshot or DOM assertion was
obtained, and **no staging browser proof is claimed**.

Additional limitation that a browser alone would not resolve: even with working
browser tooling, the **secondary** states cannot be observed on staging today,
because the read-only staging census (investigation §6) found **0** bookings with
`booking_fee_inr > 0`, **0** paid bookings and **0** payment orders. Fabricating
those rows is out of scope and forbidden. So the observable browser states are:

| State | Classification |
| --- | --- |
| ₹0 unpaid walk-in → "No payment required" | **NOT OBSERVED** (browser BLOCKED); locally **PROVEN** by render tests |
| non-zero unpaid → "Payment pending" | **NOT TESTED** in browser (and no staging row exists to observe) |
| paid → "Paid" | **NOT TESTED** in browser (and no staging row exists to observe) |

Consequently this phase's evidence for correctness is
**unit-verified + statically verified**, deliberately **not**
browser-verified or staging-verified.

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
— unchanged), so it cannot widen exposure. The Tenant A / Tenant B staging check
was **NOT TESTED in this phase** because it requires the browser, which is
BLOCKED; the cross-tenant behaviour it would re-confirm is already established
from the earlier controlled walkthrough (Tenant B sees zero Tenant A rows; a
foreign booking deep-link returns an empty RLS-filtered set with no leak). That
prior evidence is **cited, not reproduced**, and is not upgraded to fresh proof.
**Tenant isolation: PRESERVED BY CONSTRUCTION (PROVEN statically) / runtime
re-verification NOT TESTED.**

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

1. **Browser validation BLOCKED** → no staging visual proof of
   "No payment required"; correctness rests on unit + static verification only.
2. **Staging deployment NOT PERFORMED** → `setura-delta.vercel.app` still serves
   the pre-change bundle; the deployed UI will keep showing "Pending" for ₹0
   bookings until this change is pushed (or otherwise deployed).
3. **Commit/push WITHHELD** by the phase's explicit rule
   ("STOP before commit/push unless the agreed workflow explicitly permits
   committing without browser validation"). This phase was not granted that
   exception, so the working tree carries the change uncommitted.
4. **Non-zero and paid UI states cannot be observed on staging at all** (0 such
   rows exist and none may be fabricated) — permanently
   **NOT OBSERVED / NOT TESTED** for this environment, independent of tooling.
5. **Local Supabase stack was not running** (earlier: `127.0.0.1:54322` refused;
   Docker tooling unreachable), so no local end-to-end render against live data
   was attempted; not required for a pure presentation change.
6. Refund / partial-refund badges remain **out of scope and unimplemented**, as
   decided: they require a new backend read surface. `payment_status_detail`
   still has **no runtime writer** for `not_applicable` / `awaiting_payment`,
   unchanged and deliberately not addressed here.
7. Root-level markdown reports are not `deno fmt`-clean, consistent with the
   documented pre-existing condition; no source file is affected.

To close the remaining gaps in the next session, in order: restore browser
tooling → commit + push to `main` (which is this project's staging deploy path) →
browser-validate the ₹0 walk-in booking on `setura-delta.vercel.app` → record
NOT OBSERVED for the states staging cannot supply.

---

## 16. Git state

**No commit was made and nothing was pushed.** `HEAD` is unchanged from the
pre-flight baseline:

```
$ git rev-parse HEAD
449ba1193b116d68bcc62227fc99e98d8c9f3822
$ git rev-parse origin/main
449ba1193b116d68bcc62227fc99e98d8c9f3822
$ git diff --stat
 apps/web/src/routes/BookingDetail.test.tsx | 107 +++++++++++++++++++++++++++++
 apps/web/src/routes/BookingDetail.tsx      |  17 +++--
 apps/web/src/routes/ReceptionDashboard.tsx |   3 +-
 3 files changed, 122 insertions(+), 5 deletions(-)
$ git diff --check            (no output)
$ git status --short
 M apps/web/src/routes/BookingDetail.test.tsx
 M apps/web/src/routes/BookingDetail.tsx
 M apps/web/src/routes/ReceptionDashboard.tsx
?? PHASE_7_FEE_CONFIGURATION_INVESTIGATION_REPORT.md
?? PHASE_7_LOCAL_ONLINE_PAYMENT_ORDER_VALIDATION_REPORT.md
?? PHASE_7_ONLINE_NONZERO_PAYMENT_ORDER_VALIDATION_REPORT.md
?? PHASE_7_PAYMENT_STATUS_UX_INVESTIGATION_REPORT.md
?? PHASE_7_PAYMENT_STATUS_UX_IMPLEMENTATION_REPORT.md
?? apps/web/src/lib/paymentStatus.ts
?? apps/web/src/lib/paymentStatus.test.ts
```

`HEAD == origin/main == 449ba11` (not ahead, not behind). The change set is
**3 modified + 2 new frontend source files, uncommitted**; the intended commit
message for the authorized follow-up remains
`feat: clarify payment status for zero-fee bookings`. No force push, no rebase,
no history rewrite, no unrelated cleanup was performed.

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
| Staging deployment | **BLOCKED / NOT PERFORMED** |
| Browser validation | **BLOCKED** → **NOT OBSERVED** |
| Non-zero + paid states on staging | **NOT OBSERVED** (no such rows; fabrication forbidden) |
| Tenant isolation runtime re-check | **NOT TESTED** (browser BLOCKED); unchanged code path **PROVEN** statically |
| Commit / push | **NOT PERFORMED** (withheld per stop condition 11) |
| Production deployment | **NONE** |
