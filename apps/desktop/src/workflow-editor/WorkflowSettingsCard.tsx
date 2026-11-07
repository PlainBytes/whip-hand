import { useRef, useState } from 'react';
import {
  Button, Dropdown, Field, Input, Option, Switch, Text, Textarea,
} from '@fluentui/react-components';
import { ChevronDown20Regular, ChevronRight20Regular } from '@fluentui/react-icons';
import type { McpServerDef, McpSettings, OnFindings, Restriction, Workflow, WorkflowInput } from '../shared/types.ts';
import { flattenSteps } from '../shared/steps.ts';
import { useAppStore } from '../state/store.ts';
import { RestrictionPicker, catalogNames } from './RestrictionPicker.tsx';

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

type ServerKind = 'stdio' | 'http' | 'sse';

interface Pair {
  name: string;
  value: string;
}

interface ServerRow {
  key: number;
  name: string;
  kind: ServerKind;
  command: string;
  args: string[];
  /** Stdio env, in file order. A list so a half-typed or duplicate name stays editable. */
  env: Pair[];
  url: string;
  headers: Pair[];
  /** The definition as loaded, until the row is edited: an untouched server saves as it was. */
  loaded?: McpServerDef;
}

function pairsOf(rec: Record<string, string> | undefined): Pair[] {
  return Object.entries(rec ?? {}).map(([name, value]) => ({ name, value }));
}

function recordOf(pairs: Pair[]): Record<string, string> | undefined {
  return pairs.length > 0 ? Object.fromEntries(pairs.map(p => [p.name, p.value])) : undefined;
}

function rowFromServer(key: number, name: string, def: McpServerDef): ServerRow {
  const blank = { key, name, kind: 'stdio' as ServerKind, command: '', args: [], env: [], url: '', headers: [], loaded: def };
  if ('command' in def) {
    return { ...blank, command: def.command, args: def.args ?? [], env: pairsOf(def.env) };
  }
  return { ...blank, kind: def.type, url: def.url, headers: pairsOf(def.headers) };
}

function serverFromRow(row: ServerRow): McpServerDef {
  if (row.loaded !== undefined) return row.loaded;
  if (row.kind === 'stdio') {
    const env = recordOf(row.env);
    return { command: row.command, ...(row.args.length > 0 ? { args: row.args } : {}), ...(env ? { env } : {}) };
  }
  const headers = recordOf(row.headers);
  return { type: row.kind, url: row.url, ...(headers ? { headers } : {}) };
}

function pairsProblem(pairs: Pair[], label: string): string | undefined {
  if (pairs.some(p => p.name.trim() === '')) return `every ${label} needs a name`;
  const repeated = pairs.find((p, i) => pairs.findIndex(q => q.name === p.name) !== i);
  return repeated ? `${label} '${repeated.name}' is listed twice` : undefined;
}

function serverProblem(rows: ServerRow[], index: number): string | undefined {
  const row = rows[index];
  if (row.name.trim() === '') return 'a name is required';
  if (rows.some((r, i) => i !== index && r.name === row.name)) return `'${row.name}' is already used by another server`;
  if (row.kind === 'stdio') {
    return row.command.trim() === '' ? 'a command is required' : pairsProblem(row.env, 'env variable');
  }
  return row.url.trim() === '' ? 'a url is required' : pairsProblem(row.headers, 'header');
}

const LIST_STYLE = { display: 'flex', flexDirection: 'column', gap: 4 } as const;
const LIST_ROW_STYLE = { display: 'flex', gap: 4, alignItems: 'center' } as const;

/**
 * One editor per value, so any value survives as written: a comma in an
 * argument, an empty argument, spaces around a value, a line break in one.
 */
function ArgsEditor({ values, onChange }: { values: string[]; onChange: (next: string[]) => void }) {
  return (
    <div role="group" aria-label="Args" style={LIST_STYLE}>
      <Text size={200}>Args</Text>
      {values.map((value, i) => (
        <div key={i} style={LIST_ROW_STYLE}>
          <Textarea
            aria-label={`Args ${i + 1}`}
            rows={1}
            value={value}
            onChange={(_e, data) => onChange(values.map((v, j) => (j === i ? data.value : v)))}
          />
          <Button size="small" appearance="subtle" aria-label={`Remove Args ${i + 1}`} onClick={() => onChange(values.filter((_v, j) => j !== i))}>×</Button>
        </div>
      ))}
      <Button size="small" appearance="secondary" onClick={() => onChange([...values, ''])}>Add arg</Button>
    </div>
  );
}

