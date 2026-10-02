# SETURA HOSPITAL OS — PHASE 7 — C2 MUTATION SPECIFICATION / OWNER DECISION GATE

**PRE-IMPLEMENTATION SPECIFICATION & DECISION DOCUMENT — NOT AN IMPLEMENTATION REPORT**

**NO SOURCE CHANGES · NO SQL CHANGES · NO MIGRATION CHANGES · NO RLS CHANGES ·
NO GRANT CHANGES · NO EDGE FUNCTION CHANGES · NO FRONTEND CHANGES · NO
DEPLOYMENT · NO PUSH · NO COMMIT · PRODUCTION UNTOUCHED**

Date: 2026-10-01 · Baseline HEAD: `0fceb50` (G-11) · Method: current-source
inspection of `supabase/functions/alert-center/index.ts`,
`supabase/functions/command-center/index.ts`,
`supabase/functions/_shared/enterprise/broadcasts.ts`,
`supabase/migrations/47_enterprise_command_center.sql`,
`apps/web/src/api/alertCenter.ts`,
`apps/web/src/api/commandCenter.ts`,
`tests/integration/enterprise_command_center.test.ts`,
`tests/integration/alert_center_http.test.ts`, plus the authoritative planning
documents `PHASE_7_NEXT_WORKSTREAM_INVESTIGATION_AFTER_G11.md` and
`SETURA_FINAL_MASTER_ROADMAP.md`.

Every claim below is tagged with one of:

- **[EXISTING BACKEND FACT]** — verified in current source / SQL / tests.
- **[REQUIRED FUTURE SPECIFICATION]** — what an approved spec must define.
- **[PROPOSED FUTURE IMPLEMENTATION]** — not authorized; needs owner approval.
- **[UNDEFINED — OWNER / PRODUCT DECISION REQUIRED]** — the repository does
  not currently decide this; it must not be invented here.

---

## 1. Executive Summary

The post-G-11 investigation established that the frontend READ-reachability
series G-02…G-11 is exhausted, and that the only remaining UI-adjacent
capabilities are two **WRITE** surfaces: **C2 — Alert Lifecycle Mutation**
(`acknowledge` / `assign` / `resolve` / `escalate` / `suppress`) and
**C2b — Broadcast Composer** (5 `broadcast_*` actions). Both are
**backend-complete and integration-tested at the RPC/shared-function layer**
but **have never been driven over real HTTP on their write branches (R2)** and
**have no frontend wrapper or UI**.

This document is a **decision gate**, not a build. It records the exact backend
contract a future mutation UI must respect, enumerates what an authoritative
spec must still define, flags what is genuinely undefined (product decisions),
and lays out the two legitimate owner directions: commission the C2 (±C2b)
mutation workstream, or open the Phase 7 production-readiness spine. **No
implementation is authorized or performed here.** The owner decision is
requested at §20 / §26.

---

## 2. Current SETURA State

- **[EXISTING BACKEND FACT]** Local `HEAD = 0fceb50`
  ("Add Hospital Operations Analytics Read Surface (G-11)"); parent `88df4fc`
  (G-10); `origin/main` at `90100aa` (G-09) — local `main` is **ahead 2**
  and unpushed. Verified this session with `git log --oneline -5` /
  `git rev-parse`.
- **[EXISTING BACKEND FACT]** Working tree carries no tracked source edits:
  only `graphify-out/cache/stat-index.json` (generated cache) is dirty and a
  set of untracked session artifacts (logs/PNGs/reports) exist. The tree **is**
  a Git repository, superseding the older AGENTS.md §13 "not a Git repo"
  baseline note (truth hierarchy: actual state > report).
- **[EXISTING BACKEND FACT]** G-11 remains CLOSED at its certified boundary:
  IMPLEMENTED + INTEGRATION VERIFIED (local); staging NOT YET PROVEN;
  production UNTOUCHED. Not reopened here.
- **[EXISTING BACKEND FACT]** `alert-center` exposes 7 actions
  (`list`, `analytics`, `acknowledge`, `assign`, `resolve`, `escalate`,
  `suppress`); only `list`/`analytics` are wrapped by the frontend
  (`api/alertCenter.ts`). `command-center` exposes 10 actions; only the 5
  reads are reachable — the 5 `broadcast_*` writes are deliberately unwrapped
  (`api/commandCenter.ts:21`).

