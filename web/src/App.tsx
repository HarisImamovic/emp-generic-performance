import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtValue } from "./core/numbers";
import { type CopyOptions, type Layout, buildAllSegmentsText, buildClipboardText, exportXlsx } from "./core/output";
import { loadReport } from "./core/read";
import {
  GENERIC,
  POST_L,
  type Report,
  type ResultRow,
  SEGMENTS,
  type Segment,
  aggregate,
  missingCompared,
  segmentRows,
} from "./core/report";

// ---- settings (this browser only) ------------------------------------------------

interface Settings extends CopyOptions {
  layout: Layout;
  segment: string;
}

const SETTINGS_KEY = "generic-performance-settings";

function systemDecimalSeparator(): string {
  try {
    return (1.5).toLocaleString().includes(",") ? "," : ".";
  } catch {
    return ".";
  }
}

function loadSettings(): Settings {
  const defaults: Settings = {
    decSep: systemDecimalSeparator(),
    withLabels: false,
    withChange: false,
    withHeader: false,
    layout: "side",
    segment: POST_L.key,
  };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return defaults;
  }
}

function saveSettings(s: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // private mode or storage blocked: settings just aren't remembered
  }
}

// ---- helpers ------------------------------------------------------------------------

type Level = "info" | "ok" | "warn" | "error";
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? "⌘" : "Ctrl+";
// Cloudflare Access handles sign-in in front of the site; this ends that session.
// Hidden on the local dev server, where there is no sign-in.
const LOGOUT_URL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) ? null : "/cdn-cgi/access/logout";

