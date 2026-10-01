import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/auth/AuthProvider";
import {
  fetchActingHospitalContext,
  type ActingHospitalContext,
} from "@/api/portfolio";
import { fetchAlertAnalytics, fetchAlertCenter } from "@/api/alertCenter";
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
import { Input } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type {
  AlertAnalyticsData,
  AlertCenterData,
  AlertEventRow,
  AlertSeverity,
} from "@/types/api";

/**
 * Alert-Center Read Surface (Phase 7 G-10) — a strictly READ-ONLY hospital-admin
 * / global-admin view over the EXISTING `alert-center` Edge Function's two
 * aggregate reads (`list` and `analytics`).
 *
 * The browser is a presentation layer only (§16). Nothing here counts alerts,
 * groups them by key, derives a resolution rate, computes a severity percentage
 * or reconstructs a trend — every figure on the page is a value the SQL layer
 * already aggregated server-side (`get_alert_center` / `get_alert_analytics`)
 * and the Edge Function returned verbatim. The `counts` block and the analytics
 * `summary` are the SERVER's tallies, never `alerts.length` (§16).
 *
 * Lifecycle mutations are intentionally absent (§3/§19): there are NO
 * Acknowledge / Assign / Resolve / Escalate / Suppress controls (not even
 * disabled ones). This page is Alert Center — Read Only. The only per-row value
 * shown is derived from the server's own `is_resolved` boolean (a label, not a
 * business calculation).
 *
 * Truthfulness (§13/§18): a `0` renders as `0` (never `—`) and an absent value
 * renders as `—` (never a fabricated `0`); an HTTP failure is an error, never
 * dressed up as an empty success; a legitimately empty `alerts` array shows
 * "No alerts found." rather than invented rows. `display()` uses explicit null
 * checks, never `value || "—"`.
 *
 * Bounded network (§30): exactly one read cycle per action on an explicit load,
 * never on a keystroke, poll or interval; a manual Refresh performs one bounded
 * cycle, and a StrictMode remount cannot double-fire the initial load.
 *
 * Security (§20/§29): the user JWT + session `X-Hospital-ID` header go to the
 * Edge Function, which re-authorizes role + tenant before any service-role RPC
 * runs; a browser can never reach the alert RPCs directly. A `global_admin`
 * whose own account carries no tenant reuses the established G-08 bounded
 * acting-context header mechanism — inventing nothing, and the acting scope is
 * disclosed rather than hidden.
 */

type SectionStatus = "idle" | "loading" | "success" | "error";

interface Section<T> {
  status: SectionStatus;
  data: T | null;
  error: string | null;
}

const IDLE: Section<never> = { status: "idle", data: null, error: null };
const LOADING: Section<never> = { status: "loading", data: null, error: null };

function failed(e: unknown): Section<never> {
  return { status: "error", data: null, error: describeError(e) };
}

function succeeded<T>(data: T): Section<T> {
  return { status: "success", data, error: null };
}

/**
 * Honest scalar rendering: a number stays a number (so `0` never becomes `—`),
 * NUMERIC may arrive as a string, and absence or a non-finite value renders as
 * an em dash rather than a fabricated figure. Explicit null checks only —
 * never `v || "—"` (§13/§18).
 */
function display(v: number | string | boolean | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "—";
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : v;
}

// Presentation-only severity → badge colour (a real Badge variant, not a
// computed value). It never re-derives anything from the alert data.
const SEVERITY_TONE: Record<
  AlertSeverity,
  "secondary" | "warning" | "destructive"
> = {
  info: "secondary",
  warning: "warning",
  critical: "destructive",
};