---

## 3. G-02…G-11 Read-Series Closure

**[EXISTING BACKEND FACT]** Per `PHASE_7_NEXT_WORKSTREAM_INVESTIGATION_AFTER_G11.md`
§6 (per-action census re-derived this session from the current Edge Function
action constants and `api/*` wrappers):

| Function | Read actions | Reachable via | Unreached remainder |
| --- | --- | --- | --- |
| enterprise-reports | 7 | G-05 + G-06 | none |
| financial-command-center | 3 | G-09 | none |
| command-center | 5 reads | G-03 | 5 `broadcast_*` (WRITE) |
| executive-analytics | 7 | G-11 / G-08 / G-06 equivalents | none (reads) |
| alert-center | 2 reads | G-10 | 5 lifecycle (WRITE) |

**Conclusion (unchanged): NO further frontend READ-reachability gap exists.**
The remainder is exclusively write surfaces (C2, C2b) and machine/webhook/cron/
financial engines that are intentionally not generic frontend surfaces. This
document must not be read as authorizing an invented G-12 read wrapper.

---

## 4. C2 Existing Backend Inventory

**[EXISTING BACKEND FACT]** Full inventory of the alert lifecycle write path:

- **Edge layer** — `supabase/functions/alert-center/index.ts`:
  - Action set `ALERT_ACTIONS` (l.43-51); alert-target actions
    `ALERT_TARGET_ACTIONS = {acknowledge, assign, resolve, escalate}` (l.56-61).
  - Zod `Schema` (l.63-105) with refinements: `alertId` required for the four
    alert-target actions; `assigneeId` required for `assign`; `alertKey` +
    `activeUntil` required for `suppress`. `notes` ≤ 1000 chars; `reason` ≤ 200;
    `alertKey` 3–128.
  - Authorization gate runs **before** any RPC: `X-Hospital-ID` header required
    (l.171-177) → `resolveAuth(req, hospitalId, logger)` (l.179) →
    `requireRole(["hospital_admin","global_admin"])` (l.181).
  - Tenant isolation for alert-target actions via `loadAuthorizedAlert`
    (l.119-150): reads the row, `ValidationError("Alert not found")` when
    missing, `ForbiddenError("Alert belongs to different hospital")` when
    `hospital_id !== header hospital`.
  - Dispatch maps action → RPC name (l.333-339) and calls it through
    `getServiceClient()` (service-role). `outcome.ok !== true` →
    `ValidationError` (l.354-358). Audit via `logAuditEvent` (l.360-384).
- **RPC layer** — `supabase/migrations/47_enterprise_command_center.sql`:
  `acknowledge_alert` (l.169), `assign_alert` (l.211), `resolve_alert` (l.258),
  `escalate_alert` (l.303), `suppress_alerts` (l.347); supporting
  `log_alert_activity` (l.142), `is_alert_suppressed` (l.130),
  `fire_managed_alert` (l.391).
- **Grants** — 47 l.2516-2548: all five mutation RPCs are `GRANT EXECUTE … TO
  service_role` **only**; `alert_activity_log` INSERT/SELECT and
  `alert_suppressions` full DML are service-role only. A browser role cannot
  reach them directly.
- **Frontend (read-only today)** — `apps/web/src/api/alertCenter.ts` sends
  only `list`/`analytics` and documents that mutation wrappers are a separate
  future workstream; there is deliberately **no** exported mutation wrapper.
- **Tests** — `tests/integration/enterprise_command_center.test.ts` l.816-972
  prove RPC-level dedupe / idempotency / escalate-once / suppression semantics
  (details §5, §7).

**[REQUIRED FUTURE SPECIFICATION]** A C2 UI spec must consume this exact
contract, not redefine it.

---

## 5. Alert State Machine

**[EXISTING BACKEND FACT]** The alert "state" is not a single enum; it is a set
of independent columns on `alert_events` mutated by guarded
`SECURITY DEFINER` functions. Each of the four alert-target RPCs takes the row
`FOR UPDATE` (row lock) before reading, so concurrent transitions serialize.

Derived transitions (verbatim from 47 l.169-345):

