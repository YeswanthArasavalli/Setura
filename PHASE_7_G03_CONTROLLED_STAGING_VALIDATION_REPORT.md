# PHASE 7 — G-03 CONTROLLED STAGING DEPLOYMENT + VALIDATION

Phase: G-03 staging deployment and controlled, read-only staging validation.
Follows: `PHASE_7_G03_HOSPITAL_ADMIN_COMMAND_CENTRE_IMPLEMENTATION_REPORT.md`.

---

## 1. Scope

Deploy the existing (already locally proven) G-03 Hospital Admin Command Centre
frontend to the existing staging frontend, then validate it read-only against
real staging.

Staging only. No backend change. No new features. No commit. No push. No data
mutation.

**Outcome in one line:** the G-03 frontend deployed successfully to
`https://setura-delta.vercel.app` and every authorization/negative path behaves
correctly on staging, but the **hospital-admin positive data path is BLOCKED on
staging by a pre-existing backend deployment-drift defect** — the deployed
`command-center` Edge Function is an artifact older than the CORS fix in
`supabase/functions/_shared/cors.ts` (commit `79b74f7`, 2026-09-22), so its
preflight omits `apikey` and the browser refuses every Command Centre read. The
G-03 frontend source is not at fault and was NOT repaired in this phase
(§35).

## 2. Authorization

Authorized and performed: frontend deployment to the existing Vercel project;
logins; navigation; GET/read operations; invocation of the five existing
command-centre read actions; network/console/DOM inspection; deployed-bundle
inspection; read-only preflights against staging Edge Functions; role/tenant
behavior verification.

Not performed (all forbidden categories confirmed absent): booking
create/cancel/check-in/no-show/reschedule, queue mutation, patient/doctor
modification, payment, refund, fee change, hospital-settings change, WhatsApp
send/broadcast, manual worker trigger, scheduler change, secret/Vault change,
RLS/migration/Edge Function modification, user creation, auth-config change,
staging-data modification, production contact.

One out-of-band write occurred and is disclosed: `POST /auth/v1/logout?scope=global`
(204), issued by the browser session teardown of a *pre-existing* logged-in
session so the required test account could be used. It terminates an auth
session; it mutates no application data. No other non-read request was made by
the app.

## 3. Git baseline (pre-deployment, §4)

```text
git branch --show-current : main
git rev-parse HEAD        : 0ec8586b3b5b72dd4fcb06c9e5239a89103dc156
git rev-parse origin/main : 0ec8586b3b5b72dd4fcb06c9e5239a89103dc156
HEAD == origin/main       : yes ("feat: add booking status closure controls")
```

`git status --short` before deployment:

```text
 M PHASE_7_NEXT_PRODUCT_GAP_INVESTIGATION_REPORT.md
 M apps/web/src/App.tsx
 M apps/web/src/components/AppShell.tsx
 M apps/web/src/types/api.ts
?? PHASE_7_G02_COMMIT_STAGING_DEPLOYMENT_PREFLIGHT_REPORT.md
?? PHASE_7_G02_CONTROLLED_STAGING_VALIDATION_REPORT.md
?? PHASE_7_G03_HOSPITAL_ADMIN_COMMAND_CENTRE_IMPLEMENTATION_REPORT.md
?? apps/web/src/App.test.tsx
?? apps/web/src/api/commandCenter.test.ts
?? apps/web/src/api/commandCenter.ts
?? apps/web/src/routes/AdminCommandCentre.test.tsx
?? apps/web/src/routes/AdminCommandCentre.tsx
```

`git diff --stat` (tracked): `PHASE_7_NEXT_PRODUCT_GAP_INVESTIGATION_REPORT.md`
(pre-existing unrelated modification, untouched by this phase), `App.tsx` +19/−4,
`AppShell.tsx` +3, `types/api.ts` +228.

Confirmed: the G-03 implementation is exactly the expected working-tree change.
Unrelated files were not cleaned. D-COMMIT-1 was not touched.

## 4. Deployment target (verified before deploying, §7)

```text
Vercel CLI            : 59.23.2 (Node.js 24.14.1)
vercel whoami         : yeswantharasavalli
Vercel project        : setura   (prj_PZq3TlY28vzz3hF6x0TKpvxK6gMH)
Org / scope           : yeswantharasavallis-projects (team_xQHrRH4w4Z56xJ6PBuXOficc)
Project Root Directory: apps/web
Node version          : 24.x
Production URL        : https://setura-delta.vercel.app
Pre-deploy production : dpl_2yV1TnpSZVju51ddUguToFtGjiha (Ready, 7h old,
                        aliases include https://setura-delta.vercel.app)
Staging Supabase ref  : gzcqasntcbqqmgsoikms (project setura-staging)
```

No new Vercel project was created. Domain, DNS, env-var values, ownership,
deployment protection and production settings were not changed. Other projects
in the account (`setura-app`, `job-ai-system`, `road-trip-web`, `prep-os`,
`portfolio-new`, `yeswanth-projects`) were listed read-only and not touched.

## 5. Deployment result (§9)

