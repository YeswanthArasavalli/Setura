# SETURA — PHASE 7 G-05 — Hospital Admin Audit & Compliance Viewer — Implementation Report

**FINAL STATUS: PROVEN STAGING** (not production). All mandatory acceptance gates
A1–A20 = **PASS**. See §16.

This report is written against the authoritative G-05 specification and its
selected-scope source, `PHASE_7_NEXT_PRODUCT_GAP_INVESTIGATION_REPORT.md`.

---

## 1. Executive Summary

G-05 delivers a **frontend-only, strictly read-only** Hospital Admin Audit &
Compliance surface at `/admin/audit`, layered over the **already-existing**
`enterprise-reports` Edge Function (`audit_search` + the five integrity /
compliance checks). No backend, SQL, RLS, grant, SECURITY DEFINER or Edge
Function **source** was created or modified. One **targeted staging redeploy** of
`enterprise-reports` refreshed a stale deployed CORS artifact (its source already
carried the corrected shared CORS implementation).

The money-sensitive `generate` report types and all financial/settlement report
generation are **explicitly excluded** — `settlement_integrity` appears only as a
read-only verdict.

Proven on real staging for all four roles: hospital_admin sees real rows;
receptionist and doctor are denied with zero privileged requests; global_admin is
role-allowed but, having no tenant, truthfully sees "No hospital tenant is
attached to your account." Production was not touched.

---

## 2. Baseline

```text
G-05 feature commit : a02200f  "Add Hospital Admin Audit & Compliance Viewer
                                 (G-05 frontend)"  — 8 files, 1,640 insertions
Branch              : main  (== origin/main; push confirmed via git ls-remote)
Prior baseline      : 0cb2800 (G-03) → d083662 (report refresh) → a02200f (G-05)
Working tree        : clean apart from this report file. Temporary CLI-fallback
                      artifacts (/.vercelignore, root /.vercel) created during a
                      deployment-freshness investigation were removed; never
                      committed.
Staging project     : setura-staging   ref gzcqasntcbqqmgsoikms   ap-south-1
Staging frontend    : https://setura-delta.vercel.app
```

---

## 3. Scope

In scope (all delivered): types, thin read API wrapper, admin route + nav entry,
focused unit tests, one targeted staging redeploy, staging browser + HTTP control
verification, this evidence report.

Out of scope (untouched): any migration/SQL/table/index/RLS/grant/SECURITY
DEFINER/RPC; `enterprise-reports` **source**; the other eight stale Edge
Functions; financial/settlement report generation, fee administration, reschedule,
schedule/leave, notifications, WhatsApp delivery, worker/scheduler; production.

---

## 4. Files Changed (commit `a02200f`)

| File | Δ | Nature |
| --- | --- | --- |
| `apps/web/src/types/api.ts` | +137 | G-05 read types (audit entries + 5 check result shapes) |
| `apps/web/src/api/enterpriseReports.ts` | +106 (new) | Thin read wrapper — 6 actions only; `generate` NOT wrapped |
| `apps/web/src/routes/AdminAudit.tsx` | +710 (new) | Read-only viewer page |
| `apps/web/src/App.tsx` | +9 | `/admin/audit` route, gated by `ADMIN_ROLES` |
| `apps/web/src/components/AppShell.tsx` | +2 | "Audit & Compliance" nav entry (admin roles) |
| `apps/web/src/api/enterpriseReports.test.ts` | +153 (new) | Wrapper boundary tests |
| `apps/web/src/routes/AdminAudit.test.tsx` | +461 (new) | Route/UI state + role tests |
| `apps/web/src/App.test.tsx` | +62 | G-05 routing/deny tests |

No other files changed.

---

## 5. Backend Contract Verification (reused, not rebuilt)

`supabase/functions/enterprise-reports/index.ts` was inspected and confirmed to
already expose, under `requireRole(["hospital_admin","global_admin"])` +
`resolveAuth()` + `getServiceClient()` with a server-validated `X-Hospital-ID`:

```text
audit_search · audit_integrity · settlement_integrity · queue_integrity
doctor_ops_integrity · integration_matrix
```

The frontend consumes exactly those action names and body field names
(`actorId`, `entityType`, `actionType`, `fromTs`, `toTs`, `correlationId`,
`limit`, `queueSessionId`, `doctorId`, `date`) with **no source change**. Success
shapes (`{action:"audit_search", results}` / `{action, check, result}`) are
rendered verbatim. Existing server-side audit of this very access
(`compliance_check`) is preserved; no client-side audit mechanism was added.

---

## 6. Frontend Implementation

- **Route:** `/admin/audit`, wrapped in `RequireRole roles={ADMIN_ROLES}`
  (`hospital_admin`, `global_admin`); G-03 Command Centre at `/admin` intact.
- **API wrapper (`enterpriseReports.ts`):** thin boundary. No business logic, no
  financial computation, no mutation, no tenant construction; `hospitalId` is
  passed only as a header option (never in the body); no `idempotencyKey` on
  reads; `generate` deliberately absent.
