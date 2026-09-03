-- =============================================================
-- SETURA HOSPITAL OS
-- Script 03: Doctor Scheduling & Slot Engine
-- PRODUCTION SAFE VERSION
-- Run AFTER Script 02
-- =============================================================

-- =============================================================
-- EXTENSION REQUIRED FOR EXCLUSION CONSTRAINTS
-- =============================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- =============================================================
-- DOCTOR SPECIALIZATIONS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.doctor_specializations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    doctor_id UUID NOT NULL
        REFERENCES public.profiles(id)
        ON DELETE CASCADE,

    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    specialization_name TEXT NOT NULL,

    consultation_fee NUMERIC(10,2)
        NOT NULL DEFAULT 0
        CHECK (consultation_fee >= 0),

    average_consultation_minutes INTEGER
        NOT NULL DEFAULT 10
        CHECK (average_consultation_minutes BETWEEN 1 AND 240),

    is_deleted BOOLEAN NOT NULL DEFAULT false,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT unique_doctor_specialization
        UNIQUE (
            doctor_id,
            hospital_id,
            specialization_name
        )
);

CREATE INDEX IF NOT EXISTS idx_doctor_specializations_lookup
ON public.doctor_specializations(
    hospital_id,
    doctor_id
)
WHERE is_deleted = false;

DROP TRIGGER IF EXISTS trg_doctor_spec_updated_at
ON public.doctor_specializations;

CREATE TRIGGER trg_doctor_spec_updated_at
BEFORE UPDATE ON public.doctor_specializations
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_doctor_spec_hospital_immutable
ON public.doctor_specializations;

CREATE TRIGGER trg_doctor_spec_hospital_immutable
BEFORE UPDATE ON public.doctor_specializations
FOR EACH ROW
EXECUTE FUNCTION public.prevent_hospital_id_update();

-- =============================================================
-- DOCTOR SCHEDULES
-- =============================================================

CREATE TABLE IF NOT EXISTS public.doctor_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    doctor_id UUID NOT NULL
        REFERENCES public.profiles(id)
        ON DELETE CASCADE,

    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    weekday INTEGER NOT NULL
        CHECK (weekday BETWEEN 0 AND 6),

    start_time TIME NOT NULL,
    end_time TIME NOT NULL,

    max_tokens INTEGER NOT NULL DEFAULT 50
        CHECK (max_tokens > 0),

    average_consultation_minutes INTEGER
        NOT NULL DEFAULT 10
        CHECK (
            average_consultation_minutes BETWEEN 1 AND 240
        ),

    buffer_minutes INTEGER NOT NULL DEFAULT 2
        CHECK (buffer_minutes BETWEEN 0 AND 120),

    is_active BOOLEAN NOT NULL DEFAULT true,

    is_walkin_allowed BOOLEAN
        NOT NULL DEFAULT true,

    created_by UUID
        REFERENCES public.profiles(id),

    is_deleted BOOLEAN NOT NULL DEFAULT false,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_schedule_time
        CHECK (end_time > start_time)
);

-- Prevent overlapping schedules
ALTER TABLE public.doctor_schedules
DROP CONSTRAINT IF EXISTS no_overlapping_doctor_schedules;

ALTER TABLE public.doctor_schedules
ADD CONSTRAINT no_overlapping_doctor_schedules
EXCLUDE USING gist (
    doctor_id WITH =,
    hospital_id WITH =,
    weekday WITH =,
    int4range(
        (
            EXTRACT(HOUR FROM start_time)::INTEGER * 60
            +
            EXTRACT(MINUTE FROM start_time)::INTEGER
        ),
        (
            EXTRACT(HOUR FROM end_time)::INTEGER * 60
            +
            EXTRACT(MINUTE FROM end_time)::INTEGER
        ),
        '[)'
    ) WITH &&
)
WHERE (is_deleted = false);

CREATE INDEX IF NOT EXISTS idx_doctor_schedules_doctor
ON public.doctor_schedules(
    doctor_id,
    weekday
)
WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS idx_doctor_schedules_hospital
ON public.doctor_schedules(
    hospital_id,
    weekday
)
WHERE is_deleted = false;

DROP TRIGGER IF EXISTS trg_doctor_schedules_updated_at
ON public.doctor_schedules;

CREATE TRIGGER trg_doctor_schedules_updated_at
BEFORE UPDATE ON public.doctor_schedules
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_doctor_schedules_hospital_immutable
ON public.doctor_schedules;

