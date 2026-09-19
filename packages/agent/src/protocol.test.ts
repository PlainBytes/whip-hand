import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  requestSchema, responseSchema, notificationSchema, methods, notifications, ErrorCode,
  readArtifactResult, writeArtifactParams, whiphandEventNotificationParams, manualRequestParams,
  runStateChangedParams, jobSummarySchema,
} from './protocol.ts';

test('requestSchema: round-trips a well-formed request', () => {
  const req = { id: 1, method: 'hello', params: {} };
  const parsed = requestSchema.parse(req);
  assert.deepEqual(parsed, req);
});

test('requestSchema: params is optional', () => {
  const parsed = requestSchema.parse({ id: 2, method: 'hello' });
  assert.equal(parsed.params, undefined);
});

test('responseSchema: round-trips a success response', () => {
  const res = { id: 1, result: { version: '0.1.0', protocolVersion: 1 } };
  assert.deepEqual(responseSchema.parse(res), res);
});

test('responseSchema: round-trips an error response with null id', () => {
  const res = { id: null, error: { code: ErrorCode.ParseError, message: 'parse error' } };
  assert.deepEqual(responseSchema.parse(res), res);
});

test('notificationSchema: round-trips a notification (no id)', () => {
  const note = { method: 'stepLog', params: { jobId: 'j1', stream: 'stdout', line: 'hi' } };
  assert.deepEqual(notificationSchema.parse(note), note);
});

test('ErrorCode: matches the JSON-RPC-ish codes from the spec', () => {
  assert.equal(ErrorCode.ParseError, -32700);
  assert.equal(ErrorCode.MethodNotFound, -32601);
  assert.equal(ErrorCode.InvalidParams, -32602);
  assert.equal(ErrorCode.ServerError, -32000);
});

test('methods: hello params/result round-trip', () => {
  assert.deepEqual(methods.hello.params.parse({}), {});
  assert.deepEqual(methods.hello.result.parse({ version: '0.1.0', protocolVersion: 1 }), {
    version: '0.1.0', protocolVersion: 1,
  });
});

test('methods: listWorkflows accepts a workflow with a parse error entry', () => {
  const result = [
    {
      name: 'good', path: '/x/good.yaml', source: 'project',
      workflow: {
        name: 'good', steps: [
          { id: 'a', kind: 'agent', runner: 'claude', mode: 'headless', writes: false, prompt: 'p', output: 'a.md' },
        ],
      },
    },
    { name: 'bad', path: '/x/bad.yaml', source: 'global', error: 'YAML parse error: boom' },
  ];
  assert.deepEqual(methods.listWorkflows.result.parse(result), result);
});

test('methods: listWorkflows entries can carry the shadowed flag', () => {
  const result = [
    { name: 'feature', path: '/w/.whiphand/workflows/feature.yaml', source: 'project' },
    { name: 'feature', path: '/global/workflows/feature.yaml', source: 'global', shadowed: true },
  ];
  assert.deepEqual(methods.listWorkflows.result.parse(result), result);
});

test('methods: getWorkflow params accept an optional scope', () => {
  assert.equal(methods.getWorkflow.params.safeParse({ workdir: '/w', name: 'r' }).success, true);
  assert.equal(methods.getWorkflow.params.safeParse({ workdir: '/w', name: 'r', scope: 'global' }).success, true);
  assert.equal(methods.getWorkflow.params.safeParse({ workdir: '/w', name: 'r', scope: 'nope' }).success, false);
});

test('methods: deleteWorkflow params take a workflow name and scope, never a path', () => {
  assert.equal(methods.deleteWorkflow.params.safeParse({ workdir: '/w', name: 'r' }).success, true);
  assert.equal(methods.deleteWorkflow.params.safeParse({ workdir: '/w', name: 'r', scope: 'global' }).success, true);
  assert.equal(methods.deleteWorkflow.params.safeParse({ workdir: '/w', name: '../x' }).success, false);
  assert.equal(methods.deleteWorkflow.params.safeParse({ workdir: '/w', name: '/etc/passwd' }).success, false);
  assert.equal(methods.deleteWorkflow.params.safeParse({ workdir: '/w', name: 'Bad Name!' }).success, false);
  assert.deepEqual(methods.deleteWorkflow.result.parse({ deleted: false }), { deleted: false });
});

