import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FakeFileSystem } from '../files/fake-fs.ts';
import { FileSystemProvider } from '../files/fs-context.tsx';
import { MAX_RENDERED_PREVIEW_BYTES } from '../files/file-kind.ts';
import { MAX_IMAGE_BYTES } from '../markdown/MarkdownImage.tsx';
import { resolveInWorkspace } from '../markdown/resolve.ts';
import { FilePreview, resetPreviewViewForTests } from './FilePreview.tsx';

// PdfView has its own tests (pdf/PdfView.test.tsx) against a fake pdf.js;
// here it only has to be handed the right bytes. The stand-in shows what it
// was given, so a test can tell one handover from another.
vi.mock('../pdf/PdfView.tsx', () => ({
  PdfView: ({ path, bytes }: { path: string; bytes: Uint8Array }) => (
    <div data-testid="pdf-view">{`${path}: ${bytes.length} bytes, starting ${new TextDecoder().decode(bytes.slice(0, 8))}`}</div>
  ),
}));

// The Rendered/Source preference is deliberately module-scope (it must
// survive leaving this page and coming back — a mere file-selection change
// is just a re-render, which state would survive fine), which means it
// outlives any one test's render tree. Reset it so one test's toggle click
// cannot decide another test's starting view.
afterEach(() => {
  resetPreviewViewForTests();
});

function renderPreview(fs: FakeFileSystem, path: string) {
  return render(
    <FileSystemProvider fs={fs}>
      <FilePreview path={path} onDirtyChange={() => {}} />
    </FileSystemProvider>,
  );
}

function fsWith(files: Record<string, string>): FakeFileSystem {
  const fs = new FakeFileSystem();
  for (const [path, contents] of Object.entries(files)) fs.setFile(path, contents);
  return fs;
}

