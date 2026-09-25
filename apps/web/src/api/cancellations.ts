import { callFunction } from "@/lib/api";
import { newIdempotencyKey } from "@/lib/idempotency";
import type { CancelBookingRequest, CancelBookingResponse } from "@/types/api";

/**
 * Cancel a booking through the EXISTING `cancel-booking` Edge Function
 * (Phase 7 cancellation control surface).
 *
 * The body carries exactly the three fields the backend schema declares —
 * `bookingId`, `cancellationReason`, `initiateRefund`. The tenant does NOT
 * travel in the body: it uses the established `X-Hospital-ID` header that
 * `callFunction` supplies from the authenticated staff context, and the Edge
 * Function still verifies `booking.hospital_id === hospitalId` itself.
 *
 * A fresh Idempotency-Key is minted per logical submission (same convention as
 * `create-booking`) so a double-click or network retry replays instead of
 * re-transitioning. Nothing else is owned here: role authorization,
 * terminal-state protection, optimistic concurrency, refund validity/amount,
 * queue recalculation, the WhatsApp cancellation enqueue + its
 * `wa_cancel_${bookingId}` dedupe and the audit event all stay in the backend.
 */
export function cancelBooking(
  req: CancelBookingRequest,
  hospitalId: string,
  idempotencyKey: string = newIdempotencyKey("cancel-booking"),
): Promise<CancelBookingResponse> {
  return callFunction<CancelBookingResponse>("cancel-booking", req, {
    hospitalId,
    idempotencyKey,
  });
}
