/**
 * The one module that imports pdf.js — and the seam PdfView's tests mock.
 *
 * Lazy, like mermaid in markdown/Mermaid.tsx: pdf.js is a large dependency
 * and most files opened are not PDFs, so nothing is fetched until one is.
 *
 * The worker ships as its own asset and is referenced by URL rather than
 * bundled into the chunk: pdf.js parses the document on that worker, off the
 * UI thread. The `?url` import costs nothing up front — it is a string.
 *
 * If WebKitGTK ever turns out to reject this modern build, the fallback is
 * pdfjs-dist/legacy/build/ for both specifiers below; nothing else changes.
 *
 * Known limits, all for want of assets this app does not (yet) ship — each
 * is a `*Url` option on getDocument pointing at a directory copied from
 * pdfjs-dist:
 * - no `cMapUrl` / `standardFontDataUrl`: a PDF that relies on predefined
 *   CMaps or on the 14 standard fonts without embedding them (common in CJK
 *   documents) may show missing or substituted glyphs;
 * - no `wasmUrl`: JPEG 2000 and JBIG2 images — typical of scanned documents
 *   — are not decoded and leave blank areas, and ICC colour profiles fall
 *   back to plain RGB/CMYK conversion.
 * pdf.js logs a warning to the console in each case rather than failing.
 */
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

export type PdfJs = typeof import('pdfjs-dist');

let loading: Promise<PdfJs> | null = null;

export function loadPdfjs(): Promise<PdfJs> {
  if (!loading) {
    const attempt = import('pdfjs-dist').then(pdfjs => {
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    });
    // A chunk that failed to load (the dev server restarting, a dropped
    // connection on the remote web UI) must not poison every later PDF for
    // the rest of the session — forget it, so the next open tries again.
    attempt.catch(() => {
      if (loading === attempt) loading = null;
    });
    loading = attempt;
  }
  return loading;
}
