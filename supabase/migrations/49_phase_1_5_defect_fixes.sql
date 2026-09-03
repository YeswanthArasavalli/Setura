-- =============================================================
-- MIGRATION 49: PHASE 1.5 DEFECT FIXES
-- =============================================================
--
-- Three functional defects found by the Phase 1.5 verification
-- pass. Every fix is a CREATE OR REPLACE of a Phase 1.5 function
-- introduced by migration 47 (or, for the timeline, corrected in
-- place). No table, no trigger, no enum and no historical
-- migration is touched.
--
--   1. get_hospital_timeline
--      SQLSTATE 42803. The function placed
--          ORDER BY e.ts DESC LIMIT n
--      on the same query level as jsonb_agg(), so PostgreSQL
--      required e.ts to appear in a GROUP BY. Every call failed;
--      the HTTP command-center timeline action returned 500.
--      Fix: push the filter, ordering and limit into an inner
--      subquery and aggregate the already-ordered rows -- the
--      same shape public.search_audit_logs already uses.
--
--   2. generate_executive_report
--      SQLSTATE 42804 for report types 'settlement' and 'audit'.
--      Both branches wrote
--          COALESCE(public.get_reconciliation_summary(...), '{}')
--      but get_reconciliation_summary returns TABLE(8 columns)
--      and get_audit_coverage_report returns TABLE(6 columns).
--      A set-returning, record-typed call cannot be COALESCEd
--      against jsonb. 2 of the 8 report types were unreachable.
--      Fix: call both through a FROM clause and serialize with
--      row_to_json / jsonb_agg -- the shape migration 47 already
--      uses correctly in get_financial_command_center. The other
--      six report types are byte-for-byte unchanged.
--
--   3. get_financial_command_center
--      Semantic defect, product decision D-3 option (b).
--      online_payments / offline_payments counted every
--      daily_collection_entries row for the day. The frozen
--      trigger trg_auto_create_collection (migration 07) inserts
--      one DCE row per booking AFTER INSERT, unconditionally,
--      copying the booking's fee snapshots -- which are NULL for
--      a booking that has not paid. A hospital with one real
--      payment and two waiting bookings therefore reported three
--      payments. Fix: count only entries with actual payment
--      activity (COALESCE(total_amount, 0) > 0).
--
--      Monetary fields are deliberately NOT changed. SUM() already
--      ignores NULL and adding 0 changes nothing, so
--      total_collected, platform_fee, hospital_fee,
--      receptionist_fee, refunds and net_collections are
--      bit-identical before and after. Reconciliation is untouched.
--      The frozen trigger, the ledger and the meaning of
--      daily_collection_entries are all unchanged: only the
--      dashboard's interpretation of those rows is corrected.
--
--   4. current_user_role
--      Product decision D-1, database side. The function resolved
--      a user's role for a hospital with a bare LIMIT 1 and no
--      ORDER BY. user_roles deliberately permits several roles per
--      (user, hospital), so for a multi-role user PostgreSQL was
--      free to return either role -- including the higher one.
--      Every RLS policy built on this function was therefore
--      nondeterministic. Fix: order by is_primary first, then by
--      ASCENDING role level so that holding extra roles can never
--      escalate, then by role name for a total order. The role
--      model itself is unchanged.
--
-- Verification: section 5 executes every changed code path and
-- all 8 report types against a hospital id that does not exist,
-- which is enough to prove the SQL plans and returns. Exact
-- values are proven by tests/integration/enterprise_command_center.ts.
-- =============================================================

BEGIN;

-- =============================================================
-- 1. OPERATIONAL TIMELINE (SQLSTATE 42803)
-- =============================================================
--
-- The union body below is reproduced verbatim from migration 47.
-- The only changes are structural:
--   * the WHERE filters, ORDER BY and LIMIT now sit in an inner
--     subquery (t), so jsonb_agg aggregates a bounded, ordered
--     row set instead of trying to order its own input by a
--     non-grouped column;
--   * p_limit is COALESCEd before clamping, so a caller passing
--     NULL gets the documented default of 100 rather than an
--     unbounded scan. The LEAST/GREATEST clamp already expressed
--     the intent that this query is always bounded.
--
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

    SELECT jsonb_agg(row_to_json(t)::jsonb ORDER BY t.ts DESC)
    INTO v_events
    FROM (
        SELECT e.*
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
        LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 1000)
    ) t;

    RETURN jsonb_build_object(
        'hospital_id', p_hospital_id,
        'from', p_from_ts,
        'to', p_to_ts,
        'events', COALESCE(v_events, '[]'::jsonb)
    );

