import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const isWindows = process.platform === 'win32';

/**
 * A `.cmd` shaped like the shims npm generates for `claude`/`copilot` — the
 * `endLocal & goto ... ||` trick and the `%*` tail forwarding are what put a
 * second cmd parse in the path — so a stub launches the way a real runner
 * does.
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

/**
 * A directory of stub runner binaries for doctor-shaped parity checks: each
 * answers `--version` with the given line and exits 0 for anything else. Minted
 * in the shape the platform launches, so the same fixture works on every leg:
 * a checked-in bash script would depend on the executable bit and be
 * invisible to a Windows PATHEXT walk.
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
