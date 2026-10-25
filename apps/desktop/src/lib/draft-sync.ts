/**
 * Keeps the agent's copy of the New-run drafts and the run tabs in step with
 * the store: debounced saves while editing, an immediate flush when a draft is
 * about to start or its tab is left, a delete when a draft goes, and a merge
 * of drafts another client edited. App state is a convenience cache, so every
 * failure is swallowed, as `setUiState`'s are.
 *
 * The pure halves (wire conversion, restore, merge) are exported on their own
 * so they can be tested without timers or a store.
 */
import type { AgentClient } from '../agent/client.ts';
import { useAppStore, type RunDraft } from '../state/store.ts';
import { sameWorkspace } from '../shared/path-form.ts';
import type {
  AppState as AppStateData, RunDraft as WireRunDraft, RunTabsState,
} from '../shared/protocol.gen.ts';
import type { AnyTab, RunTab, TabsState } from './run-tabs.ts';

/** How long after the last edit a draft or the tab layout is saved. */
export const SAVE_DEBOUNCE_MS = 500;

export function draftToWire(draft: RunDraft): WireRunDraft {
  return {
    id: draft.id,
    workdir: draft.workdir,
    ...(draft.identityKey === undefined ? {} : { identityKey: draft.identityKey }),
    ...(draft.workflowRef === null ? {} : { workflow: draft.workflowRef }),
    inputs: draft.values,
    ...(draft.name === '' ? {} : { name: draft.name }),
    dryRun: draft.dryRun,
    ...(draft.worktreeChoice === null ? {} : { worktree: draft.worktreeChoice }),
    ...(draft.continueIn === undefined ? {} : { continueIn: draft.continueIn }),
    ...(draft.subdir === undefined ? {} : { subdir: draft.subdir }),
    ...(draft.maxIterationsRaw === '' ? {} : { maxIterations: draft.maxIterationsRaw }),
    attachments: draft.attachments.map(item => ({ path: item.path, ...(item.pasted ? { pasted: true } : {}) })),
    createdAt: new Date(draft.createdAt).toISOString(),
    updatedAt: new Date(draft.updatedAt).toISOString(),
  };
}

/**
 * The wire does not carry `baselineValues`, so a restored draft counts every
 * non-empty input as typed: closing it asks first, which errs on the side of
 * not losing an edit.
 */
export function draftFromWire(wire: WireRunDraft): RunDraft {
  return {
    id: wire.id,
    workdir: wire.workdir,
    ...(wire.identityKey === undefined ? {} : { identityKey: wire.identityKey }),
    workflowRef: wire.workflow ?? null,
    values: wire.inputs,
    name: wire.name ?? '',
    dryRun: wire.dryRun,
    worktreeChoice: wire.worktree ?? null,
    ...(wire.continueIn === undefined ? {} : { continueIn: wire.continueIn }),
    ...(wire.subdir === undefined ? {} : { subdir: wire.subdir }),
    maxIterationsRaw: wire.maxIterations ?? '',
    attachments: wire.attachments.map((item, key) => ({ key, path: item.path, ...(item.pasted ? { pasted: true } : {}) })),
    baselineValues: {},
    createdAt: timeOf(wire.createdAt),
    updatedAt: timeOf(wire.updatedAt),
  };
}

