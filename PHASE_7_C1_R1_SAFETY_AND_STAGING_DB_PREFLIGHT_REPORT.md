# SETURA — PHASE 7 C1 R1 SAFETY AND STAGING DB PREFLIGHT REPORT

**Task:** Staging DB read access + safe booking identification + Meta/WhatsApp
boundary verification — strictly read-only.
**Execution date:** 2026-09-27 (UTC).
**Successor to:** `PHASE_7_C1_COMMIT_STAGING_PREFLIGHT_REPORT.md` (R1 = NO, blockers I and J).
**Decision:** `R1 SAFE TO PROCEED = YES` (conditional — see §16 and §21).
**Re-verification pass:** later on 2026-09-27, all §16 point-in-time conditions
re-checked against live staging — every value identical (§22). YES reconfirmed.

---

## 1. Executive Summary

Both previous R1 blockers were resolved with authoritative staging evidence.

- **Blocker I (no authoritative staging DB read access): RESOLVED.** A
  project-bound, read-only-by-procedure access path exists — the Supabase CLI
  `db query --linked` management endpoint (`postgres` login role initialised
  server-side by the CLI; no local credentials, no credential exposure). DB
  identity is proven to be `setura-staging` / `gzcqasntcbqqmgsoikms` (bound by
  the CLI `--linked` flag to the single linked project reference) and the
  database content is proven SETURA (migration registry at 63/63, SETURA
  fixture tenant rows).
- **Blocker J (per-tenant Meta/WhatsApp credential cannot be ruled out):
  RESOLVED.** Every credential surface was inspected: Edge Function project
  secrets contain **no `META_*` secret**; `hospital_settings` carries only
  `meta_phone_number_id` / `meta_waba_id` (both empty for the only tenant row);
  Supabase Vault contains exactly **2 secrets, neither Meta/WhatsApp**
  (`setura_cron_secret`, `setura_scheduler_api_key`). Source analysis proves
  the `access_token` in `send-whatsapp-message` is resolved **only** from
  `Env.META_ACCESS_TOKEN` — there is no database/Vault token path at all, so no
  tenant-level token can exist by construction. Runtime corroboration: all 65
  `send_whatsapp_message` jobs are `dead` with the identical error
  `WhatsApp send failed (401): UNAUTHORIZED_NO_AUTH_HEADER`, and
  `public.whatsapp_messages` has **0 rows** — WhatsApp has never delivered on
  this staging project.

A designated safe test booking was identified and its pre-state captured
(§8–§10). **No cancellation, no mutation, no deployment, no production access
occurred in this task.**

## 2. Scope / Absolute Safety Rules

The task was executed under the absolute read-only contract: SELECT-only SQL,
information_schema/pg_catalog inspection, no mutation RPCs, no
`SELECT ... FOR UPDATE`, no enqueue, no worker wake, no secret printing, no
deployment, no commit/push. **All executed statements were `SELECT`.** Every
observed staging change in this report was produced by pre-existing staging
automation, never by this task. Secret values were never read or printed — the
CLI exposes secret values as SHA-256 digests by design, and this report records
only names, existence and locations.

## 3. Environment Identity

| Surface | Value | Status |
| --- | --- | --- |
| Linked Supabase project | `setura-staging` / `gzcqasntcbqqmgsoikms` / ap-south-1 (Mumbai) | PROVEN (CLI `projects list` LINKED marker; `supabase/.temp/project-ref`) |
| Second project visible | `PrepOS` (`ldmbqhqdgblhdiruzvfi`) — NOT linked, NOT queried | NOT OBSERVED (untouched) |
| Vercel project | `setura` (`prj_PZq3TlY28vzz3hF6x0TKpvxK6gMH`, existing) | PROVEN (no new project created; no Vercel mutation performed) |
| Production | not addressed by any command in this task | NOT TOUCHED |

Identity is unambiguous: exactly one project carries the LINKED flag, and all
DB queries were issued through `--linked`, which the CLI binds to that
reference's management endpoint.

## 4. Git Baseline

