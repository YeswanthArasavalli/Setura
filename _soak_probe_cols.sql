SELECT table_name, string_agg(column_name, ', ' ORDER BY ordinal_position) AS cols
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('job_queue','worker_registry','worker_job_leases','worker_heartbeat_log','dead_letter_jobs','sla_daily_tracking','scheduler_http_config')
GROUP BY table_name
ORDER BY table_name;
