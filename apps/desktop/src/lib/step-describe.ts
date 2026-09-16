/**
 * Pure facts about a step's shape, for the workflow lane's step tiles: what
 * kind of actor runs it, what it actually does in one line, how loops read
 * out loud, nested ordinals, and which tiles feed which. Kept out of the
 * components so the arithmetic is testable on its own, and out of
 * packages/core because it's presentation — a phrase like "until X passes"
 * has no business in the engine.
 */
import type { AgentStep, CommandStep, LoopStep, ManualStep, Step } from '../../../../packages/core/src/types.ts';
import {
  findStep, flattenSteps, isCommandStep, isContainerStep, isLoopStep, isManualStep,
} from '../../../../packages/core/src/steps.ts';
import { ATTACHMENTS_REF } from '../../../../packages/core/src/attachments.ts';

/** A step that can appear as a tile — everything except a loop, which gets a group instead. */
export type LeafStep = AgentStep | CommandStep | ManualStep;

export type Actor = 'chat' | 'auto' | 'decide' | 'shell';

/**
 * What kind of actor performs a step: a human and an agent talking
 * (interactive), an agent alone (headless), a human deciding (approval or
 * manual), or a shell command (no actor at all, really, but it still needs a
 * band).
 */
export function actorOf(step: LeafStep): Actor {
  if (isCommandStep(step)) return 'shell';
  if (isManualStep(step)) return 'decide';
  return step.mode === 'interactive' ? 'chat' : 'auto';
}

/** Collapses runs of whitespace (including newlines) to single spaces and trims the ends. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The first sentence of a (possibly multi-line, template-bearing) prompt:
 * whitespace folded to single spaces, cut at the first `.`/`!`/`?` that is
 * followed by whitespace or the end of the string. `{{ }}` templates are
 * never specially parsed, so a period inside one can't be mistaken for this
 * — in practice templates don't contain sentence punctuation, so this is
 * only ever a concern in theory.
 */
function firstSentence(text: string): string {
  const collapsed = collapseWhitespace(text);
  const match = /^.*?[.!?](?=\s|$)/.exec(collapsed);
  return match ? match[0] : collapsed;
}

/**
 * The one line that says what a step does: an approval/manual step's title,
 * an agent's first sentence, or a command's `run:` line verbatim (already
 * single-line, and monospace is what makes shell read as shell).
 */
export function purposeOf(step: LeafStep): string {
  if (isCommandStep(step)) return step.run;
  if (isManualStep(step)) return step.title;
  return firstSentence(step.prompt);
}

export interface LoopRule {
  /** The body step id whose verdict ends the loop. */
  until: string;
  /** "passes" for an agent/command verdict, "approves" for a human one. */
  verb: 'passes' | 'approves';
  max?: number;
}

/**
 * The words for a loop group's edge label: "until X passes" for a
 * step/command target, "until X approves" for a human one, plus the budget
 * when the workflow set one. `steps` is the whole tree (or at least
 * everything the loop can see) — `until` can name a step anywhere inside it.
 */
export function loopRule(loop: LoopStep, steps: Step[]): LoopRule {
  const target = findStep(steps, loop.until);
  const verb: LoopRule['verb'] = target !== undefined && isManualStep(target) ? 'approves' : 'passes';
  return {
    until: loop.until,
    verb,
    ...(loop.max_iterations !== undefined ? { max: loop.max_iterations } : {}),
  };
}

/**
 * Nested ordinals for every step in the tree: "4", "4.1", "4.1.1" — a loop
 * counts as one number at its own level, and its body continues underneath
 * it rather than restarting the top-level count.
 */
export function ordinals(steps: Step[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (list: Step[], prefix: string): void => {
    list.forEach((step, i) => {
      const ordinal = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
      out.set(step.id, ordinal);
      if (isLoopStep(step)) walk(step.steps, ordinal);
    });
  };
  walk(steps, '');
  return out;
}

interface Position {
  /** ids of every loop this step sits inside, outermost first. */
  loopChain: Set<string>;
  /** Position in document order (loops expanded once, matching `flattenSteps`). */
  order: number;
}

function positionsOf(steps: Step[], chain: readonly string[], counter: { n: number }, out: Map<string, Position>): void {
  for (const step of steps) {
    out.set(step.id, { loopChain: new Set(chain), order: counter.n++ });
    if (isLoopStep(step)) positionsOf(step.steps, [...chain, step.id], counter, out);
  }
}

export interface DataFlowEntry {
  /** ids this step's `inputs:` names, `attachments` excluded. */
  sources: string[];
  /** ids of steps that name this one in their own `inputs:`. */
  dependents: string[];
  /**
   * The subset of `sources` that are actually a later sibling in the same
   * loop body — at run time that resolves to the *previous* iteration's
   * artifact, since this step hasn't run again yet when it's this step's turn.
   */
  previousIteration: string[];
}

/**
 * Who reads from whom, across the whole tree. Built from `inputs:`, with the
 * reserved `attachments` ref excluded (it names no step). A read is flagged as
 * previous-iteration when the source comes later in document order than the
 * reader *and* the two share at least one enclosing loop — that covers a read
 * across nesting levels (e.g. an inner-loop step reading an outer loop's later
 * sibling), not just reads within the same immediate body.
 */
export function dataFlow(steps: Step[]): Map<string, DataFlowEntry> {
  const positions = new Map<string, Position>();
  positionsOf(steps, [], { n: 0 }, positions);

  const out = new Map<string, DataFlowEntry>();
  for (const { step } of flattenSteps(steps)) {
    if (!isContainerStep(step)) out.set(step.id, { sources: [], dependents: [], previousIteration: [] });
  }

  for (const { step } of flattenSteps(steps)) {
    if (isContainerStep(step)) continue;
    const entry = out.get(step.id);
    if (!entry) continue;
    for (const sourceId of step.inputs ?? []) {
      if (sourceId === ATTACHMENTS_REF) continue;
      const sourceEntry = out.get(sourceId);
      if (!sourceEntry) continue; // a dangling reference: nothing to link to
      entry.sources.push(sourceId);
      sourceEntry.dependents.push(step.id);

      const here = positions.get(step.id);
      const there = positions.get(sourceId);
      const sharesLoop = here && there && [...there.loopChain].some(id => here.loopChain.has(id));
      if (here && there && sharesLoop && there.order > here.order) {
        entry.previousIteration.push(sourceId);
      }
    }
  }
  return out;
}

/** True when `step` is the body step named by `enclosingLoop`'s `until:` — the ◆ marker. */
export function endsLoop(step: Step, enclosingLoop: LoopStep | undefined): boolean {
  return enclosingLoop !== undefined && enclosingLoop.until === step.id;
}
