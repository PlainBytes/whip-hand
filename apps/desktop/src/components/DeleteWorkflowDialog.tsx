import { useState } from 'react';
import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle,
  MessageBar, MessageBarBody, Spinner, Text,
} from '@fluentui/react-components';
import { useAgentClient } from '../agent/agent-context.tsx';
import type { Scope } from '../../../../packages/core/src/types.ts';

export interface DeleteWorkflowDialogProps {
  /** The list entry's `name` + `source` — the file to delete, never the workflow's own `name:` field. */
  name: string;
  source: Scope;
  workdir: string;
  /** A project workflow that overrides a global one of the same name: deleting it uncovers the global one. */
  revealsGlobal: boolean;
  /** The file is gone — deleted now, or already missing, which is the same outcome. */
  onDeleted: () => void;
  onDismiss: () => void;
}

/**
 * Confirms and performs a hard delete of one workflow file. Shared by the
 * Workflows page's cards and the workflow editor. Mount it only while open:
 * a closed-but-mounted Fluent Dialog is still a live Modalizer (see RunsPage).
 */
export function DeleteWorkflowDialog({
  name, source, workdir, revealsGlobal, onDeleted, onDismiss,
}: DeleteWorkflowDialogProps) {
  const client = useAgentClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // `deleted: false` means the file was already gone — still the goal.
      await client.request('deleteWorkflow', {
        workdir, name,
        ...(source === 'global' ? { scope: source } : {}),
      });
      onDeleted();
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
        // A deleteWorkflow already issued can't be un-issued: dismissal (Esc,
        // backdrop) must not lie about having stopped it.
        if (!data.open && !busy) onDismiss();
      }}
    >
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Delete workflow '{name}'?</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {source === 'global' ? (
                <Text>
                  {`'${name}' is a global workflow — every workspace on this machine loses it. `}
                  This cannot be undone.
                </Text>
              ) : (
                <Text>This deletes its file. This cannot be undone. Past runs keep their own copy.</Text>
              )}
              {source === 'project' && revealsGlobal && (
                <Text>{`The global '${name}' workflow will be used in this workspace instead.`}</Text>
              )}
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