| Mutation | Guard / current-state check | Transition on success | Repeat behavior | Terminal interaction |
| --- | --- | --- | --- | --- |
| `acknowledge` | `acknowledged_at IS NOT NULL` → short-circuit | set `acknowledged_at=now()`, `acknowledged_by=actor`; log activity `acknowledged` | returns `ok:true, already_acknowledged:true` (no second write, no second activity row) | **No `is_resolved` check** — a resolved alert can still be acknowledged |
| `assign` | `assigned_to IS NOT DISTINCT FROM assignee` → short-circuit | set `assigned_to`, `assigned_at=now()`; log `assigned` (note = assignee id) | returns `already_assigned:true` when same assignee; **reassign to a different person is allowed** and logs again | no terminal check |
| `resolve` | `is_resolved` → short-circuit | set `is_resolved=true`, `resolved_at`, `resolved_by`, `resolution_notes`; log `resolved` | returns `already_resolved:true` | acts as the soft terminal for the dedupe engine (§10) |
| `escalate` | `escalated_at IS NOT NULL` → short-circuit | set `escalated_at`, `escalated_by`, `severity='critical'`; log `escalated` | returns `already_escalated:true` — **escalation fires once** | **No `is_resolved` check** — a resolved alert can still be escalated |
| `suppress` | `p_active_until <= now()` → `ok:false, reason:window_in_past` | INSERT a new `alert_suppressions` row; returns `suppression_id` | **NOT idempotent** — every call inserts a new window row | operates on an `alert_key`, not a single row |

**[EXISTING BACKEND FACT]** Missing alert → `ok:false, reason:alert_not_found`
for all four alert-target RPCs (test l.914-921).

**[UNDEFINED — OWNER / PRODUCT DECISION REQUIRED]** Whether the UI should
**forbid** acknowledging/escalating an already-`resolved` alert, whether
`resolve` should be reversible (re-open), and whether a resolved alert may be
reassigned. The backend currently permits these cross-transitions; the
business/UX rule is not defined in the repository and must not be invented.

---

## 6. C2 Mutation Contracts

**[EXISTING BACKEND FACT]** Per-action request/response contract the UI must
respect (edge `Schema` + RPC return):

| Action | Required body | Optional body | Success envelope | Rejection envelope |
| --- | --- | --- | --- | --- |
| `acknowledge` | `action`, `alertId`(uuid) | — | `{action, alertId, result:{ok:true, already_acknowledged:bool}}` | `ok:false` → 400 `ValidationError` |
| `assign` | `action`, `alertId`, `assigneeId`(uuid) | — | `{…, result:{ok:true, already_assigned:bool}}` | same |
| `resolve` | `action`, `alertId` | `notes`(≤1000) | `{…, result:{ok:true, already_resolved:bool}}` | same |
| `escalate` | `action`, `alertId` | `notes`(≤1000) | `{…, result:{ok:true, already_escalated:bool}}` | same |
| `suppress` | `action`, `alertKey`(3-128), `activeUntil`(ISO datetime) | `reason`(≤200) | `{action, result:{ok:true, suppression_id}}` | `ok:false, reason` → 400 `ValidationError` (e.g. `window_in_past`) |

- All requests are `POST` (edge l.156-158 rejects other methods with 405) to
  the `alert-center` function with `X-Hospital-ID` header; the tenant **never**
  travels in the body.
- **[REQUIRED FUTURE SPECIFICATION]** The spec must fix the exact success/
  failure UX mapping (e.g., surfacing `already_*` as "already done, no change"
  vs an error), which the backend intentionally leaves as a soft success.

---

## 7. Idempotency Requirements

**[EXISTING BACKEND FACT]** The C2 mutations do **not** use an idempotency-key
column. Idempotency is **state-guard based**: each alert-target RPC checks the
relevant "already in target state" condition inside the `FOR UPDATE` lock and
returns a soft success without a second write or a second `alert_activity_log`
row. Proven in `enterprise_command_center.test.ts`:
- ack idempotency l.838-849 (`already_acknowledged` true on 2nd call);
- assign l.851-858; escalate-once l.860-871 (`already_escalated` true);
- resolve repeats l.885-897 (`already_resolved` true).

