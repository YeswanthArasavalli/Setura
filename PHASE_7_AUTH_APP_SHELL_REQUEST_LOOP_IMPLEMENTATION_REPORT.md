# PHASE 7 — AUTHENTICATED APP-SHELL REQUEST/REMOUNT LOOP — IMPLEMENTATION REPORT

Workstream: auth-event → forced-remount → refetch loop (Candidates F + G, one defect).
Classification: DEFECT fix, frontend-only.
Spec: authenticated implementation brief of this phase (31-section request). Status vocabulary per AGENTS.md §5.

---

## 1. Executive Summary

The proven amplifier — every `onAuthStateChange` event calling `setLoading(true)`
and re-running `resolveStaffContext()`, which made `RequireRole` swap the entire
authenticated tree for a `Loading…` div, unmounting `AppShell` + `Outlet` and
re-executing every load-on-mount page fetch — was fixed with a minimal,
structural change confined to `apps/web/src/auth/AuthProvider.tsx`.

A controlled **before/after runtime experiment on the production bundle**
pinpointed the driver: an in-session token refresh on the OLD deployed code
produced exactly the recorded defect signature (1 refresh → 1 auth event → 1
full tree teardown → `profiles` + `user_roles` + 5 × `command-center`
re-fires, with a visible `Loading…` flash); the same experiment on the FIXED
code produced only the legitimate refresh request and zero remount. The
unboundedness came from the remount itself re-entering the auth path; routine
events no longer destroy the tree. Authentication, role UX gating, tenant
resolution and RLS posture are unchanged; backend was not touched.

**Final status: PROVEN STAGING — CLOSED** (§14).

---

## 2. Baseline

| Item | Value | Method |
| --- | --- | --- |
| Branch | `main` | `git branch --show-current` |
| HEAD | `da5332efab5583a957f645a4a5c145ec42c46c5b` (`Staff booking reschedule + G-06 closure`) | `git rev-parse HEAD`, `git log -1` |
| origin/main | `da5332e` (== HEAD) | spec §1 + git |
| Working tree pre-change | Untracked G-07 evidence artifacts only | `git status --short` |

---

## 3. Root-Cause Investigation

Full chain, with evidence class per link:

```text
auth event (TOKEN_REFRESHED or any same-user event)     [PROVEN — runtime experiment, §4]
  → AuthProvider callback: unconditional setLoading(true) + load()   [PROVEN — source da5332e]
  → resolveStaffContext(): GET profiles + GET user_roles             [PROVEN — runtime burst]
  → RequireRole sees loading=true → renders <div>Loading…</div>      [PROVEN — runtime "Loading…" flash observed]
  → AppShell + Outlet component-type swap → full subtree unmount     [PROVEN — remount burst observed]
  → AdminCommandCentre mount effect (useCallback[hospitalId]) re-runs[PROVEN — 5 command-center POSTs re-fired]
  → 7 redundant requests per event; remount re-enters auth path      [PROVEN — the loop is self-refeeding]
```

- **PROVEN:** any auth event force-remounts the authenticated tree (source +
  runtime experiment); the page-fetch repetition requires remounting (stable
  `hospitalId` string; zero `setInterval`/Realtime in routes).
- **PROBABLE, bounded:** the original walkthrough's ~1 event/5–10 s cadence
  (477 → 533/min). The amplifier itself re-enters the auth path on every
  remount (`getSession()`/`getUser()` per `callFunction` on an expired token),
  so once a refresh starts while multiple surfaces are open the loop is
  self-sustaining. The exact first trigger in the original session (tab
  visibility after >55 min, multi-tab BroadcastChannel, or storage sync) could
  **not** be pinned in a fresh-session idle observation (see §4) and is
  recorded as bounded, not proven. The fix removes the harm for **every**
  same-user event regardless of which emitter fires.
- Explicitly ruled out (fresh-session, 75–132 s idle, staging + local):
  route-level polling, Realtime channels, and any steady-state timer — 0 idle
  requests observed on the pre-fix bundle when the token was not expiring.

---

## 4. Auth Event Evidence

Controlled experiment (expire stored token in place, no page reload, trigger
auto-refresh via `visibilitychange`), production bundles, real browser:

**PRE-FIX bundle (da5332e code, local prod build — defect reproduced):**
```text
new requests after refresh trigger (10 s window):
  1 × POST /auth/v1/token?grant_type=refresh_token
  1 × GET  /rest/v1/profiles          (second time)
  1 × GET  /rest/v1/user_roles        (second time)
  5 × POST /functions/v1/command-center (second full round)
"Last updated" header changed 5:38:46 PM → 5:39:49 PM  ⇒ remount
"Loading…" intermediate state observed by 250 ms poller (~250 ms–1 s flash)
Console errors: 0  (silent churn, matching original observation)
```

