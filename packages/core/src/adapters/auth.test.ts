/**
 * The login notes, with the machine substituted: env, platform, home, files and
 * the one subcommand all come from `fakeDeps`, so nothing here depends on who
 * is logged in to what on the box running the suite.
 *
 * The shape every check must keep: logged in → no note; logged out → the note
 * naming the fix; and anything we cannot be sure about (a timeout, a file we
 * cannot read, an answer we do not recognise) → no note.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv, withStubBin } from '@whiphand/test-support';
import { envOn, isMissingFile, withAuthNote, type AuthProbeDeps } from './auth.ts';
import { claudeAdapter, claudeAuthNote } from './claude.ts';
import { copilotAdapter, copilotAuthNote } from './copilot.ts';
import { opencodeAdapter, opencodeAuthNote } from './opencode.ts';

const HOME = join('/', 'home', 'u');

function enoent(): Error {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
}

interface Fake {
  env?: Record<string, string>;
  platform?: NodeJS.Platform;
  /** Path → contents. A path not listed is missing (ENOENT); a value that is an Error is thrown. */
  files?: Record<string, string | Error>;
  /** What the subcommand does: stdout, or an Error for a nonzero exit / timeout. */
  run?: string | Error;
}

function fakeDeps(fake: Fake = {}): AuthProbeDeps & { spawned: string[][] } {
  const spawned: string[][] = [];
  return {
    env: fake.env ?? {},
    platform: fake.platform ?? 'linux',
    home: HOME,
    spawned,
    async readText(path) {
      const file = fake.files?.[path];
      if (file === undefined) throw enoent();
      if (file instanceof Error) throw file;
      return file;
    },
    async run(argv) {
      spawned.push(argv);
      if (fake.run === undefined) throw new Error('unexpected spawn');
      if (fake.run instanceof Error) throw fake.run;
      return fake.run;
    },
  };
}

const eaccess = (): Error => Object.assign(new Error('EACCES'), { code: 'EACCES' });

// --- helpers ---------------------------------------------------------------

test('envOn: set means set; empty, 0 and false are how a variable is switched off', () => {
  assert.equal(envOn({ A: 'x' }, 'A'), true);
  assert.equal(envOn({ A: '' }, 'A'), false);
  assert.equal(envOn({ A: '0' }, 'A'), false);
  assert.equal(envOn({ A: 'FALSE' }, 'A'), false);
  assert.equal(envOn({}, 'A'), false);
  assert.equal(envOn({ B: '1' }, 'A', 'B'), true, 'any one of several');
});

test('isMissingFile only recognises ENOENT', () => {
  assert.equal(isMissingFile(enoent()), true);
  assert.equal(isMissingFile(eaccess()), false);
  assert.equal(isMissingFile(undefined), false);
});

test('withAuthNote: adds the note to an installed row, keeps the notes it had', async () => {
  const result = await withAuthNote({ installed: true, version: '1', notes: ['a'] }, async () => 'b');
  assert.deepEqual(result, { installed: true, version: '1', notes: ['a', 'b'] });
});

test('withAuthNote: no note, a throwing check and an uninstalled row all leave the row alone', async () => {
  const installed = { installed: true, version: '1' };
  assert.equal(await withAuthNote(installed, async () => undefined), installed);
  assert.equal(await withAuthNote(installed, async () => { throw new Error('boom'); }), installed);
  const missing = { installed: false };
  assert.equal(await withAuthNote(missing, async () => { throw new Error('must not be asked'); }), missing);
});

// --- claude ----------------------------------------------------------------

const CLAUDE_HOME = join(HOME, '.claude');
const CLAUDE_NOTE = 'not logged in — run `claude` and use /login';

test('claude: no credentials anywhere → the /login note', async () => {
  assert.equal(await claudeAuthNote(fakeDeps()), CLAUDE_NOTE);
  assert.equal(await claudeAuthNote(fakeDeps({ platform: 'win32' })), CLAUDE_NOTE);
});

test('claude: a credentials file, or any credential variable, means logged in', async () => {
  const creds = { files: { [join(CLAUDE_HOME, '.credentials.json')]: '{}' } };
  assert.equal(await claudeAuthNote(fakeDeps(creds)), undefined);
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    assert.equal(await claudeAuthNote(fakeDeps({ env: { [name]: 'x' } })), undefined, name);
  }
});

