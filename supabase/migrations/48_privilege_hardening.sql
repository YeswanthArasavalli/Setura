-- ============================================================
-- SETURA - Script 48: Privilege Hardening + Tenant Isolation
-- FULL HARDENED PRODUCTION VERSION
-- SUPABASE SAFE
-- FIRST RUN SAFE
-- RE-RUN SAFE
-- ============================================================
--
-- PURPOSE
-- -------
-- Closes the database-level privilege boundary. Until this
-- migration, every function created in schema public inherited
-- EXECUTE for anon and authenticated from Supabase's installed
-- default privileges:
--
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--       GRANT EXECUTE ON FUNCTIONS
--       TO postgres, anon, authenticated, service_role;
--
-- Those are explicit *role* grants, therefore the 54 statements of
-- the form "REVOKE ALL ON FUNCTION ... FROM PUBLIC" present in
-- migrations 27-46 are runtime no-ops: they revoke the PUBLIC
-- pseudo-role, not anon/authenticated. Migration 39 is the only
-- prior migration that used the complete pattern
-- (REVOKE FROM PUBLIC + anon + authenticated, then GRANT to
-- service_role); that pattern is reused verbatim here.
--
-- Consequence before this migration: all 193 SECURITY DEFINER
-- functions in schema public except stop_worker and
-- recalculate_queue_position were directly callable through
-- PostgREST by an unauthenticated caller holding only the public
-- anon key. SECURITY DEFINER bypasses RLS, so this bypassed every
-- Edge Function authorization check.
--
-- CLASSIFICATION SOURCE
-- ---------------------
-- docs/security/RPC_PRIVILEGE_CLASSIFICATION.tsv (193 rows)
--   A  =   4  authenticated public API  (RLS policy helpers)
--   B  = 145  internal edge/worker/cron -> service_role only
--   B-trigger = 10 trigger functions    -> not PostgREST callable
--   C  =  10  administrative / global   -> service_role only
--   D  =  24  financial / security      -> service_role only
--
-- SECTIONS
-- --------
--   1. Alert mutation authorization (CREATE OR REPLACE)
--   2. Fail-closed default privileges for future objects
--   3. Category A explicit grants (the only public RPC surface)
--   4. Category D explicit revoke / grant (financial, security)
--   5. Category C explicit revoke / grant (administrative)
--   6. Remaining SECURITY DEFINER functions (Category B)
--   7. Project-owned SECURITY INVOKER operational functions
--   8. Tenant isolation: RLS + FORCE RLS + hospital-scoped policies
--   9. Privileged configuration tables
--  10. alert_events (hospital, is_resolved) index
--  11. Verification of the resulting privilege state
--
-- SAFETY
-- ------
-- service_role and postgres both have rolbypassrls = true in
-- Supabase, so enabling RLS and FORCE ROW LEVEL SECURITY cannot
-- restrict the worker, the cron jobs, the Edge Functions (which
-- all use the service role key) or any postgres-owned
-- SECURITY DEFINER function body. Internal runtime flows are
-- therefore unaffected by section 8.
--
-- Every REVOKE / GRANT statement below is idempotent. Every
-- CREATE OR REPLACE FUNCTION preserves the existing ACL of the
-- function it replaces, so section 1 running before sections 3-6
-- is safe in either order.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. ALERT MUTATION AUTHORIZATION
-- ============================================================
--
-- acknowledge_alert, assign_alert, resolve_alert, escalate_alert
-- and suppress_alerts are SECURITY DEFINER and performed no
-- authorization check whatsoever: they trusted the caller-supplied
-- p_actor_id and mutated any alert by id, across any hospital.
--
-- The certified Edge Function contract in
-- supabase/functions/alert-center/index.ts is:
--
--     requireRole(auth, ["hospital_admin", "global_admin"])
--     + loadAuthorizedAlert() rejecting a different hospital_id
--
-- The database now enforces the same rule using the existing
-- actor-scoped helper public.has_permission(user, hospital,
-- permission). MANAGE_HOSPITAL is held by hospital_admin and
-- global_admin only, and has_permission matches global_admin
-- regardless of hospital while every other role must match the
-- hospital exactly. No second tenant-resolution model is
-- introduced.
--
-- Fail-closed properties:
--   * p_actor_id NULL              -> has_permission false -> deny
--   * actor from another hospital  -> deny
--   * ordinary doctor/receptionist -> deny
--   * global (hospital_id IS NULL) -> global_admin only
--
-- Bodies are otherwise unchanged from migration 47, including the
-- idempotent return contracts asserted by the existing integration
-- tests. Signatures and parameter defaults are unchanged.

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

    -- Authorization first: a suppression window hides alerts, so an
    -- unauthorized caller must not learn anything from the result.
    -- p_hospital_id NULL means a platform-wide suppression, which
    -- has_permission grants to global_admin only.
    IF NOT public.has_permission(
        p_actor_id,
        p_hospital_id,
        'MANAGE_HOSPITAL'
    ) THEN
        RAISE EXCEPTION
            'not_authorized: actor lacks MANAGE_HOSPITAL for this scope'
            USING ERRCODE = '42501';
    END IF;

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

