-- =============================================================
-- 46_doctor_clinical_operations.sql
--
-- Phase 1.4 - Doctor & Clinical Operations.
--
-- Additive only:
--   1. queue_runtime_events vocabulary extended with clinical
--      lifecycle events (session_started / session_ended /
--      emergency_inserted).
--   2. Audit registry: clinical_action / clinical_note under the
--      existing 'operations' category.
--   3. consultation_notes - append-only clinical notes with an
--      immutability trigger (immutable consultation audit trail).
--   4. One-active-consultation-per-doctor safeguard (unique
--      partial index; final guard for concurrent transitions).
--   5. Doctor session lifecycle RPCs: open_doctor_session /
--      close_doctor_session (idempotent, event-recorded).
--   6. Consultation lifecycle RPCs: start_consultation /
--      complete_consultation / return_to_waiting (FOR UPDATE
--      locked, idempotent).
--   7. insert_emergency_patient - priority insertion reusing the
--      advance_queue ordering (priority_score DESC).
--   8. save_consultation_note - append-only note writer.
--   9. get_doctor_dashboard - composed over get_queue_snapshot's
--      health block plus doctor-day statistics.
--
-- Reuses: queue_sessions, bookings status trigger (timestamps),
-- record_queue_event, get_queue_snapshot, booking_events feed.
-- No existing RPC signature changes.
-- =============================================================

-- =============================================================
-- 1. EVENT VOCABULARY (additive CHECK extension)
-- =============================================================

ALTER TABLE public.queue_runtime_events
    DROP CONSTRAINT IF EXISTS queue_runtime_events_event_type_check;

ALTER TABLE public.queue_runtime_events
    ADD CONSTRAINT queue_runtime_events_event_type_check
    CHECK (
        event_type IN (
            'advanced',
            'paused',
            'resumed',
            'recalled',
            'skipped',
            'restored',
            'absent_marked',
            'manually_called',
            'queue_completed',
            'doctor_delayed',
            'delay_cleared',
            'stalled_detected',
            'pause_exceeded_detected',
            'session_started',
            'session_ended',
            'emergency_inserted'
        )
    );

-- =============================================================
-- 2. AUDIT ACTION REGISTRY (additive)
-- =============================================================

INSERT INTO public.audit_action_types (
    action_type,
    display_name,
    default_severity,
    category,
    description
)
VALUES
(
    'clinical_action',
    'Clinical Action',
    'low',
    'operations',
    'Doctor clinical queue operations (consultation lifecycle, emergency insertion, session control)'
),
(
    'clinical_note',
    'Clinical Note',
    'low',
    'operations',
    'Clinical consultation note recorded for a booking'
)
ON CONFLICT (action_type) DO NOTHING;

-- =============================================================
-- 3. CONSULTATION NOTES (append-only clinical record)
-- Prescriptions and attachments are placeholders (JSONB arrays)
-- until dedicated modules exist. Immutability is layered:
--   * a mutation trigger raises on direct UPDATE/DELETE but lets
--     FK cascades through (trigger depth > 1 = cascade context;
--     RETURN OLD so the cascade delete still applies; RETURN
--     NULL would silently skip it and orphan rows),
--   * explicit privileges: service_role is INSERT+SELECT only,
--     anon/authenticated lose the default ALL grants,
--   * RLS with no policies denies any residual direct access.
-- =============================================================

CREATE TABLE IF NOT EXISTS public.consultation_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    booking_id UUID NOT NULL
        REFERENCES public.bookings(id)
        ON DELETE CASCADE,

    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    doctor_id UUID
        REFERENCES public.profiles(id)
        ON DELETE SET NULL,

    notes TEXT NOT NULL DEFAULT '',

    diagnosis_summary TEXT,

    prescription JSONB NOT NULL DEFAULT '[]'
        CHECK (
            jsonb_typeof(prescription) = 'array'
        ),

    follow_up_date DATE,

    attachments JSONB NOT NULL DEFAULT '[]'
        CHECK (
            jsonb_typeof(attachments) = 'array'
        ),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consultation_notes_booking
