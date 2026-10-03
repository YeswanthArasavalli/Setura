/**
 * tests/unit/integration_secrets.test.ts — WS-ONBOARD-3
 *
 * Pure unit coverage for the trusted-backend secret resolver and the
 * sanitized connection-test helpers in
 * `supabase/functions/_shared/integration_secrets.ts`.
 *
 * These modules transitively import `_shared/env.ts`, which validates
 * required environment variables at module load, so `setup_env.ts` MUST be
 * the first import. The Supabase client and the network `fetch` are supplied
 * as deterministic fakes — no database, no live provider. LIVE PROVIDER
 * VERIFICATION is therefore explicitly UNPROVEN here; what is proven is the
 * pure control flow: Vault-first resolution, env fallback, and that the
 * connection helpers NEVER surface a credential and map every transport /
 * HTTP outcome to exactly one of the five sanitized results.
 */

import "../utils/setup_env.ts";

import {
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  asConnectionTestResult,
  CONNECTION_TEST_RESULTS,
  getMetaAccessToken,
  getRazorpayKeySecret,
  mapHttpStatusToTestResult,
  resolveProviderSecret,
  type SecretResolverClient,
  testMetaConnection,
  testRazorpayConnection,
} from "../../supabase/functions/_shared/integration_secrets.ts";

// ─── Fake Supabase client ────────────────────────────────────────────────────

interface RpcCall {
  fn: string;
  // deno-lint-ignore no-explicit-any
  args: any;
}

function fakeDb(
  response:
    | { data: unknown; error: unknown }
    | ((fn: string, args: Record<string, unknown>) => {
      data: unknown;
      error: unknown;
    }),
): { client: SecretResolverClient; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const client: SecretResolverClient = {
    // deno-lint-ignore no-explicit-any
    rpc(fn: string, args?: Record<string, unknown>): Promise<any> {
      calls.push({ fn, args });
      const r = typeof response === "function"
        ? response(fn, args ?? {})
        : response;
      return Promise.resolve(r);
    },
  };
  return { client, calls };
}

// ─── resolveProviderSecret ───────────────────────────────────────────────────

Deno.test("resolve: Vault value wins over env fallback", async () => {
  const { client, calls } = fakeDb({ data: "vault-secret", error: null });
  const out = await resolveProviderSecret(client, "razorpay", "env-secret");
  assertEquals(out, "vault-secret");
  assertEquals(calls[0].fn, "resolve_integration_secret");
  assertEquals(calls[0].args.p_provider, "razorpay");
});

Deno.test("resolve: Vault RPC error falls back to env (preserve pre-WS-ONBOARD-3 behaviour)", async () => {
  const { client } = fakeDb({ data: null, error: { code: "42501" } });
  const out = await resolveProviderSecret(client, "razorpay", "env-secret");
  assertEquals(out, "env-secret");
});

Deno.test("resolve: Vault NULL (un-provisioned) falls back to env", async () => {
  const { client } = fakeDb({ data: null, error: null });
  const out = await resolveProviderSecret(client, "meta_whatsapp", "env-token");
  assertEquals(out, "env-token");
});

Deno.test("resolve: empty Vault string is treated as absent and falls back to env", async () => {
  const { client } = fakeDb({ data: "", error: null });
  const out = await resolveProviderSecret(client, "razorpay", "env-secret");
  assertEquals(out, "env-secret");
});

Deno.test("resolve: neither Vault nor env configured -> null (never throws)", async () => {
  const { client } = fakeDb({ data: null, error: null });
  const out = await resolveProviderSecret(client, "razorpay", "   ");
  assertEquals(out, null);
});

Deno.test("resolve: a thrown transport error is swallowed and falls back to env", async () => {
  const client: SecretResolverClient = {
    rpc(): Promise<never> {
      throw new Error("socket closed");
    },
  };
  const out = await resolveProviderSecret(client, "razorpay", "env-secret");
  assertEquals(out, "env-secret");
});

