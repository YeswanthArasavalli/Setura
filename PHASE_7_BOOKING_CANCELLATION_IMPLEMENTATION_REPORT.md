# PHASE 7 — Booking Cancellation Control Surface — Implementation Report

Scope executed: *Frontend-only Implementation + Local Proof*.
All classifications below use the vocabulary mandated by the task specification
(`PROVEN`, `IMPLEMENTED`, `PROVEN LOCAL`, `PROVEN STAGING`, `NOT OBSERVED`,
`NOT TESTED`, `BLOCKED`, `UNPROVEN`, `NOT IMPLEMENTED`, `DEFERRED BY OWNER`,
`STALE / RESOLVED`). A local runtime result is never reported as production
verification.

---

## 1. Objective

Expose the already-shipped `cancel-booking` Edge Function to the staff roles
that are permitted to use it, and make a cancellation's *outcome*
(`cancellation_reason`, `cancelled_at`) visible in the staff console — without
touching backend logic, financial policy, the booking state machine, RLS or
migrations.

Classification: **IMPLEMENTED** (frontend), **PROVEN LOCAL** (mutation path).

## 2. Baseline

| Item | Value |
| --- | --- |
| `git branch --show-current` | `main` |
| `git rev-parse HEAD` | `037bcf10c8387452ed7d8dc9c60a83b7f7052f62` |
| `git rev-parse origin/main` | `037bcf10c8387452ed7d8dc9c60a83b7f7052f62` |
| `git status --short` before work | 6 untracked `PHASE_7_*.md` reports only; no tracked modifications |

Baseline matched the expected commit exactly.

**Environment deviation discovered and corrected.** `docker ps` showed 11
Supabase services up, but `docker ps -a` showed
`supabase_edge_runtime_setura  Exited (255) 12 hours ago` — the documented
F16-01 failure mode (`RestartPolicy=no`: the Edge Runtime does not self-heal,
and `supabase start` exiting 0 is not proof it is running). Started with
`docker start supabase_edge_runtime_setura`; confirmed `Up` before and during
the HTTP proof run. This is a **local environment change**, not a product
change.

## 3. Source reconciliation

Read before writing code, to follow existing conventions rather than invent
parallel ones: `apps/web/src/lib/api.ts` (`callFunction`, `ApiEnvelope`,
`ApiError`), `lib/idempotency.ts` (`newIdempotencyKey`), `hooks/useAsyncAction.ts`,
`lib/errors.ts` (`describeError`), `api/booking.ts`, `api/reads.ts`,
`lib/paymentStatus.ts`, `lib/notificationStatus.ts`, `auth/context.ts`,
`auth/AuthProvider.tsx`, `types/api.ts`, `routes/BookingDetail.tsx`,
`routes/ReceptionDashboard.tsx`, `routes/QueueBoard.tsx`, `routes/Patients.tsx`,
`App.tsx`, `ui/{button,badge,input,label}.tsx`, and the existing
`BookingDetail.test.tsx` / `reads.test.ts`.

Conventions reused, not re-created: `callFunction` (JWT + `apikey` +
`X-Hospital-ID` + optional `Idempotency-Key`), `useAsyncAction` (one stable
idempotency key per logical submission), `describeError` (kind-mapped safe
copy), the `paymentStatus.ts` presentation-helper shape (label + Badge variant,
zero business logic), and the vitest + Testing Library test style already in
`BookingDetail.test.tsx`.

Classification: **PROVEN** (by direct source inspection).

## 4. Backend dependency verification

`supabase/functions/cancel-booking/index.ts` was read, **not modified**:

| Contract fact | Evidence (in file) |
| --- | --- |
| Request schema `bookingId` (uuid) · `cancellationReason` (3–500) · `initiateRefund` (default `false`) | zod body schema |
| Roles: `requireRole(auth, ["receptionist","hospital_admin","global_admin"])` — doctors excluded | line 8 import + role guard |
| Uncancellable/terminal states `completed`, `no_show`, `rescheduled` | `UNCANCELLABLE`, lines 206–219 → `ValidationError` |
| Already-cancelled returns 200 `{bookingId, cancelled:true, alreadyCancelled:true}` and **omits** `refundInitiated` | lines 191–204 |
| Optimistic concurrency: `.eq("id", …).eq("status", current)`; no matched row ⇒ `ConcurrencyError` | lines 226–261 |
| Refund is only a *request* through the existing `initiate_refund` RPC, only when `payment_completed` and `booking_fee_inr > 0` | lines 263–300 |
| Queue recalculation is best-effort, warns on failure | lines 320–338 |
| WhatsApp enqueue: `enqueue_job` `send_whatsapp_message`, `template_name: "booking_cancelled"`, `p_idempotency_key: \`wa_cancel_${bookingId}\`` | lines 340–378 |
| Audit action `booking_cancel` | audit call |

