/**
 * The empirical half of container.ts on Windows: a *real* `whiphand-job.exe`, a
 * real job object, and the property the whole design exists for — kill the
 * parent by any means and no descendant survives. Nothing here can be reasoned
 * from Linux, so it runs on CI's Windows leg (which builds the guard first) and
 * is inert everywhere else. The one test of its kind: it is the counterpart to
 * container.test.ts's POSIX process-group tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnRunner } from './exec.ts';
import { GuardContainer, locateGuard } from './container.ts';

const windowsOnly = { skip: process.platform !== 'win32' && 'Windows only: needs the real whiphand-job.exe and Job Objects' };

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

test('killing the parent from outside leaves no survivors, grandchildren included', windowsOnly, async () => {
  const guard = locateGuard();
  assert.ok(guard, 'the Windows leg builds the guard first (cargo build --release -p whiphand-job) or sets WHIPHAND_JOB_GUARD');

  // A stand-in for the agent: creates the run's container, starts `cmd /c` with a
  // long-lived grandchild under it (a command step's real shape), reports the pids.
  const dir = mkdtempSync(path.join(tmpdir(), 'whiphand-guard-'));
  const helper = path.join(dir, 'agent.mjs');
  writeFileSync(helper, `
    import { createContainer } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, 'container.ts')).href)};
    import { spawnRunner } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, 'exec.ts')).href)};
    const container = await createContainer({ packaged: true, guard: ${JSON.stringify(guard)} });
    const child = spawnRunner([process.execPath, '-e',
      "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });" +
      "console.log('grandchild ' + c.pid); setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'inherit'] }, { container });
    console.log('child ' + child.pid);
    child.stdout.on('data', d => process.stdout.write(d));
    setInterval(() => {}, 1000);
  `);

  const agent = spawnRunner([process.execPath, helper], { stdio: ['ignore', 'pipe', 'inherit'] });
  const pids = new Map<string, number>();
  agent.stdout!.setEncoding('utf8');
  agent.stdout!.on('data', (chunk: string) => {
    for (const m of chunk.matchAll(/(child|grandchild) (\d+)/g)) pids.set(m[1], Number(m[2]));
  });
  await until(() => pids.has('child') && pids.has('grandchild'), 30_000);
  assert.ok(alive(pids.get('grandchild')!), 'the grandchild is running before the parent dies');

  // "Task Manager": nothing of the agent's own runs at this point.
  spawnRunner(['taskkill', '/pid', String(agent.pid), '/f'], { stdio: 'ignore' });
  await until(() => !alive(pids.get('child')!) && !alive(pids.get('grandchild')!), 20_000);
});

test('cancel: killAll ends the whole tree while the guard stays usable for the next step', windowsOnly, async () => {
  const { createContainer } = await import('./container.ts');
  const container = await createContainer({ packaged: true });
  const run = (): { pid: number; grandchild: Promise<number> } => {
    const child = spawnRunner([process.execPath, '-e',
      "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });" +
      "console.log(c.pid); setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'inherit'] }, { container });
    const grandchild = new Promise<number>(resolve => child.stdout!.once('data', d => resolve(Number(String(d).trim()))));
    return { pid: child.pid!, grandchild };
  };
  const first = run();
  const grandchild = await first.grandchild;
  assert.ok(alive(grandchild));
  await container.killAll();
  assert.ok(container instanceof GuardContainer, container.degraded ?? 'the guard was found and started');
  assert.equal(container.lastKillError, undefined, 'TerminateJobObject failed (win32 error)');
  await until(() => !alive(first.pid) && !alive(grandchild), 20_000);

  // The run goes on after a step is killed (a timeout, a loop iteration): the next step is contained too.
  const second = run();
  const next = await second.grandchild;
  assert.ok(alive(next));
  await container.dispose();
  await until(() => !alive(second.pid) && !alive(next), 20_000);
});
