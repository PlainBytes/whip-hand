import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentStep, DetectResult, ModelInfo, ModelList, RunCtx, RunnerAdapter, SpawnSpec } from '../types.ts';
import { buildPrompt } from '../template.ts';
import { interactiveGuidance } from '../engine/interactive-guidance.ts';
import { endMarkerPath } from '../engine/session-end.ts';
import { probeRunner } from '../tools.ts';
import { envOn, isMissingFile, liveAuthDeps, parseLenientJson, withAuthNote, type AuthProbeDeps } from './auth.ts';
import {
  flagArgs, harvestPrompt, isResumedStep, lf, listModelsVia, promptPointer, requireSessionId, spawnSpec,
} from './common.ts';
import { SUGGEST_PROMPT_NAME, harvestPromptPath, promptPath } from '../engine/spawn-files.ts';

/** `/exit` quits copilot cleanly. */
export const COPILOT_QUIT_SEQUENCE = '/exit\r';

function modelArgs(step: AgentStep): string[] {
  return flagArgs('--model', step.model);
}
function effortArgs(step: AgentStep): string[] {
  return flagArgs('--effort', step.effort);
}
function sessionId(step: AgentStep, ctx: RunCtx): string {
  return requireSessionId(step, ctx, 'minted');
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
  // User settings live in settings.json; config.json is copilot's own file
  // (it says so in a `//` header, which is also why plain JSON.parse fails on it).
  for (const name of ['settings.json', 'config.json']) {
    try {
      const text = await readFile(join(home, name), 'utf8');
      const config = parseLenientJson(text) as { beep?: unknown };
      if (config.beep === true) return [];
    } catch {
      // no file yet, or unreadable: the default is off either way
    }
  }
  return [`copilot will not signal when it needs you; set "beep": true in ${join(home, 'settings.json')}`];
}

/** `copilot help environment` (1.0.86): any of these is a token that takes precedence over stored credentials. */
const COPILOT_TOKEN_ENV = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];

/**
 * Whether copilot has no GitHub login to use. Signals, per copilot 1.0.86:
 *  - a token in the environment (above), which wins over anything stored;
 *  - `COPILOT_PROVIDER_BASE_URL`: bring-your-own-key mode, which the help text
 *    says needs no GitHub authentication at all;
 *  - `loggedInUsers` in `config.json` under COPILOT_HOME (default `~/.copilot`)
 *    — the login itself is in the keychain and this list records who.
 *
 * Verified: a fresh COPILOT_HOME has no `config.json` (still none after
 * `copilot --version` and `copilot help`), and a logged-in one has a
 * non-empty `loggedInUsers`. Not verified: what `copilot logout` leaves in
 * the file — hence "no config.json" and "`loggedInUsers` is an empty array"
 * are the only two answers that count as logged out. An absent key, or a file
 * we cannot read or parse, could be a version that names things differently,
 * and that says nothing.
 */
