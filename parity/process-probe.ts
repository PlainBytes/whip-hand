/**
 * The TypeScript half of the process-layer parity ops (Phase 2b of
 * docs/migration.md); `crates/whiphand-core/src/parity_process.rs` is the
 * Rust half. Everything here is pure or reads only the fixture tree under
 * `parity/fixtures/core/trees/exec`, and every Windows rule is exercised as
 * win32 on every OS, the way exec.ts's own tests do.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmdInvocation, crlfToLf, msvcrtQuote, planLaunch, routeHeadless } from '../packages/core/src/exec.ts';
import { isWslLauncher, resolveShell } from '../packages/core/src/shell.ts';
import { classifyGitFailure, diffSnapshots, pathsFromStatusLines } from '../packages/core/src/engine/git-guard.ts';
import type { SpawnSpec } from '../packages/core/src/types.ts';

type Op = Record<string, unknown> & { op: string };

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');

/** The repo root in both of the spellings a win32 plan computed on this host can carry. */
function portable(value: unknown): unknown {
  const forms = [REPO, REPO.replace(/\//g, '\\')];
  if (typeof value === 'string') return forms.reduce((s, f) => s.split(f).join('<repo>'), value);
  if (Array.isArray(value)) return value.map(portable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, portable(v)]));
  }
  return value;
}

/** An op's `env`, with `dirs` (repo-relative) joined into a win32 PATH. */
function opEnv(op: Op): Record<string, string> {
  const env = { ...(op.env as Record<string, string> | undefined) };
  const dirs = op.dirs as string[] | undefined;
  if (dirs !== undefined) env.PATH = dirs.map(d => path.join(REPO, d)).join(';');
  return env;
}

function attempt(fn: () => unknown): unknown {
  try {
    return { ok: fn() };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** The ops runProcessOp answers. */
export const PROCESS_OPS: ReadonlySet<string> = new Set(['msvcrtQuote', 'cmdInvocation', 'planLaunch', 'resolveShell', 'isWslLauncher', 'crlfToLf', 'routeHeadless', 'classifyGitFailure', 'diffSnapshots', 'pathsFromStatusLines', 'matchesGlob']);

export function runProcessOp(op: Op): unknown {
  switch (op.op) {
    case 'msvcrtQuote':
      return msvcrtQuote(op.arg as string);
    case 'cmdInvocation':
      return attempt(() => cmdInvocation(op.file as string, op.args as string[], opEnv(op)));
    case 'planLaunch':
      return portable(attempt(() => planLaunch(op.argv as string[], { platform: 'win32', env: opEnv(op) })));
    case 'resolveShell': {
      const existing = new Set(op.existing as string[]);
      return resolveShell({
        platform: 'win32', env: opEnv(op), exists: p => existing.has(p),
        ...(op.git === undefined ? {} : { git: op.git as string }),
      });
    }
    case 'isWslLauncher':
      return isWslLauncher(op.path as string);
    case 'crlfToLf': {
      const f = crlfToLf();
      const out = (op.chunks as string[]).map(c => f.write(Buffer.from(c, 'utf8')));
      out.push(f.end());
      return Buffer.concat(out).toString('utf8');
    }
    case 'routeHeadless':
      return routeHeadless(op.spec as SpawnSpec, op.hasLineReader as boolean);
    case 'classifyGitFailure':
      return classifyGitFailure({
        ...(op.code === undefined ? {} : { code: op.code }),
        stderr: op.stderr, message: op.message,
      });
    case 'diffSnapshots':
      return diffSnapshots(op.before as string, op.after as string);
    case 'pathsFromStatusLines':
      return pathsFromStatusLines(op.lines as string[]);
    case 'matchesGlob': {
      const flavor = op.windows ? path.win32 : path.posix;
      return (op.paths as string[]).map(p => flavor.matchesGlob(p, op.pattern as string));
    }
    default:
      return undefined;
  }
}
