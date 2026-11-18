// Segments, report loading and aggregation.
// Port of segment_of / load_report / aggregate in desktop/generic_performance.py.
import { type MetricCol, parseColumns } from "./columns";
import { type Cell, type Kind, norm, pctChange, pyStr, pySum, toNumber } from "./numbers";

// ---- segments ----------------------------------------------------------------
// Mirrors the SA360 CASE rules:
//   searchnb + post            -> BAU | Post-L | Generic Search
//   searchnb + dma, no post    -> BAU | Pre-L | Generic Search | Campus
//   searchnb, no dma, no post  -> BAU | Pre-L | Generic Search | Vertical
// and every rule excludes aurora / ssm / cindma / slcdma / nsh.
// "Generic overall" is the union of the three.

export type SegmentKey = "post" | "vertical" | "campus" | "generic";

export interface Segment {
  key: SegmentKey;
  label: string;
  short: string;
}

export const POST_L: Segment = { key: "post", label: "BAU | Post-L | Generic Search", short: "Post-L" };
export const PRE_VERTICAL: Segment = {
  key: "vertical",
  label: "BAU | Pre-L | Generic Search | Vertical",
  short: "Pre-L Vertical",
};
export const PRE_CAMPUS: Segment = {
  key: "campus",
  label: "BAU | Pre-L | Generic Search | Campus",
  short: "Pre-L Campus",
};
export const GENERIC: Segment = { key: "generic", label: "Generic Search (searchnb) overall", short: "Generic overall" };
export const SEGMENTS: readonly Segment[] = [POST_L, PRE_VERTICAL, PRE_CAMPUS, GENERIC];

const GENERIC_EXCLUDE = ["aurora", "ssm", "cindma", "slcdma", "nsh"];

/** The single base segment a campaign belongs to (never GENERIC), or null. */
export function segmentOf(name: string): Segment | null {
  const n = name.toLowerCase();
  if (!n.includes("searchnb") || GENERIC_EXCLUDE.some((x) => n.includes(x))) return null;
  if (n.includes("post")) return POST_L;
  if (n.includes("dma")) return PRE_CAMPUS;
  return PRE_VERTICAL;
}

// ---- report ------------------------------------------------------------------

export interface Row {
  name: string;
  values: Cell[];
  segment: Segment | null;
}

export interface Report {
  fileName: string;
  sheet: string | null;
  header: Cell[];
  campaignCol: number | null;
  metrics: MetricCol[];
  skipped: string[];
  rows: Row[];
}

export function missingCompared(report: Report): string[] {
  const out: string[] = [];
  for (const m of report.metrics) {
    if (m.prev !== null) continue;
    if (m.derived && m.derived.slice(0, 2).every((d) => report.metrics[d].prev !== null)) continue;
    out.push(m.label);
  }
  return out;
}

export function segmentRows(report: Report, seg: Segment): number[] {
  const out: number[] = [];
  report.rows.forEach((r, i) => {
    if (r.segment !== null && (seg === GENERIC || r.segment === seg)) out.push(i);
  });
  return out;
}

const cell = (values: Cell[], idx: number | null): Cell =>
  idx !== null && idx < values.length ? values[idx] : null;

const isBlank = (v: Cell) => v === null || v === "";

function findHeader(rows: Cell[][], maxScan = 60): [number, number | null] | null {
  for (let i = 0; i < Math.min(rows.length, maxScan); i++) {
    const norms = rows[i].map((c) => norm(c));
    if (norms.includes("cost") && ["clicks", "impr", "impressions"].some((x) => norms.includes(x))) {
      const cc = norms.findIndex((n) => n === "campaign" || n === "campaignname");
      return [i, cc === -1 ? null : cc];
    }
  }
  return null;
}

/** Build a report from the sheets of a file (one sheet for CSV). */
export function buildReport(fileName: string, sheets: [string | null, Cell[][]][]): Report {
  for (const [sheetName, rows] of sheets) {
    const found = findHeader(rows);
    if (!found) continue;
    const [hdrIdx, campaignCol] = found;
    const candidates: [number, Cell[]][] = [];
    for (let i = hdrIdx + 1; i < rows.length; i++) {
      const values = rows[i];
      const n = i + 1; // 1-based file row number
      if (!values.some((v) => !isBlank(v))) continue;
      const firstNonBlank = values.find((v) => !isBlank(v));
      const firstText = firstNonBlank === undefined ? "" : pyStr(firstNonBlank).trim();
      const name = cell(values, campaignCol);
      if (norm(firstText).startsWith("total") || norm(name).startsWith("total")) continue;
      candidates.push([n, values]);
    }

    const header = [...rows[hdrIdx]];
    const { metrics, skipped } = parseColumns(
      header,
      candidates.map(([, v]) => v),
      campaignCol,
    );
    const cols = new Set<number>();
    for (const m of metrics) for (const c of [m.cur, m.prev]) if (c !== null) cols.add(c);
    const data: Row[] = [];
    for (const [n, values] of candidates) {
      if ([...cols].every((c) => toNumber(cell(values, c)) === null)) continue;
      const raw = cell(values, campaignCol);
      const name = isBlank(raw) ? "" : pyStr(raw).trim();
      data.push({ name: name || `(row ${n})`, values, segment: name ? segmentOf(name) : null });
    }
    return { fileName, sheet: sheetName, header, campaignCol, metrics, skipped, rows: data };
  }
  throw new Error(
    "Could not find a header row with Cost and Clicks/Impr. columns.\nMake sure the export contains those columns.",
  );
}

// ---- aggregation ---------------------------------------------------------------

export interface ResultRow {
  label: string;
  kind: Kind;
  cur: number | null;
  prev: number | null;
  change: number | null;
}

export function aggregate(report: Report, rowIndices: number[]): ResultRow[] {
  const rows = rowIndices.map((i) => report.rows[i]);
  const totals: Record<"cur" | "prev", (number | null)[]> = { cur: [], prev: [] };
  for (const period of ["cur", "prev"] as const) {
    const vals: (number | null)[] = report.metrics.map(() => null);
    report.metrics.forEach((m, k) => {
      const col = m[period];
      if (m.derived || col === null || !rows.length) return;
      const xs: number[] = [];
      for (const r of rows) {
        const x = toNumber(cell(r.values, col));
        if (x !== null) xs.push(x);
      }
      vals[k] = pySum(xs);
    });
    report.metrics.forEach((m, k) => {
      if (!m.derived || !rows.length) return;
      const [a, b, factor] = m.derived;
      const col = m[period];
      const va = vals[a];
      const vb = vals[b];
      if (va !== null && vb !== null) {
        vals[k] = vb ? (va / vb) * factor : null;
      } else if (rows.length === 1 && col !== null) {
        vals[k] = toNumber(cell(rows[0].values, col));
      }
    });
    totals[period] = vals;
  }
  return report.metrics.map((m, k) => ({
    label: m.label,
    kind: m.kind,
    cur: totals.cur[k],
    prev: totals.prev[k],
    change: pctChange(totals.cur[k], totals.prev[k]),
  }));
}