Two attempts were needed; both are recorded.

| # | Deployment URL | ID | Result |
| --- | --- | --- | --- |
| 1 | `https://setura-nbgm8wzry-yeswantharasavallis-projects.vercel.app` | — | **Error** — build failed: `The specified Root Directory "apps/web" does not exist.` Cause: `vercel deploy` was invoked from `apps/web`, so the uploaded archive had no `apps/web` segment while the project setting Root Directory is `apps/web`. No alias was moved; `setura-delta.vercel.app` stayed on the previous Ready deployment. |
| 2 | `https://setura-3ufpc8jna-yeswantharasavallis-projects.vercel.app` | `dpl_6C79adB3hoZEdpfp5ofVdj52K81H` | **Ready** — deployed from the repository root so the archive contains `apps/web`. Build 23s. Aliased `https://setura-delta.vercel.app`. Created 2026-09-28 22:39:42 IST. |

Final deployment record:

```text
deployment ID : dpl_6C79adB3hoZEdpfp5ofVdj52K81H
status        : Ready (target production)
alias         : https://setura-delta.vercel.app
bundle hash   : assets/index-CrBJP2Vn.js (485,508 bytes)
              : assets/index-D7A4dsD3.css (identical to local build output)
deployed by   : Vercel CLI upload (local working tree), not a git push
```

No backend deployment of any kind was run: `supabase db push` and
`supabase functions deploy` were NOT executed (§9). The errored attempt #1 is an
orphan Vercel deployment record; it is not aliased and does not serve traffic.

## 6. Bundle verification (§8 / §10)

Artifacts fetched from the live alias `https://setura-delta.vercel.app`
(`index.html`, `assets/index-CrBJP2Vn.js`, `assets/index-D7A4dsD3.css`) and
inspected. Counts are literal occurrence counts in the deployed artifacts.

| Check | Finding | Class |
| --- | --- | --- |
| G-03 strings | `Command Centre` ×1, `Operational Overview` ×1, `SLA Dashboard` ×1, `System Health` ×1, `Operational Timeline` ×1, `Predictive Insights` ×1, `Last updated` ×1 | PROVEN STAGING |
| `/admin` route | `path:"/admin"` ×1 | PROVEN STAGING |
| Five read actions | `"overview"`, `"timeline"`, `"predictive"`, `"sla_dashboard"`, `"system_health"` — each present exactly once | PROVEN STAGING |
| `broadcast_*` invocation | 0 occurrences of any `broadcast_` action string. The 57 `BROADCAST`/`broadcast` hits are all supabase-js Realtime library internals (`userBroadcastPush`, `broadcast:{ack,self}`, `broadcastEndpointURL`) plus the substring `/api/broadcast` inside that library — no command-centre action | PROVEN STAGING |
| Service-role credential | `service_role` ×0; `SUPABASE_SERVICE_ROLE_KEY` ×0; `"role":"service_role"` ×0 | PROVEN STAGING |
| Provider secrets | `RAZORPAY` ×0, `META_APP_SECRET` ×0, `CRON_SECRET` ×0, `WORKER_SECRET` ×0, `sk_test` ×0, `rzp_secret` ×0 | PROVEN STAGING |
| `sb_secret_` | 1 occurrence, verbatim context `e.startsWith("sb_publishable_")||e.startsWith("sb_secret_")` — the supabase-js API-key *prefix detector*, not a key value. No `sb_secret_<material>` string exists | PROVEN STAGING |
| Supabase URL | exactly one project origin: `https://gzcqasntcbqqmgsoikms.supabase.co` (staging ref). No production Supabase URL, no other project origin | PROVEN STAGING |
| Anon key | one `sb_publishable_…` value (46 chars) is inlined. It is a different key from the local dev stack's publishable key, and the browser session subsequently authenticated successfully against `gzcqasntcbqqmgsoikms` — which only happens if the key belongs to that project | PROVEN STAGING (runtime-matched). CLI cross-check of the key value was BLOCKED (no `supabase projects api-keys` credential); that path is unnecessary given the runtime proof |
| Localhost URL | the literal `http://localhost:9999` occurs once, inside the bundled supabase-js GoTrue client as its built-in default endpoint constant, and `localhost`/`127.0.0.1` again inside the library's PKCE allow-list helper. Neither is app configuration: the app's inlined `VITE_SUPABASE_URL` is the staging origin. Classified STATICALLY VERIFIED (library-internal default), NOT an app-configured localhost endpoint | STATICALLY VERIFIED |
| Source maps | 0 `.map` requests satisfied; 0 `sourceMappingURL` references in the deployed JS | PROVEN STAGING |
| Secret scanner against the deployed bundle | `deno run --allow-read scripts/check_frontend_secrets.ts .remember/tmp/g03bundle --deny-sourcemaps` → `3 artifact(s) … 0 secret hit(s), 0 source map(s) (sourcemaps denied)`, exit 0 | PROVEN STAGING |

## 7. Hospital-admin validation — TEST A (§12)

