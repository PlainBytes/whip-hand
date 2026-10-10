/**
 * The run table's shared shape: the workflow/run/status/started/duration
 * columns, and the formatting they need. Used by both the per-workspace Runs
 * grid and the cross-workspace Activity grid, which differ only in the
 * leading Workspace column.
 */
import { createTableColumn, tokens, type TableColumnDefinition } from '@fluentui/react-components';
import { BranchFork16Regular, LockClosed16Regular } from '@fluentui/react-icons';
import type { RunSummary } from '../agent/client.ts';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { elapsedMs, formatElapsed } from '../shared/format.ts';

export type RecentRun = RunSummary & { workspace: string; identityKey?: string };

export const POLL_INTERVAL_MS = 5000;

/**
 * What to call a run in prose — a dialog title, an aria-label. The grid cell
 * shows both the name and the id; everywhere else one string has to do, and
 * the name is the one a human recognizes.
 */
export function runLabel(run: RunSummary): string {
  return run.name ?? run.runId;
}

export function formatStarted(startedAt: unknown): string {
  if (typeof startedAt !== 'string') return '—';
  const parsed = Date.parse(startedAt);
  return Number.isNaN(parsed) ? '—' : new Date(parsed).toLocaleString();
}

function formatDuration(run: RunSummary): string {
  const startedAt = typeof run.startedAt === 'string' ? run.startedAt : undefined;
  // A run that never wrote endedAt (one still going, or one abandoned before
  // core could repair it) must not keep growing on every poll — fall back to
  // the last sign of life we have.
  const lastSeen = [run.endedAt, run.heartbeatAt, run.updatedAt]
    .find((v): v is string => typeof v === 'string');
  const end = lastSeen ? Date.parse(lastSeen) : Date.now();
  const ms = elapsedMs(startedAt, end);
  return ms === null ? '—' : formatElapsed(ms);
}

/** Where a run is among a `stages` step's stage files — `stage 3/7` in the status cell. */
export interface StageProgress { index: number; total: number }

/**
 * A run's stage progress as its manifest records it: the stages step it
 * stopped in (or is still in) — one that is not done and has named a current
 * stage. A stages step that finished is no longer where the run is. The
 * summary is the manifest itself (see core's RunSummaryKnown), so `steps` is
 * there to read; anything malformed just reads as no progress.
 */
export function manifestStageProgress(run: RunSummary): StageProgress | undefined {
  if (!Array.isArray(run.steps)) return undefined;
  for (const step of run.steps as Array<Record<string, unknown>>) {
    if (step?.kind !== 'stages' || step.status === 'done' || step.status === 'disabled') continue;
    const current = step.currentStage as { index?: unknown } | undefined;
    if (typeof current?.index === 'number' && typeof step.total === 'number') {
      return { index: current.index, total: step.total };
    }
  }
  return undefined;
}

/**
 * The columns every run grid shares. `stages` is live stage progress by
 * runId (see the store's `liveStageProgress`), which wins over the manifest's
 * copy for a run this app is watching: a job hears a stage start at once, the
 * grid's poll only every few seconds.
 */
export function runColumns<T extends RunSummary>(
  waiting: ReadonlySet<string>, stages: ReadonlyMap<string, StageProgress> = new Map(),
): TableColumnDefinition<T>[] {
  return [
    createTableColumn<T>({
      columnId: 'workflow',
      renderHeaderCell: () => 'Workflow',
      renderCell: run => (typeof run.workflow === 'string' ? run.workflow : '—'),
    }),
    createTableColumn<T>({
      // Still 'runId': both grids address this column by that id.
      columnId: 'runId',
      renderHeaderCell: () => 'Run',
      // The glyph shows wherever a run appears — including the cross-workspace
      // Activity grid, which is correct: a locked run reads as locked everywhere.
      //
      // A named run leads with its name and keeps the id beneath it, dimmed:
      // the name is what a human recognizes, but the id is what `--resume`
      // and `whiphand rename-run` take, so it must stay readable and copyable.
      renderCell: run => (
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
          {run.locked && <LockClosed16Regular aria-label="locked" />}
          {run.worktree && (
            <span title={`Worktree on branch ${run.worktree.branch}\n${run.worktree.path}`} style={{ display: 'inline-flex' }}>
              <BranchFork16Regular aria-label="worktree" />
            </span>
          )}
          {run.name === undefined ? run.runId : (
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {run.name}
              </span>
              <span style={{
                fontFamily: tokens.fontFamilyMonospace,
                fontSize: tokens.fontSizeBase100,
                color: tokens.colorNeutralForeground3,
              }}>
                {run.runId}
              </span>
            </span>
          )}
        </span>
      ),
    }),
    createTableColumn<T>({
      columnId: 'status',
      renderHeaderCell: () => 'Status',
      // A live run blocked on the human still reads 'running' on disk. Swap the
      // pill people already scan rather than adding a column the grid must carry.
      //
      // A run inside a stages step reports progress in stages beside it —
      // `running · stage 3/7` — rather than leaving a long staged run a bare
      // 'running' for an hour.
      renderCell: run => {
        const progress = stages.get(run.runId) ?? manifestStageProgress(run);
        return (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <StatusBadge status={waiting.has(run.runId) ? 'waiting' : run.status} />
            {progress !== undefined && (
              <span data-testid={`run-stage-progress-${run.runId}`}>
                {` · stage ${progress.index}/${progress.total}`}
              </span>
            )}
          </span>
        );
      },
    }),
    createTableColumn<T>({
      columnId: 'started',
      renderHeaderCell: () => 'Started',
      renderCell: run => formatStarted(run.startedAt),
    }),
    createTableColumn<T>({
      columnId: 'duration',
      renderHeaderCell: () => 'Duration',
      renderCell: run => formatDuration(run),
    }),
  ];
}
