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
  CircleRegular,
  DismissFilled,
  WarningFilled,
} from '@fluentui/react-icons';
import type { StepState } from '../../state/store.ts';
import { AttentionBadge } from '../AttentionBadge.tsx';
import { GENERATING_ARTIFACT_LABEL, isGeneratingArtifact } from '../../lib/step-phase.ts';
import { STATUS_BADGE_SIZE, STATUS_GLYPH_PX, STATUS_SPINNER_SIZE } from '../../lib/status-style.ts';
import type { LeafNode } from '../../lib/run-tree.ts';
import { metaLine, progressSummary, stepDuration, stepStatusColor } from './step-facts.ts';
import type { StepAwaiting } from './types.ts';

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
export function IterationHistory({ node, clock }: { node: LeafNode; clock: number }) {
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
export function StepPill({
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
            // A track scrolls rather than wraps, so a pill keeps its width
            // instead of being squeezed to fit the row.
            flexShrink: 0,
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
