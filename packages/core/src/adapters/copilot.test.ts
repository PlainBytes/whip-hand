import { test } from 'node:test';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { copilotAdapter, parseCopilotModels, COPILOT_QUIT_SEQUENCE } from './copilot.ts';
import { interactiveGuidance } from '../engine/interactive-guidance.ts';
import { endMarkerPath } from '../engine/session-end.ts';
import { SUGGEST_PROMPT_NAME, harvestPromptPath, promptPath } from '../engine/spawn-files.ts';
import { buildPrompt } from '../template.ts';
import { harvestPrompt } from './common.ts';
import type { AgentStep, RunCtx, SpawnSpec } from '../types.ts';

const fixtureDir = fileURLToPath(new URL('../../../../parity/fixtures/models/', import.meta.url));

const ctx: RunCtx = {
  workdir: '/w', runId: 'r1', runDir: '/w/.whiphand/runs/r1', runSlug: 'r1',
  sessionIds: { plan: 'sid-123' }, artifacts: {}, attempts: {}, verdicts: {}, inputs: {},
};

const planStep: AgentStep = { kind: 'agent',
  id: 'plan', runner: 'copilot', model: 'gpt-5.5', mode: 'interactive',
  writes: false, prompt: 'Plan it.', output: 'plan.md',
};

/** What core writes at `path` before the spawn. */
function fileOf(spec: SpawnSpec, path: string): string {
  const file = spec.files?.find(f => f.path === path);
  assert.ok(file, `the spec must carry a file at ${path}; it has ${JSON.stringify(spec.files?.map(f => f.path))}`);
  return file.content;
}

/** The argv element following `flag`. */
function after(spec: SpawnSpec, flag: string): string {
  return spec.argv[spec.argv.indexOf(flag) + 1];
}

test('a Windows run dir reaches the runner shell-readable, not backslashed', () => {
  // Runs on every platform on purpose: an expectation built from the native
  // path would agree with a broken adapter here and only fail on the Windows
  // leg. Feeding it a Windows-shaped run dir is what makes the check real on
  // Linux. Both the pointer and the marker in the guidance are
  // workspace-relative with forward slashes.
  const winCtx: RunCtx = { ...ctx, workdir: 'D:\\w', runDir: 'D:\\w\\.whiphand\\runs\\r1' };
  const spec = copilotAdapter.interactive(planStep, winCtx);
  assert.equal(after(spec, '-i'), 'Read and follow the instructions in .whiphand/runs/r1/.plan.prompt');
  for (const a of spec.argv) assert.ok(!a.includes('\\'), `argv still carries a backslash: ${a}`);
  const promptFile = spec.files?.find(f => f.content.includes('touch '));
  assert.ok(promptFile, 'the guidance lives in the prompt file');
  assert.ok(promptFile.content.includes('touch .whiphand/runs/r1/.plan.done'),
    'the guidance must name the same marker the rule allows');
  assert.equal(spec.endSession?.markerPath, endMarkerPath(winCtx.runDir, 'plan'),
    'the path the agent watches stays native — it goes to fs, not to a shell');
});

test('interactive: seeds via -i with a pointer, mints via --session-id, denies write', () => {
  const spec = copilotAdapter.interactive(planStep, ctx);
  assert.deepEqual(spec.argv, [
    'copilot', '-i', 'Read and follow the instructions in .whiphand/runs/r1/.plan.prompt',
    '--session-id', 'sid-123',
    '--model', 'gpt-5.5', '--deny-tool=write',
    // copilot matches a shell rule by command name, never by its arguments:
    // `shell(touch <marker>)` matched nothing, so ending a session always
    // stopped at an approval prompt (verified against copilot 1.0.83).
    '--allow-tool=shell(touch)',
  ]);
  assert.equal(spec.interactive, true);
  assert.equal(spec.stdinFile, undefined, 'copilot -p with piped stdin says "No task was provided"');
});

test('interactive: a resumed step continues via --resume= instead of minting', () => {
  const spec = copilotAdapter.interactive(planStep, { ...ctx, resumedStepIds: new Set(['plan']) });
  assert.ok(spec.argv.includes('--resume=sid-123'));
  assert.ok(!spec.argv.includes('--session-id'));
});

