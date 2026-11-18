import { type MetricCol, parseColumns } from "./columns";
import { ReportError } from "./errors";
import { type Cell, type Kind, normalizeKey, percentChange, pythonStr, pythonSum, toNumber } from "./numbers";

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
export const GENERIC: Segment = {
  key: "generic",
  label: "Generic Search (searchnb) overall",
  short: "Generic overall",
};
export const SEGMENTS: readonly Segment[] = [POST_L, PRE_VERTICAL, PRE_CAMPUS, GENERIC];

const GENERIC_MARKER = "searchnb";
const EXCLUDED_MARKERS = ["aurora", "ssm", "cindma", "slcdma", "nsh"];
const HEADER_SCAN_LIMIT = 60;
const CAMPAIGN_HEADERS = ["campaign", "campaignname"];
const VOLUME_HEADERS = ["clicks", "impr", "impressions"];

export function segmentOf(campaignName: string): Segment | null {
  const name = campaignName.toLowerCase();
  if (!name.includes(GENERIC_MARKER) || EXCLUDED_MARKERS.some((marker) => name.includes(marker))) return null;
  if (name.includes("post")) return POST_L;
  if (name.includes("dma")) return PRE_CAMPUS;
  return PRE_VERTICAL;
}

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

export type Sheet = [name: string | null, rows: Cell[][]];

export interface ResultRow {
  label: string;
  kind: Kind;
  cur: number | null;
  prev: number | null;
  change: number | null;
}

type Period = "cur" | "prev";

export function missingCompared(report: Report): string[] {
  const hasCompared = (index: number) => report.metrics[index].prev !== null;
  return report.metrics
    .filter((m) => m.prev === null && !(m.derived && hasCompared(m.derived[0]) && hasCompared(m.derived[1])))
    .map((m) => m.label);
}

export function segmentRows(report: Report, segment: Segment): number[] {
  return report.rows.flatMap((row, index) =>
    row.segment !== null && (segment === GENERIC || row.segment === segment) ? [index] : [],
  );
}

function cellAt(values: Cell[], column: number | null): Cell {
  return column !== null && column < values.length ? values[column] : null;
}

function isBlank(value: Cell): boolean {
  return value === null || value === "";
}

function findHeader(rows: Cell[][]): { headerRow: number; campaignCol: number | null } | null {
  for (let i = 0; i < Math.min(rows.length, HEADER_SCAN_LIMIT); i++) {
    const keys = rows[i].map((c) => normalizeKey(c));
    if (keys.includes("cost") && VOLUME_HEADERS.some((h) => keys.includes(h))) {
      const campaignCol = keys.findIndex((k) => CAMPAIGN_HEADERS.includes(k));
      return { headerRow: i, campaignCol: campaignCol === -1 ? null : campaignCol };
    }
  }
  return null;
}

function isTotalRow(values: Cell[], campaignCol: number | null): boolean {
  const firstFilled = values.find((v) => !isBlank(v));
  const firstText = firstFilled === undefined ? "" : pythonStr(firstFilled).trim();
  return normalizeKey(firstText).startsWith("total") || normalizeKey(cellAt(values, campaignCol)).startsWith("total");
}

function dataRows(rows: Cell[][], headerRow: number, campaignCol: number | null) {
  const result: { rowNumber: number; values: Cell[] }[] = [];
  for (let i = headerRow + 1; i < rows.length; i++) {
    const values = rows[i];
    if (values.every(isBlank) || isTotalRow(values, campaignCol)) continue;
    result.push({ rowNumber: i + 1, values });
  }
  return result;
}

function metricColumns(metrics: MetricCol[]): number[] {
  return metrics.flatMap((m) => [m.cur, m.prev]).filter((c): c is number => c !== null);
}

function campaignName(values: Cell[], campaignCol: number | null): string {
  const raw = cellAt(values, campaignCol);
  return isBlank(raw) ? "" : pythonStr(raw).trim();
}

function reportFromSheet(fileName: string, [sheetName, rows]: Sheet): Report | null {
  const header = findHeader(rows);
  if (!header) return null;
  const { headerRow, campaignCol } = header;

  const candidates = dataRows(rows, headerRow, campaignCol);
  const headerCells = [...rows[headerRow]];
  const { metrics, skipped } = parseColumns(
    headerCells,
    candidates.map((c) => c.values),
    campaignCol,
  );
  const columns = metricColumns(metrics);

  const reportRows = candidates
    .filter(({ values }) => columns.some((c) => toNumber(cellAt(values, c)) !== null))
    .map(({ rowNumber, values }) => {
      const name = campaignName(values, campaignCol);
      return { name: name || `(row ${rowNumber})`, values, segment: name ? segmentOf(name) : null };
    });

  return { fileName, sheet: sheetName, header: headerCells, campaignCol, metrics, skipped, rows: reportRows };
}

export function buildReport(fileName: string, sheets: Sheet[]): Report {
  for (const sheet of sheets) {
    const report = reportFromSheet(fileName, sheet);
    if (report) return report;
  }
  throw new ReportError("not-an-export", "Could not find a header row with Cost and Clicks/Impr. columns.");
}

function periodTotals(metrics: MetricCol[], rows: Row[], period: Period): (number | null)[] {
  const totals = metrics.map((): number | null => null);
  if (!rows.length) return totals;

  metrics.forEach((metric, index) => {
    const column = metric[period];
    if (metric.derived || column === null) return;
    const values = rows.map((r) => toNumber(cellAt(r.values, column))).filter((x): x is number => x !== null);
    totals[index] = pythonSum(values);
  });

  metrics.forEach((metric, index) => {
    if (!metric.derived) return;
    const [numerator, denominator, factor] = metric.derived;
    const top = totals[numerator];
    const bottom = totals[denominator];
    const column = metric[period];
    if (top !== null && bottom !== null) {
      totals[index] = bottom ? (top / bottom) * factor : null;
    } else if (rows.length === 1 && column !== null) {
      totals[index] = toNumber(cellAt(rows[0].values, column));
    }
  });

  return totals;
}

export function aggregate(report: Report, rowIndices: number[]): ResultRow[] {
  const rows = rowIndices.map((i) => report.rows[i]);
  const current = periodTotals(report.metrics, rows, "cur");
  const previous = periodTotals(report.metrics, rows, "prev");
  return report.metrics.map((metric, index) => ({
    label: metric.label,
    kind: metric.kind,
    cur: current[index],
    prev: previous[index],
    change: percentChange(current[index], previous[index]),
  }));
}
