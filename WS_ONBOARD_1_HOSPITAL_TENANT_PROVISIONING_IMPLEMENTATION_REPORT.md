# WS-ONBOARD-1 — Hospital Tenant Provisioning — Implementation Report

## 1. Executive summary

WS-ONBOARD-1 is **implemented** on the existing SETURA architecture. A
`global_admin` can now create a new, working hospital tenant entirely from the
SETURA UI — no SQL, no seed editing, no environment changes, no developer
intervention.

The flow follows the canonical shape:

```
Global Admin UI (form → review → confirm)
  → provision-hospital Edge Function
    → resolveAuth() (JWT-authoritative actor)
    → requireRole(["global_admin"])
    → Idempotency-Key gate (existing api_idempotency_keys registry)
    → provision_hospital SECURITY DEFINER RPC (migration 65)
      → DB-layer global_admin re-check
      → atomic hospitals INSERT (existing trigger creates hospital_settings)
    → best-effort audit event (existing audit system)
    → server-authoritative response (hospital id / name / slug)
```

Nothing was redesigned. The RPC reuses the existing `hospitals` table, the
existing `auto_create_hospital_settings()` trigger (migration 12), the existing
`api_idempotency_keys` registry (migration 25), the existing audit engine
(`write_audit_log`), the existing Edge primitives (`getServiceClient`,
`resolveAuth`, `requireRole`, `handleCors`, `successResponse`,
`handleErrorResponse`, the `SeturError` hierarchy), and the existing frontend
transport (`callFunction`, `useAsyncAction`, `RequireRole`, `AppShell`).

**Verification achieved (local, real stack):**
- Backend RPC: **INTEGRATION VERIFIED** locally — 11/11 DB tests pass.
- Edge HTTP path: **INTEGRATION VERIFIED** locally — 8/8 HTTP tests pass against a
  live Edge runtime.
- Frontend: **UNIT VERIFIED** — 12/12 vitest cases pass; `tsc --noEmit` clean.
- Production: **UNPROVEN** (no deployment exists).

Scope is WS-ONBOARD-1 only. WS-ONBOARD-2 (settings editor) and WS-ONBOARD-3
(Razorpay / Meta credentials) are **NOT** implemented and remain possible.

---

## 2. Files changed

**Created**
- `supabase/migrations/65_hospital_tenant_provisioning.sql` — canonical
  `provision_hospital` RPC + privileges + audit action type registration.
- `supabase/functions/provision-hospital/index.ts` — the Edge Function.
- `apps/web/src/api/onboarding.ts` — frontend wrapper (`provisionHospital`).
- `apps/web/src/routes/HospitalOnboarding.tsx` — onboarding route/form UI.
- `tests/integration/hospital_provisioning.test.ts` — DB/RPC integration suite.
- `tests/integration/hospital_provisioning_http.test.ts` — Edge HTTP suite.
- `apps/web/src/routes/HospitalOnboarding.test.tsx` — frontend vitest.
- `WS_ONBOARD_1_HOSPITAL_TENANT_PROVISIONING_IMPLEMENTATION_REPORT.md` — this file.

**Modified**
- `apps/web/src/types/api.ts` — added `ProvisionHospitalResponseBody`.
- `apps/web/src/App.tsx` — `/admin/onboarding` route under `GLOBAL_ADMIN_ROLES`.
- `apps/web/src/components/AppShell.tsx` — `global_admin` nav entry.
- `supabase/functions/_shared/audit.ts` — added `"hospital_provision"` to the
  `AuditActionType` union (shared primitive; additive, see §6/§10 proof).
- `supabase/functions/_shared/database.generated.ts` — regenerated via the
  canonical `deno task gen:types` (now includes `provision_hospital`).
- `supabase/migrations/MANIFEST.sha256` — appended the 65 hash via the canonical
  `--update` process (append-only; history untouched).

No already-applied migration was edited. No closed workstream was reopened.

---

## 3. Database changes

Migration `65_hospital_tenant_provisioning.sql`:

- **RPC** `public.provision_hospital(p_actor_user_id UUID, p_name TEXT, p_slug
  TEXT, p_phone, p_email, p_country, p_state, p_district, p_town, p_address,
  p_timezone TEXT DEFAULT NULL) RETURNS JSONB`, `LANGUAGE plpgsql`, `VOLATILE`,
  `SECURITY DEFINER`, `SET search_path = public`, and
  `ALTER FUNCTION ... SET row_security = off`.
