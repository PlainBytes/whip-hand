import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { mkdtemp, cp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, TOOL_GROUP_LABELS } from '@whiphand/core';
import type { ToolGroup } from '@whiphand/core';
import type { DoctorRow } from '@whiphand/agent/src/protocol.ts';
import { mintVersionStubs, pathWith, posix } from '@whiphand/test-support';

const execFileAsync = promisify(execFile);

const CLI_MAIN = fileURLToPath(new URL('../packages/cli/src/main.ts', import.meta.url));
const AGENT_MAIN = fileURLToPath(new URL('../packages/agent/src/main.ts', import.meta.url));
const FIXTURE_WORKSPACE = fileURLToPath(new URL('./fixtures/workspace', import.meta.url));
// The doctor fixtures' stub runners, minted at start in the shape this platform
// launches (see test-support) rather than the checked-in bash scripts, which need
// the executable bit and are invisible to a Windows PATHEXT walk. Same versions.
const FIXTURE_BIN = mintVersionStubs({
  claude: '9.9.9-stub', copilot: '9.9.9-stub', opencode: '9.9.9-stub',
});

/**
 * The suite's real gate is time: every wait here is a budget for child
 * processes to spawn, and a Windows runner spawns them far more slowly than
 * the 5000 ms these used to hardcode. One knob, generous by default.
 */
const WAIT_MS = Number(process.env.WHIPHAND_PARITY_WAIT_MS ?? 20_000);

// ---------------------------------------------------------------------------
// Shared fixture plumbing
// ---------------------------------------------------------------------------

async function copyFixtureWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-parity-'));
  await cp(FIXTURE_WORKSPACE, dir, { recursive: true });
  return dir;
}

/**
 * Both halves of every parity comparison are real child processes, so
 * isolation has to travel in their env rather than in this process's. Without
 * it they resolve against whatever global config.yaml and workflows the
 * developer happens to have — making parity a function of the machine — and
 * the agent's startup retention migration writes a real
 * ~/.config/whiphand/config.yaml as a side effect of running the suite.
 * Mkdtemp'd once for the file: the temp dirs stay empty, which is exactly the
 * "no global layer" baseline the fixtures assume.
 */
const ISOLATED_ENV: Record<string, string> = {
  WHIPHAND_CONFIG_HOME: await mkdtemp(join(tmpdir(), 'whiphand-parity-config-home-')),
  WHIPHAND_APP_STATE_FILE: join(await mkdtemp(join(tmpdir(), 'whiphand-parity-app-state-')), 'app-state.json'),
};

/**
 * The host variables a child genuinely needs, and no others. The wholesale
 * `process.env` spread this replaces made every comparison pass by carrying the
 * same host facts into both children — which is exactly what cancels out on one
 * machine and cannot across two: a run that reads a variable it should not is
 * invisible until the same scenario runs on another OS.
 */
const HOST_ENV = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'ComSpec', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR',
  'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'PROGRAMFILES', 'NODE_OPTIONS', 'LANG', 'LC_ALL',
  'WHIPHAND_JOB_GUARD', 'WHIPHAND_NODE_PTY_DIR',
];

/** Host variables (allowlisted) plus isolation, with per-call overrides winning over both. */
function childEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const host = Object.fromEntries(HOST_ENV.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
  return { ...host, ...ISOLATED_ENV, ...overrides };
}

// ---------------------------------------------------------------------------
// Volatile-field normalization: both paths mint their own runId (timestamp +
// random suffix, see packages/core/src/engine/artifacts.ts) and, for
// interactive claude steps, their own session UUID. Both also run against
// their own mkdtemp'd copy of the fixture workspace, so the absolute workdir
// differs too. None of that is meaningful drift — it has to be normalized
// away, INSIDE argv strings and prompts (not just top-level spec fields),
// before the two SpawnSpec sequences can be compared.
// ---------------------------------------------------------------------------

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function normalizeString(value: string, dir: string, runId: string): string {
  // Emitted paths are workspace-relative or forward-slash absolute (`C:/Users/…` on Windows),
  // so the native spelling of `dir` alone would leave the Windows temp dir in place.
  return value.split(dir).join('<dir>').split(posix(dir)).join('<dir>')
    .split(runId).join('<runId>').replace(UUID_RE, '<uuid>');
}

