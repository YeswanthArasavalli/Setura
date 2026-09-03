import json

migrations = [
  ('01_foundation.sql', 791, 635, 17, 'Core foundation: extensions, enums, hospitals, profiles, user_roles, patients, hospital_working_hours, hospital_holidays + RLS helper functions (current_user_role, is_global_admin, user_has_hospital_access, user_has_hospital_role).', 'hospitals'),
  ('02_atomic_token_engine_&_bookings.sql', 826, 666, 14, 'Atomic token engine and bookings: token_counters, queue_sessions, bookings (the central token/booking record), booking_events.', 'bookings'),
  ('03_doctorscheduling&slotengine.sql', 794, 650, 11, 'Doctor scheduling and slot engine: doctor_specializations, doctor_schedules, schedule_blocks, doctor_leaves, doctor_overrides.', 'doctor_schedules'),
  ('04_whatsapp_messaging_engine.sql', 851, 682, 15, 'WhatsApp messaging engine: wa_templates, wa_conversations, wa_messages, wa_delivery_logs, wa_webhook_events.', 'wa_messages'),
  ('05_notification_queue.sql', 594, 486, 9, 'Multi-channel notification queue: notification_templates, notification_queue, notification_deliveries.', 'notification_queue'),
  ('06_background_job_queue.sql', 549, 445, 9, 'Background job queue: job_queue (priority/status/lease fields), dead_jobs.', 'job_queue'),
  ('07_settlement_engine.sql', 669, 542, 12, 'Settlement engine: daily_collections, settlements, settlement_items, hospital_outstanding_balances.', 'settlements'),
  ('08_analytics_engine.sql', 445, 353, 10, 'Analytics engine: materialized views (mv_daily_stats, mv_doctor_perf, mv_peak_hour, mv_village, mv_revenue_forecast) + analytics_refresh_log + indexes.', 'mv_daily_stats'),
  ('09_abuse_protection_&_rate_limiting.sql', 728, 579, 18, 'Abuse protection and rate limiting: rate_limit_rules, attempt_logs, spam_events, blocked_numbers, blocked_devices, abuse_scores, temp_restrictions.', 'rate_limit_rules'),
  ('10_audit_&_security_engine.sql', 487, 405, 12, 'Audit and security engine: audit_logs, security_events.', 'audit_logs'),
  ('11_realtime_presence_schedule_tasks.sql', 513, 422, 4, 'Realtime presence: dashboard_presence (who is online per hospital/tab/role).', 'dashboard_presence'),
  ('12_hospital_configuration_engine.sql', 691, 561, 11, 'Hospital configuration: app_settings, hospital_settings, feature_flags, queue_configs.', 'hospital_settings'),
  ('13_payment_engine.sql', 961, 763, 17, 'Payment engine: payment_orders, payment_attempts, refunds, payment_events, payment_ledger.', 'payment_orders'),
  ('14_dead_letter_queue.sql', 480, 394, 8, 'Dead letter queue: dlq_entries + views for unresolved/alertable/priority DLQ subsets.', 'dlq_entries'),
  ('15_partitioning_strategy.sql', 541, 420, 10, 'Partitioning strategy: partition_management + partitioned table declarations.', 'partition_management'),
  ('16_idempotency_hardening.sql', 779, 612, 6, 'Idempotency hardening: webhook_events with payload_hash and duplicate_of fields + booking client_request_id index.', 'webhook_events'),
  ('17_queue_monitoring_engine.sql', 927, 629, 7, 'Queue monitoring engine: queue_metrics, mv_refresh_log.', 'queue_metrics'),
  ('18_config_versioning_&_rollback.sql', 776, 537, 6, 'Config versioning and rollback: config_versions, v_latest_config view.', 'config_versions'),
  ('19_background_worker_engine.sql', 956, 643, 8, 'Background worker engine v2: worker_registry, worker_heartbeat, worker_leases + v_worker_active view.', 'worker_registry'),
  ('20_presence_engine.sql', 601, 423, 5, 'Presence engine: presence_channels, hospital_presence_summary.', 'presence_channels'),
  ('21_analytics_rollups.sql', 631, 497, 9, 'Analytics rollups: weekly_rollups, monthly_rollups, quarterly_rollups, platform_weekly_summary, cohort_retention.', 'weekly_rollups'),
  ('22_partition_automation.sql', 689, 544, 7, 'Partition automation: partition_manifest, partition_policy + partition_data_quality_checks view.', 'partition_manifest'),
  ('23_retention_&_cleanup_engine.sql', 368, 279, 5, 'Retention and cleanup engine: retention_policies, cleanup_run_log.', 'retention_policies'),
  ('24_operational-monitoring_engine.sql', 558, 438, 10, 'Operational monitoring: alert_thresholds, alert_events, health_snapshots, sla_tracking + view.', 'alert_events'),
  ('25_api_idempotency_registry.sql', 648, 530, 9, 'API idempotency registry: idem_keys with request_hash and response caching + idem_endpoint_registry.', 'idem_keys'),
  ('26_migration_metadata_&_registry.sql', 612, 502, 9, 'Migration metadata and registry: migration_registry, migration_log, deployment_snapshots + view.', 'migration_registry'),
  ('27_role_permissions.sql', 272, 242, 3, 'Role permissions lookup: role_permissions + view.', 'role_permissions'),
  ('28_booking_enhancements.sql', 276, 238, 1, 'Booking enhancements: hospital_booking_config (booking fees, GST, refund policy).', 'hospital_booking_config'),
  ('29_cancellation_policy.sql', 312, 261, 4, 'Cancellation policy: cancellation_policies, cancellation_policy_history.', 'cancellation_policies'),
  ('30_device_sessions.sql', 206, 176, 5, 'Device session tracking: device_sessions (multi-device login auditing).', 'device_sessions'),
  ('31_doctor_leave_management.sql', 497, 426, 5, 'Doctor leave management: hospital_doctor_holidays (overrides existing doctor_leaves view from earlier migration).', 'hospital_doctor_holidays'),
  ('32_subscription_engine.sql', 501, 428, 9, 'Subscription engine: subscription_plans, hospital_subscriptions, billing_history.', 'hospital_subscriptions'),
  ('33_settlement_engine_refactor.sql', 307, 273, 0, 'Settlement engine refactor: introduces function-based settlement processing (replaces/appends to migration 07).', None),
  ('34_payment_ledger_cleanup.sql', 353, 315, 0, 'Payment ledger cleanup: backfill and corrections for payment_ledger records.', None),
  ('35_hospital_config_enhancements.sql', 215, 187, 0, 'Hospital config enhancements: extra columns/policies on hospital_settings.', None),
  ('36_audit_standardization.sql', 684, 627, 2, 'Audit standardization: audit_action_types reference table + standardized action categories.', 'audit_action_types'),
  ('37_feature_flags.sql', 224, 202, 0, 'Feature flags: extends feature_flags table (likely in 12) with additional behaviors.', None),
  ('38_missing_rpc_functions.sql', 253, 220, 0, 'Missing RPC functions: adds RPC functions flagged as missing in earlier audits.', None),
  ('39_schema_alignment.sql', 393, 354, 0, 'Schema alignment: aligns columns/types between migrations and code expectations.', None),
  ('40_subscription_usage_engine.sql', 319, 273, 0, 'Subscription usage engine: usage tracking tables and enforcement logic for plan limits.', None),
  ('41_integration_hardening.sql', 390, 344, 0, 'Integration hardening: lock down external integration points (webhook/queue boundaries).', None),
  ('42_whatsapp_conversational_engine.sql', 414, 354, 3, 'WhatsApp conversational engine: wa_conversation_state (deterministic intent routing state).', 'wa_conversation_state'),
  ('43_queue_runtime.sql', 1131, 965, 3, 'Queue runtime: queue_events + state-machine RPCs for the queue control flow.', 'queue_events'),
  ('44_queue_runtime_flag.sql', 24, 23, 0, 'Queue runtime feature flag: enables/disables the queue_runtime state machine.', None),
  ('45_queue_operations.sql', 998, 899, 0, 'Queue operations: queue RPCs (call/skip/restore/recall/mark absent) and supporting functions.', None),
  ('46_doctor_clinical_operations.sql', 1025, 894, 4, 'Doctor clinical operations: consultation_notes + RPCs for clinical state transitions.', 'consultation_notes'),
  ('47_enterprise_command_center.sql', 2548, 2339, 5, 'Enterprise command center: alert_activity, alert_suppressions + large RPC surface for the command center.', 'alert_activity'),
  ('48_privilege_hardening.sql', 1469, 1276, 2, 'Privilege hardening: explicit REVOKE statements + function signature hardening (gate 2 work).', None),
  ('49_phase_1_5_defect_fixes.sql', 900, 843, 0, 'Phase 1.5 defect fixes: applied patches for issues found during phase 1.5 audit.', None),
]

