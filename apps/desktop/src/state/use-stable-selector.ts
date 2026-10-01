/**
 * Store subscriptions for things derived from `jobs`.
 *
 * `jobs` gets a new identity on every pty chunk and log line (see
 * applyHighRateBatch), so a component that selects it — or selects a fresh
 * Set/Map/array computed from it — re-renders on every flush of a streaming
 * run, even when nothing it shows changed. That is what kept the Runs grid
 * rebuilding its columns ten times a second during a flood. These hooks keep
 * the previous result while `isEqual` says it is the same, so the component
 * re-renders only when its own slice actually changed.
 */
import { useRef } from 'react';
import { useAppStore, type AppState } from './store.ts';

export function useAppStoreStable<T>(selector: (state: AppState) => T, isEqual: (a: T, b: T) => boolean): T {
  const previous = useRef<{ value: T } | null>(null);
  return useAppStore(state => {
    const next = selector(state);
    if (previous.current !== null && isEqual(previous.current.value, next)) return previous.current.value;
    previous.current = { value: next };
    return next;
  });
}

export function sameSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/** For liveStageProgress's runId → { index, total }. */
export function sameStageProgress(
  a: ReadonlyMap<string, { index: number; total: number }>,
  b: ReadonlyMap<string, { index: number; total: number }>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [runId, progress] of a) {
    const other = b.get(runId);
    if (other === undefined || other.index !== progress.index || other.total !== progress.total) return false;
  }
  return true;
}
