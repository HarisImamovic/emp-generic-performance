import { ReportError } from "./errors";
import type { Cell } from "./numbers";
import { type Report, type Sheet, buildReport } from "./report";

const CSV_EXTENSIONS = [".csv", ".tsv", ".txt"];
const EXCEL_EXTENSIONS = [".xlsx", ".xlsm"];
const SNIFF_SAMPLE_LENGTH = 50000;
const SNIFF_CHUNK_LINES = 10;
const SNIFF_MIN_CONSISTENCY = 0.9;
const CANDIDATE_DELIMITERS = [",", ";", "\t"];
const PREFERRED_DELIMITERS = [",", "\t", ";", " ", ":"];
const FALLBACK_DELIMITER_ORDER = ["\t", ";", ","];
const BYTES_UNDEFINED_IN_CP1252 = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);
const LATIN1_DECODE_CHUNK = 8192;

function decodeLatin1(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += LATIN1_DECODE_CHUNK) {
    text += String.fromCharCode(...bytes.subarray(i, i + LATIN1_DECODE_CHUNK));
  }
  return text;
}

export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const isLatin1 = bytes.some((b) => BYTES_UNDEFINED_IN_CP1252.has(b));
    return isLatin1 ? decodeLatin1(bytes) : new TextDecoder("windows-1252").decode(bytes);
  }
}

function countOccurrences(text: string, character: string): number {
  return text.split(character).length - 1;
}

function mostFrequentKey<K>(counts: Map<K, number>): K | undefined {
  let best: K | undefined;
  let bestCount = -Infinity;
  for (const [key, count] of counts) {
    if (count > bestCount) [best, bestCount] = [key, count];
  }
  return best;
}

function delimiterNextToQuotes(sample: string): string | null {
  const delimiter = String.raw`[^\p{L}\p{N}_\n"']`;
  const patterns = [
    String.raw`(?<delim>${delimiter})(?<space> ?)(?<quote>["']).*?\k<quote>\k<delim>`,
    String.raw`(?:^|\n)(?<quote>["']).*?\k<quote>(?<delim>${delimiter})(?<space> ?)`,
    String.raw`(?<delim>${delimiter})(?<space> ?)(?<quote>["']).*?\k<quote>(?:$|\n)`,
    String.raw`(?:^|\n)(?<quote>["']).*?\k<quote>(?:$|\n)`,
  ];
  for (const pattern of patterns) {
    const matches = [...sample.matchAll(new RegExp(pattern, "gsmu"))];
    if (!matches.length) continue;
    const counts = new Map<string, number>();
    for (const match of matches) {
      const found = match.groups?.delim;
      if (found && CANDIDATE_DELIMITERS.includes(found)) counts.set(found, (counts.get(found) ?? 0) + 1);
    }
    return mostFrequentKey(counts) ?? null;
  }
  return null;
}

function modeWithMargin(frequencies: Map<number, number>): [count: number, margin: number] {
  const entries = [...frequencies];
  const mode = entries.reduce((best, entry) => (entry[1] > best[1] ? entry : best));
  const others = entries.filter((entry) => entry !== mode).reduce((sum, [, lines]) => sum + lines, 0);
  return [mode[0], mode[1] - others];
}

function delimiterByConsistency(sample: string): string | null {
  const lines = sample.split("\n").filter(Boolean);
  const chunkSize = Math.min(SNIFF_CHUNK_LINES, lines.length);
  const frequencies = new Map(CANDIDATE_DELIMITERS.map((d) => [d, new Map<number, number>()]));
  const consistent = new Map<string, [number, number]>();

  for (let chunk = 1, start = 0; start < lines.length; chunk++, start += chunkSize) {
    for (const line of lines.slice(start, start + chunkSize)) {
      for (const [delimiter, perCount] of frequencies) {
        const count = countOccurrences(line, delimiter);
        perCount.set(count, (perCount.get(count) ?? 0) + 1);
      }
    }

    const modes = new Map<string, [number, number]>();
    for (const [delimiter, perCount] of frequencies) {
      const neverPresent = perCount.size === 1 && perCount.has(0);
      if (!neverPresent) modes.set(delimiter, modeWithMargin(perCount));
    }

    const linesSeen = Math.min(chunkSize * chunk, lines.length);
    for (let threshold = 1; consistent.size === 0 && threshold >= SNIFF_MIN_CONSISTENCY; threshold -= 0.01) {
      for (const [delimiter, [count, margin]] of modes) {
        if (count > 0 && margin > 0 && margin / linesSeen >= threshold) consistent.set(delimiter, [count, margin]);
      }
    }
    if (consistent.size === 1) return [...consistent.keys()][0];
  }

  return PREFERRED_DELIMITERS.find((d) => consistent.has(d)) ?? null;
}

