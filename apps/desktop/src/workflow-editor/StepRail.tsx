import {
  Dropdown, Field, Input, Option, Switch, Text,
} from '@fluentui/react-components';
import type {
  AgentStep, CommandStep, EffortLevel, ManualStep, Step, StepKind, StepMode,
} from '../../../../packages/core/src/types.ts';
import { isAgentStep, isManualStep } from '../../../../packages/core/src/steps.ts';
import { ATTACHMENTS_REF } from '../../../../packages/core/src/attachments.ts';
import { useStepLayoutStyles } from './step-layout.ts';

const STEP_MODE_OPTIONS: StepMode[] = ['interactive', 'headless'];
const EFFORT_OPTIONS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const CAPTURE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'None' },
  { value: 'note', label: 'Note' },
  { value: 'review', label: 'Review' },
];

function numberOrUndefined(raw: string): number | undefined {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export interface StepRailProps {
  step: AgentStep | CommandStep | ManualStep;
  earlierStepIds: string[];
  onUpdate: (next: Step) => void;
}

/**
 * The kind-dependent right rail, in one or two fixed-width columns depending
 * on the card's width: runner, model, mode, effort, writes, verdict, then the
 * wiring — what it reads, what it writes, allowed paths. Everything a step's
 * prose sits beside, none of it stacked beneath a textarea any more. Each
 * field is a direct child, so each is its own cell of the rail's grid.
 */
export function StepRail({ step, earlierStepIds, onUpdate }: StepRailProps) {
  const styles = useStepLayoutStyles();

  function patch(fields: Partial<Step>): void {
    onUpdate({ ...step, ...fields } as Step);
  }

  function setAllowPaths(raw: string): void {
    const paths = raw.split(',').map(p => p.trim()).filter(Boolean);
    patch({ allow_paths: paths.length > 0 ? paths : undefined } as Partial<Step>);
  }

  /**
   * A manual/approval step's capture answers a save-time error rather than
   * arming one: `validateWorkflowSemantics` rejects `capture` without
   * `output`, so picking Note or Review on a step with no output filename
   * fills in a default rather than leaving that as the one operation this
   * screen can silently break.
   */
  function setCapture(value: string): void {
    const capture = value === '' ? undefined : (value as 'note' | 'review');
    const needsOutput = capture !== undefined && !(step as ManualStep).output;
    patch({
      capture,
      ...(needsOutput ? { output: `${step.id}.md` } : {}),
    } as Partial<Step>);
  }

  return (
    <div data-testid={`step-rail-${step.id}`} className={styles.rail}>
      {isAgentStep(step) && (
        <>
          <Field label="Runner">
            <Input value={step.runner} onChange={(_e, data) => patch({ runner: data.value } as Partial<Step>)} />
          </Field>
          <Field label="Model">
            <Input
              value={step.model ?? ''}
              onChange={(_e, data) => patch({ model: data.value || undefined } as Partial<Step>)}
            />
          </Field>
          <Field label="Mode">
            <Dropdown
              value={step.mode}
              selectedOptions={[step.mode]}
              onOptionSelect={(_e, data) => data.optionValue && patch({ mode: data.optionValue as StepMode } as Partial<Step>)}
            >
              {STEP_MODE_OPTIONS.map(v => <Option key={v} value={v}>{v}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Effort">
            <Dropdown
              value={step.effort ?? 'Default'}
              selectedOptions={step.effort ? [step.effort] : []}
              onOptionSelect={(_e, data) =>
                patch({ effort: (data.optionValue || undefined) as EffortLevel | undefined } as Partial<Step>)}
            >
              <Option value="">Default</Option>
              {EFFORT_OPTIONS.map(v => <Option key={v} value={v}>{v}</Option>)}
            </Dropdown>
          </Field>
          <Switch label="Writes" checked={step.writes} onChange={(_e, data) => patch({ writes: data.checked } as Partial<Step>)} />
          <Field label="Allowed paths" hint="Comma-separated.">
            <Input value={(step.allow_paths ?? []).join(', ')} onChange={(_e, data) => setAllowPaths(data.value)} />
          </Field>
        </>
      )}

      {step.kind === 'command' && (
        <>
          <Field label="Working directory" hint="Relative to the workspace. Blank = workspace root.">
            <Input value={step.cwd ?? ''} onChange={(_e, data) => patch({ cwd: data.value || undefined } as Partial<Step>)} />
          </Field>
          <Field label="Successful exit codes" hint="Comma-separated. Blank = 0 only.">
            <Input
              value={(step.expect_exit ?? []).join(', ')}
              onChange={(_e, data) => {
                const codes = data.value.split(',').map(v => Number.parseInt(v.trim(), 10)).filter(Number.isInteger);
                patch({ expect_exit: codes.length > 0 ? codes : undefined } as Partial<Step>);
              }}
            />
          </Field>
          <Field label="Timeout (ms)">
            <Input
              value={step.timeout_ms === undefined ? '' : String(step.timeout_ms)}
              onChange={(_e, data) => patch({ timeout_ms: numberOrUndefined(data.value) } as Partial<Step>)}
            />
          </Field>
        </>
      )}

      {isManualStep(step) && (
        <>
          <Field label="Title">
            <Input value={step.title} onChange={(_e, data) => patch({ title: data.value } as Partial<Step>)} />
          </Field>
          <Field label="Capture" hint="What the human is asked to write.">
            <Dropdown
              value={CAPTURE_OPTIONS.find(o => o.value === (step.capture ?? ''))?.label ?? 'None'}
              selectedOptions={[step.capture ?? '']}
              onOptionSelect={(_e, data) => data.optionValue !== undefined && setCapture(data.optionValue)}
            >
              {CAPTURE_OPTIONS.map(o => <Option key={o.value} value={o.value}>{o.label}</Option>)}
            </Dropdown>
          </Field>
          <Switch
            label="Show the diff"
            checked={step.show_diff ?? false}
            onChange={(_e, data) => patch({ show_diff: data.checked || undefined } as Partial<Step>)}
          />
          <Field label="Default without a human">
            <Dropdown
              value={step.default ?? 'continue'}
              selectedOptions={[step.default ?? 'continue']}
              onOptionSelect={(_e, data) =>
                data.optionValue && patch({ default: data.optionValue as 'continue' | 'abort' } as Partial<Step>)}
            >
              <Option value="continue">continue</Option>
              <Option value="abort">abort</Option>
            </Dropdown>
          </Field>
        </>
      )}

      <Field label="Verdict" hint="This step's result ends a loop, or stands for on_findings.">
        <Switch checked={step.verdict ?? false} onChange={(_e, data) => patch({ verdict: data.checked } as Partial<Step>)} />
      </Field>

      <Field label="Output filename" hint={step.kind === 'agent' ? undefined : 'Optional: leave blank to keep no artifact.'}>
        <Input value={step.output ?? ''} onChange={(_e, data) => patch({ output: data.value || undefined } as Partial<Step>)} />
      </Field>

      <Field label="Reads from">
        <Dropdown
          multiselect
          value={(step.inputs ?? []).join(', ')}
          selectedOptions={step.inputs ?? []}
          onOptionSelect={(_e, data) =>
            patch({ inputs: data.selectedOptions.length > 0 ? data.selectedOptions : undefined } as Partial<Step>)}
        >
          {/* Not a step: the reserved ref for every file attached to the run.
              First, because those exist before step one; offered to every
              kind — a command step's listing is only a declaration, but it
              is the one core counts as reading them. */}
          <Option value={ATTACHMENTS_REF} text={ATTACHMENTS_REF}>
            {ATTACHMENTS_REF}{' '}
            <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>— files attached to the run</Text>
          </Option>
          {earlierStepIds
            .filter(id => id !== ATTACHMENTS_REF)
            .map(id => <Option key={id} value={id}>{id}</Option>)}
        </Dropdown>
      </Field>
    </div>
  );
}

/**
 * Switching kind keeps the identity and wiring a step already has (id, what it
 * reads, what it writes, whether it is disabled) and drops only the fields
 * the new kind has no place for — so a mis-picked kind costs a click, not the
 * whole step. `capture`, `show_diff` and `default` are carried on the
 * manual/approval branch too: flipping between the two (a pure relabel, both
 * `kind: 'manual' | 'approval'` on the very same interface) must not silently
 * arm or disarm a step's capture.
 */
export function convertStep(step: Step, kind: StepKind): Step {
  if (step.kind === kind) return step;
  const isLoop = step.kind === 'loop';
  const carried = {
    id: step.id,
    ...(isLoop ? {} : { inputs: step.inputs, output: step.output, verdict: step.verdict, enabled: step.enabled }),
  };
  switch (kind) {
    case 'agent':
      return {
        kind, runner: 'claude', mode: 'headless', writes: false, prompt: '',
        ...carried, output: (isLoop ? '' : step.output) ?? '',
      } as AgentStep;
    case 'command':
      return { kind, run: '', ...carried } as CommandStep;
    case 'manual':
    case 'approval':
      return {
        kind,
        title: isManualStep(step) ? step.title : step.id,
        instructions: isManualStep(step) ? step.instructions : '',
        ...(isManualStep(step) ? { capture: step.capture, show_diff: step.show_diff, default: step.default } : {}),
        ...carried,
      } as ManualStep;
    case 'loop':
      return {
        kind, id: step.id, until: '', enabled: step.enabled,
        steps: isLoop ? step.steps : [],
      };
  }
}
