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
 * OpenCode 2.0 (verified against 2.0.18 with real spawns) changed the CLI
 * under this adapter in ways its help text does not make obvious:
 *
 * - By default a command talks to a shared background service, which keeps
 *   the config it booted with — so a spawn's own `OPENCODE_CONFIG_CONTENT`
 *   (agent, permissions, plugin) is silently ignored. Every spawn therefore
 *   passes `--standalone`, which boots a private server from this process's
 *   environment. It is a per-command flag: it must come *after* the
 *   subcommand (`opencode run --standalone`); `opencode --standalone run` is
 *   rejected as an unrecognized flag. Sessions live in the same store either
 *   way, so a standalone `session list` or `run -s` sees every session.
 * - The TUI accepts neither `--agent` nor `-m`. It is pointed at the agent by
 *   `default_agent` in the inline config, and the agent's own `model` field
 *   supplies the model.
 * - `--variant` is gone: `run -m` takes `provider/model#variant` instead. The
 *   agent config's `variant` field is accepted but ignored (a bogus value
 *   does not even error), and so is a `#variant` suffix on the agent's
 *   `model` — so an interactive step's effort cannot be set at all, and a
 *   headless one's only rides on `-m`, i.e. only when a model is named too.
 * - `OPENCODE_CONFIG_CONTENT` is merged over the user's global and project
 *   config, not in place of it: their plugins, permissions and agents still
 *   load. The inline config only wins where the two overlap.
 *
 * Two behaviours below deliberately depart from the shape a first reading of
 * opencode's own docs suggests, both verified against the installed 1.17.13
 * binary with real spawns before landing here and not yet re-verified on 2.0:
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
import { SUGGEST_PROMPT_NAME, harvestPromptPath, promptPath } from '../engine/spawn-files.ts';
import { interactiveGuidance } from '../engine/interactive-guidance.ts';
import { endMarkerPath } from '../engine/session-end.ts';
import { shQuote, toFwd, toWorkspace } from '../path-form.ts';
import { awaitStatePath } from '../engine/await-state.ts';
import { sessionCapturePath, readSessionCapture } from '../engine/session-capture.ts';
import { opencodeGuidancePath, opencodePluginPath, opencodePluginIndexPath } from '../engine/opencode-files.ts';
import { isRecord } from '../engine/progress.ts';
import { execRunner } from '../exec.ts';
import { PROBE_TIMEOUT_MS, probeRunner } from '../tools.ts';
import { liveAuthDeps, withAuthNote, type AuthProbeDeps } from './auth.ts';
import {
  flagArgs, harvestPrompt, isResumedStep, lf, listModelsVia, promptPointer, requireSessionId, spawnSpec,
} from './common.ts';


/** No PTY harness was available to verify a real quit keystroke sequence (see the module doc). */
export const OPENCODE_QUIT_SEQUENCE = '';

/** The primary agent every whiphand-driven opencode spawn runs as. */
const AGENT_NAME = 'whiphand';
/** suggestName's own agent: no filesystem access at all, so a naming spawn cannot touch the tree. */
const NAME_AGENT_NAME = 'whiphand-name';

/** Goes after the subcommand, never before it (see the module doc). */
const STANDALONE = '--standalone';

function modelArgs(step: AgentStep): string[] {
  return flagArgs('-m', step.model);
}
/** `run -m provider/model#variant` is 2.0's only way to set effort (see the module doc). */
function modelWithVariantArgs(step: AgentStep): string[] {
  const variant = step.model !== undefined && step.effort !== undefined ? `#${step.effort}` : '';
  return flagArgs('-m', step.model === undefined ? undefined : `${step.model}${variant}`);
}
function sessionId(step: AgentStep, ctx: RunCtx): string {
  return requireSessionId(step, ctx, 'captured yet');
}
/**
 * Every opencode spawn carries its whole agent config in
 * `OPENCODE_CONFIG_CONTENT`, set for the child alone — any value already in
 * whiphand's environment is replaced for it (hence detect()'s note). opencode
 * merges it over the user's own config files (see the module doc).
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
  return { [`${toFwd(runDir)}/*`]: 'allow' };
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
  return `${toFwd(rel)}/*`;
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
    // The very string the guidance tells the model to run (workspace-relative, quoted by the one helper).
    permission.bash = { [`touch ${shQuote(toWorkspace(opts.markerPath, opts.workdir))}`]: 'allow' };
  }
  return permission;
}

interface ConfigOpts {
  agentName: string;
  permission: Record<string, unknown>;
  model?: string;
  instructionsPath?: string;
  pluginPath?: string;
}

/**
 * The one `OPENCODE_CONFIG_CONTENT` value every opencode spec is built from.
 * `default_agent` is how the TUI, which has no `--agent`, lands on it; the
 * agent's `model` is how it gets its model. No `variant`: 2.0 ignores it.
 */
