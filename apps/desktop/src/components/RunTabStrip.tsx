import { useEffect, useRef, type MouseEvent } from 'react';
import {
  Button, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, Tab, TabList, Text, Tooltip,
} from '@fluentui/react-components';
import { Dismiss12Regular, Edit12Regular, MoreHorizontal20Regular } from '@fluentui/react-icons';
import { useAgentClient } from '../agent/agent-context.tsx';
import { isWaitingJob, useAppStore, type AppState, type JobState } from '../state/store.ts';
import { openWorkspace } from '../lib/workspace-switch.ts';
import type { AnyTab, DraftTab, RunTab } from '../lib/run-tabs.ts';
import { basename } from '../lib/workspace-identity.ts';
import { useShortcut } from '../lib/use-global-shortcut.ts';
import { isModalOpen } from '../lib/tab-shortcuts.ts';
import { actionLabel } from '../lib/keymap/keymap.ts';
import { useKeymap } from '../lib/keymap/use-keymap.ts';
import { RunStatusIcon, stateLabel, type RunStatus } from './OngoingRuns.tsx';
import { WorkspaceDot } from './WorkspaceDot.tsx';
import { isTabHere, tabWorkspace, useDiscardDraft } from './use-discard-draft.tsx';

/** TabList values are strings, so the Runs tab (activeTabKey null) needs one that no run key can be. */
const RUNS_TAB_VALUE = '\u0000runs';

/** The job a tab follows: its own jobId, else the live (or last) job for its run. */
function jobForTab(jobs: Record<string, JobState>, tab: RunTab): JobState | undefined {
  if (tab.jobId !== undefined && jobs[tab.jobId] !== undefined) return jobs[tab.jobId];
  if (tab.runId === undefined) return undefined;
  let finished: JobState | undefined;
  for (const job of Object.values(jobs)) {
    if (job.runId !== tab.runId) continue;
    if (!job.finished) return job;
    finished = job;
  }
  return finished;
}

function statusOf(job: JobState | undefined): RunStatus | null {
  if (job === undefined) return null;
  if (!job.finished) return isWaitingJob(job) ? 'waiting' : 'running';
  return job.errorMessage === undefined ? null : 'failed';
}

/** Middle-click closes the tab. The mousedown half stops the autoscroll cursor Windows and Linux start on it. */
const middleClick = (onClose: () => void) => ({
  onMouseDown: (event: MouseEvent) => { if (event.button === 1) event.preventDefault(); },
  onAuxClick: (event: MouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
    onClose();
  },
});

/** The tab's hover text: full title, then state (runs only), then the workspace. */
const tabTooltip = (title: string, state: string | undefined, workdir: string): string =>
  `${state === undefined ? title : `${title} — ${state}`}${workdir ? ` · ${basename(workdir)}` : ''}`;

/** What the tab says about its run's state: live state, else how it ended. */
function stateOf(job: JobState | undefined): string | undefined {
  if (job === undefined) return undefined;
  if (!job.finished) return stateLabel(job);
  return job.errorMessage === undefined ? 'finished' : 'failed';
}

function CloseButton({ label, onClose }: { label: string; onClose: () => void }) {
  const keymap = useKeymap();
  return (
    <Tooltip content={`Close (${actionLabel(keymap, 'tabs.close')} on the active tab)`} relationship="description">
      {/* A span, not a Button: the Tab is already a <button>, and nesting one is invalid. */}
      <span
        role="button"
        aria-label={`Close ${label}`}
        tabIndex={-1}
        // The Tab underneath would otherwise select itself on the same click.
        onClick={event => { event.stopPropagation(); onClose(); }}
        onDoubleClick={event => event.stopPropagation()}
        style={{ display: 'inline-flex', padding: 2, borderRadius: 4, cursor: 'pointer' }}
      >
        <Dismiss12Regular />
      </span>
    </Tooltip>
  );
}

function RunTabItem({ tab, onClose, onPin }: { tab: RunTab; onClose: () => void; onPin: () => void }) {
  const name = useAppStore(state => {
    const job = jobForTab(state.jobs, tab);
    const runId = tab.runId ?? job?.runId;
    return job?.runName ?? state.runs.find(run => run.runId === runId)?.name ?? runId;
  });
  const status = useAppStore(state => statusOf(jobForTab(state.jobs, tab)));
  const state = useAppStore(state => stateOf(jobForTab(state.jobs, tab)));
  const label = name ?? '(starting…)';

  return (
    <Tooltip content={tabTooltip(label, state, tab.workdir)} relationship="description" positioning="below">
    <Tab
      value={tab.key}
      onDoubleClick={onPin}
      {...middleClick(onClose)}
      icon={<WorkspaceDot path={tab.workdir} identityKey={tab.identityKey} size={12} />}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <Text
          truncate
          wrap={false}
          style={{ fontStyle: tab.preview ? 'italic' : undefined, maxWidth: 160 }}
          data-testid={`run-tab-title-${tab.key}`}
        >
          {label}
        </Text>
        {status !== null && <RunStatusIcon status={status} />}
        {/* A span, not a Button: the Tab is already a <button>, and nesting one is invalid. */}
        <CloseButton label={label} onClose={onClose} />
      </span>
    </Tab>
    </Tooltip>
  );
}

