import { useCallback, useMemo, useRef, useState } from "react";
import { CampaignList } from "./components/CampaignList";
import { CopyOptionsPanel } from "./components/CopyOptionsPanel";
import { Header } from "./components/Header";
import { ResultsTable } from "./components/ResultsTable";
import { SegmentTabs } from "./components/SegmentTabs";
import { SkippedColumnsNote } from "./components/SkippedColumnsNote";
import { Toasts } from "./components/Toasts";
import { buildAllSegmentsText, buildClipboardText, exportXlsx } from "./core/output";
import { loadReport } from "./core/read";
import { POST_L, type Report, type ResultRow, SEGMENTS, type Segment, aggregate, segmentRows } from "./core/report";
import { useFileDrop } from "./hooks/useFileDrop";
import { useShortcuts } from "./hooks/useShortcuts";
import { type ToastMessage, useToasts } from "./hooks/useToasts";
import {
  COPY_BLOCKED,
  EXPORT_FAILED,
  FIRST_FILE_ONLY,
  NOTHING_INCLUDED,
  copiedMessage,
  exportedMessage,
  loadErrorMessage,
  loadMessages,
} from "./messages";
import { useSettings } from "./settings";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function downloadFile(bytes: ArrayBuffer, fileName: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: XLSX_MIME }));
  const link = Object.assign(document.createElement("a"), { href: url, download: fileName });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function summarizeFile(report: Report | null): string {
  if (!report) return "No file loaded";
  const outsideGeneric = report.rows.filter((row) => !row.segment).length;
  return [
    report.fileName,
    report.sheet && `sheet ${report.sheet}`,
    `${report.rows.length} rows`,
    `${report.metrics.length} metrics`,
    `${outsideGeneric} rows outside Generic`,
  ]
    .filter(Boolean)
    .join("  ·  ");
}

function withoutExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

export default function App() {
  const [settings, updateSettings] = useSettings();
  const [report, setReport] = useState<Report | null>(null);
  const [excluded, setExcluded] = useState<ReadonlySet<number>>(new Set());
  const [segment, setSegment] = useState<Segment>(() => SEGMENTS.find((s) => s.key === settings.segment) ?? POST_L);
  const [isReading, setIsReading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const { toasts, notify, dismiss } = useToasts();

  const notifyAll = useCallback((messages: ToastMessage[]) => messages.forEach(notify), [notify]);

  const selectSegment = useCallback(
    (next: Segment) => {
      setSegment(next);
      updateSettings({ segment: next.key });
    },
    [updateSettings],
  );

  const openFile = useCallback(
    async (file: File) => {
      setIsReading(true);
      try {
        const loaded = await loadReport(file.name, await file.arrayBuffer());
        setReport(loaded);
        setExcluded(new Set());
        notifyAll(loadMessages(loaded));
      } catch (error) {
        notify(loadErrorMessage(error));
      } finally {
        setIsReading(false);
      }
    },
    [notify, notifyAll],
  );

  const openDroppedFiles = useCallback(
    (files: File[]) => {
      if (files.length > 1) notify(FIRST_FILE_ONLY);
      void openFile(files[0]);
    },
    [notify, openFile],
  );

  const chooseFile = useCallback(() => fileInput.current?.click(), []);
  const selectSegmentByIndex = useCallback((index: number) => selectSegment(SEGMENTS[index]), [selectSegment]);

  const isDragging = useFileDrop(openDroppedFiles);
  useShortcuts({ onOpen: chooseFile, onSegmentKey: selectSegmentByIndex });

  const includedRows = useCallback(
    (target: Segment) => (report ? segmentRows(report, target).filter((index) => !excluded.has(index)) : []),
    [report, excluded],
  );
  const visibleRows = useMemo(() => (report ? segmentRows(report, segment) : []), [report, segment]);
  const results = useMemo(
    () => (report ? aggregate(report, includedRows(segment)) : []),
    [report, segment, includedRows],
  );

  const allSegmentResults = (loaded: Report): [Segment, ResultRow[]][] =>
    SEGMENTS.map((s) => [s, aggregate(loaded, includedRows(s))]);

  const copyText = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify(copiedMessage(what));
    } catch {
      notify(COPY_BLOCKED);
    }
  };

  const copySegment = () => {
    if (!report) return;
    if (!includedRows(segment).length) {
      notify(NOTHING_INCLUDED);
      return;
    }
    void copyText(buildClipboardText(results, settings), segment.short);
  };

  const copyAllSegments = () => {
    if (!report) return;
    const blocks = allSegmentResults(report).map(([s, rows]): [string, ResultRow[]] => [s.short, rows]);
    void copyText(buildAllSegmentsText(blocks, settings, settings.layout), "all segments");
  };

  const exportToExcel = async () => {
    if (!report) return;
    const fileName = `${withoutExtension(report.fileName)}_summary.xlsx`;
    try {
      downloadFile(await exportXlsx(report, allSegmentResults(report), excluded), fileName);
      notify(exportedMessage(fileName));
    } catch {
      notify(EXPORT_FAILED);
    }
  };

  const toggleRow = (index: number) =>
    setExcluded((current) => {
      const next = new Set(current);
      if (!next.delete(index)) next.add(index);
      return next;
    });

  const setAllVisible = (include: boolean) =>
    setExcluded((current) => {
      const next = new Set(current);
      visibleRows.forEach((index) => (include ? next.delete(index) : next.add(index)));
      return next;
    });

  return (
    <div className="app">
      <Header
        ref={fileInput}
        fileSummary={summarizeFile(report)}
        isReading={isReading}
        onChooseFile={chooseFile}
        onFileChosen={(file) => void openFile(file)}
      />

      <SegmentTabs report={report} active={segment} excluded={excluded} onSelect={selectSegment} />

      <main className="body">
        <CampaignList
          report={report}
          segment={segment}
          rowIndices={visibleRows}
          excluded={excluded}
          onToggle={toggleRow}
          onSetAll={setAllVisible}
        />

        <section className="card summary">
          <div className="card-head">
            <h2>{segment.label}</h2>
          </div>
          <ResultsTable report={report} results={results} decimalSeparator={settings.decimalSeparator} />
          {report && <SkippedColumnsNote skipped={report.skipped} />}
          <CopyOptionsPanel settings={settings} onChange={updateSettings} />
          <div className="actions">
            <button className="btn" onClick={() => void exportToExcel()} disabled={!report}>
              Export to Excel
            </button>
            <button className="btn" onClick={copyAllSegments} disabled={!report}>
              Copy all segments
            </button>
            <button className="btn accent" onClick={copySegment} disabled={!report}>
              Copy segment
            </button>
          </div>
        </section>
      </main>

      <Toasts toasts={toasts} onDismiss={dismiss} />

      {isDragging && (
        <div className="drop-overlay">
          <p>Drop the SA360 export to open it</p>
        </div>
      )}
    </div>
  );
}
