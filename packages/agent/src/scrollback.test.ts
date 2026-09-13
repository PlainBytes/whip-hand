import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOG_SCROLLBACK_CAP_LINES, MAX_TRACKED_JOBS, PROGRESS_SCROLLBACK_CAP, PTY_SCROLLBACK_CAP_CHARS, createScrollback,
} from './scrollback.ts';

/** A whiphandEvent notification, seq assigned the way frontend.ts/RunJournal really assign it. */
function whiphandEvent(jobId: string, seq: number, event: Record<string, unknown>) {
  return { jobId, runId: 'r1', ts: `t${seq}`, seq, event };
}

function started(jobId = 'j1') {
  return { jobId, stepId: 's1', cols: 80, rows: 24 };
}

test('seq counts chunks from zero and never repeats', () => {
  const sb = createScrollback();
  sb.record('ptyStarted', started());

  const seqs = ['a', 'b', 'c'].map(data =>
    (sb.record('ptyData', { jobId: 'j1', data }) as { seq: number }).seq);

  assert.deepEqual(seqs, [0, 1, 2]);
  assert.deepEqual(sb.snapshot('j1')?.pty?.chunks, ['a', 'b', 'c']);
});

test('the recorded chunk and the stamped seq cannot disagree', () => {
  const sb = createScrollback();
  sb.record('ptyStarted', started());
  for (const data of ['a', 'b', 'c', 'd']) sb.record('ptyData', { jobId: 'j1', data });

  const pty = sb.snapshot('j1')!.pty!;
  // chunks[i] is absolute chunk baseIndex + i — the invariant the client's
  // replay arithmetic depends on.
  for (let i = 0; i < pty.chunks.length; i++) {
    const absolute = pty.baseIndex + i;
    assert.equal(pty.chunks[i], ['a', 'b', 'c', 'd'][absolute]);
  }
});

test('ptyStarted resets the session, so a second step does not inherit the first', () => {
  const sb = createScrollback();
  sb.record('ptyStarted', started());
  sb.record('ptyData', { jobId: 'j1', data: 'old' });
  sb.record('ptyExit', { jobId: 'j1', exitCode: 0 });

  sb.record('ptyStarted', { jobId: 'j1', stepId: 's2', cols: 100, rows: 30 });
  const seq = (sb.record('ptyData', { jobId: 'j1', data: 'new' }) as { seq: number }).seq;

  const pty = sb.snapshot('j1')!.pty!;
  assert.equal(seq, 0, 'a new session restarts the sequence');
  assert.deepEqual(pty.chunks, ['new']);
  assert.equal(pty.stepId, 's2');
  assert.equal(pty.cols, 100);
  assert.equal(pty.exited, false, 'the previous exit must not carry over');
  assert.equal(pty.trimmed, false);
});

test('trimming drops from the front, advances baseIndex, and flags it', () => {
  const sb = createScrollback();
  sb.record('ptyStarted', started());
  const chunk = 'x'.repeat(100_000);
  for (let i = 0; i < 25; i++) sb.record('ptyData', { jobId: 'j1', data: chunk });

  const pty = sb.snapshot('j1')!.pty!;
  const total = pty.chunks.reduce((n, c) => n + c.length, 0);
  assert.ok(total <= PTY_SCROLLBACK_CAP_CHARS, `expected <= cap, got ${total}`);
  assert.ok(pty.trimmed);
  assert.ok(pty.baseIndex > 0);
  // The invariant still holds after a trim: the last chunk is absolute #24.
  assert.equal(pty.baseIndex + pty.chunks.length - 1, 24);
});

test('seq keeps counting absolutely across a trim', () => {
  const sb = createScrollback();
  sb.record('ptyStarted', started());
  const chunk = 'x'.repeat(100_000);
  let last = -1;
  for (let i = 0; i < 30; i++) {
    last = (sb.record('ptyData', { jobId: 'j1', data: chunk }) as { seq: number }).seq;
  }
  // Renumbering after a trim is exactly the bug that would corrupt a
  // late-attaching client's terminal.
  assert.equal(last, 29);
});

test('a single oversized chunk is never dropped', () => {
  const sb = createScrollback();
  sb.record('ptyStarted', started());
  const huge = 'y'.repeat(PTY_SCROLLBACK_CAP_CHARS * 2);
  sb.record('ptyData', { jobId: 'j1', data: 'small' });
  sb.record('ptyData', { jobId: 'j1', data: huge });

  const pty = sb.snapshot('j1')!.pty!;
  assert.deepEqual(pty.chunks, [huge], 'the newest chunk survives even alone over the cap');
});

