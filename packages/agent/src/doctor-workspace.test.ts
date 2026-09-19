import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doctorParams } from './protocol.ts';

test('doctor params: no workdir is still a valid machine-level request; a workdir is accepted, an empty one is not', () => {
  assert.deepEqual(doctorParams.parse(undefined), {});
  assert.deepEqual(doctorParams.parse({}), {});
  assert.deepEqual(doctorParams.parse({ workdir: '/w' }), { workdir: '/w' });
  assert.equal(doctorParams.safeParse({ workdir: '' }).success, false);
});
