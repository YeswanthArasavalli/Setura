-- =============================================================
-- SETURA HOSPITAL OS
-- Script 12: Hospital Configuration Engine
-- FINAL PRODUCTION SAFE VERSION
-- =============================================================

BEGIN;

-- =============================================================
-- SYSTEM SETTINGS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.system_settings (
    key TEXT PRIMARY KEY,

    value JSONB NOT NULL,

    description TEXT,

    updated_by UUID
        REFERENCES public.profiles(id)
        ON DELETE SET NULL,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_system_setting_json
    CHECK (
        jsonb_typeof(value)
        IN (
            'object',
            'array',
            'string',
            'number',
            'boolean'
        )
    )
);

DROP TRIGGER IF EXISTS trg_system_settings_updated_at
ON public.system_settings;

CREATE TRIGGER trg_system_settings_updated_at
BEFORE UPDATE
ON public.system_settings
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- =============================================================
-- DEFAULT SYSTEM SETTINGS
-- =============================================================

INSERT INTO public.system_settings (
    key,
    value,
    description
)
VALUES
(
    'default_platform_fee_online',
    '20'::jsonb,
    'Default online booking fee'
),
(
    'default_platform_fee_whatsapp',
    '10'::jsonb,
    'Default WhatsApp booking fee'
),
(
    'default_receptionist_fee',
    '5'::jsonb,
    'Default receptionist incentive'
),
(
    'max_advance_booking_days',
    '7'::jsonb,
    'Maximum advance booking days'
),
(
    'whatsapp_max_retries',
    '5'::jsonb,
    'Maximum WhatsApp retries'
),
(
    'carry_forward_hour',
    '22'::jsonb,
    'Night carry forward hour'
),
(
    'analytics_refresh_hour',
    '0'::jsonb,
    'Analytics refresh hour'
),
(
    'rate_limit_window_minutes',
    '10'::jsonb,
    'Rate limit duration'
),
(
    'rate_limit_max_attempts',
    '5'::jsonb,
    'Max booking attempts'
),
(
    'abuse_auto_block_score',
    '8'::jsonb,
    'Auto block score threshold'
)
ON CONFLICT (key)
DO NOTHING;

-- =============================================================
-- HOSPITAL SETTINGS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.hospital_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID NOT NULL UNIQUE
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    -- Branding
    display_name TEXT,

    logo_url TEXT,

    whatsapp_number TEXT,

    meta_phone_number_id TEXT,

    meta_waba_id TEXT,

    -- Fees
    platform_fee_online NUMERIC(10,2)
        NOT NULL DEFAULT 20
        CHECK (platform_fee_online >= 0),

    platform_fee_whatsapp NUMERIC(10,2)
        NOT NULL DEFAULT 10
        CHECK (platform_fee_whatsapp >= 0),

    receptionist_fee NUMERIC(10,2)
        NOT NULL DEFAULT 5
        CHECK (receptionist_fee >= 0),

    online_booking_fee_enabled BOOLEAN
        NOT NULL DEFAULT true,

    -- Queue behavior
    max_tokens_per_day INTEGER
        NOT NULL DEFAULT 100
        CHECK (max_tokens_per_day BETWEEN 1 AND 5000),

    allow_walkin_tokens BOOLEAN
        NOT NULL DEFAULT true,

    allow_online_booking BOOLEAN
        NOT NULL DEFAULT true,

    allow_carry_forward BOOLEAN
        NOT NULL DEFAULT true,

    queue_display_enabled BOOLEAN
        NOT NULL DEFAULT true,

    -- Notifications
    send_whatsapp_confirmation BOOLEAN
        NOT NULL DEFAULT true,

    send_whatsapp_reminder BOOLEAN
        NOT NULL DEFAULT true,

    send_feedback_request BOOLEAN
        NOT NULL DEFAULT true,

    reminder_before_minutes INTEGER
        NOT NULL DEFAULT 30
        CHECK (
            reminder_before_minutes BETWEEN 1 AND 1440
        ),

    -- Payments
    razorpay_key_id TEXT,

    payment_enabled BOOLEAN
        NOT NULL DEFAULT false,

    -- Locale
    preferred_language TEXT
        NOT NULL DEFAULT 'te',

    timezone TEXT
        NOT NULL DEFAULT 'Asia/Kolkata',

    metadata JSONB NOT NULL DEFAULT '{}'
        CHECK (
            jsonb_typeof(metadata) = 'object'
        ),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- FIXED:
    -- PostgreSQL does not allow subqueries in CHECK constraints
    CONSTRAINT valid_timezone_format
    CHECK (
        length(trim(timezone)) > 0
    )
);

CREATE INDEX IF NOT EXISTS idx_hospital_settings_hospital
ON public.hospital_settings(hospital_id);

DROP TRIGGER IF EXISTS trg_hospital_settings_updated_at
ON public.hospital_settings;

