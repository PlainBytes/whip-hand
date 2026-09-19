/**
 * POSIX shell discovery: one dialect on every OS.
 *
 * `git` is already a non-optional dependency, and on Windows git in practice
 * means Git for Windows, which brings a POSIX shell with it. So the shell is
 * *derived from the already-resolved `git` executable* — never a hardcoded
 * install path, and never a bare PATH lookup for `bash`: on any machine with
 * WSL enabled that finds `C:\Windows\System32\bash.exe`, a launcher that runs
 * the command inside the WSL filesystem, where the workspace CWD and every path
 * we pass mean nothing. That path is rejected by name even when found.
 *
 * Git's `sh.exe` is bash in POSIX mode and accepts most bashisms, so discovery
 * does not enforce the dialect; dash (`/bin/sh` on the Linux unit and parity
 * legs) is the only enforcer for shipped templates. Docs tell authors to write
 * for `/bin/sh`.
 *
 * Resolved per run, with no process-level cache: doctor calls it fresh on every
 * probe, and a shell installed mid-session is found by the next run.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveExecutable } from './exec.ts';
import { toFwdAbs } from './path-form.ts';

export type ShellResult =
  | { ok: true; path: string }
  | { ok: false; reason: string; remediation: string };

export interface ResolveShellOpts {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Substituted by tests, which describe a fake Git for Windows layout on any host. */
  exists?: (winPath: string) => boolean;
  /** The resolved git executable; defaults to a PATH lookup. Tests pass it directly. */
  git?: string;
}

const REMEDIATION =
  'Install Git for Windows (https://git-scm.com/download/win), which includes a POSIX shell, and make sure '
  + '`git` is on PATH. Command steps are refused until a shell is found; agent steps still run.';

/** `…\System32\bash.exe` (and its 32-bit / native aliases): the WSL launcher, never the shell we want. */
export function isWslLauncher(candidate: string): boolean {
  return /[\\/](?:system32|sysnative|syswow64)[\\/]bash\.exe$/i.test(candidate);
}

/**
 * Windows-only body, written with `path.win32` so a `platform: 'win32'` test on
 * Linux exercises the real derivation, like `resolveExecutable` does.
 */
function findOnWindows(opts: ResolveShellOpts): ShellResult {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? ((p: string) => existsSync(p.replace(/\\/g, '/')));
  const git = opts.git ?? resolveExecutable('git', { platform: 'win32', env }).file;
  const win = path.win32;

  const roots: string[] = [];
  // A resolved git is an absolute path; the bare command name means "not found".
  if (win.isAbsolute(git)) {
    const gitDir = win.dirname(git);
    // Git for Windows puts `git.exe` in `cmd\` (on PATH) and again in `mingw64\bin\`.
    roots.push(win.resolve(gitDir, '..'), win.resolve(gitDir, '..', '..'));
  }
  const programFiles = [env.PROGRAMFILES, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432]
    .filter((v): v is string => v !== undefined && v !== '');
  for (const pf of programFiles) roots.push(win.join(pf, 'Git'));

  // `sh.exe` first (a POSIX-mode shell is closer to /bin/sh than a full bash),
  // `usr\bin` before `bin` (the latter holds the launcher shims), then bash.exe.
  const relatives = [['usr', 'bin', 'sh.exe'], ['bin', 'sh.exe'], ['usr', 'bin', 'bash.exe'], ['bin', 'bash.exe']];
  const tried: string[] = [];
  for (const relative of relatives) {
    for (const root of [...new Set(roots)]) {
      const candidate = win.join(root, ...relative);
      if (isWslLauncher(candidate)) continue;
      tried.push(candidate);
      if (exists(candidate)) return { ok: true, path: toFwdAbs(candidate) };
    }
  }
  const reason = win.isAbsolute(git)
    ? `no POSIX shell found near git (${toFwdAbs(git)})`
    : 'git was not found on PATH, so no POSIX shell could be derived from it';
  return { ok: false, reason, remediation: REMEDIATION };
}

export function resolveShell(opts: ResolveShellOpts = {}): ShellResult {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return { ok: true, path: '/bin/sh' };
  return findOnWindows(opts);
}

/** The refusal message for a command step, naming the shell problem and its fix. */
export function shellRefusal(result: Extract<ShellResult, { ok: false }>): string {
  return `${result.reason}. ${result.remediation}`;
}
