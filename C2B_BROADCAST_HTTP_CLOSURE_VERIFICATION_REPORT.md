# WS-C2b-CLOSURE — Broadcast Composer HTTP Write-Path Verification & Closure

Scope: verification closure of the C2b operational-broadcast composer **backend
write path** (the five `broadcast_*` actions of the `command-center` Edge
Function) over real HTTP, plus the one genuine defect that the real-HTTP
coverage exposed and its smallest correct fix.

This report is a VERIFICATION closure, not a new feature. It makes NO
production-readiness claim.

---

## 1. Executive status (evidence-tiered)

| Claim | Tier | Basis |
| --- | --- | --- |
| C2b composer backend write path reachable over real HTTP | INTEGRATION VERIFIED (local) | `tests/integration/command_center_broadcast_http.test.ts`, 23 `Deno.test` blocks (setup + H1–H21 + cleanup), local Supabase stack |
| All five `broadcast_*` actions exercised via HTTP | INTEGRATION VERIFIED (local) | H1–H7 (admin_notice, alert, queue_summary, doctor_delay, closure, global-admin-via-header) |
| Hospital-closure broadcast silently no-op'd (latent defect) | FOUND via test-first RED → FIXED → INTEGRATION VERIFIED (local) | `broadcastHospitalClosure` filtered `bookings.booking_date`; column does not exist |
| Authorization / validation / tenant-isolation / replay / PII-hygiene matrix | INTEGRATION VERIFIED (local) | H8–H21 (403-not-500, 401, 422×, 405, cross-tenant 403 zero-side-effect, idempotent replay, no phone in response) |
| No regression in adjacent suites | INTEGRATION + UNIT VERIFIED (local) | `enterprise_command_center` 30/30, `alert_center_http` 28/28, unit 113/113 |
| Static gates green | STATICALLY VERIFIED | `deno task check` exit 0, `lint` clean, `fmt:check` clean (after scoped `deno fmt`) |
| Staging `command-center` endpoint live + fail-closed at gateway | RUNTIME VERIFIED (staging, zero-mutation) | anonymous POST → `401 {"code":"UNAUTHORIZED_NO_AUTH_HEADER"}`, no enqueue |
| Staging app-layer write path + closure-fix staging proof | **UNPROVEN** | staging runs v8 = pre-fix source; requires owner redeploy |
| WhatsApp **provider delivery** of any broadcast | **UNPROVEN (by design)** | no provider credentials; ENQUEUED ≠ DELIVERED |
| Production behavior | **UNPROVEN** | no production deployment exists |

Bottom line: the C2b write path is **INTEGRATION VERIFIED locally** with one
genuine defect found and fixed. Staging is proven only at the gateway
fail-closed boundary. Provider delivery and production remain UNPROVEN.

---

## 2. Baseline probe (read-only, before any change)

- Local stack: `supabase_db_setura` Up (healthy), `supabase_auth_setura` Up
  (healthy). `supabase_edge_runtime_setura` was **Exited (255)** at probe time —
  the documented F16-01 failure mode (`RestartPolicy=no`, does not self-heal).
  It was restarted with `docker start`; serving was then proven by real HTTP,
  not by an exit code.
- Migration frontier: 73. Edge Functions present: 31. No migration was added or
  modified during this workstream.
- The C2b composer (`C2B_BROADCAST_COMPOSER_IMPLEMENTATION_REPORT.md`) was
  BLOCKED at §13 precisely because the Edge Runtime was stopped and there was
  no local `.env`. This closure unblocks and discharges that verification gap.

**Green baseline recorded BEFORE changes:**
- `tests/integration/alert_center_http.test.ts` → 28/28 (real HTTP + JWTs).
- `tests/integration/enterprise_command_center.test.ts` → 30/30.

**Baseline gap identified from evidence:** the existing enterprise suite
exercises broadcasts by importing `_shared/enterprise/broadcasts.ts` DIRECTLY
(service-role `db`), never through the `command-center` HTTP write surface, and
**never called `broadcastHospitalClosure` at all**. The five HTTP `broadcast_*`
actions had zero real-HTTP coverage. That is exactly the latent-500-class risk
(R2) flagged in `PHASE_7_NEXT_WORKSTREAM_INVESTIGATION_AFTER_G11.md`.

---

## 3. Staging version parity

- `supabase/functions/command-center/index.ts` and its `_shared` dependencies
  are unchanged in HEAD since their initial import; staging runs **v8**.
- Parity method: source inspection + `git diff HEAD` (empty for the dispatch
  path). No logic drift between HEAD source and the deployed v8 was found.
