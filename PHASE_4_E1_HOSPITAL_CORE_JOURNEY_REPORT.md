# PHASE 4 — E1 HOSPITAL CORE JOURNEY REPORT

**Date:** 2026-09-19
**Scope:** Prove the complete journey PATIENT → REGISTRATION → APPOINTMENT/WALK-IN →
TOKEN → QUEUE → DOCTOR → CONSULTATION → BILLING → PAYMENT → NOTIFICATION → HISTORY
against the real local Supabase stack, per the Phase 4 E1 specification.
**Runtime evidence:** `deno test --allow-net --allow-env --allow-run tests/integration/hospital_core_journey.test.ts`
→ **18 passed | 0 failed** (run 4, `_e1_run4.log`). Full regression
`deno task test:integration` → **200 passed | 0 failed** in 42s (`_integration_full.log`).

---

## A. Executive result

The E1 hospital core journey is **integration-proven end-to-end on the local stack**
through real HTTP Edge Function entry points and real RPC chains — no mocks. The
suite (`tests/integration/hospital_core_journey.test.ts`, 18 tests, E1 00–E1 99)
registers patients, books appointments and walk-ins, mints tokens atomically under
8-way concurrency, checks in, calls patients manually and via `call_next`, runs the
full doctor consultation leg over HTTP (gate criterion #2 satisfied: the Edge
Function is the entry point), snapshots billing fees, captures payment through the
idempotent webhook path with correct ledger effects, enqueues exactly one
notification job per booking, and reads patient history under real RLS across two
tenants.

Building the suite exposed **four genuine runtime defects** that no prior phase had
caught, all fixed and regression-proven:

1. **P0 — the payment capture path was broken end-to-end.** Since migration 34,
   every `capture_payment` call from `idempotent_capture_payment` raised
   `42725 function ... is not unique` (overload ambiguity), and the exception
   handler itself then died on `42804` (uncast CASE → enum). Fixed by new
   migration **56**. The E1 suite is the first runtime to exercise this path.
2. **Cancel-booking always 500'd** — it wrote a phantom `cancelled_by` column that
   does not exist on `bookings`. Fixed in the Edge Function.
3. **Patient identity duplication** — `create-booking` deduped on the raw phone and
   stored no `normalized_phone`, so the same patient rebooked as a walk-in created
   a duplicate profile. Fixed in the Edge Function (canonical `formatE164()`).
4. **`get_remaining_token_capacity` drift** — counted only the first matching
   shift, not the day's total. Fixed by new migration **55** and proven live by
   E1 15 (two shifts = 50 capacity).

Roadmap Phase-4 items closed: the `create_booking` token-race closure is now
runtime-proven (E1 05: 8 concurrent RPC calls → distinct contiguous tokens,
counter delta exactly 8), and the capacity drift fix is applied and proven.

**Not claimed:** production readiness, real Razorpay verification, real Meta
delivery (see §G). Status vocabulary in this report: PROVEN = integration test
passed on the local stack; the local stack is not production.

---

## B. End-to-end flow (with actual evidence)