function downloadBytes(bytes: ArrayBuffer, fileName: string) {
  const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ChangeBadge({ value, decSep }: { value: number | null; decSep: string }) {
  if (value === null) return <span className="chg">–</span>;
  if (value === 0) return <span className="chg">{fmtValue(value, "pct", decSep)}</span>;
  return value > 0 ? (
    <span className="chg up"><span className="chg-arrow">▲ </span>+{fmtValue(value, "pct", decSep)}</span>
  ) : (
    <span className="chg down"><span className="chg-arrow">▼ </span>{fmtValue(value, "pct", decSep)}</span>
  );
}

// ---- app --------------------------------------------------------------------------------

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [report, setReport] = useState<Report | null>(null);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [seg, setSeg] = useState<Segment>(() => SEGMENTS.find((s) => s.key === settings.segment) ?? POST_L);
  const [status, setStatus] = useState<{ msg: string; level: Level }>({
    msg: "Ready. Files are read on this device only — nothing is uploaded.",
    level: "info",
  });
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const update = (patch: Partial<Settings>) =>
    setSettings((s) => {
      const next = { ...s, ...patch };
      saveSettings(next);
      return next;
    });

  const selectSegment = useCallback((s: Segment) => {
    setSeg(s);
    setSettings((cur) => {
      const next = { ...cur, segment: s.key };
      saveSettings(next);
      return next;
    });
  }, []);

  const openFile = useCallback(async (file: File) => {
    setBusy(true);
    setStatus({ msg: `Reading ${file.name}…`, level: "info" });
    try {
      const rep = await loadReport(file.name, await file.arrayBuffer());
      setReport(rep);
      setExcluded(new Set());
      const msg: string[] = [];
      if (rep.campaignCol === null) msg.push("No 'Campaign' column found - campaigns cannot be segmented.");
      const missing = missingCompared(rep);
      if (missing.length) msg.push(`No compared column for: ${missing.join(", ")}.`);
      if (rep.skipped.length) msg.push(`Skipped: ${rep.skipped.join(", ")}.`);
      setStatus(
        msg.length
          ? { msg: msg.join("  "), level: "warn" }
          : { msg: `Loaded ${file.name} - ${rep.metrics.length} metric columns.`, level: "ok" },
      );
    } catch (e) {
      setStatus({ msg: `Could not read file: ${e instanceof Error ? e.message : String(e)}`, level: "error" });
    } finally {
      setBusy(false);
    }
  }, []);

  // ---- derived data ----
  const included = useCallback(
    (s: Segment) => (report ? segmentRows(report, s).filter((i) => !excluded.has(i)) : []),
    [report, excluded],
  );
  const visible = useMemo(() => (report ? segmentRows(report, seg) : []), [report, seg]);
  const results = useMemo(() => (report ? aggregate(report, included(seg)) : []), [report, seg, included]);
  const allBlocks = (): [Segment, ResultRow[]][] => SEGMENTS.map((s) => [s, aggregate(report!, included(s))]);

  // ---- actions ----
  const toClipboard = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus({ msg: `Copied ${what} to clipboard - paste into Excel with ${MOD}V.`, level: "ok" });
    } catch {
      setStatus({ msg: "The browser blocked clipboard access. Allow it for this site and try again.", level: "error" });
    }
  };

  const copySegment = () => {
    if (!report || !included(seg).length) {
      setStatus({ msg: "Nothing to copy - load a file and include some campaigns.", level: "warn" });
      return;
    }
    void toClipboard(buildClipboardText(results, settings), seg.short);
  };

  const copyAll = () => {
    if (!report) {
      setStatus({ msg: "Nothing to copy - load a file first.", level: "warn" });
      return;
    }
    const blocks = allBlocks().map(([s, r]) => [s.short, r] as [string, ResultRow[]]);
    void toClipboard(buildAllSegmentsText(blocks, settings, settings.layout), "all segments");
  };

  const exportFile = async () => {
    if (!report) {
      setStatus({ msg: "Nothing to export - load a file first.", level: "warn" });
      return;
    }
    const stem = report.fileName.replace(/\.[^.]+$/, "");
    const bytes = await exportXlsx(report, allBlocks(), excluded);
    downloadBytes(bytes, `${stem}_summary.xlsx`);
    setStatus({ msg: `Downloaded ${stem}_summary.xlsx`, level: "ok" });
  };

  const toggle = (i: number) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const setAll = (on: boolean) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      for (const i of visible) {
        if (on) next.delete(i);
        else next.add(i);
      }
      return next;
    });

  // ---- keyboard: Ctrl/⌘+O to open, 1–4 to switch segment ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && e.target.closest("input, select, textarea");
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        fileInput.current?.click();
      } else if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && /^[1-4]$/.test(e.key)) {
        selectSegment(SEGMENTS[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectSegment]);

  // ---- drag and drop anywhere on the page ----
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const f = e.dataTransfer?.files[0];
      if (f) void openFile(f);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [openFile]);

  // ---- render ----
  const outside = report ? report.rows.filter((r) => !r.segment).length : 0;
  const fileInfo = report
    ? [
        report.fileName,
        report.sheet ? `sheet ${report.sheet}` : null,
        `${report.rows.length} rows`,
        `${report.metrics.length} metrics`,
        `${outside} rows outside Generic`,
      ]
        .filter(Boolean)
        .join("  ·  ")
    : "No file loaded";

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-text">
          <h1>Generic Performance</h1>
          <p className="file-info">{fileInfo}</p>
        </div>
        <button className="btn accent" onClick={() => fileInput.current?.click()} disabled={busy}>
          {busy ? "Reading…" : "Open export…"}
          <kbd>{MOD}O</kbd>
        </button>
        {LOGOUT_URL && (
          <a className="btn ghost" href={LOGOUT_URL}>
            Sign out
          </a>
        )}
        <input
          ref={fileInput}
          type="file"
          accept=".xlsx,.xlsm,.csv,.tsv,.txt"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void openFile(f);
          }}
        />
      </header>

      <nav className="tabs" aria-label="Segments">
        {SEGMENTS.map((s, n) => {
          const rows = report ? segmentRows(report, s) : [];
          const inc = rows.filter((i) => !excluded.has(i)).length;
          return (
            <button
              key={s.key}
              className={`tab${s === seg ? " active" : ""}`}
              onClick={() => selectSegment(s)}
              title={`${s.label} (key ${n + 1})`}
              aria-pressed={s === seg}
            >
              {s.short}
              {report && <span className="tab-count">{inc === rows.length ? inc : `${inc}/${rows.length}`}</span>}
            </button>
          );
        })}
        <span className="hint">Keys 1–4 switch</span>
      </nav>

      <main className="body">
        <section className="card campaigns">
          <div className="card-head">
            <h2>Campaigns</h2>
            {report && (
              <span className="muted small">
                {included(seg).length} of {visible.length} included
              </span>
            )}
          </div>
          <div className="list-bar">
            <span className="muted small">Tick to include</span>
            <span>
              <button className="link" onClick={() => setAll(true)} disabled={!report}>
                All
              </button>
              <button className="link" onClick={() => setAll(false)} disabled={!report}>
                None
              </button>
            </span>
          </div>
          <ul className="campaign-list">
            {visible.map((i) => {
              const r = report!.rows[i];
              return (
                <li key={i}>
                  <label className={excluded.has(i) ? "off" : ""}>
                    <input type="checkbox" checked={!excluded.has(i)} onChange={() => toggle(i)} />
                    <span className="name">{r.name}</span>
                    {seg === GENERIC && r.segment && <span className="seg-tag">{r.segment.short}</span>}
                  </label>
                </li>
              );
            })}
            {report && !visible.length && <li className="muted small empty-list">No campaigns in this segment.</li>}
          </ul>
          <p className="muted small">Leaving a campaign out here also removes it from Generic overall.</p>
        </section>

        <section className="card summary">
          <div className="card-head">
            <h2>{seg.label}</h2>
          </div>
          <div className="table-wrap">
            {report ? (
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
                  {results.map((r, k) => (
                    <tr key={k}>
                      <td className="left">
                        {r.label}
                        {report.metrics[k].derived && (
                          <span className="derived" title="Recalculated from the summed columns">
                            {" "}
                            ƒ
                          </span>
                        )}
                      </td>
                      <td className="cur">{fmtValue(r.cur, r.kind, settings.decSep, true) || "–"}</td>
                      <td className="prev">{fmtValue(r.prev, r.kind, settings.decSep, true) || "–"}</td>
                      <td>
                        <ChangeBadge value={r.change} decSep={settings.decSep} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="empty">
                <p>No data yet</p>
                <p className="muted">
                  Open an SA360 export ({MOD}O) or drop the file anywhere on this page.
                  <br />
                  It's read on this device only and never uploaded.
                </p>
              </div>
            )}
          </div>

          <div className="options">
            <span className="muted small options-title">Copy options</span>
            <label>
              Decimal
              <select value={settings.decSep} onChange={(e) => update({ decSep: e.target.value })}>
                <option value=".">.</option>
                <option value=",">,</option>
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={settings.withLabels}
                onChange={(e) => update({ withLabels: e.target.checked })}
              />
              Metric names
            </label>
            <label>
              <input
                type="checkbox"
                checked={settings.withChange}
                onChange={(e) => update({ withChange: e.target.checked })}
              />
              Change %
            </label>
            <label>
              <input
                type="checkbox"
                checked={settings.withHeader}
                onChange={(e) => update({ withHeader: e.target.checked })}
              />
              Header
            </label>
            <label>
              All segments
              <select value={settings.layout} onChange={(e) => update({ layout: e.target.value as Layout })}>
                <option value="side">Side by side</option>
                <option value="stacked">Stacked</option>
              </select>
            </label>
          </div>

          <div className="actions">
            <button className="btn" onClick={() => void exportFile()} disabled={!report}>
              Export to Excel
            </button>
            <button className="btn" onClick={copyAll} disabled={!report}>
              Copy all segments
            </button>
            <button className="btn accent" onClick={copySegment} disabled={!report}>
              Copy segment
            </button>
          </div>
        </section>
      </main>

      <footer className={`status ${status.level}`} role="status">
        <span className="dot">●</span>
        <span>{status.msg}</span>
      </footer>

      {dragging && (
        <div className="drop-overlay">
          <p>Drop the SA360 export to open it</p>
        </div>
      )}
    </div>
  );
}