**[EXISTING BACKEND FACT]** `suppress` is the exception: it appends a new
suppression window each call (no guard beyond the past-window check), so it is
**not** naturally idempotent — two clicks create two active windows.

**[REQUIRED FUTURE SPECIFICATION]**
- The future UI MUST NOT build a weaker/parallel frontend idempotency system;
  it MUST rely on the server state guards for ack/assign/resolve/escalate.
- Duplicate-submit protection for `suppress` (and any action where a second
  row/transition is undesirable) must be specified: whether via the
  established platform idempotency mechanism (AGENTS.md §8) or an explicit
  server-side guard. **The choice is UNDEFINED — OWNER / PRODUCT DECISION
  REQUIRED.**
- Frontend retry must treat soft-success (`already_*`) as a successful no-op,
  never as an error to retry again.

---

## 8. Concurrency Requirements

**[EXISTING BACKEND FACT]** Concurrency for the four alert-target mutations is
**owned by the database**: `SELECT … FROM alert_events WHERE id=p_alert_id FOR
UPDATE` (47 l.186/229/276/321) serializes two admins acting on the same alert;
the second transaction observes the post-transition guarded state and returns
`already_*` rather than double-applying. The unit/integration evidence in §7
demonstrates the guard, not yet a true concurrent two-connection race.

**[REQUIRED FUTURE SPECIFICATION]**
- A real concurrent test (Admin A resolves while Admin B acknowledges/
  escalates the same alert on separate connections) must assert: exactly one
  transition per guarded field, one activity row per guarded first-transition,
  and server-authoritative final state.
- The UI must render **server-authoritative state after every mutation**
  (refetch/reconcile), must not trust optimistic local flips, and must handle
  the `already_*` soft-success and a stale-UI (row changed since load) case.
- **[UNDEFINED — OWNER / PRODUCT DECISION REQUIRED]** stale-state policy:
  last-write-wins (current backend) vs an explicit expected-version/ETag guard
  (not implemented today).

---

## 9. Audit Requirements

**[EXISTING BACKEND FACT]** Two distinct, complementary record surfaces exist
and both must be preserved:

1. **Domain activity** — `public.alert_activity_log` written by each RPC via
   `log_alert_activity(alert_id, hospital_id, actor_id, action, notes)`; action
   values `acknowledged | assigned | resolved | escalated`. Insert-only,
   service-role-only (47 l.2503-2507).
2. **Platform audit** — `logAuditEvent` at the edge (index.ts l.360-384) with:
   `hospitalId`, `actorUserId=auth.userId`, `entityType="alert_event"`,
   `entityId=alert.id`, `actionType="alert_center"`,
   `severity = escalate ? "high" : "low"`,
   `oldData = {severity, is_resolved, acknowledged_at, assigned_to,
   escalated_at}` (pre-transition snapshot from `loadAuthorizedAlert`),
   `newData = {action, alert_key, assigneeId, notes, result}`.

   `suppress` audits separately (l.275-298): `entityType="alert_suppression"`,
   `severity="medium"`, `oldData=null`,
   `newData={suppressionId, alertKey, activeUntil, reason}`, with the F16-class
   guard that a non-UUID `suppression_id` never reaches the UUID `entityId`
   column.

**[REQUIRED FUTURE SPECIFICATION]** The UI must not duplicate or bypass these;
it inherits them. It must not fabricate audit (e.g., local-only "acknowledge"
that never calls the RPC). Note: because the audit `oldData` is captured from a
separate read **before** the locking RPC, the spec should confirm whether that
snapshot must be moved inside the transaction for strict concurrency-accurate
old-state (currently best-effort). **[UNDEFINED — precision is a product/
security decision.]**

---

## 10. Notification / Side-Effect Requirements

**[EXISTING BACKEND FACT]** The C2 mutation RPCs themselves do **not** enqueue
notifications, send WhatsApp, or invoke Realtime directly — their side effects
are limited to the `alert_events` column update + `alert_activity_log` insert +
edge audit. Realtime visibility, if any, comes from the client subscribing to
`alert_events` changes (delivery mechanism is a frontend concern, not written
by these RPCs).

