-- =============================================================
-- 47_enterprise_command_center.sql
--
-- Phase 1.5 - Hospital Command Center & Executive Operations.
--
-- Additive only. Reuses: queue runtime (queue_sessions,
-- queue_runtime_events, get_queue_snapshot), doctor operations
-- (migration 46 RPCs), financial_ledger / daily_collection_entries
-- / hospital_settlements, sla_daily_tracking, alert_events +
-- fire_alert, audit engine. No existing signature changes.
--
-- Sections:
--   1. Audit action registry (alert_center / compliance_check /
--      executive_report).
--   2. Alert center: alert_events lifecycle columns, activity
--      log, suppression windows, lifecycle RPCs, fire_managed_alert.
--   3. Operational timeline (get_hospital_timeline).
--   4. Hospital command center (get_hospital_command_center).
--   5. Executive dashboards (daily / weekly / monthly).
--   6. Doctor performance intelligence + rankings.
--   7. Financial command center + forecasts.
--   8. SLA dashboard + operational scores.
--   9. Multi-hospital portfolio + benchmarks.
--  10. Predictive operations analytics.
--  11. Executive reporting engine.
--  12. Governance: audit search + integrity verification.
--  13. Grants (service_role only).
-- =============================================================

-- =============================================================
-- 1. AUDIT ACTION REGISTRY (additive)
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
    'alert_center',
    'Alert Center Action',
    'low',
    'operations',
    'Alert lifecycle management (acknowledge, assign, resolve, escalate, suppress)'
),
(
    'compliance_check',
    'Compliance Check',
    'low',
    'system',
    'Enterprise integrity verification and executive audit search'
),
(
    'executive_report',
    'Executive Report',
    'low',
    'operations',
    'Executive report generation (daily, weekly, monthly, financial, SLA, audit)'
)
ON CONFLICT (action_type) DO NOTHING;

-- =============================================================
-- 2. ALERT CENTER
-- Enterprise lifecycle on top of the existing alert_events
-- table: acknowledgment, assignment, escalation, suppression
-- windows and an append-only activity log. Resolution already
-- exists (is_resolved / resolved_at / resolved_by).
-- =============================================================

ALTER TABLE public.alert_events
    ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS acknowledged_by UUID,
    ADD COLUMN IF NOT EXISTS assigned_to UUID,
    ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS escalated_by UUID,
    ADD COLUMN IF NOT EXISTS resolution_notes TEXT,
    ADD COLUMN IF NOT EXISTS alert_category TEXT NOT NULL DEFAULT 'operational';

CREATE INDEX IF NOT EXISTS idx_alert_events_open
ON public.alert_events(hospital_id, is_resolved, created_at DESC);

CREATE TABLE IF NOT EXISTS public.alert_activity_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id UUID NOT NULL
        REFERENCES public.alert_events(id)
        ON DELETE CASCADE,
    hospital_id UUID
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,
    actor_user_id UUID,
    action TEXT NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alert_activity_alert
ON public.alert_activity_log(alert_id, created_at);

CREATE TABLE IF NOT EXISTS public.alert_suppressions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hospital_id UUID
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,
    alert_key TEXT NOT NULL,
    reason TEXT,
    active_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    active_until TIMESTAMPTZ NOT NULL,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_suppression_window
        CHECK (active_until > active_from)
);

CREATE INDEX IF NOT EXISTS idx_alert_suppressions_active
ON public.alert_suppressions(alert_key, active_until);

CREATE OR REPLACE FUNCTION public.is_alert_suppressed(
    p_hospital_id UUID,
    p_alert_key TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.alert_suppressions s
        WHERE s.alert_key = p_alert_key
          AND (
              s.hospital_id = p_hospital_id
              OR s.hospital_id IS NULL
          )
          AND now() BETWEEN s.active_from AND s.active_until
    );
$$;