nodes = []
edges = []

for fname, lines, nonempty, defs, summary, primary_table in migrations:
  path = 'supabase/migrations/' + fname
  nodes.append({
    'id': 'table:' + path,
    'type': 'table',
    'name': fname,
    'filePath': path,
    'summary': summary,
    'tags': ['migration', 'sql', 'schema', 'database', 'postgresql'],
    'complexity': 'complex' if nonempty > 800 else ('moderate' if nonempty > 200 else 'simple'),
  })
  if primary_table:
    edges.append({
      'source': 'table:' + path,
      'target': 'table:' + path + ':' + primary_table,
      'type': 'contains',
      'direction': 'forward',
      'weight': 1.0,
    })
    nodes.append({
      'id': 'table:' + path + ':' + primary_table,
      'type': 'table',
      'name': primary_table,
      'filePath': path,
      'summary': 'Table defined in ' + fname + ': ' + primary_table + '.',
      'tags': ['schema', 'table', 'database'],
      'complexity': 'simple' if defs <= 5 else 'moderate',
    })

out = {
  'nodes': nodes,
  'edges': edges,
}

print('Total nodes:', len(nodes))
print('Total edges:', len(edges))

node_limit = 60
edge_limit = 120

if len(nodes) <= node_limit and len(edges) <= edge_limit:
  with open('d:/Projects/datasets/setura/.ua/intermediate/batch-7.json', 'w') as f:
    json.dump(out, f, indent=2)
  print('Wrote single file batch-7.json')
else:
  parts = 2
  # Split files alphabetically by path - each file gets its file node + optional table node
  files = [
    'supabase/migrations/' + m[0] for m in migrations
  ]
  chunk_size = (len(files) + parts - 1) // parts
  print(f'Splitting {len(files)} files into {parts} parts, chunk_size={chunk_size}')

  for part_idx in range(parts):
    start = part_idx * chunk_size
    end = min(start + chunk_size, len(files))
    part_files = set(files[start:end])

    part_nodes = [n for n in nodes if n['filePath'] in part_files]
    part_edges = [e for e in edges if e['source'] in [n['id'] for n in part_nodes]]

    part_out = {'nodes': part_nodes, 'edges': part_edges}
    fname = f'd:/Projects/datasets/setura/.ua/intermediate/batch-7-part-{part_idx+1}.json'
    with open(fname, 'w') as f:
      json.dump(part_out, f, indent=2)
    print(f'  Part {part_idx+1}: {len(part_nodes)} nodes, {len(part_edges)} edges -> {fname}')
