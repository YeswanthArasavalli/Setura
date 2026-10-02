# PHASE 7 — G-09 FINANCE / COLLECTIONS READ SURFACE — STAGING VERIFICATION REPORT

**Final status: `G-09 — PROVEN STAGING — CLOSED`** (one recorded evidence limitation:
browser screenshots could not be captured by the automation harness; see §21.)

Scope of this phase: deploy **only** `financial-command-center` to the existing
`setura-staging` Supabase project and verify the already-implemented G-09 surface
against staging (backend HTTP matrix + browser). No redesign. No SQL/migration/RLS/
grant change. No other function redeployed. Production untouched.

---

## 1. Baseline commit

- Branch `main`, commit `90100aa` = full SHA `90100aaba1a6bf637c44540e1107f886bf14c1e3`,
  message "Add Finance / Collections Read Surface (G-09)".
- Predecessor `df4101f` (G-08). At phase start `main` was `origin/main` + 1.
- `git show --stat 90100aa` confirms it touched exactly the 10 G-09 files
  (5 added incl. the real-HTTP integration test + this-phase report excluded;
  4 modified frontend: `App.tsx`, `App.test.tsx`, `components/AppShell.tsx`,
  `types/api.ts`; 1 report). No unrelated working-tree artifacts were in the commit
  (`*.log`, screenshots, probe scripts remained untracked).

## 2. Push result

- `git push origin main` → **exit 0**, fast-forward `df4101f..90100aa main -> main`
  (normal workflow, **no force, no history rewrite**).
- Post-push: `git status -sb` → `## main...origin/main` (in sync, no ahead/behind);
  local HEAD `90100aa…`; `git ls-remote origin refs/heads/main` →
  `90100aaba1a6bf637c44540e1107f886bf14c1e3` — the remote contains the G-09 commit.
- Repo CI (`.github/workflows/ci.yml`) is **validate-only** (no `functions deploy`,
  no host deploy); the push triggers validation, not deployment.

## 3. Staging project

- `supabase projects list` (CLI authenticated) → project ref **`gzcqasntcbqqmgsoikms`**,
  name **`setura-staging`**, region **South Asia (Mumbai) = ap-south-1**, and it is the
  **LINKED** project. This exactly matches the §5 target; the target was verified, not
  guessed. The only other org project (`ldmbqhqdgblhdiruzvfi`, "PrepOS") is unrelated
  and was never targeted.
- Staging API base: `https://gzcqasntcbqqmgsoikms.supabase.co`.

## 4. Deployment target

- Exactly one function: `financial-command-center`. Deployed with
  `supabase functions deploy financial-command-center --project-ref gzcqasntcbqqmgsoikms`
  (default `verify_jwt` = true; `config.toml` carries no per-function override and the
  arch doc reserves `--no-verify-jwt` only for webhook/cron functions, which this is
  not — the frontend and HTTP test pass real user JWTs). No `--all`, no `db push`,
  no `secrets set`.

## 5. Previous function version

- Pre-deploy `supabase functions list --project-ref gzcqasntcbqqmgsoikms`:
  `financial-command-center` — id `02fc87cb-c4c9-4c4f-be73-6e889f43ff52`,
  **VERSION 7**, STATUS ACTIVE, updated `2026-09-20 16:38:02 UTC`.

## 6. New function version

- Post-deploy same list: `financial-command-center` — **VERSION 8**, STATUS ACTIVE,
  updated `2026-10-01 07:48:00 UTC` (same id, slug unchanged). Deployed script 186.4 kB.
- Version census confirms **no other function changed**: every other function retains
  its pre-existing version/timestamp. No mass-redeploy (prohibited by §2).

## 7. Deployment timestamp

- `2026-10-01 07:47:52 UTC` (deploy invocation) → live `2026-10-01 07:48:00 UTC`
  (VERSION 8 `UPDATED_AT`). Project `gzcqasntcbqqmgsoikms`, function
  `financial-command-center`.

## 8. CORS / preflight evidence

