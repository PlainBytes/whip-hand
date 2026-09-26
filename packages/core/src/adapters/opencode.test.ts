import { withStubBin } from '@whiphand/test-support';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { opencodeAdapter, parseOpencodeModels, OPENCODE_QUIT_SEQUENCE } from './opencode.ts';
import { interactiveGuidance } from '../engine/interactive-guidance.ts';
import { endMarkerPath } from '../engine/session-end.ts';
import { toFwd } from '../path-form.ts';
import { SUGGEST_PROMPT_NAME, harvestPromptPath, promptPath } from '../engine/spawn-files.ts';
import { harvestPrompt } from './common.ts';
import { awaitStatePath } from '../engine/await-state.ts';
import { sessionCapturePath } from '../engine/session-capture.ts';
import { opencodeGuidancePath, opencodePluginPath, opencodePluginIndexPath } from '../engine/opencode-files.ts';
import type { AgentStep, RunCtx, SpawnSpec } from '../types.ts';

const fixtureDir = fileURLToPath(new URL('../../../../parity/fixtures/models/', import.meta.url));

const ctx: RunCtx = {
  workdir: '/w', runId: 'r1', runDir: '/w/.whiphand/runs/r1', runSlug: 'r1',
  sessionIds: {}, artifacts: {}, attempts: {}, verdicts: {}, inputs: {},
};

const planStep: AgentStep = { kind: 'agent',
  id: 'plan', runner: 'opencode', model: 'anthropic/claude', mode: 'interactive',
  writes: false, prompt: 'Plan it.', output: 'plan.md',
};

function configOf(spec: { env: Record<string, string> }): any {
  return JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT);
}

/** What core writes at `path` before the spawn. */
function fileOf(spec: SpawnSpec, path: string): string {
  const file = spec.files?.find(f => f.path === path);
  assert.ok(file, `the spec must carry a file at ${path}; it has ${JSON.stringify(spec.files?.map(f => f.path))}`);
  return file.content;
}

// --- interactive ------------------------------------------------------

test('interactive: fresh spawn has no session flags, --prompt auto-submits the pointer', () => {
  const spec = opencodeAdapter.interactive(planStep, ctx);
  assert.deepEqual(spec.argv, [
    'opencode', '--standalone',
    '--prompt', 'Read and follow the instructions in .whiphand/runs/r1/.plan.prompt',
  ]);
  assert.equal(fileOf(spec, promptPath(ctx.runDir, 'plan')), 'Plan it.');
  assert.equal(spec.stdinFile, undefined);
  assert.equal(spec.cwd, '/w');
  assert.equal(spec.interactive, true);
});

test('interactive: a resumed step continues via -s and drops --prompt entirely', () => {
  const resumedCtx = { ...ctx, sessionIds: { plan: 'ses_abc' }, resumedStepIds: new Set(['plan']) };
  const spec = opencodeAdapter.interactive(planStep, resumedCtx);
  assert.deepEqual(spec.argv, ['opencode', '--standalone', '-s', 'ses_abc']);
});

test('interactive: the TUI gets its agent from default_agent and its model from the agent, never from flags', () => {
  // opencode 2.0's TUI rejects --agent and -m outright ("Unrecognized flag").
  const resumedCtx = { ...ctx, sessionIds: { plan: 'ses_abc' }, resumedStepIds: new Set(['plan']) };
  for (const spec of [opencodeAdapter.interactive(planStep, ctx), opencodeAdapter.interactive(planStep, resumedCtx)]) {
    for (const flag of ['--agent', '-m', '--model', '--variant']) assert.ok(!spec.argv.includes(flag), flag);
    const config = configOf(spec);
    assert.equal(config.default_agent, 'whiphand');
    assert.equal(config.agent.whiphand.model, 'anthropic/claude');
  }
});

test('interactive: throws when no session id is known for a resumed step', () => {
  const resumedCtx = { ...ctx, resumedStepIds: new Set(['plan']) };
  assert.throws(() => opencodeAdapter.interactive(planStep, resumedCtx), /session/);
});

