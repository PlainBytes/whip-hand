/**
 * The process container (invariant 6): nothing we spawn outlives the run.
 *
 * One tier, per run, owned by the *frontend* — the agent creates one when it
 * starts a job and disposes it when the job settles; the CLI creates one per
 * `whiphand run`. Core's run plumbing learns nothing about it: cancel, timeout,
 * lease loss and run end are all an abort the frontend already handles, and the
 * frontend answers by calling `killAll()`. That is the single enforcement point.
 * (Out-of-run probes — doctor, model listing, `git` — are short-lived direct
 * children with timeouts; on Windows libuv's process-global job already kills
 * direct children when node dies, and on POSIX a process-level group would add
 * nothing in the crash case.)
 *
 * Two backends:
 *
 *  - POSIX: each child is spawned `detached`, i.e. a process-group leader, and
 *    killing is `kill(-pgid)`. That reaches the real `node`/`npm`/test runner
 *    behind a `sh -c`, which signalling only the shell did not.
 *  - Windows: a Job Object per run with kill-on-close — which has no Node API,
 *    so it lives in a small helper, `whiphand-job.exe` (crates/job-guard). The
 *    guard puts *itself* in a job with breakaway off, so it is the immediate
 *    job of everything assigned to it and the breakaway walk up libuv's own job
 *    stops there. When the parent dies by any means the guard's parent-handle
 *    wait fires, the job closes, and every member dies with it.
 *
 * Known race, accepted: a child is assigned right after CreateProcess returns,
 * so a `sh -c` that forks inside that window can leave a grandchild outside the
 * job. If it is ever observed the fix is for the guard to spawn command-step
 * shells itself; it is not built up front.
 */
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnRunner } from './exec.ts';

export const DEFAULT_KILL_GRACE_MS = 5000;
export const GUARD_FILE_NAME = 'whiphand-job.exe';
/** How long the guard has to say it is ready, or acknowledge a kill. */
const GUARD_TIMEOUT_MS = 5000;

export class ContainerError extends Error {
  constructor(message: string) { super(message); this.name = 'ContainerError'; }
}

/** What a container can adopt: a `ChildProcess`, or anything with a pid and an exit hook (a node-pty session). */
export interface Adoptable {
  pid?: number;
  once?(event: 'exit', listener: () => void): unknown;
}

export interface AdoptOptions {
  /**
   * Whether the child leads its own process group (POSIX). True for a child
   * spawned with the container's `spawnOptions` and for a pty session, which is
   * a session leader by construction. False for an interactive child that
   * inherits the terminal: `detached` would `setsid` it away from the tty, so it
   * stays in the foreground group and is signalled by pid instead — relying on
   * Ctrl-C reaching the whole group, as the spec accepts.
   */
  group?: boolean;
}

export interface Container {
  /** Extra spawn options every child of this container needs (POSIX: `detached`). */
  readonly spawnOptions: { detached?: boolean };
  /** Puts a freshly spawned child (and, through it, whatever it starts) under the container. */
  adopt(child: Adoptable, opts?: AdoptOptions): void;
  /** Ends every process in the container. Resolves once they are gone or the grace period has run out and they were killed outright. */
  killAll(): Promise<void>;
  /** `killAll`, then refuse further children. Idempotent. */
  dispose(): Promise<void>;
  /**
   * Set when this container cannot actually contain: a non-packaged run
   * (source, dev, tests) on Windows with no guard binary found. The frontend
   * records it as a `process-containment` degradation. A *packaged* build in
   * that position does not get a container at all — `createContainer` throws.
   */
  readonly degraded?: string;
}

// ---------------------------------------------------------------------------
// POSIX
// ---------------------------------------------------------------------------

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    // EPERM means the group exists but is not ours to signal — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Already gone.
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export class PosixContainer implements Container {
  readonly spawnOptions = { detached: true };
  private readonly groups = new Set<number>();
  /** Children that could not be given a group of their own (see AdoptOptions.group), signalled by pid. */
  private readonly loners = new Set<number>();
  private disposed = false;
  /** Kills are serialized, so a second `killAll` (run end, after a cancel) waits for the first to finish rather than returning early. */
  private killing: Promise<void> = Promise.resolve();

  private readonly graceMs: number;

  constructor(graceMs: number = DEFAULT_KILL_GRACE_MS) {
    this.graceMs = graceMs;
  }

  adopt(child: Adoptable, opts: AdoptOptions = {}): void {
    const pid = child.pid;
    if (pid === undefined) return; // the spawn failed; there is nothing to contain
    const group = opts.group ?? true;
    if (this.disposed) {
      if (group) signalGroup(pid, 'SIGKILL'); else signalPid(pid, 'SIGKILL');
      return;
    }
    if (!group) {
      this.loners.add(pid);
      child.once?.('exit', () => { this.loners.delete(pid); });
      return;
    }
    this.groups.add(pid);
    // A leader that has exited and left nothing behind is dropped, so a later
    // killAll never signals a group id the OS has since handed to someone else.
    // One that left a grandchild behind stays: that is what we are here to kill.
    child.once?.('exit', () => { if (!groupAlive(pid)) this.groups.delete(pid); });
  }

  killAll(): Promise<void> {
    const run = this.killing.then(() => this.terminate());
    this.killing = run.catch(() => {});
    return run;
  }

  private async terminate(): Promise<void> {
    const targets = [...this.groups].filter(groupAlive);
    const singles = [...this.loners].filter(pidAlive);
    this.groups.clear();
    this.loners.clear();
    if (targets.length === 0 && singles.length === 0) return;
    for (const pgid of targets) signalGroup(pgid, 'SIGTERM');
    for (const pid of singles) signalPid(pid, 'SIGTERM');
    const remaining = (): boolean => targets.some(groupAlive) || singles.some(pidAlive);
    const deadline = Date.now() + this.graceMs;
    while (Date.now() < deadline && remaining()) await sleep(20);
    for (const pgid of targets) if (groupAlive(pgid)) signalGroup(pgid, 'SIGKILL');
    for (const pid of singles) if (pidAlive(pid)) signalPid(pid, 'SIGKILL');
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.killAll();
  }
}

