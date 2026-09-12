import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { readFile, readFile as readFileP } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInitializeReply, mergeWithAliases, probeClaudeModels } from './claude-models.ts';

const fixtureDir = fileURLToPath(new URL('../../../../parity/fixtures/models/', import.meta.url));
const fixtureLine = async (): Promise<string> =>
  (await readFile(join(fixtureDir, 'claude-initialize-response.ndjson'), 'utf8')).trim();

// --- parseInitializeReply ---------------------------------------------

test('parseInitializeReply: reads the live models off a recorded reply, including resolves', async () => {
  const models = parseInitializeReply(await fixtureLine());
  assert.ok(models !== null);
  const byId = new Map(models!.map(m => [m.id, m]));
  assert.deepEqual(byId.get('sonnet'), {
    id: 'sonnet', label: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks', resolves: 'claude-sonnet-5',
  });
  assert.equal(byId.get('haiku')?.resolves, 'claude-haiku-4-5-20251001');
  assert.equal(models!.length, 5, 'default, opus[1m], fable, sonnet, haiku');
});

test('parseInitializeReply: never reads .account', async () => {
  const line = await fixtureLine();
  assert.ok(!line.includes('account'), 'the fixture must already have account stripped');
  const models = parseInitializeReply(line);
  assert.ok(models !== null);
});

test('parseInitializeReply: not JSON -> null', () => {
  assert.equal(parseInitializeReply('not json at all'), null);
});

test('parseInitializeReply: a different control_response (mismatched request_id) -> null', () => {
  const line = JSON.stringify({
    type: 'control_response', response: { request_id: 'req_999', response: { models: [{ value: 'sonnet' }] } },
  });
  assert.equal(parseInitializeReply(line), null);
});

test('parseInitializeReply: a reply with no models array -> null', () => {
  const line = JSON.stringify({ type: 'control_response', response: { request_id: 'req_1', response: {} } });
  assert.equal(parseInitializeReply(line), null);
});

test('parseInitializeReply: an unrelated NDJSON line (e.g. an assistant event) -> null', () => {
  assert.equal(parseInitializeReply(JSON.stringify({ type: 'assistant', message: {} })), null);
});

// --- mergeWithAliases ---------------------------------------------------

