# SETURA — Phase 7 Controlled Staging Validation
## Notifications / WhatsApp Delivery Status UI — Staging Validation Report

Evidence classification legend used below (per brief §20): PROVEN · IMPLEMENTED ·
PROVEN STAGING · PROVEN LOCAL · NOT OBSERVED · NOT TESTED · BLOCKED · UNPROVEN ·
NOT IMPLEMENTED · DEFERRED BY OWNER.

---

## 1. Objective

Validate the already-implemented, frontend-only Notifications / WhatsApp
Delivery Status UI against the **existing** SETURA staging environment via a
real deployment and a real browser walkthrough. This task adds no feature work;
it only proves (or honestly fails to prove) the existing surface in staging.

Local implementation was previously reported as typecheck PASS, 68/68 tests
PASS, build PASS, secret scan PASS (see
`PHASE_7_NOTIFICATIONS_DELIVERY_STATUS_UI_IMPLEMENTATION_REPORT.md`). The gap
this run closes is **staging deployment + real browser validation**.

## 2. Scope

In scope and executed: source reconciliation, git baseline capture, frontend
build/test/typecheck/secret-scan, deployment to the existing Vercel `setura`
project, deployed-bundle inspection, and a real (unmocked, un-intercepted)
browser walkthrough of role visibility, tenant scoping, UI states, read-only
behaviour, and console/network hygiene.

Out of scope and NOT touched: production deployment, production Supabase,
migrations, RLS, Edge Functions, RPCs, retry/resend/cancel actions, financial
logic, Razorpay, Meta/WhatsApp config, scheduler/worker, D5, D13. No fake
notification rows were created (brief §10/§20).

## 3. Exact Staging Environment

- Supabase project ref / backend host: `gzcqasntcbqqmgsoikms.supabase.co`
  → `https://gzcqasntcbqqmgsoikms.supabase.co` (matches brief §5).
- Vercel project: `setura` (project id `prj_PZq3TlY28vzz3hF6x0TKpvxK6gMH`,
  team `yeswantharasavallis-projects`). No new project was created.
- Frontend alias: `https://setura-delta.vercel.app` (unchanged).
- Verified from the linked Vercel production env: `VITE_SUPABASE_URL =
  https://gzcqasntcbqqmgsoikms.supabase.co`. Local `apps/web/.env.local` still
  points at the local `127.0.0.1:54321` dev stack and was never used by the
  deployed build (the deployment is a remote Vercel build using project env).

## 4. Git Baseline

Recorded before any deployment:

- `git branch --show-current` → `main`
- `git rev-parse HEAD` → `0ea036782d6e8d058a83c60d4fbed27deaa0f941` (matches
  expected `0ea0367`)
- `origin/main` → `0ea0367`
- `git log -1 --oneline` → `0ea0367 docs: reconcile payment status UX report
  with staging/browser validation`

The feature is intentionally **UNCOMMITTED**. Nothing was committed, pushed,
reset, cleaned, or history-rewritten (brief §4/§22). At the end of the run the
working tree was restored to the exact baseline set of changes:

```
 M apps/web/src/App.tsx
 M apps/web/src/api/reads.test.ts
 M apps/web/src/api/reads.ts
 M apps/web/src/components/AppShell.tsx
?? apps/web/src/lib/notificationStatus.ts        (+ .test.ts)
?? apps/web/src/routes/Notifications.tsx          (+ .test.tsx)
?? PHASE_7_* investigation/implementation reports (pre-existing, untouched)
```

Note: the root-level `vercel link` used for deployment appended `.vercel` /
`.env.local` to the tracked `.gitignore` and created root link artifacts. These
were tooling side effects, not part of the feature; `.gitignore` was reverted
and the root `.vercel` / `.env.local` were removed so the tree matches baseline
(the pre-existing `apps/web/.vercel` was left intact).

## 5. Source Reconciliation (brief §3)

Re-verified against actual current source, not the report:

