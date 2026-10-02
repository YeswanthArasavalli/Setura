-- =============================================================
-- Migration 64 - C2 alert lifecycle: locked before/after snapshot
-- =============================================================
--
-- Class: additive re-sign of the four row lifecycle RPCs to return a
-- transactional, lock-consistent audit snapshot. No other SQL is
-- created or modified here.
--
-- Authoritative design:
--   * C2_OWNER_DECISION_CLOSURE.md  (OD-d = D1, OD-e, OD-a, OD-f)
--   * C2_MIGRATION_DESIGN_REVIEW.md (sec.6 locked snapshot, sec.12 ACL, sec.13 order)
--
-- Scope discipline:
--   * Bodies are authored directly from the migration-48 definitions.
--   * Authorization (has_permission -> RAISE 42501), tenant checks,
--     FOR UPDATE, state guards, the single UPDATE, the in-transaction
--     log_alert_activity call and the existing response keys/soft-success
--     semantics are preserved verbatim.
--   * The ONLY behavioral addition is a locked `before`/`after` snapshot
--     appended to the JSONB returned for a REAL transition. The
--     alert_not_found, 42501 and already_* branches are unchanged.
--   * D1 preserved: no is_resolved guard is added to ACK/ASSIGN/ESCALATE;
--     post-resolve mutation remains permitted; no REOPEN.
--   * suppress_alerts is intentionally NOT re-signed (no lifecycle state,
--     no activity row; a snapshot would imply idempotency it lacks).
--   * Migrations 47/48 are historical artifacts and are NOT edited.
--
-- Security (F16-04):
--   * Each function is a same-signature CREATE OR REPLACE of an existing
--     SECURITY DEFINER signature, so pg_proc.proacl (the 48-era REVOKE/
--     GRANT posture) is preserved automatically. This migration adds NO
--     GRANT, NO REVOKE and NO new function; it only redefines existing
--     OIDs. `SECURITY DEFINER` and `SET search_path = public` are kept.
--
-- Snapshot contract (OD-e PII minimisation):
--   Only audit-relevant lifecycle columns are exposed. Patient PII,
--   alert_events.message and resolution_notes are deliberately EXCLUDED
--   (notes already live in alert_activity_log; the snapshot must not copy
--   operational free text into every audit row).

-- =============================================================
-- acknowledge_alert
-- =============================================================

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
    v_before JSONB;
    v_after JSONB;
BEGIN

    SELECT
        id, hospital_id,
        acknowledged_at, acknowledged_by,
        assigned_to,
        escalated_at, escalated_by,
        is_resolved, resolved_at, resolved_by,
        severity
    INTO v_alert
    FROM public.alert_events
    WHERE id = p_alert_id
    FOR UPDATE;

    IF v_alert.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'alert_not_found');
    END IF;

    IF NOT public.has_permission(
        p_actor_id,
        v_alert.hospital_id,
        'MANAGE_HOSPITAL'
    ) THEN
        RAISE EXCEPTION
            'not_authorized: actor lacks MANAGE_HOSPITAL for this alert'
            USING ERRCODE = '42501';
    END IF;

    IF v_alert.acknowledged_at IS NOT NULL THEN
        RETURN jsonb_build_object('ok', true, 'already_acknowledged', true);
    END IF;

    -- Authoritative BEFORE snapshot, captured while the row lock is held.
    v_before := jsonb_build_object(
        'id', v_alert.id,
        'hospital_id', v_alert.hospital_id,
        'acknowledged_at', v_alert.acknowledged_at,
        'acknowledged_by', v_alert.acknowledged_by,
        'assigned_to', v_alert.assigned_to,
        'escalated_at', v_alert.escalated_at,
        'escalated_by', v_alert.escalated_by,
        'is_resolved', v_alert.is_resolved,
        'resolved_at', v_alert.resolved_at,
        'resolved_by', v_alert.resolved_by,
        'severity', v_alert.severity
    );

    UPDATE public.alert_events
    SET
        acknowledged_at = now(),
        acknowledged_by = p_actor_id
    WHERE id = p_alert_id;

    PERFORM public.log_alert_activity(
        p_alert_id, v_alert.hospital_id, p_actor_id, 'acknowledged', NULL
    );

    -- Authoritative AFTER snapshot, re-read while the lock is still held.
    SELECT jsonb_build_object(
        'id', id,
        'hospital_id', hospital_id,
        'acknowledged_at', acknowledged_at,
        'acknowledged_by', acknowledged_by,
        'assigned_to', assigned_to,
        'escalated_at', escalated_at,
        'escalated_by', escalated_by,
        'is_resolved', is_resolved,
        'resolved_at', resolved_at,
        'resolved_by', resolved_by,
        'severity', severity
    )
    INTO v_after
    FROM public.alert_events
    WHERE id = p_alert_id;

    RETURN jsonb_build_object(
        'ok', true, 'already_acknowledged', false,
        'before', v_before, 'after', v_after
    );