test('mergeWithAliases: live entries win; missing aliases are appended', () => {
  const merged = mergeWithAliases([{ id: 'sonnet', label: 'Sonnet', resolves: 'claude-sonnet-5' }]);
  assert.deepEqual(merged.find(m => m.id === 'sonnet'), { id: 'sonnet', label: 'Sonnet', resolves: 'claude-sonnet-5' });
  assert.ok(merged.some(m => m.id === 'opus'), 'opus alias appended: never offered live');
  assert.ok(merged.some(m => m.id === 'opusplan'), 'opusplan alias appended');
  assert.ok(merged.some(m => m.id === 'fable'), 'fable alias appended');
  const ids = merged.map(m => m.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
});

test('mergeWithAliases: an empty live list is just the aliases', () => {
  const merged = mergeWithAliases([]);
  assert.deepEqual(merged.map(m => m.id).sort(), ['default', 'fable', 'haiku', 'opus', 'opusplan', 'sonnet'].sort());
});

// --- probeClaudeModels: real child processes ----------------------------

/**
 * Real stub binaries on PATH, not a spawn seam: the point of these tests is
 * that the probe writes the right argv and env to whatever `claude` it finds
 * — an injected fake spawn function could not catch a regression that put
 * `--no-session-persistence` or `CLAUDE_CODE_SAFE_MODE` behind a typo.
 */
/**
 * These stubs are POSIX-only, for two independent reasons, so they are skipped
 * on Windows rather than papered over: PATH there is `;`-delimited, and even
 * spelled correctly an extensionless `claude` is invisible to the PATHEXT walk
 * in exec.ts — a `.cmd` would be found, but then cmd.exe runs it, and a
 * `#!/usr/bin/env bash` body is not a batch file. Skipped rather than left to
 * run because the fallback cases below would otherwise pass vacuously: on
 * Windows the probe finds no stub at all, which is the same `fallback` they
 * assert, so they would be green without exercising anything.
 *
 * The way to get these back is a stub pair — `claude.cmd` shelling to a
 * `node` script beside it — which is also the only shape that would exercise
 * the shim path exec.ts actually takes on Windows. "claude missing from PATH
 * entirely" below is deliberately not skipped: it needs no stub and the
 * behaviour it pins is the same on both platforms.
 */
const posixStubs = {
  skip: process.platform === 'win32' && 'stub binaries on PATH are POSIX-only; see the comment above stubBinDir',
};

function stubBinDir(t: import('node:test').TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'whiphand-claude-stub-'));
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}:${previousPath ?? ''}`;
  t.after(() => {
    process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function writeStub(dir: string, script: string): void {
  const file = join(dir, 'claude');
  writeFileSync(file, script);
  chmodSync(file, 0o755);
}

test('probeClaudeModels: a real reply -> live, merged with aliases; argv and env are correct', posixStubs, async t => {
  const dir = stubBinDir(t);
  const argvFile = join(dir, 'argv.txt');
  const envFile = join(dir, 'env.txt');
  writeStub(dir, [
    '#!/usr/bin/env bash',
    `printf '%s\\n' "$*" > '${argvFile}'`,
    `printf '%s\\n' "$CLAUDE_CODE_SAFE_MODE" > '${envFile}'`,
    'IFS= read -r _line',
    `printf '%s\\n' '{"type":"control_response","response":{"subtype":"success","request_id":"req_1",` +
      `"response":{"models":[{"value":"sonnet","resolvedModel":"claude-sonnet-5","displayName":"Sonnet"}]}}}'`,
    'exit 0',
    '',
  ].join('\n'));

  const result = await probeClaudeModels();
  assert.equal(result.source, 'live');
  assert.ok(result.models.some(m => m.id === 'sonnet' && m.resolves === 'claude-sonnet-5'));
  assert.ok(result.models.some(m => m.id === 'opus'), 'static alias merged in alongside the live reply');

  const argv = (await readFileP(argvFile, 'utf8')).trim();
  assert.ok(argv.includes('--no-session-persistence'), `argv was: ${argv}`);
  assert.ok(argv.includes('--input-format stream-json'), `argv was: ${argv}`);
  const env = (await readFileP(envFile, 'utf8')).trim();
  assert.equal(env, '1', 'CLAUDE_CODE_SAFE_MODE=1 must reach the child — it is load-bearing (no hooks, no transcript)');
});

test('probeClaudeModels: a hanging claude times out to the fallback, and the child is killed', posixStubs, async t => {
  const dir = stubBinDir(t);
  const aliveMarker = join(dir, 'still-alive.txt');
  writeStub(dir, [
    '#!/usr/bin/env bash',
    'IFS= read -r _line',
    'sleep 2',
    `printf 'yes' > '${aliveMarker}'`,
    '',
  ].join('\n'));

  const result = await probeClaudeModels({ timeoutMs: 100 });
  assert.deepEqual(result, {
    source: 'fallback', models: result.models, note: "couldn't query claude; showing built-in aliases",
  });
  assert.equal(result.source, 'fallback');

  // Give the sleeping stub time to reach its post-sleep line if it were still
  // running; the marker must never appear, because the timeout kills it first.
  await new Promise(r => setTimeout(r, 2200));
  await assert.rejects(readFileP(aliveMarker, 'utf8'), 'the child must have been killed before it could write this');
});

test('probeClaudeModels: claude exiting non-zero with no reply -> fallback', posixStubs, async t => {
  const dir = stubBinDir(t);
  writeStub(dir, ['#!/usr/bin/env bash', 'IFS= read -r _line', 'exit 1', ''].join('\n'));

  const result = await probeClaudeModels();
  assert.equal(result.source, 'fallback');
  assert.equal(result.note, "couldn't query claude; showing built-in aliases");
});

test('probeClaudeModels: a malformed reply -> fallback', posixStubs, async t => {
  const dir = stubBinDir(t);
  writeStub(dir, [
    '#!/usr/bin/env bash',
    'IFS= read -r _line',
    "printf '%s\\n' 'not a json line at all'",
    'exit 0',
    '',
  ].join('\n'));

  const result = await probeClaudeModels();
  assert.equal(result.source, 'fallback');
});

test('probeClaudeModels: claude missing from PATH entirely -> fallback, never throws', async () => {
  const previousPath = process.env.PATH;
  process.env.PATH = '';
  try {
    const result = await probeClaudeModels();
    assert.equal(result.source, 'fallback');
  } finally {
    process.env.PATH = previousPath;
  }
});
