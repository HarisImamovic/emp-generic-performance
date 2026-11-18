import { useCallback, useEffect, useRef, useState } from "react";

export type ToastTone = "success" | "error" | "warning" | "info";

export interface ToastMessage {
  tone: ToastTone;
  title: string;
  detail?: string;
}

export interface Toast extends ToastMessage {
  id: number;
}

const VISIBLE_MS: Record<ToastTone, number> = { success: 3500, info: 4500, warning: 8000, error: 10000 };
const MAX_VISIBLE = 4;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback(
    (message: ToastMessage) => {
      const id = nextId.current++;
      setToasts((current) => [...current, { ...message, id }].slice(-MAX_VISIBLE));
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), VISIBLE_MS[message.tone]),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => window.clearTimeout(timer));
  }, []);

  return { toasts, notify, dismiss };
}