function timeOf(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * The tab layout as the agent stores it. A run tab is saved by its runId, found
 * through its job when the tab only knows that; one with neither is left out,
 * and so is an active key that goes with it.
 */
export function tabsToWire(
  state: TabsState, jobs: Record<string, { runId?: string | undefined }>,
): RunTabsState {
  const tabs: RunTabsState['tabs'] = [];
  let active: string | null = null;
  for (const tab of state.tabs) {
    if (tab.kind === 'draft') {
      tabs.push({ kind: 'draft', draftId: tab.key });
      if (tab.key === state.activeTabKey) active = tab.key;
      continue;
    }
    const runId = tab.runId ?? (tab.jobId === undefined ? undefined : jobs[tab.jobId]?.runId);
    if (runId === undefined) continue;
    tabs.push({
      kind: 'run',
      workdir: tab.workdir,
      ...(tab.identityKey === undefined ? {} : { identityKey: tab.identityKey }),
      runId,
      preview: tab.preview,
    });
    if (tab.key === state.activeTabKey) active = runId;
  }
  return { tabs, active };
}

export interface RestoredTabs {
  drafts: Record<string, RunDraft>;
  tabs: AnyTab[];
  activeTabKey: string | null;
}

/**
 * Turns the saved drafts and tabs back into store state. A run tab survives
 * only if its workspace is still known and still lists the run; a draft tab
 * only if its draft was saved; a draft with no tab gets one at the end.
 * Anything that fails to check (a workspace the agent cannot list) is dropped.
 */
export async function restoreDraftsAndTabs(client: AgentClient, state: AppStateData): Promise<RestoredTabs> {
  const drafts: Record<string, RunDraft> = {};
  for (const wire of state.runDrafts) drafts[wire.id] = draftFromWire(wire);

  const runIdsByWorkspace: Array<{ path: string; identityKey: string | undefined; runIds: Promise<Set<string>> }> = [];
  const knownRuns = (workdir: string, identityKey: string | undefined): Promise<Set<string>> => {
    const where = { path: workdir, identityKey };
    const cached = runIdsByWorkspace.find(entry => sameWorkspace(entry, where));
    if (cached) return cached.runIds;
    const known = state.recentWorkspaces.some(recent => sameWorkspace(recent, where));
    const runIds = known
      ? client.request('listRuns', { workdir }).then(runs => new Set(runs.map(run => run.runId)), () => new Set<string>())
      : Promise.resolve(new Set<string>());
    runIdsByWorkspace.push({ ...where, runIds });
    return runIds;
  };

  const tabs: AnyTab[] = [];
  const seen = new Set<string>();
  for (const ref of state.runTabs.tabs) {
    if (ref.kind === 'draft') {
      if (drafts[ref.draftId] === undefined || seen.has(ref.draftId)) continue;
      seen.add(ref.draftId);
      tabs.push({ kind: 'draft', key: ref.draftId });
      continue;
    }
    if (seen.has(ref.runId) || !(await knownRuns(ref.workdir, ref.identityKey)).has(ref.runId)) continue;
    seen.add(ref.runId);
    const tab: RunTab = { kind: 'run', key: ref.runId, workdir: ref.workdir, runId: ref.runId, preview: ref.preview };
    if (ref.identityKey !== undefined) tab.identityKey = ref.identityKey;
    tabs.push(tab);
  }
  for (const id of Object.keys(drafts)) {
    if (!seen.has(id)) tabs.push({ kind: 'draft', key: id });
  }

  const active = state.runTabs.active;
  return { drafts, tabs, activeTabKey: active !== null && seen.has(active) ? active : null };
}

/**
 * Merges the drafts another client saved into the local ones. The newer
 * `updatedAt` wins; a draft being edited here (`busy`) keeps its local copy,
 * and one just deleted here (`gone`) stays deleted. A draft only the other
 * client has is adopted. Returns the changed map, or null when nothing differs.
 */
export function mergeRemoteDrafts(
  local: Record<string, RunDraft>, remote: readonly WireRunDraft[], busy: ReadonlySet<string>, gone: ReadonlySet<string>,
): Record<string, RunDraft> | null {
  let merged: Record<string, RunDraft> | null = null;
  for (const wire of remote) {
    if (busy.has(wire.id) || gone.has(wire.id)) continue;
    const mine = local[wire.id];
    if (mine !== undefined && timeOf(wire.updatedAt) <= mine.updatedAt) continue;
    merged ??= { ...local };
    merged[wire.id] = draftFromWire(wire);
  }
  return merged;
}

export interface DraftSync {
  /** Saves `id` now if it has an unsaved edit, or every such draft without an id. */
  flush: (id?: string) => void;
  /** Folds in an `appStateChanged` from the agent. */
  applyRemote: (state: AppStateData) => void;
  dispose: () => void;
}

let active: DraftSync | null = null;

/** The running sync, for callers (the form's Start) that must flush before they act. */
export function flushDraftSave(id: string): void {
  active?.flush(id);
}

/** Routes an `appStateChanged` to the running sync, if there is one. */
export function applyRemoteDrafts(state: AppStateData): void {
  active?.applyRemote(state);
}

/**
 * Starts watching the store. Whatever is in it now counts as already saved, so
 * call it after the restore has filled the store in.
 */
export function startDraftSync(client: AgentClient, debounceMs = SAVE_DEBOUNCE_MS): DraftSync {
  const known = new Map<string, RunDraft>(Object.entries(useAppStore.getState().drafts));
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const deleting = new Set<string>();
  let tabsTimer: ReturnType<typeof setTimeout> | undefined;
  let tabsSaved = JSON.stringify(tabsToWire(useAppStore.getState(), useAppStore.getState().jobs));

  const swallow = (): void => {};

  function saveDraft(id: string): void {
    const timer = timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(id);
    const draft = useAppStore.getState().drafts[id];
    if (draft === undefined) return;
    void client.request('saveRunDraft', { draft: draftToWire(draft) }).catch(swallow);
  }

  function saveTabs(): void {
    if (tabsTimer !== undefined) clearTimeout(tabsTimer);
    tabsTimer = undefined;
    const { tabs, activeTabKey, jobs } = useAppStore.getState();
    const runTabs = tabsToWire({ tabs, activeTabKey }, jobs);
    const encoded = JSON.stringify(runTabs);
    if (encoded === tabsSaved) return;
    tabsSaved = encoded;
    void client.request('setRunTabs', { runTabs }).catch(swallow);
  }

  function scheduleTabs(): void {
    if (tabsTimer !== undefined) clearTimeout(tabsTimer);
    tabsTimer = setTimeout(saveTabs, debounceMs);
  }

  const unsubscribe = useAppStore.subscribe((state, prev) => {
    for (const [id, draft] of Object.entries(state.drafts)) {
      if (known.get(id) === draft) continue;
      known.set(id, draft);
      const timer = timers.get(id);
      if (timer !== undefined) clearTimeout(timer);
      timers.set(id, setTimeout(() => saveDraft(id), debounceMs));
    }
    for (const id of [...known.keys()]) {
      if (state.drafts[id] !== undefined) continue;
      known.delete(id);
      const timer = timers.get(id);
      if (timer !== undefined) clearTimeout(timer);
      timers.delete(id);
      deleting.add(id);
      void client.request('deleteRunDraft', { id }).catch(swallow).finally(() => deleting.delete(id));
    }
    // Leaving a tab is the moment edits are most likely to be left behind.
    if (state.activeTabKey !== prev.activeTabKey) flush();
    // jobs change at the rate of the log, so they matter only to a tab still waiting on its runId.
    const waitingOnJob = state.tabs.some(tab => tab.kind === 'run' && tab.runId === undefined);
    if (state.tabs !== prev.tabs || state.activeTabKey !== prev.activeTabKey || (waitingOnJob && state.jobs !== prev.jobs)) {
      scheduleTabs();
    }
  });

  function flush(id?: string): void {
    for (const pending of id === undefined ? [...timers.keys()] : timers.has(id) ? [id] : []) saveDraft(pending);
  }

  function applyRemote(state: AppStateData): void {
    const store = useAppStore.getState();
    const merged = mergeRemoteDrafts(store.drafts, state.runDrafts, new Set(timers.keys()), deleting);
    if (merged === null) return;
    // Already saved on the other side: mark them known so they are not echoed back.
    const added: string[] = [];
    for (const [id, draft] of Object.entries(merged)) {
      if (store.drafts[id] === draft) continue;
      if (store.drafts[id] === undefined) added.push(id);
      known.set(id, draft);
    }
    useAppStore.setState({
      drafts: merged,
      // A draft only the other client had would otherwise be unreachable here.
      ...(added.length === 0 ? {} : {
        tabs: [...store.tabs, ...added.map(id => ({ kind: 'draft' as const, key: id }))],
      }),
    });
  }

  const onHide = (): void => {
    flush();
    if (tabsTimer !== undefined) saveTabs();
  };
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onHide);

  const sync: DraftSync = {
    flush,
    applyRemote,
    dispose: () => {
      unsubscribe();
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onHide);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      if (tabsTimer !== undefined) clearTimeout(tabsTimer);
      if (active === sync) active = null;
    },
  };
  active = sync;
  return sync;
}
