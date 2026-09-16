import { useMemo } from 'react';
import {
  Badge,
  Button,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Spinner,
  Text,
} from '@fluentui/react-components';
import {
  CheckmarkFilled,
  ChevronDownRegular,
  ChevronUpRegular,
  CircleRegular,
  DismissFilled,
  WarningFilled,
} from '@fluentui/react-icons';
import type { StepState } from '../state/store.ts';
import { AttentionBadge } from './AttentionBadge.tsx';
import { GENERATING_ARTIFACT_LABEL, isGeneratingArtifact } from '../lib/step-phase.ts';
import { STATUS_BADGE_SIZE, STATUS_GLYPH_PX, STATUS_SPINNER_SIZE } from '../lib/status-style.ts';
import {
  buildRunTree, flattenNodes, type LeafNode, type LoopNode, type StageGroup, type StagesNode, type StepNode,
} from '../lib/run-tree.ts';
import { elapsedMs, formatElapsed, stageLabel } from '../../../../packages/core/src/format.ts';
import { usageParts } from '../../../../packages/core/src/log-rows.ts';

/**
 * What the stepper needs to know about a session waiting on the human. Comes
 * from the live job; the label is the caller's to pass, and every caller takes
 * it from AWAIT_LABEL in lib/await-copy.ts — the header shows the same wording
 * beside the run, and the two drifted when each owned its own table.
 */
export interface StepAwaiting {
  stepId?: string;
  label: string;
}

export function StepStatusIcon({ status }: { status: StepState['status'] }) {
  switch (status) {
    case 'done':
      return <Badge appearance="filled" shape="circular" color="success" size={STATUS_BADGE_SIZE} icon={<CheckmarkFilled />} />;
    case 'failed':
      return <Badge appearance="filled" shape="circular" color="danger" size={STATUS_BADGE_SIZE} icon={<DismissFilled />} />;
    case 'running':
      return <Spinner size={STATUS_SPINNER_SIZE} />;
    case 'interrupted':
      // Never a spinner: this step is over, it just never got to say how it
      // ended. A spinner here is what made abandoned runs look alive forever.
      return <Badge appearance="filled" shape="circular" color="severe" size={STATUS_BADGE_SIZE} icon={<WarningFilled />} />;
    case 'disabled':
      // No icon at all — a disabled step never ran, which is not the same
      // fact a hollow 'pending' circle tells: pending means "not yet",
      // disabled means "never".
      return null;
    default:
      return <CircleRegular fontSize={STATUS_GLYPH_PX} style={{ color: 'var(--colorNeutralForeground3)' }} />;
  }
}

/**
 * The pill outline per status — the same fill the status badge uses, so the
 * ring and the badge always agree. CSS variables (not the `tokens` object) so
 * both webLightTheme and webDarkTheme work with no extra wiring.
 */
const STEP_STATUS_COLOR: Record<StepState['status'], string> = {
  done: 'var(--colorPaletteGreenBackground3)',
  failed: 'var(--colorPaletteRedBackground3)',
  running: 'var(--colorBrandStroke1)',
  interrupted: 'var(--colorPaletteDarkOrangeBackground3)',
  pending: 'var(--colorNeutralStroke2)',
  disabled: 'var(--colorNeutralStroke2)',
};

export function stepStatusColor(status: StepState['status']): string {
  return STEP_STATUS_COLOR[status] ?? 'var(--colorNeutralStroke2)';
}

/**
 * What a step will use, in the pill itself rather than behind a click. A step
 * that spends no tokens has no runner or model to name, so it says what it is
 * instead — the reader still learns why it has no model.
 */
function metaLine(step: StepState): string {
  switch (step.kind) {
    case 'command':
    case 'manual':
    case 'approval':
    case 'loop':
    case 'stages':
      return step.kind;
    default:
      // 'agent', and undefined for v1 manifests written before kinds existed.
      return [step.runner ?? '—', step.model ?? 'default', step.mode ?? '—'].join(' · ');
  }
}

/**
 * How long this execution has taken: frozen once it ends, still counting
 * against `clock` while it runs, and absent entirely before it starts — a
 * pending step showing '0s' would read as one that ran instantly.
 */
function stepDuration(step: StepState, clock: number): string | null {
  const end = step.endedAt === undefined ? clock : Date.parse(step.endedAt);
  const ms = elapsedMs(step.startedAt, end);
  return ms === null ? null : formatElapsed(ms);
}

