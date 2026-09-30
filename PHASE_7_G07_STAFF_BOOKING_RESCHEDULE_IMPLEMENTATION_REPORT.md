# G-07 — STAFF BOOKING RESCHEDULE IMPLEMENTATION REPORT

Execution-scope authorized by the operator: **Option B (minimal endpoint
correction)** and **Implement + test locally**. Staging, browser and production
were explicitly out of scope and are therefore reported `UNPROVEN`, not `PASS`.

Final status at the bottom follows the spec §23 rule; it is **NOT PROVEN**
because the mandatory staging/browser gates were not exercised in this scope.
That is a scope boundary, not a hidden failure — every gate that *was*
authorized passed with real runtime evidence.

---

## 1. Executive summary

The staff `reschedule-booking` Edge Function was non-functional: it wrote two
`bookings` columns (`rescheduled_at`, `rescheduled_by`) that no migration
creates and that the generated schema does not contain, so the canonical update
path failed at the database. There were also zero staff callers — no API
wrapper, no UI action, no real-HTTP integration test — even though the patient
WhatsApp reschedule flow was already proven and working.

G-07 corrected the endpoint to mirror the **proven WhatsApp semantics** (mark
the original booking `rescheduled`, create a new token-bearing booking through
the canonical `create_booking` RPC, preserving fee snapshots, audit and
notification), and surfaced it through a role-gated staff action on the booking
detail screen. The whole vertical — backend, types, API wrapper, UI — is now
exercised over real HTTP against a running local Supabase stack.

**Certification for this scope:** INTEGRATION VERIFIED locally. NOT PROVEN for
staging / browser / production.

## 2. Original defect

- Patient / WhatsApp reschedule: works (canonical flow updates only
  `bookings.status = 'rescheduled'`).
- Staff `reschedule-booking`: broken. Its `.update()` wrote
  `rescheduled_at` and `rescheduled_by`, columns that do not exist. A caller
  reaching that write would hit a schema error (Postgres 42703 → surfaced as a
  500-class failure), so no staff actor could reschedule a booking.
- No frontend caller, no staff API wrapper, no staff UI action, and no
  real-HTTP integration test existed for the staff endpoint.

## 3. Root cause

`supabase/functions/reschedule-booking/index.ts` assumed a `rescheduled_at` /
`rescheduled_by` metadata convention that the `bookings` table never had. The
generated schema (`_shared/database.generated.ts`) exposes `cancelled_at`,
`cancellation_reason`, `carry_forwarded_from`, `is_carry_forward` for the
cancellation/carry-forward concepts, but **no `rescheduled_*` column and no
`*_by` author-column convention at all** — the acting user is recorded in the
audit log (`actor_user_id`), and `cancelled_at` is trigger-maintained. The same
`rescheduled_at` bug had previously been fixed on the WhatsApp flow by removing
the column write (PHASE_1.1 precedent), which is exactly the Option-B remedy
reapplied here.

## 4. Files changed

| File | Op | Δ | Purpose |
| --- | --- | --- | --- |
| `supabase/functions/reschedule-booking/index.ts` | modify | −2 | Remove the two nonexistent-column writes (the fix) |
| `apps/web/src/types/api.ts` | modify | +22 | `RescheduleBookingRequest` / `RescheduleBookingResponse` |
| `apps/web/src/api/reschedule.ts` | new | 35 lines | Staff API wrapper (mirrors `cancellations.ts`) |
| `apps/web/src/routes/BookingDetail.tsx` | modify | +193 | Role-gated reschedule action + confirm panel |
| `apps/web/src/api/reschedule.test.ts` | new | 97 lines | Unit tests for the wrapper contract |
| `apps/web/src/routes/BookingDetail.test.tsx` | modify | +189 | Unit tests for the reschedule surface |
| `tests/integration/reschedule_booking.test.ts` | new | 732 lines | Real-HTTP integration suite (13 tests) |

Pre-existing dirty files in the working tree (`PHASE_7_G06_*.md`, two
`verify_reports_*.png`) are **not** G-07 artifacts and were left untouched.

## 5. Migration details

**None required.** Option B deliberately avoids a migration. No schema object,
grant, RLS policy or `SECURITY DEFINER` function was created or altered, so the
F16-04 default-privilege concern (a new/resignatured SECURITY DEFINER function
needing its own explicit `REVOKE`) is not triggered. `validate:migrations`
passes unchanged (0 errors, 4 pre-existing `[duplicate-objects]` warnings that
predate this work).

## 6. Backend changes

The only behavioral change is the canonical status update:

```ts
.update({
  status: "rescheduled",
  updated_at: new Date().toISOString(),
})
.eq("id", body.bookingId)
.eq("status", current) // optimistic guard → 0 rows ⇒ ConcurrencyError
```

