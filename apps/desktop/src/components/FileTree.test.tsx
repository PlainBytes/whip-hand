import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { Switch } from '@fluentui/react-components';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FakeFileSystem } from '../files/fake-fs.ts';
import { FileSystemProvider } from '../files/fs-context.tsx';
import { useFileTree } from '../files/use-file-tree.ts';
import { FileTree, type FileTreeActions } from './FileTree.tsx';
import type { TreeNodes } from '../files/tree-model.ts';
import { setVirtualViewportHeight, triggerResize, VIRTUAL_ROW_HEIGHT } from '../test/setup.ts';
import { hasInjectedStyle } from '../test/badge-style.ts';

/**
 * The "Show hidden files" Switch now lives in FilesPage's PageHeader, not in
 * FileTree, so the harness renders it here — the behaviour it drives (the
 * hook's filter) is still FileTree's to prove.
 */
function Harness({ root, ...actions }: { root: string } & Partial<FileTreeActions>) {
  const tree = useFileTree(root);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  return (
    <>
      <Switch
        checked={tree.showHidden}
        onChange={(_event, data) => tree.setShowHidden(data.checked)}
        label="Show hidden files"
      />
      <FileTree
        root={root}
        nodes={tree.nodes}
        expanded={tree.expanded}
        selectedPath={selectedPath}
        onToggle={tree.toggle}
        onSelect={setSelectedPath}
        {...actions}
      />
    </>
  );
}

function renderTree(fs: FakeFileSystem, root = '/ws', actions: Partial<FileTreeActions> = {}) {
  return render(
    <FileSystemProvider fs={fs}>
      <Harness root={root} {...actions} />
    </FileSystemProvider>,
  );
}

function workspace(): FakeFileSystem {
  const fs = new FakeFileSystem();
  fs.setFile('/ws/README.md', '# hi');
  fs.setFile('/ws/docs/design.md', '# design');
  fs.setFile('/ws/.whiphand/workflows/feature.yaml', 'name: feature');
  fs.setFile('/ws/.env', 'SECRET=1');
  fs.setFile('/ws/node_modules/left-pad/index.js', 'x');
  return fs;
}

describe('FileTree', () => {
  it('grants the workspace root before listing it', async () => {
    const fs = workspace();
    renderTree(fs);
    await waitFor(() => expect(fs.grantedRoots).toEqual(['/ws']));
  });

  it('lists the root, hiding noise but keeping .whiphand', async () => {
    renderTree(workspace());
    expect(await screen.findByText('README.md')).toBeInTheDocument();
    expect(screen.getByText('docs')).toBeInTheDocument();
    expect(screen.getByText('.whiphand')).toBeInTheDocument();
    expect(screen.queryByText('.env')).not.toBeInTheDocument();
    expect(screen.queryByText('node_modules')).not.toBeInTheDocument();
  });

  it('keeps row labels on one line so deep names scroll instead of wrapping', async () => {
    renderTree(workspace());
    const label = await screen.findByText('README.md');
    expect(label).toHaveStyle({ whiteSpace: 'nowrap' });
  });

  it('loads a directory lazily, only when it is expanded', async () => {
    renderTree(workspace());
    await screen.findByText('docs');
    expect(screen.queryByText('design.md')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('docs'));
    expect(await screen.findByText('design.md')).toBeInTheDocument();
  });

  it('reveals hidden entries when the toggle is switched on', async () => {
    renderTree(workspace());
    await screen.findByText('README.md');
    fireEvent.click(screen.getByRole('switch', { name: /hidden/i }));
    expect(await screen.findByText('.env')).toBeInTheDocument();
    expect(screen.getByText('node_modules')).toBeInTheDocument();
  });

  it('shows an unreadable directory as an error instead of breaking the tree', async () => {
    const fs = workspace();
    fs.setDir('/ws/secret');
    fs.setError('/ws/secret', 'permission denied');
    renderTree(fs);
    fireEvent.click(await screen.findByText('secret'));
    expect(await screen.findByText(/permission denied/i)).toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeInTheDocument();
  });
});

