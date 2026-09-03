-- =============================================================
-- SETURA HOSPITAL OS
-- Script 31: Doctor Leave Management (v2 - Enterprise Refactor)
-- Run AFTER Script 30
-- =============================================================
-- NOTE: doctor_leaves and doctor_availability_overrides already
-- exist from migration 03. This script:
--   1. ALTERS both tables to add missing operational columns
--   2. Adds leave_type and leave_status enums
--   3. Creates doctor_hospital_holidays (new table, per-doctor)
--   4. ENHANCES the EXISTING is_doctor_available() in place
--   5. Adds get_doctor_availability_reason() for detailed UI checks
--   6. Adds get_doctor_unavailable_dates() range query function
--
-- v2 CRITICAL FIX (Enterprise Refactor):
--   v1 of this script defined:
--     is_doctor_available(p_hospital_id, p_doctor_id, p_check_date)
--       RETURNING TABLE(is_available BOOLEAN, reason TEXT)
--   But migration 03 ALREADY defines:
--     is_doctor_available(p_doctor_id, p_hospital_id, p_date)
--       RETURNING BOOLEAN
--   Both have the identical parameter type signature (UUID, UUID,
--   DATE), so PostgreSQL treats v1's statement as a REPLACE of the
--   migration 03 function - but CREATE OR REPLACE FUNCTION cannot
--   change a function's return type. Deploying v1 would have thrown:
--     ERROR: cannot change return type of existing function
--   Even if it had matched return types, the parameter ORDER was
--   swapped (hospital_id/doctor_id vs doctor_id/hospital_id), which
--   would have silently corrupted every positional call already in
--   Edge Functions.
--
--   FIX: migration 03's is_doctor_available(doctor_id, hospital_id,
--   date) RETURNS BOOLEAN is preserved with its EXACT signature and
--   return type, and is enhanced in place to add the
--   doctor_hospital_holidays check. A NEW, distinctly-named function
--   get_doctor_availability_reason(doctor_id, hospital_id, date) is
--   added for callers who need the human-readable reason - matching
--   the same (doctor_id, hospital_id, date) parameter order as the
--   original for consistency.
-- =============================================================

BEGIN;

-- ============================================================
-- ENUMS (idempotent)
-- ============================================================

