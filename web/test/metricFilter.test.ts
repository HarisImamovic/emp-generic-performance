import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mergeMetricOrder, moveItem, orderMetrics, withoutHiddenMetrics } from "../src/core/metricFilter";
import { buildClipboardText } from "../src/core/output";
import { loadReport } from "../src/core/read";
import { PRE_VERTICAL, aggregate, segmentRows } from "../src/core/report";

const FIXTURE = join(__dirname, "..", "..", "tests", "fixtures", "sa360.xlsx");
const COPY_OPTIONS = { decimalSeparator: ".", withLabels: true, withChange: false, withHeader: false };

async function verticalResults() {
  const buffer = readFileSync(FIXTURE);
  const report = await loadReport(
    "sa360.xlsx",
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  );
  return aggregate(report, segmentRows(report, PRE_VERTICAL));
}

describe("metric filter", () => {
  it("keeps every metric when nothing is hidden", async () => {
    const results = await verticalResults();
    expect(withoutHiddenMetrics(results, new Set())).toEqual(results);
  });

  it("removes hidden metrics and keeps file order", async () => {
    const results = await verticalResults();
    const visible = withoutHiddenMetrics(results, new Set(["cost", "impr"]));
    expect(visible.map((r) => r.label)).toEqual(
      results.map((r) => r.label).filter((l) => l !== "Cost" && l !== "Impr."),
    );
  });

  it("still calculates ratios from hidden metrics", async () => {
    const results = await verticalResults();
    const cpc = results.find((r) => r.key === "avgcpc");
    const visible = withoutHiddenMetrics(results, new Set(["cost", "clicks"]));
    expect(visible.find((r) => r.key === "avgcpc")).toEqual(cpc);
  });

  it("copies only the visible metrics", async () => {
    const results = await verticalResults();
    const text = buildClipboardText(withoutHiddenMetrics(results, new Set(["cost", "clicks", "impr"])), COPY_OPTIONS);
    const copiedLabels = text.split("\n").map((line) => line.split("\t")[0]);
    expect(copiedLabels).not.toContain("Cost");
    expect(copiedLabels).toContain("Avg. CPC");
    expect(copiedLabels).toHaveLength(results.length - 3);
  });
});

describe("metric order", () => {
  it("keeps file order when no order is saved", async () => {
    const results = await verticalResults();
    expect(orderMetrics(results, [])).toEqual(results);
  });

  it("puts ordered metrics first and keeps the rest in file order", async () => {
    const results = await verticalResults();
    const ordered = orderMetrics(results, ["ctr", "nosuchmetric", "cost"]);
    const rest = results.filter((r) => r.key !== "ctr" && r.key !== "cost");
    expect(ordered.map((r) => r.key)).toEqual(["ctr", "cost", ...rest.map((r) => r.key)]);
    expect(ordered).toHaveLength(results.length);
  });

  it("copies metrics in the chosen order", async () => {
    const results = await verticalResults();
    const ordered = orderMetrics(results, ["clicks", "cost"]);
    const text = buildClipboardText(withoutHiddenMetrics(ordered, new Set(["clicks"])), COPY_OPTIONS);
    const firstLabels = text.split("\n").map((line) => line.split("\t")[0]);
    expect(firstLabels.slice(0, 1)).toEqual(["Cost"]);
    expect(firstLabels).not.toContain("Clicks");
  });

  it("keeps the saved order of metrics from other files", () => {
    expect(mergeMetricOrder(["leads", "cost", "clicks"], ["clicks", "cost"])).toEqual(["clicks", "cost", "leads"]);
  });

  it("moves an item", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
  });
});
