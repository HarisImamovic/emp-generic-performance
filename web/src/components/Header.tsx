import { forwardRef } from "react";
import { ACCEPTED_EXTENSIONS } from "../core/read";
import { SHORTCUT_PREFIX, SIGN_OUT_URL } from "../platform";

const ACCEPTED_FILES = ACCEPTED_EXTENSIONS.join(",");

interface HeaderProps {
  fileSummary: string;
  isReading: boolean;
  onChooseFile: () => void;
  onFileChosen: (file: File) => void;
}

export const Header = forwardRef<HTMLInputElement, HeaderProps>(function Header(
  { fileSummary, isReading, onChooseFile, onFileChosen },
  fileInput,
) {
  return (
    <header className="topbar">
      <div className="topbar-text">
        <h1>Generic Performance</h1>
        <p className="file-info">{fileSummary}</p>
      </div>
      <button className="btn accent" onClick={onChooseFile} disabled={isReading}>
        {isReading ? "Reading…" : "Open export…"}
        <kbd>{SHORTCUT_PREFIX}O</kbd>
      </button>
      {SIGN_OUT_URL && (
        <a className="btn ghost" href={SIGN_OUT_URL}>
          Sign out
        </a>
      )}
      <input
        ref={fileInput}
        type="file"
        accept={ACCEPTED_FILES}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onFileChosen(file);
        }}
      />
    </header>
  );
});
