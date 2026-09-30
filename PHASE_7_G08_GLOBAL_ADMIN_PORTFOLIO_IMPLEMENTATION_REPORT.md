# PHASE 7 — G-08 GLOBAL ADMIN PORTFOLIO DASHBOARD — IMPLEMENTATION REPORT

```text
Phase            G-08 Global Admin Portfolio Dashboard
Specification    "SETURA Hospital OS — G-08 Global Admin Portfolio Dashboard" (28 sections)
Baseline         main @ da5332efab5583a957f645a4a5c145ec42c46c5b
Auth-loop commit 18cfefc328ddd6099a7d6a3589ed7fd4733d5145 (pushed)
G-08 commit      the commit that contains this report (see §6 for its exact file set)
Date             2026-09-30
Final status     BLOCKED — executive-analytics deployment drift detected (§11)
```

---

## 1. Executive Summary

G-08 asked for a strictly read-only `global_admin` portfolio surface over the
already-implemented, already-HTTP-tested `executive-analytics` global actions
(`portfolio` → `get_portfolio_dashboard`, `benchmarks` →
`get_cross_hospital_benchmarks`), delivered inside the established frontend
architecture with no backend, SQL, RLS, grant or auth change.

What was achieved:

- The already-proven auth app-shell request-loop fix was preserved as its own
  atomic commit `18cfefc` and pushed to `origin/main` after a clean deep
  security review (§3).
- G-08 is implemented frontend-only in 8 repository files — 4 new, 4 modified —
  with zero changes under `supabase/` (§5, §6).
- The security boundary is the existing one: user JWT + session tenant header →
  `resolveAuth` → `requireRole` → `GLOBAL_ACTIONS` check → tenant-free
  `SECURITY DEFINER` RPC. No service-role key exists in the browser bundle (§7).
- The `X-Hospital-ID` friction of spec §5 was resolved without touching data or
  authorization, because the documented fixture route is structurally
  impossible in this schema (§8).
- 27 new tests, all local gates green, and a real-runtime browser proof against
  the live local stack with real data: 191 hospitals, 200/200 responses, clean
  console, bounded network behaviour, auth-loop guard held (§9, §10, §14, §15).

What is **not** proven: the staging browser acceptance of spec §20 Steps 3–5.
Step 1 of that section produced a STOP condition. The deployed
`executive-analytics` bundle on staging is v7 from 2026-09-20 and therefore
predates the 2026-09-22 CORS/`env` remediation that lives in its own shared
dependencies; its live preflight response omits `apikey` and `X-Client-Info`,
the two headers `supabase-js` always sends cross-origin. A browser on staging
cannot reach this function today, no matter what the frontend contains. Per the
spec, no automatic redeploy was performed.

```text
executive-analytics deployment drift detected
```

**Final status: BLOCKED** (§19). The frontend itself is complete and
INTEGRATION VERIFIED locally; the staging gate is blocked on one deployment
action that is outside G-08's declared frontend-only boundary and requires
explicit authorization.

---

## 2. Starting Repository State

Verified before any edit, by direct command rather than by assumption:

| Fact | Value | Method |
| --- | --- | --- |
| Branch | `main` | `git status` |
| HEAD | `da5332e` — "Staff booking reschedule + G-06 closure" | `git log` |
| `origin/main` | `da5332e` (in sync) | `git status` |
| Remote | `https://github.com/YeswanthArasavalli/Setura.git` | `git remote -v` |
| Working tree | 57 porcelain entries: 1 modified source file (`apps/web/src/auth/AuthProvider.tsx`) plus untracked evidence artefacts and the auth-loop files | `git status --porcelain` |

One baseline statement in `AGENTS.md` §13 is stale and was overridden by
evidence: it asserts the working tree "is NOT a Git repository (no `.git`,
confirmed by two independent methods)". This tree **is** a Git repository with a
reachable `origin`. The spec's git plan (§2, §25) is executable here and was
followed; file changes in this phase are verifiable by `git diff`, not only by
timestamps.

---

## 3. Auth-Loop Atomic Commit

Executed as the first authorized action, before any G-08 code.

