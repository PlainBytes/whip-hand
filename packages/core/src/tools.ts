/**
 * What `whiphand doctor` and the desktop's Doctor page report: a declarative
 * table of tools to probe, in two groups. The registry stays the authority on
 * *runners* (`runner: true`, load-bearing for the `defaults.runner` dropdown);
 * everything else here is detect-only.
 */
import type { AdapterRegistry } from './registry.ts';
import type { DetectResult } from './types.ts';
import { execRunner, resolveExecutable } from './exec.ts';
import path from 'node:path';
import { resolveShell, type ResolveShellOpts } from './shell.ts';
import { toFwdAbs } from './path-form.ts';
import { headroomWarning } from './canonicalize.ts';
import { classifyGitFailure } from './engine/git-guard.ts';
import { TOOL_GROUPS, type ToolGroup } from './tool-groups.ts';

// Re-exported so `@whiphand/core` stays the one import for everything doctor-shaped;
// they live in their own node-free module because the desktop bundles them.
export { TOOL_GROUPS, TOOL_GROUP_LABELS } from './tool-groups.ts';
export type { ToolGroup } from './tool-groups.ts';

/** A declarative "is this installed, and at what version" check. */
export interface ToolProbe {
  /** Display key, RPC key, and the desktop's `doctor-card-${id}` testid. */
  id: string;
  label: string;
  group: ToolGroup;
  /** What to run. argv[0] is the executable; execRunner forces shell:false. */
  argv: string[];
  /** Other executable names for the same tool, tried in order after argv[0]. */
  aliases?: string[];
  /** RegExp source whose group 1 is the version. Defaults to VERSION_RE. */
  versionPattern?: string;
  /**
   * Presentation only — nothing enforces it. A missing optional tool must not
   * render like a broken install, or a machine without jq looks as alarming
   * as one without git.
   */
  optional?: boolean;
  url?: string;
}

/** One row of the doctor report. The wire shape of the `doctor` RPC's result. */
export interface ToolStatus {
  id: string;
  label: string;
  group: ToolGroup;
  /**
   * A RunnerAdapter can drive this — i.e. it is in the registry. False for
   * every support tool AND for a harness we can detect but not yet run.
   */
  runner: boolean;
  optional: boolean;
  installed: boolean;
  version?: string;
  /** Omitted when empty, so "the CLI printed no note lines" is the same fact. */
  notes?: string[];
  url?: string;
}

/**
 * Every probe is one cheap `--version` call, but there are a dozen of them
 * behind a single RPC, and `execRunner` has no timeout of its own — one hung
 * binary would hang the whole Doctor page until the client's 30s request
 * timeout fired. Measured cost of the built-in table in parallel is ~600ms,
 * so this is ~50x headroom rather than a budget anything runs near.
 */
export const PROBE_TIMEOUT_MS = 5_000;

/**
 * Deliberately looser than a strict three-part semver, because almost nothing
 * prints a bare `X.Y.Z`:
 *
 *   git   `git version 2.53.0`          node  `v24.16.0`
 *   jq    `jq-1.8.1` (and `jq-1.6`)     rg    `ripgrep 15.1.0`
 *   copilot `GitHub Copilot CLI 1.0.83.`  cursor-agent `2025.08.28-8d9dd2c`
 *
 * Anchored on nothing, so it finds the number wherever the tool puts it.
 * `(?:\.\d+)*` needs a digit after each dot, which is what stops copilot's
 * trailing sentence period being eaten and what makes Git-for-Windows'
 * `2.45.0.windows.1` stop cleanly at `2.45.0`.
 */
export const VERSION_RE = /(\d+\.\d+(?:\.\d+)*(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?)/;

/** A pathological user-supplied pattern shouldn't get an unbounded subject. */
const VERSION_LINE_MAX = 200;

function firstNonEmptyLine(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed.slice(0, VERSION_LINE_MAX);
  }
  return undefined;
}

