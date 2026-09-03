/**
 * metrics.ts — Runtime metrics for Edge Functions
 *
 * Collects timing, counter, and gauge metrics per request.
 * At the end of each handler, metrics are flushed to the
 * queue_metrics_snapshots table (or logged structured for
 * external collectors).
 *
 * Deno Deploy does not support OpenTelemetry SDK natively,
 * so we emit metrics as structured log lines parseable by
 * Datadog / Grafana Loki / CloudWatch Logs Insights.
 */

import { Logger } from "./logger.ts";

export interface Metric {
  name: string;
  value: number;
  unit: "ms" | "count" | "bytes" | "pct";
  tags: Record<string, string>;
  timestamp: string;
}

export class MetricsCollector {
  private readonly metrics: Metric[] = [];
  private readonly baseTags: Record<string, string>;

  constructor(baseTags: Record<string, string> = {}) {
    this.baseTags = baseTags;
  }

  record(
    name: string,
    value: number,
    unit: Metric["unit"] = "count",
    extraTags: Record<string, string> = {},
  ): void {
    this.metrics.push({
      name,
      value,
      unit,
      tags: { ...this.baseTags, ...extraTags },
      timestamp: new Date().toISOString(),
    });
  }

  timing(
    name: string,
    durationMs: number,
    tags: Record<string, string> = {},
  ): void {
    this.record(name, durationMs, "ms", tags);
  }

  increment(name: string, tags: Record<string, string> = {}): void {
    this.record(name, 1, "count", tags);
  }

  /**
   * Returns a timer. Call stop() to record the duration.
   */
  startTimer(
    name: string,
    tags: Record<string, string> = {},
  ): { stop: () => number } {
    const start = performance.now();
    return {
      stop: () => {
        const durationMs = Math.round(performance.now() - start);
        this.timing(name, durationMs, tags);
        return durationMs;
      },
    };
  }

  /**
   * Flush all metrics as structured log lines.
   * Each metric is a separate JSON log entry with msg="metric".
   */
  flush(logger: Logger): void {
    for (const metric of this.metrics) {
      logger.info("metric", {
        metricName: metric.name,
        metricValue: metric.value,
        metricUnit: metric.unit,
        metricTags: metric.tags,
        metricTs: metric.timestamp,
      });
    }
  }

  getAll(): Metric[] {
    return [...this.metrics];
  }

  getSummary(): Record<string, number> {
    const summary: Record<string, number> = {};
    for (const m of this.metrics) {
      summary[m.name] = m.value;
    }
    return summary;
  }
}

/**
 * Creates a metrics collector pre-tagged with request context.
 */
export function createMetrics(
  endpoint: string,
  correlationId: string,
  hospitalId?: string,
): MetricsCollector {
  return new MetricsCollector({
    endpoint,
    correlationId,
    ...(hospitalId ? { hospitalId } : {}),
  });
}
