import { test } from 'node:test';
import assert from 'node:assert/strict';
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
