import { callFunction } from "@/lib/api";
import type {
  QueueControlAction,
  QueueControlRequest,
  QueueControlResponse,
  QueueSnapshot,
} from "@/types/api";

/**
 * Queue control via the existing `queue-control` Edge Function (receptionist
 * / hospital_admin / global_admin authorized server-side). The console never
 * reimplements queue state transitions (Phase 6 §12/§20): every action returns
 * a fresh snapshot so the UI converges to DB truth in one round-trip.
 */
export function queueControl(
  req: QueueControlRequest,
  hospitalId: string,
): Promise<QueueControlResponse> {
  return callFunction<QueueControlResponse>("queue-control", req, {
    hospitalId,
  });
}

/** Read-only full queue state (the recovery/snapshot primitive). */
export async function getQueueSnapshot(
  queueSessionId: string,
  hospitalId: string,
): Promise<QueueSnapshot> {
  const res = await queueControl(
    { queueSessionId, action: "snapshot" satisfies QueueControlAction },
    hospitalId,
  );
  return res.snapshot;
}
