-- =============================================================
-- MIGRATION 53: PHASE 2 - SCHEDULER + AUTONOMOUS OPERATIONS
-- =============================================================
--
-- Implements the roadmap NPD-05 disposition verbatim
-- (SETURA_FINAL_MASTER_ROADMAP.md section 11):
--
--   "one worker engine (v2), one queue, one scheduler ...
--    recommended pg_cron + pg_net inside the Supabase stack
--    calling the machine endpoints with HMAC secrets ... Either
--    way: one trigger path, secrets via platform secret store,
--    never in repo."
--
-- This migration adds the two things the proven W1 lifecycle was
-- still missing to stop depending on manual invocation:
--
--   1. A SCHEDULER that fires autonomously. pg_cron is preloaded in
--      the Supabase image (shared_preload_libraries includes
--      pg_cron; cron.database_name = 'postgres', which is this app
--      database). It is enabled here with CREATE EXTENSION IF NOT
--      EXISTS so a fresh `db reset` gets it and this live database
--      is a no-op. pg_net is already installed (schema `net`
--      present) and provides net.http_post.
--
--      Two named jobs are registered: setura_cron_minute (every
--      minute) and setura_cron_nightly. Each calls a thin SECURITY
--      DEFINER fire function that issues an authenticated POST to
--      the EXISTING machine Edge Function (run-cron-minute /
--      run-cron-nightly). It does NOT bypass or duplicate the worker
--      lifecycle: run-cron-minute already orchestrates
--      run_scheduled_tasks, reminders, health and the
--      ENABLE_WORKER_TRIGGER worker wakeup. The scheduler only turns
--      the existing "manual curl" into an autonomous minute tick.
--
--   2. AUTONOMOUS RECOVERY. run_worker_crash_recovery()
--      (migration 19:813-850) already composes the exact v2 recovery
--      chain the roadmap asks for - detect_crashed_workers() then
--      reclaim_crashed_worker_jobs() then lease/heartbeat hygiene -
--      but it has ZERO callers. run_scheduled_tasks() (migration
--      17:702) is the master SQL scheduler that run-cron-minute
--      invokes; it currently runs only the v1 time-based
--      reclaim_stale_jobs. This migration wires the v2 crash
--      recovery into run_scheduled_tasks so the minute tick performs
--      crash detection -> reclaim -> re-claimable recovery without
--      any manual step. Guarded exactly like its sibling calls
--      (undefined_function -> no-op) to stay additive and safe.
--
-- SECURITY (CLAUDE.md section 7 / F16-04):
--   * The fire functions read the API key and cron secret from the
--     Supabase platform secret store (Supabase Vault,
--     vault.decrypted_secrets), NOT from this repository and NOT from
--     a plaintext column. Only the non-secret project base URL lives
--     in public.scheduler_http_config, and it defaults to NULL.
--   * Fail closed by construction: if the base URL or either Vault
--     secret is absent, the fire function returns
--     { "fired": false, "reason": "not_provisioned" } and issues NO
--     HTTP request at all. So registering the real schedules on an
--     unprovisioned database is inert - it never fabricates a call,
--     never sends a bad secret, and (per the run-cron-minute
--     contract) an endpoint with no CRON_SECRET serves no caller.
--   * Every new/changed SECURITY DEFINER function gets an explicit
--     REVOKE from PUBLIC/anon/authenticated + GRANT to service_role;
--     run_scheduled_tasks keeps its pre-existing service_role-only
--     boundary and row_security = off. No function echoes secret
--     material in its return value.
--   * scheduler_http_config is owner-only (RLS enabled, no
--     privileges granted to anon/authenticated/service_role); it is
--     read solely by the definer functions running as its owner.
--
-- Verification (section 6) proves, inside this transaction: both
-- schedules registered, run_scheduled_tasks now references the v2
-- recovery, the fire functions are locked + run, and - the security
-- crux - an unprovisioned fire is a clean no-op that queues no HTTP
-- request. Nothing that requires real secrets or a running Edge
-- Runtime is claimed here; those remain environment-blocked and are
-- reported as such.
-- =============================================================

BEGIN;

