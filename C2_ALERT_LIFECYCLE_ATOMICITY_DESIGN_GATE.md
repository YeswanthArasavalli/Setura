# SETURA — GREENFIELD C2 ALERT LIFECYCLE ATOMICITY DESIGN GATE

**Class:** Architecture / design gate only. No source, SQL, migration, Edge,
frontend, test or generated artifact was created or modified. The only artifact
is this document.

Every conclusion is tagged:
`[EXISTING FACT]` · `[DESIGN REQUIREMENT]` · `[PROPOSED ARCHITECTURE]` ·
`[OWNER DECISION REQUIRED]` · `[UNPROVEN]`.

---

## 1. Executive summary

The task brief is framed as "design how the alert lifecycle *becomes*
transactionally authoritative." Direct inspection of the current repository
overturns that premise and reframes the problem:

- **The four target-alert lifecycle mutations (`acknowledge_alert`,
  `assign_alert`, `resolve_alert`, `escalate_alert`) and the key-based
  `suppress_alerts` are ALREADY atomic, row-locked, state-guarded and
  in-database-authorized.** Each is a single `SECURITY DEFINER` PL/pgSQL
  function that, inside one implicit transaction, does
  `SELECT … FOR UPDATE` → permission check (`has_permission`, SQLSTATE 42501)
  → state guard → `UPDATE` → inline `log_alert_activity` `INSERT` → returns a
  self-contained JSONB result. `[EXISTING FACT]`
- The SETURA transport **does not re-read lifecycle state in a separate
  transaction after the RPC.** It returns the RPC's own JSONB outcome directly.
  Therefore the S1-A "post-atomicity read consistency" defect that motivated the
  (proven-unrecoverable) missing candidate **does not structurally exist in this
  repository.** `[EXISTING FACT]` (see `supabase/functions/alert-center/index.ts`
  L341–394)

The real, residual correctness/verifiability gaps are therefore **narrower and
different** from the missing S1-A design:

1. **Audit vs activity atomicity asymmetry.** The activity log commits with the
   state (in-transaction). The platform audit event is an **Edge-side,
   best-effort** write (`logAuditEvent` never throws — `_shared/audit.ts`)
   captured in a *different* transaction from the mutation. `[EXISTING FACT]`
2. **Stale audit snapshot under concurrency.** `oldData` is read by
   `loadAuthorizedAlert` *before* the RPC's `FOR UPDATE`, so a concurrent
   transition can make the audit snapshot non-authoritative (TOCTOU on the
   snapshot only, not on state correctness). `[EXISTING FACT]`
3. **No machine-readable transaction status.** The transport infers outcome
   from HTTP 2xx + `result.ok`/`already_*`. "Committed-but-response-lost" is
   indistinguishable from "not committed" at the contract level, though the
   state guards make retry converge for the four row mutations. `[EXISTING FACT]`
4. **Missing verification coverage.** No concurrency/lost-update test, no
   response-loss/retry test, no exactly-once activity test against the real
   stack. `[EXISTING FACT]`

Consequently the smallest correct architecture is **not a rewrite** (AGENTS.md
§6: reuse the platform primitive). It is: keep the existing operation-specific
transactional RPCs as the atomicity engine, and optionally add (a) an
in-transaction audit snapshot, (b) a versioned status envelope, (c) the missing
tests. Whether (a) and (b) are required are **OWNER DECISIONS**, not engineer
defaults. `[PROPOSED ARCHITECTURE]`

**Verdict (§30): DESIGN READY FOR OWNER REVIEW**, gated on the owner decisions
in §25.

---

## 2. Repository baseline

| Item | Verified value |
| --- | --- |
| Strict HEAD | `0fceb50b0ca9b9971af1bebb3938583b78ace4dd` |
| Branch | `main` |
| Latest migration number | **63** (`63_consultation_notes_staff_read.sql`) — NOT 60 |
| Real 50–53 | `50_p0a_fail_job_v2_dead_letter_fix`, `51_p0e_claim_jobs_v2_lease_fix`, `52_w1_detect_crashed_workers_ambiguity_fix`, `53_phase2_scheduler_and_autonomous_recovery` |
| Alert lifecycle SQL authority | `supabase/migrations/47_enterprise_command_center.sql` (bodies) re-signed in `48_privilege_hardening.sql` (adds in-DB `has_permission` authorization; bodies otherwise unchanged) |
| Alert Edge transport | `supabase/functions/alert-center/index.ts` |
| Alert frontend | `apps/web/src/api/alertCenter.ts`, `apps/web/src/routes/AdminAlerts.tsx` — **read-only (G-10)** |
| Alert tests | `tests/integration/alert_center_http.test.ts` (13 read-only HTTP), `tests/integration/enterprise_command_center.test.ts` (includes DB-level lifecycle + one HTTP acknowledge-audited) |

Working tree before/after this task: only the pre-existing
`M graphify-out/cache/stat-index.json` and pre-existing untracked report
artifacts. No source touched. `[EXISTING FACT]`

**Lineage note (provenance carried forward):** `S1_A_CANDIDATE_PROVENANCE_REPORT.md`
established the missing candidate cannot be recovered and its 50–53 numbering
collides with real history. This gate therefore treats atomicity as a **new,
repository-grounded design**, renumbered after the real frontier. `[EXISTING FACT]`

---

## 3. Current-source findings (what the code actually does)

- `alert_events` gained independent nullable columns in migration 47 (L73–81):
  `acknowledged_at/by`, `assigned_to/at`, `escalated_at/by`,
  `resolution_notes`, `alert_category`; resolution already existed
  (`is_resolved`, `resolved_at`, `resolved_by`). **There is no single status
  enum.** `[EXISTING FACT]`
