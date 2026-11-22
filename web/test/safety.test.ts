import { describe, expect, it } from "vitest";
import { ReportError } from "../src/core/errors";
import { buildAllSegmentsText, buildClipboardText, excelSafeText } from "../src/core/output";
import { ACCEPTED_EXTENSIONS, MAX_FILE_MB, checkFileSize, loadReport } from "../src/core/read";
import { aggregate } from "../src/core/report";

const COPY_OPTIONS = { decimalSeparator: ".", withLabels: true, withChange: false, withHeader: false };
const encode = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const MB = 1024 * 1024;

describe("pasting copied labels into Excel", () => {
  it("turns formula-like labels into text", () => {
    expect(excelSafeText('=HYPERLINK("http://x","y")')).toBe(`'=HYPERLINK("http://x","y")`);
    expect(excelSafeText("+1")).toBe("'+1");
    expect(excelSafeText("-Cost")).toBe("'-Cost");
    expect(excelSafeText("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("leaves normal labels alone", () => {
    for (const label of ["Cost", "Leads / Clicks", "Cost - net", "CTR", ""]) expect(excelSafeText(label)).toBe(label);
  });

  it("keeps a label in one cell", () => {
    expect(excelSafeText("a\tb\r\nc")).toBe("a b  c");
  });

  it("copies a malicious column header as text", async () => {
    const csv = 'Campaign,Cost,Clicks,"=HYPERLINK(""http://evil"",""x"")"\nUS_SearchNB_PostL_Generic,1,2,3\n';
    const report = await loadReport("evil.csv", encode(csv));
    const results = aggregate(report, [0]);
    const copied = [
      buildClipboardText(results, COPY_OPTIONS),
      buildAllSegmentsText([["A", results]], COPY_OPTIONS, "side"),
      buildAllSegmentsText([["A", results]], COPY_OPTIONS, "stacked"),
    ];
    for (const text of copied) {
      const cells = text.split("\n").flatMap((line) => line.split("\t"));
      expect(cells.filter((cell) => /^[=+@]/.test(cell))).toEqual([]);
      expect(cells).toContain(`'=HYPERLINK("http://evil","x")`);
    }
  });
});

async function loadError(name: string, data: ArrayBuffer): Promise<string | undefined> {
  try {
    await loadReport(name, data);
    return undefined;
  } catch (error) {
    return (error as ReportError).code;
  }
}

describe("accepted file types", () => {
  const csv = "Campaign,Cost,Clicks\nUS_SearchNB_PostL_Generic,1,2\n";

  it("accepts .xlsx and .csv only", () => {
    expect(ACCEPTED_EXTENSIONS).toEqual([".xlsx", ".csv"]);
  });

  it("opens a real csv, including a capitalised extension", async () => {
    expect(await loadError("export.csv", encode(csv))).toBeUndefined();
    expect(await loadError("EXPORT.CSV", encode(csv))).toBeUndefined();
  });

  it("refuses every other extension", async () => {
    for (const name of ["export.xlsm", "export.tsv", "export.txt", "export.exe", "export.html", "export"]) {
      expect(await loadError(name, encode(csv)), name).toBe("unsupported-file");
    }
    expect(await loadError("export.xls", encode(csv))).toBe("legacy-xls");
  });

  it("refuses a binary file renamed to .csv", async () => {
    const binary = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]).buffer;
    expect(await loadError("export.csv", binary)).toBe("unsupported-file");
  });

  it("refuses a text file renamed to .xlsx", async () => {
    expect(await loadError("export.xlsx", encode(csv))).toBe("unreadable-file");
  });

  it("still opens a UTF-16 csv", async () => {
    const utf16 = new Uint8Array([0xff, 0xfe, ...Array.from(csv).flatMap((c) => [c.charCodeAt(0), 0])]);
    expect(await loadError("export.csv", utf16.buffer)).toBeUndefined();
  });
});

describe("file size limit", () => {
  it("accepts files up to the limit", () => {
    expect(() => checkFileSize(MAX_FILE_MB * MB)).not.toThrow();
  });

  it("rejects larger files", () => {
    expect(() => checkFileSize(MAX_FILE_MB * MB + 1)).toThrow(ReportError);
    try {
      checkFileSize(250 * MB);
    } catch (error) {
      expect((error as ReportError).code).toBe("too-large");
    }
  });
});
