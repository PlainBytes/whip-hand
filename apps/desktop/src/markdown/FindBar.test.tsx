import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FileSystemProvider } from '../files/fs-context.tsx';
import { FakeFileSystem } from '../files/fake-fs.ts';
import { FilePreview, resetPreviewViewForTests } from '../components/FilePreview.tsx';

// mermaid is never loaded for real under jsdom (it needs layout APIs jsdom
// doesn't implement), and here the *timing* of its render is the subject: a
// fence shows its source in a <pre> until the SVG arrives. The gate lets a
// test hold the diagram unrendered, count, then release it and count again.
const mermaidGate = vi.hoisted(() => {
  let release = () => {};
  let ready: Promise<void> = Promise.resolve();
  return {
    reset() { ready = new Promise<void>(resolve => { release = () => resolve(); }); },
    release() { release(); },
    ready() { return ready; },
  };
});

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => {
      await mermaidGate.ready();
      return { svg: '<svg data-testid="diagram"></svg>' };
    }),
  },
}));

beforeEach(() => {
  mermaidGate.reset();
});

// The Rendered/Source preference is module-scope in FilePreview (deliberately
// — it outlives the component), so the source-view test below would otherwise
// decide the starting view for every test after it.
afterEach(() => {
  resetPreviewViewForTests();
});

function renderDoc(text: string) {
  const fs = new FakeFileSystem();
  fs.setFile('/ws/plan.md', text);
  return render(
    <FileSystemProvider fs={fs}>
      <FilePreview path="/ws/plan.md" onDirtyChange={() => {}} />
    </FileSystemProvider>,
  );
}

/** A cancelable Ctrl-F, so a test can see whether the shortcut swallowed it. */
function ctrlF(): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
}

/** One Ctrl-F at the pane. True when the shortcut consumed it. */
function pressFind(container: HTMLElement, target?: Element): boolean {
  const element = target ?? container.querySelector('[data-testid="preview-scroll"]')!;
  // A fresh event every press: defaultPrevented sticks to the one already
  // dispatched, which would make a later miss look like a hit.
  const event = ctrlF();
  fireEvent(element, event);
  return event.defaultPrevented;
}

/**
 * Ctrl-F, pressed until the shortcut is actually listening.
 *
 * `findByText` resolves the moment the document is committed to the DOM, but
 * the window listener this shortcut needs is registered in a passive effect,
 * which React has not necessarily run by then. A single keystroke fired into
 * that gap is heard by nobody, and nothing re-delivers it — the bar simply
 * never opens, and by the time the assertion times out the effect has long
 * since run, so the printed DOM looks perfectly healthy. That is a race in the
 * test, not in the pane: no reader presses a key in the microseconds between
 * the document painting and an effect running.
 *
 * Only for the tests that expect the bar to open. Where the shortcut is meant
 * to stand down — over the editor, over a file that is not markdown — press it
 * once with `pressFind` instead: there is nothing to wait for there, and
 * waiting for it would assert the opposite of the point.
 */
async function openFind(container: HTMLElement, target?: Element) {
  await waitFor(() => expect(pressFind(container, target)).toBe(true));
}

