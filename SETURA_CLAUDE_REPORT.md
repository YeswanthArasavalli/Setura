# SETURA — Independent State Investigation

**Investigator posture:** read-only. Zero files modified. No migrations run, no
schema touched, no code fixed.

**Date:** 2026-08-19 **Working tree:** `d:\Projects\datasets\setura` (not a git
repository — no history available to cross-check)

---

## A. Executive Summary

The project is materially further along than its documentation, and materially
less certified than its documentation claims.

Three findings dominate everything else:

1. **An entire uncertified phase exists in the repo.** Phase 1.5 (Enterprise
   Command Center) is ~81 KB of SQL, 31 RPCs, 2 new tables, 5 edge functions, 2
   shared modules and a 23-test integration suite. It has no completion report,
   and two certification gates currently fail — both on its own test file. The
   last `supabase db reset` artifact in the repo predates it.

2. **A systemic database privilege defect spans the whole project, and Phase 1.5
   reintroduced it at the worst possible layer.** PostgreSQL grants
   `EXECUTE … TO PUBLIC` on every function by default. Migrations 27–46
   progressively learned to `REVOKE` this. Migrations 01–26 (108 functions) and
   migration 47 (31 functions) never do. That leaves ~129 `SECURITY DEFINER`
   functions — including cross-hospital portfolio dashboards, audit-log search,
   alert mutations, and payment capture — reachable via PostgREST by the `anon`
   role. This is a code-level certainty; the runtime confirmation requires one
   query I could not run (Docker is down).

3. **Roadmap numbering is fiction.** ROADMAP.md has no Phase 1.5 and never
   mentions migrations 38–47. The scope labelled "Phase 1.1–1.4" in the
   completion reports appears nowhere in the roadmap; the roadmap's actual
   1.1–1.4 was delivered under the label "Phase 0.5." Two migrations (38, 39)
   are documented in no file anywhere.

**Honest state:** the backend is a genuinely sophisticated, disciplined system —
47 migrations, 230 functions, 26 edge functions, 165 tests, zero
used-but-undefined RPCs, essentially no TODO/mock/stub debt. It is not
production-ready. It has never had a security review of function-level
privileges, and its most recent phase has never been certified.

**Recommended next step is not Phase 1.5 certification.** It is a security
remediation phase (call it 1.4.5) that must land before 1.5 is certified —
because certifying 1.5 as-is would stamp "certified" on 31 anon-callable RPCs.
Details in §L.

---

## B. Repository Reality

### What actually exists

| Component                                    | Actual             | Doc claims                              |
| -------------------------------------------- | ------------------ | --------------------------------------- |
| Migrations                                   | 47                 | 37 (ROADMAP, AUDIT_REPORT, CROSS_CHECK) |
| SQL functions (`CREATE OR REPLACE FUNCTION`) | 230                | not stated                              |
| SECURITY DEFINER functions                   | 211                | not stated                              |
| Distinct tables created                      | 100                | not stated                              |
| `ENABLE ROW LEVEL SECURITY` statements       | 90                 | "all tables"                            |
| `FORCE ROW LEVEL SECURITY` statements        | 80                 | —                                       |
| `CREATE POLICY`                              | 135                | —                                       |
| Unique partial indexes                       | 14                 | —                                       |
| Edge function directories                    | 26                 | 21 (AUDIT_REPORT)                       |
| `_shared` TS modules                         | 29                 | 16 (AUDIT_REPORT)                       |
| Test files / `Deno.test` cases               | 12 / 165           | "no tests" (AUDIT_REPORT)               |
| Frontend                                     | absent — confirmed | "screens don't exist" ✓                 |

Root contains only: `ARCHITECTURE.md`, `AUDIT_REPORT.md`,
`CROSS_CHECK_REPORT.md`, `ROADMAP.md`, and five `PHASE_*_COMPLETION_REPORT.md`
files. There is no `PHASE_0_COMPLETION_REPORT.md` and no
`PHASE_1.5_COMPLETION_REPORT.md`.

Directory listing is exhaustively: `.github`, `.qoder`, `docs`, `scripts`,
`supabase`, `tests`. No `web/`, `app/`, `src/`, `frontend/`, `package.json`, or
any UI artifact anywhere. Frontend absence is confirmed, not inferred.

### Edge functions (26)

`alert-center`, `cancel-booking`, `carry-forward-tokens`, `command-center`,
`compute-sla`, `create-booking`, `create-payment-order`, `doctor-operations`,
`enterprise-reports`, `executive-analytics`, `financial-command-center`,
`monitoring-health-check`, `process-refund`, `process-whatsapp-webhook`,
`queue-control`, `queue-next-patient`, `refresh-rollups`, `reschedule-booking`,
`run-background-worker`, `run-cron-minute`, `run-cron-nightly`,
`send-reminders`, `send-whatsapp-message`, `settlement-engine`,
`update-booking-status`, `verify-payment`

### Test distribution (165 cases)

| File                                            | Cases | Documented as certified? |
| ----------------------------------------------- | ----- | ------------------------ |
| `unit/validation.test.ts`                       | 15    | ✅ part of 37            |
| `unit/errors.test.ts`                           | 12    | ✅                       |
| `unit/response.test.ts`                         | 10    | ✅                       |
| `integration/whatsapp_conversational.test.ts`   | 28    | ✅ Phase 1.1             |
| `integration/doctor_operations.test.ts`         | 16    | ✅ Phase 1.4             |
| `integration/queue_runtime.test.ts`             | 16    | ✅ Phase 1.2             |
| `integration/queue_operations.test.ts`          | 12    | ✅ Phase 1.3             |
| `integration/local_stack.test.ts`               | 11    | ✅ Phase 0               |
| `integration/whatsapp_lifecycle.test.ts`        | 9     | ✅                       |
| `integration/usage_retention.test.ts`           | 8     | ✅                       |
| `integration/refund_sync.test.ts`               | 5     | ✅                       |
| `integration/enterprise_command_center.test.ts` | 23    | ❌ undocumented          |

Unit = 37 ✓ (matches every report). Integration excluding enterprise = 105 ✓
(exactly the Phase 1.4 certified figure). Adding the enterprise suite gives 128.
This arithmetic is the cleanest single proof that Phase 1.5 tests were written
after the last certification run and never included in one.

### File-mtime timeline (independent corroboration)