Classification: **IMPLEMENTED / INTEGRATION VERIFIED** (pre-existing backend,
exercised over real HTTP — see §14).

## 5. Files changed

Tracked modifications (6 files, **+684 / −7**):

| File | Change |
| --- | --- |
| `apps/web/src/types/api.ts` | +24: `CancelBookingRequest`, `CancelBookingResponse` (`refundInitiated?: boolean`) |
| `apps/web/src/api/reads.ts` | +6/−2: `BookingRow.cancellation_reason`, `BookingRow.cancelled_at`, both added to `BOOKING_SELECT` |
| `apps/web/src/routes/BookingDetail.tsx` | +255: role-gated cancellation action, confirm surface, outcome card, post-attempt notice |
| `apps/web/src/routes/ReceptionDashboard.tsx` | +15/−4: one `Cancelled` stat, `sm:grid-cols-5`, decision comment |
| `apps/web/src/routes/BookingDetail.test.tsx` | +366: 12 cancellation tests (27 static `it`/`it.each` declarations in file) |
| `apps/web/src/api/reads.test.ts` | +25: booking read-projection test |

New files (4):

| File | Contents |
| --- | --- |
| `apps/web/src/api/cancellations.ts` | 31 lines — typed `cancelBooking()` |
| `apps/web/src/lib/cancellationStatus.ts` | 115 lines — presentation-only helper |
| `apps/web/src/api/cancellations.test.ts` | 117 lines — 4 tests |
| `apps/web/src/lib/cancellationStatus.test.ts` | 146 lines — 9 tests |

Zero files changed under `supabase/` (`git status --porcelain supabase/`
empty). Classification: **PROVEN** by `git diff --stat`.

## 6. Cancellation API implementation

`api/cancellations.ts` is a thin typed boundary: it forwards exactly the three
backend fields through the existing `callFunction("cancel-booking", …)` with
`hospitalId` (→ `X-Hospital-ID`) and an `Idempotency-Key` from
`newIdempotencyKey("cancel-booking")` (bare UUID v4, as the backend requires).
No new HTTP client, no `service_role`, no direct browser table mutation, no
retry loop. Classification: **IMPLEMENTED**, unit-covered (§13, item A).

## 7. Booking read projection

`reads.ts` `BookingRow` gained `cancellation_reason: string | null` and
`cancelled_at: string | null`, and the module-private `BOOKING_SELECT` string
now selects both. This extends the *existing* single booking read — no new
query, no new table, no RLS change, no service-role path. Both values are
rendered only as persisted by the database; the client derives nothing.
Classification: **IMPLEMENTED** + **PROVEN LOCAL** (the same columns were read
back from the real local DB in §14).

## 8. Cancellation UI

`BookingDetail.tsx` renders one cancellation card that carries both the action
and the outcome:

- Action is offered only when the viewer's role is in
  `["receptionist","hospital_admin","global_admin"]` **and**
  `canOfferCancellation(row.status)`; it is hidden for
  `completed` / `no_show` / `rescheduled` / `cancelled`.
- `Cancel booking` (destructive) opens an explicit confirmation surface with a
  labelled `<textarea>` reason, a live `role="alert"` validation message, an
  optional refund checkbox, `Confirm cancellation` (disabled while running or
  while the reason is server-invalid) and `Keep booking`.
- Exactly three fields are sent. No status is computed, no fee is computed.
- **No optimistic write.** After any attempt the page refetches the row and
  renders the database state; the booking is never blanked and the typed reason
  is preserved when a submission is rejected so the user can retry.
- `alreadyCancelled` is treated as success ("Cancellation already completed").
- Concurrency / validation / forbidden failures surface through `describeError`.
- The free-text reason is rendered as plain React text with
  `break-words whitespace-pre-wrap` — never `dangerouslySetInnerHTML`, never in
  the console, URL, telemetry or an error string.

