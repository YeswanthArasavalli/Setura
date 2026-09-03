-- =============================================================
-- 42_whatsapp_conversational_engine.sql
--
-- Phase 1.1 - WhatsApp-first patient experience.
--
-- Adds the conversational state machine and inbound message
-- bookkeeping that turn SETURA from WhatsApp-notified into
-- WhatsApp-operated:
--
--   * 'received' message status for inbound messages
--   * whatsapp_conversation_states - hospital-scoped,
--     phone-scoped state machine with automatic expiry
--   * record_incoming_whatsapp_message - idempotent inbound
--     persistence + conversation upsert
--   * get/set_conversation_state - TTL-aware state accessors
--   * expire_conversation_states - cron-driven expiry sweep
--   * whatsapp_conversation feature flag (global default ON)
--
-- No existing object is altered destructively; the enum value
-- is additive and all RPCs are new.
-- =============================================================

-- 'received' must exist before inbound rows can be stored.
-- ADD VALUE is additive and backward compatible.
ALTER TYPE public.whatsapp_message_status
ADD VALUE IF NOT EXISTS 'received';

-- =============================================================
-- CONVERSATION STATE MACHINE
-- =============================================================

CREATE TABLE IF NOT EXISTS public.whatsapp_conversation_states (

    id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    conversation_id UUID NOT NULL
        REFERENCES public.whatsapp_conversations(id)
        ON DELETE CASCADE,

    phone_number TEXT NOT NULL,

    state TEXT NOT NULL DEFAULT 'idle'
        CHECK (
            state IN (
                'idle',
                'booking',
                'selecting_doctor',
                'selecting_date',
                'confirming',
                'rescheduling',
                'cancellation',
                'queue_lookup',
                'handoff'
            )
        ),

    -- Flow-scoped working data (patient name, chosen date,
    -- pending booking ids, prompt retries, ...)
    context JSONB NOT NULL DEFAULT '{}'
        CHECK (
            jsonb_typeof(context) = 'object'
        ),

    last_intent TEXT,

    -- Consecutive unrecognized inputs; the engine escalates
    -- to human handoff once the threshold is reached.
    unknown_count INTEGER NOT NULL DEFAULT 0
        CHECK (unknown_count >= 0),

    handoff_reason TEXT,

    -- States expire automatically; expired states behave as
    -- idle and are swept back to idle by the minute cron.
    expires_at TIMESTAMPTZ NOT NULL
        DEFAULT (now() + interval '30 minutes'),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT unique_conversation_state
        UNIQUE (
            hospital_id,
            phone_number
        )
);

CREATE INDEX IF NOT EXISTS idx_conv_states_hospital
ON public.whatsapp_conversation_states(hospital_id);

CREATE INDEX IF NOT EXISTS idx_conv_states_expires
ON public.whatsapp_conversation_states(expires_at)
WHERE state <> 'idle';

DROP TRIGGER IF EXISTS trg_conv_states_updated_at
ON public.whatsapp_conversation_states;

CREATE TRIGGER trg_conv_states_updated_at
BEFORE UPDATE ON public.whatsapp_conversation_states
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_conv_states_hospital_immutable
ON public.whatsapp_conversation_states;

CREATE TRIGGER trg_conv_states_hospital_immutable
BEFORE UPDATE ON public.whatsapp_conversation_states
FOR EACH ROW
EXECUTE FUNCTION public.prevent_hospital_id_update();

-- =============================================================
-- INBOUND MESSAGE RECORDING (idempotent)
-- Persists the incoming message, upserts the conversation,
-- and bumps conversation activity. Meta message ids are unique
-- so webhook replays are natural no-ops.
-- =============================================================

