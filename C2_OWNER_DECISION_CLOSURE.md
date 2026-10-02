# SETURA — C2 ALERT LIFECYCLE OWNER DECISION CLOSURE

**Class:** Decision-closure / specification-freeze gate. No source, SQL, migration,
Edge, frontend, test, RLS, grant or database artifact was created or modified.
The only artifact is this document. No commit, push, rebase, cherry-pick or
deploy was performed.

Every decision is tagged with exactly one of:
`[EXISTING FACT]` · `[OWNER DECISION]` · `[RECOMMENDED]` · `[UNPROVEN]`.

A correction to the design gate's HTTP shorthand is recorded in §2 and §4 — the
current not-found path maps to **422**, not 400/4xx-400, and a DB-raised 42501
on the write path currently surfaces as **500**, not 403. These are load-bearing
for OD-e.

---

## 1. Executive summary

The atomicity design gate
(`C2_ALERT_LIFECYCLE_ATOMICITY_DESIGN_GATE.md`) established that the four row
lifecycle mutations and key-based suppression are already PostgreSQL-transactional
in migrations 47/48, and recommended Option D (keep RPCs, optional locked
pre/post snapshot, optional status envelope, add missing HTTP/concurrency proof).
This gate closes the owner decisions that gate a future Migration Design Review.

Verified against the actual source (not the design doc alone):

- **OD-a** — best-effort platform audit is acceptable for C2; the transactional
  `alert_activity_log` is already the authoritative record of the transition.
  In-transaction audit atomicity is **not** a C2 requirement. `[RECOMMENDED]`
- **OD-d** — resolution is **not** terminal at the DB today, and nothing in the
  source declares it conceptually terminal. Choosing D1 (keep current semantics)
  vs D2 (terminal) vs D3 (terminal + reopen) **materially changes business
  behavior** and is a genuine product-owner choice the repository cannot settle.
  **OWNER INPUT REQUIRED.** `[OWNER DECISION]`
- **OD-e** — the HTTP mapping is determinable from the existing SETURA error
  contract; it needs **no new status codes**, but one real gap must be closed at
  implementation: a DB-raised `42501` on a write must map to **403**, not **500**.
  `[RECOMMENDED]`
- **OD-b / OD-c / OD-f / OD-g / OD-h** — non-blocking; all close to the design
  gate's recommended posture. `[EXISTING FACT]` / `[RECOMMENDED]`

**Verdict (§15): OWNER DECISIONS PARTIALLY CLOSED — OWNER INPUT REQUIRED**
(sole open item: OD-d resolved terminality / reopen policy).

---

## 2. Source-of-truth baseline

Strictly ordered per AGENTS.md §5; each line is `[EXISTING FACT]` unless noted.

| Item | Verified value | Evidence |
| --- | --- | --- |
| HEAD | `0fceb50b0ca9b9971af1bebb3938583b78ace4dd` | `git rev-parse HEAD` (this task) |
| Branch | `main` | `git branch --show-current` |
| Working tree | Only pre-existing `M graphify-out/cache/stat-index.json` + pre-existing untracked report/log artifacts. No source touched before or after this task. | `git status --short` |
| Migration frontier | **63** (`63_consultation_notes_staff_read.sql`). 50–53 are real unrelated migrations (`50_p0a_fail_job_v2_dead_letter_fix`, `51_p0e_claim_jobs_v2_lease_fix`, `52_w1_detect_crashed_workers_ambiguity_fix`, `53_phase2_scheduler_and_autonomous_recovery`). A new C2 migration would be **≥ 64** and the number MUST be re-checked at implementation. | `Glob supabase/migrations/*.sql` |
| Git is present | Contrary to the AGENTS.md §13 historical snapshot ("not a Git repo"), this working tree now **is** a Git repo and returned a real HEAD. Recorded, not assumed. `[EXISTING FACT]` | git commands |

**Verified current HTTP-source facts (corrects the design-doc shorthand):**

- `ValidationError` carries `code = "VALIDATION_ERROR"` and `statusCode = 422`
  (`_shared/errors.ts` L154–162). It is **not** 400. The design gate's "→ 400"
  and "currently 400/500" phrasing is imprecise; the actual not-found / rejected
  outcome maps to **422**. `[EXISTING FACT]`
- `ForbiddenError` = `403`, `FORBIDDEN`. `RoleInsufficientError` = `403`,
  `ROLE_INSUFFICIENT`. `InternalError` = `500`, `INTERNAL_ERROR`.
  `handleErrorResponse` (`_shared/response.ts` L196–205) passes through only
  `SeturError`s; anything unrecognized becomes **500**. `[EXISTING FACT]`