(`rescheduled_at: new Date().toISOString()` and
`rescheduled_by: auth.userId` were removed.) Everything else is preserved
unchanged: `requireRole([receptionist, hospital_admin, global_admin])`, the
`X-Hospital-ID` header requirement, the `orig.hospital_id !== hospitalId ⇒
ForbiddenError` tenant check, the date/same-day/window/holiday/working-hours
validations, the doctor-availability RPC, the `withIdempotency` wrapper, the
`create_booking` RPC call carrying the original fee snapshots +
`p_idempotency_key`, the `carry_forwarded_from` link, the `enqueue_job`
WhatsApp notification (`wa_reschedule_<newBookingId>`), and the
`logAuditEvent(actionType: "booking_status_change", actorUserId)`. The acting
user is now captured in the audit log — the platform's canonical place for it —
rather than a nonexistent column.

## 7. Frontend changes

- **Types:** `RescheduleBookingRequest { bookingId; newDate; newDoctorId?;
  reason? }` and `RescheduleBookingResponse { originalBookingId; newBookingId;
  newTokenNumber; newDate }`.
- **API wrapper** (`api/reschedule.ts`): calls
  `callFunction("reschedule-booking", body, { hospitalId, idempotencyKey })`,
  minting a fresh UUID-v4 idempotency key. Tenant is supplied via the
  `X-Hospital-ID` header, never the body.
- **UI** (`routes/BookingDetail.tsx`): a `Reschedule` card gated by
  `RESCHEDULE_ROLES = [receptionist, hospital_admin, global_admin]` **and**
  `RESCHEDULABLE_STATUSES = [booked, checked_in, waiting]` (render gate only —
  never the security boundary). Uses the shared `useAsyncAction` hook (one
  reused key per logical action so a retry replays safely), a date-only body,
  an optional reason, a success banner ("Rescheduled to … · new token …"),
  honest error surfacing, and refetch-after-mutate (no optimistic local state).

## 8. Authorization / security behavior

Server-side authorization is unchanged and is the real boundary: `resolveAuth`
+ `requireRole` reject non-staff roles, and the tenant check rejects a booking
from another hospital before any write. Proven over real HTTP:

- doctor staff token calling the endpoint → denied (403/401).
- hospital-A admin, header = A, targeting a hospital-B booking → **403
  FORBIDDEN with no mutation** (original booking still `booked`).
- missing `X-Hospital-ID` header → rejected.

No secret is hardcoded; no client-supplied hospital ID is trusted.

## 9. Financial boundary

Reschedule never mutates immutable financial records. The new booking inherits
the **original fee snapshots** verbatim via `create_booking`
(`platform_fee_snapshot = 25`, `receptionist_fee_snapshot = 10`,
`hospital_fee_snapshot = 270` in the integration fixture), and the original
booking becomes terminal (`rescheduled`). No ledger, refund or settlement row is
hand-edited. Proven in the success integration test.

## 10. Idempotency / concurrency behavior

- **Idempotency:** `withIdempotency` + `create_booking(p_idempotency_key)`.
  Replaying the same UUID-v4 key returns the cached original result and creates
  **no second booking** (`carry_forwarded_from` count stays 1). Proven.
- **Concurrency:** the optimistic `.eq("status", current)` guard means a second
  concurrent reschedule on the same booking gets **0 updated rows →
  ConcurrencyError → 409**. Two simultaneous requests produced exactly one 200
  and one 409, and exactly one new booking. Proven.
- Note (test-harness lesson): the endpoint's `extractIdempotencyKey` requires a
  **UUID v4**; a non-UUID key throws `IDEMPOTENCY_KEY_REQUIRED` (400) before
  role checks. The frontend already mints UUID-v4 keys, and the integration
  tests were corrected to match.

## 11. Test results (one targeted run each)

| Gate | Command | Result |
| --- | --- | --- |
| Migration validation | `deno task validate:migrations` | **0 errors**, 4 pre-existing warnings |
| Typecheck (Deno) | `deno task check` | **exit 0** |
| Lint (reschedule files) | `deno lint` | **0 problems** |
| Format (reschedule files) | `deno fmt --check` | **0 unformatted** |
| Deno unit tests | `deno task test` | **97 passed, 0 failed** |
| Frontend typecheck | `npm run typecheck` (apps/web) | **exit 0** |
| Frontend unit tests | `npm run test` (vitest) | **235 passed, 21 files** (see §18) |
| Staff reschedule integration | `deno test …/reschedule_booking.test.ts` | **13 passed, 0 failed** |
| WhatsApp regression | `deno test …/whatsapp_conversational.test.ts` | **28 passed, 0 failed** |

## 12. Real HTTP evidence

The integration suite issues real `fetch` calls to
`http://127.0.0.1:54321/functions/v1/reschedule-booking` with real GoTrue
access tokens (admin-created users + password grant). Nothing is mocked;
`resolveAuth`, `requireRole`, `withIdempotency` and `create_booking` are the
production primitives. The success leg asserted **HTTP 200** and then verified
the resulting database state. The Edge Runtime container
(`supabase_edge_runtime_setura`) was confirmed `Up` and restarted before the
run so it served the corrected source; the 200/409/403/422 outcomes prove the
new code path executed.