ON public.consultation_notes(
    booking_id,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_consultation_notes_hospital
ON public.consultation_notes(
    hospital_id,
    created_at DESC
);

CREATE OR REPLACE FUNCTION public.prevent_consultation_note_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- Depth 1 = direct statement: refuse. Depth > 1 = fired from
    -- within another trigger (FK cascade): allow, returning OLD so
    -- the cascade delete still removes the row.
    IF pg_trigger_depth() <= 1 THEN
        RAISE EXCEPTION 'consultation_notes is append-only'
            USING ERRCODE = 'P0003';
    END IF;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_consultation_notes_immutable
ON public.consultation_notes;

CREATE TRIGGER trg_consultation_notes_immutable
BEFORE UPDATE OR DELETE ON public.consultation_notes
FOR EACH ROW
EXECUTE FUNCTION public.prevent_consultation_note_mutation();

ALTER TABLE public.consultation_notes ENABLE ROW LEVEL SECURITY;

-- =============================================================
-- 4. ONE ACTIVE CONSULTATION PER DOCTOR (safeguard)
-- A doctor can consult exactly one patient at a time. This
-- unique partial index is the final arbiter when two
-- transitions race.
-- =============================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_consultation_per_doctor
ON public.bookings(assigned_doctor_id)
WHERE status = 'in_consultation'
  AND is_deleted = false
  AND assigned_doctor_id IS NOT NULL;

-- =============================================================
-- 5. DOCTOR SESSION LIFECYCLE
-- =============================================================

CREATE OR REPLACE FUNCTION public.open_doctor_session(
    p_hospital_id UUID,
    p_doctor_id UUID,
    p_session_date DATE DEFAULT CURRENT_DATE,
    p_max_tokens INTEGER DEFAULT NULL,
    p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_existing RECORD;
    v_id UUID;
BEGIN

    SELECT id, is_active
    INTO v_existing
    FROM public.queue_sessions
    WHERE hospital_id = p_hospital_id
      AND doctor_id = p_doctor_id
      AND session_date = p_session_date
    FOR UPDATE;

    IF v_existing.id IS NOT NULL THEN
        IF v_existing.is_active THEN
            RETURN jsonb_build_object(
                'ok', true,
                'already_open', true,
                'queue_session_id', v_existing.id
            );
        END IF;

        RETURN jsonb_build_object(
            'ok', false,
            'reason', 'session_already_ended'
        );
    END IF;

    BEGIN
        INSERT INTO public.queue_sessions (
            hospital_id,
            doctor_id,
            session_date,
            session_name,
            max_tokens,
            is_active,
            started_at
        ) VALUES (
            p_hospital_id,
            p_doctor_id,
            p_session_date,
            'doctor-session',
            COALESCE(p_max_tokens, 100),
            true,
            now()
        )
        RETURNING id INTO v_id;
    EXCEPTION
        WHEN unique_violation THEN
            -- Concurrent open won the race; converge on its row.
            SELECT id
            INTO v_id
            FROM public.queue_sessions
            WHERE hospital_id = p_hospital_id
              AND doctor_id = p_doctor_id
              AND session_date = p_session_date;

            RETURN jsonb_build_object(
                'ok', true,
                'already_open', true,
                'queue_session_id', v_id
            );
    END;

    PERFORM public.record_queue_event(
        v_id,
        'session_started',
        NULL,
        NULL,
        p_actor_id,
        jsonb_build_object('opened_by', p_actor_id)
    );

    RETURN jsonb_build_object(
        'ok', true,
        'already_open', false,
        'queue_session_id', v_id
    );

END;
$$;

ALTER FUNCTION public.open_doctor_session(UUID, UUID, DATE, INTEGER, UUID)
SET row_security = off;

CREATE OR REPLACE FUNCTION public.close_doctor_session(
    p_queue_session_id UUID,
    p_actor_id UUID DEFAULT NULL,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_session RECORD;
    v_waiting INTEGER;
BEGIN

    SELECT id, is_active
    INTO v_session
    FROM public.queue_sessions
    WHERE id = p_queue_session_id
    FOR UPDATE;

    IF v_session.id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'reason', 'session_not_found'
        );
    END IF;

    IF NOT v_session.is_active THEN
        RETURN jsonb_build_object(
            'ok', true,
            'already_closed', true
        );
    END IF;

    SELECT COUNT(*)
    INTO v_waiting
    FROM public.bookings b
    WHERE b.queue_session_id = p_queue_session_id
      AND b.status IN ('booked', 'checked_in', 'waiting', 'called')
      AND b.is_deleted = false;

    UPDATE public.queue_sessions
    SET
        is_active = false,
        ended_at = now(),
        updated_at = now()
    WHERE id = p_queue_session_id;

    PERFORM public.record_queue_event(
        p_queue_session_id,
        'session_ended',
        NULL,
        NULL,
        p_actor_id,
        jsonb_build_object(
            'reason', p_reason,
            'early', v_waiting > 0,
            'waiting_remaining', v_waiting
        )
    );

    RETURN jsonb_build_object(
        'ok', true,
        'already_closed', false,
        'waiting_remaining', v_waiting
    );

END;
$$;

ALTER FUNCTION public.close_doctor_session(UUID, UUID, TEXT)
SET row_security = off;

-- =============================================================
-- 6. CONSULTATION LIFECYCLE
-- The bookings status trigger owns the timestamps: entry into
-- in_consultation stamps consultation_started_at, completion
-- stamps consultation_completed_at.
-- =============================================================

CREATE OR REPLACE FUNCTION public.start_consultation(
    p_queue_session_id UUID,
    p_booking_id UUID,
    p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_booking RECORD;
    v_session RECORD;
BEGIN

    SELECT id, is_active
    INTO v_session
    FROM public.queue_sessions
    WHERE id = p_queue_session_id;

    IF v_session.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'session_not_found');
    END IF;

    IF NOT v_session.is_active THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'session_not_active');
    END IF;

    SELECT id, status, queue_session_id, token_number,
           consultation_started_at
    INTO v_booking
    FROM public.bookings
    WHERE id = p_booking_id
      AND is_deleted = false
    FOR UPDATE;

    IF v_booking.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'booking_not_found');
    END IF;

    IF v_booking.queue_session_id IS DISTINCT FROM p_queue_session_id THEN
        -- Cross-session / cross-hospital isolation guard.
        RETURN jsonb_build_object('ok', false, 'reason', 'booking_not_in_session');
    END IF;

    IF v_booking.status = 'in_consultation' THEN
        RETURN jsonb_build_object(
            'ok', true,
            'already_started', true,
            'booking_id', v_booking.id,
            'token_number', v_booking.token_number,
            'started_at', v_booking.consultation_started_at
        );
    END IF;

    IF v_booking.status <> 'called' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'reason', format('booking_status_%s', v_booking.status)
        );
    END IF;

    BEGIN
        UPDATE public.bookings
        SET status = 'in_consultation'
        WHERE id = p_booking_id;
    EXCEPTION
        WHEN unique_violation THEN
            -- The one-active-consultation index rejected us: the
            -- doctor already has a patient in consultation.
            RETURN jsonb_build_object(
                'ok', false,
                'reason', 'another_consultation_active'
            );
    END;

    RETURN jsonb_build_object(
        'ok', true,
        'already_started', false,
        'booking_id', p_booking_id,
        'token_number', v_booking.token_number,
        'started_at', now()
    );