CREATE TRIGGER trg_doctor_schedules_hospital_immutable
BEFORE UPDATE ON public.doctor_schedules
FOR EACH ROW
EXECUTE FUNCTION public.prevent_hospital_id_update();

-- =============================================================
-- DOCTOR SCHEDULE BLOCKS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.doctor_schedule_blocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    schedule_id UUID NOT NULL
        REFERENCES public.doctor_schedules(id)
        ON DELETE CASCADE,

    block_name TEXT,

    block_start_time TIME NOT NULL,
    block_end_time TIME NOT NULL,

    is_recurring BOOLEAN NOT NULL DEFAULT true,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_block_time
        CHECK (
            block_end_time > block_start_time
        )
);

-- Prevent overlapping blocks
ALTER TABLE public.doctor_schedule_blocks
DROP CONSTRAINT IF EXISTS no_overlapping_schedule_blocks;

ALTER TABLE public.doctor_schedule_blocks
ADD CONSTRAINT no_overlapping_schedule_blocks
EXCLUDE USING gist (
    schedule_id WITH =,
    int4range(
        (
            EXTRACT(HOUR FROM block_start_time)::INTEGER * 60
            +
            EXTRACT(MINUTE FROM block_start_time)::INTEGER
        ),
        (
            EXTRACT(HOUR FROM block_end_time)::INTEGER * 60
            +
            EXTRACT(MINUTE FROM block_end_time)::INTEGER
        ),
        '[)'
    ) WITH &&
);

CREATE INDEX IF NOT EXISTS idx_schedule_blocks_schedule
ON public.doctor_schedule_blocks(schedule_id);

-- =============================================================
-- DOCTOR LEAVES
-- =============================================================

CREATE TABLE IF NOT EXISTS public.doctor_leaves (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    doctor_id UUID NOT NULL
        REFERENCES public.profiles(id)
        ON DELETE CASCADE,

    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    leave_start_date DATE NOT NULL,
    leave_end_date DATE NOT NULL,

    reason TEXT,

    approved_by UUID
        REFERENCES public.profiles(id),

    is_deleted BOOLEAN NOT NULL DEFAULT false,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_leave_dates
        CHECK (
            leave_end_date >= leave_start_date
        )
);

ALTER TABLE public.doctor_leaves
DROP CONSTRAINT IF EXISTS no_overlapping_doctor_leaves;

ALTER TABLE public.doctor_leaves
ADD CONSTRAINT no_overlapping_doctor_leaves
EXCLUDE USING gist (
    doctor_id WITH =,
    daterange(
        leave_start_date,
        leave_end_date,
        '[]'
    ) WITH &&
)
WHERE (is_deleted = false);

CREATE INDEX IF NOT EXISTS idx_doctor_leaves_lookup
ON public.doctor_leaves(
    doctor_id,
    hospital_id,
    leave_start_date
)
WHERE is_deleted = false;

DROP TRIGGER IF EXISTS trg_doctor_leaves_hospital_immutable
ON public.doctor_leaves;

CREATE TRIGGER trg_doctor_leaves_hospital_immutable
BEFORE UPDATE ON public.doctor_leaves
FOR EACH ROW
EXECUTE FUNCTION public.prevent_hospital_id_update();

-- =============================================================
-- OVERRIDE ENUM
-- =============================================================

