import {
  Button, Dropdown, Field, Input, Option, Switch, Text,
} from '@fluentui/react-components';
import { ChevronDown20Regular, ChevronRight20Regular } from '@fluentui/react-icons';
import type { OnFindings, Workflow, WorkflowInput } from '../../../../packages/core/src/types.ts';

const ON_FINDINGS_OPTIONS: OnFindings[] = ['report', 'loop', 'interactive'];

export interface WorkflowSettingsCardProps {
  workflow: Workflow;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onUpdate: (patch: Partial<Workflow>) => void;
}

function summaryLine(workflow: Workflow): string {
  const inputCount = Object.keys(workflow.inputs ?? {}).length;
  const parts = [`on_findings: ${workflow.on_findings ?? 'workspace default'}`];
  parts.push(inputCount > 0 ? `${inputCount} input${inputCount === 1 ? '' : 's'}` : 'no inputs');
  return parts.join(' · ');
}

/**
 * Description, on_findings and the inputs table — a card at the top of the
 * same list, with the same collapse behaviour as a step card, collapsed by
 * default. This is the one workflow-level thing in a list that otherwise
 * contains exactly one kind of thing: steps.
 */
export function WorkflowSettingsCard({ workflow, collapsed, onToggleCollapsed, onUpdate }: WorkflowSettingsCardProps) {
  const inputEntries: [string, WorkflowInput][] = Object.entries(workflow.inputs ?? {});

  function setInputEntries(entries: [string, WorkflowInput][]): void {
    onUpdate({ inputs: entries.length > 0 ? Object.fromEntries(entries) : undefined });
  }

  function addInputRow(): void {
    setInputEntries([...inputEntries, ['', { required: false }]]);
  }
  function renameInputRow(index: number, key: string): void {
    const entries = inputEntries.slice();
    entries[index] = [key, entries[index][1]];
    setInputEntries(entries);
  }
  function updateInputRow(index: number, patch: Partial<WorkflowInput>): void {
    const entries = inputEntries.slice();
    entries[index] = [entries[index][0], { ...entries[index][1], ...patch }];
    setInputEntries(entries);
  }
  function removeInputRow(index: number): void {
    const entries = inputEntries.slice();
    entries.splice(index, 1);
    setInputEntries(entries);
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
            {inputEntries.map(([key, input], i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <Field label="Name">
                  <Input value={key} onChange={(_e, data) => renameInputRow(i, data.value)} />
                </Field>
                <Field label="Prompt">
                  <Input value={input.prompt ?? ''} onChange={(_e, data) => updateInputRow(i, { prompt: data.value || undefined })} />
                </Field>
                <Field label="Default">
                  <Input value={input.default ?? ''} onChange={(_e, data) => updateInputRow(i, { default: data.value || undefined })} />
                </Field>
                <Switch label="Required" checked={input.required} onChange={(_e, data) => updateInputRow(i, { required: data.checked })} />
                <Button appearance="subtle" onClick={() => removeInputRow(i)}>Remove</Button>
              </div>
            ))}
            <Button appearance="secondary" onClick={addInputRow}>Add input</Button>
          </div>
        </div>
      )}
    </div>
  );
}