- Branch: `main`
- HEAD: `a9aa774f4620b45541ccc18dce4f31d92e82d2b1`
- `origin/main`: `a9aa774f4620b45541ccc18dce4f31d92e82d2b1` (HEAD == origin/main)
- Last commit: `a9aa774 feat: add booking cancellation control surface`
- PROVEN — matches the baseline declared in the C1 preflight.

## 5. Staging DB Access Result

**PROVEN STAGING.** Path: `supabase db query --linked` (CLI option 2 —
project-linked CLI tooling; the CLI initialises a server-side login role; the
management API executes the statement inside the project). No password, URL or
key appears in this report; none was printed at any point. The access path is
technically capable of mutation via the `postgres` role, so **read-only is
enforced procedurally** (only SELECT statements were submitted) — this is
recorded honestly rather than overstated as a cryptographically read-only
credential.

## 6. DB Identity Proof

| Check | Result |
| --- | --- |
| `current_database()` / `current_user` | `postgres` / `postgres` |
| Server version | PostgreSQL 17.6 on x86_64-pc-linux-gnu |
| Binding to project ref | every query routed via `--linked` → `gzcqasntcbqqmgsoikms` (LINKED marker verified in §3) |
| SETURA content proof | `supabase_migrations.schema_migrations` count = **63**, high-water `63 consultation_notes_staff_read` — exact match to repository `supabase/migrations/` |
| Tenant content proof | `public.hospitals` = the 5 seeded canonical-UUID fixture tenants (`00000000-0000-4000-8000-00000000000N`, `admin@surya.test`) created `2026-01-01` (seed fixture date) |

## 7. Candidate Booking Census

Statuses of non-deleted bookings: `booked` 7 · `completed` 5 · `skipped` 2.
Canonical `booking_status` enum observed (10 labels). All 7 `booked` bookings
belong to the seeded test tenant Surya Hospital
(`00000000-0000-4000-8000-000000000001`), all ₹0.00, all
`payment_completed=false`, `paid_online=false`, no payment reference.

| Token | Patient | Phone (tail) | Source | Provenance classification |
| --- | --- | --- | --- | --- |
| 6 | Conf Validation Patient | …00123 | manual_free | controlled staging validation fixture (see §10) |
| 7 | Conf Validation Patient 2 | …00124 | manual_free | controlled staging validation fixture |
| 5 | E2E NoDoc 8550519 | 9808550519 | walkin | automated e2e run — **excluded** (timestamp-derived digits, see §10) |
| 1–4 | Verify Patient | random-looking | walkin | UI verification runs — weaker provenance, not designated |

## 8. Designated Safe Booking Decision

**Designated candidate:** booking `61ac8f21-2d49-466d-b4bf-fb0cd9ac76bf`
(reference `B50FF413F63B51DF`, token 6, patient
`ac93b2e3-223b-4682-a244-9fded0827aec`).

The alternative `eb701e56…` (Conf Validation Patient 2) is an equally safe
reserve. The `E2E NoDoc` booking was **explicitly excluded**: its phone is
generated by `apps/web/e2e/core_journey.mjs` as
`` `980${stamp}`.slice(0,10) `` — timestamp-derived digits that *could* coincide
with a real Indian mobile number, so non-reality of that destination cannot be
established from the name alone.

## 9. Authoritative Pre-State (captured 2026-09-27 ~05:4x UTC, read-only)

**Booking `61ac8f21`:** status `booked` · token_number 6 · queue_session_id
NULL · booking_source `manual_free` · reference `B50FF413F63B51DF` ·
booking_fee_inr `0.00` · consultation_fee_inr NULL · platform_fee_snapshot
`0.00` · payment_completed `false` · paid_online `false` · payment_reference
NULL · payment_status_detail NULL · cancellation_reason NULL · cancelled_at
NULL · whatsapp_confirmation_sent `false` · whatsapp_reminder_sent `false` ·
idempotency_key `b94cacf0-a280-448b-9242-0d76cd384fe7` · metadata `{}` ·
assigned_doctor `…00a3` · booked_by `…00a4` (seeded receptionist) · created
`2026-09-22 17:27:41 UTC` · updated `2026-09-27 03:00:12 UTC`.

