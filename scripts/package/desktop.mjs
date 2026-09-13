#!/usr/bin/env node
/**
 * Builds the desktop app: a .deb and an .AppImage on Linux, an NSIS
 * installer on Windows.
 *
 * This script does not bundle anything itself — Tauri's own bundler does
 * that. `prepareDesktopBuild()` is the handoff: build the sidecar, put it
 * where `externalBin` expects it under the target triple Tauri will look
 * for, and assemble the node-pty resource tree the sidecar needs at runtime
 * (see node-pty-resource.mjs and packages/agent/src/native.ts). It is
 * exported separately from the `tauri build` invocation below because
 * release.yml needs exactly this half: the release build hands the actual
 * `tauri build` off to tauri-action, which also signs and uploads, so it
 * cannot go through `npm run tauri` itself the way local packaging does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repoRoot, distDir } from './sea.mjs';
import { packageAgent } from './agent.mjs';
import { smokeAgent } from './smoke.mjs';
import { assembleNodePtyResource } from './node-pty-resource.mjs';
import { buildWebResource } from './web-resource.mjs';

/**
 * Tauri appends the host target triple to every externalBin path, so the file
 * has to be named for it. Read from rustc rather than hardcoded, so an arm64
 * machine fails loudly instead of building a bundle with no sidecar in it.
 */
function hostTargetTriple() {
  const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const match = out.match(/^host:\s*(\S+)$/m);
  if (!match) throw new Error('could not read the host target triple from `rustc -vV`');
  return match[1];
}

/**
 * @returns {Promise<{ triple: string, isWindows: boolean, bundleFormats: string[], bundleExtensions: string[] }>}
 */
export async function prepareDesktopBuild() {
  const triple = hostTargetTriple();
  const isWindows = process.platform === 'win32';
  // Tauri's own bundler appends the host target triple to externalBin paths,
  // then — on Windows only — appends `.exe` after *that*. So the file on disk
  // is `whiphand-agent-x86_64-pc-windows-msvc.exe`, not `whiphand-agent-x86_64-...msvc.exe`
  // misread as `whiphand-agent-x86_64-...msvc` plus an extension of its own.
  const sidecarName = `whiphand-agent-${triple}${isWindows ? '.exe' : ''}`;
  // Format list per platform, since Windows can only ever produce nsis and
  // Linux never will — this also becomes the `--bundles` argument, so
  // tauri.conf.json's own `targets: "all"` needs no per-platform fork.
  const bundleFormats = isWindows ? ['nsis'] : ['deb', 'appimage'];
  // `.sig` alongside the installer/AppImage is the updater's signature —
  // createUpdaterArtifacts (Section 5) makes `tauri build` emit one per
  // self-updating bundle, and it belongs in dist/ next to what it signs.
  const bundleExtensions = isWindows ? ['exe', 'exe.sig'] : ['deb', 'AppImage', 'AppImage.sig'];

  process.stdout.write(`preparing desktop sidecar (${triple})\n\n`);

  const agentBinary = await packageAgent();
  await smokeAgent();

  const binariesDir = path.join(repoRoot, 'apps/desktop/src-tauri/binaries');
  fs.mkdirSync(binariesDir, { recursive: true });
  const sidecar = path.join(binariesDir, sidecarName);
  fs.copyFileSync(agentBinary, sidecar);
  // chmod +x means nothing on Windows (there is no exec bit), and fs.chmodSync
  // there only toggles the read-only attribute — skip it rather than rely on
  // that side effect being harmless.
  if (!isWindows) fs.chmodSync(sidecar, 0o755);
  process.stdout.write(`\n  sidecar   ${path.relative(repoRoot, sidecar)}\n\n`);

  const nodePtyResource = assembleNodePtyResource();
  process.stdout.write(`  resource  ${path.relative(repoRoot, nodePtyResource)}\n\n`);

  const webResource = buildWebResource();
  process.stdout.write(`\n  resource  ${path.relative(repoRoot, webResource)}\n\n`);

  return { triple, isWindows, bundleFormats, bundleExtensions };
}

