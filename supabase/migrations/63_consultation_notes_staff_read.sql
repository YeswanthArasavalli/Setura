-- =============================================================
-- 63_consultation_notes_staff_read.sql
--
-- Product gap (Phase 7, clinical-note UI): consultation notes and
-- diagnosis summaries are persisted by the doctor flow
-- (doctor-operations -> save_consultation_note), but no authorized
-- read surface exists, so staff-facing UI cannot display them.
-- PHASE_7_CLINICAL_NOTE_UI_COMPLETION_REPORT.md documented this
-- READ-SURFACE GAP; this migration closes it with the minimum
-- additive change, explicitly authorized by the owner.
--
-- Current posture (migration 46), preserved except where widened:
--   * RLS enabled with ZERO policies -> every direct client read was
--     refused ("denies any residual direct access").
--   * Table ACL: SELECT, INSERT to service_role only; PUBLIC, anon and
--     authenticated fully revoked.
--   * Append-only: mutation trigger refuses direct UPDATE/DELETE; the
--     service-role-only writer RPC is the sole INSERT path.
--
-- Fix: ONE narrowly-scoped SELECT policy for staff + the matching
-- table GRANT, using the exact authorization model already established
-- by bookings_read_admin / bookings_read_doctor (migration 02). No new
-- SECURITY DEFINER routine is introduced, so no F16-04 REVOKE is
-- required; the policy body only calls the migration-01 helpers, which
-- are already SECURITY DEFINER with row_security = off and EXECUTE for
-- authenticated (current_user_role reads user_roles across its RLS
-- boundary with definer rights - the proven primitive).
--
-- Visibility (mirrors booking-read semantics for consultation_notes):
--   * global_admin            -> same global-admin model as bookings;
--   * hospital_admin /
--     receptionist of the row -> hospital-wide read, because they may
--     already read every booking of their hospital (the note's booking
--     is fully visible to them; this adds no new entity);
--   * doctor                  -> ONLY rows they authored
--     (doctor_id = auth.uid()) AND only while they still hold the
--     doctor role at that row's hospital. doctor_id is set solely from
--     the authenticated actor in doctor-operations, so "authored" and
--     "assigned treating doctor" are the same fact at write time;
--   * anon / any other role   -> zero rows (no policy matches);
--   * other hospitals         -> zero rows, never an error.
--
-- Explicitly NOT touched: writer RPC privileges, immutability
-- trigger, service_role grants, every other table/policy. No
-- INSERT/UPDATE/DELETE policy is created and authenticated gains
-- SELECT only - the append-only write path stays service-role-only.
-- =============================================================

DROP POLICY IF EXISTS consultation_notes_staff_read
ON public.consultation_notes;

CREATE POLICY consultation_notes_staff_read
ON public.consultation_notes
FOR SELECT
TO authenticated
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        IN (
            'hospital_admin',
            'receptionist'
        )
    OR (
        doctor_id = auth.uid()
        AND public.current_user_role(hospital_id) = 'doctor'
    )
);

-- Table privilege that makes the policy reachable. Stated explicitly
-- in the fail-closed direction first (PUBLIC/anon revoked again even
-- if already revoked, so the intended posture does not depend on
-- historical defaults), then the single widening GRANT.
REVOKE ALL ON public.consultation_notes FROM PUBLIC;
REVOKE ALL ON public.consultation_notes FROM anon;

GRANT SELECT ON public.consultation_notes TO authenticated;

COMMENT ON POLICY consultation_notes_staff_read
ON public.consultation_notes IS
'Phase 7: authorized staff SELECT read of consultation notes/diagnosis.
SELECT-only, mirrors bookings_read_admin/bookings_read_doctor tenancy
semantics; doctors see only rows they authored. Writer path unchanged
(service-role-only RPC); INSERT/UPDATE/DELETE remain ungranted.';
