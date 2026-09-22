# PHASE 7 — PRODUCT COMPLETION AND CONTROLLED VALIDATION REPORT

**Scope:** Highest-value D5/D13-independent product-completion and controlled
validation against the existing local/staging environments.
**Boundary:** Production infrastructure was **NOT** entered (see §20).
**Vocabulary:** `PROVEN` (with LOCAL/STAGING qualifier) · `IMPLEMENTED` ·
`PARTIALLY PROVEN` · `BLOCKED` · `UNPROVEN` · `DEFERRED BY OWNER` ·
`NOT IMPLEMENTED` · `STALE / RESOLVED`.
**Evidence discipline:** `LOCAL/STAGING PROOF ≠ PRODUCTION PROOF` throughout.

---

## 1. Executive summary

Part 5A is closed (`D5` and `D13` = `DEFERRED BY OWNER`). This phase did not
re-open production provisioning. It performed real product work and controlled
validation against the live local Supabase stack:

- **Fixed a real reception defect at its root.** The receptionist doctor picker
  and the queue board could not show a doctor's *name* because the migration-61
  `profiles` SELECT policy inlined a `user_roles` self-join that the self-only
  `user_roles_read` policy cannot satisfy for a non-admin reader. The predicate
  is now evaluated by a narrow `SECURITY DEFINER` helper (the established
  `user_has_hospital_access` pattern). **`PROVEN LOCAL`** — 9/9 dedicated RLS
  integration tests pass with real roles.
- **Fixed the transient "No doctors available" false state** that could let a
  walk-in be created without a doctor, and de-duplicated the "Cardiology ·
  Cardiology" label. **`PROVEN` (unit + build).**
- **Fixed a real CORS/security defect:** `buildCorsHeaders` now fails closed
  (no `Access-Control-Allow-Origin` echoed for a disallowed origin, `Vary:
  Origin` added, credentials only when allowed), and `env.ts` no longer carries
  an invented production domain that contradicted the D13 deferral. **`PROVEN
  LOCAL`** (unit).
- **Validated the whole product surface against the real stack:** full
  integration suite **235 passed / 0 failed**, E1 hospital core journey + D16
  financial policy **29 passed / 0 failed**, Deno unit **97 passed**, frontend
  vitest **28 passed**, typecheck clean, production build clean.

No documentation-only churn was undertaken. The stack's scheduler and worker
(P0-01/P0-02/D6) were treated as already resolved, as directed.

---

## 2. Authoritative current state

| Fact | Status |
| --- | --- |
| Working tree is a Git repo (`main`, HEAD `0bb2d90`) | Confirmed this session; AGENTS §13 "not a git repo" is **STALE / RESOLVED** |
| Migrations applied locally | 01–61 (61 files); `validate:migrations` = 0 errors, 4 pre-existing `[duplicate-objects]` warnings (baseline) |
| Migration manifest | 61 migrations / 61 lines, 0 integrity issues |
| Edge Runtime | Was `Exited (255)`; started for this validation, now `Up` |
| Production Supabase project | **NOT CREATED** |
| Production migrations / functions / secrets / users / data | **NOT APPLIED / NOT DEPLOYED / NOT PROVISIONED / NOT CREATED** |
| Razorpay / Meta / SMTP production, live commercial ops, pilot | **NOT authorized / NOT configured / NOT enabled / NOT READY** |
| `https://setura-delta.vercel.app` | Targets **STAGING**; must not be represented as production |

---

## 3. D5 / D13 boundaries (unchanged, not weakened)

- **D5 = `DEFERRED BY OWNER`.** Requirement preserved verbatim: RPO ≤ 15
  minutes, RTO ≤ 4 hours, retention ≥ 30 days. No external backup system was
  built and none was invented; Supabase Enterprise was not purchased.
- **D13 = `DEFERRED BY OWNER`.** No production domain was invented. This phase
  actively *reinforced* D13 by removing the hardcoded `setura.in` production
  fallback from `env.ts` (an invented domain that contradicted the deferral).
- No production Supabase project was created to satisfy any audit gate.

---

## 4. Product-completion gap register

Every item classified as exactly one state. "PROVEN" below means proven against
the **local** stack unless a staging qualifier is given.

### A. Core hospital journey

| Item | State | Evidence |
| --- | --- | --- |
| Registration → appointment/walk-in → doctor → token → queue → call → consult → notes → completion → billing → notification → history | **PROVEN (LOCAL)** | `hospital_core_journey.test.ts` (E1) green; within the 29-pass subset and 235 full-suite pass |
| Queue runtime / queue operations atomicity | **PROVEN (LOCAL)** | `queue_runtime.test.ts`, `queue_operations.test.ts` green |
| Doctor clinical workflow | **PROVEN (LOCAL)** | `doctor_operations.test.ts` green |

