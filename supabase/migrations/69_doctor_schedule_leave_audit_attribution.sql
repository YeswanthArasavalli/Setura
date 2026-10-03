-- =============================================================
-- 69_doctor_schedule_leave_audit_attribution.sql
--
-- WS-ONBOARD-4 follow-up (additive). Migration 68 is committed in
-- supabase/migrations/MANIFEST.sha256 and already applied, so it is a
-- historical artifact and is NOT edited here. This migration redefines
-- exactly the two upsert RPCs whose JSONB result omitted the row id.
--
-- Why: an audit event must name the entity it changed (AGENTS.md 8).
-- `upsert_doctor_schedule` / `upsert_doctor_leave` returned the mutated
-- values but not the id of the row they wrote, so the Edge Function could
-- only audit doctor_schedule_create / doctor_leave_create with a NULL
-- entity_id - the event existed but could not be attributed to a row.
--
-- Change is purely additive to the returned JSONB object
-- (schedule_id / leave_id). Signatures, parameter order, tenant checks,
-- invariants, EXCLUDE-constraint pre-checks and every existing key are
-- byte-for-byte the text of migration 68.
--
-- F16-04: a resignatured SECURITY DEFINER function re-asserts its own
-- REVOKE/GRANT boundary below rather than relying on the prior ACL being
-- preserved. Verified afterwards against pg_proc.proacl, not this text.
-- =============================================================

SET search_path = public;

CREATE OR REPLACE FUNCTION public.upsert_doctor_schedule(
    p_actor_user_id UUID,
    p_hospital_id UUID,
    p_doctor_id UUID,
    p_weekday INTEGER,
    p_start_time TIME,
    p_end_time TIME,
    p_max_tokens INTEGER DEFAULT 50,
    p_average_consultation_minutes INTEGER DEFAULT 10,
    p_is_active BOOLEAN DEFAULT true,
    -- Create/update discriminator. NULL means create. It is LAST with
    -- DEFAULT NULL because PostgreSQL requires every parameter after a
    -- defaulted one to be defaulted too, and a required parameter would make
    -- the generated client type a non-nullable string the caller would have
    -- to fake with an explicit JSON null.
    p_schedule_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.doctor_schedules%ROWTYPE;
    v_doctor_active BOOLEAN;
    v_overlap BOOLEAN;
    v_created BOOLEAN := false;
    -- Names the row this call wrote, so the caller's audit event can be
    -- attributed. A schedule audit with a NULL entity cannot be traced back.
    v_id UUID;
BEGIN

    IF p_actor_user_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = p_actor_user_id AND role = 'global_admin'
    ) AND NOT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = p_actor_user_id
          AND role = 'hospital_admin'
          AND hospital_id = p_hospital_id
    ) THEN
        RAISE EXCEPTION 'actor is not authorized for this hospital'
            USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = p_doctor_id
          AND hospital_id = p_hospital_id
          AND role = 'doctor'
    ) THEN
        RAISE EXCEPTION 'doctor not found in this hospital'
            USING ERRCODE = 'P0002';
    END IF;

    -- -- Server-side invariants -----------------------------------
    IF p_weekday IS NULL OR p_weekday NOT BETWEEN 0 AND 6 THEN
        RAISE EXCEPTION 'weekday must be between 0 (Sunday) and 6 (Saturday)'
            USING ERRCODE = '22023';
    END IF;

    IF p_start_time IS NULL OR p_end_time IS NULL THEN
        RAISE EXCEPTION 'schedule start and end time are required'
            USING ERRCODE = '22023';
    END IF;

    IF p_end_time <= p_start_time THEN
        RAISE EXCEPTION 'schedule end time must be after start time'
            USING ERRCODE = '22023';
    END IF;

    IF p_max_tokens IS NULL OR p_max_tokens <= 0 THEN
        RAISE EXCEPTION 'max tokens must be a positive integer'
            USING ERRCODE = '22023';
    END IF;

    IF p_average_consultation_minutes IS NULL
       OR p_average_consultation_minutes NOT BETWEEN 1 AND 240 THEN
        RAISE EXCEPTION 'average consultation minutes must be between 1 and 240'
            USING ERRCODE = '22023';
    END IF;

    IF p_is_active IS NULL THEN
        RAISE EXCEPTION 'is_active is required'
            USING ERRCODE = '22023';
    END IF;

    -- The domain requires an inactive doctor to hold no active schedule; the
    -- availability engine would otherwise still report the doctor available.
    IF p_is_active THEN
        SELECT is_active INTO v_doctor_active FROM public.profiles
        WHERE id = p_doctor_id;
        IF coalesce(v_doctor_active, false) IS NOT TRUE THEN
            RAISE EXCEPTION 'cannot create an active schedule for an inactive doctor'
                USING ERRCODE = '22023';
        END IF;
    END IF;

    IF p_schedule_id IS NOT NULL THEN
        SELECT * INTO v_row FROM public.doctor_schedules
        WHERE id = p_schedule_id
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'schedule not found'
                USING ERRCODE = 'P0002';
        END IF;

        IF v_row.hospital_id <> p_hospital_id OR v_row.doctor_id <> p_doctor_id THEN
            RAISE EXCEPTION 'schedule does not belong to this doctor and hospital'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    -- Overlap pre-check matching the EXCLUDE constraint exactly: same doctor,
    -- hospital and weekday, is_deleted = false, IGNORING is_active (an
    -- inactive schedule still owns its range) and excluding the row being
    -- updated. The constraint remains the atomic backstop.
    SELECT EXISTS (
        SELECT 1 FROM public.doctor_schedules s
        WHERE s.doctor_id = p_doctor_id
          AND s.hospital_id = p_hospital_id
          AND s.weekday = p_weekday
          AND s.is_deleted = false
          AND (p_schedule_id IS NULL OR s.id <> p_schedule_id)
          AND s.start_time < p_end_time
          AND s.end_time > p_start_time
    ) INTO v_overlap;

    IF v_overlap THEN
        RAISE EXCEPTION 'this schedule overlaps an existing schedule'
            USING ERRCODE = '23P01';
    END IF;

    IF v_row.id IS NULL THEN
        INSERT INTO public.doctor_schedules (
            doctor_id, hospital_id, weekday, start_time, end_time,
            max_tokens, average_consultation_minutes, is_active, created_by
        )
        VALUES (
            p_doctor_id, p_hospital_id, p_weekday, p_start_time, p_end_time,
            p_max_tokens, p_average_consultation_minutes, p_is_active, p_actor_user_id
        )
        RETURNING id INTO v_id;
        v_created := true;
    ELSE
        UPDATE public.doctor_schedules
           SET weekday                      = p_weekday,
               start_time                   = p_start_time,
               end_time                     = p_end_time,
               max_tokens                   = p_max_tokens,
               average_consultation_minutes = p_average_consultation_minutes,
               is_active                    = p_is_active
         WHERE id = p_schedule_id;
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'created', v_created,
        'schedule_id', coalesce(p_schedule_id, v_id),
        'doctor_id', p_doctor_id,
        'hospital_id', p_hospital_id,
        'weekday', p_weekday,
        'start_time', p_start_time,
        'end_time', p_end_time,
        'max_tokens', p_max_tokens,
        'is_active', p_is_active
    );