- `alert_activity_log` (47 L86–98) is append-only, `alert_id` FK
  `ON DELETE CASCADE`, indexed `(alert_id, created_at)`. `[EXISTING FACT]`
- `alert_suppressions` (47 L103–119) is key-scoped with
  `CHECK (active_until > active_from)`, `hospital_id` nullable (NULL =
  platform-wide), indexed `(alert_key, active_until)`. **No uniqueness
  constraint.** `[EXISTING FACT]`
- `is_alert_suppressed` (47 L121) — STABLE SQL predicate honoring
  `hospital_id = p OR hospital_id IS NULL` and `now() BETWEEN active_from AND
  active_until`. `[EXISTING FACT]`
- `fire_managed_alert` (47 L391–433) wraps `fire_alert` (defined in migration
  24 L216, with a 1-hour dedupe) behind the suppression predicate, then stamps
  `alert_category`. `[EXISTING FACT]`
- `get_alert_center` (47 L435–506) — STABLE, SECURITY DEFINER, returns
  `{alerts[], counts{open,acknowledged,escalated,critical_open}}`; every field
  the frontend reads already originates here. `[EXISTING FACT]`
- Migration 48 (L108–360) re-signs each mutation with an in-DB
  `has_permission(p_actor_id, v_alert.hospital_id, 'MANAGE_HOSPITAL')` that
  `RAISE EXCEPTION … ERRCODE='42501'` on denial; **state guards and inline
  `log_alert_activity` are preserved**; suppression authorizes *before* the
  window check. `[EXISTING FACT]`
- Edge transport order (index.ts): `handleCors` → POST-only → `X-Hospital-ID`
  presence → `resolveAuth(req, hospitalId)` →
  `requireRole([hospital_admin, global_admin])` → `parseBody(zod)` → per-action.
  Mutations: `loadAuthorizedAlert` (unlocked read + hospital-equality check) →
  `db.rpc(<lifecycle>)` → `logAuditEvent` (best-effort) →
  `successResponse({action, alertId, result})`. RPC client error →
  `InternalError`; `outcome.ok !== true` → `ValidationError`. `[EXISTING FACT]`
