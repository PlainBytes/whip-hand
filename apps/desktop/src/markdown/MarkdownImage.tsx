/**
 * A relative image in a markdown document, read through the consumer's
 * FileSystemPort.
 *
 * An object URL rather than a base64 data: URI — no copy of the bytes as a
 * string, and it is revoked the moment the image goes away. The MIME type
 * matters: an <img> content-sniffs raster formats but refuses to render an
 * SVG that isn't typed image/svg+xml, which is the same trap FilePreview hit.
 */
import { useEffect, useState } from 'react';
import { mimeTypeForPath } from '../files/file-kind.ts';
import type { DocResolution } from './types.ts';

/**
 * The one size cap for an inline image, shared with whoever implements
 * `loadImage` so the two can't drift apart.
 *
 * The real gate lives on the read side (FilePreview's loadImage stats before
 * it reads, and rejects), because the `loadImage(path) => Promise<Uint8Array>`
 * contract gives this component nothing to check until the bytes have already
 * crossed the IPC boundary. The check below is the backstop for a loader that
 * doesn't gate: it still keeps an oversized Blob from being constructed and
 * decoded, which is the expensive part on this side.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

interface MarkdownImageProps {
  src: string;
  alt: string;
  resolve?: (target: string) => DocResolution | null;
  loadImage?: (path: string) => Promise<Uint8Array>;
}

export function MarkdownImage({ src, alt, resolve, loadImage }: MarkdownImageProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const target = resolve?.(src) ?? null;
  const path = target?.path ?? null;

  useEffect(() => {
    if (!path || !loadImage) {
      setFailed(true);
      return;
    }
    let cancelled = false;
    let objectUrl: string | undefined;
    setFailed(false);
    // Otherwise a path change (e.g. re-render onto a different image) leaves
    // the previous, now-revoked object URL in place until the new one
    // resolves — the <img> would point at dead memory instead of showing
    // the loading placeholder.
    setUrl(null);

    void (async () => {
      try {
        const bytes = await loadImage(path);
        if (cancelled) return;
        if (bytes.byteLength > MAX_IMAGE_BYTES) {
          setFailed(true);
          return;
        }
        objectUrl = URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], { type: mimeTypeForPath(path) }),
        );
        setUrl(objectUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, loadImage]);

  if (failed) return <span className="whiphand-markdown-image-missing">Could not load {alt || src}</span>;
  if (!url) return <span className="whiphand-markdown-image-missing">Loading {alt || src}…</span>;
  // onError catches everything the read path cannot see: bytes that arrived
  // but do not decode (a file that is not the image its extension claims),
  // or a format this webview will not render. Without it the browser's own
  // broken-image glyph shows instead of the placeholder every other failure
  // here already renders.
  return <img src={url} alt={alt} onError={() => setFailed(true)} />;
}
