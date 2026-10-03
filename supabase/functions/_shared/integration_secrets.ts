/**
 * integration_secrets.ts — WS-ONBOARD-3 trusted-backend secret access
 *
 * The single internal primitive the payment / WhatsApp runtimes use to
 * obtain a platform-global provider credential. It resolves a value in
 * this strict order:
 *
 *   1. Supabase Vault, via the service_role-only
 *      resolve_integration_secret RPC (the ONLY path to Vault material).
 *   2. The existing environment variable (Env.RAZORPAY_KEY_SECRET /
 *      Env.META_ACCESS_TOKEN) as a backward-compatible fallback, so an
 *      un-provisioned host behaves EXACTLY as before this workstream
 *      (spec sec 27 / 28 / 32).
 *
 * Security contract (spec sec 29 / 30):
 *   - This module is imported ONLY by Edge Functions / the worker, never
 *     by frontend code.
 *   - It NEVER logs, returns-through-a-public-API, or embeds a resolved
 *     credential in an error. The caller receives the plaintext so it
 *     can authenticate to the provider; that is the whole point, and the
 *     value must not be forwarded to a client response.
 *   - Missing configuration is distinguished from a provider failure:
 *     an empty resolution means "not configured", never "provider down".
 */

import { Env } from "./env.ts";
import type { Logger } from "./logger.ts";

/** Trusted Supabase client (service_role). Structural to avoid a hard
 *  dependency on the generated Database type at this boundary. Declared as a
 *  method (not an arrow-typed property) so parameter checking is bivariant:
 *  the generated SupabaseClient narrows `fn` to the known RPC-name union,
 *  which must remain assignable to this wider `string` contract. The return
 *  type is `any` because rpc(...) yields a thenable PostgrestFilterBuilder,
 *  not a literal Promise; resolveProviderSecret only awaits it. */
export interface SecretResolverClient {
  // deno-lint-ignore no-explicit-any
  rpc(fn: string, args?: Record<string, unknown>): Promise<any> | any;
}

export type Provider = "razorpay" | "meta_whatsapp";

/**
 * Resolves the platform-global credential for a provider from Vault,
 * falling back to the environment. Returns `null` when neither source
 * is configured (never throws for absence — the caller decides whether
 * an absent credential is a configuration error).
 *
 * A database / RPC error is treated as "Vault unavailable" and falls
 * back to the environment rather than failing the operation, because the
 * pre-WS-ONBOARD-3 behaviour was environment-only and must be preserved.
 */
export async function resolveProviderSecret(
  db: SecretResolverClient,
  provider: Provider,
  envFallback: string,
  logger?: Logger,
): Promise<string | null> {
  let vaultValue: string | null = null;
  try {
    const { data, error } = await db.rpc("resolve_integration_secret", {
      p_provider: provider,
    });
    if (error) {
      // Never log the value; only that the lookup failed.
      logger?.warn("integration secret: Vault lookup error, using fallback", {
        provider,
        code: error.code,
      });
    } else if (typeof data === "string" && data.length > 0) {
      vaultValue = data;
    }
  } catch (err) {
    logger?.warn("integration secret: Vault lookup threw, using fallback", {
      provider,
      // The thrown error is a transport/db error, never a secret; but to
      // be conservative we log only its class, not arbitrary detail.
      kind: err instanceof Error ? err.name : "unknown",
    });
  }

  if (vaultValue !== null) return vaultValue;
  const fallback = (envFallback ?? "").trim();
  return fallback.length > 0 ? fallback : null;
}

/** Razorpay key_secret: Vault-first, then Env.RAZORPAY_KEY_SECRET. */
export function getRazorpayKeySecret(
  db: SecretResolverClient,
  logger?: Logger,
): Promise<string | null> {
  return resolveProviderSecret(db, "razorpay", Env.RAZORPAY_KEY_SECRET, logger);
}

