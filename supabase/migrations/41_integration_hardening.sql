-- =============================================================
-- SETURA HOSPITAL OS
-- Script 41: Integration Hardening (Phase 0.5)
-- Run AFTER Script 40
-- =============================================================
-- PURPOSE: Close the integration gaps identified in the audit:
--   P0.2 - Idempotent refund confirmation + settlement sync
--   P0.1 - Crash recovery for stuck WhatsApp sends
--   P0.4 - Retention policy enforcement + cleanup_run_log
-- No schema changes; function bodies only.
-- =============================================================

BEGIN;

-- ============================================================
-- P0.2: IDEMPOTENT CONFIRM REFUND
-- Guards against webhook replay: an already-processed refund
-- can never re-insert ledger entries or re-adjust settlements.
-- Also synchronizes settlement input data by zeroing the
-- unsettled collection entry of the refunded booking.
-- ============================================================

CREATE OR REPLACE FUNCTION public.confirm_refund_processed(
    p_refund_id UUID,
    p_gateway_refund_id TEXT,
    p_gateway_response JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_refund RECORD;
BEGIN

    SELECT *
    INTO v_refund
    FROM public.payment_refunds
    WHERE id = p_refund_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    -- Idempotency guard: replays must not duplicate ledger entries
    IF v_refund.refund_status = 'processed' THEN
        RETURN FALSE;
    END IF;

    UPDATE public.payment_refunds
    SET
        gateway_refund_id = p_gateway_refund_id,
        refund_status = 'processed',
        processed_at = now(),
        gateway_response = p_gateway_response,
        updated_at = now()
    WHERE id = p_refund_id;

    UPDATE public.payment_orders
    SET
        payment_status = (
            CASE
                WHEN v_refund.refund_amount_inr = amount_inr
                THEN 'refunded'
                ELSE 'partially_refunded'
            END
        )::public.payment_status,
        updated_at = now()
    WHERE id = v_refund.payment_order_id;

    -- Immutable ledger entry for the refund
    INSERT INTO public.financial_ledger (
        hospital_id,
        booking_id,
        payment_order_id,
        refund_id,
        entry_type,
        amount_inr,
        is_credit,
        description,
        reference
    )
    VALUES (
        v_refund.hospital_id,
        v_refund.booking_id,
        v_refund.payment_order_id,
        v_refund.id,
        'refund_debit',
        v_refund.refund_amount_inr,
        false,
        'Refund processed',
        p_gateway_refund_id
    );

    -- Settlement synchronization: a refunded booking must not
    -- count toward future collection settlements. Only unsettled
    -- entries are adjusted; already-settled periods stay intact.
    UPDATE public.daily_collection_entries
    SET
        platform_fee = 0,
        receptionist_fee = 0,
        hospital_fee = 0,
        total_amount = 0,
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'refund_adjusted', true,
            'refund_id', p_refund_id,
            'refund_adjusted_at', now()
        )
    WHERE booking_id = v_refund.booking_id
      AND is_settled = false;

    RETURN TRUE;

END;
$$;

ALTER FUNCTION public.confirm_refund_processed(UUID,TEXT,JSONB)
SET row_security = off;

-- ============================================================
-- P0.1: RECLAIM STALE WHATSAPP PROCESSING
-- Crash recovery: messages stuck in 'processing' (worker died
-- mid-send) are routed through the standard retry scheduler.
-- ============================================================

