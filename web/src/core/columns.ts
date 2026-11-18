// Metric column detection. Port of parse_columns in desktop/generic_performance.py.
import { type Cell, type Kind, isEmpty, norm, toNumber } from "./numbers";

export interface MetricCol {
  label: string;
  kind: Kind;
  cur: number | null; // column index of the current period
  prev: number | null; // column index of the compared period
  derived: [number, number, number] | null; // (numerator idx, denominator idx, factor) into metrics
}

// After a metric's own name, these mark its compared-period column / its delta column.
const COMPARE_RE = /^(comparedto|compareto|comparison|compared|previousperiod|previous|priorperiod|prior)/;
const DELTA_START_RE = /^(change|diff|delta|pct|percent)/;
const DELTA_ANY_RE = /(change|diff|delta|pct|percent)/;
const ORPHAN_COMPARE_RE = /(comparedto|compareto|comparison|previousperiod|priorperiod)/;

// Ratios that must be recomputed from sums, never summed or averaged:
// [header norms, numerator norms, denominator norms, factor, kind]
type Rule = [string[], string[], string[], number, Kind];
const DERIVED_RULES: Rule[] = [
  [["avgcpc", "averagecpc", "cpc"], ["cost"], ["clicks"], 1.0, "money"],
  [["ctr", "clickthroughrate"], ["clicks"], ["impr", "impressions"], 1.0, "pct"],
  [["avgcpm", "averagecpm", "cpm"], ["cost"], ["impr", "impressions"], 1000.0, "money"],
  [["convrate", "conversionrate"], ["conversions", "conv"], ["clicks"], 1.0, "pct"],
  [["costconv", "costperconv", "costperconversion", "cpa"], ["cost"], ["conversions", "conv"], 1.0, "money"],
  [["convvaluecost", "conversionvaluecost", "roas"], ["convvalue", "conversionvalue"], ["cost"], 1.0, "num"],
  [["valueconv", "convvalueconv", "valueperconversion"], ["convvalue", "conversionvalue"], ["conversions", "conv"], 1.0, "money"],
];
const RATIO_WORDS = /\b(rate|avg|average|share|ctr|cpc|cpm|cpa|roas|per|position|ratio|percent)\b/i;
const MONEY_WORDS = ["cost", "value", "revenue", "sales", "budget", "spend"];
const COUNT_NORMS = new Set(["clicks", "impr", "impressions", "interactions"]);
const ID_RE = /\bid\b/i;

function isNumericColumn(values: Cell[]): boolean {
  const filled = values.filter((v) => !isEmpty(v));
  if (!filled.length) return false;
  const nums = filled.filter((v) => toNumber(v) !== null).length;
  return nums >= 0.8 * filled.length;
}

function baseKind(n: string, raw: Cell[]): Kind {
  if (COUNT_NORMS.has(n)) return "int";
  if (raw.some((v) => typeof v === "string" && /[$€£]/.test(v))) return "money";
  if (MONEY_WORDS.some((w) => n.includes(w))) return "money";
  return "num";
}

/**
 * Every numeric column in the export becomes a metric (file order).
 * Returns metrics and the columns that were skipped (rates that can't be rebuilt,
 * or settings with no compared column in a comparison export).
 */
