import { useMemo } from 'react';
import { Button, Text } from '@fluentui/react-components';
import { ChevronDownRegular, ChevronUpRegular } from '@fluentui/react-icons';
import type { StepState } from '../state/store.ts';
import { buildRunTree, flattenNodes, type StageGroup, type StepNode } from '../lib/run-tree.ts';
import { metaLine, nodeStep, stepDuration } from './run-stepper/step-facts.ts';
import { StepDetails, StepPill } from './run-stepper/StepPill.tsx';
import { NodeView } from './run-stepper/NodeView.tsx';
import type { StepAwaiting } from './run-stepper/types.ts';

// The public entry point for this component: callers import these from here,
// wherever they now live.
export { StepDetails, StepStatusIcon } from './run-stepper/StepPill.tsx';
export { stepStatusColor } from './run-stepper/step-facts.ts';
export type { StepAwaiting } from './run-stepper/types.ts';

/**
 * `focusStepId`/`awaiting.stepId` are bare declared ids — the caller only
 * ever tracks one live step, so it has no reason to know about rounds. Once
 * an outer loop reruns an inner one, several nodes in `flat` can share that
 * id; the last one (rounds are appended in the order they ran) is the live
 * one, so its `key` is what focus/ref/awaiting have to resolve to.
 */
function resolveKey(flat: readonly StepNode[], id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  for (let i = flat.length - 1; i >= 0; i--) {
    if (flat[i].id === id) return flat[i].key;
  }
  return undefined;
}