test('exit and await state are recorded for a late attacher', () => {
  const sb = createScrollback();
  sb.record('ptyStarted', started());
  sb.record('ptyAwait', { jobId: 'j1', stepId: 's1', awaiting: true, reason: 'permission' });
  assert.deepEqual(sb.snapshot('j1')!.pty!.awaiting, { stepId: 's1', reason: 'permission' });

  sb.record('ptyAwait', { jobId: 'j1', stepId: 's1', awaiting: false });
  assert.equal(sb.snapshot('j1')!.pty!.awaiting, undefined);

  sb.record('ptyExit', { jobId: 'j1', exitCode: 3, reason: 'ended' });
  const pty = sb.snapshot('j1')!.pty!;
  assert.equal(pty.exited, true);
  assert.equal(pty.exitCode, 3);
  assert.equal(pty.exitReason, 'ended');
});

test('log lines get their own sequence and their own cap', () => {
  const sb = createScrollback();
  const first = sb.record('stepLog', { jobId: 'j1', stream: 'stdout', line: 'one' }) as { seq: number };
  const second = sb.record('stepLog', { jobId: 'j1', stream: 'stderr', line: 'two' }) as { seq: number };
  assert.equal(first.seq, 0);
  assert.equal(second.seq, 1);

  for (let i = 0; i < LOG_SCROLLBACK_CAP_LINES + 50; i++) {
    sb.record('stepLog', { jobId: 'j1', stream: 'stdout', line: `l${i}` });
  }
  const logs = sb.snapshot('j1')!.logs;
  assert.equal(logs.lines.length, LOG_SCROLLBACK_CAP_LINES);
  assert.ok(logs.trimmed);
  assert.equal(logs.lines.at(-1)!.line, `l${LOG_SCROLLBACK_CAP_LINES + 49}`);
});

test('notifications that are not transcript traffic pass through untouched', () => {
  const sb = createScrollback();
  const params = { jobId: 'j1', status: 'running' };
  assert.equal(sb.record('runStateChanged', params), params);
  assert.equal(sb.record('whiphandEvent', { jobId: 'j1' }) instanceof Object, true);
  // No jobId at all: nothing to key on.
  const orphan = { addresses: [] };
  assert.equal(sb.record('remoteAccessChanged', orphan), orphan);
});

test('whiphandEvent: step:log is excluded, the logs half above already covers it', () => {
  const sb = createScrollback();
  sb.record('whiphandEvent', whiphandEvent('j1', 0, { type: 'step:start', stepId: 's', kind: 'agent' }));
  sb.record('whiphandEvent', whiphandEvent('j1', 1, { type: 'step:log', stepId: 's', stream: 'stdout', line: 'x' }));
  assert.deepEqual(sb.snapshot('j1')!.events.map(e => e.event.type), ['step:start']);
});

test('whiphandEvent: everything but step:progress is kept in full', () => {
  const sb = createScrollback();
  sb.record('whiphandEvent', whiphandEvent('j1', 0, { type: 'step:start', stepId: 's', kind: 'agent' }));
  sb.record('whiphandEvent', whiphandEvent('j1', 1, { type: 'step:done', stepId: 's', exitCode: 0 }));
  const events = sb.snapshot('j1')!.events;
  assert.deepEqual(events.map(e => e.event.type), ['step:start', 'step:done']);
});

test('whiphandEvent: step:progress is capped, dropping the oldest first', () => {
  const sb = createScrollback();
  sb.record('whiphandEvent', whiphandEvent('j1', 0, { type: 'step:start', stepId: 's', kind: 'agent' }));
  for (let i = 0; i < PROGRESS_SCROLLBACK_CAP + 10; i++) {
    sb.record('whiphandEvent',
      whiphandEvent('j1', i + 1, { type: 'step:progress', stepId: 's', progress: { kind: 'usage', turns: i } }));
  }
  const events = sb.snapshot('j1')!.events;
  const progress = events.filter(e => e.event.type === 'step:progress');
  assert.equal(progress.length, PROGRESS_SCROLLBACK_CAP);
  // The oldest were dropped, not the newest.
  assert.equal((progress.at(-1)!.event as { progress: { turns: number } }).progress.turns, PROGRESS_SCROLLBACK_CAP + 9);
});

