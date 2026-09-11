#!/usr/bin/env node
/**
 * Builds dist/whiphand-agent — the @whiphand/agent stdio sidecar as one file.
 *
 * node-pty is left external rather than bundled: it resolves itself from a
 * real directory via packages/agent/src/native.ts's `createRequire`, which
 * only works against a real filesystem, not a bundled SEA blob. `dist/whiphand-agent`
 * therefore is not self-contained — it needs `WHIPHAND_NODE_PTY_DIR` (or the
 * baked-in default below) to open a pty at all. That is fine: this binary was
 * never a shipped artifact on its own, only an implementation detail of the
 * desktop bundle, which ships node-pty alongside it as a Tauri resource (see
 * scripts/package/node-pty-resource.mjs).
 *
 * bufferutil and utf-8-validate are `ws`'s optional native accelerators. `ws`
 * requires them inside try/catch and falls back to pure JS when they are
 * absent, so leaving them external means the require throws harmlessly at
 * runtime and the fallback is used. Bundling them would drag native addons
 * into a blob that cannot load them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildSingleExecutable, assertInjectableNode, repoRoot } from './sea.mjs';
import { smokeAgent } from './smoke.mjs';

const nodePtyDir = path.join(repoRoot, 'node_modules/node-pty');

export async function packageAgent() {
  assertInjectableNode();
  if (!fs.existsSync(nodePtyDir)) {
    throw new Error(`node-pty not found at ${nodePtyDir} — run npm install`);
  }
  return buildSingleExecutable({
    name: 'whiphand-agent',
    entry: path.join(repoRoot, 'packages/agent/src/main.ts'),
    external: ['node-pty', 'bufferutil', 'utf-8-validate'],
    define: { WHIPHAND_NODE_PTY_DIR_DEFAULT: JSON.stringify(nodePtyDir) },
  });
}

if (import.meta.filename === process.argv[1]) {
  process.stdout.write('packaging whiphand-agent\n');
  const binary = await packageAgent();
  process.stdout.write('\n');
  await smokeAgent();
  process.stdout.write(`\n  ${binary}\n`);
}
