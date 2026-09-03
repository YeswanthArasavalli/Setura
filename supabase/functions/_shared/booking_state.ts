/**
 * booking_state.ts — Single source of truth for booking status
 * transitions.
 *
 * Shared by update-booking-status (doctor/reception workflow) and the
 * Phase 1.2 queue runtime so transition rules are never duplicated.
 */

import type { BookingStatus } from "./types.ts";

/** States from which no further transition is allowed. */
export const TERMINAL_STATES = new Set<BookingStatus>([
  "completed",
  "cancelled",
  "no_show",
  "rescheduled",
]);

/**
 * Allowed transitions. `skipped -> waiting` supports restoring a
 * skipped patient back into the waiting pool (queue control).
 * `in_consultation -> waiting` supports returning an interrupted
 * consultation back to the queue (Phase 1.4 doctor operations).
 */
export const TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  booked: ["checked_in", "cancelled", "no_show", "skipped"],

  checked_in: ["waiting", "cancelled", "no_show"],

  waiting: ["called", "cancelled", "no_show", "skipped"],

  called: ["in_consultation", "no_show", "skipped"],

  in_consultation: ["completed", "cancelled", "waiting"],

  rescheduled: [],
  completed: [],
  cancelled: [],
  no_show: [],
  skipped: ["waiting"],
};

export function isTerminalState(status: BookingStatus): boolean {
  return TERMINAL_STATES.has(status);
}

export function isValidTransition(
  from: BookingStatus,
  to: BookingStatus,
): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}
