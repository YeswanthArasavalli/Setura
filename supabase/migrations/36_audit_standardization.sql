-- =============================================================
-- SETURA HOSPITAL OS
-- Script 36A: Security Event Enum Expansion
-- Run AFTER Script 35
-- =============================================================

BEGIN;

DO $$
BEGIN
    ALTER TYPE public.security_event_type
        ADD VALUE IF NOT EXISTS 'brute_force_detected';
EXCEPTION
    WHEN duplicate_object THEN NULL;
END;
$$;

DO $$
BEGIN
    ALTER TYPE public.security_event_type
        ADD VALUE IF NOT EXISTS 'session_hijack_attempt';
EXCEPTION
    WHEN duplicate_object THEN NULL;
END;
$$;

DO $$
BEGIN
    ALTER TYPE public.security_event_type
        ADD VALUE IF NOT EXISTS 'ip_blocklist_violation';
EXCEPTION
    WHEN duplicate_object THEN NULL;
END;
$$;

DO $$
BEGIN
    ALTER TYPE public.security_event_type
        ADD VALUE IF NOT EXISTS 'payment_anomaly';
EXCEPTION
    WHEN duplicate_object THEN NULL;
END;
$$;

COMMIT;

-- =============================================================
-- AUDIT ACTION TYPES FRAMEWORK
-- BACKWARD COMPATIBILITY:
--   audit_logs.action_type remains TEXT.
--   Unregistered action types are still accepted.
-- =============================================================

BEGIN;