```
Aug 11 11:06  supabase-reset.log            ← last db-reset artifact in repo
Aug 11 15:21  _check.log                    ← last deno check artifact
Aug 11 22:55  46_doctor_clinical_operations.sql
Aug 11 23:35  _shared/database.generated.ts ← types generated
Aug 11 23:41  alert-center/index.ts         ┐
Aug 11 23:50  command-center/index.ts       │ Phase 1.5 edge + docs
Aug 11 23:50  ARCHITECTURE.md, ERROR_CONTRACT.md
Aug 11 23:51  docs/API_CONTRACTS.md         ┘
Aug 12 12:19  47_enterprise_command_center.sql  ← edited AFTER type generation
Aug 12 12:20  enterprise_command_center.test.ts
Aug 18 22:30  PHASE_1.4_COMPLETION_REPORT.md
```

Note the ordering anomaly: migration 47 was last edited 12h44m after types were
generated from it. Types do contain Phase 1.5 symbols (verified), but may be
stale relative to the final migration. `deno task gen:types` should be re-run.

---

## C. Roadmap vs Reality

### The core drift

ROADMAP.md defines: **1.1** WhatsApp Reliability → **1.2** Refund Consistency →
**1.3** Retention & Maintenance → **1.4** Subscription Platform.

The completion reports deliver: **1.1** Conversational WhatsApp → **1.2** Queue
Runtime → **1.3** Operations & Exceptions → **1.4** Doctor Clinical Ops.

These are entirely different work items sharing the same labels. The roadmap's
1.1–1.4 was actually delivered — all of it — inside
`PHASE_0.5_COMPLETION_REPORT.md` (migrations 40–41). So the label "Phase 1.4"
means two incompatible things depending on which document you read.

### Phase-by-phase truth table

| Label   | Roadmap scope                                 | What was actually built                                           | Migrations | Tests    | True status                    |
| ------- | --------------------------------------------- | ----------------------------------------------------------------- | ---------- | -------- | ------------------------------ |
| 0       | Foundation & test harness                     | Harness, CI, validator, 37 unit + 11 stack tests                  | 01–37      | 48       | ✅ built, no completion report |
| 0.5     | Architecture freeze doc only                  | Freeze doc + all of roadmap 1.1–1.4                               | 40, 41     | 33 total | ✅ certified (over-delivered)  |
| —       | (nothing)                                     | `38_missing_rpc_functions.sql`                                    | 38         | —        | ⚠️ documented nowhere          |
| —       | (nothing)                                     | `39_schema_alignment.sql`                                         | 39         | —        | ⚠️ documented nowhere          |
| 1.1     | WhatsApp reliability                          | Full conversational engine (roadmap Phase 3, explicitly descoped) | 42         | +28      | ✅ certified, off-roadmap      |
| 1.2     | Refund consistency                            | Queue runtime + booking state machine                             | 43, 44     | +16      | ✅ certified, off-roadmap      |
| 1.3     | Retention & maintenance                       | Operations & exception management                                 | 45         | +12      | ✅ certified, off-roadmap      |
| 1.4     | Subscription platform                         | Doctor & clinical operations                                      | 46         | +16      | ✅ certified, off-roadmap      |
| 1.5     | does not exist in roadmap                     | Enterprise command center                                         | 47         | +23      | 🔴 implemented, NOT certified  |
| 2 / 2.5 | Integration hardening / enterprise validation | partially absorbed into 41, 47 §12 verifiers                      | —          | —        | 🟡 partial                     |
| 3       | Incoming WhatsApp (descoped)                  | built in 1.1; broadcasts in 1.5                                   | 42, 47     | —        | ✅ done early                  |
| 4A / 4B | Frontends                                     | nothing                                                           | —          | —        | 🔴 not started                 |
| 5–8     | Ops excellence → launch                       | nothing                                                           | —          | —        | 🔴 not started                 |

Additional roadmap contradiction: ROADMAP Phase 3 says "defer full
conversational booking to post-pilot." Phase 1.1 built it in full, and
`_shared/enterprise/broadcasts.ts:4` states verbatim: "Completes the Phase 3
deferred operational intelligence." The team knowingly un-deferred descoped work
without amending the roadmap.

---

## D. Document Cross-Check

| Document                                  | Verdict                                                                                                                                                                                                                                                            | Evidence        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| ROADMAP.md                                | 🔴 Obsolete. Says 37 migrations; 47 exist. No Phase 1.5. Phase numbering does not map to any implementation. Phase 3 descoping violated.                                                                                                                           | `ls` = 47 files |
| AUDIT_REPORT.md (Aug 7)                   | 🔴 Badly stale. "37 migrations, 21 edge functions, 16 shared modules, no tests, no CI." Reality: 47 / 26 / 29 / 165 tests / CI exists. Its P0 (`send-whatsapp-message/index.ts:571-577` placeholder) is resolved — that file is now 863 lines with no placeholder. | direct counts   |
| CROSS_CHECK_REPORT.md (Aug 8)             | 🟡 Stale but its conclusions still hold. "WhatsApp-first → WhatsApp-notified" and "data exists, screens don't" remain accurate.                                                                                                                                    | frontend absent |
| ARCHITECTURE.md                           | 🟢 Most accurate document. §5 correctly documents the Phase 1.5 layer, migration 47, and all 5 endpoints. Two nits: says "PostgreSQL 15" but `config.toml` sets `major_version = 17`; describes Phase 1.5 as if delivered, which conceals that it is uncertified.  | `config.toml`   |
| PHASE_0.5 / 1.1 / 1.2 / 1.3 / 1.4 reports | 🟢 Accurate on their own scope. Every claimed migration, table, RPC, index, endpoint and test count I checked exists. But all five understate warnings — each says "3 pre-existing warnings"; the validator now emits 4.                                           | see §H          |
| `docs/API_CONTRACTS.md`                   | 🟡 Covers all 5 Phase 1.5 endpoints (§2–6) and prior endpoints (§7). Omits `queue-control` entirely (Phase 1.2 endpoint, 0 mentions).                                                                                                                              | `grep -c`       |
| `docs/ERROR_CONTRACT.md`                  | 🟢 Generic taxonomy, endpoint-agnostic by design. Not drift.                                                                                                                                                                                                       | 141 lines       |

**Claim-verification result:** zero fabricated artifacts. Every migration,
table, index, trigger, RPC and endpoint named in the five completion reports
exists in the repository. I found no invented deliverables. The reports' failure
mode is omission and stale gate numbers, not invention.

### Positive verifications worth stating