| Item | Value |
| --- | --- |
| Commit hash | `18cfefc328ddd6099a7d6a3589ed7fd4733d5145` |
| Message | "Preserve proven auth app-shell request-loop fix" |
| Parent | `da5332efab5583a957f645a4a5c145ec42c46c5b` |
| Size | 4 files, 1276 insertions, 11 deletions |
| Pre-commit test run | `npx vitest run src/auth/AuthProvider.test.tsx` → 11 passed |
| Push | `da5332e..18cfefc main -> main` (normal, non-force) |
| Post-push state | `HEAD` == `origin/main` == `18cfefc3…` |

Files included (staged by explicit path, never `git add .`):

```text
apps/web/src/auth/AuthProvider.tsx                                   modified
apps/web/src/auth/AuthProvider.test.tsx                              new
PHASE_7_AUTH_APP_SHELL_REQUEST_LOOP_IMPLEMENTATION_REPORT.md         new
PHASE_7_NEXT_WORKSTREAM_INVESTIGATION_AFTER_AUTH_LOOP.md             new
```

Files deliberately excluded from the commit: every `*.png` walkthrough
screenshot, every `*.log`, every `*.ps1` helper, `.vercel/` state, `*.json`
proof dumps, and all other untracked phase reports unrelated to the auth loop.

Working-tree state after the commit: the auth-loop files no longer appear in
`git status`; the remaining untracked entries are exactly the pre-existing
evidence artefacts. `AuthProvider.tsx` carries the `authedUserRef` same-user
guard that stops a routine `TOKEN_REFRESHED` / same-user `SIGNED_IN` event from
flipping `loading`, tearing down the app shell and re-firing every
load-on-mount fetch.

The push was gated on a deep security review of the committed change set, which
returned zero findings.

---

## 4. Existing Backend Contract

Read from source, not from documentation, and unchanged by this phase.

`supabase/functions/executive-analytics/index.ts`:

| Step | Behaviour |
| --- | --- |
| 1 | `X-Hospital-ID` header is mandatory → otherwise `ValidationError("Missing X-Hospital-ID header")` → HTTP 422 |
| 2 | body validated against a Zod schema (`action` enum, `date` / `fromDate` / `toDate` under `DATE_RE`) |
| 3 | `resolveAuth(req, hospitalId, logger)` |
| 4 | `requireRole(auth, ["hospital_admin", "global_admin"])` → otherwise 403 `ROLE_INSUFFICIENT` |
| 5 | `if (GLOBAL_ACTIONS.has(body.action) && auth.role !== "global_admin")` → 403 `FORBIDDEN` "Portfolio analytics require global admin access" |
| 6 | `portfolio` → `rpc get_portfolio_dashboard({ p_date? })` → `successResponse({ action: "portfolio", portfolio })` |
| 7 | `benchmarks` → `rpc get_cross_hospital_benchmarks({ p_from_date?, p_to_date? })` → `successResponse({ action: "benchmarks", benchmarks })` |

`GLOBAL_ACTIONS = new Set(["portfolio", "benchmarks"])`. Both RPCs
(`supabase/migrations/47_enterprise_command_center.sql`) are tenant-free —
neither takes a `p_hospital_id` — `SECURITY DEFINER`, `STABLE`, and locked by
migration 48 to `service_role` EXECUTE only.

Shapes consumed verbatim by the UI:

```text
get_portfolio_dashboard        → { date, total_hospitals, active_hospitals,
                                   hospitals[ { hospital_id, name, slug, is_active,
                                                bookings_today, revenue_today,
                                                outstanding_balance, sla_status,
                                                active_sessions } ] }
get_cross_hospital_benchmarks  → { from_date, to_date,
                                   benchmarks[ { hospital_id, name, bookings, completed,
                                                 avg_wait_minutes, avg_consultation_minutes,
                                                 efficiency_pct, revenue_inr } ] }
```

`total_hospitals` is `jsonb_array_length(hospitals)` and `active_hospitals` is a
separate `COUNT(*) … WHERE is_active`; `sla_status` is
`'breached' | 'no_data' | 'healthy'` or `NULL`. The frontend mirrors these
numbers rather than recomputing them.

Reuse rather than duplication: `tests/integration/enterprise_command_center.test.ts`
already contains the real-HTTP proof `"ent http: auth gates enforce roles and
portfolio scope"` (receptionist → 403 `ROLE_INSUFFICIENT`; hospital_admin →
portfolio 403 `FORBIDDEN`; global_admin → portfolio succeeds). The current
source still matches that tested contract, so G-08 cites it and adds no
duplicate backend test.

