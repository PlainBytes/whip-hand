/**
 * The opencode adapter.
 *
 * opencode cannot mint a session id up front (no CLI flag, no API call does
 * it) — it always picks its own. So where claude and copilot are handed an id
 * before they ever run (`sessionIdInjection`), opencode is asked *after* its
 * interactive spawn exits what id it minted (`sessionIdCapture`,
 * `captureSessionId` below). Harvest then resumes that id exactly like claude
 * and copilot resume theirs.
 *
 * Two behaviours below deliberately depart from the shape a first reading of
 * opencode's own docs suggests, both verified against the installed 1.17.13
 * binary with real spawns before landing here:
 *
 * - The `edit` permission's own per-path patterns never match a path outside
 *   the project root — neither an absolute pattern nor a `../`-relative one —
 *   regardless of whether a competing `"*"` rule is also present. A `"*"`
 *   rule in the *same* permission map always wins over a more specific
 *   pattern once the target is external, which is the opposite of the
 *   documented "last matching rule wins". `external_directory`'s own
 *   patterns do not have this problem: an absolute-path pattern there matches
 *   reliably. So an *absolute* `edit` pattern naming the run directory would
 *   never work. A *relative* one does (opencode resolves it against its own
 *   cwd, which is `ctx.workdir`), and `runner.ts` puts every run directory
 *   under the workdir by default — so `agentPermission` adds a
 *   worktree-relative `<rel runDir>/*` exception to `edit` whenever the run
 *   dir is actually inside the workdir. That is what lets a read-only
 *   *headless* step write the artifact `runner.ts` asks it to write directly
 *   into the run dir (the main interactive spawn never needs it — it never
 *   writes the artifact itself; only harvest does, and harvest is granted
 *   `edit: {"*": "allow"}` unconditionally instead, the same unrestricted
 *   trust claude's `--allowedTools=Write` and copilot's `--allow-all-tools`
 *   already give their own harvest spawns). When the run dir is *not* under
 *   the workdir (a configured `artifacts_dir` pointing elsewhere), no
 *   relative pattern can name it, and a read-only headless step can only
 *   reach its artifact through bash — exactly as claude's read-only headless
 *   run already requires.
 * - The TUI's quit sequence could not be verified live (no PTY harness was
 *   available to drive it here), and the risk noted in research — a whole
 *   string written to the pty in one shot may be treated as a paste rather
 *   than keystrokes-then-Enter — is exactly the failure mode that would leave
 *   a session open forever. `OPENCODE_QUIT_SEQUENCE` is therefore the
 *   documented fallback: empty, so the frontend goes straight to SIGTERM.
 */
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import type {
  AgentStep, DetectResult, ModelInfo, ModelList, RunCtx, RunnerAdapter, SpawnSpec,
} from '../types.ts';
import { buildPrompt } from '../template.ts';
import { interactiveGuidance } from '../engine/interactive-guidance.ts';
import { endMarkerPath, sanitizeStepId, shellPath } from '../engine/session-end.ts';
import { awaitStatePath } from '../engine/await-state.ts';
import { sessionCapturePath, readSessionCapture } from '../engine/session-capture.ts';
import { opencodeGuidancePath, opencodePluginPath } from '../engine/opencode-files.ts';
import { isRecord } from '../engine/progress.ts';
import { execRunner } from '../exec.ts';
import { PROBE_TIMEOUT_MS, probeRunner } from '../tools.ts';
import { flagArgs, harvestPrompt, isResumedStep, listModelsVia, requireSessionId, spawnSpec } from './common.ts';

/** No PTY harness was available to verify a real quit keystroke sequence (see the module doc). */
export const OPENCODE_QUIT_SEQUENCE = '';

/** The primary agent every whiphand-driven opencode spawn runs as. */
const AGENT_NAME = 'whiphand';
/** suggestName's own agent: no filesystem access at all, so a naming spawn cannot touch the tree. */
const NAME_AGENT_NAME = 'whiphand-name';

function modelArgs(step: AgentStep): string[] {
  return flagArgs('-m', step.model);
}
/** `--variant` is a real `run` flag but not a TUI one — the agent config's own `variant` field covers the TUI instead. */
function variantArgs(step: AgentStep): string[] {
  return flagArgs('--variant', step.effort);
}
function sessionId(step: AgentStep, ctx: RunCtx): string {
  return requireSessionId(step, ctx, 'captured yet');
}
/**
 * Every opencode spawn carries its whole agent config in
 * `OPENCODE_CONFIG_CONTENT` — which *replaces* any value already in the
 * environment (hence detect()'s note), so the config each spawn builds is the
 * only one opencode sees.
 */
