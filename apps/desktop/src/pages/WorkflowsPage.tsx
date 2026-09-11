import { useEffect, useState, type ReactNode } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Radio,
  RadioGroup,
  Text,
} from '@fluentui/react-components';
import { Add20Regular } from '@fluentui/react-icons';
import { useAgentClient } from '../agent/agent-context.tsx';
import { useAppStore } from '../state/store.ts';
import { PageHeader } from '../components/PageHeader.tsx';
import { WorkflowCard, isWorkflowFile } from '../components/WorkflowCard.tsx';
import { DeleteWorkflowDialog } from '../components/DeleteWorkflowDialog.tsx';
import type { WorkflowEntry } from '../components/WorkflowCard.tsx';
import type { Scope } from '../../../../packages/core/src/types.ts';
import { WorkflowEditor } from '../workflow-editor/WorkflowEditor.tsx';

export interface WorkflowsPageProps {
  /**
   * Start a run of this workflow. App.tsx routes it through the same
   * pendingRunAgain path "Run again" uses, so the Runs page opens with
   * NewRunDialog already on this workflow. `source` distinguishes a global
   * card from a project one sharing the same name — see NewRunDialog's
   * `findEntry`.
   */
  onRunWorkflow: (name: string, source: Scope) => void;
}

/**
 * The workflow list, and the editor for one workflow at a time. The editor
 * itself (`WorkflowEditor`) owns the draft, the save, and its own session-only
 * UI state; this page keeps only the editing identity — the list entry's
 * `name` + `source`, never the workflow's own possibly-mismatched `name:`
 * field — and reloads the list once a save or a delete lands.
 */