**[EXISTING BACKEND FACT]** The suppression engine interacts with the alert
**firing** path (not the lifecycle writes): `fire_managed_alert` drops a
suppressed key (`is_alert_suppressed`) and otherwise inherits `fire_alert`'s
**1-hour dedupe**; resolved alerts no longer dedupe (refire creates a new row)
— proven test l.832-912.

**[REQUIRED FUTURE SPECIFICATION]** Whether an alert lifecycle write (e.g.
escalate) should fan out a notification to admins is **NOT** performed by C2
today; that behavior belongs to C2b's `broadcast_alert`. Do not conflate the
two. **[UNDEFINED — OWNER / PRODUCT DECISION REQUIRED]** whether the future C2
UI should surface a "notify on escalate" affordance that calls the separate
broadcast action.

---

## 11. Authorization / Tenant Requirements

**[EXISTING BACKEND FACT]**
- Roles: `requireRole(["hospital_admin","global_admin"])` (index.ts l.181) for
  **every** action including mutations. receptionist/doctor/anonymous are
  denied at this gate.
- Tenant: header-only (`X-Hospital-ID`); missing header → `ValidationError`
  before auth. Alert-target actions re-check `hospital_id === header hospital`
  (`loadAuthorizedAlert`) → `ForbiddenError` on mismatch. `suppress` passes
  `p_hospital_id=header` to the RPC, producing a **hospital-scoped** window
  (other tenants unaffected — proven test l.961-971).
- DB boundary: mutation RPCs are service-role-only (§4), so a browser can never
  call them directly; the edge `getServiceClient()` is the only caller.
- **[EXISTING BACKEND FACT]** The G-10 read HTTP harness
  (`alert_center_http.test.ts`) already proves fail-closed denial for reads
  (role 403 `ROLE_INSUFFICIENT`, foreign tenant 403 `HOSPITAL_ACCESS_DENIED`,
  missing header, anonymous) — closing the P3-01 500-vs-403 concern **for reads
  only**. Writes have no such HTTP proof (see §13).

**[REQUIRED FUTURE SPECIFICATION]** The mutation UI must inherit (never weaken)
this model and the write branches must reproduce the same fail-closed HTTP
evidence (403 with `data === undefined`, never a loud 500).

---

## 12. Global Admin Acting Context

**[EXISTING BACKEND FACT]** A `global_admin` is authorized by the same
`requireRole` gate but **still must scope via `X-Hospital-ID`**: the edge
header requirement and `loadAuthorizedAlert` tenant check apply identically to
global admins (index.ts doc-comment l.18-20; the G-10 read harness exercises
global_admin list/analytics against a chosen hospital — l.460-466). There is
**no** cross-tenant mutation path in C2: a global admin acts on **one
hospital's** alert at a time, chosen by the header they send.

**[UNDEFINED — OWNER / PRODUCT DECISION REQUIRED]** how the UI lets a global
admin **pick** the acting hospital (portfolio→hospital drill-in) and whether
that selection is constrained to hospitals the global admin may manage. The
backend does not enforce a "manageable portfolio" set on these mutations today.

---

## 13. Real HTTP Verification Requirements (R2 debt)

**[EXISTING BACKEND FACT]** `alert_center_http.test.ts` drives **only**
`action:"list"` and `action:"analytics"` over real HTTP (verified: no write
action appears in that file). The write actions are proven at the **RPC /
integration** layer (`enterprise_command_center.test.ts`) but are **UNPROVEN
over real HTTP end-to-end** — this is risk **R2** in the post-G-11 report.
Green RPC/unit/integration tests do **NOT** make the write branches
production-ready.

**[REQUIRED FUTURE SPECIFICATION]** Before any C2 write surface may be called
verified, a real-HTTP matrix must be defined and executed against a running
local stack. At minimum:

| # | Case | Expected |
| --- | --- | --- |
| H1 | authorized `hospital_admin` mutation success | 200, single state change, audit row |
| H2 | `global_admin` scoped mutation | 200 |
| H3 | receptionist denial | 403 `ROLE_INSUFFICIENT`, no mutation |
| H4 | doctor denial | 403, no mutation |
| H5 | anonymous | 401/403 fail-closed |
| H6 | missing `X-Hospital-ID` | 4xx `ValidationError`, before auth |
| H7 | cross-tenant alert | 403 `HOSPITAL_ACCESS_DENIED`, zero side effect |
| H8 | invalid transition (e.g. suppressed window in past) | 4xx soft reject |
| H9 | idempotent replay (repeat same mutation) | single transition, `already_*` |
| H10 | concurrent transition (two connections) | serialized, one authoritative result |
| H11 | terminal-state protection | per chosen policy (§5/§8) |
| H12 | audit evidence | audit + activity rows created exactly once |
| H13 | no unintended side effect | notifications only where specified |
| H14 | PII safety | patient PII not leaked in logs/audit beyond existing posture |
| H15 | 500-vs-403 fail-closed | denial never surfaces a loud 500 (P3-01 discipline) |

**[REQUIRED FUTURE SPECIFICATION]** **Edge Runtime serving verification must
precede any HTTP certification** because of F16-01: `supabase start` can exit 0
while the Edge Runtime container (`RestartPolicy=no`) is down. Every HTTP
assertion is void until the runtime is confirmed actually serving (503 probe +
application-layer serving check, per the G-11 discipline).

---

## 14. Frontend Safety Requirements

**[PROPOSED FUTURE IMPLEMENTATION — not authorized]** Any future C2 UI must:

- Route mutations through a new `api/alertCenter.ts` mutation wrapper that is
  added deliberately (today the file intentionally exports none, so a mutation
  cannot appear "by accident").
- Send tenant **only** via the session-derived `X-Hospital-ID` header set by
  `callFunction`; never in the body or URL.
- Treat server `already_*` soft-success correctly; no fabricated success.
- Reconcile from server state after mutation (no optimistic-only truth).
- Guard duplicate clicks (see §7, esp. `suppress`).
- Be role- and tenant-aware in rendering actions, mirroring the read surface's
  routing (reception/doctor must never see mutation affordances).
- Keep the browser console clean and never log PII.

---

## 15. C2b Existing Broadcast Inventory

**[EXISTING BACKEND FACT]** `command-center` write actions
(`command-center/index.ts` l.58-62): `broadcast_queue_summary`,
`broadcast_doctor_delay`, `broadcast_closure`, `broadcast_admin_notice`,
`broadcast_alert`.

- Same auth gate as reads: header → `resolveAuth` →
  `requireRole(["hospital_admin","global_admin"])` (l.181-191).
- Payload `Schema` (l.74-125): `queueSessionId` required for queue_summary /
  doctor_delay; `delayMinutes`(1-1440) required for doctor_delay; `kind` +
  `message`(≤500) required for admin_notice; `alertId` required for
  broadcast_alert. `reason` ≤ 200 optional.
- Tenant checks: `loadBroadcastSession` rejects a session of another hospital
  (l.127-160); `broadcast_alert` re-checks the alert row's `hospital_id`
  (l.438-440).
- Delivery delegates to `supabase/functions/_shared/enterprise/broadcasts.ts`:
  every message is enqueued through the established `enqueue_job`
  → `send_whatsapp_message` pipeline with a **deterministic idempotency key**
  (e.g. `wa_q_summary_{session}_{booking}_{liveToken}`,
  `wa_ops_alert_bcast_{alertId}_{adminId}`), so a replay never duplicates a
  delivered message.
- Patient-facing broadcasts are gated on the `whatsapp_queue_updates` feature
  flag; admin-facing broadcasts always enqueue. Enqueue is best-effort: a
  failure logs a warning and does **not** fail the request.
- Audit at edge l.467-482: `entityType="whatsapp_broadcast"`,
  `actionType="operational_alert"`, `severity="medium"`, `oldData=null`,
  `newData={action, broadcast:{kind, enqueued}, reason}`.
- Frontend: `api/commandCenter.ts:21` explicitly does **not** wrap
  `broadcast_*`.

---

## 16. C2b Mutation Contracts

**[EXISTING BACKEND FACT]** Each broadcast returns
`{action, broadcast:{kind, enqueued}}` (count of jobs enqueued) and performs no
synchronous delivery. Delivery is **asynchronous via the background worker**.