-- =============================================================
-- 1. ENABLE THE SCHEDULER EXTENSION (idempotent)
-- =============================================================
-- pg_net is already installed by the image. pg_cron is preloaded and
-- created into this database (cron.database_name = 'postgres').

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- =============================================================
-- 2. NON-SECRET ENDPOINT CONFIG (single row)
-- =============================================================
-- Holds only the project base URL + cron cadence. The API key and
-- cron secret are NOT stored here; they live in Supabase Vault and
-- are read by name at fire time. base_url defaults NULL so the
-- scheduler stays inert until an operator provisions it out-of-band.

CREATE TABLE IF NOT EXISTS public.scheduler_http_config (
    id            smallint    PRIMARY KEY DEFAULT 1,
    base_url      TEXT,
    minute_cron   TEXT        NOT NULL DEFAULT '* * * * *',
    nightly_cron  TEXT        NOT NULL DEFAULT '0 3 * * *',
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT scheduler_http_config_singleton CHECK (id = 1)
);

INSERT INTO public.scheduler_http_config (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.scheduler_http_config
    ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.scheduler_http_config
    FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.scheduler_http_config IS
    'Phase 2 scheduler non-secret config. Secrets (API key, cron '
    'secret) live in Supabase Vault under setura_scheduler_api_key / '
    'setura_cron_secret and are never stored here or in the repo.';

-- =============================================================
-- 3. FIRE FUNCTIONS - authenticated net.http_post to the existing
--    machine endpoints; fail-closed no-op until provisioned.
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
        timeout_milliseconds := 8000
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

CREATE OR REPLACE FUNCTION public.scheduler_fire_nightly()
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

    IF v_base IS NULL OR v_key IS NULL OR v_secret IS NULL THEN
        RETURN jsonb_build_object(
            'fired', false,
            'reason', 'not_provisioned'
        );
    END IF;

    PERFORM net.http_post(
        url := rtrim(v_base, '/') || '/functions/v1/run-cron-nightly',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'apikey', v_key,
            'Authorization', 'Bearer ' || v_key,
            'X-Cron-Secret', v_secret
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 15000
    );

    RETURN jsonb_build_object('fired', true, 'endpoint', 'run-cron-nightly');
END;
$$;

ALTER FUNCTION public.scheduler_fire_nightly()
SET row_security = off;

REVOKE ALL ON FUNCTION public.scheduler_fire_nightly()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scheduler_fire_nightly()
    TO service_role;

-- =============================================================
-- 4. AUTONOMOUS RECOVERY WIRING
-- =============================================================
-- run_scheduled_tasks (migration 17:702) reproduced verbatim, with
-- the v2 crash recovery (run_worker_crash_recovery) added as a
-- guarded step and surfaced in the result. All prior behavior
-- (reclaim_stale_jobs, cleanup_stale_presence,
-- cleanup_expired_restrictions, write_queue_metrics_snapshot) is
-- unchanged.

CREATE OR REPLACE FUNCTION public.run_scheduled_tasks()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_stale_jobs       INTEGER := 0;
    v_stale_presence   INTEGER := 0;
    v_expired_restrict INTEGER := 0;
    v_crash_recovery   JSONB   := NULL;
BEGIN
    BEGIN
        v_stale_jobs := public.reclaim_stale_jobs(10);
    EXCEPTION
        WHEN undefined_function THEN
            v_stale_jobs := 0;
    END;

    BEGIN
        v_stale_presence := public.cleanup_stale_presence();
    EXCEPTION
        WHEN undefined_function THEN
            v_stale_presence := 0;
    END;

    BEGIN
        v_expired_restrict := public.cleanup_expired_restrictions();
    EXCEPTION
        WHEN undefined_function THEN
            v_expired_restrict := 0;
    END;

    -- Migration 53 (Phase 2): wire the zero-caller v2 crash-recovery
    -- chain into the master scheduler so detect_crashed_workers ->
    -- reclaim_crashed_worker_jobs runs on every minute tick. Same
    -- undefined_function guard as the sibling calls, so this stays
    -- additive: if the recovery routine is ever absent the scheduler
    -- simply reports null for it.
    BEGIN
        v_crash_recovery := public.run_worker_crash_recovery();
    EXCEPTION
        WHEN undefined_function THEN
            v_crash_recovery := NULL;
    END;

    PERFORM public.write_queue_metrics_snapshot();

    RETURN jsonb_build_object(
        'reclaimed_jobs', v_stale_jobs,
        'cleaned_presence', v_stale_presence,
        'expired_restrictions', v_expired_restrict,
        'crash_recovery', v_crash_recovery,
        'metrics_snapshot', true,
        'run_at', now()
    );
END;
$$;

ALTER FUNCTION public.run_scheduled_tasks()
SET row_security = off;

REVOKE ALL ON FUNCTION public.run_scheduled_tasks()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_scheduled_tasks()
    TO service_role;

-- =============================================================
-- 5. REGISTER THE SCHEDULES (idempotent by job name)
-- =============================================================
-- On an unprovisioned database these fire the fail-closed no-op, so
-- registering them is inert. cron.schedule upserts by name, but the
-- jobs are unscheduled first to guarantee a clean redefinition and
-- to pick up any cadence change from the config row.

DO $$
DECLARE
    v_min   TEXT;
    v_night TEXT;
BEGIN
    SELECT minute_cron, nightly_cron
    INTO v_min, v_night
    FROM public.scheduler_http_config
    WHERE id = 1;

    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'setura_cron_minute') THEN
        PERFORM cron.unschedule('setura_cron_minute');
    END IF;
    PERFORM cron.schedule(
        'setura_cron_minute', v_min,
        'SELECT public.scheduler_fire_minute()'
    );

    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'setura_cron_nightly') THEN
        PERFORM cron.unschedule('setura_cron_nightly');
    END IF;
    PERFORM cron.schedule(
        'setura_cron_nightly', v_night,
        'SELECT public.scheduler_fire_nightly()'
    );
