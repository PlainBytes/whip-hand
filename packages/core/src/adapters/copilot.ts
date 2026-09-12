import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentStep, DetectResult, ModelInfo, ModelList, RunCtx, RunnerAdapter, SpawnSpec } from '../types.ts';
import { buildPrompt } from '../template.ts';
import { interactiveGuidance } from '../engine/interactive-guidance.ts';
import { endMarkerPath, shellPath } from '../engine/session-end.ts';
import { execRunner } from '../exec.ts';
import { parseToolVersion, PROBE_TIMEOUT_MS } from '../tools.ts';

/** `/exit` quits copilot cleanly, giving it the chance to flush its --share transcript. */
export const COPILOT_QUIT_SEQUENCE = '/exit\r';

export function transcriptPath(step: AgentStep, ctx: RunCtx): string {
  return `${ctx.runDir}/${step.id}-transcript.md`;
}

function modelArgs(step: AgentStep): string[] {
  return step.model ? ['--model', step.model] : [];
}
function effortArgs(step: AgentStep): string[] {
  return step.effort ? ['--effort', step.effort] : [];
}
function spec(ctx: RunCtx, argv: string[], interactive: boolean): SpawnSpec {
  return { argv, cwd: ctx.workdir, env: {}, interactive };
}

/**
 * copilot has no hooks, so the terminal bell is the only way it can tell
 * whiphand that it wants the human — and `beep` is off by default.
 *
 * Read-only, and never near the credentials that live in the same directory:
 * we report the situation and let the user decide.
 */
async function beepNote(): Promise<string[]> {
  const home = process.env.COPILOT_HOME ?? join(homedir(), '.copilot');
  try {
    const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as { beep?: unknown };
    if (config.beep === true) return [];
  } catch {
    // no config yet, or unreadable: the default is off either way
  }
  return [`copilot will not signal when it needs you; set "beep": true in ${join(home, 'config.json')}`];
}

/** The heading line `copilot help config` prints ahead of its model id list. */
const MODEL_HEADING_RE = /`model`:/;
/** One indented `- "id"` line under that heading. */
const MODEL_LINE_RE = /^\s*-\s*"([^"]+)"/;

/**
 * Pure text parser, kept apart from the spawn so a captured fixture can
 * exercise it with no process involved. Reads only the lines between the
 * `` `model`: `` heading and the next blank line — copilot has no structured
 * flag for this, so `help config`'s prose *is* the interface, and a changed
 * format must degrade to no suggestions rather than misreading noise as ids.
 *
 * `auto` is appended because it is real and selectable but not in this list
 * (it means "let copilot pick"), and BYOK provider ids never appear here
 * either — both are why this always merges into a `ModelList`, never claims
 * completeness.
 */
export function parseCopilotModels(helpOutput: string): ModelInfo[] {
  const lines = helpOutput.split('\n');
  const heading = lines.findIndex(line => MODEL_HEADING_RE.test(line));
  if (heading === -1) return [];
  const ids: string[] = [];
  for (let i = heading + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') break;
    const match = MODEL_LINE_RE.exec(line);
    if (match) ids.push(match[1]);
  }
  if (ids.length === 0) return [];
  return [...ids.map(id => ({ id })), { id: 'auto' }];
}

export const copilotAdapter: RunnerAdapter = {
  id: 'copilot',
  // --session-id RESUMES on copilot; it cannot mint. Interactive harvest goes via --share.
  capabilities: { sessionIdInjection: false, sessionResume: true, toolDenial: true, shareTranscript: true },

  async detect(): Promise<DetectResult> {
    try {
      const { stdout, stderr } = await execRunner(['copilot', '--version'], { timeout: PROBE_TIMEOUT_MS });
      return {
        installed: true,
        version: parseToolVersion(stdout, stderr),
        notes: await beepNote(),
      };
    } catch {
      return { installed: false };
    }
  },

  interactive(step: AgentStep, ctx: RunCtx): SpawnSpec {
    const marker = endMarkerPath(ctx.runDir, step.id);
    // copilot has no system-prompt flag, so the guidance rides in front of the
    // task prompt; the separator keeps the two from bleeding into each other.
    const argv = [
      'copilot', '-i', `${interactiveGuidance(step, ctx)}\n\n---\n\n${buildPrompt(step, ctx)}`,
      ...modelArgs(step), ...effortArgs(step),
      ...(step.writes ? [] : ['--deny-tool=write']),
      `--allow-tool=shell(touch ${shellPath(marker)})`,
      `--share=${transcriptPath(step, ctx)}`,
    ];
    return {
      ...spec(ctx, argv, true),
      endSession: { markerPath: marker, quitSequence: COPILOT_QUIT_SEQUENCE },
    };
  },

  headless(step: AgentStep, ctx: RunCtx): SpawnSpec {
    const argv = [
      'copilot', '-p', buildPrompt(step, ctx),
      ...modelArgs(step), ...effortArgs(step),
      '--allow-all-tools',
      ...(step.writes ? [] : ['--deny-tool=write']),
      '--output-format', 'json', '--stream', 'on',
      '--no-color',
    ];
    return { ...spec(ctx, argv, false), progress: { format: 'copilot-jsonl' } };
  },

  /** See claudeAdapter.suggestName — same contract, copilot's flags. */
  suggestName(prompt: string, ctx: RunCtx, capturePath: string): SpawnSpec {
    const argv = [
      'copilot', '-p', prompt,
      '--model', 'gpt-5-mini', '--deny-tool=write', '--deny-tool=shell',
      '--no-color',
    ];
    return { ...spec(ctx, argv, false), capture: { path: capturePath, streams: 'stdout' } };
  },

  harvest(step: AgentStep, ctx: RunCtx): SpawnSpec {
    const prompt =
      `Read the planning transcript at ${transcriptPath(step, ctx)} and write the final ` +
      `'${step.output}' artifact that was agreed in it to ${ctx.runDir}/${step.output}. ` +
      `Write only the artifact content to that file, then reply with just: done`;
    return spec(ctx, ['copilot', '-p', prompt, '--allow-all-tools', '--no-color'], false);
  },

  /**
   * copilot has no `--list-models` flag; `help config`'s prose is the only
   * source. `source: 'unavailable'` (not 'fallback') on any failure — copilot
   * has no static aliases of its own to fall back to, and 'unavailable' is
   * what tells the editor to show plain free text with no warnings, exactly
   * as it did before this existed.
   */
  async listModels(): Promise<ModelList> {
    try {
      const { stdout } = await execRunner(['copilot', 'help', 'config'], { timeout: PROBE_TIMEOUT_MS });
      const models = parseCopilotModels(stdout);
      if (models.length === 0) return { source: 'unavailable', models: [] };
      return { source: 'live', models };
    } catch {
      return { source: 'unavailable', models: [] };
    }
  },
};
