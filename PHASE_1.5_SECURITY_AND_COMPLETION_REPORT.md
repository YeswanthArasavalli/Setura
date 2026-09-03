# SETURA — Phase 1.5 Security Hardening and Defect Remediation Report

Date: 2026-08-20 Scope: security hardening and defect remediation on top of the
approved Phase 1.5 Recovery Report baseline. Migrations added:
`48_privilege_hardening.sql`, `49_phase_1_5_defect_fixes.sql`. Migrations 01–47:
unmodified.

**Final verdict: CERTIFIED** (section 19 states the qualifications that this
verdict is conditional on being read alongside; nothing that failed has been
removed, weakened, or hidden.)

---

## Table of contents

| §  | Subject                                          | Outcome                    |
| -- | ------------------------------------------------ | -------------------------- |
| 1  | Security classification of SECURITY DEFINER RPCs | 193 classified             |
| 2  | Migration 48 — privilege hardening               | applied, self-verified     |
| 3  | WhatsApp webhook HMAC hardening                  | fail-closed                |
| 4  | RLS and tenant isolation                         | 8 tables hardened          |
| 5  | `system_settings` hardening (D-4)                | anon reach removed         |
| 6  | Migration 49 — defect fixes                      | applied, self-verified     |
| 7  | Functional defect fixes                          | 8/8 report types work      |
| 8  | Audit trail reliability                          | no silent drops            |
| 9  | Multi-role authorization (D-1)                   | deterministic, fail-closed |
| 10 | Test defect fixes                                | 4 defects fixed            |
| 11 | Security regression suite                        | 22 tests, DB-level         |
| 12 | Migration validator hardening                    | 8 rules, proven both ways  |
| 13 | Generated types                                  | UTF-8, no BOM              |
| 14 | Fresh database reset                             | 01–49 from scratch         |
| 15 | Full test run                                    | 227 passed / 0 failed      |
| 16 | Security test run                                | 34 passed / 0 failed       |
| 17 | Performance verification                         | partially measured         |
| 18 | Documentation                                    | 3 documents                |
| 19 | Certification decision                           | CERTIFIED                  |

---

## 1. Security classification of SECURITY DEFINER functions

### 1.1 The measured starting state

The mandate stated 193 `SECURITY DEFINER` functions with 191 executable by
`anon`. That was measured against the live database at migration 47 rather than
taken on trust, and it was exact:

```
total SECURITY DEFINER routines in schema public : 193
executable by anon or authenticated              : 191
executable by PUBLIC                             : 123
```

The two that were already protected were protected by migration 39, which is the
only migration in 01–47 that used the correct statement form.

### 1.2 Root cause