END;
$$;

ALTER FUNCTION public.upsert_doctor_schedule(UUID, UUID, UUID, INTEGER, TIME, TIME, INTEGER, INTEGER, BOOLEAN, UUID)
    SET row_security = off;

REVOKE ALL ON FUNCTION public.upsert_doctor_schedule(UUID, UUID, UUID, INTEGER, TIME, TIME, INTEGER, INTEGER, BOOLEAN, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_doctor_schedule(UUID, UUID, UUID, INTEGER, TIME, TIME, INTEGER, INTEGER, BOOLEAN, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.upsert_doctor_schedule(UUID, UUID, UUID, INTEGER, TIME, TIME, INTEGER, INTEGER, BOOLEAN, UUID) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.upsert_doctor_schedule(UUID, UUID, UUID, INTEGER, TIME, TIME, INTEGER, INTEGER, BOOLEAN, UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.upsert_doctor_leave(
    p_actor_user_id UUID,
    p_hospital_id UUID,
    p_doctor_id UUID,
    p_leave_start_date DATE,
    p_leave_end_date DATE,
    p_leave_type TEXT DEFAULT 'other',
    p_reason TEXT DEFAULT NULL,
    p_notes TEXT DEFAULT NULL,
    -- Create/update discriminator, last for the same PostgreSQL ordering rule
    -- as the schedule parameter above.
    p_leave_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.doctor_leaves%ROWTYPE;
    v_created BOOLEAN := false;
    -- See upsert_doctor_schedule above: the leave audit must name its row.
    v_id UUID;
BEGIN

    IF p_actor_user_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = p_actor_user_id AND role = 'global_admin'
    ) AND NOT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = p_actor_user_id
          AND role = 'hospital_admin'
          AND hospital_id = p_hospital_id
    ) THEN
        RAISE EXCEPTION 'actor is not authorized for this hospital'
            USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = p_doctor_id
          AND hospital_id = p_hospital_id
          AND role = 'doctor'
    ) THEN
        RAISE EXCEPTION 'doctor not found in this hospital'
            USING ERRCODE = 'P0002';
    END IF;

    IF p_leave_start_date IS NULL OR p_leave_end_date IS NULL THEN
        RAISE EXCEPTION 'leave start and end date are required'
            USING ERRCODE = '22023';
    END IF;

    IF p_leave_end_date < p_leave_start_date THEN
        RAISE EXCEPTION 'leave end date must not precede the start date'
            USING ERRCODE = '22023';
    END IF;

    -- Enum membership checked against the catalog so a bad value is a clean
    -- 22023 instead of an opaque 22P02 cast error.
    IF NOT EXISTS (
        SELECT 1
        FROM pg_type t
        JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname = 'doctor_leave_type'
          AND e.enumlabel = p_leave_type
    ) THEN
        RAISE EXCEPTION 'unrecognized leave type'
            USING ERRCODE = '22023';
    END IF;

    IF p_leave_id IS NOT NULL THEN
        SELECT * INTO v_row FROM public.doctor_leaves
        WHERE id = p_leave_id
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'leave not found'
                USING ERRCODE = 'P0002';
        END IF;

        IF v_row.hospital_id <> p_hospital_id OR v_row.doctor_id <> p_doctor_id THEN
            RAISE EXCEPTION 'leave does not belong to this doctor and hospital'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    -- no_overlapping_doctor_leaves is (doctor_id, daterange) with
    -- is_deleted = false only - it ignores hospital AND status. Pre-check on
    -- exactly those terms so the caller gets a deterministic conflict rather
    -- than a surprise exclusion violation.
    IF EXISTS (
        SELECT 1 FROM public.doctor_leaves l
        WHERE l.doctor_id = p_doctor_id
          AND l.is_deleted = false
          AND (p_leave_id IS NULL OR l.id <> p_leave_id)
          AND l.leave_start_date <= p_leave_end_date
          AND l.leave_end_date >= p_leave_start_date
    ) THEN
        RAISE EXCEPTION 'this leave overlaps an existing leave for this doctor'
            USING ERRCODE = '23P01';
    END IF;

    IF v_row.id IS NULL THEN
        -- Admin-created leave is APPROVED on creation: is_doctor_available()
        -- only honours leave_status = 'approved', so a 'pending' row would be
        -- stored but ignored - a fake capability. The hospital admin creating
        -- it IS the approver.
        INSERT INTO public.doctor_leaves (
            doctor_id, hospital_id, leave_start_date, leave_end_date,
            reason, approved_by, leave_type, leave_status, approved_at, notes
        )
        VALUES (
            p_doctor_id, p_hospital_id, p_leave_start_date, p_leave_end_date,
            NULLIF(btrim(coalesce(p_reason, '')), ''), p_actor_user_id,
            p_leave_type::public.doctor_leave_type, 'approved', now(),
            NULLIF(btrim(coalesce(p_notes, '')), '')
        )
        RETURNING id INTO v_id;
        v_created := true;
    ELSE
        UPDATE public.doctor_leaves
           SET leave_start_date = p_leave_start_date,
               leave_end_date   = p_leave_end_date,
               leave_type       = p_leave_type::public.doctor_leave_type,
               reason           = coalesce(NULLIF(btrim(coalesce(p_reason, '')), ''), reason),
               notes            = coalesce(NULLIF(btrim(coalesce(p_notes, '')), ''), notes)
         WHERE id = p_leave_id;
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'created', v_created,
        'leave_id', coalesce(p_leave_id, v_id),
        'doctor_id', p_doctor_id,
        'hospital_id', p_hospital_id,
        'start_date', p_leave_start_date,
        'end_date', p_leave_end_date,
        'leave_type', p_leave_type,
        'leave_status', 'approved'
    );
END;
$$;

ALTER FUNCTION public.upsert_doctor_leave(UUID, UUID, UUID, DATE, DATE, TEXT, TEXT, TEXT, UUID)
    SET row_security = off;

REVOKE ALL ON FUNCTION public.upsert_doctor_leave(UUID, UUID, UUID, DATE, DATE, TEXT, TEXT, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_doctor_leave(UUID, UUID, UUID, DATE, DATE, TEXT, TEXT, TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.upsert_doctor_leave(UUID, UUID, UUID, DATE, DATE, TEXT, TEXT, TEXT, UUID) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.upsert_doctor_leave(UUID, UUID, UUID, DATE, DATE, TEXT, TEXT, TEXT, UUID) TO service_role;

