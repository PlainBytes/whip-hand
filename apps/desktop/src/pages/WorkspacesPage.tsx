import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, createTableColumn, DataGrid, DataGridBody, DataGridCell, DataGridHeader,
  DataGridHeaderCell, DataGridRow, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface,
  DialogTitle, Text, Tooltip, type TableColumnDefinition,
} from '@fluentui/react-components';
import { DeleteRegular, FolderOpenRegular, PinOffRegular, PinRegular } from '@fluentui/react-icons';
import { useAgentClient } from '../agent/agent-context.tsx';
import { useCapabilities } from '../capabilities.tsx';
import { useAppStore } from '../state/store.ts';
import { sameWorkspace } from '../shared/path-form.ts';
import { openWorkspace } from '../lib/workspace-switch.ts';
import { basename, sortWorkspaces } from '../lib/workspace-identity.ts';
import { errorMessage } from '../lib/error-message.ts';
import { WorkspaceDot } from '../components/WorkspaceDot.tsx';
import { OpenPathField } from '../components/OpenPathField.tsx';
import { Page } from '../components/Page.tsx';
import type { RecentWorkspace, WorkspaceDetails, WorkspaceGit } from '../shared/protocol.gen.ts';
import { formatStarted } from './run-columns.tsx';

// Stable reference: an inline `?? []` in a zustand selector loops forever.
const EMPTY_RECENTS: RecentWorkspace[] = [];

function gitLabel(git: WorkspaceGit | null): string {
  if (git === null) return '—';
  if (git.kind === 'branch') return git.name;
  if (git.kind === 'detached') return `detached ${git.sha}`;
  return 'git';
}

function statusLabel(w: WorkspaceDetails): string {
  if (!w.exists) return 'Missing';
  if (!w.initialized) return 'Not set up';
  return 'Ready';
}

interface ColumnActions {
  isCurrent: (w: WorkspaceDetails) => boolean;
  open: (w: WorkspaceDetails) => void;
  togglePin: (w: WorkspaceDetails) => void;
  remove: (w: WorkspaceDetails) => void;
}

const makeColumns = ({ isCurrent, open, togglePin, remove }: ColumnActions): TableColumnDefinition<WorkspaceDetails>[] => [
  createTableColumn<WorkspaceDetails>({
    columnId: 'workspace',
    renderHeaderCell: () => 'Workspace',
    renderCell: w => (
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <WorkspaceDot path={w.path} identityKey={w.identityKey} />
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Text weight="semibold" truncate wrap={false}>{basename(w.path)}</Text>
            {isCurrent(w) && <Badge appearance="tint" color="brand" size="small">Current</Badge>}
          </span>
          <Text size={100} truncate wrap={false} style={{ color: 'var(--colorNeutralForeground3)' }}>
            {w.path}
          </Text>
        </span>
      </span>
    ),
  }),
  createTableColumn<WorkspaceDetails>({
    columnId: 'pinned',
    renderHeaderCell: () => 'Pinned',
    renderCell: w => (w.pinned ? <PinRegular aria-label="Pinned" /> : null),
  }),
  createTableColumn<WorkspaceDetails>({
    columnId: 'git',
    renderHeaderCell: () => 'Git',
    renderCell: w => gitLabel(w.git),
  }),
  createTableColumn<WorkspaceDetails>({
    columnId: 'status',
    renderHeaderCell: () => 'Status',
    renderCell: w => statusLabel(w),
  }),
  createTableColumn<WorkspaceDetails>({
    columnId: 'storage',
    renderHeaderCell: () => 'Storage',
    renderCell: w => (w.storage === 'local' ? 'Project' : 'User folder'),
  }),
  createTableColumn<WorkspaceDetails>({
    columnId: 'runs',
    renderHeaderCell: () => 'Runs',
    renderCell: w => (
      <span style={{ display: 'flex', flexDirection: 'column' }}>
        <Text>{w.runCount}</Text>
        {w.lastRunAt && (
          <Text size={100} style={{ color: 'var(--colorNeutralForeground3)' }}>
            {formatStarted(w.lastRunAt)}
          </Text>
        )}
      </span>
    ),
  }),
  createTableColumn<WorkspaceDetails>({
    columnId: 'lastOpened',
    renderHeaderCell: () => 'Last opened',
    renderCell: w => formatStarted(w.lastOpenedAt),
  }),
  createTableColumn<WorkspaceDetails>({
    columnId: 'actions',
    renderHeaderCell: () => 'Actions',
    renderCell: w => (
      <span style={{ display: 'flex', gap: 4 }}>
        <Button
          size="small" icon={<FolderOpenRegular />}
          aria-label={`Open ${basename(w.path)}`}
          disabled={!w.exists || isCurrent(w)}
          onClick={() => open(w)}
        >
          Open
        </Button>
        <Button
          size="small" icon={w.pinned ? <PinOffRegular /> : <PinRegular />}
          aria-label={`${w.pinned ? 'Unpin' : 'Pin'} ${basename(w.path)}`}
          onClick={() => togglePin(w)}
        >
          {w.pinned ? 'Unpin' : 'Pin'}
        </Button>
        <Tooltip
          content={isCurrent(w) ? 'Switch to another workspace first' : 'Remove from list'}
          relationship="description"
        >
          <Button
            size="small" icon={<DeleteRegular />}
            aria-label={`Remove ${basename(w.path)} from list`}
            disabledFocusable={isCurrent(w)}
            onClick={() => remove(w)}
          />
        </Tooltip>
      </span>
    ),
  }),
];