- **DB-layer authorization:** refuses `p_actor_user_id IS NULL` or an id that
  does not hold `global_admin` in `user_roles`, raising SQLSTATE `42501`. This is
  defense-in-depth: `auth.uid()` is NULL under the service-role JWT, so the
  (JWT-authoritative) Edge layer passes the actor id explicitly and the RPC
  re-verifies it.
- **Validation / normalization:** trims name, lowercases slug; blank name or
  blank slug → SQLSTATE `22023`; slug must match
  `^[a-z0-9]+(?:-[a-z0-9]+)*$` or → `22023`.
- **Duplicate protection:** pre-check for an existing slug → `23505`, plus an
  `EXCEPTION WHEN unique_violation` handler around the INSERT → `23505`, closing
  the check-insert race against `hospitals.slug` (UNIQUE).
- **Atomic tenant creation:** a single `INSERT INTO public.hospitals(...)` with
  `RETURNING id`. NOT-NULL columns with table defaults fall back via
  `coalesce(nullif(...))` to `India` / `Andhra Pradesh` / `Narsapur` /
  `Asia/Kolkata`. The existing `trg_auto_hospital_settings` AFTER-INSERT trigger
  (migration 12) creates the `hospital_settings` default row in the same
  transaction — a tenant is never half-created, and a rolled-back provision
  leaves no partial row.
- **Returns** `jsonb_build_object('ok', true, 'reason', 'created',
  'hospital_id', v_id, 'name', v_name, 'slug', v_slug)`.
- **Privileges (F16-04 standing rule):** a NEW SECURITY DEFINER function gets
  its own explicit `REVOKE ALL ... FROM PUBLIC / anon / authenticated` and
  `GRANT EXECUTE ... TO service_role` only. Catalog verification on the local DB:
  `has_function_privilege('anon', ...)=false`, `('authenticated', ...)=false`,
  `('service_role', ...)=true`.
- **No fake identities / no per-hospital `feature_flags` rows** — flags resolve
  global defaults via the existing LEFT JOIN (migration 37). Razorpay/Meta
  credentials are out of scope.
- **Audit registration:** `INSERT INTO audit_action_types (...) VALUES
  ('hospital_provision','Hospital Provision','high','system', ...)` with
  `ON CONFLICT DO NOTHING`. (`category` uses the allowed value `system`, not a
  non-existent `admin`.)

Design notes: the file is pure ASCII (validate:migrations rejects non-ASCII; the
box-drawing/em-dash comment characters were normalized and the file re-validated
to 0 errors, 4 pre-existing baseline `[duplicate-objects]` warnings only).

---

## 4. Backend changes

**Edge Function** `supabase/functions/provision-hospital/index.ts`
(`Deno.serve`, `ENDPOINT = "provision-hospital"`):

1. `handleCors(req)`, then `405` for non-POST.
2. Trace / request logger / metrics created.
3. `resolveAuth(req, null, logger)` — tenant-free global action; the
   `X-Hospital-ID` header is neither read nor trusted for a create.
4. `requireRole(auth, ["global_admin"])`.
5. `extractIdempotencyKey(req, true)` — a UUID-v4 `Idempotency-Key` header is
   mandatory.
6. `parseBody(req, Schema)` — Zod limits: name 2..200, slug 2..96 + regex,
   optional phone ≤20, email ≤254, country/state/district/town ≤120,
   address ≤500, timezone ≤64.
7. `withIdempotency(key, ENDPOINT, auth.userId, /*hospitalId*/ null, body,
   instanceId, logger, handler)` — the existing registry; `hospitalId` is `null`
   because the target tenant does not exist yet.
8. Handler calls `db.rpc("provision_hospital", { p_actor_user_id: auth.userId,
   ... })`; on `error`, maps SQLSTATE → the correct class (see §7); requires
   `outcome.ok === true && outcome.hospital_id` else `InternalError`.
9. `logAuditEvent(...)` inside the handler (so a replay never double-audits).
10. Returns `{ statusCode: 201, body: { hospitalId, name, slug, created: true } }`
    via `successResponse(..., result.statusCode)`.
11. `catch → handleErrorResponse` (client-safe envelope, no SQL/stack/secret
    leakage).

