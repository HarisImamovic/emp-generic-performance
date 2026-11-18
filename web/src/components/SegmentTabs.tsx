import { type Report, SEGMENTS, type Segment, segmentRows } from "../core/report";

interface SegmentTabsProps {
  report: Report | null;
  active: Segment;
  excluded: ReadonlySet<number>;
  onSelect: (segment: Segment) => void;
}

function includedCount(rows: number[], excluded: ReadonlySet<number>): string {
  const included = rows.filter((index) => !excluded.has(index)).length;
  return included === rows.length ? String(included) : `${included}/${rows.length}`;
}

export function SegmentTabs({ report, active, excluded, onSelect }: SegmentTabsProps) {
  return (
    <nav className="tabs" aria-label="Segments">
      {SEGMENTS.map((segment, index) => (
        <button
          key={segment.key}
          className={`tab${segment === active ? " active" : ""}`}
          onClick={() => onSelect(segment)}
          title={`${segment.label} (key ${index + 1})`}
          aria-pressed={segment === active}
        >
          {segment.short}
          {report && <span className="tab-count">{includedCount(segmentRows(report, segment), excluded)}</span>}
        </button>
      ))}
      <span className="hint">Keys 1–4 switch</span>
    </nav>
  );
}
