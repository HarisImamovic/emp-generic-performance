import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { moveItem } from "../core/metricFilter";
import type { ResultRow } from "../core/report";
import { useDismiss } from "../hooks/useDismiss";

interface MetricPickerProps {
  metrics: ResultRow[];
  hiddenKeys: ReadonlySet<string>;
  onChange: (hiddenKeys: string[]) => void;
  onReorder: (keys: string[]) => void;
  isCustomOrder: boolean;
  onResetOrder: () => void;
}

interface Drag {
  key: string;
  pointerId: number;
  pointerY: number;
  order: string[];
}

function GripIcon() {
  return (
    <svg className="grip" viewBox="0 0 10 16" width="10" height="16" aria-hidden="true">
      {[3, 8, 13].flatMap((y) => [
        <circle key={`l${y}`} cx="2.5" cy={y} r="1.5" />,
        <circle key={`r${y}`} cx="7.5" cy={y} r="1.5" />,
      ])}
    </svg>
  );
}

const SCROLL_ZONE = 36;
const SCROLL_SPEED = 10;

export function MetricPicker({
  metrics,
  hiddenKeys,
  onChange,
  onReorder,
  isCustomOrder,
  onResetOrder,
}: MetricPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const items = useRef(new Map<string, HTMLLIElement>());
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterMove = useRef<string | null>(null);
  const panelId = useId();
  const close = useCallback(() => {
    setDrag(null);
    setIsOpen(false);
  }, []);
  useDismiss(container, isOpen, close);

  const byKey = new Map(metrics.map((m) => [m.key, m]));
  const order = drag?.order ?? metrics.map((m) => m.key);
  const shownCount = metrics.filter((m) => !hiddenKeys.has(m.key)).length;
  const keysInFile = new Set(byKey.keys());
  const hiddenElsewhere = [...hiddenKeys].filter((key) => !keysInFile.has(key));

  const toggle = (key: string) => {
    const next = new Set(hiddenKeys);
    if (!next.delete(key)) next.add(key);
    onChange([...next]);
  };
  const showAll = () => onChange(hiddenElsewhere);
  const hideAll = () => onChange([...hiddenElsewhere, ...keysInFile]);

  const announceMove = (key: string, keys: string[]) =>
    setAnnouncement(`${byKey.get(key)?.label}, position ${keys.indexOf(key) + 1} of ${keys.length}`);

  useEffect(() => {
    const key = focusAfterMove.current;
    focusAfterMove.current = null;
    if (key) handles.current.get(key)?.focus();
  });

  const handleKeyDown = (event: ReactKeyboardEvent, key: string) => {
    const from = order.indexOf(key);
    const to = { ArrowUp: from - 1, ArrowDown: from + 1, Home: 0, End: order.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    if (to < 0 || to >= order.length || to === from) return;
    const next = moveItem(order, from, to);
    focusAfterMove.current = key;
    onReorder(next);
    announceMove(key, next);
  };

  const targetIndex = (current: Drag): number => {
    return current.order.filter((key) => {
      if (key === current.key) return false;
      const rect = items.current.get(key)?.getBoundingClientRect();
      return rect !== undefined && rect.top + rect.height / 2 < current.pointerY;
    }).length;
  };

  const withTarget = (current: Drag): Drag => {
    const to = targetIndex(current);
    const from = current.order.indexOf(current.key);
    return to === from ? current : { ...current, order: moveItem(current.order, from, to) };
  };

  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>, key: string) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    setDrag({ key, pointerId: event.pointerId, pointerY: event.clientY, order: metrics.map((m) => m.key) });
  };

  const moveDrag = (event: ReactPointerEvent) => {
    if (drag?.pointerId !== event.pointerId) return;
    setDrag(withTarget({ ...drag, pointerY: event.clientY }));
  };

  const endDrag = (event: ReactPointerEvent) => {
    if (drag?.pointerId !== event.pointerId) return;
    setDrag(null);
    const before = metrics.map((m) => m.key);
    if (drag.order.some((key, index) => key !== before[index])) {
      focusAfterMove.current = drag.key;
      onReorder(drag.order);
      announceMove(drag.key, drag.order);
    }
  };

  const cancelDrag = (event: ReactPointerEvent) => {
    if (drag?.pointerId === event.pointerId) setDrag(null);
  };

  const isDragging = drag !== null;
  const latestDrag = useRef(drag);
  latestDrag.current = drag;
  useEffect(() => {
    if (!isDragging) return;
    let frame = requestAnimationFrame(function step() {
      const current = latestDrag.current;
      const box = list.current?.getBoundingClientRect();
      if (current && box && list.current) {
        const speed =
          current.pointerY < box.top + SCROLL_ZONE
            ? -SCROLL_SPEED
            : current.pointerY > box.bottom - SCROLL_ZONE
              ? SCROLL_SPEED
              : 0;
        const before = list.current.scrollTop;
        if (speed) list.current.scrollTop += speed;
        if (list.current.scrollTop !== before) setDrag((d) => d && withTarget(d));
      }
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [isDragging]);

  return (
    <div className="metric-picker" ref={container}>
      <button
        className={`btn small${shownCount < metrics.length || isCustomOrder ? " filtered" : ""}`}
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        aria-controls={panelId}
      >
        Metrics {shownCount}/{metrics.length}
        <span aria-hidden="true">▾</span>
      </button>
      {isOpen && (
        <div className="picker-panel" id={panelId} role="group" aria-label="Metrics to show and copy">
          <div className="picker-bar">
            <span className="muted small">Show, copy and order</span>
            <span>
              <button className="link" onClick={showAll}>
                All
              </button>
              <button className="link" onClick={hideAll}>
                None
              </button>
            </span>
          </div>
          <ul ref={list} className={drag ? "is-dragging" : undefined}>
            {order.map((key, index) => {
              const metric = byKey.get(key);
              if (!metric) return null;
              const isHidden = hiddenKeys.has(key);
              return (
                <li
                  key={key}
                  ref={(el) => (el ? items.current.set(key, el) : items.current.delete(key))}
                  className={`${drag?.key === key ? "dragged" : ""}${isHidden ? " off" : ""}`}
                >
                  <button
                    type="button"
                    className="drag-handle"
                    ref={(el) => (el ? handles.current.set(key, el) : handles.current.delete(key))}
                    aria-label={`Move ${metric.label}, position ${index + 1} of ${order.length}`}
                    title="Drag to reorder, or use the arrow keys"
                    onPointerDown={(event) => startDrag(event, key)}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={cancelDrag}
                    onKeyDown={(event) => handleKeyDown(event, key)}
                  >
                    <GripIcon />
                  </button>
                  <label>
                    <input type="checkbox" checked={!isHidden} onChange={() => toggle(key)} />
                    <span>{metric.label}</span>
                    {metric.isDerived && <span className="derived">ƒ</span>}
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="picker-foot">
            <p className="muted small picker-note">
              Drag <GripIcon /> to change the order. Hidden metrics are left out of the table, copies and Excel export.
            </p>
            {isCustomOrder && (
              <button className="link" onClick={onResetOrder}>
                Reset order
              </button>
            )}
          </div>
          <span className="sr-only" aria-live="polite">
            {announcement}
          </span>
        </div>
      )}
    </div>
  );
}
