/**
 * The one name-entry dialog behind New file, New folder and Rename.
 *
 * Shared so the name rules (tree-model's validateName) and the "already
 * exists" check are stated once — three near-identical dialogs would drift.
 */
import { useEffect, useState } from 'react';
import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input,
} from '@fluentui/react-components';

export type FileOpsMode = 'newFile' | 'newFolder' | 'rename';

const TITLES: Record<FileOpsMode, string> = {
  newFile: 'New file',
  newFolder: 'New folder',
  rename: 'Rename',
};

const SUBMIT_LABELS: Record<FileOpsMode, string> = {
  newFile: 'Create',
  newFolder: 'Create',
  rename: 'Rename',
};

export interface FileOpsDialogProps {
  open: boolean;
  mode: FileOpsMode;
  /** Prefill — the current name for a rename, '' for a creation. */
  initialName: string;
  /** Where the new or renamed entry will live, shown so the target is unambiguous. */
  targetDir: string;
  error: string | null;
  busy: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

export function FileOpsDialog(props: FileOpsDialogProps) {
  const { open, mode, initialName, targetDir, error, busy, onSubmit, onCancel } = props;
  const [name, setName] = useState(initialName);

  useEffect(() => {
    if (open) setName(initialName);
  }, [open, initialName]);

  return (
    <Dialog
      open={open}
      onOpenChange={(_event, data) => {
        // An fs call already issued by onSubmit can't be un-issued: once
        // busy, dismissing (Esc, backdrop click) must not pretend the
        // operation stopped — keep the dialog up until it resolves.
        if (!data.open && !busy) onCancel();
      }}
    >
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{TITLES[mode]}</DialogTitle>
          <DialogContent>
            <Field label="Name" hint={`in ${targetDir}`} validationState={error ? 'error' : 'none'} validationMessage={error ?? undefined}>
              <Input
                value={name}
                disabled={busy}
                onChange={(_event, data) => setName(data.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && !busy) onSubmit(name);
                }}
              />
            </Field>
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" disabled={busy} onClick={() => onSubmit(name)}>
              {SUBMIT_LABELS[mode]}
            </Button>
            <Button disabled={busy} onClick={onCancel}>Cancel</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
