import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { basename } from 'node:path';
import type { SpawnSpec } from '@whiphand/core';
import { startPty } from './pty.ts';

function ptySpec(argv: string[]): SpawnSpec {
  return { argv, cwd: process.cwd(), env: {}, interactive: true };
}

/**
 * `node -e` rather than `bash`/`cat`: what is under test is startPty's own
 * plumbing — data in and out, exit, resize, BEL scanning — not a shell, and
 * neither bash nor cat exists on the Windows CI leg.
 */
function nodeSpec(script: string): SpawnSpec {
  return ptySpec([process.execPath, '-e', script]);
}

/** A pty echoes what is written to it, so a reader is all `cat` was providing. */
const READ_STDIN = 'process.stdin.resume(); process.stdin.on("data", () => {});';
function toB64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}
function fromB64(s: string): string {
  return Buffer.from(s, 'base64').toString('utf8');
}

test('write() is echoed back through onData (base64 in, base64 out) and onExit observes the exit code', async () => {
  const chunks: string[] = [];
  const result = await new Promise<number>(resolvePromise => {
    const handle = startPty(nodeSpec(
      'let buf = ""; process.stdin.on("data", d => { buf += d; '
      + 'if (/[\\r\\n]/.test(buf)) { console.log("got:" + buf.trim()); process.exit(0); } });',
    ), {
      cols: 80,
      rows: 24,
      onData: data => chunks.push(fromB64(data)),
      onExit: resolvePromise,
    });
    // CR, not LF: a terminal sends carriage return for Enter. A POSIX pty's
    // line discipline maps it to LF for the reader; ConPTY forwards no bare
    // LF at all, so the child would never see a line end.
    handle.write(toB64('world\r'));
  });
  assert.equal(result, 0);
  assert.ok(chunks.join('').includes('got:world'), `expected echoed output, got: ${chunks.join('')}`);
});

test('kill() terminates the pty and onExit still fires', async () => {
  const result = await new Promise<number>(resolvePromise => {
    const handle = startPty(nodeSpec(READ_STDIN), {
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: resolvePromise,
    });
    handle.kill();
  });
  assert.equal(typeof result, 'number');
});

test('kill() twice is safe — session-end escalates, and a second one must not crash', async () => {
  // On Windows the second kill would otherwise reach a pty handle node-pty had
  // already freed, which takes the process down with nothing to catch. This
  // reads as trivially green off Windows; there it is the regression test.
  const result = await new Promise<number>(resolvePromise => {
    const handle = startPty(nodeSpec(READ_STDIN), {
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: resolvePromise,
    });
    handle.kill('SIGTERM');
    handle.kill('SIGKILL');
  });
  assert.equal(typeof result, 'number');
});

test('an abort signal kills the pty', async () => {
  const controller = new AbortController();
  const result = await new Promise<number>(resolvePromise => {
    startPty(nodeSpec(READ_STDIN), {
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: resolvePromise,
      signal: controller.signal,
    });
    controller.abort();
  });
  assert.equal(typeof result, 'number');
});

test('resize() does not throw against a live pty', async () => {
  const result = await new Promise<number>(resolvePromise => {
    const handle = startPty(nodeSpec(READ_STDIN), {
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: resolvePromise,
    });
    assert.doesNotThrow(() => handle.resize(120, 40));
    handle.kill();
  });
  assert.equal(typeof result, 'number');
});

test('cwd and env are honored', async () => {
  const chunks: string[] = [];
  const result = await new Promise<number>(resolvePromise => {
    const handle = startPty({
      argv: [process.execPath, '-e', 'console.log(process.env.WHIPHAND_TEST_VAR); console.log(process.cwd())'],
      cwd: tmpdir(),
      env: { WHIPHAND_TEST_VAR: 'hello-env' },
      interactive: true,
    }, {
      cols: 80,
      rows: 24,
      onData: data => chunks.push(fromB64(data)),
      onExit: resolvePromise,
    });
    void handle;
  });
  assert.equal(result, 0);
  const out = chunks.join('');
  assert.ok(out.includes('hello-env'), `expected env var in output, got: ${out}`);
  // A pty hard-wraps at `cols`, and the temp dir can be a long path on
  // Windows, so match on its last segment rather than the whole thing.
  assert.ok(out.includes(basename(tmpdir())), `expected cwd in output, got: ${out}`);
});

test('onBell fires for a real beep but not for a window-title sequence', async () => {
  const bells: number[] = [];
  await new Promise<void>(resolve => {
    startPty(
      // The title sequence ends in BEL too; only the standalone one is a beep.
      nodeSpec(String.raw`process.stdout.write('\u001b]0;title\u0007'); process.stdout.write('\u0007');`),
      {
        cols: 80, rows: 24,
        onData: () => {},
        onBell: () => bells.push(1),
        onExit: () => resolve(),
      },
    );
  });
  assert.equal(bells.length, 1);
});
