# PHASE 7 — G-03 CORS DEPLOYMENT-DRIFT REMEDIATION + CONTROLLED STAGING REVALIDATION

Scope of this phase (narrow): fix the already-proven staging Edge-Function
**deployment drift** that blocked the G-03 Command Centre browser CORS path, then
re-run the G-03 controlled staging validation. No redesign, no new features, no
frontend change (no frontend defect was proven), no commit, no push, no
production contact.

Follows: `PHASE_7_G03_HOSPITAL_ADMIN_COMMAND_CENTRE_IMPLEMENTATION_REPORT.md`
and `PHASE_7_G03_CONTROLLED_STAGING_VALIDATION_REPORT.md` (authoritative for the
prior PARTIAL outcome).

**Outcome in one line:** the stale `command-center` artifact on staging was
redeployed from the already-fixed source; the deployed preflight now returns
`apikey` + `X-Client-Info` (+ `Vary: Origin`); the browser completes all five
Command Centre reads with HTTP 200 and renders real live backend values with the
NULL-vs-zero distinction preserved; every negative/authorization path, tenant
isolation, bundle security and the full regression suite pass.

> **G-03: PROVEN STAGING — CORS remediation PASS; live hospital-admin data
> rendering, refresh, console, tenant isolation and read-only safety all proven on
> staging. NOT certified, NOT production-verified.**

---

## 1. Scope

Redeploy the existing (unmodified) `command-center` implementation to staging so
it picks up `_shared/cors.ts`, then re-run the G-03 controlled staging
validation unchanged. No SQL/RLS/migration/secret/Vault/frontend-source change.

## 2. Authorization

Performed: Supabase Edge Function deployment to **staging** (`command-center`
only); read-only `OPTIONS` preflights; read-only HTTP command-centre reads;
browser validation (logins, navigation, GETs, the five existing read actions,
the Command Centre `Refresh` control); network/console/DOM inspection; deployed
bundle inspection; regression.

Not performed (all forbidden categories confirmed absent): production deploy /
Supabase / DB; migration / SQL / RLS / schema / auth-config / Vault / secret
change; payment / refund / booking create-cancel-checkin-noshow / queue /
patient / doctor / settings / fee mutation; WhatsApp send / broadcast; manual
worker / scheduler change; user creation; frontend redesign; new G-03
functionality; commit / push / amend / rebase / force push.

No mutation of staging application data occurred. The only writes this phase
issued were (a) the Supabase **function-code redeploy** to staging — the
authorized remediation — and (b) auth token/logout calls made by the browser
during logins, which are session operations, not application-data mutations.

## 3. Baseline (verified — differs from the phase brief's stated baseline)

```text
git rev-parse HEAD        : 0cb2800d27bd5b0b920006530ca82f22300b0402
git rev-parse origin/main : 0cb2800d27bd5b0b920006530ca82f22300b0402
HEAD == origin/main       : YES
commit subject            : "Add Admin Command Centre (G-03) frontend & reports"
git status --short        : (clean — no modified/untracked files before the report)
git diff --stat supabase/ : (empty)
```

The phase brief (§1/§8/§26) states a baseline of `0ec8586…` with the G-03 frontend
**uncommitted**. Actual state: the working tree **is** now a Git repository whose
HEAD is `0cb2800` — one commit ahead of `0ec8586`; `0ec8586` is HEAD's parent and
is an ancestor (verified). The G-03 frontend changes that the prior validation
phase left uncommitted were **committed in `0cb2800`**. This discrepancy is
disclosed per the AGENTS.md self-report discipline; it does not change the task
outcome (source of the fix present, `supabase/` clean, CORS-fix commit is an
ancestor). `supabase/` contains no uncommitted changes, which is what §8 requires
for a safe redeploy.

```text
git merge-base --is-ancestor 79b74f7 HEAD : exit 0 (CORS fix "Fix doctor directory
                                              and CORS issues" IS an ancestor)
```

## 4. Existing CORS source verification (§9)

