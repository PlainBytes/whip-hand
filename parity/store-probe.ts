/**
 * The TypeScript half of the run-store parity ops (Phase 2a of
 * docs/migration.md); `crates/whiphand-core/src/parity_store.rs` is the Rust
 * half. Two ops:
 *
 * - `journal`: seeds a RunJournal and plays a script of events (and
 *   reopens, renames, locks, listings) through it, then returns the bytes of
 *   `run.json`, `events.ndjson` and `run.log`. Key order is part of what is
 *   compared, because it is part of what the TS journal writes.
 * - `runs`: copies fixture run directories (`parity/fixtures/core/runs/`)
 *   into a workspace and calls one reader on them — list, get, rename,
 *   delete, prune — returning its result and every run dir's files after.
 *
 * What legitimately differs between two runs of the same op (timestamps,
 * pids, lease ids, the temp workspace path) is normalized the same way on
 * both sides; everything else must match byte for byte.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../packages/core/src/config.ts';
import { RunJournal, getRun, listRuns, renameRun } from '../packages/core/src/engine/manifest.ts';
import type { RunJournalInit } from '../packages/core/src/engine/manifest.ts';
import { deleteRun, pruneRuns } from '../packages/core/src/engine/retention.ts';
import { setRunLocked } from '../packages/core/src/engine/run-lock.ts';
import type { WhiphandEvent } from '../packages/core/src/types.ts';

type Op = Record<string, unknown> & { op: string };

export const RUN_FIXTURES = fileURLToPath(new URL('./fixtures/core/runs', import.meta.url));

const HEARTBEAT_NEVER_MS = 1_000_000_000;
const ARTIFACTS_DIR = DEFAULT_CONFIG.artifacts_dir;

const TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g;
const PID = /"pid": \d+/g;
const SCOPE = /"pidScope": "[^"]*"/g;
const WS_TOKEN = /<WS>[^"\s]*/g;

/**
 * The one normalization both halves apply to every string they return. The
 * workspace path goes first (escaped as JSON writes it, then raw, then in `/`
 * form), and whatever path follows it is turned to `/` so a Windows run and a
 * POSIX one land on the same text. Then timestamps, pids, scopes, uuids.
 */
export function normalizeText(text: string, ws: string): string {
  const escaped = JSON.stringify(ws).slice(1, -1);
  return text
    .split(escaped).join('<WS>')
    .split(ws).join('<WS>')
    .split(ws.replace(/\\/g, '/')).join('<WS>')
    .replace(WS_TOKEN, token => token.replace(/\\\\/g, '/').replace(/\\/g, '/'))
    .replace(TS, '<TS>')
    .replace(PID, '"pid": <PID>')
    .replace(SCOPE, '"pidScope": "<SCOPE>"')
    .replace(UUID, '<UUID>');
}

function normalizeValue(value: unknown, ws: string): unknown {
  if (typeof value === 'string') return normalizeText(value, ws);
  if (Array.isArray(value)) return value.map(v => normalizeValue(v, ws));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([k]) => k !== 'mtimeMs')
      .map(([k, v]) => [k, normalizeValue(v, ws)]));
  }
  return value;
}

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function workspace(): string {
  return mkdtempSync(path.join(tmpdir(), 'whiphand-store-'));
}