END;
$$;

ALTER FUNCTION public.start_consultation(UUID, UUID, UUID)
SET row_security = off;

CREATE OR REPLACE FUNCTION public.complete_consultation(
    p_queue_session_id UUID,
    p_booking_id UUID,
    p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_booking RECORD;
    v_duration NUMERIC;
BEGIN
    SELECT id, status, queue_session_id, token_number,
           consultation_started_at, consultation_completed_at
    INTO v_booking
    FROM public.bookings
    WHERE id = p_booking_id
      AND is_deleted = false
    FOR UPDATE;

    IF v_booking.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'booking_not_found');
    END IF;

    IF v_booking.queue_session_id IS DISTINCT FROM p_queue_session_id THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'booking_not_in_session');
    END IF;

    IF v_booking.status = 'completed' THEN
        RETURN jsonb_build_object(
            'ok', true,
            'already_completed', true,
            'booking_id', v_booking.id,
            'token_number', v_booking.token_number
        );
    END IF;

    IF v_booking.status <> 'in_consultation' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'reason', format('booking_status_%s', v_booking.status)
        );
    END IF;

    UPDATE public.bookings
    SET status = 'completed'
    WHERE id = p_booking_id;

    v_duration := NULL;
    IF v_booking.consultation_started_at IS NOT NULL THEN
        v_duration := ROUND(
            EXTRACT(EPOCH FROM (now() - v_booking.consultation_started_at)) / 60.0,
            1
        );
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'already_completed', false,
        'booking_id', p_booking_id,
        'token_number', v_booking.token_number,
        'duration_minutes', v_duration,
        'completed_at', now()
    );

