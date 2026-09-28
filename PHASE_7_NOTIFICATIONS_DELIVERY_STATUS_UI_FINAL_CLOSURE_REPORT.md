# SETURA — Notifications / WhatsApp Delivery Status UI
## Final Git Reconciliation, Commit, Push & Deployment Verification — CLOSURE REPORT

Phase: 7 · Step: final source-control closure
Task: commit + push the already-validated read-only Notifications / delivery-status
UI, verify the resulting remote and Vercel deployment state, and close the phase.
No feature work was performed in this task.

Execution date: 2026-09-24 · Executed under the brief
`PHASE_7_NOTIFICATIONS_DELIVERY_STATUS_UI_FINAL_CLOSURE_REPORT.md` (spec §§1–20).

---

## 1. Previous baseline commit

Verified before any mutation (brief §2):

| Check | Value |
| --- | --- |
| Branch | `main` |
| `HEAD` | `0ea036782d6e8d058a83c60d4fbed27deaa0f941` |
| `origin/main` | `0ea036782d6e8d058a83c60d4fbed27deaa0f941` |
| Baseline commit subject | `docs: reconcile payment status UX report with staging/browser validation` |

Baseline matched the expected `0ea0367` exactly. The working tree was **not**
clean, as expected: 4 modified tracked files plus 4 new source/test files and
several untracked reports.

## 2. Feature commit

| Field | Value |
| --- | --- |
| SHA | `037bcf10c8387452ed7d8dc9c60a83b7f7052f62` |
| Subject | `feat: add notifications delivery status UI` |
| Parent | `0ea036782d6e8d058a83c60d4fbed27deaa0f941` — the expected previous `main` commit |
| Files changed | 10 |
| Insertions / deletions | 1166 / 6 |
| History rewriting | none — no amend, no rebase, no squash |
| Push | normal `git push origin main` → `0ea0367..037bcf1 main -> main`; no `--force`, no `--force-with-lease` |

## 3. Exact files committed

Source / tests (staged by explicit path; `git add .` was never used):

| File | Change |
| --- | --- |
| `apps/web/src/App.tsx` | +9 |
| `apps/web/src/api/reads.ts` | +54 / −6 |
| `apps/web/src/api/reads.test.ts` | +37 / −1 |
| `apps/web/src/components/AppShell.tsx` | +1 |
| `apps/web/src/lib/notificationStatus.ts` | new, +64 |
| `apps/web/src/lib/notificationStatus.test.ts` | new, +72 |
| `apps/web/src/routes/Notifications.tsx` | new, +171 |
| `apps/web/src/routes/Notifications.test.tsx` | new, +152 |

Phase 7 evidence documentation (consistent with repository precedent: 22
`PHASE_7_*.md` reports were already tracked at baseline):

| File | Change |
| --- | --- |
| `PHASE_7_NOTIFICATIONS_DELIVERY_STATUS_UI_IMPLEMENTATION_REPORT.md` | new, +249 |
| `PHASE_7_NOTIFICATIONS_DELIVERY_STATUS_UI_STAGING_VALIDATION_REPORT.md` | new, +357 |

`git diff --cached --check` and `git diff --check`: clean (exit 0, no whitespace
errors). The staged diff was inspected in full and contained only the
Notifications frontend, its tests and the two Phase 7 reports.

### Scope confirmation (brief §5)

Diff inspection confirmed the committed change contains **only** the previously
validated scope: the `notification_queue` read surface, the status→label/colour
mapping, the Notifications page, its route, its navigation entry, tests, and the
stale-comment correction in `reads.ts` (`notifications` removed from the
"no staff SELECT policy" list, migration-05 `notif_queue_admin` policy
documented).

No retry / resend / cancel / replay / status mutation / WhatsApp sending /
messaging command centre / analytics / provider integration was introduced.
`Notifications.tsx` owns no write path (`listNotifications` is the only data
call; the component renders a table with no action controls), and
`Notifications.test.tsx` asserts this explicitly:

> `it("is read-only: renders no retry/resend/cancel action controls", ...)` —
> asserts `Retry`, `Resend`, `Cancel`, `Replay` labels are absent.

The "retry"/"cancelled" tokens found in `notificationStatus*.ts` are backend
`notification_status` enum labels only, not operations.

## 4. Backend unchanged — CONFIRMED

| Check | Result |
| --- | --- |
| `git diff -- supabase/` | empty |
| `git status --short -- supabase/` | empty (no modified, no untracked) |
| Migrations | none added or changed |
| Edge Functions | none added or changed |
| RPCs | none added or changed |
| RLS policies | none added or changed |
| SECURITY DEFINER functions | none created or resignatured |
| Backend authorization | unchanged |
| Notification engine | unchanged |

