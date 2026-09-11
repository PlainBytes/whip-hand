import {
  Button, Dropdown, Field, Input, MessageBar, MessageBarBody, Option, Textarea, Tooltip,
} from '@fluentui/react-components';
import {
  ArrowDown20Regular, ArrowUp20Regular, ChevronDown20Regular, ChevronRight20Regular,
  Delete20Regular, FolderArrowRight20Regular, Pause20Regular, Play20Regular,
} from '@fluentui/react-icons';
import type { LoopStep, Step, StepKind } from '../../../../packages/core/src/types.ts';
import { isLoopStep } from '../../../../packages/core/src/steps.ts';
import { StepSummary } from '../components/StepSummary.tsx';
import { StepIdField } from './StepIdField.tsx';
import { convertStep, StepRail } from './StepRail.tsx';
import { useStepLayoutStyles } from './step-layout.ts';

const KIND_OPTIONS: StepKind[] = ['agent', 'command', 'manual', 'approval', 'loop'];

function numberOrUndefined(raw: string): number | undefined {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export interface StepCardProps {
  step: Step;
  ordinal: number;
  earlierStepIds: string[];
  idsInTree: ReadonlySet<string>;
  endsLoop: boolean;
  /** Will not run: itself disabled, or inside a disabled loop. */
  dimmed: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Only meaningful for a loop; undefined body-fold props hide the chevron. */
  bodyFolded?: boolean;
  onToggleBodyFolded?: () => void;
  isFirst: boolean;
  isLast: boolean;
  onMove: (dir: -1 | 1) => void;
  onInsertBelow: () => void;
  /** Set when this step is a loop's `until:` target — disable and remove both refuse, naming the loop. */
  guardedByLoopId?: string;
  onToggleEnabled: () => void;
  onRemove: () => void;
  onUpdate: (next: Step) => void;
  onRename: (nextId: string) => void;
  /** The persistent inline note when this card lost an input to a disabled step. */
  readerNote?: string;
  highlight?: 'source' | 'dependent';
  onReadsClick: (ids: string[]) => void;
  onWritesClick: (id: string) => void;
}

/**
 * One step, one card: prose left, knobs right, collapsed to a single
 * `StepSummary` line by default. The prose takes all the width the rail
 * leaves; the rail wraps beneath it only on a narrow card. No recursion — a
 * loop's body is a sibling list of cards the page renders one level in, not a
 * nested card.
 */
export function StepCard({
  step, ordinal, earlierStepIds, idsInTree, endsLoop, dimmed, collapsed, onToggleCollapsed,
  bodyFolded, onToggleBodyFolded, isFirst, isLast, onMove, onInsertBelow, guardedByLoopId,
  onToggleEnabled, onRemove, onUpdate, onRename, readerNote, highlight, onReadsClick, onWritesClick,
}: StepCardProps) {
  const styles = useStepLayoutStyles();
  const isEnabled = step.enabled !== false;
  const guardTooltip = guardedByLoopId ? `'${step.id}' ends loop '${guardedByLoopId}' — it cannot be disabled` : undefined;

  function patch(fields: Partial<Step>): void {
    onUpdate({ ...step, ...fields } as Step);
  }

  return (
    <div
      data-testid={`step-card-${step.id}`}
      style={{
        border: '1px solid var(--colorNeutralStroke2)', borderRadius: 4,
        background: dimmed ? 'var(--colorNeutralBackground2)' : 'var(--colorNeutralBackground1)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', flexWrap: 'wrap' }}>
        <Button
          appearance="subtle"
          size="small"
          data-testid={`step-collapse-${step.id}`}
          aria-label={collapsed ? `Expand ${step.id}` : `Collapse ${step.id}`}
          icon={collapsed ? <ChevronRight20Regular /> : <ChevronDown20Regular />}
          onClick={onToggleCollapsed}
        />
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <StepSummary
            step={step}
            ordinal={ordinal}
            endsLoop={endsLoop}
            disabled={dimmed}
            highlight={highlight}
            onReadsClick={onReadsClick}
            onWritesClick={onWritesClick}
          />
        </div>
        {isLoopStep(step) && onToggleBodyFolded && (
          <Button
            appearance="subtle"
            size="small"
            data-testid={`body-fold-${step.id}`}
            aria-label={bodyFolded ? `Show ${step.id}'s body` : `Hide ${step.id}'s body`}
            title={bodyFolded ? `Show ${step.id}'s body` : `Hide ${step.id}'s body`}
            icon={bodyFolded ? <ChevronRight20Regular /> : <ChevronDown20Regular />}
            onClick={onToggleBodyFolded}
          />
        )}
        <div style={{ display: 'flex', gap: 4 }}>
          <Button appearance="subtle" size="small" icon={<ArrowUp20Regular />} aria-label="Move up"
            disabled={isFirst} onClick={() => onMove(-1)} />
          <Button appearance="subtle" size="small" icon={<ArrowDown20Regular />} aria-label="Move down"
            disabled={isLast} onClick={() => onMove(1)} />
          <Button appearance="subtle" size="small" icon={<FolderArrowRight20Regular />} aria-label="Insert step below"
            onClick={onInsertBelow} />
          <Tooltip content={guardTooltip ?? (isEnabled ? 'Disable' : 'Enable')} relationship="label">
            <Button
              appearance="subtle"
              size="small"
              icon={isEnabled ? <Pause20Regular /> : <Play20Regular />}
              aria-label={isEnabled ? 'Disable' : 'Enable'}
              disabled={guardedByLoopId !== undefined}
              onClick={onToggleEnabled}
            />
          </Tooltip>
          <Tooltip content={guardTooltip ?? 'Remove step'} relationship="label">
            <Button
              appearance="subtle"
              size="small"
              icon={<Delete20Regular />}
              aria-label="Remove step"
              disabled={guardedByLoopId !== undefined}
              onClick={onRemove}
            />
          </Tooltip>
        </div>
      </div>

      {readerNote && (
        <div style={{ padding: '0 10px 8px' }}>
          <MessageBar intent="warning"><MessageBarBody>{readerNote}</MessageBarBody></MessageBar>
        </div>
      )}

      {!collapsed && (
        <div style={{ borderTop: '1px solid var(--colorNeutralStroke2)', padding: 12 }}>
          {isLoopStep(step) ? (
            <LoopFields step={step} onUpdate={onUpdate} />
          ) : (
            <div className={styles.body} style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <StepIdField id={step.id} idsInTree={idsInTree} onRename={onRename} />
                  <Field label="Kind">
                    <Dropdown
                      aria-label="Kind"
                      value={step.kind}
                      selectedOptions={[step.kind]}
                      style={{ minWidth: 120 }}
                      onOptionSelect={(_e, data) => data.optionValue && onUpdate(convertStep(step, data.optionValue as StepKind))}
                    >
                      {KIND_OPTIONS.map(v => <Option key={v} value={v}>{v}</Option>)}
                    </Dropdown>
                  </Field>
                </div>
                {step.kind === 'agent' && (
                  <Field label="Prompt">
                    <Textarea value={step.prompt} rows={12} onChange={(_e, data) => patch({ prompt: data.value })} />
                  </Field>
                )}
                {step.kind === 'command' && (
                  <Field label="Command" hint="Run through /bin/sh -c, in the workspace directory.">
                    <Textarea value={step.run} rows={8} onChange={(_e, data) => patch({ run: data.value })} />
                  </Field>
                )}
                {(step.kind === 'manual' || step.kind === 'approval') && (
                  <Field label="Instructions" hint="Shown to whoever is asked. Supports {{ inputs.* }}.">
                    <Textarea value={step.instructions} rows={12} onChange={(_e, data) => patch({ instructions: data.value })} />
                  </Field>
                )}
              </div>
              <StepRail step={step} earlierStepIds={earlierStepIds} onUpdate={onUpdate} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A loop card has no prose, so its expanded state is a single row of three fields. */
function LoopFields({ step, onUpdate }: { step: LoopStep; onUpdate: (next: Step) => void }) {
  function patch(fields: Partial<LoopStep>): void {
    onUpdate({ ...step, ...fields });
  }
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <Field label="Repeat until" hint="A body step with Verdict on.">
        <Dropdown
          value={step.until}
          selectedOptions={step.until ? [step.until] : []}
          onOptionSelect={(_e, data) => data.optionValue && patch({ until: data.optionValue })}
        >
          {step.steps.filter(s => !isLoopStep(s)).map(s => <Option key={s.id} value={s.id}>{s.id}</Option>)}
        </Dropdown>
      </Field>
      <Field label="Max iterations" hint="Blank = the workspace default.">
        <Input
          value={step.max_iterations === undefined ? '' : String(step.max_iterations)}
          onChange={(_e, data) => patch({ max_iterations: numberOrUndefined(data.value) })}
        />
      </Field>
      <Field label="When exhausted">
        <Dropdown
          value={step.on_exhausted ?? 'Workspace default'}
          selectedOptions={step.on_exhausted ? [step.on_exhausted] : []}
          onOptionSelect={(_e, data) => patch({ on_exhausted: (data.optionValue || undefined) as LoopStep['on_exhausted'] })}
        >
          <Option value="">Workspace default</Option>
          <Option value="report">report</Option>
          <Option value="interactive">interactive</Option>
        </Dropdown>
      </Field>
    </div>
  );
}
