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
import { RunDetailPage } from '../pages/RunDetailPage.tsx';
import { WelcomePage } from '../pages/WelcomePage.tsx';
import { Page } from './Page.tsx';

/** RunDetail is reached from a Runs row or a just-started run, not a tab of its own. */
export interface RunDetailTarget {
  jobId?: string;
  runId?: string;
}

export interface PageContentProps {
  page: PageId;
  runDetailTarget: RunDetailTarget | null;
  onOpenRunDetail: (target: RunDetailTarget) => void;
  onCloseRunDetail: () => void;
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

export function PageContent({
  page, runDetailTarget, onOpenRunDetail, onCloseRunDetail, onNavigate,
}: PageContentProps) {
  const workspacePath = useAppStore(state => state.workspacePath);
  const restoreDone = useAppStore(state => state.restoreDone);
  const { localFiles } = useCapabilities();

  // Which pages survive without a workspace is nav.ts's `requiresWorkspace`
  // column, not a condition spelled out here.
  if (requiresWorkspace(page) && !workspacePath) return restoreDone ? <WelcomePage /> : null;

  if (runDetailTarget) {
    return (
      <RunDetailPage
        jobId={runDetailTarget.jobId}
        runId={runDetailTarget.runId}
        onBack={onCloseRunDetail}
        // A resume runs under a job of its own; re-point the page at it, which
        // is exactly what opening a run detail target already means.
        onResumed={onOpenRunDetail}
        onRunAgain={(workflow, inputs, source) => {
          // Same scoping as the WorkflowsPage `onRunWorkflow` callback below:
          // a global run must not preselect a same-named project workflow.
          const ref = source === 'global' ? `global:${workflow}` : workflow;
          useAppStore.getState().setPendingRunAgain({ workflow: ref, inputs });
          onCloseRunDetail();
          onNavigate('runs');
        }}
      />
    );
  }

  return (
    <>
      {page === 'runs' && (
        <RunsPage
          onSelectRun={runId => onOpenRunDetail({ runId })}
          onStarted={jobId => onOpenRunDetail({ jobId })}
        />
      )}
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
      {page === 'activity' && <ActivityPage onSelectRun={runId => onOpenRunDetail({ runId })} />}
      {page === 'doctor' && <DoctorPage />}
      {page === 'preferences' && <PreferencesPage />}
    </>
  );
}