Executed in a real browser against `https://setura-delta.vercel.app` with the
seeded account `admin@surya.test`.

| Item | Observed | Class |
| --- | --- | --- |
| Landing after login | `https://setura-delta.vercel.app/admin` | PROVEN STAGING |
| Identity surface | role badge `hospital admin`, name `Surya Hospital Admin`, tenant `00000000-0000-4000-8000-000000000001` (roles resolved via `GET /rest/v1/user_roles?…user_id=eq.…0a2` → 200) | PROVEN STAGING |
| Navigation | `Command Centre` present and targets `/admin`, alongside the retained reception/doctor entries (8 items) | PROVEN STAGING |
| Page heading | `Command Centre`, sub-line `Read-only operational overview · Surya Hospital Admin · tenant 00000000-0000-4000-8000-000000000001` | PROVEN STAGING |
| Five sections | All five headings render in order: Operational Overview, SLA Dashboard, System Health, Operational Timeline, Predictive Insights | PROVEN STAGING |
| Loading state resolves | Yes — no permanent spinner; every section settled into its error state | PROVEN STAGING |
| Data rendering | **FAIL on staging.** Every section body shows the single string `Cannot reach the server. Check your connection.`; zero metric tiles, zero SLA values, zero health rows, zero timeline events, zero predictive values rendered | NOT OBSERVED |
| Fake zeros | None fabricated. The failure path shows an error, not `0` — the surface did not invent data | PROVEN STAGING |
| `[object Object]` / `undefined` / `null` leakage | 0 occurrences in the visible `innerText` (1,096 chars) | PROVEN STAGING |
| Read-only surface | The `<main>` region exposes exactly two controls: `Sign out` (header) and `Refresh`. No Broadcast / Cancel / Refund / Check-in / Reschedule / Resolve / Retry-job control exists | PROVEN STAGING |

The five-section skeleton, freshness control, error state and no-leak behaviour
therefore ARE proven on staging; the value-rendering assertions of §12 are NOT
OBSERVED because no read ever completed in the browser.

## 8. Command-centre network proof (§13)

Every request the page made to `/functions/v1/command-center`, with the order
captured by an in-page fetch interceptor:

```text
Round 1 (mount)      OPTIONS ×5 -> 204   POST ×5 -> net::ERR_FAILED
Round 2 (Refresh)    OPTIONS ×6 -> 204   POST ×5 -> net::ERR_FAILED
Round 3 (reload)     OPTIONS ×5 -> 204   POST ×5 -> net::ERR_FAILED
```

POST bodies, verbatim and in order, exactly the five permitted reads:

```json
{"action":"overview"}
{"action":"sla_dashboard"}
{"action":"system_health"}
{"action":"timeline"}
{"action":"predictive"}
```

No body carried any field other than `action`. Hospital context travelled only
in the `X-Hospital-ID` header set by `callFunction` from the session.

Successes: **0 of 15 POSTs.** Preflights returned 204 with
`Access-Control-Allow-Origin: https://setura-delta.vercel.app`, but
`Access-Control-Allow-Headers` did not list `apikey`, so Chrome refused the
actual POST.

| Forbidden category | Calls observed |
| --- | --- |
| `broadcast_*` | 0 |
| payment | 0 |
| refund | 0 |
| booking mutation | 0 |
| queue mutation | 0 |
| WhatsApp | 0 |
| scheduler / worker | 0 |

React StrictMode duplication: local dev shows one duplicate initial read round;
on this staging build the mount round and a later round are separated by an
explicit Refresh and a navigation reload, so the extra rounds are user-triggered,
not StrictMode. Implementation left unchanged (§13 instruction).

### 8.1 Root cause (runtime evidence, read-only preflight)

```text
OPTIONS https://gzcqasntcbqqmgsoikms.supabase.co/functions/v1/command-center
  Origin: https://setura-delta.vercel.app
  Access-Control-Request-Method: POST
  Access-Control-Request-Headers: apikey,authorization,content-type,x-client-info,x-hospital-id
=> 204
   Access-Control-Allow-Origin   : https://setura-delta.vercel.app
   Access-Control-Allow-Credentials: true
   Access-Control-Allow-Headers  : Authorization, Content-Type, Idempotency-Key,
                                   X-Correlation-ID, X-Request-ID, X-Hospital-ID
                                   <-- no "apikey", no "X-Client-Info"
   Access-Control-Allow-Methods  : GET, POST, PUT, PATCH, DELETE, OPTIONS

Same preflight against /functions/v1/create-booking:
   Access-Control-Allow-Headers  : Authorization, Content-Type, Idempotency-Key,
                                   X-Correlation-ID, X-Request-ID, X-Hospital-ID,
                                   apikey, X-Client-Info        <-- fixed
```

Current source `supabase/functions/_shared/cors.ts` lines 20–31 emits the fixed
list including `apikey` and `X-Client-Info`, with the comment that supabase-js
always sends them cross-origin. The fix landed in commit `79b74f7`
("Fix doctor directory and CORS issues", 2026-09-22), which IS an ancestor of
`HEAD` (verified with `git merge-base --is-ancestor`, exit 0).