Classification: **IMPLEMENTED**, unit/component-covered (§13, items B–J).

## 9. Refund gating

`mayOfferRefund(row)` = `row.payment_completed === true && (row.booking_fee_inr ?? 0) > 0`.
The checkbox is therefore hidden for unpaid bookings, zero-fee bookings and
rows whose fee is `null` (null is not zero — same discipline as
`paymentStatus.ts`). It is unchecked by default, its value is sent as a
boolean, and **no amount is ever rendered, computed or submitted**; the copy
states that the backend decides whether a refund is made and for how much.
`refundOutcomeLabel()` renders `refundInitiated === true` as "Refund
initiated", `false` as "No refund requested", and an absent field as "Refund
outcome not reported for this booking" — the word *completed* is never used.
Classification: **IMPLEMENTED**.

## 10. Cancellation outcome display

`cancellationOutcome(row)` is non-null only when `status === "cancelled"` and
carries exactly what the backend stores: the verbatim reason and the
timestamp. Missing reason renders "No cancellation reason was recorded." The UI
does **not** fabricate a cancelling user, a refund amount, a refund timestamp,
a WhatsApp delivery status or any other unreported field.
Classification: **IMPLEMENTED**.

## 11. Role authorization

The frontend role list is a **render convenience only** and is never a security
boundary: `requireRole()` inside `cancel-booking` remains authoritative, and a
doctor who hand-crafts a request is still refused server-side. The helper is
deliberately fail-open for an unknown future status (the server re-validates
state on every call), matching the reasoning already used in
`notificationStatus.ts`. Classification: **IMPLEMENTED** (UI gate) /
**PROVEN** (backend gate exists in source; role refusal itself is existing
backend behavior covered by the integration suite, not re-proven here).

## 12. Tenant safety

No route- or store-supplied hospital id is trusted: `hospitalId` comes from
`useAuth()`, is sent as `X-Hospital-ID` by `callFunction`, and the backend
compares it against the booking's own hospital. RLS remains the enforcement
boundary for the read path. Cross-tenant cancellation was exercised against the
real stack (§14, items 15–17). Classification: **PROVEN LOCAL**.

## 13. Unit / component tests

Vitest + Testing Library, mocking only the API/auth boundaries; real dispatch,
RLS and financial behavior stay owned by the integration suite.

| Spec item | Test | Result |
| --- | --- | --- |
| A — API builder | `cancellations.test.ts`: function name, exact 3-field body, key→value-type mapping, supplied vs. minted UUID key | pass |
| B — role visibility | `it.each` over the 3 allowed roles offers the control; doctor does not, and the booking is still visible | pass |
| C — terminal states | loop over `completed` / `no_show` / `rescheduled` / `cancelled` offers nothing | pass |
| D — reason validation | 0 / 2 chars rejected with `role="alert"` + disabled confirm; 3 / 200 / 500 accepted; 501 rejected | pass |
| E — refund gating | all four `payment_completed` × `booking_fee_inr` combinations, plus unchecked default | pass |
| F — no refund calculation | submitted keys don't match `/amount\|fee\|inr\|hospital/i`; no `number`-typed value in the body | pass |
| G — successful cancellation | refetch happens (`getBooking` called twice), local row object never mutated, no optimistic `status` | pass |
| H — `alreadyCancelled` | treated as success, no `role="alert"`, and "Refund outcome not reported…" — never "No refund requested" | pass |
| I — error path | 409 `ApiError` surfaced via `describeError`, booking stays visible, status unchanged locally, retry still possible | pass |
| J — outcome after refetch | reason + timestamp render from the refetched row; control disappears | pass |
| K — read projection | `reads.test.ts`: `select` contains `status`, `cancellation_reason`, `cancelled_at`; no secret-like column | pass |
| §8 free-text safety | `<b>not bold</b> & cancelled` renders as text; `document.querySelector("b")` is `null` | pass |

Whole-web suite: **11 files / 116 tests passed, 0 failed** (baseline at HEAD:
9 files / 68 tests). Classification: **PROVEN** for frontend behavior under
test. No pre-existing test was deleted, skipped or weakened; two of my own new
assertions were corrected after they were shown to be wrong (a self-inflicted
assertion that matched the legitimate `initiateRefund` key, and an ambiguous
`getAllByText("waiting")`).