interface SpawnSpecLike {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  interactive: boolean;
  /** Prompts and settings travel in files now, so they are compared like argv always was. */
  files?: Array<{ path: string; content: string }>;
  stdinFile?: string;
}

function normalizeSpec(spec: SpawnSpecLike, dir: string, runId: string): SpawnSpecLike {
  return {
    argv: spec.argv.map(a => normalizeString(a, dir, runId)),
    cwd: normalizeString(spec.cwd, dir, runId),
    env: Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [k, normalizeString(v, dir, runId)])),
    interactive: spec.interactive,
    ...(spec.files === undefined ? {} : {
      files: spec.files.map(f => ({ path: normalizeString(f.path, dir, runId), content: normalizeString(f.content, dir, runId) })),
    }),
    ...(spec.stdinFile === undefined ? {} : { stdinFile: normalizeString(spec.stdinFile, dir, runId) }),
  };
}

interface NormalizedSpawn {
  stepId: string;
  phase: 'main' | 'harvest';
  spec: SpawnSpecLike;
}

// ---------------------------------------------------------------------------
// Dry-run parity
// ---------------------------------------------------------------------------

async function runCliDryRun(
  dir: string, attach: string[] = [],
): Promise<{ runId: string; spawns: NormalizedSpawn[] }> {
  const { stdout } = await execFileAsync(process.execPath, [
    CLI_MAIN, 'run', 'parity', '--dry-run', '--json', '--input', 'goal=G', '-C', dir,
    ...attach.flatMap(path => ['--attach', path]),
  ], { env: childEnv() });
  const events = stdout.split('\n').filter(l => l.length > 0).map(l => JSON.parse(l));
  const runStart = events.find(e => e.type === 'run:start');
  assert.ok(runStart, `expected a run:start event in CLI stdout, got: ${stdout}`);
  const runId = runStart.runId as string;
  const spawns: NormalizedSpawn[] = events
    .filter(e => e.type === 'step:spawn')
    .map(e => ({ stepId: e.stepId, phase: e.phase, spec: normalizeSpec(e.spec, dir, runId) }));
  return { runId, spawns };
}

interface AgentMessage {
  id?: number | null;
  method?: string;
  result?: any;
  error?: any;
  params?: any;
}

function startAgentProcess(env: Record<string, string> = {}): {
  child: ChildProcessWithoutNullStreams;
  messages: AgentMessage[];
  send(obj: unknown): void;
  waitFor(pred: (m: AgentMessage) => boolean, timeoutMs?: number): Promise<AgentMessage>;
  stop(): void;
} {
  const child = spawn(process.execPath, [AGENT_MAIN], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv(env),
  });
  const messages: AgentMessage[] = [];
  const waiters: Array<{ pred: (m: AgentMessage) => boolean; resolve: (m: AgentMessage) => void }> = [];
  const stderrChunks: Buffer[] = [];
  child.stderr.on('data', d => stderrChunks.push(d));

  createInterface({ input: child.stdout }).on('line', line => {
    if (!line.trim()) return;
    let msg: AgentMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    messages.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        const [w] = waiters.splice(i, 1);
        w.resolve(msg);
      }
    }
  });

  function send(obj: unknown): void {
    child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  function waitFor(pred: (m: AgentMessage) => boolean, timeoutMs = WAIT_MS): Promise<AgentMessage> {
    const existing = messages.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolvePromise, reject) => {
      const entry = {
        pred,
        resolve: (m: AgentMessage) => {
          clearTimeout(timer);
          resolvePromise(m);
        },
      };
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(entry);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(new Error(`timed out waiting for message; stderr:\n${Buffer.concat(stderrChunks).toString()}`));
      }, timeoutMs);
      waiters.push(entry);
    });
  }

  function stop(): void {
    child.kill('SIGKILL');
  }

  return { child, messages, send, waitFor, stop };
}

