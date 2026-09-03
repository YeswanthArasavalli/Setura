/**
 * tests/unit/webhook_signature.test.ts
 *
 * Fail-closed contract for Meta webhook signature verification.
 *
 * The defect this suite locks down: the previous implementation only
 * verified the signature when BOTH the app secret and the header were
 * present, so an attacker could bypass verification entirely by simply
 * omitting X-Hub-Signature-256. These tests assert that every path
 * other than a matching digest is a rejection.
 *
 * Run: deno task test
 */

import {
  assert,
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  constantTimeEqual,
  hmacSha256Hex,
  signatureFailureStatus,
  verifyMetaSignature,
} from "../../supabase/functions/_shared/webhook_signature.ts";

const SECRET = "test_app_secret_9f2c";

const BODY = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "1234567890",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: {
              display_phone_number: "919999900001",
              phone_number_id: "111222333",
            },
            statuses: [
              {
                id: "wamid.TEST",
                status: "delivered",
                timestamp: "1716200000",
              },
            ],
          },
        },
      ],
    },
  ],
});

/** The header Meta would send for BODY signed with SECRET. */
async function validHeader(
  body = BODY,
  secret = SECRET,
): Promise<string> {
  return `sha256=${await hmacSha256Hex(body, secret)}`;
}

// ── Case 1: secret missing ───────────────────────────────────────────────────

Deno.test("verifyMetaSignature rejects when the app secret is undefined", async () => {
  const result = await verifyMetaSignature({
    rawBody: BODY,
    signatureHeader: await validHeader(),
    appSecret: undefined,
  });

  assertEquals(result.ok, false);
  assertEquals(
    result.ok === false ? result.reason : null,
    "secret_missing",
  );
});

Deno.test("verifyMetaSignature rejects when the app secret is an empty string", async () => {
  const result = await verifyMetaSignature({
    rawBody: BODY,
    signatureHeader: await validHeader(),
    appSecret: "",
  });

  assertEquals(result.ok, false);
  assertEquals(
    result.ok === false ? result.reason : null,
    "secret_missing",
  );
});

// ── Case 2: signature header missing ─────────────────────────────────────────

Deno.test("verifyMetaSignature rejects when X-Hub-Signature-256 is absent", async () => {
  const result = await verifyMetaSignature({
    rawBody: BODY,
    signatureHeader: null,
    appSecret: SECRET,
  });

  assertEquals(result.ok, false);
  assertEquals(
    result.ok === false ? result.reason : null,
    "signature_missing",
  );
});

Deno.test("verifyMetaSignature rejects an empty signature header", async () => {
  const result = await verifyMetaSignature({
    rawBody: BODY,
    signatureHeader: "",
    appSecret: SECRET,
  });

  assertEquals(result.ok, false);
  assertEquals(
    result.ok === false ? result.reason : null,
    "signature_missing",
  );
});

// ── Case 3: malformed signature header ───────────────────────────────────────

Deno.test("verifyMetaSignature rejects malformed signature headers", async () => {
  const digest = await hmacSha256Hex(BODY, SECRET);

  const malformed: Array<[string, string]> = [
    ["no algorithm prefix", digest],
    ["wrong algorithm", `sha1=${digest}`],
    ["truncated digest", `sha256=${digest.slice(0, 32)}`],
    ["over-long digest", `sha256=${digest}00`],
    ["non-hex digest", `sha256=${"z".repeat(64)}`],
    ["prefix only", "sha256="],
    ["whitespace only", "   "],
    ["json instead of header", '{"sha256":"x"}'],
  ];

  for (const [label, header] of malformed) {
    const result = await verifyMetaSignature({
      rawBody: BODY,
      signatureHeader: header,
      appSecret: SECRET,
    });

    assertEquals(result.ok, false, `${label} must be rejected`);
    assertEquals(
      result.ok === false ? result.reason : null,
      "signature_malformed",
      `${label} must be reported as malformed`,
    );
  }
});

// ── Case 4: well-formed but wrong ────────────────────────────────────────────

Deno.test("verifyMetaSignature rejects a digest computed with the wrong secret", async () => {
  const result = await verifyMetaSignature({
    rawBody: BODY,
    signatureHeader: await validHeader(BODY, "attacker_secret"),
    appSecret: SECRET,
  });

  assertEquals(result.ok, false);
  assertEquals(
    result.ok === false ? result.reason : null,
    "signature_invalid",
  );
});

