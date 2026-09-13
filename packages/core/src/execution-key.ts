/**
 * Identifies one *execution*. A loop runs the same step id many times, so an
 * id alone no longer addresses a row — this is the same `iteration ?? 1`
 * defaulting `beginStep` (engine/manifest.ts) matches entries by, spelled once
 * so that resume, the engine and the desktop cannot drift apart on it.
 *
 * Nested loops add a second axis: the same `(stepId, iteration)` pair recurs
 * once per round of whatever loop encloses it, so `outerLoops` — the chain of
 * loops beyond the immediate one, outermost first — folds into the key too.
 * Absent or empty, the key is byte-identical to the single-level original.
 *
 * Deliberately dependency-free, unlike engine/manifest.ts (which imports
 * node:fs): the desktop bundle takes no runtime dependency on @whiphand/core
 * beyond its types, except this one function, which it imports directly
 * because it is safe to pull into the web bundle. `LoopFrame`/`LoopRef` are
 * type-only imports, so they add nothing at runtime either.
 */
import type { LoopFrame, LoopRef } from './types.ts';

/**
 * The chain of loops enclosing `frame`, outermost first — everything beyond
 * `frame` itself, which a caller already has as `frame.id`/`frame.iteration`.
 * Empty for a top-level loop, or when `frame` is absent.
 */
export function ancestorLoops(frame: LoopFrame | undefined): LoopRef[] {
  const chain: LoopRef[] = [];
  let f = frame?.parent;
  while (f !== undefined) {
    chain.unshift({ id: f.id, iteration: f.iteration });
    f = f.parent;
  }
  return chain;
}

export function executionKey(stepId: string, iteration?: number, outerLoops: readonly LoopRef[] = []): string {
  // With no outer loops, iteration 1 (or absent) is dropped — the original
  // single-level rule, preserved exactly. Once there is an outer loop to
  // disambiguate rounds from, every segment gets an explicit iteration: the
  // round number is precisely the information that makes the key unique.
  const segment = (id: string, n: number | undefined): string =>
    outerLoops.length === 0 && (n === undefined || n === 1) ? id : `${id}#${n ?? 1}`;
  const prefix = outerLoops.map(l => segment(l.id, l.iteration)).join('/');
  const own = segment(stepId, iteration);
  return prefix === '' ? own : `${prefix}/${own}`;
}