- **A. Files in use** — present and wired: `apps/web/src/api/reads.ts`,
  `apps/web/src/lib/notificationStatus.ts`, `apps/web/src/routes/Notifications.tsx`,
  `apps/web/src/App.tsx`, `apps/web/src/components/AppShell.tsx`.
- **B. Single read surface** — `listNotifications()` in `reads.ts` reads **only**
  `public.notification_queue` (`.from("notification_queue").select(...)`); no
  `whatsapp_messages` merge (brief §11 respected).
- **C. No new secrets/credentials** — no `service_role`, provider tokens, webhook
  secrets, WhatsApp/Meta/payment credentials introduced in the phase source. The
  only `access_token` reference is the standard Supabase session JWT.
- **D. Session-derived tenant, RLS boundary** — `Notifications.tsx` uses
  `useAuth().hospitalId` (never a client route param); `reads.ts` adds a
  defensive `.eq("hospital_id", hospitalId)` while the comment and behaviour
  treat RLS (`notif_queue_admin`, migration 05) as the actual boundary.
- **D. Role/navigation** — `AppShell.tsx` nav item "Notifications" is gated to
  `receptionist, hospital_admin, global_admin` and does **not** list `doctor`.
  `App.tsx` guards `/reception/notifications` with `RequireRole
  roles={[...RECEPTION_ROLES]}`; `RequireRole.tsx` additionally allows
  `global_admin`.
- **D. Status labels** — `notificationStatus.ts` maps exactly the backend enum
  (pending, queued, processing, sent, delivered, read, failed, retrying,
  cancelled, permanently_failed) and degrades unknown values honestly. No
  invented status.
- **E. Backend untouched** — `git status` shows zero changes under
  `supabase/`; backend remains untouched for this phase.

**Status: IMPLEMENTED / PROVEN (static source reconciliation).** Source matches
the implementation report; no material drift found.

## 6. Vercel Deployment Evidence (brief §7)

- Method: remote Vercel build (`vercel deploy --prod`) from the repo root, which
  honours the project's configured Root Directory `apps/web`. A first attempt
  from inside `apps/web` failed cleanly with "Root Directory apps/web does not
  exist" (misplaced upload root, not a code/config change) and was corrected.
- Build log (remote): `tsc --noEmit && vite build`, 113 modules transformed,
  output `dist/assets/index-DCO78ejs.js` (463,042 bytes), status **READY**.
- Deployment URL: `https://setura-am4hjprls-yeswantharasavallis-projects.vercel.app`
- Aliased to: `https://setura-delta.vercel.app`
- No new Vercel project created; no env vars, domain, or backend configuration
  changed.

**Status: PROVEN STAGING (deployed, READY, correct alias).**

## 7. Browser Evidence (brief §8–§16)

Real browser against `https://setura-delta.vercel.app`, no mocked responses, no
interception, using the documented deterministic staging seed identities
(password `Setura@123`). Each role was logged out (`POST /auth/v1/logout` → 204)
before the next.

| Session | Result |
| --- | --- |
| `reception@surya.test` (receptionist, Tenant A `…0001`) | Login 200 → `/reception`; banner "Ravi Kumar", role `receptionist`. "Notifications" present in nav (6 items). `/reception/notifications` renders **"No notifications found."** — 0 tables, 0 errors. `notification_queue` GET → **200**, body `[]`. |
| `admin@surya.test` (hospital_admin, Tenant A) | Login OK; "Notifications" present and accessible; renders "No notifications found." |
| `dr@surya.test` (doctor) | Nav shows **only** "Doctor Console" — **no Notifications**. Direct address-bar load of `/reception/notifications` → client-side **redirect to `/doctor`**; **zero** `notification_queue` requests issued. |
| `reception-b@surya.test` (receptionist, Tenant B `…0002`) | "Notifications" accessible; request scoped `hospital_id=eq.…0002` → 200, `[]`. |
| `root@setura.test` (global_admin) | Hospital slot "no tenant"; `/reception/notifications` → **"No hospital tenant attached."** (component early-return, no query). No cross-tenant view. |

