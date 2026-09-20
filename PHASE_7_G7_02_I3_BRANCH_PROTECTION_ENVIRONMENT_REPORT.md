# PHASE 7 — G7-02 I-3 BRANCH PROTECTION & ENVIRONMENT CONTROLS REPORT

Scope: **PART B (B1–B12)**. I-3 is repository governance and release-control —
NOT deployment, NOT provisioning, NOT credential creation. Per the package,
GitHub-side configuration may be performed **only if the required GitHub access
is already available.** It is **not**. This report records what was actually
observed, the one safe in-repo control applied, and what is `BLOCKED` for lack
of server-side access. No status was upgraded beyond its evidence.

---

## Executive blocker

GitHub **API / admin access is unavailable** in this environment:

```text
gh CLI present      -> NO (not installed)
GITHUB_TOKEN set    -> NO
git remote (observed)-> https://github.com/YeswanthArasavalli/Setura.git  (YeswanthArasavalli/Setura, user-owned, NOT an org)
```

Branch protection, rulesets, required status checks, environments, environment
protection rules and secret inventory all live **server-side** and require an
authenticated admin token. None could be read or written. Installing `gh` /
signing in / minting tokens was **not** performed — that would be creating the
very access the package says must already exist, and inferring permission.
Therefore B1 (server inspection) and B3–B8 (server configuration) are `BLOCKED`.

---

## B1 — Repository configuration inspection

- **Repository identity:** `YeswanthArasavalli/Setura` (confirmed from
  `git remote -v`). Personal-account repo; organization ownership is **not**
  assumed.
- **Current branch / default branch:** working branch is `main`; `origin/HEAD`
  resolves to `main` locally, so `main` is the effective default branch as seen
  from the clone. Server-side default-branch *settings* (merge button policy,
  etc.) are `UNPROVEN` (no API).
- **Branch state:** `HEAD == origin/main == 395eaa5` (I-2/I-3 correction commit,
  pushed by the repository owner during the blocker-resolution follow-up),
  ahead 0 / behind 0, working tree clean at inspection time.
- **Existing rulesets / branch protection:** `UNPROVEN` — requires API.
- **Existing required status checks:** `UNPROVEN` — requires API.
- **Existing GitHub Environments (staging/production):** `UNPROVEN` — requires
  API.
- **Existing Actions / workflow permission settings:** server-level defaults
  `UNPROVEN`; in-tree workflow had **no** `permissions:` block before B5 (fixed).
- **Are pull requests required / are direct pushes to main possible:**
  `UNPROVEN` — requires API.
- **CODEOWNERS:** **does not exist** in-tree (`.github/` contains only
  `workflows/ci.yml`).
- **Dependabot / Renovate:** **none** in-tree (no `dependabot.yml`,
  `renovate.json`).
- **Security scanning (CodeQL / `.github/workflows/security*.yml`):** **none**
  configured. (The `docs/security/*.md` and `*_security_*.sql` files matched by
  name are project documentation/migrations, not a scanning workflow.)

---

## B2 — Target protection model (design only)

The intended flow (documented, **not** yet enforced server-side):

```text
feature branch → pull request → CI validation → required review → main
               → release validation → staging → production approval
```

`main` must remain a validation target, never an uncontrolled deploy branch.
The CI workflow already validates-only and the `release-validation` job runs on
`main` push without deploying, so the code-side shape is consistent with this
model. Enforcement is `BLOCKED` on API access.

---

## B3 — Main branch protection — **BLOCKED (no API access)**

Proposed minimum ruleset (to apply once admin access exists): require PR before
merge; ≥1 approving review; dismiss stale reviews; require conversation
resolution; require the CI checks in B4; block force pushes; block deletes;
block branch creation/renaming of the protected pattern; require up-to-date
branch where practical; restrict bypass to admins with an explicit emergency
override. **NOT IMPLEMENTED** — cannot be created without GitHub API/CLI access.

---

## B4 — Required status checks — **BLOCKED; exact names captured**

The real job `name:` strings GitHub Actions would surface as checks (from
`ci.yml`) are:

```text
fmt / lint / typecheck / migrations / manifest / unit tests   (job id: quality)
apps/web typecheck / build / test / secret scan              (job id: frontend)
supabase start + integration tests                           (job id: stack)
consolidated regression + provenance (release checks; no deploy)  (job id: release-validation)
```

Recommendation recorded for when access exists: require `quality`, `frontend`
and `stack` on PRs. **Do NOT** make `release-validation` PR-required — it only
runs on `main` push/dispatch (`if: github.event_name == 'push' && github.ref ==
'refs/heads/main'`) and boots a full stack (expensive); making it a PR gate would
create an impossible/never-satisfied merge condition. **NOT CONFIGURED** — requires
API.

---

## B5 — Actions permissions — **IMPLEMENTED (in-tree, least privilege)**

Applied the one safe, no-API governance control. Added a top-level block to
`ci.yml`:

```yaml
permissions:
  contents: read
```

Rationale: the workflow validates only. `actions/checkout` needs `contents: read`;
`upload-artifact` authenticates with a separate runtime-scoped token and does
**not** need `contents: write`. No job requires `contents: write`,
`id-token: write`, `packages: write` or `deployments: write`, so the entire
workflow is pinned read-only. I-3 created **no** deployment authority. Verified
the YAML keeps valid top-level structure and no tabs.

---

## B6 / B7 — Environments & secrets — **BLOCKED / NOT PERFORMED**

`staging` and `production` GitHub Environments are created and protected only via
the API → **BLOCKED**. Independently, the package forbids adding secrets here, so
even with access none would be written this phase.

Verified secret inventory (both directions — required to be empty):

```text
production secrets = NONE CREATED (not created; cannot enumerate server-side -> UNPROVEN remote, NOT-PERFORMED locally)
staging secrets    = NONE CREATED (same)
```

