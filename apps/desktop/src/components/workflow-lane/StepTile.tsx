import type { ReactNode } from 'react';
import {
  Badge, Button, Popover, PopoverSurface, PopoverTrigger, Text,
} from '@fluentui/react-components';
import {
  BotRegular, ChatRegular, CodeRegular, Diamond12Filled, Edit12Regular, PersonQuestionMarkRegular,
} from '@fluentui/react-icons';
import type { LeafStep } from '../../lib/step-describe.ts';
import { actorOf, purposeOf, type Actor, type DataFlowEntry } from '../../lib/step-describe.ts';
import { isAgentStep, isManualStep } from '../../../../../packages/core/src/steps.ts';

const ACTOR_ICON: Record<Actor, ReactNode> = {
  chat: <ChatRegular />,
  auto: <BotRegular />,
  decide: <PersonQuestionMarkRegular />,
  shell: <CodeRegular />,
};

const ACTOR_LABEL: Record<Actor, string> = {
  chat: 'Chat', auto: 'Auto', decide: 'Decide', shell: 'Shell',
};

/** Left-edge/icon colour per actor — see the plan's "Step tile" section. */
const ACTOR_COLOR: Record<Actor, string> = {
  chat: 'var(--colorBrandForeground1)',
  auto: 'var(--colorPaletteBlueForeground2)',
  decide: 'var(--colorPaletteMarigoldForeground2)',
  shell: 'var(--colorNeutralForeground3)',
};

const HIGHLIGHT_BACKGROUND: Record<'source' | 'dependent', string> = {
  source: 'var(--colorPaletteBlueBackground2)',
  dependent: 'var(--colorPaletteGreenBackground2)',
};

function readsList(entry: DataFlowEntry | undefined): string {
  if (!entry || entry.sources.length === 0) return '—';
  return entry.sources
    .map(id => (entry.previousIteration.includes(id) ? `${id} (previous iteration)` : id))
    .join(', ');
}

/** The popover body: everything a click adds on top of what the tile itself already shows. */
function StepPopoverContent({ step, dataFlowEntry }: { step: LeafStep; dataFlowEntry?: DataFlowEntry }) {
  const rows: Array<{ label: string; value: string }> = [];
  if (isAgentStep(step)) {
    rows.push({ label: 'Prompt', value: step.prompt });
    rows.push({ label: 'Runner', value: step.runner });
    if (step.model) rows.push({ label: 'Model', value: step.model });
    rows.push({ label: 'Mode', value: step.mode });
    if (step.effort) rows.push({ label: 'Effort', value: step.effort });
    if (step.allow_paths?.length) rows.push({ label: 'Allowed paths', value: step.allow_paths.join(', ') });
    rows.push({ label: 'Edits files', value: step.writes ? 'yes' : 'no' });
    if (step.allow_commits) rows.push({ label: 'Commits', value: 'allowed' });
  } else if (isManualStep(step)) {
    rows.push({ label: 'Instructions', value: step.instructions });
    if (step.capture) rows.push({ label: 'Capture', value: step.capture });
    if (step.show_diff) rows.push({ label: 'Shows diff', value: 'yes' });
  } else {
    rows.push({ label: 'Command', value: step.run });
  }
  rows.push({ label: 'Reads', value: readsList(dataFlowEntry) });
  if (step.output) rows.push({ label: 'Writes', value: step.output });
  if (step.verdict) rows.push({ label: 'Verdict', value: 'yes' });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 240, maxWidth: 360 }}>
      <Text weight="semibold">{step.id}</Text>
      {rows.map(row => (
        <div key={row.label}>
          <Text size={200} weight="semibold" style={{ color: 'var(--colorNeutralForeground3)' }}>{row.label}</Text>
          <Text
            as="p"
            style={row.label === 'Command' ? { fontFamily: 'monospace', margin: 0, whiteSpace: 'pre-wrap' } : { margin: 0, whiteSpace: 'pre-wrap' }}
          >
            {row.value}
          </Text>
        </div>
      ))}
    </div>
  );
}

export interface StepTileProps {
  step: LeafStep;
  ordinal: string;
  /** This tile is the `until:` target of the loop it sits in. */
  endsLoopMarker: boolean;
  dataFlowEntry?: DataFlowEntry;
  highlight?: 'source' | 'dependent';
  disabled: boolean;
  onHoverStep: (id: string | null) => void;
}

