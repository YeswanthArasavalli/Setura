# Graph Report - setura  (2026-08-27)

## Corpus Check

- cluster-only mode — file stats not available

## Summary

- 1393 nodes · 2851 edges · 95 communities (84 shown, 11 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 52 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)

- whatsapp_conversation_engine.ts
- 47_enterprise_command_center.sql
- run-background-worker/index.ts
- db.ts
- logger.ts
- SeturError
- types.ts
- privilege_isolation.test.ts
- env.ts
- audit.ts
- queue_runtime.ts
- tasks
- 13_payment_engine.sql
- doctor_operations.test.ts
- validate_migrations.ts
- queue_operations.test.ts
- queue_runtime.test.ts
- 18_config_versioning_&_rollback.sql
- getServiceClient
- auth.ts
- 01_foundation.sql
- 04_whatsapp_messaging_engine.sql
- enterprise_command_center.test.ts
- whatsapp_conversational.test.ts
- 02_atomic_token_engine_&_bookings.sql
- 43_queue_runtime.sql
- 07_settlement_engine.sql
- formatE164
- public.dead_letter_queue
- 32_subscription_engine.sql
- 46_doctor_clinical_operations.sql
- response.ts
- 05_notification_queue.sql
- 09_abuse_protection_&_rate_limiting.sql
- 31_doctor_leave_management.sql
- doctor-operations/index.ts
- 11_realtime_presence_schedule_tasks.sql
- 16_idempotency_hardening.sql
- multi_role_auth.test.ts
- 19_background_worker_engine.sql
- 06_background_job_queue.sql
- 42_whatsapp_conversational_engine.sql
- 22_partition_automation.sql
- 26_migration_metadata_&_registry.sql
- 23_retention_&_cleanup_engine.sql
- 10_audit_&_security_engine.sql
- 20_presence_engine.sql
- webhook_signature.ts
- 24_operational-monitoring_engine.sql
- 25_api_idempotency_registry.sql
- 45_queue_operations.sql
- usage_retention.test.ts
- whatsapp_lifecycle.test.ts
- enqueueWhatsApp
- MetricsCollector
- 03_doctorscheduling&slotengine.sql
- seed_constants.ts
- gen_types.ts
- notifyQueuePositions
- reporting.ts
- verify-payment/index.ts
- 39_schema_alignment.sql
- refund_sync.test.ts
- audit_reliability.test.ts
- executive-analytics/index.ts
- queue-control/index.ts
- 08_analytics_engine.sql
- public.doctor_schedule_blocks
- public.hospital_settings
- public.doctor_availability_overrides
- public.doctor_leaves
- public.hospital_settlements
- public.audit_action_types
- public.queue_runtime_events
- public.queue_runtime_events



## God Nodes (most connected - your core abstractions)

1. `getServiceClient()` - 53 edges
2. `logAuditEvent()` - 31 edges
3. `successResponse()` - 29 edges
4. `resolveAuth()` - 28 edges
5. `handleCors()` - 28 edges
6. `createMetrics()` - 28 edges
7. `ValidationError` - 27 edges
8. `formatE164()` - 27 edges
9. `handleErrorResponse()` - 27 edges
10. `createRequestLogger()` - 27 edges



## Surprising Connections (you probably didn't know these)

- `ConsultationNoteInput` --references--> `Json`  [EXTRACTED]
supabase/functions/_shared/queue/queue_runtime.ts → supabase/functions/_shared/database.generated.ts
- `validHeader()` --calls--> `hmacSha256Hex()`  [EXTRACTED]
tests/unit/webhook_signature.test.ts → supabase/functions/_shared/webhook_signature.ts
- `FlowContext` --references--> `Logger`  [EXTRACTED]
supabase/functions/_shared/whatsapp/whatsapp_conversation_engine.ts → supabase/functions/_shared/logger.ts
- `BookingRecord` --references--> `BookingStatus`  [EXTRACTED]
supabase/functions/update-booking-status/index.ts → supabase/functions/_shared/types.ts
- `executeBooking()` --calls--> `logAuditEvent()`  [EXTRACTED]
supabase/functions/_shared/whatsapp/whatsapp_booking_flow.ts → supabase/functions/_shared/audit.ts



## Import Cycles

