import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/auth/AuthProvider";
import {
  fetchActingHospitalContext,
  type ActingHospitalContext,
} from "@/api/portfolio";
import {
  fetchFinancialOverview,
  fetchReconciliationSummary,
  fetchRevenueForecast,
} from "@/api/financial";
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
  FinancialCommandCenterData,
  ReconciliationSummaryRow,
  RevenueForecastData,
} from "@/types/api";

/**
 * Finance / Collections Read Surface (Phase 7 G-09) — a strictly READ-ONLY
 * hospital-admin / global-admin view over the EXISTING `financial-command-
 * center` Edge Function's three aggregate reads.
 *
 * The browser is a presentation layer only (§10). Nothing here sums
 * transactions, derives revenue, computes refunds/fees, reconciles a
 * difference, reconstructs a settlement or forecasts a projection — every
 * number on the page is a value the SQL layer already aggregated
 * server-side and the Edge Function returned verbatim. Currency formatting
 * (§12) is the ONE allowed transformation and it never combines two amounts.
 *
 * Truthfulness (§11/§14): a `0` renders as `0` (never `—`) and an absent
 * value renders as `—` (never a fabricated `0` or `₹0`); a failed read is an
 * error, never dressed up as an empty success. `display()` / `money()` use
 * explicit null checks, never `value || "—"`.
 *
 * Date model (§13) mirrors the backend exactly: `overview` and `forecast`
 * take ONE optional day; `reconciliation` takes an optional from/to window.
 * Inputs default EMPTY so the RPC's own `CURRENT_DATE` / trailing-30-day
 * defaults apply — the console never substitutes the browser's local day.
 *
 * Bounded network (§15): exactly one read cycle per action on an explicit
 * load, never on a keystroke, poll or interval; a manual Refresh performs one
 * bounded cycle, and a StrictMode remount cannot double-fire the initial load.
 *
 * Security (§14/§16): the user JWT + session `X-Hospital-ID` header go to the
 * Edge Function, which re-authorizes role + tenant before any service-role
 * RPC runs; a browser can never reach the financial RPCs directly. A
 * `global_admin` whose own account carries no tenant reuses the established
 * G-08 bounded acting-context header mechanism — invented nothing, and the
 * acting scope is disclosed rather than hidden.
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
 * Honest scalar rendering: a number stays a number (so `0` never becomes
 * `—`), NUMERIC may arrive as a string, and absence or a non-finite value
 * renders as an em dash rather than a fabricated figure. Explicit null checks
 * only — never `v || "—"` (§11).
 */
function display(v: number | string | boolean | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "—";
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : v;
}

/**
 * Deterministic Indian digit-grouping (last group of three, then pairs of two:
 * `125000` → `1,25,000`). Implemented in plain string ops rather than
 * `Intl.NumberFormat` so the rendered text is identical in every runtime
 * (jsdom/Node ICU data varies and would otherwise make the presentation
 * non-deterministic). It groups the SERVER value only — never re-derives it.
 */
function formatIndian(n: number): string {
  const negative = n < 0;
  const [intPart, fracPart] = Math.abs(n).toString().split(".");
  let grouped = intPart;
  if (intPart.length > 3) {
    const last3 = intPart.slice(-3);
    const rest = intPart.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
    grouped = `${rest},${last3}`;
  }
  const body = fracPart === undefined ? grouped : `${grouped}.${fracPart}`;
  return `${negative ? "-" : ""}${body}`;
}

/**
 * Presentation-only INR formatting (§12). A server amount is grouped for humans
 * (`₹1,25,000` for `125000`); `0` stays `₹0` and absence stays `—`. It NEVER
 * adds, subtracts or otherwise re-derives a business value.
 */
function money(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  return `₹${formatIndian(n)}`;
}

/** A labelled value tile. `raw` values are already formatted by the caller. */
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