**API contract.** Request body: `{ name, slug, phone?, email?, country?, state?,
district?, town?, address?, timezone? }`. Response `data` (201):
`{ hospitalId, name, slug, created }`. Errors use the standard
`{ success:false, error:{ code, message } }` envelope. No secrets returned.

---

## 5. Frontend changes

- `apps/web/src/api/onboarding.ts` — `provisionHospital(actingHospitalId,
  idempotencyKey, input)` → `callFunction("provision-hospital", body, {
  hospitalId: actingHospitalId, idempotencyKey })`; blanks are omitted so the
  server default applies.
- `apps/web/src/routes/HospitalOnboarding.tsx` — a **form → review → confirm →
  provisioning → success** surface for `global_admin`. Exports pure helpers used
  by tests: `slugify`, `validateOnboarding` (mirrors the exact backend limits),
  `toProvisionInput`. Uses `useAsyncAction` (stable idempotency key per logical
  action + in-flight double-submit swallow; the button disables while running).
  Success renders the **server-returned** name / slug / hospital ID; a rejection
  renders the honest client-safe message via `describeError`. The next-step
  text ("configure settings and add doctors/staff") does not pretend
  WS-ONBOARD-2/3 exist.
- `apps/web/src/App.tsx` — `/admin/onboarding` wrapped in
  `<RequireRole roles={[...GLOBAL_ADMIN_ROLES]}>` (UX boundary; the backend
  re-authorizes regardless).
- `apps/web/src/components/AppShell.tsx` — nav entry `Hospital Onboarding`
  visible to `global_admin` only.

**Acting-context disclosure:** the shared `callFunction` transport requires a
hospital id in the `X-Hospital-ID` header. This endpoint ignores that header for
authorization/tenancy, but the page reuses the established
`fetchActingHospitalContext` (G-08 / C2b precedent) purely to satisfy the
transport rather than modify the shared primitive (AGENTS §6). It is disclosed
in the UI. If no hospital exists at all, the page shows an honest
"waiting for a request context" state. This is a known consequence of reusing
the existing transport unchanged.

---

## 6. Security

- **Two-boundary authorization.** Edge: `resolveAuth` + `requireRole(
  ["global_admin"])`. DB: the RPC re-checks `global_admin` in `user_roles`
  (`42501`) and is `service_role`-EXECUTE-only. Proven: HTTP 403 for a valid
  non-admin JWT (`ROLE_INSUFFICIENT`), HTTP 401 unauthenticated, DB `42501` for a
  non-admin/NULL actor, and `permission denied` for `anon` / `authenticated`
  direct RPC calls.
- **Privilege boundary (F16-04).** Explicit `REVOKE` from PUBLIC/anon/
  authenticated + `GRANT` to service_role; catalog ACL verified on the local DB
  (`anon=false`, `authenticated=false`, `service_role=true`).
- **Multi-tenancy.** Provisioning is a global administrative create; no
  client-supplied hospital id drives tenancy. The new hospital id comes only
  from the server. Existing RLS/`FORCE ROW LEVEL SECURITY` on `hospitals` is
  preserved; the RPC runs as owner with `row_security=off` by design.
- **Secrets.** No service-role key, Razorpay/Meta secret or credential appears
  in any frontend file. `check:frontend-secrets` gate applies (see §10).
- **Shared-primitive safety.** `audit.ts` was changed only by adding one union
  member (`"hospital_provision"`) — purely additive; the `privilege_isolation`
  suite (25/25) and peer HTTP suites still pass, proving existing behavior is
  intact.

---

## 7. Idempotency / concurrency

Three distinct mechanisms, all existing:

1. **Request replay** (same `Idempotency-Key`, same body) — the existing
   `api_idempotency_keys` registry (`withIdempotency`) returns the **stored**
   result; the second call does not re-run the RPC and does not re-audit. Proven:
   HTTP replay test — same `hospitalId` returned, exactly **one** `hospitals` row
   for the slug, exactly **one** audit row.
2. **Duplicate identity** (a distinct request reusing an existing slug) is
   treated as a **collision, not a silent success**: pre-check / unique_violation
   → `23505` → HTTP `409` `DB_CONSTRAINT_VIOLATION`. Proven in both DB and HTTP
   suites.
3. **Concurrency** — `hospitals.slug` UNIQUE + the RPC's `unique_violation`
   handler. Proven by the DB suite's **parallel** `Promise.all` test: two truly
   concurrent same-slug provisions produce exactly **one** created + **one**
   `23505`, and a count query confirms exactly one row.

