/**
 * phone.ts — Country-code-aware E.164 formatting.
 *
 * Removes hardcoded +91 assumptions from the edge layer. The
 * country code resolves in priority order:
 *
 *   1. Hospital override: hospital_settings.metadata.country_code
 *      (hospital-specific phone normalization).
 *   2. Platform default: system_settings key 'default_country_code'.
 *   3. Env override: SETURA_DEFAULT_COUNTRY_CODE.
 *   4. Fallback: '91' (current single-market deployment).
 *
 * Phones already carrying a '+' are passed through untouched.
 */

import type { DbClient } from "./db.ts";

const FALLBACK_COUNTRY_CODE = "91";

/** Renders a normalized 10-digit phone in E.164 with a country code. */
export function toE164WithCode(phone: string, countryCode: string): string {
  if (phone.startsWith("+")) return phone;
  return `+${countryCode.replace(/\D/g, "")}${phone}`;
}

/**
 * Resolves the effective country code for a hospital. Best-effort:
 * any lookup failure falls back to the env/platform default so
 * messaging is never blocked by a settings error.
 */
export async function resolveCountryCode(
  db: DbClient,
  hospitalId?: string | null,
): Promise<string> {
  try {
    if (hospitalId) {
      const { data } = await db
        .from("hospital_settings")
        .select("metadata")
        .eq("hospital_id", hospitalId)
        .maybeSingle();

      const override = (data?.metadata as Record<string, unknown> | null)
        ?.country_code;

      if (typeof override === "string" && override.trim().length > 0) {
        return override.replace(/\D/g, "");
      }
    }

    const { data } = await db
      .from("system_settings")
      .select("value")
      .eq("key", "default_country_code")
      .maybeSingle();

    const platform = data?.value;
    if (typeof platform === "string" && platform.trim().length > 0) {
      return platform.replace(/\D/g, "");
    }
  } catch {
    // Fall through to env/fallback.
  }

  return Deno.env.get("SETURA_DEFAULT_COUNTRY_CODE") ??
    FALLBACK_COUNTRY_CODE;
}

/** Formats a stored (normalized) phone into E.164 for delivery. */
export async function formatE164(
  db: DbClient,
  phone: string,
  hospitalId?: string | null,
): Promise<string> {
  if (phone.startsWith("+")) return phone;
  const code = await resolveCountryCode(db, hospitalId);
  return toE164WithCode(phone, code);
}