END;
$$;

COMMENT ON FUNCTION public.get_hospital_timeline(
    UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], TEXT, UUID, UUID, INTEGER
) IS
'Chronological operational stream over booking_events, '
'queue_runtime_events, financial_ledger and alert_events. '
'Migration 49 moved the filter/order/limit into an inner subquery: '
'ordering by a non-grouped column alongside jsonb_agg raised 42803 '
'on every call.';

-- =============================================================
-- 2. EXECUTIVE REPORT ENGINE (SQLSTATE 42804)
-- =============================================================
--
-- Six of the eight branches are reproduced byte-for-byte from
-- migration 47. Only 'settlement' and 'audit' change, and both
-- change in the same way: a TABLE-returning function is called
-- through a FROM clause and serialized, instead of being
-- COALESCEd against jsonb in an assignment.
--
--   get_reconciliation_summary(UUID, DATE, DATE)
--       -> TABLE(total_collected, platform_fee_total,
--                receptionist_fee_total, total_refunded,
--                total_settled, net_outstanding, booking_count,
--                paid_booking_count)
--       At most one row, so row_to_json of the single row.
--
--   get_audit_coverage_report(UUID, DATE, DATE)
--       -> TABLE(action_type, category, default_severity,
--                logged_count, last_logged_at, has_coverage)
--       One row per registered action type, so jsonb_agg.
--
-- v_columns keeps naming the top-level keys of v_data, which is
-- the contract the other six branches already follow. Before this
-- fix the two branches could not produce a v_data at all.
--
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
        -- Migration 49: TABLE-returning function, consumed through
        -- a FROM clause. Previously COALESCEd against jsonb (42804).
        SELECT jsonb_build_object(
            'reconciliation',
            COALESCE(row_to_json(r)::jsonb, '{}'::jsonb)
        )
        INTO v_data
        FROM public.get_reconciliation_summary(
            p_hospital_id, p_from_date, p_to_date
        ) r;

        -- No rows at all (SELECT ... INTO left v_data NULL).
        v_data := COALESCE(
            v_data,
            jsonb_build_object('reconciliation', '{}'::jsonb)
        );
        v_columns := ARRAY['reconciliation'];
    WHEN 'sla' THEN
        v_data := public.get_sla_dashboard(p_hospital_id, p_to_date);
        v_columns := ARRAY[
            'summary', 'hospitals_in_breach', 'trend_14d'
        ];
    WHEN 'audit' THEN
        -- Migration 49: set-returning, one row per action type.
        SELECT jsonb_build_object(
            'audit_coverage',
            COALESCE(jsonb_agg(row_to_json(a)::jsonb), '[]'::jsonb)
        )
        INTO v_data
        FROM public.get_audit_coverage_report(
            p_hospital_id, p_from_date, p_to_date
        ) a;

        v_data := COALESCE(
            v_data,
            jsonb_build_object('audit_coverage', '[]'::jsonb)
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

COMMENT ON FUNCTION public.generate_executive_report(
    TEXT, UUID, DATE, DATE
) IS
'Eight executive report types over the existing dashboard '
'functions. Migration 49 fixed the settlement and audit branches, '
'which COALESCEd a TABLE-returning function against jsonb (42804) '
'and were therefore unreachable. The other six are unchanged.';

-- =============================================================
-- 3. FINANCIAL COMMAND CENTER -- PAYMENT COUNT SEMANTICS (D-3)
-- =============================================================
--
-- Product decision D-3, option (b): count actual payment activity.
--
-- Reproduced verbatim from migration 47 except for the two count
-- expressions. Every monetary expression is unchanged, and the
-- change cannot move any of them: SUM() ignores NULL, and a row
-- whose total_amount is 0 adds 0.
--
-- Metric semantics after this migration:
--
--   online_payments   number of daily_collection_entries rows for
--                     the day with booking_source = 'online' AND a
--                     non-zero total_amount, i.e. online bookings
--                     that actually collected money.
--   offline_payments  the same for every other booking_source
--                     (walkin, phone, ...).
--
--   Neither counts the zero-value placeholder row that
--   trg_auto_create_collection writes for a booking with no fee
--   snapshots. Such a booking has not paid, so it is not a payment.
--   The row itself is preserved and still contributes (zero) to
--   every monetary total -- the meaning of the table is unchanged.
--
--   Consequence: online_payments + offline_payments no longer
--   equals the number of DCE rows for the day. It equals the number
--   of entries carrying money, which is what a financial command
--   center reports.
--
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
        -- D-3: entries with real payment activity only.
        'online_payments', COUNT(*) FILTER (
            WHERE dce.booking_source = 'online'
              AND COALESCE(dce.total_amount, 0) > 0
        ),
        'offline_payments', COUNT(*) FILTER (
            WHERE dce.booking_source <> 'online'
              AND COALESCE(dce.total_amount, 0) > 0
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

COMMENT ON FUNCTION public.get_financial_command_center(UUID, DATE) IS
'Daily collections, settlement aging and 30-day reconciliation for '
'one hospital. Migration 49 (decision D-3) restricted '
'online_payments/offline_payments to entries with a non-zero '
'total_amount, so the zero-value rows that trg_auto_create_collection '
'writes for unpaid bookings are no longer reported as payments. '
'All monetary fields are unchanged.';

-- =============================================================
-- 4. DETERMINISTIC ROLE RESOLUTION (D-1, DATABASE SIDE)
-- =============================================================
--
-- public.user_roles deliberately allows several roles per
-- (user, hospital): the table constraint is
--     UNIQUE (user_id, hospital_id, role)
-- and the partial unique index idx_primary_role allows exactly one
-- is_primary row per (user, hospital). Multi-role support is
-- intentional and is NOT removed, and no new unique constraint is
-- added.
--
-- What was wrong is only the RESOLUTION of that set. Migration 01
-- defined:
--
--     SELECT role::text
--     FROM public.user_roles
--     WHERE user_id = auth.uid()
--       AND hospital_id = p_hospital_id
--     LIMIT 1;            -- <-- no ORDER BY
--
-- LIMIT without ORDER BY returns an arbitrary row. For a user who
-- is, say, both a doctor and a receptionist at one hospital, the
-- role driving every RLS policy depended on the plan chosen that
-- day, and could be the HIGHER of the two.
--
-- The ordering below is the same rule the Edge boundary applies in
-- supabase/functions/_shared/auth.ts resolveAuth():
--
--   1. is_primary DESC  -- the primary role for the selected
--                          hospital is authoritative
--   2. level ASC        -- among non-primary rows the LEAST
--                          privileged role wins: holding extra
--                          roles must never escalate privileges
--   3. role::text ASC   -- total order, so the answer is stable
--                          across plans and vacuum states
--
-- The level values are the existing SETURA hierarchy
-- (global_admin 100, hospital_admin 50, doctor 30,
-- receptionist 20). No second role model and no second
-- tenant-resolution path is introduced.
--
-- global_admin is handled explicitly and separately, exactly as
-- before: role_hospital_consistency forces global_admin rows to
-- have hospital_id IS NULL, so they never match the hospital
-- predicate here. Global scope is decided by is_global_admin(),
-- which is unchanged.
--
CREATE OR REPLACE FUNCTION public.current_user_role(
    p_hospital_id UUID
)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT role::text
    FROM public.user_roles
    WHERE user_id = auth.uid()
      AND hospital_id = p_hospital_id
    ORDER BY
        is_primary DESC,
        CASE role
            WHEN 'global_admin'   THEN 100
            WHEN 'hospital_admin' THEN 50
            WHEN 'doctor'         THEN 30
            WHEN 'receptionist'   THEN 20
            ELSE 0
        END ASC,
        role::text ASC
    LIMIT 1;
$$;

-- CREATE OR REPLACE keeps the owner and the ACL, but the SET
-- clauses come from the new definition, so row_security = off is
-- re-applied here. Without it the function would read user_roles
-- under the caller's RLS and could resolve to NULL for a user who
-- cannot see their own role rows.
ALTER FUNCTION public.current_user_role(UUID)
SET row_security = off;

COMMENT ON FUNCTION public.current_user_role(UUID) IS
'Resolves the calling user''s role at one hospital. Migration 49 '
'(decision D-1) made the resolution deterministic: the is_primary '
'role wins, then the LEAST privileged role, then role name. '
'Multiple roles per hospital remain supported and can never '
'escalate privileges. global_admin is not resolved here - '
'those rows have hospital_id IS NULL by CHECK constraint - use '
'is_global_admin().';

-- =============================================================
-- 5. VERIFICATION
-- =============================================================
--
-- Each changed code path is executed. The hospital id is a fresh
-- UUID that cannot exist, so no row is read and no tenant data is
-- involved; what is proven is that the SQL plans and returns,
-- which is exactly what 42803 and 42804 prevented. Exact values
-- against fixtures are proven by the integration suite.
--
DO $$
DECLARE
    v_hospital UUID := gen_random_uuid();
    v_result JSONB;
    v_report_type TEXT;
    v_types TEXT[] := ARRAY[
        'daily_hospital',
        'weekly_operations',
        'monthly_executive',
        'doctor_performance',
        'financial',
        'settlement',
        'sla',
        'audit'
    ];
BEGIN

    -- 4.1 Timeline executes (previously 42803 on every call).
    v_result := public.get_hospital_timeline(v_hospital);

    IF v_result IS NULL
       OR NOT (v_result ? 'events')
       OR jsonb_typeof(v_result -> 'events') <> 'array'
    THEN
        RAISE EXCEPTION
            'verification 4.1 failed: get_hospital_timeline did not '
            'return an events array';
    END IF;

    IF jsonb_array_length(v_result -> 'events') <> 0 THEN
        RAISE EXCEPTION
            'verification 4.1 failed: timeline returned events for a '
            'non-existent hospital';
    END IF;

    -- 4.2 Timeline honours its filters and its limit clamp.
    v_result := public.get_hospital_timeline(
        v_hospital,
        now() - interval '1 day',
        now(),
        ARRAY['stalled_detected'],
        'critical',
        NULL,
        NULL,
        NULL
    );

    IF v_result IS NULL OR NOT (v_result ? 'events') THEN
        RAISE EXCEPTION
            'verification 4.2 failed: filtered timeline with a NULL '
            'limit did not return an events array';
    END IF;

    -- 4.3 All 8 report types execute and report ok.
    FOREACH v_report_type IN ARRAY v_types
    LOOP
        v_result := public.generate_executive_report(
            v_report_type,
            v_hospital,
            CURRENT_DATE - 6,
            CURRENT_DATE
        );

        IF v_result IS NULL OR (v_result -> 'ok') <> 'true'::jsonb THEN
            RAISE EXCEPTION
                'verification 4.3 failed: report type % did not return ok',
                v_report_type;
        END IF;

        IF NOT (v_result ? 'data') OR NOT (v_result ? 'columns') THEN
            RAISE EXCEPTION
                'verification 4.3 failed: report type % is missing data '
                'or columns',
                v_report_type;
        END IF;
    END LOOP;

    -- 4.4 The two previously broken types carry their documented key.
    v_result := public.generate_executive_report(
        'settlement', v_hospital, CURRENT_DATE - 6, CURRENT_DATE
    );

    IF NOT (v_result -> 'data' ? 'reconciliation') THEN
        RAISE EXCEPTION
            'verification 4.4 failed: settlement report has no '
            'reconciliation key';
    END IF;

    v_result := public.generate_executive_report(
        'audit', v_hospital, CURRENT_DATE - 6, CURRENT_DATE
    );

    IF jsonb_typeof(v_result -> 'data' -> 'audit_coverage') <> 'array' THEN
        RAISE EXCEPTION
            'verification 4.4 failed: audit report audit_coverage is not '
            'an array';
    END IF;

    -- 4.5 An unknown report type is still rejected, not raised.
    v_result := public.generate_executive_report(
        'not_a_report', v_hospital
    );

    IF (v_result -> 'ok') <> 'false'::jsonb
       OR (v_result ->> 'reason') <> 'unknown_report_type'
    THEN
        RAISE EXCEPTION
            'verification 4.5 failed: unknown report type was not '
            'rejected';
    END IF;

    -- 4.6 Financial command center executes and exposes the counts.
    v_result := public.get_financial_command_center(v_hospital);

    IF NOT (v_result ? 'daily_collections') THEN
        RAISE EXCEPTION
            'verification 4.6 failed: no daily_collections block';
    END IF;

    IF (v_result -> 'daily_collections' ->> 'online_payments')::bigint <> 0
       OR (v_result -> 'daily_collections' ->> 'offline_payments')::bigint
          <> 0
    THEN
        RAISE EXCEPTION
            'verification 4.6 failed: payment counts non-zero for a '
            'non-existent hospital';
    END IF;

    IF (v_result -> 'daily_collections' ->> 'total_collected')::numeric
       <> 0
    THEN
        RAISE EXCEPTION
            'verification 4.6 failed: total_collected non-zero for a '
            'non-existent hospital';
    END IF;

    -- 4.7 The D-3 filter is present in the installed definition.
    -- Guards against a later migration silently reverting to
    -- counting placeholder rows.
    IF (
        SELECT COUNT(*)
        FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname = 'get_financial_command_center'
          AND pg_get_functiondef(p.oid) LIKE
              '%COALESCE(dce.total_amount, 0) > 0%'
    ) <> 1 THEN
        RAISE EXCEPTION
            'verification 4.7 failed: D-3 payment activity filter is not '
            'present in get_financial_command_center';
    END IF;

    -- 4.8 Deterministic role resolution (D-1). The function is
    -- callable and, with no JWT in a migration session,
    -- auth.uid() is NULL so it must resolve to NULL rather than
    -- error.
    IF public.current_user_role(v_hospital) IS NOT NULL THEN
        RAISE EXCEPTION
            'verification 4.8 failed: current_user_role returned a role '
            'for an unauthenticated session';
    END IF;

    -- 4.9 The ordering is present in the installed definition. A
    -- bare LIMIT 1 would be nondeterministic again, so the shape
    -- is asserted rather than assumed.
    IF (
        SELECT COUNT(*)
        FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname = 'current_user_role'
          AND pg_get_functiondef(p.oid) LIKE '%ORDER BY%'
          AND pg_get_functiondef(p.oid) LIKE '%is_primary DESC%'
    ) <> 1 THEN
        RAISE EXCEPTION
            'verification 4.9 failed: current_user_role is not ordered by '
            'is_primary';
    END IF;

    -- 4.10 row_security = off survived the CREATE OR REPLACE. If it
    -- did not, the function would read user_roles under the
    -- caller's own RLS and could resolve to NULL for a legitimate
    -- user.
    IF NOT EXISTS (
        SELECT 1
        FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname = 'current_user_role'
          AND p.proconfig @> ARRAY['row_security=off']
    ) THEN
        RAISE EXCEPTION
            'verification 4.10 failed: current_user_role lost '
            'row_security = off';
    END IF;

    RAISE NOTICE 'migration 49 verification passed';

END $$;

-- =============================================================
-- 6. REGISTRY
-- =============================================================

INSERT INTO public.migration_registry (
    migration_id,
    script_filename,
    description,
    category,
    status,
    applied_at
)
VALUES (
    '49_phase_1_5_defect_fixes',
    '49_phase_1_5_defect_fixes.sql',
    'Phase 1.5 defect fixes: get_hospital_timeline 42803, '
    'generate_executive_report 42804 for settlement/audit, '
    'D-3 payment count semantics in get_financial_command_center, '
    'and D-1 deterministic current_user_role resolution',
    'function',
    'applied',
    now()
)
ON CONFLICT (migration_id) DO UPDATE
SET description = EXCLUDED.description,
    category = EXCLUDED.category,
    status = EXCLUDED.status,
    applied_at = EXCLUDED.applied_at;

COMMIT;