- Alert RPCs are `service_role`-only at the DB; a browser cannot invoke them
  directly (asserted by `alert_center_http.test.ts` "client roles cannot call
  the alert RPCs directly" and documented in `alertCenter.ts` L25–30).
  `[EXISTING FACT]`

---

## 4. Existing C2 lifecycle — per-operation dossier

Legend: **AuthZ** = who may call; **Guard** = state/idempotency condition;
**In-txn** = commits in the same PostgreSQL transaction as the state change.

| # | Operation | Entry point | Request (Edge zod) | AuthZ (Edge + DB) | Tenant validation | SQL/RPC | Transaction boundary | Row lock | State guard | Idempotency | Activity log | Audit | Side effects | Error semantics | HTTP | Frontend | Tests | Gaps | Redesign needed? |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | ACKNOWLEDGE | `index.ts` acknowledge→rpc | `{action,alertId}` | role∈{hosp,global}_admin **and** `has_permission(MANAGE_HOSPITAL)` 42501 | Edge `hospital_id==row.hospital_id` + RPC hospital-derived from locked row | `acknowledge_alert(p_alert_id,p_actor_id)` 47/48 | single fn txn | `FOR UPDATE` on `alert_events.id` | `acknowledged_at IS NOT NULL`→already | guard+lock | in-txn `log_alert_activity('acknowledged')` | Edge best-effort | none | `ok=false reason=alert_not_found`→400; 42501→403; rpc err→500 | 200 `{ok,already_acknowledged}` | read-only UI (no button) | `ent: …acknowledge…`; no concurrency test | audit not in txn; stale snapshot | **No** (atomic already) |
| 2 | ASSIGN | assign→rpc | `{action,alertId,assigneeId}` | same | same | `assign_alert(p_alert_id,p_assignee_id,p_actor_id)` | single fn txn | `FOR UPDATE` | `assigned_to IS NOT DISTINCT FROM p_assignee_id`→already | guard+lock | in-txn `'assigned'` (notes=assignee) | best-effort | none | as ack | 200 `{ok,already_assigned}` | **not in read UI** (C2 §OD-1 descope) | covered in `ent:` rpc test | assignee directory/UX absent by design | **No**; assign product scope = OWNER |
| 3 | RESOLVE | resolve→rpc | `{action,alertId,notes?}` | same | same | `resolve_alert(p_alert_id,p_actor_id,p_notes)` | single fn txn | `FOR UPDATE` | `is_resolved`→already | guard+lock | in-txn `'resolved'` | best-effort | none | as ack | 200 `{ok,already_resolved}` | no button | `ent:` rpc test | resolve not terminal at DB (see §6) | **No**; terminality = OWNER |
| 4 | ESCALATE | escalate→rpc | `{action,alertId,notes?}` | same | same | `escalate_alert(p_alert_id,p_actor_id,p_notes)` | single fn txn | `FOR UPDATE` | `escalated_at IS NOT NULL`→already | guard+lock | in-txn `'escalated'` | best-effort | sets `severity='critical'` | as ack | 200 `{ok,already_escalated}` | no button | `ent:` rpc test | unconditional severity override; post-resolve escalate allowed | **No**; policy = OWNER |
| 5 | SUPPRESS | suppress→rpc | `{action,alertKey,activeUntil,reason?}` | `has_permission(MANAGE_HOSPITAL, p_hospital_id)` **first** | p_hospital_id from header; NULL=global | `suppress_alerts(p_alert_key,p_active_until,p_actor_id,p_hospital_id,p_reason)` | single fn txn | **none** (key-based insert) | `active_until<=now()`→`window_in_past` | **none by design** | **no activity row** (not alert-scoped) | best-effort (`entityType=alert_suppression`) | none | `ok=false reason=window_in_past`→400; 42501→403 | 200 `{ok,suppression_id}` | no button | `ent: suppression windows gate firing` | duplicate windows accumulate; not idempotent | **No** (accepted: OD-3) |

Suppression is **semantically different** from the four row mutations: it is
key-scoped, creates a new temporal window, writes no activity row, and is not
made idempotent (per the C2 owner decision OD-3 and AGENTS.md §8 "existence
semantics"). It must not be modeled as a state transition. `[EXISTING FACT]` +
`[OWNER DECISION REQUIRED]` (§25 OD-b)

---

## 5. The actual atomicity problem, defined precisely (§8)

| Facet | Current status | Classification |
|---|---|---|
| A. State mutation atomicity | Single-fn txn; no partial field update possible (one UPDATE). | `[EXISTING FACT]` satisfied |
| B. Activity-log atomicity | `log_alert_activity` is `PERFORM`ed inside the same txn; if the INSERT fails the whole fn aborts → state cannot commit without its activity row. | `[EXISTING FACT]` satisfied |
| C. Audit atomicity | Platform audit is Edge best-effort in a **separate** txn; `state committed / audit failed` **is possible**. | `[EXISTING FACT]` gap → §9, OD-a |
| D. Snapshot atomicity | `oldData` captured before `FOR UPDATE`; not lock-consistent → snapshot can be stale. | `[EXISTING FACT]` gap → §10 |
| E. Multi-step lifecycle | One request = one operation = one alert row; no cross-record composite write to coordinate. | `[EXISTING FACT]` n/a |
| F. Idempotency under concurrency | Guard + `FOR UPDATE` serialize same-row ops; second txn sees committed state → `already_*`. | `[EXISTING FACT]` satisfied |
| G. Concurrent transitions (see §7) | Serialized by row lock; independent guarded fields (ack/assign/resolve/escalate) all persist. | `[EXISTING FACT]` satisfied |
| H. Transport failure after commit | RPC commits then PostgREST response lost → client sees network error / 5xx; DB is committed. Retry converges for row mutations (guard); suppression duplicates (accepted). | `[EXISTING FACT]` + `[UNPROVEN]` (no test) |
| I. `ROLLBACK_FAILED` | **Does not exist and is not needed here.** The RPC returns a value or raises; plpgsql/PostgREST already rolls back the whole fn txn on error. A separate `ROLLBACK_FAILED` status is an artifact of the missing S1-A candidate's design, not a SETURA requirement. | `[PROPOSED ARCHITECTURE]` do not adopt §8's `OK/ALREADY/ROLLBACK_FAILED` verbatim |

**Key conclusion:** most "atomicity" is already provided by PostgreSQL row
locking + single-transaction functions. The remaining design surface is
audit/snapshot consistency, transport status semantics, and test proof — **not**
a new atomicity engine. `[PROPOSED ARCHITECTURE]`

---

## 6. State model (§10)

Current model: **independent nullable timestamp/flag columns**, not an enum.
This is intentional and load-bearing: it lets acknowledge/assign/escalate/
resolve coexist on one row and lets `get_alert_center.counts` derive multiple
overlapping counts (`open`, `acknowledged`, `escalated`, `critical_open`) in one
pass.

- A canonical lifecycle `status` enum is **NOT recommended** and would be a
  backward-incompatible rewrite of the read contract, every count filter, and
  `fire_managed_alert` interplay. `[PROPOSED ARCHITECTURE]`: keep the
  independent-fields model. `[OWNER DECISION REQUIRED]` OD-c if a single derived
  status is nonetheless wanted for reporting.
- **Derived status** (read-only, computed):
  `resolved = is_resolved`; `escalated = escalated_at NOT NULL`;
  `acknowledged = acknowledged_at NOT NULL`; `assigned = assigned_to NOT NULL`.
  These are non-exclusive by design. `[EXISTING FACT]`
- **Terminal / reopen:** `RESOLVE` is currently **not terminal** at the DB —
  acknowledge/escalate/assign all still succeed after resolution (the C2 spec
  §14 only hides Acknowledge/Escalate in the future UI; the backend permits
  them). No reopen/unresolve transition exists. `[EXISTING FACT]` →
  `[OWNER DECISION REQUIRED]` OD-d (block post-resolve mutation? add reopen?).

---

## 7. Transition matrix (§11) — current vs proposed

Cells: ALLOWED (state changes) · ALREADY-SUCCESS (no-op, `already_*`) ·
REJECTED (guard/validation/authz fail) · OWNER.

Rows = current alert state; columns = requested op. "resolved" = `is_resolved=t`.

| State ↓ / Op → | ACK | ASSIGN | RESOLVE | ESCALATE | SUPPRESS |
|---|---|---|---|---|---|
| fresh (open, unacked) | ALLOWED | ALLOWED | ALLOWED | ALLOWED | ALLOWED (key window) |
| acknowledged | ALREADY-SUCCESS | ALLOWED/ALREADY | ALLOWED | ALLOWED | ALLOWED |
| assigned | ALLOWED/ALREADY | ALREADY-SUCCESS | ALLOWED | ALLOWED | ALLOWED |
| escalated | ALLOWED/ALREADY | ALLOWED/ALREADY | ALLOWED | ALREADY-SUCCESS | ALLOWED |
| resolved | **current: ALLOWED** · proposed: **OWNER (OD-d)** | current: ALLOWED · OWNER | ALREADY-SUCCESS | current: ALLOWED · OWNER | ALLOWED |
| concurrent same-row diff-op | serialized (lock) → both independent fields persist | | | | separate rows, benign (OD-3) |

- **repeated suppression**: always ALLOWED, creates a new window row (ALREADY
  does not apply — no dedupe). `[EXISTING FACT]`
- **resolved + acknowledge / escalate**: DB allows today; C2 product decision is
  to hide in UI. Making it DB-rejected is an owner/product policy change, not a
  correctness fix → **OWNER OD-d**. `[OWNER DECISION REQUIRED]`
- Current behavior is preserved in the recommended design; only the *audit
  snapshot* is corrected. No product semantics change is required to reach
  atomicity. `[PROPOSED ARCHITECTURE]`

---

## 8. Concurrency model (§12)

Mechanism: **pessimistic `SELECT … FOR UPDATE`** on `alert_events.id` inside
each row-mutation RPC. `[EXISTING FACT]` This already gives:

- **Serialization** of all row mutations on the same alert.
- **Lock acquisition** at first statement; **ordering** is a single row → no
  intra-alert deadlock; **cross-row deadlock** is impossible because each RPC
  locks exactly one alert row (suppression locks nothing).
- **Final authoritative state** = whichever txn commits first; the second re-reads
  the locked, updated row and evaluates its guard.

Required cases, evaluated against the real code:

| Case | Sequence | Result under current design | Activity rows | Audit |
|---|---|---|---|---|
| 1 | A: RESOLVE ‖ B: ACK | serialized; both fields persist (`is_resolved` and `acknowledged_at` are independent); order = commit order | one per *real* transition (≤2) | one each, best-effort |
| 2 | A: ESCALATE ‖ B: RESOLVE | serialized; `escalated_at` + `is_resolved` both set | ≤2 | best-effort |
| 3 | two RESOLVE | first ALLOWED, second ALREADY-SUCCESS (`already_resolved`) | **exactly 1** | 2 audit, 1 activity |
| 4 | two ESCALATE | first ALLOWED, second ALREADY-SUCCESS | **exactly 1** | 2 audit, 1 activity |
| 5 | two ASSIGN (same assignee) | first ALLOWED, second ALREADY-SUCCESS; (different assignee) second overwrites — last-writer-wins by design | 1 or 2 | best-effort |
| 6 | two SUPPRESS | two window rows created (no dedupe) | 0 | 2 audit |

**Optimistic versioning / conditional UPDATE alternatives** (§12): a
`version`/`updated_at` CAS or `UPDATE … WHERE guard` would remove the explicit
row lock but re-introduce the read-modify-write window the current `FOR UPDATE`
already closes. Since alert write volume is low (operational, not hot-path), the
pessimistic lock is the simpler correct choice. `[PROPOSED ARCHITECTURE]`:
**retain `FOR UPDATE`; do not replace it.** Retry behavior on 42501/`already_*`
is client-driven; the design must forbid blind suppression retry (§12/§16).

`[UNPROVEN]`: this serialization behavior has never been exercised by a real
two-connection integration test (§19).

---

## 9. Idempotency model (§13)

| Operation | Idempotency mechanism | Same request twice | Concurrent duplicate |
|---|---|---|---|
| ACK/RESOLVE/ESCALATE | **state guard + row lock** (natural idempotency) | `already_*`, no new activity | serialized, exactly-one real transition |
| ASSIGN | guard `IS NOT DISTINCT FROM assignee` + lock | `already_assigned` | serialized; different assignee = last-writer-wins |
| SUPPRESS | **none — intentionally** | new window row each call | two rows (benign, OD-3) |

- No new idempotency key, unique constraint, dedupe column, or transport-level
  idempotency is introduced. The existing `Idempotency-Key` transport in
  `_shared` is **not consumed by `alert-center`** and must not be presented as
  C2 idempotency. `[EXISTING FACT]` `[PROPOSED ARCHITECTURE]`: rely on the DB
  guards; do NOT bolt on a client idempotency mechanism (§13 prohibition).
- Definition per §13 axes for the row mutations: *same alert + same actor + same
  operation* → `already_*` regardless of request id / timestamp, because the
  guard keys on committed state, not on a request identity. Suppression ignores
  these axes (existence semantics).

---

## 10. Audit + activity atomicity, snapshot semantics (§14 + §15)

**Activity:** in-transaction (`PERFORM log_alert_activity`). `state committed /
activity failed` is **not possible** today. Keep it. `[EXISTING FACT]`

**Audit:** `logAuditEvent` is Edge-side, separate connection/transaction, and
**never throws** (`_shared/audit.ts`: "Never throws and never rejects"). So
`state committed / audit failed` **is possible** today. `[EXISTING FACT]`

Options:

- **Option 1 — keep best-effort audit (C2 OD-4 default).** Consequence: an audit
  write can be lost while the transition persists; activity log remains the
  transactionally authoritative record of the transition. Cheapest; no migration.
- **Option 2 — move audit into the RPC transaction** (write `audit_log` inside
  the fn, or add a DB trigger on `alert_activity_log`). Guarantees
  transition⇔audit atomicity, but (i) redesigns the platform audit boundary
  (AGENTS.md §6/§7 security-sensitive: a SECURITY DEFINER writing audit changes
  grants/RLS posture), (ii) needs a new migration, (iii) couples audit failure
  to transition failure.

`[OWNER DECISION REQUIRED]` **OD-a: is strict transition⇔audit atomicity
required, or is best-effort audit acceptable?** Recommendation (not decision):
keep OD-4 best-effort because the activity log is already the transactional
record of truth; do not rewrite global audit for C2.

**Snapshot (§15):** current flow is `read state → (release) → RPC locks+mutates
→ audit uses the pre-read snapshot`. The authoritative ordering is
`lock → capture old → mutate → capture new → audit → commit`. To make the audit
snapshot truthful without moving audit into the txn, the RPC should **return the
actual pre/post values it observed under the lock**, and the Edge should build
`oldData`/`newData` from the **RPC result**, not from the unlocked
`loadAuthorizedAlert` read. `[PROPOSED ARCHITECTURE]` (backward-compatible: an
additive field on the returned JSONB). This directly prevents misleading
snapshots under concurrent transitions. `[DESIGN REQUIREMENT]`

---

## 11. Transaction failure semantics (§16) — observable behavior

| Condition | Current observable | Required definition |
|---|---|---|
| Validation failure (zod) | `ValidationError` → 4xx with field paths | keep |
| Authorization failure (role) | `requireRole` → 403 `ROLE_INSUFFICIENT` | keep |
| Authorization failure (DB) | `has_permission` → `RAISE 42501` → surfaced 403 | must map 42501→403 fail-closed, **not** 500 (`[EXISTING FACT]`: proven for reads; **must prove for writes** §19) |
| Tenant mismatch | Edge `ForbiddenError("…different hospital")` → 403 `HOSPITAL_ACCESS_DENIED` | keep; DB also authorizes |
| Missing alert | RPC `ok=false reason=alert_not_found` → Edge `ValidationError` 4xx | keep; decide 404-vs-400 (OD-e) |
| Invalid transition | (resolve-terminal not modeled today) | only if OD-d selects rejection |
| Duplicate transition | `already_*` `ok=true` → 200 soft-success | keep; must NOT be an error |
| PostgreSQL exception | plpgsql aborts fn → whole txn rolls back → rpc error → `InternalError` 500 | keep; state provably unchanged |
| Constraint violation (e.g. `chk_suppression_window`) | 500 via rpc error today | decide map to 4xx (OD-e) |
| Activity-log failure | aborts fn (in-txn) → 500, state rolled back | keep — this is the atomicity guarantee |
| Audit failure | swallowed (best-effort), transition still commits | only changes if OD-a strict |
| Network failure after DB commit | client sees error/5xx; DB committed | §12 status envelope + refetch; **forbid blind retry** |
| Network failure before DB commit | client sees error; DB unchanged | retry-safe for row ops |
| Edge timeout | 5xx; DB indeterminate | refetch-authoritative |
| Client retry | row ops converge via guard; **suppression duplicates** | no auto-retry for suppression |

No "handle gracefully" hand-waving: every row above is a concrete HTTP status or
DB outcome. `[DESIGN REQUIREMENT]`

---

## 12. HTTP / Edge contract (§17)

- Method: `POST` only (405 otherwise). Headers: `X-Hospital-ID` required.
  Body: `{action, …}` per zod. AuthZ: `hospital_admin`/`global_admin`.
  `[EXISTING FACT]`
- Current success body: `successResponse({action, alertId, result})` where
  `result` is the RPC JSONB. Soft-success currently signalled by
  `result.already_* = true` within HTTP 200. `[EXISTING FACT]`
- **Proposed machine-readable status envelope** `[PROPOSED ARCHITECTURE]`
  (backward-compatible additive fields, so the existing read contract and C2
  Phase-1 spec's `already_*` handling keep working):

  ```
  result = {
    ok: true,
    status: "COMMITTED" | "ALREADY" | "UNKNOWN",   // REJECTED lives at HTTP layer
    already_acknowledged|already_resolved|already_escalated|already_assigned: true (when ALREADY),
    pre:  { …actual snapshot under lock… },         // truthful audit source
    post: { …actual snapshot under lock… }
  }
  ```

  Status rules (mirroring the S1-A intent, re-derived for THIS code):
  COMMITTED requires commit proof (RPC returned success); ALREADY requires the
  guard observed a committed prior transition; **UNKNOWN** is reserved for
  provably-indeterminate transport (response lost) and is the only status the
  client must refetch rather than retry. Suppression has no ALREADY; its success
  is COMMITTED with a `suppression_id`, and its transport-unknown must never be
  auto-retried.
- Distinguishing "did not commit" vs "committed, response lost": a **non-2xx
  transport error** = indeterminate → refetch (never resend, especially
  suppression); a **2xx with `status`** = authoritative. `REJECTED` (validation/
  authz) is a definite 4xx with no state change. `[DESIGN REQUIREMENT]`
- `ROLLBACK_FAILED` is **not adopted**: PostgreSQL already guarantees the fn txn
  is atomic; a returned error *is* the rolled-back case. Adding a distinct status
  would be redundant. `[PROPOSED ARCHITECTURE]`

---

## 13. Tenant isolation & security (§18 + §23)

- Two independent enforcement layers already exist: Edge `loadAuthorizedAlert`
  hospital-equality check **and** the RPC's in-DB
  `has_permission(actor, row.hospital_id, 'MANAGE_HOSPITAL')`. Defense-in-depth
  is intact. `[EXISTING FACT]`
- Malicious `Hospital-A header + Hospital-B alert_id`: Edge rejects with 403
  before the RPC; even if the RPC were reached, `has_permission` re-derives the
  alert's hospital from the locked row and raises 42501. Tenant never comes from
  the body. `[EXISTING FACT]`
- **Security evaluation (design-only, no change made):** SQL injection — RPCs are
  parameterized, `search_path=public` pinned, no interpolation. `[EXISTING FACT]`
  Direct browser RPC — blocked (service_role-only grants). `[EXISTING FACT]`
  SECURITY DEFINER — actor id is passed explicitly and re-authorized in-DB; the
  privilege posture (AGENTS.md §7 / F16-04: new/re-signed SECURITY DEFINER needs
  its own REVOKE) is a **future implementation obligation**, `[UNPROVEN]` for any
  new function this design might add. Alert-id enumeration — not-found returns a
  4xx without leaking cross-tenant existence. Actor/audit spoofing — `p_actor_id`
  = authenticated `auth.userId`, never client body. PII — alerts carry
  operational metrics, not patient PII; no new read is added. `[DESIGN REQUIREMENT]`

---

## 14. Global-admin model (§19)

`global_admin` scopes through `X-Hospital-ID` exactly like `hospital_admin`, and
the RPC's `has_permission` grants global scope only when the target hospital is
NULL/authorized (`48` L102 comment). The frontend reuses the existing G-08
acting-hospital pattern (`fetchActingHospitalContext` / `scopeHospitalId`,
`AdminAlerts.tsx` L150). `[EXISTING FACT]` **No parallel global-admin tenancy
system is proposed.** If a portfolio-wide alert mutation surface is ever wanted,
that is `[OWNER DECISION REQUIRED]` and out of C2 scope.

---

## 15. Migration strategy (§20) — renumbered after the real frontier

The design MUST NOT reuse 50–53. Real latest = 63. `[EXISTING FACT]`

Whether ANY migration is needed depends on the owner decisions; the recommended
core is **frontend/Edge/test-only and needs NO migration** (state machine,
guards, locks, in-DB authz already exist in 47/48). Optional additive migrations
(all **PROPOSED**, numbers assigned only at implementation):

| Proposed | Purpose | Data impact | Lock impact | Rollback | Compat | Staging |
|---|---|---|---|---|---|---|
| `<64>_c2_alert_rpc_snapshot.sql` | re-sign the 4 row RPCs to also `RETURN` locked `pre`/`post` snapshots (truthful audit source) | none | unchanged (`FOR UPDATE` already) | additive; prior bodies recoverable by re-applying 48 text | additive JSONB field | re-run 48 then 64 |
| `<65>_c2_alert_audit_atomic.sql` | **only if OD-a strict**: DB trigger writing `audit_log` in-txn | appends audit rows | serialized by row lock | drop trigger | must respect F16-04 REVOKE for a new SECURITY DEFINER | catalog ACL verify |
| `<66>_c2_migration_order_assertions.sql` | assert dependency order (47⊂48⊂64…) if multiple land | none | none | test-only | — | validate:migrations |

Per §20 each is gated on a genuine need; none is created now. `[PROPOSED
ARCHITECTURE]` `[UNPROVEN]` (numbers may shift as other 64+ work lands — must be
re-checked against the frontier at implementation time).

---

## 16. Historical data / backfill (§21)

The missing S1-A candidate posited a `historical_backfill` migration. For the
**real** repository this is **not required**: the independent-column model in 47
already reads NULL-ably for pre-existing rows (no lifecycle timestamp = not yet
acted), and `get_alert_center` counts handle NULLs directly. `[EXISTING FACT]`
No backfill is proposed. If OD-c (canonical status enum) were ever approved, only
then would a derived-status backfill be considered — with deterministic
`COALESCE`-based derivation, idempotent `UPDATE`, batching and locking defined at
that time. **Decision: NO backfill.** `[PROPOSED ARCHITECTURE]`

---

## 17. Performance (§22)

- Row mutations already serialize per alert; contention only on the *same* alert
  simultaneously — operationally rare. `FOR UPDATE` hold time is one guarded
  UPDATE + one INSERT (activity) → short. `[EXISTING FACT]` structure;
  `[UNPROVEN]` absolute latency (no load test exists).
- Suppression adds a row to `alert_suppressions`; `is_alert_suppressed` reads the
  `(alert_key, active_until)` index. Accumulating duplicate windows grow table
  size but not per-read correctness. `[EXISTING FACT]`
- If OD-a adds an in-txn audit trigger, every mutation additionally writes an
  audit row in-lock — the main performance cost of that option.
- No benchmark numbers are fabricated. `[UNPROVEN]`

---

## 18. Observability (§24)

Reuse existing primitives (`createMetrics`, `createRequestLogger`,
`correlationId`). `[EXISTING FACT]` The design should emit per-mutation, without
a new logging system: action, actor, hospital, alertId, `status`,
`already_*`, transport-unknown count, DB error code (42501 vs other), latency.
Network-ambiguity (status=UNKNOWN / refetch) must be observable and distinguished
from REJECTED. PII/secret logging unchanged (no body/secrets logged).
`[DESIGN REQUIREMENT]`

---

## 19. Test strategy (§25) — what a FUTURE implementation must prove

Existing coverage `[EXISTING FACT]`: `alert_center_http.test.ts` = 13 read-only
HTTP tests; `enterprise_command_center.test.ts` = DB-level
"alert dedupe, acknowledge, assign, escalate, resolve", "suppression windows gate
firing", tenant-scoped list, and HTTP "alert acknowledgment is audited".

Required ADDITIONS (do not weaken existing; per AGENTS.md §12 against the real
stack):

1. **Unit:** guard/`already_*` decision logic and envelope mapping.
2. **Integration (DB):** each transition sets exactly its field + exactly one
   activity row; second call → `already_*` with **no** second activity row.
3. **HTTP H1–H15** (mirror C2 spec §22): hospital_admin success; global_admin
   scoped; receptionist 403; doctor 403; anonymous 401; missing `X-Hospital-ID`;
   **cross-tenant mutation** (A-header/B-alert → 403, no state change); invalid
   suppression window → `window_in_past`; guarded replay; concurrent transitions;
   resolved-state protection; **audit/activity behavior**; no job/WhatsApp side
   effect; PII safety; **denials fail closed with 403/401 not 500** (the write
   analogue of the read test — currently only reads are proven).
4. **Concurrency (MANDATORY, real two connections):** §8 Cases 1–6 with explicit
   assertions — exactly-one activity row per real transition, both independent
   fields persist, no lost update, `FOR UPDATE` serialization observed.
5. **Response-loss / transport-unknown:** commit-then-lose-response, then prove
   refetch reconciles to COMMITTED and that suppression is NOT auto-retried.
6. **Migration:** fresh 0→64 application; **existing-DB upgrade** from real 63.
7. **Failure injection:** activity-INSERT failure → state rolled back (proves
   in-txn atomicity); 42501 mapping.

`[UNPROVEN]` for every item above — none exists today. This section defines the
proof burden; it does not claim any test passes.

---

## 20. Rollback / recovery (§26)

Deployment is non-atomic across layers; compatibility sequencing avoids a hard
cutover: `[PROPOSED ARCHITECTURE]`
1. DB additive (64) first — old Edge + old frontend still work (JSONB gains are
   additive). 2. Edge transport next (reads new fields, still returns old shape).
3. Frontend last. Each step is independently rollbackable because no field is
   removed and no status is made mandatory. If OD-a lands a trigger (65), it can
   be dropped without affecting state correctness (audit reverts to best-effort).
No migration requires an atomic cutover.

---

## 21. C2 Phase-1 compatibility (§27)

The unimplemented C2 Phase-1 frontend mutation workstream (the pasted
`C2_ALERT_LIFECYCLE_IMPLEMENTATION_SPEC.md`) targeted THIS backend and is
largely compatible: `[PROPOSED ARCHITECTURE]`

| Surface | Classification |
|---|---|
| `apps/web/src/api/alertCenter.ts` (read exports) | **KEEP AS-IS** (add mutation wrappers if that workstream proceeds) |
| `AdminAlerts.tsx` (read UI) | **ADAPT** (add mutation buttons; already read-only today) |
| `alert-center` Edge Function | **ADAPT** — only to consume the returned locked snapshot / add `status`; no architectural change |
| Migration 47/48 RPCs | **KEEP AS-IS** (they are already atomic + authorized); optionally **ADAPT** via additive 64 for snapshot |
| Existing HTTP tests | **KEEP AS-IS**, add H1–H15 write cases |
| Existing frontend tests | **KEEP AS-IS**, add mutation cases |

No evidence supports discarding C2 Phase-1; it simply inherits a backend that is
already correct on the atomicity axis. `[EXISTING FACT]`

---

## 22. Scope boundaries (§28)

OUT OF SCOPE (unless an owner decision pulls them in): C2b broadcast composer,
WhatsApp worker activation, `ENABLE_WORKER_TRIGGER`, scheduler changes,
financial/payment/refund/settlement engines, G-03…G-11 closed workstreams,
global audit framework rewrite (see OD-a), hospital tenancy redesign, unrelated
DB cleanup. Assign remains its own future workstream (C2 OD-1). `[DESIGN
REQUIREMENT]` Any dependency discovered is labeled **DEPENDENCY** /
**OWNER DECISION REQUIRED**, never silently built.

---

## 23. Architecture alternatives (§9 / §29) — trade-offs, no numeric scoring

| Option | Correctness/atomicity | Concurrency | Security/tenant | Maintainability | Migration complexity | Compatibility | Testability | Ops |
|---|---|---|---|---|---|---|---|---|
| **A. One RPC per operation (STATUS QUO)** | already atomic (lock+guard+in-txn activity) | row `FOR UPDATE` | in-DB `has_permission` | high — matches platform style | **none** | full | needs tests only | no new moving parts |
| **B. Generic lifecycle-transition RPC** (`transition(alert,op,actor)`) | atomic if single-txn | one lock path | central authz | medium — new indirection; risks a *second* state machine (AGENTS.md §6) | additive but re-signs everything | re-shapes Edge + tests | generic test harness | more surface |
| **C. Shared transactional primitive + thin per-op RPCs** | atomic; shares helper | delegates to A's lock | same | high if reused well; but today the "primitive" is only `log_alert_activity`+guard pattern | low | full | good | modest | 
| **D. Hybrid: keep A, add locked snapshot + optional status envelope** | atomic; truthful audit | unchanged | unchanged | high | **additive/optional** | backward-compatible | targeted tests | minimal |

`[PROPOSED ARCHITECTURE]` **Recommended = Option D (A + additive snapshot/status),
which is Option C in spirit (shared `log_alert_activity` primitive) but chooses
NOT to invent a generic engine.** Rationale (evidence-based, not preference):
the atomicity the brief asks for already exists; B would duplicate an existing
state machine and churn 47/48 for no correctness gain (AGENTS.md §6/§8); C adds
indirection without new capability; D closes only the *demonstrated* gaps
(stale snapshot, no status envelope, no tests) with additive, rollback-safe
changes. `[DESIGN REQUIREMENT]`

---

## 24. Recommended architecture (concrete)

1. Keep migrations 47/48 lifecycle RPCs as the atomicity engine (no rewrite).
2. Additive `<64>` snapshot: RPCs `RETURN` locked `pre`/`post`; Edge builds audit
   `oldData`/`newData` from the RPC result, not the unlocked pre-read.
3. Additive status envelope (§12) in the Edge response; `UNKNOWN` ⇒ client
   **refetch**, never resend; suppression never auto-retried.
4. Do NOT adopt `ROLLBACK_FAILED`; do NOT add client idempotency keys; do NOT
   add suppression dedupe (OD-3).
5. Implement the §19 test matrix (esp. real two-connection concurrency and the
   write-path fail-closed HTTP cases) before any claim of atomicity is made.
6. Best-effort audit stays best-effort **unless** OD-a selects strict atomicity
   (then `<65>` trigger + F16-04 REVOKE discipline).

All of the above is `[PROPOSED ARCHITECTURE]` pending owner sign-off.

---

## 25. Owner decisions (§30)

| ID | Decision | Options | Recommended handling | Blocking? |
|---|---|---|---|---|
| OD-a | Strict transition⇔audit atomicity | best-effort (today) vs in-txn trigger | keep best-effort (activity log is txn-authoritative) | **No** (design can land without it) — but blocks §10 Option 2 |
| OD-b | Suppression duplicate policy | benign (OD-3) vs dedupe/idempotency | keep benign, no dedupe | No |
| OD-c | Canonical lifecycle status enum | keep independent fields (recommended) vs enum | keep independent fields | No (enum would be backward-incompatible) |
| OD-d | Resolved-state mutation policy (post-resolve ack/escalate/assign; reopen) | DB-reject / DB-allow+UI-hide (today) / add reopen | decide product semantics; keep backend unchanged unless chosen | **Yes for transition matrix §7 final cells** |
| OD-e | not-found / constraint-violation HTTP mapping | 404 vs 400; 400 vs 500 | map deterministically (currently 400/500) | **Yes for H-series assertions** |
| OD-f | Machine-readable status envelope | adopt §12 vs keep `ok`/`already_*` only | adopt (backward-compatible) | No |
| OD-g | Assign in-scope now? | defer (C2 OD-1) vs build | defer | No |
| OD-h | Greenfield vs recover-S1-A | this gate already chose greenfield | confirm | Resolved by §2 lineage |

No product policy was silently decided; §7/§6 rows that depend on OD-d/OD-c are
explicitly marked OWNER. `[OWNER DECISION REQUIRED]`

---

## 26. Implementation sequencing (future; nothing runs now) (§33)

```
DESIGN APPROVAL
  ↓
OWNER DECISIONS CLOSED (OD-a, OD-d, OD-e first — they gate SQL & contract)
  ↓
MIGRATION DESIGN REVIEW (re-check real frontier number before naming 64+)
  ↓
DATABASE IMPLEMENTATION (additive snapshot RPC only if recommended core chosen)
  ↓
DATABASE TESTS (guards, exactly-once activity, in-txn atomicity failure injection)
  ↓
EDGE TRANSPORT IMPLEMENTATION (status envelope + snapshot-sourced audit)
  ↓
REAL HTTP TESTS (H1–H15, write fail-closed) — Edge Runtime serving explicitly proven first
  ↓
CONCURRENCY TESTS (two-connection, §8 cases)
  ↓
FRONTEND ADAPTATION (if C2 Phase-1 mutation UI proceeds)
  ↓
FULL REGRESSION (existing read G-10 + enterprise suites stay green)
  ↓
STAGING → STAGING EVIDENCE → PRODUCTION AUTHORIZATION
```

---

## 27. Definition of Done for the FUTURE implementation

- acknowledge/resolve/escalate(/assign if OD-g) each proven to commit state +
  exactly one activity row atomically, with concurrent duplicates yielding
  `already_*` and **no** extra activity row.
- Truthful audit snapshot sourced from the locked RPC result (no stale oldData).
- Write-path denials (receptionist/doctor/anonymous/missing-header/cross-tenant)
  return fail-closed 403/401 with **zero** state change, proven over real HTTP.
- Two-connection concurrency test passes for §8 Cases 1–6 with captured DB
  evidence (final state + activity rows).
- Response-loss/UNKNOWN reconciles by refetch; suppression never auto-retried.
- No migration reuses 50–53; new numbers verified against the live frontier; if a
  SECURITY DEFINER is added, its `pg_proc.proacl` REVOKE is catalog-verified
  (F16-04). `[DESIGN REQUIREMENT]`
- No C2b/worker/scheduler/financial/closed-workstream change. Existing tests
  unchanged and green.

## 28. Evidence requirements (§5 of AGENTS.md)

Every completion claim must be backed by the matching tier: IMPLEMENTED ≠
STATICALLY VERIFIED ≠ UNIT ≠ INTEGRATION VERIFIED ≠ RUNTIME VERIFIED ≠ PRODUCTION.
Local HTTP results are not staging/production. BLOCKED/UNPROVEN never converted
to PASS. Edge Runtime must be explicitly proven to serve (F16-01: `supabase start`
exit 0 is insufficient) before any HTTP certification is trusted. Documentation
must not be updated to assert behavior the tests did not prove.

---

## 29. Final verdict (§31)

```text
DESIGN READY FOR OWNER REVIEW
```

The design is repository-grounded and complete; PostgreSQL-level atomicity of
the lifecycle mutations **already exists** in migrations 47/48 and is preserved
(not rewritten) by the recommended architecture. Implementation is NOT
authorized by this document.

Blocking owner decisions that must close before implementation:
- **OD-d** resolved-state mutation/reopen policy (fixes the §7 matrix cells).
- **OD-e** not-found / constraint-violation HTTP mapping (fixes H-series asserts).
- **OD-a** strictly if in-txn audit is wanted (otherwise best-effort stands).

```text
Repository changes made by this task: NONE
Migrations created: NONE
Database mutations: NONE
Commits / push / deploy: NONE
```