The feature is frontend-only, as designed. The F16-04 obligation (a new or
resignatured SECURITY DEFINER function needs its own explicit `REVOKE`) is not
triggered by this commit because no function was created or altered.

## 5. Tests / typecheck / build

Run from `apps/web` before staging (brief §7):

| Gate | Result |
| --- | --- |
| `npm run typecheck` (`tsc --noEmit`) | **PASS** (no output, clean) |
| `npm test` (`vitest run`) | **PASS** — Test Files 9 passed (9), Tests **68 passed (68)** |
| `npm run build` (`tsc --noEmit && vite build`) | **PASS** — 113 modules transformed; `dist/index.html` 0.43 kB, `dist/assets/index-Box_NEHw.css` 13.57 kB, `dist/assets/index-BEvRW9c9.js` 463.22 kB (gzip 131.91 kB), built in 3.13 s |

The 68-passing-test count equals the pre-existing declared baseline — no test was
added beyond the Notifications suites already validated in staging, and none was
deleted, skipped or weakened. `src/routes/Notifications.test.tsx` contributes 8
tests, all passing.

## 6. Secret scan

Authoritative repository scanner, run against the build output:

```
deno run --allow-read ../../scripts/check_frontend_secrets.ts dist --deny-sourcemaps
Frontend secret scan: 3 artifact(s) in dist, 0 source map(s)
Result: 0 secret hit(s), 0 source map(s) (sourcemaps denied)
```

Not committed (brief §6): `.env`, `.env.local`, `.vercel/`, `dist/`, scratch
files, temporary browser evidence, automation artifacts. Verified by the staged
set in §3 — none of these paths appears.

Both committed reports were scanned for credential material before staging. One
match was found and is recorded honestly rather than being hidden:

- `PHASE_7_NOTIFICATIONS_DELIVERY_STATUS_UI_STAGING_VALIDATION_REPORT.md` §7
  names the deterministic **seed** password `Setura@123` used for the
  five-account browser walkthrough. This is not new exposure introduced by this
  commit: the identical value is already tracked in the baseline at
  `supabase/seed.sql`, `apps/web/src/routes/Login.tsx`,
  `apps/web/e2e/core_journey.mjs` and two integration tests. The report text was
  **not** edited, because the brief designates it historical evidence and
  redaction would alter that record. Flagged here for the owner's awareness; if
  the policy is that no plaintext credential may live in documentation, the
  correct fix is a separate task that also addresses the already-tracked source
  occurrences.

No access tokens, private API keys, session tokens or secret values were found in
either report.

## 6a. Independent pre-push security review

Because this task ends in a push to `main`, an L3 deep committed-change security
review was run against `037bcf1` before pushing.

Result: **0 findings.** No issues were reported and therefore no remediation was
required or performed.

## 7. Staging validation reference

The authoritative functional evidence remains
`PHASE_7_NOTIFICATIONS_DELIVERY_STATUS_UI_STAGING_VALIDATION_REPORT.md`, produced
before this commit. Its classifications were **not** upgraded by committing or
redeploying (brief §17).

Per brief §16, the five-account browser walkthrough was **not** repeated: the new
deployment is built from the same committed source and the same existing project
configuration (see §9/§10 — proven by the new-source-only route string being
present in the deployed bundle). Only the minimal post-deployment smoke check was
run.

## 8. Vercel deployment

| Field | Value |
| --- | --- |
| Project | `setura` (existing; no project created) |
| Deployment ID | `dpl_C2GQFkyHGu5zMCv8vR5GxTVHEAcv` |
| Deployment URL | `https://setura-ovhhzlp9g-yeswantharasavallis-projects.vercel.app` |
| Ready state | **READY** |
| Target / environment | `production` |
| Created | Thu Sep 24 2026 21:35:02 IST — triggered by the push of `037bcf1` |
| Build duration | `timeToReady` 14 447 ms |
| Build | `bld_nixgr52a0`, entrypoint `.`, `@vercel/vc-build`, READY |
| Aliases | `setura-delta.vercel.app`, `setura-yeswantharasavallis-projects.vercel.app`, `setura-git-main-yeswantharasavallis-projects.vercel.app` |
| Alias preserved | **YES** — `setura-delta.vercel.app` still resolves to the new deployment and serves its bundle |
| Environment variable changes | none — no `vercel env` mutation was executed by this task; the deployment used pre-existing project configuration |
| Domain changes | none |
| Backend changes | none |

Minimal post-deployment smoke check (brief §16 — deliberately not a re-audit):

| Route | Status |
| --- | --- |
| `https://setura-delta.vercel.app/` | 200 |
| `https://setura-delta.vercel.app/login` | 200 |
| `https://setura-delta.vercel.app/reception/notifications` | 200 |

No deployment-level failure. The `Error`-state deployment visible in the project
listing is a 21-minute-old prior artifact from the earlier staging-validation
session and is not the alias-bearing deployment; it was not caused by this commit
and no application code was modified in response to it.

