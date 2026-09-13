/**
 * Where the built web SPA lives on disk, resolved the same way native.ts
 * resolves node-pty: the packaged agent is an esbuild CJS bundle where
 * `import.meta.url` is not real, so a path relative to this file only works
 * unbundled. Returns null when nothing resolves to a real directory.
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

declare const WHIPHAND_WEB_ROOT_DEFAULT: string | undefined;

const buildTimeDefault = typeof WHIPHAND_WEB_ROOT_DEFAULT === 'undefined' ? undefined : WHIPHAND_WEB_ROOT_DEFAULT;

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Contains index.html, so an empty or half-copied resource tree does not count. */
function isUsableWebRoot(path: string): boolean {
  return isDirectory(path) && existsSync(resolve(path, 'index.html'));
}

export function resolveWebRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates: string[] = [];
  if (env.WHIPHAND_WEB_ROOT) candidates.push(env.WHIPHAND_WEB_ROOT);
  if (buildTimeDefault) candidates.push(buildTimeDefault);
  // Unbundled only: packages/agent/src/remote -> apps/desktop/dist-web.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(resolve(here, '..', '..', '..', '..', 'apps', 'desktop', 'dist-web'));
  } catch {
    // import.meta.url is not real in the CJS bundle; the env var covers that case.
  }
  for (const candidate of candidates) {
    if (isUsableWebRoot(candidate)) return resolve(candidate);
  }
  return null;
}