- Edge write path (`alert-center/index.ts` L315–358): `loadAuthorizedAlert`
  performs an **unlocked, service-role** read of `alert_events` by `id` **with no
  hospital filter**, then: `!data` → `ValidationError("Alert not found")` (**422**);
  `data.hospital_id !== hospitalId` → `ForbiddenError("Alert belongs to different
  hospital")` (**403**). Then `db.rpc(...)`: rpc `error` → `InternalError` (**500**);
  `outcome.ok !== true` → `ValidationError` (**422**). `[EXISTING FACT]`
- Consequently, on the **Edge** write path a foreign-but-existing alert yields
  **403** while a nonexistent alert yields **422** — the current contract already
  distinguishes "exists in another tenant" from "does not exist". Alert ids are
  UUIDv4 (`z.string().uuid()`), so practical enumeration risk is negligible, but
  the asymmetry is a documented fact relevant to OD-e. `[EXISTING FACT]`
- The RPC `alert_not_found` `RETURN` (47/48) is only observable via a **direct**
  RPC call (as in `enterprise_command_center.test.ts` L915–921) or a read/delete
  race; over HTTP the Edge pre-read catches not-found first at 422. `[EXISTING FACT]`
- DB `has_permission` `RAISE EXCEPTION … ERRCODE '42501'` (48 L131–139 etc.) is
  **defense-in-depth** after the Edge pre-checks. If a 42501 ever reaches
  PostgREST as an rpc `error`, the current Edge wraps it in `InternalError` →
  **500**, **not 403**. The design gate's §11 assertion "42501 → surfaced 403" is
  therefore **not** true of the write path as coded. `[EXISTING FACT]` (code) /
  `[UNPROVEN]` (no write-path 42501 test exists).
- Suppression `window_in_past` is a `RETURN ok=false` (48 L356–358) → Edge
  `ValidationError` **422** (index.ts L269–272). A real DB `CHECK (active_until >
  active_from)` violation would raise → rpc error → **500**. `[EXISTING FACT]`

**Verified lifecycle-source facts:**

- `resolve_alert` guard: `IF v_alert.is_resolved THEN already_resolved`.
  `acknowledge_alert`, `assign_alert`, `escalate_alert` contain **no** `is_resolved`
  check → they succeed on an already-resolved row. There is **no** reopen/unresolve
  RPC. Escalate unconditionally sets `severity = 'critical'`, so escalating a
  resolved alert flips severity back to critical. `[EXISTING FACT]` (47 L169–345,
  48 L108–324)
- Frontend is read-only: `apps/web/src/api/alertCenter.ts` exports only
  `fetchAlertCenter` / `fetchAlertAnalytics` and sends only `list`/`analytics`
  (L39–77); `apps/web/src/routes/AdminAlerts.tsx` renders **no** Acknowledge /
  Assign / Resolve / Escalate / Suppress controls (L39–42, L259–260). `[EXISTING FACT]`

**Verified test facts:**

- `enterprise_command_center.test.ts` "ent: alert dedupe, acknowledge, assign,
  escalate, resolve" (L816–922) proves, at RPC level: idempotent ack/escalate/
  resolve (`already_*`), assign, `alert_not_found`, and "refire after resolve
  creates a new row". It does **not** assert post-resolve ACK/ASSIGN/ESCALATE
  behavior, and does **not** exercise concurrency. `[EXISTING FACT]`
- `alert_center_http.test.ts` = **13 read-only HTTP** tests; its own header states
  "no case exercises a mutation action" (L18–19). Fail-closed 403/401 (not 500)
  is proven for **reads** only. `[EXISTING FACT]`
- No two-connection concurrency test, no response-loss/transport-unknown test,
  no write-path fail-closed HTTP test exist. `[UNPROVEN]`

---

## 3. OD-d — Resolved-state mutation policy

### 3.1 Current repository behavior

`[EXISTING FACT]` The alert model uses **independent nullable fields**
(`is_resolved`/`resolved_at`/`resolved_by`/`resolution_notes`, plus
`acknowledged_at`, `assigned_to`, `escalated_at`). A resolved alert is
`is_resolved = true` with `resolved_at`/`resolved_by` set. Because
`acknowledge_alert` / `assign_alert` / `escalate_alert` guard only on their **own**
field, they each still succeed after resolution. `resolve_alert` repeats yield
`already_resolved`. No REOPEN operation exists. The C2 Phase-1 frontend spec
proposed **hiding** some controls post-resolution; that is a UI-only intent and
changes **no** backend behavior (and no mutation UI exists today).

### 3.2 Available choices and consequences