CREATE TRIGGER trg_hospital_settings_updated_at
BEFORE UPDATE
ON public.hospital_settings
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_hospital_settings_immutable
ON public.hospital_settings;

CREATE TRIGGER trg_hospital_settings_immutable
BEFORE UPDATE
ON public.hospital_settings
FOR EACH ROW
EXECUTE FUNCTION public.prevent_hospital_id_update();

-- =============================================================
-- AUTO CREATE HOSPITAL SETTINGS
-- =============================================================

CREATE OR REPLACE FUNCTION public.auto_create_hospital_settings()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

    INSERT INTO public.hospital_settings (
        hospital_id
    )
    VALUES (
        NEW.id
    )
    ON CONFLICT (hospital_id)
    DO NOTHING;

    RETURN NEW;

END;
$$;

ALTER FUNCTION public.auto_create_hospital_settings()
SET row_security = off;

DROP TRIGGER IF EXISTS trg_auto_hospital_settings
ON public.hospitals;

CREATE TRIGGER trg_auto_hospital_settings
AFTER INSERT
ON public.hospitals
FOR EACH ROW
EXECUTE FUNCTION public.auto_create_hospital_settings();

-- =============================================================
-- FEATURE FLAGS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.feature_flags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    flag_key TEXT NOT NULL,

    is_enabled BOOLEAN NOT NULL DEFAULT false,

    rollout_pct INTEGER NOT NULL DEFAULT 100
        CHECK (
            rollout_pct BETWEEN 0 AND 100
        ),

    metadata JSONB NOT NULL DEFAULT '{}'
        CHECK (
            jsonb_typeof(metadata) = 'object'
        ),

    updated_by UUID
        REFERENCES public.profiles(id)
        ON DELETE SET NULL,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_feature_flags_global_unique
ON public.feature_flags(flag_key)
WHERE hospital_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_feature_flags_hospital_unique
ON public.feature_flags(hospital_id, flag_key)
WHERE hospital_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_feature_flags_lookup
ON public.feature_flags(
    hospital_id,
    flag_key,
    is_enabled
);

DROP TRIGGER IF EXISTS trg_feature_flags_updated_at
ON public.feature_flags;

CREATE TRIGGER trg_feature_flags_updated_at
BEFORE UPDATE
ON public.feature_flags
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- =============================================================
-- FEATURE FLAG SEEDS
-- =============================================================

INSERT INTO public.feature_flags (
    hospital_id,
    flag_key,
    is_enabled
)
VALUES
(NULL, 'online_payment', false),
(NULL, 'multi_doctor_queue', false),
(NULL, 'patient_portal', false),
(NULL, 'sms_notifications', false),
(NULL, 'advanced_analytics', true),
(NULL, 'revenue_dashboard', true),
(NULL, 'whatsapp_two_way', false),
(NULL, 'queue_display_screen', true),
(NULL, 'carry_forward_auto', true),
(NULL, 'duplicate_patient_merge', false)
ON CONFLICT DO NOTHING;

-- =============================================================
-- FEATURE FLAG HELPER
-- =============================================================

