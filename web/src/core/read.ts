// Reading SA360 exports (.csv / .tsv / .txt / .xlsx / .xlsm) in the browser.
// Port of _read_csv_rows / _read_xlsx_sheets / load_report in desktop/generic_performance.py.
// Files are read in memory only; nothing is uploaded or stored.
import type { Cell } from "./numbers";
import { type Report, buildReport } from "./report";

// ---- text decoding --------------------------------------------------------------

const CP1252_UNDEFINED = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);

export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes); // strips a UTF-8 BOM
  } catch {
    // Python tries cp1252, then latin-1 when cp1252 hits an undefined byte.
    if (bytes.some((b) => CP1252_UNDEFINED.has(b))) {
      let s = "";
      for (let i = 0; i < bytes.length; i += 8192) {
        s += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }
      return s;
    }
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

// ---- delimiter detection (Python csv.Sniffer with delimiters=",;\t") ----------------

const DELIMS = [",", ";", "\t"];
const PREFERRED = [",", "\t", ";", " ", ":"];

function countOf(s: string, ch: string): number {
  let n = 0;
  for (let i = s.indexOf(ch); i !== -1; i = s.indexOf(ch, i + 1)) n++;
  return n;
}

function firstMax<K>(m: Map<K, number>): K {
  let best: K | undefined;
  let bestV = -Infinity;
  for (const [k, v] of m) if (v > bestV) [best, bestV] = [k, v];
  return best as K;
}

function guessQuoteAndDelimiter(data: string): string {
  const W = String.raw`[^\p{L}\p{N}_\n"']`;
  const patterns = [
    String.raw`(?<delim>${W})(?<space> ?)(?<quote>["']).*?\k<quote>\k<delim>`,
    String.raw`(?:^|\n)(?<quote>["']).*?\k<quote>(?<delim>${W})(?<space> ?)`,
    String.raw`(?<delim>${W})(?<space> ?)(?<quote>["']).*?\k<quote>(?:$|\n)`,
    String.raw`(?:^|\n)(?<quote>["']).*?\k<quote>(?:$|\n)`,
  ];
  for (const p of patterns) {
    const matches = [...data.matchAll(new RegExp(p, "gsmu"))];
    if (!matches.length) continue;
    const delims = new Map<string, number>();
    for (const m of matches) {
      const d = m.groups?.delim;
      if (d && DELIMS.includes(d)) delims.set(d, (delims.get(d) ?? 0) + 1);
    }
    return delims.size ? firstMax(delims) : "";
  }
  return "";
}

function guessDelimiter(sample: string): string {
  const data = sample.split("\n").filter((l) => l);
  const chunkLength = Math.min(10, data.length);
  const charFrequency = new Map<string, Map<number, number>>();
  const delims = new Map<string, [number, number]>();
  let iteration = 0;
  let start = 0;
  let end = chunkLength;
  while (start < data.length) {
    iteration++;
    for (const line of data.slice(start, end)) {
      for (const ch of DELIMS) {
        const meta = charFrequency.get(ch) ?? new Map<number, number>();
        const freq = countOf(line, ch);
        meta.set(freq, (meta.get(freq) ?? 0) + 1);
        charFrequency.set(ch, meta);
      }
    }
    const modes = new Map<string, [number, number]>();
    for (const [ch, meta] of charFrequency) {
      const items = [...meta.entries()];
      if (items.length === 1 && items[0][0] === 0) continue;
      if (items.length > 1) {
        let mode = items[0];
        for (const it of items) if (it[1] > mode[1]) mode = it;
        const rest = items.filter((it) => it !== mode).reduce((s, it) => s + it[1], 0);
        modes.set(ch, [mode[0], mode[1] - rest]);
      } else {
        modes.set(ch, items[0]);
      }
    }
    const total = Math.min(chunkLength * iteration, data.length);
    let consistency = 1.0;
    while (delims.size === 0 && consistency >= 0.9) {
      for (const [k, v] of modes) {
        if (v[0] > 0 && v[1] > 0 && v[1] / total >= consistency) delims.set(k, v);
      }
      consistency -= 0.01;
    }
    if (delims.size === 1) return [...delims.keys()][0];
    start = end;
    end += chunkLength;
  }
  if (!delims.size) return "";
  for (const d of PREFERRED) if (delims.has(d)) return d;
  return "";
}

export function sniffDelimiter(sample: string): string {
  const d = guessQuoteAndDelimiter(sample) || guessDelimiter(sample);
  if (d) return d;
  // csv.Error fallback in the desktop app: most frequent of tab, semicolon, comma
  let best = "\t";
  for (const c of ["\t", ";", ","]) if (countOf(sample, c) > countOf(sample, best)) best = c;
  return best;
}

// ---- CSV parsing (Python csv.reader, default dialect) ----------------------------------

export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let afterQuote = false; // a quoted field just closed; later quotes are literal
  let started = false; // current record has content
  const endField = () => {
    row.push(field);
    field = "";
    afterQuote = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        field += c;
      }
    } else if (c === delimiter) {
      endField();
      started = true;
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (started || field) {
        endField();
        rows.push(row);
      } else {
        rows.push([]);
      }
      row = [];
      field = "";
      afterQuote = false;
      started = false;
    } else if (c === '"' && field === "" && !afterQuote) {
      inQuotes = true;
      started = true;
    } else {
      field += c;
      started = true;
    }
  }
  if (started || field) {
    endField();
    rows.push(row);
  }
  return rows;
}

export function readCsvRows(bytes: Uint8Array): string[][] {
  const text = decodeText(bytes);
  return parseCsv(text, sniffDelimiter(text.slice(0, 50000)));
}

// ---- Excel ----------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");

/** Python's str(datetime) for a date cell, so text checks behave the same. */
function pyDate(d: Date): string {
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/** ExcelJS cell value -> the cached value openpyxl returns with data_only=True. */
function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Date) return pyDate(v);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("formula" in o || "sharedFormula" in o) return toCell(o.result);
    if ("richText" in o && Array.isArray(o.richText)) {
      return (o.richText as { text: string }[]).map((t) => t.text).join("");
    }
    if ("hyperlink" in o) return toCell(o.text);
    if ("error" in o) return String(o.error);
    if ("text" in o) return toCell(o.text);
  }
  return String(v);
}

export async function readXlsxSheets(data: ArrayBuffer): Promise<[string, Cell[][]][]> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data);
  return wb.worksheets.map((ws) => {
    const rows: Cell[][] = [];
    for (let r = 1; r <= ws.rowCount; r++) {
      const values = ws.getRow(r).values as unknown[]; // 1-based, sparse
      const out: Cell[] = [];
      for (let c = 1; c < values.length; c++) out.push(toCell(values[c]));
      rows.push(out);
    }
    return [ws.name, rows] as [string, Cell[][]];
  });
}

// ---- entry point ------------------------------------------------------------------

export async function loadReport(fileName: string, data: ArrayBuffer): Promise<Report> {
  const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")).toLowerCase() : "";
  let sheets: [string | null, Cell[][]][];
  if ([".csv", ".tsv", ".txt"].includes(ext)) {
    sheets = [[null, readCsvRows(new Uint8Array(data))]];
  } else if ([".xlsx", ".xlsm"].includes(ext)) {
    sheets = await readXlsxSheets(data);
  } else if (ext === ".xls") {
    throw new Error("Old .xls format is not supported. Export from SA360 as .xlsx or .csv.");
  } else {
    throw new Error(`Unsupported file type: ${ext || "(none)"}`);
  }
  return buildReport(fileName, sheets);
}
