import { describe, expect, it } from "vitest";
import { notificationStatus } from "@/lib/notificationStatus";

/**
 * The notification status mapping (Phase 7 read-only Notifications surface).
 *
 * Pins the exact backend `public.notification_status` enum (migration 05):
 *   pending · queued · processing · sent · delivered · read · failed ·
 *   retrying · cancelled · permanently_failed
 *
 * Every canonical value must have a deterministic human label and an existing
 * Badge colour, and an unknown value must never be silently folded onto a
 * known state.
 */
const ENUM = [
  "pending",
  "queued",
  "processing",
  "sent",
  "delivered",
  "read",
  "failed",
  "retrying",
  "cancelled",
  "permanently_failed",
] as const;

describe("notificationStatus mapping", () => {
  it("maps every canonical backend enum value to a distinct known label", () => {
    const expected: Record<(typeof ENUM)[number], string> = {
      pending: "Pending",
      queued: "Queued",
      processing: "Processing",
      sent: "Sent",
      delivered: "Delivered",
      read: "Read",
      failed: "Failed",
      retrying: "Retrying",
      cancelled: "Cancelled",
      permanently_failed: "Failed permanently",
    };
    for (const status of ENUM) {
      const s = notificationStatus(status);
      expect(s.key).toBe(status);
      expect(s.label).toBe(expected[status]);
    }
  });

  it("renders 'failed' and 'permanently_failed' with different labels but the " +
    "same destructive colour, and never hides a permanent failure", () => {
    expect(notificationStatus("failed").label).toBe("Failed");
    expect(notificationStatus("permanently_failed").label).toBe(
      "Failed permanently",
    );
    expect(notificationStatus("permanently_failed").variant).toBe("destructive");
  });

  it("uses a success colour for delivered/read and a warning colour for retrying", () => {
    expect(notificationStatus("delivered").variant).toBe("success");
    expect(notificationStatus("read").variant).toBe("success");
    expect(notificationStatus("retrying").variant).toBe("warning");
  });

  it("degrades an unknown/future value honestly instead of inventing a state", () => {
    const s = notificationStatus("some_future_state");
    expect(s.key).toBe("some_future_state");
    expect(s.label).toBe("some future state");
    expect(s.variant).toBe("secondary");
    // A permanent failure must never be rendered from an unknown value.
    expect(s.label).not.toBe("Failed permanently");
  });
});