| Option | Backend semantics | Migration? | Existing-alert impact | Existing-client impact | New surface |
| --- | --- | --- | --- | --- | --- |
| **D1** Preserve current | Resolved remains mutable for ACK/ASSIGN/ESCALATE; UI may hide; no reopen | **None** | None (behavior unchanged) | None (backward compatible) | None |
| **D2** RESOLVE terminal | Post-resolve ACK/ASSIGN/ESCALATE → rejected | Yes (re-sign 3 RPCs to add `is_resolved` guard + return a rejected reason) | New rejections begin applying to already-resolved rows | Behavior change for any client that mutates resolved alerts | Rejection reason + HTTP mapping + tests |
| **D3** Terminal + REOPEN | D2 rejections **plus** a new `reopen_alert` transition | Yes (D2 changes + new RPC + activity/audit for reopen) | Same as D2 + new state edge | Same as D2 | New RPC, new activity action `reopened`, reopen authorization, new tests |
| **D4** Other | Not supported by domain evidence | — | — | — | — |

D4 is rejected: nothing in the source suggests a fourth policy (e.g.
per-role post-resolve rules) is required. `[RECOMMENDED]`

### 3.3 Required analysis answers

- **Is "resolved" conceptually terminal in SETURA's current alert model?** The
  model *permits* terminality (dedicated `is_resolved` flag + refire-after-resolve
  creating a new alert) but the mutation guards *do not enforce* it. The source is
  **internally consistent with "resolved is a soft end state, mutability is
  allowed"**; it does not decide the product question. `[EXISTING FACT]` /
  conclusion **OWNER**.
- **Does the independent-field architecture imply terminality?** **No.** The
  independent-field model is explicitly designed for *overlapping* properties
  (ack/assign/escalate/resolve coexist); it neither implies nor forbids
  terminality. `[EXISTING FACT]`
- **DB-behavior change = policy change or correctness fix?** A **product-policy
  change.** There is no correctness defect: state, activity and audit already
  commit atomically. Making RESOLVE terminal changes what operations are legal.
  `[RECOMMENDED` classification`]`
- **Existing alerts?** D1: none. D2/D3: previously-resolved alerts would
  retroactively reject ACK/ASSIGN/ESCALATE — acceptable because those actions were
  never part of any shipped UI, but it is a semantics change, not a no-op.
- **Concurrent RESOLVE ‖ ACK / ‖ ESCALATE?** Today serialized by `FOR UPDATE`;
  both independent fields persist (last-writer ordering, no lost update). Under
  D2/D3 the outcome depends on commit order: whichever transaction commits first
  sets the guard the other re-reads under lock → the second observes `is_resolved`
  and (D2/D3) rejects. This is deterministic under `FOR UPDATE`. `[EXISTING FACT]`
  (structure) / `[UNPROVEN]` (no concurrency test).
