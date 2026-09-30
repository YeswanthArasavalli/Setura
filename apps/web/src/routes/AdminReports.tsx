import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@/auth/AuthProvider";
import { generateExecutiveReport } from "@/api/executiveReports";
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
  ExecutiveReportType,
  GenerateReportResponseBody,
  JsonValue,
} from "@/types/api";

/**
 * Executive / Operational Reports Viewer (Phase 7 G-06) — a strictly READ-ONLY
 * surface over the existing `enterprise-reports` `generate` action.
 *
 * Nothing here is computed: each card renders the exact JSONB the backend's
 * `generate_executive_report` returns, with no client-side business math
 * (revenue, SLA %, doctor scores, totals all come from the server). Report
 * shapes genuinely differ per type, so the payload is rendered structurally
 * from its real keys rather than forced into one invented table.
 *
 * Only the six approved NON-FINANCIAL report types are exposed. The standalone
 * `financial` / `settlement` report types are unreachable — the wrapper's
 * allow-list is the boundary (phase spec §4/§8/§38).
 *
 * Reports are generated ONLY on an explicit button press (never on mount,
 * keystroke or poll), each report keeps independent state so one failure
 * cannot crash the page or block another report, and tenant context comes from
 * the authenticated session header — the backend re-authorizes role + tenant
 * server-side and audits every generation as `executive_report`.
 */

type SectionStatus = "idle" | "loading" | "success" | "error";

interface Section {
  status: SectionStatus;
  data: GenerateReportResponseBody | null;
  error: string | null;
}

const IDLE: Section = { status: "idle", data: null, error: null };
const LOADING: Section = { status: "loading", data: null, error: null };

function failed(e: unknown): Section {
  return { status: "error", data: null, error: describeError(e) };
}

function succeeded(data: GenerateReportResponseBody): Section {
  return { status: "success", data, error: null };
}

/** Truthful label + backend-derived description for each approved report type.
 *  Descriptions name the ACTUAL top-level sections the report returns; nothing
 *  implies a capability the source does not provide (§12). */
const REPORT_META: Record<
  ExecutiveReportType,
  { label: string; description: string }
> = {
  daily_hospital: {
    label: "Daily Hospital",
    description:
      "Hospital-day operational rollup: patients, queues, SLA, finance aggregates and alert activity.",
  },
  weekly_operations: {
    label: "Weekly Operations",
    description:
      "Week operations rollup with incidents and per-doctor productivity.",
  },
  monthly_executive: {
    label: "Monthly Executive",
    description:
      "Month executive rollup with SLA trend and settlement rollup aggregates.",
  },
  doctor_performance: {
    label: "Doctor Performance",
    description:
      "Doctor rankings and utilization heatmap over the selected date range.",
  },
  sla: {
    label: "SLA",
    description:
      "SLA summary, hospitals in breach and the trailing 14-day trend.",
  },
  audit: {
    label: "Audit",
    description: "Audit coverage by action type over the selected date range.",
  },
};

const REPORT_ORDER: ExecutiveReportType[] = [
  "daily_hospital",
  "weekly_operations",
  "monthly_executive",
  "doctor_performance",
  "sla",
  "audit",
];

/** Local ISO date (browser timezone), matching the backend `YYYY-MM-DD` input. */
function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function initialSections(): Record<ExecutiveReportType, Section> {
  return REPORT_ORDER.reduce(
    (acc, rt) => {
      acc[rt] = IDLE;
      return acc;
    },
    {} as Record<ExecutiveReportType, Section>,
  );
}

