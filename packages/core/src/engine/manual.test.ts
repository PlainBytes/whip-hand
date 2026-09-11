import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewArtifact, noteArtifact } from './manual.ts';
import type { ManualRequest, ManualResponse, ManualStep } from '../types.ts';

const step: ManualStep = {
  id: 'sign-off', kind: 'approval', title: 'Ship it?', instructions: 'Look at the diff.',
  capture: 'review', show_diff: true, output: 'feedback.md',
};

const request: ManualRequest = {
  stepId: 'sign-off', kind: 'approval', title: 'Ship it?', instructions: 'Look at the diff.',
  choices: ['continue', 'retry', 'abort'], context: { artifacts: [] }, defaultChoice: 'continue',
};

test('reviewArtifact puts the choice in the subtitle, not just the title', () => {
  const retried = reviewArtifact(step, request, { choice: 'retry', note: 'fix it' });
  assert.match(retried, /_approval step 'sign-off' — changes requested_/);

  const approved = reviewArtifact(step, request, { choice: 'continue', note: 'looks good' });
  assert.match(approved, /_approval step 'sign-off' — approved_/);
});

test('backticks every file path, so it can never parse as markdown', () => {
  const body = reviewArtifact(step, request, {
    choice: 'retry',
    comments: [{ path: 'src/review/model.ts', body: 'ReviewSource should carry the step id.' }],
  });
  assert.match(body, /## `src\/review\/model\.ts`/);
});

test('drops blank comments — an empty overall note and a whitespace-only file comment', () => {
  const body = reviewArtifact(step, request, {
    choice: 'retry',
    note: '   ',
    comments: [
      { path: 'a.ts', body: '  ' },
      { path: 'b.ts', body: 'real feedback' },
    ],
  });
  assert.ok(!body.includes('## Overall'));
  assert.ok(!body.includes('`a.ts`'));
  assert.match(body, /## `b\.ts`/);
});

test('preserves the order comments were left in', () => {
  const answer: ManualResponse = {
    choice: 'retry',
    comments: [
      { path: 'z.ts', body: 'second thing' },
      { path: 'a.ts', body: 'first thing' },
    ],
  };
  const body = reviewArtifact(step, request, answer);
  assert.ok(body.indexOf('`z.ts`') < body.indexOf('`a.ts`'));
});

test('matches the plan\'s worked example', () => {
  const body = reviewArtifact(step, request, {
    choice: 'retry',
    note: 'The error path is untested and the naming is inconsistent.',
    comments: [
      { path: 'src/review/model.ts', body: 'ReviewSource should carry the step id.' },
      { path: 'apps/desktop/src/review/ReviewOverlay.tsx', body: 'Split the decision bar out.' },
    ],
  });
  assert.equal(body, [
    "# Ship it?",
    "",
    "_approval step 'sign-off' — changes requested_",
    "",
    "## Overall",
    "",
    "The error path is untested and the naming is inconsistent.",
    "",
    "## `src/review/model.ts`",
    "",
    "ReviewSource should carry the step id.",
    "",
    "## `apps/desktop/src/review/ReviewOverlay.tsx`",
    "",
    "Split the decision bar out.",
    "",
  ].join('\n'));
});

test('noteArtifact is unaffected — capture: note still renders a bare note', () => {
  const noteStep: ManualStep = { ...step, capture: 'note' };
  const body = noteArtifact(noteStep, request, 'looks good');
  assert.equal(body, "# Ship it?\n\n_approval step 'sign-off'_\n\nlooks good\n");
});
