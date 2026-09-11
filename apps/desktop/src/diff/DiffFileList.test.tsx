import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DiffFileList } from './DiffFileList.tsx';
import type { DiffFileEntry } from './types.ts';

function entry(overrides: Partial<DiffFileEntry> = {}): DiffFileEntry {
  return {
    path: 'src/x.ts',
    status: 'modified',
    additions: 1,
    deletions: 1,
    binary: false,
    patch: '',
    ...overrides,
  };
}

describe('DiffFileList', () => {
  it('positions every row, so its hidden label never escapes to the page', () => {
    // jsdom has no layout, so the symptom (a blank, scrollable strip below the
    // app) cannot be observed here. The cause can: an absolutely positioned
    // label with no positioned ancestor is laid out against the page, where
    // the rail's overflow does not clip it and a long list grows the document.
    const files = [entry({ path: 'a.ts' }), entry({ path: 'b.ts' }), entry({ path: 'c.ts' })];
    render(<DiffFileList files={files} selectedPath={null} onSelect={() => {}} />);
    const rows = screen.getAllByRole('option');
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.style.position).toBe('relative');
  });

  it('names each row with its status as a word, and whether it has a comment', () => {
    render(
      <DiffFileList
        files={[
          entry({ path: 'src/new.ts', status: 'added' }),
          entry({ path: 'src/gone.ts', status: 'deleted' }),
        ]}
        selectedPath={null}
        onSelect={() => {}}
        commentedPaths={new Set(['src/new.ts'])}
      />,
    );
    // The status letter is aria-hidden; the word is what a screen reader hears.
    expect(screen.getByTestId('diff-file-src/new.ts')).toHaveAccessibleName(/added, commented/);
    expect(screen.getByTestId('diff-file-src/gone.ts')).toHaveAccessibleName(/deleted/);
    expect(screen.getByTestId('diff-file-src/gone.ts')).not.toHaveAccessibleName(/commented/);
  });
});
