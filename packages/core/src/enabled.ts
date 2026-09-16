/**
 * What "disabled" means, in one place. Pure — no fs, no zod, no React — so the
 * engine, the manifest seed, the CLI and the desktop editor all agree with no
 * risk of drifting apart.
 */
import type { Step, Workflow } from './types.ts';
import { flattenSteps, isContainerStep, isLoopStep } from './steps.ts';

/** Absent means enabled. */
export function isEnabled(step: Step): boolean {
  return step.enabled !== false;
}

/**
 * Ids explicitly carrying `enabled: false`, at any depth. This is the "one
 * click" count: disabling a loop is one id here, not one id per step it takes
 * with it. Addressed to a human — the workflow card, the New Run dialog.
 */
export function disabledRoots(steps: Step[]): Set<string> {
  const out = new Set<string>();
  for (const { step } of flattenSteps(steps)) {
    if (step.enabled === false) out.add(step.id);
  }
  return out;
}

/**
 * Every id that will not run: the roots, plus every descendant of a disabled
 * container (`loop` or `stages`). This is the set anything that *decides what
 * runs* asks — `pruneDisabled`, both runtime preconditions, the manifest seed.
 */
export function disabledIds(steps: Step[]): Set<string> {
  const roots = disabledRoots(steps);
  const out = new Set<string>(roots);
  for (const { step } of flattenSteps(steps)) {
    if (isContainerStep(step) && roots.has(step.id)) {
      for (const desc of flattenSteps(step.steps)) out.add(desc.step.id);
    }
  }
  return out;
}

function pruneList(steps: Step[], disabled: ReadonlySet<string>): Step[] {
  const kept: Step[] = [];
  for (const step of steps) {
    if (!isEnabled(step)) continue;
    if (isContainerStep(step)) {
      kept.push({ ...step, steps: pruneList(step.steps, disabled) });
      continue;
    }
    const inputs = step.inputs;
    if (inputs === undefined) {
      kept.push(step);
      continue;
    }
    const filtered = inputs.filter(id => !disabled.has(id));
    kept.push(filtered.length === inputs.length ? step : { ...step, inputs: filtered });
  }
  return kept;
}

/**
 * The tree that will actually run: disabled steps and disabled containers'
 * whole bodies removed, and every disabled id stripped from every surviving
 * step's `inputs:`. `LoopStep` and `StagesStep` carry no `inputs`, so
 * stripping only ever touches leaf steps.
 */
export function pruneDisabled(workflow: Workflow): Workflow {
  const disabled = disabledIds(workflow.steps);
  return { ...workflow, steps: pruneList(workflow.steps, disabled) };
}

export interface DroppedRef {
  reader: string;
  missing: string[];
}

/**
 * Enabled steps naming a disabled id in `inputs:` — a command step included,
 * now that its `inputs:` resolves to real `WHIPHAND_ARTIFACT_*` env vars
 * rather than being a runtime no-op. Evaluated against the full `disabledIds`
 * set (not just the roots), so a step that reads two of a disabled loop's
 * body steps is warned about both.
 */
export function droppedRefs(workflow: Workflow): DroppedRef[] {
  const disabled = disabledIds(workflow.steps);
  const out: DroppedRef[] = [];
  for (const { step } of flattenSteps(workflow.steps)) {
    // A reader inside a disabled container is itself in `disabled` even
    // though it carries no `enabled: false` of its own — `isEnabled` alone
    // would miss that and warn about a step that will not run either.
    if (isContainerStep(step) || disabled.has(step.id)) continue;
    const missing = (step.inputs ?? []).filter(id => disabled.has(id));
    if (missing.length > 0) out.push({ reader: step.id, missing });
  }
  return out;
}

/**
 * "a", "a and b", "a, b and c" — no Oxford comma. Exported so the desktop's
 * reader-voiced notes list names exactly as `droppedRefSentence` does.
 */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * The disabler-voiced sentence, one per disabled id, grouping every reader
 * that lost it: "plan is disabled. execute and commit-message read it; they'll
 * run without it." Shared by the CLI's `guard:warning` and the New Run dialog,
 * so the two can never disagree about the facts.
 */
export function droppedRefSentence(refs: DroppedRef[]): string[] {
  const readersById = new Map<string, string[]>();
  for (const { reader, missing } of refs) {
    for (const id of missing) {
      const list = readersById.get(id) ?? [];
      list.push(reader);
      readersById.set(id, list);
    }
  }
  const out: string[] = [];
  for (const [id, readers] of readersById) {
    const verb = readers.length === 1 ? 'reads' : 'read';
    const pronoun = readers.length === 1 ? "it'll" : "they'll";
    out.push(`${id} is disabled. ${joinNames(readers)} ${verb} it; ${pronoun} run without it.`);
  }
  return out;
}

/**
 * The loop whose `until:` names `id`, at any depth. Ignores enabled state
 * entirely by construction — the rule "a loop's `until` step can never be
 * disabled" holds unconditionally: not when the loop is enabled, not when it
 * is disabled.
 */
export function untilTargetOf(steps: Step[], id: string) {
  for (const { step } of flattenSteps(steps)) {
    if (isLoopStep(step) && step.until === id) return step;
  }
  return undefined;
}
