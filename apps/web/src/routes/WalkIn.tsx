import { BookingForm } from "@/components/BookingForm";

/** Walk-in registration (source `walkin`) — same canonical create-booking path
 *  as an appointment; the backend issues the live token for the walk-in. */
export function WalkIn() {
  return (
    <BookingForm
      source="walkin"
      title="New walk-in"
      description="Register a patient arriving now and issue a queue token. The backend allocates the token and applies the fee snapshot."
    />
  );
}