describe('FileTree watching', () => {
  it('re-lists a watched directory when it changes on disk', async () => {
    const fs = workspace();
    renderTree(fs);
    await screen.findByText('README.md');
    await waitFor(() => expect(fs.watcherCount()).toBeGreaterThan(0));

    fs.setFile('/ws/appeared.md', 'new');
    fs.emitChange('/ws');

    expect(await screen.findByText('appeared.md')).toBeInTheDocument();
  });

  it('watches a directory when it is expanded and stops when it is collapsed', async () => {
    const fs = workspace();
    renderTree(fs);
    await screen.findByText('docs');
    const rootOnly = fs.watcherCount();

    fireEvent.click(screen.getByText('docs'));
    await screen.findByText('design.md');
    await waitFor(() => expect(fs.watcherCount()).toBe(rootOnly + 1));

    fireEvent.click(screen.getByText('docs'));
    await waitFor(() => expect(fs.watcherCount()).toBe(rootOnly));
  });

  it('drops every watcher when the tree unmounts', async () => {
    const fs = workspace();
    const { unmount } = render(
      <FileSystemProvider fs={fs}>
        <Harness root="/ws" />
      </FileSystemProvider>,
    );
    await screen.findByText('README.md');
    await waitFor(() => expect(fs.watcherCount()).toBeGreaterThan(0));
    unmount();
    await waitFor(() => expect(fs.watcherCount()).toBe(0));
  });

  it('keeps showing hidden entries on a live refresh after the filter was toggled post-subscribe', async () => {
    // showHidden persists in localStorage (use-file-tree.ts); test/setup.ts's
    // afterEach clears it, so this test starts from the known default and
    // clicking the switch below reliably turns hidden files ON regardless of
    // test execution order.
    const fs = workspace();
    renderTree(fs);
    await screen.findByText('README.md');
    await waitFor(() => expect(fs.watcherCount()).toBeGreaterThan(0));

    // The root's watcher subscribed while showHidden was still false. Flip
    // it on now, after subscribing, so a stale closure over showHidden would
    // be exercised by the refresh below rather than masked by it.
    fireEvent.click(screen.getByRole('switch', { name: /hidden/i }));
    expect(await screen.findByText('.env')).toBeInTheDocument();

    // A filesystem-driven refresh through the watcher, not through the
    // toggle's own immediate re-list.
    fs.setFile('/ws/appeared.md', 'new');
    fs.emitChange('/ws');

    // appeared.md proves the watcher-driven re-list actually ran; .env
    // proves it used the current showHidden value rather than the one
    // captured when the watcher was first subscribed.
    expect(await screen.findByText('appeared.md')).toBeInTheDocument();
    expect(screen.getByText('.env')).toBeInTheDocument();
  });
});


/**
 * Fluent renders TreeItemLayout's `actions` slot only while the row is
 * hovered or focused (or when `visible` is forced, which FileTree does for
 * the selected row) — the slot is genuinely absent from the DOM otherwise.
 * So reveal the row the way a user does, by pointing at it.
 */
function hoverRow(name: string) {
  // Fired on the row's label, not the treeitem: Fluent's handler sits on the
  // layout element *inside* the treeitem, and DOM events bubble up.
  fireEvent.mouseOver(screen.getByText(name));
}