---

## 5. G-08 Implementation

Three new source modules and three edited ones, all inside the established
patterns.

**`apps/web/src/api/portfolio.ts`** — thin read boundary.
`fetchGlobalPortfolio(hospitalId, { date? })` and
`fetchCrossHospitalBenchmarks(hospitalId, { fromDate?, toDate? })` each issue
exactly one `callFunction("executive-analytics", …, { hospitalId })`. Absent
dates are **omitted** from the body so the RPC's own defaults apply instead of a
browser-invented date. Tenant travels only in the shared header — never in the
body, which is asserted by test. Neither call carries an idempotency key: both
are reads.

`fetchActingHospitalContext()` (§8) performs one bounded, RLS-guarded
`hospitals` select of a single row purely to satisfy the mandatory header.

**`apps/web/src/routes/AdminPortfolio.tsx`** — read-only page. Two independent
sections using the existing `Section<T>` state machine
(`LOADING` / `succeeded` / `failed`) resolved through one `Promise.allSettled`,
so one section's failure never destroys the other. `activeRef` guards
post-teardown state writes, matching `AdminCommandCentre`. `display()` is the
truthful scalar renderer: `0` → `"0"`, `null`/`undefined`/non-finite → `"—"`,
boolean → `yes`/`no`. No metric, ranking, average, delta or total is computed in
the browser. A single explicit Refresh button is disabled while either section
is loading and is the only way to re-request.

**Routing and navigation** — `/admin/portfolio` is wrapped in
`RequireRole roles={[...GLOBAL_ADMIN_ROLES]}`, i.e. `["global_admin"]`; the nav
entry is filtered to the same single role. The guard is a UX boundary only; the
Edge Function remains the authority. Hiding the link is not treated as
authorization.

**Types** — `apps/web/src/types/api.ts` gained the six interfaces for the two
responses, using the existing `JsonNumeric` for `NUMERIC` columns and an
explicitly nullable `outstanding_balance` (the SQL `COALESCE` defaults the
column, not a missing `outstanding_balances` row).

---

## 6. Files Changed

```text
M  apps/web/src/App.tsx                      +18
M  apps/web/src/App.test.tsx                 +76
M  apps/web/src/components/AppShell.tsx      +4
M  apps/web/src/types/api.ts                 +75
A  apps/web/src/api/portfolio.ts             122 lines
A  apps/web/src/api/portfolio.test.ts        230 lines
A  apps/web/src/routes/AdminPortfolio.tsx    440 lines
A  apps/web/src/routes/AdminPortfolio.test.tsx 374 lines
```

Tracked diff: 4 files, 173 insertions, 0 deletions; plus 4 new files. Every path
is inside the frontend surface the spec's §6 permits.

```text
git status --porcelain -- supabase/     →  (empty)
git diff --stat -- supabase/            →  (empty)
```

No migration, RPC, RLS policy, grant, SECURITY DEFINER function, auth
implementation, worker, scheduler, payment, settlement or WhatsApp file was
changed. §11 records one transient, fully reverted filesystem side effect.

---

## 7. Security Boundary

- **Token.** Every request carries the public anon key plus the **signed-in
  user's JWT** through the shared `callFunction`. `grep` of the built `dist/`
  bundle for `service_role` → 0 occurrences; no secret is reachable from the
  browser.
- **Server-side authorization.** `resolveAuth` → `requireRole` → the
  `GLOBAL_ACTIONS` check runs before any RPC. Non-`global_admin` callers receive
  403 before the tenant-free RPC is touched. Proven live in this phase on both
  environments (§10, §13).
- **Tenant header is not a privilege.** The header satisfies a contract
  requirement; it does not widen access, because both RPCs ignore it and
  `resolveAuth` treats a hospital the caller has no grant in as the global-admin
  path rather than as an escalation.
- **Client-supplied hospital IDs are never trusted** and none is invented: the
  value is either the authenticated session's own tenant or, in the documented
  §8 case, a value the server independently re-validates under RLS and role
  checks.
- **Unauthenticated and under-privileged callers.** Local runtime: anonymous
  bearer → 401; hospital_admin → 403; missing header → 422.
- **Read-only.** No mutation, no idempotency key, no write-capable path exists
  in this surface; audit and financial invariants are untouched.
