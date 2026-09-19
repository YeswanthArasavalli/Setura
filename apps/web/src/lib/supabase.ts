import { createClient } from "@supabase/supabase-js";

/**
 * Browser Supabase client.
 *
 * SECURITY (Phase 6 §21): this client is built with the PUBLIC anon key and
 * the signed-in user's JWT only. It can read exactly what RLS allows that
 * user — never more. The service-role key is NEVER available here and is
 * never sent from the browser. All privileged mutations go through Edge
 * Functions that re-resolve role + tenant server-side.
 */
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy .env.example to .env.local.",
  );
}

export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
  global: {
    headers: { "x-client-info": "setura-web/0.1.0" },
  },
});
