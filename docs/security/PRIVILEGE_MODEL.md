# SETURA Privilege Model

Status: enforced by `supabase/migrations/48_privilege_hardening.sql`,
regression-tested by `tests/integration/privilege_isolation.test.ts`, statically
guarded by `scripts/validate_migrations.ts`.

This document describes who is allowed to execute what, and why the answer is
enforced in the database rather than only in the Edge Functions.

---

## 1. The defect this model closes

SETURA puts its business logic in `SECURITY DEFINER` PostgreSQL functions and
treats Edge Functions as transport plus authorization. That is a sound design,
but it has one requirement: the database must refuse callers that the Edge layer
would have refused. Otherwise the authorization check is merely the front door
of a building with no walls:

```
client -> Edge Function -> requireRole() -> RPC        (intended)
client ----------------------------------> RPC        (the bypass)
          POST /rest/v1/rpc/<fn> with the anon key
```

Supabase provisions every project with:

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT EXECUTE ON FUNCTIONS TO postgres, anon, authenticated, service_role;
```

Because those are explicit grants to named _roles_, the 54 statements of the
form `REVOKE ALL ON FUNCTION ... FROM PUBLIC` scattered through migrations 27-46
were runtime no-ops: they revoked a `PUBLIC` grant that was not what made the
functions reachable. The measured result before migration 48 was **191 of 193
`SECURITY DEFINER` functions executable directly from PostgREST** by anyone
holding the (publishable) anon key, including payment capture, refund
initiation, settlement, and audit writing.

Separately, PostgreSQL itself grants `EXECUTE` on every newly created function
to `PUBLIC`. Migration 48 revokes the Supabase _default_ grants from `anon` and
`authenticated`, but a brand-new function still inherits the built-in `PUBLIC`
grant. That is why silence is not safe for new functions, and why the validator
treats an unmentioned new `SECURITY DEFINER` routine as an error rather than a
warning.

---

## 2. The four categories

Every `SECURITY DEFINER` routine is classified in
[`RPC_PRIVILEGE_CLASSIFICATION.tsv`](RPC_PRIVILEGE_CLASSIFICATION.tsv), whose
`arguments` column is taken from `pg_proc` and is therefore the authoritative
signature source. Do not derive signatures by grepping the SQL; adjacent
definitions bleed into one another.

| Category      | Meaning                                 | Count | Executable by                           |
| ------------- | --------------------------------------- | ----- | --------------------------------------- |
| **A**         | Authenticated public API / RLS helper   | 4     | `anon`, `authenticated`, `service_role` |
| **B**         | Internal edge / worker / cron           | 145   | `service_role`                          |
| **B-trigger** | Trigger function, never called directly | 10    | unchanged — see below                   |
| **C**         | Administrative / global scope           | 10    | `service_role`                          |
| **D**         | Financial / security-sensitive          | 24    | `service_role`                          |

Category A is deliberately small. It is exactly the four helpers that RLS
policies themselves call, which must be executable as the calling role or every
policy evaluation fails:

- `is_global_admin()`
- `current_user_role(UUID)`
- `user_has_hospital_access(UUID)`
- `user_has_hospital_role(UUID, TEXT[])`

Categories C and D use the same statement pattern, migration 39's proven form,
written out per routine rather than as a loop so that the intent is reviewable
in the diff:

```sql
REVOKE ALL ON FUNCTION public.capture_payment(UUID, TEXT, TEXT, NUMERIC, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capture_payment(UUID, TEXT, TEXT, NUMERIC, TEXT)
    TO service_role;
```

### Why B-trigger keeps its grants

The 10 B-trigger routines still carry `EXECUTE` for `anon` and `authenticated`
after migration 48. This is deliberate, and it is recorded here rather than
quietly left out of the summary, because the honest statement of the outcome is
"179 of 193 routines had their privileges changed", not "193".

All 10 return `trigger`, which makes them unreachable by the bypass path this
model exists to close, for two independent reasons:

- PostgreSQL refuses the call regardless of privilege.
  `SET ROLE anon; SELECT
public.auto_create_collection_entry();` raises
  `SQLSTATE 0A000`, `trigger
functions can only be called as triggers`. The
  privilege check never decides the outcome.
- PostgREST does not expose `trigger`-returning routines under `/rest/v1/rpc/`
  at all, so there is no request an anon key holder could send.

Revoking anyway would be a cosmetic change with real downside: these functions
run inside the triggers that maintain collection entries, audit rows, and queue
state, and a mistake in their ACLs breaks writes across the system rather than
merely denying a call. The classification TSV therefore records their
`target_execute_roles` as `unchanged (trigger-returning; not invocable)`, and
the `pg_proc` check in migration 48 section 11 excludes
`prorettype = 'pg_catalog.trigger'` for the same reason.

Consequence for the live-verification query in section 9: it returns 14 rows,
not 4 — the 4 Category A helpers plus these 10.

### Why Category C is service_role-only even for a global admin

Category C is global-scope administration: partition management, retention
sweeps, analytics refresh, configuration rollback. Its authorization rules live
in the Edge layer, which runs as `service_role` after validating the caller's
JWT. A `global_admin` user's JWT presented directly to PostgREST is therefore
refused at the database boundary — not because global admins are untrusted, but
because the _path_ skips the checks. The regression suite asserts this
explicitly for the `global_admin` fixture.

---

## 3. The three enforcement layers

| Layer                | Enforces                                        | Bypassed by              |
| -------------------- | ----------------------------------------------- | ------------------------ |
| Function `EXECUTE`   | Which roles may call an RPC at all              | nothing                  |
| RLS policies         | Which rows a client role may see or change      | `rolbypassrls` roles     |
| Edge `requireRole()` | Business authorization, per-endpoint role gates | calling PostgREST direct |

`service_role` and `postgres` both have `rolbypassrls = t`; `anon` and
`authenticated` have `f`. This is the reason RLS alone cannot be the security
model for worker, cron, or Edge Function traffic, and the reason the `EXECUTE`
grant is the primary control. RLS is the tenant-scoping layer for the _client_
roles only.

The layers are independent, and the effective boundary is the strictest of them.
A test that only exercises the Edge layer proves nothing about the other two,
which is why the regression suite talks to PostgREST directly with deliberately
pinned roles:

| Caller          | `apikey`      | `Authorization`        |
| --------------- | ------------- | ---------------------- |
| `anon`          | `ANON_KEY`    | _(absent)_             |
| `authenticated` | `ANON_KEY`    | `Bearer <user JWT>`    |
| `service_role`  | `SERVICE_KEY` | `Bearer <SERVICE_KEY>` |

---

## 4. Hardened tables

Migration 48 sections 8 and 9 removed anon reach from eight tables. Six carry
tenant-scoped operational data; two were configuration tables published
wholesale by a `USING (true)` policy.

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

`whatsapp_conversation_states` holds in-flight patient conversation state and
has no legitimate client reader, so it receives no grant rather than a
restrictive policy — the narrower control.

`queue_runtime_events` previously carried a `USING (true)` read policy.
Migration 48 replaces it with a hospital-scoped policy built on the existing
tenant-resolution helpers (`user_has_hospital_access`, `is_global_admin`). No
second tenant-resolution mechanism was introduced.

A `USING (true)` policy scoped `TO service_role` is not a finding: that role
bypasses RLS regardless, and the explicit policy documents intent. Migration 48
writes five of them.

### D-4: `system_settings` and `role_permissions`

Both tables were readable by `anon`. `system_settings` contains GST
configuration, Razorpay fee configuration, and internal operational settings;
`role_permissions` is the authorization matrix itself, which tells an attacker
exactly which permission unlocks which capability.

Consumers were inspected before changing anything. Every reader reaches these
tables through `service_role` (Edge Functions and `SECURITY DEFINER` function
bodies); `_shared/phone.ts` reads `default_country_code`, also as
`service_role`. **No anonymous consumer exists**, so no public projection view
and no public pricing RPC was created — adding one would create surface area
that nothing needs. The `USING (true)` policies were dropped, `anon` was
revoked, and the pre-existing global-admin policies were retained.

`has_permission()` continues to work because it is `SECURITY DEFINER` and reads
`role_permissions` with the definer's rights, not the caller's.

---

## 5. Adding a new RPC: the checklist

1. Decide the category, and add the row to `RPC_PRIVILEGE_CLASSIFICATION.tsv`.
2. Write the function with `SET search_path = public, pg_temp`. Without it, a
   `SECURITY DEFINER` function runs with the definer's rights and a
   caller-controlled `search_path`.
3. Write the privilege statements in the same migration:

   ```sql
   REVOKE ALL ON FUNCTION public.new_fn(UUID) FROM PUBLIC, anon, authenticated;
   GRANT EXECUTE ON FUNCTION public.new_fn(UUID) TO service_role;
   ```

   Category A instead grants to `anon, authenticated, service_role`, and should
   be justified in the migration comment.
4. Add a probe to `CATEGORY_B/C/D` in
   `tests/integration/privilege_isolation.test.ts` — both directions: denied for
   the client roles, still working for `service_role`.
5. Run `deno task validate:migrations`. It fails the build if step 3 was
   forgotten.

A new _overload_ is a new function object with a fresh ACL, so it needs its own
privilege statements. `CREATE OR REPLACE` of an existing signature does not:
replacing a function preserves its owner and ACL. It does, however, take its
`SET` clauses from the new definition, so `SET search_path` and
`SET row_security` must be repeated in every replacement.

---

## 6. What the validator enforces

`scripts/validate_migrations.ts` check 7 (`privilege-regression`) runs against
whole SQL statements with comments, string literals, and dollar-quoted bodies
removed, so keywords appearing in prose or inside a PL/pgSQL body never trigger
it. `PRIVILEGE_BASELINE = 48` is the line between "already remediated history"
and "must prove itself".

| Rule | Condition                                                              | Level |
| ---- | ---------------------------------------------------------------------- | ----- |
| P1   | New `SECURITY DEFINER` routine with no `GRANT`/`REVOKE` naming it      | error |
| P2   | New `SECURITY DEFINER` routine with no `SET search_path`               | error |
| P3   | `GRANT EXECUTE` to a client role on a routine locked to `service_role` | error |
| P4   | `ALTER DEFAULT PRIVILEGES ... GRANT`, or `GRANT ON ALL ... IN SCHEMA`  | error |
| P5   | Table grant to `anon`/`PUBLIC` on a hardened table                     | error |
| P6   | `USING (true)` reachable by a client role (error if hardened table)    | both  |
| P7   | `DISABLE ROW LEVEL SECURITY` on a hardened table                       | error |
| P8   | `DROP POLICY` on a hardened table with no replacement in the file      | warn  |

Each rule was verified against a synthetic regression migration that triggers
it, and against negative controls that must stay silent: `CREATE OR REPLACE` of
an existing signature, `USING (true) TO
service_role`, an explicitly-privileged
new routine, and a `DO` block whose body contains the same keywords.

---

## 7. Alert mutation authorization

`acknowledge_alert`, `assign_alert`, `resolve_alert`, `escalate_alert` and
`suppress_alerts` now check authorization in the function body before mutating,
raising `not_authorized` with `SQLSTATE 42501`:

- hospital admin: own hospital only;
- global admin: explicitly permitted global scope, including
  `p_hospital_id IS NULL` platform-wide suppression;
- everyone else: refused.

`suppress_alerts` checks authorization **before** validating the suppression
window, so an unauthorized caller receives `not_authorized` rather than a leak
of whether the window was valid. The regression suite asserts both orderings.

### Known divergence from D-1 (deliberate, not a defect)

`has_permission(p_user_id, p_hospital_id, p_permission)` matches **any** role
the user holds, not the primary role:

```sql
WHERE ur.user_id = p_user_id
  AND rp.permission = upper(p_permission)
  AND (ur.role = 'global_admin' OR ur.hospital_id = p_hospital_id)
```

So a user whose primary role is `receptionist` but who also holds a secondary
`hospital_admin` row would satisfy `MANAGE_HOSPITAL` in the guards above, even
though `resolveAuth()` would resolve them as a receptionist. Changing
`has_permission` would redesign the role model, which D-1 explicitly forbids
("Do NOT redesign the role model").

This is not currently exploitable: the alert RPCs are `service_role`-only, so
every real caller arrives through an Edge Function that applies `requireRole()`
first, and the effective boundary is the stricter of the two layers. It is
recorded here because it is a genuine product decision that D-1 did not cover,
and it must be resolved before any of these RPCs is ever granted to
`authenticated`.

---

## 8. Financial metric semantics (D-3)

`trg_auto_create_collection` creates a `daily_collection_entries` row when a
collection day opens, before any money moves. Those rows have
`total_amount = 0`. Counting them as payments overstated payment activity in
executive reporting.

Payment counts now count actual payment activity:

```sql
COUNT(*) FILTER (WHERE COALESCE(dce.total_amount, 0) > 0)
```

The trigger is unchanged, the ledger is unchanged, and the meaning of
`daily_collection_entries` is unchanged. Monetary totals were already computed
by summing amounts and are therefore unaffected; reconciliation remains exact.
Only the _count_ metric changed, from "collection days opened" to "collection
days with payment activity".

---

## 9. Verifying the model against a live database

```sql
-- Any SECURITY DEFINER function still reachable by a client role.
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       pg_get_function_result(p.oid)             AS returns
FROM   pg_proc p
JOIN   pg_namespace n ON n.oid = p.pronamespace
WHERE  n.nspname = 'public'
  AND  p.prosecdef
  AND  (has_function_privilege('anon',          p.oid, 'EXECUTE')
    OR  has_function_privilege('authenticated', p.oid, 'EXECUTE'))
ORDER  BY 1;
-- Expected: 14 rows - the four Category A helpers, plus the ten B-trigger
-- routines whose `returns` column is `trigger` and which PostgreSQL refuses
-- to invoke directly (SQLSTATE 0A000). Any row with a non-trigger return
-- type other than the four helpers is a regression.

-- Any function still executable by PUBLIC.
SELECT p.proname
FROM   pg_proc p
JOIN   pg_namespace n ON n.oid = p.pronamespace
WHERE  n.nspname = 'public'
  AND  has_function_privilege('public', p.oid, 'EXECUTE');
-- Expected: 10 rows, all trigger-returning. Migration 48 revokes the Supabase
-- default grants from anon and authenticated but not the built-in PUBLIC grant
-- on trigger functions; see section 2.

-- Hardened tables must not be readable by anon.
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM   pg_class c
JOIN   pg_namespace n ON n.oid = c.relnamespace
WHERE  n.nspname = 'public'
  AND  c.relname IN ('whatsapp_conversation_states', 'queue_runtime_events',
                     'analytics_refresh_logs', 'alert_activity_log',
                     'alert_suppressions', 'alert_events',
                     'system_settings', 'role_permissions')
  AND  has_table_privilege('anon', c.oid, 'SELECT');
-- Expected: zero rows.
```

Migration 48 section 11 runs the equivalent assertions at apply time and raises
if the intended end state was not reached.
