/**
 * Identifies one *execution*. A loop runs the same step id many times, so an
 * id alone no longer addresses a row — this is the same `iteration ?? 1`
 * defaulting `beginStep` (engine/manifest.ts) matches entries by, spelled once
 * so that resume, the engine and the desktop cannot drift apart on it.
 *
 * Deliberately dependency-free, unlike engine/manifest.ts (which imports
 * node:fs): the desktop bundle takes no runtime dependency on @whiphand/core
 * beyond its types, except this one function, which it imports directly
 * because it is safe to pull into the web bundle.
 */
export function executionKey(stepId: string, iteration?: number): string {
  return iteration === undefined || iteration === 1 ? stepId : `${stepId}#${iteration}`;
}
