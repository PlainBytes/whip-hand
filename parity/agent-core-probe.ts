/**
 * The TypeScript half of the parity ops for the core pieces only the desktop
 * agent used, ported in Phase 3 of docs/migration.md so the agent can run in
 * Rust; `crates/whiphand-core/src/parity_agent_core.rs` is the Rust half.
 *
 * - `parseNumstatZ`, `splitPatch`, `pairPatches`: the pure halves of diff.ts.
 * - `workingDiffFiles`: builds a git repo from a script, then diffs it.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pairPatches, parseNumstatZ, splitPatch, workingDiffFiles } from '../packages/core/src/engine/diff.ts';
import { mergeWorkflow } from '../packages/core/src/workflow-write.ts';
import { parseWorkflow } from '../packages/core/src/schema.ts';
import type { Scope, Workflow } from '../packages/core/src/types.ts';
import { cloneWorkflow, createWorkflow, deleteWorkflow, updateWorkflow } from '../packages/core/src/scaffold.ts';
import { readdirSync, readFileSync } from 'node:fs';
import { normalizeText } from './store-probe.ts';
import { findWorkspaceKey, sameWorkspace } from '../packages/core/src/path-form.ts';
import { mergeWithAliases, parseInitializeReply } from '../packages/core/src/adapters/claude-models.ts';
import { parseOpencodeModels } from '../packages/core/src/adapters/opencode.ts';
import { parseCopilotModels } from '../packages/core/src/adapters/copilot.ts';
import type { ModelInfo } from '../packages/core/src/types.ts';

type Op = Record<string, unknown> & { op: string };

/** A text spelled either literally or as `{ repeat: [text, times] }`. */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  const [t, times] = (value as { repeat: [string, number] }).repeat;
  return t.repeat(times);
}
type RepoStep = Record<string, unknown>;

/** The ops runAgentCoreOp answers. */
export const AGENT_CORE_OPS: ReadonlySet<string> = new Set([
  'parseNumstatZ', 'splitPatch', 'pairPatches', 'workingDiffFiles', 'mergeWorkflow', 'workflowFiles',
  'sameWorkspace', 'findWorkspaceKey',
  'parseInitializeReply', 'mergeWithAliases', 'parseOpencodeModels', 'parseCopilotModels',
]);

/**
 * Every comment a merged file carries, sorted: a line's text from a `#` that
 * starts it or follows a space. Crude (a `#` inside a quoted scalar counts),
 * but both sides apply the same rule to text that should hold the same
 * scalars.
 */
export function commentsOf(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#')) out.push(trimmed);
    else if (line.includes(' #')) out.push(line.slice(line.indexOf(' #') + 1));
  }
  return out.sort();
}

/**
 * mergeWorkflow's output is compared by meaning, not bytes (docs/migration.md,
 * Phase 3): the workflow it parses back to, and the comments it kept.
 */
function mergeResult(text: string): unknown {
  let workflow: unknown;
  try {
    workflow = parseWorkflow(text);
  } catch (e) {
    workflow = { error: (e as Error).message };
  }
  return { workflow, comments: commentsOf(text) };
}

const GIT_ID = ['-c', 'user.email=parity@whiphand', '-c', 'user.name=parity'];

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

/**
 * Plays a repo script into `dir`. `git: false` leaves it a plain directory.
 * Steps: `write: [path, text]` (text may be a `repeat`), `bytes: [path, base64]`, `rm: path`,
 * `mv: [from, to]`, `commit: message`.
 */
export function buildRepo(dir: string, op: Op): void {
  if (op.git !== false) {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'core.autocrlf', 'false']);
    git(dir, ['config', 'core.safecrlf', 'false']);
  }
  for (const step of (op.repo ?? []) as RepoStep[]) {
    if ('write' in step || 'bytes' in step) {
      const [rel, body] = (step.write ?? step.bytes) as [string, unknown];
      const file = path.join(dir, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'write' in step ? text(body) : Buffer.from(body as string, 'base64'));
    } else if ('rm' in step) {
      rmSync(path.join(dir, step.rm as string), { recursive: true, force: true });
    } else if ('mv' in step) {
      const [from, to] = step.mv as [string, string];
      renameSync(path.join(dir, from), path.join(dir, to));
    } else if ('commit' in step) {
      git(dir, ['add', '-A']);
      git(dir, [...GIT_ID, 'commit', '-q', '--allow-empty', '-m', step.commit as string]);
    } else {
      throw new Error(`unknown repo step ${JSON.stringify(step)}`);
    }
  }
}

