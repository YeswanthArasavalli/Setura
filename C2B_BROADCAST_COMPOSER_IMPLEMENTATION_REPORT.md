# C2b — Broadcast Composer: Implementation Report

**Status:** C2b — IMPLEMENTED AND LOCALLY VERIFIED (runtime/browser execution
BLOCKED — see §13). Statically verified + unit/component verified. Not
integration-, runtime- or production-verified.

---

## 1. C2b scope

A Hospital-Admin UI that **composes → previews → confirms → enqueues** the five
operational WhatsApp broadcasts already supported by the existing
`command-center` Edge Function. C2b is a **client only**. It adds no backend,
no Edge Function, no RPC, no migration, no new state machine and no new
idempotency mechanism. It does not redesign `broadcasts.ts`, invent business
rules, or fake delivery confirmation.

The five broadcast types surfaced (all existing `broadcast_*` actions):

| Composer type | Backend action |
| --- | --- |
| Queue Update | `broadcast_queue_summary` |
| Doctor Delay | `broadcast_doctor_delay` |
| Hospital Closure | `broadcast_closure` |
| Admin Notice | `broadcast_admin_notice` |
| Alert Notification | `broadcast_alert` |

## 2. Existing backend capabilities consumed

- **`supabase/functions/command-center/index.ts`** — the `broadcast_*` action
  handlers, their Zod `Schema` (exact field constraints) and `requireRole`
  list. READ ONLY; not modified.
- **`supabase/functions/_shared/enterprise/broadcasts.ts`** — the five
  functions that compose the WhatsApp text, select recipients and call
  `enqueue_job` with deterministic idempotency keys. READ ONLY; not modified.
- **`@/lib/api.ts` `callFunction`** — the only frontend path to the privileged
  backend (attaches the user JWT and the `X-Hospital-ID` header).
- **`@/hooks/useAsyncAction`** — established in-flight double-submit guard.
- **`@/lib/errors` `describeError`/`ApiError`** — established safe error
  mapping.
- **`@/api/reads` (`listTodaysBookings`, `listDoctorNames`)** — established
  RLS reads reused for the queue-session picker (same pattern as QueueBoard).
- **`@/api/alertCenter` `fetchAlertCenter`** — established alert-center read
  reused for the alert picker (open alerts).
- **`@/api/portfolio` `fetchActingHospitalContext`** — established G-08 bounded
  acting context for a tenant-less `global_admin`.

No new primitive was created; every capability above already existed.

## 3. Product decisions already defined (no owner decision needed)

The four "undefined" decisions flagged in the readiness report are already
settled by the backend source, so C2b consumes them rather than inventing them:

1. **Recipient selection** — fully backend-owned. The composer never enters or
   sends a phone number or recipient list. The preview *describes* the audience
   scope the server will resolve; the only count ever shown is the server's own
   `broadcast.enqueued` after the call.
2. **Preview** — honest. For backend-generated messages (queue/delay/closure/
   alert) the preview states the OPERATION, never a fabricated exact message.
   Only the admin-notice `message` (genuinely supplied by the composer) is shown
   verbatim, with the backend's `[kind]` tag disclosed rather than reproduced.
3. **Rate / spam** — the backend's deterministic `enqueue_job` idempotency key
   is the anti-duplicate mechanism. No client idempotency key and no separate
   rate limiter were introduced. The only frontend defence is `useAsyncAction`
   disabling the control while in flight.
4. **Delivery semantics** — `ENQUEUED ≠ DELIVERED`. A success renders
   "Broadcast queued." with the server's enqueue count and never claims WhatsApp
   delivery. There is no poll and no fake delivery tracker; `enqueued: 0`
   (flag-gated patient broadcast) is shown as the server's honest result.

## 4. Genuinely unresolved owner decision

**None blocking implementation.** One documented product limitation is noted
for the record rather than resolved here: patient-facing broadcasts
(queue-summary / doctor-delay / closure) are gated by the
`whatsapp_queue_updates` feature flag and return `enqueued: 0` when it is off.
C2b surfaces that honestly; whether/when to enable the flag or activate a worker
is an existing platform/operations decision (worker disabled, no proven
scheduler), out of C2b scope.

## 5. Files changed

**New (2):**
- `apps/web/src/routes/BroadcastComposer.tsx` — the composer UI.
- `apps/web/src/routes/BroadcastComposer.test.tsx` — 30 component tests.

**Modified (4):**
- `apps/web/src/types/api.ts` — added `CommandCenterBroadcastAction`,
  `AdminBroadcastKind`, `CommandCenterBroadcastResult`,
  `CommandCenterBroadcastResponse`.
- `apps/web/src/api/commandCenter.ts` — added the five broadcast wrappers +
  four options interfaces; rewrote the module doc.
- `apps/web/src/api/commandCenter.test.ts` — removed the old "no broadcast
  surface" assertion; now covers read + broadcast wrappers (payload exactness,
  tenant-only-in-header, no idempotency key, error propagation).
- `apps/web/src/App.tsx` — `/admin/broadcast` route, `ADMIN_ROLES` guard.
- `apps/web/src/components/AppShell.tsx` — "Broadcast Composer" nav entry
  (admin roles).

