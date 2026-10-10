import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle,
} from '@fluentui/react-components';
import { DangerButton } from './DangerButton.tsx';

/**
 * The one unsaved-file prompt, raised from every exit that would discard a
 * draft: switching page, switching workspace, or leaving the file within
 * the Files page. One component rather than three copies, because the
 * wording has to be identical wherever the same choice is offered.
 *
 * Mount this only while a decision is actually pending — never
 * rendered-but-closed. A closed Dialog is still a live Fluent Modalizer,
 * and stacking one under the Files page's own dialogs let tabster's
 * registration bookkeeping race under load, leaving the wrong Modalizer's
 * surface aria-hidden (see task-8-report.md).
 */
export interface UnsavedChangesDialogProps {
  onDiscard: () => void;
  onKeepEditing: () => void;
}

export function UnsavedChangesDialog({ onDiscard, onKeepEditing }: UnsavedChangesDialogProps) {
  return (
    <Dialog open onOpenChange={(_event, data) => { if (!data.open) onKeepEditing(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>You have unsaved changes</DialogTitle>
          <DialogContent>Continuing will discard the edits you haven't saved.</DialogContent>
          <DialogActions>
            <DangerButton onClick={onDiscard}>Discard changes</DangerButton>
            <Button onClick={onKeepEditing}>Keep editing</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