-- ============================================================
-- AUDIT ACTION TYPES REFERENCE TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS public.audit_action_types (
    action_type TEXT PRIMARY KEY,

    display_name TEXT NOT NULL,

    default_severity public.audit_action_severity
        NOT NULL DEFAULT 'low',

    category TEXT NOT NULL
        CHECK (
            category IN (
                'authentication',
                'authorization',
                'booking',
                'payment',
                'user_management',
                'configuration',
                'data',
                'system'
            )
        ),

    description TEXT,

    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_action_types_category
    ON public.audit_action_types (
        category,
        is_active
    );

-- ============================================================
-- STANDARD ACTION TYPES
-- ============================================================

INSERT INTO public.audit_action_types (
    action_type,
    display_name,
    default_severity,
    category,
    description
)
VALUES

-- ============================================================
-- AUTHENTICATION
-- ============================================================

(
    'LOGIN',
    'User Login',
    'low',
    'authentication',
    'Successful user login'
),
(
    'LOGOUT',
    'User Logout',
    'low',
    'authentication',
    'User logout'
),
(
    'LOGIN_FAILED',
    'Login Failed',
    'medium',
    'authentication',
    'Failed login attempt'
),
(
    'PASSWORD_RESET',
    'Password Reset',
    'medium',
    'authentication',
    'Password reset requested or completed'
),
(
    'TOKEN_REFRESH',
    'Token Refreshed',
    'low',
    'authentication',
    'Token refreshed'
),
(
    'SESSION_EXPIRED',
    'Session Expired',
    'low',
    'authentication',
    'Session expired'
),
(
    'MFA_ENABLED',
    'MFA Enabled',
    'medium',
    'authentication',
    'MFA enabled'
),
(
    'MFA_DISABLED',
    'MFA Disabled',
    'high',
    'authentication',
    'MFA disabled'
),

-- ============================================================
-- AUTHORIZATION
-- ============================================================

(
    'ROLE_CHANGE',
    'Role Changed',
    'high',
    'authorization',
    'Role changed'
),
(
    'ROLE_ASSIGNED',
    'Role Assigned',
    'high',
    'authorization',
    'Role assigned'
),
(
    'ROLE_REVOKED',
    'Role Revoked',
    'high',
    'authorization',
    'Role revoked'
),
(
    'PERMISSION_DENIED',
    'Permission Denied',
    'medium',
    'authorization',
    'Permission denied'
),
(
    'UNAUTHORIZED_ACCESS',
    'Unauthorized Access',
    'critical',
    'authorization',
    'Unauthorized access attempt'
),

-- ============================================================
-- BOOKING
-- ============================================================

(
    'BOOKING_CREATE',
    'Booking Created',
    'low',
    'booking',
    'Booking created'
),
(
    'BOOKING_CANCEL',
    'Booking Cancelled',
    'medium',
    'booking',
    'Booking cancelled'
),
(
    'BOOKING_UPDATE',
    'Booking Updated',
    'low',
    'booking',
    'Booking updated'
),
(
    'BOOKING_COMPLETE',
    'Booking Completed',
    'low',
    'booking',
    'Booking completed'
),
(
    'BOOKING_NO_SHOW',
    'Patient No Show',
    'low',
    'booking',
    'Patient no-show'
),
(
    'BOOKING_RESCHEDULE',
    'Booking Rescheduled',
    'low',
    'booking',
    'Booking rescheduled'
),
(
    'QUEUE_ADVANCE',
    'Queue Advanced',
    'low',
    'booking',
    'Queue advanced'
),
(
    'CARRY_FORWARD',
    'Booking Carry Forward',
    'low',
    'booking',
    'Booking carried forward'
),

-- ============================================================
-- PAYMENT
-- ============================================================

(
    'PAYMENT',
    'Payment Processed',
    'medium',
    'payment',
    'Payment captured'
),
(
    'PAYMENT_INITIATED',
    'Payment Initiated',
    'low',
    'payment',
    'Payment flow initiated'
),
(
    'PAYMENT_FAILED',
    'Payment Failed',
    'medium',
    'payment',
    'Payment failed'
),
(
    'REFUND',
    'Refund Issued',
    'high',
    'payment',
    'Refund issued'
),
(
    'REFUND_INITIATED',
    'Refund Initiated',
    'medium',
    'payment',
    'Refund initiated'
),
(
    'REFUND_FAILED',
    'Refund Failed',
    'high',
    'payment',
    'Refund failed'
),
(
    'SETTLEMENT_CREATED',
    'Revenue Summary Created',
    'medium',
    'payment',
    'Revenue summary generated'
),

-- ============================================================
-- USER MANAGEMENT
-- ============================================================

(
    'USER_CREATE',
    'User Created',
    'medium',
    'user_management',
    'User created'
),
(
    'USER_UPDATE',
    'User Updated',
    'low',
    'user_management',
    'User updated'
),
(
    'USER_DEACTIVATE',
    'User Deactivated',
    'high',
    'user_management',
    'User deactivated'
),
(
    'USER_REACTIVATE',
    'User Reactivated',
    'medium',
    'user_management',
    'User reactivated'
),
(
    'DOCTOR_LEAVE',
    'Doctor Leave Recorded',
    'low',
    'user_management',
    'Doctor leave created'
),
(
    'DOCTOR_LEAVE_APPROVE',
    'Doctor Leave Approved',
    'medium',
    'user_management',
    'Doctor leave approved'
),

-- ============================================================
-- CONFIGURATION
-- ============================================================

(
    'CONFIG_UPDATE',
    'Configuration Updated',
    'medium',
    'configuration',
    'Configuration changed'
),
(
    'FEE_CHANGE',
    'Fee Configuration Changed',
    'high',
    'configuration',
    'Fee changed'
),
(
    'POLICY_UPDATE',
    'Policy Updated',
    'medium',
    'configuration',
    'Policy changed'
),
(
    'FEATURE_FLAG_CHANGE',
    'Feature Flag Changed',
    'medium',
    'configuration',
    'Feature flag changed'
),
(
    'SUBSCRIPTION_CHANGE',
    'Subscription Changed',
    'high',
    'configuration',
    'Subscription changed'
),

-- ============================================================
-- DATA
-- ============================================================

(
    'PATIENT_CREATE',
    'Patient Created',
    'low',
    'data',
    'Patient created'
),
(
    'PATIENT_UPDATE',
    'Patient Updated',
    'low',
    'data',
    'Patient updated'
),
(
    'PATIENT_DELETE',
    'Patient Deleted',
    'high',
    'data',
    'Patient deleted'
),
(
    'DATA_EXPORT',
    'Data Exported',
    'high',
    'data',
    'Data exported'
),
(
    'DATA_IMPORT',
    'Data Imported',
    'high',
    'data',
    'Data imported'
),

-- ============================================================
-- SYSTEM
-- ============================================================

(
    'SYSTEM_START',
    'System Started',
    'low',
    'system',
    'System started'
),
(
    'SYSTEM_ERROR',
    'System Error',
    'critical',
    'system',
    'System error'
),
(
    'ANALYTICS_REFRESH',
    'Analytics Refreshed',
    'low',
    'system',
    'Analytics refresh'
),
(
    'BACKUP_CREATED',
    'Backup Created',
    'low',
    'system',
    'Backup created'
)

ON CONFLICT (action_type)
DO NOTHING;

-- ============================================================
-- ENHANCED AUDIT WRITER
-- ============================================================

CREATE OR REPLACE FUNCTION public.write_audit_log(
    p_hospital_id UUID,
    p_actor_id UUID,
    p_entity_type TEXT,
    p_entity_id UUID,
    p_action TEXT,
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

REVOKE ALL
ON FUNCTION public.write_audit_log(
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
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.write_audit_log(
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
TO authenticated;

-- ============================================================
-- AUDIT COVERAGE REPORT
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_audit_coverage_report(
    p_hospital_id UUID,
    p_from_date DATE DEFAULT CURRENT_DATE - 30,
    p_to_date DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
    action_type TEXT,
    category TEXT,
    default_severity TEXT,
    logged_count BIGINT,
    last_logged_at TIMESTAMPTZ,
    has_coverage BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
SELECT
    aat.action_type,
    aat.category,
    aat.default_severity::TEXT,
    COALESCE(c.cnt, 0),
    c.last_at,
    COALESCE(c.cnt, 0) > 0
FROM public.audit_action_types aat
LEFT JOIN (
    SELECT
        action_type,
        COUNT(*) AS cnt,
        MAX(created_at) AS last_at
    FROM public.audit_logs
    WHERE (hospital_id = p_hospital_id OR hospital_id IS NULL)
      AND created_at::DATE BETWEEN p_from_date AND p_to_date
    GROUP BY action_type
) c
ON c.action_type = aat.action_type
WHERE aat.is_active = TRUE
ORDER BY
    aat.category,
    aat.action_type;
$$;

COMMENT ON FUNCTION public.get_audit_coverage_report(
    UUID,
    DATE,
    DATE
)
IS 'Reports coverage for registered audit action types only. Custom or unregistered action types are intentionally excluded.';

REVOKE ALL
ON FUNCTION public.get_audit_coverage_report(UUID, DATE, DATE)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.get_audit_coverage_report(UUID, DATE, DATE)
TO authenticated;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE public.audit_action_types
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.audit_action_types
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS aat_read
ON public.audit_action_types;

CREATE POLICY aat_read
ON public.audit_action_types
FOR SELECT
USING (
    is_active = TRUE
    OR public.is_global_admin()
);

DROP POLICY IF EXISTS aat_manage
ON public.audit_action_types;

CREATE POLICY aat_manage
ON public.audit_action_types
FOR ALL
USING (
    public.is_global_admin()
)
WITH CHECK (
    public.is_global_admin()
);

COMMIT;