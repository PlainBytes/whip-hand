import { test } from 'node:test';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { copilotAdapter, parseCopilotModels, COPILOT_QUIT_SEQUENCE } from './copilot.ts';
import { interactiveGuidance } from '../engine/interactive-guidance.ts';
import { endMarkerPath, shellPath } from '../engine/session-end.ts';
import type { AgentStep, RunCtx } from '../types.ts';

const fixtureDir = fileURLToPath(new URL('../../../../parity/fixtures/models/', import.meta.url));

const ctx: RunCtx = {
  workdir: '/w', runId: 'r1', runDir: '/w/.whiphand/runs/r1', runSlug: 'r1',
  sessionIds: { plan: 'sid-123' }, artifacts: {}, attempts: {}, inputs: {},
};

const planStep: AgentStep = { kind: 'agent',
  id: 'plan', runner: 'copilot', model: 'gpt-5.5', mode: 'interactive',
  writes: false, prompt: 'Plan it.', output: 'plan.md',
};

test('a Windows run dir reaches the runner shell-readable, not backslashed', () => {
  // Runs on every platform on purpose: shellPath is the identity off Windows,
  // so an expectation built from the native path would agree with a broken
  // adapter here and only fail on the Windows leg. Feeding it a Windows-shaped
  // run dir is what makes the check real on Linux.
  const winCtx: RunCtx = { ...ctx, workdir: 'D:\\w', runDir: 'D:\\w\\.whiphand\\runs\\r1' };
  const spec = copilotAdapter.interactive(planStep, winCtx);
  assert.ok(spec.argv.includes('--allow-tool=shell(touch D:/w/.whiphand/runs/r1/.plan.done)'),
    `no shell-readable marker rule in ${JSON.stringify(spec.argv)}`);
  const guidance = spec.argv[spec.argv.indexOf('-i') + 1];
  assert.ok(guidance.includes('touch D:/w/.whiphand/runs/r1/.plan.done'),
    'the guidance must name the same marker the rule allows');
  assert.equal(spec.endSession?.markerPath, endMarkerPath(winCtx.runDir, 'plan'),
    'the path the agent watches stays native — it goes to fs, not to a shell');
});

test('interactive: seeds via -i, mints via --session-id, denies write', () => {
  const spec = copilotAdapter.interactive(planStep, ctx);
  // Shell-rendered, because that is what the runner is handed to execute.
  const marker = shellPath(endMarkerPath(ctx.runDir, 'plan'));
  assert.deepEqual(spec.argv, [
    'copilot', '-i', `${interactiveGuidance(planStep, ctx)}\n\n---\n\nPlan it.`,
    '--session-id', 'sid-123',
    '--model', 'gpt-5.5', '--deny-tool=write',
    `--allow-tool=shell(touch ${marker})`,
  ]);
  assert.equal(spec.interactive, true);
});

test('interactive: a resumed step continues via --resume= instead of minting', () => {
  const spec = copilotAdapter.interactive(planStep, { ...ctx, resumedStepIds: new Set(['plan']) });
  assert.ok(spec.argv.includes('--resume=sid-123'));
  assert.ok(!spec.argv.includes('--session-id'));
});

test('interactive: copilot has no system-prompt flag, so guidance leads and the task prompt ends', () => {
  const spec = copilotAdapter.interactive(planStep, ctx);
  const prompt = spec.argv[spec.argv.indexOf('-i') + 1];
  assert.ok(prompt.startsWith("You are running as step 'plan'"));
  assert.ok(prompt.endsWith('Plan it.'));
});

test('interactive: has no await-state spec, because copilot has no hooks', () => {
  // Its only attention signal is the terminal bell, which needs no spec field.
  assert.equal(copilotAdapter.interactive(planStep, ctx).awaitState, undefined);
});

test('interactive: carries the end-session spec the frontend watches', () => {
  const spec = copilotAdapter.interactive(planStep, ctx);
  assert.deepEqual(spec.endSession, {
    markerPath: endMarkerPath(ctx.runDir, 'plan'),
    quitSequence: COPILOT_QUIT_SEQUENCE,
  });
});

test('headless and harvest carry no interactive guidance: they have no human to collaborate with', () => {
  const step: AgentStep = { ...planStep, mode: 'headless' };
  for (const spec of [copilotAdapter.headless(step, ctx), copilotAdapter.harvest(planStep, ctx)]) {
    assert.ok(!spec.argv.some(a => a.includes('Whiphand workflow')));
    assert.equal(spec.endSession, undefined);
  }
});

test('headless writes:true requires --allow-all-tools', () => {
  const step: AgentStep = { kind: 'agent', id: 'exec', runner: 'copilot', mode: 'headless', writes: true, prompt: 'Do.', output: 'r.md' };
  const spec = copilotAdapter.headless(step, ctx);
  assert.deepEqual(spec.argv, [
    'copilot', '-p', 'Do.', '--allow-all-tools', '--output-format', 'json', '--stream', 'on', '--no-color',
  ]);
  assert.equal(spec.interactive, false);
});

