# SETURA HOSPITAL OS — PHASE 7 — POST-G-11 NEXT WORKSTREAM INVESTIGATION

**INVESTIGATION ONLY — NO SOURCE CHANGES — NO COMMIT — NO DEPLOYMENT — PRODUCTION UNTOUCHED**

Date: 2026-10-01 · Baseline HEAD: `0fceb50` · Method: current-source
inspection (routes, `api/*` wrappers, Edge Function action constants, RPC
tests) plus the authoritative planning documents. No candidate was invented;
every conclusion cites repository evidence.

---

## 1. Executive Summary

G-11 closed the last hospital-scoped READ action that was UI-intended and
frontend-unreachable. A fresh per-action census of all Edge Functions with
`action` dispatchers shows **every admin-facing read action is now
reachable** (G-03, G-05, G-06, G-08, G-09, G-10, G-11 boundaries together
consume all 5 `command-center` reads, all 7 `enterprise-reports` actions,
all 3 `financial-command-center` reads, all 7 `executive-analytics`
actions — directly or via G-06's equivalent report types — and both
`alert-center` reads). The remaining unreached capabilities are all
**mutations or machine engines**: the 5 `alert-center` lifecycle writes and
5 `command-center` `broadcast_*` writes (PRODUCT GAPs requiring an
authoritative mutation spec), the financial write engines (FINANCIAL
WORKSTREAM, not ready), doctor leave/schedule (BACKEND GAP — no Edge
Function/RPC write path exists), and the production/autonomy items
(OWNER BLOCKERs). **Therefore no trivially-ready next workstream exists.**
The recommended next authoritative step is a product decision, not code:
either commission the C2 Alert Lifecycle Mutation specification (the most
backend-complete remaining candidate) or open the Phase 7
production-readiness spine. This investigation does not implement either.

## 2. Current Git State

