# WS-C2b-STAGING-VERIFICATION REPORT

Workstream: controlled staging verification of the already-committed C2b
broadcast write path (commit `fb55678`).

Scope actually executed in this workstream: deploy `command-center` only, then
non-mutating staging verification. **Option A only.** Option B (positive
closure mutation) and Option C (provider delivery) were NOT approved and were
NOT performed.

**Overall verdict: C2b - STAGING DEPLOYMENT / SAFE ROUTE VERIFICATION
COMPLETED; POSITIVE APP-LAYER ENQUEUE REMAINS UNPROVEN.**

---

## 0. Executive status table

| Item | Evidence tier |
| --- | --- |
| Local C2b write path (inherited from `fb55678`) | INTEGRATION VERIFIED (local) |
| Staging deploy of the C2b source | RUNTIME VERIFIED (staging) - PASS |
| Deployed-artifact source parity vs `fb55678` | VERIFIED (server-unbundled, SHA256) - PASS |
| Staging gateway / auth boundary | RUNTIME VERIFIED (staging) - PASS |
| Staging function-code validation + method enforcement | RUNTIME VERIFIED (staging) - PASS |
| Closure route authenticated positive dispatch (Option A) | **BLOCKED** (no staging actor credentials) |
| Closure-fix behavioral proof on staging (any variant) | **UNPROVEN** |
| POSITIVE STAGING CLOSURE ENQUEUE | **UNPROVEN** |
| Idempotency replay / cross-tenant denial at staging app layer | **UNPROVEN** (blocked on credentials) |
| Staging side-effect containment (zero jobs, zero audit) | RUNTIME VERIFIED - PASS |
| WHATSAPP PROVIDER DELIVERY | **UNPROVEN** (no credentials, not authorized) |
| PRODUCTION | **UNPROVEN** (no production deployment exists) |

---

## 1. Pre-deployment baseline (read-only)

| Check | Result |
| --- | --- |
| `git rev-parse HEAD` | `fb5567835699ec7aa3a2ac8e3e51e07f21b52d8b` |
| HEAD subject | `Verify C2b broadcast HTTP write path and fix closure targeting` |
| `git status --short` | empty (clean), re-verified after every staging action |
| Branch / remote | `main`, `origin` = `github.com/YeswanthArasavalli/Setura.git` |
| `origin/main` | `14aa3b473b31d9e0cd85f2613fd3766e600b1dfc` |
| Divergence | `main...origin/main` = 1 ahead / 0 behind; `git branch -r --contains fb55678` = empty |
| fb55678 push status | **NOT PUSHED, and it stayed not-pushed for this whole workstream** |
| Staging project | `setura-staging`, ref `gzcqasntcbqqmgsoikms` |
| Pre-deploy `command-center` | ACTIVE, VERSION 8, updated 2026-09-29 12:29:36 UTC = PRE-FIX |
| Migration frontier | local files = 73; staging `supabase_migrations.schema_migrations` = 73 rows, max version 73; staging `public.migration_registry` = 14 applied / 0 failed (curated registry, not the frontier table) |
| Unrelated local changes | none |

Staging data facts captured in the baseline (all read-only):

| Fact | Value | Why it matters |
| --- | --- | --- |
| `public.bookings` date column | `appointment_date` present; `booking_date` absent | confirms the defect premise at staging schema level |
| Secrets | `ALLOWED_ORIGINS, CRON_SECRET, ENABLE_WORKER_TRIGGER, SUPABASE_ANON_KEY, SUPABASE_DB_URL, SUPABASE_JWKS, SUPABASE_PUBLISHABLE_KEYS, SUPABASE_SECRET_KEYS, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL, WORKER_SECRET` - no `META_*`, no `RAZORPAY_*` | provider send cannot authenticate |
| `ENABLE_WORKER_TRIGGER` digest | `b5bea41b...` = SHA256 of the literal `true` | worker trigger is ENABLED on staging |
| `cron.job` | `1 setura_cron_minute active=true`, `2 setura_cron_nightly active=true` | scheduler is live; enqueued jobs are consumed autonomously |
| `job_queue` | completed=2, dead=78, pending=0 | worker does claim and does dead-letter |
| Vault secret names | `setura_cron_secret`, `setura_scheduler_api_key` | `resolve_integration_secret('meta_whatsapp')` resolves nothing |
| `is_feature_enabled(...0001,'whatsapp_queue_updates')` | `true` (no `feature_flags` row exists; flag is default-enabled) | the closure path is NOT gated off; it reaches the bookings query |
| Closure candidate set for `current_date` | tenant `...0001`: `closure_match=4 with_phone=4` | a positive closure mutation would enqueue 4 real jobs - the reason Option B was refused |

---

## 2. Deployed commit / source

