# SETURA — C2 ALERT LIFECYCLE MIGRATION DESIGN REVIEW

**Class:** Architecture / migration design review. No source, SQL, migration,
Edge, frontend, test, RLS, grant or database artifact was created or modified.
The only artifact is this document. No commit, push, deploy, migration creation
or `db:reset` was performed (AGENTS.md §2 safety classes respected).

Claims are tagged: `[EXISTING FACT]` · `[APPROVED DECISION]` · `[PROPOSED DESIGN]`
· `[UNPROVEN]` · `[OUT OF SCOPE]`.

---

## 1. Executive summary

The C2 owner-decision gate is now fully closed: OD-a/OD-b/OD-c/OD-e/OD-f/OD-g/
OD-h closed at the design gate, and **OD-d is closed as D1** (`[APPROVED DECISION]`
— RESOLVE is not a terminal backend state; no `is_resolved` guards are added to
ACK/ASSIGN/ESCALATE; no REOPEN; migrations 47/48 are not edited).

This review answers the migration-design question the closure left open: **does
the approved architecture require a database migration at all?**

Findings:

- Lifecycle atomicity, in-DB authorization, state guards, `FOR UPDATE`
  serialization and in-transaction `alert_activity_log` **already exist** in 47/48
  and are **kept unchanged**. `[EXISTING FACT]`
- The **42501 → 403** fix and the entire **concurrency + H1–H15 write-test** suite
  need **no migration** — they are Edge-transport and test changes only.
  `[PROPOSED DESIGN]`
- The **one** thing that genuinely cannot be done without a migration is the
  **locked pre/post audit snapshot**: the `FOR UPDATE` lock is held only for the
  RPC's own transaction, so any Edge-side re-read after `db.rpc(...)` returns is
  post-commit and not lock-consistent. Capturing an authoritative snapshot
  requires the RPC itself to take and return it → an additive re-sign of the four
  row RPCs in a new migration. `[EXISTING FACT]` + `[PROPOSED DESIGN]`
- The snapshot is the **only** reason a migration is needed, and OD-f already
  endorsed its concrete value. Recommended architecture therefore = **Option A
  (Edge + tests, mandatory) + Option B (one additive snapshot migration, adopted
  because OD-f endorsed it)**. `[PROPOSED DESIGN]`

**New migration required: YES — one, and only for the locked snapshot** (number
allocated at implementation from the live frontier, currently 63 → next free 64,
**must** be re-checked; never reuse 50–53). `[PROPOSED DESIGN]`

---

## 2. Owner decision baseline

| ID | Status | Substance |
| --- | --- | --- |
| OD-a | `[APPROVED DECISION]` CLOSED | Platform audit stays best-effort; no in-txn audit trigger; activity log is the transactional record of truth. |
| OD-b | `[APPROVED DECISION]` CLOSED | Benign overlapping suppression windows; no dedupe, no client idempotency key. |
| OD-c | `[APPROVED DECISION]` CLOSED | Independent lifecycle fields retained; no canonical status enum. |
| OD-d | `[APPROVED DECISION]` CLOSED = **D1** | RESOLVE not terminal. ACK/ASSIGN/ESCALATE permitted after resolve. No REOPEN. Migrations 47/48 not edited. UI may hide post-resolve controls (presentation only, not backend terminality). |
| OD-e | `[APPROVED DECISION]` CLOSED | 422 not-found/known validation; 403 authorization; 500 unexpected DB. SQLSTATE 42501 MUST map to 403. No new status codes. |
| OD-f | `[APPROVED DECISION]` CLOSED | Locked pre/post snapshot has concrete value; formal status envelope optional; UNKNOWN is not a commit oracle. |
| OD-g | `[APPROVED DECISION]` CLOSED | Assign backend exists; Assign frontend deferred. |
| OD-h | `[APPROVED DECISION]` CLOSED | Greenfield current-repository design. |

---

## 3. Current repository baseline

`[EXISTING FACT]`