- **Error honesty.** Failures are rendered through `describeError`; a 403 says
  the actor lacks permission and is never presented as an empty dashboard, and
  no stack trace, SQL fragment or secret reaches the UI.

---

## 8. X-Hospital-ID Fixture Resolution

Spec §5 proposed, conditionally, attaching the staging `global_admin` fixture to
a hospital as a reversible data-only change. **That route is not implementable
in this schema, and no fixture was mutated.**

The `user_roles` table carries the CHECK constraint
`role_hospital_consistency`:

```sql
((role = 'global_admin'    AND hospital_id IS NULL)
 OR
 (role <> 'global_admin'   AND hospital_id IS NOT NULL))
```

So the suggested change is blocked twice over:

1. The `global_admin` row itself can never hold a `hospital_id` — the update is
   rejected by the constraint. A schema change to allow it is exactly the
   permanent-authorization change §6 forbids.
2. Adding a *second*, hospital-scoped role row for the same user would
   successfully downgrade the resolved role: `resolveAuth` /
   `resolveStaffContext` would then answer with that hospital role and the
   `GLOBAL_ACTIONS` check would 403 the very request being enabled.

Resolution actually used — frontend-only, no data or privilege change: when the
authenticated account has no native tenant, the page performs **one** bounded
read of a single `hospitals` row through the browser's RLS-guarded client
(`order name asc, limit 1, maybeSingle`) and uses that id solely as the required
header value. RLS on `hospitals` is
`is_global_admin() OR user_has_hospital_access(id)`, so only an
already-authorized global admin can read anything at all, and the backend
independently re-authorizes the request. The page **discloses** this rather than
hiding it: the subtitle states the exact header value and says the account has
no hospital of its own while the figures below remain cross-hospital.

Cost of the workaround, stated plainly: one extra `GET /rest/v1/hospitals` per
page mount, never repeated, never polled (asserted by test and observed in the
network log).

The clean fix is a small backend contract change — accept a missing
`X-Hospital-ID` for the tenant-free `GLOBAL_ACTIONS`, or read the role from the
JWT before demanding a tenant. That is outside G-08's frontend-only boundary, so
it is **reported rather than performed**, and the UI degrades honestly to
"Waiting for the hospital context the analytics service requires…" if no context
can be resolved instead of fabricating data around the gap.

---

## 9. Tests

```text
apps/web/src/api/portfolio.test.ts              13 tests
apps/web/src/routes/AdminPortfolio.test.tsx     14 tests
apps/web/src/App.test.tsx                        +6 tests (G-08 routing boundary block)
                                                ───────────
                                                33 G-08 assertions
```

Wrapper: exact action bodies; optional dates mapped 1:1 and omitted when
absent; tenant present **only** in the header (`JSON.stringify(body)` asserted
not to match `/hospital/i`); no idempotency key; exactly one request per action
with two hospitals in the payload, proving no fan-out; verbatim payload
passthrough including `portfolio: null`; unchanged error propagation including
the 403; and the acting-context read pinned to one bounded `limit(1)`
`maybeSingle`, its failure converted to an `ApiError` (42501 → 403) rather than
a silent empty context.

Page: one call per action on mount with the session tenant and no context read
when a tenant already exists; loading states; server aggregates rendered as
returned (`total_hospitals` 2 with `active_hospitals` 1 — never a `.length`);
`0` vs `—` semantics; benchmark window and rows; legitimately empty portfolio;
NULL payload treated as no-data not error; partial failure isolated; 403 never
dressed as empty; acting-context success (resolved once, used, disclosed),
honest waiting state, and both failure modes; plus the idle-window guard:
**zero** further requests after load and exactly +2 on one explicit Refresh.

Routing: `global_admin` reaches `/admin/portfolio`; hospital_admin is redirected
to the Command Centre; receptionist and doctor reach their own surfaces; the nav
entry exists only for `global_admin` while Command Centre remains for the
hospital admin; G-03/G-05/G-06 routes unchanged.

---

## 10. Local Runtime Verification

Real local Supabase stack, real seeded data, no mocks.

**Environment integrity.** `supabase start` exited 0 while the Edge Runtime
container was **stopped** — precisely the F16-01 false positive
(`RestartPolicy=no`). Detected via `supabase status` reporting
`Stopped services: [… supabase_edge_runtime_setura …]` and confirmed by
`docker inspect`; corrected with `docker start supabase_edge_runtime_setura`,
after which real function execution was proven by HTTP rather than assumed from
an exit code.