- Deployed source = local HEAD `fb55678`, working tree clean at deploy time.
- Deploy command (single slug, staging ref explicit):

```text
supabase functions deploy command-center --project-ref gzcqasntcbqqmgsoikms
```

- Deploy log (`_c2b_staging_deploy.log`) records:

```text
Bundling Function: command-center
Deploying Function: command-center (script size: 211.7kB)
Deployed Functions on project gzcqasntcbqqmgsoikms: command-center
```

- The fix carried is exactly the one predicate line in
  `supabase/functions/_shared/enterprise/broadcasts.ts`
  (`booking_date` -> `appointment_date`) plus its explanatory comment. No
  other file in the deployed bundle was changed by this workstream.

### Deployment-scope proof

Full `supabase functions list` captured after the deploy: all 31 other ACTIVE
functions retain their exact pre-deploy versions and timestamps (e.g.
`financial-command-center` 8 @ 2026-10-01 07:48:00, `alert-center` 8 @
2026-10-01 15:50:52, `run-background-worker` 7 @ 2026-09-20 16:38:02,
`send-whatsapp-message` 7 @ 2026-09-20 16:38:02, `run-cron-minute` 8 @
2026-09-20 17:18:55). Only `command-center` changed. No migration, secret,
RLS, worker or scheduler change was made.

---

## 3. Deployed command-center version

| Field | Pre-deploy | Post-deploy |
| --- | --- | --- |
| slug | `command-center` | `command-center` |
| id | `3170aca1-707d-4022-a4a4-1ea348b5d5cc` | same |
| status | ACTIVE | ACTIVE |
| version | **8** | **9** |
| updated_at (UTC) | 2026-09-29 12:29:36 | 2026-10-05 16:06:06 |

---

## 4. Runtime proof (not CLI exit code)

The first two deploy attempts are recorded as evidence of a tooling trap, not
as deployment proof: inside the sandboxed shell, `supabase functions deploy`
returned **exit code 0 while writing zero output and leaving the version at
8**. A false-positive exit code. The deploy was repeated outside the sandbox,
produced real bundling output, and only then did the version move 8 -> 9.
Deployment success was therefore accepted from platform state plus HTTP
runtime probes, never from the CLI result alone.

Runtime probes against
`https://gzcqasntcbqqmgsoikms.functions.supabase.co/command-center` after the
deploy:

| Probe | Result | Origin of response |
| --- | --- | --- |
| `GET` no auth | `401` | platform gateway (`verify_jwt`) |
| `POST` no auth, `{}` | `401` `{"code":"UNAUTHORIZED_NO_AUTH_HEADER","message":"Missing authorization header"}` | deployed function code |
| `OPTIONS` preflight with `Origin: https://setura-delta.vercel.app` | `204` | deployed function code (CORS intact) |
| `GET` with a valid JWT (anon) | `405` `Method Not Allowed` | deployed function code (method enforcement) |
| `POST` valid JWT, no `X-Hospital-ID` | `422` `VALIDATION_ERROR` "Missing X-Hospital-ID header", `fieldErrors.header=["Required"]`, `correlationId=9e94f6e0-f799-411f-863a-2491e2f36c0d`, `2026-10-05T16:11:57.203Z` | deployed function code |
| `POST` anon JWT + `X-Hospital-ID: ...0001`, `action=broadcast_closure` | `401` `UNAUTHORIZED` "Invalid or expired token", `correlationId=2e7b16d6-b1bf-40a4-846a-75fece69f26b`, `2026-10-05T16:12:20.473Z` | deployed function code (`resolveAuth`) |

The 405, 422 and 401 bodies are structured responses that only exist inside the
function source, so they prove the newly deployed v9 code is what executed.

---

## 5. Gateway / auth proof

- Fail-closed at the gateway for anonymous calls (401 on GET and POST).
- The function's own auth layer rejects a non-user token before any
  hospital-membership check, role check, body handling or database access.
- Method enforcement (405) and hospital-context validation (422) are correct
  and were reached with zero mutations.
- `403 vs 500` for an unauthorized *role*: **UNPROVEN** at staging. It is
  locally proven in `fb55678`'s suite; at staging it requires a real
  receptionist JWT, which requires the staging actor password (section 10).

---

## 6. Deployed-artifact source parity (Phase 8)

Parity was established from the artifact that is actually running on staging,
not from the local tree.

`supabase functions download command-center --project-ref gzcqasntcbqqmgsoikms
--use-api` was run from an empty directory under `%TEMP%` (never inside the
repository), so the extracted files are the server-side unbundled contents of
the deployed function.

Downloaded closure predicate, from the deployed bundle:

```ts
L307: // bookings stores the service date in appointment_date; there is no
L308: // booking_date column, so filtering the wrong name silently returned 0.
L309: .eq("appointment_date", sessionDate)
```