- 3-file cycle: `supabase/functions/_shared/whatsapp/whatsapp_booking_flow.ts -> supabase/functions/_shared/whatsapp/whatsapp_conversation_engine.ts -> supabase/functions/_shared/whatsapp/whatsapp_queue_flow.ts -> supabase/functions/_shared/whatsapp/whatsapp_booking_flow.ts`
- 3-file cycle: `supabase/functions/_shared/whatsapp/whatsapp_booking_flow.ts -> supabase/functions/_shared/whatsapp/whatsapp_conversation_engine.ts -> supabase/functions/_shared/whatsapp/whatsapp_reschedule_flow.ts -> supabase/functions/_shared/whatsapp/whatsapp_booking_flow.ts`



## Communities (95 total, 11 thin omitted)



### Community 0 - "whatsapp_conversation_engine.ts"

Cohesion: 0.06
Nodes (76): ACTIVE_BOOKING_STATUSES, BookingFlowState, buildConfirmation(), continueBookingFlow(), doctorMenu(), ensurePatient(), executeBooking(), listActiveDoctors() (+68 more)

### Community 1 - "47_enterprise_command_center.sql"

Cohesion: 0.08
Nodes (47): public.analytics_monthly_rollups, public.analytics_weekly_rollups, public.audit_logs, public.booking_events, public.daily_collection_entries, public.financial_ledger, public.outstanding_balances, public.payment_orders (+39 more)

### Community 2 - "run-background-worker/index.ts"

Cohesion: 0.11
Nodes (29): JOB_TYPES, processComputeSla(), processIncomingWhatsapp(), processRefreshAnalytics(), processSendNotification(), runStep(), selectRole(), claimIdempotencyKey() (+21 more)

### Community 3 - "db.ts"

Cohesion: 0.10
Nodes (25): RESCHEDULABLE, Schema, callRpc(), DoctorUnavailableError, ErrorCode, ErrorContext, HospitalClosedError, ValidationError (+17 more)

### Community 4 - "logger.ts"

Cohesion: 0.16
Nodes (19): Schema, Schema, WebhookEventRow, Schema, CreateSettlementSchema, handleCors(), Env, createRequestLogger() (+11 more)

### Community 5 - "SeturError"

Cohesion: 0.07
Nodes (21): BookingDuplicateError, DbError, HospitalAccessDeniedError, IdempotencyKeyRequiredError, IdempotencyProcessingError, isRetryable(), isSeturError(), PatientBlockedError (+13 more)

### Community 6 - "types.ts"

Cohesion: 0.06
Nodes (34): HandlerOptions, RoleRow, CompositeTypes, Constants, Database, DatabaseWithoutInternals, DefaultSchema, Enums (+26 more)

### Community 7 - "privilege_isolation.test.ts"

Cohesion: 0.08
Nodes (31): Actor, ANON, assertNotAuthorized(), assertRpcAllowed(), assertRpcDenied(), assertTableDenied(), bootstrap(), Caller (+23 more)

### Community 8 - "env.ts"

Cohesion: 0.06
Nodes (34): ALLOWED_ORIGINS, ALLOWED_ORIGINS_RAW, APP_ENV, AppEnv, AppEnvironment, CRON_SECRET, DEFAULT_WORKER_LEASE_SECS, DEPLOYMENT_VERSION (+26 more)

### Community 9 - "audit.ts"

Cohesion: 0.09
Nodes (20): RFC-4122, ALERT_ACTIONS, ALERT_TARGET_ACTIONS, AlertAction, AlertRow, Schema, RazorpayOrder, Schema (+12 more)

### Community 10 - "queue_runtime.ts"

Cohesion: 0.07
Nodes (29): AbsentResult, BookingNotifyRow, CallResult, ClearDelayResult, CloseSessionResult, CompleteConsultationResult, ConsultationNoteInput, DelayResult (+21 more)

### Community 11 - "tasks"

Cohesion: 0.08
Nodes (28): compilerOptions, noImplicitAny, noImplicitReturns, strict, fmt, exclude, imports, @supabase/supabase-js (+20 more)

### Community 12 - "13_payment_engine.sql"

Cohesion: 0.12
Nodes (25): public.prevent_ledger_mutation, public.write_booking_ledger_entries, public.capture_payment(), public.confirm_refund_processed(), public.financial_ledger, public.get_reconciliation_summary(), public.initiate_refund(), public.payment_attempts (+17 more)