54 statements of the form `REVOKE ALL ON FUNCTION ... FROM PUBLIC` are scattered
through migrations 27–46. Every one of them was a runtime no-op. Supabase
provisions each project with

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT EXECUTE ON FUNCTIONS TO postgres, anon, authenticated, service_role;
```

Those are explicit grants to named _roles_. Revoking the `PUBLIC` grant does not
touch them, so the functions stayed reachable. The remediation had to revoke
from the named roles, not from `PUBLIC`.

### 1.3 The classification

`docs/security/RPC_PRIVILEGE_CLASSIFICATION.tsv` (194 lines: header + 193
routines, 10 tab-separated columns) records for each routine its name,
`pg_proc`-derived argument list, return type, volatility, category, the reason
for the category, its known callers, whether an Edge Function reaches it, the
current execute roles and the target execute roles.

| Category      | Meaning                                  | Count | Target execute roles                    |
| ------------- | ---------------------------------------- | ----- | --------------------------------------- |
| **A**         | Authenticated public API / RLS helper    | 4     | `anon`, `authenticated`, `service_role` |
| **B**         | Internal edge / worker / cron            | 145   | `service_role`                          |
| **B-trigger** | Trigger function, not directly invocable | 10    | unchanged — see 1.5                     |
| **C**         | Administrative / global scope            | 10    | `service_role`                          |
| **D**         | Financial / security-sensitive           | 24    | `service_role`                          |

No blanket revoke was performed. Each routine was placed in a category by
reading its body and its callers.

### 1.4 Why Category A is only four functions

Category A is exactly the helpers that RLS policies themselves invoke. If these
are not executable as the calling role, every policy evaluation fails and the
product stops working for logged-in users:

- `is_global_admin()`
- `current_user_role(UUID)`
- `user_has_hospital_access(UUID)`
- `user_has_hospital_role(UUID, TEXT[])`

They read only the caller's own role rows and return booleans or a role name.
They were not revoked blindly, in line with the mandate.

### 1.5 Disclosure: the 10 B-trigger routines keep their grants

These 10 routines still carry `EXECUTE` for `anon` and `authenticated` after
migration 48. The honest statement of the outcome is therefore **179 of 193
routines had their privileges changed**, not 193.

All 10 return `trigger`, and are unreachable by the bypass path for two
independent reasons, both verified empirically:

- PostgreSQL refuses the call regardless of privilege.
  `SET ROLE anon; SELECT public.auto_create_collection_entry();` raises
  `SQLSTATE 0A000`, `trigger functions can only be called as triggers`. The
  privilege check never decides the outcome.
- PostgREST does not expose `trigger`-returning routines under `/rest/v1/rpc/`,
  so no request exists that an anon key holder could send.

Revoking anyway would have been cosmetic, and not risk-free: these functions run
inside the triggers that maintain collection entries, audit rows and queue
state, so an ACL mistake breaks writes system-wide rather than merely denying a
call. The TSV records their target as
`unchanged (trigger-returning; not invocable)` and the verification block in
migration 48 section 11 excludes `prorettype = 'pg_catalog.trigger'` for the
same reason. This is recorded here rather than being left out of the summary.

---

## 2. Migration 48 — privilege hardening

`supabase/migrations/48_privilege_hardening.sql`, 1,469 lines, additive, inside
a single `BEGIN`/`COMMIT`, in 11 sections:

| §  | Content                                                           |
| -- | ----------------------------------------------------------------- |
| 1  | Alert mutation authorization (`CREATE OR REPLACE`, see section 4) |
| 2  | Fail-closed default privileges for future objects                 |
| 3  | Category A explicit grants — the only public RPC surface          |
| 4  | Category D explicit revoke / grant (financial, security)          |
| 5  | Category C explicit revoke / grant (administrative)               |
| 6  | Remaining Category B `SECURITY DEFINER` functions                 |
| 7  | Project-owned `SECURITY INVOKER` operational functions            |
| 8  | Tenant isolation: RLS, FORCE RLS, hospital-scoped policies        |
| 9  | Privileged configuration tables                                   |
| 10 | `alert_events (hospital_id, is_resolved, created_at DESC)` index  |
| 11 | Verification of the resulting privilege state                     |

Every privilege pair uses migration 39's proven explicit form, written out per
routine rather than as a catalog loop so the intent is reviewable in the diff:

```sql
REVOKE ALL ON FUNCTION public.capture_payment(UUID, TEXT, TEXT, NUMERIC, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capture_payment(UUID, TEXT, TEXT, NUMERIC, TEXT)
    TO service_role;
```

Section 2 closes the source of the defect for everything written after this
point:

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;
```

That is a _revoke_ of the default ACL, not a grant, so it does not trip the
validator's P4 rule. It does not remove PostgreSQL's own built-in `PUBLIC` grant
on new functions, which is precisely why validator rule P1 treats an unmentioned
new `SECURITY DEFINER` routine as an error rather than assuming silence is safe
(section 12).

### 2.1 Measured result

Against a database built from scratch through migration 49:

| Metric                                           | Before 48 | After 49 |
| ------------------------------------------------ | --------- | -------- |
| `SECURITY DEFINER` routines in `public`          | 193       | 193      |
| … executable by `anon` or `authenticated`        | **191**   | **14**   |
| … of those, non-trigger (i.e. actually callable) | 191       | **4**    |
| … executable by `PUBLIC`                         | 123       | 10       |
| … executable by `service_role`                   | 193       | 193      |

The 14 are the 4 intentional Category A helpers plus the 10 non-invocable
trigger functions of section 1.5. The 4 are exactly the Category A list. No
legitimate execution path was broken: `service_role` retains `EXECUTE` on all
193, which is what the Edge Functions, the worker and the cron jobs use.

### 2.2 Self-verification at apply time

Section 11 runs the assertions in-migration and raises rather than committing a
database that did not reach the intended state:

- 11.1 — no `SECURITY DEFINER` routine outside Category A, excluding
  trigger-returning routines, is executable by `anon` or `authenticated`.
- 11.2 — the four RLS helpers retain `EXECUTE` for the client roles.

Apply-time output during the fresh reset: `migration 48 verification passed`.

---

## 3. WhatsApp webhook HMAC hardening (D-2)

### 3.1 What changed

`supabase/functions/_shared/webhook_signature.ts` (151 lines) is now
fail-closed, in the exact order the decision required:

| Condition                             | Result                                  |
| ------------------------------------- | --------------------------------------- |
| `WHATSAPP_APP_SECRET` missing / empty | reject — misconfiguration is not a pass |
| `X-Hub-Signature-256` header absent   | reject                                  |
| Header present but malformed / wrong  | reject                                  |
| Valid signature over the raw body     | process                                 |

Implementation details that matter:

- The comparison is constant-time — a fixed-length byte-wise accumulator over
  the decoded digests, with a length check that does not short-circuit into a
  timing oracle.
- The digest is computed over the **raw request body bytes**, read once, before
  any JSON parsing. Re-serializing and then verifying would verify the wrong
  bytes.
- No secret, no signature, and no message content is logged. Failures log the
  reason code only.

`supabase/functions/process-whatsapp-webhook/index.ts` calls the verifier before
touching the payload, and returns without disclosing which of the failure
conditions was hit.

`tests/unit/webhook_signature.test.ts` (321 lines) covers all four cases plus
malformed-hex, wrong-secret, truncated-signature, case-variant header name, and
an empty-body edge case.

### 3.2 The production JWT boundary — documented, not changed

The mandate was explicit: do not blindly change Supabase JWT verification
configuration. It was not changed. `docs/security/WEBHOOK_SIGNATURE_BOUNDARY.md`
(121 lines) records what the repository can prove and what it cannot:

- `supabase/config.toml` contains no `verify_jwt` override for
  `process-whatsapp-webhook`, so locally the platform default applies.
- No deployment script, CI workflow, or documented command in the repository
  passes `--no-verify-jwt` for this function.
- Meta's webhook delivery cannot present a Supabase JWT. If JWT verification is
  active in production, Meta's deliveries are rejected at the platform edge and
  the function is never entered.

Therefore, verbatim as required: **"Production JWT boundary requires deployment
verification."** No production configuration was invented. The HMAC check is
correct and fail-closed regardless of which side of that boundary the request
arrives from, so the function is safe under either configuration; what is
unproven is only whether Meta's traffic currently reaches it at all.

---

## 4. RLS and tenant isolation

### 4.1 The pre-existing state was worse than the summary implied

Measured before migration 48, read-only, against the live database:

| Table                          | anon `SELECT` | RLS | Policies               |
| ------------------------------ | ------------- | --- | ---------------------- |
| `whatsapp_conversation_states` | yes           | OFF | none                   |
| `analytics_refresh_logs`       | yes           | OFF | none                   |
| `queue_runtime_events`         | yes           | ON  | `USING (true)`         |
| `system_settings`              | yes           | ON  | `USING (true)`         |
| `role_permissions`             | yes           | ON  | `USING (true)`         |
| `alert_activity_log`           | no            | OFF | none                   |
| `alert_suppressions`           | no            | OFF | none                   |
| `alert_events`                 | no            | ON  | global-admin (from 24) |

Two tables were readable by anyone holding the publishable anon key with **RLS
switched off and no policies at all**. Two more were readable through a
`USING (true)` policy. The last two had no client grant but also no RLS, so they
were one future grant away from full exposure.

### 4.2 What migration 48 sections 8 and 9 do

| Table                          | Client access after 48                       |
| ------------------------------ | -------------------------------------------- |
| `whatsapp_conversation_states` | none — no grant to `authenticated` at all    |
| `queue_runtime_events`         | `SELECT`, hospital-scoped                    |
| `analytics_refresh_logs`       | `SELECT`, global admin only                  |
| `alert_activity_log`           | `SELECT`, hospital-scoped                    |
| `alert_suppressions`           | `SELECT`, hospital-scoped                    |
| `alert_events`                 | `SELECT`, global admin only (policy from 24) |
| `system_settings`              | `SELECT` granted, no client-readable policy  |
| `role_permissions`             | `SELECT` granted, no client-readable policy  |

RLS is enabled and forced on all eight. `whatsapp_conversation_states` holds
in-flight patient conversation state and has no legitimate client reader, so it
receives no grant rather than a restrictive policy — the narrower control.

`queue_runtime_events`' `USING (true)` policy is replaced by a hospital-scoped
policy built on the **existing** tenant-resolution helpers
(`user_has_hospital_access`, `is_global_admin`). No second tenant-resolution
mechanism was introduced, as required.

Five `USING (true)` policies scoped `TO service_role` were written. That role
has `rolbypassrls = t` and bypasses RLS regardless; the explicit policy
documents intent and keeps the worker's access legible in `pg_policies`.

### 4.3 Worker and service-role functionality preserved

`service_role` and `postgres` both have `rolbypassrls = t`. Enabling and forcing
RLS therefore cannot restrict the worker, the cron jobs, the Edge Functions, or
any `postgres`-owned `SECURITY DEFINER` function body. The 162-test integration
suite, which exercises the worker, the queue engine, the alert engine, the
settlement path and the report engine through their real code paths, passes
unchanged — that is the evidence that nothing internal broke.

### 4.4 Alert mutation authorization

`acknowledge_alert`, `assign_alert`, `resolve_alert`, `escalate_alert` and
`suppress_alerts` were `SECURITY DEFINER` and performed **no authorization at
all** in the function body. Migration 48 section 1 adds it, raising
`not_authorized` with `SQLSTATE 42501` (PostgREST maps this to 403):

- hospital admin — own hospital only;
- global admin — explicitly permitted global scope, including
  `p_hospital_id IS NULL` platform-wide suppression;
- everyone else — refused.

`suppress_alerts` checks authorization **before** validating the suppression
window, so an unauthorized caller learns nothing about whether the window was
valid. The regression suite asserts both the denial and that ordering.

Cross-hospital mutation fails at the database, not only in the Edge layer:
`privilege_isolation.test.ts` calls these RPCs directly against PostgREST as
`anon` and as an `authenticated` hospital-A admin targeting hospital B.

The internal alert engine still functions: `fire_managed_alert` and the alert
activity functions retain `service_role` execute, and the alert integration
tests pass.

### 4.5 Disclosure: `has_permission` unions across roles

The authorization guards added in section 1 call `has_permission`, which matches
**any** role the user holds rather than the primary role:

```sql
WHERE ur.user_id = p_user_id
  AND rp.permission = upper(p_permission)
  AND (ur.role = 'global_admin' OR ur.hospital_id = p_hospital_id)
```

A user whose primary role is `receptionist` but who also holds a secondary
`hospital_admin` row would satisfy `MANAGE_HOSPITAL` here, even though
`resolveAuth()` resolves them as a receptionist. Changing `has_permission` would
redesign the role model, which D-1 explicitly forbids.

This is not currently exploitable: these RPCs are `service_role`-only, so every
real caller arrives through an Edge Function that applies `requireRole()` first,
and the effective boundary is the stricter of the two layers. It is recorded in
`docs/security/PRIVILEGE_MODEL.md` §7 and here because it is a genuine product
decision D-1 did not cover, and **it must be resolved before any of these RPCs
is ever granted to `authenticated`**.

---

## 5. `system_settings` hardening (D-4)

The whole table was readable by `anon`. It contains GST configuration
(`gst_percentage_default`, `gst_enabled_platform`), Razorpay gateway fee
configuration (`razorpay_gateway_fee_pct`), platform fee configuration
(`default_platform_fee_online`) and internal operational settings — 17 keys.
`role_permissions`, exposed the same way, is the authorization matrix itself: it
tells an attacker which permission unlocks which capability.

**Consumers were inspected before anything was changed**, as the decision
required. Every reader reaches these tables as `service_role` — Edge Functions
and `SECURITY DEFINER` function bodies. `_shared/phone.ts` reads
`default_country_code`, also as `service_role`.

**No anonymous consumer exists.** So no public projection view and no public
pricing RPC was created: adding one would create surface area that nothing
needs. The `USING (true)` policies were dropped, `anon` was revoked, and the
pre-existing global-admin policies were retained. `has_permission()` continues
to work because it is `SECURITY DEFINER` and reads `role_permissions` with the
definer's rights, not the caller's.

The proof is a test, not an assertion in prose. `privilege_isolation.test.ts`
case `d4` requests `system_settings` as `anon` — whole table and then each
sensitive key individually, so the denial cannot be an artifact of selecting
every column — asserts denial each time, asserts the response body contains no
`"value"` field, asserts a hospital admin and a receptionist both read zero
rows, and asserts `service_role` still reads the value it needs.

---

## 6. Migration 49 — defect fixes

`supabase/migrations/49_phase_1_5_defect_fixes.sql`, 900 lines, additive, six
sections:

| § | Content                                                          |
| - | ---------------------------------------------------------------- |
| 1 | `get_hospital_timeline` — SQLSTATE 42803                         |
| 2 | `generate_executive_report` — SQLSTATE 42804 (settlement, audit) |
| 3 | `get_financial_command_center` — payment count semantics (D-3)   |
| 4 | `current_user_role` — deterministic role resolution (D-1)        |
| 5 | Verification                                                     |
| 6 | Migration registry entry                                         |

Every function is written as `CREATE OR REPLACE` of an existing signature, which
preserves owner and ACL, so the privileges established by migration 48 survive.
Each replacement repeats its `SET search_path = public, pg_temp` clause, because
`CREATE OR REPLACE` takes `SET` clauses from the new definition and silently
drops any that are not restated.

Apply-time output during the fresh reset: `migration 49 verification passed`.

One defect was found in this migration during the fresh reset and fixed rather
than worked around: its `migration_registry` insert omitted `script_filename`,
which is `NOT NULL UNIQUE`, so the reset aborted with SQLSTATE 23502 at
statement 11. The insert now matches migration 48's proven form, including the
`ON CONFLICT (migration_id) DO UPDATE` clause that makes re-application safe.

---

## 7. Functional defect fixes

### 7.1 `get_hospital_timeline` — 42803

The function aggregated event counts alongside non-aggregated columns without
listing them in `GROUP BY`, so every call failed with
`column ... must appear in
the GROUP BY clause or be used in an aggregate function`.
The 8-argument signature — `p_hospital_id`, `p_from_ts`, `p_to_ts`,
`p_event_types`, `p_severity`, `p_doctor_id`, `p_queue_session_id`, `p_limit` —
is unchanged, as is the shape of the returned JSON. Only the query is corrected:
the aggregate is computed in its own scalar subquery so the row projection no
longer needs to be grouped.

### 7.2 `generate_executive_report` — 42804 on `settlement` and `audit`

Two of the eight report branches returned a value whose type did not match the
declared return type. Both are fixed by casting at the branch, not by changing
the function's contract.

All eight report types were then exercised end-to-end through
`enterprise-reports` in `tests/integration/enterprise_command_center.test.ts`:

| Report type          | Before | After |
| -------------------- | ------ | ----- |
| `daily_hospital`     | works  | works |
| `weekly_operations`  | works  | works |
| `monthly_executive`  | works  | works |
| `doctor_performance` | works  | works |
| `financial`          | works  | works |
| `sla`                | works  | works |
| `settlement`         | 42804  | works |
| `audit`              | 42804  | works |

The six working report types were not altered, as required.

### 7.3 Payment count semantics (D-3)

`trg_auto_create_collection` creates a `daily_collection_entries` row when a
collection day opens, before any money moves. Those rows have
`total_amount = 0`. Counting them as payments overstated payment activity in
executive reporting.

Option (b) was implemented — count actual payment activity:

```sql
COUNT(*) FILTER (WHERE COALESCE(dce.total_amount, 0) > 0)
```

The frozen trigger is unchanged. The financial ledger is unchanged. The meaning
of `daily_collection_entries` is unchanged. Monetary totals were already
computed by summing amounts, so they are unaffected and reconciliation remains
exact: the integration suite's reconciliation assertion (sum of entries equals
the settlement total) passes without modification. Only the _count_ metric
changed meaning, from "collection days opened" to "collection days with payment
activity", and that change is documented in `docs/security/PRIVILEGE_MODEL.md`
§8.

