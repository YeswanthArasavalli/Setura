--- =============================================================
-- SETURA HOSPITAL OS
-- Script 01: Foundation (PRODUCTION SAFE)
-- Run order: FIRST
-- =============================================================

-- =============================================================
-- EXTENSIONS
-- =============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

-- =============================================================
-- ENUMS
-- =============================================================

DO $$
BEGIN
    CREATE TYPE public.user_role_type AS ENUM (
        'global_admin',
        'hospital_admin',
        'doctor',
        'receptionist'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    CREATE TYPE public.booking_status AS ENUM (
        'booked',
        'checked_in',
        'waiting',
        'called',
        'in_consultation',
        'completed',
        'cancelled',
        'no_show',
        'rescheduled',
        'skipped'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    CREATE TYPE public.booking_source AS ENUM (
        'online',
        'manual_free',
        'manual_whatsapp',
        'walkin'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================
-- UPDATED_AT TRIGGER
-- =============================================================

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

-- =============================================================
-- IMMUTABLE HOSPITAL GUARD
-- =============================================================

CREATE OR REPLACE FUNCTION public.prevent_hospital_id_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN

    IF TG_OP = 'UPDATE'
    AND NEW.hospital_id IS DISTINCT FROM OLD.hospital_id THEN
        RAISE EXCEPTION 'hospital_id is immutable';
    END IF;

    RETURN NEW;

END;
$$;

-- =============================================================
-- HOSPITALS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.hospitals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    name TEXT NOT NULL,
    name_te TEXT,

    slug CITEXT NOT NULL UNIQUE,

    phone TEXT,
    email TEXT,

    country TEXT NOT NULL DEFAULT 'India',
    state TEXT NOT NULL DEFAULT 'Andhra Pradesh',
    district TEXT,
    town TEXT NOT NULL DEFAULT 'Narsapur',

    address TEXT,

    timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',

    is_active BOOLEAN NOT NULL DEFAULT true,
    subscription_active BOOLEAN NOT NULL DEFAULT true,

    online_booking_enabled BOOLEAN NOT NULL DEFAULT true,

    max_advance_booking_days INTEGER
        NOT NULL DEFAULT 7
        CHECK (
            max_advance_booking_days BETWEEN 1 AND 365
        ),

    deleted_at TIMESTAMPTZ,

    created_by UUID REFERENCES auth.users(id),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hospitals_active
ON public.hospitals(created_at DESC)
WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_hospitals_updated_at
ON public.hospitals;

CREATE TRIGGER trg_hospitals_updated_at
BEFORE UPDATE ON public.hospitals
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- =============================================================
-- PROFILES
-- =============================================================

CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY
        REFERENCES auth.users(id)
        ON DELETE CASCADE,

    full_name TEXT NOT NULL,

    normalized_phone TEXT,

    avatar_url TEXT,

    preferred_language TEXT
        NOT NULL DEFAULT 'en',

    is_active BOOLEAN
        NOT NULL DEFAULT true,

    last_login_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ
        NOT NULL DEFAULT now(),

    updated_at TIMESTAMPTZ
        NOT NULL DEFAULT now(),

    CONSTRAINT valid_profile_phone
        CHECK (
            normalized_phone IS NULL
            OR normalized_phone ~ '^[0-9]{10,15}$'
        )
);

CREATE INDEX IF NOT EXISTS idx_profiles_phone
ON public.profiles(normalized_phone);

DROP TRIGGER IF EXISTS trg_profiles_updated_at
ON public.profiles;

CREATE TRIGGER trg_profiles_updated_at
BEFORE UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- =============================================================
-- USER ROLES
-- =============================================================

CREATE TABLE IF NOT EXISTS public.user_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL
        REFERENCES public.profiles(id)
        ON DELETE CASCADE,

    hospital_id UUID
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    role public.user_role_type NOT NULL,

    is_primary BOOLEAN
        NOT NULL DEFAULT false,

    created_at TIMESTAMPTZ
        NOT NULL DEFAULT now(),

    CONSTRAINT unique_user_hospital_role
        UNIQUE(user_id, hospital_id, role),

    CONSTRAINT role_hospital_consistency
        CHECK (
            (
                role = 'global_admin'
                AND hospital_id IS NULL
            )
            OR (
                role <> 'global_admin'
                AND hospital_id IS NOT NULL
            )
        )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_primary_role
ON public.user_roles(
    user_id,
    COALESCE(
        hospital_id,
        '00000000-0000-0000-0000-000000000000'::UUID
    )
)
WHERE is_primary = true;

CREATE INDEX IF NOT EXISTS idx_user_roles_user
ON public.user_roles(user_id);

CREATE INDEX IF NOT EXISTS idx_user_roles_hospital
ON public.user_roles(hospital_id);

CREATE INDEX IF NOT EXISTS idx_user_roles_role
ON public.user_roles(role);

-- =============================================================
-- RLS HELPER FUNCTIONS
-- MUST COME AFTER user_roles TABLE
-- =============================================================

CREATE OR REPLACE FUNCTION public.current_user_role(
    p_hospital_id UUID
)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT role::text
    FROM public.user_roles
    WHERE user_id = auth.uid()
      AND hospital_id = p_hospital_id
    LIMIT 1;
$$;

ALTER FUNCTION public.current_user_role(UUID)
SET row_security = off;

REVOKE ALL
ON FUNCTION public.current_user_role(UUID)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.current_user_role(UUID)
TO authenticated;

-- =============================================================

CREATE OR REPLACE FUNCTION public.is_global_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles
        WHERE user_id = auth.uid()
          AND role = 'global_admin'
    );
$$;

ALTER FUNCTION public.is_global_admin()
SET row_security = off;

REVOKE ALL
ON FUNCTION public.is_global_admin()
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.is_global_admin()
TO authenticated;

-- =============================================================

CREATE OR REPLACE FUNCTION public.user_has_hospital_access(
    p_hospital_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles
        WHERE user_id = auth.uid()
          AND hospital_id = p_hospital_id
    );
$$;

ALTER FUNCTION public.user_has_hospital_access(UUID)
SET row_security = off;

REVOKE ALL
ON FUNCTION public.user_has_hospital_access(UUID)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.user_has_hospital_access(UUID)
TO authenticated;

-- =============================================================

CREATE OR REPLACE FUNCTION public.user_has_hospital_role(
    p_hospital_id UUID,
    p_roles TEXT[]
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles
        WHERE user_id = auth.uid()
          AND hospital_id = p_hospital_id
          AND role::text = ANY(p_roles)
    );
$$;

ALTER FUNCTION public.user_has_hospital_role(UUID, TEXT[])
SET row_security = off;

REVOKE ALL
ON FUNCTION public.user_has_hospital_role(UUID, TEXT[])
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.user_has_hospital_role(UUID, TEXT[])
TO authenticated;

-- =============================================================
-- PATIENTS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.patients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    full_name TEXT NOT NULL,

    normalized_phone TEXT NOT NULL,

    age INTEGER
        CHECK (age BETWEEN 0 AND 150),

    gender TEXT,

    village TEXT,

    blood_group TEXT,

    has_diabetes BOOLEAN NOT NULL DEFAULT false,
    has_bp BOOLEAN NOT NULL DEFAULT false,

    total_visits INTEGER
        NOT NULL DEFAULT 0
        CHECK (total_visits >= 0),

    last_visit_date DATE,

    is_deleted BOOLEAN
        NOT NULL DEFAULT false,

    created_at TIMESTAMPTZ
        NOT NULL DEFAULT now(),

    updated_at TIMESTAMPTZ
        NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_patient_dedupe
ON public.patients(
    hospital_id,
    normalized_phone,
    lower(full_name)
)
WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS idx_patients_hospital
ON public.patients(hospital_id);

CREATE INDEX IF NOT EXISTS idx_patients_phone
ON public.patients(
    hospital_id,
    normalized_phone
);

CREATE INDEX IF NOT EXISTS idx_patients_last_visit
ON public.patients(
    hospital_id,
    last_visit_date DESC
);

CREATE INDEX IF NOT EXISTS idx_patients_name_trgm
ON public.patients
USING gin(full_name gin_trgm_ops);

DROP TRIGGER IF EXISTS trg_patients_updated_at
ON public.patients;

CREATE TRIGGER trg_patients_updated_at
BEFORE UPDATE ON public.patients
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_patients_hospital_immutable
ON public.patients;

CREATE TRIGGER trg_patients_hospital_immutable
BEFORE UPDATE ON public.patients
FOR EACH ROW
EXECUTE FUNCTION public.prevent_hospital_id_update();

-- =============================================================
-- HOSPITAL WORKING HOURS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.hospital_working_hours (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    weekday INTEGER NOT NULL
        CHECK (weekday BETWEEN 0 AND 6),

    open_time TIME NOT NULL,
    close_time TIME NOT NULL,

    is_open BOOLEAN NOT NULL DEFAULT true,

    created_at TIMESTAMPTZ
        NOT NULL DEFAULT now(),

    updated_at TIMESTAMPTZ
        NOT NULL DEFAULT now(),

    CONSTRAINT valid_working_hours
        CHECK (close_time > open_time),

    UNIQUE(hospital_id, weekday)
);

DROP TRIGGER IF EXISTS trg_working_hours_updated_at
ON public.hospital_working_hours;

CREATE TRIGGER trg_working_hours_updated_at
BEFORE UPDATE ON public.hospital_working_hours
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- =============================================================
-- HOSPITAL HOLIDAYS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.hospital_holidays (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    holiday_date DATE NOT NULL,

    description TEXT,

    created_at TIMESTAMPTZ
        NOT NULL DEFAULT now(),

    UNIQUE(hospital_id, holiday_date)
);

-- =============================================================
-- SEED DATA
-- Fixed UUIDs + fixed timestamps keep every environment
-- (local, CI, staging, prod) byte-identical. Phase 0
-- determinism requirement. Do not change these IDs.
-- =============================================================

INSERT INTO public.hospitals (
    id,
    name,
    slug,
    town,
    created_at,
    updated_at
)
VALUES
    ('00000000-0000-4000-8000-000000000001',
     'Surya Hospital', 'surya-hospital', 'Narsapur',
     '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
    ('00000000-0000-4000-8000-000000000002',
     'Sri Venkateswara Hospital', 'sri-venkateswara-hospital', 'Narsapur',
     '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
    ('00000000-0000-4000-8000-000000000003',
     'Tulasi Hospital', 'tulasi-hospital', 'Narsapur',
     '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
    ('00000000-0000-4000-8000-000000000004',
     'Vijaya Lakshmi Eye Hospital', 'vijaya-lakshmi-eye-hospital', 'Narsapur',
     '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00'),
    ('00000000-0000-4000-8000-000000000005',
     'Ganesh Children Hospital', 'ganesh-children-hospital', 'Narsapur',
     '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00')
ON CONFLICT (slug)
DO NOTHING;

-- =============================================================
-- ENABLE RLS
-- =============================================================

ALTER TABLE public.hospitals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hospital_working_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hospital_holidays ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.hospitals FORCE ROW LEVEL SECURITY;
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.patients FORCE ROW LEVEL SECURITY;
ALTER TABLE public.hospital_working_hours FORCE ROW LEVEL SECURITY;
ALTER TABLE public.hospital_holidays FORCE ROW LEVEL SECURITY;

-- =============================================================
-- HOSPITAL POLICIES
-- =============================================================

DROP POLICY IF EXISTS hospitals_read
ON public.hospitals;

CREATE POLICY hospitals_read
ON public.hospitals
FOR SELECT
USING (
    public.is_global_admin()
    OR public.user_has_hospital_access(id)
);

DROP POLICY IF EXISTS hospitals_manage
ON public.hospitals;

CREATE POLICY hospitals_manage
ON public.hospitals
FOR ALL
USING (
    public.is_global_admin()
)
WITH CHECK (
    public.is_global_admin()
);

-- =============================================================
-- PROFILE POLICIES
-- =============================================================

DROP POLICY IF EXISTS profiles_self
ON public.profiles;

CREATE POLICY profiles_self
ON public.profiles
FOR ALL
USING (
    id = auth.uid()
)
WITH CHECK (
    id = auth.uid()
);

DROP POLICY IF EXISTS profiles_admin_read
ON public.profiles;

CREATE POLICY profiles_admin_read
ON public.profiles
FOR SELECT
USING (
    public.is_global_admin()
    OR EXISTS (
        SELECT 1
        FROM public.user_roles my_role
        JOIN public.user_roles their_role
            ON their_role.user_id = profiles.id
        WHERE my_role.user_id = auth.uid()
          AND my_role.hospital_id = their_role.hospital_id
          AND my_role.role = 'hospital_admin'
    )
);

-- =============================================================
-- USER ROLE POLICIES
-- =============================================================

DROP POLICY IF EXISTS user_roles_read
ON public.user_roles;

CREATE POLICY user_roles_read
ON public.user_roles
FOR SELECT
USING (
    user_id = auth.uid()
    OR public.is_global_admin()
);

DROP POLICY IF EXISTS user_roles_manage
ON public.user_roles;

CREATE POLICY user_roles_manage
ON public.user_roles
FOR ALL
USING (
    public.is_global_admin()
)
WITH CHECK (
    public.is_global_admin()
);

-- =============================================================
-- PATIENT POLICIES
-- =============================================================

DROP POLICY IF EXISTS patients_read
ON public.patients;

CREATE POLICY patients_read
ON public.patients
FOR SELECT
USING (
    public.is_global_admin()
    OR public.user_has_hospital_access(hospital_id)
);

DROP POLICY IF EXISTS patients_insert
ON public.patients;

CREATE POLICY patients_insert
ON public.patients
FOR INSERT
WITH CHECK (
    public.is_global_admin()
    OR public.user_has_hospital_role(
        hospital_id,
        ARRAY[
            'hospital_admin',
            'doctor',
            'receptionist'
        ]
    )
);

DROP POLICY IF EXISTS patients_update
ON public.patients;

CREATE POLICY patients_update
ON public.patients
FOR UPDATE
USING (
    public.is_global_admin()
    OR public.user_has_hospital_role(
        hospital_id,
        ARRAY[
            'hospital_admin',
            'doctor',
            'receptionist'
        ]
    )
)
WITH CHECK (
    public.is_global_admin()
    OR public.user_has_hospital_role(
        hospital_id,
        ARRAY[
            'hospital_admin',
            'doctor',
            'receptionist'
        ]
    )
);

-- =============================================================
-- WORKING HOURS POLICIES
-- =============================================================

DROP POLICY IF EXISTS working_hours_read
ON public.hospital_working_hours;

CREATE POLICY working_hours_read
ON public.hospital_working_hours
FOR SELECT
USING (
    public.is_global_admin()
    OR public.user_has_hospital_access(hospital_id)
);

DROP POLICY IF EXISTS working_hours_manage
ON public.hospital_working_hours;

CREATE POLICY working_hours_manage
ON public.hospital_working_hours
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
-- HOLIDAY POLICIES
-- =============================================================

DROP POLICY IF EXISTS holidays_read
ON public.hospital_holidays;

CREATE POLICY holidays_read
ON public.hospital_holidays
FOR SELECT
USING (
    public.is_global_admin()
    OR public.user_has_hospital_access(hospital_id)
);

DROP POLICY IF EXISTS holidays_manage
ON public.hospital_holidays;

CREATE POLICY holidays_manage
ON public.hospital_holidays
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