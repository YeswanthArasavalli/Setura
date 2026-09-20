-- =============================================================
-- 57_phase2_scheduler_pg_net_timeout.sql
--
-- Hosted staging finding (Part 2): the scheduler chain fires and
-- completes, but every net._http_response for run-cron-minute now
-- records "Timeout of 8000 ms" instead of the HTTP 200 body.
--
-- Root cause: migration 53 budgeted the fire call at 8000 ms when
-- the two intra-project triggers inside run-cron-minute
-- (send-reminders, run-background-worker) failed fast at the hosted
-- gateway (401, pre-apikey-fix). With the gateway fix deployed, both
-- calls genuinely reach their target functions, so the real wall time
-- of one minute tick is: SQL task steps + reminders fetch (budgeted
-- 8s) + worker fetch (budgeted 10s) + health snapshot, which routinely
-- exceeds the 8s pg_net budget. The Edge Function still completes
-- server-side (worker heartbeats and job claims continue during the
-- timeouts), but the scheduler loses its HTTP-level response telemetry.
--
-- Fix: raise the minute fire budget to 20000 ms, above the function's
-- own worst-case internal budget (8s + 10s + <1s overhead per step).
-- The nightly fire is untouched (run-cron-nightly makes no
-- intra-project HTTP calls). Body otherwise reproduced verbatim from
-- migration 53. Per F16-04, the explicit REVOKE/GRANT is restated
-- alongside the resignature (CREATE OR REPLACE preserves the prior
-- ACL, but the restatement is the documented obligation for any
-- changed SECURITY DEFINER function).
-- =============================================================

CREATE OR REPLACE FUNCTION public.scheduler_fire_minute()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_base   TEXT;
    v_key    TEXT;
    v_secret TEXT;
BEGIN
    SELECT base_url INTO v_base
    FROM public.scheduler_http_config
    WHERE id = 1;

    SELECT decrypted_secret INTO v_key
    FROM vault.decrypted_secrets
    WHERE name = 'setura_scheduler_api_key'
    LIMIT 1;

    SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
    WHERE name = 'setura_cron_secret'
    LIMIT 1;

    -- Fail closed: no base URL or no secret means no call is made.
    IF v_base IS NULL OR v_key IS NULL OR v_secret IS NULL THEN
        RETURN jsonb_build_object(
            'fired', false,
            'reason', 'not_provisioned'
        );
    END IF;

    PERFORM net.http_post(
        url := rtrim(v_base, '/') || '/functions/v1/run-cron-minute',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'apikey', v_key,
            'Authorization', 'Bearer ' || v_key,
            'X-Cron-Secret', v_secret
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 20000
    );

    RETURN jsonb_build_object('fired', true, 'endpoint', 'run-cron-minute');
END;
$$;

ALTER FUNCTION public.scheduler_fire_minute()
SET row_security = off;

REVOKE ALL ON FUNCTION public.scheduler_fire_minute()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scheduler_fire_minute()
    TO service_role;
