# G7-13 — F16-05 / F16-06 Test-Quality Remediation

**Scope:** `tests/integration/privilege_isolation.test.ts` (test-only).
**Workstream:** G7-13 (F16-05 authenticated-half 401-vs-42501 proof quality;
F16-06 locked-routine denial coverage toward the S1 ≥80% target).

---

## 1. Executive Summary

**STATUS: CLEANLY RESOLVED**

- **F16-05 — RESOLVED.** `assertRpcDenied` no longer accepts a bare HTTP 401 or
  a message containing `"jwt"` as privilege-denial proof. Every privilege denial
  is now asserted on the database SQLSTATE **42501**, and the authenticated half
  additionally proves the caller genuinely authenticated (identity positive
  control) before any denial is counted. A JWT-layer rejection
  (`PGRST301` "JWT cryptographic operation failed") is now a **test failure**,
  not a pass. No production behavior and no status code were changed — the test
  now asserts the contract the repository actually exhibits.
- **F16-06 — RESOLVED.** Locked-routine denial coverage moved from **44/177
  (24.9%)** to **177/177 (100%)**, all genuine: every locked Category B/C/D
  routine is invoked over real PostgREST by an anonymous caller and by a
  real authenticated low-privilege user and asserted denied at SQLSTATE 42501.
  Target ≥80% — **PASS**.
- **Production code changed: NONE.** This is a test-only workstream.

---

## 2. Baseline

| Item | Value |
| --- | --- |
| HEAD | `0fceb50b0ca9b9971af1bebb3938583b78ace4dd` (unchanged at completion) |
| Branch | `main` |
| Last commit | `0fceb50 Add Hospital Operations Analytics Read Surface (G-11)` |

**Pre-existing working tree (untouched).** At session start `git status --short`
already listed these as modified by the owner's in-flight C2 + hygiene work, and
they remain exactly as the owner left them: `.gitignore`,
`c1_cancel_pre_state.json`, `graphify-out/cache/stat-index.json`,
`supabase/functions/_shared/{cors.ts,database.generated.ts,env.ts}`,
`supabase/functions/alert-center/index.ts`,
`tests/integration/{alert_center_http.test.ts,consultation_notes_read.test.ts,enterprise_command_center.test.ts}`.
`privilege_isolation.test.ts` was **clean** at session start; it is the **only**
tracked file this workstream modified.

> **Reconciliation with AGENTS.md §13.** AGENTS.md §13 records that "the working
> tree is NOT a Git repository (no `.git`, confirmed by two independent
> methods)." That snapshot is **stale**: the tree is now a Git repository on
> `main` at `0fceb50b`, matching this workstream's expected baseline. Git
> commands work and were used for the safety checks in §9. This is reported, not
> silently ignored; no commit was created (§11).

**Baseline test results (before any edit).**

- `privilege_isolation.test.ts`: **22 passed / 0 failed** (real local stack).
- Unit suite: **97 passed / 0 failed**.
- `validate:migrations`: **0 errors, 4 pre-existing `[duplicate-objects]`
  warnings** (recorded baseline — not re-reported as new defects).

---

## 3. F16-05 — Authenticated 401 vs 42501 proof quality

### Original weakness

The old `assertRpcDenied` accepted:

```ts
assert(res.status === 401 || res.status === 403, ...);
const lower = msg.toLowerCase();
assert(
  lower.includes("permission denied") || lower.includes("insufficient") ||
    lower.includes("jwt") || lower.includes("not authorized") ||
    lower.includes("42501"), ...);
```

Two independent problems:

1. Any 401 passed the status gate, including a **PostgREST/JWT-layer rejection**
   that never reached the database.
2. A message containing the substring `"jwt"` satisfied the reason gate. The
   JWT-failure body is literally `"JWT cryptographic operation failed"` — so a
   request that failed **authentication** (never exercising the privilege
   boundary) was counted as a **privilege denial**. This is exactly the
   authenticated-half false positive the finding described.

### Exact contract actually exhibited by the repository (empirically measured)

Measured live against the local PostgREST on real fixtures:

| Case | HTTP | Postgres `code` | Body message |
| --- | --- | --- | --- |
| Bad / invalid JWT (never reaches DB) | 401 | `PGRST301` | "JWT cryptographic operation failed" |
| Anonymous (no JWT), privilege denial | **401** | **`42501`** | "permission denied for function …" |
| Authenticated (valid JWT), insufficient privilege | **403** | **`42501`** | "permission denied for function …" |
| Identity positive control (`is_global_admin`, valid JWT) | 200 | — | boolean answer |

The database privilege boundary (SQLSTATE **42501**) is the same invariant for
both anon and authenticated callers; PostgREST maps it to **401 for the `anon`
role** and **403 for the `authenticated` role**. A JWT rejection is a different
code (`PGRST301`) and never reaches 42501. The fix asserts exactly this observed
contract — no invented status codes, no production change.

### What changed

