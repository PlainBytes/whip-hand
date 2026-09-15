import type { AgentStep, DetectResult, ModelList, RunCtx, RunnerAdapter, SpawnSpec } from '../types.ts';
import { buildPrompt } from '../template.ts';
import { interactiveGuidance } from '../engine/interactive-guidance.ts';
import { endMarkerPath, shellPath } from '../engine/session-end.ts';
import { awaitStatePath } from '../engine/await-state.ts';
import { probeRunner } from '../tools.ts';
import { probeClaudeModels } from './claude-models.ts';
import { flagArgs, harvestPrompt, isResumedStep, requireSessionId, spawnSpec } from './common.ts';

export const CLAUDE_WRITE_TOOLS = 'Write,Edit,NotebookEdit';
const READONLY_ALLOWED = 'Read,Grep,Glob,Bash';
const WRITES_ALLOWED = 'Bash,Write,Edit,NotebookEdit';
/** `/exit` at the prompt quits claude cleanly, letting it persist the session harvest resumes. */
export const CLAUDE_QUIT_SEQUENCE = '/exit\r';
/** Paths that survive being pasted into a shell rule unquoted. */
const SHELL_SAFE_PATH = /^[A-Za-z0-9_@%+=:,./-]+$/;

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
 * Everything whiphand asks of the session's settings, in the one
 * --settings object claude accepts. It takes exactly one value, which is what
 * makes it safe beside the trailing positional prompt (unlike the variadic tool
 * flags — see the NB in headless()).
 *
 * `permissions.allow` pre-approves the one command that ends the session, so
 * the last thing the human sees isn't a permission prompt: on a read-only step
 * Write is denied, so the model *must* reach for Bash there.
 *
 * `hooks` report whether the session is blocked on the human; the agent's PTY
 * frontend watches the file they write. Verified against claude 2.1.260: the
 * settings cascade deep-merges and concatenates arrays, so these are added to
 * the user's own hooks rather than replacing them.
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
function interactiveSettings(markerPath: string, awaitPath: string): Record<string, unknown> {
  const write = (reason: string): string =>
    `printf '{"r":"${reason}"}' > ${awaitPath} 2>/dev/null; exit 0`;
  const command = (c: string) => [{ hooks: [{ type: 'command', command: c }] }];
  return {
    permissions: { allow: [`Bash(touch ${markerPath})`] },
    hooks: {
      Stop: command(write('turn')),
      PermissionRequest: command(write('permission')),
      Notification: command(`cat > ${awaitPath} 2>/dev/null; exit 0`),
      UserPromptSubmit: command(`rm -f ${awaitPath} >/dev/null 2>&1; exit 0`),
    },
  };
}

/**
 * Skipped entirely when either path would need quoting: a permission rule that
 * can never match is worse than no rule, and a hook writing to the wrong place
 * is worse still. Both paths come from ctx.runDir, so they stand or fall
 * together — hence one guard, not two.
 */
function settingsArg(markerPath: string, awaitPath: string): string[] {
  if (!SHELL_SAFE_PATH.test(markerPath) || !SHELL_SAFE_PATH.test(awaitPath)) return [];
  return ['--settings', JSON.stringify(interactiveSettings(markerPath, awaitPath))];
}

export const claudeAdapter: RunnerAdapter = {
  id: 'claude',
  capabilities: {
    sessionIdInjection: true, sessionIdCapture: false, sessionResume: true,
    toolDenial: true, shareTranscript: false,
  },

  /** Nothing to add on top of the plain probe — claude's hooks mean it never needs a setup advisory. */
  detect(): Promise<DetectResult> {
    return probeRunner('claude');
  },

  interactive(step: AgentStep, ctx: RunCtx): SpawnSpec {
    const marker = endMarkerPath(ctx.runDir, step.id);
    const awaitPath = awaitStatePath(ctx.runDir, step.id);
    // Shell-rendered for the settings object, which a runner parses; `marker`
  // and `awaitPath` stay native below, where they go to fs.
  const settings = settingsArg(shellPath(marker), shellPath(awaitPath));
    // --session-id mints a conversation; continuing one needs --resume, the
    // same flag harvest() already uses. isResumedStep is deliberately strict
    // (see its doc): --resume on an id that never spawned a session exits 1.
    const sessionArgs = isResumedStep(step, ctx)
      ? ['--resume', sessionId(step, ctx)]
      : ['--session-id', sessionId(step, ctx)];
    const argv = [
      'claude', ...sessionArgs,
      ...modelArgs(step), ...effortArgs(step),
      ...(step.writes ? [] : [`--disallowedTools=${CLAUDE_WRITE_TOOLS}`]),
      '--append-system-prompt', interactiveGuidance(step, ctx),
      ...settings,
      buildPrompt(step, ctx),
    ];
    return {
      ...spawnSpec(ctx, argv, true),
      endSession: { markerPath: marker, quitSequence: CLAUDE_QUIT_SEQUENCE },
      // No settings means no hooks means nothing to watch.
      ...(settings.length > 0 ? { awaitState: { statePath: awaitPath } } : {}),
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
    const argv = [
      'claude', '-p', '--output-format', 'stream-json', '--verbose',
      ...modelArgs(step), ...effortArgs(step), ...tools, buildPrompt(step, ctx),
    ];
    return { ...spawnSpec(ctx, argv, false), progress: { format: 'claude-stream-json' } };
  },

  /**
   * The cheapest possible ask: no tools at all, and the model's whole reply is
   * the answer. `--model haiku` is hardcoded rather than taken from config —
   * naming a run is not the workflow's work, and it should never cost what the
   * workflow's own model costs.
   */
  suggestName(prompt: string, ctx: RunCtx, capturePath: string): SpawnSpec {
    const argv = ['claude', '-p', '--model', 'haiku', '--allowedTools=', prompt];
    return { ...spawnSpec(ctx, argv, false), capture: { path: capturePath, streams: 'stdout' } };
  },

  // No settings arg here, despite resuming the same session: hooks come from the
  // launching process's snapshot, and a headless harvest has no human to wait for.
  harvest(step: AgentStep, ctx: RunCtx): SpawnSpec {
    const argv = [
      'claude', '-p', '--resume', sessionId(step, ctx),
      ...modelArgs(step), '--allowedTools=Write', harvestPrompt(step, ctx),
    ];
    return spawnSpec(ctx, argv, false);
  },

  /** See claude-models.ts for the probe itself — live-only vs. static aliases lives there, not here. */
  listModels(): Promise<ModelList> {
    return probeClaudeModels();
  },
};
