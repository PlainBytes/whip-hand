#!/usr/bin/env node
/**
 * Builds the desktop app: a .deb and an .AppImage on Linux, an NSIS
 * installer on Windows.
 *
 * This script does not bundle anything itself — Tauri's own bundler does
 * that. `prepareDesktopBuild()` is the handoff: build the web UI the agent's
 * remote access serves, as a Tauri resource. The agent itself is compiled
 * into the app (crates/whiphand-agent). It is exported separately from the
 * `tauri build` invocation below because release.yml needs exactly this
 * half: the release build hands the actual `tauri build` off to
 * tauri-action, which also signs and uploads, so it cannot go through
 * `npm run tauri` itself the way local packaging does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { runInherited } from '../lib/exec.mjs';
import { repoRoot, distDir } from './common.mjs';
import { buildWebResource } from './web-resource.mjs';

/**
 * @returns {{ isWindows: boolean, bundleFormats: string[], bundleExtensions: string[] }}
 */
export function prepareDesktopBuild() {
  const isWindows = process.platform === 'win32';
  // Format list per platform, since Windows can only ever produce nsis and
  // Linux never will — this also becomes the `--bundles` argument, so
  // tauri.conf.json's own `targets: "all"` needs no per-platform fork.
  const bundleFormats = isWindows ? ['nsis'] : ['deb', 'appimage'];
  // `.sig` alongside the installer/AppImage is the updater's signature —
  // createUpdaterArtifacts (Section 5) makes `tauri build` emit one per
  // self-updating bundle, and it belongs in dist/ next to what it signs.
  const bundleExtensions = isWindows ? ['exe', 'exe.sig'] : ['deb', 'AppImage', 'AppImage.sig'];

  const webResource = buildWebResource();
  process.stdout.write(`\n  resource  ${path.relative(repoRoot, webResource)}\n\n`);

  return { isWindows, bundleFormats, bundleExtensions };
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
  const { isWindows, bundleFormats, bundleExtensions } = prepareDesktopBuild();
  const { productName, version } = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
  );
  // Tauri writes into src-tauri/target/release/bundle/<format>/.
  const bundleRoot = path.join(repoRoot, 'apps/desktop/src-tauri/target/release/bundle');

  clearStaleBundles({ bundleRoot, distDir, productName, bundleFormats, bundleExtensions });

  // `npm` on Windows is `npm.cmd`, which cannot be launched without a shell —
  // the CVE-2024-27980 refusal resolveExecutable exists to work around. It goes
  // through the seam (invariant 1) instead of `shell: true`: the seam reads
  // through the shim or wraps it correctly, and this script needs no
  // allowlist entry.
  const status = runInherited(
    ['npm', 'run', 'tauri', '-w', 'desktop', '--', 'build', '--bundles', bundleFormats.join(',')],
    { cwd: repoRoot },
  );
  if (status !== 0) throw new Error(`tauri build exited with status ${status}`);

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
 * `dist/` matters on Windows, where the CLI binary is `.exe` too.
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
