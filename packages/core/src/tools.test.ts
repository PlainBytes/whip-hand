import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdapterRegistry, defaultRegistry } from './registry.ts';
import { WorkflowError } from './schema.ts';
import type { DetectResult, RunnerAdapter, RunnerDoctor, SpawnSpec } from './types.ts';
import {
  BUILTIN_SUPPORT_TOOLS, detectTools, ghAuthCheck, isOlderVersion, parseToolVersion, probeRunner, probeTool,
  resolveToolTable,
} from './tools.ts';
import type { ToolProbe } from './tools.ts';

function fakeAdapter(
  id: string, detect: () => Promise<DetectResult>, doctor: Partial<RunnerDoctor> = {},
): RunnerAdapter {
  const spec: SpawnSpec = { argv: [id], cwd: '/', env: {}, interactive: false };
  return {
    id,
    doctor: { label: id, argv: [id, '--version'], optional: true, ...doctor },
    capabilities: { sessionIdInjection: false, sessionIdCapture: false, sessionResume: false, toolDenial: false, shareTranscript: false },
    detect,
    interactive: () => spec, headless: () => spec, harvest: () => spec,
  };
}

function registryOf(...adapters: RunnerAdapter[]): AdapterRegistry {
  const reg = new AdapterRegistry();
  for (const adapter of adapters) reg.register(adapter);
  return reg;
}

const probe = (over: Partial<ToolProbe> & Pick<ToolProbe, 'id'>): ToolProbe => ({
  label: over.id, group: 'support', argv: [over.id, '--version'], ...over,
});

// ---------------------------------------------------------------------------
// parseToolVersion — every string below was captured from the real binary.
// ---------------------------------------------------------------------------

test('parses the version out of each tool’s actual --version output', () => {
  const cases: [string, string | undefined][] = [
    ['git version 2.53.0', '2.53.0'],
    ['v24.16.0', '24.16.0'],                        // node prefixes a v
    ['11.13.0', '11.13.0'],                         // npm prints the bare number
    ['rtk 0.42.4', '0.42.4'],
    ['Python 3.14.4', '3.14.4'],
    ['jq-1.8.1', '1.8.1'],                          // hyphen, not space
    ['jq-1.6', '1.6'],                              // older jq: only two components
    ['2.1.263 (Claude Code)', '2.1.263'],
    ['fd 10.2.0', '10.2.0'],
    ['2025.08.28-8d9dd2c', '2025.08.28-8d9dd2c'],   // a dated build + hash
    ['gh version 2.86.0-112-gc30647b78 (2026-02-14)', '2.86.0-112-gc30647b78'], // gh; the date stays out
    ['ast-grep 0.28.1', '0.28.1'],
    ['yq (https://github.com/mikefarah/yq/) version v4.53.6', '4.53.6'], // the URL has no digits to win
    ['uv 0.12.6 (7938ca5d5 2026-08-25 x86_64-unknown-linux-gnu)', '0.12.6'],
    ['Universal Ctags 6.2.1, Copyright (C) 2015-2025 Universal Ctags Team', '6.2.1'], // not the copyright years
    ['scc version 3.7.0', '3.7.0'],
    ['tokei 14.0.0 compiled with serialization support: json, cbor, yaml', '14.0.0'],
    ['no numbers here', undefined],
  ];
  for (const [output, expected] of cases) {
    assert.equal(parseToolVersion(output), expected, `parsing ${JSON.stringify(output)}`);
  }
});

test('a tool whose version is on line 2 reports none rather than the wrong thing', () => {
  // shellcheck is not a row for exactly this reason: `--version` opens with its
  // tagline and puts `version: 0.11.0` second, and only line 1 is searched.
  assert.equal(parseToolVersion('ShellCheck - shell script analysis tool\nversion: 0.11.0\nlicense: GPL-3'), undefined);
});

test('copilot’s trailing sentence period is not swallowed into the version', () => {
  // `(?:\.\d+)*` requires a digit after each dot, which is what stops this.
  assert.equal(parseToolVersion('GitHub Copilot CLI 1.0.83.'), '1.0.83');
});