describe('FileTree row actions', () => {
  // These are what replaced the old toolbar. The whole point is that the
  // action carries the row's own path, so "where does this new file go?"
  // has a visible answer: the row you pointed at.
  it('offers create, rename and delete on a folder row, each naming that folder', async () => {
    const onCreateFile = vi.fn();
    const onCreateFolder = vi.fn();
    const onRename = vi.fn();
    const onDelete = vi.fn();
    renderTree(workspace(), '/ws', { onCreateFile, onCreateFolder, onRename, onDelete });
    await screen.findByText('docs');
    hoverRow('docs');

    fireEvent.click(screen.getByRole('button', { name: /new file in docs/i }));
    fireEvent.click(screen.getByRole('button', { name: /new folder in docs/i }));
    fireEvent.click(screen.getByRole('button', { name: /rename docs/i }));
    fireEvent.click(screen.getByRole('button', { name: /delete docs/i }));

    expect(onCreateFile).toHaveBeenCalledWith('/ws/docs');
    expect(onCreateFolder).toHaveBeenCalledWith('/ws/docs');
    expect(onRename).toHaveBeenCalledWith('/ws/docs');
    expect(onDelete).toHaveBeenCalledWith('/ws/docs');
  });

  it('renders the row Delete in subtle red', async () => {
    renderTree(workspace(), '/ws', { onDelete: vi.fn() });
    await screen.findByText('docs');
    hoverRow('docs');

    const del = screen.getByRole('button', { name: /delete docs/i });
    expect(hasInjectedStyle(del, 'color', 'var(--colorPaletteRedForeground1)')).toBe(true);
    expect(hasInjectedStyle(del, 'background-color', 'var(--colorPaletteRedBackground3)')).toBe(false);
  });

  it('offers only rename and delete on a file row', async () => {
    renderTree(workspace(), '/ws', { onCreateFile: vi.fn(), onRename: vi.fn(), onDelete: vi.fn() });
    await screen.findByText('README.md');
    hoverRow('README.md');

    expect(screen.getByRole('button', { name: /rename README\.md/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete README\.md/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new file in README\.md/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new folder in README\.md/i })).not.toBeInTheDocument();
  });

  it('creates inside the folder whose row was clicked, not the selected node', async () => {
    const onCreateFile = vi.fn();
    renderTree(workspace(), '/ws', { onCreateFile });
    fireEvent.click(await screen.findByText('README.md')); // selection is elsewhere
    hoverRow('docs');
    fireEvent.click(screen.getByRole('button', { name: /new file in docs/i }));
    expect(onCreateFile).toHaveBeenCalledWith('/ws/docs');
  });

  it('acts on a nested folder with its own path once expanded', async () => {
    const onCreateFile = vi.fn();
    renderTree(workspace(), '/ws', { onCreateFile });
    fireEvent.click(await screen.findByText('.whiphand'));
    await screen.findByText('workflows');
    hoverRow('workflows');
    fireEvent.click(screen.getByRole('button', { name: /new file in workflows/i }));
    expect(onCreateFile).toHaveBeenCalledWith('/ws/.whiphand/workflows');
  });

  it('does not expand or collapse the folder when its action is clicked', async () => {
    renderTree(workspace(), '/ws', { onCreateFile: vi.fn() });
    await screen.findByText('docs');
    hoverRow('docs');
    fireEvent.click(screen.getByRole('button', { name: /new file in docs/i }));
    // design.md would appear if the click had toggled 'docs' open.
    expect(screen.queryByText('design.md')).not.toBeInTheDocument();
  });

  it('keeps the selected row\'s actions on screen without the pointer', async () => {
    renderTree(workspace(), '/ws', { onCreateFile: vi.fn() });
    fireEvent.click(await screen.findByText('docs'));
    // No hover: selection alone must hold the actions open, so the current
    // target stays visible while you read the dialog it opened.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /new file in docs/i })).toBeInTheDocument();
    });
  });

  it('marks the selected row for assistive tech, folders included', async () => {
    renderTree(workspace());
    fireEvent.click(await screen.findByText('docs'));
    await waitFor(() => {
      expect(screen.getByRole('treeitem', { name: /docs/ })).toHaveAttribute('aria-selected', 'true');
    });
    expect(screen.getByRole('treeitem', { name: /README\.md/ })).toHaveAttribute('aria-selected', 'false');
  });
});