-- fire_managed_alert takes no actor: it is the internal alert
-- engine entry point called by the monitoring cron and by
-- SECURITY DEFINER health checks. It is protected by
-- service_role-only EXECUTE in section 6 rather than by an actor
-- check, because there is no user actor in that path.

-- ============================================================
-- 2. FAIL-CLOSED DEFAULT PRIVILEGES FOR FUTURE OBJECTS
-- ============================================================
--
-- Root cause remediation. Without this, migration 50 and every
-- later migration would silently re-introduce the same defect:
-- any newly created function would again be EXECUTE-able by anon.
--
-- ALTER DEFAULT PRIVILEGES is per-grantor-role, so the entries
-- actually installed by Supabase must be discovered from
-- pg_default_acl rather than assumed. Roles this migration is not
-- a member of are skipped with a NOTICE instead of failing the
-- migration, because the set of grantor roles differs between a
-- local CLI stack and a hosted project.
--
-- Effect is limited to objects created AFTER this migration in
-- schema public. Existing objects are handled explicitly in
-- sections 3-9.

DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT DISTINCT pg_get_userbyid(d.defaclrole) AS grantor
        FROM pg_default_acl d
        JOIN pg_namespace n ON n.oid = d.defaclnamespace
        WHERE n.nspname = 'public'
          AND d.defaclobjtype IN ('f', 'r')
    LOOP
        BEGIN
            EXECUTE format(
                'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
                || 'REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated',
                r.grantor
            );
            EXECUTE format(
                'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
                || 'REVOKE ALL ON TABLES FROM anon, authenticated',
                r.grantor
            );
            RAISE NOTICE
                'default privileges hardened for grantor role %',
                r.grantor;
        EXCEPTION
            WHEN insufficient_privilege THEN
                RAISE NOTICE
                    'skipped default privileges for role % (not a member)',
                    r.grantor;
        END;
    END LOOP;
END;
$$;

-- Unconditional pair for the role running this migration, which
-- may not yet have a pg_default_acl row of its own.

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE ALL ON TABLES FROM anon, authenticated;

-- ============================================================
-- 3. CATEGORY A - THE ONLY PUBLIC RPC SURFACE (4 FUNCTIONS)
-- ============================================================
--
-- These four SECURITY DEFINER helpers are referenced by RLS
-- policies. A scan of every expression in pg_policies against
-- every function name in schema public produced 193 references and
-- exactly four distinct functions:
--
--   is_global_admin()                 117 policy references
--   current_user_role(uuid)            56
--   user_has_hospital_access(uuid)     18
--   user_has_hospital_role(uuid,text[]) 2
--
-- Every policy in SETURA is defined TO {public}, which includes
-- anon, so the request role itself evaluates these helpers. If
-- EXECUTE were revoked, every RLS-protected SELECT by anon or
-- authenticated would fail with "permission denied for function".
--
-- Exposing them is safe: all four are
-- LANGUAGE sql STABLE SECURITY DEFINER
-- SET search_path = public SET row_security = off,
-- and all four scope themselves to auth.uid(). They report facts
-- about the caller only; they accept no actor parameter and
-- perform no mutation, so they cannot be used to read or change
-- another user's or another hospital's data.
--
-- These grants are stated explicitly (rather than relied upon from
-- the pre-existing default privileges) so that the intent is
-- recorded in schema history and so that section 2 cannot strand
-- them on a future rebuild.

GRANT EXECUTE ON FUNCTION public.is_global_admin()
    TO anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.current_user_role(UUID)
    TO anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.user_has_hospital_access(UUID)
    TO anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.user_has_hospital_role(UUID, TEXT[])
    TO anon, authenticated, service_role;

-- ============================================================
-- 4. CATEGORY D - FINANCIAL AND SECURITY-SENSITIVE (24)
-- ============================================================
--
-- Money movement, refunds, settlements, platform revenue,
-- fee resolution, permission introspection and the audit trail.
-- Every one of these was directly callable by anon before this
-- migration. capture_payment has two overloads and BOTH are
-- listed; revoking only one would leave the other reachable.
--
-- Migration 39's pattern is used, with the three revoked roles
-- combined into a single REVOKE statement per function (identical
-- semantics, one line per function instead of three, so that the
-- 34 explicit entries in sections 4 and 5 stay reviewable).
--
-- Only service_role receives EXECUTE. All 26 Edge Functions
-- obtain their database client from _shared/db.ts getServiceClient(),
-- so no production caller loses access. getAnonClient() exists but
-- is never invoked, and there is no frontend yet.

