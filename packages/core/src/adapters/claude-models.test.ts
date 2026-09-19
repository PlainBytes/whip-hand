import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile, readFile as readFileP } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withStubBin } from '@whiphand/test-support';
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
 * The stubs are real `claude` binaries minted in the shape the platform
 * launches — a `#!/bin/sh` script on POSIX, a `.cmd` in npm shim shape on
 * Windows (test-support's `withStubBin`), with the behaviour written once, in
 * JS. That is what makes these run on the Windows leg instead of being skipped,
 * and it is also the only shape that exercises the shim path exec.ts really
 * takes there.
 *
 * Every stub records that it was *invoked*. The fallback cases below assert
 * `fallback`, which is also what "the probe found no stub at all" produces — so
 * without that marker they would pass vacuously wherever the stub cannot be
 * found, which is exactly how they used to be green on Windows while testing
 * nothing.
 */
const reply = JSON.stringify({
  type: 'control_response',
  response: {
    subtype: 'success', request_id: 'req_1',
    response: { models: [{ value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' }] },
  },
});

/** JS for a stub that notes its invocation, then reads one line of stdin and behaves as `after` says. */
function stub(dir: string, after: string, extra = ''): string {
  return [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(join(dir, 'invoked.txt'))}, 'yes');`,
    extra,
    "require('node:readline').createInterface({ input: process.stdin }).once('line', () => {",
    after,
    '});',
  ].join('\n');
}

/** withStubBin needs the directory before the script is written, so mint it first and hand the script a path inside it. */
async function withClaude<T>(
  build: (dir: string) => string, fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'whiphand-claude-stub-state-'));
  try {
    return await withStubBin('claude', build(dir), () => fn(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const invoked = (dir: string): boolean => existsSync(join(dir, 'invoked.txt'));

test('probeClaudeModels: a real reply -> live, merged with aliases; argv and env are correct', async () => {
  await withClaude(dir => stub(
    dir,
    `process.stdout.write(${JSON.stringify(`${reply}\n`)}); process.exit(0);`,
    `fs.writeFileSync(${JSON.stringify(join(dir, 'argv.txt'))}, process.argv.slice(2).join(' ') + '\\n');`
      + `fs.writeFileSync(${JSON.stringify(join(dir, 'env.txt'))}, (process.env.CLAUDE_CODE_SAFE_MODE || '') + '\\n');`,
  ), async dir => {
    const result = await probeClaudeModels();
    assert.equal(result.source, 'live');
    assert.ok(result.models.some(m => m.id === 'sonnet' && m.resolves === 'claude-sonnet-5'));
    assert.ok(result.models.some(m => m.id === 'opus'), 'static alias merged in alongside the live reply');

    const argv = (await readFileP(join(dir, 'argv.txt'), 'utf8')).trim();
    assert.ok(argv.includes('--no-session-persistence'), `argv was: ${argv}`);
    assert.ok(argv.includes('--input-format stream-json'), `argv was: ${argv}`);
    const env = (await readFileP(join(dir, 'env.txt'), 'utf8')).trim();
    assert.equal(env, '1', 'CLAUDE_CODE_SAFE_MODE=1 must reach the child — it is load-bearing (no hooks, no transcript)');
  });
});

test('probeClaudeModels: a hanging claude times out to the fallback, and the child is killed', async () => {
  await withClaude(dir => stub(
    dir,
    `setTimeout(() => { fs.writeFileSync(${JSON.stringify(join(dir, 'still-alive.txt'))}, 'yes'); process.exit(0); }, 2000);`,
  ), async dir => {
    const result = await probeClaudeModels({ timeoutMs: 1000 });
    assert.deepEqual(result, {
      source: 'fallback', models: result.models, note: "couldn't query claude; showing built-in aliases",
    });
    assert.ok(invoked(dir), 'the stub really ran — this is not the "no claude found" fallback');

    // Give the sleeping stub time to reach its post-sleep line if it were still
    // running; the marker must never appear, because the timeout kills it first.
    await new Promise(r => setTimeout(r, 2500));
    await assert.rejects(readFileP(join(dir, 'still-alive.txt'), 'utf8'), 'the child must have been killed before it could write this');
  });
});

test('probeClaudeModels: claude exiting non-zero with no reply -> fallback', async () => {
  await withClaude(dir => stub(dir, 'process.exit(1);'), async dir => {
    const result = await probeClaudeModels();
    assert.ok(invoked(dir), 'the stub really ran');
    assert.equal(result.source, 'fallback');
    assert.equal(result.note, "couldn't query claude; showing built-in aliases");
  });
});

test('probeClaudeModels: a malformed reply -> fallback', async () => {
  await withClaude(dir => stub(dir, "process.stdout.write('not a json line at all\\n'); process.exit(0);"), async dir => {
    const result = await probeClaudeModels();
    assert.ok(invoked(dir), 'the stub really ran');
    assert.equal(result.source, 'fallback');
  });
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
