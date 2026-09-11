/**
 * One seam for launching a runner CLI. The CLI (tty.ts), the agent (spawn.ts)
 * and the PTY (pty.ts) all come through here, so Windows' several ways of not
 * being POSIX are dealt with once.
 *
 * On POSIX this is transparent: `resolveExecutable` hands the command back
 * unchanged, no PATH walk, and `planLaunch` spawns exactly the argv it was
 * given. Everything below is the Windows branch.
 *
 * There are two shapes a runner arrives in on Windows. A native install
 * (`claude.exe`, `copilot.exe` — what both vendors' own installers produce
 * now) needs nothing: CreateProcess launches it, libuv applies the MSVCRT
 * quoting `CommandLineToArgvW` expects, and arbitrary prompts survive. An npm
 * install is a `.cmd` shim, which Node refuses to launch directly since the
 * CVE-2024-27980 fix, and which historically meant routing through cmd.exe —
 * whose parser is a different language from MSVCRT's, and a lossy one.
 *
 * So we do not route through cmd.exe if we can avoid it. A `.cmd` shim is a
 * batch file whose entire job is to run `node <entry point> %*`; `resolveShim`
 * reads that entry point back out and spawns the same thing directly. No cmd
 * parse, so newlines, `%VAR%`, quotes and metacharacters all survive, and an
 * npm-installed runner behaves exactly like a native one. That matters
 * concretely: `interactiveGuidance` is always multi-line, and a raw newline is
 * the one thing no cmd.exe command line can carry at all.
 *
 * The cmd.exe wrapper below is the fallback for shims we cannot read — pnpm
 * and yarn write different ones, and a hand-written `.cmd` could do anything.
 * It is also the only correct answer for a command step, whose argv[0] *is*
 * cmd.exe and whose run line genuinely is a cmd command.
 *
 * What that fallback does NOT use is Node's own `shell: true`. Node builds the
 * same `cmd /d /s /c "..."` wrapper, but joins `[file, ...args]` with a plain
 * space and no quoting at all (DEP0190 warns about exactly this), so every
 * multi-word prompt arrives word-split. `cmdInvocation` is Node's construction
 * with per-argument quoting put back.
 *
 * Quoting there is applied *once*, not twice. npm's shim forwards its tail
 * with `%*`, and batch percent-expansion substitutes textually without
 * rescanning, so there is exactly one `CommandLineToArgvW` parse at the far
 * end however many `.cmd` hops intervene. Caret escaping is wrong for the
 * mirrored reason: `^&` survives one cmd parse and arrives as a bare `&` at
 * the next, and the number of parses is shim-dependent.
 *
 * Two shapes no quoting can carry through cmd.exe, which `cmdInvocation`
 * refuses rather than shipping a mangled prompt to a model:
 *
 *   - A raw newline. cmd ends its command line there, in the line reader,
 *     before quote processing happens at all.
 *   - A `"` in the same argument as one of `& | < > ^ ( )`. cmd has no notion
 *     of `\"`, so it closes its quote state early and the metacharacter lands
 *     outside quotes; MSVCRT has no notion of `^`. No encoding satisfies both.
 *
 * Reaching those refusals now takes an unreadable shim as well as Windows, but
 * when it happens, failing loudly still beats corrupting silently.
 */
import { execFile, spawn as nodeSpawn, type ChildProcess, type ExecFileOptions, type SpawnOptions } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export interface ResolvedExecutable {
  /** Absolute path when found on PATH; the original command otherwise (let spawn's own ENOENT surface). */
  file: string;
  /** True when `file` is a `.bat`/`.cmd` that can only be launched through `cmd.exe`. */
  usesShell: boolean;
}

const WINDOWS_SHELL_EXTENSIONS = new Set(['.bat', '.cmd']);

export interface ResolveExecutableOpts {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export function resolveExecutable(command: string, opts: ResolveExecutableOpts = {}): ResolvedExecutable {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return { file: command, usesShell: false };

  // An explicit path (relative or absolute) is not a PATH lookup — classify it as-is.
  if (command.includes('/') || command.includes('\\')) return classify(command);

