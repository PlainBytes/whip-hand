import {
  useCallback, useEffect, useMemo, useRef, useState,
  type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react';
import {
  closestCenter, DndContext, DragOverlay, KeyboardSensor, PointerSensor, pointerWithin, TouchSensor,
  useDraggable, useDroppable, useSensor, useSensors,
  type Announcements, type CollisionDetection, type DragEndEvent, type DragMoveEvent, type DragStartEvent,
  type KeyboardCoordinateGetter, type PointerSensorOptions,
} from '@dnd-kit/core';
import { getEventCoordinates } from '@dnd-kit/utilities';
import {
  Badge, Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle,
  MessageBar, MessageBarBody, Spinner, Text,
} from '@fluentui/react-components';
import { Add20Regular, Delete20Regular, Dismiss20Regular, Save20Regular } from '@fluentui/react-icons';
import { useNarrowLayout } from '../lib/use-narrow-layout.ts';
import { useAgentClient } from '../agent/agent-context.tsx';
import { DeleteWorkflowDialog } from '../components/DeleteWorkflowDialog.tsx';
import { Page } from '../components/Page.tsx';
import { DangerButton } from '../components/DangerButton.tsx';
import type { Scope, Step, Workflow } from '../shared/types.ts';
import { isContainerStep } from '../shared/steps.ts';
import { untilTargetOf } from '../shared/enabled.ts';
import type { ValidateWorkflowResult } from '../shared/protocol.gen.ts';
import { readerNotes } from '../lib/disabled-copy.ts';
import {
  indentTarget, moveBlocker, outdentTarget, referenceableIds, stepAt, type MoveDestination, type StepPath,
} from '../lib/step-tree.ts';
import { normalizeDraft } from '../lib/draft-normalize.ts';
import { useWorkflowDraft } from './use-workflow-draft.ts';
import { useHarnessCatalog } from './use-harness-catalog.ts';
import { WorkflowSettingsCard } from './WorkflowSettingsCard.tsx';
import { StepCard, type DragHandleProps } from './StepCard.tsx';
import { StepSummary } from '../components/StepSummary.tsx';
import { projectDrop, type DropProjection } from '../lib/drag-projection.ts';
import type { EditorRow } from '../lib/editor-model.ts';
import { errorMessage } from '../lib/error-message.ts';

export interface WorkflowEditorProps {
  workflow: Workflow;
  name: string;
  source: Scope;
  workdir: string;
  /** The scope a delete would uncover (a lower-scope workflow of the same name), or null. */
  uncovers: Scope | null;
  onSaved: () => void;
  onCancel: () => void;
  /** The workflow's file is gone. Any unsaved draft goes with it — the delete confirmation covers that. */
  onDeleted: () => void;
}

/** The rows left once every row inside a folded container's body (loop or stages) is hidden. */
function computeVisible(rows: EditorRow[], isBodyFolded: (id: string) => boolean): EditorRow[] {
  const visible: EditorRow[] = [];
  let hideDepth: number | null = null;
  for (const row of rows) {
    if (hideDepth !== null) {
      if (row.depth > hideDepth) continue;
      hideDepth = null;
    }
    visible.push(row);
    if (isContainerStep(row.step) && isBodyFolded(row.step.id)) hideDepth = row.depth;
  }
  return visible;
}

function isStrictPrefix(prefix: StepPath, path: StepPath): boolean {
  return prefix.length < path.length && prefix.every((v, i) => v === path[i]);
}

/** Where a drag would drop, as `projectDrop` takes it: the row under it, which half, and how far sideways (in indent levels). */
interface DropCursor {
  overId: string;
  placement: 'before' | 'after';
  offsetDepth: number;
}

/**
 * The mouse/pen half of the pointer sensors. A touch pointer is left to the
 * TouchSensor and its press-and-hold delay, so a plain swipe across a drag
 * handle still scrolls the page instead of starting a drag after a few pixels.
 */
class MouseAndPenSensor extends PointerSensor {
  static activators = [{
    eventName: 'onPointerDown' as const,
    handler: (event: ReactPointerEvent, options: PointerSensorOptions): boolean =>
      event.nativeEvent.pointerType !== 'touch' && PointerSensor.activators[0].handler(event, options),
  }];
}

/** The pointer's own row first; between rows (the list's gaps), the nearest one. */
const pointerFirst: CollisionDetection = args => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : closestCenter(args);
};