| Item | Value |
| --- | --- |
| HEAD | `0fceb50b0ca9b9971af1bebb3938583b78ace4dd` |
| Branch | `main` |
| Source dirs clean | `git status --short -- supabase apps tests` → empty (nothing touched before/after this task) |
| Alert lifecycle authority | `47_enterprise_command_center.sql` bodies (L169–386), re-signed in `48_privilege_hardening.sql` (L108–360, adds in-DB `has_permission` → `RAISE 42501`) |
| Alert Edge transport | `supabase/functions/alert-center/index.ts` |
| Error hierarchy | `_shared/errors.ts` (`ValidationError`=422, `ForbiddenError`=403, `RoleInsufficientError`=403, `InternalError`=500) |
| Response passthrough | `_shared/response.ts` `handleErrorResponse` → only `SeturError`s pass through; anything else → 500 |
| Audit | `_shared/audit.ts` `logAuditEvent` → separate `getServiceClient()` connection, `write_audit_log` RPC, **never throws/rejects**, returns `AuditWriteOutcome` |
| Frontend | `apps/web/src/api/alertCenter.ts` read-only wrappers (`list`/`analytics`); `AdminAlerts.tsx` renders no mutation controls |
| Tests | `enterprise_command_center.test.ts` (RPC-level lifecycle + suppression + not-found, single connection); `alert_center_http.test.ts` (13 read-only HTTP, no mutation) |

**Re-verified write-path facts (drive §7/§8):**

- Edge pre-read `loadAuthorizedAlert` (index.ts L119–150) is an **unlocked,
  service-role** read with **no hospital filter**; `!data` → `ValidationError`
  (422); `hospital_id !== header` → `ForbiddenError` (403). It runs **before**
  `db.rpc`, so its result is **not** lock-consistent with the mutation.
  `[EXISTING FACT]`
- On RPC error the Edge throws a generic `InternalError` (500) regardless of the
  underlying SQLSTATE — so a DB `42501` reaching PostgREST currently yields 500,
  not 403. `[EXISTING FACT]`
- Each row RPC already holds the pre-mutation column values in `v_alert RECORD`
  immediately after `SELECT … FOR UPDATE`, performs a single `UPDATE`, then
  `PERFORM log_alert_activity(...)`, then returns a `jsonb_build_object(...)`.
  The locked "before" state is therefore **already present in-scope**; the "after"
  state is a re-read away while the same lock is still held. `[EXISTING FACT]`

---

## 4. Current migration frontier

`[EXISTING FACT]` (freshly re-checked this task; §6 requires re-check at
implementation regardless)

```
Current migration frontier:   63  (63_consultation_notes_staff_read.sql)
Next available number:        64  — but MUST be re-verified immediately before
                                     naming, because unrelated 64+ work may land.
Permanently occupied, never reuse: 50, 51, 52, 53 (real worker/lease/scheduler fixes)
Historical dependencies (DO NOT EDIT): 47, 48
```

No C2 migration is created by this task. `<NEXT_AVAILABLE>` is used throughout.

---

## 5. Existing RPC transaction model

`[EXISTING FACT]` — unchanged by the approved decisions. Per row RPC:

```
BEGIN (implicit function transaction)
  SELECT <cols> FROM alert_events WHERE id = p_alert_id FOR UPDATE;   -- row lock acquired
  IF row IS NULL            -> RETURN {ok:false, reason:'alert_not_found'}
  IF NOT has_permission(...)-> RAISE EXCEPTION ERRCODE '42501'         -- in-DB authz (mig 48)
  IF guard(field)           -> RETURN {ok:true, already_<op>:true}     -- idempotent soft-success
  UPDATE alert_events SET <field> ...;                                 -- single write, no partial state
  PERFORM log_alert_activity(...);                                     -- same transaction
  RETURN {ok:true, already_<op>:false};
COMMIT
```

- **Atomicity** of state + activity log: satisfied (the `PERFORM log_alert_activity`
  aborts the whole function if the INSERT fails). `[EXISTING FACT]`
- **Serialization**: `FOR UPDATE` on a single row; each RPC locks exactly one
  alert row; suppression locks none; cross-row deadlock impossible. `[EXISTING FACT]`
- **Idempotency**: state guard keyed on committed field, not request identity.
  Suppression intentionally has none (OD-b). `[EXISTING FACT]`
