import { useEffect, useRef, useState } from 'react';
import {
  Dropdown, Field, Input, Option, Switch, Text, Tooltip,
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
  /** Set when this step is a loop's `until:` target — Verdict is locked on, naming the loop. */
  guardedByLoopId?: string;
  onUpdate: (next: Step) => void;
  /** Field key -> message, from a failed Save — same gating as the card's problem badge. */
  fieldErrors?: Record<string, string>;
}

/**
 * The kind-dependent right rail, in one or two fixed-width columns depending
 * on the card's width: runner, model, mode, effort, writes, verdict, then the
 * wiring — what it reads, what it writes, allowed paths. Everything a step's
 * prose sits beside, none of it stacked beneath a textarea any more. Each
 * field is a direct child, so each is its own cell of the rail's grid.
 */
export function StepRail({ step, earlierStepIds, guardedByLoopId, onUpdate, fieldErrors }: StepRailProps) {
  const styles = useStepLayoutStyles();
  const guardTooltip = guardedByLoopId
    ? `'${step.id}' ends loop '${guardedByLoopId}' — it must keep Verdict on`
    : undefined;

  function patch(fields: Partial<Step>): void {
    onUpdate({ ...step, ...fields } as Step);
  }

  // Allowed paths and Successful exit codes are both re-derived from the
  // parsed array on the original render, which drops the comma or the
  // spaces the user just typed on every keystroke. A local text mirror keeps
  // what was typed; it is only overwritten by the step's own value when that
  // value changed from something other than this field's own last edit —
  // the same "external change" test StepIdField's useEffect makes for id.
  const allowPaths = (step as AgentStep).allow_paths;
  const [allowPathsText, setAllowPathsText] = useState(() => (allowPaths ?? []).join(', '));
  const lastAllowPaths = useRef(allowPaths);
  useEffect(() => {
    if (allowPaths !== lastAllowPaths.current) {
      setAllowPathsText((allowPaths ?? []).join(', '));
      lastAllowPaths.current = allowPaths;
    }
  }, [allowPaths]);
  function setAllowPaths(raw: string): void {
    setAllowPathsText(raw);
    const paths = raw.split(',').map(p => p.trim()).filter(Boolean);
    const next = paths.length > 0 ? paths : undefined;
    lastAllowPaths.current = next;
    patch({ allow_paths: next } as Partial<Step>);
  }

  const expectExit = (step as CommandStep).expect_exit;
  const [expectExitText, setExpectExitText] = useState(() => (expectExit ?? []).join(', '));
  const [expectExitError, setExpectExitError] = useState<string | null>(null);
  const lastExpectExit = useRef(expectExit);
  useEffect(() => {
    if (expectExit !== lastExpectExit.current) {
      setExpectExitText((expectExit ?? []).join(', '));
      lastExpectExit.current = expectExit;
    }
  }, [expectExit]);
  function setExpectExit(raw: string): void {
    setExpectExitText(raw);
    const tokens = raw.split(',').map(v => v.trim()).filter(Boolean);
    const bad = tokens.some(t => !/^-?\d+$/.test(t));
    setExpectExitError(bad ? "must be whole numbers, comma-separated" : null);
    if (bad) return; // the field shows the error; the step keeps its last good value
    const codes = tokens.map(t => Number.parseInt(t, 10));
    const next = codes.length > 0 ? codes : undefined;
    lastExpectExit.current = next;
    patch({ expect_exit: next } as Partial<Step>);
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
          <Field
            label="Runner"
            required
            validationState={fieldErrors?.runner ? 'error' : 'none'}
            validationMessage={fieldErrors?.runner}
          >
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
            <Input value={allowPathsText} onChange={(_e, data) => setAllowPaths(data.value)} />
          </Field>
        </>
      )}

      {step.kind === 'command' && (
        <>
          <Field label="Working directory" hint="Relative to the workspace. Blank = workspace root.">
            <Input value={step.cwd ?? ''} onChange={(_e, data) => patch({ cwd: data.value || undefined } as Partial<Step>)} />
          </Field>
          <Field
            label="Successful exit codes"
            hint="Comma-separated. Blank = 0 only."
            validationState={expectExitError ? 'error' : 'none'}
            validationMessage={expectExitError ?? undefined}
          >
            <Input value={expectExitText} onChange={(_e, data) => setExpectExit(data.value)} />
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
          <Field
            label="Title"
            required
            validationState={fieldErrors?.title ? 'error' : 'none'}
            validationMessage={fieldErrors?.title}
          >
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
        {(() => {
          const verdictSwitch = (
            <Switch
              checked={step.verdict ?? false}
              disabled={guardedByLoopId !== undefined}
              onChange={(_e, data) => patch({ verdict: data.checked || undefined } as Partial<Step>)}
            />
          );
          return guardTooltip
            ? <Tooltip content={guardTooltip} relationship="label">{verdictSwitch}</Tooltip>
            : verdictSwitch;
        })()}
      </Field>

      <Field
        label="Output filename"
        required={step.kind === 'agent'}
        hint={step.kind === 'agent' ? 'Required: the file this step writes.' : 'Optional: leave blank to keep no artifact.'}
        validationState={fieldErrors?.output ? 'error' : 'none'}
        validationMessage={fieldErrors?.output}
      >
        <Input value={step.output ?? ''} onChange={(_e, data) => patch({ output: data.value || undefined } as Partial<Step>)} />
      </Field>

      <Field
        label="Reads from"
        validationState={fieldErrors?.inputs ? 'error' : 'none'}
        validationMessage={fieldErrors?.inputs}
      >
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
    ...(isLoop ? {} : { inputs: step.inputs, verdict: step.verdict, enabled: step.enabled }),
  };
  // Output is optional on every kind but 'agent': carried only when it is
  // non-blank, so a blank or absent output never survives a kind switch as
  // the very `''` core now rejects (or, for 'agent', requires and will flag).
  const output = !isLoop && step.output && step.output.trim() !== '' ? step.output : undefined;
  switch (kind) {
    case 'agent':
      return {
        kind, runner: 'claude', mode: 'headless', writes: false, prompt: '',
        ...carried, ...(output !== undefined ? { output } : {}),
      } as AgentStep;
    case 'command':
      return { kind, run: '', ...carried, ...(output !== undefined ? { output } : {}) } as CommandStep;
    case 'manual':
    case 'approval':
      return {
        kind,
        title: isManualStep(step) ? step.title : step.id,
        instructions: isManualStep(step) ? step.instructions : '',
        ...(isManualStep(step) ? { capture: step.capture, show_diff: step.show_diff, default: step.default } : {}),
        ...carried,
        ...(output !== undefined ? { output } : {}),
      } as ManualStep;
    case 'loop':
      return {
        kind, id: step.id, until: '', enabled: step.enabled,
        steps: isLoop ? step.steps : [],
      };
  }
}
