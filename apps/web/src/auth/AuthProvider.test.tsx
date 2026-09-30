import { useEffect } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@supabase/supabase-js";

/**
 * Auth app-shell request/remount loop — regression suite (Phase 7).
 *
 * The real AuthProvider and the real RequireRole guard are under test, plus a
 * TestApp that mirrors App.tsx's session branch and the /admin guarded-route
 * shape. Only the two defect-boundary dependencies are mocked: the Supabase
 * client (the auth event stream) and resolveStaffContext (the profiles +
 * user_roles read pair). The chain under test is the exact recorded loop:
 *
 *   auth event → setLoading(true) → RequireRole swaps the authenticated tree
 *   for "Loading…" → shell + Outlet unmount → remount → every load-on-mount
 *   page fetch re-runs → (next auth event) → repeat.
 *
 * Per event type these tests pin (1) how often the staff-context read pair
 * runs and (2) whether the guarded shell tree is torn down. The mount/unmount
 * counters are the direct regression guard: if a future change reintroduces
 * the loading toggle on a routine same-user auth event, the shell unmounts
 * and these tests fail.
 */

type AuthCallback = (event: string, session: Session | null) => void;

const authMock = vi.hoisted(() => ({
  session: null as Session | null,
  callback: null as AuthCallback | null,
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: authMock.session } }),
      onAuthStateChange: (cb: AuthCallback) => {
        authMock.callback = cb;
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
      signInWithPassword: vi.fn(),
      signOut: vi.fn(),
    },
  },
}));

const resolveCtx = vi.hoisted(() => vi.fn());
vi.mock("@/auth/context", () => ({
  resolveStaffContext: resolveCtx,
}));

const { AuthProvider, useAuth } = await import("@/auth/AuthProvider");
const { RequireRole } = await import("@/auth/RequireRole");

// ---- observation counters (module-level so unmounts are countable) ---------

let shellMounts = 0;
let shellUnmounts = 0;
let pageMounts = 0;
let pageUnmounts = 0;

function ShellProbe() {
  useEffect(() => {
    shellMounts += 1;
    return () => {
      shellUnmounts += 1;
    };
  }, []);
  // Mirrors AppShell: its own chrome plus the outlet child, so layout-level
  // teardown and page-level teardown are separately observable.
  return (
    <div>
      AUTHENTICATED SHELL
      <Outlet />
    </div>
  );
}

function PageProbe() {
  useEffect(() => {
    pageMounts += 1;
    return () => {
      pageUnmounts += 1;
    };
  }, []);
  return <div>PAGE CONTENT</div>;
}

function sessionFor(userId: string): Session {
  return {
    access_token: "test-access-token",
    refresh_token: "test-refresh-token",
    expires_in: 3600,
    token_type: "bearer",
    user: { id: userId, aud: "authenticated", role: "authenticated" },
  } as unknown as Session;
}

function staffFor(
  userId: string,
  role: "hospital_admin" | "doctor" = "hospital_admin",
) {
  return {
    userId,
    fullName: "Test User",
    role,
    hospitalId: "h-1",
    memberships: [{ role, hospitalId: "h-1", isPrimary: true }],
    accessibleHospitalIds: ["h-1"],
  };
}

/** Mirrors App.tsx: unauthenticated branch routes to /login, authenticated
 *  branch renders the guarded shell route (the real /admin composition). */
function TestApp() {
  const { loading, session } = useAuth();

  if (!loading && !session) {
    return (
      <Routes>
        <Route path="/login" element={<div>LOGIN SCREEN</div>} />
        <Route path="*" element={<div>LOGIN SCREEN</div>} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<div>LOGIN SCREEN</div>} />
      <Route
        element={
          <RequireRole roles={["hospital_admin", "doctor", "global_admin"]}>
            <ShellProbe />
          </RequireRole>
        }
      >
        <Route
          path="/admin"
          element={
            <RequireRole roles={["hospital_admin"]}>
              <PageProbe />
            </RequireRole>
          }
        />
      </Route>
    </Routes>
  );
}

function renderApp() {
  return render(
    <MemoryRouter initialEntries={["/admin"]}>
      <AuthProvider>
        <TestApp />
      </AuthProvider>
    </MemoryRouter>,
  );
}