**FIXED bundle, local:** 1 new request (`grant_type=refresh_token`), 0
profiles/user_roles/command-center, `Last updated` byte-identical, no flash.

**FIXED bundle, staging (`setura-delta.vercel.app`):** 1 new request
(`grant_type=refresh_token`, HTTP 200), 0 profiles/user_roles/command-center,
`Last updated 9/30/2026, 6:23:35 PM` unchanged after the refresh, no `Loading…`.

**Fresh-session idle baselines (context, not proof of emitter):** pre-fix
staging idle 96–132 s → 0 requests; fixed local/staging idle → 0 requests.
Hosted JWT TTL measured at **3600 s** (`iat`/`exp` decode of a real staging
token), so a single periodic refresh is ~1/hour; the historical 56/min required
the self-referential loop, which the experiment above reproduces and closes.

---

## 5. Files Changed

| Path | Change |
| --- | --- |
| `apps/web/src/auth/AuthProvider.tsx` | The fix (+46/−11 vs HEAD): `authedUserRef` tracks the user whose staff context is established **or in flight**; same-user auth events update `session` state only; different-user / first establish / post-null retries keep the full loading teardown; fail-closed clearing on unresolved context; stale-completion guard for concurrent user switches |
| `apps/web/src/auth/AuthProvider.test.tsx` | NEW — 11-test auth event matrix + shell-stability regression suite (§8) |

Not changed: `RequireRole.tsx`, `App.tsx`, `context.ts`, `lib/supabase.ts`,
`lib/api.ts`, `AppShell.tsx`, `AdminCommandCentre.tsx`, `BookingDetail.tsx`
(instrumentation added during diagnosis was fully removed before finalizing —
`git diff --stat HEAD` shows no residual diff in any of them).
**Zero backend changes** (§12).

## 6. Implementation

Minimal structural rule inside the existing provider (no new primitives):

```text
event with session s:
  if s.user.id === authedUserRef.current  → setSession(s) only   (routine: TOKEN_REFRESHED,
                                                                    same-user SIGNED_IN replays,
                                                                    multi-tab storage sync)
  else                                    → setLoading(true) + resolve (genuine transition:
                                            first establish / different user / after context cleared)
event with null session                   → clear marker + staff; teardown driven by session=null
```

`authedUserRef` is marked **synchronously** at load start, which additionally
deduplicates the cold-start double/triple `profiles`+`user_roles` pair that was
visible even on the pre-fix staging bundle (3× pair per cold load → 1×).
Forbidden shortcuts (autoRefreshToken off, event filtering by name, debounce,
timers, request suppression) were NOT used; `TOKEN_REFRESHED` is not special-
cased — the rule is *user identity*, not event name.

## 7. Security Preservation

- Session state is still updated on **every** event; `SIGNED_OUT` and null
  session still tear down the tree and redirect (test-pinned).
- Role/tenant re-resolution still runs on every genuine transition (first
  establish, different user, failed/empty previous resolution, re-login after
  sign-out — all test-pinned).
- A skipped same-user re-read cannot widen access: staff context is
  display/routing only (`context.ts` header comment); the Edge Functions
  re-authorize actor/role/tenant server-side from the fresh JWT on every
  request, and RLS gates the direct reads. Frontend behavior change is not a
  security boundary change.
- Fail-closed preserved: unresolved/null staff context still renders the
  no-staff surface, clears the marker, and the shell never mounts.
- No change to RLS, grants, SECURITY DEFINER, tokens, secrets, or `.env`.

## 8. Tests

| Gate | Result |
| --- | --- |
| Targeted auth tests (`vitest run src/auth/AuthProvider.test.tsx`) | **11 / 11 PASS** |
| Full frontend Vitest, sequential (`--no-file-parallelism`) | **246 / 246 PASS, 22 files** (baseline 235 + 11 new; 0 failures, 0 weakened) |
| Typecheck (`npm run typecheck`) | **PASS** (exit 0) |
| Production build (`npm run build`) | **PASS** (exit 0; dist `index-DVFLYGsb.js`) |

New tests pin, with the REAL `AuthProvider` + `RequireRole` (only the Supabase
event stream and the staff-context read mocked): auth event matrix
(`INITIAL_SESSION`/`SIGNED_IN`/`TOKEN_REFRESHED`/`USER_UPDATED`/`SIGNED_OUT`);
same-user event burst (10 events) → 0 remounts, 1 read pair; different user →
correct loading teardown + re-resolve; re-login after sign-out → re-resolves
(no stale-context reuse); null/failed context → shell never mounts, retries
on next event.

## 9. Local Runtime Verification