## 14. Local integration proof

Mechanism: the existing integration suite over the **real HTTP Edge Function
path** — `fetch(${API_URL}/functions/v1/cancel-booking)` through Kong with a
real receptionist JWT from the Auth service (`tests/utils/setup_env.ts` →
`http://127.0.0.1:54321`), local seeded tenants only. No job was inserted by
hand, no bypass of `cancel-booking`, and no direct DB write to simulate the
mutation. Then read-only `psql` against the local container for the columns the
tests do not themselves assert.

| # | Requirement | Evidence | Class |
| --- | --- | --- | --- |
| 1 | cancellable local booking | `E1 07` `create-booking` → 201, booking `3c11f1f1-d099-457c-a58b-68f3f2525a79` | PROVEN LOCAL |
| 2 | real Edge Function call, receptionist JWT | `cancel-booking` via HTTP with `tokens.receptionA` | PROVEN LOCAL |
| 3 | HTTP success | `status === 200` asserted in-test | PROVEN LOCAL |
| 4 | DB status `cancelled` | `bookings.status = 'cancelled'` (test + psql) | PROVEN LOCAL |
| 5 | `cancellation_reason` stored | psql: `e1 journey cancel 2790944` (verbatim) | PROVEN LOCAL |
| 6 | `cancelled_at` populated | psql: `2026-09-24 17:10:00.531856+00` | PROVEN LOCAL |
| 7 | replay cancellation | second `cancel-booking` call | PROVEN LOCAL |
| 8 | `alreadyCancelled = true` | `replay.data.alreadyCancelled === true`, HTTP 200 | PROVEN LOCAL |
| 9 | no duplicate state transition | exactly **1** `audit_logs` row `booking_cancel` for the booking (`17:10:00.615768`), and 1 `booking_create` | PROVEN LOCAL |
| 10 | cancelled token not callable | `call_queue_token` → `{ok:false, reason:"token_not_callable"}`; row still `cancelled` | PROVEN LOCAL |
| 15 | foreign-tenant booking id | `S1 04` receptionist A → booking B | PROVEN LOCAL |
| 16 | Forbidden behavior | `S1 04` asserts 401/403 | PROVEN LOCAL |
| 17 | no cross-tenant mutation | `S1 04` re-reads B: `status` and `cancelled_at` unchanged, and **no new** `audit_logs` row for the victim | PROVEN LOCAL |

Targeted run: `deno test tests/integration/hospital_core_journey.test.ts
tests/integration/security_s1.test.ts` → **33 passed / 0 failed**.
Full suite (§18) → **246 passed / 0 failed**.

## 15. WhatsApp enqueue evidence

Same cancelled booking, read-only psql against `job_queue`:

| Column | Value |
| --- | --- |
| `job_type` | `send_whatsapp_message` |
| `payload->>'template_name'` | `booking_cancelled` |
| `idempotency_key` | `wa_cancel_3c11f1f1-d099-457c-a58b-68f3f2525a79` (= `wa_cancel_${bookingId}`) |
| `status` | `pending` |
| `attempt_count` | `0` |
| `worker_id` / `lease_expires_at` / `processing_started_at` | all `NULL` |
| `last_error` | `NULL` |

(The booking also carries its pre-existing `wa_confirm_…` confirmation job,
equally `pending` — enqueue count for this booking is exactly one per event,
which is the behavior `E1 13` pins.)

**Not delivered / no outbound request:** the job was never claimed or processed
(`pending`, 0 attempts, no worker/lease); `whatsapp_messages` has **0** rows for
this booking and its latest pre-existing row overall is `2026-09-22
10:49:47+00`, i.e. before this run (`2026-09-24 17:10+00`);
`notification_deliveries` is empty (0 rows) and `notification_queue` has 0 rows
for the booking; and the Edge Runtime container exposes **no** `META_*` (nor
`RAZORPAY_*` / `CRON_*` / `WORKER_*` / `ENABLE_*`) environment key names —
verified by listing key names only, never values. There is therefore no local
delivery path, and R1's hazard cannot materialise locally.

Classification: enqueue **PROVEN LOCAL**; non-delivery **PROVEN LOCAL**;
"Meta would have received nothing" is by construction/environment, so the
positive statement *a real deployment with credentials behaves this way* is
**UNPROVEN**.