- **RPC integrity:** 96 distinct RPCs referenced across all edge functions vs
  230 defined. `comm -23` → zero used-but-undefined. No broken call sites.
- **Debt markers:** essentially none. No TODO/FIXME/HACK/stub/mock in production
  code. The only "placeholder" hits are migration 46's deliberate JSONB
  prescription/attachment placeholders (documented) and one string-interpolation
  comment.

---

## E. Architecture Understanding

The design is coherent and unusually disciplined. Every business number is
computed in SQL; edge functions are transport, authorization, and side-effect
orchestration only. This is stated in ARCHITECTURE.md and it holds up in code —
`_shared/reporting.ts:16` even says "No business logic lives here: numbers
always come from the SQL layer."

### Layer map

```
PostgreSQL 17 (Supabase local)
├─ 100 tables · hospital_id on every operational table
├─ 230 functions (211 SECURITY DEFINER, all with SET search_path = public)
├─ RLS: 90 ENABLE / 80 FORCE / 135 policies
├─ Immutability triggers: audit_logs, financial_ledger, consultation_notes
├─ Concurrency: 49× FOR UPDATE (10 with SKIP LOCKED), 3× advisory xact locks,
│              14 unique partial indexes as final arbiters
└─ 14 migrations attach prevent_hospital_id_update

Deno Edge (26 functions) — uniform pipeline in _shared/
  handleCors → POST guard → createTraceContext → createRequestLogger
  → createMetrics → X-Hospital-ID + resolveAuth + requireRole
  → parseBody(zod) → getServiceClient → RPC → logAuditEvent
  → successResponse / handleErrorResponse

Background: background_jobs + claim_jobs_v2 (SKIP LOCKED) + worker registry
  + heartbeat + detect_crashed_workers + lease reclaim + DLQ + POWER(2,n) backoff
Cron: run-cron-minute (8 duties) / run-cron-nightly (8 duties)
```

`resolveAuth` (`auth.ts:42`) is well-built and worth calling out as correct: it
validates the JWT via `auth.getUser()` (not manual decode), loads the profile,
rejects inactive accounts, and resolves the role from `user_roles` in the DB,
not JWT claims — with an explicit comment that claims can be stale. Hospital
membership is enforced before any business logic. `global_admin` (null
`hospital_id`) is the only bypass. Fail modes are closed.

**Where the architecture is thinner than advertised:** the Phase 1.5
alert-lifecycle RPCs (`acknowledge_alert`, `assign_alert`, `resolve_alert`,
`escalate_alert`) take no `p_hospital_id`. Tenant isolation for them lives only
in the edge layer's `loadAuthorizedAlert()` pre-check
(`alert-center/index.ts:145`). Phase 1.4 deliberately enforced isolation at both
layers (`booking_not_in_session`) and its report bragged about it. Phase 1.5
regressed to single-layer.

---

## F. Important Flows (traced through actual code)

**1. Booking → payment → ledger.** `create-booking` (dedupe by phone, atomic
token allocation) → `create-payment-order` (Razorpay order) → `verify-payment`.
The verify path is genuinely well built: it accepts both webhook
(`X-Razorpay-Signature`) and frontend-callback shapes, computes HMAC-SHA256, and
compares in constant time with a length pre-check. It calls
`idempotent_capture_payment` (which wraps `register_webhook_event_v2` for
payload-hash dedupe), which calls `capture_payment` — writing
`payment_orders.captured`, `bookings.payment_completed`, and three
`financial_ledger` rows (booking fee credit, gateway fee debit, GST debit)
atomically. `verifyPaymentSignature` throws if `RAZORPAY_KEY_SECRET` is missing
— correctly fail-closed.

**2. Doctor consultation day.** `doctor-operations` (15 actions) →
`open_doctor_session` → `advance_queue` (`FOR UPDATE SKIP LOCKED`,
priority-aware) → `start_consultation` → `complete_consultation` → SLA refresh
job → `save_consultation_note`. The one-active-consultation invariant is
enforced by unique partial index `uq_one_active_consultation_per_doctor`, which
is the final arbiter when two calls race — Phase 1.4's test 6 proves exactly one
winner. Correct design.

**3. Inbound WhatsApp.** `process-whatsapp-webhook` → HMAC gate → intent router
(deterministic, no LLM) → `whatsapp_conversation_states` machine with TTL → flow
handlers. Outbound is always queued via `enqueue_job` with deterministic keys;
`send-whatsapp-message` is worker-invoked only. Patient broadcasts gated on the
`whatsapp_queue_updates` flag. The HMAC gate is fail-open — see G-2.

**4. Alert lifecycle (Phase 1.5).** `alert-center` →
`requireRole(["hospital_admin","global_admin"])` → `loadAuthorizedAlert`
(explicit `data.hospital_id !== hospitalId` → 403) → dynamic RPC dispatch →
`log_alert_activity` → audit as `alert_center`. Correct at the edge; see the
single-layer caveat in §E and the privilege issue in G-1.

**5. Cross-tenant reads.** `executive-analytics` correctly gates portfolio and
benchmarks behind `GLOBAL_ACTIONS.has(action) && auth.role !== "global_admin"` →
reject (line 114). Every hospital-scoped call passes `p_hospital_id: hospitalId`
from the validated header — never null. The edge layer is correct here. The
exposure is that the RPCs are reachable without going through the edge at all.

---

## G. Security Status

### G-1 · CONFIRMED — CRITICAL — Systemic `EXECUTE … TO PUBLIC` on SECURITY DEFINER functions

PostgreSQL grants `EXECUTE` to `PUBLIC` on every newly created function by
default. `anon` and `authenticated` both inherit `PUBLIC` grants. Supabase
exposes schema `public` via PostgREST (`config.toml` →
`schemas = ["public", "graphql_public"]`), so any executable function is
callable at `POST /rest/v1/rpc/<name>` by any role that can execute it.

**Measured REVOKE coverage per migration:**

| Range          | Functions | `REVOKE … ON FUNCTION` | Status                                                         |
| -------------- | --------- | ---------------------- | -------------------------------------------------------------- |
| 01–26          | 108       | 0                      | 🔴 all retain PUBLIC default                                   |
| 27–46          | 91        | 54                     | 🟡 progressive adoption (42: 4/4, 43: 10/12, 45: 5/6, 46: 8/9) |
| 47 (Phase 1.5) | 31        | 0                      | 🔴 full regression                                             |

