import { describe, expect, it } from 'vitest';
import { buildRunTree } from './run-tree.ts';
import { runBands } from './run-bands.ts';
import type { StepState } from '../state/store.ts';
import { step } from '../test/step-fixture.ts';

const leaf = (id: string): StepState => step({ id, status: 'done' });
const stages = (id: string): StepState => step({ id, kind: 'stages', status: 'done', total: 1 });

/** The bands of a run whose top level is `rows`, as `kind:key1,key2` strings. */
function shape(...rows: StepState[]): string[] {
  return runBands(buildRunTree(rows)).map(band => (
    band.kind === 'block' ? `block:${band.node.key}` : `inline:${band.nodes.map(n => n.key).join(',')}`
  ));
}

describe('runBands', () => {
  it('puts a run of only leaves in one band', () => {
    expect(shape(leaf('a'), leaf('b'), leaf('c'))).toEqual(['inline:a,b,c']);
  });

  it('makes no empty band before a leading stages step', () => {
    expect(shape(stages('build'), leaf('push'))).toEqual(['block:build', 'inline:push']);
  });

  it('gives two adjacent stages steps a block each and nothing between them', () => {
    expect(shape(stages('build'), stages('ship'))).toEqual(['block:build', 'block:ship']);
  });

  it('splits leaves around a stages step into two bands', () => {
    expect(shape(leaf('a'), leaf('b'), leaf('c'), stages('build'), leaf('push')))
      .toEqual(['inline:a,b,c', 'block:build', 'inline:push']);
  });

  it('keeps a loop in the inline band with its neighbours', () => {
    const rows = [leaf('a'), step({ id: 'cycle', kind: 'loop', status: 'done' }), leaf('b')];
    expect(shape(...rows)).toEqual(['inline:a,cycle,b']);
  });

  it('keys each band by its first node', () => {
    const bands = runBands(buildRunTree([leaf('a'), leaf('b'), stages('build'), leaf('push')]));
    expect(bands.map(band => band.key)).toEqual(['a', 'build', 'push']);
  });

  it('is empty for an empty run', () => {
    expect(runBands([])).toEqual([]);
  });
});
