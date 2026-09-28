# PHASE 7 G-02 — COMMIT + EXISTING STAGING DEPLOYMENT + READ-ONLY PREFLIGHT — REPORT

Follows `PHASE_7_G02_BOOKING_STATUS_CLOSURE_IMPLEMENTATION_REPORT.md`
(G-02 PROVEN LOCAL). This phase reconciles Git, reviews the diff, re-runs the
regression suite, confirms the staging deployment and cloud bundle, performs a
READ-ONLY staging preflight, and issues the R1 pre-mutation safety decision.

**NO staging check-in, no-show, or any other staging mutation was performed.**

---

## 1. Scope

Allowed-and-performed: Git inspection, G-02 source review, full local
regression, backend-integrity check, commit/push verification, existing
Vercel project deployment verification, cloud bundle security inspection,
staging SELECT-only preflight, staging browser READ-ONLY validation, R1
decision. NOT performed (forbidden by spec): any staging/production mutation,
backend/SQL/RLS/secret change, force push, history rewrite.

## 2. Baseline

Spec expected baseline `a9aa774` with G-02 uncommitted. **Actual observed
baseline at phase start: `0ec8586` (already committed and pushed, working
tree clean)** — see §3 and §7 for the deviation and its reconciliation.
Linked staging project confirmed: `gzcqasntcbqqmgsoikms` (`setura-staging`).

## 3. Git Reconciliation

`git status --short` → empty. Branch `main`;
`HEAD == origin/main == 0ec8586b3b5b72dd4fcb06c9e5239a89103dc156`
("feat: add booking status closure controls", parent `a9aa774`).
`git diff HEAD -- apps/web supabase` → empty: the committed content is
byte-identical to the locally validated implementation
(local build hash `index-CIvldBh4.js` matches the pre-deploy build).

Commit contents vs Phase E expectations:
- ✅ all 7 G-02 source/test files present with expected line deltas
  (statuses.ts +35, statusClosure.ts +67, statuses.test.ts +94,
  statusClosure.test.ts +98, BookingDetail.tsx +216, BookingDetail.test.tsx
  +278, types/api.ts +26);
- ✅ zero `supabase/` files in the commit (Phase D below);
- ⚠️ ALSO contains 10 prior-phase reports, 5 staging screenshots and
  `c1_cancel_pre_state.json` — artifacts Phase E said to exclude. **Deviation
  D-COMMIT-1** (see §7 for cause and disposition).

No unrelated tracked modifications exist in any other area.

## 4. G-02 Source Review (Phase B, 16 checks)

All 16 spec checks verified against the committed source (direct inspection +
test pinning; each was also exercised by 145 vitest tests in the prior phase):

1. `statuses.ts` uses existing `callFunction` — only import. ✅
2. Body only `bookingId` / `newStatus` / optional `notes`. ✅ (pinned)
3. No `hospital_id` in body — `JSON.stringify(body)` ∌ `/hospital/`. ✅
4. `X-Hospital-ID` supplied solely by `callFunction` from session context
   (`lib/api.ts`: `apikey`, `Bearer` JWT, `X-Hospital-ID`). ✅
5. No invented Idempotency-Key (`"idempotencyKey" in opts === false`). ✅
6. No direct PostgREST writes anywhere in the new path. ✅
7. No financial fields (∌ `/amount|inr|fee|refund/`). ✅
8. No WhatsApp API reference. ✅
9. No service-role key (grep `service_role|eyJ|sb_secret` over changed
   source: 0 hits). ✅
10. No duplicated state machine — `statusClosure.ts` header states
    presentation-only; transitions remain server-authoritative. ✅
11. `statusClosure.ts` contains predicates/labels only. ✅
12. BookingDetail uses backend response + unconditional refetch. ✅
13. Role gate decides rendering only; server re-authorizes. ✅
14. Terminal + queue-owned states expose no controls (10-status matrix). ✅
15. C1 cancellation surface intact (tests + staging browser §15). ✅
16. Doctor receives no reception controls (tests + staging browser §15). ✅

No-show note special checks: ≤500 enforced before send; empty note omits the
key; typed text sent verbatim (no trim rewrite); travels as a JSON string to
the Edge Function (re-validated by server zod) — no SQL interpolation; no
financial content; no notification claim in any label (regex-pinned). ✅

