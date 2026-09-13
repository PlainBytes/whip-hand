/**
 * A PDF in the preview pane, drawn page by page onto canvases by pdf.js.
 *
 * Read-only on purpose: scroll, zoom, a page count. Only our own canvases
 * reach the DOM — no annotation layer, no text layer, none of pdf.js's
 * viewer (web/pdf_viewer.mjs, which carries the scripting and link
 * handling). An artifact's PDF may have been written by a model or attached
 * by anyone, so nothing in it gets to run code, take focus or navigate. The
 * cost of that is honest and deliberate: text can't be selected, and links
 * inside the PDF can't be clicked.
 *
 * Pages are drawn only when near the viewport and give their canvas memory
 * back when they scroll far away, so a 300-page manual costs what the few
 * pages on screen cost.
 */
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Button, MessageBar, MessageBarBody, Spinner, Text, ToggleButton, tokens,
} from '@fluentui/react-components';
import { AutoFitWidth20Regular, ZoomIn20Regular, ZoomOut20Regular } from '@fluentui/react-icons';
import type { PDFDocumentLoadingTask, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import { loadPdfjs, type PdfJs } from './load-pdfjs.ts';
import {
  fitWidthScale, formatScale, MAX_SCALE, MIN_SCALE, renderPixelRatio, zoomIn, zoomOut,
} from './zoom.ts';

/** Around the pages, and so also what fit-width leaves either side of one. */
const PANE_PADDING = 16;
const PAGE_GAP = 12;

/**
 * How far outside the viewport a page still counts as near: one screen above
 * and one below. Far enough that ordinary scrolling finds the next page
 * already drawn; near enough that a long document isn't drawn whole.
 */
const NEAR_MARGIN = '100% 0px';

interface PageSize {
  width: number;
  height: number;
}

interface OpenDocument {
  pages: PDFPageProxy[];
  /** Each page's size at scale 1, so a placeholder is the right size before it is drawn. */
  sizes: PageSize[];
}

type Failure = { kind: 'password' } | { kind: 'unreadable'; message: string };

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) return String(e.message);
  return String(e);
}

/**
 * By name rather than instanceof, which would need the lazily loaded module's
 * classes in hand wherever an error is caught. pdf.js rebuilds the worker's
 * exceptions on this side with their names intact, so the name is reliable.
 */
function nameOf(e: unknown): unknown {
  return typeof e === 'object' && e !== null && 'name' in e ? e.name : undefined;
}

function describeFailure(e: unknown): Failure {
  return nameOf(e) === 'PasswordException' ? { kind: 'password' } : { kind: 'unreadable', message: messageOf(e) };
}

function openDocument(pdfjs: PdfJs, bytes: Uint8Array): PDFDocumentLoadingTask {
  const params = {
    // A copy: pdf.js transfers this buffer to its worker, which detaches it.
    // The original belongs to FilePreview, and handing it over would leave
    // it zero-length under its owner.
    data: bytes.slice(),
    // A no-op in pdf.js 6, which has no eval path left to switch off (the
    // CVE-2024-4367 font-compilation one included). Said anyway, so that a
    // downgrade — to chase a WebKitGTK incompatibility, say — can't quietly
    // bring that path back on untrusted input.
    isEvalSupported: false,
    // pdf.js's default, stated rather than inherited: XFA forms are rendered
    // as HTML, and this viewer puts nothing from the PDF into the DOM.
    enableXfa: false,
  };
  return pdfjs.getDocument(params);
}

/** Gives a canvas's backing memory back now, rather than whenever the page is collected. */
function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

function releaseAll(holder: HTMLElement): void {
  for (const canvas of holder.querySelectorAll('canvas')) releaseCanvas(canvas);
  holder.replaceChildren();
}

interface PdfPageProps {
  page: PDFPageProxy;
  index: number;
  count: number;
  width: number;
  height: number;
  scale: number;
  near: boolean;
}

/**
 * One page: a white sheet sized from its viewport, holding a canvas while it
 * is near the viewport and nothing while it isn't.
 *
 * Memoised because the near-set is replaced on every scroll that moves a
 * page in or out of it, and only the pages whose own `near` flipped (or all
 * of them, on a zoom) have anything to redo.
 */
