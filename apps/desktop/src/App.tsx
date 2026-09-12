import { useCallback, useEffect, useState } from 'react';
import { FluentProvider, webDarkTheme, webLightTheme } from '@fluentui/react-components';
import { useAppStore, type JobState } from './state/store.ts';
import { useAgentClient } from './agent/agent-context.tsx';
import { useDarkTheme } from './lib/use-dark-theme.ts';
import { useStartupRestore } from './lib/use-startup-restore.ts';
import { useJobAttach } from './lib/use-job-attach.ts';
import { openWorkspace, settlePendingWorkspaceSwitch } from './lib/workspace-switch.ts';
import { useGlobalShortcut } from './lib/use-global-shortcut.ts';
import { useWindowTitle } from './lib/use-window-title.ts';
import { noopNotifier, type Notifier } from './lib/notifier.ts';
import { SPINNER_STYLE_HOOKS } from './lib/spinner-clip.ts';
import { useCapabilities } from './capabilities.tsx';
import { NotificationBridge } from './components/NotificationBridge.tsx';
import { UpdateBanner } from './components/UpdateBanner.tsx';
import { AgentDownBanner } from './components/AgentDownBanner.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { PageContent, type RunDetailTarget } from './components/PageContent.tsx';
import { UnsavedChangesDialog } from './components/UnsavedChangesDialog.tsx';
import { WorkspaceQuickSwitch } from './components/WorkspaceQuickSwitch.tsx';
import { SCROLLPORT_PADDING, SCROLLPORT_PADDING_TOP } from './components/PageHeader.tsx';
import type { PageId } from './nav.ts';

/** The one window-level shortcut: everything else hangs off the control it acts on. */
const QUICK_SWITCH = { key: 'k', mod: true } as const;

export function App({ notifier = noopNotifier }: { notifier?: Notifier } = {}) {
  const capabilities = useCapabilities();
  const dark = useDarkTheme();
  const page = useAppStore(state => state.page) as PageId;
  const setPage = useAppStore(state => state.setPage);
  const filesDirty = useAppStore(state => state.filesDirty);
  const setFilesDirty = useAppStore(state => state.setFilesDirty);
  const [runDetailTarget, setRunDetailTarget] = useState<RunDetailTarget | null>(null);
  /**
   * Navigation the unsaved-edits guard is holding until the user decides.
   * Carries a run-detail target too, so a sidebar "Ongoing runs" click that
   * gets deferred still lands on the right run once the human answers.
   */
  const [pendingPage, setPendingPage] = useState<{ id: PageId; runDetailTarget?: RunDetailTarget } | null>(null);
  const [quickSwitchOpen, setQuickSwitchOpen] = useState(false);
  const workspacePath = useAppStore(state => state.workspacePath);
  const pendingWorkspaceSwitch = useAppStore(state => state.pendingWorkspaceSwitch);
  const client = useAgentClient();
  useStartupRestore(client, capabilities);
  // Replays runs that started before this client connected — see use-job-attach.ts.
  useJobAttach(client);

  // runDetailTarget is local state, so no store-level clearing reaches it. A
  // workspace switch doesn't go through goToPage, and leaving it set would
  // have RunDetailPage query the new workspace for the old workspace's run.
  useEffect(() => setRunDetailTarget(null), [workspacePath]);

  useGlobalShortcut(QUICK_SWITCH, useCallback(() => setQuickSwitchOpen(true), []));
  useWindowTitle();

  function goToPage(next: PageId, target: RunDetailTarget | null = null): void {
    setRunDetailTarget(target);
    setPage(next);
    void client.request('setUiState', { lastPage: next }).catch(() => {});
  }

  function requestPage(next: PageId): void {
    // Leaving Files unmounts FilesPage, taking any unsaved draft with it —
    // its own in-page guard can't see this exit, so it has to be caught here
    // (spec: "selecting another file, switching tabs, or closing with
    // unsaved edits").
    if (page === 'files' && next !== 'files' && filesDirty) {
      setPendingPage({ id: next });
      return;
    }
    goToPage(next);
  }

  /**
   * Opens a run from the sidebar's "Ongoing runs" section. Two guards, but
   * only one ever applies to a given click:
   *  1. A job from another workspace switches first, via the same
   *     `openWorkspace` every other switch path uses — including its own
   *     unsaved-edits dialog. A `false` return means the human chose to keep
   *     editing, so this must not navigate. That dialog already resolved
   *     `filesDirty` for this click, so guard 2 must not re-check the
   *     (now-stale) closure value on this path.
   *  2. A same-workspace click still leaves Files, which can silently drop an
   *     unsaved draft — the same guard `requestPage` applies. This only runs
   *     when guard 1 didn't, since nothing switched.
   */
  async function openRun(job: JobState): Promise<void> {
    const target: RunDetailTarget = { jobId: job.jobId, runId: job.runId };
    if (job.workdir !== undefined && job.workdir !== workspacePath) {
      const opened = await openWorkspace(client, job.workdir).catch(() => false);
      if (!opened) return;
      goToPage('runs', target);
      return;
    }
    if (page === 'files' && filesDirty) {
      setPendingPage({ id: 'runs', runDetailTarget: target });
      return;
    }
    goToPage('runs', target);
  }

  return (
    <FluentProvider
      theme={dark ? webDarkTheme : webLightTheme}
      customStyleHooks_unstable={SPINNER_STYLE_HOOKS}
      style={{ height: '100%' }}
    >
      <NotificationBridge notifier={notifier} />
      <UpdateBanner />
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <AgentDownBanner />
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <Sidebar page={page} onSelectPage={requestPage} onOpenRun={job => void openRun(job)} />
          <main
            style={{
              flex: 1, overflow: 'auto',
              padding: SCROLLPORT_PADDING, paddingTop: SCROLLPORT_PADDING_TOP,
            }}
          >
            <PageContent
              page={page}
              runDetailTarget={runDetailTarget}
              onOpenRunDetail={target => { setPage('runs'); setRunDetailTarget(target); }}
              onCloseRunDetail={() => setRunDetailTarget(null)}
              onNavigate={goToPage}
            />
          </main>
        </div>
      </div>

      {/*
        * Yields to the guard: choosing a workspace here with unsaved edits
        * raises the dialog, and two live Modalizers is the tabster race. It
        * comes back if the answer was "keep editing", which is also the right
        * place to land.
        */}
      {quickSwitchOpen && pendingWorkspaceSwitch === null && (
        <WorkspaceQuickSwitch onClose={() => setQuickSwitchOpen(false)} />
      )}

      {/*
        * At most one guard dialog is ever mounted. A page switch and a
        * workspace switch can't both be initiated in the same tick, but
        * stacking two Modalizers is the tabster race described above, so the
        * exclusion is enforced rather than assumed.
        */}
      {pendingWorkspaceSwitch !== null ? (
        <UnsavedChangesDialog
          onDiscard={() => settlePendingWorkspaceSwitch(true)}
          onKeepEditing={() => settlePendingWorkspaceSwitch(false)}
        />
      ) : pendingPage !== null && (
        <UnsavedChangesDialog
          onDiscard={() => {
            const next = pendingPage;
            setPendingPage(null);
            setFilesDirty(false);
            goToPage(next.id, next.runDetailTarget ?? null);
          }}
          onKeepEditing={() => setPendingPage(null)}
        />
      )}
    </FluentProvider>
  );
}