- **Migration 47/48 modified?** 47 is a frozen historical artifact — never
  re-edited. D2/D3 land as a **new additive migration (≥ 64)** re-signing the
  affected RPC bodies (same pattern as 48's re-signature). D1 needs **no**
  migration. `[RECOMMENDED]`
- **New migration necessary?** Only for D2/D3 (and D3 additionally for the REOPEN
  RPC). `[RECOMMENDED]`
- **New REOPEN RPC required?** Only for D3. `[RECOMMENDED]`
- **Audit/activity semantics?** D3 would add an `alert_activity_log` action
  (e.g. `reopened`) and must clear `is_resolved`/`resolved_at`/`resolved_by`
  (and decide whether `resolution_notes` are retained or archived — a data-
  retention choice). D2 adds no new activity, only a rejection path. D1 unchanged.
- **Tests that change?** D2/D3 would require updating/adding lifecycle tests to
  assert rejection of post-resolve mutation, and D3 a reopen transition test, plus
  the concurrency ordering cases. D1 keeps current tests green and simply needs
  the additional HTTP/concurrency proof already required regardless of OD-d
  (§19 of the design gate). `[RECOMMENDED]`

### 3.4 OD-d decision block

```
OD-d:
Current behavior: RESOLVE is NOT terminal; ACK/ASSIGN/ESCALATE succeed on a
  resolved row; no REOPEN exists; escalate resets severity to critical.
  [EXISTING FACT]
Decision: OWNER INPUT REQUIRED — the choice among D1 / D2 / D3 materially
  changes business behavior and is not determinable from the repository.
  [OWNER DECISION]
Rationale: The independent-field model neither implies nor forbids terminality;
  the only shipped intent (C2 Phase-1) was UI-hiding, which is backend-neutral.
  Selecting D2/D3 invents business policy that the source does not establish.
  AGENTS.md §5/§13 forbids fabricating that policy here.
Implementation consequence: D1 = none (backend unchanged, UI-hiding only).
  D2 = additive re-sign of acknowledge/assign/escalate to guard on is_resolved +
  a rejected reason. D3 = D2 plus a new reopen_alert RPC and reopen activity.
Test consequence: D1 = current lifecycle/HTTP tests stand; add the design-gate
  §19 proof (concurrency + write fail-closed). D2/D3 = add post-resolve-rejection
  and (D3) reopen-order/concurrency tests.
Migration consequence: D1 = NO migration. D2/D3 = new additive migration >= 64
  (never edit 47/48); F16-04 explicit REVOKE applies to any new SECURITY DEFINER
  reopen_alert.
```

**Recommended default (not a decision):** **D1** — preserve current backend
semantics and express any "hide after resolve" purely in the future mutation UI.
It is the only option that is backward compatible, needs no migration, changes no
existing-client behavior, and does not invent policy the repository does not
contain. `[RECOMMENDED]`

---

## 4. OD-e — Not-found / constraint HTTP mapping

### 4.1 Case A — Alert not found

`[EXISTING FACT]` Current: Edge not-found → **422** `VALIDATION_ERROR`; RPC-level
`alert_not_found` (direct call) → returned as `ok=false` and, over HTTP, would map
to **422** as well; cross-tenant → **403** `FORBIDDEN`.

Analysis (semantic correctness, enumeration, existing contract, testability):

- SETURA's established convention treats "resource rejected by validation /
  business rule" as **422 `VALIDATION_ERROR`** and "not authorized / not this
  tenant" as **403** (see `HospitalAccessDeniedError` 403, `RoleInsufficientError`
  403). There is **no existing SETURA not-found→404 convention** consumed by this
  function; introducing 404 would be a *new* contract with no precedent here.
- The brief's framing "404 vs 400" does not match reality: today it is **422**, and
  changing to **400** would also be a needless contract break.
- Cross-tenant flow: `loadAuthorizedAlert` reads the row (service role, no RLS),
  then compares hospital. A foreign-but-existing alert → **403**; a missing alert
  → **422**. The statuses differ, so the current mapping *does* weakly distinguish
  existence — but ids are UUIDv4 and unguessable, so this is not a practical
  enumeration channel. `[EXISTING FACT]`

**Decision (Case A):** **Keep 422 `VALIDATION_ERROR` for alert-not-found.** Do
**not** introduce 404 or 400 (no existing SETURA error code to reuse for it, and
it would break the current contract/tests). This is determinable from the existing
contract, not a business-policy choice. `[RECOMMENDED]` (closed). If the owner
prefers existence-indistinguishability (foreign and missing both 403), that is a
small, explicit security preference — recorded under §14 as a low-priority owner
confirmation, not a blocker.

### 4.2 Case B — Database constraint violation

`[EXISTING FACT]` Known client-caused cases are **already** returned as
`ok=false reason` and mapped to **422**: `window_in_past`. Unexpected DB failures
(a real `CHECK (active_until > active_from)` race, the in-transaction
`log_alert_activity` INSERT failing, or any plpgsql exception) abort the function
transaction → rpc `error` → `InternalError` → **500**.

Do NOT lump these:

- **Known, client-caused validation** → keep **422** by returning a structured
  `ok=false reason` **before** the DML (as `window_in_past` already does), rather
  than relying on a DB `CHECK` to raise.
- **Unexpected DB error** (including a residual `CHECK` violation not covered by a
  pre-return) → **500** is correct: it is a genuine server fault, state provably
  rolled back, and it must remain indistinguishable to avoid leaking schema.
- **42501 privilege denial** → this is the one real gap: a DB-raised 42501 that
  reaches PostgREST currently becomes **500**. It must be mapped to **403** so
  write-path authorization denials fail closed consistently with reads. `[UNPROVEN]`
  today. Implementation requirement (not a new status code): detect SQLSTATE
  `42501` in the RPC error and throw `ForbiddenError` (403).

**Decision (Case B):** Keep the **known-client → 422 / unexpected-DB → 500**
split. Add the **42501 → 403** mapping so privilege denials never surface as 500.
Do not invent a new constraint error code; `VALIDATION_ERROR` (422) and `FORBIDDEN`
(403) already exist. `[RECOMMENDED]` (closed).

### 4.3 OD-e decision block

