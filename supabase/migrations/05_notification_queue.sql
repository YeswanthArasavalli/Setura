-- =============================================================
-- SETURA HOSPITAL OS
-- Script 05: Notification Queue
-- PRODUCTION SAFE VERSION
-- Run AFTER Script 04
-- =============================================================

-- =============================================================
-- ENUMS
-- =============================================================

DO $$
BEGIN
    CREATE TYPE public.notification_channel AS ENUM (
        'whatsapp',
        'sms',
        'push',
        'email',
        'internal'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    CREATE TYPE public.notification_status AS ENUM (
        'pending',
        'queued',
        'processing',
        'sent',
        'delivered',
        'read',
        'failed',
        'retrying',
        'cancelled',
        'permanently_failed'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    CREATE TYPE public.notification_priority AS ENUM (
        'low',
        'medium',
        'high',
        'critical'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================
-- NOTIFICATION TEMPLATES
-- =============================================================

CREATE TABLE IF NOT EXISTS public.notification_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    template_key TEXT NOT NULL,

    template_name TEXT NOT NULL,

    channel public.notification_channel
        NOT NULL,

    language_code TEXT NOT NULL DEFAULT 'en',

    subject TEXT,

    body_template TEXT NOT NULL,

    variables JSONB NOT NULL DEFAULT '[]'
        CHECK (
            jsonb_typeof(variables) = 'array'
        ),

    is_active BOOLEAN NOT NULL DEFAULT true,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT unique_notification_template
        UNIQUE (
            hospital_id,
            template_key,
            channel,
            language_code
        )
);

CREATE INDEX IF NOT EXISTS idx_notification_templates_lookup
ON public.notification_templates(
    hospital_id,
    channel,
    is_active
);

DROP TRIGGER IF EXISTS trg_notification_templates_updated_at
ON public.notification_templates;

CREATE TRIGGER trg_notification_templates_updated_at
BEFORE UPDATE ON public.notification_templates
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- =============================================================
-- NOTIFICATION QUEUE
-- =============================================================

CREATE TABLE IF NOT EXISTS public.notification_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    patient_id UUID
        REFERENCES public.patients(id)
        ON DELETE SET NULL,

    booking_id UUID
        REFERENCES public.bookings(id)
        ON DELETE SET NULL,

    channel public.notification_channel
        NOT NULL,

    priority public.notification_priority
        NOT NULL DEFAULT 'medium',

    status public.notification_status
        NOT NULL DEFAULT 'pending',

    recipient TEXT NOT NULL,

    template_key TEXT,

    title TEXT,

    message_body TEXT NOT NULL,

    metadata JSONB NOT NULL DEFAULT '{}'
        CHECK (
            jsonb_typeof(metadata) = 'object'
        ),

    idempotency_key TEXT UNIQUE,

    scheduled_for TIMESTAMPTZ NOT NULL DEFAULT now(),

    sent_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,

    retry_count INTEGER NOT NULL DEFAULT 0
        CHECK (retry_count >= 0),

    max_retries INTEGER NOT NULL DEFAULT 5
        CHECK (max_retries BETWEEN 0 AND 20),

    next_retry_at TIMESTAMPTZ,

    processing_started_at TIMESTAMPTZ,

    last_error TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_queue_worker
ON public.notification_queue(
    status,
    scheduled_for,
    priority,
    created_at
)
WHERE status IN (
    'pending',
    'queued',
    'retrying'
);

CREATE INDEX IF NOT EXISTS idx_notification_queue_retry
ON public.notification_queue(
    next_retry_at
)
WHERE status = 'retrying';

CREATE INDEX IF NOT EXISTS idx_notification_queue_hospital
ON public.notification_queue(
    hospital_id,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_notification_queue_booking
ON public.notification_queue(
    booking_id
);

DROP TRIGGER IF EXISTS trg_notification_queue_updated_at
ON public.notification_queue;

CREATE TRIGGER trg_notification_queue_updated_at
BEFORE UPDATE ON public.notification_queue
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_notification_queue_hospital_immutable
ON public.notification_queue;

CREATE TRIGGER trg_notification_queue_hospital_immutable
BEFORE UPDATE ON public.notification_queue
FOR EACH ROW
EXECUTE FUNCTION public.prevent_hospital_id_update();

-- =============================================================
-- DELIVERY LOGS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.notification_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    notification_id UUID NOT NULL
        REFERENCES public.notification_queue(id)
        ON DELETE CASCADE,

    delivery_status public.notification_status
        NOT NULL,

    provider_response JSONB NOT NULL DEFAULT '{}'
        CHECK (
            jsonb_typeof(provider_response) = 'object'
        ),

    delivered_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_notification
ON public.notification_deliveries(
    notification_id,
    created_at DESC
);

-- =============================================================
-- QUEUE NOTIFICATION
-- =============================================================

CREATE OR REPLACE FUNCTION public.queue_notification(
    p_hospital_id UUID,
    p_patient_id UUID,
    p_booking_id UUID,
    p_channel public.notification_channel,
    p_priority public.notification_priority,
    p_recipient TEXT,
    p_template_key TEXT,
    p_title TEXT,
    p_message_body TEXT,
    p_scheduled_for TIMESTAMPTZ,
    p_idempotency_key TEXT,
    p_metadata JSONB DEFAULT '{}'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_notification_id UUID;
BEGIN

    SELECT id
    INTO v_notification_id
    FROM public.notification_queue
    WHERE idempotency_key = p_idempotency_key;

    IF FOUND THEN
        RETURN v_notification_id;
    END IF;

    INSERT INTO public.notification_queue (
        hospital_id,
        patient_id,
        booking_id,
        channel,
        priority,
        recipient,
        template_key,
        title,
        message_body,
        metadata,
        scheduled_for,
        idempotency_key
    )
    VALUES (
        p_hospital_id,
        p_patient_id,
        p_booking_id,
        p_channel,
        COALESCE(p_priority, 'medium'),
        lower(trim(p_recipient)),
        p_template_key,
        p_title,
        p_message_body,
        COALESCE(p_metadata, '{}'),
        COALESCE(p_scheduled_for, now()),
        p_idempotency_key
    )
    RETURNING id INTO v_notification_id;

    RETURN v_notification_id;

END;
$$;

ALTER FUNCTION public.queue_notification(
    UUID,
    UUID,
    UUID,
    public.notification_channel,
    public.notification_priority,
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    TIMESTAMPTZ,
    TEXT,
    JSONB
)
SET row_security = off;

-- =============================================================
-- FETCH PENDING NOTIFICATIONS
-- Worker-safe using SKIP LOCKED
-- =============================================================

CREATE OR REPLACE FUNCTION public.fetch_pending_notifications(
    p_limit INTEGER DEFAULT 100
)
RETURNS SETOF public.notification_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

    RETURN QUERY

    UPDATE public.notification_queue nq
    SET
        status = 'processing',
        processing_started_at = now()
    WHERE nq.id IN (

        SELECT id
        FROM public.notification_queue
        WHERE (
            (
                status IN ('pending', 'queued')
                AND scheduled_for <= now()
            )
            OR (
                status = 'retrying'
                AND next_retry_at <= now()
            )
        )
        ORDER BY
            CASE priority
                WHEN 'critical' THEN 1
                WHEN 'high' THEN 2
                WHEN 'medium' THEN 3
                ELSE 4
            END,
            created_at
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED

    )

    RETURNING *;

END;
$$;

ALTER FUNCTION public.fetch_pending_notifications(INTEGER)
SET row_security = off;

-- =============================================================
-- MARK NOTIFICATION SENT
-- =============================================================

CREATE OR REPLACE FUNCTION public.mark_notification_sent(
    p_notification_id UUID,
    p_provider_response JSONB DEFAULT '{}'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

    UPDATE public.notification_queue
    SET
        status = 'sent',
        sent_at = now(),
        last_error = NULL
    WHERE id = p_notification_id;

    INSERT INTO public.notification_deliveries (
        notification_id,
        delivery_status,
        provider_response,
        delivered_at
    )
    VALUES (
        p_notification_id,
        'sent',
        COALESCE(p_provider_response, '{}'),
        now()
    );

    RETURN FOUND;

END;
$$;

ALTER FUNCTION public.mark_notification_sent(UUID,JSONB)
SET row_security = off;

-- =============================================================
-- SCHEDULE RETRY
-- =============================================================

CREATE OR REPLACE FUNCTION public.schedule_notification_retry(
    p_notification_id UUID,
    p_error TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_retry_count INTEGER;
    v_max_retries INTEGER;
BEGIN

    SELECT
        retry_count,
        max_retries
    INTO
        v_retry_count,
        v_max_retries
    FROM public.notification_queue
    WHERE id = p_notification_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    IF v_retry_count >= v_max_retries THEN

        UPDATE public.notification_queue
        SET
            status = 'permanently_failed',
            failed_at = now(),
            last_error = p_error
        WHERE id = p_notification_id;

        RETURN FALSE;

    END IF;

    UPDATE public.notification_queue
    SET
        retry_count = retry_count + 1,
        status = 'retrying',
        last_error = p_error,
        next_retry_at =
            now()
            +
            make_interval(
                mins => LEAST(
                    POWER(2, v_retry_count)::INTEGER,
                    1440
                )
            )
    WHERE id = p_notification_id;

    RETURN TRUE;

END;
$$;

ALTER FUNCTION public.schedule_notification_retry(UUID,TEXT)
SET row_security = off;

-- =============================================================
-- ENABLE RLS
-- =============================================================

ALTER TABLE public.notification_templates
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.notification_queue
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.notification_deliveries
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.notification_templates
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.notification_queue
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.notification_deliveries
FORCE ROW LEVEL SECURITY;

-- =============================================================
-- TEMPLATE POLICIES
-- =============================================================

DROP POLICY IF EXISTS notif_templates_read
ON public.notification_templates;

CREATE POLICY notif_templates_read
ON public.notification_templates
FOR SELECT
USING (
    hospital_id IS NULL
    OR public.is_global_admin()
    OR public.user_has_hospital_access(
        hospital_id
    )
);

-- =============================================================
-- QUEUE POLICIES
-- =============================================================

DROP POLICY IF EXISTS notif_queue_admin
ON public.notification_queue;

CREATE POLICY notif_queue_admin
ON public.notification_queue
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

-- =============================================================
-- DELIVERY POLICIES
-- =============================================================

CREATE POLICY notif_deliveries_read
ON public.notification_deliveries
FOR SELECT
USING (
    public.is_global_admin()
    OR EXISTS (
        SELECT 1
        FROM public.notification_queue nq
        WHERE nq.id = notification_deliveries.notification_id
        AND public.current_user_role(nq.hospital_id)
            IN (
                'hospital_admin',
                'receptionist'
            )
    )
);