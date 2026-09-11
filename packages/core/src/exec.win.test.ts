/**
 * The empirical half of exec.ts: does an argument survive the whole path —
 * our quoting, cmd.exe's parser, an npm shim's `%*` forwarding, cmd's parser
 * *again*, and finally CommandLineToArgvW — byte for byte?
 *
 * Everything about the quoting design is reasoning about parsers we cannot run
 * on Linux, so this is where that reasoning is checked. It is the spike named
 * in exec.ts's header (the plan's S1), and it runs on CI's `windows-latest`
 * leg with no extra infrastructure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnRunner, cmdInvocation } from './exec.ts';

const windowsOnly = { skip: process.platform !== 'win32' ? 'Windows only' : false };

/**
 * A `.cmd` shaped like the shims npm generates for `claude`/`copilot` — the
 * `endLocal & goto ... ||` trick and the `%*` tail forwarding are the parts
 * that matter, because they are what puts a second cmd parse in the path.
 */
const SHIM = [
  '@ECHO off',
  'SETLOCAL',
  'CALL :find_dp0',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & node "%dp0%\\probe.js" %*',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
].join('\r\n');

const PROBE = 'console.log(JSON.stringify(process.argv.slice(2)));\n';

/**
 * A `.cmd` whose entry point cannot be read out of it, so spawnRunner has no
 * choice but to go through cmd.exe. `node` is invoked bare rather than through
 * a `"%dp0%\..."` reference, which is exactly what makes it unreadable.
 */
const OPAQUE_SHIM = [
  '@ECHO off',
  'SETLOCAL',
  // Via a variable, so no `"%dp0%\..."` literal survives for the bypass to
  // find — the shape pnpm, yarn and hand-written shims land in.
  'SET "entry=%~dp0probe.js"',
  'node "%entry%" %*',
].join('\r\n');

/**
 * Async throughout, and `await`ing the body, because every caller has one: a
 * synchronous `finally` would delete the shim while the first spawned cmd.exe
 * was still reading it, and every later case in the same body would spawn a
 * file that is no longer there. `maxRetries` covers the tail of that — a cmd
 * that has exited a moment ago can still hold the directory on Windows.
 */
async function withShim<T>(
  body: (shim: string) => T | Promise<T>, opts: { readable?: boolean } = {},
): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), 'whiphand-exec-win-'));
  try {
    writeFileSync(path.join(dir, 'probe.js'), PROBE);
    writeFileSync(path.join(dir, 'probe.cmd'), opts.readable === false ? OPAQUE_SHIM : SHIM);
    return await body(path.join(dir, 'probe.cmd'));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

function roundTrip(shim: string, args: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawnRunner([shim, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout!.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    child.stderr!.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`shim exited ${code}: ${err.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(out.trim()) as string[]);
      } catch {
        reject(new Error(`unparseable probe output: ${JSON.stringify(out)}`));
      }
    });
  });
}

test('every carryable argument shape survives the full cmd.exe round trip', windowsOnly, async () => {
  // Deliberately the unreadable shim: this is the fallback path, and it is the
  // only one where cmd.exe's parser is in play at all.
  const cases: [string, string[]][] = [
    ['a multi-word prompt', ['-p', 'two words here']],
    ['an ampersand', ['a&b']],
    ['a pipe', ['a|b']],
    ['redirects', ['a>b', 'a<b']],
    ['a caret', ['a^b']],
    ['parentheses', ['a(b)c']],
    ['a bare percent', ['100% done']],
    ['an undefined variable reference', ['%NOT_A_REAL_VAR_XYZ%']],
    ['exclamation marks', ['!bang!']],
    ['embedded quotes', ['say "hi" please']],
    ['a trailing backslash', ['C:\\dir\\']],
    ['a trailing backslash with a space', ['C:\\my dir\\']],
    ['an empty argument', ['', 'after']],
    ['non-ascii', ['héllo wörld']],
    ['several at once', ['-p', 'two words', '--flag=a&b', 'say "hi"']],
  ];
  await withShim(async shim => {
    for (const [label, args] of cases) {
      assert.deepEqual(await roundTrip(shim, args), args, label);
    }
  }, { readable: false });
});

test('a long-but-legal command line still round-trips intact', windowsOnly, async () => {
  const prompt = 'lorem ipsum dolor '.repeat(300).trim();
  await withShim(async shim => {
    assert.deepEqual(await roundTrip(shim, ['-p', prompt]), ['-p', prompt]);
  }, { readable: false });
});

test('the shapes cmd cannot carry are refused before spawning, not mangled', windowsOnly, async () => {
  // An *unrecognized* shim is the case that still has to go through cmd.exe,
  // so this is where those refusals still apply. A shim we can read through
  // (the test below) has no such limits.
  await withShim(shim => {
    assert.throws(() => spawnRunner([shim, 'first\nsecond']), /multi-line argument/);
    assert.throws(() => spawnRunner([shim, 'say "a&b"']), /both a quote and one of/);
    assert.throws(() => spawnRunner([shim, 'x'.repeat(9000)]), /over cmd\.exe's/);
  }, { readable: false });
});

test('reading through an npm shim carries what cmd.exe never could', windowsOnly, async () => {
  // The whole point of the bypass: no cmd parse, so a multi-line system prompt
  // — which every interactive agent step sends — arrives intact.
  const cases: [string, string[]][] = [
    ['a multi-line prompt', ['First paragraph.\n\nSecond paragraph.']],
    ['a defined variable, unexpanded', ['%COMSPEC% stays literal']],
    ['a quote beside a metacharacter', ['say "a&b"']],
    ['well past cmd\'s 8191-char line', ['-p', 'lorem ipsum '.repeat(1200).trim()]],
  ];
  await withShim(async shim => {
    for (const [label, args] of cases) {
      assert.deepEqual(await roundTrip(shim, args), args, label);
    }
  });
});

test('a defined %VAR% is still expanded — the documented residual hazard', windowsOnly, async () => {
  // Pinned deliberately: quoting cannot suppress this, because cmd expands on
  // the `/c` line before any quote processing. The fix is to get prompts off
  // the command line entirely (see exec.ts's header), and when that lands this
  // assertion is what should change.
  await withShim(async shim => {
    const [got] = await roundTrip(shim, ['%NOT_A_REAL_VAR_XYZ%']);
    assert.equal(got, '%NOT_A_REAL_VAR_XYZ%', 'an undefined variable survives literally');
    assert.notEqual(
      (await roundTrip(shim, ['%COMSPEC%']))[0], '%COMSPEC%',
      'a defined variable does not — this is the known limitation',
    );
  }, { readable: false });
});

test('cmdInvocation targets COMSPEC as it is actually set on this machine', windowsOnly, () => {
  const inv = cmdInvocation('claude.cmd', ['-p', 'hi there']);
  assert.match(inv.file, /cmd(\.exe)?$/i);
  assert.deepEqual(inv.args.slice(0, 4), ['/v:off', '/d', '/s', '/c']);
});
