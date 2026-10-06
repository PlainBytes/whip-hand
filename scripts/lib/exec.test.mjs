import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveExecutable, msvcrtQuote, cmdInvocation, planLaunch, spawnRunner } from './exec.mjs';

// The win32 branch resolves with `path.win32` rules wherever it *runs*, so the
// fixtures are created with the host's `path` (the file has to actually exist)
// but asserted against `path.win32` (that is what the code under test returns).
const winJoin = path.win32.join;

test('resolveExecutable is a no-op on POSIX', () => {
  const resolved = resolveExecutable('claude', { platform: 'linux' });
  assert.deepEqual(resolved, { file: 'claude', usesShell: false });
});

test('resolveExecutable does not walk PATH for an explicit path', () => {
  const resolved = resolveExecutable('C:\\tools\\claude.cmd', { platform: 'win32', env: {} });
  assert.equal(resolved.file, 'C:\\tools\\claude.cmd');
  assert.equal(resolved.usesShell, true);
});

test('resolveExecutable finds a .cmd shim on PATH and flags it for a shell', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'whiphand-exec-'));
  try {
    writeFileSync(path.join(dir, 'claude.cmd'), '@echo off\n');
    const resolved = resolveExecutable('claude', {
      platform: 'win32',
      env: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    });
    assert.equal(resolved.file, winJoin(dir, 'claude.cmd'));
    assert.equal(resolved.usesShell, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveExecutable prefers an earlier PATHEXT extension and does not need a shell for .exe', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'whiphand-exec-'));
  try {
    writeFileSync(path.join(dir, 'node.exe'), '');
    const resolved = resolveExecutable('node', {
      platform: 'win32',
      env: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    });
    assert.equal(resolved.file, winJoin(dir, 'node.exe'));
    assert.equal(resolved.usesShell, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveExecutable falls back to the bare command when nothing is found on PATH', () => {
  const resolved = resolveExecutable('does-not-exist', { platform: 'win32', env: { PATH: '' } });
  assert.deepEqual(resolved, { file: 'does-not-exist', usesShell: false });
});

test('resolveExecutable splits PATH on the Windows delimiter, not the host one', () => {
  const empty = mkdtempSync(path.join(tmpdir(), 'whiphand-exec-empty-'));
  const dir = mkdtempSync(path.join(tmpdir(), 'whiphand-exec-'));
  try {
    writeFileSync(path.join(dir, 'copilot.bat'), '@echo off\n');
    const resolved = resolveExecutable('copilot', {
      platform: 'win32',
      // `;` regardless of where this test runs — a `:`-joined PATH would leave
      // both entries unfindable on Windows, which is the bug this pins.
      env: { PATH: `${empty};${dir}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    });
    assert.equal(resolved.file, winJoin(dir, 'copilot.bat'));
    assert.equal(resolved.usesShell, true);
  } finally {
    rmSync(empty, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveExecutable reads the extension with Windows path rules', () => {
  // Host `extname` under POSIX rules sees `.d\claude` here and misclassifies.
  const resolved = resolveExecutable('C:\\to.ols\\claude.cmd', { platform: 'win32', env: {} });
  assert.equal(resolved.usesShell, true);
});

test('msvcrtQuote leaves an ordinary argument alone and round-trips the rest', () => {
  assert.equal(msvcrtQuote('--verbose'), '--verbose');
  assert.equal(msvcrtQuote('C:\\tools\\claude.cmd'), 'C:\\tools\\claude.cmd');
  assert.equal(msvcrtQuote(''), '""');
  assert.equal(msvcrtQuote('multi word'), '"multi word"');
  assert.equal(msvcrtQuote('say "hi"'), '"say \\"hi\\""');
  // Backslashes are only special before a quote: bare ones stay single,
  // trailing ones double so they cannot escape the closing quote.
  assert.equal(msvcrtQuote('a\\b c'), '"a\\b c"');
  assert.equal(msvcrtQuote('C:\\dir\\'), 'C:\\dir\\');
  assert.equal(msvcrtQuote('C:\\my dir\\'), '"C:\\my dir\\\\"');
  assert.equal(msvcrtQuote('a\\"b'), '"a\\\\\\"b"');
});

test('msvcrtQuote quotes cmd metacharacters that MSVCRT alone would not', () => {
  // Each of these is harmless to CommandLineToArgvW but acts on cmd's parser,
  // so leaving them bare would lose the tail of the command line.
  for (const arg of ['a&b', 'a|b', 'a>b', 'a<b', 'a^b', 'a(b)', '100%', '!bang!']) {
    assert.equal(msvcrtQuote(arg), `"${arg}"`, arg);
  }
});

test('cmdInvocation builds Node\'s own wrapper shape, with quoting put back', () => {
  const inv = cmdInvocation('C:\\tools\\claude.cmd', ['-p', 'two words'], { COMSPEC: 'C:\\Windows\\cmd.exe' });
  assert.equal(inv.file, 'C:\\Windows\\cmd.exe');
  assert.equal(inv.argv0, 'C:\\Windows\\cmd.exe');
  assert.deepEqual(inv.args, ['/v:off', '/d', '/s', '/c', '"C:\\tools\\claude.cmd -p "two words""']);
  assert.equal(inv.commandLine, '/v:off /d /s /c "C:\\tools\\claude.cmd -p "two words""');
});

test('cmdInvocation quotes a COMSPEC containing a space for the verbatim command line', () => {
  // libuv emits argv[0] as-is under windowsVerbatimArguments, so the quoted
  // form has to be supplied separately from the CreateProcess lookup path.
  const inv = cmdInvocation('claude.cmd', [], { COMSPEC: 'C:\\Program Files\\cmd.exe' });
  assert.equal(inv.file, 'C:\\Program Files\\cmd.exe');
  assert.equal(inv.argv0, '"C:\\Program Files\\cmd.exe"');
});

test('cmdInvocation defaults to cmd.exe when COMSPEC is unset', () => {
  assert.equal(cmdInvocation('claude.cmd', [], {}).file, 'cmd.exe');
});

test('cmdInvocation refuses a multi-line argument rather than truncating it', () => {
  assert.throws(
    () => cmdInvocation('claude.cmd', ['-p', 'first line\nsecond line'], {}),
    /multi-line argument.*cmd\.exe/s,
  );
});

test('cmdInvocation refuses a quote sharing an argument with a cmd metacharacter', () => {
  // No encoding satisfies both parsers: cmd closes its quote state at the
  // backslash-escaped quote, leaving the `&` outside quotes to split the line.
  assert.throws(() => cmdInvocation('claude.cmd', ['say "a&b"'], {}), /both a quote and one of/);
  // Either one alone is carryable.
  assert.doesNotThrow(() => cmdInvocation('claude.cmd', ['say "hi"'], {}));
  assert.doesNotThrow(() => cmdInvocation('claude.cmd', ['a&b'], {}));
});

test('cmdInvocation refuses a command line over cmd.exe\'s limit', () => {
  assert.throws(() => cmdInvocation('claude.cmd', ['-p', 'x'.repeat(9000)], {}), /over cmd\.exe's/);
});

test('planLaunch needs no cmd.exe on POSIX, nor for a Windows .exe', () => {
  assert.equal(planLaunch(['claude', '-p', 'hello there'], { platform: 'linux' }).invocation, null);
  assert.equal(planLaunch(['C:\\tools\\claude.exe', '-p'], { platform: 'win32', env: {} }).invocation, null);
});

test('planLaunch no longer special-cases an argv[0] of cmd.exe', () => {
  // Command steps used to reach cmd.exe as argv[0] and needed a verbatim
  // `"…"`-wrapped run line. They run through a POSIX shell now, on every
  // platform, so the cmd.exe hop exists only for a `.cmd` shim we could not
  // read — and nothing here treats cmd.exe as a shell to quote for.
  const plan = planLaunch(['cmd.exe', '/d', '/s', '/c', 'echo "hi"'], { platform: 'win32', env: {} });
  assert.equal(plan.invocation, null);
  assert.deepEqual([plan.file, ...plan.args], ['cmd.exe', '/d', '/s', '/c', 'echo "hi"']);
});

test('planLaunch leaves a non-cmd shell to libuv\'s ordinary quoting', () => {
  // PowerShell parses its command line with MSVCRT rules, so Node already
  // gets it right; only the cmd family needs the verbatim treatment.
  assert.equal(
    planLaunch(['powershell.exe', '-NoProfile', '-Command', 'echo "hi"'], { platform: 'win32', env: {} }).invocation,
    null,
  );
});

test('spawnRunner passes POSIX argv through untouched, with no shell', () => {
  const calls= [];
  const fake = ((file, args, options) => {
    calls.push({ file, args, options });
    return {}                                  ;
  })                      ;

  spawnRunner(['claude', '-p', 'two words'], { cwd: '/w' }, { platform: 'linux', spawn: fake });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'claude');
  assert.deepEqual(calls[0].args, ['-p', 'two words']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, '/w');
  assert.equal(calls[0].options.windowsVerbatimArguments, undefined);
});

test('spawnRunner hands a .cmd shim a fully quoted verbatim command line', () => {
  const calls= [];
  const fake = ((file, args, options) => {
    calls.push({ file, args, options });
    return {}                                  ;
  })                      ;

  spawnRunner(['C:\\tools\\claude.cmd', '-p', 'two words'], {}, {
    platform: 'win32', env: { COMSPEC: 'C:\\Windows\\cmd.exe' }, spawn: fake,
  });
  assert.equal(calls[0].file, 'C:\\Windows\\cmd.exe');
  // The prompt survives as one argument — under Node's `shell: true` this is
  // where it would have been split into `two` and `words`.
  assert.deepEqual(calls[0].args, ['/v:off', '/d', '/s', '/c', '"C:\\tools\\claude.cmd -p "two words""']);
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.argv0, 'C:\\Windows\\cmd.exe');
});

// --- bypassing the .cmd shim -------------------------------------------

/**
 * An npm-generated `.cmd` shim, as npm 9/10 writes them. The load-bearing
 * parts are the `%dp0%`-relative path to the real entry point and the
 * `node.exe`-if-present-else-`node` choice of interpreter.
 */
function npmShim(scriptRelative) {
  return [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${scriptRelative}" %*`,
  ].join('\r\n');
}

/** Records what spawnRunner actually handed to `spawn`. */
function recordingSpawn() {
  const calls= [];
  const spawn = ((file, args, options) => {
    calls.push({ file, args, options });
    return {}                                  ;
  })                      ;
  return { calls, spawn };
}

/** A PATH directory holding a shim, its entry point, and optionally a sibling node.exe. */
function shimDir(opts= {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'whiphand-shim-'));
  const script = opts.script ?? 'node_modules/@anthropic-ai/claude-code/cli.js';
  mkdirSync(path.join(dir, path.dirname(script)), { recursive: true });
  writeFileSync(path.join(dir, script), '#!/usr/bin/env node\n');
  writeFileSync(path.join(dir, 'claude.cmd'), opts.body ?? npmShim(script.split('/').join('\\')));
  if (opts.sibling !== false) writeFileSync(path.join(dir, 'node.exe'), '');
  return dir;
}

test('a .cmd shim is resolved to the node invocation it wraps, skipping cmd.exe entirely', () => {
  const dir = shimDir();
  try {
    const { calls, spawn } = recordingSpawn();
    spawnRunner(['claude', '-p', 'two words'], {}, {
      platform: 'win32', env: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, spawn,
    });
    // The sibling node.exe, exactly as the shim itself would have chosen.
    assert.equal(calls[0].file, path.win32.join(dir, 'node.exe'));
    assert.deepEqual(calls[0].args, [
      path.win32.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
      '-p', 'two words',
    ]);
    // No cmd.exe means no verbatim command line to hand it.
    assert.equal(calls[0].options.windowsVerbatimArguments, undefined);
    assert.equal(calls[0].options.shell, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a multi-line prompt survives the bypass — the whole point of it', () => {
  const dir = shimDir();
  try {
    const { calls, spawn } = recordingSpawn();
    const guidance = 'First paragraph.\n\nSecond paragraph with "quotes" & an ampersand.';
    // Through cmd.exe this throws; CreateProcess carries it without complaint.
    spawnRunner(['claude', '--append-system-prompt', guidance], {}, {
      platform: 'win32', env: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, spawn,
    });
    assert.equal(calls[0].args[2], guidance);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with no sibling node.exe the bypass falls back to node on PATH', () => {
  const dir = shimDir({ sibling: false });
  const nodeDir = mkdtempSync(path.join(tmpdir(), 'whiphand-node-'));
  try {
    writeFileSync(path.join(nodeDir, 'node.exe'), '');
    const { calls, spawn } = recordingSpawn();
    spawnRunner(['claude', '-p'], {}, {
      platform: 'win32',
      env: { PATH: `${dir};${nodeDir}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      spawn,
    });
    assert.equal(calls[0].file, path.win32.join(nodeDir, 'node.exe'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(nodeDir, { recursive: true, force: true });
  }
});

test('an unrecognized shim shape falls back to cmd.exe rather than guessing', () => {
  // pnpm, yarn and hand-written .cmd files all land here. Degrading to the
  // old behaviour is right; inventing an interpreter for a file we cannot
  // read is not.
  const dir = shimDir({ body: '@echo off\r\nsome-other-program.exe %*\r\n' });
  try {
    const { calls, spawn } = recordingSpawn();
    spawnRunner(['claude', '-p', 'two words'], {}, {
      platform: 'win32', env: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, spawn,
    });
    assert.equal(calls[0].options.windowsVerbatimArguments, true);
    assert.deepEqual(calls[0].args.slice(0, 4), ['/v:off', '/d', '/s', '/c']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a shim naming an entry point that is not there falls back too', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'whiphand-shim-'));
  try {
    writeFileSync(path.join(dir, 'claude.cmd'), npmShim('node_modules\\gone\\cli.js'));
    writeFileSync(path.join(dir, 'node.exe'), '');
    const { calls, spawn } = recordingSpawn();
    spawnRunner(['claude', '-p'], {}, {
      platform: 'win32', env: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, spawn,
    });
    assert.equal(calls[0].options.windowsVerbatimArguments, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a pnpm-style %~dp0 shim is bypassed too', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'whiphand-shim-'));
  try {
    mkdirSync(path.join(dir, 'pkg'), { recursive: true });
    writeFileSync(path.join(dir, 'pkg', 'entry.js'), '');
    writeFileSync(path.join(dir, 'copilot.cmd'),
      '@SETLOCAL\r\n@SET PATHEXT=%PATHEXT:;.JS;=;%\r\n@node  "%~dp0\\pkg\\entry.js" %*\r\n');
    writeFileSync(path.join(dir, 'node.exe'), '');
    const { calls, spawn } = recordingSpawn();
    spawnRunner(['copilot', '-p', 'hi there'], {}, {
      platform: 'win32', env: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, spawn,
    });
    assert.equal(calls[0].file, path.win32.join(dir, 'node.exe'));
    assert.deepEqual(calls[0].args, [path.win32.join(dir, 'pkg', 'entry.js'), '-p', 'hi there']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a native .exe runner is untouched by any of this', () => {
  // The common Windows shape now: claude/copilot ship their own installers,
  // and a .exe never went near cmd.exe in the first place.
  const dir = mkdtempSync(path.join(tmpdir(), 'whiphand-native-'));
  try {
    writeFileSync(path.join(dir, 'claude.exe'), '');
    const { calls, spawn } = recordingSpawn();
    spawnRunner(['claude', '-p', 'a\nb'], {}, {
      platform: 'win32', env: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, spawn,
    });
    assert.equal(calls[0].file, path.win32.join(dir, 'claude.exe'));
    assert.deepEqual(calls[0].args, ['-p', 'a\nb']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
