import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { discoverStages, nextStage, oddStageNames, StageError, stageTitleOf } from './stages.ts';
import type { Stage } from '../types.ts';

async function tmpPlanDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-stages-'));
  await mkdir(join(dir, 'plans'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, 'plans', name), content);
  }
  return dir;
}

function stage(id: string, index: number): Stage {
  return { index, total: 0, id, title: id, path: `/plans/${id}.md` };
}

test('a match that is a directory is a StageError naming it, not a raw EISDIR', async () => {
  const dir = await tmpPlanDir({ '01-schema.md': '# Schema\n' });
  await mkdir(join(dir, 'plans', '02-assets'));
  await assert.rejects(discoverStages(dir, 'plans/*'),
    (e: Error) => e instanceof StageError && e.message === "stage file 'plans/02-assets' is a directory, not a stage file");
});

test('stages are ordered by path, and an inserted 03a sorts between 03 and 04', async () => {
  const dir = await tmpPlanDir({
    '01-schema.md': '# Schema\n', '03-api.md': '# API\n',
    '03a-api.md': '# API routes\n', '04-ui.md': '# UI\n',
  });
  const stages = await discoverStages(dir, 'plans/*.md');
  assert.deepEqual(stages.map(s => s.id), ['01-schema', '03-api', '03a-api', '04-ui']);
  assert.deepEqual(stages.map(s => s.index), [1, 2, 3, 4]);
  assert.equal(stages[0]?.total, 4);
  assert.ok(stages.every(s => isAbsolute(s.path)));
});

test('the id is the whole basename, so two stages of the same topic never collide', async () => {
  const dir = await tmpPlanDir({ '01-api.md': '# One\n', '03a-api.md': '# Two\n' });
  const stages = await discoverStages(dir, 'plans/*.md');
  assert.deepEqual(stages.map(s => s.id), ['01-api', '03a-api']);
});

test('the title is the first markdown heading, falling back to the id', async () => {
  const dir = await tmpPlanDir({ '01-a.md': 'preamble\n\n#  Add API routes  \n\nbody\n', '02-b.md': 'no heading\n' });
  const stages = await discoverStages(dir, 'plans/*.md');
  assert.equal(stages[0]?.title, 'Add API routes');
  assert.equal(stages[1]?.title, '02-b');
});

test('a filename that would corrupt an execution key is refused by name', async () => {
  const dir = await tmpPlanDir({ '01-a@b.md': '# x\n' });
  await assert.rejects(() => discoverStages(dir, 'plans/*.md'),
    /stage file '01-a@b\.md': a stage name cannot contain '@', '#', '\/' or '\\'/);
});

test('nextStage takes the first id not already completed, wherever it was inserted', () => {
  const stages = [stage('01-schema', 1), stage('02-api', 2), stage('03-ui', 3)];
  assert.equal(nextStage(stages, new Set(['01-schema']))?.id, '02-api');
  assert.equal(nextStage(stages, new Set(['01-schema', '02-api', '03-ui'])), undefined);
  assert.equal(nextStage([stage('00-intro', 1), ...stages], new Set(['01-schema']))?.id, '00-intro');
});

test('an unpadded ordinal is reported so a 9/10 mis-sort is visible', () => {
  assert.deepEqual(oddStageNames([stage('9-a', 1), stage('10-b', 2), stage('notes', 3)]), ['notes']);
});

test('an empty match is an empty list, not an error', async () => {
  assert.deepEqual(await discoverStages(await tmpPlanDir({}), 'plans/*.md'), []);
});

test('stageTitleOf takes the first heading, trimmed, else the fallback', () => {
  assert.equal(stageTitleOf('preamble\n\n#  Add API routes  \n\nbody\n', 'fallback'), 'Add API routes');
  assert.equal(stageTitleOf('no heading here\n', 'fallback'), 'fallback');
});
