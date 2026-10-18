#!/usr/bin/env node
/**
 * Builds dist/whiphand — the standalone `whiphand` CLI, a native Rust binary
 * (crates/whiphand-cli, docs/migration.md Phase 2). It needs no SEA, no
 * embedded process guard (the Windows Job Object is held in-process) and no
 * template assets (they are compiled in).
 *
 * On Linux it is built for musl, so it is one static file that runs on any
 * distribution, an old SSH server's included, not just on the glibc of the
 * machine that built it. `--host` builds for this machine's own target
 * instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { runSync } from '../lib/exec.mjs';
import { distDir, repoRoot, runSignCommand } from './common.mjs';
import { smokeCli } from './smoke.mjs';

const exe = process.platform === 'win32' ? '.exe' : '';

/** The Rust target the shipped CLI is built for, or null for the host's own. */
export function cliTarget({ host = false } = {}) {
  return process.platform === 'linux' && !host ? 'x86_64-unknown-linux-musl' : null;
}

/**
 * `cargo build --release -p whiphand-cli` for `target`; returns the path of
 * the binary it wrote under target/.
 */
export function buildCli(target) {
  const argv = ['cargo', 'build', '--release', '-p', 'whiphand-cli'];
  if (target) argv.push('--target', target);
  runSync(argv, { cwd: repoRoot, stdio: 'inherit', check: true });
  return path.join(repoRoot, 'target', ...(target ? [target] : []), 'release', `whiphand${exe}`);
}

if (import.meta.filename === process.argv[1]) {
  process.stdout.write('packaging whiphand\n');
  const built = buildCli(cliTarget({ host: process.argv.includes('--host') }));

  fs.mkdirSync(distDir, { recursive: true });
  const binary = path.join(distDir, `whiphand${exe}`);
  fs.copyFileSync(built, binary);
  fs.chmodSync(binary, 0o755);
  process.stdout.write(`  ${path.relative(repoRoot, binary)} (${(fs.statSync(binary).size / 1024 / 1024).toFixed(1)} MB)\n`);
  runSignCommand(binary);

  process.stdout.write('\n');
  smokeCli({ static: !process.argv.includes('--host') });
  process.stdout.write(`\n  ${binary}\n`);
}
