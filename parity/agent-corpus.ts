/**
 * The scenarios the TS and Rust agents must answer identically
 * (parity/agent.test.ts). Each one is a script of requests, played one at a
 * time; see agent-transcript.ts for what is compared.
 *
 * Between them they call every method, with valid and invalid params, and
 * cover the envelope, workflow files, config, dry runs, real runs with
 * command steps, manual gates, cancellation, resume, an interactive
 * terminal, run housekeeping, artifacts, app state, models and doctor, the
 * working diff, and remote access.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Ctx, Message, Scenario } from './agent-transcript.ts';

const NODE = JSON.stringify(process.execPath);
const isWin = process.platform === 'win32';

/** A command step's shell line that runs `js` under node, on every platform. */
function nodeRun(js: string): string {
  return `${NODE} -e ${JSON.stringify(js)}`;
}

function workflow(name: string, steps: string): string {
  return `name: ${name}\nsteps:\n${steps}`;
}

const finished = (m: Message): boolean =>
  m.method === 'runStateChanged' && m.params.status !== 'running';

const job = (ctx: Ctx): string => ctx.vars.jobId as string;
const keepJob = (r: any, ctx: Ctx): void => { ctx.vars.jobId = r.jobId; };

/** Every method with params that must not validate, and what the envelope refuses. */
const BAD_PARAMS: Array<[string, unknown]> = [
  ['hello', 5], ['hello', null],
  ['listWorkflows', {}], ['listWorkflows', { workdir: '' }],
  ['getWorkflow', { workdir: 'w', name: '../x' }], ['getWorkflow', { workdir: 'w', name: 5, scope: 'nowhere' }],
  ['createWorkflow', { workdir: 'w' }], ['updateWorkflow', { workdir: 'w', name: 'n', workflow: { name: 'x', steps: [{ id: 'a' }] } }],
  ['deleteWorkflow', { workdir: 'w', name: 'a/b' }], ['cloneWorkflow', { workdir: 'w', name: 'a', newName: '' }],
  ['validateWorkflow', {}], ['initWorkspace', { workdir: 3 }],
  ['doctor', { workdir: '' }], ['listModels', { refresh: 'yes' }],
  ['configGet', { workdir: '' }],
  ['configSet', { config: { defaults: {}, on_findings: 'x', loop: { max_iterations: 0 }, artifacts_dir: '', runs: { max_retained: 0, auto_name: 1, max_attachment_mb: 0 } }, explicitKeys: ['nope'] }],
  ['startRun', { workdir: 'w', workflow: 'f', inputs: { a: 1 }, maxIterations: 1.5 }],
  ['startRun', { workdir: 'w', workflow: 'f', attachments: [{ path: '/a', base64: '' }, { x: 1 }] }],
  ['resumeRun', { workdir: 'w', runId: 'r', extraIterations: 0 }],
  ['cancelRun', {}], ['cancelRun', { jobId: '' }],
  ['deleteRun', { workdir: 'w' }], ['setRunLocked', { workdir: 'w', runId: 'r', locked: 'yes' }],
  ['renameRun', { workdir: 'w', runId: 'r' }], ['pruneRuns', { workdir: 'w', max: 1.5 }],
  ['endSession', {}], ['resolveManual', { jobId: 'j', stepId: 's', choice: 'maybe', comments: [{ path: 1 }] }],
  ['listRuns', { workdir: null }], ['getRun', { workdir: 'w', runId: '' }],
  ['readRunLog', { workdir: '', runId: 3, limit: 6000, offset: -1 }], ['readRunLog', { workdir: 'w', runId: 'r', limit: 1.5 }],
  ['getWorkingDiff', {}],
  ['readArtifact', { workdir: 'w', runId: 'r', name: 'n', encoding: 'hex' }],
  ['writeArtifact', { workdir: 'w', runId: 'r', name: 'n', expectedMtimeMs: -1 }],
  ['statArtifact', { workdir: 'w', runId: 'r' }],
  ['ptyInput', { jobId: 'j' }], ['ptyResize', { jobId: 'j', cols: 0, rows: 2.5 }],
  ['getAppState', []], ['touchRecentWorkspace', { path: '' }], ['setWorkspacePinned', { path: 'p' }],
  ['setUiState', { window: { width: 0, height: 1, x: 0.5, y: 'a' }, theme: 'blue' }],
  ['listRecentRuns', { limit: 101 }], ['listJobs', 'x'], ['getJobScrollback', {}],
  ['remoteAccessGet', 1], ['remoteAccessSet', { port: 80 }], ['remoteAccessSet', { port: 70000, enabled: 1 }],
  ['remoteAccessRotateToken', false],
];

