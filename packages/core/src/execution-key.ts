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
 * A `stages` step (running a workflow body once per stage file) adds a third:
 * the same body can run once per stage, and again per retry attempt within a
 * stage, so a `StageFrame` needs its own always-explicit key segment — see
 * `executionKey`'s `stage` parameter. A stage frame is otherwise deliberately
 * *loop-shaped* (`frameRef`, `frameIdentity`): it folds into `outerLoops` and
 * `loopId`/`iteration` exactly like a loop would, so nothing that already
 * treats those as "my container" has to learn a second parenting concept.
 *
 * Deliberately dependency-free, unlike engine/manifest.ts (which imports
 * node:fs): the desktop bundle takes no runtime dependency on @whiphand/core
 * beyond its types, except this one function, which it imports directly
 * because it is safe to pull into the web bundle. `Frame`/`LoopFrame`/
 * `LoopRef`/`StageFrame` are type-only imports, so they add nothing at runtime
 * either.
 */
import type { Frame, LoopFrame, LoopRef, StageFrame } from './types.ts';

/** True for a `stages` frame — the one case a plain `LoopFrame` check can't tell apart, since `LoopFrame` carries no `kind` of its own. */
export function isStageFrame(frame: Frame | undefined): frame is StageFrame {
  return frame !== undefined && 'kind' in frame && frame.kind === 'stages';
}

/**
 * The nearest enclosing `LoopFrame`, walking up past any stage frames in the
 * way — what `RunCtx.loop` is set to, so every consumer that only ever knew
 * about loops keeps seeing exactly what it always did.
 */
export function nearestLoop(frame: Frame | undefined): LoopFrame | undefined {
  let f = frame;
  while (f !== undefined && isStageFrame(f)) f = f.parent;
  return f;
}

/** The nearest enclosing `StageFrame`, walking up past any loop frames in the way. */
export function nearestStage(frame: Frame | undefined): StageFrame | undefined {
  let f = frame;
  while (f !== undefined && !isStageFrame(f)) f = f.parent;
  return f;
}

/**
 * One frame, folded into the loop-shaped ref every `outerLoops` entry is made
 * of. A stage frame's `iteration` is its attempt number, and its `stage`
 * names the stage file — the two extra bits a plain loop has no use for.
 */
export function frameRef(frame: Frame): LoopRef {
  return isStageFrame(frame)
    ? { id: frame.id, iteration: frame.attempt, stage: frame.stage.id }
    : { id: frame.id, iteration: frame.iteration };
}

/**
 * The chain of frames enclosing `frame`, outermost first — everything beyond
 * `frame` itself, which a caller already has as `frame.id`/`frame.iteration`
 * (or `frameRef(frame)`). Empty for a top-level frame, or when `frame` is
 * absent.
 */
export function ancestorLoops(frame: Frame | undefined): LoopRef[] {
  const chain: LoopRef[] = [];
  let f = frame?.parent;
  while (f !== undefined) {
    chain.unshift(frameRef(f));
    f = f.parent;
  }
  return chain;
}

export function executionKey(
  stepId: string, iteration?: number, outerLoops: readonly LoopRef[] = [], stage?: string,
): string {
  // With no outer loops, iteration 1 (or absent) is dropped — the original
  // single-level rule, preserved exactly. Once there is an outer loop to
  // disambiguate rounds from, every segment gets an explicit iteration: the
  // round number is precisely the information that makes the key unique.
  const bare = outerLoops.length === 0;
  // A stage segment is never bare: two stages of one stages step must not
  // collapse onto one key, even at attempt 1 with no outer loop at all.
  const segment = (id: string, n: number | undefined, s: string | undefined): string => {
    if (s !== undefined) return `${id}@${s}#${n ?? 1}`;
    return bare && (n === undefined || n === 1) ? id : `${id}#${n ?? 1}`;
  };
  const prefix = outerLoops.map(l => segment(l.id, l.iteration, l.stage)).join('/');
  const own = segment(stepId, iteration, stage);
  return prefix === '' ? own : `${prefix}/${own}`;
}

/**
 * Order-sensitive equality for two `outerLoops` chains, treating absent as
 * empty — the same identity executionKey folds into a string, compared
 * directly. Shared by the journal (matching a step:start to its manifest row)
 * and the desktop's run tree (deciding which loop round owns a row), which
 * would otherwise each carry a copy that could disagree about whether round 1
 * and round 2 of an enclosing loop are the same place — or, now, about
 * whether two stages of the same stages step are the same place.
 */
export function sameLoopRefs(a: readonly LoopRef[] | undefined, b: readonly LoopRef[] | undefined): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  return aa.length === bb.length
    && aa.every((r, i) => r.id === bb[i].id && r.iteration === bb[i].iteration && r.stage === bb[i].stage);
}

/**
 * Turns a frame into the tuple every emit site, the journal and resume
 * already speak: a `loopId`/`iteration` pair, an optional `stage`, and the
 * `outerLoops` chain beyond it. The single place that does this, so a stage
 * frame's loop-shaped projection is defined once rather than re-derived at
 * every call site:
 * - no frame → `{ outerLoops: [] }`
 * - loop frame → `{ loopId: f.id, iteration: f.iteration, outerLoops: ancestorLoops(f) }`
 * - stage frame → `{ loopId: f.id, iteration: f.attempt, stage: f.stage.id, outerLoops: ancestorLoops(f) }`
 */
export function frameIdentity(
  frame: Frame | undefined,
): { loopId?: string; iteration?: number; stage?: string; outerLoops: LoopRef[] } {
  if (frame === undefined) return { outerLoops: [] };
  const ref = frameRef(frame);
  return { loopId: ref.id, iteration: ref.iteration, stage: ref.stage, outerLoops: ancestorLoops(frame) };
}
