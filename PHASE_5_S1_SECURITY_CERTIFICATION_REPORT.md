# PHASE 5 — S1 SECURITY CERTIFICATION REPORT

Execution date: 2026-09-19 (local). Environment: local Supabase stack
(Postgres 17 + Edge Runtime + Auth + Storage + Realtime) via `supabase
start`. Method: **INSPECT → ATTACK → PROVE → REGRESSION → DOCUMENT**.

> **FINAL STATUS: PHASE 5 COMPLETE — WITH BLOCKED EXTERNAL/ENVIRONMENT EVIDENCE**

No P0/P1/P2 security defect was confirmed. Every attack exercised against
the real stack was denied, leaked no data, and produced no unauthorized
state change. Positive machine/webhook paths and all production behavior
remain BLOCKED / UNPROVEN for the environmental reasons in §I and §K.

This is LOCAL RUNTIME evidence only. It is **not** a production-security
certification, and nothing here claims one.

---

## A. Executive result

A dedicated attack suite was added at
[`tests/integration/security_s1.test.ts`](tests/integration/security_s1.test.ts)
(15 tests, all passing). It attacks the security boundary at three layers
that must each hold independently — the Edge authorization layer, the
database RLS layer, and the RPC EXECUTE-privilege layer — and re-reads the
database after every denial (spec §23: an HTTP code alone is never treated
as proof).

Proven locally:

- **Cross-tenant denial with state verification** — a Hospital-A
  receptionist/doctor cannot read, cancel, or status-mutate a Hospital-B
  booking; each denial was followed by a service-role re-read showing the
  victim row unchanged and **no new audit row appended**.
- **Tenant identity is not attacker-controlled** — spoofing
  `X-Hospital-ID`, and desynchronizing body `hospitalId` from the
  validated header, are both refused with no write.
- **Role isolation** at the backend (not UI) — a receptionist cannot
  invoke the doctor-only endpoint; the doctor can (positive control).
- **Authentication / fail-closed** — missing JWT, garbage JWT, and a
  missing tenant header are refused; there is no default-tenant or
  default-privilege fallback.
- **Machine + webhook surfaces fail closed** — non-machine callers cannot
  trigger the cron endpoint; unsigned/mis-signed webhook POSTs are refused
  (never a 2xx acknowledgement).
- **Scheduler/RPC privilege boundary** — `anon`/`authenticated` cannot
  EXECUTE the service-only scheduler RPC; `service_role` retains EXECUTE.

The pre-existing privilege suite
([`privilege_isolation.test.ts`](tests/integration/privilege_isolation.test.ts),
22 tests) and the multi-role authorization suite
([`multi_role_auth.test.ts`](tests/integration/multi_role_auth.test.ts), 12
tests) were re-run as regression and stay green.

---

## B. Attack surface actually exercised

| Surface | Concrete targets attacked (HTTP) |
| --- | --- |
| HTTP functions | `create-booking`, `cancel-booking`, `update-booking-status`, `doctor-operations` |
| RPCs (PostgREST) | `run_scheduled_tasks` (service-only, no-arg) |
| RLS | `bookings` SELECT under the real `authenticated` role |
| Machine endpoint | `run-cron-minute` (`X-Cron-Secret`) |
| Webhook | `process-whatsapp-webhook` (`X-Hub-Signature-256`) |
| Financial (regression) | refund sync, `record_payment`, fee/refund basis |
| Worker (regression) | `privilege_isolation` Category B/C/D + INVOKER service-only |
| Scheduler (regression) | `scheduler_autonomy` (anon EXECUTE `scheduler_fire_minute` → 42501) |

Two real tenants (A, B) with real GoTrue users (receptionist + doctor in
each), real patients and real bookings were provisioned per-run; nothing
was mocked.

---

## C. Findings

**No security defect (P0–P2) was confirmed.** The only findings are
process/observation items that changed the tests, not the product:

| ID | Severity | Attack / observation | Root cause | Impact | Fix | Regression | Runtime evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S1-OBS-01 | Informational | `create-booking` with `X-Hospital-ID` ≠ body `hospitalId` | Expected 400 in the test; the canonical error contract maps `ValidationError` to **422** ([`errors.ts`](supabase/functions/_shared/errors.ts)) | None — the request is refused, no write | Corrected the test to assert 422 (spec §11: record actual behavior, do not force codes) | `security_s1.test.ts` S1-03 | 422 + both tenants' booking counts unchanged |
| S1-OBS-02 | Informational | Machine/webhook calls with no JWT return **401** | The Kong edge gateway refuses an uncertificated call before the function runs — the function's own secret/signature gate is a *second*, independent layer | None — still a refusal | Test now reaches the function with a valid user JWT to exercise the 403 secret gate, and records the 401 gateway refusal separately (F16-05 discipline: do not merge the two layers) | S1-09, S1-10 | user JWT + missing/wrong cron secret → 403 (function); no credential → 401 (gateway); both refused |
| S1-OBS-03 | Informational | Cross-tenant cancel check initially failed | The victim booking already carried one audit row from its own legitimate creation, so "expect 0 audit rows" was a bad baseline | None — denial + state-unchanged both passed | Test switched to a before/after audit-count delta (a refused attack adds **zero** rows) | S1-04 | audit delta 0; status/cancelled_at unchanged |