/**
 * Every workspace the app knows, with what the switcher's menu has no room
 * for: git state, whether it is set up, where its runs live. Loads on mount
 * and when the store's recents change (a pin from the switcher), not on a
 * timer.
 */
export function WorkspacesPage() {
  const client = useAgentClient();
  const { pickDirectory } = useCapabilities();
  const workspacePath = useAppStore(state => state.workspacePath);
  const identityKey = useAppStore(state => state.workspaceIdentityKey);
  const recents = useAppStore(state => state.appState?.recentWorkspaces ?? EMPTY_RECENTS);
  const patchAppState = useAppStore(state => state.patchAppState);
  const [workspaces, setWorkspaces] = useState<WorkspaceDetails[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<WorkspaceDetails | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .request('describeWorkspaces', {})
      .then(result => {
        if (cancelled) return;
        setWorkspaces(result.workspaces);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => { cancelled = true; };
  }, [client, recents]);

  const sorted = useMemo(() => sortWorkspaces(workspaces), [workspaces]);

  const isCurrent = useCallback((w: WorkspaceDetails): boolean =>
    workspacePath !== null
    && sameWorkspace(
      { path: w.path, identityKey: w.identityKey },
      { path: workspacePath, identityKey: identityKey ?? undefined },
    ), [workspacePath, identityKey]);

  const open = useCallback(async (path: string): Promise<void> => {
    setActionError(null);
    try {
      await openWorkspace(client, path);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }, [client]);

  // The store's recents change reloads the list (the effect above), so the row
  // goes away without a second describeWorkspaces call here.
  async function confirmRemove(w: WorkspaceDetails): Promise<void> {
    setRemoving(null);
    setActionError(null);
    try {
      const result = await client.request('forgetWorkspace', { path: w.path });
      patchAppState({ recentWorkspaces: result.recentWorkspaces });
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  const columns = useMemo(() => makeColumns({
    isCurrent,
    open: w => void open(w.path),
    remove: w => { if (!isCurrent(w)) setRemoving(w); },
    togglePin: w => {
      setActionError(null);
      client.request('setWorkspacePinned', { path: w.path, pinned: !w.pinned })
        .then(result => patchAppState({ recentWorkspaces: result.recentWorkspaces }))
        .catch((err: unknown) => setActionError(errorMessage(err)));
    },
  }), [isCurrent, open, client, patchAppState]);

  async function browse(): Promise<void> {
    if (!pickDirectory) return;
    const selected = await pickDirectory();
    if (selected) await open(selected);
  }

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, width: '100%' }}>
      <Text weight="semibold" size={500}>Workspaces</Text>
      {pickDirectory ? (
        <Button icon={<FolderOpenRegular />} onClick={() => void browse()}>Browse…</Button>
      ) : (
        <OpenPathField label="Open path…" onOpen={open} />
      )}
    </div>
  );

  return (
    <Page header={header}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {loadError && <Text role="alert">Failed to load workspaces: {loadError}</Text>}
        {actionError && <Text role="alert">{actionError}</Text>}
        {sorted.length === 0 ? (
          !loadError && (
            <Text>
              No workspaces yet. {pickDirectory ? 'Use Browse… to open a folder.' : 'Use Open path… to open a folder.'}
            </Text>
          )
        ) : (
          <DataGrid items={sorted} columns={columns} getRowId={w => w.path} sortable={false}>
            <DataGridHeader>
              <DataGridRow>
                {({ renderHeaderCell }) => <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>}
              </DataGridRow>
            </DataGridHeader>
            <DataGridBody<WorkspaceDetails>>
              {({ item, rowId }) => (
                <DataGridRow<WorkspaceDetails> key={rowId}>
                  {({ renderCell }) => <DataGridCell>{renderCell(item)}</DataGridCell>}
                </DataGridRow>
              )}
            </DataGridBody>
          </DataGrid>
        )}
      </div>
      {removing && (
        <Dialog open onOpenChange={(_event, data) => { if (!data.open) setRemoving(null); }}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Remove {basename(removing.path)}?</DialogTitle>
              <DialogContent>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <Text>
                    This workspace is forgotten from the list and its remembered workflow and inputs are
                    cleared. No files are deleted. You can reopen it any time.
                  </Text>
                  {removing.pinned && <Text>It is pinned, so it will also be unpinned.</Text>}
                </div>
              </DialogContent>
              <DialogActions>
                <Button appearance="primary" onClick={() => void confirmRemove(removing)}>Remove</Button>
                <Button onClick={() => setRemoving(null)}>Cancel</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
    </Page>
  );
}
