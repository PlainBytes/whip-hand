/**
 * The pure parts of scripts/mobile-check.mjs: the scene list and the verdicts.
 * The check itself needs Chromium and a built agent, so it is checked by
 * running it (`npm run mobile-check`), not here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_OFFENDERS, SCENES, STATUSES, judge, selectScenes } from './mobile-check.mjs';

test('scene names are unique', () => {
  const names = SCENES.map(scene => scene.name);
  assert.equal(new Set(names).size, names.length);
});

test('every scene has a name, a prepare and a known status', () => {
  for (const scene of SCENES) {
    assert.ok(scene.name, 'a scene needs a name');
    assert.equal(typeof scene.prepare, 'function', `${scene.name}: prepare`);
    assert.ok(STATUSES.includes(scene.status), `${scene.name}: status '${scene.status}'`);
  }
});

test('--only keeps the named scenes in scene order and rejects unknown names', () => {
  const [first, , third] = SCENES.map(scene => scene.name);
  assert.deepEqual(selectScenes(SCENES, `${third},${first}`).map(scene => scene.name), [first, third]);
  assert.equal(selectScenes(SCENES, undefined), SCENES);
  assert.throws(() => selectScenes(SCENES, `${first},nope`), /--only takes .*got 'nope'/);
});

const overflow = (offenders, pageOverflow = offenders.length > 0) => ({ pageOverflow, scrollWidth: 500, viewport: 390, offenders });
const offender = (what, right) => ({ what, right });

test('a clean scene that overflows fails and names its offenders', () => {
  const verdict = judge({ name: 'runs', status: 'clean' }, { error: null, overflow: overflow([offender('nav', 420)]) });
  assert.equal(verdict.ok, false);
  assert.match(verdict.line, /FAIL {3}runs/);
  assert.match(verdict.line, /nav ends at x=420/);
});

test('a known-broken scene only reports; once it passes it says to flip it', () => {
  const broken = judge({ name: 'runs', status: 'known-broken' }, { error: null, overflow: overflow([offender('nav', 420)]) });
  assert.equal(broken.ok, true);
  assert.match(broken.line, /nav ends at x=420/);
  const passing = judge({ name: 'runs', status: 'known-broken' }, { error: null, overflow: overflow([]) });
  assert.equal(passing.ok, true);
  assert.match(passing.line, /flip its status to 'clean'/);
});

test('a prepare that threw fails whatever the status', () => {
  for (const status of STATUSES) {
    const verdict = judge({ name: 'runs', status }, { error: 'timed out', overflow: null });
    assert.equal(verdict.ok, false);
    assert.match(verdict.line, /timed out/);
  }
});

test('at most five offenders are listed', () => {
  const many = Array.from({ length: 8 }, (_, i) => offender(`div${i}`, 400 + i));
  const { line } = judge({ name: 'runs', status: 'clean' }, { error: null, overflow: overflow(many) });
  assert.equal(line.split('\n').filter(l => /ends at/.test(l)).length, MAX_OFFENDERS);
  assert.match(line, /and 3 more/);
});
