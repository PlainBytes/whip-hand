/**
 * The run store across implementations (Phase 2a of docs/migration.md).
 * Until Phase 3 the desktop's TS sidecar and the Rust CLI share one
 * `.whiphand/runs/`, so each must judge the other's live runs exactly as it
 * judges its own: the same pid scope (or a dead owner goes unnoticed until
 * its lease runs out), the same owner-exited repair, and a fence either side
 * writes must stop the other side's journal.
 *
 * The byte-level behaviour is the core parity corpus (store-runs,
 * store-journal); this file is what only two real processes can show.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../packages/core/src/config.ts';
import { currentPidScope, listRuns } from '../packages/core/src/engine/manifest.ts';
import { writeFence } from '../packages/core/src/engine/run-fence.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const PROBE = path.join(REPO, 'target', 'debug', 'examples', `store_probe${process.platform === 'win32' ? '.exe' : ''}`);
const HOLD = fileURLToPath(new URL('./store-hold.ts', import.meta.url));
const WAIT_MS = Number(process.env.WHIPHAND_PARITY_WAIT_MS ?? 20_000);

before(() => {
  // Incremental: a no-op when the example is already built.
  execFileSync('cargo', ['build', '--quiet', '-p', 'whiphand-core', '--example', 'store_probe'], {
    cwd: REPO, stdio: 'inherit',
  });
});

const workspaces: string[] = [];

after(() => {
  for (const ws of workspaces) rmSync(ws, { recursive: true, force: true });
});

function workspace(): string {
  const ws = mkdtempSync(path.join(tmpdir(), 'whiphand-cross-'));
  workspaces.push(ws);
  return ws;
}

/** Resolves with the first stdout line matching `prefix`, or rejects after WAIT_MS. */
function lineFrom(child: ChildProcessWithoutNullStreams, prefix: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no '${prefix}' line within ${WAIT_MS} ms`)), WAIT_MS);
    const rl = createInterface({ input: child.stdout });
    rl.on('line', line => {
      if (!line.startsWith(prefix)) return;
      clearTimeout(timer);
      rl.close();
      resolve(line.slice(prefix.length));
    });
  });
}

function rustHold(ws: string, runId: string, beatMs: number): ChildProcessWithoutNullStreams {
  return spawn(PROBE, ['hold', ws, runId, String(beatMs)]);
}

function tsHold(ws: string, runId: string, beatMs: number): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [HOLD, ws, runId, String(beatMs)]);
}

async function killAndWait(child: ChildProcessWithoutNullStreams): Promise<void> {
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
}

function rustList(ws: string): string[] {
  return execFileSync(PROBE, ['list', ws], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
}

async function tsList(ws: string): Promise<string[]> {
  return (await listRuns(ws, DEFAULT_CONFIG))
    .map(r => `${r.runId} ${r.status} ${('interruptedReason' in r && r.interruptedReason) || '-'}`);
}

test('both implementations name the same pid scope', () => {
  assert.equal(execFileSync(PROBE, ['scope'], { encoding: 'utf8' }).trim(), currentPidScope());
});

test('a TS reader sees a live Rust owner as running, and repairs it once the owner is killed', async () => {
  const ws = workspace();
  const child = rustHold(ws, 'r-rust', 60_000);
  const lease = await lineFrom(child, 'ready ');
  assert.deepEqual(await tsList(ws), ['r-rust running -']);
  await killAndWait(child);
  assert.deepEqual(await tsList(ws), ['r-rust interrupted owner-exited']);
  const fence = JSON.parse(readFileSync(path.join(ws, '.whiphand', 'runs', 'r-rust', '.fenced'), 'utf8'));
  assert.deepEqual(fence, { leaseId: lease, reason: 'owner-exited' });
});

test('a Rust reader sees a live TS owner as running, and repairs it once the owner is killed', async () => {
  const ws = workspace();
  const child = tsHold(ws, 'r-ts', 60_000);
  const lease = await lineFrom(child, 'ready ');
  assert.deepEqual(rustList(ws), ['r-ts running -']);
  await killAndWait(child);
  assert.deepEqual(rustList(ws), ['r-ts interrupted owner-exited']);
  const fence = JSON.parse(readFileSync(path.join(ws, '.whiphand', 'runs', 'r-ts', '.fenced'), 'utf8'));
  assert.deepEqual(fence, { leaseId: lease, reason: 'owner-exited' });
});

test("a fence a TS reader writes stops a Rust owner's journal", async () => {
  const ws = workspace();
  const child = rustHold(ws, 'r-rust', 100);
  const lease = await lineFrom(child, 'ready ');
  const lost = lineFrom(child, 'lost ');
  await writeFence(path.join(ws, '.whiphand', 'runs', 'r-rust'), { leaseId: lease, reason: 'lease-expired' });
  assert.equal(await lost, "lease lost (host suspended?): run.json says 'interrupted'");
  await new Promise(resolve => child.once('exit', resolve));
});

test("a fence a Rust reader writes stops a TS owner's journal", async () => {
  const ws = workspace();
  const child = tsHold(ws, 'r-ts', 100);
  const lease = await lineFrom(child, 'ready ');
  const lost = lineFrom(child, 'lost ');
  const runDir = path.join(ws, '.whiphand', 'runs', 'r-ts');
  execFileSync(PROBE, ['fence', runDir, lease]);
  assert.ok(existsSync(path.join(runDir, '.fenced')));
  assert.equal(await lost, "lease lost (host suspended?): run.json says 'interrupted'");
  await new Promise(resolve => child.once('exit', resolve));
});