/** Depth-first, like `flattenNodes`, but not into a stages step's body. */
function flattenOutsideStages(nodes: StepNode[]): StepNode[] {
  const out: StepNode[] = [];
  const walk = (list: StepNode[]): void => {
    for (const node of list) {
      out.push(node);
      if (node.kind === 'loop') walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** The stage group holding the node keyed `key`, at any depth inside it; `undefined` outside every stage. */
function stageGroupOf(nodes: StepNode[], key: string | undefined): StageGroup | undefined {
  if (key === undefined) return undefined;
  for (const node of flattenOutsideStages(nodes)) {
    if (node.kind !== 'stages') continue;
    const group = node.children.find(g => g.stage !== undefined && flattenNodes(g.children).some(n => n.key === key));
    if (group !== undefined) return group;
  }
  return undefined;
}

export interface RunStepperProps {
  steps: StepState[];
  /** The step the run is on — marked with a heavier ring. */
  focusStepId?: string;
  awaiting?: StepAwaiting;
  /** Collapsed to the focus step alone — for workflows long enough to crowd out the panel below. */
  collapsed?: boolean;
  /** Renders the collapse chevron when provided; the page owns the state. */
  onToggleCollapse?: () => void;
  /**
   * Lets the page scroll the focus node into view, keyed by execution
   * identity — see run-tree.ts's `StepNode.key`. Called once per key a pill
   * answers to: its node key, plus (for a folded leaf) every execution's own
   * key, so a caller holding the *running* execution's key finds the same
   * element as one holding the node's key.
   */
  nodeRef?: (key: string, el: HTMLElement | null) => void;
  /**
   * The clock live durations are measured against. The page owns the single
   * interval that advances it, so the row does not carry one timer per pill —
   * and a test can pin it.
   */
  now?: number;
}

/**
 * The run at a glance: one pill per step, in workflow order, colour- and
 * icon-coded by status, each naming what it will use and how long it has
 * taken. Loops nest their body rather than trailing it, and a step that runs
 * many times keeps one pill and counts up — so the row's length is set by the
 * workflow, not by how long a cycle churns.
 */
export function RunStepper({
  steps, focusStepId, awaiting, collapsed, onToggleCollapse, nodeRef, now,
}: RunStepperProps) {
  const tree = useMemo(() => buildRunTree(steps), [steps]);
  const flat = useMemo(() => flattenNodes(tree), [tree]);
  const clock = now ?? Date.now();
  // Resolved once here rather than per-pill: several nodes can share a bare
  // id once loops nest, and only the latest round is the one actually in
  // focus or awaiting — see resolveKey.
  const focusKey = useMemo(() => resolveKey(flat, focusStepId), [flat, focusStepId]);
  const awaitingKey = useMemo(() => resolveKey(flat, awaiting?.stepId), [flat, awaiting?.stepId]);
  const focusIndex = flat.findIndex(node => node.key === focusKey);

  // The "N of M" progress count is a position over a total, not a count of
  // completed steps — so it excludes disabled nodes from both halves, the
  // same way a disabled loop excludes its own descendants (they are never
  // separate nodes to begin with once the loop itself is disabled). Without
  // this the bar would stall on a step that will never start.
  //
  // A stages step's body counts as nothing here: it repeats once per stage,
  // so counting its pills would grow the total as stages pass. Focus inside a
  // stage is counted in stages instead — see `focusStage`.
  const isDisabledNode = (node: StepNode): boolean => nodeStep(node).status === 'disabled';
  const countedFlat = useMemo(
    () => flattenOutsideStages(tree).filter(node => !isDisabledNode(node)), [tree],
  );
  const countedIndex = countedFlat.findIndex(node => node.key === focusKey);
  const focusStage = useMemo(() => stageGroupOf(tree, focusKey), [tree, focusKey]);

  // Collapsed shows the step the run is actually on, on its own — a loop body
  // step included, without the group around it. With no focus step (an empty
  // run) there is nothing to show and nothing to collapse.
  const collapsedToFocus = collapsed && focusIndex !== -1;
  const visible = collapsedToFocus ? [flat[focusIndex]] : tree;

  return (
    <div
      data-testid="run-stepper"
      style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}
    >
      {/*
        The stepper owns this strip, so it is the stepper's job to say when it
        has nothing in it. A quiet annotation rather than a centred
        EmptyState: this is a thin fixed-height row, not a pane.
      */}
      {steps.length === 0 && (
        <Text
          size={200}
          data-testid="stepper-empty"
          style={{ color: 'var(--colorNeutralForeground3)' }}
        >
          No steps yet.
        </Text>
      )}
      {visible.map((node, position) => (
        // Fragment, not a wrapper element: the connector has to be a direct
        // flex child of the row or it can't wrap with the pills.
        <div key={node.key} style={{ display: 'contents' }}>
          {position > 0 && (
            // Grows to fill the row rather than sitting at a fixed width: on a
            // row that wraps early there is no trailing connector to leave
            // dangling past the last pill, and every row still reads as one
            // continuous track.
            <div
              aria-hidden
              style={{ flex: '1 1 12px', minWidth: 12, height: 1, background: 'var(--colorNeutralStroke2)' }}
            />
          )}
          {collapsedToFocus && node.kind !== 'step' ? (
            // Collapsed means one pill, so a container shows itself and not its body.
            <StepPill
              id={node.id}
              nodeKey={node.key}
              ordinal={node.ordinal}
              step={nodeStep(node)}
              meta={metaLine(nodeStep(node))}
              duration={stepDuration(nodeStep(node), clock)}
              isFocus
              awaiting={node.key === awaitingKey ? awaiting : undefined}
              nodeRef={nodeRef}
            >
              <StepDetails step={nodeStep(node)} />
            </StepPill>
          ) : (
            <NodeView
              node={node}
              focusKey={focusKey}
              awaitingKey={awaitingKey}
              awaiting={awaiting}
              clock={clock}
              nodeRef={nodeRef}
            />
          )}
        </div>
      ))}
      {collapsedToFocus && (
        <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>
          {focusStage === undefined
            ? `${countedIndex + 1} of ${countedFlat.length}`
            : `stage ${focusStage.index} of ${focusStage.total}`}
        </Text>
      )}
      {onToggleCollapse && (
        <Button
          appearance="subtle"
          size="small"
          data-testid="stepper-collapse-toggle"
          aria-label={collapsed ? 'Show all steps' : 'Collapse to the current step'}
          title={collapsed ? 'Show all steps' : 'Collapse to the current step'}
          icon={collapsed ? <ChevronDownRegular /> : <ChevronUpRegular />}
          onClick={onToggleCollapse}
          style={{ marginLeft: 'auto' }}
        />
      )}
    </div>
  );
}