/** 'iteration 2 of 3', or 'iteration 2' for a run that recorded no budget. */
function loopProgress(loop: StepState): string | null {
  if (!loop.iterations) return null;
  return loop.maxIterations === undefined
    ? `iteration ${loop.iterations}`
    : `iteration ${loop.iterations} of ${loop.maxIterations}`;
}

/**
 * 'N of M accepted' — progress in stages, on the stages step's own pill.
 * Never 'iteration': a stage is not a lap of a loop. `completed` is only
 * written once the step is done, so the running count is the accepted list.
 */
function stagesProgress(stages: StepState): string | null {
  if (stages.total === undefined) return null;
  const accepted = stages.completed ?? stages.completedStages?.length ?? 0;
  return `${accepted} of ${stages.total} accepted`;
}

/** The pill a node is represented by: its own row for a container, its newest execution for a leaf. */
function nodeStep(node: StepNode): StepState {
  switch (node.kind) {
    case 'loop': return node.loop;
    case 'stages': return node.stages;
    default: return node.latest;
  }
}

/**
 * What this step has cost so far, for the pill's own second line, beside the
 * duration — spend and elapsed are the same kind of fact and read as one
 * cluster. Every part is optional because it depends on what the runner
 * reported — claude gives a dollar cost, copilot gives premium requests — so
 * absent counters are left out rather than shown as zeroes.
 *
 * Deliberately no `lastAction`: what a step is doing right now is the last
 * line of the Terminal tab's feed, and the pill saying it too is exactly the
 * duplication this row was cleaned up to stop.
 */