### B. Reception experience

| Item | State | Evidence |
| --- | --- | --- |
| Doctor dropdown shows doctor **name**, not specialty-only | **PROVEN (LOCAL)** — was a real defect, **FIXED** | migration 61 + `staff_doctor_directory.test.ts`; `reads.test.ts` label test |
| Transient "No doctors available" cannot yield an unqueued walk-in | **PROVEN (LOCAL)** — **FIXED** | `BookingForm.test.tsx` loading/error/empty state tests; build clean |
| Registration/search/appointment/walk-in/token/queue visibility/payment/history screens | **IMPLEMENTED** (routes present; exercised via journey tests) | `ReceptionDashboard/Patients/BookAppointment/WalkIn/QueueBoard/BookingDetail.tsx` |

### C. Doctor experience

| Item | State | Evidence |
| --- | --- | --- |
| Today's appointments, queue, call next, consult, notes, diagnosis, completion, next, history | **PROVEN (LOCAL)** | `DoctorConsole.tsx` workflow + `doctor_operations.test.ts` green |

### D. Financial correctness (D16 authoritative)

| Item | State | Evidence |
| --- | --- | --- |
| `booking_fee_inr` = platform fee only; SETURA collects only this via Razorpay | **PROVEN (LOCAL)** | `d16_financial_policy.test.ts` green |
| Revenue recognised only after successful capture; unpaid/WhatsApp ≠ collected revenue | **PROVEN (LOCAL)** | `d16_financial_policy.test.ts`, `booking_fee_refund.test.ts` |
| Refunds ≤ captured; cumulative refunds ≤ collected; partial affects only refunded amount | **PROVEN (LOCAL)** | `refund_sync.test.ts`, `booking_fee_refund.test.ts` |
| Settlement / record-payment ledger correctness | **PROVEN (LOCAL)** | `settlement_record_payment.test.ts` |
| Razorpay gateway fee recorded separately; GST treatment | **IMPLEMENTED**; GST = **BLOCKED** pending CA/tax confirmation (owner decision, not code) | — |

No contradiction with D16 was found; the model was **not** redesigned.

### E. Worker / scheduler / background jobs

| Item | State | Evidence |
| --- | --- | --- |
| Enqueue/claim/lease/complete/fail/retry/crash-recovery/dead-letter | **PROVEN (LOCAL)** | `worker_lifecycle`, `worker_lease_persistence`, `worker_job_failure` green |
| P0-01 (`claim_jobs_v2` lease) | **STALE / RESOLVED** (migration 51 sets `lease_expires_at`; crash-reclaim runtime-proven) — not re-opened, per directive |
| Scheduler autonomy (`pg_cron → scheduler_fire_minute → pg_net → run-cron-minute`) | **PROVEN (LOCAL)** — `scheduler_autonomy.test.ts` green; P0-02/D6 not re-opened |
| Stale presence cleanup / reminder jobs | **PROVEN (LOCAL)** within suite | `usage_retention` + reminder paths exercised |
| **Production** authenticated worker wake / secrets | **BLOCKED** — production environment does not exist |

### F. Security / multi-tenancy

| Item | State | Evidence |
| --- | --- | --- |
| RLS tenant isolation, role authorization, doctor/reception/admin boundaries | **PROVEN (LOCAL)** | `security_s1`, `privilege_isolation`, `multi_role_auth` green |
| Migration-61 directory read is SELECT-only and tenant-scoped (cross-hospital/patient/anon → zero rows) | **PROVEN (LOCAL)** | `staff_doctor_directory.test.ts` |
| New `SECURITY DEFINER` routine least-privilege (catalog `proacl`) | **PROVEN (LOCAL)** — `prosecdef=t`, anon `EXECUTE`=f, authenticated `EXECUTE`=t (verified via `has_function_privilege`, not migration text) |
| CORS fail-closed / no invented production origin | **PROVEN (LOCAL)** | `cors.test.ts`, `response.test.ts` |
| Idempotency / unauthorized mutation / cross-tenant write | **PROVEN (LOCAL)** within suite |
| **Production** privilege/RLS state | **UNPROVEN** — no production deployment exists |

### G. Frontend completeness

