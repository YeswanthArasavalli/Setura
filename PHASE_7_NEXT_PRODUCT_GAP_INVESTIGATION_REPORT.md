# SETURA — PHASE 7: NEXT PRODUCT GAP INVESTIGATION
## Fresh Read-Only Discovery After G-03 PROVEN STAGING

**Phase:** 7 — Next Product Gap Investigation (DISCOVERY ONLY)
**Date:** 2026-09-29
**Status:** COMPLETE — no source, SQL, migration, RLS, Edge Function, test,
deployment, staging-data, commit or push performed. Read-only git inspection,
source/migration/test census and current-report review only.
**Supersedes:** the previous content of this file (the post-G-02 investigation
at baseline `0ec8586`), whose selected candidate — Hospital Admin Command
Centre (G-03) — has since been implemented at `0cb2800`
("Add Admin Command Centre (G-03) frontend & reports") and closed as
**PROVEN STAGING** (see
`PHASE_7_G03_CORS_REMEDIATION_AND_CONTROLLED_STAGING_REVALIDATION_REPORT.md`).
That report's baseline and selection are STALE / RESOLVED; this is a fresh
investigation against `0cb2800`.

---

## 1. Executive Summary

After G-03, the hospital-admin persona has a live, staging-proven, read-only
Command Centre. The largest remaining *evidence-supported, bounded* product gap
is that **every audit, compliance and executive-reporting capability the backend
already implements and integration-tests over real HTTP is still completely
unreachable from the product UI.** `enterprise-reports` (an audited,
role-gated, `service_role`-mediated Edge Function) already exposes
`audit_search`, four integrity/compliance checks and eight report types;
`financial-command-center` already wraps the money read RPCs;
`executive-analytics` already serves global-admin portfolio and hospital-admin
daily analytics. None has a frontend surface.

The recommended next gap is a **read-only Hospital Admin Audit & Compliance
viewer** built on the already-proven `enterprise-reports` Edge Function. This
**re-elevates the previous G-05 "audit viewer"** candidate but **reclassifies it
from BACKEND-REQUIRED to FRONTEND-ONLY + one targeted redeployment**, because
current source disproves the earlier premise (it assumed no Edge Function
exposes audit to staff — `enterprise-reports.audit_search` does, with
`resolveAuth` + `requireRole(["hospital_admin","global_admin"])` + server-side
hospital id + access auditing). Implementation is **not** started here.

---

## 2. Baseline (verified)

| Check | Verified value |
| --- | --- |
| Branch | `main` |
| HEAD | `0cb2800d27bd5b0b920006530ca82f22300b0402` |
| origin/main | `0cb2800d27bd5b0b920006530ca82f22300b0402` (== HEAD) |
| HEAD subject | `Add Admin Command Centre (G-03) frontend & reports` |
| `git status --short` | 1 untracked file only (this report); no tracked modifications |
| Staging Supabase | `setura-staging` / ref `gzcqasntcbqqmgsoikms` / `ap-south-1` |
| Staging frontend | `https://setura-delta.vercel.app` |
| G-03 status | PROVEN STAGING (per the CORS remediation report) |

The working tree **is** a functional Git repository (git status/branch/log
all succeed), consistent with the last two investigation reports; the older
AGENTS.md §13 "not a Git repo" note no longer holds and was not relied upon.
No commit, push, amend or rebase was performed. **GIT: UNCHANGED.**

---

## 3. G-03 Closure Confirmation

```text
G-03 remains PROVEN STAGING.
No reopening required.
```

G-03 (Command Centre) is treated as CLOSED. It was not re-investigated, not
modified, and its five read actions were not re-designed.

---

## 4. Current Frontend Inventory (rebuilt from `App.tsx` + `api/`)

| Route | Roles (`RequireRole`) | Screen |
| --- | --- | --- |
| `/login` | public | Login |
| `/` (index, in shell) | reception∪doctor∪admin roles | Landing (role redirect) |
| `/reception` | receptionist, hospital_admin | ReceptionDashboard |
| `/reception/book` | receptionist, hospital_admin | BookAppointment |
| `/reception/walk-in` | receptionist, hospital_admin | WalkIn |
| `/reception/patients` | receptionist, hospital_admin | Patients |
| `/reception/notifications` | receptionist, hospital_admin | Notifications |
| `/queue` | receptionist, hospital_admin | QueueBoard |
| `/doctor` | doctor, hospital_admin | DoctorConsole |
| `/admin` | hospital_admin, global_admin | AdminCommandCentre (G-03) |
| `/bookings/:bookingId` | shell roles | BookingDetail |