**Status: PROVEN STAGING for auth, nav visibility, route guard, and empty/error
branch routing.**

## 8. Notification Records Observed (brief §9/§10)

`notification_queue` returned **0 rows** for every tenant tested (Tenant A and
Tenant B). The populated table (column headers, per-row Channel/Status badges,
Retries, timestamps, `last_error`) was therefore **NOT OBSERVED** in the live
browser — staging simply has no notification rows. No records were fabricated
(brief §10). The empty state "No notifications found." rendered correctly, and
it is distinct from the error branch ("Could not load notifications." +
`role="alert"`), which did not trigger.

**Status: NOT OBSERVED (no existing `notification_queue` records in staging).**

## 9. WhatsApp Records Observed (brief §11)

WhatsApp-bound sends are surfaced through the `channel` column of
`notification_queue` (no `whatsapp_messages` merge). Because
`notification_queue` returned 0 rows, there were **no WhatsApp rows to observe**.
WhatsApp visibility is therefore **IMPLEMENTED + NOT OBSERVED IN STAGING** — it
is **not** upgraded to PROVEN (brief §21).

**Status: WHATSAPP RECORDS = NOT OBSERVED.**

## 10. Role Visibility (brief §12)

- RECEPTIONIST — route accessible: **PROVEN STAGING**.
- HOSPITAL_ADMIN — route accessible: **PROVEN STAGING**.
- GLOBAL_ADMIN — follows existing RequireRole/global-admin behaviour; renders
  "No hospital tenant attached." with no query (no hospital context): **PROVEN
  STAGING**.
- DOCTOR — no Notifications nav item, and direct navigation is redirected to
  `/doctor` with no data call: **PROVEN STAGING**. No authorization code was
  modified for this test.

## 11. Tenant Isolation (brief §13)

The security boundary is `notification_queue` RLS, not the client filter. Each
authenticated session issued a `notification_queue` GET carrying **only its own**
`hospital_id` filter (`…0001` for Tenant A, `…0002` for Tenant B), with a valid
publishable `apikey` + session JWT, and each returned 200. Tenant A's rows could
not appear under Tenant B's query.

Honest limitation: because **both** tenants had 0 rows, a positive cross-tenant
leak could not be demonstrated either way in the live UI — only that the request
is correctly RLS-scoped per session. The client-side `hospital_id` filter is
treated as defensive, never as the boundary (brief §13). No isolation failure was
observed; no frontend patch was needed.

**Status: PROVEN STAGING at the request-scoping level; cross-tenant row
differential = NOT OBSERVED (empty source data).**

## 12. Loading / Empty / Error States (brief §14)

- Loading — the component's `Loading…` branch exists and fires elsewhere, but on
  the notifications page the read resolved faster than one frame, so a live
  loading flash was **NOT OBSERVED**.
- Empty — **PROVEN STAGING**: "No notifications found." for zero-row tenants.
- Error — not induced (brief §14 forbids damaging staging to force it); the
  dedicated error branch is distinct from empty and is covered by the existing
  unit test. **NOT TESTED** in browser by design.
- Long `last_error` — **NOT OBSERVED** (no rows carry an error). The component
  truncates `last_error` (`max-w-[16rem] truncate` + `title`), verified
  statically only.

## 13. Read-Only Verification (brief §15)

The live notifications `main` region contained **0** interactive controls — no
Retry, Resend, Cancel, Replay, Force delivery, Change status, Dead-letter replay,
or WhatsApp resend. The only in-row link is "View booking" (a read navigation).
Deployed-bundle inspection confirmed the component performs only a `.select()`
on `notification_queue` (0 `insert/update/delete/upsert`).

**Status: PROVEN STAGING (read-only).**

## 14. Console / Network Results (brief §16)

