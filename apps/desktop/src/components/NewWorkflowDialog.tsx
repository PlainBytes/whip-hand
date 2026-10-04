import { useState } from 'react';
import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle,
  Field, Input, MessageBar, MessageBarBody, Radio, RadioGroup, Spinner,
} from '@fluentui/react-components';
import { useAgentClient } from '../agent/agent-context.tsx';
import type { Scope } from '../shared/types.ts';
import type { WorkflowEntry } from './workflow-lane/WorkflowLane.tsx';
import { workflowNameProblem } from './workflow-name-problem.ts';
import { errorMessage } from '../lib/error-message.ts';

export interface NewWorkflowDialogProps {
  workdir: string;
  /** The current list, used to flag collisions as the user types. */
  existing: WorkflowEntry[];
  onCreated: () => void;
  onDismiss: () => void;
}

/**
 * Scaffolds a new workflow file from the template. Follows the
 * `CloneWorkflowDialog` pattern — same name validation, same busy guard on
 * dismissal, mounted only while open (a closed-but-mounted Fluent Dialog is
 * still a live Modalizer). Being unmounted on close is also what resets the
 * name and scope for the next open, so there is no reset code to forget.
 */
export function NewWorkflowDialog({ workdir, existing, onCreated, onDismiss }: NewWorkflowDialogProps) {
  const client = useAgentClient();
  const [name, setName] = useState('');
  const [scope, setScope] = useState<Scope>('project');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // An empty box hasn't said anything wrong yet — the disabled Create button
  // is enough; greeting the user with a red field on open is not.
  const problem = name === '' ? null : workflowNameProblem(name, scope, existing);

  async function confirm(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await client.request('createWorkflow', {
        workdir, name,
        // Omitted rather than sent as 'project': keeps the common-case
        // request identical to before scopes existed.
        ...(scope === 'global' ? { scope } : {}),
      });
      onCreated();
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
        // A createWorkflow already issued can't be un-issued: dismissal (Esc,
        // backdrop) must not lie about having stopped it.
        if (!data.open && !busy) onDismiss();
      }}
    >
      <DialogSurface>
        <DialogBody>
          <DialogTitle>New workflow</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Field
                label="Name"
                required
                validationState={problem ? (problem.blocking ? 'error' : 'warning') : 'none'}
                validationMessage={problem?.message}
              >
                <Input value={name} onChange={(_e, data) => setName(data.value)} />
              </Field>
              <Field label="Scope">
                <RadioGroup
                  layout="horizontal"
                  value={scope}
                  onChange={(_e, data) => setScope(data.value as Scope)}
                >
                  <Radio value="project" label="This workspace" />
                  <Radio value="global" label="Global (every workspace)" />
                </RadioGroup>
              </Field>
              {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button
              appearance="primary"
              disabled={busy || name === '' || problem?.blocking === true}
              icon={busy ? <Spinner size="tiny" /> : undefined}
              onClick={() => void confirm()}
            >
              {busy ? 'Creating…' : 'Create'}
            </Button>
            <Button disabled={busy} onClick={onDismiss}>Cancel</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