function opencodeSpec(ctx: RunCtx, argv: string[], interactive: boolean, config: string): SpawnSpec {
  return spawnSpec(ctx, argv, interactive, { OPENCODE_CONFIG_CONTENT: config });
}

/**
 * `external_directory` is the one opencode permission whose absolute-path
 * patterns actually match a target outside the project root (see the module
 * doc) — set on every spawn so a run directory configured outside the
 * workdir never silently loses the marker touch or the harvest write.
 * Harmless when the run dir is inside the project: the pattern still matches
 * (opencode resolves it against the filesystem, not against "is this
 * external"), and the base agent's own permissive default already allows
 * writes there regardless.
 */
function externalDirectoryPermission(runDir: string): Record<string, string> {
  return { [`${shellPath(runDir)}/*`]: 'allow' };
}

/**
 * `edit`'s own patterns only ever match a *relative* target (see the module
 * doc) — resolved by opencode against its own cwd, i.e. `workdir`. Returns
 * the pattern naming everything under `runDir`, or `undefined` when `runDir`
 * is not actually inside `workdir` (a configured `artifacts_dir` elsewhere),
 * since no relative pattern can name a path outside the tree opencode
 * resolves them against.
 */
function relativeRunDirPattern(workdir: string, runDir: string): string | undefined {
  const rel = relative(workdir, runDir);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return `${shellPath(rel)}/*`;
}

interface PermissionOpts {
  /** true grants the `edit` tool unconditionally — writes:true steps and harvest both want this. */
  editAllowed: boolean;
  workdir: string;
  runDir: string;
  /** Present only for an interactive spawn: pre-approves the one command that ends the session. */
  markerPath?: string;
}

function agentPermission(opts: PermissionOpts): Record<string, unknown> {
  const edit: Record<string, string> = { '*': opts.editAllowed ? 'allow' : 'deny' };
  if (!opts.editAllowed) {
    // Read-only: still let a headless step reach its own run-dir artifact
    // through `edit`, not just bash — see the module doc.
    const runDirPattern = relativeRunDirPattern(opts.workdir, opts.runDir);
    if (runDirPattern !== undefined) edit[runDirPattern] = 'allow';
  }
  const permission: Record<string, unknown> = {
    edit,
    external_directory: externalDirectoryPermission(opts.runDir),
  };
  if (opts.markerPath !== undefined) {
    permission.bash = { [`touch ${shellPath(opts.markerPath)}`]: 'allow' };
  }
  return permission;
}

interface ConfigOpts {
  agentName: string;
  permission: Record<string, unknown>;
  model?: string;
  variant?: string;
  instructionsPath?: string;
  pluginPath?: string;
}

/** The one `OPENCODE_CONFIG_CONTENT` value every opencode spec is built from. */
function configContent(opts: ConfigOpts): string {
  const agentBody: Record<string, unknown> = {
    mode: 'primary',
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.variant !== undefined ? { variant: opts.variant } : {}),
    permission: opts.permission,
  };
  const root: Record<string, unknown> = {
    ...(opts.instructionsPath !== undefined ? { instructions: [shellPath(opts.instructionsPath)] } : {}),
    ...(opts.pluginPath !== undefined ? { plugin: [`file://${shellPath(opts.pluginPath)}`] } : {}),
    agent: { [opts.agentName]: agentBody },
  };
  return JSON.stringify(root);
}

/**
 * The await-state/session-capture plugin, one instance per interactive spawn
 * (paths and, when known, the session id itself, are baked in as literals —
 * the plugin has no other way to learn what step it belongs to).
 *
 * `knownSessionId` is set only when resuming: `-s` resume fires no
 * `session.created` for the root session (verified against 1.17.13), so
 * there is nothing to learn it from — the plugin is told instead. On a fresh
 * spawn it starts `null` and the first root `session.created` fills it in.
 *
 * Subagent sessions (`session.created` with `info.parentID` set) are tracked
 * separately and always excluded: their own status/permission chatter must
 * never flap the root session's await-state.
 */