describe('find in document', () => {
  it('opens on ctrl+f and counts the matches', async () => {
    const { container } = renderDoc('We use PKCE. PKCE is good. PKCE again.');
    await screen.findByText(/We use/);
    await openFind(container);
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'PKCE' } });
    expect(await screen.findByText('1/3')).toBeInTheDocument();
  });

  it('opens on cmd+f too, for a mac keyboard', async () => {
    const { container } = renderDoc('PKCE');
    await screen.findByText('PKCE');
    // Same wait as Ctrl-F, for the same reason — see openFind.
    await waitFor(() => {
      const event = new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true });
      fireEvent(container.querySelector('[data-testid="preview-scroll"]')!, event);
      expect(event.defaultPrevented).toBe(true);
    });
    expect(await screen.findByRole('searchbox')).toBeInTheDocument();
  });

  it('highlights every match', async () => {
    const { container } = renderDoc('PKCE and PKCE');
    await screen.findByText(/PKCE/);
    await openFind(container);
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'PKCE' } });
    await waitFor(() => expect(container.querySelectorAll('mark[data-find-index]')).toHaveLength(2));
  });

  it('marks only the current match as active', async () => {
    const { container } = renderDoc('a a');
    await screen.findByText('a a');
    await openFind(container);
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'a' } });
    await waitFor(() => expect(container.querySelectorAll('mark[data-find-active="true"]')).toHaveLength(1));
    expect(container.querySelector('mark[data-find-active="true"]')).toHaveAttribute('data-find-index', '0');

    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() => {
      expect(container.querySelector('mark[data-find-active="true"]')).toHaveAttribute('data-find-index', '1');
    });
    expect(container.querySelectorAll('mark[data-find-active="true"]')).toHaveLength(1);
  });

  it('steps forward and wraps around', async () => {
    const { container } = renderDoc('a a');
    await screen.findByText(/a a/);
    await openFind(container);
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'a' } });
    await screen.findByText('1/2');
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(await screen.findByText('2/2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(await screen.findByText('1/2')).toBeInTheDocument();
  });

  it('steps backwards and wraps around', async () => {
    const { container } = renderDoc('a a');
    await screen.findByText(/a a/);
    await openFind(container);
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'a' } });
    await screen.findByText('1/2');
    fireEvent.click(screen.getByRole('button', { name: /previous/i }));
    expect(await screen.findByText('2/2')).toBeInTheDocument();
  });

  it('steps with enter and shift+enter without leaving the box', async () => {
    const { container } = renderDoc('a a a');
    await screen.findByText('a a a');
    await openFind(container);
    const box = await screen.findByRole('searchbox');
    fireEvent.change(box, { target: { value: 'a' } });
    await screen.findByText('1/3');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText('2/3')).toBeInTheDocument();
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(await screen.findByText('1/3')).toBeInTheDocument();
  });

  it('starts a new query from its first match', async () => {
    const { container } = renderDoc('alpha alpha beta beta');
    await screen.findByText(/alpha/);
    await openFind(container);
    const box = await screen.findByRole('searchbox');
    fireEvent.change(box, { target: { value: 'alpha' } });
    await screen.findByText('1/2');
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    await screen.findByText('2/2');
    fireEvent.change(box, { target: { value: 'beta' } });
    expect(await screen.findByText('1/2')).toBeInTheDocument();
  });

  it('says so when nothing matches', async () => {
    const { container } = renderDoc('nothing here');
    await screen.findByText(/nothing here/);
    await openFind(container);
    const box = await screen.findByRole('searchbox');
    // A found query first: '0/0' is also the bar's opening state, so
    // asserting it straight away would pass even if counting never ran.
    fireEvent.change(box, { target: { value: 'here' } });
    expect(await screen.findByText('1/1')).toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(await screen.findByText('0/0')).toBeInTheDocument();
  });

  it('closes on escape and clears the highlights', async () => {
    const { container } = renderDoc('PKCE');
    await screen.findByText('PKCE');
    await openFind(container);
    const box = await screen.findByRole('searchbox');
    fireEvent.change(box, { target: { value: 'PKCE' } });
    await waitFor(() => expect(container.querySelector('mark')).not.toBeNull());
    fireEvent.keyDown(box, { key: 'Escape' });
    await waitFor(() => expect(container.querySelector('mark')).toBeNull());
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('closes from the close button', async () => {
    const { container } = renderDoc('PKCE');
    await screen.findByText('PKCE');
    await openFind(container);
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'PKCE' } });
    await waitFor(() => expect(container.querySelector('mark')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /close find/i }));
    await waitFor(() => expect(screen.queryByRole('searchbox')).not.toBeInTheDocument());
    expect(container.querySelector('mark')).toBeNull();
  });

  it('searches the source view over text the rendered view never shows', async () => {
    // The link's target is on screen in Source and gone in Rendered, so the
    // two views must disagree — 1 against 2. A fixture that counted the same
    // either way would pass without the source path ever running.
    const { container } = renderDoc('See [PKCE](./notes/PKCE.md) for detail.');
    await screen.findByText(/for detail/);
    await openFind(container);
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'PKCE' } });
    expect(await screen.findByText('1/1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Source' }));
    expect(await screen.findByText('2 matches')).toBeInTheDocument();
  });

  it('offers no stepping in the source view, where nothing is marked to step to', async () => {
    const { container } = renderDoc('PKCE and PKCE');
    await screen.findByText(/PKCE/);
    await openFind(container);
    const box = await screen.findByRole('searchbox');
    fireEvent.change(box, { target: { value: 'PKCE' } });
    // Enabled in Rendered, so the assertion below is about the view and not
    // about the controls being permanently dead.
    await screen.findByText('1/2');
    expect(screen.getByRole('button', { name: /next/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /previous/i })).toBeEnabled();

    fireEvent.click(screen.getByRole('tab', { name: 'Source' }));
    // A tally, not a position: there is no current match to be at.
    expect(await screen.findByText('2 matches')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText('2 matches')).toBeInTheDocument();
  });

  it('reports the occurrences inside fenced code that the rendered view cannot reach', async () => {
    // The rehype plugin deliberately skips anything under a <pre>: CodeBlock
    // renders through dangerouslySetInnerHTML, so a <mark> there would be
    // counted but never shown. The count would then silently mean something
    // different in each view, so the bar says what it is leaving out.
    const { container } = renderDoc('PKCE in prose.\n\n```js\nconst PKCE = 1;\n```\n');
    await screen.findByText(/PKCE in prose/);
    await openFind(container);
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'PKCE' } });
    expect(await screen.findByText('1/1')).toBeInTheDocument();
    expect(await screen.findByText('+1 in code blocks')).toBeInTheDocument();
    expect(container.querySelectorAll('mark[data-find-index]')).toHaveLength(1);
  });

  it('says nothing about code blocks when the query is not in one', async () => {
    const { container } = renderDoc('PKCE in prose.\n\n```js\nconst answer = 1;\n```\n');
    await screen.findByText(/PKCE in prose/);
    await openFind(container);
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'PKCE' } });
    expect(await screen.findByText('1/1')).toBeInTheDocument();
    expect(screen.queryByText(/in code blocks/)).not.toBeInTheDocument();
  });

  it('counts fenced code in the source view, where the code really is on screen', async () => {
    // The complement of the test above: source view shows the fence verbatim,
    // so its plain-text scan includes it and the count is honest there too.
    const { container } = renderDoc('PKCE in prose.\n\n```js\nconst PKCE = 1;\n```\n');
    fireEvent.click(await screen.findByRole('tab', { name: 'Source' }));
    await openFind(container);
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'PKCE' } });
    expect(await screen.findByText('2 matches')).toBeInTheDocument();
    expect(screen.queryByText(/in code blocks/)).not.toBeInTheDocument();
  });

  it('reports a mermaid fence the same before and after the diagram renders', async () => {
    // The fence's source sits in a real <pre> until the SVG replaces it, and
    // the counting effect does not re-run when it does. Counting it would
    // make the answer depend on whether the reader pressed Ctrl/Cmd-F before
    // or after the diagram drew — the same document, two answers.
    const { container } = renderDoc('PKCE in prose.\n\n```mermaid\ngraph LR\n  PKCE --> token\n```\n');
    await screen.findByText(/PKCE in prose/);
    // The stand-in really is on screen, so the assertions below are not
    // passing merely because there is nothing there to miscount.
    expect(container.querySelector('pre[data-fallback-for="diagram"]')).not.toBeNull();

    await openFind(container);
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'PKCE' } });
    expect(await screen.findByText('1/1')).toBeInTheDocument();
    expect(screen.queryByText(/in code blocks/)).not.toBeInTheDocument();

    mermaidGate.release();
    await screen.findByTestId('diagram');
    expect(await screen.findByText('1/1')).toBeInTheDocument();
    expect(screen.queryByText(/in code blocks/)).not.toBeInTheDocument();
  });

  it('does not resurrect a stale index when a live document shrinks and grows again', async () => {
    const fs = new FakeFileSystem();
    fs.setFile('/ws/plan.md', 'a a a');
    const { container } = render(
      <FileSystemProvider fs={fs}>
        <FilePreview path="/ws/plan.md" onDirtyChange={() => {}} live />
      </FileSystemProvider>,
    );
    await screen.findByText('a a a');
    await openFind(container);
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'a' } });
    await screen.findByText('1/3');
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    await screen.findByText('3/3');

    // The writer truncates the document: the third match no longer exists.
    fs.setFileSilently('/ws/plan.md', 'a');
    fs.emitFileChange('/ws/plan.md');
    expect(await screen.findByText('1/1')).toBeInTheDocument();

    // ...and writes it back. Clamping only on the way to the screen would
    // have left findIndex at 2, and the active match would jump to the end
    // here without the reader touching anything.
    fs.setFileSilently('/ws/plan.md', 'a a a');
    fs.emitFileChange('/ws/plan.md');
    await waitFor(() => expect(screen.getByText('1/3')).toBeInTheDocument());
  });

  it('matches without regard to case', async () => {
    const { container } = renderDoc('Pkce and pkce and PKCE');
    await screen.findByText(/Pkce/);
    await openFind(container);
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'pkce' } });
    expect(await screen.findByText('1/3')).toBeInTheDocument();
  });

  it('treats the query as literal text, not a pattern', async () => {
    const { container } = renderDoc('a.b and axb');
    await screen.findByText(/a\.b/);
    await openFind(container);
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'a.b' } });
    expect(await screen.findByText('1/1')).toBeInTheDocument();
  });

  it('refocuses the box when ctrl+f is pressed again', async () => {
    const { container } = renderDoc('PKCE');
    await screen.findByText('PKCE');
    await openFind(container);
    const box = await screen.findByRole('searchbox');
    fireEvent.change(box, { target: { value: 'PKCE' } });
    (container.querySelector('[data-testid="preview-scroll"]') as HTMLElement).focus();
    expect(document.activeElement).not.toBe(box);
    await openFind(container);
    await waitFor(() => expect(document.activeElement).toBe(box));
    // Pressing it again means "search for something else": the standing query
    // is selected so the next keystroke replaces it.
    expect((box as HTMLInputElement).selectionStart).toBe(0);
    expect((box as HTMLInputElement).selectionEnd).toBe('PKCE'.length);
  });

  it('opens from anywhere in the window, not only from inside the preview', async () => {
    // The realistic sequence is to click a file in the tree and then press
    // Ctrl-F, with focus nowhere near the preview pane — which a handler on
    // the pane itself never sees. There is no native webview find to fall
    // back on, so that version of the shortcut is one nobody ever finds.
    const { container } = renderDoc('PKCE');
    await screen.findByText('PKCE');
    expect(document.activeElement).toBe(document.body);
    await openFind(container, document.body);
    expect(await screen.findByRole('searchbox')).toBeInTheDocument();
  });

  it('leaves ctrl+f alone while the reader is typing in the editor', async () => {
    // A window-level shortcut swallows the keystroke wherever it fires
    // (useGlobalShortcut calls preventDefault before the handler), so
    // "the bar did not open" is not enough on its own — the editor's own
    // Ctrl-F has to reach the editor unconsumed.
    renderDoc('PKCE');
    await screen.findByText('PKCE');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const textarea = await screen.findByRole('textbox');

    const inEditor = ctrlF();
    textarea.dispatchEvent(inEditor);
    expect(inEditor.defaultPrevented).toBe(false);

    // And from outside the editor, where the typing guard does not apply.
    // The shortcut is not subscribed at all while the editor is open, so it
    // does not consume the keystroke there either.
    const outside = ctrlF();
    document.body.dispatchEvent(outside);
    expect(outside.defaultPrevented).toBe(false);

    await waitFor(() => expect(screen.queryByRole('searchbox')).not.toBeInTheDocument());
  });

  it('still refocuses and selects the query when ctrl+f is pressed inside the find box', async () => {
    // The find box is an <input>, so the window-level shortcut stands down
    // for it by design — the pane keeps a handler of its own for exactly
    // this case, and without it a second Ctrl-F from the box does nothing.
    renderDoc('PKCE');
    await screen.findByText('PKCE');
    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true });
    const box = await screen.findByRole('searchbox');
    fireEvent.change(box, { target: { value: 'PKCE' } });
    (box as HTMLInputElement).setSelectionRange(4, 4);

    fireEvent.keyDown(box, { key: 'f', ctrlKey: true });
    await waitFor(() => expect((box as HTMLInputElement).selectionStart).toBe(0));
    expect((box as HTMLInputElement).selectionEnd).toBe('PKCE'.length);
    expect(document.activeElement).toBe(box);
  });

  it('does not offer find while the document is being edited', async () => {
    const { container } = renderDoc('PKCE');
    await screen.findByText('PKCE');
    await openFind(container);
    expect(await screen.findByRole('searchbox')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(screen.queryByRole('searchbox')).not.toBeInTheDocument());
    // And ctrl+f in the editor is left alone rather than swallowed.
    expect(pressFind(container)).toBe(false);
    await waitFor(() => expect(screen.queryByRole('searchbox')).not.toBeInTheDocument());
  });

  it('does not offer find for a file that is not markdown', async () => {
    const fs = new FakeFileSystem();
    fs.setFile('/ws/notes.txt', 'PKCE');
    const { container } = render(
      <FileSystemProvider fs={fs}>
        <FilePreview path="/ws/notes.txt" onDirtyChange={() => {}} />
      </FileSystemProvider>,
    );
    await screen.findByText('PKCE');
    expect(pressFind(container)).toBe(false);
    await waitFor(() => expect(screen.queryByRole('searchbox')).not.toBeInTheDocument());
  });
});
