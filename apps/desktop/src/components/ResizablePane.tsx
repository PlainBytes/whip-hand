/**
 * The left pane of a two-pane row (file tree | preview) with a drag handle on
 * its right edge. Renders the pane and the handle as siblings, so the page
 * keeps its own flex row and puts the preview next as the following sibling.
 * The 8px handle stands where the rows' `gap` used to, so at rest the layout
 * is unchanged.
 *
 * The width is clamped to [minWidth, maxFraction × parent width] so the
 * preview always keeps its share, and persisted per `storageKey` so each view
 * remembers its own.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';

export interface ResizablePaneProps {
  storageKey: string;
  defaultWidth?: number;
  minWidth?: number;
  /** Largest share of the parent's width the pane may take. */
  maxFraction?: number;
  children: ReactNode;
}

const HANDLE_WIDTH = 8;
const KEY_STEP = 16;

function readStoredWidth(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function storeWidth(key: string, width: number): void {
  try {
    window.localStorage.setItem(key, String(Math.round(width)));
  } catch {
    // Storage unavailable or full: the width just won't persist.
  }
}

export function ResizablePane({
  storageKey,
  defaultWidth = 320,
  minWidth = 200,
  maxFraction = 0.6,
  children,
}: ResizablePaneProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => readStoredWidth(storageKey) ?? defaultWidth);
  // Unknown until measured; until then only the lower bound is enforced.
  const [maxWidth, setMaxWidth] = useState<number | null>(null);
  const [active, setActive] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const maxFor = useCallback((): number => {
    const parentWidth = paneRef.current?.parentElement?.getBoundingClientRect().width ?? 0;
    // An unmeasured (or zero-width) parent must not collapse the pane to min.
    return parentWidth > 0 ? Math.max(minWidth, parentWidth * maxFraction) : Infinity;
  }, [minWidth, maxFraction]);

  const clamp = useCallback(
    (value: number) => Math.min(Math.max(value, minWidth), maxFor()),
    [minWidth, maxFor],
  );

  const measure = useCallback(() => {
    const max = maxFor();
    setMaxWidth(Number.isFinite(max) ? max : null);
    setWidth(current => clamp(current));
  }, [maxFor, clamp]);

  useEffect(() => {
    measure();
    const parent = paneRef.current?.parentElement;
    if (!parent || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [measure]);

  const commit = (next: number) => {
    const clamped = clamp(next);
    setWidth(clamped);
    storeWidth(storageKey, clamped);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { startX: event.clientX, startWidth: width };
    setDragging(true);
    document.body.style.userSelect = 'none';
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setWidth(clamp(drag.startWidth + event.clientX - drag.startX));
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setDragging(false);
    document.body.style.userSelect = '';
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    commit(drag.startWidth + event.clientX - drag.startX);
  };

  // A drag interrupted by unmount must not leave the page unselectable.
  useEffect(() => () => {
    document.body.style.userSelect = '';
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowLeft': commit(width - KEY_STEP); break;
      case 'ArrowRight': commit(width + KEY_STEP); break;
      case 'Home': commit(minWidth); break;
      case 'End': commit(maxFor()); break;
      default: return;
    }
    event.preventDefault();
  };

  const lit = active || dragging;

  return (
    <>
      <div
        ref={paneRef}
        style={{ width, flexShrink: 0, minHeight: 0, display: 'flex', overflow: 'hidden' }}
      >
        {children}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize file list"
        aria-valuenow={Math.round(width)}
        aria-valuemin={minWidth}
        aria-valuemax={Math.round(maxWidth ?? Math.max(width, defaultWidth))}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => commit(defaultWidth)}
        onKeyDown={onKeyDown}
        onMouseEnter={() => setActive(true)}
        onMouseLeave={() => setActive(false)}
        onFocus={() => setActive(true)}
        onBlur={() => setActive(false)}
        style={{
          width: HANDLE_WIDTH,
          flexShrink: 0,
          cursor: 'col-resize',
          touchAction: 'none',
          outline: 'none',
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            width: 2,
            height: '100%',
            borderRadius: 1,
            background: lit ? 'var(--colorNeutralStroke1Hover)' : 'transparent',
          }}
        />
      </div>
    </>
  );
}
