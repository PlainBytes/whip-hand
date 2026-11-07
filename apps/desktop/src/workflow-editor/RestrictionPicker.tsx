import { useState } from 'react';
import { Badge, Button, Checkbox, Dropdown, Field, Input, Option, Text } from '@fluentui/react-components';
import type { Restriction } from '../shared/types.ts';

type Mode = 'inherit' | 'all' | 'allow' | 'deny';

const MODE_LABEL: Record<Mode, string> = {
  inherit: 'Inherit from workflow',
  all: 'All',
  allow: 'Only these',
  deny: 'All except these',
};

export interface RestrictionPickerProps {
  /** Shown in the field label and used for accessible names, e.g. "MCP servers". */
  label: string;
  testId: string;
  /** The current include/exclude. Absent is the default: inherit for a step, all for the workflow. */
  value: Restriction | undefined;
  /** A step can inherit the workflow's setting; the workflow itself cannot. */
  inheritable: boolean;
  /** Names the catalog (and the workflow) offer; free-text entry covers any the catalog could not read. */
  offered: string[];
  /** The offered list is complete enough to call an unmatched name wrong. False before the catalog answers. */
  complete: boolean;
  onChange: (next: Restriction | undefined) => void;
}

function modeOf(value: Restriction | undefined, inheritable: boolean): Mode {
  if (value === undefined) return inheritable ? 'inherit' : 'all';
  if (value.allow !== undefined) return 'allow';
  if (value.deny !== undefined) {
    // On a step, an empty deny list is how "All" is written: the engine reads it
    // as unrestricted and it overrides the workflow, unlike a bare `{}` (inherit).
    return inheritable && value.deny.length === 0 ? 'all' : 'deny';
  }
  return inheritable ? 'inherit' : 'all';
}

function namesOf(value: Restriction | undefined): string[] {
  return value?.allow ?? value?.deny ?? [];
}

function build(mode: Mode, names: string[], inheritable: boolean): Restriction | undefined {
  switch (mode) {
    case 'inherit': return undefined;
    // A step writes "All" as `{ deny: [] }` (a bare `{}` would inherit). The
    // workflow-level caller turns an empty restriction back into an absent key.
    case 'all': return inheritable ? { deny: [] } : {};
    case 'allow': return { allow: names };
    case 'deny': return { deny: names };
  }
}

/**
 * Include / exclude picker for MCP servers or plugins: a mode selector and,
 * for the two list modes, a checkbox per offered name plus free-text entry.
 * A selected name the catalog doesn't list is kept and badged, not refused:
 * the catalog may be stale.
 */
export function RestrictionPicker({
  label, testId, value, inheritable, offered, complete, onChange,
}: RestrictionPickerProps) {
  const [draftName, setDraftName] = useState('');
  // On a step, "All except these" with nothing listed yet is saved as the same
  // `{ deny: [] }` as All. Only this picker knows the list is being edited, so
  // the controls for entering the first name stay up until the mode changes.
  const [editingDeny, setEditingDeny] = useState(false);
  const stored = modeOf(value, inheritable);
  const mode: Mode = stored === 'all' && editingDeny && value?.deny !== undefined ? 'deny' : stored;
  const selected = namesOf(value);
  const choices = [...offered, ...selected.filter(n => !offered.includes(n))];
  const modes: Mode[] = inheritable ? ['inherit', 'all', 'allow', 'deny'] : ['all', 'allow', 'deny'];

  function commit(next: Mode, names: string[]): void {
    setEditingDeny(next === 'deny');
    onChange(build(next, names, inheritable));
  }
  function setMode(next: Mode): void {
    // Switching between the two list modes keeps the names already picked.
    commit(next, next === 'allow' || next === 'deny' ? selected : []);
  }
  function toggle(name: string, on: boolean): void {
    commit(mode, on ? [...selected, name] : selected.filter(n => n !== name));
  }
  function addTyped(): void {
    const name = draftName.trim();
    if (name === '') return;
    setDraftName('');
    if (!selected.includes(name)) commit(mode, [...selected, name]);
  }

  return (
    <div data-testid={testId} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Field label={label}>
        <Dropdown
          aria-label={`${label} mode`}
          value={MODE_LABEL[mode]}
          selectedOptions={[mode]}
          onOptionSelect={(_e, data) => data.optionValue && setMode(data.optionValue as Mode)}
        >
          {modes.map(m => <Option key={m} value={m}>{MODE_LABEL[m]}</Option>)}
        </Dropdown>
      </Field>
      {(mode === 'allow' || mode === 'deny') && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 4 }}>
          {choices.length === 0 && (
            <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>
              {mode === 'allow' ? 'None allowed.' : 'Nothing excluded.'}
            </Text>
          )}
          {choices.map(name => (
            <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Checkbox
                label={name}
                checked={selected.includes(name)}
                onChange={(_e, data) => toggle(name, data.checked === true)}
              />
              {complete && !offered.includes(name) && (
                <Badge color="warning" appearance="tint" size="small">not found</Badge>
              )}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Input
              aria-label={`Add ${label} name`}
              placeholder="name"
              size="small"
              value={draftName}
              onChange={(_e, data) => setDraftName(data.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTyped(); } }}
            />
            <Button size="small" appearance="secondary" aria-label={`Add ${label} entry`} onClick={addTyped}>Add</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Catalog names for the given runners, in order, without duplicates. */
export function catalogNames(
  rows: Record<string, { source: string } & Record<string, unknown>> | undefined | null,
  runners: string[],
  key: 'servers' | 'plugins',
): { names: string[]; complete: boolean } {
  if (!rows) return { names: [], complete: false };
  const names: string[] = [];
  let complete = true;
  for (const runner of runners) {
    const row = rows[runner];
    if (row === undefined) { complete = false; continue; }
    // An unavailable row may still hold what the readable config files gave:
    // worth offering, but not enough to call any other name wrong.
    if (row.source === 'unavailable') complete = false;
    for (const item of (row[key] as Array<{ name: string }>)) {
      if (!names.includes(item.name)) names.push(item.name);
    }
  }
  return { names, complete };
}
