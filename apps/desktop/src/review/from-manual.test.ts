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

  describe('with execution but no stage', () => {
    // Core now sends `execution` for every framed gate, so a plain or nested
    // loop takes the `execution` path — it must key exactly as the old
    // `loop`-only path did, or a draft saved before would be orphaned.
    const keys = (loop: NonNullable<ManualRequest['loop']>, execution: NonNullable<ManualRequest['execution']>) => ({
      viaLoop: fromManualRequest(request({ loop })).key,
      viaExecution: fromManualRequest(request({ loop, execution })).key,
    });

    it('keys a plain loop iteration as the loop path did', () => {
      expect(keys({ id: 'cycle', iteration: 1, maxIterations: 10 }, { loopId: 'cycle', iteration: 1 }))
        .toEqual({ viaLoop: 'sign-off', viaExecution: 'sign-off' });
      expect(keys({ id: 'cycle', iteration: 2, maxIterations: 10 }, { loopId: 'cycle', iteration: 2 }))
        .toEqual({ viaLoop: 'sign-off#2', viaExecution: 'sign-off#2' });
    });

    it('keys a nested loop round as the loop path did', () => {
      const loop = {
        id: 'inner', iteration: 2, maxIterations: 3,
        parent: { id: 'outer', iteration: 3, maxIterations: 5 },
      };
      const execution = { loopId: 'inner', iteration: 2, outerLoops: [{ id: 'outer', iteration: 3 }] };
      expect(keys(loop, execution)).toEqual({ viaLoop: 'outer#3/sign-off#2', viaExecution: 'outer#3/sign-off#2' });
    });
  });

  describe('inside a stage', () => {
    /** The gate `accept` directly under stage `stageId` of stages step 'build', as core's manual.ts builds it. */
    const reqFor = (stageId: string, attempt = 1, maxAttempts: number | null = 3): ManualRequest => request({
      stepId: 'accept',
      choices: ['continue', 'retry', 'abort'],
      stage: {
        stagesId: 'build', id: stageId, title: 'Add API routes', index: 2, total: 7, attempt,
        ...(maxAttempts === null ? {} : { maxAttempts }),
      },
      execution: { loopId: 'build', iteration: attempt, stage: stageId },
    });

    it('keys on its stage, so two stages do not share one review', () => {
      expect(fromManualRequest(reqFor('01-a')).key).not.toEqual(fromManualRequest(reqFor('02-b')).key);
      expect(fromManualRequest(reqFor('02-b')).key).toBe('accept@02-b#1');
    });

    it('keys a retried attempt of the same stage as a fresh question', () => {
      expect(fromManualRequest(reqFor('02-b', 2)).key).toBe('accept@02-b#2');
    });

    it('keys a gate inside a loop inside a stage by the whole frame chain', () => {
      const result = fromManualRequest(request({
        stepId: 'check',
        loop: { id: 'cycle', iteration: 2, maxIterations: 3 },
        execution: { loopId: 'cycle', iteration: 2, outerLoops: [{ id: 'build', iteration: 1, stage: '02-b' }] },
      }));
      expect(result.key).toBe('build@02-b#1/check#2');
    });

    it('names the stage beneath the question', () => {
      expect(fromManualRequest(reqFor('02-b')).subtitle).toBe('stage 2 of 7 · Add API routes');
      expect(fromManualRequest(reqFor('02-b', 2)).subtitle).toBe('stage 2 of 7 · Add API routes · attempt 2 of 3');
      // An agent that predates maxAttempts sends none: no budget to state.
      expect(fromManualRequest(reqFor('02-b', 2, null)).subtitle).toBe('stage 2 of 7 · Add API routes · attempt 2');
    });

    it('has no subtitle outside a stage', () => {
      expect(fromManualRequest(request()).subtitle).toBeUndefined();
    });
  });
});
