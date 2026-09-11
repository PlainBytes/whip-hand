/**
 * Where the built web SPA lives on disk, resolved the same way native.ts
 * resolves node-pty and for the same reason: the packaged agent is an esbuild
 * CJS bundle inside a single-file executable, so `import.meta.url` is not real
 * there and a path relative to this source file only works unbundled.
 *
 * The cascade, in order:
 *   1. WHIPHAND_WEB_ROOT — what tauri-transport.ts passes when it spawns us. In a
 *      packaged bundle that is <resourceDir>/resources/web; under `tauri dev`
 *      it is the repo's apps/desktop/dist-web.
 *   2. WHIPHAND_WEB_ROOT_DEFAULT — an esbuild define, for a standalone agent binary.
 *   3. A path relative to this module, for `node --test` and a plain dev run.
 *
 * Returns null when nothing resolves to a real directory. Callers must answer
 * 503 with an actionable message rather than throwing: "the remote UI has not
 * been built" is a routine state during development, and discovering it as a
 * blank page on another machine is the failure mode this avoids.
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
