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
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Spinner,
  Switch,
  Text,
  ToggleButton,
  type TableColumnDefinition,
} from '@fluentui/react-components';
import { Add20Regular, Delete16Regular, LockClosed16Regular, LockOpen16Regular } from '@fluentui/react-icons';
import { useAgentClient } from '../agent/agent-context.tsx';
import { useAppStore, waitingRunIds } from '../state/store.ts';
import type { RunSummary } from '../agent/client.ts';
import { POLL_INTERVAL_MS, runColumns, runLabel } from './run-columns.tsx';
import { NewRunDialog } from '../components/NewRunDialog.tsx';

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
  const jobs = useAppStore(state => state.jobs);
  // useMemo rather than a Set-returning selector: zustand compares with
  // Object.is, so a fresh Set per call would re-render this grid on every
  // unrelated store write.
  const waiting = useMemo(
    () => waitingRunIds(jobs, workspacePath ?? undefined),
    [jobs, workspacePath],
  );
  const [error, setError] = useState<string | null>(null);
  const [showDryRuns, setShowDryRuns] = useState(false);
  const [showInterrupted, setShowInterrupted] = useState(true);
  const [newRunOpen, setNewRunOpen] = useState(false);
  /** The run awaiting delete confirmation; null when no dialog is open. */
  const [deleting, setDeleting] = useState<RunSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
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
        setError(err instanceof Error ? err.message : String(err));
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

  async function confirmDelete(): Promise<void> {
    if (!workspacePath || !deleting) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const result = await client.request('deleteRun', { workdir: workspacePath, runId: deleting.runId });
      if (!result.deleted) {
        setDeleteError(
          result.reason === 'locked' ? 'This run is locked.'
            : result.reason === 'running' ? 'This run is still running.'
              : 'This run no longer exists.',
        );
        return;
      }
      setDeleting(null);
      poll();
    } finally {
      setDeleteBusy(false);
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
          onClick={event => { event.stopPropagation(); setDeleting(run); setDeleteError(null); }}
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
    () => [...runColumns<RunSummary>(waiting), actionsColumn],
    [waiting, actionsColumn],
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
        // Mounted only while a delete is pending confirmation: a closed-but-
        // mounted Dialog is still a live Fluent Modalizer (see FilesPage).
        <Dialog
          open
          onOpenChange={(_event, data) => {
            // A deleteRun already issued can't be un-issued: dismissal (Esc,
            // backdrop, window close) must not lie about having stopped it.
            if (!data.open && !deleteBusy) setDeleting(null);
          }}
        >
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Delete {deleting.name ?? `run ${deleting.runId}`}?</DialogTitle>
              <DialogContent>
                This deletes the run's directory and everything in it. This cannot be undone.
                {deleteError ? ` — ${deleteError}` : ''}
              </DialogContent>
              <DialogActions>
                <Button appearance="primary" disabled={deleteBusy} onClick={() => void confirmDelete()}>
                  {deleteBusy ? <Spinner size="tiny" /> : 'Delete'}
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