test('interactive: copilot has no system-prompt flag, so guidance leads and the task prompt ends, in the one file', () => {
  const spec = copilotAdapter.interactive(planStep, ctx);
  const prompt = fileOf(spec, promptPath(ctx.runDir, 'plan'));
  assert.equal(prompt, `${interactiveGuidance(planStep, ctx)}\n\n---\n\nPlan it.`);
  assert.ok(prompt.startsWith("You are running as step 'plan'"));
  assert.ok(prompt.endsWith('Plan it.'));
  assert.ok(!prompt.includes('\r'), 'LF');
  assert.ok(prompt.includes('touch .whiphand/runs/r1/.plan.done'), 'the marker is workspace-relative');
  assert.ok(!spec.argv.some(a => a.includes('Plan it.') || a.includes('Whiphand workflow')), 'no prompt content on argv');
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
    assert.ok(!spec.files?.some(f => f.content.includes('Whiphand workflow')), 'nor in any file it reads');
    assert.equal(spec.endSession, undefined);
  }
});

test('headless writes:true requires --allow-all-tools', () => {
  const step: AgentStep = { kind: 'agent', id: 'exec', runner: 'copilot', mode: 'headless', writes: true, prompt: 'Do.', output: 'r.md' };
  const spec = copilotAdapter.headless(step, ctx);
  assert.deepEqual(spec.argv, [
    'copilot', '-p', 'Read and follow the instructions in .whiphand/runs/r1/.exec.prompt',
    '--allow-all-tools', '--output-format', 'json', '--stream', 'on', '--no-color',
  ]);
  assert.equal(spec.interactive, false);
  assert.equal(fileOf(spec, promptPath(ctx.runDir, 'exec')), 'Do.');
  assert.equal(spec.stdinFile, undefined);
});

test('headless writes:false allows file writes only to its own artifact', () => {
  // A deny rule always beats an allow rule in copilot, so `--deny-tool=write`
  // also blocked the artifact write itself and every read-only step failed.
  // Without --allow-all-tools, a write that no rule allows is refused instead.
  const step: AgentStep = { kind: 'agent', id: 'rev', runner: 'copilot', mode: 'headless', writes: false, prompt: 'Review.', output: 'f.md' };
  const loopCtx: RunCtx = { ...ctx, artifacts: { rev: '/w/.whiphand/runs/r1/fix/iter-2/f.md' } };
  const spec = copilotAdapter.headless(step, loopCtx);
  assert.equal(fileOf(spec, promptPath(ctx.runDir, 'rev')), 'Review.');
  assert.deepEqual(spec.argv, [
    'copilot', '-p', 'Read and follow the instructions in .whiphand/runs/r1/.rev.prompt',
    '--allow-tool=shell', '--allow-tool=url',
    '--allow-tool=write(/w/.whiphand/runs/r1/fix/iter-2/f.md)',
    '--output-format', 'json', '--stream', 'on', '--no-color',
  ]);
});

