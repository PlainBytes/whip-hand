import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentStep, DetectResult, RunCtx, RunnerAdapter, SpawnSpec } from '../types.ts';
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
};
