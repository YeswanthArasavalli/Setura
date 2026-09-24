# PHASE 7 — Notifications / WhatsApp Delivery Status UI — Implementation Report

## Objective

Frontend-only, **read-only** staff visibility of notification / WhatsApp
delivery status. No backend change, no new RLS policy, no new RPC, no new Edge
Function, no SECURITY DEFINER. Existing RLS remains the authorization
boundary.

Authoritative prior investigation (not reopened):
`PHASE_7_NEXT_PRODUCT_GAP_INVESTIGATION_REPORT.md`.

## Source Reconciliation (performed before any edit)

Verified against current source, not the report:

- `apps/web/src/App.tsx`, `apps/web/src/routes/`, `apps/web/src/api/reads.ts`,
  `apps/web/src/types/api.ts`, `apps/web/src/auth/*`, `apps/web/src/lib/*`,
  `apps/web/src/components/ui/*`.
- `supabase/migrations/05_notification_queue.sql` — `notification_queue`,
  `notification_deliveries`, and the `notification_status` /
  `notification_channel` enums.
- `supabase/migrations/04_whatsapp_messaging_engine.sql` — `whatsapp_messages`,
  `whatsapp_message_status`, and the message RLS policy.

**Exact `notification_status` enum (source of truth, migration 05 L27–38):**
`pending, queued, processing, sent, delivered, read, failed, retrying,
cancelled, permanently_failed` — matches the spec §5 list exactly.

**`notification_channel` enum:** `whatsapp, sms, push, email, internal` — a
`notification_queue` row with `channel = 'whatsapp'` is the outbound
WhatsApp-bound notification and its delivery lifecycle is already on this one
table.

**`notification_queue` columns used (confirmed present):** `id, hospital_id,
patient_id, booking_id, channel, priority, status, recipient, title,
retry_count, scheduled_for, sent_at, delivered_at, failed_at, last_error,
created_at`. `notification_queue` and `whatsapp_messages` do **not** share a
schema — they were not conflated.

**Stale comment corrected:** `reads.ts`'s header previously asserted
"notifications … are intentionally NOT read here". That is contradicted by the
live DB (`notif_queue_admin` grants staff SELECT since migration 05). The
comment was corrected to reflect actual source (DB is truth over comment).

## Confirmed Authorization Boundary (existing RLS, unchanged)

| Policy | Table | Effect |
| --- | --- | --- |
| `notif_queue_admin` | `notification_queue` | FOR ALL; `receptionist`/`hospital_admin` via `current_user_role(hospital_id)`, plus `is_global_admin()`. Tenant-scoped. |
| `notif_deliveries_read` | `notification_deliveries` | SELECT; same roles via parent `notification_queue`. |
| `wa_messages_read` | `whatsapp_messages` | SELECT; same roles. |

No policy was added or modified. **v1 reads only `notification_queue`.** The
conversational `whatsapp_messages` engine was deliberately NOT merged —
surfacing its message content would drift toward the "patient communication /
messaging command center" surface explicitly excluded by the spec (§11).
WhatsApp delivery status is shown through the `channel = 'whatsapp'` rows of
`notification_queue`.

## Source Trace

```text
React UI (Notifications.tsx)
  → apps/web/src/api/reads.ts :: listNotifications()
  → PostgREST (authenticated supabase client)
  → existing RLS (notif_queue_admin)
  → notification_queue
```

No `service_role` in the browser. No direct unauthenticated table access.

## Backend Dependency

```text
NO BACKEND CHANGE
```

Verified: zero modifications under `supabase/` (migrations, functions, config).
All changes are confined to `apps/web/src/`.

## Implementation — Files Changed

Modified:

- `apps/web/src/api/reads.ts` — added `NotificationRow` type +
  `listNotifications(hospitalId, limit)` (SELECT-only, tenant filter, newest
  first); corrected the stale header comment.
