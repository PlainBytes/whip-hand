import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, writeFile, chmod, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_SUPPORT_TOOLS, defaultRegistry, machineChecks, pathKey } from '@whiphand/core';

const AGENT_MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));

// Loosely typed: this is a test-only wire decoder, and each test asserts the
// shape it expects from a specific method's response.
interface Message {
  id?: number | null;
  method?: string;
  result?: any;
  error?: any;
  params?: any;
}

interface AgentHandle {
  child: ChildProcessWithoutNullStreams;
  /** Every parsed stdout line so far, in arrival order. */
  messages: readonly Message[];
  send(obj: unknown): void;
  waitFor(pred: (m: Message) => boolean, timeoutMs?: number): Promise<Message>;
  stop(): void;
}

let agentTestCounter = 0;

function startAgent(envOverride: Record<string, string> = {}): AgentHandle {
  // Every spawned agent gets its own isolated app-state file by default, so
  // a test that doesn't care about app-state persistence never reads or
  // writes the real developer/CI machine's app-state.json (and concurrent
  // test files spawning agents can't race on the same path).
  const isolatedRoot = join(tmpdir(), `whiphand-agent-test-${process.hrtime.bigint()}-${agentTestCounter++}`);
  const env = {
    ...process.env,
    ...(envOverride.WHIPHAND_APP_STATE_FILE ? {} : { WHIPHAND_APP_STATE_FILE: join(isolatedRoot, 'app-state.json') }),
    // Every spawned agent also gets its own isolated global config-home, so a
    // test never reads or writes the real developer/CI machine's global
    // workflows or config.yaml.
    ...(envOverride.WHIPHAND_CONFIG_HOME ? {} : { WHIPHAND_CONFIG_HOME: join(isolatedRoot, 'config-home') }),
    // And its own remote-access config: the real one may have remote access
    // enabled, which would bind the developer's port and publish its state.
    ...(envOverride.WHIPHAND_REMOTE_CONFIG_FILE ? {} : { WHIPHAND_REMOTE_CONFIG_FILE: join(isolatedRoot, 'remote-access.json') }),
    ...envOverride,
  };
  const child = spawn(process.execPath, [AGENT_MAIN], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });
  const messages: Message[] = [];
  const waiters: Array<{ pred: (m: Message) => boolean; resolve: (m: Message) => void }> = [];
  const stderrChunks: Buffer[] = [];
  child.stderr.on('data', d => stderrChunks.push(d));

  createInterface({ input: child.stdout }).on('line', line => {
    if (!line.trim()) return;
    let msg: Message;
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

  function waitFor(pred: (m: Message) => boolean, timeoutMs = 5000): Promise<Message> {
    const existing = messages.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolvePromise, reject) => {
      const entry = {
        pred,
        resolve: (m: Message) => {
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

async function fixtureWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-agent-'));
  await mkdir(join(dir, '.whiphand', 'workflows'), { recursive: true });
  await writeFile(join(dir, '.whiphand', 'workflows', 'smoke.yaml'), [
    'name: smoke',
    'steps:',
    '  - id: a',
    '    runner: claude',
    '    mode: headless',
    '    writes: true',
    '    prompt: hello',
    '    output: a.md',
    '',
  ].join('\n'));
  return dir;
}

/**
 * A workspace holding one stopped run, resumable, whose remaining step is a
 * command that succeeds — so a resume of it runs to completion without a
 * runner binary being installed.
 */
async function workspaceWithStoppedRun(): Promise<{ workdir: string; runId: string }> {
  const workdir = await mkdtemp(join(tmpdir(), 'whiphand-agent-resume-'));
  const runId = '20260101-000000-aaaa';
  const runDir = join(workdir, '.whiphand', 'runs', runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'workflow.yaml'), [
    'name: smoke',
    'steps:',
    '  - id: a',
    '    kind: command',
    '    run: "true"',
    '    output: a.log',
    '',
  ].join('\n'));
  await writeFile(join(runDir, 'run.json'), JSON.stringify({
    version: 2, runId, workflow: 'smoke', workdir, dryRun: false,
    pid: 999_999, startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:01Z',
    endedAt: '2026-01-01T00:00:01Z', status: 'failed', ok: false,
    inputs: {}, sessionIds: {},
    steps: [{ id: 'a', kind: 'command', status: 'failed', exitCode: 1 }],
  }));
  return { workdir, runId };
}

test('renameRun sets, echoes and clears a name that listRuns and getRun then report', async () => {
  const { workdir, runId } = await workspaceWithStoppedRun();
  const agent = startAgent();
  try {
    agent.send({ id: 1, method: 'renameRun', params: { workdir, runId, name: '  OAuth support  ' } });
    // The result is what was actually stored — normalization included — so a
    // client never has to re-derive it.
    assert.deepEqual((await agent.waitFor(m => m.id === 1)).result,
      { renamed: true, name: 'OAuth support' });

    agent.send({ id: 2, method: 'listRuns', params: { workdir } });
    const listed = await agent.waitFor(m => m.id === 2);
    assert.equal(listed.result[0].name, 'OAuth support');

    agent.send({ id: 3, method: 'getRun', params: { workdir, runId } });
    const detail = await agent.waitFor(m => m.id === 3);
    assert.equal(detail.result.name, 'OAuth support');
    // The marker is bookkeeping, not one of the run's artifacts.
    assert.ok(!detail.result.artifacts.some((a: any) => a.name === '.name'));

    agent.send({ id: 4, method: 'renameRun', params: { workdir, runId, name: null } });
    assert.deepEqual((await agent.waitFor(m => m.id === 4)).result, { renamed: true });

    agent.send({ id: 5, method: 'getRun', params: { workdir, runId } });
    assert.equal((await agent.waitFor(m => m.id === 5)).result.name, undefined);
  } finally {
    agent.stop();
  }
});

test('renameRun against an unknown run errors rather than inventing one', async () => {
  const { workdir } = await workspaceWithStoppedRun();
  const agent = startAgent();
  try {
    agent.send({ id: 1, method: 'renameRun', params: { workdir, runId: 'no-such-run', name: 'x' } });
    const res = await agent.waitFor(m => m.id === 1);
    assert.equal(res.error.code, -32000);
    assert.match(String(res.error.message), /unknown run/);
  } finally {
    agent.stop();
  }
});

test('resumeRun against a run that cannot be resumed fails cleanly', async () => {
  const workdir = await fixtureWorkspace();
  const agent = startAgent();
  try {
    agent.send({ id: 1, method: 'resumeRun', params: { workdir, runId: 'no-such-run' } });
    const res = await agent.waitFor(m => m.id === 1);

    // Refused before a job exists, so the caller sees an error rather than a
    // jobId whose run dies a moment later.
    assert.equal(res.error.code, -32000);
    assert.match(String(res.error.message), /no run/);
  } finally {
    agent.stop();
  }
});

test('a resumed run carries its runId on every whiphandEvent notification', async () => {
  const { workdir, runId } = await workspaceWithStoppedRun();
  const agent = startAgent();
  try {
    agent.send({ id: 1, method: 'resumeRun', params: { workdir, runId } });
    const started = await agent.waitFor(m => m.id === 1);
    const jobId = started.result.jobId;

    // A resumed run emits run:resume, not run:start. The desktop correlates by
    // runId, so the agent must pick it up from there too or every notification
    // for a resumed run goes out unattributed.
    const resumed = await agent.waitFor(m =>
      m.method === 'whiphandEvent' && m.params.jobId === jobId && m.params.event.type === 'run:resume');
    assert.equal(resumed.params.runId, runId);

    const finalState = await agent.waitFor(m =>
      m.method === 'runStateChanged' && m.params.jobId === jobId && m.params.status !== 'running');
    assert.equal(finalState.params.status, 'succeeded');
    assert.equal(finalState.params.runId, runId);
  } finally {
    agent.stop();
  }
});

test('a resumed run tags its notifications with the workspace identity key', async () => {
  const { workdir, runId } = await workspaceWithStoppedRun();
  const agent = startAgent();
  try {
    agent.send({ id: 1, method: 'resumeRun', params: { workdir, runId } });
    const { jobId } = (await agent.waitFor(m => m.id === 1)).result;

    const finalState = await agent.waitFor(m =>
      m.method === 'runStateChanged' && m.params.jobId === jobId && m.params.status !== 'running');
    assert.equal(finalState.params.identityKey, pathKey(await realpath(workdir)));
    agent.send({ id: 2, method: 'listJobs', params: {} });
    assert.equal((await agent.waitFor(m => m.id === 2)).result[0].identityKey, pathKey(await realpath(workdir)));
  } finally {
    agent.stop();
  }
});

test('hello returns the core version and protocolVersion 1', async () => {
  const agent = startAgent();
  try {
    agent.send({ id: 1, method: 'hello', params: {} });
    const res = await agent.waitFor(m => m.id === 1);
    assert.equal(res.result.protocolVersion, 1);
    assert.equal(typeof res.result.version, 'string');
  } finally {
    agent.stop();
  }
});

/** A port nothing is listening on right now, from the range remote-access config accepts. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  await new Promise<void>(done => server.close(() => done()));
  return port;
}

test('with remote access enabled, nothing precedes the first response on stdout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-agent-remote-'));
  const configFile = join(dir, 'remote-access.json');
  await writeFile(configFile, JSON.stringify({
    schemaVersion: 1, enabled: true, port: await freePort(), token: 'x'.repeat(32),
  }));
  const agent = startAgent({ WHIPHAND_REMOTE_CONFIG_FILE: configFile });
  try {
    agent.send({ id: 1, method: 'remoteAccessGet', params: {} });
    const res = await agent.waitFor(m => m.id === 1);
    // Otherwise the assertion below proves nothing: the server has to have
    // actually started, since that is what used to publish.
    assert.equal(res.result.listening, true, `remote server did not start: ${res.result.error}`);
    assert.deepEqual(agent.messages[0], res);
  } finally {
    agent.stop();
  }
});

test('listWorkflows finds the fixture workflow with no parse error', async () => {
  const workdir = await fixtureWorkspace();
  const agent = startAgent();
  try {
    agent.send({ id: 1, method: 'listWorkflows', params: { workdir } });
    const res = await agent.waitFor(m => m.id === 1);
    assert.deepEqual(res.result.map((r: any) => r.name), ['smoke']);
    assert.equal(res.result[0].error, undefined);
    assert.equal(res.result[0].workflow.name, 'smoke');
  } finally {
    agent.stop();
  }
});

test('getWorkflow resolves and parses the named workflow', async () => {
  const workdir = await fixtureWorkspace();
  const agent = startAgent();
  try {
    agent.send({ id: 1, method: 'getWorkflow', params: { workdir, name: 'smoke' } });
    const res = await agent.waitFor(m => m.id === 1);
    assert.equal(res.result.name, 'smoke');
    assert.equal(res.result.steps[0].id, 'a');
  } finally {
    agent.stop();
  }
});

test('configGet reports exists:false and defaults when no config.yaml is present', async () => {
  const workdir = await fixtureWorkspace();
  const agent = startAgent();
  try {
    agent.send({ id: 1, method: 'configGet', params: { workdir } });
    const res = await agent.waitFor(m => m.id === 1);
    assert.equal(res.result.project.exists, false);
    assert.equal(res.result.project.path, join(workdir, '.whiphand', 'config.yaml'));
    assert.equal(res.result.config.defaults.runner, 'claude');
  } finally {
    agent.stop();
  }
});

test('configSet writes .whiphand/config.yaml and a following configGet reflects it', async () => {
  const workdir = await fixtureWorkspace();
  const agent = startAgent();
  try {
    const config = {
      defaults: { runner: 'copilot' }, on_findings: 'loop',
      loop: { max_iterations: 7 }, artifacts_dir: '.whiphand/runs', runs: { max_retained: null, auto_name: false, max_attachment_mb: 25 },
    };
    agent.send({ id: 1, method: 'configSet', params: { workdir, config } });
    const setRes = await agent.waitFor(m => m.id === 1);
    assert.deepEqual(setRes.result, { ok: true });

    agent.send({ id: 2, method: 'configGet', params: { workdir } });
    const getRes = await agent.waitFor(m => m.id === 2);
    assert.equal(getRes.result.project.exists, true);
    assert.deepEqual(getRes.result.config, config);
  } finally {
    agent.stop();
  }
});

test('configSet with scope global is visible from configGet with no workdir at all', async () => {
  const agent = startAgent();
  try {
    const config = {
      defaults: { runner: 'copilot' }, on_findings: 'report',
      loop: { max_iterations: 3 }, artifacts_dir: '.whiphand/runs', runs: { max_retained: null, auto_name: false, max_attachment_mb: 25 },
    };
    agent.send({ id: 1, method: 'configSet', params: { config, scope: 'global' } });
    const setRes = await agent.waitFor(m => m.id === 1);
    assert.deepEqual(setRes.result, { ok: true });

    agent.send({ id: 2, method: 'configGet', params: {} });
    const getRes = await agent.waitFor(m => m.id === 2);
    assert.equal(getRes.result.config.defaults.runner, 'copilot');
    assert.equal(getRes.result.project, undefined);
  } finally {
    agent.stop();
  }
});

test('configSet rejects an invalid (partial) config with -32602', async () => {
  const workdir = await fixtureWorkspace();
  const agent = startAgent();
  try {
    agent.send({ id: 1, method: 'configSet', params: { workdir, config: { defaults: { runner: 'claude' } } } });
    const res = await agent.waitFor(m => m.id === 1);
    assert.equal(res.error.code, -32602);
  } finally {
    agent.stop();
  }
});

test('listRuns is empty for a fresh workspace', async () => {
  const workdir = await fixtureWorkspace();
  const agent = startAgent();
  try {
    agent.send({ id: 1, method: 'listRuns', params: { workdir } });
    const res = await agent.waitFor(m => m.id === 1);
    assert.deepEqual(res.result, []);
  } finally {
    agent.stop();
  }
});

test('startRun(dryRun:true) returns a jobId immediately, then streams whiphandEvents to a successful finish', async () => {
  const workdir = await fixtureWorkspace();
  const agent = startAgent();
  try {
    agent.send({ id: 1, method: 'startRun', params: { workdir, workflow: 'smoke', dryRun: true } });
    const started = await agent.waitFor(m => m.id === 1);
    assert.equal(typeof started.result.jobId, 'string');
    const jobId = started.result.jobId;

    const spawnEvent = await agent.waitFor(m =>
      m.method === 'whiphandEvent' && m.params.jobId === jobId && m.params.event.type === 'step:spawn');
    assert.equal(spawnEvent.params.event.stepId, 'a');

    const runningState = await agent.waitFor(m =>
      m.method === 'runStateChanged' && m.params.jobId === jobId && m.params.status === 'running');
    assert.equal(typeof runningState.params.runId, 'string');

    const finalState = await agent.waitFor(m =>
      m.method === 'runStateChanged' && m.params.jobId === jobId && m.params.status !== 'running');
    assert.equal(finalState.params.status, 'succeeded');
    assert.equal(finalState.params.runId, runningState.params.runId);
  } finally {
    agent.stop();
  }
});

test('startRun for a missing workflow fails cleanly via whiphandEvent run:error + runStateChanged failed', async () => {
  const workdir = await fixtureWorkspace();
  const agent = startAgent();
  try {
    agent.send({ id: 1, method: 'startRun', params: { workdir, workflow: 'does-not-exist', dryRun: true } });
    const started = await agent.waitFor(m => m.id === 1);
    const jobId = started.result.jobId;

    const errorEvent = await agent.waitFor(m =>
      m.method === 'whiphandEvent' && m.params.jobId === jobId && m.params.event.type === 'run:error');
    assert.equal(typeof errorEvent.params.event.message, 'string');

    const finalState = await agent.waitFor(m =>
      m.method === 'runStateChanged' && m.params.jobId === jobId && m.params.status === 'failed');
    assert.equal(finalState.params.status, 'failed');
  } finally {
    agent.stop();
  }
});

test('startRun failing AFTER run:start still carries the run\'s runId on the terminal notifications', async () => {
  // Empty PATH: the 'claude' runner binary can't be resolved, so
  // child_process.spawn inside spawnHeadless emits 'error' (ENOENT) and its
  // promise rejects — a real, deterministic non-dry-run failure path that
  // happens strictly after run:start (and thus after runIdBox is populated)
  // has already fired.
  const workdir = await fixtureWorkspace();
  const agent = startAgent({ PATH: '' });
  try {
    agent.send({ id: 1, method: 'startRun', params: { workdir, workflow: 'smoke' } });
    const started = await agent.waitFor(m => m.id === 1);
    const jobId = started.result.jobId;

    const runningState = await agent.waitFor(m =>
      m.method === 'runStateChanged' && m.params.jobId === jobId && m.params.status === 'running');
    const runId = runningState.params.runId;
    assert.equal(typeof runId, 'string');

    const errorEvent = await agent.waitFor(m =>
      m.method === 'whiphandEvent' && m.params.jobId === jobId && m.params.event.type === 'run:error');
    assert.equal(errorEvent.params.runId, runId);

    const finalState = await agent.waitFor(m =>
      m.method === 'runStateChanged' && m.params.jobId === jobId && m.params.status === 'failed');
    assert.equal(finalState.params.runId, runId);
  } finally {
    agent.stop();
  }
});

test('doctor reports one entry per built-in tool (shape only)', async () => {
  // Deterministic because startAgent isolates WHIPHAND_CONFIG_HOME: the spawned
  // agent finds no doctor.yaml, so the table is exactly the built-in one.
  const agent = startAgent();
  try {
    agent.send({ id: 1, method: 'doctor', params: {} });
    // Probes run in parallel, but a row's check (gh auth token) follows its own
    // probe, each bounded by PROBE_TIMEOUT_MS: a slow machine legitimately
    // outlasts waitFor's 5s default. Under --test-timeout, so its stderr still shows.
    const res = await agent.waitFor(m => m.id === 1, 20_000);
    assert.ok(Array.isArray(res.result));
    // The registered harnesses, then the support built-ins, then this machine's own facts (the
    // POSIX shell, and on Windows the git launcher and token-file gaps) — the same rows the CLI's
    // doctor prints.
    assert.deepEqual(res.result.map((r: any) => r.id), [
      ...defaultRegistry().list().map(a => a.id),
      ...BUILTIN_SUPPORT_TOOLS.map(t => t.id),
      ...machineChecks().map(r => r.id),
    ]);

    for (const entry of res.result) {
      assert.equal(typeof entry.installed, 'boolean');
      assert.equal(typeof entry.label, 'string');
      assert.equal(typeof entry.runner, 'boolean');
      assert.equal(typeof entry.optional, 'boolean');
      assert.ok(['harness', 'support'].includes(entry.group));
      if (entry.version !== undefined) assert.equal(typeof entry.version, 'string');
    }

    // The registry is the authority on what can be a workflow's `runner:`.
    const runners = res.result.filter((r: any) => r.runner).map((r: any) => r.id).sort();
    assert.deepEqual(runners, ['claude', 'copilot', 'opencode']);
    const harnesses = res.result.filter((r: any) => r.group === 'harness').map((r: any) => r.id);
    assert.deepEqual(harnesses, ['claude', 'copilot', 'opencode'], 'the harness group is exactly the runners');
    assert.ok(!res.result.some((r: any) => ['codex', 'gemini', 'cursor-agent'].includes(r.id)));
  } finally {
    agent.stop();
  }
});

test('unknown method over the wire -> -32601', async () => {
  const agent = startAgent();
  try {
    agent.send({ id: 1, method: 'notAMethod', params: {} });
    const res = await agent.waitFor(m => m.id === 1);
    assert.equal(res.error.code, -32601);
  } finally {
    agent.stop();
  }
});

/**
 * A PATH-stubbed `claude` binary that honours the prompt-off-argv contract.
 *
 * Interactive call (argv[0] != '-p'): checks that the last argv element is the
 * one-sentence pointer and that the file it names (workspace-relative, so
 * resolved against the cwd) holds the step's prompt, then waits for one line of
 * pty input, echoes a marker, and exits 0 (the human finishing the session).
 * Any deviation exits non-zero before the marker, which fails the test.
 *
 * Harvest call (`-p --resume ...`): the prompt arrives on STDIN, never argv. It
 * parses the artifact path out of harvestPrompt's fixed shape ("... to <path>.
 * Write only the artifact content...") — a workspace-relative path, resolved
 * against the cwd — and writes the artifact there, then exits 0.
 */
/**
 * Two entry points over one implementation, because PATH lookup differs by
 * platform: a shebang file POSIX can exec, and — since Windows resolves only
 * PATHEXT extensions and cannot run a shebang — a `.cmd` shaped like the shim
 * npm writes, which planLaunch reads through to the script it wraps (see
 * exec.ts). An opaque `.cmd` would be pushed through cmd.exe instead, which
 * cannot carry the multi-line system prompt an interactive step sends.
 */
async function stubClaudeBinDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-agent-stub-claude-'));
  const script = [
    '#!/usr/bin/env node',
    'const fs = require("fs");',
    'const args = process.argv.slice(2);',
    'if (args[0] === "-p") {',
    '  if (args.some(a => a.includes("Write the final"))) process.exit(4);',
    '  const prompt = fs.readFileSync(0, "utf8");',
    '  const m = prompt.match(/to (\\S+)\\. Write only the artifact content/);',
    '  if (!m) process.exit(5);',
    '  fs.writeFileSync(require("path").resolve(process.cwd(), m[1]), "STUBBED ARTIFACT CONTENT\\n");',
    '  process.exit(0);',
    '} else {',
    '  const pointer = args[args.length - 1];',
    '  const pm = pointer.match(/^Read and follow the instructions in (\\S+)$/);',
    '  if (!pm) process.exit(2);',
    '  const promptFile = require("path").resolve(process.cwd(), pm[1]);',
    '  if (fs.readFileSync(promptFile, "utf8") !== "hello") process.exit(3);',
    '  for (const flag of ["--append-system-prompt-file", "--settings"]) {',
    '    const i = args.indexOf(flag);',
    '    if (i < 0 || !fs.existsSync(args[i + 1])) process.exit(6);',
    '  }',
    '  process.stdin.setEncoding("utf8");',
    '  let buf = "";',
    '  process.stdin.on("data", d => {',
    '    buf += d;',
    '    if (buf.includes("\\n") || buf.includes("\\r")) {',
    '      process.stdout.write("bye\\n");',
    '      process.exit(0);',
    '    }',
    '  });',
    '}',
    '',
  ].join('\n');
  await writeFile(join(dir, 'claude-impl.js'), script);

  const posix = join(dir, 'claude');
  await writeFile(posix, '#!/usr/bin/env node\nrequire("./claude-impl.js");\n');
  await chmod(posix, 0o755);

  await writeFile(join(dir, 'claude.cmd'), [
    '@ECHO off',
    'SETLOCAL',
    'CALL :find_dp0',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & node "%dp0%\\claude-impl.js" %*',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
  ].join('\r\n') + '\r\n');

  return dir;
}

async function interactiveFixtureWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-agent-interactive-'));
  await mkdir(join(dir, '.whiphand', 'workflows'), { recursive: true });
  await writeFile(join(dir, '.whiphand', 'workflows', 'chat.yaml'), [
    'name: chat',
    'steps:',
    '  - id: chat',
    '    runner: claude',
    '    mode: interactive',
    '    writes: true',
    '    prompt: hello',
    '    output: chat.md',
    '',
  ].join('\n'));
  return dir;
}

test('interactive step: startRun -> ptyStarted -> ptyInput -> ptyExit -> headless harvest -> succeeded, with artifact', async () => {
  const workdir = await interactiveFixtureWorkspace();
  const stubDir = await stubClaudeBinDir();
  const agent = startAgent({ PATH: `${stubDir}${delimiter}${process.env.PATH}` });
  try {
    agent.send({ id: 1, method: 'startRun', params: { workdir, workflow: 'chat' } });
    const started = await agent.waitFor(m => m.id === 1);
    const jobId = started.result.jobId;

    const ptyStarted = await agent.waitFor(m => m.method === 'ptyStarted' && m.params.jobId === jobId);
    assert.equal(ptyStarted.params.stepId, 'chat');
    assert.equal(ptyStarted.params.cols, 80);
    assert.equal(ptyStarted.params.rows, 24);

    // Drive the interactive phase over stdio: write input, which the stub
    // echoes and then exits on, ending the session.
    agent.send({ id: 2, method: 'ptyInput', params: { jobId, data: Buffer.from('go\r', 'utf8').toString('base64') } });
    const inputAck = await agent.waitFor(m => m.id === 2);
    assert.deepEqual(inputAck.result, { ok: true });

    const ptyData = await agent.waitFor(m =>
      m.method === 'ptyData' && m.params.jobId === jobId
      && Buffer.from(m.params.data, 'base64').toString('utf8').includes('bye'));
    assert.ok(ptyData);

    const ptyExit = await agent.waitFor(m => m.method === 'ptyExit' && m.params.jobId === jobId);
    assert.equal(ptyExit.params.exitCode, 0);

    // Harvest runs headlessly after the pty exits — no special agent-side
    // logic needed for it beyond what Task 5 already wired.
    const finalState = await agent.waitFor(m =>
      m.method === 'runStateChanged' && m.params.jobId === jobId && m.params.status !== 'running', 10000);
    assert.equal(finalState.params.status, 'succeeded');
    const runId = finalState.params.runId;

    agent.send({ id: 3, method: 'getRun', params: { workdir, runId } });
    const runDetail = await agent.waitFor(m => m.id === 3);
    const artifact = runDetail.result.artifacts.find((a: any) => a.name === 'chat.md');
    assert.ok(artifact, 'expected a chat.md artifact');
    const content = await readFile(artifact.path, 'utf8');
    assert.equal(content, 'STUBBED ARTIFACT CONTENT\n');
  } finally {
    agent.stop();
  }
});

test('ptyInput against a job with no live PTY errors -32000', async () => {
  const agent = startAgent();
  try {
    agent.send({ id: 1, method: 'ptyInput', params: { jobId: 'no-such-job', data: '' } });
    const res = await agent.waitFor(m => m.id === 1);
    assert.equal(res.error.code, -32000);
  } finally {
    agent.stop();
  }
});

test('ptyResize against an unknown job errors -32000', async () => {
  const agent = startAgent();
  try {
    agent.send({ id: 1, method: 'ptyResize', params: { jobId: 'no-such-job', cols: 100, rows: 30 } });
    const res = await agent.waitFor(m => m.id === 1);
    assert.equal(res.error.code, -32000);
  } finally {
    agent.stop();
  }
});

test('endSession against an unknown job answers ok:false rather than erroring', async () => {
  const agent = startAgent();
  try {
    agent.send({ id: 1, method: 'endSession', params: { jobId: 'no-such-job' } });
    const res = await agent.waitFor(m => m.id === 1);
    assert.deepEqual(res.result, { ok: false });
  } finally {
    agent.stop();
  }
});

test('stdin end triggers a clean exit(0), stdout stays protocol-only', async () => {
  const agent = startAgent();
  const exitCode: number | null = await new Promise(resolvePromise => {
    agent.child.on('exit', code => resolvePromise(code));
    agent.child.stdin.end();
  });
  assert.equal(exitCode, 0);
});
