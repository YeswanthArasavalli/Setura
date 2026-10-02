# SETURA HOSPITAL OS — C2 ALERT LIFECYCLE MUTATION — IMPLEMENTATION-READY SPECIFICATION

**SPECIFICATION ONLY — NOT AN IMPLEMENTATION**
**NO SOURCE / SQL / MIGRATION / RLS / GRANT / EDGE-FUNCTION / FRONTEND / TEST
CHANGES · NO COMMIT · NO PUSH · NO DEPLOY · NO ENV/SECRET CHANGE · NO DATABASE
STATE CHANGE · PRODUCTION UNTOUCHED**

Date: 2026-10-01 · Baseline HEAD: `0fceb50` (G-11) · Authoritative source
document: `PHASE_7_C2_MUTATION_SPECIFICATION_GATE.md`.

Method: current-source inspection of `supabase/functions/alert-center/index.ts`,
`supabase/migrations/47_enterprise_command_center.sql`,
`apps/web/src/api/alertCenter.ts`, `apps/web/src/lib/api.ts`,
`apps/web/src/types/api.ts`, `apps/web/src/routes/AdminAlerts.tsx`,
`tests/integration/enterprise_command_center.test.ts`,
`tests/integration/alert_center_http.test.ts`.

Legend used throughout (inherited from the source gate document, terminology
preserved):

- **[EXISTING]** — verified behavior in current source / SQL / tests.
- **[REQUIRED SPEC]** — a definition this document establishes.
- **[PROPOSED PRODUCT DECISION]** — a product choice made here; the repository
  does not currently decide it.
- **[OWNER DECISION STILL REQUIRED]** — cannot be safely decided from existing
  evidence; must not be invented.
- **[PROPOSED FUTURE IMPL]** — not authorized; a later phase only.

---

## Section 1 — Executive Decision

1. **C2 scope.** A hospital-admin / global-admin **mutation** surface for the
   five existing `alert-center` actions — `acknowledge`, `assign`, `resolve`,
   `escalate`, `suppress` — layered onto the existing `/admin/alerts` read page.
2. **What already exists [EXISTING].** The Edge Function, the five
   `SECURITY DEFINER` RPCs (migration 47), the auth/tenant gate, the
   state-guard idempotency, `FOR UPDATE` row locking, the dual audit +
   activity-log writers, the RPC-level integration tests, and the read-only
   frontend (`api/alertCenter.ts`, `AdminAlerts.tsx`).
3. **What is missing [EXISTING gap].** No frontend mutation wrappers, no
   mutation UI, no real-HTTP proof of the **write** branches (R2), no true
   two-connection concurrency proof, no staging/production proof.
4. **What this specification authorizes conceptually.** It fixes the exact
   backend contract, the state-transition matrix, the UX rules, the API
   wrapper signatures, the concurrency/staleness model, and the verification
   matrices so that a later engineering agent implements **without making
   product decisions during coding**.
5. **Explicitly out of scope.** C2b Broadcast Composer (a separate decision /
   workstream); financial engines; doctor leave/schedule; any scheduler/worker
   activation; reopening closed G-03…G-11 surfaces.
6. **This document does not, by itself, authorize code changes.** It is a
   specification. Implementation requires a subsequent owner-approved
   engineering phase. The final readiness verdict is at **Section 24** and is
   **NOT fully implementation-ready** pending two owner decisions (§19/§24).

---

## Section 2 — Current Backend Contract

**[EXISTING]** All five actions are `POST` to the `alert-center` Edge Function
(non-POST → 405, `index.ts` l.156-158). Tenant travels **only** in the
`X-Hospital-ID` header (never in the body). Before any RPC: header required →
`resolveAuth` → `requireRole(["hospital_admin","global_admin"])` (l.171-181).
Body is validated by a single Zod `Schema` (l.63-105).

| Action | Required | Optional (limit) | RPC invoked | AuthZ | Tenant check |
| --- | --- | --- | --- | --- | --- |
| `acknowledge` | `alertId` (uuid) | — | `acknowledge_alert(p_alert_id, p_actor_id)` | admin roles | `loadAuthorizedAlert` ownership |
| `assign` | `alertId`, `assigneeId` (uuid) | — | `assign_alert(p_alert_id, p_assignee_id, p_actor_id)` | admin roles | `loadAuthorizedAlert` |
| `resolve` | `alertId` | `notes` (≤1000) | `resolve_alert(p_alert_id, p_actor_id, p_notes)` | admin roles | `loadAuthorizedAlert` |
| `escalate` | `alertId` | `notes` (≤1000) | `escalate_alert(p_alert_id, p_actor_id, p_notes)` | admin roles | `loadAuthorizedAlert` |
| `suppress` | `alertKey` (3-128), `activeUntil` (ISO datetime) | `reason` (≤200) | `suppress_alerts(p_alert_key, p_active_until, p_actor_id, p_hospital_id, p_reason)` | admin roles | RPC receives header hospital (scoped window) |

- **Response shape [EXISTING].** `successResponse({ action, alertId, result })`
  for the four alert-target actions; `successResponse({ action, result })` for
  `suppress`. `result` is the RPC's JSONB (`{ok:true, already_*}` or
  `{ok:false, reason}`).
- **Success semantics [EXISTING].** A real transition returns
  `ok:true` with the relevant flag **false** (e.g. `already_acknowledged:false`).
- **Soft-success semantics [EXISTING].** A repeat that is already in the target
  state returns **HTTP 200** with `ok:true` and the flag **true**
  (`already_acknowledged/assigned/resolved/escalated`), producing **no** second
  column write and **no** second activity row.
- **Failure semantics [EXISTING].** RPC `ok !== true` → the edge throws
  `ValidationError` (→ 4xx) for that action, or for `suppress`,
  `Suppression window rejected` with `reason` (e.g. `window_in_past`).
  Missing alert → `ok:false, reason:alert_not_found` (RPC) surfaced as 4xx.
  Unexpected errors → `InternalError` (→ 5xx) via `handleErrorResponse`.
