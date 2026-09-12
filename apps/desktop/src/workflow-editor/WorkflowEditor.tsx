import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge, Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle,
  MessageBar, MessageBarBody, Spinner, Text,
} from '@fluentui/react-components';
import { Add20Regular, Delete20Regular, Dismiss20Regular, Save20Regular } from '@fluentui/react-icons';
import { useAgentClient } from '../agent/agent-context.tsx';
import { DeleteWorkflowDialog } from '../components/DeleteWorkflowDialog.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { PageFooter } from '../components/PageFooter.tsx';
import type { Scope, Workflow } from '../../../../packages/core/src/types.ts';
import { isLoopStep } from '../../../../packages/core/src/steps.ts';
import { untilTargetOf } from '../../../../packages/core/src/enabled.ts';
import { validateWorkflowDraft } from '../../../../packages/core/src/schema.ts';
import { readerNotes } from '../lib/disabled-copy.ts';
import { referenceableIds } from '../lib/step-tree.ts';
import { normalizeDraft } from '../lib/draft-normalize.ts';
import { useWorkflowDraft } from './use-workflow-draft.ts';
import { useHarnessCatalog } from './use-harness-catalog.ts';
import { WorkflowSettingsCard } from './WorkflowSettingsCard.tsx';
import { StepCard } from './StepCard.tsx';
import type { EditorRow } from '../lib/editor-model.ts';

export interface WorkflowEditorProps {
  workflow: Workflow;
  name: string;
  source: Scope;
  workdir: string;
  /** A project workflow overriding a global one of the same name — the delete confirmation says so. */
  revealsGlobal: boolean;
  onSaved: () => void;
  onCancel: () => void;
  /** The workflow's file is gone. Any unsaved draft goes with it — the delete confirmation covers that. */
  onDeleted: () => void;
}

/** True when hiding `row` because it sits inside a loop whose body is folded. */
function computeVisible(rows: EditorRow[], isBodyFolded: (id: string) => boolean): EditorRow[] {
  const visible: EditorRow[] = [];
  let hideDepth: number | null = null;
  for (const row of rows) {
    if (hideDepth !== null) {
      if (row.depth > hideDepth) continue;
      hideDepth = null;
    }
    visible.push(row);
    if (isLoopStep(row.step) && isBodyFolded(row.step.id)) hideDepth = row.depth;
  }
  return visible;
}

/**
 * The editor: a workflow settings card, then one flat, indented list of step
 * cards — every card the same width, nesting carried by indentation rather
 * than by cards containing cards. Owns the draft, the save, and the
 * session-only collapse / body-fold / highlight state. Not a page: this is a
 * child of WorkflowsPage, which keeps the `{ name, source }` editing identity
 * and passes it down; the app has no router for this to be a destination of.
 */