END;
$$;

ALTER FUNCTION public.complete_consultation(UUID, UUID, UUID)
SET row_security = off;

CREATE OR REPLACE FUNCTION public.return_to_waiting(
    p_queue_session_id UUID,
    p_booking_id UUID,
    p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_booking RECORD;
BEGIN

    SELECT id, status, queue_session_id, token_number,
           consultation_started_at
    INTO v_booking
    FROM public.bookings
    WHERE id = p_booking_id
      AND is_deleted = false
    FOR UPDATE;

    IF v_booking.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'booking_not_found');
    END IF;

    IF v_booking.queue_session_id IS DISTINCT FROM p_queue_session_id THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'booking_not_in_session');
    END IF;

    IF v_booking.status = 'waiting' THEN
        RETURN jsonb_build_object(
            'ok', true,
            'already_waiting', true,
            'booking_id', v_booking.id,
            'token_number', v_booking.token_number
        );
    END IF;

    IF v_booking.status <> 'in_consultation' THEN
        RETURN jsonb_build_object(
            'ok', false,
            'reason', format('booking_status_%s', v_booking.status)
        );
    END IF;

    -- The interrupted consultation restarts fresh: clear the
    -- stale start timestamp so durations stay accurate.
    UPDATE public.bookings
    SET
        status = 'waiting',
        consultation_started_at = NULL
    WHERE id = p_booking_id;

    RETURN jsonb_build_object(
        'ok', true,
        'already_waiting', false,
        'booking_id', p_booking_id,
        'token_number', v_booking.token_number
    );

END;
$$;

ALTER FUNCTION public.return_to_waiting(UUID, UUID, UUID)
SET row_security = off;

-- =============================================================
-- 7. EMERGENCY INSERTION
-- The emergency patient receives the next token but a top
-- priority_score, so the existing advance_queue ordering
-- (priority DESC, token ASC) calls them next. No duplicate
-- queue logic.
-- =============================================================

CREATE OR REPLACE FUNCTION public.insert_emergency_patient(
    p_queue_session_id UUID,
    p_patient_name TEXT,
    p_patient_phone TEXT DEFAULT NULL,
    p_reason TEXT DEFAULT NULL,
    p_actor_id UUID DEFAULT NULL,
    p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_session RECORD;
    v_existing UUID;
    v_token INTEGER;
    v_id UUID;
BEGIN

    SELECT id, hospital_id, doctor_id, session_date, is_active
    INTO v_session
    FROM public.queue_sessions
    WHERE id = p_queue_session_id
    FOR UPDATE;

    IF v_session.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'session_not_found');
    END IF;

    IF NOT v_session.is_active THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'session_not_active');
    END IF;

    IF p_idempotency_key IS NOT NULL THEN
        SELECT id
        INTO v_existing
        FROM public.bookings
        WHERE queue_session_id = p_queue_session_id
          AND idempotency_key = p_idempotency_key
          AND is_deleted = false;

        IF v_existing IS NOT NULL THEN
            RETURN jsonb_build_object(
                'ok', true,
                'already_inserted', true,
                'booking_id', v_existing
            );
        END IF;
    END IF;

    SELECT COALESCE(MAX(token_number), 0) + 1
    INTO v_token
    FROM public.bookings
    WHERE queue_session_id = p_queue_session_id
      AND is_deleted = false;

    INSERT INTO public.bookings (
        hospital_id,
        queue_session_id,
        patient_name,
        patient_phone,
        token_number,
        priority_score,
        priority_flag,
        status,
        booking_source,
        assigned_doctor_id,
        booked_by,
        appointment_date,
        idempotency_key
    ) VALUES (
        v_session.hospital_id,
        p_queue_session_id,
        p_patient_name,
        NULLIF(trim(p_patient_phone), ''),
        v_token,
        100,
        true,
        'waiting',
        'walkin',
        v_session.doctor_id,
        p_actor_id,
        v_session.session_date,
        p_idempotency_key
    )
    RETURNING id INTO v_id;

    PERFORM public.record_queue_event(
        p_queue_session_id,
        'emergency_inserted',
        v_token,
        v_id,
        p_actor_id,
        jsonb_build_object('reason', p_reason)
    );

    RETURN jsonb_build_object(
        'ok', true,
        'already_inserted', false,
        'booking_id', v_id,
        'token_number', v_token
    );