test('interactive: read-only denies edit except a worktree-relative run-dir exception; writes:true allows it all', () => {
  const ro = configOf(opencodeAdapter.interactive(planStep, ctx));
  assert.deepEqual(ro.agent.whiphand.permission.edit, { '*': 'deny', '.whiphand/runs/r1/*': 'allow' });

  const writeStep: AgentStep = { ...planStep, id: 'exec', writes: true };
  const rw = configOf(opencodeAdapter.interactive(writeStep, ctx));
  assert.deepEqual(rw.agent.whiphand.permission.edit, { '*': 'allow' });
});

test('interactive: no relative run-dir exception when the run dir is outside the workdir', () => {
  const outsideCtx: RunCtx = { ...ctx, runDir: '/elsewhere/runs/r1' };
  const config = configOf(opencodeAdapter.interactive(planStep, outsideCtx));
  assert.deepEqual(config.agent.whiphand.permission.edit, { '*': 'deny' });
});

test('interactive: external_directory always names the run dir, for the marker touch', () => {
  const config = configOf(opencodeAdapter.interactive(planStep, ctx));
  assert.deepEqual(config.agent.whiphand.permission.external_directory, { '/w/.whiphand/runs/r1/*': 'allow' });
});

test('interactive: bash carve-out pre-approves exactly the marker touch command', () => {
  const config = configOf(opencodeAdapter.interactive(planStep, ctx));
  // Workspace-relative, the very string the guidance tells the model to run.
  assert.deepEqual(config.agent.whiphand.permission.bash, { 'touch .whiphand/runs/r1/.plan.done': 'allow' });
  const guidance = fileOf(opencodeAdapter.interactive(planStep, ctx), opencodeGuidancePath(ctx.runDir, 'plan'));
  assert.ok(guidance.includes('touch .whiphand/runs/r1/.plan.done'));
});

test('interactive: a run dir with a space quotes the marker in the rule and the guidance alike', () => {
  const spaced: RunCtx = { ...ctx, runDir: '/w/my runs/r1' };
  const spec = opencodeAdapter.interactive(planStep, spaced);
  assert.deepEqual(configOf(spec).agent.whiphand.permission.bash, { "touch 'my runs/r1/.plan.done'": 'allow' });
  assert.ok(fileOf(spec, opencodeGuidancePath(spaced.runDir, 'plan')).includes("touch 'my runs/r1/.plan.done'"));
  assert.deepEqual(spec.awaitState, { statePath: awaitStatePath(spaced.runDir, 'plan') });
});

test('interactive: effort has nowhere to go — 2.0 ignores the agent config variant, and the TUI has no -m', () => {
  const step: AgentStep = { ...planStep, effort: 'high' };
  const spec = opencodeAdapter.interactive(step, ctx);
  assert.equal(configOf(spec).agent.whiphand.model, 'anthropic/claude');
  assert.equal(configOf(spec).agent.whiphand.variant, undefined);
  assert.ok(!spec.argv.some(a => a.includes('high')));
});

test('interactive: instructions and plugin paths in the config match the files delivered', () => {
  const spec = opencodeAdapter.interactive(planStep, ctx);
  const config = configOf(spec);
  const guidance = opencodeGuidancePath(ctx.runDir, 'plan');
  const pluginDir = opencodePluginPath(ctx.runDir, 'plan');
  const pluginIndex = opencodePluginIndexPath(ctx.runDir, 'plan');
  assert.deepEqual(config.instructions, [toFwd(guidance)]);
  // OpenCode 2.0+ plugins are directories; the config points to the directory path.
  assert.deepEqual(config.plugin, [pluginDir]);
  assert.deepEqual(spec.files?.map(f => f.path).sort(), [guidance, pluginIndex, promptPath(ctx.runDir, 'plan')].sort());
  const guidanceFile = spec.files!.find(f => f.path === guidance)!;
  assert.equal(guidanceFile.content, interactiveGuidance(planStep, ctx));
});