```
OD-e:
Not-found decision: KEEP 422 VALIDATION_ERROR (alert-not-found). No 404, no 400.
Constraint-violation decision: Known client-caused window validation → 422 via a
  structured ok=false RETURN before DML (as window_in_past already does);
  unexpected DB errors (including a residual CHECK race and an in-txn activity
  failure) → 500. Privilege 42501 → MUST map to 403 (fix the current 500 leak).
Exact HTTP statuses in the C2 write contract:
  200 success / already_* (soft success is 200, NOT 409);
  401 anonymous (UNAUTHORIZED);
  403 role / tenant / DB-privilege (FORBIDDEN, ROLE_INSUFFICIENT,
      HOSPITAL_ACCESS_DENIED; and 42501→FORBIDDEN after the fix);
  405 non-POST (raw Response, existing);
  422 validation + not-found + window_in_past (VALIDATION_ERROR);
  500 unexpected database failure only (INTERNAL_ERROR).
  404 / 409 / 428: NO ROLE in C2 today — do not introduce them.
Exact machine-readable error codes: reuse EXISTING SETURA codes only —
  VALIDATION_ERROR (422), FORBIDDEN / ROLE_INSUFFICIENT / HOSPITAL_ACCESS_DENIED
  (403), UNAUTHORIZED (401), INTERNAL_ERROR (500). No new error code is created.
Cross-tenant behavior: foreign-but-existing alert → 403 (Edge hospital-equality
  check), and the DB has_permission 42501 (→403 after fix) is defense-in-depth;
  tenant is never taken from the body. [EXISTING FACT]
Unexpected DB-error behavior: function transaction rolls back, rpc error → 500,
  state provably unchanged. [EXISTING FACT] structure / [UNPROVEN] write-path test
Frontend consequence: none today (read-only UI). A future mutation client maps
  422→inline field error, 403→access-denied, 500→retry-unsafe (refetch, not
  resend). [RECOMMENDED]
Test consequence: add write-path HTTP cases asserting 401/403 fail-closed (never
  500) for receptionist/doctor/anonymous/missing-header/cross-tenant, a 422 for
  not-found and window_in_past, and a 42501→403 case. [UNPROVEN] until written.
```

---

## 5. OD-a — Strict audit atomicity

`[EXISTING FACT]` State change + `alert_activity_log` INSERT are in one function
transaction (the `PERFORM log_alert_activity` aborts the whole function if the
INSERT fails). Platform audit (`logAuditEvent`, `_shared/audit.ts`) is Edge-side,
best-effort, on a separate connection, and never throws — so `state committed /
audit failed` is possible.

- **Activity-log authority:** `alert_activity_log` is the transactional,
  authoritative per-transition record. It already satisfies AGENTS.md §8
  ("important mutations must be auditable via the established audit system")
  because the transition cannot commit without its activity row.
- **Platform-audit authority:** best-effort observability; a lost platform audit
  row is recoverable from the activity log, not vice-versa.

Security consequences of Option A2 (in-txn platform audit) — evaluated, **not**
designed:

- A `SECURITY DEFINER` function (or trigger) writing `audit_log` changes the audit
  write boundary; it needs its own explicit REVOKE (F16-04: a new/re-signed
  SECURITY DEFINER preserves the prior ACL only by accident) and catalog
  `pg_proc.proacl` verification.
- It couples **audit failure to transition failure**: a transient audit write error
  would roll back a legitimate lifecycle change — a regression in availability.
- `search_path` pinning, function ownership, RLS bypass posture, and audit
  framework coupling all change; blast radius is the global audit system, far
  outside C2 (§22 of the design gate declares global audit rewrite out of scope).
- Performance: every mutation additionally writes an audit row while holding the
  row lock.

```
OD-a:
Decision: A1 — KEEP BEST-EFFORT platform audit. Strict transition<=>audit
  atomicity is NOT required for C2. [RECOMMENDED] (closed)
Why: The transactional alert_activity_log is already the authoritative record;
  the residual risk (a lost best-effort platform audit row) does not affect state
  correctness and is reconcilable from the activity log.
Activity-log authority: in-transaction, authoritative for the transition. Keep.
Platform-audit authority: best-effort observability; failure tolerated; never
  throws. Keep.
Failure semantics: unchanged — "state committed / audit failed" remains possible
  and acceptable; "state committed / activity failed" remains impossible.
Security consequence: A1 introduces no new SECURITY DEFINER audit writer, so no
  new REVOKE/F16-04 obligation and no audit-coupled availability risk.
Migration consequence: NO migration for the audit axis. (The optional locked
  pre/post snapshot migration is an OD-f concern, separate from OD-a.)
Performance consequence: none added.
Future implementation requirement: if a compliance authority later REQUIRES
  transition<=>platform-audit atomicity, that is a global-audit-framework product
  decision (OUT OF C2 SCOPE) and would carry the full F16-04 REVOKE + catalog-ACL
  verification burden — recorded here as a caveat, not a C2 requirement.
```