Scope census on staging (27 Edge Functions in the repo; read-only OPTIONS only):

| Function | `apikey` in Allow-Headers |
| --- | --- |
| `command-center` | MISSING |
| `create-booking` | present |
| `doctor-operations` | present (proven by two successful browser POSTs, TEST C) |
| `cancel-booking`, `update-booking-status`, `queue-next-patient`, `enterprise-reports`, `financial-command-center`, `executive-analytics`, `alert-center`, `send-whatsapp-message`, `run-background-worker` | MISSING |

Conclusion: this is **staging Edge-Function deployment drift** — a mixture of
post-fix and pre-fix artifacts — not a G-03 frontend defect. The deployed
`command-center` artifact predates `79b74f7`.

**Fix (NOT applied here; requires explicit authorization):** redeploy the stale
Edge Functions to `gzcqasntcbqqmgsoikms` (`supabase functions deploy
command-center …`) so they pick up the current `_shared/cors.ts`. Redeploying is
a backend modification and is forbidden by §3/§9/§35, so G-03 stops at this
finding.

### 8.2 Backend reads themselves are healthy on staging

To separate "backend broken" from "browser boundary broken", the same five reads
were invoked directly against staging over HTTP (non-browser, so CORS does not
apply) as `admin@surya.test` with `X-Hospital-ID: …0001`. Read-only; no mutation.

```text
overview        success=true  data keys: action|overview|scores
sla_dashboard   success=true  data keys: action|sla
system_health   success=true  data keys: action|health
timeline        success=true  data keys: action|timeline
predictive      success=true  data keys: action|predictions
```

Representative staging payload (quoted as returned; not recomputed):

```text
overview.date                       2026-09-28
overview.generated_at               2026-09-28T17:37:31.969473+00:00
overview.hospital_id                00000000-0000-4000-8000-000000000001
overview.sla                        NULL (absent)
scores.health_score                 75
scores.congestion_score             100
scores.patient_experience_score     100
scores.delay_score                  0
scores.risk_score                   0
scores.inputs                       waiting=0, capacity=0, active_sessions=0,
                                    open_alerts_24h=0, avg_wait_minutes=NULL,
                                    delayed_sessions=0
sla.date                            2026-09-28
sla.hospitals_in_breach             [] (0 rows)
sla.trend_14d                       [] (0 rows)
health keys                          deadLetterQueue | materializedViews |
                                    openAlerts | queueHealth
timeline keys                        events | from | hospital_id | to
```

Class: PROVEN STAGING at the API boundary (backend returns real, tenant-correct
data), while the same data is NOT OBSERVED through the browser because of §8.1.
This is also the exact NULL-vs-zero distinction §15 asks about: `avg_wait_minutes`
and `overview.sla` arrive as NULL while `waiting`/`capacity` arrive as real 0 —
the UI's separation of those two renderings therefore remains NOT OBSERVED on
staging.

## 9. Refresh validation (§14)

```text
before click : [data-testid="last-updated"] = "Not yet fetched"
action       : Refresh clicked exactly once
after click  : "Not yet fetched"  (did NOT advance)
reads        : a NEW round of exactly five POSTs fired, bodies overview,
               sla_dashboard, system_health, timeline, predictive
               -> all net::ERR_FAILED
mutations    : 0
console      : 5 more CORS errors + 5 more net::ERR_FAILED, no new error type
determinism  : a plain reload reproduced the identical failure
               (5 OPTIONS 204 + 5 POST ERR_FAILED)
```

Correct client behaviour, and the anti-fabrication rule held: `lastUpdated` is
stamped only when at least one read fulfils (`AdminCommandCentre.tsx` L136–138),
so a fully failed round honestly reports "Not yet fetched" instead of a fake
freshness time. Refresh re-issues reads and nothing else — it is not a mutation.

Class: the *mechanism* (re-query all five, no mutation, honest timestamp) is
PROVEN STAGING; the *success* variant required by §33 (timestamp advances, five
reads succeed) is FAIL on staging — blocked by §8.1.

## 10. Operational Overview / SLA / System Health / Timeline / Predictive (§15–§19)

| Section | Staging result |
| --- | --- |
| Operational Overview values originate from backend | NOT OBSERVED (no values rendered; reads blocked) |
| NULL not presented as zero | NOT OBSERVED in UI. The backend side is proven to return both NULLs and real zeros (§8.2), and the unit tests that pin this distinction passed locally this phase |
| SLA summary / tracked / breach / avg breach wait / table / trend | NOT OBSERVED. Backend read succeeds and returns `hospitals_in_breach=[]`, `trend_14d=[]` for 2026-09-28 — an empty, not a zero, dataset |
| System Health alerts / queue / MVs / DLQ | NOT OBSERVED. Backend read succeeds and returns the four expected groups |
| Timeline events / timestamps / category / severity / conditional entity | NOT OBSERVED. Backend read succeeds and returns `events`, `from`, `to`, `hospital_id` |
| Predictive values rendered faithfully | NOT OBSERVED. Backend read succeeds and returns `predictions` |

