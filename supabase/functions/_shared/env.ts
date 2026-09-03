/**
 * env.ts — Typed environment validation
 *
 * Validates environment variables during module load.
 * Fails fast during cold start instead of causing runtime failures.
 *
 * Usage:
 *
 * Inside _shared:
 *   import { Env } from "./env.ts";
 *
 * Outside _shared:
 *   import { Env } from "../_shared/env.ts";
 */

type AppEnvironment = "development" | "production" | "test";

function requireEnv(key: string): string {
  const value = Deno.env.get(key)?.trim();

  if (!value) {
    throw new Error(
      `[env] FATAL: Required environment variable "${key}" is missing or empty`,
    );
  }

  return value;
}

function optionalEnv(
  key: string,
  defaultValue = "",
): string {
  return Deno.env.get(key)?.trim() ?? defaultValue;
}

function requireUrlEnv(key: string): string {
  const value = requireEnv(key);

  try {
    new URL(value);
  } catch {
    throw new Error(
      `[env] FATAL: "${key}" must be a valid URL. Got: "${value}"`,
    );
  }

  return value;
}

function optionalIntEnv(
  key: string,
  defaultValue: number,
): number {
  const raw = optionalEnv(key, String(defaultValue));
  const parsed = Number.parseInt(raw, 10);

  if (Number.isNaN(parsed)) {
    throw new Error(
      `[env] FATAL: "${key}" must be an integer. Got: "${raw}"`,
    );
  }

  return parsed;
}

function optionalBooleanEnv(
  key: string,
  defaultValue = false,
): boolean {
  const raw = optionalEnv(key, String(defaultValue)).toLowerCase();

  return raw === "true" ||
    raw === "1" ||
    raw === "yes";
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Supabase
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = requireUrlEnv("SUPABASE_URL");

const SUPABASE_ANON_KEY = requireEnv(
  "SUPABASE_ANON_KEY",
);

const SUPABASE_SERVICE_KEY = requireEnv(
  "SUPABASE_SERVICE_ROLE_KEY",
);

// ─────────────────────────────────────────────────────────────────────────────
// Application
// ─────────────────────────────────────────────────────────────────────────────

const APP_ENV = optionalEnv(
  "APP_ENV",
  "production",
) as AppEnvironment;

if (
  !["development", "production", "test"]
    .includes(APP_ENV)
) {
  throw new Error(
    `[env] FATAL: Invalid APP_ENV "${APP_ENV}"`,
  );
}

const IS_PRODUCTION = APP_ENV === "production";
const IS_DEVELOPMENT = APP_ENV === "development";
const IS_TEST = APP_ENV === "test";

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp / Meta
// ─────────────────────────────────────────────────────────────────────────────

const META_ACCESS_TOKEN = optionalEnv("META_ACCESS_TOKEN");

const META_APP_SECRET = optionalEnv("META_APP_SECRET");

const META_WEBHOOK_VERIFY_TOKEN = optionalEnv("META_WEBHOOK_VERIFY_TOKEN");

const META_PHONE_NUMBER_ID = optionalEnv("META_PHONE_NUMBER_ID");

const META_API_VERSION = optionalEnv("META_API_VERSION", "v19.0");

// ─────────────────────────────────────────────────────────────────────────────
// Razorpay
// ─────────────────────────────────────────────────────────────────────────────

const RAZORPAY_KEY_ID = optionalEnv("RAZORPAY_KEY_ID");

const RAZORPAY_KEY_SECRET = optionalEnv("RAZORPAY_KEY_SECRET");

// ─────────────────────────────────────────────────────────────────────────────
// Cron / internal scheduling
// ─────────────────────────────────────────────────────────────────────────────

// Shared secret for X-Cron-Secret header auth on cron-triggered
// functions. Empty = fail-closed (all cron endpoints return 403).
const CRON_SECRET = optionalEnv("CRON_SECRET");

// Shared secret for X-Worker-Secret header auth between the
// background worker and worker-dispatch endpoints.
const WORKER_SECRET = optionalEnv("WORKER_SECRET");

// "true" enables cron-minute triggering of the background worker.
const ENABLE_WORKER_TRIGGER = optionalEnv("ENABLE_WORKER_TRIGGER");

// ─────────────────────────────────────────────────────────────────────────────
// Observability
// ─────────────────────────────────────────────────────────────────────────────

const LOG_LEVEL = optionalEnv(
  "LOG_LEVEL",
  IS_PRODUCTION ? "info" : "debug",
);

const SENTRY_DSN = optionalEnv("SENTRY_DSN");

const DEPLOYMENT_VERSION = optionalEnv("DEPLOYMENT_VERSION", "unknown");

// ─────────────────────────────────────────────────────────────────────────────
// Runtime Limits
// ─────────────────────────────────────────────────────────────────────────────

const MAX_BOOKING_ADVANCE_DAYS = optionalIntEnv(
  "MAX_BOOKING_ADVANCE_DAYS",
  7,
);

const DEFAULT_WORKER_LEASE_SECS = optionalIntEnv(
  "WORKER_LEASE_SECS",
  30,
);

const IDEMPOTENCY_TTL_HOURS = optionalIntEnv(
  "IDEMPOTENCY_TTL_HOURS",
  24,
);

const RATE_LIMIT_WINDOW_MINUTES = optionalIntEnv(
  "RATE_LIMIT_WINDOW_MINUTES",
  10,
);

const RATE_LIMIT_MAX_ATTEMPTS = optionalIntEnv(
  "RATE_LIMIT_MAX_ATTEMPTS",
  5,
);

// ─────────────────────────────────────────────────────────────────────────────
// Feature Flags
// ─────────────────────────────────────────────────────────────────────────────

const ENABLE_TRACING = optionalBooleanEnv(
  "ENABLE_TRACING",
  true,
);

const ENABLE_METRICS = optionalBooleanEnv(
  "ENABLE_METRICS",
  true,
);

// ─────────────────────────────────────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS_RAW = optionalEnv(
  "ALLOWED_ORIGINS",
  IS_PRODUCTION
    ? "https://setura.in,https://app.setura.in"
    : "http://localhost:3000,http://localhost:5173",
);

const ALLOWED_ORIGINS = ALLOWED_ORIGINS_RAW
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

export const Env = Object.freeze(
  {
    // Supabase
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_KEY,

    // Application
    APP_ENV,
    IS_PRODUCTION,
    IS_DEVELOPMENT,
    IS_TEST,

    // WhatsApp
    META_ACCESS_TOKEN,
    META_APP_SECRET,
    META_WEBHOOK_VERIFY_TOKEN,
    META_PHONE_NUMBER_ID,
    META_API_VERSION,

    // Razorpay
    RAZORPAY_KEY_ID,
    RAZORPAY_KEY_SECRET,

    // Cron
    CRON_SECRET,
    WORKER_SECRET,
    ENABLE_WORKER_TRIGGER,

    // Observability
    LOG_LEVEL,
    SENTRY_DSN,
    DEPLOYMENT_VERSION,

    // Runtime
    MAX_BOOKING_ADVANCE_DAYS,
    DEFAULT_WORKER_LEASE_SECS,
    IDEMPOTENCY_TTL_HOURS,
    RATE_LIMIT_WINDOW_MINUTES,
    RATE_LIMIT_MAX_ATTEMPTS,

    // Feature Flags
    ENABLE_TRACING,
    ENABLE_METRICS,

    // CORS
    ALLOWED_ORIGINS,
  } as const,
);

export type AppEnv = typeof APP_ENV;
export type Environment = typeof Env;
