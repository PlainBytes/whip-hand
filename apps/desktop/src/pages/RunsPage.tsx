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
  Spinner,
  Switch,
  Text,
  ToggleButton,
  type TableColumnDefinition,
} from '@fluentui/react-components';
import { Add20Regular, Delete16Regular, LockClosed16Regular, LockOpen16Regular } from '@fluentui/react-icons';
import { useAgentClient } from '../agent/agent-context.tsx';
import { liveStageProgress, useAppStore, waitingRunIds } from '../state/store.ts';
import { sameSet, sameStageProgress, useAppStoreStable } from '../state/use-stable-selector.ts';
import type { RunSummary } from '../agent/client.ts';
import { POLL_INTERVAL_MS, runColumns, runLabel } from './run-columns.tsx';
import { NewRunDialog } from '../components/NewRunDialog.tsx';
import { DeleteRunDialog } from '../components/DeleteRunDialog.tsx';
import { errorMessage } from '../lib/error-message.ts';

export interface RunsPageProps {
  onSelectRun: (runId: string) => void;
  onStarted: (jobId: string) => void;
}

/** Fluent DataGrid over listRuns, polled every 5s, with dry-run/interrupted filters. */
export function RunsPage({ onSelectRun, onStarted }: RunsPageProps) {
  const client = useAgentClient();
  const workspacePath = useAppStore(state => state.workspacePath);
  const runs = useAppStore(state => state.runs);
  const setRuns = useAppStore(state => state.setRuns);
  const pendingRunAgain = useAppStore(state => state.pendingRunAgain);
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
  const [newRunOpen, setNewRunOpen] = useState(false);
  /** The run awaiting delete confirmation; null when no dialog is open. */
  const [deleting, setDeleting] = useState<RunSummary | null>(null);
  const [lockingId, setLockingId] = useState<string | null>(null);

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
    if (pendingRunAgain) setNewRunOpen(true);
  }, [pendingRunAgain]);

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
        <ToggleButton
          size="small"
          checked={!!run.locked}
          disabled={lockingId === run.runId}
          icon={
            lockingId === run.runId ? <Spinner size="tiny" />
              : run.locked ? <LockClosed16Regular /> : <LockOpen16Regular />
          }
          aria-label={run.locked ? `Unlock ${runLabel(run)}` : `Lock ${runLabel(run)}`}
          onClick={event => { event.stopPropagation(); void handleToggleLock(run); }}
        >
          {run.locked ? 'Locked' : 'Lock'}
        </ToggleButton>
        <Button
          size="small"
          icon={<Delete16Regular />}
          aria-label={`Delete ${runLabel(run)}`}
          onClick={event => { event.stopPropagation(); setDeleting(run); }}
        >
          Delete
        </Button>
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

  if (!workspacePath) {
    return <Text>Choose a workspace to see its runs.</Text>;
  }

  const matchesFilters = (run: RunSummary): boolean => {
    if (!showDryRuns && run.dryRun === true) return false;
    if (!showInterrupted && run.status === 'interrupted') return false;
    return true;
  };
  const filtered = runs.filter(matchesFilters);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 16 }}>
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
        </div>
        <Button appearance="primary" icon={<Add20Regular />} onClick={() => setNewRunOpen(true)}>
          New run
        </Button>
      </div>
      {newRunOpen && (
        <NewRunDialog
          open
          onOpenChange={setNewRunOpen}
          onStarted={jobId => {
            setNewRunOpen(false);
            onStarted(jobId);
          }}
        />
      )}
      {error && <Text>Failed to load runs: {error}</Text>}
      {filtered.length === 0 ? (
        <Text>No runs match the current filters.</Text>
      ) : (
        <DataGrid items={filtered} columns={columns} getRowId={run => run.runId} sortable={false}>
          <DataGridHeader>
            <DataGridRow>
              {({ renderHeaderCell }) => <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>}
            </DataGridRow>
          </DataGridHeader>
          <DataGridBody<RunSummary>>
            {({ item, rowId }) => (
              <DataGridRow<RunSummary>
                key={rowId}
                onClick={() => onSelectRun(item.runId)}
                style={{ cursor: 'pointer' }}
              >
                {({ renderCell }) => <DataGridCell>{renderCell(item)}</DataGridCell>}
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
          onDeleted={() => {
            setDeleting(null);
            poll();
          }}
          onDismiss={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