export function AdminFinancial() {
  const { staff, hospitalId } = useAuth();
  const isGlobalAdmin = staff?.role === "global_admin";

  const [overview, setOverview] =
    useState<Section<FinancialCommandCenterData | null>>(IDLE);
  const [forecast, setForecast] =
    useState<Section<RevenueForecastData | null>>(IDLE);
  const [reconciliation, setReconciliation] =
    useState<Section<ReconciliationSummaryRow[] | null>>(IDLE);

  // Optional date overrides. EMPTY means "let the backend default apply";
  // they are read at load time (never trigger a fetch on keystroke, §15).
  const [overviewDate, setOverviewDate] = useState("");
  const [forecastDate, setForecastDate] = useState("");
  const [reconFrom, setReconFrom] = useState("");
  const [reconTo, setReconTo] = useState("");
  const datesRef = useRef({ overviewDate, forecastDate, reconFrom, reconTo });
  datesRef.current = { overviewDate, forecastDate, reconFrom, reconTo };

  const activeRef = useRef(true);
  const didInitialLoadRef = useRef(false);

  // The bounded acting context, resolved only when the account itself has no
  // tenant (the seeded `global_admin` reality) — the established G-08
  // mechanism, reused verbatim rather than re-invented (§16).
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
        else setActingError("No hospital exists to satisfy the required context.");
      })
      .catch((e) => {
        if (activeRef.current) setActingError(describeError(e));
      });
  }, [isGlobalAdmin, hospitalId]);

  const load = useCallback(async () => {
    if (!scopeHospitalId) return;
    const d = datesRef.current;
    setOverview(LOADING);
    setForecast(LOADING);
    setReconciliation(LOADING);

    // Three independent reads → three independent outcomes, one request each,
    // with absent dates OMITTED so the backend's own defaults apply (§13).
    const [rOverview, rForecast, rReconciliation] = await Promise.allSettled([
      fetchFinancialOverview(scopeHospitalId, {
        date: d.overviewDate || undefined,
      }),
      fetchRevenueForecast(scopeHospitalId, {
        date: d.forecastDate || undefined,
      }),
      fetchReconciliationSummary(scopeHospitalId, {
        fromDate: d.reconFrom || undefined,
        toDate: d.reconTo || undefined,
      }),
    ]);

    if (!activeRef.current) return;

    setOverview(
      rOverview.status === "fulfilled"
        ? succeeded(rOverview.value.financial)
        : failed(rOverview.reason),
    );
    setForecast(
      rForecast.status === "fulfilled"
        ? succeeded(rForecast.value.forecast)
        : failed(rForecast.reason),
    );
    setReconciliation(
      rReconciliation.status === "fulfilled"
        ? succeeded(rReconciliation.value.reconciliation)
        : failed(rReconciliation.reason),
    );
  }, [scopeHospitalId]);

  // Initial load happens once the scope is known — and, guarded by
  // didInitialLoadRef, at most once even across a StrictMode remount (§15).
  useEffect(() => {
    if (!scopeHospitalId || didInitialLoadRef.current) return;
    didInitialLoadRef.current = true;
    void load();
  }, [scopeHospitalId, load]);

  if (!scopeHospitalId) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Finance / Collections</h1>
        {actingError ? (
          <ErrorBanner message={actingError} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Waiting for the hospital context the financial service requires on
            every request. No financial data is shown.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Finance / Collections</h1>
          <p className="text-sm text-muted-foreground">
            Read-only view · {staff?.fullName} · every figure is aggregated
            server-side by the existing financial-command-center reads and
            rendered verbatim. Nothing here is computed or re-derived in the
            browser.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Request context sent as the required tenant header:{" "}
            <span className="font-mono">{scopeHospitalId}</span>
            {acting
              ? " — your account has no hospital of its own, so this one is used only to satisfy the header; the figures below are scoped to it."
              : " — taken from your session."}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={
            overview.status === "loading" ||
            forecast.status === "loading" ||
            reconciliation.status === "loading"
          }
          onClick={() => void load()}
        >
          Refresh
        </Button>
      </div>

      {/* Optional date controls. Empty = backend default; changes take effect
          on the next explicit Refresh, never automatically (§13/§15). */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-5">
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">
              Overview date
            </span>
            <Input
              type="date"
              value={overviewDate}
              onChange={(e) => setOverviewDate(e.target.value)}
              className="h-9 w-44"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">
              Forecast as-of date
            </span>
            <Input
              type="date"
              value={forecastDate}
              onChange={(e) => setForecastDate(e.target.value)}
              className="h-9 w-44"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">
              Reconciliation from
            </span>
            <Input
              type="date"
              value={reconFrom}
              onChange={(e) => setReconFrom(e.target.value)}
              className="h-9 w-44"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">
              Reconciliation to
            </span>
            <Input
              type="date"
              value={reconTo}
              onChange={(e) => setReconTo(e.target.value)}
              className="h-9 w-44"
            />
          </label>
          <p className="pb-2 text-xs text-muted-foreground">
            Leave a date empty to use the server default. Press Refresh to
            apply any change.
          </p>
        </CardContent>
      </Card>

      <OverviewCard section={overview} />
      <ForecastCard section={forecast} />
      <ReconciliationCard section={reconciliation} />
    </div>
  );
}

// ─── A. Financial overview ───────────────────────────────────────────────────

function OverviewCard({
  section,
}: {
  section: Section<FinancialCommandCenterData | null>;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle>Financial Overview</CardTitle>
          <Badge variant="outline" className="font-mono text-[10px]">
            overview
          </Badge>
        </div>
        <CardDescription>
          Daily collections, settlement intelligence and reconciliation for
          one hospital-day.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {section.status === "idle" ? (
          <p className="text-sm text-muted-foreground">Not loaded yet.</p>
        ) : section.status === "loading" ? (
          <p className="text-sm text-muted-foreground">Loading overview…</p>
        ) : section.status === "error" ? (
          <ErrorBanner message={section.error ?? "Request failed."} />
        ) : !section.data ? (
          <p className="text-sm text-muted-foreground">
            No financial overview data available.
          </p>
        ) : (
          <OverviewView data={section.data} />
        )}
      </CardContent>
    </Card>
  );
}

function OverviewView({ data }: { data: FinancialCommandCenterData }) {
  const dc = data.daily_collections;
  const si = data.settlement_intelligence;
  const aging = si.aging_buckets;
  const settlements = si.recent_settlements ?? [];
  return (
    <div className="space-y-5">
      <div className="text-xs text-muted-foreground">
        Date: <span className="font-mono">{display(data.date)}</span>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Daily Collections</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat label="Total collected" value={money(dc.total_collected)} />
          <Stat label="Net collections" value={money(dc.net_collections)} />
          <Stat label="Refunds" value={money(dc.refunds)} />
          <Stat label="Platform fee" value={money(dc.platform_fee)} />
          <Stat label="Hospital fee" value={money(dc.hospital_fee)} />
          <Stat label="Receptionist fee" value={money(dc.receptionist_fee)} />
          <Stat
            label="Online payments"
            value={display(dc.online_payments)}
          />
          <Stat
            label="Offline payments"
            value={display(dc.offline_payments)}
          />
          <Stat label="Pending payments" value={display(dc.pending_payments)} />
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Settlement Intelligence</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat
            label="Outstanding balance"
            value={money(si.outstanding_balance)}
          />
          <Stat label="Overdue count" value={display(si.overdue_count)} />
          <Stat label="Partial payments" value={display(si.partial_payments)} />
          <Stat
            label="Collection velocity (days)"
            value={display(si.collection_velocity_days)}
          />
          <Stat label="Aging · current" value={money(aging.current)} />
          <Stat
            label="Aging · 8–30 days"
            value={money(aging.overdue_8_30)}
          />
          <Stat
            label="Aging · 31+ days"
            value={money(aging.overdue_31_plus)}
          />
        </div>

        {si.recent_settlements === null ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No settlement records.
          </p>
        ) : settlements.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No recent settlements.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH>Start</TH>
                  <TH>End</TH>
                  <TH>Platform amount</TH>
                  <TH>Paid to SETURA</TH>
                  <TH>Remaining due</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {settlements.map((s) => (
                  <TR key={s.id}>
                    <TD className="align-top font-mono text-xs">
                      {display(s.settlement_start_date)}
                    </TD>
                    <TD className="align-top font-mono text-xs">
                      {display(s.settlement_end_date)}
                    </TD>
                    <TD className="align-top">
                      {money(s.total_platform_amount)}
                    </TD>
                    <TD className="align-top">
                      {money(s.amount_paid_to_setura)}
                    </TD>
                    <TD className="align-top">{money(s.remaining_due)}</TD>
                    <TD className="align-top">{display(s.settlement_status)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </div>

      {data.reconciliation ? (
        <div>
          <h3 className="mb-2 text-sm font-semibold">
            Reconciliation (embedded)
          </h3>
          <ReconciliationRowGrid row={data.reconciliation} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No reconciliation summary embedded for this date.
        </p>
      )}
    </div>
  );
}

// ─── B. Revenue forecast ─────────────────────────────────────────────────────

function ForecastCard({ section }: { section: Section<RevenueForecastData | null> }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle>Revenue Forecast</CardTitle>
          <Badge variant="outline" className="font-mono text-[10px]">
            forecast
          </Badge>
        </div>
        <CardDescription>
          Deterministic prorated projections computed server-side.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {section.status === "idle" ? (
          <p className="text-sm text-muted-foreground">Not loaded yet.</p>
        ) : section.status === "loading" ? (
          <p className="text-sm text-muted-foreground">Loading forecast…</p>
        ) : section.status === "error" ? (
          <ErrorBanner message={section.error ?? "Request failed."} />
        ) : !section.data ? (
          <p className="text-sm text-muted-foreground">
            No forecast data available.
          </p>
        ) : (
          <ForecastView data={section.data} />
        )}
      </CardContent>
    </Card>
  );
}

function ForecastView({ data }: { data: RevenueForecastData }) {
  return (
    <div className="space-y-4">
      <div className="text-xs text-muted-foreground">
        As of <span className="font-mono">{display(data.as_of)}</span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat
          label="Projected month revenue"
          value={money(data.projected_month_revenue)}
        />
        <Stat
          label="Projected platform fees"
          value={money(data.projected_platform_fees)}
        />
        <Stat
          label="Projected settlements"
          value={money(data.projected_settlements)}
        />
        <Stat label="Refund rate (30d)" value={display(data.refund_rate_30d)} />
        <Stat
          label="Refund impact forecast"
          value={money(data.refund_impact_forecast)}
        />
        <Stat
          label="Collection forecast (next 7d)"
          value={money(data.collection_forecast_next_7d)}
        />
      </div>
      <div>
        <h3 className="mb-2 text-sm font-semibold">Projection Inputs</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat label="MTD revenue" value={money(data.inputs.mtd_revenue)} />
          <Stat label="Days elapsed" value={display(data.inputs.days_elapsed)} />
          <Stat label="Days in month" value={display(data.inputs.days_in_month)} />
        </div>
      </div>
    </div>
  );
}

// ─── C. Reconciliation summary ───────────────────────────────────────────────

function ReconciliationCard({
  section,
}: {
  section: Section<ReconciliationSummaryRow[] | null>;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle>Collections → Ledger Reconciliation</CardTitle>
          <Badge variant="outline" className="font-mono text-[10px]">
            reconciliation
          </Badge>
        </div>
        <CardDescription>
          Server-computed reconciliation over the requested window (trailing 30
          days by default).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {section.status === "idle" ? (
          <p className="text-sm text-muted-foreground">Not loaded yet.</p>
        ) : section.status === "loading" ? (
          <p className="text-sm text-muted-foreground">
            Loading reconciliation…
          </p>
        ) : section.status === "error" ? (
          <ErrorBanner message={section.error ?? "Request failed."} />
        ) : !section.data || section.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No reconciliation rows for this window.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH>Total collected</TH>
                  <TH>Platform fee</TH>
                  <TH>Receptionist fee</TH>
                  <TH>Refunded</TH>
                  <TH>Settled</TH>
                  <TH>Net outstanding</TH>
                  <TH>Bookings</TH>
                  <TH>Paid bookings</TH>
                </TR>
              </THead>
              <TBody>
                {section.data.map((r, i) => (
                  <TR key={i}>
                    <TD className="align-top">{money(r.total_collected)}</TD>
                    <TD className="align-top">{money(r.platform_fee_total)}</TD>
                    <TD className="align-top">
                      {money(r.receptionist_fee_total)}
                    </TD>
                    <TD className="align-top">{money(r.total_refunded)}</TD>
                    <TD className="align-top">{money(r.total_settled)}</TD>
                    <TD className="align-top">{money(r.net_outstanding)}</TD>
                    <TD className="align-top">{display(r.booking_count)}</TD>
                    <TD className="align-top">
                      {display(r.paid_booking_count)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** The overview's embedded reconciliation row, rendered as labelled tiles. */
function ReconciliationRowGrid({ row }: { row: ReconciliationSummaryRow }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Stat label="Total collected" value={money(row.total_collected)} />
      <Stat label="Platform fee" value={money(row.platform_fee_total)} />
      <Stat label="Receptionist fee" value={money(row.receptionist_fee_total)} />
      <Stat label="Refunded" value={money(row.total_refunded)} />
      <Stat label="Settled" value={money(row.total_settled)} />
      <Stat label="Net outstanding" value={money(row.net_outstanding)} />
      <Stat label="Bookings" value={display(row.booking_count)} />
      <Stat label="Paid bookings" value={display(row.paid_booking_count)} />
    </div>
  );
}