```text
Patient            → E1 01/E1 03: POST create-booking creates patient + profile
                     links; walk-in rebook reuses the SAME patient id (dedupe pin)
Appointment/Walk-in→ E1 01 (appointment, fee 20) / E1 03 (walk-in, fee 5)
                     / E1 11 (manual_whatsapp, platform 10 + receptionist 5)
Token              → E1 01: token counter == booking token_number;
                     E1 05: 8 concurrent create_booking RPCs → distinct gapless
                     tokens, exactly one duplicate-key retry returns the same booking
Queue              → E1 06 check-in → E1 08 queue-control action:"call" (token →
                     called, current_live_token set, repeat call idempotent)
                     → E1 10 call_next advances to lowest active token
Doctor             → E1 09: doctor-operations over HTTP — receptionist 403;
                     start_session → save_note (consultation_notes row with doctor
                     attribution) → complete; replays return already_started /
                     already_completed; consultation_completed_at set
Billing            → E1 01/E1 11: platform_fee_snapshot / hospital_fee_snapshot /
                     booking_fee_inr written at booking time (fee policy from E1 00)
Payment            → E1 12: payment_orders row → idempotent_capture_payment →
                     success/was_duplicate=false; order captured; booking
                     payment_completed + payment_reference; ledger rows
                     booking_fee_collected 20 credit + gateway_fee_debit 0.40 (2%);
                     replay was_duplicate=true with unchanged ledger count;
                     unknown order → success=false, zero ledger writes
Notification       → E1 13: exactly one wa_confirm_<bookingId> job per journey
                     booking; payload.phone is E.164 ("+" + raw digits).
                     REAL META DELIVERY = BLOCKED (§G)
History            → E1 14: authenticated patient reads via RLS — hospital A sees
                     only its own bookings; hospital B sees 0 bookings and null patient
Failure/cleanup    → E1 02 (422 validation, 422 cross-tenant body/header mismatch,
                     403 wrong-hospital receptionist, zero rows created);
                     E1 07 (cancelled token refused by call_queue_token as
                     token_not_callable); E1 16 (FK refusal mints no counter;
                     start_consultation on a 'booked' token refused ≥400,
                     state unchanged); E1 99 (tenant cleanup contract, see §H)
```

---

## C. Defects found and fixed

### C1. F4-01 (P0) — every payment capture died on overload ambiguity
- **Defect:** `idempotent_capture_payment` reported `Payment capture failed:
  function capture_payment(...) is not unique` for **every** order.
- **Root cause:** migration 34 added a `capture_payment` overload with
  `p_gateway_fee_inr NUMERIC DEFAULT NULL` alongside the original 4-arg
  signature; migration 16's unqualified 4-arg `PERFORM` became ambiguous
  (SQLSTATE 42725) at every call site.
- **Fix:** migration 56 resolves `public.capture_payment(...)` unambiguously
  with the explicit 5-arg call passing `NULL` for the fee, and captures the
  boolean result.
- **Migration/file:** `supabase/migrations/56_payment_capture_path_fix.sql`.
- **Regression test:** E1 12 (capture + replay + unknown order).
- **Runtime result:** pass; discovered via live psql reproduction of the 42725
  chain, not by inference.

### C2. F4-02 — the exception handler itself crashed (42804)
- **Defect:** when capture failed, `fail_webhook_event` raised
  `42804 … CASE types … cannot be matched` so the whole RPC aborted and the
  webhook event was left stuck in `processing`.
- **Root cause:** uncast `CASE … THEN 'failed' ELSE 'received' END` assigned to
  the `webhook_processing_status` enum column.
- **Fix:** explicit `'failed'::public.webhook_processing_status` /
  `'received'::public.webhook_processing_status` casts in migration 56.
- **Regression test:** E1 12 unknown-order branch + migration 56's self-verify
  probe (direct `fail_webhook_event` call writes the enum cleanly).
- **Runtime result:** pass.

### C3. F4-03 — `PERFORM` discarded `capture_payment`'s boolean (silent success)
- **Defect:** even absent C1, a non-capturable order would have been reported
  as `Payment captured successfully` because `PERFORM` drops the return value.
- **Root cause:** `PERFORM public.capture_payment(...)` instead of capturing
  `INTO v_captured`.
- **Fix:** migration 56: `SELECT … INTO v_captured;` with
  `IF v_captured IS NULL OR NOT v_captured THEN fail_webhook_event + RETURN
  (false, false, 'Payment capture failed: order not capturable')`.
- **Regression test:** E1 12 unknown-order → `success=false`, no dup, no ledger rows.
- **Runtime result:** pass.

### C4. Cancel-booking wrote a phantom `cancelled_by` column
- **Defect:** every real cancellation returned 500 `Cancel failed`
  (PostgREST error on a nonexistent column).
- **Root cause:** `supabase/functions/cancel-booking/index.ts` included
  `cancelled_by: auth.userId` in the `bookings` UPDATE; the column does not
  exist (catalog shows only `cancelled_at` + `cancellation_reason`, and the line
  was the sole reference to `cancelled_by` in the whole repo).