test('claude: Bedrock, Vertex and Foundry authenticate elsewhere, so no login is expected', async () => {
  for (const name of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
    assert.equal(await claudeAuthNote(fakeDeps({ env: { [name]: '1' } })), undefined, name);
  }
  assert.equal(await claudeAuthNote(fakeDeps({ env: { CLAUDE_CODE_USE_BEDROCK: '0' } })), CLAUDE_NOTE,
    'switched off is not switched on');
});

test('claude: CLAUDE_CONFIG_DIR moves where the credentials are looked for', async () => {
  const dir = join('/', 'elsewhere');
  const env = { CLAUDE_CONFIG_DIR: dir };
  assert.equal(await claudeAuthNote(fakeDeps({ env, files: { [join(dir, '.credentials.json')]: '{}' } })), undefined);
  assert.equal(await claudeAuthNote(fakeDeps({ env, files: { [join(CLAUDE_HOME, '.credentials.json')]: '{}' } })),
    CLAUDE_NOTE, 'the default directory is not consulted once it is overridden');
});

test('claude: an apiKeyHelper, or a key in settings.json env, means logged in', async () => {
  const settings = (value: unknown) => ({ files: { [join(CLAUDE_HOME, 'settings.json')]: JSON.stringify(value) } });
  assert.equal(await claudeAuthNote(fakeDeps(settings({ apiKeyHelper: 'echo k' }))), undefined);
  assert.equal(await claudeAuthNote(fakeDeps(settings({ env: { ANTHROPIC_API_KEY: 'k' } }))), undefined);
  for (const name of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
    assert.equal(await claudeAuthNote(fakeDeps(settings({ env: { [name]: '1' } }))), undefined, name);
  }
  assert.equal(await claudeAuthNote(fakeDeps(settings({ env: { CLAUDE_CODE_USE_BEDROCK: 'false' } }))), CLAUDE_NOTE,
    'a provider switched off in settings.json is not switched on');
  assert.equal(await claudeAuthNote(fakeDeps(settings({ theme: 'dark', env: { FOO: 'bar' } }))), CLAUDE_NOTE,
    'settings that say nothing about auth do not count');
});

test('claude: files we cannot read or parse leave us unsure, so no note', async () => {
  const settings = join(CLAUDE_HOME, 'settings.json');
  assert.equal(await claudeAuthNote(fakeDeps({ files: { [settings]: '{ not json' } })), undefined);
  assert.equal(await claudeAuthNote(fakeDeps({ files: { [settings]: eaccess() } })), undefined);
  assert.equal(await claudeAuthNote(fakeDeps({ files: { [join(CLAUDE_HOME, '.credentials.json')]: eaccess() } })),
    undefined, 'a credentials file we may not read is still one that exists');
});

test('claude: macOS keeps the login in the Keychain, where there is nothing to check', async () => {
  assert.equal(await claudeAuthNote(fakeDeps({ platform: 'darwin' })), undefined);
});

test('claude: never spawns anything (claude auth status phones home)', async () => {
  const deps = fakeDeps();
  await claudeAuthNote(deps);
  assert.deepEqual(deps.spawned, []);
});

// --- copilot ---------------------------------------------------------------

const COPILOT_HOME = join(HOME, '.copilot');
const COPILOT_CONFIG = join(COPILOT_HOME, 'config.json');
const COPILOT_NOTE = 'not logged in — run `copilot login`';
const managed = (config: unknown) => `// This file is managed automatically.\n${JSON.stringify(config)}`;

test('copilot: no config.json and no token → the login note', async () => {
  assert.equal(await copilotAuthNote(fakeDeps()), COPILOT_NOTE);
});

test('copilot: a recorded login means logged in (the header comment does not get in the way)', async () => {
  const config = managed({ loggedInUsers: [{ host: 'https://github.com', login: 'octo' }] });
  assert.equal(await copilotAuthNote(fakeDeps({ files: { [COPILOT_CONFIG]: config } })), undefined);
});

test('copilot: a config that lists nobody is logged out', async () => {
  assert.equal(await copilotAuthNote(fakeDeps({ files: { [COPILOT_CONFIG]: managed({ loggedInUsers: [] }) } })),
    COPILOT_NOTE);
});

