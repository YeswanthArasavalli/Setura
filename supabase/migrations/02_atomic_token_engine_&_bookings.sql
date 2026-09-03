-- =============================================================
-- SETURA HOSPITAL OS
-- Script 02: Atomic Token Engine & Bookings
-- PRODUCTION SAFE VERSION
-- Run AFTER Script 01
-- =============================================================

-- =============================================================
-- DAILY TOKEN COUNTERS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.hospital_daily_counters (
    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    visit_date DATE NOT NULL,

    last_token INTEGER NOT NULL DEFAULT 0
        CHECK (last_token >= 0),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (hospital_id, visit_date)
);

-- =============================================================
-- ATOMIC TOKEN GENERATOR
-- =============================================================

CREATE OR REPLACE FUNCTION public.generate_next_token(
    p_hospital_id UUID,
    p_visit_date DATE
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_next INTEGER;
BEGIN

    INSERT INTO public.hospital_daily_counters (
        hospital_id,
        visit_date,
        last_token
    )
    VALUES (
        p_hospital_id,
        p_visit_date,
        1
    )
    ON CONFLICT (hospital_id, visit_date)
    DO UPDATE
    SET last_token =
        public.hospital_daily_counters.last_token + 1
    RETURNING last_token
    INTO v_next;

    RETURN v_next;

END;
$$;

ALTER FUNCTION public.generate_next_token(UUID, DATE)
SET row_security = off;

REVOKE ALL
ON FUNCTION public.generate_next_token(UUID, DATE)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.generate_next_token(UUID, DATE)
TO authenticated;

-- =============================================================
-- QUEUE SESSIONS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.queue_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    doctor_id UUID
        REFERENCES public.profiles(id)
        ON DELETE SET NULL,

    session_date DATE NOT NULL,

    session_name TEXT,

    max_tokens INTEGER NOT NULL DEFAULT 100
        CHECK (max_tokens > 0),

    current_live_token INTEGER NOT NULL DEFAULT 0
        CHECK (current_live_token >= 0),

    is_active BOOLEAN NOT NULL DEFAULT true,

    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT unique_session
        UNIQUE (
            hospital_id,
            doctor_id,
            session_date
        )
);

CREATE INDEX IF NOT EXISTS idx_queue_sessions_hospital_date
ON public.queue_sessions(
    hospital_id,
    session_date
);

CREATE INDEX IF NOT EXISTS idx_queue_sessions_doctor
ON public.queue_sessions(
    doctor_id,
    session_date
);

DROP TRIGGER IF EXISTS trg_queue_sessions_updated_at
ON public.queue_sessions;

CREATE TRIGGER trg_queue_sessions_updated_at
BEFORE UPDATE ON public.queue_sessions
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_queue_sessions_hospital_immutable
ON public.queue_sessions;

CREATE TRIGGER trg_queue_sessions_hospital_immutable
BEFORE UPDATE ON public.queue_sessions
FOR EACH ROW
EXECUTE FUNCTION public.prevent_hospital_id_update();