CREATE OR REPLACE FUNCTION public.is_feature_enabled(
    p_hospital_id UUID,
    p_flag_key TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(

        (
            SELECT ff.is_enabled
            FROM public.feature_flags ff
            WHERE ff.hospital_id = p_hospital_id
              AND ff.flag_key = p_flag_key
            LIMIT 1
        ),

        (
            SELECT ff.is_enabled
            FROM public.feature_flags ff
            WHERE ff.hospital_id IS NULL
              AND ff.flag_key = p_flag_key
            LIMIT 1
        ),

        false
    );
$$;

ALTER FUNCTION public.is_feature_enabled(UUID,TEXT)
SET row_security = off;

-- =============================================================
-- QUEUE CONFIGS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.queue_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    doctor_id UUID
        REFERENCES public.profiles(id)
        ON DELETE CASCADE,

    config_key TEXT NOT NULL,

    config_value JSONB NOT NULL,

    description TEXT,

    updated_by UUID
        REFERENCES public.profiles(id)
        ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_queue_config_json
    CHECK (
        jsonb_typeof(config_value)
        IN (
            'object',
            'array',
            'string',
            'number',
            'boolean'
        )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_configs_doctor_unique
ON public.queue_configs(
    hospital_id,
    doctor_id,
    config_key
)
WHERE doctor_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_configs_hospital_unique
ON public.queue_configs(
    hospital_id,
    config_key
)
WHERE doctor_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_queue_configs_lookup
ON public.queue_configs(
    hospital_id,
    doctor_id,
    config_key
);

DROP TRIGGER IF EXISTS trg_queue_configs_updated_at
ON public.queue_configs;

CREATE TRIGGER trg_queue_configs_updated_at
BEFORE UPDATE
ON public.queue_configs
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_queue_configs_immutable
ON public.queue_configs;

CREATE TRIGGER trg_queue_configs_immutable
BEFORE UPDATE
ON public.queue_configs
FOR EACH ROW
EXECUTE FUNCTION public.prevent_hospital_id_update();

-- =============================================================
-- QUEUE CONFIG HELPER
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_queue_config(
    p_hospital_id UUID,
    p_doctor_id UUID,
    p_config_key TEXT
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(

        (
            SELECT qc.config_value
            FROM public.queue_configs qc
            WHERE qc.hospital_id = p_hospital_id
              AND qc.doctor_id = p_doctor_id
              AND qc.config_key = p_config_key
            LIMIT 1
        ),

        (
            SELECT qc.config_value
            FROM public.queue_configs qc
            WHERE qc.hospital_id = p_hospital_id
              AND qc.doctor_id IS NULL
              AND qc.config_key = p_config_key
            LIMIT 1
        )

    );
$$;

ALTER FUNCTION public.get_queue_config(UUID,UUID,TEXT)
SET row_security = off;

-- =============================================================
-- EFFECTIVE FEES
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_effective_fees(
    p_hospital_id UUID,
    p_booking_source public.booking_source
)
RETURNS TABLE (
    platform_fee NUMERIC(10,2),
    receptionist_fee NUMERIC(10,2),
    hospital_fee NUMERIC(10,2),
    total_amount NUMERIC(10,2)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT

        CASE p_booking_source
            WHEN 'online'
                THEN hs.platform_fee_online
            WHEN 'manual_whatsapp'
                THEN hs.platform_fee_whatsapp
            ELSE 0
        END::NUMERIC(10,2),

        CASE p_booking_source
            WHEN 'manual_whatsapp'
                THEN hs.receptionist_fee
            ELSE 0
        END::NUMERIC(10,2),

        0::NUMERIC(10,2),

        CASE p_booking_source
            WHEN 'online'
                THEN hs.platform_fee_online
            WHEN 'manual_whatsapp'
                THEN hs.platform_fee_whatsapp + hs.receptionist_fee
            ELSE 0
        END::NUMERIC(10,2)

    FROM public.hospital_settings hs
    WHERE hs.hospital_id = p_hospital_id
    LIMIT 1;
$$;

ALTER FUNCTION public.get_effective_fees(UUID,public.booking_source)
SET row_security = off;

-- =============================================================
-- ENABLE RLS
-- =============================================================

ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_settings FORCE ROW LEVEL SECURITY;

ALTER TABLE public.hospital_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hospital_settings FORCE ROW LEVEL SECURITY;

ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feature_flags FORCE ROW LEVEL SECURITY;

ALTER TABLE public.queue_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.queue_configs FORCE ROW LEVEL SECURITY;

-- =============================================================
-- POLICIES
-- =============================================================

DROP POLICY IF EXISTS system_settings_global_admin
ON public.system_settings;

CREATE POLICY system_settings_global_admin
ON public.system_settings
FOR ALL
USING (
    public.is_global_admin()
)
WITH CHECK (
    public.is_global_admin()
);

DROP POLICY IF EXISTS system_settings_read
ON public.system_settings;

CREATE POLICY system_settings_read
ON public.system_settings
FOR SELECT
USING (true);

DROP POLICY IF EXISTS hospital_settings_read
ON public.hospital_settings;

CREATE POLICY hospital_settings_read
ON public.hospital_settings
FOR SELECT
USING (
    public.is_global_admin()
    OR public.user_has_hospital_access(hospital_id)
);

DROP POLICY IF EXISTS hospital_settings_manage
ON public.hospital_settings;

CREATE POLICY hospital_settings_manage
ON public.hospital_settings
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

DROP POLICY IF EXISTS feature_flags_read
ON public.feature_flags;

CREATE POLICY feature_flags_read
ON public.feature_flags
FOR SELECT
USING (
    hospital_id IS NULL
    OR public.is_global_admin()
    OR public.user_has_hospital_access(hospital_id)
);

DROP POLICY IF EXISTS feature_flags_manage
ON public.feature_flags;

CREATE POLICY feature_flags_manage
ON public.feature_flags
FOR ALL
USING (
    public.is_global_admin()
)
WITH CHECK (
    public.is_global_admin()
);

DROP POLICY IF EXISTS queue_configs_read
ON public.queue_configs;

CREATE POLICY queue_configs_read
ON public.queue_configs
FOR SELECT
USING (
    public.is_global_admin()
    OR public.user_has_hospital_access(hospital_id)
);

DROP POLICY IF EXISTS queue_configs_manage
ON public.queue_configs;

CREATE POLICY queue_configs_manage
ON public.queue_configs
FOR ALL
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        IN (
            'hospital_admin',
            'receptionist'
        )
)
WITH CHECK (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        IN (
            'hospital_admin',
            'receptionist'
        )
);

COMMIT;