import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { opencodeAdapter, parseOpencodeModels, OPENCODE_QUIT_SEQUENCE } from './opencode.ts';
import { interactiveGuidance } from '../engine/interactive-guidance.ts';
import { endMarkerPath, shellPath } from '../engine/session-end.ts';
import { awaitStatePath } from '../engine/await-state.ts';
import { sessionCapturePath } from '../engine/session-capture.ts';
import { opencodeGuidancePath, opencodePluginPath } from '../engine/opencode-files.ts';
import type { AgentStep, RunCtx } from '../types.ts';

const fixtureDir = fileURLToPath(new URL('../../../../parity/fixtures/models/', import.meta.url));

const ctx: RunCtx = {
  workdir: '/w', runId: 'r1', runDir: '/w/.whiphand/runs/r1', runSlug: 'r1',
  sessionIds: {}, artifacts: {}, attempts: {}, inputs: {},
};

const planStep: AgentStep = { kind: 'agent',
  id: 'plan', runner: 'opencode', model: 'anthropic/claude', mode: 'interactive',
  writes: false, prompt: 'Plan it.', output: 'plan.md',
};

function configOf(spec: { env: Record<string, string> }): any {
  return JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT);
}

// --- interactive ------------------------------------------------------

test('interactive: fresh spawn has no session flags, --prompt auto-submits', () => {
  const spec = opencodeAdapter.interactive(planStep, ctx);
  assert.deepEqual(spec.argv, [
    'opencode', '--agent', 'whiphand', '-m', 'anthropic/claude', '--prompt', 'Plan it.',
  ]);
  assert.equal(spec.cwd, '/w');
  assert.equal(spec.interactive, true);
});

test('interactive: a resumed step continues via -s and drops --prompt entirely', () => {
  const resumedCtx = { ...ctx, sessionIds: { plan: 'ses_abc' }, resumedStepIds: new Set(['plan']) };
  const spec = opencodeAdapter.interactive(planStep, resumedCtx);
  assert.deepEqual(spec.argv, ['opencode', '-s', 'ses_abc', '--agent', 'whiphand', '-m', 'anthropic/claude']);
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
  const marker = shellPath(endMarkerPath(ctx.runDir, 'plan'));
  assert.deepEqual(config.agent.whiphand.permission.bash, { [`touch ${marker}`]: 'allow' });
});

test('interactive: model and effort land on the agent config, not just argv', () => {
  const step: AgentStep = { ...planStep, effort: 'high' };
  const config = configOf(opencodeAdapter.interactive(step, ctx));
  assert.equal(config.agent.whiphand.model, 'anthropic/claude');
  assert.equal(config.agent.whiphand.variant, 'high');
  // The TUI has no --variant flag (verified against 1.17.13) — only -m appears in argv.
  assert.ok(!opencodeAdapter.interactive(step, ctx).argv.includes('--variant'));
});

