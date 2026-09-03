/**
 * auth.ts — JWT validation, role enforcement, hospital access control
 *
 * Design:
 * - JWT is validated by calling Supabase's auth.getUser()
 *   (preferred over manual JWT decode — Supabase handles key rotation)
 * - Role is resolved from user_roles table, not the JWT claims
 *   (claims can be stale after role changes; DB is authoritative)
 * - Hospital access is enforced here, before any business logic runs
 * - All auth failures return typed errors, never throw raw strings
 *
 * Multi-role resolution (decision D-1): a user may hold several roles
 * at one hospital and be primary at several hospitals. `.single()` on
 * user_roles therefore used to ERROR rather than return a row, which
 * locked legitimate multi-role users out entirely. Resolution now goes
 * through `selectRole()`, which prefers the primary role and never
 * escalates. See its docstring for the rule; the database applies the
 * same one in `current_user_role()` (migration 49).
 */

import { createAuthClient, getServiceClient } from "./db.ts";
import {
  HospitalAccessDeniedError,
  RoleInsufficientError,
  UnauthorizedError,
} from "./errors.ts";
import type { AuthContext, DbProfile, UserRoleType } from "./types.ts";
import { Logger } from "./logger.ts";

// ─── JWT extraction ───────────────────────────────────────────────────────────

