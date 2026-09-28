import { callFunction } from "@/lib/api";
import type {
  CommandCenterOverviewResponse,
  CommandCenterPredictiveResponse,
  CommandCenterSlaResponse,
  CommandCenterSystemHealthResponse,
  CommandCenterTimelineResponse,
} from "@/types/api";

/**
 * Read-only boundary over the EXISTING `command-center` Edge Function
 * (Phase 7 G-03 admin command centre).
 *
 * The console owns nothing here: the five wrappers below send exactly the
 * actions the backend schema accepts, with no body fields beyond what
 * `command-center/index.ts` actually reads. Role + tenant authorization is
 * re-resolved server-side (`requireRole` + `X-Hospital-ID` verification) —
 * the tenant travels ONLY in the header `callFunction` sets from the
 * authenticated staff context, never in the body and never from the URL.
 *
 * The backend's `broadcast_*` actions are deliberately NOT wrapped: this
 * surface can only read. There is no mutation path to introduce by accident.
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
