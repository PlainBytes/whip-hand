#!/usr/bin/env node
/**
 * Wraps dist/whiphand (cli.mjs, the static Linux build) in a .deb of its own,
 * `whiphand-cli`, for a machine that wants the CLI and the TUI without the
 * desktop app: dist/whiphand-cli_<version>_amd64.deb.
 *
 * The binary is static, so the package depends on nothing. Both packages
 * install /usr/bin/whiphand (the desktop ships the CLI as a sidecar), so each
 * conflicts with and replaces the other: installing one swaps out the other
 * instead of failing on the shared file. The desktop's half is
 * bundle.linux.deb in tauri.conf.json.
 *
 * Built with dpkg-deb from a staged tree; no cargo-deb, no other tool.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSync } from '../lib/exec.mjs';
import { distDir, repoRoot } from './common.mjs';

export const PACKAGE = 'whiphand-cli';

/** The control file. The desktop package is `whiphand`, its name from tauri.conf.json's productName. */
export function controlFile({ version, installedSize }) {
  return [
    `Package: ${PACKAGE}`,
    `Version: ${version}`,
    'Architecture: amd64',
    'Maintainer: PlainBytes',
    `Installed-Size: ${installedSize}`,
    'Conflicts: whiphand',
    'Replaces: whiphand',
    'Section: devel',
    'Priority: optional',
    'Homepage: https://github.com/PlainBytes/whip-hand',
    'Description: workflow runner for LLM CLIs, with a terminal UI',
    ' The whiphand command line and its terminal UI (`whiphand`, or',
    ' `whiphand tui`), without the desktop app.',
    '',
  ].join('\n');
}

/** @returns {string} the path of the .deb it wrote */
export function buildCliDeb({ binary = path.join(distDir, 'whiphand') } = {}) {
  if (!fs.existsSync(binary)) throw new Error(`${binary} is missing; run npm run package:cli first`);
  const version = runSync([binary, '--version'], { stdio: ['ignore', 'pipe', 'inherit'], check: true }).stdout.trim();

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'whiphand-cli-deb-'));
  try {
    const bin = path.join(stage, 'usr/bin/whiphand');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.copyFileSync(binary, bin);
    fs.chmodSync(bin, 0o755);
    fs.mkdirSync(path.join(stage, 'DEBIAN'));
    // mkdtemp makes the root 0700 and the umask decides the rest; dpkg records
    // what it is given, and a package must not claim /usr as anything but 0755.
    for (const dir of ['', 'usr', 'usr/bin', 'DEBIAN']) fs.chmodSync(path.join(stage, dir), 0o755);
    const installedSize = Math.ceil(fs.statSync(bin).size / 1024);
    fs.writeFileSync(path.join(stage, 'DEBIAN/control'), controlFile({ version, installedSize }));

    const deb = path.join(distDir, `${PACKAGE}_${version}_amd64.deb`);
    runSync(['dpkg-deb', '--root-owner-group', '--build', stage, deb], { stdio: ['ignore', 'pipe', 'inherit'], check: true });
    return deb;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (import.meta.filename === process.argv[1]) {
  if (process.platform !== 'linux') throw new Error(`the CLI .deb is built on Linux; this is ${process.platform}`);
  const deb = buildCliDeb();
  process.stdout.write(`  ${path.relative(repoRoot, deb)}\n`);
}
