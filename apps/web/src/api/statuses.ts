import { callFunction } from "@/lib/api";
import type {
  UpdateBookingStatusRequest,
  UpdateBookingStatusResponse,
} from "@/types/api";

/**
 * Close the reception-side booking lifecycle through the EXISTING
 * `update-booking-status` Edge Function (Phase 7 G-02 status closure).
 *
 * The body carries exactly the backend schema's fields — `bookingId`,
 * `newStatus` and the optional `notes` (omitted, never empty-string, when the
 * staff member typed nothing). The tenant does NOT travel in the body: it uses
 * the established `X-Hospital-ID` header that `callFunction` supplies from the
 * authenticated staff context, and the Edge Function still verifies
 * `booking.hospital_id === hospitalId` itself.
 *
 * No Idempotency-Key is sent: the endpoint does not read the header, and its
 * replay safety is intrinsic — an already-in-target-state request answers
 * `200 { changed: false }` without writing, and the UPDATE carries an
 * optimistic `.eq("status", current)` guard. Nothing else is owned here: role
 * authorization, the canonical state machine, terminal-state protection,
 * concurrency, the `wa_booking_no_show_${bookingId}`-deduped notification
 * enqueue, the SLA refresh and the audit event all stay in the backend.
 */
export function updateBookingStatus(
  req: UpdateBookingStatusRequest,
  hospitalId: string,
): Promise<UpdateBookingStatusResponse> {
  return callFunction<UpdateBookingStatusResponse>(
    "update-booking-status",
    req,
    { hospitalId },
  );
}
