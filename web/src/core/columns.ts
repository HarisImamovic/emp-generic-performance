import { type Cell, type Kind, isEmpty, normalizeKey, toNumber } from "./numbers";

export interface MetricCol {
  label: string;
  kind: Kind;
  cur: number | null;
  prev: number | null;
  derived: [numerator: number, denominator: number, factor: number] | null;
}

interface RatioRule {
  headers: string[];
  numerators: string[];
  denominators: string[];
  factor: number;
  kind: Kind;
}

interface PendingRatio {
  metricIndex: number;
  column: number;
  numerators: string[];
  denominators: string[];
  factor: number;
  kind: Kind | null;
}

const COMPARED_SUFFIX = /^(comparedto|compareto|comparison|compared|previousperiod|previous|priorperiod|prior)/;
const CHANGE_SUFFIX = /^(change|diff|delta|pct|percent)/;
const CHANGE_WORD = /(change|diff|delta|pct|percent)/;
const STANDALONE_COMPARED_HEADER = /(comparedto|compareto|comparison|previousperiod|priorperiod)/;
const RATE_WORDS = /\b(rate|avg|average|share|ctr|cpc|cpm|cpa|roas|per|position|ratio|percent)\b/i;
const ID_WORD = /\bid\b/i;
const CURRENCY_SYMBOL = /[$€£]/;
const MONEY_WORDS = ["cost", "value", "revenue", "sales", "budget", "spend"];
const COUNT_HEADERS = new Set(["clicks", "impr", "impressions", "interactions"]);
const NUMERIC_SHARE_THRESHOLD = 0.8;

const RATIO_RULES: RatioRule[] = [
  {
    headers: ["avgcpc", "averagecpc", "cpc"],
    numerators: ["cost"],
    denominators: ["clicks"],
    factor: 1,
    kind: "money",
  },
  {
    headers: ["ctr", "clickthroughrate"],
    numerators: ["clicks"],
    denominators: ["impr", "impressions"],
    factor: 1,
    kind: "pct",
  },
  {
    headers: ["avgcpm", "averagecpm", "cpm"],
    numerators: ["cost"],
    denominators: ["impr", "impressions"],
    factor: 1000,
    kind: "money",
  },
  {
    headers: ["convrate", "conversionrate"],
    numerators: ["conversions", "conv"],
    denominators: ["clicks"],
    factor: 1,
    kind: "pct",
  },
  {
    headers: ["costconv", "costperconv", "costperconversion", "cpa"],
    numerators: ["cost"],
    denominators: ["conversions", "conv"],
    factor: 1,
    kind: "money",
  },
  {
    headers: ["convvaluecost", "conversionvaluecost", "roas"],
    numerators: ["convvalue", "conversionvalue"],
    denominators: ["cost"],
    factor: 1,
    kind: "num",
  },
  {
    headers: ["valueconv", "convvalueconv", "valueperconversion"],
    numerators: ["convvalue", "conversionvalue"],
    denominators: ["conversions", "conv"],
    factor: 1,
    kind: "money",
  },
];

function firstColumnByKey(keys: string[]): Map<string, number> {
  const first = new Map<string, number>();
  keys.forEach((key, column) => {
    if (key && !first.has(key)) first.set(key, column);
  });
  return first;
}

function longestBaseKey(key: string, baseKeys: Iterable<string>): string | null {
  let best: string | null = null;
  for (const base of baseKeys) {
    if (base === key || !key.startsWith(base)) continue;
    if (best !== null && base.length <= best.length) continue;
    const suffix = key.slice(base.length);
    if (COMPARED_SUFFIX.test(suffix) || CHANGE_SUFFIX.test(suffix)) best = base;
  }
  return best;
}

function pairComparedColumns(keys: string[], first: Map<string, number>) {
  const comparedColumnOf = new Map<string, number>();
  const secondaryColumns = new Set<number>();
  keys.forEach((key, column) => {
    if (!key) return;
    const base = longestBaseKey(key, first.keys());
    if (base === null) return;
    secondaryColumns.add(column);
    const suffix = key.slice(base.length);
    const isComparedValue = COMPARED_SUFFIX.test(suffix) && !CHANGE_WORD.test(suffix);
    if (isComparedValue && !comparedColumnOf.has(base)) comparedColumnOf.set(base, column);
  });
  return { comparedColumnOf, secondaryColumns };
}

function isNumericColumn(values: Cell[]): boolean {
  const filled = values.filter((v) => !isEmpty(v));
  if (!filled.length) return false;
  const numeric = filled.filter((v) => toNumber(v) !== null).length;
  return numeric >= NUMERIC_SHARE_THRESHOLD * filled.length;
}

function additiveKind(key: string, values: Cell[]): Kind {
  if (COUNT_HEADERS.has(key)) return "int";
  if (values.some((v) => typeof v === "string" && CURRENCY_SYMBOL.test(v))) return "money";
  if (MONEY_WORDS.some((word) => key.includes(word))) return "money";
  return "num";
}

