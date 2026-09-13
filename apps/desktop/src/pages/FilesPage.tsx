/**
 * The Files tab: workspace tree on the left, preview on the right.
 *
 * Owns the pieces that span both panes — which file is selected, and the
 * unsaved-edits guard that has to intercept a selection change before the
 * preview swaps out from under the editor.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Switch, Text,
} from '@fluentui/react-components';
import { useAppStore } from '../state/store.ts';
import { useFileTree } from '../files/use-file-tree.ts';
import { useFileSystem } from '../files/fs-context.tsx';
import { joinPath, parentPath, validateName } from '../files/tree-model.ts';
import { DocumentAdd16Regular, FolderAdd16Regular } from '@fluentui/react-icons';
import { FileTree } from '../components/FileTree.tsx';
import { FilePreview } from '../components/FilePreview.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { RECESSED_SURFACE } from '../components/recessed-surface.ts';
import { basename } from '../lib/workspace-identity.ts';
import { FileOpsDialog, type FileOpsMode } from '../components/FileOpsDialog.tsx';
import { UnsavedChangesDialog } from '../components/UnsavedChangesDialog.tsx';
import { resolveInWorkspace } from '../markdown/resolve.ts';
import { useOpenExternal } from '../lib/open-external.tsx';

/**
 * What the dirty guard is holding until the user decides. Every one of these
 * either retargets the preview or drops it, so each has to be confirmed
 * before an unsaved draft is thrown away. 'newFolder' is deliberately absent:
 * it leaves the selection (and so the editor) exactly where it was.
 */
type PendingAction =
  | { kind: 'select'; path: string }
  /** `target` is the containing directory for a create, the node for a rename. */
  | { kind: 'ops'; mode: FileOpsMode; target: string }
  | { kind: 'delete'; path: string };

