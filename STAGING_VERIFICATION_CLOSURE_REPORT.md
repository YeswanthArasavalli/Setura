# SETURA — STAGING VERIFICATION CLOSURE REPORT

Evidence vocabulary per AGENTS.md §5: IMPLEMENTED · STATICALLY VERIFIED ·
UNIT VERIFIED · INTEGRATION VERIFIED · **RUNTIME VERIFIED (staging)** ·
PRODUCTION VERIFIED · UNPROVEN · BLOCKED · FAIL. No claim is upgraded beyond
the evidence that produced it. Staging project: `setura-staging`
(`gzcqasntcbqqmgsoikms`). **No secret value, password or token was printed or
committed.** Public-by-design client config (project URL, anon key) was used
only locally for anonymous HTTP probes.

---

## 1. Executive Summary

This workstream re-opened the live `setura-staging` environment and produced
**new, real, non-fabricated evidence** for three of the four objectives and
honestly recorded the fourth as blocked.

Achieved this session (live staging):

- **Cross-tenant isolation — RUNTIME VERIFIED** at both the database boundary
  (SET ROLE + simulated JWT) and the HTTP/PostgREST boundary. A Hospital A
  admin sees its own 16 bookings (and a specific A booking by primary key =
  1); a Hospital B user sees **0** of A's rows; `anon` sees **0**.
- **RPC / privilege boundaries — RUNTIME VERIFIED.** Catalog ACL shows
  `trigger_sla_refresh` is service-role-only; a direct DB call as `anon` fails
  with **SQLSTATE 42501**; over HTTP the RPC is **not exposed** (404 PGRST205).
- **Authentication negative path — RUNTIME VERIFIED.** Invalid login → HTTP
  400; `anon` REST returns `200 []` (RLS), not data.
- **compute_sla (migration 73) — RUNTIME VERIFIED (zero-wait path).** Guard
  present in `pg_get_functiondef`; recompute of a zero-wait day yields
  `sla_wait_breached = false`, `avg_wait_minutes = NULL`, no `23502`.
- **Frontend staging — deployed & live.** Vercel serves HTTP 200
  (`title = SETURA — Staff Console`), targets the correct staging project, and
  **redirects unauthenticated visitors away from `/admin` and `/admin/audit` to
  `/login`** (browser-confirmed).

Cannot be honestly certified this session (require owner-provided valid
staging credentials / a ≥24h authorized soak window):

- The **≥24h worker happy-path soak** (only a smoke exists).
- **Positive authenticated login** + role-capability matrix at the Edge
  Function layer, and the **full end-to-end hospital journey** through the
  product UI/APIs.
- The **authenticated** frontend walkthrough (role routing, logout, session
  persistence, protected-data rendering).

**Final status (§16): STAGING PARTIALLY VERIFIED — REMAINING BLOCKERS.**
`STAGING VERIFIED` must NOT be claimed: the 24H soak, authenticated hospital
E2E and authenticated frontend/security positive paths are genuinely
UNPROVEN / BLOCKED.

---

## 2. Starting State (re-confirmed live this session)

| Check | Result |
| --- | --- |
| Staging reachable + linked | YES (`gzcqasntcbqqmgsoikms`, CLI 2.100.1) |
| Migrations applied | max `73`, count `73` |
| Distinct job types | `2` (`send_whatsapp_message`, `compute_sla`) |
| job_queue | completed `1`, dead `77`, pending/claimed `0` |
| compute_sla guard present | `true` (in `pg_get_functiondef`) |
| auth.users | `5` |
| hospitals | `5` (Surya `…001`, Sri Venkateswara `…002`, +3) |
| user_roles | global_admin `1`, hospital_admin `1`, doctor `1`, receptionist `2` |
| live RLS policies (public) | `144` |

Tenant map used for testing — Hospital A = `…0001` (admin `…a2`, doctor `…a3`,
receptionist `…a4`); Hospital B = `…0002` (receptionist `…c1`); global_admin
`…a1` (hospital_id NULL).

---

## 3. Objective A — 24H Worker Happy-Path Soak

