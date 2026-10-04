import {
  Button, Dropdown, Field, Input, MessageBar, MessageBarBody, Option, Textarea, Tooltip,
} from '@fluentui/react-components';
import {
  ArrowDown20Regular, ArrowUp20Regular, ChevronDown20Regular, ChevronRight20Regular,
  Delete20Regular, FolderArrowRight20Regular, Pause20Regular, Play20Regular,
} from '@fluentui/react-icons';
import type { LoopStep, StagesStep, Step, StepKind } from '../shared/types.ts';
import { isContainerStep, isLoopStep, isStagesStep } from '../shared/steps.ts';
import { StepSummary } from '../components/StepSummary.tsx';
import { StepIdField } from './StepIdField.tsx';
import { convertStep, StepRail } from './StepRail.tsx';
import { useStepLayoutStyles } from './step-layout.ts';
import { nonNegativeOrUndefined, numberOrUndefined } from './number-field.ts';

const KIND_OPTIONS: StepKind[] = ['agent', 'command', 'manual', 'approval', 'loop', 'stages'];

export interface StepCardProps {
  step: Step;
  ordinal: number;
  earlierStepIds: string[];
  idsInTree: ReadonlySet<string>;
  endsLoop: boolean;
  /** Will not run: itself disabled, or inside a disabled container. */
  dimmed: boolean;
  /** Sits in some container's body — a `stages` step cannot go here (schema.ts refuses it inside a loop or another stages step). */
  nested?: boolean;
  /** Sits in a `stages` body, at any depth — `stage` (the current stage file) is readable here. */
  inStages?: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Only meaningful for a container (loop or stages); undefined body-fold props hide the chevron. */
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
  /** A pending, uncommitted Step ID problem on this card — blocks Save until resolved. */
  onIdError?: (error: string | null) => void;
  /** The persistent inline note when this card lost an input to a disabled step. */
  readerNote?: string;
  highlight?: 'source' | 'dependent';
  onReadsClick: (ids: string[]) => void;
  onWritesClick: (id: string) => void;
  /** Save-time problems naming this card, shown only once Save has been tried at least once. */
  problemCount?: number;
  /** Field key -> message, for the fields this card owns — same gating as `problemCount`. */
  fieldErrors?: Record<string, string>;
}

/**
 * One step, one card: prose left, knobs right, collapsed to a single
 * `StepSummary` line by default. The prose takes all the width the rail
 * leaves; the rail wraps beneath it only on a narrow card. No recursion — a
 * loop's body is a sibling list of cards the page renders one level in, not a
 * nested card.
 */
