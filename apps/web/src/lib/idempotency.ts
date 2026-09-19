/**
 * Idempotency key generation.
 *
 * The browser assumes double-clicks and retries (Phase 6 §19). We generate a
 * stable key per logical submission and reuse it for retries of the SAME
 * submission, so a replay never creates a duplicate booking/token/ledger row.
 * Backend idempotency (Idempotency-Key header + api_idempotency_keys) is the
 * FINAL protection — this only avoids accidental client-side duplication.
 *
 * CONTRACT: `create-booking` (and the shared idempotency layer) validates the
 * header against a strict UUID-v4 regex and rejects anything else with
 * IDEMPOTENCY_KEY_REQUIRED. So the value MUST be a bare UUID v4 — it cannot
 * carry a scope prefix. The `scope` argument is accepted for call-site
 * readability only and is intentionally not embedded.
 */
export function newIdempotencyKey(_scope?: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Fallback (no Web Crypto): a v4-shaped UUID that still passes the backend
  // regex, so a downgrade in a non-secure context never breaks submissions.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
