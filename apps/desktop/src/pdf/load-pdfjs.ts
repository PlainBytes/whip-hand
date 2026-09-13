/**
 * The one module that imports pdf.js — and the seam PdfView's tests mock.
 * Lazy, like mermaid in markdown/Mermaid.tsx: nothing is fetched until a PDF
 * is actually opened.
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
