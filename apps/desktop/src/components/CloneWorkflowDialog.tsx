import { useState } from 'react';
import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle,
  Field, Input, MessageBar, MessageBarBody, Spinner, Text,
} from '@fluentui/react-components';
import { Copy20Regular } from '@fluentui/react-icons';
import { useAgentClient } from '../agent/agent-context.tsx';
import type { Scope } from '../../../../packages/core/src/types.ts';
import type { WorkflowEntry } from './workflow-lane/WorkflowLane.tsx';
import { isWorkflowNameTaken, workflowNameProblem } from './workflow-name-problem.ts';
import { errorMessage } from '../lib/error-message.ts';

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

/** The first free `<base>-copy`, `<base>-copy-2`, `<base>-copy-3`, ... in `scope`. */
function suggestName(existing: WorkflowEntry[], base: string, scope: Scope): string {
  const first = `${base}-copy`;
  if (!isWorkflowNameTaken(existing, first, scope)) return first;
  let n = 2;
  while (isWorkflowNameTaken(existing, `${base}-copy-${n}`, scope)) n += 1;
  return `${base}-copy-${n}`;
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

  const problem = workflowNameProblem(newName, source, existing);

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
      setError(errorMessage(err));
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
