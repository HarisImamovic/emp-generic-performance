import { useCallback, useId, useRef, useState } from "react";
import type { ResultRow } from "../core/report";
import { useDismiss } from "../hooks/useDismiss";

interface MetricPickerProps {
  metrics: ResultRow[];
  hiddenKeys: ReadonlySet<string>;
  onChange: (hiddenKeys: string[]) => void;
}

export function MetricPicker({ metrics, hiddenKeys, onChange }: MetricPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const close = useCallback(() => setIsOpen(false), []);
  useDismiss(container, isOpen, close);

  const shownCount = metrics.filter((m) => !hiddenKeys.has(m.key)).length;
  const keysInFile = new Set(metrics.map((m) => m.key));
  const hiddenElsewhere = [...hiddenKeys].filter((key) => !keysInFile.has(key));

  const toggle = (key: string) => {
    const next = new Set(hiddenKeys);
    if (!next.delete(key)) next.add(key);
    onChange([...next]);
  };
  const showAll = () => onChange(hiddenElsewhere);
  const hideAll = () => onChange([...hiddenElsewhere, ...keysInFile]);

  return (
    <div className="metric-picker" ref={container}>
      <button
        className={`btn small${shownCount < metrics.length ? " filtered" : ""}`}
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        aria-controls={panelId}
      >
        Metrics {shownCount}/{metrics.length}
        <span aria-hidden="true">▾</span>
      </button>
      {isOpen && (
        <div className="picker-panel" id={panelId} role="group" aria-label="Metrics to show and copy">
          <div className="picker-bar">
            <span className="muted small">Show and copy</span>
            <span>
              <button className="link" onClick={showAll}>
                All
              </button>
              <button className="link" onClick={hideAll}>
                None
              </button>
            </span>
          </div>
          <ul>
            {metrics.map((metric) => (
              <li key={metric.key}>
                <label>
                  <input type="checkbox" checked={!hiddenKeys.has(metric.key)} onChange={() => toggle(metric.key)} />
                  <span>{metric.label}</span>
                  {metric.isDerived && <span className="derived">ƒ</span>}
                </label>
              </li>
            ))}
          </ul>
          <p className="muted small picker-note">Hidden metrics are left out of the table, copies and Excel export.</p>
        </div>
      )}
    </div>
  );
}
