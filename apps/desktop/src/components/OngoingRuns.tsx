import { Button, Spinner, Tooltip } from '@fluentui/react-components';
import { DismissCircleFilled, PauseCircleFilled } from '@fluentui/react-icons';
import { WorkspaceDot } from './WorkspaceDot.tsx';
import { RowGlyph, RowTrailing, SIDEBAR_ROW_GAP, SIDEBAR_ROW_STYLE } from './sidebar-row.tsx';
import { isWaitingJob, type JobState } from '../state/store.ts';
import { AWAIT_LABEL, manualLabel } from '../lib/await-copy.ts';
import { basename } from '../lib/workspace-identity.ts';

/** Beyond this, the rest collapse into a single "+N more" row into Activity. */
const MAX_ROWS = 5;

function rowName(job: JobState): string {
  return job.runName ?? job.runId ?? '(starting…)';
}

/**
 * The precise wording for what a job is doing, shared by the tooltip and the
 * accessible name — `AWAIT_LABEL`/`manualLabel` are already the one place
 * this copy is centralised, so the row does not invent its own "waiting".
 */
function stateLabel(job: JobState): string {
  if (job.awaiting) return AWAIT_LABEL[job.awaiting.reason];
  if (job.pendingManual) return manualLabel(job.pendingManual.kind);
  return 'running';
}

export type RunStatus = 'running' | 'waiting' | 'failed';

/**
 * The row's trailing glyph, mirroring the shape of `StepStatusIcon`. `failed`
 * is not reachable from this list today — `ongoingJobs` filters to
 * `!job.finished`, so a failed run leaves the sidebar the moment it fails —
 * but is kept ready for if that selector ever changes, and is exercised
 * directly by tests.
 */
export function RunStatusIcon({ status }: { status: RunStatus }) {
  switch (status) {
    case 'running':
      return <Spinner size="extra-tiny" />;
    case 'waiting':
      return <PauseCircleFilled fontSize={16} style={{ color: 'var(--colorPaletteDarkOrangeForeground1)' }} />;
    case 'failed':
      return <DismissCircleFilled fontSize={16} style={{ color: 'var(--colorPaletteRedForeground1)' }} />;
  }
}

export interface OngoingRunsProps {
  jobs: JobState[];
  onOpenRun: (job: JobState) => void;
  /** The cap keeps this section's height bounded; the overflow row is how the true count stays reachable. */
  onShowMore: () => void;
}

/**
 * Shared by every row in this list. `+N more` gets an empty `<RowGlyph>` of
 * its own, so it's the row's *content*, not just this button style, that
 * lines up with the run names above it.
 */
const ROW_STYLE = { ...SIDEBAR_ROW_STYLE, minWidth: 0 };

/**
 * Clickable rows for live jobs — running or blocked on the human — above the
 * Activity item, so switching to the one that needs attention doesn't
 * require a detour through the Activity grid. Purely derived from
 * `state.jobs` via the `ongoingJobs` selector; see Sidebar for the
 * preference that can hide this section entirely.
 */
export function OngoingRuns({ jobs, onOpenRun, onShowMore }: OngoingRunsProps) {
  if (jobs.length === 0) return null;
  const shown = jobs.slice(0, MAX_ROWS);
  const overflow = jobs.length - shown.length;

  return (
    <div
      role="group"
      aria-label="Ongoing runs"
      style={{ display: 'flex', flexDirection: 'column', gap: SIDEBAR_ROW_GAP }}
    >
      {shown.map(job => {
        const waiting = isWaitingJob(job);
        const name = rowName(job);
        const label = stateLabel(job);
        const workspace = job.workdir ? basename(job.workdir) : undefined;
        const tooltip = `${name} — ${label}${workspace ? ` · ${workspace}` : ''}`;
        return (
          <Tooltip key={job.jobId} content={tooltip} relationship="description">
            <Button
              appearance="subtle"
              aria-label={tooltip}
              onClick={() => onOpenRun(job)}
              style={ROW_STYLE}
            >
              <span style={{ display: 'flex', alignItems: 'center', width: '100%', minWidth: 0 }}>
                <RowGlyph>
                  {job.workdir && <WorkspaceDot path={job.workdir} />}
                </RowGlyph>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
                  {name}
                </span>
                <RowTrailing>
                  <RunStatusIcon status={waiting ? 'waiting' : 'running'} />
                </RowTrailing>
              </span>
            </Button>
          </Tooltip>
        );
      })}
      {overflow > 0 && (
        <Button
          appearance="subtle"
          onClick={onShowMore}
          style={ROW_STYLE}
        >
          <span style={{ display: 'flex', alignItems: 'center', width: '100%', minWidth: 0 }}>
            <RowGlyph />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
              +{overflow} more
            </span>
          </span>
        </Button>
      )}
    </div>
  );
}