```text
SMOKE TEST (happy path):  PASS  (prior WS-OPS-1: real compute_sla job
                                enqueue→claim→lease→execute→completed;
                                completed_jobs_total 0→1; re-confirmed
                                this session: completed=1)
24H HAPPY-PATH SOAK:      UNPROVEN / BLOCKED
```

A genuine unattended ≥24-hour soak was **not** run and was **not** fabricated.

- **BLOCKER:** a ≥24h wall-clock observation window in a controlled staging
  run.
- **WHY:** the only soak harness (`scripts/ws_ops1_autonomy_soak.ts`,
  `deno task soak:autonomy`) is loopback-locked by design (`isLocal()` gate →
  `Deno.exit(3)` off-loopback). Per prompt §3/§5 its safety restriction must
  NOT be relaxed to force staging execution, and fake jobs must NOT be added
  to inflate metrics.
- **EXACT OWNER ACTION:** authorize either (a) a dedicated, owner-approved
  staging soak variant permitted to point at `setura-staging`, or (b) a ≥24h
  controlled staging observation window using a legitimate benign producer
  (`trigger_sla_refresh`) drained by the real pg_cron → worker path.
- **WHAT WAS VERIFIED WITHOUT IT:** worker claim/lease/retry/DLQ and the
  happy-path smoke remain RUNTIME VERIFIED from prior + this session
  (`completed=1`). **Superseding note:** `cron.job_run_details` returned 0
  success / 0 failed this session (history trimmed/retained); scheduler >24h
  health is carried from the prior WS-OPS-1 certification and was **not**
  re-established this session — do not read 0/0 as fresh proof of a 24h healthy
  run.

---

## 4. Objective B — Authenticated Security

### 4a. VERIFIED — negative path + database authorization boundary

DB boundary (SET LOCAL ROLE + simulated `request.jwt.claims`), live staging:

| Caller (claims sub / role) | Target | Result |
| --- | --- | --- |
| hospital_admin `…a2` / authenticated | all `bookings` | **16** (own tenant) |
| hospital_admin `…a2` / authenticated | A booking by exact id | **1** |
| receptionist `…c1` (Hospital B) / authenticated | all `bookings` | **0** |
| receptionist `…c1` / authenticated | A booking by exact id | **0** |
| `anon` (no claims) | `bookings` | **0** rows (RLS default-deny) |

- `auth.uid()` resolves from the simulated claims; RLS is genuinely enforced
  for `authenticated` (elevated caller sees all, scoped caller sees tenant
  slice). `bookings` and `patients` have `relrowsecurity = true` **and**
  `relforcerowsecurity = true`.

HTTP boundary (public anon key, PostgREST/Auth), live staging:

| Probe | Result |
| --- | --- |
| `anon` `GET /rest/v1/bookings` | **HTTP 200** body `[]` (RLS over HTTP) |
| `anon` `POST /rest/v1/trigger_sla_refresh` | **HTTP 404** `PGRST205` (RPC not exposed to anon) |
| `POST /auth/v1/token` invalid credentials | **HTTP 400** (denied, no session) |

RPC privilege boundary, live staging:

- Catalog ACL `has_function_privilege` for `trigger_sla_refresh(uuid,date)`:
  `anon=false`, `authenticated=false`, `service_role=true`.
- Direct DB call as `anon`: **`ERROR 42501: permission denied for function
  trigger_sla_refresh`** (real SQLSTATE, not a JWT-layer 401).

### 4b. BLOCKED — positive authenticated paths

- **Valid login / token refresh / expiry / Edge Function `requireRole`
  capability matrix (Global Admin / Hospital Admin / Doctor / Receptionist).**
- **WHY:** the 5 staging auth users exist but their **passwords are not held**
  in this environment; no service-role key is available as a secret; and the
  prompt (§6) forbids fabricating authenticated users. Negative-path probes
  cannot stand in for a real successful login.
- **EXACT OWNER ACTION:** provide (out-of-band) one valid credential set per
  role for the seeded staging users, **or** authorize admin-API user creation
  under a service key, to enable the positive authorization matrix.
- **VERIFIABLE WITHOUT IT:** everything in §4a (tenant isolation, RLS, RPC
  privilege, anon/bad-credential denial) is already proven at the authoritative
  backend boundary — which §7 explicitly requires over frontend-only checks.

