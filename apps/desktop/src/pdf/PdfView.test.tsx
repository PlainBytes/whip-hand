import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PdfView } from './PdfView.tsx';

// pdf.js is never loaded for real here, the same way Mermaid.test.tsx never
// loads mermaid: it needs a worker and a real canvas, and jsdom has neither.
// load-pdfjs.ts is the one seam, so the fake below stands in for the whole
// module — a document, its pages, and their render tasks — with each render
// held open until a test settles it.
const loader = vi.hoisted(() => ({ loadPdfjs: vi.fn() }));
vi.mock('./load-pdfjs.ts', () => loader);

interface Size { width: number; height: number }

interface FakeRender {
  page: number;
  scale: number;
  canvas: HTMLCanvasElement;
  cancel: ReturnType<typeof vi.fn>;
  finish: () => void;
  fail: (error: unknown) => void;
}

/** pdf.js's exceptions are Errors told apart by `name`, which is all PdfView looks at. */
function pdfException(name: string, message: string) {
  return Object.assign(new Error(message), { name });
}

/**
 * `cancelRejects: false` models pdf.js's cancellation for what it is —
 * cooperative: a draw already on its last operation can still finish after
 * cancel() was called, and its promise then resolves rather than rejecting.
 */
function fakeDocument(sizes: Size[], { cancelRejects = true } = {}) {
  const renders: FakeRender[] = [];
  const pages = sizes.map((size, i) => ({
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: size.width * scale, height: size.height * scale, scale,
    })),
    render: vi.fn(({ canvas, viewport }: { canvas: HTMLCanvasElement; viewport: { scale: number } }) => {
      let finish!: () => void;
      let fail!: (error: unknown) => void;
      const promise = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
      // As pdf.js does: cancelling rejects the render's promise.
      const cancel = vi.fn(() => {
        if (cancelRejects) fail(pdfException('RenderingCancelledException', 'Rendering cancelled'));
      });
      renders.push({ page: i + 1, scale: viewport.scale, canvas, cancel, finish, fail });
      return { promise, cancel };
    }),
    cleanup: vi.fn(() => true),
  }));
  const loadingTask = {
    promise: Promise.resolve({ numPages: pages.length, getPage: vi.fn(async (n: number) => pages[n - 1]) }),
    destroy: vi.fn(async () => {}),
  };
  return { pages, loadingTask, renders };
}

function fakeFailingDocument(error: unknown) {
  const promise = Promise.reject(error);
  promise.catch(() => {}); // settled by the component; not an unhandled rejection in the meantime
  return { promise, destroy: vi.fn(async () => {}) };
}

const getDocument = vi.fn();

/**
 * The IntersectionObserver jsdom doesn't have. `setNear` plays the browser's
 * part: every observed page is reported, as near or far.
 */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(readonly callback: IntersectionObserverCallback, readonly options?: IntersectionObserverInit) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
  setNear(indices: number[]) {
    const entries = [...this.targets].map(target => ({
      target,
      isIntersecting: indices.includes(Number((target as HTMLElement).dataset.pageIndex)),
    }) as unknown as IntersectionObserverEntry);
    act(() => this.callback(entries, this as unknown as IntersectionObserver));
  }
}

/**
 * Waits for the document to be on screen *and* for its IntersectionObserver
 * to exist. The page count appears on the commit that shows the document,
 * but the observer is created in a passive effect, which React may not have
 * run by the time findByText resolves (the same gap FindBar.test.tsx
 * describes) — so a test that went straight to `observer()` would fail, now
 * and then, for want of an observer that was a moment away.
 */
async function shown(pageCount: string): Promise<void> {
  await screen.findByText(pageCount);
  await waitFor(() => expect(FakeIntersectionObserver.instances.length).toBeGreaterThan(0));
}

function observer(): FakeIntersectionObserver {
  const latest = FakeIntersectionObserver.instances.at(-1);
  if (!latest) throw new Error('no IntersectionObserver was created');
  return latest;
}

/** A controllable ResizeObserver: the global stub in test/setup.ts never fires. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  constructor(readonly callback: ResizeObserverCallback) { FakeResizeObserver.instances.push(this); }
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** jsdom lays nothing out; this is the scroller's width inside its scrollbar. */
let paneWidth = 0;

function resizePane(width: number) {
  paneWidth = width;
  act(() => {
    for (const instance of FakeResizeObserver.instances) instance.callback([], instance as unknown as ResizeObserver);
  });
}

