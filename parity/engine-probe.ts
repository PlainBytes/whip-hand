/**
 * The TypeScript half of the engine parity ops (Phase 2d of
 * docs/migration.md); `crates/whiphand-core/src/parity_engine.rs` is the
 * Rust half. Pure pieces of the run engine: the workflow snapshot's YAML,
 * verdicts, artifact paths, stage discovery, attachment naming, command
 * specs, manual requests and the enabled/disabled pruning.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { parseWorkflow } from '../packages/core/src/schema.ts';
import { DEFAULT_CONFIG } from '../packages/core/src/config.ts';
import { defaultRegistry } from '../packages/core/src/registry.ts';
import { runWorkflow } from '../packages/core/src/engine/runner.ts';
import { planResume } from '../packages/core/src/engine/resume.ts';
import { pipeChild, routeHeadless, spawnRunner } from '../packages/core/src/exec.ts';
import type { Frontend, ManualResponse, SpawnSpec, WhiphandEvent } from '../packages/core/src/types.ts';
import { normalizeText } from './store-probe.ts';

type Op = Record<string, unknown> & { op: string };

/** The ops runEngineOp answers. */
export const ENGINE_OPS: ReadonlySet<string> = new Set(['stringifyYaml', 'workflowSnapshot', 'runWorkflow']);

/** Every file under `dir` but dotfiles and the run's own logs, `/`-relative, sorted. */
function bundle(dir: string, prefix = ''): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const entry of readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...bundle(dir, rel));
    else if (rel !== 'run.log' && rel !== 'events.ndjson') out.push([rel, readFileSync(path.join(dir, rel), 'utf8')]);
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * One whole run through the engine, with a scripted frontend: events as
 * their exact JSON (run:env, which races the steps by design, left out),
 * the run's run.json and every artifact. The workspace is a fresh temp dir
 * holding `files`; every declared input without a default gets a value.
 */
async function runWorkflowOp(op: Op, repo: string): Promise<unknown> {
  return withTempDir(async ws => {
    for (const [rel, content] of Object.entries((op.files ?? {}) as Record<string, string>)) {
      mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
      writeFileSync(path.join(ws, rel), content);
    }
    const text = 'yaml' in op ? op.yaml as string : readFileSync(path.join(repo, op.file as string), 'utf8');
    let workflow;
    try {
      workflow = parseWorkflow(text);
    } catch {
      return { invalid: true };
    }
    const inputs: Record<string, string> = {};
    for (const [k, def] of Object.entries(workflow.inputs ?? {})) if (def.default === undefined) inputs[k] = `value-${k}`;
    const events: string[] = [];
    const answers = [...((op.answers ?? []) as ManualResponse[])];
    const frontend: Frontend = {
      runInteractive: async () => 0,
      runManual: async () => answers.shift() ?? { choice: 'continue' },
      onEvent: (e: WhiphandEvent) => { if (e.type !== 'run:env') events.push(JSON.stringify(e)); },
    };
    const spawnHeadless = (spec: SpawnSpec, signal?: AbortSignal, onLine?: (l: string, s: 'stdout' | 'stderr') => void): Promise<number> => {
      const child = spawnRunner(spec.argv, { cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      return pipeChild(child, { onLine, capture: routeHeadless(spec, onLine !== undefined).capture, signal, onAbort: c => { c.kill(); } });
    };
    const config = { ...DEFAULT_CONFIG, runs: { ...DEFAULT_CONFIG.runs, max_retained: null } };
    let outcome: unknown;
    let runDir: string | undefined;
    try {
      const r = await runWorkflow({
        workflow, workdir: ws, inputs, config,
        registry: defaultRegistry(), frontend, dryRun: op.dryRun === true, spawnHeadless, workflowSource: 'project',
        ...(op.name === undefined ? {} : { name: op.name as string }),
        ...(op.maxIterations === undefined ? {} : { maxIterations: op.maxIterations as number }),
      });
      runDir = r.runDir;
      outcome = { ok: r.ok, verdict: r.verdict ?? null, cancelled: r.cancelled ?? false };
    } catch (e) {
      outcome = { error: (e as Error).message };
      const runs = path.join(ws, '.whiphand', 'runs');
      try { runDir = path.join(runs, readdirSync(runs)[0]); } catch { /* refused before a run dir */ }
    }
    let resumed: unknown = null;
    if (op.resume !== undefined && runDir !== undefined) {
      const r = op.resume as { files?: Record<string, string>; extraIterations?: number };
      for (const [rel, content] of Object.entries(r.files ?? {})) writeFileSync(path.join(ws, rel), content);
      events.push('--- resume ---');
      try {
        const plan = await planResume(ws, config, path.basename(runDir),
          r.extraIterations === undefined ? undefined : { extraIterations: r.extraIterations });
        const again = await runWorkflow({
          workflow: plan.workflow, workdir: ws, inputs: plan.inputs, config, registry: defaultRegistry(), frontend,
          spawnHeadless, resume: plan,
        });
        resumed = {
          ok: again.ok, warnings: plan.warnings, restartAt: plan.restartAt ?? null,
          resumedStepIds: [...plan.resumedStepIds].sort(),
        };
      } catch (e) {
        resumed = { error: (e as Error).message };
      }
    }
    const runId = runDir === undefined ? '\u0000' : path.basename(runDir);
    const norm = (t: string): string => normalizeText(t.split(runId).join('<RUN_ID>'), ws);
    return {
      outcome: JSON.parse(norm(JSON.stringify(outcome))),
      resumed: JSON.parse(norm(JSON.stringify(resumed))),
      events: events.map(norm),
      files: runDir === undefined ? null : bundle(runDir).map(([rel, content]) => [norm(rel), norm(content)]),
    };
  });
}

export async function runEngineOp(op: Op, repo: string): Promise<unknown> {
  switch (op.op) {
    case 'stringifyYaml':
      return stringifyYaml(op.value);
    case 'workflowSnapshot': {
      const text = 'yaml' in op ? op.yaml as string : readFileSync(path.join(repo, op.file as string), 'utf8');
      try {
        return { snapshot: stringifyYaml(parseWorkflow(text)) };
      } catch {
        return { invalid: true };
      }
    }
    case 'runWorkflow':
      return runWorkflowOp(op, repo);
    default:
      return undefined;
  }
}

/** A scratch directory for ops that touch the disk, removed afterwards. */
export function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), 'whiphand-engine-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}