- Application console errors: **0** across all five sessions.
- App-origin 4xx/5xx to Supabase: **0** (all 200; logout 204).
- CORS failures: **0** (cross-origin `OPTIONS` preflights returned 200).
- All application API traffic went to `gzcqasntcbqqmgsoikms.supabase.co`;
  static assets to `setura-delta.vercel.app`; **0 requests to `localhost` /
  `127.0.0.1`**. Only non-2xx entries were same-origin 304 cache
  revalidations (normal).

**Status: PROVEN STAGING.**

## 15. Secret / Bundle Scan (brief §6/§17)

- Local build secret scan: `3 artifact(s), 0 source map(s) → 0 secret hit(s)`
  (run twice: pre-deploy and post-validation regression).
- Deployed bundle inspection (`index-DCO78ejs.js`): the **only** Supabase host
  baked in is `gzcqasntcbqqmgsoikms.supabase.co`; `service_role` → **0** hits.
- The `localhost` / `127.0.0.1` substrings present in the bundle are stock
  `@supabase/supabase-js` internals (a legacy GoTrue constant, a hostname
  validation helper, and an allowlist pattern) — **not** an application backend
  endpoint. Confirmed by context extraction and by the live network log showing
  zero localhost traffic.
- Publishable/anon key present in traffic (`sb_publishable_…`) — public by
  design; no service-role key, Razorpay/Meta/SMTP/worker/cron/Vault credential
  present. No secret values reproduced here.

**Status: PROVEN LOCAL (scan) + PROVEN STAGING (deployed bundle + live
network).**

## 16. Regression Results (brief §19)

Re-run after staging validation (source unchanged):

- `npm run typecheck` → PASS.
- `npm test` → **68/68 passed** (9 files, incl. `Notifications.test.tsx` 8 tests).
- `npm run build` → PASS (pre-deploy; remote build also READY).
- `deno run ... check_frontend_secrets.ts dist --deny-sourcemaps` → 0 secret
  hits, 0 source maps.

No tests were modified to force green.

## 17. Defects Found

No functional defects were observed in staging for the implemented surface.
One environment/tooling note (not a product defect): the deployment must be run
from the repository root to match the project's configured Root Directory
`apps/web`; deploying from inside `apps/web` fails the build with a clear error
and changes nothing.

## 18. Limitations

- Staging `notification_queue` is **empty**, so the populated table, status
  badge rendering on real rows, WhatsApp row rendering, and long-`last_error`
  truncation are **NOT OBSERVED** live (only statically verified). Per brief
  §10/§20 these were **not** fabricated.
- Because both tenants had 0 rows, tenant isolation is proven at the
  request-scoping level but a positive cross-tenant differential was **NOT
  OBSERVED**.
- The error state was intentionally **NOT TESTED** in the browser (forcing it
  would require damaging staging).
- The transient "Loading…" flash was not captured on the fast local-network
  read.
- STAGING ≠ PRODUCTION: nothing here certifies production, which is not
  deployed.

## 19. Exact Evidence Classification

| Surface | Classification |
| --- | --- |
| Source reconciliation (files, single-surface read, RLS boundary, role gating, status map) | PROVEN (static) / IMPLEMENTED |
| Frontend typecheck / 68 tests / build / secret scan | PROVEN LOCAL |
| Staging deployment (READY, correct alias, existing project) | PROVEN STAGING |
| Deployed bundle (staging host only, anon key only, no service_role) | PROVEN STAGING |
| Receptionist / hospital_admin Notifications visibility + route access | PROVEN STAGING |
| Doctor blocked (no nav, direct URL → redirect, 0 data calls) | PROVEN STAGING |
| Global-admin "no hospital tenant" handling | PROVEN STAGING |
| Read-only (no action controls, live + bundle) | PROVEN STAGING |
| Console / network hygiene (0 errors, 0 localhost, all→staging) | PROVEN STAGING |
| Empty state ("No notifications found.") | PROVEN STAGING |
| Tenant request scoping (per-session hospital_id filter) | PROVEN STAGING |
| Populated table / status badges / WhatsApp rows / long error | NOT OBSERVED (no staging rows) |
| Cross-tenant row differential | NOT OBSERVED (both tenants empty) |
| Browser error state | NOT TESTED (by design) |
| Backend (migrations/RLS/RPC/Edge) changes | NOT IMPLEMENTED (out of scope) |
| Production | UNPROVEN (no production deployment) |
| D5 backup/DR, D13 production domain | DEFERRED BY OWNER (not reopened) |