No placeholder resembling a real credential was created. None of
`SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `WORKER_SECRET`,
`RAZORPAY_KEY_SECRET`, `META_APP_SECRET` (or any other secret) was added
anywhere.

---

## B8 — Deployment workflow policy — **NOT IMPLEMENTED (correctly)**

No deployment workflow exists and **none was created.** I-3 is governance;
deployment is later authorized work. No `supabase db push`, `supabase functions
deploy` or `supabase secrets set` was added to the repository. The existing
`ci.yml` remains validate-only (asserted in its header and by the absence of any
deploy step). No non-deploying placeholder workflow was needed and none was
invented.

---

## B9 — CODEOWNERS — **DEFERRED**

No CODEOWNERS exists. The repository has a single identifiable human owner
(`YeswanthArasavalli`) and **no verifiable teams or additional reviewers** (cannot
enumerate collaborators without API access). Per the package, inventing reviewer
identities is forbidden, and an owner-only CODEOWNERS adds little on a personal
repo (the owner already owns/bypasses). **CODEOWNERS = DEFERRED** pending a
populated reviewer roster.

---

## B10 — Security controls — **NOT WEAKENED**

This package changed no application code. Diff census of the working tree:

```text
.github/workflows/ci.yml   -> comment + read-only permissions block (governance)
deno.json                  -> fmt/lint exclude scope (Part A correction)
tests/integration/*.test.ts-> formatting only (Part A correction)
```

No change to RLS, authentication, privilege controls, worker security, scheduler
security, financial authorization, or the frontend secret boundary. The frontend
secret/source-map scan gate is unchanged and still passing (A6).

---

## B11 — Push policy — **NO PUSH PERFORMED**

No `git push` was run in this session; no commits were created. The in-tree I-3
edit (B5 permissions) is left as an **uncommitted working-tree change**, together
with the Part A correction. The two pre-existing commits and the graphify commit
were already on `origin/main` **before** this session (A1) — that push was not
performed here and its authorization status is noted, not asserted. No
server-side I-3 configuration required a push, because it required (missing) API
access instead.

---

## B12 — Evidence summary

1. Repository identity: `YeswanthArasavalli/Setura` (user-owned).
2. Branch state: `HEAD == origin/main == 395eaa5`, clean tree.
3. Current GitHub rules: `UNPROVEN` (no API access).
4. Changes made: `ci.yml` least-privilege `permissions: contents: read` (B5);
   Part A scope/format correction in `deno.json` + 2 test files.
5. Exact branch protection/ruleset config: `NOT IMPLEMENTED` — blocked on API.
6. Exact required checks: names captured (B4); `NOT CONFIGURED` — blocked on API.
7. Actions permission model: workflow now explicitly `contents: read`.
8. Staging environment state: `NOT CREATED` / `BLOCKED`.
9. Production environment state: `NOT CREATED` / `BLOCKED`.
10. Secret inventory: none created here; server enumeration `UNPROVEN`.
11. Deployment workflow: `NOT IMPLEMENTED` (correctly out of I-3 scope).
12. CODEOWNERS: `DEFERRED`.
13. Security review: nothing weakened; no application code touched.
14. Remaining blocked: all server-side governance (B1 inspection, B3–B8 config) —
    GitHub API/admin access unavailable.
15. Not performed: push, deploy, provisioning, secret creation, env creation,
    ruleset creation, CODEOWNERS, any application logic change.
16. Push occurred: **NO by this agent.** The owner separately committed
    `395eaa5` (the B5 + Part A changes) and pushed it to `origin/main` during
    the follow-up; no push or commit was performed by the package itself.
17. Deployment occurred: **NO**.

---

## I-3 status

`PARTIALLY IMPLEMENTED` — the single repository-internal control that needs no
server access (**B5** least-privilege token permissions) is **IMPLEMENTED**;
**B9** is **DEFERRED** with rationale; **B1** (server inspection) and **B3–B8**
(rulesets, required checks, environments, secrets, deployment wiring) are
**BLOCKED** because GitHub API/admin access is not available in this
environment. No GitHub governance was fabricated.

---

## Blocker-resolution follow-up (same package, later run)

Re-checked both original blockers against the live environment:

1. **Docker — RESOLVED.** The daemon came up (Docker 29.6.2) and the local
   Supabase stack was confirmed running. The Edge Runtime container was in its
   known F16-01 exited state and was recovered with
   `docker start supabase_edge_runtime_setura`. The consolidated regression then
   **executed**: `57 passed / 1 failed`. The lone failure `E1 09` was
   source-traced to a **Sunday-only test-fixture date rollover**
   (`clinicDate()` bumps Sunday→Monday) diverging from the production
   `open_doctor_session` `CURRENT_DATE` default — a **test-harness defect, not a
   product defect**, not caused by I-2/I-3. *Recommended follow-up (NOT applied
   here, as no product/test change was authorized and it is not a product
   defect): make the E1 doctor-session leg deterministic across weekdays — either
   pass an explicit `p_session_date = CLINIC.date` through the doctor-session
   primitive, or skip/anchor the "today session" assertions when
   `getDay() === 0`. Left as a small, isolated test-only change for explicit
   authorization.*

2. **GitHub admin/API access — STILL BLOCKED.** Re-verified: `gh` not installed,
   `GITHUB_TOKEN` and `GH_TOKEN` both unset. The only git credential is the
   Git Credential Manager `manager` helper (a git-protocol credential for
   push/pull, not an admin REST token); extracting it to call the branch-
   protection / environments API would be the prohibited "undocumented
   credential" path and was not attempted. Therefore B1 server inspection and
   B3–B8 server configuration remain **BLOCKED / UNPROVEN**; none was invented.

**In-tree governance state after the follow-up:** the B5 `permissions:
contents: read` block and the Part A fmt/lint scoping are present in the working
tree as tracked files (committed by the owner as `395eaa5`). Local CI recheck on
the current tree: `fmt:check` 150 files / exit 0, `lint` 91 files / 0 problems,
`check` exit 0, `test` 91/91, `validate:migrations` 0 err / 4 pre-existing warn,
`validate:migration-manifest` 0 issues; frontend `npm ci` (258 pkgs, exit 0),
typecheck, build, vitest 17/17 and secret/source-map scan 0/0. Git diff review
confirmed **no `.sql`, no `supabase/migrations`, no `supabase/functions`, no
`graphify-out`, no secret** among the changed files.
