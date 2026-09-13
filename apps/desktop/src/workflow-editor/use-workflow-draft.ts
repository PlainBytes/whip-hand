import { useCallback, useMemo, useState } from 'react';
import type { Step, Workflow } from '../../../../packages/core/src/types.ts';
import { flattenSteps, isLoopStep } from '../../../../packages/core/src/steps.ts';
import {
  appendAt, insertAfter, moveAt, removeStep as removeStepById, renameStep as renameStepById, stepAt, updateAt,
  type StepPath,
} from '../lib/step-tree.ts';
import { editorRows, wiring } from '../lib/editor-model.ts';

/** Unique across the whole tree, which is where step ids have to be unique. */
function freshId(existing: Step[]): string {
  const taken = new Set(flattenSteps(existing).map(f => f.step.id));
  let n = taken.size + 1;
  while (taken.has(`step-${n}`)) n += 1;
  return `step-${n}`;
}

/**
 * `output` is omitted, not set to `''`: it is optional-shaped everywhere but
 * `agent`, and core now treats `''` as present-but-blank, not absent. `prompt`
 * stays `''` — it is required, and left that way is exactly what should be
 * flagged as unfilled. The cast reflects that a fresh step is a deliberately
 * incomplete draft, same as every other editor mutation in this file.
 */
function newStep(existing: Step[]): Step {
  return {
    kind: 'agent', id: freshId(existing), runner: 'claude', mode: 'headless',
    writes: false, prompt: '',
  } as Step;
}

export type Highlight = { kind: 'source' | 'dependent'; ids: Set<string> };

/**
 * The draft plus every mutation the editor offers (update, insert, remove,
 * move, rename, toggle), and the session-only collapse / body-fold /
 * highlight state — so the components that use this are mostly rendering.
 * Collapse and fold are keyed by step id, not path: an id is stable between
 * commits (a rename only commits on blur), which is what keeps a collapsed
 * card's collapsed-ness from swapping with its neighbour's on Move up.
 */
export function useWorkflowDraft(initial: Workflow) {
  const [draft, setDraft] = useState<Workflow>(initial);
  // Empty means "everything collapsed" — the editor opens with nothing expanded.
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  // Empty means "nothing folded" — a loop's body is visible until folded.
  const [foldedLoopIds, setFoldedLoopIds] = useState<ReadonlySet<string>>(new Set());
  const [settingsCollapsed, setSettingsCollapsed] = useState(true);
  const [highlight, setHighlight] = useState<Highlight | null>(null);

  const rows = useMemo(() => editorRows(draft), [draft]);
  const wire = useMemo(() => wiring(draft), [draft]);
  const idsInTree = useMemo(() => new Set(rows.map(r => r.step.id)), [rows]);

  function updateWorkflowSettings(patch: Partial<Workflow>): void {
    setDraft(d => ({ ...d, ...patch }));
  }

  function updateStep(path: StepPath, next: Step): void {
    setDraft(d => ({ ...d, steps: updateAt(d.steps, path, next) }));
  }

  function moveStep(path: StepPath, dir: -1 | 1): void {
    setDraft(d => ({ ...d, steps: moveAt(d.steps, path, dir) }));
  }

  /** Insert-below: a loop card's next row is its own first body child; any other card inserts as the next sibling. */
  function insertStepBelow(path: StepPath): void {
    setDraft(d => {
      const step = newStep(d.steps);
      setExpandedIds(prev => new Set(prev).add(step.id));
      return { ...d, steps: insertAfter(d.steps, path, step) };
    });
  }

  /** The trailing "Add step" button — appends at the very top level, same as today. */
  function appendStep(): void {
    setDraft(d => {
      const step = newStep(d.steps);
      setExpandedIds(prev => new Set(prev).add(step.id));
      return { ...d, steps: appendAt(d.steps, [], step) };
    });
  }

  function removeStepAt(path: StepPath): void {
    const step = stepAt(draft.steps, path);
    if (step === undefined) return;
    setDraft(d => ({ ...d, steps: removeStepById(d.steps, step.id) }));
  }

  function commitRename(path: StepPath, nextId: string): void {
    const step = stepAt(draft.steps, path);
    if (step === undefined || step.id === nextId) return;
    const oldId = step.id;
    setDraft(d => ({ ...d, steps: renameStepById(d.steps, oldId, nextId) }));
    setExpandedIds(prev => {
      if (!prev.has(oldId)) return prev;
      const next = new Set(prev);
      next.delete(oldId);
      next.add(nextId);
      return next;
    });
    setFoldedLoopIds(prev => {
      if (!prev.has(oldId)) return prev;
      const next = new Set(prev);
      next.delete(oldId);
      next.add(nextId);
      return next;
    });
  }

  /** Absent means enabled — toggling "on" clears the key rather than writing `enabled: true`. */
  function toggleEnabled(path: StepPath): void {
    const step = stepAt(draft.steps, path);
    if (step === undefined) return;
    const next: Step = { ...step };
    if (step.enabled === false) delete (next as { enabled?: boolean }).enabled;
    else (next as { enabled?: boolean }).enabled = false;
    updateStep(path, next);
  }

  const isExpanded = useCallback((id: string) => expandedIds.has(id), [expandedIds]);
  function toggleExpanded(id: string): void {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const isBodyFolded = useCallback((id: string) => foldedLoopIds.has(id), [foldedLoopIds]);
  function toggleBodyFolded(id: string): void {
    setFoldedLoopIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  /** Highlights the ids a step reads from. Re-clicking the same step's chip clears it. */
  function highlightReads(id: string): void {
    setHighlight(prev => {
      const ids = new Set(wire.sources(id));
      if (prev?.kind === 'source' && prev.ids.size === ids.size && [...ids].every(i => prev.ids.has(i))) return null;
      return { kind: 'source', ids };
    });
  }

  /** Highlights the ids that read this step. Re-clicking the same step's chip clears it. */
  function highlightWrites(id: string): void {
    setHighlight(prev => {
      const ids = new Set(wire.dependents(id));
      if (prev?.kind === 'dependent' && prev.ids.size === ids.size && [...ids].every(i => prev.ids.has(i))) return null;
      return { kind: 'dependent', ids };
    });
  }

  function highlightFor(id: string): 'source' | 'dependent' | undefined {
    if (highlight === null || !highlight.ids.has(id)) return undefined;
    return highlight.kind;
  }

  return {
    draft,
    rows,
    idsInTree,
    updateWorkflowSettings,
    updateStep,
    moveStep,
    insertStepBelow,
    appendStep,
    removeStepAt,
    commitRename,
    toggleEnabled,
    isExpanded,
    toggleExpanded,
    isBodyFolded,
    toggleBodyFolded,
    settingsCollapsed,
    toggleSettingsCollapsed: () => setSettingsCollapsed(v => !v),
    highlightReads,
    highlightWrites,
    highlightFor,
    isLoop: isLoopStep,
  };
}
