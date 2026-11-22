import type { ReactNode } from 'react';
import { Text, tokens } from '@fluentui/react-components';
import type { RunSummary } from '../agent/client.ts';
import { StatusBadge } from './StatusBadge.tsx';
import { WorkspaceDot } from './WorkspaceDot.tsx';
import { basename } from '../lib/workspace-identity.ts';
import {
  formatDuration, formatStarted, LockedMarker, runLabel, runStageProgress, WorktreeMarker,
  type StageProgress,
} from '../pages/run-columns.tsx';

export interface RunCardProps {
  run: RunSummary;
  /** True for a live run blocked on the human: its badge reads 'waiting', as in the grid. */
  waiting: boolean;
  stages: ReadonlyMap<string, StageProgress>;
  /** Activity names the run's workspace; Runs is one workspace and leaves this out. */
  workspace?: { path: string; identityKey?: string };
  onOpen: () => void;
  /** Row actions, beside the card's button rather than inside it (a button cannot hold buttons). */
  actions?: ReactNode;
}

const dim = { color: tokens.colorNeutralForeground3 } as const;

/**
 * One run as a stacked-list card, the narrow layout's stand-in for a grid row:
 * name and status, then workflow and stage progress, then started and
 * duration. Cells come from run-columns' helpers so both layouts read alike.
 */
export function RunCard({ run, waiting, stages, workspace, onOpen, actions }: RunCardProps) {
  const label = runLabel(run);
  const status = waiting ? 'waiting' : run.status;
  const progress = runStageProgress(run, stages);
  const workflow = typeof run.workflow === 'string' ? run.workflow : '—';
  return (
    <div
      data-testid={`run-card-${run.runId}`}
      style={{
        display: 'flex', alignItems: 'stretch', gap: 4,
        border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6,
        background: tokens.colorNeutralBackground1,
      }}
    >
      <button
        type="button"
        aria-label={`${label}, ${status}`}
        onClick={onOpen}
        style={{
          all: 'unset', boxSizing: 'border-box', flex: 1, minWidth: 0, minHeight: 44, cursor: 'pointer',
          padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 4,
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <Text weight="semibold" truncate wrap={false} style={{ flex: 1, minWidth: 0 }}>{label}</Text>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            <WorktreeMarker run={run} />
            <LockedMarker run={run} />
            <StatusBadge status={status} />
          </span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <Text size={200} truncate wrap={false} style={{ minWidth: 0 }}>{workflow}</Text>
          {run.subdir !== undefined && (
            <Text size={100} truncate wrap={false} data-testid={`run-subdir-${run.runId}`}
              style={{ ...dim, fontFamily: tokens.fontFamilyMonospace, minWidth: 0 }}>
              {run.subdir}
            </Text>
          )}
          {progress !== undefined && (
            <Text size={200} style={{ flexShrink: 0 }} data-testid={`run-stage-progress-${run.runId}`}>
              {`stage ${progress.index}/${progress.total}`}
            </Text>
          )}
        </span>
        <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Text size={200} style={dim}>{formatStarted(run.startedAt)}</Text>
          <Text size={200} style={dim}>{formatDuration(run)}</Text>
        </span>
        {workspace !== undefined && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <WorkspaceDot path={workspace.path} identityKey={workspace.identityKey} size={12} />
            <Text size={200} truncate wrap={false} style={{ minWidth: 0 }}>{basename(workspace.path)}</Text>
          </span>
        )}
      </button>
      {actions !== undefined && <div style={{ display: 'flex', alignItems: 'center', paddingRight: 4 }}>{actions}</div>}
    </div>
  );
}
