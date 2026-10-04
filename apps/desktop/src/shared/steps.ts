/**
 * Narrowing and traversal helpers for the step tree (whiphand-core's
 * steps.rs). Kept out of types.ts, which stays declaration-only.
 */
import type { AgentStep, CommandStep, LoopStep, ManualStep, StagesStep, Step } from './types.ts';

export function isAgentStep(step: Step): step is AgentStep {
  return step.kind === 'agent';
}
export function isCommandStep(step: Step): step is CommandStep {
  return step.kind === 'command';
}
export function isManualStep(step: Step): step is ManualStep {
  return step.kind === 'manual' || step.kind === 'approval';
}
export function isLoopStep(step: Step): step is LoopStep {
  return step.kind === 'loop';
}
export function isStagesStep(step: Step): step is StagesStep {
  return step.kind === 'stages';
}

/**
 * A step whose body runs more than once — repeatedly (`loop`) or once per
 * stage file (`stages`) — rather than producing one artifact of its own.
 * The single narrowing every "recurse into the tree" and "this step has no
 * artifact" check goes through, so a `stages` body is never silently skipped
 * by code that only ever knew about `loop`.
 */
export function isContainerStep(step: Step): step is LoopStep | StagesStep {
  return isLoopStep(step) || isStagesStep(step);
}

/** Every step kind except a container (`loop` or `stages`) can write an artifact and be referenced. */
export function isLeafStep(step: Step): step is AgentStep | CommandStep | ManualStep {
  return !isContainerStep(step);
}

/** A container's own body; `[]` for a leaf step. */
export function childSteps(step: Step): Step[] {
  return isContainerStep(step) ? step.steps : [];
}

export interface FlatStep {
  step: Step;
  /** id of the enclosing loop, when this step is a direct loop body member. */
  loopId?: string;
  /** id of the enclosing `stages` step, at any depth (through any number of nested loops). */
  stagesId?: string;
  /** 0 for top-level steps, 1 for a container's body, and so on. */
  depth: number;
}

/**
 * The declared plan in document order, containers expanded exactly once: a
 * loop or a `stages` step appears immediately before its body. This is the
 * shape the run manifest seeds itself from and the desktop stepper renders —
 * it is *not* an execution order, since a loop body runs many times and a
 * `stages` body runs once per stage file.
 *
 * `stagesId` threads through nested loops (a `stages` body may contain a
 * loop), because it names the enclosing plan file's owner, not the immediate
 * parent — `loopId`, by contrast, is deliberately reset on entering a
 * `stages` body: a `stages` step cannot itself sit inside a loop (schema.ts
 * refuses it), so there is never an enclosing loop to preserve there.
 */
export function flattenSteps(steps: Step[], loopId?: string, stagesId?: string, depth = 0): FlatStep[] {
  const out: FlatStep[] = [];
  for (const step of steps) {
    out.push({ step, loopId, stagesId, depth });
    if (isLoopStep(step)) out.push(...flattenSteps(step.steps, step.id, stagesId, depth + 1));
    else if (isStagesStep(step)) out.push(...flattenSteps(step.steps, undefined, step.id, depth + 1));
  }
  return out;
}

/** Depth-first lookup by id across the whole tree. */
export function findStep(steps: Step[], id: string): Step | undefined {
  for (const step of steps) {
    if (step.id === id) return step;
    const nested = findStep(childSteps(step), id);
    if (nested) return nested;
  }
  return undefined;
}

/** Every loop in the tree, outermost first — a `stages` step's own body loops included. */
export function collectLoops(steps: Step[]): LoopStep[] {
  return flattenSteps(steps).map(f => f.step).filter(isLoopStep);
}