CREATE OR REPLACE FUNCTION public.log_alert_activity(
    p_alert_id UUID,
    p_hospital_id UUID,
    p_actor_id UUID,
    p_action TEXT,
    p_notes TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE sql
SET search_path = public
AS $$
    INSERT INTO public.alert_activity_log (
        alert_id,
        hospital_id,
        actor_user_id,
        action,
        notes
    )
    VALUES (
        p_alert_id,
        p_hospital_id,
        p_actor_id,
        p_action,
        p_notes
    );
$$;

CREATE OR REPLACE FUNCTION public.acknowledge_alert(
    p_alert_id UUID,
    p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_alert RECORD;
BEGIN

    SELECT id, hospital_id, acknowledged_at, is_resolved
    INTO v_alert
    FROM public.alert_events
    WHERE id = p_alert_id
    FOR UPDATE;

    IF v_alert.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'alert_not_found');
    END IF;

    IF v_alert.acknowledged_at IS NOT NULL THEN
        RETURN jsonb_build_object('ok', true, 'already_acknowledged', true);
    END IF;

    UPDATE public.alert_events
    SET
        acknowledged_at = now(),
        acknowledged_by = p_actor_id
    WHERE id = p_alert_id;

    PERFORM public.log_alert_activity(
        p_alert_id, v_alert.hospital_id, p_actor_id, 'acknowledged', NULL
    );

    RETURN jsonb_build_object('ok', true, 'already_acknowledged', false);

END;
$$;

CREATE OR REPLACE FUNCTION public.assign_alert(
    p_alert_id UUID,
    p_assignee_id UUID,
    p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_alert RECORD;
BEGIN

    SELECT id, hospital_id, assigned_to
    INTO v_alert
    FROM public.alert_events
    WHERE id = p_alert_id
    FOR UPDATE;

    IF v_alert.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'alert_not_found');
    END IF;

    IF v_alert.assigned_to IS NOT DISTINCT FROM p_assignee_id THEN
        RETURN jsonb_build_object('ok', true, 'already_assigned', true);
    END IF;

    UPDATE public.alert_events
    SET
        assigned_to = p_assignee_id,
        assigned_at = now()
    WHERE id = p_alert_id;

    PERFORM public.log_alert_activity(
        p_alert_id,
        v_alert.hospital_id,
        p_actor_id,
        'assigned',
        p_assignee_id::text
    );

    RETURN jsonb_build_object('ok', true, 'already_assigned', false);

END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_alert(
    p_alert_id UUID,
    p_actor_id UUID,
    p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_alert RECORD;
BEGIN

    SELECT id, hospital_id, is_resolved
    INTO v_alert
    FROM public.alert_events
    WHERE id = p_alert_id
    FOR UPDATE;

    IF v_alert.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'alert_not_found');
    END IF;

    IF v_alert.is_resolved THEN
        RETURN jsonb_build_object('ok', true, 'already_resolved', true);
    END IF;

    UPDATE public.alert_events
    SET
        is_resolved = true,
        resolved_at = now(),
        resolved_by = p_actor_id,
        resolution_notes = p_notes
    WHERE id = p_alert_id;

    PERFORM public.log_alert_activity(
        p_alert_id, v_alert.hospital_id, p_actor_id, 'resolved', p_notes
    );

    RETURN jsonb_build_object('ok', true, 'already_resolved', false);

END;
$$;

CREATE OR REPLACE FUNCTION public.escalate_alert(
    p_alert_id UUID,
    p_actor_id UUID,
    p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_alert RECORD;
BEGIN

    SELECT id, hospital_id, escalated_at, severity
    INTO v_alert
    FROM public.alert_events
    WHERE id = p_alert_id
    FOR UPDATE;

    IF v_alert.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'alert_not_found');
    END IF;

    IF v_alert.escalated_at IS NOT NULL THEN
        RETURN jsonb_build_object('ok', true, 'already_escalated', true);
    END IF;

    UPDATE public.alert_events
    SET
        escalated_at = now(),
        escalated_by = p_actor_id,
        severity = 'critical'::public.alert_severity_level
    WHERE id = p_alert_id;

    PERFORM public.log_alert_activity(
        p_alert_id, v_alert.hospital_id, p_actor_id, 'escalated', p_notes
    );

    RETURN jsonb_build_object('ok', true, 'already_escalated', false);

END;
$$;

CREATE OR REPLACE FUNCTION public.suppress_alerts(
    p_alert_key TEXT,
    p_active_until TIMESTAMPTZ,
    p_actor_id UUID,
    p_hospital_id UUID DEFAULT NULL,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id UUID;
BEGIN

    IF p_active_until <= now() THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'window_in_past');
    END IF;

    INSERT INTO public.alert_suppressions (
        hospital_id,
        alert_key,
        reason,
        active_until,
        created_by
    )
    VALUES (
        p_hospital_id,
        p_alert_key,
        p_reason,
        p_active_until,
        p_actor_id
    )
    RETURNING id INTO v_id;

    RETURN jsonb_build_object('ok', true, 'suppression_id', v_id);

END;
$$;

-- Suppression-aware wrapper around fire_alert. Suppressed keys are
-- dropped silently (maintenance window semantics); everything else
-- inherits fire_alert's 1-hour dedupe unchanged.
CREATE OR REPLACE FUNCTION public.fire_managed_alert(
    p_hospital_id UUID,
    p_alert_key TEXT,
    p_severity public.alert_severity_level,
    p_current_value NUMERIC,
    p_threshold_value NUMERIC,
    p_threshold_unit TEXT,
    p_message TEXT,
    p_category TEXT DEFAULT 'operational'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id UUID;
BEGIN

    IF public.is_alert_suppressed(p_hospital_id, p_alert_key) THEN
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

    IF v_id IS NOT NULL THEN
        UPDATE public.alert_events
        SET alert_category = p_category
        WHERE id = v_id;
    END IF;

    RETURN v_id;

END;
$$;

CREATE OR REPLACE FUNCTION public.get_alert_center(
    p_hospital_id UUID DEFAULT NULL,
    p_status TEXT DEFAULT 'open',
    p_severity TEXT DEFAULT NULL,
    p_category TEXT DEFAULT NULL,
    p_limit INTEGER DEFAULT 50
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_alerts JSONB;
    v_counts JSONB;
BEGIN

    SELECT jsonb_agg(row_to_json(a)::jsonb ORDER BY a.created_at DESC)
    INTO v_alerts
    FROM (
        SELECT
            ae.id,
            ae.hospital_id,
            ae.alert_key,
            ae.alert_category,
            ae.severity::text AS severity,
            ae.current_value,
            ae.threshold_value,
            ae.message,
            ae.is_resolved,
            ae.acknowledged_at,
            ae.assigned_to,
            ae.escalated_at,
            ae.created_at,
            ae.resolved_at
        FROM public.alert_events ae
        WHERE (p_hospital_id IS NULL OR ae.hospital_id = p_hospital_id)
          AND (
              p_status = 'all'
              OR (p_status = 'open' AND ae.is_resolved = false)
              OR (p_status = 'resolved' AND ae.is_resolved = true)
          )
          AND (p_severity IS NULL OR ae.severity = p_severity::public.alert_severity_level)
          AND (p_category IS NULL OR ae.alert_category = p_category)
        ORDER BY ae.created_at DESC
        LIMIT LEAST(GREATEST(p_limit, 1), 500)
    ) a;

    SELECT jsonb_build_object(
        'open', COUNT(*) FILTER (WHERE ae.is_resolved = false),
        'acknowledged', COUNT(*) FILTER (
            WHERE ae.is_resolved = false AND ae.acknowledged_at IS NOT NULL
        ),
        'escalated', COUNT(*) FILTER (
            WHERE ae.is_resolved = false AND ae.escalated_at IS NOT NULL
        ),
        'critical_open', COUNT(*) FILTER (
            WHERE ae.is_resolved = false AND ae.severity = 'critical'
        )
    )
    INTO v_counts
    FROM public.alert_events ae
    WHERE (p_hospital_id IS NULL OR ae.hospital_id = p_hospital_id);

    RETURN jsonb_build_object(
        'alerts', COALESCE(v_alerts, '[]'::jsonb),
        'counts', v_counts
    );

END;
$$;

CREATE OR REPLACE FUNCTION public.get_alert_analytics(
    p_hospital_id UUID DEFAULT NULL,
    p_from_date DATE DEFAULT CURRENT_DATE - 30,
    p_to_date DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_by_key JSONB;
    v_summary JSONB;
BEGIN

    SELECT jsonb_agg(row_to_json(k)::jsonb ORDER BY k.total DESC)
    INTO v_by_key
    FROM (
        SELECT
            ae.alert_key,
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE ae.is_resolved) AS resolved,
            ROUND(AVG(
                EXTRACT(EPOCH FROM (
                    COALESCE(ae.resolved_at, now()) - ae.created_at
                )) / 60.0
            ), 1) AS avg_resolution_minutes
        FROM public.alert_events ae
        WHERE (p_hospital_id IS NULL OR ae.hospital_id = p_hospital_id)
          AND ae.created_at::date BETWEEN p_from_date AND p_to_date
        GROUP BY ae.alert_key
    ) k;

    SELECT jsonb_build_object(
        'total', COUNT(*),
        'resolved', COUNT(*) FILTER (WHERE ae.is_resolved),
        'avg_resolution_minutes', ROUND(AVG(
            EXTRACT(EPOCH FROM (
                COALESCE(ae.resolved_at, now()) - ae.created_at
            )) / 60.0
        ), 1)
    )
    INTO v_summary
    FROM public.alert_events ae
    WHERE (p_hospital_id IS NULL OR ae.hospital_id = p_hospital_id)
      AND ae.created_at::date BETWEEN p_from_date AND p_to_date;

    RETURN jsonb_build_object(
        'summary', v_summary,
        'by_alert_key', COALESCE(v_by_key, '[]'::jsonb)
    );

END;
$$;

-- =============================================================
-- 3. OPERATIONAL TIMELINE
-- One chronological stream over the existing event feeds:
-- booking_events, queue_runtime_events, payment_events,
-- alert_events and financial_ledger. No new storage.
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_hospital_timeline(
    p_hospital_id UUID,
    p_from_ts TIMESTAMPTZ DEFAULT now() - interval '24 hours',
    p_to_ts TIMESTAMPTZ DEFAULT now(),
    p_event_types TEXT[] DEFAULT NULL,
    p_severity TEXT DEFAULT NULL,
    p_doctor_id UUID DEFAULT NULL,
    p_queue_session_id UUID DEFAULT NULL,
    p_limit INTEGER DEFAULT 100
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_events JSONB;
BEGIN

    SELECT jsonb_agg(row_to_json(e)::jsonb ORDER BY e.ts DESC)
    INTO v_events
    FROM (
        -- Booking lifecycle (created / status transitions).
        SELECT
            be.created_at AS ts,
            'booking' AS category,
            COALESCE(be.event_type, 'status_changed') AS event_type,
            'info' AS severity,
            'booking' AS entity_type,
            be.booking_id AS entity_id,
            b.assigned_doctor_id AS doctor_id,
            b.queue_session_id,
            jsonb_build_object(
                'old_status', be.old_status::text,
                'new_status', be.new_status::text
            ) AS metadata
        FROM public.booking_events be
        LEFT JOIN public.bookings b ON b.id = be.booking_id
        WHERE be.hospital_id = p_hospital_id
          AND be.created_at BETWEEN p_from_ts AND p_to_ts

        UNION ALL

        -- Queue runtime events (calls, pauses, delays, sessions,
        -- emergencies - the clinical operations stream).
        SELECT
            qe.created_at AS ts,
            'queue' AS category,
            qe.event_type,
            CASE qe.event_type
                WHEN 'emergency_inserted' THEN 'warning'
                WHEN 'doctor_delayed' THEN 'warning'
                WHEN 'stalled_detected' THEN 'critical'
                WHEN 'pause_exceeded_detected' THEN 'warning'
                ELSE 'info'
            END AS severity,
            'queue_session' AS entity_type,
            qe.queue_session_id AS entity_id,
            qe.actor_id AS doctor_id,
            qe.queue_session_id,
            qe.metadata
        FROM public.queue_runtime_events qe
        WHERE qe.hospital_id = p_hospital_id
          AND qe.created_at BETWEEN p_from_ts AND p_to_ts

        UNION ALL

        -- Settlement lifecycle from the immutable ledger.
        SELECT
            fl.created_at AS ts,
            'financial' AS category,
            fl.entry_type::text AS event_type,
            'info' AS severity,
            'settlement' AS entity_type,
            fl.settlement_id AS entity_id,
            NULL::uuid AS doctor_id,
            NULL::uuid AS queue_session_id,
            jsonb_build_object(
                'amount_inr', fl.amount_inr,
                'is_credit', fl.is_credit
            ) AS metadata
        FROM public.financial_ledger fl
        WHERE fl.hospital_id = p_hospital_id
          AND fl.settlement_id IS NOT NULL
          AND fl.created_at BETWEEN p_from_ts AND p_to_ts

        UNION ALL

        -- Alerts (SLA breach, congestion, stalls...).
        SELECT
            ae.created_at AS ts,
            'alert' AS category,
            ae.alert_key AS event_type,
            CASE ae.severity
                WHEN 'critical' THEN 'critical'
                WHEN 'warning' THEN 'warning'
                ELSE 'info'
            END AS severity,
            'alert' AS entity_type,
            ae.id AS entity_id,
            NULL::uuid AS doctor_id,
            NULL::uuid AS queue_session_id,
            jsonb_build_object(
                'current_value', ae.current_value,
                'threshold_value', ae.threshold_value,
                'message', ae.message
            ) AS metadata
        FROM public.alert_events ae
        WHERE ae.hospital_id = p_hospital_id
          AND ae.created_at BETWEEN p_from_ts AND p_to_ts
    ) e
    WHERE (p_event_types IS NULL OR e.event_type = ANY (p_event_types))
      AND (p_severity IS NULL OR e.severity = p_severity)
      AND (p_doctor_id IS NULL OR e.doctor_id = p_doctor_id)
      AND (
          p_queue_session_id IS NULL
          OR e.queue_session_id = p_queue_session_id
      )
    ORDER BY e.ts DESC
    LIMIT LEAST(GREATEST(p_limit, 1), 1000);

    RETURN jsonb_build_object(
        'hospital_id', p_hospital_id,
        'from', p_from_ts,
        'to', p_to_ts,
        'events', COALESCE(v_events, '[]'::jsonb)
    );

END;
$$;

-- =============================================================
-- 4. HOSPITAL COMMAND CENTER
-- Live aggregation over bookings, queue runtime, SLA tracking,
-- collections and outstanding balances. All numbers come from
-- the frozen source-of-truth tables.
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_hospital_command_center(
    p_hospital_id UUID,
    p_date DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_patients JSONB;
    v_queues JSONB;
    v_sla JSONB;
    v_finance JSONB;
    v_queue_health JSONB;
BEGIN

    -- Patient flow for the day.
    SELECT jsonb_build_object(
        'total_today', COUNT(*),
        'waiting', COUNT(*) FILTER (WHERE b.status = 'waiting'),
        'called', COUNT(*) FILTER (WHERE b.status = 'called'),
        'in_consultation', COUNT(*) FILTER (
            WHERE b.status = 'in_consultation'
        ),
        'completed', COUNT(*) FILTER (WHERE b.status = 'completed'),
        'cancelled', COUNT(*) FILTER (WHERE b.status = 'cancelled'),
        'no_shows', COUNT(*) FILTER (WHERE b.status = 'no_show'),
        'skipped', COUNT(*) FILTER (WHERE b.status = 'skipped'),
        'checked_in', COUNT(*) FILTER (WHERE b.status = 'checked_in'),
        'avg_wait_minutes', ROUND(AVG(
            EXTRACT(EPOCH FROM (
                b.consultation_started_at - b.checked_in_at
            )) / 60.0
        ) FILTER (
            WHERE b.consultation_started_at IS NOT NULL
              AND b.checked_in_at IS NOT NULL
        ), 1),
        'avg_consultation_minutes', ROUND(AVG(
            EXTRACT(EPOCH FROM (
                b.consultation_completed_at - b.consultation_started_at
            )) / 60.0
        ) FILTER (
            WHERE b.consultation_completed_at IS NOT NULL
              AND b.consultation_started_at IS NOT NULL
        ), 1)
    )
    INTO v_patients
    FROM public.bookings b
    WHERE b.hospital_id = p_hospital_id
      AND b.appointment_date = p_date
      AND b.is_deleted = false;

    -- Queue runtime state: sessions, pauses, delays, stalls,
    -- active consultations.
    SELECT jsonb_build_object(
        'active_sessions', COUNT(*) FILTER (WHERE qs.is_active),
        'paused_queues', COUNT(*) FILTER (
            WHERE qs.is_active AND qs.is_paused
        ),
        'delayed_doctors', COUNT(*) FILTER (
            WHERE qs.is_active AND qs.delay_expected_minutes IS NOT NULL
        ),
        'stalled_queues', COUNT(*) FILTER (
            WHERE qs.is_active
              AND NOT qs.is_paused
              AND EXISTS (
                  SELECT 1
                  FROM public.bookings wb
                  WHERE wb.queue_session_id = qs.id
                    AND wb.status = 'waiting'
                    AND wb.is_deleted = false
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM public.queue_runtime_events pe
                  WHERE pe.queue_session_id = qs.id
                    AND pe.event_type IN ('advanced', 'manually_called')
                    AND pe.created_at > now() - interval '20 minutes'
              )
              AND qs.started_at < now() - interval '20 minutes'
        ),
        'active_consultations', (
            SELECT COUNT(*)
            FROM public.bookings cb
            WHERE cb.hospital_id = p_hospital_id
              AND cb.status = 'in_consultation'
              AND cb.is_deleted = false
        ),
        'doctor_availability', (
            SELECT jsonb_agg(jsonb_build_object(
                'doctor_id', qs.doctor_id,
                'session_id', qs.id,
                'is_paused', qs.is_paused,
                'delay_minutes', qs.delay_expected_minutes,
                'current_token', qs.current_live_token
            ) ORDER BY qs.started_at)
            FROM public.queue_sessions qs
            WHERE qs.hospital_id = p_hospital_id
              AND qs.session_date = p_date
              AND qs.is_active
        )
    )
    INTO v_queues
    FROM public.queue_sessions qs
    WHERE qs.hospital_id = p_hospital_id
      AND qs.session_date = p_date;

    -- SLA status from the SLA engine.
    SELECT COALESCE(
        jsonb_build_object(
            'avg_wait_minutes', s.avg_wait_minutes,
            'completion_rate_pct', s.completion_rate_pct,
            'wait_breached', s.sla_wait_breached,
            'completion_breached', s.sla_completion_breached,
            'status', CASE
                WHEN s.sla_wait_breached
                  OR s.sla_completion_breached THEN 'breached'
                ELSE 'healthy'
            END
        ),
        jsonb_build_object('status', 'no_data')
    )
    INTO v_sla
    FROM public.sla_daily_tracking s
    WHERE s.hospital_id = p_hospital_id
      AND s.tracking_date = p_date;

    -- Finance of the day from collections + refunds, plus
    -- outstanding settlements from the cached balance table.
    SELECT jsonb_build_object(
        'revenue_today', (
            SELECT COALESCE(SUM(dce.total_amount), 0)
            FROM public.daily_collection_entries dce
            WHERE dce.hospital_id = p_hospital_id
              AND dce.collection_date = p_date
        ),
        'platform_fee_today', (
            SELECT COALESCE(SUM(dce.platform_fee), 0)
            FROM public.daily_collection_entries dce
            WHERE dce.hospital_id = p_hospital_id
              AND dce.collection_date = p_date
        ),
        'refunds_today', (
            SELECT COALESCE(SUM(pr.refund_amount_inr), 0)
            FROM public.payment_refunds pr
            WHERE pr.hospital_id = p_hospital_id
              AND pr.processed_at::date = p_date
        ),
        'pending_payments', (
            SELECT COUNT(*)
            FROM public.payment_orders po
            WHERE po.hospital_id = p_hospital_id
              AND po.payment_status IN ('initiated', 'pending')
              AND po.is_deleted = false
        ),
        'outstanding_settlements', (
            SELECT COALESCE(ob.total_outstanding, 0)
            FROM public.outstanding_balances ob
            WHERE ob.hospital_id = p_hospital_id
        )
    )
    INTO v_finance;

    -- Alert activity over the last 24 hours.
    SELECT jsonb_build_object(
        'recent_alerts_24h', COUNT(*)
    )
    INTO v_queue_health
    FROM public.alert_events ae
    WHERE ae.hospital_id = p_hospital_id
      AND ae.created_at > now() - interval '24 hours';

    RETURN jsonb_build_object(
        'hospital_id', p_hospital_id,
        'date', p_date,
        'patients', v_patients,
        'queues', v_queues,
        'sla', v_sla,
        'finance', v_finance,
        'alert_activity', v_queue_health,
        'generated_at', now()
    );

END;
$$;

-- =============================================================
-- 5. EXECUTIVE DASHBOARDS
-- =============================================================

-- Daily operations: hourly booking trend, throughput, efficiency
-- and SLA compliance for one day.
CREATE OR REPLACE FUNCTION public.get_daily_operations_dashboard(
    p_hospital_id UUID,
    p_date DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_hourly JSONB;
    v_rates JSONB;
    v_sla JSONB;
BEGIN

    SELECT jsonb_agg(row_to_json(h)::jsonb ORDER BY h.hour)
    INTO v_hourly
    FROM (
        SELECT
            EXTRACT(HOUR FROM b.created_at)::int AS hour,
            COUNT(*) AS bookings,
            COUNT(*) FILTER (WHERE b.status = 'completed') AS completed
        FROM public.bookings b
        WHERE b.hospital_id = p_hospital_id
          AND b.appointment_date = p_date
          AND b.is_deleted = false
        GROUP BY 1
    ) h;

    SELECT jsonb_build_object(
        'total_bookings', COUNT(*),
        'completed', COUNT(*) FILTER (WHERE b.status = 'completed'),
        'cancellation_rate_pct', ROUND(
            100.0 * COUNT(*) FILTER (WHERE b.status = 'cancelled')
            / NULLIF(COUNT(*), 0), 1
        ),
        'no_show_rate_pct', ROUND(
            100.0 * COUNT(*) FILTER (WHERE b.status = 'no_show')
            / NULLIF(COUNT(*), 0), 1
        ),
        'avg_wait_minutes', ROUND(AVG(
            EXTRACT(EPOCH FROM (
                b.consultation_started_at - b.checked_in_at
            )) / 60.0
        ) FILTER (
            WHERE b.consultation_started_at IS NOT NULL
              AND b.checked_in_at IS NOT NULL
        ), 1),
        'avg_consultation_minutes', ROUND(AVG(
            EXTRACT(EPOCH FROM (
                b.consultation_completed_at - b.consultation_started_at
            )) / 60.0
        ) FILTER (
            WHERE b.consultation_completed_at IS NOT NULL
              AND b.consultation_started_at IS NOT NULL
        ), 1),
        'doctor_throughput', (
            SELECT jsonb_agg(
                row_to_json(d)::jsonb ORDER BY d.completed DESC
            )
            FROM (
                SELECT
                    bb.assigned_doctor_id AS doctor_id,
                    COUNT(*) FILTER (
                        WHERE bb.status = 'completed'
                    ) AS completed
                FROM public.bookings bb
                WHERE bb.hospital_id = p_hospital_id
                  AND bb.appointment_date = p_date
                  AND bb.assigned_doctor_id IS NOT NULL
                  AND bb.is_deleted = false
                GROUP BY bb.assigned_doctor_id
            ) d
        )
    )
    INTO v_rates
    FROM public.bookings b
    WHERE b.hospital_id = p_hospital_id
      AND b.appointment_date = p_date
      AND b.is_deleted = false;

    SELECT COALESCE(
        jsonb_build_object(
            'compliant', NOT s.sla_wait_breached
                AND NOT s.sla_completion_breached,
            'avg_wait_minutes', s.avg_wait_minutes,
            'completion_rate_pct', s.completion_rate_pct
        ),
        jsonb_build_object('compliant', NULL)
    )
    INTO v_sla
    FROM public.sla_daily_tracking s
    WHERE s.hospital_id = p_hospital_id
      AND s.tracking_date = p_date;

    RETURN jsonb_build_object(
        'hospital_id', p_hospital_id,
        'date', p_date,
        'hourly_trend', COALESCE(v_hourly, '[]'::jsonb),
        'operations', v_rates,
        'sla', v_sla
    );

END;
$$;

-- Weekly: rollup-sourced performance + incident frequencies.
CREATE OR REPLACE FUNCTION public.get_weekly_dashboard(
    p_hospital_id UUID,
    p_week_start DATE DEFAULT date_trunc('week', CURRENT_DATE)::date
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_rollup JSONB;
    v_incidents JSONB;
    v_doctors JSONB;
BEGIN

    SELECT COALESCE(row_to_json(w)::jsonb, 'null'::jsonb)
    INTO v_rollup
    FROM public.analytics_weekly_rollups w
    WHERE w.hospital_id = p_hospital_id
      AND w.week_start_date = p_week_start;

    SELECT jsonb_build_object(
        'total_alerts', COUNT(*),
        'congestion_events', COUNT(*) FILTER (
            WHERE ae.alert_key IN (
                'queue_wait_exceeded',
                'queue_length_exceeded',
                'queue_stalled'
            )
        ),
        'delay_events', COUNT(*) FILTER (
            WHERE ae.alert_key = 'doctor_delay'
               OR ae.message ILIKE '%delay%'
        ),
        'sla_breaches', COUNT(*) FILTER (
            WHERE ae.alert_key = 'sla_wait_breach'
        )
    )
    INTO v_incidents
    FROM public.alert_events ae
    WHERE ae.hospital_id = p_hospital_id
      AND ae.created_at::date
          BETWEEN p_week_start AND p_week_start + 6;

    SELECT jsonb_agg(row_to_json(d)::jsonb ORDER BY d.completed DESC)
    INTO v_doctors
    FROM (
        SELECT
            b.assigned_doctor_id AS doctor_id,
            COUNT(*) FILTER (WHERE b.status = 'completed') AS completed,
            COUNT(*) AS total_assigned,
            ROUND(AVG(
                EXTRACT(EPOCH FROM (
                    b.consultation_completed_at
                    - b.consultation_started_at
                )) / 60.0
            ) FILTER (
                WHERE b.consultation_completed_at IS NOT NULL
            ), 1) AS avg_consultation_minutes
        FROM public.bookings b
        WHERE b.hospital_id = p_hospital_id
          AND b.appointment_date
              BETWEEN p_week_start AND p_week_start + 6
          AND b.assigned_doctor_id IS NOT NULL
          AND b.is_deleted = false
        GROUP BY b.assigned_doctor_id
    ) d;

    RETURN jsonb_build_object(
        'hospital_id', p_hospital_id,
        'week_start', p_week_start,
        'week_end', p_week_start + 6,
        'rollup', v_rollup,
        'incidents', v_incidents,
        'doctor_productivity', COALESCE(v_doctors, '[]'::jsonb)
    );

END;
$$;

-- Monthly: rollup-sourced growth + SLA trend + settlements.
CREATE OR REPLACE FUNCTION public.get_monthly_dashboard(
    p_hospital_id UUID,
    p_month_start DATE DEFAULT date_trunc('month', CURRENT_DATE)::date
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_rollup JSONB;
    v_sla_trend JSONB;
    v_settlements JSONB;
BEGIN

    SELECT COALESCE(row_to_json(m)::jsonb, 'null'::jsonb)
    INTO v_rollup
    FROM public.analytics_monthly_rollups m
    WHERE m.hospital_id = p_hospital_id
      AND m.month_start_date = p_month_start;

    SELECT jsonb_agg(row_to_json(s)::jsonb ORDER BY s.tracking_date)
    INTO v_sla_trend
    FROM (
        SELECT
            t.tracking_date,
            t.avg_wait_minutes,
            t.completion_rate_pct,
            t.sla_wait_breached
        FROM public.sla_daily_tracking t
        WHERE t.hospital_id = p_hospital_id
          AND t.tracking_date BETWEEN p_month_start
              AND (p_month_start + interval '1 month'
                   - interval '1 day')::date
        ORDER BY t.tracking_date
        LIMIT 31
    ) s;

    SELECT jsonb_build_object(
        'created', COUNT(*),
        'paid', COUNT(*) FILTER (
            WHERE hs.settlement_status = 'paid'
        ),
        'total_platform_amount', COALESCE(
            SUM(hs.total_platform_amount), 0
        ),
        'total_collected', COALESCE(
            SUM(hs.amount_paid_to_setura), 0
        )
    )
    INTO v_settlements
    FROM public.hospital_settlements hs
    WHERE hs.hospital_id = p_hospital_id
      AND hs.settlement_start_date >= p_month_start
      AND hs.settlement_start_date
          < (p_month_start + interval '1 month')::date;

    RETURN jsonb_build_object(
        'hospital_id', p_hospital_id,
        'month_start', p_month_start,
        'rollup', v_rollup,
        'sla_trend', COALESCE(v_sla_trend, '[]'::jsonb),
        'settlements', v_settlements
    );

END;
$$;

-- =============================================================
-- 6. DOCTOR PERFORMANCE INTELLIGENCE
-- =============================================================

-- Individual doctor metrics over a date range. Sources:
-- bookings (lifecycle timestamps), queue_runtime_events (delay
-- minutes), queue_sessions (utilization), collection entries
-- (revenue contribution).
CREATE OR REPLACE FUNCTION public.get_doctor_performance(
    p_doctor_id UUID,
    p_hospital_id UUID,
    p_from_date DATE DEFAULT CURRENT_DATE - 29,
    p_to_date DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_core JSONB;
    v_delay JSONB;
    v_utilization JSONB;
    v_duration_dist JSONB;
BEGIN

    SELECT jsonb_build_object(
        'patients_seen', COUNT(*) FILTER (
            WHERE b.status IN (
                'called', 'in_consultation', 'completed'
            )
        ),
        'consultations_completed', COUNT(*) FILTER (
            WHERE b.status = 'completed'
        ),
        'total_assigned', COUNT(*),
        'avg_consultation_minutes', ROUND(AVG(
            EXTRACT(EPOCH FROM (
                b.consultation_completed_at - b.consultation_started_at
            )) / 60.0
        ) FILTER (
            WHERE b.consultation_completed_at IS NOT NULL
              AND b.consultation_started_at IS NOT NULL
        ), 1),
        'avg_wait_caused_minutes', ROUND(AVG(
            EXTRACT(EPOCH FROM (
                b.consultation_started_at - b.checked_in_at
            )) / 60.0
        ) FILTER (
            WHERE b.consultation_started_at IS NOT NULL
              AND b.checked_in_at IS NOT NULL
        ), 1),
        'completion_rate_pct', ROUND(
            100.0 * COUNT(*) FILTER (WHERE b.status = 'completed')
            / NULLIF(COUNT(*), 0), 1
        ),
        'cancellation_rate_pct', ROUND(
            100.0 * COUNT(*) FILTER (WHERE b.status = 'cancelled')
            / NULLIF(COUNT(*), 0), 1
        ),
        'no_show_impact', COUNT(*) FILTER (
            WHERE b.status = 'no_show'
        ),
        'queue_throughput_per_day', ROUND(
            COUNT(*) FILTER (WHERE b.status = 'completed')
            / NULLIF((p_to_date - p_from_date + 1), 0), 2
        ),
        'revenue_contribution_inr', (
            SELECT COALESCE(SUM(dce.total_amount), 0)
            FROM public.daily_collection_entries dce
            JOIN public.bookings rb ON rb.id = dce.booking_id
            WHERE rb.assigned_doctor_id = p_doctor_id
              AND dce.hospital_id = p_hospital_id
              AND dce.collection_date
                  BETWEEN p_from_date AND p_to_date
        )
    )
    INTO v_core
    FROM public.bookings b
    WHERE b.assigned_doctor_id = p_doctor_id
      AND b.hospital_id = p_hospital_id
      AND b.appointment_date BETWEEN p_from_date AND p_to_date
      AND b.is_deleted = false;

    -- Declared delay minutes from queue runtime events.
    SELECT jsonb_build_object(
        'delay_events', COUNT(*),
        'total_delay_minutes', COALESCE(SUM(
            (qe.metadata->>'delay_minutes')::numeric
        ), 0)
    )
    INTO v_delay
    FROM public.queue_runtime_events qe
    WHERE qe.hospital_id = p_hospital_id
      AND qe.event_type = 'doctor_delayed'
      AND qe.actor_id = p_doctor_id
      AND qe.created_at::date BETWEEN p_from_date AND p_to_date;

    -- Session utilization: completed consultations vs token
    -- capacity across the doctor's sessions in range.
    SELECT jsonb_build_object(
        'sessions', COUNT(*),
        'capacity', COALESCE(SUM(qs.max_tokens), 0),
        'utilization_pct', ROUND(
            100.0 * (
                SELECT COUNT(*)
                FROM public.bookings sb
                WHERE sb.assigned_doctor_id = p_doctor_id
                  AND sb.hospital_id = p_hospital_id
                  AND sb.status = 'completed'
                  AND sb.appointment_date
                      BETWEEN p_from_date AND p_to_date
                  AND sb.is_deleted = false
            ) / NULLIF(SUM(qs.max_tokens), 0), 1
        )
    )
    INTO v_utilization
    FROM public.queue_sessions qs
    WHERE qs.hospital_id = p_hospital_id
      AND qs.doctor_id = p_doctor_id
      AND qs.session_date BETWEEN p_from_date AND p_to_date;

    -- Consultation duration distribution (5-minute buckets).
    SELECT jsonb_agg(row_to_json(d)::jsonb ORDER BY d.bucket_start)
    INTO v_duration_dist
    FROM (
        SELECT
            (FLOOR(
                EXTRACT(EPOCH FROM (
                    b.consultation_completed_at
                    - b.consultation_started_at
                )) / 300.0
            ) * 5)::int AS bucket_start,
            COUNT(*) AS consultations
        FROM public.bookings b
        WHERE b.assigned_doctor_id = p_doctor_id
          AND b.hospital_id = p_hospital_id
          AND b.appointment_date BETWEEN p_from_date AND p_to_date
          AND b.consultation_completed_at IS NOT NULL
          AND b.consultation_started_at IS NOT NULL
          AND b.is_deleted = false
        GROUP BY 1
    ) d;

    RETURN jsonb_build_object(
        'doctor_id', p_doctor_id,
        'hospital_id', p_hospital_id,
        'from_date', p_from_date,
        'to_date', p_to_date,
        'metrics', v_core,
        'delays', v_delay,
        'session_utilization', v_utilization,
        'duration_distribution', COALESCE(v_duration_dist, '[]'::jsonb)
    );

END;
$$;

-- Comparative metrics: ranking, load distribution and a
-- doctor x weekday utilization heatmap for the hospital.
CREATE OR REPLACE FUNCTION public.get_doctor_rankings(
    p_hospital_id UUID,
    p_from_date DATE DEFAULT CURRENT_DATE - 29,
    p_to_date DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_rankings JSONB;
    v_heatmap JSONB;
BEGIN

    SELECT jsonb_agg(row_to_json(r)::jsonb ORDER BY r.throughput_rank)
    INTO v_rankings
    FROM (
        SELECT
            d.doctor_id,
            d.completed,
            d.total_assigned,
            d.avg_consultation_minutes,
            d.load_pct,
            RANK() OVER (
                ORDER BY d.completed DESC
            ) AS throughput_rank,
            RANK() OVER (
                ORDER BY d.avg_consultation_minutes ASC NULLS LAST
            ) AS efficiency_rank
        FROM (
            SELECT
                b.assigned_doctor_id AS doctor_id,
                COUNT(*) FILTER (
                    WHERE b.status = 'completed'
                ) AS completed,
                COUNT(*) AS total_assigned,
                ROUND(AVG(
                    EXTRACT(EPOCH FROM (
                        b.consultation_completed_at
                        - b.consultation_started_at
                    )) / 60.0
                ) FILTER (
                    WHERE b.consultation_completed_at IS NOT NULL
                ), 1) AS avg_consultation_minutes,
                ROUND(
                    100.0 * COUNT(*) / NULLIF(SUM(COUNT(*)) OVER (), 0),
                    1
                ) AS load_pct
            FROM public.bookings b
            WHERE b.hospital_id = p_hospital_id
              AND b.appointment_date BETWEEN p_from_date AND p_to_date
              AND b.assigned_doctor_id IS NOT NULL
              AND b.is_deleted = false
            GROUP BY b.assigned_doctor_id
        ) d
    ) r;

    SELECT jsonb_agg(row_to_json(h)::jsonb ORDER BY h.doctor_id, h.weekday)
    INTO v_heatmap
    FROM (
        SELECT
            b.assigned_doctor_id AS doctor_id,
            EXTRACT(ISODOW FROM b.appointment_date)::int AS weekday,
            COUNT(*) FILTER (WHERE b.status = 'completed') AS completed
        FROM public.bookings b
        WHERE b.hospital_id = p_hospital_id
          AND b.appointment_date BETWEEN p_from_date AND p_to_date
          AND b.assigned_doctor_id IS NOT NULL
          AND b.is_deleted = false
        GROUP BY 1, 2
    ) h;

    RETURN jsonb_build_object(
        'hospital_id', p_hospital_id,
        'from_date', p_from_date,
        'to_date', p_to_date,
        'rankings', COALESCE(v_rankings, '[]'::jsonb),
        'utilization_heatmap', COALESCE(v_heatmap, '[]'::jsonb)
    );

END;
$$;

-- =============================================================
-- 7. FINANCIAL COMMAND CENTER
-- Daily collections from daily_collection_entries, refunds from
-- payment_refunds, settlement intelligence from
-- hospital_settlements + outstanding_balances, reconciliation
-- via get_reconciliation_summary.
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_financial_command_center(
    p_hospital_id UUID,
    p_date DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_collections JSONB;
    v_settlements JSONB;
    v_reconciliation JSONB;
BEGIN

    SELECT jsonb_build_object(
        'total_collected', COALESCE(SUM(dce.total_amount), 0),
        'platform_fee', COALESCE(SUM(dce.platform_fee), 0),
        'hospital_fee', COALESCE(SUM(dce.hospital_fee), 0),
        'receptionist_fee', COALESCE(SUM(dce.receptionist_fee), 0),
        'refunds', (
            SELECT COALESCE(SUM(pr.refund_amount_inr), 0)
            FROM public.payment_refunds pr
            WHERE pr.hospital_id = p_hospital_id
              AND pr.processed_at::date = p_date
        ),
        'net_collections', COALESCE(SUM(dce.total_amount), 0) - (
            SELECT COALESCE(SUM(pr.refund_amount_inr), 0)
            FROM public.payment_refunds pr
            WHERE pr.hospital_id = p_hospital_id
              AND pr.processed_at::date = p_date
        ),
        'online_payments', COUNT(*) FILTER (
            WHERE dce.booking_source = 'online'
        ),
        'offline_payments', COUNT(*) FILTER (
            WHERE dce.booking_source <> 'online'
        ),
        'pending_payments', (
            SELECT COUNT(*)
            FROM public.payment_orders po
            WHERE po.hospital_id = p_hospital_id
              AND po.payment_status IN ('initiated', 'pending')
              AND po.is_deleted = false
        )
    )
    INTO v_collections
    FROM public.daily_collection_entries dce
    WHERE dce.hospital_id = p_hospital_id
      AND dce.collection_date = p_date;

    -- Settlement intelligence with aging buckets.
    SELECT jsonb_build_object(
        'outstanding_balance', (
            SELECT COALESCE(ob.total_outstanding, 0)
            FROM public.outstanding_balances ob
            WHERE ob.hospital_id = p_hospital_id
        ),
        'aging_buckets', jsonb_build_object(
            'current', COALESCE(SUM(
                hs.remaining_due
            ) FILTER (
                WHERE hs.remaining_due > 0
                  AND CURRENT_DATE - hs.settlement_end_date <= 7
            ), 0),
            'overdue_8_30', COALESCE(SUM(
                hs.remaining_due
            ) FILTER (
                WHERE hs.remaining_due > 0
                  AND CURRENT_DATE - hs.settlement_end_date
                      BETWEEN 8 AND 30
            ), 0),
            'overdue_31_plus', COALESCE(SUM(
                hs.remaining_due
            ) FILTER (
                WHERE hs.remaining_due > 0
                  AND CURRENT_DATE - hs.settlement_end_date > 30
            ), 0)
        ),
        'overdue_count', COUNT(*) FILTER (
            WHERE hs.settlement_status = 'overdue'
               OR (
                   hs.remaining_due > 0
                   AND hs.settlement_end_date < CURRENT_DATE
               )
        ),
        'partial_payments', COUNT(*) FILTER (
            WHERE hs.settlement_status = 'partially_paid'
        ),
        'collection_velocity_days', ROUND(AVG(
            EXTRACT(EPOCH FROM (hs.paid_at - hs.created_at)) / 86400.0
        ) FILTER (WHERE hs.paid_at IS NOT NULL), 1),
        'recent_settlements', (
            SELECT jsonb_agg(row_to_json(s)::jsonb ORDER BY s.created_at DESC)
            FROM (
                SELECT
                    hs2.id,
                    hs2.settlement_start_date,
                    hs2.settlement_end_date,
                    hs2.total_platform_amount,
                    hs2.amount_paid_to_setura,
                    hs2.remaining_due,
                    hs2.settlement_status::text AS settlement_status,
                    hs2.created_at
                FROM public.hospital_settlements hs2
                WHERE hs2.hospital_id = p_hospital_id
                ORDER BY hs2.created_at DESC
                LIMIT 10
            ) s
        )
    )
    INTO v_settlements
    FROM public.hospital_settlements hs
    WHERE hs.hospital_id = p_hospital_id;

    -- Reuse the reconciliation engine for the trailing 30 days.
    SELECT row_to_json(r)::jsonb
    INTO v_reconciliation
    FROM public.get_reconciliation_summary(
        p_hospital_id,
        p_date - 29,
        p_date
    ) r;

    RETURN jsonb_build_object(
        'hospital_id', p_hospital_id,
        'date', p_date,
        'daily_collections', v_collections,
        'settlement_intelligence', v_settlements,
        'reconciliation', v_reconciliation
    );

END;
$$;

-- Deterministic revenue forecasting: prorate month-to-date
-- collections over elapsed days; refund impact applies the
-- trailing refund rate to the projection.
CREATE OR REPLACE FUNCTION public.get_revenue_forecast(
    p_hospital_id UUID,
    p_date DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_month_start DATE := date_trunc('month', p_date)::date;
    v_days_in_month INT;
    v_days_elapsed INT;
    v_mtd NUMERIC;
    v_platform_mtd NUMERIC;
    v_refund_rate NUMERIC;
    v_last30_revenue NUMERIC;
    v_last30_refunds NUMERIC;
BEGIN

    v_days_in_month := (
        (v_month_start + interval '1 month')::date
        - v_month_start
    );
    v_days_elapsed := GREATEST(p_date - v_month_start + 1, 1);

    SELECT
        COALESCE(SUM(dce.total_amount), 0),
        COALESCE(SUM(dce.platform_fee), 0)
    INTO v_mtd, v_platform_mtd
    FROM public.daily_collection_entries dce
    WHERE dce.hospital_id = p_hospital_id
      AND dce.collection_date BETWEEN v_month_start AND p_date;

    SELECT COALESCE(SUM(dce2.total_amount), 0)
    INTO v_last30_revenue
    FROM public.daily_collection_entries dce2
    WHERE dce2.hospital_id = p_hospital_id
      AND dce2.collection_date BETWEEN p_date - 29 AND p_date;

    SELECT COALESCE(SUM(pr.refund_amount_inr), 0)
    INTO v_last30_refunds
    FROM public.payment_refunds pr
    WHERE pr.hospital_id = p_hospital_id
      AND pr.processed_at::date BETWEEN p_date - 29 AND p_date;

    v_refund_rate := CASE
        WHEN v_last30_revenue > 0
        THEN LEAST(v_last30_refunds / v_last30_revenue, 1)
        ELSE 0
    END;

    RETURN jsonb_build_object(
        'hospital_id', p_hospital_id,
        'as_of', p_date,
        'projected_month_revenue', ROUND(
            v_mtd * v_days_in_month / v_days_elapsed, 2
        ),
        'projected_platform_fees', ROUND(
            v_platform_mtd * v_days_in_month / v_days_elapsed, 2
        ),
        'projected_settlements', ROUND(
            v_mtd * v_days_in_month / v_days_elapsed, 2
        ),
        'refund_rate_30d', ROUND(v_refund_rate, 4),
        'refund_impact_forecast', ROUND(
            v_mtd * v_days_in_month / v_days_elapsed * v_refund_rate, 2
        ),
        'collection_forecast_next_7d', ROUND(
            (v_last30_revenue / 30.0) * 7, 2
        ),
        'inputs', jsonb_build_object(
            'mtd_revenue', v_mtd,
            'days_elapsed', v_days_elapsed,
            'days_in_month', v_days_in_month
        )
    );

END;
$$;

-- =============================================================
-- 8. SLA & OPERATIONAL INTELLIGENCE
-- =============================================================

-- Live SLA dashboard over the SLA engine output + queue runtime
-- breach signals.
CREATE OR REPLACE FUNCTION public.get_sla_dashboard(
    p_hospital_id UUID DEFAULT NULL,
    p_date DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_breaches JSONB;
    v_trend JSONB;
    v_summary JSONB;
BEGIN

    SELECT jsonb_agg(row_to_json(b)::jsonb ORDER BY b.avg_wait_minutes DESC NULLS LAST)
    INTO v_breaches
    FROM (
        SELECT
            s.hospital_id,
            h.name AS hospital_name,
            s.avg_wait_minutes,
            s.completion_rate_pct,
            s.sla_wait_breached,
            s.sla_completion_breached
        FROM public.sla_daily_tracking s
        JOIN public.hospitals h ON h.id = s.hospital_id
        WHERE (p_hospital_id IS NULL OR s.hospital_id = p_hospital_id)
          AND s.tracking_date = p_date
          AND (s.sla_wait_breached OR s.sla_completion_breached)
    ) b;

    SELECT jsonb_agg(row_to_json(t)::jsonb ORDER BY t.tracking_date)
    INTO v_trend
    FROM (
        SELECT
            s.tracking_date,
            ROUND(AVG(s.avg_wait_minutes), 1) AS avg_wait_minutes,
            ROUND(AVG(s.completion_rate_pct), 1) AS completion_rate_pct,
            COUNT(*) FILTER (
                WHERE s.sla_wait_breached OR s.sla_completion_breached
            ) AS hospitals_breached
        FROM public.sla_daily_tracking s
        WHERE (p_hospital_id IS NULL OR s.hospital_id = p_hospital_id)
          AND s.tracking_date BETWEEN p_date - 13 AND p_date
        GROUP BY s.tracking_date
    ) t;

    SELECT jsonb_build_object(
        'tracked', COUNT(*),
        'in_breach', COUNT(*) FILTER (
            WHERE s.sla_wait_breached OR s.sla_completion_breached
        ),
        'avg_breach_wait_minutes', ROUND(AVG(
            s.avg_wait_minutes
        ) FILTER (
            WHERE s.sla_wait_breached
        ), 1)
    )
    INTO v_summary
    FROM public.sla_daily_tracking s
    WHERE (p_hospital_id IS NULL OR s.hospital_id = p_hospital_id)
      AND s.tracking_date = p_date;

    RETURN jsonb_build_object(
        'date', p_date,
        'summary', v_summary,
        'hospitals_in_breach', COALESCE(v_breaches, '[]'::jsonb),
        'trend_14d', COALESCE(v_trend, '[]'::jsonb)
    );

END;
$$;

-- Composite operational scores (0-100, higher is better except
-- risk). Deterministic formulas over live state.
CREATE OR REPLACE FUNCTION public.get_operational_scores(
    p_hospital_id UUID,
    p_date DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_queue JSONB;
    v_wait NUMERIC;
    v_capacity INT;
    v_waiting INT;
    v_delayed INT;
    v_sessions INT;
    v_alerts INT;
    v_completion NUMERIC;
    v_congestion INT;
    v_delay INT;
    v_risk INT;
    v_health INT;
    v_experience INT;
BEGIN

    SELECT
        COUNT(*),
        COALESCE(SUM(qs.max_tokens), 0),
        COUNT(*) FILTER (WHERE qs.delay_expected_minutes IS NOT NULL)
    INTO v_sessions, v_capacity, v_delayed
    FROM public.queue_sessions qs
    WHERE qs.hospital_id = p_hospital_id
      AND qs.session_date = p_date
      AND qs.is_active;

    SELECT COUNT(*)
    INTO v_waiting
    FROM public.bookings b
    WHERE b.hospital_id = p_hospital_id
      AND b.appointment_date = p_date
      AND b.status = 'waiting'
      AND b.is_deleted = false;

    SELECT COUNT(*)
    INTO v_alerts
    FROM public.alert_events ae
    WHERE ae.hospital_id = p_hospital_id
      AND ae.is_resolved = false
      AND ae.created_at > now() - interval '24 hours';

    SELECT COALESCE(s.completion_rate_pct, 100),
           COALESCE(s.avg_wait_minutes, 0)
    INTO v_completion, v_wait
    FROM public.sla_daily_tracking s
    WHERE s.hospital_id = p_hospital_id
      AND s.tracking_date = p_date;

    -- Congestion: waiting load vs capacity.
    v_congestion := CASE
        WHEN v_capacity <= 0 THEN 100
        ELSE GREATEST(0, LEAST(100, ROUND(
            100.0 * v_waiting / v_capacity
        )::int))
    END;

    -- Delay: share of active sessions running late.
    v_delay := CASE
        WHEN v_sessions <= 0 THEN 0
        ELSE ROUND(100.0 * v_delayed / v_sessions)::int
    END;

    -- Risk: unresolved alerts + breach pressure.
    v_risk := LEAST(100, v_alerts * 10
        + CASE WHEN v_wait > 60 THEN 30
               WHEN v_wait > 45 THEN 15
               ELSE 0 END);

    -- Health: inverse of risk and congestion.
    v_health := GREATEST(0, 100 - (v_risk / 2) - (v_congestion / 4));

    -- Patient experience: wait + completion driven.
    v_experience := GREATEST(0, LEAST(100, ROUND(
        (v_completion * 0.5)
        + GREATEST(0, 50 - v_wait) 
    )::int));

    v_queue := jsonb_build_object(
        'waiting', v_waiting,
        'capacity', v_capacity,
        'active_sessions', v_sessions,
        'delayed_sessions', v_delayed,
        'open_alerts_24h', v_alerts,
        'avg_wait_minutes', v_wait
    );

    RETURN jsonb_build_object(
        'hospital_id', p_hospital_id,
        'date', p_date,
        'congestion_score', v_congestion,
        'delay_score', v_delay,
        'risk_score', v_risk,
        'health_score', v_health,
        'patient_experience_score', v_experience,
        'inputs', v_queue
    );

END;
$$;

-- =============================================================
-- 9. MULTI-HOSPITAL PORTFOLIO & BENCHMARKS
-- Global-admin views across all tenants.
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_portfolio_dashboard(
    p_date DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_hospitals JSONB;
BEGIN

    SELECT jsonb_agg(row_to_json(h)::jsonb ORDER BY h.revenue_today DESC, h.bookings_today DESC)
    INTO v_hospitals
    FROM (
        SELECT
            hp.id AS hospital_id,
            hp.name,
            hp.slug,
            hp.is_active,
            (
                SELECT COUNT(*)
                FROM public.bookings b
                WHERE b.hospital_id = hp.id
                  AND b.appointment_date = p_date
                  AND b.is_deleted = false
            ) AS bookings_today,
            (
                SELECT COALESCE(SUM(dce.total_amount), 0)
                FROM public.daily_collection_entries dce
                WHERE dce.hospital_id = hp.id
                  AND dce.collection_date = p_date
            ) AS revenue_today,
            (
                SELECT COALESCE(ob.total_outstanding, 0)
                FROM public.outstanding_balances ob
                WHERE ob.hospital_id = hp.id
            ) AS outstanding_balance,
            (
                SELECT CASE
                    WHEN s.sla_wait_breached
                      OR s.sla_completion_breached THEN 'breached'
                    WHEN s.tracking_date IS NULL THEN 'no_data'
                    ELSE 'healthy'
                END
                FROM public.sla_daily_tracking s
                WHERE s.hospital_id = hp.id
                  AND s.tracking_date = p_date
            ) AS sla_status,
            (
                SELECT COUNT(*)
                FROM public.queue_sessions qs
                WHERE qs.hospital_id = hp.id
                  AND qs.session_date = p_date
                  AND qs.is_active
            ) AS active_sessions
        FROM public.hospitals hp
    ) h;

    RETURN jsonb_build_object(
        'date', p_date,
        'total_hospitals', jsonb_array_length(
            COALESCE(v_hospitals, '[]'::jsonb)
        ),
        'active_hospitals', (
            SELECT COUNT(*) FROM public.hospitals WHERE is_active
        ),
        'hospitals', COALESCE(v_hospitals, '[]'::jsonb)
    );

END;
$$;

-- Cross-hospital benchmarks over the trailing 30 days.
CREATE OR REPLACE FUNCTION public.get_cross_hospital_benchmarks(
    p_from_date DATE DEFAULT CURRENT_DATE - 29,
    p_to_date DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_rows JSONB;
BEGIN

    SELECT jsonb_agg(row_to_json(r)::jsonb ORDER BY r.completed DESC)
    INTO v_rows
    FROM (
        SELECT
            hp.id AS hospital_id,
            hp.name,
            COUNT(*) AS bookings,
            COUNT(*) FILTER (WHERE b.status = 'completed') AS completed,
            ROUND(AVG(
                EXTRACT(EPOCH FROM (
                    b.consultation_started_at - b.checked_in_at
                )) / 60.0
            ) FILTER (
                WHERE b.consultation_started_at IS NOT NULL
                  AND b.checked_in_at IS NOT NULL
            ), 1) AS avg_wait_minutes,
            ROUND(AVG(
                EXTRACT(EPOCH FROM (
                    b.consultation_completed_at
                    - b.consultation_started_at
                )) / 60.0
            ) FILTER (
                WHERE b.consultation_completed_at IS NOT NULL
            ), 1) AS avg_consultation_minutes,
            ROUND(
                100.0 * COUNT(*) FILTER (WHERE b.status = 'completed')
                / NULLIF(COUNT(*), 0), 1
            ) AS efficiency_pct,
            (
                SELECT COALESCE(SUM(dce.total_amount), 0)
                FROM public.daily_collection_entries dce
                WHERE dce.hospital_id = hp.id
                  AND dce.collection_date
                      BETWEEN p_from_date AND p_to_date
            ) AS revenue_inr
        FROM public.hospitals hp
        LEFT JOIN public.bookings b
            ON b.hospital_id = hp.id
           AND b.appointment_date BETWEEN p_from_date AND p_to_date
           AND b.is_deleted = false
        GROUP BY hp.id, hp.name
    ) r;

    RETURN jsonb_build_object(
        'from_date', p_from_date,
        'to_date', p_to_date,
        'benchmarks', COALESCE(v_rows, '[]'::jsonb)
    );

END;
$$;

-- =============================================================
-- 10. PREDICTIVE OPERATIONS ANALYTICS
-- Deterministic heuristics over live throughput (no ML): rates
-- observed in the current session/day are projected forward.
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_predictive_insights(
    p_hospital_id UUID,
    p_date DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_queue JSONB;
    v_financial JSONB;
    v_no_show NUMERIC;
BEGIN

    -- Queue predictions from today's throughput.
    SELECT jsonb_build_object(
        'waiting_now', COUNT(*) FILTER (WHERE b.status = 'waiting'),
        'completed_now', COUNT(*) FILTER (WHERE b.status = 'completed'),
        'predicted_no_shows_today', ROUND(
            COUNT(*) * COALESCE(
                (
                    SELECT s.no_show_rate_pct / 100.0
                    FROM public.sla_daily_tracking s
                    WHERE s.hospital_id = p_hospital_id
                      AND s.tracking_date = p_date - 1
                ),
                0.05
            ), 1
        ),
        'avg_consultation_minutes', ROUND(AVG(
            EXTRACT(EPOCH FROM (
                b.consultation_completed_at - b.consultation_started_at
            )) / 60.0
        ) FILTER (
            WHERE b.consultation_completed_at IS NOT NULL
              AND b.consultation_started_at IS NOT NULL
        ), 1)
    )
    INTO v_queue
    FROM public.bookings b
    WHERE b.hospital_id = p_hospital_id
      AND b.appointment_date = p_date
      AND b.is_deleted = false;

    -- Predicted wait/completion/exhaustion: waiting count x avg
    -- consultation time, projected from the observed rate.
    v_queue := v_queue || jsonb_build_object(
        'predicted_wait_next_minutes', ROUND(
            COALESCE((v_queue->>'avg_consultation_minutes')::numeric, 0)
            + COALESCE(
                (
                    SELECT s.avg_wait_minutes
                    FROM public.sla_daily_tracking s
                    WHERE s.hospital_id = p_hospital_id
                      AND s.tracking_date = p_date
                ), 0
            ), 1
        ),
        'predicted_queue_exhaustion_minutes', ROUND(
            (v_queue->>'waiting_now')::numeric
            * COALESCE(
                (v_queue->>'avg_consultation_minutes')::numeric, 10
            ), 1
        )
    );

    -- Financial predictions reuse the forecast RPC.
    v_financial := public.get_revenue_forecast(p_hospital_id, p_date);

    RETURN jsonb_build_object(
        'hospital_id', p_hospital_id,
        'date', p_date,
        'queue_predictions', v_queue,
        'financial_predictions', v_financial
    );

END;
$$;

-- =============================================================
-- 11. EXECUTIVE REPORTING ENGINE
-- One dispatcher over the analytics RPCs above. Returns
-- structured JSONB: {report_type, hospital_id, from, to,
-- columns, rows, summary} - CSV and PDF-ready rendering happen
-- at the edge layer from the same rows.
-- =============================================================

CREATE OR REPLACE FUNCTION public.generate_executive_report(
    p_report_type TEXT,
    p_hospital_id UUID,
    p_from_date DATE DEFAULT CURRENT_DATE - 6,
    p_to_date DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_data JSONB;
    v_columns TEXT[];
BEGIN

    CASE p_report_type
    WHEN 'daily_hospital' THEN
        v_data := public.get_hospital_command_center(
            p_hospital_id, p_to_date
        );
        v_columns := ARRAY[
            'patients', 'queues', 'sla', 'finance', 'alert_activity'
        ];
    WHEN 'weekly_operations' THEN
        v_data := public.get_weekly_dashboard(
            p_hospital_id, p_from_date
        );
        v_columns := ARRAY[
            'rollup', 'incidents', 'doctor_productivity'
        ];
    WHEN 'monthly_executive' THEN
        v_data := public.get_monthly_dashboard(
            p_hospital_id,
            date_trunc('month', p_to_date)::date
        );
        v_columns := ARRAY['rollup', 'sla_trend', 'settlements'];
    WHEN 'doctor_performance' THEN
        v_data := public.get_doctor_rankings(
            p_hospital_id, p_from_date, p_to_date
        );
        v_columns := ARRAY['rankings', 'utilization_heatmap'];
    WHEN 'financial' THEN
        v_data := public.get_financial_command_center(
            p_hospital_id, p_to_date
        ) || jsonb_build_object(
            'forecast',
            public.get_revenue_forecast(p_hospital_id, p_to_date)
        );
        v_columns := ARRAY[
            'daily_collections',
            'settlement_intelligence',
            'reconciliation',
            'forecast'
        ];
    WHEN 'settlement' THEN
        v_data := COALESCE(
            public.get_reconciliation_summary(
                p_hospital_id, p_from_date, p_to_date
            ),
            '{}'::jsonb
        );
        v_columns := ARRAY['reconciliation'];
    WHEN 'sla' THEN
        v_data := public.get_sla_dashboard(p_hospital_id, p_to_date);
        v_columns := ARRAY[
            'summary', 'hospitals_in_breach', 'trend_14d'
        ];
    WHEN 'audit' THEN
        v_data := COALESCE(
            public.get_audit_coverage_report(
                p_hospital_id, p_from_date, p_to_date
            ),
            '{}'::jsonb
        );
        v_columns := ARRAY['audit_coverage'];
    ELSE
        RETURN jsonb_build_object(
            'ok', false,
            'reason', 'unknown_report_type',
            'supported', ARRAY[
                'daily_hospital',
                'weekly_operations',
                'monthly_executive',
                'doctor_performance',
                'financial',
                'settlement',
                'sla',
                'audit'
            ]
        );
    END CASE;

    RETURN jsonb_build_object(
        'ok', true,
        'report_type', p_report_type,
        'hospital_id', p_hospital_id,
        'from_date', p_from_date,
        'to_date', p_to_date,
        'columns', v_columns,
        'data', v_data,
        'generated_at', now()
    );

END;
$$;

-- =============================================================
-- 12. GOVERNANCE & COMPLIANCE
-- Executive audit search + deterministic integrity checks.
-- =============================================================

CREATE OR REPLACE FUNCTION public.search_audit_logs(
    p_hospital_id UUID,
    p_actor_id UUID DEFAULT NULL,
    p_entity_type TEXT DEFAULT NULL,
    p_action_type TEXT DEFAULT NULL,
    p_from_ts TIMESTAMPTZ DEFAULT now() - interval '7 days',
    p_to_ts TIMESTAMPTZ DEFAULT now(),
    p_correlation_id TEXT DEFAULT NULL,
    p_limit INTEGER DEFAULT 100
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_rows JSONB;
BEGIN

    SELECT jsonb_agg(row_to_json(a)::jsonb ORDER BY a.created_at DESC)
    INTO v_rows
    FROM (
        SELECT
            al.id,
            al.actor_user_id,
            al.entity_type,
            al.entity_id,
            al.action_type,
            al.action_severity::text AS action_severity,
            al.metadata,
            al.notes,
            al.created_at
        FROM public.audit_logs al
        WHERE al.hospital_id = p_hospital_id
          AND al.created_at BETWEEN p_from_ts AND p_to_ts
          AND (p_actor_id IS NULL OR al.actor_user_id = p_actor_id)
          AND (p_entity_type IS NULL OR al.entity_type = p_entity_type)
          AND (p_action_type IS NULL OR al.action_type = p_action_type)
          AND (
              p_correlation_id IS NULL
              OR al.metadata->>'correlationId' = p_correlation_id
          )
        ORDER BY al.created_at DESC
        LIMIT LEAST(GREATEST(p_limit, 1), 1000)
    ) a;

    RETURN jsonb_build_object(
        'hospital_id', p_hospital_id,
        'entries', COALESCE(v_rows, '[]'::jsonb)
    );

END;
$$;

-- Audit integrity: counts + actor/entity referential sanity for
-- a hospital-day.
CREATE OR REPLACE FUNCTION public.verify_audit_integrity(
    p_hospital_id UUID,
    p_from_ts TIMESTAMPTZ DEFAULT now() - interval '1 day'
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_total BIGINT;
    v_orphan_actors BIGINT;
    v_registered_actions BIGINT;
    v_unknown_actions BIGINT;
BEGIN

    SELECT COUNT(*) INTO v_total
    FROM public.audit_logs al
    WHERE al.hospital_id = p_hospital_id
      AND al.created_at >= p_from_ts;

    -- Actor ids must exist in profiles or be NULL.
    SELECT COUNT(*) INTO v_orphan_actors
    FROM public.audit_logs al
    WHERE al.hospital_id = p_hospital_id
      AND al.created_at >= p_from_ts
      AND al.actor_user_id IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = al.actor_user_id
      );

    -- Action types must be registered.
    SELECT COUNT(DISTINCT al.action_type) INTO v_registered_actions
    FROM public.audit_logs al
    WHERE al.hospital_id = p_hospital_id
      AND al.created_at >= p_from_ts
      AND EXISTS (
          SELECT 1 FROM public.audit_action_types t
          WHERE t.action_type = al.action_type
      );

    SELECT COUNT(DISTINCT al.action_type) INTO v_unknown_actions
    FROM public.audit_logs al
    WHERE al.hospital_id = p_hospital_id
      AND al.created_at >= p_from_ts
      AND NOT EXISTS (
          SELECT 1 FROM public.audit_action_types t
          WHERE t.action_type = al.action_type
      );

    RETURN jsonb_build_object(
        'ok', v_orphan_actors = 0 AND v_unknown_actions = 0,
        'total_entries', v_total,
        'orphan_actors', v_orphan_actors,
        'registered_action_types', v_registered_actions,
        'unknown_action_types', v_unknown_actions
    );

END;
$$;

-- Settlement integrity: settlement totals must reconcile with
-- their settlement_items and the underlying collection entries.
CREATE OR REPLACE FUNCTION public.verify_settlement_integrity(
    p_hospital_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_mismatches JSONB;
    v_checked INT;
BEGIN

    SELECT COUNT(*) INTO v_checked
    FROM public.hospital_settlements hs
    WHERE hs.hospital_id = p_hospital_id;

    SELECT jsonb_agg(row_to_json(m)::jsonb)
    INTO v_mismatches
    FROM (
        SELECT
            hs.id AS settlement_id,
            hs.total_platform_amount,
            COALESCE(SUM(si.platform_fee_amount), 0) AS items_platform_total
        FROM public.hospital_settlements hs
        LEFT JOIN public.settlement_items si
            ON si.settlement_id = hs.id
        WHERE hs.hospital_id = p_hospital_id
        GROUP BY hs.id, hs.total_platform_amount
        HAVING hs.total_platform_amount
            <> COALESCE(SUM(si.platform_fee_amount), 0)
    ) m;

    RETURN jsonb_build_object(
        'ok', v_mismatches IS NULL,
        'settlements_checked', v_checked,
        'mismatches', COALESCE(v_mismatches, '[]'::jsonb)
    );

END;
$$;

-- Queue integrity: bookings must belong to their session's
-- hospital, tokens must be unique per session, and the
-- one-active-consultation invariant must hold.
CREATE OR REPLACE FUNCTION public.verify_queue_integrity(
    p_queue_session_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_cross_hospital BIGINT;
    v_duplicate_tokens BIGINT;
    v_parallel_consultations BIGINT;
BEGIN

    SELECT COUNT(*) INTO v_cross_hospital
    FROM public.bookings b
    JOIN public.queue_sessions qs ON qs.id = b.queue_session_id
    WHERE b.queue_session_id = p_queue_session_id
      AND b.hospital_id <> qs.hospital_id
      AND b.is_deleted = false;

    SELECT COUNT(*) INTO v_duplicate_tokens
    FROM (
        SELECT b.token_number
        FROM public.bookings b
        WHERE b.queue_session_id = p_queue_session_id
          AND b.is_deleted = false
        GROUP BY b.token_number
        HAVING COUNT(*) > 1
    ) d;

    SELECT COUNT(*) INTO v_parallel_consultations
    FROM (
        SELECT b.assigned_doctor_id
        FROM public.bookings b
        WHERE b.queue_session_id = p_queue_session_id
          AND b.status = 'in_consultation'
          AND b.is_deleted = false
          AND b.assigned_doctor_id IS NOT NULL
        GROUP BY b.assigned_doctor_id
        HAVING COUNT(*) > 1
    ) c;

    RETURN jsonb_build_object(
        'ok', v_cross_hospital = 0
            AND v_duplicate_tokens = 0
            AND v_parallel_consultations = 0,
        'cross_hospital_bookings', v_cross_hospital,
        'duplicate_tokens', v_duplicate_tokens,
        'parallel_consultations', v_parallel_consultations
    );

END;
$$;

-- Doctor operations integrity: timestamp ordering and status
-- consistency for one doctor-day.
CREATE OR REPLACE FUNCTION public.verify_doctor_operations_integrity(
    p_doctor_id UUID,
    p_date DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_bad_order BIGINT;
    v_completed_missing_ts BIGINT;
BEGIN

    SELECT COUNT(*) INTO v_bad_order
    FROM public.bookings b
    WHERE b.assigned_doctor_id = p_doctor_id
      AND b.appointment_date = p_date
      AND b.is_deleted = false
      AND b.consultation_started_at IS NOT NULL
      AND b.consultation_completed_at IS NOT NULL
      AND b.consultation_completed_at < b.consultation_started_at;

    SELECT COUNT(*) INTO v_completed_missing_ts
    FROM public.bookings b
    WHERE b.assigned_doctor_id = p_doctor_id
      AND b.appointment_date = p_date
      AND b.status = 'completed'
      AND b.is_deleted = false
      AND b.consultation_completed_at IS NULL;

    RETURN jsonb_build_object(
        'ok', v_bad_order = 0 AND v_completed_missing_ts = 0,
        'timestamp_order_violations', v_bad_order,
        'completed_without_timestamp', v_completed_missing_ts
    );

END;
$$;

-- Integration matrix: booking -> collection -> ledger chain
-- verification for a hospital-day (workflow verification).
CREATE OR REPLACE FUNCTION public.verify_integration_matrix(
    p_hospital_id UUID,
    p_date DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_collections_without_booking BIGINT;
    v_ledger_without_source BIGINT;
BEGIN

    SELECT COUNT(*) INTO v_collections_without_booking
    FROM public.daily_collection_entries dce
    WHERE dce.hospital_id = p_hospital_id
      AND dce.collection_date = p_date
      AND dce.booking_id IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM public.bookings b
          WHERE b.id = dce.booking_id
      );

    SELECT COUNT(*) INTO v_ledger_without_source
    FROM public.financial_ledger fl
    WHERE fl.hospital_id = p_hospital_id
      AND fl.created_at::date = p_date
      AND fl.booking_id IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM public.bookings b
          WHERE b.id = fl.booking_id
      );

    RETURN jsonb_build_object(
        'ok', v_collections_without_booking = 0
            AND v_ledger_without_source = 0,
        'collections_without_booking', v_collections_without_booking,
        'ledger_without_source', v_ledger_without_source
    );

END;
$$;

-- =============================================================
-- 13. TABLE PRIVILEGES & FUNCTION GRANTS
-- =============================================================

REVOKE ALL ON TABLE public.alert_activity_log FROM PUBLIC;
REVOKE ALL ON TABLE public.alert_activity_log FROM anon;
REVOKE ALL ON TABLE public.alert_activity_log FROM authenticated;
REVOKE ALL ON TABLE public.alert_activity_log FROM service_role;
GRANT SELECT, INSERT ON TABLE public.alert_activity_log TO service_role;

REVOKE ALL ON TABLE public.alert_suppressions FROM PUBLIC;
REVOKE ALL ON TABLE public.alert_suppressions FROM anon;
REVOKE ALL ON TABLE public.alert_suppressions FROM authenticated;
REVOKE ALL ON TABLE public.alert_suppressions FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.alert_suppressions TO service_role;

GRANT EXECUTE ON FUNCTION
    public.is_alert_suppressed(UUID, TEXT),
    public.log_alert_activity(UUID, UUID, UUID, TEXT, TEXT),
    public.acknowledge_alert(UUID, UUID),
    public.assign_alert(UUID, UUID, UUID),
    public.resolve_alert(UUID, UUID, TEXT),
    public.escalate_alert(UUID, UUID, TEXT),
    public.suppress_alerts(TEXT, TIMESTAMPTZ, UUID, UUID, TEXT),
    public.fire_managed_alert(UUID, TEXT, public.alert_severity_level, NUMERIC, NUMERIC, TEXT, TEXT, TEXT),
    public.get_alert_center(UUID, TEXT, TEXT, TEXT, INTEGER),
    public.get_alert_analytics(UUID, DATE, DATE),
    public.get_hospital_timeline(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], TEXT, UUID, UUID, INTEGER),
    public.get_hospital_command_center(UUID, DATE),
    public.get_daily_operations_dashboard(UUID, DATE),
    public.get_weekly_dashboard(UUID, DATE),
    public.get_monthly_dashboard(UUID, DATE),
    public.get_doctor_performance(UUID, UUID, DATE, DATE),
    public.get_doctor_rankings(UUID, DATE, DATE),
    public.get_financial_command_center(UUID, DATE),
    public.get_revenue_forecast(UUID, DATE),
    public.get_sla_dashboard(UUID, DATE),
    public.get_operational_scores(UUID, DATE),
    public.get_portfolio_dashboard(DATE),
    public.get_cross_hospital_benchmarks(DATE, DATE),
    public.get_predictive_insights(UUID, DATE),
    public.generate_executive_report(TEXT, UUID, DATE, DATE),
    public.search_audit_logs(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER),
    public.verify_audit_integrity(UUID, TIMESTAMPTZ),
    public.verify_settlement_integrity(UUID),
    public.verify_queue_integrity(UUID),
    public.verify_doctor_operations_integrity(UUID, DATE),
    public.verify_integration_matrix(UUID, DATE)
TO service_role;