~129 `SECURITY DEFINER` functions in the unrevoked ranges. `SECURITY DEFINER`
means they run as the owner and bypass RLS and table grants entirely — the
table-level REVOKEs that migration 47 does apply provide no protection against
them.

Concrete exploitable surface in Phase 1.5 alone (migration 47 §13, lines
2503–2512, revokes only the two tables; the `GRANT EXECUTE … TO service_role`
for all 31 functions adds a grant, it does not remove the PUBLIC default):

- `get_portfolio_dashboard(date)` — every hospital's operations + revenue
- `get_cross_hospital_benchmarks(…)` — full cross-tenant benchmarks
- `search_audit_logs(hospital, …)` — any hospital's complete audit trail
- `get_financial_command_center`, `get_revenue_forecast`,
  `get_daily/weekly/monthly_dashboard`, `get_doctor_performance`,
  `get_hospital_timeline`
- Writes: `suppress_alerts(key, until, actor, hospital ⇒ NULL, reason)` —
  `p_hospital_id` defaults to NULL, and `is_alert_suppressed` treats
  `hospital_id IS NULL` as matching every hospital → one call blinds
  platform-wide monitoring
- Writes: `acknowledge_alert` / `resolve_alert` / `escalate_alert` /
  `assign_alert` — no hospital parameter at all
- Writes: `fire_managed_alert(…)` — inject arbitrary alerts for any hospital

The two `LANGUAGE sql` helpers (`is_alert_suppressed`, `log_alert_activity`) are
`SECURITY INVOKER` — the correct choice — and are therefore genuinely protected
by the table REVOKEs. That is the one piece of migration 47's privilege design
that works.

### G-2 · CONFIRMED — CRITICAL — `capture_payment` is authenticated-callable and performs no verification

`34_payment_ledger_cleanup.sql:246` and `:267`:

```sql
GRANT EXECUTE ON FUNCTION public.capture_payment(TEXT,TEXT,TEXT,JSONB,NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.capture_payment(TEXT,TEXT,TEXT,JSONB)         TO authenticated;
```

Both overloads are `SECURITY DEFINER`. The function accepts
`p_gateway_signature TEXT` and stores it without ever validating it. It performs
no authorization check, no `auth.uid()` check, and no hospital scoping. Given
only a `gateway_order_id` whose status is not already captured/refunded, it:

- sets `payment_orders.payment_status = 'captured'`
- sets `bookings.payment_completed = true, paid_online = true`
- inserts 3 rows into `financial_ledger`

`financial_ledger` is immutable by trigger (`13_payment_engine.sql:384` —
"financial_ledger is immutable"). Forged entries can never be corrected or
deleted, and they propagate into `hospital_settlements`, `settlement_items`,
`outstanding_balances` and platform revenue with no clean remediation path.

The edge function does everything right; the RPC simply bypasses it. Any
hospital staff account is authenticated — this is a receptionist-fraud vector
(mark unpaid bookings paid, pocket cash) even under the most conservative
reading, and cross-tenant if an order id from another hospital is learned.

### G-3 · CONFIRMED — HIGH — `create_platform_revenue_summary` is authenticated-callable and writes settlements

`33_settlement_engine_refactor.sql:305` grants EXECUTE to `authenticated` on a
`SECURITY DEFINER` function that INSERTs into `hospital_settlements` and
`settlement_items` and UPDATEs `daily_collection_entries` — for an arbitrary
`p_hospital_id`, with an arbitrary `p_performed_by` written into the settlement
record (actor spoofing).

### G-4 · CONFIRMED — HIGH — `whatsapp_conversation_states`: `GRANT SELECT TO authenticated` with no RLS

`42_whatsapp_conversational_engine.sql:392-398`:

```sql
REVOKE ALL ON TABLE public.whatsapp_conversation_states FROM PUBLIC;   -- does NOT remove
GRANT SELECT ON public.whatsapp_conversation_states TO authenticated;  -- Supabase's explicit
                                                                       -- anon/authenticated grants
```

`grep -i "ROW LEVEL\|POLICY"` against this table across all 47 migrations
returns empty — RLS is never enabled. The table holds `hospital_id`,
`phone_number`, and `context JSONB` documented in-line as "patient name, chosen
date, pending booking ids." Any authenticated user of any hospital can read
every tenant's rows via `GET /rest/v1/whatsapp_conversation_states`.

Same migration also grants EXECUTE to `authenticated` on
`record_incoming_whatsapp_message(UUID,…)` (inject fake inbound messages for any
hospital) and `set_conversation_state(UUID,TEXT,TEXT,JSONB,…)` (write arbitrary
conversation state for any hospital/phone). Together these are a WhatsApp
flow-hijack primitive: poisoned state affects the next genuine message from that
phone.

### G-5 · CONFIRMED — HIGH — `queue_runtime_events` policy is `USING (true)` for `authenticated`

`43_queue_runtime.sql:134-138`:

```sql
CREATE POLICY queue_events_read ON public.queue_runtime_events
FOR SELECT TO authenticated USING (true);
```

RLS is enabled and forced on this table — and the policy grants unrestricted
cross-tenant read of every hospital's queue events (token numbers, doctor ids,
booking ids, event metadata). This is the reason the "90 tables with RLS" figure
is not a safety metric. RLS enabled ≠ tenant isolated.

### G-6 · CONFIRMED — HIGH — WhatsApp webhook HMAC verification is fail-open

`process-whatsapp-webhook/index.ts:228-254`:

```ts
const signature = req.headers.get("X-Hub-Signature-256") ?? "";
const appSecret = Env.META_APP_SECRET;
if (appSecret && signature) { // ← omit the header ⇒ block skipped entirely
  const valid = await verifyHmac(rawBody, signature, appSecret);
  if (!valid) return new Response("Forbidden", { status: 403 });
}
// falls through and processes the body as authentic
```

`META_APP_SECRET` is `optionalEnv` (`env.ts:120`) — unset means no startup
failure and no verification. And even with the secret configured, omitting the
signature header skips verification because `""` is falsy. Contrast with
`verifyPaymentSignature`, which throws when its secret is absent. The asymmetry
is the bug: one path was written fail-closed, the other fail-open.

**Mitigating context:** `config.toml` has no `[functions.*]` block, so
`verify_jwt` defaults to `true` — which both limits anonymous reach and is
itself a deployment defect (real Meta webhooks cannot present a JWT). One of
those two must be wrong in production; both need resolving.

### G-7 · CONFIRMED — MEDIUM — Phase 1.5 tables have no RLS

