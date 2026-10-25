import { describe, expect, it } from 'vitest';
import { stepDuration } from './step-facts.ts';
import { step } from '../../test/step-fixture.ts';

const T0 = Date.parse('2026-01-01T10:00:00Z');
const stamp = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();

describe('stepDuration', () => {
  it('shows active time: a 120s step that waited 90s reads 30s', () => {
    const s = step({ id: 'a', status: 'done', startedAt: stamp(0), endedAt: stamp(120), waitedMs: 90_000 });
    expect(stepDuration(s, T0 + 999_000)).toBe('30s');
  });

  it('reads as before without the wait fields', () => {
    const s = step({ id: 'a', status: 'done', startedAt: stamp(0), endedAt: stamp(75) });
    expect(stepDuration(s, T0 + 999_000)).toBe('1m 15s');
  });

  it('stands still while a wait is open', () => {
    const s = step({ id: 'a', status: 'running', startedAt: stamp(0), waitingSince: stamp(40) });
    expect(stepDuration(s, T0 + 50_000)).toBe('40s');
    expect(stepDuration(s, T0 + 500_000)).toBe('40s');
  });

  it('shows nothing for manual and approval gates', () => {
    for (const kind of ['manual', 'approval'] as const) {
      const s = step({ id: 'a', kind, status: 'done', startedAt: stamp(0), endedAt: stamp(60) });
      expect(stepDuration(s, T0)).toBeNull();
    }
  });
});
