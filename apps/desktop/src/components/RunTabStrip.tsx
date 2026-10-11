import { useEffect } from 'react';
import { Tab, TabList, Text } from '@fluentui/react-components';
import { Dismiss12Regular, Edit12Regular } from '@fluentui/react-icons';
import { useAgentClient } from '../agent/agent-context.tsx';
import { isWaitingJob, useAppStore, type AppState, type JobState } from '../state/store.ts';
import { openWorkspace } from '../lib/workspace-switch.ts';
import type { AnyTab, DraftTab, RunTab } from '../lib/run-tabs.ts';
import { RunStatusIcon, type RunStatus } from './OngoingRuns.tsx';
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

function RunTabItem({ tab, onClose, onPin }: { tab: RunTab; onClose: () => void; onPin: () => void }) {
  const name = useAppStore(state => {
    const job = jobForTab(state.jobs, tab);
    const runId = tab.runId ?? job?.runId;
    return job?.runName ?? state.runs.find(run => run.runId === runId)?.name ?? runId;
  });
  const status = useAppStore(state => statusOf(jobForTab(state.jobs, tab)));
  const label = name ?? '(starting…)';

  return (
    <Tab
      value={tab.key}
      onDoubleClick={onPin}
      icon={<WorkspaceDot path={tab.workdir} identityKey={tab.identityKey} size={12} />}
      title={tab.workdir}
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
      </span>
    </Tab>
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
    <Tab
      value={tab.key}
      icon={<WorkspaceDot path={workdir} identityKey={identityKey || undefined} size={12} />}
      title={workdir}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <Edit12Regular aria-hidden data-testid={`draft-tab-glyph-${tab.key}`} />
        <Text truncate wrap={false} style={{ maxWidth: 160 }} data-testid={`run-tab-title-${tab.key}`}>
          {title}
        </Text>
        <span
          role="button"
          aria-label={`Close ${title}`}
          tabIndex={-1}
          onClick={event => { event.stopPropagation(); onClose(); }}
          style={{ display: 'inline-flex', padding: 2, borderRadius: 4, cursor: 'pointer' }}
        >
          <Dismiss12Regular />
        </span>
      </span>
    </Tab>
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
      <TabList
        size="small"
        // The reserved-space copy would repeat the title and the close button in every tab.
        reserveSelectedTabSpace={false}
        selectedValue={activeTabKey ?? RUNS_TAB_VALUE}
        onTabSelect={(_event, data) => void select(String(data.value))}
        aria-label="Runs"
        style={{ borderBottom: '1px solid var(--colorNeutralStroke2)', flexShrink: 0, paddingInline: 8 }}
      >
        <Tab value={RUNS_TAB_VALUE}>Runs</Tab>
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
      {discard.dialog}
    </>
  );
}