**Explicit statement:** best-effort audit **is sufficient for C2.** Strict audit
atomicity is not adopted merely because it sounds stronger. `[RECOMMENDED]`

---

## 6. OD-b — Suppression duplicate policy

`[EXISTING FACT]` `suppress_alerts` writes a new `alert_suppressions` row per call
(no uniqueness constraint, no dedupe, no client idempotency key); `window_in_past`
is returned for `active_until <= now()`. Repeated suppression creates benign
overlapping windows. Suppression is key-scoped, writes no activity row, and is
**not** a state transition. No source evidence requires a change.

```
OD-b:
Decision: KEEP BENIGN OVERLAPPING WINDOWS. No dedupe, no client idempotency key.
  [EXISTING FACT] posture retained; non-blocking.
Rationale: Symmetry with the row mutations is not a requirement; dedupe would add
  a constraint/semantics with no evidence base and would change suppression's
  accepted existence semantics (design gate §4 / OD-3).
Concurrency note (OD-b <-> response-loss): suppression must NEVER be blindly
  retried on an indeterminate transport outcome — a resend creates a second
  window. Refetch/state-check before any resend. [RECOMMENDED]
Migration consequence: none.
```

---

## 7. OD-c — Canonical lifecycle status

`[EXISTING FACT]` `get_alert_center.counts` derives overlapping counts (`open`,
`acknowledged`, `escalated`, `critical_open`) from the independent fields in one
pass; `fire_managed_alert` interacts with those same columns. A single `status`
enum would be a backward-incompatible rewrite of the read contract, every count
filter, and the fire path. No source establishes a requirement for an enum.

```
OD-c:
Decision: KEEP independent lifecycle fields. NO canonical status enum.
  [RECOMMENDED] (closed; non-blocking)
Rationale: the model intentionally allows ack/assign/escalate/resolve to coexist;
  counts and reads depend on that. An enum conflicts with current counts/filters.
Consistency: no proposed enum conflicts with existing reads because none is added.
Migration consequence: none. (No derived-status backfill — design gate §16.)
```

---

## 8. OD-f — Machine-readable status envelope

`[EXISTING FACT]` Today outcome is inferred from HTTP 2xx + `result.ok` +
`result.already_*`. `UNKNOWN` **cannot** magically tell whether PostgreSQL
committed — after a response-loss event the client genuinely cannot know; the only
safe action is to **refetch authoritative state**, never resend.

Evaluation: for the four **row** mutations, the state guards already make a retry
converge (`already_*`), and a definite 4xx means definite rejection. The envelope's
value is therefore **transport-clarity + audit truthfulness (locked pre/post)**,
not correctness of the state machine.

```
OD-f:
Decision: ADOPT the additive, backward-compatible pieces that have concrete value
  — (1) the locked pre/post snapshot returned by the RPC and used to build the
  truthful audit oldData/newData, and (2) the client discipline below. The formal
  COMMITTED/ALREADY/UNKNOWN status field is OPTIONAL sugar on top of the existing
  ok/already_* contract; it is NOT required for C2 correctness. [RECOMMENDED]
  Non-blocking.
Precise semantics (do not overclaim UNKNOWN):
  2xx + (ok=true, already_*=false)  -> COMMITTED
  2xx + (ok=true, already_*=true)   -> ALREADY (no second activity row)
  non-2xx transport failure         -> INDETERMINATE -> REFETCH state, never resend
  4xx (422/403/401)                 -> definite REJECTED, no state change
  5xx                               -> unexpected DB fault; state rolled back;
                                      REFETCH before any retry
  Suppression has NO ALREADY; success is COMMITTED with suppression_id; its
  INDETERMINATE outcome must NEVER be auto-retried.
Existing-contract sufficiency: the existing ok/already_* contract is SUFFICIENT
  for the four row ops; UNKNOWN adds no ability to detect a lost-response commit
  beyond "refetch". Do not present UNKNOWN as a commit oracle.
Migration consequence: snapshot return needs the additive migration >=64 ONLY if
  the locked-snapshot adoption is implemented; the status field itself is Edge-only.
```

---

## 9. OD-g — Assign scope

`[EXISTING FACT]` `assign_alert` RPC and the Edge `assign` action exist and are
tested at RPC level (`enterprise_command_center.test.ts` L851–858, L881). No
assignable-user directory was established, and neither `alertCenter.ts` nor
`AdminAlerts.tsx` exposes any assign/mutation surface. Repository evidence supports
the design gate's C2 OD-1 descope.