- **D1 consequence**: no `is_resolved` guard exists in ACK/ASSIGN/ESCALATE, and
  none is added — post-resolve mutation remains permitted. This is the approved
  behavior, not a defect to fix. `[APPROVED DECISION]`

---

## 6. Locked snapshot design

**Does the locked snapshot require a migration? YES.** `[PROPOSED DESIGN]`
Reasoning, not assumption: the only moment a truthful pre/post pair can be
observed is while `FOR UPDATE` holds the row, which is **inside** the RPC
transaction. An Edge re-read after `db.rpc` returns is post-commit (lock released)
and can be interleaved by a concurrent transition — precisely the stale-`oldData`
gap the design gate §10 identified. Therefore the RPC must capture and return the
snapshot; that changes the function body → requires the additive `<NEXT_AVAILABLE>`
migration (47/48 are never edited).

Smallest additive change (design description only — **do not implement here**):

```
-- inside each row RPC, still under FOR UPDATE:
v_before := row_to_json(v_alert_full);        -- capture authoritative OLD state under lock
<existing UPDATE + PERFORM log_alert_activity unchanged>
SELECT row_to_json(a) INTO v_after FROM alert_events a WHERE a.id = p_alert_id;  -- still locked
RETURN jsonb_build_object(
  'ok', true, 'already_<op>', <bool>,
  'before', v_before,   -- ADDITIVE keys only
  'after',  v_after
);
```

The guard/`already_*`/`alert_not_found`/42501 branches are unchanged; on a soft
`already_*` or rejection no snapshot mutation is required (Edge treats them via
§7/§15). The `before` value can reuse the columns already selected into
`v_alert`; `after` is a locked re-read of the same row.

### Snapshot contract (proposed fields)

`[PROPOSED DESIGN]` Return only audit-relevant lifecycle columns; **no** patient
PII and **no** free-text `message`/`resolution_notes` in the envelope beyond what
is operationally necessary (notes already live in `alert_activity_log`, so the
snapshot need not duplicate them). Minimal set:

```
before/after = {
  id, hospital_id,
  acknowledged_at, acknowledged_by,
  assigned_to,
  escalated_at, escalated_by,
  is_resolved, resolved_at, resolved_by,
  severity
}
```

`resolution_notes` and `alert_events.message` are deliberately **excluded** from
the snapshot payload to avoid copying operational text into every audit row; the
activity log remains the place notes are recorded. `[APPROVED DECISION]` (OD-e
PII-minimisation) applies.

The design **prevents stale pre-lock snapshots** by sourcing `oldData`/`newData`
from these RPC-returned `before`/`after` values instead of `loadAuthorizedAlert`.
`[PROPOSED DESIGN]`

---

## 7. HTTP error mapping design (42501 → 403)

`[APPROVED DECISION]` (OD-e): known SQLSTATE `42501` must map to `ForbiddenError`
(403); **only** 42501; unexpected DB errors stay 500. No new error code
(`FORBIDDEN` / 403 already exists in `_shared/errors.ts`). `[EXISTING FACT]`

Current defect `[EXISTING FACT]`: the Edge wraps **any** rpc `error` in
`InternalError` (500), so a `42501` that reaches PostgREST surfaces as 500.

Design — where to place the mapping (compare, per §11 of the brief):

| Placement | Blast radius | Pros | Cons |
| --- | --- | --- | --- |
| **A. Localized in `alert-center/index.ts`** | One Edge function | Smallest change; C2-scoped; no shared-primitive churn | Duplicated if other functions need the same |
| **B. Shared error-translation layer** (`_shared`) | Every caller of the helper | DRY; consistent; AGENTS.md §6 favors shared primitives | Touches a shared module → wider regression surface; must not change existing 500 semantics for other callers |

**Recommendation: A now, B as a follow-up.** For C2 the localized mapping keeps
blast radius minimal and is sufficient: in the rpc-error branch, detect the
PostgREST error's SQLSTATE/message for `42501` and `throw new ForbiddenError(...)`;
otherwise keep `throw new InternalError(...)` (500). When a second function
needs the same rule, promote it into a shared translator so the pattern is not
copy-pasted. `[PROPOSED DESIGN]` Do not modify either file in this task.