No SLA or predictive value was computed in the browser or by hand; nothing was
compared against a fabricated expectation. No claim is made about prediction
quality, forecasting correctness or business recommendation — none was tested.

## 11. Receptionist negative — TEST B (§20)

| Check | Observed | Class |
| --- | --- | --- |
| Lands on `/reception` | yes — `https://setura-delta.vercel.app/reception`, badge `receptionist`, name `Ravi Kumar`, tenant `…0001`, `<h1>` `Welcome, Ravi Kumar` | PROVEN STAGING |
| Command Centre nav absent | exact labels: `Dashboard`, `Appointment`, `Walk-in`, `Patients`, `Notifications`, `Queue / Tokens` — no Command Centre | PROVEN STAGING |
| Direct `/admin` rejected | SPA redirected back to `/reception`; no Command Centre heading or section rendered | PROVEN STAGING |
| Network proof | `/functions/v1/` requests during the whole session: **0**; command-center: **0**; mutations: **0** (all app traffic was GET on `/rest/v1` plus the auth token POST) | PROVEN STAGING |
| Console | clean — no messages at all, no CORS error | PROVEN STAGING |

## 12. Doctor negative — TEST C (§21)

| Check | Observed | Class |
| --- | --- | --- |
| Lands on `/doctor` | yes — badge `doctor`, name `Dr. Anitha Rao`, tenant `…0001`, `<h1>` `Doctor console`, state `No session active` | PROVEN STAGING |
| Command Centre nav absent | single item `Doctor Console` | PROVEN STAGING |
| Direct `/admin` rejected | redirected to `/doctor`; no Command Centre render | PROVEN STAGING |
| command-center requests | **0** | PROVEN STAGING |
| Other function traffic | `POST /functions/v1/doctor-operations` ×2 → **200**, both the Doctor Console's automatic on-load `action:"dashboard"` read (`apps/web/src/api/doctorOps.ts` L27–28). Not a mutation; no action button was pressed and the UI stayed `No session active`. This is also the positive control that the CORS defect is per-function, not global | PROVEN STAGING |
| Console | clean | PROVEN STAGING |

## 13. Global-admin validation — TEST D (§22)

| Check | Observed | Class |
| --- | --- | --- |
| Login | `root@setura.test` → lands on `/admin`, badge `global admin`, name `Setura Root Admin`, tenant field displays `no tenant` | PROVEN STAGING |
| Command Centre visible in nav | yes (nav shows all 8 items incl. Command Centre) — expected, since the admin surface mirrors the backend `hospital_admin | global_admin` gate | PROVEN STAGING |
| No-tenant state | `<main>` renders exactly `No hospital tenant is attached to your account.`; no `<h1>`; no hospital selector; none of the five sections | PROVEN STAGING |
| No hospital-scoped call without a tenant | `/functions/v1/` requests: **0**; command-center: **0**; mutations: **0**; console clean | PROVEN STAGING |
| Tenant-bearing global-admin data path | NOT OBSERVED — the seeded staging account has no hospital tenant. Nothing was invented and the account was not modified | NOT OBSERVED |

No hospital selector was introduced. `GLOBAL ADMIN COMMAND-CENTRE DATA:
NOT OBSERVED — seeded account has no hospital tenant`.

## 14. Tenant / authorization validation (§23)

Frontend (STATICALLY VERIFIED + observed):
`AdminCommandCentre.tsx` takes `hospitalId` only from `useAuth()` (the
authenticated session), guards with `if (!hospitalId) return;` before any load
and renders the no-tenant message instead of fetching. There is no
`useParams`/`useSearchParams` in the surface, `/admin` accepts no query or path
parameter, and no request body carries a hospital id — the tenant travels only
in the `X-Hospital-ID` header that `callFunction` sets from the session.
Observed on staging: the tenant string displayed equals the JWT's own tenant,
and a no-tenant session issues zero hospital-scoped calls.

Backend boundary (PROVEN STAGING, read-only, no mutation):

```text
admin of tenant …0001, X-Hospital-ID: …0002 (cross-tenant)  -> 403 denied
admin of tenant …0001, X-Hospital-ID absent                  -> 422 denied
```

Existing backend cross-tenant evidence cited rather than re-created:
`tests/integration/enterprise_command_center.test.ts` cases
`financial isolation between tenants` and
`timeline streams fired alerts with filters and isolation` — both executed and
passed this phase (§15 below).

## 15. Role / tenant matrix (§24)

| Actor | Expected route | Observed route | Command Centre visible | Command Centre requests |
| --- | --- | --- | --- | --- |
| hospital_admin | `/admin` | `/admin` | YES | 5 reads per round, all `net::ERR_FAILED` (0 succeeded) |
| global_admin | `/admin` or documented no-tenant state | `/admin`, no-tenant state | YES (nav) / no sections | 0 (correct: no tenant) |
| receptionist | `/reception` | `/reception` (`/admin` → redirected) | NO | 0 |
| doctor | `/doctor` | `/doctor` (`/admin` → redirected) | NO | 0 |