/** A labelled value tile. `value` is already a display string from the caller. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
    >
      {message}
    </p>
  );
}

export function AdminAlerts() {
  const { staff, hospitalId } = useAuth();
  const isGlobalAdmin = staff?.role === "global_admin";

  const [center, setCenter] = useState<Section<AlertCenterData | null>>(IDLE);
  const [analytics, setAnalytics] =
    useState<Section<AlertAnalyticsData | null>>(IDLE);

  // Optional filter / window overrides. EMPTY means "let the backend default
  // apply"; they are read at load time (never trigger a fetch on change, §30).
  const [status, setStatus] = useState("");
  const [severity, setSeverity] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const filtersRef = useRef({ status, severity, fromDate, toDate });
  filtersRef.current = { status, severity, fromDate, toDate };

  const activeRef = useRef(true);
  const didInitialLoadRef = useRef(false);

  // The bounded acting context, resolved only when the account itself has no
  // tenant (the seeded `global_admin` reality) — the established G-08
  // mechanism, reused verbatim rather than re-invented (§20).
  const [acting, setActing] = useState<ActingHospitalContext | null>(null);
  const [actingError, setActingError] = useState<string | null>(null);
  const actingAttemptedRef = useRef(false);
  const scopeHospitalId = hospitalId ?? acting?.hospitalId ?? null;

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isGlobalAdmin || hospitalId || actingAttemptedRef.current) return;
    actingAttemptedRef.current = true;
    fetchActingHospitalContext()
      .then((ctx) => {
        if (!activeRef.current) return;
        if (ctx) setActing(ctx);
        else {
          setActingError(
            "No hospital exists to satisfy the required context.",
          );
        }
      })
      .catch((e) => {
        if (activeRef.current) setActingError(describeError(e));
      });
  }, [isGlobalAdmin, hospitalId]);

  const load = useCallback(async () => {
    if (!scopeHospitalId) return;
    const f = filtersRef.current;
    setCenter(LOADING);
    setAnalytics(LOADING);

    // Two independent reads → two independent outcomes, one request each, with
    // absent filters/dates OMITTED so the backend's own defaults apply (§17).
    const [rCenter, rAnalytics] = await Promise.allSettled([
      fetchAlertCenter(scopeHospitalId, {
        status: (f.status || undefined) as
          | "open"
          | "all"
          | "resolved"
          | undefined,
        severity: (f.severity || undefined) as
          | "info"
          | "warning"
          | "critical"
          | undefined,
      }),
      fetchAlertAnalytics(scopeHospitalId, {
        fromDate: f.fromDate || undefined,
        toDate: f.toDate || undefined,
      }),
    ]);

    if (!activeRef.current) return;

    setCenter(
      rCenter.status === "fulfilled"
        ? succeeded(rCenter.value.center)
        : failed(rCenter.reason),
    );
    setAnalytics(
      rAnalytics.status === "fulfilled"
        ? succeeded(rAnalytics.value.analytics)
        : failed(rAnalytics.reason),
    );
  }, [scopeHospitalId]);

  // Initial load happens once the scope is known — and, guarded by
  // didInitialLoadRef, at most once even across a StrictMode remount (§30).
  useEffect(() => {
    if (!scopeHospitalId || didInitialLoadRef.current) return;
    didInitialLoadRef.current = true;
    void load();
  }, [scopeHospitalId, load]);

  if (!scopeHospitalId) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Alert Center</h1>
        {actingError ? (
          <ErrorBanner message={actingError} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Waiting for the hospital context the alert service requires on every
            request. No alerts are shown.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">
            Alert Center <span className="text-sm font-normal text-muted-foreground">— Read Only</span>
          </h1>
          <p className="text-sm text-muted-foreground">
            Read-only view · {staff?.fullName} · every alert row and statistic
            is aggregated server-side by the existing alert-center reads and
            rendered verbatim. Nothing here is counted, grouped or re-derived in
            the browser, and no alert can be acknowledged, assigned, resolved,
            escalated or suppressed from this page.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Request context sent as the required tenant header:{" "}
            <span className="font-mono">{scopeHospitalId}</span>
            {acting
              ? " — your account has no hospital of its own, so this one is used only to satisfy the header; the alerts below are scoped to it."
              : " — taken from your session."}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={
            center.status === "loading" || analytics.status === "loading"
          }
          onClick={() => void load()}
        >
          Refresh
        </Button>
      </div>

      {/* Optional filters + window. Empty = backend default; changes take effect
          on the next explicit Refresh, never automatically (§17/§30). */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-5">
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">
              Alert status
            </span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="h-9 w-40 rounded-md border border-border bg-background px-2 text-sm"
            >
              <option value="">Default (open)</option>
              <option value="open">Open</option>
              <option value="all">All</option>
              <option value="resolved">Resolved</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">
              Severity
            </span>
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value)}
              className="h-9 w-40 rounded-md border border-border bg-background px-2 text-sm"
            >
              <option value="">All severities</option>
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">
              Analytics from
            </span>
            <Input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="h-9 w-44"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">
              Analytics to
            </span>
            <Input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="h-9 w-44"
            />
          </label>
          <p className="pb-2 text-xs text-muted-foreground">
            Leave a control empty to use the server default. Press Refresh to
            apply any change.
          </p>
        </CardContent>
      </Card>

      <AlertListCard section={center} />
      <AnalyticsCard section={analytics} />
    </div>
  );
}

// ─── A. Alert list ───────────────────────────────────────────────────────────

