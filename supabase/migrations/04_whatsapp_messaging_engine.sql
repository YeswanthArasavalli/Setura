-- =============================================================
-- SETURA HOSPITAL OS
-- Script 04: WhatsApp Messaging Engine
-- PRODUCTION SAFE VERSION
-- Run AFTER Script 03
-- =============================================================

-- =============================================================
-- ENUMS
-- =============================================================

DO $$
BEGIN
    CREATE TYPE public.whatsapp_message_status AS ENUM (
        'queued',
        'processing',
        'sent',
        'delivered',
        'read',
        'failed',
        'retrying',
        'permanently_failed'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    CREATE TYPE public.whatsapp_message_direction AS ENUM (
        'incoming',
        'outgoing'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    CREATE TYPE public.whatsapp_template_category AS ENUM (
        'utility',
        'marketing',
        'authentication'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================
-- WHATSAPP TEMPLATES
-- =============================================================

CREATE TABLE IF NOT EXISTS public.whatsapp_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    template_name TEXT NOT NULL,

    meta_template_name TEXT NOT NULL,

    category public.whatsapp_template_category
        NOT NULL,

    language_code TEXT NOT NULL DEFAULT 'en',

    template_body TEXT NOT NULL,

    variables JSONB NOT NULL DEFAULT '[]'
        CHECK (
            jsonb_typeof(variables) = 'array'
        ),

    is_active BOOLEAN NOT NULL DEFAULT true,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT unique_template_per_scope
        UNIQUE (
            hospital_id,
            meta_template_name,
            language_code
        )
);

CREATE INDEX IF NOT EXISTS idx_wa_templates_lookup
ON public.whatsapp_templates(
    hospital_id,
    is_active
);

DROP TRIGGER IF EXISTS trg_wa_templates_updated_at
ON public.whatsapp_templates;

CREATE TRIGGER trg_wa_templates_updated_at
BEFORE UPDATE ON public.whatsapp_templates
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- =============================================================
-- CONVERSATIONS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.whatsapp_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    patient_id UUID
        REFERENCES public.patients(id)
        ON DELETE SET NULL,

    phone_number TEXT NOT NULL,

    latest_message_at TIMESTAMPTZ,

    unread_count INTEGER NOT NULL DEFAULT 0
        CHECK (unread_count >= 0),

    is_blocked BOOLEAN NOT NULL DEFAULT false,

    metadata JSONB NOT NULL DEFAULT '{}'
        CHECK (
            jsonb_typeof(metadata) = 'object'
        ),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT unique_conversation_phone
        UNIQUE (
            hospital_id,
            phone_number
        )
);

CREATE INDEX IF NOT EXISTS idx_wa_conversations_hospital
ON public.whatsapp_conversations(hospital_id);

CREATE INDEX IF NOT EXISTS idx_wa_conversations_latest
ON public.whatsapp_conversations(
    hospital_id,
    latest_message_at DESC
);

DROP TRIGGER IF EXISTS trg_wa_conversations_updated_at
ON public.whatsapp_conversations;

CREATE TRIGGER trg_wa_conversations_updated_at
BEFORE UPDATE ON public.whatsapp_conversations
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_wa_conversations_hospital_immutable
ON public.whatsapp_conversations;

CREATE TRIGGER trg_wa_conversations_hospital_immutable
BEFORE UPDATE ON public.whatsapp_conversations
FOR EACH ROW
EXECUTE FUNCTION public.prevent_hospital_id_update();

-- =============================================================
-- WHATSAPP MESSAGES
-- =============================================================

CREATE TABLE IF NOT EXISTS public.whatsapp_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    conversation_id UUID NOT NULL
        REFERENCES public.whatsapp_conversations(id)
        ON DELETE CASCADE,

    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    patient_id UUID
        REFERENCES public.patients(id)
        ON DELETE SET NULL,

    related_booking_id UUID
        REFERENCES public.bookings(id)
        ON DELETE SET NULL,

    direction public.whatsapp_message_direction
        NOT NULL,

    message_status public.whatsapp_message_status
        NOT NULL DEFAULT 'queued',

    whatsapp_message_id TEXT UNIQUE,

    template_name TEXT,

    template_language TEXT NOT NULL DEFAULT 'en',

    message_text TEXT,

    media_url TEXT,

    error_message TEXT,

    sent_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    read_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,

    retry_count INTEGER NOT NULL DEFAULT 0
        CHECK (retry_count >= 0),

    max_retries INTEGER NOT NULL DEFAULT 5
        CHECK (max_retries BETWEEN 0 AND 20),

    next_retry_at TIMESTAMPTZ,

    processing_started_at TIMESTAMPTZ,

    idempotency_key TEXT UNIQUE,

    metadata JSONB NOT NULL DEFAULT '{}'
        CHECK (
            jsonb_typeof(metadata) = 'object'
        ),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wa_messages_conversation
ON public.whatsapp_messages(
    conversation_id,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_wa_messages_booking
ON public.whatsapp_messages(
    related_booking_id
);

CREATE INDEX IF NOT EXISTS idx_wa_messages_processing
ON public.whatsapp_messages(
    message_status,
    next_retry_at
);

CREATE INDEX IF NOT EXISTS idx_wa_messages_hospital_created
ON public.whatsapp_messages(
    hospital_id,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_wa_messages_worker_fetch
ON public.whatsapp_messages(
    message_status,
    created_at
)
WHERE message_status IN (
    'queued',
    'retrying'
);

DROP TRIGGER IF EXISTS trg_wa_messages_hospital_immutable
ON public.whatsapp_messages;

CREATE TRIGGER trg_wa_messages_hospital_immutable
BEFORE UPDATE ON public.whatsapp_messages
FOR EACH ROW
EXECUTE FUNCTION public.prevent_hospital_id_update();

-- =============================================================
-- DELIVERY LOGS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.whatsapp_delivery_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    whatsapp_message_id UUID NOT NULL
        REFERENCES public.whatsapp_messages(id)
        ON DELETE CASCADE,

    delivery_status public.whatsapp_message_status
        NOT NULL,

    meta_event_id TEXT,

    payload JSONB NOT NULL DEFAULT '{}'
        CHECK (
            jsonb_typeof(payload) = 'object'
        ),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wa_delivery_logs_message
ON public.whatsapp_delivery_logs(
    whatsapp_message_id,
    created_at DESC
);

-- =============================================================
-- WEBHOOK EVENTS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.whatsapp_webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    webhook_event_id TEXT UNIQUE NOT NULL,

    event_type TEXT NOT NULL,

    payload JSONB NOT NULL,

    processed BOOLEAN NOT NULL DEFAULT false,

    processed_at TIMESTAMPTZ,

    processing_error TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wa_webhooks_unprocessed
ON public.whatsapp_webhook_events(
    processed,
    created_at
)
WHERE processed = false;

-- =============================================================
-- FIND OR CREATE CONVERSATION
-- =============================================================

CREATE OR REPLACE FUNCTION public.find_or_create_whatsapp_conversation(
    p_hospital_id UUID,
    p_patient_id UUID,
    p_phone TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_phone TEXT;
    v_id UUID;
BEGIN

    v_phone :=
        regexp_replace(
            p_phone,
            '[^0-9]',
            '',
            'g'
        );

    INSERT INTO public.whatsapp_conversations (
        hospital_id,
        patient_id,
        phone_number,
        latest_message_at
    )
    VALUES (
        p_hospital_id,
        p_patient_id,
        v_phone,
        now()
    )
    ON CONFLICT (
        hospital_id,
        phone_number
    )
    DO UPDATE
    SET
        latest_message_at = now(),
        updated_at = now(),
        patient_id = COALESCE(
            whatsapp_conversations.patient_id,
            EXCLUDED.patient_id
        )
    RETURNING id INTO v_id;

    RETURN v_id;

END;
$$;

ALTER FUNCTION public.find_or_create_whatsapp_conversation(UUID,UUID,TEXT)
SET row_security = off;

-- =============================================================
-- QUEUE MESSAGE
-- =============================================================

CREATE OR REPLACE FUNCTION public.queue_whatsapp_message(
    p_hospital_id UUID,
    p_patient_id UUID,
    p_booking_id UUID,
    p_phone TEXT,
    p_template_name TEXT,
    p_message_text TEXT,
    p_idempotency_key TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_conv_id UUID;
    v_msg_id UUID;
BEGIN

    SELECT id
    INTO v_msg_id
    FROM public.whatsapp_messages
    WHERE idempotency_key = p_idempotency_key;

    IF FOUND THEN
        RETURN v_msg_id;
    END IF;

    v_conv_id :=
        public.find_or_create_whatsapp_conversation(
            p_hospital_id,
            p_patient_id,
            p_phone
        );

    INSERT INTO public.whatsapp_messages (
        conversation_id,
        hospital_id,
        patient_id,
        related_booking_id,
        direction,
        template_name,
        message_text,
        idempotency_key
    )
    VALUES (
        v_conv_id,
        p_hospital_id,
        p_patient_id,
        p_booking_id,
        'outgoing',
        p_template_name,
        p_message_text,
        p_idempotency_key
    )
    RETURNING id INTO v_msg_id;

    RETURN v_msg_id;

END;
$$;

ALTER FUNCTION public.queue_whatsapp_message(UUID,UUID,UUID,TEXT,TEXT,TEXT,TEXT)
SET row_security = off;

-- =============================================================
-- FETCH PENDING WORKER BATCH
-- =============================================================

CREATE OR REPLACE FUNCTION public.fetch_pending_whatsapp_messages(
    p_limit INTEGER DEFAULT 50
)
RETURNS SETOF public.whatsapp_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

    RETURN QUERY

    UPDATE public.whatsapp_messages wm
    SET
        message_status = 'processing',
        processing_started_at = now()
    WHERE wm.id IN (

        SELECT id
        FROM public.whatsapp_messages
        WHERE (
            message_status = 'queued'
            OR (
                message_status = 'retrying'
                AND next_retry_at <= now()
            )
        )
        ORDER BY created_at
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED

    )

    RETURNING *;

END;
$$;

ALTER FUNCTION public.fetch_pending_whatsapp_messages(INTEGER)
SET row_security = off;

-- =============================================================
-- HANDLE DELIVERY STATUS
-- =============================================================

CREATE OR REPLACE FUNCTION public.handle_whatsapp_delivery_status(
    p_meta_message_id TEXT,
    p_status public.whatsapp_message_status,
    p_payload JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_msg RECORD;
BEGIN

    SELECT *
    INTO v_msg
    FROM public.whatsapp_messages
    WHERE whatsapp_message_id = p_meta_message_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    IF v_msg.message_status IN (
        'read',
        'permanently_failed'
    ) THEN
        RETURN TRUE;
    END IF;

    UPDATE public.whatsapp_messages
    SET
        message_status = p_status,

        delivered_at =
            CASE
                WHEN p_status = 'delivered'
                AND delivered_at IS NULL
                THEN now()
                ELSE delivered_at
            END,

        read_at =
            CASE
                WHEN p_status = 'read'
                AND read_at IS NULL
                THEN now()
                ELSE read_at
            END,

        failed_at =
            CASE
                WHEN p_status = 'failed'
                AND failed_at IS NULL
                THEN now()
                ELSE failed_at
            END

    WHERE id = v_msg.id;

    INSERT INTO public.whatsapp_delivery_logs (
        whatsapp_message_id,
        delivery_status,
        meta_event_id,
        payload
    )
    VALUES (
        v_msg.id,
        p_status,
        p_meta_message_id,
        p_payload
    );

    RETURN TRUE;

END;
$$;

ALTER FUNCTION public.handle_whatsapp_delivery_status(TEXT,public.whatsapp_message_status,JSONB)
SET row_security = off;

-- =============================================================
-- RETRY ENGINE
-- =============================================================

CREATE OR REPLACE FUNCTION public.schedule_whatsapp_retry(
    p_message_id UUID,
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
    FROM public.whatsapp_messages
    WHERE id = p_message_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    IF v_retry_count >= v_max_retries THEN

        UPDATE public.whatsapp_messages
        SET
            message_status = 'permanently_failed',
            error_message = p_error,
            failed_at = now()
        WHERE id = p_message_id;

        RETURN FALSE;

    END IF;

    UPDATE public.whatsapp_messages
    SET
        retry_count = retry_count + 1,
        message_status = 'retrying',
        error_message = p_error,
        next_retry_at =
            now()
            +
            make_interval(
                mins => LEAST(
                    POWER(2, v_retry_count)::INTEGER,
                    1440
                )
            )
    WHERE id = p_message_id;

    RETURN TRUE;

END;
$$;

ALTER FUNCTION public.schedule_whatsapp_retry(UUID,TEXT)
SET row_security = off;

-- =============================================================
-- WEBHOOK DEDUPE
-- =============================================================

CREATE OR REPLACE FUNCTION public.register_webhook_event(
    p_webhook_event_id TEXT,
    p_event_type TEXT,
    p_payload JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_inserted INTEGER;
BEGIN

    INSERT INTO public.whatsapp_webhook_events (
        webhook_event_id,
        event_type,
        payload
    )
    VALUES (
        p_webhook_event_id,
        p_event_type,
        p_payload
    )
    ON CONFLICT (webhook_event_id)
    DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    RETURN v_inserted > 0;

END;
$$;

ALTER FUNCTION public.register_webhook_event(TEXT,TEXT,JSONB)
SET row_security = off;

-- =============================================================
-- REALTIME
-- =============================================================

DO $$
BEGIN

    BEGIN
        ALTER PUBLICATION supabase_realtime
        ADD TABLE public.whatsapp_messages;
    EXCEPTION
        WHEN duplicate_object THEN NULL;
    END;

    BEGIN
        ALTER PUBLICATION supabase_realtime
        ADD TABLE public.whatsapp_conversations;
    EXCEPTION
        WHEN duplicate_object THEN NULL;
    END;

END $$;

-- =============================================================
-- ENABLE RLS
-- =============================================================

ALTER TABLE public.whatsapp_templates
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.whatsapp_conversations
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.whatsapp_messages
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.whatsapp_delivery_logs
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.whatsapp_webhook_events
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.whatsapp_templates
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.whatsapp_conversations
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.whatsapp_messages
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.whatsapp_delivery_logs
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.whatsapp_webhook_events
FORCE ROW LEVEL SECURITY;

-- =============================================================
-- TEMPLATE POLICIES
-- =============================================================

DROP POLICY IF EXISTS wa_templates_read
ON public.whatsapp_templates;

CREATE POLICY wa_templates_read
ON public.whatsapp_templates
FOR SELECT
USING (
    hospital_id IS NULL
    OR public.is_global_admin()
    OR public.user_has_hospital_access(
        hospital_id
    )
);

-- =============================================================
-- CONVERSATION POLICIES
-- =============================================================

DROP POLICY IF EXISTS wa_conversations_read
ON public.whatsapp_conversations;

CREATE POLICY wa_conversations_read
ON public.whatsapp_conversations
FOR SELECT
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        IN (
            'hospital_admin',
            'receptionist'
        )
);

CREATE POLICY wa_conversations_manage
ON public.whatsapp_conversations
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
-- MESSAGE POLICIES
-- =============================================================

DROP POLICY IF EXISTS wa_messages_read
ON public.whatsapp_messages;

CREATE POLICY wa_messages_read
ON public.whatsapp_messages
FOR SELECT
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        IN (
            'hospital_admin',
            'receptionist'
        )
);

-- =============================================================
-- WEBHOOK POLICIES
-- =============================================================

DROP POLICY IF EXISTS wa_webhooks_admin
ON public.whatsapp_webhook_events;

CREATE POLICY wa_webhooks_admin
ON public.whatsapp_webhook_events
FOR ALL
USING (
    public.is_global_admin()
)
WITH CHECK (
    public.is_global_admin()
);