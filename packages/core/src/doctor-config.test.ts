import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globalDoctorConfigPath, loadDoctorConfig } from './doctor-config.ts';
import { WorkflowError } from './schema.ts';

/** Writes a doctor.yaml into a throwaway dir and returns its path. */
async function withFile(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-doctor-'));
  const path = join(dir, 'doctor.yaml');
  await writeFile(path, body, 'utf8');
  return path;
}

async function problemsOf(body: string): Promise<string[]> {
  const path = await withFile(body);
  try {
    await loadDoctorConfig(path);
  } catch (e) {
    assert.ok(e instanceof WorkflowError, `expected a WorkflowError, got ${String(e)}`);
    // Every problem names the file: one global file breaks doctor on every
    // workspace, and the message has to say which file to go and fix.
    for (const problem of e.problems) assert.ok(problem.startsWith(`${path}: `), problem);
    return e.problems;
  }
  return assert.fail(`expected ${JSON.stringify(body)} to be rejected`);
}

test('lives beside config.yaml, under the same config home', () => {
  const path = globalDoctorConfigPath({ WHIPHAND_CONFIG_HOME: '/cfg' }, 'linux', '/home/u');
  assert.equal(path, join('/cfg', 'doctor.yaml'));
});

test('a missing file is an empty config, not an error', async () => {
  assert.deepEqual(await loadDoctorConfig(join(tmpdir(), 'whiphand-doctor-nonexistent', 'doctor.yaml')), {});
});

test('an empty file is an empty config', async () => {
  assert.deepEqual(await loadDoctorConfig(await withFile('')), {});
});

test('round-trips a tool table, mapping version_pattern to versionPattern', async () => {
  const config = await loadDoctorConfig(await withFile(`
tools:
  - id: bun
    label: Bun
    group: support
    argv: [bun, --version]
    aliases: [bun-canary]
    version_pattern: 'v?(\\d+\\.\\d+\\.\\d+)'
    optional: false
    url: https://bun.sh
hide: [jq, cursor-agent]
`));

  assert.deepEqual(config, {
    tools: [{
      id: 'bun', label: 'Bun', group: 'support',
      argv: ['bun', '--version'], aliases: ['bun-canary'],
      versionPattern: 'v?(\\d+\\.\\d+\\.\\d+)', optional: false, url: 'https://bun.sh',
    }],
    hide: ['jq', 'cursor-agent'],
  });
});

test('a tool without version_pattern carries no versionPattern key at all', async () => {
  const config = await loadDoctorConfig(await withFile(
    'tools: [{ id: bun, label: Bun, group: support, argv: [bun, --version] }]'));
  assert.ok(!('versionPattern' in config.tools![0]));
});

test('hide alone is a valid file', async () => {
  assert.deepEqual(await loadDoctorConfig(await withFile('hide: [jq]')), { hide: ['jq'] });
});

test('an unknown key is rejected rather than silently ignored', async () => {
  // Strict on purpose: nothing writes this file, so nothing depends on keys
  // being stripped, and a misspelled `argvs:` that quietly does nothing is a
  // worse experience than being told.
  const problems = await problemsOf(
    'tools: [{ id: bun, label: Bun, group: support, argv: [bun], argvs: [x] }]');
  assert.ok(problems.some(p => p.includes('argvs')), problems.join('\n'));
});

test('an unknown TOP-LEVEL key is rejected too', async () => {
  await problemsOf('toolz: []');
});

test('an invalid group names the offending path', async () => {
  const problems = await problemsOf(
    'tools: [{ id: bun, label: Bun, group: gadgets, argv: [bun] }]');
  assert.ok(problems.some(p => p.includes('tools.0.group')), problems.join('\n'));
});

test('an id with whitespace is rejected', async () => {
  // The CLI report is parsed column-wise with \S+; an id with a space would
  // split one row into two and desync the CLI from the RPC.
  const problems = await problemsOf(
    'tools: [{ id: "my tool", label: T, group: support, argv: [t] }]');
  assert.ok(problems.some(p => p.includes('tools.0.id')), problems.join('\n'));
});

test('an empty argv is rejected — there would be nothing to run', async () => {
  await problemsOf('tools: [{ id: bun, label: Bun, group: support, argv: [] }]');
});

test('an uncompilable version_pattern is a named config error, not a throw at probe time', async () => {
  const problems = await problemsOf(
    'tools: [{ id: bun, label: Bun, group: support, argv: [bun], version_pattern: "([" }]');
  assert.ok(problems.some(p => p.includes('tools.bun.version_pattern')), problems.join('\n'));
});

test('a YAML syntax error is wrapped as a WorkflowError naming the file', async () => {
  // Unwrapped this escapes as a raw YAMLParseError and bypasses every caller
  // that knows how to render a config problem.
  await problemsOf('tools: [unclosed');
});