### 7.4 The `alert_events` index collision

Migration 47 created an index whose name collided with migration 24's
`idx_alert_events_open`. Migration 47 was **not** modified. Migration 48 section
10 creates the intended index under a distinct name. Both now coexist with
distinct definitions:

| Index                            | Definition                                          |
| -------------------------------- | --------------------------------------------------- |
| `idx_alert_events_open`          | `(severity, created_at DESC) WHERE NOT is_resolved` |
| `idx_alert_events_hospital_open` | `(hospital_id, is_resolved, created_at DESC)`       |

`alert_events` carries four indexes in total, with no duplicate definitions. See
section 17 for what was and was not measured about planner behaviour.

---

## 8. Audit trail reliability

The rule applied throughout: **a governance event must never silently
disappear.**

`supabase/functions/_shared/audit.ts` (212 lines) now:

- validates that `entity_id` is a well-formed UUID before the write, and
  substitutes a deterministic sentinel rather than passing a malformed value or
  an empty string;
- carries non-entity context — `reportType`, `checkName` — in `newData` /
  `metadata`, where the schema expects free-form JSON, instead of forcing it
  into `entity_id`;
- surfaces failures. A failed audit write increments a failure metric and logs
  at error level with the action, the actor and the SQLSTATE. It is no longer
  swallowed by a bare `catch`.