/**
 * One step, as a fixed-width tile: an actor band, the id, what it does, and
 * where its output goes. Command tiles are a compact variant with no model
 * line. A click opens a popover with everything the tile itself has no room
 * for; hover/focus tints the tiles this one reads from and the tiles that
 * read from it (StepTrack passes `highlight` down once it knows who's hovered).
 */
export function StepTile({
  step, ordinal, endsLoopMarker, dataFlowEntry, highlight, disabled, onHoverStep,
}: StepTileProps) {
  const actor = actorOf(step);
  const color = ACTOR_COLOR[actor];
  const purpose = purposeOf(step);
  const model = isAgentStep(step) ? step.model : undefined;
  const writesFiles = isAgentStep(step) && step.writes;
  const isShell = actor === 'shell';
  const width = isShell && !step.output ? 140 : 180;

  const ariaLabel = [
    `step ${ordinal}`, step.id, ACTOR_LABEL[actor],
    ...(model ? [model] : []),
    purpose,
    ...(step.output ? [`writes ${step.output}`] : []),
    ...(disabled ? ['disabled'] : []),
  ].join(', ');

  return (
    <Popover>
      <PopoverTrigger disableButtonEnhancement>
        <Button
          appearance="subtle"
          data-testid={`step-tile-${step.id}`}
          data-highlight={highlight}
          aria-label={ariaLabel}
          title={`${step.id}: ${purpose}`}
          onMouseEnter={() => onHoverStep(step.id)}
          onMouseLeave={() => onHoverStep(null)}
          onFocus={() => onHoverStep(step.id)}
          onBlur={() => onHoverStep(null)}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'stretch',
            width,
            minWidth: width,
            padding: 0,
            gap: 0,
            opacity: disabled ? 0.55 : 1,
            background: highlight ? HIGHLIGHT_BACKGROUND[highlight] : undefined,
            borderRadius: 8,
            overflow: 'hidden',
          }}
        >
          <span
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              borderLeft: `3px solid ${color}`, color, padding: '3px 6px',
              background: 'var(--colorNeutralBackground2)',
            }}
          >
            <Text size={100} data-testid={`step-ordinal-${step.id}`} style={{ color: 'var(--colorNeutralForeground3)' }}>
              {ordinal}
            </Text>
            {ACTOR_ICON[actor]}
            <Text size={100} weight="semibold" style={{ color }}>{ACTOR_LABEL[actor]}</Text>
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 3 }}>
              {writesFiles && <Edit12Regular data-testid={`step-writes-${step.id}`} style={{ color: 'var(--colorPaletteMarigoldForeground1)' }} />}
              {endsLoopMarker && <Diamond12Filled data-testid={`step-ends-loop-${step.id}`} style={{ color: 'var(--colorBrandForeground1)' }} />}
            </span>
          </span>
          <span style={{ padding: '4px 6px 0', textAlign: 'left' }}>
            <Text weight="semibold" truncate wrap={false} style={{ display: 'block' }}>{step.id}</Text>
          </span>
          <span style={{ padding: '2px 6px 4px', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {model && (
              <Text size={100} style={{ color: 'var(--colorNeutralForeground3)' }}>{model}</Text>
            )}
            <Text
              size={200}
              style={{
                whiteSpace: 'normal', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                overflow: 'hidden', ...(isShell ? { fontFamily: 'monospace' } : {}),
              }}
            >
              {purpose}
            </Text>
          </span>
          {step.output && (
            <span style={{ padding: '0 6px 4px', textAlign: 'left' }}>
              <Text size={100} truncate wrap={false} style={{ color: 'var(--colorNeutralForeground3)', display: 'block' }}>
                {`→ ${step.output}`}
              </Text>
            </span>
          )}
          {disabled && (
            <span style={{ padding: '0 6px 4px', textAlign: 'left' }}>
              <Badge appearance="tint" color="subtle" size="small">disabled</Badge>
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverSurface data-testid={`step-tile-popover-${step.id}`}>
        <StepPopoverContent step={step} dataFlowEntry={dataFlowEntry} />
      </PopoverSurface>
    </Popover>
  );
}