## 9. Deployed bundle verification

Fetched live from the alias, not from disk. Deployed entry:
`/assets/index-DCO78ejs.js`, 463 042 bytes.

**Correspondence to committed source** — strings that exist only in this commit:

| Marker | Present in deployed bundle |
| --- | --- |
| `/reception/notifications` (new route) | YES |
| `Notifications` (nav/heading) | YES |
| `Read-only delivery status` (subtitle) | YES |
| `Delivery status` (card title) | YES |
| `No notifications found.` (empty state) | YES |
| `notification_queue` (read surface) | YES |
| `permanently_failed` (status mapping) | YES |

**Backend boundary:** exactly one Supabase host is baked in —
`gzcqasntcbqqmgsoikms.supabase.co`, the expected staging project. No other host.

**Negative checks (all clean):**

| Item | Result |
| --- | --- |
| `service_role` | 0 hits |
| Razorpay secret (`sk_test` / `sk_live` / `rzp_test` / `rzp_live`) | 0 hits |
| Meta / WhatsApp credential | 0 hits |
| SMTP credential | 0 hits |
| Worker / cron secret (`WORKER_SECRET`, `CRON_SECRET`) | 0 hits |
| Vault credential | 0 hits |
| JWT-shaped bearer tokens (`eyJ…`) | 0 hits |
| Long secret/token/password assignments | 0 hits |
| Source maps (`sourceMappingURL`) | 0 hits; `…index-DCO78ejs.js.map` → HTTP 403 (not served) |

No secret values were printed at any point.

**One classified false positive, recorded rather than glossed:** a substring
search for `sb_secret` matched once in the deployed bundle. It is a **10-character
bare prefix literal** (`sb_secret_`, immediately followed by a quote) inside
`@supabase/supabase-js` key-format detection code — `e.startsWith("sb_publishable_")
|| e.startsWith("sb_secret_")` — carrying no key material. The identical literal
is present in the locally built bundle that the repository scanner certified at 0
secret hits. The only real key material in the bundle is two occurrences of a
46-character `sb_publishable_…` value, i.e. the publishable (browser-public by
design) Supabase key supplied by existing Vercel project configuration.

**Deployed-vs-local bundle hash difference, explained:** Vercel built
`index-DCO78ejs.js` (463 042 B); the local build produced `index-BEvRW9c9.js`
(463 328 B). The difference is configuration injection, not source drift: the
local artifact bakes **no** Supabase host at all, while the deployed artifact
bakes the staging host and publishable key from Vercel project environment. This
confirms no local `.env.local` value travelled into the deployment.

## 10. Remote Git state

After `git fetch origin`:

| Check | Value |
| --- | --- |
| `HEAD` | `037bcf10c8387452ed7d8dc9c60a83b7f7052f62` |
| `origin/main` | `037bcf10c8387452ed7d8dc9c60a83b7f7052f62` |
| `HEAD == origin/main` | **YES** |
| Upstream tracking | `## main...origin/main` (no ahead/behind divergence) |
| Remote | `https://github.com/YeswanthArasavalli/Setura.git` |

## 11. Working tree state

No tracked file is modified, and no tooling artifact was left behind. Explicitly
checked and confirmed **unchanged**: `.gitignore`, `apps/web/.gitignore`,
`apps/web/package-lock.json`, `supabase/`, `apps/web/dist/` (ignored),
`.vercel/` (ignored). The `.gitignore` drift risk noted in brief §8 — previously
produced by Vercel linking during staging validation — is absent.

Remaining untracked, intentionally **not** committed (out of this feature's
scope; historical documents from other steps, left for their own closure
decisions):

- `PHASE_7_FEE_CONFIGURATION_INVESTIGATION_REPORT.md`
- `PHASE_7_LOCAL_ONLINE_PAYMENT_ORDER_VALIDATION_REPORT.md`
- `PHASE_7_NEXT_PRODUCT_GAP_INVESTIGATION_REPORT.md`
- `PHASE_7_ONLINE_NONZERO_PAYMENT_ORDER_VALIDATION_REPORT.md`
- `PHASE_7_PAYMENT_STATUS_UX_INVESTIGATION_REPORT.md`
- `PHASE_7_NOTIFICATIONS_DELIVERY_STATUS_UI_FINAL_CLOSURE_REPORT.md` (this report,
  written after the commit and push it documents; committing it would require a
  second commit, which brief §11/§9 did not authorise)

## 12. Evidence classification (unchanged by this task)

**PROVEN STAGING** — read-only control surface: role visibility
(receptionist / hospital_admin), doctor exclusion and redirect, global-admin
no-tenant handling, empty state, request scoping, RLS boundary usage,
console/network hygiene, deployed bundle security posture, no-action read-only
behaviour.