test('interactive: carries end-session and await-state specs for the frontend', () => {
  const spec = opencodeAdapter.interactive(planStep, ctx);
  assert.deepEqual(spec.endSession, { markerPath: endMarkerPath(ctx.runDir, 'plan'), quitSequence: OPENCODE_QUIT_SEQUENCE });
  assert.deepEqual(spec.awaitState, { statePath: awaitStatePath(ctx.runDir, 'plan') });
});

test('interactive: no progress spec — nobody is watching a feed on an interactive session', () => {
  assert.equal(opencodeAdapter.interactive(planStep, ctx).progress, undefined);
});

// --- headless -----------------------------------------------------------

test('headless: format json, agent flag, and effort riding on -m as provider/model#variant', () => {
  const step: AgentStep = { ...planStep, mode: 'headless', effort: 'max' };
  const spec = opencodeAdapter.headless(step, ctx);
  assert.deepEqual(spec.argv, [
    'opencode', 'run', '--standalone', '--format', 'json', '--agent', 'whiphand',
    '-m', 'anthropic/claude#max',
    'Read and follow the instructions in .whiphand/runs/r1/.plan.prompt',
  ]);
  assert.equal(fileOf(spec, promptPath(ctx.runDir, 'plan')), 'Plan it.');
  assert.equal(spec.stdinFile, undefined, "opencode's stdin support for `run` is not verified");
  assert.equal(spec.interactive, false);
  assert.deepEqual(spec.progress, { format: 'opencode-json' });
  assert.equal(spec.completeWhenArtifactWritten, true);
  assert.equal(configOf(spec).agent.whiphand.variant, undefined, '2.0 ignores it; -m is the only carrier');
});

test('headless: no effort means a bare model, and effort without a model is dropped — -m needs a model to carry it', () => {
  const step: AgentStep = { ...planStep, mode: 'headless' };
  assert.equal(opencodeAdapter.headless(step, ctx).argv.at(-2), 'anthropic/claude');
  const noModel = opencodeAdapter.headless({ ...step, model: undefined, effort: 'max' }, ctx).argv;
  assert.ok(!noModel.includes('-m'));
  assert.ok(!noModel.some(a => a.includes('max')));
});

test('headless: no support files beyond the prompt — a headless step has no human to collaborate with', () => {
  const step: AgentStep = { ...planStep, mode: 'headless' };
  assert.deepEqual(opencodeAdapter.headless(step, ctx).files?.map(f => f.path), [promptPath(ctx.runDir, 'plan')]);
});

test('headless: writes:false denies edit except the run-dir exception, so a read-only step can still write its artifact; writes:true allows it all', () => {
  const step: AgentStep = { ...planStep, mode: 'headless' };
  assert.deepEqual(configOf(opencodeAdapter.headless(step, ctx)).agent.whiphand.permission.edit,
    { '*': 'deny', '.whiphand/runs/r1/*': 'allow' });
  const writeStep: AgentStep = { ...step, writes: true };
  assert.deepEqual(configOf(opencodeAdapter.headless(writeStep, ctx)).agent.whiphand.permission.edit, { '*': 'allow' });
});

// --- harvest --------------------------------------------------------------

test('harvest: resumes by id, unconditionally allows edit regardless of the step\'s own writes', () => {
  const harvestCtx = { ...ctx, sessionIds: { plan: 'ses_xyz' } };
  const spec = opencodeAdapter.harvest(planStep, harvestCtx); // planStep.writes === false
  assert.deepEqual(spec.argv.slice(0, 7), ['opencode', 'run', '--standalone', '--format', 'json', '-s', 'ses_xyz']);
  assert.ok(spec.argv.includes('--agent'));
  assert.equal(configOf(spec).agent.whiphand.permission.edit['*'], 'allow');
  assert.deepEqual(spec.progress, { format: 'opencode-json' });
  assert.equal(spec.completeWhenArtifactWritten, true);
});