// ---------------------------------------------------------------------------
// Windows: the guard helper
// ---------------------------------------------------------------------------

/**
 * Protocol, line-based: the parent writes `assign <pid>`, `kill`, or closes
 * stdin; the guard answers `ready` once its job exists, `ok <pid>` / `err <pid>
 * <reason>` per assign, and `killed` (or `err kill <reason>`) after a `kill`. EOF closes the job, which
 * kills every member.
 */
export class GuardContainer implements Container {
  readonly spawnOptions = {};
  private disposed = false;
  /** Whether anything was assigned since the last `kill`, so a dispose right after a cancel does not send a second one. */
  private dirty = false;
  private readonly waiters: Array<(line: string) => void> = [];
  private readonly guard: ChildProcess;
  private readonly timeoutMs: number;
  /** Why the last `kill` failed, as the guard reported it; cleared by one that succeeds. */
  lastKillError: string | undefined;

  constructor(guard: ChildProcess, timeoutMs: number = GUARD_TIMEOUT_MS) {
    this.guard = guard;
    this.timeoutMs = timeoutMs;
    guard.stdout?.setEncoding('utf8');
    const lines = createInterface({ input: guard.stdout! });
    lines.on('line', line => { this.waiters.shift()?.(line.trim()); });
    // A guard that dies takes its job with it, killing the members: the
    // containment we wanted, only earlier than asked. Nothing to do but stop
    // writing to it.
    guard.stdin?.on('error', () => {});
  }

  /** Resolves when the guard reports a line satisfying `accept`, or rejects on timeout / early exit. */
  private nextLine(accept: (line: string) => boolean): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new ContainerError('the process guard did not answer in time')), this.timeoutMs);
      timer.unref?.();
      const onLine = (line: string): void => {
        if (accept(line)) { clearTimeout(timer); resolve(line); } else this.waiters.push(onLine);
      };
      this.waiters.push(onLine);
      this.guard.once('exit', () => { clearTimeout(timer); reject(new ContainerError('the process guard exited')); });
    });
  }

  /** Waits for the guard's `ready`, so a job that could not be created is found before the first child is spawned. */
  async ready(): Promise<void> {
    await this.nextLine(line => line === 'ready');
  }

  adopt(child: Adoptable): void {
    if (child.pid === undefined) return;
    if (this.disposed) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } return; }
    this.dirty = true;
    this.guard.stdin?.write(`assign ${child.pid}\n`);
  }

  async killAll(): Promise<void> {
    if (!this.dirty || this.guard.exitCode !== null || this.guard.stdin === null || this.guard.stdin.destroyed) return;
    this.dirty = false;
    this.guard.stdin.write('kill\n');
    const answer = await this.nextLine(line => line === 'killed' || line.startsWith('err kill ')).catch(() => undefined);
    this.lastKillError = answer?.startsWith('err kill ') === true ? answer.slice('err kill '.length) : undefined;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.killAll();
    // EOF closes the job (a no-op now) and lets the guard exit.
    this.guard.stdin?.end();
    if (this.guard.exitCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, this.timeoutMs);
        timer.unref?.();
        this.guard.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
  }
}

