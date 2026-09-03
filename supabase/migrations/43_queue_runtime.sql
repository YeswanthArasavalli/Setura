-- =============================================================
-- 43_queue_runtime.sql
--
-- Phase 1.2 - Queue Runtime & Live Operations.
--
-- Turns the queue from a booking database into a real-time
-- operational system:
--
--   * pause/resume state on queue_sessions (additive columns)
--   * queue_runtime_events - append-only operational event log,
--     published to Realtime for display screens
--   * idempotent control RPCs: pause, resume, recall, skip,
--     restore, mark absent, manual call
--   * advance_queue hardened with a pause guard (SKIP LOCKED
--     semantics unchanged)
--   * get_queue_snapshot - full state reconstruction from the
--     database (recovery primitive) with wait-time estimates
--   * trigger_sla_refresh - debounced SLA recompute enqueue
--   * weekly rollups gain skipped_bookings (skipped rate)
--
-- All changes are additive. No existing RPC signature changes.
-- =============================================================

-- =============================================================
-- 1. QUEUE SESSION RUNTIME COLUMNS (additive)
-- =============================================================

ALTER TABLE public.queue_sessions
    ADD COLUMN IF NOT EXISTS is_paused BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.queue_sessions
    ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;

ALTER TABLE public.queue_sessions
    ADD COLUMN IF NOT EXISTS pause_reason TEXT;

-- =============================================================
-- 2. QUEUE RUNTIME EVENTS
-- Append-only operational log. Realtime-published so display
-- screens and dashboards receive queue completion, pause and
-- resume events without polling.
-- =============================================================

CREATE TABLE IF NOT EXISTS public.queue_runtime_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    queue_session_id UUID NOT NULL
        REFERENCES public.queue_sessions(id)
        ON DELETE CASCADE,

    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    booking_id UUID
        REFERENCES public.bookings(id)
        ON DELETE SET NULL,

    event_type TEXT NOT NULL
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
                'queue_completed'
            )
        ),

    token_number INTEGER,

    actor_id UUID
        REFERENCES public.profiles(id)
        ON DELETE SET NULL,

    metadata JSONB NOT NULL DEFAULT '{}'
        CHECK (
            jsonb_typeof(metadata) = 'object'
        ),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_queue_events_session
