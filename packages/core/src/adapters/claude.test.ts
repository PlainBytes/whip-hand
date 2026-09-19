import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeAdapter, CLAUDE_WRITE_TOOLS, CLAUDE_QUIT_SEQUENCE } from './claude.ts';
import { interactiveGuidance } from '../engine/interactive-guidance.ts';
import { endMarkerPath } from '../engine/session-end.ts';
import { awaitStatePath } from '../engine/await-state.ts';
import {
  SUGGEST_PROMPT_NAME, harvestPromptPath, promptPath, settingsPath, systemPromptPath,
} from '../engine/spawn-files.ts';
import { buildPrompt } from '../template.ts';
import { harvestPrompt } from './common.ts';
import { join } from 'node:path';
import { toFwdAbs } from '../path-form.ts';
import type { AgentStep, RunCtx, SpawnSpec } from '../types.ts';

// A workspace in the host's own native form, so the same expectations hold on every
// platform instead of being gated to POSIX: `FWD` is what the adapter emits for it —
// absolute with forward slashes (`/w` here, `D:/w` on Windows).
const WORK = process.platform === 'win32' ? 'D:\\w' : '/w';
const FWD = toFwdAbs(WORK);

const ctx: RunCtx = {
  workdir: WORK, runId: 'r1', runDir: join(WORK, '.whiphand', 'runs', 'r1'), runSlug: 'r1',
  sessionIds: { plan: '11111111-1111-4111-8111-111111111111' },
  artifacts: {}, attempts: {}, verdicts: {}, inputs: {},
};

const planStep: AgentStep = { kind: 'agent',
  id: 'plan', runner: 'claude', model: 'opus', mode: 'interactive',
  writes: false, prompt: 'Plan it.', output: 'plan.md',
};

/** Hand-written on purpose: building it from the adapter's own helper would let it drift silently. */
const EXPECTED_SETTINGS = {
  // The rule is the string the model is told to run: workspace-relative.
  permissions: { allow: ['Bash(touch .whiphand/runs/r1/.plan.done)'] },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: `printf '{"r":"turn"}' > ${FWD}/.whiphand/runs/r1/.plan.await 2>/dev/null; exit 0` }] }],
    PermissionRequest: [{ hooks: [{ type: 'command', command: `printf '{"r":"permission"}' > ${FWD}/.whiphand/runs/r1/.plan.await 2>/dev/null; exit 0` }] }],
    Notification: [{ hooks: [{ type: 'command', command: `cat > ${FWD}/.whiphand/runs/r1/.plan.await 2>/dev/null; exit 0` }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: `rm -f ${FWD}/.whiphand/runs/r1/.plan.await >/dev/null 2>&1; exit 0` }] }],
  },
};

/** What core writes at `path` before the spawn. */
function fileOf(spec: SpawnSpec, path: string): string {
  const file = spec.files?.find(f => f.path === path);
  assert.ok(file, `the spec must carry a file at ${path}; it has ${JSON.stringify(spec.files?.map(f => f.path))}`);
  return file.content;
}

/** The settings object, read from the file `--settings` names (the object is not on argv any more). */
function settingsOf(spec: SpawnSpec, c: RunCtx = ctx): typeof EXPECTED_SETTINGS {
  return JSON.parse(fileOf(spec, settingsPath(c.runDir, 'plan')));
}

/** The guidance, read from the file `--append-system-prompt-file` names. */
function guidanceOf(spec: SpawnSpec, c: RunCtx = ctx): string {
  return fileOf(spec, systemPromptPath(c.runDir, 'plan'));
}

