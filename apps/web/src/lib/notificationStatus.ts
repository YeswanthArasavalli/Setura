import type { BadgeProps } from "@/components/ui/badge";

/**
 * Notification delivery-status presentation (Phase 7 read-only Notifications
 * surface).
 *
 * The backend `public.notification_status` enum (migration 05) is the single
 * source of truth for the lifecycle:
 *
 *   pending · queued · processing · sent · delivered · read · failed ·
 *   retrying · cancelled · permanently_failed
 *
 * This helper is PRESENTATION ONLY. It owns no delivery rule, guesses no new
 * state, and never renames a backend state in a way that hides its meaning —
 * it gives each canonical value a deterministic human label and an existing
 * `Badge` colour. An unknown/future value degrades to a neutral, honestly
 * formatted label rather than being silently mapped onto a known state.
 */
export type NotificationStatusKey =
  | "pending"
  | "queued"
  | "processing"
  | "sent"
  | "delivered"
  | "read"
  | "failed"
  | "retrying"
  | "cancelled"
  | "permanently_failed";

export interface NotificationStatus {
  /** The backend enum value this maps to (or the raw input when unknown). */
  key: string;
  /** Exact badge text. */
  label: string;
  /** Existing `Badge` variant — no new styling infrastructure. */
  variant: NonNullable<BadgeProps["variant"]>;
}

/** Deterministic label + colour for each canonical backend status. */
const MAP: Record<NotificationStatusKey, Omit<NotificationStatus, "key">> = {
  pending: { label: "Pending", variant: "secondary" },
  queued: { label: "Queued", variant: "secondary" },
  processing: { label: "Processing", variant: "default" },
  sent: { label: "Sent", variant: "default" },
  delivered: { label: "Delivered", variant: "success" },
  read: { label: "Read", variant: "success" },
  failed: { label: "Failed", variant: "destructive" },
  retrying: { label: "Retrying", variant: "warning" },
  cancelled: { label: "Cancelled", variant: "outline" },
  permanently_failed: { label: "Failed permanently", variant: "destructive" },
};

export function notificationStatus(status: string): NotificationStatus {
  const known = MAP[status as NotificationStatusKey];
  if (known) return { key: status, ...known };
  // Unknown / not-yet-modelled value: show it honestly, never fabricated onto
  // a known state's colour or wording.
  return {
    key: status,
    label: status.replace(/_/g, " "),
    variant: "secondary",
  };
}