DO $$
BEGIN
    CREATE TYPE public.override_type AS ENUM (
        'available',
        'unavailable',
        'emergency_leave',
        'extended_hours'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================
-- AVAILABILITY OVERRIDES
-- =============================================================

CREATE TABLE IF NOT EXISTS public.doctor_availability_overrides (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    doctor_id UUID NOT NULL
        REFERENCES public.profiles(id)
        ON DELETE CASCADE,

    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    override_date DATE NOT NULL,

    override_type public.override_type NOT NULL,

    start_time TIME,
    end_time TIME,

    notes TEXT,

    created_by UUID
        REFERENCES public.profiles(id),

    is_deleted BOOLEAN NOT NULL DEFAULT false,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_override_times
        CHECK (
            (
                start_time IS NULL
                AND end_time IS NULL
            )
            OR (
                start_time IS NOT NULL
                AND end_time IS NOT NULL
                AND end_time > start_time
            )
        )
);

CREATE INDEX IF NOT EXISTS idx_doctor_overrides_lookup
ON public.doctor_availability_overrides(
    doctor_id,
    override_date
)
WHERE is_deleted = false;

DROP TRIGGER IF EXISTS trg_doctor_override_hospital_immutable
ON public.doctor_availability_overrides;

CREATE TRIGGER trg_doctor_override_hospital_immutable
BEFORE UPDATE ON public.doctor_availability_overrides
FOR EACH ROW
EXECUTE FUNCTION public.prevent_hospital_id_update();

-- =============================================================
-- IS DOCTOR AVAILABLE
-- =============================================================

CREATE OR REPLACE FUNCTION public.is_doctor_available(
    p_doctor_id UUID,
    p_hospital_id UUID,
    p_date DATE
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
          AND p_date BETWEEN leave_start_date
                          AND leave_end_date
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
          AND override_type IN (
                'unavailable',
                'emergency_leave'
          )
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

    RETURN EXISTS (
        SELECT 1
        FROM public.doctor_schedules
        WHERE doctor_id = p_doctor_id
          AND hospital_id = p_hospital_id
          AND weekday =
                EXTRACT(DOW FROM p_date)::INTEGER
          AND is_active = true
          AND is_deleted = false
    );

END;
$$;

ALTER FUNCTION public.is_doctor_available(UUID,UUID,DATE)
SET row_security = off;

-- =============================================================
-- REMAINING TOKEN CAPACITY
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_remaining_token_capacity(
    p_doctor_id UUID,
    p_hospital_id UUID,
    p_date DATE
)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_max_tokens INTEGER;
    v_booked INTEGER;
BEGIN

    SELECT max_tokens
    INTO v_max_tokens
    FROM public.doctor_schedules
    WHERE doctor_id = p_doctor_id
      AND hospital_id = p_hospital_id
      AND weekday =
            EXTRACT(DOW FROM p_date)::INTEGER
      AND is_active = true
      AND is_deleted = false
    ORDER BY start_time
    LIMIT 1;

    IF v_max_tokens IS NULL THEN
        RETURN 0;
    END IF;

    SELECT COUNT(*)
    INTO v_booked
    FROM public.bookings
    WHERE assigned_doctor_id = p_doctor_id
      AND hospital_id = p_hospital_id
      AND appointment_date = p_date
      AND status NOT IN (
            'cancelled',
            'no_show'
      )
      AND is_deleted = false;

    RETURN GREATEST(
        v_max_tokens - v_booked,
        0
    );

END;
$$;

ALTER FUNCTION public.get_remaining_token_capacity(UUID,UUID,DATE)
SET row_security = off;

-- =============================================================
-- WAIT ESTIMATION
-- =============================================================

CREATE OR REPLACE FUNCTION public.estimate_wait_minutes(
    p_queue_session_id UUID,
    p_token_number INTEGER
)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_avg_minutes NUMERIC;
    v_ahead INTEGER;
BEGIN

    SELECT COALESCE(
        ds.average_consultation_minutes,
        10
    )
    INTO v_avg_minutes
    FROM public.queue_sessions qs
    JOIN public.doctor_schedules ds
        ON ds.doctor_id = qs.doctor_id
       AND ds.hospital_id = qs.hospital_id
       AND ds.weekday =
            EXTRACT(DOW FROM qs.session_date)::INTEGER
       AND ds.is_deleted = false
    WHERE qs.id = p_queue_session_id
    LIMIT 1;

    SELECT COUNT(*)
    INTO v_ahead
    FROM public.bookings
    WHERE queue_session_id = p_queue_session_id
      AND token_number < p_token_number
      AND status IN (
            'booked',
            'checked_in',
            'waiting',
            'called',
            'in_consultation'
      )
      AND is_deleted = false;

    RETURN ROUND(
        v_ahead * COALESCE(v_avg_minutes, 10)
    )::INTEGER;

END;
$$;

ALTER FUNCTION public.estimate_wait_minutes(UUID,INTEGER)
SET row_security = off;

-- =============================================================
-- REALTIME
-- =============================================================

DO $$
BEGIN

    BEGIN
        ALTER PUBLICATION supabase_realtime
        ADD TABLE public.doctor_schedules;
    EXCEPTION
        WHEN duplicate_object THEN NULL;
    END;

    BEGIN
        ALTER PUBLICATION supabase_realtime
        ADD TABLE public.doctor_leaves;
    EXCEPTION
        WHEN duplicate_object THEN NULL;
    END;

END $$;

-- =============================================================
-- ENABLE RLS
-- =============================================================

ALTER TABLE public.doctor_specializations
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.doctor_schedules
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.doctor_schedule_blocks
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.doctor_leaves
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.doctor_availability_overrides
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.doctor_specializations
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.doctor_schedules
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.doctor_schedule_blocks
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.doctor_leaves
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.doctor_availability_overrides
FORCE ROW LEVEL SECURITY;

-- =============================================================
-- SPECIALIZATION POLICIES
-- =============================================================

DROP POLICY IF EXISTS doctor_spec_read
ON public.doctor_specializations;

CREATE POLICY doctor_spec_read
ON public.doctor_specializations
FOR SELECT
USING (
    public.is_global_admin()
    OR public.user_has_hospital_access(hospital_id)
);

-- =============================================================
-- SCHEDULE POLICIES
-- =============================================================

DROP POLICY IF EXISTS doctor_sched_read
ON public.doctor_schedules;

CREATE POLICY doctor_sched_read
ON public.doctor_schedules
FOR SELECT
USING (
    public.is_global_admin()
    OR public.user_has_hospital_access(hospital_id)
);

DROP POLICY IF EXISTS doctor_sched_manage
ON public.doctor_schedules;

CREATE POLICY doctor_sched_manage
ON public.doctor_schedules
FOR ALL
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        = 'hospital_admin'
    OR (
        doctor_id = auth.uid()
        AND public.current_user_role(hospital_id)
            = 'doctor'
    )
)
WITH CHECK (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        = 'hospital_admin'
    OR (
        doctor_id = auth.uid()
        AND public.current_user_role(hospital_id)
            = 'doctor'
    )
);

-- =============================================================
-- LEAVE POLICIES
-- =============================================================

DROP POLICY IF EXISTS doctor_leaves_read
ON public.doctor_leaves;

CREATE POLICY doctor_leaves_read
ON public.doctor_leaves
FOR SELECT
USING (
    public.is_global_admin()
    OR public.user_has_hospital_access(hospital_id)
);

DROP POLICY IF EXISTS doctor_leaves_manage
ON public.doctor_leaves;

CREATE POLICY doctor_leaves_manage
ON public.doctor_leaves
FOR ALL
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        = 'hospital_admin'
    OR doctor_id = auth.uid()
)
WITH CHECK (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        = 'hospital_admin'
    OR doctor_id = auth.uid()
);

