import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentClient } from '../agent/client.ts';
import { useAppStore } from '../state/store.ts';
import { EMPTY_APP_STATE } from '../test/app-state.ts';
import type { AppState, RunDraft as WireDraft } from '../shared/protocol.gen.ts';
import {
  applyRemoteDrafts, draftFromWire, draftToWire, flushDraftSave, mergeRemoteDrafts, restoreDraftsAndTabs,
  startDraftSync, tabsToWire, SAVE_DEBOUNCE_MS,
} from './draft-sync.ts';

type Call = { method: string; params: Record<string, unknown> };

/** A client that records what it is asked and answers `reply` (or ok). */
function fakeClient(reply: (method: string, params: Record<string, unknown>) => unknown = () => ({ ok: true })) {
  const calls: Call[] = [];
  const client = {
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return reply(method, params);
    }),
  } as unknown as AgentClient;
  return { client, calls, of: (method: string) => calls.filter(call => call.method === method) };
}

function wire(id: string, patch: Partial<WireDraft> = {}): WireDraft {
  return {
    id, workdir: '/ws', inputs: {}, dryRun: false, attachments: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...patch,
  };
}

function reset(): void {
  useAppStore.setState({
    workspacePath: '/ws', workflows: [], appState: { ...EMPTY_APP_STATE }, drafts: {}, tabs: [], activeTabKey: null, jobs: {},
  });
}

describe('draft and tab wire conversion', () => {
  it('round-trips every field a draft holds', () => {
    const draft = {
      id: 'd1', workdir: '/ws', identityKey: 'k', workflowRef: 'global:ship', values: { a: '1' }, name: 'n', dryRun: true,
      worktreeChoice: false, maxIterationsRaw: '3', baselineValues: {},
      attachments: [{ key: 0, path: '/f' }, { key: 1, path: '/stash/pasted-1.png', pasted: true }],
      createdAt: Date.parse('2026-01-01T00:00:00Z'), updatedAt: Date.parse('2026-01-02T00:00:00Z'),
    };
    expect(draftFromWire(draftToWire(draft))).toEqual(draft);
  });

  it('leaves out what is unset, so absence means the workflow default', () => {
    const saved = draftToWire(draftFromWire(wire('d1')));
    expect(saved).not.toHaveProperty('workflow');
    expect(saved).not.toHaveProperty('name');
    expect(saved).not.toHaveProperty('worktree');
    expect(saved).not.toHaveProperty('maxIterations');
  });

  it('saves run tabs by runId, finding it through the job, and drops one that has none yet', () => {
    const wireTabs = tabsToWire({
      tabs: [
        { kind: 'run', key: 'r1', workdir: '/ws', runId: 'r1', preview: true },
        { kind: 'draft', key: 'd1' },
        { kind: 'run', key: 'j2', workdir: '/ws', identityKey: 'k', jobId: 'j2', preview: false },
        { kind: 'run', key: 'j3', workdir: '/ws', jobId: 'j3', preview: false },
      ],
      activeTabKey: 'j2',
    }, { j2: { runId: 'r2' } });
    expect(wireTabs).toEqual({
      tabs: [
        { kind: 'run', workdir: '/ws', runId: 'r1', preview: true },
        { kind: 'draft', draftId: 'd1' },
        { kind: 'run', workdir: '/ws', identityKey: 'k', runId: 'r2', preview: false },
      ],
      active: 'r2',
    });
  });

  it('saves no active key when the active tab is not saved', () => {
    expect(tabsToWire({ tabs: [{ kind: 'run', key: 'j3', workdir: '/ws', jobId: 'j3', preview: false }], activeTabKey: 'j3' }, {}))
      .toEqual({ tabs: [], active: null });
  });
});