/** The tab's title for a draft: the typed run name, else the chosen workflow's name, else a placeholder. */
function draftTitle(state: Pick<AppState, 'drafts'>, draftId: string): string {
  const draft = state.drafts[draftId];
  if (draft === undefined) return 'New run';
  const typed = draft.name.trim();
  if (typed !== '') return typed;
  // The ref is `global:<name>` for a global entry; the name is all the tab shows.
  const workflow = draft.workflowRef?.replace(/^(global|project):/, '');
  return workflow || 'New run';
}

function DraftTabItem({ tab, onClose }: { tab: DraftTab; onClose: () => void }) {
  const title = useAppStore(state => draftTitle(state, tab.key));
  const workspace = useAppStore(state => {
    const draft = state.drafts[tab.key];
    return draft === undefined ? '' : `${draft.workdir}\u0000${draft.identityKey ?? ''}`;
  });
  const [workdir = '', identityKey = ''] = workspace.split('\u0000');

  return (
    <Tooltip content={tabTooltip(title, 'draft', workdir)} relationship="description" positioning="below">
    <Tab
      value={tab.key}
      {...middleClick(onClose)}
      icon={<WorkspaceDot path={workdir} identityKey={identityKey || undefined} size={12} />}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <Edit12Regular aria-hidden data-testid={`draft-tab-glyph-${tab.key}`} />
        <Text truncate wrap={false} style={{ maxWidth: 160 }} data-testid={`run-tab-title-${tab.key}`}>
          {title}
        </Text>
        <CloseButton label={title} onClose={onClose} />
      </span>
    </Tab>
    </Tooltip>
  );
}

/** One row of the overflow menu: workspace dot and title, as the tab shows them. */
function OverflowItem({ tab, onPick }: { tab: AnyTab; onPick: () => void }) {
  const title = useAppStore(state => {
    if (tab.kind === 'draft') return draftTitle(state, tab.key);
    const job = jobForTab(state.jobs, tab);
    const runId = tab.runId ?? job?.runId;
    return job?.runName ?? state.runs.find(run => run.runId === runId)?.name ?? runId ?? '(starting…)';
  });
  const workspace = useAppStore(state => {
    if (tab.kind === 'run') return `${tab.workdir}\u0000${tab.identityKey ?? ''}`;
    const draft = state.drafts[tab.key];
    return draft === undefined ? '' : `${draft.workdir}\u0000${draft.identityKey ?? ''}`;
  });
  const [workdir = '', identityKey = ''] = workspace.split('\u0000');
  return (
    <MenuItem icon={<WorkspaceDot path={workdir} identityKey={identityKey || undefined} size={12} />} onClick={onPick}>
      {title}
    </MenuItem>
  );
}

/**
 * The Runs page's tabs: the fixed Runs list, then every open run and draft across
 * all workspaces. Activating a tab from another workspace goes through
 * `openWorkspace` first, so its unsaved-edits guard applies and a refusal
 * leaves both the workspace and the active tab where they were.
 */
