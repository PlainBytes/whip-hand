import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { planExec } from './package/sea.mjs';

// planExec is the seam sea.mjs routes WHIPHAND_SIGN_COMMAND and the postject
// invocation through instead of execFileSync's own `shell: true` (which joins
// file and args with a bare space and no quoting — DEP0190 — and would break
// on any argument containing a space). These tests exercise its Windows
// branch from Linux CI the same way exec.test.ts does: `platform: 'win32'`
// plus a `PATH` pointing at a real temp directory, so resolveExecutable's
// readdirSync sees real files without needing a Windows host.

test('planExec: a native .exe on PATH needs no wrapping', () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'whiphand-sea-'));
  fs.writeFileSync(path.join(dir, 'signtool.exe'), '');

  const { file, args, options } = planExec(['signtool', 'C:\\out\\cli.exe'], {
    platform: 'win32', env: { PATH: dir, PATHEXT: '.EXE' },
  });

  assert.equal(file, path.win32.join(dir, 'signtool.exe'));
  assert.deepEqual(args, ['C:\\out\\cli.exe']);
  assert.deepEqual(options, {});
});

test('planExec: an unrecognized .cmd shim falls back to a quoted cmd.exe wrapper, not shell: true', () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'whiphand-sea-'));
  // Deliberately not an npm/pnpm/yarn node-shim shape, so resolveShim bails
  // and planLaunch has to fall back to the cmd.exe wrapper.
  fs.writeFileSync(path.join(dir, 'mytool.cmd'), '@echo off\r\n%*\r\n');

  const binaryWithSpace = 'C:\\Program Files\\out\\cli.exe';
  const { file, args, options } = planExec(['mytool', binaryWithSpace], {
    platform: 'win32', env: { PATH: dir, PATHEXT: '.CMD' },
  });

  assert.equal(file, 'cmd.exe');
  assert.equal(options.windowsVerbatimArguments, true);
  assert.equal(typeof options.argv0, 'string');
  // The space-containing path must survive as one argument (quoted), not be
  // split in two the way a bare-space join (Node's `shell: true`) would do.
  const commandLine = args.join(' ');
  assert.match(commandLine, /"C:\\Program Files\\out\\cli\.exe"/);
});

test('planExec: on POSIX, an absolute path is used unchanged with no wrapping', () => {
  const { file, args, options } = planExec(['/usr/bin/postject', 'a.bin'], { platform: 'linux' });

  assert.equal(file, '/usr/bin/postject');
  assert.deepEqual(args, ['a.bin']);
  assert.deepEqual(options, {});
});
