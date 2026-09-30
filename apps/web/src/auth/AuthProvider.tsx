import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { resolveStaffContext, type StaffContext } from "./context";
import type { UserRole } from "@/types/api";

interface AuthState {
  session: Session | null;
  staff: StaffContext | null;
  loading: boolean;
  error: string | null;
  role: UserRole | null;
  hospitalId: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Real authentication flow (Phase 6 §6):
 *   login → authenticated session → resolve role → resolve tenant → dashboard
 * Supabase Auth issues the JWT; the staff context is read from RLS-protected
 * tables. Nothing about role/tenant here is trusted for security — it only
 * decides what to render; the Edge Functions re-authorize every call.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [staff, setStaff] = useState<StaffContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // User whose staff context this provider instance has ALREADY established
  // (or is actively resolving — getSession() and the initial auth event
  // describe the same user and must not double-read). The full loading
  // teardown runs once per user; routine same-user auth events must not
  // re-arm it, or RequireRole swaps the authenticated tree and every
  // load-on-mount page fetch repeats (app-shell request/remount loop).
  const authedUserRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;

    // Mark the user synchronously so an auth event arriving while this read
    // is in flight is recognised as routine, not as a new transition.
    function beginLoad(userId: string) {
      if (authedUserRef.current === userId) return;
      authedUserRef.current = userId;
      void load(userId);
    }

    async function load(userId: string) {
      let ctx: StaffContext | null = null;
      try {
        ctx = await resolveStaffContext(userId);
      } catch {
        if (active) setError("Could not load your staff profile.");
      }
      if (!active) return;
      // A different user was established while this read was in flight: this
      // result is stale and must not overwrite the newer context.
      if (authedUserRef.current !== userId) return;
      if (!ctx) {
        // Fail-closed: no usable staff context. Clear the marker so the next
        // auth event retries resolution instead of skipping forever.
        authedUserRef.current = null;
      }
      setStaff(ctx);
      setLoading(false);
    }

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      if (data.session) {
        beginLoad(data.session.user.id);
      } else {
        setLoading(false);
      }
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, s) => {
      setSession(s);
      setError(null);
      if (s) {
        if (authedUserRef.current === s.user.id) {
          // Routine auth activity for the user the app is already built for
          // (TOKEN_REFRESHED, same-user SIGNED_IN replays, multi-tab storage
          // sync): update session state, keep the authenticated tree
          // mounted. The backend re-authorizes every request from the fresh
          // JWT regardless, so skipping the staff re-read here changes
          // nothing about authorization.
          return;
        }
        // Genuine transition (first resolve, or a different user): the
        // previous user's context must not render, so reload fully.
        setLoading(true);
        beginLoad(s.user.id);
      } else {
        // Signed out: teardown of the authenticated tree is driven by the
        // null session itself (App/RequireRole redirect), not by loading.
        authedUserRef.current = null;
        setStaff(null);
        setLoading(false);
      }
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    setError(null);
    const { error: err } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (err) {
      // Supabase's invalid-credentials message is safe to surface.
      setError(
        err.message.includes("Invalid") || err.message.includes("password")
          ? "Invalid email or password."
          : err.message,
      );
      throw err;
    }
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setStaff(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      session,
      staff,
      loading,
      error,
      role: staff?.role ?? null,
      hospitalId: staff?.hospitalId ?? null,
      signIn,
      signOut,
    }),
    [session, staff, loading, error, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
