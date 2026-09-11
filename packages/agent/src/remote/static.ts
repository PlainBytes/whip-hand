/**
 * Serving the built SPA off disk.
 *
 * The SHELL IS PUBLIC ON THE LAN; THE RPC CHANNEL IS NOT. Nothing served here
 * requires a token, and that is deliberate: these files are inert HTML/JS/CSS
 * with no user data in them, and gating them would mean the QR link could not
 * even render the screen that asks for a token. Every byte that is actually
 * worth protecting goes over the authenticated WebSocket.
 *
 * The one thing this file must get right is containment. `safeResolve` is pure
 * so the traversal cases can be enumerated in a table rather than discovered.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Maps a request path to an absolute path inside `root`, or null if it escapes.
 *
 * Decoding happens BEFORE the traversal check, which is the whole point: a
 * check against the raw path would pass '%2e%2e%2f' straight through. A
 * malformed escape throws in decodeURIComponent and is rejected rather than
 * passed along raw.
 */
export function safeResolve(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]!.split('#')[0]!);
  } catch {
    return null;
  }
  // A NUL truncates the path in some syscalls; never let one through.
  if (decoded.includes('\0')) return null;
  // Backslash is a separator on Windows, so '..\..\x' is traversal there and
  // merely a weird filename here. Rejecting it everywhere keeps the check
  // platform-independent rather than correct on only one platform.
  if (decoded.includes('\\')) return null;
  if (!decoded.startsWith('/')) return null;

  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, `.${decoded}`);
  const rel = relative(absoluteRoot, candidate);
  // '' means the root itself; anything starting with '..' escaped it, and an
  // absolute result means relative() gave up — a different Windows drive.
  if (rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) return null;
  return candidate;
}

export interface StaticHit {
  path: string;
  contentType: string;
  /** True when we fell back to index.html for a client-side route. */
  isShell: boolean;
}

async function isFile(path: string): Promise<boolean> {
  const stats = await stat(path).catch(() => null);
  return stats?.isFile() ?? false;
}

/**
 * Resolves a request to a file, falling back to index.html for client-side
 * routes. The fallback is skipped for anything that looks like an asset
 * request, so a missing bundle chunk 404s instead of returning HTML that the
 * browser would try to execute as JavaScript.
 */
export async function resolveStatic(root: string, urlPath: string): Promise<StaticHit | null> {
  const target = safeResolve(root, urlPath);
  if (target === null) return null;

  const shell = join(resolve(root), 'index.html');
  const direct = urlPath === '/' || urlPath === '' ? shell : target;
  if (await isFile(direct)) {
    return { path: direct, contentType: contentTypeFor(direct), isShell: direct === shell };
  }
  if (extname(direct) !== '') return null;
  if (await isFile(shell)) {
    return { path: shell, contentType: contentTypeFor(shell), isShell: true };
  }
  return null;
}

/** Streams a resolved hit, with the headers a LAN-served shell should carry. */
export function sendStatic(res: ServerResponse, hit: StaticHit): void {
  res.writeHead(200, {
    'Content-Type': hit.contentType,
    'X-Content-Type-Options': 'nosniff',
    // Hashed asset filenames make long caching safe; the shell must never be
    // cached, or a rotated token screen would be served from disk.
    'Cache-Control': hit.isShell ? 'no-store' : 'public, max-age=31536000, immutable',
  });
  createReadStream(hit.path).pipe(res);
}
