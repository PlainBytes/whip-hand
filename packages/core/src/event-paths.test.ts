import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventPathsToWorkspace } from './event-paths.ts';
import { toNative } from './path-form.ts';
import type { SpawnSpec, WhiphandEvent } from './types.ts';

const ROOT = '/ws/proj';

test('step:artifact and step:artifact-missing carry a workspace-relative path', () => {
  const artifact = eventPathsToWorkspace(
    { type: 'step:artifact', stepId: 'a', path: '/ws/proj/.whiphand/runs/r1/a.md', bytes: 3 }, ROOT);
  assert.deepEqual(artifact, { type: 'step:artifact', stepId: 'a', path: '.whiphand/runs/r1/a.md', bytes: 3 });
  const missing = eventPathsToWorkspace(
    { type: 'step:artifact-missing', stepId: 'a', path: '/ws/proj/.whiphand/runs/r1/a.md', reason: 'absent' }, ROOT);
  assert.deepEqual(missing, {
    type: 'step:artifact-missing', stepId: 'a', path: '.whiphand/runs/r1/a.md', reason: 'absent',
  });
});

test('a path with no relative form keeps the absolute forward-slash fallback', () => {
  const outside = eventPathsToWorkspace({ type: 'step:artifact', stepId: 'a', path: '/elsewhere/a.md' }, ROOT);
  assert.equal(outside.type === 'step:artifact' && outside.path, '/elsewhere/a.md');
  const otherDrive = eventPathsToWorkspace(
    { type: 'step:artifact', stepId: 'a', path: 'D:\\runs\\a.md' }, 'C:\\Proj');
  assert.equal(otherDrive.type === 'step:artifact' && otherDrive.path, 'D:/runs/a.md');
});

test('a Windows-shaped root and native paths come out relative with /', () => {
  const root = 'C:\\Proj';
  const artifact = eventPathsToWorkspace(
    { type: 'step:artifact', stepId: 'a', path: 'C:\\Proj\\.whiphand\\runs\\r1\\a.md' }, root);
  assert.equal(artifact.type === 'step:artifact' && artifact.path, '.whiphand/runs/r1/a.md');
  // case-insensitive on a Windows-shaped path, and it resolves back to the native form
  const cased = eventPathsToWorkspace(
    { type: 'step:artifact', stepId: 'a', path: 'c:\\proj\\Sub\\a.md' }, root);
  assert.equal(cased.type === 'step:artifact' && cased.path, 'Sub/a.md');
  assert.equal(toNative('.whiphand/runs/r1/a.md', root), 'C:\\Proj\\.whiphand\\runs\\r1\\a.md');
});

test('converting is idempotent: an already-relative path is left alone', () => {
  const once = eventPathsToWorkspace({ type: 'step:artifact', stepId: 'a', path: '/ws/proj/x/a.md' }, ROOT);
  assert.deepEqual(eventPathsToWorkspace(once, ROOT), once);
});

test('step:spawn records every path field of the spec relative to the workspace, argv and env untouched', () => {
  const spec: SpawnSpec = {
    argv: ['claude', '--settings', '/home/u/.config/whiphand/s.json', 'go'],
    cwd: ROOT,
    env: { WHIPHAND_RUN_DIR: '/ws/proj/.whiphand/runs/r1' },
    interactive: true,
    endSession: { markerPath: '/ws/proj/.whiphand/runs/r1/.a.done', quitSequence: 'q' },
    awaitState: { statePath: '/ws/proj/.whiphand/runs/r1/.a.await' },
    capture: { path: '/ws/proj/.whiphand/runs/r1/a.log', streams: 'both' },
    files: [{ path: '/ws/proj/.whiphand/runs/r1/.a.prompt', content: 'hi' }],
    stdinFile: '/ws/proj/.whiphand/runs/r1/.a.prompt',
  };
  const event: WhiphandEvent = { type: 'step:spawn', stepId: 'a', spec, phase: 'main' };
  const recorded = eventPathsToWorkspace(event, ROOT);
  assert.ok(recorded.type === 'step:spawn');
  assert.deepEqual(recorded.spec, {
    argv: spec.argv, env: spec.env, interactive: true,
    cwd: '.',
    endSession: { markerPath: '.whiphand/runs/r1/.a.done', quitSequence: 'q' },
    awaitState: { statePath: '.whiphand/runs/r1/.a.await' },
    capture: { path: '.whiphand/runs/r1/a.log', streams: 'both' },
    files: [{ path: '.whiphand/runs/r1/.a.prompt', content: 'hi' }],
    stdinFile: '.whiphand/runs/r1/.a.prompt',
  });
  // the spec handed to the OS is a different object and stays native
  assert.equal(spec.cwd, ROOT);
  assert.equal(spec.files![0].path, '/ws/proj/.whiphand/runs/r1/.a.prompt');
});

test('optional spawn fields stay absent rather than becoming undefined keys', () => {
  const spec: SpawnSpec = { argv: ['x'], cwd: ROOT, env: {}, interactive: false };
  const recorded = eventPathsToWorkspace({ type: 'step:spawn', stepId: 'a', spec, phase: 'main' }, ROOT);
  assert.ok(recorded.type === 'step:spawn');
  assert.deepEqual(Object.keys(recorded.spec).sort(), ['argv', 'cwd', 'env', 'interactive']);
});

test('events with no path field are returned as they came', () => {
  const event: WhiphandEvent = { type: 'step:done', stepId: 'a', exitCode: 0 };
  assert.equal(eventPathsToWorkspace(event, ROOT), event);
});