DO $$ BEGIN
    CREATE TYPE public.doctor_leave_type AS ENUM (
        'annual_leave', 'sick_leave', 'conference',
        'emergency', 'personal', 'other'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE public.doctor_leave_status AS ENUM (
        'pending', 'approved', 'rejected', 'cancelled'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- PART A: Enhance doctor_leaves
-- Migration 03 created: id, doctor_id, hospital_id,
--   leave_start_date, leave_end_date, reason, approved_by,
--   is_deleted, created_at
-- ============================================================

ALTER TABLE public.doctor_leaves
    ADD COLUMN IF NOT EXISTS leave_type
        public.doctor_leave_type NOT NULL DEFAULT 'personal',

    ADD COLUMN IF NOT EXISTS leave_status
        public.doctor_leave_status NOT NULL DEFAULT 'pending',

    ADD COLUMN IF NOT EXISTS approved_at
        TIMESTAMPTZ,

    ADD COLUMN IF NOT EXISTS rejection_reason
        TEXT,

    ADD COLUMN IF NOT EXISTS notes
        TEXT,

    ADD COLUMN IF NOT EXISTS auto_cancel_bookings
        BOOLEAN NOT NULL DEFAULT false,

    ADD COLUMN IF NOT EXISTS metadata
        JSONB NOT NULL DEFAULT '{}'
            CHECK (jsonb_typeof(metadata) = 'object'),

    ADD COLUMN IF NOT EXISTS updated_at
        TIMESTAMPTZ NOT NULL DEFAULT now();

-- Indexes on new columns
CREATE INDEX IF NOT EXISTS idx_doctor_leaves_status_date
    ON public.doctor_leaves (hospital_id, leave_status, leave_start_date)
    WHERE leave_status IN ('pending', 'approved');

CREATE INDEX IF NOT EXISTS idx_doctor_leaves_doctor_date
    ON public.doctor_leaves (hospital_id, doctor_id, leave_start_date);

DROP TRIGGER IF EXISTS trg_doctor_leaves_updated_at ON public.doctor_leaves;
CREATE TRIGGER trg_doctor_leaves_updated_at
    BEFORE UPDATE ON public.doctor_leaves
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Backfill leave_status from approved_by (legacy rows)
UPDATE public.doctor_leaves
SET
    leave_status =
        CASE
            WHEN approved_by IS NOT NULL
            THEN 'approved'::public.doctor_leave_status
            ELSE 'pending'::public.doctor_leave_status
        END,
    approved_at =
        CASE
            WHEN approved_by IS NOT NULL
            THEN created_at
            ELSE NULL
        END
WHERE approved_by IS NOT NULL
  AND approved_at IS NULL;

-- ============================================================
-- PART B: Enhance doctor_availability_overrides
-- Migration 03 created: id, doctor_id, hospital_id,
--   override_date, override_type (enum), start_time, end_time,
--   notes, created_by, is_deleted, created_at
-- override_type enum: 'available','unavailable',
--                     'emergency_leave','extended_hours'
-- ============================================================

ALTER TABLE public.doctor_availability_overrides
    ADD COLUMN IF NOT EXISTS max_tokens
        INTEGER CHECK (max_tokens IS NULL OR max_tokens > 0),

    ADD COLUMN IF NOT EXISTS metadata
        JSONB NOT NULL DEFAULT '{}'
            CHECK (jsonb_typeof(metadata) = 'object'),

    ADD COLUMN IF NOT EXISTS updated_at
        TIMESTAMPTZ NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS trg_doctor_avail_overrides_updated_at
    ON public.doctor_availability_overrides;
CREATE TRIGGER trg_doctor_avail_overrides_updated_at
    BEFORE UPDATE ON public.doctor_availability_overrides
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- PART C: doctor_hospital_holidays (NEW TABLE)
-- Distinct from hospital_holidays (all-hospital, in migration 01)
-- This is for doctor-specific or department-specific holidays
-- ============================================================

CREATE TABLE IF NOT EXISTS public.doctor_hospital_holidays (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id) ON DELETE CASCADE,

    doctor_id   UUID
        REFERENCES public.profiles(id) ON DELETE CASCADE,

    holiday_date DATE NOT NULL,
    description  TEXT,

    -- If true, applies to ALL doctors at this hospital
    applies_to_all_doctors BOOLEAN NOT NULL DEFAULT false,

    created_by  UUID
        REFERENCES public.profiles(id) ON DELETE SET NULL,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT unique_doctor_holiday
        UNIQUE (hospital_id, doctor_id, holiday_date)
);

CREATE INDEX IF NOT EXISTS idx_doctor_hospital_holidays
    ON public.doctor_hospital_holidays (hospital_id, holiday_date);

CREATE UNIQUE INDEX IF NOT EXISTS
    idx_unique_global_doctor_holiday
ON public.doctor_hospital_holidays (
    hospital_id,
    holiday_date
)
WHERE applies_to_all_doctors = true;
-- ============================================================
-- ENHANCE is_doctor_available() IN PLACE
-- EXACT signature/return type preserved from migration 03:
--   is_doctor_available(p_doctor_id UUID, p_hospital_id UUID, p_date DATE)
--   RETURNS BOOLEAN
-- Adds: doctor_hospital_holidays check.
-- Behavior for all previously-covered cases (leaves, overrides,
-- hospital_holidays, weekly schedule) is UNCHANGED.
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_doctor_available(
    p_doctor_id   UUID,
    p_hospital_id UUID,
    p_date        DATE
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

    IF EXISTS (
        SELECT 1
        FROM public.doctor_leaves
        WHERE doctor_id = p_doctor_id
          AND hospital_id = p_hospital_id
          AND p_date BETWEEN leave_start_date AND leave_end_date
          AND leave_status = 'approved'
          AND is_deleted = false
    ) THEN
        RETURN FALSE;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.doctor_availability_overrides
        WHERE doctor_id = p_doctor_id
          AND hospital_id = p_hospital_id
          AND override_date = p_date
          AND override_type IN ('unavailable', 'emergency_leave')
          AND is_deleted = false
    ) THEN
        RETURN FALSE;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.hospital_holidays
        WHERE hospital_id = p_hospital_id
          AND holiday_date = p_date
    ) THEN
        RETURN FALSE;
    END IF;

    -- NEW in v2: doctor-specific or department-wide holiday
    IF EXISTS (
        SELECT 1
        FROM public.doctor_hospital_holidays
        WHERE hospital_id  = p_hospital_id
          AND holiday_date = p_date
          AND (applies_to_all_doctors = true OR doctor_id = p_doctor_id)
    ) THEN
        RETURN FALSE;
    END IF;

    RETURN EXISTS (
        SELECT 1
        FROM public.doctor_schedules
        WHERE doctor_id = p_doctor_id
          AND hospital_id = p_hospital_id
          AND weekday = EXTRACT(DOW FROM p_date)::INTEGER
          AND is_active = true
          AND is_deleted = false
    );

