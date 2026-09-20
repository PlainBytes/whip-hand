import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The normalization list is declared, not discovered. Exactly these four
 * things may be substituted before a cross-OS artifact comparison; anything
 * else that differs between two legs is a real difference. **Line endings are
 * not on the list**: normalizing them would hide the exact bug the comparison
 * exists to catch — a CRLF in an artifact is a genuine regression, because
 * artifacts are LF by construction.
 */
export const NORMALIZATION = ['run id', 'ISO timestamps', 'session UUIDs', 'workspace absolute prefix'] as const;

export interface BundleFile {
  /** Run-dir-relative, `/`-separated. */
  path: string;
  bytes: Buffer;
}

export interface CaptureOptions {
  /** The workspace root as this leg knows it (native form); its native and `/` spellings both become `<WORKSPACE>`. */
  workspace: string;
  runId: string;
}

/**
 * What a run records that describes the *host*, not the work — dropped from the
 * captured `run.json`, along with `run.log` and `events.ndjson` (also host-shaped)
 * and every dotfile (bookkeeping: markers, prompts, settings). `pid` and
 * `pidScope` name the owning process and its PID space, and differ by construction.
 */
const HOST_FIELDS = ['stoppedTree', 'degradations', 'pid', 'pidScope'] as const;
const EXCLUDED_FILES = new Set(['run.log', 'events.ndjson']);

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const RUN_ID_SHAPE = /\d{8}-\d{6}-[0-9a-f]{4}/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Applies exactly the declared substitutions to one text value. */
function normalizeText(text: string, opts: CaptureOptions): string {
  const spellings = new Set([opts.workspace, opts.workspace.split(path.sep).join('/'), opts.workspace.replace(/\\/g, '/')]);
  let out = text;
  // JSON escapes a backslash, so a native Windows path appears doubled inside run.json.
  for (const spelling of [...spellings].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(escapeRegExp(spelling.replace(/\\/g, '\\\\')), 'g'), '<WORKSPACE>');
    out = out.replace(new RegExp(escapeRegExp(spelling), 'g'), '<WORKSPACE>');
  }
  return out.replaceAll(opts.runId, '<RUN_ID>').replace(RUN_ID_SHAPE, '<RUN_ID>').replace(ISO, '<TIMESTAMP>').replace(UUID, '<UUID>');
}

function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

/**
 * The normalized artifact bundle of one run: every step artifact under the run
 * dir (dotfiles excluded) plus `run.json`, sorted by path, with the declared
 * substitutions applied and nothing else. Two legs' bundles compare byte for
 * byte against one checked-in golden.
 */
export function captureBundle(runDir: string, opts: CaptureOptions): BundleFile[] {
  const files: BundleFile[] = [];
  for (const rel of walk(runDir).sort()) {
    const base = rel.split('/').pop() ?? rel;
    if (EXCLUDED_FILES.has(rel)) continue;
    // A dotfile anywhere under the run dir is bookkeeping (`.plan.done`, `.step.prompt`, …).
    if (base.startsWith('.')) continue;
    let text = readFileSync(path.join(runDir, rel), 'utf8');
    if (rel === 'run.json') {
      const manifest = JSON.parse(text) as Record<string, unknown>;
      for (const field of HOST_FIELDS) delete manifest[field];
      text = JSON.stringify(manifest, null, 2);
    }
    files.push({ path: rel, bytes: Buffer.from(normalizeText(text, opts), 'utf8') });
  }
  return files;
}