const SCREEN_READER_INSTRUCTIONS = {
  draggable: 'To pick up a step, press Space or Enter. Use the up and down arrow keys to move it between steps, '
    + 'and the left and right arrow keys to move it out of or into a loop or stages body. '
    + 'Press Space or Enter again to drop it, or Escape to cancel.',
};

/** Where a projected drop lands, in words — for the screen-reader announcements and the drop line's label. */
function describeDrop(steps: Step[], p: DropProjection): string {
  if (p.blocker !== null) return `cannot drop here: ${p.blocker}`;
  const fromParent = p.from.slice(0, -1);
  const sameList = fromParent.length === p.parentPath.length && fromParent.every((v, i) => v === p.parentPath[i]);
  // `index` is a slot in the list as it is before the move.
  const position = (sameList && p.from[p.from.length - 1] < p.index ? p.index - 1 : p.index) + 1;
  const container = stepAt(steps, p.parentPath);
  return container === undefined
    ? `at the top level, position ${position}`
    : `into ${container.kind} '${container.id}', position ${position}`;
}

/**
 * One row of the list: a drop target, and draggable by the handle its card
 * renders (the card gets the handle's props through `children`). The row
 * stays where it is while dragged — `DragOverlay` shows what moves.
 */
function DndRow({
  id, style, register, children,
}: {
  id: string;
  style: CSSProperties;
  register: (id: string, el: HTMLDivElement | null) => void;
  children: (handle: DragHandleProps) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef: setDragRef, setActivatorNodeRef, isDragging } = useDraggable({ id });
  const { setNodeRef: setDropRef } = useDroppable({ id });
  const ref = useCallback((el: HTMLDivElement | null) => {
    setDragRef(el);
    setDropRef(el);
    register(id, el);
  }, [id, register, setDragRef, setDropRef]);
  return (
    <div ref={ref} style={{ ...style, position: 'relative', opacity: isDragging ? 0.4 : undefined }}>
      {children({ ref: setActivatorNodeRef, ...attributes, ...listeners })}
    </div>
  );
}

/**
 * The editor: a workflow settings card, then one flat, indented list of step
 * cards — every card the same width, nesting carried by indentation rather
 * than by cards containing cards. Owns the draft, the save, and the
 * session-only collapse / body-fold / highlight state. Not a page: this is a
 * child of WorkflowsPage, which keeps the `{ name, source }` editing identity
 * and passes it down; the app has no router for this to be a destination of.
 */
type DraftValidation = Pick<ValidateWorkflowResult, 'problems' | 'fieldProblems'>;

const NO_PROBLEMS: DraftValidation = { problems: [], fieldProblems: [] };

/** How long the editor waits after an edit before checking the draft again. */
const REVALIDATE_MS = 250;