/**
 * Only the FIRST non-empty line is searched, which matters more than it
 * sounds: `rg --version` follows its own version with a `PCRE2 10.43 is
 * available` line, and a whole-output search would happily report a tool's
 * bundled-library version as the tool's.
 *
 * stderr is a fallback for stdout being empty, not an additional haystack —
 * npm's update notifier writes there, and it must never win over a real
 * answer on stdout.
 */
export function parseToolVersion(
  stdout: string, stderr = '', pattern?: string,
): string | undefined {
  const line = firstNonEmptyLine(stdout) ?? firstNonEmptyLine(stderr);
  if (line === undefined) return undefined;
  const re = pattern === undefined ? VERSION_RE : new RegExp(pattern);
  return line.match(re)?.[1];
}

/**
 * claude, copilot and opencode are probed through their adapters —
 * `detectTools` routes any registry id through the adapter's own `detect()`,
 * which is what keeps copilot's `beep` advisory note (and opencode's PATH and
 * env notes) alive. The adapters don't re-implement the probe to do that,
 * though: each `detect()` runs *this* entry via `probeRunner`, then layers its
 * notes on top, so the argv here is the one that actually runs — edit it and
 * both Doctor and the run:env snapshot follow.
 *
 * `optional` defaults to true. Only the things whiphand cannot work without at
 * all are required: claude and copilot (a fresh install needs at least one
 * working runner, and these are the two everyone starts from), and git, which
 * engine/git-guard.ts shells out to in order to enforce every `writes: false`
 * step. opencode is a third, later runner, and stays optional — nothing about
 * a working whiphand install depends on it being there.
 */
export const BUILTIN_TOOLS: readonly ToolProbe[] = [
  // --- harness: what whiphand drives -------------------------------------------
  {
    id: 'claude', label: 'Claude Code', group: 'harness',
    argv: ['claude', '--version'], optional: false,
    url: 'https://claude.com/claude-code',
  },
  {
    id: 'copilot', label: 'GitHub Copilot CLI', group: 'harness',
    argv: ['copilot', '--version'], optional: false,
    url: 'https://github.com/github/copilot-cli',
  },
  // Detected, not drivable: no RunnerAdapter exists for these yet, so they
  // report `runner: false` and the UI says so rather than offering them as a
  // `defaults.runner` that would fail validateWorkflowRunners at run time.
  {
    id: 'codex', label: 'OpenAI Codex CLI', group: 'harness',
    argv: ['codex', '--version'], url: 'https://github.com/openai/codex',
  },
  {
    id: 'gemini', label: 'Gemini CLI', group: 'harness',
    argv: ['gemini', '--version'], url: 'https://github.com/google-gemini/gemini-cli',
  },
  {
    id: 'cursor-agent', label: 'Cursor Agent', group: 'harness',
    argv: ['cursor-agent', '--version'], url: 'https://cursor.com/cli',
  },
  {
    id: 'opencode', label: 'opencode', group: 'harness',
    argv: ['opencode', '--version'], optional: true, url: 'https://opencode.ai',
  },

  // --- support: what workflows and whiphand itself lean on ---------------------
  {
    id: 'git', label: 'Git', group: 'support',
    argv: ['git', '--version'], optional: false, url: 'https://git-scm.com',
  },
  { id: 'node', label: 'Node.js', group: 'support', argv: ['node', '--version'], url: 'https://nodejs.org' },
  { id: 'npm', label: 'npm', group: 'support', argv: ['npm', '--version'], url: 'https://docs.npmjs.com/cli' },
  {
    // `python3` first: on Linux and macOS that is the canonical name, and a
    // bare `python` is as likely to be absent (or a Python 2) as it is to be
    // the one you want. The alias picks up Windows and virtualenvs, where
    // `python` is the only name there is.
    //
    // Windows without Python installed answers `python` with the Microsoft
    // Store app-execution alias — which, given an argument, prints its
    // "not found" line and exits nonzero rather than opening the Store. So
    // that reports as missing, which is the right answer, with no side effect.
    id: 'python', label: 'Python', group: 'support',
    argv: ['python3', '--version'], aliases: ['python'], url: 'https://www.python.org',
  },
  { id: 'rtk', label: 'rtk', group: 'support', argv: ['rtk', '--version'] },
  {
    id: 'rg', label: 'ripgrep', group: 'support',
    argv: ['rg', '--version'], url: 'https://github.com/BurntSushi/ripgrep',
  },
  {
    // Debian and Ubuntu ship the binary as `fdfind` (the `fd` name was taken).
    // Without the alias a correctly-installed fd there reports as missing.
    id: 'fd', label: 'fd', group: 'support',
    argv: ['fd', '--version'], aliases: ['fdfind'], url: 'https://github.com/sharkdp/fd',
  },
  { id: 'jq', label: 'jq', group: 'support', argv: ['jq', '--version'], url: 'https://jqlang.github.io/jq' },
];

