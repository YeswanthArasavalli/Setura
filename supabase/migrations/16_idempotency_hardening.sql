-- =============================================================
-- SETURA HOSPITAL OS
-- Script 16: Idempotency Hardening
-- FINAL PRODUCTION SAFE VERSION
-- Run AFTER:
--   02_token_engine.sql
--   04_whatsapp_engine.sql
--   05_notification_queue.sql
--   13_payment_engine.sql
-- =============================================================

BEGIN;

-- =============================================================
-- ENUMS
-- =============================================================

DO $$ BEGIN
    CREATE TYPE public.webhook_provider AS ENUM (
        'razorpay',
        'meta_whatsapp',
        'internal'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE public.webhook_processing_status AS ENUM (
        'received',
        'processing',
        'processed',
        'duplicate',
        'failed',
        'ignored'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================
-- WEBHOOK EVENTS
-- Canonical webhook dedupe infrastructure
-- =============================================================

CREATE TABLE IF NOT EXISTS public.webhook_events (

    id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

    provider public.webhook_provider NOT NULL,

    provider_event_id TEXT NOT NULL,

    event_type TEXT NOT NULL,

    payload_hash TEXT NOT NULL,

    duplicate_detected BOOLEAN NOT NULL DEFAULT false,

    duplicate_of UUID
        REFERENCES public.webhook_events(id)
        ON DELETE SET NULL,

    processing_status public.webhook_processing_status
        NOT NULL DEFAULT 'received',

    processing_started_at TIMESTAMPTZ,

    processed_at TIMESTAMPTZ,

    processing_error TEXT,

    processing_attempt INTEGER NOT NULL DEFAULT 0
        CHECK (processing_attempt >= 0),

    raw_payload JSONB NOT NULL
        CHECK (
            jsonb_typeof(raw_payload)
            IN ('object', 'array')
        ),

    hospital_id UUID
        REFERENCES public.hospitals(id)
        ON DELETE SET NULL,

    created_at TIMESTAMPTZ
        NOT NULL DEFAULT now(),

    updated_at TIMESTAMPTZ
        NOT NULL DEFAULT now(),

    CONSTRAINT unique_provider_event
    UNIQUE (
        provider,
        provider_event_id
    )
);

-- =============================================================
-- INDEXES
-- =============================================================

CREATE INDEX IF NOT EXISTS idx_webhook_events_unprocessed
ON public.webhook_events(
    processing_status,
    created_at ASC
)
WHERE processing_status IN (
    'received',
    'failed'
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_hash
ON public.webhook_events(
    payload_hash,
    provider
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_hospital
ON public.webhook_events(
    hospital_id,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_provider_status
ON public.webhook_events(
    provider,
    processing_status,
    created_at
);

-- =============================================================
-- TRIGGERS
-- =============================================================

DROP TRIGGER IF EXISTS trg_webhook_events_updated_at
ON public.webhook_events;

CREATE TRIGGER trg_webhook_events_updated_at
BEFORE UPDATE
ON public.webhook_events
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_webhook_events_hospital_immutable
BEFORE UPDATE
ON public.webhook_events
FOR EACH ROW
WHEN (OLD.hospital_id IS NOT NULL)
EXECUTE FUNCTION public.prevent_hospital_id_update();

-- =============================================================
-- IDEMPOTENT WEBHOOK REGISTRATION
-- =============================================================

CREATE OR REPLACE FUNCTION public.register_webhook_event_v2(
    p_provider              public.webhook_provider,
    p_provider_event_id     TEXT,
    p_event_type            TEXT,
    p_payload_hash          TEXT,
    p_raw_payload           JSONB,
    p_hospital_id           UUID DEFAULT NULL
)
RETURNS TABLE (
    is_new BOOLEAN,
    event_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE

    v_id UUID;

    v_existing_id UUID;

    v_inserted BOOLEAN := false;

BEGIN

    -- =========================================================
    -- HASH DUPLICATE CHECK
    -- =========================================================

    SELECT id
    INTO v_existing_id
    FROM public.webhook_events
    WHERE payload_hash = p_payload_hash
      AND provider = p_provider
    LIMIT 1;

    IF FOUND THEN

        INSERT INTO public.webhook_events (
            provider,
            provider_event_id,
            event_type,
            payload_hash,
            raw_payload,
            hospital_id,
            duplicate_detected,
            duplicate_of,
            processing_status
        )
        VALUES (
            p_provider,
            p_provider_event_id,
            p_event_type,
            p_payload_hash,
            p_raw_payload,
            p_hospital_id,
            true,
            v_existing_id,
            'duplicate'
        )
        ON CONFLICT (
            provider,
            provider_event_id
        )
        DO NOTHING;

        RETURN QUERY
        SELECT false, v_existing_id;

        RETURN;

    END IF;

    -- =========================================================
    -- PRIMARY REGISTRATION
    -- =========================================================

    INSERT INTO public.webhook_events (
        provider,
        provider_event_id,
        event_type,
        payload_hash,
        raw_payload,
        hospital_id
    )
    VALUES (
        p_provider,
        p_provider_event_id,
        p_event_type,
        p_payload_hash,
        p_raw_payload,
        p_hospital_id
    )

    ON CONFLICT (
        provider,
        provider_event_id
    )

    DO UPDATE SET
        duplicate_detected = true,
        processing_attempt =
            public.webhook_events.processing_attempt + 1,
        updated_at = now()

    RETURNING
        id,
        (xmax = 0)
    INTO
        v_id,
        v_inserted;

    RETURN QUERY
    SELECT v_inserted, v_id;

END;
$$;

ALTER FUNCTION public.register_webhook_event_v2(
    public.webhook_provider,
    TEXT,
    TEXT,
    TEXT,
    JSONB,
    UUID
)
SET row_security = off;

-- =============================================================
-- CLAIM WEBHOOK EVENTS
-- Worker-safe using SKIP LOCKED
-- =============================================================

CREATE OR REPLACE FUNCTION public.claim_webhook_event(
    p_provider      public.webhook_provider,
    p_event_types   TEXT[] DEFAULT NULL,
    p_batch_size    INTEGER DEFAULT 5
)
RETURNS SETOF public.webhook_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

    RETURN QUERY

    UPDATE public.webhook_events we

    SET
        processing_status = 'processing',
        processing_started_at = now(),
        processing_attempt = we.processing_attempt + 1,
        updated_at = now()

    WHERE we.id IN (

        SELECT id
        FROM public.webhook_events

        WHERE processing_status IN (
            'received',
            'failed'
        )

        AND provider = p_provider

        AND (
            p_event_types IS NULL
            OR event_type = ANY(p_event_types)
        )

        ORDER BY created_at ASC

        LIMIT p_batch_size

        FOR UPDATE SKIP LOCKED

    )

    RETURNING we.*;

END;
$$;

ALTER FUNCTION public.claim_webhook_event(
    public.webhook_provider,
    TEXT[],
    INTEGER
)
SET row_security = off;

-- =============================================================
-- COMPLETE WEBHOOK
-- =============================================================

CREATE OR REPLACE FUNCTION public.complete_webhook_event(
    p_event_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

    UPDATE public.webhook_events
    SET
        processing_status = 'processed',
        processed_at = now(),
        updated_at = now()
    WHERE id = p_event_id;

    RETURN FOUND;

END;
$$;

ALTER FUNCTION public.complete_webhook_event(UUID)
SET row_security = off;

-- =============================================================
-- FAIL WEBHOOK
-- =============================================================

CREATE OR REPLACE FUNCTION public.fail_webhook_event(
    p_event_id UUID,
    p_error TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

    UPDATE public.webhook_events
    SET

        processing_status = CASE
            WHEN processing_attempt >= 5
            THEN 'failed'
            ELSE 'received'
        END,

        processing_error = LEFT(p_error, 5000),

        updated_at = now()

    WHERE id = p_event_id;

    RETURN FOUND;

END;
$$;

ALTER FUNCTION public.fail_webhook_event(UUID,TEXT)
SET row_security = off;

-- =============================================================
-- IDEMPOTENT PAYMENT CAPTURE
-- =============================================================

CREATE OR REPLACE FUNCTION public.idempotent_capture_payment(
    p_provider_event_id     TEXT,
    p_payload_hash          TEXT,
    p_raw_payload           JSONB,
    p_gateway_order_id      TEXT,
    p_gateway_payment_id    TEXT,
    p_gateway_signature     TEXT
)
RETURNS TABLE (
    success BOOLEAN,
    was_duplicate BOOLEAN,
    message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE

    v_is_new BOOLEAN;

    v_event_id UUID;

BEGIN

    -- =========================================================
    -- IDEMPOTENCY GATE
    -- =========================================================

    SELECT
        r.is_new,
        r.event_id
    INTO
        v_is_new,
        v_event_id

    FROM public.register_webhook_event_v2(
        'razorpay',
        p_provider_event_id,
        'payment.captured',
        p_payload_hash,
        p_raw_payload
    ) r;

    IF NOT v_is_new THEN

        RETURN QUERY
        SELECT
            false,
            true,
            'Duplicate webhook already processed';

        RETURN;

    END IF;

    -- =========================================================
    -- PROCESSING CLAIM
    -- =========================================================

    UPDATE public.webhook_events
    SET
        processing_status = 'processing',
        processing_started_at = now(),
        updated_at = now()
    WHERE id = v_event_id;

    -- =========================================================
    -- CAPTURE
    -- =========================================================

    BEGIN

        PERFORM public.capture_payment(
            p_gateway_order_id,
            p_gateway_payment_id,
            p_gateway_signature,
            p_raw_payload
        );

        PERFORM public.complete_webhook_event(
            v_event_id
        );

        RETURN QUERY
        SELECT
            true,
            false,
            'Payment captured successfully';

    EXCEPTION
        WHEN OTHERS THEN

            PERFORM public.fail_webhook_event(
                v_event_id,
                SQLERRM
            );

            RETURN QUERY
            SELECT
                false,
                false,
                'Payment capture failed: ' || SQLERRM;

    END;

END;
$$;

ALTER FUNCTION public.idempotent_capture_payment(
    TEXT,
    TEXT,
    JSONB,
    TEXT,
    TEXT,
    TEXT
)
SET row_security = off;

-- =============================================================
-- BOOKINGS: CLIENT REQUEST ID
-- =============================================================

DO $$
BEGIN

    IF NOT EXISTS (

        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'bookings'
          AND column_name = 'client_request_id'

    ) THEN

        ALTER TABLE public.bookings
        ADD COLUMN client_request_id TEXT;

    END IF;

END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_client_request_id
ON public.bookings(client_request_id)
WHERE client_request_id IS NOT NULL;

-- =============================================================
-- IDEMPOTENT BOOKING CREATION
-- =============================================================

CREATE OR REPLACE FUNCTION public.idempotent_create_booking(
    p_client_request_id     TEXT,
    p_hospital_id           UUID,
    p_queue_session_id      UUID,
    p_patient_id            UUID,
    p_patient_name          TEXT,
    p_patient_phone         TEXT,
    p_patient_age           INTEGER,
    p_patient_gender        TEXT,
    p_village               TEXT,
    p_blood_group           TEXT,
    p_has_diabetes          BOOLEAN,
    p_has_bp                BOOLEAN,
    p_booking_source        public.booking_source,
    p_doctor_id             UUID,
    p_booked_by             UUID,
    p_appointment_date      DATE
)
RETURNS TABLE (
    booking_id UUID,
    token_number INTEGER,
    was_duplicate BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE

    v_existing_id UUID;

    v_existing_token INTEGER;

    v_fees RECORD;

    v_new_id UUID;

    v_new_token INTEGER;

BEGIN

    -- =========================================================
    -- DUPLICATE CHECK
    -- =========================================================

    SELECT
        b.id,
        b.token_number
    INTO
        v_existing_id,
        v_existing_token

    FROM public.bookings b

    WHERE b.client_request_id =
        p_client_request_id;

    IF FOUND THEN

        RETURN QUERY
        SELECT
            v_existing_id,
            v_existing_token,
            true;

        RETURN;

    END IF;

    -- =========================================================
    -- FEE RESOLUTION
    -- =========================================================

    SELECT
        f.platform_fee,
        f.receptionist_fee,
        f.hospital_fee,
        f.total_amount

    INTO v_fees

    FROM public.get_effective_fees(
        p_hospital_id,
        p_booking_source
    ) f;

    -- =========================================================
    -- BOOKING CREATION
    -- =========================================================

    SELECT
        r.booking_id,
        r.token_number

    INTO
        v_new_id,
        v_new_token

    FROM public.create_booking(

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

        p_booking_source,

        p_doctor_id,
        p_booked_by,

        p_appointment_date,

        v_fees.platform_fee,
        v_fees.receptionist_fee,
        v_fees.hospital_fee,

        p_client_request_id

    ) r;

    -- =========================================================
    -- STORE CLIENT REQUEST ID
    -- =========================================================

    UPDATE public.bookings
    SET
        client_request_id =
            p_client_request_id
    WHERE id = v_new_id;

    RETURN QUERY
    SELECT
        v_new_id,
        v_new_token,
        false;

END;
$$;

ALTER FUNCTION public.idempotent_create_booking(
    TEXT,
    UUID,
    UUID,
    UUID,
    TEXT,
    TEXT,
    INTEGER,
    TEXT,
    TEXT,
    TEXT,
    BOOLEAN,
    BOOLEAN,
    public.booking_source,
    UUID,
    UUID,
    DATE
)
SET row_security = off;

-- =============================================================
-- ENABLE RLS
-- =============================================================

ALTER TABLE public.webhook_events
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.webhook_events
FORCE ROW LEVEL SECURITY;

-- =============================================================
-- POLICIES
-- =============================================================

DROP POLICY IF EXISTS webhook_events_global_admin
ON public.webhook_events;

CREATE POLICY webhook_events_global_admin
ON public.webhook_events
FOR ALL
USING (
    public.is_global_admin()
)
WITH CHECK (
    public.is_global_admin()
);

DROP POLICY IF EXISTS webhook_events_hospital_admin
ON public.webhook_events;

CREATE POLICY webhook_events_hospital_admin
ON public.webhook_events
FOR SELECT
USING (
    hospital_id IS NOT NULL
    AND public.current_user_role(hospital_id)
        = 'hospital_admin'
);

COMMIT;