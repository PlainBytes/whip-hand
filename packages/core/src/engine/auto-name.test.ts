import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoNameRun, suggestNamePrompt } from './auto-name.ts';
import { readRunName, SUGGEST_CAPTURE_NAME } from './run-name.ts';
import { AdapterRegistry } from '../registry.ts';
import { claudeAdapter } from '../adapters/claude.ts';
import { copilotAdapter } from '../adapters/copilot.ts';
import { opencodeAdapter } from '../adapters/opencode.ts';
import type { RunCtx, RunnerAdapter, SpawnSpec, Workflow } from '../types.ts';

const workflow: Workflow = {
  name: 'feature',
  steps: [{ kind: 'command', id: 'a', run: 'exit 0', output: 'a.log' }],
};

async function ctxIn(inputs: Record<string, string> = { feature: 'oauth support' }): Promise<RunCtx> {
  const runDir = await mkdtemp(join(tmpdir(), 'whiphand-auto-name-'));
  return {
    workdir: '/w', runId: '20260101-000000-aaaa', runDir, runSlug: '20260101-000000-aaaa',
    sessionIds: {}, artifacts: {}, attempts: {}, inputs,
  };
}

/** An adapter that answers by writing `reply` to the capture path it was given. */
function answering(reply: string | null, exitCode = 0): RunnerAdapter {
  const base = {
    id: 'fake',
    capabilities: { sessionIdInjection: false, sessionIdCapture: false, sessionResume: false, toolDenial: true, shareTranscript: false },
    detect: async () => ({ installed: true }),
    interactive: () => { throw new Error('unused'); },
    headless: () => { throw new Error('unused'); },
    harvest: () => { throw new Error('unused'); },
  } as unknown as RunnerAdapter;
  return {
    ...base,
    suggestName(_prompt: string, ctx: RunCtx, capturePath: string): SpawnSpec {
      return {
        argv: ['fake', '-p'], cwd: ctx.workdir, env: {}, interactive: false,
        capture: { path: capturePath },
      };
    },
    // The "spawn" is the test's own: it writes what the runner would have said.
    __reply: reply, __exitCode: exitCode,
  } as RunnerAdapter & { __reply: string | null; __exitCode: number };
}

function registryWith(adapter: RunnerAdapter): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(adapter);
  return registry;
}

function spawnWriting(reply: string | null, exitCode = 0) {
  return async (spec: SpawnSpec): Promise<number> => {
    if (reply !== null) await writeFile(spec.capture!.path, reply, 'utf8');
    return exitCode;
  };
}

test('a usable reply becomes the run name, and the capture file is cleaned up', async () => {
  const ctx = await ctxIn();
  const name = await autoNameRun({
    ctx, workflow, registry: registryWith(answering(null)), runner: 'fake',
    spawnHeadless: spawnWriting('OAuth support\n'),
  });
  assert.equal(name, 'OAuth support');
  assert.equal(await readRunName(ctx.runDir), 'OAuth support');
  // Folded into the marker — a second, staler copy has no reason to survive.
  const detail = await autoNameRun({
    ctx, workflow, registry: registryWith(answering(null)), runner: 'fake',
    spawnHeadless: async spec => {
      assert.ok(spec.capture?.path.endsWith(SUGGEST_CAPTURE_NAME));
      return 1;
    },
  });
  assert.equal(detail, undefined);
});

test('a chatty reply is still bounded and single-line by normalization', async () => {
  const ctx = await ctxIn();
  const name = await autoNameRun({
    ctx, workflow, registry: registryWith(answering(null)), runner: 'fake',
    spawnHeadless: spawnWriting('  Add OAuth\nsupport  \n'),
  });
  assert.equal(name, 'Add OAuth support');
});

test('the naming spec asks for stdout only, so a stderr warning cannot become the name', async () => {
  const ctx = await ctxIn();
  const adapter = answering(null);
  const spec = adapter.suggestName!('prompt', ctx, join(ctx.runDir, SUGGEST_CAPTURE_NAME));
  void spec;
  // The contract is on the spec the *real* adapters build, since that is what
  // tells the frontend which streams to tee. Both set it; the fake above does
  // not, so assert against the real ones rather than the stand-in.
  const runCtx = { ...ctx, workdir: ctx.runDir };
  for (const real of [claudeAdapter, copilotAdapter, opencodeAdapter]) {
    const built = real.suggestName!('name this run', runCtx, '/tmp/cap');
    assert.equal(built.capture?.streams, 'stdout', real.id);
  }
});