test('copilot: any of the three token variables, or bring-your-own-key, means no GitHub login is needed', async () => {
  for (const name of ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_PROVIDER_BASE_URL']) {
    assert.equal(await copilotAuthNote(fakeDeps({ env: { [name]: 'x' } })), undefined, name);
  }
});

test('copilot: COPILOT_HOME moves where the login is looked for', async () => {
  const home = join('/', 'elsewhere');
  const loggedIn = managed({ loggedInUsers: [{ login: 'octo' }] });
  assert.equal(
    await copilotAuthNote(fakeDeps({ env: { COPILOT_HOME: home }, files: { [join(home, 'config.json')]: loggedIn } })),
    undefined);
  assert.equal(
    await copilotAuthNote(fakeDeps({ env: { COPILOT_HOME: home }, files: { [COPILOT_CONFIG]: loggedIn } })),
    COPILOT_NOTE);
});

test('copilot: a config we cannot read, parse or recognise leaves us unsure, so no note', async () => {
  const unsure = async (contents: string | Error) =>
    copilotAuthNote(fakeDeps({ files: { [COPILOT_CONFIG]: contents } }));
  assert.equal(await unsure('{ not json'), undefined);
  assert.equal(await unsure(eaccess()), undefined);
  assert.equal(await unsure(managed({ firstLaunchAt: 'x' })), undefined, 'no loggedInUsers key: a renamed one looks the same');
  assert.equal(await unsure(managed({ loggedInUsers: 'octo' })), undefined, 'not a list');
  assert.equal(await unsure('null'), undefined);
});

// --- opencode --------------------------------------------------------------

const OPENCODE_AUTH = join(HOME, '.local', 'share', 'opencode', 'auth.json');
const OPENCODE_NOTE = 'no provider credentials — run `opencode auth login`';
const listing = (body: string): string =>
  `\n┌  Credentials ~/.local/share/opencode/auth.json\n│\n${body}\n`;

test('opencode: stored credentials answer it from the file, with nothing spawned', async () => {
  const deps = fakeDeps({ files: { [OPENCODE_AUTH]: JSON.stringify({ mistral: { type: 'api', key: 'k' } }) } });
  assert.equal(await opencodeAuthNote(deps), undefined);
  assert.deepEqual(deps.spawned, [], '`opencode auth list` is ~0.8s; a logged-in machine should not pay it');
});

test('opencode: XDG_DATA_HOME moves the file', async () => {
  const data = join('/', 'xdg');
  const deps = fakeDeps({
    env: { XDG_DATA_HOME: data },
    files: { [join(data, 'opencode', 'auth.json')]: JSON.stringify({ opencode: { type: 'api', key: 'k' } }) },
  });
  assert.equal(await opencodeAuthNote(deps), undefined);
  assert.deepEqual(deps.spawned, []);
});

test('opencode: nothing stored and `0 credentials` from the subcommand → the note', async () => {
  const empty = fakeDeps({ run: listing('└  0 credentials') });
  assert.equal(await opencodeAuthNote(empty), OPENCODE_NOTE);
  assert.deepEqual(empty.spawned, [['opencode', 'auth', 'list']]);
  const emptyFile = fakeDeps({ files: { [OPENCODE_AUTH]: '{}' }, run: listing('└  0 credentials') });
  assert.equal(await opencodeAuthNote(emptyFile), OPENCODE_NOTE, 'an empty auth.json is asked about, not trusted');
});

test('opencode: colour codes in the listing do not hide the count', async () => {
  const coloured = '\x1b[90m└\x1b[0m  0 credentials\n';
  assert.equal(await opencodeAuthNote(fakeDeps({ run: coloured })), OPENCODE_NOTE);
});

test('opencode: a provider key found in the environment means it has a provider', async () => {
  const withEnv = listing('└  0 credentials') +
    '\n┌  Environment\n│\n●  Anthropic ANTHROPIC_API_KEY\n│\n└  1 environment variable\n';
  assert.equal(await opencodeAuthNote(fakeDeps({ run: withEnv })), undefined);
});

test('opencode: credentials the subcommand finds that the file check missed → no note', async () => {
  assert.equal(await opencodeAuthNote(fakeDeps({ run: listing('●  Mistral api\n│\n└  1 credential') })), undefined);
  assert.equal(await opencodeAuthNote(fakeDeps({ run: listing('└  10 credentials') })), undefined,
    '10 is not 0');
});