Reference mapping target `[PROPOSED DESIGN]`:

```
rpc error is 42501 privilege denial  -> ForbiddenError   -> 403 FORBIDDEN
rpc error otherwise (unexpected)     -> InternalError     -> 500 INTERNAL_ERROR
```

In practice the common denials (role, wrong-hospital, anonymous) are still caught
**before** the RPC by `requireRole`/`loadAuthorizedAlert`/`resolveAuth` and already
return 403/403/401 `[EXISTING FACT]`; the 42501 path is defense-in-depth for a
denial that slips past the Edge checks and is raised by `has_permission`. The
write-path fail-closed behavior is `[UNPROVEN]` today (only reads are proven by
`alert_center_http.test.ts`).

---

## 8. HTTP contract (frozen)

`[APPROVED DECISION]` (OD-e) — the C2 write contract uses exactly:

| Status | Condition | Code |
| --- | --- | --- |
| **200** | lifecycle success; also soft-success `already_acknowledged` / `already_assigned` / `already_resolved` / `already_escalated` (`ok:true`) | success envelope |
| **401** | anonymous / unauthenticated (`resolveAuth` fails) | `UNAUTHORIZED` |
| **403** | insufficient role (`ROLE_INSUFFICIENT`), wrong hospital (`FORBIDDEN`/`HOSPITAL_ACCESS_DENIED`), **and DB `42501` → `FORBIDDEN` after §7** | `FORBIDDEN` family |
| **405** | non-POST method | raw `Response("Method Not Allowed",405)` `[EXISTING FACT]` |
| **422** | zod validation; **alert not found**; `window_in_past`; known client-caused business validation | `VALIDATION_ERROR` |
| **500** | unexpected database/server failure only (state rolled back) | `INTERNAL_ERROR` |

Do **not** introduce **404 / 409 / 428**: no existing SETURA code path uses them
here, soft-success is 200 (not 409), and not-found is 422 (not 404). `[APPROVED DECISION]`
If a future requirement forces one, it must be raised as a new owner decision,
not slipped into implementation. `[OUT OF SCOPE]` for this gate.

---

## 9. Concurrency test design

`FOR UPDATE` is already the mechanism; it is **not** redesigned. `[APPROVED DECISION]`
Design the **missing** true two-connection verification (independent DB
connections, real local Supabase stack). None of these tests exist today
`[UNPROVEN]`; this section defines the burden, not a pass claim.

Per case define: lock ordering, final state, number of `alert_activity_log` rows,
expected `already_*`, absence of lost update, rollback behavior.

| Case | A ‖ B | Lock ordering | Expected final state | Activity rows | `already_*` | Lost update |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | RESOLVE ‖ ACKNOWLEDGE | serialized by row lock; commit order = arrival order | **both** `is_resolved=true` and `acknowledged_at` set (independent fields) | 2 (each is a real transition) | none | none (guarded) |
| 2 | RESOLVE ‖ ESCALATE | serialized | `is_resolved=true` **and** `escalated_at` set, `severity=critical` | 2 | none | none |
| 3 | RESOLVE ‖ RESOLVE | first wins, second blocks then re-reads | `is_resolved=true` | **exactly 1** | one `already_resolved` | none |
| 4 | ESCALATE ‖ ESCALATE | serialized | `escalated_at` set once | **exactly 1** | one `already_escalated` | none |
| 5 | ASSIGN X ‖ ASSIGN Y | serialized | `assigned_to` = last committer (last-writer-wins by design) | **2** (X then Y are distinct real transitions) | only if X==Y | none |
| 6 | ACKNOWLEDGE ‖ ACKNOWLEDGE | serialized | `acknowledged_at` set once | **exactly 1** | one `already_acknowledged` | none |

Notes:
- Under **D1**, cases 1 and 2 are expected to **both persist** — the test must
  assert exactly that, and must **not** be written to expect a post-resolve
  rejection (that would be a D2 test). `[APPROVED DECISION]` OD-d=D1
- Rollback behavior: if the activity `INSERT` fails, the whole function aborts and
  neither the state change nor the activity row persists — prove this by failure
  injection (`[UNPROVEN]`). `[PROPOSED DESIGN]`
