-- =============================================================
-- SETURA HOSPITAL OS
-- Script 14: Dead Letter Queue
-- FINAL PRODUCTION SAFE VERSION
-- =============================================================

BEGIN;

-- =============================================================
-- ENUMS
-- =============================================================

DO $$ BEGIN
    CREATE TYPE public.dead_letter_source AS ENUM (
        'job_queue',
        'whatsapp_message',
        'notification',
        'payment_event',
        'webhook_event',
        'analytics_refresh'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE public.dead_letter_resolution AS ENUM (
        'unresolved',
        'retried_successfully',
        'manually_resolved',
        'discarded'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================
-- DEAD LETTER QUEUE
-- =============================================================

CREATE TABLE IF NOT EXISTS public.dead_letter_queue (

    id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

    hospital_id UUID
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    -- Source tracking
    source public.dead_letter_source NOT NULL,

    source_id UUID NOT NULL,

    source_table TEXT NOT NULL,

    job_type TEXT,

    related_booking_id UUID
        REFERENCES public.bookings(id)
        ON DELETE SET NULL,

    related_patient_id UUID
        REFERENCES public.patients(id)
        ON DELETE SET NULL,

    -- Failure metadata
    attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (attempt_count >= 0),

    last_error TEXT NOT NULL,

    last_error_at TIMESTAMPTZ
        NOT NULL DEFAULT now(),

    first_failed_at TIMESTAMPTZ
        NOT NULL DEFAULT now(),

    payload JSONB NOT NULL DEFAULT '{}'
        CHECK (
            jsonb_typeof(payload)
            IN ('object', 'array')
        ),

    -- Resolution
    resolution public.dead_letter_resolution
        NOT NULL DEFAULT 'unresolved',

    resolved_by UUID
        REFERENCES public.profiles(id)
        ON DELETE SET NULL,

    resolved_at TIMESTAMPTZ,

    resolution_notes TEXT,

    -- Alerting
    is_alertable BOOLEAN NOT NULL DEFAULT true,

    alert_sent BOOLEAN NOT NULL DEFAULT false,

    priority_level TEXT NOT NULL DEFAULT 'medium'
        CHECK (
            priority_level IN (
                'low',
                'medium',
                'high',
                'critical'
            )
        ),

    created_at TIMESTAMPTZ
        NOT NULL DEFAULT now(),

    updated_at TIMESTAMPTZ
        NOT NULL DEFAULT now(),

    -- Prevent duplicate dead-letter storms
    CONSTRAINT unique_active_dead_letter
    UNIQUE (
        source,
        source_id,
        resolution
    )
);

-- =============================================================
-- INDEXES
-- =============================================================

CREATE INDEX IF NOT EXISTS idx_dlq_unresolved
ON public.dead_letter_queue(
    resolution,
    hospital_id,
    created_at DESC
)
WHERE resolution = 'unresolved';

CREATE INDEX IF NOT EXISTS idx_dlq_source
ON public.dead_letter_queue(
    source,
    source_id
);

CREATE INDEX IF NOT EXISTS idx_dlq_alertable
ON public.dead_letter_queue(
    is_alertable,
    alert_sent
)
WHERE is_alertable = true
AND alert_sent = false;

CREATE INDEX IF NOT EXISTS idx_dlq_priority
ON public.dead_letter_queue(
    priority_level,
    created_at DESC
)
WHERE resolution = 'unresolved';

CREATE INDEX IF NOT EXISTS idx_dlq_hospital_created
ON public.dead_letter_queue(
    hospital_id,
    created_at DESC
);

-- =============================================================
-- TRIGGERS
-- =============================================================

DROP TRIGGER IF EXISTS trg_dlq_updated_at
ON public.dead_letter_queue;

CREATE TRIGGER trg_dlq_updated_at
BEFORE UPDATE
ON public.dead_letter_queue
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_dlq_hospital_immutable
BEFORE UPDATE
ON public.dead_letter_queue
FOR EACH ROW
WHEN (OLD.hospital_id IS NOT NULL)
EXECUTE FUNCTION public.prevent_hospital_id_update();

-- =============================================================
-- SEND TO DEAD LETTER
-- Idempotent + race-safe
-- =============================================================

CREATE OR REPLACE FUNCTION public.send_to_dead_letter(
    p_source public.dead_letter_source,
    p_source_id UUID,
    p_source_table TEXT,
    p_job_type TEXT,
    p_hospital_id UUID,
    p_booking_id UUID,
    p_patient_id UUID,
    p_attempt_count INTEGER,
    p_last_error TEXT,
    p_payload JSONB,
    p_priority TEXT DEFAULT 'medium'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id UUID;
BEGIN

    INSERT INTO public.dead_letter_queue (
        hospital_id,
        source,
        source_id,
        source_table,
        job_type,
        related_booking_id,
        related_patient_id,
        attempt_count,
        last_error,
        payload,
        priority_level
    )
    VALUES (
        p_hospital_id,
        p_source,
        p_source_id,
        p_source_table,
        p_job_type,
        p_booking_id,
        p_patient_id,
        p_attempt_count,
        LEFT(p_last_error, 5000),
        COALESCE(p_payload, '{}'),
        p_priority
    )

    ON CONFLICT (
        source,
        source_id,
        resolution
    )

    DO UPDATE SET
        attempt_count = EXCLUDED.attempt_count,
        last_error = EXCLUDED.last_error,
        payload = EXCLUDED.payload,
        updated_at = now(),
        last_error_at = now()

    RETURNING id
    INTO v_id;

    RETURN v_id;

END;
$$;

ALTER FUNCTION public.send_to_dead_letter(
    public.dead_letter_source,
    UUID,
    TEXT,
    TEXT,
    UUID,
    UUID,
    UUID,
    INTEGER,
    TEXT,
    JSONB,
    TEXT
)
SET row_security = off;

-- =============================================================
-- RETRY DEAD LETTER ITEM
-- Multi-worker safe
-- =============================================================

CREATE OR REPLACE FUNCTION public.retry_dead_letter_item(
    p_dlq_id UUID,
    p_resolved_by UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_item RECORD;
BEGIN

    SELECT *
    INTO v_item
    FROM public.dead_letter_queue
    WHERE id = p_dlq_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    IF v_item.resolution <> 'unresolved' THEN
        RETURN FALSE;
    END IF;

    CASE v_item.source

        WHEN 'job_queue' THEN

            PERFORM public.enqueue_job(
                v_item.job_type,
                v_item.payload,
                'high',
                now(),
                'dlq_retry_' || p_dlq_id::text,
                v_item.hospital_id,
                v_item.related_booking_id
            );

        WHEN 'whatsapp_message' THEN

            UPDATE public.whatsapp_messages
            SET
                message_status = 'queued',
                retry_count = 0,
                next_retry_at = NULL,
                error_message = NULL
            WHERE id = v_item.source_id;

        WHEN 'notification' THEN

            UPDATE public.notification_queue
            SET
                status = 'pending',
                retry_count = 0,
                next_retry_at = NULL,
                last_error = NULL,
                scheduled_for = now()
            WHERE id = v_item.source_id;

        ELSE
            NULL;

    END CASE;

    UPDATE public.dead_letter_queue
    SET
        resolution = 'retried_successfully',
        resolved_by = p_resolved_by,
        resolved_at = now(),
        updated_at = now()
    WHERE id = p_dlq_id;

    RETURN TRUE;

END;
$$;

ALTER FUNCTION public.retry_dead_letter_item(UUID,UUID)
SET row_security = off;

-- =============================================================
-- DLQ SUMMARY
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_dlq_summary()
RETURNS TABLE (
    source public.dead_letter_source,
    unresolved_count BIGINT,
    critical_count BIGINT,
    oldest_item_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT

        source,

        COUNT(*)
        FILTER (
            WHERE resolution = 'unresolved'
        ),

        COUNT(*)
        FILTER (
            WHERE resolution = 'unresolved'
            AND priority_level = 'critical'
        ),

        MIN(created_at)
        FILTER (
            WHERE resolution = 'unresolved'
        )

    FROM public.dead_letter_queue

    GROUP BY source;
$$;

ALTER FUNCTION public.get_dlq_summary()
SET row_security = off;

-- =============================================================
-- VIEWS
-- =============================================================

CREATE OR REPLACE VIEW public.dlq_whatsapp_failed AS
SELECT
    dlq.*,
    wm.message_text,
    wm.template_name,
    wc.phone_number,
    b.booking_reference
FROM public.dead_letter_queue dlq
LEFT JOIN public.whatsapp_messages wm
    ON wm.id = dlq.source_id
LEFT JOIN public.whatsapp_conversations wc
    ON wc.id = wm.conversation_id
LEFT JOIN public.bookings b
    ON b.id = dlq.related_booking_id
WHERE dlq.source = 'whatsapp_message'
  AND dlq.resolution = 'unresolved';

CREATE OR REPLACE VIEW public.dlq_notifications_failed AS
SELECT
    dlq.*,
    nq.channel,
    nq.recipient,
    nq.message_body,
    b.booking_reference
FROM public.dead_letter_queue dlq
LEFT JOIN public.notification_queue nq
    ON nq.id = dlq.source_id
LEFT JOIN public.bookings b
    ON b.id = dlq.related_booking_id
WHERE dlq.source = 'notification'
  AND dlq.resolution = 'unresolved';

-- =============================================================
-- ENABLE RLS
-- =============================================================

ALTER TABLE public.dead_letter_queue
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.dead_letter_queue
FORCE ROW LEVEL SECURITY;

-- =============================================================
-- POLICIES
-- =============================================================

DROP POLICY IF EXISTS dlq_global_admin
ON public.dead_letter_queue;

CREATE POLICY dlq_global_admin
ON public.dead_letter_queue
FOR ALL
USING (
    public.is_global_admin()
)
WITH CHECK (
    public.is_global_admin()
);

DROP POLICY IF EXISTS dlq_hospital_admin_read
ON public.dead_letter_queue;

CREATE POLICY dlq_hospital_admin_read
ON public.dead_letter_queue
FOR SELECT
USING (
    hospital_id IS NOT NULL
    AND public.current_user_role(hospital_id)
        = 'hospital_admin'
);

COMMIT;