test('Git-for-Windows’ four-part build stops at the semver', () => {
  assert.equal(parseToolVersion('git version 2.45.0.windows.1'), '2.45.0');
});

test('only the first line is searched, so a bundled library cannot win', () => {
  // `rg --version` really does print this. Searching the whole output would
  // report PCRE2's version for a tool whose own line lacked a number.
  const rg = 'ripgrep 15.1.0\n\nfeatures:+pcre2\nPCRE2 10.43 is available';
  assert.equal(parseToolVersion(rg), '15.1.0');
});

test('stderr is a fallback for an empty stdout, never a second haystack', () => {
  assert.equal(parseToolVersion('', 'tool 1.2.3'), '1.2.3');
  // npm's update notifier writes to stderr; a real answer on stdout must win.
  assert.equal(parseToolVersion('11.13.0', 'npm 9.0.0 is available'), '11.13.0');
});

test('a custom pattern overrides the default rule', () => {
  assert.equal(parseToolVersion('build 2024w31', undefined, 'build (\\w+)'), '2024w31');
});

// ---------------------------------------------------------------------------
// resolveToolTable — merge, override, registry sweep, hide
// ---------------------------------------------------------------------------

const ids = (table: ToolProbe[], group: ToolProbe['group']): string[] =>
  table.filter(t => t.group === group).map(t => t.id);

test('with no adapters and no config the table is the support built-ins alone', () => {
  const table = resolveToolTable(registryOf());
  assert.deepEqual(table.map(t => t.id), BUILTIN_SUPPORT_TOOLS.map(t => t.id));
  assert.ok(table.every(t => t.group === 'support'));
});

test('the harness group is exactly the registry, in registration order, ahead of the support rows', () => {
  const registry = defaultRegistry();
  const table = resolveToolTable(registry);
  assert.deepEqual(ids(table, 'harness'), registry.list().map(a => a.id));
  assert.deepEqual(ids(table, 'harness'), ['claude', 'copilot', 'opencode']);
  assert.deepEqual(table.slice(0, 3).map(t => t.group), ['harness', 'harness', 'harness'], 'harness rows come first');
  for (const gone of ['codex', 'gemini', 'cursor-agent']) {
    assert.ok(!table.some(t => t.id === gone), `${gone} has no adapter, so it is not a harness`);
  }
});

test('each harness row carries its adapter’s own label, url and required-ness', () => {
  const by = new Map(resolveToolTable(defaultRegistry()).map(t => [t.id, t]));
  assert.equal(by.get('claude')?.label, 'Claude Code');
  assert.equal(by.get('claude')?.url, 'https://claude.com/claude-code');
  assert.equal(by.get('claude')?.optional, false);
  assert.equal(by.get('copilot')?.label, 'GitHub Copilot CLI');
  assert.equal(by.get('copilot')?.optional, false);
  assert.equal(by.get('opencode')?.label, 'opencode');
  assert.equal(by.get('opencode')?.optional, true);
});

test('a newly registered adapter appears with its own label and url, not just its id', () => {
  const table = resolveToolTable(registryOf(fakeAdapter(
    'newbie', async () => ({ installed: true }),
    { label: 'Newbie CLI', url: 'https://example.com/newbie', optional: false },
  )));
  const added = table.find(t => t.id === 'newbie');
  assert.equal(added?.group, 'harness');
  assert.equal(added?.label, 'Newbie CLI');
  assert.equal(added?.url, 'https://example.com/newbie');
  assert.equal(added?.optional, false);
});

