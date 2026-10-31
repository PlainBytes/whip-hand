import { useState } from 'react';
import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle,
  MessageBar, MessageBarBody, Spinner, Text,
} from '@fluentui/react-components';
import { useAgentClient } from '../agent/agent-context.tsx';
import { useAppStore } from '../state/store.ts';
import type { DeleteRunResult } from '../shared/protocol.gen.ts';
import { errorMessage } from '../lib/error-message.ts';
import { DangerButton } from './DangerButton.tsx';

export interface DeleteRunDialogProps {
  workdir: string;
  runId: string;
  /** The run's human name, when it has one — the title says it instead of the id. */
  name?: string;
  /** The run's worktree path; another listed run on the same path keeps the worktree alive. */
  worktreePath?: string;
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
  if (reason === 'worktree-dirty') {
    return "This run's worktree still has uncommitted changes.";
  }
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
export function DeleteRunDialog({ workdir, runId, name, worktreePath, onDeleted, onDismiss }: DeleteRunDialogProps) {
  const client = useAgentClient();
  const sharer = useAppStore(state => worktreePath === undefined
    ? undefined
    : state.runs.find(run => run.runId !== runId && run.worktree?.path === worktreePath));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A dirty worktree is not an error: it asks for a second, explicit confirmation.
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  async function confirm(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await client.request('deleteRun', confirmDiscard
        ? { workdir, runId, force: true }
        : { workdir, runId });
      if (result.deleted) onDeleted();
      else if (result.reason === 'worktree-dirty' && !confirmDiscard) setConfirmDiscard(true);
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
              {confirmDiscard && (
                <Text data-testid="delete-discard-warning">
                  This run's worktree has uncommitted changes. Deleting will discard them. The run's branch is kept.
                </Text>
              )}
              {sharer && (
                <Text data-testid="delete-worktree-kept">
                  The worktree is kept because run {sharer.name ?? sharer.runId} still uses it.
                </Text>
              )}
              {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
            </div>
          </DialogContent>
          <DialogActions>
            <DangerButton disabled={busy} onClick={() => void confirm()}>
              {busy ? <Spinner size="tiny" /> : confirmDiscard ? 'Discard changes and delete' : 'Delete'}
            </DangerButton>
            <Button disabled={busy} onClick={onDismiss}>Cancel</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