function spendSummary(progress: NonNullable<StepState['progress']>): string | null {
  const parts = usageParts(progress, usd => `$${usd.toFixed(2)}`);
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * The one-line answer to "is it stuck?", for the popover: what the step is
 * doing on top of what it has spent. The feed only survives while the step is
 * live, so this is where the last action a *finished* step reported stays
 * readable. Elapsed time is not repeated here: the pill already carries it.
 */
function progressSummary(progress: NonNullable<StepState['progress']>): string | null {
  const spend = spendSummary(progress);
  const parts = [
    ...(progress.lastAction === undefined ? [] : [progress.lastAction]),
    ...(spend === null ? [] : [spend]),
  ];
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * Everything known about one execution. The pill shows the headline; this is
 * what a click adds.
 */
export function StepDetails({ step }: { step: StepState }) {
  const summary = step.progress ? progressSummary(step.progress) : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Text>{metaLine(step)}</Text>
      <Text>
        {step.startedAt ?? '—'} {step.endedAt ? `→ ${step.endedAt}` : ''}
      </Text>
      {summary !== null && (
        <Text data-testid="step-progress" italic>{summary}</Text>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {step.exitCode !== undefined && <Text>exit {step.exitCode}</Text>}
        {step.verdict && (
          <Badge color={step.verdict === 'pass' ? 'success' : 'danger'} appearance="filled">
            VERDICT: {step.verdict.toUpperCase()}
          </Badge>
        )}
      </div>
    </div>
  );
}

/**
 * Every iteration of a folded step, oldest first. The pill speaks for the
 * newest one; this is where the history it stands in front of stays reachable.
 */
function IterationHistory({ node, clock }: { node: LeafNode; clock: number }) {
  return (
    <ol
      data-testid={`step-history-${node.key}`}
      style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 2 }}
    >
      {node.executions.map((execution, index) => {
        const duration = stepDuration(execution, clock);
        return (
          <li key={execution.key}>
            <Text size={200}>
              iteration {execution.iteration ?? index + 1} · {execution.status}
              {duration === null ? '' : ` · ${duration}`}
              {execution.verdict ? ` · ${execution.verdict.toUpperCase()}` : ''}
            </Text>
          </li>
        );
      })}
    </ol>
  );
}

interface PillProps {
  id: string;
  /**
   * The node's execution identity — see run-tree.ts's `StepNode.key`. Once
   * loops nest, two rounds can share `id`; every testid, ref lookup and
   * focus/awaiting comparison keys off this instead, so `id` is left free to
   * do nothing but label the pill.
   */
  nodeKey: string;
  ordinal: number;
  step: StepState;
  /** Second line under the id: what the step will use, or what it is. */
  meta: string;
  /** Right of the meta line: how long it has taken. */
  duration: string | null;
  /** Right of the duration: what it has spent, when the runner reported any. */
  spend?: string | null;
  /** How many times this step has run, when that is more than once. */
  runCount?: number;
  /** A loop's place in its budget — 'iteration 2 of 3'. Loops only. */
  iteration?: string | null;
  /** A stages step's accepted count — '2 of 7 accepted'. Stages steps only. */
  stagesCount?: string | null;
  isFocus: boolean;
  /** Set only on the one node — of possibly several sharing `id` — that is actually awaiting. */
  awaiting?: StepAwaiting;
  nodeRef?: (key: string, el: HTMLElement | null) => void;
  /**
   * Additional execution keys that resolve to this same pill — every folded
   * execution's own key, for a LeafNode whose `nodeKey` only names the first
   * one. A caller scrolling to "the currently running execution" (its own
   * key, e.g. `execute#2`) has to find this element the same way a caller
   * scrolling to "the step" (the bare id, via `resolveKey`) does.
   */
  extraKeys?: readonly string[];
  children: React.ReactNode;
}

/**
 * One step, self-describing: ordinal and status on top, what it uses and how
 * long it has taken underneath. Two lines rather than one so a collapsed panel
 * still answers "which tool, which model" without a click.
 */
function StepPill({
  id, nodeKey, ordinal, step, meta, duration, spend, runCount, iteration, stagesCount, isFocus, awaiting, nodeRef,
  extraKeys, children,
}: PillProps) {
  const color = stepStatusColor(step.status);
  const isDisabled = step.status === 'disabled';
  return (
    <Popover>
      <PopoverTrigger disableButtonEnhancement>
        <Button
          appearance="subtle"
          data-testid={`step-card-${nodeKey}`}
          data-current={isFocus ? 'true' : undefined}
          // An aria-label replaces the pill's text outright, so it has to
          // carry everything the two lines say: the status, which is only a
          // colour and a glyph, and the meta line, which is the whole point
          // of the pill describing itself.
          aria-label={[
            `step ${ordinal}`,
            id,
            step.status,
            ...(isGeneratingArtifact(step) ? [GENERATING_ARTIFACT_LABEL] : []),
            ...(runCount === undefined ? [] : [`${runCount} iterations`]),
            ...(iteration ? [iteration] : []),
            ...(stagesCount ? [stagesCount] : []),
            meta,
            ...(duration === null ? [] : [duration]),
            ...(spend ? [spend] : []),
          ].join(', ')}
          ref={(el: HTMLButtonElement | null) => {
            nodeRef?.(nodeKey, el);
            extraKeys?.forEach(key => nodeRef?.(key, el));
          }}
          style={{
            borderRadius: 12,
            // The ring always carries the *status* colour — a focused failed
            // step has to stay red — so focus is marked by weight instead: a
            // thicker ring, bold text, filled back.
            border: `${isFocus ? 2 : 1}px solid ${color}`,
            // Keep the pill the same height whether or not it has the 2px
            // focus ring, so the row doesn't jog as a run advances.
            padding: isFocus ? '4px 9px' : '5px 10px',
            fontWeight: isFocus ? 600 : 400,
            background: isFocus ? 'var(--colorNeutralBackground1Selected)' : undefined,
            // Dimming means "this will not run" and nothing more — every
            // other control stays exactly as live as it always was.
            opacity: isDisabled ? 0.55 : 1,
            display: 'flex',
            minWidth: 0,
          }}
        >
          <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Text
                size={200}
                data-testid={`step-ordinal-${nodeKey}`}
                style={{ color: 'var(--colorNeutralForeground3)' }}
              >
                {ordinal}
              </Text>
              <StepStatusIcon status={step.status} />
              <span>{id}</span>
              {isDisabled && (
                <Badge appearance="tint" color="subtle" size="small" data-testid={`step-disabled-${nodeKey}`}>
                  disabled
                </Badge>
              )}
              {runCount !== undefined && (
                <Badge
                  appearance="tint"
                  color="informative"
                  size="small"
                  data-testid={`step-iterations-${nodeKey}`}
                >
                  ×{runCount}
                </Badge>
              )}
              {iteration && (
                <Badge
                  appearance="tint"
                  color="informative"
                  size="small"
                  data-testid={`loop-progress-${nodeKey}`}
                >
                  {iteration}
                </Badge>
              )}
              {stagesCount && (
                <Badge
                  appearance="tint"
                  color="informative"
                  size="small"
                  data-testid={`stages-progress-${nodeKey}`}
                >
                  {stagesCount}
                </Badge>
              )}
              {isGeneratingArtifact(step) && (
                <Badge
                  appearance="tint"
                  color="informative"
                  size="small"
                  data-testid={`step-phase-${nodeKey}`}
                >
                  {GENERATING_ARTIFACT_LABEL}
                </Badge>
              )}
              {awaiting !== undefined && (
                <AttentionBadge label={awaiting.label} data-testid={`step-awaiting-${nodeKey}`} />
              )}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Text
                size={100}
                data-testid={`step-meta-${nodeKey}`}
                style={{ color: 'var(--colorNeutralForeground3)' }}
              >
                {meta}
              </Text>
              {duration !== null && (
                <Text
                  size={100}
                  data-testid={`step-duration-${nodeKey}`}
                  style={{ color: 'var(--colorNeutralForeground3)' }}
                >
                  {duration}
                </Text>
              )}
              {/* Beside the duration, not behind a click: "how long and how
                  much" is the pair you check on a run you left running. */}
              {spend && (
                <Text
                  size={100}
                  data-testid={`step-spend-${nodeKey}`}
                  style={{ color: 'var(--colorNeutralForeground3)' }}
                >
                  {spend}
                </Text>
              )}
            </span>
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverSurface data-testid={`step-popover-${nodeKey}`}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 200 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <StepStatusIcon status={step.status} />
            <Text weight="semibold">{id}</Text>
            <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>
              {/* "running" alone cannot tell the session apart from the pass
                  that writes the artifact after it — and those look very
                  different to someone wondering whether to keep waiting. */}
              {step.status}
              {isGeneratingArtifact(step) && ` · ${GENERATING_ARTIFACT_LABEL}`}
            </Text>
          </div>
          {children}
        </div>
      </PopoverSurface>
    </Popover>
  );
}

interface NodeProps {
  node: StepNode;
  /** The resolved execution identity a bare `focusStepId` names — see `resolveKey`. */
  focusKey?: string;
  /** The resolved execution identity a bare `awaiting.stepId` names — see `resolveKey`. */
  awaitingKey?: string;
  awaiting?: StepAwaiting;
  clock: number;
  nodeRef?: (key: string, el: HTMLElement | null) => void;
}

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
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        border: `1px dashed ${stepStatusColor(node.loop.status)}`,
        borderRadius: 12, padding: 6,
      }}
    >
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
 * one labelled group per stage file, reading `stage 2 of 7 · Add API routes`.
 * A stage sent back after a rejection keeps each attempt's pills apart,
 * badged `attempt N`, rather than folding them into one another.
 */
