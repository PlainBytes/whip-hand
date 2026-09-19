#!/usr/bin/env node
/**
 * Smoke tests for the packaged binaries. These are the only tests that can see
 * what the unit suite cannot: whether the bundle actually carries the engine
 * and whether the SEA boots. Run automatically at the end of each packaging
 * script.
 *
 * node-pty is no longer embedded in either binary (see native.ts and
 * agent.mjs) — proving that it still resolves *from source* and can open a
 * real pty is packages/agent/src/native.test.ts's job, run on every `npm
 * test`. That is not the same proof as this file's: `smokeAgent()` below
 * drives the actual packaged binary through its real NDJSON protocol, with
 * `WHIPHAND_NODE_PTY_DIR` pointed at the assembled resource tree (the layout a
 * `.deb`/`.AppImage`/NSIS install actually carries), so a bug that only
 * bundling introduces — or a resolution that only happens to work against
 * `node_modules/node-pty` — is caught here, not just at the unit level.
 * `scripts/package/fixtures/bin`'s `claude` stub stands in for a real runner
 * CLI so this needs nothing installed on the packaging machine.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { runSync, spawnRunner } from '../../packages/core/src/exec.ts';
import { repoRoot, distDir } from './sea.mjs';
import { assembleNodePtyResource } from './node-pty-resource.mjs';

const exeSuffix = process.platform === 'win32' ? '.exe' : '';
const FIXTURE_BIN = path.join(repoRoot, 'scripts/package/fixtures/bin');

/**
 * The sidecar's remote-access config lives in the user's data dir, and a
 * packaging machine that has remote access enabled would otherwise have every
 * smoke run bind that port on the LAN. Pointed at a file that doesn't exist,
 * the store falls back to its defaults: off.
 */
const ISOLATED_REMOTE_CONFIG = path.join(os.tmpdir(), `whiphand-smoke-${process.pid}`, 'remote-access.json');

function check(label, fn) {
  try {
    fn();
    process.stdout.write(`  ✔ ${label}\n`);
  } catch (error) {
    process.stdout.write(`  ✘ ${label}\n`);
    throw error;
  }
}

export function smokeCli() {
  const whiphand = path.join(distDir, `whiphand${exeSuffix}`);
  process.stdout.write('smoke: whiphand\n');

  check('--version prints the core version', () => {
    const version = runSync([whiphand, '--version'], { stdio: ['ignore', 'pipe', 'inherit'], check: true }).stdout.trim();
    assert.match(version, /^\d+\.\d+\.\d+$/);
  });

  check('doctor reports on the runner CLIs', () => {
    // Exit code is 1 when a runner is missing, which is a valid outcome here;
    // the assertion is that it ran and reported rather than crashed.
    const { stdout } = runSync([whiphand, 'doctor'], { stdio: ['ignore', 'pipe', 'inherit'] });
    assert.match(stdout, /claude/);
  });

  check('run --dry-run resolves a workflow end to end', () => {
    // A temp workspace, so the smoke test never leaves a run directory behind
    // in the repo. `run` is also the token a broken argv path would eat.
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'whiphand-smoke-'));
    try {
      const workflow = path.join(workdir, 'smoke.yaml');
      fs.copyFileSync(path.join(repoRoot, 'scripts/package/fixtures/smoke.yaml'), workflow);
      const { stdout } = runSync([whiphand, 'run', workflow, '--dry-run', '--input', 'subject=packaging'], {
        stdio: ['ignore', 'pipe', 'inherit'], cwd: workdir, check: true,
      });
      assert.match(stdout, /step think/, 'the agent step was not resolved');
      assert.match(stdout, /Consider packaging/, 'inputs were not interpolated');
      assert.match(stdout, /step check/, 'the command step was not resolved');
      assert.match(stdout, /run complete/);
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  // Windows only: the packaged build must be able to contain a real run. Without
  // its embedded guard (or a POSIX shell to run the command in) this exits 1.
  if (process.platform === 'win32') {
    check('a real command run starts under the embedded process guard', () => {
      const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'whiphand-smoke-run-'));
      try {
        const workflow = path.join(workdir, 'smoke-command.yaml');
        fs.copyFileSync(path.join(repoRoot, 'scripts/package/fixtures/smoke-command.yaml'), workflow);
        const { stdout } = runSync([whiphand, 'run', workflow], { stdio: ['ignore', 'pipe', 'inherit'], cwd: workdir, check: true });
        assert.match(stdout, /run complete/);
      } finally {
        fs.rmSync(workdir, { recursive: true, force: true });
      }
    });
  }
}

/** One request in, one response out. */
function request(binary, message, env, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawnRunner([binary], { stdio: ['pipe', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`sidecar did not answer within ${timeoutMs}ms; stderr: ${stderr}`));
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk;
      const line = stdout.split('\n').find(l => l.trim());
      if (!line) return;
      clearTimeout(timer);
      child.kill('SIGTERM');
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(new Error(`sidecar wrote a non-JSON line: ${line}`));
      }
    });
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', reject);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