test('interactive: instructions and plugin paths in the config match the files delivered', () => {
  const spec = opencodeAdapter.interactive(planStep, ctx);
  const config = configOf(spec);
  const guidance = opencodeGuidancePath(ctx.runDir, 'plan');
  const plugin = opencodePluginPath(ctx.runDir, 'plan');
  assert.deepEqual(config.instructions, [shellPath(guidance)]);
  assert.deepEqual(config.plugin, [`file://${shellPath(plugin)}`]);
  assert.deepEqual(spec.files?.map(f => f.path).sort(), [guidance, plugin].sort());
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

test('headless: format json, agent flag, model and variant argv', () => {
  const step: AgentStep = { ...planStep, mode: 'headless', effort: 'max' };
  const spec = opencodeAdapter.headless(step, ctx);
  assert.deepEqual(spec.argv, [
    'opencode', 'run', '--format', 'json', '--agent', 'whiphand',
    '-m', 'anthropic/claude', '--variant', 'max', 'Plan it.',
  ]);
  assert.equal(spec.interactive, false);
  assert.deepEqual(spec.progress, { format: 'opencode-json' });
});

test('headless: no support files — a headless step has no human to collaborate with', () => {
  const step: AgentStep = { ...planStep, mode: 'headless' };
  assert.equal(opencodeAdapter.headless(step, ctx).files, undefined);
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
  assert.deepEqual(spec.argv.slice(0, 6), ['opencode', 'run', '--format', 'json', '-s', 'ses_xyz']);
  assert.ok(spec.argv.includes('--agent'));
  assert.equal(configOf(spec).agent.whiphand.permission.edit['*'], 'allow');
  assert.deepEqual(spec.progress, { format: 'opencode-json' });
});

test('harvest: prompt asks for the same artifact write claude/copilot harvest asks for', () => {
  const harvestCtx = { ...ctx, sessionIds: { plan: 'ses_xyz' } };
  const spec = opencodeAdapter.harvest(planStep, harvestCtx);
  const prompt = spec.argv.at(-1)!;
  assert.ok(prompt.includes('/w/.whiphand/runs/r1/plan.md'));
  assert.ok(prompt.includes("'plan.md'"));
});

test('harvest: throws when no session id has been captured yet', () => {
  assert.throws(() => opencodeAdapter.harvest(planStep, ctx), /session/);
});

// --- suggestName ------------------------------------------------------

test('suggestName: its own agent denies everything, captures stdout only, no -m', () => {
  const spec = opencodeAdapter.suggestName!('name it', ctx, '/tmp/cap');
  assert.deepEqual(spec.argv, ['opencode', 'run', '--agent', 'whiphand-name', 'name it']);
  assert.deepEqual(configOf(spec), { agent: { 'whiphand-name': { mode: 'primary', permission: { '*': 'deny' } } } });
  assert.deepEqual(spec.capture, { path: '/tmp/cap', streams: 'stdout' });
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

/** Puts a stub `opencode` answering `session list` ahead of PATH for the duration of `fn`. */
async function withSessionListStub<T>(jsonBody: string, fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-opencode-stub-'));
  const script = `#!/usr/bin/env bash\nif [ "$1" = "session" ]; then cat <<'JSON'\n${jsonBody}\nJSON\nexit 0\nfi\nexit 1\n`;
  const file = join(dir, 'opencode');
  await writeFile(file, script, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}:${previousPath}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
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

async function loadPlugin(spec: { files?: Array<{ path: string; content: string }> }): Promise<any> {
  const pluginFile = spec.files!.find(f => f.path.endsWith('.opencode-plugin.mjs'))!;
  await writeFile(pluginFile.path, pluginFile.content, 'utf8');
  const mod = await import(pathToFileURL(pluginFile.path).href);
  return mod.Whiphand();
}

test('plugin: captures the root session, ignores a subagent session entirely', async () => {
  const runDir = await tmpRunDir();
  try {
    const runCtx: RunCtx = { ...ctx, runDir, workdir: runDir };
    const spec = opencodeAdapter.interactive(planStep, runCtx);
    const plugin = await loadPlugin(spec);

    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'sub1', parentID: 'root1' } } } });
    await assert.rejects(() => stat(sessionCapturePath(runDir, 'plan')), 'a subagent session must not be captured');

    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'root1' } } } });
    assert.equal(await readFile(sessionCapturePath(runDir, 'plan'), 'utf8'), 'root1');

    // The subagent's own status chatter must never touch the await file.
    await plugin.event({ event: { type: 'session.status', properties: { sessionID: 'sub1', status: { type: 'idle' } } } });
    await assert.rejects(() => stat(awaitStatePath(runDir, 'plan')));
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('plugin: root session.status idle/busy writes and clears the await file', async () => {
  const runDir = await tmpRunDir();
  try {
    const runCtx: RunCtx = { ...ctx, runDir, workdir: runDir };
    const plugin = await loadPlugin(opencodeAdapter.interactive(planStep, runCtx));
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'root1' } } } });

    await plugin.event({ event: { type: 'session.status', properties: { sessionID: 'root1', status: { type: 'idle' } } } });
    assert.deepEqual(JSON.parse(await readFile(awaitStatePath(runDir, 'plan'), 'utf8')), { r: 'turn' });

    await plugin.event({ event: { type: 'session.status', properties: { sessionID: 'root1', status: { type: 'busy' } } } });
    await assert.rejects(() => stat(awaitStatePath(runDir, 'plan')));
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('plugin: permission/question asked and replied on the root session', async () => {
  const runDir = await tmpRunDir();
  try {
    const runCtx: RunCtx = { ...ctx, runDir, workdir: runDir };
    const plugin = await loadPlugin(opencodeAdapter.interactive(planStep, runCtx));
    await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'root1' } } } });

    for (const asked of ['permission.asked', 'question.asked']) {
      await plugin.event({ event: { type: asked, properties: { sessionID: 'root1' } } });
      assert.deepEqual(JSON.parse(await readFile(awaitStatePath(runDir, 'plan'), 'utf8')), { r: 'permission' }, asked);
    }
    for (const replied of ['permission.replied', 'question.replied', 'question.rejected']) {
      await writeFile(awaitStatePath(runDir, 'plan'), JSON.stringify({ r: 'permission' }));
      await plugin.event({ event: { type: replied, properties: { sessionID: 'root1' } } });
      await assert.rejects(() => stat(awaitStatePath(runDir, 'plan')), replied);
    }
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('plugin: a resumed spawn bakes in the known session id, with no session.created needed', async () => {
  const runDir = await tmpRunDir();
  try {
    const runCtx: RunCtx = {
      ...ctx, runDir, workdir: runDir,
      sessionIds: { plan: 'ses_known' }, resumedStepIds: new Set(['plan']),
    };
    const plugin = await loadPlugin(opencodeAdapter.interactive(planStep, runCtx));
    // No session.created at all — resume fires none for the root session.
    await plugin.event({ event: { type: 'session.status', properties: { sessionID: 'ses_known', status: { type: 'idle' } } } });
    assert.deepEqual(JSON.parse(await readFile(awaitStatePath(runDir, 'plan'), 'utf8')), { r: 'turn' });
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('plugin: a fault handling one event never breaks the session', async () => {
  const runDir = await tmpRunDir();
  try {
    const runCtx: RunCtx = { ...ctx, runDir, workdir: runDir };
    const plugin = await loadPlugin(opencodeAdapter.interactive(planStep, runCtx));
    // `event` itself is null: `event.properties` throws inside the handler.
    await assert.doesNotReject(() => plugin.event({ event: null }));
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