-- =============================================================
-- BOOKINGS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    queue_session_id UUID
        REFERENCES public.queue_sessions(id)
        ON DELETE SET NULL,

    patient_id UUID
        REFERENCES public.patients(id)
        ON DELETE SET NULL,

    patient_name TEXT NOT NULL,

    patient_phone TEXT NOT NULL,

    patient_age INTEGER
        CHECK (
            patient_age IS NULL
            OR patient_age BETWEEN 0 AND 150
        ),

    patient_gender TEXT,

    village TEXT,

    blood_group TEXT,

    has_diabetes BOOLEAN NOT NULL DEFAULT false,
    has_bp BOOLEAN NOT NULL DEFAULT false,

    token_number INTEGER NOT NULL
        CHECK (token_number > 0),

    priority_score INTEGER NOT NULL DEFAULT 0,

    priority_flag BOOLEAN NOT NULL DEFAULT false,

    status public.booking_status
        NOT NULL DEFAULT 'booked',

    booking_source public.booking_source
        NOT NULL,

    assigned_doctor_id UUID
        REFERENCES public.profiles(id)
        ON DELETE SET NULL,

    booked_by UUID
        REFERENCES public.profiles(id)
        ON DELETE SET NULL,

    appointment_date DATE NOT NULL,

    checked_in_at TIMESTAMPTZ,
    called_at TIMESTAMPTZ,
    consultation_started_at TIMESTAMPTZ,
    consultation_completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    no_show_marked_at TIMESTAMPTZ,

    carry_forwarded_from UUID
        REFERENCES public.bookings(id)
        ON DELETE SET NULL,

    is_carry_forward BOOLEAN NOT NULL DEFAULT false,

    cancellation_reason TEXT,

    platform_fee_snapshot NUMERIC(10,2)
        NOT NULL DEFAULT 0
        CHECK (platform_fee_snapshot >= 0),

    receptionist_fee_snapshot NUMERIC(10,2)
        NOT NULL DEFAULT 0
        CHECK (receptionist_fee_snapshot >= 0),

    hospital_fee_snapshot NUMERIC(10,2)
        NOT NULL DEFAULT 0
        CHECK (hospital_fee_snapshot >= 0),

    total_amount_snapshot NUMERIC(10,2)
        NOT NULL DEFAULT 0
        CHECK (total_amount_snapshot >= 0),

    payment_completed BOOLEAN NOT NULL DEFAULT false,

    payment_reference TEXT,

    whatsapp_confirmation_sent BOOLEAN
        NOT NULL DEFAULT false,

    whatsapp_reminder_sent BOOLEAN
        NOT NULL DEFAULT false,

    feedback_sent BOOLEAN
        NOT NULL DEFAULT false,

    estimated_wait_minutes INTEGER
        CHECK (
            estimated_wait_minutes IS NULL
            OR estimated_wait_minutes >= 0
        ),

    idempotency_key TEXT UNIQUE,

    booking_reference TEXT NOT NULL UNIQUE
        DEFAULT upper(
            encode(
                gen_random_bytes(8),
                'hex'
            )
        ),

    metadata JSONB NOT NULL DEFAULT '{}'
        CHECK (
            jsonb_typeof(metadata) = 'object'
        ),

    is_deleted BOOLEAN NOT NULL DEFAULT false,

    deleted_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT unique_session_token
        UNIQUE (
            queue_session_id,
            token_number
        )
);

CREATE INDEX IF NOT EXISTS idx_bookings_hospital_date
ON public.bookings(
    hospital_id,
    appointment_date
);

CREATE INDEX IF NOT EXISTS idx_bookings_status
ON public.bookings(status)
WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS idx_bookings_doctor
ON public.bookings(
    assigned_doctor_id,
    appointment_date
);

CREATE INDEX IF NOT EXISTS idx_bookings_priority
ON public.bookings(
    priority_flag,
    priority_score DESC,
    token_number ASC
)
WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS idx_bookings_patient
ON public.bookings(patient_id);

CREATE INDEX IF NOT EXISTS idx_bookings_queue_lookup
ON public.bookings(
    queue_session_id,
    status,
    priority_score DESC,
    token_number ASC
)
WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS idx_bookings_idempotency
ON public.bookings(idempotency_key);

DROP TRIGGER IF EXISTS trg_bookings_updated_at
ON public.bookings;

CREATE TRIGGER trg_bookings_updated_at
BEFORE UPDATE ON public.bookings
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_bookings_hospital_immutable
ON public.bookings;

CREATE TRIGGER trg_bookings_hospital_immutable
BEFORE UPDATE ON public.bookings
FOR EACH ROW
EXECUTE FUNCTION public.prevent_hospital_id_update();

-- =============================================================
-- BOOKING EVENTS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.booking_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    booking_id UUID NOT NULL
        REFERENCES public.bookings(id)
        ON DELETE CASCADE,

    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    old_status public.booking_status,
    new_status public.booking_status,

    event_type TEXT NOT NULL,

    performed_by UUID
        REFERENCES public.profiles(id)
        ON DELETE SET NULL,

    notes TEXT,

    metadata JSONB NOT NULL DEFAULT '{}'
        CHECK (
            jsonb_typeof(metadata) = 'object'
        ),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_booking_events_booking
ON public.booking_events(
    booking_id,
    created_at DESC
);

-- =============================================================
-- STATUS CHANGE HANDLER
-- =============================================================

