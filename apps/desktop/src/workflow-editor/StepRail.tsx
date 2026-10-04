import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Combobox, Dropdown, Field, Input, Link, Option, Switch, Text, Tooltip,
} from '@fluentui/react-components';
import type {
  AgentStep, CommandStep, EffortLevel, ManualStep, StagesStep, Step, StepKind, StepMode,
} from '../shared/types.ts';
import { childSteps, isAgentStep, isManualStep } from '../shared/steps.ts';
import { ATTACHMENTS_REF } from '../shared/attachments.ts';
import { STAGE_REF } from '../shared/types.ts';
import { useAgentClient } from '../agent/agent-context.tsx';
import { useAppStore } from '../state/store.ts';
import { useStepLayoutStyles } from './step-layout.ts';
import { numberOrUndefined } from './number-field.ts';
import { refreshModelCatalog } from './use-harness-catalog.ts';

const SUBTLE = { color: 'var(--colorNeutralForeground3)' };

const STEP_MODE_OPTIONS: StepMode[] = ['interactive', 'headless'];
const EFFORT_OPTIONS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const CAPTURE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'None' },
  { value: 'note', label: 'Note' },
  { value: 'review', label: 'Review' },
];

export interface StepRailProps {
  step: AgentStep | CommandStep | ManualStep;
  earlierStepIds: string[];
  /** Sits in a `stages` body — Reads from offers `stage`, the current stage file. */
  inStages?: boolean;
  /** Set when this step is a loop's `until:` target — Verdict is locked on, naming the loop. */
  guardedByLoopId?: string;
  onUpdate: (next: Step) => void;
  /** Field key -> message, from a failed Save — same gating as the card's problem badge. */
  fieldErrors?: Record<string, string>;
}

/**
 * The kind-dependent right rail, in one or two fixed-width columns depending
 * on the card's width: runner, model, mode, effort, writes, allow commits,
 * verdict, then the wiring — what it reads, what it writes, allowed paths.
 * Everything a step's prose sits beside, none of it stacked beneath a textarea
 * any more. Each field is a direct child, so each is its own cell of the rail's
 * grid.
 */