async function runAgentDryRun(
  dir: string, attach: string[] = [],
): Promise<{ runId: string; spawns: NormalizedSpawn[] }> {
  const agent = startAgentProcess();
  try {
    agent.send({
      id: 1, method: 'startRun',
      params: {
        workdir: dir, workflow: 'parity', inputs: { goal: 'G' }, dryRun: true,
        ...(attach.length === 0 ? {} : { attachments: attach.map(path => ({ path })) }),
      },
    });
    const started = await agent.waitFor(m => m.id === 1);
    const jobId = started.result.jobId as string;

    const finalState = await agent.waitFor(m =>
      m.method === 'runStateChanged' && m.params.jobId === jobId && m.params.status !== 'running');
    assert.equal(finalState.params.status, 'succeeded', 'expected the agent dry run to succeed');
    const runId = finalState.params.runId as string;

    // NDJSON arrives on one sequential stdout stream, and runStateChanged's
    // terminal notification is written strictly after every whiphandEvent for the
    // run (see runJobInBackground's finally block) — so every step:spawn is
    // already sitting in `messages` by the time finalState resolved above.
    const spawnEvents = agent.messages.filter(m =>
      m.method === 'whiphandEvent' && m.params.jobId === jobId && m.params.event.type === 'step:spawn');

    const spawns: NormalizedSpawn[] = spawnEvents.map(m => ({
      stepId: m.params.event.stepId,
      phase: m.params.event.phase,
      spec: normalizeSpec(m.params.event.spec, dir, runId),
    }));
    return { runId, spawns };
  } finally {
    agent.stop();
  }
}

test('dry-run parity: CLI and agent produce identical normalized SpawnSpec sequences', async () => {
  const cliDir = await copyFixtureWorkspace();
  const agentDir = await copyFixtureWorkspace();

  const cli = await runCliDryRun(cliDir);
  const agent = await runAgentDryRun(agentDir);

  assert.deepEqual(
    cli.spawns.map(s => `${s.stepId}:${s.phase}`),
    agent.spawns.map(s => `${s.stepId}:${s.phase}`),
    'CLI and agent dry runs spawned a different step/phase sequence',
  );
  assert.deepEqual(
    cli.spawns, agent.spawns,
    'CLI and agent dry runs produced different SpawnSpecs after normalizing session ' +
    'UUIDs, runIds, and workdir paths — see the diff above for the exact field.',
  );

  // Event payload paths are workspace-relative, so none of them needed the
  // workdir normalized away to agree.
  for (const { spec } of [...cli.spawns, ...agent.spawns]) {
    assert.equal(spec.cwd, '.');
    for (const file of spec.files ?? []) assert.ok(!file.path.includes('<dir>') && !file.path.startsWith('/'), file.path);
  }

  // The fixture's loop carries a disabled step ('notes'). Matching spawn lists
  // alone would not catch both sides wrongly agreeing to spawn it — this
  // proves neither one starts a session for a disabled step.
  assert.ok(!cli.spawns.some(s => s.stepId === 'notes'), 'the CLI must not spawn a disabled step');
  assert.ok(!agent.spawns.some(s => s.stepId === 'notes'), 'the agent must not spawn a disabled step');
});

test('dry-run parity: CLI --attach and agent startRun attachments record the same list', async () => {
  const cliDir = await copyFixtureWorkspace();
  const agentDir = await copyFixtureWorkspace();
  const src = await mkdtemp(join(tmpdir(), 'whiphand-parity-attach-'));
  await writeFile(join(src, 'bug.png'), 'PNG');
  await writeFile(join(src, 'Bug.PNG.txt'), 'same stem, other file');
  const files = [join(src, 'bug.png'), join(src, 'bug.png'), join(src, 'Bug.PNG.txt')];

  const cli = await runCliDryRun(cliDir, files);
  const agent = await runAgentDryRun(agentDir, files);

  const recorded = async (dir: string, runId: string) =>
    (JSON.parse(await readFile(join(dir, '.whiphand', 'runs', runId, 'run.json'), 'utf8')) as {
      attachments?: unknown;
    }).attachments;
  const cliList = await recorded(cliDir, cli.runId);
  assert.deepEqual(cliList, [
    { name: 'bug.png', path: 'attachments/bug.png', size: 3, source: files[0] },
    { name: 'bug-2.png', path: 'attachments/bug-2.png', size: 3, source: files[1] },
    { name: 'Bug.PNG.txt', path: 'attachments/Bug.PNG.txt', size: 21, source: files[2] },
  ]);
  assert.deepEqual(await recorded(agentDir, agent.runId), cliList);
  // And the step that reads them is handed the same prompt by both.
  assert.deepEqual(cli.spawns, agent.spawns);
  // The prompt is a file now (workspace-relative paths, one style), compared here in full.
  const prompt = cli.spawns[0].spec.files?.map(f => f.content).join('\n') ?? '';
  assert.match(prompt, /- attachments\/bug-2\.png: \.whiphand\/runs\/<runId>\/attachments\/bug-2\.png/);
});

