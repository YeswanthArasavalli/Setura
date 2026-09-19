import { BookingForm } from "@/components/BookingForm";

/** Appointment booking (source `manual_free`) via the canonical create-booking
 *  Edge Function — the same path walk-ins use, only the source differs. */
export function BookAppointment() {
  return (
    <BookingForm
      source="manual_free"
      title="New appointment"
      description="Register or reuse a patient and book an appointment. Token allocation, fee snapshot and de-duplication are handled by the backend."
    />
  );
}