function pluginSource(runDir: string, stepId: string, knownSessionId: string | undefined): string {
  const sessionFile = JSON.stringify(sessionCapturePath(runDir, stepId));
  const awaitFile = JSON.stringify(awaitStatePath(runDir, stepId));
  const known = JSON.stringify(knownSessionId ?? null);
  return `// Generated by whiphand for step '${sanitizeStepId(stepId)}'. Do not edit by hand.
export const Whiphand = async () => {
  const fs = await import('node:fs/promises');
  const SESSION_FILE = ${sessionFile};
  const AWAIT_FILE = ${awaitFile};
  let rootId = ${known};
  const subIds = new Set();
  const isRoot = (id) => typeof id === 'string' && id === rootId && !subIds.has(id);
  const writeAwait = async (reason) => {
    try { await fs.writeFile(AWAIT_FILE, JSON.stringify({ r: reason })); } catch {}
  };
  const clearAwait = async () => {
    try { await fs.rm(AWAIT_FILE, { force: true }); } catch {}
  };
  return {
    event: async ({ event }) => {
      try {
        const props = event && event.properties ? event.properties : {};
        switch (event.type) {
          case 'session.created': {
            const info = props.info || {};
            if (info.parentID) { subIds.add(info.id); break; }
            if (rootId === null) rootId = info.id;
            if (info.id === rootId) await fs.writeFile(SESSION_FILE, rootId);
            break;
          }
          case 'session.status': {
            if (!isRoot(props.sessionID)) break;
            const status = props.status ? props.status.type : undefined;
            if (status === 'idle') await writeAwait('turn');
            else if (status === 'busy') await clearAwait();
            break;
          }
          case 'permission.asked':
          case 'question.asked':
            if (isRoot(props.sessionID)) await writeAwait('permission');
            break;
          case 'permission.replied':
          case 'question.replied':
          case 'question.rejected':
            if (isRoot(props.sessionID)) await clearAwait();
            break;
          default:
            break;
        }
      } catch {
        // A plugin fault must never break the user's session.
      }
    },
  };
};
`;
}

/** One `provider/model` per line — everything else in `opencode models`' output is noise. */
const MODEL_LINE_RE = /^[^\s/]+\/\S+$/;

export function parseOpencodeModels(output: string): ModelInfo[] {
  return output.split('\n')
    .map(line => line.trim())
    .filter(line => MODEL_LINE_RE.test(line))
    .map(id => ({ id }));
}

