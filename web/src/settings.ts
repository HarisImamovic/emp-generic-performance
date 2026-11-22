import { useCallback, useState } from "react";
import type { CopyOptions, Layout } from "./core/output";
import { POST_L, type SegmentKey } from "./core/report";

export interface Settings extends CopyOptions {
  layout: Layout;
  segment: SegmentKey;
  hiddenMetrics: string[];
  metricOrder: string[];
}

const STORAGE_KEY = "generic-performance-settings";

function systemDecimalSeparator(): string {
  return (1.5).toLocaleString().includes(",") ? "," : ".";
}

function defaultSettings(): Settings {
  return {
    decimalSeparator: systemDecimalSeparator(),
    withLabels: false,
    withChange: false,
    withHeader: false,
    layout: "side",
    segment: POST_L.key,
    hiddenMetrics: [],
    metricOrder: [],
  };
}

function readStoredSettings(): Settings {
  try {
    return { ...defaultSettings(), ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") };
  } catch {
    return defaultSettings();
  }
}

function storeSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    return;
  }
}

export function useSettings() {
  const [settings, setSettings] = useState(readStoredSettings);

  const updateSettings = useCallback((changes: Partial<Settings>) => {
    setSettings((current) => {
      const next = { ...current, ...changes };
      storeSettings(next);
      return next;
    });
  }, []);

  return [settings, updateSettings] as const;
}