function placeholders(): HTMLElement[] {
  return screen.getAllByRole('img', { name: /^Page \d+ of \d+$/ });
}

const bytes = () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7

// 400pt-wide pages in a 632px pane: 600px to fit into once the 16px padding
// either side is taken off, so fit-width is exactly 150% — between the 125%
// and 175% zoom steps, which is what the zoom buttons have to cope with.
const PAGE = { width: 400, height: 500 };
const FIT_PANE = 632;

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  FakeResizeObserver.instances = [];
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  paneWidth = FIT_PANE;
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
    return (this as HTMLElement).dataset?.testid === 'pdf-scroll' ? paneWidth : 0;
  });
  getDocument.mockReset();
  loader.loadPdfjs.mockReset();
  loader.loadPdfjs.mockResolvedValue({ getDocument });
});

afterEach(() => {
  // Unmount before the fakes go: this file's afterEach runs ahead of
  // test/setup.ts's cleanup(), and an effect React scheduled but had not yet
  // run (the IntersectionObserver one, after a document loaded late in a
  // test) would otherwise run in between and find no IntersectionObserver.
  // Unmounting flushes it first, with the fakes still in place.
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PdfView', () => {
  it('lays out one placeholder per page, sized at fit-width before any is drawn, and counts them', async () => {
    const doc = fakeDocument([PAGE, PAGE, { width: 800, height: 400 }]);
    getDocument.mockReturnValue(doc.loadingTask);
    render(<PdfView path="/ws/spec.pdf" bytes={bytes()} />);

    expect(await screen.findByText('3 pages')).toBeInTheDocument();
    expect(screen.getByText('/ws/spec.pdf')).toBeInTheDocument();
    expect(screen.getByText('150%')).toBeInTheDocument();
    const pages = placeholders();
    expect(pages.map(page => page.getAttribute('aria-label'))).toEqual(['Page 1 of 3', 'Page 2 of 3', 'Page 3 of 3']);
    expect(pages[0]).toHaveStyle({ width: '600px', height: '750px' });
    // The first page decides fit-width; a wider page is drawn at the same
    // scale and scrolls sideways rather than shrinking everything else.
    expect(pages[2]).toHaveStyle({ width: '1200px', height: '600px' });
    for (const page of doc.pages) expect(page.render).not.toHaveBeenCalled();
  });

  it('centres each page by itself, so one wide page neither shifts the others nor overflows out of reach', async () => {
    // jsdom has no layout, so this pins the style contract (as FilePreview's
    // editor-sizing tests do). The bug it guards was seen in a real browser:
    // with the pages centred in a max-content column, a single landscape
    // page widened the column past the pane and pushed every portrait page
    // off-centre and half out of view.
    getDocument.mockReturnValue(fakeDocument([PAGE, { width: 800, height: 400 }]).loadingTask);
    render(<PdfView path="/ws/spec.pdf" bytes={bytes()} />);
    await shown('2 pages');
    for (const page of placeholders()) expect(page).toHaveStyle({ marginLeft: 'auto', marginRight: 'auto' });
    const column = placeholders()[0].parentElement;
    expect(column?.style.alignItems).toBe('');
    expect(column?.style.width).toBe('');
  });

  it('says "1 page" for a single page', async () => {
    getDocument.mockReturnValue(fakeDocument([PAGE]).loadingTask);
    render(<PdfView path="/ws/one.pdf" bytes={bytes()} />);
    expect(await screen.findByText('1 page')).toBeInTheDocument();
  });

  it('draws only the pages near the viewport', async () => {
    const doc = fakeDocument([PAGE, PAGE, PAGE, PAGE]);
    getDocument.mockReturnValue(doc.loadingTask);
    render(<PdfView path="/ws/spec.pdf" bytes={bytes()} />);
    await shown('4 pages');

    expect(observer().options?.root).toBe(screen.getByTestId('pdf-scroll'));
    expect(observer().targets.size).toBe(4);
    observer().setNear([0, 1]);

    expect(doc.pages[0].render).toHaveBeenCalledTimes(1);
    expect(doc.pages[1].render).toHaveBeenCalledTimes(1);
    expect(doc.pages[2].render).not.toHaveBeenCalled();
    expect(doc.pages[3].render).not.toHaveBeenCalled();
  });

  it('puts a finished page on screen, and gives its canvas back once it is far away', async () => {
    const doc = fakeDocument([PAGE, PAGE]);
    getDocument.mockReturnValue(doc.loadingTask);
    render(<PdfView path="/ws/spec.pdf" bytes={bytes()} />);
    await shown('2 pages');

    observer().setNear([0]);
    const [first] = doc.renders;
    expect(first.canvas.width).toBe(600);
    expect(first.canvas.height).toBe(750);
    await act(async () => first.finish());
    expect(placeholders()[0].querySelector('canvas')).toBe(first.canvas);

    observer().setNear([1]);
    expect(placeholders()[0].querySelector('canvas')).toBeNull();
    expect(first.canvas.width).toBe(0);
    expect(first.canvas.height).toBe(0);
    expect(doc.pages[0].cleanup).toHaveBeenCalled();
  });

  it('never puts a draw abandoned for a newer one on screen, even if it finishes after all', async () => {
    const doc = fakeDocument([PAGE], { cancelRejects: false });
    getDocument.mockReturnValue(doc.loadingTask);
    render(<PdfView path="/ws/spec.pdf" bytes={bytes()} />);
    await shown('1 page');
    observer().setNear([0]);

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    const [stale, current] = doc.renders;
    expect(stale.cancel).toHaveBeenCalled();

    await act(async () => stale.finish());
    expect(placeholders()[0].querySelector('canvas')).toBeNull();
    expect(stale.canvas.width).toBe(0);

    await act(async () => current.finish());
    expect(placeholders()[0].querySelector('canvas')).toBe(current.canvas);
  });

  it('draws at scale × devicePixelRatio and shows the canvas at scale, for crisp HiDPI pages', async () => {
    const original = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    try {
      const doc = fakeDocument([PAGE]);
      getDocument.mockReturnValue(doc.loadingTask);
      render(<PdfView path="/ws/spec.pdf" bytes={bytes()} />);
      await shown('1 page');
      observer().setNear([0]);

      const [drawn] = doc.renders;
      expect(drawn.scale).toBe(3);
      expect(drawn.canvas.width).toBe(1200);
      expect(placeholders()[0]).toHaveStyle({ width: '600px' });
      expect(drawn.canvas.style.width).toBe('100%');
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { value: original, configurable: true });
    }
  });

  it('zooms by steps from the fit-width scale, redraws the visible pages, and Fit width restores it', async () => {
    const doc = fakeDocument([PAGE, PAGE]);
    getDocument.mockReturnValue(doc.loadingTask);
    render(<PdfView path="/ws/spec.pdf" bytes={bytes()} />);
    await shown('2 pages');
    observer().setNear([0]);
    const firstDraw = doc.renders[0];

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByText('175%')).toBeInTheDocument();
    expect(placeholders()[0]).toHaveStyle({ width: '700px' });
    // The draw at the old scale is abandoned, and the page drawn again at the new one.
    expect(firstDraw.cancel).toHaveBeenCalled();
    expect(doc.renders.at(-1)).toMatchObject({ page: 1, scale: 1.75 });
    expect(doc.pages[1].render).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Fit width' }));
    expect(screen.getByText('150%')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(screen.getByText('125%')).toBeInTheDocument();
    // A cancelled draw is the viewer's own doing, not a page that failed.
    await act(async () => {});
    expect(screen.queryByText(/could not render page/i)).not.toBeInTheDocument();
  });

  it('follows the pane as it resizes until someone zooms by hand, and again after Fit width', async () => {
    getDocument.mockReturnValue(fakeDocument([PAGE]).loadingTask);
    render(<PdfView path="/ws/spec.pdf" bytes={bytes()} />);
    await shown('1 page');
    expect(screen.getByRole('button', { name: 'Fit width' })).toHaveAttribute('aria-pressed', 'true');

    resizePane(832); // 800px of content: 200%
    expect(screen.getByText('200%')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(screen.getByText('175%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fit width' })).toHaveAttribute('aria-pressed', 'false');
    resizePane(432);
    expect(screen.getByText('175%')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Fit width' }));
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('stops the zoom buttons at 25% and 400%', async () => {
    getDocument.mockReturnValue(fakeDocument([PAGE]).loadingTask);
    render(<PdfView path="/ws/spec.pdf" bytes={bytes()} />);
    await shown('1 page');

    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
    for (let i = 0; i < 20; i++) fireEvent.click(zoomIn);
    expect(screen.getByText('400%')).toBeInTheDocument();
    expect(zoomIn).toBeDisabled();

    const zoomOut = screen.getByRole('button', { name: 'Zoom out' });
    for (let i = 0; i < 20; i++) fireEvent.click(zoomOut);
    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(zoomOut).toBeDisabled();
  });

  it('hands pdf.js a copy of the bytes, with eval and XFA off', async () => {
    getDocument.mockReturnValue(fakeDocument([PAGE]).loadingTask);
    const original = bytes();
    render(<PdfView path="/ws/spec.pdf" bytes={original} />);
    await shown('1 page');

    expect(getDocument).toHaveBeenCalledTimes(1);
    const params = getDocument.mock.calls[0][0] as { data: Uint8Array; isEvalSupported: boolean; enableXfa: boolean };
    expect(params.isEvalSupported).toBe(false);
    expect(params.enableXfa).toBe(false);
    expect(Array.from(params.data)).toEqual(Array.from(original));
    // pdf.js transfers what it is given to its worker and detaches it; the
    // caller's buffer must not be the one that goes.
    expect(params.data.buffer).not.toBe(original.buffer);
  });

  it('says a password-protected PDF is one, without offering a prompt', async () => {
    getDocument.mockReturnValue(fakeFailingDocument(pdfException('PasswordException', 'No password given')));
    render(<PdfView path="/ws/locked.pdf" bytes={bytes()} />);
    expect(await screen.findByText('This PDF is password-protected.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Zoom in' })).not.toBeInTheDocument();
  });

  it('reports a corrupt or truncated file in the pane', async () => {
    getDocument.mockReturnValue(fakeFailingDocument(pdfException('InvalidPDFException', 'Invalid PDF structure.')));
    render(<PdfView path="/ws/broken.pdf" bytes={bytes()} />);
    expect(await screen.findByText('Could not render this PDF: Invalid PDF structure.')).toBeInTheDocument();
  });

  it('reports pdf.js itself failing to load, rather than spinning forever', async () => {
    loader.loadPdfjs.mockRejectedValue(new Error('Failed to fetch dynamically imported module'));
    render(<PdfView path="/ws/spec.pdf" bytes={bytes()} />);
    expect(await screen.findByText(/Could not render this PDF: Failed to fetch dynamically imported module/))
      .toBeInTheDocument();
  });

  it('shows a page that fails to draw as an error in its own place, and draws the rest', async () => {
    const doc = fakeDocument([PAGE, PAGE]);
    getDocument.mockReturnValue(doc.loadingTask);
    render(<PdfView path="/ws/spec.pdf" bytes={bytes()} />);
    await shown('2 pages');
    observer().setNear([0, 1]);

    const [first, second] = doc.renders;
    await act(async () => {
      first.fail(new Error('Bad XRef entry'));
      second.finish();
    });
    expect(placeholders()[0]).toHaveTextContent('Could not render page 1: Bad XRef entry');
    expect(placeholders()[1].querySelector('canvas')).toBe(second.canvas);
  });

  it('destroys the document and cancels its draws on unmount', async () => {
    const doc = fakeDocument([PAGE, PAGE]);
    getDocument.mockReturnValue(doc.loadingTask);
    const { unmount } = render(<PdfView path="/ws/spec.pdf" bytes={bytes()} />);
    await shown('2 pages');
    observer().setNear([0, 1]);

    unmount();
    expect(doc.loadingTask.destroy).toHaveBeenCalledTimes(1);
    for (const drawing of doc.renders) expect(drawing.cancel).toHaveBeenCalled();
  });

  it('starts over for another file: the old document is destroyed and its draws cancelled', async () => {
    const first = fakeDocument([PAGE, PAGE]);
    const second = fakeDocument([PAGE]);
    getDocument.mockReturnValueOnce(first.loadingTask).mockReturnValueOnce(second.loadingTask);
    const { rerender } = render(<PdfView path="/ws/a.pdf" bytes={bytes()} />);
    await shown('2 pages');
    observer().setNear([0]);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    const inFlight = first.renders.at(-1);
    if (!inFlight) throw new Error('page 1 was never drawn');

    rerender(<PdfView path="/ws/b.pdf" bytes={bytes()} />);
    expect(first.loadingTask.destroy).toHaveBeenCalledTimes(1);
    expect(inFlight.cancel).toHaveBeenCalled();

    expect(await screen.findByText('1 page')).toBeInTheDocument();
    expect(getDocument).toHaveBeenCalledTimes(2);
    // Zoom is per file: the next one opens at fit-width again.
    expect(screen.getByText('150%')).toBeInTheDocument();
  });
});
