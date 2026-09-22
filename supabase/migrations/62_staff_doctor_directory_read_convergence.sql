-- =============================================================
-- 62_staff_doctor_directory_read_convergence.sql
--
-- WHY THIS MIGRATION EXISTS (not an edit to 61):
-- version 61 has already been APPLIED on the shared STAGING project
-- with its ORIGINAL content, which used an inlined user_roles
-- self-join. That shape is inert: user_roles_read (01) exposes only a
-- user's OWN role rows, so the target-doctor side of the join is
-- invisible to a receptionist and the policy returns zero extra rows
-- (verified directly on staging: policy profiles_staff_read_doctors
-- present, helper function absent). The workspace copy of 61 was later
-- corrected to use a SECURITY DEFINER helper, but a recorded migration
-- version is never re-run by `supabase db push` and must not be edited
-- in place (migration immutability). So the corrected behavior is
-- delivered forward as an additive migration, exactly as the operating
-- contract requires.
--
-- This file is IDEMPOTENT and CONVERGES any environment to the intended
-- end state regardless of which 61 it ran:
--   * CREATE OR REPLACE the same narrowly-scoped helper;
--   * DROP ... IF EXISTS then CREATE the SELECT-only policy that calls
--     it, replacing a stale broken version if one is present.
-- On a fresh database it simply re-establishes what corrected-61 built.
--
-- Security posture (F16-04): the newly (re)defined SECURITY DEFINER
-- routine gets its OWN explicit REVOKE (PUBLIC, anon) and a GRANT
-- EXECUTE to authenticated only. SELECT only, tenant-scoped to doctors
-- who share a hospital with the reader. No other table or routine
-- privilege is touched.
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