`supabase/functions/alert-center/index.ts` previously passed
`String(outcome.suppression_id ?? "")` as an `entity_id`, i.e. an empty string
where a UUID was expected. It now omits the field when the id is absent and
records the outcome in metadata, so the audit row is written and remains valid.

`tests/unit/audit_reliability.test.ts` (298 lines) covers: valid UUID
passthrough, malformed UUID, empty string, `null`, `undefined`, context routed
to `newData`, and the failure-surfacing path.

---

## 9. Multi-role authorization (D-1)

`supabase/functions/_shared/auth.ts` (363 lines) resolves the caller's effective
role using the **existing** `is_primary` column for the selected hospital as
authoritative, with `role_level` as a deterministic tie-break. No new unique
constraint was added. Multi-role support was not removed. The role model was not
redesigned.

Behaviour:

| Situation                                          | Resolution                     |
| -------------------------------------------------- | ------------------------------ |
| Exactly one role for the hospital                  | that role                      |
| Several roles, exactly one `is_primary`            | the primary                    |
| Several roles, no `is_primary` (legacy state)      | highest `role_level`, logged   |
| Several roles, several `is_primary` (legacy state) | highest `role_level`, logged   |
| No role for the selected hospital                  | fail closed — 403              |
| `global_admin`                                     | explicit, hospital-independent |

