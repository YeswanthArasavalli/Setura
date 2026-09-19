import { supabase } from "@/lib/supabase";
import type { UserRole } from "@/types/api";

/**
 * Staff context resolution (Phase 6 §5/§6/§7).
 *
 * The browser reads the signed-in user's own `user_roles` + `profiles` rows
 * via RLS to know which role(s)/hospital(s) to SHOW and which tenant to send
 * as X-Hospital-ID. This is display/routing convenience ONLY. The backend
 * independently re-resolves role + hospital on every Edge Function call from
 * the DB (auth.ts resolveAuth) and is the real authority — a tampered value
 * here has no effect on authorization.
 */

export interface StaffMembership {
  role: UserRole;
  hospitalId: string | null; // null for global_admin
  isPrimary: boolean;
}

export interface StaffContext {
  userId: string;
  fullName: string;
  role: UserRole; // effective primary role for the active tenant
  hospitalId: string | null; // active tenant context
  memberships: StaffMembership[];
  /** Hospitals the user can operate in (for a multi-hospital switcher). */
  accessibleHospitalIds: string[];
}

// Mirrors ROLE_HIERARCHY in _shared/auth.ts (used only to break display ties;
// the backend applies the authoritative rule).
const ROLE_LEVEL: Record<UserRole, number> = {
  global_admin: 100,
  hospital_admin: 50,
  doctor: 30,
  receptionist: 20,
};

/**
 * Reduce a user's role rows to one effective role, preferring the primary and
 * NEVER escalating (least-privileged wins on ambiguity) — same intent as the
 * server `selectRole`. Returns null when nothing is primary (fail-closed).
 */
function selectRoleForHospital(rows: StaffMembership[]): UserRole | null {
  if (rows.length === 0) return null;
  const primaries = rows.filter((r) => r.isPrimary);
  if (primaries.length === 1) return primaries[0].role;
  if (primaries.length > 1) {
    return primaries.reduce((lowest, c) =>
      ROLE_LEVEL[c.role] < ROLE_LEVEL[lowest.role] ? c : lowest,
    ).role;
  }
  return null;
}

export async function resolveStaffContext(
  userId: string,
  preferredHospitalId?: string | null,
): Promise<StaffContext | null> {
  const [{ data: profile }, { data: roleRows, error }] = await Promise.all([
    supabase.from("profiles").select("full_name,is_active").eq("id", userId).maybeSingle(),
    supabase.from("user_roles").select("role,hospital_id,is_primary").eq("user_id", userId),
  ]);

  if (error) throw error;
  if (!profile || profile.is_active === false) return null;

  const memberships: StaffMembership[] = (roleRows ?? []).map((r: {
    role: UserRole;
    hospital_id: string | null;
    is_primary: boolean;
  }) => ({
    role: r.role,
    hospitalId: r.hospital_id,
    isPrimary: r.is_primary,
  }));

  const accessibleHospitalIds = Array.from(
    new Set(
      memberships
        .map((m) => m.hospitalId)
        .filter((h): h is string => Boolean(h)),
    ),
  );

  // Choose the active tenant: explicit preference, else the sole accessible
  // hospital, else (global_admin with no hospital rows) null.
  const hospitalId =
    preferredHospitalId ?? accessibleHospitalIds[0] ?? null;

  const hospitalRows = memberships.filter((m) => m.hospitalId === hospitalId);
  let role = selectRoleForHospital(hospitalRows);

  // global_admin holds NULL-hospital grants and may act in any tenant.
  if (!role && memberships.some((m) => m.role === "global_admin")) {
    role = "global_admin";
  }

  if (!role) return null;

  return {
    userId,
    fullName: (profile.full_name as string) ?? "",
    role,
    hospitalId,
    memberships,
    accessibleHospitalIds,
  };
}