export function WorkflowsPage({ onRunWorkflow }: WorkflowsPageProps) {
  const client = useAgentClient();
  const workspacePath = useAppStore(state => state.workspacePath);
  const workflows = useAppStore(state => state.workflows);
  const setWorkflows = useAppStore(state => state.setWorkflows);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [settingUp, setSettingUp] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  const [newWorkflowOpen, setNewWorkflowOpen] = useState(false);
  const [newWorkflowName, setNewWorkflowName] = useState('');
  const [newWorkflowScope, setNewWorkflowScope] = useState<Scope>('project');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [editing, setEditing] = useState<{ name: string; source: Scope } | null>(null);
  /** The card awaiting delete confirmation; null when no dialog is open. */
  const [deleting, setDeleting] = useState<{ name: string; source: Scope } | null>(null);

  useEffect(() => {
    if (!workspacePath) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    client
      .request('listWorkflows', { workdir: workspacePath })
      .then(result => {
        if (!cancelled) setWorkflows(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, workspacePath, setWorkflows, reloadKey]);

  async function setUp(): Promise<void> {
    if (!workspacePath) return;
    setSettingUp(true);
    setSetupError(null);
    try {
      await client.request('initWorkspace', { workdir: workspacePath });
      setReloadKey(k => k + 1);
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : String(err));
    } finally {
      setSettingUp(false);
    }
  }

  async function createNewWorkflow(): Promise<void> {
    if (!workspacePath) return;
    setCreating(true);
    setCreateError(null);
    try {
      await client.request('createWorkflow', {
        workdir: workspacePath, name: newWorkflowName,
        // Omitted rather than sent as 'project': keeps the common-case
        // request identical to before scopes existed.
        ...(newWorkflowScope === 'global' ? { scope: newWorkflowScope } : {}),
      });
      setNewWorkflowOpen(false);
      setNewWorkflowName('');
      setNewWorkflowScope('project');
      setReloadKey(k => k + 1);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  function startEdit(entry: WorkflowEntry): void {
    if (!entry.workflow) return;
    setEditing({ name: entry.name, source: entry.source });
  }

  /** Deleting this project workflow uncovers a global one of the same name. */
  function revealsGlobal(name: string, source: Scope): boolean {
    return source === 'project' && workflows.some(w => w.source === 'global' && w.name === name && isWorkflowFile(w));
  }

  const newWorkflowDialog = (
    <Dialog
      open={newWorkflowOpen}
      onOpenChange={(_e, data) => {
        setNewWorkflowOpen(data.open);
        if (!data.open) {
          setNewWorkflowName('');
          setNewWorkflowScope('project');
          setCreateError(null);
        }
      }}
    >
      <DialogTrigger disableButtonEnhancement>
        <Button appearance="primary" icon={<Add20Regular />}>New workflow</Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>New workflow</DialogTitle>
          <DialogContent>
            <Field label="Name" required>
              <Input value={newWorkflowName} onChange={(_e, data) => setNewWorkflowName(data.value)} />
            </Field>
            <Field label="Scope">
              <RadioGroup
                layout="horizontal"
                value={newWorkflowScope}
                onChange={(_e, data) => setNewWorkflowScope(data.value as Scope)}
              >
                <Radio value="project" label="This workspace" />
                <Radio value="global" label="Global (every workspace)" />
              </RadioGroup>
            </Field>
            {createError && <MessageBar intent="error"><MessageBarBody>{createError}</MessageBarBody></MessageBar>}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => setNewWorkflowOpen(false)}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              disabled={!newWorkflowName.trim() || creating}
              onClick={() => void createNewWorkflow()}
            >
              {creating ? 'Creating…' : 'Create'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );

  if (!workspacePath) {
    return <Text>Choose a workspace to see its workflows.</Text>;
  }

  if (editing) {
    const entry = workflows.find(w => w.name === editing.name && w.source === editing.source);
    if (entry?.workflow) {
      return (
        <WorkflowEditor
          key={`${editing.source}:${editing.name}`}
          workflow={entry.workflow}
          name={editing.name}
          source={editing.source}
          workdir={workspacePath}
          onCancel={() => setEditing(null)}
          revealsGlobal={revealsGlobal(editing.name, editing.source)}
          onSaved={() => {
            setEditing(null);
            setReloadKey(k => k + 1);
          }}
          onDeleted={() => {
            setEditing(null);
            setReloadKey(k => k + 1);
          }}
        />
      );
    }
    // The entry vanished from under the editor (e.g. deleted on disk between
    // opening it and this render) — there's nothing left to edit.
    setEditing(null);
  }

  const cardList = workflows.length > 0 && (
    // A responsive grid: the summary line each card now carries sets the
    // minimum column width, so a wide monitor gets two or three cards
    // abreast instead of one stretched to the full window.
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))',
        gap: 12,
      }}
    >
      {workflows.map(entry => (
        <WorkflowCard
          key={`${entry.source}:${entry.name}`}
          entry={entry}
          onRun={() => onRunWorkflow(entry.name, entry.source)}
          onEdit={startEdit}
          onDelete={target => setDeleting({ name: target.name, source: target.source })}
        />
      ))}
    </div>
  );

  let body: ReactNode;
  if (loading && workflows.length === 0) {
    body = <Text>Loading workflows…</Text>;
  } else if (error) {
    body = <Text>Failed to load workflows: {error}</Text>;
  } else if (!workflows.some(w => w.source === 'project')) {
    // Not `workflows.length === 0`: a workspace that owns zero project
    // workflows of its own still needs the setup CTA, but any global
    // workflows it can already see are rendered alongside it rather than
    // hidden behind it — they're runnable right now, setup or not.
    body = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 480 }}>
          <Text>No workflows found in this workspace.</Text>
          <Button appearance="primary" disabled={settingUp} onClick={() => void setUp()}>
            {settingUp ? 'Setting up…' : 'Set up this workspace'}
          </Button>
          {setupError && <MessageBar intent="error"><MessageBarBody>{setupError}</MessageBarBody></MessageBar>}
        </div>
        {cardList}
      </div>
    );
  } else {
    body = cardList;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <PageHeader>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text weight="semibold" size={500}>
            Workflows{workflows.length > 0 && ` — ${workflows.length} workflow${workflows.length === 1 ? '' : 's'}`}
          </Text>
          {newWorkflowDialog}
        </div>
      </PageHeader>
      <div style={{ marginTop: 16 }}>{body}</div>
      {deleting && (
        <DeleteWorkflowDialog
          name={deleting.name}
          source={deleting.source}
          workdir={workspacePath}
          revealsGlobal={revealsGlobal(deleting.name, deleting.source)}
          onDeleted={() => {
            setDeleting(null);
            setReloadKey(k => k + 1);
          }}
          onDismiss={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