// ---------------------------------------------------------------------------
// Doctor parity
// ---------------------------------------------------------------------------

/**
 * Both surfaces now call the same `detectTools()` in @whiphand/core, so they can no
 * longer disagree about what is installed — the duplicated loop this test was
 * written to police is gone. What it still catches is the half that stayed
 * separate: the CLI's renderer. This asserts that `whiphand doctor`'s text loses
 * none of the facts the RPC carries, so the two surfaces keep saying the same
 * thing to a human and to the desktop.
 *
 * `label`, `optional` and `url` are deliberately outside the comparison: they
 * are static table metadata both sides read from the same registry and BUILTIN_SUPPORT_TOOLS, so
 * there is no drift for a comparison to find. (`optional` is recoverable from
 * the ○ mark for a MISSING tool, but not for an installed one, so including
 * it would only assert half a fact.)
 */
interface DoctorFact {
  id: string;
  group: ToolGroup;
  runner: boolean;
  installed: boolean;
  version?: string;
  notes?: string[];
}

/** Section headings come from @whiphand/core, so rewording one cannot break the parse. */
const GROUP_BY_LABEL = new Map<string, ToolGroup>(
  (Object.entries(TOOL_GROUP_LABELS) as [ToolGroup, string][]).map(([group, label]) => [label, group]),
);

/**
 * packages/cli/src/commands/doctor.ts's line grammar:
 *   heading  a bare line matching no other rule
 *   tool     "✔|✘|○ <id> <rest>"
 *   note     "  · <text>", belonging to the tool above it
 *   blank    separates sections
 */
const TOOL_LINE_RE = /^(✔|✘|○) (\S+) (.+)$/;
const NOTE_LINE_RE = /^ {2}· (.+)$/;

function parseCliDoctorOutput(stdout: string): DoctorFact[] {
  const facts: DoctorFact[] = [];
  let group: ToolGroup | null = null;

  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;

    const note = line.match(NOTE_LINE_RE);
    if (note) {
      assert.ok(facts.length > 0, `note line with no tool above it: ${JSON.stringify(line)}`);
      const owner = facts[facts.length - 1];
      owner.notes = [...(owner.notes ?? []), note[1]];
      continue;
    }

    const tool = line.match(TOOL_LINE_RE);
    if (!tool) {
      const heading = GROUP_BY_LABEL.get(line);
      assert.ok(heading, `unparseable doctor line: ${JSON.stringify(line)}`);
      group = heading;
      continue;
    }

    assert.ok(group !== null, `tool line before any group heading: ${JSON.stringify(line)}`);
    const [, mark, id, rest] = tool;
    const installed = mark === '✔';
    facts.push({
      id,
      group,
      // The CLI prints no runner column: every harness row is a runner, and
      // support rows never are.
      runner: group === 'harness',
      installed,
      version: installed ? (rest === '(version unknown)' ? undefined : rest) : undefined,
    });
  }
  return facts;
}

/** The agent carries fields the CLI has no reason to print. Project them away. */
function factsFromAgent(rows: DoctorRow[]): DoctorFact[] {
  return rows.map(row => ({
    id: row.id, group: row.group, runner: row.runner,
    installed: row.installed, version: row.version, notes: row.notes,
  }));
}

/**
 * One shape for both sides: every key present, `notes` absent-or-empty
 * collapsed to undefined (the agent omits the field; the CLI simply prints no
 * note lines — the same fact), sorted by id so ordering is compared
 * separately from content.
 */
function normalize(facts: DoctorFact[]): DoctorFact[] {
  return [...facts]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(f => ({
      id: f.id,
      group: f.group,
      runner: f.runner,
      installed: f.installed,
      version: f.version,
      notes: f.notes !== undefined && f.notes.length > 0 ? f.notes : undefined,
    }));
}

