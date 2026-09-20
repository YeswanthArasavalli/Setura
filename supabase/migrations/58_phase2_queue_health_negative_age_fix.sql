-- =============================================================
-- 58_phase2_queue_health_negative_age_fix.sql
--
-- Hosted staging finding (Part 2): write_queue_metrics_snapshot()
-- began violating queue_metrics_snapshots_oldest_pending_age_secs_check
-- on every tick from the moment the first background job entered retry
-- backoff (live evidence: last snapshot row 17:19 UTC, then hard stop).
--
-- Root cause: migration 17 computes the job_queue branch as
--     now() - MIN(scheduled_at) FILTER (WHERE status = 'pending')
-- and the notifications branch as
--     now() - MIN(scheduled_for) FILTER (WHERE status = 'pending').
-- Both columns legitimately hold FUTURE timestamps: retry backoff
-- reschedules pending jobs (next attempts) and reminders/notifications
-- are enqueued for future send times. When the earliest pending row is
-- in the future the interval goes negative, the INTEGER cast preserves
-- the sign, and the CHECK (age >= 0) rejects the whole snapshot insert
-- - silently starving ALL queue health metrics until no future-scheduled
-- pending row exists.
--
-- This is data-state dependent, not environment dependent: any
-- production queue holding a normal future-scheduled job breaks the
-- monitoring engine. It never reproduced locally because local pending
-- jobs all had past scheduled_at values.
--
-- Fix: clamp both ages at zero (GREATEST(age, '0 secs')). Semantics are
-- preserved for the only consumer semantics that matter: STUCK_OLDEST_JOB
-- and alert thresholds compare age against positive intervals, and a
-- future-scheduled job has waited zero seconds. Body otherwise
-- reproduced verbatim from migration 17. The function is SECURITY
-- INVOKER; per F16-04 discipline the pre-existing privilege boundary
-- (migration 48: no PUBLIC/anon/authenticated, service_role only) is
-- restated unchanged.
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_queue_health()

RETURNS TABLE (

    queue_type TEXT,

    pending_count BIGINT,

    processing_count BIGINT,

    failed_count BIGINT,

    dead_count BIGINT,

    oldest_pending_age INTERVAL,

    avg_attempts NUMERIC,

    throughput_last_hour BIGINT

)

LANGUAGE sql
STABLE
AS $$

    -- =========================================================
    -- JOB QUEUE
    -- =========================================================

    SELECT

        'job_queue'::TEXT,

        COUNT(*) FILTER (
            WHERE status = 'pending'
        ),

        COUNT(*) FILTER (
            WHERE status = 'processing'
        ),

        COUNT(*) FILTER (
            WHERE status = 'failed'
        ),

        COUNT(*) FILTER (
            WHERE status = 'dead'
        ),

        -- Clamp: pending jobs scheduled in the future (retry
        -- backoff, reminders) have waited zero seconds, never a
        -- negative age (queue_metrics_snapshots CHECK >= 0).
        GREATEST(
            now() - MIN(scheduled_at)
                FILTER (WHERE status = 'pending'),
            INTERVAL '0 secs'
        ),

        ROUND(
            AVG(attempt_count)::NUMERIC,
            2
        ),

        COUNT(*) FILTER (
            WHERE status = 'completed'
            AND processing_completed_at >
                now() - interval '1 hour'
        )

    FROM public.job_queue

    UNION ALL

    -- =========================================================
    -- WHATSAPP
    -- =========================================================

    SELECT

        'whatsapp'::TEXT,

        COUNT(*) FILTER (
            WHERE message_status = 'queued'
        ),

        COUNT(*) FILTER (
            WHERE message_status = 'processing'
        ),

        COUNT(*) FILTER (
            WHERE message_status IN (
                'failed',
                'retrying'
            )
        ),

        COUNT(*) FILTER (
            WHERE message_status = 'permanently_failed'
        ),

        now() - MIN(created_at)
            FILTER (
                WHERE message_status = 'queued'
            ),

        ROUND(
            AVG(retry_count)::NUMERIC,
            2
        ),

        COUNT(*) FILTER (
            WHERE message_status = 'sent'
            AND sent_at > now() - interval '1 hour'
        )

    FROM public.whatsapp_messages

    UNION ALL

    -- =========================================================
    -- NOTIFICATIONS
    -- =========================================================

    SELECT

        'notifications'::TEXT,

        COUNT(*) FILTER (
            WHERE status = 'pending'
        ),

        COUNT(*) FILTER (
            WHERE status = 'queued'
        ),

        COUNT(*) FILTER (
            WHERE status = 'failed'
        ),

        0::BIGINT,

        -- Clamp: scheduled_for is the intended future send time;
        -- a not-yet-due notification has aged zero seconds.
        GREATEST(
            now() - MIN(scheduled_for)
                FILTER (
                    WHERE status = 'pending'
                ),
            INTERVAL '0 secs'
        ),

        ROUND(
            AVG(retry_count)::NUMERIC,
            2
        ),

        COUNT(*) FILTER (
            WHERE status = 'sent'
            AND sent_at > now() - interval '1 hour'
        )

    FROM public.notification_queue;

$$;

-- Restate the pre-existing boundary unchanged (migration 48).
REVOKE ALL ON FUNCTION public.get_queue_health()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_queue_health()
    TO service_role;