/** Holds a `${NAME}` reference? `$${` is an escaped literal, not one. */
const REFERENCE = /(^|[^$])\$\{[A-Za-z_][A-Za-z0-9_]*(:-[^}]*)?\}/;
/** Mirrors `looks_like_credential` in whiphand-core's secrets.rs. */
const CREDENTIAL_NAME = /TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE/i;

/** The value is written out in the workflow under a name that suggests a credential. */
function isLiteralCredential(pair: Pair): boolean {
  return CREDENTIAL_NAME.test(pair.name) && pair.value !== '' && !REFERENCE.test(pair.value);
}

function PairsEditor({ label, addLabel, pairs, onChange }: {
  label: string;
  addLabel: string;
  pairs: Pair[];
  onChange: (next: Pair[]) => void;
}) {
  const patch = (i: number, change: Partial<Pair>): void => onChange(pairs.map((p, j) => (j === i ? { ...p, ...change } : p)));
  return (
    <div role="group" aria-label={label} style={LIST_STYLE}>
      <Text size={200}>{label}</Text>
      {pairs.map((pair, i) => (
        <div key={i} style={LIST_STYLE}>
          <div style={LIST_ROW_STYLE}>
          <Input aria-label={`${label} ${i + 1} name`} value={pair.name} onChange={(_e, data) => patch(i, { name: data.value })} />
          <Textarea aria-label={`${label} ${i + 1} value`} rows={1} placeholder="${NAME}" value={pair.value} onChange={(_e, data) => patch(i, { value: data.value })} />
          <Button size="small" appearance="subtle" aria-label={`Remove ${label} ${i + 1}`} onClick={() => onChange(pairs.filter((_p, j) => j !== i))}>×</Button>
          </div>
          {isLiteralCredential(pair) && (
            <Text size={200} style={{ color: 'var(--colorStatusWarningForeground1)' }}>
              This looks like a credential and would stay in the workflow file and every run&apos;s snapshot. Use {'${NAME}'} and add the value under Settings → Secrets.
            </Text>
          )}
        </div>
      ))}
      <Button size="small" appearance="secondary" onClick={() => onChange([...pairs, { name: '', value: '' }])}>{addLabel}</Button>
    </div>
  );
}