test('methods: cloneWorkflow params take a workflow name and newName, never a path', () => {
  assert.equal(methods.cloneWorkflow.params.safeParse({ workdir: '/w', name: 'r', newName: 'r-copy' }).success, true);
  assert.equal(
    methods.cloneWorkflow.params.safeParse({ workdir: '/w', name: 'r', newName: 'r-copy', scope: 'global' }).success,
    true,
  );
  assert.equal(methods.cloneWorkflow.params.safeParse({ workdir: '/w', name: '../x', newName: 'r-copy' }).success, false);
  assert.equal(methods.cloneWorkflow.params.safeParse({ workdir: '/w', name: 'r', newName: '/etc/passwd' }).success, false);
  assert.equal(methods.cloneWorkflow.params.safeParse({ workdir: '/w', name: 'r', newName: 'Bad Name!' }).success, false);
  assert.deepEqual(
    methods.cloneWorkflow.result.parse({ path: '/w/.whiphand/workflows/r-copy.yaml' }),
    { path: '/w/.whiphand/workflows/r-copy.yaml' },
  );
});

test('methods: getWorkflow result requires a full workflow', () => {
  const workflow = {
    name: 'r', steps: [
      { id: 'a', kind: 'agent', runner: 'claude', mode: 'headless', writes: false, prompt: 'p', output: 'a.md' },
    ],
  };
  assert.deepEqual(methods.getWorkflow.result.parse(workflow), workflow);
});

test('methods: getWorkflow carries a loop body and its non-agent steps over the wire', () => {
  const workflow = {
    name: 'r',
    steps: [{
      id: 'fix', kind: 'loop', until: 'review', max_iterations: 2,
      steps: [
        { id: 'tests', kind: 'command', run: 'npm test', verdict: true, output: 'tests.log' },
        { id: 'review', kind: 'agent', runner: 'claude', mode: 'headless', writes: false, verdict: true, prompt: 'p', output: 'r.md' },
      ],
    }],
  };
  assert.deepEqual(methods.getWorkflow.result.parse(workflow), workflow);
});

test('methods: a step with no kind arrives as an agent step', () => {
  const parsed = methods.getWorkflow.result.parse({
    name: 'r', steps: [{ id: 'a', runner: 'claude', mode: 'headless', writes: false, prompt: 'p', output: 'a.md' }],
  });
  assert.equal(parsed.steps[0].kind, 'agent');
});

test('methods: doctor result shape', () => {
  const result = [
    {
      id: 'claude', label: 'Claude Code', group: 'harness', runner: true,
      optional: false, installed: true, version: '1.2.3', url: 'https://claude.com/claude-code',
    },
    { id: 'jq', label: 'jq', group: 'support', runner: false, optional: true, installed: false },
  ];
  assert.deepEqual(methods.doctor.result.parse(result), result);
});

test('methods: doctor rejects a row missing the fields the UI branches on', () => {
  // `runner` in particular: the desktop's runner dropdown filters on it, so a
  // row arriving without it would make every support tool selectable.
  const complete = {
    id: 'git', label: 'Git', group: 'support', runner: false, optional: false, installed: true,
  };
  assert.equal(methods.doctor.result.safeParse([complete]).success, true);
  for (const field of ['id', 'label', 'group', 'runner', 'optional', 'installed']) {
    const { [field]: _dropped, ...partial } = complete as Record<string, unknown>;
    assert.equal(
      methods.doctor.result.safeParse([partial]).success, false,
      `a doctor row without '${field}' must not parse`);
  }
});

