# SETURA — STAGING AUTH TEST-ACCOUNT PROVISIONING DISCOVERY

Scope: **read-only discovery**. Determine the safest legitimate way to obtain
dedicated staging credentials for the seeded staging roles so that positive
authentication, role-capability verification, authenticated frontend testing,
cross-role authorization testing and the full hospital E2E journey can later be
run. **No code, migration, database or credential was changed in this task.**

Authority for the current blocker: `STAGING_VERIFICATION_CLOSURE_REPORT.md`
(§4b, §7) — status `STAGING PARTIALLY VERIFIED — REMAINING BLOCKERS`. The
major remaining blocker is **positive authenticated staging access**.

This note contains **NO** passwords, access tokens, service keys, private keys
or secret values. Where a secret name is referenced, only its NAME (a public
configuration fact) is stated, never its value.

---

## 1. CURRENT ACCESS (what legitimately exists right now)

| Capability | Status | Evidence |
| --- | --- | --- |
| Supabase CLI authenticated identity | PRESENT | CLI signs in via the Windows Credential Manager target `Supabase CLI:supabase`; `supabase projects list` and `supabase secrets list` both succeed without an explicit token flag. |
| Linked project | `setura-staging` | ref `gzcqasntcbqqmgsoikms`, region South Asia (Mumbai). The only SETURA project; the other listed project `PrepOS` is unrelated. **No SETURA production project exists.** |
| Elevated DB read/compute | AVAILABLE | `supabase db query --linked "<SELECT>"` runs server-side via the Management API using the CLI's stored management login. Used read-only here. |
| Project Management API permission | AVAILABLE (config/secrets scope) | `supabase secrets list --project-ref gzcqasntcbqqmgsoikms` returned the secret **names + digests**. This proves the CLI login holds project-management rights. |
| Auth Admin API (GoTrue) direct access from this environment | NOT AVAILABLE | Requires the service-role key VALUE, which is not exposed to the agent. |
| `SUPABASE_SERVICE_ROLE_KEY` value | ABSENT from local env | Not an env var, not in a local `.env` (none exists; `.gitignore` has no `.env` rule and there is no non-example `.env`). `.env.example` is placeholders only. |
| `SUPABASE_ACCESS_TOKEN` / `SUPABASE_DB_URL` env vars | ABSENT | Confirmed in the closure report §"Blocker 2 re-confirmed". |

**Decisive discovery.** `supabase secrets list` on staging returned these secret
NAMES (values withheld):

```text
ALLOWED_ORIGINS · CRON_SECRET · ENABLE_WORKER_TRIGGER · SUPABASE_ANON_KEY ·
SUPABASE_DB_URL · SUPABASE_JWKS · SUPABASE_PUBLISHABLE_KEYS ·
SUPABASE_SECRET_KEYS · SUPABASE_SERVICE_ROLE_KEY · SUPABASE_URL · WORKER_SECRET
```

Interpretation:
- A service-role key **already exists as an Edge Function secret in the staging
  vault** (`SUPABASE_SERVICE_ROLE_KEY`, and the newer `SUPABASE_SECRET_KEYS`).
  The staging Edge Functions therefore **already have legitimate Auth Admin
  capability at runtime** — `clinical-configuration` already calls
  `db.auth.admin.createUser(...)` through `getServiceClient()` (which reads
  `Env.SUPABASE_SERVICE_KEY`).
- The CLI `secrets` command lists names/digests but there is **no supported
  command to read an existing secret's value**, and there is **no
  `supabase auth` / auth-users management command group** (CLI top-level
  offers only `config`, `db`, `login`, `postgres-config`, `secrets`, `sso`).
  Therefore the CLI management login, though privileged for config/secrets,
  **cannot** legitimately create or reset an Auth user on its own.

## 2. EXISTING STAGING USERS (read-only inspection)

`auth.users` count = 5, all `email_confirmed = true`. Role mapping (from
`user_roles` joined to `hospitals`):

| email | role | hospital |
| --- | --- | --- |
| `root@setura.test` | global_admin | (platform, no hospital) |
| `admin@surya.test` | hospital_admin | Surya Hospital |
| `dr@surya.test` | doctor | Surya Hospital |
| `reception@surya.test` | receptionist | Surya Hospital (Hospital A) |
| `reception-b@surya.test` | receptionist | Sri Venkateswara Hospital (Hospital B) |