`alert_activity_log` and `alert_suppressions` (`47:86`, `47:103`) —
`grep -i "ROW LEVEL SECURITY\|CREATE POLICY"` across the entire 81 KB file
returns empty.

This deviates from Phase 1.4's triple-layer pattern for `consultation_notes`
(trigger + revoke/grant + RLS-with-no-policies) and from the Phase 0.5 freeze
rule "RLS pattern … No exceptions." Mitigated by the explicit
`REVOKE … FROM anon, authenticated` at lines 2504–2511 — so it is a
defense-in-depth gap, not an independently exploitable hole. It becomes material
the moment G-1 is fixed by grant-tightening alone without adding RLS.

### G-8 · CONFIRMED — MEDIUM — `resolveAuth` lockout on legitimate multi-role users

`user_roles UNIQUE is (user_id, hospital_id, role)` (`01_foundation.sql:222`) —
not `(user_id, hospital_id)`. So a user may legitimately hold two roles at one
hospital (e.g. doctor + receptionist). `auth.ts:82-87` uses `.single()` on
`.eq(user_id).eq(hospital_id)` → `PGRST116` on multiple rows → `roleRow` null →
falls to the global-admin branch → `HospitalAccessDeniedError`.

Such a user is locked out of the entire platform with a misleading "hospital
access denied." Fail-closed, so not a security hole — a correctness/availability
defect the schema actively permits.

### G-9 · CONFIRMED — MEDIUM — `terminate_device_session` has no caller check

`30_device_sessions.sql:154` — `SECURITY DEFINER`, granted to `authenticated`,
`WHERE id = p_session_id AND user_id = p_user_id` with no `auth.uid()`
comparison. Requires knowing both ids; impact limited to forced logout.

### Potential concerns (not confirmed — require the live DB)

- **Runtime privilege state.** G-1 is a code-level certainty, but I could not
  execute `\df+` to confirm the resulting ACLs. Docker is down. One query
  settles it — see §L.
- **Type/schema drift.** `database.generated.ts` contains all Phase 1.5 symbols
  (verified after correcting for its UTF-16LE encoding), but migration 47 was
  edited 12h44m after generation. Signature drift is possible, not established.
- **Seed idempotency.** `supabase-start.log` ends in a real failure:
  `duplicate key value violates unique constraint "hospitals_slug_key"`.
  `seed.sql` uses `ON CONFLICT (id) DO NOTHING` for hospitals — id-idempotent
  but not slug-idempotent. Reproducible only with the stack up.
- **`prevent_hospital_id_update` coverage.** Applied in 14 migrations, none of
  them 45/46/47. Immaterial for append-only `consultation_notes`;
  `alert_suppressions.hospital_id` is service-role-mutable.

### Already fixed (verified resolved)

- ✅ AUDIT_REPORT's P0 — the `send-whatsapp-message/index.ts:571-577`
  placeholder is gone; the file is now 863 lines of real Meta Cloud API
  integration.
- ✅ Phase 1.3's phone-validation-before-PostgREST-`.or()` hardening in
  `whatsapp_queue_flow.ts` is present.
- ✅ Both HMAC comparators (`verify-payment`, webhook) use constant-time
  comparison with length pre-checks. The crypto is correct; only the gating in
  G-6 is wrong.
- ✅ Migration 38 documents and fixes two RPCs (`carry_forward_pending_tokens`,
  `compute_sla_tracking`) that were called by edge functions and migrations
  11/17 but never defined anywhere — failures were silently swallowed by
  EXCEPTION handlers. Real bug, properly fixed. It just isn't mentioned in any
  report.

---

## H. Testing & Certification Status

Every command below was actually executed in this session unless the row says
otherwise.

| Gate                | Command                         | Exists | Run now | Result                                                                        |
| ------------------- | ------------------------------- | ------ | ------- | ----------------------------------------------------------------------------- |
| Format              | `deno fmt --check`              | ✅     | ✅      | 🔴 FAIL — Found 1 not formatted file in 246 files                             |
| Lint                | `deno lint`                     | ✅     | ✅      | ✅ PASS — 69 files, 0 problems                                                |
| Typecheck           | `deno task check`               | ✅     | ✅      | 🔴 FAIL — 1 error (below)                                                     |
| Migration validator | `deno task validate:migrations` | ✅     | ✅      | 🟡 0 errors, 4 warnings (reports say 3)                                       |
| Unit tests          | `deno task test`                | ✅     | ❌      | ⚪ Not run — no Docker needed, but 37 cases are unchanged since certification |
| Integration         | `deno task test:integration`    | ✅     | ❌      | ⚪ BLOCKED — Docker daemon down                                               |
| DB reset            | `supabase db reset`             | ✅     | ❌      | ⚪ BLOCKED — Docker daemon down                                               |
| Seed                | via reset                       | ✅     | ❌      | ⚪ BLOCKED                                                                    |
| CI                  | `.github/workflows/ci.yml`      | ✅     | n/a     | 🔴 Would fail on fmt + check                                                  |

I am not claiming any gate passes that I did not run. Unit tests, integration
tests, db reset and seed are unverified in this environment — `docker ps` and
`supabase status` both fail with
`open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.`
I did not attempt a workaround, and I did not run any destructive command.

### Failure 1 — `deno fmt --check`

`tests/integration/enterprise_command_center.test.ts`, around lines 344–355
(`fixtureActor("admina", "hospital_admin", hospitalA, "01")` needs wrapping).
Cosmetic, one file, Phase 1.5's test file.

### Failure 2 — `deno task check` (this one is a real bug, not cosmetic)

```
TS2322 [ERROR]: Type '"info"' is not assignable to type
  '"critical" | "low" | "medium" | "high" | undefined'.
    p_severity: "info",
    ~~~~~~~~~~
    at tests/integration/enterprise_command_center.test.ts:1121:5
```

`10_audit_&_security_engine.sql:13` defines
`audit_action_severity AS ENUM ('low','medium','high','critical')`. `'info'` is
not a valid value. So this is not merely a type error — the test at line 1111
asserts `assertEquals(wErr, null)` after calling `write_audit_log` with
`p_severity: "info"`, which would also fail at runtime. The Phase 1.5
audit-search test has never successfully run.

### Failure 3 — the undocumented 4th validator warning

```
WARN [duplicate-objects] 47_enterprise_command_center.sql:83 — index "idx_alert_events_open"
     defined in 2 migrations (24_operational-monitoring_engine.sql:140,
     47_enterprise_command_center.sql:83) — guarded, verify intent
```

