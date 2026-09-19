import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromPosix, withStubBin } from '@whiphand/test-support';
import { ContainerError, GUARD_FILE_NAME, PosixContainer, createContainer, locateGuard } from './container.ts';

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX process groups' : false };

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/** A `sh -c` that starts a grandchild, records its pid, and waits — the shape of a command step. */
function shellWithGrandchild(container: PosixContainer, dir: string): { pidFile: string; child: ReturnType<typeof spawn> } {
  const pidFile = join(dir, 'gc.pid');
  const child = spawn('/bin/sh', ['-c', `sleep 100 & echo $! > '${pidFile}'; wait`], {
    stdio: 'ignore', ...container.spawnOptions,
  });
  container.adopt(child);
  return { pidFile, child };
}

test('POSIX: killAll ends a grandchild that signalling the shell alone would have left running', posixOnly, async () => {
  const container = new PosixContainer(500);
  const dir = mkdtempSync(join(tmpdir(), 'wh-container-'));
  const { pidFile } = shellWithGrandchild(container, dir);
  await until(() => { try { return readFileSync(pidFile, 'utf8').trim() !== ''; } catch { return false; } });
  const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(alive(grandchild));
  await container.killAll();
  await until(() => !alive(grandchild));
});

test('POSIX: a grandchild that outlives its exited parent is still killed at dispose', posixOnly, async () => {
  const container = new PosixContainer(500);
  const dir = mkdtempSync(join(tmpdir(), 'wh-container-'));
  const pidFile = join(dir, 'gc.pid');
  // The shell exits at once, leaving `sleep` behind: a watcher started by one step.
  const child = spawn('/bin/sh', ['-c', `sleep 100 >/dev/null 2>&1 & echo $! > '${pidFile}'`], { stdio: 'ignore', ...container.spawnOptions });
  container.adopt(child);
  await new Promise(resolve => child.once('exit', resolve));
  const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(alive(grandchild), 'left running past its parent — the run is not over yet');
  await container.dispose();
  await until(() => !alive(grandchild));
});

test('POSIX: escalates to SIGKILL for a group that ignores SIGTERM', posixOnly, async () => {
  const container = new PosixContainer(150);
  const child = spawn('/bin/sh', ['-c', 'trap "" TERM; while :; do sleep 1; done'], { stdio: 'ignore', ...container.spawnOptions });
  container.adopt(child);
  await new Promise(resolve => setTimeout(resolve, 100));
  const started = Date.now();
  await container.killAll();
  assert.ok(Date.now() - started >= 100, 'waited out the grace period');
  await until(() => child.exitCode !== null || child.signalCode !== null);
  assert.equal(child.signalCode, 'SIGKILL');
});

test('POSIX: a child adopted without a group is signalled by pid', posixOnly, async () => {
  const container = new PosixContainer(500);
  const child = spawn('/bin/sh', ['-c', 'sleep 100'], { stdio: 'ignore' });
  container.adopt(child, { group: false });
  await container.killAll();
  await until(() => child.exitCode !== null || child.signalCode !== null);
});

test('POSIX: concurrent killAll calls both resolve only once the tree is gone', posixOnly, async () => {
  const container = new PosixContainer(500);
  const dir = mkdtempSync(join(tmpdir(), 'wh-container-'));
  const { pidFile } = shellWithGrandchild(container, dir);
  await until(() => { try { return readFileSync(pidFile, 'utf8').trim() !== ''; } catch { return false; } });
  const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
  const first = container.killAll();
  const second = container.killAll();
  await second;
  assert.ok(!alive(grandchild), 'the second call does not return early while the first is still killing');
  await first;
});

test('POSIX: a child adopted after dispose is killed immediately', posixOnly, async () => {
  const container = new PosixContainer(200);
  await container.dispose();
  const child = spawn('/bin/sh', ['-c', 'sleep 100'], { stdio: 'ignore', ...container.spawnOptions });
  container.adopt(child);
  await until(() => child.exitCode !== null || child.signalCode !== null);
});

test('createContainer hands POSIX a process-group container', async () => {
  const container = await createContainer({ platform: 'linux' });
  assert.ok(container instanceof PosixContainer);
  assert.deepEqual(container.spawnOptions, { detached: true });
  assert.equal((container as { degraded?: string }).degraded, undefined);
});

test('Windows without a guard: a non-packaged run proceeds and says containment is off', async () => {
  const container = await createContainer({ platform: 'win32', packaged: false, guard: null });
  assert.match(container.degraded ?? '', /process guard \(whiphand-job\.exe\) was not found/);
  await container.killAll();
  await container.dispose();
});