describe('FilePreview', () => {
  it('renders markdown rather than its source', async () => {
    renderPreview(fsWith({ '/ws/a.md': '# Title\n\nBody text.' }), '/ws/a.md');
    expect(await screen.findByRole('heading', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByText('Body text.')).toBeInTheDocument();
    expect(screen.queryByText('# Title')).not.toBeInTheDocument();
  });

  it('renders other text files as code', async () => {
    // Asserted on textContent, not findByText: highlight.js splits the line
    // into <span>s, so no single text node holds the whole string.
    const { container } = renderPreview(fsWith({ '/ws/workflow.yaml': 'name: feature' }), '/ws/workflow.yaml');
    await waitFor(() => expect(container.querySelector('code.hljs')?.textContent).toBe('name: feature'));
  });

  it('reports binary files instead of rendering them', async () => {
    const fs = fsWith({});
    fs.setFile('/ws/blob.bin', 'ab\0cd');
    renderPreview(fs, '/ws/blob.bin');
    expect(await screen.findByText(/binary file/i)).toBeInTheDocument();
  });

  it('refuses to read a file over the preview cap', async () => {
    const fs = fsWith({ '/ws/huge.log': 'x'.repeat(2 * 1024 * 1024 + 1) });
    renderPreview(fs, '/ws/huge.log');
    expect(await screen.findByText(/too large to preview/i)).toBeInTheDocument();
  });

  it('surfaces a read failure without crashing', async () => {
    const fs = fsWith({ '/ws/secret.md': 'x' });
    fs.setError('/ws/secret.md', 'permission denied');
    renderPreview(fs, '/ws/secret.md');
    expect(await screen.findByText(/permission denied/i)).toBeInTheDocument();
  });

  it('shows an empty state when no file is selected', () => {
    render(
      <FileSystemProvider fs={fsWith({})}>
        <FilePreview path={null} onDirtyChange={() => {}} />
      </FileSystemProvider>,
    );
    expect(screen.getByText(/select a file/i)).toBeInTheDocument();
  });
});

describe('FilePreview source toggle', () => {
  it('offers the source without entering edit mode', async () => {
    renderPreview(fsWith({ '/ws/a.md': '# Title' }), '/ws/a.md');
    fireEvent.click(await screen.findByRole('tab', { name: 'Source' }));
    // The raw text, highlighted as markdown — and no editable field.
    await waitFor(() => expect(screen.getByTestId('preview-source').textContent).toBe('# Title'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('goes back to the rendered document', async () => {
    renderPreview(fsWith({ '/ws/a.md': '# Title' }), '/ws/a.md');
    fireEvent.click(await screen.findByRole('tab', { name: 'Source' }));
    // Confirms the Source click actually did something — without this, a
    // no-op Source click would still leave the heading in the document
    // throughout and the test below would pass for the wrong reason.
    await screen.findByTestId('preview-source');
    fireEvent.click(screen.getByRole('tab', { name: 'Rendered' }));
    expect(await screen.findByRole('heading', { name: 'Title' })).toBeInTheDocument();
    expect(screen.queryByTestId('preview-source')).not.toBeInTheDocument();
  });

  it('offers no source toggle for a non-markdown file', async () => {
    renderPreview(fsWith({ '/ws/a.yaml': 'name: x' }), '/ws/a.yaml');
    await screen.findByText('/ws/a.yaml');
    expect(screen.queryByRole('tab', { name: 'Source' })).not.toBeInTheDocument();
  });

  it('scrolls the document rather than the page', async () => {
    renderPreview(fsWith({ '/ws/a.md': '# Title' }), '/ws/a.md');
    // The style contract, not just presence: this is what makes the
    // container the one that scrolls instead of the host page — a bare
    // existence check would still pass with `overflow: auto` removed.
    expect(await screen.findByTestId('preview-scroll')).toHaveStyle({ overflow: 'auto' });
  });
});

describe('FilePreview editing', () => {
  it('edits markdown as raw source and returns to the rendered view after saving', async () => {
    const fs = fsWith({ '/ws/a.md': '# Title' });
    renderPreview(fs, '/ws/a.md');
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));

    const textarea = screen.getByRole('textbox');
    expect(textarea).toHaveValue('# Title');
    fireEvent.change(textarea, { target: { value: '# Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByRole('heading', { name: 'Renamed' })).toBeInTheDocument();
    expect(new TextDecoder().decode(await fs.readFile('/ws/a.md'))).toBe('# Renamed');
  });

  it('discards edits on cancel', async () => {
    const fs = fsWith({ '/ws/a.md': '# Title' });
    renderPreview(fs, '/ws/a.md');
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'throw away' } });
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(await screen.findByRole('heading', { name: 'Title' })).toBeInTheDocument();
    expect(new TextDecoder().decode(await fs.readFile('/ws/a.md'))).toBe('# Title');
  });

  it('edits non-markdown text files too', async () => {
    const fs = fsWith({ '/ws/workflow.yaml': 'name: feature' });
    renderPreview(fs, '/ws/workflow.yaml');
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'name: changed' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(async () => {
      expect(new TextDecoder().decode(await fs.readFile('/ws/workflow.yaml'))).toBe('name: changed');
    });
  });

  it('reports dirty state to the page while there are unsaved edits', async () => {
    const fs = fsWith({ '/ws/a.md': '# Title' });
    const onDirtyChange = vi.fn();
    render(
      <FileSystemProvider fs={fs}>
        <FilePreview path="/ws/a.md" onDirtyChange={onDirtyChange} />
      </FileSystemProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'changed' } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it('refuses to save silently over a file that changed on disk', async () => {
    const fs = fsWith({ '/ws/a.md': '# Title' });
    renderPreview(fs, '/ws/a.md');
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mine' } });

    fs.setFileSilently('/ws/a.md', 'theirs'); // a run wrote to it underneath us
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText(/changed on disk/i)).toBeInTheDocument();
    expect(new TextDecoder().decode(await fs.readFile('/ws/a.md'))).toBe('theirs');

    fireEvent.click(screen.getByRole('button', { name: /overwrite/i }));
    await waitFor(async () => {
      expect(new TextDecoder().decode(await fs.readFile('/ws/a.md'))).toBe('mine');
    });
  });

  it('reloads the on-disk version when asked to', async () => {
    const fs = fsWith({ '/ws/a.md': '# Title' });
    renderPreview(fs, '/ws/a.md');
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mine' } });
    fs.setFileSilently('/ws/a.md', '# Theirs');
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /reload/i }));
    expect(await screen.findByRole('heading', { name: 'Theirs' })).toBeInTheDocument();
  });

  /**
   * The "changed on disk" notice, when reload() cannot act on it.
   *
   * reload() has three paths that give up and return — the file no longer
   * reads, it grew past MAX_PREVIEW_BYTES, it stopped being text — and each
   * leaves `diskChanged` set. Without an explanation the notice keeps
   * offering Reload and pressing it visibly does nothing.
   */
  async function raiseDiskNotice(fs: FakeFileSystem, diskText: string) {
    render(
      <FileSystemProvider fs={fs}>
        <FilePreview path="/ws/a.md" onDirtyChange={() => {}} live />
      </FileSystemProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mine' } });
    // Dirty, so the watcher raises the notice instead of swapping the text.
    fs.setFileSilently('/ws/a.md', diskText);
    fs.emitFileChange('/ws/a.md');
    expect(await screen.findByText(/changed on disk/i)).toBeInTheDocument();
  }

  it('says why a Reload could not be applied, and offers it again when it might work', async () => {
    const fs = fsWith({ '/ws/a.md': '# Title' });
    await raiseDiskNotice(fs, '# Theirs');

    fs.setError('/ws/a.md', 'permission denied');
    fireEvent.click(screen.getByRole('button', { name: /reload/i }));
    expect(await screen.findByText(/could not be read just now/i)).toBeInTheDocument();

    // A transient failure, so the button stays — and still works. The
    // reader is in the editor, so "worked" means the draft now holds the
    // disk version (overwriteDraft) and the notice is gone.
    fs.clearError('/ws/a.md');
    fireEvent.click(screen.getByRole('button', { name: /reload/i }));
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('# Theirs'));
    expect(screen.queryByText(/changed on disk/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/could not be read just now/i)).not.toBeInTheDocument();
  });

  it('withdraws Reload when the file it would reload is no longer text', async () => {
    const fs = fsWith({ '/ws/a.md': '# Title' });
    await raiseDiskNotice(fs, 'now\u0000binary');

    fireEvent.click(screen.getByRole('button', { name: /reload/i }));
    expect(await screen.findByText(/no longer a text file/i)).toBeInTheDocument();
    // Nothing a second press could change, and a button that does nothing
    // reads as the app being broken.
    await waitFor(() => expect(screen.queryByRole('button', { name: /reload/i })).not.toBeInTheDocument());
    // The notice itself stays: the file really did change underneath.
    expect(screen.getByText(/changed on disk/i)).toBeInTheDocument();
  });

  it('returns to the rendered view after saving, even though startInEditMode stays true', async () => {
    // Task 9's new-file flow keeps startInEditMode true across the save (it
    // only clears on the next selection change) — auto-entry into edit mode
    // must be one-shot per opened file, not re-triggered by the `loaded`
    // object that Save itself replaces.
    const fs = fsWith({ '/ws/a.md': '# Title' });
    render(
      <FileSystemProvider fs={fs}>
        <FilePreview path="/ws/a.md" onDirtyChange={() => {}} startInEditMode />
      </FileSystemProvider>,
    );

    const textarea = await screen.findByRole('textbox');
    fireEvent.change(textarea, { target: { value: '# Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByRole('heading', { name: 'Renamed' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});

describe('FilePreview images', () => {
  /**
   * The object URL's Blob has to carry a MIME type. Raster formats survive
   * an untyped Blob because the image decoder sniffs their content, but an
   * <img> will not render an SVG unless the resource is typed
   * image/svg+xml — untyped, it shows a broken-image icon.
   */
  async function blobTypeFor(path: string, contents: string): Promise<string> {
    const created: Blob[] = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (blob: Blob) => {
      created.push(blob);
      return 'blob:preview-test';
    };
    URL.revokeObjectURL = () => {};
    try {
      renderPreview(fsWith({ [path]: contents }), path);
      await screen.findByRole('img');
      return created[0]?.type ?? '<no blob created>';
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  }

  it('types an SVG blob so the <img> actually renders it', async () => {
    expect(await blobTypeFor('/ws/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')).toBe('image/svg+xml');
  });

  it('types raster images from their extension too', async () => {
    expect(await blobTypeFor('/ws/shot.png', 'not really a png')).toBe('image/png');
  });

  it('renders an image past the text preview cap, as an attached screenshot routinely is', async () => {
    expect(await blobTypeFor('/ws/attachments/bug.png', 'x'.repeat(2 * 1024 * 1024 + 1))).toBe('image/png');
  });

  // Regression test: FilePreview's early returns (this one included) are the
  // sole child of a `display: flex` pane on both host pages (Task 9). A flex
  // item's default `align-self: stretch` would otherwise stretch the <img>
  // to the pane's full height and distort it. jsdom has no layout engine, so
  // this asserts the style contract that prevents the stretch rather than
  // rendered geometry — the same pattern as "FilePreview editor sizing" below.
  it('does not stretch or distort a rendered image', async () => {
    renderPreview(fsWith({ '/ws/shot.png': 'not really a png' }), '/ws/shot.png');
    const img = await screen.findByRole('img');
    expect(img).toHaveStyle({ alignSelf: 'flex-start', maxHeight: '100%', objectFit: 'contain' });
  });
});

describe('FilePreview PDFs', () => {
  /** A PDF-ish body: the header, then the NULs every real one has in its binary streams. */
  const pdf = (size: number) => `%PDF-1.7\n\u0000\u0000${'x'.repeat(Math.max(0, size - 11))}`;

  it('hands a PDF past the text cap to the PDF viewer, as an attached spec routinely is', async () => {
    const fs = fsWith({});
    fs.setFile('/ws/attachments/spec.pdf', pdf(5 * 1024 * 1024));
    renderPreview(fs, '/ws/attachments/spec.pdf');
    expect(await screen.findByTestId('pdf-view')).toHaveTextContent(
      `/ws/attachments/spec.pdf: ${5 * 1024 * 1024} bytes, starting %PDF-1.7`,
    );
    expect(screen.queryByText(/too large to preview/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/binary file/i)).not.toBeInTheDocument();
  });

  it('refuses a PDF past the rendered-preview cap without reading it', async () => {
    const fs = fsWith({});
    fs.setFile('/ws/huge.pdf', pdf(MAX_RENDERED_PREVIEW_BYTES + 1));
    const read = vi.spyOn(fs, 'readFile');
    renderPreview(fs, '/ws/huge.pdf');
    expect(await screen.findByText(/too large to preview/i)).toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
    expect(screen.queryByTestId('pdf-view')).not.toBeInTheDocument();
  });

  it('offers no Edit button over a PDF, and leaves Ctrl/Cmd-F to the webview', async () => {
    const fs = fsWith({});
    fs.setFile('/ws/spec.pdf', pdf(1024));
    renderPreview(fs, '/ws/spec.pdf');
    await screen.findByTestId('pdf-view');
    // Flushes the passive effects, where the find shortcut would subscribe:
    // without this, the keystrokes below could land before a (wrongly)
    // registered shortcut was listening, and pass for the wrong reason.
    await act(async () => {});

    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      const event = new KeyboardEvent('keydown', { key: 'f', ...modifier, bubbles: true, cancelable: true });
      document.body.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('keeps showing an open PDF when a live watcher reports it changed, rather than half a rewrite', async () => {
    const fs = fsWith({});
    fs.setFile('/ws/report.pdf', pdf(1024));
    render(
      <FileSystemProvider fs={fs}>
        <FilePreview path="/ws/report.pdf" onDirtyChange={() => {}} live />
      </FileSystemProvider>,
    );
    const viewer = await screen.findByTestId('pdf-view');
    expect(fs.watcherCount()).toBeGreaterThan(0);
    const read = vi.spyOn(fs, 'readFile');

    fs.setFileSilently('/ws/report.pdf', `%PDF-1.7\n${'y'.repeat(20)}`);
    fs.emitFileChange('/ws/report.pdf');
    // The reload really ran and really read the new bytes — so the
    // assertions below are about what it did with them, not about it never
    // getting that far.
    await waitFor(() => expect(read).toHaveBeenCalled());
    await act(async () => {});

    expect(screen.getByTestId('pdf-view')).toBe(viewer);
    expect(viewer).toHaveTextContent('/ws/report.pdf: 1024 bytes');
    expect(screen.queryByText(/could not open this file/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/changed on disk/i)).not.toBeInTheDocument();
  });
});

describe('FilePreview editor sizing', () => {
  // jsdom has no layout engine, so these assert the style contract rather
  // than the rendered geometry. They exist because the geometry was wrong
  // twice over while the editor was Fluent's Textarea: its `medium` slot
  // ships `max-height: 260px` (measured in headless Chromium at 1400x1000:
  // 457px of textarea under an 857px root, the rest of the file
  // unreachable), and its `display: inline-flex` root shrank to the
  // textarea's intrinsic `cols` width in a block scroll container (200px of
  // editor in an 800px pane, every line wrapped into that column).
  //
  // The editor is now CodeEditor, whose textarea is absolutely positioned
  // over the highlighted layer — so the contract is "covers its container on
  // both axes, capped by nothing", which is what these check.
  it('lets the editor fill its container on both axes, uncapped', async () => {
    renderPreview(fsWith({ '/ws/long.md': Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n') }), '/ws/long.md');
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));

    const textarea = screen.getByRole('textbox');
    expect(textarea.style.position).toBe('absolute');
    expect(textarea.style.width).toBe('100%');
    expect(textarea.style.height).toBe('100%');
    // Any cap here would strand the rest of the file below the fold again.
    expect(textarea.style.maxHeight).toBe('');
  });

  // A short file must still leave a full-height click target: the container
  // is what the textarea sizes to, so if it collapsed to two lines of text,
  // clicking the empty pane below would not put the caret in the file.
  it('keeps the editor at least as tall as the pane for a short file', async () => {
    renderPreview(fsWith({ '/ws/long.md': 'one line' }), '/ws/long.md');
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));

    expect(screen.getByTestId('code-editor').style.minHeight).toBe('100%');
  });
});

describe('FilePreview document context', () => {
  it('navigates to a relative link through the page', async () => {
    const onNavigate = vi.fn();
    const fs = fsWith({ '/ws/docs/plan.md': 'see [review](./review.md)', '/ws/docs/review.md': 'ok' });
    render(
      <FileSystemProvider fs={fs}>
        <FilePreview
          path="/ws/docs/plan.md"
          onDirtyChange={() => {}}
          docContext={{
            resolve: target => resolveInWorkspace('/ws/docs', '/ws', target),
            onNavigate,
            openExternal: () => {},
          }}
        />
      </FileSystemProvider>,
    );
    fireEvent.click(await screen.findByRole('link', { name: 'review' }));
    expect(onNavigate).toHaveBeenCalledWith('/ws/docs/review.md');
  });

  it('renders a link with no document context as inert', async () => {
    const fs = fsWith({ '/ws/plan.md': 'see [review](./review.md)' });
    renderPreview(fs, '/ws/plan.md');
    expect(await screen.findByText('review')).toHaveAttribute('data-inert', 'true');
  });

  it('reads a relative image through the port', async () => {
    const fs = fsWith({ '/ws/doc.md': '![diagram](./arch.png)', '/ws/arch.png': 'fake-png-bytes' });
    const readFile = vi.spyOn(fs, 'readFile');
    render(
      <FileSystemProvider fs={fs}>
        <FilePreview
          path="/ws/doc.md"
          onDirtyChange={() => {}}
          docContext={{ resolve: target => resolveInWorkspace('/ws', '/ws', target), onNavigate: () => {} }}
        />
      </FileSystemProvider>,
    );
    expect((await screen.findByAltText('diagram')).getAttribute('src')).toMatch(/^blob:/);
    expect(readFile).toHaveBeenCalledWith('/ws/arch.png');
  });

  it('never reads an image past the size cap', async () => {
    // The gate belongs on the stat, not on the bytes: reading first would
    // pull the whole file across the IPC boundary only to discard it.
    const fs = fsWith({ '/ws/doc.md': '![huge](./huge.png)' });
    fs.setFile('/ws/huge.png', 'x'.repeat(MAX_IMAGE_BYTES + 1));
    const readFile = vi.spyOn(fs, 'readFile');
    render(
      <FileSystemProvider fs={fs}>
        <FilePreview
          path="/ws/doc.md"
          onDirtyChange={() => {}}
          docContext={{ resolve: target => resolveInWorkspace('/ws', '/ws', target), onNavigate: () => {} }}
        />
      </FileSystemProvider>,
    );
    expect(await screen.findByText(/could not load/i)).toBeInTheDocument();
    expect(readFile).not.toHaveBeenCalledWith('/ws/huge.png');
  });
});

describe('FilePreview live refresh', () => {
  function renderLive(fs: FakeFileSystem, path: string) {
    return render(
      <FileSystemProvider fs={fs}>
        <FilePreview path={path} onDirtyChange={() => {}} live />
      </FileSystemProvider>,
    );
  }

  /**
   * jsdom has no layout engine: scrollHeight and clientHeight are always 0
   * and scrollTop never moves. Drive the three numbers the component reads,
   * through a handle the test can mutate so a document can be made to grow
   * mid-refresh the way an appended-to one does.
   */
  function fakeLayout(el: HTMLElement, scrollHeight: number, clientHeight: number, scrollTop: number) {
    const layout = { scrollHeight, clientHeight, scrollTop };
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => layout.scrollHeight });
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => layout.clientHeight });
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => layout.scrollTop,
      set: (value: number) => { layout.scrollTop = value; },
    });
    return layout;
  }

  /**
   * The hazard these tests exist for is the browser dropping the scroll
   * offset when the content under it is replaced — which jsdom, having no
   * layout, never does on its own. Simulate it: reset the offset the moment
   * the swapped-in text lands, so a component that failed to restore the
   * position would leave 0 behind and the assertion could actually fail.
   * `grewTo`, when given, is the taller document the run just appended to.
   */
  function resetScrollOnContentSwap(
    el: HTMLElement,
    layout: { scrollHeight: number; scrollTop: number },
    grewTo?: number,
  ): MutationObserver {
    const observer = new MutationObserver(() => {
      if (grewTo !== undefined) layout.scrollHeight = grewTo;
      layout.scrollTop = 0;
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return observer;
  }

  it('re-renders when the open file changes on disk', async () => {
    const fs = fsWith({ '/ws/plan.md': '# Draft' });
    renderLive(fs, '/ws/plan.md');
    await screen.findByRole('heading', { name: 'Draft' });

    fs.setFileSilently('/ws/plan.md', '# Draft\n\n## Testing');
    fs.emitFileChange('/ws/plan.md');

    expect(await screen.findByRole('heading', { name: 'Testing' })).toBeInTheDocument();
  });

  it('refreshes the source view too, not only the rendered one', async () => {
    const fs = fsWith({ '/ws/plan.md': '# Draft' });
    const { container } = renderLive(fs, '/ws/plan.md');
    fireEvent.click(await screen.findByRole('tab', { name: 'Source' }));
    await waitFor(() => expect(container.querySelector('code.hljs')?.textContent).toBe('# Draft'));

    fs.setFileSilently('/ws/plan.md', '# Draft\n\nappended');
    fs.emitFileChange('/ws/plan.md');

    await waitFor(() => expect(container.querySelector('code.hljs')?.textContent).toContain('appended'));
  });

  it('does not watch when live is off', async () => {
    const fs = fsWith({ '/ws/plan.md': '# Draft' });
    renderPreview(fs, '/ws/plan.md');
    await screen.findByRole('heading', { name: 'Draft' });
    expect(fs.watcherCount()).toBe(0);
  });

  it('watches while live, so the zero above is not vacuous', async () => {
    const fs = fsWith({ '/ws/plan.md': '# Draft' });
    renderLive(fs, '/ws/plan.md');
    await screen.findByRole('heading', { name: 'Draft' });
    await waitFor(() => expect(fs.watcherCount()).toBe(1));
  });

  it('stops watching when the file is closed', async () => {
    const fs = fsWith({ '/ws/plan.md': '# Draft' });
    const { unmount } = renderLive(fs, '/ws/plan.md');
    await screen.findByRole('heading', { name: 'Draft' });
    await waitFor(() => expect(fs.watcherCount()).toBe(1));
    unmount();
    await waitFor(() => expect(fs.watcherCount()).toBe(0));
  });

  it('keeps showing the last good text when a re-read fails mid-write', async () => {
    // A file being rewritten can vanish for an instant. That must not turn
    // into an error surface — the next event brings the new contents.
    const fs = fsWith({ '/ws/plan.md': '# Draft' });
    renderLive(fs, '/ws/plan.md');
    await screen.findByRole('heading', { name: 'Draft' });

    fs.setError('/ws/plan.md', 'no such file');
    fs.emitFileChange('/ws/plan.md');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Draft' })).toBeInTheDocument());
    expect(screen.queryByText(/could not open/i)).not.toBeInTheDocument();

    fs.clearError('/ws/plan.md');
    fs.setFileSilently('/ws/plan.md', '# Draft\n\n## Testing');
    fs.emitFileChange('/ws/plan.md');
    expect(await screen.findByRole('heading', { name: 'Testing' })).toBeInTheDocument();
  });

  it('offers to reload rather than discarding an unsaved edit', async () => {
    const fs = fsWith({ '/ws/plan.md': 'original' });
    renderLive(fs, '/ws/plan.md');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mine' } });

    fs.setFileSilently('/ws/plan.md', 'theirs');
    fs.emitFileChange('/ws/plan.md');

    expect(await screen.findByText(/changed on disk/i)).toBeInTheDocument();
    // The draft survived: the refresh did not overwrite it.
    expect(screen.getByRole('textbox')).toHaveValue('mine');

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('theirs'));
    expect(screen.queryByText(/changed on disk/i)).not.toBeInTheDocument();
  });

  it('stays quiet for an event that did not actually change the file', async () => {
    // The watcher fires on writes it cannot attribute — tauri-fs matches
    // events by basename inside the parent directory, and any tool that
    // rewrites a file in place (git checkout, a formatter, our own save
    // echoing back) produces one. Raising the notice from the event alone
    // told the reader their file had changed underneath them while they were
    // the only one touching it, and offered to discard their edits for it.
    const fs = fsWith({ '/ws/plan.md': 'original' });
    renderLive(fs, '/ws/plan.md');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mine' } });

    // No setFileSilently: the bytes on disk are exactly what the pane loaded.
    fs.emitFileChange('/ws/plan.md');
    // Let the verifying read run before asking what it decided.
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByText(/changed on disk/i)).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('mine');

    // ...and the check is a real comparison, not just a slower path: a
    // genuine change still raises the notice.
    fs.setFileSilently('/ws/plan.md', 'theirs');
    fs.emitFileChange('/ws/plan.md');
    expect(await screen.findByText(/changed on disk/i)).toBeInTheDocument();
  });

  it('takes the deferred change once the edit is cancelled', async () => {
    // Otherwise the notice outlives the draft it was protecting, and the
    // document stays stale: there may never be another event to carry the
    // change, if the run that wrote the file has finished.
    const fs = fsWith({ '/ws/plan.md': '# Draft' });
    renderLive(fs, '/ws/plan.md');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mine' } });

    fs.setFileSilently('/ws/plan.md', '# Theirs');
    fs.emitFileChange('/ws/plan.md');
    await screen.findByText(/changed on disk/i);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByRole('heading', { name: 'Theirs' })).toBeInTheDocument();
    expect(screen.queryByText(/changed on disk/i)).not.toBeInTheDocument();
  });

  it("holds the reader's scroll position across a refresh", async () => {
    const fs = fsWith({ '/ws/plan.md': '# Draft' });
    renderLive(fs, '/ws/plan.md');
    const scroller = await screen.findByTestId('preview-scroll');
    const layout = fakeLayout(scroller, 1000, 200, 300);
    const observer = resetScrollOnContentSwap(scroller, layout);

    fs.setFileSilently('/ws/plan.md', '# Draft\n\nmore');
    fs.emitFileChange('/ws/plan.md');

    await screen.findByText('more');
    // waitFor, not a bare assertion: the restore deliberately waits for a
    // frame, so that it lands after React has painted the new text.
    await waitFor(() => expect(scroller.scrollTop).toBe(300));
    observer.disconnect();
  });

  it('follows the end of a document it was already reading the end of', async () => {
    const fs = fsWith({ '/ws/plan.md': '# Draft' });
    renderLive(fs, '/ws/plan.md');
    const scroller = await screen.findByTestId('preview-scroll');
    const layout = fakeLayout(scroller, 1000, 200, 790); // within 40px of the bottom
    // The appended text makes the document taller, so sticking to the bottom
    // means a *new* offset (1200), not the one it started at.
    const observer = resetScrollOnContentSwap(scroller, layout, 1400);

    fs.setFileSilently('/ws/plan.md', '# Draft\n\nmore');
    fs.emitFileChange('/ws/plan.md');

    await screen.findByText('more');
    await waitFor(() => expect(scroller.scrollTop).toBe(1200));
    observer.disconnect();
  });

  /**
   * Resolves after a frame has been served, so a test can prove that the
   * restore scheduled in one *didn't* happen — waiting on a timeout instead
   * would only prove it hadn't happened yet.
   */
  const nextFrame = () => new Promise<void>(resolve => { requestAnimationFrame(() => resolve()); });

  it('takes one closing read when the run finishes', async () => {
    const fs = fsWith({ '/ws/plan.md': '# Draft' });
    const view = (live: boolean) => (
      <FileSystemProvider fs={fs}>
        <FilePreview path="/ws/plan.md" onDirtyChange={() => {}} live={live} />
      </FileSystemProvider>
    );
    const { rerender } = render(view(true));
    await screen.findByRole('heading', { name: 'Draft' });

    // The last write of a run lands between the final poll and the moment
    // `live` goes false with the run, so no watcher ever sees it. Without a
    // closing read the pane sits on stale content, with nothing to say so,
    // exactly as the reader turns to the finished result.
    fs.setFileSilently('/ws/plan.md', '# Draft\n\n## Final');
    rerender(view(false));

    expect(await screen.findByRole('heading', { name: 'Final' })).toBeInTheDocument();
    await waitFor(() => expect(fs.watcherCount()).toBe(0));
  });

  it('does not overwrite an edit that started while the re-read was in flight', async () => {
    const fs = fsWith({ '/ws/plan.md': 'original' });
    renderLive(fs, '/ws/plan.md');
    await screen.findByText('original');

    // Hold the re-read open. On the artifact port this is an RPC round trip,
    // and the reader can click Edit and type well inside that window.
    let release: (() => void) | undefined;
    let readCompleted = false;
    const realReadFile = fs.readFile.bind(fs);
    vi.spyOn(fs, 'readFile').mockImplementation(async filePath => {
      await new Promise<void>(resolve => { release = resolve; });
      const bytes = await realReadFile(filePath);
      readCompleted = true;
      return bytes;
    });

    fs.setFileSilently('/ws/plan.md', 'theirs');
    fs.emitFileChange('/ws/plan.md');
    await waitFor(() => expect(release).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mine' } });

    release?.();
    await waitFor(() => expect(readCompleted).toBe(true));
    await act(async () => {});

    // The keystrokes survived the reload landing on top of them — and
    // nothing silently settled `dirty` back to false, either.
    expect(screen.getByRole('textbox')).toHaveValue('mine');
  });

  it("does not seed the next file's draft with a late re-read of the previous one", async () => {
    const fs = fsWith({ '/ws/a.md': 'alpha', '/ws/b.md': 'bravo' });
    const view = (path: string) => (
      <FileSystemProvider fs={fs}>
        <FilePreview path={path} onDirtyChange={() => {}} live />
      </FileSystemProvider>
    );
    const { rerender } = render(view('/ws/a.md'));
    await screen.findByText('alpha');

    let release: (() => void) | undefined;
    let readCompleted = false;
    const realReadFile = fs.readFile.bind(fs);
    vi.spyOn(fs, 'readFile').mockImplementation(async filePath => {
      if (filePath === '/ws/a.md') await new Promise<void>(resolve => { release = resolve; });
      const bytes = await realReadFile(filePath);
      if (filePath === '/ws/a.md') readCompleted = true;
      return bytes;
    });

    fs.setFileSilently('/ws/a.md', 'alpha changed');
    fs.emitFileChange('/ws/a.md');
    await waitFor(() => expect(release).toBeDefined());

    // The reader moves on and starts editing the next file while that read
    // is still in flight.
    rerender(view('/ws/b.md'));
    await screen.findByText('bravo');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('textbox')).toHaveValue('bravo');

    release?.();
    await waitFor(() => expect(readCompleted).toBe(true));
    await act(async () => {});

    expect(screen.getByRole('textbox')).toHaveValue('bravo');
  });

  it('stays a working pane when the watch cannot be established', async () => {
    // watchFile rejects for a path that fails the traversal check, or when
    // the plugin refuses the parent directory. Quiet is the right failure
    // here: a pane that is merely not live still shows what it read, and
    // there is nothing the reader could do about it anyway. An unhandled
    // rejection in the webview is another matter, and this test would see it.
    const fs = fsWith({ '/ws/plan.md': '# Draft' });
    vi.spyOn(fs, 'watchFile').mockRejectedValue(new Error('watch refused'));

    const unhandled: unknown[] = [];
    const noteRejection = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', noteRejection);
    try {
      renderLive(fs, '/ws/plan.md');

      expect(await screen.findByRole('heading', { name: 'Draft' })).toBeInTheDocument();
      expect(screen.queryByText(/could not open/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/watch refused/i)).not.toBeInTheDocument();

      // A turn of the loop for a rejection to go unhandled in.
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', noteRejection);
    }
  });

  it('leaves the reader alone when a change brings identical bytes', async () => {
    // The Tauri watcher matches loosely on the parent directory (Task 10's
    // basename fallback), so an unrelated write in a busy folder arrives as
    // a change to this file. Re-rendering for it would collapse an open
    // <details>, drop the selection and restart image loads — and, visibly,
    // snap a reader near the end down to the bottom.
    const fs = fsWith({ '/ws/plan.md': '# Draft' });
    renderLive(fs, '/ws/plan.md');
    const scroller = await screen.findByTestId('preview-scroll');
    fakeLayout(scroller, 1000, 200, 790);
    const readFile = vi.spyOn(fs, 'readFile');

    fs.setFileSilently('/ws/plan.md', '# Draft'); // same bytes, new mtime
    fs.emitFileChange('/ws/plan.md');
    await waitFor(() => expect(readFile).toHaveBeenCalledTimes(1));
    await nextFrame();
    await nextFrame();

    expect(scroller.scrollTop).toBe(790);
  });

  it('still follows the end from exactly the stick-to-bottom threshold', async () => {
    const fs = fsWith({ '/ws/plan.md': '# Draft' });
    renderLive(fs, '/ws/plan.md');
    const scroller = await screen.findByTestId('preview-scroll');
    // 1000 - 200 - 760 === 40: the last offset that still counts as
    // reading the end. Pins the constant from below.
    const layout = fakeLayout(scroller, 1000, 200, 760);
    const observer = resetScrollOnContentSwap(scroller, layout, 1400);

    fs.setFileSilently('/ws/plan.md', '# Draft\n\nmore');
    fs.emitFileChange('/ws/plan.md');

    await screen.findByText('more');
    await waitFor(() => expect(scroller.scrollTop).toBe(1200));
    observer.disconnect();
  });

  it('holds position one pixel past the stick-to-bottom threshold', async () => {
    const fs = fsWith({ '/ws/plan.md': '# Draft' });
    renderLive(fs, '/ws/plan.md');
    const scroller = await screen.findByTestId('preview-scroll');
    // 41px from the end: one pixel too far to be carried along. Pins the
    // constant from above — a wider threshold would sweep this reader down.
    const layout = fakeLayout(scroller, 1000, 200, 759);
    const observer = resetScrollOnContentSwap(scroller, layout);

    fs.setFileSilently('/ws/plan.md', '# Draft\n\nmore');
    fs.emitFileChange('/ws/plan.md');

    await screen.findByText('more');
    await waitFor(() => expect(scroller.scrollTop).toBe(759));
    observer.disconnect();
  });

  it('warns instead of swapping when the run finishes under a dirty draft', async () => {
    const fs = fsWith({ '/ws/plan.md': 'original' });
    const view = (live: boolean) => (
      <FileSystemProvider fs={fs}>
        <FilePreview path="/ws/plan.md" onDirtyChange={() => {}} live={live} />
      </FileSystemProvider>
    );
    const { rerender } = render(view(true));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mine' } });

    // The run's last write lands in the window between the final poll and
    // `live` going false, so no watcher event ever fires for it.
    fs.setFileSilently('/ws/plan.md', 'theirs');
    rerender(view(false));

    expect(await screen.findByText(/changed on disk/i)).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('mine');

    // And the swap really was skipped: `loaded.mtimeMs` still predates that
    // write, so the save-time guard is still armed for it. Reading the file
    // to raise the notice must not cost the reader that protection.
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByRole('button', { name: /overwrite/i })).toBeInTheDocument();
  });

  it("does not clear the next file's notice with a late re-read of the previous one", async () => {
    const fs = fsWith({ '/ws/a.md': 'alpha', '/ws/b.md': 'bravo' });
    const view = (path: string) => (
      <FileSystemProvider fs={fs}>
        <FilePreview path={path} onDirtyChange={() => {}} live />
      </FileSystemProvider>
    );
    const { rerender } = render(view('/ws/a.md'));
    await screen.findByText('alpha');

    let release: (() => void) | undefined;
    let readCompleted = false;
    const realReadFile = fs.readFile.bind(fs);
    vi.spyOn(fs, 'readFile').mockImplementation(async filePath => {
      if (filePath === '/ws/a.md') await new Promise<void>(resolve => { release = resolve; });
      const bytes = await realReadFile(filePath);
      if (filePath === '/ws/a.md') readCompleted = true;
      return bytes;
    });

    fs.setFileSilently('/ws/a.md', 'alpha changed');
    fs.emitFileChange('/ws/a.md');
    await waitFor(() => expect(release).toBeDefined());

    // The reader moves on, starts editing, and something writes *that* file.
    rerender(view('/ws/b.md'));
    await screen.findByText('bravo');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mine' } });
    fs.setFileSilently('/ws/b.md', 'theirs');
    fs.emitFileChange('/ws/b.md');
    await screen.findByText(/changed on disk/i);

    release?.();
    await waitFor(() => expect(readCompleted).toBe(true));
    await act(async () => {});

    // The stale read belongs to a file nobody is looking at any more; it does
    // not get to dismiss a warning about this one.
    expect(screen.getByText(/changed on disk/i)).toBeInTheDocument();
  });

  it("does not apply the previous file's scroll offset to the next one", async () => {
    const fs = fsWith({ '/ws/a.md': 'alpha', '/ws/b.md': 'bravo' });
    const view = (path: string) => (
      <FileSystemProvider fs={fs}>
        <FilePreview path={path} onDirtyChange={() => {}} live />
      </FileSystemProvider>
    );
    const { rerender } = render(view('/ws/a.md'));
    await screen.findByText('alpha');
    fakeLayout(screen.getByTestId('preview-scroll'), 1000, 200, 300);

    let release: (() => void) | undefined;
    let readCompleted = false;
    const realReadFile = fs.readFile.bind(fs);
    vi.spyOn(fs, 'readFile').mockImplementation(async filePath => {
      if (filePath === '/ws/a.md') await new Promise<void>(resolve => { release = resolve; });
      const bytes = await realReadFile(filePath);
      if (filePath === '/ws/a.md') readCompleted = true;
      return bytes;
    });

    fs.setFileSilently('/ws/a.md', 'alpha changed');
    fs.emitFileChange('/ws/a.md');
    await waitFor(() => expect(release).toBeDefined());

    // The reader opens another file and is at the top of it. Selecting a
    // file remounts the pane through its loading state, so this is a *new*
    // scroll container — and `scrollRef` now points at it, which is exactly
    // what makes the stale offset reachable.
    rerender(view('/ws/b.md'));
    await screen.findByText('bravo');
    const scroller = screen.getByTestId('preview-scroll');
    fakeLayout(scroller, 1000, 200, 0);

    release?.();
    await waitFor(() => expect(readCompleted).toBe(true));
    await nextFrame();
    await nextFrame();

    expect(scroller.scrollTop).toBe(0);
  });
});
