/**
 * _shared/cron_auth.ts — fail-closed cron secret verification
 *
 * Extracted from the inline comparison duplicated across cron
 * endpoints (P0-C). The contract these functions encode is the
 * security boundary proven by tests/unit/cron_auth.test.ts:
 *
 *   1. Missing header                → reject
 *   2. Unconfigured expected secret  → reject (fail-closed: an
 *      endpoint with no CRON_SECRET serves NO authorized caller)
 *   3. Length mismatch               → reject
 *   4. Any byte mismatch             → reject
 *   5. Exact match                   → accept
 *
 * Comparison is constant-time in the matching path (full-length XOR
 * scan) so a wrong secret does not leak its earliest-differing byte
 * through response timing. Never log or echo secret material.
 */

/** True only when `provided` exactly equals `expected`. */
export function cronSecretMatches(
  provided: string | null,
  expected: string,
): boolean {
  if (!provided || !expected) {
    return false;
  }

  if (provided.length !== expected.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }

  return diff === 0;
}

/**
 * Verify the `X-Cron-Secret` header on a request against the
 * endpoint's configured secret. Returns null when authenticated,
 * or the 403 Response the caller must return.
 */
export function verifyCronRequest(
  req: Request,
  expectedSecret: string,
): Response | null {
  const provided = req.headers.get("X-Cron-Secret");

  if (!cronSecretMatches(provided, expectedSecret)) {
    return new Response("Forbidden", { status: 403 });
  }

  return null;
}
