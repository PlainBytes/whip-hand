/**
 * What `whiphand doctor` and the desktop's Doctor page report: a declarative
 * table of tools to probe, in two groups. The registry is the authority on
 * *harnesses*: the "harness" group is exactly the registered `RunnerAdapter`s
 * (`runner: true`, load-bearing for the `defaults.runner` dropdown), each
 * described by its own `adapter.doctor`. The "support" group is the table
 * below plus whatever the user adds in doctor.yaml.
 */
import type { AdapterRegistry } from './registry.ts';
import type { DetectResult, RunnerDoctor } from './types.ts';
import { execRunner, resolveExecutable } from './exec.ts';
import path from 'node:path';
import { resolveShell, type ResolveShellOpts } from './shell.ts';
import { toFwdAbs } from './path-form.ts';
import { headroomWarning } from './canonicalize.ts';
import { classifyGitFailure } from './engine/git-guard.ts';
import { TOOL_GROUPS, type ToolGroup } from './tool-groups.ts';
import { WorkflowError } from './schema.ts';
import { globalDoctorConfigPath } from './doctor-config.ts';

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
  /**
   * Extra notes for a tool that turned out to be installed — "installed but
   * not logged in", say. Built-in rows only: a function cannot come from
   * doctor.yaml, and an override of a built-in row there replaces the row, check
   * included. A check that throws is a check with no answer, so no notes.
   */
  check?: () => Promise<string[]>;
}

