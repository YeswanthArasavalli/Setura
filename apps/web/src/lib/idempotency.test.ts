import { describe, expect, it } from "vitest";
import { newIdempotencyKey } from "./idempotency";

// The backend (extractIdempotencyKey) validates the Idempotency-Key header
// against a strict UUID-v4 regex — this test pins that contract so a future
// "add a prefix for readability" change cannot silently break submissions.
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("newIdempotencyKey (Phase 6 §19)", () => {
  it("emits a bare UUID v4 the backend will accept", () => {
    expect(newIdempotencyKey("create-booking")).toMatch(UUID_V4);
  });

  it("is unique across calls (no accidental key reuse)", () => {
    const seen = new Set(Array.from({ length: 500 }, () => newIdempotencyKey("s")));
    expect(seen.size).toBe(500);
    for (const k of seen) expect(k).toMatch(UUID_V4);
  });
});