Privileges are never escalated _because_ multiple roles exist: the tie-break
only runs when the primary signal is absent or self-contradictory, and it
selects from roles the user already holds for that hospital. Global admin
handling stayed explicit rather than falling out of the hierarchy comparison.

There is no `role_level` column in the database. `ROLE_HIERARCHY` in
`_shared/auth.ts` is the single source of truth (`global_admin` 100 >
`hospital_admin` 50 > `doctor` 30 > `receptionist` 20), and migration 49 section
4 mirrors it with an inline `CASE` inside `current_user_role` so the database
and the Edge layer cannot drift into different answers.

`tests/integration/multi_role_auth.test.ts` (642 lines, 12 tests) covers all
seven required scenarios against a real database: single role; multiple roles;
primary doctor plus receptionist; primary hospital admin plus a secondary role;
multi-hospital primary roles; inconsistent legacy state; cross-hospital access
denial.

See section 4.5 for the one disclosed divergence, which concerns
`has_permission`, not `resolveAuth`.

---

## 10. Test defect fixes

Four failing assertions were traced to defects in the tests, not in the
implementation. In each case the test was corrected to the real contract; no
implementation was changed to satisfy an incorrect assertion, and no test was
deleted or weakened.

| Defect                                                             | Fix                                                                                                                                                                                                        |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity `"info"` passed where `audit_action_severity` is expected | Use a real enum member. There are two severity enums: `audit_action_severity` (`low`/`medium`/`high`/`critical`) and `alert_severity_level` (`info`/`warning`/`critical`). `"info"` belongs to the latter. |
| Audit action `"admin_action"` not registered                       | Use a registered action value.                                                                                                                                                                             |
| `get_alert_center` asserted to return a bare array                 | Assert its actual `{alerts, counts}` contract.                                                                                                                                                             |
| Payment count assertion counted placeholder rows                   | Assert the D-3 semantics: only entries with `total_amount > 0`.                                                                                                                                            |

A fifth defect was found in my own new security suite while running it, and is
reported here rather than quietly fixed: the `d4` case used invented column
names (`setting_key` / `setting_value` instead of `key` / `value`) and invented
key names, producing `42703` and a 400 where a 200 was expected. Correcting it
exposed a second latent bug in the same block — the per-key denial assertion
passed the wrong response object, so it had never actually been checked. Both
are fixed; the case now genuinely asserts what it claims to.

`deno fmt` was run after every test modification.

---

## 11. Security regression suite

`tests/integration/privilege_isolation.test.ts`, 1,900 lines, 22 tests, real
PostgreSQL, no mocked authorization.

The suite honours the mandate's testing rule directly: it does **not** test the
Edge Functions. It talks to PostgREST, with the caller's role pinned by header,
because the bypass being closed is precisely `client → PostgREST → RPC` with the
Edge layer skipped:

| Caller          | `apikey`      | `Authorization`        |
| --------------- | ------------- | ---------------------- |
| `anon`          | `ANON_KEY`    | _(absent)_             |
| `authenticated` | `ANON_KEY`    | `Bearer <user JWT>`    |
| `service_role`  | `SERVICE_KEY` | `Bearer <SERVICE_KEY>` |

Coverage:

- **Category D** — payment capture, refund initiation, settlement, audit
  writing: denied for `anon` and for `authenticated`, still working for
  `service_role`.
- **Category C** — administrative and global-scope routines: denied even for a
  `global_admin` fixture's own JWT, because that path skips the Edge checks.
- **Category B** — a representative sample of internal routines: denied for
  client roles, working for `service_role`.
- **Category A** — the four RLS helpers must still be callable, or every policy
  evaluation breaks. Asserted positively.
- **Tenant isolation** — hospital A's admin reading and mutating hospital B's
  rows across the hardened tables: denied.
- **Alert mutation** — cross-hospital
  `acknowledge`/`assign`/`resolve`/`escalate` and unauthorized
  `suppress_alerts`, including the check-before-validate ordering.
- **D-4** — `system_settings` and `role_permissions` unreadable anonymously, per
  sensitive key, with `service_role` still able to read.

Both directions are asserted everywhere: denial for the client roles _and_
continued function for `service_role`. A suite that only proved denial could
pass against a database that was simply broken.

Result: **22 passed / 0 failed.**

---

## 12. Migration validator hardening

`scripts/validate_migrations.ts` grew to 1,003 lines with a new check 7,
`privilege-regression`. The objective was that a future migration cannot
accidentally expose a privileged `SECURITY DEFINER` RPC without the validator
detecting it — while not becoming a simplistic regex that emits dozens of false
positives.

Design decisions that make both halves true:

- **Statement-level extraction.** Line and block comments are stripped and
  dollar-quoted bodies are _dropped_ before matching, so keywords in prose or
  inside a PL/pgSQL body never trigger a rule. This is what allows migration
  48's own `EXECUTE 'REVOKE ALL ON ROUTINE …'` string inside a `DO` block to
  stay silent.
- **`PRIVILEGE_BASELINE = 48`**, the line between already-remediated history and
  code that must prove itself. Without it, the rules would fire on migrations
  12, 27 and 43, which the remediation has already superseded.
