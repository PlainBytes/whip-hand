import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { PageContent } from './PageContent.tsx';
import { useAppStore } from '../state/store.ts';
import { CapabilitiesProvider, type AppCapabilities } from '../capabilities.tsx';

const BROWSER_CAPS: AppCapabilities = { host: 'browser', localFiles: false };

/**
 * PageContent's job here is just the glue between a card/page click and
 * a new draft: scoping the ref so a global workflow can't silently
 * re-resolve to a same-named project one (review: do-review/iter-2, finding
 * 1 — RunDetailPage's "Run again" was missing this, WorkflowsPage's card
 * already had it). Real WorkflowsPage/RunDetailPage need a live agent
 * client and network responses to render at all, which is irrelevant to the
 * ref-building logic under test — stub them down to a button per callback.
 */
vi.mock('../pages/WorkflowsPage.tsx', () => ({
  WorkflowsPage: ({ onRunWorkflow }: { onRunWorkflow: (name: string, source: 'project' | 'global') => void }) => (
    <button onClick={() => onRunWorkflow('feature', 'global')}>run-workflow-global</button>
  ),
}));

vi.mock('../pages/FilesPage.tsx', () => ({
  FilesPage: () => <div>files-page</div>,
}));

vi.mock('./NewRunForm.tsx', () => ({
  NewRunForm: ({ draftId, visible }: { draftId: string; visible?: boolean }) => (
    <div data-testid={`form-${draftId}`} data-visible={String(visible)} />
  ),
}));

vi.mock('./RunTabStrip.tsx', () => ({
  RunTabStrip: () => <div>run-tab-strip</div>,
}));

vi.mock('../pages/RunsPage.tsx', () => ({
  RunsPage: ({ onSelectRun, onNewRun }: {
    onSelectRun: (runId: string, pin: boolean) => void;
    onNewRun: () => void;
  }) => (
    <>
      <button onClick={() => onSelectRun('r1', false)}>select-run</button>
      <button onClick={() => onSelectRun('r1', true)}>pin-run</button>
      <button onClick={onNewRun}>new-run</button>
    </>
  ),
}));

vi.mock('../pages/RunDetailPage.tsx', () => ({
  RunDetailPage: (
    { onRunAgain, onResumed, onBack }: {
      onBack: () => void;
      onRunAgain: (workflow: string, inputs: Record<string, string>, source?: 'project' | 'global') => void;
      onResumed: (target: { jobId: string; runId: string }) => void;
    },
  ) => (
    <>
      <button onClick={() => onRunAgain('feature', { a: '1' }, 'global')}>run-again-global</button>
      <button onClick={() => onRunAgain('feature', { a: '1' })}>run-again-unscoped</button>
      <button onClick={onBack}>back</button>
      <button onClick={() => onResumed({ jobId: 'job-new', runId: 'r1' })}>resumed</button>
    </>
  ),
}));

function renderPageContent(
  overrides: Partial<Parameters<typeof PageContent>[0]> = {},
  capabilities?: AppCapabilities,
) {
  const onNavigate = vi.fn();
  const wrap = (node: ReactNode) =>
    capabilities ? <CapabilitiesProvider value={capabilities}>{node}</CapabilitiesProvider> : node;
  render(wrap(<PageContent page="workflows" onNavigate={onNavigate} {...overrides} />));
  return { onNavigate };
}

const TAB = { kind: 'run', key: 'r1', workdir: '/ws', runId: 'r1', preview: false } as const;