test('the agent-productivity tools are optional support rows, ordered after the original built-ins', () => {
  const table = resolveToolTable(registryOf());
  const added = ['gh', 'ast-grep', 'yq', 'uv', 'ctags', 'scc'];
  assert.deepEqual(table.slice(-added.length).map(t => t.id), added);
  assert.deepEqual(table.slice(0, 8).map(t => t.id), ['git', 'node', 'npm', 'python', 'rtk', 'rg', 'fd', 'jq']);
  for (const id of added) {
    const row = table.find(t => t.id === id);
    assert.equal(row?.group, 'support', id);
    assert.equal(row?.optional ?? true, true, `${id} is optional: a missing one is ○, never ✘`);
    assert.match(row?.url ?? '', /^https:\/\//, `${id} links somewhere`);
  }
  assert.equal(table.find(t => t.id === 'yq')?.url, 'https://github.com/mikefarah/yq');
  assert.deepEqual(table.find(t => t.id === 'ctags')?.aliases, ['uctags']);
  assert.deepEqual(table.find(t => t.id === 'scc')?.aliases, ['tokei']);
  assert.equal(table.find(t => t.id === 'ast-grep')?.aliases, undefined, 'sg is shadow-utils on Linux');
  assert.ok(!table.some(t => t.id === 'shellcheck'), 'shellcheck needs a versionLine knob, so it is not a row');
});

test('a user tool with a new id is appended', () => {
  const table = resolveToolTable(registryOf(), { tools: [probe({ id: 'bun' })] });
  assert.equal(table.at(-1)?.id, 'bun');
  assert.equal(table.length, BUILTIN_SUPPORT_TOOLS.length + 1);
});

test('a user tool reusing a built-in id replaces it IN PLACE', () => {
  const at = BUILTIN_SUPPORT_TOOLS.findIndex(t => t.id === 'rtk');
  const table = resolveToolTable(registryOf(), {
    tools: [probe({ id: 'rtk', label: 'RTK', argv: ['rtk', 'version'], optional: false })],
  });

  // Position is the point: tweaking one probe must not reshuffle the report.
  assert.equal(table.length, BUILTIN_SUPPORT_TOOLS.length);
  assert.equal(table[at].id, 'rtk');
  assert.deepEqual(table[at].argv, ['rtk', 'version']);
  assert.equal(table[at].label, 'RTK');
});

test('a doctor.yaml override of a registry id changes its presentation in place, and nothing else', () => {
  const registry = defaultRegistry();
  const before = resolveToolTable(registry);
  const table = resolveToolTable(registry, {
    tools: [probe({
      id: 'claude', label: 'Claude!', group: 'harness', argv: ['never', 'run'],
      optional: true, url: 'https://example.com/claude',
    })],
  });
  const at = before.findIndex(t => t.id === 'claude');
  assert.equal(table.length, before.length);
  assert.equal(table[at].id, 'claude');
  assert.equal(table[at].label, 'Claude!');
  assert.equal(table[at].optional, true);
  assert.equal(table[at].url, 'https://example.com/claude');
  assert.equal(table[at].group, 'harness');
  assert.deepEqual(table[at].argv, ['claude', '--version'], 'the adapter owns how it is probed');
});

test('an override that leaves url and optional out keeps the adapter’s', () => {
  const table = resolveToolTable(defaultRegistry(), {
    tools: [probe({ id: 'claude', label: 'Claude!', group: 'harness' })],
  });
  const claude = table.find(t => t.id === 'claude');
  assert.equal(claude?.url, 'https://claude.com/claude-code');
  assert.equal(claude?.optional, false);
});

test('a doctor.yaml harness entry with an unknown id is rejected, naming the file and the id', () => {
  assert.throws(
    () => resolveToolTable(defaultRegistry(), { tools: [probe({ id: 'codex', group: 'harness' })] }),
    (e: unknown) => {
      assert.ok(e instanceof WorkflowError);
      assert.match(e.message, /doctor\.yaml/);
      assert.match(e.message, /codex/);
      assert.match(e.message, /group 'harness' is reserved for registered runners \(claude, copilot, opencode\)/);
      return true;
    },
  );
});

test('every unknown harness entry is reported, not just the first', () => {
  assert.throws(
    () => resolveToolTable(defaultRegistry(), {
      tools: [probe({ id: 'codex', group: 'harness' }), probe({ id: 'gemini', group: 'harness' })],
    }),
    (e: unknown) => e instanceof WorkflowError && /codex/.test(e.message) && /gemini/.test(e.message),
  );
});

test('an unknown id in the support group is still just an appended support tool', () => {
  const table = resolveToolTable(defaultRegistry(), { tools: [probe({ id: 'codex', group: 'support' })] });
  assert.equal(table.at(-1)?.id, 'codex');
  assert.equal(table.at(-1)?.group, 'support');
});

test('hide is applied last, so it can remove a registered adapter too', () => {
  const table = resolveToolTable(
    registryOf(fakeAdapter('newbie', async () => ({ installed: true }))),
    { hide: ['jq', 'newbie'] },
  );
  assert.ok(!table.some(t => t.id === 'jq'));
  assert.ok(!table.some(t => t.id === 'newbie'), 'hiding must beat the registry rows');
});

test('hide: [opencode] hides that harness and only that one', () => {
  const table = resolveToolTable(defaultRegistry(), { hide: ['opencode'] });
  assert.deepEqual(ids(table, 'harness'), ['claude', 'copilot']);
});

// ---------------------------------------------------------------------------
// detectTools
// ---------------------------------------------------------------------------

/** Reports everything installed, so rows are distinguished by their metadata. */
const allInstalled = async (p: ToolProbe): Promise<DetectResult> =>
  ({ installed: true, version: `${p.id}-1.0.0` });

test('runner is true only for ids the registry actually has', async () => {
  const rows = await detectTools(
    registryOf(fakeAdapter('claude', async () => ({ installed: true }))),
    {}, { probe: allInstalled },
  );
  const by = new Map(rows.map(r => [r.id, r]));
  assert.equal(by.get('claude')?.runner, true);
  assert.equal(by.get('git')?.runner, false);
  assert.deepEqual(
    rows.filter(r => r.runner).map(r => r.id), rows.filter(r => r.group === 'harness').map(r => r.id),
    'runner is true for exactly the harness rows',
  );
});

test('a registry id is detected by its adapter, not by the table’s argv', async () => {
  // This is what keeps copilot's `beep` advisory alive: the adapter owns its
  // own detection, and a doctor.yaml override cannot take that over.
  const rows = await detectTools(
    registryOf(fakeAdapter('copilot', async () => ({ installed: true, version: '9.9.9', notes: ['beep'] }))),
    { tools: [probe({ id: 'copilot', group: 'harness', argv: ['never', 'run'] })] },
    {
      probe: async (p: ToolProbe) => {
        assert.notEqual(p.id, 'copilot', 'the adapter should have answered for copilot');
        return { installed: false };
      },
    },
  );
  const copilot = rows.find(r => r.id === 'copilot');
  assert.equal(copilot?.version, '9.9.9');
  assert.deepEqual(copilot?.notes, ['beep']);
});

test('an override of claude changes its label and still detects through the adapter', async () => {
  const rows = await detectTools(
    registryOf(fakeAdapter('claude', async () => ({ installed: true, version: '2.0.0' }))),
    { tools: [probe({ id: 'claude', label: 'My Claude', group: 'harness', argv: ['never', 'run'] })] },
    { probe: async () => ({ installed: false }) },
  );
  const claude = rows.find(r => r.id === 'claude');
  assert.equal(claude?.label, 'My Claude');
  assert.equal(claude?.installed, true);
  assert.equal(claude?.version, '2.0.0');
});

test('an override still gets to change a registry row’s presentation', async () => {
  const rows = await detectTools(
    registryOf(fakeAdapter('copilot', async () => ({ installed: true }))),
    { tools: [probe({ id: 'copilot', label: 'Copilot!', group: 'harness', optional: true })] },
    { probe: allInstalled },
  );
  const copilot = rows.find(r => r.id === 'copilot');
  assert.equal(copilot?.label, 'Copilot!');
  assert.equal(copilot?.optional, true);
});

test('rows come back group-major: every harness before every support tool', async () => {
  const rows = await detectTools(defaultRegistry(), {}, { probe: allInstalled });
  const groups = rows.map(r => r.group);
  assert.deepEqual([...new Set(groups)], ['harness', 'support']);
  assert.equal(groups.indexOf('support'), groups.lastIndexOf('harness') + 1);
});

test('optional defaults to true; only the things whiphand cannot work without are required', async () => {
  const rows = await detectTools(defaultRegistry(), {}, { probe: allInstalled });
  const required = rows.filter(r => !r.optional).map(r => r.id).sort();
  // The POSIX shell is required too: with none, command steps refuse to run.
  assert.deepEqual(required, ['claude', 'copilot', 'git', 'posix-shell']);
});

test('empty notes are omitted, so the CLI printing none is the same fact', async () => {
  const rows = await detectTools(
    registryOf(), { hide: BUILTIN_SUPPORT_TOOLS.slice(1).map(t => t.id) },
    { probe: async () => ({ installed: true, notes: [] }), machine: () => [] },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].notes, undefined);
  assert.ok(!Object.values(rows[0]).includes(null));
});