The initial five red tests were all test-side miscalibrations against the
documented error contract and gateway layer; **no implementation change
was warranted**, and none was made. This is the honest
"test-vs-implementation" classification required by the standard.

---

## D. S1 Security Acceptance Matrix

Statuses: `PROVEN` · `FIXED + PROVEN` · `BLOCKED` · `NOT APPLICABLE` · `OPEN` ·
(`UNPROVEN` used where a sub-property exists but was not exercised).

| S1 Criterion | Status | Evidence |
| --- | --- | --- |
| Tenant isolation | PROVEN | S1-01 (RLS SELECT leak = none), S1-02; regression E1-14 + privilege_isolation |
| Tenant-ID spoofing | PROVEN | S1-02 (header=B on A JWT → 403), S1-03 (body≠header → 422), no writes |
| Resource-ID spoofing | PROVEN | S1-04 cancel B→403 unchanged, S1-05 doctor update B→403 unchanged |
| Role isolation | PROVEN | S1-06 receptionist→doctor-operations 403; doctor 200 control |
| Doctor isolation | PROVEN | S1-05 (cross-tenant update → 403, state unchanged) + S1-13 (intra-hospital: doctor A vs another doctor's booking in the SAME hospital → 403 `Doctors can only update their own patients`, state unchanged); E1-09 refuses non-doctors |
| Patient isolation | NOT APPLICABLE | The role model (`user_role_type`, [migration 01](supabase/migrations/01_foundation.sql)) defines only global_admin/hospital_admin/doctor/receptionist — there is **no patient login**. Patient data isolation = tenant isolation (PROVEN above) |
| JWT authentication | PROVEN | S1-07 missing/garbage → 401; multi_role_auth garbage-token |
| RLS runtime behavior | PROVEN | S1-01 (real `authenticated` role read), privilege_isolation (22), E1-14 |
| Machine endpoint authentication | PROVEN (fail-closed) / BLOCKED (positive) | S1-09 refuses user JWT & wrong secret (403) and uncertificated (401). Positive authorized path BLOCKED — no `CRON_SECRET` in the Edge container |
| Worker privilege boundary | PROVEN | privilege_isolation Category B/C/D + INVOKER service-only; scheduler_autonomy recovery |
| Scheduler privilege boundary | PROVEN | S1-11 anon/authenticated EXECUTE refused, service retained; scheduler_autonomy anon→42501 |
| RPC privilege boundary | PROVEN | privilege_isolation Categories A–D; S1-11 |
| SECURITY DEFINER safety | PROVEN (prior catalog) / UNCHANGED | Gate 2 catalog census (139 RLS policies; locked B/C/D routines). S1 introduced no new SECURITY DEFINER function and found no new SD defect |
| Financial authorization | PROVEN | S1-04 (cross-tenant refund path refused); settlement record_payment refused for authenticated/unauth; refund_sync ledger/authority regressions |
| Webhook authentication | PROVEN (internal + fail-closed) / BLOCKED (live) | S1-10 unsigned/mis-signed refused; internal HMAC logic proven by [`webhook_signature.test.ts`](tests/unit/webhook_signature.test.ts). LIVE signed webhook BLOCKED — no `META_APP_SECRET` |
| Webhook replay protection | UNPROVEN (S1) | Idempotency/dedup exists (inbound event dedup) but was not exercised by an authenticated replay in S1; internal-logic proof out of scope of this suite |
| Fail-closed behavior | PROVEN | S1-07/08/09/10; multi_role_auth "no primary role → deny"; no privilege fallback observed |
| Error disclosure | PROVEN (observed) | S1-03/08 JSON bodies carried only `{code,message,fieldErrors,correlationId}` — no secret/SQL/stack. Full systematic sweep UNPROVEN |
| Audit logging | PROVEN | S1-12 legitimate booking audited to its tenant; S1-04 denial appended nothing; teardown confirmed `audit_logs are immutable` |
| Unauthorized state mutation | PROVEN | S1-01/02/03/04/05 each re-read the DB after denial — unchanged |
| Security regression | PROVEN | 70/70 across E1(18)+W1(4)+Scheduler(3)+Financial(11)+privilege(22)+multi-role(12) |

No percentage score is given, per spec §33.

---

## E. Privilege evidence (catalog + runtime)

- `run_scheduled_tasks` executed directly via PostgREST: refused for `anon`
  and `authenticated` with a privilege-shaped 401/403 (404 explicitly
  excluded as a test defect, mirroring the F16-05 discipline), while
  `service_role` retains EXECUTE.
- `privilege_isolation` (Category A callable; B/C/D + INVOKER refused for
  anon/authenticated and permitted for service_role) stays green,
  corroborating the Gate 2 posture: **139 live RLS policies**, locked
  service-only routines, deliberately-public RLS helpers preserved.
- Intentional exceptions were **not** revoked to inflate a metric; no
  privilege change was made this phase.

---

## F. Tenant isolation evidence

- **Read (RLS):** as a real `authenticated` Hospital-A JWT,
  `GET bookings?id=eq.<B booking>` → `[]`; `?hospital_id=eq.<B>` → `[]`;
  the same user's own booking → 1 row. Service-role read confirms the B row
  exists (control), so the empty result is isolation, not absence.
- **Header spoof:** A receptionist with `X-Hospital-ID = B` → `resolveAuth`
  finds no grant at B → 403; B booking count unchanged.
- **Body/header desync:** valid A header + body `hospitalId = B` → 422
  ValidationError; neither tenant's booking count changed.

---

## G. Role isolation evidence

- receptionist → `doctor-operations` (`requireRole(["doctor","hospital_admin",
  "global_admin"])`) → 403; doctor → same endpoint → 200 (positive control).
- doctor A → cross-tenant `update-booking-status` on B's booking → 403
  (hospital ownership checked before any write).
- Roles are resolved from `user_roles` (DB), not JWT claims, and multi-role
  resolution never escalates (regression `multi_role_auth`, 12 tests).

---

## H. Fail-closed evidence

| Missing / invalid input | Observed | Fallback granted? |
| --- | --- | --- |
| No `Authorization` (create-booking) | 401 | No |
| Garbage JWT | 401 | No |
| No `X-Hospital-ID` | 422 ValidationError | No default tenant |
| A JWT + B header | 403 | No |
| Body tenant ≠ header tenant | 422 | No |
| Cron call, no/wrong secret | 403 (function) / 401 (gateway) | No execution |
| Unsigned / mis-signed webhook | ≥400 (never 2xx) | No acknowledgement |
| Scheduler RPC as anon/authenticated | 401/403 privilege | No EXECUTE |

No path silently widened to public access, service role, or a default
hospital.

---

## I. External / environment blockers (kept separate from proofs)

- **Razorpay:** no real credentials. Payment/refund authorization is proven
  only through the internal RPC chain and refusals; live PSP behavior is
  BLOCKED.
- **Meta / WhatsApp:** no `META_APP_SECRET`. Internal signature logic is
  unit-PROVEN; the live signed webhook path is BLOCKED and was NOT faked.
- **Machine secrets:** the Edge container has no `CRON_SECRET` /
  `WORKER_SECRET`, so the cron/worker **authorized** path is BLOCKED; only
  the fail-closed refusal is proven.
- **Production:** nothing here is production verification. No deployment is
  asserted.
- **Gateway vs function:** a 401 from Kong and a 403 from the function are
  reported as distinct layers, never merged (F16-05).

---

## J. Remaining product decisions (not silently resolved)

- **NPD-05 (scheduler):** still a design decision — no scheduler is wired;
  S1 did not choose one.
- **P0-01 (`claim_jobs_v2` lease_expires_at):** a functional crash-recovery
  gap, **not** a privilege boundary issue; untouched by S1 and still open.
- **P0-03 / P0-04:** environment/default and fee-writer items — unchanged,
  out of S1's security scope.

---

## K. Production limitations (explicit)

UNPROVEN in production: actual deployed privilege ACLs, live RLS policy
count, real webhook authenticity under production secrets, real PSP
behavior, and any runtime reachable only post-deploy. The `RestartPolicy=no`
Edge Runtime behavior (F16-01) is an environment concern, not a boundary.
Local green ≠ production secure; this report claims the former only.

---

## Verification log (local)

| Gate | Result |
| --- | --- |
| `security_s1.test.ts` | 15 passed / 0 failed |
| E1 `hospital_core_journey` | 18 passed |
| W1 `worker_lifecycle` | 4 passed |
| Scheduler `scheduler_autonomy` | 3 passed |
| Financial (`refund_sync`, `booking_fee_refund`, `settlement_record_payment`) | 11 passed |
| `privilege_isolation` | 22 passed |
| `multi_role_auth` | 12 passed |
| **Regression total** | **70 passed / 0 failed** |
| `validate:migrations` | 0 errors, 4 pre-existing `[duplicate-objects]` warnings (baseline) |
| `deno lint` | clean |
| `deno check` (task) | exit 0 (all functions + tests) |
| `gen:types:check` | `database.generated.ts` up to date |
| `deno fmt --check` | 0 source files affected; only the known root `.md` cosmetic baseline |

Commands were run against the live local stack with the Edge Runtime
confirmed up (per AGENTS.md §13, an exit code alone is not trusted for
Edge-dependent tests).

---

## Certification statement

Within the limits of local, secret-free execution, the S1 objective —
*"can an unauthorized person make the system do something it should
not?"* — was answered by direct attack: **every unauthorized attempt was
denied with no data leak and no state mutation**, and the legitimate
primitives continued to work. No P0/P1 security defect remained, so
certification was not worked around.

**PHASE 5 COMPLETE — WITH BLOCKED EXTERNAL/ENVIRONMENT EVIDENCE.**

Phase 6 is NOT started (per spec §36).