function configContent(opts: ConfigOpts): string {
  const agentBody: Record<string, unknown> = {
    mode: 'primary',
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    permission: opts.permission,
  };
  const root: Record<string, unknown> = {
    ...(opts.instructionsPath !== undefined ? { instructions: [toFwd(opts.instructionsPath)] } : {}),
    // OpenCode 2.0+ plugins are directories; the path is relative to the run dir.
    ...(opts.pluginPath !== undefined ? { plugin: [opts.pluginPath] } : {}),
    default_agent: opts.agentName,
    agent: { [opts.agentName]: agentBody },
  };
  return JSON.stringify(root);
}

/**
 * The await-state/session-capture plugin, one instance per interactive spawn.
 * OpenCode 2.0 requires plugins to be directories with a default export
 * `{ id: string, setup(ctx) { ... } }`. The plugin subscribes to events via
 * `ctx.event.subscribe()` and writes two files:
 * - session-capture: the root session id (written on first `session.created`
 *   for a root session, or immediately if `knownSessionId` was provided for a
 *   resume)
 * - await-state: written when the session is idle or a permission/question is
 *   asked, cleared when busy or the permission/question is answered.
 *
 * `knownSessionId` is set only when resuming: `-s` resume fires no
 * `session.created` for the root session (verified against 1.17.13), so
 * there is nothing to learn it from — the plugin is told instead. On a fresh
 * spawn it starts `null` and the first root `session.created` fills it in.
 *
 * Subagent sessions (`session.created` with `parentID` set) are tracked
 * separately and always excluded: their own status/permission chatter must
 * never flap the root session's await-state.
 *
 * 2.0 emits both 1.x event names (`permission.asked`, `session.status`) and
 * v2 names (`permission.v2.asked`, `session.idle`). The plugin listens to all
 * of them so it keeps working whichever set a given build actually emits.
 */
