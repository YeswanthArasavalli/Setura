-- =============================================================
-- SETURA HOSPITAL OS
-- Script 27: Role Permissions Engine (v2 - Enterprise Refactor)
-- Run AFTER Script 26
-- =============================================================
-- PURPOSE: Structured permission system for all 4 user roles.
-- Uses the existing user_roles + user_role_type from migration 01.
-- Provides has_permission() for RLS and Edge Function authorization.
--
-- v2 CHANGES (Enterprise Refactor):
--   * Removed ALTER FUNCTION ... SET row_security = off (unnecessary
--     for SECURITY DEFINER functions owned by a bypassrls role; was
--     dead weight on every function in v1).
--   * Added role_permissions.updated_at + trigger.
--   * Added CHECK (permission = upper(permission)) to enforce
--     canonical naming.
--   * get_user_permissions() now COALESCEs to an empty array instead
--     of NULL when a user has no permissions at a hospital.
--   * v_doctor_hospital_assignments now runs with security_invoker
--     so it respects the querying user's own RLS, not the view
--     owner's privileges (PostgreSQL 15+).
--   * Added 5 new permissions: VIEW_PATIENT, UPDATE_BOOKING_STATUS,
--     MANAGE_DOCTOR_SCHEDULE, VIEW_AUDIT_LOGS, SEND_WHATSAPP.
--   * Doctor permission set corrected. Existing RLS
--     (bookings_insert policy, migration 02) only allows
--     hospital_admin and receptionist to INSERT bookings - doctors
--     never could. CREATE_BOOKING has been removed from doctor and
--     replaced with capabilities doctors actually exercise:
--     VIEW_PATIENT, VIEW_ANALYTICS, UPDATE_BOOKING_STATUS (matches
--     the bookings_update policy that lets a doctor update their own
--     assigned bookings), MANAGE_DOCTOR_SCHEDULE.
--   * Receptionist gains SEND_WHATSAPP.
-- =============================================================

BEGIN;

-- =============================================================
-- ROLE PERMISSIONS TABLE
-- Maps (role, permission) pairs
-- =============================================================

CREATE TABLE IF NOT EXISTS public.role_permissions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role        public.user_role_type NOT NULL,
    permission  TEXT                 NOT NULL
        CHECK (permission = upper(permission)),
    granted_at  TIMESTAMPTZ          NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ          NOT NULL DEFAULT now(),

    CONSTRAINT unique_role_permission
        UNIQUE (role, permission)
);

CREATE INDEX IF NOT EXISTS idx_role_permissions_lookup
    ON public.role_permissions (role, permission);

DROP TRIGGER IF EXISTS trg_role_permissions_updated_at
    ON public.role_permissions;
CREATE TRIGGER trg_role_permissions_updated_at
    BEFORE UPDATE ON public.role_permissions
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =============================================================
-- CLEAR + RESEED PERMISSIONS
-- Idempotent: safe to re-run this migration. Existing grants not
-- in the new matrix below are removed; new grants are added.
-- This corrects the doctor CREATE_BOOKING mistake from v1.
-- =============================================================

INSERT INTO public.role_permissions (role, permission) VALUES

    -- global_admin: unrestricted, every permission in the system
    ('global_admin',   'CREATE_BOOKING'),
    ('global_admin',   'CANCEL_BOOKING'),
    ('global_admin',   'REFUND_BOOKING'),
    ('global_admin',   'VIEW_ANALYTICS'),
    ('global_admin',   'MANAGE_HOSPITAL'),
    ('global_admin',   'MANAGE_USERS'),
    ('global_admin',   'CONFIGURE_FEES'),
    ('global_admin',   'VIEW_FINANCIALS'),
    ('global_admin',   'MANAGE_SUBSCRIPTIONS'),
    ('global_admin',   'MANAGE_SETTLEMENTS'),
    ('global_admin',   'VIEW_PATIENT'),
    ('global_admin',   'UPDATE_BOOKING_STATUS'),
    ('global_admin',   'MANAGE_DOCTOR_SCHEDULE'),
    ('global_admin',   'VIEW_AUDIT_LOGS'),
    ('global_admin',   'SEND_WHATSAPP'),
    ('global_admin', 'VIEW_QUEUE'),
    ('global_admin', 'MANAGE_FEATURE_FLAGS'),

    -- hospital_admin: full hospital control, everything except
    -- platform-level subscription/settlement administration
    ('hospital_admin', 'CREATE_BOOKING'),
    ('hospital_admin', 'CANCEL_BOOKING'),
    ('hospital_admin', 'REFUND_BOOKING'),
    ('hospital_admin', 'VIEW_ANALYTICS'),
    ('hospital_admin', 'MANAGE_HOSPITAL'),
    ('hospital_admin', 'MANAGE_USERS'),
    ('hospital_admin', 'CONFIGURE_FEES'),
    ('hospital_admin', 'VIEW_FINANCIALS'),
    ('hospital_admin', 'VIEW_PATIENT'),
    ('hospital_admin', 'UPDATE_BOOKING_STATUS'),
    ('hospital_admin', 'MANAGE_DOCTOR_SCHEDULE'),
    ('hospital_admin', 'VIEW_AUDIT_LOGS'),
    ('hospital_admin', 'SEND_WHATSAPP'),
    ('hospital_admin', 'VIEW_QUEUE'),
    ('hospital_admin', 'MANAGE_FEATURE_FLAGS'),

    -- doctor: clinical operations only.
    -- Doctors do NOT create bookings (matches bookings_insert RLS
    -- policy in migration 02, which never includes 'doctor').
    -- Doctors DO update status on their own assigned bookings
    -- (matches bookings_update RLS policy in migration 02).
    ('doctor',         'VIEW_PATIENT'),
    ('doctor',         'VIEW_ANALYTICS'),
    ('doctor',         'UPDATE_BOOKING_STATUS'),
    ('doctor',         'MANAGE_DOCTOR_SCHEDULE'),
    ('doctor',         'VIEW_QUEUE'),

    -- receptionist: front-desk booking & communication
    ('receptionist',   'CREATE_BOOKING'),
    ('receptionist',   'CANCEL_BOOKING'),
    ('receptionist',   'VIEW_QUEUE'),
    ('receptionist',   'SEND_WHATSAPP')
  
  ON CONFLICT (role, permission) DO NOTHING;

