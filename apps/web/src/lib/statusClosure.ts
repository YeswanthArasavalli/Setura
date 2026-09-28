/**
 * Reception status-closure presentation (Phase 7 G-02).
 *
 * Mirrors the discipline of `cancellationStatus.ts` and is PRESENTATION ONLY
 * by contract:
 *
 *   - it owns NO authorization. `update-booking-status` applies `requireRole`
 *     + `X-Hospital-ID` + the tenant equality check server-side; the role gate
 *     in the route only decides whether a control is rendered.
 *   - it owns NO state machine. These predicates hide controls the canonical
 *     backend machine (`_shared/booking_state.ts`) would certainly reject for
 *     THIS surface; the server's transition guard, optimistic
 *     `.eq("status", current)` check and `changed:false` replay remain the
 *     only authority over whether a booking changed state.
 *   - queue-owned states (`waiting`, `called`, `in_consultation`) are
 *     deliberately excluded: those bookings are acted on through QueueBoard
 *     (`mark_absent` et al.), not through a manual status control here.
 */

/** Whether Check In may be offered: the backend allows booked → checked_in
 *  and nothing else transitions into `checked_in` for this surface. */
export function canOfferCheckIn(status: string): boolean {
  return status === "booked";
}

/** Whether Mark No-Show may be offered: the backend allows
 *  booked → no_show and checked_in → no_show. Future-date bookings are
 *  exactly the population `queue-control mark_absent` cannot reach (it
 *  filters on a live queue session), which is why this writer exists. */
export function canOfferNoShow(status: string): boolean {
  return status === "booked" || status === "checked_in";
}

/** Server-compatible optional-note boundary (zod `.max(500)`, no minimum).
 *  Returns null when acceptable — including for the empty string, which the
 *  caller omits from the request entirely. */
export const STATUS_NOTE_MAX = 500;

export function statusNoteError(notes: string): string | null {
  if (notes.length > STATUS_NOTE_MAX) {
    return `Note must be at most ${STATUS_NOTE_MAX} characters.`;
  }
  return null;
}

/**
 * Wording after a status attempt, from the backend response only. `changed`
 * false is the intrinsic replay — already in the target state — and reads as
 * a completed outcome, never as an error. No delivery is ever claimed: the
 * no-show WhatsApp job is enqueued server-side and its delivery is a
 * separate, observable-later lifecycle (Notifications surface).
 */
export function statusOutcomeLabel(status: string, changed: boolean): string {
  if (status === "checked_in") {
    return changed
      ? "Patient checked in"
      : "Patient was already checked in (no change)";
  }
  if (status === "no_show") {
    return changed
      ? "Booking marked as no-show"
      : "Booking was already marked no-show (no change)";
  }
  // Defensive: the endpoint can legitimately return other statuses for
  // actors/flows outside this surface; state it plainly, invent nothing.
  return `Status is now ${status.replace("_", " ")}`;
}