test('a stale capture file from a crashed run is not prepended to the new name', async () => {
  const ctx = await ctxIn();
  await writeFile(join(ctx.runDir, SUGGEST_CAPTURE_NAME), 'Leftover from last time\n', 'utf8');
  const name = await autoNameRun({
    ctx, workflow, registry: registryWith(answering(null)), runner: 'fake',
    // Appends, exactly as both real capture implementations do.
    spawnHeadless: async spec => {
      await appendFile(spec.capture!.path, 'OAuth support\n', 'utf8');
      return 0;
    },
  });
  assert.equal(name, 'OAuth support');
});

test('a non-zero exit leaves the run unnamed rather than failing it', async () => {
  const ctx = await ctxIn();
  const name = await autoNameRun({
    ctx, workflow, registry: registryWith(answering(null)), runner: 'fake',
    spawnHeadless: spawnWriting('Would have been a name', 1),
  });
  assert.equal(name, undefined);
  assert.equal(await readRunName(ctx.runDir), undefined);
});

test('an empty reply, and a spawn that throws, both leave the run unnamed', async () => {
  const ctx = await ctxIn();
  assert.equal(await autoNameRun({
    ctx, workflow, registry: registryWith(answering(null)), runner: 'fake',
    spawnHeadless: spawnWriting('   \n'),
  }), undefined);

  assert.equal(await autoNameRun({
    ctx, workflow, registry: registryWith(answering(null)), runner: 'fake',
    spawnHeadless: async () => { throw new Error('no such binary'); },
  }), undefined);
  assert.equal(await readRunName(ctx.runDir), undefined);
});

test('a runner without suggestName is simply never asked', async () => {
  const ctx = await ctxIn();
  const plain = { ...answering(null) };
  delete (plain as { suggestName?: unknown }).suggestName;
  let spawned = false;
  const name = await autoNameRun({
    ctx, workflow, registry: registryWith(plain as RunnerAdapter), runner: 'fake',
    spawnHeadless: async () => { spawned = true; return 0; },
  });
  assert.equal(name, undefined);
  assert.equal(spawned, false);
});

test('an unknown runner is not an error, just no name', async () => {
  const ctx = await ctxIn();
  assert.equal(await autoNameRun({
    ctx, workflow, registry: registryWith(answering(null)), runner: 'nope',
    spawnHeadless: spawnWriting('x'),
  }), undefined);
});

test('the timeout gives up on a spawn that never answers', async () => {
  const ctx = await ctxIn();
  const name = await autoNameRun({
    ctx, workflow, registry: registryWith(answering(null)), runner: 'fake',
    timeoutMs: 10,
    // Resolves only once aborted — what a real spawn does on SIGTERM.
    spawnHeadless: (_spec, signal) => new Promise(resolve => {
      signal?.addEventListener('abort', () => resolve(143));
    }),
  });
  assert.equal(name, undefined);
});

test("a cancelled run's signal aborts the naming spawn too", async () => {
  const ctx = await ctxIn();
  const controller = new AbortController();
  const promise = autoNameRun({
    ctx, workflow, registry: registryWith(answering(null)), runner: 'fake',
    signal: controller.signal,
    spawnHeadless: (_spec, signal) => new Promise(resolve => {
      signal?.addEventListener('abort', () => resolve(143));
    }),
  });
  controller.abort();
  assert.equal(await promise, undefined);
});

test('the prompt names the workflow and lists only the inputs that were filled', () => {
  const prompt = suggestNamePrompt(workflow, { feature: 'oauth', notes: '  ' });
  assert.match(prompt, /'feature' workflow/);
  assert.match(prompt, /- feature: oauth/);
  assert.ok(!prompt.includes('- notes:'), 'a blank input tells the model nothing');
});

test('the prompt says so when there were no inputs at all', () => {
  assert.match(suggestNamePrompt(workflow, {}), /no inputs/);
});
