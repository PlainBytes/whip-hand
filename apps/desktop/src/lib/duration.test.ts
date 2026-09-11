import { describe, expect, it } from 'vitest';
import { elapsedMs, formatElapsed } from './duration.ts';

describe('formatElapsed', () => {
  it('counts in whole seconds below a minute', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(47_000)).toBe('47s');
    // Floors rather than rounds: a timer must never show the second it has
    // not finished, or a step reads as 1m before its first minute is up.
    expect(formatElapsed(59_900)).toBe('59s');
  });

  it('splits into minutes and seconds from a minute up', () => {
    expect(formatElapsed(60_000)).toBe('1m 0s');
    expect(formatElapsed(252_000)).toBe('4m 12s');
    expect(formatElapsed(3_599_000)).toBe('59m 59s');
  });

  it('drops seconds once there are hours, which no one reads at that scale', () => {
    expect(formatElapsed(3_600_000)).toBe('1h 0m');
    expect(formatElapsed(3_780_000)).toBe('1h 3m');
    expect(formatElapsed(90_000_000)).toBe('25h 0m');
  });

  it('clamps a negative span to zero rather than printing "-1s"', () => {
    // Clock skew between the run host and this window is enough to produce one.
    expect(formatElapsed(-5_000)).toBe('0s');
  });
});

describe('elapsedMs', () => {
  const start = '2026-01-01T00:00:00Z';

  it('measures from the start timestamp to the end instant given', () => {
    expect(elapsedMs(start, Date.parse('2026-01-01T00:00:30Z'))).toBe(30_000);
  });

  it('has nothing to measure without a start timestamp', () => {
    expect(elapsedMs(undefined, Date.now())).toBeNull();
  });

  it('has nothing to measure when the start timestamp is unparseable', () => {
    expect(elapsedMs('not a date', Date.now())).toBeNull();
  });
});
