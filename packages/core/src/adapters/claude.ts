import type { AgentStep, DetectResult, ModelList, RunCtx, RunnerAdapter, SpawnSpec } from '../types.ts';
import { buildPrompt } from '../template.ts';
import { interactiveGuidance } from '../engine/interactive-guidance.ts';
import { endMarkerPath } from '../engine/session-end.ts';
import { shQuote, toFwdAbs, toWorkspace } from '../path-form.ts';
import { awaitStatePath } from '../engine/await-state.ts';
import { SUGGEST_PROMPT_NAME, harvestPromptPath, promptPath, settingsPath, systemPromptPath } from '../engine/spawn-files.ts';
import { probeRunner } from '../tools.ts';
import { envOn, isMissingFile, liveAuthDeps, withAuthNote, type AuthProbeDeps } from './auth.ts';
import { probeClaudeModels } from './claude-models.ts';
import { flagArgs, harvestPrompt, isResumedStep, lf, promptPointer, requireSessionId, spawnSpec } from './common.ts';
import { join } from 'node:path';

export const CLAUDE_WRITE_TOOLS = 'Write,Edit,NotebookEdit';
const READONLY_ALLOWED = 'Read,Grep,Glob,Bash';
const WRITES_ALLOWED = 'Bash,Write,Edit,NotebookEdit';
/** `/exit` at the prompt quits claude cleanly, letting it persist the session harvest resumes. */
export const CLAUDE_QUIT_SEQUENCE = '/exit\r';

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
 * Everything whiphand asks of the session's settings, in the one `--settings`
 * object claude accepts — written to a file in the run dir and passed **by
 * path** (`--settings` takes a path as well as inline JSON). That takes the
 * quote-plus-metacharacter exposure, the length exposure and the space-in-path
 * bug off argv in one move: the path we pass is short, ours, and carryable by
 * construction. (`SHELL_SAFE_PATH` — which rejected any path with a space and
 * took permissions, all four hooks *and* await-state down with it, a routine
 * case for a Windows home directory — is deleted, not fixed.)
 *
 * `permissions.allow` pre-approves the one command that ends the session, so
 * the last thing the human sees isn't a permission prompt: on a read-only step
 * Write is denied, so the model *must* reach for Bash there. The rule is the
 * very string the guidance tells the model to run (`touch <marker>`, the marker
 * workspace-relative), quoted by the one quoting helper.
 *
 * `hooks` report whether the session is blocked on the human; the agent's PTY
 * frontend watches the file they write. Verified against claude 2.1.260: the
 * settings cascade deep-merges and concatenates arrays, so these are added to
 * the user's own hooks rather than replacing them. The paths embedded in the
 * hook commands go through `shQuote` (absolute, forward-slash — a hook runs in
 * whatever directory claude was in), which is what makes a space in them safe.
 *
 * EVERY command ends in `; exit 0`, and that is load-bearing rather than tidy:
 * a Stop hook exiting nonzero BLOCKS the agent from stopping — an endless loop
 * in front of the human — and a PermissionRequest hook exiting 2 DENIES the
 * tool, making claude look like it refuses everything. Both would be blamed on
 * claude, not on us. `rm` is not a shell builtin, so a PATH-less environment
 * exits 127; `; exit 0` covers that where `|| true` (only the last command)
 * would not. stderr is discarded because these events feed it back to the model.
 *
 * Notification dumps its raw payload instead of using a `matcher`: the agent
 * maps `notification_type` itself, which keeps us off unverified matcher
 * semantics and gives a second route to the permission state should the
 * PermissionRequest hook not fire.
 */
function interactiveSettings(touchMarker: string, awaitPath: string): Record<string, unknown> {
  const target = shQuote(awaitPath);
  const write = (reason: string): string =>
    `printf '{"r":"${reason}"}' > ${target} 2>/dev/null; exit 0`;
  const command = (c: string) => [{ hooks: [{ type: 'command', command: c }] }];
  return {
    permissions: { allow: [`Bash(touch ${shQuote(touchMarker)})`] },
    hooks: {
      Stop: command(write('turn')),
      PermissionRequest: command(write('permission')),
      Notification: command(`cat > ${target} 2>/dev/null; exit 0`),
      UserPromptSubmit: command(`rm -f ${target} >/dev/null 2>&1; exit 0`),
    },
  };
}