export function WorkflowEditor({
  workflow, name, source, workdir, revealsGlobal, onSaved, onCancel, onDeleted,
}: WorkflowEditorProps) {
  const client = useAgentClient();
  const draftApi = useWorkflowDraft(workflow);
  const { draft, rows } = draftApi;
  // Prefetches doctor + listModels so the Runner dropdown and Model combobox
  // are normally ready before a card is even expanded; StepRail reads both
  // straight from the store.
  useHarnessCatalog();

  const [saving, setSaving] = useState(false);
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
  const { problems: draftProblems, fieldProblems: draftFieldProblems } = useMemo(
    () => validateWorkflowDraft(normalized), [normalized],
  );
  // Keyed by the card's own committed id, so this reads as a problem on that
  // card, and its message matches the `step '<id>': ...` shape the footer's
  // other lines use.
  const idProblems = Object.entries(idFieldErrors)
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([stepId, message]) => ({ stepId, message: `step '${stepId}': Step ID ${message}` }));
  const allProblems = [
    ...draftProblems, ...idProblems.map(p => p.message), ...(settingsProblem ? [settingsProblem] : []),
  ];

  // Field-level errors for the step cards — populated only from the schema's
  // own field problems (id problems are already visible at their source, the
  // Step ID field itself). First problem per (step, field) wins.
  const fieldErrorsByStepId = new Map<string, Record<string, string>>();
  for (const fp of draftFieldProblems) {
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
  // Every stepId-bearing problem, in the same order as `allProblems` — built
  // from the structured `fieldProblems` rather than re-parsing `problems`
  // strings, since a "references" semantic problem (`step 'b' references
  // unknown step 'a'`) has no colon right after the id for a regex to find.
  const stepProblems = [
    ...draftFieldProblems.flatMap(fp => (fp.stepId !== undefined ? [{ stepId: fp.stepId }] : [])),
    ...idProblems,
  ];
  const problemCountByStepId = new Map<string, number>();
  for (const { stepId } of stepProblems) {
    problemCountByStepId.set(stepId, (problemCountByStepId.get(stepId) ?? 0) + 1);
  }

  // Expands the card (and unfolds any loop bodies above it), then scrolls it
  // into view once that expansion has actually reached the DOM.
  function revealStep(stepId: string): void {
    const target = rows.find(r => r.step.id === stepId);
    if (target === undefined) return;
    for (const row of rows) {
      if (!isLoopStep(row.step)) continue;
      if (row.path.length >= target.path.length) continue;
      if (!row.path.every((v, i) => v === target.path[i])) continue;
      if (draftApi.isBodyFolded(row.step.id)) draftApi.toggleBodyFolded(row.step.id);
    }
    if (!draftApi.isExpanded(stepId)) draftApi.toggleExpanded(stepId);
    setRevealId(stepId);
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
    if (allProblems.length > 0) {
      setShowProblems(true);
      const firstStepId = stepProblems[0]?.stepId;
      if (firstStepId !== undefined) revealStep(firstStepId);
      return;
    }
    if (source === 'global' && !confirmingGlobalSave) {
      setConfirmingGlobalSave(true);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await client.request('updateWorkflow', {
        workdir, name, workflow: normalized,
        ...(source === 'global' ? { scope: source } : {}),
      });
      setConfirmingGlobalSave(false);
      onSaved();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
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
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {globalSaveConfirmDialog}
      {confirmingDelete && (
        <DeleteWorkflowDialog
          name={name}
          source={source}
          workdir={workdir}
          revealsGlobal={revealsGlobal}
          onDeleted={onDeleted}
          onDismiss={() => setConfirmingDelete(false)}
        />
      )}
      <PageHeader>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text weight="semibold" size={500}>
            Edit workflow: {name}
            {source === 'global' && <Badge appearance="tint" color="brand" style={{ marginLeft: 8 }}>Global</Badge>}
          </Text>
          <Button
            appearance="secondary"
            icon={<Delete20Regular />}
            aria-label={`Delete ${name}`}
            disabled={saving}
            onClick={() => setConfirmingDelete(true)}
          >
            Delete
          </Button>
        </div>
      </PageHeader>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 16, paddingBottom: 16 }}>
        <WorkflowSettingsCard
          workflow={draft}
          collapsed={draftApi.settingsCollapsed}
          onToggleCollapsed={draftApi.toggleSettingsCollapsed}
          onUpdate={draftApi.updateWorkflowSettings}
          onProblem={setSettingsProblem}
        />

        {visibleRows.map(row => {
          const siblings = siblingsCount(rows, row);
          const guardLoop = untilTargetOf(draft.steps, row.step.id);
          return (
            <div
              key={row.step.id}
              ref={el => { cardRefs.current[row.step.id] = el; }}
              style={{
                marginLeft: row.depth * 20,
                borderLeft: row.depth > 0 ? '2px solid var(--colorBrandStroke2)' : undefined,
                paddingLeft: row.depth > 0 ? 10 : 0,
              }}
            >
              <StepCard
                step={row.step}
                ordinal={ordinalByStepId.get(row.step.id)!}
                earlierStepIds={referenceableIds(draft.steps, row.path)}
                idsInTree={draftApi.idsInTree}
                endsLoop={row.endsLoop}
                dimmed={row.dimmed}
                collapsed={!draftApi.isExpanded(row.step.id)}
                onToggleCollapsed={() => draftApi.toggleExpanded(row.step.id)}
                bodyFolded={isLoopStep(row.step) ? draftApi.isBodyFolded(row.step.id) : undefined}
                onToggleBodyFolded={isLoopStep(row.step) ? () => draftApi.toggleBodyFolded(row.step.id) : undefined}
                isFirst={siblings.index === 0}
                isLast={siblings.index === siblings.total - 1}
                onMove={dir => draftApi.moveStep(row.path, dir)}
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
            </div>
          );
        })}

        <Button appearance="secondary" icon={<Add20Regular />} onClick={draftApi.appendStep}>
          Add step
        </Button>
      </div>

      <PageFooter>
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
        <div style={{ display: 'flex', gap: 8 }}>
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
      </PageFooter>
    </div>
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
