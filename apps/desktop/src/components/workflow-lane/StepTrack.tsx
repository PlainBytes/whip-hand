import { Text } from '@fluentui/react-components';
import type { LoopStep, Step } from '../../shared/types.ts';
import { isLoopStep, isStagesStep } from '../../shared/steps.ts';
import { endsLoop, type DataFlowEntry } from '../../lib/step-describe.ts';
import { StepTile } from './StepTile.tsx';
import { LoopGroup } from './LoopGroup.tsx';
import { StagesGroup } from './StagesGroup.tsx';
import { useNarrowLayout } from '../../lib/use-narrow-layout.ts';

export interface StepTrackProps {
  steps: Step[];
  /** The whole workflow tree — loop rules and ordinals are computed against it, not just this list. */
  workflowSteps: Step[];
  ordinals: Map<string, string>;
  dataFlow: Map<string, DataFlowEntry>;
  /** The loop `steps` is the body of, when it is one — undefined at the top level. */
  enclosingLoop?: LoopStep;
  /** The container `steps` is the body of, for the test id — defaults to `enclosingLoop`'s id. */
  trackId?: string;
  /** Top level wraps between nodes; a loop body stays on one (scrollable) line. */
  wrap: boolean;
  sourceSet: ReadonlySet<string>;
  dependentSet: ReadonlySet<string>;
  onHoverStep: (id: string | null) => void;
  nestLevel: number;
}

/**
 * A step list, left to right, `→`-connected. Recurses into `LoopGroup` for a
 * nested loop and `StagesGroup` for a stages step; renders everything else as
 * a `StepTile`. The connector for each node (after the first) travels with it
 * in one flex item, so a wrapped top-level line naturally starts with its own
 * `→` — no JS measuring needed.
 */
export function StepTrack({
  steps, workflowSteps, ordinals, dataFlow, enclosingLoop, trackId, wrap, sourceSet, dependentSet, onHoverStep, nestLevel,
}: StepTrackProps) {
  // On a phone the top-level line scrolls inside its own box instead of
  // wrapping, one snap point per node; it never widens the page.
  const narrow = useNarrowLayout();
  const scrollLine = narrow && wrap;
  const wrapLine = wrap && !narrow;
  return (
    <div
      data-testid={(trackId ?? enclosingLoop?.id) ? `step-track-${trackId ?? enclosingLoop?.id}` : 'step-track-root'}
      style={{
        display: 'flex',
        flexWrap: wrapLine ? 'wrap' : 'nowrap',
        alignItems: 'flex-start',
        gap: 8,
        overflowX: wrapLine ? undefined : 'auto',
        paddingBottom: wrapLine ? undefined : 4,
        ...(scrollLine
          ? { minWidth: 0, maxWidth: '100%', scrollSnapType: 'x proximity', overscrollBehaviorX: 'contain' }
          : {}),
      }}
    >
      {steps.map((step, i) => (
        <div
          key={step.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flex: wrapLine ? '0 1 auto' : 'none',
            minWidth: wrapLine ? 0 : undefined,
            maxWidth: wrapLine ? '100%' : undefined,
            scrollSnapAlign: scrollLine ? 'start' : undefined,
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
          ) : isStagesStep(step) ? (
            <StagesGroup
              stages={step}
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