- Frontend calls **six** Edge Functions: `create-booking`, `queue-control`,
  `doctor-operations`, `cancel-booking`, `update-booking-status`, and (G-03)
  `command-center`. A grep of `apps/web/src` for `enterprise-reports`,
  `financial-command-center`, `executive-analytics`, `alert-center` returns
  **0 call sites** (only incidental "audit"/"not reported" strings).
- Zero direct client table writes; reads go through PostgREST SELECT under RLS
  (`api/reads.ts`); mutations are all Edge-Function mediated.
- `global_admin` now has a dedicated `/admin` landing, but for a **no-tenant**
  account the Command Centre renders "No hospital tenant is attached to your
  account." (G-03 report TEST D) — so global-admin portfolio/system visibility
  is still effectively absent.

---

## 5. Current Backend Inventory (26 Edge Functions; role/auth posture)

Frontend-consumed (6): `create-booking`, `queue-control`, `doctor-operations`,
`cancel-booking`, `update-booking-status`, `command-center`.

Admin-grade **read** functions — implemented, role-gated, HTTP-integration
tested, **never UI-consumed**:

| Function | Auth | Read actions | HTTP integration proof |
| --- | --- | --- | --- |
| `enterprise-reports` | `resolveAuth`+`requireRole([hospital_admin,global_admin])`, `getServiceClient` | `generate` (8 types), `audit_search`, `audit_integrity`, `settlement_integrity`, `queue_integrity`, `doctor_ops_integrity`, `integration_matrix` | YES — `enterprise_command_center.test.ts:1477-1524` (json/csv/pdf + validation + audit) |
| `executive-analytics` | role-gated; portfolio=global_admin, daily=hospital_admin | `portfolio`, `daily_operations`, … | YES — `:1358-1403` (role + scope denials) |
| `alert-center` | role-gated, audited | list / acknowledge | YES — `:1417-1473` (ack audited, cross-tenant 403) |
| `financial-command-center` | `resolveAuth`+`requireRole([hospital_admin,global_admin])`, `getServiceClient` | `overview`, `forecast`, `reconciliation` | RPC-level only (`:727-780`); **function HTTP path not integration-tested** |

Backend/system-only (unchanged): `settlement-engine`, `carry-forward-tokens`,
`compute-sla`, `monitoring-health-check`, `refresh-rollups`,
`run-background-worker`, `run-cron-minute`, `run-cron-nightly`,
`send-reminders`, `send-whatsapp-message`, `process-whatsapp-webhook`,
`create-payment-order`, `verify-payment`, `process-refund`,
`reschedule-booking`, `queue-next-patient`.

Key SQL objects: `audit_logs`/`search_audit_logs`/`verify_*_integrity`
(10/36/47), financial read RPCs `get_financial_command_center` /
`get_revenue_forecast` / `get_reconciliation_summary` (service_role-only per
48), doctor schedule/leave tables (03/31).

---

## 6. User Journey Coverage

- **Patient/Reception/Doctor/Booking/Queue/Consultation/Notes/Cancel/Status-
  closure/Notifications/Payment-read** — IMPLEMENTED + REACHABLE (closed prior
  phases).
- **Hospital Admin** — Command Centre (operational/SLA/health/timeline/
  predictive) REACHABLE (G-03). **Audit trail ❌ · compliance/integrity checks
  ❌ · executive reports ❌ · finance/collections read ❌ · fee config ❌** — all
  either unreachable or absent in UI.
- **Doctor** — own **schedule/leave visibility ❌** (tables RLS-readable, no UI).
- **Global Admin** — Command Centre no-tenant state only; **portfolio /
  cross-tenant analytics has no UI** despite `executive-analytics` being
  proven.

---

## 7. Reachability Matrix

| Capability | Backend | UI | Status |
| --- | --- | --- | --- |
| Command Centre reads | ✅ proven+deployed | ✅ | IMPLEMENTED + REACHABLE |
| Booking/queue/doctor/cancel/status/notes | ✅ | ✅ | IMPLEMENTED + REACHABLE |
| **Audit viewer / compliance checks** | ✅ `enterprise-reports` (HTTP-proven) | ❌ | **IMPLEMENTED + UNREACHABLE** |
| **Executive reports (op/SLA/doctor)** | ✅ same function | ❌ | IMPLEMENTED + UNREACHABLE |
| Global-admin portfolio analytics | ✅ `executive-analytics` | ❌ | IMPLEMENTED + UNREACHABLE |
| Finance/collections read | ✅ fn, RPC-level test only | ❌ | PARTIAL (evidence weaker) |
| Doctor schedule/leave **read** | ✅ RLS-readable tables | ❌ | BACKEND-INCOMPLETE UI (low standalone value) |
| Doctor schedule/leave **write** | ⚠️ unaudited `FOR ALL` | ❌ | BACKEND-REQUIRED + security-sensitive |
| Reschedule | ⚠️ broken | ❌ | BLOCKED (backend defect) |
| Fee configuration admin | ✅ | ❌ | financial mutation, deferred |