---

## 5. Tenant Isolation (mandatory gate)

**PASS — RUNTIME VERIFIED (staging, DB + HTTP).** Bidirectional proof that the
database authorization boundary (not just the UI) enforces tenancy: Hospital A
user reads only A (16 / own-by-id 1), Hospital B user reads 0 of A's rows
(including by exact primary key), `anon` reads 0. Cross-tenant reads are denied
at RLS and mirrored at PostgREST.

---

## 6. RPC / Privilege Verification

**PASS — RUNTIME VERIFIED (staging).** Catalog ACL + live SQLSTATE 42501 as
`anon` + PostgREST 404 (non-exposure) confirm a service-role-only producer is
protected at the DB and HTTP boundaries. Live RLS policy count = **144**.
Staging privilege posture was measured **directly on staging**, not inferred
from local evidence (prompt §8 respected). (Sampling one representative locked
RPC; a full 179-routine ACL sweep is out of scope and unchanged from prior
certifications.)

---

## 7. Objective C — End-to-End Hospital Journey

**BLOCKED.** The journey (§9 of the task) begins at *Hospital Staff Login* and
runs provisioning → configuration → clinical setup → validation → activation →
booking → queue → cancellation → audit → reports **through the implemented
authenticated APIs/RPCs**. Without valid staging credentials for the seeded
users this could not be executed, and it was **not** simulated or fabricated.

- **EXACT OWNER ACTION:** supply role credentials (see §4b) or authorize
  service-key user provisioning; then the journey can be driven against the
  already-live primitives.
- **PARTIAL signal (not a substitute):** staging already contains 5 hospitals
  and 5 role assignments (prior seeded provisioning artifacts), confirming the
  provisioning objects exist — but this is **data presence, not a run
  journey**, and is recorded as UNPROVEN for the gate.

---

## 8. Objective D — Frontend Staging

**DEPLOYED & PARTIALLY VERIFIED — authenticated walkthrough BLOCKED.**

VERIFIED (live):

- Vercel project `setura` (`prj_PZq3TlY28vzz3hF6x0TKpvxK6gMH`) authenticated as
  `yeswantharasavalli`; live deployments return **HTTP 200**,
  `<title>SETURA — Staff Console</title>`, SPA shell with root div.
- Build/output config: `vercel.json` framework `vite`, `npm run build` → `dist`,
  SPA rewrites `/(.*) → /index.html`.
- Environment config: production env `VITE_SUPABASE_URL =
  https://gzcqasntcbqqmgsoikms.supabase.co` — **targets the correct staging
  project**; anon key present (public client key).
- **Unauthenticated route guard (browser, live):** `/` → redirects to `/login`;
  `/admin` → `/login`; `/admin/audit` → `/login`; login form renders (email +
  password + Sign in). No protected data leaked. Screenshot:
  `_unauth_admin_redirect.png`.

BLOCKED: authenticated role routing across `/admin/*` (audit, reports,
portfolio, financial, alerts, operations, hospital-settings, integrations,
clinical-configuration, activation), doctor/receptionist views, logout, session
persistence and protected-data rendering — all require a successful login
(§4b blocker). **No authenticated route is claimed as verified.**

---

## 9. compute_sla Verification (migration 73 regression)

**RUNTIME VERIFIED (staging) for the zero-wait path** — the exact former-crash
case. Guard `v_avg_wait IS NOT NULL AND v_avg_wait > v_wait_threshold` present
in staging `pg_get_functiondef`. Recompute of `…001 / 2026-10-01` (0 bookings)
→ `sla_wait_breached = false`, `avg_wait_minutes = NULL`, **no `23502`**. All
**4** existing `sla_daily_tracking` rows currently: `breached=false`, `avg NULL`.

- **Below/above-threshold → `true` branch:** NOT exercised on live staging data
  because staging currently has **zero** wait samples (all days NULL). That
  branch is proven only by the local integration regression (4/4 post-fix in
  WS-OPS-1). Recorded as **UNVERIFIED on live staging data** (locally proven).
- The `NOT NULL` constraint was **not** weakened.

---

## 10. Existing 7 Dead Jobs

