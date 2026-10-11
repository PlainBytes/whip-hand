import { describe, expect, it } from 'vitest';
import { findEntry, initialValues, preselect, refFor, type WorkflowEntry } from './new-run-draft.ts';

function entry(name: string, source: 'project' | 'global', extra: Partial<WorkflowEntry> = {}): WorkflowEntry {
  return {
    name, source, path: `/${source}/${name}.yaml`,
    workflow: {
      name,
      inputs: {
        ticket: { required: true },
        env: { required: false, remember: true },
        branch: { required: false, default: 'main' },
      },
      steps: [],
    },
    ...extra,
  } as WorkflowEntry;
}

const memory = (lastWorkflow: string, lastInputs: Record<string, Record<string, string>> = {}) => ({ lastWorkflow, lastInputs });

describe('preselect', () => {
  const ship = entry('ship', 'project');
  const review = entry('review', 'project');

  it('selects nothing while the list is not loaded', () => {
    expect(preselect([], memory('ship'), { workflow: 'ship', inputs: {} })).toBeNull();
  });

  it('lets run-again win over the remembered workflow, and its inputs over everything', () => {
    const chosen = preselect([ship, review], memory('ship', { review: { env: 'staging' } }), {
      workflow: 'review', inputs: { ticket: 'T-1', env: 'prod' },
    });
    expect(chosen).toEqual({ workflowRef: 'review', values: { ticket: 'T-1', env: 'prod', branch: 'main' } });
  });

  it('falls back to the remembered workflow without run-again', () => {
    expect(preselect([ship, review], memory('review'))?.workflowRef).toBe('review');
  });

  it('selects nothing without run-again or memory', () => {
    expect(preselect([ship, review], undefined)).toBeNull();
  });

  it('falls back when the run-again target is unknown', () => {
    expect(preselect([ship, review], memory('review'), { workflow: 'gone', inputs: { ticket: 'x' } }))
      .toEqual({ workflowRef: 'review', values: { ticket: '', env: '', branch: 'main' } });
  });

  it('falls back when the run-again target has a parse error', () => {
    const broken = entry('broken', 'project', { error: 'bad yaml', workflow: undefined });
    expect(preselect([broken, ship], memory('ship'), { workflow: 'broken', inputs: {} })?.workflowRef).toBe('ship');
  });

  it('selects nothing when the remembered workflow is gone or errored', () => {
    const broken = entry('ship', 'project', { error: 'bad yaml', workflow: undefined });
    expect(preselect([broken], memory('ship'))).toBeNull();
    expect(preselect([review], memory('ship'))).toBeNull();
  });

  it('tells a global entry from a project one of the same name', () => {
    const global = entry('ship', 'global');
    expect(preselect([ship, global], memory('global:ship'))?.workflowRef).toBe('global:ship');
    expect(preselect([ship, global], memory('ship'))?.workflowRef).toBe('ship');
    expect(preselect([global, ship], undefined, { workflow: 'global:ship', inputs: {} })?.workflowRef).toBe('global:ship');
    expect(preselect([ship], memory('global:ship'))).toBeNull();
  });

  it('reads remembered inputs under the entry\'s own ref', () => {
    const global = entry('ship', 'global');
    const mem = memory('ship', { ship: { env: 'project-env' }, 'global:ship': { env: 'global-env' } });
    expect(preselect([ship, global], { ...mem, lastWorkflow: 'global:ship' })?.values.env).toBe('global-env');
    expect(preselect([ship, global], mem)?.values.env).toBe('project-env');
  });
});

describe('initialValues', () => {
  const ship = entry('ship', 'project');

  it('fills only remember: true inputs from memory', () => {
    const values = initialValues(ship, memory('ship', { ship: { ticket: 'OLD', env: 'staging', branch: 'dev' } }));
    expect(values).toEqual({ ticket: '', env: 'staging', branch: 'main' });
  });

  it('prefers an override, then memory, then the default, then blank', () => {
    expect(initialValues(ship, undefined, { branch: 'x' })).toEqual({ ticket: '', env: '', branch: 'x' });
  });

  it('is empty for a workflow without inputs', () => {
    expect(initialValues(entry('bare', 'project', { workflow: { name: 'bare', steps: [] } } as never), undefined)).toEqual({});
  });
});

describe('refs', () => {
  it('scopes a global entry and leaves a project one bare', () => {
    expect(refFor(entry('a', 'global'))).toBe('global:a');
    expect(refFor(entry('a', 'project'))).toBe('a');
  });

  it('resolves explicit scopes exactly, and a bare name to the first match', () => {
    const list = [entry('a', 'project'), entry('a', 'global')];
    expect(findEntry(list, 'global:a')).toBe(list[1]);
    expect(findEntry(list, 'project:a')).toBe(list[0]);
    expect(findEntry(list, 'a')).toBe(list[0]);
    expect(findEntry([list[1]], 'project:a')).toBeUndefined();
  });
});