/** Every executable name to try, in order: argv[0] first, then each alias. */
function candidates(probe: ToolProbe): string[][] {
  const [, ...rest] = probe.argv;
  return [probe.argv, ...(probe.aliases ?? []).map(name => [name, ...rest])];
}

/**
 * Runs one probe. "Installed" means the command exited zero — `execFile`
 * rejects otherwise, so a tool that prints its version and exits nonzero
 * would read as missing. Nothing in BUILTIN_TOOLS does that; if a real case
 * turns up it wants a per-probe opt-out rather than relaxing this for all.
 */
export async function probeTool(probe: ToolProbe): Promise<DetectResult> {
  for (const argv of candidates(probe)) {
    try {
      const { stdout, stderr } = await execRunner(argv, { timeout: PROBE_TIMEOUT_MS });
      const version = parseToolVersion(String(stdout), String(stderr), probe.versionPattern);
      // Naming the binary matters only when it isn't the one we asked for —
      // otherwise every row would carry a note repeating its own id.
      // Omitted rather than `notes: undefined`, so an adapter returning this
      // as its own detect() result has the same shape it always had.
      return argv[0] === probe.argv[0]
        ? { installed: true, version }
        : { installed: true, version, notes: [`found as '${argv[0]}'`] };
    } catch {
      continue;
    }
  }
  return { installed: false };
}

/**
 * The spawn half of a runner adapter's `detect()`: probes the adapter's own
 * BUILTIN_TOOLS row, so adapters share probeTool's version parsing, timeout
 * and alias fallback instead of each carrying a copy. Deliberately the
 * *built-in* row, not the doctor.yaml-merged table — an override there cannot
 * change how a registry id is detected (see resolveToolTable), and a run's
 * run:env snapshot has no doctor config to consult anyway.
 *
 * An id with no row gets `<id> --version`, the same default resolveToolTable
 * synthesizes for a registered adapter the table hasn't heard of — so a
 * third-party adapter can use this too, and a missing row degrades to a
 * sensible probe instead of throwing out of Doctor.
 */
export function probeRunner(id: string): Promise<DetectResult> {
  const builtin = BUILTIN_TOOLS.find(probe => probe.id === id);
  return probeTool(builtin ?? { id, label: id, group: 'harness', argv: [id, '--version'] });
}

export interface DoctorToolsConfig {
  tools?: ToolProbe[];
  hide?: string[];
}

export interface DetectToolsDeps {
  probe?: (probe: ToolProbe) => Promise<DetectResult>;
  /** Machine-level facts appended to the support group; substituted by tests. Defaults to `machineChecks()`. */
  machine?: () => ToolStatus[];
  /**
   * The workspace the report is about, when there is one. Doctor still answers
   * "is this machine set up" with none; given one it also reports what is wrong
   * with *that folder* — see `workspaceChecks`.
   */
  workdir?: string;
  /** Substituted by tests. Defaults to `workspaceChecks(workdir)`. */
  workspace?: (workdir: string) => Promise<ToolStatus[]>;
}