I verified intent, and intent is violated:

```sql
-- 24:140
CREATE INDEX IF NOT EXISTS idx_alert_events_open
ON public.alert_events(severity, created_at DESC) WHERE is_resolved = false;

-- 47:83
CREATE INDEX IF NOT EXISTS idx_alert_events_open
ON public.alert_events(hospital_id, is_resolved, created_at DESC);
```

Same name, different definition. On a fresh db reset, migration 24 runs first,
and migration 47's `IF NOT EXISTS` makes its CREATE a silent no-op. The
hospital-scoped index that every `get_alert_center` / `get_alert_analytics`
query depends on does not exist in the database. Those queries fall back to a
severity-leading partial index or a sequential scan. Confirmed defect; the
validator caught it and it was never triaged.

### Certification verdict

| Phase                 | Verdict                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0, 0.5, 1.1, 1.2, 1.3 | ✅ Certified as documented (gates re-verifiable once Docker is up)                                                                                                                                                             |
| 1.4                   | ✅ Certified per report, but its "3 warnings" figure was already wrong at publication time — the 4th warning arrives with migration 47, which postdates it, so 1.4's own claim is defensible                                   |
| 1.5                   | 🔴 NOT CERTIFIED. Never had a completion report. 2 of 7 gates fail. Introduced an untriaged 4th warning containing a real defect. No db reset artifact covers it. Its 23 tests have never been counted in any certified total. |

---

## I. Missing / Incomplete Work (prioritized)

### CRITICAL

1. **Function-level privilege remediation (G-1).** ~129 `SECURITY DEFINER`
   functions retain PostgreSQL's `EXECUTE TO PUBLIC` default. Needs a systematic
   `REVOKE ALL ON FUNCTION … FROM PUBLIC, anon, authenticated` sweep plus a
   validator rule so it can never regress.
2. **`capture_payment` privilege revocation (G-2).** Financial forgery into an
   immutable ledger.
3. **`create_platform_revenue_summary` privilege revocation (G-3).** Settlement
   forgery with actor spoofing.

### HIGH

4. `whatsapp_conversation_states`: enable RLS + revoke the authenticated SELECT
   (G-4). Cross-tenant patient PII.
5. Revoke `record_incoming_whatsapp_message` / `set_conversation_state` from
   `authenticated` (G-4).
6. Replace `queue_events_read USING (true)` with a hospital-scoped predicate
   (G-5).
7. Make the webhook HMAC gate fail-closed (G-6) and resolve the `verify_jwt`
   contradiction for webhook endpoints.
8. Fix the `idx_alert_events_open` collision (H-3) — rename migration 47's
   index; the Phase 1.5 alert index is currently absent.
9. Fix `p_severity: "info"` (H-2) — the only thing standing between the repo and
   a green typecheck, and it also breaks at runtime.
10. Fix `deno fmt` (H-1).
11. Write `PHASE_1.5_COMPLETION_REPORT.md` and certify Phase 1.5 — after 1–10.

### MEDIUM

12. `resolveAuth` multi-role lockout (G-8) — either change `.single()` to
    highest-privilege selection via `ROLE_HIERARCHY`, or add a
    `(user_id, hospital_id)` unique constraint. Requires a product decision (see
    §L).
13. RLS on `alert_activity_log` / `alert_suppressions` (G-7).
14. `terminate_device_session` caller check (G-9).
15. Document migrations 38 and 39 — real, load-bearing fixes with zero
    documentation.
16. Regenerate `database.generated.ts`; fix the UTF-16LE output (`gen:types`
    uses PowerShell `Set-Content`, which also makes the file un-greppable and
    Windows-only).
17. Seed slug-idempotency (`hospitals_slug_key`).
18. Add `queue-control` to `docs/API_CONTRACTS.md`.
19. `prevent_hospital_id_update` on Phase 1.3–1.5 tables.
20. Tighten alert-lifecycle RPCs to accept and verify `p_hospital_id`
    (dual-layer isolation, matching Phase 1.4).

### LOW

- `withAuth` in `auth.ts:203` is dead code — zero call sites outside its own
  definition.
- `as never` cast in `alert-center/index.ts:301` defeats RPC arg typing.
- `pdf_ready` is explicitly not PDF generation (`reporting.ts:12-14`) — fine,
  but the API contract should say so plainly.
- ARCHITECTURE.md says PostgreSQL 15; `config.toml` says 17.
- Rewrite ROADMAP.md against reality (§K).
- Mark AUDIT_REPORT.md and CROSS_CHECK_REPORT.md as superseded — they actively
  mislead.
- Frontend: 0% of Phases 4A/4B. The largest remaining scope by effort, and the
  entire product surface a hospital actually touches.

---

## J. Undocumented Work (implemented, in no document)

| Artifact                                                                                                                                                    | Size            | Referenced in           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ----------------------- |
| `38_missing_rpc_functions.sql`                                                                                                                              | 8,025 B         | nothing                 |
| `39_schema_alignment.sql`                                                                                                                                   | 10,950 B        | nothing                 |
| `47_enterprise_command_center.sql` — 31 RPCs, 2 tables                                                                                                      | 80,912 B        | ARCHITECTURE.md §5 only |
| `tests/integration/enterprise_command_center.test.ts` — 23 tests                                                                                            | 1,608 lines     | nothing                 |
| 5 enterprise edge functions (`command-center` 503, `executive-analytics` 327, `alert-center` 398, `enterprise-reports` 397, `financial-command-center` 190) | 1,815 lines     | ARCHITECTURE.md §6      |
| `_shared/enterprise/broadcasts.ts`                                                                                                                          | 419 lines       | ARCHITECTURE.md §5      |
| `_shared/reporting.ts`                                                                                                                                      | 113 lines       | ARCHITECTURE.md §5      |
| `_shared/phone.ts`                                                                                                                                          | 78 lines        | ARCHITECTURE.md §5      |
| `docs/API_CONTRACTS.md`, `docs/ERROR_CONTRACT.md`                                                                                                           | 200 + 141 lines | ARCHITECTURE.md §7      |
| Phase 0 itself — 37 migrations, harness, CI, validator                                                                                                      | —               | no completion report    |

Migration 38's header is worth quoting because it documents a bug class nobody
carried forward: "Phase 0 migration verification found two RPCs called by Edge
Functions and by migrations 11/17 that were never defined anywhere … (silently
swallowed by their EXCEPTION handlers)." It also adds `sla_wait_breached` /
`sla_completion_breached` to `sla_daily_tracking`, which migration 24 never
created despite `compute-sla` reading them. That is exactly the kind of latent
defect this investigation was asked to surface — and it was already found and
fixed, then left undocumented.

