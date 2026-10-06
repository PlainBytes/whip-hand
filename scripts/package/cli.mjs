#!/usr/bin/env node
/**
 * Builds dist/whiphand — the standalone `whiphand` CLI, a native Rust binary
 * (crates/whiphand-cli, docs/migration.md Phase 2). It needs no SEA, no
 * embedded process guard (the Windows Job Object is held in-process) and no
 * template assets (they are compiled in).
 */
import fs from 'node:fs';
import path from 'node:path';
import { runSync } from '../lib/exec.mjs';
import { distDir, repoRoot, runSignCommand } from './common.mjs';
import { smokeCli } from './smoke.mjs';

const exe = process.platform === 'win32' ? '.exe' : '';

process.stdout.write('packaging whiphand\n');
runSync(['cargo', 'build', '--release', '-p', 'whiphand-cli'], { cwd: repoRoot, stdio: 'inherit', check: true });

fs.mkdirSync(distDir, { recursive: true });
const binary = path.join(distDir, `whiphand${exe}`);
fs.copyFileSync(path.join(repoRoot, 'target/release', `whiphand${exe}`), binary);
fs.chmodSync(binary, 0o755);
process.stdout.write(`  ${path.relative(repoRoot, binary)} (${(fs.statSync(binary).size / 1024 / 1024).toFixed(1)} MB)\n`);
runSignCommand(binary);

process.stdout.write('\n');
smokeCli();
process.stdout.write(`\n  ${binary}\n`);