/**
 * Machine-level facts that are not "is this binary installed" — the out-of-run
 * degradations of invariant 7, in the same vocabulary the run manifest uses
 * (`degradations.ts`). They belong in doctor, not in a log nobody reads:
 *
 *  - the POSIX shell command steps run through: red when none is found (command
 *    steps will refuse to run; agent steps still work), and the resolved path
 *    when found, so a wrong answer is visible rather than mysterious;
 *  - `git` exposed as a `.cmd` wrapper (Windows), which used to make doctor read
 *    green while the write-guard and the diff silently returned null;
 *  - the remote token file's mode not being enforceable on Windows, where
 *    `fs.chmod` only toggles read-only — a pre-existing gap, now stated rather
 *    than invisible (an ACL / Credential Manager is the named follow-up).
 */
export function machineChecks(opts: ResolveShellOpts & { platform?: NodeJS.Platform } = {}): ToolStatus[] {
  const platform = opts.platform ?? process.platform;
  const rows: ToolStatus[] = [];
  const shell = resolveShell({ ...opts, platform });
  rows.push({
    id: 'posix-shell', label: 'POSIX shell', group: 'support', runner: false, optional: false,
    installed: shell.ok,
    ...(shell.ok
      ? { notes: [`command steps run through ${shell.path}`] }
      : { notes: [shell.reason, shell.remediation] }),
  });
  if (platform === 'win32') {
    const git = resolveExecutable('git', { platform, ...(opts.env === undefined ? {} : { env: opts.env }) });
    if (git.usesShell) {
      rows.push({
        id: 'git-wrapper', label: 'git launcher', group: 'support', runner: false, optional: true, installed: false,
        notes: [`git resolves to a .cmd wrapper (${toFwdAbs(git.file)}), which cannot be launched directly; the write-guard and the diff need a real git.exe`],
      });
    }
    rows.push({
      id: 'token-file-mode', label: 'Remote token file mode', group: 'support', runner: false, optional: true, installed: false,
      notes: ['fs.chmod only toggles the read-only attribute on Windows, so the remote access token file cannot be made 0600 (a known gap; Credential Manager is the follow-up)'],
    });
  }
  return rows;
}

export interface WorkspaceChecksOpts {
  platform?: NodeJS.Platform;
  /** Substituted by tests: rejects the way `execRunner` does when git refuses. Defaults to `git rev-parse --git-dir`. */
  git?: (workdir: string) => Promise<unknown>;
}

/**
 * The facts about one workspace that would otherwise surface only mid-run (or
 * only as a warning at workspace open), reported the way machine facts are: a
 * row appears **only when something is wrong**, so a healthy workspace adds
 * nothing to the report.
 *
 *  - git refusing the repository (`detected dubious ownership`, routine on a
 *    shared or network profile): red, because a `writes: false` step cannot run
 *    without its write-guard, with the `safe.directory` remediation git itself
 *    prints. Only that one wording qualifies — a non-repo, a missing git or a
 *    timeout are different facts with their own rows or none.
 *  - too little headroom under Windows' 260-character limit: amber, since the
 *    run may well work, with `subst` as the escape hatch.
 */
export async function workspaceChecks(workdir: string, opts: WorkspaceChecksOpts = {}): Promise<ToolStatus[]> {
  const platform = opts.platform ?? process.platform;
  const root = (platform === 'win32' ? path.win32 : path).resolve(workdir);
  const rows: ToolStatus[] = [];

  try {
    await (opts.git ?? (dir => execRunner(['git', 'rev-parse', '--git-dir'], { cwd: dir })))(root);
  } catch (error) {
    const failure = classifyGitFailure(error);
    if (failure.kind === 'unavailable' && /dubious ownership/i.test(failure.reason)) {
      rows.push({
        id: 'git-ownership', label: 'Workspace git ownership', group: 'support', runner: false, optional: false, installed: false,
        notes: [
          failure.reason,
          `git will not read this repository, so steps that need the write-guard fail. Trust it with: git config --global --add safe.directory ${toFwdAbs(root)}`,
        ],
      });
    }
  }

  const headroom = platform === 'win32' ? headroomWarning(root) : null;
  if (headroom !== null) {
    rows.push({
      id: 'long-path', label: 'Workspace path length', group: 'support', runner: false, optional: true, installed: false,
      notes: [headroom],
    });
  }
  return rows;
}