CREATE OR REPLACE FUNCTION public.handle_booking_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN

    IF NEW.status = 'in_consultation'
    AND OLD.status IS DISTINCT FROM 'in_consultation' THEN
        NEW.consultation_started_at := now();
    END IF;

    IF NEW.status = 'completed'
    AND OLD.status IS DISTINCT FROM 'completed' THEN
        NEW.consultation_completed_at := now();
    END IF;

    IF NEW.status = 'cancelled'
    AND OLD.status IS DISTINCT FROM 'cancelled' THEN
        NEW.cancelled_at := now();
    END IF;

    IF NEW.status = 'no_show'
    AND OLD.status IS DISTINCT FROM 'no_show' THEN
        NEW.no_show_marked_at := now();
    END IF;

    INSERT INTO public.booking_events (
        booking_id,
        hospital_id,
        old_status,
        new_status,
        event_type
    )
    VALUES (
        NEW.id,
        NEW.hospital_id,
        OLD.status,
        NEW.status,
        'status_changed'
    );

    RETURN NEW;

END;
$$;

DROP TRIGGER IF EXISTS trg_booking_status_change
ON public.bookings;

CREATE TRIGGER trg_booking_status_change
BEFORE UPDATE ON public.bookings
FOR EACH ROW
WHEN (
    OLD.status IS DISTINCT FROM NEW.status
)
EXECUTE FUNCTION public.handle_booking_status_change();

-- =============================================================
-- CREATE BOOKING
-- =============================================================

CREATE OR REPLACE FUNCTION public.create_booking(
    p_hospital_id UUID,
    p_queue_session_id UUID,
    p_patient_id UUID,
    p_patient_name TEXT,
    p_patient_phone TEXT,
    p_patient_age INTEGER,
    p_patient_gender TEXT,
    p_village TEXT,
    p_blood_group TEXT,
    p_has_diabetes BOOLEAN,
    p_has_bp BOOLEAN,
    p_booking_source public.booking_source,
    p_doctor_id UUID,
    p_booked_by UUID,
    p_appointment_date DATE,
    p_platform_fee NUMERIC,
    p_receptionist_fee NUMERIC,
    p_hospital_fee NUMERIC,
    p_idempotency_key TEXT
)
RETURNS TABLE (
    booking_id UUID,
    token_number INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_booking_id UUID;
    v_token INTEGER;
    v_total NUMERIC;
BEGIN

    SELECT b.id, b.token_number
    INTO v_booking_id, v_token
    FROM public.bookings b
    WHERE b.idempotency_key = p_idempotency_key;

    IF FOUND THEN
        RETURN QUERY
        SELECT v_booking_id, v_token;
        RETURN;
    END IF;

    v_token :=
        public.generate_next_token(
            p_hospital_id,
            p_appointment_date
        );

    v_total :=
        COALESCE(p_platform_fee, 0)
        + COALESCE(p_receptionist_fee, 0)
        + COALESCE(p_hospital_fee, 0);

    INSERT INTO public.bookings (
        hospital_id,
        queue_session_id,
        patient_id,
        patient_name,
        patient_phone,
        patient_age,
        patient_gender,
        village,
        blood_group,
        has_diabetes,
        has_bp,
        token_number,
        booking_source,
        assigned_doctor_id,
        booked_by,
        appointment_date,
        platform_fee_snapshot,
        receptionist_fee_snapshot,
        hospital_fee_snapshot,
        total_amount_snapshot,
        idempotency_key
    )
    VALUES (
        p_hospital_id,
        p_queue_session_id,
        p_patient_id,
        p_patient_name,
        p_patient_phone,
        p_patient_age,
        p_patient_gender,
        p_village,
        p_blood_group,
        p_has_diabetes,
        p_has_bp,
        v_token,
        p_booking_source,
        p_doctor_id,
        p_booked_by,
        p_appointment_date,
        COALESCE(p_platform_fee, 0),
        COALESCE(p_receptionist_fee, 0),
        COALESCE(p_hospital_fee, 0),
        v_total,
        p_idempotency_key
    )
    RETURNING id
    INTO v_booking_id;

    UPDATE public.patients
    SET
        total_visits = total_visits + 1,
        last_visit_date = p_appointment_date
    WHERE id = p_patient_id;

    RETURN QUERY
    SELECT v_booking_id, v_token;

END;
$$;

ALTER FUNCTION public.create_booking(
UUID,UUID,UUID,TEXT,TEXT,INTEGER,TEXT,TEXT,TEXT,
BOOLEAN,BOOLEAN,public.booking_source,UUID,UUID,
DATE,NUMERIC,NUMERIC,NUMERIC,TEXT
)
SET row_security = off;

-- =============================================================
-- ADVANCE QUEUE
-- CONCURRENCY SAFE
-- =============================================================

CREATE OR REPLACE FUNCTION public.advance_queue(
    p_queue_session_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_booking_id UUID;
    v_token INTEGER;
BEGIN

    SELECT id, token_number
    INTO v_booking_id, v_token
    FROM public.bookings
    WHERE queue_session_id = p_queue_session_id
      AND status IN (
            'booked',
            'checked_in',
            'waiting'
      )
      AND is_deleted = false
    ORDER BY
        priority_score DESC,
        token_number ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF v_booking_id IS NULL THEN
        RETURN NULL;
    END IF;

    UPDATE public.bookings
    SET
        status = 'called',
        called_at = now()
    WHERE id = v_booking_id;

    UPDATE public.queue_sessions
    SET current_live_token = v_token
    WHERE id = p_queue_session_id;

    RETURN v_token;

END;
$$;

ALTER FUNCTION public.advance_queue(UUID)
SET row_security = off;

-- =============================================================
-- REALTIME
-- =============================================================

DO $$
BEGIN

    BEGIN
        ALTER PUBLICATION supabase_realtime
        ADD TABLE public.bookings;
    EXCEPTION
        WHEN duplicate_object THEN NULL;
    END;

    BEGIN
        ALTER PUBLICATION supabase_realtime
        ADD TABLE public.booking_events;
    EXCEPTION
        WHEN duplicate_object THEN NULL;
    END;

    BEGIN
        ALTER PUBLICATION supabase_realtime
        ADD TABLE public.queue_sessions;
    EXCEPTION
        WHEN duplicate_object THEN NULL;
    END;

END $$;

-- =============================================================
-- ENABLE RLS
-- =============================================================

ALTER TABLE public.hospital_daily_counters
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.queue_sessions
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.bookings
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.booking_events
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.hospital_daily_counters
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.queue_sessions
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.bookings
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.booking_events
FORCE ROW LEVEL SECURITY;

-- =============================================================
-- COUNTER POLICIES
-- =============================================================

DROP POLICY IF EXISTS daily_counters_internal
ON public.hospital_daily_counters;

CREATE POLICY daily_counters_internal
ON public.hospital_daily_counters
FOR ALL
USING (false)
WITH CHECK (false);

-- =============================================================
-- QUEUE SESSION POLICIES
-- =============================================================

DROP POLICY IF EXISTS queue_sessions_read
ON public.queue_sessions;

CREATE POLICY queue_sessions_read
ON public.queue_sessions
FOR SELECT
USING (
    public.is_global_admin()
    OR public.user_has_hospital_access(hospital_id)
);

DROP POLICY IF EXISTS queue_sessions_manage
ON public.queue_sessions;

CREATE POLICY queue_sessions_manage
ON public.queue_sessions
FOR ALL
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        IN ('hospital_admin', 'receptionist')
)
WITH CHECK (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        IN ('hospital_admin', 'receptionist')
);

-- =============================================================
-- BOOKING POLICIES
-- =============================================================

DROP POLICY IF EXISTS bookings_read_admin
ON public.bookings;

CREATE POLICY bookings_read_admin
ON public.bookings
FOR SELECT
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        IN (
            'hospital_admin',
            'receptionist'
        )
);