---

## 8. Product Gap Matrix (classification per §11 of brief)

| Gap | Class |
| --- | --- |
| Audit & Compliance viewer | **B — Frontend reachability** (backend proven) + E (one redeploy) |
| Executive reports | B + E |
| Global-admin portfolio dashboard | B + E |
| Finance/collections read | B + E + F (fn HTTP path untested), financially sensitive to render |
| Doctor schedule/leave read | B (low value) / write = C + D |
| Reschedule | C — BACKEND DEFECT |
| Fee admin | C + financial mutation |

---

## 9. Previously Considered Gaps — Re-evaluation (CURRENT evidence)

| Prior cand. | Prior verdict | Current re-evaluation |
| --- | --- | --- |
| G-05 Audit viewer | "BACKEND-REQUIRED — service_role RPCs, no fn exposes audit" | **SUPERSEDED.** `enterprise-reports.audit_search` (`index.ts:228-275`) already exposes audit to `hospital_admin`/`global_admin` via `getServiceClient()` with server-side hospital id and audits the access. Now **FRONTEND-ONLY + targeted redeploy**. Remains the strongest candidate and is SELECTED. |
| Finance read (G-06) | "service_role-only, broad, money-sensitive" | fn `financial-command-center` wraps the RPCs and is role-gated, but its HTTP path is **not** integration-tested and it is a multi-view money surface. Still DEFERRED (breadth + evidence + financial). |
| Doctor schedule/leave (G-04) | read=frontend-only low value; write=unaudited | Unchanged. Read has low standalone value; write needs an audited Edge Function. DEFERRED. |
| Reschedule (G-07) | BACKEND DEFECT — columns absent | **STILL VALID.** `grep rescheduled_at|rescheduled_by supabase/migrations` = **0 matches**. Not ready. ELIMINATED. |
| Fee admin (G-08) | financial mutation | Unchanged. DEFERRED. |
| Command Centre (G-03) | SELECTED | IMPLEMENTED + PROVEN STAGING. CLOSED. |

---

## 10. Nine Stale Edge Functions (deployment drift only — NOT a product gap by itself)

Per the G-03 report §24.2, these staging functions still carry the pre-`79b74f7`
CORS artifact: `cancel-booking`, `update-booking-status`, `queue-next-patient`,
`enterprise-reports`, `financial-command-center`, `executive-analytics`,
`alert-center`, `send-whatsapp-message`, `run-background-worker`.

- Do NOT mass-redeploy. They are documented as deployment drift only.
- **Relevance to the selected candidate:** `enterprise-reports` is one of the
  nine. Its browser path would hit the same preflight `ERR_FAILED` G-03 saw
  until redeployed from current source. Therefore:
  `candidate requires targeted redeployment` (of `enterprise-reports` **only**),
  to be performed **only** in the implementation phase under explicit
  authorization — NOT during this investigation.
- The other eight are untouched and not implied by this recommendation.

---

## 11. Security / Authorization Analysis

