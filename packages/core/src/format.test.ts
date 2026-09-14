import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elapsedMs, formatBytes, formatElapsed } from './format.ts';

test('formatBytes: bytes, whole kilobytes, and megabytes to one decimal', () => {
  assert.equal(formatBytes(12), '12 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(340 * 1024), '340 KB');
  assert.equal(formatBytes(1.25 * 1024 * 1024), '1.3 MB');
});

test('formatElapsed: counts in whole seconds below a minute', () => {
  assert.equal(formatElapsed(0), '0s');
  assert.equal(formatElapsed(47_000), '47s');
  // Floors rather than rounds: a timer must never show the second it has
  // not finished, or a step reads as 1m before its first minute is up.
  assert.equal(formatElapsed(59_900), '59s');
});

test('formatElapsed: splits into minutes and seconds from a minute up', () => {
  assert.equal(formatElapsed(60_000), '1m 0s');
  assert.equal(formatElapsed(252_000), '4m 12s');
  assert.equal(formatElapsed(3_599_000), '59m 59s');
});

test('formatElapsed: drops seconds once there are hours, which no one reads at that scale', () => {
  assert.equal(formatElapsed(3_600_000), '1h 0m');
  assert.equal(formatElapsed(3_780_000), '1h 3m');
  assert.equal(formatElapsed(90_000_000), '25h 0m');
});

test('formatElapsed: clamps a negative span to zero rather than printing "-1s"', () => {
  // Clock skew between the run host and the reader is enough to produce one.
  assert.equal(formatElapsed(-5_000), '0s');
});

test('elapsedMs: measures from the start timestamp to the end instant given', () => {
  assert.equal(elapsedMs('2026-01-01T00:00:00Z', Date.parse('2026-01-01T00:00:30Z')), 30_000);
});

test('elapsedMs: has nothing to measure without a usable start timestamp', () => {
  assert.equal(elapsedMs(undefined, Date.now()), null);
  assert.equal(elapsedMs('not a date', Date.now()), null);
});
