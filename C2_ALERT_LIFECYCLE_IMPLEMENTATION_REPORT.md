# C2 ALERT LIFECYCLE — IMPLEMENTATION REPORT

Execution of the C2 Alert Lifecycle Implementation Authorization. Authoritative
design: OD-d = **D1** (RESOLVE is not terminal; ACK/ASSIGN/ESCALATE permitted
after RESOLVE; no REOPEN; existing PostgreSQL lifecycle RPCs remain the atomicity
engine; migrations 47/48 untouched; one additive locked-snapshot migration;
`42501 → 403` is an Edge transport fix; `alert_activity_log` remains the
transactional lifecycle record).

Evidence tiers are kept honest. Nothing here is claimed at a higher tier than it
was actually verified. All integration/runtime results are **LOCAL** Supabase
stack results; **no** staging or production verification was performed.

---

## C2 IMPLEMENTATION STATUS: COMPLETE (local integration-verified; not production)

- **HEAD:** `0fceb50b0ca9b9971af1bebb3938583b78ace4dd`
- **BRANCH:** `main`
- **Migration frontier before:** `63` (live re-check before implementation)
- **Migration created:** `64` — `supabase/migrations/64_c2_alert_rpc_locked_snapshot.sql` (443 lines, ASCII-only)
- **Migration applied:** Yes, to the LOCAL stack. Applied directly via `psql`
  after a `supabase start` re-init reverted the earlier `db push` attempt; a
  matching `schema_migrations` row (`version=64`) was inserted and PostgREST
  schema was reloaded. Applied-state re-verified from the catalog (below).

### Files changed

| File | Change | Tier |
| --- | --- | --- |
| `supabase/migrations/64_c2_alert_rpc_locked_snapshot.sql` | NEW (untracked) — re-signs the four row RPCs with locked snapshot | IMPLEMENTED + applied + catalog-verified |
| `supabase/functions/alert-center/index.ts` | MOD (+31/-12) — 42501→403, snapshot-based audit | IMPLEMENTED + integration-verified |
| `tests/integration/enterprise_command_center.test.ts` | MOD (+408) — 6 concurrency + snapshot + rollback `c2:` tests | INTEGRATION-VERIFIED |
| `tests/integration/alert_center_http.test.ts` | MOD (+465) — H1–H15 write-path HTTP coverage | INTEGRATION-VERIFIED |

---

## SQL (migration 64)

- **snapshot:** Each of `acknowledge_alert` / `assign_alert` / `resolve_alert` /
  `escalate_alert` now returns additive `before` / `after` JSONB objects captured
  while the row `FOR UPDATE` lock is held, only on a real transition. Approved
  fields only: `id, hospital_id, acknowledged_at, acknowledged_by, assigned_to,
  escalated_at, escalated_by, is_resolved, resolved_at, resolved_by, severity`.
  No `alert_events.message`, no `resolution_notes`, no patient PII.
- **authorization preserved:** Bodies authored from the actual migration-48
  definitions. Same signatures, same return type (`jsonb`), same
  `has_permission(...)`, same SQLSTATE `42501` RAISE, same tenant checks, same
  `FOR UPDATE`, same state guards, same UPDATE + `log_alert_activity(...)`, same
  soft-success (`already_*`) and not-found response semantics. `suppress_alerts`
  was NOT re-signed; no `reopen_alert` was created; no state machine / enum added;
  D1 unchanged (no `is_resolved` guard introduced in ACK/ASSIGN/ESCALATE).
- **privileges verified (catalog, `pg_proc` + `has_function_privilege()`):**
  All four: `prosecdef = t` (SECURITY DEFINER), `proconfig = search_path=public`,
  `anon EXECUTE = f`, `authenticated EXECUTE = f`, `service_role EXECUTE = t`,
  snapshot present. Same-signature `CREATE OR REPLACE` preserved the prior ACL —
  no new grants, no widened privileges, no `search_path` weakening (F16-04
  nuance: a re-signatured existing function retains its ACL; a genuinely NEW
  SECURITY DEFINER function would have needed an explicit REVOKE).

## Edge (`alert-center/index.ts`)

- **42501 → 403:** In the RPC error branch, `error.code === "42501"` now throws
  `ForbiddenError` (403 FORBIDDEN); every other rpc error still throws
  `InternalError` (500). No new error code; `_shared/errors.ts` untouched.