---

## K. Documentation Drift

| Document                | Action                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ROADMAP.md              | 🔴 Rewrite. "37 migrations" → 47. No Phase 1.5 entry. Phase labels 1.1–1.4 collide with two different scopes. Phase 3 descoping was silently reversed. |
| AUDIT_REPORT.md         | 🔴 Mark superseded. Its headline counts are wrong in every dimension and its P0 is fixed.                                                              |
| CROSS_CHECK_REPORT.md   | 🟡 Mark superseded; its qualitative conclusions survive.                                                                                               |
| ARCHITECTURE.md         | 🟢 Keep. Add "Phase 1.5 is implemented but uncertified." Fix PG 15 → 17.                                                                               |
| Completion reports ×5   | 🟡 Add an errata line: the validator now emits 4 warnings, not 3.                                                                                      |
| `docs/API_CONTRACTS.md` | 🟡 Add `queue-control`. Note `pdf_ready` ≠ PDF.                                                                                                        |
| Missing entirely        | `PHASE_0_COMPLETION_REPORT.md`, `PHASE_1.5_COMPLETION_REPORT.md`, docs for migrations 38–39, and a `SECURITY.md` recording the privilege model.        |

**Meta-observation:** the drift is one-directional — the code is always ahead of
the docs, never behind. Nothing was ever claimed and not built. That is a
healthy failure mode, and it means the fix is documentation work, not recovery
work.

---

## L. Exact Recommended Next Step

**Do not certify Phase 1.5 next. Run a security remediation phase first.**

### Phase 1.4.5 — Database Privilege & Tenant-Isolation Hardening

**Why this and not Phase 1.5 certification:** certifying 1.5 as-is would place a
"certified" stamp on 31 RPCs callable by anon, including cross-hospital
portfolio dashboards, audit-log search, and platform-wide alert suppression.
Certification is the project's trust mechanism; spending it on a layer with G-1
unresolved devalues every prior certification. G-2 additionally writes forged
rows into an immutable ledger — meaning the cost of delay is permanent,
unrepairable data corruption, not a bug to patch later. And the fix is cheap:
REVOKE statements in one new migration, no logic changes, no API changes.

**Why not the frontend:** Phases 4A/4B are the largest remaining scope, but
building UI on a backend where any authenticated user can forge payments means
the security fix later has to be re-validated against a much larger surface.

### Prerequisite (blocking — do this first)

Start Docker Desktop, then confirm G-1 empirically before writing a single line:

```sql
-- Which functions are executable by anon/authenticated?
SELECT p.proname, p.prosecdef AS security_definer,
       array_to_string(p.proacl, ' | ') AS acl
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND (p.proacl IS NULL                                    -- NULL ⇒ PUBLIC default
       OR has_function_privilege('anon',          p.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
ORDER BY p.prosecdef DESC, p.proname;

-- RLS + grant reality for the flagged tables
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname='public'
  AND c.relname IN ('whatsapp_conversation_states','alert_activity_log',
                    'alert_suppressions','queue_runtime_events','analytics_refresh_logs');
```

`proacl IS NULL` is the signature of "never granted or revoked" — i.e. the
PUBLIC default is live. This query converts G-1 from a code-level certainty into
a measured fact, and gives you the exact remediation list. Run it before
deciding scope. If it returns near-empty, G-1 collapses and this phase shrinks
to items 4–10 — a real possibility I am obliged to leave open, since I could not
run it.

Then establish the baseline: `supabase db reset` (47 migrations + seed) →
`deno fmt --check` → `deno lint` → `deno task check` →
`deno task validate:migrations` → `deno task test` →
`deno task test:integration`. Expect fmt and check to fail, and integration to
report 128 tests with at least the audit-search test failing. Record the real
numbers before changing anything.

### Files this phase should touch

**New:**

- `supabase/migrations/48_privilege_hardening.sql` — the REVOKE sweep, RLS for
  G-4/G-7, the `queue_events_read` policy replacement, and a renamed Phase 1.5
  alert index (leave `idx_alert_events_open` alone; add
  `idx_alert_events_hospital_open`)
- `PHASE_1.4.5_COMPLETION_REPORT.md`
- `SECURITY.md` — the privilege model, so this cannot regress silently

**Modified:**

- `scripts/validate_migrations.ts` — add a rule: any
  `CREATE OR REPLACE FUNCTION` without a matching `REVOKE … FROM PUBLIC` is an
  error. This is the single highest-leverage change in the whole phase; it makes
  G-1 structurally impossible to reintroduce, which is exactly how migration 47
  regressed after migrations 27–46 had solved it by convention alone.
- `supabase/functions/process-whatsapp-webhook/index.ts` — fail-closed HMAC
- `supabase/functions/_shared/env.ts` — promote `META_APP_SECRET` to required
- `tests/integration/enterprise_command_center.test.ts` — `"info"` → `"low"`,
  plus `deno fmt`
- `supabase/config.toml` —
  `[functions.process-whatsapp-webhook] verify_jwt = false`
- `supabase/functions/_shared/database.generated.ts` — regenerate

**New tests** (`tests/integration/privilege_isolation.test.ts`): assert `anon`
and `authenticated` clients are denied on the full remediated RPC list; assert
cross-tenant reads of `whatsapp_conversation_states` and `queue_runtime_events`
return zero rows; assert an unsigned webhook POST returns 403.

### What NOT to change

- ❌ Do not touch the frozen engines. Booking state machine, queue runtime,
  payment/settlement engines, job queue, audit, analytics, SLA. This phase
  changes _who may call them_, never _what they do_.
- ❌ Do not alter any existing function body or signature. REVOKE/GRANT/POLICY
  statements only.
- ❌ Do not DROP the migration-24 `idx_alert_events_open`. Add a new name.
  Dropping it would silently deoptimize migration 24's severity-first alert
  queries.
- ❌ Do not edit migrations 01–47 in place. Additive migration 48 only — the
  project's stated invariant, and the reason all 47 replay cleanly today.
