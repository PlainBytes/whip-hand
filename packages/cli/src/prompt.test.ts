import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { createManualPrompt, promptMissingInputs } from './prompt.ts';
import type { ManualRequest, Workflow } from '@whiphand/core';

/**
 * A stand-in terminal: answers are typed one at a time, in response to each
 * question, the way a person does. Pre-loading every line into the stream
 * instead does not work — readline emits buffered lines whether or not a
 * question is outstanding, so the second answer would be dropped.
 */
function terminal(...answers: string[]) {
  const input = new PassThrough();
  const chunks: string[] = [];
  let next = 0;
  const output = new Writable({
    write(chunk, _enc, cb) {
      const text = String(chunk);
      chunks.push(text);
      // Every prompt this module writes ends in '> ' or ': '.
      if (/(> |: )$/.test(text)) {
        setImmediate(() => {
          if (next < answers.length) input.write(answers[next++]);
          else input.end();
        });
      }
      cb();
    },
  });
  return {
    input,
    output,
    get text() { return chunks.join(''); },
  };
}

function sink(): Writable & { text: string } {
  const chunks: string[] = [];
  const w = new Writable({
    write(chunk, _enc, cb) { chunks.push(String(chunk)); cb(); },
  }) as Writable & { text: string };
  Object.defineProperty(w, 'text', { get: () => chunks.join('') });
  return w;
}

const request: ManualRequest = {
  stepId: 'sign', kind: 'approval', title: 'Ship it?',
  instructions: 'Review the diff before pushing.',
  choices: ['continue', 'abort'],
  context: { artifacts: [{ id: 'review', path: '/r/findings.md' }] },
  defaultChoice: 'continue',
};

test('a non-interactive run refuses to walk past a human gate', async () => {
  const runManual = createManualPrompt({ yes: false, isTty: false });
  await assert.rejects(runManual(request), (e: unknown) =>
    e instanceof Error && e.message.includes("'sign'") && e.message.includes('--yes'));
});

test('--yes takes the step default and says out loud that it did', async () => {
  const output = sink();
  const runManual = createManualPrompt({ yes: true, isTty: false, output });
  assert.deepEqual(await runManual(request), { choice: 'continue' });
  assert.ok(output.text.includes('auto-resolving'));
  assert.ok(output.text.includes("'sign'"));
});

test('--yes honours a step whose default is abort', async () => {
  const runManual = createManualPrompt({ yes: true, isTty: false, output: sink() });
  const answer = await runManual({ ...request, defaultChoice: 'abort' });
  assert.equal(answer.choice, 'abort');
});

test('--yes supplies a placeholder note rather than writing an empty artifact', async () => {
  const runManual = createManualPrompt({ yes: true, isTty: false, output: sink() });
  const answer = await runManual({
    ...request, capture: { kind: 'note', label: 'Note', requiredFor: ['continue'], perFile: false },
  });
  assert.ok(answer.note && answer.note.length > 0);
  assert.ok(answer.note.includes('--yes'));
});

test('--yes does not invent a note for a capture the default choice never required', async () => {
  // A `capture: review` step's default is `continue`, which review only
  // requires for `retry` — auto-approving it must not write a placeholder
  // into a step that never needed one.
  const runManual = createManualPrompt({ yes: true, isTty: false, output: sink() });
  const answer = await runManual({
    ...request, capture: { kind: 'review', label: 'Feedback', requiredFor: ['retry'], perFile: true },
  });
  assert.equal(answer.note, undefined);
});

test('on a terminal it renders the question and reads a choice', async () => {
  const t = terminal('a\n');
  const runManual = createManualPrompt({ yes: false, isTty: true, ...t });
  assert.deepEqual(await runManual(request), { choice: 'abort' });
  assert.ok(t.text.includes('Ship it?'));
  assert.ok(t.text.includes('Review the diff before pushing.'));
  assert.ok(t.text.includes('- review: /r/findings.md'), 'artifact paths are shown');
  assert.ok(t.text.includes('[c]ontinue'));
  assert.ok(t.text.includes('── Decision: Ship it?'));
});

