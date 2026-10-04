SELECT 'queue_status'::text AS k, status::text AS g, count(*)::text AS n FROM public.job_queue GROUP BY status
UNION ALL SELECT 'queue_type_status', job_type||'/'||status, count(*)::text FROM public.job_queue GROUP BY 2
UNION ALL SELECT 'cron_registry', jobid::text||' '||jobname||' '||schedule||' active='||active::text, NULL FROM cron.job
UNION ALL SELECT 'cron_run_24h', status, count(*)::text FROM cron.job_run_details WHERE start_time > now() - interval '24 hours' GROUP BY status
UNION ALL SELECT 'cron_last60m', jobid::text, count(*)::text||' runs/'||count(*) FILTER (WHERE status='succeeded')::text||' ok' FROM cron.job_run_details WHERE start_time > now() - interval '60 minutes' GROUP BY jobid
UNION ALL SELECT 'cron_max_start', max(start_time)::text, NULL FROM cron.job_run_details
UNION ALL SELECT 'worker_registry_status', status, count(*)::text FROM public.worker_registry GROUP BY status
UNION ALL SELECT 'worker_latest_hb', (SELECT worker_id FROM public.worker_registry ORDER BY last_heartbeat_at DESC NULLS LAST LIMIT 1), (SELECT max(last_heartbeat_at)::text FROM public.worker_registry)
UNION ALL SELECT 'hb_log_24h', 'rows/distinct_workers', count(*)::text||'/'||count(DISTINCT worker_id)::text FROM public.worker_heartbeat_log WHERE heartbeat_at > now() - interval '24 hours'
UNION ALL SELECT 'hb_log_max', 'latest', (SELECT max(heartbeat_at)::text FROM public.worker_heartbeat_log)
UNION ALL SELECT 'lease_age', CASE WHEN completed_at IS NOT NULL THEN 'closed' WHEN lease_expires_at > now() THEN 'lease_live' ELSE 'lease_expired' END, count(*)::text FROM public.worker_job_leases GROUP BY 2
UNION ALL SELECT 'lease_24h', 'leases_leased_last24h', count(*)::text FROM public.worker_job_leases WHERE leased_at > now() - interval '24 hours'
UNION ALL SELECT 'dead_letter', 'total', count(*)::text FROM public.dead_letter_jobs
UNION ALL SELECT 'dead_letter', 'failed_last24h', count(*)::text FROM public.dead_letter_jobs WHERE failed_at > now() - interval '24 hours'
UNION ALL SELECT 'completed_by_type', job_type, count(*)::text FROM public.job_queue WHERE status='completed' GROUP BY job_type
UNION ALL SELECT 'completed_latest', (SELECT id::text FROM public.job_queue WHERE status='completed' ORDER BY processing_completed_at DESC NULLS LAST LIMIT 1), (SELECT processing_completed_at::text FROM public.job_queue WHERE status='completed' ORDER BY processing_completed_at DESC NULLS LAST LIMIT 1)
UNION ALL SELECT 'sla_row', hospital_id::text||' '||tracking_date::text, 'wait='||COALESCE(avg_wait_minutes::text,'NULL')||' breached='||sla_wait_breached::text||' computed='||computed_at::text FROM public.sla_daily_tracking
UNION ALL SELECT 'sched_cfg', id::text, 'base_url_set='||(base_url IS NOT NULL)::text FROM public.scheduler_http_config
UNION ALL SELECT 'net_resp_24h', CASE WHEN timed_out THEN 'timed_out' WHEN status_code IS NOT NULL THEN status_code::text WHEN error_msg IS NOT NULL THEN 'error' ELSE 'pending' END, count(*)::text FROM net._http_response WHERE created > now() - interval '24 hours' GROUP BY 2
UNION ALL SELECT 'probe_now', 'server_time', now()::text
ORDER BY k, g;