/**
 * Streams NDJSON lines from `child.stdout` to `onMessage` as they arrive,
 * one parsed object per line — unlike `request()`, this keeps listening past
 * the first line, since a `startRun` response is followed by a stream of
 * notifications on the same stdout.
 */
function streamNdjson(child, onMessage) {
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
 * `child.kill()` terminates one process, never the tree below it. The sidecar
 * spawns a pty, whose shell and ConPTY helpers outlive it — and any of them
 * still running holds the run's workdir open, because a live process's cwd
 * cannot be removed on Windows. `taskkill /T` takes the whole tree, and
 * waiting for `close` means those handles are gone before anything tries to
 * delete underneath them.
 */
function terminate(child) {
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
function discard(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (error) {
    process.stdout.write(`  note      left ${dir} behind (${error.code})\n`);
  }
}

/**
 * Runs `scripts/package/fixtures/interactive-smoke.yaml`'s one interactive
 * step for real, through the packaged agent's own NDJSON protocol, and waits
 * for either `ptyStarted` (resolveNodePty() succeeded and node-pty opened a
 * real pty) or a `run:error` whiphandEvent (it threw — e.g. the MODULE_NOT_FOUND
 * this test exists to catch). Doesn't wait for the run to finish: once the
 * pty either starts or fails to, the question this test asks is answered.
 */
async function smokeAgentInteractivePty(resourceDir) {
  const agent = path.join(distDir, `whiphand-agent${exeSuffix}`);
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'whiphand-smoke-pty-'));
  const workflow = path.join(workdir, 'interactive-smoke.yaml');
  fs.copyFileSync(path.join(repoRoot, 'scripts/package/fixtures/interactive-smoke.yaml'), workflow);

  const env = {
    ...process.env,
    WHIPHAND_NODE_PTY_DIR: resourceDir,
    WHIPHAND_REMOTE_CONFIG_FILE: ISOLATED_REMOTE_CONFIG,
    PATH: `${FIXTURE_BIN}${path.delimiter}${process.env.PATH ?? ''}`,
  };

  const child = spawnRunner([agent], { stdio: ['pipe', 'pipe', 'pipe'], env });
  let stderr = '';
  child.stderr.on('data', chunk => (stderr += chunk));

  try {
    const outcome = await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no ptyStarted/run:error within 20000ms; stderr: ${stderr}`));
      }, 20_000);
      streamNdjson(child, message => {
        const event = message.params?.event;
        if (message.method === 'ptyStarted') {
          clearTimeout(timer);
          resolvePromise({ ok: true });
        } else if (message.method === 'whiphandEvent' && event?.type === 'run:error') {
          clearTimeout(timer);
          resolvePromise({ ok: false, message: event.message });
        }
      });
      child.on('error', reject);
      child.stdin.write(`${JSON.stringify({ id: 1, method: 'startRun', params: { workdir, workflow } })}\n`);
    });
    check('interactive step opens a real pty via the assembled node-pty resource tree', () => {
      assert.ok(outcome.ok, `agent reported run:error instead of starting the pty: ${outcome.message}`);
    });
  } finally {
    await terminate(child);
    discard(workdir);
  }
}

export async function smokeAgent() {
  const agent = path.join(distDir, `whiphand-agent${exeSuffix}`);
  process.stdout.write('smoke: whiphand-agent\n');

  // node-pty is external to the bundle (agent.mjs), so the sidecar needs to
  // be told where to find it even for this smoke test, which runs the binary
  // directly rather than through the desktop bundle's resourceDir() hand-off.
  const env = {
    ...process.env,
    WHIPHAND_NODE_PTY_DIR: path.join(repoRoot, 'node_modules/node-pty'),
    WHIPHAND_REMOTE_CONFIG_FILE: ISOLATED_REMOTE_CONFIG,
  };

  const response = await request(agent, { id: 1, method: 'hello', params: { protocolVersion: 1 } }, env);
  check('hello answers over stdio', () => {
    assert.equal(response.id, 1);
    assert.equal(response.result?.protocolVersion, 1);
    assert.match(String(response.result?.version), /^\d+\.\d+\.\d+$/);
  });

  // Unlike `hello`, which touches nothing in native.ts, this points
  // WHIPHAND_NODE_PTY_DIR at the *assembled resource tree* rather than
  // node_modules/node-pty — the layout an installed build actually has.
  // Into a throwaway directory, not the bundle's own: the pty opened below
  // leaves ConPTY helpers holding `conpty.dll` and `OpenConsole.exe` open, and
  // prepareDesktopBuild's assembly of the real resource dir right after this
  // would then fail its rmSync with EPERM.
  const resourceDir = assembleNodePtyResource(
    process.platform, fs.mkdtempSync(path.join(os.tmpdir(), 'whiphand-smoke-node-pty-')),
  );
  await smokeAgentInteractivePty(resourceDir);
}

if (import.meta.filename === process.argv[1]) {
  smokeCli();
  await smokeAgent();
}