END;
$$;

ALTER FUNCTION public.insert_emergency_patient(UUID, TEXT, TEXT, TEXT, UUID, TEXT)
SET row_security = off;

-- =============================================================
-- 8. CLINICAL NOTES (append-only writer)
-- =============================================================

CREATE OR REPLACE FUNCTION public.save_consultation_note(
    p_booking_id UUID,
    p_doctor_id UUID,
    p_notes TEXT,
    p_diagnosis_summary TEXT DEFAULT NULL,
    p_prescription JSONB DEFAULT NULL,
    p_follow_up_date DATE DEFAULT NULL,
    p_attachments JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_booking RECORD;
    v_note_id UUID;
BEGIN

    SELECT id, hospital_id
    INTO v_booking
    FROM public.bookings
    WHERE id = p_booking_id
      AND is_deleted = false;

    IF v_booking.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'booking_not_found');
    END IF;

    INSERT INTO public.consultation_notes (
        booking_id,
        hospital_id,
        doctor_id,
        notes,
        diagnosis_summary,
        prescription,
        follow_up_date,
        attachments
    ) VALUES (
        p_booking_id,
        v_booking.hospital_id,
        p_doctor_id,
        COALESCE(p_notes, ''),
        p_diagnosis_summary,
        COALESCE(p_prescription, '[]'::JSONB),
        p_follow_up_date,
        COALESCE(p_attachments, '[]'::JSONB)
    )
    RETURNING id INTO v_note_id;

    RETURN jsonb_build_object(
        'ok', true,
        'note_id', v_note_id,
        'booking_id', p_booking_id,
        'hospital_id', v_booking.hospital_id
    );

END;
$$;

ALTER FUNCTION public.save_consultation_note(UUID, UUID, TEXT, TEXT, JSONB, DATE, JSONB)
SET row_security = off;