## 16. Network audit (§26) — whole-session totals

```text
0 booking mutations          0 cancellation mutations
0 check-in mutations         0 no-show mutations
0 queue mutations            0 payment calls
0 refund calls               0 WhatsApp calls
0 broadcast calls            0 scheduler calls
0 worker calls
```

Only auth requests (`/auth/v1/token` password+refresh, `/auth/v1/logout`
teardown), read requests (`/rest/v1/profiles`, `/rest/v1/user_roles`,
`/rest/v1/bookings` — all 200), command-center read POSTs (blocked by §8.1), and
the Doctor Console's automatic `doctor-operations` dashboard read (200). The
`auth/v1/logout` scope=global calls are session teardown, disclosed in §2.

## 17. Console audit (§25)

Hospital admin `/admin`: 20 errors in two paired sets, all two verbatim
repeating patterns —

```text
Access to fetch at 'https://gzcqasntcbqqmgsoikms.supabase.co/functions/v1/command-center'
from origin 'https://setura-delta.vercel.app' has been blocked by CORS policy:
Request header field apikey is not allowed by Access-Control-Allow-Headers in
preflight response.                                             (×10)
Failed to load resource: net::ERR_FAILED                        (×10)
```

Plus 5 more of each after the reload reproduction. These are the app-originated
failures of this phase and are the §8.1 defect, not a console-noise artefact.

Receptionist, doctor and global-admin sessions: **0 console messages** — no
errors, no warnings, no CORS entries.

React Router future-flag warnings appeared in the local Vitest run only
(`v7_startTransition`, `v7_relativeSplatPath`) and were not observed in the
staging browser console window. 304 cache responses on document navigation were
excluded from failure counting per §25.

## 18. Screenshot status (§27)

```text
SCREENSHOTS BLOCKED — ENVIRONMENT
NATIVE_BROWSER_VIEWPORT_UNAVAILABLE: Native Browser did not become visible with
a positive viewport within 1000ms (viewport=833x687, visible=false,
attached=false, cdpAttached=true, visibilityState=hidden)
```

All four requested captures (hospital-admin Command Centre, global-admin state,
receptionist blocked state, doctor blocked state) failed identically, including
`fullPage` JPEG retries. No image was produced and none was fabricated. DOM /
accessibility snapshots plus the network audit above are the substitute
evidence. This is an environment condition, not a product failure.

## 19. Security / bundle scan

See §6. Both the ad-hoc marker sweep and the repository's own gate
(`scripts/check_frontend_secrets.ts --deny-sourcemaps`) were run against the
**deployed** artifacts and returned 0 hits / 0 source maps, exit 0. The staging
publishable/anon key is the only credential class present, as allowed. No secret
value is printed in this report.

## 20. Mutation-safety verification (§28)

No staging row was created, changed or deleted by this phase. The only non-GET
application requests were auth token/logout calls, the (blocked) Command Centre
reads, and the Doctor Console's automatic dashboard read. No test booking was
created or cancelled, no check-in/no-show, no queue change, no payment/refund, no
patient/hospital/settings modification. Anything that would need a mutation to
prove is recorded as `NOT TESTED — MUTATION NOT AUTHORIZED`; none was needed for
the assertions made here.

## 21. Regression results (§6, §30)

Executed this phase, this session:

| Command | Result |
| --- | --- |
| `npm run typecheck` (`tsc --noEmit`) | PASS, 0 errors |
| `npm test` (Vitest, full suite) | **PASS 170/170 across 16 files** |
| `npx vitest run` on the three G-03 files, re-run after deployment | **PASS 25/25** (`commandCenter.test.ts` 6, `AdminCommandCentre.test.tsx` 12, `App.test.tsx` 7) |
| `npm run build` | PASS — 119 modules, `dist/assets/index-CKUySAMz.js` 485.55 kB, 0 source maps |
| `deno run --allow-read scripts/check_frontend_secrets.ts --deny-sourcemaps` (local dist) | PASS — 3 artifacts, 0 secret hits, 0 source maps |
| Same scan against the **deployed** bundle | PASS — 0 hits, 0 source maps |
| `deno test --allow-net --allow-env --allow-run tests/integration/enterprise_command_center.test.ts` (local stack) | **PASS 23/23**, including `ent http: command-center overview and timeline`, `ent http: auth gates enforce roles and portfolio scope`, `financial isolation between tenants` |

Post-deployment source check: `git diff --check` exit 0 (no whitespace/damage),
`git diff --stat -- apps/web/src` byte-identical to the pre-deployment record
(+19/+3/+228), working tree unchanged (§23). Per §30 the full pre-deployment trio
was therefore not repeated a second time except the targeted G-03 suites.

Not repaired (pre-existing, unrelated, §6): `deno fmt --check` root-markdown
failures; `supabase db diff` shadow-DB tooling failure. No file was reformatted
to make this phase green.

## 22. Known limitations