test('headless writes:false adds write denial (denial beats allow-all)', () => {
  const step: AgentStep = { kind: 'agent', id: 'rev', runner: 'copilot', mode: 'headless', writes: false, prompt: 'Review.', output: 'f.md' };
  const spec = copilotAdapter.headless(step, ctx);
  assert.deepEqual(spec.argv, [
    'copilot', '-p', 'Review.', '--allow-all-tools', '--deny-tool=write',
    '--output-format', 'json', '--stream', 'on', '--no-color',
  ]);
});

test('harvest resumes the session by id and asks it to write the artifact', () => {
  const spec = copilotAdapter.harvest(planStep, ctx);
  assert.equal(spec.argv[0], 'copilot');
  assert.equal(spec.argv[1], '-p');
  const prompt = spec.argv[2];
  assert.ok(prompt.includes('/w/.whiphand/runs/r1/plan.md'));
  assert.ok(spec.argv.includes('--resume=sid-123'));
  assert.ok(spec.argv.includes('--allow-all-tools'));
  assert.ok(!spec.argv.some(a => a.includes('--share')));
});

test('harvest reports progress: --output-format json --stream on does not disturb the write', () => {
  const spec = copilotAdapter.harvest(planStep, ctx);
  assert.deepEqual(spec.progress, { format: 'copilot-jsonl' });
  assert.ok(spec.argv.includes('--output-format'));
  assert.equal(spec.argv[spec.argv.indexOf('--output-format') + 1], 'json');
});

test('detect notes that copilot cannot signal for attention while beep is off', async t => {
  // Its only attention channel is the terminal bell, and beep defaults to off.
  const home = await mkdtemp(join(tmpdir(), 'whiphand-copilot-'));
  const previous = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = previous;
  });

  const noConfig = await copilotAdapter.detect();
  if (noConfig.installed) {
    assert.ok(noConfig.notes?.some(n => n.includes('beep')), 'no config means the default, which is off');
  }

  await writeFile(join(home, 'config.json'), JSON.stringify({ beep: true }));
  const withBeep = await copilotAdapter.detect();
  if (withBeep.installed) assert.deepEqual(withBeep.notes, [], 'nothing to say once it is on');
});

test('headless asks for streaming jsonl so a running step can report progress', () => {
  const step: AgentStep = { ...planStep, mode: 'headless' };
  const spec = copilotAdapter.headless(step, ctx);
  assert.equal(spec.argv[spec.argv.indexOf('--output-format') + 1], 'json');
  assert.equal(spec.argv[spec.argv.indexOf('--stream') + 1], 'on');
  assert.deepEqual(spec.progress, { format: 'copilot-jsonl' });
});

test('interactive asks for no progress: nobody is watching a feed there', () => {
  assert.equal(copilotAdapter.interactive(planStep, ctx).progress, undefined);
});

// --- listModels -------------------------------------------------------

test('parseCopilotModels: extracts every id under the `model` heading, appends auto', async () => {
  const helpOutput = await readFile(join(fixtureDir, 'copilot-help-config.txt'), 'utf8');
  const models = parseCopilotModels(helpOutput);
  assert.deepEqual(models.map(m => m.id).slice(0, 3), ['claude-sonnet-5', 'claude-fable-5.1', 'claude-fable-5']);
  assert.ok(models.some(m => m.id === 'gpt-5-mini'), 'a gpt id from the list is present');
  // Stops at the first blank line, so contextTier's own bullets never leak in.
  assert.equal(models.length, 27, 'exactly the fixture\'s 26 model ids plus auto');
  assert.deepEqual(models.at(-2), { id: 'kimi-k2.7-code' }, 'last real id before auto');
  assert.equal(models.at(-1)?.id, 'auto', 'auto is appended last');
});

test('parseCopilotModels: no `model` heading means no suggestions', () => {
  assert.deepEqual(parseCopilotModels('Configuration Settings:\n\n  `logLevel`: ...\n'), []);
});

test('parseCopilotModels: a heading with no bullet lines under it means no suggestions', () => {
  assert.deepEqual(parseCopilotModels('  `model`: AI model to use.\n\n  `contextTier`: ...\n'), []);
});

test('listModels: copilot not found on PATH reports unavailable, not a throw', async () => {
  const previousPath = process.env.PATH;
  process.env.PATH = '';
  try {
    const result = await copilotAdapter.listModels!();
    assert.deepEqual(result, { source: 'unavailable', models: [] });
  } finally {
    process.env.PATH = previousPath;
  }
});

test('copilot capabilities: sessionIdInjection+sessionResume, no share transcript any more', () => {
  assert.deepEqual(copilotAdapter.capabilities, {
    sessionIdInjection: true, sessionIdCapture: false, sessionResume: true,
    toolDenial: true, shareTranscript: false,
  });
});