test('methods: doctor rejects a group outside the two we render', () => {
  assert.equal(methods.doctor.result.safeParse([{
    id: 'x', label: 'x', group: 'gadgets', runner: false, optional: true, installed: false,
  }]).success, false);
});

test('methods: listModels params default to no refresh', () => {
  assert.deepEqual(methods.listModels.params.parse(undefined), {});
  assert.deepEqual(methods.listModels.params.parse({ refresh: true }), { refresh: true });
});

test('methods: listModels result is keyed by runner id, one ModelList per adapter that offers one', () => {
  const result = {
    claude: {
      source: 'live',
      models: [{ id: 'sonnet', label: 'Sonnet', resolves: 'claude-sonnet-5' }, { id: 'opus' }],
    },
    copilot: { source: 'unavailable', models: [] },
  };
  assert.deepEqual(methods.listModels.result.parse(result), result);
});

test('methods: listModels rejects a source outside the three the editor knows', () => {
  assert.equal(
    methods.listModels.result.safeParse({ claude: { source: 'cached', models: [] } }).success, false,
  );
});

test('methods: configGet params allow omitting workdir (PreferencesPage, no workspace open)', () => {
  assert.equal(methods.configGet.params.safeParse({}).success, true);
  assert.equal(methods.configGet.params.safeParse({ workdir: '/w' }).success, true);
});

test('methods: configGet result carries the merged config plus both raw layers', () => {
  const result = {
    config: {
      defaults: { runner: 'claude' }, on_findings: 'report', loop: { max_iterations: 3 },
      artifacts_dir: '.whiphand/runs', runs: { max_retained: null, auto_name: false, max_attachment_mb: 25 },
    },
    global: { config: {}, path: '/home/u/.config/whiphand/config.yaml', exists: false },
    project: { config: {}, path: '/w/.whiphand/config.yaml', exists: false },
  };
  assert.deepEqual(methods.configGet.result.parse(result), result);
});

test('methods: configGet result omits project when read with no workdir', () => {
  const result = {
    config: {
      defaults: { runner: 'claude' }, on_findings: 'report', loop: { max_iterations: 3 },
      artifacts_dir: '.whiphand/runs', runs: { max_retained: null, auto_name: false, max_attachment_mb: 25 },
    },
    global: { config: {}, path: '/home/u/.config/whiphand/config.yaml', exists: false },
  };
  assert.deepEqual(methods.configGet.result.parse(result), result);
});

test('methods: configSet params requires a full (non-partial) config, and takes an optional scope', () => {
  const bad = { workdir: '/w', config: { defaults: { runner: 'claude' } } };
  assert.equal(methods.configSet.params.safeParse(bad).success, false);
  const good = {
    workdir: '/w',
    config: {
      defaults: { runner: 'claude' }, on_findings: 'report', loop: { max_iterations: 3 },
      artifacts_dir: '.whiphand/runs', runs: { max_retained: null, auto_name: false, max_attachment_mb: 25 },
    },
  };
  assert.equal(methods.configSet.params.safeParse(good).success, true);
  assert.equal(methods.configSet.params.safeParse({ ...good, scope: 'global', workdir: undefined }).success, true);
});

test('methods: configSet explicitKeys accepts only real dotted config keys', () => {
  const good = {
    workdir: '/w',
    config: {
      defaults: { runner: 'claude' }, on_findings: 'report', loop: { max_iterations: 3 },
      artifacts_dir: '.whiphand/runs', runs: { max_retained: null, auto_name: false, max_attachment_mb: 25 },
    },
  };
  assert.equal(methods.configSet.params.safeParse({ ...good, explicitKeys: [] }).success, true);
  assert.equal(
    methods.configSet.params.safeParse({ ...good, explicitKeys: ['runs.max_retained', 'on_findings'] }).success,
    true,
  );
  assert.equal(methods.configSet.params.safeParse({ ...good, explicitKeys: ['runs.nope'] }).success, false);
});

