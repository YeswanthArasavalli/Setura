# SETURA — COMPLETE SOFTWARE STATE & REMAINING IMPLEMENTATION REPORT

**READ-ONLY INVESTIGATION — NO CODE CHANGES — NO MIGRATION — NO COMMIT — NO PUSH — NO DEPLOYMENT**

Date: 2026-10-02 · Method: direct repository inspection (directory/file counts,
migration listing, Edge-Function inventory, frontend route/API census, targeted
source grep for write paths and credential resolution, `.env.example`, live `git`
probe) reconciled against the authoritative planning artifacts
(`SETURA_FINAL_MASTER_ROADMAP.md`,
`PHASE_7_NEXT_WORKSTREAM_READINESS_REPORT.md`, and the closure reports for C2,
C2b, G-UI, GEN-TYPES/hygiene, G7-13, F16-07, G7-16). Every conclusion cites
repository evidence and is tagged with a verification level. No report is
trusted over the actual source when the two disagree.

---

## 0. Verification Legend (used throughout)

- **IMPLEMENTED** — the code/SQL exists in the tree.
- **STATICALLY VERIFIED** — confirmed by reading source/config.
- **UNIT VERIFIED** — a unit test asserting it passed on the local run.
- **INTEGRATION VERIFIED (local)** — executed against the real local Supabase stack.
- **STAGING VERIFIED** — proven on the deployed staging project.
- **PRODUCTION VERIFIED** — proven in a production environment.
- **UNPROVEN** — no matching evidence at the claimed level.
- **BLOCKED** — cannot be proven in this environment (classified).

**Category (mandatory per tasking §24):**
A = SOFTWARE INCOMPLETE · B = complete, local verification remaining ·
C = complete, staging verification remaining · D = complete, real external
account required · E = owner/business decision required · F = documentation /
hygiene only.

---

## 1. HEADLINE ANSWER TO THE OPERATING QUESTION

> *If tomorrow I obtain a real hospital, Razorpay account, WhatsApp/Meta
> account, GST details and credentials — can I onboard that hospital through
> SETURA's intended frontend/configuration flow without developers building
> missing core software?*

**NO — not yet.** The transactional engine, staff/admin consoles, patient
journey, payments/refunds/settlements, WhatsApp conversation flow, alerts and
analytics are genuinely implemented and largely locally integration-verified.
But the **hospital onboarding / configuration layer is the missing core**: there
is no product surface (nor even a backend RPC/Edge action) to *create a hospital
tenant* or to *set a hospital's operational and integration configuration*.
Today those require direct SQL and environment-variable editing by a developer.

The concrete blockers are enumerated in §6, §7 and the backlog in §26. They are
**Category A (software incomplete)**, distinct from the Category D
(needs-real-account) and Category E (needs-owner-decision) items that the owner
has explicitly deferred.

---

## 2. Repository Inventory (measured, this session)

| Item | Count | Method |
| --- | --- | --- |
| Migrations | **64** SQL files + `MANIFEST.sha256` (64 lines) | `supabase/migrations` listing; `Get-Content MANIFEST.sha256` = 64 |
| Edge Functions | **26** (+ `_shared`) | `supabase/functions` directory listing |
| `_shared` modules | ~23 top-level modules + `enterprise/`, `queue/`, `whatsapp/` subdirs | `supabase/functions/_shared` listing |
| TypeScript files (`.ts`) | **151** (excl. `node_modules`/`graphify-out`/`.qoder`/`.remember`/`.ua`) | recursive count |
| TSX files (`.tsx`) | **42** | recursive count |
| SQL files | **66** (64 migrations + 2 elsewhere) | recursive count |
| Test files (`*.test.ts` in `tests/`) | **36** | `tests/{unit,integration}` count |
| Frontend route files | **27** (14 pages + 12 co-located `.test.tsx` + Login) | `apps/web/src/routes` listing |
| Frontend API wrapper modules | **13** non-test (`alertCenter, booking, cancellations, commandCenter, doctorOps, enterpriseReports, executiveReports, financial, operations, portfolio, queue, reads, reschedule, statuses`) | `apps/web/src/api` listing |
| Git state | **IS a Git repo**; branch `main`, HEAD `0fceb50` (G-11), `origin/main` `90100aa`, **ahead 2**; large uncommitted working set | `git rev-parse HEAD`, `git status -sb` |

**Baseline correction.** `AGENTS.md §13` states "the working tree is NOT a Git
repository" and "no scheduler exists." Both are **stale** and are contradicted
by direct evidence: `git` works (§2 above), and a scheduler mechanism was added
in migration `53_phase2_scheduler_and_autonomous_recovery.sql`. The reports
`G7_13` §2 and `PHASE_7_NEXT_WORKSTREAM_READINESS_REPORT` §2 independently
reconcile this. Classification: **F (documentation only)** — AGENTS.md §13 needs
its snapshot updated; no product defect.

---

## 3. Database / PostgreSQL

**Schema breadth (evidence: migration titles + generated types).** The DB is the
system's backbone and is genuinely mature: foundation/tenant model (01), atomic
token engine & bookings (02), doctor scheduling/slot engine (03), WhatsApp
messaging engine (04), notification queue (05), background job queue (06),
settlement engine (07/33), analytics engine + rollups (08/21), abuse protection &
rate limiting (09), audit & security engine (10/36), realtime presence (11/20),
**hospital configuration engine** (12/35) with config versioning & rollback (18),
payment engine (13), dead-letter queue (14), partitioning (15/22), idempotency
hardening + API idempotency registry (16/25), queue monitoring/runtime/operations
(17/43/44/45), background worker engine (19), retention/cleanup (23), operational
monitoring (24), migration metadata & registry (26), role permissions (27),
booking enhancements & cancellation policy (28/29), device sessions (30), doctor
leave management (31), subscription engine (32), feature flags (37), WhatsApp
conversational engine (42), doctor clinical operations (46), enterprise command
center (47), privilege hardening (48), and the C2 alert lifecycle RPCs (64).

