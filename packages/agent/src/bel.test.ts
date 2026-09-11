import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBelScanner } from './bel.ts';

test('a standalone BEL is a beep', () => {
  assert.equal(createBelScanner().scan('\x07'), 1);
  assert.equal(createBelScanner().scan('hello\x07world'), 1);
  assert.equal(createBelScanner().scan('\x07\x07'), 2);
});

test('a window-title OSC is not a beep, even though it ends in BEL', () => {
  // The regression that matters: claude repaints its title constantly, so
  // counting these would light the indicator permanently.
  assert.equal(createBelScanner().scan('\x1b]0;my title\x07'), 0);
  assert.equal(createBelScanner().scan('\x1b]2;other\x07'), 0);
});

test('a real beep right after a title sequence still counts', () => {
  assert.equal(createBelScanner().scan('\x1b]0;t\x07\x07'), 1);
});

test('an OSC split across chunks is still recognised', () => {
  const s = createBelScanner();
  assert.equal(s.scan('\x1b]0;ti'), 0);
  assert.equal(s.scan('tle\x07'), 0, 'the terminator arrived in a later read');
});

test('OSC 8 hyperlinks are not beeps', () => {
  // Observed verbatim in claude's own output.
  assert.equal(createBelScanner().scan('\x1b]8;;http://x\x07label\x1b]8;;\x07'), 0);
});

test('an ST-terminated OSC releases the scanner', () => {
  const s = createBelScanner();
  assert.equal(s.scan('\x1b]0;t\x1b\\'), 0);
  assert.equal(s.scan('\x07'), 1, 'ESC \\ closed the OSC, so this BEL stands alone');
});

test('CAN and SUB abort an OSC', () => {
  const s = createBelScanner();
  assert.equal(s.scan('\x1b]0;t\x18'), 0);
  assert.equal(s.scan('\x07'), 1);
});

test('a runaway OSC is released rather than deafening the session forever', () => {
  const s = createBelScanner();
  assert.equal(s.scan('\x1b]0;' + 'x'.repeat(5000)), 0);
  assert.equal(s.scan('\x07'), 1);
});

test('other escape families are ignored, not mistaken for OSC', () => {
  const s = createBelScanner();
  assert.equal(s.scan('\x1b[31mred\x1b[0m'), 0);
  assert.equal(s.scan('\x07'), 1);
});