/** Meta / WhatsApp access token: Vault-first, then Env.META_ACCESS_TOKEN. */
export function getMetaAccessToken(
  db: SecretResolverClient,
  logger?: Logger,
): Promise<string | null> {
  return resolveProviderSecret(
    db,
    "meta_whatsapp",
    Env.META_ACCESS_TOKEN,
    logger,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection testing (spec sec 16 / 17)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The complete, sanitized test vocabulary. It NEVER carries a
 * credential, a raw provider body, an Authorization header or provider
 * metadata beyond a coarse classification, so the test endpoint cannot
 * become a secret-exfiltration endpoint.
 */
export const CONNECTION_TEST_RESULTS = [
  "CONNECTED",
  "INVALID_CREDENTIAL",
  "UNAUTHORIZED",
  "PROVIDER_UNAVAILABLE",
  "CONFIGURATION_INVALID",
] as const;

export type ConnectionTestResult = typeof CONNECTION_TEST_RESULTS[number];

function isConnectionTestResult(value: string): value is ConnectionTestResult {
  return (CONNECTION_TEST_RESULTS as readonly string[]).includes(value);
}

/** Parse and sanitize a provider HTTP status into a test result. */
export function mapHttpStatusToTestResult(
  status: number,
): ConnectionTestResult {
  if (status >= 200 && status < 300) return "CONNECTED";
  if (status === 401) return "INVALID_CREDENTIAL";
  if (status === 403) return "UNAUTHORIZED";
  if (status === 400 || status === 404 || status === 422) {
    // A 400/404 on a credential-authenticated read means the
    // credential did not resolve the requested resource.
    return "INVALID_CREDENTIAL";
  }
  if (status >= 500) return "PROVIDER_UNAVAILABLE";
  return "PROVIDER_UNAVAILABLE";
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RazorpayTestInput {
  keyId: string | null;
  keySecret: string | null;
  fetchImpl?: FetchLike;
  /** Overridable for tests; defaults to the live Razorpay host. */
  baseUrl?: string;
}

/**
 * Validates a Razorpay key pair against a safe authenticated read
 * (`/v1/settings`). Executes server-side; returns ONLY a
 * ConnectionTestResult. Never throws with the credential in the message;
 * a network fault maps to PROVIDER_UNAVAILABLE. Absent config maps to
 * CONFIGURATION_INVALID (which is NOT a provider failure).
 *
 * LIVE PROVIDER VERIFICATION IS UNPROVEN locally (no real credentials);
 * the code path is exercised with a stubbed fetch in unit tests.
 */
export async function testRazorpayConnection(
  input: RazorpayTestInput,
): Promise<ConnectionTestResult> {
  const keyId = (input.keyId ?? "").trim();
  const keySecret = (input.keySecret ?? "").trim();
  if (!keyId || !keySecret) return "CONFIGURATION_INVALID";

  const doFetch = input.fetchImpl ?? fetch;
  const url = `${input.baseUrl ?? "https://api.razorpay.com"}/v1/settings`;
  const token = btoa(`${keyId}:${keySecret}`);
  try {
    const res = await doFetch(url, {
      method: "GET",
      headers: { Authorization: `Basic ${token}` },
    });
    return mapHttpStatusToTestResult(res.status);
  } catch {
    return "PROVIDER_UNAVAILABLE";
  }
}

export interface MetaTestInput {
  accessToken: string | null;
  phoneNumberId: string | null;
  apiVersion?: string;
  fetchImpl?: FetchLike;
  /** Overridable for tests; defaults to the live Graph host. */
  baseUrl?: string;
}

/**
 * Validates a Meta access-token / phone-number relationship with a safe
 * read (`GET /{phone-number-id}?fields=id`). Returns ONLY a sanitized
 * ConnectionTestResult; the token is never echoed. Absent config maps to
 * CONFIGURATION_INVALID. LIVE META VERIFICATION IS UNPROVEN locally.
 */
export async function testMetaConnection(
  input: MetaTestInput,
): Promise<ConnectionTestResult> {
  const token = (input.accessToken ?? "").trim();
  const phoneNumberId = (input.phoneNumberId ?? "").trim();
  if (!token || !phoneNumberId) return "CONFIGURATION_INVALID";

  const doFetch = input.fetchImpl ?? fetch;
  const version = input.apiVersion ?? Env.META_API_VERSION ?? "v19.0";
  const base = input.baseUrl ?? "https://graph.facebook.com";
  const url = `${base}/${version}/${
    encodeURIComponent(phoneNumberId)
  }?fields=id`;
  try {
    const res = await doFetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    return mapHttpStatusToTestResult(res.status);
  } catch {
    return "PROVIDER_UNAVAILABLE";
  }
}

/** Defense-in-depth: a public result string is always one of the five. */
export function asConnectionTestResult(value: unknown): ConnectionTestResult {
  const s = String(value ?? "");
  return isConnectionTestResult(s) ? s : "PROVIDER_UNAVAILABLE";
}