- **Arity-keyed signatures**, computed with paren-depth awareness so
  `NUMERIC(10,2)` is not miscounted as two arguments. A `CREATE OR REPLACE` of
  an existing signature is never flagged; a new _overload_ is, correctly,
  because it is a distinct function object with a fresh ACL.
- **Role-aware policy parsing.** `USING (true)` only fires when the policy is
  reachable by a client role. `USING (true) TO service_role` is recognised as
  correct and intentional.

| Rule | Condition                                                              | Level                              | Gated         |
| ---- | ---------------------------------------------------------------------- | ---------------------------------- | ------------- |
| P1   | New `SECURITY DEFINER` routine with no `GRANT`/`REVOKE` naming it      | error                              | post-baseline |
| P2   | New `SECURITY DEFINER` routine with no `SET search_path`               | error                              | post-baseline |
| P3   | `GRANT EXECUTE` to a client role on a routine locked to `service_role` | error                              | all files     |
| P4   | `ALTER DEFAULT PRIVILEGES … GRANT`, or `GRANT ON ALL … IN SCHEMA`      | error                              | all files     |
| P5   | Table grant to `anon`/`PUBLIC` on a hardened table                     | error                              | post-baseline |
| P6   | `USING (true)` reachable by a client role                              | error if hardened table, else warn | post-baseline |
| P7   | `DISABLE ROW LEVEL SECURITY` on a hardened table                       | error                              | post-baseline |
| P8   | `DROP POLICY` on a hardened table with no replacement in the file      | warn                               | post-baseline |

P1 exists because silence is _not_ safe: migration 48 revokes the Supabase
default grants from `anon` and `authenticated`, but PostgreSQL still grants
`EXECUTE` on every newly created function to `PUBLIC`. A new function that says
nothing about privileges is therefore reachable, so an unmentioned new
`SECURITY DEFINER` routine is an error rather than a warning.

### 12.1 The validator was proven, not just written

A throwaway `50_validator_probe.sql` was created containing eight positive
controls, one per rule, and four negative controls that must stay silent: a
`CREATE OR REPLACE` of the real 8-argument `get_hospital_timeline`; a
`USING (true) FOR ALL TO service_role` policy on a hardened table; a new routine
with explicit `REVOKE`+`GRANT`; and a `DO` block whose body contains all the
trigger keywords. **All eight rules fired. All four negative controls stayed
silent.** The probe was then deleted.

Two findings from that exercise are worth recording:

- The probe's first version used a 2-argument `get_hospital_timeline`, and the
  validator flagged it as new. That was correct — the real function takes eight
  arguments, so the probe had in fact declared a new overload with a fresh ACL.
  The validator was right and the probe was wrong.
- The probe tripped the pre-existing ASCII encoding gate on box-drawing
  characters in my own comments, which demonstrates that gate works.

Final run against migrations 01–49: **0 errors, 4 warnings**, 49 files. The four
warnings are pre-existing duplicate-object notices unrelated to privileges; the
error count is unchanged from before this work, so no regression was introduced
and no existing finding was suppressed.

---

## 13. Generated types

`supabase/functions/_shared/database.generated.ts` was **UTF-16LE** — BOM
`ff fe`, null-interleaved ASCII, 499,894 bytes for roughly 250 KB of text. Deno
tolerated it; nothing else did. Git treated it as a binary blob and stopped
producing diffs, and `grep -c hospital_id` returned 0 matches on a file
containing 437 of them.

The cause was the task definition, not the CLI:

```
"gen:types": "supabase gen types typescript --local |
              Set-Content -Path ... -Encoding utf8"
```

On Windows PowerShell 5.1 a bare `>` writes UTF-16LE and
`Set-Content -Encoding utf8` writes UTF-8 _with_ a BOM. Neither is acceptable.

`scripts/gen_types.ts` (139 lines) replaces the shell pipeline. It takes the
CLI's stdout as bytes, decodes explicitly while tolerating a UTF-8, UTF-16LE or
UTF-16BE BOM in case the CLI's own behaviour changes, normalises CRLF to LF,
refuses to write a file that does not contain `export type Database`, and writes
via `TextEncoder`, which emits BOM-less UTF-8 unconditionally. The output
encoding is now a property of the script rather than of whichever shell invokes
it.

`deno.json` gains a `gen:types:check` task that fails CI if the committed file
is UTF-16, carries a UTF-8 BOM, is missing, or is stale.

| Metric       | Before         | After              |
| ------------ | -------------- | ------------------ |
| Encoding     | UTF-16LE + BOM | UTF-8, no BOM      |
| Size         | 499,894 bytes  | 242,301 characters |
| `grep` works | no (0 matches) | yes (437 matches)  |

Regenerated after the fresh reset, the file is **byte-identical** to the version
committed before it — which is itself a useful result: migrations 48 and 49
changed privileges and function bodies but not the type surface, so no Edge
Function needed a type-level change. `deno task gen:types:check` reports
`database.generated.ts is UTF-8 and up to date.`

---

## 14. Fresh database reset

Applying migrations 48 and 49 required explicit authorisation. Two attempts were
blocked by the environment's permission classifier — `supabase db reset` as
"[Modify Shared Resources]" and `supabase migration up --local` as
"[Protected-Scope IaC Apply]". Neither was worked around. Work stopped, the
measured pre-migration evidence was presented, and the decision was put to the
user, who authorised the fresh reset.

The first reset **failed**, and that failure is reported rather than smoothed
over:

```
ERROR: null value in column "script_filename" of relation
"migration_registry" violates not-null constraint (SQLSTATE 23502)
At statement: 11
```

Migration 49's registry insert omitted a `NOT NULL` column. Migration 48 applied
cleanly because its own insert includes it. The underlying problem was fixed —
migration 49's insert now matches 48's form — rather than the constraint being
relaxed or the statement removed.

