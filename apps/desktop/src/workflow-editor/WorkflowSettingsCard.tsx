import { useState } from 'react';
import {
  Button, Dropdown, Field, Input, Option, Switch, Text,
} from '@fluentui/react-components';
import { ChevronDown20Regular, ChevronRight20Regular } from '@fluentui/react-icons';
import type { OnFindings, Workflow, WorkflowInput } from '../shared/types.ts';

const ON_FINDINGS_OPTIONS: OnFindings[] = ['report', 'loop', 'interactive'];

export interface WorkflowSettingsCardProps {
  workflow: Workflow;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onUpdate: (patch: Partial<Workflow>) => void;
  /**
   * Fires whenever a row's name is blank or collides with another row's —
   * `null` once every row is clean. `workflow.inputs` is a plain object, so a
   * blank or duplicate name can never be pushed there as its own entry; the
   * row survives in this component's own state, and Save is blocked instead
   * of silently dropping it.
   */
  onProblem?: (message: string | null) => void;
}

interface InputRow {
  /** Stable across renames, unlike the name itself — what makes two blank
   * rows, or a rename onto another row's name, distinguishable in the list. */
  key: number;
  name: string;
  input: WorkflowInput;
}

function summaryLine(workflow: Workflow): string {
  const inputCount = Object.keys(workflow.inputs ?? {}).length;
  const parts = [`on_findings: ${workflow.on_findings ?? 'workspace default'}`];
  parts.push(inputCount > 0 ? `${inputCount} input${inputCount === 1 ? '' : 's'}` : 'no inputs');
  return parts.join(' · ');
}

/** One row's problem, if any: a blank name, or a name that collides with an earlier row's. */
function rowProblem(rows: InputRow[], index: number): string | undefined {
  const { name } = rows[index];
  if (name.trim() === '') return 'a name is required';
  if (rows.some((r, i) => i !== index && r.name === name)) return `'${name}' is already used by another input`;
  return undefined;
}

/**
 * Description, on_findings and the inputs table — a card at the top of the
 * same list, with the same collapse behaviour as a step card, collapsed by
 * default. This is the one workflow-level thing in a list that otherwise
 * contains exactly one kind of thing: steps.
 */
export function WorkflowSettingsCard({
  workflow, collapsed, onToggleCollapsed, onUpdate, onProblem,
}: WorkflowSettingsCardProps) {
  // Seeded once, like `useWorkflowDraft`'s own draft state: this component
  // lives for exactly one workflow (a switch remounts the whole editor), so
  // there is no "resync from outside" case to handle here, only pushing this
  // row state's own edits up to the workflow draft.
  const [rows, setRows] = useState<InputRow[]>(() => Object.entries(workflow.inputs ?? {})
    .map(([name, input], key) => ({ key, name, input })));
  const [nextKey, setNextKey] = useState(rows.length);

  function pushRows(next: InputRow[]): void {
    setRows(next);
    const problems = next.map((_row, i) => rowProblem(next, i)).filter((p): p is string => p !== undefined);
    onProblem?.(problems.length > 0 ? `workflow inputs: ${problems.join('; ')}` : null);
    // A blank or duplicate name has nowhere to go in a plain `Record<string,
    // WorkflowInput>` — it is kept in this row state (so it is never lost)
    // and reported above, rather than pushed to the draft as data loss.
    const inputs: Record<string, WorkflowInput> = {};
    for (let i = 0; i < next.length; i++) {
      if (rowProblem(next, i) !== undefined) continue;
      inputs[next[i].name] = next[i].input;
    }
    onUpdate({ inputs: Object.keys(inputs).length > 0 ? inputs : undefined });
  }

  function addInputRow(): void {
    pushRows([...rows, { key: nextKey, name: '', input: { required: false } }]);
    setNextKey(k => k + 1);
  }
  function renameInputRow(index: number, name: string): void {
    const next = rows.slice();
    next[index] = { ...next[index], name };
    pushRows(next);
  }
  function updateInputRow(index: number, patch: Partial<WorkflowInput>): void {
    const next = rows.slice();
    next[index] = { ...next[index], input: { ...next[index].input, ...patch } };
    pushRows(next);
  }
  function removeInputRow(index: number): void {
    const next = rows.slice();
    next.splice(index, 1);
    pushRows(next);
  }

  return (
    <div
      data-testid="workflow-settings-card"
      style={{ border: '1px solid var(--colorNeutralStroke2)', borderRadius: 4 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px' }}>
        <Button
          appearance="subtle"
          size="small"
          data-testid="workflow-settings-collapse"
          aria-label={collapsed ? 'Expand workflow settings' : 'Collapse workflow settings'}
          icon={collapsed ? <ChevronRight20Regular /> : <ChevronDown20Regular />}
          onClick={onToggleCollapsed}
        />
        <Text weight="semibold">Workflow settings</Text>
        <Text size={200} style={{ marginLeft: 'auto', color: 'var(--colorNeutralForeground3)' }}>
          {summaryLine(workflow)}
        </Text>
      </div>

      {!collapsed && (
        <div style={{ borderTop: '1px solid var(--colorNeutralStroke2)', padding: 12, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Field label="Description">
            <Input
              value={workflow.description ?? ''}
              onChange={(_e, data) => onUpdate({ description: data.value || undefined })}
            />
          </Field>

          <Field label="On findings">
            <Dropdown
              value={workflow.on_findings ?? 'Workspace default'}
              selectedOptions={workflow.on_findings ? [workflow.on_findings] : []}
              onOptionSelect={(_e, data) => onUpdate({ on_findings: (data.optionValue || undefined) as OnFindings | undefined })}
            >
              <Option value="">Workspace default</Option>
              {ON_FINDINGS_OPTIONS.map(v => <Option key={v} value={v}>{v}</Option>)}
            </Dropdown>
          </Field>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Text weight="semibold">Inputs</Text>
            {rows.map((row, i) => {
              const problem = rowProblem(rows, i);
              return (
                <div key={row.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <Field label="Name" validationState={problem ? 'error' : 'none'} validationMessage={problem}>
                    <Input value={row.name} onChange={(_e, data) => renameInputRow(i, data.value)} />
                  </Field>
                  <Field label="Prompt">
                    <Input
                      value={row.input.prompt ?? ''}
                      onChange={(_e, data) => updateInputRow(i, { prompt: data.value || undefined })}
                    />
                  </Field>
                  <Field label="Default">
                    <Input
                      value={row.input.default ?? ''}
                      onChange={(_e, data) => updateInputRow(i, { default: data.value || undefined })}
                    />
                  </Field>
                  <Switch
                    label="Required"
                    checked={row.input.required}
                    onChange={(_e, data) => updateInputRow(i, { required: data.checked })}
                  />
                  <Button appearance="subtle" onClick={() => removeInputRow(i)}>Remove</Button>
                </div>
              );
            })}
            <Button appearance="secondary" onClick={addInputRow}>Add input</Button>
          </div>
        </div>
      )}
    </div>
  );
}
