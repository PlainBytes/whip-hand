/**
 * The working tree's change set, file by file.
 *
 * `workingDiff` in manual.ts answers "give me something to print on a tty" and
 * returns one opaque string. This answers "give me something to render" and
 * returns a list a reviewer can walk: per file a status, counts, and that
 * file's own unified patch. Hunk parsing is deliberately *not* here — core
 * stays a git wrapper, and the frontend that draws the rows is the one that
 * knows what a row is.
 *
 * Two things it fixes about the string version, beyond the shape:
 *
 * - `git diff HEAD` shows the index and the worktree against HEAD, and an
 *   untracked file is in neither — so a file a step just *created* never
 *   appeared at sign-off at all. That is the most important thing on the
 *   screen, silently missing.
 * - It is not truncated at 400 lines, so the last file is never severed
 *   mid-hunk.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** git's hash of the empty tree — the base for a repo with no commits yet. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * How many files we will put in front of a human at once. Past this the rail
 * stops being something anyone reads, exactly as MAX_DIR_ENTRIES reasons about
 * a directory listing.
 */
export const MAX_DIFF_FILES = 500;

/** Per-file patch cap. A generated file is not reviewed line by line. */
export const MAX_PATCH_BYTES = 256 * 1024;

/** Across all files. Past this, later entries keep their counts and lose their patch. */
export const MAX_TOTAL_PATCH_BYTES = 4 * 1024 * 1024;

/**
 * `git diff` exits 1 to mean "there were differences", which `promisify`
 * turns into a rejection — so the *success* path here throws. Anything else
 * (2 = trouble, 128 = usage, 'ENOENT' = no git) is a real failure and is
 * rethrown. `code` is `number | string` on a child-process rejection, hence
 * the loose check.
 */
async function gitStdout(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await run('git', args, {
      cwd, maxBuffer: 64 * 1024 * 1024, ...(env ? { env } : {}),
    });
    return stdout;
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string };
    if (e.code === 1 && typeof e.stdout === 'string') return e.stdout;
    throw err;
  }
}

export type DiffStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffFileEntry {
  /** The new path — or, for a delete, the path that went away. */
  path: string;
  /** Only set when git detected a rename. */
  oldPath?: string;
  status: DiffStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** This file's unified patch. Absent when binary, or dropped by a cap. */
  patch?: string;
  /** The patch was dropped because it was too large, not because there is none. */
  truncated?: boolean;
}

export interface WorkingDiff {
  files: DiffFileEntry[];
  /** How many files the MAX_DIFF_FILES cap dropped. */
  filesTruncated?: number;
  /** Entries kept, patch dropped — by a size cap or by the pairing guard. */
  patchesOmitted?: number;
}