test('harvest: prompt asks for the same artifact write claude/copilot harvest asks for', () => {
  const harvestCtx = { ...ctx, sessionIds: { plan: 'ses_xyz' } };
  const spec = opencodeAdapter.harvest(planStep, harvestCtx);
  assert.equal(spec.argv.at(-1), 'Read and follow the instructions in .whiphand/runs/r1/.plan.harvest-prompt');
  const prompt = fileOf(spec, harvestPromptPath(ctx.runDir, 'plan'));
  assert.equal(prompt, harvestPrompt(planStep, harvestCtx));
  assert.ok(prompt.includes(' .whiphand/runs/r1/plan.md.'), prompt);
  assert.ok(!prompt.includes('/w/.whiphand'), 'workspace-relative, not absolute');
  assert.ok(prompt.includes("'plan.md'"));
  assert.equal(spec.stdinFile, undefined);
});

test('harvest: throws when no session id has been captured yet', () => {
  assert.throws(() => opencodeAdapter.harvest(planStep, ctx), /session/);
});

// --- suggestName ------------------------------------------------------

test('suggestName: its own agent denies everything, captures stdout only, no -m', () => {
  const spec = opencodeAdapter.suggestName!('name it', ctx, '/tmp/cap');
  assert.deepEqual(spec.argv, [
    'opencode', 'run', '--standalone', '--agent', 'whiphand-name',
    'Read and follow the instructions in .whiphand/runs/r1/.name.suggest-prompt',
  ]);
  assert.deepEqual(spec.files, [{ path: join(ctx.runDir, SUGGEST_PROMPT_NAME), content: 'name it' }]);
  assert.equal(spec.stdinFile, undefined);
  assert.deepEqual(configOf(spec), { agent: { 'whiphand-name': { mode: 'primary', permission: { '*': 'deny' } } } });
  assert.deepEqual(spec.capture, { path: '/tmp/cap', streams: 'stdout' });
});

// --- prompt off argv ---------------------------------------------------

test('the pointer sentence is the same for interactive and headless of one step', () => {
  const interactive = opencodeAdapter.interactive(planStep, ctx);
  const headless = opencodeAdapter.headless({ ...planStep, mode: 'headless' }, ctx);
  const a = interactive.argv[interactive.argv.indexOf('--prompt') + 1];
  const b = headless.argv.at(-1);
  assert.equal(a, b);
  assert.equal(a, 'Read and follow the instructions in .whiphand/runs/r1/.plan.prompt');
});

test('--standalone follows the subcommand: opencode 2.0 rejects it in front of one', () => {
  // `opencode --standalone run …` exits 1 with "Unrecognized flag: --standalone
  // in command opencode run"; only the bare TUI takes it straight after `opencode`.
  const harvestCtx = { ...ctx, sessionIds: { plan: 'ses_xyz' } };
  const subcommands: Array<[string, SpawnSpec]> = [
    ['headless', opencodeAdapter.headless({ ...planStep, mode: 'headless' }, ctx)],
    ['harvest', opencodeAdapter.harvest(planStep, harvestCtx)],
    ['suggestName', opencodeAdapter.suggestName!('name it', ctx, '/tmp/cap')],
  ];
  for (const [label, spec] of subcommands) {
    assert.deepEqual(spec.argv.slice(0, 3), ['opencode', 'run', '--standalone'], label);
  }
  assert.equal(opencodeAdapter.interactive(planStep, ctx).argv[1], '--standalone');
});

test('an adversarial prompt is written to the file and never appears in argv or the config env', () => {
  const adversarial =
    `%COMSPEC% "double" 'single' \`tick\` $(id) & | > ^ ! \\ \n\nsecond line\n${'x'.repeat(20000)}`;
  const specs: Array<[string, SpawnSpec]> = [
    ['interactive', opencodeAdapter.interactive({ ...planStep, prompt: adversarial }, ctx)],
    ['headless', opencodeAdapter.headless({ ...planStep, mode: 'headless', prompt: adversarial }, ctx)],
  ];
  for (const [label, spec] of specs) {
    assert.ok(fileOf(spec, promptPath(ctx.runDir, 'plan')).includes(adversarial), `${label}: file carries the prompt`);
    for (const a of spec.argv) {
      assert.ok(a.length < 300, `${label}: an argv element is ${a.length} chars long`);
      for (const bad of ['%COMSPEC%', '"double"', 'second line', 'xxxxxxxxxx', '$(id)']) {
        assert.ok(!a.includes(bad), `${label}: argv carries ${bad}`);
      }
    }
    assert.ok(!spec.env.OPENCODE_CONFIG_CONTENT.includes('second line'), `${label}: nor does the config`);
  }
});

