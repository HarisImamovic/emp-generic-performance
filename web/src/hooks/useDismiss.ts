import { type RefObject, useEffect } from "react";

export function useDismiss(container: RefObject<HTMLElement>, isOpen: boolean, onDismiss: () => void): void {
  useEffect(() => {
    if (!isOpen) return;
    const handlePointer = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) onDismiss();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    document.addEventListener("pointerdown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [container, isOpen, onDismiss]);
}
