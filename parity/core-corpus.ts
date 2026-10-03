/**
 * The generated part of the core parity corpus. `regenerate-core-golden.ts`
 * writes these suites next to the hand-written ones, so both implementations
 * read the same op lists from disk and neither has to know how they were made.
 *
 * - `workflow-files`: every workflow YAML the repo ships or keeps as a fixture.
 * - `schema-tests`: every input `packages/core/src/schema.test.ts` hands to
 *   `parseWorkflow` or `validateWorkflowDraft`, captured by running that test
 *   file against a recording shim — the TS suite's own cases, verbatim.
 * - `mutants`: the kitchen-sink workflow, broken one field at a time in every
 *   way a hand-written YAML file can break it. Broad, cheap coverage of the
 *   exact order and wording of zod's issues.
 * - `store-runs` and `store-journal`: the run store (see store-corpus.ts).
 * - `process` and `globs`: launching processes and the git guard (see process-corpus.ts).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { CORE_FIXTURES, REPO, canonical } from './core-probe.ts';
import type { Op } from './core-probe.ts';
import { storeJournalOps, storeRunsOps } from './store-corpus.ts';
import { PROCESS_SUITES } from './process-corpus.ts';

const WORKFLOW_DIRS = [
  'parity/fixtures/core/workflows',
  'examples',
  'packages/core/templates',
  'parity/fixtures/workspace/.whiphand/workflows',
];

export function workflowFileOps(): Op[] {
  return WORKFLOW_DIRS.flatMap(dir => readdirSync(path.join(REPO, dir))
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort()
    .map(f => ({ op: 'validateWorkflow', file: `${dir}/${f}` })));
}

const SCHEMA_SRC = path.join(REPO, 'packages', 'core', 'src');

/**
 * Runs schema.test.ts with `./schema.ts` swapped for a shim that records every
 * input, then deletes both temp files. The shim's own exports shadow the
 * star re-export, so every other import the test makes is the real thing.
 */
export function schemaTestOps(): Op[] {
  const out = mkdtempSync(path.join(tmpdir(), 'whiphand-capture-'));
  const record = path.join(out, 'inputs.json');
  const shim = path.join(SCHEMA_SRC, '.parity-capture-schema.ts');
  const test = path.join(SCHEMA_SRC, '.parity-capture.test.ts');
  writeFileSync(shim, `import { writeFileSync } from 'node:fs';
import * as real from './schema.ts';
export * from './schema.ts';
const seen: unknown[] = [];
process.on('exit', () => writeFileSync(${JSON.stringify(record)}, JSON.stringify(seen)));
export function parseWorkflow(yaml: string) { seen.push({ yaml }); return real.parseWorkflow(yaml); }
export function validateWorkflowDraft(draft: unknown) { seen.push({ draft: draft === undefined ? null : draft }); return real.validateWorkflowDraft(draft); }
`);
  const source = readFileSync(path.join(SCHEMA_SRC, 'schema.test.ts'), 'utf8');
  writeFileSync(test, source.replaceAll("from './schema.ts'", "from './.parity-capture-schema.ts'"));
  try {
    // Run as a plain script (node:test runs a file's tests on its own), and
    // without the parent runner's NODE_TEST_CONTEXT: under `node --test` that
    // variable turns the child into a reporter-protocol subprocess.
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;
    execFileSync(process.execPath, [test], { stdio: 'pipe', env });
    const inputs = JSON.parse(readFileSync(record, 'utf8')) as Array<Record<string, unknown>>;
    const unique = new Map<string, Op>();
    for (const input of inputs) {
      const op = { op: 'validateWorkflow', ...input };
      unique.set(canonical(op), op);
    }
    return [...unique.values()];
  } finally {
    rmSync(shim, { force: true });
    rmSync(test, { force: true });
    rmSync(out, { recursive: true, force: true });
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** What a field can be replaced with: every JSON type, blank strings, and the numbers zod treats specially. */
const REPLACEMENTS: Json[] = [null, '', '  ', 'x', 0, -1, 1.5, 9007199254740993, true, [], {}];

function clone<T extends Json>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function setAt(root: Json, at: Array<string | number>, mutate: (parent: Json[] | Record<string, Json>, key: string | number) => void): Json {
  const copy = clone(root);
  let node = copy as Json;
  for (const key of at.slice(0, -1)) node = (node as Record<string, Json>)[key as string];
  mutate(node as Json[] | Record<string, Json>, at.at(-1)!);
  return copy;
}

/** Every path to a value under `root`, depth first. */
function paths(node: Json, prefix: Array<string | number> = []): Array<Array<string | number>> {
  if (Array.isArray(node)) return node.flatMap((v, i) => [[...prefix, i], ...paths(v, [...prefix, i])]);
  if (node !== null && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => [[...prefix, k], ...paths(v, [...prefix, k])]);
  }
  return [];
}

export function mutantOps(): Op[] {
  const seed = parseYaml(readFileSync(path.join(CORE_FIXTURES, 'workflows', 'kitchen-sink.yaml'), 'utf8')) as Json;
  const drafts: Json[] = [];
  for (const at of paths(seed)) {
    const last = at.at(-1);
    drafts.push(setAt(seed, at, (parent, key) => {
      if (Array.isArray(parent)) parent.splice(key as number, 1);
      else delete parent[key as string];
    }));
    for (const value of REPLACEMENTS) {
      drafts.push(setAt(seed, at, (parent, key) => { (parent as Record<string, Json>)[key as string] = clone(value); }));
    }
    // A step object: give it a kind that does not exist, and a field another kind owns.
    if (typeof last === 'number' && at.at(-2) === 'steps') {
      drafts.push(setAt(seed, at, (parent, key) => { ((parent as Json[])[key as number] as Record<string, Json>).kind = 'nope'; }));
      drafts.push(setAt(seed, at, (parent, key) => { ((parent as Json[])[key as number] as Record<string, Json>).until = 'x'; }));
    }
  }
  return drafts.map(draft => ({ op: 'validateWorkflow', draft }));
}

/** Every generated suite, by file name (without `.json`). */
export const GENERATED_SUITES: Record<string, () => Op[]> = {
  'workflow-files': workflowFileOps,
  'schema-tests': schemaTestOps,
  mutants: mutantOps,
  'store-runs': storeRunsOps,
  'store-journal': storeJournalOps,
  ...PROCESS_SUITES,
};