export function parseColumns(
  header: Cell[],
  rows: Cell[][],
  campaignCol: number | null,
): { metrics: MetricCol[]; skipped: string[] } {
  const labels = header.map((h) => (h === null ? "" : String(h).trim()));
  const norms = header.map((h) => norm(h));
  const first = new Map<string, number>();
  norms.forEach((n, j) => {
    if (n && !first.has(n)) first.set(n, j);
  });

  // pair "<metric> (Compared to)" with "<metric>"; drop "<metric> (% change)"
  const prevOf = new Map<string, number>();
  const secondary = new Set<number>();
  norms.forEach((n, j) => {
    if (!n) return;
    let best: string | null = null;
    for (const b of first.keys()) {
      if (b !== n && n.startsWith(b) && (best === null || b.length > best.length)) {
        const rest = n.slice(b.length);
        if (COMPARE_RE.test(rest) || DELTA_START_RE.test(rest)) best = b;
      }
    }
    if (best === null) return;
    secondary.add(j);
    const rest = n.slice(best.length);
    if (COMPARE_RE.test(rest) && !DELTA_ANY_RE.test(rest) && !prevOf.has(best)) prevOf.set(best, j);
  });

  const colValues = (j: number): Cell[] => rows.map((r) => (j < r.length ? r[j] : null));

  // numeric base columns, file order
  const bases: number[] = [];
  for (const [n, j] of first) {
    if (secondary.has(j) || j === campaignCol || ID_RE.test(labels[j]) || ORPHAN_COMPARE_RE.test(n)) continue;
    if (isNumericColumn(colValues(j))) bases.push(j);
  }
  bases.sort((a, b) => a - b);

  const metrics: MetricCol[] = [];
  const skipped: string[] = [];
  const pending: [number, number, string[], string[], number, Kind | ""][] = [];
  const prevFor = (n: string) => prevOf.get(n) ?? null;

  const additiveByNorm = (cands: string[]): number | null => {
    for (const c of cands) {
      for (let k = 0; k < metrics.length; k++) {
        const m = metrics[k];
        if (m.derived === null && m.kind !== "pct" && norm(m.label) === c) return k;
      }
    }
    return null;
  };

  for (const j of bases) {
    const n = norms[j];
    const raw = colValues(j);
    const rule = DERIVED_RULES.find((r) => r[0].includes(n));
    const parts = labels[j].split("/");
    if (rule) {
      metrics.push({ label: labels[j], kind: rule[4], cur: j, prev: prevFor(n), derived: null });
      pending.push([metrics.length - 1, j, rule[1], rule[2], rule[3], rule[4]]);
    } else if (parts.length === 2 && parts.every((p) => norm(p))) {
      metrics.push({ label: labels[j], kind: "num", cur: j, prev: prevFor(n), derived: null });
      pending.push([metrics.length - 1, j, [norm(parts[0])], [norm(parts[1])], 1.0, ""]);
    } else if (
      RATIO_WORDS.test(labels[j]) ||
      labels[j].includes("%") ||
      raw.some((v) => typeof v === "string" && v.trim().endsWith("%"))
    ) {
      metrics.push({ label: labels[j], kind: "pct", cur: j, prev: prevFor(n), derived: null });
      pending.push([metrics.length - 1, j, [], [], 1.0, "pct"]);
    } else if (prevOf.size && !prevOf.has(n)) {
      // comparison export, but this column has none: a setting (Budget, target CPA), not performance
      skipped.push(`${labels[j]} (no compared column)`);
    } else {
      metrics.push({ label: labels[j], kind: baseKind(n, raw), cur: j, prev: prevFor(n), derived: null });
    }
  }

  const drop = new Set<number>();
  for (const [k, j, num, den, factor, kindIn] of pending) {
    const a = additiveByNorm(num);
    const b = additiveByNorm(den);
    if (a === null || b === null) {
      drop.add(k);
      skipped.push(`${labels[j]} (not summable)`);
      continue;
    }
    let kind = kindIn;
    if (!kind) {
      // generic "A / B" column
      kind = metrics[a].kind === "money" && metrics[b].kind !== "money" ? "money" : "num";
    }
    metrics[k].kind = kind;
    metrics[k].derived = [a, b, factor];
  }

  // drop non-aggregatable columns and re-point derived indices
  const remap = new Map<number, number>();
  const kept: MetricCol[] = [];
  metrics.forEach((m, k) => {
    if (!drop.has(k)) {
      remap.set(k, kept.length);
      kept.push(m);
    }
  });
  for (const m of kept) {
    if (m.derived) {
      const [a, b, f] = m.derived;
      m.derived = [remap.get(a)!, remap.get(b)!, f];
    }
  }
  return { metrics: kept, skipped };
}
