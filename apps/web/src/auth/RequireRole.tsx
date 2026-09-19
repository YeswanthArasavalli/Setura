import { type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/auth/AuthProvider";
import type { UserRole } from "@/types/api";

/**
 * Route guard. This is a UX/convenience gate only — it decides what to render
 * so a user is not shown screens they cannot use. Real authorization is
 * enforced by RLS + the Edge Functions' server-side requireRole (Phase 6 §5/§6).
 */
export function RequireRole({
  roles,
  children,
}: {
  roles: UserRole[];
  children: ReactNode;
}) {
  const { session, staff, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (!staff) {
    return (
      <div className="flex h-screen items-center justify-center px-6 text-center text-muted-foreground">
        No staff role is attached to this account. Contact your hospital admin.
      </div>
    );
  }

  // global_admin can reach everything.
  const allowed =
    staff.role === "global_admin" || roles.includes(staff.role);

  if (!allowed) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
