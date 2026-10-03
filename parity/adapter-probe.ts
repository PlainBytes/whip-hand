/**
 * The TypeScript half of the adapter and doctor parity ops (Phase 2c of
 * docs/migration.md); `crates/whiphand-core/src/parity_adapters.rs` is the
 * Rust half. Spawn specs are compared as the JS objects they are, key order
 * included, because events.ndjson records them verbatim. Paths are built
 * under a fixed per-OS workspace and normalized by store-probe's rules, so
 * one golden serves every OS.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { claudeAdapter, claudeAuthNote } from '../packages/core/src/adapters/claude.ts';
import { copilotAdapter, copilotAuthNote } from '../packages/core/src/adapters/copilot.ts';
import { opencodeAdapter, opencodeAuthNote } from '../packages/core/src/adapters/opencode.ts';
import type { AuthProbeDeps } from '../packages/core/src/adapters/auth.ts';
import { createProgressParser, progressErrorMessage } from '../packages/core/src/engine/progress.ts';
import { interactiveGuidance } from '../packages/core/src/engine/interactive-guidance.ts';
import { headlessPrompt } from '../packages/core/src/engine/headless-guidance.ts';
import { parseAwaitState } from '../packages/core/src/engine/await-state.ts';
import { buildPrompt, inputArtifacts } from '../packages/core/src/template.ts';
import { isOlderVersion, parseToolVersion, resolveToolTable } from '../packages/core/src/tools.ts';
import type { ToolStatus } from '../packages/core/src/tools.ts';
import { loadDoctorConfig } from '../packages/core/src/doctor-config.ts';
import { defaultRegistry, validateWorkflowFrontend, validateWorkflowRunners, validateWorkflowShell } from '../packages/core/src/registry.ts';
import { parseWorkflow, WorkflowError } from '../packages/core/src/schema.ts';
import { assertNotUnc, headroomWarning } from '../packages/core/src/canonicalize.ts';
import type { AgentStep, Frame, ProgressFormat, RunCtx, RunnerAdapter } from '../packages/core/src/types.ts';
import { normalizeText } from './store-probe.ts';
import { doctorReport } from '../packages/cli/src/commands/doctor.ts';

type Op = Record<string, unknown> & { op: string };

/** A workspace that never exists: specs only name paths, they touch none. */
export const WS = process.platform === 'win32' ? 'C:\\ws\\proj' : '/ws/proj';
const HOME = process.platform === 'win32' ? 'C:\\Users\\fake' : '/home/fake';

function normalize(value: unknown, root = WS): unknown {
  if (typeof value === 'string') return normalizeText(value, root);
  if (Array.isArray(value)) return value.map(v => normalize(v, root));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [normalize(k, root) as string, normalize(v, root)]));
  }
  return value;
}

/** The parts of a `step` op field the adapters read, as an AgentStep. */
function agentStep(raw: Record<string, unknown>): AgentStep {
  return { kind: 'agent', mode: 'headless', writes: false, prompt: '', output: 'out.md', runner: 'claude', ...raw } as AgentStep;
}

/** The `ctx` op field as a RunCtx under WS: artifact and attachment paths are run-relative. */
function runCtx(raw: Record<string, unknown>): RunCtx {
  const runId = (raw.runId as string | undefined) ?? '20240101-000000-abc';
  const runDir = raw.runDirOutside === true ? path.join(path.dirname(WS), 'elsewhere', runId) : path.join(WS, '.whiphand', 'runs', runId);
  const rel = (p: string): string => path.join(runDir, p);
  const frame = raw.frame as Frame | undefined;
  let loop = frame;
  while (loop !== undefined && 'kind' in loop && loop.kind === 'stages') loop = loop.parent;
  return {
    workdir: WS, runId, runDir,
    runSlug: (raw.runSlug as string | undefined) ?? runId,
    ...(raw.runName === undefined ? {} : { runName: raw.runName as string }),
    sessionIds: (raw.sessionIds ?? {}) as Record<string, string>,
    artifacts: Object.fromEntries(Object.entries((raw.artifacts ?? {}) as Record<string, string>).map(([k, v]) => [k, rel(v)])),
    attempts: {},
    verdicts: (raw.verdicts ?? {}) as Record<string, 'pass' | 'fail'>,
    inputs: (raw.inputs ?? {}) as Record<string, string>,
    ...(frame === undefined ? {} : { frame }),
    ...(loop === undefined ? {} : { loop: loop as RunCtx['loop'] }),
    ...(raw.resumed === undefined ? {} : { resumedStepIds: new Set(raw.resumed as string[]) }),
    ...(raw.attachments === undefined ? {} : { attachments: (raw.attachments as string[]).map(rel) }),
  };
}

const ADAPTERS: Record<string, RunnerAdapter> = { claude: claudeAdapter, copilot: copilotAdapter, opencode: opencodeAdapter };