function pluginSource(runDir: string, stepId: string, knownSessionId: string | undefined): string {
  const sessionFile = JSON.stringify(sessionCapturePath(runDir, stepId));
  const awaitFile = JSON.stringify(awaitStatePath(runDir, stepId));
  const known = JSON.stringify(knownSessionId ?? null);
  // OpenCode 2.0 plugin: must be a directory with index.mjs that default-exports { id, setup }
  return `// Generated by whiphand for step '${stepId}'. Do not edit by hand.
// OpenCode 2.0+ plugin: directory with index.mjs, default export { id, setup }
import { promises as fs } from 'node:fs';
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

export default {
  id: 'whiphand-capture-${stepId}',
  setup(ctx) {
    const controller = new AbortController();
    (async () => {
      try {
        // Write session file immediately if we already know the id (resume case)
        if (rootId !== null) {
          try { await fs.writeFile(SESSION_FILE, rootId); } catch {}
        }
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const props = event.properties ?? event.data ?? {};
          switch (event.type) {
            case 'session.created': {
              const info = props.info ?? props;
              if (info.parentID) { subIds.add(info.id); break; }
              if (rootId === null) rootId = info.id;
              if (info.id === rootId) await fs.writeFile(SESSION_FILE, rootId);
              break;
            }
            case 'session.status': {
              if (!isRoot(props.sessionID)) break;
              const status = props.status?.type;
              if (status === 'idle') await writeAwait('turn');
              else if (status === 'busy') await clearAwait();
              break;
            }
            case 'session.idle':
              if (isRoot(props.sessionID)) await writeAwait('turn');
              break;
            case 'permission.asked':
            case 'permission.v2.asked':
            case 'question.asked':
            case 'question.v2.asked':
              if (isRoot(props.sessionID)) await writeAwait('permission');
              break;
            case 'permission.replied':
            case 'permission.v2.replied':
            case 'question.replied':
            case 'question.v2.replied':
            case 'question.rejected':
            case 'question.v2.rejected':
              if (isRoot(props.sessionID)) await clearAwait();
              break;
          }
        }
      } catch {
        // A plugin fault must never break the user's session.
      }
    })();
    return () => controller.abort();
  },
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

/**
 * Whether opencode has no provider to talk to. The common case reads
 * `auth.json` (`$XDG_DATA_HOME/opencode/`, default `~/.local/share/opencode/`),
 * which 2.0 still writes, and the subcommand only runs when that file has
 * nothing to show — so a wrong guess at the path costs time, never a wrong note.
 *
 * Verified against opencode 2.0.18: `opencode auth list --standalone --format
 * json` is local and prints one entry per provider, each with its
 * `connections` — stored credentials (`type: "credential"`) and provider API
 * keys found in the environment (`type: "env"`) alike. `--standalone` matters
 * here too: the background service would report *its* environment, not ours.
 * Only a parsed, empty answer earns the note; output we cannot read says
 * nothing, and a failed or timed-out run rejects for `withAuthNote` to absorb.
 *
 * "Not logged in" would be too strong here: opencode also has free models that
 * need no key, and providers can be configured in opencode.json. The note
 * says what we saw.
 */
export async function opencodeAuthNote(deps: AuthProbeDeps = liveAuthDeps()): Promise<string | undefined> {
  const dataDir = deps.env.XDG_DATA_HOME || join(deps.home, '.local', 'share');
  try {
    const stored: unknown = JSON.parse(await deps.readText(join(dataDir, 'opencode', 'auth.json')));
    if (isRecord(stored) && Object.keys(stored).length > 0) return undefined;
  } catch {
    // missing or unreadable: ask opencode itself
  }
  const listing = await deps.run(['opencode', 'auth', 'list', STANDALONE, '--format', 'json']);
  let providers: unknown;
  try {
    providers = JSON.parse(listing);
  } catch {
    return undefined;
  }
  if (!Array.isArray(providers)) return undefined;
  const connected = providers.some(p => isRecord(p) && Array.isArray(p.connections) && p.connections.length > 0);
  return connected ? undefined : 'no provider credentials — run `opencode auth login`';
}

export const opencodeAdapter: RunnerAdapter = {
  id: 'opencode',
  doctor: {
    label: 'opencode', url: 'https://opencode.ai',
    argv: ['opencode', '--version'], optional: true,
    minVersion: '2.0.0',
  },
  capabilities: {
    sessionIdInjection: false, sessionIdCapture: true, sessionResume: true,
    toolDenial: true, shareTranscript: false,
  },

  async detect(): Promise<DetectResult> {
    const probed = await withAuthNote(await probeRunner(opencodeAdapter.doctor), opencodeAuthNote);
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
    const prompt = promptPath(ctx.runDir, step.id);
    const pluginDir = opencodePluginPath(ctx.runDir, step.id);
    const pluginIndex = opencodePluginIndexPath(ctx.runDir, step.id);
    const resumed = isResumedStep(step, ctx);

    const config = configContent({
      agentName: AGENT_NAME,
      permission: agentPermission({ editAllowed: step.writes, workdir: ctx.workdir, runDir: ctx.runDir, markerPath: marker }),
      model: step.model,
      instructionsPath: guidance,
      pluginPath: pluginDir,
    });

    // No --agent or -m: the TUI rejects both (see the module doc). A resumed
    // step already knows its id (from the manifest); --prompt did not
    // auto-submit alongside -s in 1.x, so it is omitted rather than shipped
    // knowing it will be ignored.
    const argv = resumed
      ? ['opencode', STANDALONE, '-s', sessionId(step, ctx)]
      : ['opencode', STANDALONE, '--prompt', promptPointer(prompt, ctx)];

    return {
      ...opencodeSpec(ctx, argv, true, config),
      files: [
        { path: prompt, content: lf(buildPrompt(step, ctx)) },
        { path: guidance, content: lf(interactiveGuidance(step, ctx)) },
        // OpenCode 2.0+ requires plugins to be directories with index.mjs
        { path: pluginIndex, content: pluginSource(ctx.runDir, step.id, resumed ? ctx.sessionIds[step.id] : undefined) },
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
    });
    // opencode's stdin support for `run` is not verified, so it takes the pointer.
    const prompt = promptPath(ctx.runDir, step.id);
    const argv = [
      'opencode', 'run', STANDALONE, '--format', 'json', '--agent', AGENT_NAME,
      ...modelWithVariantArgs(step), promptPointer(prompt, ctx),
    ];
    return {
      ...opencodeSpec(ctx, argv, false, config),
      files: [{ path: prompt, content: lf(buildPrompt(step, ctx)) }],
      progress: { format: 'opencode-json' },
      completeWhenArtifactWritten: true,
    };
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
    const file = harvestPromptPath(ctx.runDir, step.id);
    const argv = [
      'opencode', 'run', STANDALONE, '--format', 'json', '-s', sessionId(step, ctx), '--agent', AGENT_NAME,
      ...modelArgs(step), promptPointer(file, ctx),
    ];
    return {
      ...opencodeSpec(ctx, argv, false, config),
      files: [{ path: file, content: lf(harvestPrompt(step, ctx)) }],
      progress: { format: 'opencode-json' },
      completeWhenArtifactWritten: true,
    };
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
        ['opencode', 'session', 'list', STANDALONE, '--format', 'json', '-n', '20'],
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
    const file = join(ctx.runDir, SUGGEST_PROMPT_NAME);
    const argv = ['opencode', 'run', STANDALONE, '--agent', NAME_AGENT_NAME, promptPointer(file, ctx)];
    return {
      ...opencodeSpec(ctx, argv, false, config),
      files: [{ path: file, content: lf(prompt) }],
      capture: { path: capturePath, streams: 'stdout' },
    };
  },

  /** `opencode models` prints one `provider/model` id per line; anything else means no list. */
  listModels(): Promise<ModelList> {
    return listModelsVia(['opencode', 'models'], parseOpencodeModels);
  },
};