export function StepCard({
  step, ordinal, earlierStepIds, idsInTree, endsLoop, dimmed, nested, inStages, collapsed, onToggleCollapsed,
  bodyFolded, onToggleBodyFolded, isFirst, isLast, onMove, onInsertBelow, guardedByLoopId,
  onToggleEnabled, onRemove, onUpdate, onRename, onIdError, readerNote, highlight, onReadsClick, onWritesClick,
  problemCount, fieldErrors,
}: StepCardProps) {
  const styles = useStepLayoutStyles();
  const isEnabled = step.enabled !== false;
  const guardTooltip = guardedByLoopId ? `'${step.id}' ends loop '${guardedByLoopId}' — it cannot be disabled` : undefined;
  // Offering `stages` inside a container would only invite a save-time error
  // the dropdown can prevent — the same reasoning as Repeat until's options.
  const kindOptions = nested ? KIND_OPTIONS.filter(k => k !== 'stages') : KIND_OPTIONS;

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
            problemCount={problemCount}
          />
        </div>
        {isContainerStep(step) && onToggleBodyFolded && (
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
            <LoopFields step={step} onUpdate={onUpdate} fieldErrors={fieldErrors} />
          ) : isStagesStep(step) ? (
            <StagesFields step={step} onUpdate={onUpdate} fieldErrors={fieldErrors} />
          ) : (
            <div className={styles.body} style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <StepIdField id={step.id} idsInTree={idsInTree} onRename={onRename} onErrorChange={onIdError} />
                  <Field label="Kind">
                    <Dropdown
                      aria-label="Kind"
                      value={step.kind}
                      selectedOptions={[step.kind]}
                      style={{ minWidth: 120 }}
                      onOptionSelect={(_e, data) => data.optionValue && onUpdate(convertStep(step, data.optionValue as StepKind))}
                    >
                      {kindOptions.map(v => <Option key={v} value={v}>{v}</Option>)}
                    </Dropdown>
                  </Field>
                </div>
                {step.kind === 'agent' && (
                  <Field
                    label="Prompt"
                    required
                    validationState={fieldErrors?.prompt ? 'error' : 'none'}
                    validationMessage={fieldErrors?.prompt}
                  >
                    <Textarea value={step.prompt} rows={12} onChange={(_e, data) => patch({ prompt: data.value })} />
                  </Field>
                )}
                {step.kind === 'command' && (
                  <Field
                    label="Command"
                    required
                    hint="Run through /bin/sh -c, in the workspace directory."
                    validationState={fieldErrors?.run ? 'error' : 'none'}
                    validationMessage={fieldErrors?.run}
                  >
                    <Textarea value={step.run} rows={8} onChange={(_e, data) => patch({ run: data.value })} />
                  </Field>
                )}
                {(step.kind === 'manual' || step.kind === 'approval') && (
                  <Field
                    label="Instructions"
                    required
                    hint="Shown to whoever is asked. Supports {{ inputs.* }}."
                    validationState={fieldErrors?.instructions ? 'error' : 'none'}
                    validationMessage={fieldErrors?.instructions}
                  >
                    <Textarea value={step.instructions} rows={12} onChange={(_e, data) => patch({ instructions: data.value })} />
                  </Field>
                )}
              </div>
              <StepRail
                step={step}
                earlierStepIds={earlierStepIds}
                inStages={inStages}
                guardedByLoopId={guardedByLoopId}
                onUpdate={onUpdate}
                fieldErrors={fieldErrors}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A stages card has no prose either: which files make the stages, and how many
 * extra attempts a failing stage gets. No `until` — a stages step ends when
 * its files run out, not on a verdict.
 */
function StagesFields({
  step, onUpdate, fieldErrors,
}: { step: StagesStep; onUpdate: (next: Step) => void; fieldErrors?: Record<string, string> }) {
  function patch(fields: Partial<StagesStep>): void {
    onUpdate({ ...step, ...fields });
  }
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <Field
        label="Stage files"
        required
        hint="A glob relative to the workspace, one stage per file, in path order. Supports {{ inputs.* }}."
        validationState={fieldErrors?.items ? 'error' : 'none'}
        validationMessage={fieldErrors?.items}
        style={{ flex: '1 1 320px' }}
      >
        <Input value={step.items} onChange={(_e, data) => patch({ items: data.value })} />
      </Field>
      <Field
        label="Max retries"
        hint="Extra attempts a failing stage gets. 0 = none; blank = 2."
        validationState={fieldErrors?.max_retries ? 'error' : 'none'}
        validationMessage={fieldErrors?.max_retries}
      >
        <Input
          value={step.max_retries === undefined ? '' : String(step.max_retries)}
          onChange={(_e, data) => patch({ max_retries: nonNegativeOrUndefined(data.value) })}
        />
      </Field>
    </div>
  );
}

/** A loop card has no prose, so its expanded state is a single row of three fields. */
function LoopFields({
  step, onUpdate, fieldErrors,
}: { step: LoopStep; onUpdate: (next: Step) => void; fieldErrors?: Record<string, string> }) {
  function patch(fields: Partial<LoopStep>): void {
    onUpdate({ ...step, ...fields });
  }
  // Only a body step with Verdict on can end the loop — offering the rest
  // just invites a save-time error the dropdown could have prevented. The
  // current value stays selectable even once it no longer qualifies (e.g.
  // Verdict got turned off), so the resulting field error stays visible
  // instead of silently reverting to something the user never picked.
  const verdictOptions = step.steps.filter(s => !isContainerStep(s) && s.verdict);
  const options = step.until && !verdictOptions.some(s => s.id === step.until)
    ? [...verdictOptions, ...step.steps.filter(s => s.id === step.until)]
    : verdictOptions;
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <Field
        label="Repeat until"
        hint="A body step with Verdict on."
        validationState={fieldErrors?.until ? 'error' : 'none'}
        validationMessage={fieldErrors?.until}
      >
        <Dropdown
          value={step.until}
          selectedOptions={step.until ? [step.until] : []}
          onOptionSelect={(_e, data) => data.optionValue && patch({ until: data.optionValue })}
        >
          {options.length > 0
            ? options.map(s => <Option key={s.id} value={s.id}>{s.id}</Option>)
            : <Option value="" disabled>Turn on Verdict on a body step first</Option>}
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