`supabase/functions/_shared/cors.ts` emits, in `Access-Control-Allow-Headers`:
`Authorization, Content-Type, Idempotency-Key, X-Correlation-ID, X-Request-ID,
X-Hospital-ID, apikey, X-Client-Info` — `apikey` and `X-Client-Info` present, plus
`Vary: Origin` and fail-closed origin handling.

`supabase/functions/command-center/index.ts` imports `handleCors`
(line 24) and calls it for `OPTIONS` (lines 163–164), returning the shared
headers. Confirmed: the current working tree matches the already-proven fixed
implementation, so — per §5/§9 — the source was **NOT** modified. The only defect
was that the deployed staging artifact predated this source.

`ALLOWED_ORIGINS` is read at runtime from `Deno.env` (a function secret), and the
staging preflight already echoes `https://setura-delta.vercel.app`, so the origin
allow-list is configured server-side and persists across a code-only redeploy. No
secret change was needed or made.

## 5. Pre-deployment preflight (§10) — drift confirmed live

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
                                   <-- NO apikey, NO X-Client-Info (stale pre-fix artifact)
```

This reproduces the §8.1 root cause of the prior validation report exactly.

## 6. Deployment performed (§11)

```text
command   : supabase functions deploy command-center
function  : command-center
target    : gzcqasntcbqqmgsoikms  (setura-staging, the CLI-linked project)
result    : SUCCESS — "Deployed Functions on project gzcqasntcbqqmgsoikms: command-center"
script    : 210.5 kB
timestamp : 2026-09-29 12:29 UTC (CLI, no error)
```

Only `command-center` was deployed — the minimum required to close the G-03
browser path. `supabase db push` / `migration` were NOT run; no SQL, RLS or
secret was changed; production was NOT targeted. **The other stale functions
were deliberately NOT redeployed** (see §16 / Remaining limitations).

## 7. Post-deployment preflight (§12) — remediation successful

```text
OPTIONS (identical request to §5)
=> 204
   Access-Control-Allow-Origin   : https://setura-delta.vercel.app
   Access-Control-Allow-Credentials: true
   Vary                           : Accept-Encoding, Origin
   Access-Control-Allow-Headers  : Authorization, Content-Type, Idempotency-Key,
                                   X-Correlation-ID, X-Request-ID, X-Hospital-ID,
                                   apikey, X-Client-Info     <-- FIXED
```

`apikey` and `X-Client-Info` are now present and `Vary: Origin` was added — the
redeployed artifact carries the current shared CORS helper.

## 8. Direct backend read proof (§13) — read-only, non-browser control

Password-grant as `admin@surya.test`, `X-Hospital-ID: …0001`, against staging:

```text
overview       success=true  data keys: action|overview|scores
sla_dashboard  success=true  data keys: action|sla
system_health  success=true  data keys: action|health
timeline       success=true  data keys: action|timeline
predictive     success=true  data keys: action|predictions
```

Representative structure (as returned, not recomputed): `overview.sla = NULL`,
`scores.inputs.avg_wait_minutes = NULL` while `waiting / capacity /
active_sessions` are real `0`; `sla.hospitals_in_breach = []`, `sla.trend_14d =
[]`. No secret, token or key value is reproduced here.

## 9. Hospital-admin browser validation — TEST A (§14)

Against `https://setura-delta.vercel.app` as `admin@surya.test`.

```text
A1 Landing            /admin                                   PROVEN STAGING
A2 Identity           hospital admin · Surya Hospital Admin ·
                      tenant 00000000-0000-4000-8000-000000000001  PROVEN STAGING
A3 Command Centre nav present                                   PROVEN STAGING
A4 Five sections render (Operational Overview, SLA Dashboard,
   System Health, Operational Timeline, Predictive Insights)    PROVEN STAGING
A5 Five POST reads      OPTIONS ×5 → 204, POST ×5 → 200         PROVEN STAGING
   (previously POST ×5 → net::ERR_FAILED)
```

No `net::ERR_FAILED`, no CORS error. The exact failure the prior phase reported
is resolved.

## 10. Live-data rendering (§15) — actual values, not headings only

