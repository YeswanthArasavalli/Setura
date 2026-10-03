# WS-SEC-1 — Legacy Doctor Schedule & Leave Direct-Write Security Hardening

## Implementation Report

Scope: `doctor_schedules` and `doctor_leaves` legacy browser-write bypass.
Target environment: real local PostgreSQL + real local Edge Runtime.
Classification vocabulary per AGENTS.md §5: every claim below is labelled with
the evidence class that actually backs it. Local results are NOT production
verification.

---

## 1. Executive outcome

The pre-existing legacy bypass documented by WS-ONBOARD-4 has been closed
additively. `anon` and `authenticated` (and every browser JWT role, including a
`hospital_admin` / `doctor` token) can no longer `INSERT` / `UPDATE` / `DELETE`
`doctor_schedules` or `doctor_leaves` through PostgREST. The refusal is enforced
at the **database** boundary (SQLSTATE `42501`), independently of the Edge layer.

Legitimate browser `SELECT` through the retained tenant-scoped RLS read model
still works, and the canonical `clinical-configuration → SECURITY DEFINER RPC`
write path (which executes as `service_role`) is unchanged and still succeeds
end to end. No business logic, no data, no schema, and no RPC was modified.

**WS-SEC-1 STATUS: IMPLEMENTED / INTEGRATION VERIFIED / RUNTIME (local)
VERIFIED.**

---

## 2. Existing security posture discovered (LIVE catalog, pre-change)

Read from the actual running database (`pg_policies`, `pg_class`,
`information_schema.role_table_grants`), not inferred from migration text:

| Object | Discovered before WS-SEC-1 |
| --- | --- |
| `doctor_schedules` policies | `doctor_sched_read` (FOR SELECT) **and** `doctor_sched_manage` (FOR ALL, roles `{public}`, WITH CHECK) |
| `doctor_leaves` policies | `doctor_leaves_read` (FOR SELECT) **and** `doctor_leaves_manage` (FOR ALL, roles `{public}`, WITH CHECK) |
| Table grants | `anon` **and** `authenticated` held `INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, SELECT, TRIGGER` on **both** tables |
| RLS | `relrowsecurity = t`, `relforcerowsecurity = t` on both tables (already enabled + forced) |

The `*_manage` policies originate in migration `03_doctorscheduling&slotengine.sql`.
Migration `68` (WS-ONBOARD-4) introduced the RPC write path but deliberately
left these legacy policies in place and recorded them as a known limitation.

---

## 3. Exact legacy policies discovered

```
doctor_schedules :: doctor_sched_manage   cmd=ALL    roles={public}  has_qual  has_with_check
doctor_leaves    :: doctor_leaves_manage  cmd=ALL    roles={public}  has_qual  has_with_check
```

Their `USING` / `WITH CHECK` clauses honoured `is_global_admin()`, a
`hospital_admin` role, or row ownership (`doctor_id = auth.uid()`), so an
authenticated browser JWT for any of those identities could mutate rows
directly. `FOR ALL` also covered `SELECT`, but a separate `*_read` `FOR SELECT`
policy already provided the read model.

---

## 4. Actual security gap

A second, audit-bypassing write path existed alongside the canonical one:

```
Browser (hospital_admin / doctor JWT)
   → PostgREST INSERT/UPDATE/DELETE
   → doctor_schedules / doctor_leaves      ← bypassed resolveAuth, requireRole,
                                              tenant validation, idempotency and
                                              the SECURITY DEFINER audit trail
```

This is exactly the "hidden second path" the SETURA security model forbids. The
gap was real at the privilege layer (grants present) *and* at the policy layer
(FOR ALL policies present).

---

## 5. Files created

- `supabase/migrations/70_ws_sec_1_doctor_schedule_leave_direct_write_hardening.sql`
- `tests/integration/doctor_schedule_leave_direct_write_denial.test.ts`
- This report.
- `supabase/migrations/MANIFEST.sha256` gained one append-only line for
  migration 70 (via the canonical `--update` mechanism; no existing line
  touched).

