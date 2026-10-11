import { describe, expect, it } from 'vitest';
import {
  EMPTY_TABS, isPreview, activateTab, adoptRunIds, closeTab, convertDraftTab, openDraftTab, openTab, pinTab, retargetTab, type RunTabTarget, type TabsState,
} from './run-tabs.ts';

const W = '/work/a';
const run = (runId: string, workdir = W): RunTabTarget => ({ workdir, runId });

function open(state: TabsState, target: RunTabTarget, pin = false): TabsState {
  return openTab(state, target, { pin });
}
const keys = (state: TabsState): string[] => state.tabs.map(tab => tab.key);

describe('openTab', () => {
  it('adds a preview tab and activates it', () => {
    const state = open(EMPTY_TABS, run('r1'));
    expect(state.tabs).toMatchObject([{ key: 'r1', preview: true }]);
    expect(state.activeTabKey).toBe('r1');
  });

  it('reuses the one preview tab, in place, for the next un-pinned open', () => {
    let state = open(EMPTY_TABS, run('r1'));
    state = open(state, run('r2'));
    expect(keys(state)).toEqual(['r2']);
    expect(state.activeTabKey).toBe('r2');
  });

  it('adds a pinned tab and leaves an existing preview alone', () => {
    let state = open(EMPTY_TABS, run('r1'));
    state = open(state, run('r2'), true);
    expect(state.tabs.map(tab => [tab.key, isPreview(tab)])).toEqual([['r1', true], ['r2', false]]);
  });

  it('focuses the tab a run already has and adds no duplicate', () => {
    let state = open(EMPTY_TABS, run('r1'), true);
    state = open(state, run('r2'), true);
    state = open(state, run('r1'));
    expect(keys(state)).toEqual(['r1', 'r2']);
    expect(state.activeTabKey).toBe('r1');
    expect(isPreview(state.tabs[0]!)).toBe(false);
  });

  it('pins an existing preview tab when opened with pin', () => {
    let state = open(EMPTY_TABS, run('r1'));
    state = open(state, run('r1'), true);
    expect(state.tabs).toMatchObject([{ key: 'r1', preview: false }]);
  });

  it('keeps an existing preview tab a preview when re-opened without pin', () => {
    let state = open(EMPTY_TABS, run('r1'));
    state = open(state, run('r1'));
    expect(isPreview(state.tabs[0]!)).toBe(true);
  });

  it('adds a new preview after the active tab, beside a pinned one', () => {
    let state = open(EMPTY_TABS, run('r1'), true);
    state = open(state, run('r2'), true);
    state = activateTab(state, 'r1');
    state = open(state, run('r3'));
    expect(keys(state)).toEqual(['r1', 'r3', 'r2']);
  });

  it('opens first when the Runs tab is active', () => {
    let state = open(EMPTY_TABS, run('r1'), true);
    state = activateTab(state, null);
    state = open(state, run('r2'), true);
    expect(keys(state)).toEqual(['r2', 'r1']);
  });

  it('never holds more than one preview tab', () => {
    let state = EMPTY_TABS;
    for (const id of ['a', 'b', 'c']) state = open(state, run(id));
    state = open(state, run('d'), true);
    state = open(state, run('e'));
    state = open(state, run('f'));
    expect(state.tabs.filter(tab => isPreview(tab))).toHaveLength(1);
  });

  it('treats the same runId in another workspace as another run', () => {
    let state = open(EMPTY_TABS, run('r1'), true);
    state = open(state, run('r1', '/work/b'), true);
    expect(state.tabs).toHaveLength(2);
  });

  it('keys a just-started run by its jobId', () => {
    const state = open(EMPTY_TABS, { workdir: W, jobId: 'j1' }, true);
    expect(state.tabs).toMatchObject([{ key: 'j1', jobId: 'j1' }]);
  });

  it('ignores a target with neither runId nor jobId', () => {
    expect(open(EMPTY_TABS, { workdir: W })).toBe(EMPTY_TABS);
  });
});

describe('pinTab', () => {
  it('turns a preview tab into a pinned one', () => {
    const state = pinTab(open(EMPTY_TABS, run('r1')), 'r1');
    expect(isPreview(state.tabs[0]!)).toBe(false);
  });

  it('leaves state untouched for an unknown key', () => {
    const state = open(EMPTY_TABS, run('r1'));
    expect(pinTab(state, 'nope')).toBe(state);
  });

  it('lets the next un-pinned open add a fresh preview beside it', () => {
    let state = pinTab(open(EMPTY_TABS, run('r1')), 'r1');
    state = open(state, run('r2'));
    expect(state.tabs.map(tab => [tab.key, isPreview(tab)])).toEqual([['r1', false], ['r2', true]]);
  });
});

describe('closeTab', () => {
  const three = (): TabsState => {
    let state = EMPTY_TABS;
    for (const id of ['a', 'b', 'c']) state = open(state, run(id), true);
    return state;
  };

  it('activates the right neighbour of the closed active tab', () => {
    const state = closeTab(activateTab(three(), 'b'), 'b');
    expect(keys(state)).toEqual(['a', 'c']);
    expect(state.activeTabKey).toBe('c');
  });

  it('falls back to the left neighbour when there is none on the right', () => {
    const state = closeTab(three(), 'c');
    expect(state.activeTabKey).toBe('b');
  });

  it('falls back to the Runs tab when it was the last one', () => {
    const state = closeTab(open(EMPTY_TABS, run('a')), 'a');
    expect(state).toEqual({ tabs: [], activeTabKey: null });
  });

  it('keeps the active tab when another one is closed', () => {
    const state = closeTab(three(), 'a');
    expect(state.activeTabKey).toBe('c');
  });

  it('ignores an unknown key', () => {
    const state = three();
    expect(closeTab(state, 'nope')).toBe(state);
  });
});