function attempt(fn: () => unknown): unknown {
  try {
    return { ok: fn() };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** Auth-note deps over a fake home: `files` are home-relative, `{ error: 'other' }` an unreadable one. */
function authDeps(op: Op): AuthProbeDeps {
  const files = (op.files ?? {}) as Record<string, string | { error: string }>;
  const env = Object.fromEntries(Object.entries((op.env ?? {}) as Record<string, string>)
    .map(([k, v]) => [k, v.replace('$HOME', HOME)]));
  return {
    env, home: HOME, platform: (op.platform as NodeJS.Platform | undefined) ?? 'linux',
    readText: async (p: string) => {
      const key = p.startsWith(HOME) ? p.slice(HOME.length + 1).replace(/\\/g, '/') : p;
      const entry = files[key];
      if (entry === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      if (typeof entry !== 'string') throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return entry;
    },
    run: async () => {
      if (typeof op.run !== 'string') throw new Error('no answer');
      return op.run;
    },
  };
}

function workflowOf(op: Op): ReturnType<typeof parseWorkflow> {
  return parseWorkflow(op.yaml as string);
}

/** The ops runAdapterOp answers. */
export const ADAPTER_OPS: ReadonlySet<string> = new Set(['adapterSpec', 'progress', 'authNote', 'parseToolVersion', 'isOlderVersion', 'resolveToolTable', 'loadDoctorConfig', 'doctorReport', 'validateWorkflowRunners', 'validateWorkflowShell', 'validateWorkflowFrontend', 'buildPrompt', 'guidance', 'parseAwaitState', 'headroomWarning', 'assertNotUnc']);

export async function runAdapterOp(op: Op, repo: string): Promise<unknown> {
  switch (op.op) {
    case 'adapterSpec': {
      const adapter = ADAPTERS[op.runner as string];
      const step = agentStep(op.step as Record<string, unknown>);
      const ctx = runCtx((op.ctx ?? {}) as Record<string, unknown>);
      // As text: the key order is what events.ndjson records, and the golden sorts keys.
      const result = attempt(() => {
        switch (op.method) {
          case 'interactive': return JSON.stringify(adapter.interactive(step, ctx));
          case 'headless': return JSON.stringify(adapter.headless(step, ctx));
          case 'harvest': return JSON.stringify(adapter.harvest(step, ctx));
          default: return JSON.stringify(adapter.suggestName!(op.prompt as string, ctx, path.join(ctx.runDir, '.name.suggest')));
        }
      });
      return normalize(result);
    }
    case 'progress': {
      const format = op.format as ProgressFormat;
      const parse = createProgressParser(format);
      return (op.lines as string[]).map(line => ({
        progress: JSON.stringify(parse(line) ?? null),
        error: progressErrorMessage(format, line) ?? null,
      }));
    }
    case 'authNote': {
      const deps = authDeps(op);
      const note = op.runner === 'claude' ? claudeAuthNote(deps)
        : op.runner === 'copilot' ? copilotAuthNote(deps) : opencodeAuthNote(deps);
      try {
        return { note: (await note) ?? null };
      } catch {
        return { rejected: true };
      }
    }
    case 'parseToolVersion':
      return parseToolVersion(op.stdout as string, (op.stderr ?? '') as string, op.pattern as string | undefined) ?? null;
    case 'isOlderVersion':
      return isOlderVersion(op.version as string | undefined, op.min as string);
    case 'resolveToolTable':
      try {
        return resolveToolTable(defaultRegistry(), op.config as never).map(p => ({
          id: p.id, label: p.label, group: p.group, argv: p.argv, aliases: p.aliases ?? [],
          optional: p.optional ?? null, url: p.url ?? null,
        }));
      } catch (e) {
        if (e instanceof WorkflowError) return { problems: e.problems.map(p => p.replace(/^.*doctor\.yaml/, '<doctor.yaml>')) };
        throw e;
      }
    case 'loadDoctorConfig': {
      const file = path.join(repo, op.file as string);
      let text: string | undefined;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        // missing: loadDoctorConfig's own empty config
      }
      try {
        if (text !== undefined) parseYaml(text);
      } catch {
        return { yamlError: true };
      }
      try {
        const config = await loadDoctorConfig(file);
        return { config: {
          tools: config.tools?.map(t => ({
            id: t.id, label: t.label, group: t.group, argv: t.argv, aliases: t.aliases ?? [],
            versionPattern: t.versionPattern ?? null, optional: t.optional ?? null, url: t.url ?? null,
          })) ?? null,
          hide: config.hide ?? null,
        } };
      } catch (e) {
        if (!(e instanceof WorkflowError)) throw e;
        return { problems: e.problems.map(p => p.split(file).join(op.file as string)) };
      }
    }
    case 'doctorReport':
      return doctorReport(op.statuses as ToolStatus[]);
    case 'validateWorkflowRunners':
      return validateWorkflowRunners(workflowOf(op), defaultRegistry());
    case 'validateWorkflowShell':
      return validateWorkflowShell(workflowOf(op), op.shell as never);
    case 'validateWorkflowFrontend':
      return validateWorkflowFrontend(workflowOf(op), op.canRunManual ? { runManual: () => {} } : {});
    case 'buildPrompt': {
      const ctx = runCtx((op.ctx ?? {}) as Record<string, unknown>);
      return normalize(attempt(() => ({
        prompt: buildPrompt({ prompt: op.prompt as string, inputs: op.inputs as string[] | undefined }, ctx),
        inputs: inputArtifacts((op.inputs ?? []) as string[], ctx).map(i => ({ id: i.id, path: i.path ?? null })),
      })));
    }
    case 'guidance': {
      const step = agentStep(op.step as Record<string, unknown>);
      const ctx = runCtx((op.ctx ?? {}) as Record<string, unknown>);
      return normalize({ interactive: interactiveGuidance(step, ctx), headless: headlessPrompt(step, 'TASK') });
    }
    case 'parseAwaitState': {
      const r = parseAwaitState(op.raw as string);
      return r.kind === 'state' ? r.reason : null;
    }
    case 'headroomWarning':
      return headroomWarning(op.root as string);
    case 'assertNotUnc':
      return attempt(() => { assertNotUnc(op.input as string); return true; });
    default:
      return undefined;
  }
}