**Invariant enforcement is DB-first (correct).** Business rules live in SECURITY
DEFINER RPCs and triggers, not application code, per the established architecture
(AGENTS §6/§8). Examples verified this session:
- `auto_create_hospital_settings()` trigger (migration 12:237) auto-creates a
  `hospital_settings` row whenever a `hospitals` row is inserted.
- `version_hospital_settings()` trigger (migration 18:271) versions every config
  change for rollback.
- `create_hospital_settlement()` (07:316) later repurposed/deprecated in favor of
  `create_platform_revenue_summary()` (33:113) — the settlement engine refactor is
  real, not aspirational.

**Tenant isolation.** RLS is pervasive (live policy count **139**, measured at
Gate 1 / `PRIVILEGE_RUNTIME_VERIFICATION.md:446`, superseding the stale "193"
that F16-07 corrected). Privilege boundary locked 177 callable routines to
`service_role` only; **F16-06 denial coverage is now 177/177 (100%)** proven at
SQLSTATE 42501 for both anon and a real authenticated low-privilege caller
(`G7_13_F16_TEST_QUALITY_REMEDIATION_REPORT.md` §4). **INTEGRATION VERIFIED
(local).** Production privilege catalog state remains **UNPROVEN** — must be
re-measured against the deployed DB (roadmap §9 bold item; G7-04). Category D/E
(production provisioning), not a code gap.

**Race-prone areas (handled).** Booking/token/queue/payment/refund paths use
atomic RPCs with row locking and idempotency (02/16/25/56). Concurrency tests
exist (C2 alert writes 6 two-connection cases + rollback injection, G7-13 §;
reschedule races per G-07). **No competing application-level mutation was found**
in the read surfaces added this cycle.

**Known DB-category findings (verify before treating as fixed):**
- **P0-04 / `booking_fee_inr`** — roadmap says closed via migration 54
  (`booking_fee_writer.sql`, present on disk). **IMPLEMENTED.** Not re-executed
  here.
- **F16-04 (standing obligation)** — migration 48's default-privilege fail-closed
  does NOT hold; every new/resignatured SECURITY DEFINER function needs its own
  explicit `REVOKE`. **Design rule, open obligation** — not a defect to fix in a
  file, but a checklist for all future migrations. Category A (process/standing).