export function StepRail({ step, earlierStepIds, inStages, guardedByLoopId, onUpdate, fieldErrors }: StepRailProps) {
  const styles = useStepLayoutStyles();
  const guardTooltip = guardedByLoopId
    ? `'${step.id}' ends loop '${guardedByLoopId}' — it must keep Verdict on`
    : undefined;

  function patch(fields: Partial<Step>): void {
    onUpdate({ ...step, ...fields } as Step);
  }

  // Read from the store rather than via props: step cards nest inside loops,
  // and threading doctor/catalog through StepCard and the loop body just to
  // reach the one rail that needs them would be a lot of plumbing for two
  // values that are already prefetched once, workspace-wide, by
  // use-harness-catalog.ts.
  const client = useAgentClient();
  const doctorResult = useAppStore(state => state.doctorResult);
  const modelCatalog = useAppStore(state => state.modelCatalog);
  const setModelCatalog = useAppStore(state => state.setModelCatalog);

  function refreshModels(): void {
    refreshModelCatalog(client, setModelCatalog);
  }

  const runnerId = isAgentStep(step) ? step.runner : undefined;

  // `.runner` only: doctor also reports support tools and harnesses whiphand
  // has no adapter for — offering `git` here would build a workflow that
  // fails validateWorkflowRunners at run time. Before doctor answers,
  // doctorResult is null and this is just the step's own current value, so
  // nothing already chosen is ever lost off the list.
  const runnerOptions = useMemo(() => {
    const ids = new Set((doctorResult ?? []).filter(r => r.runner).map(r => r.id));
    if (runnerId !== undefined) ids.add(runnerId);
    return Array.from(ids);
  }, [doctorResult, runnerId]);
  // Only once doctor has actually answered — before that, "unknown" cannot be
  // told apart from "not asked yet", and warning would be a false positive.
  const runnerWarning = runnerId !== undefined && doctorResult !== null
    && !doctorResult.some(r => r.runner && r.id === runnerId)
    ? `'${runnerId}' isn't a runner whiphand can drive`
    : undefined;

  const modelList = runnerId === undefined ? undefined : modelCatalog?.[runnerId];
  const modelOptions = modelList?.models ?? [];
  // A missing list (loading, no modelCatalog yet, or a runner with no
  // listModels at all) must never look like a typo — only 'live' and
  // 'fallback' lists are complete enough to call an unmatched value wrong.
  const modelValue = isAgentStep(step) ? (step.model ?? '').trim() : '';
  const modelWarning = modelValue !== ''
    && modelList !== undefined && modelList.source !== 'unavailable'
    && !modelOptions.some(m => m.id === modelValue || m.resolves === modelValue)
    ? `'${modelValue}' isn't in ${runnerId}'s model list`
    : undefined;

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
            validationState={fieldErrors?.runner ? 'error' : runnerWarning ? 'warning' : 'none'}
            validationMessage={fieldErrors?.runner ?? runnerWarning}
          >
            <Dropdown
              value={step.runner}
              selectedOptions={[step.runner]}
              onOptionSelect={(_e, data) => data.optionValue && patch({ runner: data.optionValue } as Partial<Step>)}
            >
              {runnerOptions.map(id => <Option key={id} value={id}>{id}</Option>)}
            </Dropdown>
          </Field>
          <Field
            label="Model"
            validationState={modelWarning ? 'warning' : 'none'}
            validationMessage={modelWarning}
            hint={
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {modelList?.source === 'fallback' && modelList.note && <Text size={200} style={SUBTLE}>{modelList.note}</Text>}
                <Link as="button" type="button" onClick={refreshModels}>Refresh list</Link>
              </span>
            }
          >
            <Combobox
              freeform
              value={step.model ?? ''}
              selectedOptions={step.model ? [step.model] : []}
              onChange={e => patch({ model: e.target.value || undefined } as Partial<Step>)}
              onOptionSelect={(_e, data) => patch({ model: data.optionValue || undefined } as Partial<Step>)}
            >
              <Option value="">Default</Option>
              {modelOptions.map(m => (
                <Option key={m.id} value={m.id} text={m.label ?? m.id}>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <Text>{m.label ?? m.id}</Text>
                    {m.description && <Text size={200} style={SUBTLE}>{m.description}</Text>}
                  </div>
                </Option>
              ))}
            </Combobox>
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
          <Switch
            label="Allow commits"
            checked={step.allow_commits ?? false}
            onChange={(_e, data) => patch({ allow_commits: data.checked || undefined } as Partial<Step>)}
          />
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
          {/* Not a step either: the current stage file, readable only inside a
              stages body — schema.ts refuses it anywhere else. There it always
              means the stage file, even if a step is (invalidly) named it. */}
          {inStages && (
            <Option value={STAGE_REF} text={STAGE_REF}>
              {STAGE_REF}{' '}
              <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>— the current stage file</Text>
            </Option>
          )}
          {earlierStepIds
            .filter(id => id !== ATTACHMENTS_REF && !(inStages && id === STAGE_REF))
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
  // A container (`loop` or `stages`) carries no StepCommon field at all — no
  // `inputs`, `verdict` or `output` to read here, only `id`/`enabled`/`steps`.
  const isContainer = step.kind === 'loop' || step.kind === 'stages';
  const carried = {
    id: step.id,
    ...(isContainer ? {} : { inputs: step.inputs, verdict: step.verdict, enabled: step.enabled }),
  };
  // Output is optional on every kind but 'agent': carried only when it is
  // non-blank, so a blank or absent output never survives a kind switch as
  // the very `''` core now rejects (or, for 'agent', requires and will flag).
  const output = !isContainer && step.output && step.output.trim() !== '' ? step.output : undefined;
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
      // A container keeps its body across the switch; `until` starts blank,
      // as a fresh loop's does, for Repeat until to fill in.
      return {
        kind, id: step.id, until: '', enabled: step.enabled,
        steps: childSteps(step),
      };
    case 'stages':
      // Same as 'loop': the body survives, and Stage files starts blank.
      return {
        kind, id: step.id, items: '', enabled: step.enabled,
        steps: childSteps(step),
      } as StagesStep;
  }
}
