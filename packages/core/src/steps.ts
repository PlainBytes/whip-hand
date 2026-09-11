/**
 * Narrowing and traversal helpers for the step tree.
 *
 * Kept out of types.ts (which stays declaration-only) and out of schema.ts
 * (which pulls in zod) so the engine, the manifest, the CLI and the desktop
 * can all reach for them without dragging a validator along.
 */
import type { AgentStep, CommandStep, LoopStep, ManualStep, Step } from './types.ts';

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

/** Every step kind except `loop` can write an artifact and be referenced. */
export function isLeafStep(step: Step): step is AgentStep | CommandStep | ManualStep {
  return !isLoopStep(step);
}

export interface FlatStep {
  step: Step;
  /** id of the enclosing loop, when this step is a loop body member. */
  loopId?: string;
  /** 0 for top-level steps, 1 for a loop body, and so on. */
  depth: number;
}

/**
 * The declared plan in document order, loops expanded exactly once: a loop
 * appears immediately before its body. This is the shape the run manifest
 * seeds itself from and the desktop stepper renders — it is *not* an
 * execution order, since a loop body runs many times.
 */
export function flattenSteps(steps: Step[], loopId?: string, depth = 0): FlatStep[] {
  const out: FlatStep[] = [];
  for (const step of steps) {
    out.push({ step, loopId, depth });
    if (isLoopStep(step)) out.push(...flattenSteps(step.steps, step.id, depth + 1));
  }
  return out;
}

/** Depth-first lookup by id across the whole tree. */
export function findStep(steps: Step[], id: string): Step | undefined {
  for (const step of steps) {
    if (step.id === id) return step;
    if (isLoopStep(step)) {
      const nested = findStep(step.steps, id);
      if (nested) return nested;
    }
  }
  return undefined;
}

/** Every loop in the tree, outermost first. */
export function collectLoops(steps: Step[]): LoopStep[] {
  return flattenSteps(steps).map(f => f.step).filter(isLoopStep);
}