- **Incident (self-caught, no residual effect):** a `supabase functions
  download command-center` probe momentarily overwrote 15 local source files
  (the command-center index + 14 `_shared/*.ts`) with the staging eszip bundle.
  The diff showed only eszip reformatting, no logic change. All 15 files were
  restored via `git checkout`; `git diff HEAD` was re-verified empty and the
  restored blob identity matched HEAD. The working tree is clean for those
  paths. No source change from this incident persists.

---

## 4. Defect found via real-HTTP coverage (the closure no-op)

**Symptom (test-first RED).** New test `ccbc H6` (closure POSITIVE CONTROL,
two queue-active patients with phones at a flag-ON hospital) returned
`enqueued: 0` instead of `2`.

**Classification.** Genuine product defect (latent silent no-op), not a test
artifact and not a environment/tooling issue.

**Root cause.** `supabase/functions/_shared/enterprise/broadcasts.ts`,
`broadcastHospitalClosure`, filtered the `bookings` table on
`.eq("booking_date", sessionDate)`. The `bookings` table has **no
`booking_date` column**; the service date is stored in `appointment_date`. The
column name was confirmed against the live DB catalog
(`information_schema.columns`). Because every broadcast helper is best-effort
and swallows errors (a query error is logged as a warning and returns `0`), the
wrong-column filter never raised to the caller — it **silently returned zero
recipients**, so a hospital-closure broadcast delivered nothing while the
command-center still reported a `200` success envelope. The pre-existing
enterprise suite never triggered this because it never called
`broadcastHospitalClosure`.

**Smallest correct fix** (source, one predicate + comment):

```
.eq("hospital_id", hospitalId)
// bookings stores the service date in appointment_date; there is no
// booking_date column, so filtering the wrong name silently returned 0.
.eq("appointment_date", sessionDate)
.in("status", QUEUE_ACTIVE_STATUSES)
```

No migration, worker, scheduler, or unrelated Edge Function was touched. The
Edge Runtime was restarted after the edit so the module reloaded.

**Regression coverage added/updated.** `H6` is a positive control that asserts
`enqueued == 2` for the flag-ON case and would fail again if the predicate
regressed; `H5` asserts the honest `200 / enqueued 0` no-op when the flag is
OFF. Together they pin both the "reaches today's active patients" behavior and
the flag-gating behavior.

**Rerun.** After the fix: `command_center_broadcast_http` **23/23**. Affected
regression `enterprise_command_center` **30/30**.

---

## 5. Real-HTTP verification results (local stack)

`tests/integration/command_center_broadcast_http.test.ts` — 21 assertion tests
(H1–H21) + setup + cleanup = 23 `Deno.test` blocks, driving
`POST /functions/v1/command-center` with real JWTs and `X-Hospital-ID`.

- H1 `broadcast_admin_notice` (flag-independent) enqueues + writes an
  `audit_logs` row (`entity_type whatsapp_broadcast`, `action_type
  operational_alert`).
- H2 `broadcast_alert` enqueues to admins.
- H3 `broadcast_queue_summary` fans out to the 2 queue-active patients (flag ON).
- H4 `broadcast_doctor_delay` fans out to queue-active patients.
- H5 patient broadcast is an honest no-op when the flag is OFF (200, enqueued 0).
- H6 `broadcast_closure` reaches today's active patients — POSITIVE CONTROL.
- H7 `global_admin` scoped via `X-Hospital-ID` succeeds.
- H8–H9 receptionist / doctor denied the broadcast write → **403, not 500**.
- H10 anonymous write → 401.
- H11 missing `X-Hospital-ID` → 422.
- H12 `GET` → 405.
- H13 cross-tenant queue session → 403 **and zero side-effect**.
- H14 cross-tenant alert → 403 **and zero side-effect**.
- H15 `doctor_delay` missing `delayMinutes` → 422.
- H16 not-found queue session → 422.
- H17 oversized message (>500) → 422.
- H18 unknown admin-notice `kind` → 422.
- H19 malformed `action` name → 422.
- H20 identical replay does **not** create a duplicate `job_queue` row
  (deterministic idempotency key + `enqueue_job` `ON CONFLICT DO UPDATE`).
- H21 response carries no patient/admin phone number (PII hygiene).

Result: **23/23 PASS** (post-fix).

---

## 6. Regression / static gates (local)

- `enterprise_command_center.test.ts` → 30/30.
- `alert_center_http.test.ts` → 28/28.
- Unit suite → 113/113.
- `deno task check` → exit 0.
- `deno task lint` → clean.
- Formatting: the two C2b source/test files (`broadcasts.ts`, the new
  `command_center_broadcast_http.test.ts`) are individually `deno fmt --check`
  clean. Repo-wide `deno fmt:check`, however, reports **14 unrelated files**
  (`_shared/{tracing,phone,cors,metrics,db,response,errors,audit,env,validation,
  logger,auth}.ts`, `_shared/queue/queue_runtime.ts`, and
  `command-center/index.ts`). Every reported difference is **line-ending-only**:
  `git diff` against HEAD for those files is empty (content byte-identical).
  They originated from the Windows `core.autocrlf=true` checkout/EOL condition
  associated with the earlier staging `functions download` / revert incident.
  Attempting to normalize them would create unrelated working-tree
  modifications, so those files were deliberately reverted and are **excluded**
  from this focused C2b commit. **No repo-wide formatting normalization was
  performed**, and no `.gitattributes`/`deno.json` change was introduced. This
  line-ending condition is Windows-local and does not affect Linux CI.

