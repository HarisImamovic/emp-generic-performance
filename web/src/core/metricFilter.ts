import type { ResultRow } from "./report";

export function withoutHiddenMetrics(results: ResultRow[], hiddenKeys: ReadonlySet<string>): ResultRow[] {
  return results.filter((row) => !hiddenKeys.has(row.key));
}

export function orderMetrics(results: ResultRow[], order: readonly string[]): ResultRow[] {
  if (!order.length) return results;
  const rank = new Map(order.map((key, index) => [key, index]));
  const ranked = results.filter((row) => rank.has(row.key));
  ranked.sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
  return [...ranked, ...results.filter((row) => !rank.has(row.key))];
}

export function mergeMetricOrder(saved: readonly string[], fileOrder: readonly string[]): string[] {
  const inFile = new Set(fileOrder);
  return [...fileOrder, ...saved.filter((key) => !inFile.has(key))];
}

export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}
