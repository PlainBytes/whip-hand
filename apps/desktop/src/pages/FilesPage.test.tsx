import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FakeFileSystem } from '../files/fake-fs.ts';
import { FileSystemProvider } from '../files/fs-context.tsx';
import { useAppStore } from '../state/store.ts';
import { FilesPage } from './FilesPage.tsx';

function workspace(): FakeFileSystem {
  const fs = new FakeFileSystem();
  fs.setFile('/ws/README.md', '# Readme');
  fs.setFile('/ws/notes.md', '# Notes');
  fs.setFile('/ws/docs/design.md', '# Design');
  return fs;
}

function renderFilesPage(fs: FakeFileSystem) {
  useAppStore.setState({ workspacePath: '/ws' });
  render(
    <FileSystemProvider fs={fs}>
      <FilesPage />
    </FileSystemProvider>,
  );
}

/**
 * Operations moved from a page toolbar onto the tree rows, so tests drive
 * them the way a user does: point at the row, click its action. Fluent only
 * renders a row's actions while it is hovered, focused or selected.
 */
function rowAction(rowName: string, action: RegExp) {
  fireEvent.mouseOver(screen.getByText(rowName));
  fireEvent.click(screen.getByRole('button', { name: action }));
}

describe('FilesPage', () => {
  afterEach(() => useAppStore.setState({ workspacePath: null }));

  it('previews the file clicked in the tree', async () => {
    renderFilesPage(workspace());
    fireEvent.click(await screen.findByText('README.md'));
    expect(await screen.findByRole('heading', { name: 'Readme' })).toBeInTheDocument();
  });

  it('follows the open file as something else writes it', async () => {
    // The Files pane watches whatever is open: a run (or another editor)
    // writing the previewed file should show up without a re-select.
    const fs = workspace();
    renderFilesPage(fs);
    fireEvent.click(await screen.findByText('README.md'));
    await screen.findByRole('heading', { name: 'Readme' });

    fs.setFileSilently('/ws/README.md', '# Readme\n\n## Appended');
    act(() => fs.emitFileChange('/ws/README.md'));

    expect(await screen.findByRole('heading', { name: 'Appended' })).toBeInTheDocument();
  });

  it('switches preview when another file is clicked', async () => {
    renderFilesPage(workspace());
    fireEvent.click(await screen.findByText('README.md'));
    await screen.findByRole('heading', { name: 'Readme' });
    fireEvent.click(screen.getByText('notes.md'));
    expect(await screen.findByRole('heading', { name: 'Notes' })).toBeInTheDocument();
  });

  it('warns before leaving a file with unsaved edits, and stays put when told to', async () => {
    renderFilesPage(workspace());
    fireEvent.click(await screen.findByText('README.md'));
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unsaved' } });

    fireEvent.click(screen.getByText('notes.md'));
    expect(await screen.findByText(/unsaved changes/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /keep editing/i }));
    expect(screen.getByRole('textbox')).toHaveValue('unsaved');
  });

  it('moves on and drops the edits when discard is confirmed', async () => {
    renderFilesPage(workspace());
    fireEvent.click(await screen.findByText('README.md'));
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unsaved' } });
    fireEvent.click(screen.getByText('notes.md'));
    fireEvent.click(await screen.findByRole('button', { name: /discard/i }));
    expect(await screen.findByRole('heading', { name: 'Notes' })).toBeInTheDocument();
  });

  it('warns before leaving a file with unsaved edits, even when the next click is a directory', async () => {
    renderFilesPage(workspace());
    fireEvent.click(await screen.findByText('README.md'));
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unsaved' } });

    // 'docs' is a directory, not a file — it must not bypass the guard.
    fireEvent.click(screen.getByText('docs'));
    expect(await screen.findByText(/unsaved changes/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /keep editing/i }));
    expect(screen.getByRole('textbox')).toHaveValue('unsaved');
  });

  it('tells the user to open a workspace when there is none', async () => {
    useAppStore.setState({ workspacePath: null });
    render(
      <FileSystemProvider fs={workspace()}>
        <FilesPage />
      </FileSystemProvider>,
    );
    await waitFor(() => expect(screen.getByText(/open a workspace/i)).toBeInTheDocument());
  });
});

describe('FilesPage markdown navigation', () => {
  afterEach(() => useAppStore.setState({ workspacePath: null }));

  it('opens the file a markdown link points at, and reveals it in the tree', async () => {
    const fs = new FakeFileSystem();
    fs.setFile('/ws/plan.md', 'see [review](./docs/review.md)');
    fs.setFile('/ws/docs/review.md', '# Findings');
    renderFilesPage(fs);

    fireEvent.click(await screen.findByText('plan.md'));
    fireEvent.click(await screen.findByRole('link', { name: 'review' }));

    expect(await screen.findByRole('heading', { name: 'Findings' })).toBeInTheDocument();
    // The tree expanded to show where the reader landed: docs/ was collapsed
    // (and unlisted) until the link was followed.
    expect(await screen.findByText('review.md')).toBeInTheDocument();
  });
});