test('the plugin path is the directory, not a file URL', () => {
  const winCtx: RunCtx = { ...ctx, workdir: 'D:\\w', runDir: 'D:\\w\\.whiphand\\runs\\r1' };
  const spec = opencodeAdapter.interactive(planStep, winCtx);
  const pluginDir = opencodePluginPath(winCtx.runDir, 'plan');
  assert.equal(configOf(spec).plugin[0], pluginDir);
  assert.equal(spec.argv[spec.argv.indexOf('--prompt') + 1],
    'Read and follow the instructions in .whiphand/runs/r1/.plan.prompt');
});

// --- listModels ---------------------------------------------------------

test('parseOpencodeModels: keeps only provider/model lines', () => {
  assert.deepEqual(parseOpencodeModels('opencode/big-pickle\nmistral/codestral-latest\n'),
    [{ id: 'opencode/big-pickle' }, { id: 'mistral/codestral-latest' }]);
});

test('parseOpencodeModels: drops blank lines, headings and anything with no slash', () => {
  assert.deepEqual(parseOpencodeModels('\n  \nModels:\nbare-name\nprovider/model\n'), [{ id: 'provider/model' }]);
});

test('listModels: parses the recorded fixture', async () => {
  const fixture = await readFile(join(fixtureDir, 'opencode-models.txt'), 'utf8');
  const models = parseOpencodeModels(fixture);
  assert.ok(models.length > 0);
  assert.ok(models.every(m => /^[^\s/]+\/\S+$/.test(m.id)));
});

test('listModels: opencode not found on PATH reports unavailable, not a throw', async () => {
  const previousPath = process.env.PATH;
  process.env.PATH = '';
  try {
    assert.deepEqual(await opencodeAdapter.listModels!(), { source: 'unavailable', models: [] });
  } finally {
    process.env.PATH = previousPath;
  }
});

// --- detect -------------------------------------------------------------

test('detect: reports not installed (not a throw) when opencode is nowhere on PATH', async () => {
  const previousPath = process.env.PATH;
  process.env.PATH = '';
  try {
    const result = await opencodeAdapter.detect();
    assert.equal(result.installed, false);
  } finally {
    process.env.PATH = previousPath;
  }
});

test('detect: notes when OPENCODE_CONFIG_CONTENT is already set in the environment', async () => {
  const previous = process.env.OPENCODE_CONFIG_CONTENT;
  process.env.OPENCODE_CONFIG_CONTENT = '{}';
  try {
    const result = await opencodeAdapter.detect();
    assert.ok(result.notes?.some(n => n.includes('OPENCODE_CONFIG_CONTENT')));
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
    else process.env.OPENCODE_CONFIG_CONTENT = previous;
  }
});

// --- captureSessionId ---------------------------------------------------

async function tmpRunDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'whiphand-opencode-capture-'));
}

/**
 * The stub `opencode` is minted by test-support in the shape the platform
 * launches — a `#!/bin/sh` script, or a `.cmd` in npm shim shape on Windows —
 * with its behaviour written once, in JS. (It used to be a bash script that
 * Windows' PATHEXT lookup never found, so these were skipped there.) The
 * fallback cases assert `undefined`, which is also what "no opencode found"
 * produces — but the first test's positive match proves the stub is reachable.
 */
async function withSessionListStub<T>(jsonBody: string, fn: () => Promise<T>): Promise<T> {
  const script = `if (process.argv.slice(2, 5).join(' ') === 'session list --standalone') { process.stdout.write(${JSON.stringify(jsonBody)} + '\\n'); process.exit(0); }\nprocess.exit(1);`;
  return withStubBin('opencode', script, () => fn());
}

