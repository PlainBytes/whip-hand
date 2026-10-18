#!/usr/bin/env node
/**
 * Puts the `whiphand` CLI where the desktop bundle picks it up as a sidecar
 * (`bundle.externalBin` in tauri.conf.json), so installing the desktop app
 * also installs `whiphand`: /usr/bin/whiphand beside /usr/bin/whiphand-desktop
 * from the .deb, whiphand.exe beside whiphand-desktop.exe on Windows.
 *
 * Tauri looks for `binaries/whiphand-<target triple>` and the triple is the
 * one the app is built for (the host's, gnu on Linux), while the binary put
 * there is the shipped CLI, which on Linux is the static musl one: it runs
 * wherever the app does.
 *
 * tauri-build refuses to compile the app, `tauri dev` included, without the
 * file, so the desktop's `pretauri` script runs this too. The release build is
 * incremental: after the first, it costs a cargo no-op.
 */
import fs from 'node:fs';
import path from 'node:path';
import { runSync } from '../lib/exec.mjs';
import { repoRoot, runSignCommand } from './common.mjs';
import { buildCli, cliTarget } from './cli.mjs';

/** The triple `rustc` builds for here, which is what tauri-build names the sidecar after. */
function hostTriple() {
  const { stdout } = runSync(['rustc', '-vV'], { stdio: ['ignore', 'pipe', 'inherit'], check: true });
  const host = stdout.match(/^host: (\S+)$/m);
  if (!host) throw new Error(`no host triple in rustc -vV:\n${stdout}`);
  return host[1];
}

/** @returns {string} the sidecar's path under apps/desktop/src-tauri/binaries/ */
export function prepareSidecar() {
  const built = buildCli(cliTarget());
  const exe = process.platform === 'win32' ? '.exe' : '';
  const sidecar = path.join(repoRoot, 'apps/desktop/src-tauri/binaries', `whiphand-${hostTriple()}${exe}`);
  fs.mkdirSync(path.dirname(sidecar), { recursive: true });
  fs.copyFileSync(built, sidecar);
  fs.chmodSync(sidecar, 0o755);
  runSignCommand(sidecar);
  return sidecar;
}

if (import.meta.filename === process.argv[1]) {
  process.stdout.write(`  sidecar   ${path.relative(repoRoot, prepareSidecar())}\n`);
}