DROP POLICY IF EXISTS bookings_read_doctor
ON public.bookings;

CREATE POLICY bookings_read_doctor
ON public.bookings
FOR SELECT
USING (
    assigned_doctor_id = auth.uid()
    AND public.current_user_role(hospital_id)
        = 'doctor'
);

DROP POLICY IF EXISTS bookings_insert
ON public.bookings;

CREATE POLICY bookings_insert
ON public.bookings
FOR INSERT
WITH CHECK (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        IN (
            'hospital_admin',
            'receptionist'
        )
);

DROP POLICY IF EXISTS bookings_update
ON public.bookings;

CREATE POLICY bookings_update
ON public.bookings
FOR UPDATE
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        IN (
            'hospital_admin',
            'receptionist'
        )
    OR (
        assigned_doctor_id = auth.uid()
        AND public.current_user_role(hospital_id)
            = 'doctor'
    )
)
WITH CHECK (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        IN (
            'hospital_admin',
            'receptionist'
        )
    OR (
        assigned_doctor_id = auth.uid()
        AND public.current_user_role(hospital_id)
            = 'doctor'
    )
);

-- =============================================================
-- BOOKING EVENTS POLICIES
-- =============================================================

DROP POLICY IF EXISTS booking_events_read
ON public.booking_events;

CREATE POLICY booking_events_read
ON public.booking_events
FOR SELECT
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        IN (
            'hospital_admin',
            'receptionist',
            'doctor'
        )
);