/** One row of the doctor report. The wire shape of the `doctor` RPC's result. */
export interface ToolStatus {
  id: string;
  label: string;
  group: ToolGroup;
  /** A RunnerAdapter can drive this — i.e. it is in the registry: true for exactly the harness rows. */
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
 * timeout fired. Measured cost of the built-in table in parallel is ~610ms
 * (600ms before the agent-productivity rows were added: the slowest single
 * probe, opencode at ~460ms, sets the pace and the rest overlap it), so this is
 * ~8x headroom rather than a budget anything runs near.
 */
export const PROBE_TIMEOUT_MS = 5_000;

/**
 * Deliberately looser than a strict three-part semver, because almost nothing
 * prints a bare `X.Y.Z`:
 *
 *   git   `git version 2.53.0`          node  `v24.16.0`
 *   jq    `jq-1.8.1` (and `jq-1.6`)     rg    `ripgrep 15.1.0`
 *   copilot `GitHub Copilot CLI 1.0.83.`
 *   yq    `yq (https://github.com/mikefarah/yq/) version v4.53.6`
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
 * "Installed but not logged in" for gh. Checked against gh 2.86.0:
 * `gh auth token --hostname github.com` is local (keyring, `hosts.yml` or
 * `GH_TOKEN`), takes ~0.1s and exits 1 with `no oauth token found for
 * github.com` when there is none.
 *
 * `gh auth status` looks like the obvious call and is wrong for this: it
 * validates the token against the API, so offline it exits 1 with "The token
 * in keyring is invalid" for a perfectly good login. The token comes back on
 * stdout, is never looked at, and goes out of scope with the result.
 *
 * Only that exact failure counts. A timeout, a locked keyring, or anything
 * else that is not "no token" says nothing about being logged in.
 */
export async function ghAuthCheck(run: typeof execRunner = execRunner): Promise<string[]> {
  try {
    await run(['gh', 'auth', 'token', '--hostname', 'github.com'], { timeout: PROBE_TIMEOUT_MS });
    return [];
  } catch (error) {
    const { code, stderr } = error as { code?: unknown; stderr?: unknown };
    return code === 1 && /no oauth token/i.test(String(stderr ?? ''))
      ? ['not logged in — run `gh auth login`']
      : [];
  }
}

/**
 * The support group's built-in rows. Harnesses are not here: each registered
 * adapter carries its own `doctor` descriptor, and `resolveToolTable` builds
 * the harness rows from the registry, so a new adapter shows up in Doctor
 * with no edit to this table.
 *
 * `optional` defaults to true. Only what whiphand cannot work without at all
 * is required: git, which engine/git-guard.ts shells out to in order to
 * enforce every `writes: false` step. (Which harnesses are required is the
 * adapters' say: claude and copilot, the two everyone starts from.)
 */
export const BUILTIN_SUPPORT_TOOLS: readonly ToolProbe[] = [
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

  // Agent-productivity tools: CLIs a coding agent leans on, or that cut its
  // token use or error rate. All optional, grouped by purpose.
  {
    // PRs, issues and CI logs without scraping the web.
    id: 'gh', label: 'GitHub CLI', group: 'support', argv: ['gh', '--version'], url: 'https://cli.github.com',
    check: ghAuthCheck,
  },
  {
    // Structural search and rewrite: precise edits for far fewer tokens than
    // regex plus reading whole files. Its short name `sg` is not an alias on
    // purpose: on Linux that is shadow-utils' "switch group", and telling the
    // two apart would take a probe option that checks the output.
    id: 'ast-grep', label: 'ast-grep', group: 'support',
    argv: ['ast-grep', '--version'], url: 'https://ast-grep.github.io',
  },
  {
    // Two unrelated tools share this name (mikefarah's Go one and the Python
    // wrapper around jq). Both print a version on the first line, so a plain
    // probe serves either; the link is to mikefarah's.
    id: 'yq', label: 'yq', group: 'support', argv: ['yq', '--version'], url: 'https://github.com/mikefarah/yq',
  },
  {
    // Fast, reproducible Python environments; many agent tools and MCP servers
    // are distributed through `uvx`.
    id: 'uv', label: 'uv', group: 'support', argv: ['uv', '--version'], url: 'https://docs.astral.sh/uv',
  },
  {
    // A cheap symbol index for navigating big repos. Only Universal Ctags
    // counts, and BSD/macOS ctags exits nonzero for `--version`, so it reads as
    // missing. (Emacs' `ctags` answers with its own version and reads as
    // installed — accepted rather than probed around.) `uctags` is what some
    // BSDs and distros call the Universal build, where `ctags` is another tool.
    id: 'ctags', label: 'Universal Ctags', group: 'support',
    argv: ['ctags', '--version'], aliases: ['uctags'], url: 'https://ctags.io',
  },
  {
    // A one-shot size and language map of a codebase. `tokei` is the same idea
    // and prints `tokei 14.0.0`, which VERSION_RE already handles.
    id: 'scc', label: 'scc', group: 'support',
    argv: ['scc', '--version'], aliases: ['tokei'], url: 'https://github.com/boyter/scc',
  },
];

/** The part of a `ToolProbe` that says what to run, which is all `probeTool` needs. */
type ProbeCommand = Pick<ToolProbe, 'argv' | 'aliases' | 'versionPattern'>;

/** Every executable name to try, in order: argv[0] first, then each alias. */
function candidates(probe: ProbeCommand): string[][] {
  const [, ...rest] = probe.argv;
  return [probe.argv, ...(probe.aliases ?? []).map(name => [name, ...rest])];
}

/**
 * Runs one probe. "Installed" means the command exited zero — `execFile`
 * rejects otherwise, so a tool that prints its version and exits nonzero
 * would read as missing. Nothing in BUILTIN_SUPPORT_TOOLS does that; if a real case
 * turns up it wants a per-probe opt-out rather than relaxing this for all.
 */
export async function probeTool(probe: ProbeCommand): Promise<DetectResult> {
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
 * What `detectTools` runs for a support row: the probe, then the row's own
 * `check` when it is installed. Kept out of `probeTool` so the adapters, which
 * do their own layering in `detect()`, share only the version half; and out of
 * the detectTools body so a test that substitutes `deps.probe` also gets no
 * real `gh` spawned behind its back.
 */
async function probeToolAndCheck(entry: ToolProbe): Promise<DetectResult> {
  const probed = await probeTool(entry);
  const { check } = entry;
  if (!probed.installed || check === undefined) return probed;
  // Through a promise chain so a check that throws before it returns one is also "no answer".
  const notes = await Promise.resolve().then(() => check()).catch((): string[] => []);
  return notes.length === 0 ? probed : { ...probed, notes: [...(probed.notes ?? []), ...notes] };
}

/**
 * The spawn half of a runner adapter's `detect()`: probes the adapter's own
 * `doctor` descriptor, so adapters share probeTool's version parsing, timeout
 * and alias fallback instead of each carrying a copy. Deliberately the
 * adapter's descriptor, not the doctor.yaml-merged table — an override there
 * cannot change how a registry id is detected (see resolveToolTable), and a
 * run's run:env snapshot has no doctor config to consult anyway.
 *
 * `detectTools` routes every registry id through the adapter's `detect()`,
 * which is what keeps copilot's `beep` advisory note (and opencode's PATH and
 * env notes) alive: each `detect()` runs its descriptor here, then layers its
 * notes on top, so the argv in `adapter.doctor` is the one that actually
 * runs — edit it and both Doctor and the run:env snapshot follow.
 */
export function probeRunner(doctor: RunnerDoctor): Promise<DetectResult> {
  return probeTool(doctor);
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
 * The merged table, in this order: one harness row per registered adapter (in
 * registration order, built from its `doctor` descriptor), the support
 * built-ins, then the user's own support rows from doctor.yaml.
 *
 * A user entry whose `id` matches an existing row REPLACES it *in place*
 * rather than appending — so tweaking one probe doesn't reshuffle the whole
 * report. For a registry id the override may change only `label`, `url` and
 * `optional`: detection keeps going through the adapter's own `detect()`
 * (that is where copilot's beep note comes from), so `argv`, `aliases` and
 * `versionPattern` have nothing to act on, and the row stays in the harness
 * group.
 *
 * The harness group is reserved for registered runners: a user entry claiming
 * it for an id the registry has never heard of is refused with a
 * `WorkflowError`, the same way any other invalid doctor.yaml is. The schema
 * cannot see the registry, so the check lives here.
 *
 * `hide` is applied LAST, so hiding an adapter actually hides it.
 */
export function resolveToolTable(
  registry: AdapterRegistry, config: DoctorToolsConfig = {},
): ToolProbe[] {
  const adapters = registry.list();
  const table: ToolProbe[] = [
    ...adapters.map((adapter): ToolProbe => ({ id: adapter.id, group: 'harness', ...adapter.doctor })),
    ...BUILTIN_SUPPORT_TOOLS,
  ];
  const indexOf = new Map(table.map((probe, i) => [probe.id, i]));

  const reserved = (config.tools ?? []).filter(t => t.group === 'harness' && !registry.has(t.id));
  if (reserved.length > 0) {
    const path = globalDoctorConfigPath();
    const runners = adapters.map(adapter => adapter.id).join(', ');
    throw new WorkflowError(reserved.map(t =>
      `${path}: tools.${t.id}: group 'harness' is reserved for registered runners (${runners})`));
  }

  for (const extra of config.tools ?? []) {
    const existing = indexOf.get(extra.id);
    if (existing === undefined) {
      indexOf.set(extra.id, table.length);
      table.push(extra);
    } else if (registry.has(extra.id)) {
      const row = table[existing];
      table[existing] = { ...row, label: extra.label, url: extra.url ?? row.url, optional: extra.optional ?? row.optional };
    } else {
      table[existing] = extra;
    }
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
  const probe = deps.probe ?? probeToolAndCheck;
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
