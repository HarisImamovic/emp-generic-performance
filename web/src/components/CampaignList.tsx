import { GENERIC, type Report, type Segment } from "../core/report";

interface CampaignListProps {
  report: Report | null;
  segment: Segment;
  rowIndices: number[];
  excluded: ReadonlySet<number>;
  onToggle: (rowIndex: number) => void;
  onSetAll: (included: boolean) => void;
}

export function CampaignList({ report, segment, rowIndices, excluded, onToggle, onSetAll }: CampaignListProps) {
  const includedCount = rowIndices.filter((index) => !excluded.has(index)).length;

  return (
    <section className="card campaigns">
      <div className="card-head">
        <h2>Campaigns</h2>
        {report && (
          <span className="muted small">
            {includedCount} of {rowIndices.length} included
          </span>
        )}
      </div>
      <div className="list-bar">
        <span className="muted small">Tick to include</span>
        <span>
          <button className="link" onClick={() => onSetAll(true)} disabled={!report}>
            All
          </button>
          <button className="link" onClick={() => onSetAll(false)} disabled={!report}>
            None
          </button>
        </span>
      </div>
      <ul className="campaign-list">
        {report &&
          rowIndices.map((index) => {
            const row = report.rows[index];
            const isExcluded = excluded.has(index);
            return (
              <li key={index}>
                <label className={isExcluded ? "off" : ""}>
                  <input type="checkbox" checked={!isExcluded} onChange={() => onToggle(index)} />
                  <span className="name">{row.name}</span>
                  {segment === GENERIC && row.segment && <span className="seg-tag">{row.segment.short}</span>}
                </label>
              </li>
            );
          })}
        {report && !rowIndices.length && <li className="muted small empty-list">No campaigns in this segment.</li>}
      </ul>
      <p className="muted small">Leaving a campaign out here also removes it from Generic overall.</p>
    </section>
  );
}
