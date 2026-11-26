/**
 * Whether this screen joins a live terminal as a guest: it takes the PTY's
 * size and never reports one. A phone is a guest in both orientations, so
 * rotating it never resizes the PTY the desktop is also showing.
 *
 * Portrait is caught by the narrow-layout width. Landscape is wider than that,
 * so a touch screen that is short is a phone too. One combined query, so a
 * rotation is a single evaluation rather than two queries flipping in turn.
 * A tablet (taller than the limit) and a short mouse-driven window stay `fit`.
 */
import { useSyncExternalStore } from 'react';
import { NARROW_MAX_WIDTH } from './use-narrow-layout.ts';

/** The tallest a touch screen can be and still count as a phone on its side. */
export const PHONE_LANDSCAPE_MAX_HEIGHT = 500;
const QUERY = `(max-width: ${NARROW_MAX_WIDTH}px), (pointer: coarse) and (max-height: ${PHONE_LANDSCAPE_MAX_HEIGHT}px)`;

/** jsdom (vitest) doesn't implement matchMedia, so there it is never a guest. */
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

export function useTerminalGuest(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