test('doctor parity: CLI human output and agent doctor() report the same tool facts', async () => {
  // The login notes are a fact about whoever runs the suite (`~/.claude`, the
  // keychain, gh's config), so give every tool a credential to keep them out of
  // the comparison: the stub runners then report no auth note, and the real gh
  // (when installed) answers `gh auth token` from GH_TOKEN. The stub opencode
  // answers `auth list` with nothing, which is an answer we do not recognise.
  const stubEnv = {
    PATH: pathWith(FIXTURE_BIN).PATH ?? '',
    ANTHROPIC_API_KEY: 'parity-stub', COPILOT_GITHUB_TOKEN: 'parity-stub', GH_TOKEN: 'parity-stub',
  };

  const { stdout } = await execFileAsync(process.execPath, [CLI_MAIN, 'doctor'], { env: childEnv(stubEnv) });
  const cliFacts = normalize(parseCliDoctorOutput(stdout));

  const agent = startAgentProcess(stubEnv);
  let agentFacts: DoctorFact[];
  try {
    agent.send({ id: 1, method: 'doctor', params: { workdir: process.cwd() } });
    const res = await agent.waitFor(m => m.id === 1);
    agentFacts = normalize(factsFromAgent(res.result as DoctorRow[]));
  } finally {
    agent.stop();
  }

  // A renderer that silently dropped a whole section would otherwise still
  // "agree" with an agent projection built from the same missing rows.
  for (const group of ['harness', 'support'] as ToolGroup[]) {
    assert.ok(
      cliFacts.some(f => f.group === group),
      `whiphand doctor printed no rows under the '${group}' heading`,
    );
  }

  assert.deepEqual(
    cliFacts.map(f => f.id), agentFacts.map(f => f.id),
    'CLI doctor and agent doctor() report a different set of tools',
  );
  assert.deepEqual(
    cliFacts, agentFacts,
    'CLI doctor and agent doctor() disagree on group/runner/installed/version/notes for one or more tools',
  );
});

// ---------------------------------------------------------------------------
// --name / --max-iterations / --resume --extra-iterations parity
//
// budget.yaml is deliberately kind: command throughout (unlike parity.yaml):
// its 'review' step always fails, so a plain run always exhausts
// max_iterations without depending on the claude/copilot stub binaries doing
// anything beyond exiting. That determinism is what makes exhaustion, and
// then --resume --extra-iterations off the exhausted loop, testable at all.
// ---------------------------------------------------------------------------

/**
 * Strips every timestamp/pid/path field a real run's manifest carries, so two
 * separate runs compare equal. `dir` and `runId` also get substituted out of
 * whatever string values survive — a stage step's own `artifact` field is an
 * absolute path under the mkdtemp'd workspace and the minted runId (see
 * normalizeString above for the identical need on a SpawnSpec), and neither
 * workflow here recorded artifacts before staged.yaml gave one a reason to.
 */
function normalizeManifest(value: unknown, dir: string, runId: string): unknown {
  const VOLATILE = new Set([
    'runId', 'workdir', 'runDir', 'pid', 'pidScope', 'startedAt', 'endedAt', 'updatedAt', 'heartbeatAt', 'resumedAt',
  ]);
  if (Array.isArray(value)) return value.map(v => normalizeManifest(v, dir, runId));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !VOLATILE.has(k))
        .map(([k, v]) => [k, normalizeManifest(v, dir, runId)]),
    );
  }
  if (typeof value === 'string') return normalizeString(value, dir, runId);
  return value;
}

async function readManifest(dir: string, runId: string): Promise<unknown> {
  const raw = JSON.parse(await readFile(join(dir, '.whiphand', 'runs', runId, 'run.json'), 'utf8'));
  return normalizeManifest(raw, dir, runId);
}