**Confirmed terminal.** Staging `job_queue` still shows dead `77` (the 70
WhatsApp + 7 `compute_sla`). No history was rewritten and none were re-queued.
The important proof stands: their previously failing input shape (zero-wait day)
now succeeds under the fixed function (§9 recompute) — forward-looking fix,
historical dead rows left untouched.

---

## 11. Tests Executed (exact, this session)

| Scope | Command | Result |
| --- | --- | --- |
| Migration validation | `deno task validate:migrations` | **0 errors / 6 pre-existing warnings** |
| Migration manifest | `deno task validate:migration-manifest` | **73 migrations / 73 lines / 0 integrity issues** |
| Staging DB-boundary isolation | live SQL (SET ROLE/claims) | 4 assertions PASS (§4a) |
| Staging HTTP boundary | live REST/Auth | 3 probes as recorded (§4a) |
| Staging RPC privilege | live SQLSTATE + catalog ACL | 42501 + service-only confirmed |
| Staging compute_sla recompute | live SQL | zero-wait → false, no 23502 |
| Frontend live + unauth guard | HTTP + browser | 200 + redirect to /login |

The historical **537/537** integration baseline was **NOT** re-run this session
and is **not** claimed here. Unit/integration suites were only run for the two
read-only validation tasks above (this session made **no source-code change**,
so a full suite re-run was not required by prompt §17).

---

## 12. Files Changed

**No production source, migration, Edge Function or frontend code was modified.**
This session only read state and ran read-only / computed-state probes. Scratch
verification helpers created and then removed: `_sv_*.sql`, `_sv_http.ps1`,
`_sv_http.log`, `_sv_fe.log`, `apps/web/_sv_fe.ps1`. Browser evidence retained:
`_unauth_admin_redirect.png`. Deliverable added: **this report**.

---

## 13. Database Changes

**No migration 74 was created.** No schema, table, column, constraint, RLS or
grant change was made. The only staging writes were legitimate computed state:
one `compute_sla_tracking(...)` recompute of `…001 / 2026-10-01` (upserts an
SLA rollup row that already existed as `false`) — a benign recomputation, no
PII exposed, no immutable financial record touched. Migration 73 remains the
latest canonical migration.

---

## 14. Runtime Evidence — LOCAL / STAGING / PRODUCTION

LOCAL:
- `validate:migrations` 0/6; manifest 73/73/0. STATICALLY VERIFIED.

STAGING (`setura-staging`, live this session) — RUNTIME VERIFIED:
- Tenant isolation (DB + HTTP), RLS force posture, 144 policies.
- RPC privilege boundary (42501 + ACL + HTTP 404).
- Auth negative path (bad login 400, anon empty).
- compute_sla zero-wait path.
- Frontend deployed + unauthenticated route guard.

PRODUCTION:
- **UNPROVEN.** No production project/deploy/accessed. Staging results are NOT
  read as production readiness (prompt §20).

---

## 15. Known Limitations / Owner & Environment Blockers

1. **24H soak** — needs a ≥24h authorized staging observation window or an
   owner-approved soak variant; loopback lock must NOT be bypassed. (§3)
2. **Positive authentication + role capability matrix** — needs valid staging
   credentials (passwords not held) or service-key provisioning authorization.
   (§4b)
3. **End-to-end hospital journey** — blocked on #2. (§7)
4. **Authenticated frontend walkthrough** (role routing / logout / session /
   protected data) — blocked on #2. (§8)
5. **compute_sla threshold `true` branch** — no live wait-sample data on
   staging; locally proven only. (§9)
6. **Scheduler fresh >24h health** — `cron.job_run_details` returned 0/0 this
   session (history trimmed); carried from prior certification, not
   re-established. (§3)

Provider integration (Razorpay/Meta) and production remain intentionally
out of scope and untouched.

---

## 16. Final Status

```text
STAGING PARTIALLY VERIFIED — REMAINING BLOCKERS
```

Definition-of-Done gate ledger (§21):