- **Audit [EXISTING].** Alert-target actions: `logAuditEvent` with
  `entityType="alert_event"`, `actionType="alert_center"`,
  `severity = escalate ? "high" : "low"`, `oldData` = pre-transition snapshot,
  `newData` = `{action, alert_key, assigneeId, notes, result}` (l.360-384).
  `suppress`: `entityType="alert_suppression"`, `severity="medium"`,
  `oldData=null`, and a non-UUID `suppression_id` is never placed in `entityId`
  (l.275-298).
- **Activity log [EXISTING].** Each RPC, on a **real** transition, calls
  `log_alert_activity(alert_id, hospital_id, actor_id, action, notes)` writing
  one `alert_activity_log` row (`acknowledged|assigned|resolved|escalated`).
- **Locking/concurrency [EXISTING].** The four alert-target RPCs open with
  `SELECT … FROM alert_events WHERE id = p_alert_id FOR UPDATE` (47
  l.186/229/276/321), serializing concurrent mutations. `suppress` takes no row
  lock (it inserts a new window row).
- **Notifications / WhatsApp / Realtime [EXISTING].** The C2 mutation RPCs do
  **not** enqueue notifications, do **not** touch WhatsApp, and do **not**
  write to Realtime. (Alert fan-out is C2b's `broadcast_alert`, out of scope.)
  Realtime visibility, if used, is a client subscription to `alert_events`, not
  produced by these RPCs.
- **Idempotency [EXISTING].** State-guard based (§6), **not** key based. Note:
  `callFunction` can send an `Idempotency-Key` header (`lib/api.ts` l.11,47),
  **but the `alert-center` Zod schema never reads it** → that header is inert
  for C2 today. Any key-based idempotency would be a backend change (§19).

---

## Section 3 — Authoritative Alert State Model

**[EXISTING]** Alert "state" is **not** a single enum. It is a set of
independent columns on `alert_events` (migration 47 l.73-81):
`is_resolved`, `acknowledged_at/by`, `assigned_to/at`, `escalated_at/by`,
`severity`, `resolution_notes`, plus `created_at/resolved_at`. The four
mutations guard and set their own column independently of the others.

**State-transition matrix.** "Existing backend behavior" is from 47 l.169-386 +
tests l.816-972; "Proposed UI behavior" is this spec's product decision (§4).

| Current state | Action | Existing backend behavior | Proposed UI behavior | Allowed? | Result |
| --- | --- | --- | --- | --- | --- |
| unacknowledged | acknowledge | set `acknowledged_at=now()`, log | show button | yes | transition |
| acknowledged | acknowledge | `already_acknowledged:true`, no write | button hidden/disabled after refresh | yes (no-op) | soft-success |
| resolved | acknowledge | **still acknowledges** (no `is_resolved` guard) | **hide** Acknowledge on resolved | backend yes / UI no | UI prevents |
| unresolved (unassigned) | assign | set `assigned_to`, `assigned_at`, log | show Assign | yes | transition |
| assigned→same assignee | assign | `already_assigned:true`, no write | hide if target == current | yes (no-op) | soft-success |
| assigned→different | assign | re-assigns, logs again | allow | yes | transition |
| resolved | assign | **still assigns** | **hide** Assign on resolved | backend yes / UI no | UI prevents |
| unresolved | resolve | set `is_resolved=true`, `resolved_at/by`, notes, log | show Resolve (+ optional notes) | yes | transition |
| resolved | resolve | `already_resolved:true`, no write | hide Resolve on resolved | yes (no-op) | soft-success |
| unresolved, not escalated | escalate | set `escalated_at/by`, `severity=critical`, log | show Escalate | yes | transition |
| resolved | escalate | **still escalates** | **hide** Escalate on resolved | backend yes / UI no | UI prevents |
| already escalated | escalate | `already_escalated:true`, no write, severity unchanged | hide Escalate once `escalated_at` set | yes (no-op) | soft-success |
| suppress active key (future window) | suppress | INSERT new `alert_suppressions` row, `ok:true` | confirm + single-submit | yes | new window row |
| suppress past window | suppress | `ok:false, reason:window_in_past` → 4xx | client pre-validates future-only | no | rejection |
| repeated suppression | suppress | **another INSERT** (not idempotent) | client submit-lock + benign-additive note | yes (multi-row) | see §7 |

**[EXISTING]** `alert_suppressions` has `CHECK (active_until > active_from)`
(l.114-116); `active_from` defaults to `now()`.

---

## Section 4 — Resolution of the Undefined Product Decisions

Each is **[PROPOSED PRODUCT DECISION]** unless flagged
**[OWNER DECISION STILL REQUIRED]**. All prefer the smallest choice compatible
with the existing backend; **none** of them is claimed to already exist.

### D1 — Forbid acknowledge after resolve?
- **Decision:** UI hides Acknowledge when `is_resolved === true`; backend
  unchanged (still permits it).
- **Rationale:** `resolve` is the soft terminal of the dedupe engine; a
  post-resolution ack is operationally meaningless.
- **Security:** none weakened — server remains authoritative. **UX:** fewer
  confusing actions. **Backend compatibility:** none required. **Frontend-only
  sufficient:** yes. **Test:** UI hides button for resolved rows. **Risk:** a
  genuinely-late ack is blocked in UI only (data model unaffected). **Rejected
  alternative:** a backend `is_resolved` guard (rejected — behavior change to a
  tested RPC).

### D2 — Forbid escalate after resolve?
- Identical treatment to D1: hide Escalate on resolved (frontend-only). Same
  rationale/security/test profile. **Rejected:** backend guard.

### D3 — Can resolved alerts be reassigned?
- **Decision:** UI hides Assign on resolved (frontend-only). Reassignment of
  **non**-resolved alerts is allowed (existing backend re-logs, §3).
- **Frontend-only sufficient:** yes. **Risk:** an admin cannot reassign a
  resolved alert from the UI; acceptable (reopen is D4).

### D4 — Can resolved alerts be reopened?
- **[OWNER DECISION STILL REQUIRED].** There is **no** reopen/unresolve RPC
  (migration 47 provides none). Reopening requires a **new** RPC + state rules
  → a backend change, out of the "existing backend" boundary. Recommend
  **deferring reopen to a separate decision**; C2 UI does not offer reopen.

### D5 — Duplicate-suppression prevention?
- **Decision:** **[PROPOSED PRODUCT DECISION]** rely on (a) client submit-lock
  during the request, (b) an explicit confirmation dialog, and (c) accept that
  overlapping windows are **semantically benign** — `is_alert_suppressed` is an
  OR-existence check (47 l.121-140), so an extra window does not change
  suppression truth. A hard single-active-window guarantee is therefore
  **not** required for correctness.
- **Frontend-only sufficient:** yes for the benign-duplicate posture.
- **[OWNER DECISION STILL REQUIRED]** *only if* the product mandates a hard
  "one active window per key" invariant — that needs a backend guard/unique
  constraint (see §19). Key-based idempotency is available at transport but is
  **not consumed** by `alert-center` (§2), so it cannot be relied on without a
  backend change.

### D6 — Stale-state / concurrency policy?
- **Decision:** **server-authoritative reconcile.** Every mutation is followed
  by a re-fetch of the affected row/center; the UI never treats an optimistic
  local flip as final truth. Last-write-wins is acceptable **because** each
  transition is individually guarded under `FOR UPDATE` (§8).
- **Frontend-only sufficient:** yes. **Rejected:** expected-version/ETag guard
  (would need backend support). **Owner may** still require an ETag; not needed
  for correctness here.

### D7 — How does `global_admin` choose the acting hospital?
- **Decision:** **reuse the existing G-08 bounded acting context verbatim** —
  `fetchActingHospitalContext()` (`api/portfolio`), and
  `scopeHospitalId = hospitalId ?? acting?.hospitalId` (already the pattern in
  `AdminAlerts.tsx` l.156). Mutations send `X-Hospital-ID = scopeHospitalId`.
  **Do not** invent a portfolio-management API. **Frontend-only sufficient:**
  yes. **Cross-tenant safety:** the backend re-checks per-row ownership, so a
  wrong header cannot mutate another tenant's alert (§15).

### D8 — How do `already_*` responses appear in the UI?
- **Decision:** treat as **success**, never failure. Info toast
  "Alert already acknowledged/assigned/resolved/escalated"; refresh; HTTP 200
  handled as success; **no retry**. (Full contract §6.)

### D9 — Audit behavior under concurrency?
- **Decision:** keep the backend authoritative; the platform-audit `oldData`
  snapshot is captured from `loadAuthorizedAlert` **before** the locking RPC, so
  under a true race it may reflect pre-lock state rather than the exact row the
  RPC transitioned. Accept this as best-effort for C2 (**frontend-only, no
  change**). **[OWNER DECISION STILL REQUIRED]** if strict transaction-accurate
  `oldData` is mandated — that requires moving the snapshot inside the RPC
  transaction (backend change, §19).

---

## Section 5 — Recommended C2 UX (extends `/admin/alerts`, no duplicate page)

**[PROPOSED FUTURE IMPL]** Build **on the existing `AdminAlerts.tsx`**
(G-10 read surface); do not create a second alert center.

### Alert list (existing `get_alert_center.alerts` columns only)
Columns to render (verbatim server fields, no browser computation):
`created_at`, `severity` (badge — reuse `SEVERITY_TONE`), `alert_key`,
`alert_category`, `message`, status chip derived from
`is_resolved`/`acknowledged_at`/`escalated_at`/`assigned_to`, and **per-row
mutation actions**. Counts come from the server `counts` block (never
`alerts.length`). **PII:** the alert read carries no patient PII; do not add
any.

### Alert detail (drawer) — bounded to what the existing read returns
Show: lifecycle state (the columns above), timestamps, `assigned_to` **as a raw
id only** (no name — see §19: no directory read exists), `severity`,
`message`. **NOT shown** (no existing read): `resolution_notes`, actor names
(`acknowledged_by`/`escalated_by`), and the `alert_activity_log` history —
these require a new read (§19) or are descoped. Do **not** fake an activity
timeline.

### Mutation controls — visibility & behavior
Appear only when the section is `success`, the actor is `hospital_admin` or
`global_admin`, and `scopeHospitalId` is present. Per selected row:

| Control | Visible when | Confirmation | Required input | Notes |
| --- | --- | --- | --- | --- |
| Acknowledge | `!is_resolved && !acknowledged_at` | none | — | |
| Assign | `!is_resolved` | none | `assigneeId` | target source unresolved → §19/§24 gate |
| Resolve | `!is_resolved` | yes | optional `notes` (≤1000) | terminal, confirm |
| Escalate | `!is_resolved && !escalated_at` | yes | optional `notes` | raises to critical |
| Suppress | (operates on a key, not a row) | yes | `alertKey`, future `activeUntil`, optional `reason` | submit-locked (§7) |

- **Disabled conditions:** while a mutation for that row is in-flight
  (single-submit lock); when no hospital context is selected (global_admin with
  unresolved acting context → all mutations disabled + disclosure message).
- **Loading behavior:** disable the pressed control only; keep the rest of the
  page interactive.
- **Duplicate-click prevention:** per-row in-flight flag; button becomes
  disabled on submit and re-enables only after the reconcile completes.
- **Error handling:** render `describeError(e)` (already imported); never dress
  an HTTP failure as an empty success (existing G-10 honesty rule).
- **Success handling:** toast + refetch (below).
- **Refresh/reconciliation:** after **any** mutation response (success or
  `already_*`), refetch the center (and, if the drawer is open, the affected
  row's server state) so the UI shows DB truth, not the click's assumption.

---

## Section 6 — `already_*` Semantics

`already_acknowledged` / `already_assigned` / `already_resolved` /
`already_escalated` are **[EXISTING] soft successes (HTTP 200)**, never errors.

| Field | UX |
| --- | --- |
| Message | info toast "Alert already <past-participle>" (no red error styling) |
| UI refresh | **yes** — refetch center + reconcile the row |
| Mutation button | remains hidden/disabled post-reconcile (row is in target state) |
| Activity timeline | N/A in C2 (no history read); do not render a fake entry |
| HTTP treated as | success (`envelope.success === true` path in `callFunction`) |
| Frontend retry | **never** retry a soft-success; a guarded mutation that already applied must not be re-issued |

**Hard rule [REQUIRED SPEC]:** the implementation must **never** blindly retry a
state-guarded mutation; `already_*` terminates the interaction.

---

## Section 7 — Suppression Semantics

**[EXISTING]** `suppress` differs from the four row mutations:
- Operates on an **`alert_key`** (3-128 chars), not an `alertId`.
- `activeUntil` must be a future ISO datetime; the RPC returns
  `ok:false, reason:window_in_past` for past windows; the table also enforces
  `active_until > active_from` (default `active_from = now()`).
- Creates (INSERTs) a new `alert_suppressions` row and returns
  `suppression_id`. It takes **no** `FOR UPDATE` and has **no** "already
  suppressed" guard → **not naturally idempotent**: repeated calls append
  additional windows.
- Effect is on the **firing** path (`fire_managed_alert` →
  `is_alert_suppressed`), which is a boolean existence check across active
  windows.

**[REQUIRED SPEC] Implementation-ready UX contract (D5):**
1. Client pre-validates `activeUntil > now()` (mirror of the RPC guard) to give
   immediate feedback; the server still rejects past windows.
2. Confirmation dialog ("Suppress `<key>` until `<when>`? This pauses new
   alerts of this key").
3. Single-submit lock; the button is disabled until the response returns.
4. Treat overlapping windows as **benign** (existence semantics) — do **not**
   build a frontend idempotency key, because the transport `Idempotency-Key` is
   **not consumed** by `alert-center` (§2) and inventing a client-only scheme
   would be a weaker parallel system (forbidden by AGENTS.md §8).
5. Because there is **no** existing read that lists active suppressions, the UI
   shows the just-submitted window as a transient confirmation only; a
   persistent "current suppressions" panel requires a new read (§19) and is
   **out of scope for C2 Phase 1**.

Duplicate-submit protection decision: **frontend-only single-submit +
confirmation + acceptance of benign additive windows.** A hard server-side
single-window guard is **[OWNER DECISION STILL REQUIRED]** (§4 D5, §19).

---

## Section 8 — Concurrency / Stale State

**Principle [REQUIRED SPEC]:** the database is authoritative. `FOR UPDATE` in
the four alert-target RPCs serializes concurrent transitions; the second
transaction observes the guarded post-state and returns `already_*`.

Frontend model:
- **Mutation request** → send header `scopeHospitalId`, body per §2.
- **Server response** → interpret `ok` + `already_*` (§6).
- **Refresh/reconciliation** → refetch after every mutation; render server
  truth.
- **Simultaneous other-admin mutation** → surfaced by the reconcile: the row
  reflects the winning transition; the losing click yields `already_*`.
- **Stale detail view** → on reconcile, if the drawer's row changed, refresh its
  displayed state; never block on a version the server does not enforce.
- **`already_*`** → soft success, no retry (§6).
- **4xx transition rejection** (e.g. `window_in_past`, `alert_not_found`,
  `HOSPITAL_ACCESS_DENIED`) → show error, do **not** auto-retry, do not mutate
  local optimistic state.
- **Network timeout / unknown outcome** (status `0` / `NETWORK` from
  `callFunction`): **do not auto-resubmit.** Because guarded mutations are
  naturally idempotent for ack/assign/resolve/escalate, the safe recovery is a
  **refetch (read) first** to observe the committed state; only if the state is
  unchanged may the user manually retry. For `suppress` (append, non-idempotent)
  the recovery is **refetch + explicit user decision**, never a silent resend —
  a blind resend could append a second window.

Rationale per action: guarded transitions are read-verifiable, so reconcile
before retry is always safe; the one non-guarded action (`suppress`) is exactly
the one where a blind retry is unsafe.

---

## Section 9 — Global Admin Tenancy

**[EXISTING] reuse, [REQUIRED SPEC] binding:**
- The backend requires `X-Hospital-ID` on every call; the frontend must **never**
  place tenant identity in the mutation body as a substitute.
- `global_admin` with no own tenant resolves a single acting hospital via the
  **existing G-08** `fetchActingHospitalContext()` → `scopeHospitalId` (D7).
- **Selection required:** always, before any mutation is enabled.
- **Displayed:** the acting hospital is disclosed on the page (as the read
  surface already discloses scope) — never hidden.
- **Persisted during session:** held in component state (`acting`) exactly as
  today; not written to the body.
- **No hospital selected:** all mutation controls disabled + honest message
  ("No hospital exists to satisfy the required context." — the existing string).
- **Context changes mid-session:** reload the center for the new
  `scopeHospitalId`; discard in-flight drawer state; re-enable per new scope.
- **Reload:** mutations refetch against the **current** `scopeHospitalId`.
- **Cross-tenant prevention:** the backend re-validates per-row
  (`loadAuthorizedAlert`) + the RPC `p_hospital_id` for suppress; a mismatched
  header cannot mutate another tenant (403, §15).
- **No portfolio-management API is invented** — only the existing bounded
  acting context is used.
- **Distinction:** *frontend context selection* (which hospital to act as) is
  separate from *backend authorization* (which is re-enforced on every call).

---

## Section 10 — API Wrapper Specification (proposed additions to `api/alertCenter.ts`)

**[PROPOSED FUTURE IMPL] — TypeScript contracts only; do not write bodies.**
All wrappers call `callFunction("alert-center", body, { hospitalId })`; the
`X-Hospital-ID` header carries tenant. Response types are added to
`types/api.ts`. **[EXISTING gap]** there is currently **no** mutation response
type — one must be defined from the RPC return shape (§2).

Shared types:
```ts
type AlertMutationFlags =
  | { already_acknowledged: boolean }
  | { already_assigned: boolean }
  | { already_resolved: boolean }
  | { already_escalated: boolean };
// result.ok is always true on the 200 path; the flag distinguishes
// real-transition (false) from soft-success (true).
```

| Function | Input | Body sent | Returns (success envelope `data`) |
| --- | --- | --- | --- |
| `acknowledgeAlert(hospitalId, { alertId })` | `alertId: string` | `{action:"acknowledge", alertId}` | `{action, alertId, result:{ok:true, already_acknowledged}}` |
| `assignAlert(hospitalId, { alertId, assigneeId })` | two uuids | `{action:"assign", alertId, assigneeId}` | `{…, result:{ok:true, already_assigned}}` |
| `resolveAlert(hospitalId, { alertId, notes? })` | `alertId`, optional `notes≤1000` | `{action:"resolve", alertId, notes?}` | `{…, result:{ok:true, already_resolved}}` |
| `escalateAlert(hospitalId, { alertId, notes? })` | `alertId`, optional `notes≤1000` | `{action:"escalate", alertId, notes?}` | `{…, result:{ok:true, already_escalated}}` |
| `suppressAlerts(hospitalId, { alertKey, activeUntil, reason? })` | key(3-128), future ISO datetime, `reason≤200` | `{action:"suppress", alertKey, activeUntil, reason?}` | `{action:"suppress", result:{ok:true, suppression_id}}` |

- **Headers:** `hospitalId` → `X-Hospital-ID` only. Do **not** set
  `idempotencyKey` for these calls (unused by `alert-center` — §2/§7).
- **Error mapping:** rely on `callFunction` throwing `ApiError`; UI maps
  `401`→re-auth, `403`→access-denied message, `400/422`→field/transition
  message (surface `fieldErrors`), network `0`→unknown-outcome path (§8).
- **Soft-success mapping:** `result.already_* === true` is a **success** branch,
  not an error (§6).
- **No-PII logging:** wrappers must not log tokens, `Authorization`/`apikey`
  headers, or full alert bodies; log only `action`, `alertId`/`alertKey`,
  `correlationId`, result category (§17).

---

## Section 11 — Frontend Component Boundary

**[PROPOSED FUTURE IMPL] — minimal, no new abstractions:**

| Unit | Responsibility | Inputs | Outputs | State owner | API dep | AuthZ visibility | Error behavior |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `AdminAlerts` (extend) | add mutation controls to the existing table rows | center data, `scopeHospitalId`, role | row action buttons | page | `alertCenter` wrappers | admin roles only | toast + keep last good data |
| `AlertMutationBar` (new, in-file) | per-row Acknowledge/Assign/Resolve/Escalate | row, in-flight flag | callbacks | page (lifted) | wrappers | hidden for resolved (D1-D3) | disabled while in-flight |
| `ResolveDialog` | capture optional notes + confirm | `alertId` | resolve call | dialog local | `resolveAlert` | admin only | show `describeError` |
| `EscalateDialog` | confirm + optional notes | `alertId` | escalate call | dialog local | `escalateAlert` | admin only | same |
| `AssignDialog` | capture `assigneeId` | `alertId` | assign call | dialog local | `assignAlert` | admin only; **blocked on assignee source (§19)** | same |
| `SuppressDialog` | capture key + future window + reason | acting context | suppress call | dialog local | `suppressAlerts` | admin only | pre-validate future window |
| `useAlertReconcile` (thin) | refetch center after any mutation | `scopeHospitalId`, filters | refreshed center | page | `fetchAlertCenter` | n/a | sets error section |

- No new state machine in React; no browser recomputation; drawer shows only
  fields the read returns (no fabricated activity timeline / resolution note).
- Confirmation required for **Resolve**, **Escalate**, **Suppress** (terminal or
  wide-impact); Acknowledge/Assign do not (D1-D3 visibility governs them).

---

## Section 12 — HTTP Write Certification Matrix (future tests)

**[PROPOSED FUTURE IMPL]** These tests do **not** exist yet.
`alert_center_http.test.ts` today drives **only** `list`/`analytics` (verified:
no write action appears in that file) → this is risk **R2**. Every case below
requires **Edge Runtime serving verification first** (F16-01: `supabase start`
may exit 0 with the Edge container down).

| # | Setup | Request | Expected HTTP | Expected response | DB mutation | Audit | Activity | Side-effect absence | Cleanup | PASS evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H1 | hospital_admin, own open alert | `acknowledge` | 200 | `already_acknowledged:false` | `acknowledged_at` set | 1 `alert_event` audit | 1 `acknowledged` row | no WhatsApp/notify | resolve/delete fixture | captured 200 + row + counts |
| H2 | global_admin, header scoped to hospital | `escalate` | 200 | `already_escalated:false`, severity critical | `escalated_at` set, severity=critical | 1 audit sev high | 1 `escalated` | none | same | catalog row diff |
| H3 | receptionist token | `acknowledge` | 403 | `ROLE_INSUFFICIENT`, `data===undefined` | none | none | none | loud-500 must NOT appear | n/a | asserted 403 |
| H4 | doctor token | `resolve` | 403 | `ROLE_INSUFFICIENT` | none | none | none | — | n/a | asserted 403 |
| H5 | anonymous (no JWT) | `acknowledge` | 401/403 | fail-closed | none | none | none | — | n/a | asserted denial |
| H6 | no `X-Hospital-ID` | `acknowledge` | 400/4xx | `ValidationError` Missing header | none | none | none | — | n/a | asserted before-auth rejection |
| H7 | admin A token, alert owned by hospital B | `resolve` | 403 | `HOSPITAL_ACCESS_DENIED` | none | none | none | **zero mutation on B's row** | n/a | row B unchanged |
| H8 | suppress with past `activeUntil` | `suppress` | 4xx | `Suppression window rejected` `window_in_past` | no suppression row | none | none | none | n/a | asserted rejection |
| H9 | `acknowledge` twice sequentially | both `acknowledge` | 200,200 | 2nd `already_acknowledged:true` | one transition total | one real-transition audit* | exactly 1 `acknowledged` | none | cleanup | activity log count == 1 |
| H10 | two concurrent transitions (see §13) | parallel `resolve`+`acknowledge` | both 200 | guarded | serialized | per winner | exactly-once per guarded first transition | no lost update | cleanup | see §13 |
| H11 | resolve then (UI-hidden but) ack a resolved row directly via RPC path/edge | per chosen D1 | n/a for UI | UI prevents; backend documented | per backend | — | — | — | cleanup | record backend allows; UI blocks |
| H12 | any guarded mutation | — | — | — | — | audit created **once** | activity created **once** | no dup | assert counts | counts asserted |
| H13 | acknowledge | — | — | — | no notify enqueued | — | — | `job_queue` unchanged for this alert | assert job count | zero new jobs |
| H14 | all actions | — | — | response/logs free of patient PII beyond existing alert fields | — | — | — | — | grep logs | no PII leak |
| H15 | denial cases (H3/H4/H7) | — | never a loud 500 | 4xx with `data===undefined` | — | — | — | — | — | `assertDenied` discipline |

\* Repeats of a guarded mutation produce **no second** activity row; a repeat
`audit` may still be written by the edge for every 200 — tests must assert the
**activity** exactly-once and record the edge-audit-per-request behavior
explicitly (§14).

Cleanup uses the existing test fixture teardown; **immutable audit history must
not be weakened for test convenience** (AGENTS.md §8/§12).

---

## Section 13 — True Concurrency Test (future)

**[PROPOSED FUTURE IMPL]** The existing test
`enterprise_command_center.test.ts` l.816-922 is **sequential** and proves the
guard, **not** a real race. A dedicated two-connection test must be added.

- **Setup:** one open alert; two authenticated admin connections (Admin A,
  Admin B) on **separate DB sessions**.
- **Trigger:** fire `resolve_alert` (A) and `acknowledge_alert` (B) — and a
  second pairing `escalate_alert` vs `resolve_alert` — simultaneously
  (e.g. `Promise.all` of two distinct pooled connections).
- **Expected locking:** `FOR UPDATE` serializes; one transaction acquires the
  row lock, the other blocks until commit, then reads the post-transition row.
- **Expected final state:** both guarded fields end set (`is_resolved` **and**
  `acknowledged_at`, or `escalated_at` **and** `is_resolved`) — the guard is
  per-column, so ack/escalate are not lost by resolve and vice-versa.
- **Expected activity rows:** exactly **one** `acknowledged` row and **one**
  `resolved`/`escalated` row (each guarded first real transition logs once); no
  duplicated row for a column already set.
- **Expected audit rows:** one edge audit per HTTP request that returned 200
  (documented, not asserted as "one per state change").
- **Acceptable ordering:** either A-before-B or B-before-A.
- **Unacceptable:** a lost update (a guarded column never set though both
  callers got 200), a double activity row for the same transition, or a
  partial write (transitioned column without its activity row).
- **Evidence:** captured final row + `alert_activity_log` counts + both response
  JSON; PASS requires the invariant above, FAIL/BLOCKED otherwise (§21).

**[DO NOT]** claim existing sequential tests prove this.

---

## Section 14 — Audit Requirements

**[EXISTING] both surfaces remain; the frontend NEVER writes a parallel audit
record:**
1. **`alert_activity_log`** (domain, append-only, service-role-only):
   per guarded **real** transition — `action` ∈
   {acknowledged, assigned, resolved, escalated}, `actor_user_id`, `hospital_id`,
   `notes`, `created_at`. **Exactly once** per real transition; soft-success
   writes none.
2. **Platform audit (`logAuditEvent`)**: `action` (edge action name),
   `actor=auth.userId`, `tenant=hospitalId`, `entity=alert.id` (or
   `suppression_id` when UUID), `oldData` = pre-transition snapshot
   (`severity, is_resolved, acknowledged_at, assigned_to, escalated_at`),
   `newData` = `{action, alert_key, assigneeId, notes, result}`, `severity`
   (escalate high, others low; suppress medium), timestamp implicit.

- **Concurrency:** activity is inside the RPC transaction (accurate); the
  platform `oldData` snapshot is pre-lock best-effort (§4 D9). Under the §13
  race, activity rows remain exactly-once per guarded transition.
- **Immutability:** never relaxed for tests (AGENTS.md §8/§12).
- **Frontend role:** display/read only; no client-side audit fabrication.

---

## Section 15 — Security / Tenant Isolation

**[EXISTING] to be preserved, not weakened:**
- **hospital_admin** → mutate own tenant's alerts (header-scoped + row check).
- **global_admin** → mutate the header-scoped hospital's alerts only (D7); no
  cross-tenant aggregate mutation exists in C2.
- **receptionist / doctor / anonymous** → denied at `requireRole`/`resolveAuth`
  (H3/H4/H5) **before** any RPC.
- **Cross-tenant alert IDs** → `loadAuthorizedAlert` `ForbiddenError`; RPC `p_
  hospital_id` scoping for suppress (H7).
- **Missing tenant header** → rejected before auth (H6).
- **Forged tenant header** → the actor's role is validated against the header
  hospital by `resolveAuth`; a global_admin may set any hospital but is still
  row-checked per hospital; a hospital_admin acting with a foreign header is
  denied by membership. (Existing gate — do not bypass.)
- **Service-role RPC exposure** → the five mutation RPCs are `GRANT EXECUTE … TO
  service_role` only (47 l.2516-2548); **the browser must keep using the Edge
  Function boundary**; no direct PostgREST RPC call is authorized. F16-04
  caution: any **new/resigned** function would need its own explicit `REVOKE` —
  relevant only if §19 backend reads are added.
- **PII leakage** → alert rows carry no patient PII; do not add patient
  identifiers to requests, logs, or UI.
- **Browser direct RPC** → forbidden; `getServiceClient()` is edge-only.

---

## Section 16 — Error Contract (frontend handling)

Handling of statuses the **existing backend produces**:

| Status | Source | UI handling |
| --- | --- | --- |
| 401 | `resolveAuth` / `callFunction` no token | re-auth prompt; no mutation |
| 403 | `requireRole` (`ROLE_INSUFFICIENT`), tenant (`HOSPITAL_ACCESS_DENIED`) | access-denied message; never a success; no retry |
| 400 / 422 | `ValidationError` (missing header, schema, `alert_not_found`, `window_in_past`) | show message + `fieldErrors`; focus the offending input |
| 500 | `InternalError` | generic error; log `correlationId`; **do not** auto-retry mutation (§8) |
| network (status 0) | `callFunction` catch | unknown outcome → **refetch-first**, never blind resend (§8) |

- **404 / 409:** **[EXISTING]** the current backend does **not** emit these for
  C2 (missing alert is a 4xx `ValidationError`, not 404). **[REQUIRED SPEC —
  future]** a true `409 Conflict`/stale-version signal would require backend
  support (not present); do not expect it. Marked as future-only, not current.

---

## Section 17 — Observability

**May be logged (safe):** `action`, `alertId`/`alertKey`, tenant id in safe
(schematic) form, `correlationId` (from trace), result category
(`transition | already | rejected | denied | error`), HTTP status, latency.

**Never logged:** access tokens, `Authorization`/`apikey`/`Idempotency-Key`
values, secrets, raw request/response bodies containing notes, unnecessary
patient PII, `service_role` keys. (AGENTS.md §7.)

Frontend uses the existing `describeError` for user-facing messages and must not
`console.log` alert payloads; production console must stay clean.

---

## Section 18 — Implementation Boundary

### Existing — MUST remain untouched
`alert-center/index.ts`; the five RPCs + `log_alert_activity` +
`is_alert_suppressed` + `fire_managed_alert` + `get_alert_center` +
`get_alert_analytics` (migration 47); all RLS; all grants; the audit +
activity infrastructure; `_shared` primitives
(`resolveAuth`/`requireRole`/`getServiceClient`/`logAuditEvent`/
`successResponse`/`handleErrorResponse`); the closed G-03…G-11 surfaces
(including `AdminAlerts.tsx` **read** behavior and `api/alertCenter.ts` read
wrappers).

### Proposed future implementation (new additive work only)
- **Extend** `apps/web/src/api/alertCenter.ts` with the five mutation wrappers
  (§10) — additive; existing read exports stay.
- **Add** mutation types to `apps/web/src/types/api.ts` — additive.
- **Extend** `AdminAlerts.tsx` (+ small dialog components) with mutation controls
  on the existing table (§5/§11) — additive to the read surface.
- **Add** HTTP write tests + concurrency test (§12/§13).
- **Later, after authorization:** staging verification (§22 steps 10-11).

Do not reopen G-03…G-11 or refactor the backend for cleanliness.

---

## Section 19 — Required Backend Changes

**Core lifecycle mutations (acknowledge / resolve / escalate / suppress):
NO BACKEND CHANGES REQUIRED** — fully implemented, tested, and
service-role-gated today; a UI can bind directly to the existing contract (§2).

**Where the existing backend does NOT cover the UI (honest gaps):**

1. **Assignee target source for `Assign`** — `assign_alert` needs an
   `assigneeId` (a user UUID), but **no existing Edge action or read surfaces a
   hospital-scoped assignable-user directory** to the console. Options:
   (a) add a minimal hospital-scoped assignable-users read RPC **[BACKEND CHANGE
   REQUIRED]**; (b) reuse an existing hospital-scoped read that yields user ids
   (e.g. G-11 `get_doctor_rankings` → doctors only — a product question about
   whether alerts may be assigned to doctors); (c) **descope `Assign` to a later
   increment**. → **[OWNER DECISION STILL REQUIRED]**. This is the primary
   blocker to a full "no backend change" outcome.
2. **Detail enrichment (resolution_notes, actor names, activity history,
   current suppressions list)** — none is returned by `get_alert_center`
   (l.456-470) and no read exposes `alert_activity_log` / `alert_suppressions`.
   Rendering them requires a **new read** **[BACKEND CHANGE REQUIRED]**;
   otherwise these UI affordances are **descoped** (this spec descopes them —
   §5 detail is limited to fields the read returns).
3. **Hard single-active-suppression invariant** (only if D5 resolves to a strict
   guarantee) — needs a backend guard/unique constraint.
4. **Key-based idempotency for suppress** (only if required) — the transport
   `Idempotency-Key` is not consumed by `alert-center`; enabling it is a backend
   change.
5. **Transaction-accurate audit `oldData`** (only if D9 requires strictness) —
   move the snapshot inside the RPC transaction.

**Smallest-change principle:** none of items 1-5 is required for the guarded
mutations themselves; each is required only if the corresponding UI richness or
hard guarantee is in scope. Any added read must, per F16-04, carry its own
explicit `REVOKE`/grant review.

---

## Section 20 — Definition of Done (C2)

C2 is **not** done merely because code compiles, UI renders, or a mutation
returns 200. Required:

**Implementation**
- Five API wrappers (§10) with soft-success mapping and no `Idempotency-Key`
  misuse; types added.
- UI mutation controls with role/tenant-aware visibility and D1-D3 resolved
  button rules (§5).
- Validation mirroring backend (future window, uuid, length) with server as
  authority.
- Authorization-aware visibility (admin roles; disabled without context).
- Server reconciliation after every mutation (§8).

**Testing**
- Unit: state-guard/`already_*` mapping, validation, error mapping.
- Frontend component: visibility rules, soft-success toast, no-retry, submit-lock.
- Real Edge Function HTTP: full §12 matrix (H1-H15).
- Negative authorization, cross-tenant, idempotency, suppression, concurrency
  (§13), audit exactly-once, PII safety.

**Runtime verification**
- **VERIFY EDGE RUNTIME IS ACTUALLY SERVING** before any HTTP certification
  (F16-01): 503 probe + an application-layer read must succeed; `supabase start`
  exit 0 is **not** accepted as evidence.

**Environment verification**
- Keep **LOCAL / STAGING / PRODUCTION** separate; never promote evidence
  across environments. Local green ≠ staging/prod proof.

---

## Section 21 — Evidence Standard

Every future certification claim records: **command · environment · expected
output · captured evidence · interpretation · PASS/FAIL/BLOCKED**.

- `BLOCKED` is never recorded as `PASS` (e.g. Docker/Edge unavailable →
  BLOCKED).
- "Not tested" is never "assumed working".
- A declared test count is not a passed test count; a 401 alone is not
  privilege-denial proof (require the specific signal, e.g. the app-level
  `ROLE_INSUFFICIENT`/`HOSPITAL_ACCESS_DENIED` body and/or SQLSTATE 42501, per
  F16-05 discipline).
- Local results are never presented as staging/production verification.
- Vocabulary: PASS · FAIL · BLOCKED · UNPROVEN · NOT APPLICABLE.

---

## Section 22 — Implementation Sequence (future)

```
Step 1  Freeze this specification + resolve §19 owner decisions (Assign source;
        detail-enrichment scope) BEFORE coding
Step 2  Implement API wrappers + types (§10) — read paths untouched
Step 3  Implement frontend mutation UX on AdminAlerts (§5/§11)
Step 4  Add frontend/unit coverage (visibility, already_*, submit-lock)
Step 5  Add real HTTP write tests (§12) + concurrency test (§13)
Step 6  VERIFY Edge Runtime actually serving (F16-01)
Step 7  Run LOCAL HTTP certification (H1-H15)
Step 8  Run LOCAL concurrency certification
Step 9  Review audit + security evidence (§14/§15)
Step 10 Stage deployment ONLY after explicit owner authorization
Step 11 Staging verification (write branches on staging)
Step 12 Production decision handled separately (never implied)
```

If `Assign` is descoped (owner choice), Steps 2-9 exclude it; if a new
assignable-users read is approved, it lands as an additive, privilege-reviewed
migration before Step 3.

---

## Section 23 — Risk Register

| Risk | Probability | Impact | Mitigation | Owner | Gate |
| --- | --- | --- | --- | --- | --- |
| Stale UI after a mutation | Med | Med | server-authoritative reconcile (§8) | Frontend | Step 4/7 |
| Duplicate clicks (guarded) | Med | Low | per-row submit-lock; guards make repeats benign | Frontend | Step 4 |
| Suppression duplication | Med | Low (existence semantics) | single-submit + confirm; additive windows benign (§7) | Frontend/Product | Step 7 H-9/supp |
| Concurrent admin actions | Low | Low | DB `FOR UPDATE`; prove via §13 | Backend(existing)/Test | Step 8 |
| Cross-tenant mutation | Low | Critical | header + `loadAuthorizedAlert` + RPC scope | Backend | Step 7 H7 |
| Global-admin context mistake | Med | Med | reuse G-08 acting ctx; disable without scope (§9) | Frontend | Step 4 |
| Audit inconsistency | Low | High | backend-owned audit; display-only client (§14) | Backend | Step 9 |
| Runtime not serving (false green) | Med | High | explicit serving verification (§20/§22) | Env | Step 6 |
| Timeout / unknown outcome | Med | Med | refetch-first, no blind resend (§8) | Frontend | Step 4 |
| Accidental PII logging | Low | High | observability contract (§17) | Frontend/Backend | Step 9 |
| Backend/frontend semantic drift | Low | High | this spec is the single contract; no invented states (§2/§3) | All | Step 1 |
| Assign has no target directory | High | Blocks Assign | resolve §19 before coding | Owner/Product | Step 1 |

(Probability/Impact are qualitative, per the tasking; no fabricated numbers.)

---

## Section 24 — Final Implementation-Readiness Verdict

**Overall verdict: NOT IMPLEMENTATION-READY** — the specification is complete,
but two product/owner decisions must be resolved before safe implementation,
and no HTTP/concurrency/staging/production proof exists yet. A specification
being complete does **not** make C2 production-ready.

Readiness by axis:

- **Backend readiness:** ✅ for `acknowledge` / `resolve` / `escalate` /
  `suppress` (implemented, RPC-integration-tested, service-role-gated,
  concurrency-guarded). ⚠️ **not ready for `Assign`** — no assignable-user
  source is exposed to the UI (needs a new read or descoping → §19).
- **Frontend readiness:** ❌ not implemented (wrappers + UI are proposals here).
- **Product-decision readiness:** ⚠️ **two owner decisions still required:**
  1. **Assignee source** (§19 item 1) — add a scoped read, reuse a doctor read,
     or descope `Assign`.
  2. **Detail-enrichment scope** (§19 item 2) — whether `resolution_notes`,
     actor names, activity history, and current-suppressions visibility are in
     scope (each needs a new read) or descoped.
  - Secondary (only if strict guarantees are mandated): hard single-suppression
     invariant (D5), transaction-accurate audit `oldData` (D9).
- **HTTP-test readiness:** ❌ write branches UNPROVEN over real HTTP (**R2**).
- **Staging readiness:** ❌ NOT PROVEN (nothing deployed; local-only).
- **Production readiness:** ❌ UNTOUCHED / UNPROVEN (no deploy, no prod action).

**Owner decisions still required (explicit list):**
- OD-1: `Assign` target-selection source (§19.1).
- OD-2: Alert detail enrichment reads — in scope or descope (§19.2).
- OD-3 (conditional): hard single-suppression-window guarantee (D5).
- OD-4 (conditional): transaction-accurate audit snapshot (D9).

**Recommended path to READY:** resolve OD-1 and OD-2 (a single owner ruling);
the four guarded mutations can then proceed with **no backend change**, and any
approved enrichment/Assign read is added as a review-privileged, additive
migration. This document authorizes **no** code change by itself.

---

*End of specification. This task modified no repository file other than creating
this document. No commit, push, deployment, or environment/secret change was
performed. Closed workstreams G-03…G-11 and C2b were not reopened.*