function looksLikeRate(label: string, values: Cell[]): boolean {
  return (
    RATE_WORDS.test(label) || label.includes("%") || values.some((v) => typeof v === "string" && v.trim().endsWith("%"))
  );
}

function splitRatioLabel(label: string): [string, string] | null {
  const parts = label.split("/");
  if (parts.length !== 2) return null;
  const [numerator, denominator] = parts.map((part) => normalizeKey(part));
  return numerator && denominator ? [numerator, denominator] : null;
}

function findAdditiveMetric(metrics: MetricCol[], candidates: string[]): number | null {
  for (const candidate of candidates) {
    const index = metrics.findIndex(
      (m) => m.derived === null && m.kind !== "pct" && normalizeKey(m.label) === candidate,
    );
    if (index !== -1) return index;
  }
  return null;
}

function ratioKind(metrics: MetricCol[], numerator: number, denominator: number): Kind {
  const isMoneyPerUnit = metrics[numerator].kind === "money" && metrics[denominator].kind !== "money";
  return isMoneyPerUnit ? "money" : "num";
}

function removeMetrics(metrics: MetricCol[], removed: Set<number>): MetricCol[] {
  const newIndex = new Map<number, number>();
  const kept = metrics.filter((_, index) => {
    if (removed.has(index)) return false;
    newIndex.set(index, newIndex.size);
    return true;
  });
  for (const metric of kept) {
    if (!metric.derived) continue;
    const [numerator, denominator, factor] = metric.derived;
    metric.derived = [newIndex.get(numerator)!, newIndex.get(denominator)!, factor];
  }
  return kept;
}

export function parseColumns(
  header: Cell[],
  rows: Cell[][],
  campaignCol: number | null,
): { metrics: MetricCol[]; skipped: string[] } {
  const labels = header.map((h) => (h === null ? "" : String(h).trim()));
  const keys = header.map((h) => normalizeKey(h));
  const first = firstColumnByKey(keys);
  const { comparedColumnOf, secondaryColumns } = pairComparedColumns(keys, first);
  const columnValues = (column: number): Cell[] => rows.map((row) => (column < row.length ? row[column] : null));

  const baseColumns = [...first]
    .filter(
      ([key, column]) =>
        !secondaryColumns.has(column) &&
        column !== campaignCol &&
        !ID_WORD.test(labels[column]) &&
        !STANDALONE_COMPARED_HEADER.test(key) &&
        isNumericColumn(columnValues(column)),
    )
    .map(([, column]) => column)
    .sort((a, b) => a - b);

  const metrics: MetricCol[] = [];
  const skipped: string[] = [];
  const pending: PendingRatio[] = [];
  const isComparisonExport = comparedColumnOf.size > 0;

  const addMetric = (column: number, kind: Kind) => {
    const key = keys[column];
    metrics.push({ label: labels[column], kind, cur: column, prev: comparedColumnOf.get(key) ?? null, derived: null });
    return metrics.length - 1;
  };

  for (const column of baseColumns) {
    const key = keys[column];
    const label = labels[column];
    const values = columnValues(column);
    const rule = RATIO_RULES.find((r) => r.headers.includes(key));
    const ratioParts = splitRatioLabel(label);

    if (rule) {
      const { numerators, denominators, factor, kind } = rule;
      pending.push({ metricIndex: addMetric(column, kind), column, numerators, denominators, factor, kind });
    } else if (ratioParts) {
      const [numerator, denominator] = ratioParts;
      const metricIndex = addMetric(column, "num");
      pending.push({
        metricIndex,
        column,
        numerators: [numerator],
        denominators: [denominator],
        factor: 1,
        kind: null,
      });
    } else if (looksLikeRate(label, values)) {
      const metricIndex = addMetric(column, "pct");
      pending.push({ metricIndex, column, numerators: [], denominators: [], factor: 1, kind: "pct" });
    } else if (isComparisonExport && !comparedColumnOf.has(key)) {
      skipped.push(`${label} (no compared column)`);
    } else {
      addMetric(column, additiveKind(key, values));
    }
  }

  const unresolved = new Set<number>();
  for (const ratio of pending) {
    const numerator = findAdditiveMetric(metrics, ratio.numerators);
    const denominator = findAdditiveMetric(metrics, ratio.denominators);
    if (numerator === null || denominator === null) {
      unresolved.add(ratio.metricIndex);
      skipped.push(`${labels[ratio.column]} (not summable)`);
      continue;
    }
    const metric = metrics[ratio.metricIndex];
    metric.kind = ratio.kind ?? ratioKind(metrics, numerator, denominator);
    metric.derived = [numerator, denominator, ratio.factor];
  }

  return { metrics: removeMetrics(metrics, unresolved), skipped };
}
