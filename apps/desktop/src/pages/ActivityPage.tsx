import { useEffect, useMemo, useState } from 'react';
import {
  createTableColumn, DataGrid, DataGridBody, DataGridCell, DataGridHeader,
  DataGridHeaderCell, DataGridRow, Text, type TableColumnDefinition,
} from '@fluentui/react-components';
import { useAgentClient } from '../agent/agent-context.tsx';
import { liveStageProgress, useAppStore, waitingRunIds } from '../state/store.ts';
import { sameWorkspace } from '../../../../packages/core/src/path-form.ts';
import { openWorkspace } from '../lib/workspace-switch.ts';
import { basename } from '../lib/workspace-identity.ts';
import { WorkspaceDot } from '../components/WorkspaceDot.tsx';
import { POLL_INTERVAL_MS, runColumns, type RecentRun, type StageProgress } from './run-columns.tsx';
import { errorMessage } from '../lib/error-message.ts';

export interface ActivityPageProps {
  onSelectRun: (runId: string) => void;
}

const makeColumns = (
  waiting: ReadonlySet<string>, stages: ReadonlyMap<string, StageProgress>,
): TableColumnDefinition<RecentRun>[] => [
  createTableColumn<RecentRun>({
    columnId: 'workspace',
    renderHeaderCell: () => 'Workspace',
    renderCell: run => (
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <WorkspaceDot path={run.workspace} identityKey={run.identityKey} />
        {basename(run.workspace)}
      </span>
    ),
  }),
  ...runColumns<RecentRun>(waiting, stages),
];

/**
 * Runs across every recent workspace, so you can work in one and still see
 * what the others are doing. Runs is deliberately this workspace only — the
 * split is the whole point of the sidebar's two groups.
 *
 * The rows come off disk, so they include runs started by `whiphand run` in a
 * terminal, which this app has no job for. The sidebar's badge counts live
 * jobs instead. The two legitimately disagree.
 */
export function ActivityPage({ onSelectRun }: ActivityPageProps) {
  const client = useAgentClient();
  const workspacePath = useAppStore(state => state.workspacePath);
  const identityKey = useAppStore(state => state.workspaceIdentityKey);
  const jobs = useAppStore(state => state.jobs);
  const [runs, setRuns] = useState<RecentRun[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Unfiltered: every workspace's waiting jobs are relevant here, which is
  // exactly what this page is for.
  const waiting = useMemo(() => waitingRunIds(jobs), [jobs]);
  const stages = useMemo(() => liveStageProgress(jobs), [jobs]);
  const columns = useMemo(() => makeColumns(waiting, stages), [waiting, stages]);

  useEffect(() => {
    let cancelled = false;

    function poll(): void {
      client
        .request('listRecentRuns', { limit: 50 })
        .then(result => {
          if (cancelled) return;
          setRuns(result);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(errorMessage(err));
        });
    }

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [client]);

  async function openRun(entry: RecentRun): Promise<void> {
    const here = workspacePath === null ? null : { path: workspacePath, identityKey: identityKey ?? undefined };
    if (here === null || !sameWorkspace({ path: entry.workspace, identityKey: entry.identityKey }, here)) {
      try {
        await openWorkspace(client, entry.workspace);
      } catch {
        // Don't navigate into a run in a workspace we failed to switch to —
        // RunDetailPage would call getRun against the old workdir, producing a
        // confusing "unknown run" instead of a clear "couldn't open that
        // workspace".
        setError(`Could not open workspace: ${entry.workspace}`);
        return;
      }
    }
    onSelectRun(entry.runId);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {error && <Text>Failed to load activity: {error}</Text>}
      {runs.length === 0 ? (
        <Text>No runs yet in any recent workspace.</Text>
      ) : (
        <DataGrid items={runs} columns={columns} getRowId={run => `${run.workspace}:${run.runId}`} sortable={false}>
          <DataGridHeader>
            <DataGridRow>
              {({ renderHeaderCell }) => <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>}
            </DataGridRow>
          </DataGridHeader>
          <DataGridBody<RecentRun>>
            {({ item, rowId }) => (
              <DataGridRow<RecentRun>
                key={rowId}
                onClick={() => void openRun(item)}
                style={{ cursor: 'pointer' }}
              >
                {({ renderCell }) => <DataGridCell>{renderCell(item)}</DataGridCell>}
              </DataGridRow>
            )}
          </DataGridBody>
        </DataGrid>
      )}
    </div>
  );
}
