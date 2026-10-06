import { useMemo, useState } from 'react';
import { Badge } from '@fluentui/react-components';
import {
  flattenNodes, type LeafNode, type LoopNode, type StageGroup, type StagesNode, type StepNode,
} from '../../lib/run-tree.ts';
import { stageLabel } from '../../shared/format.ts';
import { stageRollup } from '../../lib/stage-rollup.ts';
import {
  loopProgress, metaLine, spendSummary, stagesProgress, stepDuration, stepStatusColor,
} from './step-facts.ts';
import { defaultExpandedStage, StageRow } from './StageRow.tsx';
import { IterationHistory, StepDetails, StepPill } from './StepPill.tsx';
import { StepTrack } from './StepTrack.tsx';
import type { NodeProps } from './types.ts';

function LeafView({ node, focusKey, awaitingKey, awaiting, clock, nodeRef }: NodeProps & { node: LeafNode }) {
  return (
    <StepPill
      id={node.id}
      nodeKey={node.key}
      ordinal={node.ordinal}
      step={node.latest}
      meta={metaLine(node.latest)}
      duration={stepDuration(node.latest, clock)}
      spend={node.latest.progress ? spendSummary(node.latest.progress) : null}
      runCount={node.executions.length > 1 ? node.executions.length : undefined}
      isFocus={node.key === focusKey}
      awaiting={node.key === awaitingKey ? awaiting : undefined}
      nodeRef={nodeRef}
      extraKeys={node.executions.length > 1 ? node.executions.map(execution => execution.key) : undefined}
    >
      <StepDetails step={node.latest} />
      {node.executions.length > 1 && <IterationHistory node={node} clock={clock} />}
    </StepPill>
  );
}

/**
 * A loop and its body, drawn as one bordered group. The body sits visibly
 * inside the cycle that owns it, and — because repeat executions are folded
 * into their step — the group stays the same size however long the loop runs.
 */
function LoopView({ node, focusKey, awaitingKey, awaiting, clock, nodeRef }: NodeProps & { node: LoopNode }) {
  if (node.loop.status === 'disabled') {
    // The whole subtree is disabled too (disabling a loop takes its whole
    // body with it), so there is nothing to hang body rows on — a count is
    // more informative than phantom rows with no iteration to key them by.
    // The count is every descendant, not just direct children: a loop
    // containing a loop still reads as one number.
    const descendantCount = flattenNodes(node.children).length;
    return (
      <StepPill
        id={node.id}
        nodeKey={node.key}
        ordinal={node.ordinal}
        step={node.loop}
        meta={`loop disabled — ${descendantCount} step${descendantCount === 1 ? '' : 's'} not run`}
        duration={null}
        isFocus={node.key === focusKey}
        awaiting={node.key === awaitingKey ? awaiting : undefined}
        nodeRef={nodeRef}
      >
        <StepDetails step={node.loop} />
      </StepPill>
    );
  }
  return (
    <div
      data-testid={`step-loop-${node.key}`}
      style={{
        border: `1px dashed ${stepStatusColor(node.loop.status)}`,
        borderRadius: 12, padding: 6,
        // A direct child of a track, which scrolls rather than shrinks: the
        // box keeps its width instead of being squeezed to the window's.
        flexShrink: 0,
      }}
    >
      <StepTrack testid={`step-loop-track-${node.key}`}>
        <StepPill
          id={node.id}
          nodeKey={node.key}
          ordinal={node.ordinal}
          step={node.loop}
          meta={metaLine(node.loop)}
          duration={stepDuration(node.loop, clock)}
          // On the pill rather than beside it: where a loop is in its budget is
          // a fact about the loop, and a bare line of text floating next to the
          // pill that owns it is the shape this screen no longer uses.
          iteration={loopProgress(node.loop)}
          isFocus={node.key === focusKey}
          awaiting={node.key === awaitingKey ? awaiting : undefined}
          nodeRef={nodeRef}
        >
          <StepDetails step={node.loop} />
        </StepPill>
        {node.children.map(child => (
          <NodeView
            key={child.key}
            node={child}
            focusKey={focusKey}
            awaitingKey={awaitingKey}
            awaiting={awaiting}
            clock={clock}
            nodeRef={nodeRef}
          />
        ))}
      </StepTrack>
    </div>
  );
}

/** Runs of consecutive groups for the same stage — one per stage file, each holding its attempts. */
function groupsByStage(groups: readonly StageGroup[]): StageGroup[][] {
  const runs: StageGroup[][] = [];
  for (const group of groups) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last[0].stage !== undefined && last[0].stage === group.stage) last.push(group);
    else runs.push([group]);
  }
  return runs;
}

/**
 * A `stages` step and its body, drawn like a loop group — its own pill, then
 * one row per stage file, reading `stage 2 of 7 · Add API routes`. A row is
 * one summary line until opened, so a run of many stages stays a short list;
 * open, it holds that stage's pills in a scrolling track.
 * A stage sent back after a rejection keeps each attempt's pills apart,
 * badged `attempt N`, rather than folding them into one another.
 */