- `apps/web/src/App.tsx` — registered the `/reception/notifications` route
  guarded by `RECEPTION_ROLES` (`receptionist`, `hospital_admin`; `global_admin`
  also reaches it via `RequireRole`'s global-admin rule, matching the RLS).
- `apps/web/src/components/AppShell.tsx` — added the "Notifications" nav item
  for `receptionist`, `hospital_admin`, `global_admin`. **Not** shown to
  `doctor`.
- `apps/web/src/api/reads.test.ts` — added a read-boundary test pinning the
  `notification_queue` table, the `hospital_id` filter, ordering, the lifecycle
  select columns, and an assertion that no secret/token column is selected.

Created:

- `apps/web/src/lib/notificationStatus.ts` — reusable, presentation-only
  mapping of the 10 canonical backend statuses to a deterministic label +
  existing `Badge` variant; unknown values degrade honestly.
- `apps/web/src/lib/notificationStatus.test.ts` — independent mapping tests.
- `apps/web/src/routes/Notifications.tsx` — the read-only page.
- `apps/web/src/routes/Notifications.test.tsx` — surface tests.

The Notifications table columns: Patient/Ref (recipient + booking link),
Channel, Status, Retries, Queued, Sent, Delivered, Failed, Last error. Long
`last_error` is truncated in a bounded cell with a `title` tooltip so it cannot
break the layout.

## Status Mapping (backend enum → UI label → badge variant)

| Backend status | UI label | Badge variant |
| --- | --- | --- |
| pending | Pending | secondary |
| queued | Queued | secondary |
| processing | Processing | default |
| sent | Sent | default |
| delivered | Delivered | success |
| read | Read | success |
| failed | Failed | destructive |
| retrying | Retrying | warning |
| cancelled | Cancelled | outline |
| permanently_failed | Failed permanently | destructive |

No new states invented; no backend state renamed in a way that hides meaning.

## UX States Handled

Loading ("Loading…"), Empty ("No notifications found."), Success (table),
Error (alert via `describeError`, and the card explicitly does **not** show
"No notifications found." on error — an error never masquerades as empty; this
was caught by a test and fixed), Unauthorized (RLS returns zero rows → empty
state; route guarded by `RequireRole`).

## Tenant Security

`hospitalId` comes from the authenticated session (`useAuth()` →
`resolveStaffContext`), **never** from a route/query parameter. The route path
`/reception/notifications` carries no `hospital_id`. The RLS policy is the
enforcement boundary; the client `hospital_id` filter is defensive only.

## Local Validation (exact results)

Run in `apps/web`:

```text
npm run typecheck   -> PASS (tsc --noEmit, no output)
npm test            -> PASS  (9 files, 68 tests, 0 failed)
npm run build       -> PASS  (tsc --noEmit && vite build; 113 modules)
```

Secret scan on build output:

```text
deno run --allow-read ../../scripts/check_frontend_secrets.ts dist --deny-sourcemaps
Frontend secret scan: 3 artifact(s) in dist, 0 source map(s)
Result: 0 secret hit(s), 0 source map(s) (sourcemaps denied)
```

Diff check:

```text
git diff --check   -> clean (exit 0)
```

## Security Check (pre-completion)

```text
No service_role            -> confirmed (authenticated supabase client only)
No secret                  -> confirmed (0 secret hits)
No provider token          -> confirmed (select excludes token/secret/credential/password)
No webhook secret          -> confirmed
No hospital_id auth bypass -> confirmed (session-derived, not route/query param)
No direct unauthenticated  -> confirmed (reads flow through RLS)
No backend auth change     -> confirmed (NO BACKEND CHANGE)
```

## Scope — Actions NOT Implemented

Read-only. The following were deliberately **not** implemented (require
separate authorization / Edge Function design): retry button, resend,
dead-letter replay, cancel notification, force delivery, WhatsApp resend, manual
status changes. Also excluded: analytics/dashboards, delivery-rate charts,
filtering frameworks, complex pagination, export, provider diagnostics, WhatsApp
campaign management, message composition, patient communication UI.

## Staging Deployment & Browser Validation

Staging/browser validation is **authorized** by this phase but **NOT PERFORMED
in this session.** It requires a controlled Vercel deployment plus real staging
login credentials for `receptionist` / `hospital_admin`, which are not present
in this working tree. Per the evidence rules, this is recorded honestly rather
than upgraded or fabricated.

```text
Staging deployment:            NOT TESTED (not executed this session)
Browser page access:           NOT TESTED
Existing notification records: NOT OBSERVED
Tenant isolation (browser):    NOT TESTED
WhatsApp records (browser):    NOT OBSERVED
Console / Network checks:      NOT TESTED
```

No notification or WhatsApp records were fabricated. No real WhatsApp message
was sent. No Meta credentials were used. To proceed, run the existing `setura`
Vercel project deploy and a controlled browser walkthrough as receptionist /
hospital_admin.

## Production

```text
NO PRODUCTION DEPLOYMENT
```

## Git

The working tree is now a Git repository (this contradicts the older AGENTS.md
§13 snapshot; confirmed by `git rev-parse --is-inside-work-tree` → `true`).

```text
HEAD          0ea0367  (branch: main)
origin/main   0ea0367  (HEAD == origin/main; nothing committed this session)
working tree  modified: apps/web/src/App.tsx, apps/web/src/api/reads.ts,
              apps/web/src/api/reads.test.ts, apps/web/src/components/AppShell.tsx
              new: apps/web/src/lib/notificationStatus.ts,
                   apps/web/src/lib/notificationStatus.test.ts,
                   apps/web/src/routes/Notifications.tsx,
                   apps/web/src/routes/Notifications.test.tsx
```

Nothing was committed (no explicit authorization to commit). `git add .` was
NOT used. Pre-existing untracked Phase 7 investigation reports, `.env`,
`.vercel`, `dist` and scratch files were left unstaged.

## Final Classification

```text
Notification read surface:      PROVEN LOCAL  (unit + build + secret scan) / STAGING NOT TESTED
Frontend implementation:        IMPLEMENTED
Tenant isolation:               PROVEN STATICALLY (session-derived filter + existing RLS) / browser NOT TESTED
WhatsApp records:               NOT OBSERVED (surfaced via notification_queue channel, not the conversational engine)
Retry/dead-letter ACTIONS:      NOT IMPLEMENTED — OUT OF SCOPE
Financial impact:               NONE
Backend changes:                NONE
Production:                     NO DEPLOYMENT
```