describe('restoreDraftsAndTabs', () => {
  const state = (patch: Partial<AppState>): AppState => ({
    ...EMPTY_APP_STATE,
    recentWorkspaces: [{ path: '/ws', lastOpenedAt: '1' }, { path: '/other', lastOpenedAt: '1' }],
    ...patch,
  });
  const runs = (byWorkdir: Record<string, string[]>) => fakeClient((method, params) => {
    const ids = byWorkdir[params.workdir as string];
    if (ids === undefined) throw new Error('no such workspace');
    return ids.map(runId => ({ runId }));
  });

  it('brings back run tabs in order with their preview state, and the same active one', async () => {
    const { client } = runs({ '/ws': ['r1', 'r2', 'r3'] });
    const restored = await restoreDraftsAndTabs(client, state({
      runTabs: {
        tabs: [
          { kind: 'run', workdir: '/ws', runId: 'r2', preview: false },
          { kind: 'run', workdir: '/ws', runId: 'r1', preview: true },
        ],
        active: 'r1',
      },
    }));
    expect(restored.tabs).toEqual([
      { kind: 'run', key: 'r2', workdir: '/ws', runId: 'r2', preview: false },
      { kind: 'run', key: 'r1', workdir: '/ws', runId: 'r1', preview: true },
    ]);
    expect(restored.activeTabKey).toBe('r1');
  });

  it('drops a run that is gone, and falls back to the Runs tab when it was the active one', async () => {
    const { client } = runs({ '/ws': ['r1'] });
    const restored = await restoreDraftsAndTabs(client, state({
      runTabs: {
        tabs: [
          { kind: 'run', workdir: '/ws', runId: 'r1', preview: false },
          { kind: 'run', workdir: '/ws', runId: 'deleted', preview: false },
        ],
        active: 'deleted',
      },
    }));
    expect(restored.tabs.map(tab => tab.key)).toEqual(['r1']);
    expect(restored.activeTabKey).toBeNull();
  });

  it('drops a run tab whose workspace is no longer known, without asking the agent about it', async () => {
    const { client, of } = runs({ '/gone': ['r9'], '/ws': [] });
    const restored = await restoreDraftsAndTabs(client, state({
      runTabs: { tabs: [{ kind: 'run', workdir: '/gone', runId: 'r9', preview: false }], active: 'r9' },
    }));
    expect(restored.tabs).toEqual([]);
    expect(restored.activeTabKey).toBeNull();
    expect(of('listRuns')).toEqual([]);
  });

  it('drops the tabs of a workspace the agent cannot list', async () => {
    const { client } = runs({ '/ws': ['r1'] }); // /other throws
    const restored = await restoreDraftsAndTabs(client, state({
      runTabs: {
        tabs: [
          { kind: 'run', workdir: '/other', runId: 'r5', preview: false },
          { kind: 'run', workdir: '/ws', runId: 'r1', preview: false },
        ],
        active: 'r1',
      },
    }));
    expect(restored.tabs.map(tab => tab.key)).toEqual(['r1']);
  });

  it('lists a workspace once however many of its tabs there are', async () => {
    const { client, of } = runs({ '/ws': ['r1', 'r2'] });
    await restoreDraftsAndTabs(client, state({
      runTabs: {
        tabs: [
          { kind: 'run', workdir: '/ws', runId: 'r1', preview: false },
          { kind: 'run', workdir: '/ws', runId: 'r2', preview: false },
        ],
        active: null,
      },
    }));
    expect(of('listRuns')).toHaveLength(1);
  });

  it('restores drafts with their tabs, drops a draft tab with no saved draft, and gives an orphan draft a tab', async () => {
    const { client } = runs({});
    const restored = await restoreDraftsAndTabs(client, state({
      runDrafts: [wire('d1', { name: 'one' }), wire('orphan')],
      runTabs: {
        tabs: [{ kind: 'draft', draftId: 'd1' }, { kind: 'draft', draftId: 'lost' }],
        active: 'lost',
      },
    }));
    expect(Object.keys(restored.drafts)).toEqual(['d1', 'orphan']);
    expect(restored.drafts.d1).toMatchObject({ name: 'one' });
    expect(restored.tabs).toEqual([{ kind: 'draft', key: 'd1' }, { kind: 'draft', key: 'orphan' }]);
    expect(restored.activeTabKey).toBeNull();
  });

  it('keeps a draft tab active and a pasted attachment on its draft', async () => {
    const { client } = runs({});
    const restored = await restoreDraftsAndTabs(client, state({
      runDrafts: [wire('d1', { attachments: [{ path: '/stash/d1/pasted-1.png', pasted: true }] })],
      runTabs: { tabs: [{ kind: 'draft', draftId: 'd1' }], active: 'd1' },
    }));
    expect(restored.activeTabKey).toBe('d1');
    expect(restored.drafts.d1!.attachments).toEqual([{ key: 0, path: '/stash/d1/pasted-1.png', pasted: true }]);
  });
});