/** A `claude` that the interactive step talks to (see main.test.ts's stub). */
function claudeStub(): Record<string, string> {
  const impl = [
    'const fs = require("fs");',
    'const args = process.argv.slice(2);',
    'if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }',
    'if (args[0] === "-p") {',
    '  const prompt = fs.readFileSync(0, "utf8");',
    '  const m = prompt.match(/to (\\S+)\\. Write only the artifact content/);',
    '  if (!m) process.exit(5);',
    '  fs.writeFileSync(require("path").resolve(process.cwd(), m[1]), "STUBBED ARTIFACT CONTENT\\n");',
    '  process.exit(0);',
    '}',
    'process.stdout.write("ready\\r\\n");',
    'process.stdin.setEncoding("utf8");',
    'let buf = "";',
    'process.stdin.on("data", d => {',
    '  buf += d;',
    '  if (buf.includes("\\r") || buf.includes("\\n")) { process.stdout.write("bye " + buf.trim() + "\\r\\n"); process.exit(0); }',
    '});',
    '',
  ].join('\n');
  return {
    'stubs/claude-impl.js': impl,
    'stubs/claude': '#!/usr/bin/env node\nrequire("./claude-impl.js");\n',
    'stubs/claude.cmd': [
      '@ECHO off', 'SETLOCAL', 'CALL :find_dp0',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & node "%dp0%\\claude-impl.js" %*',
      ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b',
    ].join('\r\n') + '\r\n',
  };
}

function stubPath(ctx: Ctx): Record<string, string> {
  if (!isWin) execFileSync('chmod', ['+x', path.join(ctx.root, 'stubs', 'claude')]);
  return { PATH: `${path.join(ctx.root, 'stubs')}${path.delimiter}${process.env.PATH ?? ''}` };
}

const WF = 'ws/.whiphand/workflows';

