# PHASE_7_G10 — ALERT-CENTER READ SURFACE — STAGING VERIFICATION REPORT

**Status:** G-10 — PROVEN STAGING — CLOSED
**Implementation commit:** `88df4fc` (`HEAD` on `main`, re-verified at end: `git rev-parse HEAD` = `88df4fceaa1dce6df39cadd9d53a3cd2435368b2`)
**Scope of this report:** STAGING deployment + controlled staging verification ONLY. This task restarted no implementation, redesigned no surface, reopened no closed workstream, and touched no production environment.

---

## 1. Evidence classes used (per AGENTS.md §5)

- **LOCAL IMPLEMENTATION** — cited from the committed `PHASE_7_G10_ALERT_CENTER_IMPLEMENTATION_REPORT.md`. NOT re-executed here (§8: working tree is unchanged from `88df4fc` for all source, so the full local suite was not needlessly re-run).
- **STAGING VERIFICATION** — freshly proven in this task against the SETURA staging environment (Supabase project ref `gzcqasntcbqqmgsoikms`; Vercel `https://setura-delta.vercel.app`). This is the substance of this report.
- **PRODUCTION** — **UNTOUCHED.** No production deployment, no production data, no production verification. Local/staging results are NOT converted into any production claim.

Staging ≠ production. Nothing below certifies production readiness.

---

## 2. Baseline and tree hygiene (§2 / §8 / §23)

| Check | Result |
| --- | --- |
| `git rev-parse HEAD` | `88df4fc…` (matches required commit) |
| Branch | `main` |
| Tracked source under `apps/web`, `supabase/`, `tests/` | **clean vs HEAD** — zero modified tracked source files |
| Only tracked change | `graphify-out/cache/stat-index.json` (generated cache — not touched, not committed) |
| Untracked files | prior-session scratch (probe `.ps1`, `.log`, `.png`, `graphify-out/cache/ast/*`) + this-task scratch |

Note: the AGENTS.md §13 "working tree is not a Git repository" statement is stale — the tree is now a Git repo with remote `github.com/YeswanthArasavalli/Setura.git`, confirmed directly. Source-of-truth hierarchy (source/runtime > docs) governs.

No commit, amend, force-push, or unrelated commit was made. Scratch created during this task was cleaned up (§9).

---

## 3. Deployment (§5 / §7)