describe('FilesPage file operations', () => {
  it('creates a new file in the folder whose row action was used, and opens it for editing', async () => {
    const fs = workspace();
    renderFilesPage(fs);
    await screen.findByText('docs');
    rowAction('docs', /new file in docs/i);
    fireEvent.change(screen.getByRole('textbox', { name: /name/i }), { target: { value: 'todo.md' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(async () => {
      await expect(fs.exists('/ws/docs/todo.md')).resolves.toBe(true);
    });
    expect(await screen.findByRole('textbox')).toBeInTheDocument();
  });

  it('refuses a name that already exists', async () => {
    renderFilesPage(workspace());
    await screen.findByText('README.md');
    fireEvent.click(screen.getByRole('button', { name: /new file in ws/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /name/i }), { target: { value: 'README.md' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
  });

  it('refuses a name containing a path separator', async () => {
    renderFilesPage(workspace());
    await screen.findByText('README.md');
    fireEvent.click(screen.getByRole('button', { name: /new file in ws/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /name/i }), { target: { value: '../escape.md' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    expect(await screen.findByText(/cannot contain/i)).toBeInTheDocument();
  });

  it('creates a new folder', async () => {
    const fs = workspace();
    renderFilesPage(fs);
    await screen.findByText('README.md');
    fireEvent.click(screen.getByRole('button', { name: /new folder in ws/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /name/i }), { target: { value: 'ideas' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    expect(await screen.findByText('ideas')).toBeInTheDocument();
  });

  it('renames the selected file and keeps previewing it under its new name', async () => {
    const fs = workspace();
    renderFilesPage(fs);
    fireEvent.click(await screen.findByText('README.md'));
    await screen.findByRole('heading', { name: 'Readme' });
    rowAction('README.md', /rename README\.md/i);
    fireEvent.change(screen.getByRole('textbox', { name: /name/i }), { target: { value: 'GUIDE.md' } });
    // Scoped to the dialog: the toolbar has a "Rename" button too, so an
    // unscoped query matches two elements and throws.
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^rename$/i }));

    expect(await screen.findByText('GUIDE.md')).toBeInTheDocument();
    await waitFor(async () => {
      await expect(fs.exists('/ws/README.md')).resolves.toBe(false);
    });
  });

  it('deletes the selected file after confirmation and clears the preview', async () => {
    const fs = workspace();
    renderFilesPage(fs);
    fireEvent.click(await screen.findByText('notes.md'));
    await screen.findByRole('heading', { name: 'Notes' });
    rowAction('notes.md', /delete notes\.md/i);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    await waitFor(async () => {
      await expect(fs.exists('/ws/notes.md')).resolves.toBe(false);
    });
    expect(await screen.findByText(/select a file/i)).toBeInTheDocument();
  });

  it('spells out that deleting a folder takes its contents with it', async () => {
    renderFilesPage(workspace());
    await screen.findByText('docs');
    rowAction('docs', /delete docs/i);
    expect(await screen.findByText(/everything inside it/i)).toBeInTheDocument();
  });
});

/**
 * The toolbar operations retarget or drop the previewed file without going
 * through select(), so each one has to consult the dirty guard itself.
 */
describe('FilesPage toolbar operations with unsaved edits', () => {
  afterEach(() => useAppStore.setState({ workspacePath: null, filesDirty: false }));

  async function editReadme(): Promise<void> {
    fireEvent.click(await screen.findByText('README.md'));
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unsaved' } });
    await waitFor(() => expect(useAppStore.getState().filesDirty).toBe(true));
  }

  it('warns before a rename discards unsaved edits, and keeps them when told to', async () => {
    renderFilesPage(workspace());
    await editReadme();

    rowAction('README.md', /rename README\.md/i);
    expect(await screen.findByText(/unsaved changes/i)).toBeInTheDocument();
    // The rename dialog must not have opened behind the warning.
    expect(screen.queryByRole('textbox', { name: /name/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /keep editing/i }));
    expect(screen.getByRole('textbox')).toHaveValue('unsaved');
  });

  it('opens the rename dialog once the discard is confirmed', async () => {
    const fs = workspace();
    renderFilesPage(fs);
    await editReadme();

    rowAction('README.md', /rename README\.md/i);
    fireEvent.click(await screen.findByRole('button', { name: /discard/i }));

    const nameField = await screen.findByRole('textbox', { name: /name/i });
    fireEvent.change(nameField, { target: { value: 'GUIDE.md' } });
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^rename$/i }));

    expect(await screen.findByText('GUIDE.md')).toBeInTheDocument();
    // The pre-edit contents move with the file: the draft was discarded, not saved.
    await waitFor(async () => {
      expect(new TextDecoder().decode(await fs.readFile('/ws/GUIDE.md'))).toBe('# Readme');
    });
  });

  it('warns before a delete discards unsaved edits', async () => {
    renderFilesPage(workspace());
    await editReadme();

    rowAction('README.md', /delete README\.md/i);
    expect(await screen.findByText(/unsaved changes/i)).toBeInTheDocument();
    expect(screen.queryByText(/cannot be undone/i)).not.toBeInTheDocument();
  });

  it('warns before a new file discards unsaved edits', async () => {
    renderFilesPage(workspace());
    await editReadme();

    fireEvent.click(screen.getByRole('button', { name: /new file/i }));
    expect(await screen.findByText(/unsaved changes/i)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /name/i })).not.toBeInTheDocument();
  });
});

/**
 * selectedPath is only ever set by a click or a file operation, so anything
 * that invalidates it from the outside has to be noticed explicitly.
 */
describe('FilesPage selection invalidation', () => {
  afterEach(() => useAppStore.setState({ workspacePath: null, filesDirty: false }));

  it('drops a selection left over from the previous workspace', async () => {
    const fs = workspace();
    fs.setFile('/other/elsewhere.md', '# Elsewhere');
    renderFilesPage(fs);
    fireEvent.click(await screen.findByText('README.md'));
    await screen.findByRole('heading', { name: 'Readme' });

    // The workspace picker lives in the always-visible header, so this can
    // happen while the Files tab is open and a file is being previewed.
    act(() => useAppStore.setState({ workspacePath: '/other' }));

    expect(await screen.findByText(/select a file/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Readme' })).not.toBeInTheDocument();
    expect(await screen.findByText('elsewhere.md')).toBeInTheDocument();
  });

  it('clears the selection when the selected file vanishes from a refreshed listing', async () => {
    const fs = workspace();
    renderFilesPage(fs);
    fireEvent.click(await screen.findByText('notes.md'));
    await screen.findByRole('heading', { name: 'Notes' });

    // Deleted by something else — the watcher re-lists /ws and the node goes
    // away, leaving selectedPath dangling (and Delete offering "Delete ?").
    await fs.remove('/ws/notes.md');

    expect(await screen.findByText(/select a file/i)).toBeInTheDocument();
    // The row is gone too, so nothing is left holding the stale path — the
    // toolbar button this used to assert on no longer exists; operations
    // live on the rows.
    expect(screen.queryByText('notes.md')).not.toBeInTheDocument();
  });
});

describe('FilesPage editor actions', () => {
  it('offers Edit once, beside the file it acts on', async () => {
    renderFilesPage(workspace());
    fireEvent.click(await screen.findByText('README.md'));
    await screen.findByRole('heading', { name: 'Readme' });

    // Exactly one: the pane owns these controls outright now, and two copies
    // of Save would be both confusing and ambiguous to a test.
    expect(screen.getAllByRole('button', { name: /^edit$/i })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(screen.getAllByRole('button', { name: /^save$/i })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /^cancel$/i })).toHaveLength(1);
  });

  it('retracts the actions when no file is open', async () => {
    renderFilesPage(workspace());
    await screen.findByText('README.md');
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
  });
});

describe('FilesPage actions that do not touch the draft', () => {
  // Each action now names its own target, so the guard can tell whether it
  // actually endangers the draft. Deleting something else must not interrupt.
  it('deletes an unrelated file without warning about unsaved edits', async () => {
    const fs = workspace();
    renderFilesPage(fs);
    fireEvent.click(await screen.findByText('README.md'));
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unsaved' } });

    rowAction('notes.md', /delete notes\.md/i);

    expect(screen.queryByText(/unsaved changes/i)).not.toBeInTheDocument();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    await waitFor(async () => {
      await expect(fs.exists('/ws/notes.md')).resolves.toBe(false);
    });
    // The draft survived: the pane was never retargeted.
    expect(screen.getByRole('textbox')).toHaveValue('unsaved');
  });

  it('creates a folder without warning about unsaved edits', async () => {
    renderFilesPage(workspace());
    fireEvent.click(await screen.findByText('README.md'));
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unsaved' } });

    rowAction('docs', /new folder in docs/i);

    expect(screen.queryByText(/unsaved changes/i)).not.toBeInTheDocument();
    expect(await screen.findByRole('textbox', { name: /name/i })).toBeInTheDocument();
  });
});