ON public.queue_runtime_events(
    queue_session_id,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_queue_events_hospital
ON public.queue_runtime_events(
    hospital_id,
    created_at DESC
);

DROP TRIGGER IF EXISTS trg_queue_events_hospital_immutable
ON public.queue_runtime_events;

CREATE TRIGGER trg_queue_events_hospital_immutable
BEFORE UPDATE ON public.queue_runtime_events
FOR EACH ROW
EXECUTE FUNCTION public.prevent_hospital_id_update();

DO $$
BEGIN
    BEGIN
        ALTER PUBLICATION supabase_realtime
        ADD TABLE public.queue_runtime_events;
    EXCEPTION
        WHEN duplicate_object THEN NULL;
    END;
END $$;

ALTER TABLE public.queue_runtime_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.queue_runtime_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS queue_events_service
ON public.queue_runtime_events;

CREATE POLICY queue_events_service
ON public.queue_runtime_events
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

DROP POLICY IF EXISTS queue_events_read
ON public.queue_runtime_events;

CREATE POLICY queue_events_read
ON public.queue_runtime_events
FOR SELECT
TO authenticated
USING (true);

-- =============================================================
-- 3. EVENT RECORDER (internal primitive)
-- =============================================================

CREATE OR REPLACE FUNCTION public.record_queue_event(
    p_queue_session_id UUID,
    p_event_type TEXT,
    p_token_number INTEGER DEFAULT NULL,
    p_booking_id UUID DEFAULT NULL,
    p_actor_id UUID DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_hospital UUID;
    v_id UUID;
BEGIN

    SELECT hospital_id
    INTO v_hospital
    FROM public.queue_sessions
    WHERE id = p_queue_session_id;

    IF v_hospital IS NULL THEN
        RAISE EXCEPTION 'Queue session not found'
            USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO public.queue_runtime_events (
        queue_session_id,
        hospital_id,
        booking_id,
        event_type,
        token_number,
        actor_id,
        metadata
    )
    VALUES (
        p_queue_session_id,
        v_hospital,
        p_booking_id,
        p_event_type,
        p_token_number,
        p_actor_id,
        COALESCE(p_metadata, '{}')
    )
    RETURNING id INTO v_id;

    RETURN v_id;

END;
$$;

ALTER FUNCTION public.record_queue_event(UUID,TEXT,INTEGER,UUID,UUID,JSONB)
SET row_security = off;

-- =============================================================
-- 4. ADVANCE QUEUE (hardened)
-- SKIP LOCKED semantics are preserved exactly. A paused queue
-- refuses to advance. Every successful advance records an
-- operational event.
-- =============================================================

CREATE OR REPLACE FUNCTION public.advance_queue(
    p_queue_session_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_booking_id UUID;
    v_token INTEGER;
    v_paused BOOLEAN;
BEGIN

    SELECT is_paused
    INTO v_paused
    FROM public.queue_sessions
    WHERE id = p_queue_session_id
    FOR UPDATE;

    IF v_paused IS NULL THEN
        RETURN NULL;
    END IF;

    IF v_paused THEN
        RAISE EXCEPTION 'QUEUE_PAUSED'
            USING ERRCODE = 'P0001';
    END IF;

    SELECT id, token_number
    INTO v_booking_id, v_token
    FROM public.bookings
    WHERE queue_session_id = p_queue_session_id
      AND status IN (
            'booked',
            'checked_in',
            'waiting'
      )
      AND is_deleted = false
    ORDER BY
        priority_score DESC,
        token_number ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF v_booking_id IS NULL THEN
        RETURN NULL;
    END IF;

    UPDATE public.bookings
    SET
        status = 'called',
        called_at = now()
    WHERE id = v_booking_id;

    UPDATE public.queue_sessions
    SET
        current_live_token = v_token,
        started_at = COALESCE(started_at, now())
    WHERE id = p_queue_session_id;

    PERFORM public.record_queue_event(
        p_queue_session_id,
        'advanced',
        v_token,
        v_booking_id
    );

    RETURN v_token;

END;
$$;

ALTER FUNCTION public.advance_queue(UUID)
SET row_security = off;

-- =============================================================
-- 5. PAUSE / RESUME (idempotent)
-- The queue_sessions UPDATE doubles as the Realtime broadcast:
-- subscribed display screens receive the state change.
-- =============================================================

CREATE OR REPLACE FUNCTION public.pause_queue(
    p_queue_session_id UUID,
    p_reason TEXT DEFAULT NULL,
    p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_rows INTEGER;
BEGIN

    UPDATE public.queue_sessions
    SET
        is_paused = true,
        paused_at = now(),
        pause_reason = p_reason
    WHERE id = p_queue_session_id
      AND is_paused = false;

    GET DIAGNOSTICS v_rows = ROW_COUNT;

    IF v_rows = 0 THEN
        RETURN jsonb_build_object(
            'paused', false,
            'already_paused', true
        );
    END IF;

    PERFORM public.record_queue_event(
        p_queue_session_id,
        'paused',
        NULL,
        NULL,
        p_actor_id,
        jsonb_build_object('reason', COALESCE(p_reason, ''))
    );

    RETURN jsonb_build_object(
        'paused', true,
        'already_paused', false
    );

END;
$$;

ALTER FUNCTION public.pause_queue(UUID,TEXT,UUID)
SET row_security = off;

CREATE OR REPLACE FUNCTION public.resume_queue(
    p_queue_session_id UUID,
    p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_rows INTEGER;
BEGIN

    UPDATE public.queue_sessions
    SET
        is_paused = false,
        paused_at = NULL,
        pause_reason = NULL
    WHERE id = p_queue_session_id
      AND is_paused = true;

    GET DIAGNOSTICS v_rows = ROW_COUNT;

    IF v_rows = 0 THEN
        RETURN jsonb_build_object(
            'resumed', false,
            'already_running', true
        );
    END IF;

    PERFORM public.record_queue_event(
        p_queue_session_id,
        'resumed',
        NULL,
        NULL,
        p_actor_id
    );

    RETURN jsonb_build_object(
        'resumed', true,
        'already_running', false
    );

END;
$$;

ALTER FUNCTION public.resume_queue(UUID,UUID)
SET row_security = off;

-- =============================================================
-- 6. TOKEN CONTROL OPERATIONS (all optimistic + idempotent)
-- =============================================================

-- Recalls the currently called token. Pure notification hook:
-- no state change, so repeated recalls are naturally safe.
CREATE OR REPLACE FUNCTION public.recall_current_token(
    p_queue_session_id UUID,
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

    SELECT
        b.id,
        b.token_number,
        b.patient_name,
        b.patient_phone
    INTO v_booking
    FROM public.bookings b
    JOIN public.queue_sessions qs
        ON qs.id = b.queue_session_id
    WHERE b.queue_session_id = p_queue_session_id
      AND b.status = 'called'
      AND b.is_deleted = false
      AND b.token_number = qs.current_live_token
    ORDER BY b.called_at DESC NULLS LAST
    LIMIT 1;

    IF v_booking.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'no_called_token');
    END IF;

    PERFORM public.record_queue_event(
        p_queue_session_id,
        'recalled',
        v_booking.token_number,
        v_booking.id,
        p_actor_id
    );

    RETURN jsonb_build_object(
        'ok', true,
        'booking_id', v_booking.id,
        'token_number', v_booking.token_number,
        'patient_name', v_booking.patient_name,
        'patient_phone', v_booking.patient_phone
    );

END;
$$;

ALTER FUNCTION public.recall_current_token(UUID,UUID)
SET row_security = off;

-- Skips a token. Optimistic guard: only queue-active statuses
-- can be skipped, so concurrent terminal transitions lose
-- gracefully with ok=false.
CREATE OR REPLACE FUNCTION public.skip_queue_token(
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
    v_token INTEGER;
    v_live INTEGER;
BEGIN

    UPDATE public.bookings
    SET status = 'skipped'
    WHERE id = p_booking_id
      AND queue_session_id = p_queue_session_id
      AND status IN ('booked', 'checked_in', 'waiting', 'called')
      AND is_deleted = false
    RETURNING token_number INTO v_token;

    IF v_token IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'reason', 'not_skippable'
        );
    END IF;

    SELECT current_live_token
    INTO v_live
    FROM public.queue_sessions
    WHERE id = p_queue_session_id;

    PERFORM public.record_queue_event(
        p_queue_session_id,
        'skipped',
        v_token,
        p_booking_id,
        p_actor_id
    );

    RETURN jsonb_build_object(
        'ok', true,
        'token_number', v_token,
        'was_current', v_token = v_live
    );

END;
$$;

ALTER FUNCTION public.skip_queue_token(UUID,UUID,UUID)
SET row_security = off;

-- Restores a skipped patient back into the waiting pool.
CREATE OR REPLACE FUNCTION public.restore_queue_token(
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
    v_token INTEGER;
BEGIN

    UPDATE public.bookings
    SET status = 'waiting'
    WHERE id = p_booking_id
      AND queue_session_id = p_queue_session_id
      AND status = 'skipped'
      AND is_deleted = false
    RETURNING token_number INTO v_token;

    IF v_token IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'reason', 'not_skipped'
        );
    END IF;

    PERFORM public.record_queue_event(
        p_queue_session_id,
        'restored',
        v_token,
        p_booking_id,
        p_actor_id
    );

    RETURN jsonb_build_object(
        'ok', true,
        'token_number', v_token
    );

END;
$$;

ALTER FUNCTION public.restore_queue_token(UUID,UUID,UUID)
SET row_security = off;

-- Marks a patient absent (no-show).
CREATE OR REPLACE FUNCTION public.mark_patient_absent(
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
    v_token INTEGER;
BEGIN

    UPDATE public.bookings
    SET status = 'no_show'
    WHERE id = p_booking_id
      AND queue_session_id = p_queue_session_id
      AND status IN ('booked', 'checked_in', 'waiting', 'called')
      AND is_deleted = false
    RETURNING token_number INTO v_token;

    IF v_token IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'reason', 'not_markable'
        );
    END IF;

    PERFORM public.record_queue_event(
        p_queue_session_id,
        'absent_marked',
        v_token,
        p_booking_id,
        p_actor_id
    );

    RETURN jsonb_build_object(
        'ok', true,
        'token_number', v_token
    );

END;
$$;

ALTER FUNCTION public.mark_patient_absent(UUID,UUID,UUID)
SET row_security = off;

-- Manually calls a specific token (reception override).
-- Idempotent: calling an already-called token returns ok with
-- the idempotent flag instead of failing.
CREATE OR REPLACE FUNCTION public.call_queue_token(
    p_queue_session_id UUID,
    p_token_number INTEGER,
    p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_booking_id UUID;
    v_status TEXT;
BEGIN

    SELECT id, status
    INTO v_booking_id, v_status
    FROM public.bookings
    WHERE queue_session_id = p_queue_session_id
      AND token_number = p_token_number
      AND is_deleted = false
    ORDER BY
        CASE
            WHEN status IN ('booked', 'checked_in', 'waiting') THEN 0
            ELSE 1
        END,
        created_at DESC
    LIMIT 1
    FOR UPDATE;

    IF v_booking_id IS NULL THEN
        RETURN jsonb_build_object(
            'ok', false,
            'reason', 'token_not_found'
        );
    END IF;

    IF v_status = 'called' THEN
        RETURN jsonb_build_object(
            'ok', true,
            'idempotent', true,
            'booking_id', v_booking_id,
            'token_number', p_token_number
        );
    END IF;

    IF v_status NOT IN ('booked', 'checked_in', 'waiting') THEN
        RETURN jsonb_build_object(
            'ok', false,
            'reason', 'token_not_callable',
            'current_status', v_status
        );
    END IF;

    UPDATE public.bookings
    SET
        status = 'called',
        called_at = now()
    WHERE id = v_booking_id;

    UPDATE public.queue_sessions
    SET current_live_token = p_token_number
    WHERE id = p_queue_session_id;

    PERFORM public.record_queue_event(
        p_queue_session_id,
        'manually_called',
        p_token_number,
        v_booking_id,
        p_actor_id
    );

    RETURN jsonb_build_object(
        'ok', true,
        'idempotent', false,
        'booking_id', v_booking_id,
        'token_number', p_token_number
    );

END;
$$;

ALTER FUNCTION public.call_queue_token(UUID,INTEGER,UUID)
SET row_security = off;

-- =============================================================
-- 7. QUEUE SNAPSHOT (wait-time engine + recovery primitive)
-- Reconstructs the complete live queue state from the database
-- alone, so any display/doctor/reception client can recover
-- after a crash, reconnect or refresh without polling.
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_queue_snapshot(
    p_queue_session_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_session RECORD;
    v_avg INTEGER;
    v_called JSONB;
    v_waiting JSONB;
    v_counts JSONB;
BEGIN

    SELECT
        id,
        hospital_id,
        doctor_id,
        session_date,
        is_active,
        is_paused,
        current_live_token,
        max_tokens
    INTO v_session
    FROM public.queue_sessions
    WHERE id = p_queue_session_id;

    IF v_session.id IS NULL THEN
        RETURN NULL;
    END IF;

    -- Doctor throughput for the session weekday; 10 min default.
    SELECT ds.average_consultation_minutes
    INTO v_avg
    FROM public.doctor_schedules ds
    WHERE ds.doctor_id = v_session.doctor_id
      AND ds.hospital_id = v_session.hospital_id
      AND ds.weekday = EXTRACT(DOW FROM v_session.session_date)::INTEGER
      AND ds.is_active = true
      AND ds.is_deleted = false
    ORDER BY ds.start_time
    LIMIT 1;

    v_avg := COALESCE(v_avg, 10);

    SELECT jsonb_build_object(
        'booking_id', b.id,
        'token_number', b.token_number,
        'patient_name', b.patient_name,
        'called_at', b.called_at
    )
    INTO v_called
    FROM public.bookings b
    WHERE b.queue_session_id = p_queue_session_id
      AND b.status = 'called'
      AND b.is_deleted = false
    ORDER BY b.called_at DESC NULLS LAST
    LIMIT 1;

    SELECT jsonb_agg(
        jsonb_build_object(
            'booking_id', w.id,
            'token_number', w.token_number,
            'patient_name', w.patient_name,
            'status', w.status,
            'position', w.pos,
            'estimated_wait_minutes', w.pos * v_avg
        )
        ORDER BY w.pos
    )
    INTO v_waiting
    FROM (
        SELECT
            b.id,
            b.token_number,
            b.patient_name,
            b.status,
            ROW_NUMBER() OVER (
                ORDER BY b.priority_score DESC, b.token_number ASC
            ) AS pos
        FROM public.bookings b
        WHERE b.queue_session_id = p_queue_session_id
          AND b.status IN ('booked', 'checked_in', 'waiting')
          AND b.is_deleted = false
    ) w;

    SELECT jsonb_build_object(
        'waiting', COUNT(*) FILTER (
            WHERE b.status IN ('booked', 'checked_in', 'waiting')
        ),
        'called', COUNT(*) FILTER (WHERE b.status = 'called'),
        'in_consultation', COUNT(*) FILTER (
            WHERE b.status = 'in_consultation'
        ),
        'completed', COUNT(*) FILTER (WHERE b.status = 'completed'),
        'skipped', COUNT(*) FILTER (WHERE b.status = 'skipped'),
        'no_show', COUNT(*) FILTER (WHERE b.status = 'no_show'),
        'cancelled', COUNT(*) FILTER (WHERE b.status = 'cancelled')
    )
    INTO v_counts
    FROM public.bookings b
    WHERE b.queue_session_id = p_queue_session_id
      AND b.is_deleted = false;

    RETURN jsonb_build_object(
        'session', jsonb_build_object(
            'id', v_session.id,
            'hospital_id', v_session.hospital_id,
            'doctor_id', v_session.doctor_id,
            'session_date', v_session.session_date,
            'is_active', v_session.is_active,
            'is_paused', v_session.is_paused,
            'current_live_token', v_session.current_live_token,
            'max_tokens', v_session.max_tokens
        ),
        'average_consultation_minutes', v_avg,
        'currently_called', COALESCE(v_called, 'null'::JSONB),
        'waiting', COALESCE(v_waiting, '[]'::JSONB),
        'counts', v_counts,
        'estimated_wait_next_minutes', CASE
            WHEN v_waiting IS NULL THEN 0
            ELSE v_avg
        END,
        'generated_at', now()
    );

END;
$$;

ALTER FUNCTION public.get_queue_snapshot(UUID)
SET row_security = off;

-- =============================================================
-- 8. SLA REFRESH TRIGGER (debounced via job idempotency)
-- One compute_sla job per hospital per 5-minute bucket; bursts
-- of queue events collapse into a single recompute.
-- =============================================================

CREATE OR REPLACE FUNCTION public.trigger_sla_refresh(
    p_hospital_id UUID,
    p_date DATE DEFAULT CURRENT_DATE
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_bucket TEXT;
    v_job_id UUID;
BEGIN

    v_bucket := to_char(
        date_trunc('hour', now())
        + (
            FLOOR(EXTRACT(MINUTE FROM now()) / 5) * 5
        ) * interval '1 minute',
        'YYYYMMDDHH24MI'
    );

    SELECT public.enqueue_job(
        'compute_sla',
        jsonb_build_object(
            'hospital_id', p_hospital_id,
            'date', p_date::TEXT
        ),
        'normal',
        now(),
        'sla_' || p_hospital_id::TEXT || '_' || p_date::TEXT
            || '_' || v_bucket,
        p_hospital_id,
        NULL,
        jsonb_build_object('source', 'queue_runtime')
    )
    INTO v_job_id;

    RETURN v_job_id;

END;
$$;

ALTER FUNCTION public.trigger_sla_refresh(UUID,DATE)
SET row_security = off;

-- =============================================================
-- 9. ANALYTICS: SKIPPED RATE IN WEEKLY ROLLUPS
-- Additive column + recompute function update. Everything else
-- in the rollup stays byte-identical to migration 21.
-- =============================================================

ALTER TABLE public.analytics_weekly_rollups
    ADD COLUMN IF NOT EXISTS skipped_bookings INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.compute_weekly_rollup(
    p_hospital_id UUID,
    p_week_start DATE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_end DATE;
    v_peak_hour INTEGER;
    v_total_bookings INTEGER;
    v_completed_bookings INTEGER;
BEGIN

    v_end := p_week_start + 6;

    SELECT
        EXTRACT(HOUR FROM consultation_started_at)::INTEGER
    INTO v_peak_hour
    FROM public.bookings
    WHERE hospital_id = p_hospital_id
      AND appointment_date BETWEEN p_week_start AND v_end
      AND consultation_started_at IS NOT NULL
      AND is_deleted = false
    GROUP BY EXTRACT(HOUR FROM consultation_started_at)
    ORDER BY COUNT(*) DESC
    LIMIT 1;

    SELECT
        COUNT(*),
        COUNT(*) FILTER (WHERE status = 'completed')
    INTO
        v_total_bookings,
        v_completed_bookings
    FROM public.bookings
    WHERE hospital_id = p_hospital_id
      AND appointment_date BETWEEN p_week_start AND v_end
      AND is_deleted = false;

    INSERT INTO public.analytics_weekly_rollups (
        hospital_id,
        week_start_date,
        week_end_date,

        total_bookings,
        completed_bookings,
        cancelled_bookings,
        no_show_bookings,
        skipped_bookings,
        carry_forward_bookings,

        new_patients,
        repeat_patients,

        total_revenue_inr,
        platform_revenue_inr,
        receptionist_fees_inr,

        avg_wait_minutes,
        avg_consultation_minutes,

        peak_hour,
        completion_rate_pct,
        computed_at
    )
    SELECT
        p_hospital_id,
        p_week_start,
        v_end,

        COUNT(*),

        COUNT(*) FILTER (
            WHERE b.status = 'completed'
        ),

        COUNT(*) FILTER (
            WHERE b.status = 'cancelled'
        ),

        COUNT(*) FILTER (
            WHERE b.status = 'no_show'
        ),

        COUNT(*) FILTER (
            WHERE b.status = 'skipped'
        ),

        COUNT(*) FILTER (
            WHERE COALESCE(b.is_carry_forward, false) = true
        ),

        COUNT(*) FILTER (
            WHERE COALESCE(p.total_visits, 0) <= 1
        ),

        COUNT(*) FILTER (
            WHERE COALESCE(p.total_visits, 0) > 1
        ),

        COALESCE(SUM(b.total_amount_snapshot), 0),
        COALESCE(SUM(b.platform_fee_snapshot), 0),
        COALESCE(SUM(b.receptionist_fee_snapshot), 0),

        ROUND(
            AVG(
                EXTRACT(
                    EPOCH FROM (
                        b.consultation_started_at - b.created_at
                    )
                ) / 60
            )::NUMERIC,
            2
        ),

        ROUND(
            AVG(
                EXTRACT(
                    EPOCH FROM (
                        b.consultation_completed_at - b.consultation_started_at
                    )
                ) / 60
            )::NUMERIC,
            2
        ),

        v_peak_hour,

        CASE
            WHEN v_total_bookings > 0 THEN
                ROUND(
                    v_completed_bookings::NUMERIC
                    / v_total_bookings * 100,
                    2
                )
            ELSE 0
        END,

        now()

    FROM public.bookings b
    LEFT JOIN public.patients p
        ON p.id = b.patient_id

    WHERE b.hospital_id = p_hospital_id
      AND b.appointment_date BETWEEN p_week_start AND v_end
      AND b.is_deleted = false

    ON CONFLICT (
        hospital_id,
        week_start_date
    )
    DO UPDATE SET
        total_bookings = EXCLUDED.total_bookings,
        completed_bookings = EXCLUDED.completed_bookings,
        cancelled_bookings = EXCLUDED.cancelled_bookings,
        no_show_bookings = EXCLUDED.no_show_bookings,
        skipped_bookings = EXCLUDED.skipped_bookings,
        carry_forward_bookings = EXCLUDED.carry_forward_bookings,
        new_patients = EXCLUDED.new_patients,
        repeat_patients = EXCLUDED.repeat_patients,
        total_revenue_inr = EXCLUDED.total_revenue_inr,
        platform_revenue_inr = EXCLUDED.platform_revenue_inr,
        receptionist_fees_inr = EXCLUDED.receptionist_fees_inr,
        avg_wait_minutes = EXCLUDED.avg_wait_minutes,
        avg_consultation_minutes = EXCLUDED.avg_consultation_minutes,
        peak_hour = EXCLUDED.peak_hour,
        completion_rate_pct = EXCLUDED.completion_rate_pct,
        computed_at = now();

END;
$$;

-- =============================================================
-- 10. GRANTS
-- =============================================================

REVOKE ALL ON TABLE public.queue_runtime_events FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE
ON public.queue_runtime_events
TO service_role;
GRANT SELECT
ON public.queue_runtime_events
TO authenticated;

REVOKE ALL ON FUNCTION public.record_queue_event(UUID,TEXT,INTEGER,UUID,UUID,JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_queue_event(UUID,TEXT,INTEGER,UUID,UUID,JSONB)
    TO service_role;

REVOKE ALL ON FUNCTION public.pause_queue(UUID,TEXT,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pause_queue(UUID,TEXT,UUID)
    TO service_role;

REVOKE ALL ON FUNCTION public.resume_queue(UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resume_queue(UUID,UUID)
    TO service_role;

REVOKE ALL ON FUNCTION public.recall_current_token(UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recall_current_token(UUID,UUID)
    TO service_role;

REVOKE ALL ON FUNCTION public.skip_queue_token(UUID,UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.skip_queue_token(UUID,UUID,UUID)
    TO service_role;

REVOKE ALL ON FUNCTION public.restore_queue_token(UUID,UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.restore_queue_token(UUID,UUID,UUID)
    TO service_role;

REVOKE ALL ON FUNCTION public.mark_patient_absent(UUID,UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_patient_absent(UUID,UUID,UUID)
    TO service_role;

REVOKE ALL ON FUNCTION public.call_queue_token(UUID,INTEGER,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.call_queue_token(UUID,INTEGER,UUID)
    TO service_role;

REVOKE ALL ON FUNCTION public.get_queue_snapshot(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_queue_snapshot(UUID)
    TO service_role, authenticated;

REVOKE ALL ON FUNCTION public.trigger_sla_refresh(UUID,DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.trigger_sla_refresh(UUID,DATE)
    TO service_role;

COMMENT ON FUNCTION public.get_queue_snapshot(UUID) IS
'Phase 1.2 queue runtime: full queue state reconstruction from the database.
Recovery primitive for display screens, doctor consoles and reception after
crash/reconnect/refresh. Includes wait-time estimates from doctor throughput.';

COMMENT ON FUNCTION public.trigger_sla_refresh(UUID,DATE) IS
'Phase 1.2: debounced SLA recompute enqueue. One compute_sla job per
hospital per 5-minute bucket via job idempotency keys.';
