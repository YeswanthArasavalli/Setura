import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@/auth/AuthProvider";
import {
  fetchCommandCenterOverview,
  fetchCommandCenterPredictive,
  fetchCommandCenterSla,
  fetchCommandCenterSystemHealth,
  fetchCommandCenterTimeline,
} from "@/api/commandCenter";
import { describeError } from "@/lib/errors";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type {
  CommandCenterOverviewResponse,
  CommandCenterPredictiveResponse,
  CommandCenterSlaResponse,
  CommandCenterSystemHealthResponse,
  CommandCenterTimelineResponse,
  TimelineEvent,
} from "@/types/api";

/**
 * Hospital Admin Command Centre (Phase 7 G-03) — a strictly READ-ONLY
 * operational overview.
 *
 * Everything on this page is a presentation of an actual `command-center`
 * Edge Function response: no metric is computed, derived or fabricated in
 * React, no SLA math is re-implemented, no prediction is invented and no
 * mutation control exists. The five reads are independent sections with
 * section-level loading / empty / error states, so one failing action
 * degrades only its own section (partial failure), never the whole page.
 *
 * Tenant context comes from the authenticated staff session only — never
 * from the URL — and the backend re-authorizes role + tenant server-side.
 */

type SectionStatus = "loading" | "success" | "error";

interface Section<T> {
  status: SectionStatus;
  data: T | null;
  error: string | null;
}

const LOADING: Section<never> = { status: "loading", data: null, error: null };

function failed(e: unknown): Section<never> {
  return { status: "error", data: null, error: describeError(e) };
}

function succeeded<T>(data: T): Section<T> {
  return { status: "success", data, error: null };
}

/** Safe display for backend values that may arrive as number or string
 *  (PostgREST NUMERIC serialisation), null or undefined. Never renders
 *  "undefined", "null" or "[object Object]". */
function display(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "—";
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : v;
}

/** Timestamp rendering that falls back to the raw value for unparsable
 *  input instead of emitting "Invalid Date" noise. */