- `HEAD = 0fceb50` ("Add Hospital Operations Analytics Read Surface
  (G-11)") — confirmed as the current local HEAD, as expected.
- Branch `main`; parent `88df4fc` (G-10); grandparent `90100aa` (G-09,
  = `origin/main`).
- Relationship to origin: **`main` is ahead 2** (`88df4fc`, `0fceb50` not
  pushed). Nothing was pushed by this investigation (spec §6A/§15).
- Working tree: only `graphify-out/cache/stat-index.json` modified
  (generated cache, deliberately never staged) and 116 untracked artifacts
  (session logs, PNGs, temp JSON, old run outputs). No tracked source file
  is dirty.

## 3. G-11 Closure Confirmation

Per `PHASE_7_G11_OPERATIONS_ANALYTICS_IMPLEMENTATION_REPORT.md` (committed
in `0fceb50`): local real HTTP 14/14; frontend 371/371 (339 baseline + 32
new); regressions `enterprise_command_center` 23/23,
`privilege_isolation` 22/22, `multi_role_auth` 12/12; typecheck/build/
check/lint/migrations/secret-scan green at baseline. Certification states:
IMPLEMENTED + INTEGRATION VERIFIED (local); staging NOT YET PROVEN;
production UNTOUCHED. **G-11 is closed; not reopened by this
investigation.** The Edge Runtime startup finding (F16-01 class:
`supabase start` exit 0 while the container was down; 503 probed and
application-layer serving verified before HTTP evidence) is recorded as an
environment finding, not a product defect.

## 4. Closed Workstream Register (unchanged, plus G-11)

`G-02 booking status · G-03 Command Centre · G-05 Audit & Compliance ·
G-06 Executive Reports · G-07 Staff Reschedule · AUTH LOOP · G-08 Global
Portfolio · G-09 Finance/Collections · G-10 Alert Center · G-11 Operations
Analytics`. None was re-audited or modified here; this investigation only
read their committed evidence and current source.

## 5. Frontend Route Inventory (current `App.tsx`)

`/login`, `/reception`, `/reception/book`, `/reception/walk-in`,
`/reception/patients`, `/reception/notifications`, `/queue`, `/doctor`,
`/bookings/:bookingId`, `/admin`, `/admin/audit`, `/admin/reports`,
`/admin/financial`, `/admin/portfolio`, `/admin/alerts`,
**`/admin/operations`** (new since baseline; G-11), plus the `*` fallback.
No route or nav entry was found without a backing surface, and no backing
surface was found without a route.

## 6. Edge Function Reachability Inventory (action-level, from current source)

Backend action constants vs frontend `api/*` wrappers (verified by direct
grep of `ANALYTICS_ACTIONS`, `ALERT_ACTIONS`, `ADMIN_ACTIONS`,
`REPORT_ACTIONS`, `FINANCE_ACTIONS` and every `callFunction(...)` body):

| Function | Actions total | Reachable via | Unreached remainder |
| --- | --- | --- | --- |
| executive-analytics | 7 | G-11 (daily_operations, doctor_rankings), G-08 (portfolio, benchmarks); weekly_operations / monthly_executive / doctor_performance via G-06 `generate` equivalents | **none (reads)** — the 3 direct analytics variants stay unwrapped ON PURPOSE (G-11 boundary test forbids duplication) |
| alert-center | 7 | G-10 (list, analytics) | acknowledge, assign, resolve, escalate, suppress — all WRITE |
| command-center | 10 | G-03 (overview, timeline, predictive, sla_dashboard, system_health) | broadcast_queue_summary / doctor_delay / closure / admin_notice / alert — all WRITE; `api/commandCenter.ts` documents the exclusion |
| enterprise-reports | 7 | G-05 + G-06 (all: generate, audit_search, audit_integrity, settlement_integrity, queue_integrity, doctor_ops_integrity, integration_matrix) | none |
| financial-command-center | 3 | G-09 (overview, forecast, reconciliation) | none |
| booking/queue/clinical (create-booking, cancel-booking, reschedule-booking, update-booking-status, queue-control, doctor-operations) | — | consumed by staff console | — |
| zero-caller engines | create-payment-order, verify-payment, process-refund, settlement-engine, send-reminders, carry-forward-tokens, compute-sla, refresh-rollups, run-background-worker, run-cron-minute, run-cron-nightly, monitoring-health-check, process-whatsapp-webhook, send-whatsapp-message, **queue-next-patient** | none | machine/webhook/cron/financial/queue-advance engines — intentionally NOT UI surfaces (post-G09 §5.2 classification, re-verified: still zero frontend callers) |

**Answer to §6B: no further legitimate frontend READ reachability gap
exists.** The two remaining UI-adjacent gaps (alert lifecycle, broadcasts)
are WRITE surfaces. `queue-next-patient` (a skip-locked queue-advance WRITE
endpoint that was missing from the post-G10 table — noted as an erratum in
that closed report, not a product issue) is a staff-action engine whose
user-facing equivalents already exist in `queue-control`/`doctor-operations`
consoles; it is NOT a read gap.

## 7. Backend Capability Inventory

1. **Implemented + tested + now reachable:** all admin read actions above.
2. **Implemented, tested, frontend-unreachable, READ-only-safe:** none at
   the Edge Function action layer. (Raw SQL availability reads —
   `is_doctor_available`, `get_doctor_availability_reason`,
   `get_doctor_unavailable_dates` — have no Edge Function action wrapper;
   exposing them requires new backend → stop condition, §8.)
3. **Write-capable, backend-complete, not UI-ready:** alert lifecycle (RPCs
   `acknowledge_alert`/`assign_alert`/`escalate_alert`/`resolve_alert`/
   `suppress_alerts` proven idempotent + deduped + escalation-once in
   `enterprise_command_center.test.ts:816+`; Edge wrappers implemented with
   `requireRole` + `loadAuthorizedAlert` + `logAuditEvent`); command-center
   broadcasts (SQL + realtime path integration-tested in the same suite).
   Neither has EVER been driven over real HTTP for the WRITE action (G-10/G-11
   HTTP harnesses cover reads only) — verification debt to be discharged by
   any future mutation spec.
4. **Write engines by design:** payments/refund/settlement (see 5), cron
   jobs, WhatsApp webhook/outbound, worker runners.
5. **Financial work requiring separate architecture:** refund ≤
   SETURA-collected enforcement, settlement cadence, partial refunds (P0-04
   chain, Phase 3 wave). Untouched.
6. **Infrastructure/production blockers:** none newly discovered; the known
   register stands (P0-01 lease reclaim, P0-02/NPD-05 no scheduler,
   P0-03 `ENABLE_WORKER_TRIGGER=false`, F16-01 restart policy, production
   privilege re-verification, deploy/secrets/backup).

## 8. Read/Write Classification

Read surfaces: 100% reachable. Unreached actions: 10 (5 alert lifecycle +
5 broadcasts) — ALL writes. Zero-caller functions: 15 — ALL write/machine/
webhook/cron engines. There is no read-only work left that does not either
(a) duplicate a closed workstream or (b) require new backend actions.

## 9. Security Boundary Review

No candidate under consideration weakens roles, RLS or grants. The alert
lifecycle wrappers already enforce `requireRole(["hospital_admin",
"global_admin"])` + per-row tenant load; broadcasts are admin-only by the
existing gate. A mutation UI would inherit (not modify) these boundaries.
P3-01 (500-instead-of-403 on authorization failure) was remediated and its
fail-closed refusal is re-proven on every gated run by the
`assertDenied` loud-500-defect discipline in the HTTP harnesses — but only
for READ paths; the write paths' app-level denial would need the same HTTP
proof in a future spec. Production privilege state remains UNPROVEN
(local-only census; never to be converted to production certification).

## 10. Tenant Isolation Review

Unchanged and currently proven: header-only tenancy (`X-Hospital-ID`),
server-resolved `p_hospital_id`, fail-closed `HOSPITAL_ACCESS_DENIED`
both directions (G-11 suite re-demonstrated this on the current HEAD, 403
with `data === undefined`). No candidate requires cross-tenant
aggregation; portfolio/benchmarks remain the only cross-tenant actions and
are global_admin-gated by `GLOBAL_ACTIONS`.

## 11. Financial Boundary Review

No financial mutation is proposed or implied by any remaining candidate.
C2 (alerts/broadcasts) touches zero money paths. The financial engines
(create-payment-order, verify-payment, process-refund, settlement-engine)
remain deliberately UI-unreachable pending an authoritative financial
specification; the business rule (SETURA collects only the booking/platform
fee) is untouched.

## 12. Production Boundary Review

Production: UNTOUCHED (no deploy, no secrets, no schema, no infra).
`origin/main` remains at `90100aa`; local `main` is ahead 2 and will stay
unpushed until the owner authorizes. Staging: G-11 NOT YET PROVEN by
design; nothing in this investigation deploys or re-deploys anything.
Phase 7 readiness items (deploy pipeline, Vault, Sentry, backup/DR, load
test, production privilege re-measurement, pilot onboarding) are all
owner/environment actions, not repository code tasks.

## 13. Candidate Workstreams (post-G-11)

- **C2 — Alert Lifecycle Mutation Surface** (`acknowledge`/`assign`/
  `resolve`/`escalate`/`suppress` UI over the existing `alert-center`
  actions).
- **C2b — Broadcast Composer Surface** (5 `broadcast_*` actions — newly
  enumerated at action level by this census; previously only implicit).
- **C3 — Financial Mutation Workstream** (refund/settlement/payment verify
  admin workflows).
- **C4 — Doctor Schedule / Leave Management** (write RPCs + Edge action do
  not exist).
- **C5 — Notification/Integration Management Surface.**
- **C6 — Production Readiness / Autonomy** (scheduler decision, worker
  activation, deploy, secrets, backup/DR).
- **C7 — Reachability-gap continuation workstream** — tested for existence
  by §6 census; result: EMPTY.

## 14. Candidate Classification

| ID | Classification |
| --- | --- |
| C2 | **PRODUCT GAP (write)** — backend-complete; requires an authoritative mutation specification before implementation |
| C2b | **PRODUCT GAP (write)** — same class as C2; same prerequisite |
| C3 | **FINANCIAL WORKSTREAM · NOT READY** — requires separate design/security investigation and Phase-3 rulings |
| C4 | **BACKEND/SECURITY GAP · NOT READY — REQUIRES NEW BACKEND** (any UI now would bypass auth→validation→audit→invariant layer) |
| C5 | **NOT ACTUALLY A GAP** — delivery status already surfaced; no unreachable-and-intended admin primitive |
| C6 | **INFRASTRUCTURE / OWNER BLOCKER** — cannot be certified from this repository alone |
| C7 | **ALREADY CLOSED** — the frontend-reachability workstream series (G-02…G-11) is exhausted with evidence in §6 |

## 15. Evidence for Each Candidate

- C2/C2b: action constants `supabase/functions/alert-center/index.ts:43-51`
  and `command-center/index.ts:52-63` vs wrapper absence in
  `apps/web/src/api/alertCenter.ts` (list/analytics only) and
  `commandCenter.ts:21` ("broadcast_* deliberately NOT wrapped"); RPC
  behavior proven in `enterprise_command_center.test.ts:816+`
  (idempotent ack, dedupe, escalate-once, suppression windows).
- C3: post-G10 investigation §11-C3; engines list in §6 table; roadmap
  Phase 3 + NPD rulings.
- C4: post-G10 §11-C4 (read RPCs exist in migration 31; no leave-write RPC
  or Edge action — re-verified this session by the §6 census: no such
  action constant exists anywhere).
- C5: post-G10 §11-C5; `/reception/notifications` route present in current
  `App.tsx`.
- C6: AGENTS.md §13 current-state register (P0-01/02/03, F16-01/04) and
  roadmap §4/§7; no repository-side change can close them.
- C7: the §6 per-action census itself.

## 16. Roadmap Alignment

`SETURA_FINAL_MASTER_ROADMAP.md` §6/§11: the serial spine ends at Phase 7
(production readiness → pilot). Phase 6 (staff frontend) exit criterion is
"the full journey executable **through the console**" — the read surfaces
are done; the journey-through-console still lacks the admin MUTATION verbs
(alert handling, broadcasts), which is precisely C2/C2b territory — but
master-roadmap Phase 7 items (deploy, scheduler ruling NPD-05, worker
activation, production privilege verification) are owner decisions that
gate everything downstream. Roadmap ordering does NOT authorize starting
C2/C2b/C3/C4/C6 in code without their specifications/rulings.

## 17. Dependencies

C2/C2b depend only on closed workstreams (G-10 surface for alerts, G-03
for broadcasts) plus a NEW authoritative mutation spec covering:
idempotency keys (mutations MUST use the established system), concurrency
(two admins acting on one alert), audit old/new state, notification
side-effects, and real-HTTP write-path tests. C3 depends on NPD-01/02/03
rulings. C4 depends on new backend design. C6 depends on owner
infrastructure and explicit authorization for scheduler/worker activation.

## 18. Stop Conditions (evaluated per §8 of the tasking)

Any attempt to implement C2b today would hit no backend stop condition but
would violate the mutation-authorization rule (no authoritative spec).
C4 would require new SQL/RPC/Edge actions → **BACKEND CHANGE REQUIRED →
STOP**. C3 → financial mutation model → **STOP**. C6 → production
infrastructure/credentials → **STOP**. None of the stop conditions fired
for the *investigation* itself; several block *implementation* — hence
INVESTIGATION ONLY.

## 19. Recommended Next Workstream

**No workstream is currently READY FOR IMPLEMENTATION.** The next
legitimate step is a product/owner decision with two evidenced options:

1. **Commission the C2 (+optionally C2b) Alert Lifecycle Mutation
   Specification** — the only remaining candidates whose backends are
   already implemented, integration-tested and privilege-hardened; this
   continues the console's "hospital can actually operate SETURA" goal
   (roadmap Phase 6 exit criterion). Until that spec exists, C2 is NOT
   authorized.
2. **Open Phase 7 production readiness** (scheduler ruling NPD-05,
   push/deploy authorization, staging project for the G-10/G-11 unproven
   surfaces, production privilege re-measurement) — all owner-gated.

If a spec-writer must produce exactly one next implementable workstream
after the owner rules, C2 is the natural candidate; this investigation
deliberately does not write that spec or pre-commit its boundary.

## 20. Exact Implementation Boundary

Deferred — no candidate is authorized. When/if C2 is commissioned, the
boundary must be authored as an explicit spec (files, actions, mutation
safety requirements from AGENTS.md §8, verification matrix) BEFORE any
code change; that spec, not this investigation, owns the boundary
definition.

## 21. Required Verification Plan (for a future authorized workstream)

Baseline for any future mutation surface (superset of §12 of the tasking):
real-HTTP authorized success incl. audit row created; role denial 403;
missing tenant 422; anonymous; cross-tenant with zero mutation side-effect;
idempotent replay (same key → single state transition, single audit event);
concurrent competing transitions (ack/resolve races); terminal-state
preservation; tenant isolation of alert rows; PII in audit payloads; full
frontend suite (≥371); typecheck/build/migrations/secret gates; Edge
Runtime serving verified before any HTTP certification (F16-01 discipline).

## 22. Certification Boundary

This investigation ends at: **INVESTIGATION ONLY.** No claim of
implementation, verification or readiness is made for any candidate. G-11
stays exactly where its report certifies it (local integration verified;
staging NOT YET PROVEN; production UNTOUCHED).

## 23. Files Expected to Change

**NONE in this phase.** The report file itself is the only artifact, per
tasking §14/§15 (untracked until the owner decides; no commit created).

## 24. Files Explicitly Forbidden to Change (this and any future workstream without explicit authorization)

- All of `supabase/migrations/` (applied history).
- `supabase/functions/executive-analytics/index.ts`,
  `alert-center/index.ts`, `command-center/index.ts`,
  `enterprise-reports/index.ts`,
  `financial-command-center/index.ts` and `_shared/` primitives —
  unless a future authorized spec explicitly requires it.
- The G-11 deliverables (`api/operations.ts`, `routes/AdminOperations.tsx`
  and their tests) — closed workstream.
- `GRAPH_REPORT.md` / `graphify-out/` generated artifacts.

## 25. Risk Register (this investigation's outputs)

| ID | Risk | Class |
| --- | --- | --- |
| R1 | Pressure to "finish the frontend" by bolting UI onto write actions without a mutation spec — would breach AGENTS.md §8 (idempotency/audit/state-machine) | Governance |
| R2 | Alert/broadcast WRITE paths have never been driven over real HTTP — a latent 500-class defect (P3-01 analogue) could exist only on those branches; unproven either way | Verification debt |
| R3 | `queue-next-patient` missing from the post-G10 inventory table — closed-report erratum recorded here; current census restores it | Documentation |
| R4 | Local-ahead-2 commits unpushed; a machine event before owner push discipline could lose G-10/G-11 history (repo has no remote backup of these commits) | Infrastructure |
| R5 | Converting this report's "C2 is natural next candidate" into unauthorized implementation | Governance |

## 26. Final Decision

The post-G-11 state is **read-surface-complete**: no further frontend
reachability gap exists, and every remaining gap is either an unauthorized
mutation surface, a financial/backend design task, or an owner
infrastructure blocker. Correct next state per tasking §9:

```text
INVESTIGATION ONLY
NO SOURCE CHANGES
NO DEPLOYMENT
PRODUCTION UNTOUCHED
```

Owner action requested: choose between commissioning the C2 alert-lifecycle
mutation specification and opening Phase 7 production readiness (NPD-05 +
deploy authorization).