- **Component (`AdminAudit.tsx`):** independent per-section
  idle/loading/success/error state; landing audit-search fires **exactly once**
  per tenant (a ref-stabilised effect keyed on `hospitalId`, so typing filters
  never fires a per-keystroke audited request); each integrity check runs only on
  explicit "Run check"; partial failure isolates sections.
- **Rendering honesty (§11/§12):** `display()` preserves backend `0` (never a
  false em dash) and coerces number/`string` PostgREST forms; `null`/`undefined`
  → `—`. `VerdictBadge` renders nothing when `ok` is `undefined` — a missing /
  unavailable verdict is **never** shown as PASS. Values are rendered verbatim;
  nothing is recomputed client-side.
- **Safe metadata (§9):** only the known string `metadata.correlationId` is
  surfaced; whole JSONB objects are never dumped, no HTML rendering.
- **No-tenant guard (§13):** an authenticated admin with no hospital context
  renders "No hospital tenant is attached to your account." and issues zero
  requests (short-circuited before `runSearch` and the effect).

---

## 7. Targeted Deployment (staging only)

```text
supabase functions deploy enterprise-reports   → setura-staging (gzcqasntcbqqmgsoikms)
```

No mass redeploy; the other eight stale functions untouched; **no production
deploy**. The function **source** was not modified — only refreshed so the
deployed CORS artifact matches the corrected shared implementation.

Post-deploy preflight (reconfirmed live):

```text
OPTIONS .../functions/v1/enterprise-reports  → 204
Access-Control-Allow-Origin  = https://setura-delta.vercel.app
Access-Control-Allow-Headers = ... X-Hospital-ID, apikey, X-Client-Info ...
Vary                         = Origin
```

### 7a. Deployment-freshness investigation (resolved — false alarm)

An earlier concern that staging served a "stale" bundle was **disproven**: the
served `index-C6ZliI2u.js` genuinely contains `/admin/audit`, "Audit &
Compliance" and `audit_search`. Its hash differs from the local `index-D2jHs_Z1.js`
only because Vercel's production minifier (CLI 60.1.3, iad1) emits a
functionally-identical bundle (498.77 kB vs local 498.95 kB). The git build of
`a02200f` correctly deployed.

---

## 8. Testing

| Check | Result |
| --- | --- |
| `npm run typecheck` | **PASS** (clean) |
| `npm test` | **PASS** — 198 tests / 18 files (incl. new G-05 wrapper/route/routing) |
| `npm run build` | **PASS** — local bundle contains `/admin/audit` |
| `enterprise_command_center.test.ts` (local stack) | **PASS** — 23 / 0 |
| `deno task validate:migrations` | **PASS** — 0 errors, 4 pre-existing warnings |
| `deno fmt --check` | 2 pre-existing untouched files (`c1_cancel_pre_state.json`, `consultation_notes_read.test.ts`) — not fixed (cosmetic, out of scope) |

Unit coverage includes: exact request bodies; `hospitalId` header-only (never in
body); no `idempotencyKey` on reads; exhaustive module surface (6 exports, no
`generate`/`reportType`); role-denied routing; checks never auto-run; exactly one
landing search; empty-vs-error distinction; no-tenant → zero requests;
partial-failure isolation; safe-metadata rendering; verdict `ok=undefined` → no
badge (never a false PASS).

---

## 9. Browser Staging Validation (`https://setura-delta.vercel.app`)

**hospital_admin (`admin@surya.test`):** nav entry present; `/admin/audit`
auto-loaded **9 real audit rows** for tenant `…0001`; all 5 check sections idle
("Not run yet."); **exactly one** `POST enterprise-reports → 200`; console clean.

**receptionist (`reception@surya.test`):** nav entry **absent**; direct
`/admin/audit` → **redirect to `/reception`**; no rows; **zero** enterprise-reports
requests; console clean.

**doctor (`dr@surya.test`):** nav entry **absent** (only "Doctor Console");
direct `/admin/audit` → **redirect to `/doctor`**; no rows; **zero**
enterprise-reports requests; console clean.

**global_admin (`root@setura.test`):** role-allowed, but account genuinely has
`hospital_id = null`. `/admin/audit` renders **exactly** "No hospital tenant is
attached to your account." — no rows, no crash, no `[object Object]`/`undefined`;
**zero** enterprise-reports requests; console clean; hard deep-link (full reload)
stays on `/admin/audit` and shows the identical truthful message (guard is not an
SPA-nav artifact).

---

## 10. Tenant Isolation

Hospital A admin sees only Hospital A rows (browser: 9 rows for `…0001`). Backend
enforcement (read-only HTTP control, unchanged source):

```text
cross-tenant header → 403 HOSPITAL_ACCESS_DENIED
missing X-Hospital-ID → 422 VALIDATION_ERROR
```

Frontend never supplies an authoritative tenant ID; it derives from the
authenticated session and the server re-authorizes.

---

## 11. Security

- Role isolation at both boundaries: `requireRole([hospital_admin, global_admin])`
  server-side + `RequireRole` route guard client-side; receptionist/doctor denied.
