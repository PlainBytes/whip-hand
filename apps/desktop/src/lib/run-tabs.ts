/**
 * The Runs page's tab model as pure functions over `{ tabs, activeTabKey }`,
 * following VS Code's preview-tab rules. The store wraps these as actions, so
 * every rule is testable without React or a store.
 */
import { sameWorkspace } from '../shared/path-form.ts';

/** What identifies a run in a tab: where it lives, plus the run and/or the job following it. */
export interface RunTabTarget {
  workdir: string;
  identityKey?: string | undefined;
  runId?: string | undefined;
  jobId?: string | undefined;
}

export interface RunTab extends RunTabTarget {
  kind: 'run';
  /** The runId when known, else the jobId — see `tabKey`. */
  key: string;
  /** Italic, and replaced by the next un-pinned open. At most one exists. */
  preview: boolean;
}

/**
 * A new run being filled in; `key` is the draft's id. Always pinned — the
 * preview slot is only ever taken by a run tab.
 */
export interface DraftTab {
  kind: 'draft';
  key: string;
}

export type AnyTab = RunTab | DraftTab;

export interface TabsState {
  tabs: AnyTab[];
  /** null is the fixed Runs list tab, which is not in `tabs`. */
  activeTabKey: string | null;
}

export const EMPTY_TABS: TabsState = { tabs: [], activeTabKey: null };

/** Stable across the job gaining a runId only in that the runId wins once known. */
export function tabKey(target: Pick<RunTabTarget, 'runId' | 'jobId'>): string {
  return target.runId ?? target.jobId ?? '';
}

/** Whether `tab` is the italic, replaceable preview tab. */
export function isPreview(tab: AnyTab): boolean {
  return tab.kind === 'run' && tab.preview;
}

function toTab(target: RunTabTarget, preview: boolean): RunTab {
  const tab: RunTab = { kind: 'run', key: tabKey(target), workdir: target.workdir, preview };
  if (target.identityKey !== undefined) tab.identityKey = target.identityKey;
  if (target.runId !== undefined) tab.runId = target.runId;
  if (target.jobId !== undefined) tab.jobId = target.jobId;
  return tab;
}

/** Whether `tab` already shows the run `target` names: same workspace and the same run or job. */
function matches(tab: RunTab, target: RunTabTarget): boolean {
  if (!sameWorkspace(
    { path: tab.workdir, identityKey: tab.identityKey },
    { path: target.workdir, identityKey: target.identityKey },
  )) return false;
  return (target.runId !== undefined && tab.runId === target.runId)
    || (target.jobId !== undefined && tab.jobId === target.jobId);
}

/** Fills in what an existing tab was missing (a job's runId, say) from a fresher target. */
function merged(tab: RunTab, target: RunTabTarget, preview: boolean): RunTab {
  const next = toTab({
    workdir: tab.workdir,
    identityKey: tab.identityKey ?? target.identityKey,
    runId: target.runId ?? tab.runId,
    // A newer job (a resume) supersedes the one the tab followed.
    jobId: target.jobId ?? tab.jobId,
  }, preview);
  return next;
}

export function openTab(state: TabsState, target: RunTabTarget, opts: { pin: boolean }): TabsState {
  if (tabKey(target) === '') return state;
  const found = state.tabs.findIndex(tab => tab.kind === 'run' && matches(tab, target));
  if (found !== -1) {
    const existing = state.tabs[found] as RunTab;
    const next = merged(existing, target, existing.preview && !opts.pin);
    const tabs = state.tabs.slice();
    tabs[found] = next;
    return { tabs, activeTabKey: next.key };
  }

  const fresh = toTab(target, !opts.pin);
  const tabs = state.tabs.slice();
  const previewAt = opts.pin ? -1 : tabs.findIndex(isPreview);
  if (previewAt !== -1) {
    tabs[previewAt] = fresh;
  } else {
    const activeAt = tabs.findIndex(tab => tab.key === state.activeTabKey);
    // Right of the active tab; the Runs tab is not in the array, so -1 lands first.
    tabs.splice(activeAt + 1, 0, fresh);
  }
  return { tabs, activeTabKey: fresh.key };
}

export function pinTab(state: TabsState, key: string): TabsState {
  if (!state.tabs.some(tab => tab.kind === 'run' && tab.key === key && tab.preview)) return state;
  return { ...state, tabs: state.tabs.map(tab => (tab.kind === 'run' && tab.key === key ? { ...tab, preview: false } : tab)) };
}