**Patient `ac93b2e3`:** `Conf Validation Patient` · normalized_phone
`+919876500123` · age 45 · gender F · village `ConfVillage` · total_visits 1 ·
created `2026-09-22 17:27:41 UTC` (same transaction window as the booking).
No further PII exists or is exposed — every attribute is synthetic.

**Queue:** no queue session attached (NULLed by nightly carry-forward, §21).

**Notifications:** `notification_queue` 0 rows for this booking or this
recipient; `whatsapp_messages` 0 rows system-wide; **2 pre-existing
`send_whatsapp_message` jobs already `dead`** (attempt_count 5/5):
`wa_confirm_61ac8f21…` and `reminder_61ac8f21…` — no cancellation job exists
(`booking_cancel%` idempotency keys: 0 rows). No dedupe key pre-exists for a
cancellation send.

**Audit:** exactly 1 audit row for this booking — `booking_create`, low
severity, actor `…00a4`, `2026-09-22 17:27:41 UTC`.

**Financial:** `payment_orders` 0 · `payment_refunds` 0 · `financial_ledger` 0
rows for this booking.

## 10. Patient / Test Identity Safety Evidence

- The booking + patient pair is **documented in the repository**:
  `PHASE_7_BOOKING_CONFIRMATION_ENHANCEMENT_REPORT.md` §validation-table lists
  `Conf Validation Patient / 9876500123 / B50FF413F63B51DF /
  61ac8f21-2d49-466d-b4bf-fb0cd9ac76bf` — created **by this project's own
  controlled staging validation on 2026-09-22** via the receptionist UI.
- The `987650012x` sequence is a deliberate deterministic test series (two
  sequential numbers assigned to two sequential synthetic identities), with
  synthetic name ("Conf Validation Patient") and synthetic village
  ("ConfVillage").
- The hospital is the repository-seeded fixture tenant (canonical UUID,
  `admin@surya.test` — RFC 2606 reserved domain).
- Classification: patient identity **PROVEN deliberately non-real** (repository
  documentation + fully synthetic attributes + seeded tenant). Phone: deliberately
  non-real by the same fixture evidence, and additionally structurally
  undeliverable on this project (§11–§14) — the "guaranteed not to reach a real
  person" condition is satisfied on both limbs of the criterion.

## 11. Meta / WhatsApp Credential Inventory