END;
$$;

-- =============================================================
-- assign_alert
-- =============================================================

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
    v_before JSONB;
    v_after JSONB;
BEGIN

    SELECT
        id, hospital_id,
        acknowledged_at, acknowledged_by,
        assigned_to,
        escalated_at, escalated_by,
        is_resolved, resolved_at, resolved_by,
        severity
    INTO v_alert
    FROM public.alert_events
    WHERE id = p_alert_id
    FOR UPDATE;

    IF v_alert.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'alert_not_found');
    END IF;

    IF NOT public.has_permission(
        p_actor_id,
        v_alert.hospital_id,
        'MANAGE_HOSPITAL'
    ) THEN
        RAISE EXCEPTION
            'not_authorized: actor lacks MANAGE_HOSPITAL for this alert'
            USING ERRCODE = '42501';
    END IF;

    IF v_alert.assigned_to IS NOT DISTINCT FROM p_assignee_id THEN
        RETURN jsonb_build_object('ok', true, 'already_assigned', true);
    END IF;

    v_before := jsonb_build_object(
        'id', v_alert.id,
        'hospital_id', v_alert.hospital_id,
        'acknowledged_at', v_alert.acknowledged_at,
        'acknowledged_by', v_alert.acknowledged_by,
        'assigned_to', v_alert.assigned_to,
        'escalated_at', v_alert.escalated_at,
        'escalated_by', v_alert.escalated_by,
        'is_resolved', v_alert.is_resolved,
        'resolved_at', v_alert.resolved_at,
        'resolved_by', v_alert.resolved_by,
        'severity', v_alert.severity
    );

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

    SELECT jsonb_build_object(
        'id', id,
        'hospital_id', hospital_id,
        'acknowledged_at', acknowledged_at,
        'acknowledged_by', acknowledged_by,
        'assigned_to', assigned_to,
        'escalated_at', escalated_at,
        'escalated_by', escalated_by,
        'is_resolved', is_resolved,
        'resolved_at', resolved_at,
        'resolved_by', resolved_by,
        'severity', severity
    )
    INTO v_after
    FROM public.alert_events
    WHERE id = p_alert_id;

    RETURN jsonb_build_object(
        'ok', true, 'already_assigned', false,
        'before', v_before, 'after', v_after
    );

END;
$$;

-- =============================================================
-- resolve_alert
-- =============================================================

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
    v_before JSONB;
    v_after JSONB;
