-- =============================================================
-- 45_queue_operations.sql
--
-- Phase 1.3 -- Operations & exception management.
--
-- Additive only:
--   1. Doctor delay state on queue_sessions (Realtime broadcast
--      piggybacks on the row update, like pause state).
--   2. Audit action registry entries (queue_control backfill for
--      Phase 1.2 + operational_alert).
--   3. Operational alert threshold defaults (global rows; hospitals
--      can override per alert_key via alert_thresholds).
--   4. resolve_alert_threshold / try_fire_queue_alert helpers over
--      the existing alert infrastructure (migration 24).
--   5. mark_doctor_delay / clear_doctor_delay control RPCs:
--      optimistic, idempotent, event-recorded.
--   6. get_queue_snapshot recreated with the SAME signature:
--      delay-aware estimates + a live health block (additive keys).
--   7. evaluate_queue_health: congestion / stall / pause /
--      throughput / SLA-breach detection called from cron-minute.
--      Fires alerts through fire_alert (1h dedupe) and records
--      operational incidents as queue_runtime_events.
--
-- Reuses: alert_thresholds, alert_events, fire_alert,
-- record_queue_event, queue_runtime_events, sla_daily_tracking.
-- No parallel queue engine; advance_queue is untouched.
-- =============================================================

-- =============================================================
-- 1. DOCTOR DELAY STATE (additive columns)
-- =============================================================

ALTER TABLE public.queue_sessions
    ADD COLUMN IF NOT EXISTS delay_expected_minutes INTEGER,
    ADD COLUMN IF NOT EXISTS delay_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS delay_reason TEXT;

ALTER TABLE public.queue_sessions
    DROP CONSTRAINT IF EXISTS chk_delay_minutes_positive;

ALTER TABLE public.queue_sessions
    ADD CONSTRAINT chk_delay_minutes_positive
    CHECK (
        delay_expected_minutes IS NULL
        OR delay_expected_minutes > 0
    );

COMMENT ON COLUMN public.queue_sessions.delay_expected_minutes IS
'Phase 1.3: expected doctor delay in minutes; NULL = on time.
Broadcast to displays via the queue_sessions Realtime publication.';

-- Extend the operational event vocabulary additively (the check
-- predates delay/stall incident events).
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
            'pause_exceeded_detected'
        )
    );

-- =============================================================
-- 2. AUDIT ACTION REGISTRY
-- The category check predates queue operations; extend it
-- additively with the new 'operations' category.
-- =============================================================

ALTER TABLE public.audit_action_types
    DROP CONSTRAINT IF EXISTS audit_action_types_category_check;

ALTER TABLE public.audit_action_types
    ADD CONSTRAINT audit_action_types_category_check
    CHECK (
        category IN (
            'authentication',
            'authorization',
            'booking',
            'payment',
            'user_management',
            'configuration',
            'data',
            'system',
            'operations'
        )
    );

INSERT INTO public.audit_action_types (
    action_type,
    display_name,
    default_severity,
    category,
    description
)
VALUES
(
    'queue_control',
    'Queue Control',
    'medium',
    'operations',
    'Live queue control action (pause/resume/recall/skip/restore/delay)'
),
(
    'operational_alert',
    'Operational Alert',
    'medium',
    'operations',
    'Operational exception detected by the queue health evaluator'
)
ON CONFLICT (action_type) DO NOTHING;

-- =============================================================
-- 3. OPERATIONAL ALERT THRESHOLD DEFAULTS
-- Global rows (hospital_id NULL); per-hospital overrides win.
-- =============================================================

INSERT INTO public.alert_thresholds (
    hospital_id,
    alert_key,
    threshold_value,
    threshold_unit,
    severity,
    notes
)
VALUES
(NULL, 'queue_wait_exceeded', 45, 'minutes', 'warning',
 'Average estimated wait across the waiting queue'),
(NULL, 'queue_length_exceeded', 25, 'count', 'warning',
 'Waiting patients in one queue session'),