function summaryLine(workflow: Workflow): string {
  const inputCount = Object.keys(workflow.inputs ?? {}).length;
  const parts = [`on_findings: ${workflow.on_findings ?? 'workspace default'}`];
  if (workflow.mcp?.allow !== undefined) parts.push(`mcp: ${workflow.mcp.allow.length} allowed`);
  else if (workflow.mcp?.deny !== undefined) parts.push(`mcp: ${workflow.mcp.deny.length} denied`);
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

  // Inputs and servers both report through the one `onProblem`; keep each
  // table's message so one table going clean doesn't clear the other's.
  const problemsRef = useRef<{ inputs: string | null; servers: string | null }>({ inputs: null, servers: null });
  function reportProblem(table: 'inputs' | 'servers', message: string | null): void {
    problemsRef.current[table] = message;
    const all = [problemsRef.current.inputs, problemsRef.current.servers].filter((m): m is string => m !== null);
    onProblem?.(all.length > 0 ? all.join('; ') : null);
  }

  const [servers, setServers] = useState<ServerRow[]>(() => Object.entries(workflow.mcp?.servers ?? {})
    .map(([name, def], key) => rowFromServer(key, name, def)));
  const [nextServerKey, setNextServerKey] = useState(servers.length);

  const mcpCatalog = useAppStore(state => state.mcpCatalog);
  const pluginCatalog = useAppStore(state => state.pluginCatalog);
  const runners = [...new Set(flattenSteps(workflow.steps)
    .map(f => f.step).flatMap(st => (st.kind === 'agent' ? [st.runner] : [])))];
  const mcpOffer = catalogNames(mcpCatalog?.runners, runners, 'servers');
  const workflowServerNames = Object.keys(workflow.mcp?.servers ?? {});
  const mcpNames = [...mcpOffer.names, ...workflowServerNames.filter(n => !mcpOffer.names.includes(n))];
  const pluginOffer = catalogNames(pluginCatalog?.runners, runners, 'plugins');

  /** The workflow's `mcp:` is the default restriction plus the servers it brings; empty means no key. */
  function pushMcp(restriction: Restriction | undefined, nextServers: ServerRow[]): void {
    const defs: Record<string, McpServerDef> = {};
    nextServers.forEach((row, i) => {
      if (serverProblem(nextServers, i) === undefined) defs[row.name] = serverFromRow(row);
    });
    const mcp: McpSettings = {
      ...(restriction?.allow !== undefined ? { allow: restriction.allow } : {}),
      ...(restriction?.deny !== undefined ? { deny: restriction.deny } : {}),
      ...(Object.keys(defs).length > 0 ? { servers: defs } : {}),
    } as McpSettings;
    onUpdate({ mcp: Object.keys(mcp).length > 0 ? mcp : undefined });
  }
  function pushServers(next: ServerRow[]): void {
    setServers(next);
    const problems = next.map((_r, i) => serverProblem(next, i)).filter((p): p is string => p !== undefined);
    reportProblem('servers', problems.length > 0 ? `workflow MCP servers: ${problems.join('; ')}` : null);
    pushMcp(workflow.mcp, next);
  }
  function patchServer(index: number, patch: Partial<ServerRow>): void {
    const next = servers.slice();
    next[index] = { ...next[index], ...patch, loaded: undefined };
    pushServers(next);
  }

  function pushRows(next: InputRow[]): void {
    setRows(next);
    const problems = next.map((_row, i) => rowProblem(next, i)).filter((p): p is string => p !== undefined);
    reportProblem('inputs', problems.length > 0 ? `workflow inputs: ${problems.join('; ')}` : null);
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

          <RestrictionPicker
            label="MCP servers"
            testId="workflow-mcp"
            value={workflow.mcp?.allow !== undefined ? { allow: workflow.mcp.allow }
              : workflow.mcp?.deny !== undefined ? { deny: workflow.mcp.deny } : undefined}
            inheritable={false}
            offered={mcpNames}
            complete={mcpOffer.complete}
            onChange={next => pushMcp(next, servers)}
          />

          <div data-testid="workflow-mcp-servers" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Text weight="semibold">Workflow MCP servers</Text>
            {servers.map((row, i) => {
              const problem = serverProblem(servers, i);
              return (
                <div key={row.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <Field label="Server name" validationState={problem ? 'error' : 'none'} validationMessage={problem}>
                    <Input value={row.name} onChange={(_e, data) => patchServer(i, { name: data.value })} />
                  </Field>
                  <Field label="Server type">
                    <Dropdown
                      value={row.kind}
                      selectedOptions={[row.kind]}
                      onOptionSelect={(_e, data) => data.optionValue && patchServer(i, { kind: data.optionValue as ServerKind })}
                    >
                      {(['stdio', 'http', 'sse'] as ServerKind[]).map(k => <Option key={k} value={k}>{k}</Option>)}
                    </Dropdown>
                  </Field>
                  {row.kind === 'stdio' ? (
                    <>
                      <Field label="Command">
                        <Input value={row.command} onChange={(_e, data) => patchServer(i, { command: data.value })} />
                      </Field>
                      <ArgsEditor values={row.args} onChange={args => patchServer(i, { args })} />
                      <PairsEditor label="Env" addLabel="Add env variable" pairs={row.env} onChange={env => patchServer(i, { env })} />
                    </>
                  ) : (
                    <>
                      <Field label="URL">
                        <Input value={row.url} onChange={(_e, data) => patchServer(i, { url: data.value })} />
                      </Field>
                      <PairsEditor label="Headers" addLabel="Add header" pairs={row.headers} onChange={headers => patchServer(i, { headers })} />
                    </>
                  )}
                  <Button appearance="subtle" onClick={() => pushServers(servers.filter((_r, j) => j !== i))}>
                    Remove server
                  </Button>
                </div>
              );
            })}
            <Button
              appearance="secondary"
              onClick={() => {
                pushServers([...servers, { key: nextServerKey, name: '', kind: 'stdio', command: '', args: [], env: [], url: '', headers: [] }]);
                setNextServerKey(k => k + 1);
              }}
            >
              Add server
            </Button>
          </div>

          <RestrictionPicker
            label="Plugins"
            testId="workflow-plugins"
            value={workflow.plugins?.allow !== undefined ? { allow: workflow.plugins.allow }
              : workflow.plugins?.deny !== undefined ? { deny: workflow.plugins.deny } : undefined}
            inheritable={false}
            offered={pluginOffer.names}
            complete={pluginOffer.complete}
            onChange={next => onUpdate({
              plugins: next?.allow !== undefined ? { allow: next.allow } : next?.deny !== undefined ? { deny: next.deny } : undefined,
            })}
          />

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