test('Windows without a guard: a packaged build refuses — safety-relevant, so it fails rather than warns', async () => {
  await assert.rejects(() => createContainer({ platform: 'win32', packaged: true, guard: null }), (error: Error) => {
    assert.ok(error instanceof ContainerError);
    assert.match(error.message, /cannot contain the run's processes/);
    return true;
  });
});

/**
 * A stand-in guard speaking the real protocol, so the parent's half of it is
 * exercised anywhere — minted by test-support in the shape the platform
 * launches (a `#!/bin/sh` script; a `.cmd` in npm shim shape on Windows), its
 * behaviour written once, in JS. Runs on every leg.
 */
function fakeGuardScript(behaviour: 'ok' | 'silent', log: string): string {
  return `const { appendFileSync } = require('node:fs');
if (${JSON.stringify(behaviour)} === 'ok') process.stdout.write('ready\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  appendFileSync(${JSON.stringify(log)}, line + '\\n');
  if (line.startsWith('assign ')) process.stdout.write('ok ' + line.slice(7) + '\\n');
  if (line === 'kill') process.stdout.write('killed\\n');
}).on('close', () => { appendFileSync(${JSON.stringify(log)}, 'EOF\\n'); process.exit(0); });
setInterval(() => {}, 1000);
`;
}

test('Windows guard protocol: ready, assign <pid>, kill, then EOF on dispose', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'wh-guard-log-')), 'log');
  await withStubBin('fake-guard', fakeGuardScript('ok', log), async stub => {
    const container = await createContainer({
      platform: 'win32', packaged: true, guard: { path: stub.file, source: 'env' }, guardTimeoutMs: 8000,
    });
    assert.equal((container as { degraded?: string }).degraded, undefined);
    container.adopt({ pid: 4242 });
    await container.killAll();
    await container.dispose();
    await until(() => existsSync(log) && readFileSync(log, 'utf8').endsWith('EOF\n'), 8000);
    assert.equal(readFileSync(log, 'utf8'), 'assign 4242\nkill\nEOF\n');
  });
});

test('Windows guard that never becomes ready: packaged refuses, non-packaged degrades', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'wh-guard-log-')), 'log');
  await withStubBin('fake-guard', fakeGuardScript('silent', log), async stub => {
    await assert.rejects(
      () => createContainer({ platform: 'win32', packaged: true, guard: { path: stub.file, source: 'env' }, guardTimeoutMs: 400 }),
      /could not create its job/,
    );
    const container = await createContainer({
      platform: 'win32', packaged: false, guard: { path: stub.file, source: 'env' }, guardTimeoutMs: 400,
    });
    assert.match(container.degraded ?? '', /could not create its job/);
  });
});

test('locateGuard: WHIPHAND_JOB_GUARD wins, then a binary beside the executable, then the dev build', () => {
  const present = new Set<string>();
  const exists = (p: string): boolean => present.has(p);
  const none = (): undefined => undefined;
  assert.equal(locateGuard({ env: {}, execPath: '/app/whiphand', exists, seaAsset: none }), null);

  const resource = fromPosix(`/app/resources/${GUARD_FILE_NAME}`);
  present.add(resource);
  assert.deepEqual(locateGuard({ env: {}, execPath: '/app/whiphand', exists, seaAsset: none }),
    { path: resource, source: 'resource' });

  present.add('/custom/guard.exe');
  assert.deepEqual(locateGuard({ env: { WHIPHAND_JOB_GUARD: '/custom/guard.exe' }, execPath: '/app/whiphand', exists, seaAsset: none }),
    { path: '/custom/guard.exe', source: 'env' });
  // An override that points nowhere is a failure to find, not a silent fall-through to another binary.
  assert.equal(locateGuard({ env: { WHIPHAND_JOB_GUARD: '/nope.exe' }, execPath: '/app/whiphand', exists, seaAsset: none }), null);
});

test('locateGuard extracts an embedded SEA asset to a content-hashed path, once', () => {
  const home = mkdtempSync(join(tmpdir(), 'wh-sea-'));
  const asset = (): Uint8Array => new Uint8Array([1, 2, 3, 4]);
  const first = locateGuard({ env: { LOCALAPPDATA: home }, execPath: '/nowhere/whiphand', exists: () => false, seaAsset: asset });
  assert.equal(first?.source, 'sea-asset');
  assert.match(first!.path, /whiphand[\\/]bin[\\/]whiphand-job-[0-9a-f]{16}\.exe$/);
  assert.deepEqual([...readFileSync(first!.path)], [1, 2, 3, 4]);
  const second = locateGuard({ env: { LOCALAPPDATA: home }, execPath: '/nowhere/whiphand', exists: () => false, seaAsset: asset });
  assert.equal(second?.path, first!.path, 'content-addressed: the same bytes land on the same path');
});
