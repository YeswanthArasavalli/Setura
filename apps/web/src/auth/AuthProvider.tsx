import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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

  useEffect(() => {
    let active = true;

    async function load(userId: string) {
      try {
        const ctx = await resolveStaffContext(userId);
        if (!active) return;
        setStaff(ctx);
      } catch {
        if (active) {
          setStaff(null);
          setError("Could not load your staff profile.");
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      if (data.session) {
        void load(data.session.user.id);
      } else {
        setLoading(false);
      }
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, s) => {
      setSession(s);
      setError(null);
      if (s) {
        setLoading(true);
        void load(s.user.id);
      } else {
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