function StagesView({ node, focusKey, awaitingKey, awaiting, clock, nodeRef }: NodeProps & { node: StagesNode }) {
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
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        border: `1px dashed ${stepStatusColor(node.stages.status)}`,
        borderRadius: 12, padding: 6,
      }}
    >
      {pill(metaLine(node.stages), true)}
      {groupsByStage(node.children).map(attempts => {
        const first = attempts[0];
        const stageKey = first.stage === undefined ? first.key : `${node.key}@${first.stage}`;
        // Badged only once a stage has been attempted more than once: an
        // "attempt 1" on every stage that passed first time is noise.
        const badged = attempts.length > 1 || (first.attempt ?? 1) > 1;
        return (
          <div
            key={stageKey}
            data-testid={`stage-group-${stageKey}`}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              borderLeft: '2px solid var(--colorNeutralStroke2)', paddingLeft: 8,
            }}
          >
            <Text
              size={200}
              data-testid={`stage-label-${stageKey}`}
              style={{ color: 'var(--colorNeutralForeground2)' }}
            >
              {first.stage === undefined ? 'not started' : stageLabel(first.index, first.total, first.title)}
            </Text>
            {attempts.map(group => badged ? (
              <div
                key={group.key}
                data-testid={`stage-attempt-group-${group.key}`}
                style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
              >
                <Badge appearance="tint" color="informative" size="small" data-testid={`stage-attempt-${group.key}`}>
                  attempt {group.attempt}
                </Badge>
                {children(group.children)}
              </div>
            ) : (
              <div key={group.key} style={{ display: 'contents' }}>{children(group.children)}</div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function NodeView(props: NodeProps) {
  switch (props.node.kind) {
    case 'loop': return <LoopView {...props} node={props.node} />;
    case 'stages': return <StagesView {...props} node={props.node} />;
    default: return <LeafView {...props} node={props.node} />;
  }
}

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
