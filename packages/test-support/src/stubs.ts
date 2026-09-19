import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface StubBin {
  /** The directory holding the stub — what goes on PATH. */
  dir: string;
  /** The stub's launchable file (`<name>` on POSIX, `<name>.cmd` on Windows). */
  file: string;
  /** The JS the stub runs, so a test can inspect or extend it. */
  script: string;
  /** Replaces the stub's behaviour in place — for a test that changes what a binary answers between calls. */
  rewrite(behaviour: string): void;
}

const isWindows = process.platform === 'win32';

/**
 * A `.cmd` shaped like the shims npm generates for `claude`/`copilot` — the
 * `endLocal & goto ... ||` trick and the `%*` tail forwarding are what put a
 * second cmd parse in the path — so `resolveShim`'s readable-shim branch (the
 * one a real runner takes) is what gets exercised.
 */
function npmShim(scriptName: string): string {
  return [
    '@ECHO off',
    'SETLOCAL',
    'CALL :find_dp0',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & node "%dp0%\\${scriptName}" %*`,
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
  ].join('\r\n');
}

/** A `.cmd` whose entry point cannot be read out of it, so the cmd.exe fallback is the only way through. */
function opaqueShim(scriptName: string): string {
  return [
    '@ECHO off',
    'SETLOCAL',
    `SET "entry=%~dp0${scriptName}"`,
    'node "%entry%" %*',
  ].join('\r\n');
}

function mint(name: string, behaviour: string, readable: boolean): StubBin {
  const dir = mkdtempSync(path.join(tmpdir(), `whiphand-stub-${name}-`));
  const scriptName = `${name}.stub.js`;
  writeFileSync(path.join(dir, scriptName), behaviour, 'utf8');
  const rewrite = (next: string): void => writeFileSync(path.join(dir, scriptName), next, 'utf8');
  if (isWindows) {
    const file = path.join(dir, `${name}.cmd`);
    writeFileSync(file, readable ? npmShim(scriptName) : opaqueShim(scriptName), 'utf8');
    return { dir, file, script: behaviour, rewrite };
  }
  // POSIX: a `#!/bin/sh` script, mode 0755. It launches node by absolute path, so a
  // test that empties PATH (to prove a fallback) still finds its stub's interpreter.
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/${scriptName}" "$@"\n`, 'utf8');
  chmodSync(file, 0o755);
  return { dir, file, script: behaviour, rewrite };
}

/**
 * `env` with `dir` first on PATH, joined with `path.delimiter` (`;` on Windows).
 * On Windows the variable is `Path` in a real environment and `PATH` in a
 * lower-cased copy; both are set so whichever the code under test reads sees it.
 */
export function pathWith(dir: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const current = env.PATH ?? env.Path ?? '';
  const joined = current === '' ? dir : `${dir}${path.delimiter}${current}`;
  return { ...env, PATH: joined, ...(isWindows ? { Path: joined } : {}) };
}

/** Runs `fn` with `patch` applied to `process.env`, restoring it afterwards even if `fn` throws. */
export async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(patch).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

async function run<T>(stub: StubBin, fn: (stub: StubBin) => T | Promise<T>): Promise<T> {
  // `Path` and `PATH` both, for the reason pathWith says.
  const patched = pathWith(stub.dir);
  try {
    return await withEnv({ PATH: patched.PATH, ...(isWindows ? { Path: patched.Path } : {}) }, () => fn(stub));
  } finally {
    rmSync(stub.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/**
 * Mints a stub binary named `name` whose behaviour is `behaviour` — JavaScript
 * source, written once and run by node on every platform — puts its directory
 * first on PATH for the duration of `fn`, and cleans up after. POSIX gets a
 * `#!/bin/sh` script; Windows gets a `.cmd` in **npm shim shape**, which
 * exercises `resolveShim`'s readable-shim path, the one a real runner takes.
 */
export function withStubBin<T>(name: string, behaviour: string, fn: (stub: StubBin) => T | Promise<T>): Promise<T> {
  return run(mint(name, behaviour, true), fn);
}

/**
 * The same, but on Windows the shim is one `resolveShim` cannot read, so the
 * cmd.exe fallback is the only way through. On POSIX there is no such thing as
 * an unreadable shim and this is `withStubBin`.
 */
export function withUnreadableStubBin<T>(name: string, behaviour: string, fn: (stub: StubBin) => T | Promise<T>): Promise<T> {
  return run(mint(name, behaviour, false), fn);
}

/**
 * A directory of stub runner binaries for doctor-shaped parity checks: each
 * answers `--version` with the given line and exits 0 for anything else. Minted
 * in the shape the platform launches, so the same fixture works on every leg —
 * the checked-in `parity/fixtures/bin/*` bash scripts depend on the executable
 * bit and are invisible to a Windows PATHEXT walk.
 */
export function mintVersionStubs(versions: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'whiphand-fixture-bin-'));
  for (const [name, version] of Object.entries(versions)) {
    const scriptName = `${name}.stub.js`;
    writeFileSync(path.join(dir, scriptName),
      `if (process.argv[2] === '--version') { console.log(${JSON.stringify(version)}); }\nprocess.exit(0);\n`, 'utf8');
    if (isWindows) {
      writeFileSync(path.join(dir, `${name}.cmd`), npmShim(scriptName), 'utf8');
    } else {
      const file = path.join(dir, name);
      writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/${scriptName}" "$@"\n`, 'utf8');
      chmodSync(file, 0o755);
    }
  }
  return dir;
}