## 6. Files modified

- `supabase/migrations/MANIFEST.sha256` (appended 1 entry, append-only).
- No Edge Function, no RPC, no other migration, and no frontend source file
  was modified.

---

## 7. Migration details

Additive migration `70`. Migrations 68 and 69 are historical artifacts and were
**not** edited (confirmed by the append-only manifest check). It performs four
surgical actions and nothing else:

1. `DROP POLICY IF EXISTS doctor_sched_manage ON doctor_schedules;`
2. `DROP POLICY IF EXISTS doctor_leaves_manage ON doctor_leaves;`
3. `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON <both
   tables> FROM PUBLIC, anon, authenticated;` — `TRUNCATE` is included because a
   browser-role TRUNCATE grant would allow wiping the whole (cross-tenant)
   table, which is a strictly worse mutation than a row write.
4. Re-assert the intended boundary explicitly: `GRANT SELECT ... TO anon,
   authenticated` (browser = read only) and `GRANT ALL ... TO service_role`
   (privileged path preserved); re-assert `ENABLE` + `FORCE ROW LEVEL SECURITY`.

No SECURITY DEFINER function is created or resignatured, so the F16-04
function-REVOKE rule does not apply here; the resulting table ACL was verified
against the live catalog (§11/§13), not against the migration text.

---

## 8. RLS changes

- Legacy `FOR ALL` write policies `doctor_sched_manage` / `doctor_leaves_manage`
  removed.
- `FOR SELECT` read policies `doctor_sched_read` / `doctor_leaves_leave`
  (`doctor_leaves_read`) **retained unchanged** — reads are untouched.
- `relrowsecurity = t` and `relforcerowsecurity = t` remain on both tables.
- Result (live): the only remaining policies are `r` (SELECT) on each table.

## 9. Grant / revoke changes

Post-migration live `role_table_grants`:

| Grantee | doctor_schedules | doctor_leaves |
| --- | --- | --- |
| `anon` | SELECT only | SELECT only |
| `authenticated` | SELECT only | SELECT only |
| `service_role` | INSERT/UPDATE/DELETE/SELECT/TRUNCATE/REFERENCES/TRIGGER (full) | full |

`TRUNCATE` / `REFERENCES` / `TRIGGER` were also stripped from the browser roles.

---

## 10. Direct browser denial evidence (INTEGRATION VERIFIED)

New suite `doctor_schedule_leave_direct_write_denial.test.ts` (12 tests, all
green against the real local stack). Every denial is pinned on **SQLSTATE
`42501`** (not an HTTP status) and accepts either a "permission denied" or a
"row-level security" message so the invariant — not the incidental message text
— is asserted. Probe payloads use only real columns so PostgREST's schema cache
cannot short-circuit the request as `PGRST204` before it reaches PostgreSQL.

Proven refused, per table:
- `anon` INSERT / UPDATE / DELETE → `42501`
- `authenticated` / `hospital_admin` (own tenant) INSERT / UPDATE / DELETE → `42501`
- `doctor` role direct INSERT into own schedule / UPDATE / DELETE on leave → `42501`
- cross-tenant `authenticated` direct UPDATE / DELETE with a **known UUID** → `42501`

The rows created via the RPC path were re-read after every attempt and were
byte-for-byte unchanged (the denials really denied; they did not partially apply).

## 11. RPC write-path evidence (INTEGRATION VERIFIED)

Same suite proves the privileged path still succeeds after hardening:
- `upsert_doctor_schedule` create → `delete_doctor_schedule` (soft-delete)
- `upsert_doctor_schedule` update (`max_tokens` change really landed)
- `upsert_doctor_leave` → `cancel_doctor_leave` (`leave_status = cancelled`)

Live RPC ACL (`pg_proc.proacl`) for the four write functions:
`postgres=X/postgres | service_role=X/postgres` — owner EXECUTE + service_role
EXECUTE only; `anon` / `authenticated` / `PUBLIC` EXECUTE absent. The write-path
lock is preserved.

## 12. Tenant isolation

