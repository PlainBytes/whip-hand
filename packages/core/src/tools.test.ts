import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdapterRegistry } from './registry.ts';
import type { DetectResult, RunnerAdapter, SpawnSpec } from './types.ts';
import {
  BUILTIN_TOOLS, detectTools, parseToolVersion, probeRunner, probeTool, resolveToolTable,
} from './tools.ts';
import type { ToolProbe } from './tools.ts';

function fakeAdapter(id: string, detect: () => Promise<DetectResult>): RunnerAdapter {
  const spec: SpawnSpec = { argv: [id], cwd: '/', env: {}, interactive: false };
  return {
    id,
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
    ['2025.08.28-8d9dd2c', '2025.08.28-8d9dd2c'],   // cursor-agent: dated build + hash
    ['no numbers here', undefined],
  ];
  for (const [output, expected] of cases) {
    assert.equal(parseToolVersion(output), expected, `parsing ${JSON.stringify(output)}`);
  }
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

test('the built-in table is the baseline, in its declared order', () => {
  const table = resolveToolTable(registryOf());
  assert.deepEqual(table.map(t => t.id), BUILTIN_TOOLS.map(t => t.id));
});

test('a user tool with a new id is appended', () => {
  const table = resolveToolTable(registryOf(), { tools: [probe({ id: 'bun' })] });
  assert.equal(table.at(-1)?.id, 'bun');
  assert.equal(table.length, BUILTIN_TOOLS.length + 1);
});

test('a user tool reusing a built-in id replaces it IN PLACE', () => {
  const at = BUILTIN_TOOLS.findIndex(t => t.id === 'rtk');
  const table = resolveToolTable(registryOf(), {
    tools: [probe({ id: 'rtk', label: 'RTK', argv: ['rtk', 'version'], optional: false })],
  });

  // Position is the point: tweaking one probe must not reshuffle the report.
  assert.equal(table.length, BUILTIN_TOOLS.length);
  assert.equal(table[at].id, 'rtk');
  assert.deepEqual(table[at].argv, ['rtk', 'version']);
  assert.equal(table[at].label, 'RTK');
});

test('a registered adapter the table has never heard of is added as a harness', () => {
  const table = resolveToolTable(registryOf(fakeAdapter('newbie', async () => ({ installed: true }))));
  const added = table.find(t => t.id === 'newbie');
  assert.ok(added, 'a third adapter must appear in doctor with no table edit');
  assert.equal(added.group, 'harness');
});

test('hide is applied last, so it can remove a registered adapter too', () => {
  const table = resolveToolTable(
    registryOf(fakeAdapter('newbie', async () => ({ installed: true }))),
    { hide: ['jq', 'newbie'] },
  );
  assert.ok(!table.some(t => t.id === 'jq'));
  assert.ok(!table.some(t => t.id === 'newbie'), 'hiding must beat the registry sweep');
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
  assert.equal(by.get('codex')?.runner, false, 'a harness with no adapter is detect-only');
  assert.equal(by.get('git')?.runner, false);
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
  const rows = await detectTools(registryOf(), {}, { probe: allInstalled });
  const groups = rows.map(r => r.group);
  assert.deepEqual([...new Set(groups)], ['harness', 'support']);
  assert.equal(groups.indexOf('support'), groups.lastIndexOf('harness') + 1);
});

test('optional defaults to true; only the things whiphand cannot work without are required', async () => {
  const rows = await detectTools(registryOf(), {}, { probe: allInstalled });
  const required = rows.filter(r => !r.optional).map(r => r.id).sort();
  assert.deepEqual(required, ['claude', 'copilot', 'git']);
});

test('empty notes are omitted, so the CLI printing none is the same fact', async () => {
  const rows = await detectTools(
    registryOf(), { hide: BUILTIN_TOOLS.slice(1).map(t => t.id) },
    { probe: async () => ({ installed: true, notes: [] }) },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].notes, undefined);
  assert.ok(!Object.values(rows[0]).includes(null));
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

test('probeRunner probes the built-in row for an id, returning probeTool\'s exact shape', async () => {
  // `node` stands in for a runner: it has a built-in row and is certainly installed.
  const result = await probeRunner('node');
  assert.equal(result.installed, true);
  assert.match(result.version ?? '', /^\d+\.\d+\.\d+/);
  assert.ok(!('notes' in result), 'no alias answered, so no notes key at all — adapters return this as-is');
});

test('probeRunner falls back to `<id> --version` for an id with no built-in row', async () => {
  assert.deepEqual(await probeRunner('whiphand-definitely-not-a-real-binary-xyz'), { installed: false });
});

test('every shipped adapter has a built-in row for probeRunner to find', () => {
  for (const id of ['claude', 'copilot', 'opencode']) {
    const row = BUILTIN_TOOLS.find(probe => probe.id === id);
    assert.deepEqual(row?.argv, [id, '--version'], id);
  }
});
