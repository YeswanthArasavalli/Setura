/**
 * db.ts — Supabase client management
 *
 * Three clients serve different purposes:
 *
 * 1. serviceClient — service role key, bypasses RLS.
 *    Use for: background workers, internal mutations, webhook handlers,
 *    any operation that must not be gated by RLS.
 *    NEVER expose to user-controlled input.
 *
 * 2. anonClient — anon key, subject to RLS.
 *    Use for: public read-only queries (hospital list, working hours).
 *
 * 3. authClient(jwt) — request-scoped, impersonates the caller.
 *    Use for: any user-facing mutation where RLS must be enforced.
 *    Created per-request, NOT cached.
 *
 * All clients are module-level singletons (service + anon) or
 * per-request instances (authClient). Deno module caching ensures
 * the service/anon clients are initialized once per isolate lifetime.
 */

import {
  createClient,
  SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { Env } from "./env.ts";
import type { Database } from "./types.ts";

// ─── Service-role client (bypasses RLS) ──────────────────────────────────────

let _serviceClient: SupabaseClient<Database> | null = null;

export function getServiceClient(): SupabaseClient<Database> {
  if (!_serviceClient) {
    _serviceClient = createClient<Database>(
      Env.SUPABASE_URL,
      Env.SUPABASE_SERVICE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false,
        },
        db: { schema: "public" },
        global: {
          headers: {
            "x-setura-client": "edge-service",
            "x-setura-version": Env.DEPLOYMENT_VERSION,
          },
        },
      },
    );
  }
  return _serviceClient;
}

// ─── Anon client (subject to RLS) ────────────────────────────────────────────

let _anonClient: SupabaseClient<Database> | null = null;

export function getAnonClient(): SupabaseClient<Database> {
  if (!_anonClient) {
    _anonClient = createClient<Database>(
      Env.SUPABASE_URL,
      Env.SUPABASE_ANON_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false,
        },
        db: { schema: "public" },
      },
    );
  }
  return _anonClient;
}

// ─── Auth client (per-request, user-impersonating) ───────────────────────────

/**
 * Creates a client that runs as the authenticated user.
 * RLS policies see auth.uid() = the user's UUID.
 * Must be created fresh per request — never cache this.
 */
export function createAuthClient(jwt: string): SupabaseClient<Database> {
  return createClient<Database>(
    Env.SUPABASE_URL,
    Env.SUPABASE_ANON_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      db: { schema: "public" },
      global: {
        headers: {
          Authorization: `Bearer ${jwt}`,
          "x-setura-client": "edge-auth",
        },
      },
    },
  );
}

// ─── Typed RPC helpers ────────────────────────────────────────────────────────

/**
 * Calls a Postgres SECURITY DEFINER function via service client,
 * fully typed against the generated Database schema.
 * Throws DbError if Supabase returns an error.
 */
export async function callRpc<
  Fn extends string & keyof Database["public"]["Functions"],
>(
  fnName: Fn,
  params: Database["public"]["Functions"][Fn]["Args"],
  client?: SupabaseClient<Database>,
): Promise<Database["public"]["Functions"][Fn]["Returns"]> {
  const db = client ?? getServiceClient();
  const { data, error } = await db.rpc(fnName, params);

  if (error) {
    const { DbError } = await import("./errors.ts");
    throw new DbError(`RPC ${fnName} failed: ${error.message}`, {
      code: error.code,
      details: error.details,
      hint: error.hint,
      params,
    });
  }

  return data;
}

// ─── Type-safe table helpers ──────────────────────────────────────────────────

export type DbClient = SupabaseClient<Database>;

/**
 * Helper: assert no Supabase error, return data.
 * Used inline to avoid repetitive error checks.
 */
export function assertNoError<T>(
  result: { data: T | null; error: { message: string; code?: string } | null },
  context: string,
): T {
  if (result.error) {
    const message = `[db] ${context}: ${result.error.message}`;
    // Lazy import to avoid circular dependency
    throw Object.assign(new Error(message), {
      code: "DB_ERROR",
      statusCode: 500,
      retryable: false,
      dbCode: result.error.code,
    });
  }
  if (result.data === null || result.data === undefined) {
    throw Object.assign(new Error(`[db] ${context}: no data returned`), {
      code: "DB_ERROR",
      statusCode: 500,
      retryable: false,
    });
  }
  return result.data;
}