test('opencode: a timeout, a nonzero exit or an answer we do not recognise → no note', async () => {
  const timedOut = Object.assign(new Error('timed out'), { killed: true, code: null });
  await assert.rejects(opencodeAuthNote(fakeDeps({ run: timedOut })), /timed out/,
    'the check itself lets the failure through…');
  assert.equal(await withAuthNote({ installed: true }, () => opencodeAuthNote(fakeDeps({ run: timedOut }))).then(r => r.notes),
    undefined, '…and the wrapper turns it into no note');
  assert.equal(await opencodeAuthNote(fakeDeps({ run: '9.9.9-stub\n' })), undefined);
  assert.equal(await opencodeAuthNote(fakeDeps({ run: '' })), undefined);
});

// --- detect() wiring ---------------------------------------------------------
// The checks above take their machine as an argument; these run each adapter's
// real detect() against a stub binary on PATH, to pin that it is called, and
// called only for an installed tool.

const emptyDir = (): Promise<string> => mkdtemp(join(tmpdir(), 'whiphand-auth-'));

const NO_CLAUDE_LOGIN: Record<string, string | undefined> = {
  ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined,
  CLAUDE_CODE_USE_BEDROCK: undefined, CLAUDE_CODE_USE_VERTEX: undefined, CLAUDE_CODE_USE_FOUNDRY: undefined,
};

test('claude detect(): an installed claude with no login carries the note; a key removes it', async () => {
  // macOS has no file signal to check (see claudeAuthNote), so it never has the note.
  const expected = process.platform === 'darwin' ? undefined : [CLAUDE_NOTE];
  const config = await emptyDir();
  await withStubBin('claude', `console.log('claude 9.9.9');`, async () => {
    const loggedOut = await withEnv({ ...NO_CLAUDE_LOGIN, CLAUDE_CONFIG_DIR: config }, () => claudeAdapter.detect());
    assert.equal(loggedOut.installed, true);
    assert.deepEqual(loggedOut.notes, expected);
    const withKey = await withEnv({ ...NO_CLAUDE_LOGIN, CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'k' },
      () => claudeAdapter.detect());
    assert.equal(withKey.notes, undefined);
  });
});

test('claude detect(): an uninstalled claude gets no login note, only "not installed"', async () => {
  const result = await withEnv({ PATH: '', Path: '', ...NO_CLAUDE_LOGIN, CLAUDE_CONFIG_DIR: await emptyDir() },
    () => claudeAdapter.detect());
  assert.deepEqual(result, { installed: false });
});

test('copilot detect(): the login note leads and the beep note still follows', async () => {
  const home = await emptyDir();
  const tokens = { COPILOT_GITHUB_TOKEN: undefined, GH_TOKEN: undefined, GITHUB_TOKEN: undefined, COPILOT_PROVIDER_BASE_URL: undefined };
  await withStubBin('copilot', `console.log('GitHub Copilot CLI 9.9.9.');`, async () => {
    const loggedOut = await withEnv({ ...tokens, COPILOT_HOME: home }, () => copilotAdapter.detect());
    assert.equal(loggedOut.notes?.length, 2);
    assert.equal(loggedOut.notes?.[0], COPILOT_NOTE);
    assert.ok(loggedOut.notes?.[1].includes('beep'));
    const withToken = await withEnv({ ...tokens, COPILOT_HOME: home, GH_TOKEN: 't' }, () => copilotAdapter.detect());
    assert.deepEqual(withToken.notes?.map(n => n.includes('beep')), [true]);
  });
});

test('opencode detect(): asks `opencode auth list` only when auth.json has nothing, and notes `0 credentials`', async () => {
  const data = await emptyDir();
  const behaviour = `console.log(process.argv[2] === 'auth' ? '└  0 credentials' : '1.2.3');`;
  await withStubBin('opencode', behaviour, async () => {
    const result = await withEnv({ XDG_DATA_HOME: data, OPENCODE_CONFIG_CONTENT: undefined }, () => opencodeAdapter.detect());
    assert.equal(result.installed, true);
    assert.deepEqual(result.notes, [OPENCODE_NOTE]);
  });
});
