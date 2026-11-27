import { describe, expect, it } from 'vitest';
import { authorInputPlaceholder, findAuthorWorkflow, savedWorkflowOf } from './author-workflow.ts';
import type { WorkflowEntry } from './new-run-draft.ts';

const WORKFLOW = { name: 'author-workflow', steps: [] } as unknown as NonNullable<WorkflowEntry['workflow']>;

function entry(over: Partial<WorkflowEntry>): WorkflowEntry {
  return { name: 'author-workflow', path: '/ws/.whiphand/workflows/author-workflow.yaml', source: 'project', workflow: WORKFLOW, ...over };
}

function run(over: Record<string, unknown> = {}) {
  return {
    status: 'succeeded',
    workflow: 'author-workflow',
    inputs: { goal: 'g', name: 'feature', scope: 'workspace' },
    steps: [{ id: 'design', status: 'done' }, { id: 'save', status: 'done' }],
    ...over,
  };
}

describe('findAuthorWorkflow', () => {
  it('finds a usable entry in any scope', () => {
    expect(findAuthorWorkflow([entry({ source: 'global' })])?.source).toBe('global');
  });

  it('skips a missing, broken or shadowed one', () => {
    expect(findAuthorWorkflow([])).toBeUndefined();
    expect(findAuthorWorkflow([entry({ workflow: undefined, error: 'bad yaml' })])).toBeUndefined();
    expect(findAuthorWorkflow([entry({ name: 'feature' })])).toBeUndefined();
    expect(findAuthorWorkflow([entry({ shadowed: true, source: 'global' }), entry({ source: 'project' })])?.source).toBe('project');
  });
});

describe('savedWorkflowOf', () => {
  it('reads the saved name and scope from a succeeded run whose save step is done', () => {
    expect(savedWorkflowOf(run())).toEqual({ name: 'feature', scope: 'workspace' });
  });

  it("falls back to the template's default scope when scope is blank or unknown", () => {
    expect(savedWorkflowOf(run({ inputs: { name: 'feature' } }))).toEqual({ name: 'feature', scope: 'project' });
    expect(savedWorkflowOf(run({ inputs: { name: 'feature', scope: 'nowhere' } }))).toEqual({ name: 'feature', scope: 'project' });
  });

  it('is null for another workflow, an unfinished run, a failed save or no name', () => {
    expect(savedWorkflowOf(null)).toBeNull();
    expect(savedWorkflowOf(run({ workflow: 'feature' }))).toBeNull();
    expect(savedWorkflowOf(run({ status: 'failed' }))).toBeNull();
    expect(savedWorkflowOf(run({ status: 'running' }))).toBeNull();
    // `done` is a step status; core never writes it as a run's status.
    expect(savedWorkflowOf(run({ status: 'done' }))).toBeNull();
    expect(savedWorkflowOf(run({ steps: [{ id: 'save', status: 'failed' }] }))).toBeNull();
    expect(savedWorkflowOf(run({ steps: [{ id: 'design', status: 'done' }] }))).toBeNull();
    expect(savedWorkflowOf(run({ inputs: { name: '  ' } }))).toBeNull();
  });
});

describe('authorInputPlaceholder', () => {
  it("asks what should change only for author-workflow's goal with a file attached", () => {
    expect(authorInputPlaceholder('author-workflow', 'goal', 1)).toBe('What should change?');
    expect(authorInputPlaceholder('author-workflow', 'goal', 0)).toBeUndefined();
    expect(authorInputPlaceholder('author-workflow', 'name', 1)).toBeUndefined();
    expect(authorInputPlaceholder('feature', 'goal', 1)).toBeUndefined();
  });
});