test('methods: getWorkflow rejects a name that could escape its scope directory', () => {
  // `name` is joined into a scope dir on the other side of this boundary, and
  // the webview it arrives from is not trusted.
  for (const name of ['../escape', 'sub/nested', '.', 'global:feature', 'Feature']) {
    assert.equal(
      methods.getWorkflow.params.safeParse({ workdir: '/w', name }).success, false,
      `expected getWorkflow to reject name ${JSON.stringify(name)}`,
    );
  }
  assert.equal(methods.getWorkflow.params.safeParse({ workdir: '/w', name: 'feature-2' }).success, true);
});

test('methods: startRun params allows omitting inputs/dryRun', () => {
  const parsed = methods.startRun.params.parse({ workdir: '/w', workflow: 'r' });
  assert.deepEqual(parsed, { workdir: '/w', workflow: 'r' });
});

test('methods: cancelRun params accepts either jobId or workdir+runId', () => {
  assert.equal(methods.cancelRun.params.safeParse({ jobId: 'j1' }).success, true);
  assert.equal(methods.cancelRun.params.safeParse({ workdir: '/w', runId: 'run-1' }).success, true);
  assert.equal(methods.cancelRun.params.safeParse({}).success, false);
});

test('methods: endSession needs a jobId', () => {
  assert.equal(methods.endSession.params.safeParse({ jobId: 'j1' }).success, true);
  assert.equal(methods.endSession.params.safeParse({}).success, false);
  assert.equal(methods.endSession.params.safeParse({ jobId: '' }).success, false);
});

test('methods: getRun result is nullable', () => {
  assert.equal(methods.getRun.result.parse(null), null);
});

test('methods: readArtifact params/result round-trip (name, not a path)', () => {
  const params = { workdir: '/w', runId: 'run-1', name: 'review.md' };
  assert.deepEqual(methods.readArtifact.params.parse(params), params);
  const result = { content: 'hi', size: 2, mtimeMs: 1725000000000 };
  assert.deepEqual(methods.readArtifact.result.parse(result), result);
});

test('methods: ptyInput params round-trip (data is base64)', () => {
  const params = { jobId: 'j1', data: 'aGVsbG8=' };
  assert.deepEqual(methods.ptyInput.params.parse(params), params);
  assert.deepEqual(methods.ptyInput.result.parse({ ok: true }), { ok: true });
});

test('methods: ptyResize params round-trip and reject non-positive cols/rows', () => {
  const params = { jobId: 'j1', cols: 120, rows: 40 };
  assert.deepEqual(methods.ptyResize.params.parse(params), params);
  assert.throws(() => methods.ptyResize.params.parse({ ...params, cols: 0 }));
});

test('notifications: whiphandEvent round-trips a run:start event', () => {
  const params = {
    jobId: 'j1', runId: 'run-1',
    event: { type: 'run:start', runId: 'run-1', workflow: 'r' },
    ts: '2026-01-01T00:00:00.000Z',
  };
  assert.deepEqual(notifications.whiphandEvent.parse(params), params);
});

test('notifications: runStateChanged round-trips', () => {
  const params = { jobId: 'j1', runId: 'run-1', status: 'running' };
  assert.deepEqual(notifications.runStateChanged.parse(params), params);
});

test('notifications: pty* shapes round-trip', () => {
  assert.deepEqual(
    notifications.ptyStarted.parse({ jobId: 'j1', stepId: 's1', cols: 80, rows: 24 }),
    { jobId: 'j1', stepId: 's1', cols: 80, rows: 24 },
  );
  assert.deepEqual(notifications.ptyData.parse({ jobId: 'j1', data: 'aGVsbG8=' }), { jobId: 'j1', data: 'aGVsbG8=' });
  assert.deepEqual(notifications.ptyExit.parse({ jobId: 'j1', exitCode: 0 }), { jobId: 'j1', exitCode: 0 });
  assert.deepEqual(
    notifications.ptyExit.parse({ jobId: 'j1', exitCode: 0, reason: 'ended' }),
    { jobId: 'j1', exitCode: 0, reason: 'ended' },
  );
});

