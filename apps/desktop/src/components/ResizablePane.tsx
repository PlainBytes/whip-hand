/**
 * A pane of a two-pane layout with a drag handle on one edge. Renders the pane
 * and the handle as siblings, so the page keeps its own flex container and
 * puts the other pane next as the following sibling.
 *
 * `axis="width"` (default) is the left pane of a row (file tree | preview): the
 * handle sits on its right edge, drags with `clientX` and the arrow keys are
 * Left/Right. The 8px handle stands where the row's `gap` used to, so at rest
 * the layout is unchanged.
 *
 * `axis="height"` is the top pane of a column: the handle sits below it, drags
 * with `clientY` and the arrow keys are Up/Down. With `fit` the size is applied
 * as `maxHeight`, so the pane still shrinks to fit shorter content. That size
 * is only a cap, so a `fit` pane's drags and key steps start from what is on
 * screen (its measured size), never from the stored cap, and `aria-valuenow`
 * reports the rendered size.
 *
 * The size is clamped to [minSize, maxFraction × parent size] so the sibling
 * always keeps its share, and persisted per `storageKey` so each view
 * remembers its own. `defaultSize` may be a CSS length string; the pane then
 * renders it as-is until the first drag or key press, which starts from the
 * measured size and stores pixels from then on. Double-clicking the handle
 * goes back to the default (and clears the stored value for a string default).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from 'react';

export interface ResizablePaneProps {
  storageKey: string;
  /** Which dimension the handle resizes. */
  axis?: 'width' | 'height';
  /** Initial size: pixels, or a CSS length used until the first interaction. */
  defaultSize?: number | string;
  /** @deprecated Use `defaultSize`. */
  defaultWidth?: number;
  minSize?: number;
  /** Alias of `minSize`, kept for the width callers. */
  minWidth?: number;
  /** Largest share of the parent's size the pane may take. */
  maxFraction?: number;
  /** Accessible name of the separator. */
  label?: string;
  /** Apply the size as a maximum (`maxHeight`) so the pane can shrink to fit. */
  fit?: boolean;
  children: ReactNode;
}

const HANDLE_SIZE = 8;
const KEY_STEP = 16;
const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 240;
const MIN_WIDTH = 200;
const MIN_HEIGHT = 120;

function readStoredSize(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function storeSize(key: string, size: number): void {
  try {
    window.localStorage.setItem(key, String(Math.round(size)));
  } catch {
    // Storage unavailable or full: the size just won't persist.
  }
}

function clearStoredSize(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage unavailable: nothing persisted to clear.
  }
}