Double-submit at the UI is additionally swallowed by `useAsyncAction`'s in-flight
guard (button disabled while running), but the backend is what actually prevents
a duplicate tenant.

Error mapping (no secret/SQL/stack leakage):
`42501 → ForbiddenError`, `23505 → SeturError("...","DB_CONSTRAINT_VIOLATION",
409)`, `22023 → ValidationError`, body-schema failure → Zod `422`, missing key →
`IDEMPOTENCY_KEY_REQUIRED` `400`, unauthenticated → `401`, unexpected →
`InternalError` `500`.

---

## 8. Audit

On a successful provision the Edge layer emits one best-effort audit event
through the existing `logAuditEvent` → `write_audit_log` path:

- `action_type`: `hospital_provision` (registered as category `system`,
  default severity `high`).
- `entity_type`: `hospital`; `entity_id`: the new hospital id;
  `hospital_id`: the new hospital id; `actor_user_id`: the resolved global_admin.
- `severity`: `high`; `old_data`: null; `new_data`: `{ name, slug }`.

The audit call lives **inside** the idempotency handler, so a replayed key does
not double-record the event (proven by the HTTP replay test: exactly one audit
row). `logAuditEvent` never throws (existing best-effort-after-commit pattern
preserved).

---

## 9. Tests

Backend suites ran against the **real local Supabase stack** (DB up; Edge runtime
started via `supabase functions serve` for the HTTP suite). Frontend suite ran
under vitest (jsdom) with the wrapper/auth mocked at the module boundary.

### DB / RPC — `tests/integration/hospital_provisioning.test.ts` (11/11 PASS)

| Test | Result | Verification level |
|---|---|---|
| setup fixture actors (global_admin + hospital_admin) | PASS | INTEGRATION (local) |
| provision creates hospital row + auto hospital_settings | PASS | INTEGRATION (local) |
| anon cannot EXECUTE provision_hospital (permission denied) | PASS | INTEGRATION (local) |
| authenticated (even hospital_admin) cannot EXECUTE | PASS | INTEGRATION (local) |
| RPC refuses a non-global_admin actor (42501) | PASS | INTEGRATION (local) |
| RPC refuses a NULL actor (42501) | PASS | INTEGRATION (local) |
| duplicate slug → 23505, no second row | PASS | INTEGRATION (local) |
| concurrent same-slug → exactly one tenant | PASS | INTEGRATION (local) |
| malformed slug → 22023, no partial row | PASS | INTEGRATION (local) |
| empty name → 22023, no partial row | PASS | INTEGRATION (local) |
| audit_action_types registers hospital_provision | PASS | INTEGRATION (local) |

### Edge HTTP — `tests/integration/hospital_provisioning_http.test.ts` (8/8 PASS)

| Test | Result | Verification level |
|---|---|---|
| setup global_admin + hospital_admin fixtures | PASS | INTEGRATION (local) |
| global_admin provisions a tenant (201), settings + audit land | PASS | INTEGRATION (local) |
| replay same Idempotency-Key → stored tenant, no duplicate | PASS | INTEGRATION (local) |
| missing Idempotency-Key → 400 | PASS | INTEGRATION (local) |
| hospital_admin (wrong role) → 403 ROLE_INSUFFICIENT | PASS | INTEGRATION (local) |
| unauthenticated → 401 | PASS | INTEGRATION (local) |
| distinct request reusing existing slug → 409 | PASS | INTEGRATION (local) |
| invalid slug → 422 VALIDATION_ERROR | PASS | INTEGRATION (local) |

### Frontend — `apps/web/src/routes/HospitalOnboarding.test.tsx` (12/12 PASS)

| Test | Result | Verification level |
|---|---|---|
| slugify: lowercase + hyphenate + trim | PASS | UNIT |
| slugify: collapse separators / strip ends | PASS | UNIT |
| slugify: caps length at 96 | PASS | UNIT |
| validateOnboarding: requires name + slug | PASS | UNIT |
| validateOnboarding: accepts valid minimal draft | PASS | UNIT |
| validateOnboarding: rejects non-lowercase/hyphen slug | PASS | UNIT |
| validateOnboarding: rejects malformed email, allows blank | PASS | UNIT |
| validateOnboarding: enforces length ceilings | PASS | UNIT |
| toProvisionInput: trims, lowercases slug, drops blanks | PASS | UNIT |
| hides the form from a non-global-admin (UX guard) | PASS | UNIT |
| Form → Review → submit once with normalized input; server result renders | PASS | UNIT |
| renders honest conflict error, never a fake success | PASS | UNIT |