- Browser reads stay tenant-scoped: an owning tenant's admin reads its
  schedules/leaves; a foreign tenant's admin reads **zero rows** (no existence
  leak) — asserted for both tables.
- Cross-tenant RPC mutation (B's admin targeting A's schedule/leave) is refused.
- Cross-tenant direct PostgREST write with a known UUID is refused (`42501`).

---

## 13. Catalog verification (RUNTIME VERIFIED, local)

Re-read live after migration (all confirm the target posture):

```
Policies:   r on doctor_leaves    (roles = PUBLIC)      -- SELECT only
            r on doctor_schedules (roles = PUBLIC)      -- SELECT only
RLS:        doctor_leaves    relrowsecurity=t relforcerowsecurity=t
            doctor_schedules relrowsecurity=t relforcerowsecurity=t
Grants:     anon/authenticated = SELECT only; service_role = full
RPC ACL:    upsert/delete/cancel schedule/leave = postgres + service_role EXECUTE only
```

## 14. Privilege verification

`privilege_isolation.test.ts` (25 tests) re-run green, including the F16-06
locked-routine anon/authenticated `42501` denials and the WS-ONBOARD-4
"departments/doctor_departments SELECT only" direct-write refusal. No existing
assertion was weakened. F16-04 / F16-05 / F16-06 / F16-07 posture is preserved.

---

## 15. Regression results (all against the real local stack)

| Suite | Result | Class |
| --- | --- | --- |
| New WS-SEC-1 denial suite | 12 / 12 | INTEGRATION VERIFIED |
| `clinical_configuration.test.ts` (WS-ONBOARD-4 DB) | 27 / 27 | INTEGRATION VERIFIED |
| `clinical_configuration_http.test.ts` (Edge→RPC) | 28 / 28 | INTEGRATION VERIFIED |
| `privilege_isolation.test.ts` | 25 / 25 | INTEGRATION VERIFIED |
| `reschedule_booking` + `doctor_operations` + `staff_doctor_directory` | 38 / 38 | INTEGRATION VERIFIED |
| `deno task test:consolidated` (hospital_core_journey, worker, scheduler, booking_fee, refund, settlement, security_s1) | 59 / 59 | INTEGRATION VERIFIED |
| `deno task test` (unit) | 113 / 113 | UNIT VERIFIED |
| `apps/web` full `npm run test` | 512 / 512 (35 files) | INTEGRATION VERIFIED (client) |
| `apps/web` `ClinicalConfiguration.test.tsx` | 33 / 33 | INTEGRATION VERIFIED (client) |

WS-ONBOARD-4's existing **27 DB + 28 HTTP** evidence remains green, and the
clinical-configuration UI still creates / updates / deletes schedules and
creates / cancels leave (frontend tests + HTTP suite confirm both).

**Authoritative gates:**

| Gate | Result |
| --- | --- |
| `deno task check` | PASS (exit 0) |
| `deno task lint` | PASS (116 files, 0 problems) |
| `deno task fmt:check` | PASS (exit 0; `**/*.md` excluded by `deno.json`) |
| `deno task gen:types:check` | PASS — `database.generated.ts` up to date (no schema change) |
| `deno task validate:migrations` | PASS — 0 errors; 6 warnings (4 pre-existing `duplicate-objects`, 2 new `rollback-risk/TRUNCATE` — see §16) |
| `deno task validate:migration-manifest` | PASS — 70 migrations, 70 lines, 0 integrity issues |

---

## 16. Known limitations

- The two new `validate:migrations` warnings are validator **false positives**:
  the scanner flags any literal `TRUNCATE` token, and they occur inside a
  `REVOKE ... TRUNCATE ...` privilege statement, not a `TRUNCATE <table>` DDL.
  They are non-blocking (0 errors) and are the intended hardening.
- `reschedule_booking.test.ts` and `whatsapp_conversational.test.ts` seed
  `doctor_schedules` with the **service_role** client (confirmed by reading their
  `getServiceClient()` setup); the revoke targets only `anon`/`authenticated`,
  so those legitimate backend writes are unaffected (proven by reschedule
  re-run).
