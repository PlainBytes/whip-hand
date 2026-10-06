import { Text } from '@fluentui/react-components';
import { ArrowRepeatAllRegular } from '@fluentui/react-icons';
import type { LoopStep, Step } from '../../shared/types.ts';
import { flattenSteps } from '../../shared/steps.ts';
import { loopRule, type DataFlowEntry } from '../../lib/step-describe.ts';
import { StepTrack } from './StepTrack.tsx';

/** Alternating tints so nested loops read as layers rather than indentation. */
const NEST_BACKGROUND = ['var(--colorNeutralBackground2)', 'var(--colorNeutralBackground3)'];

export interface LoopGroupProps {
  loop: LoopStep;
  ordinal: string;
  /** The whole workflow tree — `until:` can name a step anywhere inside it. */
  workflowSteps: Step[];
  ordinals: Map<string, string>;
  dataFlow: Map<string, DataFlowEntry>;
  sourceSet: ReadonlySet<string>;
  dependentSet: ReadonlySet<string>;
  onHoverStep: (id: string | null) => void;
  nestLevel: number;
}

function loopLabel(loop: LoopStep, workflowSteps: Step[]): string {
  const rule = loopRule(loop, workflowSteps);
  const max = rule.max === undefined ? '' : ` · max ${rule.max}`;
  return `${loop.id} · until ${rule.until} ${rule.verb}${max}`;
}

/**
 * A loop body as a dashed, tinted box: the rule label sits on the top edge,
 * a faint "again" line runs along the bottom back to the first body tile,
 * and a disabled loop collapses to a single summary tile instead of an
 * empty box (its body was never going to run, so there's nothing to lay out).
 */
export function LoopGroup({
  loop, ordinal, workflowSteps, ordinals, dataFlow, sourceSet, dependentSet, onHoverStep, nestLevel,
}: LoopGroupProps) {
  if (loop.enabled === false) {
    const descendantCount = flattenSteps(loop.steps).length;
    return (
      <div
        data-testid={`loop-disabled-${loop.id}`}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
          border: '1px dashed var(--colorNeutralStroke2)', borderRadius: 8, opacity: 0.55,
        }}
      >
        <Text size={100} style={{ color: 'var(--colorNeutralForeground3)' }}>{ordinal}</Text>
        <Text size={200}>
          {`loop disabled — ${descendantCount} step${descendantCount === 1 ? '' : 's'}`}
        </Text>
      </div>
    );
  }

  return (
    <div
      data-testid={`loop-group-${loop.id}`}
      style={{
        position: 'relative',
        border: '1px dashed var(--colorNeutralStroke2)',
        borderRadius: 10,
        background: NEST_BACKGROUND[nestLevel % NEST_BACKGROUND.length],
        padding: '18px 14px 16px',
        margin: '10px 0 4px',
        maxWidth: '100%',
        minWidth: 0,
        boxSizing: 'border-box',
      }}
    >
      <span
        data-testid={`loop-label-${loop.id}`}
        style={{
          position: 'absolute', top: -11, left: 10,
          background: 'var(--colorNeutralBackground1)', borderRadius: 4, padding: '0 6px',
          display: 'flex', alignItems: 'center', gap: 4,
        }}
      >
        <Text size={100} style={{ color: 'var(--colorNeutralForeground3)' }}>{ordinal}</Text>
        <ArrowRepeatAllRegular fontSize={14} style={{ color: 'var(--colorNeutralForeground3)' }} />
        <Text size={200} style={{ color: 'var(--colorNeutralForeground2)' }}>
          {loopLabel(loop, workflowSteps)}
        </Text>
      </span>

      <StepTrack
        steps={loop.steps}
        workflowSteps={workflowSteps}
        ordinals={ordinals}
        dataFlow={dataFlow}
        enclosingLoop={loop}
        wrap={false}
        sourceSet={sourceSet}
        dependentSet={dependentSet}
        onHoverStep={onHoverStep}
        nestLevel={nestLevel + 1}
      />

      {/* The "again" return arrow: a faint line under the body, back to its start. */}
      <div
        aria-hidden
        style={{
          position: 'absolute', left: 14, right: 14, bottom: 4,
          borderTop: '1px dashed var(--colorNeutralStroke2)', opacity: 0.6,
        }}
      />
    </div>
  );
}