```
OD-g:
Decision: ASSIGN BACKEND EXISTS · ASSIGN FRONTEND PRODUCT SCOPE DEFERRED.
  [EXISTING FACT] (backend) / [RECOMMENDED] (deferral)
Rationale: no assignable-user directory exists; inventing one is out of C2 scope.
  Building Assign UI is a separate future workstream that first requires a user
  directory decision (OWNER for that workstream, not C2).
Implementation consequence: none for C2; existing assign RPC stays.
```

---

## 10. OD-h — Greenfield vs recover-S1-A

`[EXISTING FACT]` `S1_A_CANDIDATE_PROVENANCE_REPORT.md` proves the missing S1-A
candidate is unrecoverable and its 50–53 numbering collides with real history.
The design gate is repository-grounded greenfield. This is already resolved by
provenance.

```
OD-h:
Decision: GREENFIELD / CURRENT-REPOSITORY DESIGN. The missing S1-A content is NOT
  reconstructed. [EXISTING FACT] (closed)
Migration consequence: new C2 numbers are >=64, re-checked against the live
  frontier at implementation; 50-53 are never reused.
```

---

## 11. Cross-decision consistency

| Pair | Check | Result |
| --- | --- | --- |
| OD-d ↔ HTTP | If D2/D3 chosen, post-resolve rejection needs a defined contract. Under D1 (recommended) there is no new rejection, so the OD-e contract (§4.3) is complete as-is. Under D2/D3 the rejection reuses **422 `VALIDATION_ERROR`** (a guarded business-rule rejection, like `window_in_past`) — **no new status**. Consistent. | CONSISTENT |
| OD-d ↔ concurrency | RESOLVE ‖ ACK/ESCALATE: D1 → both fields persist (serialized). D2/D3 → whichever commits first wins, second re-reads `is_resolved` under lock and rejects. Deterministic under `FOR UPDATE` either way. Consistent. | CONSISTENT |
| OD-a ↔ snapshots | Audit stays best-effort (OD-a A1). The **locked pre/post snapshot is still useful** — it makes the best-effort audit row *truthful* under concurrency even though it stays non-atomic. Snapshot is an OD-f item, independent of OD-a. Consistent. | CONSISTENT |
| OD-e ↔ H1–H15 | Statuses are fixed and deterministic (200/401/403/405/422/500). Write-path fail-closed (42501→403, tenant→403, anon→401) must be proven; that mapping is defined here, so H-series assertions are non-ambiguous. Consistent. | CONSISTENT |
| OD-f ↔ response-loss | UNKNOWN never authorizes blind resend; INDETERMINATE ⇒ refetch. No unsafe auto-retry introduced. Consistent. | CONSISTENT |
| OD-b ↔ response-loss | Suppression never auto-retried (would duplicate a window). Consistent with §6. | CONSISTENT |
| OD-c ↔ existing reads | No status enum added ⇒ `get_alert_center.counts` and filters unchanged. Consistent. | CONSISTENT |

No decision in this closure conflicts with another; the only open item (OD-d)
degrades cleanly to D1 with no contract/migration impact.

---

## 12. Implementation impact

Reflects the **recommended** closure (OD-d = D1, OD-a = A1, OD-c = keep fields,
OD-b = benign, OD-g = deferred). Items that depend on OD-d are conditional.

| Area | Decision impact |
| --- | --- |
| Migration 47 | **KEEP** (frozen historical artifact; never edited) |
| Migration 48 | **KEEP** (already atomic + in-DB authorized) |
| New migration (≥64) | **NO** for the recommended core; **YES (additive)** only if the locked pre/post snapshot (OD-f) is implemented, or if OD-d selects D2/D3 (guard re-sign / reopen RPC). Number re-checked at implementation. |
| Alert RPCs | **KEEP**; optionally **ADAPT** (additive) for locked snapshot return if OD-f snapshot is built |
| Edge Function | **ADAPT** — map 42501→403; build audit old/new from the locked snapshot if adopted; optional status field. No architectural change. |
| Frontend API (`alertCenter.ts`) | **KEEP AS-IS** (read-only); add mutation wrappers only when the future mutation UI workstream proceeds |
| Admin Alerts UI (`AdminAlerts.tsx`) | **KEEP AS-IS** for C2 (read-only); mutation controls are a separate future workstream |
| Existing tests | **KEEP** (must stay green; never weakened) |
| New HTTP tests (H1–H15) | **REQUIRED** — write-path fail-closed (401/403 never 500), 422 not-found/window, cross-tenant 403 |
| Concurrency tests | **REQUIRED** — real two-connection §8 cases 1–6; exactly-one activity per real transition |
| Audit framework | **KEEP** (best-effort unchanged; no global audit rewrite) |
| RLS | **KEEP** |
| Grants | **KEEP**; any new SECURITY DEFINER (reopen/snapshot) needs its own explicit REVOKE (F16-04) + catalog ACL verify |
| C2b (broadcast composer) | **OUT OF SCOPE** |
| Worker / scheduler | **OUT OF SCOPE** |
| Financial systems | **OUT OF SCOPE** |
| G-03…G-11 | **UNCHANGED** |