function mostCommonDelimiter(sample: string): string {
  return FALLBACK_DELIMITER_ORDER.reduce((best, d) =>
    countOccurrences(sample, d) > countOccurrences(sample, best) ? d : best,
  );
}

export function sniffDelimiter(sample: string): string {
  return delimiterNextToQuotes(sample) ?? delimiterByConsistency(sample) ?? mostCommonDelimiter(sample);
}

export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let quotedFieldClosed = false;
  let recordStarted = false;

  const finishField = () => {
    row.push(field);
    field = "";
    quotedFieldClosed = false;
  };
  const finishRecord = () => {
    if (recordStarted || field) {
      finishField();
      rows.push(row);
    } else {
      rows.push([]);
    }
    row = [];
    field = "";
    quotedFieldClosed = false;
    recordStarted = false;
  };

  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (inQuotes) {
      if (character !== '"') {
        field += character;
      } else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = false;
        quotedFieldClosed = true;
      }
    } else if (character === delimiter) {
      finishField();
      recordStarted = true;
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && text[i + 1] === "\n") i++;
      finishRecord();
    } else if (character === '"' && field === "" && !quotedFieldClosed) {
      inQuotes = true;
      recordStarted = true;
    } else {
      field += character;
      recordStarted = true;
    }
  }
  if (recordStarted || field) finishRecord();
  return rows;
}

export function readCsvRows(bytes: Uint8Array): string[][] {
  const text = decodeText(bytes);
  return parseCsv(text, sniffDelimiter(text.slice(0, SNIFF_SAMPLE_LENGTH)));
}

const twoDigits = (n: number) => String(n).padStart(2, "0");

function pythonDateTime(date: Date): string {
  const day = `${date.getUTCFullYear()}-${twoDigits(date.getUTCMonth() + 1)}-${twoDigits(date.getUTCDate())}`;
  const time = `${twoDigits(date.getUTCHours())}:${twoDigits(date.getUTCMinutes())}:${twoDigits(date.getUTCSeconds())}`;
  return `${day} ${time}`;
}

function cachedCellValue(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return pythonDateTime(value);
  if (typeof value !== "object") return String(value);

  const cell = value as Record<string, unknown>;
  if ("formula" in cell || "sharedFormula" in cell) return cachedCellValue(cell.result);
  if (Array.isArray(cell.richText)) return (cell.richText as { text: string }[]).map((part) => part.text).join("");
  if ("hyperlink" in cell) return cachedCellValue(cell.text);
  if ("error" in cell) return String(cell.error);
  if ("text" in cell) return cachedCellValue(cell.text);
  return String(value);
}

export async function readXlsxSheets(data: ArrayBuffer): Promise<Sheet[]> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(data);
  } catch (cause) {
    throw new ReportError("unreadable-file", `Could not open the Excel file: ${String(cause)}`);
  }
  return workbook.worksheets.map((worksheet): Sheet => {
    const rows: Cell[][] = [];
    for (let r = 1; r <= worksheet.rowCount; r++) {
      const values = worksheet.getRow(r).values as unknown[];
      rows.push(Array.from(values.slice(1), (value) => cachedCellValue(value)));
    }
    return [worksheet.name, rows];
  });
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot).toLowerCase();
}

export async function loadReport(fileName: string, data: ArrayBuffer): Promise<Report> {
  const extension = extensionOf(fileName);
  if (CSV_EXTENSIONS.includes(extension)) {
    return buildReport(fileName, [[null, readCsvRows(new Uint8Array(data))]]);
  }
  if (EXCEL_EXTENSIONS.includes(extension)) {
    return buildReport(fileName, await readXlsxSheets(data));
  }
  if (extension === ".xls") {
    throw new ReportError("legacy-xls", "Old .xls format is not supported.");
  }
  throw new ReportError("unsupported-file", `Unsupported file type: ${extension || "(none)"}`);
}