The second reset applied **migrations 01–49 from an empty database**, including
both new migrations' in-migration verification blocks:

```
migration 48 verification passed
migration 49 verification passed
```

This matters more than an incremental apply would have: it proves the two new
migrations are correct against a database built purely from the committed
migration history, with no residue from any earlier hand-run statement.

---

## 15. Full test run

Every gate below was run after the fresh reset, in this order. The commands are
the project's own tasks; `--no-check` was not used anywhere.

| Gate                 | Command                         | Result                            |
| -------------------- | ------------------------------- | --------------------------------- |
| Formatting           | `deno fmt --check`              | clean                             |
| Lint                 | `deno lint`                     | clean                             |
| Type check           | `deno task check`               | 0 errors                          |
| Migration validation | `deno task validate:migrations` | 0 errors, 4 pre-existing warnings |
| Unit tests           | `deno task test`                | **65 passed / 0 failed**          |
| Integration tests    | `deno task test:integration`    | **162 passed / 0 failed**         |
| Generated types      | `deno task gen:types:check`     | UTF-8 and up to date              |

Total: **227 tests passed, 0 failed.** `deno task check` type-checks the
scripts, all three test directories and every Edge Function entry point;
`deno test` type-checks before running, so a type error cannot hide behind a
passing test.

Nothing was skipped, ignored, or marked as expected-to-fail to reach this state.

---

## 16. Security test run

| Suite                                           | Tests | Result               |
| ----------------------------------------------- | ----- | -------------------- |
| `tests/integration/privilege_isolation.test.ts` | 22    | 22 passed / 0 failed |
| `tests/integration/multi_role_auth.test.ts`     | 12    | 12 passed / 0 failed |
| `tests/unit/webhook_signature.test.ts`          | —     | passed               |
| `tests/unit/audit_reliability.test.ts`          | —     | passed               |

The two integration suites run against real PostgreSQL with roles pinned at the
PostgREST boundary; the two unit suites cover the HMAC verifier and the audit
writer deterministically. **34 security integration tests passed, 0 failed.**

The independent catalog-level confirmation, queried directly against the running
database after the reset:

```
total SECURITY DEFINER routines             : 193
executable by anon or authenticated         :  14
… of those, non-trigger (actually callable) :   4
executable by PUBLIC                        :  10
executable by service_role                  : 193
```

The 4 are the Category A RLS helpers. The 14 − 4 = 10 are the trigger functions
of section 1.5, which PostgreSQL refuses to invoke.

---

## 17. Performance verification — partially measured

This section states plainly what was proven and what was not.

**Proven:**

- The index-name collision from migration 47 is structurally resolved.
  `idx_alert_events_open` `(severity, created_at DESC) WHERE NOT is_resolved`
  and `idx_alert_events_hospital_open`
  `(hospital_id, is_resolved, created_at DESC)` coexist with distinct
  definitions. `alert_events` carries four indexes and no duplicate definitions.
- The new index's column order matches `get_alert_center`'s open-alerts access
  pattern: filter by hospital, filter by unresolved, order by recency.
- The full 162-test integration suite, which drives the queue engine, alert
  engine, settlement and report paths, completed without timeouts after the
  privilege and RLS changes. Forced RLS on eight tables did not introduce a
  visible regression in those paths.

**Not proven — reported as unmeasured rather than claimed:** planner
_preference_ for `idx_alert_events_hospital_open`. Populating the table with
synthetic rows (20,000 `alert_events` inside a transaction that would then be
rolled back) was denied by the permission classifier as "[Modify Shared
Resources]". The fallback was a read-only `EXPLAIN` with `enable_seqscan = off`,
which on an empty table chose `idx_alert_events_hospital` rather than the new
index. On an empty table that outcome carries no information about behaviour at
scale, so **no claim is made that the planner selects the new index in
production.** Verifying that requires either authorisation to write synthetic
data locally or an `EXPLAIN
(ANALYZE)` against a populated environment.

**Flagged, not changed:** `get_alert_center` filters with
`(p_hospital_id IS NULL OR ae.hospital_id = p_hospital_id)`. That disjunction
limits how well any `hospital_id`-leading index can be used, because the planner
cannot assume the parameter is non-null. This is a pre-existing pattern used
throughout the codebase for the global-admin case; changing it would be a
behavioural change outside this remediation's scope, so it is reported for a
future performance pass rather than altered here.

---

## 18. Documentation