describe('mergeRemoteDrafts', () => {
  const local = (updatedAt: number, name = 'local') => ({ ...draftFromWire(wire('d1')), name, updatedAt });
  const remote = (updatedAt: string) => wire('d1', { name: 'remote', updatedAt });
  const none = new Set<string>();

  it('takes the newer copy', () => {
    const merged = mergeRemoteDrafts({ d1: local(1000) }, [remote('2026-01-01T00:00:05.000Z')], none, none);
    expect(merged?.d1?.name).toBe('remote');
  });

  it('keeps the local copy when it is newer or equal, which is also how its own echo is ignored', () => {
    const mine = local(Date.parse('2026-01-01T00:00:05.000Z'));
    expect(mergeRemoteDrafts({ d1: mine }, [remote('2026-01-01T00:00:05.000Z')], none, none)).toBeNull();
    expect(mergeRemoteDrafts({ d1: mine }, [remote('2026-01-01T00:00:01.000Z')], none, none)).toBeNull();
  });

  it('keeps the local copy of a draft being edited here, even when the other one is newer', () => {
    expect(mergeRemoteDrafts({ d1: local(1000) }, [remote('2026-01-01T00:00:05.000Z')], new Set(['d1']), none)).toBeNull();
  });

  it('does not bring back a draft just deleted here, and adopts one only the other client has', () => {
    expect(mergeRemoteDrafts({}, [remote('2026-01-01T00:00:05.000Z')], none, new Set(['d1']))).toBeNull();
    expect(Object.keys(mergeRemoteDrafts({}, [remote('2026-01-01T00:00:05.000Z')], none, none) ?? {})).toEqual(['d1']);
  });
});