- Full `deno task test:integration` (every file) was not re-run as one batch in
  this session; the directly-affected suites plus the curated `test:consolidated`
  gate were run green instead. Payment/WhatsApp suites that require external
  secrets remain environment-gated (unchanged by this workstream).

## 17. Staging status

NOT VERIFIED. No staging deployment was performed or claimed (§26). Target was
the local stack only.

## 18. Production status

UNPROVEN / NOT VERIFIED. No production deployment, no production RLS change, no
production credential used. No production security certification is claimed.

---

## 19. Definition-of-Done checklist

| Requirement | Status |
| --- | --- |
| `doctor_schedules` INSERT/UPDATE/DELETE direct denied (proven) | DONE — INTEGRATION VERIFIED |
| `doctor_leaves` INSERT/UPDATE/DELETE direct denied (proven) | DONE — INTEGRATION VERIFIED |
| Legitimate `clinical-configuration → RPC → PostgreSQL` path works | DONE — INTEGRATION VERIFIED |
| Existing reads continue to work | DONE — INTEGRATION VERIFIED |
| Tenant isolation (cross-tenant mutation denied, no existence leak) | DONE — INTEGRATION VERIFIED |
| Live ACL/RLS catalog matches intended architecture | DONE — RUNTIME VERIFIED (local) |
| Existing suites remain green | DONE — INTEGRATION VERIFIED |
| Manifest valid, no historical migration modified | DONE — statically verified |

---

## 20. Final status

```
WS-SEC-1 STATUS: IMPLEMENTED

Direct doctor_schedules writes:
  anon / authenticated / hospital_admin / doctor INSERT, UPDATE, DELETE = DENIED
  (SQLSTATE 42501), proven against live local PostgREST. INTEGRATION VERIFIED.

Direct doctor_leaves writes:
  anon / authenticated / hospital_admin / doctor INSERT, UPDATE, DELETE = DENIED
  (SQLSTATE 42501), proven against live local PostgREST. INTEGRATION VERIFIED.

RLS:
  Legacy FOR ALL policies dropped; SELECT-only read policies retained;
  relrowsecurity=true and relforcerowsecurity=true on both tables.
  Verified against live pg_class/pg_policy. RUNTIME VERIFIED (local).

Table grants:
  anon/authenticated = SELECT only (INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/
  TRIGGER revoked); service_role = full. Verified via live role_table_grants.

RPC write path:
  upsert_doctor_schedule / delete_doctor_schedule / upsert_doctor_leave /
  cancel_doctor_leave still succeed end to end; EXECUTE remains
  service_role-only (live pg_proc.proacl). INTEGRATION VERIFIED.

Tenant isolation:
  Cross-tenant browser write refused (42501) even with a known UUID; cross-
  tenant RPC mutation refused; foreign tenant reads return zero rows.
  INTEGRATION VERIFIED.

Catalog verification:
  Policies = SELECT only; RLS enabled+forced; browser grants SELECT-only;
  service_role full; RPC EXECUTE locked. RUNTIME VERIFIED (local).

Privilege tests:
  privilege_isolation.test.ts 25/25 green; F16-04/05/06/07 posture preserved.

Clinical configuration regression:
  27 DB + 28 HTTP WS-ONBOARD-4 tests green; UI create/update/delete schedule
  and create/update/cancel leave still work (33/33 frontend ClinicalConfiguration).

Full regression:
  unit 113/113; consolidated 59/59; booking/operations/directory 38/38;
  frontend 512/512; all authoritative Deno gates PASS.

Staging:
  NOT VERIFIED (no staging performed).

Production:
  UNPROVEN (no production deployment; no production certification claimed).

Remaining blockers:
  None for local closure. (The 2 validate:migrations TRUNCATE warnings are
  false positives of a REVOKE statement, not defects.)
```

WS-SEC-1 can be considered CLOSED LOCALLY.

This is not a production security certification. No further workstream is
started from this report.