test('whiphandEvent: a fresh step:start drops the previous step\'s progress backlog', () => {
  const sb = createScrollback();
  sb.record('whiphandEvent', whiphandEvent('j1', 0, { type: 'step:start', stepId: 'a', kind: 'agent' }));
  sb.record('whiphandEvent',
    whiphandEvent('j1', 1, { type: 'step:progress', stepId: 'a', progress: { kind: 'usage', turns: 1 } }));
  sb.record('whiphandEvent', whiphandEvent('j1', 2, { type: 'step:done', stepId: 'a', exitCode: 0 }));
  sb.record('whiphandEvent', whiphandEvent('j1', 3, { type: 'step:start', stepId: 'b', kind: 'agent' }));

  const progress = sb.snapshot('j1')!.events.filter(e => e.event.type === 'step:progress');
  assert.deepEqual(progress, [], 'step a\'s backlog does not linger once step b has started');
});

test('whiphandEvent: the snapshot replays in seq order, regardless of which internal bucket held each event', () => {
  const sb = createScrollback();
  sb.record('whiphandEvent', whiphandEvent('j1', 0, { type: 'step:start', stepId: 's', kind: 'agent' }));
  sb.record('whiphandEvent',
    whiphandEvent('j1', 1, { type: 'step:progress', stepId: 's', progress: { kind: 'usage', turns: 1 } }));
  sb.record('whiphandEvent', whiphandEvent('j1', 2, { type: 'step:done', stepId: 's', exitCode: 0 }));

  const events = sb.snapshot('j1')!.events;
  assert.deepEqual(events.map(e => e.seq), [0, 1, 2]);
  assert.deepEqual(events.map(e => e.event.type), ['step:start', 'step:progress', 'step:done']);
});

test('whiphandEvent: a seq-less event (a handler-direct run:error) keeps its arrival position, not sorted to the front', () => {
  const sb = createScrollback();
  sb.record('whiphandEvent', whiphandEvent('j1', 0, { type: 'step:start', stepId: 's', kind: 'agent' }));
  sb.record('whiphandEvent',
    whiphandEvent('j1', 1, { type: 'step:progress', stepId: 's', progress: { kind: 'usage', turns: 1 } }));
  // handlers.ts's catch-block run:error carries no `seq` at all — it never
  // went through RunJournal.record. A full sort keyed on `seq ?? 0` would put
  // this ahead of the step:start above.
  sb.record('whiphandEvent', { jobId: 'j1', runId: 'r1', ts: 't2', event: { type: 'run:error', message: 'boom' } });

  const events = sb.snapshot('j1')!.events;
  assert.deepEqual(events.map(e => e.event.type), ['step:start', 'step:progress', 'run:error']);
});

test('an unknown job has no snapshot', () => {
  assert.equal(createScrollback().snapshot('nope'), null);
});

test('eviction drops the least recently active finished job first', () => {
  let clock = 0;
  const sb = createScrollback(() => clock);
  for (let i = 0; i < MAX_TRACKED_JOBS + 3; i++) {
    clock = i;
    sb.record('ptyStarted', { jobId: `j${i}`, stepId: 's', cols: 80, rows: 24 });
    sb.record('ptyExit', { jobId: `j${i}`, exitCode: 0 });
  }
  const tracked = sb.trackedJobs();
  assert.equal(tracked.length, MAX_TRACKED_JOBS);
  assert.equal(sb.snapshot('j0'), null, 'oldest evicted');
  assert.ok(sb.snapshot(`j${MAX_TRACKED_JOBS + 2}`), 'newest kept');
});

test('a job with a LIVE pty is never evicted', () => {
  let clock = 0;
  const sb = createScrollback(() => clock);
  // The oldest job, and still running.
  sb.record('ptyStarted', { jobId: 'live', stepId: 's', cols: 80, rows: 24 });

  for (let i = 0; i < MAX_TRACKED_JOBS + 5; i++) {
    clock = i + 1;
    sb.record('ptyStarted', { jobId: `j${i}`, stepId: 's', cols: 80, rows: 24 });
    sb.record('ptyExit', { jobId: `j${i}`, exitCode: 0 });
  }
  assert.ok(sb.snapshot('live'), 'dropping the transcript of a running job is the one thing eviction must not do');
});

test('snapshots are copies, so a later append cannot mutate one already taken', () => {
  const sb = createScrollback();
  sb.record('ptyStarted', started());
  sb.record('ptyData', { jobId: 'j1', data: 'a' });
  const snap = sb.snapshot('j1')!;
  sb.record('ptyData', { jobId: 'j1', data: 'b' });

  assert.deepEqual(snap.pty!.chunks, ['a']);
});