- Snapshot interplay: for a real transition the returned `before`/`after` must
  reflect the locked values at that transaction's commit point, not the Edge
  pre-read — assert the losing txn's snapshot is internally consistent with the
  row it observed under lock. `[PROPOSED DESIGN]`

---

## 10. Write-path HTTP test design (H1–H15)

Current HTTP tests are read-only `[EXISTING FACT]`. Add write cases against the
real Edge Runtime (see §15 prerequisite). `[UNPROVEN]` until written; must be
deterministic per the frozen §8 contract.

| # | Scenario | Expected |
| --- | --- | --- |
| H1 | hospital_admin success (each of ack/assign/resolve/escalate) | 200 `ok:true` |
| H2 | global_admin scoped via X-Hospital-ID | 200 `ok:true` |
| H3 | receptionist denied | 403 `ROLE_INSUFFICIENT` (fail-closed, not 500) |
| H4 | doctor denied | 403 `ROLE_INSUFFICIENT` |
| H5 | anonymous | 401 `UNAUTHORIZED` |
| H6 | missing `X-Hospital-ID` | 422 `VALIDATION_ERROR` `[EXISTING FACT]` (missing-header → ValidationError) |
| H7 | cross-tenant (A header, B alert) | 403 (Edge hospital-equality check), **zero** state change |
| H8 | validation failure (bad uuid / missing alertId / bad suppress shape) | 422 |
| H9 | already_* replay | 200 with `already_*` true, exactly one activity row total |
| H10 | concurrent operation (HTTP-level, pairs with §9) | 200s; deterministic serialized result |
| H11 | **resolved-state behavior under D1** — ACK/ASSIGN/ESCALATE on a resolved alert | **200 permitted** (backend unchanged); must NOT be written as a D2 rejection |
| H12 | audit/activity correctness | activity row count == real transitions; audit old/new sourced from locked snapshot |
| H13 | unexpected side-effect check | no job queued, no WhatsApp sent, no financial write |
| H14 | PII safety | no patient PII in logs/response/snapshot (§6 exclusion) |
| H15 | **500-vs-403 fail-closed** — force a DB 42501 and a genuine unexpected DB error | 42501→**403** (after §7); unexpected→**500**; never a role/tenant denial as 500 |

`[PROPOSED DESIGN]`. H7/H15 are the write analogues of the existing read fail-closed
proofs; the design gate flagged the write path as the current proof gap.

---

## 11. Audit semantics

`[APPROVED DECISION]` OD-a: platform audit remains **best-effort**. It is written
on a **separate** connection via `write_audit_log` and never throws `[EXISTING FACT]`
(`_shared/audit.ts`). No trigger, no in-txn audit writer, no audit rewrite.

Purpose of the snapshot is **not** to make audit atomic — it is to make the
best-effort audit row **truthful** with respect to the lifecycle transaction:

```
oldData = the RPC's locked `before` snapshot
newData = the RPC's locked `after` snapshot (committed in the same transaction)
```

The Edge builds `logAuditEvent({ oldData, newData })` from the RPC `result` rather
than from `loadAuthorizedAlert` `[PROPOSED DESIGN]`. A lost audit write remains
possible and acceptable; the transactional `alert_activity_log` is the
authoritative per-transition record. `[APPROVED DECISION]`

---

## 12. Security / SECURITY DEFINER review

- The four row RPCs and `suppress_alerts` are `SECURITY DEFINER`,
  `SET search_path = public`, service_role-only at the DB; a browser cannot invoke
  them directly. `[EXISTING FACT]`
- **F16-04 nuance (precise).** The snapshot migration performs `CREATE OR REPLACE
  FUNCTION` on the **same existing signatures** (same parameter list, same name).
  `CREATE OR REPLACE` does **not** create a new catalog object — it redefines the
  existing function **OID**, so `pg_proc.proacl` (the 48-era REVOKE/GRANT posture)
  is **preserved automatically**; a same-signature re-sign does **not** require a
  fresh REVOKE. This is the opposite of a **brand-new** `SECURITY DEFINER` (e.g. a
  `reopen_alert`, **not** built under D1) which would need its own explicit REVOKE.
  `[PROPOSED DESIGN]`