- ❌ Do not touch `audit_logs` or `financial_ledger` immutability triggers.
- ❌ Do not start the frontend.
- ❌ Do not "fix" G-8 (multi-role lockout) unilaterally. It needs a product
  decision: are dual-role users (a doctor who also works reception — common in
  small Indian clinics) supported or forbidden? The schema currently permits
  them and the code locks them out. This is the one question in this report I'd
  want answered before touching the code, because the two fixes are opposites:
  add a `(user_id, hospital_id)` unique constraint, or select the highest role
  via `ROLE_HIERARCHY`.

### What happens immediately after

`supabase db reset` (48 migrations) → all 7 gates green → 128/128 integration
(105 prior + 23 enterprise) → write `PHASE_1.4.5_COMPLETION_REPORT.md`. Then
Phase 1.5 certification becomes a formality: its code is already written and its
tests already exist; only the fmt/typecheck/index defects were blocking, and
1.4.5 clears all three. Realistically 1.4.5 and 1.5 certification land together.

---

## M. Proposed Continuation Plan

**Phase 1.4.5 — Privilege & Isolation Hardening** (above) · 1–2 days · Gates:
all 7 + new privilege-isolation suite. Complete when anon/authenticated can
execute no `SECURITY DEFINER` RPC and the validator enforces it.

**Phase 1.5 — Enterprise Command Center certification** · 0.5 day · Prereq:
1.4.5. No new implementation — regenerate types, verify all 23 enterprise tests
pass against a fresh reset, confirm the renamed alert index is used (`EXPLAIN`
on `get_alert_center`), write the missing completion report. Complete at 128/128
with 4 warnings triaged to 3.

**Phase 1.6 — Documentation Reconciliation** · 1 day · No code. Rewrite
ROADMAP.md against reality with a phase-label errata table; document migrations
38–39; supersede AUDIT_REPORT.md and CROSS_CHECK_REPORT.md; write the absent
`PHASE_0_COMPLETION_REPORT.md`; add `queue-control` to API_CONTRACTS.md. Gate:
fmt/lint only. Do this before the frontend — the frontend will be built by
someone reading these documents, and they are currently wrong about which
endpoints exist.

**Phase 2 — Integration Hardening completion** · 2–3 days · Prereq: 1.5.
Reconcile roadmap Phase 2 against what migration 41 and migration 47 §12
verifiers already delivered (`verify_audit_integrity`,
`verify_settlement_integrity`, `verify_queue_integrity`,
`verify_doctor_operations_integrity`, `verify_integration_matrix` all exist).
Audit before building — much of Phase 2 may already be done. Resolve the
medium-priority items (12–20 in §I), including the G-8 product decision and
dual-layer isolation on alert RPCs.

**Phase 4A — Operational Frontend** · largest remaining scope · Prereq: 1.6
(accurate API contracts), 2. Reception queue board, doctor consultation console,
patient display. Every number comes from existing RPCs — `get_queue_snapshot`,
`get_doctor_dashboard`, `doctor-operations`, `queue-control`. No new backend
work should be needed; if it appears to be, that is a signal the API contracts
are wrong, not that the backend is incomplete. Needs a framework decision (not
in scope for me to invent) and a new test tier — the repo has zero frontend test
infrastructure, so CI needs a third job.

**Phase 4B — Management Frontend** · Prereq: 4A. Hospital admin + global admin
consoles over `command-center`, `executive-analytics`,
`financial-command-center`, `alert-center`, `enterprise-reports`. This is where
Phase 1.5's 31 RPCs finally get a consumer — today they have none, which is
precisely why their privilege defect went unnoticed.

**Phases 5 → 6 → 6.5 → 7 → 8** — as ROADMAP.md specifies. I am deliberately not
restating or embellishing these; the roadmap's Phase 6.5 hard gate (7 items) is
well-specified and should be honored as written. I'd add one item to it: a
privilege-model review, since the absence of one is what produced the critical
findings in this report.

---

## §18 — Verdict on the previous model's hypotheses

| Hypothesis                                                  | Verdict                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-tenant hospital queue SaaS                            | ✅ Confirmed                                                                                                                                                                                                                                                                              |
| Supabase/PostgreSQL core runtime                            | ✅ Confirmed (PG 17, not the 15 in ARCHITECTURE.md)                                                                                                                                                                                                                                       |
| Phase 1.4 = doctor clinical operations                      | ✅ Confirmed — but only per the completion reports. ROADMAP's Phase 1.4 is "Subscription Platform." The hypothesis is right about the code and wrong about the roadmap, and did not flag the collision.                                                                                   |
| Migration 47 "may be" enterprise command center / Phase 1.5 | ✅ Confirmed, and the hedge was unnecessary — the file's own header says "Phase 1.5 – Hospital Command Center & Executive Operations."                                                                                                                                                    |
| "Several Edge Functions may already exist"                  | ✅ Confirmed but badly underspecified — exactly 5 new endpoints plus 3 shared modules and a 1,608-line test suite. "Several" understates a fully-built layer.                                                                                                                             |
| No Phase 1.5 completion report                              | ✅ Confirmed. It also missed that `PHASE_0_COMPLETION_REPORT.md` is absent.                                                                                                                                                                                                               |
| Frontend may not exist                                      | ✅ Confirmed with certainty — full directory listing shows no UI artifact of any kind.                                                                                                                                                                                                    |
| Phase 1.5 certification is the immediate next task          | ❌ Wrong, and this is the consequential error. Certification is blocked by two failing gates and by a critical privilege defect that migration 47 itself reintroduces. Certifying next would stamp "certified" on 31 anon-callable RPCs. The correct next step is remediation first (§L). |

### What the previous analysis missed entirely

- Migrations 38 and 39 — undocumented, load-bearing (38 fixes two RPCs that were
  called-but-never-defined).
- Both currently failing gates — `deno fmt --check` and `deno task check`.
- The 4th validator warning, and that it contains a real defect: the Phase 1.5
  alert index is silently never created.
- G-1 through G-9 — the entire security picture, including two critical
  financial-integrity findings.
- The phase-numbering collision, which makes "Phase 1.4" ambiguous across the
  project's own documents.

No files were modified. No migrations were run. No commands were executed
against any external system. The two failing gates and the `p_severity: "info"`
bug are reported, not repaired, per your §15.

Two things I could not verify and am not claiming: the runtime privilege ACLs
(Docker down — the query in §L settles it in seconds), and whether the
unit/integration suites pass today. Everything else in this report is backed by
a command I ran or a file I read.

**The one question I'd like answered before any code changes:** are dual-role
users — someone who is both a doctor and a receptionist at the same hospital —
supported? The schema permits it; `resolveAuth` locks them out. The fix depends
entirely on your answer.