There is no `.eq("booking_date", ...)` predicate anywhere in the deployed
bundle (the only remaining `booking_date` text is inside the explanatory
comment).

SHA256 parity, deployed bundle vs local HEAD `fb55678`:

| File | deployed (first 12) | local (first 12) | match |
| --- | --- | --- | --- |
| `_shared/enterprise/broadcasts.ts` | `34f15e7fd4c3` | `34f15e7fd4c3` | YES |
| `command-center/index.ts` | `2387ab1f14a1` | `2387ab1f14a1` | YES |
| `_shared/queue/queue_runtime.ts` | `b0c882e6ebcc` | `b0c882e6ebcc` | YES |
| `_shared/auth.ts` | `c0d2854cee7f` | `c0d2854cee7f` | YES |

Aggregate: 15 downloaded files compared against the local tree, **0
mismatches, 0 files absent locally**.

**Conclusion for Phase 8: staging is provably NOT running the pre-fix v8
source.** The deployed v9 artifact is byte-identical to `fb55678` and contains
the `appointment_date` predicate.

---

## 7. Closure route / data-selection status (Option A)

Option A as approved means: authenticated request -> `command-center` ->
authorization -> `broadcast_closure` -> fixed predicate -> correct data
selection -> zero recipients -> zero enqueue.

**This could not be executed. Status: BLOCKED, not PASS.**

Blocker: every step after "authenticated request" requires a real staging user
JWT for a `hospital_admin` actor.

- `POST /auth/v1/token?grant_type=password` as `admin@surya.test` with the
  repository seed password (`supabase/seed.sql`) returned
  `400 invalid_credentials`. This reproduces the already-recorded staging fact
  that the seed password is obsolete on live staging since owner provisioning;
  the current password is supplied out-of-band and is not committed anywhere.
- No password file was present at the recorded temp location.
- The failure was not retried with variations, and no credential was invented,
  bypassed, or brute-forced.

Therefore the closure route was only exercised up to the authorization
boundary (section 4: a `broadcast_closure` request is rejected at `resolveAuth`
with 401 before any enqueue).

**Methodological note - why the zero-enqueue variant is weak even once
credentials are available.** A zero-recipient date yields `HTTP 200 /
enqueued: 0` under BOTH the pre-fix and the post-fix code: pre-fix because the
query on the nonexistent column fails and the best-effort helper swallows the
error, post-fix because the correct query legitimately matched no rows. No
zero-side-effect probe can discriminate the fix. The only discriminating
staging test is a date that has matching queue-active bookings, i.e. Option B,
which is explicitly not authorized. The fix's differential evidence is therefore
LOCAL, and it is concrete: test `ccbc H6` (closure POSITIVE CONTROL) went
RED pre-fix expecting `enqueued: 2` and receiving `enqueued: 0`, root-caused to
`.eq("booking_date", ...)` against a column that does not exist, and passed at
`enqueued: 2` after the predicate change (`C2B_BROADCAST_HTTP_CLOSURE_VERIFICATION_REPORT.md`
sections 4-5). The staging evidence for this workstream therefore rests on the
deployed-artifact parity in section 6 plus that local differential proof, NOT on
any staging behavioral observation.

Correct evidence language for this workstream: *staging deployment and
deployed-source parity verified; authenticated closure route dispatch and any
staging behavioral demonstration of the closure fix remain UNPROVEN.*

---

## 8. Idempotency / tenant-isolation status

| Target | Staging status | Reason |
| --- | --- | --- |
| Same idempotency key does not duplicate work | UNPROVEN (local: PROVEN in `fb55678`) | needs an authenticated positive call |
| Cross-tenant request denied | UNPROVEN (local: PROVEN) | needs a second-tenant actor JWT |
| Denied request produces zero side effect | PARTIALLY PROVEN | proven for the anonymous and anon-token denials actually performed: zero jobs, zero audit rows (section 9); not proven for a role-denied or tenant-denied authenticated request |
| Role enforcement (403, not 500) | UNPROVEN at staging | needs a receptionist JWT |
| No patient/admin phone numbers in responses | PARTIALLY PROVEN | the four successful error bodies returned only code/message/fieldErrors/correlationId/timestamp - no PII; positive-path response bodies not exercised |

---

## 9. Worker / provider safety boundary

No provider-boundary action occurred, and this is verified, not assumed:

- `job_queue` after all staging activity: completed=2, dead=78 - identical to
  the baseline. `job_queue` rows created in the last 2 hours: **0**.
- `audit_logs` rows created in the last 2 hours: **0**.
- Nothing was done to the worker or scheduler: `ENABLE_WORKER_TRIGGER`
  untouched, `cron.job` untouched (both jobs still active), DLQ behavior
  untouched, no job inserted or deleted directly.