test('an empty answer takes the default', async () => {
  const runManual = createManualPrompt({ yes: false, isTty: true, ...terminal('\n') });
  assert.deepEqual(await runManual(request), { choice: 'continue' });
});

test('an unrecognized answer is re-asked rather than guessed at', async () => {
  const t = terminal('zzz\n', 'c\n');
  const runManual = createManualPrompt({ yes: false, isTty: true, ...t });
  assert.deepEqual(await runManual(request), { choice: 'continue' });
  assert.ok(t.text.includes('not one of'));
});

test('a retry choice is offered and accepted inside a loop', async () => {
  const runManual = createManualPrompt({ yes: false, isTty: true, ...terminal('r\n') });
  const answer = await runManual({
    ...request, choices: ['continue', 'retry', 'abort'],
    loop: { id: 'fix', iteration: 2, maxIterations: 3 },
  });
  assert.equal(answer.choice, 'retry');
});

test('a capture step collects the note, and will not accept an empty one', async () => {
  const t = terminal('c\n', '\n', 'shipped it\n');
  const runManual = createManualPrompt({ yes: false, isTty: true, ...t });
  const answer = await runManual({
    ...request,
    capture: { kind: 'note', label: 'Release note', requiredFor: ['continue'], perFile: false },
  });
  assert.deepEqual(answer, { choice: 'continue', note: 'shipped it' });
  assert.ok(t.text.includes('a note is required'));
});

test('a note is asked for on retry, not just continue', async () => {
  // Regression: the old condition was `choice === 'continue' && request.capture`,
  // which silently dropped feedback typed against a retry.
  const t = terminal('r\n', 'send it back and try again\n');
  const runManual = createManualPrompt({ yes: false, isTty: true, ...t });
  const answer = await runManual({
    ...request,
    choices: ['continue', 'retry', 'abort'],
    capture: { kind: 'review', label: 'Feedback', requiredFor: ['retry'], perFile: true },
  });
  assert.deepEqual(answer, { choice: 'retry', note: 'send it back and try again' });
});

test('capture is not asked for on abort', async () => {
  const t = terminal('a\n');
  const runManual = createManualPrompt({ yes: false, isTty: true, ...t });
  const answer = await runManual({
    ...request,
    choices: ['continue', 'retry', 'abort'],
    capture: { kind: 'review', label: 'Feedback', requiredFor: ['retry'], perFile: true },
  });
  assert.deepEqual(answer, { choice: 'abort' });
});

test('the diff is shown when the step asked for it', async () => {
  const t = terminal('c\n');
  const runManual = createManualPrompt({ yes: false, isTty: true, ...t });
  await runManual({ ...request, context: { artifacts: [], diff: '+++ b/src/x.ts' } });
  assert.ok(t.text.includes('+++ b/src/x.ts'));
});

const workflow: Workflow = {
  name: 'r',
  inputs: {
    feature: { required: true, prompt: 'What are we building?' },
    branch: { required: false },
    env: { required: true, default: 'dev' },
  },
  steps: [{
    kind: 'agent', id: 'a', runner: 'claude', mode: 'headless', writes: false,
    prompt: 'p', output: 'a.md',
  }],
};

test('missing required inputs are prompted for, using the workflow prompt text', async () => {
  const t = terminal('oauth\n');
  const resolved = await promptMissingInputs(workflow, {}, { yes: false, isTty: true, ...t });
  assert.deepEqual(resolved, { feature: 'oauth' });
  assert.ok(t.text.includes('What are we building?'));
});

test('inputs already given, defaulted, or optional are never prompted for', async () => {
  const t = terminal();
  const resolved = await promptMissingInputs(workflow, { feature: 'given' }, {
    yes: false, isTty: true, ...t,
  });
  assert.deepEqual(resolved, { feature: 'given' });
  assert.equal(t.text, '', 'nothing left to ask about');
});

test('without a terminal, prompting is skipped so the engine reports the miss', async () => {
  const resolved = await promptMissingInputs(workflow, {}, { yes: false, isTty: false });
  assert.deepEqual(resolved, {});
});