/** A container that contains nothing — a non-packaged Windows run with no guard binary. */
class UncontainedContainer implements Container {
  readonly spawnOptions = {};
  readonly degraded: string;
  constructor(degraded: string) {
    this.degraded = degraded;
  }
  adopt(): void {}
  async killAll(): Promise<void> {}
  async dispose(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Finding the guard
// ---------------------------------------------------------------------------

/** True in a packaged build (SEA) — where the guard asset is expected to exist, so its absence is a failure, not a degradation. */
export function isPackagedBuild(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.WHIPHAND_PACKAGED === '1') return true;
  try {
    // node:sea is only meaningful inside a single-executable application.
    const sea = process.getBuiltinModule?.('node:sea') as { isSea?: () => boolean } | undefined;
    return sea?.isSea?.() === true;
  } catch {
    return false;
  }
}

export interface GuardLocation { path: string; source: 'env' | 'resource' | 'sea-asset' | 'dev-build' }

/**
 * Where the guard binary is, in the order the distributions put it:
 * `WHIPHAND_JOB_GUARD`; beside the executable (the Tauri resource, and the
 * agent sidecar's neighbour); extracted from the CLI's SEA asset to a
 * content-hashed path under `%LOCALAPPDATA%` on first use; the `cargo build`
 * output in a source checkout.
 */
export function locateGuard(opts: {
  env?: NodeJS.ProcessEnv; execPath?: string; exists?: (p: string) => boolean; seaAsset?: () => Uint8Array | undefined;
} = {}): GuardLocation | null {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  if (env.WHIPHAND_JOB_GUARD !== undefined && env.WHIPHAND_JOB_GUARD !== '') {
    return exists(env.WHIPHAND_JOB_GUARD) ? { path: env.WHIPHAND_JOB_GUARD, source: 'env' } : null;
  }
  const execDir = dirname(opts.execPath ?? process.execPath);
  for (const dir of [execDir, join(execDir, 'resources'), join(execDir, '..', 'resources')]) {
    const candidate = join(dir, GUARD_FILE_NAME);
    if (exists(candidate)) return { path: candidate, source: 'resource' };
  }
  const asset = (opts.seaAsset ?? readSeaAsset)();
  if (asset !== undefined) {
    const extracted = extractAsset(asset, env);
    if (extracted !== null) return { path: extracted, source: 'sea-asset' };
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'crates', 'job-guard', 'target');
  for (const profile of ['release', 'debug']) {
    const candidate = join(root, profile, GUARD_FILE_NAME);
    if (exists(candidate)) return { path: candidate, source: 'dev-build' };
  }
  return null;
}

function readSeaAsset(): Uint8Array | undefined {
  try {
    const sea = process.getBuiltinModule?.('node:sea') as
      { isSea?: () => boolean; getRawAsset?: (key: string) => ArrayBuffer } | undefined;
    if (sea?.isSea?.() !== true || sea.getRawAsset === undefined) return undefined;
    return new Uint8Array(sea.getRawAsset(GUARD_FILE_NAME));
  } catch {
    return undefined; // no such asset in this build
  }
}

/** Writes the embedded guard once, to a content-hashed name, so two versions never share a file and a running guard is never overwritten. */
function extractAsset(bytes: Uint8Array, env: NodeJS.ProcessEnv): string | null {
  const base = env.LOCALAPPDATA ?? env.XDG_DATA_HOME ?? (env.HOME === undefined ? undefined : join(env.HOME, '.local', 'share'));
  if (base === undefined) return null;
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const target = join(base, 'whiphand', 'bin', `whiphand-job-${hash}.exe`);
  try {
    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true });
      // A unique temp + rename would be the durable form; extraction is
      // idempotent and content-addressed, so a torn write only costs a retry
      // and `wx` refuses to clobber a file another process is mid-writing.
      writeFileSync(target, bytes, { flag: 'wx', mode: 0o755 });
    }
    return target;
  } catch {
    return existsSync(target) ? target : null;
  }
}

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

export interface CreateContainerOpts {
  platform?: NodeJS.Platform;
  packaged?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Override guard discovery. `null` means none found. */
  guard?: GuardLocation | null;
  killGraceMs?: number;
  guardTimeoutMs?: number;
}

/**
 * One container for one run. On Windows a guard that cannot be found, started
 * or made to create its job is **safety-relevant in a packaged build** — the
 * run refuses to start (`ContainerError`) — and a `process-containment`
 * degradation everywhere else.
 */
export async function createContainer(opts: CreateContainerOpts = {}): Promise<Container> {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return new PosixContainer(opts.killGraceMs);

  const env = opts.env ?? process.env;
  const packaged = opts.packaged ?? isPackagedBuild(env);
  const refuse = (reason: string): Container => {
    if (packaged) throw new ContainerError(`cannot contain the run's processes: ${reason}`);
    return new UncontainedContainer(`${reason}; child processes may outlive a crash`);
  };

  const location = opts.guard === undefined ? locateGuard({ env }) : opts.guard;
  if (location === null) return refuse(`the process guard (${GUARD_FILE_NAME}) was not found`);
  let guard: ChildProcess;
  try {
    guard = spawnRunner([location.path, String(process.pid)], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  } catch (error) {
    return refuse(`the process guard could not be started: ${(error as Error).message}`);
  }
  const container = new GuardContainer(guard, opts.guardTimeoutMs);
  try {
    guard.once('error', () => {});
    await container.ready();
  } catch (error) {
    try { guard.kill(); } catch { /* gone */ }
    return refuse(`the process guard could not create its job: ${(error as Error).message}`);
  }
  return container;
}
