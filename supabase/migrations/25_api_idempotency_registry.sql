-- ============================================================
-- SETURA - Script 25: API Idempotency Registry
-- FULL HARDENED PRODUCTION VERSION
-- SUPABASE SAFE
-- FIRST RUN SAFE
-- RE-RUN SAFE
-- ============================================================

BEGIN;

-- ============================================================
-- ENUMS
-- ============================================================

DO $$
BEGIN
    CREATE TYPE public.idempotency_status AS ENUM (
        'processing',
        'completed',
        'failed',
        'expired'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END;
$$;

-- ============================================================
-- IDEMPOTENCY KEYS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.api_idempotency_keys (

    idempotency_key TEXT NOT NULL,

    api_endpoint TEXT NOT NULL,

    hospital_id UUID
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    user_id UUID
        REFERENCES public.profiles(id)
        ON DELETE SET NULL,

    request_hash TEXT,

    request_summary JSONB NOT NULL DEFAULT '{}',

    status public.idempotency_status
        NOT NULL DEFAULT 'processing',

    response_status_code INTEGER,

    response_body JSONB,

    response_headers JSONB
        NOT NULL DEFAULT '{}',

    first_attempt_at TIMESTAMPTZ
        NOT NULL DEFAULT now(),

    completed_at TIMESTAMPTZ,

    expires_at TIMESTAMPTZ
        NOT NULL DEFAULT (
            now() + interval '24 hours'
        ),

    claimed_by_instance TEXT,

    error_code TEXT,

    error_message TEXT,

    attempt_count INTEGER
        NOT NULL DEFAULT 1
        CHECK (attempt_count >= 1),

    PRIMARY KEY (
        idempotency_key,
        api_endpoint
    ),

    CONSTRAINT valid_idempotency_key
    CHECK (
        length(trim(idempotency_key)) >= 8
    ),

    CONSTRAINT valid_endpoint
    CHECK (
        length(trim(api_endpoint)) > 0
    )
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_idem_keys_expires
ON public.api_idempotency_keys(
    expires_at
)
WHERE status != 'expired';

CREATE INDEX IF NOT EXISTS idx_idem_keys_user
ON public.api_idempotency_keys(
    user_id,
    first_attempt_at DESC
)
WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_idem_keys_hospital
ON public.api_idempotency_keys(
    hospital_id,
    api_endpoint,
    first_attempt_at DESC
)
WHERE hospital_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_idem_keys_processing
ON public.api_idempotency_keys(
    status,
    first_attempt_at
);

CREATE INDEX IF NOT EXISTS idx_idem_keys_endpoint
ON public.api_idempotency_keys(
    api_endpoint,
    first_attempt_at DESC
);

-- ============================================================
-- CLAIM KEY
-- ============================================================

CREATE OR REPLACE FUNCTION public.claim_idempotency_key(
    p_key TEXT,
    p_endpoint TEXT,
    p_hospital_id UUID DEFAULT NULL,
    p_user_id UUID DEFAULT NULL,
    p_request_hash TEXT DEFAULT NULL,
    p_request_summary JSONB DEFAULT '{}',
    p_instance_id TEXT DEFAULT NULL
)
RETURNS TABLE (
    is_new BOOLEAN,
    status public.idempotency_status,
    response_status_code INTEGER,
    response_body JSONB,
    mismatch_detected BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_existing RECORD;
    v_inserted BOOLEAN := false;
    v_mismatch BOOLEAN := false;
BEGIN

    IF p_key IS NULL OR length(trim(p_key)) < 8 THEN
        RAISE EXCEPTION 'Invalid idempotency key';
    END IF;

    INSERT INTO public.api_idempotency_keys (
        idempotency_key,
        api_endpoint,
        hospital_id,
        user_id,
        request_hash,
        request_summary,
        claimed_by_instance
    )
    VALUES (
        p_key,
        p_endpoint,
        p_hospital_id,
        p_user_id,
        p_request_hash,
        p_request_summary,
        p_instance_id
    )
    ON CONFLICT (
        idempotency_key,
        api_endpoint
    )
    DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    SELECT *
    INTO v_existing
    FROM public.api_idempotency_keys
    WHERE idempotency_key = p_key
      AND api_endpoint = p_endpoint
    FOR UPDATE;

    IF v_existing.request_hash IS NOT NULL
       AND p_request_hash IS NOT NULL
       AND v_existing.request_hash != p_request_hash THEN

        v_mismatch := true;

    END IF;

    IF NOT v_inserted THEN

        UPDATE public.api_idempotency_keys
        SET attempt_count = attempt_count + 1
        WHERE idempotency_key = p_key
          AND api_endpoint = p_endpoint;

    END IF;

    RETURN QUERY
    SELECT
        v_inserted,
        v_existing.status,
        v_existing.response_status_code,
        v_existing.response_body,
        v_mismatch;

END;
$$;

ALTER FUNCTION public.claim_idempotency_key(
    TEXT,
    TEXT,
    UUID,
    UUID,
    TEXT,
    JSONB,
    TEXT
)
SET row_security = off;

-- ============================================================
-- COMPLETE KEY
-- ============================================================

CREATE OR REPLACE FUNCTION public.complete_idempotency_key(
    p_key TEXT,
    p_endpoint TEXT,
    p_response_code INTEGER,
    p_response_body JSONB,
    p_response_headers JSONB DEFAULT '{}'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

    UPDATE public.api_idempotency_keys
    SET
        status = 'completed',
        response_status_code = p_response_code,
        response_body = p_response_body,
        response_headers = p_response_headers,
        completed_at = now()
    WHERE idempotency_key = p_key
      AND api_endpoint = p_endpoint
      AND status = 'processing';

    RETURN FOUND;

END;
$$;

ALTER FUNCTION public.complete_idempotency_key(
    TEXT,
    TEXT,
    INTEGER,
    JSONB,
    JSONB
)
SET row_security = off;

-- ============================================================
-- FAIL KEY
-- ============================================================

CREATE OR REPLACE FUNCTION public.fail_idempotency_key(
    p_key TEXT,
    p_endpoint TEXT,
    p_error_code TEXT,
    p_error_message TEXT,
    p_response_code INTEGER DEFAULT 500
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

    UPDATE public.api_idempotency_keys
    SET
        status = 'failed',
        error_code = p_error_code,
        error_message = left(p_error_message, 4000),
        response_status_code = p_response_code,
        completed_at = now()
    WHERE idempotency_key = p_key
      AND api_endpoint = p_endpoint
      AND status = 'processing';

    RETURN FOUND;

END;
$$;

ALTER FUNCTION public.fail_idempotency_key(
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    INTEGER
)
SET row_security = off;

-- ============================================================
-- RESET STALE PROCESSING KEYS
-- ============================================================

CREATE OR REPLACE FUNCTION public.reset_stale_idempotency_keys(
    p_stuck_minutes INTEGER DEFAULT 5
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INTEGER;
BEGIN

    UPDATE public.api_idempotency_keys
    SET
        status = 'failed',
        error_code = 'HANDLER_TIMEOUT',
        error_message =
            format(
                'Handler timed out after %s minutes',
                p_stuck_minutes
            ),
        completed_at = now()
    WHERE status = 'processing'
      AND first_attempt_at <
            now() -
            make_interval(mins => p_stuck_minutes);

    GET DIAGNOSTICS v_count = ROW_COUNT;

    RETURN v_count;

END;
$$;

ALTER FUNCTION public.reset_stale_idempotency_keys(INTEGER)
SET row_security = off;

-- ============================================================
-- CLEANUP
-- ============================================================

CREATE OR REPLACE FUNCTION public.cleanup_idempotency_keys()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INTEGER;
BEGIN

    UPDATE public.api_idempotency_keys
    SET status = 'expired'
    WHERE expires_at < now()
      AND status IN ('completed', 'failed');

    DELETE FROM public.api_idempotency_keys
    WHERE status = 'expired'
      AND expires_at < now() - interval '48 hours';

    GET DIAGNOSTICS v_count = ROW_COUNT;

    RETURN v_count;

END;
$$;

ALTER FUNCTION public.cleanup_idempotency_keys()
SET row_security = off;

-- ============================================================
-- STATS VIEW
-- ============================================================

CREATE OR REPLACE VIEW public.idempotency_stats AS
SELECT
    api_endpoint,

    COUNT(*) AS total_keys,

    COUNT(*) FILTER (
        WHERE status = 'processing'
    ) AS in_flight,

    COUNT(*) FILTER (
        WHERE status = 'completed'
    ) AS completed,

    COUNT(*) FILTER (
        WHERE status = 'failed'
    ) AS failed,

    COUNT(*) FILTER (
        WHERE status = 'expired'
    ) AS expired,

    COUNT(*) FILTER (
        WHERE attempt_count > 1
    ) AS retried,

    ROUND(
        AVG(attempt_count),
        2
    ) AS avg_attempts,

    MAX(attempt_count) AS max_attempts

FROM public.api_idempotency_keys
WHERE first_attempt_at >
    now() - interval '24 hours'
GROUP BY api_endpoint
ORDER BY total_keys DESC;

-- ============================================================
-- ENDPOINT REGISTRY
-- ============================================================

CREATE TABLE IF NOT EXISTS public.idempotency_endpoint_registry (

    endpoint_name TEXT PRIMARY KEY,

    description TEXT NOT NULL,

    idempotency_required BOOLEAN
        NOT NULL DEFAULT true,

    max_retries_allowed INTEGER
        NOT NULL DEFAULT 3,

    response_cached BOOLEAN
        NOT NULL DEFAULT true,

    key_expiry_hours INTEGER
        NOT NULL DEFAULT 24,

    created_at TIMESTAMPTZ
        NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_idem_registry_required
ON public.idempotency_endpoint_registry(
    idempotency_required
);

INSERT INTO public.idempotency_endpoint_registry (
    endpoint_name,
    description,
    idempotency_required,
    response_cached
)
VALUES
(
    'create-booking',
    'Create patient booking',
    true,
    true
),
(
    'initiate-refund',
    'Initiate payment refund',
    true,
    true
),
(
    'capture-payment',
    'Capture payment webhook',
    true,
    false
),
(
    'carry-forward-tokens',
    'Carry forward queue',
    true,
    true
),
(
    'send-whatsapp-message',
    'Send WhatsApp message',
    true,
    false
),
(
    'create-settlement',
    'Create settlement',
    true,
    true
),
(
    'advance-queue',
    'Advance queue token',
    false,
    false
),
(
    'update-booking-status',
    'Update booking status',
    false,
    false
),
(
    'register-worker',
    'Register worker instance',
    false,
    false
)
ON CONFLICT (endpoint_name)
DO NOTHING;

-- ============================================================
-- OPTIONAL OPERATIONAL NOTES
-- Only insert if table exists
-- ============================================================

DO $$
BEGIN

    IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'operational_notes'
    ) THEN

        INSERT INTO public.operational_notes (
            category,
            title,
            body
        )
        VALUES (
            'idempotency',
            'Edge Function Idempotency Pattern',
            'All mutating Edge Functions must use the centralized idempotency registry.'
        )
        ON CONFLICT (title)
        DO NOTHING;

    END IF;

END;
$$;

-- ============================================================
-- SAFE POLICY CLEANUP
-- ============================================================

DROP POLICY IF EXISTS idem_keys_self
ON public.api_idempotency_keys;

DROP POLICY IF EXISTS idem_keys_no_direct_write
ON public.api_idempotency_keys;

DROP POLICY IF EXISTS idem_keys_no_direct_update
ON public.api_idempotency_keys;

DROP POLICY IF EXISTS idem_endpoint_registry_read
ON public.idempotency_endpoint_registry;

DROP POLICY IF EXISTS idem_endpoint_registry_manage
ON public.idempotency_endpoint_registry;

-- ============================================================
-- RLS
-- ============================================================

ALTER TABLE public.api_idempotency_keys
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.api_idempotency_keys
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.idempotency_endpoint_registry
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.idempotency_endpoint_registry
FORCE ROW LEVEL SECURITY;

-- ============================================================
-- POLICIES
-- ============================================================

CREATE POLICY idem_keys_self
ON public.api_idempotency_keys
FOR SELECT
USING (
    user_id = auth.uid()
    OR public.is_global_admin()
    OR (
        hospital_id IS NOT NULL
        AND public.current_user_role(hospital_id)
            = 'hospital_admin'
    )
);

CREATE POLICY idem_keys_no_direct_write
ON public.api_idempotency_keys
FOR INSERT
WITH CHECK (false);

CREATE POLICY idem_keys_no_direct_update
ON public.api_idempotency_keys
FOR UPDATE
USING (false);

CREATE POLICY idem_endpoint_registry_read
ON public.idempotency_endpoint_registry
FOR SELECT
USING (
    auth.uid() IS NOT NULL
);

CREATE POLICY idem_endpoint_registry_manage
ON public.idempotency_endpoint_registry
FOR ALL
USING (
    public.is_global_admin()
)
WITH CHECK (
    public.is_global_admin()
);

COMMIT;