## 5. Regression Results (Phase C)

Re-run in this phase against the committed tree:

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm test` (vitest) | **145/145 passed** |
| `npm run build` | PASS — `index-CIvldBh4.js` (identical hash to earlier validation) |
| `check_frontend_secrets.ts` | 0 secret hits, 0 source maps |
| `git diff --check` | clean |
| `deno task validate:migrations` | 0 errors, 4 known pre-existing warnings |
| `deno task test:integration` | **246/246 passed** (Edge Runtime confirmed `running` first; F16-01 did NOT recur this phase) |

No material difference from the implementation-phase evidence.

## 6. Backend / Migration Integrity (Phase D)

`git diff -- supabase` → **ZERO**; `git status --short supabase/` → empty;
migration count **63** unchanged; no Edge Function, RLS, RPC, manifest or
secret change inside commit `0ec8586` or the working tree.

## 7. Commit Details — DEVIATION D-COMMIT-1 (external, sealed)

**The G-02 commit and push were NOT created by this session.** Evidence:
commit timestamp 2026-09-28 15:58:19 +0530 — after this session's last test
run (15:36 IST) and while this session held no authorization;
`.remember\logs\` shows `autonomous` (15:58:12) and
`memory-2026-09-28.log` (15:58:15) activity immediately before the commit;
a Vercel production deployment followed 14 seconds later (15:58:33). This
session's prior-phase instruction was "COMMIT: NOT PERFORMED" and it honored
that — no `git commit`/`git push` was ever issued from this session.

Disposition: the commit message matches the spec's suggestion
(`feat: add booking status closure controls`) and the G-02 content is exactly
the validated implementation with zero backend diff; the deviation is purely
the bundled artifacts (prior reports/screenshots). Undoing it requires history
rewrite + force push to `main`, both explicitly forbidden by this spec.
Therefore: **sealed as baseline, documented, NOT amended.** Recommend the
owner decide whether a follow-up cleanup commit (removing artifact files from
tracking) is warranted; this phase did not create one (out of scope).

## 8. Push Details (Phase F)

`origin/main == HEAD == 0ec8586` — push is proven complete and consistent.
No new push was needed or performed. Working tree clean post-verification.

## 9. Vercel Deployment (Phase G)

Existing project `setura` (no new project created; no env-var, ownership,
domain, protection or backend-setting change):

| Field | Value |
| --- | --- |
| Deployment | `dpl_2yV1TnpSZVju51ddUguToFtGjiha` |
| Status | **Ready**, target Production, created 15:58:33 +0530 |
| Build | Cloud build, 14s duration, 2 vCPU machine |
| Deployment URL | `setura-gxy6x3qly-yeswantharasavallis-projects.vercel.app` |
| Staging alias | `https://setura-delta.vercel.app` serves this build (entry JS `index-CfoHR7jI.js`) |
| Scope note | `vercel ls` shows personal scope `yeswantharasavallis-projects` — same pre-existing scope posture as C1; recorded, NOT reconciled |

Commit↔build correspondence: deployment created 14s after the commit and the
served bundle contains the G-02 strings (§10); no other commit exists between.

## 10. Cloud Bundle Security (Phase H)

Inspected the actual served bundle (`/assets/index-CfoHR7jI.js`, 470,681 B):

| Check | Result |
| --- | --- |
| Staging Supabase URL | present — exactly one `https://gzcqasntcbqqmgsoikms.supabase.co` |
| Client key | publishable only: `sb_publishable_…` (public by design; value not reproduced beyond prefix evidence) |
| `service_role` | absent |
| `sb_secret_` | 2 occurrences, BOTH inside supabase-js key-format validator literals — no actual secret key (0 bare JWT tokens, `eyJ` count 0) |
| Razorpay / META_ACCESS_TOKEN / CRON / WORKER / SMTP / Vault secrets | absent |
| `localhost` / `127.0.0.1` | occurrences are stock supabase-js library literals (default local gotrue `http://localhost:9999`, DNS allow-list); no app config points at localhost; no other host URL in bundle |
| Production domain | absent |
| Source maps | 0 (`sourceMappingURL` absent, no `.map` served) |
| Test credentials / PII | `surya.test`, `Setura@123` absent |
| G-02 strings | ALL present: "Visit status", "Check In", "Mark No-Show", "Confirm check-in", "Confirm no-show", "update-booking-status" |