REVOKE ALL ON FUNCTION public.calculate_refund_amount(UUID, TIMESTAMPTZ)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.calculate_refund_amount(UUID, TIMESTAMPTZ)
    TO service_role;

REVOKE ALL ON FUNCTION public.capture_payment(TEXT, TEXT, TEXT, JSONB)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capture_payment(TEXT, TEXT, TEXT, JSONB)
    TO service_role;

REVOKE ALL ON FUNCTION public.capture_payment(
    TEXT, TEXT, TEXT, JSONB, NUMERIC
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capture_payment(
    TEXT, TEXT, TEXT, JSONB, NUMERIC
) TO service_role;

REVOKE ALL ON FUNCTION public.confirm_refund_processed(UUID, TEXT, JSONB)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_refund_processed(UUID, TEXT, JSONB)
    TO service_role;

REVOKE ALL ON FUNCTION public.create_hospital_settlement(
    UUID, DATE, DATE, UUID
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_hospital_settlement(
    UUID, DATE, DATE, UUID
) TO service_role;

REVOKE ALL ON FUNCTION public.create_platform_revenue_summary(
    UUID, DATE, DATE, UUID
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_platform_revenue_summary(
    UUID, DATE, DATE, UUID
) TO service_role;

REVOKE ALL ON FUNCTION public.current_user_has_permission(UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_has_permission(UUID, TEXT)
    TO service_role;

REVOKE ALL ON FUNCTION public.generate_audit_log_partition_ddl(INTEGER)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generate_audit_log_partition_ddl(INTEGER)
    TO service_role;

REVOKE ALL ON FUNCTION public.get_audit_coverage_report(UUID, DATE, DATE)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_audit_coverage_report(UUID, DATE, DATE)
    TO service_role;

REVOKE ALL ON FUNCTION public.get_booking_fee(
    UUID, public.booking_source
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_booking_fee(
    UUID, public.booking_source
) TO service_role;

REVOKE ALL ON FUNCTION public.get_effective_fees(
    UUID, public.booking_source
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_effective_fees(
    UUID, public.booking_source
) TO service_role;

REVOKE ALL ON FUNCTION public.get_financial_command_center(UUID, DATE)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_financial_command_center(UUID, DATE)
    TO service_role;

REVOKE ALL ON FUNCTION public.get_platform_revenue_breakdown(
    UUID, DATE, DATE
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_platform_revenue_breakdown(
    UUID, DATE, DATE
) TO service_role;

REVOKE ALL ON FUNCTION public.get_reconciliation_summary(UUID, DATE, DATE)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_reconciliation_summary(UUID, DATE, DATE)
    TO service_role;

REVOKE ALL ON FUNCTION public.get_revenue_forecast(UUID, DATE)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_revenue_forecast(UUID, DATE)
    TO service_role;

REVOKE ALL ON FUNCTION public.get_user_permissions(UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_permissions(UUID)
    TO service_role;

REVOKE ALL ON FUNCTION public.has_permission(UUID, UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_permission(UUID, UUID, TEXT)
    TO service_role;

REVOKE ALL ON FUNCTION public.idempotent_capture_payment(
    TEXT, TEXT, JSONB, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.idempotent_capture_payment(
    TEXT, TEXT, JSONB, TEXT, TEXT, TEXT
) TO service_role;

REVOKE ALL ON FUNCTION public.initiate_refund(UUID, NUMERIC, TEXT, UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.initiate_refund(UUID, NUMERIC, TEXT, UUID)
    TO service_role;

REVOKE ALL ON FUNCTION public.record_settlement_payment(UUID, NUMERIC, UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_settlement_payment(UUID, NUMERIC, UUID)
    TO service_role;

REVOKE ALL ON FUNCTION public.search_audit_logs(
    UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_audit_logs(
    UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER
) TO service_role;

REVOKE ALL ON FUNCTION public.verify_audit_integrity(UUID, TIMESTAMPTZ)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_audit_integrity(UUID, TIMESTAMPTZ)
    TO service_role;

REVOKE ALL ON FUNCTION public.verify_settlement_integrity(UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_settlement_integrity(UUID)
    TO service_role;

REVOKE ALL ON FUNCTION public.write_audit_log(
    UUID, UUID, TEXT, UUID, TEXT, public.audit_action_severity,
    JSONB, JSONB, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_audit_log(
    UUID, UUID, TEXT, UUID, TEXT, public.audit_action_severity,
    JSONB, JSONB, TEXT, JSONB
) TO service_role;

-- ============================================================
-- 5. CATEGORY C - ADMINISTRATIVE AND CROSS-HOSPITAL (10)
-- ============================================================
--
-- Portfolio dashboards, cross-hospital benchmarks, global metrics,
-- executive reporting and subscription management. These aggregate
-- across every tenant, so exposure to anon leaked the entire
-- platform's operational and commercial position.
--
-- Authorization for these APIs is enforced in the Edge Functions
-- (global-admin scope). Per the remediation mandate the database
-- boundary is now enforced as well, so Edge Function authorization
-- can no longer be bypassed by calling PostgREST directly.

REVOKE ALL ON FUNCTION public.change_subscription_plan(
    UUID, TEXT, public.billing_cycle, UUID
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.change_subscription_plan(
    UUID, TEXT, public.billing_cycle, UUID
) TO service_role;

REVOKE ALL ON FUNCTION public.compute_global_metrics(DATE)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compute_global_metrics(DATE)
    TO service_role;

REVOKE ALL ON FUNCTION public.generate_executive_report(
    TEXT, UUID, DATE, DATE
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generate_executive_report(
    TEXT, UUID, DATE, DATE
) TO service_role;

REVOKE ALL ON FUNCTION public.get_cross_hospital_benchmarks(DATE, DATE)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_cross_hospital_benchmarks(DATE, DATE)
    TO service_role;

REVOKE ALL ON FUNCTION public.get_portfolio_dashboard(DATE)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_portfolio_dashboard(DATE)
    TO service_role;

REVOKE ALL ON FUNCTION public.get_subscription_limits(UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_subscription_limits(UUID)
    TO service_role;

REVOKE ALL ON FUNCTION public.get_subscription_usage(UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_subscription_usage(UUID)
    TO service_role;

REVOKE ALL ON FUNCTION public.is_subscription_active(UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_subscription_active(UUID)
    TO service_role;

REVOKE ALL ON FUNCTION public.record_subscription_usage(UUID, TEXT, INTEGER)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_subscription_usage(UUID, TEXT, INTEGER)
    TO service_role;

REVOKE ALL ON FUNCTION public.sync_subscription_usage(UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_subscription_usage(UUID)
    TO service_role;

-- ============================================================
-- 6. CATEGORY B - INTERNAL EDGE / WORKER / CRON (145)
-- ============================================================
--
-- Booking, queue, doctor workflow, WhatsApp, job queue, DLQ,
-- worker registry, partition maintenance, analytics refresh,
-- monitoring, command centre and alert engine functions.
--
-- These are enumerated by predicate rather than by name because
-- 145 explicit blocks would be unreviewable, and because a
-- predicate is self-maintaining: any SECURITY DEFINER function
-- that exists at this point and is not on the Category A allowlist
-- is locked down, which removes the possibility of a name being
-- forgotten. Sections 4 and 5 remain explicit for the categories
-- where naming the function is itself part of the security record.
--
-- The loop is idempotent and also re-applies the intended state to
-- the 34 functions already handled explicitly above.
--
-- Exclusions and why:
--
--   * The 4 Category A helpers, which RLS policies depend on.
--
--   * Functions RETURNS trigger (10). PostgREST refuses to expose
--     any function whose return type is trigger, so they carry no
--     PostgREST attack surface. EXECUTE on a trigger function is
--     checked only at CREATE TRIGGER time, not when the trigger
--     fires, so revoking would not harden anything while risking
--     future trigger creation. They are listed as B-trigger in
--     docs/security/RPC_PRIVILEGE_CLASSIFICATION.tsv.
--
--   * Extension-owned functions (pg_depend.deptype = 'e'), which
--     belong to citext, pg_trgm, btree_gist, pgcrypto and friends.
--     Revoking EXECUTE on those breaks index operator support and
--     ordinary column operations for non-superuser roles.
--
-- Note on public.partition_health: that view selects from the
-- SECURITY DEFINER function check_partition_readiness(), which is
-- Category B. After this migration the view is readable by
-- service_role only. No Edge Function or test reads the view;
-- monitoring-health-check calls the function directly with the
-- service role. This is recorded here so the behaviour change is
-- not a surprise later.

DO $$
DECLARE
    r RECORD;
    v_count INTEGER := 0;
BEGIN
    FOR r IN
        SELECT format(
                   'public.%I(%s)',
                   p.proname,
                   pg_get_function_identity_arguments(p.oid)
               ) AS sig
        FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.prokind IN ('f', 'p')
          AND p.prosecdef
          AND p.prorettype <> 'pg_catalog.trigger'::regtype
          AND p.proname NOT IN (
              'is_global_admin',
              'current_user_role',
              'user_has_hospital_access',
              'user_has_hospital_role'
          )
          AND NOT EXISTS (
              SELECT 1
              FROM pg_depend d
              WHERE d.classid = 'pg_proc'::regclass
                AND d.objid = p.oid
                AND d.deptype = 'e'
          )
        ORDER BY 1
    LOOP
        EXECUTE 'REVOKE ALL ON ROUTINE ' || r.sig
            || ' FROM PUBLIC, anon, authenticated';
        EXECUTE 'GRANT EXECUTE ON ROUTINE ' || r.sig
            || ' TO service_role';
        v_count := v_count + 1;
    END LOOP;

    RAISE NOTICE
        'privilege hardening applied to % SECURITY DEFINER routines',
        v_count;
END;
$$;

-- ============================================================
-- 7. PROJECT-OWNED SECURITY INVOKER OPERATIONAL FUNCTIONS (9)
-- ============================================================
--
-- Of the 284 SECURITY INVOKER functions in schema public the vast
-- majority are extension functions that must remain executable.
-- The nine below are SETURA-owned operational helpers that expose
-- platform-wide or cross-hospital operational state and have no
-- business being callable by an unauthenticated client:
--
--   check_queue_backlog_alerts  fires alerts, all hospitals
--   get_queue_health            platform queue state
--   get_stuck_jobs              job queue internals
--   get_mv_refresh_health       analytics pipeline state
--   forecast_queue_depth        per-hospital forecasting
--   find_duplicate_patient_candidates   patient PII similarity
--   is_alert_suppressed         alert engine internals
--   is_hospital_online          hospital runtime state
--   log_alert_activity          writes the alert audit trail
--
-- pg_depend was checked across index expressions, constraints,
-- column defaults, generated columns, triggers, policies and views
-- for all nine: zero structural dependencies, so revoking EXECUTE
-- cannot break DDL or query planning.
--
-- Deliberately NOT touched, and recorded here as a decision:
-- extension functions, trigger functions, and the pure helpers
-- normalize_phone_number(text), compute_health_score(int,int,int)
-- and get_partition_name(text,date). Those are side-effect-free
-- arithmetic or string helpers that leak nothing.

REVOKE ALL ON FUNCTION public.check_queue_backlog_alerts(INTEGER, INTEGER)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_queue_backlog_alerts(INTEGER, INTEGER)
    TO service_role;

REVOKE ALL ON FUNCTION public.get_queue_health()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_queue_health()
    TO service_role;

REVOKE ALL ON FUNCTION public.get_stuck_jobs(INTEGER)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_stuck_jobs(INTEGER)
    TO service_role;

REVOKE ALL ON FUNCTION public.get_mv_refresh_health()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_mv_refresh_health()
    TO service_role;

REVOKE ALL ON FUNCTION public.forecast_queue_depth(UUID, DATE)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.forecast_queue_depth(UUID, DATE)
    TO service_role;

REVOKE ALL ON FUNCTION public.find_duplicate_patient_candidates(
    UUID, DOUBLE PRECISION
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_duplicate_patient_candidates(
    UUID, DOUBLE PRECISION
) TO service_role;

REVOKE ALL ON FUNCTION public.is_alert_suppressed(UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_alert_suppressed(UUID, TEXT)
    TO service_role;

REVOKE ALL ON FUNCTION public.is_hospital_online(UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_hospital_online(UUID)
    TO service_role;

REVOKE ALL ON FUNCTION public.log_alert_activity(
    UUID, UUID, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_alert_activity(
    UUID, UUID, UUID, TEXT, TEXT
) TO service_role;

-- ============================================================
-- 8. TENANT ISOLATION - RLS, FORCE RLS, HOSPITAL-SCOPED POLICIES
-- ============================================================
--
-- Pre-migration state of the isolation targets
-- (relrowsecurity | relforcerowsecurity | grants):
--
--   whatsapp_conversation_states  f | f | anon ALL, authenticated ALL
--   analytics_refresh_logs        f | f | anon ALL, authenticated ALL
--   queue_runtime_events          t | t | anon ALL, authenticated ALL
--   alert_activity_log            f | f | (no anon/auth grants)
--   alert_suppressions            f | f | (no anon/auth grants)
--
-- Migration 47 did revoke the table grants for alert_activity_log
-- and alert_suppressions correctly, but never enabled RLS on them.
-- The two genuinely readable-by-anon tables are
-- whatsapp_conversation_states (contains patient phone numbers and
-- conversation context) and analytics_refresh_logs.
-- queue_runtime_events had RLS enabled but its read policy was
-- USING (true), which is not tenant isolation.
--
-- The trusted tenant-resolution model already used everywhere else
-- in SETURA is reused unchanged:
--
--     public.is_global_admin()
--     public.user_has_hospital_access(hospital_id)
--
-- No second tenant-resolution system is introduced.
--
-- service_role and postgres have rolbypassrls = true, so none of
-- the statements below can restrict the worker, the cron jobs, the
-- Edge Functions or a SECURITY DEFINER function body. The service
-- policies are stated anyway so that intent is visible in
-- pg_policies, matching the style migration 47 used for
-- queue_events_service.

-- ---------- whatsapp_conversation_states ----------
-- Internal WhatsApp bot state machine. Contains phone numbers and
-- conversation context: no client should read it at all.

REVOKE ALL ON TABLE public.whatsapp_conversation_states
    FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE public.whatsapp_conversation_states
    TO service_role;

ALTER TABLE public.whatsapp_conversation_states
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.whatsapp_conversation_states
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wa_conversation_states_service
    ON public.whatsapp_conversation_states;

CREATE POLICY wa_conversation_states_service
ON public.whatsapp_conversation_states
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- ---------- queue_runtime_events ----------
-- Hospital-scoped queue event stream. A client may subscribe to
-- its own hospital's events; USING (true) allowed any authenticated
-- user of any hospital to read every hospital's queue activity,
-- including token numbers and actor ids.

REVOKE ALL ON TABLE public.queue_runtime_events
    FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.queue_runtime_events TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE public.queue_runtime_events
    TO service_role;

ALTER TABLE public.queue_runtime_events
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.queue_runtime_events
    FORCE ROW LEVEL SECURITY;

-- Replaces migration 43's queue_events_read USING (true).
DROP POLICY IF EXISTS queue_events_read
    ON public.queue_runtime_events;

DROP POLICY IF EXISTS queue_events_hospital_read
    ON public.queue_runtime_events;

CREATE POLICY queue_events_hospital_read
ON public.queue_runtime_events
FOR SELECT
TO authenticated
USING (
    public.is_global_admin()
    OR (
        hospital_id IS NOT NULL
        AND public.user_has_hospital_access(hospital_id)
    )
);

DROP POLICY IF EXISTS queue_events_service
    ON public.queue_runtime_events;

CREATE POLICY queue_events_service
ON public.queue_runtime_events
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- ---------- analytics_refresh_logs ----------
-- Platform-wide analytics pipeline history. The table has no
-- hospital_id column, so there is nothing to scope by: the correct
-- boundary is global admin only.

REVOKE ALL ON TABLE public.analytics_refresh_logs
    FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.analytics_refresh_logs TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE public.analytics_refresh_logs
    TO service_role;

ALTER TABLE public.analytics_refresh_logs
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.analytics_refresh_logs
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS analytics_refresh_logs_read
    ON public.analytics_refresh_logs;

CREATE POLICY analytics_refresh_logs_read
ON public.analytics_refresh_logs
FOR SELECT
TO authenticated
USING (
    public.is_global_admin()
);

DROP POLICY IF EXISTS analytics_refresh_logs_service
    ON public.analytics_refresh_logs;

CREATE POLICY analytics_refresh_logs_service
ON public.analytics_refresh_logs
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- ---------- alert_activity_log ----------
-- The alert audit trail. hospital_id is nullable because a global
-- alert has no hospital; those rows are global admin only.

REVOKE ALL ON TABLE public.alert_activity_log
    FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.alert_activity_log TO authenticated;

GRANT SELECT, INSERT ON TABLE public.alert_activity_log TO service_role;

ALTER TABLE public.alert_activity_log
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.alert_activity_log
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS alert_activity_log_read
    ON public.alert_activity_log;

CREATE POLICY alert_activity_log_read
ON public.alert_activity_log
FOR SELECT
TO authenticated
USING (
    public.is_global_admin()
    OR (
        hospital_id IS NOT NULL
        AND public.user_has_hospital_access(hospital_id)
    )
);

DROP POLICY IF EXISTS alert_activity_log_service
    ON public.alert_activity_log;

CREATE POLICY alert_activity_log_service
ON public.alert_activity_log
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- ---------- alert_suppressions ----------
-- A suppression hides alerts, so visibility follows the same
-- boundary as alert mutation: own hospital, or global admin for
-- platform-wide (hospital_id IS NULL) windows.

REVOKE ALL ON TABLE public.alert_suppressions
    FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.alert_suppressions TO authenticated;

GRANT SELECT, INSERT ON TABLE public.alert_suppressions TO service_role;

ALTER TABLE public.alert_suppressions
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.alert_suppressions
    FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS alert_suppressions_read
    ON public.alert_suppressions;

CREATE POLICY alert_suppressions_read
ON public.alert_suppressions
FOR SELECT
TO authenticated
USING (
    public.is_global_admin()
    OR (
        hospital_id IS NOT NULL
        AND public.user_has_hospital_access(hospital_id)
    )
);

DROP POLICY IF EXISTS alert_suppressions_service
    ON public.alert_suppressions;

CREATE POLICY alert_suppressions_service
ON public.alert_suppressions
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- ---------- alert_events ----------
-- Migration 24 created alert_events with RLS and FORCE RLS enabled
-- and global-admin-only policies, but never revoked the inherited
-- table grants. The policies already deny anon, so this is
-- defence in depth: remove the grant as well, so that a future
-- policy mistake cannot expose the table.

REVOKE ALL ON TABLE public.alert_events
    FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.alert_events TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE public.alert_events
    TO service_role;

-- ============================================================
-- 9. PRIVILEGED CONFIGURATION TABLES
-- ============================================================
--
-- system_settings holds GST configuration, gateway fee
-- configuration and internal operational settings. It had
-- RLS enabled with two policies:
--
--     system_settings_global_admin  FOR ALL  is_global_admin()
--     system_settings_read          FOR SELECT  USING (true)
--
-- plus inherited anon table grants, so the entire privileged
-- configuration table was readable with the public anon key.
--
-- The only consumer in the repository is
-- supabase/functions/_shared/phone.ts, which reads
-- default_country_code through the service role client. No
-- anonymous consumer exists, so no public projection or public
-- pricing RPC is required; adding one would create surface area
-- that nothing needs. If a public pricing page later needs values,
-- the correct shape is a narrow SECURITY DEFINER RPC returning only
-- the intentionally public keys, not a table grant.
--
-- system_settings_global_admin is retained, so a global admin
-- console can still read and write through an authenticated
-- session; every other authenticated user sees zero rows.

DROP POLICY IF EXISTS system_settings_read
    ON public.system_settings;

REVOKE ALL ON TABLE public.system_settings
    FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.system_settings TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE public.system_settings
    TO service_role;

ALTER TABLE public.system_settings
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.system_settings
    FORCE ROW LEVEL SECURITY;

-- role_permissions is the authorization matrix itself. It had
-- role_permissions_read FOR SELECT USING (true) plus anon grants,
-- publishing the complete permission model to anyone with the anon
-- key. Nothing reads it as anon or authenticated:
-- has_permission, current_user_has_permission and
-- get_user_permissions are all SECURITY DEFINER and execute as
-- postgres. role_permissions_manage (FOR ALL, is_global_admin())
-- is retained for the admin path.

DROP POLICY IF EXISTS role_permissions_read
    ON public.role_permissions;

REVOKE ALL ON TABLE public.role_permissions
    FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.role_permissions TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE public.role_permissions
    TO service_role;

ALTER TABLE public.role_permissions
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.role_permissions
    FORCE ROW LEVEL SECURITY;

-- ============================================================
-- 10. alert_events (hospital_id, is_resolved, created_at) INDEX
-- ============================================================
--
-- Migration 24 already owns the name idx_alert_events_open with a
-- different definition:
--
--     ON public.alert_events(severity, created_at DESC)
--     WHERE is_resolved = false
--
-- Migration 47 line 83 declared
--
--     CREATE INDEX IF NOT EXISTS idx_alert_events_open
--     ON public.alert_events(hospital_id, is_resolved, created_at DESC)
--
-- Because the name already existed, IF NOT EXISTS made that a
-- silent no-op: the index get_alert_center actually needs was never
-- created, and no error was raised. Migration 47 is not modified
-- and migration 24's index is not dropped. The intended index is
-- created here under a distinct, accurate name.

CREATE INDEX IF NOT EXISTS idx_alert_events_hospital_open
ON public.alert_events(hospital_id, is_resolved, created_at DESC);

-- ============================================================
-- 11. VERIFICATION OF THE RESULTING PRIVILEGE STATE
-- ============================================================
--
-- Fails the migration (and therefore the whole transaction) if the
-- intended end state was not reached. This is what makes the
-- migration self-proving rather than merely well-intentioned.

DO $$
DECLARE
    v_bad TEXT;
    v_missing TEXT;
    v_tables TEXT[] := ARRAY[
        'whatsapp_conversation_states',
        'queue_runtime_events',
        'analytics_refresh_logs',
        'alert_activity_log',
        'alert_suppressions',
        'system_settings',
        'role_permissions',
        'alert_events'
    ];
BEGIN

    -- 11.1 No SECURITY DEFINER routine outside the Category A
    --      allowlist may be executable by anon or authenticated.
    SELECT string_agg(s.sig, ', ' ORDER BY s.sig)
    INTO v_bad
    FROM (
        SELECT format(
                   'public.%I(%s)',
                   p.proname,
                   pg_get_function_identity_arguments(p.oid)
               ) AS sig
        FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.prokind IN ('f', 'p')
          AND p.prosecdef
          AND p.prorettype <> 'pg_catalog.trigger'::regtype
          AND p.proname NOT IN (
              'is_global_admin',
              'current_user_role',
              'user_has_hospital_access',
              'user_has_hospital_role'
          )
          AND NOT EXISTS (
              SELECT 1
              FROM pg_depend d
              WHERE d.classid = 'pg_proc'::regclass
                AND d.objid = p.oid
                AND d.deptype = 'e'
          )
          AND (
              has_function_privilege('anon', p.oid, 'EXECUTE')
              OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
          )
    ) s;

    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION
            'migration 48: SECURITY DEFINER routines still callable by '
            'anon or authenticated: %', v_bad;
    END IF;

    -- 11.2 The four RLS policy helpers must keep EXECUTE, or every
    --      RLS-protected read by anon/authenticated breaks.
    IF NOT (
        has_function_privilege(
            'anon', 'public.is_global_admin()', 'EXECUTE')
        AND has_function_privilege(
            'authenticated', 'public.is_global_admin()', 'EXECUTE')
        AND has_function_privilege(
            'anon', 'public.current_user_role(uuid)', 'EXECUTE')
        AND has_function_privilege(
            'authenticated', 'public.current_user_role(uuid)', 'EXECUTE')
        AND has_function_privilege(
            'anon', 'public.user_has_hospital_access(uuid)', 'EXECUTE')
        AND has_function_privilege(
            'authenticated',
            'public.user_has_hospital_access(uuid)',
            'EXECUTE')
        AND has_function_privilege(
            'anon', 'public.user_has_hospital_role(uuid,text[])', 'EXECUTE')
        AND has_function_privilege(
            'authenticated',
            'public.user_has_hospital_role(uuid,text[])',
            'EXECUTE')
    ) THEN
        RAISE EXCEPTION
            'migration 48: an RLS policy helper lost EXECUTE for '
            'anon or authenticated';
    END IF;

    -- 11.3 Every isolation target must have RLS and FORCE RLS.
    SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO v_missing
    FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relname = ANY (v_tables)
      AND NOT (c.relrowsecurity AND c.relforcerowsecurity);

    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION
            'migration 48: RLS or FORCE RLS missing on: %', v_missing;
    END IF;

    -- 11.4 anon must hold no privilege at all on those tables.
    SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO v_bad
    FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relname = ANY (v_tables)
      AND (
          has_table_privilege('anon', c.oid, 'SELECT')
          OR has_table_privilege('anon', c.oid, 'INSERT')
          OR has_table_privilege('anon', c.oid, 'UPDATE')
          OR has_table_privilege('anon', c.oid, 'DELETE')
      );

    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION
            'migration 48: anon still holds privileges on: %', v_bad;
    END IF;

    -- 11.5 authenticated must hold no write privilege on them.
    SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO v_bad
    FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relname = ANY (v_tables)
      AND (
          has_table_privilege('authenticated', c.oid, 'INSERT')
          OR has_table_privilege('authenticated', c.oid, 'UPDATE')
          OR has_table_privilege('authenticated', c.oid, 'DELETE')
      );

    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION
            'migration 48: authenticated still holds write privileges '
            'on: %', v_bad;
    END IF;

    -- 11.6 The USING (true) queue policy must be gone and the
    --      hospital-scoped replacement present.
    IF EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'queue_runtime_events'
          AND policyname = 'queue_events_read'
    ) THEN
        RAISE EXCEPTION
            'migration 48: queue_events_read USING (true) still present';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'queue_runtime_events'
          AND policyname = 'queue_events_hospital_read'
    ) THEN
        RAISE EXCEPTION
            'migration 48: queue_events_hospital_read was not created';
    END IF;

    -- 11.7 The legitimate internal caller must keep EXECUTE.
    IF NOT (
        has_function_privilege(
            'service_role',
            'public.capture_payment(text,text,text,jsonb,numeric)',
            'EXECUTE')
        AND has_function_privilege(
            'service_role',
            'public.get_portfolio_dashboard(date)',
            'EXECUTE')
        AND has_function_privilege(
            'service_role',
            'public.acknowledge_alert(uuid,uuid)',
            'EXECUTE')
        AND has_function_privilege(
            'service_role',
            'public.fire_managed_alert(uuid,text,'
            || 'alert_severity_level,numeric,numeric,text,text,text)',
            'EXECUTE')
    ) THEN
        RAISE EXCEPTION
            'migration 48: service_role lost EXECUTE on an internal RPC';
    END IF;

    -- 11.8 The index migration 47 intended must now exist.
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'idx_alert_events_hospital_open'
    ) THEN
        RAISE EXCEPTION
            'migration 48: idx_alert_events_hospital_open missing';
    END IF;

    RAISE NOTICE 'migration 48 verification passed';

END;
$$;

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
    '48_privilege_hardening',
    '48_privilege_hardening.sql',
    'Closes the database privilege boundary: fail-closed default privileges, service_role-only EXECUTE for all SECURITY DEFINER RPCs except the four RLS policy helpers, actor authorization on alert mutations, RLS and hospital-scoped policies for queue_runtime_events, whatsapp_conversation_states, analytics_refresh_logs, alert_activity_log and alert_suppressions, privileged configuration lockdown for system_settings and role_permissions, and the alert_events hospital index migration 47 silently skipped',
    'policy',
    'applied',
    now()
)
ON CONFLICT (migration_id) DO UPDATE
SET description = EXCLUDED.description,
    status = EXCLUDED.status,
    applied_at = EXCLUDED.applied_at;

COMMIT;