**Direct HTTP against `http://127.0.0.1:54321` (login `root@setura.test`,
`postgrest_role=authenticated`):**

| Call | Result |
| --- | --- |
| `portfolio` as global_admin | **200** · `date=2026-09-30` · `total_hospitals=191` · `active_hospitals=191` · 191 rows |
| `benchmarks` as global_admin | **200** · window `2026-09-01 … 2026-09-30` · 191 rows |
| `portfolio` as hospital_admin | **403** FORBIDDEN "Portfolio analytics require global admin access" |
| `daily_operations` as the same hospital_admin | **200** (hospital scope not regressed) |
| `portfolio` with no `X-Hospital-ID` | **422** (the §5 friction, reproduced) |
| `portfolio` with the anon key as bearer | **401** |

Database census behind those numbers: 191 hospitals, 1264 bookings, exactly one
`global_admin` grant (`root@setura.test`, `hospital_id` NULL).

**Real browser against the production build** (`vite preview` on the built
`dist/`, port 4173, so React StrictMode's dev-only double invocation does not
distort the request counts):

- Nav shows "Global Portfolio" for `root@setura.test`.
- `/admin/portfolio` rendered: Reported date **2026-09-30**, Total hospitals
  **191**, Active hospitals **191**, 191 table rows (first two: *E1 Journey
  6981953 A*, *Surya Hospital*); benchmark line **Window: 2026-09-01 →
  2026-09-30** with 191 rows (first row *Surya Hospital* 381 bookings / 34
  completed / avg wait `—` / 517.6 / 8.9 / 1580).
- The disclosed context line read exactly: "Request context sent as the required
  tenant header: 4d60b28f-871d-4808-a5ce-06bbc139d21d — your account has no
  hospital of its own, so this one is used only to satisfy the header; the
  figures below are cross-hospital, not scoped to it."
- Network for that load: **2** POST to `executive-analytics` → **200, 200**
  (bodies `{"action":"portfolio"}` and `{"action":"benchmarks"}`), **1** GET
  `/rest/v1/hospitals` (`limit=1`) → 200, **0** `/auth/v1` calls (session
  restored), no `service_role` anywhere, origins limited to `localhost:4173` and
  `127.0.0.1:54321`.
- Console: **0 errors, 0 warnings, 0 logs**; no repeated or looping messages.
- Role denial in the browser: signed in as `admin@surya.test` → nav contains 10
  links and **not** "Global Portfolio"; direct navigation to `/admin/portfolio`
  redirected to `/admin` (Command Centre, live data) with **0**
  `executive-analytics` requests issued. Reproduced twice.

```text
Local runtime verdict: PASS — real portfolio and real benchmarks rendered,
real denial observed, network behaviour bounded, console clean.
```

---

## 11. Staging Deployment

Spec §20 Step 1 required a freshness check of the deployed
`executive-analytics` before any staging browser proof, with a STOP on drift and
no automatic redeploy. **Step 1 stopped the phase.**

```text
Staging project      setura-staging / gzcqasntcbqqmgsoikms (ap-south-1)
Staging frontend     https://setura-delta.vercel.app  (bundle /assets/index-D23ak40u.js)
executive-analytics  STATUS ACTIVE · VERSION 7 · UPDATED_AT 2026-09-20 16:38:02 UTC
CORS/env remediation commit 79b74f7 "Fix doctor directory and CORS issues" 2026-09-22
```

The deployed function therefore predates a security-relevant remediation that
lives in **its own** shared dependency tree. Two independent methods confirm the
drift, and they agree.

**Method A — deployed bundle vs source.** The deployed function was downloaded
into a scratch location and compared with `HEAD`. Identical:
`executive-analytics/index.ts`, `_shared/auth.ts`, `db.ts`, `errors.ts`,
`logger.ts`, `metrics.ts`, `response.ts`, `tracing.ts`, `validation.ts`.
Different: `_shared/cors.ts` and `_shared/env.ts` — the deployed copies lack the
fail-closed origin handling, the mandatory `Vary: Origin`, and the `apikey` /
`X-Client-Info` entries in `Access-Control-Allow-Headers`, and still hardcode a
production origin default in `env.ts`.