describe('activateTab', () => {
  it('activates the Runs tab with null', () => {
    expect(activateTab(open(EMPTY_TABS, run('a')), null).activeTabKey).toBeNull();
  });

  it('ignores a key with no tab', () => {
    const state = open(EMPTY_TABS, run('a'));
    expect(activateTab(state, 'nope')).toBe(state);
  });
});

describe('retargetTab', () => {
  it('re-keys a job-only tab once its runId is known, in place and still active', () => {
    let state = open(EMPTY_TABS, run('x'), true);
    state = open(state, { workdir: W, jobId: 'j1' });
    state = retargetTab(state, 'j1', { workdir: W, jobId: 'j1', runId: 'r9' });
    expect(keys(state)).toEqual(['x', 'r9']);
    expect(state.activeTabKey).toBe('r9');
    expect(state.tabs[1]).toMatchObject({ jobId: 'j1', runId: 'r9', preview: true });
  });

  it('points a resumed tab at the new job without adding a tab', () => {
    let state = open(EMPTY_TABS, { workdir: W, jobId: 'j1', runId: 'r1' }, true);
    state = retargetTab(state, 'r1', { workdir: W, jobId: 'j2', runId: 'r1' });
    expect(state.tabs).toMatchObject([{ key: 'r1', jobId: 'j2', preview: false }]);
    expect(state.activeTabKey).toBe('r1');
  });

  it('merges into the earlier tab when the new key is already open', () => {
    let state = open(EMPTY_TABS, run('r1'), true);
    state = open(state, { workdir: W, jobId: 'j1' }, true);
    state = retargetTab(state, 'j1', { workdir: W, jobId: 'j1', runId: 'r1' });
    expect(keys(state)).toEqual(['r1']);
    expect(state.activeTabKey).toBe('r1');
    expect(state.tabs[0]).toMatchObject({ runId: 'r1', jobId: 'j1' });
  });

  it('ignores an unknown key', () => {
    const state = open(EMPTY_TABS, run('a'));
    expect(retargetTab(state, 'nope', run('b'))).toBe(state);
  });
});

describe('adoptRunIds', () => {
  it('gives a job-only tab its job\'s runId so a runId open finds it', () => {
    let state = open(EMPTY_TABS, { workdir: W, jobId: 'j1' }, true);
    state = adoptRunIds(state, { j1: { runId: 'r1' } });
    state = open(state, run('r1'));
    expect(keys(state)).toEqual(['r1']);
  });

  it('leaves tabs alone while their job has no runId', () => {
    const state = open(EMPTY_TABS, { workdir: W, jobId: 'j1' }, true);
    expect(adoptRunIds(state, { j1: {} })).toBe(state);
  });
});

describe('draft tabs', () => {
  it('opens right of the active tab and activates', () => {
    let state = open(EMPTY_TABS, run('r1'), true);
    state = open(state, run('r2'), true);
    state = activateTab(state, 'r1');
    state = openDraftTab(state, 'd1');
    expect(keys(state)).toEqual(['r1', 'd1', 'r2']);
    expect(state.activeTabKey).toBe('d1');
  });

  it('activates an already open draft instead of adding another', () => {
    let state = openDraftTab(EMPTY_TABS, 'd1');
    state = activateTab(open(state, run('r1'), true), 'd1');
    expect(openDraftTab(state, 'd1')).toBe(state);
  });

  it('is never the preview, and is left alone by the next un-pinned open', () => {
    let state = openDraftTab(EMPTY_TABS, 'd1');
    expect(isPreview(state.tabs[0]!)).toBe(false);
    state = open(state, run('r1'));
    state = open(state, run('r2'));
    expect(keys(state)).toEqual(['d1', 'r2']);
  });

  it('converts to a pinned run tab at the same position, keeping it active', () => {
    let state = open(EMPTY_TABS, run('r1'), true);
    state = openDraftTab(state, 'd1');
    state = open(state, run('r2'), true);
    state = activateTab(state, 'd1');
    state = convertDraftTab(state, 'd1', { workdir: W, jobId: 'j1' });
    expect(keys(state)).toEqual(['r1', 'j1', 'r2']);
    expect(state.tabs[1]).toMatchObject({ kind: 'run', jobId: 'j1', preview: false });
    expect(state.activeTabKey).toBe('j1');
  });

  it('leaves the active tab alone when converting a draft that is not active', () => {
    let state = openDraftTab(EMPTY_TABS, 'd1');
    state = open(state, run('r1'), true);
    state = convertDraftTab(state, 'd1', { workdir: W, jobId: 'j1' });
    expect(state.activeTabKey).toBe('r1');
  });

  it('ignores an unknown draft, and a target with no run or job', () => {
    const state = openDraftTab(EMPTY_TABS, 'd1');
    expect(convertDraftTab(state, 'nope', { workdir: W, jobId: 'j1' })).toBe(state);
    expect(convertDraftTab(state, 'd1', { workdir: W })).toBe(state);
  });

  it('is skipped by retarget and adoptRunIds', () => {
    const state = openDraftTab(EMPTY_TABS, 'd1');
    expect(retargetTab(state, 'd1', run('r1'))).toBe(state);
    expect(adoptRunIds(state, { d1: { runId: 'r1' } })).toBe(state);
  });
});