- **P2-11 orphaned routines** — ~27% caller-less routines (roadmap §12 "do not
  delete by reflex"). **KNOWN/ACCEPTED tech debt.** Category A-low/F.

---

## 4. Edge Functions / Backend

**Complete inventory (26).**

| Function | Purpose | Notes |
| --- | --- | --- |
| `create-booking`, `cancel-booking`, `reschedule-booking`, `update-booking-status` | booking lifecycle | canonical state machine; reuses RPCs |
| `create-payment-order`, `verify-payment`, `process-refund` | Razorpay order/verify/refund | fail-closed w/o creds (Category D) |
| `settlement-engine`, `financial-command-center` | financial rollups/collections | reads authoritative ledgers |
| `compute-sla`, `refresh-rollups` | analytics derivation | batch/machine-invoked |
| `run-background-worker`, `run-cron-minute`, `run-cron-nightly`, `send-reminders`, `carry-forward-tokens` | worker + cron entrypoints | machine-only; see §5 |
| `queue-control`, `queue-next-patient`, `doctor-operations` | queue runtime + clinical | canonical queue primitives |
| `process-whatsapp-webhook`, `send-whatsapp-message` | WhatsApp inbound/outbound | HMAC + conversational engine |
| `alert-center` | C2 alert lifecycle (read + acknowledge/resolve/escalate/suppress) | backend CLOSED, HTTP+concurrency proven |
| `command-center`, `enterprise-reports`, `executive-analytics` | admin read surfaces + broadcasts | G-03/G-06/G-11 + C2b backend |
| `monitoring-health-check` | health | observability surface |

**Shared primitives (present and reused, not duplicated).** `_shared/` holds
`getServiceClient` (db.ts), `resolveAuth`/`requireRole` (auth.ts), `audit.ts`,
`response.ts` (`successResponse`/`handleErrorResponse`), `cors.ts` (fail-closed),
`env.ts`, `errors.ts`, `idempotency.ts`, `logger.ts`/`metrics.ts`/`tracing.ts`,
`validation.ts`, `phone.ts` (`formatE164`), `rate_limit.ts`, `realtime.ts`,
`reporting.ts`, `webhook_signature.ts`, `worker.ts`, plus `enterprise/`,
`queue/`, `whatsapp/` and the frozen `database.generated.ts`. The readiness
report confirms **zero TODO/FIXME/HACK** and **zero skipped/disabled tests**
across `supabase/functions/**/*.ts` and `apps/web/src`.

**Completeness.** No Edge Function is a stub in its happy path. The 15
"zero-caller" functions are machine/webhook/cron/financial/queue engines **by
design**, not UI gaps (readiness §7 false-positive clearing). Verification level
varies per feature (see §13 matrix); backend for alerts/booking/payments/queue is
**INTEGRATION VERIFIED (local)**; the C2 alert write path is additionally
**HTTP-verified (H1–H15, 28/28)**.

---

## 5. Worker / Queue / Scheduler

This is the most materially changed area versus the stale AGENTS.md snapshot.

**Worker lifecycle — SOFTWARE PRESENT, PROVEN LOCALLY; PROD ACTIVATION IS A
DECISION/CONFIG.**
- `claim_jobs_v2` lease bug (P0-01) is **FIXED** by migrations 50/51/52
  (`p0a_fail_job_v2_dead_letter_fix`, `p0e_claim_jobs_v2_lease_fix`,
  `w1_detect_crashed_workers_ambiguity_fix`), all present on disk.
- Crash reclaim is **locally proven** (G7-01 CLOSED; readiness §4 "Worker
  lifecycle … P0-01 FIXED … crash reclaim PROVEN locally").
- **However** `ENABLE_WORKER_TRIGGER=false` is still the shipped default
  (`.env.example:16`). **IMPLEMENTED but not activated** — a documented default
  that, deployed as-is, enqueues but does not process. Category **E/D** (owner
  decision D6 + production secret/config), **not** a code gap.

**Scheduler — A SCHEDULER NOW EXISTS IN SOFTWARE.**
- Migration 53 installs `pg_cron` + `pg_net` and creates the owner-only singleton
  `public.scheduler_http_config` (RLS enabled, `REVOKE ALL`, defaults to NULL).
- Migration 57 adds pg_net timeout handling; migration 58 fixes queue-health
  negative-age.
- **Locally proven** autonomous firing (readiness §4: "migration 53
  pg_cron+pg_net+Vault, autonomous firing 316/0, G7-07 CLOSED locally"; §5
  evidence matrix marks scheduler integration PASS locally, HTTP wake PARTIAL).
- The old P0-02 "no scheduler exists" is therefore **superseded** at the software
  level. Remaining: **hosted-Supabase extension/Vault behavior UNPROVEN (D7)**
  and the config row must carry the real wake URL + `CRON_SECRET` at deploy.
  Category **D/E** (production provisioning), **not** a missing-software gap.

**Verdict:** worker/scheduler are **COMPLETE SOFTWARE awaiting runtime/deployed
verification**, not incomplete software — the genuine blockers are activation
decisions and production configuration, with the one caveat that a
production-proven end-to-end (cron → claim → process → complete, unattended
≥24h) has NOT been demonstrated anywhere (roadmap §9 "Scheduler operating ≥24h
unattended" remains unchecked). That 24h soak is **UNPROVEN** and is the honest
gap to close at staging/production.

---

## 6. Hospital / Multi-Tenant Architecture — THE CORE COMPLETION GAP

**Can SETURA onboard a new hospital through configuration rather than custom
development? NO.** Tenant *data isolation* is architecturally excellent (RLS,
per-hospital scoping, service-role boundaries). Tenant *creation and
configuration* have **no software entry path**. Evidence:

**6.1 Hospital tenant creation.** `INSERT INTO hospitals` exists only as the
`01_foundation.sql:531` seed. There is **no `create_hospital` RPC and no Edge
Function** that provisions a tenant (grep of all migrations/functions found
none). Onboarding a hospital today = a developer runs SQL (or edits a seed).
**Category A.**

**6.2 Hospital configuration write path.** `hospital_settings` is *read* by many
functions (`create-booking`, `create-payment-order`, `send-reminders`,
`run-background-worker`, `_shared/phone.ts`, WhatsApp engine) but **is never
written by any Edge Function**. The only `.update()` calls in the functions target
`bookings`/`notification_queue`, not config. Config is created only by the
`auto_create_hospital_settings()` trigger (defaults) and mutated only by direct
SQL (e.g. migration 35:85 backfill). Therefore **fees, booking/platform fee,
operating hours, holidays, consultation fee, queue config, feature-flag toggles,
`meta_phone_number_id`, `meta_waba_id`, `razorpay_key_id`, display name,
preferred language, country code, max advance days** cannot be set through any
product surface. **Category A.**

**6.3 Departments / doctors / staff / schedules.** The read/booking sides and the
doctor clinical workflow (migration 46) and doctor leave management (31) exist,
and staff can reschedule/manage queue (G-07, Phase 6). But **creating** a
department/doctor/staff user and configuring schedules is not exposed as an
admin command surface with a dedicated Edge action/RPC write path proven here
(contrast: C4 "Doctor schedule/leave management — no write RPC/Edge action
exists" per readiness §4, NOT READY). **Category A (schedule/leave write) + E
(design ruling).**

**6.4 Integration credential model (design, not just a gap).** Razorpay and Meta
*secrets* live in **global env** (`env.ts: RAZORPAY_KEY_ID/SECRET`,
`META_APP_SECRET`, `META_ACCESS_TOKEN` are `optionalEnv`), and `hospital_settings`
stores only non-secret ids (`razorpay_key_id`, `meta_phone_number_id`,
`meta_waba_id`). For SETURA's business model (SETURA collects only the
platform/booking fee via one platform PSP account) a single global Razorpay
account is defensible (**Category E/D — architecture/product decision**), but
per-hospital WhatsApp is **effectively single-tenant today**:
`send-whatsapp-message` falls back to global `Env.META_*` when a hospital has no
`meta_phone_number_id` (AUDIT_REPORT §finding 7). **Category A** if genuine
multi-hospital WhatsApp onboarding is intended.

**Net:** the entire "hospital onboarding UI + configuration write API" is
**missing software** (§7 detail). This — not absent real credentials — is the
answer to the operating question.

---

## 7. Hospital Onboarding / Configuration UI

**Frontend route census (measured).** `apps/web/src/routes` contains:
`Login, BookAppointment, BookingDetail, WalkIn, Patients, QueueBoard,
ReceptionDashboard, DoctorConsole, Notifications, AdminAlerts, AdminAudit,
AdminCommandCentre, AdminFinancial, AdminOperations, AdminPortfolio, AdminReports,
BroadcastComposer` (+ co-located tests). `apps/web/src/api` wrappers: `alertCenter,
booking, cancellations, commandCenter, doctorOps, enterpriseReports,
executiveReports, financial, operations, portfolio, queue, reads, reschedule,
statuses`.

**There is NO onboarding / settings / hospital-configuration / integrations
route, and NO API wrapper for them.** A grep of `apps/web/src` for
`hospital_settings|onboard|createHospital|/settings|configureHospital|Razorpay
config` returned only the read-only `verify_integration_matrix` **audit** surface
(`AdminAudit.tsx`, an analytics check — *not* credential configuration). **The
configuration surfaces the tasking enumerates (§7) do not exist.**

| Required config surface (tasking §7) | Backend? | UI? | Category |
| --- | --- | --- | --- |
| Legal/display name, address, contact, GST | schema partially; **no write path** | ✗ | **A** |
| Operating hours / holidays | schema (12/35); no write path | ✗ | **A** |
| Departments / doctors / staff CRUD | partial; schedule write ✗ | ✗ | **A/E** |
| Consultation & booking/platform fees | `hospital_settings` cols; no write path | ✗ | **A** |
| Queue configuration | schema; no write path | ✗ | **A** |
| Feature flags | `37_feature_flags`; no write path | ✗ | **A** |
| Razorpay configuration + test connection | global env only | ✗ | **A/D/E** |
| WhatsApp/Meta configuration + test connection | `hospital_settings` ids + global secret; no write path/UI | ✗ | **A** |
| Credential entry / rotation / enable-disable / audit | ✗ | ✗ | **A** |

**Frontend quality where it DOES exist** is good: server-authoritative reads,
role-gating (`ADMIN_ROLES`), honest mutation UX (C2b "ENQUEUED ≠ DELIVERED", G-UI
reconcile loop re-reads server state), tenant travels only in the
`X-Hospital-ID` header, no hospital id in bodies (test-proven). So the frontend
skill/infrastructure exists — it simply has **no configuration surface built**.

---

## 8. Razorpay / Payments

**SOFTWARE COMPLETE (business-model-correct), live verification pending.** The
payment chain is implemented across `13_payment_engine.sql`, migration 56
(`payment_capture_path_fix`), and Edge functions `create-payment-order`,
`verify-payment`, `process-refund`. The established model — SETURA collects only
the booking/platform fee, revenue recognized at capture, refunds bounded by
SETURA-collected amount — is enforced in SQL (`59_d16_revenue_at_capture`,
`60_d16_refund_unification`; `d16_financial_policy.test.ts` integration-proven,
readiness §5 "Financial … PASS (local)"). Fee separation (consultation vs
platform) uses `hospital_settings` (`create-payment-order/index.ts:272`).

- **Order creation / capture / webhook / signature / idempotency / dedup /
  refunds / ledger / audit — IMPLEMENTED, INTEGRATION VERIFIED (local).**
- **Gateway-secret handling** = global env (single platform PSP; §6.4).
- **BLOCKED (Category D):** real Razorpay live behavior (G7-05, no credentials;
  code fail-closed by design).
- **Category E:** residual financial-policy rulings before "complete":
  **NPD-01 GST** (pending CA/tax), refund≤SETURA-collected **enforcement
  hardening**, settlement **cadence**, **partial-refund proportionality**
  (readiness §4 "Financial correctness wave … NOT READY — rulings/design first").
- **SaaS subscription billing is schema-only** — `razorpay_subscription_id`
  column exists (32_subscription_engine) with **no Edge integration to the
  Razorpay subscription API** (AUDIT_REPORT finding 6; roadmap P2-01
  "accounting-only until a billing decision"). **Category A (if hospital-pays-
  SETURA subscription is in scope) / E (billing decision).** Not required for a
  booking-fee pilot.

---

## 9. WhatsApp / Meta

**SOFTWARE COMPLETE for the conversational + messaging engines, live verification
pending; multi-tenant credential entry is the software gap.**
- Engines: `04_whatsapp_messaging_engine`, `42_whatsapp_conversational_engine`,
  `send-whatsapp-message`, `process-whatsapp-webhook`, `_shared/whatsapp/*`.
- Preserved invariants (AGENTS §10): webhook HMAC
  (`webhook_signature.ts`), inbound dedup, deterministic intent routing,
  booking/queue/reschedule/cancel conversational flows, handoff, outbound job
  queue, delivery/read reconciliation. `whatsapp_lifecycle` +
  `whatsapp_conversational` integration suites **PASS (local)**; HMAC tests use
  fake secrets locally (**PARTIAL**, not live-signed).
- C2b Broadcast Composer consumes the five existing `broadcast_*` actions
  (queue/delay/closure/admin-notice/alert) — **IMPLEMENTED, unit/component
  verified**; runtime/browser **BLOCKED** (no live stack in that session) and
  delivery proof is coupled to worker activation (enqueue-only today).
- **Category A:** no per-hospital Meta credential *configuration write* surface;
  `send-whatsapp-message` **falls back to a single global Meta phone number** when
  a hospital has no `meta_phone_number_id` (AUDIT finding 7). Patient broadcasts
  are gated by the `whatsapp_queue_updates` feature flag (default off →
  `enqueued: 0`).
- **Category D:** real Meta Business/WhatsApp assets, live webhook, template
  approval — G7-06 BLOCKED by design.

---

## 10. Security

**Strong, defense-in-depth, and freshly hardened — mostly locally certified.**
- AuthN/AuthZ separation: `resolveAuth()` + `requireRole()` at the Edge boundary
  AND RLS/`service_role`/`EXECUTE`-grant boundaries at the DB. Fail-closed CORS
  (`cors.ts:10`). Alert writes fail closed (42501→403, H15).
- Privilege isolation test is now **high-quality**: F16-05 fixed — SQLSTATE-42501
  anchored, identity positive control (`is_global_admin`→200), anon 401 vs
  authenticated 403 asserted separately (`G7_13` §3). `privilege_isolation`
  **25/25 INTEGRATION VERIFIED (local)**.
- Injection: parameterized RPCs/PostgREST; no raw interpolation found.
- Secrets: none committed; `.env.example` holds placeholders only; AGENTS §7
  rules observed by reports.
- **Standing gaps (not new defects):**
  - **F16-04** — default-privilege fail-closed does not hold; new/resignatured
    SECURITY DEFINER functions need their own explicit `REVOKE` (process rule,
    §3). Category A (obligation).
  - **Production privilege catalog UNPROVEN** — must be re-measured on the
    deployed DB (G7-04, roadmap §9). Category D/E.
  - **Rate-limiting on the `verify-payment` webhook** — recorded UNPROVEN-DETAIL
    (readiness §7), needs confirmation before the production gate. Category A-low.
  - **Doctor permission granularity** — `27_role_permissions` defines
    `has_permission()` but **no Edge Function calls it** (authorization is
    `requireRole` only) — AUDIT finding 8. Coarse-by-design today; fine-grained
    permissions are **unused**. Category A (if granularity is a product
    requirement) / E (design).
  - **AI Insights** feature flag seeded `FALSE` with **no implementation** (AUDIT
    finding 5) — an intended placeholder, not a defect. Category F/A-if-promoted.

---

## 11. Frontend (React app) — see §7 census

14 product pages + auth shell + `AppShell` nav, 13 API wrappers, hooks
(`useAsyncAction`), `lib/api.ts` `callFunction` (the sole privileged path,
attaches JWT + `X-Hospital-ID`), `lib/errors`, `types/api.ts`. Role-based
visibility, server-authoritative state, honest mutation/reconcile UX.
- **Frontend suite:** baseline **371/371** at G-11; later runs **389 passed**
  (G-UI) and **46 passed** (C2b) — **UNIT/COMPONENT VERIFIED (local)**, build +
  `tsc --noEmit` PASS. Browser/runtime walkthroughs **BLOCKED** where Docker was
  down (G-UI §10, C2b §13).
- **Missing surfaces (§7):** all hospital onboarding/configuration/integration
  screens. **No optimistic-only mutation anti-patterns found; no placeholder
  screens in the existing routes; no fake/static business data found in read
  surfaces** (they call real RPCs). The one "UI with thin/no backend write"
  category is the entire configuration domain (backend write absent, §6).

---

## 12. Journeys (patient · doctor/staff · finance · notifications)

**Patient journey — IMPLEMENTED, locally integration-verified end-to-end legs.**
discovery → hospital/doctor select → slot/queue → booking → booking fee → payment
→ confirmation → WhatsApp notify → arrival/token/queue → consultation →
completion → cancellation → reschedule → refund → notifications → audit. Booking
lifecycle (create/cancel/reschedule/status-update Edge + RPCs), token/queue
runtime, consultation notes (63), payment/refund (13/59/60), notifications (05),
audit (10/36) all exist. Gate E1 (hospital journey) locally PASS. Configuration-
dependent legs (fees, hours) are blocked by §6, not by journey code.

**Doctor/staff journey — PARTIALLY IMPLEMENTED.** Reception reschedule (G-07,
staging PROVEN), doctor console (Phase 6), queue next/call (queue runtime 43/45),
clinical operations (46), leave management schema (31). **Gap:** doctor
schedule/leave **write** path absent (C4, NOT READY — no write RPC/Edge, §6.3).

**Finance/settlement journey — IMPLEMENTED, derived-not-hand-maintained.**
booking → payment → capture → revenue-at-capture (D16/59) → refund unification
(60) → settlement refactor (33) → daily collections → reconciliation → reports →
audit. Financial reports read authoritative ledgers (G-06/G-09, `verify_integration
_matrix` audit on AdminAudit). **Remaining = policy rulings (NPD-01 GST, cadence,
partials), Category E** (§8).

**Notifications/alerts — C2 CLOSED + HTTP/concurrency proven; C2b composed.**
Alert lifecycle read (G-10, staging PROVEN) + writes (acknowledge/resolve/
escalate/suppress; backend CLOSED, HTTP H1–H15, **G-UI mutation UI now
IMPLEMENTED/locally verified**) + broadcasts (C2b UI). **Small gap:** alert
*assignment* UI intentionally deferred until an assignable-user directory exists
(G-UI §13). Delivery-status UI closed (C5/Phase 7).

---

## 13. Analytics / Reporting

Command center (47 + `command-center`), executive analytics (`executive-
analytics`), enterprise reports (`enterprise-reports`), operations analytics
(G-11), financial command center (`financial-command-center`), portfolio (G-08),
audit (G-05), SLA (`compute-sla`), rollups (21). All admin read surfaces use
**real backend RPCs, not static/demo values** (G-03…G-11 integration suites,
162/162 cross-feature, readiness §5). Staging: G-07…G-10 **PROVEN**; **G-11
UNPROVEN on staging** (Category B/C).

---

## 14. Testing Estate

| Layer | Latest measured result | Level |
| --- | --- | --- |
| Unit (Deno) | **97/97** | INTEGRATION-independent local run (hygiene §6, G7-13 §7) |
| Migration validate | **0 errors, 4 pre-existing `[duplicate-objects]` warnings** | STATIC (baseline, AGENTS §13) |
| Migration manifest | **64 disk / 64 manifest, 0 integrity issues** | STATIC (G7-16 §6) |
| `gen:types:check` / `check` / `lint` / `fmt:check` | **all PASS** (hygiene §6) | STATIC/local |
| Privilege isolation | **25/25** (F16-06 → 100% locked denial coverage) | INTEGRATION (local) |
| C2 alert lifecycle | HTTP **28/28**, concurrency **30/30**, regression **162/162** | INTEGRATION (local) |
| Frontend vitest | **389 passed / 0 failed (30 files)** incl. G-UI; C2b **46** | UNIT/COMPONENT (local) |
| Financial (`d16_financial_policy`, refund, settlement) | PASS | INTEGRATION (local) |
| WhatsApp lifecycle/conversational | PASS | INTEGRATION (local); HMAC **PARTIAL** (fake secrets) |

No `.skip`/`.only`/`Deno.ignore` (readiness §7). **Gaps:** C2-write and G-11
**staging UNPROVEN**; broadcast_* writes have **no real HTTP write coverage** (R2
debt half-discharged); Docker-dependent browser walks BLOCKED.

---

## 15. CI/CD · Deployment · Observability · Backup/DR

- **CI present** (`.github/workflows/ci.yml`) incl. migration-manifest integrity
  + append-only PR steps (**G7-16 verified already wired at HEAD**). **CD absent.**
- **GitHub Actions execution UNPROVEN until first push** (nothing pushed; local
  ahead 2 with a large uncommitted set) — Category **E** (owner push/SCM
  discipline; risk R4).
- **Vercel** staging (`setura-delta.vercel.app`) is the deployed frontend artifact
  for G-07…G-10 walks; production deploy NOT performed.
- **Observability:** internal `logger.ts`/`metrics.ts`/`tracing.ts` +
  `monitoring-health-check` exist; **`SENTRY_DSN` declared but unused**, no wired
  external provider (D17) — Category **E** (provider decision).
- **Backup/DR:** Supabase platform provides infra, but **D5 backup/PITR is
  DEFERRED BY OWNER** and mandatory before real patient data (Part 5A §3) —
  Category **E**. Migration recovery relies on the manifest/immutability guard
  (present). No DR drill exists.

---

## 16. Documentation

Reports are prolific (100+ root `.md`). Contradictions found are **documentation
only** (Category F), not product: AGENTS.md §13 stale on git-repo/scheduler (§2);
F16-07 comment "193 RLS policies" corrected (fixed in
`F16_07_SECURITY_QUALITY_REMEDIATION_REPORT.md`); MANIFEST 63→64 gap closed
(G7-16). `AUDIT_REPORT.md` / older phase reports predate the newer closures and
should be read with the readiness report as the current authority. Recommend a
single reconciliation touch-up of AGENTS.md §13 and the roadmap status columns at
the next documentation pass (Category F).

---

## 17. Dead / Orphaned / Duplicate Code

- **P2-11** ~27% caller-less SQL routines — **KNOWN/ACCEPTED**, do not delete
  (roadmap §12). Category F/A-low.
- **AI Insights** flag (no impl), **subscription** `razorpay_subscription_id`
  (no edge) — **placeholders pending decision**, not dead bugs. Category A/E.
- **Root scratch artifacts** (~100 untracked logs/PNG/JSON/PS1) — hygiene debt,
  D15 DEFERRED. Category F.
- `vector` container restart loop locally — environment, irrelevant to app tests.
- Zero TODO/FIXME/HACK and zero disabled tests confirmed.

---

## 18. Previously Closed Workstreams — Status (read-only re-confirmation)

| Workstream | State | Evidence | Verdict |
| --- | --- | --- | --- |
| G-03 Command Centre | closed | 30/30 regression; g08 smoke | **CLOSED — DO NOT REOPEN** |
| G-05 Audit & Compliance | closed | 30/30 + 10/10 | **CLOSED** |
| G-06 Executive Reports | closed | 30/30 | **CLOSED** |
| G-07 Staff Reschedule | closed | 13/13 + staging PROVEN | **CLOSED** |
| G-08 Global Portfolio | closed | 9/9 + 30/30 + staging | **CLOSED** |
| G-09 Finance/Collections | closed | 13/13 + 22/22 + staging | **CLOSED** |
| G-10 Alert Center Read | closed | 28/28 + staging PROVEN | **CLOSED** |
| G-11 Ops Analytics | closed local | 14/14 + 12/12; staging UNPROVEN | **CLOSED (local)** |
| C2 Alert Lifecycle | closed local | HTTP 28/28, concurrency 30/30 | **CLOSED (local)** |
| G-UI Alert Mutation UI | implemented | 389 frontend tests; browser BLOCKED | **CLOSED (local)** |
| C2b Broadcast Composer | implemented | 46 tests; runtime BLOCKED | **CLOSED (local)** |
| GEN-TYPES / hygiene | resolved | lint/fmt/gen:types PASS | **CLOSED (local)** |
| G7-13 (F16-05/06) | resolved | privilege 25/25, 100% coverage | **CLOSED (local)** |
| F16-07 | resolved | comment corrected; suite re-run 25/25 | **CLOSED** |
| G7-16 (manifest) | resolved | 64/64, guard proven | **CLOSED (local)** |

**No regression detected** in this read-only pass. All remain CLOSED; several
carry only **staging/production verification debt**, not code debt.

---

## 19. Software-Completion Matrix

| Area | Current state | Evidence | Category | Remaining software work | Real account needed? | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| Booking/token/queue engine | Impl + local int | migrations 02/43/45, E1 PASS | D (live) | none | No | — |
| Consultation notes | Impl + local int | mig 63, suite | — | none | No | — |
| Payment order/capture/refund | Impl + local int | 13/56/59/60, d16 suite | D/E | policy rulings (GST/partials/cadence) | Razorpay live | P1 |
| Settlement/collections | Impl + local int | 33, G-06/09 | — | none | No | — |
| WhatsApp engine | Impl + local int | 04/42, suites | A/D | per-hospital credential write | Meta live | P1 |
| Alerts (C2 + G-UI) | Impl + local HTTP/concurrency | C2, G-UI | C | staging write proof; assignment UI | No | P2 |
| Broadcasts (C2b) | Impl + unit | C2b report | B/C | runtime/staging delivery proof (needs worker) | No | P2 |
| Admin read surfaces | Impl, G-07…10 staging-proven | 162/162 | B/C | G-11 staging | No | P3 |
| Worker lifecycle | Impl + local reclaim | 50/51/52, G7-01 | E/D | activation decision + 24h soak proof | prod secret | P1 |
| Scheduler | Impl + local firing | 53/57/58 | D/E | hosted pg_cron/pg_net/Vault proof | prod config | P1 |
| Privilege boundary | 177/177 local | G7-13 | D | production re-measure (G7-04) | deploy | P1 |
| CI | present | ci.yml | E | GitHub execution proof (push) | push auth | P2 |
| CD/deploy | **absent** | readiness §4 | E | pipeline build at deploy time | deploy auth | P1 |
| Observability | internal only | logger/metrics/tracing | E | Sentry wiring | provider | P2 |
| Backup/DR | deferred | Part 5A §3 | E | tier choice + drill | prod | P1 |
| **Hospital tenant creation** | **absent** | no RPC/Edge; seed only | **A** | **RPC/Edge + UI** | No | **P0** |
| **Hospital config write (fees/hours/queue/flags)** | **absent** | `hospital_settings` read-only | **A** | **write RPC/Edge + UI** | No | **P0** |
| **Integrations config UI + test-connection** | **absent** | no route/wrapper | **A** | **credential-entry surface + validation** | No | **P0** |
| Doctor schedule/leave **write** | absent | C4 NOT READY | A/E | design + write RPC/Edge/UI | No | P1 |
| SaaS subscription billing | schema-only | 32; no edge | A/E | billing decision + impl | Razorpay | P3 |
| Fine-grained permissions | defined/unused | 27; not called | A/E | decision + `has_permission` wiring | No | P2 |

---

## 20. Prioritized Remaining Software Backlog

### P0 — Genuine blockers to "technically complete for onboarding"

**WS-ONBOARD-1 · Hospital tenant provisioning**
- Objective: create a hospital tenant (row + auth users + default settings) without SQL.
- Current: seed-only (`01_foundation.sql:531`); auto-settings trigger exists (12).
- Files: new migration (RPC `create_hospital`/`provision_hospital`), new/extended
  Edge action, admin UI. Depends on RLS/audit/idempotency primitives (all present).
- Impl: SECURITY DEFINER RPC (service_role) with explicit `REVOKE` (F16-04 rule),
  audit event, idempotency; Edge action `requireRole(global_admin)`; UI form.
- Tests: tenant-isolation, idempotency/replay, audit, privilege denial.
- Done: a global admin creates a working tenant purely from the UI.

**WS-ONBOARD-2 · Hospital configuration write surfaces**
- Objective: edit fees, booking/platform fee, GST/legal, operating hours, holidays,
  queue config, display name, language, country code, max advance days, feature
  flags via UI → RPC.
- Current: `hospital_settings`/config schema exists (12/35/37) but is read-only
  from the app; versioning trigger already present (18).
- Impl: `update_hospital_config` RPC (+ explicit REVOKE), Edge action, admin forms
  mirroring existing schema; reuse `version_hospital_settings` for rollback.
- Tests: validation, tenancy, audit, config-rollback, privilege.
- Done: a hospital is fully operationally configured without a developer.

**WS-ONBOARD-3 · Integrations configuration + test-connection UI**
- Objective: enter/rotate/enable-disable Razorpay & per-hospital Meta ids, validate
  connections, audit, without env edits for the *non-secret* per-hospital values.
- Current: secrets are global env (`env.ts`); `hospital_settings` stores ids only;
  no write path/UI. Decide single-platform vs per-hospital credential model
  (owner input, §6.4) then build the surface.
- Tests: connection validation (mocked provider), no-secret-leak, tenancy, audit.
- Done: WhatsApp/Razorpay per-hospital wiring + test-connection from the UI.

### P1 — Required for production-grade operation (many are decisions/verification, not new core code)
- Financial rulings + enforcement (NPD-01 GST, refund≤collected, cadence, partials) — **E** then A.
- Doctor schedule/leave **write** path (C4) — A/E.
- Worker activation + ≥24h unattended soak + scheduler hosted proof (D5/D6/D7) — E/D.
- CD/deploy pipeline; production secrets/Vault; production privilege re-measure (G7-02/03/04) — E/D.
- Backup/DR tier + drill (D5) — E.
- Per-hospital WhatsApp credential support if multi-hospital live (finding 7) — A.

### P2 — Important improvements
- Alert assignment UI (needs assignable-user directory). C2b/G-UI/C2 staging write proof.
- Sentry/observability wiring (D17). Fine-grained `has_permission` wiring (if required).
- verify-payment webhook rate-limit confirmation before prod gate.

### P3 — Later
- SaaS subscription billing enforcement. Load test (G7-14). Locale/currency
  abstraction for market expansion. P2-11 orphaned-routine cleanup. Root scratch
  hygiene (D15), D8 graphify-out tracking.

---

## 21. Recommended Implementation Order (by real dependency graph)

```text
1. WS-ONBOARD-1 (tenant creation RPC+Edge+UI)   ← unblocks everything else
2. WS-ONBOARD-2 (config write RPC+Edge+UI)       ← fees/queue/hours make pilot real
3. Owner ruling: single-platform vs per-hospital credentials (§6.4)
4. WS-ONBOARD-3 (integrations config + test-connection UI)
5. Doctor schedule/leave write path (C4)          ← completes staff journey
6. Financial rulings → enforcement (refund≤collected, partials, cadence)
7. Deploy: push → CI green → CD pipeline → staging G-11 + C2/C2b write re-proof
8. Worker/scheduler activation + 24h soak + production privilege re-measure (G7-04)
9. Secrets/Vault + SMTP + domain + Sentry + Backup/DR drill
10. Real Razorpay/Meta test-credential staging (G7-05/06) → pilot tenant onboarding
```

Rationale: the **entire onboarding layer is a single dependency root** — the rest
of the system already consumes `hospital_settings`; once a safe write RPC/Edge/UI
exists, real hospitals become configuration work. Deploy/verification items are
sequenced last because they are gated by owner authorization, not by code.

---

## 22. Final Executive Summary

### What is already built (concrete)
Multi-tenant foundation with RLS + service-role boundaries; atomic token/booking
state machine; queue runtime; doctor clinical workflow; payment capture, refunds,
settlement, daily collections, revenue-at-capture (D16); WhatsApp messaging +
conversational engines; notification delivery-status; alert lifecycle (C2 backend
HTTP/concurrency-proven) **with** the G-UI mutation UI; C2b broadcast composer;
enterprise command center, executive/operations/financial/portfolio/audit read
surfaces; background worker with lease/reclaim; **a scheduler (pg_cron/pg_net,
migration 53)**; config versioning/rollback; audit; idempotency; rate limiting;
retention/partitioning; a React admin/staff/patient frontend; CI with
migration-manifest enforcement. Privilege denial coverage 177/177; unit 97/97;
C2 HTTP 28/28; frontend 389 passing — **all LOCAL**.

### What is still genuine software work (Category A)
1. **Hospital tenant creation** (no RPC/Edge/UI).
2. **Hospital configuration write path** (fees/hours/holidays/queue/flags/branding — `hospital_settings` is app-read-only).
3. **Integrations configuration + test-connection UI** (Razorpay/Meta id entry, rotation, enable/disable, audit).
4. **Doctor schedule/leave write** (C4).
5. Per-hospital WhatsApp credential support (only single global Meta today).
6. Fine-grained `has_permission` wiring (defined but unused).
7. SaaS subscription billing (schema-only) — if in scope.
8. CD/deploy pipeline (CI exists, CD absent).

### What is complete but not live/staging-verified (B/C)
G-11 staging; C2/C2b write staging + browser walks; end-to-end worker/scheduler
unattended ≥24h; broadcast delivery proof (needs worker).

### What only needs real accounts later (D)
Live Razorpay (G7-05), live Meta/WhatsApp (G7-06), SMTP (D12), production domain
(D13), production secrets/Vault, production privilege re-measure (G7-04).

### What still needs owner/business decisions (E)
NPD-01 GST/CA; financial cadence & partial-refund policy; credential model
(single-platform vs per-hospital); D5 backup/DR; D6 worker default; D15 data
retention/offboarding; D17 observability provider; scheduler production
provisioning; SCM push/commit discipline (risk R4).

### Biggest technical risks (evidence-based)
- **No onboarding layer** → cannot pilot a hospital without a developer (P0).
- Worker/scheduler **never proven unattended end-to-end in any environment**
  despite local pieces passing.
- **No CD pipeline**; CI execution unproven (nothing pushed).
- Financial policy rulings unresolved → refund/settlement edge cases.
- Single-global-Meta fallback breaks multi-hospital WhatsApp isolation.
- Production privilege/JWT/config **UNPROVEN** — local PASS ≠ production PASS.

### Estimated remaining engineering effort (no false precision)
- Onboarding layer (WS-ONBOARD-1/2/3, RPC+Edge+UI+tests): **~3–5 weeks**.
- Doctor schedule/leave write path: **~1–2 weeks**.
- Financial rulings→enforcement (post-decision): **~1–2 weeks**.
- Deploy/CD + worker/scheduler activation + staging/production verification +
  backup/observability: **~2–3 weeks** (much is config/authorization-bound).
- Owner-decision latency and real-account provisioning are schedule risks, not
  effort.

### Technical-completion definition
SETURA is **TECHNICALLY COMPLETE** when: a global admin can **create a hospital
tenant**, set **all operational configuration** (fees, hours, holidays, queue,
branding, feature flags), **enter/validate integrations** (Razorpay key-id,
per-hospital Meta ids) and **create doctor schedules/leave** — each through the
frontend over audited, tenant-isolated, idempotent, privilege-locked RPCs — with
**no SQL, no env edit and no code change for that hospital**; and the worker +
scheduler run **unattended ≥24h** with end-to-end delivery, and the production
privilege catalog is re-measured green. Live Razorpay/Meta behavior and real
credentials remain **Category D** (verification, not software) and do NOT block
technical completion.

**Do not confuse missing real-world credentials with missing software — but note
that the onboarding/configuration layer is genuinely missing software, not
merely missing credentials.**
