-- =============================================================
-- SETURA HOSPITAL OS
-- Script 09: Abuse Protection & Rate Limiting
-- PRODUCTION SAFE VERSION
-- =============================================================

-- =============================================================
-- ENUMS
-- =============================================================

DO $$
BEGIN
    CREATE TYPE public.spam_event_type AS ENUM (
        'rapid_booking',
        'phone_rotation',
        'device_rotation',
        'payment_failure_flood',
        'ip_flood',
        'manual_flag'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    CREATE TYPE public.restriction_status AS ENUM (
        'active',
        'expired',
        'lifted'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================
-- PHONE NORMALIZER
-- IMMUTABLE SAFE
-- =============================================================

CREATE OR REPLACE FUNCTION public.normalize_phone_number(
    p_phone TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_phone TEXT;
BEGIN

    IF p_phone IS NULL THEN
        RETURN NULL;
    END IF;

    -- Strip non-digits except +
    v_phone := regexp_replace(
        trim(p_phone),
        '[^0-9+]',
        '',
        'g'
    );

    -- Indian mobile normalization
    IF v_phone ~ '^[6-9][0-9]{9}$' THEN
        v_phone := '+91' || v_phone;

    ELSIF v_phone ~ '^91[6-9][0-9]{9}$' THEN
        v_phone := '+' || v_phone;
    END IF;

    RETURN v_phone;

END;
$$;

-- =============================================================
-- RATE LIMIT RULES
-- =============================================================

CREATE TABLE IF NOT EXISTS public.rate_limit_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    rule_name TEXT NOT NULL,

    window_minutes INTEGER NOT NULL DEFAULT 10
        CHECK (
            window_minutes BETWEEN 1 AND 1440
        ),

    max_attempts INTEGER NOT NULL DEFAULT 5
        CHECK (
            max_attempts BETWEEN 1 AND 10000
        ),

    is_active BOOLEAN NOT NULL DEFAULT true,

    metadata JSONB NOT NULL DEFAULT '{}'
        CHECK (
            jsonb_typeof(metadata) = 'object'
        ),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_rules_hospital
ON public.rate_limit_rules(
    hospital_id,
    is_active
);

-- =============================================================
-- BOOKING ATTEMPT LOGS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.booking_attempt_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    normalized_phone TEXT NOT NULL,

    ip_address INET,

    device_identifier TEXT,

    success BOOLEAN NOT NULL DEFAULT false,

    metadata JSONB NOT NULL DEFAULT '{}'
        CHECK (
            jsonb_typeof(metadata) = 'object'
        ),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attempt_logs_phone_time
ON public.booking_attempt_logs(
    hospital_id,
    normalized_phone,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_attempt_logs_ip_time
ON public.booking_attempt_logs(
    hospital_id,
    ip_address,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_attempt_logs_device_time
ON public.booking_attempt_logs(
    hospital_id,
    device_identifier,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_attempt_logs_created
ON public.booking_attempt_logs(
    created_at DESC
);

-- =============================================================
-- SPAM EVENTS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.spam_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    event_type public.spam_event_type NOT NULL,

    phone_number TEXT,

    device_identifier TEXT,

    ip_address INET,

    risk_score INTEGER NOT NULL DEFAULT 1
        CHECK (
            risk_score >= 0
        ),

    metadata JSONB NOT NULL DEFAULT '{}'
        CHECK (
            jsonb_typeof(metadata) = 'object'
        ),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spam_events_phone
ON public.spam_events(
    hospital_id,
    phone_number,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_spam_events_ip
ON public.spam_events(
    hospital_id,
    ip_address,
    created_at DESC
);

-- =============================================================
-- BLOCKED NUMBERS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.blocked_numbers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    normalized_phone TEXT NOT NULL,

    block_reason TEXT,

    restriction_status public.restriction_status
        NOT NULL DEFAULT 'active',

    blocked_until TIMESTAMPTZ,

    metadata JSONB NOT NULL DEFAULT '{}'
        CHECK (
            jsonb_typeof(metadata) = 'object'
        ),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (
        hospital_id,
        normalized_phone
    )
);

CREATE INDEX IF NOT EXISTS idx_blocked_numbers_active
ON public.blocked_numbers(
    hospital_id,
    normalized_phone
)
WHERE restriction_status = 'active';

-- =============================================================
-- BLOCKED DEVICES
-- =============================================================

CREATE TABLE IF NOT EXISTS public.blocked_devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    device_identifier TEXT UNIQUE NOT NULL,

    block_reason TEXT,

    restriction_status public.restriction_status
        NOT NULL DEFAULT 'active',

    blocked_until TIMESTAMPTZ,

    metadata JSONB NOT NULL DEFAULT '{}'
        CHECK (
            jsonb_typeof(metadata) = 'object'
        ),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================
-- ABUSE SCORES
-- =============================================================

CREATE TABLE IF NOT EXISTS public.abuse_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    normalized_phone TEXT NOT NULL,

    device_identifier TEXT,

    ip_address INET,

    total_score INTEGER NOT NULL DEFAULT 0
        CHECK (
            total_score >= 0
        ),

    last_event_at TIMESTAMPTZ,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (
        hospital_id,
        normalized_phone
    )
);

CREATE INDEX IF NOT EXISTS idx_abuse_scores_total
ON public.abuse_scores(
    hospital_id,
    total_score DESC
);

DROP TRIGGER IF EXISTS trg_abuse_scores_updated_at
ON public.abuse_scores;

CREATE TRIGGER trg_abuse_scores_updated_at
BEFORE UPDATE ON public.abuse_scores
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- =============================================================
-- TEMPORARY RESTRICTIONS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.temporary_restrictions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    restriction_type TEXT NOT NULL,

    phone_number TEXT,

    device_identifier TEXT,

    ip_address INET,

    restriction_reason TEXT,

    restriction_status public.restriction_status
        NOT NULL DEFAULT 'active',

    restricted_until TIMESTAMPTZ,

    metadata JSONB NOT NULL DEFAULT '{}'
        CHECK (
            jsonb_typeof(metadata) = 'object'
        ),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_restriction_window
        CHECK (
            restricted_until IS NULL
            OR restricted_until > created_at
        )
);

CREATE INDEX IF NOT EXISTS idx_temp_restrictions_phone
ON public.temporary_restrictions(
    hospital_id,
    phone_number,
    restriction_status
)
WHERE restriction_status = 'active';

CREATE INDEX IF NOT EXISTS idx_temp_restrictions_ip
ON public.temporary_restrictions(
    hospital_id,
    ip_address,
    restriction_status
)
WHERE restriction_status = 'active';

-- =============================================================
-- RATE LIMIT CHECK
-- =============================================================

CREATE OR REPLACE FUNCTION public.check_booking_rate_limit(
    p_hospital_id UUID,
    p_phone TEXT,
    p_window_minutes INTEGER DEFAULT 10,
    p_max_attempts INTEGER DEFAULT 5
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_phone TEXT;
    v_count INTEGER;
BEGIN

    v_phone := public.normalize_phone_number(
        p_phone
    );

    SELECT COUNT(*)
    INTO v_count
    FROM public.booking_attempt_logs
    WHERE hospital_id = p_hospital_id
      AND normalized_phone = v_phone
      AND created_at >= (
            now()
            -
            make_interval(
                mins => p_window_minutes
            )
      );

    RETURN v_count < p_max_attempts;

END;
$$;

ALTER FUNCTION public.check_booking_rate_limit(UUID,TEXT,INTEGER,INTEGER)
SET row_security = off;

-- =============================================================
-- PHONE BLOCK CHECK
-- =============================================================

CREATE OR REPLACE FUNCTION public.is_phone_blocked(
    p_hospital_id UUID,
    p_phone TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_phone TEXT;
BEGIN

    v_phone := public.normalize_phone_number(
        p_phone
    );

    RETURN EXISTS (
        SELECT 1
        FROM public.blocked_numbers
        WHERE hospital_id = p_hospital_id
          AND normalized_phone = v_phone
          AND restriction_status = 'active'
          AND (
                blocked_until IS NULL
                OR blocked_until > now()
          )
    )
    OR EXISTS (
        SELECT 1
        FROM public.temporary_restrictions
        WHERE hospital_id = p_hospital_id
          AND phone_number = v_phone
          AND restriction_status = 'active'
          AND (
                restricted_until IS NULL
                OR restricted_until > now()
          )
    );

END;
$$;

ALTER FUNCTION public.is_phone_blocked(UUID,TEXT)
SET row_security = off;

-- =============================================================
-- LOG BOOKING ATTEMPT
-- =============================================================

CREATE OR REPLACE FUNCTION public.log_booking_attempt(
    p_hospital_id UUID,
    p_phone TEXT,
    p_ip_address INET,
    p_device_identifier TEXT,
    p_success BOOLEAN DEFAULT false,
    p_metadata JSONB DEFAULT '{}'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

    INSERT INTO public.booking_attempt_logs (
        hospital_id,
        normalized_phone,
        ip_address,
        device_identifier,
        success,
        metadata
    )
    VALUES (
        p_hospital_id,
        public.normalize_phone_number(
            p_phone
        ),
        p_ip_address,
        p_device_identifier,
        p_success,
        COALESCE(p_metadata, '{}')
    );

END;
$$;

ALTER FUNCTION public.log_booking_attempt(UUID,TEXT,INET,TEXT,BOOLEAN,JSONB)
SET row_security = off;

-- =============================================================
-- INCREMENT ABUSE SCORE
-- =============================================================

CREATE OR REPLACE FUNCTION public.increment_abuse_score(
    p_hospital_id UUID,
    p_phone TEXT,
    p_device_identifier TEXT,
    p_ip_address INET,
    p_score INTEGER DEFAULT 1
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_total INTEGER;
BEGIN

    INSERT INTO public.abuse_scores (
        hospital_id,
        normalized_phone,
        device_identifier,
        ip_address,
        total_score,
        last_event_at
    )
    VALUES (
        p_hospital_id,
        public.normalize_phone_number(
            p_phone
        ),
        p_device_identifier,
        p_ip_address,
        p_score,
        now()
    )
    ON CONFLICT (
        hospital_id,
        normalized_phone
    )
    DO UPDATE
    SET
        total_score =
            abuse_scores.total_score
            +
            EXCLUDED.total_score,

        last_event_at = now(),

        ip_address = EXCLUDED.ip_address,

        device_identifier =
            COALESCE(
                EXCLUDED.device_identifier,
                abuse_scores.device_identifier
            )

    RETURNING total_score
    INTO v_total;

    RETURN v_total;

END;
$$;

ALTER FUNCTION public.increment_abuse_score(UUID,TEXT,TEXT,INET,INTEGER)
SET row_security = off;

-- =============================================================
-- CLEANUP EXPIRED RESTRICTIONS
-- =============================================================

CREATE OR REPLACE FUNCTION public.cleanup_expired_restrictions()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INTEGER;
BEGIN

    UPDATE public.temporary_restrictions
    SET restriction_status = 'expired'
    WHERE restriction_status = 'active'
      AND restricted_until <= now();

    GET DIAGNOSTICS v_count = ROW_COUNT;

    UPDATE public.blocked_numbers
    SET restriction_status = 'expired'
    WHERE restriction_status = 'active'
      AND blocked_until <= now();

    RETURN v_count;

END;
$$;

ALTER FUNCTION public.cleanup_expired_restrictions()
SET row_security = off;

-- =============================================================
-- ENABLE RLS
-- =============================================================

ALTER TABLE public.rate_limit_rules
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.booking_attempt_logs
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.spam_events
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.blocked_numbers
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.blocked_devices
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.abuse_scores
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.temporary_restrictions
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.rate_limit_rules
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.booking_attempt_logs
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.spam_events
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.blocked_numbers
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.blocked_devices
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.abuse_scores
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.temporary_restrictions
FORCE ROW LEVEL SECURITY;

-- =============================================================
-- POLICIES
-- =============================================================

CREATE POLICY abuse_admin_read
ON public.spam_events
FOR SELECT
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        = 'hospital_admin'
);

CREATE POLICY blocked_numbers_admin
ON public.blocked_numbers
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

CREATE POLICY temp_restrictions_admin
ON public.temporary_restrictions
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

CREATE POLICY abuse_scores_admin
ON public.abuse_scores
FOR SELECT
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        = 'hospital_admin'
);

CREATE POLICY booking_attempt_logs_admin
ON public.booking_attempt_logs
FOR SELECT
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        = 'hospital_admin'
);