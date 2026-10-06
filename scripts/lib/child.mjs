/**
 * Helpers for driving a long-lived child over NDJSON (the benchmarks), and
 * for tearing it down without leaving a process tree behind.
 */
import fs from 'node:fs';
import { runSync } from './exec.mjs';

/**
 * Streams NDJSON lines from `child.stdout` to `onMessage` as they arrive,
 * one parsed object per line. It keeps listening past the first line, since
 * a `startRun` response is followed by a stream of notifications on the same
 * stdout.
 */
export function streamNdjson(child, onMessage) {
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) onMessage(JSON.parse(line));
    }
  });
}

/**
 * `child.kill()` terminates one process, never the tree below it. The agent
 * spawns a pty, whose shell and ConPTY helpers outlive it — and any of them
 * still running holds the run's workdir open, because a live process's cwd
 * cannot be removed on Windows. `taskkill /T` takes the whole tree, and
 * waiting for `close` means those handles are gone before anything tries to
 * delete underneath them.
 */
export function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const closed = new Promise(resolve => child.once('close', resolve));
  if (process.platform === 'win32') runSync(['taskkill', '/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
  // Never let teardown outlast the thing it is tearing down: a smoke test that
  // has already answered its question must not become the hang.
  return Promise.race([closed, new Promise(resolve => setTimeout(resolve, 5_000).unref())]);
}

/**
 * Best effort. A ConPTY helper can outlive even a tree kill, and a temp
 * directory we could not remove is not a reason to fail a packaging run whose
 * question is already answered.
 */
export function discard(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (error) {
    process.stdout.write(`  note      left ${dir} behind (${error.code})\n`);
  }
}