### Community 13 - "doctor_operations.test.ts"

Cohesion: 0.10
Nodes (23): advanceQueue(), bookingRow(), bootstrap(), ctx(), DbClient, DoctorFixture, fixtureDoctor(), fixtureDoctors (+15 more)

### Community 14 - "validate_migrations.ts"

Cohesion: 0.12
Nodes (25): analyzeFile(), checkDuplicates(), checkPrimaryKeys(), checkPrivileges(), definitions, errors, extractStatements(), Finding (+17 more)

### Community 15 - "queue_operations.test.ts"

Cohesion: 0.11
Nodes (22): alertRows(), bootstrap(), ctx(), DbClient, fixtureDoctor(), fixtureDoctors, fixtureHospitals, fixtureSessions (+14 more)

### Community 16 - "queue_runtime.test.ts"

Cohesion: 0.12
Nodes (20): TERMINAL_STATES, TRANSITIONS, BookingState, bookingStatus(), bootstrap(), ctx(), DbClient, fixtureHospitals (+12 more)

### Community 17 - "18_config_versioning_&_rollback.sql"

Cohesion: 0.12
Nodes (21): public.prevent_config_version_mutation, public.version_feature_flag, public.version_hospital_settings, public.version_system_settings, public.config_change_history, public.config_versions, public.prevent_config_version_mutation(), public.rollback_system_setting() (+13 more)

### Community 18 - "getServiceClient"

Cohesion: 0.13
Nodes (17): BookingRow, IMPORTANT:, Schema, UNCANCELLABLE, Booking, QueueSession, Schema, getServiceClient() (+9 more)

### Community 19 - "auth.ts"

Cohesion: 0.12
Nodes (14): ADMIN_ACTIONS, ADMIN_BROADCAST_KINDS, CommandCenterAction, Schema, REPORT_ACTIONS, REPORT_TYPES, ReportAction, Schema (+6 more)

### Community 20 - "01_foundation.sql"

Cohesion: 0.14
Nodes (19): auth, auth.users, public.current_user_role(), public.hospital_holidays, public.hospital_working_hours, public.hospitals, public.is_global_admin(), public.patients (+11 more)

### Community 21 - "04_whatsapp_messaging_engine.sql"

Cohesion: 0.14
Nodes (19): public.fetch_pending_whatsapp_messages(), public.handle_whatsapp_delivery_status(), public.queue_whatsapp_message(), public.schedule_whatsapp_retry(), public.whatsapp_conversations, public.whatsapp_delivery_logs, public.whatsapp_messages, public.whatsapp_templates (+11 more)

### Community 22 - "enterprise_command_center.test.ts"

Cohesion: 0.11
Nodes (14): bootstrap(), createAuthUser(), ctx(), DbClient, fixtureActor(), FixtureState, getLocalStatus(), LocalStatus (+6 more)

### Community 23 - "whatsapp_conversational.test.ts"

Cohesion: 0.12
Nodes (18): client(), countBookings(), createDirectBooking(), DATE_A, DATE_B, DATE_HOL, getBooking(), getLocalStatus() (+10 more)

### Community 24 - "02_atomic_token_engine_&_bookings.sql"

Cohesion: 0.16
Nodes (19): public.handle_booking_status_change, public.advance_queue(), public.booking_events, public.bookings, public.create_booking(), public.handle_booking_status_change(), public.hospital_daily_counters, public.queue_sessions (+11 more)

### Community 25 - "43_queue_runtime.sql"

Cohesion: 0.13
Nodes (14): public.advance_queue(), public.call_queue_token(), public.get_queue_snapshot(), public.queue_runtime_events, public.recall_current_token(), public.record_queue_event(), public.trigger_sla_refresh(), public.bookings (+6 more)

### Community 26 - "07_settlement_engine.sql"

Cohesion: 0.14
Nodes (17): public.auto_create_collection_entry, public.create_hospital_settlement(), public.daily_collection_entries, public.hospital_settlements, public.outstanding_balances, public.refresh_outstanding_balance(), public.settlement_items, public (+9 more)

### Community 27 - "formatE164"

