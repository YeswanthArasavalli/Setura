/**
 * reporting.ts — Executive report formatting helpers.
 *
 * Reports are produced as structured JSONB by the SQL reporting
 * engine (generate_executive_report). This module renders that
 * structure into the three supported delivery formats:
 *
 *   - json:      pass-through (default API contract)
 *   - csv:       deterministic flattening into key/value rows, or
 *                tabular rows when the report carries a `rows`
 *                array
 *   - pdf_ready: sectioned structure a renderer can paginate
 *                (title, meta, sections) — no binary generation
 *                at the edge
 *
 * No business logic lives here: numbers always come from the SQL
 * layer.
 */

type Flat = Record<string, unknown>;

function isPlainObject(v: unknown): v is Flat {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Flattens nested objects into dot-separated keys (depth-first). */
export function flattenObject(
  obj: Flat,
  prefix = "",
): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];

  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (isPlainObject(value)) {
      out.push(...flattenObject(value, path));
    } else if (Array.isArray(value)) {
      out.push([path, JSON.stringify(value)]);
    } else {
      out.push([path, value]);
    }
  }

  return out;
}

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(s)) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

/**
 * Renders a report payload as CSV. If `data.rows` exists and is an
 * array of objects, it becomes a proper table; otherwise the report
 * is flattened into key,value rows.
 */
export function reportToCsv(report: Flat): string {
  const data = isPlainObject(report.data) ? report.data : {};
  const rows = Array.isArray(data.rows) ? data.rows : null;

  if (rows && rows.length > 0 && rows.every((r) => isPlainObject(r))) {
    const columns = Array.from(
      rows.reduce<Set<string>>((acc, r) => {
        for (const k of Object.keys(r as Flat)) acc.add(k);
        return acc;
      }, new Set()),
    );

    const lines = [columns.map(csvEscape).join(",")];

    for (const row of rows) {
      const r = row as Flat;
      lines.push(columns.map((c) => csvEscape(r[c])).join(","));
    }

    return lines.join("\n");
  }

  const flat = flattenObject(data);
  const lines = ["key,value"];

  for (const [k, v] of flat) {
    lines.push(`${csvEscape(k)},${csvEscape(v)}`);
  }

  return lines.join("\n");
}

/** Renders a report payload as a PDF-ready sectioned structure. */
export function reportToPdfReady(report: Flat): Flat {
  const data = isPlainObject(report.data) ? report.data : {};

  const sections = Object.entries(data).map(([heading, content]) => ({
    heading,
    content: isPlainObject(content) || Array.isArray(content)
      ? content
      : { value: content },
  }));

  return {
    title: `SETURA ${String(report.report_type ?? "report")} report`,
    hospitalId: report.hospital_id ?? null,
    fromDate: report.from_date ?? null,
    toDate: report.to_date ?? null,
    generatedAt: report.generated_at ?? new Date().toISOString(),
    format: "pdf_ready",
    sections,
  };
}