// ---------------------------------------------------------------------------
// login checks (gh, and the `check` hook on a support row)
// ---------------------------------------------------------------------------

const GH_NOTE = 'not logged in — run `gh auth login`';

/** What execFile rejects with for a command that ran and exited nonzero, as execRunner decorates it. */
const exited = (code: number, stderr: string) => Object.assign(new Error('Command failed'), { code, stdout: '', stderr });

test('ghAuthCheck: a token means logged in, and asks gh for the github.com token, offline-safe', async () => {
  const calls: string[][] = [];
  const notes = await ghAuthCheck(async argv => { calls.push(argv); return { stdout: 'gho_x', stderr: '' }; });
  assert.deepEqual(notes, []);
  // `auth token`, not `auth status`: status validates against the API, so an offline laptop reads as logged out.
  assert.deepEqual(calls, [['gh', 'auth', 'token', '--hostname', 'github.com']]);
});

test('ghAuthCheck: exit 1 with "no oauth token" is the one answer that means logged out', async () => {
  const notes = await ghAuthCheck(async () => { throw exited(1, 'no oauth token found for github.com\n'); });
  assert.deepEqual(notes, [GH_NOTE]);
});

test('ghAuthCheck: a timeout, another exit code, another message or a spawn failure says nothing', async () => {
  const check = (error: unknown) => ghAuthCheck(async () => { throw error; });
  assert.deepEqual(await check(Object.assign(new Error('timed out'), { killed: true, code: null, signal: 'SIGTERM', stderr: '' })), []);
  assert.deepEqual(await check(exited(2, 'no oauth token found for github.com')), []);
  assert.deepEqual(await check(exited(1, 'failed to read from keyring: locked')), []);
  assert.deepEqual(await check(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })), []);
});

