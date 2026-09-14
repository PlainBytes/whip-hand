import { useState } from 'react';
import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle,
  Field, Input, MessageBar, MessageBarBody, Spinner, Text,
} from '@fluentui/react-components';
import { Copy20Regular } from '@fluentui/react-icons';
import { useAgentClient } from '../agent/agent-context.tsx';
import { WORKFLOW_NAME_RE } from '../../../../packages/core/src/workflow-name.ts';
import type { Scope } from '../../../../packages/core/src/types.ts';
import { isWorkflowFile } from './workflow-lane/WorkflowLane.tsx';
import type { WorkflowEntry } from './workflow-lane/WorkflowLane.tsx';

export interface CloneWorkflowDialogProps {
  /** The list entry's `name` + `source` — the workflow being cloned. */
  name: string;
  source: Scope;
  workdir: string;
  /** The current list, used to suggest a free name and flag collisions as the user types. */
  existing: WorkflowEntry[];
  onCloned: () => void;
  onDismiss: () => void;
}

/** Whether `candidate` is already used by a real workflow file in `scope`. */
function isTaken(existing: WorkflowEntry[], candidate: string, scope: Scope): boolean {
  return existing.some(e => e.source === scope && e.name === candidate && isWorkflowFile(e));
}

/** The first free `<base>-copy`, `<base>-copy-2`, `<base>-copy-3`, ... in `scope`. */
function suggestName(existing: WorkflowEntry[], base: string, scope: Scope): string {
  const first = `${base}-copy`;
  if (!isTaken(existing, first, scope)) return first;
  let n = 2;
  while (isTaken(existing, `${base}-copy-${n}`, scope)) n += 1;
  return `${base}-copy-${n}`;
}

interface NameProblem {
  message: string;
  /** An error blocks Clone; a same-name-in-the-other-scope warning does not. */
  blocking: boolean;
}

function nameProblem(newName: string, source: Scope, existing: WorkflowEntry[]): NameProblem | null {
  if (!WORKFLOW_NAME_RE.test(newName)) {
    return { message: 'Use lowercase letters, digits, - and _ (start with a letter or digit)', blocking: true };
  }
  if (isTaken(existing, newName, source)) {
    return { message: `A workflow named ${newName} already exists`, blocking: true };
  }
  const otherScope: Scope = source === 'global' ? 'project' : 'global';
  if (isTaken(existing, newName, otherScope)) {
    const message = source === 'project'
      ? `Will override the global workflow ${newName} in this workspace`
      : `Hidden in this workspace by the project workflow ${newName}`;
    return { message, blocking: false };
  }
  return null;
}

/**
 * Clones one workflow file under a new name, staying in the source's own
 * scope. Follows the `DeleteWorkflowDialog` pattern: mounted only while
 * open, because a closed-but-mounted Fluent Dialog is still a live
 * Modalizer. The server re-checks the target name even though this dialog
 * already does — the `existing` list it checks against can be stale by the
 * time Clone is pressed.
 */
export function CloneWorkflowDialog({
  name, source, workdir, existing, onCloned, onDismiss,
}: CloneWorkflowDialogProps) {
  const client = useAgentClient();
  const [newName, setNewName] = useState(() => suggestName(existing, name, source));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problem = nameProblem(newName, source, existing);

  async function confirm(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await client.request('cloneWorkflow', {
        workdir, name, newName,
        ...(source === 'global' ? { scope: source } : {}),
      });
      onCloned();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(_event, data) => {
        // A cloneWorkflow already issued can't be un-issued: dismissal (Esc,
        // backdrop) must not lie about having stopped it.
        if (!data.open && !busy) onDismiss();
      }}
    >
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Clone workflow</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Field
                label="Name"
                required
                validationState={problem ? (problem.blocking ? 'error' : 'warning') : 'none'}
                validationMessage={problem?.message}
              >
                <Input value={newName} onChange={(_e, data) => setNewName(data.value)} />
              </Field>
              <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>
                {source === 'global' ? 'Clones into: Global (every workspace)' : 'Clones into: This workspace'}
              </Text>
              {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button
              appearance="primary"
              disabled={busy || problem?.blocking === true}
              icon={busy ? <Spinner size="tiny" /> : <Copy20Regular />}
              onClick={() => void confirm()}
            >
              {busy ? 'Cloning…' : 'Clone'}
            </Button>
            <Button disabled={busy} onClick={onDismiss}>Cancel</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