- **snapshot-based audit:** `logAuditEvent` `oldData = outcome.before`,
  `newData = outcome.after ?? { action, already: true, result }`. The soft
  `already_*` replay (commits no change, returns no snapshot) records a null old
  state plus the replayed action. The `loadAuthorizedAlert` pre-read is retained
  only for authorization/tenant isolation and `entityId`; it is no longer the
  audit snapshot source (not lock-consistent). Audit stays best-effort; no audit
  trigger; no in-transaction platform audit.
- **unexpected DB → 500:** preserved (verified by H15b failure injection).

## Concurrency (genuine two-connection, `enterprise_command_center.test.ts`)

PostgREST serves each parallel `db.rpc` on its own DB backend session, so the six
cases are real two-connection races, not sequential single-connection calls.

| Case | Result |
| --- | --- |
| Case 1 `RESOLVE \|\| ACKNOWLEDGE` | PASS — both persist (D1), 2 activity rows, no lost update |
| Case 2 `RESOLVE \|\| ESCALATE` | PASS — both persist (D1), `severity=critical`, 2 activity rows |
| Case 3 `RESOLVE \|\| RESOLVE` | PASS — exactly one real transition, one `already_resolved` |
| Case 4 `ESCALATE \|\| ESCALATE` | PASS — exactly one real transition, one `already_escalated` |
| Case 5 `ASSIGN X \|\| ASSIGN Y` | PASS — serialized, last commit authoritative, 2 activity rows |
| Case 6 `ACKNOWLEDGE \|\| ACKNOWLEDGE` | PASS — exactly one real transition, one `already_acknowledged` |

Snapshot concurrency assertions (§14): for each real transition the `before` /
`after` values were checked against the observed row state, not merely for key
existence. Rollback / failure-injection (§15): a scoped trigger forcing
`log_alert_activity` to fail rolls back BOTH the lifecycle state change and the
activity row (verified DB state after failure, not only that an exception was
thrown).

## HTTP (H1–H15, `alert_center_http.test.ts`)

- **Edge Runtime serving — verified (§17 / F16-01):** `supabase start` exit 0 was
  NOT trusted. Edge Runtime container confirmed `Up` and the
  `/functions/v1/alert-center` endpoint returns a real gateway `401` (not `503`)
  for anonymous, i.e. actually serving, before any HTTP result was interpreted.

| Case | Result |
| --- | --- |
| H1 hospital_admin lifecycle success | PASS |
| H2 global_admin scoped via X-Hospital-ID | PASS |
| H3 receptionist denied → 403 | PASS |
| H4 doctor denied → 403 | PASS |
| H5 anonymous → 401 | PASS |
| H6 missing X-Hospital-ID → 422 | PASS |
| H7 cross-tenant alert → 403 + zero mutation | PASS |
| H8 malformed validation → 422 | PASS |
| H9 `already_*` replay → 200 soft-success | PASS |
| H10 concurrent HTTP → serialized result | PASS |
| H11 resolved alert under D1 → permitted 200 | PASS |
| H12 audit/activity correctness | PASS |
| H13 no unintended jobs/WhatsApp/financial side effects | PASS |
| H14 no message/notes PII in response | PASS |
| H15 42501 → 403 and unexpected DB → 500 | PASS |

Status contract honored (200/401/403/422/500 only; no 404/409/428). The existing
13 read tests remain in the suite and pass (total HTTP file: **28 passed / 0
failed**).

## Regression

- **alert lifecycle:** `enterprise_command_center.test.ts` full run — **30 passed
  / 0 failed** (23 pre-existing + 7 new `c2:`). No existing assertion weakened or
  deleted.
- **HTTP read regression:** within `alert_center_http.test.ts` — **28 passed / 0
  failed** (includes the original 13 read tests).
- **privilege boundary:** `privilege_isolation.test.ts` — **22 passed / 0 failed**
  (confirms the ACL/least-privilege posture is unchanged by migration 64).
- **audit reliability:** `tests/unit/audit_reliability.test.ts` — **10 passed / 0
  failed**.
- **G-03…G-11 (full matrix):** NOT re-executed this session. The change's blast
  radius was scoped by an exhaustive search: the ONLY non-test consumer of the
  four RPCs and of the `alert-center` function is `alert-center/index.ts` itself;
  no Edge function or app path reaches the alert lifecycle RPCs and no other
  feature (G-03…G-09, G-11) depends on them. The alert-path regression
  (command-center + privilege + audit) is green, so the risk to the untouched
  suites is assessed as nil — but this is a scoping judgement, not a claim that
  the full G-matrix was run.