- The 4 candidate closure bookings for `current_date` in tenant `...0001` were
  NOT touched; no closure broadcast was dispatched for a date that has
  matching bookings.

Defense-in-depth for the provider boundary (source + config, established in the
baseline): a send attempt would fail inside `send-whatsapp-message` at the
`!phoneNumberId || !accessToken` check (`InternalError "Meta credentials not
configured"`) BEFORE the `graph.facebook.com` call and before the
`whatsapp_messages` record is created, because no `META_*` secret and no
`meta_whatsapp` Vault entry exist on staging. So even an unauthorized Option B
run could not have delivered a message; it would still have created real
provider-bound jobs and staging dead-letters, which is precisely why it was
refused.

**ENQUEUED != DELIVERED** was held throughout: no delivery claim is made
anywhere in this report.

---

## 10. Positive-enqueue, provider-delivery and production boundaries

- POSITIVE STAGING CLOSURE ENQUEUE: **UNPROVEN**. Not attempted (Option B not
  authorized) and not possible for Option A without staging actor credentials.
- Staging application-layer C2b write path (authenticated dispatch):
  **UNPROVEN** - blocked on credentials.
- WHATSAPP PROVIDER DELIVERY: **UNPROVEN**. No Meta credentials, none added, no
  synthetic provider success created.
- PRODUCTION: **UNPROVEN**. No production deployment exists and none was
  attempted. **NOT** claimed ready in any form.

---

## 11. Blockers and the minimum owner decision

| Blocker | Classification | Minimum owner decision required |
| --- | --- | --- |
| No staging `hospital_admin` / `receptionist` actor credentials (seed password obsolete on live staging; out-of-band password not available) | environment/credential, not product | Supply the current staging fixture password out-of-band (e.g. at the recorded temp path), OR authorize an equivalent read-only actor. This unblocks Phase 6 Option A, Phase 7 role/tenant checks, and idempotency replay |
| Positive closure enqueue cannot be proven without creating ~4 provider-bound jobs that the live `setura_cron_minute` worker will consume and dead-letter | deliberate safety decision | Already decided in this workstream: Option B refused. Any future positive staging enqueue needs an explicit owner authorization for those staging job/DLQ rows |
| Provider delivery | credential scope | Not authorized; out of scope for this workstream |
| Sandbox blocks `supabase functions deploy` (silent exit 0, no effect) | tooling, not product | None; workaround proven (run outside the sandbox). Worth recording so no future run trusts a sandboxed deploy exit code |

---

## 12. Final evidence tier

**C2b - STAGING DEPLOYMENT / SAFE ROUTE VERIFICATION COMPLETED; POSITIVE
APP-LAYER ENQUEUE REMAINS UNPROVEN.**

What is genuinely established here, at the highest tier safely reachable:

1. The `fb55678` source is deployed and running on staging as version 9, proven
   by platform version state, by HTTP responses that only that code can
   produce, and by SHA256 parity of the server-unbundled artifact against the
   commit (15/15 files).
2. Staging no longer runs the pre-fix v8 source; the deployed bundle contains
   `.eq("appointment_date", sessionDate)` and no `booking_date` predicate.
3. The gateway and the function's own auth/validation/method boundaries fail
   closed correctly on the deployed artifact.
4. All of this was achieved with zero database jobs, zero audit rows, zero
   schema/secret/worker/scheduler changes, and `fb55678` still unpushed.

What is NOT established: authenticated closure dispatch on staging, positive
enqueue, idempotency replay, cross-tenant denial, role-denied 403, provider
delivery, production behavior. All remain UNPROVEN and are recorded as such.

---

## 13. Inherited local evidence (from `fb55678`, not re-run here)

Verified against the committed `C2B_BROADCAST_HTTP_CLOSURE_VERIFICATION_REPORT.md`
rather than restated blindly: `command_center_broadcast_http` 23/23 post-fix
(with the pre-fix failure and positive control recorded), regression
`enterprise_command_center` 30/30, `alert_center_http` 28/28, unit suite
113/113, `deno task check` exit 0, `deno task lint` clean.

Formatting claim is deliberately narrow and is recorded as the source report
states it: the two C2b files (`broadcasts.ts`,
`command_center_broadcast_http.test.ts`) are individually `deno fmt --check`
clean, while repo-wide `deno fmt:check` still reports **14 unrelated files**
differing on line endings only (Windows `core.autocrlf` checkout condition,
`git diff` against HEAD empty for those files). No repo-wide normalization was
performed in this workstream either. That report's own boundaries are
consistent with this one: staging app-layer write path UNPROVEN, provider
delivery UNPROVEN, production UNPROVEN.

The full local campaign was NOT re-run in this workstream because deployment
introduced no source change (per Phase 8 of the workstream instruction).
