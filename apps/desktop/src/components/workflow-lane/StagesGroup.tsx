import { Text } from '@fluentui/react-components';
import { DocumentMultipleRegular } from '@fluentui/react-icons';
import type { StagesStep, Step } from '../../../../../packages/core/src/types.ts';
import { flattenSteps } from '../../../../../packages/core/src/steps.ts';
import { stagesRule, type DataFlowEntry } from '../../lib/step-describe.ts';
import { StepTrack } from './StepTrack.tsx';

/** Alternating tints so nested groups read as layers rather than indentation — shared with LoopGroup. */
const NEST_BACKGROUND = ['var(--colorNeutralBackground2)', 'var(--colorNeutralBackground3)'];

export interface StagesGroupProps {
  stages: StagesStep;
  ordinal: string;
  workflowSteps: Step[];
  ordinals: Map<string, string>;
  dataFlow: Map<string, DataFlowEntry>;
  sourceSet: ReadonlySet<string>;
  dependentSet: ReadonlySet<string>;
  onHoverStep: (id: string | null) => void;
  nestLevel: number;
}

function stagesLabel(stages: StagesStep): string {
  const rule = stagesRule(stages);
  const retries = rule.maxRetries === undefined
    ? ''
    : ` · up to ${rule.maxRetries} ${rule.maxRetries === 1 ? 'retry' : 'retries'}`;
  return `${stages.id} · ${rule.phrase} · ${rule.items || '—'}${retries}`;
}

/**
 * A stages body as a dashed, tinted box, the counterpart to `LoopGroup`: the
 * label on the top edge says the body runs once per stage file and where
 * those files come from. No "again" line — a stage is not an iteration, the
 * next one starts over on the next file. A disabled stages step collapses to
 * a single summary tile, as a disabled loop does.
 */
export function StagesGroup({
  stages, ordinal, workflowSteps, ordinals, dataFlow, sourceSet, dependentSet, onHoverStep, nestLevel,
}: StagesGroupProps) {
  if (stages.enabled === false) {
    const descendantCount = flattenSteps(stages.steps).length;
    return (
      <div
        data-testid={`stages-disabled-${stages.id}`}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
          border: '1px dashed var(--colorNeutralStroke2)', borderRadius: 8, opacity: 0.55,
        }}
      >
        <Text size={100} style={{ color: 'var(--colorNeutralForeground3)' }}>{ordinal}</Text>
        <Text size={200}>
          {`stages disabled — ${descendantCount} step${descendantCount === 1 ? '' : 's'}`}
        </Text>
      </div>
    );
  }

  return (
    <div
      data-testid={`stages-group-${stages.id}`}
      style={{
        position: 'relative',
        border: '1px dashed var(--colorNeutralStroke2)',
        borderRadius: 10,
        background: NEST_BACKGROUND[nestLevel % NEST_BACKGROUND.length],
        padding: '18px 14px 12px',
        margin: '10px 0 4px',
        maxWidth: '100%',
        minWidth: 0,
        boxSizing: 'border-box',
      }}
    >
      <span
        data-testid={`stages-label-${stages.id}`}
        style={{
          position: 'absolute', top: -11, left: 10,
          background: 'var(--colorNeutralBackground1)', borderRadius: 4, padding: '0 6px',
          display: 'flex', alignItems: 'center', gap: 4,
        }}
      >
        <Text size={100} style={{ color: 'var(--colorNeutralForeground3)' }}>{ordinal}</Text>
        <DocumentMultipleRegular fontSize={14} style={{ color: 'var(--colorNeutralForeground3)' }} />
        <Text size={200} style={{ color: 'var(--colorNeutralForeground2)' }}>
          {stagesLabel(stages)}
        </Text>
      </span>

      <StepTrack
        steps={stages.steps}
        workflowSteps={workflowSteps}
        ordinals={ordinals}
        dataFlow={dataFlow}
        trackId={stages.id}
        wrap={false}
        sourceSet={sourceSet}
        dependentSet={dependentSet}
        onHoverStep={onHoverStep}
        nestLevel={nestLevel + 1}
      />
    </div>
  );
}
