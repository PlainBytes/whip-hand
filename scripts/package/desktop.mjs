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

if (import.meta.filename === process.argv[1]) {
  const { isWindows, bundleFormats, bundleExtensions } = await prepareDesktopBuild();

  // `npm` on Windows is `npm.cmd`, which execFileSync cannot launch without a
  // shell — the same CVE-2024-27980 refusal resolveExecutable exists to work
  // around, here on the one call site that isn't a runner CLI.
  execFileSync('npm', ['run', 'tauri', '-w', 'desktop', '--', 'build', '--bundles', bundleFormats.join(',')], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, WHIPHAND_PACKAGE: '1' },
    shell: process.platform === 'win32',
  });

  // Tauri writes into src-tauri/target/release/bundle/<format>/. Collect the
  // artifacts next to the CLI binary so `dist/` is the one place to look.
  const bundleRoot = path.join(repoRoot, 'apps/desktop/src-tauri/target/release/bundle');
  fs.mkdirSync(distDir, { recursive: true });
  const collected = [];
  const extensionPattern = new RegExp(`\\.(${bundleExtensions.join('|')})$`);
  for (const format of bundleFormats) {
    const dir = path.join(bundleRoot, format);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (!extensionPattern.test(entry)) continue;
      const target = path.join(distDir, entry);
      fs.copyFileSync(path.join(dir, entry), target);
      if (!isWindows) fs.chmodSync(target, 0o755);
      collected.push(target);
    }
  }

  if (collected.length === 0) throw new Error(`tauri build produced no bundles under ${bundleRoot}`);
  process.stdout.write('\n');
  for (const artifact of collected) process.stdout.write(`  ${artifact}\n`);
}