/** Emit an auth event exactly as the Supabase client callback would. */
function emit(event: string, session: Session | null) {
  act(() => {
    authMock.callback!(event, session);
  });
}

async function authenticatedTreeMounted() {
  await waitFor(() =>
    expect(screen.getByText("PAGE CONTENT")).toBeInTheDocument(),
  );
}

beforeEach(() => {
  authMock.session = null;
  authMock.callback = null;
  resolveCtx.mockReset();
  shellMounts = 0;
  shellUnmounts = 0;
  pageMounts = 0;
  pageUnmounts = 0;
});

// ---- INITIAL_SESSION --------------------------------------------------------

describe("INITIAL_SESSION", () => {
  it("no stored session: settles unauthenticated without a staff read", async () => {
    renderApp();
    emit("INITIAL_SESSION", null);

    await waitFor(() =>
      expect(screen.getByText("LOGIN SCREEN")).toBeInTheDocument(),
    );
    expect(resolveCtx).not.toHaveBeenCalled();
    expect(shellMounts).toBe(0);
    expect(pageMounts).toBe(0);
  });

  it("stored session: resolves staff context once and mounts the shell once", async () => {
    authMock.session = sessionFor("u-1");
    resolveCtx.mockResolvedValue(staffFor("u-1"));

    renderApp();
    emit("INITIAL_SESSION", authMock.session);

    await authenticatedTreeMounted();
    expect(resolveCtx).toHaveBeenCalledTimes(1);
    expect(shellMounts).toBe(1);
    expect(shellUnmounts).toBe(0);
    expect(pageMounts).toBe(1);
    expect(pageUnmounts).toBe(0);
  });
});

// ---- TOKEN_REFRESHED (the routine churn driver) -----------------------------

