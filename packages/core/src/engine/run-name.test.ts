import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NAME_MARKER_NAME, RUN_NAME_MAX, RUN_SLUG_MAX, namePath, readRunName, setRunName,
  normalizeRunName, slugifyRunName, runSlugFor,
} from './run-name.ts';
import { WORKFLOW_NAME_RE } from '../scaffold.ts';

async function runDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'whiphand-run-name-'));
}

test('setRunName/readRunName round-trip through the marker file', async () => {
  const dir = await runDir();
  assert.equal(await readRunName(dir), undefined);
  await setRunName(dir, 'OAuth support');
  assert.equal(await readRunName(dir), 'OAuth support');
  assert.equal(await readFile(namePath(dir), 'utf8'), 'OAuth support');
  assert.ok(namePath(dir).endsWith(NAME_MARKER_NAME));
});

test('null clears the name, and clearing twice is not an error', async () => {
  const dir = await runDir();
  await setRunName(dir, 'gone');
  await setRunName(dir, null);
  assert.equal(await readRunName(dir), undefined);
  await setRunName(dir, null);
  assert.equal(await readRunName(dir), undefined);
});

test('a name that normalizes to nothing clears rather than writes an empty file', async () => {
  const dir = await runDir();
  await setRunName(dir, 'real');
  await setRunName(dir, '   ');
  assert.equal(await readRunName(dir), undefined);
});

test('a marker file holding only whitespace reads as unnamed', async () => {
  const dir = await runDir();
  await writeFile(namePath(dir), '\n\n', 'utf8');
  assert.equal(await readRunName(dir), undefined);
});

test('normalizeRunName collapses whitespace and strips control characters', () => {
  assert.equal(normalizeRunName('  OAuth\t\tsupport \n'), 'OAuth support');
  assert.equal(normalizeRunName('a\u0000b\u0007c\u001fd'), 'a b c d');
  assert.equal(normalizeRunName('one\nline'), 'one line');
});

test('normalizeRunName caps the length and returns null for nothing usable', () => {
  const long = 'x'.repeat(RUN_NAME_MAX + 50);
  assert.equal(normalizeRunName(long)?.length, RUN_NAME_MAX);
  assert.equal(normalizeRunName(''), null);
  assert.equal(normalizeRunName('   \t '), null);
});

test('a name truncated mid-word does not keep a trailing space', () => {
  // The cut lands on the space between the two words.
  const name = `${'x'.repeat(RUN_NAME_MAX - 1)} tail`;
  const normalized = normalizeRunName(name);
  assert.equal(normalized, 'x'.repeat(RUN_NAME_MAX - 1));
});

test('slugifyRunName produces a git-ref-safe token', () => {
  assert.equal(slugifyRunName('OAuth support'), 'oauth-support');
  assert.equal(slugifyRunName('Fix #123: the /api endpoint!'), 'fix-123-the-api-endpoint');
  assert.equal(slugifyRunName('  --leading and trailing--  '), 'leading-and-trailing');
  assert.equal(slugifyRunName('v1.2.3 release'), 'v1-2-3-release');
});

test('slugifyRunName folds accents rather than dropping the word', () => {
  assert.equal(slugifyRunName('Crème Brûlée'), 'creme-brulee');
  assert.equal(slugifyRunName('naïve café'), 'naive-cafe');
});

test('slugifyRunName returns empty when there is nothing to slug', () => {
  assert.equal(slugifyRunName('!!!'), '');
  assert.equal(slugifyRunName('🚀🚀'), '');
  assert.equal(slugifyRunName(''), '');
});

test('slugifyRunName caps length without leaving a trailing dash', () => {
  const slug = slugifyRunName(`${'a'.repeat(RUN_SLUG_MAX - 1)} tail`);
  assert.ok(slug.length <= RUN_SLUG_MAX);
  assert.ok(!slug.endsWith('-'));
  assert.equal(slug, 'a'.repeat(RUN_SLUG_MAX - 1));
});

test('every non-empty slug matches the shape the codebase already validates', () => {
  const names = [
    'OAuth support', 'Fix #123: the /api endpoint!', 'Crème Brûlée', '  --dashes--  ',
    '9 lives', 'v1.2.3 release', 'UPPER CASE', 'a'.repeat(200),
  ];
  for (const name of names) {
    const slug = slugifyRunName(name);
    assert.ok(slug.length > 0, `expected a slug for '${name}'`);
    assert.match(slug, WORKFLOW_NAME_RE, `slug '${slug}' from '${name}'`);
  }
});

test('runSlugFor falls back to the run id when there is no usable slug', () => {
  assert.equal(runSlugFor('20260101-000000-aaaa', undefined), '20260101-000000-aaaa');
  assert.equal(runSlugFor('20260101-000000-aaaa', '!!!'), '20260101-000000-aaaa');
  assert.equal(runSlugFor('20260101-000000-aaaa', 'OAuth support'), 'oauth-support');
});