test('only rtk and gh carry a check', () => {
  assert.deepEqual(BUILTIN_SUPPORT_TOOLS.filter(t => t.check).map(t => t.id), ['rtk', 'gh']);
});

// The default probe is the only one that runs checks; a test that substitutes
// `deps.probe` must not get a real `gh` spawned behind its back. `node` itself
// is the installed tool here, so nothing outside the test process is involved.
const nodeRow = (check: ToolProbe['check']): ToolProbe =>
  probe({ id: 'checked', argv: [process.execPath, '--version'], check });

const rowOf = async (row: ToolProbe) =>
  (await detectTools(registryOf(), { tools: [row], hide: BUILTIN_SUPPORT_TOOLS.map(t => t.id) }, { machine: () => [] }))[0];

test('detectTools: an installed tool’s check adds its notes to the row', async () => {
  const row = await rowOf(nodeRow(async () => ['not logged in — run `x login`']));
  assert.equal(row.installed, true);
  assert.deepEqual(row.notes, ['not logged in — run `x login`']);
});

test('detectTools: a check with nothing to say, or one that throws, leaves the row without notes', async () => {
  assert.equal((await rowOf(nodeRow(async () => []))).notes, undefined);
  const thrown = await rowOf(nodeRow(async () => { throw new Error('boom'); }));
  assert.equal(thrown.installed, true, 'a failing check must not fail the row');
  assert.equal(thrown.notes, undefined);
  const syncThrown = await rowOf(nodeRow((() => { throw new Error('boom'); }) as ToolProbe['check']));
  assert.equal(syncThrown.installed, true, 'nor may one that throws before it returns a promise');
  assert.equal(syncThrown.notes, undefined);
});