## 13. Local runtime evidence

Against the running local stack the corrected endpoint produced, in the real
database:

- original booking `status = rescheduled`;
- a **new booking** with a fresh token, `status = booked`,
  `appointment_date = newDate`, fee snapshots preserved,
  `carry_forwarded_from = originalId`, and (when no new doctor is sent) the
  original `assigned_doctor_id`;
- exactly **1** `audit_logs` row (`action_type = booking_status_change`);
- exactly **1** `job_queue` row (`idempotency_key = wa_reschedule_<newBookingId>`,
  `job_type = send_whatsapp_message`) — enqueued, not delivered.

Rejections produced their documented error codes with no side effects:
invalid state / past / same / too-far → `VALIDATION_ERROR` (422); holiday →
`HOSPITAL_CLOSED` (422); doctor without a schedule → `DOCTOR_UNAVAILABLE`
(422).

## 14. Staging evidence

**NOT PERFORMED / UNPROVEN.** The authorized scope was local-only. No staging
deployment was touched, so no staging runtime or browser evidence exists.

## 15. Browser evidence

**NOT PERFORMED / UNPROVEN.** No controlled staging browser walkthrough of the
new `Reschedule` UI was executed in this scope. The UI is proven only by
component unit tests (jsdom), not by a real browser against a deployed stack.

## 16. Regression results

- **WhatsApp reschedule flow:** unchanged by this work (the fix touched only the
  staff endpoint). `whatsapp_conversational.test.ts` ran **28/28**, including
  all five `wa reschedule` cases (success, doctor unavailable, hospital closed,
  invalid date re-prompt, concurrent-cancellation abort) and the cancel cases.
- **Full frontend suite:** the reschedule tests pass alongside the existing
  cancellation / status-closure / payment-badge suites.
- **Deno unit suite:** 97/97.

## 17. Git commit

**No commit created.** Per the operating contract, a commit happens only on
explicit authorization, which this task did not include. The working tree is a
Git repository (contrary to the older AGENTS.md §13 note); the G-07 changes are
present as tracked-file edits plus new untracked files, and were verified by
direct `git diff` / file inspection.

## 18. Known limitations

- **Frontend vitest under parallel load:** the default parallel `npm run test`
  reported 16 failures — **all `Test timed out in 5000ms`**, scattered across
  files unrelated to G-07 (AdminCommandCentre, AdminReports, BookingForm,
  AdminAudit) and the pre-existing cancellation tests. This is resource
  contention (suite wall-clock 220s; the "failing" tests run in ~0.3–0.7s in
  isolation), **not a logic defect**. Proof: `BookingDetail.test.tsx` +
  `reschedule.test.ts` run in isolation → **58/58 passed**; the full suite with
  `--no-file-parallelism` → **235/235 passed** in 34s. The 5s default
  `testTimeout` is tight for this loaded Windows runner and is a CI-hygiene
  consideration, not a G-07 product issue.
- Local-only certification; staging/browser/production unproven (§14, §15, §19).

## 19. Production status

**NOT PROVEN.** No production deployment exists or was performed. Nothing here
certifies production behavior.

## 20. Final acceptance matrix

| Requirement | Evidence | Status |
| --- | --- | --- |
| Schema correct | No migration needed; generated schema has no `rescheduled_*`; fix removes the writes; `validate:migrations` 0 errors | **PASS** (static + integration) |
| Endpoint works | Real HTTP 200 + DB state, 13/13 integration | **PASS** (local, INTEGRATION VERIFIED) |
| Staff UI works | Component unit tests only (jsdom); no browser walkthrough | **UNPROVEN** (browser not in scope) |
| Role isolation | Integration: doctor denied; wrapper/UI role gates unit-tested | **PASS** (local integration) |
| Tenant isolation | Integration: cross-hospital → 403, no mutation | **PASS** (local integration) |
| Idempotency | Integration: replay → same result, 0 extra bookings | **PASS** (local integration) |
| Concurrency | Integration: 200 + 409, one new booking | **PASS** (local integration) |
| Audit | Integration: exactly 1 `booking_status_change` | **PASS** (local integration) |
| Notification | Integration: exactly 1 `wa_reschedule_*` job enqueued (enqueue ≠ delivery) | **PASS** (local integration) |
| Regression | WhatsApp 28/28; Deno unit 97/97; FE 235/235 (sequential) | **PASS** (local) |
| Staging | Not performed (out of authorized scope) | **BLOCKED / UNPROVEN** |

---

```text
G-07:
NOT PROVEN
```

Rationale (spec §23): the implementation and its local integration proof are
complete and green, but the mandatory **staging** and **browser** gates were not
exercised under the authorized local-only scope. Partial implementation must not
be converted into completion, so the phase is `NOT PROVEN`, with the local
vertical (backend + types + API + UI + integration + regression)
`INTEGRATION VERIFIED`.
