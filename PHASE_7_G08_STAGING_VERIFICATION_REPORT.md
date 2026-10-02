# PHASE 7 — G-08 STAGING VERIFICATION REPORT

**Workstream:** G-08 — Global Admin Portfolio Dashboard
**Gate:** Staging deployment + browser verification
**Date:** 2026-10-01 (UTC)
**Role:** Release / verification engineer (NOT a coding phase)

---

## 1. EXECUTIVE SUMMARY

The single known G-08 staging blocker was a **stale deployed `executive-analytics`
Edge Function (v7)** whose CORS preflight response omitted `apikey`,
`X-Client-Info` and `Vary: Origin`, so the browser preflight failed before the
portfolio/benchmark POSTs could reach the function. This was a **deployment
freshness problem**, not a frontend implementation defect.

The one authorized remediation — redeploying **only** `executive-analytics` to
the existing `setura-staging` project — was executed and re-verified end to end.
After the deploy:

- Staging preflight now returns the required CORS headers.
- The backend authorization matrix is unchanged and correct
  (`portfolio`/`benchmarks` → 200 for global_admin, `403` hospital_admin,
  `422` missing tenant header, `401` anonymous).
- The global-admin browser journey renders **real** cross-hospital portfolio and
  benchmark data with a clean initial network fan-out, zero idle-loop requests,
  and a correct single-cycle Refresh.
- Role isolation (hospital_admin / receptionist / doctor) is enforced by the
  route guard, not merely by hiding the nav item: each role is redirected away
  from `/admin/portfolio` and issues **0** `executive-analytics` browser calls.
- Auth-loop regression, console cleanliness, and G-03/G-05/G-06/G-07 smoke all
  pass.
- Production was completely untouched.

**FINAL STATUS: G-08 — PROVEN STAGING — CLOSED**

Every mandatory acceptance gate in §21 of the task specification passed with
observed evidence. No frontend, SQL, fixture, role or production change was made.

---

## 2. BASELINE COMMIT

Verified against the actual Git repository (present in this tree):

```text
HEAD          = df4101f45a6d5484970c362341a5fc95e84d586d
origin/main   = df4101f (HEAD -> main, origin/main, origin/HEAD)
G-08 impl     = df4101f  "Add read-only global admin portfolio dashboard (G-08)"
auth-loop fix = 18cfefc  "Preserve proven auth app-shell request-loop fix"
prior         = da5332e  "Staff booking reschedule + G-06 closure"
```

Matches the baseline stated in the task (§1). `git status --short` showed only
untracked report/log artifacts — **zero tracked source files modified** before
or during this verification.

---

## 3. DEPLOYMENT AUTHORIZATION

Explicitly authorized exactly one backend deployment (§3):

```text
supabase functions deploy executive-analytics
Target: setura-staging / gzcqasntcbqqmgsoikms / ap-south-1
```

Only `executive-analytics` was deployed. No other Edge Function, no new Supabase
project, no new Vercel project, no production deploy, no production change.
CLI authentication confirmed by `supabase projects list`, which enumerated the
existing staging project `setura-staging` (ref `gzcqasntcbqqmgsoikms`, region
"South Asia (Mumbai)" = ap-south-1, created 2026-09-20).

---

## 4. PRE-DEPLOYMENT SOURCE VERIFICATION (§4)

Inspected, did not edit:

| File | Confirmed behavior |
| --- | --- |
| `supabase/functions/executive-analytics/index.ts` | Imports `handleCors` from `_shared/cors.ts`; requires `X-Hospital-ID` (missing → `ValidationError` → 422); `resolveAuth` + `requireRole(["hospital_admin","global_admin"])`; `GLOBAL_ACTIONS = {portfolio, benchmarks}` restricted to `global_admin` else `ForbiddenError` → 403; pure pass-through to SQL RPCs `get_portfolio_dashboard` / `get_cross_hospital_benchmarks` (no edge recomputation). |
| `supabase/functions/_shared/cors.ts` | `buildCorsHeaders` emits `Vary: Origin`, `Access-Control-Allow-Headers` includes `apikey` and `X-Client-Info`, fail-closed origin (no ACAO echoed for disallowed/absent origin), credentials only alongside a concrete allowed origin. |
| `supabase/functions/_shared/env.ts` | Production fail-closed `ALLOWED_ORIGINS` (no invented default); dev defaults to localhost origins. |