Deno.test("getRazorpayKeySecret / getMetaAccessToken route the correct provider to Vault", async () => {
  const { client: rzp, calls: rzpCalls } = fakeDb({
    data: "rzp-vault",
    error: null,
  });
  assertEquals(await getRazorpayKeySecret(rzp), "rzp-vault");
  assertEquals(rzpCalls[0].args.p_provider, "razorpay");

  const { client: meta, calls: metaCalls } = fakeDb({
    data: "meta-vault",
    error: null,
  });
  assertEquals(await getMetaAccessToken(meta), "meta-vault");
  assertEquals(metaCalls[0].args.p_provider, "meta_whatsapp");
});

// ─── mapHttpStatusToTestResult ────────────────────────────────────────────────

Deno.test("mapHttpStatus: 2xx -> CONNECTED, 401/400/404/422 -> INVALID_CREDENTIAL, 403 -> UNAUTHORIZED, 5xx/other -> PROVIDER_UNAVAILABLE", () => {
  assertEquals(mapHttpStatusToTestResult(200), "CONNECTED");
  assertEquals(mapHttpStatusToTestResult(204), "CONNECTED");
  assertEquals(mapHttpStatusToTestResult(401), "INVALID_CREDENTIAL");
  assertEquals(mapHttpStatusToTestResult(400), "INVALID_CREDENTIAL");
  assertEquals(mapHttpStatusToTestResult(404), "INVALID_CREDENTIAL");
  assertEquals(mapHttpStatusToTestResult(422), "INVALID_CREDENTIAL");
  assertEquals(mapHttpStatusToTestResult(403), "UNAUTHORIZED");
  assertEquals(mapHttpStatusToTestResult(500), "PROVIDER_UNAVAILABLE");
  assertEquals(mapHttpStatusToTestResult(503), "PROVIDER_UNAVAILABLE");
  assertEquals(mapHttpStatusToTestResult(302), "PROVIDER_UNAVAILABLE");
});

// ─── fetch stub ──────────────────────────────────────────────────────────────

interface Captured {
  url: string;
  // deno-lint-ignore no-explicit-any
  init: any;
}

function stubFetch(
  behavior:
    | { status: number }
    | { throws: true }
    | { response: unknown },
): {
  fetchImpl: (u: string, i?: RequestInit) => Promise<Response>;
  last: () => Captured | null;
} {
  let captured: Captured | null = null;
  const fetchImpl = (u: string, i?: RequestInit): Promise<Response> => {
    captured = { url: u, init: i };
    if ("throws" in behavior && behavior.throws) {
      return Promise.reject(new Error("network down"));
    }
    const status = "status" in behavior ? behavior.status : 200;
    const body = "response" in behavior ? behavior.response : {};
    return Promise.resolve(
      new Response(JSON.stringify(body), { status }),
    );
  };
  return { fetchImpl, last: () => captured };
}

// ─── testRazorpayConnection ──────────────────────────────────────────────────

Deno.test("razorpay test: absent key id/secret -> CONFIGURATION_INVALID, fetch never called", async () => {
  let called = 0;
  const out = await testRazorpayConnection({
    keyId: "",
    keySecret: "x",
    fetchImpl: (() => {
      called++;
      // deno-lint-ignore no-explicit-any
      return Promise.resolve(new Response("{}", { status: 200 })) as any;
    }) as never,
  });
  assertEquals(out, "CONFIGURATION_INVALID");
  assertEquals(called, 0);
});

Deno.test("razorpay test: 200 -> CONNECTED; credential is sent but NEVER echoed", async () => {
  const cap = stubFetch({ status: 200 });
  const out = await testRazorpayConnection({
    keyId: "rzp_id",
    keySecret: "TEST_SECRET_SHOULD_NEVER_LEAK_123456",
    fetchImpl: cap.fetchImpl,
    baseUrl: "https://rzp.test",
  });
  assertEquals(out, "CONNECTED");
  const c = cap.last();
  assertNotEquals(c, null);
  assertEquals(c!.url, "https://rzp.test/v1/settings");
  // The request carries basic auth (so the provider can authenticate it)...
  assertEquals(
    c!.init.headers.Authorization,
    `Basic ${btoa("rzp_id:TEST_SECRET_SHOULD_NEVER_LEAK_123456")}`,
  );
  // ...but the RESULT is a bare enum token that contains no credential.
  assertEquals(CONNECTION_TEST_RESULTS.includes(out), true);
});

