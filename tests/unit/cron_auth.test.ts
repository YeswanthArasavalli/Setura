/**
 * tests/unit/cron_auth.test.ts
 *
 * P0-C — fail-closed contract of the shared cron auth primitive.
 *
 * The nightly trigger/wrong-secret pair (P1-07 + P2-09) was resolved
 * by deleting the prohibited worker wake, which also removed the
 * only use of the wrong derived secret. The remaining cron auth
 * boundary was extracted into _shared/cron_auth.ts and is proven
 * here against the four required cases:
 *
 *   correct secret   → accept
 *   missing secret   → reject (header absent)
 *   wrong secret     → reject (same length, and different length)
 *   unconfigured     → reject (fail-closed: no CRON_SECRET means no
 *                      caller can be authorized, never "accept all")
 *
 * Run: deno task test
 */

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  cronSecretMatches,
  verifyCronRequest,
} from "../../supabase/functions/_shared/cron_auth.ts";

const SECRET = "local_only_fake_cron_secret_5150";

function requestWithHeader(value: string | null): Request {
  const headers = new Headers();
  if (value !== null) headers.set("X-Cron-Secret", value);
  return new Request("http://localhost/functions/v1/run-cron-nightly", {
    method: "POST",
    headers,
  });
}

Deno.test("cron auth: correct secret is accepted", () => {
  assertEquals(cronSecretMatches(SECRET, SECRET), true);
  assertEquals(verifyCronRequest(requestWithHeader(SECRET), SECRET), null);
});

Deno.test("cron auth: missing secret header is rejected", () => {
  assertEquals(cronSecretMatches(null, SECRET), false);

  const resp = verifyCronRequest(requestWithHeader(null), SECRET);
  assert(resp, "missing header must be rejected");
  assertEquals(resp.status, 403);
});

Deno.test("cron auth: wrong secret is rejected (equal and unequal length)", () => {
  // Same length, differing bytes — the length fast-path must not be
  // the only defense.
  const sameLengthWrong = "X" + SECRET.slice(1);
  assertEquals(cronSecretMatches(sameLengthWrong, SECRET), false);

  assertEquals(cronSecretMatches("short", SECRET), false);
  assertEquals(cronSecretMatches(SECRET + "extra", SECRET), false);

  const resp = verifyCronRequest(requestWithHeader(sameLengthWrong), SECRET);
  assert(resp, "same-length wrong secret must be rejected");
  assertEquals(resp.status, 403);
});

Deno.test("cron auth: unconfigured expected secret fails closed", () => {
  // Empty CRON_SECRET must never authorize anything — including a
  // caller that (impossibly) sends an empty header.
  assertEquals(cronSecretMatches(SECRET, ""), false);
  assertEquals(cronSecretMatches("", ""), false);
  assertEquals(cronSecretMatches(null, ""), false);

  const resp = verifyCronRequest(requestWithHeader(SECRET), "");
  assert(resp, "unconfigured endpoint must reject every caller");
  assertEquals(resp.status, 403);
});

Deno.test("cron auth: empty provided header is rejected", () => {
  assertEquals(cronSecretMatches("", SECRET), false);

  const resp = verifyCronRequest(requestWithHeader(""), SECRET);
  assert(resp, "empty header must be rejected");
  assertEquals(resp.status, 403);
});

// ─── P0-C / P2-09 / drift D-05: the frozen synchronous-nightly constraint ───

const NIGHTLY_SOURCE = await Deno.readTextFile(
  new URL(
    "../../supabase/functions/run-cron-nightly/index.ts",
    import.meta.url,
  ),
);

Deno.test("nightly: run-cron-nightly must NOT wake the worker (I-03)", () => {
  // The prohibited Step-9 fetch was removed, not repaired. If it is
  // ever reintroduced, this guard fails before the drift can ship.
  assert(
    !NIGHTLY_SOURCE.includes("/run-background-worker"),
    "run-cron-nightly must not call run-background-worker — nightly " +
      "tasks are synchronous by frozen constraint (P2-09/D-05)",
  );
});

Deno.test("nightly: the wrong derived secret pattern is gone (P1-07)", () => {
  assert(
    !NIGHTLY_SOURCE.includes("SUPABASE_SERVICE_KEY.slice"),
    "the P1-07 derived-credential pattern must not return",
  );
});