END;
$$;

REVOKE ALL     ON FUNCTION public.is_doctor_available(UUID, UUID, DATE) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.is_doctor_available(UUID, UUID, DATE) TO authenticated;

COMMENT ON FUNCTION public.is_doctor_available(UUID, UUID, DATE) IS
'Quick boolean availability check. Original signature from migration 03
preserved exactly: (p_doctor_id, p_hospital_id, p_date). Enhanced in
Script 31 to also check doctor_hospital_holidays. Use
get_doctor_availability_reason() for a human-readable explanation.';

-- ============================================================
-- get_doctor_availability_reason(doctor_id, hospital_id, date)
-- NEW function, distinct name, same parameter order as the
-- original is_doctor_available() for consistency. Returns the
-- same boolean PLUS a human-readable reason for booking/admin UIs.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_doctor_availability_reason(
    p_doctor_id   UUID,
    p_hospital_id UUID,
    p_date        DATE
)
RETURNS TABLE (is_available BOOLEAN, reason TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.doctor_leaves
         WHERE doctor_id     = p_doctor_id
           AND hospital_id   = p_hospital_id
           AND leave_status  = 'approved'
           AND p_date BETWEEN leave_start_date AND leave_end_date
           AND is_deleted    = false
    ) THEN
        RETURN QUERY SELECT false, 'Doctor on approved leave';
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.doctor_availability_overrides
         WHERE doctor_id     = p_doctor_id
           AND hospital_id   = p_hospital_id
           AND override_date = p_date
           AND override_type IN ('unavailable', 'emergency_leave')
           AND is_deleted    = false
    ) THEN
        RETURN QUERY SELECT false, 'Doctor has a blocked date override';
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.hospital_holidays
         WHERE hospital_id  = p_hospital_id
           AND holiday_date = p_date
    ) THEN
        RETURN QUERY SELECT false, 'Hospital holiday';
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.doctor_hospital_holidays
         WHERE hospital_id  = p_hospital_id
           AND holiday_date = p_date
           AND (applies_to_all_doctors = true OR doctor_id = p_doctor_id)
    ) THEN
        RETURN QUERY SELECT false, 'Doctor holiday';
        RETURN;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.doctor_schedules
         WHERE doctor_id   = p_doctor_id
           AND hospital_id = p_hospital_id
           AND weekday     = EXTRACT(DOW FROM p_date)::INTEGER
           AND is_active   = true
           AND is_deleted  = false
    ) THEN
        RETURN QUERY SELECT false, 'No schedule on this weekday';
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.doctor_availability_overrides
         WHERE doctor_id     = p_doctor_id
           AND hospital_id   = p_hospital_id
           AND override_date = p_date
           AND override_type IN ('available', 'extended_hours')
           AND is_deleted    = false
    ) THEN
        RETURN QUERY SELECT true, 'Available (schedule override)';
        RETURN;
    END IF;

    RETURN QUERY SELECT true, 'Available per regular schedule';