- Still, the design **must not assume** — post-application **catalog verification**
  is required: read `pg_proc.proacl` and `has_function_privilege()` for
  `anon`/`authenticated`/`service_role` on each touched function after the
  migration, and confirm `search_path` stayed pinned. `[PROPOSED DESIGN]`
  (AGENTS.md §7: verify the catalog, not migration text.)
- Function ownership / grantor: unchanged by a same-signature re-sign (owner stays
  `supabase_admin`/migration role as already established). No GRANT changes are
  made in this design. `[PROPOSED DESIGN]`
- Tenant isolation: two layers remain (Edge hospital-equality check + in-DB
  `has_permission` 42501). The snapshot adds no new read path that bypasses
  either; `after` is re-read under the already-held lock. `[EXISTING FACT]`
- Injection: snapshot uses `row_to_json` of a locked record into JSONB — no string
  interpolation of untrusted values. `[PROPOSED DESIGN]`
- Regression risk: re-signing bodies risks diverging from 48's authorization block
  if the copy omits the `has_permission` check — mitigation: the new migration is
  authored **from the 48 bodies** (authz + guards preserved verbatim) plus the
  snapshot additions, and privilege tests (§9/H15) guard it. `[PROPOSED DESIGN]`

---

## 13. Migration ordering

`[PROPOSED DESIGN]` Intended dependency chain (numbers are `<NEXT_AVAILABLE>`
placeholders; re-check the live frontier at implementation):

```
47  (bodies)
 ↓
48  (in-DB has_permission re-sign)   [historical — DO NOT EDIT]
 ↓
<NEXT_AVAILABLE>_c2_alert_rpc_locked_snapshot.sql   [new; CREATE OR REPLACE 4 row RPCs from the 48 bodies + add locked before/after keys]
```

- Never 50–53. Never edit 47/48.
- Content scope: **only** the four row-mutation RPC bodies gain `before`/`after`.
  Suppression is **excluded** (no lifecycle state, no activity row, OD-b benign;
  a snapshot adds nothing and risks implying an idempotency it deliberately lacks).
- If additional C2 SQL is ever required later, order assertions (47⊂48⊂N) should be
  asserted via `validate:migrations` on a fresh 0→N apply. `[UNPROVEN]` until run.

---

## 14. Backward compatibility

`[PROPOSED DESIGN]` (grounded in `[EXISTING FACT]` result shapes)

- The added `before`/`after` keys are **purely additive** to the returned JSONB.
  Existing consumers read `result.ok`, `already_*`, `reason`, `suppression_id` —
  none are removed or renamed. `[EXISTING FACT]`
- Existing direct-RPC tests in `enterprise_command_center.test.ts` assert on
  `ok`/`already_*`/`reason` only; additive keys do not break them. `[EXISTING FACT]`
- The Edge can ignore the snapshot (still functional) or consume it; adoption is
  independent of the additive DB change, enabling staged rollout.
- No frontend mutation surface is required; `alertCenter.ts`/`AdminAlerts.tsx`
  stay read-only. `[APPROVED DECISION]` OD-g / OD-d(D1)
- `gen:types` regeneration: the RPC return type is JSONB (`RETURNS JSONB`), so the
  generated `database.generated.ts` signature is unchanged by new JSONB **keys**.
  No type churn expected `[PROPOSED DESIGN]` — verify `gen:types:check` at impl.

---

## 15. Failure / recovery semantics

| Condition | Behavior | Status |
| --- | --- | --- |
| Migration failure | apply aborted; prior RPCs intact; no data change | `[PROPOSED DESIGN]` |
| RPC failure (plpgsql exception) | whole function transaction rolls back; state + activity unchanged → Edge 500 (or 403 for 42501 after §7) | `[EXISTING FACT]` |
| activity-log INSERT failure | aborts function → state rolled back (this **is** the atomicity guarantee) | `[EXISTING FACT]` structure / `[UNPROVEN]` injection test |
| audit failure | swallowed (best-effort); transition still commits; activity log authoritative | `[APPROVED DECISION]` OD-a |
| **Edge response loss** | NOT equivalent to rollback — DB may have committed. Client must **refetch authoritative state; never blindly resend.** Row ops converge via guard (`already_*`); **suppression must NEVER auto-resend** (a resend creates a second window; no `already_*`) | `[APPROVED DECISION]` OD-b/OD-f |
| HTTP timeout / non-2xx transport error | indeterminate → refetch, then decide; distinguish from definite 4xx rejection | `[PROPOSED DESIGN]` |
| client retry | row ops safe (guard); suppression retry forbidden | `[APPROVED DECISION]` |

