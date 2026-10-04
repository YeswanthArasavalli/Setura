SELECT 'soak_t0_enqueue' AS step,
       public.trigger_sla_refresh('00000000-0000-4000-8000-000000000001'::uuid, DATE '2026-10-04') AS job_id,
       now() AS enqueued_at;