- `OPTIONS /functions/v1/financial-command-center` with
  `Origin: https://setura-delta.vercel.app` and
  `Access-Control-Request-Headers: apikey,authorization,content-type,x-client-info,x-hospital-id`
  → **HTTP 204**.
- `Access-Control-Allow-Origin: https://setura-delta.vercel.app` (exact origin echoed),
  `access-control-allow-credentials: true`,
  `Vary: Accept-Encoding, Origin`,
  `access-control-allow-headers` includes `Authorization, Content-Type, Idempotency-Key,
  X-Correlation-ID, X-Request-ID, X-Hospital-ID, apikey, X-Client-Info`,
  `access-control-allow-methods` includes `POST, OPTIONS`, `max-age 86400`.
- Response carried `x-deno-execution-id` + `x-served-by: supabase-edge-runtime`,
  `x-sb-edge-region: ap-south-1`, `sb-project-ref: gzcqasntcbqqmgsoikms` — the preflight
  is genuinely served by the deployed function's shared CORS handler. **No stale CORS**
  (the previously observed G-03/G-05/G-08 allow-origin drift is not present).

## 9. Backend HTTP matrix (staging Edge Function, server-to-server)

Recovered the public anon key + URL from the shipped bundle (public by design; printed
by length only). Authenticated via GoTrue password grant against the existing seeded
accounts. `A = 00000000-0000-4000-8000-000000000001` (Surya, hospital_admin tenant).

| Probe | Result |
| --- | --- |
| hospital_admin `overview` @ A | **200** `success:true` server aggregate (date 2026-10-01, daily_collections + settlement_intelligence + embedded reconciliation) |
| hospital_admin `forecast` @ A | **200** server projection (as_of, inputs, refund_rate_30d …) |
| hospital_admin `reconciliation` @ A | **200** summary array (`reconciliation:[{…}]`) |
| global_admin `overview` @ valid header | **200** — acting hospital `…0005` (Ganesh Children Hospital), chosen from the RLS-visible `hospitals` read (5 visible), **no invented tenant** |
| receptionist ×3 @ A | **403** `ROLE_INSUFFICIENT` ("Required: hospital_admin or global_admin, actual: receptionist") |
| doctor ×3 @ A | **403** `ROLE_INSUFFICIENT` (actual: doctor) |
| missing `X-Hospital-ID` (valid admin JWT) | **422** `VALIDATION_ERROR` "Missing X-Hospital-ID header" (`fieldErrors.header: Required`) |
| anonymous (no Bearer) | **401** `UNAUTHORIZED` "Missing Bearer token" |
| cross-tenant: admin(A member) → hospital `…0005` | **403** `HOSPITAL_ACCESS_DENIED` "Access denied to hospital …0005" — no data returned |

## 10. Hospital-admin browser evidence

`/admin/financial` as `admin@surya.test` (banner "hospital admin / Surya Hospital Admin /
tenant …0001"): nav shows exactly **"Finance / Collections"**; page settles to data (no
persistent loading); **three sections render** (Financial Overview incl. Daily
Collections + Settlement Intelligence + embedded reconciliation; Revenue Forecast;
Collections → Ledger Reconciliation). All Overview currency fields render `₹0` (server
zeros — hospital A has no financial activity on 2026-10-01; these are genuine
server-generated values, identical to the §9 server response); counts render `0`; the two
server-NULL fields (`Outstanding balance`, `Collection velocity (days)`) render **`—`**.
Zero application console errors.

## 11. Global-admin browser evidence