test('detectTools: a check can ask about another row without that row being probed twice', async () => {
  let claudeDetects = 0;
  const claude = fakeAdapter('claude', async () => { claudeDetects++; return { installed: true, version: '2.1.300' }; });
  const askClaude = nodeRow(async ctx => [`claude installed: ${(await ctx.detected('claude'))?.installed}`]);
  const [, row] = await detectTools(registryOf(claude), { tools: [askClaude], hide: BUILTIN_SUPPORT_TOOLS.map(t => t.id) }, { machine: () => [] });
  assert.deepEqual(row.notes, ['claude installed: true']);
  assert.equal(claudeDetects, 1);
});

test('detectTools: a row nobody registered or that is hidden is undefined to a check', async () => {
  const seen: unknown[] = [];
  const ask = nodeRow(async ctx => { seen.push(ctx.detected('claude')); return []; });
  await rowOf(ask);
  assert.deepEqual(seen, [undefined]);
});

test('detectTools: a tool that is not installed is not checked', async () => {
  let asked = false;
  const row = await rowOf(probe({
    id: 'checked', argv: ['whiphand-no-such-binary-4f1c', '--version'],
    check: async () => { asked = true; return ['never']; },
  }));
  assert.equal(row.installed, false);
  assert.equal(asked, false);
  assert.equal(row.notes, undefined);
});

// ---------------------------------------------------------------------------
// probeTool — the one place that actually spawns
// ---------------------------------------------------------------------------

test('probes a real binary', async () => {
  // node is guaranteed present: it is running this test.
  const result = await probeTool(probe({ id: 'node', argv: ['node', '--version'] }));
  assert.equal(result.installed, true);
  assert.match(result.version ?? '', /^\d+\.\d+\.\d+/);
  assert.equal(result.notes, undefined, 'no alias was needed, so nothing to say');
});

test('a binary that is not there reports missing rather than throwing', async () => {
  const result = await probeTool(probe({ id: 'whiphand-definitely-not-a-real-binary-xyz' }));
  assert.deepEqual(result, { installed: false });
});

test('an alias is tried after the primary name, and named when it answers', async () => {
  // Exactly Debian's fd/fdfind situation, with node standing in for the alias.
  const result = await probeTool(probe({
    id: 'fd', argv: ['whiphand-definitely-not-a-real-binary-xyz', '--version'], aliases: ['node'],
  }));
  assert.equal(result.installed, true);
  assert.deepEqual(result.notes, ["found as 'node'"]);
});

// ---------------------------------------------------------------------------
// probeRunner — the spawn half of every adapter's detect()
// ---------------------------------------------------------------------------

test('probeRunner probes the descriptor it is given, returning probeTool\'s exact shape', async () => {
  // `node` stands in for a runner: it is certainly installed.
  const result = await probeRunner({ label: 'Node', argv: ['node', '--version'], optional: true });
  assert.equal(result.installed, true);
  assert.match(result.version ?? '', /^\d+\.\d+\.\d+/);
  assert.ok(!('notes' in result), 'no alias answered, so no notes key at all — adapters return this as-is');
});

test('probeRunner reports a descriptor whose binary is missing as not installed', async () => {
  const doctor: RunnerDoctor = {
    label: 'Nope', argv: ['whiphand-definitely-not-a-real-binary-xyz', '--version'], optional: true,
  };
  assert.deepEqual(await probeRunner(doctor), { installed: false });
});

test('every shipped adapter describes itself for doctor with a `--version` probe of its own id', () => {
  for (const adapter of defaultRegistry().list()) {
    assert.deepEqual(adapter.doctor.argv, [adapter.id, '--version'], adapter.id);
    assert.ok(adapter.doctor.label.length > 0, adapter.id);
  }
});

