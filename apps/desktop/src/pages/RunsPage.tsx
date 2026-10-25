import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  createTableColumn,
  DataGrid,
  DataGridBody,
  DataGridCell,
  DataGridHeader,
  DataGridHeaderCell,
  DataGridRow,
  MessageBar,
  MessageBarBody,
  Spinner,
  Switch,
  Text,
  Tooltip,
  type TableColumnDefinition,
} from '@fluentui/react-components';
import { Add20Regular, Delete16Regular, LockClosed16Regular, LockOpen16Regular } from '@fluentui/react-icons';
import { useAgentClient } from '../agent/agent-context.tsx';
import { liveStageProgress, useAppStore, waitingRunIds } from '../state/store.ts';
import { sameSet, sameStageProgress, useAppStoreStable } from '../state/use-stable-selector.ts';
import type { RunSummary } from '../agent/client.ts';
import { POLL_INTERVAL_MS, runColumns, runColumnStyle, runLabel } from './run-columns.tsx';
import { DeleteRunDialog } from '../components/DeleteRunDialog.tsx';
import { errorMessage } from '../lib/error-message.ts';
import { DangerButton } from '../components/DangerButton.tsx';
import { OpenInEditorButton } from '../components/OpenInEditorButton.tsx';
import { useClickOrDoubleClick } from '../lib/use-click-or-double-click.ts';
import { Page } from '../components/Page.tsx';
import { actionLabel } from '../lib/keymap/keymap.ts';
import { useKeymap } from '../lib/keymap/use-keymap.ts';

export interface RunsPageProps {
  /** A single click opens a preview tab; a double click (`pin`) a pinned one. */
  onSelectRun: (runId: string, pin: boolean) => void;
  /** Opens a new draft tab. */
  onNewRun: () => void;
}