function StagesView({ node, focusKey, awaitingKey, awaiting, clock, nodeRef }: NodeProps & { node: StagesNode }) {
  // Until a row is clicked, what is open is `defaultExpandedStage`'s answer,
  // computed each render, so the open row follows the run as it moves on. The
  // first click latches `touched`: from then on the default contributes
  // nothing and only `overrides` say what is open, so a stage that finishes
  // does not fold and one that starts does not steal the view. Held per mount
  // — RunDetailPage keys the stepper on the run, so visiting a run again follows again.
  const [touched, setTouched] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const rows = useMemo(() => groupsByStage(node.children).map(attempts => {
    const first = attempts[0];
    return {
      attempts,
      stageKey: first.stage === undefined ? first.key : `${node.key}@${first.stage}`,
      label: first.stage === undefined ? 'not started' : stageLabel(first.index, first.total, first.title),
      rollup: stageRollup(attempts, clock),
    };
  }), [node.key, node.children, clock]);
  const focusStageKey = useMemo(() => {
    if (focusKey === undefined) return undefined;
    return rows.find(row => row.attempts.some(
      group => flattenNodes(group.children).some(child => child.key === focusKey),
    ))?.stageKey;
  }, [rows, focusKey]);
  const fallback = touched ? undefined : defaultExpandedStage(rows, focusStageKey);
  const isExpanded = (stageKey: string) => overrides[stageKey] ?? stageKey === fallback;

  const pill = (meta: string, withDuration: boolean) => (
    <StepPill
      id={node.id}
      nodeKey={node.key}
      ordinal={node.ordinal}
      step={node.stages}
      meta={meta}
      duration={withDuration ? stepDuration(node.stages, clock) : null}
      stagesCount={withDuration ? stagesProgress(node.stages) : null}
      isFocus={node.key === focusKey}
      awaiting={node.key === awaitingKey ? awaiting : undefined}
      nodeRef={nodeRef}
    >
      <StepDetails step={node.stages} />
    </StepPill>
  );
  if (node.stages.status === 'disabled') {
    // As for a disabled loop: the body never runs, so a count says more than
    // phantom pills with no stage to hang them on.
    const descendantCount = flattenNodes(node.children.flatMap(group => group.children)).length;
    return pill(`stages disabled — ${descendantCount} step${descendantCount === 1 ? '' : 's'} not run`, false);
  }
  const children = (nodes: StepNode[]) => nodes.map(child => (
    <NodeView
      key={child.key}
      node={child}
      focusKey={focusKey}
      awaitingKey={awaitingKey}
      awaiting={awaiting}
      clock={clock}
      nodeRef={nodeRef}
    />
  ));
  return (
    <div
      data-testid={`step-stages-${node.key}`}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 4,
        border: `1px dashed ${stepStatusColor(node.stages.status)}`,
        borderRadius: 12, padding: 6,
        // As for a loop: a `stages` step inside a loop is a direct child of
        // that loop's track, and must not shrink with the window.
        flexShrink: 0,
      }}
    >
      {/* Wrapped so the column's stretch does not pull the pill out to the full width. */}
      <div style={{ display: 'flex' }}>{pill(metaLine(node.stages), true)}</div>
      {rows.map(({ attempts, stageKey, label, rollup }) => {
        // Badged only once a stage has been attempted more than once: an
        // "attempt 1" on every stage that passed first time is noise.
        const badged = attempts.length > 1 || (attempts[0].attempt ?? 1) > 1;
        const expanded = isExpanded(stageKey);
        return (
          <StageRow
            key={stageKey}
            stageKey={stageKey}
            label={label}
            rollup={rollup}
            expanded={expanded}
            onToggle={() => {
              // Pin every row as it is drawn right now, this one flipped: the
              // latch drops the default, and a row that was open only because
              // of it (the running stage) would otherwise fold under the
              // click. `expanded` was read before the latch closed, so the
              // clicked row flips from what the reader saw.
              setTouched(true);
              setOverrides(Object.fromEntries(
                rows.map(row => [row.stageKey, row.stageKey === stageKey ? !expanded : isExpanded(row.stageKey)]),
              ));
            }}
          >
            {attempts.map(group => badged ? (
              <div
                key={group.key}
                data-testid={`stage-attempt-group-${group.key}`}
                style={{ display: 'flex', alignItems: 'center', gap: 8 }}
              >
                <Badge
                  appearance="tint"
                  color="informative"
                  size="small"
                  data-testid={`stage-attempt-${group.key}`}
                  style={{ flexShrink: 0 }}
                >
                  {group.maxAttempts === undefined
                    ? `attempt ${group.attempt}`
                    : `attempt ${group.attempt} of ${group.maxAttempts}`}
                </Badge>
                <StepTrack testid={`stage-track-${group.key}`}>{children(group.children)}</StepTrack>
              </div>
            ) : (
              <StepTrack key={group.key} testid={`stage-track-${group.key}`}>{children(group.children)}</StepTrack>
            ))}
          </StageRow>
        );
      })}
    </div>
  );
}

export function NodeView(props: NodeProps) {
  switch (props.node.kind) {
    case 'loop': return <LoopView {...props} node={props.node} />;
    case 'stages': return <StagesView {...props} node={props.node} />;
    default: return <LeafView {...props} node={props.node} />;
  }
}