| Item | State | Evidence |
| --- | --- | --- |
| auth / routing / reception / patients / appointments / walk-ins / queue / doctor console / booking detail | **IMPLEMENTED + PROVEN (unit/build)** | 8 routes; `tsc --noEmit` clean; `vite build` clean; vitest 28 |
| payment state / error / loading / authorization states (reception walk-in path) | **PROVEN (LOCAL unit)** for the loading/error/empty doctor-picker states | `BookingForm.test.tsx` |
| Click-through staging validation of every screen | **PARTIALLY PROVEN** — validated by journey/unit/build, not by an automated browser pass this session |
| Notifications UI | **DEFERRED** (genuinely non-critical; not present as a dedicated route) |

### H. External integrations

| Item | State | Evidence |
| --- | --- | --- |
| WhatsApp conversational + lifecycle (HMAC/dedup/intent/handoff/delivery) app-side contracts | **PROVEN (LOCAL)** with faked provider boundary | `whatsapp_conversational`, `whatsapp_lifecycle` green |
| Razorpay create/verify/refund contracts app-side | **PROVEN (LOCAL)** via financial suite (no live money) |
| Webhook signature verification / retry / idempotency / failure handling | **PROVEN (LOCAL)** |
| **Live** Meta/Razorpay/SMTP provider calls with real credentials | **BLOCKED BY EXTERNAL DEPENDENCY** — no credentials; local Edge Runtime env does not carry `META_APP_SECRET`/`RAZORPAY_KEY_SECRET`/etc. |

### I. Observability

| Item | State | Evidence |
| --- | --- | --- |
| Structured JSON logging, request-scoped context, worker/job + payment + webhook events, error classification, health | **IMPLEMENTED + PARTIALLY PROVEN (LOCAL)** | integration run emitted structured logs (e.g. worker failure/`JWT validation failed` events) proving the logging path executes |
| Centralized metrics/health checks production dashboards | **UNPROVEN / BLOCKED** — production monitoring not entered |

### J. Testing

| Item | State | Evidence |
| --- | --- | --- |
| Unit / integration / journey / financial / security / worker / scheduler suites | **PROVEN (LOCAL)** — current counts in §14 |

---

## 5. Core hospital journey status
**PROVEN (LOCAL).** The end-to-end journey, queue runtime, queue operations and
doctor operations suites pass against the live stack. No journey-breaking gap
was found; the only journey-adjacent defect (reception cannot name the doctor it
is queueing toward) was fixed in §B/§16.

## 6. Reception status
**PROVEN (LOCAL)** for the two known defects (doctor-name visibility, transient
no-doctors state). Reception screens are **IMPLEMENTED** and exercised by the
journey tests; an automated browser click-through of every screen was not part
of this session (see §19 for that as the recommended next validation step).

## 7. Doctor status
**PROVEN (LOCAL).** `DoctorConsole.tsx` covers start → call → consult → note →
complete → recall → waiting list; `doctor_operations.test.ts` passes.

## 8. Financial status (D16)
**PROVEN (LOCAL)** and consistent with the authoritative D16 model. GST tax
treatment remains a **BLOCKED** owner/CA decision, not a code defect.

## 9. Worker / scheduler status
**PROVEN (LOCAL)** for lifecycle, lease persistence, job failure, and scheduler
autonomy. P0-01/P0-02/D6 confirmed not open. Production wake = **BLOCKED**.

## 10. Security / multi-tenancy status
**PROVEN (LOCAL)** for RLS isolation, privilege isolation, and the new
directory policy's least-privilege catalog ACL. Production security posture is
**UNPROVEN** (no production).

## 11. Frontend status
**IMPLEMENTED** and **PROVEN** at unit/typecheck/build level. Notifications UI
**DEFERRED**. Live-staging browser validation is the remaining gap.

## 12. External integration status
App-side contracts **PROVEN (LOCAL)** against faked provider boundaries.
**Live** provider calls **BLOCKED BY EXTERNAL DEPENDENCY** (no credentials).
No credentials were manufactured and no real money was moved.

## 13. Observability status
Structured logging/audit/error classification **IMPLEMENTED** and executing in
the real stack (**PARTIALLY PROVEN**). Production dashboards **NOT
IMPLEMENTED/BLOCKED** (no production).

## 14. Testing / regression results (ACTUAL current counts)

| Gate | Result |
| --- | --- |
| `validate:migrations` | 61 files, **0 errors**, 4 baseline `[duplicate-objects]` warnings |
| `validate:migration-manifest` | 61 / 61, **0 integrity issues** |
| Deno unit (`tests/unit/`) | **97 passed / 0 failed** |
| `deno task check` | exit 0 |
| `deno lint` | 0 problems (94 files) |
| `deno fmt --check` | clean (158 files) |
| Full integration (`tests/integration/`) | **235 passed / 0 failed** |
| E1 journey + D16 financial (focused) | **29 passed / 0 failed** |
| Frontend vitest | **28 passed / 0 failed** (5 files) |
| Frontend `tsc --noEmit` | clean |
| Frontend `vite build` | exit 0 |

