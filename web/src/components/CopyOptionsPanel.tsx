import type { Layout } from "../core/output";
import type { Settings } from "../settings";

interface CopyOptionsPanelProps {
  settings: Settings;
  onChange: (changes: Partial<Settings>) => void;
}

type ToggleName = "withLabels" | "withChange" | "withHeader";

const TOGGLES: [ToggleName, string][] = [
  ["withLabels", "Metric names"],
  ["withChange", "Change %"],
  ["withHeader", "Header"],
];

export function CopyOptionsPanel({ settings, onChange }: CopyOptionsPanelProps) {
  return (
    <div className="options">
      <span className="muted small options-title">Copy options</span>
      <label>
        Decimal
        <select
          value={settings.decimalSeparator}
          onChange={(event) => onChange({ decimalSeparator: event.target.value })}
        >
          <option value=".">.</option>
          <option value=",">,</option>
        </select>
      </label>
      {TOGGLES.map(([name, label]) => (
        <label key={name}>
          <input
            type="checkbox"
            checked={settings[name]}
            onChange={(event) => onChange({ [name]: event.target.checked })}
          />
          {label}
        </label>
      ))}
      <label>
        All segments
        <select value={settings.layout} onChange={(event) => onChange({ layout: event.target.value as Layout })}>
          <option value="side">Side by side</option>
          <option value="stacked">Stacked</option>
        </select>
      </label>
    </div>
  );
}
