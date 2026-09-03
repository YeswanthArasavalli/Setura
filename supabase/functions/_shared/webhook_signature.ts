/**
 * webhook_signature.ts — fail-closed Meta webhook signature verification
 *
 * Meta signs every WhatsApp Cloud API webhook POST with
 *
 *     X-Hub-Signature-256: sha256=<hex hmac of the raw body>
 *
 * keyed by the app secret. The raw request body must be verified
 * byte-for-byte before it is parsed, because a re-serialized body
 * produces a different digest.
 *
 * This module is fail-closed by construction: `verifyMetaSignature`
 * has exactly one success path and every other outcome is a typed
 * rejection reason. A caller cannot accidentally treat "no secret
 * configured" or "no signature header" as success, which is the
 * defect this replaces.
 *
 * Nothing here logs. The secret, the received signature and the
 * computed signature never leave the function, so a caller cannot
 * leak them by logging the result: the reason codes are constants.
 */

/** Reasons a webhook body is not accepted. */
export type SignatureFailureReason =
  /** No app secret configured on this deployment. Server misconfiguration. */
  | "secret_missing"
  /** The request carried no X-Hub-Signature-256 header. */
  | "signature_missing"
  /** Header present but not of the form sha256=<64 hex chars>. */
  | "signature_malformed"
  /** Well-formed header whose digest does not match the body. */
  | "signature_invalid";

export type SignatureVerification =
  | { ok: true }
  | { ok: false; reason: SignatureFailureReason };

const SIGNATURE_PATTERN = /^sha256=[0-9a-f]{64}$/;

/** Lowercase hex HMAC-SHA256 of `message` keyed by `secret`. */
export async function hmacSha256Hex(
  message: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );

  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Length-checked constant-time string comparison.
 *
 * The length check is not a timing leak worth closing: the length of
 * a SHA-256 hex digest is public and fixed. Once the lengths match,
 * every character is compared and the result is folded into a single
 * accumulator, so the loop takes the same time for an early mismatch
 * as for a late one.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;

  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return diff === 0;
}

/**
 * Verify a Meta webhook signature against the raw request body.
 *
 * Contract (all four cases are covered by tests/unit/webhook_signature.test.ts):
 *
 *   appSecret missing/empty   -> { ok: false, reason: "secret_missing" }
 *   signature header absent   -> { ok: false, reason: "signature_missing" }
 *   header not sha256=<hex64> -> { ok: false, reason: "signature_malformed" }
 *   digest mismatch           -> { ok: false, reason: "signature_invalid" }
 *   digest match              -> { ok: true }
 *
 * `rawBody` must be the exact bytes received, as returned by
 * `await req.text()` before any JSON parsing.
 */
export async function verifyMetaSignature(input: {
  rawBody: string;
  signatureHeader: string | null;
  appSecret: string | undefined;
}): Promise<SignatureVerification> {
  const { rawBody, signatureHeader, appSecret } = input;

  if (!appSecret) {
    return { ok: false, reason: "secret_missing" };
  }

  if (!signatureHeader) {
    return { ok: false, reason: "signature_missing" };
  }

  // Meta sends lowercase hex. Normalizing case here keeps the
  // comparison constant-time against a fixed-shape input while
  // still rejecting anything that is not a SHA-256 hex digest.
  const received = signatureHeader.trim().toLowerCase();

  if (!SIGNATURE_PATTERN.test(received)) {
    return { ok: false, reason: "signature_malformed" };
  }

  const expected = `sha256=${await hmacSha256Hex(rawBody, appSecret)}`;

  if (!constantTimeEqual(expected, received)) {
    return { ok: false, reason: "signature_invalid" };
  }

  return { ok: true };
}

/**
 * HTTP status for a rejection.
 *
 * A missing secret is a deployment fault, not a client fault, so it
 * is reported as 500 — the same shape the GET verification branch
 * uses for a missing META_WEBHOOK_VERIFY_TOKEN. Every signature
 * problem is attributable to the caller and is reported as 403.
 *
 * Neither is 200: the "always return 200 to Meta" rule exists to
 * stop retry storms for *internal processing* failures. An unsigned
 * or wrongly signed request is not from Meta, so there is no retry
 * loop to protect and no reason to acknowledge it.
 */
export function signatureFailureStatus(
  reason: SignatureFailureReason,
): number {
  return reason === "secret_missing" ? 500 : 403;
}