These map **exactly** to the five desired staging roles (Global Admin, Hospital
Admin, Doctor, Receptionist A, Receptionist B). They were provisioned by the
seed chain (`created_at = 2026-01-01`, fixed `…0000a1/a2/a3/a4/c1` UUIDs,
`raw_user_meta_data` has no `provisioned_by` marker). Their password hashes are
**not recoverable and the plaintext passwords are not held** in this
environment. Negative/tenant-isolation testing already used them at the DB
boundary; only the **successful-login path** is blocked.

## 3. AVAILABLE ADMINISTRATIVE MECHANISMS (surveyed, none executed)

- **Repo tooling.** Integration tests (`tests/integration/*.test.ts`) create
  throwaway users via `POST {API_URL}/auth/v1/admin/users` with a service-role
  key — but that key comes from `supabase status` of the **LOCAL** stack only.
  There is **no existing script that provisions STAGING auth users**. The
  `clinical-configuration` Edge Function does use Auth Admin `createUser` at
  runtime, but it is gated behind `resolveAuth` + `requireRole(global_admin,
  hospital_admin)` — it cannot bootstrap the first credential (chicken-and-egg).
- **Prohibited by this task and by rule:** `UPDATE auth.users` / direct
  password writes into `auth.users`. A DB connection that can execute SQL is
  **not** a legitimate Auth credential mechanism. Not to be used.

## 4. OPTIONS

### OPTION A — Existing authorized administrative mechanism (CLI management login)
- **What already exists:** the CLI login has project-management rights (proven
  by `secrets list`) and elevated DB read/compute.
- **Can it create/reset staging Auth users safely?** **NO.** There is no CLI
  auth-user command, no way to read the vault secret value through the CLI, and
  the CLI's DB access must not be used to write `auth.users`.
- **Verdict:** not sufficient on its own. Rejected as a standalone path.

### OPTION B — Supabase Dashboard / Auth administration (owner-driven, no key exposure)
- **What the owner does:** sign in to the Supabase Dashboard for
  `setura-staging` → **Authentication → Users**.
- **Supported:** *Create new user* with an email + chosen password (auto
  confirmed, no SMTP needed). *Delete user*. *Send password-recovery email* to
  an existing user — **but this last one requires SMTP to be configured on the
  project, which is UNPROVEN here**.
- **Reuse of the existing 5 seeded users via the Dashboard alone:** only the
  email-reset path applies, which depends on SMTP. Without confirmed SMTP the
  Dashboard cannot set a KNOWN password for an EXISTING user.
- **Info the owner gives the agent afterward:** the emails and which role each
  maps to (NOT a secret in Git; used only transiently in a controlled browser
  session). If new users are created, the agent must then attach
  profile/`user_roles` rows for the fresh UUIDs (app-layer writes), since the
  existing correct role bindings belong to the seeded UUIDs.

### OPTION C — Authorized service-key / Auth-Admin provisioning of the EXISTING users
- **Authorization required:** the owner explicitly authorizes a one-time Auth
  Admin password reset of the 5 seeded staging users, and provides the staging
  **service-role key VALUE** out-of-band (Dashboard → Project Settings → API
  Keys → `secret`/service key). The key already exists in the vault; this only
  surfaces its value to a controlled operation.
- **Where the key is stored / how used:** loaded ONLY as a transient
  process-environment variable for a single short-lived admin call against the
  proper GoTrue endpoint `PUT /auth/v1/admin/users/{id}` with a `password` body.
  NEVER written to a file, NEVER echoed, NEVER committed, NEVER logged.
- **How leakage is prevented:** value passed by the owner through a secure
  out-of-band channel; the agent applies it via the Auth Admin API only (not
  SQL), then the owner may **rotate** the key afterward. `.gitignore` has no
  rule that would accidentally capture a runtime env var (none is persisted).
- **Preferable to Dashboard?** For **reusing the already-correct seeded roles
  without SMTP dependency**, yes: it sets a known password on the existing
  users (fixed roles, confirmed emails) with zero app-layer churn and zero code
  change. The trade-off is that a powerful, RLS-bypassing key is handled —
  acceptable ONLY for staging (separate project; no production project exists),
  only out-of-band, and only with post-use rotation offered.

