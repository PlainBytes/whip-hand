/**
 * startPty: spawns an interactive PTY for a step's SpawnSpec. Data crossing
 * this boundary is base64-encoded in both directions to travel safely as JSON over the NDJSON wire.
 */
import { createBelScanner } from './bel.ts';
import { resolveNodePty } from './native.ts';
import { planLaunch, type SpawnSpec } from '@whiphand/core';

export interface PtyHandle {
  /** `base64` is base64-decoded to raw text/bytes before being written to the pty. */
  write(base64: string): void;
  resize(cols: number, rows: number): void;
  /**
   * Defaults to node-pty's own default signal; session-end escalates SIGTERM
   * then SIGKILL. Advisory only: ConPTY has no signals, so on Windows the
   * signal is dropped, the pty is closed outright, and any further kill is
   * ignored — see startPty for why a second one there is not harmless.
   */
  kill(signal?: string): void;
}

export interface StartPtyOpts {
  cols: number;
  rows: number;
  /** Called with each chunk of pty output, base64-encoded. */
  onData(base64: string): void;
  /** Called exactly once, when the underlying process exits. */
  onExit(exitCode: number): void;
  /**
   * Called once per chunk that contained a standalone BEL — the runner beeping
   * for attention. Scanned here because this is the only point where the raw
   * bytes exist before base64; doing it downstream would decode twice.
   */
  onBell?(): void;
  signal?: AbortSignal;
}

export function startPty(spec: SpawnSpec, opts: StartPtyOpts): PtyHandle {
  // node-pty's Windows agent hands the command straight to CreateProcess,
  // which resolves .exe/.com on PATH but not .cmd/.bat — so a `claude`/
  // `copilot` npm shim needs the same treatment headless spawns get, and
  // `planLaunch` is that one decision (see exec.ts). Usually it reads through
  // the shim to the `node <entry point>` it wraps, which needs nothing special
  // here. Only when it cannot, and falls back to a cmd.exe wrapper, does the
  // result have to go through node-pty's command-line *string* mode: node-pty
  // applies its own MSVCRT quoting to array elements and would escape ours a
  // second time.
  const plan = planLaunch(spec.argv);
  const args = plan.invocation === null ? plan.args : plan.invocation.commandLine;
  const child = resolveNodePty().spawn(plan.file, args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    cols: opts.cols,
    rows: opts.rows,
    name: 'xterm-256color',
  });

  /**
   * Every route to node-pty's kill goes through here, because on Windows the
   * second one is not a no-op: WindowsPtyAgent.kill() runs a native kill on
   * the pty handle and disposes the conout worker, so calling it again works
   * on a handle it already freed and takes the process down with no error to
   * catch. session-end escalates SIGTERM then SIGKILL, and an abort can land
   * beside either, so two kills is the normal case rather than the odd one.
   *
   * Only Windows collapses them. On POSIX the escalation is the whole point —
   * SIGTERM asks, SIGKILL insists — and swallowing the second would leave a
   * process that ignored the first running forever.
   */
  let killedOnWindows = false;
  const killPty = (signal?: string): void => {
    if (process.platform !== 'win32') {
      child.kill(signal);
      return;
    }
    // No signals to deliver on Windows, so the first bare kill is already the
    // forceful one and there is nothing for a second to add.
    if (killedOnWindows) return;
    killedOnWindows = true;
    child.kill();
  };

  const onAbort = (): void => killPty();
  opts.signal?.addEventListener('abort', onAbort);

  const bells = createBelScanner();
  child.onData(data => {
    const rang = bells.scan(data) > 0;
    opts.onData(Buffer.from(data, 'utf8').toString('base64'));
    if (rang) opts.onBell?.();
  });
  child.onExit(({ exitCode }) => {
    opts.signal?.removeEventListener('abort', onAbort);
    opts.onExit(exitCode);
  });

  return {
    write(base64: string): void {
      child.write(Buffer.from(base64, 'base64').toString('utf8'));
    },
    resize(cols: number, rows: number): void {
      child.resize(cols, rows);
    },
    kill(signal?: string): void {
      // node-pty's WindowsTerminal throws outright on *any* signal — there is
      // nothing to deliver one to — while a bare kill() closes the pty and
      // kills its agent, which is what session-end's SIGTERM-then-SIGKILL
      // escalation actually wants. Forwarding the signal there turned every
      // graceful session end on Windows into a throw.
      killPty(signal);
    },
  };
}