## 15. Defects found
1. **Reception doctor-name visibility** — migration 61 (drafted this task) used
   an inlined `user_roles` self-join; `user_roles_read` is self-only, so no
   non-admin reader could resolve the doctor row (receptionist got zero rows).
2. **Transient "No doctors available"** allowed a walk-in submit while the
   doctor list was still loading.
3. **CORS not fail-closed + invented production origin** in `env.ts`
   (`https://setura.in`), which also contradicted the D13 deferral.

## 16. Defects fixed
1. Rewrote `supabase/migrations/61_staff_doctor_directory_read.sql`: predicate
   now `public.user_is_same_hospital_doctor(id)` — a narrow `SECURITY DEFINER`
   `SELECT`-only helper with `row_security = off`, explicit `REVOKE` from
   PUBLIC/anon and `GRANT EXECUTE` to `authenticated` (F16-04 rule); policy is
   `SELECT`-only and tenant-scoped. Re-applied to local DB; catalog ACL and
   isolation verified. (Migration 61 was this session's own unreleased draft —
   never applied to staging/production — so it was corrected in place; its
   `DROP POLICY IF EXISTS` / `CREATE OR REPLACE` guards keep it idempotent, and
   only its `MANIFEST.sha256` hash line was refreshed.)
2. `apps/web/src/components/BookingForm.tsx`: `doctorsState`
   (loading/ready/error) so an empty-list-during-fetch is never shown as "No
   doctors"; select+submit disabled while loading; distinct messages per state;
   `apps/web/src/api/reads.ts` `label` (de-duplicated) and `listDoctorNames`.
3. `supabase/functions/_shared/cors.ts` fail-closed with `Vary: Origin`;
   `supabase/functions/_shared/env.ts` production path warns and yields an
   empty allow-list instead of a fabricated domain. `QueueBoard.tsx` now labels
   sessions with the doctor's name.

Regression added: `tests/integration/staff_doctor_directory.test.ts` (9),
`tests/unit/cors.test.ts` (6), `apps/web/src/api/reads.test.ts` (5),
`apps/web/src/components/BookingForm.test.tsx` (6); `tests/unit/response.test.ts`
updated for fail-closed CORS. `tests/integration/d16_financial_policy.test.ts`
lint cleanup (removed an unused binding).

## 17. Remaining blockers
- Production wake of worker/scheduler + secrets/config — **BLOCKED**: production
  environment does not exist.
- Live Razorpay / Meta / SMTP integration — **BLOCKED BY EXTERNAL DEPENDENCY**.
- GST tax treatment — **BLOCKED** pending CA/tax owner decision.

## 18. Deferred items
- **D5** backup/PITR — `DEFERRED BY OWNER` (requirement preserved).
- **D13** production domain / infrastructure — `DEFERRED BY OWNER`.
- Notifications UI — `DEFERRED` (non-critical for the core journey).
- Automated browser click-through of every frontend screen against staging.

## 19. Recommended next implementation sequence
1. **Controlled staging walkthrough** (browser) of reception → doctor → finance
   happy paths + the fixed doctor-picker on real staging data; convert the
   current journey proof from LOCAL-only to STAGING where safe and read-only.
2. **Frontend loading/error/authorization states** beyond the walk-in path
   (Patients, QueueBoard, BookingDetail) — the highest-value remaining usability
   completeness, no production dependency.
3. **Observability surfacing** in the existing command-center/alerting
   primitives for worker dead-letter + webhook failures (reuse, do not
   duplicate).
4. Hold D5/D13 and live integrations until real-world demand justifies them.

## 20. Production statement
Production was **NOT** entered. No production Supabase project, migration,
Edge Function, secret, staff/patient record, Razorpay/Meta/SMTP credential,
domain purchase, money movement, or live commercial operation was created or
enabled. All such actions require explicit future authorization. The temporary
Vercel frontend continues to target **STAGING** and is not production.

---

### Concrete next decision (awaiting owner)
Product work is green and the highest-value D5/D13-independent defects found in
this pass are fixed and proven locally. The single most valuable next step that
needs **no** production and no new credentials is the **staging browser
walkthrough** (§19.1) to upgrade reception/doctor/finance proof from LOCAL to
STAGING. I recommend that as the next phase unless you prefer a different
priority from §19.
