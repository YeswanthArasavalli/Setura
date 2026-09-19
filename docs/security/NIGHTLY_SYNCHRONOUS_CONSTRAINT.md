# Nightly Synchronous Constraint — P1-07 / P2-09 Resolution

**Status:** DECIDED AND IMPLEMENTED (Phase 0, P0-C) **Date:** 2026-09-18
**Finding IDs (canonical, `CROSS_PHASE_GAP_REGISTER.md`):** P1-07 (wrong
secret), P2-09 (prohibited nightly worker wake), drift D-05
(`ARCHITECTURAL_DRIFT_REGISTER.md`) **Requirement:** I-03 — `ROADMAP.md:~248`
_"Verify `run-cron-nightly` does NOT wake worker (nightly tasks are
synchronous)"_

---

## 1. The entangled defect pair

`run-cron-nightly` carried a Step 9 that POSTed to `run-background-worker` with
the header `X-Cron-Secret: Env.SUPABASE_SERVICE_KEY.slice(-20)` — a **derived**
credential the worker never accepts (the worker verifies against `CRON_SECRET`).
Consequence: the call **always 403'd** (P1-07).

That failure was accidentally protective: the call itself violates the frozen
architecture constraint that nightly tasks are synchronous (P2-09 / D-05).
Fixing only the secret would have **activated the prohibited behavior** — the
two had to be resolved together.

## 2. The decision

**The prohibited call was removed, not repaired.**

- Nightly maintenance (`run-cron-nightly`, steps 1–8) is **synchronous** and
  remains so by standing constraint. It does not and must not wake the worker.
- Worker wake-up belongs to exactly two owners:
  1. `run-cron-minute`, gated by the documented `ENABLE_WORKER_TRIGGER` flag
     (correct `CRON_SECRET` usage already present there), and
  2. the future scheduler decision **NPD-05** (Phase 2) — which remains open; no
     scheduler is implied by this document.
- Post-nightly queued jobs are therefore processed by the minute-cron path or
  the future scheduler — never by a nightly-side wake.

Rejected alternative: "fix the Step-9 secret" — rejected because it ships the
forbidden design (D-05: _"Fixing P1-07 before D-05 would ship the forbidden
design"_).

## 3. Implementation

| Change                                                                                                                                                                  | File                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Step 9 removed; explanatory comment left at the seam                                                                                                                    | `supabase/functions/run-cron-nightly/index.ts` |
| Header doc updated with the synchronous constraint                                                                                                                      | same                                           |
| Fail-closed cron auth extracted to a shared primitive                                                                                                                   | `supabase/functions/_shared/cron_auth.ts`      |
| Nightly endpoint now uses the shared primitive                                                                                                                          | `run-cron-nightly/index.ts`                    |
| Unit proof: correct/missing/wrong/unconfigured secret + two regression guards ("nightly must not call run-background-worker", "derived-secret pattern must not return") | `tests/unit/cron_auth.test.ts`                 |

## 4. Verification standard

- The auth contract (accept exact match; reject missing, wrong,
  length-mismatched, and unconfigured-secret cases) is unit-proven against the
  shared primitive.
- The negative constraint is guarded in CI: any reintroduction of a
  nightly→worker call fails `deno task test`.
- Local runtime note: with no `CRON_SECRET` configured in the local Edge
  Runtime, `run-cron-nightly` fails closed (403 for every caller) — which is the
  intended posture, not a bypass.

## 5. Explicit non-goals

- No secret values are recorded here or committed anywhere.
- This document does **not** decide NPD-05 (scheduler choice) and does **not**
  enable `ENABLE_WORKER_TRIGGER`; both remain open Phase 0/2 decisions per
  `SETURA_FINAL_MASTER_ROADMAP.md`.
