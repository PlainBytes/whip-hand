import type { ReactNode } from 'react';
import { Button, Text } from '@fluentui/react-components';
import { ChevronDownRegular, ChevronRightRegular } from '@fluentui/react-icons';
import type { StageRollup } from '../../lib/stage-rollup.ts';
import { StepStatusIcon } from './StepPill.tsx';

/**
 * The stage that starts open: the one holding the focused step, else the
 * first still running, else the last that failed or was interrupted — the
 * place someone reading a stopped run wants to look. A run that finished
 * cleanly has none, and opens fully collapsed.
 */
export function defaultExpandedStage(
  rows: readonly { stageKey: string; rollup: StageRollup }[],
  focusStageKey: string | undefined,
): string | undefined {
  if (focusStageKey !== undefined) return focusStageKey;
  const running = rows.find(row => row.rollup.status === 'running');
  if (running !== undefined) return running.stageKey;
  return rows.findLast(row => row.rollup.status === 'failed' || row.rollup.status === 'interrupted')?.stageKey;
}

/**
 * '9 steps · 21m · 20 turns · $1.84'. A part nobody reported is left out
 * rather than shown as a zero, as `spendSummary` does for a pill.
 */
function summaryLine(rollup: StageRollup): string {
  return [
    rollup.steps === 0 ? null : `${rollup.steps} step${rollup.steps === 1 ? '' : 's'}`,
    rollup.elapsed,
    rollup.spend,
  ].filter((part): part is string => part !== null).join(' · ');
}

/**
 * One stage of a `stages` step: a header line that is the whole stage when
 * collapsed, and its pills beneath when open.
 *
 * Presentational on purpose. The body is handed in rather than rendered from
 * the tree, so this file never imports `NodeView` (which renders it) and the
 * two do not form a cycle.
 */
export function StageRow({
  stageKey, label, rollup, expanded, onToggle, children,
}: {
  stageKey: string;
  label: string;
  rollup: StageRollup;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div data-testid={`stage-group-${stageKey}`} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Button
        appearance="subtle"
        size="small"
        aria-expanded={expanded}
        data-testid={`stage-toggle-${stageKey}`}
        onClick={onToggle}
        style={{ width: '100%', justifyContent: 'flex-start', gap: 8 }}
      >
        {expanded ? <ChevronDownRegular /> : <ChevronRightRegular />}
        <StepStatusIcon status={rollup.status} />
        <Text
          size={200}
          data-testid={`stage-label-${stageKey}`}
          style={{ color: 'var(--colorNeutralForeground2)' }}
        >
          {label}
        </Text>
        {/* The least important thing on the line, so it sits at the far end and reads quietest. */}
        <Text
          size={200}
          data-testid={`stage-summary-${stageKey}`}
          style={{ marginLeft: 'auto', color: 'var(--colorNeutralForeground3)' }}
        >
          {summaryLine(rollup)}
        </Text>
      </Button>
      {expanded && (
        // Indented past the chevron so the pills line up under the label.
        <div
          data-testid={`stage-body-${stageKey}`}
          style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 24, minWidth: 0 }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
