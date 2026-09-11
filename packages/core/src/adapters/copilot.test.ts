import { test } from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { copilotAdapter, transcriptPath, COPILOT_QUIT_SEQUENCE } from './copilot.ts';
import { interactiveGuidance } from '../engine/interactive-guidance.ts';
import { endMarkerPath, shellPath } from '../engine/session-end.ts';
import type { AgentStep, RunCtx } from '../types.ts';

const ctx: RunCtx = {
  workdir: '/w', runId: 'r1', runDir: '/w/.whiphand/runs/r1', runSlug: 'r1',
  sessionIds: {}, artifacts: {}, attempts: {}, inputs: {},
};

const planStep: AgentStep = { kind: 'agent',
  id: 'plan', runner: 'copilot', model: 'gpt-5.5', mode: 'interactive',
  writes: false, prompt: 'Plan it.', output: 'plan.md',
};

test('transcript path convention', () => {
  assert.equal(transcriptPath(planStep, ctx), '/w/.whiphand/runs/r1/plan-transcript.md');
});

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

test('interactive: seeds via -i, denies write, always shares transcript', () => {
  const spec = copilotAdapter.interactive(planStep, ctx);
  // Shell-rendered, because that is what the runner is handed to execute.
  const marker = shellPath(endMarkerPath(ctx.runDir, 'plan'));
  assert.deepEqual(spec.argv, [
    'copilot', '-i', `${interactiveGuidance(planStep, ctx)}\n\n---\n\nPlan it.`,
    '--model', 'gpt-5.5', '--deny-tool=write',
    `--allow-tool=shell(touch ${marker})`,
    '--share=/w/.whiphand/runs/r1/plan-transcript.md',
  ]);
  assert.equal(spec.interactive, true);
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

test('headless and harvest carry no guidance: they have no human to collaborate with', () => {
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

test('harvest distills the shared transcript into the artifact', () => {
  const spec = copilotAdapter.harvest(planStep, ctx);
  assert.equal(spec.argv[0], 'copilot');
  assert.equal(spec.argv[1], '-p');
  const prompt = spec.argv[2];
  assert.ok(prompt.includes('/w/.whiphand/runs/r1/plan-transcript.md'));
  assert.ok(prompt.includes('/w/.whiphand/runs/r1/plan.md'));
  assert.ok(spec.argv.includes('--allow-all-tools'));
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

test('interactive and harvest ask for no progress: nobody is watching a feed', () => {
  assert.equal(copilotAdapter.interactive(planStep, ctx).progress, undefined);
  assert.equal(copilotAdapter.harvest(planStep, ctx).progress, undefined);
});

test('copilot ignores resumedStepIds, having no session id of its own to resume', () => {
  // sessionIdInjection is false, so whiphand never records an id for a copilot step:
  // there is nothing to resume and the field must change nothing.
  const plain = copilotAdapter.interactive(planStep, ctx).argv;
  const withSet = copilotAdapter
    .interactive(planStep, { ...ctx, resumedStepIds: new Set(['plan']) }).argv;

  assert.deepEqual(withSet, plain);
});