function AlertListCard({ section }: { section: Section<AlertCenterData | null> }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle>Alert Inbox</CardTitle>
          <Badge variant="outline" className="font-mono text-[10px]">
            list
          </Badge>
        </div>
        <CardDescription>
          The alert-center snapshot with server-computed whole-tenant counts.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {section.status === "idle" ? (
          <p className="text-sm text-muted-foreground">Not loaded yet.</p>
        ) : section.status === "loading" ? (
          <p className="text-sm text-muted-foreground">Loading alerts…</p>
        ) : section.status === "error" ? (
          <ErrorBanner message={section.error ?? "Request failed."} />
        ) : !section.data ? (
          <p className="text-sm text-muted-foreground">
            No alert data available.
          </p>
        ) : (
          <AlertListView data={section.data} />
        )}
      </CardContent>
    </Card>
  );
}

function AlertListView({ data }: { data: AlertCenterData }) {
  const alerts = data.alerts ?? [];
  const counts = data.counts;
  return (
    <div className="space-y-5">
      {/* Server counts, never `alerts.length` (§16). */}
      <div>
        <h3 className="mb-2 text-sm font-semibold">Alert Counts (tenant-wide)</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Stat label="Open" value={display(counts.open)} />
          <Stat label="Acknowledged" value={display(counts.acknowledged)} />
          <Stat label="Escalated" value={display(counts.escalated)} />
          <Stat label="Critical open" value={display(counts.critical_open)} />
        </div>
      </div>

      {alerts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No alerts found.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>Severity</TH>
                <TH>Key</TH>
                <TH>Category</TH>
                <TH>Message</TH>
                <TH>Status</TH>
                <TH>Created</TH>
              </TR>
            </THead>
            <TBody>
              {alerts.map((a) => (
                <AlertRow key={a.id} alert={a} />
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function AlertRow({ alert }: { alert: AlertEventRow }) {
  const tone = SEVERITY_TONE[alert.severity] ?? "secondary";
  // A label over the server's own boolean — presentation, not a calculation.
  const state = alert.is_resolved ? "resolved" : "open";
  return (
    <TR>
      <TD className="align-top">
        <Badge variant={tone}>
          {alert.severity}
        </Badge>
      </TD>
      <TD className="align-top font-mono text-xs">{display(alert.alert_key)}</TD>
      <TD className="align-top">{display(alert.alert_category)}</TD>
      <TD className="align-top">{alert.message}</TD>
      <TD className="align-top">{state}</TD>
      <TD className="align-top font-mono text-xs">{display(alert.created_at)}</TD>
    </TR>
  );
}

// ─── B. Analytics ────────────────────────────────────────────────────────────

function AnalyticsCard({
  section,
}: {
  section: Section<AlertAnalyticsData | null>;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle>Alert Analytics</CardTitle>
          <Badge variant="outline" className="font-mono text-[10px]">
            analytics
          </Badge>
        </div>
        <CardDescription>
          Volume and resolution statistics computed server-side (trailing 30
          days by default).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {section.status === "idle" ? (
          <p className="text-sm text-muted-foreground">Not loaded yet.</p>
        ) : section.status === "loading" ? (
          <p className="text-sm text-muted-foreground">Loading analytics…</p>
        ) : section.status === "error" ? (
          <ErrorBanner message={section.error ?? "Request failed."} />
        ) : !section.data ? (
          <p className="text-sm text-muted-foreground">
            No analytics available.
          </p>
        ) : (
          <AnalyticsView data={section.data} />
        )}
      </CardContent>
    </Card>
  );
}

function AnalyticsView({ data }: { data: AlertAnalyticsData }) {
  const byKey = data.by_alert_key ?? [];
  return (
    <div className="space-y-5">
      <div>
        <h3 className="mb-2 text-sm font-semibold">Summary</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat label="Total" value={display(data.summary.total)} />
          <Stat label="Resolved" value={display(data.summary.resolved)} />
          <Stat
            label="Avg resolution (min)"
            value={display(data.summary.avg_resolution_minutes)}
          />
        </div>
      </div>

      {byKey.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No alerts in this window.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>Alert key</TH>
                <TH>Total</TH>
                <TH>Resolved</TH>
                <TH>Avg resolution (min)</TH>
              </TR>
            </THead>
            <TBody>
              {byKey.map((k) => (
                <TR key={k.alert_key}>
                  <TD className="align-top font-mono text-xs">
                    {display(k.alert_key)}
                  </TD>
                  <TD className="align-top">{display(k.total)}</TD>
                  <TD className="align-top">{display(k.resolved)}</TD>
                  <TD className="align-top">
                    {display(k.avg_resolution_minutes)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </div>
  );
}
