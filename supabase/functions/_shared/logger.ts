/**
 * logger.ts — Structured JSON logging for Edge Functions
 *
 * Design decisions:
 * - Every log line is a single JSON object (machine-parseable)
 * - Log level hierarchy: debug < info < warn < error
 * - Correlation ID flows through all logs in a request
 * - Timing helpers for measuring execution duration
 * - Error serialization preserves stack traces in dev mode
 * - Never throws: logger failures are silently swallowed
 */

import { Env } from "./env.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const CONFIGURED_LEVEL = (Env.LOG_LEVEL as LogLevel) in LOG_LEVELS
  ? (Env.LOG_LEVEL as LogLevel)
  : "info";

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[CONFIGURED_LEVEL];
}

export interface LogContext {
  correlationId?: string;
  requestId?: string;
  userId?: string;
  hospitalId?: string;
  endpoint?: string;
  durationMs?: number;
  [key: string]: unknown;
}

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  service: string;
  version: string;
  env: string;
  [key: string]: unknown;
}

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const base: Record<string, unknown> = {
      name: err.name,
      message: err.message,
    };
    if (!Env.IS_PRODUCTION && err.stack) {
      base.stack = err.stack;
    }
    // Preserve SeturError fields
    if ("code" in err) base.code = (err as { code: unknown }).code;
    if ("statusCode" in err) {
      base.statusCode = (err as { statusCode: unknown }).statusCode;
    }
    if ("context" in err) base.context = (err as { context: unknown }).context;
    if ("retryable" in err) {
      base.retryable = (err as { retryable: unknown }).retryable;
    }
    return base;
  }
  return { raw: String(err) };
}

function emit(level: LogLevel, msg: string, context: LogContext = {}): void {
  if (!shouldLog(level)) return;

  try {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      msg,
      service: "setura-edge",
      version: Env.DEPLOYMENT_VERSION,
      env: Env.APP_ENV,
      ...context,
    };

    const line = JSON.stringify(entry);

    if (level === "error" || level === "warn") {
      console.error(line);
    } else {
      console.log(line);
    }
  } catch {
    // Never let the logger crash a request
  }
}

// ─── Logger class (request-scoped) ───────────────────────────────────────────

/**
 * Normalizes a loosely-typed second log argument.
 * Plain objects are merged as context; anything else (typically an
 * Error caught in a catch block) is serialized under the "error" key.
 */
function toContext(extra: unknown): LogContext {
  if (
    extra !== null &&
    typeof extra === "object" &&
    !(extra instanceof Error)
  ) {
    return extra as LogContext;
  }
  if (extra === undefined || extra === null) {
    return {};
  }
  return { error: serializeError(extra) };
}

export class Logger {
  private context: LogContext;

  constructor(context: LogContext = {}) {
    this.context = context;
  }

  /**
   * Returns a child logger with additional context merged in.
   * Original logger is unmodified.
   */
  child(additionalContext: LogContext): Logger {
    return new Logger({ ...this.context, ...additionalContext });
  }

  debug(msg: string, extra?: unknown): void {
    emit("debug", msg, { ...this.context, ...toContext(extra) });
  }

  info(msg: string, extra?: unknown): void {
    emit("info", msg, { ...this.context, ...toContext(extra) });
  }

  warn(msg: string, extra?: unknown): void {
    emit("warn", msg, { ...this.context, ...toContext(extra) });
  }

  error(msg: string, err?: unknown, extra: LogContext = {}): void {
    const errorContext = err !== undefined
      ? { error: serializeError(err) }
      : {};
    emit("error", msg, { ...this.context, ...errorContext, ...extra });
  }

  /**
   * Returns a timer. Call timer.end() to log the duration.
   */
  timer(label: string, extra: LogContext = {}): { end: () => number } {
    const start = performance.now();
    return {
      end: () => {
        const durationMs = Math.round(performance.now() - start);
        this.info(`${label} completed`, { ...extra, durationMs });
        return durationMs;
      },
    };
  }
}

// ─── Module-level root logger ─────────────────────────────────────────────────

export const rootLogger = new Logger({});

/**
 * Creates a request-scoped logger. Call at the top of each handler.
 */
export function createRequestLogger(req: Request, endpoint: string): Logger {
  const correlationId = req.headers.get("X-Correlation-ID") ??
    req.headers.get("X-Request-ID") ??
    crypto.randomUUID();

  return new Logger({
    correlationId,
    endpoint,
    method: req.method,
    url: new URL(req.url).pathname,
  });
}
