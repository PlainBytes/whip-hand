import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReviewOverlay, type ReviewOverlayProps } from './ReviewOverlay.tsx';
import { DIFF_SOURCE_ID, type ReviewRequest } from './model.ts';
import { FakeFileSystem } from '../files/fake-fs.ts';
import type { WorkingDiff } from '../diff/types.ts';

function request(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    key: 'sign-off',
    badge: 'Decision needed',
    title: 'Ship it?',
    instructions: 'Review the diff and the findings.',
    sources: [],
    choices: [
      { value: 'continue', label: 'Continue', hint: 'Carry on.', primary: true },
      { value: 'abort', label: 'Abort run', hint: 'Stop here.', primary: false },
    ],
    ...overrides,
  };
}

const DIFF: WorkingDiff = {
  files: [{
    path: 'src/x.ts', status: 'modified', additions: 1, deletions: 1, binary: false,
    patch: 'diff --git a/src/x.ts b/src/x.ts\n@@ -1 +1 @@\n-old\n+new\n',
  }],
};

const TWO_FILE_DIFF: WorkingDiff = {
  files: [
    {
      path: 'src/x.ts', status: 'modified', additions: 1, deletions: 1, binary: false,
      patch: 'diff --git a/src/x.ts b/src/x.ts\n@@ -1 +1 @@\n-old\n+new\n',
    },
    {
      path: 'src/y.ts', status: 'modified', additions: 1, deletions: 1, binary: false,
      patch: 'diff --git a/src/y.ts b/src/y.ts\n@@ -1 +1 @@\n-old\n+new\n',
    },
  ],
};

const REVIEW_CAPTURE = { kind: 'review' as const, label: 'Feedback', requiredFor: ['retry' as const], perFile: true };
const REVIEW_SOURCES = [{ kind: 'diff' as const, id: DIFF_SOURCE_ID, label: 'Changes' }];
const REVIEW_CHOICES = [
  { value: 'continue' as const, label: 'Continue', hint: 'Carry on.', primary: true },
  { value: 'retry' as const, label: 'Request changes', hint: 'Send it back.', primary: false },
  { value: 'abort' as const, label: 'Abort run', hint: 'Stop here.', primary: false },
];

function renderOverlay(overrides: Partial<ReviewOverlayProps> = {}) {
  const onResolve = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  const onRefreshDiff = vi.fn();
  const props: ReviewOverlayProps = {
    request: request(),
    diff: null,
    diffLoading: false,
    diffError: null,
    onRefreshDiff,
    onClose,
    onResolve,
    fs: new FakeFileSystem(),
    ...overrides,
  };
  const view = render(<ReviewOverlay {...props} />);
  return { ...view, onResolve, onClose, onRefreshDiff, props };
}