- **type/check:** `deno check` on the three changed TS files — **exit 0**.
- **lint:** `deno lint` on the three changed files — **exit 0** (after removing
  one unused `no-explicit-any` lint-ignore).
- **format:** `deno fmt --check` on the three changed files — **exit 0** after
  `deno fmt` was run scoped to exactly those files. (Repo-wide `fmt:check` still
  fails only on the known pre-existing root markdown docs — unchanged by C2.)
- **migrations:** `deno task validate:migrations` — **exit 0**, 64 files scanned,
  **0 errors / 4 warnings** (the same 4 pre-existing `[duplicate-objects]`
  warnings; migration 64 introduces no new duplicate-object warning).
- **gen:types:** `deno task gen:types:check` — **FAILS**, but the failure is
  **pre-existing and unrelated to C2**: the only substantive difference is that
  the live DB contains `user_is_same_hospital_doctor` (defined by migration **61**
  `staff_doctor_directory_read`), which the committed `database.generated.ts`
  predates. Migration 64 changes only function BODIES with identical signatures
  and identical `jsonb` return types, which the generator does not encode, so it
  neither causes nor worsens the staleness. The committed `database.generated.ts`
  is unmodified in the working tree (`git diff` empty). It was NOT regenerated
  because doing so would fold unrelated migration-61 churn into the file, outside
  C2 scope (§2/§22).

## Production

- **NO PRODUCTION CHANGES.** All results are LOCAL stack. No deployment.
  Production state is **UNPROVEN**.

## Git (§22)

- **commit:** NO
- **push:** NO
- **deploy:** NO
- No migration history rewrite, no renumbering, no reset/rebase/cherry-pick.

```text
git status --short (C2 scope)
 M supabase/functions/alert-center/index.ts
 M tests/integration/alert_center_http.test.ts
 M tests/integration/enterprise_command_center.test.ts
?? supabase/migrations/64_c2_alert_rpc_locked_snapshot.sql

git diff --stat (tracked edits)
 supabase/functions/alert-center/index.ts           |  31 +-
 tests/integration/alert_center_http.test.ts        | 465 +++++++++++++++++++-
 tests/integration/enterprise_command_center.test.ts| 408 ++++++++++++++++++
 3 files changed, 892 insertions(+), 12 deletions(-)
```

---

## DEFINITION OF DONE

Every C2-specific item is satisfied at the tier claimed:

- [x] Migration 64 allocated from live frontier (63 → 64); never reused 50–53
- [x] Exactly one additive snapshot migration; 47/48 and 50–53 untouched
- [x] Four row RPCs preserve migration-48 authorization/guards; D1 preserved
- [x] Locked `before` + `after` snapshot; no PII in snapshot (H14)
- [x] `42501 → 403` proven (H15); unexpected DB → 500 proven (H15b)
- [x] Two-connection concurrency proven (6 cases); activity atomicity + failure
      injection proven (rollback test)
- [x] H1–H15 proven; Edge Runtime explicitly verified serving
- [x] Tenant isolation (H7) + role isolation (H3/H4) proven
- [x] `pg_proc` ACL + SECURITY DEFINER + pinned `search_path` verified
- [x] Existing alert tests + 13 HTTP read tests green; no assertion weakened
- [x] check / lint / fmt (changed files) / validate:migrations green
- [ ] **gen:types:check red** — pre-existing migration-61 drift, NOT a C2 regression
- [ ] **full G-03…G-11 matrix not re-executed** — scoped as out of blast radius

## FINAL VERDICT

**IMPLEMENTED — VERIFICATION INCOMPLETE**

The C2 design is implemented and every C2-specific requirement is
**INTEGRATION-VERIFIED** against the local Supabase stack (SQL snapshot +
privileges, Edge 42501→403 + snapshot audit, D1 concurrency, rollback injection,
H1–H15, alert-path regression). It is intentionally NOT upgraded beyond the
evidence actually produced:

1. `gen:types:check` is red from a **pre-existing, non-C2** staleness (migration
   61 function absent from the committed types file); C2 did not cause it and
   regenerating is out of scope.
2. The full **G-03…G-11** matrix was not re-executed; it was scoped as outside
   the change's reach rather than proven green.
3. Nothing is **RUNTIME-VERIFIED IN PRODUCTION**; production readiness is not
   claimed.

To close the remaining two DoD boxes requires either (a) regenerating
`database.generated.ts` under a separate migration-hygiene task, and (b) running
the full cross-feature regression suite — neither of which is a C2 code change.
