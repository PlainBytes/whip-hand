import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeAdapter, CLAUDE_WRITE_TOOLS, CLAUDE_QUIT_SEQUENCE } from './claude.ts';
import { interactiveGuidance } from '../engine/interactive-guidance.ts';
import { endMarkerPath, shellPath } from '../engine/session-end.ts';
import { awaitStatePath } from '../engine/await-state.ts';
import type { AgentStep, RunCtx } from '../types.ts';

const ctx: RunCtx = {
  workdir: '/w', runId: 'r1', runDir: '/w/.whiphand/runs/r1', runSlug: 'r1',
  sessionIds: { plan: '11111111-1111-4111-8111-111111111111' },
  artifacts: {}, attempts: {}, inputs: {},
};

const planStep: AgentStep = { kind: 'agent',
  id: 'plan', runner: 'claude', model: 'opus', mode: 'interactive',
  writes: false, prompt: 'Plan it.', output: 'plan.md',
};

/** Hand-written on purpose: building it from the adapter's own helper would let it drift silently. */
const EXPECTED_SETTINGS = {
  permissions: { allow: ['Bash(touch /w/.whiphand/runs/r1/.plan.done)'] },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: `printf '{"r":"turn"}' > /w/.whiphand/runs/r1/.plan.await 2>/dev/null; exit 0` }] }],
    PermissionRequest: [{ hooks: [{ type: 'command', command: `printf '{"r":"permission"}' > /w/.whiphand/runs/r1/.plan.await 2>/dev/null; exit 0` }] }],
    Notification: [{ hooks: [{ type: 'command', command: 'cat > /w/.whiphand/runs/r1/.plan.await 2>/dev/null; exit 0' }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'rm -f /w/.whiphand/runs/r1/.plan.await >/dev/null 2>&1; exit 0' }] }],
  },
};

function settingsOf(spec: { argv: string[] }): typeof EXPECTED_SETTINGS {
  return JSON.parse(spec.argv[spec.argv.indexOf('--settings') + 1]);
}

/**
 * These seven pin the exact contents of the --settings object against
 * hand-written POSIX paths. The object is emitted on every platform, but on
 * Windows it carries Windows paths, so there is nothing here for them to match
 * — that case is covered by "a Windows run dir still gets settings" below.
 */
const posixSettings = {
  skip: process.platform === 'win32' && 'these pin POSIX paths; on Windows the object carries Windows ones',
};

test('interactive: pins session, denies write tools, appends guidance, seeds prompt last', posixSettings, () => {
  const spec = claudeAdapter.interactive(planStep, ctx);
  assert.deepEqual(spec.argv, [
    'claude', '--session-id', '11111111-1111-4111-8111-111111111111',
    '--model', 'opus', `--disallowedTools=${CLAUDE_WRITE_TOOLS}`,
    '--append-system-prompt', interactiveGuidance(planStep, ctx),
    '--settings', JSON.stringify(EXPECTED_SETTINGS),
    'Plan it.',
  ]);
  assert.equal(spec.cwd, '/w');
  assert.equal(spec.interactive, true);
});

test('interactive: one --settings object carries both the permission rule and the hooks', posixSettings, () => {
  const spec = claudeAdapter.interactive(planStep, ctx);
  assert.equal(spec.argv.filter(a => a === '--settings').length, 1, 'claude takes exactly one');
  assert.deepEqual(settingsOf(spec), EXPECTED_SETTINGS);
});

test('interactive: every hook command exits 0', posixSettings, () => {
  // Load-bearing. A Stop hook exiting nonzero blocks the agent from stopping,
  // and a PermissionRequest hook exiting 2 denies the tool outright.
  const entries = Object.values(settingsOf(claudeAdapter.interactive(planStep, ctx)).hooks);
  assert.equal(entries.length, 4);
  for (const entry of entries) {
    for (const h of entry[0].hooks) assert.ok(h.command.endsWith('; exit 0'), h.command);
  }
});

