import { callFunction } from "@/lib/api";
import { newIdempotencyKey } from "@/lib/idempotency";
import type { CreateBookingRequest, CreateBookingResponse } from "@/types/api";

/**
 * Canonical booking path (Phase 6 §9/§10/§11). Appointment and walk-in both
 * go through the existing `create-booking` Edge Function — the frontend does
 * NOT duplicate patient identity, fee snapshot, token allocation or tenant
 * checks. `bookingSource: "walkin"` vs `"manual_free"` selects the flow; the
 * backend owns the difference.
 *
 * A fresh Idempotency-Key is minted per logical submission so a double-click
 * or network retry cannot create a duplicate booking/token.
 */
export function createBooking(
  req: CreateBookingRequest,
  hospitalId: string,
  idempotencyKey: string = newIdempotencyKey("create-booking"),
): Promise<CreateBookingResponse> {
  return callFunction<CreateBookingResponse>("create-booking", req, {
    hospitalId,
    idempotencyKey,
  });
}
