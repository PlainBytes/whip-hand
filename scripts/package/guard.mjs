/**
 * The process guard (`whiphand-job.exe`, crates/job-guard), built once for the
 * Windows packages that need it and embedded as a SEA asset — the CLI stays a
 * single file, and the agent sidecar (the desktop's process host) carries its
 * own copy, extracted on first use to a content-hashed path under
 * `%LOCALAPPDATA%\whiphand\bin` (see packages/core/src/container.ts).
 *
 * Windows only: POSIX contains by process group inside Node itself. In a
 * *packaged* build a missing or unstartable guard refuses the run, so leaving
 * this out of a Windows build would be caught by the smoke test, not shipped.
 */
import path from 'node:path';
import { runSync } from '../../packages/core/src/exec.ts';
import { repoRoot } from './sea.mjs';

const manifest = path.join(repoRoot, 'crates/job-guard/Cargo.toml');
export const GUARD_ASSET_NAME = 'whiphand-job.exe';

/** Builds the guard (release) and returns its path, or undefined off Windows. */
export function buildGuard() {
  if (process.platform !== 'win32') return undefined;
  runSync(['cargo', 'build', '--release', '--manifest-path', manifest], { check: true });
  return path.join(repoRoot, 'crates/job-guard/target/release', GUARD_ASSET_NAME);
}

/** The `assets` entry for buildSingleExecutable: `{}` off Windows. */
export function guardAssets() {
  const guard = buildGuard();
  return guard === undefined ? {} : { [GUARD_ASSET_NAME]: guard };
}
