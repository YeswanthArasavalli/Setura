---
kind: logging_system
name: Structured JSON Logging with Request-Scoped Context in Supabase Edge Functions
category: logging_system
scope:
  - "**"
source_files:
  - supabase/functions/_shared/logger.ts
  - supabase/functions/_shared/tracing.ts
  - supabase/functions/_shared/metrics.ts
  - supabase/functions/_shared/errors.ts
  - supabase/functions/_shared/env.ts
---

## Overview

The repository implements a centralized, structured logging system for its
Supabase Edge Functions (Deno Deploy) located under
`supabase/functions/_shared/`. There is no third-party logging framework — the
system is built on top of Deno's `console.log` / `console.error`, producing one
JSON object per log line that can be consumed by external collectors (Datadog,
Grafana Loki, CloudWatch Logs Insights).

## Core Components

### Logger (`logger.ts`)

- **Format**: Every log line is a single JSON object (`LogEntry`) containing
  fixed fields `ts`, `level`, `msg`, `service` (always `"setura-edge"`),
  `version` (from `Env.DEPLOYMENT_VERSION`), and `env` (from `Env.APP_ENV`),
  plus any merged context fields.
- **Levels**: `debug < info < warn < error`, filtered at runtime by `LOG_LEVEL`
  from environment. Default is `info` in production, `debug` otherwise.
- **Request-scoped context**: `createRequestLogger(req, endpoint)` builds a
  `Logger` instance carrying `correlationId`, `endpoint`, `method`, and `url`. A
  `child()` method returns a new logger merging additional context without
  mutating the parent.
- **Error serialization**: Errors passed as the second argument are serialized
  via `serializeError()`, which preserves `name`, `message`, `stack` (only when
  `!Env.IS_PRODUCTION`), and custom fields from `SeturError` (`code`,
  `statusCode`, `context`, `retryable`).
- **Safety**: The `emit()` function is wrapped in try/catch so logger failures
  never crash a request.
- **Timing helper**: `logger.timer(label)` returns an `{ end: () => number }`
  that logs `durationMs` on completion.

### Tracing (`tracing.ts`)

- Provides distributed tracing context propagation using simple UUIDs (no
  OpenTelemetry, not available in Deno Deploy).
- `TraceContext` carries `correlationId`, `requestId`, `spanId`, optional
  `parentSpanId`, and `startTime`.
- `traceHeaders(ctx)` produces headers (`X-Correlation-ID`, `X-Request-ID`,
  `X-Span-ID`, `X-Parent-Span-ID`) to forward across downstream calls.
- `childSpan(parent)` creates a child span inheriting the correlation ID.

### Metrics (`metrics.ts`)

- `MetricsCollector` buffers metrics per request with `name`, `value`, `unit`
  (`ms | count | bytes | pct`), `tags`, and `timestamp`.
- Emits metrics as structured log lines with `msg="metric"` via the shared
  `Logger`, tagged with `endpoint`, `correlationId`, and optionally
  `hospitalId`.
- `createMetrics(endpoint, correlationId, hospitalId?)` pre-tags collectors with
  request context.

### Error Integration (`errors.ts`)

- Centralized `SeturError` hierarchy with typed `ErrorCode` values covering
  auth, validation, booking, idempotency, rate limiting, queue/worker, payment,
  database, external services, and server errors.
- Each error carries `code`, `statusCode`, `retryable`, `context`, and
  `timestamp`; `toJSON()` serializes these fields.
- `isSeturError()` and `isRetryable()` type guards support consistent error
  handling.

### Environment Configuration (`env.ts`)

- Observability-related env vars: `LOG_LEVEL` (defaults based on `APP_ENV`),
  `SENTRY_DSN`, `DEPLOYMENT_VERSION`, `ENABLE_TRACING`, `ENABLE_METRICS`.
- Fails fast on missing required variables during module load.

## Architecture & Conventions

1. **Single JSON-per-line output** — every log line is machine-parseable JSON;
   consumers parse rather than regex-match text.
2. **Correlation ID flows through all logs** — extracted from `X-Correlation-ID`
   or `X-Request-ID` headers, falling back to `crypto.randomUUID()`; this same
   ID is propagated to downstream calls via `traceHeaders`.
3. **Service identity is baked into every entry** — `service: "setura-edge"` and
   `version` (deployment version) are always present.
4. **Environment-driven verbosity** — `LOG_LEVEL` controls filtering; stack
   traces are suppressed in production.
5. **Errors are first-class log payloads** — errors are never stringified raw;
   they go through `serializeError()` and retain typed fields from `SeturError`.
6. **Metrics are emitted as log lines** — because Deno Deploy lacks native
   metrics SDKs, metrics are flushed as structured log entries with
   `msg="metric"` for log-based collectors.
7. **Never throws** — both the logger emit path and the error serializer swallow
   exceptions to protect request execution.

## Key Files

- `supabase/functions/_shared/logger.ts` — structured logger, levels,
  request-scoped context, timers
- `supabase/functions/_shared/tracing.ts` — correlation/span context propagation
- `supabase/functions/_shared/metrics.ts` — metrics collection flushed as
  structured logs
- `supabase/functions/_shared/errors.ts` — typed `SeturError` hierarchy used by
  logger serialization
- `supabase/functions/_shared/env.ts` — `LOG_LEVEL`, `DEPLOYMENT_VERSION`,
  `SENTRY_DSN`, feature flags

## Constraints

- No OpenTelemetry SDK is used (not available in Deno Deploy); tracing is
  lightweight UUID-based.
- Log output goes only to `console.log` / `console.error`; there is no file
  sink, network sink, or pluggable backend within this codebase.
- All domain errors must extend `SeturError` so they serialize consistently into
  logs.