-- =============================================================
-- 9. DOCTOR DASHBOARD
-- Composed over the existing get_queue_snapshot health block
-- plus day-level statistics from the session's bookings.
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_doctor_dashboard(
    p_doctor_id UUID,
    p_hospital_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_session RECORD;
    v_snapshot JSONB;
    v_current JSONB;
    v_next JSONB;
    v_stats RECORD;
BEGIN

    SELECT qs.id, qs.is_paused, qs.pause_reason,
           qs.delay_expected_minutes, qs.max_tokens,
           qs.started_at
    INTO v_session
    FROM public.queue_sessions qs
    WHERE qs.hospital_id = p_hospital_id
      AND qs.doctor_id = p_doctor_id
      AND qs.session_date = CURRENT_DATE
      AND qs.is_active = true
    ORDER BY qs.created_at DESC
    LIMIT 1;

    IF v_session.id IS NULL THEN
        RETURN jsonb_build_object(
            'has_session', false,
            'generated_at', now()
        );
    END IF;

    v_snapshot := public.get_queue_snapshot(v_session.id);

    SELECT jsonb_build_object(
        'booking_id', b.id,
        'token_number', b.token_number,
        'patient_name', b.patient_name,
        'status', b.status,
        'called_at', b.called_at,
        'consultation_started_at', b.consultation_started_at
    )
    INTO v_current
    FROM public.bookings b
    WHERE b.queue_session_id = v_session.id
      AND b.status IN ('in_consultation', 'called')
      AND b.is_deleted = false
    ORDER BY
        CASE b.status WHEN 'in_consultation' THEN 0 ELSE 1 END,
        b.called_at DESC NULLS LAST
    LIMIT 1;

    SELECT jsonb_agg(
        jsonb_build_object(
            'booking_id', w.id,
            'token_number', w.token_number,
            'patient_name', w.patient_name,
            'position', w.pos,
            'estimated_wait_minutes', w.est
        )
        ORDER BY w.pos
    )
    INTO v_next
    FROM (
        SELECT
            b.id,
            b.token_number,
            b.patient_name,
            ROW_NUMBER() OVER (
                ORDER BY b.priority_score DESC, b.token_number ASC
            ) AS pos,
            (v_snapshot->>'estimated_wait_next_minutes')::NUMERIC
                * ROW_NUMBER() OVER (
                    ORDER BY b.priority_score DESC, b.token_number ASC
                ) AS est
        FROM public.bookings b
        WHERE b.queue_session_id = v_session.id
          AND b.status IN ('booked', 'checked_in', 'waiting')
          AND b.is_deleted = false
        ORDER BY b.priority_score DESC, b.token_number ASC
        LIMIT 5
    ) w;

    SELECT
        COUNT(*) FILTER (
            WHERE b.status IN ('booked', 'checked_in', 'waiting')
        ) AS waiting_count,
        COUNT(*) FILTER (WHERE b.status = 'called') AS called_count,
        COUNT(*) FILTER (
            WHERE b.status = 'in_consultation'
        ) AS in_consultation_count,
        COUNT(*) FILTER (WHERE b.status = 'completed') AS completed_count,
        ROUND(AVG(
            EXTRACT(EPOCH FROM (b.called_at - b.created_at)) / 60.0
        ) FILTER (WHERE b.called_at IS NOT NULL), 1) AS avg_wait_minutes,
        ROUND(AVG(
            EXTRACT(EPOCH FROM (
                b.consultation_completed_at - b.consultation_started_at
            )) / 60.0
        ) FILTER (
            WHERE b.consultation_started_at IS NOT NULL
              AND b.consultation_completed_at IS NOT NULL
        ), 1) AS avg_consultation_minutes
    INTO v_stats
    FROM public.bookings b
    WHERE b.queue_session_id = v_session.id
      AND b.is_deleted = false;

    RETURN jsonb_build_object(
        'has_session', true,
        'queue_session_id', v_session.id,
        'hospital_id', p_hospital_id,
        'doctor_id', p_doctor_id,
        'current_patient', COALESCE(v_current, 'null'::JSONB),
        'next_patients', COALESCE(v_next, '[]'::JSONB),
        'counts', jsonb_build_object(
            'waiting', v_stats.waiting_count,
            'called', v_stats.called_count,
            'in_consultation', v_stats.in_consultation_count,
            'completed', v_stats.completed_count
        ),
        'avg_wait_minutes', v_stats.avg_wait_minutes,
        'avg_consultation_minutes', v_stats.avg_consultation_minutes,
        'delay_status', jsonb_build_object(
            'delayed', COALESCE(v_session.delay_expected_minutes, 0) > 0,
            'delay_expected_minutes', v_session.delay_expected_minutes
        ),
        'pause_status', jsonb_build_object(
            'paused', v_session.is_paused,
            'reason', v_session.pause_reason
        ),
        'queue_utilization', CASE
            WHEN COALESCE(v_session.max_tokens, 0) > 0 THEN ROUND(
                v_stats.completed_count::NUMERIC / v_session.max_tokens,
                4
            )
            ELSE 0
        END,
        'session_health', COALESCE(v_snapshot->'health', '{}'::JSONB),
        'generated_at', now()
    );

END;
$$;

ALTER FUNCTION public.get_doctor_dashboard(UUID, UUID)
SET row_security = off;

-- =============================================================
-- 10. GRANTS (service_role only; consistent with 43/45)
-- =============================================================

REVOKE ALL ON FUNCTION public.open_doctor_session(UUID, UUID, DATE, INTEGER, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.open_doctor_session(UUID, UUID, DATE, INTEGER, UUID)
    TO service_role;

REVOKE ALL ON FUNCTION public.close_doctor_session(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.close_doctor_session(UUID, UUID, TEXT)
    TO service_role;

REVOKE ALL ON FUNCTION public.start_consultation(UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_consultation(UUID, UUID, UUID)
    TO service_role;

REVOKE ALL ON FUNCTION public.complete_consultation(UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_consultation(UUID, UUID, UUID)
    TO service_role;

REVOKE ALL ON FUNCTION public.return_to_waiting(UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.return_to_waiting(UUID, UUID, UUID)
    TO service_role;

REVOKE ALL ON FUNCTION public.insert_emergency_patient(UUID, TEXT, TEXT, TEXT, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.insert_emergency_patient(UUID, TEXT, TEXT, TEXT, UUID, TEXT)
    TO service_role;

REVOKE ALL ON FUNCTION public.save_consultation_note(UUID, UUID, TEXT, TEXT, JSONB, DATE, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_consultation_note(UUID, UUID, TEXT, TEXT, JSONB, DATE, JSONB)
    TO service_role;

REVOKE ALL ON FUNCTION public.get_doctor_dashboard(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_doctor_dashboard(UUID, UUID)
    TO service_role;

-- Immutability: strip the default ALL grants, then allow the
-- application INSERT + SELECT only. The mutation trigger and RLS
-- provide defense in depth; FK cascades still apply.
REVOKE ALL ON TABLE public.consultation_notes FROM PUBLIC;
REVOKE ALL ON TABLE public.consultation_notes FROM anon;
REVOKE ALL ON TABLE public.consultation_notes FROM authenticated;
REVOKE ALL ON TABLE public.consultation_notes FROM service_role;
GRANT SELECT, INSERT ON TABLE public.consultation_notes TO service_role;

COMMENT ON FUNCTION public.open_doctor_session(UUID, UUID, DATE, INTEGER, UUID) IS
'Phase 1.4: open (or converge on) the doctor session for a hospital/doctor/day.
Idempotent; refuses to reopen an already-ended session.';

COMMENT ON FUNCTION public.close_doctor_session(UUID, UUID, TEXT) IS
'Phase 1.4: end a doctor session (incl. early closure). Idempotent; records
session_ended with remaining-waiting metadata.';

COMMENT ON FUNCTION public.start_consultation(UUID, UUID, UUID) IS
'Phase 1.4: called -> in_consultation under FOR UPDATE. The unique
one-active-consultation-per-doctor index rejects racing starts.';

COMMENT ON FUNCTION public.complete_consultation(UUID, UUID, UUID) IS
'Phase 1.4: in_consultation -> completed. Idempotent; returns duration.';

COMMENT ON FUNCTION public.return_to_waiting(UUID, UUID, UUID) IS
'Phase 1.4: interrupt a consultation and return the patient to waiting;
clears the stale start timestamp.';

COMMENT ON FUNCTION public.insert_emergency_patient(UUID, TEXT, TEXT, TEXT, UUID, TEXT) IS
'Phase 1.4: insert an emergency patient at the front of the queue via
priority_score; records emergency_inserted.';

COMMENT ON FUNCTION public.save_consultation_note(UUID, UUID, TEXT, TEXT, JSONB, DATE, JSONB) IS
'Phase 1.4: append-only clinical note (notes, diagnosis, prescription
placeholder, follow-up, attachments placeholder).';

COMMENT ON FUNCTION public.get_doctor_dashboard(UUID, UUID) IS
'Phase 1.4: doctor day dashboard composed over get_queue_snapshot health
plus wait/consultation statistics and delay/pause status.';

COMMENT ON TABLE public.consultation_notes IS
'Phase 1.4: append-only clinical consultation notes, the immutable
consultation audit trail. Direct UPDATE/DELETE are refused by a
mutation trigger, INSERT-only grants and RLS; FK cascades still
remove rows with their parents.';