*Working-tree side effect, disclosed and reverted.* `supabase functions
download` exposes no output-directory flag and walks up to the linked project
root, so it wrote those two files into `supabase/functions/_shared/`. The
overwrite was detected immediately by `git status`, the deployed copies were
preserved for the comparison, and the local files were restored with
`git checkout -- supabase/functions/_shared/cors.ts supabase/functions/_shared/env.ts`.
Post-restore `git status --porcelain -- supabase/` is **empty** and
`git diff --stat -- supabase/` is **empty**: no backend file is changed by this
phase. This incident is also a second, independent confirmation that the drift
is real — the two files differ from source in a way that maps exactly onto the
2026-09-22 remediation.

**Method B — live preflight on staging.**

| Function | `access-control-allow-headers` | `vary` |
| --- | --- | --- |
| `executive-analytics` (v7, 2026-09-20) | `Authorization, Content-Type, Idempotency-Key, X-Correlation-ID, X-Request-ID, X-Hospital-ID` | `Accept-Encoding` |
| `enterprise-reports` (v8, 2026-09-29) | same **plus** `apikey, X-Client-Info` | `Accept-Encoding, Origin` |

`supabase-js` always sends `apikey` and `x-client-info` cross-origin, so the
browser's preflight asks for them; per the Fetch standard a preflight fails when
any requested header is absent from the response, so the real POST is never
sent. The drift is **material to G-08**, not cosmetic.

For completeness, the deployed capability itself is intact when CORS is not in
the way — server-to-server probes against staging, no browser involved:

| Call | Result |
| --- | --- |
| `portfolio` as `root@setura.test` | **200** · `date=2026-09-30` · `total_hospitals=5` · `active_hospitals=5` · 5 rows |
| `benchmarks` as `root@setura.test` | **200** · window `2026-09-01 … 2026-09-30` · 5 rows |
| `portfolio` as `admin@surya.test` | **403** FORBIDDEN "Portfolio analytics require global admin access" |
| `daily_operations` as `admin@surya.test` | **200** |

Staging carries 5 hospitals against 191 locally; both are real data for their
environment.

**Action deliberately NOT taken:** no `supabase functions deploy`, no
`vercel --prod`, no fixture mutation, no CORS workaround in the frontend. The
spec's STOP instruction and §6's boundary both forbid it, and a redeploy is a
deployment decision for the owner.

```text
executive-analytics deployment drift detected
Staging deployment/verification gate: BLOCKED
```

---

## 12. Staging Browser Verification

**NOT PROVEN — BLOCKED by §11.** Spec §20 Steps 3–5 (global-admin browser proof,
hospital-admin browser denial, receptionist/doctor browser denial) all require a
browser to call `executive-analytics` on staging, which the stale preflight
response prevents. The frontend cannot compensate without either weakening
security or spoofing a header value the backend re-validates, so no staging
browser claim is made.

What *was* established about staging: the deployed contract, response shapes and
role gate behave as the local stack does (§11 table), so once the function is
redeployed from current source the expected outcome is the locally-observed
one. That expectation is explicitly **not** recorded as a proof.

---

## 13. Role Isolation

| Layer | global_admin | hospital_admin | receptionist / doctor | Evidence class |
| --- | --- | --- | --- | --- |
| Route guard | reaches the page | redirected to `/admin` | redirected to own surface | UNIT VERIFIED (`App.test.tsx`) + locally runtime-verified for global_admin and hospital_admin |
| Nav entry | visible | absent (10 links, none of them "Global Portfolio") | absent | locally runtime-verified for both admin roles; UNIT VERIFIED for the rest |
| Edge Function role gate | 200 | 403 `FORBIDDEN` | 403 `ROLE_INSUFFICIENT` | INTEGRATION VERIFIED locally (HTTP + browser) and on staging (server-to-server); cited from the existing real-HTTP suite for receptionist |
| RPC EXECUTE grant | via `service_role` only | unchanged by this phase | unchanged | static source + migration 48 (no grant touched) |

No cross-tenant read path was introduced, no RLS policy or grant was weakened,
and no new authorization mechanism was invented; the existing
`RequireRole` / `resolveAuth` / `requireRole` chain is the whole story.

---

## 14. Network Evidence

Per explicit page load by `global_admin` on the local stack:

```text
POST /functions/v1/executive-analytics {"action":"portfolio"}   → 200
POST /functions/v1/executive-analytics {"action":"benchmarks"}  → 200
GET  /rest/v1/hospitals?select=id,name&order=name.asc&limit=1   → 200   (§8 context read, once per mount)
auth requests on the load: 0   (session restored from storage)
```

- **No polling / no loop:** ~38 s idle after load produced **0** new requests,
  no `/login` bounce, no re-render into a loading state.
- **No fan-out:** 191 hospitals in the payload, 2 function calls. One explicit
  Refresh produced exactly +2 calls and nothing else.
- **No privileged traffic:** no `service_role` string in the built bundle; only
  `localhost:4173` and `127.0.0.1:54321` origins were contacted.
- **No unrelated side effects:** no mutation, payment, refund, settlement,
  WhatsApp, worker or scheduler request was generated by this page.
- **Console clean:** 0 errors / 0 warnings / 0 logs on the portfolio route.

---

## 15. Regression Smoke

Narrow smoke against the live local stack for the shared files this phase
touched (`App.tsx`, `AppShell.tsx`, `types/api.ts`), deliberately not a
re-certification of closed work:

| Surface | Result |
| --- | --- |
| G-03 Command Centre `/admin` | rendered live (bookings today 21, completed 2, cancelled 11, `job_queue` pending 1771); 7 requests, all 200; console clean |
| G-05 Audit & Compliance `/admin/audit` | rendered live trail rows + integrity cards; 5 requests, all 200; console clean |
| G-06 Executive Reports `/admin/reports` | 6 on-demand report cards, date inputs present, no auto-fetch; 2 requests (session only), both 200; console clean |
| G-07 Staff booking reschedule | action rendering covered by the unchanged frontend suite (24 files / 279 tests) passing after the route/nav edits |
| Auth-loop guard | 11 dedicated tests pass; idle windows on two different routes produced 0 requests and no shell teardown/remount |
| Stray global analytics traffic on hospital-admin routes | 0 requests to `executive-analytics` across all three routes |

Local gate results, all after the final source state:

```text
deno task validate:migrations   63 files · 0 errors · 4 pre-existing [duplicate-objects] warnings (documented baseline)
npx tsc --noEmit                clean
npx vitest run --no-file-parallelism   24 test files · 279 tests · all passed
npx vite build                  126 modules · dist/assets/index-BXyEPeU1.js 517.92 kB · built 4.83 s
                                (pre-existing >500 kB chunk warning only)
```

Backend-side gates are structurally unaffected by this phase, and that is stated
rather than implied: `deno.json` excludes `apps/` from `fmt`, `lint` and
`check`, and excludes `**/*.md` from `fmt`, so the entire G-08 diff (4 modified
frontend files, 4 new frontend files, 1 new root report) is outside their scope
— no `supabase/`, `tests/` or `scripts/` file was changed. `deno fmt --check`
repo-wide currently reports **7** pre-existing unformatted files (`c1_cancel_pre_state.json`,
`.vercel/project.json`, `_patch_root.json`, `_authloop_served_bundle.js`,
`tests/integration/consultation_notes_read.test.ts` and
`supabase/functions/_shared/{cors,env}.ts`); the last two are byte-identical to
`HEAD` (`git status --porcelain -- supabase/` empty), so this is an existing
repository condition, not a G-08 regression, and `fmt` was deliberately not run
because it rewrites files (§2). The AGENTS.md §13 note describing the `fmt:check`
baseline as "exactly 8 root markdown files" is stale twice over: markdown is now
excluded by configuration and the failing set is these 7 files.

---

## 16. Known Limitations

1. **Staging is unreachable for this surface from a browser** until
   `executive-analytics` is redeployed from current source (§11). This is the
   single blocking limitation.
2. **The header friction of spec §5 is still real.** G-08 absorbs it with one
   bounded RLS read plus an honest waiting state; the correct fix is a backend
   contract change that was out of scope here.
3. **No pagination or virtualisation on the portfolio tables** — the RPC returns
   every hospital, so the local environment renders 191 + 191 rows (382 `<tr>`
   nodes). Acceptable at current scale; a platform-wide growth concern, not a
   G-08 defect, and adding client-side paging would be a new capability rather
   than a thin surface.
4. **`sla_status` `no_data` and NULL are visually distinct but both non-actionable**
   in this read-only view; no SLA drill-down exists.
