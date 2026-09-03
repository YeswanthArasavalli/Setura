# PRIVILEGE RUNTIME VERIFICATION

**Deliverable of:** SETURA Phase 1.6, Gate 2 — Database Privilege Verification
**Closes canonical finding:** **P1-11** — "The privilege boundary from Phase 1.5
is unproven" ([CROSS_PHASE_GAP_REGISTER.md:252-272](CROSS_PHASE_GAP_REGISTER.md#L252))

> **ID note.** This document uses the canonical Register scheme fixed by Gate 0.
> The finding closed here is **P1-11**. The Summary scheme in
> `CROSS_PHASE_AUDIT_REPORT.md` §23.3 numbers the same finding **P1-07**; that
> label is not used anywhere in this document.

**Verified at:** `2026-08-22 06:43:27.984103+00` (database `now()`)
**Server:** `PostgreSQL 17.6 on x86_64-pc-linux-gnu, compiled by gcc (GCC) 15.2.0, 64-bit`
**Container:** `supabase_db_setura`, image tag `postgres 17.6.1.106`
**Migration state:** `supabase_migrations.schema_migrations` = versions `01`…`49`,
49 rows, no gaps. Migration HEAD 49 applied.
**Scope:** all **479** routines in schema `public` — the exact population counted
in Gate 1. No ACL in this document is inferred from migration text; every value
is read from `pg_proc.proacl` or computed by `has_function_privilege()` against
the live catalog.

---

## 1. Why this gate exists

P1-11 did not assert that the privilege boundary was broken. It asserted that
nobody had ever looked:

> **Status:** **UNPROVEN, not failed.** … **Why it remains unproven:** the sole
> evidence is `privilege_isolation.test.ts`, which **could not be executed**
> (Docker unavailable), and `pg_proc.proacl` could not be read. No phase report
> contains catalog output either. … Until the suite runs, whether `anon` can
> execute financial routines is **unknown**.
> — [CROSS_PHASE_GAP_REGISTER.md:258-271](CROSS_PHASE_GAP_REGISTER.md#L258)

This gate reads the catalog and executes the boundary. It changes nothing.

---

## 2. Method

### 2.1 Two different questions, deliberately separated

A routine is reachable by an untrusted client only if **both** hold:

1. the routine's schema is exposed by PostgREST **and** the role has schema `USAGE`; and
2. the role has effective `EXECUTE` on the routine, **and** PostgREST is
   structurally willing to expose that routine's shape.

Catalog `EXECUTE` alone is therefore not an exposure claim, and this document
never treats it as one. Condition 1 was measured; condition 2 was measured **and
then executed** against the live API.

**PostgREST exposed schemas** — [supabase/config.toml](supabase/config.toml), `[api]`:

```toml
schemas = ["public", "graphql_public"]
extra_search_path = ["public", "extensions"]
max_rows = 1000
```

**Schema `USAGE`, effective** (`has_schema_privilege`):

| Schema | anon | authenticated | service_role | postgres |
|---|---|---|---|---|
| `public` | **t** | **t** | t | t |
| `extensions` | t | t | t | t |
| `auth` | t | t | t | t |
| `storage` | t | t | t | t |
| `graphql` | t | t | t | t |
| `graphql_public` | t | t | t | t |
| `vault` | f | f | t | t |

Schema `public` is exposed **and** `anon` holds `USAGE` on it. Condition 1 is
satisfied for every routine in this document's scope. Consequently the entire
protective burden rests on per-routine `EXECUTE` plus PostgREST's shape rules —
which is precisely why P1-11 mattered.

### 2.2 The expected state is derived from source, not invented

Migration 48 defines its own intended end state, and this document scores against
that definition rather than against an opinion. The classification predicate below
is transcribed from
[48_privilege_hardening.sql:766-808](supabase/migrations/48_privilege_hardening.sql#L766-L808):

| Class | Definition (from migration 48) | Expected `anon` / `authenticated` | Expected `service_role` |
|---|---|---|---|
| **A-rls-helper** | The 4 SECURITY DEFINER helpers RLS policies depend on, §3 [:451-492](supabase/migrations/48_privilege_hardening.sql#L451-L492) | **EXECUTE granted** | granted |
| **B/C/D-locked** | `prosecdef` ∧ `prokind IN ('f','p')` ∧ return ≠ `trigger` ∧ ∉ Category A ∧ not extension-owned. Category B §6 (145) + C §5 (10) + D §4 (24) | **revoked** | granted |
| **B-trigger** | `prosecdef` ∧ returns `trigger` (10) | untouched by design [:745-751](supabase/migrations/48_privilege_hardening.sql#L745-L751) | untouched |
| **INV-other (locked 9)** | SECURITY INVOKER operational helpers, §7 [:811-839](supabase/migrations/48_privilege_hardening.sql#L811-L839) | **revoked** | granted |
| **INV-other (pure 3)** | `normalize_phone_number`, `compute_health_score`, `get_partition_name` — "deliberately NOT touched, and recorded here as a decision" [:835-839](supabase/migrations/48_privilege_hardening.sql#L835-L839) | **granted, by decision** | granted |
| **INV-trigger** | SECURITY INVOKER trigger functions (8) | untouched by design | untouched |
| **EXT-extension** | `pg_depend.deptype = 'e'` — citext, pg_trgm, btree_gist, pgcrypto et al. Revoking "breaks index operator support" [:753-756](supabase/migrations/48_privilege_hardening.sql#L753-L756) | **out of scope** | out of scope |

> **Correction to the register, recorded per RULE 2.** P1-11's Location line cites
> "migration 48 §6 (Category B, 145 …), §7 (Category C, 10), §8 (Category D, 24)".
> The section numbers for C and D are wrong. In the actual file: **§4 = Category D
> (24)** [:495](supabase/migrations/48_privilege_hardening.sql#L495), **§5 =
> Category C (10)** [:655](supabase/migrations/48_privilege_hardening.sql#L655),
> **§6 = Category B (145)** [:723](supabase/migrations/48_privilege_hardening.sql#L723)
> (§6 is correct), **§7 = the 9 SECURITY INVOKER operational functions**, **§8 =
> tenant isolation / RLS**. The *counts* 145 / 10 / 24 are correct. This is a
> citation defect in the register, not a defect in the code, and it does not change
> P1-11's substance. Carried to Gate 8 alongside DOC-01. No register entry is
> renamed, renumbered, merged, split, added or removed.

### 2.3 A false PASS that was caught and discarded

First-pass probes called each routine through PostgREST with an empty body `{}`.
`get_reconciliation_summary` and `has_permission` both returned **HTTP 404
`PGRST202`** — "no matches were found in the schema cache".

That result is **inadmissible as privilege evidence** and was discarded. Both
routines take required arguments, so `PGRST202` is equally consistent with a
signature mismatch as with a privilege denial. Treating it as proof of enforcement
would have manufactured exactly the kind of unearned PASS that RULE 4 forbids.
The probes were re-run with correct named arguments plus a `service_role`
existence control (§4.2). Recorded because the trap is not obvious.

### 2.4 Verbatim classification query

```sql
WITH c AS (
  SELECT p.oid, p.proname, p.prosecdef, p.prokind, p.proacl,
    p.prorettype = 'pg_catalog.trigger'::regtype AS trig,
    EXISTS (SELECT 1 FROM pg_depend d
            WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid
              AND d.deptype='e') AS ext,
    p.proname IN ('is_global_admin','current_user_role',
                  'user_has_hospital_access','user_has_hospital_role') AS cat_a
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
), k AS (
  SELECT *, CASE
      WHEN cat_a AND prosecdef            THEN 'A_rls_helper'
      WHEN ext                            THEN 'EXT_extension_owned'
      WHEN prosecdef AND trig             THEN 'B_trigger_secdef'
      WHEN prosecdef AND prokind IN ('f','p') THEN 'BCD_secdef_locked'
      WHEN NOT prosecdef AND trig         THEN 'INV_trigger'
      ELSE 'INV_other' END AS class
  FROM c
)
SELECT class, count(*) AS n,
  count(*) FILTER (WHERE has_function_privilege('anon',oid,'EXECUTE'))         AS anon,
  count(*) FILTER (WHERE has_function_privilege('authenticated',oid,'EXECUTE')) AS auth,
  count(*) FILTER (WHERE has_function_privilege('service_role',oid,'EXECUTE'))  AS svc,
  count(*) FILTER (WHERE has_function_privilege('postgres',oid,'EXECUTE'))      AS pg,
  count(*) FILTER (WHERE proacl IS NULL)                                       AS acl_null
FROM k GROUP BY class ORDER BY class;
```

---

## 3. Census — actual measured state

Verbatim output of the query in §2.4, columns
`class | n | anon | auth | svc | pg | acl_null`:

```
A_rls_helper|4|4|4|4|4|0
B_trigger_secdef|10|10|10|10|10|0
BCD_secdef_locked|179|0|0|179|179|0
EXT_extension_owned|266|266|266|266|266|0
INV_other|12|3|3|12|12|0
INV_trigger|8|8|8|8|8|0
```

Scored against §2.2:

| Class | n | anon actual | anon expected | auth actual | service_role actual | Verdict |
|---|---|---|---|---|---|---|
| A-rls-helper | 4 | 4 / 4 | **all 4** | 4 / 4 | 4 / 4 | **PASS** |
| **B/C/D-locked** | **179** | **0 / 179** | **none** | **0 / 179** | **179 / 179** | **PASS** |
| B-trigger | 10 | 10 / 10 | untouched | 10 / 10 | 10 / 10 | **PASS** (§4.1) |
| INV-other | 12 | 3 / 12 | exactly the 3 pure helpers | 3 / 12 | 12 / 12 | **PASS** |
| INV-trigger | 8 | 8 / 8 | untouched | 8 / 8 | 8 / 8 | **PASS** (§4.1) |
| EXT-extension | 266 | 266 / 266 | out of scope | 266 / 266 | 266 / 266 | NOT ASSESSED |
| **Total** | **479** | | | | | |

`4 + 10 + 179 + 266 + 12 + 8 = 479` — reconciles exactly to the Gate 1 population.
`acl_null = 0` in every class: no routine in `public` relies on an implicit default
ACL; every one carries an explicit `proacl` array.

### 3.1 The 179 reconcile exactly to the register's own arithmetic

**179 = 145 (Category B) + 10 (Category C) + 24 (Category D)** — the three counts
P1-11 cites. The predicate-derived population and the register's stated population
are the same set, and **`anon` holds EXECUTE on none of them.**

### 3.2 The exception sets are the documented ones, name for name

The 12 `INV-other` routines split 9 locked / 3 open. Measured `proacl`:

**Locked — all 9 named in §7 [:820-828](supabase/migrations/48_privilege_hardening.sql#L820-L828), all `anon = false`, `proacl` = `postgres=X/postgres service_role=X/postgres`:**

| Routine | anon EXECUTE |
|---|---|
| `check_queue_backlog_alerts(integer, integer)` | false |
| `find_duplicate_patient_candidates(uuid, double precision)` | false |
| `forecast_queue_depth(uuid, date)` | false |
| `get_mv_refresh_health()` | false |
| `get_queue_health()` | false |
| `get_stuck_jobs(integer)` | false |
| `is_alert_suppressed(uuid, text)` | false |
| `is_hospital_online(uuid)` | false |
| `log_alert_activity(uuid, uuid, uuid, text, text)` | false |

In each case the PUBLIC entry `=X/postgres` is **absent** from `proacl` — the
`REVOKE ALL … FROM PUBLIC, anon, authenticated` took effect on the object itself.

**Open — exactly the 3 the migration documents as a deliberate decision:**

| Routine | anon EXECUTE | `proacl` |
|---|---|---|
| `compute_health_score(integer, integer, integer)` | true | `=X/postgres postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres` |
| `get_partition_name(text, date)` | true | same shape |
| `normalize_phone_number(text)` | true | same shape |

No fourth routine is open. The measured exception set and the documented exception
set are identical.

---

## 4. Runtime execution of the boundary

Catalog state was not accepted as proof of behaviour. The boundary was executed
through Kong → PostgREST against the live database.

### 4.1 Trigger-returning routines: EXECUTE granted, yet no API surface

Ten SECURITY DEFINER trigger functions retain `anon=X/postgres` **and** the PUBLIC
grant `=X/postgres`. Two of them are financially significant by name —
`write_booking_ledger_entries` and `auto_create_collection_entry`. The gate
instruction forbids both dismissing this without evidence and calling it a
vulnerability without evidence, so it was tested.

These functions take **no arguments**, so an empty-body RPC call is the *correct*
call shape — the §2.3 ambiguity does not apply here.

| Routine | Caller role | Result |
|---|---|---|
| `write_booking_ledger_entries` | **anon** (has EXECUTE) | **404** `PGRST202` — "no matches were found in the schema cache" |
| `auto_create_collection_entry` | **anon** (has EXECUTE) | **404** `PGRST202` |
| `write_booking_ledger_entries` | **service_role** (has EXECUTE) | **404** `PGRST202` |
| `auto_create_collection_entry` | **service_role** (has EXECUTE) | **404** `PGRST202` |

The refusal is **role-independent**: a role that demonstrably holds EXECUTE is
refused identically. Therefore the refusal is **structural** — PostgREST will not
expose a routine whose return type is `trigger` — and is not a privilege artefact.

This is a genuinely discriminating result, because the ACL and the API disagree:
`anon` holds EXECUTE in the catalog and still cannot invoke the routine. Combined
with the fact that EXECUTE on a trigger function is checked at `CREATE TRIGGER`
time rather than at fire time, the ten routines carry **no PostgREST attack
surface**. Migration 48's stated reasoning at
[:745-751](supabase/migrations/48_privilege_hardening.sql#L745-L751) is confirmed
by execution. The same reasoning and the same evidence apply to the 8
`INV-trigger` routines.

**Classification: trigger-only. Not API-callable. Not a vulnerability.** Recorded
as measured state, not dismissed.

### 4.2 Locked routines: the controlled experiment

Run with correct named arguments against live seeded data —
`p_hospital_id = 00000000-0000-4000-8000-000000000002` (first row of
`public.hospitals`), `p_user_id = 00000000-0000-4000-8000-0000000000a1` (first row
of `public.profiles`).

| Routine | Caller | HTTP | Body |
|---|---|---|---|
| `get_reconciliation_summary` | **anon** | **401** | `{"code":"42501","message":"permission denied for function get_reconciliation_summary"}` |
| `has_permission` | **anon** | **401** | `{"code":"42501","message":"permission denied for function has_permission"}` |
| `get_reconciliation_summary` | **service_role** | **200** | `[{"total_collected":0,"platform_fee_total":0,"receptionist_fee_total":0,"total_refunded":0,"total_settled":0,"net_outstanding":0,"booking_count":0,"paid_booking_count":0}]` |
| `has_permission` | **service_role** | **200** | `false` |

This is decisive, and it is decisive *because* of the control:

- The `service_role` **200** responses prove both routines are present in
  PostgREST's schema cache and fully invocable through the API. Non-existence and
  signature mismatch are eliminated as explanations.
- The `anon` failures are **SQLSTATE `42501`, `permission denied for function`** —
  PostgreSQL's own privilege denial, raised by the executor **before** the routine
  body runs. Not a 404, not a validation error, not an application-level check.

`anon` cannot execute a financial routine. The question P1-11 recorded as
**"unknown"** now has a measured answer.

Measured `proacl` for the routines exercised:

```
get_reconciliation_summary(p_hospital_id uuid, p_from_date date, p_to_date date)
  volatile=s  proacl = postgres=X/postgres service_role=X/postgres
has_permission(p_user_id uuid, p_hospital_id uuid, p_permission text)
  volatile=s  proacl = postgres=X/postgres service_role=X/postgres
idempotent_capture_payment(p_provider_event_id text, p_payload_hash text,
  p_raw_payload jsonb, p_gateway_order_id text, p_gateway_payment_id text,
  p_gateway_signature text)
  volatile=v  proacl = postgres=X/postgres service_role=X/postgres
```

Both executed routines are `STABLE` (`provolatile = 's'`), so neither probe could
mutate state. `idempotent_capture_payment` is `VOLATILE` and was **not** invoked —
its ACL is reported from the catalog only.

### 4.3 Positive control

`normalize_phone_number` — a documented deliberately-open pure helper — called as
**anon** returned **HTTP 200** `"+919876543210"`. The probe harness, the anon key
and the RPC path all work. The failures in §4.2 are therefore properties of the
boundary, not of the test method.

---

## 5. A new defect found while verifying: the fail-closed default does not hold

P1-11 is a PASS. Section 2 of the same migration is **not**, and this was found by
executing its stated guarantee rather than reading it.

Migration 48 §2 states its purpose at
[:391-393](supabase/migrations/48_privilege_hardening.sql#L391-L393):

> Root cause remediation. Without this, migration 50 and every later migration
> would silently re-introduce the same defect: any newly created function would
> again be EXECUTE-able by anon.

**Measured `pg_default_acl` for schema `public`:**

| Grantor | Objtype | Default ACL |
|---|---|---|
| `postgres` | `f` functions | `postgres=X/postgres service_role=X/postgres` |
| `postgres` | `r` tables | `postgres=arwdDxtm/postgres service_role=arwdDxtm/postgres` |
| `supabase_admin` | `f` functions | `postgres=X/… **anon=X/…** **authenticated=X/…** service_role=X/…` |
| `supabase_admin` | `r` tables | `postgres=arwdDxtm/… **anon=arwdDxtm/…** **authenticated=arwdDxtm/…** service_role=arwdDxtm/…` |

Two independent problems:

1. **The `supabase_admin` grantor entries were never hardened.** §2's `DO` loop
   catches `insufficient_privilege` and continues with a `NOTICE`
   [:431-436](supabase/migrations/48_privilege_hardening.sql#L431-L436). The
   migration runs as `postgres`, which is not a member of `supabase_admin`, so the
   `supabase_admin` rows took that path and were skipped **silently by design**.
   For objects created by `supabase_admin`, `anon` still receives EXECUTE on
   functions and **full `arwdDxtm` DML on tables** by default.

2. **The PUBLIC grant was never revoked, for any grantor.** §2 issues
   `REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated`
   ([:420](supabase/migrations/48_privilege_hardening.sql#L420) and
   [:445](supabase/migrations/48_privilege_hardening.sql#L445)) and omits `PUBLIC`.
   PostgreSQL grants `EXECUTE` on new functions to `PUBLIC` by built-in default,
   and `anon` is reached through `PUBLIC`. Revoking from the two named roles does
   not remove that path.

**Empirical proof, executed inside a transaction and rolled back:**

```sql
BEGIN;
CREATE FUNCTION public.__gate2_probe() RETURNS int LANGUAGE sql AS 'SELECT 1';
SELECT has_function_privilege('anon','public.__gate2_probe()','EXECUTE');
SELECT has_function_privilege('authenticated','public.__gate2_probe()','EXECUTE');
SELECT proacl FROM pg_proc WHERE proname='__gate2_probe';
ROLLBACK;
```

Output:

```
future_fn_anon_execute=true
future_fn_authenticated_execute=true
future_fn_acl==X/postgres postgres=X/postgres service_role=X/postgres
```

The leading `=X/postgres` is the PUBLIC grant. A function created in `public`
**after** migration 48 is executable by `anon`. §2's stated guarantee does not
hold. Post-verification `SELECT count(*) FROM pg_proc WHERE proname='__gate2_probe'`
returned **0** — the probe left no residue.

Note the contrast that isolates the bug: §6's object-level loop revokes
`FROM PUBLIC, anon, authenticated`
([:797-798](supabase/migrations/48_privilege_hardening.sql#L797-L798)) and works.
§2's default-privileges statements omit `PUBLIC` and do not. **The same migration
uses the correct primitive in one section and an incomplete one in the other** —
the identical *class* of error P1-11 identified in migrations 27-46, recurring
inside the remediation.

### 5.1 Latent, not live — and only by accident

Migration 49 is the only migration after 48. It creates four functions
([:90](supabase/migrations/49_phase_1_5_defect_fixes.sql#L90),
[:260](supabase/migrations/49_phase_1_5_defect_fixes.sql#L260),
[:425](supabase/migrations/49_phase_1_5_defect_fixes.sql#L425),
[:620](supabase/migrations/49_phase_1_5_defect_fixes.sql#L620)) and contains
**zero** `REVOKE` or `GRANT` statements. Measured result:

| Routine created by migration 49 | secdef | anon | auth | `proacl` |
|---|---|---|---|---|
| `generate_executive_report(text, uuid, date, date)` | t | **false** | false | `postgres=X/postgres service_role=X/postgres` |
| `get_financial_command_center(uuid, date)` | t | **false** | false | `postgres=X/postgres service_role=X/postgres` |
| `get_hospital_timeline(uuid, timestamptz, timestamptz, text[], text, uuid, uuid, integer)` | t | **false** | false | `postgres=X/postgres service_role=X/postgres` |
| `current_user_role(uuid)` | t | true | true | `postgres=X/… anon=X/… authenticated=X/… service_role=X/…` (Category A — correct) |

No routine is currently over-exposed. But the reason is incidental: all four are
`CREATE OR REPLACE` of functions that already existed before migration 48, and
`CREATE OR REPLACE` **preserves the existing ACL** when the signature is unchanged.
Each name resolves to exactly one signature — no overloads were created. Migration
49 inherited migration 48's lockdown rather than earning it.

Had any of those signatures changed, or had migration 49 added a genuinely new
function, that routine would today be `anon`-executable with no statement anywhere
in the repository to prevent it.

**Recorded as new Phase 1.6 finding `F16-04`. Severity proposed P1** (a
security-boundary regression vector on the next schema change, in a system whose
central Phase 1.5 claim is this boundary), **current exposure: none.** Severity is
proposed, not assigned — assignment belongs to the Gate 8 register update. Per §14
and the standing instruction, **no repair is attempted in this gate.** A fix would
require a new migration, which §15 forbids initiating here.

---

## 6. Verdict on P1-11

| Question P1-11 asked | Measured answer | Evidence |
|---|---|---|
| Can `anon` execute financial routines? | **No** | 0 / 179 catalog EXECUTE; SQLSTATE `42501` at runtime with `service_role` 200 control (§4.2) |
| Did the Category B/C/D lockdown take effect? | **Yes, all 179** | §3, §3.1 |
| Are the 145 / 10 / 24 counts real? | **Yes — sum 179 exactly** | §3.1 |
| Was the Category A exposure limited to 4? | **Yes, exactly 4** | §3 |
| Are the documented exceptions the actual exceptions? | **Yes, name for name** | §3.2 |
| Do trigger functions with `anon` EXECUTE create API exposure? | **No — structurally refused** | §4.1, role-independent `PGRST202` |
| Is the boundary proven by execution, not inspection? | **Yes** | §4.2, §4.3 |

**P1-11: VERIFIED — PASS.** The privilege boundary Phase 1.5 claimed is real,
enforced by the live database, and confirmed by execution. The finding was
correctly classed UNPROVEN rather than FAILED; the underlying work was sound.

**Scope limits, stated explicitly:**

- This is the **local** stack. No deployed environment exists, so the production
  privilege state remains **UNPROVEN** — as does whether migration 48's `DO` loop
  skips a *different* grantor set on a hosted project, which is the exact
  divergence §2's comment at
  [:398-400](supabase/migrations/48_privilege_hardening.sql#L398-L400) anticipates.
- **Routines only.** Table and column privileges, RLS policy *correctness*, and
  `FORCE ROW LEVEL SECURITY` are Gate 7 scope. Gate 1 measured 93/93 tables with
  RLS enabled; whether the 139 policies are individually correct is not asserted
  here.
- The 266 extension-owned routines are **NOT ASSESSED**, matching migration 48's
  recorded decision. They are listed in full in Appendix B so the exclusion is
  auditable rather than invisible.
- `tests/integration/privilege_isolation.test.ts` — the unexecuted test that left
  P1-11 unproven — has **not** been run in this gate. Gate 2 verified the boundary
  directly against the catalog and the API. Whether that test file *correctly
  asserts* this boundary is a separate question, deferred to Gate 3.

---

## Appendix A — All 213 SETURA-owned routines in schema `public`

Every row measured from the live catalog. `Source` lists every migration whose text
defines that routine name, derived by
`grep -lE "FUNCTION (public\.)?<name>[[:space:]]*\("` over
`supabase/migrations/*.sql`; a later migration in the list supersedes an earlier
one. All 211 distinct names resolved to at least one migration — none unmapped.

| Routine | Schema | Class | SecDef | Returns | anon | auth | service_role | postgres | Actual `proacl` | Expected | API-callable | Source | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `current_user_role(p_hospital_id uuid)` | public | A-rls-helper | true | text | true | true | true | true | `postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres` | anon+auth+service_role EXECUTE | YES - public schema exposed | 01,48,49 | **PASS** |
| `is_global_admin()` | public | A-rls-helper | true | boolean | true | true | true | true | `postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres` | anon+auth+service_role EXECUTE | YES - public schema exposed | 01,48 | **PASS** |
| `user_has_hospital_access(p_hospital_id uuid)` | public | A-rls-helper | true | boolean | true | true | true | true | `postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres` | anon+auth+service_role EXECUTE | YES - public schema exposed | 01,48 | **PASS** |
| `user_has_hospital_role(p_hospital_id uuid, p_roles text[])` | public | A-rls-helper | true | boolean | true | true | true | true | `postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres` | anon+auth+service_role EXECUTE | YES - public schema exposed | 01,48 | **PASS** |
| `auto_create_booking_fee_policy()` | public | B-trigger | true | trigger | true | true | true | true | `=X/postgres postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres` | untouched by design; not API-exposable | NO - returns trigger (PGRST202 proven) | 28 | **PASS** |
| `auto_create_cancellation_policy()` | public | B-trigger | true | trigger | true | true | true | true | `=X/postgres postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres` | untouched by design; not API-exposable | NO - returns trigger (PGRST202 proven) | 29 | **PASS** |
| `auto_create_collection_entry()` | public | B-trigger | true | trigger | true | true | true | true | `=X/postgres postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres` | untouched by design; not API-exposable | NO - returns trigger (PGRST202 proven) | 07 | **PASS** |
| `auto_create_hospital_settings()` | public | B-trigger | true | trigger | true | true | true | true | `=X/postgres postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres` | untouched by design; not API-exposable | NO - returns trigger (PGRST202 proven) | 12 | **PASS** |
| `auto_create_trial_subscription()` | public | B-trigger | true | trigger | true | true | true | true | `=X/postgres postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres` | untouched by design; not API-exposable | NO - returns trigger (PGRST202 proven) | 32 | **PASS** |
| `capture_cancellation_policy_history()` | public | B-trigger | true | trigger | true | true | true | true | `=X/postgres postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres` | untouched by design; not API-exposable | NO - returns trigger (PGRST202 proven) | 29 | **PASS** |
| `version_feature_flag()` | public | B-trigger | true | trigger | true | true | true | true | `=X/postgres postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres` | untouched by design; not API-exposable | NO - returns trigger (PGRST202 proven) | 18 | **PASS** |
| `version_hospital_settings()` | public | B-trigger | true | trigger | true | true | true | true | `=X/postgres postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres` | untouched by design; not API-exposable | NO - returns trigger (PGRST202 proven) | 18 | **PASS** |
| `version_system_settings()` | public | B-trigger | true | trigger | true | true | true | true | `=X/postgres postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres` | untouched by design; not API-exposable | NO - returns trigger (PGRST202 proven) | 18 | **PASS** |
| `write_booking_ledger_entries()` | public | B-trigger | true | trigger | true | true | true | true | `=X/postgres postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres` | untouched by design; not API-exposable | NO - returns trigger (PGRST202 proven) | 13 | **PASS** |
| `acknowledge_alert(p_alert_id uuid, p_actor_id uuid)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47,48 | **PASS** |
| `advance_queue(p_queue_session_id uuid)` | public | B/C/D-locked | true | integer | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 02,43 | **PASS** |
| `assign_alert(p_alert_id uuid, p_assignee_id uuid, p_actor_id uuid)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47,48 | **PASS** |
| `calculate_refund_amount(p_booking_id uuid, p_cancellation_time timestamp with time zone)` | public | B/C/D-locked | true | TABLE(refund_amount numeric, refund_percentage numeric, refund_reason text, is_eligible boolean) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 29,48 | **PASS** |
| `call_queue_token(p_queue_session_id uuid, p_token_number integer, p_actor_id uuid)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 43 | **PASS** |
| `capture_payment(p_gateway_order_id text, p_gateway_payment_id text, p_gateway_signature text, p_gateway_response jsonb)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 13,34,48 | **PASS** |
| `capture_payment(p_gateway_order_id text, p_gateway_payment_id text, p_gateway_signature text, p_gateway_response jsonb, p_gateway_fee_inr numeric)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 13,34,48 | **PASS** |
| `carry_forward_pending_tokens(p_hospital_id uuid, p_from_date date, p_to_date date)` | public | B/C/D-locked | true | integer | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 38 | **PASS** |
| `change_subscription_plan(p_hospital_id uuid, p_new_plan_name text, p_billing_cycle billing_cycle, p_performed_by uuid)` | public | B/C/D-locked | true | uuid | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 32,48 | **PASS** |
| `check_booking_rate_limit(p_hospital_id uuid, p_phone text, p_window_minutes integer, p_max_attempts integer)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 09 | **PASS** |
| `check_partition_readiness()` | public | B/C/D-locked | true | TABLE(table_name text, estimated_rows bigint, threshold_value integer, threshold_reached boolean, auto_enabled boolean, action_recommended text) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 15,22 | **PASS** |
| `claim_idempotency_key(p_key text, p_endpoint text, p_hospital_id uuid, p_user_id uuid, p_request_hash text, p_request_summary jsonb, p_instance_id text)` | public | B/C/D-locked | true | TABLE(is_new boolean, status idempotency_status, response_status_code integer, response_body jsonb, mismatch_detected boolean) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 25 | **PASS** |
| `claim_jobs(p_worker_id text, p_job_types text[], p_batch_size integer, p_lease_minutes integer)` | public | B/C/D-locked | true | SETOF job_queue | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 06 | **PASS** |
| `claim_jobs_v2(p_worker_id text, p_job_types text[], p_batch_size integer)` | public | B/C/D-locked | true | SETOF job_queue | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 19 | **PASS** |
| `claim_webhook_event(p_provider webhook_provider, p_event_types text[], p_batch_size integer)` | public | B/C/D-locked | true | SETOF webhook_events | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 16 | **PASS** |
| `cleanup_expired_restrictions()` | public | B/C/D-locked | true | integer | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 09 | **PASS** |
| `cleanup_idempotency_keys()` | public | B/C/D-locked | true | integer | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 25 | **PASS** |
| `cleanup_operational_data()` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 23,41 | **PASS** |
| `cleanup_stale_presence()` | public | B/C/D-locked | true | integer | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 11,20 | **PASS** |
| `cleanup_stale_presence(p_batch_size integer)` | public | B/C/D-locked | true | integer | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 11,20 | **PASS** |
| `clear_doctor_delay(p_queue_session_id uuid, p_actor_id uuid)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 45 | **PASS** |
| `close_doctor_session(p_queue_session_id uuid, p_actor_id uuid, p_reason text)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 46 | **PASS** |
| `complete_consultation(p_queue_session_id uuid, p_booking_id uuid, p_actor_id uuid)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 46 | **PASS** |
| `complete_idempotency_key(p_key text, p_endpoint text, p_response_code integer, p_response_body jsonb, p_response_headers jsonb)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 25 | **PASS** |
| `complete_job(p_job_id uuid)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 06 | **PASS** |
| `complete_job_v2(p_job_id uuid, p_worker_id text)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 19 | **PASS** |
| `complete_webhook_event(p_event_id uuid)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 16 | **PASS** |
| `compute_global_metrics(p_report_date date)` | public | B/C/D-locked | true | void | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 21,48 | **PASS** |
| `compute_sla_tracking(p_hospital_id uuid, p_date date)` | public | B/C/D-locked | true | void | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 38 | **PASS** |
| `compute_weekly_rollup(p_hospital_id uuid, p_week_start date)` | public | B/C/D-locked | true | void | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 21,43 | **PASS** |
| `confirm_refund_processed(p_refund_id uuid, p_gateway_refund_id text, p_gateway_response jsonb)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 13,41,48 | **PASS** |
| `create_booking(p_hospital_id uuid, p_queue_session_id uuid, p_patient_id uuid, p_patient_name text, p_patient_phone text, p_patient_age integer, p_patient_gender text, p_village text, p_blood_group text, p_has_diabetes boolean, p_has_bp boolean, p_booking_source booking_source, p_doctor_id uuid, p_booked_by uuid, p_appointment_date date, p_platform_fee numeric, p_receptionist_fee numeric, p_hospital_fee numeric, p_idempotency_key text)` | public | B/C/D-locked | true | TABLE(booking_id uuid, token_number integer) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 02,39 | **PASS** |
| `create_hospital_settlement(p_hospital_id uuid, p_start_date date, p_end_date date, p_collected_by uuid)` | public | B/C/D-locked | true | uuid | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 07,33,48 | **PASS** |
| `create_platform_revenue_summary(p_hospital_id uuid, p_start_date date, p_end_date date, p_performed_by uuid)` | public | B/C/D-locked | true | uuid | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 33,48 | **PASS** |
| `current_user_has_permission(p_hospital_id uuid, p_permission text)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 27,48 | **PASS** |
| `detect_crashed_workers()` | public | B/C/D-locked | true | TABLE(crashed_worker_id text, worker_type text, last_seen timestamp with time zone) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 19 | **PASS** |
| `enqueue_job(p_job_type text, p_payload jsonb, p_priority job_priority, p_scheduled_at timestamp with time zone, p_idempotency_key text, p_hospital_id uuid, p_booking_id uuid, p_metadata jsonb)` | public | B/C/D-locked | true | uuid | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 06 | **PASS** |
| `escalate_alert(p_alert_id uuid, p_actor_id uuid, p_notes text)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47,48 | **PASS** |
| `estimate_wait_minutes(p_queue_session_id uuid, p_token_number integer)` | public | B/C/D-locked | true | integer | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 03 | **PASS** |
| `evaluate_queue_health()` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 45 | **PASS** |
| `expire_conversation_states()` | public | B/C/D-locked | true | integer | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 42 | **PASS** |
| `expire_stale_device_sessions(p_inactive_days integer)` | public | B/C/D-locked | true | integer | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 30 | **PASS** |
| `extend_job_lease(p_job_id uuid, p_worker_id text, p_extend_seconds integer)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 19 | **PASS** |
| `fail_idempotency_key(p_key text, p_endpoint text, p_error_code text, p_error_message text, p_response_code integer)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 25 | **PASS** |
| `fail_job(p_job_id uuid, p_error text)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 06 | **PASS** |
| `fail_job_v2(p_job_id uuid, p_worker_id text, p_error text)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 19 | **PASS** |
| `fail_migration(p_migration_id text, p_error text, p_applied_by text)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 26 | **PASS** |
| `fail_webhook_event(p_event_id uuid, p_error text)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 16 | **PASS** |
| `fetch_pending_notifications(p_limit integer)` | public | B/C/D-locked | true | SETOF notification_queue | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 05 | **PASS** |
| `fetch_pending_whatsapp_messages(p_limit integer)` | public | B/C/D-locked | true | SETOF whatsapp_messages | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 04 | **PASS** |
| `find_or_create_whatsapp_conversation(p_hospital_id uuid, p_patient_id uuid, p_phone text)` | public | B/C/D-locked | true | uuid | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 04 | **PASS** |
| `fire_alert(p_hospital_id uuid, p_alert_key text, p_severity alert_severity_level, p_current_value numeric, p_threshold_value numeric, p_threshold_unit text, p_message text)` | public | B/C/D-locked | true | uuid | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 24 | **PASS** |
| `fire_managed_alert(p_hospital_id uuid, p_alert_key text, p_severity alert_severity_level, p_current_value numeric, p_threshold_value numeric, p_threshold_unit text, p_message text, p_category text)` | public | B/C/D-locked | true | uuid | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47 | **PASS** |
| `generate_audit_log_partition_ddl(p_months integer)` | public | B/C/D-locked | true | text | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 15,48 | **PASS** |
| `generate_booking_partition_ddl(p_months integer)` | public | B/C/D-locked | true | text | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 15 | **PASS** |
| `generate_executive_report(p_report_type text, p_hospital_id uuid, p_from_date date, p_to_date date)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47,48,49 | **PASS** |
| `generate_next_token(p_hospital_id uuid, p_visit_date date)` | public | B/C/D-locked | true | integer | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 02 | **PASS** |
| `generate_partition_ddl(p_parent_table text, p_month date)` | public | B/C/D-locked | true | text | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 22 | **PASS** |
| `generate_wa_messages_partition_ddl(p_months integer)` | public | B/C/D-locked | true | text | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 15 | **PASS** |
| `get_alert_analytics(p_hospital_id uuid, p_from_date date, p_to_date date)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47 | **PASS** |
| `get_alert_center(p_hospital_id uuid, p_status text, p_severity text, p_category text, p_limit integer)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47 | **PASS** |
| `get_audit_coverage_report(p_hospital_id uuid, p_from_date date, p_to_date date)` | public | B/C/D-locked | true | TABLE(action_type text, category text, default_severity text, logged_count bigint, last_logged_at timestamp with time zone, has_coverage boolean) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 36,48 | **PASS** |
| `get_booking_fee(p_hospital_id uuid, p_booking_source booking_source)` | public | B/C/D-locked | true | TABLE(booking_fee numeric, gst_amount numeric, total_fee numeric, consultation_fee numeric, collect_consultation_at_hospital boolean) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 28,48 | **PASS** |
| `get_conversation_state(p_hospital_id uuid, p_phone text)` | public | B/C/D-locked | true | SETOF whatsapp_conversation_states | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 42 | **PASS** |
| `get_cross_hospital_benchmarks(p_from_date date, p_to_date date)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47,48 | **PASS** |
| `get_daily_operations_dashboard(p_hospital_id uuid, p_date date)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47 | **PASS** |
| `get_dlq_summary()` | public | B/C/D-locked | true | TABLE(source dead_letter_source, unresolved_count bigint, critical_count bigint, oldest_item_at timestamp with time zone) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 14 | **PASS** |
| `get_doctor_availability_reason(p_doctor_id uuid, p_hospital_id uuid, p_date date)` | public | B/C/D-locked | true | TABLE(is_available boolean, reason text) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 31 | **PASS** |
| `get_doctor_dashboard(p_doctor_id uuid, p_hospital_id uuid)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 46 | **PASS** |
| `get_doctor_performance(p_doctor_id uuid, p_hospital_id uuid, p_from_date date, p_to_date date)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47 | **PASS** |
| `get_doctor_rankings(p_hospital_id uuid, p_from_date date, p_to_date date)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47 | **PASS** |
| `get_doctor_unavailable_dates(p_doctor_id uuid, p_hospital_id uuid, p_from_date date, p_to_date date)` | public | B/C/D-locked | true | TABLE(unavailable_date date, reason text) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 31 | **PASS** |
| `get_effective_fees(p_hospital_id uuid, p_booking_source booking_source)` | public | B/C/D-locked | true | TABLE(platform_fee numeric, receptionist_fee numeric, hospital_fee numeric, total_amount numeric) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 12,35,48 | **PASS** |
| `get_financial_command_center(p_hospital_id uuid, p_date date)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47,48,49 | **PASS** |
| `get_hospital_command_center(p_hospital_id uuid, p_date date)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47 | **PASS** |
| `get_hospital_feature_flags(p_hospital_id uuid)` | public | B/C/D-locked | true | TABLE(flag_key text, display_name text, description text, is_enabled boolean, is_override boolean) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 37 | **PASS** |
| `get_hospital_timeline(p_hospital_id uuid, p_from_ts timestamp with time zone, p_to_ts timestamp with time zone, p_event_types text[], p_severity text, p_doctor_id uuid, p_queue_session_id uuid, p_limit integer)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47,49 | **PASS** |
| `get_monthly_dashboard(p_hospital_id uuid, p_month_start date)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47 | **PASS** |
| `get_operational_scores(p_hospital_id uuid, p_date date)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47 | **PASS** |
| `get_partition_health()` | public | B/C/D-locked | true | TABLE(partition_name text, parent_table text, range_start text, range_end text, state partition_state, actual_rows bigint, size_pretty text) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 22 | **PASS** |
| `get_partition_maintenance_advice()` | public | B/C/D-locked | true | TABLE(table_name text, recommendation text, estimated_rows bigint) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 15 | **PASS** |
| `get_platform_revenue_breakdown(p_hospital_id uuid, p_from_date date, p_to_date date)` | public | B/C/D-locked | true | TABLE(total_collected numeric, gateway_fees numeric, gst_collected numeric, refunds_issued numeric, net_setura_revenue numeric, booking_count integer, paid_booking_count integer) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 34,48 | **PASS** |
| `get_portfolio_dashboard(p_date date)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47,48 | **PASS** |
| `get_predictive_insights(p_hospital_id uuid, p_date date)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47 | **PASS** |
| `get_queue_config(p_hospital_id uuid, p_doctor_id uuid, p_config_key text)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 12 | **PASS** |
| `get_queue_snapshot(p_queue_session_id uuid)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 43,45 | **PASS** |
| `get_reconciliation_summary(p_hospital_id uuid, p_from_date date, p_to_date date)` | public | B/C/D-locked | true | TABLE(total_collected numeric, platform_fee_total numeric, receptionist_fee_total numeric, total_refunded numeric, total_settled numeric, net_outstanding numeric, booking_count integer, paid_booking_count integer) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 13,48 | **PASS** |
| `get_remaining_token_capacity(p_doctor_id uuid, p_hospital_id uuid, p_date date)` | public | B/C/D-locked | true | integer | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 03 | **PASS** |
| `get_retention_report()` | public | B/C/D-locked | true | TABLE(table_name text, retention_days integer, hard_delete_after_days integer, legal_basis text) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 23 | **PASS** |
| `get_revenue_forecast(p_hospital_id uuid, p_date date)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47,48 | **PASS** |
| `get_sla_dashboard(p_hospital_id uuid, p_date date)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47 | **PASS** |
| `get_subscription_limits(p_hospital_id uuid)` | public | B/C/D-locked | true | TABLE(max_doctors integer, max_receptionists integer, max_bookings_per_month integer, current_doctor_count integer, current_receptionist_count integer, current_month_bookings integer, subscription_status text, plan_name text, expires_at timestamp with time zone, is_active boolean) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 32,48 | **PASS** |
| `get_subscription_usage(p_hospital_id uuid)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 40,48 | **PASS** |
| `get_user_permissions(p_hospital_id uuid)` | public | B/C/D-locked | true | text[] | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 27,48 | **PASS** |
| `get_weekly_dashboard(p_hospital_id uuid, p_week_start date)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47 | **PASS** |
| `handle_whatsapp_delivery_status(p_meta_message_id text, p_status whatsapp_message_status, p_payload jsonb)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 04 | **PASS** |
| `has_permission(p_user_id uuid, p_hospital_id uuid, p_permission text)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 27,48 | **PASS** |
| `idempotent_capture_payment(p_provider_event_id text, p_payload_hash text, p_raw_payload jsonb, p_gateway_order_id text, p_gateway_payment_id text, p_gateway_signature text)` | public | B/C/D-locked | true | TABLE(success boolean, was_duplicate boolean, message text) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 16,48 | **PASS** |
| `idempotent_create_booking(p_client_request_id text, p_hospital_id uuid, p_queue_session_id uuid, p_patient_id uuid, p_patient_name text, p_patient_phone text, p_patient_age integer, p_patient_gender text, p_village text, p_blood_group text, p_has_diabetes boolean, p_has_bp boolean, p_booking_source booking_source, p_doctor_id uuid, p_booked_by uuid, p_appointment_date date)` | public | B/C/D-locked | true | TABLE(booking_id uuid, token_number integer, was_duplicate boolean) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 16 | **PASS** |
| `increment_abuse_score(p_hospital_id uuid, p_phone text, p_device_identifier text, p_ip_address inet, p_score integer)` | public | B/C/D-locked | true | integer | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 09 | **PASS** |
| `initiate_refund(p_booking_id uuid, p_refund_amount_inr numeric, p_refund_reason text, p_initiated_by uuid)` | public | B/C/D-locked | true | uuid | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 13,48 | **PASS** |
| `insert_emergency_patient(p_queue_session_id uuid, p_patient_name text, p_patient_phone text, p_reason text, p_actor_id uuid, p_idempotency_key text)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 46 | **PASS** |
| `is_doctor_available(p_doctor_id uuid, p_hospital_id uuid, p_date date)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 03,31 | **PASS** |
| `is_feature_enabled(p_hospital_id uuid, p_flag_key text)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 12 | **PASS** |
| `is_phone_blocked(p_hospital_id uuid, p_phone text)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 09 | **PASS** |
| `is_subscription_active(p_hospital_id uuid)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 32,48 | **PASS** |
| `log_booking_attempt(p_hospital_id uuid, p_phone text, p_ip_address inet, p_device_identifier text, p_success boolean, p_metadata jsonb)` | public | B/C/D-locked | true | void | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 09 | **PASS** |
| `log_security_event(p_hospital_id uuid, p_user_id uuid, p_event_type security_event_type, p_event_details jsonb, p_risk_score integer, p_ip_address inet, p_user_agent text, p_event_fingerprint text)` | public | B/C/D-locked | true | uuid | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 10 | **PASS** |
| `mark_doctor_delay(p_queue_session_id uuid, p_minutes integer, p_reason text, p_actor_id uuid)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 45 | **PASS** |
| `mark_notification_sent(p_notification_id uuid, p_provider_response jsonb)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 05 | **PASS** |
| `mark_patient_absent(p_queue_session_id uuid, p_booking_id uuid, p_actor_id uuid)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 43 | **PASS** |
| `open_doctor_session(p_hospital_id uuid, p_doctor_id uuid, p_session_date date, p_max_tokens integer, p_actor_id uuid)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 46 | **PASS** |
| `pause_queue(p_queue_session_id uuid, p_reason text, p_actor_id uuid)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 43 | **PASS** |
| `plan_partitions(p_parent_table text, p_months_ahead integer, p_start_month date)` | public | B/C/D-locked | true | TABLE(partition_name text, range_start text, state partition_state) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 22 | **PASS** |
| `presence_heartbeat(p_hospital_id uuid, p_role user_role_type, p_channel presence_channel, p_tab_id text, p_metadata jsonb)` | public | B/C/D-locked | true | TABLE(active_users integer, active_receptionists integer, hospital_is_online boolean) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 20 | **PASS** |
| `presence_leave(p_hospital_id uuid, p_channel presence_channel, p_tab_id text)` | public | B/C/D-locked | true | void | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 20 | **PASS** |
| `queue_notification(p_hospital_id uuid, p_patient_id uuid, p_booking_id uuid, p_channel notification_channel, p_priority notification_priority, p_recipient text, p_template_key text, p_title text, p_message_body text, p_scheduled_for timestamp with time zone, p_idempotency_key text, p_metadata jsonb)` | public | B/C/D-locked | true | uuid | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 05 | **PASS** |
| `queue_whatsapp_message(p_hospital_id uuid, p_patient_id uuid, p_booking_id uuid, p_phone text, p_template_name text, p_message_text text, p_idempotency_key text)` | public | B/C/D-locked | true | uuid | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 04 | **PASS** |
| `recalculate_queue_position(p_booking_id uuid)` | public | B/C/D-locked | true | void | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 39 | **PASS** |
| `recall_current_token(p_queue_session_id uuid, p_actor_id uuid)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 43 | **PASS** |
| `reclaim_crashed_worker_jobs()` | public | B/C/D-locked | true | integer | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 19 | **PASS** |
| `reclaim_stale_jobs(p_timeout_minutes integer)` | public | B/C/D-locked | true | integer | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 06 | **PASS** |
| `reclaim_stale_whatsapp_processing(p_stale_minutes integer)` | public | B/C/D-locked | true | integer | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 41 | **PASS** |
| `recompute_hospital_online_state(p_hospital_id uuid)` | public | B/C/D-locked | true | void | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 20 | **PASS** |
| `record_incoming_whatsapp_message(p_hospital_id uuid, p_phone text, p_meta_message_id text, p_text text, p_patient_name text)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 42 | **PASS** |
| `record_queue_event(p_queue_session_id uuid, p_event_type text, p_token_number integer, p_booking_id uuid, p_actor_id uuid, p_metadata jsonb)` | public | B/C/D-locked | true | uuid | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 43 | **PASS** |
| `record_settlement_payment(p_settlement_id uuid, p_paid_amount numeric, p_performed_by uuid)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 07,33,48 | **PASS** |
| `record_subscription_usage(p_hospital_id uuid, p_metric text, p_increment integer)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 40,48 | **PASS** |
| `refresh_analytics_views()` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 08 | **PASS** |
| `refresh_analytics_views_ordered()` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 17 | **PASS** |
| `refresh_outstanding_balance(p_hospital_id uuid)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 07 | **PASS** |
| `refresh_single_mv(p_view_name text)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 17 | **PASS** |
| `register_migration(p_migration_id text, p_filename text, p_description text, p_category text, p_depends_on text[], p_version text, p_duration_ms integer, p_checksum text, p_is_reversible boolean, p_rollback_script text, p_applied_by text)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 26 | **PASS** |
| `register_webhook_event(p_webhook_event_id text, p_event_type text, p_payload jsonb)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 04 | **PASS** |
| `register_webhook_event_v2(p_provider webhook_provider, p_provider_event_id text, p_event_type text, p_payload_hash text, p_raw_payload jsonb, p_hospital_id uuid)` | public | B/C/D-locked | true | TABLE(is_new boolean, event_id uuid) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 16 | **PASS** |
| `register_worker(p_worker_id text, p_worker_type text, p_instance_id text, p_hostname text, p_lease_duration integer)` | public | B/C/D-locked | true | worker_registry | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 19 | **PASS** |
| `reset_stale_idempotency_keys(p_stuck_minutes integer)` | public | B/C/D-locked | true | integer | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 25 | **PASS** |
| `resolve_alert(p_alert_id uuid, p_actor_id uuid, p_notes text)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47,48 | **PASS** |
| `resolve_alert_threshold(p_hospital_id uuid, p_alert_key text, p_fallback numeric)` | public | B/C/D-locked | true | numeric | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 45 | **PASS** |
| `resolve_security_event(p_event_id uuid, p_resolved_by uuid, p_notes text)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 10 | **PASS** |
| `restore_queue_token(p_queue_session_id uuid, p_booking_id uuid, p_actor_id uuid)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 43 | **PASS** |
| `resume_queue(p_queue_session_id uuid, p_actor_id uuid)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 43 | **PASS** |
| `retry_dead_letter_item(p_dlq_id uuid, p_resolved_by uuid)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 14 | **PASS** |
| `return_to_waiting(p_queue_session_id uuid, p_booking_id uuid, p_actor_id uuid)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 46 | **PASS** |
| `rollback_feature_flag(p_hospital_id uuid, p_flag_key text, p_target_version integer, p_rolled_back_by uuid, p_reason text)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 18 | **PASS** |
| `rollback_system_setting(p_key text, p_target_version integer, p_rolled_back_by uuid, p_reason text)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 18 | **PASS** |
| `run_analytics_rollups(p_target_date date)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 21 | **PASS** |
| `run_health_check()` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 24 | **PASS** |
| `run_nightly_tasks(p_hospital_id uuid)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 11,17 | **PASS** |
| `run_retention_cleanup()` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 23,41 | **PASS** |
| `run_scheduled_tasks()` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 11,17 | **PASS** |
| `run_worker_crash_recovery()` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 19 | **PASS** |
| `save_consultation_note(p_booking_id uuid, p_doctor_id uuid, p_notes text, p_diagnosis_summary text, p_prescription jsonb, p_follow_up_date date, p_attachments jsonb)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 46 | **PASS** |
| `schedule_notification_retry(p_notification_id uuid, p_error text)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 05 | **PASS** |
| `schedule_partition_creation()` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 22 | **PASS** |
| `schedule_whatsapp_retry(p_message_id uuid, p_error text)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 04 | **PASS** |
| `search_audit_logs(p_hospital_id uuid, p_actor_id uuid, p_entity_type text, p_action_type text, p_from_ts timestamp with time zone, p_to_ts timestamp with time zone, p_correlation_id text, p_limit integer)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47,48 | **PASS** |
| `send_to_dead_letter(p_source dead_letter_source, p_source_id uuid, p_source_table text, p_job_type text, p_hospital_id uuid, p_booking_id uuid, p_patient_id uuid, p_attempt_count integer, p_last_error text, p_payload jsonb, p_priority text)` | public | B/C/D-locked | true | uuid | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 14 | **PASS** |
| `set_conversation_state(p_hospital_id uuid, p_phone text, p_state text, p_context jsonb, p_ttl_minutes integer, p_last_intent text, p_unknown_count integer, p_handoff_reason text)` | public | B/C/D-locked | true | uuid | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 42 | **PASS** |
| `skip_queue_token(p_queue_session_id uuid, p_booking_id uuid, p_actor_id uuid)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 43 | **PASS** |
| `soft_delete_aged_messages()` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 23 | **PASS** |
| `start_consultation(p_queue_session_id uuid, p_booking_id uuid, p_actor_id uuid)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 46 | **PASS** |
| `stop_worker(p_worker_id text, p_drain boolean)` | public | B/C/D-locked | true | void | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 39 | **PASS** |
| `suppress_alerts(p_alert_key text, p_active_until timestamp with time zone, p_actor_id uuid, p_hospital_id uuid, p_reason text)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47,48 | **PASS** |
| `sync_subscription_usage(p_hospital_id uuid)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 40,48 | **PASS** |
| `take_deployment_snapshot(p_label text, p_created_by text)` | public | B/C/D-locked | true | uuid | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 26 | **PASS** |
| `terminate_device_session(p_session_id uuid, p_user_id uuid)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 30 | **PASS** |
| `trigger_sla_refresh(p_hospital_id uuid, p_date date)` | public | B/C/D-locked | true | uuid | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 43 | **PASS** |
| `try_fire_queue_alert(p_hospital_id uuid, p_queue_session_id uuid, p_alert_key text, p_severity alert_severity_level, p_current_value numeric, p_threshold_value numeric, p_threshold_unit text, p_message text)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 45 | **PASS** |
| `upsert_device_session(p_user_id uuid, p_hospital_id uuid, p_device_name text, p_device_type text, p_ip_address inet, p_user_agent text, p_session_token_hash text)` | public | B/C/D-locked | true | uuid | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 30 | **PASS** |
| `upsert_presence(p_hospital_id uuid, p_tab_id text, p_metadata jsonb)` | public | B/C/D-locked | true | void | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 11 | **PASS** |
| `verify_audit_integrity(p_hospital_id uuid, p_from_ts timestamp with time zone)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47,48 | **PASS** |
| `verify_doctor_operations_integrity(p_doctor_id uuid, p_date date)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47 | **PASS** |
| `verify_integration_matrix(p_hospital_id uuid, p_date date)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47 | **PASS** |
| `verify_queue_integrity(p_queue_session_id uuid)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47 | **PASS** |
| `verify_settlement_integrity(p_hospital_id uuid)` | public | B/C/D-locked | true | jsonb | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47,48 | **PASS** |
| `worker_heartbeat(p_worker_id text, p_jobs_in_flight integer, p_metadata jsonb)` | public | B/C/D-locked | true | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 19 | **PASS** |
| `write_audit_log(p_hospital_id uuid, p_actor_id uuid, p_entity_type text, p_entity_id uuid, p_action text, p_severity audit_action_severity, p_old_data jsonb, p_new_data jsonb, p_notes text, p_metadata jsonb)` | public | B/C/D-locked | true | uuid | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 10,36,39,48 | **PASS** |
| `write_queue_metrics_snapshot()` | public | B/C/D-locked | true | void | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 17 | **PASS** |
| `check_queue_backlog_alerts(p_pending_threshold integer, p_age_threshold_minutes integer)` | public | INV-other | false | TABLE(queue_type text, alert_reason text, pending_count bigint, oldest_age interval) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 17,48 | **PASS** |
| `compute_health_score(p_critical_alerts integer, p_warning_alerts integer, p_crashed_workers integer)` | public | INV-other | false | integer | true | true | true | true | `=X/postgres postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres` | anon YES (documented pure helper) | YES - public schema exposed | 24 | **PASS** |
| `find_duplicate_patient_candidates(p_hospital_id uuid, p_similarity double precision)` | public | INV-other | false | TABLE(patient_a_id uuid, patient_b_id uuid, phone_a text, phone_b text, name_a text, name_b text, name_similarity double precision) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 11,48 | **PASS** |
| `forecast_queue_depth(p_hospital_id uuid, p_date date)` | public | INV-other | false | TABLE(doctor_id uuid, booked_count integer, max_capacity integer, capacity_pct numeric, avg_wait_minutes numeric) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 11,48 | **PASS** |
| `get_mv_refresh_health()` | public | INV-other | false | TABLE(view_name text, last_refresh timestamp with time zone, duration_ms integer, last_success boolean, row_count bigint, is_stale boolean) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 17,48 | **PASS** |
| `get_partition_name(p_parent_table text, p_month date)` | public | INV-other | false | text | true | true | true | true | `=X/postgres postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres` | anon YES (documented pure helper) | YES - public schema exposed | 22 | **PASS** |
| `get_queue_health()` | public | INV-other | false | TABLE(queue_type text, pending_count bigint, processing_count bigint, failed_count bigint, dead_count bigint, oldest_pending_age interval, avg_attempts numeric, throughput_last_hour bigint) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 17,48 | **PASS** |
| `get_stuck_jobs(p_stuck_threshold_minutes integer)` | public | INV-other | false | TABLE(job_id uuid, job_type text, hospital_id uuid, worker_id text, processing_started timestamp with time zone, stuck_for interval, attempt_count integer, payload jsonb) | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 17,48 | **PASS** |
| `is_alert_suppressed(p_hospital_id uuid, p_alert_key text)` | public | INV-other | false | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47,48 | **PASS** |
| `is_hospital_online(p_hospital_id uuid)` | public | INV-other | false | boolean | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 11,48 | **PASS** |
| `log_alert_activity(p_alert_id uuid, p_hospital_id uuid, p_actor_id uuid, p_action text, p_notes text)` | public | INV-other | false | void | false | false | true | true | `postgres=X/postgres service_role=X/postgres` | anon NO / auth NO / service_role YES | YES - public schema exposed | 47,48 | **PASS** |
| `normalize_phone_number(p_phone text)` | public | INV-other | false | text | true | true | true | true | `=X/postgres postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres` | anon YES (documented pure helper) | YES - public schema exposed | 09 | **PASS** |
| `handle_booking_status_change()` | public | INV-trigger | false | trigger | true | true | true | true | `=X/postgres postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres` | untouched by design; not API-exposable | NO - returns trigger (PGRST202 proven) | 02 | **PASS** |
| `prevent_audit_log_modification()` | public | INV-trigger | false | trigger | true | true | true | true | `=X/postgres postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres` | untouched by design; not API-exposable | NO - returns trigger (PGRST202 proven) | 10 | **PASS** |
| `prevent_config_version_mutation()` | public | INV-trigger | false | trigger | true | true | true | true | `=X/postgres postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres` | untouched by design; not API-exposable | NO - returns trigger (PGRST202 proven) | 18 | **PASS** |
| `prevent_consultation_note_mutation()` | public | INV-trigger | false | trigger | true | true | true | true | `=X/postgres postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres` | untouched by design; not API-exposable | NO - returns trigger (PGRST202 proven) | 46 | **PASS** |
| `prevent_hospital_id_update()` | public | INV-trigger | false | trigger | true | true | true | true | `=X/postgres postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres` | untouched by design; not API-exposable | NO - returns trigger (PGRST202 proven) | 01,02,03,04,05,06,07,11,12,13,14,16,42,43 | **PASS** |
| `prevent_immutable_row_modification()` | public | INV-trigger | false | trigger | true | true | true | true | `=X/postgres postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres` | untouched by design; not API-exposable | NO - returns trigger (PGRST202 proven) | 32 | **PASS** |
| `prevent_ledger_mutation()` | public | INV-trigger | false | trigger | true | true | true | true | `=X/postgres postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres` | untouched by design; not API-exposable | NO - returns trigger (PGRST202 proven) | 13 | **PASS** |
| `set_updated_at()` | public | INV-trigger | false | trigger | true | true | true | true | `=X/postgres postgres=X/postgres anon=X/postgres authenticated=X/postgres service_role=X/postgres` | untouched by design; not API-exposable | NO - returns trigger (PGRST202 proven) | 01,02,03,04,05,06,07,09,11,12,13,14,15,16,20,23,24,26,27,28,29,30,31,32,42 | **PASS** |

---

## Appendix B — All 266 extension-owned routines in schema `public` (NOT ASSESSED)

Listed in full so that the exclusion is auditable. These are owned by `citext`,
`pg_trgm`, `btree_gist`, `pgcrypto` and related extensions
(`pg_depend.deptype = 'e'`). Migration 48 §6 records the reason for leaving them
alone: revoking EXECUTE "breaks index operator support and ordinary column
operations for non-superuser roles"
([48_privilege_hardening.sql:753-756](supabase/migrations/48_privilege_hardening.sql#L753-L756)).
They are not SETURA routines and carry no SETURA business logic. `anon` holds
EXECUTE on all 266 — this is stock Supabase posture, unchanged by this project,
and is reported rather than scored.

| Routine | Schema | Class | SecDef | Returns | anon | auth | service_role | postgres | Actual `proacl` | Expected | API-callable | Source | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `cash_dist(money, money)` | public | EXT-extension | false | money | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `citext(boolean)` | public | EXT-extension | false | citext | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `citext(character)` | public | EXT-extension | false | citext | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `citext(inet)` | public | EXT-extension | false | citext | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `citext_cmp(citext, citext)` | public | EXT-extension | false | integer | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `citext_eq(citext, citext)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `citext_ge(citext, citext)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `citext_gt(citext, citext)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `citext_hash(citext)` | public | EXT-extension | false | integer | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `citext_hash_extended(citext, bigint)` | public | EXT-extension | false | bigint | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `citext_larger(citext, citext)` | public | EXT-extension | false | citext | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `citext_le(citext, citext)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `citext_lt(citext, citext)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `citext_ne(citext, citext)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `citext_pattern_cmp(citext, citext)` | public | EXT-extension | false | integer | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `citext_pattern_ge(citext, citext)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `citext_pattern_gt(citext, citext)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `citext_pattern_le(citext, citext)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `citext_pattern_lt(citext, citext)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `citext_smaller(citext, citext)` | public | EXT-extension | false | citext | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `citextin(cstring)` | public | EXT-extension | false | citext | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `citextout(citext)` | public | EXT-extension | false | cstring | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `citextrecv(internal)` | public | EXT-extension | false | citext | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `citextsend(citext)` | public | EXT-extension | false | bytea | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `date_dist(date, date)` | public | EXT-extension | false | integer | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `float4_dist(real, real)` | public | EXT-extension | false | real | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `float8_dist(double precision, double precision)` | public | EXT-extension | false | double precision | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_bit_compress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_bit_consistent(internal, bit, smallint, oid, internal)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_bit_penalty(internal, internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_bit_picksplit(internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_bit_same(gbtreekey_var, gbtreekey_var, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_bit_union(internal, internal)` | public | EXT-extension | false | gbtreekey_var | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_bool_compress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_bool_consistent(internal, boolean, smallint, oid, internal)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_bool_fetch(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_bool_penalty(internal, internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_bool_picksplit(internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_bool_same(gbtreekey2, gbtreekey2, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_bool_union(internal, internal)` | public | EXT-extension | false | gbtreekey2 | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_bpchar_compress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_bpchar_consistent(internal, character, smallint, oid, internal)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_bytea_compress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_bytea_consistent(internal, bytea, smallint, oid, internal)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_bytea_penalty(internal, internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_bytea_picksplit(internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_bytea_same(gbtreekey_var, gbtreekey_var, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_bytea_union(internal, internal)` | public | EXT-extension | false | gbtreekey_var | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_cash_compress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_cash_consistent(internal, money, smallint, oid, internal)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_cash_distance(internal, money, smallint, oid, internal)` | public | EXT-extension | false | double precision | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_cash_fetch(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_cash_penalty(internal, internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_cash_picksplit(internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_cash_same(gbtreekey16, gbtreekey16, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_cash_union(internal, internal)` | public | EXT-extension | false | gbtreekey16 | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_date_compress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_date_consistent(internal, date, smallint, oid, internal)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_date_distance(internal, date, smallint, oid, internal)` | public | EXT-extension | false | double precision | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_date_fetch(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_date_penalty(internal, internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_date_picksplit(internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_date_same(gbtreekey8, gbtreekey8, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_date_union(internal, internal)` | public | EXT-extension | false | gbtreekey8 | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_decompress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_enum_compress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_enum_consistent(internal, anyenum, smallint, oid, internal)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_enum_fetch(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_enum_penalty(internal, internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_enum_picksplit(internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_enum_same(gbtreekey8, gbtreekey8, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_enum_union(internal, internal)` | public | EXT-extension | false | gbtreekey8 | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_float4_compress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_float4_consistent(internal, real, smallint, oid, internal)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_float4_distance(internal, real, smallint, oid, internal)` | public | EXT-extension | false | double precision | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_float4_fetch(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_float4_penalty(internal, internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_float4_picksplit(internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_float4_same(gbtreekey8, gbtreekey8, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_float4_union(internal, internal)` | public | EXT-extension | false | gbtreekey8 | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_float8_compress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_float8_consistent(internal, double precision, smallint, oid, internal)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_float8_distance(internal, double precision, smallint, oid, internal)` | public | EXT-extension | false | double precision | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_float8_fetch(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_float8_penalty(internal, internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_float8_picksplit(internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_float8_same(gbtreekey16, gbtreekey16, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_float8_union(internal, internal)` | public | EXT-extension | false | gbtreekey16 | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_inet_compress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_inet_consistent(internal, inet, smallint, oid, internal)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_inet_penalty(internal, internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_inet_picksplit(internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_inet_same(gbtreekey16, gbtreekey16, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_inet_union(internal, internal)` | public | EXT-extension | false | gbtreekey16 | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_int2_compress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_int2_consistent(internal, smallint, smallint, oid, internal)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_int2_distance(internal, smallint, smallint, oid, internal)` | public | EXT-extension | false | double precision | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_int2_fetch(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_int2_penalty(internal, internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_int2_picksplit(internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_int2_same(gbtreekey4, gbtreekey4, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_int2_union(internal, internal)` | public | EXT-extension | false | gbtreekey4 | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_int4_compress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_int4_consistent(internal, integer, smallint, oid, internal)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_int4_distance(internal, integer, smallint, oid, internal)` | public | EXT-extension | false | double precision | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_int4_fetch(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_int4_penalty(internal, internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_int4_picksplit(internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_int4_same(gbtreekey8, gbtreekey8, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_int4_union(internal, internal)` | public | EXT-extension | false | gbtreekey8 | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_int8_compress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_int8_consistent(internal, bigint, smallint, oid, internal)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_int8_distance(internal, bigint, smallint, oid, internal)` | public | EXT-extension | false | double precision | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_int8_fetch(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_int8_penalty(internal, internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_int8_picksplit(internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_int8_same(gbtreekey16, gbtreekey16, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_int8_union(internal, internal)` | public | EXT-extension | false | gbtreekey16 | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_intv_compress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_intv_consistent(internal, interval, smallint, oid, internal)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_intv_decompress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_intv_distance(internal, interval, smallint, oid, internal)` | public | EXT-extension | false | double precision | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_intv_fetch(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_intv_penalty(internal, internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_intv_picksplit(internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_intv_same(gbtreekey32, gbtreekey32, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_intv_union(internal, internal)` | public | EXT-extension | false | gbtreekey32 | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_macad8_compress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_macad8_consistent(internal, macaddr8, smallint, oid, internal)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_macad8_fetch(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_macad8_penalty(internal, internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_macad8_picksplit(internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_macad8_same(gbtreekey16, gbtreekey16, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_macad8_union(internal, internal)` | public | EXT-extension | false | gbtreekey16 | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_macad_compress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_macad_consistent(internal, macaddr, smallint, oid, internal)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_macad_fetch(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_macad_penalty(internal, internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_macad_picksplit(internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_macad_same(gbtreekey16, gbtreekey16, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_macad_union(internal, internal)` | public | EXT-extension | false | gbtreekey16 | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_numeric_compress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_numeric_consistent(internal, numeric, smallint, oid, internal)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_numeric_penalty(internal, internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_numeric_picksplit(internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_numeric_same(gbtreekey_var, gbtreekey_var, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_numeric_union(internal, internal)` | public | EXT-extension | false | gbtreekey_var | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_oid_compress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_oid_consistent(internal, oid, smallint, oid, internal)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_oid_distance(internal, oid, smallint, oid, internal)` | public | EXT-extension | false | double precision | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_oid_fetch(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_oid_penalty(internal, internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_oid_picksplit(internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_oid_same(gbtreekey8, gbtreekey8, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_oid_union(internal, internal)` | public | EXT-extension | false | gbtreekey8 | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_text_compress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_text_consistent(internal, text, smallint, oid, internal)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_text_penalty(internal, internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_text_picksplit(internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_text_same(gbtreekey_var, gbtreekey_var, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_text_union(internal, internal)` | public | EXT-extension | false | gbtreekey_var | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_time_compress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_time_consistent(internal, time without time zone, smallint, oid, internal)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_time_distance(internal, time without time zone, smallint, oid, internal)` | public | EXT-extension | false | double precision | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_time_fetch(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_time_penalty(internal, internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_time_picksplit(internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_time_same(gbtreekey16, gbtreekey16, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_time_union(internal, internal)` | public | EXT-extension | false | gbtreekey16 | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_timetz_compress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_timetz_consistent(internal, time with time zone, smallint, oid, internal)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_ts_compress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_ts_consistent(internal, timestamp without time zone, smallint, oid, internal)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_ts_distance(internal, timestamp without time zone, smallint, oid, internal)` | public | EXT-extension | false | double precision | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_ts_fetch(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_ts_penalty(internal, internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_ts_picksplit(internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_ts_same(gbtreekey16, gbtreekey16, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_ts_union(internal, internal)` | public | EXT-extension | false | gbtreekey16 | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_tstz_compress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_tstz_consistent(internal, timestamp with time zone, smallint, oid, internal)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_tstz_distance(internal, timestamp with time zone, smallint, oid, internal)` | public | EXT-extension | false | double precision | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_uuid_compress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_uuid_consistent(internal, uuid, smallint, oid, internal)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_uuid_fetch(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_uuid_penalty(internal, internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_uuid_picksplit(internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_uuid_same(gbtreekey32, gbtreekey32, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_uuid_union(internal, internal)` | public | EXT-extension | false | gbtreekey32 | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_var_decompress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbt_var_fetch(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbtreekey16_in(cstring)` | public | EXT-extension | false | gbtreekey16 | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbtreekey16_out(gbtreekey16)` | public | EXT-extension | false | cstring | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbtreekey2_in(cstring)` | public | EXT-extension | false | gbtreekey2 | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbtreekey2_out(gbtreekey2)` | public | EXT-extension | false | cstring | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbtreekey32_in(cstring)` | public | EXT-extension | false | gbtreekey32 | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbtreekey32_out(gbtreekey32)` | public | EXT-extension | false | cstring | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbtreekey4_in(cstring)` | public | EXT-extension | false | gbtreekey4 | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbtreekey4_out(gbtreekey4)` | public | EXT-extension | false | cstring | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbtreekey8_in(cstring)` | public | EXT-extension | false | gbtreekey8 | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbtreekey8_out(gbtreekey8)` | public | EXT-extension | false | cstring | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbtreekey_var_in(cstring)` | public | EXT-extension | false | gbtreekey_var | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gbtreekey_var_out(gbtreekey_var)` | public | EXT-extension | false | cstring | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gin_extract_query_trgm(text, internal, smallint, internal, internal, internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gin_extract_value_trgm(text, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gin_trgm_consistent(internal, smallint, text, integer, internal, internal, internal, internal)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gin_trgm_triconsistent(internal, smallint, text, integer, internal, internal, internal)` | public | EXT-extension | false | "char" | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gtrgm_compress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gtrgm_consistent(internal, text, smallint, oid, internal)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gtrgm_decompress(internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gtrgm_distance(internal, text, smallint, oid, internal)` | public | EXT-extension | false | double precision | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gtrgm_in(cstring)` | public | EXT-extension | false | gtrgm | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gtrgm_options(internal)` | public | EXT-extension | false | void | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gtrgm_out(gtrgm)` | public | EXT-extension | false | cstring | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gtrgm_penalty(internal, internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gtrgm_picksplit(internal, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gtrgm_same(gtrgm, gtrgm, internal)` | public | EXT-extension | false | internal | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `gtrgm_union(internal, internal)` | public | EXT-extension | false | gtrgm | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `int2_dist(smallint, smallint)` | public | EXT-extension | false | smallint | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `int4_dist(integer, integer)` | public | EXT-extension | false | integer | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `int8_dist(bigint, bigint)` | public | EXT-extension | false | bigint | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `interval_dist(interval, interval)` | public | EXT-extension | false | interval | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `max(citext)` | public | EXT-extension | false | citext | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `min(citext)` | public | EXT-extension | false | citext | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `oid_dist(oid, oid)` | public | EXT-extension | false | oid | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `regexp_match(citext, citext)` | public | EXT-extension | false | text[] | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `regexp_match(citext, citext, text)` | public | EXT-extension | false | text[] | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `regexp_matches(citext, citext)` | public | EXT-extension | false | SETOF text[] | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `regexp_matches(citext, citext, text)` | public | EXT-extension | false | SETOF text[] | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `regexp_replace(citext, citext, text)` | public | EXT-extension | false | text | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `regexp_replace(citext, citext, text, text)` | public | EXT-extension | false | text | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `regexp_split_to_array(citext, citext)` | public | EXT-extension | false | text[] | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `regexp_split_to_array(citext, citext, text)` | public | EXT-extension | false | text[] | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `regexp_split_to_table(citext, citext)` | public | EXT-extension | false | SETOF text | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `regexp_split_to_table(citext, citext, text)` | public | EXT-extension | false | SETOF text | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `replace(citext, citext, citext)` | public | EXT-extension | false | text | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `set_limit(real)` | public | EXT-extension | false | real | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `show_limit()` | public | EXT-extension | false | real | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `show_trgm(text)` | public | EXT-extension | false | text[] | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `similarity(text, text)` | public | EXT-extension | false | real | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `similarity_dist(text, text)` | public | EXT-extension | false | real | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `similarity_op(text, text)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `split_part(citext, citext, integer)` | public | EXT-extension | false | text | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `strict_word_similarity(text, text)` | public | EXT-extension | false | real | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `strict_word_similarity_commutator_op(text, text)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `strict_word_similarity_dist_commutator_op(text, text)` | public | EXT-extension | false | real | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `strict_word_similarity_dist_op(text, text)` | public | EXT-extension | false | real | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `strict_word_similarity_op(text, text)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `strpos(citext, citext)` | public | EXT-extension | false | integer | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `texticlike(citext, citext)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `texticlike(citext, text)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `texticnlike(citext, citext)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `texticnlike(citext, text)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `texticregexeq(citext, citext)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `texticregexeq(citext, text)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `texticregexne(citext, citext)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `texticregexne(citext, text)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `time_dist(time without time zone, time without time zone)` | public | EXT-extension | false | interval | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `translate(citext, citext, text)` | public | EXT-extension | false | text | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `ts_dist(timestamp without time zone, timestamp without time zone)` | public | EXT-extension | false | interval | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `tstz_dist(timestamp with time zone, timestamp with time zone)` | public | EXT-extension | false | interval | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `word_similarity(text, text)` | public | EXT-extension | false | real | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `word_similarity_commutator_op(text, text)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `word_similarity_dist_commutator_op(text, text)` | public | EXT-extension | false | real | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `word_similarity_dist_op(text, text)` | public | EXT-extension | false | real | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |
| `word_similarity_op(text, text)` | public | EXT-extension | false | boolean | true | true | true | true | `=X/supabase_admin supabase_admin=X/supabase_admin postgres=X/supabase_admin anon=X/supabase_admin authenticated=X/supabase_admin service_role=X/supabase_admin` | out of scope - deliberately untouched | n/a - extension-owned | n/a | **NOT ASSESSED** |

---

## Appendix C — Verdict tally

| Population | Rows | PASS | FAIL | NOT ASSESSED |
|---|---|---|---|---|
| Appendix A — SETURA-owned | 213 | **213** | **0** | 0 |
| Appendix B — extension-owned | 266 | 0 | 0 | 266 |
| **Total** | **479** | **213** | **0** | **266** |

Zero FAIL rows across both appendices.

**Gate 2 outcome: P1-11 VERIFIED — PASS (local stack). One new latent defect
recorded as `F16-04`. No code, migration, privilege or configuration was modified
by this gate.**

---

## Appendix D — Supplementary evidence for two suspended certification claims

Gate 2 was scoped to P1-11, but the catalog access it required also resolves two
`CERTIFICATION_RECONCILIATION.md` §8.2 entries that were suspended or qualified
solely for want of a live database. Recorded here as evidence; the certification
restatement itself belongs to Gate 8.

### D.1 The trigger-function unreachability claim is now proven on both halves

§8.2 claim 17 records disclosure 2 — *"Ten trigger-returning routines retain `anon`
`EXECUTE` … unreachable — PostgreSQL raises `0A000` on a direct call and PostgREST
does not expose them"* — as **UPHELD WITH QUALIFICATION**, because *"Confirming
PostgREST non-exposure requires a live instance."*

Both halves were executed:

**Half 1 — direct SQL call raises `0A000`.** Captured SQLSTATE, not inferred from
the message text:

```sql
DO $$ BEGIN
  BEGIN PERFORM public.write_booking_ledger_entries();
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'SQLSTATE=% MESSAGE=%', SQLSTATE, SQLERRM;
  END;
END $$;
```

```
NOTICE:  SQLSTATE=0A000 MESSAGE=trigger functions can only be called as triggers
```

The same call as `SET LOCAL ROLE anon` inside a rolled-back transaction produced the
identical error. The cited code `0A000` is exact.

**Half 2 — PostgREST does not expose them.** §4.1: role-independent `PGRST202`, with
`service_role` refused identically to `anon`.

Both halves hold. The qualification that kept claim 17 from full `UPHELD` is
discharged.

### D.2 The "off by two" routine count was a unit mismatch, not an error

§8.2 claim 8 records the Phase 1.5 classification total of **193** as **WITHDRAWN
(sub-claim: the number)**, against an *"Independent recount: 191 unique routines …
the total is off by two."*

Measured against the live catalog, for SECURITY DEFINER, non-extension-owned
routines in schema `public`:

```
secdef_nonext_public_total=193
distinct_names=191
overloaded_names=capture_payment(2), cleanup_stale_presence(2)
```

Both numbers are correct measurements of different units. **193** is the count of
*routines* (distinct signatures); **191** is the count of *distinct names*. The gap
is exactly the two overloaded names, `capture_payment` and `cleanup_stale_presence`,
each existing at two signatures — `193 − 191 = 2`.

This also reconciles independently with §3 of this document:
`A-rls-helper (4) + B/C/D-locked (179) + B-trigger (10) = 193`, which is precisely
the A / B / B-trigger / C / D classification universe the Phase 1.5 report used.

The Phase 1.5 report's **193** is therefore correct as a routine count, and the
audit's recount was correct as a name count. Neither made an arithmetic error;
the two were counting different things and the discrepancy has an exact,
enumerable cause. **Gate 8 should reconsider the WITHDRAWN verdict on claim 8 in
light of this evidence.** Gate 2 does not restate certification outcomes itself.

Note that this does not disturb §19.3 item 2's narrowed figure of *"179 of 193"* —
§3 measures exactly **179** routines in the locked set, confirming that number too.