export function WorkflowEditor({
  workflow, name, source, workdir, uncovers, onSaved, onCancel, onDeleted,
}: WorkflowEditorProps) {
  const narrow = useNarrowLayout();
  const client = useAgentClient();
  const draftApi = useWorkflowDraft(workflow);
  const { draft, rows } = draftApi;
  // Prefetches doctor + listModels so the Runner dropdown and Model combobox
  // are normally ready before a card is even expanded; StepRail reads both
  // straight from the store.
  useHarnessCatalog(workdir);

  const [saving, setSaving] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // A global workflow's save gets its own confirmation: every workspace on
  // the machine reads it, not just this one.
  const [confirmingGlobalSave, setConfirmingGlobalSave] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Inline errors appear only after the first Save attempt that found a
  // problem — not on every keystroke of a workflow nobody has tried to save
  // yet. Once shown, they recompute on every render, so they clear as the
  // problems that caused them get fixed.
  const [showProblems, setShowProblems] = useState(false);
  // A pending, uncommitted Step ID edit on some card — keyed by that card's
  // current committed id, which is also its React key here.
  const [idFieldErrors, setIdFieldErrors] = useState<Record<string, string | null>>({});
  // A blank or duplicate input name in the settings card's own row state —
  // it can never be pushed into `workflow.inputs` as its own entry.
  const [settingsProblem, setSettingsProblem] = useState<string | null>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [revealId, setRevealId] = useState<string | null>(null);

  const normalized = useMemo(() => normalizeDraft(draft), [draft]);
  // The agent's validator (validateWorkflow) is the only one. It runs at
  // Save, and again after each edit once problems are on screen, so they
  // clear as they get fixed. `validated` is the draft the result describes;
  // an answer for an older draft is dropped.
  const [validation, setValidation] = useState<DraftValidation>(NO_PROBLEMS);
  const validated = useRef<unknown>(undefined);
  const current = useRef(normalized);
  current.current = normalized;

  async function validate(candidate: typeof normalized): Promise<DraftValidation> {
    validated.current = candidate;
    const { problems, fieldProblems } = await client.request('validateWorkflow', { draft: candidate });
    const found = { problems, fieldProblems };
    if (current.current === candidate) setValidation(found);
    return found;
  }

  useEffect(() => {
    if (!showProblems || validated.current === normalized) return;
    const timer = setTimeout(() => {
      // A failure leaves the last answer up; Save reports it.
      validate(normalized).catch(() => {});
    }, REVALIDATE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- validate reads refs and the stable client
  }, [showProblems, normalized]);

  // Keyed by the card's own committed id, so this reads as a problem on that
  // card, and its message matches the `step '<id>': ...` shape the problem list's
  // other lines use.
  const idProblems = Object.entries(idFieldErrors)
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([stepId, message]) => ({ stepId, message: `step '${stepId}': Step ID ${message}` }));
  const problemsOf = (v: DraftValidation): string[] => [
    ...v.problems, ...idProblems.map(p => p.message), ...(settingsProblem ? [settingsProblem] : []),
  ];
  // Every stepId-bearing problem, in the same order as `problemsOf` — built
  // from the structured `fieldProblems` rather than re-parsing `problems`
  // strings, since a "references" semantic problem (`step 'b' references
  // unknown step 'a'`) has no colon right after the id for a regex to find.
  const stepProblemsOf = (v: DraftValidation): { stepId: string }[] => [
    ...v.fieldProblems.flatMap(fp => (fp.stepId !== undefined ? [{ stepId: fp.stepId }] : [])),
    ...idProblems,
  ];
  const allProblems = problemsOf(validation);

  // Field-level errors for the step cards — populated only from the schema's
  // own field problems (id problems are already visible at their source, the
  // Step ID field itself). First problem per (step, field) wins.
  const fieldErrorsByStepId = new Map<string, Record<string, string>>();
  for (const fp of validation.fieldProblems) {
    if (fp.stepId === undefined || fp.field === undefined) continue;
    const bucket = fieldErrorsByStepId.get(fp.stepId) ?? {};
    if (!(fp.field in bucket)) bucket[fp.field] = fp.phrase;
    fieldErrorsByStepId.set(fp.stepId, bucket);
  }

  const notes = readerNotes(draft);
  const noteByStepId = new Map(notes.map(n => [n.stepId, n.text]));
  const visibleRows = computeVisible(rows, draftApi.isBodyFolded);
  // The ordinal is the step's position in the whole declared tree (loops
  // expanded once, depth-first) — stable regardless of which bodies are
  // folded, so folding a loop never renumbers anything outside it.
  const ordinalByStepId = new Map(rows.map((row, i) => [row.step.id, i + 1]));
  const problemCountByStepId = new Map<string, number>();
  for (const { stepId } of stepProblemsOf(validation)) {
    problemCountByStepId.set(stepId, (problemCountByStepId.get(stepId) ?? 0) + 1);
  }

  // Expands the card (and unfolds any container bodies above it), then scrolls it
  // into view once that expansion has actually reached the DOM.
  function revealStep(stepId: string): void {
    const target = rows.find(r => r.step.id === stepId);
    if (target === undefined) return;
    for (const row of rows) {
      if (!isContainerStep(row.step)) continue;
      if (row.path.length >= target.path.length) continue;
      if (!row.path.every((v, i) => v === target.path[i])) continue;
      if (draftApi.isBodyFolded(row.step.id)) draftApi.toggleBodyFolded(row.step.id);
    }
    if (!draftApi.isExpanded(stepId)) draftApi.toggleExpanded(stepId);
    setRevealId(stepId);
  }

  // "Move into container above" and a drag's drop: a folded destination body
  // unfolds first, so the moved card stays on screen instead of vanishing into
  // the fold.
  function moveIntoContainer(path: StepPath, to: MoveDestination): void {
    if (moveBlocker(draft.steps, path, to.parentPath) !== null) return;
    const container = stepAt(draft.steps, to.parentPath);
    if (container !== undefined && draftApi.isBodyFolded(container.id)) draftApi.toggleBodyFolded(container.id);
    draftApi.moveStepTo(path, to);
  }

  // ---- Drag and drop ----
  // `@dnd-kit` (pointer, touch and keyboard sensors — not native HTML5 drag,
  // which the Tauri window's file-drop handling blocks on Windows) reports
  // where the drag is; `projectDrop` turns that into a destination. The
  // cursor and its projection are mirrored in refs because the keyboard
  // coordinate getter and the announcements run outside React's render.
  const indent = narrow ? 8 : 20;
  const [dragActiveId, setDragActiveId] = useState<string | null>(null);
  const [cursor, setCursorState] = useState<DropCursor | null>(null);
  const dragRef = useRef<{ activeId: string; keyboard: boolean } | null>(null);
  const cursorRef = useRef<DropCursor | null>(null);
  const projectionRef = useRef<DropProjection | null>(null);
  const announcedRef = useRef<string | undefined>(undefined);
  const droppedRef = useRef<string | undefined>(undefined);
  const latest = useRef({ steps: draft.steps, visibleRows, indent });
  latest.current = { steps: draft.steps, visibleRows, indent };

  const registerCard = useCallback((id: string, el: HTMLDivElement | null) => {
    cardRefs.current[id] = el;
  }, []);

  function projectionFor(next: DropCursor | null): DropProjection | null {
    const drag = dragRef.current;
    if (drag === null || next === null) return null;
    const { steps, visibleRows: shown } = latest.current;
    return projectDrop({ steps, rows: shown, activeId: drag.activeId, ...next });
  }

  function setCursor(next: DropCursor | null): void {
    const prev = cursorRef.current;
    if (prev === next || (prev !== null && next !== null && prev.overId === next.overId
      && prev.placement === next.placement && prev.offsetDepth === next.offsetDepth)) return;
    cursorRef.current = next;
    projectionRef.current = projectionFor(next);
    setCursorState(next);
  }

  /** The rows a drop can go between — every visible row but the dragged one and its body. */
  function dropCandidates(activeId: string): { active: EditorRow; candidates: EditorRow[] } | undefined {
    const shown = latest.current.visibleRows;
    const active = shown.find(r => r.step.id === activeId);
    if (active === undefined) return undefined;
    return { active, candidates: shown.filter(r => r !== active && !isStrictPrefix(active.path, r.path)) };
  }

  /** Which gap between candidates a cursor marks — the same arithmetic as `projectDrop`. */
  function gapOf(c: DropCursor, active: EditorRow, candidates: EditorRow[]): number {
    if (c.overId === active.step.id) {
      return latest.current.visibleRows.slice(0, latest.current.visibleRows.indexOf(active))
        .filter(r => candidates.includes(r)).length;
    }
    const i = candidates.findIndex(r => r.step.id === c.overId);
    return c.placement === 'before' ? i : i + 1;
  }

  // Arrow keys during a keyboard drag: Up/Down step through the gaps between
  // rows, Left/Right change the drop depth. The returned coordinates move the
  // overlay to the drop line; the drop itself is decided by the cursor alone.
  const keyboardMove = useRef<KeyboardCoordinateGetter>(() => undefined);
  keyboardMove.current = (event, { currentCoordinates }) => {
    const drag = dragRef.current;
    if (drag === null || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) return undefined;
    event.preventDefault();
    const found = dropCandidates(drag.activeId);
    if (found === undefined || found.candidates.length === 0) return undefined;
    const { active, candidates } = found;
    const current = cursorRef.current ?? { overId: active.step.id, placement: 'after' as const, offsetDepth: 0 };
    const depthNow = projectionRef.current?.depth ?? active.depth;
    let gap = gapOf(current, active, candidates);
    let depth = depthNow;
    if (event.code === 'ArrowUp') gap = Math.max(0, gap - 1);
    else if (event.code === 'ArrowDown') gap = Math.min(candidates.length, gap + 1);
    else depth = Math.max(0, depthNow + (event.code === 'ArrowRight' ? 1 : -1));
    const next: DropCursor = gap < candidates.length
      ? { overId: candidates[gap].step.id, placement: 'before', offsetDepth: depth - active.depth }
      : { overId: candidates[candidates.length - 1].step.id, placement: 'after', offsetDepth: depth - active.depth };
    setCursor(next);
    const anchor = cardRefs.current[next.overId]?.getBoundingClientRect();
    if (anchor === undefined) return currentCoordinates;
    const shownDepth = projectionRef.current?.depth ?? active.depth;
    const anchorDepth = candidates.find(r => r.step.id === next.overId)!.depth;
    return {
      x: anchor.left + (shownDepth - anchorDepth) * latest.current.indent,
      y: next.placement === 'before' ? anchor.top : anchor.bottom,
    };
  };
  const keyboardCoordinates = useCallback<KeyboardCoordinateGetter>(
    (event, args) => keyboardMove.current(event, args), []);

  const sensors = useSensors(
    // A few pixels of travel before a mouse drag starts, so a click on the handle stays a click.
    useSensor(MouseAndPenSensor, { activationConstraint: { distance: 5 } }),
    // Press and hold to drag on touch; moving first scrolls the page as usual.
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates }),
  );

  function endDrag(): void {
    dragRef.current = null;
    cursorRef.current = null;
    projectionRef.current = null;
    announcedRef.current = undefined;
    setDragActiveId(null);
    setCursorState(null);
  }

  function onDragStart(event: DragStartEvent): void {
    const activeId = String(event.active.id);
    const keyboard = event.activatorEvent.type === 'keydown';
    dragRef.current = { activeId, keyboard };
    cursorRef.current = null;
    projectionRef.current = null;
    droppedRef.current = undefined;
    setDragActiveId(activeId);
    setCursorState(null);
  }

  function onDragMove(event: DragMoveEvent): void {
    const drag = dragRef.current;
    if (drag === null || drag.keyboard) return;
    const { over } = event;
    const start = getEventCoordinates(event.activatorEvent);
    if (over === null || start === null) {
      setCursor(null);
      return;
    }
    const y = start.y + event.delta.y;
    setCursor({
      overId: String(over.id),
      placement: y < over.rect.top + over.rect.height / 2 ? 'before' : 'after',
      offsetDepth: Math.round(event.delta.x / latest.current.indent),
    });
  }

  function onDragEnd(_event: DragEndEvent): void {
    const drag = dragRef.current;
    const projection = projectionRef.current;
    droppedRef.current = drag === null ? undefined
      : projection === null ? `'${drag.activeId}' was not moved.`
      : projection.blocker !== null ? `'${drag.activeId}' was not moved: ${projection.blocker}`
      : `Dropped '${drag.activeId}' ${describeDrop(draft.steps, projection)}.`;
    endDrag();
    if (projection !== null && projection.blocker === null) moveIntoContainer(projection.from, projection);
  }

  function onDragCancel(): void {
    const drag = dragRef.current;
    droppedRef.current = drag === null ? undefined : `Cancelled. '${drag.activeId}' was not moved.`;
    endDrag();
  }

  const ownPlace = (id: string): string => `'${id}' is back at its own place`;
  // Announces the projected target whenever it changes (pointer moves fire
  // far more often than the target does).
  function announceTarget(): string | undefined {
    const drag = dragRef.current;
    if (drag === null) return undefined;
    const p = projectionRef.current;
    const text = p === null ? ownPlace(drag.activeId) : `'${drag.activeId}' ${describeDrop(latest.current.steps, p)}`;
    if (text === announcedRef.current) return undefined;
    announcedRef.current = text;
    return text;
  }
  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      // The drag starts over its own place; say so only once it has been somewhere else.
      announcedRef.current = ownPlace(String(active.id));
      return `Picked up step '${String(active.id)}'.`;
    },
    onDragMove: announceTarget,
    onDragOver: announceTarget,
    onDragEnd: () => droppedRef.current,
    onDragCancel: () => droppedRef.current,
  };

  const projection = dragActiveId === null ? null : projectionFor(cursor);
  const activeRow = dragActiveId === null ? undefined : visibleRows.find(r => r.step.id === dragActiveId);
  // While dragged, a container's body travels with it: its rows are not shown.
  const renderedRows = activeRow === undefined
    ? visibleRows
    : visibleRows.filter(r => !isStrictPrefix(activeRow.path, r.path));
  // The drop line hangs off the row just below the gap (or, for the very end, the last row).
  let indicator: { rowId: string; side: 'top' | 'bottom' } | undefined;
  if (projection !== null && activeRow !== undefined && cursor !== null) {
    const found = dropCandidates(activeRow.step.id);
    if (found !== undefined && found.candidates.length > 0) {
      const gap = gapOf(cursor, found.active, found.candidates);
      indicator = gap < found.candidates.length
        ? { rowId: found.candidates[gap].step.id, side: 'top' }
        : { rowId: found.candidates[found.candidates.length - 1].step.id, side: 'bottom' };
    }
  }

  function dropLine(row: EditorRow): ReactNode {
    if (projection === null || indicator?.rowId !== row.step.id) return null;
    const blocked = projection.blocker !== null;
    const color = blocked ? 'var(--colorPaletteRedBorder2)' : 'var(--colorBrandStroke1)';
    return (
      <div
        data-testid="drop-indicator"
        data-blocked={blocked ? 'true' : 'false'}
        aria-hidden
        style={{
          position: 'absolute', zIndex: 1, pointerEvents: 'none', right: 0,
          // From this row's own indent to the projected one; the row's 2px nesting border sits inside it.
          left: (projection.depth - row.depth) * indent - (row.depth > 0 ? 2 : 0),
          [indicator.side]: -6,
          borderTop: `3px ${blocked ? 'dashed' : 'solid'} ${color}`,
        }}
      >
        {blocked && (
          <span style={{
            position: 'absolute', right: 0, top: 2, padding: '0 6px', borderRadius: 4, fontSize: 12,
            background: 'var(--colorPaletteRedBackground1)', color: 'var(--colorPaletteRedForeground1)',
            border: `1px solid ${color}`, whiteSpace: 'nowrap', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {`Cannot drop here: ${projection.blocker}`}
          </span>
        )}
      </div>
    );
  }

  useEffect(() => {
    if (revealId === null) return;
    const el = cardRefs.current[revealId];
    if (el === null || el === undefined) return;
    // jsdom (tests) has no layout engine and does not implement this.
    el.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    setRevealId(null);
    // Runs again once the reveal's own state changes land in the DOM —
    // `visibleRows` is what actually changes when a fold/expand takes effect.
  }, [revealId, visibleRows]);

  async function save(): Promise<void> {
    setSaving(true);
    setSaveError(null);
    let found: DraftValidation;
    try {
      found = await validate(normalized);
    } catch (err) {
      setSaveError(errorMessage(err));
      setSaving(false);
      return;
    }
    if (problemsOf(found).length > 0) {
      setSaving(false);
      setShowProblems(true);
      const firstStepId = stepProblemsOf(found)[0]?.stepId;
      if (firstStepId !== undefined) revealStep(firstStepId);
      // Workflow-level problems only: the bar is the first thing in the body, so
      // bring the body's top into view. jsdom (tests) does not implement scrollTo.
      else bodyRef.current?.parentElement?.scrollTo?.({ top: 0, behavior: 'smooth' });
      return;
    }
    if (source === 'global' && !confirmingGlobalSave) {
      setSaving(false);
      setConfirmingGlobalSave(true);
      return;
    }
    try {
      await client.request('updateWorkflow', {
        workdir, name, workflow: normalized,
        ...(source !== 'project' ? { scope: source } : {}),
      });
      setConfirmingGlobalSave(false);
      onSaved();
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const globalSaveConfirmDialog = (
    <Dialog open={confirmingGlobalSave} onOpenChange={(_e, data) => setConfirmingGlobalSave(data.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Save global workflow?</DialogTitle>
          <DialogContent>
            <Text>
              {`'${name}' is a global workflow — every workspace on this machine reads it. `}
              Saving will change what all of them run.
            </Text>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => setConfirmingGlobalSave(false)}>Cancel</Button>
            <Button appearance="primary" onClick={() => void save()}>Save anyway</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );

  return (
    <Page header={<>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <Text weight="semibold" size={500}>
            Edit workflow: {name}
            {source === 'workspace' && <Badge appearance="tint" color="informative" style={{ marginLeft: 8 }}>Workspace</Badge>}
            {source === 'global' && <Badge appearance="tint" color="brand" style={{ marginLeft: 8 }}>Global</Badge>}
          </Text>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <DangerButton
              variant="filled"
              icon={<Delete20Regular />}
              aria-label={`Delete ${name}`}
              disabled={saving}
              onClick={() => setConfirmingDelete(true)}
            >
              Delete
            </DangerButton>
            <Button appearance="secondary" icon={<Dismiss20Regular />} onClick={onCancel}>Cancel</Button>
            <Button
              appearance="primary"
              disabled={saving}
              icon={saving ? <Spinner size="tiny" /> : <Save20Regular />}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
    </>}>
      {globalSaveConfirmDialog}
      {confirmingDelete && (
        <DeleteWorkflowDialog
          name={name}
          source={source}
          workdir={workdir}
          uncovers={uncovers}
          onDeleted={onDeleted}
          onDismiss={() => setConfirmingDelete(false)}
        />
      )}
      <div ref={bodyRef} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {saveError && (
          <MessageBar intent="error">
            {/* A WorkflowError-style server message is several lines, joined with '\n  - '. */}
            <MessageBarBody style={{ whiteSpace: 'pre-wrap' }}>{saveError}</MessageBarBody>
          </MessageBar>
        )}
        {showProblems && allProblems.length > 0 && (
          <MessageBar intent="error">
            <MessageBarBody>
              <div>{allProblems.length} problem{allProblems.length === 1 ? '' : 's'}:</div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {allProblems.map((problem, i) => <li key={`${i}:${problem}`}>{problem}</li>)}
              </ul>
            </MessageBarBody>
          </MessageBar>
        )}
        <WorkflowSettingsCard
          workflow={draft}
          collapsed={draftApi.settingsCollapsed}
          onToggleCollapsed={draftApi.toggleSettingsCollapsed}
          onUpdate={draftApi.updateWorkflowSettings}
          onProblem={setSettingsProblem}
        />

        <DndContext
          sensors={sensors}
          collisionDetection={pointerFirst}
          accessibility={{ announcements, screenReaderInstructions: SCREEN_READER_INSTRUCTIONS }}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
        >
        {renderedRows.map(row => {
          const siblings = siblingsCount(rows, row);
          const guardLoop = untilTargetOf(draft.steps, row.step.id);
          const outTo = outdentTarget(row.path);
          const inTo = indentTarget(draft.steps, row.path);
          return (
            <DndRow
              key={row.step.id}
              id={row.step.id}
              register={registerCard}
              style={{
                marginLeft: row.depth * indent,
                borderLeft: row.depth > 0 ? '2px solid var(--colorBrandStroke2)' : undefined,
                paddingLeft: row.depth > 0 ? (narrow ? 6 : 10) : 0,
                minWidth: 0,
              }}
            >
              {dragHandle => <>
              {dropLine(row)}
              <StepCard
                dragHandle={dragHandle}
                workflowServers={Object.keys(draft.mcp?.servers ?? {})}
                step={row.step}
                ordinal={ordinalByStepId.get(row.step.id)!}
                earlierStepIds={referenceableIds(draft.steps, row.path)}
                idsInTree={draftApi.idsInTree}
                endsLoop={row.endsLoop}
                dimmed={row.dimmed}
                nested={row.depth > 0}
                inStages={row.inStages}
                collapsed={!draftApi.isExpanded(row.step.id)}
                onToggleCollapsed={() => draftApi.toggleExpanded(row.step.id)}
                bodyFolded={isContainerStep(row.step) ? draftApi.isBodyFolded(row.step.id) : undefined}
                onToggleBodyFolded={isContainerStep(row.step) ? () => draftApi.toggleBodyFolded(row.step.id) : undefined}
                isFirst={siblings.index === 0}
                isLast={siblings.index === siblings.total - 1}
                onMove={dir => draftApi.moveStep(row.path, dir)}
                onMoveOut={outTo && (() => draftApi.moveStepTo(row.path, outTo))}
                moveOutBlocker={outTo && (moveBlocker(draft.steps, row.path, outTo.parentPath) ?? undefined)}
                onMoveIn={inTo && (() => moveIntoContainer(row.path, inTo))}
                moveInBlocker={inTo && (moveBlocker(draft.steps, row.path, inTo.parentPath) ?? undefined)}
                onInsertBelow={() => draftApi.insertStepBelow(row.path)}
                guardedByLoopId={guardLoop?.id}
                onToggleEnabled={() => draftApi.toggleEnabled(row.path)}
                onRemove={() => draftApi.removeStepAt(row.path)}
                onUpdate={next => draftApi.updateStep(row.path, next)}
                onRename={nextId => draftApi.commitRename(row.path, nextId)}
                onIdError={error => setIdFieldErrors(prev => (
                  prev[row.step.id] === error ? prev : { ...prev, [row.step.id]: error }
                ))}
                readerNote={noteByStepId.get(row.step.id)}
                highlight={draftApi.highlightFor(row.step.id)}
                onReadsClick={() => draftApi.highlightReads(row.step.id)}
                onWritesClick={() => draftApi.highlightWrites(row.step.id)}
                problemCount={showProblems ? problemCountByStepId.get(row.step.id) : undefined}
                fieldErrors={showProblems ? fieldErrorsByStepId.get(row.step.id) : undefined}
              />
              </>}
            </DndRow>
          );
        })}
          {/* No drop animation: after a move the card is already where it landed. */}
          <DragOverlay dropAnimation={null}>
            {activeRow && (
              <div
                data-testid="drag-overlay"
                style={{
                  border: '1px solid var(--colorBrandStroke1)', borderRadius: 4, padding: '6px 10px',
                  background: 'var(--colorNeutralBackground1)', boxShadow: 'var(--shadow16)', cursor: 'grabbing',
                }}
              >
                <StepSummary
                  step={activeRow.step}
                  ordinal={ordinalByStepId.get(activeRow.step.id)!}
                  endsLoop={activeRow.endsLoop}
                  disabled={activeRow.dimmed}
                />
              </div>
            )}
          </DragOverlay>
        </DndContext>

        <Button appearance="secondary" icon={<Add20Regular />} onClick={draftApi.appendStep}>
          Add step
        </Button>
      </div>
    </Page>
  );
}

/** This row's index and sibling count within its own list — for Move up/down's disabled edges. */
function siblingsCount(rows: EditorRow[], row: EditorRow): { index: number; total: number } {
  const parentPath = row.path.slice(0, -1);
  const siblings = rows.filter(r =>
    r.path.length === row.path.length && r.path.slice(0, -1).every((v, i) => v === parentPath[i]));
  const index = row.path[row.path.length - 1];
  return { index, total: siblings.length };
}