describe('FileTree: a long listing', () => {
  const COUNT = 500;
  const name = (i: number) => `file-${String(i).padStart(3, '0')}.txt`;
  function bigNodes(): TreeNodes {
    const nodes: TreeNodes = {
      '/ws': { path: '/ws', name: 'ws', kind: 'dir', childrenLoaded: true, children: [] },
    };
    for (let i = 0; i < COUNT; i += 1) {
      const path = `/ws/${name(i)}`;
      nodes['/ws'].children!.push(path);
      nodes[path] = { path, name: name(i), kind: 'file', childrenLoaded: false };
    }
    return nodes;
  }
  function renderBig() {
    const utils = render(
      <FileTree root="/ws" nodes={bigNodes()} expanded={[]} selectedPath={null} onToggle={vi.fn()} onSelect={vi.fn()} />,
    );
    const scroller = utils.container.querySelector('[data-virtual-scroller]') as HTMLElement;
    // jsdom has no layout or scrolling: give the scroller its extent, and make
    // scrollTo move scrollTop and say so, as a browser would.
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      // What a browser would lay out: the spacers plus the rendered rows.
      get: () => [...scroller.querySelector('[role=tree]')!.children].reduce((sum, child) => sum
        + (child.hasAttribute('data-index') ? VIRTUAL_ROW_HEIGHT : parseFloat((child as HTMLElement).style.height) || 0), 0),
    });
    Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true });
    scroller.scrollTo = ((options: ScrollToOptions) => {
      Object.defineProperty(scroller, 'scrollTop', { value: options.top ?? 0, configurable: true, writable: true });
      fireEvent.scroll(scroller);
    }) as typeof scroller.scrollTo;
    return utils;
  }

  it('keeps only the rows near the viewport in the DOM', () => {
    setVirtualViewportHeight(300);
    renderBig();
    const rows = screen.getAllByRole('treeitem');
    expect(rows.length).toBeGreaterThan(300 / VIRTUAL_ROW_HEIGHT);
    expect(rows.length).toBeLessThan(60);
    expect(rows[0]).toHaveAttribute('aria-posinset', '1');
    expect(rows[0]).toHaveAttribute('aria-setsize', String(COUNT));
    expect(screen.queryByText(name(COUNT - 1))).toBeNull();
  });

  // A hidden Run Detail tab is display: none; the browser resets the scroll
  // container's scrollTop to 0 without a scroll event, and showing it again is
  // only a resize. The window must follow the real scrollTop, not the stale one.
  it('resyncs the window when the container is shown again at scrollTop 0', () => {
    setVirtualViewportHeight(300);
    const { container } = renderBig();
    const scroller = container.querySelector('[data-virtual-scroller]') as HTMLElement;
    scroller.scrollTop = 5000;
    fireEvent.scroll(scroller);
    expect(screen.queryByText(name(0))).toBeNull();

    scroller.scrollTop = 0; // silently, as display: none does
    act(() => triggerResize(scroller));

    expect(screen.getByText(name(0))).toBeInTheDocument();
    const tree = scroller.querySelector('[role=tree]')!;
    expect((tree.firstElementChild as HTMLElement).style.height).toMatch(/^0(px)?$|^$/);
  });

  // Home and ArrowLeft to a parent scrolled out of the window take the same
  // path, and all three were checked by hand in Chromium. jsdom's focus is
  // too timing-dependent under a loaded suite to chain a second jump.
  it('End reaches a row outside the window', async () => {
    setVirtualViewportHeight(300);
    renderBig();
    const first = screen.getAllByRole('treeitem')[0];
    first.focus();
    fireEvent.keyDown(first, { key: 'End' });
    await waitFor(() => expect(document.activeElement).toHaveTextContent(name(COUNT - 1)), { timeout: 3000 });
    expect(screen.queryByText(name(0))).toBeNull();
  });
});