test('whiphandEvent: a step:spawn spec round-trips with and without its optional session fields', () => {
  const base = { argv: ['claude'], cwd: '/w', env: {}, interactive: true };
  for (const spec of [
    base,
    { ...base, endSession: { markerPath: '/w/.whiphand/.plan.done', quitSequence: '/exit\r' } },
    { ...base, awaitState: { statePath: '/w/.whiphand/.plan.await' } },
  ]) {
    const event = { type: 'step:spawn', stepId: 'plan', spec, phase: 'main' };
    const parsed = notifications.whiphandEvent.parse({ jobId: 'j1', event, ts: '2026-01-01T00:00:00.000Z' });
    assert.deepEqual((parsed as { event: unknown }).event, event);
  }
});

test('whiphandEvent: a step:spawn spec carries its progress format over the wire', () => {
  const spec = {
    argv: ['claude'], cwd: '/w', env: {}, interactive: false,
    progress: { format: 'claude-stream-json' },
  };
  const event = { type: 'step:spawn', stepId: 'impl', spec, phase: 'main' };
  const parsed = notifications.whiphandEvent.parse({ jobId: 'j1', event, ts: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual((parsed as { event: unknown }).event, event);
});

test('whiphandEvent: every step:progress variant round-trips', () => {
  for (const progress of [
    { kind: 'text', text: 'looking at the runner' },
    { kind: 'tool', tool: 'Read' },
    { kind: 'tool', tool: 'Read', target: 'runner.ts' },
    { kind: 'usage', turns: 3, costUsd: 0.04 },
    { kind: 'usage', turns: 2, premiumRequests: 0.33 },
  ]) {
    const event = { type: 'step:progress', stepId: 'impl', progress };
    const parsed = notifications.whiphandEvent.parse({ jobId: 'j1', event, ts: '2026-01-01T00:00:00.000Z' });
    assert.deepEqual((parsed as { event: unknown }).event, event);
  }
});

test('whiphandEvent: rejects a step:progress with an unknown kind', () => {
  const event = { type: 'step:progress', stepId: 'impl', progress: { kind: 'vibes' } };
  const result = notifications.whiphandEvent.safeParse({ jobId: 'j1', event, ts: '2026-01-01T00:00:00.000Z' });
  assert.equal(result.success, false);
});

test('notifications: ptyAwait round-trips a blocked session and a working one', () => {
  const blocked = { jobId: 'j1', stepId: 'plan', awaiting: true, reason: 'permission' };
  assert.deepEqual(notifications.ptyAwait.parse(blocked), blocked);
  const working = { jobId: 'j1', stepId: 'plan', awaiting: false };
  assert.deepEqual(notifications.ptyAwait.parse(working), working);
  assert.equal(notifications.ptyAwait.safeParse({ ...blocked, reason: 'nonsense' }).success, false);
});

test('notifications: stepLog round-trips', () => {
  const params = { jobId: 'j1', stream: 'stderr', line: 'oops' };
  assert.deepEqual(notifications.stepLog.parse(params), params);
});

test('readArtifactResult carries the stat fields the editor needs', () => {
  const parsed = readArtifactResult.parse({ content: 'hi', size: 2, mtimeMs: 1725000000000 });
  assert.deepEqual(parsed, { content: 'hi', size: 2, mtimeMs: 1725000000000 });
  assert.throws(() => readArtifactResult.parse({ content: 'hi' }));
});

test('writeArtifactParams accepts a name-addressed write, with expectedMtimeMs optional', () => {
  const base = { workdir: '/ws', runId: 'run-1', name: 'review.md', content: '# hi' };
  assert.deepEqual(writeArtifactParams.parse(base), { ...base });
  assert.equal(writeArtifactParams.parse({ ...base, expectedMtimeMs: 5 }).expectedMtimeMs, 5);
  // Empty content is a legitimate write; an empty name is not.
  assert.equal(writeArtifactParams.parse({ ...base, content: '' }).content, '');
  assert.throws(() => writeArtifactParams.parse({ ...base, name: '' }));
});

test('writeArtifact is registered in the methods map', () => {
  assert.ok('writeArtifact' in methods);
});

test('methods: startRun attachments are a strict union of a path or named base64 bytes', () => {
  const parse = (attachments: unknown) =>
    methods.startRun.params.safeParse({ workdir: '/w', workflow: 'r', attachments }).success;
  assert.equal(parse([{ path: '/a.png' }, { name: 'p.png', base64: 'AA==' }]), true);
  assert.equal(parse([{ path: '/a.png', base64: 'AA==' }]), false, 'both at once is refused');
  assert.equal(parse([{ name: 'p.png' }]), false);
  assert.equal(parse([{ path: '' }]), false);
});

test('methods: readArtifact takes an optional encoding; statArtifact takes a name', () => {
  assert.equal(methods.readArtifact.params.safeParse({ workdir: '/w', runId: 'r', name: 'a' }).success, true);
  assert.equal(methods.readArtifact.params.safeParse({ workdir: '/w', runId: 'r', name: 'a', encoding: 'base64' }).success, true);
  assert.equal(methods.readArtifact.params.safeParse({ workdir: '/w', runId: 'r', name: 'a', encoding: 'hex' }).success, false);
  assert.equal(methods.statArtifact.params.safeParse({ workdir: '/w', runId: 'r', name: 'a' }).success, true);
});

test('a stage\'s attempt budget survives the wire on stages:item and on a manual request', () => {
  const event = whiphandEventNotificationParams.parse({
    jobId: 'j', ts: 't', event: {
      type: 'stages:item', id: 'build', index: 2, total: 7, stageId: '02-b', title: 'API', attempt: 2, maxAttempts: 3,
    },
  });
  assert.equal((event.event as { maxAttempts?: number }).maxAttempts, 3);

  const request = manualRequestParams.parse({
    jobId: 'j',
    request: {
      stepId: 'accept', kind: 'approval', title: 'Accept?', instructions: '', choices: ['continue'],
      context: { artifacts: [] }, defaultChoice: 'continue',
      stage: { stagesId: 'build', id: '02-b', title: 'API', index: 2, total: 7, attempt: 2, maxAttempts: 3 },
    },
  });
  assert.equal(request.request.stage?.maxAttempts, 3);
});

test('the workspace identity key rides on job notifications and summaries, and is optional on all of them', () => {
  const event = { type: 'run:start', runId: 'r', workflow: 'w' };
  const tagged = whiphandEventNotificationParams.parse({ jobId: 'j', workdir: '/link', identityKey: '/real', event, ts: 't' });
  assert.equal(tagged.identityKey, '/real');
  assert.equal(whiphandEventNotificationParams.parse({ jobId: 'j', event, ts: 't' }).identityKey, undefined);

  assert.equal(runStateChangedParams.parse({ jobId: 'j', identityKey: '/real', status: 'running' }).identityKey, '/real');
  assert.equal(runStateChangedParams.parse({ jobId: 'j', status: 'running' }).identityKey, undefined);

  const summary = { jobId: 'j', workdir: '/link', status: 'running', pty: null };
  assert.equal(jobSummarySchema.parse({ ...summary, identityKey: '/real' }).identityKey, '/real');
  assert.equal(jobSummarySchema.parse(summary).identityKey, undefined);
});

test('a recent workspace entry round-trips its identity key, and one without still parses', () => {
  const parsed = methods.touchRecentWorkspace.result.parse({
    recentWorkspaces: [{ path: '/link', lastOpenedAt: 't', identityKey: '/real' }, { path: '/old', lastOpenedAt: 't' }],
  });
  assert.deepEqual(parsed.recentWorkspaces.map(r => r.identityKey), ['/real', undefined]);
});