Deno.test("razorpay test: 401 -> INVALID_CREDENTIAL (no secret leakage in the enum)", async () => {
  const cap = stubFetch({ status: 401 });
  const out = await testRazorpayConnection({
    keyId: "id",
    keySecret: "secret",
    fetchImpl: cap.fetchImpl,
  });
  assertEquals(out, "INVALID_CREDENTIAL");
});

Deno.test("razorpay test: network fault -> PROVIDER_UNAVAILABLE", async () => {
  const cap = stubFetch({ throws: true });
  const out = await testRazorpayConnection({
    keyId: "id",
    keySecret: "secret",
    fetchImpl: cap.fetchImpl,
  });
  assertEquals(out, "PROVIDER_UNAVAILABLE");
});

// ─── testMetaConnection ──────────────────────────────────────────────────────

Deno.test("meta test: absent token/phone-id -> CONFIGURATION_INVALID", async () => {
  const out = await testMetaConnection({
    accessToken: "tok",
    phoneNumberId: "",
    // deno-lint-ignore no-explicit-any
    fetchImpl: (() => Promise.resolve(new Response("{}") as any)) as never,
  });
  assertEquals(out, "CONFIGURATION_INVALID");
});

Deno.test("meta test: 200 -> CONNECTED; token is Bearer-sent but NEVER echoed; phone-id in path", async () => {
  const cap = stubFetch({ status: 200 });
  const out = await testMetaConnection({
    accessToken: "TEST_SECRET_SHOULD_NEVER_LEAK_123456",
    phoneNumberId: "pn-42",
    apiVersion: "v20.0",
    fetchImpl: cap.fetchImpl,
    baseUrl: "https://graph.test",
  });
  assertEquals(out, "CONNECTED");
  const c = cap.last();
  assertEquals(
    c!.url,
    "https://graph.test/v20.0/pn-42?fields=id",
  );
  assertEquals(
    c!.init.headers.Authorization,
    "Bearer TEST_SECRET_SHOULD_NEVER_LEAK_123456",
  );
});

Deno.test("meta test: 500 -> PROVIDER_UNAVAILABLE; network fault -> PROVIDER_UNAVAILABLE", async () => {
  const s500 = stubFetch({ status: 500 });
  assertEquals(
    await testMetaConnection({
      accessToken: "t",
      phoneNumberId: "p",
      fetchImpl: s500.fetchImpl,
    }),
    "PROVIDER_UNAVAILABLE",
  );
  const thr = stubFetch({ throws: true });
  assertEquals(
    await testMetaConnection({
      accessToken: "t",
      phoneNumberId: "p",
      fetchImpl: thr.fetchImpl,
    }),
    "PROVIDER_UNAVAILABLE",
  );
});

// ─── asConnectionTestResult ──────────────────────────────────────────────────

Deno.test("asConnectionTestResult: whitelists the five; anything else -> PROVIDER_UNAVAILABLE", () => {
  for (const r of CONNECTION_TEST_RESULTS) {
    assertEquals(asConnectionTestResult(r), r);
  }
  assertEquals(
    asConnectionTestResult("CONNECTED_BUT_LEAKY"),
    "PROVIDER_UNAVAILABLE",
  );
  assertEquals(asConnectionTestResult(null), "PROVIDER_UNAVAILABLE");
  assertEquals(
    asConnectionTestResult("TEST_SECRET_SHOULD_NEVER_LEAK_123456"),
    "PROVIDER_UNAVAILABLE",
  );
});
