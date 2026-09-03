# SETURA — Error Contract

Every error returned by a SETURA edge function uses the standard envelope:

```json
{
  "success": false,
  "error": {
    "code": "<machine-readable code>",
    "message": "<human-readable message>",
    "fieldErrors": { "<field>": ["<reason>", "..."] },
    "retryable": false
  },
  "correlationId": "<trace id>",
  "timestamp": "<ISO 8601>"
}
```

`fieldErrors` is present only for `VALIDATION_ERROR`. `retryable: true` means
the same request may safely be retried (after `Retry-After` where applicable).
All errors are instances of the typed `SeturError` hierarchy
(`supabase/functions/_shared/errors.ts`); unexpected exceptions collapse to
`INTERNAL_ERROR` without leaking internals.

---

## 1. Error codes

### Authentication & authorization

| Code                     | HTTP | Retryable | Meaning                                    |
| ------------------------ | ---- | --------- | ------------------------------------------ |
| `UNAUTHORIZED`           | 401  | No        | Missing/invalid credentials                |
| `INVALID_JWT`            | 401  | No        | JWT failed verification                    |
| `SESSION_EXPIRED`        | 401  | No        | Session no longer valid                    |
| `FORBIDDEN`              | 403  | No        | Authenticated but not allowed              |
| `HOSPITAL_ACCESS_DENIED` | 403  | No        | User has no role in the requested hospital |
| `ROLE_INSUFFICIENT`      | 403  | No        | Role not permitted for this action         |

### Validation

| Code               | HTTP | Retryable | Meaning                                   |
| ------------------ | ---- | --------- | ----------------------------------------- |
| `VALIDATION_ERROR` | 422  | No        | Body failed zod schema; see `fieldErrors` |
| `INVALID_PHONE`    | 422  | No        | Phone failed normalization                |
| `INVALID_UUID`     | 422  | No        | Malformed UUID argument                   |
| `INVALID_DATE`     | 422  | No        | Malformed date argument                   |
| `MISSING_FIELD`    | 422  | No        | Required field absent                     |
| `BODY_TOO_LARGE`   | 422  | No        | Payload exceeds size limit                |

### Booking domain

| Code                       | HTTP | Retryable | Meaning                                  |
| -------------------------- | ---- | --------- | ---------------------------------------- |
| `BOOKING_DUPLICATE`        | 409  | No        | Idempotent duplicate with different body |
| `BOOKING_NOT_FOUND`        | 422  | No        | Booking does not exist in this hospital  |
| `TOKEN_EXHAUSTED`          | 422  | No        | No tokens left for the date              |
| `QUEUE_FULL`               | 422  | No        | Session token capacity reached           |
| `HOSPITAL_CLOSED`          | 422  | No        | Outside operating rules                  |
| `HOSPITAL_HOLIDAY`         | 422  | No        | Requested date is a hospital holiday     |
| `ADVANCE_BOOKING_EXCEEDED` | 422  | No        | Beyond the advance-booking window        |
| `DOCTOR_UNAVAILABLE`       | 422  | No        | Doctor on leave / no session             |
| `PATIENT_BLOCKED`          | 422  | No        | Phone restricted by abuse protection     |

### Idempotency

| Code                       | HTTP | Retryable | Meaning                               |
| -------------------------- | ---- | --------- | ------------------------------------- |
| `IDEMPOTENCY_KEY_REQUIRED` | 400  | No        | Mutating endpoint requires the header |
| `IDEMPOTENCY_PROCESSING`   | 202  | Yes       | Same key in flight; retry later       |
| `IDEMPOTENCY_MISMATCH`     | 409  | No        | Key reused with a different payload   |

### Rate limiting

| Code                     | HTTP | Retryable | Meaning                           |
| ------------------------ | ---- | --------- | --------------------------------- |
| `RATE_LIMIT_EXCEEDED`    | 429  | Yes       | Phone-scoped limit; `Retry-After` |
| `IP_RATE_LIMIT_EXCEEDED` | 429  | Yes       | IP-scoped limit; `Retry-After`    |

### Queue & workers

| Code                      | HTTP | Retryable | Meaning                         |
| ------------------------- | ---- | --------- | ------------------------------- |
| `JOB_CLAIM_FAILED`        | 500  | Yes       | Worker could not claim a job    |
| `WORKER_LEASE_LOST`       | 409  | Yes       | Lease expired mid-processing    |
| `QUEUE_CONCURRENCY_ERROR` | 409  | Yes       | Contended queue operation       |
| `DB_CONCURRENCY_ERROR`    | 409  | Yes       | Optimistic concurrency conflict |

### Payments

| Code                    | HTTP | Retryable | Meaning                              |
| ----------------------- | ---- | --------- | ------------------------------------ |
| `PAYMENT_FAILED`        | 502  | Yes       | PSP failure                          |
| `PAYMENT_NOT_FOUND`     | 422  | No        | Unknown payment/order                |
| `REFUND_EXCEEDS_AMOUNT` | 422  | No        | Refund larger than refundable amount |

### Database & infrastructure

| Code                      | HTTP | Retryable | Meaning                             |
| ------------------------- | ---- | --------- | ----------------------------------- |
| `DB_ERROR`                | 500  | No        | Query/RPC failure                   |
| `DB_CONSTRAINT_VIOLATION` | 500  | No        | Constraint rejected the write       |
| `DB_TIMEOUT`              | 504  | Yes       | Query exceeded budget               |
| `WHATSAPP_SEND_FAILED`    | 502  | Yes       | WhatsApp API failure (worker scope) |
| `WHATSAPP_RATE_LIMITED`   | 429  | Yes       | WhatsApp throttling (worker scope)  |
| `INTERNAL_ERROR`          | 500  | No        | Unclassified server error           |
| `NOT_IMPLEMENTED`         | 501  | No        | Endpoint/action not available       |
| `SERVICE_UNAVAILABLE`     | 503  | Yes       | Dependency unavailable              |

---

## 2. Phase 1.5 domain error semantics

Enterprise endpoints reuse the taxonomy above with these semantics:

- **Missing `X-Hospital-ID`** → `VALIDATION_ERROR` (422, `header`).
- **Unknown action/report type** → `VALIDATION_ERROR` with the rejected field
  (the SQL layer returns `{ok: false, reason}` which the edge maps to a 422,
  e.g. `reason: unknown_report_type`).
- **Alert not found / wrong hospital** → `VALIDATION_ERROR` (404-style message)
  / `FORBIDDEN` respectively.
- **Suppression window in the past** → `VALIDATION_ERROR`
  (`reason: window_in_past`).
- **Alert lifecycle rejection** (e.g. resolving an already resolved alert) →
  `VALIDATION_ERROR` with the RPC `reason` on `alertId`.
- **Portfolio/benchmarks by non-global admin** → `FORBIDDEN`.

---

## 3. Client guidance

1. Treat `code` as the stable contract; `message` is human-readable and may
   change.
2. Retry only when `retryable: true`; honor `Retry-After` on 429.
3. Reuse the same `Idempotency-Key` when retrying a mutation — retries converge
   instead of duplicating.
4. Log `correlationId` for every failure; support can trace it through logs and
   the immutable audit trail (`audit_search` with `correlationId`).
5. 5xx errors never mutate business state partially: mutations are transactional
   at the SQL layer, and side-effects (notifications) are best-effort and
   independently idempotent.
