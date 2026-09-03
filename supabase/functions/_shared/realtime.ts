/**
 * realtime.ts — Supabase Realtime event emission helpers
 *
 * Edge Functions cannot push directly to Realtime channels.
 * Instead, we mutate the tables that Realtime is subscribed to,
 * which triggers the replication stream automatically.
 *
 * For queue display screens and dashboards:
 *   - bookings table changes → triggers queue display refresh
 *   - queue_sessions table changes → triggers live token update
 *   - hospital_online_state table changes → triggers presence indicator
 *
 * This module provides typed helpers that perform the correct mutations
 * to trigger the right Realtime events.
 */

import { getServiceClient } from "./db.ts";
import type { Logger } from "./logger.ts";

/**
 * Refreshes the hospital's current live token number in queue_sessions.
 * Subscribed clients receive the update via Realtime.
 */
export async function broadcastQueueAdvance(
  queueSessionId: string,
  newLiveToken: number,
  logger: Logger,
): Promise<void> {
  try {
    const db = getServiceClient();
    await db
      .from("queue_sessions")
      .update({
        current_live_token: newLiveToken,
        updated_at: new Date().toISOString(),
      })
      .eq("id", queueSessionId);
  } catch (err) {
    logger.error("Failed to broadcast queue advance", err, {
      queueSessionId,
      newLiveToken,
    });
  }
}

/**
 * Updates hospital_online_state to trigger presence refresh.
 * Called after each heartbeat.
 */
export async function broadcastPresenceUpdate(
  hospitalId: string,
  isOnline: boolean,
  activeUsers: number,
  logger: Logger,
): Promise<void> {
  try {
    const db = getServiceClient();
    await db
      .from("hospital_online_state")
      .upsert({
        hospital_id: hospitalId,
        is_online: isOnline,
        active_users: activeUsers,
        updated_at: new Date().toISOString(),
      })
      .eq("hospital_id", hospitalId);
  } catch (err) {
    logger.error("Failed to broadcast presence update", err, { hospitalId });
  }
}
