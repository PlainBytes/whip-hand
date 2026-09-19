import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSegment, isValidSegment, validateRelativePath, validateSegment } from './segment.ts';
import { isValidWorkflowName, workflowNameProblem } from './workflow-name.ts';

test('accepts ordinary names, including ones a conservative filter would refuse', () => {
  for (const name of ['plan', 'plan.md', '.plan.done', 'a b', 'report-v1.md', 'É', 'console', 'nully', 'com10', 'lpt0', 'com', '01-api']) {
    assert.deepEqual(validateSegment(name), { ok: true }, name);
  }
});

test('rejects every character Windows refuses in a name, and control characters', () => {
  for (const ch of ['\\', '/', ':', '*', '?', '"', '<', '>', '|', '\u0000', '\n', '\t', '\u001f']) {
    const result = validateSegment(`a${ch}b`);
    assert.equal(result.ok, false, JSON.stringify(ch));
  }
});

test('rejects reserved device names in any case, with or without an extension', () => {
  const reserved = ['CON', 'PRN', 'AUX', 'NUL', ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap(n => [`COM${n}`, `LPT${n}`])];
  for (const name of reserved) {
    for (const variant of [name, name.toLowerCase(), `${name}.txt`, `${name.toLowerCase()}.tar.gz`, `${name} .txt`]) {
      const result = validateSegment(variant);
      assert.equal(result.ok, false, variant);
      assert.match((result as { reason: string }).reason, /reserved device name/, variant);
    }
  }
});

test('rejects empty names and trailing dots or spaces, which Windows strips silently', () => {
  assert.equal(validateSegment('').ok, false);
  assert.equal(validateSegment('plan.').ok, false);
  assert.equal(validateSegment('plan ').ok, false);
  assert.equal(validateSegment('.').ok, false);
  assert.equal(validateSegment('..').ok, false);
});

test('returns a reason that names the problem', () => {
  assert.match((validateSegment('a:b') as { reason: string }).reason, /':'/);
  assert.match((validateSegment('a\u0001b') as { reason: string }).reason, /control character U\+0001/);
  assert.match((validateSegment('x.') as { reason: string }).reason, /trailing|ends with a dot/);
});

test('isValidSegment and assertSegment agree with validateSegment', () => {
  assert.equal(isValidSegment('plan'), true);
  assert.equal(isValidSegment('nul'), false);
  assert.doesNotThrow(() => assertSegment('plan', 'stage id'));
  assert.throws(() => assertSegment('nul', 'stage id'), /invalid stage id "nul": 'nul' is a reserved device name/);
});

test('validateRelativePath keeps subdirectories and rejects escapes', () => {
  for (const ok of ['plan.md', 'reports/plan.md', 'a/b/c.txt']) {
    assert.deepEqual(validateRelativePath(ok), { ok: true }, ok);
  }
  for (const bad of ['', '/abs.md', 'C:/abs.md', 'C:\\abs.md', 'a\\b.md', '../x.md', 'a/../x.md', 'a//b.md', './x.md', 'a/./b',
    'report:v1.md', 'reports/nul.txt', 'reports/plan.', 'a/']) {
    assert.equal(validateRelativePath(bad).ok, false, bad);
  }
});

test('workflow names go through the segment validator as well as the shape pattern', () => {
  assert.equal(isValidWorkflowName('feature-dev'), true);
  assert.equal(isValidWorkflowName('Feature'), false);
  for (const name of ['con', 'nul', 'aux', 'com1', 'lpt9', 'prn']) {
    assert.equal(isValidWorkflowName(name), false, name);
    assert.match(workflowNameProblem(name) ?? '', /reserved device name/);
  }
  assert.equal(workflowNameProblem('ok-name'), null);
});
