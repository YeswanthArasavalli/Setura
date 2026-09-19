import { describe, expect, it } from "vitest";
import { ApiError, describeError } from "./errors";

function err(status: number, extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {}) {
  return new ApiError({ code: "X", message: "backend message", status, ...extra });
}

describe("ApiError.kind (Phase 6 §18 status→intent mapping)", () => {
  it.each([
    [0, "network"],
    [401, "auth"],
    [403, "forbidden"],
    [422, "validation"],
    [409, "conflict"],
    [429, "rate_limit"],
    [500, "server"],
    [503, "server"],
    [418, "unknown"],
  ] as const)("maps HTTP %i to %s", (status, kind) => {
    expect(err(status).kind).toBe(kind);
  });
});

describe("describeError", () => {
  it("never leaks the raw backend message for auth/forbidden/rate-limit", () => {
    expect(describeError(err(401, { message: "JWT expired internal detail" }))).toBe(
      "Your session expired. Please sign in again.",
    );
    expect(describeError(err(403))).toBe(
      "You do not have permission to perform this action.",
    );
    expect(describeError(err(429))).toContain("Too many requests");
  });

  it("surfaces the client-safe backend message for validation/conflict", () => {
    expect(describeError(err(422, { message: "Phone is required" }))).toBe(
      "Phone is required",
    );
  });

  it("handles plain Errors and unknown values without throwing", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError("string failure")).toBe("An unexpected error occurred.");
  });
});
