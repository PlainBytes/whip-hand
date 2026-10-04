/**
 * The TypeScript half of the core parity harness (Phase 1 of docs/migration.md).
 * `crates/whiphand-core/src/parity.rs` is the Rust half: both run the same JSON
 * ops from `parity/fixtures/core/suites/` and must reproduce the checked-in
 * results in `parity/fixtures/core/golden/` byte for byte.
 *
 * Results are canonical JSON (keys sorted, compact), one per line. Paths below
 * the repo root are written as `<repo>/…` with forward slashes, so one golden
 * serves every OS. One thing is deliberately not compared: the text of a YAML
 * syntax error, which each side's parser words its own way. Only *that* the
 * document failed to parse is a parity target.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  validateWorkflowDraft, validateWorkflowWarnings, unattendedProblems, WorkflowError,
} from '../packages/core/src/schema.ts';
import {
  renderTemplate, renderReferences, bindings, referencedRefs, artifactEnvName, inputEnvName,
} from '../packages/core/src/template.ts';
import type { TemplateScope } from '../packages/core/src/template.ts';
import {
  loadConfigLayer, mergeConfig, diffConfigLayer, loadWorkspaceConfig,
} from '../packages/core/src/config.ts';
import type { ConfigKey, PartialConfig } from '../packages/core/src/config.ts';
import { resolveWorkflowPath, listWorkflows, parseInputPairs } from '../packages/core/src/workspace.ts';
import { validateSegment, validateRelativePath } from '../packages/core/src/segment.ts';
import { workflowNameProblem } from '../packages/core/src/workflow-name.ts';
import type { WorkspaceConfig } from '../packages/core/src/types.ts';
import { runStoreOp } from './store-probe.ts';
import { PROCESS_OPS, runProcessOp } from './process-probe.ts';
import { ADAPTER_OPS, runAdapterOp } from './adapter-probe.ts';
import { ENGINE_OPS, runEngineOp } from './engine-probe.ts';
import { AGENT_CORE_OPS, runAgentCoreOp } from './agent-core-probe.ts';

export const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
export const CORE_FIXTURES = path.join(REPO, 'parity', 'fixtures', 'core');
export const SUITES_DIR = path.join(CORE_FIXTURES, 'suites');
export const GOLDEN_DIR = path.join(CORE_FIXTURES, 'golden');

const YAML_ERROR_PREFIX = 'invalid workflow:\n  - YAML parse error: ';

export type Op = Record<string, unknown> & { op: string };

/** Recursively sorts object keys (arrays keep their order) and drops `undefined`, as JSON would. */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) sorted[key] = sortKeysDeep(v);
    }
    return sorted;
  }
  return value;
}

/** The one line a result is compared as. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/** A suite or golden file: a JSON array with one compact entry per line, so diffs read line by line. */
export function formatLines(lines: string[]): string {
  return lines.length === 0 ? '[]\n' : `[\n${lines.join(',\n')}\n]\n`;
}

export function readLines(file: string): string[] {
  return (JSON.parse(readFileSync(file, 'utf8')) as unknown[]).map(canonical);
}

function str(op: Op, key: string): string {
  const v = op[key];
  if (typeof v !== 'string') throw new Error(`op ${JSON.stringify(op)} needs a string '${key}'`);
  return v;
}

function at(op: Op, key: string): string {
  return path.join(REPO, str(op, key));
}

function segmentResult(r: ReturnType<typeof validateSegment>): unknown {
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}

function validateWorkflow(raw: unknown): unknown {
  const result = validateWorkflowDraft(raw);
  const out: Record<string, unknown> = { problems: result.problems, fieldProblems: result.fieldProblems };
  if (result.workflow !== undefined) {
    out.workflow = result.workflow;
    out.warnings = validateWorkflowWarnings(result.workflow);
    out.unattended = unattendedProblems(result.workflow);
  }
  return out;
}

/** Whether a file exists and is not YAML — the one error whose wording the two sides don't share. */
function isBadYaml(file: string): boolean {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  try {
    parseYaml(text);
    return false;
  } catch {
    return true;
  }
}

function configError(e: unknown): unknown {
  if (e instanceof WorkflowError) return { problems: e.problems };
  throw e;
}

/** Runs `fn` with WHIPHAND_CONFIG_HOME pointed at `configHome`, the way the CLI and agent find it. */
async function withConfigHome<T>(configHome: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.WHIPHAND_CONFIG_HOME;
  process.env.WHIPHAND_CONFIG_HOME = configHome;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.WHIPHAND_CONFIG_HOME;
    else process.env.WHIPHAND_CONFIG_HOME = prev;
  }
}

