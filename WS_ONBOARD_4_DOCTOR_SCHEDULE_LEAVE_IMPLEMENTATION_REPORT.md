# WS-ONBOARD-4 — Doctor, Department, Schedule & Leave Configuration

Implementation report. Objective (spec §1): a newly provisioned hospital must be
able to configure its operational doctor / department / schedule / leave data
entirely through SETURA's authorized frontend, without a developer inserting
rows into PostgreSQL.

---

## 1. Executive outcome

**WS-ONBOARD-4 STATUS: IMPLEMENTED** and locally verified.

The five configuration domains are writable end-to-end through one new Edge
Function (`clinical-configuration`) backed by ten new/rewritten `SECURITY
DEFINER` RPCs (migration 68, plus additive attribution fix in migration 69),
and rendered by one new admin screen at `/admin/clinical-configuration`.
Configured schedules and leave are consumed by the pre-existing availability /
token engine — no parallel model, no fake screen.

Evidence classes for this workstream:

| Surface | Class |
| --- | --- |
| Migration 68 + 69 SQL objects | INTEGRATION VERIFIED (applied to and probed on the real local PostgreSQL) |
| Edge Function over HTTP | INTEGRATION VERIFIED / RUNTIME VERIFIED through the local Edge Runtime container |
| Frontend screen + API client | UNIT VERIFIED (Vitest, 512 suite tests incl. this screen) and build-verified |
| Privilege boundary | INTEGRATION VERIFIED against `pg_proc.proacl` (catalog, not source text) |
| Staging | UNPROVEN (no staging deployment performed — spec §22) |
| Production | UNPROVEN (no production deployment exists) |

---

## 2. Starting architecture

Already present and authoritative before this workstream:

- `departments`, `doctor_departments`, `profiles`, `doctor_schedules`,
  `doctor_leaves` tables with tenancy columns and CHECK / EXCLUDE constraints
  (department + doctor core defined in migration 46
  `doctor_clinical_operations.sql` and neighbours).
- Booking state machine, atomic token engine, queue runtime and the weekly
  `doctor_schedules` / `doctor_leaves` consumption inside the availability RPCs.
- Shared runtime primitives: `getServiceClient()`, `resolveAuth()`,
  `requireRole()`, `logAuditEvent()`, `successResponse()` /
  `handleErrorResponse()` / `handleCors()`, `withIdempotency()` over
  `api_idempotency_keys`, request logger, validation, error hierarchy.
- RLS-as-tenant-isolation, immutable `audit_logs` + `audit_action_types`
  registry, and the `MANIFEST.sha256` append-only migration discipline.
- Frontend: React Router SPA with `AppShell.tsx` role-filtered navigation and a
  shared typed API client layer under `apps/web/src/api/`.

The genuine gap was **not** missing data models. It was that **no privileged
write path existed**: nothing let an authenticated `hospital_admin` create or
edit a department, a doctor profile, a weekly schedule row or a leave row
through the platform. Those rows could previously only appear via manual SQL.

---

## 3. Existing schema discovered

Verified against the live local database (not from migration text):

- **`departments`** — hospital-scoped, `code` unique per hospital, activation
  flag, row-level security. Had **no** browser `SELECT` grant and **no** RLS
  read policy: the admin UI could not even list them.
- **`doctor_departments`** — join table with a `p_department_ids` JSONB
  assignment convention already used elsewhere.
- **`profiles`** — the single canonical doctor identity (role-based). Reused
  as-is; **no second doctor table, no duplicate auth identity** was created.
- **`doctor_schedules`** — weekly template: `weekday` 0–6, `start_time` /
  `end_time` with a CHECK ordering invariant, `max_tokens`,
  `average_consultation_minutes`, `is_active`, and an `EXCLUDE` gist constraint
  rejecting overlapping windows per doctor/weekday.
- **`doctor_leaves`** — date-range leave per doctor with an overlapping-range
  `EXCLUDE` constraint and a status column.
- **`audit_logs` / `audit_action_types`** — `category` CHECK permits
  `'configuration'` (migration 36), so new actions register without schema
  relaxation.
- **`api_idempotency_keys`** — the platform replay store used by
  `withIdempotency`.

**Measured correction to an assumption:** the `EXCLUDE` overlap constraint on
`doctor_schedules` guards active *and* inactive rows. A test premise that an
inactive row would not collide was wrong (measured `23P01`) and the RPC
pre-check was written to match the real constraint, not the assumption.

---

## 4. Existing capabilities reused