The source is the current repository version and is consistent with the CORS /
environment remediation already audited in the G-08 implementation report. **No
discrepancy** requiring a STOP.

---

## 5. FUNCTION VERSION BEFORE / AFTER (§6)

```text
Before (stale, from prior verification): executive-analytics v7, ~2026-09-20
After  (this deploy):                    executive-analytics v8, ACTIVE
Updated at (UTC):                         2026-10-01 04:49:11
Project ref:                              gzcqasntcbqqmgsoikms
Deployment log:                           "Deployed Functions on project
                                          gzcqasntcbqqmgsoikms:
                                          executive-analytics" (script 187.5 kB)
```

Deployed version **v8 > v7** — confirmed newer than the stale deployment. Only
`executive-analytics` appears as deployed by this action.

---

## 6. CORS PREFLIGHT EVIDENCE (§7)

Direct `OPTIONS` to
`https://gzcqasntcbqqmgsoikms.supabase.co/functions/v1/executive-analytics`
with `Origin: https://setura-delta.vercel.app` and
`Access-Control-Request-Headers: apikey,x-client-info,authorization,content-type,x-hospital-id`:

```text
Status:                                   204 (handled by handleCors)
Access-Control-Allow-Origin:              https://setura-delta.vercel.app
Vary:                                     Accept-Encoding, Origin   (includes Origin)
Access-Control-Allow-Credentials:         true
Access-Control-Allow-Headers:             Authorization, Content-Type,
                                          Idempotency-Key, X-Correlation-ID,
                                          X-Request-ID, X-Hospital-ID,
                                          apikey, X-Client-Info
Access-Control-Allow-Methods:             GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Max-Age:                   86400
x-sb-edge-region:                         ap-south-1
x-served-by:                              supabase-edge-runtime
```

`apikey`, `X-Client-Info` and `Vary: Origin` are all now present and the staging
frontend origin is accepted. The previously failing preflight is resolved. The
browser can send `POST /functions/v1/executive-analytics` from
`https://setura-delta.vercel.app`.

---

## 7. BACKEND HTTP EVIDENCE (§8)

Server-side probes against staging, authenticated via the password-grant token
endpoint with the staging anon key and `X-Hospital-ID:
00000000-0000-4000-8000-000000000001`. Authorization results were NOT weakened.

| Case | Actor / request | Result | Expected |
| --- | --- | --- | --- |
| Global portfolio | global_admin `action=portfolio` | **200** | 200 |
| Global benchmarks | global_admin `action=benchmarks` | **200** | 200 |
| Hospital admin | hospital_admin `action=portfolio` | **403** | 403 |
| Missing tenant header | global_admin, no `X-Hospital-ID` | **422** | 422 |
| Anonymous | no Bearer token, header present | **401** | 401 |

### Actual response structures (server-provided, not client-aggregated)

`portfolio` keys: `date, hospitals, total_hospitals, active_hospitals`

```json
{"date":"2026-10-01","total_hospitals":5,"active_hospitals":5,
 "hospitals":[
  {"name":"Surya Hospital","slug":"surya-hospital","is_active":true,"sla_status":null,"revenue_today":0,"bookings_today":2,"active_sessions":0,"outstanding_balance":null},
  {"name":"Sri Venkateswara Hospital","...":"...","bookings_today":0},
  {"name":"Tulasi Hospital","...":"...","bookings_today":0},
  {"name":"Vijaya Lakshmi Eye Hospital","...":"...","bookings_today":0},
  {"name":"Ganesh Children Hospital","...":"...","bookings_today":0}]}
```

`benchmarks` keys: `from_date, to_date, benchmarks` (window
`2026-09-02 → 2026-10-01`), 5 hospital rows with `bookings, completed,
avg_wait_minutes (null), avg_consultation_minutes, efficiency_pct, revenue_inr`.
Notable real values: Surya `bookings:14, completed:5, efficiency_pct:35.7,
avg_consultation_minutes:0.6`. Meaningful nulls (`sla_status`,
`outstanding_balance`, `avg_wait_minutes`) are returned as `null`, **not**
coerced to zero.