/** Any one of these set means claude has something to authenticate with. */
const CLAUDE_CREDENTIAL_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];
/** Bedrock, Vertex and Foundry authenticate through the cloud provider's own credentials, not a login. */
const CLAUDE_CLOUD_PROVIDER_ENV = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];

/**
 * Whether claude will start with no credentials, worked out from the same
 * places claude itself looks, with no process spawned. Verified against claude
 * 2.1.278 with `claude auth status` in an empty CLAUDE_CONFIG_DIR: every
 * variable above, an `apiKeyHelper` or `env` entry in the user's settings.json,
 * and a `.credentials.json` in the config dir each flip `loggedIn` to true.
 *
 * `claude auth status` itself is not used: it answers authoritatively but
 * opens a connection to Anthropic on every call (seen with strace, even with
 * telemetry switched off), and Doctor's checks stay on the machine.
 *
 * macOS keeps the login in the Keychain, where a file check can only see the
 * wrong thing, so there is no answer and therefore no note. Windows and Linux
 * use `.credentials.json` under the config dir (Windows not verified here).
 * Project-level and managed settings are not read; a login supplied only
 * there would get a note it does not deserve; accepted, since running the
 * suggested login is harmless.
 */
export async function claudeAuthNote(deps: AuthProbeDeps = liveAuthDeps()): Promise<string | undefined> {
  if (deps.platform !== 'linux' && deps.platform !== 'win32') return undefined;
  const { env } = deps;
  if (envOn(env, ...CLAUDE_CREDENTIAL_ENV, ...CLAUDE_CLOUD_PROVIDER_ENV)) return undefined;

  const configDir = env.CLAUDE_CONFIG_DIR || join(deps.home, '.claude');
  try {
    await deps.readText(join(configDir, '.credentials.json'));
    return undefined;
  } catch (error) {
    if (!isMissingFile(error)) return undefined;
  }

  try {
    const settings = JSON.parse(await deps.readText(join(configDir, 'settings.json'))) as
      { apiKeyHelper?: unknown; env?: Record<string, unknown> } | null;
    if (settings?.apiKeyHelper) return undefined;
    // settings.json's `env` block is applied like exported variables, cloud-provider switches included.
    const fromSettings = Object.fromEntries(
      Object.entries(settings?.env ?? {}).filter(([, value]) => value != null).map(([name, value]) => [name, String(value)]));
    if (envOn(fromSettings, ...CLAUDE_CREDENTIAL_ENV, ...CLAUDE_CLOUD_PROVIDER_ENV)) return undefined;
  } catch (error) {
    // No settings.json is a plain "no" — but one we cannot read or parse might
    // hold the helper, and then we are not sure.
    if (!isMissingFile(error)) return undefined;
  }
  return 'not logged in — run `claude` and use /login';
}