| Concern | Reused primitive (not re-implemented) |
| --- | --- |
| Authentication | `resolveAuth(req, headerHospitalId, logger)` |
| Authorization | `requireRole(auth, ["global_admin", "hospital_admin"])` |
| Tenant binding | Existing `X-Hospital-ID` header validation + `hospital_memberships` check; `global_admin` may name a target tenant, `hospital_admin` may not |
| Idempotency | `withIdempotency()` + `api_idempotency_keys` |
| Audit | `logAuditEvent()` + `audit_action_types` registry |
| HTTP envelope / CORS / errors | `successResponse()`, `handleErrorResponse()`, `handleCors()`, shared error hierarchy |
| Validation | Shared Zod schemas from `_shared/validation.ts`, extended locally |
| Doctor identity | `profiles` (existing model) |
| Schedule/leave storage | `doctor_schedules` / `doctor_leaves` (existing tables + existing CHECK/EXCLUDE invariants) |
| Availability consumption | Existing availability / token RPCs that already read `doctor_schedules` and `doctor_leaves` |
| Frontend transport | Existing shared API client conventions, auth header injection, role-filtered `AppShell` nav |

---

## 5. Files created

The working tree is **not a Git repository** (AGENTS.md §13), so this inventory
is by direct file inspection and timestamps.

| File | Size | Purpose |
| --- | --- | --- |
| `supabase/migrations/68_departments_doctors_schedules_leave_configuration.sql` | 1557 lines | Ten configuration RPCs, grants/revokes, RLS read path, audit action-type registration |
| `supabase/migrations/69_doctor_schedule_leave_audit_attribution.sql` | additive | Redefines the two upsert RPCs to return the mutated row id (audit attribution) |
| `supabase/functions/clinical-configuration/index.ts` | 838 lines | The single Edge Function, 9 actions |
| `apps/web/src/api/clinicalConfiguration.ts` | 16.5 KB | Typed API client for the 9 actions |
| `apps/web/src/routes/ClinicalConfiguration.tsx` | 63.7 KB | Admin screen: departments, doctors, doctor↔department, weekly schedules, leave |
| `apps/web/src/routes/ClinicalConfiguration.test.tsx` | 28.3 KB | Frontend behaviour tests |
| `tests/integration/clinical_configuration.test.ts` | 65 KB | 27 RPC/DB tests against the real local stack |
| `tests/integration/clinical_configuration_http.test.ts` | 48 KB | 28 HTTP tests through the real Edge Runtime |

## 6. Files modified

| File | Change |
| --- | --- |
| `supabase/functions/_shared/audit.ts` | Added the new `actionType` union members (`department_create/update/status_change`, `doctor_create/update/status_change`, `doctor_department_assignment`, `doctor_schedule_create/update/delete`, `doctor_leave_create/update/cancel`) |
| `supabase/functions/_shared/database.generated.ts` | Regenerated for migration 68/69 objects (`gen:types`, then `gen:types:check` clean) |
| `apps/web/src/App.tsx` | Mounted route `/admin/clinical-configuration` |
| `apps/web/src/components/AppShell.tsx` | One navigation entry "Clinical Setup", roles `hospital_admin`, `global_admin` |
| `apps/web/src/types/api.ts` | Shared response types for the configuration surface |
| `supabase/migrations/MANIFEST.sha256` | Appended via the canonical `validate:migration-manifest --update` mechanism (append-only tool; 69 lines) |

No closed workstream file (WS-ONBOARD-1/2/3, C2/C2b, G-03…G-11, G7-13, G7-16)
was rewritten; each of their suites remains green (§19).

---

## 7. Database changes

**Migration 68** adds, all `SECURITY DEFINER` with `SET search_path = public`:

- Departments: `create_department`, `update_department` (optimistic-locked),
  `set_department_status`, `assert_department_id_array(JSONB)`.
- Doctors: `create_doctor`, `update_doctor` (activation, department assignment,
  fee-spec edits against `profiles` + `doctor_departments`).
- Schedules: `upsert_doctor_schedule` (create/update discriminator
  `p_schedule_id`), `delete_doctor_schedule`.
- Leave: `upsert_doctor_leave`, `cancel_doctor_leave`.

Every RPC performs its own tenant check (actor membership + target-entity
hospital), raises specific SQLSTATEs (`42501` authorization, `23505` unique,
`23P01` exclusion overlap, plus targeted validation errors), writes through the
existing tables so their CHECK/EXCLUDE constraints remain the last line of
defence, and returns a JSONB result.

Read path: `departments` and `doctor_departments` gained
`ENABLE ROW LEVEL SECURITY`, a hospital-scoped `*_read` policy and
`GRANT SELECT … TO authenticated` — browser-readable, still write-blind.