describe("TOKEN_REFRESHED on a healthy authenticated app", () => {
  it("does NOT re-resolve staff context, toggle loading, or remount the shell", async () => {
    authMock.session = sessionFor("u-1");
    resolveCtx.mockResolvedValue(staffFor("u-1"));

    renderApp();
    await authenticatedTreeMounted();
    expect(resolveCtx).toHaveBeenCalledTimes(1);

    emit("TOKEN_REFRESHED", sessionFor("u-1"));

    // The tree stayed mounted the whole time: no "Loading…" swap, no second
    // mount, no extra profiles/user_roles read pair.
    expect(screen.getByText("PAGE CONTENT")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(shellMounts).toBe(1);
    expect(shellUnmounts).toBe(0);
    expect(pageMounts).toBe(1);
    expect(pageUnmounts).toBe(0);
    expect(resolveCtx).toHaveBeenCalledTimes(1);
  });

  it("a burst of routine same-user events still produces zero remounts", async () => {
    authMock.session = sessionFor("u-1");
    resolveCtx.mockResolvedValue(staffFor("u-1"));

    renderApp();
    await authenticatedTreeMounted();

    for (let i = 0; i < 10; i += 1) {
      emit(i % 2 === 0 ? "TOKEN_REFRESHED" : "SIGNED_IN", sessionFor("u-1"));
    }

    expect(screen.getByText("PAGE CONTENT")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(shellMounts).toBe(1);
    expect(shellUnmounts).toBe(0);
    expect(pageMounts).toBe(1);
    expect(pageUnmounts).toBe(0);
    // The initial getSession resolve is the only read pair; ten routine
    // events added none.
    expect(resolveCtx).toHaveBeenCalledTimes(1);
  });
});

// ---- USER_UPDATED -------------------------------------------------------------

describe("USER_UPDATED", () => {
  it("same user: keeps the shell mounted and issues no staff re-read", async () => {
    authMock.session = sessionFor("u-1");
    resolveCtx.mockResolvedValue(staffFor("u-1"));

    renderApp();
    await authenticatedTreeMounted();

    emit("USER_UPDATED", sessionFor("u-1"));

    expect(screen.getByText("PAGE CONTENT")).toBeInTheDocument();
    expect(shellUnmounts).toBe(0);
    expect(pageUnmounts).toBe(0);
    expect(resolveCtx).toHaveBeenCalledTimes(1);
  });
});

// ---- SIGNED_IN ---------------------------------------------------------------

describe("SIGNED_IN", () => {
  it("post-establishment same-user events add no re-resolve and no remount", async () => {
    authMock.session = sessionFor("u-1");
    resolveCtx.mockResolvedValue(staffFor("u-1"));

    renderApp();
    await authenticatedTreeMounted();

    emit("SIGNED_IN", sessionFor("u-1"));

    expect(screen.getByText("PAGE CONTENT")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(shellMounts).toBe(1);
    expect(shellUnmounts).toBe(0);
    expect(resolveCtx).toHaveBeenCalledTimes(1);
  });

  it("a DIFFERENT user forces a full reload — the old user's shell must not persist", async () => {
    authMock.session = sessionFor("u-1");
    resolveCtx.mockResolvedValue(staffFor("u-1"));

    renderApp();
    await authenticatedTreeMounted();

    resolveCtx.mockResolvedValue(staffFor("u-2"));
    emit("SIGNED_IN", sessionFor("u-2"));

    // Genuine transition: the loading teardown IS correct here — u-1's staff
    // context must never keep rendering under u-2's session.
    expect(screen.queryByText("PAGE CONTENT")).toBeNull();
    expect(shellUnmounts).toBe(1);
    expect(pageUnmounts).toBe(1);

    await authenticatedTreeMounted();
    expect(shellMounts).toBe(2);
    expect(pageMounts).toBe(2);
    expect(resolveCtx).toHaveBeenLastCalledWith("u-2");
  });
});

// ---- SIGNED_OUT --------------------------------------------------------------

describe("SIGNED_OUT", () => {
  it("tears down the authenticated shell via the null session", async () => {
    authMock.session = sessionFor("u-1");
    resolveCtx.mockResolvedValue(staffFor("u-1"));

    renderApp();
    await authenticatedTreeMounted();

    emit("SIGNED_OUT", null);

    await waitFor(() =>
      expect(screen.getByText("LOGIN SCREEN")).toBeInTheDocument(),
    );
    expect(shellUnmounts).toBe(1);
    expect(pageUnmounts).toBe(1);
    expect(resolveCtx).toHaveBeenCalledTimes(1);
  });

  it("re-authentication after sign-out re-resolves staff context (no sticky skip)", async () => {
    authMock.session = sessionFor("u-1");
    resolveCtx.mockResolvedValue(staffFor("u-1"));

    renderApp();
    await authenticatedTreeMounted();

    emit("SIGNED_OUT", null);
    await waitFor(() =>
      expect(screen.getByText("LOGIN SCREEN")).toBeInTheDocument(),
    );

    emit("SIGNED_IN", sessionFor("u-1"));
    await authenticatedTreeMounted();
    // The second sign-in is a genuine transition (context was cleared), so
    // the staff pair runs again — stale staff context is never reused.
    expect(resolveCtx).toHaveBeenCalledTimes(2);
  });
});

// ---- fail-closed context outcomes -------------------------------------------

describe("staff context outcome", () => {
  it("null context (inactive/no role): shell never mounts; routine events keep retrying resolution", async () => {
    authMock.session = sessionFor("u-1");
    resolveCtx.mockResolvedValue(null);

    renderApp();
    await waitFor(() =>
      expect(
        screen.getByText(/No staff role is attached/),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText("AUTHENTICATED SHELL")).toBeNull();

    emit("TOKEN_REFRESHED", sessionFor("u-1"));

    // An unresolved user is never treated as "already resolved".
    expect(screen.queryByText("AUTHENTICATED SHELL")).toBeNull();
    expect(resolveCtx).toHaveBeenCalledTimes(2);
  });

  it("resolver failure never renders the shell, and recovery on a later event works", async () => {
    authMock.session = sessionFor("u-1");
    resolveCtx.mockRejectedValueOnce(new Error("network"));

    renderApp();
    await waitFor(() =>
      expect(
        screen.getByText(/No staff role is attached/),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText("AUTHENTICATED SHELL")).toBeNull();

    resolveCtx.mockResolvedValue(staffFor("u-1"));
    emit("TOKEN_REFRESHED", sessionFor("u-1"));
    await authenticatedTreeMounted();
    expect(resolveCtx).toHaveBeenCalledTimes(2);
  });
});