/**
 * A patch past 2,000 UTF-16 units is recorded as its length and its two
 * ends, so the golden does not carry megabytes the input already holds.
 */
function abbreviate<T>(diff: T): T {
  if (diff === null || typeof diff !== 'object' || !('files' in diff)) return diff;
  const files = (diff as { files: Array<{ patch?: string }> }).files.map(f =>
    f.patch !== undefined && f.patch.length > 2000
      ? { ...f, patch: `<${f.patch.length}: ${f.patch.slice(0, 40)}…${f.patch.slice(-40)}>` }
      : f);
  return { ...diff, files };
}

/**
 * Plays a script of workflow-file calls against a temp workspace (`<root>/ws`)
 * and config home (`<root>/home`), then summarizes every workflow file left
 * in either scope the way `mergeWorkflow` results are compared.
 */
async function workflowFilesOp(op: Op): Promise<unknown> {
  const root = mkdtempSync(path.join(tmpdir(), 'whiphand-wffiles-'));
  const ws = path.join(root, 'ws');
  const home = path.join(root, 'home');
  mkdirSync(ws);
  const prev = process.env.WHIPHAND_CONFIG_HOME;
  process.env.WHIPHAND_CONFIG_HOME = home;
  try {
    const results: unknown[] = [];
    for (const step of op.script as Array<Record<string, unknown>>) {
      if ('writeFile' in step) {
        const [rel, body] = step.writeFile as [string, string];
        const file = path.join(root, rel);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, body);
        continue;
      }
      const scope = (step.scope ?? 'project') as Scope;
      const name = step.name as string;
      try {
        switch (step.call) {
          case 'create': results.push(await createWorkflow(ws, name, scope)); break;
          case 'update': results.push(await updateWorkflow(ws, name, step.workflow as Workflow, scope)); break;
          case 'delete': results.push(await deleteWorkflow(ws, name, scope)); break;
          case 'clone': results.push(await cloneWorkflow(ws, name, step.to as string, scope)); break;
          default: throw new Error(`unknown workflowFiles call ${String(step.call)}`);
        }
      } catch (e) {
        results.push({ error: (e as Error).message });
      }
    }
    const files: Record<string, unknown> = {};
    for (const dir of ['ws/.whiphand/workflows', 'home/workflows']) {
      let names: string[] = [];
      try {
        names = readdirSync(path.join(root, dir)).sort();
      } catch { /* the scope was never written */ }
      for (const f of names) files[`${dir}/${f}`] = mergeResult(readFileSync(path.join(root, dir, f), 'utf8'));
    }
    return JSON.parse(normalizeText(JSON.stringify({ results, files }), root));
  } finally {
    if (prev === undefined) delete process.env.WHIPHAND_CONFIG_HOME;
    else process.env.WHIPHAND_CONFIG_HOME = prev;
    rmSync(root, { recursive: true, force: true });
  }
}

export async function runAgentCoreOp(op: Op): Promise<unknown> {
  switch (op.op) {
    case 'parseNumstatZ': return parseNumstatZ(op.stdout as string);
    case 'splitPatch': return splitPatch(op.patch as string);
    case 'pairPatches': return abbreviate(pairPatches(op.entries as Parameters<typeof pairPatches>[0], (op.chunks as unknown[]).map(text)));
    case 'workingDiffFiles': {
      const dir = mkdtempSync(path.join(tmpdir(), 'whiphand-diffrepo-'));
      try {
        buildRepo(dir, op);
        try {
          return { ok: abbreviate(await workingDiffFiles(dir, (op.maxFiles as number | undefined) ?? 500)) };
        } catch (e) {
          return { error: (e as Error).message };
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    case 'workflowFiles': return workflowFilesOp(op);
    case 'parseInitializeReply': return parseInitializeReply(op.line as string);
    case 'mergeWithAliases': return mergeWithAliases(op.live as ModelInfo[]);
    case 'parseOpencodeModels': return parseOpencodeModels(op.output as string);
    case 'parseCopilotModels': return parseCopilotModels(op.help as string);
    case 'sameWorkspace': return sameWorkspace(op.a as { path: string }, op.b as { path: string });
    case 'findWorkspaceKey': return findWorkspaceKey(
      Object.fromEntries(op.records as Array<[string, { identityKey?: string }]>), op.workspace as { path: string }) ?? null;
    case 'mergeWorkflow': return mergeResult(mergeWorkflow(op.text as string, op.workflow as Workflow));
    default: throw new Error(`unknown agent-core op '${op.op}'`);
  }
}