**[EXISTING BACKEND FACT — critical caveat]** Because the worker is
documented-disabled by default (`.env.example` `ENABLE_WORKER_TRIGGER=false`,
P0-03) and no scheduler exists (P0-02/NPD-05), an `enqueued: N` result does
**NOT** prove message delivery. A C2b spec must state that "success" means
"enqueued", and any delivery guarantee depends on the worker/production
activation owned under Option B.

**[REQUIRED FUTURE SPECIFICATION]** recipient-selection UX, preview-before-send,
and rate/spam protection are **UNDEFINED — OWNER / PRODUCT DECISION REQUIRED**;
they must not be invented here.

---

## 17. C2 vs C2b Scope Decision

**[REQUIRED FUTURE SPECIFICATION — decision input]** Repository evidence:

- C2 (alert lifecycle) writes to the **operational alert record** + activity +
  audit; idempotency is state-guard based; touches **no money and no
  messaging**.
- C2b (broadcasts) writes to the **job queue / messaging pipeline** via
  `enqueue_job`; idempotency is deterministic-key based; touches
  **patient/admin comms** and depends on the worker (Option B dependency).
- They share the **auth gate, tenant model and edge audit primitive**
  (§18) but have **different side-effect domains, different idempotency
  mechanisms, and different delivery semantics**.

Recommended framing for the owner: **C2 is the more self-contained candidate**
(its backend effects complete inside the DB); **C2b's end-to-end proof is
coupled to worker/scheduler activation**, so a combined spec should sequence
C2b delivery verification behind Option B infrastructure. Whether to write one
combined spec or two is the owner's call (§20).

---

## 18. Shared Mutation Infrastructure Requirements

**[EXISTING BACKEND FACT]** Both surfaces already share, and must reuse rather
than duplicate: `handleCors`, `resolveAuth`/`requireRole`,
`getServiceClient`, `parseBody`/Zod, `createRequestLogger`, `createMetrics`,
`createTraceContext`, `logAuditEvent`, `successResponse`/`handleErrorResponse`,
and the error hierarchy (`ValidationError`/`ForbiddenError`/`InternalError`).

**[REQUIRED FUTURE SPECIFICATION]** A future mutation UI must extend the
**existing** `callFunction` + audit + auth primitives (AGENTS.md §6/§7). It
must NOT introduce a second client idempotency layer, a second audit writer, or
a parallel authorization check. Any new shared helper needs an explicit
architectural reason.

---

## 19. Phase 7 Production-Readiness Alternative (Option B)

**[EXISTING BACKEND FACT]** From `SETURA_FINAL_MASTER_ROADMAP.md` and AGENTS.md
§13, the production-readiness spine consists of owner/environment actions that
no repository-only feature work can close. Classification:

| Item | Class |
| --- | --- |
| Scheduler ruling **NPD-05** (no scheduler exists; pg_cron not installed) | OWNER DECISION |
| Worker activation ruling (`ENABLE_WORKER_TRIGGER=false`; lease-reclaim P0-01) | OWNER DECISION + REPOSITORY WORK |
| Deployment / push authorization (local `main` ahead 2, unpushed) | OWNER DECISION |
| Staging verification of unproven G-10/G-11 surfaces | ENVIRONMENT-SPECIFIC VERIFICATION |
| Production privilege re-measurement (F16-04/§7; local census ≠ production) | ENVIRONMENT-SPECIFIC VERIFICATION |
| Vault / secrets provisioning (none local) | INFRASTRUCTURE WORK |
| Backup / DR | INFRASTRUCTURE WORK |
| Load testing | INFRASTRUCTURE WORK |
| Pilot readiness / onboarding | OWNER DECISION |

**[Explicit boundary]** None of the above is completed merely because code
exists locally; each is out of scope for this session and is either an owner
decision, an infrastructure task, or environment-specific verification. **No
production action is performed or implied here.**

---

## 20. Owner Decisions Required

See §26 decision table. The owner must choose **one** direction (the
investigation explicitly does not choose on their behalf).

---

## 21. Explicit Non-Goals

- No C2 / C2b implementation, code, SQL, migration, RLS, grant, Edge Function,
  or frontend change.
- No new analytics/report/read wrapper (read series is exhausted — §3).
- No deployment, push, or commit.
- No invention of alert UX semantics, state-transition business rules,
  recipient rules, notification policy, escalation timing, SLAs, permission or
  audit semantics beyond what the source already does.
