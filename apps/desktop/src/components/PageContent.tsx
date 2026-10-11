import { Text } from '@fluentui/react-components';
import { useAppStore } from '../state/store.ts';
import { useCapabilities } from '../capabilities.tsx';
import { requiresWorkspace, type PageId } from '../nav.ts';
import { RunsPage } from '../pages/RunsPage.tsx';
import { WorkflowsPage } from '../pages/WorkflowsPage.tsx';
import { FilesPage } from '../pages/FilesPage.tsx';
import { DoctorPage } from '../pages/DoctorPage.tsx';
import { WorkspaceSettingsPage } from '../pages/WorkspaceSettingsPage.tsx';
import { PreferencesPage } from '../pages/PreferencesPage.tsx';
import { ActivityPage } from '../pages/ActivityPage.tsx';
import { RunTabStrip } from './RunTabStrip.tsx';
import { RunDetailPage } from '../pages/RunDetailPage.tsx';
import { WelcomePage } from '../pages/WelcomePage.tsx';
import { Page } from './Page.tsx';

export interface PageContentProps {
  page: PageId;
  onNavigate: (next: PageId) => void;
}

/**
 * Reachable only if something navigates to 'files' directly — nav.ts already
 * filters the item out of the sidebar in a browser. It exists so that path is
 * an explanation rather than a blank pane.
 */
function LocalFilesUnavailable() {
  return (
    <Page header={<Text weight="semibold" size={500}>Files</Text>}>
      <div style={{ maxWidth: 480 }}>
        <Text size={400} weight="semibold">Files are only available in the desktop app</Text>
        <br />
        <Text>
          Browsing the workspace reads the local disk directly, which a browser on another
          machine cannot do. Run artifacts and diffs are still available from any run.
        </Text>
      </div>
    </Page>
  );
}

export function PageContent({ page, onNavigate }: PageContentProps) {
  const workspacePath = useAppStore(state => state.workspacePath);
  const restoreDone = useAppStore(state => state.restoreDone);
  const tabs = useAppStore(state => state.tabs);
  const activeTabKey = useAppStore(state => state.activeTabKey);
  const { localFiles } = useCapabilities();

  // Which pages survive without a workspace is nav.ts's `requiresWorkspace`
  // column, not a condition spelled out here.
  if (requiresWorkspace(page) && !workspacePath) return restoreDone ? <WelcomePage /> : null;

  /**
   * A run in the open workspace: the Runs list and Activity both open runs
   * this way. Read from the store, not the render's closure — Activity calls
   * this right after switching workspace, before this component re-renders.
   */
  function openRun(target: { runId?: string; jobId?: string }, pin: boolean): void {
    const { workspacePath: workdir, workspaceIdentityKey } = useAppStore.getState();
    if (!workdir) return;
    useAppStore.getState().openRunTab({ workdir, identityKey: workspaceIdentityKey ?? undefined, ...target }, { pin });
    onNavigate('runs');
  }

  if (page === 'runs') {
    const active = tabs.find(tab => tab.key === activeTabKey);
    return (
      <>
        <RunTabStrip />
        {active ? (
          <RunDetailPage
            // A resume's new job is a fresh page, as the re-pointed page was before tabs.
            key={active.jobId ?? active.key}
            jobId={active.jobId}
            runId={active.runId}
            onBack={() => useAppStore.getState().activateTab(null)}
            // A resume runs under a job of its own; re-point this tab at it
            // rather than opening another.
            onResumed={target => useAppStore.getState().retargetTab(active.key, { ...active, ...target })}
            onRunAgain={(workflow, inputs, source) => {
              // Same scoping as the WorkflowsPage `onRunWorkflow` callback below:
              // a global run must not preselect a same-named project workflow.
              const ref = source === 'global' ? `global:${workflow}` : workflow;
              useAppStore.getState().setPendingRunAgain({ workflow: ref, inputs });
              useAppStore.getState().activateTab(null);
            }}
          />
        ) : (
          <RunsPage
            onSelectRun={(runId, pin) => openRun({ runId }, pin)}
            onStarted={jobId => openRun({ jobId }, true)}
          />
        )}
      </>
    );
  }

  return (
    <>
      {page === 'workflows' && (
        <WorkflowsPage
          onRunWorkflow={(workflow, source) => {
            // Same path "Run again" takes: RunsPage opens NewRunDialog as soon
            // as pendingRunAgain is set, and the dialog preselects this workflow.
            // Remembered values only apply to inputs the workflow marks
            // `remember: true`; everything else fills from `default` or blank.
            // A global entry is scoped explicitly so NewRunDialog preselects
            // the card that was actually clicked, not a project workflow that
            // happens to share its name.
            const ref = source === 'global' ? `global:${workflow}` : workflow;
            useAppStore.getState().setPendingRunAgain({ workflow: ref, inputs: {} });
            onNavigate('runs');
          }}
        />
      )}
      {page === 'files' && (localFiles ? <FilesPage /> : <LocalFilesUnavailable />)}
      {page === 'workspace-settings' && <WorkspaceSettingsPage />}
      {page === 'activity' && <ActivityPage onSelectRun={runId => openRun({ runId }, false)} />}
      {page === 'doctor' && <DoctorPage />}
      {page === 'preferences' && <PreferencesPage />}
    </>
  );
}