Cohesion: 0.19
Nodes (19): DbClient, AdminBroadcastKind, AdminContact, broadcastAdminOperational(), BroadcastAlert, broadcastAlertToAdmins(), BroadcastBookingRow, broadcastDoctorDelay() (+11 more)

### Community 28 - "public.dead_letter_queue"

Cohesion: 0.14
Nodes (17): public.notification_queue, public.dead_letter_queue, public.dlq_notifications_failed, public.dlq_whatsapp_failed, public.get_dlq_summary(), public.retry_dead_letter_item(), public, public.bookings (+9 more)

### Community 29 - "32_subscription_engine.sql"

Cohesion: 0.18
Nodes (15): public.auto_create_trial_subscription, public.prevent_immutable_row_modification, public.auto_create_trial_subscription(), public.change_subscription_plan(), public.get_subscription_limits(), public.hospital_subscriptions, public.is_subscription_active(), public.subscription_billing_history (+7 more)

### Community 30 - "46_doctor_clinical_operations.sql"

Cohesion: 0.18
Nodes (15): public.prevent_consultation_note_mutation, public.close_doctor_session(), public.complete_consultation(), public.consultation_notes, public.get_doctor_dashboard(), public.insert_emergency_patient(), public.open_doctor_session(), public.return_to_waiting() (+7 more)

### Community 31 - "response.ts"

Cohesion: 0.18
Nodes (13): FINANCE_ACTIONS, FinanceAction, Schema, RefundStatus, Schema, buildCorsHeaders(), ApiErrorResponse, ApiSuccessResponse (+5 more)

### Community 32 - "05_notification_queue.sql"

Cohesion: 0.15
Nodes (14): public.notification_deliveries, public.notification_queue, public.notification_templates, public.queue_notification(), public.schedule_notification_retry(), public, public.bookings, public.hospitals (+6 more)

### Community 33 - "09_abuse_protection_&_rate_limiting.sql"

Cohesion: 0.18
Nodes (12): public.abuse_scores, public.blocked_devices, public.blocked_numbers, public.booking_attempt_logs, public.check_booking_rate_limit(), public.is_phone_blocked(), public.rate_limit_rules, public.spam_events (+4 more)

### Community 34 - "31_doctor_leave_management.sql"

Cohesion: 0.18
Nodes (13): public.hospital_holidays, public.doctor_hospital_holidays, public.get_doctor_availability_reason(), public.is_doctor_available(), public, public.doctor_availability_overrides, public.doctor_leaves, public.doctor_schedules (+5 more)

### Community 35 - "doctor-operations/index.ts"

Cohesion: 0.13
Nodes (15): BOOKING_ACTIONS, DOCTOR_ACTIONS, DoctorAction, Schema, SESSIONLESS_ACTIONS, getDoctorDashboard(), notifyQueuePauseChange(), QueueSessionRow (+7 more)

### Community 36 - "11_realtime_presence_schedule_tasks.sql"

Cohesion: 0.13
Nodes (9): public.dashboard_presence, public.is_hospital_online(), public, public.hospitals, public.prevent_hospital_id_update, public.profiles, public.set_updated_at, trg_dashboard_presence_hospital_immutable (+1 more)

### Community 37 - "16_idempotency_hardening.sql"

Cohesion: 0.14
Nodes (12): public.claim_webhook_event(), public.idempotent_create_booking(), public.register_webhook_event_v2(), public.webhook_events, information_schema.columns, public, public.bookings, public.hospitals (+4 more)

### Community 38 - "multi_role_auth.test.ts"

Cohesion: 0.17
Nodes (12): Actor, bootstrap(), createAuthUser(), ctx(), dbRoleFor(), FixtureState, getLocalStatus(), LocalStatus (+4 more)

### Community 39 - "19_background_worker_engine.sql"

Cohesion: 0.22
Nodes (7): public.job_queue, public.claim_jobs_v2(), public.fail_job_v2(), public.reclaim_crashed_worker_jobs(), public.worker_heartbeat_log, public.worker_job_leases, public.worker_registry

### Community 40 - "06_background_job_queue.sql"

Cohesion: 0.16
Nodes (10): public.claim_jobs(), public.dead_letter_jobs, public.fail_job(), public.job_queue, public.bookings, public.hospitals, public.prevent_hospital_id_update, public.set_updated_at (+2 more)