### 3.1 Frontend (Vercel, existing project `setura`, Root Directory `apps/web`)
- Deployed the committed `88df4fc` frontend to the existing staging project via `vercel deploy --prod` from the repository root (the project's configured Root Directory is `apps/web`; deploying the CLI from `apps/web` fails "Root Directory does not exist", matching the established repo-root deploy mechanism).
- A root `.vercelignore` was required to exclude ~270 MB of untracked scratch logs (Vercel CLI does not honor `.gitignore`; the `100 MB` file-size limit was hit by a stale `_g09_lint.log`). It excludes only scratch (`*.log`, `*.png`, `_*`, generated cache dirs), NOT any build-essential file under `apps/web`. The file is untracked scratch and was removed after verification.
- Deployment aliased to `https://setura-delta.vercel.app`.
- **Live-bundle marker verification:** served bundle `/assets/index-CnV3174s.js` contains the G-10 markers (Alert Center route + read-only surface), confirming the committed frontend is what is actually served.

### 3.2 Backend (Supabase Edge Functions) — authorized alert-center-only redeploy
- Function inventory on staging (`supabase functions list --project-ref gzcqasntcbqqmgsoikms`) showed `alert-center` at **v7 (2026-09-20)** while the corrected shared-CORS functions (e.g. `command-center`, `financial-command-center`) were at v8 — i.e. the staging `alert-center` **artifact** was stale: its preflight `Access-Control-Allow-Headers` omitted `apikey` / `X-Client-Info`, even though the committed `_shared/cors.ts` already includes them.
- This is documented **staging artifact drift**, not a source defect: server-to-server (which bypasses CORS) all reads succeeded, while the browser POST was blocked at preflight.
- Remediation exactly as §7 permits: redeployed **ONLY `alert-center`** from the unchanged committed source (`supabase functions deploy alert-center --project-ref gzcqasntcbqqmgsoikms`). **v7 → v8 (2026-10-01 15:50:52 UTC)**. No source, SQL, migration, RLS, grant, or SECURITY DEFINER change. All other functions left at their committed versions.
- Post-redeploy preflight confirmed `Access-Control-Allow-Headers` now includes `apikey` and `X-Client-Info`. Runtime authorization matrix re-run after redeploy: unchanged (§4).

---

## 4. Backend HTTP authorization matrix on staging (§9–§11 / §13)

Method: server-to-server `POST /functions/v1/alert-center` with genuine GoTrue password-grant JWTs; accounts/tenants from `supabase/seed.sql` + migration `01_foundation.sql` (Tenant A = `…0001` Surya; foreign Tenant B = `…0002` Sri Venkateswara). Run BOTH before and after the alert-center redeploy — results identical, zero regressions.

| Case | Actor / headers | Expected | Staging result |
| --- | --- | --- | --- |
| `adminA.list` | hospital_admin, X-Hospital-ID=A | 200 | **200** `counts.open=34, critical_open=17` |
| `adminA.analytics` | hospital_admin, A | 200 | **200** `summary.total=34, resolved=0, by_alert_key=2` |
| `globalAdmin.list` | global_admin, A (acting context) | 200 | **200** |
| `globalAdmin.analytics` | global_admin, A | 200 | **200** |
| `recepA.list` / `.analytics` | receptionist, A | 403 ROLE_INSUFFICIENT | **403 ROLE_INSUFFICIENT** |
| `doctorA.list` / `.analytics` | doctor, A | 403 ROLE_INSUFFICIENT | **403 ROLE_INSUFFICIENT** |
| `adminA.list(no-header)` | hospital_admin, no X-Hospital-ID | 422 VALIDATION_ERROR | **422 VALIDATION_ERROR** |
| `anon.list` | anonymous | 401 UNAUTHORIZED | **401 UNAUTHORIZED** |
| `adminA.list@B` / `.analytics@B` | hospital_admin of A presenting foreign tenant B | 403 HOSPITAL_ACCESS_DENIED, **no data** | **403 HOSPITAL_ACCESS_DENIED**, `data` absent |

**P3-01 (no authorization 5xx):** ZERO 500s across the matrix. All denials occur before any RPC (auth → role → header → RPC), so a denial can never surface as a 500. **PASS.**
**Tenant isolation:** the cross-tenant probe returns a specific 403 `HOSPITAL_ACCESS_DENIED` with **no data payload** — no cross-hospital leakage. **PASS.**

---

## 5. Browser walkthrough (§12–§20)

Performed with the Browser subagent on the live staging frontend after the CORS redeploy. Screenshots were blocked by an OS-minimized/hidden browser window (environment/tooling blocker, honestly reported); verification therefore relies on the DOM/accessibility snapshot, the network request log, and the browser console (permitted by §20 once the app is proven healthy by those signals).

| Requirement | Evidence | Result |
| --- | --- | --- |
| Alert Inbox + Alert Analytics render | hospital_admin `/admin/alerts`: "Alert Center — Read Only"; "Alert Inbox" + "Alert Analytics" mount with real rows | **PASS** |
| Server counts authoritative (not `alerts.length`) | Tiles OPEN=34 / ACK=0 / ESC=0 / CRITICAL OPEN=17; Summary TOTAL=34 / RESOLVED=0 / avg≈13,984; 34 detail rows; 2 by-key rows (`queue_stalled` 17, `queue_throughput_low` 17) | **PASS** |
| Counts do NOT change with row filtering (§16) | Applying Critical filter → rows drop to 17 but OPEN tile stays 34 (server `counts`, not client calc) | **PASS** |
| Empty state | global_admin renders proper empty state (OPEN=0, "No alerts found.", "No alerts in this window.") with acting-context disclosure `…0005` | **PASS** |
| Bounded one-cycle refresh / no polling | On load exactly 2 alert-center POSTs (both 200); after idle, 0 additional requests; no timer polling | **PASS** |
| Filters inert until Refresh | Changing selects/dates issues 0 network requests; only `Refresh` triggers the 2-call cycle | **PASS** |
| Role routing | receptionist/doctor: "Alert Center" nav absent; direct `/admin/alerts` redirects to `/reception` / `/doctor`; page never mounts; ZERO alert-center requests | **PASS** |
| No mutation controls | Only `Refresh` rendered; no acknowledge/assign/resolve/escalate/suppress control at any state | **PASS** |
| Clean console | No errors/warnings on any role's Alert Center view; **no CORS errors** post-redeploy | **PASS** |

---

## 6. Closed-workstream regression smoke (§21 / §3)

Confirmed the frontend deploy + alert-center redeploy did not disturb closed workstreams. Browser subagent, READ-ONLY, same environment caveats. All surfaces rendered real data or proper empty states; console clean throughout.

| Workstream | Route | Actor | Evidence | Result |
| --- | --- | --- | --- | --- |
| G-03 Command Centre | `/admin` | hospital_admin | `command-center` POST ×5 → 200; Operational Overview / SLA / System Health render | **PASS** |
| G-05 Audit | `/admin/audit` | hospital_admin | `enterprise-reports` POST → 200; audit-log table populated | **PASS** |
| G-06 Reports | `/admin/reports` | hospital_admin | 4 report cards mount; on-demand reads (no auto-fetch) | **PASS** |
| G-09 Finance | `/admin/financial` | hospital_admin | `financial-command-center` POST ×3 → 200; collections/settlement/recon render | **PASS** |
| G-08 portfolio role boundary | `/admin/portfolio` | hospital_admin | **redirected to `/admin`**; NO portfolio fetch, NO portfolio data | **PASS (denied)** |
| G-08 portfolio | `/admin/portfolio` | global_admin | `executive-analytics` POST ×2 → 200; 5 hospitals + benchmarks render | **PASS** |
| G-10 alert-center (post-fix) | `/admin/alerts` | hospital_admin | `alert-center` POST ×2 → 200; no CORS errors | **PASS** |
| AUTH idle / no polling | (any admin page) | global_admin | ~106 s idle window after load: ZERO recurring requests; one-time token exchange only | **PASS** |

No closed workstream was modified; each remained reachable with role boundaries intact.

---

## 7. Final acceptance matrix (§24 / §25)

| Gate | Class | Verdict |
| --- | --- | --- |
| Frontend built from `88df4fc` served on staging; G-10 markers live in bundle | STAGING | **PASS** |
| alert-center stale artifact → authorized v7→v8 redeploy; preflight now allows `apikey`/`X-Client-Info` | STAGING | **PASS** |
| Backend HTTP authorization matrix (list/analytics; all role/header/anon/cross-tenant cases) | STAGING | **PASS** |
| P3-01 (no authorization 5xx) | STAGING | **PASS** |
| Tenant isolation (cross-tenant 403, no data) | STAGING | **PASS** |
| Browser data render (counts, by-key, analytics) | STAGING | **PASS** |
| Server counts authoritative (filter divergence) | STAGING | **PASS** |
| Empty state (global_admin acting context) | STAGING | **PASS** |
| Idle / bounded refresh / no polling / filters inert | STAGING | **PASS** |
| Role routing (receptionist/doctor never mount; nav hidden) | STAGING | **PASS** |
| Zero mutation controls | STAGING | **PASS** |
| Clean browser console | STAGING | **PASS** |
| Closed-workstream regression (G-03/05/06/07/08/09/AUTH) | STAGING | **PASS** |
| Git end-state (HEAD = `88df4fc`, source clean vs HEAD) | HYGIENE | **PASS** |
| Screenshots (OS-minimized browser) | TOOLING | **BLOCKED (environment)** — substituted by DOM/network/console per §20 |
| Local test suite (frontend 339/339; integration HTTP 13/13; secrets 0 hits) | LOCAL (committed, not re-run this task per §8) | cited from `PHASE_7_G10_ALERT_CENTER_IMPLEMENTATION_REPORT.md` |
| Production | — | **UNTOUCHED / UNPROVEN** |

---

## 8. Verdict (§29 / §30)

**G-10 — PROVEN STAGING — CLOSED**

- **Implementation:** `88df4fc` (read-only alert-center surface: `list` + `analytics` only, no mutation path).
- **Local (committed evidence, not re-run this task per §8):** frontend `vitest` **339/339** (28 files); integration HTTP **13/13**; `check_frontend_secrets` **0** hits.
- **Staging (proven this task):** Backend HTTP **PASS** · Authorization **PASS** · Tenant isolation **PASS** · P3-01 (no auth 5xx) **PASS** · Browser data render **PASS** · Server-authoritative counts **PASS** · Empty state **PASS** · Idle/polling/bounded-refresh **PASS** · Role routing **PASS** · Zero mutation controls **PASS** · Console **PASS** · Closed-workstream regression **PASS**.
- **Only deviation:** alert-center staging artifact was stale (missing `apikey`/`X-Client-Info` in CORS preflight). Resolved exactly as §7 authorizes by redeploying ONLY alert-center from unchanged committed source (v7→v8). No source/SQL/RLS/grant change. Classified as **staging artifact drift**, not a product defect.
- **Production: UNTOUCHED.** No production claim is made.

G-10 is closed at the STAGING level. This is NOT a production-readiness certification.

---

## 9. Cleanup (§23)

Scratch produced during this task (`_g10_staging_http_probe.ps1`, `_g10_deploy.log`, `_g10_fn_deploy.log`, the root `.vercelignore`, and the `g10_*.png` browser captures) was removed after evidence was captured. The tracked working tree remains based on `88df4fc` with zero modified source files.
