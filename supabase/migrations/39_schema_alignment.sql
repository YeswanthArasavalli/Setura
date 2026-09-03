-- =====================================================================
-- Migration 39: Schema / type alignment for Edge Functions
-- =====================================================================
-- Aligns the SQL surface with the regenerated TypeScript types:
--
--   1. NEW stop_worker(p_worker_id, p_drain)
--      Called by _shared/worker.ts on graceful shutdown.
--
--   2. NEW recalculate_queue_position(p_booking_id)
--      Called by cancel-booking to refresh wait estimates after a
--      cancellation frees a queue slot.
--
--   3. CREATE OR REPLACE create_booking
--      Body unchanged from migration 02. Adds DEFAULT NULL to every
--      parameter after the first defaulted one (PostgreSQL requires
--      trailing defaults). The signature and parameter order are
--      unchanged, so idempotent_create_booking's positional call is
--      unaffected. Required-ness stays enforced by the API validation
--      schema.
--
--   4. CREATE OR REPLACE write_audit_log
--      Body unchanged from migration 36. Adds DEFAULT NULL to
--      p_hospital_id and p_entity_id (both are genuinely optional:
--      system-level events have no hospital, some events have no
--      entity id).
--
--   5. Registers the 'payment_order_created' audit action used by
--      create-payment-order.
-- =====================================================================

-- ============================================================
-- 1. STOP WORKER
-- ============================================================

