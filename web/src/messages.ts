import { ReportError, type ReportErrorCode } from "./core/errors";
import { MAX_FILE_MB } from "./core/read";
import { type Report, missingCompared } from "./core/report";
import type { ToastMessage } from "./hooks/useToasts";
import { SHORTCUT_PREFIX } from "./platform";

const LOAD_ERRORS: Record<ReportErrorCode, Omit<ToastMessage, "tone">> = {
  "not-an-export": {
    title: "This doesn't look like an SA360 campaign export",
    detail: "No Cost and Clicks or Impr. columns were found. Export the campaign report from SA360 and try again.",
  },
  "legacy-xls": {
    title: "Old Excel format (.xls) isn't supported",
    detail: "Export the report from SA360 as .xlsx or .csv instead.",
  },
  "unsupported-file": {
    title: "That file type isn't supported",
    detail: "Choose the .xlsx or .csv file you downloaded from SA360.",
  },
  "too-large": {
    title: "This file is too large",
    detail: `Files up to ${MAX_FILE_MB} MB can be opened. SA360 campaign exports are much smaller, so check that you picked the right file.`,
  },
  "unreadable-file": {
    title: "Couldn't open this Excel file",
    detail: "It may be damaged or password-protected. Try downloading the export from SA360 again.",
  },
};

export function loadErrorMessage(error: unknown): ToastMessage {
  if (error instanceof ReportError) return { tone: "error", ...LOAD_ERRORS[error.code] };
  return {
    tone: "error",
    title: "Something went wrong reading the file",
    detail: error instanceof Error ? error.message : String(error),
  };
}

export function loadMessages(report: Report): ToastMessage[] {
  const messages: ToastMessage[] = [
    {
      tone: "success",
      title: `Opened ${report.fileName}`,
      detail: `${report.rows.length} rows · ${report.metrics.length} metrics`,
    },
  ];
  if (report.campaignCol === null) {
    messages.push({
      tone: "warning",
      title: "No Campaign column found",
      detail: "Campaigns can't be sorted into segments. Include the Campaign column in the SA360 export.",
    });
  }
  const missing = missingCompared(report);
  if (missing.length) {
    messages.push({
      tone: "warning",
      title: "Some metrics have no comparison period",
      detail: `Turn on the date comparison in SA360 before exporting. Missing for: ${missing.join(", ")}.`,
    });
  }
  return messages;
}

export function copiedMessage(what: string): ToastMessage {
  return { tone: "success", title: `Copied ${what}`, detail: `Paste into Excel with ${SHORTCUT_PREFIX}V.` };
}

export const COPY_BLOCKED: ToastMessage = {
  tone: "error",
  title: "Couldn't copy to the clipboard",
  detail: "Your browser blocked it. Allow clipboard access for this site and try again.",
};

export const NOTHING_INCLUDED: ToastMessage = {
  tone: "warning",
  title: "No campaigns included",
  detail: "Tick at least one campaign in this segment to copy it.",
};

export const EXPORT_FAILED: ToastMessage = {
  tone: "error",
  title: "Couldn't create the Excel file",
  detail: "Please try again. If it keeps failing, reload the page and open the export again.",
};

export function exportedMessage(fileName: string): ToastMessage {
  return { tone: "success", title: "Excel file downloaded", detail: fileName };
}

export const NO_METRICS_SHOWN: ToastMessage = {
  tone: "warning",
  title: "No metrics selected",
  detail: "Choose at least one metric under Metrics to copy or export.",
};

export const FIRST_FILE_ONLY: ToastMessage = {
  tone: "info",
  title: "Opened the first file only",
  detail: "Drop one SA360 export at a time.",
};