```text
Database parity                 PASS
Migration integrity             PASS   (73/73/0; validate 0 err/6 warn)
Scheduler runtime               PASS (prior cert) — NOT re-established this session
Worker claim/lease              PASS (prior)
Worker retry/DLQ                PASS (prior)
Worker happy path               PASS (smoke, prior + completed=1 this session)
24H worker soak                 UNPROVEN / BLOCKED        <-- blocks "VERIFIED"
Authenticated security          PARTIAL (boundary+negative PASS; positive BLOCKED)
Cross-tenant isolation          PASS (DB + HTTP, this session)
RPC privilege boundaries        PASS (this session)
Hospital E2E                    BLOCKED (no credentials)   <-- blocks "VERIFIED"
Frontend staging                PARTIAL (deploy+unauth PASS; authed BLOCKED)
Critical regression (compute_sla) PASS (zero-wait on staging; threshold branch local-only)
```

Because **24H worker soak**, **Hospital E2E** and the authenticated halves of
**Authenticated security** and **Frontend staging** are genuinely
UNPROVEN / BLOCKED, `STAGING VERIFIED` cannot be claimed. The remaining gates
need exactly one enabling input: **owner-authorized valid staging credentials
(§4b) and an authorized ≥24h soak window (§3).** No evidence on this page was
manufactured; every PASS cites a live staging measurement taken this session or
a prior certification explicitly labelled as carried-forward.

---

## 17. Addendum — Continuation Re-check (no code change; owner input required)

A follow-up pass re-tested whether either blocker could be cleared with the
**currently available environment/access** before making any code change.
Outcome: neither blocker is a coding problem; both remain owner/environment
bound. No source, migration, Edge Function, frontend or provider change was
made, and none was warranted.

**Environment credential availability (checked this pass, names/values not
printed):**

| Item | State |
| --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | ABSENT |
| `SERVICE_ROLE_KEY` | ABSENT |
| `SUPABASE_DB_URL` | ABSENT |
| `SUPABASE_ACCESS_TOKEN` (env) | ABSENT (linked `db query` succeeds via the CLI's stored management login, which is elevated **read/compute** only) |
| local `.env` (non-example) | none |
| `.env.example` | placeholders only |

**Blocker 2 re-confirmed:** the 5 staging `auth.users` exist and are
`email_confirmed = true`, but **no valid password and no service-role key are
present** in this environment. The Auth Admin API (login/password reset) and
the Edge Function `requireRole` matrix therefore cannot be exercised via a
legitimate successful login. Writing/rotating a password directly into
`auth.users` via the elevated DB connection would be **manufacturing
credentials** (prompt: "Do NOT fabricate credentials"; AGENTS.md §7 secrets /
least-privilege) and was explicitly NOT done.

**Blocker 1 re-confirmed:** no ≥24h authorized observation window is available
and `scripts/ws_ops1_autonomy_soak.ts` stays loopback-locked by design; its
safety restriction was NOT bypassed and no jobs were fabricated to inflate
metrics.

**compute_sla true-branch:** staging holds **zero** live wait samples (all 4
`sla_daily_tracking` rows `avg_wait_minutes IS NULL`). Synthesising wait data
would distort business records, so it was NOT created. Recorded as:

```text
STAGING TRUE-BRANCH (breach = true) = UNPROVEN (no live wait samples)
LOCAL REGRESSION (breach = true)     = PROVEN (WS-OPS-1, 4/4 post-fix)
```

**Decision:**

```text
CODE STATUS:
No implementation required.

STAGING STATUS:
PARTIALLY VERIFIED.

BLOCKER 1:
24H worker soak — owner/environment required.

BLOCKER 2:
Positive authenticated staging access — owner/environment required.

PRODUCTION:
UNPROVEN.

PROVIDERS:
OUT OF SCOPE.
```

**Exact owner action required** (unchanged, now with the enabling cause
isolated):
1. Supply one valid credential set per role for the seeded staging users
   **out-of-band** (or authorize service-key admin provisioning) → unblocks
   positive login, role/capability matrix, authenticated frontend walkthrough
   and the full hospital journey.
2. Authorize a controlled ≥24h staging soak window (or approve a
   staging-targeted soak variant that does not weaken the loopback lock) →
   unblocks the 24H worker soak gate.

Until both enabling inputs exist, `STAGING VERIFIED` must NOT be claimed.