CREATE OR REPLACE FUNCTION public.record_incoming_whatsapp_message(
    p_hospital_id UUID,
    p_phone TEXT,
    p_meta_message_id TEXT,
    p_text TEXT,
    p_patient_name TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_conv_id UUID;
    v_msg_id UUID;
    v_patient_id UUID;
    v_existing UUID;
BEGIN

    -- Idempotency: replays of the same Meta message are no-ops
    IF p_meta_message_id IS NOT NULL AND p_meta_message_id <> '' THEN
        SELECT id
        INTO v_existing
        FROM public.whatsapp_messages
        WHERE whatsapp_message_id = p_meta_message_id
        LIMIT 1;

        IF FOUND THEN
            SELECT conversation_id
            INTO v_conv_id
            FROM public.whatsapp_messages
            WHERE id = v_existing;

            RETURN jsonb_build_object(
                'conversation_id', v_conv_id,
                'message_id', v_existing,
                'is_duplicate', true
            );
        END IF;
    END IF;

    -- Best-effort patient link by normalized phone
    SELECT id
    INTO v_patient_id
    FROM public.patients
    WHERE hospital_id = p_hospital_id
      AND normalized_phone = p_phone
      AND is_deleted = false
    ORDER BY updated_at DESC
    LIMIT 1;

    v_conv_id := public.find_or_create_whatsapp_conversation(
        p_hospital_id,
        v_patient_id,
        p_phone
    );

    INSERT INTO public.whatsapp_messages (
        conversation_id,
        hospital_id,
        patient_id,
        direction,
        message_status,
        whatsapp_message_id,
        message_text,
        idempotency_key,
        sent_at
    )
    VALUES (
        v_conv_id,
        p_hospital_id,
        v_patient_id,
        'incoming',
        'received',
        NULLIF(p_meta_message_id, ''),
        p_text,
        'incoming_' || COALESCE(NULLIF(p_meta_message_id, ''), gen_random_uuid()::text),
        now()
    )
    RETURNING id INTO v_msg_id;

    UPDATE public.whatsapp_conversations
    SET
        latest_message_at = now(),
        unread_count = unread_count + 1,
        patient_id = COALESCE(patient_id, v_patient_id)
    WHERE id = v_conv_id;

    RETURN jsonb_build_object(
        'conversation_id', v_conv_id,
        'message_id', v_msg_id,
        'patient_id', v_patient_id,
        'is_duplicate', false
    );

END;
$$;

ALTER FUNCTION public.record_incoming_whatsapp_message(UUID,TEXT,TEXT,TEXT,TEXT)
SET row_security = off;

-- =============================================================
-- STATE ACCESSORS
-- =============================================================

-- Returns the caller's state row. Expired rows are reset to
-- idle in place before being returned so every consumer sees a
-- consistent view without a separate sweep.
CREATE OR REPLACE FUNCTION public.get_conversation_state(
    p_hospital_id UUID,
    p_phone TEXT
)
RETURNS SETOF public.whatsapp_conversation_states
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

    UPDATE public.whatsapp_conversation_states
    SET
        state = 'idle',
        context = '{}',
        unknown_count = 0,
        handoff_reason = NULL
    WHERE hospital_id = p_hospital_id
      AND phone_number = p_phone
      AND expires_at < now()
      AND state <> 'idle';

    RETURN QUERY
    SELECT *
    FROM public.whatsapp_conversation_states
    WHERE hospital_id = p_hospital_id
      AND phone_number = p_phone;

END;
$$;

ALTER FUNCTION public.get_conversation_state(UUID,TEXT)
SET row_security = off;

-- Upserts the state row for a hospital-scoped phone. TTL keeps
-- conversations from going stale mid-flow.
CREATE OR REPLACE FUNCTION public.set_conversation_state(
    p_hospital_id UUID,
    p_phone TEXT,
    p_state TEXT,
    p_context JSONB DEFAULT '{}',
    p_ttl_minutes INTEGER DEFAULT 30,
    p_last_intent TEXT DEFAULT NULL,
    p_unknown_count INTEGER DEFAULT NULL,
    p_handoff_reason TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_conv_id UUID;
    v_state_id UUID;
BEGIN

    v_conv_id := public.find_or_create_whatsapp_conversation(
        p_hospital_id,
        NULL,
        p_phone
    );

    INSERT INTO public.whatsapp_conversation_states (
        hospital_id,
        conversation_id,
        phone_number,
        state,
        context,
        last_intent,
        unknown_count,
        handoff_reason,
        expires_at
    )
    VALUES (
        p_hospital_id,
        v_conv_id,
        p_phone,
        p_state,
        COALESCE(p_context, '{}'),
        p_last_intent,
        COALESCE(p_unknown_count, 0),
        p_handoff_reason,
        now() + (COALESCE(p_ttl_minutes, 30) || ' minutes')::interval
    )
    ON CONFLICT (hospital_id, phone_number)
    DO UPDATE SET
        state = EXCLUDED.state,
        context = EXCLUDED.context,
        last_intent = COALESCE(EXCLUDED.last_intent,
            public.whatsapp_conversation_states.last_intent),
        unknown_count = COALESCE(p_unknown_count,
            public.whatsapp_conversation_states.unknown_count),
        handoff_reason = EXCLUDED.handoff_reason,
        expires_at = EXCLUDED.expires_at
    RETURNING id INTO v_state_id;

    RETURN v_state_id;

END;
$$;

ALTER FUNCTION public.set_conversation_state(UUID,TEXT,TEXT,JSONB,INTEGER,TEXT,INTEGER,TEXT)
SET row_security = off;

-- =============================================================
-- EXPIRY SWEEP (minute cron)
-- =============================================================

CREATE OR REPLACE FUNCTION public.expire_conversation_states()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INTEGER;
BEGIN

    UPDATE public.whatsapp_conversation_states
    SET
        state = 'idle',
        context = '{}',
        unknown_count = 0,
        handoff_reason = NULL
    WHERE expires_at < now()
      AND state <> 'idle';

    GET DIAGNOSTICS v_count = ROW_COUNT;

    RETURN v_count;

END;
$$;

ALTER FUNCTION public.expire_conversation_states()
SET row_security = off;

-- =============================================================
-- FEATURE FLAG
-- Conversational flows can be disabled per hospital without a
-- deploy; inbound messages then get a polite fallback reply.
-- =============================================================

INSERT INTO public.feature_flags (
    hospital_id,
    flag_key,
    is_enabled,
    metadata
)
VALUES (
    NULL,
    'whatsapp_conversation',
    TRUE,
    '{"display_name":"WhatsApp Conversation","description":"Patients can book, check queue status, reschedule and cancel through WhatsApp."}'::JSONB
)
ON CONFLICT DO NOTHING;

-- =============================================================
-- GRANTS
-- =============================================================

REVOKE ALL ON TABLE public.whatsapp_conversation_states FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE
ON public.whatsapp_conversation_states
TO service_role;
GRANT SELECT
ON public.whatsapp_conversation_states
TO authenticated;

REVOKE ALL ON FUNCTION public.record_incoming_whatsapp_message(UUID,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_incoming_whatsapp_message(UUID,TEXT,TEXT,TEXT,TEXT)
    TO service_role, authenticated;

REVOKE ALL ON FUNCTION public.get_conversation_state(UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_conversation_state(UUID,TEXT)
    TO service_role, authenticated;

REVOKE ALL ON FUNCTION public.set_conversation_state(UUID,TEXT,TEXT,JSONB,INTEGER,TEXT,INTEGER,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_conversation_state(UUID,TEXT,TEXT,JSONB,INTEGER,TEXT,INTEGER,TEXT)
    TO service_role, authenticated;

REVOKE ALL ON FUNCTION public.expire_conversation_states() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expire_conversation_states()
    TO service_role;