export function ResizablePane({
  storageKey,
  axis = 'width',
  defaultSize,
  defaultWidth,
  minSize,
  minWidth,
  maxFraction = 0.6,
  label = 'Resize file list',
  fit = false,
  children,
}: ResizablePaneProps) {
  const vertical = axis === 'height';
  const dimension = vertical ? 'height' : 'width';
  const min = minSize ?? minWidth ?? (vertical ? MIN_HEIGHT : MIN_WIDTH);
  const fallback = defaultSize ?? defaultWidth ?? (vertical ? DEFAULT_HEIGHT : DEFAULT_WIDTH);
  const numericDefault = typeof fallback === 'number' ? fallback : null;

  const paneRef = useRef<HTMLDivElement>(null);
  // Pixels once known; null while a string default is still in charge.
  const [size, setSize] = useState<number | null>(
    () => readStoredSize(storageKey) ?? numericDefault,
  );
  // Rendered size of the pane, for a string default that has no pixels yet.
  const [measured, setMeasured] = useState(0);
  // Unknown until measured; until then only the lower bound is enforced.
  const [maxSize, setMaxSize] = useState<number | null>(null);
  const [active, setActive] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ start: number; startSize: number } | null>(null);

  const maxFor = useCallback((): number => {
    const parentSize = paneRef.current?.parentElement?.getBoundingClientRect()[dimension] ?? 0;
    // An unmeasured (or zero-sized) parent must not collapse the pane to min.
    return parentSize > 0 ? Math.max(min, parentSize * maxFraction) : Infinity;
  }, [dimension, min, maxFraction]);

  const clamp = useCallback(
    (value: number) => Math.min(Math.max(value, min), maxFor()),
    [min, maxFor],
  );

  const measure = useCallback(() => {
    const max = maxFor();
    setMaxSize(Number.isFinite(max) ? max : null);
    setSize(current => (current === null ? null : clamp(current)));
    const rect = paneRef.current?.getBoundingClientRect();
    if (rect) setMeasured(rect[dimension]);
  }, [maxFor, clamp, dimension]);

  useEffect(() => {
    measure();
    const pane = paneRef.current;
    const parent = pane?.parentElement;
    if (!pane || !parent || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    // With `fit` or a string default, content changes resize the pane alone.
    observer.observe(pane);
    return () => observer.disconnect();
  }, [measure]);

  const onScreenSize = (): number =>
    paneRef.current?.getBoundingClientRect()[dimension] ?? measured;

  /**
   * The size an interaction starts from. With `fit` the stored size is only a
   * cap, so start from what is on screen; otherwise pixels, else what is on screen.
   */
  const currentSize = (): number => (fit ? onScreenSize() : (size ?? onScreenSize()));

  const commit = (next: number) => {
    const clamped = clamp(next);
    setSize(clamped);
    storeSize(storageKey, clamped);
  };

  const reset = () => {
    if (numericDefault !== null) {
      commit(numericDefault);
      return;
    }
    clearStoredSize(storageKey);
    setSize(null);
  };

  const pointerPos = (event: PointerEvent<HTMLDivElement>) =>
    vertical ? event.clientY : event.clientX;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { start: pointerPos(event), startSize: currentSize() };
    setDragging(true);
    document.body.style.userSelect = 'none';
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setSize(clamp(drag.startSize + pointerPos(event) - drag.start));
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setDragging(false);
    document.body.style.userSelect = '';
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    commit(drag.startSize + pointerPos(event) - drag.start);
  };

  // A drag interrupted by unmount must not leave the page unselectable.
  useEffect(() => () => {
    document.body.style.userSelect = '';
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const shrinkKey = vertical ? 'ArrowUp' : 'ArrowLeft';
    const growKey = vertical ? 'ArrowDown' : 'ArrowRight';
    switch (event.key) {
      case shrinkKey: commit(currentSize() - KEY_STEP); break;
      case growKey: commit(currentSize() + KEY_STEP); break;
      case 'Home': commit(min); break;
      case 'End': commit(maxFor()); break;
      default: return;
    }
    event.preventDefault();
  };

  const lit = active || dragging;
  const shown = fit ? measured : (size ?? measured);
  const rendered = size ?? fallback;

  const paneStyle: CSSProperties = vertical
    ? {
        ...(fit ? { maxHeight: rendered } : { height: rendered }),
        flexShrink: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }
    : { width: rendered, flexShrink: 0, minHeight: 0, display: 'flex', overflow: 'hidden' };

  return (
    <>
      <div ref={paneRef} style={paneStyle}>
        {children}
      </div>
      <div
        role="separator"
        aria-orientation={vertical ? 'horizontal' : 'vertical'}
        aria-label={label}
        aria-valuenow={Math.round(shown)}
        aria-valuemin={min}
        aria-valuemax={Math.round(maxSize ?? Math.max(shown, numericDefault ?? 0))}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={reset}
        onKeyDown={onKeyDown}
        onMouseEnter={() => setActive(true)}
        onMouseLeave={() => setActive(false)}
        onFocus={() => setActive(true)}
        onBlur={() => setActive(false)}
        style={{
          ...(vertical ? { height: HANDLE_SIZE } : { width: HANDLE_SIZE }),
          flexShrink: 0,
          cursor: vertical ? 'row-resize' : 'col-resize',
          touchAction: 'none',
          outline: 'none',
          display: 'flex',
          ...(vertical ? { alignItems: 'center' } : { justifyContent: 'center' }),
        }}
      >
        <div
          style={{
            ...(vertical ? { height: 2, width: '100%' } : { width: 2, height: '100%' }),
            borderRadius: 1,
            background: lit ? 'var(--colorNeutralStroke1Hover)' : 'transparent',
          }}
        />
      </div>
    </>
  );
}
