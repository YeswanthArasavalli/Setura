import { callFunction } from "@/lib/api";
import { newIdempotencyKey } from "@/lib/idempotency";
import type { RescheduleBookingRequest, RescheduleBookingResponse } from "@/types/api";

/**
 * Reschedule a booking through the EXISTING `reschedule-booking` Edge Function
 * (G-07 staff reschedule surface).
 *
 * The body carries exactly the fields the backend schema declares — `bookingId`
 * and `newDate`, plus optional `newDoctorId` / `reason`. The tenant does NOT
 * travel in the body: it uses the established `X-Hospital-ID` header that
 * `callFunction` supplies from the authenticated staff context, and the Edge
 * Function still verifies `booking.hospital_id === hospitalId` itself.
 *
 * A fresh Idempotency-Key is minted per logical submission (same convention as
 * `cancel-booking` / `create-booking`) so a double-click or network retry
 * replays instead of producing a second reschedule. The backend feeds that key
 * to BOTH its own idempotency layer and the canonical `create_booking` RPC, so
 * one logical request yields exactly one new booking. Nothing else is owned
 * here: role authorization, tenant isolation, reschedulable-state protection,
 * the optimistic status guard, booking-window / holiday / working-hours / doctor
 * availability validation, the `booking_rescheduled` WhatsApp enqueue and its
 * `wa_reschedule_${newBookingId}` dedupe, the fee-snapshot propagation and the
 * audit event all stay in the backend.
 */
export function rescheduleBooking(
  req: RescheduleBookingRequest,
  hospitalId: string,
  idempotencyKey: string = newIdempotencyKey("reschedule-booking"),
): Promise<RescheduleBookingResponse> {
  return callFunction<RescheduleBookingResponse>("reschedule-booking", req, {
    hospitalId,
    idempotencyKey,
  });
}