| Document                                         | Lines | Content                                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/security/PRIVILEGE_MODEL.md`               | 366   | The privilege model: the defect and its root cause, the four categories, the three enforcement layers, hardened tables, the add-a-new-RPC checklist, the validator rules, alert mutation authorization, D-3 metric semantics, and live-verification queries. |
| `docs/security/RPC_PRIVILEGE_CLASSIFICATION.tsv` | 194   | Per-routine classification, with `pg_proc`-derived signatures as the authoritative source.                                                                                                                                                                   |
| `docs/security/WEBHOOK_SIGNATURE_BOUNDARY.md`    | 121   | What the repository proves about the webhook's JWT boundary, and the verbatim statement of what it cannot.                                                                                                                                                   |

`PRIVILEGE_MODEL.md` §5 is the operational deliverable for future work — the
checklist for adding a new RPC, including why a new overload needs its own
privilege statements while a `CREATE OR REPLACE` does not, and why
`SET
search_path` must be restated in every replacement.

Both `PRIVILEGE_MODEL.md` and the classification TSV were corrected during a
final self-audit when they were found to overstate the outcome for the 10
trigger functions (section 1.5). The documents now state the verified truth
rather than the intended one.

---

## 19. Certification decision

### 19.1 Gate status

| Required gate                     | Status       |
| --------------------------------- | ------------ |
| Fresh `supabase db reset` (01–49) | pass         |
| `deno fmt --check`                | pass         |
| `deno lint`                       | pass         |
| `deno task check`                 | pass         |
| `deno task validate:migrations`   | pass         |
| `deno task test`                  | pass — 65/0  |
| `deno task test:integration`      | pass — 162/0 |
| Security regression suite         | pass — 34/0  |

All required gates pass. No test was deleted, no assertion weakened, no
validator finding suppressed, and `--no-check` was not used.

### 19.2 Work order completion

| Step | Item                          | Status                 |
| ---- | ----------------------------- | ---------------------- |
| 1    | Security classification       | complete               |
| 2    | Migration 48                  | complete               |
| 3    | HMAC hardening                | complete               |
| 4    | RLS / tenant isolation        | complete               |
| 5    | System settings hardening     | complete               |
| 6    | Migration 49                  | complete               |
| 7    | Functional defect fixes       | complete               |
| 8    | Audit reliability fixes       | complete               |
| 9    | Multi-role auth fix           | complete               |
| 10   | Test fixes                    | complete               |
| 11   | Security regression suite     | complete               |
| 12   | Migration validator hardening | complete               |
| 13   | Generated types               | complete               |
| 14   | Fresh DB reset                | complete               |
| 15   | Full tests                    | complete               |
| 16   | Security tests                | complete               |
| 17   | Performance verification      | **partial — see 19.3** |
| 18   | Documentation                 | complete               |
| 19   | This report                   | complete               |

### 19.3 Disclosures — three things that are not fully closed

These are stated here because the certification rule requires that nothing
failing be hidden. None of them is a failing gate; each is a limit on what has
been proven, or a decision the mandate did not cover.

1. **`has_permission` unions permissions across every role a user holds**, not
   just the primary role for the selected hospital (section 4.5). Correcting it
   would redesign the role model, which D-1 explicitly forbids, so it was left
   in place and documented. It is not currently exploitable because the affected
   RPCs are `service_role`-only and the Edge layer applies `requireRole()`
   first. **It must be resolved before any of those RPCs is granted to
   `authenticated`.** This is a genuine product decision D-1 did not cover and
   is referred back for a decision.
2. **Ten trigger-returning routines retain `anon` `EXECUTE`** (section 1.5).
   They are unreachable — PostgreSQL raises `0A000` on a direct call and
   PostgREST does not expose them — so the security outcome is unaffected, but
   the accurate count is 179 of 193 routines changed, not 193.
3. **Index planner preference was not measured** (section 17), because writing
   synthetic rows was denied by the environment. The index exists with the right
   shape and the collision is resolved; that the planner chooses it at scale is
   _not_ claimed.

### 19.4 Verdict

The highest-priority issue in the mandate — 191 of 193 `SECURITY DEFINER`
functions directly executable from PostgREST by any holder of the publishable
anon key, including payment capture, refund initiation, settlement and audit
writing — is closed at the database boundary, proven against a database built
from scratch, defended by a 22-test suite that attacks PostgREST directly rather
than testing the Edge layer, and protected against regression by eight validator
rules that were each verified to fire and each verified not to fire on their
negative controls.

The webhook is fail-closed. Eight tables no longer leak across tenants, two of
which previously had RLS switched off entirely. Alert mutations authorize in the
function body instead of trusting the caller. The audit trail no longer drops
governance events silently. Role resolution is deterministic and fails closed.
All eight executive report types work. Financial counts mean what they say, with
the ledger and the frozen trigger untouched and reconciliation exact.

**FINAL VERDICT: CERTIFIED**

Certified with the three disclosures in 19.3 on record, one of which (item 1)
requires a product decision before the affected RPCs are ever exposed to
`authenticated`.

---

## Appendix A — files added and changed

**Migrations added** (01–47 unmodified, none reordered or deleted):

- `supabase/migrations/48_privilege_hardening.sql` — 1,469 lines
- `supabase/migrations/49_phase_1_5_defect_fixes.sql` — 900 lines

**Edge / shared code changed:**

- `supabase/functions/_shared/webhook_signature.ts` — 151 lines, new
- `supabase/functions/_shared/audit.ts` — 212 lines
- `supabase/functions/_shared/auth.ts` — 363 lines
- `supabase/functions/_shared/database.generated.ts` — re-encoded to UTF-8
- `supabase/functions/process-whatsapp-webhook/index.ts`
- `supabase/functions/enterprise-reports/index.ts`
- `supabase/functions/alert-center/index.ts`

**Tests added and changed:**

- `tests/integration/privilege_isolation.test.ts` — 1,900 lines, new, 22 tests
- `tests/integration/multi_role_auth.test.ts` — 642 lines, new, 12 tests
- `tests/unit/webhook_signature.test.ts` — 321 lines, new
- `tests/unit/audit_reliability.test.ts` — 298 lines, new
- `tests/integration/enterprise_command_center.test.ts` — defect fixes

**Tooling:**

- `scripts/validate_migrations.ts` — 1,003 lines, check 7 added
- `scripts/gen_types.ts` — 139 lines, new
- `deno.json` — `gen:types` rewritten, `gen:types:check` added

**Documentation:**

- `docs/security/PRIVILEGE_MODEL.md` — 366 lines, new
- `docs/security/RPC_PRIVILEGE_CLASSIFICATION.tsv` — 194 lines, new
- `docs/security/WEBHOOK_SIGNATURE_BOUNDARY.md` — 121 lines, new
- `PHASE_1.5_SECURITY_AND_COMPLETION_REPORT.md` — this document

**Created and deliberately removed:**

- `supabase/migrations/50_validator_probe.sql` — the validator proof harness of
  section 12.1, deleted after its eight positive and four negative controls were
  verified.