BEGIN

    SELECT
        id, hospital_id,
        acknowledged_at, acknowledged_by,
        assigned_to,
        escalated_at, escalated_by,
        is_resolved, resolved_at, resolved_by,
        severity
    INTO v_alert
    FROM public.alert_events
    WHERE id = p_alert_id
    FOR UPDATE;

    IF v_alert.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'alert_not_found');
    END IF;

    IF NOT public.has_permission(
        p_actor_id,
        v_alert.hospital_id,
        'MANAGE_HOSPITAL'
    ) THEN
        RAISE EXCEPTION
            'not_authorized: actor lacks MANAGE_HOSPITAL for this alert'
            USING ERRCODE = '42501';
    END IF;

    IF v_alert.is_resolved THEN
        RETURN jsonb_build_object('ok', true, 'already_resolved', true);
    END IF;

    v_before := jsonb_build_object(
        'id', v_alert.id,
        'hospital_id', v_alert.hospital_id,
        'acknowledged_at', v_alert.acknowledged_at,
        'acknowledged_by', v_alert.acknowledged_by,
        'assigned_to', v_alert.assigned_to,
        'escalated_at', v_alert.escalated_at,
        'escalated_by', v_alert.escalated_by,
        'is_resolved', v_alert.is_resolved,
        'resolved_at', v_alert.resolved_at,
        'resolved_by', v_alert.resolved_by,
        'severity', v_alert.severity
    );

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

    SELECT jsonb_build_object(
        'id', id,
        'hospital_id', hospital_id,
        'acknowledged_at', acknowledged_at,
        'acknowledged_by', acknowledged_by,
        'assigned_to', assigned_to,
        'escalated_at', escalated_at,
        'escalated_by', escalated_by,
        'is_resolved', is_resolved,
        'resolved_at', resolved_at,
        'resolved_by', resolved_by,
        'severity', severity
    )
    INTO v_after
    FROM public.alert_events
    WHERE id = p_alert_id;

    RETURN jsonb_build_object(
        'ok', true, 'already_resolved', false,
        'before', v_before, 'after', v_after
    );

END;
$$;

-- =============================================================
-- escalate_alert
-- =============================================================

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
    v_before JSONB;
    v_after JSONB;
BEGIN

    SELECT
        id, hospital_id,
        acknowledged_at, acknowledged_by,
        assigned_to,
        escalated_at, escalated_by,
        is_resolved, resolved_at, resolved_by,
        severity
    INTO v_alert
    FROM public.alert_events
    WHERE id = p_alert_id
    FOR UPDATE;

    IF v_alert.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'alert_not_found');
    END IF;

    IF NOT public.has_permission(
        p_actor_id,
        v_alert.hospital_id,
        'MANAGE_HOSPITAL'
    ) THEN
        RAISE EXCEPTION
            'not_authorized: actor lacks MANAGE_HOSPITAL for this alert'
            USING ERRCODE = '42501';
    END IF;

    IF v_alert.escalated_at IS NOT NULL THEN
        RETURN jsonb_build_object('ok', true, 'already_escalated', true);
    END IF;

    v_before := jsonb_build_object(
        'id', v_alert.id,
        'hospital_id', v_alert.hospital_id,
        'acknowledged_at', v_alert.acknowledged_at,
        'acknowledged_by', v_alert.acknowledged_by,
        'assigned_to', v_alert.assigned_to,
        'escalated_at', v_alert.escalated_at,
        'escalated_by', v_alert.escalated_by,
        'is_resolved', v_alert.is_resolved,
        'resolved_at', v_alert.resolved_at,
        'resolved_by', v_alert.resolved_by,
        'severity', v_alert.severity
    );

    UPDATE public.alert_events
    SET
        escalated_at = now(),
        escalated_by = p_actor_id,
        severity = 'critical'::public.alert_severity_level
    WHERE id = p_alert_id;

    PERFORM public.log_alert_activity(
        p_alert_id, v_alert.hospital_id, p_actor_id, 'escalated', p_notes
    );

    SELECT jsonb_build_object(
        'id', id,
        'hospital_id', hospital_id,
        'acknowledged_at', acknowledged_at,
        'acknowledged_by', acknowledged_by,
        'assigned_to', assigned_to,
        'escalated_at', escalated_at,
        'escalated_by', escalated_by,
        'is_resolved', is_resolved,
        'resolved_at', resolved_at,
        'resolved_by', resolved_by,
        'severity', severity
    )
    INTO v_after
    FROM public.alert_events
    WHERE id = p_alert_id;

    RETURN jsonb_build_object(
        'ok', true, 'already_escalated', false,
        'before', v_before, 'after', v_after
    );

END;
$$;