test('captureSessionId: reads the plugin-written file first, never shelling out', async () => {
  const runDir = await tmpRunDir();
  try {
    await writeFile(sessionCapturePath(runDir, 'plan'), 'ses_from_file');
    const runCtx: RunCtx = { ...ctx, runDir, workdir: runDir };
    // No opencode on PATH at all — a fallback attempt would throw/reject.
    const previousPath = process.env.PATH;
    process.env.PATH = '';
    try {
      assert.equal(await opencodeAdapter.captureSessionId!(planStep, runCtx), 'ses_from_file');
    } finally {
      process.env.PATH = previousPath;
    }
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('captureSessionId: with no file, falls back to session list; exactly one match wins', async () => {
  const runDir = await tmpRunDir();
  try {
    await writeFile(opencodeGuidancePath(runDir, 'plan'), 'guidance');
    const created = Date.now() + 60_000;
    const body = JSON.stringify([{ id: 'ses_fallback', directory: runDir, created }]);
    const runCtx: RunCtx = { ...ctx, runDir, workdir: runDir };
    const result = await withSessionListStub(body, () => opencodeAdapter.captureSessionId!(planStep, runCtx));
    assert.equal(result, 'ses_fallback');
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('captureSessionId: two equally-plausible sessions is ambiguous, not a guess', async () => {
  const runDir = await tmpRunDir();
  try {
    await writeFile(opencodeGuidancePath(runDir, 'plan'), 'guidance');
    const created = Date.now() + 60_000;
    const body = JSON.stringify([
      { id: 'ses_a', directory: runDir, created },
      { id: 'ses_b', directory: runDir, created },
    ]);
    const runCtx: RunCtx = { ...ctx, runDir, workdir: runDir };
    const result = await withSessionListStub(body, () => opencodeAdapter.captureSessionId!(planStep, runCtx));
    assert.equal(result, undefined);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('captureSessionId: no session in this directory created after the guidance file means undefined', async () => {
  const runDir = await tmpRunDir();
  try {
    await writeFile(opencodeGuidancePath(runDir, 'plan'), 'guidance');
    const stale = Date.now() - 60_000;
    const body = JSON.stringify([{ id: 'ses_old', directory: runDir, created: stale }]);
    const runCtx: RunCtx = { ...ctx, runDir, workdir: runDir };
    const result = await withSessionListStub(body, () => opencodeAdapter.captureSessionId!(planStep, runCtx));
    assert.equal(result, undefined);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('captureSessionId: never throws, even when the fallback command itself fails', async () => {
  const runDir = await tmpRunDir();
  try {
    // No guidance file either: the mtime lookup itself throws, inside the try/catch.
    const runCtx: RunCtx = { ...ctx, runDir, workdir: runDir };
    await assert.doesNotReject(async () => {
      const result = await opencodeAdapter.captureSessionId!(planStep, runCtx);
      assert.equal(result, undefined);
    });
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

// --- plugin behaviour -----------------------------------------------------

/**
 * Load and initialize a v2 plugin for testing. Returns an object with an
 * `emit` method that can be used to send events to the plugin, plus the
 * plugin directory for cleanup.
 */
async function loadPlugin(spec: { files?: Array<{ path: string; content: string }> }): Promise<{ emit: (evt: any) => Promise<void>; pluginDir: string }> {
  const pluginIndex = spec.files!.find(f => f.path.endsWith('/index.mjs'))!;
  const pluginDir = pluginIndex.path.replace('/index.mjs', '');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(pluginIndex.path, pluginIndex.content, 'utf8');
  
  // For testing, we create a simple event bus that the plugin can subscribe to
  const eventBus: Array<any> = [];
  const pending: Array<{ resolve: (value: any) => void; reject: (error: any) => void }> = [];
  let firstNextResolved = false;
  
  const mockSubscribe = () => ({
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise((resolve, reject) => {
        if (eventBus.length > 0) {
          firstNextResolved = true;
          resolve({ value: eventBus.shift()!, done: false });
        } else {
          pending.push({ resolve, reject });
        }
      }),
    }),
  });
  
  const mockCtx: any = {
    event: { subscribe: mockSubscribe },
  };
  
  const mod = await import(pathToFileURL(pluginIndex.path).href);
  const pluginDef = mod.default;
  pluginDef.setup(mockCtx);
  
  // Wait for the plugin to call next() at least once
  await new Promise(resolve => {
    const check = () => {
      if (firstNextResolved || pending.length > 0) {
        resolve(void 0);
      } else {
        setTimeout(check, 5);
      }
    };
    check();
  });
  
  return {
    pluginDir,
    emit: async (evt: any) => {
      eventBus.push(evt);
      // Resolve any pending next() calls
      while (pending.length > 0 && eventBus.length > 0) {
        const { resolve } = pending.shift()!;
        resolve({ value: eventBus.shift()!, done: false });
      }
    },
  };
}

test('plugin: captures the root session, ignores a subagent session entirely', async () => {
  const runDir = await tmpRunDir();
  let plugin: Awaited<ReturnType<typeof loadPlugin>> | null = null;
  try {
    const runCtx: RunCtx = { ...ctx, runDir, workdir: runDir };
    const spec = opencodeAdapter.interactive(planStep, runCtx);
    plugin = await loadPlugin(spec);

    await plugin.emit({ type: 'session.created', properties: { info: { id: 'sub1', parentID: 'root1' } } });
    await assert.rejects(() => stat(sessionCapturePath(runDir, 'plan')), 'a subagent session must not be captured');

    await plugin.emit({ type: 'session.created', properties: { info: { id: 'root1' } } });
    assert.equal(await readFile(sessionCapturePath(runDir, 'plan'), 'utf8'), 'root1');

    // The subagent's own status chatter must never touch the await file.
    await plugin.emit({ type: 'session.status', properties: { sessionID: 'sub1', status: { type: 'idle' } } });
    await assert.rejects(() => stat(awaitStatePath(runDir, 'plan')));
  } finally {
    if (plugin) await rm(plugin.pluginDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  }
});

test('plugin: root session.status idle/busy writes and clears the await file', async () => {
  const runDir = await tmpRunDir();
  let plugin: Awaited<ReturnType<typeof loadPlugin>> | null = null;
  try {
    const runCtx: RunCtx = { ...ctx, runDir, workdir: runDir };
    plugin = await loadPlugin(opencodeAdapter.interactive(planStep, runCtx));
    await plugin.emit({ type: 'session.created', properties: { info: { id: 'root1' } } });
    await new Promise(resolve => setTimeout(resolve, 20));

    await plugin.emit({ type: 'session.status', properties: { sessionID: 'root1', status: { type: 'idle' } } });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(JSON.parse(await readFile(awaitStatePath(runDir, 'plan'), 'utf8')), { r: 'turn' });

    await plugin.emit({ type: 'session.status', properties: { sessionID: 'root1', status: { type: 'busy' } } });
    await new Promise(resolve => setTimeout(resolve, 20));
    await assert.rejects(() => stat(awaitStatePath(runDir, 'plan')));
  } finally {
    if (plugin) await rm(plugin.pluginDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  }
});

test('plugin: permission/question asked and replied on the root session', async () => {
  const runDir = await tmpRunDir();
  let plugin: Awaited<ReturnType<typeof loadPlugin>> | null = null;
  try {
    const runCtx: RunCtx = { ...ctx, runDir, workdir: runDir };
    plugin = await loadPlugin(opencodeAdapter.interactive(planStep, runCtx));
    await plugin.emit({ type: 'session.created', properties: { info: { id: 'root1' } } });
    await new Promise(resolve => setTimeout(resolve, 20));

    for (const asked of ['permission.asked', 'question.asked']) {
      await plugin.emit({ type: asked, properties: { sessionID: 'root1' } });
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.deepEqual(JSON.parse(await readFile(awaitStatePath(runDir, 'plan'), 'utf8')), { r: 'permission' }, asked);
    }
    for (const replied of ['permission.replied', 'question.replied', 'question.rejected']) {
      await writeFile(awaitStatePath(runDir, 'plan'), JSON.stringify({ r: 'permission' }));
      await plugin.emit({ type: replied, properties: { sessionID: 'root1' } });
      await new Promise(resolve => setTimeout(resolve, 20));
      await assert.rejects(() => stat(awaitStatePath(runDir, 'plan')), replied);
    }
  } finally {
    if (plugin) await rm(plugin.pluginDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  }
});

test('plugin: the 2.0 event names drive the await file the same way, and still only for the root session', async () => {
  const runDir = await tmpRunDir();
  let plugin: Awaited<ReturnType<typeof loadPlugin>> | null = null;
  try {
    const runCtx: RunCtx = { ...ctx, runDir, workdir: runDir };
    plugin = await loadPlugin(opencodeAdapter.interactive(planStep, runCtx));
    await plugin.emit({ type: 'session.created', properties: { info: { id: 'root1' } } });
    await new Promise(resolve => setTimeout(resolve, 20));
    await plugin.emit({ type: 'session.created', properties: { info: { id: 'sub1', parentID: 'root1' } } });
    await new Promise(resolve => setTimeout(resolve, 20));

    await plugin.emit({ type: 'session.idle', properties: { sessionID: 'sub1' } });
    await new Promise(resolve => setTimeout(resolve, 20));
    await assert.rejects(() => stat(awaitStatePath(runDir, 'plan')), 'a subagent going idle is not the human’s turn');
    await plugin.emit({ type: 'session.idle', properties: { sessionID: 'root1' } });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(JSON.parse(await readFile(awaitStatePath(runDir, 'plan'), 'utf8')), { r: 'turn' });

    for (const asked of ['permission.v2.asked', 'question.v2.asked']) {
      await plugin.emit({ type: asked, properties: { id: 'req1', sessionID: 'root1' } });
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.deepEqual(JSON.parse(await readFile(awaitStatePath(runDir, 'plan'), 'utf8')), { r: 'permission' }, asked);
    }
    for (const replied of ['permission.v2.replied', 'question.v2.replied', 'question.v2.rejected']) {
      await writeFile(awaitStatePath(runDir, 'plan'), JSON.stringify({ r: 'permission' }));
      await plugin.emit({ type: replied, properties: { sessionID: 'root1', requestID: 'req1' } });
      await new Promise(resolve => setTimeout(resolve, 20));
      await assert.rejects(() => stat(awaitStatePath(runDir, 'plan')), replied);
    }
  } finally {
    if (plugin) await rm(plugin.pluginDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  }
});

test('plugin: a resumed spawn bakes in the known session id, with no session.created needed', async () => {
  const runDir = await tmpRunDir();
  let plugin: Awaited<ReturnType<typeof loadPlugin>> | null = null;
  try {
    const runCtx: RunCtx = {
      ...ctx, runDir, workdir: runDir,
      sessionIds: { plan: 'ses_known' }, resumedStepIds: new Set(['plan']),
    };
    plugin = await loadPlugin(opencodeAdapter.interactive(planStep, runCtx));
    // No session.created at all — resume fires none for the root session.
    await plugin.emit({ type: 'session.status', properties: { sessionID: 'ses_known', status: { type: 'idle' } } });
    assert.deepEqual(JSON.parse(await readFile(awaitStatePath(runDir, 'plan'), 'utf8')), { r: 'turn' });
  } finally {
    if (plugin) await rm(plugin.pluginDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  }
});

test('plugin: a fault handling one event never breaks the session', async () => {
  const runDir = await tmpRunDir();
  let plugin: Awaited<ReturnType<typeof loadPlugin>> | null = null;
  try {
    const runCtx: RunCtx = { ...ctx, runDir, workdir: runDir };
    plugin = await loadPlugin(opencodeAdapter.interactive(planStep, runCtx));
    // `event` itself is null: `event.properties` throws inside the handler.
    await assert.doesNotReject(() => plugin!.emit({ type: 'session.status', properties: null }));
  } finally {
    if (plugin) await rm(plugin.pluginDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  }
});
