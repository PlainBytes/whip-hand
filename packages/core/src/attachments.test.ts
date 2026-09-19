import { validateSegment } from './segment.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachmentNames, consumesAttachments, sanitizeAttachmentName, unusedAttachmentsMessage,
} from './attachments.ts';
import type { Step, Workflow } from './types.ts';

const agent = (id: string, inputs?: string[], enabled?: boolean): Step => ({
  id, kind: 'agent', runner: 'claude', mode: 'headless', writes: false, prompt: 'p', output: `${id}.md`,
  ...(inputs === undefined ? {} : { inputs }), ...(enabled === undefined ? {} : { enabled }),
});
const wf = (...steps: Step[]): Workflow => ({ name: 'w', steps });

test('sanitize keeps the basename only, from either kind of path', () => {
  assert.equal(sanitizeAttachmentName('/home/me/shots/bug.png'), 'bug.png');
  assert.equal(sanitizeAttachmentName('C:\\Users\\me\\bug.png'), 'bug.png');
});

test('sanitize replaces anything outside [A-Za-z0-9._-] with a dash', () => {
  assert.equal(sanitizeAttachmentName('/x/Screen Shot (2).png'), 'Screen-Shot--2-.png');
  assert.equal(sanitizeAttachmentName('/x/résumé.pdf'), 'r-sum-.pdf');
});

test('sanitize strips leading dots, so nothing becomes hidden or a bookkeeping name', () => {
  assert.equal(sanitizeAttachmentName('/x/.name'), 'name');
  assert.equal(sanitizeAttachmentName('/x/..lock'), 'lock');
});

test('sanitize never mints a name Windows would resolve to a device or strip', () => {
  assert.equal(sanitizeAttachmentName('/x/nul.txt'), 'attachment-nul.txt');
  assert.equal(sanitizeAttachmentName('C:\\x\\CON'), 'attachment-CON');
  assert.equal(sanitizeAttachmentName('/x/com1.tar.gz'), 'attachment-com1.tar.gz');
  assert.equal(sanitizeAttachmentName('/x/notes.'), 'notes');
  for (const raw of ['/x/nul.txt', '/x/aux', '/x/lpt3.log', '/x/a.', '/x/...', '/x/a:b?.md']) {
    assert.equal(validateSegment(sanitizeAttachmentName(raw)).ok, true, raw);
  }
});

test('sanitize falls back to "attachment" when nothing is left', () => {
  assert.equal(sanitizeAttachmentName('/x/...'), 'attachment');
  assert.equal(sanitizeAttachmentName(''), 'attachment');
});

test('names pasted bytes pasted-N, keeping only the extension offered', () => {
  assert.deepEqual(
    attachmentNames([{ name: 'image.png' }, { path: '/a/log.txt' }, { name: 'clipboard.jpeg' }, { name: 'raw' }]),
    ['pasted-1.png', 'log.txt', 'pasted-2.jpeg', 'pasted-3']);
});

test('deduplicates case-insensitively, before the extension', () => {
  assert.deepEqual(
    attachmentNames([{ path: '/a/bug.png' }, { path: '/b/Bug.PNG' }, { path: '/c/bug.png' }, { path: '/d/Makefile' },
      { path: '/e/makefile' }]),
    ['bug.png', 'Bug-2.PNG', 'bug-3.png', 'Makefile', 'makefile-2']);
});

test('a generated suffix never collides with a name given later, or earlier', () => {
  assert.deepEqual(attachmentNames([{ path: '/a/x-2.log' }, { path: '/a/x.log' }, { path: '/b/x.log' }]),
    ['x-2.log', 'x.log', 'x-3.log']);
});

test('consumesAttachments: an enabled step naming the ref', () => {
  assert.equal(consumesAttachments(wf(agent('plan', ['attachments']))), true);
  assert.equal(consumesAttachments(wf(agent('plan'), agent('b', ['plan']))), false);
});

test('consumesAttachments: a disabled consumer does not count, nor one inside a disabled loop', () => {
  assert.equal(consumesAttachments(wf(agent('plan', ['attachments'], false), agent('b'))), false);
  const loop: Step = {
    kind: 'loop', id: 'fix', until: 'rev', enabled: false,
    steps: [agent('exec', ['attachments']), { ...agent('rev'), verdict: true } as Step],
  };
  assert.equal(consumesAttachments(wf(agent('plan'), loop)), false);
  assert.equal(consumesAttachments(wf(agent('plan'), { ...loop, enabled: undefined })), true);
});

test('consumesAttachments: a command step listing the ref counts — it is the declaration', () => {
  assert.equal(consumesAttachments(wf({ id: 'ls', kind: 'command', run: 'ls', inputs: ['attachments'] })), true);
});

test('the unused message counts the files and names the fix', () => {
  assert.match(unusedAttachmentsMessage(1), /^1 file attached, but no step reads `attachments`\./);
  assert.match(unusedAttachmentsMessage(2), /^2 files attached/);
  assert.match(unusedAttachmentsMessage(1), /inputs: \[attachments\]/);
});