---

## 8. GLOBAL-ADMIN BROWSER EVIDENCE (§9)

Target `https://setura-delta.vercel.app`. Logged in as seeded `root@setura.test`
(password not printed/exposed). Confirmed role badge **`global admin`**
("Setura Root Admin", tenant "no tenant").

- **Navigation:** `Global Portfolio` nav item visible to global_admin.
- **`/admin/portfolio` accessible:** renders `Global Portfolio` heading with the
  server-side-aggregation disclosure line. Page states plainly that nothing is
  computed in the browser.
- **Portfolio section (real data):** REPORTED DATE `2026-10-01`, TOTAL HOSPITALS
  `5`, ACTIVE HOSPITALS `5`; 5 hospital rows exactly matching the backend
  response (Surya bookings-today `2`, others `0`).
- **Benchmarks section (real data):** heading `Cross-Hospital Benchmarks`,
  `Window: 2026-09-02 → 2026-10-01`, 5 hospital rows with the server's metrics.
- **Empty/null semantics:** nulls displayed as `—` (Outstanding balance / SLA
  status on all rows; Avg wait on all; Avg consultation on 4/5); real zeros shown
  as `0`. No null→fake-zero conversion; existing G-08 display behavior used.
- **Tenant header context:** the page discloses it sends `X-Hospital-ID:
  00000000-0000-4000-8000-000000000005` obtained through the intentional bounded
  RLS read (global_admin has no own hospital) — used only to satisfy the header;
  the figures are cross-hospital. This is the established intentional G-08
  frontend behavior; it was NOT replaced with fixture manipulation.

Screenshots: `g08_staging_A1_globaladmin_login.png`,
`g08_staging_B_portfolio.png`.

---

## 9. NETWORK EVIDENCE (§10)

Clean `/admin/portfolio` initial load (fetch/xhr + preflight):

```text
POST  .../functions/v1/executive-analytics  (action=portfolio)   200
POST  .../functions/v1/executive-analytics  (action=benchmarks)  200
GET   .../rest/v1/hospitals?select=id,name&order=name.asc&limit=1  200
OPTIONS preflights for the above                                  200/204
GET   .../rest/v1/profiles, .../rest/v1/user_roles (auth resolution) 200
```

Counts exactly as intended: **1 portfolio + 1 benchmarks + 1 bounded hospitals
read**, all 200. The hospitals read is bounded (`limit=1`). Requests originate
from `https://setura-delta.vercel.app` and are accepted by staging CORS (no
preflight failure). The `X-Hospital-ID` tenant header is present as required by
the backend contract. **No `service_role` key** appears in browser requests —
every analytics request used the anon/publishable `apikey` + user Bearer JWT. No
tenant ID is stuffed into the request body to bypass authorization (the body is
only `{"action":"portfolio"}` / `{"action":"benchmarks"}`, confirmed by body
capture).

---

## 10. IDLE-LOOP EVIDENCE (§11)

After the portfolio loaded, the page was left idle. Measured idle window
≈ **182 seconds** (far exceeding the 20s minimum, within the preferred 30–60s+
range). Cross-validated with the in-page Performance Resource Timing API after
the DevTools buffer was cleared mid-idle (tooling caveat, reported honestly).

New requests during idle:

```text
0 new executive-analytics requests
0 repeated hospitals reads
0 auth-triggered page remounts (profiles=1, user_roles=1, unchanged)
0 unexpected API loops
0 login bounce
```

Also serves as a regression check for the previously fixed AuthProvider/remount
problem — none recurred. Screenshot: `g08_staging_D_idle_state.png`.

---

## 11. REFRESH EVIDENCE (§12)

The explicit `Refresh` button was clicked **exactly once**. It disabled, both
sections showed transient `Loading portfolio…` / `Loading benchmarks…`, then
re-rendered identical data and re-enabled.