- **Fix:** removed the line; the acting user remains captured in the audit log
  via `logAuditEvent`.
- **Migration/file:** `supabase/functions/cancel-booking/index.ts` (Edge Runtime
  restarted to serve it; `Up` verified by `docker ps`, per F16-01 discipline).
- **Regression test:** E1 07 (cancel → replay 200 `alreadyCancelled` →
  `call_queue_token` refuses the cancelled token).
- **Runtime result:** pass.

### C5. Patient identity duplicated across appointment → walk-in
- **Defect:** rebooking an existing phone as a walk-in created a second patient.
- **Root cause:** `create-booking` matched/deduped on the raw client phone and
  never stored `normalized_phone`, so the canonical-identity path was dead.
- **Fix:** use the shared `formatE164()` primitive; lookup and insert both use
  `normalized_phone` (`_in("normalized_phone", [normalizedPhone, raw])`), and
  notification payloads carry the normalized E.164 value.
- **Migration/file:** `supabase/functions/create-booking/index.ts`.
- **Regression tests:** E1 03 (walk-in reuses canonical patient), E1 13
  (payload phone starts "+" and ends with raw digits).
- **Runtime result:** pass.

### C6. `get_remaining_token_capacity` counted one shift, not the day
- **Defect:** extended-hours drift — a doctor with two same-weekday active shifts
  (30 + 20) reported capacity from the first shift only.
- **Root cause:** old implementation selected a single schedule row.
- **Fix:** migration 55 — `SUM(max_tokens)` over active `doctor_schedules` for
  the weekday minus bookings with
  `status NOT IN ('cancelled','no_show') AND is_deleted=false`.
- **Regression test:** E1 15 asserts `50 − bookedCount` dynamically; also
  re-verified the live `prosrc` in the catalog.
- **Runtime result:** pass (proved on a two-shift fixture, which the old code
  would have failed).

**Documentation finding (no code change):**
`tests/integration/enterprise_command_center.test.ts` ~L1588 claims deleting a
hospital cascades its ledger. Runtime disproves this: `financial_ledger` and
`config_versions` immutability triggers fire on CASCADE deletes (see §H).
Recorded, not rewritten — no test weakening.

---

## D. Files changed

| Path | Change |
| --- | --- |
| `tests/integration/hospital_core_journey.test.ts` | NEW — 18-test E1 suite (~1320 lines) |
| `supabase/migrations/55_token_capacity_daily_sum.sql` | NEW — capacity daily-sum rewrite (C6) |
| `supabase/migrations/56_payment_capture_path_fix.sql` | NEW — F4-01/02/03 fixes (C1–C3) |
| `supabase/functions/cancel-booking/index.ts` | MODIFIED — removed phantom `cancelled_by` write (C4) |
| `supabase/functions/create-booking/index.ts` | MODIFIED — E.164 patient dedupe (C5, prior session) |

No applied migration was edited. Both DB fixes are new additive migrations.

---

## E. Database changes

- **Migration 55 — `55_token_capacity_daily_sum.sql`:** `CREATE OR REPLACE`
  of `public.get_remaining_token_capacity(p_doctor_id UUID, p_hospital_id UUID,
  p_date DATE)` to daily `SUM(max_tokens)` over active shifts minus live
  bookings. F16-04 honored: explicit `REVOKE ALL ... FROM PUBLIC, anon,
  authenticated; GRANT EXECUTE ... TO service_role`, with
  `has_function_privilege()` catalog self-check inside the migration.
- **Migration 56 — `56_payment_capture_path_fix.sql`:** `CREATE OR REPLACE` of
  `public.fail_webhook_event` (enum casts) and
  `public.idempotent_capture_payment` (unqualified 5-arg capture call, boolean
  checked). Same F16-04 REVOKE/GRANT + catalog self-verification. In-migration
  runtime probes: unknown-order capture returns `success=false` with no dup and
  zero ledger writes; replay returns `was_duplicate=true`; direct
  `fail_webhook_event` enum write succeeds; probe rows cleaned up.
  NOTICE `migration 56 verification passed` observed on application.