const PdfPage = memo(function PdfPage({ page, index, count, width, height, scale, near }: PdfPageProps) {
  // The canvas lives in a holder React never renders children into, so a
  // finished drawing can be swapped in whole. Drawing straight into the
  // canvas on screen would blank it the moment its size was set, and every
  // zoom would flash each visible page white before redrawing it.
  const holderRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const cssWidth = width * scale;
  const cssHeight = height * scale;

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    if (!near) {
      releaseAll(holder);
      // The page's parsed operator list and decoded images, which are
      // otherwise kept for a redraw that may never come.
      page.cleanup();
      return;
    }

    let cancelled = false;
    let task: RenderTask | undefined;
    const ratio = renderPixelRatio(cssWidth, cssHeight, window.devicePixelRatio || 1);
    const viewport = page.getViewport({ scale: scale * ratio });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    // Drawn at scale × devicePixelRatio, shown at scale: crisp on HiDPI.
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';

    try {
      task = page.render({ canvas, viewport });
    } catch (e) {
      releaseCanvas(canvas);
      setFailed(messageOf(e));
      return;
    }
    task.promise.then(
      () => {
        if (cancelled) {
          releaseCanvas(canvas);
          return;
        }
        releaseAll(holder);
        holder.append(canvas);
        setFailed(null);
      },
      (e: unknown) => {
        releaseCanvas(canvas);
        // A cancelled render is this effect's own cleanup at work (a zoom, a
        // scroll away, the next file), not a failure worth showing.
        if (cancelled || nameOf(e) === 'RenderingCancelledException') return;
        setFailed(messageOf(e));
      },
    );

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [page, scale, near, cssWidth, cssHeight]);

  // Unmount (another file, or none): the canvases go now, not at the next GC.
  useEffect(() => {
    const holder = holderRef.current;
    return () => {
      if (holder) releaseAll(holder);
    };
  }, []);

  return (
    <div
      data-page-index={index}
      role="img"
      aria-label={`Page ${index + 1} of ${count}`}
      style={{
        position: 'relative',
        flex: 'none',
        // Centred one page at a time, by auto margins rather than the
        // column's align-items. A page wider than the pane then overflows to
        // the right only, where it can be scrolled to. A centred one would
        // overflow to the left as well, out of reach. And centring every
        // page within the widest one would push the others off-centre.
        marginLeft: 'auto',
        marginRight: 'auto',
        width: cssWidth,
        height: cssHeight,
        // White paper in both themes, on purpose: this is the page as its
        // author made it, and inverting it for dark mode would misrepresent
        // every figure and colour in it. Only the surround follows the theme.
        // A failed page drops the paper, so its message is in theme colours.
        background: failed === null ? '#ffffff' : tokens.colorNeutralBackground1,
        boxShadow: tokens.shadow4,
      }}
    >
      <div ref={holderRef} style={{ position: 'absolute', inset: 0 }} />
      {failed !== null && (
        <Text
          size={200}
          style={{ position: 'absolute', inset: 0, padding: 12, color: tokens.colorPaletteRedForeground1 }}
        >
          Could not render page {index + 1}: {failed}
        </Text>
      )}
    </div>
  );
});

export interface PdfViewProps {
  path: string;
  bytes: Uint8Array;
}

/**
 * Keyed on the path, so everything one document owns — its zoom, which pages
 * are near, the render tasks in flight — is torn down with it and starts over
 * for the next. Zoom deliberately isn't carried from one file to another.
 */
export function PdfView({ path, bytes }: PdfViewProps) {
  return <PdfDocumentView key={path} path={path} bytes={bytes} />;
}

