/**
 * The corpus for parity/agent-core-probe.ts: the core pieces the desktop
 * agent needs, ported in Phase 3.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO } from './core-probe.ts';
import type { Op } from './core-probe.ts';
import { parseWorkflow } from '../packages/core/src/schema.ts';

/** A chunk or file body spelled `[text, times]`, so the suite stays small; the probes expand it. */
const rep = (text: string, times: number) => ({ repeat: [text, times] });
const big = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i} ${'.'.repeat(60)}\n`).join('');

function diffOps(): Op[] {
  const ops: Op[] = [];
  for (const stdout of [
    '', '\n', '12\t3\tsrc/a.ts\0', '1\t0\ta.ts\0\n', '1\t1\t\0old.txt\0new name.txt\0', '-\t-\tb.png\0',
    '1\t0\tweird\tname.txt\0', '-\t-\tb.png\0' + '1\t1\t\0old.txt\0new.txt\0' + '4\t0\tz.ts\0\n',
    '1\t1\t\0only-old\0', 'garbage\0', 'x\ty\tp\0', ' 7\t+2\tq\0', '-\t3\tr\0', '1\t-\ts\0',
  ]) ops.push({ op: 'parseNumstatZ', stdout });

  const header = (p: string) => `diff --git a/${p} b/${p}\nindex 1..2 100644\n--- a/${p}\n+++ b/${p}\n`;
  for (const patch of [
    '', '  \n', header('x') + '@@ -1 +1 @@\n-a\n+b\n' + header('y') + '@@ -1 +1 @@\n-c\n+d\n',
    'preamble\n' + header('x'), header('x') + '+diff --git a/z b/z\n', header('x') + '+a\rdiff --git a/y b/y\n',
    header('x') + '+a diff --git a/y b/y\n', 'diff --git a/x b/x', header('my file.txt'),
  ]) ops.push({ op: 'splitPatch', patch });

  const entry = (p: string, extra: Record<string, unknown> = {}) =>
    ({ path: p, additions: 1, deletions: 0, binary: false, ...extra });
  const chunk = (p: string, body = '@@ -1 +1 @@\n-a\n+b\n') => `${header(p)}${body}`;
  ops.push(
    { op: 'pairPatches', entries: [], chunks: [] },
    { op: 'pairPatches', entries: [entry('a'), entry('b')], chunks: [chunk('a'), chunk('b')] },
    { op: 'pairPatches', entries: [entry('a'), entry('b')], chunks: [chunk('a')] },
    { op: 'pairPatches', entries: [entry('a')], chunks: [] },
    { op: 'pairPatches', entries: [entry('n')], chunks: ['diff --git a/n b/n\nnew file mode 100644\n'] },
    { op: 'pairPatches', entries: [entry('d')], chunks: ['diff --git a/d b/d\ndeleted file mode 100644\n'] },
    { op: 'pairPatches', entries: [entry('r', { oldPath: 'q' })], chunks: ['diff --git a/q b/r\nnew file mode 1\n'] },
    { op: 'pairPatches', entries: [entry('p')], chunks: ['diff --git a/p b/p\nBinary files a/p and b/p differ\n'] },
    { op: 'pairPatches', entries: [entry('p')], chunks: ['diff --git a/p b/p\nGIT binary patch\nliteral 0\n'] },
    { op: 'pairPatches', entries: [entry('p')], chunks: ['diff --git a/p b/p\nGIT binary patchy\n'] },
    { op: 'pairPatches', entries: [entry('p', { binary: true })], chunks: [chunk('p')] },
    { op: 'pairPatches', entries: [entry('big')], chunks: [rep('+', 256 * 1024)] },
    { op: 'pairPatches', entries: [entry('fit')], chunks: [rep('é', 256 * 1024)] },
    { op: 'pairPatches', entries: [entry('wide')], chunks: [rep('😀', 128 * 1024 + 1)] },
    {
      op: 'pairPatches',
      entries: Array.from({ length: 18 }, (_, i) => entry(`f${i}`)),
      chunks: Array.from({ length: 18 }, () => rep('x', 250 * 1024)),
    },
  );

  const repo = (name: string, steps: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
    ({ op: 'workingDiffFiles', name, repo: steps, ...extra });
  const base = [{ write: ['a.txt', 'a\nb\nc\nd\ne\n'] }, { write: ['keep.txt', big(20, 'keep')] }, { commit: 'init' }];
  ops.push(
    repo('not a repo', [{ write: ['a.txt', 'x\n'] }], { git: false }),
    repo('no commits yet', [{ write: ['a.txt', 'x\n'] }, { write: ['dir/b.txt', 'y\n'] }]),
    repo('no commits, empty', []),
    repo('clean', base),
    repo('edit, delete, add', [...base,
      { write: ['a.txt', 'a\nB\nc\nd\ne\nf\n'] }, { rm: 'keep.txt' }, { write: ['new/untracked.md', '# hi\n'] }]),
    repo('rename', [...base, { mv: ['keep.txt', 'moved.txt'] }]),
    repo('rename with edit', [...base, { mv: ['keep.txt', 'moved.txt'] }, { write: ['moved.txt', big(20, 'keep') + 'more\n'] }]),
    repo('binary', [...base, { bytes: ['img.bin', Buffer.from([0, 1, 2, 0, 255, 0]).toString('base64')] }]),
    repo('odd names', [...base, { write: ['my file.txt', 'x\n'] }, { write: ['ünïcödé/名前.txt', 'y\n'] }]),
    repo('whiphand excluded', [...base, { write: ['.whiphand/runs/r/plan.md', 'p\n'] }, { write: ['src.ts', 'z\n'] }]),
    repo('crlf', [...base, { write: ['win.txt', 'a\r\nb\r\n'] }]),
    repo('a patch file under review', [...base, { write: ['fix.patch', 'diff --git a/q b/q\n--- a/q\n+++ b/q\n'] }]),
    repo('file cap', [...base, ...Array.from({ length: 5 }, (_, i) => ({ write: [`f${i}.txt`, `${i}\n`] }))], { maxFiles: 2 }),
    repo('large file', [...base, { write: ['gen.txt', rep('generated line .................................................\n', 5000)] }]),
  );
  return ops;
}

export const AGENT_CORE_SUITES: Record<string, () => Op[]> = {
  diff: diffOps,
  'merge-workflow': () => mergeOps(text => parseWorkflow(text) as unknown as Wf),
  workspaces: workspaceOps,
  models: modelOps,
  'workflow-write': () => workflowFileOps(text => parseWorkflow(text) as unknown as Wf),
};

// ------------------------------------------------------------ mergeWorkflow

type Wf = { steps: Step[] } & Record<string, unknown>;
type Step = { id: string; kind?: string; steps?: Step[] } & Record<string, unknown>;

const MERGE_DIRS = ['parity/fixtures/core/merge', 'packages/core/templates', 'examples'];
const MERGE_FILES = ['parity/fixtures/core/workflows/kitchen-sink.yaml'];

const isContainer = (s: Step) => s.kind === 'loop' || s.kind === 'stages';
function firstContainer(steps: Step[]): Step | undefined {
  for (const s of steps) {
    if (isContainer(s)) return s;
  }
  return undefined;
}

/** Each edit takes a fresh copy and returns it changed, or undefined when it does not apply. */
const EDITS: Record<string, (wf: Wf) => Wf | undefined> = {
  'no-op': wf => wf,
  'disable first step': wf => { wf.steps[0].enabled = false; return wf; },
  'disable last step': wf => { wf.steps[wf.steps.length - 1].enabled = false; return wf; },
  'disable a nested step': wf => {
    const c = firstContainer(wf.steps);
    if (!c?.steps?.length) return undefined;
    c.steps[c.steps.length - 1].enabled = false;
    return wf;
  },
  'reverse steps': wf => wf.steps.length < 2 ? undefined : (wf.steps.reverse(), wf),
  'drop first step': wf => wf.steps.length < 2 ? undefined : (wf.steps.shift(), wf),
  'rename first step': wf => { wf.steps[0].id = `${wf.steps[0].id}-renamed`; return wf; },
  'set description': wf => { wf.description = 'A new description: with a colon'; return wf; },
  'delete description': wf => ('description' in wf ? (delete wf.description, wf) : undefined),
  'delete inputs': wf => ('inputs' in wf ? (delete wf.inputs, wf) : undefined),
  'append a command step': wf => {
    wf.steps.push({ kind: 'command', id: 'appended', run: 'echo "#not a comment"', output: 'appended.log' });
    return wf;
  },
  'nested step to root': wf => {
    const c = firstContainer(wf.steps);
    if (!c?.steps || c.steps.length < 2) return undefined;
    const moved = c.steps.shift()!;
    wf.steps.push(moved);
    return wf;
  },
  'root step into container': wf => {
    const c = firstContainer(wf.steps);
    const leaf = wf.steps.find(s => !isContainer(s));
    if (!c?.steps || !leaf) return undefined;
    wf.steps = wf.steps.filter(s => s !== leaf);
    c.steps.push(leaf);
    return wf;
  },
};

export function mergeOps(parse: (text: string) => Wf): Op[] {
  const files = [
    ...MERGE_DIRS.flatMap(dir => readdirSync(path.join(REPO, dir))
      .filter(f => f.endsWith('.yaml')).sort().map(f => `${dir}/${f}`)),
    ...MERGE_FILES,
  ];
  const ops: Op[] = [];
  for (const file of files) {
    const text = readFileSync(path.join(REPO, file), 'utf8');
    for (const [edit, apply] of Object.entries(EDITS)) {
      const workflow = apply(parse(text));
      if (workflow !== undefined) ops.push({ op: 'mergeWorkflow', file, edit, text, workflow });
    }
  }
  const crlf = readFileSync(path.join(REPO, 'parity/fixtures/core/merge/feature-commented.yaml'), 'utf8').replace(/\n/g, '\r\n');
  for (const edit of ['no-op', 'disable a nested step', 'reverse steps']) {
    ops.push({ op: 'mergeWorkflow', file: 'crlf', edit, text: crlf, workflow: EDITS[edit](parse(crlf)) });
  }
  const minimal = { name: 'w', steps: [{ kind: 'command', id: 'a', run: 'echo hi', output: 'a.log' }] };
  for (const text of ['', 'just a string\n', '- a\n- b\n', '# only a comment\n']) {
    ops.push({ op: 'mergeWorkflow', file: 'inline', edit: 'replace', text, workflow: minimal });
  }
  return ops;
}

// ------------------------------------------- update, delete, clone a workflow

export function workflowFileOps(parse: (text: string) => Wf): Op[] {
  const commented = readFileSync(path.join(REPO, 'parity/fixtures/core/merge/feature-commented.yaml'), 'utf8');
  const wf = () => parse(commented);
  const edited = () => { const w = wf(); w.steps[0].enabled = false; return w; };
  const broken = () => { const w = wf(); w.steps[0].inputs = ['nope']; return w; };
  const at = (dir: string, name: string, text: string) => ({ writeFile: [`${dir}/${name}`, text] });
  const project = (name: string, text = commented) => at('ws/.whiphand/workflows', name, text);
  const global = (name: string, text = commented) => at('home/workflows', name, text);
  const op = (name: string, script: Array<Record<string, unknown>>): Op => ({ op: 'workflowFiles', name, script });
  return [
    op('update writes a fresh file', [{ call: 'update', name: 'fresh', workflow: wf() }]),
    op('update merges onto the file', [project('feature.yaml'), { call: 'update', name: 'feature', workflow: edited() }]),
    op('update locks the name', [{ call: 'update', name: 'other', workflow: wf() }]),
    op('update in the global scope', [global('feature.yaml'), { call: 'update', name: 'feature', scope: 'global', workflow: edited() }]),
    op('update refuses a bad name', [{ call: 'update', name: '../x', workflow: wf() }]),
    op('update refuses semantic problems', [project('feature.yaml'), { call: 'update', name: 'feature', workflow: broken() }]),
    op('update writes .yaml beside a .yml', [project('feature.yml'), { call: 'update', name: 'feature', workflow: edited() }]),
    op('create then update', [{ call: 'create', name: 'made' }, { call: 'update', name: 'made', workflow: wf() }]),
    op('delete .yaml', [project('a.yaml'), { call: 'delete', name: 'a' }, { call: 'delete', name: 'a' }]),
    op('delete .yml', [project('a.yml'), { call: 'delete', name: 'a' }]),
    op('delete prefers .yaml', [project('a.yaml'), project('a.yml'), { call: 'delete', name: 'a' }]),
    op('delete leaves the other scope', [project('a.yaml'), global('a.yaml'), { call: 'delete', name: 'a' }]),
    op('delete in the global scope', [global('a.yaml'), { call: 'delete', name: 'a', scope: 'global' }]),
    op('delete refuses a bad name', [{ call: 'delete', name: 'a/b' }]),
    op('clone', [project('feature.yaml'), { call: 'clone', name: 'feature', to: 'copy' }]),
    op('clone from .yml', [project('feature.yml'), { call: 'clone', name: 'feature', to: 'copy' }]),
    op('clone onto an existing name', [project('feature.yaml'), project('copy.yaml', 'name: keep\nsteps: []\n'), { call: 'clone', name: 'feature', to: 'copy' }]),
    op('clone a missing workflow', [{ call: 'clone', name: 'gone', to: 'copy' }]),
    op('clone an invalid workflow', [project('bad.yaml', 'name: bad\nsteps: 3\n'), { call: 'clone', name: 'bad', to: 'copy' }]),
    op('clone in the global scope', [global('feature.yaml'), { call: 'clone', name: 'feature', to: 'copy', scope: 'global' }]),
    op('clone refuses a bad target name', [project('feature.yaml'), { call: 'clone', name: 'feature', to: '' }]),
  ];
}

// ------------------------------------------------ workspace identity matching

/**
 * Only cases whose answer is the same on every host: Windows-shaped paths
 * fold case everywhere, but a POSIX path folds case only on a Windows host.
 */
function workspaceOps(): Op[] {
  const ref = (path: string, identityKey?: string): Record<string, string> =>
    (identityKey === undefined ? { path } : { path, identityKey });
  const pairs: Array<[Record<string, string>, Record<string, string>]> = [
    [ref('/w/a'), ref('/w/a')],
    [ref('/w/a'), ref('/w/b')],
    [ref('/w/a/./x/..'), ref('/w/a')],
    [ref('/w/a/'), ref('/w/a')],
    [ref('C:\\W\\A'), ref('c:/w/a')],
    [ref('C:\\W\\A', 'k1'), ref('c:/w/a', 'k2')],
    [ref('/w/a', 'k1'), ref('/w/b', 'k1')],
    [ref('/w/a', 'k1'), ref('/w/a')],
    [ref('/w/a'), ref('/w/b', 'k1')],
    [ref('\\\\server\\share\\x'), ref('//SERVER/share/x')],
  ];
  const ops: Op[] = pairs.map(([a, b]) => ({ op: 'sameWorkspace', a, b }));
  const records: Array<[string, Record<string, string>]> = [
    ['/w/a', {}], ['C:\\W\\B', {}], ['/w/c', { identityKey: 'kc' }], ['/w/d', { identityKey: 'kd' }],
  ];
  for (const workspace of [
    ref('/w/a'), ref('c:/w/b'), ref('/elsewhere', 'kc'), ref('/w/c'), ref('/w/d', 'other'), ref('/nope'),
  ]) ops.push({ op: 'findWorkspaceKey', records, workspace });
  return ops;
}

// ------------------------------------------------------------ model listings

function modelOps(): Op[] {
  const fixture = (name: string) => readFileSync(path.join(REPO, 'parity/fixtures/models', name), 'utf8');
  const reply = (response: unknown) => JSON.stringify({ type: 'control_response', response });
  const ok = (models: unknown) => reply({ request_id: 'req_1', subtype: 'success', response: { models, account: { email: 'x@y' } } });
  const ops: Op[] = [];
  for (const line of [
    '', 'not json', '[]', JSON.stringify({ type: 'system' }), reply('x'), reply({ request_id: 'req_2', response: { models: [] } }),
    reply({ request_id: 'req_1', response: { models: 'no' } }), reply({ request_id: 'req_1' }), ok([]),
    ok([{ value: 'default', displayName: 'Default', description: 'Use the default', resolvedModel: 'claude-x' },
      { value: 'sonnet' }, { value: 3 }, 'str', null, { displayName: 'no value' },
      { value: 'opus[1m]', displayName: 7, description: null }]),
  ]) ops.push({ op: 'parseInitializeReply', line });
  for (const ids of [[], ['sonnet'], ['default', 'opus', 'sonnet', 'haiku', 'fable', 'opusplan'], ['x', 'haiku']]) {
    ops.push({ op: 'mergeWithAliases', live: ids.map(id => ({ id, label: id.toUpperCase() })) });
  }
  for (const output of [
    '', 'opencode/big-pickle\nmistral/codestral-latest\n', '\n  \nModels:\nbare-name\nprovider/model\n',
    'a/b/c\n/x\nx/\na b/c\n\ta/b\t\r\n', fixture('opencode-models.txt'),
  ]) ops.push({ op: 'parseOpencodeModels', output });
  for (const help of [
    '', 'Configuration Settings:\n\n  `logLevel`: ...\n', '  `model`: AI model to use.\n\n  `contextTier`: ...\n',
    '  `model`: m\n    - "a"\n    -"b"\n    - c\n    - ""\n  - "d" trailing\r\n\n    - "e"\n',
    fixture('copilot-help-config.txt'),
  ]) ops.push({ op: 'parseCopilotModels', help });
  return ops;
}