**NOT OBSERVED** — populated notification rows; real status-badge rendering;
WhatsApp rows; long `last_error` rendering; positive cross-tenant row
differential.

**NOT TESTED** — browser-induced error state.

**STATICALLY / LOCALLY VERIFIED IN THIS TASK** — typecheck, 68/68 unit tests,
production build, local secret scan, committed-source-to-deployed-bundle
correspondence, deployed-bundle negative security checks, remote Git equivalence,
L3 security review (0 findings). These are regression-and-artifact facts about
the shipped bundle; they do **not** convert any NOT OBSERVED item into an
observation. No data-dependent rendering was exercised: the smoke check fetched
HTML/asset bytes only and performed no authenticated read of `notification_queue`.

## 13. Remaining limitations

1. Data-dependent rendering (populated rows, badges, WhatsApp rows, long
   `last_error` truncation) remains unobserved; the staging tenant's
   `notification_queue` was empty during validation and no seed data was added.
2. A positive cross-tenant row differential was never observed — isolation is
   evidenced by request scoping plus the migration-05 `notif_queue_admin` RLS
   policy and by each tenant reading zero rows, not by a demonstrated
   A-has-rows / B-has-none differential. Empty results must not be read as
   proof of blocking.
3. Browser-induced error-state UI is untested.
4. The Notifications UI has never been exercised against a production backend.
5. No local Supabase stack was running for this task, so no integration test was
   executed here; the 68 tests are unit-level (`vitest`, jsdom).
6. `vercel env ls` / `vercel domains ls` returned no parseable listing in this
   session, so "no environment/domain changes" is asserted as *no mutation was
   performed by this task* plus *the deployment resolved the existing aliases* —
   not as a fully enumerated configuration inventory.

## 14. Production boundary

**Production: UNPROVEN.** Nothing in this task deployed to or verified a
production backend or production frontend beyond the existing Vercel alias that
points at the staging Supabase project. No production secrets, hosts or data
were touched. `PRODUCTION VERIFIED` is not claimed anywhere in this report.

## 15. Deferred decisions

- **D5 — DEFERRED BY OWNER.**
- **D13 — DEFERRED BY OWNER.**

Neither was reopened, advanced or resolved by this task.

## 16. Final status

| | |
| --- | --- |
| **A. Previous HEAD** | `0ea036782d6e8d058a83c60d4fbed27deaa0f941` |
| **B. Feature commit** | `037bcf10c8387452ed7d8dc9c60a83b7f7052f62` |
| **C. Commit message** | `feat: add notifications delivery status UI` |
| **D. Files committed** | 10 — 8 `apps/web` source/test files + 2 Phase 7 reports (1166 insertions, 6 deletions) |
| **E. Backend changes** | NONE — `supabase/` diff empty and clean |
| **F. Tests** | typecheck PASS · 68/68 PASS (9 files) · build PASS |
| **G. Secret scan** | 0 secret hits · 0 source maps (plus L3 security review: 0 findings) |
| **H. Push** | `git push origin main` → `0ea0367..037bcf1`; normal push, no force |
| **I. HEAD == origin/main** | YES |
| **J. Vercel deployment** | `dpl_C2GQFkyHGu5zMCv8vR5GxTVHEAcv` · READY · production target · alias `setura-delta.vercel.app` preserved · bundle contains the new route strings |
| **K. Final staging status** | PROVEN STAGING for the validated read-only control surface |
| **L. Populated notification rows** | NOT OBSERVED |
| **M. WhatsApp rows** | NOT OBSERVED |
| **N. Tenant isolation** | RLS boundary usage PROVEN STAGING; positive cross-tenant row differential NOT OBSERVED |
| **O. Production** | UNPROVEN |
| **P. D5** | DEFERRED BY OWNER |
| **Q. D13** | DEFERRED BY OWNER |
| **R. Working tree** | Clean of tracked changes; 6 untracked files documented in §11 (5 out-of-scope historical reports + this report) |
| **S. Final classification** | PROVEN STAGING (validated read-only control surface) · NOT OBSERVED (populated / WhatsApp data-dependent rendering) · UNPROVEN (production) |

**Final classification:** PROVEN STAGING for the validated read-only control
surface; NOT OBSERVED for populated and WhatsApp data-dependent rendering;
UNPROVEN for production. D5 and D13 remain DEFERRED BY OWNER.

Not claimed: "fully certified", "production ready", or that WhatsApp delivery was
observed.

## 17. Hard stop

The phase is closed: validated source committed, pushed, remote-verified, and
the resulting deployment and bundle reconciled against that source.

Not started, per brief §20: notification retry engine, WhatsApp sending,
dead-letter replay, patient communication UI, analytics, provider diagnostics,
production deployment, D5, D13, or any new database migration.

END.