CREATE OR REPLACE FUNCTION public.stop_worker(
    p_worker_id TEXT,
    p_drain BOOLEAN DEFAULT false
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

    IF p_drain THEN
        -- Keep the lease alive so in-flight jobs finish; the worker
        -- simply stops claiming new jobs.
        UPDATE public.worker_registry
        SET
            status = 'draining',
            updated_at = now()
        WHERE worker_id = p_worker_id
          AND status = 'active';
    ELSE
        -- Hard stop: expire the lease immediately so any claimed jobs
        -- are requeued by recover_crashed_worker_jobs.
        UPDATE public.worker_registry
        SET
            status = 'stopped',
            lease_expires_at = now(),
            updated_at = now()
        WHERE worker_id = p_worker_id
          AND status IN ('active', 'draining');
    END IF;

END;
$$;

ALTER FUNCTION public.stop_worker(TEXT, BOOLEAN)
    OWNER TO postgres;

REVOKE ALL ON FUNCTION public.stop_worker(TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.stop_worker(TEXT, BOOLEAN) FROM anon;
REVOKE ALL ON FUNCTION public.stop_worker(TEXT, BOOLEAN) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.stop_worker(TEXT, BOOLEAN)
    TO service_role;

-- ============================================================
-- 2. RECALCULATE QUEUE POSITION
-- ============================================================

CREATE OR REPLACE FUNCTION public.recalculate_queue_position(
    p_booking_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_session_id UUID;
BEGIN

    SELECT b.queue_session_id
    INTO v_session_id
    FROM public.bookings b
    WHERE b.id = p_booking_id
      AND b.is_deleted = false;

    IF v_session_id IS NULL THEN
        RETURN;
    END IF;

    -- Refresh wait estimates for every active booking in the same
    -- queue session. estimate_wait_minutes is STABLE and returns NULL
    -- before the session starts, which is the desired behaviour.
    UPDATE public.bookings b
    SET estimated_wait_minutes =
        public.estimate_wait_minutes(b.queue_session_id, b.token_number)
    WHERE b.queue_session_id = v_session_id
      AND b.is_deleted = false
      AND b.status IN (
          'booked',
          'checked_in',
          'waiting',
          'called'
      );

END;
$$;

ALTER FUNCTION public.recalculate_queue_position(UUID)
    OWNER TO postgres;

REVOKE ALL ON FUNCTION public.recalculate_queue_position(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recalculate_queue_position(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.recalculate_queue_position(UUID)
    FROM authenticated;

GRANT EXECUTE ON FUNCTION public.recalculate_queue_position(UUID)
    TO service_role;

-- ============================================================
-- 3. CREATE BOOKING (parameter defaults only)
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_booking(
    p_hospital_id UUID,
    p_queue_session_id UUID DEFAULT NULL,
    p_patient_id UUID DEFAULT NULL,
    p_patient_name TEXT DEFAULT NULL,
    p_patient_phone TEXT DEFAULT NULL,
    p_patient_age INTEGER DEFAULT NULL,
    p_patient_gender TEXT DEFAULT NULL,
    p_village TEXT DEFAULT NULL,
    p_blood_group TEXT DEFAULT NULL,
    p_has_diabetes BOOLEAN DEFAULT false,
    p_has_bp BOOLEAN DEFAULT false,
    p_booking_source public.booking_source DEFAULT NULL,
    p_doctor_id UUID DEFAULT NULL,
    p_booked_by UUID DEFAULT NULL,
    p_appointment_date DATE DEFAULT NULL,
    p_platform_fee NUMERIC DEFAULT NULL,
    p_receptionist_fee NUMERIC DEFAULT NULL,
    p_hospital_fee NUMERIC DEFAULT NULL,
    p_idempotency_key TEXT DEFAULT NULL
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
        COALESCE(p_has_diabetes, false),
        COALESCE(p_has_bp, false),
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
BOOLEAN,BOOLEAN,public.booking_source,UUID,UUID,DATE,
NUMERIC,NUMERIC,NUMERIC,TEXT
)
    OWNER TO postgres;

-- ============================================================
-- 4. WRITE AUDIT LOG (optional hospital/entity ids)
-- ============================================================

CREATE OR REPLACE FUNCTION public.write_audit_log(
    p_hospital_id UUID DEFAULT NULL,
    p_actor_id UUID DEFAULT NULL,
    p_entity_type TEXT DEFAULT NULL,
    p_entity_id UUID DEFAULT NULL,
    p_action TEXT DEFAULT NULL,
    p_severity public.audit_action_severity DEFAULT NULL,
    p_old_data JSONB DEFAULT NULL,
    p_new_data JSONB DEFAULT NULL,
    p_notes TEXT DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}'::JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id UUID;
    v_severity public.audit_action_severity;
BEGIN

    IF p_severity IS NULL THEN
        SELECT default_severity
        INTO v_severity
        FROM public.audit_action_types
        WHERE action_type = p_action
          AND is_active = TRUE;
    END IF;

    v_severity := COALESCE(
        p_severity,
        v_severity,
        'low'
    );

    INSERT INTO public.audit_logs (
        hospital_id,
        actor_user_id,
        entity_type,
        entity_id,
        action_type,
        action_severity,
        old_data,
        new_data,
        notes,
        metadata
    )
    VALUES (
        p_hospital_id,
        p_actor_id,
        p_entity_type,
        p_entity_id,
        p_action,
        v_severity,
        p_old_data,
        p_new_data,
        p_notes,
        COALESCE(p_metadata, '{}'::JSONB)
    )
    RETURNING id
    INTO v_id;

    RETURN v_id;

END;
$$;

ALTER FUNCTION public.write_audit_log(
    UUID,
    UUID,
    TEXT,
    UUID,
    TEXT,
    public.audit_action_severity,
    JSONB,
    JSONB,
    TEXT,
    JSONB
)
    OWNER TO postgres;

-- ============================================================
-- 5. REGISTER payment_order_created AUDIT ACTION
-- ============================================================

INSERT INTO public.audit_action_types (
    action_type,
    display_name,
    default_severity,
    category,
    description
)
VALUES (
    'payment_order_created',
    'Payment Order Created',
    'low',
    'payment',
    'Razorpay payment order created for a booking'
)
ON CONFLICT (action_type) DO NOTHING;

-- ============================================================
-- METADATA
-- ============================================================

INSERT INTO public.migration_registry (
    migration_id,
    script_filename,
    description,
    category,
    status,
    applied_at
)
VALUES (
    '39_schema_alignment',
    '39_schema_alignment.sql',
    'Adds stop_worker and recalculate_queue_position RPCs; parameter defaults on create_booking and write_audit_log; registers payment_order_created audit action',
    'schema',
    'applied',
    now()
)
ON CONFLICT (migration_id) DO UPDATE
SET description = EXCLUDED.description,
    status = EXCLUDED.status,
    applied_at = EXCLUDED.applied_at;