/** One `--numstat -z` record, before its patch is attached. */
interface NumstatEntry {
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

/**
 * `--numstat -z` is three tab-separated fields per record, NUL-terminated:
 *
 *   ordinary  `12\t3\tpath\0`
 *   binary    `-\t-\tpath\0`
 *   rename    `1\t1\t\0oldPath\0newPath\0`   <- path field EMPTY, two more fields follow
 *
 * Two things bite. Git appends a trailing `\n` after the final NUL, so a
 * `.filter(Boolean)` still leaves a `"\n"` field. And the counts are split with
 * `indexOf` rather than `split('\t')` because a path may itself contain a tab —
 * `-z` does not quote it.
 */
export function parseNumstatZ(stdout: string): NumstatEntry[] {
  const fields = stdout.split('\0');
  const entries: NumstatEntry[] = [];

  for (let i = 0; i < fields.length;) {
    const field = fields[i];
    if (field.trim() === '') { i++; continue; }

    const firstTab = field.indexOf('\t');
    const secondTab = field.indexOf('\t', firstTab + 1);
    if (firstTab === -1 || secondTab === -1) { i++; continue; }

    const rawAdd = field.slice(0, firstTab);
    const rawDel = field.slice(firstTab + 1, secondTab);
    const rest = field.slice(secondTab + 1);
    const binary = rawAdd === '-' && rawDel === '-';
    const additions = binary ? 0 : Number.parseInt(rawAdd, 10) || 0;
    const deletions = binary ? 0 : Number.parseInt(rawDel, 10) || 0;

    if (rest === '') {
      // A rename: the next two fields are the old and new paths.
      const oldPath = fields[i + 1];
      const path = fields[i + 2];
      if (oldPath === undefined || path === undefined) break;
      entries.push({ path, oldPath, additions, deletions, binary });
      i += 3;
    } else {
      entries.push({ path: rest, additions, deletions, binary });
      i += 1;
    }
  }
  return entries;
}

/**
 * One `git diff` patch into one chunk per file, in git's own order.
 *
 * Deliberately does not read the path back out of the `diff --git` header.
 * Git does not quote a space, so it emits `diff --git a/my file.txt b/my
 * file.txt` — genuinely ambiguous, and a repo holding both `a b/c.txt` and
 * `x.txt` defeats every heuristic for finding the ` b/` boundary. The numstat
 * pass is the authoritative path list; these chunks are matched to it by
 * position, which is why both passes must carry identical flags.
 */
export function splitPatch(patch: string): string[] {
  if (patch.trim() === '') return [];
  // Split on the header rather than on a delimiter, so the marker stays with
  // the chunk it introduces and a `diff --git` inside a hunk body (a patch
  // file being reviewed) can't split it: hunk bodies are always indented by a
  // prefix character, so the ^ anchor never matches there.
  const parts = patch.split(/^diff --git /m);
  return parts.slice(1).map(part => `diff --git ${part}`);
}

/** A patch chunk for a file git reported as binary carries no reviewable text. */
function isBinaryChunk(chunk: string): boolean {
  return /^Binary files /m.test(chunk) || /^GIT binary patch$/m.test(chunk);
}

function statusOf(chunk: string | undefined, entry: NumstatEntry): DiffStatus {
  if (entry.oldPath !== undefined) return 'renamed';
  if (chunk === undefined) return 'modified';
  if (/^new file mode /m.test(chunk)) return 'added';
  if (/^deleted file mode /m.test(chunk)) return 'deleted';
  return 'modified';
}

/**
 * Attach each patch chunk to its numstat entry, by position.
 *
 * If the two lists disagree in length, every pairing after the divergence is
 * suspect — so none is made. That is not fussiness: mispairing here means a
 * human approves changes they were shown against a file that did not contain
 * them. Losing the patches and keeping the counts is embarrassing; showing the
 * wrong file's diff on a sign-off screen is not survivable.
 */
export function pairPatches(entries: NumstatEntry[], chunks: string[]): WorkingDiff {
  const aligned = entries.length === chunks.length;
  let patchesOmitted = 0;
  let totalBytes = 0;

  const files: DiffFileEntry[] = entries.map((entry, index) => {
    const chunk = aligned ? chunks[index] : undefined;
    const binary = entry.binary || (chunk !== undefined && isBinaryChunk(chunk));
    const file: DiffFileEntry = {
      path: entry.path,
      ...(entry.oldPath === undefined ? {} : { oldPath: entry.oldPath }),
      status: statusOf(chunk, entry),
      additions: entry.additions,
      deletions: entry.deletions,
      binary,
    };

    if (chunk === undefined) {
      // Only counts as "omitted" when there was something to omit — a run
      // with no patch pass at all is not reporting a loss.
      if (!aligned) patchesOmitted++;
      return file;
    }
    if (binary) return file; // Nothing renderable; not a loss worth reporting.

    if (chunk.length > MAX_PATCH_BYTES || totalBytes + chunk.length > MAX_TOTAL_PATCH_BYTES) {
      patchesOmitted++;
      return { ...file, truncated: true };
    }
    totalBytes += chunk.length;
    return { ...file, patch: chunk };
  });

  return { files, ...(patchesOmitted > 0 ? { patchesOmitted } : {}) };
}

/**
 * The working tree against HEAD, file by file. `null` means this is not a git
 * repo — and *only* that. Everything else degrades to counts without patches,
 * because a review screen that shows nothing looks exactly like a review
 * screen for a run that changed nothing.
 *
 * (manual.ts's `workingDiff` gets that wrong: one try/catch around both spawns
 * turns a maxBuffer overflow into "no diff". Don't copy it.)
 *
 * The mechanism is a throwaway index. `GIT_INDEX_FILE` points at a temp file,
 * `read-tree` seeds it from HEAD so deletes and renames still register, and
 * `add -A` stages the working tree into it. Diffing *that* against HEAD gets
 * tracked edits, deletes, renames and untracked files in one uniform pass —
 * no per-file spawns, and the real index is never touched.
 */
export async function workingDiffFiles(workdir: string): Promise<WorkingDiff | null> {
  let head: string;
  try {
    // Also the "is this a git repo" probe: everything after this point may
    // fail loudly, but reaching it at all proves the repo exists.
    head = await gitStdout(['rev-parse', '--verify', '--quiet', 'HEAD'], workdir);
  } catch {
    return null;
  }
  // A repo with no commits has no HEAD to diff against; the empty tree is what
  // "everything is new" means.
  const base = head.trim() === '' ? EMPTY_TREE : 'HEAD';

  const indexDir = await mkdtemp(join(tmpdir(), 'whiphand-diff-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(indexDir, 'index') };

  try {
    await gitStdout(['read-tree', base], workdir, env);
    // `add -A` writes blobs into .git/objects for anything changed. They are
    // unreferenced and the next gc collects them — the same cost `git stash
    // create` pays — but it is a real write from an otherwise read-shaped call.
    //
    // The pathspec keeps the run's own artifacts out. `whiphand init` writes no
    // .gitignore and artifacts_dir is configurable, so in a fresh workspace
    // plan.md and review.md are themselves untracked and would otherwise
    // dominate the very review they are the subject of. Same rule as
    // diffSnapshots' `.whiphand/` filter, so the write-guard and the review agree
    // about what counts as a change.
    await gitStdout(['add', '-A', '--', '.', ':(exclude,glob).whiphand/**'], workdir, env);

    // Every flag defends against a *user's* gitconfig, not against git's
    // defaults. --find-renames on both passes or the two lists can come back
    // different lengths; --no-ext-diff because a textconv driver emits
    // something that is not a unified patch at all; --no-color against
    // color.ui=always; --unified=3 because diff.context is settable and would
    // silently multiply the payload against the caps above. noprefix and
    // mnemonicPrefix are pinned so the patch body itself is byte-identical
    // whatever the user has configured — nothing here reads the `diff --git`
    // header, but a diff a reviewer reads should not change shape per machine.
    const shared = [
      '-c', 'core.quotepath=false', '-c', 'diff.noprefix=false',
      '-c', 'diff.mnemonicPrefix=false', '--no-pager', 'diff', '--cached', base,
      '--find-renames', '--no-ext-diff', '--no-color',
    ];
    const pathspec = ['--', '.', ':(exclude,glob).whiphand/**'];

    const numstat = await gitStdout([...shared, '--numstat', '-z', ...pathspec], workdir, env);
    const all = parseNumstatZ(numstat);
    const entries = all.slice(0, MAX_DIFF_FILES);
    const filesTruncated = all.length - entries.length;

    // Nothing to fetch a patch for, and no reason to pay for the second spawn.
    if (entries.length === 0) return { files: [] };

    // The patch pass is the one that can genuinely be enormous — MAX_DIFF_FILES
    // bounds the *list*, not the bytes git prints, and nothing in the pathspec
    // can bound it without naming every path on a command line. So its failure
    // is expected rather than exceptional: a maxBuffer overflow degrades to
    // counts-without-patches, which is what the docstring promises, instead of
    // failing the whole call and showing a review screen with nothing on it.
    let chunks: string[];
    try {
      const patch = await gitStdout([...shared, '--unified=3', ...pathspec], workdir, env);
      // Chunks cover every file git reported; the entry list may have been
      // capped, so trim to match or the pairing guard fires on our own cap.
      chunks = splitPatch(patch).slice(0, entries.length);
    } catch {
      chunks = [];
    }

    const result = chunks.length === 0 && entries.length > 0
      ? { files: pairPatches(entries, []).files, patchesOmitted: entries.length }
      : pairPatches(entries, chunks);
    return filesTruncated > 0 ? { ...result, filesTruncated } : result;
  } finally {
    await rm(indexDir, { recursive: true, force: true });
  }
}
