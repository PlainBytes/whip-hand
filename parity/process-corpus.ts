/**
 * The process-layer suites of the core parity corpus (Phase 2b of
 * docs/migration.md), generated like the rest of core-corpus.ts:
 *
 * - `process`: Windows argv quoting and the cmd.exe wrapper, launch planning
 *   against a fixture PATH of npm, pnpm, native and unreadable shims, shell
 *   discovery near git, CRLF folding, headless routing, and the git guard's
 *   failure classification and status-line parsing.
 * - `globs`: `path.matchesGlob`, as `allow_paths` uses it, on POSIX and
 *   win32: every pattern below against every path below. Nothing here
 *   differs only by case: Node folds case on a macOS or Windows *host*
 *   whichever flavor is asked for, so such a case has no one golden.
 */
type Op = Record<string, unknown> & { op: string };

const TREE = 'parity/fixtures/core/trees/exec';
const dirs = (...names: string[]): string[] => names.map(n => `${TREE}/${n}`);

const QUOTE_ARGS = [
  '', 'plain', 'two words', 'tab\there', 'a"b', 'a\\"b', 'trailing\\', 'trail space\\', 'C:\\Program Files\\x\\',
  '\\\\server\\share', 'amp&ersand', 'pipe|it', '<in>', 'caret^', '(paren)', '%PATH%', 'bang!', 'ünï 🚀',
  'a\\\\b', '"', '\\', ' ', 'nbsp\u00a0here', 'line\nbreak',
];

function processOps(): Op[] {
  const ops: Op[] = QUOTE_ARGS.map(arg => ({ op: 'msvcrtQuote', arg }));
  const cmd = (file: string, args: string[], env: Record<string, string> = {}): Op =>
    ({ op: 'cmdInvocation', file, args, env });
  ops.push(
    cmd('C:\\tools\\x.cmd', ['-p', 'two words', '%HOME%']),
    cmd('C:\\Program Files\\x.cmd', ['a!b'], { COMSPEC: 'C:\\Windows\\system32\\cmd.exe' }),
    cmd('x.cmd', [], { ComSpec: 'C:\\My Shell\\cmd.exe' }),
    cmd('x.cmd', ['multi\nline prompt that goes on and on and on and on and on and on and on and on']),
    cmd('x.cmd', ['carriage\rreturn']),
    cmd('x.cmd', ['"quoted" & more']),
    cmd('x.cmd', ['"quoted" but safe']),
    cmd('x.cmd', ['x'.repeat(8160)]),
    cmd('x.cmd', ['x'.repeat(8180)]),
    cmd('x.cmd', ['é'.repeat(4000)]),
  );
  const plan = (argv: string[], ds: string[], env: Record<string, string> = {}): Op =>
    ({ op: 'planLaunch', argv, dirs: ds, env });
  ops.push(
    plan(['claude', '-p', 'a prompt\nwith lines'], dirs('npm', 'nodebin')),
    plan(['claude', '-p', 'x'], dirs('native', 'npm', 'nodebin')),
    plan(['claude', '-p', 'x'], dirs('npm', 'native', 'nodebin')),
    plan(['claude', '-p', 'x'], dirs('npm')),
    plan(['CLAUDE.CMD', 'x'], dirs('npm', 'nodebin')),
    plan(['claude', 'x'], dirs('npm', 'native'), { PATHEXT: '.EXE;.CMD' }),
    plan(['claude', 'x'], dirs('npm', 'native'), { PATHEXT: '.CMD;.EXE' }),
    plan(['copilot', 'two words', '%X%'], dirs('npm', 'nodebin')),
    plan(['copilot', '"a" & b'], dirs('npm', 'nodebin')),
    plan(['opencode', 'run', 'x'], dirs('pnpm')),
    plan(['hand', 'arg'], dirs('bad')),
    plan(['tool'], dirs('native')),
    plan(['git', 'status'], dirs('native')),
    plan(['missing', 'x'], dirs('native', 'npm')),
    plan(['./relative/run.cmd', 'x'], dirs('native')),
    plan(['C:\\abs\\run.exe', 'x'], dirs('native')),
  );
  const shell = (git: string | undefined, existing: string[], env: Record<string, string> = {}): Op =>
    ({ op: 'resolveShell', ...(git === undefined ? {} : { git }), existing, env });
  ops.push(
    shell('C:\\Program Files\\Git\\cmd\\git.exe', ['C:\\Program Files\\Git\\usr\\bin\\sh.exe', 'C:\\Program Files\\Git\\bin\\bash.exe']),
    shell('C:\\Program Files\\Git\\cmd\\git.exe', ['C:\\Program Files\\Git\\bin\\bash.exe']),
    shell('C:\\Git\\mingw64\\bin\\git.exe', ['C:\\Git\\usr\\bin\\sh.exe']),
    shell('C:\\Git\\cmd\\git.exe', [], { ProgramFiles: 'D:\\Apps' }),
    shell('C:\\Git\\cmd\\git.exe', ['D:\\Apps\\Git\\bin\\sh.exe'], { ProgramFiles: 'D:\\Apps', 'ProgramFiles(x86)': '' }),
    shell('git', [], {}),
    shell('C:\\Windows\\System32\\git.exe', ['C:\\Windows\\System32\\bash.exe', 'C:\\Windows\\bin\\bash.exe']),
    shell(undefined, ['C:\\x\\usr\\bin\\sh.exe'], { PATH: '' }),
  );
  for (const p of ['C:\\Windows\\System32\\bash.exe', 'c:/windows/SYSNATIVE/bash.exe', 'C:\\Git\\bin\\bash.exe', '\\SysWOW64\\bash.exe', 'system32\\bash.exe']) {
    ops.push({ op: 'isWslLauncher', path: p });
  }
  for (const chunks of [['a\r\nb'], ['a\r', '\nb'], ['a\r'], ['\r', '\r', '\n'], ['x\ry\r\n\r\n'], [], ['é\r\n😀']]) {
    ops.push({ op: 'crlfToLf', chunks });
  }
  const route = (spec: Record<string, unknown>, hasLineReader: boolean): Op =>
    ({ op: 'routeHeadless', spec: { argv: [], cwd: '.', env: {}, interactive: false, ...spec }, hasLineReader });
  for (const reader of [true, false]) {
    ops.push(
      route({}, reader),
      route({ capture: { path: 'out.log' } }, reader),
      route({ capture: { path: 'out.log', streams: 'stdout' } }, reader),
      route({ progress: { format: 'claude-stream-json' } }, reader),
      route({ progress: { format: 'copilot-jsonl' }, capture: { path: 'o' } }, reader),
      route({ progress: { format: 'opencode-json' }, capture: { path: 'o', streams: 'stdout' } }, reader),
    );
  }
  const git = (code: number | string | null, stderr: string, message: string): Op =>
    ({ op: 'classifyGitFailure', code, stderr, message });
  ops.push(
    git(128, 'fatal: not a git repository (or any of the parent directories): .git\n', 'Command failed'),
    git(128, 'fatal: NOT A GIT REPOSITORY', 'x'),
    git(128, "fatal: detected dubious ownership in repository at '/w'\nTo add an exception…", 'Command failed: git status'),
    git(1, 'fatal: not a git repository', 'x'),
    git(1, '', 'Command failed: git rev-parse HEAD\n'),
    git('ENOENT', '', 'spawn git ENOENT'),
    git(null, '  \n', 'Command failed: git status\nsecond line'),
    git('ERR_CHILD_PROCESS_STDIO_MAXBUFFER', '', 'stdout maxBuffer length exceeded'),
  );
  ops.push(
    { op: 'diffSnapshots', before: '', after: ' M a.ts\n?? b.ts' },
    { op: 'diffSnapshots', before: ' M a.ts', after: ' M a.ts\n?? b.ts\n\n?? .whiphand/runs/x/run.json' },
    { op: 'diffSnapshots', before: '?? b.ts', after: 'R  old.ts -> new/.whiphand/x\n?? whiphand.md\n?? sub/.whiphand-not/x\n M b.ts' },
    { op: 'pathsFromStatusLines', lines: [' M a.ts', 'R  old name.ts -> new name.ts', '?? "quoted path"', 'A  dir/', 'M', ' -> x -> y'] },
  );
  return ops;
}