| Surface | Finding | Classification |
| --- | --- | --- |
| Edge Function project secrets (11 names: `ALLOWED_ORIGINS`, `CRON_SECRET`, `ENABLE_WORKER_TRIGGER`, `SUPABASE_*` platform keys, `WORKER_SECRET`) | **no `META_*` / WhatsApp token present**; no `RAZORPAY_KEY_SECRET` | ABSENT |
| Source (`send-whatsapp-message/index.ts` L413–460) | `accessToken = Env.META_ACCESS_TOKEN` **only**; DB can override `phoneNumberId` but **never the token**; missing either → `InternalError("Meta credentials not configured")` **before any Meta call** | boundary PROVEN |
| Runtime corroboration | all 65 `send_whatsapp_message` jobs `dead`: `WhatsApp send failed (401): UNAUTHORIZED_NO_AUTH_HEADER` (the function's own no-token failure mode) | PROVEN STAGING |
| `whatsapp_messages` table | 0 rows — no message ever queued or sent via the canonical path | NOT OBSERVED (zero deliveries) |

Only secret *names* and CLI-provided digests were seen; no secret value was
read or printed in this task.

## 12. Tenant-Level Credential Investigation

Exhaustive column census across `public` + `vault` for
`%token%|%secret%|%api_key%|%credential%|%waba%|%phone_number_id%` found exactly
one tenant integration surface: `hospital_settings.meta_phone_number_id` /
`meta_waba_id` / `whatsapp_number`. Single tenant row present (Surya test
tenant): `has_waba_id=false`, `has_phone_num_id=false` (both ABSENT),
`has_wa_number=true` (a display number, not a credential),
`razorpay_key_id` absent. Vault: **2 secrets total** —
`setura_cron_secret`, `setura_scheduler_api_key` — neither provider-deliverable.
No `credentials`/`secrets` columns exist anywhere else in `public`.
**Conclusion: no tenant-level deliverable Meta/WhatsApp credential exists — and
none could exist in a form the code reads, because the code has no DB token
path.** Blocker J: RESOLVED.

## 13. Notification Delivery Path (static, not invoked)

`cancel-booking` → if `patient_phone` present → `enqueue_job(send_whatsapp_message,
payload.phone = formatE164(b.patient_phone))` → worker claims → `send-whatsapp-message`
function → `Env.META_ACCESS_TOKEN` (absent) → throw → retry/backoff → `dead`.
Recipient for the designated booking is `+919876500123` (synthetic fixture, §10).
No live path was executed by this task.

## 14. Worker / Queue Safety

- Worker IS active on staging: the designated booking's 2 jobs were claimed by
  distinct worker IDs, reached 5/5 attempts, and are `dead` — a future
  cancellation job **will** be picked up and processed automatically.
- That processing provably terminates in the credential error above (identical
  outcome observed on all **71/71** job_queue rows system-wide; 0
  pending/processing/claimed live jobs; 0 jobs created since 2026-09-26).
- Therefore the worker/provider path cannot unexpectedly reach a real person for
  the designated booking.

## 15. Refund Safety (what WOULD happen — nothing was initiated)

Designated booking: `booking_fee_inr 0.00`, `payment_completed false`,
`paid_online false`, 0 payment orders, 0 ledger entries, 0 refunds, tenant
`payment_enabled=false`. Any refund computed against SETURA's collected amount
is ₹0 — under the unchanged D16 policy (SETURA refunds only its own collected
booking/platform fee; consultation fee is direct-to-hospital; backend controls
refund behavior; tenant `cancellation_policies` v1 row present:
full-refund ≤30 min, partial 50 %, same-day 0 %). `process-refund` was NOT
called; no financial record was created.

## 16. R1 Decision

| Condition | Verdict |
| --- | --- |
| staging DB identity proven | PROVEN (§3, §6) |
| authoritative read-only DB access proven | PROVEN STAGING — procedural read-only (§5) |
| designated booking exists | PROVEN (§8) |
| booking belongs to staging/test tenant | PROVEN — seeded fixture tenant (§6, §8) |
| patient identity deliberately non-real | PROVEN (§10) |
| phone/destination deliberately non-real or guaranteed sandbox | PROVEN — fixture series + structurally undeliverable (§10–§12) |
| provider credential boundary fully understood | PROVEN (§11–§12) |
| no tenant-level deliverable Meta credential can reach a real patient | PROVEN (§12) |
| notification recipient guaranteed safe | PROVEN (§10, §13) |
| worker/provider path cannot unexpectedly reach a real person | PROVEN (§11–§14) |
| candidate pre-state captured | PROVEN (§9) |
| no mutation performed | PROVEN (§2, §20) |

**R1 SAFE TO PROCEED = YES**

subject to the two standing conditions in §21. YES means the safety
prerequisites are proven; **the actual cancellation remains a separate,
explicitly authorized task and was NOT performed here.**

## 17. What Was NOT Performed

No booking cancelled · no booking created/modified · no patient/settings/
notification/queue row modified · no token call/skip/restore · no WhatsApp sent ·
no notification delivery triggered · no worker invoked · nothing enqueued ·
no cron called · no refund initiated · no RPC executed (any purpose) · Vault
untouched (metadata SELECT only) · no secret created/rotated/print · no code,
migration, SQL or config edited · nothing committed or pushed · no deploy ·
Vercel and Supabase settings unmodified · production never addressed.

## 18. Production Boundary

UNPROVEN / untouched, unchanged from the C1 preflight. No command in this task
targeted any endpoint other than the linked staging project ref.

## 19. D5 / D13 Status

- D5 (backup/DR): **DEFERRED BY OWNER** — unchanged, not weakened.
- D13 (production domain): **DEFERRED BY OWNER** — unchanged.

## 20. Git Working Tree

`git status --porcelain`: 10 untracked files, all pre-existing (7 phase reports
+ 3 staging screenshots from earlier tasks). Zero tracked-file changes. This
report adds one untracked file. All temporary scratch artifacts created by this
task (`.remember/tmp/q1.sql`, `pre_booking.json`, `pre_jobs.json`,
`secrets.json`) were deleted; their evidence is inlined above.

## 21. Remaining Prerequisites (for the future controlled-cancellation task)

1. **Re-capture pre-state immediately before cancelling.** The active nightly
   cron (`run-cron-nightly` → `carry_forward_pending_tokens`, proven firing at
   03:00:12 UTC today on all 7 booked rows) legitimately mutates
   `appointment_date` / `token_number` / `carry_forwarded_from` /
   `queue_session_id` daily. Status/cancellation fields are untouched by it and
   the booking remains cancellable, but a stale pre-state snapshot must not be
   used as the post-cancellation diff baseline.
2. **Re-verify the credential boundary at execution time** (R1 = YES is a
   point-in-time proof): `secrets list` must still show no `META_ACCESS_TOKEN`,
   `hospital_settings` must still have empty `meta_phone_number_id` /
   `meta_waba_id`, and `vault.secrets` must still contain no Meta credential.
   If a real Meta token is ever added to this staging project before the
   cancellation runs, the destination-safety argument must be re-derived, not
   inherited.
3. Explicit owner authorization for the cancellation itself (separate task).

## 22. Re-verification Pass (2026-09-27, second read-only check)

Re-executed after the local Docker/Edge-Runtime recovery (which touched only
the local stack, not staging). All SELECT-only, no mutation. Every checked
value is IDENTICAL to §9/§11–§14:

| Check | First pass | Re-verification |
| --- | --- | --- |
| Designated booking `61ac8f21…` | `booked`, token 6, ₹0.00, cancel fields NULL, `updated_at 2026-09-27 03:00:12 UTC` | UNCHANGED (byte-identical row) |
| Edge Function secrets | 11 names, 0 `META_*` | 11 names, 0 `META_*` |
| Vault | 2 secrets (`setura_cron_secret`, `setura_scheduler_api_key`) | 2 secrets |
| Tenant Meta IDs (`hospital_settings`) | empty | empty |
| Live (non-terminal) jobs | 0 | 0 |
| `whatsapp_messages` | 0 rows ever | 0 rows ever |
| Notification rows for booking | 0 | 0 |
| Git baseline | `main` @ `a9aa774` == origin/main | UNCHANGED; 0 tracked-file changes |

**R1 SAFE TO PROCEED = YES — reconfirmed.** §21 conditions 1–2 still apply to
the future cancellation task (the nightly cron has not re-fired since this
pass; it will at the next 03:00 UTC).

---

## Final Required Output

| Requirement | Result | Evidence |
| --- | --- | --- |
| Staging DB identity | PROVEN | `--linked` → `gzcqasntcbqqmgsoikms` (LINKED flag), 63/63 SETURA migrations, fixture tenants, PG 17.6, `postgres`@`postgres` |
| Read-only DB access | PROVEN STAGING | CLI management-endpoint query path; SELECT-only procedure; no credentials exposed |
| Safe test booking | PROVEN | `61ac8f21…` / ref `B50FF413F63B51DF`, status `booked`, ₹0 |
| Non-real patient proven | PROVEN | repo-documented controlled validation fixture; synthetic name/village; seeded tenant |
| Non-real phone proven | PROVEN | deterministic `987650012x` fixture series + structurally undeliverable on this project |
| Meta/WhatsApp boundary | PROVEN | no `META_*` secrets; token is Env-only in code (no DB path); Vault has 0 Meta secrets; tenant Meta IDs empty; 71/71 jobs dead on 401 |
| Notification path safety | PROVEN | static chain analysis + 0 `whatsapp_messages` ever; recipient is fixture phone |
| Refund safety | PROVEN | ₹0 collected, no payment order/refund/ledger; D16 unchanged; nothing initiated |
| R1 SAFE TO PROCEED | **YES** (conditional §21) | all twelve §16 conditions proven |
| Cancellation performed | NO | prohibited in this task; none executed |
| Production touched | NO | no production endpoint addressed |

"CANCELLATION PERFORMED: NO"

"STAGING MUTATION PERFORMED: NO"

"WHATSAPP SENT: NO"

"REFUND INITIATED: NO"

"PRODUCTION TOUCHED: NO"