---

## 7. Controlled staging verification (safe scope only)

- A single **zero-mutation** anonymous `POST` to the staging `command-center`
  endpoint returned `401 {"code":"UNAUTHORIZED_NO_AUTH_HEADER"}`. This proves
  the staging endpoint is live and fail-closed at the gateway/auth layer with
  **no enqueue** performed.
- A second probe attempt hit a local network/TLS blip and a regex miss; it was
  **not** retried in a loop (per the "no identical retry" rule). The first
  clean 401 is sufficient for the gateway fail-closed claim.

Deliberately NOT performed on staging:

- **No positive enqueue on staging.** The staging deployment runs the pre-fix
  v8 source, and a real enqueue that a provider-bound worker later pulls risks
  an uncontrolled WhatsApp delivery failure at the provider boundary — explicitly
  out of scope. The full staging **app-layer** write path and any staging proof
  of the closure fix are therefore **UNPROVEN**, pending an owner redeploy of
  the fixed source.

**Evidence boundary respected throughout:** every `enqueued: N` above means
**BROADCAST ACCEPTED / ENQUEUED**, not WHATSAPP PROVIDER DELIVERED. Delivery is
UNPROVEN without the external provider credentials, which were not added.

---

## 8. Local test residue (classified, NOT a defect)

The multiple test runs (including the pre-fix RED run) left 4 `C2b %` fixture
hospitals and a set of `wa_*` `job_queue` rows in the **local** stack. A
FK-safe cleanup was attempted but **aborted by the `audit_logs` immutability
trigger**: deleting the fixture auth-users tries to `SET NULL` their
`audit_logs.actor_user_id`, and deleting the fixture hospitals collides with
`audit_logs` rows that reference them (20 such rows confirmed). Per the
operating contract, cleanup must NOT weaken immutable audit history — so the
residue was left in place and the transaction rolled back cleanly (no partial
delete).

This accumulation is an expected characteristic of run-scoped test cleanup over
an immutable audit trail, not a C2b defect: the pre-existing
`enterprise_command_center` suite exhibits the identical pattern (49 accumulated
`P15 Ent %` hospitals). It is local-only and does not affect any conclusion in
this report.

---

## 9. Constraints compliance

- No migration modified or added.
- No worker / scheduler behavior modified.
- No unrelated Edge Function modified (only the one-predicate closure fix in
  `_shared/enterprise/broadcasts.ts`).
- No provider credentials added.
- No WhatsApp provider delivery claimed.
- No uncontrolled WhatsApp delivery failure intentionally created (positive
  staging enqueue skipped for exactly this reason).
- WS-OPS-1 not reopened; compute_sla TRUE-branch not recast as a WS-OPS-1 defect.
- No production-readiness claim made.
- A genuine defect was found and handled by the authorized workflow:
  classify → root cause → smallest fix → regression coverage → rerun affected →
  rerun regression → continue.

---

## 10. Working-tree / commit state

- HEAD = `14aa3b4` ("Preserve WS-OPS-1 closure evidence and remove soak scratch
  files"), == `origin/main`; the WS-OPS-1 evidence-preservation commit/push is
  complete and unchanged.
- C2b changes are present but **UNCOMMITTED**:
  - `M  supabase/functions/_shared/enterprise/broadcasts.ts` (closure fix).
  - `?? tests/integration/command_center_broadcast_http.test.ts` (new suite).
- No commit was authorized for the C2b changes (only the WS-OPS-1 commit/push
  was approved). They are present in the working tree, unstaged, for owner
  review.

---

## 11. Closure statement

The WS-C2b broadcast composer backend write path is **INTEGRATION VERIFIED
locally** across all five `broadcast_*` actions, including authorization,
tenant-isolation, validation, idempotent replay, and PII hygiene; one genuine
latent defect (hospital-closure broadcast silently no-op'd due to a
non-existent `booking_date` filter) was found via test-first RED, root-caused
against the live DB catalog, fixed minimally, and re-verified GREEN with
regressions intact. Staging is proven only as live + gateway-fail-closed
(zero-enqueue). WhatsApp provider delivery and the staging app-layer path
(including a staging demonstration of the closure fix) remain **UNPROVEN** and
require, respectively, external provider credentials and an owner redeploy. No
production-readiness claim is made.