test('harvest resumes the session by id and asks it to write the artifact', () => {
  const spec = copilotAdapter.harvest(planStep, ctx);
  assert.equal(spec.argv[0], 'copilot');
  assert.equal(spec.argv[1], '-p');
  assert.equal(spec.argv[2], 'Read and follow the instructions in .whiphand/runs/r1/.plan.harvest-prompt');
  const prompt = fileOf(spec, harvestPromptPath(ctx.runDir, 'plan'));
  assert.equal(prompt, harvestPrompt(planStep, ctx));
  assert.ok(prompt.includes(' .whiphand/runs/r1/plan.md.'), prompt);
  assert.ok(!prompt.includes('/w/.whiphand'), 'workspace-relative, not absolute');
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
    assert.ok(noConfig.notes?.some(n => n.includes('beep') && n.includes(join(home, 'settings.json'))),
      'no config means the default, which is off — and user settings go in settings.json');
  }

  // copilot 1.0.83 writes config.json itself, starting with `//` comment lines.
  await writeFile(join(home, 'config.json'), `// This file is managed automatically.\n${JSON.stringify({ beep: true })}`);
  const inManagedConfig = await copilotAdapter.detect();
  if (inManagedConfig.installed) assert.deepEqual(inManagedConfig.notes, [], 'a commented config.json still reads');

  await writeFile(join(home, 'config.json'), '// This file is managed automatically.\n{}');
  await writeFile(join(home, 'settings.json'), JSON.stringify({ beep: true }));
  const inSettings = await copilotAdapter.detect();
  if (inSettings.installed) assert.deepEqual(inSettings.notes, [], 'nothing to say once settings.json turns it on');
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

// --- prompt off argv ---------------------------------------------------

test('the pointer sentence is the same for interactive and headless of one step', () => {
  // One sentence, one file name: the two modes cannot drift apart, and the
  // sentence has no metacharacter for a shim to mishandle.
  const headlessStep: AgentStep = { ...planStep, mode: 'headless' };
  const interactive = after(copilotAdapter.interactive(planStep, ctx), '-i');
  const headless = after(copilotAdapter.headless(headlessStep, ctx), '-p');
  assert.equal(interactive, headless);
  assert.equal(interactive, 'Read and follow the instructions in .whiphand/runs/r1/.plan.prompt');
});

test('an adversarial prompt is written to the file and never appears in argv', () => {
  const adversarial =
    `%COMSPEC% "double" 'single' \`tick\` $(id) & | > ^ ! \\ \n\nsecond line\n${'x'.repeat(20000)}`;
  const headlessStep: AgentStep = { ...planStep, mode: 'headless', prompt: adversarial };
  const specs: Array<[string, SpawnSpec]> = [
    ['interactive', copilotAdapter.interactive({ ...planStep, prompt: adversarial }, ctx)],
    ['headless', copilotAdapter.headless(headlessStep, ctx)],
  ];
  for (const [label, spec] of specs) {
    assert.ok(fileOf(spec, promptPath(ctx.runDir, 'plan')).includes(adversarial), `${label}: file carries the prompt`);
    for (const a of spec.argv) {
      assert.ok(a.length < 300, `${label}: an argv element is ${a.length} chars long`);
      for (const bad of ['%COMSPEC%', '"double"', 'second line', 'xxxxxxxxxx', '$(id)']) {
        assert.ok(!a.includes(bad), `${label}: argv carries ${bad}`);
      }
    }
  }
});

test('headless: the prompt file holds buildPrompt, LF', () => {
  const step: AgentStep = { ...planStep, mode: 'headless', prompt: 'one\r\ntwo' };
  const content = fileOf(copilotAdapter.headless(step, ctx), promptPath(ctx.runDir, 'plan'));
  assert.equal(content, buildPrompt({ ...step, prompt: 'one\r\ntwo' }, ctx).replace(/\r\n?/g, '\n'));
  assert.ok(!content.includes('\r'));
});

test('harvest and suggestName: pointer argv plus the file, and no stdinFile', () => {
  const harvest = copilotAdapter.harvest(planStep, ctx);
  assert.deepEqual(harvest.files, [{ path: harvestPromptPath(ctx.runDir, 'plan'), content: harvestPrompt(planStep, ctx) }]);
  assert.equal(harvest.stdinFile, undefined);

  const capture = join(ctx.runDir, '.name.out');
  const suggest = copilotAdapter.suggestName!('Name it: "%X%" & co\r\nplease', ctx, capture);
  const file = join(ctx.runDir, SUGGEST_PROMPT_NAME);
  assert.deepEqual(suggest.argv, [
    'copilot', '-p', 'Read and follow the instructions in .whiphand/runs/r1/.name.suggest-prompt',
    '--model', 'gpt-5-mini', '--deny-tool=write', '--deny-tool=shell', '--no-color',
  ]);
  assert.deepEqual(suggest.files, [{ path: file, content: 'Name it: "%X%" & co\nplease' }]);
  assert.equal(suggest.stdinFile, undefined);
  assert.deepEqual(suggest.capture, { path: capture, streams: 'stdout' });
});