`/admin/financial` as `root@setura.test` (banner "global admin / Setura Root Admin /
no tenant"): all three sections load (200), no redirect, and the page shows a truthful
scope disclosure — verbatim: *"Request context sent as the required tenant header:
`00000000-0000-4000-8000-000000000005` — your account has no hospital of its own, so this
one is used only to satisfy the header; the figures below are scoped to it."* The network
shows a `GET /rest/v1/hospitals?select=id,name&order=name.asc&limit=1` [200]
(acting-context read) preceding the 3 financial POSTs [200] — i.e. the tenant came from
a server lookup, **not a fabricated value**. Idle Δ0, 0 console errors.

## 12. Receptionist isolation

`reception@surya.test`: **"Finance / Collections" absent** from nav; navigating directly to
`/admin/financial` **redirects to `/reception`**; **0** `financial-command-center` requests
(load network = GET profiles / user_roles / bookings only); no financial data rendered;
0 console errors. The frontend prevents the call (a backend 403 was not relied upon).

## 13. Doctor isolation

`dr@surya.test`: **"Finance / Collections" absent**; direct `/admin/financial` **redirects
to `/doctor`**; **0** financial requests (network = profiles / user_roles /
doctor-operations); no data; 0 console errors.

## 14. Cross-tenant evidence

Server-side (§9): hospital_admin of tenant A requesting hospital `…0005` →
**403 HOSPITAL_ACCESS_DENIED** with no financial payload. No leakage observed in any
browser session. DB-enforced (`resolveAuth` membership + service-role RPC tenant check) —
no client-supplied hospital trusted.

## 15. Network evidence (browser, initial load)

- hospital_admin `/admin/financial` full load: 8 requests = 2 GET (profiles, user_roles) +
  **3 POST financial-command-center [200]** + 3 OPTIONS preflight [204]. Exactly one
  request per action; correct endpoint + method POST + authenticated. No payment/refund/
  settlement mutation requests, no scheduler/worker calls, no unrelated financial endpoints.
- Refresh delta: POST count 3 → 6 (**+3**, one bounded cycle). Idle (20s): Δ0, no loading
  return → no polling, no remount loop (also a clean regression signal for the previously
  closed AuthProvider request/remount issue).
- Limitation: the browser network tool exposes method/URL/status only, not request headers,
  so the `X-Hospital-ID` header value was not directly read in-browser. Header behavior is
  nonetheless proven directly by the backend matrix (§9: missing→422, cross-tenant→403) and
  corroborated on-page by the tenant disclosure (§10/§11).

## 16. Null-vs-zero evidence

Server returns literal `0` amounts → UI renders `₹0` / `0` (never `—`); server returns
`null` (outstanding balance, collection velocity, no settlement records) → UI renders `—`
/ an explicit "no records" message (never a fabricated `₹0`). Observed directly in the
staging hospital-admin and global-admin renders; no staging data was altered to manufacture
the case.

## 17. Refresh / idle evidence

One manual Refresh = exactly one additional bounded 3-request cycle; ≥20s idle produced
zero self-initiated financial requests and no persistent loading for both hospital_admin
and global_admin. (§13/§14/§15 frontend guarantees confirmed live.)

## 18. Console evidence

**0 application console errors** across every role and page exercised
(hospital_admin financial + all 5 smoke surfaces, global_admin financial + portfolio,
receptionist, doctor). No login bounce. Sign-out returned to the login form with no
protected page leaked. (Browser-automation click/fill timeouts are harness noise, not app
errors, and did not affect load/console evidence.)

## 19. Closed-workstream regression smoke (post-deploy, staging browser)

| Surface | Role | Result |
| --- | --- | --- |
| G-03 Command Centre `/admin` | hospital_admin | **PASS** — rendered, 0 console errors |
| G-05 Audit & Compliance `/admin/audit` | hospital_admin | **PASS** — rendered, 0 console errors |
| G-06 Executive/Operational Reports `/admin/reports` | hospital_admin | **PASS** — rendered, 0 console errors |
| G-07 Reschedule reachability (booking detail) | hospital_admin | **PASS** — "Reschedule booking" control present, not executed |
| G-08 Global Portfolio `/admin/portfolio` | global_admin | **PASS** — portfolio + benchmarks render (5 hospitals, date 2026-10-01), 0 console errors |

No closed workstream was reopened or redeployed; these functions retain prior versions
(§6). No regression attributable to the isolated G-09 deployment.

## 20. Production untouched verification

- No production deployment. The only Supabase write in this session was the single
  `functions deploy` to `--project-ref gzcqasntcbqqmgsoikms` (staging). No `--all`, no
  `db push`, no `secrets set`, no config change.
- No production-mutating requests. All backend calls targeted the staging project URL /
  staging Vercel app. No request was made against `ldmbqhqdgblhdiruzvfi` (PrepOS) or any
  non-staging target. There is no reachable `setura-production` project in this account;
  production is untouched by construction.
- The `main` push triggers validate-only CI; the live staging frontend already served the
  G-09 bundle (verified: `/admin/financial`, `Finance / Collections`,
  `fetchFinancialOverview`, `Revenue Forecast` present; G-03/G-06/G-08 routes still
  present).

## 21. Limitations

- **Screenshots not captured.** The browser automation harness reported
  `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE` (window minimized/hidden at OS level;
  `document.visibilityState=hidden`), which blocks `take_screenshot` and native
  click/fill. Per §22, native **network + DOM/accessibility + console** evidence was
  collected instead; no visual artifacts are attached. Login/refresh were driven via
  React-compatible programmatic events.
- **In-browser request headers not directly inspectable** (network tool returns
  method/URL/status only). Header/tenant correctness is therefore evidenced by the
  backend matrix (§9) plus on-page disclosure (§11) rather than a raw header read.
- Staging hospital A had **no financial activity on the probe date**, so server aggregates
  are legitimately `0` (structure and server dates/correlationIds are real and present);
  this is genuine server data, not fabricated values. Zero staging rows were invented.

## 22. Final acceptance matrix

| # | Criterion | Result |
| --- | --- | --- |
| 1 | Commit `90100aa` verified | PASS |
| 2 | Commit pushed normally (no force) | PASS |
| 3 | Staging target verified | PASS (`gzcqasntcbqqmgsoikms` setura-staging, ap-south-1, linked) |
| 4 | Only financial-command-center deployed | PASS |
| 5 | Deployment version recorded | PASS (v7 → v8) |
| 6 | CORS/preflight verified | PASS (204, exact origin, headers) |
| 7 | Hospital-admin overview 200 | PASS |
| 8 | Hospital-admin forecast 200 | PASS |
| 9 | Hospital-admin reconciliation 200 | PASS |
| 10 | Global-admin path verified | PASS (200 via RLS acting context) |
| 11 | Receptionist 403 | PASS |
| 12 | Doctor 403 | PASS |
| 13 | Missing tenant 422 | PASS |
| 14 | Anonymous 401 | PASS |
| 15 | Cross-tenant fail-closed | PASS (403 HOSPITAL_ACCESS_DENIED) |
| 16 | No financial data leakage | PASS |
| 17 | Direct RPC privilege remains protected | PASS (403 / SQLSTATE 42501 ×3) |
| 18 | `/admin/financial` reachable for authorized role | PASS |
| 19 | Finance nav correct | PASS |
| 20 | Three sections render real server data | PASS |
| 21 | No client financial calculations | PASS |
| 22 | Null-vs-zero preserved | PASS |
| 23 | No uncontrolled polling | PASS (idle Δ0) |
| 24 | Refresh bounded | PASS (+3 one cycle) |
| 25 | Auth-loop regression clean | PASS |
| 26 | Receptionist makes zero finance calls | PASS |
| 27 | Doctor makes zero finance calls | PASS |
| 28 | Global-admin behavior truthful | PASS (disclosed acting tenant) |
| 29 | Console clean | PASS (0 errors all roles) |
| 30 | G-03 smoke | PASS |
| 31 | G-05 smoke | PASS |
| 32 | G-06 smoke | PASS |
| 33 | G-07 smoke | PASS |
| 34 | G-08 smoke | PASS |
| 35 | Production untouched | PASS |
| — | Screenshots (not a §21 gate) | LIMITED — harness viewport unavailable; network/DOM/console used (§21/§22 allowance) |

---

```text
G-09 — PROVEN STAGING — CLOSED
PRODUCTION — UNTOUCHED
```

All required staging gates passed with real, observed evidence. The sole deviation is the
documented inability to capture screenshots (browser-harness viewport limitation), for
which native network/DOM/console evidence was substituted as explicitly permitted. Not
proceeding to any next workstream. Stop.