## 16. Idempotency / replay evidence

Two independent layers were observed, not assumed: the client mints one key per
logical submission via `useAsyncAction` + `newIdempotencyKey` (unit-tested), and
the backend's own already-cancelled short-circuit returns HTTP 200 with
`alreadyCancelled: true` while writing nothing — proven by 1 (not 2)
`booking_cancel` audit events and an unchanged `cancelled_at` (§14 items 7–9).
The response-shape asymmetry discovered in source (`refundInitiated` omitted on
replay) is modelled in the type as optional and rendered as "not reported".
Classification: **PROVEN LOCAL**.

## 17. Concurrency / error handling

The backend's optimistic `.eq("status", current)` guard and its
`ConcurrencyError` are pre-existing and untouched. The frontend does not
optimistically mutate status, so a concurrent transition is surfaced rather than
overwritten: a 409 `ApiError` renders through `describeError`, the booking card
stays visible, the local row keeps its old status, the confirm surface stays
open with the typed reason intact, and a retry is possible. Unit-covered; the
server-side race itself is existing backend behavior.
Classification: **IMPLEMENTED** (frontend) / **NOT TESTED** as a live
two-writer race against the real stack.

## 18. Regression results

Frontend (`apps/web`):

| Command | Result |
| --- | --- |
| `npm run typecheck` (`tsc --noEmit`) | clean |
| `npm test` | 11 files / 116 tests passed, 0 failed (19.28s) |
| `npm run build` | built — `dist/index.html` 0.43 kB, `dist/assets/index-CmMflCI0.css` 13.95 kB, `dist/assets/index-De4OX1oG.js` 467.63 kB (gzip 133.05 kB) |

Repository (`deno.json` task authority):

| Task | Result |
| --- | --- |
| `deno task test:integration` | **246 passed / 0 failed** (2m17s) |
| `deno task test` (unit) | 97 passed / 0 failed |
| `deno task lint` | clean, 95 files checked |
| `deno task check` | clean |
| `deno task validate:migrations` | 63 files, **0 errors**, 4 pre-existing `[duplicate-objects]` baseline warnings |
| `deno task fmt:check` | **FAILS on 1 file — pre-existing**: `tests/integration/consultation_notes_read.test.ts` ("Found 1 not formatted file in 161 files"). Tracked and unmodified in this task (`git status` clean for it), so it is unformatted at the baseline commit. `deno fmt` was **not** run: it rewrites files and this task does not authorize that. |

Two notes, recorded rather than acted on:

1. `deno.json` excludes `apps/` and `**/*.md` from `fmt`/`lint`, so no file this
   task changed is inside Deno's formatting scope; the frontend's own tooling
   (tsc + vitest + vite) is green.
2. The AGENTS.md §13 baseline line "`fmt:check` fails on exactly 8 root markdown
   files" no longer matches the measured state (markdown is excluded; the single
   remaining failure is the Deno test file above). Documentation staleness, not
   a product defect — **not** edited here.

The structured `error`/`warn` JSON lines in the integration log
(`w1 deterministic failure`, `invalid JWT: … token is malformed`) are the
*expected* negative-path logs of the worker-failure and
malformed-credential tests; the Deno summary line is authoritative.

## 19. Secret scan

`deno run --allow-read scripts/check_frontend_secrets.ts apps/web/dist
--deny-sourcemaps` → "Frontend secret scan: 3 artifact(s) in dist, **0 source
map(s)** … Result: **0 secret hit(s)**, 0 source map(s) (sourcemaps denied)".
No secret, token or key was introduced in any changed file; no `.env` was
created or committed. Classification: **PROVEN** for the local build output.

## 20. Staging status

Nothing was deployed and nothing on staging was touched in this phase. No
staging booking was created or cancelled, no staging record was mutated, and no
fake notification data was written. The already-cancelled staging read-back
permitted by §13 was **NOT OBSERVED** — no such record was inspected — and is
therefore recorded as **NOT TESTED**, not as a pass.
Classification: staging mutation **NOT TESTED (deliberately)**; staging
read-back **NOT TESTED**.

## 21. R1 handling

R1 is the escalated risk that a cancellation enqueues a real
`send_whatsapp_message` with the `booking_cancelled` template, i.e. a message
to a real patient phone. Handling:

- The mutation was proven **locally only**, against seeded tenants.
- Local non-delivery is evidenced in §15 (job `pending`, no message/delivery
  rows, no `META_*` key in the Edge Runtime environment).
- Staging cancellation was **not** performed and **not** simulated with
  fabricated data.
- **R1 owner authorization required before staging cancellation.** This phase
  stops at that boundary rather than working around it.

Classification: local path **PROVEN LOCAL**; staging/real delivery **BLOCKED BY
R1** (recorded as BLOCKED, never converted to PASS).

## 22. Documentation drift

`apps/web/src/api/reads.ts` header comment (line ~11) asserts that
`payment_ledger` is intentionally not read here and is surfaced only through
Edge Functions / booking snapshot fields. The investigation phase flagged that
statement as stale relative to current finance surface. This task's edit to the
same file added only booking cancellation columns to a different SELECT and
neither relies on nor worsens that claim, so per the phase rules the comment was
left untouched rather than half-corrected without the finance work.

Disposition: **DOCUMENTATION DRIFT — DEFERRED TO C2 FINANCE VISIBILITY PHASE**.
C2 was **NOT IMPLEMENTED** here.

## 23. Out-of-scope items

Not designed, not scaffolded, not stubbed: reschedule control surface, no-show
action, schedule / leave / availability, finance dashboard, refunds list,
settlement UI, audit-log UI, online payment collection, notification retry,
WhatsApp resend, dead-letter actions, D5, D13. No second worker mechanism, no
second state machine, no new Edge Function, no RPC, no migration, no RLS
policy, no SECURITY DEFINER function, no privilege change.
Classification: **NOT IMPLEMENTED** (by design).

## 24. Git status

Feature left **uncommitted**, as required. No `git add .`, no commit, no push,
no `reset --hard`, no `clean -fd`, no force push, no history rewrite.

- Modified (6): `types/api.ts`, `api/reads.ts`, `routes/BookingDetail.tsx`,
  `routes/ReceptionDashboard.tsx`, `routes/BookingDetail.test.tsx`,
  `api/reads.test.ts` — +684 / −7.
- Untracked (4 code files): `api/cancellations.ts`, `api/cancellations.test.ts`,
  `lib/cancellationStatus.ts`, `lib/cancellationStatus.test.ts`, plus this
  report and the 6 pre-existing untracked `PHASE_7_*.md`.
- `git status --porcelain supabase/`: empty — the backend, migrations and
  functions are byte-for-byte unchanged from `037bcf1`.
- Local logs written as evidence artifacts: `_cancel_proof_run.log`,
  `_cancellation_integration_full.log`. Both are covered by the repository's
  `*.log` ignore rule, so they do not appear in `git status`.

## 25. Final classification

| Surface | Classification |
| --- | --- |
| Frontend cancellation control + outcome visibility | **IMPLEMENTED** |
| Frontend unit / component behavior (§10 A–K + free-text safety) | **PROVEN** (vitest, 116/116) |
| Backend cancellation (pre-existing) | **IMPLEMENTED / INTEGRATION VERIFIED** |
| Local mutation: cancel → stored reason + timestamp → replay → queue refusal → cross-tenant denial | **PROVEN LOCAL** |
| Local WhatsApp enqueue + dedupe key + non-delivery | **PROVEN LOCAL** |
| Staging mutation | **NOT TESTED** |
| Staging read-back of an already-cancelled record | **NOT OBSERVED / NOT TESTED** |
| Real Meta / WhatsApp delivery | **BLOCKED BY R1** — owner authorization required |
| Concurrency two-writer race against the live stack | **NOT TESTED** (frontend handling unit-proven) |
| Production | **UNPROVEN** — no deployment performed |
| `reads.ts` `payment_ledger` comment | **DOCUMENTATION DRIFT — DEFERRED TO C2 FINANCE VISIBILITY PHASE** |
| D5 | **DEFERRED BY OWNER** |
| D13 | **DEFERRED BY OWNER** |
| Repository `fmt:check` | **FAIL — PRE-EXISTING**, one Deno integration test file, outside this task's scope |
| This feature | **UNCOMMITTED** by design |

No claim above is strengthened beyond its evidence: local results are not
production results, an initiated refund is not a completed refund, an absent
response field is not a negative decision, and a blocked path is not a pass.