const GLOB_PATTERNS = [
  '**', '*', '**/*', '**/*.ts', '*.ts', 'src/**', 'src/*', 'src/**/*.ts', 'src/**/test/*.ts', 'a/**/b',
  '**/a', '**/**/a', '.*', '.github/**', '**/.github/**', 'src/*.{ts,tsx}', '{src,lib}/**', '{a,b,}', '{,a}/x',
  'a{1..3}', 'x{a..c}y', 'f{01..10..3}', 'x{}y', '{x}', '{a,{b,c}}d', 'a/{b,c/d}/e', '${a,b}',
  '?', '??', 'a?c', '[abc]', '[!a]*', '[^a]*', '[a-c]x', '[]a]', '[a-]', '[[:alpha:]]*', '[[:digit:]]',
  '@(a|b)', '?(a)b', '*(a)', '+(ab)', '!(a)', '!(a|b).ts', 'a!(b)c', '!(*.md)', '@(*.ts|*.js)', 'x/!(y)/z',
  'a/./b', 'a/../b', './a', 'a//b', 'a/b/', '/abs/**', '', 'a\\b', 'a\\*', '#comment', '!negated',
  'docs/**/*.md', 'packages/*/src/**', '**/node_modules/**', '**/*.min.*', 'café/*', '😀', '?.md',
];

const GLOB_PATHS = [
  '', 'a', 'b', 'c', 'ab', 'abc', 'abbc', 'ac', 'aab', 'abab', 'x', '.a', '.x', 'a.ts', 'b.ts', 'c.ts',
  'a.md', 'x.md', 'readme.md', 'a.min.js', 'src', 'src/a.ts', 'src/a.tsx', 'src/.env', 'src/x/test/b.ts',
  'lib/x.js', 'a/b', 'a/c', 'a/x/b', 'a/b/c', 'a/b/e', 'a/c/d/e', 'a/./b', 'a/../b', './a', 'a//b',
  'a/b/', 'x/y/z', 'x/a/z', '.github/workflows/ci.yml', 'pkg/.github/x', 'docs/a/b.md', 'docs/.hidden/c.md',
  'packages/core/src/x.ts', 'node_modules/x/y', 'a/node_modules/z', '/abs/x', 'a1', 'a2', 'a4', 'xay', 'xdy',
  'f01', 'f04', 'f10', 'x{}y', '{x}', 'ad', 'bd', 'd', 'a/b/e', 'a/c/d/e', 'a,b', '1', '-', ']', 'café/x',
  '😀', 'é.md', '#comment', '!negated', 'a\\b', '$a', '${a,b}',
];

function globOps(): Op[] {
  const ops: Op[] = [];
  for (const windows of [false, true]) {
    for (const pattern of GLOB_PATTERNS) ops.push({ op: 'matchesGlob', windows, pattern, paths: GLOB_PATHS });
  }
  return ops;
}

export const PROCESS_SUITES: Record<string, () => Op[]> = {
  process: processOps,
  globs: globOps,
};