CREATE OR REPLACE FUNCTION public.reclaim_stale_whatsapp_processing(
    p_stale_minutes INTEGER DEFAULT 15
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row RECORD;
    v_count INTEGER := 0;
BEGIN

    FOR v_row IN
        SELECT id
        FROM public.whatsapp_messages
        WHERE message_status = 'processing'
          AND processing_started_at IS NOT NULL
          AND processing_started_at <
              now() - (p_stale_minutes || ' minutes')::interval
        FOR UPDATE SKIP LOCKED
    LOOP
        -- schedule_whatsapp_retry handles backoff, retry_count,
        -- and promotion to permanently_failed at max_retries.
        PERFORM public.schedule_whatsapp_retry(
            v_row.id,
            'Reclaimed after worker crash or timeout'
        );
        v_count := v_count + 1;
    END LOOP;

    RETURN v_count;

END;
$$;

ALTER FUNCTION public.reclaim_stale_whatsapp_processing(INTEGER)
SET row_security = off;

-- ============================================================
-- P0.4: OPERATIONAL DATA CLEANUP (hardened)
-- Replaces migration 23's version whose zero-argument
-- cleanup_stale_presence() call is ambiguous (two overloads
-- exist: migrations 11 and 20). Also cleans expired temporary
-- records (api idempotency keys) and stale worker state
-- (expired/completed job leases).
-- ============================================================

CREATE OR REPLACE FUNCTION public.cleanup_operational_data()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_presence INTEGER := 0;
    v_idem INTEGER := 0;
    v_leases INTEGER := 0;
BEGIN

    -- Stale presence records (explicit arg disambiguates overloads)
    BEGIN
        v_presence := public.cleanup_stale_presence(1000);
    EXCEPTION
        WHEN undefined_function THEN
            v_presence := 0;
        WHEN OTHERS THEN
            v_presence := 0;
    END;

    -- Expired API idempotency keys (terminal states only;
    -- in-flight 'processing' rows are never removed)
    BEGIN
        DELETE FROM public.api_idempotency_keys
        WHERE expires_at < now()
          AND status <> 'processing';
        GET DIAGNOSTICS v_idem = ROW_COUNT;
    EXCEPTION
        WHEN undefined_table THEN
            v_idem := 0;
    END;

    -- Stale worker state: leases finished or expired > 7 days
    BEGIN
        DELETE FROM public.worker_job_leases
        WHERE (
            outcome IS NOT NULL
            AND leased_at < now() - interval '7 days'
        ) OR (
            lease_expires_at < now() - interval '7 days'
        );
        GET DIAGNOSTICS v_leases = ROW_COUNT;
    EXCEPTION
        WHEN undefined_table THEN
            v_leases := 0;
    END;

    RETURN jsonb_build_object(
        'status', 'completed',
        'stale_presence', v_presence,
        'expired_idempotency_keys', v_idem,
        'stale_worker_leases', v_leases,
        'run_at', now()
    );

END;
$$;

ALTER FUNCTION public.cleanup_operational_data()
SET row_security = off;

-- ============================================================
-- P0.4: RETENTION CLEANUP (hardened)
-- Preserves: financial_ledger, audit_logs, hospital_settlements,
-- payment tables, whatsapp_messages (all have NULL hard-delete
-- policies). Enforces hard_delete_after_days for operational
-- tables, archives aged messages, cleans stale presence, and
-- records every run in cleanup_run_log.
-- ============================================================

CREATE OR REPLACE FUNCTION public.run_retention_cleanup()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_operational JSONB;
    v_archival JSONB;
    v_policy RECORD;
    v_deleted INTEGER;
    v_batch INTEGER;
    v_counts JSONB := '{}';
    v_total INTEGER := 0;
    v_start TIMESTAMPTZ := clock_timestamp();
    v_duration_ms INTEGER;
BEGIN

    -- 1. Presence + operational temp records
    v_operational := public.cleanup_operational_data();

    -- 2. Archive aged messages (soft archive, never deletes)
    v_archival := public.soft_delete_aged_messages();

    -- 3. Enforce retention policies with explicit hard-delete windows.
    --    Policies with NULL hard_delete_after_days (ledger, audit,
    --    settlements, payments, messages) are never hard-deleted.
    FOR v_policy IN
        SELECT table_name, hard_delete_after_days
        FROM public.retention_policies
        WHERE is_active = true
          AND hard_delete_after_days IS NOT NULL
        ORDER BY table_name
    LOOP
        -- Safety: only touch tables that actually exist with created_at
        IF NOT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = v_policy.table_name
              AND column_name = 'created_at'
        ) THEN
            CONTINUE;
        END IF;

        v_deleted := 0;

        -- Batched deletes keep locks short on large tables
        FOR i IN 1..10 LOOP
            EXECUTE format(
                'DELETE FROM public.%I WHERE id IN (
                    SELECT id FROM public.%I
                    WHERE created_at < $1
                    LIMIT 2000
                )',
                v_policy.table_name,
                v_policy.table_name
            )
            USING now() - (v_policy.hard_delete_after_days || ' days')::interval;

            GET DIAGNOSTICS v_batch = ROW_COUNT;
            v_deleted := v_deleted + v_batch;

            EXIT WHEN v_batch = 0;
        END LOOP;

        IF v_deleted > 0 THEN
            v_counts := v_counts || jsonb_build_object(
                v_policy.table_name, v_deleted
            );
            v_total := v_total + v_deleted;
        END IF;
    END LOOP;

    v_duration_ms := GREATEST(
        1,
        EXTRACT(MILLISECONDS FROM clock_timestamp() - v_start)::INTEGER
    );

    -- 4. Metrics record for the run
    INSERT INTO public.cleanup_run_log (
        run_type,
        tables_cleaned,
        total_deleted,
        duration_ms,
        success
    )
    VALUES (
        'retention_cleanup',
        v_counts,
        v_total,
        v_duration_ms,
        true
    );

    RETURN jsonb_build_object(
        'status', 'completed',
        'operational_cleanup', v_operational,
        'archival', v_archival,
        'tables_cleaned', v_counts,
        'total_deleted', v_total,
        'duration_ms', v_duration_ms,
        'run_at', now()
    );

EXCEPTION
    WHEN OTHERS THEN
        INSERT INTO public.cleanup_run_log (
            run_type,
            tables_cleaned,
            total_deleted,
            duration_ms,
            error_message,
            success
        )
        VALUES (
            'retention_cleanup',
            v_counts,
            v_total,
            GREATEST(
                1,
                EXTRACT(MILLISECONDS FROM clock_timestamp() - v_start)::INTEGER
            ),
            SQLERRM,
            false
        );
        RAISE;

END;
$$;

ALTER FUNCTION public.run_retention_cleanup()
SET row_security = off;

-- ============================================================
-- GRANTS
-- ============================================================

REVOKE ALL ON FUNCTION public.reclaim_stale_whatsapp_processing(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reclaim_stale_whatsapp_processing(INTEGER)
    TO service_role, authenticated;

COMMIT;