/**
 * The merged table: built-ins, the user's own entries from doctor.yaml, and
 * anything in the registry the table hasn't heard of.
 *
 * A user entry whose `id` matches a built-in REPLACES it *in place* rather
 * than appending — so tweaking one probe doesn't reshuffle the whole report.
 * The one thing such an override cannot change is detection for a registry
 * id: `detectTools` still calls the adapter's own `detect()` there, because
 * that is where copilot's beep note comes from. Label, group, url and
 * optional are all overridable.
 *
 * `hide` is applied LAST, after the registry sweep, so hiding an adapter
 * actually hides it rather than having it re-appear as an unknown runner.
 */
export function resolveToolTable(
  registry: AdapterRegistry, config: DoctorToolsConfig = {},
): ToolProbe[] {
  const table = [...BUILTIN_TOOLS];
  const indexOf = new Map(table.map((probe, i) => [probe.id, i]));

  for (const extra of config.tools ?? []) {
    const existing = indexOf.get(extra.id);
    if (existing === undefined) {
      indexOf.set(extra.id, table.length);
      table.push(extra);
    } else {
      table[existing] = extra;
    }
  }

  // A third adapter registered in defaultRegistry() shows up in Doctor with
  // no table edit at all — the registry is the authority on runners, and a
  // runner missing from the health check is the worst thing this could do.
  for (const adapter of registry.list()) {
    if (indexOf.has(adapter.id)) continue;
    indexOf.set(adapter.id, table.length);
    table.push({ id: adapter.id, label: adapter.id, group: 'harness', argv: [adapter.id, '--version'] });
  }

  const hidden = new Set(config.hide ?? []);
  return table.filter(probe => !hidden.has(probe.id));
}

/**
 * The doctor report. Probes run in parallel — a dozen sequential spawns would
 * turn a 600ms page into a several-second one for no reason.
 *
 * Output is group-major in TOOL_GROUPS order, stable within a group, so the
 * CLI's sections and the desktop's render from the same sequence.
 */
export async function detectTools(
  registry: AdapterRegistry,
  config: DoctorToolsConfig = {},
  deps: DetectToolsDeps = {},
): Promise<ToolStatus[]> {
  const probe = deps.probe ?? probeTool;
  const table = resolveToolTable(registry, config);

  const rows = await Promise.all(table.map(async (entry): Promise<ToolStatus> => {
    const runner = registry.has(entry.id);
    const detected = runner ? await registry.get(entry.id).detect() : await probe(entry);
    return {
      id: entry.id,
      label: entry.label,
      group: entry.group,
      runner,
      optional: entry.optional ?? true,
      installed: detected.installed,
      version: detected.version,
      // Normalized to "absent" rather than "present but empty": the CLI
      // printing no note lines has to be the same fact as the agent omitting
      // the field, or the parity comparison sees a difference that isn't one.
      notes: detected.notes !== undefined && detected.notes.length > 0 ? detected.notes : undefined,
      url: entry.url,
    };
  }));

  const workspaceRows = deps.workdir === undefined ? [] : await (deps.workspace ?? workspaceChecks)(deps.workdir);
  const all = [...rows, ...(deps.machine ?? machineChecks)(), ...workspaceRows];
  return TOOL_GROUPS.flatMap(group => all.filter(row => row.group === group));
}