  const env = opts.env ?? process.env;
  // `path.win32` throughout this branch, not the host's `path`: PATH is
  // `;`-delimited and joined with `\` on Windows regardless of where the
  // resolution is being *computed*, which is what lets a `platform: 'win32'`
  // test on Linux exercise the real thing.
  const dirs = (env.PATH ?? env.Path ?? '').split(path.win32.delimiter).filter(Boolean);
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasExt = exts.some(ext => command.toLowerCase().endsWith(ext.toLowerCase()));
  const candidates = hasExt ? [command] : exts.map(ext => `${command}${ext}`);

  for (const dir of dirs) {
    // NTFS/FAT are case-insensitive, so the match has to be too — a `.cmd`
    // shim on disk as `claude.CMD` still has to satisfy a `claude.cmd`
    // candidate built from PATHEXT. PATHEXT order still decides which
    // extension wins within a directory, so look up each candidate in turn
    // rather than scanning directory entries in filesystem order.
    const entries = new Map(listDir(dir).map(entry => [entry.toLowerCase(), entry]));
    for (const candidate of candidates) {
      const match = entries.get(candidate.toLowerCase());
      if (match !== undefined) return classify(path.win32.join(dir, match));
    }
  }
  return classify(command);
}

/** Only ever reached past `resolveExecutable`'s POSIX early return, so win32 rules apply. */
function classify(file: string): ResolvedExecutable {
  return { file, usesShell: WINDOWS_SHELL_EXTENSIONS.has(path.win32.extname(file).toLowerCase()) };
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** `cmd.exe`, by any path, with or without its extension. */
const CMD_SHELL_RE = /^(?:.*[\\/])?cmd(?:\.exe)?$/i;

/**
 * Wider than the classic MSVCRT trigger (space, tab, `"`, empty), because the
 * quoted form has to survive cmd's parser too: an unquoted `a&b` loses its
 * `&` to command separation long before `CommandLineToArgvW` sees it.
 */
const NEEDS_QUOTING = /[\s"&|<>^()%!]/;

/** The metacharacters cmd acts on, and so the ones that cannot share an argument with a `"`. */
const CMD_METACHARS = /[&|<>^()]/;

/** cmd.exe's own command-line ceiling, well below CreateProcess's 32767. */
const CMD_MAX_COMMAND_LINE = 8191;

/**
 * Quotes one argument so `CommandLineToArgvW` reconstructs it exactly.
 * Backslashes are only special immediately before a `"`, which is why they
 * are counted rather than escaped as they are read.
 */
export function msvcrtQuote(arg: string): string {
  if (arg.length > 0 && !NEEDS_QUOTING.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    out += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  // Trailing backslashes abut the closing quote, so they need doubling too.
  return `${out}${'\\'.repeat(backslashes * 2)}"`;
}

function excerpt(arg: string): string {
  const oneLine = arg.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}

/**
 * Refuses the argument shapes no quoting can carry through cmd.exe. See this
 * file's header for why each one is unfixable rather than merely unhandled.
 */
function assertCarryable(args: string[]): void {
  for (const arg of args) {
    if (/[\r\n]/.test(arg)) {
      throw new Error(
        'cannot pass a multi-line argument through cmd.exe on Windows: a raw newline ends '
        + `the command line before quoting applies (argument: "${excerpt(arg)}")`,
      );
    }
    if (arg.includes('"') && CMD_METACHARS.test(arg)) {
      throw new Error(
        'cannot pass an argument containing both a quote and one of & | < > ^ ( ) through '
        + `cmd.exe on Windows: no encoding satisfies both parsers (argument: "${excerpt(arg)}")`,
      );
    }
  }
}

function assertLength(commandLine: string): void {
  if (commandLine.length > CMD_MAX_COMMAND_LINE) {
    throw new Error(
      `command line is ${commandLine.length} characters, over cmd.exe's ${CMD_MAX_COMMAND_LINE}-character `
      + 'limit; it would be silently truncated',
    );
  }
}

export interface CmdInvocation {
  /** COMSPEC, unquoted — this is the CreateProcess lookup, not part of the command line. */
  file: string;
  /** COMSPEC, quoted. Under verbatim args libuv emits argv[0] as-is, so a COMSPEC containing a space needs this. */
  argv0: string;
  /** For `child_process.spawn`, with `windowsVerbatimArguments: true`. */
  args: string[];
  /** The same thing as one string, for node-pty's Windows command-line mode. */
  commandLine: string;
}

/**
 * Both shapes of one `cmd.exe /c` invocation: the array Node's spawn wants and
 * the single string node-pty's Windows mode wants. One builder so the two
 * paths cannot drift.
 *
 * `/s` is load-bearing — it makes cmd strip exactly the outer quote pair
 * instead of heuristically hunting for where the command starts. `/v:off`
 * closes the `!` failure mode outright rather than leaving it to a registry
 * setting we cannot see from here.
 */
export function cmdInvocation(
  file: string, args: string[], env: NodeJS.ProcessEnv = process.env,
): CmdInvocation {
  assertCarryable([file, ...args]);
  const comspec = env.COMSPEC ?? env.ComSpec ?? 'cmd.exe';
  const argv0 = msvcrtQuote(comspec);
  const blob = `"${[file, ...args].map(msvcrtQuote).join(' ')}"`;
  const cmdArgs = ['/v:off', '/d', '/s', '/c', blob];
  const commandLine = cmdArgs.join(' ');
  assertLength(`${argv0} ${commandLine}`);
  return { file: comspec, argv0, args: cmdArgs, commandLine };
}

/**
 * The other half of the same problem: when argv[0] already *is* cmd.exe — what
 * `commandSpec` builds for every command step on Windows — the trailing run
 * line is a cmd command, not an MSVCRT argument. Left to libuv it gets
 * backslash-escaped into something cmd does not speak (`echo "hi"` prints
 * `\"hi\"`), so it needs the same verbatim treatment, just without a second
 * layer of argument quoting. Returns null when the argv is not that shape.
 */
function cmdShellInvocation(file: string, args: string[]): CmdInvocation | null {
  const runIndex = args.length - 1;
  if (runIndex < 1 || !/^\/[ck]$/i.test(args[runIndex - 1])) return null;
  assertCarryable([args[runIndex]]);
  const argv0 = msvcrtQuote(file);
  const cmdArgs = [...args.slice(0, runIndex), `"${args[runIndex]}"`];
  const commandLine = cmdArgs.join(' ');
  assertLength(`${argv0} ${commandLine}`);
  return { file, argv0, args: cmdArgs, commandLine };
}

/**
 * A `.cmd` shim is not a program — it is a batch file whose whole job is to
 * run `node <entry point>` with the arguments it was given. Going through
 * cmd.exe to reach that is what drags in the entire quoting problem above; so
 * where the shim can be read and understood, we skip it and spawn the same
 * node invocation directly. CreateProcess then carries newlines, `%VAR%`,
 * quotes and metacharacters without complaint, and an npm-installed runner
 * behaves exactly like a natively installed `claude.exe`.
 *
 * Deliberately conservative: anything unrecognized (pnpm and yarn write
 * different shims, and a hand-written `.cmd` could do anything at all) falls
 * back to the cmd.exe wrapper. A shim we cannot read is a shim whose
 * interpreter we must not invent.
 */
const SHIM_SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

/**
 * The win32 branch computes Windows paths wherever it runs, but a
 * `platform: 'win32'` test runs on a POSIX host whose filesystem still speaks
 * `/`. Converting only at the points that actually touch the disk keeps the
 * paths we return honest — they are what Windows would spawn — while letting
 * this whole branch be exercised off Windows. A no-op on Windows, and
 * unreachable on a POSIX *production* path, which returns before ever getting
 * here.
 */
function onDisk(winPath: string): string {
  return process.platform === 'win32' ? winPath : winPath.replace(/\\/g, '/');
}

/** `"%dp0%\..."` as npm writes it, `"%~dp0\..."` as pnpm and yarn do. */
const SHIM_PATH_RE = /"%(?:~dp0|dp0%)\\*([^"]+)"/g;

/**
 * The node the shim itself would pick: a sibling `node.exe` if the package
 * manager put one there, otherwise node from PATH. Never `process.execPath` —
 * in a packaged build that is `whiphand.exe`, and spawning it would re-run us.
 */
function shimInterpreter(shimDir: string, deps: ResolveExecutableOpts): string | null {
  const sibling = path.win32.join(shimDir, 'node.exe');
  if (existsSync(onDisk(sibling))) return sibling;
  const onPath = resolveExecutable('node', deps);
  // Unresolved means `resolveExecutable` handed the bare name back: there is
  // no node to hand a script to, so the shim knows something we do not.
  return onPath.file === 'node' ? null : onPath.file;
}

/** The `[node, script]` a `.cmd` shim wraps, or null when it is not that shape. */
function resolveShim(shimFile: string, deps: ResolveExecutableOpts): [string, string] | null {
  let body: string;
  try {
    body = readFileSync(onDisk(shimFile), 'utf8');
  } catch {
    return null;
  }
  const shimDir = path.win32.dirname(shimFile);
  for (const [, captured] of body.matchAll(SHIM_PATH_RE)) {
    // The shim also names `node.exe` this way; the entry point is the match
    // that looks like a script and is actually on disk.
    if (!SHIM_SCRIPT_EXTENSIONS.has(path.win32.extname(captured).toLowerCase())) continue;
    const script = path.win32.join(shimDir, captured);
    if (!existsSync(onDisk(script))) continue;
    const node = shimInterpreter(shimDir, deps);
    return node === null ? null : [node, script];
  }
  return null;
}

/**
 * How to actually launch an argv: the file and args to hand `spawn`, plus the
 * extra options a cmd.exe wrapper needs. `invocation` is non-null only when
 * that wrapper is in play — note that a *bypassed* `.cmd` shim leaves it null
 * while still rewriting `file` and `args`, so consumers must read the whole
 * plan rather than treating a null invocation as "use the argv unchanged".
 */
export interface LaunchPlan {
  file: string;
  args: string[];
  invocation: CmdInvocation | null;
}

/**
 * Resolves the command *once* — on Windows that is a readdir of every PATH
 * directory, so doing it twice per spawn is not free — and decides what
 * wrapping, if any, the result needs.
 */
export function planLaunch(argv: string[], deps: ResolveExecutableOpts = {}): LaunchPlan {
  const [command, ...args] = argv;
  const resolved = resolveExecutable(command, deps);
  if ((deps.platform ?? process.platform) !== 'win32') {
    return { file: resolved.file, args, invocation: null };
  }
  if (resolved.usesShell) {
    // Reading through the shim first: only if that fails does the argv have to
    // survive cmd.exe, and with it every restriction assertCarryable enforces.
    const wrapped = resolveShim(resolved.file, deps);
    if (wrapped !== null) {
      const [node, script] = wrapped;
      return { file: node, args: [script, ...args], invocation: null };
    }
    const invocation = cmdInvocation(resolved.file, args, deps.env ?? process.env);
    return { file: invocation.file, args: invocation.args, invocation };
  }
  if (CMD_SHELL_RE.test(path.win32.basename(resolved.file))) {
    const invocation = cmdShellInvocation(resolved.file, args);
    if (invocation !== null) {
      return { file: invocation.file, args: invocation.args, invocation };
    }
  }
  return { file: resolved.file, args, invocation: null };
}

/** Options that make Node hand our command line to cmd.exe unchanged. */
function verbatim(invocation: CmdInvocation | null): Record<string, unknown> {
  return invocation === null
    ? {}
    : { argv0: invocation.argv0, windowsVerbatimArguments: true };
}

/** `child_process.spawn`, routed through `resolveExecutable`. Transparent on POSIX. */
export function spawnRunner(
  argv: string[],
  options: SpawnOptions = {},
  deps: { spawn?: typeof nodeSpawn } & ResolveExecutableOpts = {},
): ChildProcess {
  const spawnFn = deps.spawn ?? nodeSpawn;
  const plan = planLaunch(argv, deps);
  return spawnFn(plan.file, plan.args, { ...options, ...verbatim(plan.invocation), shell: false });
}

/**
 * `child_process.execFile`, promisified and routed through `resolveExecutable`.
 *
 * Its callers today are only the adapters' `--version` probes, which carry no
 * user data and would survive far cruder handling — but leaving it on Node's
 * `shell: true` would make it a third rule for the same problem, and the one a
 * future caller with real arguments would land on without noticing.
 */
export function execRunner(
  argv: string[],
  options: ExecFileOptions = {},
  deps: ResolveExecutableOpts = {},
): Promise<{ stdout: string; stderr: string }> {
  const plan = planLaunch(argv, deps);
  return new Promise((resolvePromise, reject) => {
    execFile(
      plan.file,
      plan.args,
      { ...options, ...verbatim(plan.invocation), shell: false, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}
