import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { PageContent } from './PageContent.tsx';
import { useAppStore } from '../state/store.ts';
import { CapabilitiesProvider, type AppCapabilities } from '../capabilities.tsx';

const BROWSER_CAPS: AppCapabilities = { host: 'browser', localFiles: false };

/**
 * PageContent's job here is just the glue between a card/page click and
 * `pendingRunAgain`: scoping the ref so a global workflow can't silently
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

vi.mock('./RunTabStrip.tsx', () => ({
  RunTabStrip: () => <div>run-tab-strip</div>,
}));

vi.mock('../pages/RunsPage.tsx', () => ({
  RunsPage: ({ onSelectRun, onStarted }: {
    onSelectRun: (runId: string, pin: boolean) => void;
    onStarted: (jobId: string) => void;
  }) => (
    <>
      <button onClick={() => onSelectRun('r1', false)}>select-run</button>
      <button onClick={() => onSelectRun('r1', true)}>pin-run</button>
      <button onClick={() => onStarted('job-1')}>started</button>
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
    useAppStore.setState({ workspacePath: '/ws', pendingRunAgain: null, tabs: [], activeTabKey: null });
  });

  afterEach(() => {
    useAppStore.setState({ workspacePath: null, pendingRunAgain: null, tabs: [], activeTabKey: null });
  });

  it('scopes a global workflow card click into a global:-prefixed pendingRunAgain', () => {
    renderPageContent({ page: 'workflows' });
    fireEvent.click(screen.getByRole('button', { name: 'run-workflow-global' }));
    expect(useAppStore.getState().pendingRunAgain).toEqual({ workflow: 'global:feature', inputs: {} });
  });

  it('scopes Run again into a global:-prefixed pendingRunAgain when the run was started from a global workflow', () => {
    useAppStore.setState({ tabs: [TAB], activeTabKey: 'r1' });
    renderPageContent({ page: 'runs' });
    fireEvent.click(screen.getByRole('button', { name: 'run-again-global' }));
    expect(useAppStore.getState().pendingRunAgain).toEqual({ workflow: 'global:feature', inputs: { a: '1' } });
    // Back to the list, where New run opens; the run's tab stays.
    expect(useAppStore.getState().activeTabKey).toBeNull();
    expect(useAppStore.getState().tabs).toHaveLength(1);
  });

  it('leaves an unscoped Run again bare, for a run with no recorded workflowSource', () => {
    useAppStore.setState({ tabs: [TAB], activeTabKey: 'r1' });
    renderPageContent({ page: 'runs' });
    fireEvent.click(screen.getByRole('button', { name: 'run-again-unscoped' }));
    expect(useAppStore.getState().pendingRunAgain).toEqual({ workflow: 'feature', inputs: { a: '1' } });
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

  it('opens a just-started run in a pinned tab keyed by its job', () => {
    renderPageContent({ page: 'runs' });
    fireEvent.click(screen.getByRole('button', { name: 'started' }));
    expect(useAppStore.getState().tabs).toMatchObject([{ key: 'job-1', jobId: 'job-1', preview: false }]);
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