export async function copilotAuthNote(deps: AuthProbeDeps = liveAuthDeps()): Promise<string | undefined> {
  if (envOn(deps.env, ...COPILOT_TOKEN_ENV, 'COPILOT_PROVIDER_BASE_URL')) return undefined;
  const home = deps.env.COPILOT_HOME ?? join(deps.home, '.copilot');
  try {
    const config = parseLenientJson(await deps.readText(join(home, 'config.json'))) as
      { loggedInUsers?: unknown } | null;
    if (!Array.isArray(config?.loggedInUsers) || config.loggedInUsers.length > 0) return undefined;
  } catch (error) {
    if (!isMissingFile(error)) return undefined;
  }
  return 'not logged in — run `copilot login`';
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
  doctor: {
    label: 'GitHub Copilot CLI', url: 'https://github.com/github/copilot-cli',
    argv: ['copilot', '--version'], optional: false,
  },
  // copilot 1.0.83's --session-id mints a new session, same as claude's flag
  // of the same name (--help: "or set the UUID for a new session"); a bare
  // id string means "resume". Interactive harvest goes via --resume, same as
  // claude — there is no --share transcript any more.
  capabilities: {
    sessionIdInjection: true, sessionIdCapture: false, sessionResume: true,
    toolDenial: true, shareTranscript: false,
  },

  /**
   * The login and beep notes are only worth reading config for once copilot
   * is actually there — a missing runner's row has nothing to advise about.
   * `notes` is always an array when installed (empty once logged in and beep
   * is on), never absent. The login note leads: a step cannot start without it.
   */
  async detect(): Promise<DetectResult> {
    const probed = await withAuthNote(await probeRunner(copilotAdapter.doctor), copilotAuthNote);
    if (!probed.installed) return probed;
    return { ...probed, notes: [...(probed.notes ?? []), ...await beepNote()] };
  },

  interactive(step: AgentStep, ctx: RunCtx): SpawnSpec {
    const marker = endMarkerPath(ctx.runDir, step.id);
    // --session-id mints a conversation; continuing one needs --resume=, the
    // same flag harvest() already uses. Same rule as claude's own
    // sessionArgs (see isResumedStep).
    const sessionArgs = isResumedStep(step, ctx)
      ? [`--resume=${sessionId(step, ctx)}`]
      : ['--session-id', sessionId(step, ctx)];
    // copilot has no system-prompt flag, so the guidance rides in front of the
    // task prompt; the separator keeps the two from bleeding into each other.
    // The guidance and the task both live in the prompt file, which is what the
    // argv pointer names; the separator keeps the two from bleeding together.
    const prompt = promptPath(ctx.runDir, step.id);
    const argv = [
      'copilot', '-i', promptPointer(prompt, ctx),
      ...sessionArgs, ...modelArgs(step), ...effortArgs(step),
      ...(step.writes ? [] : ['--deny-tool=write']),
      // A shell rule matches the command name only; naming the marker path
      // in it matches nothing, and the session-ending touch stops at a prompt.
      '--allow-tool=shell(touch)',
    ];
    return {
      ...spawnSpec(ctx, argv, true),
      files: [{ path: prompt, content: lf(`${interactiveGuidance(step, ctx)}\n\n---\n\n${buildPrompt(step, ctx)}`) }],
      endSession: { markerPath: marker, quitSequence: COPILOT_QUIT_SEQUENCE },
    };
  },

  /**
   * A read-only step still has to write its artifact, and copilot's deny rules
   * beat every allow rule, so `--deny-tool=write` cannot carry a run-dir
   * exception. Instead it gets no --allow-all-tools: shell and URL access are
   * allowed, and a file write only to the artifact path — any other write has
   * no rule and is refused, since `-p` has nobody to ask.
   */
  headless(step: AgentStep, ctx: RunCtx): SpawnSpec {
    const artifact = ctx.artifacts[step.id] ?? join(ctx.runDir, step.output);
    // `copilot -p` with piped stdin says "No task was provided" (verified against
    // 1.0.83), so stdin is not an option here: the pointer it is.
    const prompt = promptPath(ctx.runDir, step.id);
    const argv = [
      'copilot', '-p', promptPointer(prompt, ctx),
      ...modelArgs(step), ...effortArgs(step),
      ...(step.writes
        ? ['--allow-all-tools']
        : ['--allow-tool=shell', '--allow-tool=url', `--allow-tool=write(${artifact})`]),
      '--output-format', 'json', '--stream', 'on',
      '--no-color',
    ];
    return {
      ...spawnSpec(ctx, argv, false),
      files: [{ path: prompt, content: lf(buildPrompt(step, ctx)) }],
      progress: { format: 'copilot-jsonl' },
    };
  },

  /** See claudeAdapter.suggestName — same contract, copilot's flags. */
  suggestName(prompt: string, ctx: RunCtx, capturePath: string): SpawnSpec {
    const file = join(ctx.runDir, SUGGEST_PROMPT_NAME);
    const argv = [
      'copilot', '-p', promptPointer(file, ctx),
      '--model', 'gpt-5-mini', '--deny-tool=write', '--deny-tool=shell',
      '--no-color',
    ];
    return {
      ...spawnSpec(ctx, argv, false),
      files: [{ path: file, content: lf(prompt) }],
      capture: { path: capturePath, streams: 'stdout' },
    };
  },

  // No guidance/settings here, despite resuming the same session: a headless
  // harvest has no human to wait for. --output-format json --stream on is
  // safe alongside --resume and a file write (verified against 1.0.83: the
  // write lands and the events stream cleanly around it), so a harvest step
  // reports progress exactly like any other headless spawn.
  harvest(step: AgentStep, ctx: RunCtx): SpawnSpec {
    const file = harvestPromptPath(ctx.runDir, step.id);
    const argv = [
      'copilot', '-p', promptPointer(file, ctx), `--resume=${sessionId(step, ctx)}`,
      ...modelArgs(step), '--allow-all-tools', '--output-format', 'json', '--stream', 'on', '--no-color',
    ];
    return {
      ...spawnSpec(ctx, argv, false),
      files: [{ path: file, content: lf(harvestPrompt(step, ctx)) }],
      progress: { format: 'copilot-jsonl' },
    };
  },

  /**
   * copilot has no `--list-models` flag; `help config`'s prose is the only
   * source. Any failure reads as 'unavailable' (see listModelsVia) — plain
   * free text with no warnings, exactly as the editor behaved before this
   * existed.
   */
  listModels(): Promise<ModelList> {
    return listModelsVia(['copilot', 'help', 'config'], parseCopilotModels);
  },
};
