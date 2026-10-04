WITH w AS (SELECT timestamptz '2026-10-04 08:09:21+00' AS t0)
SELECT 'window'::text AS k, 't0'::text AS g, (SELECT t0::text FROM w)::text AS n
UNION ALL SELECT 'window','elapsed_hours', round((EXTRACT(EPOCH FROM (now()-(SELECT t0 FROM w)))/3600)::numeric, 2)::text
UNION ALL SELECT 'window','ok_if_ge_24h', ((now() - (SELECT t0 FROM w)) >= interval '24 hours')::text
UNION ALL SELECT 'cron_in_window','minute_runs', count(*)::text FROM cron.job_run_details WHERE jobid=1 AND start_time >= (SELECT t0 FROM w)
UNION ALL SELECT 'cron_in_window','succeeded', count(*) FILTER (WHERE status='succeeded')::text FROM cron.job_run_details WHERE jobid=1 AND start_time >= (SELECT t0 FROM w)
UNION ALL SELECT 'cron_in_window','non_succeeded', count(*) FILTER (WHERE status<>'succeeded')::text FROM cron.job_run_details WHERE jobid=1 AND start_time >= (SELECT t0 FROM w)
UNION ALL SELECT 'cron_in_window','distinct_minutes', count(DISTINCT date_trunc('minute', start_time))::text FROM cron.job_run_details WHERE jobid=1 AND start_time >= (SELECT t0 FROM w)
UNION ALL SELECT 'cron_in_window','nightly_runs', count(*)::text FROM cron.job_run_details WHERE jobid=2 AND start_time >= (SELECT t0 FROM w)
UNION ALL SELECT 'cron_last_return',(SELECT return_message::text FROM cron.job_run_details WHERE jobid=1 ORDER BY start_time DESC LIMIT 1), NULL
UNION ALL SELECT 'jobs_created_in_window', job_type||'/'||status, count(*)::text FROM public.job_queue WHERE created_at >= (SELECT t0 FROM w) GROUP BY 2
UNION ALL SELECT 'jobs_completed_in_window', job_type, count(*)::text FROM public.job_queue WHERE status='completed' AND processing_completed_at >= (SELECT t0 FROM w) GROUP BY 2
UNION ALL SELECT 'jobs_dead_in_window', job_type, count(*)::text FROM public.job_queue WHERE status='dead' AND updated_at >= (SELECT t0 FROM w) GROUP BY 2
UNION ALL SELECT 'dlq_failed_in_window','rows', count(*)::text FROM public.dead_letter_jobs WHERE failed_at >= (SELECT t0 FROM w)
UNION ALL SELECT 'soak_job_final', (SELECT status||' w='||COALESCE(worker_id::text,'-')||' att='||attempt_count::text||'/'||max_attempts::text FROM public.job_queue WHERE id='b4d09b67-35ee-46fc-9693-296f2e9d8643'), (SELECT processing_completed_at::text FROM public.job_queue WHERE id='b4d09b67-35ee-46fc-9693-296f2e9d8643')
UNION ALL SELECT 'soak_job_leases', count(*)::text, (SELECT string_agg(COALESCE(outcome,'open')::text, ',') FROM public.worker_job_leases WHERE job_queue_id='b4d09b67-35ee-46fc-9693-296f2e9d8643')
UNION ALL SELECT 'multi_lease_completed', count(*)::text, NULL FROM (SELECT l.job_queue_id FROM public.worker_job_leases l JOIN public.job_queue j ON j.id=l.job_queue_id WHERE j.status='completed' AND l.leased_at >= (SELECT t0 FROM w) GROUP BY l.job_queue_id HAVING count(*) > 1) m
UNION ALL SELECT 'stuck_processing', count(*)::text, NULL FROM public.job_queue WHERE status='processing' AND updated_at < now() - interval '5 minutes'
UNION ALL SELECT 'expired_open_leases', count(*)::text, NULL FROM public.worker_job_leases WHERE outcome IS NULL AND lease_expires_at < now()
UNION ALL SELECT 'hb_in_window','rows/workers', count(*)::text||'/'||count(DISTINCT worker_id)::text FROM public.worker_heartbeat_log WHERE heartbeat_at >= (SELECT t0 FROM w)
UNION ALL SELECT 'queue_depth_close','pend+proc', (SELECT count(*)::text FROM public.job_queue WHERE status IN ('pending','processing'))
UNION ALL SELECT 'net_in_window', CASE WHEN timed_out THEN 'timed_out' WHEN status_code IS NOT NULL THEN status_code::text WHEN error_msg IS NOT NULL THEN 'error' ELSE 'pending' END, count(*)::text FROM net._http_response WHERE created >= (SELECT t0 FROM w) GROUP BY 2
UNION ALL SELECT 'completed_by_type_close', job_type, count(*)::text FROM public.job_queue WHERE status='completed' GROUP BY job_type
UNION ALL SELECT 'dead_by_type_close', job_type, count(*)::text FROM public.job_queue WHERE status='dead' GROUP BY job_type
UNION ALL SELECT 'crashed_workers_close','count', (SELECT count(*)::text FROM public.worker_registry WHERE status='crashed')
UNION ALL SELECT 'probe_close','server_time', now()::text
ORDER BY k, g;