### Community 41 - "42_whatsapp_conversational_engine.sql"

Cohesion: 0.14
Nodes (10): public.record_incoming_whatsapp_message(), public.whatsapp_conversation_states, public, public.hospitals, public.prevent_hospital_id_update, public.set_updated_at, public.whatsapp_conversations, public.whatsapp_messages (+2 more)

### Community 42 - "22_partition_automation.sql"

Cohesion: 0.22
Nodes (10): pg_class, public.%1$I, public.generate_partition_ddl(), public.get_partition_health(), public.operational_notes, public.partition_config, public.partition_health, public.partition_manifest (+2 more)

### Community 43 - "26_migration_metadata_&_registry.sql"

Cohesion: 0.23
Nodes (9): information_schema.routines, public.deployment_snapshots, public.migration_execution_log, public.migration_registry, public.migration_status_view, public.take_deployment_snapshot(), information_schema.tables, public.set_updated_at (+1 more)

### Community 44 - "23_retention_&_cleanup_engine.sql"

Cohesion: 0.18
Nodes (10): pg_proc, public.cleanup_operational_data(), public.cleanup_run_log, public.get_retention_report(), public.retention_policies, public.soft_delete_aged_messages(), information_schema.tables, public.hospitals (+2 more)

### Community 45 - "10_audit_&_security_engine.sql"

Cohesion: 0.20
Nodes (7): public.prevent_audit_log_modification, public.audit_logs, public.security_events, public, public.hospitals, public.profiles, trg_audit_logs_no_update

### Community 46 - "20_presence_engine.sql"

Cohesion: 0.21
Nodes (8): public.dashboard_presence, public.hospital_online_state, public.recompute_hospital_online_state(), public.hospitals, public.profiles, public.set_updated_at, trg_online_state_updated_at, trg_presence_updated_at

### Community 47 - "webhook_signature.ts"

Cohesion: 0.31
Nodes (9): RFC-4231, constantTimeEqual(), hmacSha256Hex(), SignatureFailureReason, signatureFailureStatus(), SignatureVerification, verifyMetaSignature(), BODY (+1 more)

### Community 48 - "24_operational-monitoring_engine.sql"

Cohesion: 0.22
Nodes (8): public.alert_events, public.alert_thresholds, public.fire_alert(), public.system_health_snapshots, public.hospitals, public.profiles, public.set_updated_at, trg_alert_thresholds_updated_at

### Community 49 - "25_api_idempotency_registry.sql"

Cohesion: 0.22
Nodes (6): public.api_idempotency_keys, public.claim_idempotency_key(), public.idempotency_endpoint_registry, public.idempotency_stats, public.hospitals, public.profiles

### Community 50 - "45_queue_operations.sql"

Cohesion: 0.22
Nodes (7): public.alert_thresholds, public.clear_doctor_delay(), public.mark_doctor_delay(), public.resolve_alert_threshold(), public.try_fire_queue_alert(), public.alert_events, public.queue_sessions

### Community 52 - "usage_retention.test.ts"

Cohesion: 0.29
Nodes (8): createClient(), db(), getLocalStatus(), getSubscription(), LocalStatus, record(), RUN, SubscriptionRow

### Community 53 - "whatsapp_lifecycle.test.ts"

Cohesion: 0.29
Nodes (9): createClient(), createdMessageIds, db(), getLocalStatus(), getMsg(), LocalStatus, queueMsg(), RUN (+1 more)

### Community 54 - "enqueueWhatsApp"

Cohesion: 0.33
Nodes (9): enqueueWhatsApp(), loadBookingForNotify(), runCallToken(), runCompleteConsultation(), runMarkAbsent(), runRecallCurrentToken(), runRestoreToken(), runSkipToken() (+1 more)

### Community 56 - "03_doctorscheduling&slotengine.sql"

Cohesion: 0.29
Nodes (6): public.doctor_specializations, public.estimate_wait_minutes(), public.get_remaining_token_capacity(), public.bookings, public.doctor_schedules, public.queue_sessions

### Community 57 - "seed_constants.ts"

Cohesion: 0.36
Nodes (6): createClient(), db(), getLocalStatus(), LocalStatus, SEED_USER_IDS, SEED

### Community 58 - "gen_types.ts"