END $$;

-- =============================================================
-- 6. VERIFICATION
-- =============================================================

DO $$
DECLARE
    v_jobs      INTEGER;
    v_queued    INTEGER;
    v_result    JSONB;
BEGIN
    -- 6.1 Both schedules registered with their expected commands.
    SELECT COUNT(*) INTO v_jobs
    FROM cron.job
    WHERE (jobname = 'setura_cron_minute'
              AND command = 'SELECT public.scheduler_fire_minute()')
       OR (jobname = 'setura_cron_nightly'
              AND command = 'SELECT public.scheduler_fire_nightly()');

    IF v_jobs <> 2 THEN
        RAISE EXCEPTION
            'verification 6.1 failed: expected 2 scheduler jobs, found %',
            v_jobs;
    END IF;

    -- 6.2 run_scheduled_tasks now invokes the v2 crash recovery.
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname = 'run_scheduled_tasks'
          AND p.prosrc LIKE '%run_worker_crash_recovery%'
    ) THEN
        RAISE EXCEPTION
            'verification 6.2 failed: run_scheduled_tasks does not '
            'reference run_worker_crash_recovery';
    END IF;

    -- 6.3 fire functions + scheduler are service_role-only, definer,
    -- row_security off.
    IF has_function_privilege('anon', 'public.scheduler_fire_minute()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.scheduler_fire_minute()', 'EXECUTE')
       OR NOT has_function_privilege('service_role', 'public.scheduler_fire_minute()', 'EXECUTE')
       OR has_function_privilege('anon', 'public.scheduler_fire_nightly()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.scheduler_fire_nightly()', 'EXECUTE')
       OR NOT has_function_privilege('service_role', 'public.scheduler_fire_nightly()', 'EXECUTE')
       OR has_function_privilege('anon', 'public.run_scheduled_tasks()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.run_scheduled_tasks()', 'EXECUTE')
       OR NOT has_function_privilege('service_role', 'public.run_scheduled_tasks()', 'EXECUTE') THEN
        RAISE EXCEPTION
            'verification 6.3 failed: scheduler function EXECUTE is '
            'not service_role-only';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('scheduler_fire_minute', 'scheduler_fire_nightly')
          AND p.prosecdef = true
          AND p.proconfig @> ARRAY['row_security=off']
    ) OR (
        SELECT COUNT(*) FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('scheduler_fire_minute', 'scheduler_fire_nightly')
          AND p.prosecdef = true
          AND p.proconfig @> ARRAY['row_security=off']
    ) <> 2 THEN
        RAISE EXCEPTION
            'verification 6.3b failed: fire functions lost SECURITY '
            'DEFINER or row_security = off';
    END IF;

    -- 6.4 config table is not readable by client roles and is
    -- unprovisioned (base_url NULL).
    IF has_table_privilege('anon', 'public.scheduler_http_config', 'SELECT')
       OR has_table_privilege('authenticated', 'public.scheduler_http_config', 'SELECT') THEN
        RAISE EXCEPTION
            'verification 6.4 failed: scheduler_http_config SELECT '
            'leaked to a client role';
    END IF;

    IF EXISTS (SELECT 1 FROM public.scheduler_http_config WHERE id = 1 AND base_url IS NOT NULL) THEN
        RAISE EXCEPTION
            'verification 6.4b failed: scheduler_http_config.base_url '
            'should be NULL (unprovisioned) in this migration';
    END IF;

    -- 6.5 Security crux: an unprovisioned fire is a clean no-op that
    -- enqueues NO HTTP request and returns fired = false.
    IF EXISTS (SELECT 1 FROM vault.decrypted_secrets
               WHERE name IN ('setura_scheduler_api_key', 'setura_cron_secret')) THEN
        RAISE EXCEPTION
            'verification 6.5 precondition failed: Vault secrets must '
            'be absent to prove the fail-closed path';
    END IF;

    SELECT COUNT(*) INTO v_queued FROM net.http_request_queue;

    v_result := public.scheduler_fire_minute();

    IF v_result ->> 'fired' <> 'false'
       OR v_result ->> 'reason' <> 'not_provisioned' THEN
        RAISE EXCEPTION
            'verification 6.5 failed: unprovisioned minute fire '
            'returned %', v_result;
    END IF;

    -- Still no request queued: fail-closed is real, not just a label.
    IF (SELECT COUNT(*) FROM net.http_request_queue) <> v_queued THEN
        RAISE EXCEPTION
            'verification 6.5 failed: unprovisioned fire enqueued an '
            'HTTP request despite being unprovisioned';
    END IF;

    v_result := public.scheduler_fire_nightly();

    IF v_result ->> 'fired' <> 'false'
       OR v_result ->> 'reason' <> 'not_provisioned' THEN
        RAISE EXCEPTION
            'verification 6.5 failed: unprovisioned nightly fire '
            'returned %', v_result;
    END IF;

    IF (SELECT COUNT(*) FROM net.http_request_queue) <> v_queued THEN
        RAISE EXCEPTION
            'verification 6.5 failed: unprovisioned nightly fire '
            'enqueued an HTTP request';
    END IF;

    RAISE NOTICE 'migration 53 verification passed';
END $$;

-- =============================================================
-- 7. REGISTRY
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
    '53_phase2_scheduler_and_autonomous_recovery',
    '53_phase2_scheduler_and_autonomous_recovery.sql',
    'Phase 2 (NPD-05): enable pg_cron and register two named jobs '
    '(setura_cron_minute, setura_cron_nightly) that fire the existing '
    'run-cron-minute/run-cron-nightly machine endpoints via pg_net '
    'authenticated POST, reading the API key and cron secret from '
    'Supabase Vault (never the repo); fail closed to a no-op that '
    'enqueues zero HTTP when unprovisioned; and wire the previously '
    'zero-caller run_worker_crash_recovery (detect_crashed_workers -> '
    'reclaim_crashed_worker_jobs) into run_scheduled_tasks so the '
    'minute tick performs autonomous crash recovery; all new/changed '
    'SECURITY DEFINER functions restated service_role-only and '
    'verified, including the fail-closed no-op path',
    'schema',
    'applied',
    now()
)
ON CONFLICT (migration_id) DO UPDATE
SET description = EXCLUDED.description,
    category = EXCLUDED.category,
    status = EXCLUDED.status,
    applied_at = EXCLUDED.applied_at;

COMMIT;
