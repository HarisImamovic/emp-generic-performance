export type ReportErrorCode = "unsupported-file" | "legacy-xls" | "not-an-export" | "unreadable-file" | "too-large";

export class ReportError extends Error {
  constructor(
    readonly code: ReportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ReportError";
  }
}
