import type { ReactNode } from 'react';
import { Badge, Button, Text } from '@fluentui/react-components';
import type { Step } from '../../../../packages/core/src/types.ts';
import { isAgentStep, isCommandStep, isLoopStep } from '../../../../packages/core/src/steps.ts';
import { ATTACHMENTS_REF } from '../../../../packages/core/src/attachments.ts';

const KIND_COLOR = {
  agent: 'informative', command: 'severe', manual: 'important',
  approval: 'important', loop: 'brand',
} as const;

export interface StepSummaryProps {
  step: Step;
  /** Position label — a number at the top level, '↳' inside a loop body on the workflow list card. */
  ordinal: ReactNode;
  /** This step is named by an enclosing loop's `until:`. */
  endsLoop?: boolean;
  /** This step will not run — dimmed and badged, never both silently. */
  disabled?: boolean;
  /**
   * The workflow list card's own extra facts, which the collapsed editor card
   * does not repeat: `mode`, and the `writes` flag relabelled "edits files" so
   * it cannot be misread as the summary's own `writes:` artifact chip.
   */
  showModeAndWrites?: boolean;
  /** Fires with the ids this step reads from, when its `reads:` chip is clicked. */
  onReadsClick?: (ids: string[]) => void;
  /** Fires with this step's own id, when its `writes:` chip is clicked. */
  onWritesClick?: (id: string) => void;
  /** Lit up because another card's chip named this one as a source or a dependent. */
  highlight?: 'source' | 'dependent';
  /** Save-time problems naming this step, shown only once Save has been tried at least once. */
  problemCount?: number;
}

function readsIds(step: Step): string[] {
  if (isLoopStep(step) || isCommandStep(step)) return [];
  return step.inputs ?? [];
}

const HIGHLIGHT_BACKGROUND: Record<'source' | 'dependent', string> = {
  source: 'var(--colorPaletteBlueBackground2)',
  dependent: 'var(--colorPaletteGreenBackground2)',
};

/**
 * The one line that says what a step is: used both by the editor's collapsed
 * card and by the workflow list card's step outline. `reads:`/`writes:` are
 * chips a click can highlight the neighbours of; a `command` step shows
 * `reads: —` (or `reads: attachments`) with its templated `run:` line as the
 * summary text instead, since `inputs:` is a runtime no-op for one.
 */
export function StepSummary({
  step, ordinal, endsLoop, disabled, showModeAndWrites, onReadsClick, onWritesClick, highlight, problemCount,
}: StepSummaryProps) {
  const writes = isLoopStep(step) ? undefined : step.output;
  const reads = readsIds(step);

  return (
    <div
      data-testid={`step-summary-${step.id}`}
      data-highlight={highlight}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0,
        opacity: disabled ? 0.55 : 1,
        background: highlight ? HIGHLIGHT_BACKGROUND[highlight] : undefined,
        borderRadius: 4,
      }}
    >
      <Text size={200} style={{ minWidth: 18, textAlign: 'right', color: 'var(--colorNeutralForeground3)' }}>
        {ordinal}
      </Text>
      <Text weight="semibold" data-testid="step-summary-step-id">{step.id}</Text>
      <Badge appearance="tint" color={KIND_COLOR[step.kind]} size="small">{step.kind}</Badge>
      {!isLoopStep(step) && step.verdict && <Badge appearance="tint" color="success" size="small">verdict</Badge>}
      {endsLoop && <Badge appearance="tint" color="brand" size="small">ends loop</Badge>}
      {disabled && <Badge appearance="tint" color="subtle" size="small">disabled</Badge>}
      {!!problemCount && (
        <Badge appearance="tint" color="danger" size="small">
          {problemCount} problem{problemCount === 1 ? '' : 's'}
        </Badge>
      )}
      {showModeAndWrites && isAgentStep(step) && (
        <Badge appearance="tint" color={step.mode === 'interactive' ? 'brand' : 'informative'} size="small">
          {step.mode}
        </Badge>
      )}
      {showModeAndWrites && isAgentStep(step) && step.writes && (
        <Badge appearance="tint" color="warning" size="small">edits files</Badge>
      )}

      {isLoopStep(step) ? (
        <Text size={200} style={{ marginLeft: 'auto', color: 'var(--colorNeutralForeground3)' }}>
          until {step.until || '—'}
        </Text>
      ) : isCommandStep(step) ? (
        <>
          {/* `attachments` is the one entry that means something on a
              command step: core counts it as reading the run's files, which
              the step reaches through $WHIPHAND_RUN_DIR/attachments. */}
          <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>
            reads: {step.inputs?.includes(ATTACHMENTS_REF) ? ATTACHMENTS_REF : '—'}
          </Text>
          <Text
            size={200}
            style={{
              marginLeft: 'auto', color: 'var(--colorNeutralForeground3)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '50%',
            }}
          >
            {step.run}
          </Text>
        </>
      ) : (
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center', minWidth: 0 }}>
          <Button
            appearance="transparent"
            size="small"
            data-testid={`reads-chip-${step.id}`}
            disabled={!onReadsClick || reads.length === 0}
            onClick={() => onReadsClick?.(reads)}
            style={{ minWidth: 0, color: 'var(--colorNeutralForeground3)' }}
          >
            reads: {reads.length > 0 ? reads.join(', ') : '—'}
          </Button>
          {writes && (
            <Button
              appearance="transparent"
              size="small"
              data-testid={`writes-chip-${step.id}`}
              disabled={!onWritesClick}
              onClick={() => onWritesClick?.(step.id)}
              style={{ minWidth: 0, color: 'var(--colorNeutralForeground3)' }}
            >
              writes: {writes}
            </Button>
          )}
        </span>
      )}
    </div>
  );
}
