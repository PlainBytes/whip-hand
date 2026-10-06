import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRelativePath, validateSegment } from './segment.ts';
import { workflowNameProblem } from './workflow-name.ts';
import { formatLogLine, parseLogLine, summarizeEvent } from './log-rows.ts';
import type { WhiphandEvent } from './types.ts';

/**
 * The webview keeps its own copies of a few of core's pure modules. These
 * check them against the goldens whiphand-core is held to
 * (crates/whiphand-core/tests/parity.rs), so the copies cannot drift from
 * what the agent writes.
 */

const CORE_FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../parity/fixtures/core');
const fixtures = (file: string): unknown[] =>
  JSON.parse(readFileSync(path.join(CORE_FIXTURES, file), 'utf8')) as unknown[];

describe('segment and workflow-name match the core golden', () => {
  const ops = fixtures('suites/segment.json') as Array<{ op: string; name?: string; path?: string }>;
  const golden = fixtures('golden/segment.json');

  it('answers every op as core does', () => {
    expect(ops).toHaveLength(golden.length);
    const results = ops.map(op => {
      const shape = (r: ReturnType<typeof validateSegment>) => (r.ok ? { ok: true } : { ok: false, reason: r.reason });
      switch (op.op) {
        case 'validateSegment': return shape(validateSegment(op.name!));
        case 'validateRelativePath': return shape(validateRelativePath(op.path!));
        case 'workflowNameProblem': return workflowNameProblem(op.name!);
        default: throw new Error(`unexpected op ${op.op}`);
      }
    });
    // JSON drops `undefined`, as the golden's writer did.
    expect(JSON.parse(JSON.stringify(results))).toEqual(golden);
  });
});

const TRUNCATED = '…[truncated]';

describe('log-rows (and the format helpers it uses) match the core golden', () => {
  const golden = fixtures('golden/store-journal.json') as Array<{ events: string | null; runLog: string | null }>;

  it('summarizes every journaled event to the run.log line core wrote', () => {
    let compared = 0;
    for (const entry of golden) {
      if (entry.events === null || entry.runLog === null) continue;
      // Both files only append, and a resumed run starts `seq` again, so
      // each run.log line is matched to the next event with its seq. Rows
      // with no event (headless output is logged, not journaled) are skipped.
      const events = entry.events.split('\n').filter(Boolean)
        .map(line => JSON.parse(line) as { seq: number; event: WhiphandEvent });
      let next = 0;
      for (const line of entry.runLog.split('\n').filter(Boolean)) {
        const row = parseLogLine(line);
        if (row === null) continue;
        const at = events.findIndex((e, i) => i >= next && e.seq === row.seq);
        if (at === -1) continue;
        const { seq, event } = events[at];
        const formatted = formatLogLine({ seq, ts: '<TS>', ...summarizeEvent(event) });
        // The writer cuts an over-long line and marks it; the kept part must match.
        if (line.endsWith(TRUNCATED)) {
          expect(formatted.startsWith(line.slice(0, -TRUNCATED.length)), `seq ${seq} prefix`).toBe(true);
        } else {
          expect(formatted).toBe(`${line}\n`);
        }
        next = at + 1;
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(20);
  });
});