export function extractJwt(req: Request): string | null {
  const auth = req.headers.get("Authorization");
  if (!auth) return null;
  const [scheme, token] = auth.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

// ─── Role resolution (decision D-1) ──────────────────────────────────────────

// Exported for reuse by future role-threshold checks (e.g. requireMinRole).
// Also the single source of role levels used to break ties below: no
// second role model is introduced.
export const ROLE_HIERARCHY: Record<UserRoleType, number> = {
  global_admin: 100,
  hospital_admin: 50,
  doctor: 30,
  receptionist: 20,
};

interface RoleRow {
  role: UserRoleType;
  is_primary: boolean;
}

/**
 * Chooses ONE role from the set a user holds.
 *
 * SETURA supports several roles per user per hospital on purpose:
 * user_roles is UNIQUE(user_id, hospital_id, role), and the partial
 * unique index idx_primary_role allows exactly one is_primary row per
 * (user, hospital). None of that changes here. What changes is only
 * how the set is reduced to one effective role:
 *
 *   1. The is_primary role for the selected scope is authoritative.
 *   2. If several rows are primary — possible only across hospitals,
 *      since idx_primary_role forbids it within one — the LEAST
 *      privileged of them wins. Holding more roles must never grant
 *      more privilege.
 *   3. If nothing is primary the state is inconsistent and the answer
 *      is unknowable, so this returns null and the caller fails
 *      closed. Guessing here would either escalate or silently pick
 *      an arbitrary role, and both are worse than a denial.
 *
 * Returns null when no role can be resolved. Never throws.
 */
function selectRole(
  rows: RoleRow[],
  scope: string,
  userId: string,
  logger?: Logger,
): UserRoleType | null {
  if (rows.length === 0) {
    return null;
  }

  const primaries = rows.filter((r) => r.is_primary);

  if (primaries.length === 1) {
    return primaries[0].role;
  }

  if (primaries.length > 1) {
    const chosen = primaries.reduce((lowest, candidate) =>
      ROLE_HIERARCHY[candidate.role] < ROLE_HIERARCHY[lowest.role]
        ? candidate
        : lowest
    ).role;

    logger?.warn("Multiple primary roles; resolved to least privileged", {
      userId,
      scope,
      candidates: primaries.map((r) =>
        r.role
      ),
      resolved: chosen,
    });

    return chosen;
  }

  // rows.length > 0 and no primary among them.
  logger?.error("No primary role; denying access", undefined, {
    userId,
    scope,
    roles: rows.map((r) => r.role),
  });

  return null;
}

// ─── Core: validate JWT and load user profile + role ─────────────────────────

/**
 * Validates JWT, loads the authenticated user's profile, and resolves
 * their role for the given hospital (if hospitalId is provided).
 *
 * Role resolution is fail-closed at every step: an unreadable role
 * set, a role set with no primary, and no grant at all are all
 * denials, never a fallback to a lower-privilege default.
 *
 * Throws:
 *   UnauthorizedError — JWT missing, invalid, or expired
 *   HospitalAccessDeniedError — user is not a member of the hospital,
 *     or their roles there cannot be resolved to one effective role
 */
export async function resolveAuth(
  req: Request,
  hospitalId?: string | null,
  logger?: Logger,
): Promise<AuthContext> {
  const jwt = extractJwt(req);

  if (!jwt) {
    throw new UnauthorizedError("Missing Bearer token");
  }

  // Validate JWT via Supabase auth (handles signature, expiry, revocation)
  const authClient = createAuthClient(jwt);
  const { data: { user }, error: authError } = await authClient.auth.getUser();

  if (authError || !user) {
    logger?.warn("JWT validation failed", { authError: authError?.message });
    throw new UnauthorizedError("Invalid or expired token");
  }

  // Load profile from DB
  const db = getServiceClient();
  const { data: profile, error: profileError } = await db
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (profileError || !profile) {
    throw new UnauthorizedError("User profile not found");
  }

  if (!profile.is_active) {
    throw new UnauthorizedError("User account is inactive");
  }

  // Resolve role for hospital (if provided)
  let role: UserRoleType | null = null;

  if (hospitalId) {
    // Every role the user holds AT THIS HOSPITAL. Deliberately not
    // .single(): user_roles allows several roles per (user, hospital)
    // and .single() FAILS on more than one row, which used to deny a
    // legitimate multi-role user outright.
    const { data: hospitalRoles, error: hospitalRoleError } = await db
      .from("user_roles")
      .select("role, is_primary")
      .eq("user_id", user.id)
      .eq("hospital_id", hospitalId);

    if (hospitalRoleError) {
      // Fail closed: an unreadable role set is not an empty role set.
      logger?.error("Role lookup failed", hospitalRoleError, {
        userId: user.id,
        hospitalId,
      });
      throw new HospitalAccessDeniedError(hospitalId);
    }

    const rows = (hospitalRoles ?? []) as RoleRow[];

    if (rows.length > 0) {
      role = selectRole(rows, `hospital ${hospitalId}`, user.id, logger);

      if (!role) {
        throw new HospitalAccessDeniedError(hospitalId);
      }
    } else {
      // No grant at this hospital. A global_admin may still act.
      //
      // global_admin rows have hospital_id IS NULL by the
      // role_hospital_consistency CHECK, so they never appear above.
      // They are also not de-duplicated by
      // UNIQUE(user_id, hospital_id, role) -- PostgreSQL treats NULLs
      // as distinct -- so a user can hold more than one such row.
      // .limit(1) instead of .single() for exactly that reason.
      const { data: globalAdminRows, error: globalAdminError } = await db
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .eq("role", "global_admin")
        .limit(1);

      if (
        globalAdminError || !globalAdminRows || globalAdminRows.length === 0
      ) {
        throw new HospitalAccessDeniedError(hospitalId);
      }

      role = "global_admin";
    }
  } else {
    // No hospital context: resolve across every hospital the user
    // belongs to. A user who is primary at two hospitals has two
    // is_primary rows (idx_primary_role is per user+hospital), so
    // .single() used to fail here and leave role null.
    const { data: allRoles, error: allRolesError } = await db
      .from("user_roles")
      .select("role, is_primary")
      .eq("user_id", user.id);

    if (allRolesError) {
      logger?.error("Role lookup failed", allRolesError, { userId: user.id });
      role = null;
    } else {
      role = selectRole(
        (allRoles ?? []) as RoleRow[],
        "no hospital context",
        user.id,
        logger,
      );
    }
  }

  return {
    userId: user.id,
    hospitalId: hospitalId ?? null,
    role,
    jwt,
    profile: profile as DbProfile,
  };
}

// ─── Role enforcement helpers ─────────────────────────────────────────────────

/**
 * Asserts that the authenticated user has at least one of the required roles.
 * global_admin always passes.
 */
export function requireRole(
  auth: AuthContext,
  required: UserRoleType[],
): void {
  if (!auth.role) {
    throw new RoleInsufficientError(required, null);
  }
  if (auth.role === "global_admin") return; // always passes
  if (!required.includes(auth.role)) {
    throw new RoleInsufficientError(required, auth.role);
  }
}

export function requireHospitalAccess(
  auth: AuthContext,
  hospitalId: string,
): void {
  if (auth.role === "global_admin") return;
  if (auth.hospitalId !== hospitalId) {
    throw new HospitalAccessDeniedError(hospitalId);
  }
}

export function isGlobalAdmin(auth: AuthContext): boolean {
  return auth.role === "global_admin";
}

export function hasRole(auth: AuthContext, role: UserRoleType): boolean {
  if (auth.role === "global_admin") return true;
  return auth.role === role;
}

export function canManageQueue(auth: AuthContext): boolean {
  return (
    auth.role === "global_admin" ||
    auth.role === "hospital_admin" ||
    auth.role === "receptionist"
  );
}

export function canViewAnalytics(auth: AuthContext): boolean {
  return (
    auth.role === "global_admin" ||
    auth.role === "hospital_admin"
  );
}

// ─── Middleware composition ───────────────────────────────────────────────────

export interface HandlerOptions {
  requireAuth?: boolean;
  hospitalIdSource?: "body" | "header" | "param" | "none";
  requiredRoles?: UserRoleType[];
}

/**
 * Middleware wrapper that resolves auth before calling the inner handler.
 * Usage:
 *
 *   Deno.serve(withAuth(async (req, auth) => {
 *     // auth is always non-null here
 *   }, { requiredRoles: ["receptionist", "hospital_admin"] }))
 */
export function withAuth(
  handler: (
    req: Request,
    auth: AuthContext,
    logger: Logger,
  ) => Promise<Response>,
  opts: HandlerOptions = {},
  logger?: Logger,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const { handleCors } = await import("./cors.ts");
    const corsResponse = handleCors(req);
    if (corsResponse) return corsResponse;

    const { handleErrorResponse } = await import("./response.ts");
    const correlationId = req.headers.get("X-Correlation-ID") ??
      crypto.randomUUID();

    try {
      // Resolve hospital ID from header (most common for SETURA)
      const hospitalId = req.headers.get("X-Hospital-ID") ?? undefined;

      const auth = await resolveAuth(req, hospitalId, logger);

      if (opts.requiredRoles && opts.requiredRoles.length > 0) {
        requireRole(auth, opts.requiredRoles);
      }

      return await handler(req, auth, logger ?? new Logger({ correlationId }));
    } catch (err) {
      return handleErrorResponse(err, correlationId, req);
    }
  };
}