export function AdminReports() {
  const { staff, hospitalId } = useAuth();

  // Shared date window (optional). Empty means “use the backend defaults” —
  // the console does not invent a range the RPC would not otherwise apply.
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState(todayIso);

  // Independent per-report state: report A failing never disturbs report B.
  const [sections, setSections] = useState(initialSections);

  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  // No mount-time generation: reports are produced only on an explicit click
  // (§25), which also sidesteps StrictMode double-fire and any request loop.
  const generate = (reportType: ExecutiveReportType) => {
    if (!hospitalId) return;
    setSections((prev) => ({ ...prev, [reportType]: LOADING }));
    generateExecutiveReport(hospitalId, reportType, {
      fromDate: fromDate || undefined,
      toDate: toDate || undefined,
    })
      .then((d) =>
        activeRef.current
          ? setSections((prev) => ({ ...prev, [reportType]: succeeded(d) }))
          : undefined,
      )
      .catch((e) =>
        activeRef.current
          ? setSections((prev) => ({ ...prev, [reportType]: failed(e) }))
          : undefined,
      );
  };

  if (!hospitalId) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Executive &amp; Operational Reports</h1>
        {/* Truthful no-tenant state (spec §20/§30): the seeded global admin has
            hospital_id = null and `generate_executive_report` requires a tenant,
            so no report data is fabricated. */}
        <p className="text-sm text-muted-foreground">
          No hospital tenant is attached to your account, so there are no
          hospital-scoped reports to generate. Reports require a hospital
          context.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">
          Executive &amp; Operational Reports
        </h1>
        <p className="text-sm text-muted-foreground">
          Read-only executive reports · {staff?.fullName} · tenant{" "}
          <span className="font-mono">{hospitalId}</span>. Generated by the
          existing enterprise-reports engine (every generation is audited
          server-side). Financial and settlement report types are not exposed.
        </p>
      </div>

      {/* ── Shared date window (report-specific inputs per the contract) ── */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-5">
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">From date</span>
            <Input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="h-9 w-44"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">To date</span>
            <Input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="h-9 w-44"
            />
          </label>
          <p className="pb-2 text-xs text-muted-foreground">
            Leave &ldquo;From date&rdquo; empty to use the backend default
            window. Each report is generated only when you press its button.
          </p>
        </CardContent>
      </Card>

      {/* ── The six approved report types ───────────────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-2">
        {REPORT_ORDER.map((rt) => (
          <ReportCard
            key={rt}
            reportType={rt}
            section={sections[rt]}
            onGenerate={() => generate(rt)}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Report card shell ───────────────────────────────────────────────────────

function ReportCard({
  reportType,
  section,
  onGenerate,
}: {
  reportType: ExecutiveReportType;
  section: Section;
  onGenerate: () => void;
}) {
  const meta = REPORT_META[reportType];
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle>{meta.label}</CardTitle>
          <Badge variant="outline" className="font-mono text-[10px]">
            {reportType}
          </Badge>
        </div>
        <CardDescription>{meta.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button
          size="sm"
          disabled={section.status === "loading"}
          onClick={onGenerate}
        >
          {section.status === "loading" ? "Generating…" : "Generate report"}
        </Button>

        {section.status === "idle" ? (
          <p className="text-sm text-muted-foreground">Not generated yet.</p>
        ) : section.status === "loading" ? (
          <p className="text-sm text-muted-foreground">Generating…</p>
        ) : section.status === "error" ? (
          // Honest failure: an error is never dressed up as “no data”.
          <p
            role="alert"
            className="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
          >
            {section.error}
          </p>
        ) : (
          <ReportResult data={section.data} />
        )}
      </CardContent>
    </Card>
  );
}

function ReportResult({ data }: { data: GenerateReportResponseBody | null }) {
  const report = data?.report;
  if (!report) {
    return <p className="text-sm text-muted-foreground">No data.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          Range: <span className="font-mono">{report.from_date}</span> →{" "}
          <span className="font-mono">{report.to_date}</span>
        </span>
        <span>
          Generated: <span className="font-mono">{displayTs(report.generated_at)}</span>
        </span>
      </div>
      <ReportDataView data={report.data} />
    </div>
  );
}

// ─── Structured, backend-faithful renderer ───────────────────────────────────
// The report `data` object is dynamic JSONB whose keys are the real backend
// sections (named by `report.columns`). Rendering walks THOSE keys instead of
// imposing a fabricated uniform schema (§7/§17).

function ReportDataView({ data }: { data: Record<string, JsonValue> }) {
  const entries = Object.entries(data ?? {});
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">No data.</p>;
  }
  return (
    <div className="space-y-4">
      {entries.map(([key, value]) => (
        <div key={key} className="rounded-md border border-border p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {humanize(key)}
          </div>
          <ValueNode value={value} />
        </div>
      ))}
    </div>
  );
}

function ValueNode({ value }: { value: JsonValue }): ReactNode {
  if (value === null) {
    return <span className="text-muted-foreground">—</span>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-muted-foreground">No data</span>;
    }
    // A homogeneous array of records is the one case a table honestly fits:
    // the columns are the rows' OWN keys, taken from the backend, not invented.
    const allRecords = value.every((v) => isRecord(v));
    if (allRecords) {
      return <RecordTable rows={value as Record<string, JsonValue>[]}></RecordTable>;
    }
    return (
      <ul className="list-disc space-y-1 pl-5">
        {value.map((v, i) => (
          <li key={i}>
            <ValueNode value={v} />
          </li>
        ))}
      </ul>
    );
  }

  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return <span className="text-muted-foreground">No data</span>;
    }
    return (
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
        {entries.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-3">
            <dt className="text-xs text-muted-foreground">{humanize(k)}</dt>
            <dd className="text-right text-sm">
              <ValueNode value={v} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  return <span>{formatScalar(value)}</span>;
}

function RecordTable({ rows }: { rows: Record<string, JsonValue>[] }) {
  // Column set is derived from the actual keys present across the returned
  // rows — never a fixed, assumed schema.
  const columns = Array.from(
    new Set(rows.flatMap((r) => Object.keys(r))),
  );
  return (
    <div className="overflow-x-auto">
      <Table>
        <THead>
          <TR>
            {columns.map((c) => (
              <TH key={c}>{humanize(c)}</TH>
            ))}
          </TR>
        </THead>
        <TBody>
          {rows.map((row, i) => (
            <TR key={i}>
              {columns.map((c) => (
                <TD key={c} className="align-top">
                  <Cell value={row[c]} />
                </TD>
              ))}
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

/** A table cell: scalars render truthfully; a nested object/array falls back
 *  to a compact JSON string rather than being flattened into a false value. */
function Cell({ value }: { value: JsonValue | undefined }) {
  if (value === undefined || value === null) {
    return <span className="text-muted-foreground">—</span>;
  }
  if (typeof value === "object") {
    return (
      <span className="font-mono text-xs text-muted-foreground">
        {JSON.stringify(value)}
      </span>
    );
  }
  return <span>{formatScalar(value)}</span>;
}

/**
 * Truthful scalar formatting (§16). A number stays a number — 0 renders as
 * “0”, never as “—”. Non-finite numbers and absence render as an honest dash,
 * never a fabricated value.
 */
function formatScalar(v: string | number | boolean): string {
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "—";
  if (typeof v === "boolean") return v ? "true" : "false";
  return v === "" ? "—" : v;
}

function displayTs(ts: string | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

function isRecord(v: JsonValue | undefined): v is Record<string, JsonValue> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Readable label for a snake_case backend key; the raw key stays visible in
 *  the type badge, so this only formats for humans and never renames meaning. */
function humanize(key: string): string {
  return key.replace(/_/g, " ");
}