test('interactive: hooks touch the await path and nothing else', posixSettings, () => {
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

test('interactive: UserPromptSubmit clears the state rather than writing one', posixSettings, () => {
  const { hooks } = settingsOf(claudeAdapter.interactive(planStep, ctx));
  assert.match(hooks.UserPromptSubmit[0].hooks[0].command, /^rm -f /);
});

test('interactive: Notification dumps its raw payload instead of trusting a matcher', posixSettings, () => {
  // The agent maps notification_type itself; matcher filtering is unverified.
  const { hooks } = settingsOf(claudeAdapter.interactive(planStep, ctx));
  assert.match(hooks.Notification[0].hooks[0].command, /^cat > /);
  for (const entry of Object.values(hooks)) {
    assert.ok(!('matcher' in entry[0]), 'no entry depends on matcher semantics');
  }
});

test('interactive: carries the await-state spec the frontend watches', posixSettings, () => {
  const spec = claudeAdapter.interactive(planStep, ctx);
  assert.deepEqual(spec.awaitState, { statePath: awaitStatePath(ctx.runDir, 'plan') });
});

test('a Windows run dir still gets settings, with every path a shell can read', () => {
  // The whole object used to be dropped on Windows: SHELL_SAFE_PATH has no
  // backslash in it, so a native run-dir path failed the guard and an
  // interactive step reported no await state and got no end-session rule.
  // Forward slashes name the same file, and are what Git Bash — which is what
  // claude runs hook commands and Bash tool calls through on Windows — can
  // actually read.
  const winCtx: RunCtx = { ...ctx, workdir: 'D:\\w', runDir: 'D:\\w\\.whiphand\\runs\\r1' };
  const spec = claudeAdapter.interactive(planStep, winCtx);

  assert.ok(spec.argv.includes('--settings'), '--settings must be emitted on Windows');
  const settings = settingsOf(spec);
  assert.deepEqual(settings.permissions.allow, ['Bash(touch D:/w/.whiphand/runs/r1/.plan.done)']);
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
  for (const c of [ctx, { ...ctx, workdir: 'D:\\w', runDir: 'D:\\w\\.whiphand\\runs\\r1' }]) {
    const spec = claudeAdapter.interactive(planStep, c);
    const guidance = spec.argv[spec.argv.indexOf('--append-system-prompt') + 1];
    const quoted = guidance.match(/touch (\S+)/);
    assert.ok(quoted, 'guidance must name the touch command');
    assert.deepEqual(settingsOf(spec).permissions.allow, [`Bash(touch ${quoted[1]})`]);
  }
});

test('interactive: the system prompt names the marker the session ends with', () => {
  const spec = claudeAdapter.interactive(planStep, ctx);
  const guidance = spec.argv[spec.argv.indexOf('--append-system-prompt') + 1];
  assert.ok(guidance.includes(`touch ${shellPath(endMarkerPath(ctx.runDir, 'plan'))}`));
});

test('interactive: carries the end-session spec the frontend watches', () => {
  const spec = claudeAdapter.interactive(planStep, ctx);
  assert.deepEqual(spec.endSession, {
    markerPath: endMarkerPath(ctx.runDir, 'plan'),
    quitSequence: CLAUDE_QUIT_SEQUENCE,
  });
});

test('interactive: skips --settings entirely when the path would need quoting', () => {
  const spaced: RunCtx = { ...ctx, runDir: '/w/my runs/r1' };
  const spec = claudeAdapter.interactive(planStep, spaced);
  assert.ok(!spec.argv.includes('--settings'), 'a rule that can never match is worse than none');
  // The session can still end itself; the human just answers one permission prompt.
  assert.equal(spec.endSession?.markerPath, endMarkerPath(spaced.runDir, 'plan'));
  // No settings means no hooks, so there is nothing for a watcher to read.
  assert.equal(spec.awaitState, undefined);
});

test('headless and harvest carry no guidance: they have no human to collaborate with', () => {
  const step: AgentStep = { ...planStep, mode: 'headless' };
  for (const spec of [claudeAdapter.headless(step, ctx), claudeAdapter.harvest(planStep, ctx)]) {
    assert.ok(!spec.argv.includes('--append-system-prompt'));
    assert.ok(!spec.argv.includes('--settings'), 'no hooks: nobody is waiting on a human');
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
    '--allowedTools=Bash,Write,Edit,NotebookEdit', 'Do.',
  ]);
  assert.equal(spec.interactive, false);
});

test('headless writes:false allows read-only set and denies write tools', () => {
  const step: AgentStep = { kind: 'agent',
    id: 'review', runner: 'claude', model: 'haiku', mode: 'headless',
    writes: false, effort: 'high', prompt: 'Review.', output: 'f.md',
  };
  const spec = claudeAdapter.headless(step, ctx);
  assert.deepEqual(spec.argv, [
    'claude', '-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--effort', 'high',
    '--allowedTools=Read,Grep,Glob,Bash', `--disallowedTools=${CLAUDE_WRITE_TOOLS}`, 'Review.',
  ]);
});

test('harvest resumes the minted session and only allows Write', () => {
  const spec = claudeAdapter.harvest(planStep, ctx);
  assert.equal(spec.argv[0], 'claude');
  assert.deepEqual(spec.argv.slice(1, 4), ['-p', '--resume', '11111111-1111-4111-8111-111111111111']);
  assert.ok(spec.argv.includes('--allowedTools=Write'));
  const prompt = spec.argv[spec.argv.length - 1];
  assert.ok(prompt.includes('/w/.whiphand/runs/r1/plan.md'));
  assert.ok(prompt.includes("'plan.md'"));
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
