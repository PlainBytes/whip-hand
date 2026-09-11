/**
 * Decides how a file should be previewed, from its path and its first bytes.
 *
 * Pure and React-free on purpose: this is the logic worth testing, and the
 * Files page's rendering shouldn't have to be mounted to test it.
 */

/**
 * Files above this size are never read at all — the preview reports the size
 * instead. Mirrors MAX_ARTIFACT_BYTES in packages/agent/src/handlers.ts so a
 * file the agent refuses to hand over isn't happily slurped by the webview.
 */
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

/**
 * The cap for a file the preview renders rather than decoding and
 * highlighting it as text: an image, handed to an <img> whole, and a PDF,
 * handed to pdf.js. A screenshot or a spec attached to a run is routinely
 * past MAX_PREVIEW_BYTES, and seeing it is the point of having attached it,
 * so this sits comfortably above the default `runs.max_attachment_mb` (25).
 * The agent's base64 read cap still applies on the artifact port; a file past
 * either reports its size or the agent's refusal like any other oversized file.
 */
export const MAX_RENDERED_PREVIEW_BYTES = 32 * 1024 * 1024;

/** How many leading bytes are sniffed for NULs when classifying a file. */
const SNIFF_BYTES = 8 * 1024;

export type FileKind = 'markdown' | 'image' | 'pdf' | 'text' | 'binary';

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);

const PDF_EXTENSION = 'pdf';

/**
 * The MIME type an <img> needs for each previewable image format. Raster
 * formats are content-sniffed by the decoder and would render from an
 * untyped Blob, but SVG is not: an untyped (or wrongly typed) resource in an
 * <img> is simply not rendered, which showed up as a broken-image icon.
 */
const IMAGE_MIME_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
};

/** Derived, so the two can't drift: every image extension has a MIME type. */
const IMAGE_EXTENSIONS = new Set(Object.keys(IMAGE_MIME_TYPES));

/**
 * highlight.js language ids, deliberately a fixed map rather than
 * hljs.highlightAuto(): auto-detection is slow on large files and guesses
 * badly on short ones (a 3-line YAML file routinely comes back as Perl).
 */
const LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
  rs: 'rust', py: 'python', go: 'go', java: 'java', rb: 'ruby', php: 'php',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  css: 'css', scss: 'scss', html: 'xml', xml: 'xml', svg: 'xml',
  sql: 'sql', diff: 'diff', patch: 'diff', dockerfile: 'dockerfile',
  md: 'markdown', markdown: 'markdown',
};

/** Lowercased extension without the dot; '' when there isn't one (dotfiles included). */
export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return ''; // -1: no dot; 0: a dotfile like .gitignore
  return name.slice(dot + 1).toLowerCase();
}

/**
 * A NUL byte in the first 8KB is the same heuristic `grep` and `git` use: no
 * valid UTF-8 text contains one, and every common binary format has one early.
 */
export function isBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, SNIFF_BYTES);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

export function detectKind(path: string, bytes: Uint8Array): FileKind {
  const ext = extensionOf(path);
  // Images are decided by extension alone — sniffing would classify every PNG
  // as 'binary' and there'd be nothing left to render them with.
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  // Likewise PDFs, whose compressed streams would put nearly every one in
  // 'binary' — and an ASCII-only one in 'text', which is no better.
  if (ext === PDF_EXTENSION) return 'pdf';
  if (isBinary(bytes)) return 'binary';
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
  return 'text';
}

/**
 * Whether a file of this kind is decoded as text — and so is editable, and
 * refreshes in place when a live file changes. Everything else is rendered
 * (image, PDF) or merely reported (binary), and a re-open is what picks up
 * a change to it.
 */
export function isTextKind(kind: FileKind): boolean {
  return kind === 'markdown' || kind === 'text';
}

/** Whether the preview treats this path as an image — by extension alone, as detectKind does. */
export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(path));
}

/** Whether the preview treats this path as a PDF — by extension alone, as detectKind does. */
export function isPdfPath(path: string): boolean {
  return extensionOf(path) === PDF_EXTENSION;
}

/** The size past which the preview refuses to read `path` at all. */
export function previewCapFor(path: string): number {
  return isImagePath(path) || isPdfPath(path) ? MAX_RENDERED_PREVIEW_BYTES : MAX_PREVIEW_BYTES;
}

/**
 * MIME type for a previewable image, or '' when the type isn't known — which
 * is what `new Blob([...], { type })` wants for "unspecified" anyway.
 */
export function mimeTypeForPath(path: string): string {
  return IMAGE_MIME_TYPES[extensionOf(path)] ?? '';
}

/**
 * The extension to give bytes that arrived with only a MIME type — a pasted
 * clipboard image. The inverse of IMAGE_MIME_TYPES (its first extension per
 * type, so image/jpeg is `jpg`), so whatever gets named here previews as an
 * image again. An image type this app doesn't know keeps its own subtype
 * (`image/tiff` -> `tiff`) rather than being mislabelled as something it isn't.
 */
export function extensionForImageMime(mime: string): string {
  const type = mime.toLowerCase().split(';')[0].trim();
  const known = Object.entries(IMAGE_MIME_TYPES).find(([, m]) => m === type);
  if (known) return known[0];
  const subtype = type.startsWith('image/') ? type.slice('image/'.length).replace(/[^a-z0-9]/g, '') : '';
  return subtype === '' ? 'png' : subtype;
}

export function languageForPath(path: string): string {
  return LANGUAGES[extensionOf(path)] ?? 'plaintext';
}