1. The five value-rendering assertions (§15–§19) could not be observed through
   the staging browser because of the deployed-artifact CORS defect (§8.1). The
   behavior itself remains PROVEN LOCAL (implementation report §15) and
   INTEGRATION VERIFIED; it is not downgraded to "broken".
2. Screenshots BLOCKED — ENVIRONMENT (hidden native viewport, no pixels).
3. Browser automation caveats: `click`/`fill` timed out against the SPA in the
   hidden viewport, so sign-in/sign-out/the Refresh click were dispatched through
   in-page DOM events on the real React-controlled elements and the page's own
   submit button — the app's genuine auth path was exercised. Recorded because it
   affects how the interactions were driven, not what they proved.
4. Global-admin-with-tenant data path NOT OBSERVED (seeded account has no
   tenant).
5. Staging API-key value could not be cross-checked via `supabase projects
   api-keys` (no CLI credential); resolved by the runtime authentication proof
   in §6 instead.
6. Whether the other stale Edge Functions (§8.1 census) break their own browser
   flows was NOT TESTED — exercising them would require mutation-capable calls.
   Only their preflight headers were read.
7. Local-environment results are not production verification. Nothing here is
   production evidence.

## 23. Backend unchanged proof (§5 / §31.25)

```text
git status --short -- supabase/   -> (no output)
git diff --stat  -- supabase/     -> (no output)
```

`supabase/` is untouched: no migration added or edited, no SQL/RLS/grant change,
no Edge Function source change, no `command-center/index.ts` edit, no type
regeneration. No `supabase db push`, `functions deploy`, `db reset` or `db serve`
was run by this phase. The five read wrappers in
`apps/web/src/api/commandCenter.ts` are exactly `overview`, `timeline`,
`predictive`, `sla_dashboard`, `system_health`; no wrapper exists for any
`broadcast_*` action (the only `broadcast` strings in `src` are the negative
assertions in `AdminCommandCentre.test.tsx` L353 and comments), and no new
command-centre action was added. The 403/422 denials in §14 are therefore
observations of the pre-existing deployed backend, not of a change made here.

## 24. Production boundary (§26 of the phase list)

Production was not touched. Every Supabase call in this phase targeted the
staging ref `gzcqasntcbqqmgsoikms`; the deployment targeted only the existing
`setura` Vercel project and its existing `setura-delta.vercel.app` alias. No
production Supabase project, key, secret, Vault entry, function or database was
addressed; no production deployment was promoted beyond moving the staging
project's own alias as the existing deployment model does. The other Vercel
projects in the account were not deployed to.

## 25. Git state (§29)

```text
git status --short   : identical to §3 (G-03 source changes still uncommitted)
git rev-parse HEAD   : 0ec8586b3b5b72dd4fcb06c9e5239a89103dc156
git rev-parse origin/main : 0ec8586b3b5b72dd4fcb06c9e5239a89103dc156
```

No commit, no push, no amend, no rebase, no force push, no unrelated file
cleaned, no history rewrite. HEAD still equals origin/main — nothing reached
GitHub, so nothing could auto-deploy from git. The only filesystem writes outside
tracked source were the report file itself and throwaway bundle artifacts under
the already-ignored `.remember/tmp/g03bundle/` (index.html, bundle.js,
index.css), which do not appear in `git status`.

## 26. Final classification (§32–§33)

```text
G-03 COMMAND CENTRE FRONTEND DEPLOYED TO STAGING ........ PROVEN STAGING
G-03 /admin ROUTING + NAV VISIBILITY (hospital_admin) ... PROVEN STAGING
G-03 FIVE-SECTION SKELETON, ERROR STATES, NO LEAK ....... PROVEN STAGING
G-03 READ-ONLY SURFACE / ZERO MUTATIONS ................. PROVEN STAGING
G-03 REFRESH MECHANISM (re-reads 5, no mutation,
     honest "Not yet fetched") .......................... PROVEN STAGING
G-03 LIVE DATA RENDERING (overview/SLA/health/timeline/
     predictive values) on staging browser .............. BLOCKED — ENVIRONMENT
                                                        (deployed Edge Function
                                                        artifact staleness, §8.1)
G-03 REFRESH SUCCESS VARIANT (timestamp advances) ...... FAIL ON STAGING (same cause)
G-03 COMMAND-CENTRE READS AT API BOUNDARY (staging) ..... PROVEN STAGING
BACKEND COMMAND-CENTRE READS ON STAGING DATA ............ PROVEN STAGING
RECEPTIONIST NEGATIVE ................................... PROVEN STAGING
DOCTOR NEGATIVE ......................................... PROVEN STAGING
GLOBAL ADMIN NO-TENANT STATE ............................ PROVEN STAGING
GLOBAL ADMIN WITH-TENANT DATA ........................... NOT OBSERVED
TENANT ISOLATION (frontend derivation) .................. STATICALLY VERIFIED
TENANT ISOLATION (backend cross-tenant denial, staging) . PROVEN STAGING (403 / 422)
NETWORK SAFETY (0 mutations / 0 broadcast) .............. PROVEN STAGING
CONSOLE ................................................. FAIL ON STAGING
                                                        (10+10 CORS/ERR_FAILED, §17)
SECURITY / BUNDLE SCAN .................................. PROVEN STAGING (clean)
SCREENSHOTS ............................................. BLOCKED — ENVIRONMENT
BACKEND / MIGRATIONS / RLS / EDGE FUNCTIONS ............. UNCHANGED
PRODUCTION .............................................. NOT TOUCHED
```