function PdfDocumentView({ path, bytes }: PdfViewProps) {
  const [doc, setDoc] = useState<OpenDocument | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  /** null: fit-width, following the pane as it resizes. A number: the reader's own zoom. */
  const [manualScale, setManualScale] = useState<number | null>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  const [near, setNear] = useState<ReadonlySet<number>>(() => new Set());
  // State rather than a ref: the observers below need to (re)attach when
  // the scroller appears, and it only exists while there is no failure.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  /** Where the middle of the viewport sits, as a fraction of the document's height. */
  const centreRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | undefined;
    setDoc(null);
    setFailure(null);
    setManualScale(null);
    setNear(new Set());

    void (async () => {
      try {
        const pdfjs = await loadPdfjs();
        if (cancelled) return;
        task = openDocument(pdfjs, bytes);
        const pdf = await task.promise;
        const pages = await Promise.all(
          Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1)),
        );
        if (cancelled) return;
        setDoc({
          pages,
          sizes: pages.map(page => {
            const { width, height } = page.getViewport({ scale: 1 });
            return { width, height };
          }),
        });
      } catch (e) {
        // Destroying the task below rejects its promise; that is this
        // effect's own cleanup, not something to report.
        if (!cancelled) setFailure(describeFailure(e));
      }
    })();

    return () => {
      cancelled = true;
      // Tears down the document and its worker-side state with it, and
      // rejects anything still waiting on either.
      task?.destroy().catch(() => {});
    };
  }, [bytes]);

  // The pane's width, for fit-width. clientWidth rather than the observer's
  // own numbers: it is the width inside the scrollbar, which is what a page
  // actually has to fit into.
  useLayoutEffect(() => {
    if (!scroller) return;
    const measure = () => setPaneWidth(scroller.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scroller]);

  useEffect(() => {
    if (!scroller || !doc) return;
    const observer = new IntersectionObserver(entries => {
      setNear(current => {
        const next = new Set(current);
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset.pageIndex);
          if (entry.isIntersecting) next.add(index);
          else next.delete(index);
        }
        return next;
      });
    }, { root: scroller, rootMargin: NEAR_MARGIN });
    for (const placeholder of scroller.querySelectorAll('[data-page-index]')) observer.observe(placeholder);
    return () => observer.disconnect();
  }, [scroller, doc]);

  // The first page decides fit-width, as it does in most viewers: a document
  // with the odd landscape page keeps its portrait pages readable, and the
  // wide one scrolls sideways instead of shrinking everything else.
  const firstWidth = doc?.sizes[0]?.width ?? 0;
  const scale = manualScale ?? fitWidthScale(paneWidth - 2 * PANE_PADDING, firstWidth);

  // Keep the same part of the document in view across a zoom. Left alone,
  // scrollTop stays put in pixels while everything above it grows or
  // shrinks, and a zoom on page 40 lands the reader somewhere around page 80.
  useLayoutEffect(() => {
    if (!scroller || scroller.scrollHeight === 0) return;
    scroller.scrollTop = centreRef.current * scroller.scrollHeight - scroller.clientHeight / 2;
  }, [scroller, scale]);

  const onScroll = () => {
    if (!scroller || scroller.scrollHeight === 0) return;
    centreRef.current = (scroller.scrollTop + scroller.clientHeight / 2) / scroller.scrollHeight;
  };

  const count = doc?.pages.length ?? 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, width: '100%', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Text weight="semibold">{path}</Text>
        <div style={{ flex: 1 }} />
        {doc && (
          <>
            <Text>{count === 1 ? '1 page' : `${count} pages`}</Text>
            <Button
              appearance="subtle"
              icon={<ZoomOut20Regular />}
              aria-label="Zoom out"
              disabled={scale <= MIN_SCALE}
              onClick={() => setManualScale(zoomOut(scale))}
            />
            <Text style={{ minWidth: 44, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
              {formatScale(scale)}
            </Text>
            <Button
              appearance="subtle"
              icon={<ZoomIn20Regular />}
              aria-label="Zoom in"
              disabled={scale >= MAX_SCALE}
              onClick={() => setManualScale(zoomIn(scale))}
            />
            <ToggleButton
              checked={manualScale === null}
              icon={<AutoFitWidth20Regular />}
              onClick={() => setManualScale(null)}
            >
              Fit width
            </ToggleButton>
          </>
        )}
      </div>

      {failure ? (
        <MessageBar intent={failure.kind === 'password' ? 'warning' : 'error'}>
          <MessageBarBody>
            {failure.kind === 'password'
              ? 'This PDF is password-protected.'
              : `Could not render this PDF: ${failure.message}`}
          </MessageBarBody>
        </MessageBar>
      ) : (
        <div
          ref={setScroller}
          data-testid="pdf-scroll"
          // Focusable, so the keyboard can scroll it without a click first.
          tabIndex={0}
          onScroll={onScroll}
          style={{
            flex: 1,
            minHeight: 0,
            overflowX: 'auto',
            // Always a scrollbar, where the platform draws one that takes
            // space: fit-width measures the width inside it, and a scrollbar
            // that came and went with the page height would change that width
            // and so the page height — and could flip back and forth forever.
            overflowY: 'scroll',
            padding: PANE_PADDING,
          }}
        >
          {doc ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: PAGE_GAP }}>
              {doc.pages.map((page, index) => (
                <PdfPage
                  key={index}
                  page={page}
                  index={index}
                  count={count}
                  width={doc.sizes[index].width}
                  height={doc.sizes[index].height}
                  scale={scale}
                  near={near.has(index)}
                />
              ))}
            </div>
          ) : (
            <Spinner size="tiny" label="Opening…" />
          )}
        </div>
      )}
    </div>
  );
}
