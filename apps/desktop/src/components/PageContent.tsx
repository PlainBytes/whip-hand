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
import { NewRunForm } from './NewRunForm.tsx';
import type { RunAgain } from '../lib/new-run-draft.ts';
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

/**
 * Every open draft's form, mounted on every page and shown only for the active
 * draft tab on the Runs page. Staying mounted keeps what the form holds
 * locally (a start in flight, an error) through a switch of tab or page; the
 * rest lives in the store's draft.
 */
function DraftForms({ shown }: { shown: boolean }) {
  const tabs = useAppStore(state => state.tabs);
  const activeTabKey = useAppStore(state => state.activeTabKey);
  const drafts = tabs.filter(tab => tab.kind === 'draft');
  return (
    <>
      {drafts.map(tab => {
        const visible = shown && tab.key === activeTabKey;
        return (
          <div key={tab.key} style={{ display: visible ? 'block' : 'none', flex: 1, minHeight: 0 }}>
            <NewRunForm draftId={tab.key} visible={visible} />
          </div>
        );
      })}
    </>
  );
}

function PageBody({ page, onNavigate }: PageContentProps) {
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

  /** A new draft tab in the open workspace, active, on the Runs page. Every call makes another. */
  function newDraft(runAgain?: RunAgain, continueIn?: string): void {
    const { workspacePath: workdir, workspaceIdentityKey, createDraft, openDraftTab } = useAppStore.getState();
    if (!workdir) return;
    openDraftTab(createDraft({ workdir, identityKey: workspaceIdentityKey ?? undefined, runAgain, continueIn }));
    onNavigate('runs');
  }

  if (page === 'runs') {
    const active = tabs.find(tab => tab.key === activeTabKey);
    return (
      <>
        <RunTabStrip />
        {active?.kind === 'draft' ? null : active ? (
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
              newDraft({ workflow: ref, inputs });
            }}
            onContinueInWorktree={(sourceId, workflow, source) => {
              const ref = workflow === undefined ? undefined : source === 'global' ? `global:${workflow}` : workflow;
              newDraft(ref === undefined ? undefined : { workflow: ref, inputs: {} }, sourceId);
            }}
          />
        ) : (
          <RunsPage
            onSelectRun={(runId, pin) => openRun({ runId }, pin)}
            onNewRun={() => newDraft()}
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
            // Same path "Run again" takes: a new draft with this workflow
            // selected. Remembered values only apply to inputs the workflow marks
            // `remember: true`; everything else fills from `default` or blank.
            // A global entry is scoped explicitly so the draft preselects
            // the card that was actually clicked, not a project workflow that
            // happens to share its name.
            const ref = source === 'global' ? `global:${workflow}` : workflow;
            newDraft({ workflow: ref, inputs: {} });
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

export function PageContent({ page, onNavigate }: PageContentProps) {
  const workspacePath = useAppStore(state => state.workspacePath);
  return (
    <>
      <PageBody page={page} onNavigate={onNavigate} />
      {workspacePath && <DraftForms shown={page === 'runs'} />}
    </>
  );
}
