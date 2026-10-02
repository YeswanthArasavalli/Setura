import { callFunction } from "@/lib/api";
import type {
  AdminBroadcastKind,
  CommandCenterBroadcastResponse,
  CommandCenterOverviewResponse,
  CommandCenterPredictiveResponse,
  CommandCenterSlaResponse,
  CommandCenterSystemHealthResponse,
  CommandCenterTimelineResponse,
} from "@/types/api";

/**
 * Boundary over the EXISTING `command-center` Edge Function
 * (Phase 7 G-03 admin command centre + C2b Broadcast Composer).
 *
 * The five read wrappers send exactly the actions the backend schema accepts,
 * with no body fields beyond what `command-center/index.ts` actually reads.
 * The five `broadcast_*` wrappers (C2b) send exactly the fields the backend
 * `Schema` reads for the selected action and NOTHING else — every absent
 * optional field is OMITTED (never coerced to `""`/null) so the server default
 * applies. Role + tenant authorization is re-resolved server-side (`requireRole`
 * + `X-Hospital-ID` verification): the tenant travels ONLY in the header
 * `callFunction` sets from the authenticated staff context, never in the body
 * and never from the URL.
 *
 * C2b owns NOTHING of the broadcast itself. Recipient selection, the final
 * WhatsApp text and replay safety all live in the backend
 * `_shared/enterprise/broadcasts.ts`: it fans out to the queue-active patients,
 * hospital admins or the alert's admins the server decides, composes the exact
 * message, and keys every `enqueue_job` with a DETERMINISTIC idempotency key.
 * Because that deterministic key is the whole dedupe mechanism and the endpoint
 * never reads an `Idempotency-Key` header, NO such header is minted here — a
 * client-supplied key would be an unsupported second mechanism (§16). A
 * successful response means the broadcast was ACCEPTED/ENQUEUED per the
 * contract (`broadcast.enqueued` is the server's enqueue-attempt count), NOT
 * that WhatsApp delivered anything (§5). Delivery confirmation is out of scope
 * while `ENABLE_WORKER_TRIGGER=false` and no scheduler is production-proven
 * (§6): the composer never polls and never renders "delivered".
 */

/** Fetch the live overview snapshot + composite operational scores. */
export function fetchCommandCenterOverview(
  hospitalId: string,
): Promise<CommandCenterOverviewResponse> {
  return callFunction<CommandCenterOverviewResponse>(
    "command-center",
    { action: "overview" },
    { hospitalId },
  );
}

/** Recent hospital event stream (backend default window: last 24h). */
export function fetchCommandCenterTimeline(
  hospitalId: string,
): Promise<CommandCenterTimelineResponse> {
  return callFunction<CommandCenterTimelineResponse>(
    "command-center",
    { action: "timeline" },
    { hospitalId },
  );
}

/** Backend-generated deterministic projections. Presented, never computed. */
export function fetchCommandCenterPredictive(
  hospitalId: string,
): Promise<CommandCenterPredictiveResponse> {
  return callFunction<CommandCenterPredictiveResponse>(
    "command-center",
    { action: "predictive" },
    { hospitalId },
  );
}

/** Live SLA dashboard for the hospital (backend-scoped by the header). */
export function fetchCommandCenterSla(
  hospitalId: string,
): Promise<CommandCenterSlaResponse> {
  return callFunction<CommandCenterSlaResponse>(
    "command-center",
    { action: "sla_dashboard" },
    { hospitalId },
  );
}

/** Monitoring infrastructure health (queue workers, MVs, DLQ, alerts). */
export function fetchCommandCenterSystemHealth(
  hospitalId: string,
): Promise<CommandCenterSystemHealthResponse> {
  return callFunction<CommandCenterSystemHealthResponse>(
    "command-center",
    { action: "system_health" },
    { hospitalId },
  );
}

// ─── C2b Broadcast Composer mutations ─────────────────────────────────

