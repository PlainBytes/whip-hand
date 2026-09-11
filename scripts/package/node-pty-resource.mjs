#!/usr/bin/env node
/**
 * Assembles a trimmed node-pty tree under
 * apps/desktop/src-tauri/resources/node-pty/: `package.json`, `lib/` (minus
 * `*.test.js` and `*.map`), and only the native addon for the host platform.
 *
 * Shipped as a Tauri bundle resource so the sidecar's node-pty (see
 * packages/agent/src/native.ts) resolves a real, on-disk package via
 * `resourceDir()` at runtime — an installed machine has no repo and no
 * `node_modules` to fall back to.
 *
 * node-pty's `lib/utils.js` probes `build/Release`, then `build/Debug`, then
 * `prebuilds/<platform>-<arch>` for its addon, so shipping only the one that
 * matches the host is enough; on Windows that directory also carries
 * `conpty.dll` and `OpenConsole.exe`, resolved by the addon relative to
 * itself, so it is copied whole rather than picking out `pty.node` alone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './sea.mjs';

const sourceDir = path.join(repoRoot, 'node_modules/node-pty');
export const bundleResourceDir = path.join(repoRoot, 'apps/desktop/src-tauri/resources/node-pty');

function copyDir(src, dest, skip = () => false) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to, skip);
    else fs.copyFileSync(from, to);
  }
}

function nativeSource(platform) {
  return platform === 'win32'
    ? path.join(sourceDir, 'prebuilds/win32-x64')
    : path.join(sourceDir, 'build/Release');
}

/**
 * `targetDir` defaults to the bundle's own resource directory — what
 * `npm run package` is here to fill. Callers that only need the *layout* and
 * then open a real pty against it (smoke.mjs, native.test.ts) must pass a
 * throwaway directory instead: on Windows the pty's ConPTY helpers keep
 * `conpty.dll` and `OpenConsole.exe` open after the caller is done with them,
 * and the next assembly's `rmSync` of a shared directory fails with EPERM.
 */
export function assembleNodePtyResource(platform = process.platform, targetDir = bundleResourceDir) {
  const nativeDir = nativeSource(platform);
  if (!fs.existsSync(nativeDir)) {
    throw new Error(`node-pty native addon not found at ${nativeDir} — run npm install`);
  }

  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(path.join(sourceDir, 'package.json'), path.join(targetDir, 'package.json'));
  copyDir(path.join(sourceDir, 'lib'), path.join(targetDir, 'lib'), name => name.endsWith('.test.js') || name.endsWith('.map'));
  copyDir(nativeDir, path.join(targetDir, path.relative(sourceDir, nativeDir)));

  return targetDir;
}

if (import.meta.filename === process.argv[1]) {
  const dir = assembleNodePtyResource();
  process.stdout.write(`node-pty resource assembled at ${path.relative(repoRoot, dir)}\n`);
}