export function RunTabStrip() {
  const client = useAgentClient();
  const keymap = useKeymap();
  const tabs = useAppStore(state => state.tabs);
  const activeTabKey = useAppStore(state => state.activeTabKey);
  const activateTab = useAppStore(state => state.activateTab);
  const closeTab = useAppStore(state => state.closeTab);
  const pinTab = useAppStore(state => state.pinTab);
  const retargetTab = useAppStore(state => state.retargetTab);
  // Just-started tabs are keyed by jobId; re-key them once the job has a run,
  // so opening that run from the list finds the tab instead of adding one.
  const learned = useAppStore(state => tabs
    .filter((tab): tab is RunTab => tab.kind === 'run')
    .filter(tab => tab.runId === undefined && tab.jobId !== undefined && state.jobs[tab.jobId]?.runId !== undefined)
    .map(tab => `${tab.key}\u0000${state.jobs[tab.jobId!]!.runId}`)
    .join('\u0001'));

  useEffect(() => {
    if (learned === '') return;
    for (const entry of learned.split('\u0001')) {
      const [key, runId] = entry.split('\u0000') as [string, string];
      const tab = useAppStore.getState().tabs.find(candidate => candidate.key === key);
      if (tab?.kind === 'run') retargetTab(key, { ...tab, runId });
    }
  }, [learned, retargetTab]);

  function close(tab: AnyTab): void {
    if (tab.kind === 'draft') {
      discard.request(tab.key);
      return;
    }
    closeTab(tab.key);
    discard.afterClose(tab.key === activeTabKey);
  }

  const discard = useDiscardDraft();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Keep the active tab in view when the strip is wider than the window.
  useEffect(() => {
    const selected = scrollRef.current?.querySelector('[role="tab"][aria-selected="true"]');
    // jsdom has no scrollIntoView.
    if (selected instanceof HTMLElement) selected.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeTabKey, tabs.length]);

  /** Tab values in strip order: the Runs list, then every open tab. */
  function order(): string[] {
    return [RUNS_TAB_VALUE, ...useAppStore.getState().tabs.map(candidate => candidate.key)];
  }

  function step(delta: 1 | -1): void {
    if (isModalOpen()) return;
    const values = order();
    const current = values.indexOf(useAppStore.getState().activeTabKey ?? RUNS_TAB_VALUE);
    const next = values[(Math.max(current, 0) + delta + values.length) % values.length];
    if (next !== undefined) void select(next);
  }

  // Ctrl+Tab: forward through the Runs list and this workspace's tabs only, so it never switches workspace.
  function stepInWorkspace(): void {
    if (isModalOpen()) return;
    const { tabs: open, activeTabKey: active } = useAppStore.getState();
    const values = [RUNS_TAB_VALUE, ...open.filter(isTabHere).map(candidate => candidate.key)];
    const current = values.indexOf(active ?? RUNS_TAB_VALUE);
    const next = values[(Math.max(current, 0) + 1) % values.length];
    if (next !== undefined) void select(next);
  }

  // The Ctrl+Tab actions are allowInTerminal: they stay live while a terminal has focus (TerminalPanel stops xterm eating them).
  useShortcut('tabs.next', () => step(1));
  useShortcut('tabs.nextInWorkspace', stepInWorkspace);
  useShortcut('tabs.nextAll', () => step(1));
  useShortcut('tabs.previous', () => step(-1));
  useShortcut('tabs.close', () => {
    if (isModalOpen()) return;
    const { tabs: open, activeTabKey: active } = useAppStore.getState();
    const current = open.find(candidate => candidate.key === active);
    // The Runs tab (no active key) cannot be closed.
    if (current !== undefined) close(current);
  });
  useShortcut('tabs.newRun', () => {
    if (isModalOpen()) return;
    const { workspacePath, workspaceIdentityKey, createDraft, openDraftTab } = useAppStore.getState();
    if (workspacePath) openDraftTab(createDraft({ workdir: workspacePath, identityKey: workspaceIdentityKey ?? undefined }));
  });
  useShortcut('tabs.runsList', () => {
    if (!isModalOpen()) void select(RUNS_TAB_VALUE);
  });

  async function select(value: string): Promise<void> {
    if (value === RUNS_TAB_VALUE) {
      activateTab(null);
      return;
    }
    const tab = useAppStore.getState().tabs.find(candidate => candidate.key === value);
    if (tab === undefined) return;
    if (!isTabHere(tab)) {
      const where = tabWorkspace(tab);
      if (where === undefined) return;
      const opened = await openWorkspace(client, where.path).catch(() => false);
      if (!opened) return;
    }
    activateTab(tab.key);
  }

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--colorNeutralStroke2)', flexShrink: 0, paddingInline: 8 }}>
        {/* Scrolls sideways when the tabs do not fit; the menu beside it stays put. */}
        <div ref={scrollRef} style={{ flex: 1, minWidth: 0, overflowX: 'auto', scrollbarWidth: 'none' }}>
          <TabList
            size="small"
            // The reserved-space copy would repeat the title and the close button in every tab.
            reserveSelectedTabSpace={false}
            selectedValue={activeTabKey ?? RUNS_TAB_VALUE}
            onTabSelect={(_event, data) => void select(String(data.value))}
            aria-label="Runs"
            style={{ width: 'max-content' }}
          >
            <Tooltip content={`Runs list (${actionLabel(keymap, 'tabs.runsList')})`} relationship="description" positioning="below">
              <Tab value={RUNS_TAB_VALUE}>Runs</Tab>
            </Tooltip>
            {tabs.map(tab => (tab.kind === 'draft' ? (
              <DraftTabItem key={tab.key} tab={tab} onClose={() => close(tab)} />
            ) : (
              <RunTabItem
                key={tab.key}
                tab={tab}
                onClose={() => close(tab)}
                onPin={() => pinTab(tab.key)}
              />
            )))}
          </TabList>
        </div>
        {tabs.length > 0 && (
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Tooltip
                content={`All tabs (${actionLabel(keymap, 'tabs.previous')} / ${actionLabel(keymap, 'tabs.next')} to cycle; ${actionLabel(keymap, 'tabs.nextInWorkspace')} this workspace, ${actionLabel(keymap, 'tabs.nextAll')} all)`}
                relationship="label"
              >
                <Button appearance="subtle" size="small" icon={<MoreHorizontal20Regular />} />
              </Tooltip>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem onClick={() => void select(RUNS_TAB_VALUE)}>Runs</MenuItem>
                {tabs.map(tab => (
                  <OverflowItem key={tab.key} tab={tab} onPick={() => void select(tab.key)} />
                ))}
              </MenuList>
            </MenuPopover>
          </Menu>
        )}
      </div>
      {discard.dialog}
    </>
  );
}