**Edge Runtime prerequisite (F16-01):** `supabase start` returning exit 0 is
**NOT** sufficient — the container has `RestartPolicy=no` and can be down while
the CLI exits 0. Any real-HTTP certification (§10) is invalid unless the
implementation/test gate **explicitly verifies Edge Runtime is serving** first.
`[APPROVED DECISION]` / gate requirement. `[EXISTING FACT]` (F16-01).

---

## 16. Alternatives

| Option | Description | Migration? | Correctness / trade-offs |
| --- | --- | --- | --- |
| **A** | No DB change; Edge 42501→403 + full H1–H15 + concurrency tests | **No** | Closes the authorization-contract and proof gaps; **cannot** fix the stale pre-lock audit snapshot (best-effort audit keeps a non-authoritative `oldData`). Minimal blast radius. |
| **B** | Extend the four row RPC returns with locked `before`/`after`; Edge sources audit from them | **Yes** (one additive) | Closes the last demonstrated gap (truthful snapshot under concurrency); additive & backward compatible; same-signature re-sign preserves ACL (§12). Slight: body-copy risk mitigated by authoring from 48 + tests. |
| **C** | Separate read-only audit-snapshot RPC called after the mutation | Yes (new function) | New `SECURITY DEFINER` → triggers full F16-04 REVOKE + catalog verification; and a post-commit read is **not** lock-consistent, so it does **not** actually solve staleness. Rejected. |
| **D** | Other | — | No source evidence supports a further option. Rejected. |

`[PROPOSED DESIGN]` No numeric scoring. C is rejected specifically because it
re-introduces the read-modify-write window `FOR UPDATE` already closes and pays a
new-function REVOKE to do so.

---

## 17. Recommended architecture

**A + B.** Adopt **Option A** as the mandatory core (Edge 42501→403 mapping and the
complete §9/§10 test suite require **no migration**), and adopt **Option B** — a
single additive `<NEXT_AVAILABLE>` migration re-signing only the four row RPCs to
return the locked `before`/`after` snapshot — because OD-f closed with the
snapshot carrying concrete value and B is the only way to make the best-effort
audit truthful under concurrency without a second state machine, a new function,
or touching global audit. Reject C and D. `[PROPOSED DESIGN]`

The migration is therefore required **if and only if** the snapshot (B) is built;
the security/HTTP/test closure (A) stands on its own with no DB change. This gate
recommends building B. `[APPROVED DECISION]` (OD-f) + `[PROPOSED DESIGN]`

Kept unchanged: 47/48 RPCs as the atomicity engine `[EXISTING FACT]`; `FOR UPDATE`
serialization; in-transaction `log_alert_activity`; best-effort `logAuditEvent`;
independent-field model; suppression semantics. `[APPROVED DECISION]`

---

## 18. Exact future file impact

`[PROPOSED DESIGN]` — minimal set a future (separately authorized) implementation
MAY touch:

| File | Change |
| --- | --- |
| `supabase/migrations/<NEXT_AVAILABLE>_c2_alert_rpc_locked_snapshot.sql` | **New.** Re-sign 4 row RPC bodies (from 48) to add locked `before`/`after`. No authz/guard change. Suppression excluded. |
| `supabase/functions/alert-center/index.ts` | **Adapt.** 42501→403 in rpc-error branch; build audit `oldData`/`newData` from RPC `before`/`after`. |
| `tests/integration/enterprise_command_center.test.ts` | **Extend.** Two-connection concurrency (§9) + failure-injection + snapshot assertions. Existing assertions kept. |
| `tests/integration/alert_center_http.test.ts` | **Extend.** H1–H15 write cases (§10), including H11 D1-permitted and H15 fail-closed. Existing read cases kept. |