## 6. UI implemented

Three unmistakable stages with a stage indicator: **Compose → Preview → Queued**.

- Type picker limited to the five supported broadcasts (human labels; internal
  `broadcast_*` names never shown).
- Per-type context fields: queue-session picker (queue/delay), delay minutes +
  reason (delay), optional session date + reason (closure), notice category +
  message (admin notice), open-alert picker (alert).
- Client-side validation mirrors the backend `Schema` limits for usability only
  (`MESSAGE_MAX` 500, `REASON_MAX` 200, `DELAY_MIN` 1, `DELAY_MAX` 1440,
  `YYYY-MM-DD` date) — never a security boundary.
- "Review broadcast" gated on validation; preview re-checks defensively;
  "Confirm and queue" dispatches exactly one request.
- Reuses the established `Card`/`Button`/`Input`/`Textarea`/`Label`/`Badge`
  primitives; no new component system.

## 7. API wrappers

Five wrappers in `@/api/commandCenter`, each sending only the fields the backend
reads for that action (optional blanks omitted so the server default applies):

```
broadcastQueueSummary(hospitalId, queueSessionId)
broadcastDoctorDelay(hospitalId, { queueSessionId, delayMinutes, reason? })
broadcastClosure(hospitalId, { date?, reason? })
broadcastAdminNotice(hospitalId, { kind, message })
broadcastAlert(hospitalId, { alertId })
```

All go through `callFunction` against `command-center`; return type is
`CommandCenterBroadcastResponse`.

## 8. Authorization

Mutation controls render for `hospital_admin` / `global_admin` purely as UX
convenience mirroring the backend's own `requireRole` list. The Edge Function
re-authorizes role **and** tenant on every call, so hiding a control is never
the boundary. A non-admin (receptionist/doctor) sees a restriction notice and
sends nothing.

## 9. Tenant handling

Tenant travels **only** in the `X-Hospital-ID` header that `callFunction` sets;
no hospital id is ever placed in a broadcast body. A tenant-less `global_admin`
reuses `fetchActingHospitalContext()` exactly once, discloses that acting
context in the UI, and issues zero broadcast requests until the scope resolves.

## 10. Preview / confirmation behavior

Preview shows the human type label, the described recipient scope, and the
composer-supplied fields. For backend-generated messages it states the
operation, not an invented message. Confirmation dispatches the matching
wrapper once; success drives state from the resolved response (a reactive
effect, never a stale closure read), so a rejection returns to preview and a
swallowed double-submit fires nothing. The queued screen reports the server's
`broadcast.enqueued` count with an explicit "not delivered" disclaimer, and
offers "Compose another" (full reset) without re-submitting.

## 11. Tests

- `commandCenter.test.ts` — **16** tests: exhaustive 10-export check, exact
  payloads for the five broadcast wrappers, tenant-in-header-only, no
  idempotency key sent, error propagation.
- `BroadcastComposer.test.tsx` — **30** tests: authorization visibility, field
  visibility per type, client validation bounds, preview content honesty,
  confirm + payload dispatch, "queued ≠ delivered", honest `enqueued: 0`,
  duplicate-submit guard, backend errors at 401/403/422/500, global-admin
  acting context, PII containment, "compose another" reset.

Result: **46 passed** (2 files), exit 0. Non-failing `act()` advisories appear
on async context loads in visibility tests and are noise, not assertions.

## 12. Build / typecheck / lint / format

- `tsc --noEmit`: exit **0** (clean).
- `vite build`: exit **0** (bundle produced; only the pre-existing >500 kB
  chunk-size advisory, unrelated to C2b).
- `vitest`: exit **0** (46 tests green).
- `deno fmt` / `deno lint`: **NOT APPLICABLE** to this surface — `deno.json`
  excludes `apps/`; the frontend is governed by the `apps/web` toolchain
  (tsc/vite/vitest), not the Deno formatter.

## 13. Runtime / browser status

**BLOCKED.** The local Supabase stack is partially running, but there is no
local `.env` and the Edge Runtime container is stopped, so no authenticated
browser walkthrough or live `command-center` call could be executed. No
machine-endpoint runtime or production verification was performed. Local
evidence is static typecheck + unit/component tests only.

## 14. Diff boundary

All changes are confined to `apps/web/` (2 new + 4 modified files, enumerated in
§5). **Zero** backend / SQL / migration / Edge Function / `_shared` changes. No
new route beyond `/admin/broadcast`; no change to existing pages other than the
route and nav registrations.

## 15. Remaining limitations

- Runtime/production behavior UNPROVEN (§13): the composer is verified against
  mocked backend responses, not a live Edge Function.
- `ENQUEUED ≠ DELIVERED`: the feature flag / disabled worker / absent scheduler
  mean a queued broadcast may not reach patients or admins; surfaced honestly,
  not a C2b defect.
- Client validation is a UX mirror of backend limits only; the backend remains
  the authority and may reject independently.
- Bundle-size advisory is pre-existing and unrelated to C2b.