test('interactive: pins session, denies write tools, appends guidance by file, seeds the pointer last', () => {
  const spec = claudeAdapter.interactive(planStep, ctx);
  assert.deepEqual(spec.argv, [
    'claude', '--session-id', '11111111-1111-4111-8111-111111111111',
    '--model', 'opus', `--disallowedTools=${CLAUDE_WRITE_TOOLS}`,
    '--append-system-prompt-file', `${FWD}/.whiphand/runs/r1/.plan.system-prompt.md`,
    '--settings', `${FWD}/.whiphand/runs/r1/.plan.settings.json`,
    'Read and follow the instructions in .whiphand/runs/r1/.plan.prompt',
  ]);
  assert.equal(spec.cwd, WORK);
  assert.equal(spec.interactive, true);
});

test('interactive: the prompt, the guidance and the settings are written as files, prompt content off argv', () => {
  const spec = claudeAdapter.interactive(planStep, ctx);
  assert.equal(fileOf(spec, promptPath(ctx.runDir, 'plan')), 'Plan it.');
  assert.equal(fileOf(spec, systemPromptPath(ctx.runDir, 'plan')), interactiveGuidance(planStep, ctx));
  assert.ok(fileOf(spec, settingsPath(ctx.runDir, 'plan')).endsWith('\n'));
  assert.equal(spec.stdinFile, undefined, 'an interactive session reads the terminal, not a piped file');
  for (const a of spec.argv) {
    assert.ok(!a.includes('Plan it.'), `the prompt text must not ride on argv: ${a}`);
    assert.ok(!a.includes('Stay inside this step'), `the guidance must not ride on argv: ${a}`);
    assert.ok(!a.includes('{'), `no inline JSON on argv: ${a}`);
  }
});

test('interactive: one --settings path names the file carrying both the permission rule and the hooks', () => {
  const spec = claudeAdapter.interactive(planStep, ctx);
  assert.equal(spec.argv.filter(a => a === '--settings').length, 1, 'claude takes exactly one');
  assert.equal(spec.argv[spec.argv.indexOf('--settings') + 1], `${FWD}/.whiphand/runs/r1/.plan.settings.json`);
  assert.deepEqual(settingsOf(spec), EXPECTED_SETTINGS);
});

test('interactive: every hook command exits 0', () => {
  // Load-bearing. A Stop hook exiting nonzero blocks the agent from stopping,
  // and a PermissionRequest hook exiting 2 denies the tool outright.
  const entries = Object.values(settingsOf(claudeAdapter.interactive(planStep, ctx)).hooks);
  assert.equal(entries.length, 4);
  for (const entry of entries) {
    for (const h of entry[0].hooks) assert.ok(h.command.endsWith('; exit 0'), h.command);
  }
});