function displayTs(ts: string | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

const SEVERITY_VARIANT: Record<string, "secondary" | "warning" | "destructive">
  = {
    info: "secondary",
    warning: "warning",
    critical: "destructive",
  };

export function AdminCommandCentre() {
  const { staff, hospitalId } = useAuth();

  const [overview, setOverview] = useState<Section<CommandCenterOverviewResponse>>(LOADING);
  const [sla, setSla] = useState<Section<CommandCenterSlaResponse>>(LOADING);
  const [health, setHealth] = useState<Section<CommandCenterSystemHealthResponse>>(LOADING);
  const [timeline, setTimeline] = useState<Section<CommandCenterTimelineResponse>>(LOADING);
  const [predictive, setPredictive] = useState<Section<CommandCenterPredictiveResponse>>(LOADING);

  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const activeRef = useRef(true);

  const loadAll = useCallback(async () => {
    if (!hospitalId) return;
    setRefreshing(true);
    setOverview(LOADING);
    setSla(LOADING);
    setHealth(LOADING);
    setTimeline(LOADING);
    setPredictive(LOADING);

    // Independent reads → independent outcomes. allSettled keeps one failed
    // action from destroying the sections that did return.
    const [rOverview, rSla, rHealth, rTimeline, rPredictive] =
      await Promise.allSettled([
        fetchCommandCenterOverview(hospitalId),
        fetchCommandCenterSla(hospitalId),
        fetchCommandCenterSystemHealth(hospitalId),
        fetchCommandCenterTimeline(hospitalId),
        fetchCommandCenterPredictive(hospitalId),
      ]);

    if (!activeRef.current) return;

    if (rOverview.status === "fulfilled") setOverview(succeeded(rOverview.value));
    else setOverview(failed(rOverview.reason));
    if (rSla.status === "fulfilled") setSla(succeeded(rSla.value));
    else setSla(failed(rSla.reason));
    if (rHealth.status === "fulfilled") setHealth(succeeded(rHealth.value));
    else setHealth(failed(rHealth.reason));
    if (rTimeline.status === "fulfilled") setTimeline(succeeded(rTimeline.value));
    else setTimeline(failed(rTimeline.reason));
    if (rPredictive.status === "fulfilled") setPredictive(succeeded(rPredictive.value));
    else setPredictive(failed(rPredictive.reason));

    // The freshness claim covers only an actually-completed fetch round with
    // at least one success — never a failed refresh.
    if ([rOverview, rSla, rHealth, rTimeline, rPredictive].some((r) => r.status === "fulfilled")) {
      setLastUpdated(new Date().toISOString());
    }
    setRefreshing(false);
  }, [hospitalId]);

  useEffect(() => {
    activeRef.current = true;
    void loadAll();
    return () => {
      activeRef.current = false;
    };
  }, [loadAll]);

  if (!hospitalId) {
    return (
      <p className="text-muted-foreground">
        No hospital tenant is attached to your account.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Command Centre</h1>
          <p className="text-sm text-muted-foreground">
            Read-only operational overview · {staff?.fullName} · tenant{" "}
            <span className="font-mono">{hospitalId}</span>
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground" data-testid="last-updated">
            {lastUpdated
              ? `Last updated ${new Date(lastUpdated).toLocaleString()}`
              : "Not yet fetched"}
          </span>
          <Button size="sm" variant="outline" disabled={refreshing} onClick={() => void loadAll()}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>

      <OverviewSection section={overview} />
      <SlaSection section={sla} />
      <SystemHealthSection section={health} />
      <TimelineSection section={timeline} />
      <PredictiveSection section={predictive} />
    </div>
  );
}

// ─── Section shell ───────────────────────────────────────────────────────────

function SectionCard<T>({
  title,
  description,
  section,
  children,
}: {
  title: string;
  description: string;
  section: Section<T>;
  children: (data: T) => ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {section.status === "loading" ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : section.status === "error" ? (
          // Honest failure: an error is never dressed up as “no data”.
          <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {section.error}
          </p>
        ) : (
          children(section.data as T)
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-xl font-semibold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

// ─── Operational overview ────────────────────────────────────────────────────

function OverviewSection({
  section,
}: {
  section: Section<CommandCenterOverviewResponse>;
}) {
  return (
    <SectionCard
      title="Operational Overview"
      description="Live snapshot from the command-center overview read."
      section={section}
    >
      {(data) => {
        const o = data.overview;
        const s = data.scores;
        return (
          <div className="space-y-4">
            {o.patients ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <Stat label="Bookings today" value={display(o.patients.total_today)} />
                <Stat label="Waiting" value={display(o.patients.waiting)} />
                <Stat label="Called" value={display(o.patients.called)} />
                <Stat label="In consultation" value={display(o.patients.in_consultation)} />
                <Stat label="Checked in" value={display(o.patients.checked_in)} />
                <Stat label="Completed" value={display(o.patients.completed)} />
                <Stat label="Cancelled" value={display(o.patients.cancelled)} />
                <Stat label="No-shows" value={display(o.patients.no_shows)} />
                <Stat label="Avg wait (min)" value={display(o.patients.avg_wait_minutes)} />
                <Stat
                  label="Avg consultation (min)"
                  value={display(o.patients.avg_consultation_minutes)}
                />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No patient-flow data returned.
              </p>
            )}

            {o.queues ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <Stat label="Active sessions" value={display(o.queues.active_sessions)} />
                <Stat label="Paused queues" value={display(o.queues.paused_queues)} />
                <Stat label="Delayed doctors" value={display(o.queues.delayed_doctors)} />
                <Stat label="Stalled queues" value={display(o.queues.stalled_queues)} />
                <Stat label="Active consultations" value={display(o.queues.active_consultations)} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No queue sessions today.</p>
            )}

            {o.finance ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <Stat label="Revenue today" value={display(o.finance.revenue_today)} />
                <Stat label="Platform fee today" value={display(o.finance.platform_fee_today)} />
                <Stat label="Refunds today" value={display(o.finance.refunds_today)} />
                <Stat label="Pending payments" value={display(o.finance.pending_payments)} />
                <Stat
                  label="Outstanding settlements"
                  value={display(o.finance.outstanding_settlements)}
                />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No finance data returned.</p>
            )}

            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <span className="text-muted-foreground">SLA status: </span>
                {o.sla ? display(o.sla.status) : "—"}
              </div>
              <div>
                <span className="text-muted-foreground">Alerts (24h): </span>
                {display(o.alert_activity?.recent_alerts_24h)}
              </div>
              <div>
                <span className="text-muted-foreground">Snapshot date: </span>
                {display(o.date)}
              </div>
              <div>
                <span className="text-muted-foreground">Generated: </span>
                {displayTs(o.generated_at)}
              </div>
            </div>

            {s ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <Stat label="Congestion score" value={display(s.congestion_score)} />
                <Stat label="Delay score" value={display(s.delay_score)} />
                <Stat label="Risk score" value={display(s.risk_score)} />
                <Stat label="Health score" value={display(s.health_score)} />
                <Stat label="Patient experience" value={display(s.patient_experience_score)} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No operational scores returned.</p>
            )}
          </div>
        );
      }}
    </SectionCard>
  );
}

// ─── SLA dashboard ───────────────────────────────────────────────────────────

function SlaSection({ section }: { section: Section<CommandCenterSlaResponse> }) {
  return (
    <SectionCard
      title="SLA Dashboard"
      description="Backend SLA tracking for the selected day — values as computed by the SLA engine."
      section={section}
    >
      {(data) => {
        const sla = data.sla;
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label="Tracked" value={display(sla.summary?.tracked)} />
              <Stat label="In breach" value={display(sla.summary?.in_breach)} />
              <Stat
                label="Avg breach wait (min)"
                value={display(sla.summary?.avg_breach_wait_minutes)}
              />
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium">Breaches</h3>
              {sla.hospitals_in_breach.length === 0 ? (
                <p className="text-sm text-muted-foreground">No SLA breaches recorded.</p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Hospital</TH>
                      <TH>Avg wait</TH>
                      <TH>Completion %</TH>
                      <TH>Wait breach</TH>
                      <TH>Completion breach</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {sla.hospitals_in_breach.map((b, i) => (
                      <TR key={`${b.hospital_id}-${i}`}>
                        <TD>{b.hospital_name}</TD>
                        <TD>{display(b.avg_wait_minutes)}</TD>
                        <TD>{display(b.completion_rate_pct)}</TD>
                        <TD>{b.sla_wait_breached ? "Yes" : "No"}</TD>
                        <TD>{b.sla_completion_breached ? "Yes" : "No"}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium">14-day trend</h3>
              {sla.trend_14d.length === 0 ? (
                <p className="text-sm text-muted-foreground">No trend data available.</p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Date</TH>
                      <TH>Avg wait</TH>
                      <TH>Completion %</TH>
                      <TH>Breached</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {sla.trend_14d.map((t) => (
                      <TR key={t.tracking_date}>
                        <TD>{display(t.tracking_date)}</TD>
                        <TD>{display(t.avg_wait_minutes)}</TD>
                        <TD>{display(t.completion_rate_pct)}</TD>
                        <TD>{display(t.hospitals_breached)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </div>
          </div>
        );
      }}
    </SectionCard>
  );
}

// ─── System health ───────────────────────────────────────────────────────────

function SystemHealthSection({
  section,
}: {
  section: Section<CommandCenterSystemHealthResponse>;
}) {
  return (
    <SectionCard
      title="System Health"
      description="Monitoring infrastructure state reported by the backend health read."
      section={section}
    >
      {(data) => {
        const h = data.health;
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Open alerts" value={display(h.openAlerts)} />
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium">Job queues</h3>
              {h.queueHealth === null ? (
                <p className="text-sm text-muted-foreground">Not reported.</p>
              ) : h.queueHealth.length === 0 ? (
                <p className="text-sm text-muted-foreground">No queue health rows.</p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Queue</TH>
                      <TH>Pending</TH>
                      <TH>Processing</TH>
                      <TH>Failed</TH>
                      <TH>Dead</TH>
                      <TH>Oldest pending</TH>
                      <TH>Throughput (1h)</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {h.queueHealth.map((q) => (
                      <TR key={q.queue_type}>
                        <TD>{q.queue_type}</TD>
                        <TD>{display(q.pending_count)}</TD>
                        <TD>{display(q.processing_count)}</TD>
                        <TD>{display(q.failed_count)}</TD>
                        <TD>{display(q.dead_count)}</TD>
                        <TD>{display(q.oldest_pending_age)}</TD>
                        <TD>{display(q.throughput_last_hour)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium">Materialized views</h3>
              {h.materializedViews === null ? (
                <p className="text-sm text-muted-foreground">Not reported.</p>
              ) : h.materializedViews.length === 0 ? (
                <p className="text-sm text-muted-foreground">No materialized-view rows.</p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>View</TH>
                      <TH>Last refresh</TH>
                      <TH>Success</TH>
                      <TH>Rows</TH>
                      <TH>Stale</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {h.materializedViews.map((m) => (
                      <TR key={m.view_name}>
                        <TD className="font-mono">{m.view_name}</TD>
                        <TD>{displayTs(m.last_refresh)}</TD>
                        <TD>{m.last_success === null || m.last_success === undefined ? "—" : m.last_success ? "Yes" : "No"}</TD>
                        <TD>{display(m.row_count)}</TD>
                        <TD>{m.is_stale ? "Yes" : "No"}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium">Dead-letter queue</h3>
              {h.deadLetterQueue === null ? (
                <p className="text-sm text-muted-foreground">Not reported.</p>
              ) : h.deadLetterQueue.length === 0 ? (
                <p className="text-sm text-muted-foreground">DLQ is empty.</p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Source</TH>
                      <TH>Unresolved</TH>
                      <TH>Critical</TH>
                      <TH>Oldest item</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {h.deadLetterQueue.map((d) => (
                      <TR key={d.source}>
                        <TD>{d.source}</TD>
                        <TD>{display(d.unresolved_count)}</TD>
                        <TD>{display(d.critical_count)}</TD>
                        <TD>{displayTs(d.oldest_item_at)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </div>
          </div>
        );
      }}
    </SectionCard>
  );
}

// ─── Timeline ────────────────────────────────────────────────────────────────

function TimelineSection({
  section,
}: {
  section: Section<CommandCenterTimelineResponse>;
}) {
  return (
    <SectionCard
      title="Operational Timeline"
      description="Recent hospital events from the timeline read (backend default window: last 24 hours)."
      section={section}
    >
      {(data) => {
        const events: TimelineEvent[] = data.timeline.events ?? [];
        if (events.length === 0) {
          return <p className="text-sm text-muted-foreground">No events in this window.</p>;
        }
        return (
          <Table>
            <THead>
              <TR>
                <TH>Time</TH>
                <TH>Category</TH>
                <TH>Event</TH>
                <TH>Severity</TH>
                <TH>Entity</TH>
                <TH>Detail</TH>
              </TR>
            </THead>
            <TBody>
              {events.map((e, i) => (
                <TR key={`${e.ts}-${e.event_type}-${i}`}>
                  <TD className="whitespace-nowrap">{displayTs(e.ts)}</TD>
                  <TD>{display(e.category)}</TD>
                  <TD>{display(e.event_type)}</TD>
                  <TD>
                    <Badge variant={SEVERITY_VARIANT[e.severity] ?? "secondary"}>
                      {display(e.severity)}
                    </Badge>
                  </TD>
                  <TD className="text-muted-foreground">{display(e.entity_type)}</TD>
                  <TD className="max-w-[16rem] truncate text-muted-foreground">
                    {/* Only a backend-supplied string message is shown;
                        metadata objects are never stringified into the UI. */}
                    {typeof e.metadata?.message === "string" ? e.metadata.message : "—"}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        );
      }}
    </SectionCard>
  );
}

// ─── Predictive ──────────────────────────────────────────────────────────────

function PredictiveSection({
  section,
}: {
  section: Section<CommandCenterPredictiveResponse>;
}) {
  return (
    <SectionCard
      title="Predictive Insights"
      description="Deterministic projections generated by the backend. The console adds no forecasting logic and makes no recommendations."
      section={section}
    >
      {(data) => {
        const p = data.predictions;
        return (
          <div className="space-y-4">
            {p.queue_predictions ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat label="Waiting now" value={display(p.queue_predictions.waiting_now)} />
                <Stat label="Completed now" value={display(p.queue_predictions.completed_now)} />
                <Stat
                  label="Predicted no-shows today"
                  value={display(p.queue_predictions.predicted_no_shows_today)}
                />
                <Stat
                  label="Avg consult time (min)"
                  value={display(p.queue_predictions.avg_consultation_minutes)}
                />
                <Stat
                  label="Predicted next wait (min)"
                  value={display(p.queue_predictions.predicted_wait_next_minutes)}
                />
                <Stat
                  label="Predicted queue exhaustion (min)"
                  value={display(p.queue_predictions.predicted_queue_exhaustion_minutes)}
                />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No queue predictions returned.</p>
            )}

            {p.financial_predictions ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat
                  label="Projected month revenue"
                  value={display(p.financial_predictions.projected_month_revenue)}
                />
                <Stat
                  label="Projected platform fees"
                  value={display(p.financial_predictions.projected_platform_fees)}
                />
                <Stat
                  label="30-day refund rate"
                  value={display(p.financial_predictions.refund_rate_30d)}
                />
                <Stat
                  label="Collection forecast (7d)"
                  value={display(p.financial_predictions.collection_forecast_next_7d)}
                />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No financial predictions returned.
              </p>
            )}
          </div>
        );
      }}
    </SectionCard>
  );
}