export const claudeAdapter: RunnerAdapter = {
  id: 'claude',
  doctor: {
    label: 'Claude Code', url: 'https://claude.com/claude-code',
    argv: ['claude', '--version'], optional: false,
    // The oldest version cited under "verified against" in this file (2.1.260 in interactiveSettings).
    minVersion: '2.1.260',
  },
  capabilities: {
    sessionIdInjection: true, sessionIdCapture: false, sessionResume: true,
    toolDenial: true, shareTranscript: false,
  },

  /** The plain probe, plus a login note — claude's hooks mean it never needs a setup advisory. */
  async detect(): Promise<DetectResult> {
    return withAuthNote(await probeRunner(claudeAdapter.doctor), claudeAuthNote);
  },

  interactive(step: AgentStep, ctx: RunCtx): SpawnSpec {
    const marker = endMarkerPath(ctx.runDir, step.id);
    const awaitPath = awaitStatePath(ctx.runDir, step.id);
    const prompt = promptPath(ctx.runDir, step.id);
    const system = systemPromptPath(ctx.runDir, step.id);
    const settings = settingsPath(ctx.runDir, step.id);
    // --session-id mints a conversation; continuing one needs --resume, the
    // same flag harvest() already uses. isResumedStep is deliberately strict
    // (see its doc): --resume on an id that never spawned a session exits 1.
    const sessionArgs = isResumedStep(step, ctx)
      ? ['--resume', sessionId(step, ctx)]
      : ['--session-id', sessionId(step, ctx)];
    // Nothing multi-line, quoted or user-authored is left on argv: the guidance
    // goes in as a system-prompt *file* (verified against claude 2.1.277: the
    // flag is accepted interactively and validates its path at startup), the
    // settings by path, and the task prompt is the one-sentence pointer.
    const argv = [
      'claude', ...sessionArgs,
      ...modelArgs(step), ...effortArgs(step),
      ...(step.writes ? [] : [`--disallowedTools=${CLAUDE_WRITE_TOOLS}`]),
      '--append-system-prompt-file', toFwdAbs(system),
      '--settings', toFwdAbs(settings),
      promptPointer(prompt, ctx),
    ];
    return {
      ...spawnSpec(ctx, argv, true),
      files: [
        { path: prompt, content: lf(buildPrompt(step, ctx)) },
        { path: system, content: lf(interactiveGuidance(step, ctx)) },
        {
          path: settings,
          content: `${JSON.stringify(interactiveSettings(toWorkspace(marker, ctx.workdir), toFwdAbs(awaitPath)), null, 2)}\n`,
        },
      ],
      endSession: { markerPath: marker, quitSequence: CLAUDE_QUIT_SEQUENCE },
      // The settings file is always written, so the hooks always exist: await-state
      // is guaranteed, including under a path with a space.
      awaitState: { statePath: awaitPath },
    };
  },

  headless(step: AgentStep, ctx: RunCtx): SpawnSpec {
    // NB: =-joined single tokens — claude's tool flags are variadic and would
    // otherwise swallow the trailing positional prompt (found in e2e).
    const tools = step.writes
      ? [`--allowedTools=${WRITES_ALLOWED}`]
      : [`--allowedTools=${READONLY_ALLOWED}`, `--disallowedTools=${CLAUDE_WRITE_TOOLS}`];
    // --verbose is not optional decoration: stream-json only actually streams
    // with it, and without it the run goes silent again (confirmed against the
    // recorded fixture in parity/fixtures/progress).
    //
    // The prompt is not an argv element at all: `claude -p` reads it from stdin
    // (verified against claude 2.1.277), handed over as the file's own
    // descriptor — see SpawnSpec.stdinFile.
    const argv = [
      'claude', '-p', '--output-format', 'stream-json', '--verbose',
      ...modelArgs(step), ...effortArgs(step), ...tools,
    ];
    const prompt = promptPath(ctx.runDir, step.id);
    return {
      ...spawnSpec(ctx, argv, false),
      files: [{ path: prompt, content: lf(buildPrompt(step, ctx)) }],
      stdinFile: prompt,
      progress: { format: 'claude-stream-json' },
    };
  },

  /**
   * The cheapest possible ask: no tools at all, and the model's whole reply is
   * the answer. `--model haiku` is hardcoded rather than taken from config —
   * naming a run is not the workflow's work, and it should never cost what the
   * workflow's own model costs.
   */
  suggestName(prompt: string, ctx: RunCtx, capturePath: string): SpawnSpec {
    const argv = ['claude', '-p', '--model', 'haiku', '--allowedTools='];
    const file = join(ctx.runDir, SUGGEST_PROMPT_NAME);
    return {
      ...spawnSpec(ctx, argv, false),
      files: [{ path: file, content: lf(prompt) }],
      stdinFile: file,
      capture: { path: capturePath, streams: 'stdout' },
    };
  },

  // No settings arg here, despite resuming the same session: hooks come from the
  // launching process's snapshot, and a headless harvest has no human to wait for.
  harvest(step: AgentStep, ctx: RunCtx): SpawnSpec {
    const argv = ['claude', '-p', '--resume', sessionId(step, ctx), ...modelArgs(step), '--allowedTools=Write'];
    const file = harvestPromptPath(ctx.runDir, step.id);
    return { ...spawnSpec(ctx, argv, false), files: [{ path: file, content: lf(harvestPrompt(step, ctx)) }], stdinFile: file };
  },

  /** See claude-models.ts for the probe itself — live-only vs. static aliases lives there, not here. */
  listModels(): Promise<ModelList> {
    return probeClaudeModels();
  },
};