- **`codeOf(res)`** — extracts the Postgres/PostgREST error `code` field.
- **`assertRpcDenied` (retightened, same name, all existing call sites keep
  working):** rejects a 404 as a test defect, then requires
  `codeOf(res) === "42501"` (the database privilege denial). `"jwt"`,
  `"insufficient"` and `"not authorized"` substring acceptance is **removed**, so
  a `PGRST301` JWT failure now fails the test instead of passing it.
- **`assertPrivilegeDenied(res, what, expectedStatus)`** — the strict form:
  requires code 42501, requires the message to contain "permission denied for
  function", **and** pins the HTTP status to the caller layer (`401` anon /
  `403` authenticated). Used by the new exhaustive census so the anonymous-vs-
  authenticated distinction is asserted, not assumed.
- **`assertGenuinelyAuthenticated(caller, who)`** — identity proof. Calls
  `is_global_admin` (a Category-A helper that the authenticated role is allowed
  to execute) as the same JWT and asserts HTTP 200. Called at the start of every
  authenticated-denial test (Category D, C, B, INVOKER, and the new census), so
  a later 403 is provably "authenticated but insufficient privilege" rather than
  an authentication failure miscounted as a denial.

### Why the new test proves the intended distinction

For the authenticated half, two facts must both hold: (a) the JWT genuinely
authenticates (proven by `is_global_admin` → 200 for the same token), and (b)
the denial is the database privilege boundary (proven by `code === "42501"`,
message "permission denied for function"). A JWT-layer rejection satisfies
neither — it cannot return 200 to `is_global_admin` and carries `PGRST301`, not
`42501`. Anonymous denial is pinned to 401 and authenticated denial to 403, so
the two layers are asserted separately (Case A vs Case B). No secret/token/PII
is logged: only HTTP status, the SQLSTATE code and the Postgres message.

---

## 4. F16-06 — Locked-routine denial coverage

### Authoritative locked-routine census

Built from `docs/security/RPC_PRIVILEGE_CLASSIFICATION.tsv`, filtered to
`category ∈ {B, C, D}` AND `target_execute_roles == "service_role"`. This
excludes the four Category A RLS helpers (`is_global_admin`,
`current_user_role`, `user_has_hospital_access`, `user_has_hospital_role` —
deliberately open to `anon`/`authenticated`) and the trigger-only, non-invocable
`B-trigger` set. Deduplicated by function name (widest overload kept for
payload resolution):

| Measure | Value |
| --- | --- |
| TOTAL authoritative locked callable routines | **177** distinct names |
| Reconciliation to the roadmap "179" | 177 names + 2 same-name overloads (`capture_payment` 4-/5-arg, `cleanup_stale_presence` 0-/1-arg) = 179 migration signatures; coverage measured per distinct callable routine |
| Previously denial-exercised | **44** |
| Previously uncovered | **133** |

### Coverage probe design

The `LOCKED_ROUTINES` table lists each routine's **parameter names** (from the
TSV `arguments` column). A payload of `{ name: null }` for those names resolves
the correct overload in PostgREST (so no `404`/`PGRST202` test defect), and
because the privilege check fires **before** argument values are cast, `null`
values are sufficient to reach and prove the real `42501` denial boundary.
Nothing executes and nothing mutates — the request is refused at
`EXECUTE`-grant resolution. This is the smallest safe denial case (§12).

Two new integration tests exercise the entire census:

- `...denies anon (HTTP 401 / SQLSTATE 42501)` → 177 assertions via
  `assertPrivilegeDenied(res, "anon -> fn", 401)`.
- `...denies a genuine authenticated user (HTTP 403 / SQLSTATE 42501)` → identity
  proof for `clerkA` (lowest-privilege receptionist), then 177 assertions via
  `assertPrivilegeDenied(res, "authenticated:clerkA -> fn", 403)`.

A third guard test asserts the census is complete and has no duplicate names
(`length === 177`), so silent drift of the locked set is caught.

### Before / after

```
Locked routines (denominator): 177
Previously covered:             44   (24.9%)
Newly covered:                 133
Final covered:                 177
Coverage:                     100.0%
Target:                       >= 80%
Result:                       PASS
```

100% is truthful, not manufactured: every one of the 177 routines was
empirically swept (177 × 2 roles) before being written into the test, and each
returned anon `401/42501` and authenticated `403/42501`. The committed test
re-exercises the same boundary on every run. Coverage is not padded with
static/string/catalog-only checks — each row is a live denied RPC invocation.

No routine was left uncovered, so there are no "uncovered routines and reasons."

---

## 5. Test Changes

| File | Change |
| --- | --- |
| `tests/integration/privilege_isolation.test.ts` | (1) Replaced the loose `assertRpcDenied` reason gate with SQLSTATE-42501 enforcement; added `codeOf`, `assertPrivilegeDenied`, `assertGenuinelyAuthenticated`. (2) Added `assertGenuinelyAuthenticated` calls to the Category D / C / B / INVOKER authenticated-denial tests. (3) Added the F16-06 section: `LOCKED_ROUTINES` census (177 rows), `nullPayload`, and 3 new `Deno.test` cases (completeness guard + anon sweep + authenticated sweep). |

