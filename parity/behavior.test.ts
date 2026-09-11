import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_GROUP_LABELS } from '@whiphand/core';
import type { ToolGroup } from '@whiphand/core';
import type { DoctorRow } from '@whiphand/agent/src/protocol.ts';

const execFileAsync = promisify(execFile);

const CLI_MAIN = fileURLToPath(new URL('../packages/cli/src/main.ts', import.meta.url));
const AGENT_MAIN = fileURLToPath(new URL('../packages/agent/src/main.ts', import.meta.url));
const FIXTURE_WORKSPACE = fileURLToPath(new URL('./fixtures/workspace', import.meta.url));
const FIXTURE_BIN = fileURLToPath(new URL('./fixtures/bin', import.meta.url));

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

/** `process.env` plus isolation, with per-call overrides winning over both. */
function childEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...ISOLATED_ENV, ...overrides };
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
  return value.split(dir).join('<dir>').split(runId).join('<runId>').replace(UUID_RE, '<uuid>');
}

interface SpawnSpecLike {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  interactive: boolean;
}

function normalizeSpec(spec: SpawnSpecLike, dir: string, runId: string): SpawnSpecLike {
  return {
    argv: spec.argv.map(a => normalizeString(a, dir, runId)),
    cwd: normalizeString(spec.cwd, dir, runId),
    env: Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [k, normalizeString(v, dir, runId)])),
    interactive: spec.interactive,
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

  function waitFor(pred: (m: AgentMessage) => boolean, timeoutMs = 5000): Promise<AgentMessage> {
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
  assert.ok(cli.spawns[0].spec.argv.some(a => a.includes('- attachments/bug-2.png: <dir>/')));
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
 * are static table metadata both sides read from the same BUILTIN_TOOLS, so
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
 *   tool     "✔|✘|○ <id> <rest>" with an optional " [detect only]" suffix
 *   note     "  · <text>", belonging to the tool above it
 *   blank    separates sections
 */
const TOOL_LINE_RE = /^(✔|✘|○) (\S+) (.+?)( \[detect only\])?$/;
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
    const [, mark, id, rest, detectOnly] = tool;
    const installed = mark === '✔';
    facts.push({
      id,
      group,
      // Only a harness row can carry the marker, so a support tool is never
      // mistaken for a runner by its absence.
      runner: group === 'harness' && detectOnly === undefined,
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
  const stubEnv = { PATH: `${FIXTURE_BIN}:${process.env.PATH}` };

  const { stdout } = await execFileAsync(process.execPath, [CLI_MAIN, 'doctor'], { env: childEnv(stubEnv) });
  const cliFacts = normalize(parseCliDoctorOutput(stdout));

  const agent = startAgentProcess(stubEnv);
  let agentFacts: DoctorFact[];
  try {
    agent.send({ id: 1, method: 'doctor', params: {} });
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