---

## 13. Future implementation preconditions

Every condition must hold before any implementation begins:

1. **OWNER DECISIONS CLOSED** — OD-d resolved (explicit D1/D2/D3 selection).
   OD-a/OD-b/OD-c/OD-e/OD-f/OD-g/OD-h are closed in this document.
2. **CURRENT MIGRATION FRONTIER RECHECKED** — confirm live frontier at
   implementation (currently 63); allocate the next free number only then.
3. **MIGRATION DESIGN REVIEW** — required only if a new migration is triggered
   (OD-f snapshot, or OD-d D2/D3). Includes F16-04 REVOKE plan and 47⊂48⊂N order.
4. **IMPLEMENTATION SCOPE APPROVED** — confirm the recommended core is Edge+test
   only (D1/A1 path needs no DB change).
5. **TEST MATRIX APPROVED** — H1–H15 write fail-closed + two-connection
   concurrency + response-loss refetch + in-txn-atomicity failure injection.
6. **Edge Runtime proven serving** before any HTTP certification (F16-01: `supabase
   start` exit 0 is insufficient).

**Scope removals (per §12 of the brief):** Because OD-a selects best-effort and
OD-f's formal status field is optional, *strict transition⇔audit atomicity* and
*a mandatory COMMITTED/ALREADY/UNKNOWN envelope* are **removed** from required
future scope — they are not hypothetical C2 requirements. The locked snapshot and
the 42501→403 mapping remain concrete requirements.

---

## 14. Remaining owner decisions

1. **OD-d (BLOCKING) — RESOLVE terminality / reopen.** The product owner must
   select **D1 / D2 / D3**. This gate cannot settle it: it materially changes
   business behavior and the source does not declare resolution terminal.
   Recommended default: **D1** (backend unchanged; hide in UI).
2. **OD-e (NON-BLOCKING, low priority) — existence-indistinguishability.** Owner
   may optionally prefer foreign-and-missing both map to 403 rather than the
   current 403-vs-422 asymmetry. UUIDv4 ids make this a minor concern; the
   recommended closure keeps 422 unless the owner opts otherwise.
3. **OD-a (CLOSED with caveat) — compliance override.** If a compliance authority
   later mandates transition⇔platform-audit atomicity, that is a global-audit
   product decision outside C2 and reopens OD-a; not required now.

No other decision remains open.

---

## 15. Final decision status

```
OD-d: OWNER INPUT REQUIRED  (D1 recommended; D2/D3 are product-policy changes)
OD-e: CLOSED  (422 not-found / known-client; 500 unexpected DB; fix 42501->403;
       no new status codes) [RECOMMENDED]
OD-a: CLOSED  (best-effort audit sufficient for C2) [RECOMMENDED]
OD-b: CLOSED  (benign overlapping windows) [EXISTING FACT]
OD-c: CLOSED  (keep independent fields, no enum) [RECOMMENDED]
OD-f: CLOSED  (locked snapshot + refetch discipline valuable; formal status field
       optional; UNKNOWN is not a commit oracle) [RECOMMENDED]
OD-g: CLOSED  (backend exists, frontend deferred) [RECOMMENDED]
OD-h: CLOSED  (greenfield) [EXISTING FACT]
```

```text
OWNER DECISIONS PARTIALLY CLOSED — OWNER INPUT REQUIRED
```

The single open item is **OD-d** (resolved terminality / reopen policy), a genuine
product choice the repository does not determine. Every other blocking decision
(OD-e, OD-a) is closed with an evidence-backed recommendation. This document
freezes decisions only; it does **not** authorize implementation and does **not**
create migration 64 or modify 47/48.

Next gate: owner selects OD-d (D1/D2/D3). Once OD-d is answered, the
**MIGRATION DESIGN REVIEW** gate becomes deterministic and can proceed.

---

**Repository changes made by this task:** NONE (source/SQL/migration/test/Edge/
frontend). **Database mutations:** NONE. **Commits / push / deploy:** NONE. The
only new artifact is `C2_OWNER_DECISION_CLOSURE.md`.