Cohesion: 0.38
Nodes (6): checkOnly, decode(), generate(), HEADER, normalize(), OUT_PATH

### Community 59 - "notifyQueuePositions"

Cohesion: 0.29
Nodes (7): getQueueSnapshot(), notifyDoctorDelay(), notifyQueuePositions(), notifySessionEarlyClosed(), queueUpdatesEnabled(), runCloseDoctorSession(), runMarkDoctorDelayed()

### Community 60 - "reporting.ts"

Cohesion: 0.52
Nodes (6): csvEscape(), Flat, flattenObject(), isPlainObject(), reportToCsv(), reportToPdfReady()

### Community 61 - "verify-payment/index.ts"

Cohesion: 0.43
Nodes (6): computeHash(), FrontendVerifySchema, hmacSha256(), processCapturedPayment(), verifyPaymentSignature(), verifyWebhookSignature()

### Community 62 - "39_schema_alignment.sql"

Cohesion: 0.33
Nodes (5): public.create_booking(), public.recalculate_queue_position(), public.write_audit_log(), public.audit_action_types, public.bookings

### Community 64 - "refund_sync.test.ts"

Cohesion: 0.43
Nodes (6): createClient(), db(), getLocalStatus(), LocalStatus, RUN, seedCapturedBooking()

### Community 67 - "executive-analytics/index.ts"

Cohesion: 0.40
Nodes (4): ANALYTICS_ACTIONS, AnalyticsAction, GLOBAL_ACTIONS, Schema

### Community 68 - "queue-control/index.ts"

Cohesion: 0.40
Nodes (4): BOOKING_ACTIONS, CONTROL_ACTIONS, ControlAction, Schema

## Knowledge Gaps

- **313 isolated node(s):** `BookingFlowState`, `CancelFlowState`, `CancellableRow`, `HospitalWaConfig`, `InboundMessage` (+308 more)
These have ≤1 connection - possible missing edges or undocumented components.
- **11 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.



## Suggested Questions

*Questions this graph is uniquely positioned to answer:*

- **Why does** `getServiceClient()` **connect** `getServiceClient` **to** `whatsapp_conversation_engine.ts`**,** `run-background-worker/index.ts`**,** `db.ts`**,** `logger.ts`**,** `doctor-operations/index.ts`**,** `executive-analytics/index.ts`**,** `queue-control/index.ts`**,** `audit.ts`**,** `auth.ts`**,** `verify-payment/index.ts`**,** `response.ts`**?**
*High betweenness centrality (0.013) - this node is a cross-community bridge.*
- **Why does** `logAuditEvent()` **connect** `audit.ts` **to** `whatsapp_conversation_engine.ts`**,** `run-background-worker/index.ts`**,** `db.ts`**,** `doctor-operations/index.ts`**,** `logger.ts`**,** `queue-control/index.ts`**,** `getServiceClient`**,** `auth.ts`**,** `MetricsCollector`**,** `verify-payment/index.ts`**,** `response.ts`**?**
*High betweenness centrality (0.011) - this node is a cross-community bridge.*
- **Why does** `Logger` **connect** `run-background-worker/index.ts` **to** `whatsapp_conversation_engine.ts`**,** `db.ts`**,** `logger.ts`**,** `audit.ts`**,** `queue_runtime.ts`**,** `getServiceClient`**,** `auth.ts`**,** `formatE164`**?**
*High betweenness centrality (0.010) - this node is a cross-community bridge.*
- **Are the 3 inferred relationships involving** `logAuditEvent()` **(e.g. with** `.error()` **and** `.warn()`**) actually correct?**
`logAuditEvent()` *has 3 INFERRED edges - model-reasoned connections that need verification.*
- **Are the 2 inferred relationships involving** `resolveAuth()` **(e.g. with** `.error()` **and** `.warn()`**) actually correct?**
`resolveAuth()` *has 2 INFERRED edges - model-reasoned connections that need verification.*
- **What connects** `BookingFlowState`**,** `CancelFlowState`**,** `CancellableRow` **to the rest of the system?**
*313 weakly-connected nodes found - possible documentation gaps or missing edges.*
- **Should** `whatsapp_conversation_engine.ts` **be split into smaller, more focused modules?**
*Cohesion score 0.057946069994262765 - nodes in this community are weakly interconnected.*