/** Options for `broadcast_doctor_delay` (backend `Schema` field names). */
export interface DoctorDelayBroadcastOptions {
  queueSessionId: string;
  /** Integer 1–1440, enforced identically by the backend `Schema`. */
  delayMinutes: number;
  /** Optional, max 200 chars (backend `reason`); omitted when blank. */
  reason?: string;
}

/** Options for `broadcast_closure`. Both optional; omitted values use the
 *  backend default (today / no reason). */
export interface ClosureBroadcastOptions {
  /** Optional `YYYY-MM-DD`; the backend defaults to today when absent. */
  date?: string;
  /** Optional, max 200 chars; omitted when blank. */
  reason?: string;
}

/** Options for `broadcast_admin_notice` (`kind` + `message` are required). */
export interface AdminNoticeBroadcastOptions {
  kind: AdminBroadcastKind;
  /** Max 500 chars (backend `message`); required by the backend `Schema`. */
  message: string;
}

/** Options for `broadcast_alert` (`alertId` required; `reason` is NOT read by
 *  this action, so it is never sent). */
export interface AlertBroadcastOptions {
  alertId: string;
}

/**
 * Queue-summary broadcast: the backend fans the current queue snapshot out to
 * the session's queue-active patients (gated on the `whatsapp_queue_updates`
 * flag) and composes each message. The browser supplies ONLY the session id.
 */
export function broadcastQueueSummary(
  hospitalId: string,
  queueSessionId: string,
): Promise<CommandCenterBroadcastResponse> {
  return callFunction<CommandCenterBroadcastResponse>(
    "command-center",
    { action: "broadcast_queue_summary", queueSessionId },
    { hospitalId },
  );
}

/**
 * Doctor-delay broadcast to the session's queue-active patients. `reason` is
 * omitted when blank so the backend default applies; the delay minutes and
 * reason are validated identically client-side for usability but the backend
 * `Schema` is authoritative.
 */
export function broadcastDoctorDelay(
  hospitalId: string,
  options: DoctorDelayBroadcastOptions,
): Promise<CommandCenterBroadcastResponse> {
  return callFunction<CommandCenterBroadcastResponse>(
    "command-center",
    {
      action: "broadcast_doctor_delay",
      queueSessionId: options.queueSessionId,
      delayMinutes: options.delayMinutes,
      ...(options.reason ? { reason: options.reason } : {}),
    },
    { hospitalId },
  );
}

/**
 * Hospital-closure broadcast. The backend resolves the recipient set (every
 * still-active patient in today's queues) and the message itself; the browser
 * sends only the optional date/reason overrides, each omitted when absent.
 */
export function broadcastClosure(
  hospitalId: string,
  options: ClosureBroadcastOptions = {},
): Promise<CommandCenterBroadcastResponse> {
  return callFunction<CommandCenterBroadcastResponse>(
    "command-center",
    {
      action: "broadcast_closure",
      ...(options.date ? { date: options.date } : {}),
      ...(options.reason ? { reason: options.reason } : {}),
    },
    { hospitalId },
  );
}

/**
 * Admin operational notice: delivered to the hospital admins by the backend,
 * which prefixes the exact `[kind]` tag. `kind` and `message` are required by
 * the backend `Schema`; there is no optional field to omit for this action.
 */
export function broadcastAdminNotice(
  hospitalId: string,
  options: AdminNoticeBroadcastOptions,
): Promise<CommandCenterBroadcastResponse> {
  return callFunction<CommandCenterBroadcastResponse>(
    "command-center",
    {
      action: "broadcast_admin_notice",
      kind: options.kind,
      message: options.message,
    },
    { hospitalId },
  );
}

/**
 * Alert broadcast: pushes an existing alert (tenant-checked server-side) to
 * the hospital admins. Only `alertId` is read; the message text is the
 * backend's, composed from the alert row, never re-authored in the browser.
 */
export function broadcastAlert(
  hospitalId: string,
  options: AlertBroadcastOptions,
): Promise<CommandCenterBroadcastResponse> {
  return callFunction<CommandCenterBroadcastResponse>(
    "command-center",
    { action: "broadcast_alert", alertId: options.alertId },
    { hospitalId },
  );
}