describe('startDraftSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reset();
  });
  afterEach(() => {
    vi.useRealTimers();
    reset();
  });

  function newDraft(): string {
    return useAppStore.getState().createDraft({ workdir: '/ws' });
  }

  it('saves once after a pause, not on every keystroke', () => {
    const { client, of } = fakeClient();
    const sync = startDraftSync(client);
    const id = newDraft();
    for (const text of ['a', 'ab', 'abc']) {
      useAppStore.getState().updateDraft(id, { name: text });
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 100);
    }
    expect(of('saveRunDraft')).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(of('saveRunDraft')).toHaveLength(1);
    expect(of('saveRunDraft')[0]!.params).toMatchObject({ draft: { id, name: 'abc' } });
    vi.advanceTimersByTime(10 * SAVE_DEBOUNCE_MS);
    expect(of('saveRunDraft')).toHaveLength(1);
    sync.dispose();
  });

  it('debounces each draft on its own', () => {
    const { client, of } = fakeClient();
    const sync = startDraftSync(client);
    const a = newDraft();
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 100);
    const b = newDraft();
    vi.advanceTimersByTime(100);
    expect(of('saveRunDraft').map(call => (call.params.draft as WireDraft).id)).toEqual([a]);
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    expect(of('saveRunDraft').map(call => (call.params.draft as WireDraft).id)).toEqual([a, b]);
    sync.dispose();
  });

  it('flushes a draft at once on request, and then not again when the timer would have fired', () => {
    const { client, of } = fakeClient();
    const sync = startDraftSync(client);
    const id = newDraft();
    flushDraftSave(id);
    expect(of('saveRunDraft')).toHaveLength(1);
    flushDraftSave(id); // nothing pending
    vi.advanceTimersByTime(10 * SAVE_DEBOUNCE_MS);
    expect(of('saveRunDraft')).toHaveLength(1);
    sync.dispose();
  });

  it('flushes the pending drafts when the active tab changes', () => {
    const { client, of } = fakeClient();
    const sync = startDraftSync(client);
    const id = newDraft();
    useAppStore.getState().openDraftTab(id);
    expect(of('saveRunDraft')).toHaveLength(1); // opening activated the tab
    useAppStore.getState().updateDraft(id, { name: 'typed' });
    useAppStore.getState().activateTab(null);
    expect(of('saveRunDraft')).toHaveLength(2);
    expect(of('saveRunDraft')[1]!.params).toMatchObject({ draft: { name: 'typed' } });
    sync.dispose();
  });

  it('deletes a draft when it goes, at once, and never saves it after', () => {
    const { client, of } = fakeClient();
    const sync = startDraftSync(client);
    const id = newDraft();
    useAppStore.getState().updateDraft(id, { name: 'x' });
    useAppStore.getState().discardDraft(id);
    expect(of('deleteRunDraft')).toEqual([{ method: 'deleteRunDraft', params: { id } }]);
    vi.advanceTimersByTime(10 * SAVE_DEBOUNCE_MS);
    expect(of('saveRunDraft')).toHaveLength(0);
    sync.dispose();
  });

  it('deletes the draft once its start converts the tab', () => {
    const { client, of } = fakeClient();
    const sync = startDraftSync(client);
    const id = newDraft();
    useAppStore.getState().openDraftTab(id);
    useAppStore.getState().convertDraftTab(id, { workdir: '/ws', jobId: 'j1' });
    expect(of('deleteRunDraft')).toHaveLength(1);
    expect(useAppStore.getState().tabs).toMatchObject([{ kind: 'run', jobId: 'j1' }]);
    sync.dispose();
  });

  it('saves the tab layout after a pause, once for a burst, and skips an unchanged one', () => {
    const { client, of } = fakeClient();
    const sync = startDraftSync(client);
    const { openRunTab, activateTab } = useAppStore.getState();
    openRunTab({ workdir: '/ws', runId: 'r1' }, { pin: true });
    openRunTab({ workdir: '/ws', runId: 'r2' }, { pin: false });
    expect(of('setRunTabs')).toHaveLength(0);
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    expect(of('setRunTabs')).toHaveLength(1);
    expect(of('setRunTabs')[0]!.params).toEqual({
      runTabs: {
        tabs: [
          { kind: 'run', workdir: '/ws', runId: 'r1', preview: false },
          { kind: 'run', workdir: '/ws', runId: 'r2', preview: true },
        ],
        active: 'r2',
      },
    });
    activateTab('r2'); // already active: no change to save
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    expect(of('setRunTabs')).toHaveLength(1);
    sync.dispose();
  });

  it('counts what is in the store when it starts as saved', () => {
    const id = newDraft();
    const { client, calls } = fakeClient();
    const sync = startDraftSync(client);
    vi.advanceTimersByTime(10 * SAVE_DEBOUNCE_MS);
    expect(calls).toEqual([]);
    useAppStore.getState().updateDraft(id, { name: 'x' });
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
    sync.dispose();
  });

  it('swallows a failed save', async () => {
    const { client } = fakeClient(() => { throw new Error('disk full'); });
    const sync = startDraftSync(client);
    newDraft();
    expect(() => vi.advanceTimersByTime(SAVE_DEBOUNCE_MS)).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    sync.dispose();
  });

  it('stops saving once disposed', () => {
    const { client, calls } = fakeClient();
    startDraftSync(client).dispose();
    newDraft();
    vi.advanceTimersByTime(10 * SAVE_DEBOUNCE_MS);
    expect(calls).toEqual([]);
  });

  describe('a change from another client', () => {
    const remoteState = (...drafts: WireDraft[]): AppState => ({ ...EMPTY_APP_STATE, runDrafts: drafts });

    it('shows the newer copy, and does not save it back', () => {
      const id = newDraft();
      const { client, calls } = fakeClient();
      const sync = startDraftSync(client);
      const later = new Date(Date.now() + 60_000).toISOString();
      applyRemoteDrafts(remoteState(wire(id, { name: 'from the browser', updatedAt: later })));
      expect(useAppStore.getState().drafts[id]!.name).toBe('from the browser');
      vi.advanceTimersByTime(10 * SAVE_DEBOUNCE_MS);
      expect(calls).toEqual([]);
      sync.dispose();
    });

    it('leaves a draft this client is mid-edit on alone', () => {
      const { client, of } = fakeClient();
      const sync = startDraftSync(client);
      const id = newDraft();
      useAppStore.getState().updateDraft(id, { name: 'typing' });
      const later = new Date(Date.now() + 60_000).toISOString();
      applyRemoteDrafts(remoteState(wire(id, { name: 'from the browser', updatedAt: later })));
      expect(useAppStore.getState().drafts[id]!.name).toBe('typing');
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
      expect(of('saveRunDraft')[0]!.params).toMatchObject({ draft: { name: 'typing' } });
      sync.dispose();
    });

    it('takes the remote copy once the local edit has been saved', () => {
      const { client } = fakeClient();
      const sync = startDraftSync(client);
      const id = newDraft();
      useAppStore.getState().updateDraft(id, { name: 'typing' });
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
      const later = new Date(Date.now() + 60_000).toISOString();
      applyRemoteDrafts(remoteState(wire(id, { name: 'from the browser', updatedAt: later })));
      expect(useAppStore.getState().drafts[id]!.name).toBe('from the browser');
      sync.dispose();
    });

    it('ignores an older copy, and gives a draft only the other client has a tab here', () => {
      const id = newDraft();
      const { client } = fakeClient();
      const sync = startDraftSync(client);
      applyRemoteDrafts(remoteState(wire(id, { name: 'stale', updatedAt: '2000-01-01T00:00:00.000Z' }), wire('theirs')));
      expect(useAppStore.getState().drafts[id]!.name).toBe('');
      expect(Object.keys(useAppStore.getState().drafts)).toEqual([id, 'theirs']);
      expect(useAppStore.getState().tabs).toEqual([{ kind: 'draft', key: 'theirs' }]);
      expect(useAppStore.getState().activeTabKey).toBeNull();
      sync.dispose();
    });
  });
});