async function journalOp(op: Op): Promise<unknown> {
  const ws = workspace();
  try {
    const runId = op.runId as string;
    const runDir = path.join(ws, ARTIFACTS_DIR, runId);
    mkdirSync(runDir, { recursive: true });
    const knobs = {
      heartbeatIntervalMs: HEARTBEAT_NEVER_MS,
      ...(op.capBytes === undefined ? {} : { runLogCapBytes: op.capBytes as number }),
    };
    const init: RunJournalInit = {
      runDir, runId, workdir: ws,
      workflow: op.workflow as string,
      dryRun: op.dryRun as boolean,
      ...(op.workflowSource === undefined ? {} : { workflowSource: op.workflowSource as 'project' | 'global' }),
      inputs: op.inputs as Record<string, string>,
      ...(op.attachments === undefined ? {} : { attachments: op.attachments as RunJournalInit['attachments'] }),
      sessionIds: op.sessionIds as Record<string, string>,
      steps: op.steps as RunJournalInit['steps'],
      ...knobs,
    };
    let journal = new RunJournal(init);
    const lists: unknown[] = [];
    for (const entry of op.script as Array<Record<string, unknown>>) {
      if ('event' in entry) {
        journal.record(entry.event as WhiphandEvent);
      } else if ('reopen' in entry) {
        await journal.flush();
        journal.close();
        const detail = await getRun(ws, DEFAULT_CONFIG, runId);
        if (detail === null || detail.status === 'unknown') throw new Error('reopen: no readable run');
        const sub = (entry.reopen as { workdir?: string }).workdir;
        journal = RunJournal.reopen(runDir, detail, {
          ...knobs,
          ...(sub === undefined ? {} : { workdir: path.join(ws, sub) }),
        });
      } else if ('stoppedTree' in entry) {
        journal.noteStoppedTree(entry.stoppedTree as string);
      } else if ('writeFile' in entry) {
        const { path: rel, content } = entry.writeFile as { path: string; content: string };
        const file = path.join(runDir, rel);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, content);
      } else if ('rename' in entry) {
        await renameRun(ws, DEFAULT_CONFIG, runId, entry.rename as string | null);
      } else if ('lock' in entry) {
        await setRunLocked(runDir, entry.lock as boolean);
      } else if ('list' in entry) {
        await journal.flush();
        const runs = await listRuns(ws, DEFAULT_CONFIG);
        lists.push(runs.map(r => ({ runId: r.runId, status: r.status, locked: r.locked, name: r.name })));
      } else {
        throw new Error(`unknown journal script entry ${JSON.stringify(entry)}`);
      }
    }
    await journal.flush();
    journal.close();
    return normalizeValue({
      runJson: readOrNull(path.join(runDir, 'run.json')),
      events: readOrNull(path.join(runDir, 'events.ndjson')),
      runLog: readOrNull(path.join(runDir, 'run.log')),
      lists,
    }, ws);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

async function runsOp(op: Op): Promise<unknown> {
  const ws = workspace();
  try {
    const runsDir = path.join(ws, ARTIFACTS_DIR);
    mkdirSync(runsDir, { recursive: true });
    const fixtures = op.fixtures as string[];
    for (const name of fixtures) cpSync(path.join(RUN_FIXTURES, name), path.join(runsDir, name), { recursive: true });
    let value: unknown;
    switch (op.call) {
      case 'list': value = await listRuns(ws, DEFAULT_CONFIG); break;
      case 'get': value = await getRun(ws, DEFAULT_CONFIG, op.runId as string); break;
      case 'rename': value = await renameRun(ws, DEFAULT_CONFIG, op.runId as string, op.name as string | null); break;
      case 'delete': value = await deleteRun(ws, DEFAULT_CONFIG, op.runId as string); break;
      case 'prune': value = await pruneRuns(ws, DEFAULT_CONFIG, op.max as number | null); break;
      default: throw new Error(`unknown runs call '${String(op.call)}'`);
    }
    const files: Record<string, unknown> = {};
    for (const name of fixtures) {
      const dir = path.join(runsDir, name);
      files[name] = existsSync(dir)
        ? {
            runJson: readOrNull(path.join(dir, 'run.json')),
            fence: readOrNull(path.join(dir, '.fenced')),
            name: readOrNull(path.join(dir, '.name')),
            entries: readdirSync(dir).sort(),
          }
        : null;
    }
    return normalizeValue({ value: value ?? null, files }, ws);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

/** The store ops, or undefined for an op this module does not own. */
export async function runStoreOp(op: Op): Promise<unknown> {
  switch (op.op) {
    case 'journal': return journalOp(op);
    case 'runs': return runsOp(op);
    default: return undefined;
  }
}