```text
executive-analytics resource count: 2 → 4   (delta +2, simultaneous)
+1 portfolio request (body {"action":"portfolio"})   200
+1 benchmarks request (body {"action":"benchmarks"}) 200
hospitals reads: stayed 1 (context read correctly NOT re-fired)
profiles / user_roles: stayed 1 each (no remount)
No repeated loop. No polling added. UI updated successfully.
```

Screenshot: `g08_staging_E_after_refresh.png`.

---

## 12. ROLE-ISOLATION EVIDENCE (§13–§15)

Backend isolation (proven in §7): `hospital_admin → portfolio = 403`.

Frontend isolation, all three non-global roles:

| Role | Login badge | Global Portfolio nav | Direct `/admin/portfolio` | executive-analytics browser calls |
| --- | --- | --- | --- | --- |
| hospital_admin (`admin@surya.test`) | `hospital admin` | NOT visible | **redirect → `/admin`** | **0** |
| receptionist (`reception@surya.test`) | `receptionist` | NOT visible | **redirect → `/reception`** | **0** |
| doctor (`dr@surya.test`) | `doctor` | NOT visible | **redirect → `/doctor`** | **0** |

The route guard prevents access independently of hiding the nav item — direct
navigation to `/admin/portfolio` is redirected for every non-global role, and
**0** `executive-analytics` requests are issued. No fixtures were modified.

Screenshots: `g08_staging_hospadmin_login.png`,
`g08_staging_hospadmin_portfolio_denied.png`,
`g08_staging_receptionist_denied.png`, `g08_staging_doctor_denied.png`.

---

## 13. CONSOLE EVIDENCE (§17)

For each role tested (`global_admin`, `hospital_admin`, `receptionist`,
`doctor`):

```text
0 application JavaScript errors
0 unhandled promise rejections
0 React runtime errors / prop warnings
```

No intentional negative HTTP probes (401/403/422) surfaced as console failures;
in the browser journeys above every observed fetch/xhr returned 200 (the
403/422/401 matrix was exercised at the backend layer in §7, not by the browser
roles, which are blocked before ever calling the endpoint).

---

## 14. AUTH-LOOP REGRESSION EVIDENCE (§16)

Across all role sessions, none of the regression symptoms appeared:

```text
No persistent "Loading" screen after token refresh (only transient route-resolution loading)
No AppShell remount loop (header/nav/content stable across repeated snapshots + ~16s idle)
No repeated profiles / user_roles reads (exactly 1 + 1 per full page load; re-verified on a
  hard reload of a protected deep link, which restored the session in place)
No repeated Command Centre calls (single 5-call fan-out only, on /admin)
No repeated portfolio / benchmark calls
No login bounce to /login
0 console exceptions in all sessions
```

Previously fixed AuthProvider behavior remains intact.

---

## 15. G-03 / G-05 / G-06 / G-07 SMOKE EVIDENCE (§18)

Lightweight smoke only; no unnecessary mutations performed.

- **G-03 Command Centre (`/admin`) — PASS.** Loads real data (bookings today 2,
  job queues incl. `job_queue Dead 76`, 5 materialized views, system health 34
  open alerts, timeline, predictive insights). **POSTs containing
  `command-center` = 5** (expected fan-out). ~16s idle → still 5, no auto-refresh
  loop, all 200. Screenshot `g08_staging_smoke_g03.png`.
- **G-05 Audit & Compliance (`/admin/audit`) — PASS.** Audit Trail Search renders
  **26 real rows** (e.g. `booking_status_change`, `compliance_check`,
  `executive_report`). Integrity cards present (not run — avoids mutation).
  Screenshot `g08_staging_smoke_g05.png`.
- **G-06 Executive Reports (`/admin/reports`) — PASS.** 6 report cards present;
  generated **Daily Hospital** once → 1× POST `enterprise-reports` (200), report
  rendered (Range `2026-09-25 → 2026-10-01`, sections SLA/DATE/QUEUES/FINANCE/
  PATIENTS/…). Screenshot `g08_staging_smoke_g06.png`.
- **G-07 Reschedule (booking detail) — PASS.** Opened an eligible `booked`
  walk-in booking; heading `Reschedule` and button `Reschedule booking` present
  alongside Cancel/Check In/No-Show. **Not clicked — nothing mutated.**
  Screenshot `g08_staging_smoke_g07.png`.

