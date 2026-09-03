/**
 * tests/utils/setup_env.ts — Test environment bootstrap
 *
 * SETURA TEST / MOCKING STRATEGY
 * ──────────────────────────────
 * 1. Unit tests (tests/unit/) target PURE modules only:
 *    errors.ts, validation.ts, response.ts. They run with fake
 *    Supabase credentials — no network, no database. This file
 *    seeds Deno.env BEFORE any _shared module is imported,
 *    because env.ts validates required variables eagerly at
 *    module load (fail-fast cold-start design).
 *
 *    IMPORTANT: in every test file that imports a module which
 *    transitively imports _shared/env.ts, this file MUST be the
 *    first import. ES modules execute in import order, so the
 *    fake env is in place before env.ts evaluates.
 *
 * 2. Mocking: no mocking framework is used by design.
 *    - Pure logic is tested directly (fast, deterministic).
 *    - Anything that touches Postgres (RPCs, RLS, triggers) is
 *      NOT mocked — mocks would drift from the real schema.
 *      Instead, integration tests (tests/integration/) run
 *      against the real local Supabase stack via the service
 *      client, exercising the exact migrations + seed.
 *    - External HTTP APIs (Meta WhatsApp, Razorpay) are never
 *      called from tests; code paths that need them are covered
 *      by unit tests of their pure transforms only.
 *
 * 3. Determinism: no random(), no live clocks in assertions
 *    (tests compute expected values relative to Date.now()).
 */

Deno.env.set("APP_ENV", "test");
Deno.env.set("SUPABASE_URL", "http://127.0.0.1:54321");
Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
Deno.env.set("ALLOWED_ORIGINS", "http://localhost:3000,http://localhost:5173");

export {};