// ---------------------------------------------------------------------------
// version floor — RunnerDoctor.minVersion
// ---------------------------------------------------------------------------

test('isOlderVersion: equal and newer are not older, older is', () => {
  assert.equal(isOlderVersion('2.1.277', '2.1.277'), false);
  assert.equal(isOlderVersion('2.1.278', '2.1.277'), false);
  assert.equal(isOlderVersion('2.2.0', '2.1.277'), false);
  assert.equal(isOlderVersion('3.0.0', '2.1.277'), false);
  assert.equal(isOlderVersion('2.1.276', '2.1.277'), true);
  assert.equal(isOlderVersion('1.99.999', '2.0.0'), true);
});

test('isOlderVersion: compares numbers, not strings, and pads a short version with zeros', () => {
  assert.equal(isOlderVersion('1.0.9', '1.0.83'), true);
  assert.equal(isOlderVersion('1.0.100', '1.0.83'), false);
  assert.equal(isOlderVersion('1.0', '1.0.0'), false);
  assert.equal(isOlderVersion('1.0.0', '1.0'), false);
  assert.equal(isOlderVersion('1.0', '1.0.1'), true);
});

test('isOlderVersion: a pre-release or build suffix is ignored', () => {
  assert.equal(isOlderVersion('2.1.277-beta.1', '2.1.277'), false);
  assert.equal(isOlderVersion('2.1.276-rc.2', '2.1.277'), true);
  assert.equal(isOlderVersion('2.45.0+build.7', '2.45.0'), false);
});

test('isOlderVersion: a version that is missing or not plain numbers is never older', () => {
  assert.equal(isOlderVersion(undefined, '2.1.277'), false);
  assert.equal(isOlderVersion('', '2.1.277'), false);
  assert.equal(isOlderVersion('nightly', '2.1.277'), false);
  assert.equal(isOlderVersion('1.x.0', '2.1.277'), false);
  assert.equal(isOlderVersion('1..0', '2.1.277'), false);
  assert.equal(isOlderVersion('1.0.0', 'latest'), false);
});

const NODE_DOCTOR: RunnerDoctor = { label: 'Node', argv: ['node', '--version'], optional: true };

test('probeRunner: a version below the descriptor’s minVersion is installed, with a note naming the floor', async () => {
  const result = await probeRunner({ ...NODE_DOCTOR, minVersion: '999.0.0' });
  assert.equal(result.installed, true);
  assert.deepEqual(result.notes, ['older than 999.0.0, the oldest version whiphand is tested with — update it']);
});

test('probeRunner: no note at or above the floor, or with no floor at all', async () => {
  const version = (await probeRunner(NODE_DOCTOR)).version!;
  assert.equal((await probeRunner({ ...NODE_DOCTOR, minVersion: version })).notes, undefined);
  assert.equal((await probeRunner({ ...NODE_DOCTOR, minVersion: '1.0.0' })).notes, undefined);
  assert.equal((await probeRunner(NODE_DOCTOR)).notes, undefined);
});

test('probeRunner: an unparseable version gets no floor note, and a missing binary none either', async () => {
  const dated = await probeRunner({ ...NODE_DOCTOR, versionPattern: '(v)\\d', minVersion: '999.0.0' });
  assert.equal(dated.installed, true);
  assert.equal(dated.notes, undefined);
  const noVersion = await probeRunner({
    label: 'Node', argv: [process.execPath, '-p', '"dev"'], versionPattern: '(dev)', optional: true, minVersion: '1.0.0',
  });
  assert.equal(noVersion.notes, undefined);
  const missing = await probeRunner({ label: 'x', argv: ['whiphand-no-such-binary-4f1c'], optional: true, minVersion: '1.0.0' });
  assert.deepEqual(missing, { installed: false });
});

test('the three harness adapters state the version their comments were verified against', () => {
  const floors = Object.fromEntries(defaultRegistry().list().map(a => [a.id, a.doctor.minVersion]));
  assert.deepEqual(floors, { claude: '2.1.260', copilot: '1.0.83', opencode: '2.0.0' });
});
