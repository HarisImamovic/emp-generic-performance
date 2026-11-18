// Clipboard text and Excel export.
// Port of build_clipboard_text / build_all_segments_text / export_xlsx in desktop/generic_performance.py.
import { fmtValue } from "./numbers";
import { type Report, type ResultRow, type Segment } from "./report";

export type Layout = "side" | "stacked";

export interface CopyOptions {
  decSep: string;
  withLabels: boolean;
  withChange: boolean;
  withHeader: boolean;
}

function valueCells(r: ResultRow, decSep: string, withChange: boolean): string[] {
  const cells = [
    fmtValue(r.cur, r.kind, decSep, r.kind === "money"),
    fmtValue(r.prev, r.kind, decSep, r.kind === "money"),
  ];
  if (withChange) cells.push(fmtValue(r.change, "pct", decSep));
  return cells;
}

export function buildClipboardText(results: ResultRow[], o: CopyOptions): string {
  const lines: string[] = [];
  if (o.withHeader) {
    const cols = [...(o.withLabels ? ["Metric"] : []), "Current", "Compared", ...(o.withChange ? ["Change %"] : [])];
    lines.push(cols.join("\t"));
  }
  for (const r of results) {
    lines.push([...(o.withLabels ? [r.label] : []), ...valueCells(r, o.decSep, o.withChange)].join("\t"));
  }
  return lines.join("\n");
}

export function buildAllSegmentsText(blocks: [string, ResultRow[]][], o: CopyOptions, layout: Layout): string {
  if (layout === "stacked") {
    return blocks
      .map(([name, results]) => {
        const text = buildClipboardText(results, o);
        return o.withHeader ? `${name}\n${text}` : text;
      })
      .join("\n\n");
  }
  const cols = ["Current", "Compared", ...(o.withChange ? ["Change %"] : [])];
  const lines: string[] = [];
  if (o.withHeader) {
    lines.push(
      [...(o.withLabels ? ["Metric"] : []), ...blocks.flatMap(([name]) => cols.map((c) => `${name} - ${c}`))].join(
        "\t",
      ),
    );
  }
  blocks[0][1].forEach((first, k) => {
    const cells = o.withLabels ? [first.label] : [];
    for (const [, results] of blocks) cells.push(...valueCells(results[k], o.decSep, o.withChange));
    lines.push(cells.join("\t"));
  });
  return lines.join("\n");
}

const XL_FORMATS = { money: "#,##0.00", int: "#,##0", num: "#,##0.##", pct: "0.00%" } as const;

/** The Summary + Campaigns workbook, as .xlsx bytes. */
export async function exportXlsx(
  report: Report,
  blocks: [Segment, ResultRow[]][],
  excluded: Set<number>,
): Promise<ArrayBuffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Summary", { views: [{ state: "frozen", xSplit: 1, ySplit: 2 }] });
  const bold = { bold: true };

  const head = ws.getCell(2, 1);
  head.value = "Metric";
  head.font = bold;
  blocks.forEach(([seg], s) => {
    const c0 = 2 + s * 3;
    const top = ws.getCell(1, c0);
    top.value = seg.label;
    top.font = bold;
    top.alignment = { horizontal: "center" };
    ws.mergeCells(1, c0, 1, c0 + 2);
    ["Current", "Compared", "Change %"].forEach((text, o) => {
      const c = ws.getCell(2, c0 + o);
      c.value = text;
      c.font = bold;
      ws.getColumn(c0 + o).width = 15;
    });
  });
  report.metrics.forEach((m, k) => {
    const row = 3 + k;
    ws.getCell(row, 1).value = m.label;
    blocks.forEach(([, results], s) => {
      const r = results[k];
      const c0 = 2 + s * 3;
      const cells: [number | null, string][] = [
        [r.cur, XL_FORMATS[r.kind]],
        [r.prev, XL_FORMATS[r.kind]],
        [r.change, "0.00%"],
      ];
      cells.forEach(([v, f], o) => {
        const c = ws.getCell(row, c0 + o);
        c.value = v;
        c.numFmt = f;
      });
    });
  });
  const longest = report.metrics.length ? Math.max(...report.metrics.map((m) => m.label.length)) : 20;
  ws.getColumn(1).width = Math.max(20, Math.min(60, longest + 2));

  const info = wb.addWorksheet("Campaigns");
  info.addRow(["Source file", report.fileName]);
  if (report.skipped.length) info.addRow(["Columns skipped", report.skipped.join(", ")]);
  info.addRow([]);
  info.addRow(["Campaign", "Segment", "Included"]).font = bold;
  report.rows.forEach((r, i) => {
    if (r.segment) info.addRow([r.name, r.segment.label, excluded.has(i) ? "No" : "Yes"]);
  });
  report.rows.forEach((r) => {
    if (!r.segment) info.addRow([r.name, "(not in Generic)"]);
  });
  info.getColumn(1).width = 60;
  info.getColumn(2).width = 42;
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}
