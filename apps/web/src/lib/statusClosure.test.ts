import { describe, expect, it } from "vitest";

import {
  canOfferCheckIn,
  canOfferNoShow,
  statusNoteError,
  statusOutcomeLabel,
} from "@/lib/statusClosure";

/**
 * The presentation-only visibility predicates behind the G-02 status-closure
 * surface. They mirror the canonical backend machine (`_shared/booking_state
 * .ts`) ONLY to hide controls the server would certainly reject for this
 * surface; the integration suite owns the server-side truth. The full runtime
 * status set (pg_enum `booking_status`) is enumerated here so no state can
 * accidentally acquire a control the backend would refuse.
 */
const ALL_STATUSES = [
  "booked",
  "checked_in",
  "waiting",
  "called",
  "in_consultation",
  "completed",
  "cancelled",
  "no_show",
  "rescheduled",
  "skipped",
];

describe("canOfferCheckIn", () => {
  it("is offered for exactly the booked state", () => {
    expect(ALL_STATUSES.filter(canOfferCheckIn)).toEqual(["booked"]);
  });
});

describe("canOfferNoShow", () => {
  it("is offered for booked and checked_in only", () => {
    expect(ALL_STATUSES.filter(canOfferNoShow)).toEqual([
      "booked",
      "checked_in",
    ]);
  });

  it("never offers a control on a terminal or queue-owned state", () => {
    for (const status of [
      "completed",
      "cancelled",
      "no_show",
      "rescheduled",
      "waiting",
      "called",
      "in_consultation",
    ]) {
      expect(canOfferNoShow(status)).toBe(false);
    }
  });
});

describe("statusNoteError", () => {
  it("accepts the empty note (the key is then omitted) up to 500 characters", () => {
    expect(statusNoteError("")).toBeNull();
    expect(statusNoteError("x")).toBeNull();
    expect(statusNoteError("y".repeat(500))).toBeNull();
  });

  it("rejects past the server boundary without altering the text", () => {
    expect(statusNoteError("z".repeat(501))).toMatch(/at most 500/);
  });
});

describe("statusOutcomeLabel", () => {
  it("reads an intrinsic replay as a completed outcome, not an error", () => {
    expect(statusOutcomeLabel("checked_in", false)).toBe(
      "Patient was already checked in (no change)",
    );
    expect(statusOutcomeLabel("no_show", false)).toBe(
      "Booking was already marked no-show (no change)",
    );
  });

  it("states real transitions plainly", () => {
    expect(statusOutcomeLabel("checked_in", true)).toBe("Patient checked in");
    expect(statusOutcomeLabel("no_show", true)).toBe(
      "Booking marked as no-show",
    );
  });

  it("never claims a notification was sent", () => {
    for (const changed of [true, false]) {
      for (const status of ["checked_in", "no_show", "waiting"]) {
        expect(statusOutcomeLabel(status, changed)).not.toMatch(
          /whatsapp|sent|notified/i,
        );
      }
    }
  });
});