describe('ReviewOverlay', () => {
  it('leads with the question', () => {
    renderOverlay();
    expect(screen.getByText('Ship it?')).toBeInTheDocument();
    expect(screen.getByText('Decision needed')).toBeInTheDocument();
  });

  it('spends no vertical space on the instructions', () => {
    // They restate what the rail already lists, and this screen exists to give
    // the change set room — so they live in the tooltip, never in the header's
    // own flow. (Fluent keeps tooltip content mounted, so this is about *where*
    // the text is, not whether it exists.)
    renderOverlay();
    const text = screen.getByText('Review the diff and the findings.');
    expect(text.closest('[role="tooltip"]')).not.toBeNull();
  });

  it('shows the instructions on the badge, reachable by keyboard', async () => {
    renderOverlay();
    fireEvent.focus(screen.getByTestId('review-instructions'));
    expect(await screen.findByRole('tooltip'))
      .toHaveTextContent('Review the diff and the findings.');
  });

  it('carries no aria-hidden, which is the Modalizer regression this design avoids', () => {
    renderOverlay();
    expect(screen.getByTestId('review-overlay')).not.toHaveAttribute('aria-hidden');
  });

  it('does not close on Escape', () => {
    // The run cannot proceed until this is answered; a keystroke that dropped
    // the review would be data loss.
    const { onClose } = renderOverlay();
    fireEvent.keyDown(screen.getByTestId('review-overlay'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('leaves by the explicit button', () => {
    const { onClose } = renderOverlay();
    fireEvent.click(screen.getByTestId('review-close'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('sends the choice that was clicked', async () => {
    const { onResolve } = renderOverlay();
    fireEvent.click(screen.getByTestId('review-choice-abort'));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith('abort', undefined, undefined));
  });

  it('gates only continue on a required note', async () => {
    const { onResolve } = renderOverlay({
      request: request({ capture: { kind: 'note', label: 'Note', requiredFor: ['continue'], perFile: false } }),
    });
    expect(screen.getByTestId('review-choice-continue')).toBeDisabled();
    // Abort needs no note — it does not write one.
    expect(screen.getByTestId('review-choice-abort')).not.toBeDisabled();

    fireEvent.change(screen.getByTestId('review-note'), { target: { value: 'looks good' } });
    expect(screen.getByTestId('review-choice-continue')).not.toBeDisabled();

    fireEvent.click(screen.getByTestId('review-choice-continue'));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith('continue', 'looks good', undefined));
  });

  it('gates retry, not continue, on a required note under capture: review', async () => {
    const { onResolve } = renderOverlay({
      request: request({
        choices: [
          { value: 'continue', label: 'Continue', hint: 'Carry on.', primary: true },
          { value: 'retry', label: 'Request changes', hint: 'Send it back.', primary: false },
        ],
        capture: { kind: 'review', label: 'Feedback', requiredFor: ['retry'], perFile: true },
      }),
    });
    expect(screen.getByTestId('review-choice-continue')).not.toBeDisabled();
    expect(screen.getByTestId('review-choice-retry')).toBeDisabled();

    fireEvent.change(screen.getByTestId('review-note'), { target: { value: 'please fix the naming' } });
    expect(screen.getByTestId('review-choice-retry')).not.toBeDisabled();

    fireEvent.click(screen.getByTestId('review-choice-retry'));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith('retry', 'please fix the naming', undefined));
  });

  it('surfaces a rejected answer inline rather than throwing at the page', async () => {
    const onResolve = vi.fn().mockRejectedValue(new Error('This step is no longer waiting.'));
    renderOverlay({ onResolve });
    fireEvent.click(screen.getByTestId('review-choice-continue'));
    expect(await screen.findByTestId('review-error')).toHaveTextContent('no longer waiting');
    // And the buttons come back, so the human is not stranded.
    await waitFor(() => expect(screen.getByTestId('review-choice-abort')).not.toBeDisabled());
  });

  it('lists the sources it was given and selects the first', () => {
    renderOverlay({
      request: request({
        sources: [
          { kind: 'diff', id: DIFF_SOURCE_ID, label: 'Changes' },
          { kind: 'artifact', id: 'review', path: '/r/review.md', label: 'review.md' },
        ],
      }),
      diff: DIFF,
    });
    expect(screen.getByTestId(`review-source-${DIFF_SOURCE_ID}`)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('review-source-review')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('diff-grid')).toBeInTheDocument();
  });

  it('switches to an artifact when its rail row is picked', () => {
    renderOverlay({
      request: request({
        sources: [
          { kind: 'diff', id: DIFF_SOURCE_ID, label: 'Changes' },
          { kind: 'artifact', id: 'review', path: '/r/review.md', label: 'review.md' },
        ],
      }),
      diff: DIFF,
    });
    fireEvent.click(screen.getByTestId('review-source-review'));
    expect(screen.queryByTestId('diff-grid')).toBeNull();
  });

  it('says the workspace is not a repo rather than showing an empty diff', () => {
    // null is "not a git repo" and only that — a clean tree is a different
    // sentence, and conflating them is how a review screen lies.
    renderOverlay({
      request: request({ sources: [{ kind: 'diff', id: DIFF_SOURCE_ID, label: 'Changes' }] }),
      diff: null,
    });
    expect(screen.getByTestId('empty-state')).toHaveTextContent("isn't a git repository");
  });

  it('distinguishes a clean tree from a missing repo', () => {
    renderOverlay({
      request: request({ sources: [{ kind: 'diff', id: DIFF_SOURCE_ID, label: 'Changes' }] }),
      diff: { files: [] },
    });
    expect(screen.getByTestId('empty-state')).toHaveTextContent('No changes in the working tree.');
  });

  it('surfaces a failed diff read instead of showing nothing', () => {
    renderOverlay({
      request: request({ sources: [{ kind: 'diff', id: DIFF_SOURCE_ID, label: 'Changes' }] }),
      diffError: 'git exploded',
    });
    expect(screen.getByTestId('review-diff-error')).toHaveTextContent('git exploded');
  });

  it('re-reads the working tree on demand', () => {
    const { onRefreshDiff } = renderOverlay({
      request: request({ sources: [{ kind: 'diff', id: DIFF_SOURCE_ID, label: 'Changes' }] }),
      diff: DIFF,
    });
    fireEvent.click(screen.getByTestId('review-diff-refresh'));
    expect(onRefreshDiff).toHaveBeenCalledOnce();
  });

  it('offers Refresh in the states where re-reading is what you want', () => {
    // Burying it in the success case put the button everywhere except the
    // error, not-a-repo and empty-tree states it exists for.
    const sources = [{ kind: 'diff' as const, id: DIFF_SOURCE_ID, label: 'Changes' }];
    for (const props of [
      { diffError: 'git exploded' },
      { diff: null },
      { diff: { files: [] } as WorkingDiff },
      { diff: DIFF },
    ]) {
      const view = render(
        <ReviewOverlay
          request={request({ sources })}
          diff={null}
          diffLoading={false}
          diffError={null}
          onRefreshDiff={vi.fn()}
          onClose={vi.fn()}
          onResolve={vi.fn()}
          fs={new FakeFileSystem()}
          {...props}
        />,
      );
      expect(view.getByTestId('review-diff-refresh')).toBeInTheDocument();
      view.unmount();
    }
  });

  it('says so when a decision has nothing attached', () => {
    renderOverlay();
    expect(screen.getByTestId('empty-state')).toHaveTextContent('Nothing was attached');
  });

  it('does not let a second question inherit the first one\'s draft note', () => {
    const capture = { kind: 'note' as const, label: 'Note', requiredFor: ['continue' as const], perFile: false };
    const { rerender, props } = renderOverlay({
      request: request({ key: 'sign#1', capture }),
    });
    fireEvent.change(screen.getByTestId('review-note'), { target: { value: 'first answer' } });
    expect(screen.getByTestId('review-note')).toHaveValue('first answer');

    // The same step, next time round the loop, is a different question.
    rerender(<ReviewOverlay {...props} request={request({ key: 'sign#2', capture })} />);
    expect(screen.getByTestId('review-note')).toHaveValue('');
  });

  it('offers no per-file comment box unless the capture kind asks for one', () => {
    renderOverlay({ request: request({ sources: REVIEW_SOURCES }), diff: DIFF });
    expect(screen.queryByTestId('review-comment-toggle')).toBeNull();
  });

  it('round-trips a per-file comment into the resolved answer', async () => {
    const { onResolve } = renderOverlay({
      request: request({ sources: REVIEW_SOURCES, choices: REVIEW_CHOICES, capture: REVIEW_CAPTURE }),
      diff: DIFF,
    });
    fireEvent.click(screen.getByTestId('review-comment-toggle'));
    fireEvent.change(screen.getByTestId('review-file-comment'), { target: { value: 'fix the naming here' } });
    fireEvent.change(screen.getByTestId('review-note'), { target: { value: 'a couple of things' } });

    expect(screen.getByTestId('review-file-comment-count')).toHaveTextContent('1 file comment');

    fireEvent.click(screen.getByTestId('review-choice-retry'));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith(
      'retry', 'a couple of things', [{ path: 'src/x.ts', body: 'fix the naming here' }],
    ));
  });

  it('drops blank per-file comments rather than sending empty ones', async () => {
    const { onResolve } = renderOverlay({
      request: request({ sources: REVIEW_SOURCES, capture: REVIEW_CAPTURE }),
      diff: DIFF,
    });
    fireEvent.click(screen.getByTestId('review-comment-toggle'));
    fireEvent.change(screen.getByTestId('review-file-comment'), { target: { value: '   ' } });
    fireEvent.change(screen.getByTestId('review-note'), { target: { value: 'ship it' } });
    expect(screen.queryByTestId('review-file-comment-count')).toBeNull();

    fireEvent.click(screen.getByTestId('review-choice-continue'));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith('continue', 'ship it', undefined));
  });

  it('auto-expands a file that already has a comment, and dots it in the rail', () => {
    renderOverlay({
      request: request({ sources: REVIEW_SOURCES, capture: REVIEW_CAPTURE }),
      diff: TWO_FILE_DIFF,
    });
    // Comment on the first file (selected by default), then switch away.
    fireEvent.click(screen.getByTestId('review-comment-toggle'));
    fireEvent.change(screen.getByTestId('review-file-comment'), { target: { value: 'left a note' } });
    fireEvent.click(screen.getByTestId('diff-file-src/y.ts'));

    // The rail marks the commented file without having to click back into it.
    expect(screen.getByTestId('diff-file-commented-src/x.ts')).toBeInTheDocument();
    expect(screen.queryByTestId('diff-file-commented-src/y.ts')).toBeNull();

    // Switching back shows the comment already expanded, not collapsed behind a click.
    fireEvent.click(screen.getByTestId('diff-file-src/x.ts'));
    expect(screen.getByTestId('review-file-comment')).toHaveValue('left a note');
  });

  it('keeps a per-file draft when the same question is still on screen', () => {
    // The overlay is kept mounted (not unmounted) across the desktop's own
    // close/reopen toggle — see RunDetailPage's display:none pattern — so a
    // rerender that does not change request.key must not lose a draft.
    const { rerender, props } = renderOverlay({
      request: request({ sources: REVIEW_SOURCES, capture: REVIEW_CAPTURE }),
      diff: DIFF,
    });
    fireEvent.click(screen.getByTestId('review-comment-toggle'));
    fireEvent.change(screen.getByTestId('review-file-comment'), { target: { value: 'still true' } });

    rerender(<ReviewOverlay {...props} diff={DIFF} />);
    expect(screen.getByTestId('review-file-comment')).toHaveValue('still true');
  });
});