test('interactive: hooks touch the await path and nothing else', () => {
  const awaitPath = awaitStatePath(ctx.runDir, 'plan');
  const { hooks } = settingsOf(claudeAdapter.interactive(planStep, ctx));
  for (const [event, entry] of Object.entries(hooks)) {
    const { command } = entry[0].hooks[0];
    assert.ok(command.includes(awaitPath), `${event} writes the await path`);
    const paths = (command.match(/\/[^\s'"]*/g) ?? [])
      .map(x => x.replace(/[;&|]+$/, ''))
      .filter(x => x !== '/dev/null');
    assert.deepEqual(paths, [awaitPath], `${event} names no path but the await file`);
  }
});

test('interactive: UserPromptSubmit clears the state rather than writing one', () => {
  const { hooks } = settingsOf(claudeAdapter.interactive(planStep, ctx));
  assert.match(hooks.UserPromptSubmit[0].hooks[0].command, /^rm -f /);
});

test('interactive: Notification dumps its raw payload instead of trusting a matcher', () => {
  // The agent maps notification_type itself; matcher filtering is unverified.
  const { hooks } = settingsOf(claudeAdapter.interactive(planStep, ctx));
  assert.match(hooks.Notification[0].hooks[0].command, /^cat > /);
  for (const entry of Object.values(hooks)) {
    assert.ok(!('matcher' in entry[0]), 'no entry depends on matcher semantics');
  }
});

test('interactive: carries the await-state spec the frontend watches', () => {
  const spec = claudeAdapter.interactive(planStep, ctx);
  assert.deepEqual(spec.awaitState, { statePath: awaitStatePath(ctx.runDir, 'plan') });
});

test('a Windows run dir still gets settings, with every path a shell can read', () => {
  // The whole object used to be dropped on Windows: SHELL_SAFE_PATH has no
  // backslash in it, so a native run-dir path failed the guard and an
  // interactive step reported no await state and got no end-session rule.
  // Forward slashes name the same file, and are what Git Bash — which is what
  // claude runs hook commands and Bash tool calls through on Windows — can
  // actually read. The rule is workspace-relative, like the guidance.
  const winCtx: RunCtx = { ...ctx, workdir: 'D:\\w', runDir: 'D:\\w\\.whiphand\\runs\\r1' };
  const spec = claudeAdapter.interactive(planStep, winCtx);

  assert.equal(spec.argv[spec.argv.indexOf('--settings') + 1], 'D:/w/.whiphand/runs/r1/.plan.settings.json',
    '--settings must be emitted on Windows, as an absolute forward-slash path');
  assert.equal(spec.argv[spec.argv.indexOf('--append-system-prompt-file') + 1], 'D:/w/.whiphand/runs/r1/.plan.system-prompt.md');
  assert.equal(spec.argv.at(-1), 'Read and follow the instructions in .whiphand/runs/r1/.plan.prompt');
  for (const a of spec.argv) assert.ok(!a.includes('\\'), `argv still carries a backslash: ${a}`);
  const settings = settingsOf(spec, winCtx);
  assert.deepEqual(settings.permissions.allow, ['Bash(touch .whiphand/runs/r1/.plan.done)']);
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const { command } = groups[0].hooks[0];
    assert.ok(!command.includes('\\'), `${event} hook still carries a backslash: ${command}`);
    assert.ok(command.includes('D:/w/.whiphand/runs/r1/.plan.await'), `${event} hook lost the await path: ${command}`);
  }
  assert.equal(spec.awaitState?.statePath, awaitStatePath(winCtx.runDir, 'plan'),
    'the path the frontend watches stays native — it goes to fs, not to a shell');
});

test('the end-session rule and the guidance name the marker identically', () => {
  // Two halves of one mechanism: the guidance tells the model to run
  // `touch <marker>` and the rule pre-approves exactly that string. A
  // difference of one character means a permission prompt as the last thing
  // the human sees.
  for (const c of [
    ctx,
    { ...ctx, workdir: 'D:\\w', runDir: 'D:\\w\\.whiphand\\runs\\r1' },
    { ...ctx, runDir: join(WORK, 'my runs', 'r1') },
  ]) {
    const spec = claudeAdapter.interactive(planStep, c);
    const quoted = guidanceOf(spec, c).match(/touch ('[^']*'|\S+)/);
    assert.ok(quoted, 'guidance must name the touch command');
    assert.deepEqual(settingsOf(spec, c).permissions.allow, [`Bash(touch ${quoted[1]})`]);
  }
});

test('interactive: the system prompt names the marker the session ends with', () => {
  const guidance = guidanceOf(claudeAdapter.interactive(planStep, ctx));
  assert.ok(guidance.includes('touch .whiphand/runs/r1/.plan.done'), 'workspace-relative marker');
  assert.ok(!guidance.includes(endMarkerPath(ctx.runDir, 'plan')), 'never the absolute path');
  assert.ok(guidance.includes('(.whiphand/runs/r1)'), 'the run-dir carve-out is workspace-relative too');
});

test('interactive: carries the end-session spec the frontend watches', () => {
  const spec = claudeAdapter.interactive(planStep, ctx);
  assert.deepEqual(spec.endSession, {
    markerPath: endMarkerPath(ctx.runDir, 'plan'),
    quitSequence: CLAUDE_QUIT_SEQUENCE,
  });
});

test('interactive: a run dir with a space still gets settings, awaitState and single-quoted hook paths', () => {
  // SHELL_SAFE_PATH used to drop the whole settings object — permission rule,
  // all four hooks and await-state — for any path containing a space, a
  // routine case for a Windows home directory. It is deleted: shQuote quotes
  // the path where it needs it.
  const spaced: RunCtx = { ...ctx, runDir: join(WORK, 'my runs', 'r1') };
  const spec = claudeAdapter.interactive(planStep, spaced);
  assert.equal(spec.argv[spec.argv.indexOf('--settings') + 1], `${FWD}/my runs/r1/.plan.settings.json`,
    'a path with a space is fine as one argv element');
  assert.deepEqual(spec.awaitState, { statePath: awaitStatePath(spaced.runDir, 'plan') });
  assert.equal(spec.endSession?.markerPath, endMarkerPath(spaced.runDir, 'plan'));

  const settings = settingsOf(spec, spaced);
  assert.deepEqual(settings.permissions.allow, [`Bash(touch 'my runs/r1/.plan.done')`]);
  const await_ = `'${FWD}/my runs/r1/.plan.await'`;
  assert.equal(settings.hooks.Stop[0].hooks[0].command, `printf '{"r":"turn"}' > ${await_} 2>/dev/null; exit 0`);
  assert.equal(settings.hooks.PermissionRequest[0].hooks[0].command, `printf '{"r":"permission"}' > ${await_} 2>/dev/null; exit 0`);
  assert.equal(settings.hooks.Notification[0].hooks[0].command, `cat > ${await_} 2>/dev/null; exit 0`);
  assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, `rm -f ${await_} >/dev/null 2>&1; exit 0`);
});

test('interactive: awaitState is always set, and an ordinary path stays unquoted', () => {
  const spec = claudeAdapter.interactive(planStep, ctx);
  assert.deepEqual(spec.awaitState, { statePath: awaitStatePath(ctx.runDir, 'plan') });
  for (const entry of Object.values(settingsOf(spec).hooks)) {
    assert.ok(!entry[0].hooks[0].command.includes(`'${FWD}`), 'shQuote leaves a safe path byte-identical');
  }
});

test('headless and harvest carry no guidance: they have no human to collaborate with', () => {
  const step: AgentStep = { ...planStep, mode: 'headless' };
  for (const spec of [claudeAdapter.headless(step, ctx), claudeAdapter.harvest(planStep, ctx)]) {
    assert.ok(!spec.argv.includes('--append-system-prompt'));
    assert.ok(!spec.argv.includes('--append-system-prompt-file'));
    assert.ok(!spec.argv.includes('--settings'), 'no hooks: nobody is waiting on a human');
    assert.deepEqual(spec.files?.map(f => f.path).filter(p => /system-prompt\.md|settings\.json/.test(p)), []);
    assert.equal(spec.endSession, undefined);
    assert.equal(spec.awaitState, undefined);
  }
});

test('interactive: throws when engine has not minted a session id', () => {
  assert.throws(() => claudeAdapter.interactive({ ...planStep, id: 'other' }, ctx), /session/);
});

test('headless writes:true pre-approves write tools', () => {
  const step: AgentStep = { kind: 'agent', id: 'exec', runner: 'claude', mode: 'headless', writes: true, prompt: 'Do.', output: 'r.md' };
  const spec = claudeAdapter.headless(step, ctx);
  assert.deepEqual(spec.argv, [
    'claude', '-p', '--output-format', 'stream-json', '--verbose',
    '--allowedTools=Bash,Write,Edit,NotebookEdit',
  ]);
  assert.equal(spec.interactive, false);
  assert.equal(spec.stdinFile, promptPath(ctx.runDir, 'exec'));
  assert.equal(fileOf(spec, promptPath(ctx.runDir, 'exec')), 'Do.');
});

test('headless writes:false allows read-only set and denies write tools', () => {
  const step: AgentStep = { kind: 'agent',
    id: 'review', runner: 'claude', model: 'haiku', mode: 'headless',
    writes: false, effort: 'high', prompt: 'Review.', output: 'f.md',
  };
  const spec = claudeAdapter.headless(step, ctx);
  assert.deepEqual(spec.argv, [
    'claude', '-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--effort', 'high',
    '--allowedTools=Read,Grep,Glob,Bash', `--disallowedTools=${CLAUDE_WRITE_TOOLS}`,
  ]);
  assert.equal(spec.stdinFile, promptPath(ctx.runDir, 'review'));
  assert.equal(fileOf(spec, promptPath(ctx.runDir, 'review')), 'Review.');
});

test('harvest resumes the minted session and only allows Write', () => {
  const spec = claudeAdapter.harvest(planStep, ctx);
  assert.equal(spec.argv[0], 'claude');
  assert.deepEqual(spec.argv.slice(1, 4), ['-p', '--resume', '11111111-1111-4111-8111-111111111111']);
  assert.ok(spec.argv.includes('--allowedTools=Write'));
  // The prompt is a file on stdin, workspace-relative inside; argv carries none of it.
  assert.deepEqual(spec.argv, [
    'claude', '-p', '--resume', '11111111-1111-4111-8111-111111111111', '--model', 'opus', '--allowedTools=Write',
  ], 'no positional prompt');
  const file = harvestPromptPath(ctx.runDir, 'plan');
  assert.equal(spec.stdinFile, file);
  const prompt = fileOf(spec, file);
  assert.ok(prompt.includes(' .whiphand/runs/r1/plan.md.'), prompt);
  assert.ok(!prompt.includes(`${FWD}/.whiphand`), 'not the absolute path');
  assert.ok(prompt.includes("'plan.md'"));
  assert.equal(prompt, harvestPrompt(planStep, ctx));
});

test('headless asks for stream-json so a running step can report progress', () => {
  const step: AgentStep = { ...planStep, mode: 'headless' };
  const spec = claudeAdapter.headless(step, ctx);
  assert.equal(spec.argv[spec.argv.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(spec.argv.includes('--verbose'), 'stream-json only streams with --verbose');
  assert.deepEqual(spec.progress, { format: 'claude-stream-json' });
});

test('interactive and harvest ask for no progress: nobody is watching a feed', () => {
  assert.equal(claudeAdapter.interactive(planStep, ctx).progress, undefined);
  assert.equal(claudeAdapter.harvest(planStep, ctx).progress, undefined);
});

test('interactive resumes the recorded session for a step being retried', () => {
  // --session-id mints; continuing an existing conversation needs --resume,
  // exactly as harvest() already does.
  const fresh = claudeAdapter.interactive(planStep, ctx).argv;
  assert.ok(fresh.includes('--session-id'));
  assert.equal(fresh.includes('--resume'), false);

  const resumed = claudeAdapter
    .interactive(planStep, { ...ctx, resumedStepIds: new Set(['plan']) }).argv;
  assert.ok(resumed.includes('--resume'));
  assert.equal(resumed.includes('--session-id'), false);
  assert.equal(resumed[resumed.indexOf('--resume') + 1], ctx.sessionIds['plan']);
});

test('interactive mints as usual for a step that is not being retried', () => {
  const argv = claudeAdapter
    .interactive(planStep, { ...ctx, resumedStepIds: new Set(['other']) }).argv;

  assert.ok(argv.includes('--session-id'));
  assert.equal(argv.includes('--resume'), false);
});

// ---------------------------------------------------------------------------
// Prompt off argv (spec §3): headless/harvest/suggestName read stdin
// ---------------------------------------------------------------------------

const headlessStep: AgentStep = { kind: 'agent',
  id: 'exec', runner: 'claude', mode: 'headless', writes: true, prompt: 'Do the thing.', output: 'r.md',
};
const execCtx: RunCtx = { ...ctx, sessionIds: { ...ctx.sessionIds, exec: '22222222-2222-4222-8222-222222222222' } };

test('headless: stdinFile is the .prompt file, the prompt is in files and not in argv', () => {
  const spec = claudeAdapter.headless(headlessStep, execCtx);
  const file = join(execCtx.runDir, '.exec.prompt');
  assert.equal(spec.stdinFile, file);
  assert.equal(spec.stdinFile, promptPath(execCtx.runDir, 'exec'));
  assert.deepEqual(spec.files, [{ path: file, content: buildPrompt(headlessStep, execCtx) }]);
  assert.ok(spec.files?.some(f => f.path === spec.stdinFile), 'stdinFile is also written by core');
  assert.ok(!spec.argv.some(a => a.includes('Do the thing.')));
});

test('headless: the prompt file is LF, whatever line endings the workflow carried', () => {
  const crlf: AgentStep = { ...headlessStep, prompt: 'one\r\ntwo\rthree\nfour' };
  const content = fileOf(claudeAdapter.headless(crlf, execCtx), promptPath(execCtx.runDir, 'exec'));
  assert.ok(content.startsWith('one\ntwo\nthree\nfour'), JSON.stringify(content));
  assert.ok(!content.includes('\r'));
});

test('an adversarial prompt is written to the file and never appears in argv', () => {
  // %COMSPEC% would be expanded by cmd.exe, the quotes and & would end a
  // quoted argument, and 20000 characters overflow cmd.exe's 8191 cap — none of
  // which can matter once the prompt is not an argv element at all.
  const adversarial =
    `%COMSPEC% "double" 'single' \`tick\` $(id) & | > ^ ! \\ \n\nsecond line\n${'x'.repeat(20000)}`;
  const injected: AgentStep = { ...headlessStep, prompt: adversarial };
  const interactive: AgentStep = { ...planStep, prompt: adversarial };
  const specs: Array<[string, SpawnSpec, string]> = [
    ['headless', claudeAdapter.headless(injected, execCtx), promptPath(execCtx.runDir, 'exec')],
    ['interactive', claudeAdapter.interactive(interactive, ctx), promptPath(ctx.runDir, 'plan')],
  ];
  for (const [label, spec, file] of specs) {
    assert.ok(fileOf(spec, file).includes(adversarial), `${label}: the file carries the prompt verbatim`);
    for (const a of spec.argv) {
      assert.ok(a.length < 300, `${label}: an argv element is ${a.length} chars long`);
      for (const bad of ['%COMSPEC%', '"double"', 'second line', 'xxxxxxxxxx', '$(id)']) {
        assert.ok(!a.includes(bad), `${label}: argv carries ${bad}`);
      }
    }
    assert.ok(spec.argv.join(' ').length < 1000, `${label}: whole argv stays short`);
  }
});

test('harvest: carries its prompt as a file and stdinFile', () => {
  const spec = claudeAdapter.harvest(planStep, ctx);
  const file = join(ctx.runDir, '.plan.harvest-prompt');
  assert.deepEqual(spec.files, [{ path: file, content: harvestPrompt(planStep, ctx) }]);
  assert.equal(spec.stdinFile, file);
});

test('suggestName: carries its prompt as a file and stdinFile, and none of it on argv', () => {
  const capture = join(ctx.runDir, '.name.out');
  const spec = claudeAdapter.suggestName!('Name this run: "fix %PATH% & more"\r\nplease', ctx, capture);
  const file = join(ctx.runDir, SUGGEST_PROMPT_NAME);
  assert.equal(SUGGEST_PROMPT_NAME, '.name.suggest-prompt');
  assert.deepEqual(spec.argv, ['claude', '-p', '--model', 'haiku', '--allowedTools=']);
  assert.equal(spec.stdinFile, file);
  assert.deepEqual(spec.files, [{ path: file, content: 'Name this run: "fix %PATH% & more"\nplease' }]);
  assert.deepEqual(spec.capture, { path: capture, streams: 'stdout' });
});