(NULL, 'queue_stalled', 20, 'minutes', 'critical',
 'Queue has waiting patients but no token progress'),
(NULL, 'queue_pause_exceeded', 30, 'minutes', 'warning',
 'Queue paused longer than threshold'),
(NULL, 'queue_throughput_low', 3, 'per_hour', 'warning',
 'Completed consultations per hour below throughput'),
(NULL, 'sla_wait_breach', 60, 'minutes', 'warning',
 'SLA daily average wait time breach')
ON CONFLICT (hospital_id, alert_key)
DO NOTHING;

-- =============================================================
-- 4. THRESHOLD RESOLUTION + ALERT FIRE HELPERS
-- =============================================================

CREATE OR REPLACE FUNCTION public.resolve_alert_threshold(
    p_hospital_id UUID,
    p_alert_key TEXT,
    p_fallback NUMERIC
)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(
        (
            SELECT threshold_value
            FROM public.alert_thresholds
            WHERE hospital_id = p_hospital_id
              AND alert_key = p_alert_key
              AND is_active = true
            LIMIT 1
        ),
        (
            SELECT threshold_value
            FROM public.alert_thresholds
            WHERE hospital_id IS NULL
              AND alert_key = p_alert_key
              AND is_active = true
            LIMIT 1
        ),
        p_fallback
    );
$$;

