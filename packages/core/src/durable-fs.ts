/**
 * The one durable-write helper and the one delete helper (invariant 5).
 *
 * POSIX rename(2) replaces its target atomically however many others are
 * renaming onto it. Windows does not: MoveFileEx fails outright when the
 * target is held for even a moment — by another writer's rename over the same
 * file, by a virus scanner or search indexer that opened it to read it, or, on a
 * redirected `%APPDATA%` or a share, by whatever the server is doing. All of
 * those clear in milliseconds, and a lost write does not, so both helpers here
 * retry briefly with backoff before giving up. Inert on POSIX, where none of
 * them arise. Nothing else in the tree hand-rolls a second copy; the
 * invariants test (scripts/invariants.test.mjs) fails the build if it does.
 */
import { randomBytes } from 'node:crypto';
import { rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** A directory that an indexer is still walking reports ENOTEMPTY where a file reports EBUSY. */
const TRANSIENT_REMOVE_CODES: ReadonlySet<string> = new Set([...TRANSIENT_RENAME_CODES, 'ENOTEMPTY']);

/**
 * Backoff widened for share semantics: 10, 20, 40, 80, 160 ms and then 250 ms
 * a step — a little under three seconds in all, long enough to ride out a
 * scanner or a server hiccup, short enough that a real failure is not slow.
 */
export const RETRY_ATTEMPTS = 15;
const RETRY_BASE_MS = 10;
const RETRY_CAP_MS = 250;

function backoffMs(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_CAP_MS);
}

interface RetryDeps {
  /** Substituted by tests, so a give-up case does not wait out the real backoff. */
  sleep?: (ms: number) => Promise<void>;
}

async function retrying<T>(
  op: () => Promise<T>, transient: ReadonlySet<string>, sleep: (ms: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await op();
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (attempt >= RETRY_ATTEMPTS || code === undefined || !transient.has(code)) throw error;
      await sleep(backoffMs(attempt));
    }
  }
}

/** Exported for its own test — nothing else should need to substitute `op`. */
export async function renameReplacing(
  from: string, to: string, op: (f: string, t: string) => Promise<void> = rename, deps: RetryDeps = {},
): Promise<void> {
  await retrying(() => op(from, to), TRANSIENT_RENAME_CODES, deps.sleep ?? (ms => delay(ms)));
}

export interface WriteFileAtomicOptions extends RetryDeps {
  /** File mode for the new file. Set on the temp file, because rename preserves it and a chmod after would leave a window. */
  mode?: number;
  encoding?: BufferEncoding;
}

/**
 * A unique temp name beside the target: pid plus random bytes, never a
 * constant `.tmp`, so two processes (or two journals) writing the same file
 * cannot clobber each other's half-written temp.
 */
export function tempNameFor(target: string): string {
  return join(dirname(target), `${basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
}

/** tmp + rename, so a reader never observes a half-written file, and the rename survives a scanner holding the target. */
export async function writeFileAtomic(
  target: string, data: string | Uint8Array, opts: WriteFileAtomicOptions = {},
): Promise<void> {
  const tmp = tempNameFor(target);
  await writeFile(tmp, data, {
    ...(typeof data === 'string' ? { encoding: opts.encoding ?? 'utf8' } : {}),
    ...(opts.mode === undefined ? {} : { mode: opts.mode }),
  });
  try {
    await renameReplacing(tmp, target, rename, opts);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

/**
 * `rm -r` with the same transient-code retry and backoff. Missing is not an
 * error. Whether a failure that survives the retries may fail the caller is
 * the caller's call: `pruneRuns` records it as a degradation, `deleteRun`
 * surfaces it.
 */
export async function removeTree(
  path: string, op: (p: string) => Promise<void> = p => rm(p, { recursive: true, force: true }), deps: RetryDeps = {},
): Promise<void> {
  await retrying(() => op(path), TRANSIENT_REMOVE_CODES, deps.sleep ?? (ms => delay(ms)));
}