-- =============================================================
-- OVERRIDE POLICIES
-- =============================================================

DROP POLICY IF EXISTS doctor_override_read
ON public.doctor_availability_overrides;

CREATE POLICY doctor_override_read
ON public.doctor_availability_overrides
FOR SELECT
USING (
    public.is_global_admin()
    OR public.user_has_hospital_access(hospital_id)
);

DROP POLICY IF EXISTS doctor_override_manage
ON public.doctor_availability_overrides;

CREATE POLICY doctor_override_manage
ON public.doctor_availability_overrides
FOR ALL
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        = 'hospital_admin'
)
WITH CHECK (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        = 'hospital_admin'
);

-- =============================================================
-- BLOCK POLICIES
-- =============================================================

DROP POLICY IF EXISTS doctor_blocks_read
ON public.doctor_schedule_blocks;

CREATE POLICY doctor_blocks_read
ON public.doctor_schedule_blocks
FOR SELECT
USING (
    EXISTS (
        SELECT 1
        FROM public.doctor_schedules ds
        WHERE ds.id = doctor_schedule_blocks.schedule_id
          AND (
                public.is_global_admin()
                OR public.user_has_hospital_access(
                    ds.hospital_id
                )
          )
    )
);

DROP POLICY IF EXISTS doctor_blocks_manage
ON public.doctor_schedule_blocks;

CREATE POLICY doctor_blocks_manage
ON public.doctor_schedule_blocks
FOR ALL
USING (
    EXISTS (
        SELECT 1
        FROM public.doctor_schedules ds
        WHERE ds.id = doctor_schedule_blocks.schedule_id
          AND (
                public.is_global_admin()
                OR public.current_user_role(
                    ds.hospital_id
                ) = 'hospital_admin'
          )
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1
        FROM public.doctor_schedules ds
        WHERE ds.id = doctor_schedule_blocks.schedule_id
          AND (
                public.is_global_admin()
                OR public.current_user_role(
                    ds.hospital_id
                ) = 'hospital_admin'
          )
    )
);