#!/usr/bin/env node
/**
 * Builds the desktop `.deb` and swaps it in for whatever is installed on this
 * Ubuntu machine: compile, remove, install.
 *
 * This exists because testing a change against a *really installed* build
 * otherwise means knowing the artifact's exact filename, which encodes
 * productName, version and arch (`Whiphand_0.1.0_amd64.deb`) and so moves under
 * you. `buildDesktopBundles()` already returns the paths it wrote, so this
 * script installs the artifact it just built rather than globbing dist/ and
 * hoping.
 *
 * The remove step is load-bearing, not just tidiness: the version is pinned at
 * 0.1.0 across builds (scripts/version.mjs), so `apt-get install` over an
 * already-installed 0.1.0 is a no-op and the freshly built bundle would
 * silently not land.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildDesktopBundles } from './desktop.mjs';

// The `.deb`, dpkg and apt are all Ubuntu/Debian — on Windows this script's
// build step produces an NSIS installer it could do nothing with, and on macOS
// there is no bundle at all. Fail here rather than after a ten-minute build.
if (process.platform !== 'linux') {
  throw new Error(`reinstall is Linux-only (apt/.deb); this is ${process.platform}`);
}

// apt refuses to touch the dpkg database as a normal user. Escalate only when
// we are not already root, so this stays usable inside a root container.
const sudo = process.getuid() === 0 ? [] : ['sudo'];

/** Runs a command through to the terminal — `sudo`'s password prompt included. */
function run(argv) {
  const [command, ...args] = argv;
  execFileSync(command, args, { stdio: 'inherit' });
}

/**
 * Runs a command for its output, trimmed. execFileSync forwards the child's
 * stderr to ours by default, which is what you want everywhere except the
 * probe below, where a non-zero exit is an expected answer rather than a
 * fault — hence `quiet`.
 */
function capture(argv, { quiet = false } = {}) {
  const [command, ...args] = argv;
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'inherit'],
  }).trim();
}

/**
 * dpkg-query exits non-zero for a package it has never heard of, and prints a
 * status of `deinstall ok config-files` for one that was removed but left its
 * config behind — neither is installed, and only ` installed` distinguishes the
 * case where there is something to remove.
 */
function isInstalled(name) {
  try {
    return capture(['dpkg-query', '-W', '-f=${Status}', name], { quiet: true }).endsWith(' installed');
  } catch {
    return false;
  }
}

const artifacts = await buildDesktopBundles();
process.stdout.write('\n');
for (const artifact of artifacts) process.stdout.write(`  ${artifact}\n`);

const deb = artifacts.find(artifact => artifact.endsWith('.deb'));
if (!deb) throw new Error(`the desktop build produced no .deb: ${artifacts.join(', ')}`);

// Read the dpkg name out of the artifact instead of hardcoding `whiphand`. It
// comes from `[package] name` in src-tauri/Cargo.toml, lowercased, and is *not*
// the filename — so a future rename removes the package that is actually
// installed rather than orphaning it.
const packageName = capture(['dpkg-deb', '-f', deb, 'Package']);

process.stdout.write(`\nreinstalling ${packageName} from ${path.basename(deb)}\n\n`);

if (isInstalled(packageName)) {
  run([...sudo, 'apt-get', 'remove', '-y', packageName]);
} else {
  process.stdout.write(`  ${packageName} is not installed, nothing to remove\n`);
}

// apt-get rather than dpkg -i, because the bundle declares runtime
// dependencies (libwebkit2gtk-4.1-0, libgtk-3-0) that dpkg will not resolve.
// The path must be absolute — apt only treats an argument as a local file when
// it contains a slash, otherwise it looks the name up in the repos and fails.
process.stdout.write('\n');
run([...sudo, 'apt-get', 'install', '-y', path.resolve(deb)]);

process.stdout.write(`\n  installed  ${capture(['dpkg-query', '-W', '-f=${Package} ${Version}', packageName])}\n`);