export const opencodeAdapter: RunnerAdapter = {
  id: 'opencode',
  capabilities: {
    sessionIdInjection: false, sessionIdCapture: true, sessionResume: true,
    toolDenial: true, shareTranscript: false,
  },

  async detect(): Promise<DetectResult> {
    const probed = await probeRunner('opencode');
    const notes = [...(probed.notes ?? [])];
    if (!probed.installed) {
      // opencode is only on PATH in an interactive shell (it's added by
      // .bashrc), so a whiphand run — which never sources one — can find the
      // binary installed and still fail to launch it.
      const fallback = join(homedir(), '.opencode', 'bin', 'opencode');
      if (existsSync(fallback)) {
        notes.push(`opencode is installed at ${fallback} but not on PATH for this process; add its directory to PATH`);
      }
    }
    if (process.env.OPENCODE_CONFIG_CONTENT !== undefined) {
      notes.push(
        'OPENCODE_CONFIG_CONTENT is already set in this environment; whiphand replaces it for every spawn');
    }
    return { ...probed, ...(notes.length ? { notes } : {}) };
  },

  interactive(step: AgentStep, ctx: RunCtx): SpawnSpec {
    const marker = endMarkerPath(ctx.runDir, step.id);
    const awaitPath = awaitStatePath(ctx.runDir, step.id);
    const guidance = opencodeGuidancePath(ctx.runDir, step.id);
    const plugin = opencodePluginPath(ctx.runDir, step.id);
    const resumed = isResumedStep(step, ctx);

    const config = configContent({
      agentName: AGENT_NAME,
      permission: agentPermission({ editAllowed: step.writes, workdir: ctx.workdir, runDir: ctx.runDir, markerPath: marker }),
      model: step.model,
      variant: step.effort,
      instructionsPath: guidance,
      pluginPath: plugin,
    });

    // A resumed step already knows its id (from the manifest); --prompt does
    // not auto-submit alongside -s, so it is omitted rather than shipped
    // knowing it will be ignored.
    const argv = resumed
      ? ['opencode', '-s', sessionId(step, ctx), '--agent', AGENT_NAME, ...modelArgs(step)]
      : ['opencode', '--agent', AGENT_NAME, ...modelArgs(step), '--prompt', buildPrompt(step, ctx)];

    return {
      ...opencodeSpec(ctx, argv, true, config),
      files: [
        { path: guidance, content: interactiveGuidance(step, ctx) },
        { path: plugin, content: pluginSource(ctx.runDir, step.id, resumed ? ctx.sessionIds[step.id] : undefined) },
      ],
      endSession: { markerPath: marker, quitSequence: OPENCODE_QUIT_SEQUENCE },
      awaitState: { statePath: awaitPath },
    };
  },

  headless(step: AgentStep, ctx: RunCtx): SpawnSpec {
    const config = configContent({
      agentName: AGENT_NAME,
      permission: agentPermission({ editAllowed: step.writes, workdir: ctx.workdir, runDir: ctx.runDir }),
      model: step.model,
      variant: step.effort,
    });
    const argv = [
      'opencode', 'run', '--format', 'json', '--agent', AGENT_NAME,
      ...modelArgs(step), ...variantArgs(step), buildPrompt(step, ctx),
    ];
    return { ...opencodeSpec(ctx, argv, false, config), progress: { format: 'opencode-json' } };
  },

  /**
   * `-s <id>` resumes the exact session the interactive spawn's plugin (or,
   * failing that, `captureSessionId`'s fallback) identified. `edit` is
   * unconditionally allowed regardless of the original step's `writes` —
   * see the module doc for why this, rather than a run-dir-scoped carve-out,
   * is what actually gets the artifact written on a read-only step.
   */
  harvest(step: AgentStep, ctx: RunCtx): SpawnSpec {
    const config = configContent({
      agentName: AGENT_NAME,
      permission: agentPermission({ editAllowed: true, workdir: ctx.workdir, runDir: ctx.runDir }),
      model: step.model,
    });
    const argv = [
      'opencode', 'run', '--format', 'json', '-s', sessionId(step, ctx), '--agent', AGENT_NAME,
      ...modelArgs(step), harvestPrompt(step, ctx),
    ];
    return { ...opencodeSpec(ctx, argv, false, config), progress: { format: 'opencode-json' } };
  },

  /**
   * The plugin is the primary channel (it writes the session-capture file the
   * instant the root session exists). `opencode session list` is the fallback
   * for when the plugin never ran at all (`--pure`, `OPENCODE_PURE`, or a
   * plugin load failure) — accepted only when it can point at exactly one
   * session with no ambiguity, per the module doc's "never attempt a doomed
   * harvest" rule. Never throws.
   */
  async captureSessionId(step: AgentStep, ctx: RunCtx): Promise<string | undefined> {
    const fromFile = await readSessionCapture(ctx.runDir, step.id);
    if (fromFile !== undefined) return fromFile;

    try {
      const guidanceMtime = await stat(opencodeGuidancePath(ctx.runDir, step.id)).then(s => s.mtimeMs);
      const { stdout } = await execRunner(
        ['opencode', 'session', 'list', '--format', 'json', '-n', '20'],
        { cwd: ctx.workdir, timeout: PROBE_TIMEOUT_MS },
      );
      const sessions: unknown = JSON.parse(stdout);
      if (!Array.isArray(sessions)) return undefined;
      const matches = sessions.filter((s): s is { id: string } =>
        isRecord(s)
        && typeof s.id === 'string'
        && s.directory === ctx.workdir
        && typeof s.created === 'number'
        && s.created >= guidanceMtime);
      return matches.length === 1 ? matches[0].id : undefined;
    } catch {
      return undefined;
    }
  },

  /**
   * `whiphand-name` has its own agent config, permission-denied on
   * everything: naming a run must never touch the tree. No `-m`, since
   * opencode has no universal cheap model the way claude has haiku.
   */
  suggestName(prompt: string, ctx: RunCtx, capturePath: string): SpawnSpec {
    const config = JSON.stringify({
      agent: { [NAME_AGENT_NAME]: { mode: 'primary', permission: { '*': 'deny' } } },
    });
    const argv = ['opencode', 'run', '--agent', NAME_AGENT_NAME, prompt];
    return { ...opencodeSpec(ctx, argv, false, config), capture: { path: capturePath, streams: 'stdout' } };
  },

  /** `opencode models` prints one `provider/model` id per line; anything else means no list. */
  listModels(): Promise<ModelList> {
    return listModelsVia(['opencode', 'models'], parseOpencodeModels);
  },
};
