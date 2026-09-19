/**
 * tests/unit/settlement_record_payment.test.ts
 *
 * P0-D static regression guard.
 *
 * The defect: settlement-engine's `record_payment` action called the SQL
 * no-op `record_settlement_payment()` (migration 33 reduced it to
 * `RETURN FALSE`) and then threw InternalError("Settlement payment RPC
 * returned false"), so EVERY such request returned HTTP 500.
 *
 * These guards fail if the always-500 code path is ever reintroduced, and
 * positively assert the honest replacement (NotImplementedError → 501) is
 * wired into the router. Static source checks only — the behavioral 501 is
 * proven by tests/integration/settlement_record_payment.test.ts.
 */

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const SRC_URL = new URL(
  "../../supabase/functions/settlement-engine/index.ts",
  import.meta.url,
);

async function source(): Promise<string> {
  try {
    return await Deno.readTextFile(SRC_URL);
  } catch (err) {
    throw new Error(
      `Cannot read settlement-engine source (needs --allow-read): ${
        (err as Error).message
      }`,
    );
  }
}

Deno.test("settlement-engine: no longer calls the no-op record_settlement_payment RPC", async () => {
  const src = await source();
  assertEquals(
    src.includes("record_settlement_payment"),
    false,
    "The deprecated no-op RPC must not be invoked from the Edge Function.",
  );
});

Deno.test("settlement-engine: the always-500 message is gone", async () => {
  const src = await source();
  assertEquals(
    src.includes("Settlement payment RPC returned false"),
    false,
    "The InternalError that produced the guaranteed HTTP 500 must be removed.",
  );
});

Deno.test("settlement-engine: record_payment short-circuits to NotImplementedError", async () => {
  const src = await source();
  // The retired action must be intercepted and answered honestly.
  assertStringIncludes(src, "NotImplementedError");
  const guard = src.indexOf('if (body.action === "record_payment")');
  assertEquals(
    guard > -1,
    true,
    "Expected an explicit record_payment short-circuit branch.",
  );
  // The no-op-RPC 500 used to live inside the idempotency callback (after
  // the `await withIdempotency` call). The short-circuit must run BEFORE it,
  // so no idempotency claim / RPC / audit / balance mutation can occur. We
  // match the call site, not the `withIdempotency` import binding.
  const idem = src.indexOf("await withIdempotency");
  assertEquals(
    idem === -1 || guard < idem,
    true,
    "record_payment must be rejected before the idempotency-wrapped block.",
  );
});