**§33 gate check:** "PROVEN STAGING" requires deployment success **and** live
hospital-admin staging data rendering **and** five successful reads **and**
timestamp-advancing refresh **and** a clean console. Deployment succeeded and all
authorization/negative conditions passed, but four of those conjuncts are
blocked by one root cause (§8.1) that lies in the deployed backend artifact, which
this phase is forbidden to change.

> **G-03: PARTIAL — PROVEN STAGING for authorization, routing, read-only safety,
> bundle security and the no-tenant state; BLOCKED — ENVIRONMENT (staging
> Edge-Function CORS deployment drift, §8.1) for live data rendering, refresh
> success and console cleanliness. NOT certified, NOT production-verified.**

**Defect discovered, documented, NOT fixed (per §35):** staging
`command-center` (and eight other Edge Functions) carry a pre-`79b74f7` CORS
artifact whose `Access-Control-Allow-Headers` omits `apikey`/`X-Client-Info`, so
every browser-origin POST from `setura-delta.vercel.app` to those functions is
blocked at preflight. Suggested next-phase authorization: redeploy the stale
functions to `gzcqasntcbqqmgsoikms`, then re-run TEST A (§12–§19) and the console
audit unchanged. No G-03 frontend change is indicated by this phase's evidence.

STOP. Nothing further was started: no fix, no commit, no push, no backend/SQL/
RLS/function/secret/data/production modification, no next product-gap
investigation.

---

## 27. Mandatory final block

```text
CURRENT BASELINE:
0ec8586b3b5b72dd4fcb06c9e5239a89103dc156

STAGING:
setura-staging / gzcqasntcbqqmgsoikms

STAGING FRONTEND:
https://setura-delta.vercel.app

G-03:
PARTIAL — authorization/routing/safety PROVEN STAGING; live-data rendering BLOCKED

HOSPITAL ADMIN:
PROVEN STAGING (login -> /admin, Command Centre nav, 5 sections render, no leak, read-only)

COMMAND-CENTER OVERVIEW:
NOT OBSERVED in browser — BLOCKED (stale Edge Function CORS); backend read PROVEN STAGING

SLA DASHBOARD:
NOT OBSERVED in browser — BLOCKED (same cause); backend read returns 2026-09-28, 0 breaches

SYSTEM HEALTH:
NOT OBSERVED in browser — BLOCKED (same cause); backend read returns DLQ/MV/alerts/queue

TIMELINE:
NOT OBSERVED in browser — BLOCKED (same cause); backend read returns events window

PREDICTIVE:
NOT OBSERVED in browser — BLOCKED (same cause); backend read returns predictions

REFRESH:
MECHANISM PROVEN STAGING (5 re-reads, 0 mutations, honest "Not yet fetched"); SUCCESS VARIANT FAIL ON STAGING

RECEPTIONIST:
PROVEN STAGING (lands /reception, no Command Centre nav, /admin redirected, 0 command-center calls, clean console)

DOCTOR:
PROVEN STAGING (lands /doctor, no Command Centre nav, /admin redirected, 0 command-center calls, clean console)

GLOBAL ADMIN:
PROVEN STAGING — no-tenant state rendered verbatim, 0 hospital-scoped calls; with-tenant data NOT OBSERVED

TENANT ISOLATION:
PROVEN STAGING at backend (cross-tenant read 403, missing header 422); frontend session-derived tenant STATICALLY VERIFIED

NETWORK SAFETY:
PROVEN STAGING — 0 booking/cancel/check-in/no-show/queue/payment/refund/WhatsApp/broadcast/scheduler/worker calls

CONSOLE:
FAIL ON STAGING — 20 CORS/ERR_FAILED entries (10 per read round x2), all from the single §8.1 cause; other roles clean

SCREENSHOTS:
BLOCKED — ENVIRONMENT (native viewport unavailable; none fabricated)

SECURITY SCAN:
PROVEN STAGING — deployed bundle clean (0 secret hits, 0 source maps, staging URL + publishable key only)

BACKEND:
UNCHANGED

MIGRATIONS:
UNCHANGED

RLS:
UNCHANGED

FINANCIAL:
NO MUTATION

WHATSAPP:
NO CALLS

BROADCAST:
NO CALLS

PRODUCTION:
NOT TOUCHED

GIT:
HEAD == origin/main == 0ec8586; no commit, no push, no amend, no rebase; G-03 source changes remain uncommitted; supabase/ clean

FINAL STATUS:
PARTIAL — G-03 NOT PROVEN STAGING END-TO-END; blocked by staging Edge-Function CORS deployment drift (missing apikey in Access-Control-Allow-Headers on command-center). Defect documented, not fixed. STOP.
```
