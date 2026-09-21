import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headlessGuidance, headlessPrompt } from './headless-guidance.ts';

const step = { id: 'exec', writes: true };

test('both variants say no human is present and forbid asking', () => {
  for (const writes of [true, false]) {
    const text = headlessGuidance({ id: 'exec', writes });
    assert.ok(text.includes("step 'exec'"));
    assert.ok(text.includes('no human is watching'));
    assert.ok(text.includes('Do not ask questions'));
    assert.ok(text.includes('record that choice in your artifact'));
  }
});

test('both variants forbid history and index changes, and allow reading', () => {
  for (const writes of [true, false]) {
    const text = headlessGuidance({ id: 'exec', writes });
    for (const word of ['commit', 'stash', 'reset', 'checkout', 'switch', 'rebase', 'merge', 'push', 'tag']) {
      assert.ok(text.includes(word), `names ${word}`);
    }
    assert.ok(text.includes('git diff, git log and git show is fine'));
  }
});

test('both variants tie the deliverable to the artifact file and demand honesty', () => {
  for (const writes of [true, false]) {
    const text = headlessGuidance({ id: 'exec', writes });
    assert.ok(text.includes('not to stdout'));
    assert.ok(text.includes('The step fails if the file is missing'));
    assert.ok(text.includes('Never claim a check you did not run'));
  }
});

test('the read-only variant says READ-ONLY; the write variant does not', () => {
  const ro = headlessGuidance({ id: 'exec', writes: false });
  assert.ok(ro.includes('READ-ONLY'));
  assert.ok(ro.includes('no shell command that changes anything'));
  assert.ok(ro.includes('does not fix what it finds'));
  const rw = headlessGuidance(step);
  assert.ok(!rw.includes('READ-ONLY'));
  assert.ok(rw.includes('does not review its own work and does not commit it'));
});

test('the text has no template placeholder the prompt renderer could rewrite', () => {
  for (const writes of [true, false]) assert.ok(!headlessGuidance({ id: 'exec', writes }).includes('{{'));
});

test('headlessPrompt puts the guidance first and the step prompt last, under its own heading', () => {
  const text = headlessPrompt(step, 'Do the thing.');
  assert.ok(text.startsWith(headlessGuidance(step)));
  assert.ok(text.endsWith('\n\n---\n\n## Your task\n\nDo the thing.'));
});