export const SCENARIOS: Scenario[] = [
  {
    name: 'envelope and params',
    steps: [
      { raw: '{bad', label: 'not json' },
      { raw: '[]', label: 'not an object' },
      { raw: '{"id":"x","method":"hello"}', label: 'string id' },
      { raw: '{"id":2.5,"method":""}', label: 'empty method' },
      { raw: '{"id":1e21,"method":"nope"}', label: 'unknown method' },
      { raw: '{"method":"hello"}', label: 'no id' },
      ...BAD_PARAMS.map(([call, params]) => ({ call, params, label: `${call} ${JSON.stringify(params)}` })),
    ],
  },
  {
    name: 'workflow files',
    files: {
      [`${WF}/commented.yaml`]: '# keep me\nname: commented\nsteps:\n  - id: a # first\n    kind: command\n    run: echo a\n    output: a.log\n',
      [`${WF}/broken.yaml`]: 'name: broken\nsteps: 3\n',
      'home/workflows/global-only.yaml': workflow('global-only', '  - id: g\n    kind: command\n    run: echo g\n    output: g.log\n'),
    },
    steps: [
      { call: 'hello' },
      { call: 'listWorkflows', params: (c: Ctx) => ({ workdir: c.ws }) },
      { call: 'getWorkflow', params: (c: Ctx) => ({ workdir: c.ws, name: 'commented' }) },
      { call: 'getWorkflow', params: (c: Ctx) => ({ workdir: c.ws, name: 'broken' }), label: 'getWorkflow broken' },
      { call: 'getWorkflow', params: (c: Ctx) => ({ workdir: c.ws, name: 'global-only', scope: 'global' }), label: 'getWorkflow global' },
      { call: 'getWorkflow', params: (c: Ctx) => ({ workdir: c.ws, name: 'missing' }), label: 'getWorkflow missing' },
      { call: 'createWorkflow', params: (c: Ctx) => ({ workdir: c.ws, name: 'made' }) },
      { call: 'createWorkflow', params: (c: Ctx) => ({ workdir: c.ws, name: 'made' }), label: 'createWorkflow again' },
      { call: 'createWorkflow', params: (c: Ctx) => ({ workdir: c.ws, name: 'Bad Name!' }), label: 'createWorkflow bad name' },
      {
        call: 'updateWorkflow', label: 'updateWorkflow merge',
        params: (c: Ctx) => ({ workdir: c.ws, name: 'commented', workflow: { name: 'commented', steps: [{ id: 'a', kind: 'command', run: 'echo b', output: 'a.log', enabled: false }] } }),
      },
      { call: 'getWorkflow', params: (c: Ctx) => ({ workdir: c.ws, name: 'commented' }), label: 'getWorkflow after update' },
      {
        call: 'updateWorkflow', label: 'updateWorkflow semantic problem',
        params: (c: Ctx) => ({ workdir: c.ws, name: 'commented', workflow: { name: 'commented', steps: [{ id: 'a', kind: 'command', run: 'x', output: 'a.log', inputs: ['nope'] }] } }),
      },
      { call: 'cloneWorkflow', params: (c: Ctx) => ({ workdir: c.ws, name: 'commented', newName: 'copy' }) },
      { call: 'cloneWorkflow', params: (c: Ctx) => ({ workdir: c.ws, name: 'commented', newName: 'copy' }), label: 'cloneWorkflow onto existing' },
      { call: 'deleteWorkflow', params: (c: Ctx) => ({ workdir: c.ws, name: 'copy' }) },
      { call: 'deleteWorkflow', params: (c: Ctx) => ({ workdir: c.ws, name: 'copy' }), label: 'deleteWorkflow again' },
      { call: 'validateWorkflow', params: { draft: { name: 'w', steps: [] } } },
      { call: 'validateWorkflow', params: { draft: { name: 'w', steps: [{ id: 'a', kind: 'command', output: 'a.log' }] } }, label: 'validateWorkflow field problem' },
      { call: 'validateWorkflow', params: { draft: { name: 'w', steps: [{ id: 'a', kind: 'command', run: 'x', output: 'a.log' }] } }, label: 'validateWorkflow valid' },
      { call: 'initWorkspace', params: (c: Ctx) => ({ workdir: c.ws }) },
      { call: 'initWorkspace', params: (c: Ctx) => ({ workdir: c.ws }), label: 'initWorkspace again' },
      { call: 'listWorkflows', params: (c: Ctx) => ({ workdir: c.ws }), label: 'listWorkflows after init' },
    ],
  },
  {
    name: 'config',
    steps: [
      { call: 'configGet' },
      { call: 'configGet', params: (c: Ctx) => ({ workdir: c.ws }), label: 'configGet project' },
      {
        call: 'configSet', label: 'configSet global',
        params: { scope: 'global', config: { defaults: { runner: 'copilot' }, on_findings: 'report', loop: { max_iterations: 3 }, artifacts_dir: '.whiphand/runs', runs: { max_retained: null, auto_name: false, max_attachment_mb: 25 } } },
      },
      {
        call: 'configSet', label: 'configSet project',
        params: (c: Ctx) => ({ workdir: c.ws, explicitKeys: ['loop.max_iterations'], config: { defaults: { runner: 'copilot' }, on_findings: 'loop', loop: { max_iterations: 3 }, artifacts_dir: '.whiphand/runs', runs: { max_retained: 5, auto_name: true, max_attachment_mb: 1.5 } } }),
      },
      {
        call: 'configSet', label: 'configSet project without workdir',
        params: { config: { defaults: { runner: 'claude' }, on_findings: 'report', loop: { max_iterations: 3 }, artifacts_dir: '.whiphand/runs', runs: { max_retained: null, auto_name: false, max_attachment_mb: 25 } } },
      },
      { call: 'configGet', params: (c: Ctx) => ({ workdir: c.ws }), label: 'configGet after' },
    ],
  },
  {
    name: 'runs, artifacts and housekeeping',
    files: {
      [`${WF}/build.yaml`]: workflow('build', [
        '  - id: one',
        '    kind: command',
        `    run: ${JSON.stringify(nodeRun('console.log("one out"); console.error("one err")'))}`,
        '    output: one.log',
        '  - id: two',
        '    kind: command',
        `    run: ${JSON.stringify(nodeRun('require("fs").writeFileSync(".whiphand/two.txt", "x"); console.log("two")'))}`,
        '    output: two.log',
        '',
      ].join('\n')),
      [`${WF}/plan.yaml`]: [
        'name: plan',
        'inputs:',
        '  goal:',
        '    required: true',
        '    prompt: Goal?',
        'steps:',
        '  - id: p',
        '    runner: claude',
        '    mode: headless',
        '    writes: false',
        '    output: p.md',
        '    prompt: "Plan {{ inputs.goal }}"',
        '',
      ].join('\n'),
      'attach.txt': 'attached text\n',
    },
    steps: [
      { call: 'startRun', params: (c: Ctx) => ({ workdir: c.ws, workflow: 'build' }), keep: keepJob },
      { until: finished, label: 'build finished' },
      { call: 'listJobs' },
      { call: 'getJobScrollback', params: (c: Ctx) => ({ jobId: job(c) }) },
      { call: 'getJobScrollback', params: { jobId: 'nope' }, label: 'getJobScrollback unknown' },
      {
        call: 'listRuns', params: (c: Ctx) => ({ workdir: c.ws }),
        keep: (r: any, c: Ctx) => { c.vars.runId = r[0].runId; },
      },
      { call: 'getRun', params: (c: Ctx) => ({ workdir: c.ws, runId: c.vars.runId }) },
      { call: 'getRun', params: (c: Ctx) => ({ workdir: c.ws, runId: 'nope' }), label: 'getRun unknown' },
      // Stops before run:env's line, whose place in run.log is a race.
      { call: 'readRunLog', params: (c: Ctx) => ({ workdir: c.ws, runId: c.vars.runId, limit: 2 }) },
      { call: 'readRunLog', params: (c: Ctx) => ({ workdir: c.ws, runId: c.vars.runId, fromEnd: true, limit: 2 }), label: 'readRunLog tail' },
      { call: 'readRunLog', params: (c: Ctx) => ({ workdir: c.ws, runId: 'nope' }), label: 'readRunLog unknown' },
      { call: 'readArtifact', params: (c: Ctx) => ({ workdir: c.ws, runId: c.vars.runId, name: 'one.log' }) },
      { call: 'readArtifact', params: (c: Ctx) => ({ workdir: c.ws, runId: c.vars.runId, name: 'one.log', encoding: 'base64' }), label: 'readArtifact base64' },
      { call: 'readArtifact', params: (c: Ctx) => ({ workdir: c.ws, runId: c.vars.runId, name: '../../x' }), label: 'readArtifact outside' },
      { call: 'statArtifact', params: (c: Ctx) => ({ workdir: c.ws, runId: c.vars.runId, name: 'two.log' }) },
      { call: 'writeArtifact', params: (c: Ctx) => ({ workdir: c.ws, runId: c.vars.runId, name: 'two.log', content: 'edited\n' }) },
      { call: 'writeArtifact', params: (c: Ctx) => ({ workdir: c.ws, runId: c.vars.runId, name: 'two.log', content: 'x', expectedMtimeMs: 1 }), label: 'writeArtifact stale' },
      { call: 'readArtifact', params: (c: Ctx) => ({ workdir: c.ws, runId: c.vars.runId, name: 'two.log' }), label: 'readArtifact after write' },
      { call: 'renameRun', params: (c: Ctx) => ({ workdir: c.ws, runId: c.vars.runId, name: '  Nice\tname ' }) },
      { call: 'renameRun', params: (c: Ctx) => ({ workdir: c.ws, runId: 'nope', name: 'x' }), label: 'renameRun unknown' },
      { call: 'setRunLocked', params: (c: Ctx) => ({ workdir: c.ws, runId: c.vars.runId, locked: true }) },
      { call: 'deleteRun', params: (c: Ctx) => ({ workdir: c.ws, runId: c.vars.runId }), label: 'deleteRun locked' },
      { call: 'setRunLocked', params: (c: Ctx) => ({ workdir: c.ws, runId: c.vars.runId, locked: false }), label: 'setRunLocked off' },
      { call: 'startRun', params: (c: Ctx) => ({ workdir: c.ws, workflow: 'plan', dryRun: true, inputs: { goal: 'G' }, name: 'dry', maxIterations: 2, attachments: [{ path: path.join(c.root, 'attach.txt') }, { name: 'pasted.txt', base64: Buffer.from('pasted').toString('base64') }] }), label: 'startRun dry with attachments', keep: keepJob },
      { until: (m: Message, c: Ctx) => finished(m) && m.params.jobId === job(c), label: 'dry finished' },
      { call: 'startRun', params: (c: Ctx) => ({ workdir: c.ws, workflow: 'build', attachments: [{ path: path.join(c.root, 'attach.txt') }] }), label: 'startRun attachments refused' },
      { call: 'startRun', params: (c: Ctx) => ({ workdir: c.ws, workflow: 'missing' }), label: 'startRun missing workflow', keep: keepJob },
      { until: (m: Message, c: Ctx) => finished(m) && m.params.jobId === job(c), label: 'missing finished' },
      { call: 'listRuns', params: (c: Ctx) => ({ workdir: c.ws }), label: 'listRuns after' },
      { call: 'pruneRuns', params: (c: Ctx) => ({ workdir: c.ws, max: 1 }) },
      { call: 'deleteRun', params: (c: Ctx) => ({ workdir: c.ws, runId: 'nope' }), label: 'deleteRun missing' },
      { call: 'listRuns', params: (c: Ctx) => ({ workdir: c.ws }), label: 'listRuns final' },
    ],
  },
  {
    name: 'manual gate, cancel and resume',
    files: {
      [`${WF}/gate.yaml`]: workflow('gate', [
        '  - id: before',
        '    kind: command',
        `    run: ${JSON.stringify(nodeRun('console.log("before")'))}`,
        '    output: before.log',
        '  - id: approve',
        '    kind: approval',
        '    title: Ship it?',
        '    instructions: Look first.',
        '',
      ].join('\n')),
      [`${WF}/slow.yaml`]: workflow('slow', [
        '  - id: wait',
        '    kind: command',
        `    run: ${JSON.stringify(nodeRun('setTimeout(() => {}, 60000)'))}`,
        '    output: wait.log',
        '',
      ].join('\n')),
      [`${WF}/flaky.yaml`]: workflow('flaky', [
        '  - id: first',
        '    kind: command',
        `    run: ${JSON.stringify(nodeRun('console.log("first")'))}`,
        '    output: first.log',
        '  - id: second',
        '    kind: command',
        `    run: ${JSON.stringify(nodeRun('const fs = require("fs"); if (!fs.existsSync("ok")) process.exit(3); console.log("second")'))}`,
        '    output: second.log',
        '',
      ].join('\n')),
    },
    steps: [
      { call: 'startRun', params: (c: Ctx) => ({ workdir: c.ws, workflow: 'gate' }), keep: keepJob },
      { until: (m: Message, c: Ctx) => m.method === 'manualRequest' && m.params.jobId === job(c), label: 'gate asks' },
      { call: 'listJobs', label: 'listJobs parked' },
      { call: 'resolveManual', params: (c: Ctx) => ({ jobId: job(c), stepId: 'other', choice: 'continue' }), label: 'resolveManual stale' },
      { call: 'resolveManual', params: { jobId: 'nope', stepId: 'approve', choice: 'continue' }, label: 'resolveManual unknown job' },
      { call: 'resolveManual', params: (c: Ctx) => ({ jobId: job(c), stepId: 'approve', choice: 'continue', note: 'fine', comments: [{ path: 'a.txt', body: 'nit' }] }) },
      { until: (m: Message, c: Ctx) => finished(m) && m.params.jobId === job(c), label: 'gate finished' },
      { call: 'startRun', params: (c: Ctx) => ({ workdir: c.ws, workflow: 'slow' }), keep: keepJob, label: 'startRun slow' },
      { until: (m: Message, c: Ctx) => m.method === 'whiphandEvent' && m.params.jobId === job(c) && m.params.event.type === 'step:spawn', label: 'slow spawned' },
      { call: 'cancelRun', params: (c: Ctx) => ({ jobId: job(c) }) },
      { until: (m: Message, c: Ctx) => finished(m) && m.params.jobId === job(c), label: 'slow cancelled' },
      { call: 'cancelRun', params: { jobId: 'nope' }, label: 'cancelRun unknown job' },
      { call: 'cancelRun', params: (c: Ctx) => ({ workdir: c.ws, runId: 'nope' }), label: 'cancelRun unknown run' },
      { call: 'startRun', params: (c: Ctx) => ({ workdir: c.ws, workflow: 'flaky' }), keep: keepJob, label: 'startRun flaky' },
      {
        until: (m: Message, c: Ctx) => finished(m) && m.params.jobId === job(c), label: 'flaky failed',
      },
      { call: 'listRuns', params: (c: Ctx) => ({ workdir: c.ws }), keep: (r: any, c: Ctx) => { c.vars.runId = r.find((x: any) => x.workflow === 'flaky').runId; } },
      { call: 'resumeRun', params: (c: Ctx) => ({ workdir: c.ws, runId: 'nope' }), label: 'resumeRun unknown' },
      { act: (c: Ctx) => { execFileSync(process.execPath, ['-e', 'require("fs").writeFileSync("ok", "")'], { cwd: c.ws }); }, label: 'fix the flake' },
      { call: 'resumeRun', params: (c: Ctx) => ({ workdir: c.ws, runId: c.vars.runId }), keep: keepJob },
      { until: (m: Message, c: Ctx) => finished(m) && m.params.jobId === job(c), label: 'resume finished' },
      { call: 'getRun', params: (c: Ctx) => ({ workdir: c.ws, runId: c.vars.runId }), label: 'getRun resumed' },
    ],
  },
  {
    name: 'interactive terminal',
    files: {
      ...claudeStub(),
      [`${WF}/chat.yaml`]: workflow('chat', [
        '  - id: chat',
        '    runner: claude',
        '    mode: interactive',
        '    writes: true',
        '    prompt: hello',
        '    output: chat.md',
        '',
      ].join('\n')),
    },
    env: stubPath,
    steps: [
      { call: 'endSession', params: { jobId: 'nope' }, label: 'endSession unknown' },
      { call: 'ptyInput', params: { jobId: 'nope', data: '' }, label: 'ptyInput unknown' },
      { call: 'ptyResize', params: { jobId: 'nope', cols: 10, rows: 10 }, label: 'ptyResize unknown' },
      { call: 'startRun', params: (c: Ctx) => ({ workdir: c.ws, workflow: 'chat' }), keep: keepJob },
      { until: (m: Message, c: Ctx) => m.method === 'ptyStarted' && m.params.jobId === job(c), label: 'terminal opens' },
      {
        until: (m: Message, c: Ctx) => m.method === 'ptyData' && m.params.jobId === job(c)
          && Buffer.from(m.params.data, 'base64').toString().includes('ready'),
        label: 'runner ready',
      },
      { call: 'ptyResize', params: (c: Ctx) => ({ jobId: job(c), cols: 100, rows: 30 }) },
      { call: 'listJobs', label: 'listJobs live' },
      { call: 'ptyInput', params: (c: Ctx) => ({ jobId: job(c), data: Buffer.from('go\r').toString('base64') }) },
      { until: (m: Message, c: Ctx) => m.method === 'ptyExit' && m.params.jobId === job(c), label: 'terminal exits' },
      { until: (m: Message, c: Ctx) => finished(m) && m.params.jobId === job(c), label: 'chat finished' },
      { call: 'endSession', params: (c: Ctx) => ({ jobId: job(c) }), label: 'endSession after exit' },
      { call: 'listRuns', params: (c: Ctx) => ({ workdir: c.ws }), keep: (r: any, c: Ctx) => { c.vars.runId = r[0].runId; } },
      { call: 'readArtifact', params: (c: Ctx) => ({ workdir: c.ws, runId: c.vars.runId, name: 'chat.md' }) },
    ],
  },
  {
    name: 'app state',
    files: { 'other/.keep': '' },
    steps: [
      { call: 'getAppState' },
      { call: 'touchRecentWorkspace', params: (c: Ctx) => ({ path: c.ws }) },
      { call: 'touchRecentWorkspace', params: (c: Ctx) => ({ path: path.join(c.root, 'other') }), label: 'touch other' },
      { call: 'touchRecentWorkspace', params: (c: Ctx) => ({ path: path.join(c.root, 'nowhere') }), label: 'touch missing' },
      { call: 'setWorkspacePinned', params: (c: Ctx) => ({ path: c.ws, pinned: true }) },
      { call: 'setWorkspacePinned', params: (c: Ctx) => ({ path: path.join(c.root, 'nowhere'), pinned: true }), label: 'pin unknown' },
      { call: 'setUiState', params: { theme: 'dark', lastPage: '/runs', window: { width: 800, height: 600, x: -5, y: 10 }, runsRetention: { maxPerWorkspace: 3 }, showOngoingRuns: false } },
      { call: 'setUiState', params: { window: null, lastPage: null }, label: 'setUiState clear' },
      { call: 'getAppState', label: 'getAppState after' },
      { call: 'listRecentRuns' },
      { call: 'listRecentRuns', params: { limit: 1 }, label: 'listRecentRuns limit' },
      { call: 'setWorkspacePinned', params: (c: Ctx) => ({ path: c.ws, pinned: false }), label: 'unpin' },
    ],
  },
  {
    name: 'machine: doctor and models without tools',
    env: () => ({ PATH: '' }),
    steps: [
      { call: 'listModels' },
      { call: 'doctor' },
      { call: 'listModels', params: { refresh: true }, label: 'listModels refresh' },
    ],
  },
  {
    name: 'working diff',
    steps: [
      { call: 'getWorkingDiff', params: (c: Ctx) => ({ workdir: c.ws }), label: 'not a repo' },
      {
        act: (c: Ctx) => {
          const git = (...args: string[]) => execFileSync('git', args, { cwd: c.ws, stdio: 'ignore' });
          git('init', '-q', '-b', 'main');
          git('config', 'core.autocrlf', 'false');
          execFileSync(process.execPath, ['-e', 'require("fs").writeFileSync("a.txt", "a\\nb\\n")'], { cwd: c.ws });
          git('add', '-A');
          git('-c', 'user.email=p@w', '-c', 'user.name=p', 'commit', '-q', '-m', 'init');
          execFileSync(process.execPath, ['-e', 'const fs = require("fs"); fs.writeFileSync("a.txt", "a\\nB\\n"); fs.writeFileSync("new.txt", "n\\n")'], { cwd: c.ws });
        },
        label: 'make a repo with changes',
      },
      { call: 'getWorkingDiff', params: (c: Ctx) => ({ workdir: c.ws }), label: 'changes' },
    ],
  },
  {
    name: 'remote access',
    steps: [
      { call: 'remoteAccessGet' },
      { call: 'remoteAccessSet', params: () => ({ enabled: true, port: Number(process.env.PARITY_REMOTE_PORT) }), label: 'enable' },
      { call: 'remoteAccessRotateToken' },
      { call: 'remoteAccessGet', label: 'remoteAccessGet on' },
      { call: 'remoteAccessSet', params: { enabled: false }, label: 'disable' },
    ],
  },
];
