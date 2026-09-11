import { describe, expect, it } from 'vitest';
import {
  detectKind, extensionForImageMime, extensionOf, isBinary, isPdfPath, isTextKind, languageForPath, mimeTypeForPath,
  MAX_PREVIEW_BYTES, MAX_RENDERED_PREVIEW_BYTES, previewCapFor,
} from './file-kind.ts';

const text = (s: string) => new TextEncoder().encode(s);

describe('extensionOf', () => {
  it('lowercases the extension and ignores directories in the path', () => {
    expect(extensionOf('/ws/docs/README.MD')).toBe('md');
    expect(extensionOf('/ws/no-extension')).toBe('');
    expect(extensionOf('/ws/.gitignore')).toBe('');
  });
});

describe('isBinary', () => {
  it('is true when a NUL byte appears in the first 8KB', () => {
    expect(isBinary(new Uint8Array([0x68, 0x00, 0x69]))).toBe(true);
  });

  it('is false for plain UTF-8 text, including multibyte characters', () => {
    expect(isBinary(text('hello — árvíztűrő'))).toBe(false);
  });

  it('ignores a NUL that appears only after the first 8KB', () => {
    const bytes = new Uint8Array(9000);
    bytes.fill(0x61);
    bytes[8500] = 0x00;
    expect(isBinary(bytes)).toBe(false);
  });
});

describe('detectKind', () => {
  it('treats .md and .markdown as markdown', () => {
    expect(detectKind('/ws/a.md', text('# hi'))).toBe('markdown');
    expect(detectKind('/ws/a.markdown', text('# hi'))).toBe('markdown');
  });

  it('treats known image extensions as images without sniffing their bytes', () => {
    expect(detectKind('/ws/a.png', new Uint8Array([0x89, 0x50, 0x00, 0x00]))).toBe('image');
    expect(detectKind('/ws/a.svg', text('<svg />'))).toBe('image');
  });

  it('treats .pdf as a PDF by extension alone, case-insensitively, however binary its bytes', () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0x00, 0x01]);
    expect(detectKind('/ws/report.pdf', pdfBytes)).toBe('pdf');
    expect(detectKind('/ws/REPORT.PDF', pdfBytes)).toBe('pdf');
  });

  it('treats NUL-containing non-image files as binary', () => {
    expect(detectKind('/ws/a.bin', new Uint8Array([0x01, 0x00, 0x02]))).toBe('binary');
  });

  it('treats everything else decodable as text', () => {
    expect(detectKind('/ws/workflow.yaml', text('name: x'))).toBe('text');
    expect(detectKind('/ws/LICENSE', text('MIT'))).toBe('text');
  });
});

describe('isTextKind', () => {
  it('is true only for the kinds the preview decodes, edits and refreshes as text', () => {
    expect(isTextKind('markdown')).toBe(true);
    expect(isTextKind('text')).toBe(true);
    expect(isTextKind('image')).toBe(false);
    expect(isTextKind('pdf')).toBe(false);
    expect(isTextKind('binary')).toBe(false);
  });
});

describe('languageForPath', () => {
  it('maps known extensions to highlight.js language ids', () => {
    expect(languageForPath('/ws/a.ts')).toBe('typescript');
    expect(languageForPath('/ws/a.yaml')).toBe('yaml');
    expect(languageForPath('/ws/a.yml')).toBe('yaml');
    expect(languageForPath('/ws/a.rs')).toBe('rust');
  });

  it('falls back to plaintext for unknown extensions', () => {
    expect(languageForPath('/ws/LICENSE')).toBe('plaintext');
  });
});

describe('mimeTypeForPath', () => {
  it('types every image kind the preview claims to render', () => {
    expect(mimeTypeForPath('/ws/a.png')).toBe('image/png');
    expect(mimeTypeForPath('/ws/a.jpg')).toBe('image/jpeg');
    expect(mimeTypeForPath('/ws/a.jpeg')).toBe('image/jpeg');
    expect(mimeTypeForPath('/ws/a.gif')).toBe('image/gif');
    expect(mimeTypeForPath('/ws/a.webp')).toBe('image/webp');
    expect(mimeTypeForPath('/ws/a.bmp')).toBe('image/bmp');
    expect(mimeTypeForPath('/ws/a.ico')).toBe('image/x-icon');
  });

  it('types SVG, which an <img> will not render without it', () => {
    expect(mimeTypeForPath('/ws/logo.SVG')).toBe('image/svg+xml');
  });

  it('leaves non-images untyped', () => {
    expect(mimeTypeForPath('/ws/a.md')).toBe('');
    expect(mimeTypeForPath('/ws/LICENSE')).toBe('');
  });
});

describe('extensionForImageMime', () => {
  it('names a pasted image so it previews as an image again', () => {
    expect(extensionForImageMime('image/png')).toBe('png');
    expect(extensionForImageMime('image/jpeg')).toBe('jpg');
    expect(extensionForImageMime('image/svg+xml')).toBe('svg');
    expect(mimeTypeForPath(`/ws/pasted-1.${extensionForImageMime('image/webp')}`)).toBe('image/webp');
  });

  it('keeps the subtype of an image type it does not know, rather than calling it a png', () => {
    expect(extensionForImageMime('image/tiff')).toBe('tiff');
  });
});

describe('MAX_PREVIEW_BYTES', () => {
  it('matches the 2MB cap the agent applies to artifacts', () => {
    expect(MAX_PREVIEW_BYTES).toBe(2 * 1024 * 1024);
  });

  it('is the cap for text; an image or a PDF may be as large as a default-capped attachment', () => {
    expect(previewCapFor('/ws/server.log')).toBe(MAX_PREVIEW_BYTES);
    expect(previewCapFor('/ws/attachments/bug.PNG')).toBe(MAX_RENDERED_PREVIEW_BYTES);
    expect(previewCapFor('/ws/attachments/spec.pdf')).toBe(MAX_RENDERED_PREVIEW_BYTES);
    expect(MAX_RENDERED_PREVIEW_BYTES).toBeGreaterThanOrEqual(25 * 1024 * 1024);
  });
});

describe('isPdfPath', () => {
  it('goes by extension alone, as detectKind does', () => {
    expect(isPdfPath('/ws/a.pdf')).toBe(true);
    expect(isPdfPath('/ws/a.Pdf')).toBe(true);
    expect(isPdfPath('/ws/a.pdf.txt')).toBe(false);
    expect(isPdfPath('/ws/pdf')).toBe(false);
  });
});
