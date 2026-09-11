import { describe, expect, it } from 'vitest';
import { fromManualRequest } from './from-manual.ts';
import { DIFF_SOURCE_ID } from './model.ts';
import type { ManualRequest } from '../../../../packages/core/src/types.ts';

function request(overrides: Partial<ManualRequest> = {}): ManualRequest {
  return {
    stepId: 'sign-off',
    kind: 'approval',
    title: 'Ship it?',
    instructions: 'Review the diff and the findings.',
    choices: ['continue', 'abort'],
    context: { artifacts: [] },
    defaultChoice: 'continue',
    ...overrides,
  };
}

describe('fromManualRequest', () => {
  it('offers the change set only when the workflow asked for it', () => {
    // `show_diff: false` means core omits context.diff, and the panel must not
    // invent a source the step never said to present.
    expect(fromManualRequest(request()).sources).toEqual([]);

    const withDiff = fromManualRequest(request({ context: { artifacts: [], diff: 'patch' } }));
    expect(withDiff.sources).toEqual([{ kind: 'diff', id: DIFF_SOURCE_ID, label: 'Changes' }]);
  });

  it('turns each declared input into an artifact source labelled by its basename', () => {
    const result = fromManualRequest(request({
      context: {
        artifacts: [
          { id: 'review', path: '/runs/r1/do-review/iter-2/review.md' },
          { id: 'plan', path: '/runs/r1/plan.md' },
        ],
      },
    }));
    expect(result.sources).toEqual([
      { kind: 'artifact', id: 'review', path: '/runs/r1/do-review/iter-2/review.md', label: 'review.md' },
      { kind: 'artifact', id: 'plan', path: '/runs/r1/plan.md', label: 'plan.md' },
    ]);
  });

  it('labels a Windows path by its basename too', () => {
    const result = fromManualRequest(request({
      context: { artifacts: [{ id: 'plan', path: 'C:\\runs\\r1\\plan.md' }] },
    }));
    expect(result.sources[0].label).toBe('plan.md');
  });

  it('puts the change set before the artifacts', () => {
    const result = fromManualRequest(request({
      context: { artifacts: [{ id: 'review', path: '/r/review.md' }], diff: 'patch' },
    }));
    expect(result.sources.map(s => s.kind)).toEqual(['diff', 'artifact']);
  });

  it('marks only continue as the primary choice', () => {
    const result = fromManualRequest(request({ choices: ['continue', 'retry', 'abort'] }));
    expect(result.choices.map(c => [c.value, c.primary])).toEqual([
      ['continue', true], ['retry', false], ['abort', false],
    ]);
    expect(result.choices[1].label).toBe('Retry');
  });

  it('keys a loop iteration separately so a second asking starts a fresh draft', () => {
    const first = fromManualRequest(request({
      loop: { id: 'cycle', iteration: 1, maxIterations: 10 },
    }));
    const second = fromManualRequest(request({
      loop: { id: 'cycle', iteration: 2, maxIterations: 10 },
    }));
    expect(first.key).not.toBe(second.key);
  });

  it('keys a step outside a loop by its id alone', () => {
    expect(fromManualRequest(request()).key).toBe('sign-off');
  });

  it('does not restate the step or the iteration, which the stepper is showing', () => {
    const result = fromManualRequest(request({
      loop: { id: 'cycle', iteration: 2, maxIterations: 10 },
    }));
    // The key is identity, not display — nothing here should read as a label.
    expect(Object.values(result).join(' ')).not.toContain('iteration');
  });

  it('carries the badge register for each kind', () => {
    expect(fromManualRequest(request({ kind: 'approval' })).badge).toBe('Decision needed');
    expect(fromManualRequest(request({ kind: 'manual' })).badge).toBe('Your turn');
  });

  it('passes the capture spec through only when core asked for one', () => {
    expect(fromManualRequest(request()).capture).toBeUndefined();
    const capture = { kind: 'note' as const, label: 'Note', requiredFor: ['continue' as const], perFile: false };
    expect(fromManualRequest(request({ capture })).capture).toEqual(capture);
  });

  it('relabels retry as "Request changes" only under capture: review', () => {
    const withoutCapture = fromManualRequest(request({ choices: ['continue', 'retry', 'abort'] }));
    expect(withoutCapture.choices.find(c => c.value === 'retry')?.label).toBe('Retry');

    const withNote = fromManualRequest(request({
      choices: ['continue', 'retry', 'abort'],
      capture: { kind: 'note', label: 'Note', requiredFor: ['continue'], perFile: false },
    }));
    expect(withNote.choices.find(c => c.value === 'retry')?.label).toBe('Retry');

    const withReview = fromManualRequest(request({
      choices: ['continue', 'retry', 'abort'],
      capture: { kind: 'review', label: 'Feedback', requiredFor: ['retry'], perFile: true },
    }));
    const retry = withReview.choices.find(c => c.value === 'retry');
    expect(retry?.label).toBe('Request changes');
    expect(retry?.hint).toBe('Send it back to the agent with your comments.');
  });
});
