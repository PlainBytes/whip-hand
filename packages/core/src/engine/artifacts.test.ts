import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRunDir, artifactPath, ensureArtifactDir, assertArtifact, ArtifactError,
} from './artifacts.ts';
import type { AgentStep, LoopFrame, StageFrame } from '../types.ts';

test('createRunDir creates a unique absolute run dir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-'));
  const a = await createRunDir(dir, '.whiphand/runs');
  const b = await createRunDir(dir, '.whiphand/runs');
  assert.notEqual(a.runId, b.runId);
  assert.ok(a.runDir.startsWith(dir));
  assert.ok((await stat(a.runDir)).isDirectory());
  assert.match(a.runId, /^\d{8}-\d{6}-[0-9a-f]{4}$/);
});

test('artifactPath joins run dir and output name', () => {
  const step: AgentStep = {
    kind: 'agent', id: 'p', runner: 'claude', mode: 'headless', writes: false,
    prompt: 'x', output: 'plan.md',
  };
  assert.equal(artifactPath('/r', step), join('/r', 'plan.md'));
});

test('artifactPath gives each loop iteration its own directory', () => {
  const step = { output: 'report.md' };
  assert.equal(artifactPath('/r', step, { id: 'fix', iteration: 1, maxIterations: 3 }),
    join('/r', 'fix', 'iter-1', 'report.md'));
  assert.equal(artifactPath('/r', step, { id: 'fix', iteration: 2, maxIterations: 3 }),
    join('/r', 'fix', 'iter-2', 'report.md'));
});

test('a stage frame gets one directory per stage and attempt', () => {
  const stage = { index: 2, total: 7, id: '02-api', title: 'T', path: '/p/02-api.md' };
  const f: StageFrame = { kind: 'stages', id: 'build', stage, attempt: 1, maxAttempts: 3 };
  assert.equal(artifactPath('/run', { output: 'accept.md' }, f),
    join('/run', 'build', '02-api', 'attempt-1', 'accept.md'));
  const loop: LoopFrame = { id: 'cycle', iteration: 1, maxIterations: 3, parent: { ...f, attempt: 2 } };
  assert.equal(artifactPath('/run', { output: 'execute-report.md' }, loop),
    join('/run', 'build', '02-api', 'attempt-2', 'cycle', 'iter-1', 'execute-report.md'));
});

test('ensureArtifactDir creates the parent directory of a nested artifact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-'));
  const nested = join(dir, 'fix', 'iter-2', 'report.md');
  await ensureArtifactDir(nested);
  assert.ok((await stat(join(dir, 'fix', 'iter-2'))).isDirectory());
});

test('assertArtifact accepts non-empty, rejects missing and empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-'));
  const good = join(dir, 'good.md');
  await writeFile(good, '# plan\n');
  await assertArtifact(good); // no throw
  await assert.rejects(assertArtifact(join(dir, 'missing.md')), ArtifactError);
  const empty = join(dir, 'empty.md');
  await writeFile(empty, '  \n');
  await assert.rejects(assertArtifact(empty), (e: unknown) =>
    e instanceof ArtifactError && e.message.includes(empty));
});
