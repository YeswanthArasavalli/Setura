/**
 * rate_limit.ts — Distributed rate limiting
 *
 * Uses the booking_attempt_logs table (Script 09) as the backing store.
 * Sliding window: counts attempts within the last N minutes.
 * Distributed-safe: each check is a DB read — no in-memory state
 * that would be lost across Edge Function cold starts.
 */

import { getServiceClient } from "./db.ts";
import { RateLimitError } from "./errors.ts";
import { normalizePhone } from "./validation.ts";
import { Env } from "./env.ts";
import type { Logger } from "./logger.ts";

export interface RateLimitConfig {
  windowMinutes?: number;
  maxAttempts?: number;
  hospitalId: string;
}

/**
 * Checks rate limit for a phone number, then logs the attempt.
 * Throws RateLimitError if limit exceeded.
 * Always call this BEFORE creating the booking — on success, the attempt is logged.
 */
export async function checkAndLogBookingAttempt(
  phone: string,
  ip: string | null,
  config: RateLimitConfig,
  logger: Logger,
): Promise<void> {
  const normalized = normalizePhone(phone);
  const windowMinutes = config.windowMinutes ?? Env.RATE_LIMIT_WINDOW_MINUTES;
  const maxAttempts = config.maxAttempts ?? Env.RATE_LIMIT_MAX_ATTEMPTS;

  const db = getServiceClient();

  // Check if phone is blocked
  const { data: blocked } = await db
    .from("blocked_numbers")
    .select("id")
    .eq("hospital_id", config.hospitalId)
    .eq("normalized_phone", normalized)
    .eq("restriction_status", "active")
    .gt("blocked_until", new Date().toISOString())
    .single();

  if (blocked) {
    logger.warn("Phone is blocked", {
      phone: normalized,
      hospitalId: config.hospitalId,
    });
    throw new RateLimitError(3600, {
      reason: "PHONE_BLOCKED",
      phone: normalized,
    });
  }

  // Count recent attempts
  const windowStart = new Date(
    Date.now() - windowMinutes * 60 * 1000,
  ).toISOString();

  const { count, error } = await db
    .from("booking_attempt_logs")
    .select("id", { count: "exact", head: true })
    .eq("hospital_id", config.hospitalId)
    .eq("normalized_phone", normalized)
    .gte("created_at", windowStart);

  if (error) {
    // Fail open on DB error — don't block legitimate requests
    logger.warn("Rate limit check failed, proceeding", {
      error: error.message,
    });
    return;
  }

  if ((count ?? 0) >= maxAttempts) {
    // Log the failed attempt
    await db.from("booking_attempt_logs").insert({
      hospital_id: config.hospitalId,
      normalized_phone: normalized,
      ip_address: ip,
      success: false,
    });

    logger.warn("Rate limit exceeded", {
      phone: normalized,
      count,
      windowMinutes,
      maxAttempts,
    });

    const retryAfterSecs = windowMinutes * 60;
    throw new RateLimitError(retryAfterSecs, {
      phone: normalized,
      windowMinutes,
      maxAttempts,
    });
  }

  // Log the attempt
  await db.from("booking_attempt_logs").insert({
    hospital_id: config.hospitalId,
    normalized_phone: normalized,
    ip_address: ip,
    success: true,
  });
}

/**
 * Extracts the caller IP from Supabase Edge Function request headers.
 */
export function extractIp(req: Request): string | null {
  return (
    req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
      req.headers.get("CF-Connecting-IP") ??
      req.headers.get("X-Real-IP") ??
      null
  );
}
