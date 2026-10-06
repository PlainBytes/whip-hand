/**
 * The scripts' one seam for starting a process (packaging, benchmarks), so
 * Windows' several ways of not being POSIX are dealt with once. Transparent on
 * POSIX; see the comments below for how the Windows `.cmd`-shim/cmd.exe
 * handling works. Ported from the TS core's exec.ts when the product moved to
 * Rust (crates/whiphand-core/src/process does the same for the agent).
 *
 * Nothing else in the scripts imports `node:child_process` or passes
 * `shell: true` (scripts/invariants.test.mjs).
 */
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * A native install (`claude.exe`, `copilot.exe`) needs nothing special:
 * CreateProcess launches it and MSVCRT quoting just works. An npm install is a
 * `.cmd` shim, which Node refuses to launch directly since the CVE-2024-27980
 * fix — routing that through cmd.exe instead drags in a second, lossier parser,
 * which is what the rest of this file tries to avoid where it can.
 */
const WINDOWS_SHELL_EXTENSIONS = new Set(['.bat', '.cmd']);

export function resolveExecutable(command, opts = {}) {
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
function classify(file) {
  return { file, usesShell: WINDOWS_SHELL_EXTENSIONS.has(path.win32.extname(file).toLowerCase()) };
}

function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

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
export function msvcrtQuote(arg) {
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

function excerpt(arg) {
  const oneLine = arg.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}

/**
 * Refuses the two argument shapes no quoting can carry through cmd.exe: a raw
 * newline (cmd ends the command line there, before quote processing happens)
 * and a `"` sharing an argument with one of `& | < > ^ ( )` (cmd has no `\"`
 * escape and MSVCRT has no `^`, so no encoding satisfies both parsers).
 * Failing loudly here beats shipping a corrupted prompt to a model.
 */
function assertCarryable(args) {
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

function assertLength(commandLine) {
  if (commandLine.length > CMD_MAX_COMMAND_LINE) {
    throw new Error(
      `command line is ${commandLine.length} characters, over cmd.exe's ${CMD_MAX_COMMAND_LINE}-character `
      + 'limit; it would be silently truncated',
    );
  }
}

/**
 * Both shapes of one `cmd.exe /c` invocation: the array Node's spawn wants and
 * the single command line. One builder so the two cannot drift.
 *
 * Reimplements Node's own `shell: true` cmd.exe wrapper rather than using it:
 * Node joins `[file, ...args]` with a bare space and no quoting (DEP0190), so
 * every multi-word argument arrives word-split. Quoting here is applied
 * *once*, via `msvcrtQuote` rather than caret-escaping, because npm's `.cmd`
 * shim forwards its tail with `%*` — a textual substitution, not a re-parse —
 * so there is exactly one `CommandLineToArgvW` parse at the far end however
 * many `.cmd` hops intervene; a caret would survive one cmd parse and arrive
 * as a bare metacharacter at the next.
 *
 * `/s` is load-bearing — it makes cmd strip exactly the outer quote pair
 * instead of heuristically hunting for where the command starts. `/v:off`
 * closes the `!` failure mode outright rather than leaving it to a registry
 * setting we cannot see from here.
 */
export function cmdInvocation(
  file, args, env = process.env,
) {
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
function onDisk(winPath) {
  return process.platform === 'win32' ? winPath : winPath.replace(/\\/g, '/');
}

/** `"%dp0%\..."` as npm writes it, `"%~dp0\..."` as pnpm and yarn do. */
const SHIM_PATH_RE = /"%(?:~dp0|dp0%)\\*([^"]+)"/g;

/**
 * The node the shim itself would pick: a sibling `node.exe` if the package
 * manager put one there, otherwise node from PATH. Never `process.execPath` —
 * in a packaged build that would be the app itself.
 */
function shimInterpreter(shimDir, deps) {
  const sibling = path.win32.join(shimDir, 'node.exe');
  if (existsSync(onDisk(sibling))) return sibling;
  const onPath = resolveExecutable('node', deps);
  // Unresolved means `resolveExecutable` handed the bare name back: there is
  // no node to hand a script to, so the shim knows something we do not.
  return onPath.file === 'node' ? null : onPath.file;
}

/** The `[node, script]` a `.cmd` shim wraps, or null when it is not that shape. */
function resolveShim(shimFile, deps) {
  let body;
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
 * How to actually launch an argv: `{ file, args, invocation }`, the file and
 * args to hand `spawn` plus the cmd.exe wrapper when one is in play. Note that
 * a *bypassed* `.cmd` shim leaves `invocation` null while still rewriting
 * `file` and `args`, so consumers must read the whole plan.
 *
 * Resolves the command *once* — on Windows that is a readdir of every PATH
 * directory, so doing it twice per spawn is not free.
 */
export function planLaunch(argv, deps = {}) {
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
  // Nothing else ever wraps: the cmd.exe hop above is reserved for a `.cmd`
  // shim we could not read.
  return { file: resolved.file, args, invocation: null };
}

/** Options that make Node hand our command line to cmd.exe unchanged. */
export function verbatim(invocation) {
  return invocation === null
    ? {}
    : { argv0: invocation.argv0, windowsVerbatimArguments: true };
}

/** `child_process.spawn`, routed through `resolveExecutable`. Transparent on POSIX; never shows a console window on Windows. */
export function spawnRunner(argv, options = {}, deps = {}) {
  const spawnFn = deps.spawn ?? nodeSpawn;
  const plan = planLaunch(argv, deps);
  return spawnFn(plan.file, plan.args, {
    windowsHide: true,
    ...options,
    ...verbatim(plan.invocation),
    shell: false,
  });
}

/**
 * A synchronous run through the same plan as everything else — for the packaging
 * scripts, which launch `npm` (a `.cmd` shim on Windows: this file's thesis in
 * miniature) and used to say `shell: process.platform === 'win32'` to get
 * there. A spawn failure always throws; a non-zero status throws only with
 * `check`, carrying `status` and `stderr` on the error.
 */
export function runSync(argv, options = {}, deps = {}) {
  const plan = planLaunch(argv, deps);
  const result = spawnSync(plan.file, plan.args, {
    windowsHide: true,
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout,
    ...verbatim(plan.invocation),
    stdio: options.stdio ?? 'inherit',
    encoding: 'utf8',
    shell: false,
  });
  if (result.error !== undefined) throw result.error;
  const status = result.status ?? 1;
  const out = { status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
  if (options.check === true && status !== 0) {
    throw Object.assign(new Error(`${argv[0]} exited with status ${status}${out.stderr === '' ? '' : `: ${out.stderr.trim()}`}`), out);
  }
  return out;
}

/** `runSync` with inherited stdio, returning the exit code. */
export function runInherited(argv, options = {}, deps = {}) {
  return runSync(argv, { ...options, stdio: 'inherit' }, deps).status;
}
