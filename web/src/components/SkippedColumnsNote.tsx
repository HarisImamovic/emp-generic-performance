interface SkippedColumnsNoteProps {
  skipped: string[];
}

export function SkippedColumnsNote({ skipped }: SkippedColumnsNoteProps) {
  if (!skipped.length) return null;
  return (
    <p className="note" title="These columns can't be totalled across campaigns, so they're left out.">
      <span aria-hidden="true">ⓘ</span> Not included: {skipped.join(", ")}
    </p>
  );
}