Possibly (only if a shared translator is chosen in §7 Option B):
`supabase/functions/_shared/errors.ts` / a small shared helper. **Not** recommended
for C2 scope.

Explicit non-touches:

```
Migrations 47/48:        DO NOT EDIT
C2b broadcasts:          DO NOT TOUCH
G-03…G-11:               DO NOT TOUCH
Frontend:                NO C2 mutation UI in this gate (alertCenter.ts / AdminAlerts.tsx unchanged)
RLS / grants:            no changes (same-signature re-sign preserves ACL — verify, don't re-grant)
worker / scheduler / financial / payments / settlement: OUT OF SCOPE
```

---

## 19. Definition of done (future implementation)

Not complete on compile alone. Must prove `[UNPROVEN]` → verified:

- **Database:** lifecycle stays atomic; locked `before`/`after` is authoritative
  (sourced under lock, not from the Edge pre-read); activity remains transactional;
  no lost update across §9 cases 1–6.
- **Security:** 42501 → 403 proven on the write path; tenant & role isolation
  intact; `pg_proc.proacl` catalog-verified after the re-sign (no accidental grant
  widening); `search_path` still pinned.
- **HTTP:** H1–H15 pass with real Edge Runtime **explicitly proven serving**
  (F16-01); no authorization denial ever surfaces as 500.
- **Concurrency:** true two-connection tests deterministic; exactly-one activity
  row per real transition; correct `already_*`.
- **Regression:** existing alert lifecycle + 13 read HTTP tests + full G-03…G-11
  suites green; `deno task check`/`lint`/`validate:migrations` pass; `gen:types:check`
  clean.
- **Safety:** no migration-history rewrite; no production change; no claim exceeds
  its evidence tier (AGENTS.md §5).

---

## 20. Evidence requirements

Every completion claim must map to the matching tier: IMPLEMENTED ≠
STATICALLY VERIFIED ≠ UNIT ≠ INTEGRATION VERIFIED ≠ RUNTIME ≠ PRODUCTION
`[APPROVED DECISION]`. Local HTTP ≠ staging/production. The design gate's
atomicity claims are `[EXISTING FACT]` from source; the **runtime proof** of
serialization, fail-closed writes, and snapshot truthfulness is `[UNPROVEN]` until
the §9/§10 tests actually run against the real stack with Edge Runtime serving.
`validate:migrations` and `fmt:check` baselines (0 errors / 4 pre-existing
duplicate-object warnings) must not regress.

---

## 21. Implementation preconditions (each must hold first)

1. **Owner decisions closed** — done: OD-d = D1 `[APPROVED DECISION]`; all others closed.
2. **Migration frontier re-checked** at implementation (currently 63; allocate the
   real next number; never 50–53). `[PROPOSED DESIGN]`
3. **Snapshot adoption confirmed in scope** — the migration exists **only** for B;
   if B is later descoped, implementation is Edge+test only with **no migration**.
4. **Migration design review** — this document is that review; sign-off required
   before authoring SQL.
5. **Test matrix approved** — §9 concurrency + §10 H1–H15 + failure injection +
   catalog ACL check.
6. **F16-04 posture understood** — same-signature re-sign preserves ACL; new
   functions (none here) would need explicit REVOKE; verification is catalog-based.
7. **Edge Runtime serving verified** before interpreting any HTTP result.

---

## 22. Final verdict

```text
MIGRATION DESIGN READY FOR IMPLEMENTATION REVIEW
```

The approved architecture is repository-grounded: atomicity, authorization,
serialization and activity-log atomicity already exist in 47/48 and are kept
unchanged under D1. Exactly **one additive migration** is required — solely for the
locked `before`/`after` audit snapshot (Option B) — and it is same-signature re-sign
so the ACL is preserved (verify, do not re-grant). The 42501→403 fix and the entire
concurrency/write-test suite need **no migration**. Implementation itself remains a
separate authorization gate; this document authorizes none.

```text
Repository changes made by this task: NONE
Migrations created: NONE
Database mutations: NONE
Commits / push / deploy: NONE
```