-- Fires an alert only when no open duplicate exists (1h window,
-- matching fire_alert's own dedupe). Returns the new alert payload
-- or NULL when suppressed, so callers can record the incident
-- exactly once per alert.
CREATE OR REPLACE FUNCTION public.try_fire_queue_alert(
    p_hospital_id UUID,
    p_queue_session_id UUID,
    p_alert_key TEXT,
    p_severity public.alert_severity_level,
    p_current_value NUMERIC,
    p_threshold_value NUMERIC,
    p_threshold_unit TEXT,
    p_message TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id UUID;
BEGIN

    IF EXISTS (
        SELECT 1
        FROM public.alert_events
        WHERE hospital_id = p_hospital_id
          AND alert_key = p_alert_key
          AND severity = p_severity
          AND is_resolved = false
          AND created_at > now() - interval '1 hour'
    ) THEN
        RETURN NULL;
    END IF;

    v_id := public.fire_alert(
        p_hospital_id,
        p_alert_key,
        p_severity,
        p_current_value,
        p_threshold_value,
        p_threshold_unit,
        p_message
    );

    RETURN jsonb_build_object(
        'alert_id', v_id,
        'hospital_id', p_hospital_id,
        'queue_session_id', p_queue_session_id,
        'alert_key', p_alert_key,
        'severity', p_severity::TEXT,
        'current_value', p_current_value,
        'threshold_value', p_threshold_value,
        'message', p_message
    );

END;
$$;

-- =============================================================
-- 5. DOCTOR DELAY CONTROL RPCs (idempotent, event-recorded)
-- =============================================================

CREATE OR REPLACE FUNCTION public.mark_doctor_delay(
    p_queue_session_id UUID,
    p_minutes INTEGER,
    p_reason TEXT DEFAULT NULL,
    p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_session RECORD;
    v_event_id UUID;
BEGIN

    IF p_minutes IS NULL OR p_minutes < 1 OR p_minutes > 720 THEN
        RAISE EXCEPTION 'Delay minutes must be between 1 and 720'
            USING ERRCODE = '23514';
    END IF;

    SELECT
        id,
        delay_expected_minutes,
        delay_reason
    INTO v_session
    FROM public.queue_sessions
    WHERE id = p_queue_session_id
    FOR UPDATE;

    IF v_session.id IS NULL THEN
        RAISE EXCEPTION 'Queue session not found'
            USING ERRCODE = 'P0002';
    END IF;

    -- Idempotent: identical delay already in place.
    IF v_session.delay_expected_minutes = p_minutes
       AND COALESCE(v_session.delay_reason, '') = COALESCE(p_reason, '')
    THEN
        RETURN jsonb_build_object(
            'ok', true,
            'already_delayed', true,
            'delay_minutes', p_minutes
        );
    END IF;

    UPDATE public.queue_sessions
    SET delay_expected_minutes = p_minutes,
        delay_started_at = now(),
        delay_reason = p_reason
    WHERE id = p_queue_session_id;

    v_event_id := public.record_queue_event(
        p_queue_session_id,
        'doctor_delayed',
        NULL,
        NULL,
        p_actor_id,
        jsonb_build_object(
            'minutes', p_minutes,
            'reason', p_reason
        )
    );

    RETURN jsonb_build_object(
        'ok', true,
        'already_delayed', false,
        'delay_minutes', p_minutes,
        'event_id', v_event_id
    );

END;
$$;

CREATE OR REPLACE FUNCTION public.clear_doctor_delay(
    p_queue_session_id UUID,
    p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_session RECORD;
    v_event_id UUID;
BEGIN

    SELECT
        id,
        delay_expected_minutes,
        delay_reason
    INTO v_session
    FROM public.queue_sessions
    WHERE id = p_queue_session_id
    FOR UPDATE;

    IF v_session.id IS NULL THEN
        RAISE EXCEPTION 'Queue session not found'
            USING ERRCODE = 'P0002';
    END IF;

    -- Idempotent: nothing to clear.
    IF v_session.delay_expected_minutes IS NULL THEN
        RETURN jsonb_build_object(
            'ok', true,
            'already_clear', true
        );
    END IF;

    UPDATE public.queue_sessions
    SET delay_expected_minutes = NULL,
        delay_started_at = NULL,
        delay_reason = NULL
    WHERE id = p_queue_session_id;

    v_event_id := public.record_queue_event(
        p_queue_session_id,
        'delay_cleared',
        NULL,
        NULL,
        p_actor_id,
        jsonb_build_object(
            'previous_minutes', v_session.delay_expected_minutes,
            'previous_reason', v_session.delay_reason
        )
    );

    RETURN jsonb_build_object(
        'ok', true,
        'already_clear', false,
        'cleared', true,
        'previous_minutes', v_session.delay_expected_minutes,
        'event_id', v_event_id
    );

END;
$$;

-- =============================================================
-- 6. QUEUE SNAPSHOT (same signature; delay-aware + health block)
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
    v_delay INTEGER;
    v_actual_avg NUMERIC;
    v_called JSONB;
    v_waiting JSONB;
    v_counts JSONB;
    v_waiting_count INTEGER;
    v_called_count INTEGER;
    v_completed_count INTEGER;
    v_last_progress TIMESTAMPTZ;
    v_elapsed_hrs NUMERIC;
BEGIN

    SELECT
        id,
        hospital_id,
        doctor_id,
        session_date,
        is_active,
        is_paused,
        pause_reason,
        current_live_token,
        max_tokens,
        paused_at,
        created_at,
        started_at,
        delay_expected_minutes,
        delay_reason,
        delay_started_at
    INTO v_session
    FROM public.queue_sessions
    WHERE id = p_queue_session_id;

    IF v_session.id IS NULL THEN
        RETURN NULL;
    END IF;

    v_delay := COALESCE(v_session.delay_expected_minutes, 0);

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

    -- Actual average consultation duration observed in this session
    -- (doctor throughput monitoring).
    SELECT ROUND(
        AVG(
            EXTRACT(EPOCH FROM (
                b.consultation_completed_at - b.consultation_started_at
            )) / 60.0
        )::NUMERIC,
        1
    )
    INTO v_actual_avg
    FROM public.bookings b
    WHERE b.queue_session_id = p_queue_session_id
      AND b.status = 'completed'
      AND b.consultation_started_at IS NOT NULL
      AND b.consultation_completed_at IS NOT NULL
      AND b.is_deleted = false;

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

    -- Waiting list; estimates now include the declared doctor delay.
    SELECT jsonb_agg(
        jsonb_build_object(
            'booking_id', w.id,
            'token_number', w.token_number,
            'patient_name', w.patient_name,
            'status', w.status,
            'position', w.pos,
            'estimated_wait_minutes', w.pos * v_avg + v_delay
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

    v_waiting_count := COALESCE((v_counts->>'waiting')::INTEGER, 0);
    v_called_count := COALESCE((v_counts->>'called')::INTEGER, 0);
    v_completed_count := COALESCE((v_counts->>'completed')::INTEGER, 0);

    -- Last queue progress: advance or manual call.
    SELECT GREATEST(
        v_session.created_at,
        COALESCE(MAX(e.created_at), v_session.created_at)
    )
    INTO v_last_progress
    FROM public.queue_runtime_events e
    WHERE e.queue_session_id = p_queue_session_id
      AND e.event_type IN ('advanced', 'manually_called');

    v_elapsed_hrs := GREATEST(
        EXTRACT(EPOCH FROM (
            now() - COALESCE(v_session.started_at, v_session.created_at)
        )) / 3600.0,
        1.0 / 60.0
    );

    RETURN jsonb_build_object(
        'session', jsonb_build_object(
            'id', v_session.id,
            'hospital_id', v_session.hospital_id,
            'doctor_id', v_session.doctor_id,
            'session_date', v_session.session_date,
            'is_active', v_session.is_active,
            'is_paused', v_session.is_paused,
            'pause_reason', v_session.pause_reason,
            'current_live_token', v_session.current_live_token,
            'max_tokens', v_session.max_tokens,
            'delay_expected_minutes', v_session.delay_expected_minutes,
            'delay_reason', v_session.delay_reason,
            'delay_started_at', v_session.delay_started_at
        ),
        'average_consultation_minutes', v_avg,
        'currently_called', COALESCE(v_called, 'null'::JSONB),
        'waiting', COALESCE(v_waiting, '[]'::JSONB),
        'counts', v_counts,
        'estimated_wait_next_minutes', CASE
            WHEN v_waiting IS NULL THEN 0
            ELSE v_avg + v_delay
        END,
        'health', jsonb_build_object(
            'delay_active', v_delay > 0,
            'delay_expected_minutes', v_delay,
            'actual_avg_consultation_minutes', COALESCE(v_actual_avg, v_avg),
            'throughput_per_hour', ROUND(v_completed_count / v_elapsed_hrs, 1),
            'avg_estimated_wait_minutes', CASE
                WHEN v_waiting_count = 0 THEN 0
                ELSE ROUND(v_avg * (v_waiting_count + 1) / 2.0 + v_delay, 1)
            END,
            'estimated_completion_at', to_char(
                now() + (
                    (v_waiting_count + v_called_count) * v_avg + v_delay
                ) * interval '1 minute',
                'YYYY-MM-DD"T"HH24:MI:SS"Z"'
            ),
            'last_progress_at', v_last_progress,
            'stalled_minutes', ROUND(
                EXTRACT(EPOCH FROM (now() - v_last_progress)) / 60.0,
                1
            ),
            'paused_minutes', CASE
                WHEN v_session.is_paused AND v_session.paused_at IS NOT NULL
                THEN ROUND(
                    EXTRACT(EPOCH FROM (now() - v_session.paused_at)) / 60.0,
                    1
                )
                ELSE 0
            END
        ),
        'generated_at', now()
    );

END;
$$;

ALTER FUNCTION public.get_queue_snapshot(UUID)
SET row_security = off;

-- =============================================================
-- 7. QUEUE HEALTH EVALUATOR (cron-minute)
-- Detects congestion, stalls, long pauses, low throughput and SLA
-- breaches for every active session today. Alerts are deduped by
-- try_fire_queue_alert (1h window); incidents are recorded as
-- queue_runtime_events exactly once per fired alert.
-- =============================================================

CREATE OR REPLACE FUNCTION public.evaluate_queue_health()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_s RECORD;
    v_waiting INTEGER;
    v_completed INTEGER;
    v_avg INTEGER;
    v_delay INTEGER;
    v_est_avg_wait NUMERIC;
    v_last_progress TIMESTAMPTZ;
    v_elapsed_secs NUMERIC;
    v_thr NUMERIC;
    v_alert JSONB;
    v_new_alerts JSONB := '[]'::JSONB;
    v_sessions INTEGER := 0;
    v_hosp UUID;
    v_sla_wait NUMERIC;
    v_stall_min NUMERIC;
    v_pause_min NUMERIC;
    v_throughput NUMERIC;
BEGIN

    FOR v_s IN
        SELECT
            id,
            hospital_id,
            doctor_id,
            session_date,
            is_paused,
            paused_at,
            delay_expected_minutes,
            created_at,
            started_at
        FROM public.queue_sessions
        WHERE is_active = true
          AND session_date = CURRENT_DATE
    LOOP
        v_sessions := v_sessions + 1;
        v_delay := COALESCE(v_s.delay_expected_minutes, 0);

        SELECT
            COUNT(*) FILTER (
                WHERE b.status IN ('booked', 'checked_in', 'waiting')
            ),
            COUNT(*) FILTER (WHERE b.status = 'completed')
        INTO v_waiting, v_completed
        FROM public.bookings b
        WHERE b.queue_session_id = v_s.id
          AND b.is_deleted = false;

        SELECT ds.average_consultation_minutes
        INTO v_avg
        FROM public.doctor_schedules ds
        WHERE ds.doctor_id = v_s.doctor_id
          AND ds.hospital_id = v_s.hospital_id
          AND ds.weekday = EXTRACT(DOW FROM v_s.session_date)::INTEGER
          AND ds.is_active = true
          AND ds.is_deleted = false
        ORDER BY ds.start_time
        LIMIT 1;

        v_avg := COALESCE(v_avg, 10);

        v_est_avg_wait := CASE
            WHEN v_waiting > 0
            THEN ROUND(v_avg * (v_waiting + 1) / 2.0 + v_delay, 1)
            ELSE 0
        END;

        -- (a) Average estimated wait exceeds threshold
        IF v_waiting > 0 THEN
            v_thr := public.resolve_alert_threshold(
                v_s.hospital_id, 'queue_wait_exceeded', 45
            );

            IF v_est_avg_wait > v_thr THEN
                v_alert := public.try_fire_queue_alert(
                    v_s.hospital_id,
                    v_s.id,
                    'queue_wait_exceeded',
                    'warning'::public.alert_severity_level,
                    v_est_avg_wait,
                    v_thr,
                    'minutes',
                    format(
                        'Average estimated wait %s min exceeds %s min (session %s)',
                        ROUND(v_est_avg_wait, 1),
                        v_thr,
                        v_s.id
                    )
                );

                IF v_alert IS NOT NULL THEN
                    v_new_alerts := v_new_alerts || v_alert;
                END IF;
            END IF;
        END IF;

        -- (b) Queue length exceeds threshold (congestion)
        v_thr := public.resolve_alert_threshold(
            v_s.hospital_id, 'queue_length_exceeded', 25
        );

        IF v_waiting > v_thr THEN
            v_alert := public.try_fire_queue_alert(
                v_s.hospital_id,
                v_s.id,
                'queue_length_exceeded',
                'warning'::public.alert_severity_level,
                v_waiting,
                v_thr,
                'count',
                format(
                    'Queue has %s waiting patients (threshold %s) in session %s',
                    v_waiting,
                    v_thr,
                    v_s.id
                )
            );

            IF v_alert IS NOT NULL THEN
                v_new_alerts := v_new_alerts || v_alert;
            END IF;
        END IF;

        -- (c) Stalled queue: waiting patients but no token progress.
        -- Paused queues are handled by the pause check instead.
        IF v_waiting > 0 AND NOT v_s.is_paused THEN
            SELECT GREATEST(
                v_s.created_at,
                COALESCE(MAX(e.created_at), v_s.created_at)
            )
            INTO v_last_progress
            FROM public.queue_runtime_events e
            WHERE e.queue_session_id = v_s.id
              AND e.event_type IN ('advanced', 'manually_called');

            v_thr := public.resolve_alert_threshold(
                v_s.hospital_id, 'queue_stalled', 20
            );

            v_stall_min := ROUND(
                EXTRACT(EPOCH FROM (now() - v_last_progress)) / 60.0,
                1
            );

            IF v_stall_min > v_thr
            THEN
                v_alert := public.try_fire_queue_alert(
                    v_s.hospital_id,
                    v_s.id,
                    'queue_stalled',
                    'critical'::public.alert_severity_level,
                    v_stall_min,
                    v_thr,
                    'minutes',
                    format(
                        'Queue stalled: no token progress for %s min with %s waiting (session %s)',
                        v_stall_min,
                        v_waiting,
                        v_s.id
                    )
                );

                IF v_alert IS NOT NULL THEN
                    v_new_alerts := v_new_alerts || v_alert;

                    -- Incident record, exactly once per fired alert.
                    PERFORM public.record_queue_event(
                        v_s.id,
                        'stalled_detected',
                        NULL,
                        NULL,
                        NULL,
                        jsonb_build_object(
                            'stalled_minutes', v_stall_min,
                            'waiting_count', v_waiting,
                            'recovery_suggestion', CASE
                                WHEN v_delay > 0
                                THEN 'Doctor delay active: verify delay is current or clear it, then advance the queue'
                                ELSE 'Advance or manually call the next token; if the doctor is unavailable, pause the queue with a reason'
                            END
                        )
                    );
                END IF;
            END IF;
        END IF;

        -- (d) Pause duration exceeds threshold
        IF v_s.is_paused AND v_s.paused_at IS NOT NULL THEN
            v_thr := public.resolve_alert_threshold(
                v_s.hospital_id, 'queue_pause_exceeded', 30
            );

            v_pause_min := ROUND(
                EXTRACT(EPOCH FROM (now() - v_s.paused_at)) / 60.0,
                1
            );

            IF v_pause_min > v_thr
            THEN
                v_alert := public.try_fire_queue_alert(
                    v_s.hospital_id,
                    v_s.id,
                    'queue_pause_exceeded',
                    'warning'::public.alert_severity_level,
                    v_pause_min,
                    v_thr,
                    'minutes',
                    format(
                        'Queue paused for %s min (threshold %s) in session %s',
                        v_pause_min,
                        v_thr,
                        v_s.id
                    )
                );

                IF v_alert IS NOT NULL THEN
                    v_new_alerts := v_new_alerts || v_alert;

                    PERFORM public.record_queue_event(
                        v_s.id,
                        'pause_exceeded_detected',
                        NULL,
                        NULL,
                        NULL,
                        jsonb_build_object(
                            'paused_minutes', v_pause_min,
                            'recovery_suggestion',
                            'Resume the queue or end the session and reschedule waiting patients'
                        )
                    );
                END IF;
            END IF;
        END IF;

        -- (e) Doctor throughput drop. Skipped when a delay is
        -- declared (the hospital already knows) or the session is
        -- younger than 30 minutes (not enough signal).
        IF v_delay = 0 AND v_waiting > 0 AND NOT v_s.is_paused THEN
            v_elapsed_secs := EXTRACT(EPOCH FROM (
                now() - COALESCE(v_s.started_at, v_s.created_at)
            ));

            IF v_elapsed_secs >= 1800 THEN
                v_thr := public.resolve_alert_threshold(
                    v_s.hospital_id, 'queue_throughput_low', 3
                );

                v_throughput := ROUND(
                    v_completed / GREATEST(v_elapsed_secs / 3600.0, 0.5),
                    1
                );

                IF v_throughput < v_thr
                THEN
                    v_alert := public.try_fire_queue_alert(
                        v_s.hospital_id,
                        v_s.id,
                        'queue_throughput_low',
                        'warning'::public.alert_severity_level,
                        v_throughput,
                        v_thr,
                        'per_hour',
                        format(
                            'Throughput %s consultations/hour below %s with %s waiting (session %s)',
                            v_throughput,
                            v_thr,
                            v_waiting,
                            v_s.id
                        )
                    );

                    IF v_alert IS NOT NULL THEN
                        v_new_alerts := v_new_alerts || v_alert;
                    END IF;
                END IF;
            END IF;
        END IF;
    END LOOP;

    -- (f) SLA breach alerts (hospital level, hospitals with an
    -- active session today).
    FOR v_hosp IN
        SELECT DISTINCT hospital_id
        FROM public.queue_sessions
        WHERE is_active = true
          AND session_date = CURRENT_DATE
    LOOP
        v_thr := public.resolve_alert_threshold(
            v_hosp, 'sla_wait_breach', 60
        );

        SELECT s.avg_wait_minutes
        INTO v_sla_wait
        FROM public.sla_daily_tracking s
        WHERE s.hospital_id = v_hosp
          AND s.tracking_date = CURRENT_DATE;

        IF v_sla_wait IS NOT NULL AND v_sla_wait > v_thr THEN
            v_alert := public.try_fire_queue_alert(
                v_hosp,
                NULL,
                'sla_wait_breach',
                'warning'::public.alert_severity_level,
                v_sla_wait,
                v_thr,
                'minutes',
                format(
                    'SLA breach: average wait %s min exceeds %s min today',
                    ROUND(v_sla_wait, 1),
                    v_thr
                )
            );

            IF v_alert IS NOT NULL THEN
                v_new_alerts := v_new_alerts || v_alert;
            END IF;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'evaluated_at', now(),
        'sessions_evaluated', v_sessions,
        'new_alerts', v_new_alerts
    );

END;
$$;

-- =============================================================
-- 8. GRANTS
-- =============================================================

REVOKE ALL ON FUNCTION public.resolve_alert_threshold(UUID, TEXT, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_alert_threshold(UUID, TEXT, NUMERIC)
    TO service_role;

REVOKE ALL ON FUNCTION public.try_fire_queue_alert(UUID, UUID, TEXT, public.alert_severity_level, NUMERIC, NUMERIC, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.try_fire_queue_alert(UUID, UUID, TEXT, public.alert_severity_level, NUMERIC, NUMERIC, TEXT, TEXT)
    TO service_role;

REVOKE ALL ON FUNCTION public.mark_doctor_delay(UUID, INTEGER, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_doctor_delay(UUID, INTEGER, TEXT, UUID)
    TO service_role;

REVOKE ALL ON FUNCTION public.clear_doctor_delay(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clear_doctor_delay(UUID, UUID)
    TO service_role;

REVOKE ALL ON FUNCTION public.evaluate_queue_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.evaluate_queue_health()
    TO service_role;

COMMENT ON FUNCTION public.mark_doctor_delay(UUID, INTEGER, TEXT, UUID) IS
'Phase 1.3: declare/adjust a doctor delay for a queue session. Idempotent
for identical (minutes, reason); records a doctor_delayed operational event.';

COMMENT ON FUNCTION public.clear_doctor_delay(UUID, UUID) IS
'Phase 1.3: clear a doctor delay. Idempotent; records a delay_cleared
operational event with the previous delay in metadata.';

COMMENT ON FUNCTION public.evaluate_queue_health() IS
'Phase 1.3: cron-minute operational evaluator. Detects wait/length/stall/
pause/throughput exceptions per active session and SLA breaches per
hospital. Alerts are deduped (1h); incidents recorded once per alert.';