5. **No date/window picker.** The spec called for a thin surface, so the RPC
   defaults are used and reported verbatim; the wrapper already accepts the
   optional `date` / `fromDate` / `toDate` arguments if a later phase wants them.
6. **Observed, not caused, not reopened:** during the local browser work a second
   rapid password login for `admin@surya.test` produced a `profiles` read that
   returned 401 while `user_roles` returned 200, leaving the shell on "No staff
   role is attached to this account" until a manual reload. It looks like a
   post-login token-application race in the closed auth area. G-08 did not touch
   `AuthProvider` and does not re-audit it; recorded here so it is not silently
   lost.
7. **Environment note (F16-01 confirmed again):** `supabase start` can exit 0
   with the Edge Runtime down. Any runtime verification must check the stopped
   services list rather than the exit code.

---

## 17. Production Status

```text
PRODUCTION NOT TOUCHED
```

No production project was addressed by any command in this phase. Every write
target was the local stack or `setura-staging`; the Vercel staging alias was
read-only inspected. No production deployment, secret, migration or data change
occurred.

---

## 18. Final Acceptance Matrix

| # | Gate | Status |
| --- | --- | --- |
| 1 | Auth-loop fix atomically committed and pushed, separate from G-08 | PASS (`18cfefc`) |
| 2 | G-08 frontend implemented (thin, read-only, `global_admin` only) | PASS |
| 3 | No unnecessary backend change; no SQL/RLS/grant change | PASS (`supabase/` clean) |
| 4 | §5 fixture mutation avoided without a schema change | PASS (deviation reported, §8) |
| 5 | API wrapper tested | PASS (13 tests) |
| 6 | UI tested (loading / data / empty / error / honesty) | PASS (14 tests) |
| 7 | Role isolation tested | PASS (6 routing tests + runtime denial) |
| 8 | Local typecheck | PASS |
| 9 | Local frontend tests (sequential) | PASS (24 files / 279 tests) |
| 10 | Local build | PASS |
| 11 | Real local HTTP / runtime proof | PASS |
| 12 | Real portfolio data rendered | PASS (191 hospitals) |
| 13 | Real benchmarks rendered | PASS (window 2026-09-01 → 2026-09-30) |
| 14 | Network behaviour bounded (no polling / fan-out / privileged traffic) | PASS |
| 15 | Console clean | PASS |
| 16 | Auth-loop regression guard | PASS |
| 17 | G-03 / G-05 / G-06 / G-07 narrow regression smoke | PASS |
| 18 | Staging deployment freshness check (§20 Step 1) | FAIL — drift detected → STOP |
| 19 | Global-admin staging browser proof | BLOCKED (gate 18) |
| 20 | Hospital-admin staging browser denial | BLOCKED (gate 18); backend denial separately proven server-to-server on staging |
| 21 | Receptionist/doctor staging access remains blocked | UNPROVEN on staging (unit-verified guard; backend gate cited from the existing integration suite) |
| 22 | Production untouched | PASS |
| 23 | Final report written, git state documented | PASS (this document) |

---

## 19. Final Status

```text
BLOCKED
```

Exact reason: **`executive-analytics` deployment drift detected** on
`setura-staging` (`gzcqasntcbqqmgsoikms`) — deployed version 7 dated
2026-09-20 16:38:02 UTC predates the 2026-09-22 CORS/`env` remediation inside
that function's own bundle, and its live preflight omits `apikey` and
`X-Client-Info`, so a browser cannot call it. Spec §20 Step 1 therefore required
a STOP with no automatic redeploy, which blocks spec §20 Steps 3–5 and the
"Global admin staging proof PASS / Hospital admin staging denial PASS" gates of
§27.

Per §27, `PROVEN STAGING — CLOSED` is **not** claimed.

Component statuses, so nothing is overstated or understated:

```text
G-08 frontend implementation      INTEGRATION VERIFIED (locally, real stack)
G-08 local runtime acceptance     PASS
G-08 staging browser acceptance   BLOCKED — executive-analytics deployment drift detected
Production                        NOT TOUCHED
```

Unblocking is one authorized deployment action, not a code change:
redeploy `executive-analytics` from current source to `setura-staging`, then
re-run spec §20 Steps 3–5 and §21 against
`https://setura-delta.vercel.app`. The G-08 frontend requires no further edit
for that path, and the locally-verified behaviour is the expected result.
