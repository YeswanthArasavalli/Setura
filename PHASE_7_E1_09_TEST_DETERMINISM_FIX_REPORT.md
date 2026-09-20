# PHASE 7 — E1-09 Deterministic Test Fix + Consolidated Regression Re-proof

Execution date: Sunday, 2026-09-20 (a genuine Sunday run — the exact condition
that reproduced the failure).

Scope: an isolated, test-only determinism correction to the E1 hospital core
journey fixture, followed by a full consolidated regression re-proof. No
production behavior was changed and no commit was created.

---

## 1. Original failure

Real consolidated regression against the local Supabase stack (Docker 29.6.2,
stack RUNNING, Edge Runtime recovered) before the fix:

```text
deno task test:consolidated   ->   57 passed | 1 failed
E1 suite in isolation          ->   17 passed | 1 failed
```

The single failure was `E1 09` at
`tests/integration/hospital_core_journey.test.ts:872`:

```text
AssertionError: Values are not equal.
-   5c9166a8-a1d5-4b7a-80ff-6e115363f8a7   (queue_session_id from start_session)
+   74210d51-afd6-47a1-8359-eaae630172aa   (J.sessionId from the booking)
```

Sunday-only divergence.

## 2. Root cause (test fixture, not product)

Verified against source before any change:

```text
clinicDate()  -> if (getDay() === 0) setDate(+1)   // Sunday -> Monday
CLINIC.date   -> Monday on a Sunday run

E1 01 (create-booking) -> queue session for p_appointment_date = CLINIC.date (Monday)

E1 09 (doctor-operations start_session)
    -> runOpenDoctorSession(db, hospitalId, doctorId, actorId, logger)
    -> db.rpc("open_doctor_session", { p_hospital_id, p_doctor_id, p_actor_id })
       // NO p_session_date is passed by the Edge Function
    -> open_doctor_session(... p_session_date DATE DEFAULT CURRENT_DATE ...)  // migration 46
       // CURRENT_DATE = Sunday
```

Different `(hospital, doctor, date)` tuple → `open_doctor_session` correctly
created a second (Sunday) session instead of converging on `J.sessionId`
(migration 46 lines 210-231: it converges only when an ACTIVE session exists for
the exact `p_session_date`). The test then compared two different UUIDs.

This is a test-harness determinism defect. The production date semantics are
correct and unchanged.

## 3. Fix (test-only)

Option A was investigated first and rejected as unauthorized: the doctor-session
API contract does **not** expose a session date. `doctor-operations`'s Zod schema
has no session-date field for `start_session`, and `runOpenDoctorSession` does
not forward `p_session_date`. Passing an explicit date would require changing the
production Edge Function / API contract solely for the test — explicitly
prohibited by the task package.

Option B (test-date anchoring) was applied instead — the smallest internal
consistency fix. `clinicDate()` no longer advances Sunday → Monday; it anchors
to plain "today" for every weekday, so `CLINIC.date` equals the same current
date the doctor-session RPC resolves via the server `CURRENT_DATE`. This is
precisely the equality Mon-Sat runs already relied on for convergence; the
Sunday-only `+1` rollover was the sole desynchroniser. The fixture doctor's
schedule is inserted for `CLINIC.weekday`, so availability and capacity remain
correct on any weekday, Sunday included.

File changed: `tests/integration/hospital_core_journey.test.ts` (function body
minus one line, plus an explanatory comment). No assertion weakened, no Sunday
skip, no timing hack:

```ts
function clinicDate(): { date: string; weekday: number } {
  const d = new Date();
  // removed: if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  ...
}
```

The E1 09 invariant remains meaningful: `doctor session == existing queue
session` for the same hospital / doctor / session date.

## 4. Production impact

```text
No production SQL changed.
No migration changed.
No Edge Function changed.
No RLS changed.
No business logic changed.
No financial / worker / scheduler / frontend / CI logic changed.
```

Proven by `git diff --name-only` (see §7): the only modified file is the test.

## 5. Test evidence (actual repository output, live stack)

```text
E1 (hospital_core_journey)     = 18 passed | 0 failed
W1 (worker lifecycle/lease/failure) = PASS (within consolidated)
Scheduler (scheduler_autonomy) = PASS (within consolidated)
Financial (booking_fee_refund / refund_sync / settlement_record_payment) = PASS
Security (security_s1)         = PASS
Consolidated (test:consolidated) = 58 passed | 0 failed (16s)
Unit (deno task test)          = 91 passed | 0 failed
```

The `w1 deterministic failure` JSON log lines inside the consolidated run are an
intentional self-test (a job deliberately throws, is retried, then dead-lettered)
— not a defect.

## 6. Repeatability

The corrected E1 suite was run twice back-to-back on the Sunday stack:

```text
Run 1 -> 18 passed | 0 failed
Run 2 -> 18 passed | 0 failed
```

Weekday independence: the failure required `getDay() === 0` (Sunday); with the
rollover removed, `CLINIC.date` tracks the same current date on every weekday,
so the previously-failing Sunday condition is now identical in behavior to the
Mon-Sat path that already passed. The system clock was not manipulated.

## 7. Git state (actual, verified — differs from the package's assumed state)

The working tree IS now a Git repository (AGENTS.md §13's "no `.git`" note is
out of date and explicitly warns facts may have changed).

```text
HEAD          = 2c53638        (NOT the assumed 395eaa5)
origin/main   = 2c53638        (in sync, ahead/behind 0 / 0)
working tree  = 1 modified file: tests/integration/hospital_core_journey.test.ts
                (12 insertions(+), 5 deletions(-))
commit created = NO
push performed = NO
```

`git diff --name-only`:

```text
tests/integration/hospital_core_journey.test.ts
```

The fix is left as an uncommitted working-tree change for review, as required.

## 8. Remaining blockers (unchanged, not resolved here)

Server-side GitHub branch-protection / environment governance remains blocked —
no `gh`, no `GITHUB_TOKEN`/`GH_TOKEN`, only a git-protocol credential helper:

```text
B1 / B3 / B4 / B6 / B7  =  BLOCKED / UNPROVEN
```

GitHub admin access remains a separate prerequisite for the G7-02 I-3 server-side
governance items. This was not bypassed or pretended resolved.

---

## Hard stop

The deterministic E1-09 fix and the complete consolidated regression (58/58) are
proven locally. No deployment, no production project/secret/credential creation,
no DNS, no hospital onboarding, no real WhatsApp/payment activity was started.