---

## 10. Regression

Relevant existing suites run after implementation (targeted, per the spec's
allowance not to re-run every enormous suite):

| Suite / gate | Command | Result |
|---|---|---|
| Migration validation | `deno task validate:migrations` | PASS (0 errors; 4 pre-existing baseline warnings) |
| Migration manifest | `deno task validate:migration-manifest` | PASS (65 migrations, 65 lines, 0 issues) |
| Generated types check | `deno task gen:types:check` | PASS ("up to date", no drift) |
| Deno static check | `deno task check` | PASS (scripts, unit+integration tests, all Edge fns incl. new) |
| Lint | `deno task lint` | PASS (102 files, 0 problems) |
| Formatting | `deno task fmt:check` | PASS (0 unformatted) |
| Frontend secrets scan | `deno task check:frontend-secrets` | PASS (0 findings) |
| Unit tests | `deno task test` | PASS |
| Privilege isolation | `privilege_isolation.test.ts` | PASS (25/25) |
| Local stack | `local_stack.test.ts` | PASS (11/11) |
| Hospital core journey | `hospital_core_journey.test.ts` | PASS (18/18) |
| Financial command centre (peer Edge HTTP) | `financial_command_center_http.test.ts` | PASS (13/13) |
| Frontend typecheck | `tsc --noEmit` | PASS (0 errors) |
| Frontend suite | `vitest run` (all) | PASS (32 files / 441 tests) |

Closed workstreams (G-03..G-11, C2, C2b, G-UI, GEN-TYPES, G7-*, F16-*) were not
reopened; the privilege-boundary and peer-Edge suites passing is the evidence the
shared primitives remain intact.

---

## 11. Runtime limitations

Honest statement of what is and is not proven:

- **Local only.** All "INTEGRATION VERIFIED" claims are against the **local**
  Docker Supabase stack. There is **no production deployment**, so
  `provision-hospital` / `provision_hospital` are **PRODUCTION-UNPROVEN**.
- **Edge runtime had to be started manually.** The local stack's Edge Runtime
  container was not running (known F16-01 `RestartPolicy=no` behavior). The HTTP
  suite was run after starting it explicitly with `supabase functions serve`
  (which served all functions). The HTTP results are real but depend on that
  manually-started runtime.
- **Migration-history bookkeeping gap on the local DB.** Migration 65's objects
  exist in the local Docker DB (function + settings trigger + audit action type;
  `deno check`/integration tests all pass against them), but the CLI history
  table `supabase_migrations.schema_migrations` currently lists only up to `64`
  — 65 was applied to the local container directly via `psql` (see next point),
  which does not insert a CLI history row. A clean `supabase db reset` applies
  migrations in file order and records 65; `validate:migrations` passing and the
  file's well-formedness make that reset safe. This is an environment-hygiene
  note, not a product defect.
- **Disclosed incident — an earlier `supabase db push` targeted a linked remote
  project** (not the local Docker DB) during setup, so migration 65 reached that
  linked remote. The local DB was subsequently brought to the correct state by
  applying migration 65 directly via `psql`. No further remote push was performed
  from this session. This should be reconciled against that linked project before
  any deployment.
- **No real browser E2E against the live backend.** Frontend tests are
  deterministic unit/render tests with the wrapper mocked; the live end-to-end
  transport + authorization is covered by the Edge HTTP suite, not a headless
  browser run.

---

## 12. Scope confirmation

```
WS-ONBOARD-1 IMPLEMENTED
WS-ONBOARD-2 NOT IMPLEMENTED
WS-ONBOARD-3 NOT IMPLEMENTED
```

The tenant-creation design deliberately does not block the later workstreams:
`hospital_settings` defaults are created (WS-ONBOARD-2 can edit them), no fake
Razorpay/Meta credentials were stubbed (WS-ONBOARD-3 can add a real write path),
and no competing primitives were introduced.

---

## 13. Remaining next step

The next workstream is:

```
WS-ONBOARD-2 — Hospital Configuration Write Surfaces
```

It is intentionally **not** implemented in this task.
