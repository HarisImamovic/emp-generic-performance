import { formatValue } from "../core/numbers";
import type { ResultRow } from "../core/report";
import { IS_TOUCH_DEVICE, SHORTCUT_PREFIX } from "../platform";

interface ResultsTableProps {
  hasReport: boolean;
  results: ResultRow[];
  decimalSeparator: string;
}

function ChangeBadge({ value, decimalSeparator }: { value: number | null; decimalSeparator: string }) {
  if (value === null) return <span className="chg">–</span>;
  const text = formatValue(value, "pct", decimalSeparator);
  if (value === 0) return <span className="chg">{text}</span>;
  const isUp = value > 0;
  return (
    <span className={`chg ${isUp ? "up" : "down"}`}>
      <span className="chg-arrow">{isUp ? "▲ " : "▼ "}</span>
      {isUp ? "+" : ""}
      {text}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="empty">
      <p>No data yet</p>
      <p className="muted">
        {IS_TOUCH_DEVICE
          ? "Tap Open export… and choose the SA360 export."
          : `Open an SA360 export (${SHORTCUT_PREFIX}O) or drop the file anywhere on this page.`}
        <br />
        It's read on this device only and never uploaded.
      </p>
    </div>
  );
}

export function ResultsTable({ hasReport, results, decimalSeparator }: ResultsTableProps) {
  if (!hasReport) {
    return (
      <div className="table-wrap">
        <EmptyState />
      </div>
    );
  }

  if (!results.length) {
    return (
      <div className="table-wrap">
        <div className="empty">
          <p>All metrics are hidden</p>
          <p className="muted">Choose the metrics to show under Metrics, above the table.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th className="left">Metric</th>
            <th>Current</th>
            <th>Compared</th>
            <th>Change</th>
          </tr>
        </thead>
        <tbody>
          {results.map((row) => (
            <tr key={row.key}>
              <td className="left">
                {row.label}
                {row.isDerived && (
                  <span className="derived" title="Recalculated from the summed columns">
                    {" "}
                    ƒ
                  </span>
                )}
              </td>
              <td className="cur">{formatValue(row.cur, row.kind, decimalSeparator, true) || "–"}</td>
              <td className="prev">{formatValue(row.prev, row.kind, decimalSeparator, true) || "–"}</td>
              <td>
                <ChangeBadge value={row.change} decimalSeparator={decimalSeparator} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