END;
$$;

REVOKE ALL     ON FUNCTION public.get_doctor_availability_reason(UUID, UUID, DATE) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_doctor_availability_reason(UUID, UUID, DATE) TO authenticated;

-- ============================================================
-- get_doctor_unavailable_dates(doctor, hospital, from, to)
-- Efficient date-range unavailability query for calendar UI.
-- Parameter order matches is_doctor_available (doctor, hospital).
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_doctor_unavailable_dates(
    p_doctor_id   UUID,
    p_hospital_id UUID,
    p_from_date   DATE,
    p_to_date     DATE
)
RETURNS TABLE (
    unavailable_date DATE,
    reason TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

    IF p_from_date > p_to_date THEN
        RAISE EXCEPTION
            'from_date must be <= to_date';
    END IF;

    IF (p_to_date - p_from_date) > 365 THEN
        RAISE EXCEPTION
            'date range cannot exceed 365 days';
    END IF;

    RETURN QUERY

    -- Approved leaves
    SELECT d::DATE,
           'Leave: ' || dl.leave_type::TEXT
    FROM public.doctor_leaves dl
    CROSS JOIN LATERAL
         generate_series(
             dl.leave_start_date,
             dl.leave_end_date,
             '1 day'
         ) d
    WHERE dl.hospital_id = p_hospital_id
      AND dl.doctor_id = p_doctor_id
      AND dl.leave_status = 'approved'
      AND dl.is_deleted = false
      AND d::DATE BETWEEN p_from_date AND p_to_date

    UNION

    -- Explicit unavailable overrides
    SELECT dao.override_date,
           'Override: ' ||
           COALESCE(
               dao.notes,
               dao.override_type::TEXT
           )
    FROM public.doctor_availability_overrides dao
    WHERE dao.hospital_id = p_hospital_id
      AND dao.doctor_id = p_doctor_id
      AND dao.override_type IN (
            'unavailable',
            'emergency_leave'
      )
      AND dao.is_deleted = false
      AND dao.override_date BETWEEN p_from_date AND p_to_date

    UNION

    -- Hospital-wide holidays
    SELECT hh.holiday_date,
           'Hospital holiday: ' ||
           COALESCE(hh.description, '')
    FROM public.hospital_holidays hh
    WHERE hh.hospital_id = p_hospital_id
      AND hh.holiday_date BETWEEN p_from_date AND p_to_date

    UNION

    -- Doctor-specific hospital holidays
    SELECT dhh.holiday_date,
           'Holiday: ' ||
           COALESCE(dhh.description, '')
    FROM public.doctor_hospital_holidays dhh
    WHERE dhh.hospital_id = p_hospital_id
      AND dhh.holiday_date BETWEEN p_from_date AND p_to_date
      AND (
            dhh.applies_to_all_doctors = true
            OR dhh.doctor_id = p_doctor_id
      )

    ORDER BY 1;

END;
$$;

REVOKE ALL     ON FUNCTION public.get_doctor_unavailable_dates(UUID,UUID,DATE,DATE) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_doctor_unavailable_dates(UUID,UUID,DATE,DATE) TO authenticated;

-- ============================================================
-- RLS (doctor_leaves & doctor_availability_overrides already
-- have policies from migration 03; only the new table needs them)
-- ============================================================

ALTER TABLE public.doctor_hospital_holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doctor_hospital_holidays FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dhh_read   ON public.doctor_hospital_holidays;
CREATE POLICY        dhh_read
    ON public.doctor_hospital_holidays FOR SELECT
    USING (
        public.is_global_admin()
        OR public.user_has_hospital_access(hospital_id)
    );

DROP POLICY IF EXISTS dhh_manage ON public.doctor_hospital_holidays;
CREATE POLICY        dhh_manage
    ON public.doctor_hospital_holidays FOR ALL
    USING      (public.is_global_admin() OR public.current_user_role(hospital_id) = 'hospital_admin')
    WITH CHECK (public.is_global_admin() OR public.current_user_role(hospital_id) = 'hospital_admin');

COMMIT;