async function runRaw(op: Op): Promise<unknown> {
  switch (op.op) {
    case 'validateSegment': return segmentResult(validateSegment(str(op, 'name')));
    case 'validateRelativePath': return segmentResult(validateRelativePath(str(op, 'path')));
    case 'workflowNameProblem': return workflowNameProblem(str(op, 'name'));

    case 'validateWorkflow': {
      if ('draft' in op) return validateWorkflow(op.draft);
      const text = 'yaml' in op ? str(op, 'yaml') : readFileSync(at(op, 'file'), 'utf8');
      let raw: unknown;
      try {
        raw = parseYaml(text);
      } catch {
        return { yamlError: true };
      }
      return validateWorkflow(raw);
    }

    case 'renderTemplate':
      try {
        return { text: renderTemplate(str(op, 'tpl'), op.scope as TemplateScope) };
      } catch (e) {
        return { error: (e as Error).message };
      }
    case 'renderReferences':
      try {
        return renderReferences(str(op, 'tpl'), op.scope as TemplateScope);
      } catch (e) {
        return { error: (e as Error).message };
      }
    case 'bindings':
      try {
        return { bindings: bindings(op.scope as TemplateScope) };
      } catch (e) {
        return { error: (e as Error).message };
      }
    case 'referencedRefs': return referencedRefs(str(op, 'tpl'));
    case 'artifactEnvName': return artifactEnvName(str(op, 'id'));
    case 'inputEnvName': return inputEnvName(str(op, 'key'));

    case 'loadConfigLayer': {
      if (isBadYaml(at(op, 'file'))) return { yamlError: true };
      try {
        return { layer: await loadConfigLayer(at(op, 'file')) };
      } catch (e) {
        return configError(e);
      }
    }
    case 'mergeConfig':
      return mergeConfig(op.base as WorkspaceConfig, ...(op.layers as PartialConfig[]));
    case 'diffConfigLayer':
      return diffConfigLayer(op.full as WorkspaceConfig, op.base as WorkspaceConfig, (op.explicit ?? []) as ConfigKey[]);
    case 'loadWorkspaceConfig': {
      const workspace = at(op, 'workspace');
      const configHome = at(op, 'configHome');
      if (isBadYaml(path.join(configHome, 'config.yaml')) || isBadYaml(path.join(workspace, '.whiphand', 'config.yaml'))) {
        return { yamlError: true };
      }
      try {
        return { config: await withConfigHome(configHome, () => loadWorkspaceConfig(workspace)) };
      } catch (e) {
        return configError(e);
      }
    }

    case 'parseInputPairs':
      try {
        return { inputs: parseInputPairs(op.pairs as string[]) };
      } catch (e) {
        return { error: (e as Error).message };
      }
    case 'resolveWorkflowPath':
      try {
        return await withConfigHome(at(op, 'configHome'), () => resolveWorkflowPath(str(op, 'ref'), at(op, 'workspace')));
      } catch (e) {
        return { error: (e as Error).message };
      }
    case 'listWorkflows': {
      const entries = await withConfigHome(at(op, 'configHome'), () => listWorkflows(at(op, 'workspace')));
      return entries.map(e => ({
        ...e,
        error: e.error?.startsWith(YAML_ERROR_PREFIX) ? '<yaml error>' : e.error,
      }));
    }
    case 'journal':
    case 'runs':
    case 'runLog':
      return runStoreOp(op);
    default:
      if (PROCESS_OPS.has(op.op)) return runProcessOp(op);
      if (ADAPTER_OPS.has(op.op)) return runAdapterOp(op, REPO);
      if (ENGINE_OPS.has(op.op)) return runEngineOp(op, REPO);
      if (AGENT_CORE_OPS.has(op.op)) return runAgentCoreOp(op);
      throw new Error(`unknown parity op '${op.op}'`);
  }
}

/** Rewrites every string holding a path below the repo to the portable `<repo>/…` form. */
function normalizePaths(value: unknown): unknown {
  if (typeof value === 'string') return value.includes(REPO) ? value.split(REPO).join('<repo>').replace(/\\/g, '/') : value;
  if (Array.isArray(value)) return value.map(normalizePaths);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizePaths(v)]));
  }
  return value;
}

/** One op's result, as the canonical line the golden holds. */
export async function runOp(op: Op): Promise<string> {
  return canonical(normalizePaths(await runRaw(op)));
}
