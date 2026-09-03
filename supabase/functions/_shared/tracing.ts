/**
 * tracing.ts — Correlation IDs and request timing
 *
 * Provides distributed tracing context propagation.
 * In Edge Functions, we use a simple request-scoped context
 * object rather than OpenTelemetry (not available in Deno Deploy).
 */

export interface TraceContext {
  correlationId: string; // flows across service boundaries (from client or generated)
  requestId: string; // unique to this Edge Function invocation
  spanId: string; // unique to this unit of work within the invocation
  parentSpanId?: string; // set when calling downstream services
  startTime: number; // performance.now() at creation
}

export function createTraceContext(req: Request): TraceContext {
  return {
    correlationId: req.headers.get("X-Correlation-ID") ??
      req.headers.get("X-Request-ID") ??
      crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    spanId: crypto.randomUUID(),
    startTime: performance.now(),
  };
}

export function childSpan(parent: TraceContext): TraceContext {
  return {
    correlationId: parent.correlationId,
    requestId: parent.requestId,
    spanId: crypto.randomUUID(),
    parentSpanId: parent.spanId,
    startTime: performance.now(),
  };
}

export function elapsedMs(ctx: TraceContext): number {
  return Math.round(performance.now() - ctx.startTime);
}

export function traceHeaders(ctx: TraceContext): HeadersInit {
  return {
    "X-Correlation-ID": ctx.correlationId,
    "X-Request-ID": ctx.requestId,
    "X-Span-ID": ctx.spanId,
    ...(ctx.parentSpanId ? { "X-Parent-Span-ID": ctx.parentSpanId } : {}),
  };
}
