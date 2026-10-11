import { useCallback, useEffect, useRef } from 'react';

/** How long a click waits for a second one; the OS default is around 500ms, but this only has to beat a deliberate double click. */
export const DOUBLE_CLICK_MS = 250;

/**
 * Tells a click from the first half of a double click. A click that opens a
 * tab swaps the list for the run's page, so the second click and the
 * `dblclick` land on the new page and never reach the row. The click is
 * therefore held back for `DOUBLE_CLICK_MS`; a double click inside that window
 * replaces it with a pinned open.
 */
export function useClickOrDoubleClick<T>(open: (value: T, pin: boolean) => void): {
  click: (value: T) => void;
  doubleClick: (value: T) => void;
} {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  const clear = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => clear, [clear]);

  const click = useCallback((value: T) => {
    clear();
    timer.current = setTimeout(() => {
      timer.current = null;
      openRef.current(value, false);
    }, DOUBLE_CLICK_MS);
  }, [clear]);
  const doubleClick = useCallback((value: T) => {
    clear();
    openRef.current(value, true);
  }, [clear]);
  return { click, doubleClick };
}