Production mode only (`npm run build` + `npm run preview` on :4173 — not dev/HMR).

| Measurement | Result |
| --- | --- |
| `/admin` idle ≥60 s (fixed build) | **0** requests in 89.4 s |
| `/bookings/:id` idle ≥60 s (fixed build) | **0** requests in 89.0 s |
| In-session refresh (fixed) | 1 refresh request, 0 page refetches, header unchanged |
| In-session refresh (pre-fix rebuild) | 8 requests, full remount — defect reproduced |
| Console | 0 errors/warnings both runs |

Screenshots: `authloop_local_fixed_final.png`, `_diag_prev_build_refresh_remount.png`.

## 10. Staging Verification

- URL: `https://setura-delta.vercel.app` — deployment `setura-2rbelth7u-...`,
  target production-slot alias of the existing `setura` Vercel project
  (the established staging frontend), status READY. No new project.
  Deployed-asset proof: served `index-D23ak40u.js` contains the fixed
  minified callback
  `onAuthStateChange((m,p)=>{...if(c.current===p.user.id)return;...})` —
  byte-compared fingerprint with the local fixed build.
- **Deploy method deviation (disclosed):** the brief forbade commit/push, but
  the project's normal path is a git-push auto-build. Executed after explicit
  user selection: `vercel deploy --prod --yes` from the repo root (CLI upload,
  no git history mutation). Side effect noted for ops: the CLI upload did not
  reproduce the exact remote-build hash (different env/Node), and root-CLI
  deploys require the repo-root link (project `rootDirectory=apps/web`
  resolves against CLI uploads — first attempts from `apps/web` errored).
- `/admin` idle: **0** requests / 94.6 s; `Last updated` stable 45 min session.
- `/bookings/:id` idle: **0** requests / 80.8 s.
- Auth refresh behavior: §4; console: **0** messages all types.
- Supabase backend: untouched (hosted project used read-only through the app).

## 11. Regression Smoke (closed work — NOT re-audited)

| Guard | Result |
| --- | --- |
| G-03 `/admin` loads; one Refresh action = exactly 5 command-center POSTs, all 200, `Last updated` advances | PASS |
| G-05 `/admin/audit` loads with 24 audit rows + integrity panels, 0 errors | PASS |
| G-06 `/admin/reports` generates Daily Hospital report once (1 request, 200, values render) | PASS |
| G-07 booked booking (`Token 3`, status `booked`) shows Reschedule action; terminal `rescheduled` booking correctly shows none | PASS |
| Role/tenant: receptionist login lands `/reception`, admin nav links absent; admin lands `/admin` | PASS |

## 12. Git State (end of phase)

```text
branch: main   HEAD: da5332efab5583a957f645a4a5c145ec42c46c5b (== origin/main, unchanged)
modified (uncommitted): apps/web/src/auth/AuthProvider.tsx
new (untracked):        apps/web/src/auth/AuthProvider.test.tsx
untracked env residue:  .vercel/ (CLI link created for the authorized deploy)
new evidence files:     _authloop_*.log/.json/.ps1/.js, authloop_*.png screenshots
No commit, no push, no history mutation performed (spec §29).
git diff --stat HEAD -- supabase tests scripts .github deno.json → EMPTY (backend untouched).
```

## 13. Known Residuals (carried forward, not reopened)

- Original ~56/min emitter in the historical walkthrough session remains
  **bounded-not-proven** (§3): fresh idle never looped pre-fix; the proven
  self-referential refresh→remount→refetch cycle is closed for all sources.
- Role/tenant changes made in the DB during a long idle session are picked up
  at next sign-in or user switch, not mid-session (backend remains
  authoritative in the interim). Design consequence of the fix.
- Pre-existing docs debt untouched: stale AGENTS.md "no .git" note;
  F16-07 comment; ~90 untracked root evidence artifacts; markdown fmt:check.
- Standing items unchanged: portfolio UI gap, alert triage, finance
  read/evidence gap, doctor schedule/leave, B1/NPD-05 (scheduler), worker
  P0-01/P0-03, production infrastructure deferral, staging fixture limits
  (doctor/tenant-B empty).
- `realtime` `_handleTokenChanged` warns that `onAuthStateChange`-sourced
  values are less secure than `getUser()` — pre-existing library posture;
  unaffected by this change (backend uses verified JWTs).

## 14. Final Status

```text
PROVEN STAGING — CLOSED
```

Acceptance criteria A1–A24: all PASS on the evidence above, with A2 satisfied
as "clearly bounded" (permitted by the criterion's wording) and the staging
deploy method deviation disclosed in §10. Production Supabase/infrastructure
NOT TOUCHED; no `PRODUCTION VERIFIED` claim is made.