Privilege boundary per function: `REVOKE ALL … FROM PUBLIC / anon /
authenticated` then `GRANT EXECUTE … TO service_role` only — asserted inside
each migration itself, per F16-04 (a new or resignatured `SECURITY DEFINER`
function needs its own explicit REVOKE and must not rely on a previous
migration's default-privilege behaviour). Verified in the catalog, not from
migration text: `anon_x=f auth_x=f svc_x=t`.

**Migration 69** is the audit-attribution fix, shipped additively (see §20 and
§21). It redefines only `upsert_doctor_schedule` and `upsert_doctor_leave`,
adding `v_id UUID` + `RETURNING id INTO v_id` and the extra result keys
`'schedule_id', coalesce(p_schedule_id, v_id)` /
`'leave_id', coalesce(p_leave_id, v_id)`. Signatures, tenant checks, invariants
and every pre-existing result key are unchanged; it re-asserts its own
REVOKE/GRANT block and the resulting ACL was catalog-verified as still locked.

No destructive DDL. No column was dropped. No existing row was rewritten
back-fill-style.

---

## 8. Edge Function changes

`supabase/functions/clinical-configuration/index.ts` — one new function, nine
actions, all following the canonical flow (spec §4):

```
Frontend → shared API client → clinical-configuration Edge Function
  → resolveAuth() → requireRole(['global_admin','hospital_admin'])
  → X-Hospital-ID / tenant validation → Zod validation
  → withIdempotency() → SECURITY DEFINER RPC → DB invariant
  → logAuditEvent() → server-authoritative response
```

| Action | RPC | Audit action |
| --- | --- | --- |
| `department_create` | `create_department` | `department_create` (entity id from RPC result) |
| `department_update` | `update_department` | `department_update` |
| `department_status_change` | `set_department_status` | `department_status_change` |
| `doctor_create` | `create_doctor` | `doctor_create` |
| `doctor_update` | `update_doctor` | `doctor_update` / `doctor_status_change` / `doctor_department_assignment` |
| `schedule_upsert` | `upsert_doctor_schedule` | `doctor_schedule_create` / `doctor_schedule_update` (id from 69) |
| `schedule_delete` | `delete_doctor_schedule` | `doctor_schedule_delete` |
| `leave_upsert` | `upsert_doctor_leave` | `doctor_leave_create` / `doctor_leave_update` (id from 69) |
| `leave_cancel` | `cancel_doctor_leave` | `doctor_leave_cancel` |

Business rules live in SQL, not in the function: the Edge Function orchestrates
and never re-implements a schedule/leave invariant.

Two function-side corrections were required by measurement:

- **Calendar-date validation.** The shared `DateSchema` only checks
  `!isNaN(Date.parse(d))`, and **Deno's `Date.parse("2026-02-30")` succeeds**,
  best-fit-overflowing to `2026-03-02`. A comment in earlier code claimed the
  opposite and was factually wrong (proved with `deno eval`). Added
  `CalendarDateSchema = DateSchema.refine(...)` performing a string↔Date
  round-trip, with a NaN guard so the genuinely unparseable `2026-13-01`
  (whose `toISOString()` throws `RangeError`) is still reported by the shared
  refine. Both now yield HTTP 422 rather than 500.
- **Audit entity attribution.** `auditPlan` was writing
  `entityId: null` for schedule/leave creates because the RPCs returned no row
  id. Fixed at the source (migration 69) and propagated through the response
  entity, not by loosening the test.

---

## 9. Frontend changes

- `apps/web/src/api/clinicalConfiguration.ts` — typed client for all nine
  actions; reuses the existing fetch/auth client conventions and surfaces the
  server's error codes to the UI. No direct Supabase writes from the browser.
- `apps/web/src/routes/ClinicalConfiguration.tsx` — one admin screen with five
  managed surfaces: departments (create / rename / activate / deactivate),
  doctors (create against `profiles` / edit / assign departments),
  doctor↔department assignment, weekly schedule grid (per weekday windows with
  `max_tokens` and consultation duration), and leave (date ranges + cancel).
  Reads use the new `SELECT`-only RLS path; every write goes through the Edge
  Function. Authoritative state (versions, ids) is re-read from the server
  response rather than guessed client-side.
- Route + navigation registered for `hospital_admin` and `global_admin` only.
- `apps/web/src/types/api.ts` — shared response typing.

---

## 10. Authentication / authorization

Two independent boundaries are maintained (spec §13–§17, AGENTS.md §7):

1. **Edge Function boundary** — `resolveAuth()` then
   `requireRole(["global_admin", "hospital_admin"])`. Verified over real HTTP:
   missing token → 401; wrong role (e.g. `staff`, `patient`) → 403.
2. **Database boundary** — every RPC is `EXECUTE`-granted to `service_role`
   only. `anon` and `authenticated` EXECUTE confirmed absent in
   `pg_proc.proacl`, and the RPCs are unreachable from the browser path.

Role checks at the function layer do **not** make the RPC safe to expose; the
catalog ACL was read back rather than inferred from migration text (F16-04).

---

## 11. Tenant isolation

- Client-supplied hospital ids are never trusted: the `X-Hospital-ID` header is
  validated against the actor's `hospital_memberships` inside `resolveAuth()`;
  a `hospital_admin` may only ever name the hospital they belong to, while a
  `global_admin` names a target tenant explicitly.
- Each RPC re-checks the actor's membership **and** that the target entity
  (department, doctor profile, schedule row, leave row) belongs to the asserted
  hospital, raising `42501` otherwise.
- RLS policies on `departments` / `doctor_departments` scope the new read path
  by hospital.
- Cross-hospital probes are covered by tests: a hospital-B admin operating on a
  hospital-A entity is denied, and the denial does not reveal whether the foreign
  row exists (no existence leakage through differing messages/codes).

---

## 12. Idempotency

All nine mutating actions run inside the platform `withIdempotency()` wrapper
over `api_idempotency_keys`; the Edge Function does not implement its own
replay store and no new HTTP conflict contract was invented.

**Measured contract (documented rather than assumed):** for a
same-key/different-payload reuse, `claim_idempotency_key` computes
`mismatchDetected`, but `withIdempotency()` returns the cached completed
response when `!isNew && status === "completed"`. The **stored 200 is replayed
and the second write is never applied** — verified end-to-end: zero rows for
the second department code, HTTP 200, the replayed `departmentId` equals the
FIRST entity, and exactly one row exists in total. Retry therefore cannot
create a duplicate department, doctor, schedule or leave row, nor a duplicate
audit event.

---

## 13. Concurrency

- `update_department` carries an expected-version check; a stale version is
  refused with `P0001` and over HTTP as **409 `DB_CONCURRENCY_ERROR`**, after
  which the row provably keeps its version and its name.
- **True concurrent race proven:** two simultaneous `update_department` calls
  with the *same* base version yield exactly one success and exactly one
  `P0001` conflict (`Promise.all`, asserted counts, not simulated).
- Uniqueness (`department code`/`name`, case-insensitively) is enforced by the
  database unique indexes — measured `23505` — and is scoped **per hospital**
  (the same code in a different hospital is allowed).
- Overlapping schedule windows are refused by the table's `EXCLUDE` gist
  constraint — measured `23P01`, including overlap against an inactive row.
- Overlapping leave ranges likewise hit their `EXCLUDE` constraint.
- The RPCs do the invariant work inside PostgreSQL, so the protection does not
  depend on the Edge Function's process-local timing. No application-level
  read-modify-write race was introduced and no sleeps were used to paper over
  ordering.

---

## 14. Audit

Every privileged write emits exactly one `logAuditEvent()` through the
established audit system (no competing log), carrying actor, hospital, entity
type, entity id, action, severity, old state and new state, and registered
against `audit_action_types` with `category = 'configuration'` following the
existing `{entity}_{verb}` naming convention.

Attribution is proven, not assumed: tests assert the returned
`schedule_id` / `leave_id` is a UUID, equals the real row's `id` in
`doctor_schedules` / `doctor_leaves`, **and** equals
`audit_logs.entity_id` for that event, with audit counts filtered per entity so
sibling tests cannot mask a defect. Deactivation wording is captured as the
system actually writes it (`Doctor deactivated; 1 active schedule(s)
deactivated in the same transaction (WS-ONBOARD-4)`, alongside the structured
`schedulesDeactivated: 1` cascade count). Audit immutability was not weakened
for test cleanup.

---

## 15. Schedule semantics

- A schedule is a **weekly template row** in the pre-existing
  `doctor_schedules` table: `weekday` 0–6, `start_time`/`end_time`,
  `max_tokens`, `average_consultation_minutes`, `is_active`.
- Create and update share `upsert_doctor_schedule` with an explicit
  `p_schedule_id` discriminator (`NULL` ⇒ create). The parameter is last with
  `DEFAULT NULL` because PostgreSQL requires defaults to be contiguous, and a
  required parameter would make the generated client type non-nullable for
  every caller.
- The window-ordering CHECK and the overlap `EXCLUDE` constraint remain the
  database's own — the RPC pre-checks to produce a clean error, then the
  constraint still protects against a race that the pre-check cannot see.
- Deactivating a doctor does **not** silently delete history: `update_doctor`
  deactivates active schedule rows and reports the count in the audit note.
  Reactivation deliberately does **not** auto-restore them (see §21) —
  restoring availability is an explicit admin act, not an implicit side effect.
- No second schedule model and no competing availability semantics were
  introduced.

---

## 16. Leave semantics

- Leave is a date-range row in the pre-existing `doctor_leaves` table,
  upserted by `upsert_doctor_leave` and closed by `cancel_doctor_leave`
  (status transition, not deletion) — the historical record stays auditable.
- Overlapping ranges for the same doctor are refused by the table's `EXCLUDE`
  constraint.
- Calendar validity is enforced at the Edge Function boundary via
  `CalendarDateSchema` (real-calendar round-trip) and again by PostgreSQL date
  typing, so `2026-02-30` and `2026-13-01` both return 422 instead of being
  silently overflowed into March or surfacing as a 500.
- Leave is consumed by the existing availability path, so a configured leave
  range removes capacity rather than merely storing an unused row.

---

## 17. Runtime integration

Requirement: configured data must actually drive the operational engine (spec
§20 "DO NOT FAKE FUNCTIONALITY").

- Verification deliberately runs the full
  `Frontend/API → Edge Runtime → RPC → PostgreSQL` chain, not direct function
  calls: 28 HTTP tests were executed against the live local Edge Runtime
  container.
- Per AGENTS.md/F16-01, an exit code is not evidence that Edge Runtime is up.
  `supabase start` exited 0 while the container was absent (the documented
  false-positive); container inspection confirmed `Up` and
  `RestartPolicy=no`, and an HTTP probe returned 401 (rejection by auth, i.e.
  reachable) rather than connection-refused.
- A stale Edge Runtime module cache was detected after editing the function and
  cleared by restarting the container, confirmed by the runtime log line
  `serving the request with supabase/functions/clinical-configuration`.
- Availability is asserted through the real engine in the tests: a configured
  weekly window yields slots, an overlapping-window write is refused by the
  constraint, and a leave range removes availability on the affected dates —
  i.e. the same tables the booking/token engine already reads.

---

## 18. Tests

New, this workstream:

| Suite | Result |
| --- | --- |
| `tests/integration/clinical_configuration.test.ts` (RPC/DB, real local stack) | `ok \| 27 passed \| 0 failed` — INTEGRATION VERIFIED |
| `tests/integration/clinical_configuration_http.test.ts` (HTTP via Edge Runtime) | `ok \| 28 passed \| 0 failed` — INTEGRATION/RUNTIME VERIFIED |
| `apps/web/src/routes/ClinicalConfiguration.test.tsx` | part of the 512-test frontend suite — UNIT VERIFIED |

Coverage deliberately includes failure shapes, not just happy paths. The
measured HTTP status vocabulary actually asserted: `200` success, `400`
missing/non-UUID `Idempotency-Key` and non-POST `405`, `401` unauthenticated,
`403` role and tenant, `409` for `DB_CONCURRENCY_ERROR` (stale version),
`DB_CONSTRAINT_VIOLATION` (duplicate department identifier, schedule overlap,
leave overlap), `422` for strict-body / RPC input refusals and the duplicate
doctor email, and `500` for an injected unexpected database fault. At DB level:
`22023` validation, `23505` unique, `23P01` exclusion overlap, `P0002` unknown
id, `P0001` version conflict, `23503` fabricated auth id, `42501` cross-tenant
and EXECUTE denials, plus atomicity (a late column failure leaves no
half-created doctor), the 13-action `audit_action_types` registration, the
browser SELECT-only posture, and availability that really appears when a
schedule is created and really disappears when it is soft-deleted or a leave
range is approved.

Six initially-red tests were each diagnosed individually. Four were **my
assertions contradicting measured reality** and were rewritten to the truth
(table-grant denial message, `withIdempotency` replay semantics, PostgREST
serialising `numeric 600` as a JS number, the audit note wording, and the
unfiltered audit-event count). Two were **genuine product defects** and were
fixed at the source: the NULL audit `entity_id` (migration 69) and the
calendar-date 500 (`CalendarDateSchema`). No test was deleted, skipped or
weakened to reach green.

**Self-audit of two interim fixes (disclosed, then corrected).** Two of the
six red tests were first "fixed" in a way that did not actually prove the
requirement, and both were reworked during final verification:

- *Duplicate doctor email.* The first attempt accepted **either** a `409`
  conflict **or** a `400` validation error — green by construction, which
  proves nothing. It was rewritten to name the single measured contract: a
  `doctor_create` that reuses a registered email returns **HTTP 422 /
  `VALIDATION_ERROR`** (the platform path maps the auth-identity uniqueness
  refusal into a validation error, *not* into the `409` used for row-level
  conflicts), and the test then proves non-mutation — exactly one `auth.users`
  row for that email, and the existing `profiles` row untouched.
- *Browser direct-write refusal.* See the paragraph below: the assertion now
  pins the SQLSTATE and stops accepting a hoped-for message.

No test was deleted, skipped or weakened to reach green.

One measured correction to a stored belief: the browser write refusal is at the
**table-grant** layer (`42501 permission denied for table departments`) —
RLS is never evaluated for those statements, because `authenticated` holds no
INSERT/UPDATE/DELETE grant at all. The assertion pins SQLSTATE `42501`
(which covers both boundaries) and accepts either the grant or the RLS message,
with a comment recording that the SELECT-only RLS policies are the **second**
boundary, not the first.

---

## 19. Regression results

All commands are the repository's only authorities (`deno.json` / CI), run on
the final cleaned tree.

| Gate | Result |
| --- | --- |
| `deno task validate:migrations` | `Result: 0 error(s), 4 warning(s)` — the 4 documented pre-existing `[duplicate-objects]` warnings, not new |
| `deno task validate:migration-manifest` | `69 migration(s), 69 manifest line(s)` · `Result: 0 integrity issue(s)` |
| `deno task fmt:check` | `Checked 188 files` · exit 0 |
| `deno task lint` | `Checked 113 files` · exit 0 |
| `deno task check` | exit 0 |
| `deno task gen:types:check` | `database.generated.ts is UTF-8 and up to date.` · exit 0 |
| `deno task test` (unit) | `ok \| 113 passed \| 0 failed` |
| `deno task test:integration` (34 test files, real stack) | `ok \| 474 passed \| 0 failed (2m3s)` |
| `deno task test:consolidated` | `ok \| 58 passed \| 0 failed` (final-tree re-run, exit 0) |
| `apps/web` `npm run typecheck` | exit 0 |
| `apps/web` `npm run test` | `Test Files 35 passed (35)` · `Tests 512 passed (512)` |
| `apps/web` `npm run build` + `scripts/check_frontend_secrets.ts apps/web/dist --deny-sourcemaps` | exit 0 · `0` secret hits · `0` source maps |

Closing evidence pass on the shipped tree (after report authoring and scratch
cleanup): `fmt:check` `Checked 188 files` exit 0 · `validate:migrations`
`0 error(s), 4 warning(s)` · `validate:migration-manifest` `69 migration(s),
69 manifest line(s)` / `0 integrity issue(s)` · both new suites run together
`ok | 55 passed | 0 failed` (27 DB + 28 HTTP).

Previously closed workstreams (WS-ONBOARD-1/2/3, C2/C2b, G-03…G-11, G7-13,
G7-16, F16-07, privilege and booking/token/doctor-scheduling suites) remain
green inside the 474-test integration run. No unrelated test was rewritten;
every red test in this workstream was either a measured-truth correction to my
own assertion or a real defect fixed at its source (§18).

Method note (recorded, not hidden): a targeted re-run initially failed 27/27
with `Local Supabase stack is not running` because my ad-hoc `deno test`
omitted `--allow-run`, which the shared preflight helper needs to shell out to
`supabase status`. That was a **tooling** failure in my command, not a product
regression; re-run with the task's real permission set it was 27/27.

---

## 20. Migration / manifest status

- Canonical numbering respected: 68 (configuration surface) and 69 (additive
  attribution fix) follow the existing 67.
- **Applied for real** to the local stack: 68 was pushed and catalog-probed;
  after the 69 work, the local database was restored to the pristine-68 bodies
  and the **68 → 69 sequence was genuinely re-executed**, so 69's DDL is
  INTEGRATION VERIFIED rather than merely written.
- Manifest maintained only through the canonical
  `deno task validate:migration-manifest --update` append mechanism.
- Type generation re-run for the new objects; `gen:types:check` clean.
- Grants/revokes verified from `pg_proc.proacl` (`anon_x=f auth_x=f svc_x=t`),
  and `SET search_path = public` is set in every new/redefined function.
- **Migration-discipline incident, corrected and disclosed:** after finding the
  NULL `entity_id` defect I first edited already-manifested migration 68. The
  tooling caught it: `validate:migration-manifest` failed with
  `ERROR [modified] 68_…sql content hash does not match the manifest entry`,
  and `--update` only appends — it will not rewrite an existing line. Because
  applied migrations are historical artifacts (AGENTS.md §11), all six edits to
  68 were **reverted to their committed bytes** (manifest back to
  `0 integrity issue(s)` with 68 entries and 68 lines) and the change was
  re-delivered as additive migration 69.
- A second tooling catch: `Set-Content -Encoding utf8` gave 69 a UTF-8 BOM and
  `validate:migrations` refused it
  (`[encoding] non-ASCII byte 0xef at offset 0 — migrations must be pure ASCII`).
  BOM stripped, the freshly appended 69 manifest line removed and re-generated
  by `--update`, then 69 re-applied. Final state as in §19/§20.
- Scratch probe scripts left by the workstream (`_onboard4_*` logs and the
  temporary `.sql`/`.ps1` probes) have been deleted; after that deletion
  `deno task fmt:check` passes on all 188 files.

---

## 21. Known limitations

1. **68 → 69 history.** Migration 68 was briefly edited post-manifest, then
   reverted; the intended change shipped as additive migration 69. The local
   database was restored to pristine 68 before applying 69 so the real
   application order was exercised — but this is a two-step history any future
   environment must replay, and 68's text alone does not describe the final
   returned JSONB.
2. **Pre-existing direct-write policies remain.** `doctor_schedules` and
   `doctor_leaves` still carry legacy `*_manage FOR ALL TO public` policies
   predating this workstream. A browser role with a table grant could therefore
   bypass audit/idempotency on those two tables. Database CHECK + EXCLUDE
   constraints still protect the invariants. Removing those legacy policies is a
   separate, security-sensitive change to closed-workstream RLS and was **not**
   done silently here.
3. **Reactivation does not restore schedules.** `update_doctor` deactivates
   active schedules when a doctor is deactivated and deliberately does not
   restore them on reactivation; an admin must re-enable availability
   explicitly. This is a design decision, not an oversight, but it is not
   documented in the product UI copy.
4. **True simultaneous races are proven at one layer only.** The single
   genuine `Promise.all` race test is the department same-version update
   (exactly one winner, exactly one `P0001`). Schedule and leave overlap are
   proven sequentially at **both** DB and HTTP level (`23P01` → `409`), but no
   simultaneous two-HTTP-client overlap race is asserted; forcing one would be
   timing-dependent and would mainly exercise the platform idempotency wrapper.
   Duplicate-insert protection in that window is nevertheless guaranteed by the
   tables' own `EXCLUDE` constraints, not by application timing.
5. **`withIdempotency` mismatch semantics are inherited, not fixed here.** A
   same-key/different-payload request silently replays the stored response
   instead of surfacing a 409 conflict. This is the platform primitive's
   measured behaviour, reused as required by the spec ("do not invent a new
   HTTP conflict contract"); changing it would affect every other consumer.
6. **Staging/production UNPROVEN.** §22 forbade pushes; nothing was deployed.
7. **Browser session walkthrough NOT performed** as a scripted click-through
   against a controlled staging project — the UI is UNIT VERIFIED (Vitest) and
   its backend RUNTIME VERIFIED, but a human-style end-to-end staging walk is
   not part of this evidence set.
8. **`fmt:check` baseline in AGENTS.md §13 is stale.** It records a failure on 8
   root markdown files; today `fmt:check` passes all 188 files (root `*.md` are
   outside `deno fmt`'s configured scope — `deno fmt <report.md>` reports
   `No target files found`). Recorded honestly rather than "fixed" — no
   documentation file was reformatted unasked.
9. **No Git evidence available.** The tree is not a Git repository, so
   created/modified inventories rest on direct file inspection and timestamps,
   not `git status`/`git diff`.

---

## 22. Staging status

**UNPROVEN.** No staging project was deployed or exercised for this workstream
(spec §22: no production pushes; staging deployment is a separately authorized
action). The migration chain, privilege ACL and Edge Function contract have
only ever been executed against the local Supabase stack, and a local runtime
result is not staging verification.

## 23. Production status

**UNPROVEN.** No production deployment exists. Nothing here may be read as
"production ready": production privilege state, RLS policy counts, scheduler
absence and worker behaviour remain exactly as AGENTS.md §13 records them, and
this workstream neither changed nor certified them.

---

## 24. Definition-of-done checklist

| Requirement | Status | Evidence |
| --- | --- | --- |
| Newly created hospital configures Departments via frontend | DONE — INTEGRATION VERIFIED | `create_department` / `update_department` / `set_department_status` via 68; HTTP create/update/status tests green |
| …Doctors | DONE — INTEGRATION VERIFIED | `create_doctor` / `update_doctor` against existing `profiles` (no duplicate identity model) |
| …Doctor ↔ Department | DONE — INTEGRATION VERIFIED | `doctor_departments` writes + `assert_department_id_array`; assignment audit event `doctor_department_assignment` |
| …Doctor schedules | DONE — INTEGRATION VERIFIED | `upsert_doctor_schedule` / `delete_doctor_schedule`; `23P01` overlap refusal measured |
| …Doctor leave | DONE — INTEGRATION VERIFIED | `upsert_doctor_leave` / `cancel_doctor_leave`; overlap + calendar-date refusals measured |
| Authentication on every privileged write | DONE | `resolveAuth()` on all 9 actions; 401 without token measured over HTTP |
| Authorization | DONE | `requireRole(['global_admin','hospital_admin'])`; role-denial 403 measured |
| Tenant validation | DONE | header-vs-membership + per-RPC entity-hospital check; cross-tenant `42501` measured without existence leakage |
| Server-side validation | DONE | Shared Zod + `CalendarDateSchema`; 400/422 measured |
| Appropriate idempotency | DONE | `withIdempotency()` + `api_idempotency_keys`; replay cannot duplicate row or audit event (measured) |
| Database invariants | DONE | existing CHECK/EXCLUDE/unique constraints preserved; RPC raises specific SQLSTATEs |
| Audit | DONE | one `logAuditEvent()` per write, registered action types, `entity_id` attribution asserted equal to the real row id (migration 69) |
| Runtime: schedules/leave consumed by existing availability/booking flow | DONE — RUNTIME VERIFIED | 28 HTTP tests through the live Edge Runtime against the real engine; container state and 401 probe confirmed serving (F16-01) |
| Cross-tenant access denied | DONE | measured |
| Unauthorized roles denied | DONE | measured |
| No secrets exposed | DONE | no secret read/hardcoded; frontend dist secret scan 0 hits, 0 source maps |
| Existing functionality green | DONE | 113 unit · 474 integration · 58 consolidated · 512 frontend · all static gates exit 0 |
| Every claimed verification has command/test evidence | DONE | §18–§20 record the exact commands and outputs |

---

## 25. Final status

**WS-ONBOARD-4: IMPLEMENTED.**

- Departments / Doctors / Schedules / Leave configuration: **INTEGRATION
  VERIFIED** against the real local database.
- Edge Function contract over HTTP including all security and error shapes:
  **RUNTIME VERIFIED** through the local Edge Runtime.
- Audit attribution, idempotent replay, tenant isolation and privilege
  boundaries: **INTEGRATION VERIFIED**, catalog-checked rather than text-checked.
- Regression: **UNIT VERIFIED + INTEGRATION VERIFIED**, zero failures.
- Staging: **UNPROVEN**. Production: **UNPROVEN**.
- Blockers: **none** inside this workstream's local scope. The items in §21 are
  limitations and follow-up candidates, not incomplete work in §24.

This report is the closing artifact for WS-ONBOARD-4. No further workstream is
started here.

---

## Appendix — required status block (spec §30)

Kept as an appendix so sections 1–25 remain exactly the mandated report
structure.

```text
WS-ONBOARD-4 STATUS: IMPLEMENTED

Departments:
  IMPLEMENTED + INTEGRATION VERIFIED. create_department / update_department /
  set_department_status (migration 68) over the clinical-configuration Edge
  Function; new SELECT-only RLS + GRANT SELECT read path so the admin screen can
  list them at all; code/name uniqueness, version advance and cross-tenant
  refusal measured (23505 / P0001 / 42501).

Doctors:
  IMPLEMENTED + INTEGRATION VERIFIED. create_doctor / update_doctor write the
  EXISTING profiles + user_roles('doctor') + doctor_specializations +
  doctor_departments model only - no parallel doctor table, no duplicate auth
  identity. Atomicity under a late column failure, fabricated-auth-id refusal
  (23503), deactivation cascade and tenant/role re-check all measured.

Schedules:
  IMPLEMENTED + INTEGRATION VERIFIED. upsert_doctor_schedule /
  delete_doctor_schedule on the pre-existing doctor_schedules weekly template;
  window/token/minute invariants (22023) and overlap (23P01, including against
  an INACTIVE row) measured; soft-delete releases the range.

Leave:
  IMPLEMENTED + INTEGRATION VERIFIED. upsert_doctor_leave / cancel_doctor_leave
  on doctor_leaves; approved-on-creation status semantics, date and unknown-type
  validation, overlap refusal (23P01) and cross-tenant refusal measured.

Runtime integration:
  RUNTIME VERIFIED. 28 HTTP tests executed Frontend/API -> Edge Runtime -> RPC ->
  PostgreSQL against the live local container (F16-01 serving proven by container
  inspection + 401 probe, not by an exit code). A created schedule makes the
  doctor genuinely bookable on that weekday; deleting it, or approving a leave
  range over it, removes that availability through the existing engine.

Security:
  IMPLEMENTED + INTEGRATION VERIFIED. Two boundaries held: Edge layer
  (resolveAuth + requireRole(['global_admin','hospital_admin']) + tenant header
  validation -> 401/403) and database layer (all 10 write RPCs service_role-only,
  anon/authenticated EXECUTE confirmed absent in pg_proc.proacl AND at runtime;
  F16-04 explicit REVOKE re-asserted inside migration 69 for its two
  resignatured functions). No cross-tenant existence leak. No secret read,
  logged or shipped (dist scan: 0 hits, 0 source maps).

Idempotency:
  IMPLEMENTED + INTEGRATION VERIFIED via the platform withIdempotency() /
  api_idempotency_keys - no second mechanism and no invented conflict contract.
  Missing and non-UUID keys are 400 with nothing written; measured replay
  semantics documented rather than assumed.

Audit:
  IMPLEMENTED + INTEGRATION VERIFIED. One logAuditEvent() per privileged write
  through the established system; 13 configuration action types registered in
  audit_action_types; entity_id attribution proven equal to the real row id
  (this required migration 69 - see §20/§21).

Tests:
  27 DB integration passed / 0 failed; 28 HTTP runtime integration passed /
  0 failed; ClinicalConfiguration frontend suite inside 512 passed frontend
  tests.

Regression:
  ZERO FAILURES on the final tree: 113 unit; 474 integration across 34 files;
  58 consolidated; 512 frontend / 35 files; typecheck, build, check, lint,
  fmt:check, gen:types:check, validate:migrations (0 errors, 4 documented
  pre-existing warnings) and migration-manifest (69/69, 0 integrity issues) all
  exit 0. Previously closed workstreams remain green; no unrelated test was
  rewritten.

Staging:
  UNPROVEN. No staging deployment performed (spec §22). Local runtime results are
  not staging verification.

Production:
  UNPROVEN. No production deployment exists. Nothing here is a production-readiness
  claim.

Remaining blockers:
  NONE for this workstream's local scope. §21 lists limitations and follow-up
  candidates: pre-existing *_manage FOR ALL TO public policies on
  doctor_schedules / doctor_leaves (a separate security-sensitive change to
  closed-workstream RLS), schedule non-restoration on reactivation (design
  decision), inherited withIdempotency mismatch semantics, single-layer
  simultaneous-race proof, and UNPROVEN staging/production.
```

**WS-ONBOARD-4 can be considered CLOSED LOCALLY** — implementation complete and
evidenced against the real local stack, with every gate run on the final tree and
zero failures. It is explicitly **NOT** claimed certified, staging-verified,
production-verified or production-ready. Per spec §30, no further workstream is
started here.
