# Meta WhatsApp Webhook — Signature and JWT Boundary

Phase 1.5 security hardening, decision D-2.

## 1. What changed

`supabase/functions/process-whatsapp-webhook/index.ts` previously verified the
Meta signature only when both the secret and the header happened to be present:

```ts
const signature = req.headers.get("X-Hub-Signature-256") ?? "";
const appSecret = Env.META_APP_SECRET;

if (appSecret && signature) { // <-- fail OPEN
  const valid = await verifyHmac(rawBody, signature, appSecret);
  if (!valid) return new Response("Forbidden", { status: 403 });
}
```

Because `META_APP_SECRET` is `optionalEnv` and `""` is falsy, an unsigned POST
skipped verification entirely and its payload was processed. Only one of the
four required cases was enforced.

Verification now lives in `supabase/functions/_shared/webhook_signature.ts`,
whose `verifyMetaSignature()` has exactly one success path. The four rejection
outcomes are typed constants, so a caller cannot mistake a misconfiguration or a
missing header for success:

| Condition                                  | Result                                    | HTTP |
| ------------------------------------------ | ----------------------------------------- | ---- |
| `META_APP_SECRET` unset or empty           | `{ ok: false, reason: "secret_missing" }` | 500  |
| `X-Hub-Signature-256` absent or empty      | `signature_missing`                       | 403  |
| Header not `sha256=<64 lowercase hex>`     | `signature_malformed`                     | 403  |
| Well-formed header, digest does not match  | `signature_invalid`                       | 403  |
| Digest matches HMAC-SHA256 of the raw body | `{ ok: true }`                            | 200  |

Properties preserved and asserted by `tests/unit/webhook_signature.test.ts` (18
tests):

- The **raw bytes** from `await req.text()` are verified before `JSON.parse`. A
  re-serialized body produces a different digest, so parsing first would break
  verification.
- Comparison stays **constant-time**: length check on a public fixed-length
  digest, then a full-width XOR fold over every character.
- **Nothing sensitive is logged.** The module does not log at all. The handler
  logs only the reason code — never the secret, the received signature, the
  computed digest, or any message content.
- Rejections are **not** answered with HTTP 200. The "always return 200 to Meta"
  rule exists to stop retry storms for _internal processing_ failures. A request
  that fails signature verification did not come from Meta, so there is no retry
  loop to protect.

### Why `META_APP_SECRET` stays `optionalEnv`

`_shared/env.ts` is imported by every Edge Function. Promoting the secret to
`requiredEnv` would fail module initialization for all of them — including
deployments that do not use WhatsApp at all. Rejecting per request with 500
satisfies "secret missing -> reject" without turning one integration's
configuration into a platform-wide boot failure. The 500 also matches the
existing GET branch, which returns `Server Misconfigured` when
`META_WEBHOOK_VERIFY_TOKEN` is absent.

## 2. JWT boundary — repository evidence

Per the D-2 constraint, the Supabase JWT configuration was **inspected and
documented, not changed**. Findings:

| Question                                      | Repository evidence                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| Does `supabase/config.toml` set `verify_jwt`? | **No.** The file has no `[functions]` section at all, for any function.             |
| Effective local default                       | `verify_jwt = true` — Supabase's default when unspecified.                          |
| Any `--no-verify-jwt` in the repo?            | **None.** No occurrence in any file.                                                |
| Deploy script or CI workflow?                 | **None found.** No `supabase functions deploy` invocation exists in the repository. |
| Production webhook URL / Meta app config?     | Not present in the repository.                                                      |

Consequence: with `verify_jwt = true`, Supabase rejects any request without a
valid `Authorization: Bearer <jwt>` header _before_ the function body runs. Meta
does not send an Authorization header. So on a deployment matching the committed
configuration, Meta's webhook POSTs would be rejected by the platform and the
function would never execute. A working production deployment therefore implies
the JWT check is disabled out-of-band — via `--no-verify-jwt` at deploy time or
the dashboard's per-function setting — but **no artifact in this repository
records that**.

Both possibilities were considered and neither can be confirmed from committed
evidence:

1. JWT verification is disabled in production out-of-band. Then the HMAC
   verification implemented above is the _only_ authentication on the endpoint,
   which is exactly why it had to become fail-closed.
2. JWT verification is enabled in production. Then WhatsApp webhook delivery is
   currently non-functional, independent of this change.

**Production JWT boundary requires deployment verification.**

**Do not invent a production configuration.**

`supabase/config.toml` was deliberately left unmodified. Adding a `[functions]`
section with `verify_jwt = false` would be asserting a production fact that
cannot be verified from the repository, and would weaken the local boundary on
the strength of a guess.

### What a deployment operator must confirm

1. The actual `verify_jwt` setting for `process-whatsapp-webhook` in the
   deployed project (dashboard, or the deploy command in use).
2. The webhook callback URL registered in the Meta app, and whether any gateway,
   proxy, or function-level shim sits in front of the Edge Function.
3. That `META_APP_SECRET` is set in the deployed function's secrets and equals
   the Meta app secret. After this change, an unset secret means every webhook
   POST is refused with 500 rather than silently processed — the failure is now
   loud, which is the intended behaviour.

Once (1) is known, record it in `supabase/config.toml` so the boundary is
version-controlled rather than dashboard-only.

## 3. Files

- `supabase/functions/_shared/webhook_signature.ts` — new, verification module
- `supabase/functions/process-whatsapp-webhook/index.ts` — fail-closed handler
- `tests/unit/webhook_signature.test.ts` — new, 18 tests over all five outcomes
