import { type Kind, formatValue } from "./numbers";
import type { Report, ResultRow, Segment } from "./report";

export type Layout = "side" | "stacked";

export interface CopyOptions {
  decimalSeparator: string;
  withLabels: boolean;
  withChange: boolean;
  withHeader: boolean;
}

const TAB = "\t";
const NEWLINE = "\n";
const PERIOD_HEADERS = ["Current", "Compared"];
const CHANGE_HEADER = "Change %";
const EXCEL_FORMATS: Record<Kind, string> = { money: "#,##0.00", int: "#,##0", num: "#,##0.##", pct: "0.00%" };
const CHANGE_FORMAT = "0.00%";
const SUMMARY_COLUMN_WIDTH = 15;
const LABEL_COLUMN_MIN_WIDTH = 20;
const LABEL_COLUMN_MAX_WIDTH = 60;
const COLUMNS_PER_SEGMENT = 3;

function valueHeaders(options: CopyOptions): string[] {
  return options.withChange ? [...PERIOD_HEADERS, CHANGE_HEADER] : PERIOD_HEADERS;
}

function valueCells(row: ResultRow, options: CopyOptions): string[] {
  const thousands = row.kind === "money";
  const cells = [
    formatValue(row.cur, row.kind, options.decimalSeparator, thousands),
    formatValue(row.prev, row.kind, options.decimalSeparator, thousands),
  ];
  if (options.withChange) cells.push(formatValue(row.change, "pct", options.decimalSeparator));
  return cells;
}

const FORMULA_START = /^[=+\-@]/;
const CELL_BREAKS = /[\t\r\n]/g;

export function excelSafeText(text: string): string {
  const oneCell = text.replace(CELL_BREAKS, " ");
  return FORMULA_START.test(oneCell) ? `'${oneCell}` : oneCell;
}

function labelCell(text: string, options: CopyOptions): string[] {
  return options.withLabels ? [excelSafeText(text)] : [];
}

export function buildClipboardText(results: ResultRow[], options: CopyOptions): string {
  const lines = results.map((row) => [...labelCell(row.label, options), ...valueCells(row, options)].join(TAB));
  if (options.withHeader) lines.unshift([...labelCell("Metric", options), ...valueHeaders(options)].join(TAB));
  return lines.join(NEWLINE);
}

function stackedText(blocks: [string, ResultRow[]][], options: CopyOptions): string {
  return blocks
    .map(([name, results]) => {
      const table = buildClipboardText(results, options);
      return options.withHeader ? `${name}${NEWLINE}${table}` : table;
    })
    .join(NEWLINE + NEWLINE);
}

function sideBySideText(blocks: [string, ResultRow[]][], options: CopyOptions): string {
  const lines = blocks[0][1].map((first, index) =>
    [...labelCell(first.label, options), ...blocks.flatMap(([, results]) => valueCells(results[index], options))].join(
      TAB,
    ),
  );
  if (options.withHeader) {
    const headers = blocks.flatMap(([name]) => valueHeaders(options).map((h) => `${name} - ${h}`));
    lines.unshift([...labelCell("Metric", options), ...headers].join(TAB));
  }
  return lines.join(NEWLINE);
}

export function buildAllSegmentsText(blocks: [string, ResultRow[]][], options: CopyOptions, layout: Layout): string {
  return layout === "stacked" ? stackedText(blocks, options) : sideBySideText(blocks, options);
}

export async function exportXlsx(
  report: Report,
  blocks: [Segment, ResultRow[]][],
  excluded: ReadonlySet<number>,
): Promise<ArrayBuffer> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const bold = { bold: true };

  const summary = workbook.addWorksheet("Summary", { views: [{ state: "frozen", xSplit: 1, ySplit: 2 }] });
  Object.assign(summary.getCell(2, 1), { value: "Metric", font: bold });

  blocks.forEach(([segment, results], blockIndex) => {
    const firstColumn = 2 + blockIndex * COLUMNS_PER_SEGMENT;
    Object.assign(summary.getCell(1, firstColumn), {
      value: segment.label,
      font: bold,
      alignment: { horizontal: "center" },
    });
    summary.mergeCells(1, firstColumn, 1, firstColumn + COLUMNS_PER_SEGMENT - 1);

    [...PERIOD_HEADERS, CHANGE_HEADER].forEach((text, offset) => {
      Object.assign(summary.getCell(2, firstColumn + offset), { value: text, font: bold });
      summary.getColumn(firstColumn + offset).width = SUMMARY_COLUMN_WIDTH;
    });

    results.forEach((row, metricIndex) => {
      const cells: [number | null, string][] = [
        [row.cur, EXCEL_FORMATS[row.kind]],
        [row.prev, EXCEL_FORMATS[row.kind]],
        [row.change, CHANGE_FORMAT],
      ];
      cells.forEach(([value, numFmt], offset) => {
        Object.assign(summary.getCell(3 + metricIndex, firstColumn + offset), { value, numFmt });
      });
    });
  });

  const labels = (blocks[0]?.[1] ?? []).map((row) => row.label);
  labels.forEach((label, index) => {
    summary.getCell(3 + index, 1).value = label;
  });
  const longestLabel = labels.length ? Math.max(...labels.map((label) => label.length)) : LABEL_COLUMN_MIN_WIDTH;
  summary.getColumn(1).width = Math.max(LABEL_COLUMN_MIN_WIDTH, Math.min(LABEL_COLUMN_MAX_WIDTH, longestLabel + 2));

  const campaigns = workbook.addWorksheet("Campaigns");
  campaigns.addRow(["Source file", report.fileName]);
  if (report.skipped.length) campaigns.addRow(["Columns skipped", report.skipped.join(", ")]);
  campaigns.addRow([]);
  campaigns.addRow(["Campaign", "Segment", "Included"]).font = bold;
  report.rows.forEach((row, index) => {
    if (row.segment) campaigns.addRow([row.name, row.segment.label, excluded.has(index) ? "No" : "Yes"]);
  });
  report.rows.forEach((row) => {
    if (!row.segment) campaigns.addRow([row.name, "(not in Generic)"]);
  });
  campaigns.getColumn(1).width = 60;
  campaigns.getColumn(2).width = 42;

  return (await workbook.xlsx.writeBuffer()) as ArrayBuffer;
}
