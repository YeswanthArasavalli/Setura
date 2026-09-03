# SETURA — API Contracts

All APIs are HTTP POST JSON endpoints hosted as Supabase Edge Functions. This
document is the contract reference for clients; it is additive and backward
compatible with every prior phase.

---

## 1. Common conventions

### 1.1 Request headers

| Header             | Required      | Description                           |
| ------------------ | ------------- | ------------------------------------- |
| `Authorization`    | Yes           | `Bearer <JWT>`                        |
| `X-Hospital-ID`    | Yes           | Tenant scope (UUID)                   |
| `Idempotency-Key`  | When required | Mutating booking/payment endpoints    |
| `X-Correlation-ID` | Optional      | Client-supplied trace id; echoed back |

### 1.2 Success envelope

```json
{
  "success": true,
  "data": { "...": "endpoint-specific payload" },
  "correlationId": "uuid-or-client-supplied",
  "timestamp": "2026-08-11T10:00:00.000Z",
  "meta": { "optional": "metadata" }
}
```

OpenAPI-ready metadata: every response carries `correlationId` and `timestamp`;
endpoints may attach a `meta` block (e.g. content hints).

### 1.3 Error envelope

See `docs/ERROR_CONTRACT.md`. Errors are always:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "human readable",
    "fieldErrors": { "field": ["reason"] },
    "retryable": false
  },
  "correlationId": "...",
  "timestamp": "..."
}
```

### 1.4 Dates and times

- Dates: `YYYY-MM-DD` (server-local hospital date semantics in SQL).
- Timestamps: ISO 8601 UTC (`YYYY-MM-DDTHH:mm:ss.sssZ`).

---

## 2. Command center — `command-center`

Roles: `hospital_admin`, `global_admin`.

| `action`                  | Body fields                                                                                 | Response `data`                    |
| ------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------- |
| `overview`                | `date?`                                                                                     | `overview` + `scores`              |
| `timeline`                | `fromTs?`, `toTs?`, `eventTypes?[]`, `severity?`, `doctorId?`, `queueSessionId?`, `limit?`  | `timeline`                         |
| `predictive`              | `date?`                                                                                     | `predictions`                      |
| `sla_dashboard`           | `date?`                                                                                     | `sla`                              |
| `system_health`           | —                                                                                           | `health` (queue/MV/DLQ/openAlerts) |
| `broadcast_queue_summary` | `queueSessionId`                                                                            | `broadcast {kind, enqueued}`       |
| `broadcast_doctor_delay`  | `queueSessionId`, `delayMinutes`, `reason?`                                                 | `broadcast {kind, enqueued}`       |
| `broadcast_closure`       | `date?`, `reason?`                                                                          | `broadcast {kind, enqueued}`       |
| `broadcast_admin_notice`  | `kind` (`daily_summary` \| `sla_breach` \| `congestion` \| `operational_notice`), `message` | `broadcast {kind, enqueued}`       |
| `broadcast_alert`         | `alertId`                                                                                   | `broadcast {kind, enqueued}`       |

`overview` contains `patients`, `queues` (incl. doctor availability, stalled
queues), `sla`, `finance` (revenue today, outstanding settlements), and
`alert_activity`. Broadcasts are idempotent (deterministic job keys),
feature-flag gated for patient-facing messages, and audited as
`operational_alert`.

Performance target: `< 300 ms` for overview/timeline.

---

## 3. Executive analytics — `executive-analytics`

Roles: `hospital_admin`, `global_admin` (portfolio/benchmarks: `global_admin`
only → `FORBIDDEN` otherwise).

| `action`             | Body fields                        | Response `data` |
| -------------------- | ---------------------------------- | --------------- |
| `daily_operations`   | `date?`                            | `dashboard`     |
| `weekly_operations`  | `weekStart?`                       | `dashboard`     |
| `monthly_executive`  | `monthStart?`                      | `dashboard`     |
| `doctor_performance` | `doctorId`, `fromDate?`, `toDate?` | `performance`   |
| `doctor_rankings`    | `fromDate?`, `toDate?`             | `rankings`      |
| `portfolio`          | `date?`                            | `portfolio`     |
| `benchmarks`         | `fromDate?`, `toDate?`             | `benchmarks`    |

Read-only (no audit entries). Performance targets: dashboards `< 500 ms`, doctor
analytics `< 200 ms`, portfolio `< 800 ms`.

---

## 4. Financial command center — `financial-command-center`

Roles: `hospital_admin`, `global_admin`.

| `action`         | Body fields            | Response `data`  |
| ---------------- | ---------------------- | ---------------- |
| `overview`       | `date?`                | `financial`      |
| `forecast`       | `date?`                | `forecast`       |
| `reconciliation` | `fromDate?`, `toDate?` | `reconciliation` |

`overview` provides daily collections (fee split, refunds, net, online/offline
split, pending), settlement intelligence (aging buckets, velocity, outstanding),
and reconciliation status. `forecast` is deterministic month-to-date proration
with its `inputs` disclosed. Performance target: `< 400 ms`.

---

## 5. Alert center — `alert-center`

Roles: `hospital_admin`, `global_admin` (hospital isolation enforced on every
target).

| `action`      | Body fields                                                               | Response `data`                          |
| ------------- | ------------------------------------------------------------------------- | ---------------------------------------- |
| `list`        | `status?` (`open`\|`all`\|`resolved`), `severity?`, `category?`, `limit?` | `center`                                 |
| `analytics`   | `fromDate?`, `toDate?`                                                    | `analytics`                              |
| `acknowledge` | `alertId`                                                                 | `result {ok, ...}`                       |
| `assign`      | `alertId`, `assigneeId`                                                   | `result {ok, ...}`                       |
| `resolve`     | `alertId`, `notes?`                                                       | `result {ok, ...}`                       |
| `escalate`    | `alertId`, `notes?`                                                       | `result {ok, ...}` (severity → critical) |
| `suppress`    | `alertKey`, `activeUntil`, `reason?`                                      | `result {ok, suppression_id}`            |

Mutations are audited as `alert_center` and write to the append-only
`alert_activity_log`. Repeated `acknowledge`/`assign` calls are idempotent
(`already_acknowledged` / no-op semantics in `result`).

---

## 6. Enterprise reports — `enterprise-reports`

Roles: `hospital_admin`, `global_admin`.

| `action`               | Body fields                                                                              | Response `data`            |
| ---------------------- | ---------------------------------------------------------------------------------------- | -------------------------- |
| `generate`             | `reportType`, `format?` (`json`\|`csv`\|`pdf_ready`), `fromDate?`, `toDate?`             | `report` \| `csv` \| `pdf` |
| `audit_search`         | `actorId?`, `entityType?`, `actionType?`, `fromTs?`, `toTs?`, `correlationId?`, `limit?` | `results`                  |
| `audit_integrity`      | `fromTs?`                                                                                | `result {ok, ...}`         |
| `settlement_integrity` | —                                                                                        | `result {ok, ...}`         |
| `queue_integrity`      | `queueSessionId`                                                                         | `result {ok, ...}`         |
| `doctor_ops_integrity` | `doctorId`, `date?`                                                                      | `result {ok, ...}`         |
| `integration_matrix`   | `date?`                                                                                  | `result {ok, ...}`         |

Report types: `daily_hospital`, `weekly_operations`, `monthly_executive`,
`doctor_performance`, `financial`, `settlement`, `sla`, `audit`.

- `format: json` returns the full report object (`report`).
- `format: csv` returns `csv` text (tabular when the report has rows, flattened
  key/value otherwise); `meta.contentType = "text/csv"`.
- `format: pdf_ready` returns a sectioned structure (`pdf`) suitable for
  paginated rendering — no binary at the edge.

Generation is audited as `executive_report`; compliance checks as
`compliance_check` (audit searches are themselves audited). Performance target:
`< 5 s` per report.

---

## 7. Prior-phase endpoint contracts (unchanged)

Existing endpoints retain their current contracts exactly — this phase adds no
breaking changes:

- `create-booking`, `reschedule-booking`, `cancel-booking`,
  `update-booking-status`, `carry-forward-tokens` — booking lifecycle with
  idempotency keys.
- `queue-next-patient`, `doctor-operations` — queue runtime actions.
- `create-payment-order`, `verify-payment`, `process-refund`,
  `settlement-engine` — financial flows.
- `process-whatsapp-webhook`, `send-reminders` — messaging.
- `refresh-rollups`, `compute-sla`, `monitoring-health-check`,
  `run-background-worker`, cron entry points — operations.

---

## 8. Workflow verification & integration matrix

Deferred verification APIs are now served by `enterprise-reports`:

- **Integration matrix automation:** `integration_matrix` verifies the booking →
  collection → ledger chain per hospital-day.
- **Workflow verification:** `queue_integrity` and `doctor_ops_integrity` verify
  queue invariants and doctor-day timestamp consistency.
- **Observability verification:** `command-center` `system_health` exposes queue
  health, MV freshness, DLQ summary, and open alert counts.