## 11. Staging Identity (Phase I)

`.temp/linked-project.json`: ref `gzcqasntcbqqmgsoikms`, name
`setura-staging` — matches spec. Tenant `…0001` (Surya) present. Frontend
alias confirmed serving the G-02 build.

## 12. Staging Authentication (Phase J)

Receptionist `reception@surya.test` login **PROVEN WORKING** via the real
browser session (§15): role `receptionist`, user Ravi Kumar, hospital
context resolves to tenant `…0001`. Doctor `dr@surya.test` exists and logs in
(role `doctor`, Dr. Anitha Rao). No password printed here; seed credentials
are the documented local/staging test accounts.

## 13. Synthetic Booking Inventory (Phase K — SELECT-only)

6 status-`booked`, not-deleted bookings in tenant `…0001`, ALL:
`booking_fee_inr = 0.00`, `consultation_fee_inr NULL`, `payment_completed
false`, `paid_online false`, 0 payment orders, 0 refunds, 0 status-change
events, clearly synthetic names (`Verify Patient` ×4, `E2E NoDoc 8550519`,
`Conf Validation Patient 2`).

| Candidate | ID | Notes |
| --- | --- | --- |
| A — future check-in | `eb701e56-0df6-…` (Conf Validation Patient 2) | used READ-ONLY in §15 browser validation; zero mutation |
| B — future no-show | `f7918ac1-b327-…` (E2E NoDoc 8550519) | untouched |
| Reserve | 4 × `Verify Patient` (`1533cce8-…`, `75795f7d-…`, `efc5dbcb-…`, `4c4775f1-…`) | untouched |

Excluded by rule: the cancelled C1 booking (not `booked`, would not appear),
any payment-active booking (none among these), real-looking patients (none —
all names synthetic). Post-browser DB re-check: all 6 STILL `booked`, event
totals 0, `max(updated_at)` = 03:00 UTC (before every action in this phase).

## 14. Provider / WhatsApp Safety (Phase L)

Staging Edge secrets (listed via CLI, **names + digests only**): no
`META_*`, no `RAZORPAY_*`, no WhatsApp credentials exist.
`hospital_settings`: `meta_phone_number_id NULL`, `meta_waba_id NULL`.
`vault.secrets`: exactly `setura_cron_secret`, `setura_scheduler_api_key` —
no provider secret.

Classification (consistent with C1): **provider delivery is safely blocked at
the credential boundary.** A future no-show would enqueue
`wa_booking_no_show_<id>` (deduped) which cannot reach Meta — it would remain
pending/dead-letter per existing worker behavior.

## 15. Read-Only Browser Validation (Phase M)

Real browser session on `https://setura-delta.vercel.app` (all 10 spec checks
PASS): receptionist login → dashboard (7 bookings) → Candidate A detail:
"Visit status" card with Check In + Mark No-Show, C1 "Cancel booking" still
present, confirmation panel opened (local-state only — **zero network requests
fired**) and closed via "Keep as is", badge remained `booked`. Network audit:
every `rest/v1/*` request GET (+ OPTIONS preflight); only non-GET was the
login `POST /auth/v1/token`. Doctor session on the same booking: NO Visit
status card, NO reception controls, page still `booked`. Zero console
errors/warnings; all API traffic to `gzcqasntcbqqmgsoikms.supabase.co`, no
localhost. **The confirmation is open-and-cancel safe: opening it performs no
mutation.** Screenshots blocked (`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`,
hidden IDE viewport) — a11y-snapshot text observations are the evidence.

## 16. R1 Safety Decision (Phase N)

All 12 required conditions verified TRUE: (1) correct staging project;
(2) correct frontend; (3) G-02 bundle deployed (strings proven in served
cloud build); (4) receptionist authentication works; (5) safe synthetic
bookings identified; (6) candidates are `booked`; (7) unpaid/feeless;
(8) no financial history (0 orders/0 refunds); (9) no real patient data;
(10) provider credential boundary verified blocked; (11) zero production
involvement; (12) no unrelated pending mutation.

