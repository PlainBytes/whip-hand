#!/usr/bin/env node
/**
 * Builds the browser SPA into apps/desktop/src-tauri/resources/web/, so a
 * packaged app can serve it to another machine on the network.
 *
 * Same shape as node-pty-resource.mjs, and shipped the same way: a Tauri
 * bundle resource the sidecar reads off disk at runtime via a path handed to
 * it in WHIPHAND_WEB_ROOT (see packages/agent/src/remote/web-root.ts). The agent is
 * a plain Node process with no Tauri APIs, so a directory path is the only
 * hand-off available — exactly as with WHIPHAND_NODE_PTY_DIR.
 *
 * Called from prepareDesktopBuild() rather than from the top-level
 * package:desktop script, and that placement is load-bearing: release.yml
 * hands the actual `tauri build` to tauri-action and calls prepareDesktopBuild
 * on its own, so anything outside that function would silently not ship in a
 * release. It is also NOT part of apps/desktop's `build` script, which is
 * tauri.conf.json's beforeBuildCommand and doubles as the local typecheck —
 * building the web bundle there would cost every local build for an artifact
 * only the packaged app needs.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './sea.mjs';

const appDir = path.join(repoRoot, 'apps/desktop');
const targetDir = path.join(appDir, 'src-tauri/resources/web');

export function buildWebResource() {
  fs.rmSync(targetDir, { recursive: true, force: true });

  // `--outDir` straight into the resource tree: no intermediate copy to keep
  // in sync, and `dist-web/` stays purely a developer convenience.
  execFileSync(
    'npm',
    ['run', 'build:web', '-w', 'desktop', '--', '--outDir', targetDir, '--emptyOutDir'],
    { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' },
  );

  // The static server treats a missing index.html as "never built" and answers
  // 503, which would be discovered on someone's phone rather than here.
  const indexHtml = path.join(targetDir, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    throw new Error(`web bundle built but ${path.relative(repoRoot, indexHtml)} is missing`);
  }
  return targetDir;
}

if (import.meta.filename === process.argv[1]) {
  const dir = buildWebResource();
  process.stdout.write(`web resource assembled at ${path.relative(repoRoot, dir)}\n`);
}
