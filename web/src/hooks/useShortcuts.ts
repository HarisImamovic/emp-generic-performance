import { useEffect } from "react";

interface Shortcuts {
  onOpen: () => void;
  onSegmentKey: (index: number) => void;
}

const SEGMENT_KEY = /^[1-4]$/;

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest("input, select, textarea") !== null;
}

export function useShortcuts({ onOpen, onSegmentKey }: Shortcuts): void {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const withModifier = event.ctrlKey || event.metaKey;
      if (withModifier && event.key.toLowerCase() === "o") {
        event.preventDefault();
        onOpen();
      } else if (!withModifier && !event.altKey && !isTyping(event.target) && SEGMENT_KEY.test(event.key)) {
        onSegmentKey(Number(event.key) - 1);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onOpen, onSegmentKey]);
}
