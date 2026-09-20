import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RTK_HOOK_NOTE, rtkHookCheck, type RtkHookDeps } from './rtk-hook.ts';
import type { CheckContext } from './tools.ts';

const claudeIs = (installed: boolean | 'absent'): CheckContext => ({
  detected: id => id === 'claude' && installed !== 'absent' ? Promise.resolve({ installed }) : undefined,
});

/** A `~/.claude` of the given files; a path not listed is missing, and `throws` names files that fail another way. */
function deps(files: Record<string, string>, opts: { throws?: Record<string, string>; env?: NodeJS.ProcessEnv } = {}): RtkHookDeps {
  return {
    env: opts.env ?? {},
    home: '/h',
    async readText(path) {
      const failure = opts.throws?.[path];
      if (failure !== undefined) throw Object.assign(new Error(failure), { code: failure });
      const text = files[path];
      if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return text;
    },
  };
}

const hooksWith = (command: string) => JSON.stringify({
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] },
});

const SETTINGS = '/h/.claude/settings.json';
const LOCAL = '/h/.claude/settings.local.json';

test('rtkHookCheck: a hook that calls rtk means no note', async () => {
  for (const command of [
    'rtk hook claude',
    '/home/me/.local/bin/rtk hook claude',
    '"C:\\Users\\me\\bin\\rtk.exe" hook claude',
    '~/.claude/hooks/rtk-rewrite.sh',
    'cd /x && rtk hook claude; exit 0',
  ]) {
    assert.deepEqual(await rtkHookCheck(claudeIs(true), deps({ [SETTINGS]: hooksWith(command) })), [], command);
  }
});

test('rtkHookCheck: the hook may be in settings.local.json instead', async () => {
  const notes = await rtkHookCheck(claudeIs(true), deps({ [SETTINGS]: '{}', [LOCAL]: hooksWith('rtk hook claude') }));
  assert.deepEqual(notes, []);
});

test('rtkHookCheck: settings without an rtk hook get the note, naming the setup command', async () => {
  assert.deepEqual(await rtkHookCheck(claudeIs(true), deps({ [SETTINGS]: '{}' })), [RTK_HOOK_NOTE]);
  assert.match(RTK_HOOK_NOTE, /`rtk init -g`/);
  assert.deepEqual(await rtkHookCheck(claudeIs(true), deps({ [SETTINGS]: hooksWith('echo hi') })), [RTK_HOOK_NOTE]);
  // Mentioning rtk somewhere that is not a hook command does not count, nor does a lookalike word.
  const elsewhere = JSON.stringify({ permissions: { allow: ['Bash(rtk gain)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'cartkit run' }] }] } });
  assert.deepEqual(await rtkHookCheck(claudeIs(true), deps({ [SETTINGS]: elsewhere })), [RTK_HOOK_NOTE]);
});

test('rtkHookCheck: no settings file at all gets the note', async () => {
  assert.deepEqual(await rtkHookCheck(claudeIs(true), deps({})), [RTK_HOOK_NOTE]);
});

test('rtkHookCheck: a settings file that is malformed, or cannot be read, says nothing', async () => {
  assert.deepEqual(await rtkHookCheck(claudeIs(true), deps({ [SETTINGS]: '{ "hooks": ' })), []);
  assert.deepEqual(await rtkHookCheck(claudeIs(true), deps({ [SETTINGS]: '{}', [LOCAL]: 'not json' })), []);
  assert.deepEqual(await rtkHookCheck(claudeIs(true), deps({}, { throws: { [SETTINGS]: 'EACCES' } })), []);
});

test('rtkHookCheck: valid JSON of an unexpected shape is a file with no hook', async () => {
  for (const text of ['null', '[]', '"x"', '{"hooks":"rtk"}', '{"hooks":null}']) {
    assert.deepEqual(await rtkHookCheck(claudeIs(true), deps({ [SETTINGS]: text })), [RTK_HOOK_NOTE], text);
  }
});

test('rtkHookCheck: only when claude is in the report and installed', async () => {
  assert.deepEqual(await rtkHookCheck(claudeIs(false), deps({})), []);
  assert.deepEqual(await rtkHookCheck(claudeIs('absent'), deps({})), []);
});

test('rtkHookCheck: reads CLAUDE_CONFIG_DIR the way claude does', async () => {
  const env = { CLAUDE_CONFIG_DIR: '/cfg' };
  const notes = await rtkHookCheck(claudeIs(true), deps({ '/cfg/settings.json': hooksWith('rtk hook claude') }, { env }));
  assert.deepEqual(notes, []);
  assert.deepEqual(await rtkHookCheck(claudeIs(true), deps({ [SETTINGS]: hooksWith('rtk hook claude') }, { env })), [RTK_HOOK_NOTE]);
});