- No conversion of local RPC/integration proof into staging or production
  certification.

---

## 22. Stop Conditions

- Any request to build C2/C2b UI **before** an owner-approved authoritative
  spec → STOP (violates AGENTS.md §8 mutation discipline / governance R1/R5).
- Any C2b delivery claim that depends on the worker → BLOCKED until Option B
  activation (§16).
- Any real-HTTP write certification attempted without Edge Runtime serving
  verification → invalid per F16-01 (§13).
- Any need for new backend actions (not the case for C2/C2b, unlike C4) would
  escalate to a backend-design workstream.

---

## 23. Proposed Future Implementation Boundary

**PROPOSED ONLY — REQUIRES OWNER APPROVAL. NOT a finalized boundary.**

Likely touch points **after** approval (to be authored in the real spec):
- `apps/web/src/api/alertCenter.ts` — add deliberate mutation wrappers.
- A new hospital-admin alerts mutation surface built on the existing
  `/admin/alerts` read route.
- `apps/web/src/api/commandCenter.ts` + a broadcast composer — **only if C2b
  is approved**.
- New real-HTTP write integration tests (the §13 matrix) — likely
  `tests/integration/alert_center_http.test.ts` extensions or a sibling.

**Files that should remain UNTOUCHED unless the approved spec proves
otherwise:** all `supabase/migrations/` (applied history); the Edge Functions
`alert-center`, `command-center`, and `_shared/enterprise/broadcasts.ts`
(backends are complete); the other closed G-03…G-11 surfaces; and
`GRAPH_REPORT.md` / `graphify-out/`.

---

## 24. Proposed Future Test Matrix

**[PROPOSED FUTURE SPECIFICATION — non-binding until approved]**

- **HTTP:** the §13 H1–H15 matrix, preceded by Edge Runtime serving
  verification.
- **Frontend:** role routing, tenant-context propagation, action availability,
  server-authoritative reconciliation, retry safety, duplicate-click safety,
  stale-state handling, error handling, no unauthorized mutation, no fabricated
  success, clean console.
- **Regression:** existing frontend suite (≥371 per G-11 baseline),
  `enterprise_command_center`, `privilege_isolation`, `multi_role_auth`, and
  all existing G-03…G-11 surfaces.
- Adjust only when repository evidence requires it.

---

## 25. Certification Vocabulary

Applied per AGENTS.md §5. Current honest status of C2/C2b:

- Backend mutation code: **IMPLEMENTED** (source/SQL present).
- Mutation semantics: **INTEGRATION VERIFIED (RPC-level, local)** for
  idempotency/dedupe/suppression; **UNPROVEN over real HTTP** (write branches)
  and **UNPROVEN under true concurrent two-connection races**.
- Frontend mutation surface: **NOT AUTHORIZED / NOT IMPLEMENTED**.
- Staging: **NOT PROVEN**. Production: **UNTOUCHED / UNPROVEN**.
- This document itself: **SPECIFICATION / DECISION GATE** only. **No**
  "ready", "verified", "secure", or "certified" claim is made for any mutation
  surface.

---

## 26. Final Decision Gate

| Decision | Meaning |
| --- | --- |
| **APPROVE C2 SPECIFICATION** | Authorize a detailed, implementation-ready C2 Alert Lifecycle Mutation spec/workstream (still no code until a follow-on implementation phase) |
| **APPROVE C2 + C2b** | Authorize a combined mutation spec (sequence C2b delivery proof behind Option B worker activation — §16/§17) |
| **OPEN PHASE 7 READINESS** | Pause feature work; pursue staging/production readiness (NPD-05, push/deploy authorization, production privilege re-measurement, secrets/backup/DR — §19) |
| **DEFER** | No implementation and no spec commissioning yet |

**This document does not choose.** The owner's ruling determines the next
phase. Until an approved authoritative spec exists, C2 and C2b remain
BACKEND-COMPLETE / UI-NOT-AUTHORIZED, and their write branches remain
HTTP-UNPROVEN (R2).

---

*End of specification/decision gate. Only this document was created; no source,
SQL, migration, RLS, grant, Edge Function, frontend, deployment, push, or
commit was performed.*
