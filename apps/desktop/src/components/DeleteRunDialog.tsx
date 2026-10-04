import { useState } from 'react';
import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle,
  MessageBar, MessageBarBody, Spinner, Text,
} from '@fluentui/react-components';
import { useAgentClient } from '../agent/agent-context.tsx';
import type { DeleteRunResult } from '../shared/protocol.gen.ts';
import { errorMessage } from '../lib/error-message.ts';

export interface DeleteRunDialogProps {
  workdir: string;
  runId: string;
  /** The run's human name, when it has one — the title says it instead of the id. */
  name?: string;
  /** The run's directory is gone. Callers decide what that means: re-poll a list, or leave the page. */
  onDeleted: () => void;
  onDismiss: () => void;
}

/**
 * Why the agent declined, in words. A refusal is an answer, not a failure —
 * the request itself succeeded — so it lands in the same error slot a thrown
 * RPC does but never reaches `onDeleted`.
 */
function refusalMessage(reason: DeleteRunResult['reason']): string {
  if (reason === 'locked') return 'This run is locked.';
  if (reason === 'running') return 'This run is still running.';
  return 'This run no longer exists.';
}

/**
 * Confirms and performs a hard delete of one run's directory. Shared by the
 * Runs grid's row action and the run page's header, which used to carry
 * their own copies of this dialog — copies that had already drifted apart on
 * button order, and that both let a rejected deleteRun escape as an unhandled
 * promise with the dialog still spinning and saying nothing. Follows the
 * `DeleteWorkflowDialog` pattern: mount it only while open, because a
 * closed-but-mounted Fluent Dialog is still a live Modalizer.
 */
export function DeleteRunDialog({ workdir, runId, name, onDeleted, onDismiss }: DeleteRunDialogProps) {
  const client = useAgentClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await client.request('deleteRun', { workdir, runId });
      if (result.deleted) onDeleted();
      else setError(refusalMessage(result.reason));
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
        // A deleteRun already issued can't be un-issued: dismissal (Esc,
        // backdrop) must not lie about having stopped it.
        if (!data.open && !busy) onDismiss();
      }}
    >
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Delete {name ?? `run ${runId}`}?</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Text>This deletes the run's directory and everything in it. This cannot be undone.</Text>
              {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" disabled={busy} onClick={() => void confirm()}>
              {busy ? <Spinner size="tiny" /> : 'Delete'}
            </Button>
            <Button disabled={busy} onClick={onDismiss}>Cancel</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