export function FilesPage() {
  const workspacePath = useAppStore(state => state.workspacePath);
  const setFilesDirty = useAppStore(state => state.setFilesDirty);
  const tree = useFileTree(workspacePath);
  const fs = useFileSystem();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  /** Action the dirty guard is holding until the user decides. */
  const [pending, setPending] = useState<PendingAction | null>(null);
  /** The open name dialog and what it acts on; null when closed. */
  const [ops, setOps] = useState<{ mode: FileOpsMode; target: string } | null>(null);
  const [opsError, setOpsError] = useState<string | null>(null);
  const [opsBusy, setOpsBusy] = useState(false);
  /** The path awaiting delete confirmation; null when no dialog is open. */
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /** New-file flow: the preview opens straight into edit mode. */
  const [openInEditMode, setOpenInEditMode] = useState(false);
  const openExternal = useOpenExternal();
  /**
   * select() is declared below the early return (it needs `root` narrowed),
   * and it closes over `dirty`, so it is a different function on every
   * render. Reaching it through a ref keeps docContext out of that: naming
   * select in the dependency list would give docContext a new identity every
   * render (remounting every image in the document), and leaving it out
   * would freeze onNavigate onto a stale copy of the unsaved-edits guard.
   */
  const selectRef = useRef<(path: string) => void>(() => {});

  // Mirror the draft state into the store so App.tsx can guard the tab
  // switch that unmounts this page (see AppState.filesDirty).
  const noteDirty = useCallback((value: boolean) => {
    setDirty(value);
    setFilesDirty(value);
  }, [setFilesDirty]);

  // An unmount while dirty must not leave the flag set: nothing would ever
  // clear it again and every later tab switch would raise the dialog.
  useEffect(() => () => setFilesDirty(false), [setFilesDirty]);

  // The workspace picker sits in the always-visible header, so the workspace
  // can change while this page is open. useFileTree resets itself to the new
  // root, but selectedPath would go on naming a file in the *old* one —
  // FilePreview's `path` never changes, so it keeps showing, and happily
  // saving to, a file outside the workspace the header now names.
  useEffect(() => {
    setSelectedPath(null);
    setOpenInEditMode(false);
    setPending(null);
    noteDirty(false);
  }, [workspacePath, noteDirty]);

  // A watcher-driven refresh (or switching "Show hidden files" off) can prune
  // the selected node while selectedPath still names it. Left dangling, the
  // Delete dialog reads "Delete ?" and derives `recursive` from a missing
  // node — so deleting a still-present non-empty directory would fail
  // instead of recursing.
  const selectionMissing = selectedPath !== null
    && tree.nodes[selectedPath] === undefined
    // Only once the parent's listing has actually landed. Between a refresh
    // starting and its entries arriving the node is legitimately absent, and
    // pruning then would cancel a perfectly good selection.
    && tree.nodes[parentPath(selectedPath)]?.childrenLoaded === true;
  useEffect(() => {
    if (!selectionMissing) return;
    setSelectedPath(null);
    setOpenInEditMode(false);
  }, [selectionMissing]);

  /**
   * Relative links and images in the open document resolve against *its*
   * directory, not the workspace root — that is what an author writing
   * `./review.md` means — and nothing outside the workspace resolves at all.
   */
  const docContext = useMemo(() => (
    workspacePath && selectedPath
      ? {
          resolve: (target: string) => resolveInWorkspace(parentPath(selectedPath), workspacePath, target),
          // Reveal, then select: select() may hold the navigation at the
          // unsaved-edits guard, and expanding the tree towards where the
          // reader is going is harmless either way.
          onNavigate: (path: string) => { tree.expand(path); selectRef.current(path); },
          openExternal,
        }
      : undefined
  ), [workspacePath, selectedPath, tree.expand, openExternal]);

  if (!workspacePath) return <Text>Open a workspace to browse its files.</Text>;
  // Narrowed once, by name, for the closures below: TS won't carry the
  // `!workspacePath` narrowing across a nested function boundary since those
  // can run later, so `workspacePath` reads back as `string | null` inside them.
  const root = workspacePath;

  // Directories are selectable (they're the target of New file / Rename /
  // Delete, and FilePreview is guarded against ever reading one as a file
  // below), so they go through the same dirty guard as a file selection —
  // clicking a folder must not silently discard unsaved edits.
  function select(path: string): void {
    if (dirty && path !== selectedPath) {
      setPending({ kind: 'select', path });
      return;
    }
    runAction({ kind: 'select', path });
  }
  selectRef.current = select;

  /** Carries out an action the guard has already cleared (or never held). */
  function runAction(action: PendingAction): void {
    switch (action.kind) {
      case 'select':
        setOpenInEditMode(false);
        setSelectedPath(action.path);
        break;
      case 'ops':
        setOps({ mode: action.mode, target: action.target });
        setOpsError(null);
        break;
      case 'delete':
        setDeleting(action.path);
        setDeleteError(null);
        break;
    }
  }

  /** True when `path` is the file being edited, or a directory containing it. */
  function affectsOpenFile(path: string): boolean {
    if (selectedPath === null) return false;
    return selectedPath === path || selectedPath.startsWith(`${path}/`) || selectedPath.startsWith(`${path}\\`);
  }

  /**
   * Row actions bypass select(), so any that would retarget or drop the
   * preview has to consult the same guard — otherwise an unsaved draft is
   * destroyed silently (and a rename would additionally carry the *pre-edit*
   * contents to the new name).
   *
   * Now that each action names its own target, the guard only fires when the
   * action actually touches the file being edited: creating a folder, or
   * deleting something elsewhere in the tree, leaves the draft alone.
   */
  function guarded(action: PendingAction): void {
    const touchesDraft = action.kind === 'select'
      || (action.kind === 'ops' && action.mode === 'newFile')
      || (action.kind === 'ops' && action.mode === 'rename' && affectsOpenFile(action.target))
      || (action.kind === 'delete' && affectsOpenFile(action.path));
    if (dirty && touchesDraft) {
      setPending(action);
      return;
    }
    runAction(action);
  }

  const selectedNode = selectedPath ? tree.nodes[selectedPath] : undefined;

  async function submitOps(name: string): Promise<void> {
    if (!ops) return;
    const { mode, target } = ops;
    const invalid = validateName(name);
    if (invalid) {
      setOpsError(invalid);
      return;
    }

    const dir = mode === 'rename' ? parentPath(target) : target;
    const destination = joinPath(dir, name);
    setOpsBusy(true);
    setOpsError(null);
    try {
      if (await fs.exists(destination)) {
        setOpsError('Something with that name already exists here.');
        return;
      }
      if (mode === 'newFolder') {
        await fs.mkdir(destination);
      } else if (mode === 'newFile') {
        await fs.writeTextFile(destination, '');
      } else {
        await fs.rename(target, destination);
      }
      await tree.refreshDir(dir);
      setOps(null);
      if (mode === 'newFile') {
        setOpenInEditMode(true);
        setSelectedPath(destination);
      } else if (mode === 'rename' && selectedPath === target) {
        // Keep previewing the same file under its new name: FilePreview's
        // load effect already depends on `path`, and `destination` differs
        // from the old `selectedPath`, so setting it is enough to force a
        // re-read — no separate reload signal needed.
        setSelectedPath(destination);
      }
    } catch (e) {
      setOpsError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpsBusy(false);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (deleting === null) return;
    const path = deleting;
    const dir = parentPath(path);
    const wasOpen = affectsOpenFile(path);
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await fs.remove(path, { recursive: tree.nodes[path]?.kind === 'dir' });
      await tree.refreshDir(dir);
      // Only the open file's removal clears the pane; deleting something
      // else in the tree must not close what you were reading.
      if (wasOpen) setSelectedPath(null);
      setDeleting(null);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
          <div style={{ minWidth: 0 }}>
            <Text weight="semibold" size={500}>Files</Text>
            <div><Text size={200}>{workspacePath}</Text></div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
            <Switch
              checked={tree.showHidden}
              onChange={(_event, data) => tree.setShowHidden(data.checked)}
              label="Show hidden files"
            />
            {/*
              * Every other create lives on the row it acts on. The workspace
              * root has no row of its own, so its two live here — named after
              * their target, like the row actions are.
              */}
            <Button
              size="small"
              icon={<DocumentAdd16Regular />}
              onClick={() => guarded({ kind: 'ops', mode: 'newFile', target: root })}
            >
              New file in {basename(root)}
            </Button>
            <Button
              size="small"
              icon={<FolderAdd16Regular />}
              onClick={() => guarded({ kind: 'ops', mode: 'newFolder', target: root })}
            >
              New folder in {basename(root)}
            </Button>
          </div>
        </div>
      </PageHeader>

      <div style={{ display: 'flex', flex: 1, minHeight: 0, paddingTop: 8, gap: 8 }}>
        <div
          style={{
            width: 320,
            flexShrink: 0,
            minHeight: 0,
            display: 'flex',
            overflow: 'hidden',
          }}
        >
          <FileTree
            root={workspacePath}
            nodes={tree.nodes}
            expanded={tree.expanded}
            selectedPath={selectedPath}
            onToggle={tree.toggle}
            onSelect={select}
            onCreateFile={dirPath => guarded({ kind: 'ops', mode: 'newFile', target: dirPath })}
            onCreateFolder={dirPath => guarded({ kind: 'ops', mode: 'newFolder', target: dirPath })}
            onRename={path => guarded({ kind: 'ops', mode: 'rename', target: path })}
            onDelete={path => guarded({ kind: 'delete', path })}
          />
        </div>
        <div
          style={{
            // The recessed surface the run page reads its output on — the
            // only boundary; the tree sits on the page background with an
            // 8px gap before it.
            ...RECESSED_SURFACE,
            flex: 1, minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden',
          }}
        >
          <FilePreview
            path={selectedNode?.kind === 'dir' ? null : selectedPath}
            onDirtyChange={noteDirty}
            startInEditMode={openInEditMode}
            docContext={docContext}
            // A file open in this pane should follow whatever writes it —
            // a run, an external editor — without needing a re-select.
            live
          />
        </div>
      </div>

      {pending !== null && (
        // Mounted only while there's a pending action to confirm, not
        // rendered-but-closed: a closed Dialog is still a live Fluent
        // Modalizer, and two Modalizers on one page (this one plus
        // FilePreview's own conflict dialog) can race in tabster's
        // registration bookkeeping under load, leaving the wrong one
        // aria-hidden (see task-8-report.md).
        //
        // Shared with every other exit that would discard a draft, so the
        // wording can't drift between them.
        <UnsavedChangesDialog
          onDiscard={() => {
            const action = pending;
            setPending(null);
            // Only a selection change discards the draft here and now. A
            // rename/delete/new-file dialog can still be cancelled, and the
            // editor keeps its text until the operation actually retargets
            // the preview — so the guard has to stay armed until then rather
            // than declaring the page clean up front.
            if (action.kind === 'select') noteDirty(false);
            runAction(action);
          }}
          onKeepEditing={() => setPending(null)}
        />
      )}

      {ops !== null && (
        // Mounted only while an operation is in progress — see the
        // pendingPath dialog above for why an always-mounted-but-closed
        // Dialog is unsafe (task-8-report.md).
        <FileOpsDialog
          open
          mode={ops.mode}
          initialName={ops.mode === 'rename' ? (tree.nodes[ops.target]?.name ?? '') : ''}
          targetDir={ops.mode === 'rename' ? parentPath(ops.target) : ops.target}
          error={opsError}
          busy={opsBusy}
          onSubmit={name => void submitOps(name)}
          onCancel={() => { setOps(null); setOpsError(null); }}
        />
      )}

      {deleting && (
        // Same reasoning as above: mounted only while a delete is pending
        // confirmation, not rendered-but-closed.
        <Dialog
          open
          onOpenChange={(_event, data) => {
            // An fs.remove() already issued can't be un-issued: once the
            // delete is in flight, dismissing (Esc, backdrop click, or the
            // window close) must not make the dialog lie about it having
            // stopped.
            if (!data.open && !deleteBusy) setDeleting(null);
          }}
        >
          <DialogSurface>
            <DialogBody>
              {/* Named from the node being deleted, not the selection —
                * a row action can target something you never selected. */}
              <DialogTitle>Delete {tree.nodes[deleting]?.name ?? basename(deleting)}?</DialogTitle>
              <DialogContent>
                {tree.nodes[deleting]?.kind === 'dir'
                  ? `Delete folder "${tree.nodes[deleting]?.name}" and everything inside it? This cannot be undone.`
                  : `Delete "${tree.nodes[deleting]?.name ?? basename(deleting)}"? This cannot be undone.`}
                {deleteError ? ` — ${deleteError}` : ''}
              </DialogContent>
              <DialogActions>
                <Button appearance="primary" disabled={deleteBusy} onClick={() => void confirmDelete()}>
                  Delete
                </Button>
                <Button disabled={deleteBusy} onClick={() => setDeleting(null)}>Cancel</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
    </div>
  );
}