/** How many closed tabs `withClosed` remembers. */
export const CLOSED_TABS_LIMIT = 20;

/** The part of a tab that says which run it shows; what reopening needs. */
export function runTabTarget(tab: RunTab): RunTabTarget {
  const target: RunTabTarget = { workdir: tab.workdir };
  if (tab.identityKey !== undefined) target.identityKey = tab.identityKey;
  if (tab.runId !== undefined) target.runId = tab.runId;
  if (tab.jobId !== undefined) target.jobId = tab.jobId;
  return target;
}

/** `closed` with `target` as the newest entry, the oldest dropped past the limit. */
export function withClosed(closed: RunTabTarget[], target: RunTabTarget): RunTabTarget[] {
  return [...closed, target].slice(-CLOSED_TABS_LIMIT);
}

export function closeTab(state: TabsState, key: string): TabsState {
  const at = state.tabs.findIndex(tab => tab.key === key);
  if (at === -1) return state;
  const tabs = state.tabs.filter((_, index) => index !== at);
  if (state.activeTabKey !== key) return { ...state, tabs };
  const neighbour = tabs[at] ?? tabs[at - 1];
  return { tabs, activeTabKey: neighbour?.key ?? null };
}

export function activateTab(state: TabsState, key: string | null): TabsState {
  if (key !== null && !state.tabs.some(tab => tab.key === key)) return state;
  return state.activeTabKey === key ? state : { ...state, activeTabKey: key };
}

/** Opens a tab for a new draft right of the active one and activates it; an existing one is just activated. */
export function openDraftTab(state: TabsState, draftId: string): TabsState {
  if (state.tabs.some(tab => tab.key === draftId)) return activateTab(state, draftId);
  const tabs = state.tabs.slice();
  const activeAt = tabs.findIndex(tab => tab.key === state.activeTabKey);
  tabs.splice(activeAt + 1, 0, { kind: 'draft', key: draftId });
  return { tabs, activeTabKey: draftId };
}

/**
 * Swaps a started draft's tab for the pinned tab of its run, in the same
 * position. The run tab is active only if the draft's was: a start that
 * finishes after the person moved on must not pull them back.
 */
export function convertDraftTab(state: TabsState, draftId: string, target: RunTabTarget): TabsState {
  const at = state.tabs.findIndex(tab => tab.kind === 'draft' && tab.key === draftId);
  if (at === -1 || tabKey(target) === '') return state;
  const fresh = toTab(target, false);
  const wasActive = state.activeTabKey === draftId;
  const tabs = state.tabs.slice();
  tabs[at] = fresh;
  return { tabs, activeTabKey: wasActive ? fresh.key : state.activeTabKey };
}

/**
 * Re-points tab `key` at `target`, keeping its place and pin state. The key
 * follows the target (a job that learns its runId changes it); if that lands
 * on another tab already showing the run, the two are merged into the earlier
 * position so the run never shows twice.
 */
export function retargetTab(state: TabsState, key: string, target: RunTabTarget): TabsState {
  const at = state.tabs.findIndex(tab => tab.key === key);
  if (at === -1 || tabKey(target) === '') return state;
  const old = state.tabs[at]!;
  if (old.kind !== 'run') return state;
  const next = toTab({ ...target, workdir: target.workdir || old.workdir }, old.preview);
  const wasActive = state.activeTabKey === key;

  const other = state.tabs.findIndex((tab, index) => index !== at && tab.key === next.key);
  const tabs = state.tabs.slice();
  if (other === -1) {
    tabs[at] = next;
  } else {
    const keep = Math.min(at, other);
    tabs[keep] = { ...next, preview: old.preview && isPreview(state.tabs[other]!) };
    tabs.splice(Math.max(at, other), 1);
  }
  const otherWasActive = other !== -1 && state.activeTabKey === state.tabs[other]!.key;
  return { tabs, activeTabKey: wasActive || otherWasActive ? next.key : state.activeTabKey };
}

/**
 * Gives job-only tabs the runId their job has since learned, so a later open
 * by runId finds the tab instead of adding a second one for the same run.
 */
export function adoptRunIds(state: TabsState, jobs: Record<string, { runId?: string | undefined }>): TabsState {
  let next = state;
  for (const tab of state.tabs) {
    if (tab.kind !== 'run' || tab.runId !== undefined || tab.jobId === undefined) continue;
    const runId = jobs[tab.jobId]?.runId;
    if (runId !== undefined) next = retargetTab(next, tab.key, { ...tab, runId });
  }
  return next;
}
