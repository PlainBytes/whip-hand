import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnHeadless, spawnInteractive } from './tty.ts';

// `node -e` rather than `true`/`false`/`sleep`/`/bin/sh`: it behaves identically
// on every platform these tests run on, where the coreutils are absent on
// Windows and cmd's builtins are not the same programs.
const node = (script: string): string[] => [process.execPath, '-e', script];
const EXIT_OK = node('');
const EXIT_ONE = node('process.exit(1)');
const SLEEP = node('setTimeout(() => {}, 5000)');

test('spawnHeadless returns the child exit code', async () => {
  const ok = await spawnHeadless({ argv: EXIT_OK, cwd: process.cwd(), env: {}, interactive: false });
  assert.equal(ok, 0);
  const bad = await spawnHeadless({ argv: EXIT_ONE, cwd: process.cwd(), env: {}, interactive: false });
  assert.equal(bad, 1);
});

test('spawnHeadless resolves with a sentinel exit code when aborted mid-flight', async () => {
  const controller = new AbortController();
  const start = Date.now();
  const promise = spawnHeadless(
    { argv: SLEEP, cwd: process.cwd(), env: {}, interactive: false },
    controller.signal,
  );
  setTimeout(() => controller.abort(), 50);
  const code = await promise;
  const elapsedMs = Date.now() - start;
  assert.equal(code, 130);
  assert.ok(elapsedMs < 2000, `expected quick settle, took ${elapsedMs}ms`);
});

test('a progress spec goes to onLine and is never echoed to the terminal', async () => {
  // A distinctive token, so the assertion cannot trip over the test reporter's
  // own output. stdout is wrapped rather than replaced, for the same reason.
  const token = 'zzq-marker-9137';
  const seen: string[] = [];
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    written.push(String(chunk));
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;

  try {
    const code = await spawnHeadless(
      {
        argv: node(`console.log(${JSON.stringify(token)})`), cwd: process.cwd(), env: {},
        interactive: false, progress: { format: 'claude-stream-json' },
      },
      undefined,
      line => seen.push(line),
    );
    assert.equal(code, 0);
  } finally {
    process.stdout.write = original as typeof process.stdout.write;
  }

  assert.deepEqual(seen, [token]);
  assert.ok(!written.some(w => w.includes(token)), 'raw structured output must not reach the terminal');
});

test('a spec with both capture and progress still keeps its structured stdout off the terminal and out of the file', async () => {
  // Regression: capture used to be checked before progress, so such a spec
  // would have gone down the plain capture tee and echoed raw NDJSON.
  const outToken = 'zzq-progress-5521';
  const errToken = 'zzq-progress-err-5522';
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-tty-'));
  const file = join(dir, 'out.log');
  const seen: string[] = [];
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    written.push(String(chunk));
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  // Swallowed rather than wrapped: the token would otherwise show in the test output.
  process.stderr.write = (() => true) as typeof process.stderr.write;

  try {
    const code = await spawnHeadless(
      {
        argv: node(`console.log(${JSON.stringify(outToken)}); console.error(${JSON.stringify(errToken)})`),
        cwd: process.cwd(), env: {}, interactive: false,
        capture: { path: file }, progress: { format: 'claude-stream-json' },
      },
      undefined,
      line => seen.push(line),
    );
    assert.equal(code, 0);
  } finally {
    process.stdout.write = original as typeof process.stdout.write;
    process.stderr.write = originalErr as typeof process.stderr.write;
  }

  assert.deepEqual(seen.sort(), [outToken, errToken].sort());
  assert.ok(!written.some(w => w.includes(outToken)), 'raw structured output must not reach the terminal');
  assert.equal(await readFile(file, 'utf8'), `${errToken}\n`, 'the capture keeps stderr, not the progress stream');
  await rm(dir, { recursive: true, force: true });
});

test('a plain headless spec still reaches the terminal unchanged after the inherit -> pipe+tee switch, and also reaches onLine', async () => {
  // Regression for the run-audit design: core now always wants stdout/stderr
  // lines back (to fold into step:log), which meant giving up stdio:'inherit'
  // for the plain path. The one thing that must never change is what a human
  // watching `whiphand run` in a terminal actually sees.
  const outToken = 'zzq-stdout-8214';
  const errToken = 'zzq-stderr-8215';
  const written: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    written.push(String(chunk));
    return (originalOut as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    written.push(String(chunk));
    return (originalErr as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;

  const seen: Array<{ line: string; stream: 'stdout' | 'stderr' }> = [];
  let code: number;
  try {
    code = await spawnHeadless(
      {
        argv: node(`console.log(${JSON.stringify(outToken)}); console.error(${JSON.stringify(errToken)})`),
        cwd: process.cwd(), env: {}, interactive: false,
      },
      undefined,
      (line, stream) => seen.push({ line, stream }),
    );
  } finally {
    process.stdout.write = originalOut as typeof process.stdout.write;
    process.stderr.write = originalErr as typeof process.stderr.write;
  }

  assert.equal(code, 0);
  assert.ok(written.some(w => w.includes(outToken)), 'stdout still reaches the terminal');
  assert.ok(written.some(w => w.includes(errToken)), 'stderr still reaches the terminal');
  assert.deepEqual(seen.sort((a, b) => a.stream.localeCompare(b.stream)), [
    { line: errToken, stream: 'stderr' },
    { line: outToken, stream: 'stdout' },
  ]);
});

test('a plain headless spec with no onLine reader falls back to the original inherit path', async () => {
  const code = await spawnHeadless({ argv: EXIT_OK, cwd: process.cwd(), env: {}, interactive: false });
  assert.equal(code, 0);
});

test('spawnInteractive resolves with a sentinel exit code when aborted mid-flight (stdio inherit)', async () => {
  const controller = new AbortController();
  const start = Date.now();
  const promise = spawnInteractive(
    { argv: SLEEP, cwd: process.cwd(), env: {}, interactive: true },
    controller.signal,
  );
  setTimeout(() => controller.abort(), 50);
  const code = await promise;
  const elapsedMs = Date.now() - start;
  assert.equal(code, 130);
  assert.ok(elapsedMs < 2000, `expected quick settle, took ${elapsedMs}ms`);
});