describe('PageContent', () => {
  beforeEach(() => {
    useAppStore.setState({ workspacePath: '/ws', drafts: {}, tabs: [], activeTabKey: null });
  });

  afterEach(() => {
    useAppStore.setState({ workspacePath: null, drafts: {}, tabs: [], activeTabKey: null });
  });

  /** The workflow the active draft was created for. */
  function activeDraft() {
    const { drafts, activeTabKey } = useAppStore.getState();
    return drafts[activeTabKey!]!;
  }

  it('scopes a global workflow card click into a draft that selects the global entry', () => {
    useAppStore.setState({
      workflows: [{ name: 'feature', source: 'global', path: '/g/feature.yaml', workflow: { name: 'feature', steps: [] } }] as never,
    });
    const { onNavigate } = renderPageContent({ page: 'workflows' });
    fireEvent.click(screen.getByRole('button', { name: 'run-workflow-global' }));
    expect(activeDraft()).toMatchObject({ workdir: '/ws', workflowRef: 'global:feature' });
    expect(useAppStore.getState().tabs).toMatchObject([{ kind: 'draft' }]);
    expect(onNavigate).toHaveBeenCalledWith('runs');
  });

  it('makes a new draft for every Run workflow click', () => {
    renderPageContent({ page: 'workflows' });
    fireEvent.click(screen.getByRole('button', { name: 'run-workflow-global' }));
    fireEvent.click(screen.getByRole('button', { name: 'run-workflow-global' }));
    expect(useAppStore.getState().tabs).toHaveLength(2);
    expect(Object.keys(useAppStore.getState().drafts)).toHaveLength(2);
  });

  it('scopes Run again into a draft on the global entry when the run was started from a global workflow', () => {
    useAppStore.setState({
      tabs: [TAB], activeTabKey: 'r1',
      workflows: [{ name: 'feature', source: 'global', path: '/g/feature.yaml', workflow: { name: 'feature', inputs: { a: {} }, steps: [] } }] as never,
    });
    renderPageContent({ page: 'runs' });
    fireEvent.click(screen.getByRole('button', { name: 'run-again-global' }));
    expect(activeDraft()).toMatchObject({ workflowRef: 'global:feature', values: { a: '1' } });
    // The run's tab stays, with the draft opened beside it.
    expect(useAppStore.getState().tabs).toMatchObject([{ key: 'r1' }, { kind: 'draft' }]);
  });

  it('leaves an unscoped Run again bare, for a run with no recorded workflowSource', () => {
    useAppStore.setState({
      tabs: [TAB], activeTabKey: 'r1',
      workflows: [{ name: 'feature', source: 'project', path: '/p/feature.yaml', workflow: { name: 'feature', inputs: { a: {} }, steps: [] } }] as never,
    });
    renderPageContent({ page: 'runs' });
    fireEvent.click(screen.getByRole('button', { name: 'run-again-unscoped' }));
    expect(activeDraft()).toMatchObject({ workflowRef: 'feature', values: { a: '1' } });
  });

  it('opens a blank draft tab, three times for three clicks, and no dialog', () => {
    renderPageContent({ page: 'runs' });
    for (let i = 0; i < 3; i++) {
      // Back on the Runs list, where the button is, between clicks.
      act(() => useAppStore.getState().activateTab(null));
      fireEvent.click(screen.getByRole('button', { name: 'new-run' }));
    }
    const { tabs, activeTabKey } = useAppStore.getState();
    expect(tabs.map(tab => tab.kind)).toEqual(['draft', 'draft', 'draft']);
    expect(activeTabKey).toBe(tabs[0]!.key); // each lands right of the list tab it was opened from
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows only the active draft\'s form, and keeps the others mounted but hidden', () => {
    const { createDraft, openDraftTab } = useAppStore.getState();
    const a = createDraft({ workdir: '/ws' });
    const b = createDraft({ workdir: '/ws' });
    openDraftTab(a);
    openDraftTab(b);
    renderPageContent({ page: 'runs' });
    expect(screen.getByTestId(`form-${a}`)).toHaveAttribute('data-visible', 'false');
    expect(screen.getByTestId(`form-${b}`)).toHaveAttribute('data-visible', 'true');
    expect(screen.queryByRole('button', { name: 'select-run' })).not.toBeInTheDocument();
  });

  it('keeps the forms mounted but not visible on another page', () => {
    const { createDraft, openDraftTab } = useAppStore.getState();
    const a = createDraft({ workdir: '/ws' });
    openDraftTab(a);
    renderPageContent({ page: 'workflows' });
    expect(screen.getByTestId(`form-${a}`)).toHaveAttribute('data-visible', 'false');
  });

  it('shows the tab strip and the Runs list while the Runs tab is active', () => {
    renderPageContent({ page: 'runs' });
    expect(screen.getByText('run-tab-strip')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'select-run' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'back' })).not.toBeInTheDocument();
  });

  it('shows no tab strip on other pages', () => {
    renderPageContent({ page: 'workflows' });
    expect(screen.queryByText('run-tab-strip')).not.toBeInTheDocument();
  });

  it('shows the run detail for the active tab', () => {
    useAppStore.setState({ tabs: [TAB], activeTabKey: 'r1' });
    renderPageContent({ page: 'runs' });
    expect(screen.getByRole('button', { name: 'back' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'select-run' })).not.toBeInTheDocument();
  });

  it('opens a preview tab for a selected row and a pinned one for a double click', () => {
    renderPageContent({ page: 'runs' });
    fireEvent.click(screen.getByRole('button', { name: 'select-run' }));
    expect(useAppStore.getState()).toMatchObject({
      activeTabKey: 'r1',
      tabs: [{ key: 'r1', workdir: '/ws', preview: true }],
    });
    act(() => useAppStore.setState({ activeTabKey: null }));
    fireEvent.click(screen.getByRole('button', { name: 'pin-run' }));
    expect(useAppStore.getState().tabs).toMatchObject([{ key: 'r1', preview: false }]);
  });

  it('goes back to the Runs tab and keeps the run\'s tab', () => {
    useAppStore.setState({ tabs: [TAB], activeTabKey: 'r1' });
    renderPageContent({ page: 'runs' });
    fireEvent.click(screen.getByRole('button', { name: 'back' }));
    expect(useAppStore.getState()).toMatchObject({ activeTabKey: null, tabs: [{ key: 'r1' }] });
  });

  it('re-points the active tab at the job a resume started, adding no tab', () => {
    useAppStore.setState({
      tabs: [{ ...TAB, jobId: 'job-old' }], activeTabKey: 'r1',
    });
    renderPageContent({ page: 'runs' });

    fireEvent.click(screen.getByText('resumed'));

    expect(useAppStore.getState().tabs).toMatchObject([{ key: 'r1', jobId: 'job-new' }]);
    expect(useAppStore.getState().activeTabKey).toBe('r1');
  });

  it('renders the Files page on a host with a local filesystem', () => {
    renderPageContent({ page: 'files' });
    expect(screen.getByText('files-page')).toBeInTheDocument();
  });

  it('explains itself instead of rendering Files where there is no local filesystem', () => {
    // Nav already hides the item; this covers arriving at the page some other
    // way (a restored lastPage, a quick-switch) so it is never a blank pane.
    renderPageContent({ page: 'files' }, BROWSER_CAPS);

    expect(screen.queryByText('files-page')).not.toBeInTheDocument();
    expect(screen.getByText(/only available in the desktop app/i)).toBeInTheDocument();
  });
});
