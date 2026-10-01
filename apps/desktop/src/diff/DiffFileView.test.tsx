import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DiffFileView } from './DiffFileView.tsx';
import type { DiffFileEntry } from './types.ts';
import { setVirtualViewportHeight, VIRTUAL_ROW_HEIGHT } from '../test/setup.ts';

function entry(overrides: Partial<DiffFileEntry> = {}): DiffFileEntry {
  return {
    path: 'src/x.ts',
    status: 'modified',
    additions: 1,
    deletions: 1,
    binary: false,
    patch: [
      'diff --git a/src/x.ts b/src/x.ts',
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      '@@ -10,3 +10,3 @@ fn ctx',
      ' keep',
      '-old',
      '+new',
    ].join('\n'),
    ...overrides,
  };
}

beforeEach(() => localStorage.clear());

describe('DiffFileView', () => {
  it('gives every row exactly four cells, which is what keeps the sides aligned', () => {
    // jsdom has no layout, so visual alignment cannot be asserted directly.
    // Four cells per row is the structural property the single-grid design
    // guarantees, so it is testable at the level where it is guaranteed.
    const { container } = render(<DiffFileView file={entry()} />);
    const cells = [...container.querySelectorAll('[data-row]')];
    const byRow = new Map<string, number>();
    for (const cell of cells) {
      const row = cell.getAttribute('data-row')!;
      byRow.set(row, (byRow.get(row) ?? 0) + 1);
    }
    // The hunk header spans all four columns as a single cell; content rows
    // are four apiece.
    const contentRows = [...byRow.entries()].filter(([row]) => row !== '0');
    expect(contentRows.length).toBeGreaterThan(0);
    for (const [, count] of contentRows) expect(count).toBe(4);
  });

  it('numbers both sides and marks each cell with its kind', () => {
    const { container } = render(<DiffFileView file={entry()} />);
    const kinds = [...container.querySelectorAll('[data-side="left"]')]
      .map(el => el.getAttribute('data-kind'));
    expect(kinds).toEqual(['context', 'del']);

    const right = [...container.querySelectorAll('[data-side="right"]')]
      .map(el => el.getAttribute('data-kind'));
    expect(right).toEqual(['context', 'add']);
  });

  it('pairs the deleted line opposite its replacement', () => {
    const { container } = render(<DiffFileView file={entry()} />);
    const del = container.querySelector('[data-side="left"][data-kind="del"]');
    const add = container.querySelector('[data-side="right"][data-kind="add"]');
    expect(del).toHaveTextContent('-old');
    expect(add).toHaveTextContent('+new');
    // Opposite each other means the same row.
    expect(del!.getAttribute('data-row')).toBe(add!.getAttribute('data-row'));
  });

  it('renders an empty counterpart cell for a pure insertion, hidden from screen readers', () => {
    const file = entry({
      patch: 'diff --git a/n b/n\n--- /dev/null\n+++ b/n\n@@ -0,0 +1 @@\n+only\n',
    });
    const { container } = render(<DiffFileView file={file} />);
    const empty = container.querySelector('[data-side="left"][data-kind="empty"]');
    expect(empty).toBeInTheDocument();
    expect(empty).toHaveTextContent('');
    // Its gutter is decorative; announcing 400 blank line numbers is noise.
    expect(container.querySelector('[data-kind="empty"][aria-hidden="true"]')).toBeInTheDocument();
  });

  it('switches to a unified column and remembers the choice', () => {
    const { container, unmount } = render(<DiffFileView file={entry()} />);
    expect(container.querySelectorAll('[data-side="left"]').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('switch', { name: /side by side/i }));
    expect(container.querySelectorAll('[data-side="left"]')).toHaveLength(0);
    unmount();

    const again = render(<DiffFileView file={entry()} />);
    expect(again.container.querySelectorAll('[data-side="left"]')).toHaveLength(0);
  });

  it('shows counts rather than an empty pane when the patch was dropped for size', () => {
    render(<DiffFileView file={entry({ patch: undefined, truncated: true, additions: 900 })} />);
    expect(screen.getByTestId('empty-state')).toHaveTextContent('Too large to show here');
    expect(screen.getByTestId('empty-state')).toHaveTextContent('900 added');
  });

  it('says so for a binary file instead of drawing an empty grid', () => {
    render(<DiffFileView file={entry({ binary: true, patch: undefined })} />);
    expect(screen.getByTestId('empty-state')).toHaveTextContent('Binary file');
  });

  it('refuses a mid-merge combined diff rather than showing a misread one', () => {
    const file = entry({ patch: 'diff --git a/x b/x\n@@@ -1,1 -1,1 +1,1 @@@\n- a\n +b\n' });
    render(<DiffFileView file={file} />);
    expect(screen.getByTestId('empty-state')).toHaveTextContent('mid-merge');
  });

  it('reports a file that only changed its line endings', () => {
    const file = entry({
      patch: 'diff --git a/x b/x\n@@ -1,2 +1,2 @@\n-a\r\n-b\r\n+a\n+b\n',
    });
    render(<DiffFileView file={file} />);
    expect(screen.getByTestId('diff-line-endings-only')).toBeInTheDocument();
  });

  it('does not claim "no changes" for a file whose patch core had to drop', () => {
    // The pairing guard drops every patch rather than risk mispairing one.
    // Counts survive, so saying "no textual changes" would be a lie on the one
    // screen that must not tell one.
    render(<DiffFileView file={entry({ patch: undefined, additions: 12, deletions: 3 })} />);
    const state = screen.getByTestId('empty-state');
    expect(state).toHaveTextContent("Couldn't show this file's changes");
    expect(state).toHaveTextContent('+12');
    expect(state).not.toHaveTextContent('No textual changes');
  });

  it('still says "no textual changes" for a file that really has none', () => {
    render(<DiffFileView file={entry({ patch: undefined, additions: 0, deletions: 0 })} />);
    expect(screen.getByTestId('empty-state')).toHaveTextContent('No textual changes');
  });

  it('keeps the line-endings warning when the unified view is chosen', () => {
    // It is a fact about the file, not about how it is being looked at.
    const file = entry({ patch: 'diff --git a/x b/x\n@@ -1,2 +1,2 @@\n-a\r\n-b\r\n+a\n+b\n' });
    render(<DiffFileView file={file} />);
    fireEvent.click(screen.getByRole('switch', { name: /side by side/i }));
    expect(screen.getByTestId('diff-line-endings-only')).toBeInTheDocument();
  });

  it('names a rename with both paths', () => {
    render(<DiffFileView file={entry({ oldPath: 'src/old.ts', status: 'renamed' })} />);
    expect(screen.getByTestId('diff-file-path')).toHaveTextContent('src/old.ts → src/x.ts');
  });

  describe('a file past the old 2000-row cap', () => {
    const LINES = 5000;
    const big = () => entry({
      additions: LINES, deletions: 0,
      patch: [
        'diff --git a/big.txt b/big.txt', '--- a/big.txt', '+++ b/big.txt', `@@ -0,0 +1,${LINES} @@`,
        ...Array.from({ length: LINES }, (_, i) => `+line ${i + 1}`),
      ].join('\n'),
    });
    /** One wrapper per drawn row (see DiffFileView's subgrid rows). */
    const drawnRows = (container: HTMLElement) => container.querySelectorAll('[data-index]');

    it('draws the whole file instead of cutting it off', () => {
      render(<DiffFileView file={big()} />);
      expect(screen.queryByText(/more lines/)).toBeNull();
      expect(screen.getByText(`+line ${LINES}`)).toBeInTheDocument();
    });

    it('keeps only the rows near the viewport in the DOM, and scrolls to the rest', async () => {
      setVirtualViewportHeight(400);
      const { container } = render(<DiffFileView file={big()} />);
      expect(screen.getByText('+line 1')).toBeInTheDocument();
      expect(screen.queryByText(`+line ${LINES}`)).toBeNull();
      expect(drawnRows(container).length).toBeLessThan(100);

      const scroller = container.querySelector('[data-virtual-scroller]') as HTMLElement;
      // jsdom does not keep a scrollTop it cannot lay out; pin one past the end.
      Object.defineProperty(scroller, 'scrollTop', { value: LINES * VIRTUAL_ROW_HEIGHT, configurable: true, writable: true });
      fireEvent.scroll(scroller);
      expect(await screen.findByText(`+line ${LINES}`)).toBeInTheDocument();
      expect(screen.queryByText('+line 1')).toBeNull();
    });
  });
});
