import { test } from 'node:test';
import assert from 'node:assert/strict';
import path, { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveNodePty } from './native.ts';
// A packaging script, not a package this workspace's tsconfig declares types
// for — resolves fine at runtime under nodenext, just untyped.
// @ts-expect-error TS7016 — no declaration file for this .mjs
import { assembleNodePtyResource } from '../../../scripts/package/node-pty-resource.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('resolveNodePty(), pointed at the assembled resource tree, opens a real pty and observes its exit code', async () => {
  // Points at the same layout the shipped .deb/.AppImage/NSIS installer
  // carries — package.json plus lib/ plus one native dir, no node_modules
  // ancestor anywhere above it — rather than the repo's own
  // node_modules/node-pty. A previous version of this test pointed at the
  // latter, which made a bare `require('node-pty')` resolve by accident (the
  // upward node_modules walk found the repo's), masking the exact bug this
  // proof exists to catch. See native.ts's resolveNodePty for the fix.
  // A throwaway directory, not the bundle's own resource dir: the pty opened
  // below leaves ConPTY helpers holding files in it on Windows, which would
  // make a later `npm run package` fail to clear that directory.
  const resourceDir = assembleNodePtyResource(
    process.platform, mkdtempSync(join(tmpdir(), 'whiphand-native-node-pty-')),
  );
  const previous = process.env.WHIPHAND_NODE_PTY_DIR;
  process.env.WHIPHAND_NODE_PTY_DIR = resourceDir;
  try {
    const nodePty = resolveNodePty();
    const [file, args] = process.platform === 'win32'
      ? ['cmd.exe', ['/d', '/s', '/c', 'exit 7']]
      : ['/bin/sh', ['-c', 'exit 7']];
    const exitCode = await new Promise<number>(resolvePromise => {
      const child = nodePty.spawn(file, args, {
        cwd: repoRoot,
        env: process.env,
        cols: 80,
        rows: 24,
        name: 'xterm-256color',
      });
      child.onExit(({ exitCode: code }) => resolvePromise(code));
    });
    assert.equal(exitCode, 7);
  } finally {
    if (previous === undefined) delete process.env.WHIPHAND_NODE_PTY_DIR;
    else process.env.WHIPHAND_NODE_PTY_DIR = previous;
  }
});