/**
 * The other half: prepare, then actually run Tauri's bundler and collect what
 * it produced into `dist/`. Exported — rather than living in the main block
 * below — so reinstall.mjs can build and then install the very artifact this
 * returns, instead of re-deriving its name. That name is not guessable from
 * anything in this file: it is `<productName>_<version>_<arch>.<format>`, so
 * `Whiphand_0.1.0_amd64.deb` with a capital W the dpkg package name does not
 * share.
 *
 * @returns {Promise<string[]>} absolute paths of the artifacts now in dist/
 */
export async function buildDesktopBundles() {
  const { isWindows, bundleFormats, bundleExtensions } = await prepareDesktopBuild();
  const { productName, version } = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
  );
  // Tauri writes into src-tauri/target/release/bundle/<format>/.
  const bundleRoot = path.join(repoRoot, 'apps/desktop/src-tauri/target/release/bundle');

  clearStaleBundles({ bundleRoot, distDir, productName, bundleFormats, bundleExtensions });

  // `npm` on Windows is `npm.cmd`, which execFileSync cannot launch without a
  // shell — the same CVE-2024-27980 refusal resolveExecutable exists to work
  // around, here on the one call site that isn't a runner CLI.
  execFileSync('npm', ['run', 'tauri', '-w', 'desktop', '--', 'build', '--bundles', bundleFormats.join(',')], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, WHIPHAND_PACKAGE: '1' },
    shell: process.platform === 'win32',
  });

  return collectBundles({ bundleRoot, distDir, productName, version, isWindows, bundleFormats, bundleExtensions });
}

/** Matches a desktop bundle's filename: `<productName>_…` with one of this platform's bundle extensions. */
function bundlePattern(productName, bundleExtensions) {
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escape(productName)}_.*\\.(${bundleExtensions.map(escape).join('|')})$`);
}

/**
 * Deletes what earlier builds left behind, before `tauri build` runs: the
 * whole `bundle/<format>/` directories, and the matching bundles in `dist/`.
 *
 * Tauri never clears those directories, and the filename carries the version,
 * so after a bump the previous version's `.deb` stays next to the new one —
 * and `Whiphand_0.1.0_amd64.deb` sorts first. reinstall.mjs once installed it
 * in place of the build it had just made. Matching on `<productName>_` in
 * `dist/` matters on Windows, where the CLI and agent binaries are `.exe` too.
 */
export function clearStaleBundles({ bundleRoot, distDir, productName, bundleFormats, bundleExtensions }) {
  for (const format of bundleFormats) {
    fs.rmSync(path.join(bundleRoot, format), { recursive: true, force: true });
  }
  if (!fs.existsSync(distDir)) return;
  const pattern = bundlePattern(productName, bundleExtensions);
  for (const entry of fs.readdirSync(distDir)) {
    if (pattern.test(entry)) fs.rmSync(path.join(distDir, entry), { force: true });
  }
}

/**
 * Copies the bundles `tauri build` produced into `dist/`, next to the CLI
 * binary, so `dist/` is the one place to look. Throws on a bundle whose name
 * does not carry `version` rather than passing it on: with clearStaleBundles
 * run first that cannot happen, and if it ever does, a caller installing
 * whatever comes back would silently install the wrong build.
 *
 * @returns {string[]} absolute paths of the artifacts now in dist/
 */
export function collectBundles({ bundleRoot, distDir, productName, version, isWindows, bundleFormats, bundleExtensions }) {
  fs.mkdirSync(distDir, { recursive: true });
  const collected = [];
  const pattern = bundlePattern(productName, bundleExtensions);
  const current = `${productName}_${version}_`;
  for (const format of bundleFormats) {
    const dir = path.join(bundleRoot, format);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (!pattern.test(entry)) continue;
      if (!entry.startsWith(current)) {
        throw new Error(`${path.join(dir, entry)} is not a ${version} bundle; refusing to collect a stale build`);
      }
      const target = path.join(distDir, entry);
      fs.copyFileSync(path.join(dir, entry), target);
      if (!isWindows) fs.chmodSync(target, 0o755);
      collected.push(target);
    }
  }

  if (collected.length === 0) throw new Error(`tauri build produced no bundles under ${bundleRoot}`);
  return collected;
}

if (import.meta.filename === process.argv[1]) {
  const collected = await buildDesktopBundles();
  process.stdout.write('\n');
  for (const artifact of collected) process.stdout.write(`  ${artifact}\n`);
}
