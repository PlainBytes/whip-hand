import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Dialog,
  DialogBody,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
} from '@fluentui/react-components';
import { NewRunForm } from './NewRunForm.tsx';
import { useAppStore } from '../state/store.ts';

export interface NewRunDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: (jobId: string) => void;
}

/**
 * The modal around a `NewRunForm`: a draft lives exactly as long as the dialog
 * is open, and is deleted on Cancel, dismiss or a successful start alike.
 */
export function NewRunDialog({ open, onOpenChange, onStarted }: NewRunDialogProps) {
  const workspacePath = useAppStore(state => state.workspacePath);
  const identityKey = useAppStore(state => state.workspaceIdentityKey) ?? undefined;
  const setPendingRunAgain = useAppStore(state => state.setPendingRunAgain);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  // Taken once: the request is cleared from the store as it is consumed, and a
  // second effect run must still see it.
  const runAgainRef = useRef(useAppStore.getState().pendingRunAgain);
  // Still waiting for the workflow list, so the form must apply it on arrival.
  const [runAgainPending, setRunAgainPending] = useState(false);

  useEffect(() => {
    if (!open || !workspacePath) return;
    const { createDraft, deleteDraft, workflows } = useAppStore.getState();
    const runAgain = runAgainRef.current ?? undefined;
    const id = createDraft({ workdir: workspacePath, identityKey, runAgain });
    // With the list loaded the draft has already considered it. Otherwise it
    // stays in the store until the form has seen the list arrive.
    if (runAgain && workflows.length > 0) setPendingRunAgain(null);
    setRunAgainPending(!!runAgain && workflows.length === 0);
    setDraftId(id);
    return () => {
      deleteDraft(id);
      setDraftId(null);
    };
  }, [open, workspacePath, identityKey, setPendingRunAgain]);

  return (
    <Dialog open={open} onOpenChange={(_e, data) => onOpenChange(data.open)}>
      <DialogSurface
        // A drop lands anywhere on the window while the dialog is up — it is
        // modal, so the whole window is the dialog — and the outline says so.
        style={dropActive ? { outline: '2px dashed var(--colorBrandStroke1)', outlineOffset: -4 } : undefined}
      >
        <DialogBody>
          <DialogTitle>New run</DialogTitle>
          {draftId && (
            <NewRunForm
              draftId={draftId}
              visible={open}
              onStarted={jobId => {
                useAppStore.getState().deleteDraft(draftId);
                onStarted(jobId);
              }}
              runAgain={runAgainPending ? runAgainRef.current ?? undefined : undefined}
              onRunAgainConsumed={() => {
                setRunAgainPending(false);
                setPendingRunAgain(null);
              }}
              onDropActiveChange={setDropActive}
              cancel={
                <DialogTrigger disableButtonEnhancement>
                  <Button appearance="secondary">Cancel</Button>
                </DialogTrigger>
              }
            />
          )}
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
