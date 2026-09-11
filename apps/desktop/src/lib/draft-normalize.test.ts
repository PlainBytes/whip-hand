import { describe, expect, it } from 'vitest';
import { normalizeDraft } from './draft-normalize.ts';
import type { Workflow } from '../../../../packages/core/src/types.ts';

describe('normalizeDraft', () => {
  it('strips a blank command output, cwd and shell', () => {
    const wf: Workflow = {
      name: 'w',
      steps: [{
        id: 'a', kind: 'command', run: 'echo hi', output: '   ', cwd: '', shell: '  ',
      }],
    };
    const out = normalizeDraft(wf);
    const step = out.steps[0] as unknown as Record<string, unknown>;
    expect('output' in step).toBe(false);
    expect('cwd' in step).toBe(false);
    expect('shell' in step).toBe(false);
  });

  it('never strips an agent step\'s output — it is required, not optional', () => {
    const wf: Workflow = {
      name: 'w',
      steps: [{
        id: 'a', kind: 'agent', runner: 'claude', mode: 'headless', writes: false, prompt: 'hi', output: '   ',
      }],
    };
    const out = normalizeDraft(wf);
    expect((out.steps[0] as unknown as { output?: string }).output).toBe('   ');
  });

  it('drops verdict: false, matching "absent means default"', () => {
    const wf: Workflow = {
      name: 'w',
      steps: [{
        id: 'a', kind: 'command', run: 'echo hi', output: 'a.log', verdict: false,
      }],
    };
    const out = normalizeDraft(wf);
    expect('verdict' in (out.steps[0] as object)).toBe(false);
  });

  it('recurses into a loop body', () => {
    const wf: Workflow = {
      name: 'w',
      steps: [{
        kind: 'loop', id: 'l', until: 'a',
        steps: [{ id: 'a', kind: 'command', run: 'x', output: '', verdict: true }],
      }],
    };
    const out = normalizeDraft(wf);
    const loop = out.steps[0] as unknown as { steps: Array<Record<string, unknown>> };
    expect('output' in loop.steps[0]).toBe(false);
  });

  it('strips a blank workflow description and blank named-input prompt/default', () => {
    const wf: Workflow = {
      name: 'w',
      description: '   ',
      inputs: { feature: { required: true, prompt: '  ', default: '' } },
      steps: [{ id: 'a', kind: 'command', run: 'x', output: 'a.log' }],
    };
    const out = normalizeDraft(wf);
    expect('description' in out).toBe(false);
    const input = out.inputs!.feature as unknown as Record<string, unknown>;
    expect('prompt' in input).toBe(false);
    expect('default' in input).toBe(false);
  });
});