For the selected candidate (`enterprise-reports` audit + compliance reads):
- Role gate is server-side `requireRole(["hospital_admin","global_admin"])` —
  receptionist/doctor denied at the edge (mirrors G-03's proven posture).
- Tenant is taken ONLY from the session-derived `X-Hospital-ID` header, then
  verified server-side; `search_audit_logs` is called with the server-supplied
  `p_hospital_id` through `getServiceClient()`, never a client body field. The
  prior-report O-C hazard (caller-supplied hospital id) is **not** reachable
  from the browser because the RPC stays `service_role`-only behind the fn.
- Audit access is itself audited (`compliance_check`, `index.ts:246-265`) —
  accountability preserved.
- No new RLS/SECURITY DEFINER/grant boundary is introduced. No service-role key
  ever reaches the browser. Cross-tenant calls must be proven 403 and missing
  header 422 (same gates as G-03).

---

## 12. Financial Risk Analysis

- **Selected candidate: NONE for mutations.** Audit search + integrity/compliance
  checks are read-only metadata; `settlement_integrity` returns a
  reconciliation **verdict**, not a money figure and performs no write.
- Out of scope for this phase and NOT recommended: the `financial` and
  `settlement` **report types** and the finance read dashboard — those render
  money figures and belong to a separately-gated, evidence-stronger phase
  (business invariant reminder: SETURA collects only the booking/platform fee;
  the hospital collects the consultation fee directly).

---

## 13. Candidate Comparison (factual descriptors — no scores/rankings)

| Candidate | User value | Backend readiness | Frontend | Security | Financial | Backend work | Frontend work | Runtime proof | Dependency risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Audit & Compliance viewer | High | Ready (`enterprise-reports`, HTTP-proven) | Missing | Ready (role+tenant audited) | Read-only / none | none (redeploy only) | one route + read wrapper | Staging, low | 1 targeted redeploy |
| Executive operational reports | High | Ready (same fn, HTTP-proven) | Missing | Ready | Read-only (excl. money report types) | none (redeploy only) | one route | Staging, low | same single redeploy |
| Global-admin portfolio dashboard | Medium | Ready (`executive-analytics`, HTTP-proven) | Missing | Ready (global_admin) | Read-only | none (redeploy) | one route | Staging, medium (needs tenant-less account) | 1 redeploy + account context |
| Finance/collections read | Medium | Partial (fn RPC-level test only) | Missing | Ready | **sensitive (money display)** | 1 fn HTTP test | one route | Staging, harder | 1 redeploy + test gap |
| Doctor schedule/leave read | Low | Ready (RLS tables) | Missing | Ready (read) | none | none | one route | Staging, low | none |
| Doctor schedule/leave write | Medium | Missing (unaudited) | Missing | **Gap (no audit)** | none | new audited fn | one route | Staging, high | security-sensitive |
| Reschedule | Medium | **Defect (columns absent)** | Missing | — | fee-carry | additive migration + fn fix | one route | blocked | NOT ready |
| Fee configuration admin | Medium | Ready | Missing | financial | **MUTATION** | config/policy | one route | policy-gated | NOT selected |

---

## 14. Recommended Next Gap

```text
Candidate:  Hospital Admin Audit & Compliance Viewer
            (read-only surface over the existing `enterprise-reports` Edge
            Function: `audit_search` + the integrity/compliance checks)

Why it exists:  Auditability is a core SETURA non-negotiable, yet no UI exposes
                the audit trail or compliance/integrity checks. The backend
                already implements and HTTP-integration-tests them.

Who needs it:   hospital_admin (and global_admin) — for operational
                accountability, incident review and compliance.

What already exists:  `enterprise-reports` (role-gated, service-role mediated,
                access-audited) + `search_audit_logs` + `verify_*_integrity`
                RPCs + real-HTTP integration proof + shared CORS fix in source.

What is missing:  a frontend route + a read API wrapper (mirroring
                api/commandCenter.ts), plus one targeted staging redeploy of
                `enterprise-reports` (it is among the stale nine).

Why this is the next justified capability:  highest-value gap whose backend is
                already PROVEN (unlike finance's RPC-only evidence, reschedule's
                defect, and schedule-write's missing audit) and which reuses an
                already-proven G-03 template (frontend over an authorized Edge
                Function read path).

Frontend-only or backend-required:  FRONTEND-ONLY + one targeted redeployment
                (no new SQL / RLS / RPC / SECURITY DEFINER / fn-code change).

Expected scope:  one `/admin/audit` (or Command Centre sub-tab) route guarded
                to [hospital_admin, global_admin]; a read wrapper calling
                `enterprise-reports` with action=audit_search (+ integrity
                checks); render results read-only; no report-generation of
                financial/settlement types in this slice.

Security implications:  relies on existing server-side role+tenant enforcement;
                adds no new trust boundary; cross-tenant 403 / missing-header
                422 must remain proven.

Financial implications:  NONE (read-only audit metadata; money report types
                explicitly excluded).

Runtime proof required:  staging browser walkthrough as hospital_admin —
                audit_search returns rows, receptionist/doctor denied,
                cross-tenant 403, no mutation, console/network clean; plus the
                existing enterprise-reports HTTP integration test kept green.

Dependencies:  targeted redeploy of `enterprise-reports` to staging under
                explicit implementation-phase authorization.
```

---

## 15. Exact Proposed Scope (for the NEXT authorized phase)

MAY touch:
- One new admin route in `App.tsx` + nav entry in `AppShell.tsx` + a page under
  `apps/web/src/routes/` + a read wrapper under `apps/web/src/api/` + types in
  `types/api.ts` + unit tests.
- One targeted `supabase functions deploy enterprise-reports` to **staging**
  (minimum to close the browser path), mirroring the proven G-03 remediation.

MUST NOT touch:
- Any migration, SQL, RLS, grants, SECURITY DEFINER function, or Edge Function
  **source** (source already correct).
- Any of the other eight stale functions; no mass redeploy.
- Financial/settlement report generation, fee config, reschedule, schedule/leave
  writes, notifications/WhatsApp, worker/scheduler.
- Production. No commit/push without explicit authorization.

---

## 16. Acceptance Criteria

1. hospital_admin lands on the audit route and sees real audit rows for their
   tenant via `audit_search`.
2. Receptionist and doctor have no route entry and are redirected; they issue
   zero `enterprise-reports` requests.
3. Cross-tenant header → 403; missing header → 422 (proven in staging).
4. Integrity/compliance checks render read-only verdicts; no mutation issued.
5. Preflight returns the current shared CORS headers (`apikey`, `X-Client-Info`,
   `Vary: Origin`) post-redeploy; all POST reads return 200.
6. Zero errors / warnings in console; zero unexpected network mutations.
7. Existing `enterprise_command_center.test.ts` HTTP suite stays green; typecheck
   and build pass.

---

## 17. Definition of Done

```text
Implementation            + expected behavior   + failure behavior
+ unit tests (wrapper/route)                    + integration tests (reuse HTTP suite)
+ Browser/E2E walkthrough on staging            + runtime staging proof
+ tenant isolation        + role isolation       + console/network cleanliness
+ evidence report
```
BLOCKED ≠ PASS. Staging proof is **NOT** production readiness; no production
claim is made.

---

## 18. STOP CONDITIONS

Implementation must NOT begin if:
- The `enterprise-reports` staging redeploy is not explicitly authorized (the
  browser path stays BLOCKED, not worked around).
- Any audit/compliance read is found to require a new RLS/SECURITY DEFINER
  boundary (would reclassify it as backend/security work → separate phase).
- A financial/settlement report type is pulled into scope (financial sensitivity
  demands its own gated phase).
- Staging or production data mutation would be needed to demonstrate the flow.

---

## 19. Evidence Standard Notes

Conclusions rest on: current source (`enterprise-reports/index.ts`,
`financial-command-center/index.ts`, `App.tsx`, `api/*.ts`,
`_shared/cors.ts` posture via G-03 report), current integration tests
(`enterprise_command_center.test.ts` HTTP sections), current migrations
(reschedule-column census), and current git state. Where the prior G-05 audit
conclusion ("backend-required") conflicts with current source, the conflict is
reported and resolved toward source: the Edge Function already exists. Local
test results are not claimed as production. No report/finance/analytics UI was
found (grep of `apps/web/src`).

---

## 20. FINAL DECISION

```text
CURRENT BASELINE:
0cb2800d27bd5b0b920006530ca82f22300b0402  (HEAD == origin/main; working tree clean
apart from this report; staging setura-staging / gzcqasntcbqqmgsoikms;
frontend https://setura-delta.vercel.app)

G-03:
PROVEN STAGING — CLOSED

NEXT PRODUCT GAP:
Hospital Admin Audit & Compliance Viewer (read-only surface over the existing
`enterprise-reports` Edge Function: audit_search + integrity/compliance checks)

CLASSIFICATION:
Frontend reachability gap (backend proven) + one targeted deployment drift fix

IMPLEMENTATION SCOPE:
One admin route + read API wrapper (mirror commandCenter.ts) + a single targeted
`enterprise-reports` staging redeploy. No SQL/RLS/RPC/SECURITY DEFINER/fn-source
change. Financial/settlement report types excluded.

BACKEND CHANGES REQUIRED:
No — `enterprise-reports` already exposes role-gated, service-role-mediated,
access-audited audit + compliance reads; only its STAGING ARTIFACT needs a
targeted redeploy (it is one of the stale nine).

DATABASE/RLS CHANGES REQUIRED:
No — existing role gate + server-side tenant scoping + service_role-only audit
RPCs remain unchanged.

FINANCIAL IMPACT:
None (read-only audit metadata; money report types explicitly out of scope).

STAGING PROOF REQUIRED:
- hospital_admin renders real audit rows; receptionist/doctor denied (0 requests)
- cross-tenant 403 / missing-header 422
- OPTIONS preflight returns current CORS headers; reads return 200
- integrity/compliance checks render read-only; 0 mutations
- console/network clean; existing enterprise-reports HTTP suite green; build+typecheck pass

PRODUCTION:
NOT TOUCHED

INVESTIGATION STATUS:
COMPLETE — STOP
```

**This was discovery only. No implementation was started.**
