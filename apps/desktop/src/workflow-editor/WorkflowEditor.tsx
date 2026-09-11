import { useState } from 'react';
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
import { readerNotes } from '../lib/disabled-copy.ts';
import { referenceableIds } from '../lib/step-tree.ts';
import { useWorkflowDraft } from './use-workflow-draft.ts';
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

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // A global workflow's save gets its own confirmation: every workspace on
  // the machine reads it, not just this one.
  const [confirmingGlobalSave, setConfirmingGlobalSave] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const notes = readerNotes(draft);
  const noteByStepId = new Map(notes.map(n => [n.stepId, n.text]));
  const visibleRows = computeVisible(rows, draftApi.isBodyFolded);
  // The ordinal is the step's position in the whole declared tree (loops
  // expanded once, depth-first) — stable regardless of which bodies are
  // folded, so folding a loop never renumbers anything outside it.
  const ordinalByStepId = new Map(rows.map((row, i) => [row.step.id, i + 1]));

  async function save(): Promise<void> {
    if (source === 'global' && !confirmingGlobalSave) {
      setConfirmingGlobalSave(true);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await client.request('updateWorkflow', {
        workdir, name, workflow: draft,
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
        />

        {visibleRows.map(row => {
          const siblings = siblingsCount(rows, row);
          const guardLoop = untilTargetOf(draft.steps, row.step.id);
          return (
            <div
              key={row.step.id}
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
                readerNote={noteByStepId.get(row.step.id)}
                highlight={draftApi.highlightFor(row.step.id)}
                onReadsClick={() => draftApi.highlightReads(row.step.id)}
                onWritesClick={() => draftApi.highlightWrites(row.step.id)}
              />
            </div>
          );
        })}

        <Button appearance="secondary" icon={<Add20Regular />} onClick={draftApi.appendStep}>
          Add step
        </Button>
      </div>

      <PageFooter>
        {saveError && <MessageBar intent="error"><MessageBarBody>{saveError}</MessageBarBody></MessageBar>}
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