- **Application method:** `supabase db push` remains blocked by a pre-existing
  shadow-branch/introspection error (Phase 1.6 record), so both migrations were
  applied via `docker exec … psql -f` and registered manually: rows in
  `public.migration_registry` (real columns `description`/`category='function'`)
  and parity rows in `supabase_migrations.schema_migrations` (verified by
  `SELECT` after each insert).
- No tables, constraints or RLS policies were added or altered.

---

## F. Tests — exact commands and results

All commands run from repository root on the live local stack
(`supabase status` healthy; Edge Runtime container confirmed `Up`).

| Command | Result |
| --- | --- |
| `docker exec supabase_db_setura psql -U postgres -d postgres -f /outside/migrations/55_…sql` / `…56_…sql` | applied; 56 emitted `NOTICE: migration 56 verification passed` + COMMIT |
| `deno test --allow-net --allow-env --allow-run tests/integration/hospital_core_journey.test.ts` (run 4) | **18 passed \| 0 failed** (`_e1_run4.log`) |
| `deno task test:integration` (full suite) | **200 passed \| 0 failed** in 42s (`_integration_full.log`) |
| `deno task test` (unit) | **81 passed \| 0 failed** |
| `deno task validate:migrations` | **0 errors**, 4 pre-existing `[duplicate-objects]` warnings (known baseline, not new) |
| `deno check tests/integration/hospital_core_journey.test.ts supabase/functions/**/index.ts` | **exit 0** |
| `deno task lint` | 2 hits, both in `.ua\tmp\*.js` scratch files (non-source); repo source clean |
| `deno fmt` on the 5 touched files, then scoped `--check` | touched files clean; 1 pre-existing unformatted non-touched file (`tests/integration/scheduler_autonomy.test.ts`) recorded, not changed |
| `deno task gen:types:check` | up to date |

Test iterations that prove the fixes rather than route around them: run 1
(1/18) surfaced the auto-provisioning-trigger collision (fixture switched to
UPDATE-after-provisioning); run 2 (3/18) surfaced phone-length, gender-enum and
config-versioning cleanup traps; run 3 (14/18) surfaced the four real defects
C1–C4's runtime chain and the 422-vs-400 edge mapping; run 4 green. No
assertion was weakened to reach green; E1 99 was rewritten from "delete both
tenants" to the honest two-part permanence contract after runtime disproved the
cascade-deletion assumption (§H).

---

## G. External blockers (separate, per spec)

```text
META       REAL META DELIVERY = BLOCKED. Code/payload path is TESTABLE and
           PROVEN (E1 13: one job per booking, E.164 payload, canonical
           idempotency keys). No local META_APP_SECRET; no real webhook or
           outbound delivery was performed or is claimed.
RAZORPAY   REAL RAZORPAY = BLOCKED. INTERNAL PAYMENT FLOW is TESTABLE and
           PROVEN end-to-end (E1 12: order → idempotent capture → ledger →
           replay dedupe → unknown-order refusal). Signature verification was
           exercised only against locally fabricated values.
EDGE RUNTIME  Local Docker Edge Runtime served all HTTP tests; functions are
              mounted from ./supabase/functions. Known fragility F16-01
              (RestartPolicy=no) handled by explicit restart + `docker ps`
              verification before the green run. Production Edge Runtime
              behavior is UNPROVEN.
PRODUCTION PRODUCTION = BLOCKED / NOT APPLICABLE. Everything in this report
              is local-stack integration evidence. No deployment exists; no
              production claim is made. (Also: working tree is not a Git
              repository, so CI reachability remains unmeasurable.)
```

---

## H. Open NPD decisions (left open, not silently closed)

