import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

vi.mock('../pages/RunDetailPage.tsx', () => ({
  RunDetailPage: (
    { onRunAgain, onResumed }: {
      onRunAgain: (workflow: string, inputs: Record<string, string>, source?: 'project' | 'global') => void;
      onResumed: (target: { jobId: string; runId: string }) => void;
    },
  ) => (
    <>
      <button onClick={() => onRunAgain('feature', { a: '1' }, 'global')}>run-again-global</button>
      <button onClick={() => onRunAgain('feature', { a: '1' })}>run-again-unscoped</button>
      <button onClick={() => onResumed({ jobId: 'job-new', runId: 'run-1' })}>resumed</button>
    </>
  ),
}));

function renderPageContent(
  overrides: Partial<Parameters<typeof PageContent>[0]> = {},
  capabilities?: AppCapabilities,
) {
  const onOpenRunDetail = vi.fn();
  const onCloseRunDetail = vi.fn();
  const onNavigate = vi.fn();
  const wrap = (node: ReactNode) =>
    capabilities ? <CapabilitiesProvider value={capabilities}>{node}</CapabilitiesProvider> : node;
  render(wrap(
    <PageContent
      page="workflows"
      runDetailTarget={null}
      onOpenRunDetail={onOpenRunDetail}
      onCloseRunDetail={onCloseRunDetail}
      onNavigate={onNavigate}
      {...overrides}
    />,
  ));
  return { onOpenRunDetail, onCloseRunDetail, onNavigate };
}

describe('PageContent', () => {
  beforeEach(() => {
    useAppStore.setState({ workspacePath: '/ws', pendingRunAgain: null });
  });

  afterEach(() => {
    useAppStore.setState({ workspacePath: null, pendingRunAgain: null });
  });

  it('scopes a global workflow card click into a global:-prefixed pendingRunAgain', () => {
    renderPageContent({ page: 'workflows' });
    fireEvent.click(screen.getByRole('button', { name: 'run-workflow-global' }));
    expect(useAppStore.getState().pendingRunAgain).toEqual({ workflow: 'global:feature', inputs: {} });
  });

  it('scopes Run again into a global:-prefixed pendingRunAgain when the run was started from a global workflow', () => {
    const { onCloseRunDetail, onNavigate } = renderPageContent({ runDetailTarget: { runId: 'r1' } });
    fireEvent.click(screen.getByRole('button', { name: 'run-again-global' }));
    expect(useAppStore.getState().pendingRunAgain).toEqual({ workflow: 'global:feature', inputs: { a: '1' } });
    expect(onCloseRunDetail).toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledWith('runs');
  });

  it('leaves an unscoped Run again bare, for a run with no recorded workflowSource', () => {
    renderPageContent({ runDetailTarget: { runId: 'r1' } });
    fireEvent.click(screen.getByRole('button', { name: 'run-again-unscoped' }));
    expect(useAppStore.getState().pendingRunAgain).toEqual({ workflow: 'feature', inputs: { a: '1' } });
  });
  it('re-points the run detail page at the job a resume started', () => {
    const { onOpenRunDetail } = renderPageContent({
      page: 'runs', runDetailTarget: { runId: 'run-1' },
    });

    fireEvent.click(screen.getByText('resumed'));

    // The resumed run lives in a job of its own; opening it is the same action
    // as opening any other run detail target.
    expect(onOpenRunDetail).toHaveBeenCalledWith({ jobId: 'job-new', runId: 'run-1' });
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