**R1 SAFE TO PROCEED = YES** — readiness only. Per this spec, NO mutation was
performed; the actual controlled check-in/no-show require their own explicit
authorization with exact booking IDs (Candidate A / Candidate B above).

## 17. Remaining Blockers

- Staging mutation authorization (separate, explicit) — NOT granted here.
- D-COMMIT-1 artifact-hygiene decision belongs to the owner (§7); cannot be
  fixed within this phase's rules (no history rewrite/force push).
- Screenshot evidence BLOCKED by hidden IDE viewport (both sessions).
- Pre-existing, out of scope: P-RESCH-01, P0-01..P0-04, F16-01 (did not recur
  this phase), F16-05..F16-07, Vercel personal/team scope posture (recorded).

## 18. Production Boundary

NOT TOUCHED. No production Supabase project, no production domain, no
production infrastructure created or referenced; the Vercel project's
`production` target IS this staging-aliased console (`setura-delta`), whose
backend is `setura-staging` — no real-hospital data or endpoint was involved.

## 19. Git Final State

Branch `main`; `HEAD == origin/main == 0ec8586`; working tree clean
(`git status --short` empty); no new commit or push produced by this phase;
this report intentionally left uncommitted (same posture as prior phase
reports, pending owner preference).

## 20. Final Classification

| Item | Classification |
| --- | --- |
| G-02 IMPLEMENTATION | PROVEN LOCAL |
| G-02 COMMIT | `0ec8586b3b5b72dd4fcb06c9e5239a89103dc156` (pre-existing; content VERIFIED == validated source; hygiene DEVIATION D-COMMIT-1) |
| G-02 PUSH | PROVEN (`origin/main` == HEAD) |
| STAGING FRONTEND | PROVEN DEPLOYED (cloud bundle contains G-02) |
| STAGING BACKEND | UNCHANGED |
| STAGING READ-ONLY PREFLIGHT | PROVEN (SELECT-only DB + READ-only browser, zero mutation re-verified post-hoc) |
| STAGING MUTATION | NOT PERFORMED |
| R1 SAFE TO PROCEED | YES |
| WHATSAPP DELIVERY | NOT TESTED (credential boundary blocks delivery) |
| FINANCIAL MUTATION | NOT PERFORMED |
| PRODUCTION | NOT TOUCHED |

---

CURRENT BASELINE: 0ec8586b3b5b72dd4fcb06c9e5239a89103dc156

G-02 IMPLEMENTATION:
PROVEN LOCAL

G-02 COMMIT: 0ec8586b3b5b72dd4fcb06c9e5239a89103dc156

G-02 PUSH:
PROVEN

VERCEL:
dpl_2yV1TnpSZVju51ddUguToFtGjiha — Ready (production target, cloud build of
main@0ec8586)

STAGING FRONTEND:
PROVEN DEPLOYED

STAGING READ-ONLY PREFLIGHT:
PROVEN

SAFE SYNTHETIC BOOKINGS:
6 total, all booked/unpaid/feeless/no-financial-history/no-status-history,
synthetic names — Candidate A `eb701e56-0df6-4ecb-9fb5-83b81f7fae8b`
(check-in), Candidate B `f7918ac1-b327-40c8-b1bd-9ad06ef02968` (no-show),
4 reserve `Verify Patient` bookings

R1 SAFE TO PROCEED:
YES

STAGING CHECK-IN:
NOT PERFORMED

STAGING NO-SHOW:
NOT PERFORMED

WHATSAPP:
No META_* / provider credential exists at staging (secrets names+digests,
hospital_settings NULL, vault 2 non-provider keys) — delivery safely blocked
at credential boundary, consistent with C1; no delivery claimed

FINANCIAL:
NO MUTATION PERFORMED

PRODUCTION:
NOT TOUCHED

D5:
DEFERRED BY OWNER

D13:
DEFERRED BY OWNER

FINAL STATUS:
G-02 COMMITTED + STAGING DEPLOYED + READ-ONLY PREFLIGHT COMPLETE

NEXT AUTHORIZATION REQUIRED:
ONE CONTROLLED STAGING CHECK-IN + ONE CONTROLLED STAGING NO-SHOW