Deno.test("verifyMetaSignature rejects a signature for a different body", async () => {
  const result = await verifyMetaSignature({
    rawBody: BODY,
    signatureHeader: await validHeader('{"object":"other"}'),
    appSecret: SECRET,
  });

  assertEquals(result.ok, false);
  assertEquals(
    result.ok === false ? result.reason : null,
    "signature_invalid",
  );
});

Deno.test("verifyMetaSignature rejects a body mutated after signing", async () => {
  const header = await validHeader();

  // A single character changed anywhere in the payload must invalidate
  // the digest. This is why the raw bytes are verified before parsing:
  // re-serialized JSON would not match even when semantically equal.
  const tampered = BODY.replace("delivered", "read");

  assertNotEquals(tampered, BODY);

  const result = await verifyMetaSignature({
    rawBody: tampered,
    signatureHeader: header,
    appSecret: SECRET,
  });

  assertEquals(result.ok, false);
  assertEquals(
    result.ok === false ? result.reason : null,
    "signature_invalid",
  );
});

// ── Case 5: the single success path ──────────────────────────────────────────

Deno.test("verifyMetaSignature accepts a correctly signed body", async () => {
  const result = await verifyMetaSignature({
    rawBody: BODY,
    signatureHeader: await validHeader(),
    appSecret: SECRET,
  });

  assertEquals(result, { ok: true });
});

Deno.test("verifyMetaSignature accepts an uppercase-hex header", async () => {
  const header = (await validHeader()).toUpperCase().replace(
    "SHA256=",
    "sha256=",
  );

  const result = await verifyMetaSignature({
    rawBody: BODY,
    signatureHeader: header,
    appSecret: SECRET,
  });

  assertEquals(result, { ok: true });
});

Deno.test("verifyMetaSignature accepts a header with surrounding whitespace", async () => {
  const result = await verifyMetaSignature({
    rawBody: BODY,
    signatureHeader: `  ${await validHeader()}  `,
    appSecret: SECRET,
  });

  assertEquals(result, { ok: true });
});

Deno.test("verifyMetaSignature accepts an empty body when correctly signed", async () => {
  const result = await verifyMetaSignature({
    rawBody: "",
    signatureHeader: await validHeader(""),
    appSecret: SECRET,
  });

  assertEquals(result, { ok: true });
});

// ── HMAC primitive ───────────────────────────────────────────────────────────

Deno.test("hmacSha256Hex matches the RFC 4231 test vector", async () => {
  // RFC 4231 case 1: key = 20 x 0x0b, data = "Hi There".
  const key = "\x0b".repeat(20);

  assertEquals(
    await hmacSha256Hex("Hi There", key),
    "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
  );
});

Deno.test("hmacSha256Hex returns 64 lowercase hex characters", async () => {
  const digest = await hmacSha256Hex(BODY, SECRET);

  assertEquals(digest.length, 64);
  assert(/^[0-9a-f]{64}$/.test(digest), "digest must be lowercase hex");
});

Deno.test("hmacSha256Hex is deterministic and secret-dependent", async () => {
  const a = await hmacSha256Hex(BODY, SECRET);
  const b = await hmacSha256Hex(BODY, SECRET);
  const c = await hmacSha256Hex(BODY, `${SECRET}x`);

  assertEquals(a, b);
  assertNotEquals(a, c);
});

// ── Comparison helper ────────────────────────────────────────────────────────

Deno.test("constantTimeEqual compares full strings", () => {
  assertEquals(constantTimeEqual("abc", "abc"), true);
  assertEquals(constantTimeEqual("", ""), true);
  assertEquals(constantTimeEqual("abc", "abd"), false);
  assertEquals(constantTimeEqual("abc", "bbc"), false);
  assertEquals(constantTimeEqual("abc", "abcd"), false);
  assertEquals(constantTimeEqual("abcd", "abc"), false);
});

// ── Status mapping ───────────────────────────────────────────────────────────

Deno.test("signatureFailureStatus reports misconfiguration as 500 and refusals as 403", () => {
  assertEquals(signatureFailureStatus("secret_missing"), 500);
  assertEquals(signatureFailureStatus("signature_missing"), 403);
  assertEquals(signatureFailureStatus("signature_malformed"), 403);
  assertEquals(signatureFailureStatus("signature_invalid"), 403);
});

Deno.test("signatureFailureStatus never acknowledges a rejection with 200", () => {
  const reasons = [
    "secret_missing",
    "signature_missing",
    "signature_malformed",
    "signature_invalid",
  ] as const;

  for (const reason of reasons) {
    assertNotEquals(
      signatureFailureStatus(reason),
      200,
      `${reason} must not be answered with HTTP 200`,
    );
  }
});
