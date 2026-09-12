import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelCatalog } from './model-catalog.ts';
import { AdapterRegistry } from './registry.ts';
import type { AgentStep, DetectResult, ModelList, RunCtx, RunnerAdapter, SpawnSpec } from './types.ts';

const CAPS = { sessionIdInjection: false, sessionResume: false, toolDenial: false, shareTranscript: false };
const NOOP_SPEC: SpawnSpec = { argv: [], cwd: '/', env: {}, interactive: false };

function fakeAdapter(
  id: string,
  opts: { listModels?: () => Promise<ModelList>; calls?: number[] } = {},
): RunnerAdapter {
  return {
    id,
    capabilities: CAPS,
    async detect(): Promise<DetectResult> { return { installed: true }; },
    interactive(_step: AgentStep, _ctx: RunCtx): SpawnSpec { return NOOP_SPEC; },
    headless(_step: AgentStep, _ctx: RunCtx): SpawnSpec { return NOOP_SPEC; },
    harvest(_step: AgentStep, _ctx: RunCtx): SpawnSpec { return NOOP_SPEC; },
    ...(opts.listModels ? { listModels: opts.listModels } : {}),
  };
}

function countingList(models: ModelList, calls: number[]): () => Promise<ModelList> {
  return async () => {
    calls.push(1);
    return models;
  };
}

test('adapters without listModels are omitted from the catalog', async () => {
  const registry = new AdapterRegistry();
  registry.register(fakeAdapter('claude', { listModels: countingList({ source: 'live', models: [{ id: 'sonnet' }] }, []) }));
  registry.register(fakeAdapter('copilot'));

  const catalog = new ModelCatalog(registry);
  const result = await catalog.get();

  assert.deepEqual(Object.keys(result), ['claude']);
});

test('two concurrent get() calls share one probe', async () => {
  const calls: number[] = [];
  const registry = new AdapterRegistry();
  registry.register(fakeAdapter('claude', {
    listModels: async () => {
      calls.push(1);
      await new Promise(r => setTimeout(r, 5));
      return { source: 'live', models: [{ id: 'sonnet' }] };
    },
  }));
  const catalog = new ModelCatalog(registry);

  const [a, b] = await Promise.all([catalog.get(), catalog.get()]);
  assert.equal(calls.length, 1);
  assert.deepEqual(a, b);
});

test('refresh re-probes even with a cached result', async () => {
  const calls: number[] = [];
  const registry = new AdapterRegistry();
  registry.register(fakeAdapter('claude', {
    listModels: countingList({ source: 'live', models: [{ id: 'sonnet' }] }, calls),
  }));
  const catalog = new ModelCatalog(registry);

  await catalog.get();
  await catalog.get();
  assert.equal(calls.length, 1, 'the second get() without refresh reused the cache');

  await catalog.get({ refresh: true });
  assert.equal(calls.length, 2, 'refresh must re-probe');
});

test('invalidate() makes the next get() re-probe', async () => {
  const calls: number[] = [];
  const registry = new AdapterRegistry();
  registry.register(fakeAdapter('claude', {
    listModels: countingList({ source: 'live', models: [{ id: 'sonnet' }] }, calls),
  }));
  const catalog = new ModelCatalog(registry);

  await catalog.get();
  catalog.invalidate();
  await catalog.get();
  assert.equal(calls.length, 2);
});

test('invalidate() during an in-flight probe keeps its stale result out of the cache', async () => {
  const registry = new AdapterRegistry();
  let resolveFirst: ((v: ModelList) => void) | undefined;
  const first = new Promise<ModelList>(r => { resolveFirst = r; });
  let calls = 0;
  registry.register(fakeAdapter('claude', {
    listModels: () => {
      calls += 1;
      return calls === 1 ? first : Promise.resolve({ source: 'live', models: [{ id: 'second' }] });
    },
  }));
  const catalog = new ModelCatalog(registry);

  const stale = catalog.get(); // starts probe A, still pending
  catalog.invalidate(); // bumps the generation while A is in flight
  const fresh = await catalog.get(); // cache/inFlight are both null now: starts probe B
  resolveFirst!({ source: 'live', models: [{ id: 'first' }] }); // A settles last
  await stale;

  const cached = await catalog.get(); // must reuse B's cached result, not spawn a third probe
  assert.deepEqual(cached, fresh);
  assert.deepEqual(cached.claude.models, [{ id: 'second' }]);
  assert.equal(calls, 2, 'A settling after being superseded must not trigger a third probe');
});

test('a fallback/unavailable result is cached too, not re-probed on every call', async () => {
  const calls: number[] = [];
  const registry = new AdapterRegistry();
  registry.register(fakeAdapter('claude', {
    listModels: countingList({ source: 'fallback', models: [{ id: 'sonnet' }], note: 'fell back' }, calls),
  }));
  const catalog = new ModelCatalog(registry);

  await catalog.get();
  await catalog.get();
  assert.equal(calls.length, 1);
});