/** Runs `workflow` to completion (whatever its own exit code) and returns the minted runId. */
async function runCliToCompletion(dir: string, workflow: string, args: string[] = []): Promise<string> {
  await execFileAsync(process.execPath, [CLI_MAIN, 'run', workflow, '-C', dir, ...args], { env: childEnv() })
    .catch(() => {});
  // An explicit lookup, not `readdir()[0]`: directory order is a filesystem detail (NTFS differs from ext4).
  const runId = (await readdir(join(dir, '.whiphand', 'runs'), { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort().at(-1);
  assert.ok(runId, `expected a run directory under ${dir}`);
  return runId;
}

/** budget.yaml always fails, so a nonzero exit is expected. */
async function runCliBudget(dir: string, args: string[] = []): Promise<string> {
  return runCliToCompletion(dir, 'budget', args);
}

/** staged.yaml's gate declares `default: continue`, so `--yes` runs it unattended to a DONE manifest. */
async function runCliStaged(dir: string, args: string[] = []): Promise<string> {
  return runCliToCompletion(dir, 'staged', args);
}

async function resumeCliBudget(dir: string, runId: string, args: string[] = []): Promise<void> {
  await execFileAsync(process.execPath, [CLI_MAIN, 'run', '--resume', runId, '-C', dir, ...args], { env: childEnv() })
    .catch(() => {});
}

/** Polls a mutable snapshot until `check` returns a defined value, or times out. */
async function waitForCondition<T>(check: () => T | undefined, timeoutMs = WAIT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/**
 * Runs `workflow` to completion over RPC, answering every `manualRequest`
 * the agent parks on along the way (there is no CLI-shaped `--yes` on this
 * transport — the desktop always asks, and a client that wants unattended
 * behaviour has to answer as the CLI's `--yes` would: taking each gate's own
 * declared `defaultChoice`). `onManual` is omitted for a workflow with no
 * manual/approval steps at all, matching runAgentBudget's plain wait.
 */
async function runAgentToCompletion(
  dir: string, workflow: string, params: Record<string, unknown> = {},
  onManual?: (request: { stepId: string; defaultChoice?: string }) => string,
): Promise<string> {
  const agent = startAgentProcess();
  try {
    agent.send({ id: 1, method: 'startRun', params: { workdir: dir, workflow, ...params } });
    const started = await agent.waitFor(m => m.id === 1);
    const jobId = (started.result as { jobId: string }).jobId;

    let answered = 0;
    let rpcId = 2;
    for (;;) {
      const next = await waitForCondition<AgentMessage>(() => {
        if (onManual !== undefined) {
          const manualMsgs = agent.messages.filter(m => m.method === 'manualRequest' && m.params.jobId === jobId);
          if (manualMsgs.length > answered) return manualMsgs[answered];
        }
        return agent.messages.find(m =>
          m.method === 'runStateChanged' && m.params.jobId === jobId && m.params.status !== 'running');
      });
      if (next.method === 'runStateChanged') return next.params.runId as string;

      answered++;
      const request = next.params.request as { stepId: string; defaultChoice?: string };
      const choice = onManual!(request);
      const thisRpcId = rpcId++;
      agent.send({ id: thisRpcId, method: 'resolveManual', params: { jobId, stepId: request.stepId, choice } });
      await agent.waitFor(m => m.id === thisRpcId);
    }
  } finally {
    agent.stop();
  }
}

async function runAgentBudget(dir: string, params: Record<string, unknown> = {}): Promise<string> {
  return runAgentToCompletion(dir, 'budget', params);
}

/**
 * The client-side stand-in for the CLI's `--yes`: nothing `--yes`-shaped is
 * sent to the agent (the protocol has no such parameter); this client simply
 * answers every gate with its own declared `default`.
 */
async function runAgentStagedAnsweringDefaults(dir: string): Promise<string> {
  return runAgentToCompletion(dir, 'staged', {}, request => request.defaultChoice ?? 'continue');
}

async function resumeAgentBudget(dir: string, runId: string, params: Record<string, unknown> = {}): Promise<void> {
  const agent = startAgentProcess();
  try {
    agent.send({ id: 1, method: 'resumeRun', params: { workdir: dir, runId, ...params } });
    const started = await agent.waitFor(m => m.id === 1);
    const jobId = (started.result as { jobId: string }).jobId;
    await agent.waitFor(m => m.method === 'runStateChanged' && m.params.jobId === jobId && m.params.status !== 'running');
  } finally {
    agent.stop();
  }
}

test('--name parity: CLI --name and the agent startRun.name land in the same run:start event', async () => {
  const cliDir = await copyFixtureWorkspace();
  const agentDir = await copyFixtureWorkspace();

  const { stdout } = await execFileAsync(process.execPath, [
    CLI_MAIN, 'run', 'parity', '--dry-run', '--json', '--input', 'goal=G', '--name', 'Ship it', '-C', cliDir,
  ], { env: childEnv() });
  const cliStart = stdout.split('\n').filter(Boolean).map(l => JSON.parse(l)).find(e => e.type === 'run:start');
  assert.equal(cliStart.name, 'Ship it');

  const agent = startAgentProcess();
  try {
    agent.send({
      id: 1, method: 'startRun',
      params: { workdir: agentDir, workflow: 'parity', inputs: { goal: 'G' }, dryRun: true, name: 'Ship it' },
    });
    const started = await agent.waitFor(m => m.id === 1);
    const jobId = (started.result as { jobId: string }).jobId;
    const agentStart = await agent.waitFor(m =>
      m.method === 'whiphandEvent' && m.params.jobId === jobId && m.params.event.type === 'run:start');
    assert.equal(agentStart.params.event.name, 'Ship it');
  } finally {
    agent.stop();
  }
});

test('--max-iterations parity: CLI and agent startRun.maxIterations exhaust a loop at the same count', async () => {
  const cliDir = await copyFixtureWorkspace();
  const agentDir = await copyFixtureWorkspace();

  const cliRunId = await runCliBudget(cliDir, ['--max-iterations', '2']);
  const agentRunId = await runAgentBudget(agentDir, { maxIterations: 2 });

  const cliManifest = await readManifest(cliDir, cliRunId);
  const agentManifest = await readManifest(agentDir, agentRunId);
  assert.deepEqual(cliManifest, agentManifest);
  assert.equal((cliManifest as { status: string }).status, 'failed');
  const loopStep = (cliManifest as { steps: Array<{ id: string; iterations?: number }> })
    .steps.find(s => s.id === 'cycle');
  assert.equal(loopStep?.iterations, 2, '--max-iterations 2 must exhaust after exactly 2 iterations');
});

test('--resume --extra-iterations parity: CLI and agent grant the same extra budget to an exhausted loop', async () => {
  const cliDir = await copyFixtureWorkspace();
  const agentDir = await copyFixtureWorkspace();

  const cliRunId = await runCliBudget(cliDir);
  const agentRunId = await runAgentBudget(agentDir);
  // Both start from the same exhausted-at-1 state before resuming differently.
  assert.deepEqual(await readManifest(cliDir, cliRunId), await readManifest(agentDir, agentRunId));

  await resumeCliBudget(cliDir, cliRunId, ['--extra-iterations', '2']);
  await resumeAgentBudget(agentDir, agentRunId, { extraIterations: 2 });

  const cliManifest = await readManifest(cliDir, cliRunId);
  const agentManifest = await readManifest(agentDir, agentRunId);
  assert.deepEqual(cliManifest, agentManifest);
  const loopStep = (cliManifest as { steps: Array<{ id: string; maxIterations?: number }> })
    .steps.find(s => s.id === 'cycle');
  assert.equal(loopStep?.maxIterations, 3, '1 (original) + 2 (extra) = 3');
});

// ---------------------------------------------------------------------------
// rename-run parity
// ---------------------------------------------------------------------------

test("rename-run parity: CLI's '' and the agent's null clear a run's name the same way", async () => {
  const cliDir = await copyFixtureWorkspace();
  const agentDir = await copyFixtureWorkspace();
  const cli = await runCliDryRun(cliDir);
  const agent = await runAgentDryRun(agentDir);

  await execFileAsync(process.execPath, [CLI_MAIN, 'rename-run', cli.runId, 'Before', '-C', cliDir], { env: childEnv() });
  const { stdout } = await execFileAsync(
    process.execPath, [CLI_MAIN, 'rename-run', cli.runId, '', '-C', cliDir], { env: childEnv() },
  );
  assert.match(stdout, /name cleared/);

  const agentRpc = startAgentProcess();
  let cleared: AgentMessage;
  try {
    agentRpc.send({ id: 1, method: 'renameRun', params: { workdir: agentDir, runId: agent.runId, name: 'Before' } });
    await agentRpc.waitFor(m => m.id === 1);
    agentRpc.send({ id: 2, method: 'renameRun', params: { workdir: agentDir, runId: agent.runId, name: null } });
    cleared = await agentRpc.waitFor(m => m.id === 2);
  } finally {
    agentRpc.stop();
  }
  assert.deepEqual(cleared.result, { renamed: true });

  const nameMarker = async (dir: string, runId: string) =>
    readFile(join(dir, '.whiphand', 'runs', runId, '.name'), 'utf8').catch(() => null);
  assert.equal(await nameMarker(cliDir, cli.runId), null, "CLI's '' must clear the marker file, not write an empty one");
  assert.equal(await nameMarker(agentDir, agent.runId), null);
});

// ---------------------------------------------------------------------------
// init / new-workflow scaffolding parity
// ---------------------------------------------------------------------------

/** Every file under dir, relative, sorted — the shape of a scaffold's output, regardless of write order. */
async function fileTree(dir: string): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];
  async function walk(sub: string): Promise<void> {
    for (const entry of await readdir(join(dir, sub), { withFileTypes: true })) {
      const rel = join(sub, entry.name);
      if (entry.isDirectory()) await walk(rel);
      else out.push({ path: rel, content: await readFile(join(dir, rel), 'utf8') });
    }
  }
  await walk('.');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

test('init parity: CLI `whiphand init` and the agent initWorkspace scaffold the same files', async () => {
  const cliDir = await mkdtemp(join(tmpdir(), 'whiphand-parity-init-'));
  const agentDir = await mkdtemp(join(tmpdir(), 'whiphand-parity-init-'));

  await execFileAsync(process.execPath, [CLI_MAIN, 'init', '-C', cliDir], { env: childEnv() });
  const agent = startAgentProcess();
  try {
    agent.send({ id: 1, method: 'initWorkspace', params: { workdir: agentDir } });
    await agent.waitFor(m => m.id === 1);
  } finally {
    agent.stop();
  }

  assert.deepEqual(await fileTree(join(cliDir, '.whiphand')), await fileTree(join(agentDir, '.whiphand')));
});

test('new-workflow parity: CLI `whiphand new-workflow` and the agent createWorkflow scaffold the same file', async () => {
  const cliDir = await mkdtemp(join(tmpdir(), 'whiphand-parity-neww-'));
  const agentDir = await mkdtemp(join(tmpdir(), 'whiphand-parity-neww-'));

  await execFileAsync(process.execPath, [CLI_MAIN, 'new-workflow', 'triage', '-C', cliDir], { env: childEnv() });
  const agent = startAgentProcess();
  try {
    agent.send({ id: 1, method: 'createWorkflow', params: { workdir: agentDir, name: 'triage', scope: 'project' } });
    await agent.waitFor(m => m.id === 1);
  } finally {
    agent.stop();
  }

  const content = (dir: string) => readFile(join(dir, '.whiphand', 'workflows', 'triage.yaml'), 'utf8');
  assert.equal(await content(cliDir), await content(agentDir));
});

// ---------------------------------------------------------------------------
// config parity
// ---------------------------------------------------------------------------

test('config set parity: CLI dotted key/value and the agent configSet write the same project config.yaml', async () => {
  const cliDir = await mkdtemp(join(tmpdir(), 'whiphand-parity-config-'));
  const agentDir = await mkdtemp(join(tmpdir(), 'whiphand-parity-config-'));

  await execFileAsync(
    process.execPath, [CLI_MAIN, 'config', 'set', 'defaults.runner', 'copilot', '-C', cliDir], { env: childEnv() },
  );

  const agent = startAgentProcess();
  try {
    // The desktop's settings form reads the whole merged config, edits one
    // field, and submits the lot back — configSet's shape mirrors that, unlike
    // the CLI's single dotted key/value. explicitKeys is what tells
    // diffConfigLayer to write only this field, same as the CLI's one write.
    agent.send({
      id: 1, method: 'configSet',
      params: {
        workdir: agentDir, scope: 'project', explicitKeys: ['defaults.runner'],
        config: { ...DEFAULT_CONFIG, defaults: { ...DEFAULT_CONFIG.defaults, runner: 'copilot' } },
      },
    });
    await agent.waitFor(m => m.id === 1);
  } finally {
    agent.stop();
  }

  const content = (dir: string) => readFile(join(dir, '.whiphand', 'config.yaml'), 'utf8');
  assert.equal(await content(cliDir), await content(agentDir));
});

// ---------------------------------------------------------------------------
// stages parity
// ---------------------------------------------------------------------------

test('stages parity: CLI and agent walk the same stages and write the same manifest', async () => {
  const cliDir = await copyFixtureWorkspace();
  const agentDir = await copyFixtureWorkspace();
  const cliRunId = await runCliStaged(cliDir, ['--yes']);        // the fixture's gate declares default: continue
  const agentRunId = await runAgentStagedAnsweringDefaults(agentDir);
  const cliManifest = await readManifest(cliDir, cliRunId) as {
    steps: Array<{ id: string; stage?: string; completedStages?: string[] }>;
  };
  assert.deepEqual(cliManifest, await readManifest(agentDir, agentRunId));
  const build = cliManifest.steps.find(s => s.id === 'build')!;
  assert.deepEqual(build.completedStages, ['01-a', '02-b']);
  assert.deepEqual(cliManifest.steps.filter(s => s.id === 'accept').map(s => s.stage), ['01-a', '02-b']);
});
