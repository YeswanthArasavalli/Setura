-- =============================================================
-- 61_staff_doctor_directory_read.sql
--
-- Product gap (Phase 7, reception UX): the reception doctor picker
-- and the queue board cannot show a doctor's NAME.
--
-- Root cause is a privilege boundary, not a UI bug. The assignable-
-- doctors read (apps/web/src/api/reads.ts -> doctor_specializations
-- with an embedded profiles(full_name)) is allowed on the
-- specialization row itself (doctor_spec_read, migration 03:
-- user_has_hospital_access) but the embedded profiles row is filtered
-- by its own policies. Migration 01 gives profiles only two of them:
-- profiles_self (id = auth.uid()) and profiles_admin_read
-- (global_admin OR same-hospital hospital_admin). For a receptionist
-- the embedded row is therefore empty and the UI falls back to the
-- specialization label - the picker reads "Cardiology . Cardiology"
-- instead of naming the doctor the reception desk is about to queue a
-- patient in front of.
--
-- Fix: one additional, narrowly-scoped SELECT policy on profiles that
-- lets same-hospital staff read a doctor's directory row.
--
--   * SELECT only - no INSERT/UPDATE/DELETE, so it cannot authorize
--     any mutation.
--   * Readable rows are restricted to principals that actually hold
--     the 'doctor' role at a hospital the reader also belongs to, so
--     tenancy is enforced by the policy itself and a cross-hospital
--     read returns zero rows rather than an error.
--   * profiles carries no financial or clinical column (01: full_name,
--     normalized_phone, avatar_url, preferred_language, is_active,
--     last_login_at, timestamps) and no later migration has added a
--     column to it, so the exposure is the staff-directory fields the
--     front desk needs.
--
-- WHY A SECURITY DEFINER HELPER (and not an inlined user_roles join):
-- the tenancy check must read BOTH the reader's user_roles row and the
-- target doctor's user_roles row. user_roles_read (01) exposes only
-- user_id = auth.uid() (plus global admin), so an authenticated reader
-- cannot see the doctor's role row from a plain policy subquery - the
-- target side of the join is empty and the policy would grant nothing.
-- profiles_admin_read (01) has the same shape and is likewise only
-- effective for its holders; it is not a general directory read.
--
-- The proven primitive for crossing the user_roles RLS boundary is a
-- SECURITY DEFINER helper with row_security = off, exactly as
-- user_has_hospital_access (01) does. So the predicate is evaluated in
-- user_is_same_hospital_doctor(), a definer function that reads
-- user_roles with the definer's rights and returns a single boolean.
-- Following the F16-04 rule, the new definer routine gets its OWN
-- explicit REVOKE (PUBLIC, anon) and a GRANT EXECUTE to authenticated
-- only; it exposes no table and takes the target id as a parameter.
--
-- This does NOT widen role_permissions, system_settings or any other
-- table migration 48 hardened, and it re-grants EXECUTE on no existing
-- routine.
-- =============================================================

CREATE OR REPLACE FUNCTION public.user_is_same_hospital_doctor(
    p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles my_role
        JOIN public.user_roles their_role
            ON their_role.hospital_id = my_role.hospital_id
        WHERE my_role.user_id = auth.uid()
          AND their_role.user_id = p_user_id
          AND my_role.hospital_id IS NOT NULL
          AND my_role.role IN ('hospital_admin', 'doctor', 'receptionist')
          AND their_role.role = 'doctor'
    );
$$;

ALTER FUNCTION public.user_is_same_hospital_doctor(UUID)
SET row_security = off;

REVOKE ALL
ON FUNCTION public.user_is_same_hospital_doctor(UUID)
FROM PUBLIC;

REVOKE ALL
ON FUNCTION public.user_is_same_hospital_doctor(UUID)
FROM anon;

GRANT EXECUTE
ON FUNCTION public.user_is_same_hospital_doctor(UUID)
TO authenticated;

DROP POLICY IF EXISTS profiles_staff_read_doctors
ON public.profiles;

CREATE POLICY profiles_staff_read_doctors
ON public.profiles
FOR SELECT
TO authenticated
USING ( public.user_is_same_hospital_doctor(id) );
