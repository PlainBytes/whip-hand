/**
 * The one switch the phone layout keys off: viewport width, not host. A
 * narrow desktop window gets it too, and a wide browser tab does not.
 */
import { useSyncExternalStore } from 'react';

export const NARROW_MAX_WIDTH = 720;
const QUERY = `(max-width: ${NARROW_MAX_WIDTH}px)`;

/** jsdom (vitest) doesn't implement matchMedia, so there it is never narrow. */
function supported(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

function subscribe(onChange: () => void): () => void {
  if (!supported()) return () => {};
  const mql = window.matchMedia(QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  return supported() && window.matchMedia(QUERY).matches;
}

export function useNarrowLayout(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