## 20. Final Conclusion

The Notifications / WhatsApp Delivery Status UI is **deployed to the existing
staging environment and PROVEN STAGING** for its real, observable behaviour:
authentication, role-gated navigation (receptionist / hospital_admin /
global_admin in; doctor out), route-guard redirect, read-only rendering, empty
state, correct backend host, tenant-scoped RLS request, and clean console /
network / secret posture.

The data-dependent surfaces — a populated delivery table, per-row status badges,
WhatsApp-bound row visibility, and long-`last_error` truncation — are
**IMPLEMENTED + NOT OBSERVED IN STAGING**, because `notification_queue` holds no
rows for the tested tenants. These were not fabricated and are **not** upgraded
to PROVEN. This is honest staging evidence, not a production certification.

**Overall feature classification: PROVEN STAGING (read-only control surface) /
NOT OBSERVED (populated + WhatsApp data rendering) / UNPROVEN (production).**

---

## Final Response Summary

- **A. Implementation:** Unchanged this task; source reconciliation confirms the
  read-only `notification_queue`-only surface, session-derived tenant, RLS
  boundary, role gating, and exact backend status enum. PROVEN (static).
- **B. Staging deployment:** Remote Vercel build to the existing `setura`
  project → READY, aliased `https://setura-delta.vercel.app`. PROVEN STAGING.
- **C. Browser validation:** Real browser, 5 role/tenant sessions, no mocking.
  Auth, nav visibility, doctor redirect, global-admin no-tenant, and empty state
  all behaved correctly. PROVEN STAGING.
- **D. Notification records:** `notification_queue` returned 0 rows for all
  tenants → populated table NOT OBSERVED (not fabricated).
- **E. WhatsApp records:** NOT OBSERVED (0 rows); IMPLEMENTED only.
- **F. Tenant isolation:** Per-session request correctly scoped to its own
  `hospital_id` under RLS (PROVEN STAGING); positive cross-tenant differential
  NOT OBSERVED (both tenants empty).
- **G. Console/network:** 0 app console errors, 0 CORS failures, 0 app 4xx/5xx,
  0 localhost traffic; all API calls to `gzcqasntcbqqmgsoikms.supabase.co`.
- **H. Secret scan:** 0 secret hits, 0 source maps; deployed bundle has only the
  staging Supabase host + publishable key, 0 `service_role`.
- **I. Regression:** typecheck PASS, 68/68 tests PASS, build PASS, secret scan
  PASS (re-run after validation; no tests weakened).
- **J. Defects:** None functional. Tooling note: deploy must run from repo root
  to match the project's Root Directory `apps/web`.
- **K. Production:** UNPROVEN — no production deployment; D5/D13 remain DEFERRED
  BY OWNER and were not reopened.
- **L. Git:** HEAD `0ea0367` = `origin/main`; feature left intentionally
  uncommitted; nothing committed/pushed; working tree restored to baseline
  (tooling's accidental `.gitignore`/root-link edits reverted and removed).
- **M. Final classification:** **PROVEN STAGING** for the read-only control,
  navigation, authorization, empty-state, network and secret surfaces;
  **NOT OBSERVED** for populated/WhatsApp data rendering (no staging rows);
  **UNPROVEN** for production. Not overclaimed as fully certified or
  production-ready.