Populated backend values rendered (representative): Bookings today **4**; Open
alerts **34**; Congestion **100**, Health **75**, Patient experience **100**;
`job_queue` Failed **74**; 5 materialized views with real refresh timestamp
`9/29/2026, 8:30:00 AM` (Success=Yes, Stale=No, rows 4/3/4/4/8); Predicted
no-shows **0.2**; snapshot date `2026-09-29`; **2 real timeline events**
(`9/28/2026 8:25:44 PM`, `8:23:13 PM` — booking / status_changed / info).

Error-string audit of `document.body.innerText`: `Cannot reach the server` =
absent, `Check your connection` = absent, generic error state = absent.

## 11. NULL vs zero (§16)

Preserved in the UI. Em-dash `—` marks true null/unavailable (Avg wait, Avg
consultation, Outstanding settlements, SLA status, Avg breach wait, WhatsApp
oldest pending, Avg consult time). Honest empty-states rendered verbatim ("No SLA
breaches recorded.", "No trend data available.", "DLQ is empty."). Literal `0`
appears only where the backend returned a real `0` (Waiting, Completed, Revenue
today). No NULL was silently coerced to `0`; no `0` was fabricated for a NULL.

## 12. Refresh validation (§17)

```text
before        Last updated 9/29/2026, 6:04:48 PM
action        Refresh clicked exactly once -> 5 POSTs, all 200
after         Last updated 9/29/2026, 6:05:12 PM   (ADVANCED)
mutations     0 (only overview/sla_dashboard/system_health/timeline/predictive reads)
```

The `Refresh → 5 successful reads → timestamp advances` success variant that the
prior phase could not observe is now PROVEN STAGING.

## 13. Console audit (§18)

Hospital-admin `/admin`: **0 errors, 0 warnings, 0 CORS entries, 0
`net::ERR_FAILED`.** Receptionist, doctor and global-admin sessions: 0 console
messages. Nothing was filtered or hidden.

## 14. Receptionist negative — TEST B (§19)

```text
lands /reception (Ravi Kumar, receptionist, tenant …0001)         PROVEN STAGING
Command Centre nav absent (nav: Dashboard/Appointment/Walk-in/
  Patients/Notifications/Queue / Tokens)                          PROVEN STAGING
manual /admin -> redirected to /reception                         PROVEN STAGING
command-center requests 0 · mutations 0 · console clean           PROVEN STAGING
```

## 15. Doctor negative — TEST C (§20)

```text
lands /doctor (Dr. Anitha Rao, doctor, tenant …0001)              PROVEN STAGING
Command Centre nav absent (single item "Doctor Console")          PROVEN STAGING
manual /admin -> redirected to /doctor                            PROVEN STAGING
command-center requests 0                                         PROVEN STAGING
allowed auto read POST /doctor-operations -> 200 (positive control)
"Start session" NOT clicked · no mutation · console clean         PROVEN STAGING
```

## 16. Global-admin validation — TEST D (§21)

```text
root@setura.test -> /admin, badge "global admin", Setura Root Admin,
  tenant field "no tenant"                                        PROVEN STAGING
<main> renders exactly "No hospital tenant is attached to your account."
  with none of the five sections                                  PROVEN STAGING
command-center requests 0 (no tenant to scope to)                 PROVEN STAGING
Global-admin-WITH-TENANT data path                                NOT OBSERVED
  (the seeded staging account has no hospital tenant; the account
  was NOT modified to manufacture a test)
```

## 17. Tenant isolation (§22) — read-only backend boundary

```text
admin of tenant …0001, X-Hospital-ID …0002 (cross-tenant)  -> 403   PROVEN STAGING
admin of tenant …0001, X-Hospital-ID absent                -> 422   PROVEN STAGING
```

Frontend tenant derivation remains STATICALLY VERIFIED (`AdminCommandCentre.tsx`
takes `hospitalId` only from `useAuth()`; no path/query param; hospital id travels
only in the session-derived `X-Hospital-ID` header).

## 18. Network / mutation safety (§23) — whole session

```text
booking/cancellation/check-in/no-show mutations = 0   queue mutations = 0
payment = 0   refund = 0   WhatsApp = 0   broadcast = 0
scheduler = 0   worker = 0
```

Command Centre is strictly read-only end to end.

## 19. Deployed bundle security (§24)

Re-fetched the live `https://setura-delta.vercel.app` artifacts (unchanged build
`dpl_6C79adB3…`: `index.html` 418 B, `index-CrBJP2Vn.js` **485,508 B**,
`index-D7A4dsD3.css` 14,130 B) and ran the repository gate:

```text
deno run --allow-read scripts/check_frontend_secrets.ts <deployed bundle> --deny-sourcemaps
→ 3 artifact(s), 0 secret hit(s), 0 source map(s) (sourcemaps denied), exit 0
```

`service_role` / `SUPABASE_SERVICE_ROLE_KEY` / Razorpay / `META_APP_SECRET` /
`CRON_SECRET` / `WORKER_SECRET` = 0. Only the staging Supabase origin and the
publishable/anon credential are present. No key value is printed.

## 20. Regression (§25)

| Command | Result |
| --- | --- |
| `npm run typecheck` (tsc --noEmit) | PASS, exit 0 |
| `npm test` (Vitest full suite) | **PASS 170/170 across 16 files** |
| `npm run build` | PASS — 119 modules, `dist/assets/index-CKUySAMz.js` 485.55 kB, 0 source maps, exit 0 |
| `npx vitest run` (3 G-03 files) | **PASS 25/25** (`commandCenter.test.ts`, `AdminCommandCentre.test.tsx`, `App.test.tsx`) |
| `deno test … tests/integration/enterprise_command_center.test.ts` | **PASS 23/23**, incl. `ent http: command-center overview and timeline` and `ent http: auth gates enforce roles and portfolio scope` |

To run the integration suite the local Edge Runtime container
(`supabase_edge_runtime_setura`) was `docker start`-ed — it was reported
**Stopped** by `supabase status` (known AGENTS.md §13 `RestartPolicy=no`
condition). This touches only the local Docker runtime, resets no data, and is
not a staging/production change.

Not repaired (pre-existing, unrelated): root-markdown `deno fmt --check`
failures. No file was reformatted to make this phase green.

## 21. Git state (§26)

```text
git rev-parse HEAD        : 0cb2800d27bd5b0b920006530ca82f22300b0402
git rev-parse origin/main : 0cb2800d27bd5b0b920006530ca82f22300b0402
git diff --stat supabase/ : (empty)
git status --short        : (clean apart from this new report file)
```

No commit, no push, no amend, no rebase, no force push, no unrelated file
cleaned. HEAD still equals origin/main. The redeploy changed the remote staging
artifact, not the repository. Throwaway bundle artifacts and helper scripts were
written only under the ignored `.remember/tmp/`.

## 22. Production boundary

Production was not touched. Every Supabase call targeted the staging ref
`gzcqasntcbqqmgsoikms`; the only deployment was `command-center` to that staging
project; the browser/bundle checks targeted the existing
`setura-delta.vercel.app` staging frontend. No production Supabase project, key,
secret, Vault entry, function or database was addressed.

## 23. Screenshots

```text
SCREENSHOTS BLOCKED — ENVIRONMENT
NATIVE_BROWSER_VIEWPORT_UNAVAILABLE (viewport 0x0 / visible=false)
```

No image was produced and none was fabricated. DOM / accessibility-tree /
network / console evidence is used throughout instead. This is an environment
condition, not a product failure.

## 24. Final classification and remaining limitations

**Acceptance gate (§27) — every required conjunct:**

```text
✓ frontend deployed                ✓ five sections render
✓ hospital_admin reaches /admin    ✓ actual live backend values render
✓ five command-centre POSTs 200    ✓ Refresh performs five successful reads
✓ Last updated advances            ✓ NULL-vs-zero preserved
✓ hospital-admin console clean     ✓ receptionist denied
✓ doctor denied                    ✓ global-admin no-tenant state correct
✓ tenant isolation proven          ✓ zero mutations
✓ zero broadcast                   ✓ deployed bundle clean
✓ production untouched
```

All conjuncts satisfied → **G-03: PROVEN STAGING.**

**Remaining limitations (honestly recorded, none blocks the gate):**

1. **Global-admin-with-tenant data path NOT OBSERVED** — the seeded staging
   account carries no hospital tenant; the account was not modified to force a
   test. The no-tenant state itself is PROVEN STAGING.
2. **Other stale Edge Functions not redeployed.** Only `command-center` (the
   minimum G-03 fix) was redeployed. Nine further staging functions from the
   prior census (`cancel-booking`, `update-booking-status`, `queue-next-patient`,
   `enterprise-reports`, `financial-command-center`, `executive-analytics`,
   `alert-center`, `send-whatsapp-message`, `run-background-worker`) still carry
   the pre-`79b74f7` CORS artifact and were left unchanged, per §6 ("do not
   blindly deploy every function"). Their browser behavior was NOT tested —
   exercising them would require calls outside this phase's read-only scope. If
   any such flow is later needed in-browser, it requires its own authorized
   redeploy.
3. **Unconfirmed auto-refresh anomaly (not a proven defect).** During TEST A the
   browser observed repeated read rounds and advancing timestamps. Source
   inspection shows **no** loop mechanism exists: `AdminCommandCentre.tsx` has no
   `setInterval`/`setTimeout`/`refetch`, and `loadAll` is memoized on the stable
   `hospitalId`, so its mount effect cannot self-re-fire. `StrictMode`
   double-invocation applies only to dev builds, not this production build. The
   observed advances occurred on **irregular** intervals (15s / 13s / 18s / 34s),
   consistent with the browser harness re-mounting `/admin` between snapshots
   rather than a deterministic timer. Every such request returned 200 with 0
   console errors, so it breaks no gate conjunct. Classified UNCONFIRMED —
   likely tooling artifact. No frontend change was made (none is proven
   warranted). Flagged for optional follow-up only if independently reproduced
   from a clean manual session.
4. Local-environment regression results are not production verification. This
   phase is **staging** only. Nothing here certifies production.

STOP. No product-gap investigation, no G-04/G-05, no rescheduling, no analytics,
no finance/audit UI, no refactor, no commit, no push.

---

## 25. Mandatory final block

```text
CURRENT BASELINE:
0cb2800d27bd5b0b920006530ca82f22300b0402   (HEAD == origin/main; the brief's stated
0ec8586 is this commit's parent/ancestor; G-03 frontend now committed; supabase/ clean)

STAGING:
setura-staging / gzcqasntcbqqmgsoikms

STAGING FRONTEND:
https://setura-delta.vercel.app

G-03:
PROVEN STAGING

CORS REMEDIATION:
PASS

COMMAND-CENTER PREFLIGHT:
PASS (apikey + X-Client-Info now present; Vary: Origin added)

HOSPITAL ADMIN LIVE DATA:
PROVEN

REFRESH:
PASS (5 reads all 200; Last updated advanced 6:04:48 PM -> 6:05:12 PM)

RECEPTIONIST:
PASS

DOCTOR:
PASS

GLOBAL ADMIN:
PASS (no-tenant state); WITH-TENANT DATA NOT OBSERVED (seeded account has no tenant)

TENANT ISOLATION:
PASS (403 cross-tenant / 422 missing header)

NETWORK SAFETY:
PASS (0 mutations / 0 broadcast)

SECURITY SCAN:
PASS (deployed bundle: 0 secret hits, 0 source maps)

CONSOLE:
PASS (0 CORS / 0 ERR_FAILED / 0 errors)

SCREENSHOTS:
BLOCKED — ENVIRONMENT

BACKEND:
CHANGED — command-center Edge Function redeployed to STAGING from already-fixed source
(no source-code change; migrations/RLS/secrets untouched)

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
HEAD == origin/main == 0cb2800; no commit; no push; no amend; no rebase; supabase/ clean

FINAL STATUS:
PROVEN STAGING
```
