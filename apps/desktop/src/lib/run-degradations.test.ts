import { describe, expect, it } from 'vitest';
import { addDegradation, mergeDegradations } from './run-degradations.ts';

describe('addDegradation', () => {
  it('appends a new (capability, stepId)', () => {
    const one = addDegradation(undefined, { capability: 'diff', reason: 'no git', stepId: 'a', at: 't1' });
    const two = addDegradation(one, { capability: 'diff', reason: 'no git', stepId: 'b', at: 't2' });
    expect(two.map(d => d.stepId)).toEqual(['a', 'b']);
  });

  it('keeps the first report of a repeated (capability, stepId) and returns the same list', () => {
    const one = addDegradation(undefined, { capability: 'diff', reason: 'first', stepId: 'a', at: 't1' });
    expect(addDegradation(one, { capability: 'diff', reason: 'second', stepId: 'a', at: 't2' })).toBe(one);
  });

  it('treats a run-level and a step-level entry of one capability as different facts', () => {
    const one = addDegradation(undefined, { capability: 'diff', reason: 'r', at: 't1' });
    expect(addDegradation(one, { capability: 'diff', reason: 'r', stepId: 'a', at: 't2' })).toHaveLength(2);
  });
});

describe('mergeDegradations', () => {
  it('is empty with nothing on disk and nothing live', () => {
    expect(mergeDegradations(undefined, undefined)).toEqual([]);
  });

  it('does not double-count what the manifest and the live job both report', () => {
    const persisted = [{ capability: 'git-guard', reason: 'not a repo', at: 't1' }];
    const live = [
      { capability: 'git-guard', reason: 'not a repo', at: 't1' },
      { capability: 'hooks', reason: 'dropped', stepId: 's', at: 't2' },
    ];
    expect(mergeDegradations(persisted, live).map(d => d.capability)).toEqual(['git-guard', 'hooks']);
  });

  it('ignores a persisted value that is not the expected shape', () => {
    expect(mergeDegradations('nope', undefined)).toEqual([]);
    expect(mergeDegradations([null, { capability: 3 }, { capability: 'diff', reason: 'r', at: 't' }], undefined))
      .toEqual([{ capability: 'diff', reason: 'r', at: 't' }]);
  });
});