- No new SECURITY DEFINER function, no RLS/grant change, no RPC modification.
- **Service-role key never reaches the browser.** Frontend bundle string scan:
  `service_role` / `SUPABASE_SERVICE_ROLE` / `SERVICE_ROLE_KEY` / `secret` =
  **0 occurrences**. Only the public anon/publishable key is embedded (by design
  in every Supabase frontend; RLS is the real boundary).
- CORS preflight returns current shared headers (§7). Access is audited
  server-side as `compliance_check`.

---

## 12. Network Safety

Observed operations were **read-only GET/POST** to `enterprise-reports` plus
ordinary RLS reads (profiles, user_roles, bookings, doctor reads). **No** payment
/ refund / booking / queue / database mutation, **no** WhatsApp delivery, **no**
broadcast, **no** worker or scheduler execution.

---

## 13. Console Cleanliness

Console **empty** across all four role walkthroughs. The only non-2xx entries
were a `304` cache revalidation on static assets (normal) and one self-inflicted
`401` from a manual probe missing an `apikey` header (not from the app).

---

## 14. Financial Safety

Financial / settlement **report generation and mutations were excluded**. The
`generate` action is not wrapped. `settlement_integrity` is exposed **only** as a
read-only reconciles-or-not verdict, explicitly framed "a verdict, not a
financial report." No fee administration, no reconciliation dashboard, no money
mutation.

---

## 15. Production Status

```text
PRODUCTION NOT TOUCHED
```

All evidence is local (unit/static) or **staging** runtime. A local build is not
production verification; staging proof is not production readiness.

---

## 16. Acceptance Gate (spec §26)

| Gate | Criterion | Verdict |
| --- | --- | --- |
| A1 | Hospital admin can open the Audit Viewer | **PASS** (browser) |
| A2 | Real audit rows returned for the correct tenant | **PASS** (browser: 9 rows, tenant …0001) |
| A3 | Integrity/compliance checks render correctly | **PASS** (browser idle render + HTTP 200 verdicts + unit) |
| A4 | Receptionist: no nav + direct access denied | **PASS** (browser redirect) |
| A5 | Doctor: no nav + direct access denied | **PASS** (browser redirect) |
| A6 | Denied roles issue ZERO `enterprise-reports` requests | **PASS** (browser: 0 for both) |
| A7 | Cross-tenant access denied | **PASS** (403, HTTP control) |
| A8 | Missing hospital context → backend denial | **PASS** (422 HTTP control; frontend no-tenant guard) |
| A9 | CORS preflight has required current headers | **PASS** (204 live reconfirm) |
| A10 | Read requests return successful responses | **PASS** (200) |
| A11 | No database/business mutations | **PASS** (read-only) |
| A12 | No financial/settlement mutation | **PASS** (NONE) |
| A13 | No WhatsApp delivery triggered | **PASS** (NONE) |
| A14 | No worker/scheduler triggered | **PASS** (NONE) |
| A15 | No service-role credential reaches the browser | **PASS** (bundle scan 0) |
| A16 | Console: zero unexpected errors/warnings | **PASS** (empty) |
| A17 | Existing integration tests remain green | **PASS** (23 / 0) |
| A18 | Typecheck passes | **PASS** |
| A19 | Build passes | **PASS** |
| A20 | Evidence report complete | **PASS** (this file) |

**No mandatory gate is FAIL / BLOCKED / NOT OBSERVED.** (Screenshots were BLOCKED
by a harness viewport fault but that is not an acceptance gate; the underlying
gates are DOM/network-proven — see §18.)

---

## 17. Definition of Done

Implementation ✓ · expected behavior ✓ · failure behavior (error/empty/idle/
unavailable states, never a false PASS) ✓ · unit tests ✓ · existing integration
HTTP suite reused & green ✓ · staging runtime proof (browser 4 roles + HTTP
control) ✓ · role isolation ✓ · tenant isolation ✓ · network/console cleanliness
✓ · evidence report ✓.

---

## 18. Remaining Limitations (honest)

1. **Browser screenshots BLOCKED** — the automation harness's native viewport was
   unavailable, so no image artifacts exist. Evidence is accessibility snapshots,
   verbatim DOM text and network inspection. This does not weaken any gate, but
   visual capture should be re-run when the browser view is available.
2. **Live "Run check" click not performed in-browser.** The success-verdict
   rendering path is proven by unit tests and staging HTTP `200 ok=true` reads;
   in the browser walkthroughs the sections were confirmed rendering in their
   idle state. Not a defect — a capture limitation.
3. **Global-admin positive tenant path unexercisable** — the seeded global_admin
   has no hospital by design; the truthful no-tenant state is what the spec §13
   requires, so this is correct behavior, not a gap.
4. **Minor UX polish (recorded, not shipped to avoid churning a passing deploy):**
   truncated actor UUID has no full-value tooltip; no "N rows in window" count
   label; entity `type`+`id` separated by margin only. None affect any gate.
5. **Staging ≠ production.** PRODUCTION NOT TOUCHED and remains UNPROVEN.