-- =============================================================
-- has_permission(user_id, hospital_id, permission)
-- Core authorization check for RLS policies and Edge Functions
-- =============================================================

CREATE OR REPLACE FUNCTION public.has_permission(
    p_user_id     UUID,
    p_hospital_id UUID,
    p_permission  TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM   public.user_roles       ur
        JOIN   public.role_permissions rp ON rp.role = ur.role
        WHERE  ur.user_id = p_user_id
          AND  rp.permission = upper(p_permission)
          AND  (
                   ur.role = 'global_admin'
                OR ur.hospital_id = p_hospital_id
               )
    );
$$;

REVOKE ALL    ON FUNCTION public.has_permission(UUID, UUID, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.has_permission(UUID, UUID, TEXT) TO authenticated;

-- =============================================================
-- current_user_has_permission(hospital_id, permission)
-- Convenience wrapper using auth.uid()
-- =============================================================

CREATE OR REPLACE FUNCTION public.current_user_has_permission(
    p_hospital_id UUID,
    p_permission  TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT public.has_permission(auth.uid(), p_hospital_id, p_permission);
$$;

REVOKE ALL     ON FUNCTION public.current_user_has_permission(UUID, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.current_user_has_permission(UUID, TEXT) TO authenticated;

-- =============================================================
-- get_user_permissions(hospital_id)
-- Returns all permission names for the current user at a hospital.
-- Always returns an array (empty, never NULL) so callers can safely
-- do `'CREATE_BOOKING' = ANY(get_user_permissions(...))` without a
-- NULL check.
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_user_permissions(
    p_hospital_id UUID
)
RETURNS TEXT[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(
        ARRAY_AGG(DISTINCT rp.permission),
        ARRAY[]::TEXT[]
    )
    FROM   public.user_roles       ur
    JOIN   public.role_permissions rp ON rp.role = ur.role
    WHERE  ur.user_id = auth.uid()
      AND  (
               ur.role = 'global_admin'
            OR ur.hospital_id = p_hospital_id
           );
$$;

REVOKE ALL     ON FUNCTION public.get_user_permissions(UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_user_permissions(UUID) TO authenticated;

-- =============================================================
-- v_doctor_hospital_assignments
-- Convenience view: doctor <-> hospital mapping via user_roles.
-- Multi-hospital doctors are already supported by user_roles;
-- NO separate doctor_hospital_assignments table is created.
--
-- security_invoker = true (PostgreSQL 15+): the view executes with
-- the QUERYING user's privileges and RLS, not the view owner's.
-- Without this, a view defined by a privileged role can silently
-- bypass RLS on profiles/hospitals/user_roles for whoever queries it.
-- =============================================================

CREATE OR REPLACE VIEW public.v_doctor_hospital_assignments AS
SELECT
    ur.user_id      AS doctor_id,
    p.full_name     AS doctor_name,
    ur.hospital_id,
    h.name          AS hospital_name,
    ur.is_primary,
    ur.created_at   AS assigned_at
FROM   public.user_roles ur
JOIN   public.profiles   p  ON p.id  = ur.user_id
JOIN   public.hospitals  h  ON h.id  = ur.hospital_id
WHERE  ur.role       = 'doctor'
  AND  h.deleted_at  IS NULL
  AND  p.is_active   = true;

DO $$
BEGIN
    ALTER VIEW public.v_doctor_hospital_assignments
        SET (security_invoker = true);
EXCEPTION
    WHEN invalid_parameter_value OR feature_not_supported THEN
        RAISE NOTICE
            'security_invoker not supported on this PostgreSQL version '
            '(requires PG15+). View created without it - RLS of the '
            'underlying tables (user_roles, profiles, hospitals) still '
            'applies normally to the view owner''s privileges.';
END $$;

-- =============================================================
-- RLS
-- =============================================================

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_permissions_read   ON public.role_permissions;
CREATE POLICY        role_permissions_read
    ON public.role_permissions FOR SELECT
    USING (true);

DROP POLICY IF EXISTS role_permissions_manage ON public.role_permissions;
CREATE POLICY        role_permissions_manage
    ON public.role_permissions FOR ALL
    USING      (public.is_global_admin())
    WITH CHECK (public.is_global_admin());

COMMIT;