### OPTION D — Dedicated NEW staging test identities
- **When better:** if the owner prefers not to reuse the seeded identities at
  all, or wants clean-separable test accounts.
- **Advantages:** obvious test-only accounts; easy, unambiguous cleanup (delete
  them); no reuse of seed artifacts.
- **Disadvantages / requirements:** each new user needs a fresh `profiles` +
  `user_roles` binding for its new UUID (the seeded role rows are keyed to the
  seeded UUIDs). Creation itself is legitimate via Dashboard (no SMTP) or via
  Auth Admin `createUser`; role attachment is normal app-layer provisioning.
- **Cleanup:** delete the created auth users and their `user_roles`/`profiles`
  rows when the journey testing concludes.

## 5. RECOMMENDATION

```text
RECOMMENDED OPTION:
OPTION C — Owner-authorized, one-time Auth Admin password reset of the 5
EXISTING seeded staging users via the proper GoTrue endpoint
(PUT /auth/v1/admin/users/{id}), using the service-role key supplied strictly
out-of-band.

WHY:
The 5 seeded users already carry the EXACT target roles and are already
email-confirmed, so resetting their passwords (through the legitimate Supabase
Auth Admin mechanism, NOT UPDATE auth.users) unlocks positive login, token
refresh, the requireRole capability matrix and the full E2E journey with zero
app-layer re-binding and NO code change. The service-role key already exists in
the staging vault; this only needs its value for one controlled, transient
operation. Unlike the Dashboard email-reset path, it does NOT depend on
unconfirmed SMTP. Staging is a standalone project (no production project
exists), so exposure risk is bounded and the key can be rotated afterward.

OWNER ACTION REQUIRED:
1. In the Supabase Dashboard for setura-staging, retrieve the service-role /
   secret key value.
2. Provide it to the engineering agent strictly OUT-OF-BAND (a secure channel,
   NOT pasted into the repo, a report, or terminal history), and explicitly
   authorize: "reset the 5 seeded staging users to a dedicated staging
   password via the Auth Admin API."
3. Supply (or approve) the single dedicated staging password to set.
4. Optionally rotate the key after the operation.

ENGINEERING ACTION AFTER OWNER ACTION:
Load the key ONLY as a transient env var; call the Auth Admin API to set the
dedicated password on the 5 existing users; verify a successful password-grant
login per role; then run the role capability matrix, authenticated frontend
walkthrough, cross-role authorization tests and the hospital E2E journey.
Never persist or print the key. Do NOT touch production, Razorpay, Meta/WhatsApp,
RLS, or the auth architecture.
```

**Lower-privilege alternative (preferred if SMTP is confirmed working, or if the
owner will not expose the key at all):** OPTION B/D — the owner creates the
credentials entirely inside the Dashboard so the service key never leaves it.
This is strictly safer on key-exposure but requires either confirmed SMTP (to
reset the existing users) or new-user role re-binding (Option D).

## 6. CODE-CHANGE REQUIREMENT

```text
NO CODE CHANGE REQUIRED.
```

Provisioning uses the existing Supabase Auth Admin mechanism (Dashboard UI or
the GoTrue `auth/v1/admin` endpoint the Edge layer already wraps). No migration
74, no `auth.users` SQL writes, no new authentication infrastructure, no RLS or
auth-architecture change. No secret enters Git, reports, source, logs or
screenshots.

## 7. SECURITY CONSIDERATIONS

- Rejected: `UPDATE auth.users` / direct password writes (not a legitimate Auth
  mechanism). Rejected: using the CLI's elevated DB access to mint credentials.
- Least privilege: prefer Dashboard-side creation (key never leaves) when SMTP
  is available; otherwise bound the service-key handling to one transient,
  out-of-band, staging-only operation with post-use rotation.
- Staging isolation: `setura-staging` is separate; no production SETURA project
  exists. Production, Razorpay and Meta/WhatsApp are out of scope.
- Auditability: a successful provisioning + first authenticated login should be
  recorded (emails/roles only, never the key or password).

## 8. STATUS

```text
READY FOR OWNER ACTION
```

Positive authentication is **NOT** yet verified. STAGING is **NOT** VERIFIED.
This note only establishes the safe path to obtain legitimate staging test
credentials. Awaiting the owner's OPTION decision and (for Option C) the
out-of-band key + explicit authorization before any provisioning is executed.
