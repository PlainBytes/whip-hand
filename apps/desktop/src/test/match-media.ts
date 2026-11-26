import { vi } from 'vitest';

export interface Screen { width: number; height: number; coarse: boolean }

/**
 * Judges the media queries the app uses against `screen`: comma-separated
 * alternatives of `and`-joined `(max-width: Npx)`, `(max-height: Npx)` and
 * `(pointer: coarse|fine)`. Any other feature (Fluent UI asks about
 * reduced motion, say) never matches.
 */
export function evaluateQuery(query: string, screen: Screen): boolean {
  return query.split(',').some(alt => alt.split(/\band\b/).every(part => {
    const feature = /^\s*\(([\w-]+):\s*([\w-]+?)(px)?\)\s*$/.exec(part);
    if (!feature) return false;
    const [, name, value] = feature;
    if (name === 'max-width') return screen.width <= Number(value);
    if (name === 'max-height') return screen.height <= Number(value);
    if (name === 'pointer') return value === (screen.coarse ? 'coarse' : 'fine');
    return false;
  }));
}

/**
 * A matchMedia stub judged against a screen that can change. A change fires
 * every listener with its own query's `{ matches, media }`, as a browser would.
 */
export function stubScreen(initial: Screen) {
  type Listener = (event: { matches: boolean; media: string }) => void;
  const listeners = new Map<Listener, string>();
  let screen = initial;
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return evaluateQuery(query, screen); },
    media: query,
    addEventListener: (_: string, fn: Listener) => listeners.set(fn, query),
    removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
  }));
  return {
    change(next: Screen) {
      screen = next;
      listeners.forEach((media, fn) => fn({ matches: evaluateQuery(media, screen), media }));
    },
    listeners,
  };
}

export const PHONE_PORTRAIT: Screen = { width: 390, height: 844, coarse: true };
export const PHONE_LANDSCAPE: Screen = { width: 844, height: 390, coarse: true };
export const TABLET: Screen = { width: 1180, height: 820, coarse: true };
export const SHORT_DESKTOP_WINDOW: Screen = { width: 1200, height: 400, coarse: false };
