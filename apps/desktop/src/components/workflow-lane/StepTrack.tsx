import { Text } from '@fluentui/react-components';
import type { LoopStep, Step } from '../../../../../packages/core/src/types.ts';
import { isLoopStep } from '../../../../../packages/core/src/steps.ts';
import { endsLoop, type DataFlowEntry } from '../../lib/step-describe.ts';
import { StepTile } from './StepTile.tsx';
import { LoopGroup } from './LoopGroup.tsx';

export interface StepTrackProps {
  steps: Step[];
  /** The whole workflow tree — loop rules and ordinals are computed against it, not just this list. */
  workflowSteps: Step[];
  ordinals: Map<string, string>;
  dataFlow: Map<string, DataFlowEntry>;
  /** The loop `steps` is the body of, when it is one — undefined at the top level. */
  enclosingLoop?: LoopStep;
  /** Top level wraps between nodes; a loop body stays on one (scrollable) line. */
  wrap: boolean;
  sourceSet: ReadonlySet<string>;
  dependentSet: ReadonlySet<string>;
  onHoverStep: (id: string | null) => void;
  nestLevel: number;
}

/**
 * A step list, left to right, `→`-connected. Recurses into `LoopGroup` for a
 * nested loop; renders everything else as a `StepTile`. The connector for
 * each node (after the first) travels with it in one flex item, so a wrapped
 * top-level line naturally starts with its own `→` — no JS measuring needed.
 */
export function StepTrack({
  steps, workflowSteps, ordinals, dataFlow, enclosingLoop, wrap, sourceSet, dependentSet, onHoverStep, nestLevel,
}: StepTrackProps) {
  return (
    <div
      data-testid={enclosingLoop ? `step-track-${enclosingLoop.id}` : 'step-track-root'}
      style={{
        display: 'flex',
        flexWrap: wrap ? 'wrap' : 'nowrap',
        alignItems: 'flex-start',
        gap: 8,
        overflowX: wrap ? undefined : 'auto',
        paddingBottom: wrap ? undefined : 4,
      }}
    >
      {steps.map((step, i) => (
        <div
          key={step.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flex: wrap ? '0 1 auto' : 'none',
            minWidth: wrap ? 0 : undefined,
            maxWidth: wrap ? '100%' : undefined,
          }}
        >
          {i > 0 && (
            <Text aria-hidden size={300} style={{ color: 'var(--colorNeutralForeground3)' }}>→</Text>
          )}
          {isLoopStep(step) ? (
            <LoopGroup
              loop={step}
              ordinal={ordinals.get(step.id) ?? ''}
              workflowSteps={workflowSteps}
              ordinals={ordinals}
              dataFlow={dataFlow}
              sourceSet={sourceSet}
              dependentSet={dependentSet}
              onHoverStep={onHoverStep}
              nestLevel={nestLevel}
            />
          ) : (
            <StepTile
              step={step}
              ordinal={ordinals.get(step.id) ?? ''}
              endsLoopMarker={endsLoop(step, enclosingLoop)}
              dataFlowEntry={dataFlow.get(step.id)}
              highlight={sourceSet.has(step.id) ? 'source' : dependentSet.has(step.id) ? 'dependent' : undefined}
              disabled={step.enabled === false}
              onHoverStep={onHoverStep}
            />
          )}
        </div>
      ))}
    </div>
  );
}