These closed workstreams were NOT reopened.

---

## 16. PRODUCTION-SAFETY CONFIRMATION (§20)

```text
Deployed:            executive-analytics → setura-staging (gzcqasntcbqqmgsoikms) ONLY
Production Supabase: untouched
Production Vercel:   untouched
Production secrets:  untouched
Production functions:untouched
Production database: untouched
```

No production target was referenced by any command executed. The only deployment
command issued was scoped with `--project-ref gzcqasntcbqqmgsoikms` (staging).
**Production untouched — PASS.**

---

## 17. ACCEPTANCE MATRIX (§21)

### Deployment
- [x] Current `executive-analytics` source verified
- [x] Only `executive-analytics` deployed
- [x] Deployment succeeded
- [x] New function version confirmed (v8 > v7)

### CORS
- [x] Staging preflight succeeds (204)
- [x] `apikey` accepted
- [x] `X-Client-Info` accepted
- [x] `Vary: Origin` present
- [x] Staging frontend origin accepted

### Backend
- [x] Global portfolio 200
- [x] Benchmarks 200
- [x] Hospital admin 403
- [x] Missing header 422
- [x] Anonymous 401

### Global Admin Browser
- [x] Login succeeds
- [x] `/admin/portfolio` accessible
- [x] Portfolio renders real data
- [x] Benchmarks render real data
- [x] Exactly intended initial network calls (1+1+1, all 200)
- [x] No service_role
- [x] Console clean
- [x] Idle (≈182s) produces no unexpected requests
- [x] Refresh creates exactly one new portfolio + benchmark cycle
- [x] No auth/remount loop

### Role Isolation
- [x] Hospital admin cannot access (redirect, 0 calls)
- [x] Receptionist cannot access (redirect, 0 calls)
- [x] Doctor cannot access (redirect, 0 calls)
- [x] Unauthorized roles produce 0 analytics browser calls

### Regression
- [x] G-03 smoke PASS
- [x] G-05 smoke PASS
- [x] G-06 smoke PASS
- [x] G-07 smoke PASS

### Production
- [x] Production untouched

**All mandatory gates PASS.**

---

## 18. LIMITATIONS

- **Vocabulary:** everything here is **PROVEN STAGING** (staging backend +
  staging browser). This is NOT production verification. Production state remains
  UNPROVEN — no production deployment was made or in scope.
- **Token-refresh path not directly exercised:** within the observation window no
  proactive token refresh was induced, so the post-refresh remount path was not
  hit directly; the auth-loop regression evidence is based on idle monitoring and
  hard-reload of a protected deep link, both clean.
- **DevTools buffer cleared mid-idle:** the browser extension cleared its network
  buffer once during the long idle window; idle-zero was therefore cross-validated
  with the in-page Performance Resource Timing API rather than the cleared buffer.
- **One browser-automation artifact:** a single login submit hit the browser's
  native empty-field validation and was retried successfully — an automation
  artifact, not an application defect (no console error, no app impact).
- **Backend analytics attribution:** portfolio-vs-benchmarks attribution on the
  initial pair was inferred from request ordering and confirmed by request-body
  capture on the refresh pair; the browser's network tool does not label the two
  identical-URL POSTs by action name directly.

---

## 19. FINAL STATUS

```text
G-08 — PROVEN STAGING — CLOSED
```

The stale `executive-analytics` staging deployment (v7, missing `apikey` /
`X-Client-Info` / `Vary: Origin` in CORS) was the sole blocker. The single
authorized redeploy brought it to v8; the preflight now succeeds, the backend
authorization matrix is intact, the global-admin browser journey renders real
server-aggregated portfolio/benchmark data with clean network/idle/refresh
behavior, unauthorized roles are route-guarded with zero analytics calls, the
auth-loop regression holds, console is clean across all roles, and the G-03 /
G-05 / G-06 / G-07 smoke checks still pass. Production was untouched.

No frontend redesign, no SQL changes, no fixture manipulation, no production
deployment, no unrelated work was performed.
