import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const mainPath = fileURLToPath(new URL('./main.ts', import.meta.url));

const FIXTURE_WORKFLOW = `name: x
steps:
  - id: only
    runner: claude
    mode: headless
    writes: false
    output: only.md
    prompt: say hi
`;

test('whiphand run --dry-run --json emits pure NDJSON on stdout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whiphand-json-'));
  await mkdir(join(dir, '.whiphand', 'workflows'), { recursive: true });
  await writeFile(join(dir, '.whiphand', 'workflows', 'x.yaml'), FIXTURE_WORKFLOW);

  const { stdout, stderr } = await execFileAsync(
    process.execPath, [mainPath, 'run', 'x', '--dry-run', '--json', '-C', dir],
  );

  const lines = stdout.split('\n').filter(l => l.length > 0);
  assert.ok(lines.length > 0, 'expected at least one NDJSON line');

  const events = lines.map(line => {
    try {
      return JSON.parse(line);
    } catch (e) {
      throw new Error(`non-JSON line in stdout: ${JSON.stringify(line)} (${(e as Error).message})`);
    }
  });

  const types = events.map(e => e.type);
  assert.ok(types.includes('run:start'), `expected run:start in ${types}`);
  assert.ok(types.includes('step:spawn'), `expected step:spawn in ${types}`);
  assert.ok(types.includes('run:done'), `expected run:done in ${types}`);

  // no stray non-JSON stdout output (e.g. accidental console.log)
  assert.equal(stdout.trimEnd().split('\n').length, lines.length);
  void stderr;
});
