import type { ResultRow } from "./report";

export function withoutHiddenMetrics(results: ResultRow[], hiddenKeys: ReadonlySet<string>): ResultRow[] {
  return results.filter((row) => !hiddenKeys.has(row.key));
}
