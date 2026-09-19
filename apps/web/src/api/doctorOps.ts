import { callFunction } from "@/lib/api";
import type {
  DoctorAction,
  DoctorDashboard,
  DoctorOperationsRequest,
  DoctorOperationsResponse,
  QueueSnapshot,
} from "@/types/api";

/**
 * Doctor & clinical operations via the existing `doctor-operations` Edge
 * Function (doctor / hospital_admin / global_admin authorized server-side;
 * doctors may only act on their own session). The console exposes the
 * already-proven consultation workflow and adds no clinical logic (Phase 6
 * §13/§14). Transitions are idempotent on the backend; save_note mints a key.
 */
function op(
  req: DoctorOperationsRequest,
  hospitalId: string,
): Promise<DoctorOperationsResponse> {
  return callFunction<DoctorOperationsResponse>("doctor-operations", req, {
    hospitalId,
  });
}

export const doctorOps = {
  dashboard: (hospitalId: string, doctorId?: string) =>
    op({ action: "dashboard" satisfies DoctorAction, doctorId }, hospitalId),

  startSession: (hospitalId: string) =>
    op({ action: "start_session" }, hospitalId),

  callNext: (queueSessionId: string, hospitalId: string) =>
    op({ action: "call_next", queueSessionId }, hospitalId),

  startConsultation: (queueSessionId: string, bookingId: string, hospitalId: string) =>
    op({ action: "start_consultation", queueSessionId, bookingId }, hospitalId),

  // Notes are immutable appends owned by the backend; no client idempotency
  // key is needed (doctor-operations does not read the Idempotency-Key header).
  saveNote: (
    bookingId: string,
    hospitalId: string,
    notes: string,
    diagnosisSummary?: string,
    queueSessionId?: string,
  ) =>
    op(
      { action: "save_note", queueSessionId, bookingId, notes, diagnosisSummary },
      hospitalId,
    ),

  completeConsultation: (
    queueSessionId: string,
    bookingId: string,
    hospitalId: string,
  ) => op({ action: "complete_consultation", queueSessionId, bookingId }, hospitalId),

  recall: (queueSessionId: string, hospitalId: string) =>
    op({ action: "recall", queueSessionId }, hospitalId),
};

export type { DoctorDashboard, QueueSnapshot };