1. **Tenant decommission has no purge path.** A hospital with captured payments
   or a versioned config row is permanently undeletable: the
   `financial_ledger` and `config_versions` immutability triggers fire on
   CASCADE deletes, and no migration offers an authorized archive/purge RPC.
   E1 99 now *proves* this contract (B deletes fully; A deletion is refused
   with an immutability error and its ledger rows stay queryable). Whether a
   compliant decommission workflow is required is a product decision — **OPEN**.
2. **Scheduler absence (P0-02)** — unchanged by Phase 4; still a design
   decision (NPD-05), not re-litigated here.
3. **`ENABLE_WORKER_TRIGGER=false` default (P0-03)** — notification jobs enqueue
   correctly (E1 13) but autonomous processing remains documented-off; a product
   deployment decision, **OPEN**.
4. **Fee-policy business defaults** (E1 00 configures online 20 / whatsapp 10 /
   walk-in 5 / receptionist 5 explicitly) — the suite proves the snapshots
   follow configuration; it does not certify the default values themselves as
   business policy.

Environment side effect (not a decision): the failing early runs left ~4
undeletable `e1-journey-%` fixture hospitals in the **local** database
(config_versions/ledger residue). They are inert, invisible to RLS-scoped
reads, and removed by any future `db:reset`.

---

## I. E1 acceptance criteria

| E1 Criterion             | Status | Evidence |
| ------------------------ | ------ | -------- |
| Patient registration     | PROVEN | E1 01, E1 03 (HTTP create-booking; canonical patient dedupe via normalized_phone) |
| Appointment              | PROVEN | E1 01 (booked row, fee snapshot 20, session + token linked) |
| Walk-in                  | PROVEN | E1 03, E1 06 (walk-in fee 5; check-in to `checked_in`) |
| Token generation         | PROVEN | E1 01, E1 05 (counter==token; 8-way concurrent distinct gapless tokens) |
| Queue placement          | PROVEN | E1 08 (queue-control call → `called`, `current_live_token` set) |
| Doctor queue             | PROVEN | E1 10 (`call_next` advances to lowest active token) |
| Call patient             | PROVEN | E1 08 (duplicate call idempotent), E1 07 (cancelled token refused) |
| Consultation             | PROVEN | E1 09 (start→note→complete over HTTP; non-doctor 403; replays) |
| Consultation completion  | PROVEN | E1 09 (`consultation_completed_at` set; `already_completed` replay) |
| Billing state            | PROVEN | E1 01/11 + E1 12 (fee snapshots at booking; booking → `payment_completed` with reference) |
| Payment state            | PROVEN | E1 12 internal flow (captured order, ledger 20 credit + 0.40 gateway fee, replay dedupe). REAL RAZORPAY BLOCKED (§G) |
| Notification path        | PROVEN | E1 13 code/payload path (exactly one wa_confirm job per booking, E.164 payload). REAL META DELIVERY BLOCKED (§G) |
| Patient history          | PROVEN | E1 14 (authenticated RLS reads; cross-tenant sees nothing) |
| Cross-module consistency | PROVEN | E1 07 (cancelled booking ⇒ token not callable, no payment rows), E1 16 (refusals leave state unchanged) |
| Idempotency              | PROVEN | E1 04 (replay key ⇒ same booking/token, 1 job), E1 08/09/12 replays |
| Concurrency              | PROVEN | E1 05 (8 simultaneous create_booking RPCs) + duplicate-key retry returns same booking |
| Tenant isolation         | PROVEN | E1 02 (403 + 422 mismatch, zero rows), E1 14 (RLS), E1 99 (per-tenant data) |
| Failure handling         | PROVEN | E1 12 unknown order ⇒ success=false + zero ledger writes; E1 16 FK refusal mints no counter; E1 02 invalid inputs create nothing |

No criterion is BLOCKED at the internal-journey level; the two external-service
dependencies are recorded separately in §G per the spec's
TESTABLE/BLOCKED split and never converted into PASS equivalents.

---

## J. Final status

```text
PHASE 4 COMPLETE — WITH BLOCKED EXTERNAL/ENVIRONMENT EVIDENCE
```

No production-readiness claim is made. Phase 5 is not started.
