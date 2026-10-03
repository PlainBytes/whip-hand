/**
 * The adapter and doctor suites of the core parity corpus (Phase 2c of
 * docs/migration.md), generated like the rest of core-corpus.ts:
 *
 * - `adapters`: every adapter method over writes/read-only, model and effort,
 *   resumed and fresh sessions, missing session ids, input artifacts with
 *   verdicts and attachments, stage frames, and a run dir outside the
 *   workspace; plus buildPrompt, the guidance texts and the await-state file.
 * - `progress`: the recorded runner streams in parity/fixtures/progress, and
 *   hand-written edge lines, through each format's parser.
 * - `doctor`: auth notes over a fake home, version parsing, the merged tool
 *   table, doctor.yaml fixtures, the report's text, the workflow capability
 *   gates and the workspace-open checks.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Op = Record<string, unknown> & { op: string };
type Raw = Record<string, unknown>;

const PROGRESS = fileURLToPath(new URL('./fixtures/progress', import.meta.url));

const STAGE_FRAME = {
  id: 'build', kind: 'stages', attempt: 2, maxAttempts: 3,
  stage: { index: 2, total: 3, id: '02-api', title: 'API', path: '/ws/proj/plan/02-api.md' },
};
const LOOP_FRAME = { id: 'fix', iteration: 2, maxIterations: 3 };

function adapterOps(): Op[] {
  const ops: Op[] = [];
  const steps: Raw[] = [
    { id: 'plan', prompt: 'Plan {{ inputs.topic }} for run {{ run.id }}.\n\n', output: 'plan.md', writes: false },
    { id: 'build', prompt: 'Build it', output: 'build.md', writes: true, model: 'opus', effort: 'high', inputs: ['plan', 'attachments'] },
    { id: 'review', prompt: 'Review loop {{ loop.iteration }}/{{ loop.max_iterations }}', output: 'review.md', writes: false, model: '', inputs: ['build'] },
    { id: 'stage-x', prompt: 'Stage {{ stage.index }} of {{ stage.total }}: {{ stage.title }}', output: 'x.md', writes: true, effort: 'low' },
  ];
  const sessions = { plan: 'sid-plan', build: 'sid-build', review: 'sid-review', 'stage-x': 'sid-x' };
  const ctxs: Raw[] = [
    { inputs: { topic: 'auth' }, sessionIds: sessions, artifacts: { plan: 'plan.md', build: 'build/iter-1/build.md' },
      verdicts: { build: 'fail' }, attachments: ['attachments/spec v2.md'], frame: LOOP_FRAME },
    { inputs: { topic: 'auth' }, sessionIds: sessions, resumed: ['plan', 'build', 'stage-x'],
      artifacts: { plan: 'plan.md', build: 'build.md' }, verdicts: { plan: 'pass' }, runName: 'My Run', runSlug: 'my-run',
      frame: { ...STAGE_FRAME, parent: LOOP_FRAME } },
    { inputs: { topic: 'auth' }, sessionIds: sessions, artifacts: { plan: 'plan.md', build: 'build.md' }, runDirOutside: true,
      frame: STAGE_FRAME },
    { inputs: {} },
  ];
  for (const runner of ['claude', 'copilot', 'opencode']) {
    for (const method of ['interactive', 'headless', 'harvest']) {
      for (const step of steps) {
        for (const ctx of ctxs) ops.push({ op: 'adapterSpec', runner, method, step: { ...step, runner, mode: method === 'headless' ? 'headless' : 'interactive' }, ctx });
      }
    }
    ops.push({ op: 'adapterSpec', runner, method: 'suggestName', step: {}, ctx: ctxs[0], prompt: 'Name this run.\r\nIn five words.' });
  }
  for (const ctx of ctxs) {
    ops.push(
      { op: 'buildPrompt', prompt: '  Do {{ inputs.topic }}  \n\n', inputs: ['plan', 'build', 'attachments'], ctx },
      { op: 'buildPrompt', prompt: 'No inputs {{ run.slug }} {{ run.name }}', ctx },
      { op: 'buildPrompt', prompt: 'x', inputs: ['missing'], ctx },
      { op: 'buildPrompt', prompt: 'x {{ inputs.nope }}', ctx },
      { op: 'guidance', step: { id: 'chat', writes: false, output: 'chat.md' }, ctx },
      { op: 'guidance', step: { id: 'chat', writes: true, output: 'notes.md' }, ctx },
    );
  }
  for (const raw of ['', '  ', '{"r":"turn"}', '{"r":"permission"}\n', '{"r":"away"}', '{"r":"attention"}',
    '{"notification_type":"idle_prompt"}', '{"notification_type":"permission_prompt","message":"x"}',
    '{"notification_type":"worker_permission_prompt"}', '{"notification_type":"auth_success"}', '{"r":',
    'null', '[1]', '"turn"', '{"r":"nope","notification_type":"idle_prompt"}']) {
    ops.push({ op: 'parseAwaitState', raw });
  }
  return ops;
}

function fixtureLines(name: string): string[] {
  return readFileSync(path.join(PROGRESS, name), 'utf8').split('\n');
}

function progressOps(): Op[] {
  const edge = [
    '', '   ', 'not json', '[1,2]', 'null', '{"type":"assistant"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"  "},{"type":"text","text":" hi\\n there "}]}}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls   -la\\n | wc"}}]}}',
    `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"${'é'.repeat(130)}"}}]}}`,
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"","input":{}}]}}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Grep","input":{"pattern":"   ","query":"q"}}]}}',
    '{"type":"result","num_turns":3,"total_cost_usd":0.0358}', '{"type":"result","num_turns":"3"}', '{"type":"result"}',
    '{"type":"tool.execution_start","data":{"toolName":"view","arguments":{"path":"src/x.ts"}}}',
    '{"type":"assistant.message","data":{"content":""}}', '{"type":"assistant.message","data":{"content":"done."}}',
    '{"type":"assistant.turn_end","data":{"turnId":"0"}}', '{"type":"assistant.turn_end","data":{"turnId":"2"}}',
    '{"type":"assistant.turn_end","data":{"turnId":" 4 "}}', '{"type":"assistant.turn_end","data":{"turnId":"1.5"}}',
    '{"type":"assistant.turn_end","data":{"turnId":""}}', '{"type":"assistant.turn_end","data":{"turnId":null}}',
    '{"type":"assistant.turn_end","data":{"turnId":-1}}', '{"type":"assistant.turn_end","data":{}}',
    '{"type":"result","usage":{"premiumRequests":0.33}}', '{"type":"result","usage":5}',
    '{"type":"tool_use","part":{"tool":"edit","state":{"input":{"filePath":"a.ts"}}}}',
    '{"type":"text","part":{"text":"hello"}}', '{"type":"step_finish","part":{}}',
    '{"type":"step_finish","part":{"cost":0.01}}', '{"type":"step_finish","part":{"cost":0.02}}',
    '{"type":"error","error":{"name":"ProviderError","data":{"message":"  rate\\n limited  "}}}',
    '{"type":"error","error":{"message":"plain"}}', '{"type":"error","error":{"name":"OnlyName"}}',
    '{"type":"error","error":{"data":{"message":null},"message":"fallback"}}', '{"type":"error","error":{"data":{"message":" "}}}',
    '{"type":"error"}',
  ];
  const ops: Op[] = [];
  for (const format of ['claude-stream-json', 'copilot-jsonl', 'opencode-json']) ops.push({ op: 'progress', format, lines: edge });
  ops.push(
    { op: 'progress', format: 'claude-stream-json', lines: fixtureLines('claude-stream-json.ndjson') },
    { op: 'progress', format: 'copilot-jsonl', lines: fixtureLines('copilot-jsonl.ndjson') },
    { op: 'progress', format: 'opencode-json', lines: fixtureLines('opencode-json.ndjson') },
    { op: 'progress', format: 'opencode-json', lines: fixtureLines('opencode-error.ndjson') },
  );
  return ops;
}

const WORKFLOW = `name: caps
steps:
  - id: chat
    runner: claude
    mode: interactive
    writes: false
    prompt: talk
    output: chat.md
  - id: oc
    runner: opencode
    mode: interactive
    writes: true
    prompt: x
    output: oc.md
  - id: cmd
    kind: command
    run: echo hi
  - id: cmd2
    kind: command
    run: echo hi
    shell: /bin/bash
  - id: gate
    kind: approval
    title: Ship?
    instructions: Look.
  - id: ask
    kind: manual
    title: Do it
    instructions: By hand.
  - id: loop
    kind: loop
    until: check
    steps:
      - id: check
        kind: command
        run: test -f x
        verdict: true
`;

function doctorOps(): Op[] {
  const ops: Op[] = [];
  const auth = (runner: string, extra: Raw): Op => ({ op: 'authNote', runner, ...extra });
  ops.push(
    auth('claude', {}),
    auth('claude', { platform: 'darwin' }),
    auth('claude', { platform: 'win32' }),
    auth('claude', { env: { ANTHROPIC_API_KEY: 'x' } }),
    auth('claude', { env: { ANTHROPIC_API_KEY: '0' } }),
    auth('claude', { env: { CLAUDE_CODE_USE_BEDROCK: 'FALSE' } }),
    auth('claude', { env: { CLAUDE_CODE_USE_VERTEX: '1' } }),
    auth('claude', { files: { '.claude/.credentials.json': '{}' } }),
    auth('claude', { files: { '.claude/.credentials.json': { error: 'other' } } }),
    auth('claude', { env: { CLAUDE_CONFIG_DIR: '$HOME/custom' }, files: { 'custom/.credentials.json': '{}' } }),
    auth('claude', { env: { CLAUDE_CONFIG_DIR: '' }, files: { '.claude/.credentials.json': '{}' } }),
    auth('claude', { files: { '.claude/settings.json': '{"apiKeyHelper":"/bin/key"}' } }),
    auth('claude', { files: { '.claude/settings.json': '{"apiKeyHelper":""}' } }),
    auth('claude', { files: { '.claude/settings.json': '{"env":{"ANTHROPIC_AUTH_TOKEN":"t","X":null}}' } }),
    auth('claude', { files: { '.claude/settings.json': '{"env":{"CLAUDE_CODE_USE_FOUNDRY":1}}' } }),
    auth('claude', { files: { '.claude/settings.json': '{"env":{"ANTHROPIC_API_KEY":false}}' } }),
    auth('claude', { files: { '.claude/settings.json': 'not json' } }),
    auth('claude', { files: { '.claude/settings.json': 'null' } }),
    auth('claude', { files: { '.claude/settings.json': { error: 'other' } } }),
    auth('copilot', {}),
    auth('copilot', { env: { GH_TOKEN: 'x' } }),
    auth('copilot', { env: { COPILOT_PROVIDER_BASE_URL: 'http://x' } }),
    auth('copilot', { files: { '.copilot/config.json': '// managed\n{"loggedInUsers":[]}' } }),
    auth('copilot', { files: { '.copilot/config.json': '{"loggedInUsers":[{"login":"me"}]}' } }),
    auth('copilot', { files: { '.copilot/config.json': '{}' } }),
    auth('copilot', { files: { '.copilot/config.json': '  // a\n  // b\n{"loggedInUsers": []}\n' } }),
    auth('copilot', { files: { '.copilot/config.json': 'oops' } }),
    auth('copilot', { files: { '.copilot/config.json': { error: 'other' } } }),
    auth('copilot', { env: { COPILOT_HOME: '$HOME/ch' }, files: { 'ch/config.json': '{"loggedInUsers":[]}' } }),
    auth('opencode', { run: '[]' }),
    auth('opencode', { run: '[{"id":"anthropic","connections":[{"type":"env"}]}]' }),
    auth('opencode', { run: '[{"id":"a","connections":[]},{"id":"b"}]' }),
    auth('opencode', { run: 'garbage' }),
    auth('opencode', { run: '{"a":1}' }),
    auth('opencode', {}),
    auth('opencode', { files: { '.local/share/opencode/auth.json': '{"anthropic":{}}' }, run: '[]' }),
    auth('opencode', { files: { '.local/share/opencode/auth.json': '{}' }, run: '[]' }),
    auth('opencode', { env: { XDG_DATA_HOME: '$HOME/xdg' }, files: { 'xdg/opencode/auth.json': '{"x":1}' } }),
  );
  for (const [stdout, stderr, pattern] of [
    ['git version 2.45.0.windows.1', '', undefined], ['GitHub Copilot CLI 1.0.83.\nnext', '', undefined],
    ['', 'v24.1.0', undefined], ['\n  \njq-1.8.1', '', undefined], ['yq (https://github.com/mikefarah/yq/) version v4.53.6', '', undefined],
    ['no version here', '2.0.0', undefined], ['build 7', '', 'build (\\d+)'], ['', '', undefined],
    ['tool 1.2.3+build.5 extra', '', undefined], [`${'x'.repeat(250)} 1.2.3`, '', undefined],
  ] as Array<[string, string, string | undefined]>) {
    ops.push({ op: 'parseToolVersion', stdout, stderr, ...(pattern === undefined ? {} : { pattern }) });
  }
  for (const [version, min] of [['2.1.9', '2.1.260'], ['2.1.260', '2.1.260'], ['1.0', '1.0.0'], ['0.9.9', '1.0'],
    ['2.0.0-beta.1', '2.0.0'], ['1.x', '1.0'], ['3', '2.9.9'], ['1.0.0', 'x']] as Array<[string, string]>) {
    ops.push({ op: 'isOlderVersion', version, min });
  }
  ops.push({ op: 'isOlderVersion', min: '1.0.0' });
  const tool = (extra: Raw): Raw => ({ id: 'x', label: 'X', group: 'support', argv: ['x', '--version'], ...extra });
  ops.push(
    { op: 'resolveToolTable', config: {} },
    { op: 'resolveToolTable', config: { hide: ['jq', 'claude', 'nope'] } },
    { op: 'resolveToolTable', config: { tools: [tool({}), tool({ id: 'git', label: 'Git!', optional: true }), tool({ id: 'copilot', label: 'Copilot!', group: 'support', argv: ['cp'] })] } },
    { op: 'resolveToolTable', config: { tools: [tool({ id: 'opencode', label: 'OC', group: 'harness', url: 'https://x', optional: false })] } },
    { op: 'resolveToolTable', config: { tools: [tool({ id: 'rogue', group: 'harness' }), tool({ id: 'r2', group: 'harness' })] } },
  );
  for (const file of ['valid', 'override', 'invalid', 'types', 'empty', 'list', 'broken', 'reserved', 'urls', 'missing']) {
    ops.push({ op: 'loadDoctorConfig', file: `parity/fixtures/core/doctor/${file}.yaml` });
  }
  const status = (id: string, group: string, extra: Raw): Raw => ({ id, label: id, group, runner: group === 'harness', optional: true, installed: true, ...extra });
  ops.push({ op: 'doctorReport', statuses: [] });
  ops.push({ op: 'doctorReport', statuses: [
    status('claude', 'harness', { optional: false, version: '2.1.300', notes: ['not logged in — run `claude` and use /login'] }),
    status('copilot', 'harness', { optional: false, installed: false }),
    status('opencode', 'harness', { installed: false }),
    status('git', 'support', { version: undefined }),
    status('jq', 'support', { installed: false, notes: ['a', 'b'] }),
  ] });
  ops.push({ op: 'doctorReport', statuses: [status('rg', 'support', { version: '15.1.0' })] });
  ops.push(
    { op: 'validateWorkflowRunners', yaml: WORKFLOW },
    { op: 'validateWorkflowRunners', yaml: WORKFLOW.replace('runner: opencode', 'runner: nobody') },
    { op: 'validateWorkflowShell', yaml: WORKFLOW, shell: { ok: true } },
    { op: 'validateWorkflowShell', yaml: WORKFLOW, shell: { ok: false, reason: 'no shell', remediation: 'Install Git.' } },
    { op: 'validateWorkflowFrontend', yaml: WORKFLOW, canRunManual: true },
    { op: 'validateWorkflowFrontend', yaml: WORKFLOW, canRunManual: false },
  );
  for (const root of ['C:\\short', `C:\\${'d'.repeat(136)}`, `C:\\${'d'.repeat(137)}`, `/${'é'.repeat(200)}`]) {
    ops.push({ op: 'headroomWarning', root });
  }
  for (const input of ['\\\\server\\share\\proj', '//server/share', '\\\\?\\C:\\x', 'C:\\x', '/home/x', '\\\\.\\pipe\\x']) {
    ops.push({ op: 'assertNotUnc', input });
  }
  return ops;
}

export const ADAPTER_SUITES: Record<string, () => Op[]> = {
  adapters: adapterOps,
  progress: progressOps,
  doctor: doctorOps,
};