The pre-existing Category A / D / C / B / INVOKER / isolation / D-4 / alert
cross-hospital / teardown tests and their argument payloads were preserved
unchanged in intent; only the assertion **strength** (F16-05) and the new census
(F16-06) changed.

## 6. Production Code Changes

**NONE.** No migration, Edge Function, RLS policy, grant, SECURITY DEFINER
signature, `search_path`, `requireRole`, tenant check or SQLSTATE mapping was
touched. The `supabase/` tree diff in the working copy is entirely the owner's
pre-existing C2/hygiene work (present before this session); this workstream
modified no file outside the single test file.

---

## 7. Validation Matrix

| Check | Command | Result |
| --- | --- | --- |
| privilege_isolation | `deno test --allow-net --allow-env --allow-run tests/integration/privilege_isolation.test.ts` | **PASS 25/25** (was 22/22) |
| Related security suites | n/a | **NOT RE-RUN** — dependency surface is nil: no shared helper was changed (all edits local to this file). `multi_role_auth` / `enterprise_command_center` / C2 / RLS suites do not import anything this workstream modified. `enterprise_command_center.test.ts` and `alert_center_http.test.ts` carry the owner's uncommitted C2 edits and were deliberately left untouched. |
| Unit tests | `deno test --allow-env --allow-read tests/unit/` | **PASS 97/97** |
| Typecheck | `deno check tests/integration/privilege_isolation.test.ts` | **PASS** (clean) |
| Lint | `deno lint tests/integration/privilege_isolation.test.ts` | **PASS** (clean) |
| Format | `deno fmt --check tests/integration/privilege_isolation.test.ts` | **PASS** (formatted) |
| Migration validation | `deno run --allow-read scripts/validate_migrations.ts` | **PASS** 0 errors, 4 pre-existing warnings |

## 8. Coverage Evidence

See §4. Locked denominator **177**; before **44 (24.9%)**; after **177
(100%)**; target **≥80%**; result **PASS**. Empirical pre-write sweep:
177 routines × 2 roles, 0 anomalies (identity control `is_global_admin` →
authenticated 200; every routine → anon 401/42501 and authenticated 403/42501).

## 9. C2 Protection

Verified via `git diff --name-only` / `--stat` and the session-start
`git status --short`:

- **C2 migration `64_c2_alert_rpc_locked_snapshot.sql`: UNCHANGED** (absent from
  the tree diff entirely — not modified by the owner or by this session).
- **`supabase/functions/alert-center/index.ts`: UNCHANGED BY THIS SESSION.** It
  appears in `git diff` only as the owner's pre-existing uncommitted edit (was
  already ` M` at session start). This workstream did not open or modify it.
- **C2 HTTP tests (`alert_center_http.test.ts`): UNCHANGED BY THIS SESSION**
  (same reason — owner's pre-existing edit).
- **C2 concurrency tests / C2 frontend / C2 RPCs: UNCHANGED.**
- The only file this session modified is `tests/integration/privilege_isolation
  .test.ts`.

**C2: UNCHANGED (no regression introduced).**

## 10. Remaining Issues

- **RESOLVED:** F16-05 (authenticated-half 401-vs-42501 proof quality) and
  F16-06 (locked-routine denial coverage → 100%).
- **PRE-EXISTING (out of scope, unchanged):** the 4 `[duplicate-objects]`
  migration warnings; the owner's in-flight C2/hygiene working-tree edits.
- **OUT OF SCOPE (explicitly not absorbed):** F16-07 (the "193 RLS policies"
  comment in this test file at the Category A section — the live count is 139;
  AGENTS.md lists the comment as still needing a targeted fix in a separate
  action), F16-04, D15, D8, C2b, scheduler, financial, production/staging
  deployment. These are recorded, not touched here.
- **BLOCKED:** none.

> Note: F16-07 is referenced only to record that the pre-existing comment was
> **deliberately not modified** in this test-only workstream, per the task's
> instruction not to absorb F16-07.

## 11. Git Safety

- `git status` / `git diff` inspected. **No commit created.** No push, reset,
  rebase, stash, checkout or cherry-pick performed.
- HEAD unchanged: `0fceb50b0ca9b9971af1bebb3938583b78ace4dd`.
- All throwaway probe/sweep/generator scripts created during investigation were
  removed; no scratch artifacts remain from this session.

---

## 12. Final Verdict

**STATUS: CLEANLY RESOLVED**

F16-05 and F16-06 are closed with real, reproducible, integration-level
authorization-denial evidence. The privilege boundary itself was already proven
at the catalog/runtime layer (Gate 2); this workstream raised the **test
evidence quality** (SQLSTATE-anchored, identity-proven, layer-distinguished) and
**denial coverage** (44 → 177 of 177 locked routines) without changing SETURA
production behavior. Certification vocabulary: F16-05 **RESOLVED (integration
verified, locally)**; F16-06 **PASS (integration verified, locally)**;
production privilege state remains **UNPROVEN** (no deployment) and is not
claimed here.
