import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Kind, formatValue, toNumber } from "../src/core/numbers";
import { buildAllSegmentsText, buildClipboardText } from "../src/core/output";
import { loadReport } from "../src/core/read";
import { type ResultRow, SEGMENTS, aggregate, missingCompared, segmentOf, segmentRows } from "../src/core/report";

const ROOT = join(__dirname, "..", "..", "tests");
const expected = (name: string) => JSON.parse(readFileSync(join(ROOT, "expected", name), "utf-8"));

const FLOATING_POINT_TOLERANCE = 1e-9;

function closeTo(actual: number | null, want: number | null) {
  if (want === null) return expect(actual).toBeNull();
  expect(actual).not.toBeNull();
  expect(Math.abs((actual as number) - want)).toBeLessThanOrEqual(
    FLOATING_POINT_TOLERANCE * Math.max(1, Math.abs(want)),
  );
}

function compareResults(actual: ResultRow[], want: ResultRow[]) {
  expect(actual.map((r) => [r.label, r.kind])).toEqual(want.map((r) => [r.label, r.kind]));
  actual.forEach((r, k) => {
    closeTo(r.cur, want[k].cur);
    closeTo(r.prev, want[k].prev);
    closeTo(r.change, want[k].change);
  });
}

describe("number handling matches the desktop app", () => {
  const b = expected("basics.json");

  it("formats values the same", () => {
    for (const c of b.fmt) {
      expect(formatValue(c.value, c.kind as Kind, c.decimalSeparator, c.thousands), JSON.stringify(c)).toBe(c.out);
    }
  });

  it("parses number text the same", () => {
    for (const c of b.toNumber) closeTo(toNumber(c.text), c.out);
  });

  it("assigns segments the same", () => {
    for (const c of b.segmentOf) expect(segmentOf(c.name)?.key ?? null, c.name).toBe(c.out);
  });
});

const fixtures = readdirSync(join(ROOT, "fixtures")).sort();

describe.each(fixtures)("%s matches the desktop app", (file) => {
  const want = expected(file.replace(/\.[^.]+$/, ".json"));
  const load = async () => {
    const buf = readFileSync(join(ROOT, "fixtures", file));
    return loadReport(file, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  };

  it("finds the same columns, metrics and campaigns", async () => {
    const rep = await load();
    expect(rep.sheet).toBe(want.sheet);
    expect(rep.campaignCol).toBe(want.campaignCol);
    expect(rep.metrics).toEqual(want.metrics);
    expect(rep.skipped).toEqual(want.skipped);
    expect(missingCompared(rep)).toEqual(want.missingCompared);
    expect(rep.rows.map((r) => ({ name: r.name, segment: r.segment?.key ?? null }))).toEqual(want.rows);
  });

  it("calculates the same totals and copy text", async () => {
    const rep = await load();
    const excluded = new Set(rep.rows.map((_, i) => i).filter((i) => i % 2 === 1));
    const blocksAll: [string, ResultRow[]][] = [];
    const blocksSome: [string, ResultRow[]][] = [];
    for (const seg of SEGMENTS) {
      const idx = segmentRows(rep, seg);
      expect(idx).toEqual(want.segments[seg.key].rows);
      const all = aggregate(rep, idx);
      const some = aggregate(
        rep,
        idx.filter((i) => !excluded.has(i)),
      );
      compareResults(all, want.segments[seg.key].all);
      compareResults(some, want.segments[seg.key].some);
      blocksAll.push([seg.short, all]);
      blocksSome.push([seg.short, some]);
    }
    for (const c of want.copy) {
      expect(buildClipboardText(blocksAll[0][1], c.options)).toBe(c.segment);
      expect(buildAllSegmentsText(blocksSome, c.options, "side")).toBe(c.side);
      expect(buildAllSegmentsText(blocksAll, c.options, "stacked")).toBe(c.stacked);
    }
  });
});
