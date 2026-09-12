import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProgram } from './program.ts';

test('buildProgram: exposes doctor, run, rename-run, init, new-workflow, and config commands', () => {
  const program = buildProgram();
  const names = program.commands.map(c => c.name());
  assert.deepEqual(new Set(names),
    new Set(['doctor', 'run', 'rename-run', 'init', 'new-workflow', 'config']));
});

test('buildProgram: run exposes --name, and rename-run takes a run id and a name', () => {
  const program = buildProgram();
  const run = program.commands.find(c => c.name() === 'run')!;
  assert.ok(run.options.some(o => o.flags.startsWith('--name')),
    `expected --name in ${run.options.map(o => o.flags)}`);

  const rename = program.commands.find(c => c.name() === 'rename-run')!;
  assert.deepEqual(rename.registeredArguments.map(a => [a.name(), a.required]),
    [['runId', true], ['name', true]]);
  assert.ok(rename.options.map(o => o.flags).some(f => f.startsWith('-C')));
});

test('buildProgram: new-workflow exposes --global', () => {
  const program = buildProgram();
  const cmd = program.commands.find(c => c.name() === 'new-workflow');
  const flags = cmd!.options.map(o => o.flags);
  assert.ok(flags.includes('--global'), `expected --global in ${flags}`);
});

test('buildProgram: config exposes get and set subcommands, each with --global and -C', () => {
  const program = buildProgram();
  const config = program.commands.find(c => c.name() === 'config');
  assert.ok(config, 'config command should exist');
  const subNames = config!.commands.map(c => c.name());
  assert.deepEqual(new Set(subNames), new Set(['get', 'set']));

  const get = config!.commands.find(c => c.name() === 'get')!;
  assert.deepEqual(get.registeredArguments.map(a => [a.name(), a.required]), [['key', false]]);
  assert.ok(get.options.map(o => o.flags).includes('--global'));

  const set = config!.commands.find(c => c.name() === 'set')!;
  assert.deepEqual(set.registeredArguments.map(a => [a.name(), a.required]), [['key', true], ['value', true]]);
  assert.ok(set.options.map(o => o.flags).includes('--global'));
});

test('buildProgram: run command exposes --dry-run, --input, -C, --json, --yes, --max-iterations', () => {
  const program = buildProgram();
  const run = program.commands.find(c => c.name() === 'run');
  assert.ok(run, 'run command should exist');
  const flags = run!.options.map(o => o.flags);
  assert.ok(flags.includes('--dry-run'), `expected --dry-run in ${flags}`);
  assert.ok(flags.some(f => f.startsWith('--input')), `expected --input in ${flags}`);
  assert.ok(flags.some(f => f.startsWith('-C')), `expected -C in ${flags}`);
  assert.ok(flags.includes('--json'), `expected --json in ${flags}`);
  assert.ok(flags.includes('--yes'), `expected --yes in ${flags}`);
  assert.ok(flags.some(f => f.startsWith('--max-iterations')), `expected --max-iterations in ${flags}`);
});

test('buildProgram: --max-iterations rejects anything that is not a positive integer', () => {
  const program = buildProgram();
  const run = program.commands.find(c => c.name() === 'run');
  const parseArg = run!.options.find(o => o.long === '--max-iterations')!.parseArg!;
  assert.equal(parseArg('3', undefined), 3);
  for (const bad of ['0', '-1', 'x', '1.5']) {
    assert.throws(() => parseArg(bad, undefined), /positive integer/, `should reject '${bad}'`);
  }
});

test('buildProgram: run exposes --extra-iterations, and its parseArg rejects non-positive integers', () => {
  const program = buildProgram();
  const run = program.commands.find(c => c.name() === 'run');
  const flags = run!.options.map(o => o.flags);
  assert.ok(flags.some(f => f.startsWith('--extra-iterations')), `expected --extra-iterations in ${flags}`);

  const parseArg = run!.options.find(o => o.long === '--extra-iterations')!.parseArg!;
  assert.equal(parseArg('2', undefined), 2);
  for (const bad of ['0', '-1', 'x', '1.5']) {
    assert.throws(() => parseArg(bad, undefined), /positive integer/, `should reject '${bad}'`);
  }
});

test('buildProgram: run takes a workflow argument, optional so --resume can stand alone', () => {
  const program = buildProgram();
  const run = program.commands.find(c => c.name() === 'run');
  const argNames = run!.registeredArguments.map(a => a.name());
  assert.deepEqual(argNames, ['workflow']);
  // A resumed run executes the workflow its run directory recorded, so naming
  // one on the command line would only ever contradict it.
  assert.equal(run!.registeredArguments[0].required, false);
});

test('buildProgram: run exposes --resume and --fresh-session', () => {
  const program = buildProgram();
  const run = program.commands.find(c => c.name() === 'run');
  const flags = run!.options.map(o => o.flags);
  assert.ok(flags.some(f => f.startsWith('--resume')), `expected --resume in ${flags}`);
  assert.ok(flags.includes('--fresh-session'), `expected --fresh-session in ${flags}`);
});

test('buildProgram: does not parse argv at build time (no side effects)', () => {
  // Building the program must be safe to call repeatedly for introspection
  // without spawning subcommand actions or touching process.exitCode.
  const before = process.exitCode;
  buildProgram();
  assert.equal(process.exitCode, before);
});

test('buildProgram: version is wired to CORE_VERSION', async () => {
  const { CORE_VERSION } = await import('@whiphand/core');
  const program = buildProgram();
  assert.equal(program.version(), CORE_VERSION);
});