/** Fluent DataGrid over listRuns, polled every 5s, with dry-run/interrupted filters. */
export function RunsPage({ onSelectRun, onNewRun }: RunsPageProps) {
  const client = useAgentClient();
  const keymap = useKeymap();
  const workspacePath = useAppStore(state => state.workspacePath);
  const runs = useAppStore(state => state.runs);
  const setRuns = useAppStore(state => state.setRuns);
  const identityKey = useAppStore(state => state.workspaceIdentityKey);
  const workspace = useMemo(
    () => (workspacePath === null ? undefined : { path: workspacePath, identityKey: identityKey ?? undefined }),
    [workspacePath, identityKey],
  );
  // Compared by content, not identity: `jobs` changes on every pty chunk and
  // log line, and a new Set here rebuilds the columns and the whole grid.
  const waiting = useAppStoreStable(state => waitingRunIds(state.jobs, workspace), sameSet);
  const stages = useAppStoreStable(state => liveStageProgress(state.jobs, workspace), sameStageProgress);
  const [error, setError] = useState<string | null>(null);
  const [showDryRuns, setShowDryRuns] = useState(false);
  const [showInterrupted, setShowInterrupted] = useState(true);
  /** The run awaiting delete confirmation; null when no dialog is open. */
  const [deleting, setDeleting] = useState<RunSummary | null>(null);
  const [lockingId, setLockingId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const rowClick = useClickOrDoubleClick<string>(onSelectRun);

  // Hoisted out of the polling effect so row actions can trigger an immediate
  // re-poll on success, rather than mutating local state and risking drift
  // from what the filesystem actually has.
  const poll = useCallback(() => {
    if (!workspacePath) return;
    client
      .request('listRuns', { workdir: workspacePath })
      .then(result => {
        setRuns(result);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      });
  }, [client, workspacePath, setRuns]);

  useEffect(() => {
    if (!workspacePath) return;
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [workspacePath, poll]);

  async function handleToggleLock(run: RunSummary): Promise<void> {
    if (!workspacePath) return;
    setLockingId(run.runId);
    try {
      await client.request('setRunLocked', { workdir: workspacePath, runId: run.runId, locked: !run.locked });
      poll();
    } finally {
      setLockingId(null);
    }
  }

  // Owned by this page (not the shared runColumns): Activity is cross-workspace
  // and read-only, so it has no business offering a lock/delete row action.
  const actionsColumn = useMemo<TableColumnDefinition<RunSummary>>(() => createTableColumn<RunSummary>({
    columnId: 'actions',
    renderHeaderCell: () => 'Actions',
    renderCell: run => (
      <div style={{ display: 'flex', gap: 8 }}>
        {workspacePath && (
          <OpenInEditorButton
            workdir={workspacePath}
            worktree={run.worktree ?? undefined}
            subdir={run.subdir}
            size="small"
            iconOnly
            onError={setOpenError}
          />
        )}
        <Tooltip content={run.locked ? `Unlock ${runLabel(run)}` : `Lock ${runLabel(run)}`} relationship="label">
          <Button
            size="small"
            appearance="secondary"
            disabled={lockingId === run.runId}
            icon={
              lockingId === run.runId ? <Spinner size="tiny" />
                : run.locked ? <LockClosed16Regular /> : <LockOpen16Regular />
            }
            onClick={event => { event.stopPropagation(); void handleToggleLock(run); }}
          />
        </Tooltip>
        <Tooltip content={`Delete ${runLabel(run)}`} relationship="label">
          <DangerButton
            variant="subtle"
            size="small"
            icon={<Delete16Regular />}
            onClick={event => { event.stopPropagation(); setDeleting(run); }}
          />
        </Tooltip>
      </div>
    ),
    // handleToggleLock isn't memoized (it closes over poll, which already
    // depends on workspacePath); listing it here would rebuild the column
    // every render and defeat the memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [lockingId, workspacePath]);

  const columns = useMemo(
    () => [...runColumns<RunSummary>(waiting, stages), actionsColumn],
    [waiting, stages, actionsColumn],
  );

  const title = <Text weight="semibold" size={500}>Runs</Text>;

  if (!workspacePath) {
    return <Page header={title}><Text>Choose a workspace to see its runs.</Text></Page>;
  }

  const matchesFilters = (run: RunSummary): boolean => {
    if (!showDryRuns && run.dryRun === true) return false;
    if (!showInterrupted && run.status === 'interrupted') return false;
    return true;
  };
  const filtered = runs.filter(matchesFilters);

  const header = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
      {title}
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexShrink: 0 }}>
        <Switch
          label="Show dry runs"
          checked={showDryRuns}
          onChange={(_e, data) => setShowDryRuns(data.checked)}
        />
        <Switch
          label="Show interrupted"
          checked={showInterrupted}
          onChange={(_e, data) => setShowInterrupted(data.checked)}
        />
        <Tooltip content={`New run (${actionLabel(keymap, 'tabs.newRun')})`} relationship="description">
          <Button appearance="primary" icon={<Add20Regular />} onClick={onNewRun}>
            New run
          </Button>
        </Tooltip>
      </div>
    </div>
  );

  return (
    <Page header={header}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {error && <Text>Failed to load runs: {error}</Text>}
      {openError && (
        <MessageBar intent="error" data-testid="runs-open-error">
          <MessageBarBody>{openError}</MessageBarBody>
        </MessageBar>
      )}
      {filtered.length === 0 ? (
        <Text>No runs match the current filters.</Text>
      ) : (
        <DataGrid items={filtered} columns={columns} getRowId={run => run.runId} sortable={false}>
          <DataGridHeader>
            <DataGridRow>
              {({ columnId, renderHeaderCell }) => (
                <DataGridHeaderCell style={runColumnStyle(columnId)}>{renderHeaderCell()}</DataGridHeaderCell>
              )}
            </DataGridRow>
          </DataGridHeader>
          <DataGridBody<RunSummary>>
            {({ item, rowId }) => (
              <DataGridRow<RunSummary>
                key={rowId}
                onClick={() => rowClick.click(item.runId)}
                onDoubleClick={() => rowClick.doubleClick(item.runId)}
                style={{ cursor: 'pointer' }}
              >
                {({ columnId, renderCell }) => (
                  <DataGridCell style={runColumnStyle(columnId)}>{renderCell(item)}</DataGridCell>
                )}
              </DataGridRow>
            )}
          </DataGridBody>
        </DataGrid>
      )}
      {deleting && (
        <DeleteRunDialog
          workdir={workspacePath}
          runId={deleting.runId}
          name={deleting.name}
          {...(deleting.worktree ? { worktreePath: deleting.worktree.path } : {})}
          onDeleted={() => {
            setDeleting(null);
            poll();
          }}
          onDismiss={() => setDeleting(null)}
        />
      )}
    </div>
    </Page>
  );
}
