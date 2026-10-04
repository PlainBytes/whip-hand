import { describe, expect, it } from 'vitest';
import { editorRows, wiring } from './editor-model.ts';
import type { AgentStep, LoopStep, StagesStep, Workflow } from '../shared/types.ts';

const agent = (over: Partial<AgentStep> & { id: string }): AgentStep => ({
  kind: 'agent', runner: 'claude', mode: 'headless', writes: false,
  prompt: `prompt for ${over.id}`, output: `${over.id}.md`, ...over,
});

/** Mirrors feature-development.yaml's nesting: human-review wraps do-review wraps execute/review. */
function nested(): Workflow {
  const doReview: LoopStep = {
    kind: 'loop', id: 'do-review', until: 'review', max_iterations: 10,
    steps: [
      agent({ id: 'execute', writes: true, inputs: ['plan', 'review', 'sign-off'] }),
      agent({ id: 'review', verdict: true, inputs: ['plan', 'execute'] }),
    ],
  };
  const humanReview: LoopStep = {
    kind: 'loop', id: 'human-review', until: 'sign-off', max_iterations: 5,
    steps: [doReview, { kind: 'manual', id: 'sign-off', title: 't', instructions: 'i', verdict: true, inputs: ['review'] }],
  };
  return {
    name: 'feature-development',
    steps: [
      agent({ id: 'plan', mode: 'interactive' }),
      humanReview,
      agent({ id: 'commit-message', inputs: ['plan', 'review', 'sign-off'] }),
    ],
  };
}

describe('editorRows', () => {
  it('flattens the whole tree, one row per step at any depth, in document order', () => {
    const rows = editorRows(nested());
    expect(rows.map(r => r.step.id)).toEqual([
      'plan', 'human-review', 'do-review', 'execute', 'review', 'sign-off', 'commit-message',
    ]);
  });

  it('carries depth for indentation — a loop\'s body one level in', () => {
    const rows = editorRows(nested());
    const depthOf = (id: string) => rows.find(r => r.step.id === id)!.depth;
    expect(depthOf('plan')).toBe(0);
    expect(depthOf('human-review')).toBe(0);
    expect(depthOf('do-review')).toBe(1);
    expect(depthOf('execute')).toBe(2);
    expect(depthOf('sign-off')).toBe(1);
  });

  it('carries each row\'s path, addressable back into the tree', () => {
    const rows = editorRows(nested());
    expect(rows.find(r => r.step.id === 'execute')!.path).toEqual([1, 0, 0]);
    expect(rows.find(r => r.step.id === 'commit-message')!.path).toEqual([2]);
  });

  it('badges the step named by an enclosing loop\'s until: as endsLoop', () => {
    const rows = editorRows(nested());
    const endsLoopIds = rows.filter(r => r.endsLoop).map(r => r.step.id);
    expect(endsLoopIds.sort()).toEqual(['review', 'sign-off']);
  });

  it('dims a disabled loop\'s whole body, but not the loop\'s siblings', () => {
    const wf = nested();
    (wf.steps[1] as LoopStep).enabled = false;
    const rows = editorRows(wf);
    const dimmedIds = rows.filter(r => r.dimmed).map(r => r.step.id);
    expect(dimmedIds.sort()).toEqual(['do-review', 'execute', 'human-review', 'review', 'sign-off']);
    expect(rows.find(r => r.step.id === 'plan')!.dimmed).toBe(false);
    expect(rows.find(r => r.step.id === 'commit-message')!.dimmed).toBe(false);
  });
});

describe('wiring', () => {
  it('sources(id) is what a step reads; dependents(id) is who reads it', () => {
    const w = wiring(nested());
    expect(w.sources('commit-message').sort()).toEqual(['plan', 'review', 'sign-off']);
    expect(w.dependents('review').sort()).toEqual(['commit-message', 'execute', 'sign-off']);
  });

  it('a loop has no sources — nothing can inputs: a loop', () => {
    expect(wiring(nested()).sources('human-review')).toEqual([]);
  });

  it('a command step\'s inputs never appear as a dependent — inputs: is a runtime no-op for one', () => {
    const wf: Workflow = {
      name: 'w',
      steps: [
        agent({ id: 'plan' }),
        { kind: 'command', id: 'stage', run: 'echo hi', inputs: ['plan'], output: 'stage.log' },
      ],
    };
    expect(wiring(wf).dependents('plan')).toEqual([]);
  });

  it('attachments is the run\'s files, not a card: no source, and never anyone\'s dependent', () => {
    // Even a step wrongly *called* attachments (core rejects the id) must not
    // light up every reader of the attached files.
    const wf: Workflow = {
      name: 'w',
      steps: [
        agent({ id: 'attachments' }),
        agent({ id: 'plan', inputs: ['attachments'] }),
        agent({ id: 'execute', inputs: ['attachments', 'plan'] }),
      ],
    };
    const w = wiring(wf);
    expect(w.sources('execute')).toEqual(['plan']);
    expect(w.sources('plan')).toEqual([]);
    expect(w.dependents('attachments')).toEqual([]);
  });
});

describe('a stages step in the editor model', () => {
  const staged = (): Workflow => ({
    name: 'staged',
    steps: [
      agent({ id: 'plan' }),
      {
        kind: 'stages', id: 'build', items: 'plans/*.md',
        steps: [
          agent({ id: 'impl', inputs: ['stage', 'plan'] }),
          { kind: 'loop', id: 'fix', until: 'check', steps: [agent({ id: 'check', verdict: true, inputs: ['impl'] })] },
          { kind: 'approval', id: 'gate', title: 't', instructions: 'i' },
        ],
      } as StagesStep,
      agent({ id: 'after', inputs: ['plan'] }),
    ],
  });

  it('gives its body rows, one level in, addressable by path', () => {
    const rows = editorRows(staged());
    expect(rows.map(r => [r.step.id, r.depth])).toEqual([
      ['plan', 0], ['build', 0], ['impl', 1], ['fix', 1], ['check', 2], ['gate', 1], ['after', 0],
    ]);
    expect(rows.find(r => r.step.id === 'check')!.path).toEqual([1, 1, 0]);
  });

  it('marks the rows inside a stages body, at any depth, and only those', () => {
    const inStages = editorRows(staged()).filter(r => r.inStages).map(r => r.step.id);
    expect(inStages).toEqual(['impl', 'fix', 'check', 'gate']);
  });

  it('dims a disabled stages step\'s whole body', () => {
    const wf = staged();
    (wf.steps[1] as StagesStep).enabled = false;
    expect(editorRows(wf).filter(r => r.dimmed).map(r => r.step.id)).toEqual(['build', 'impl', 'fix', 'check', 'gate']);
  });

  it('wires reads inside its body — `stage` is the stage file, not a card to light up', () => {
    const w = wiring(staged());
    expect(w.sources('impl')).toEqual(['plan']);
    expect(w.dependents('plan').sort()).toEqual(['after', 'impl']);
    expect(w.dependents('impl')).toEqual(['check']);
    expect(w.sources('build')).toEqual([]);
  });
});
