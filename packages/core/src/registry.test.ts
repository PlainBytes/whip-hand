import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdapterRegistry, validateWorkflowRunners } from './registry.ts';
import type { Workflow, RunnerAdapter, SpawnSpec } from './types.ts';

function fakeAdapter(id: string, caps: Partial<RunnerAdapter['capabilities']>): RunnerAdapter {
  const spec: SpawnSpec = { argv: [id], cwd: '/', env: {}, interactive: false };
  return {
    id,
    capabilities: {
      sessionIdInjection: false, sessionResume: false,
      toolDenial: false, shareTranscript: false, ...caps,
    },
    detect: async () => ({ installed: true }),
    interactive: () => spec, headless: () => spec, harvest: () => spec,
  };
}

const workflow = (runner: string, mode: 'interactive' | 'headless', writes = false): Workflow => ({
  name: 'r',
  steps: [{ id: 's1', kind: 'agent', runner, mode, writes, prompt: 'p', output: 'o.md' }],
});

test('register/get round-trips and rejects duplicates', () => {
  const reg = new AdapterRegistry();
  const a = fakeAdapter('x', {});
  reg.register(a);
  assert.equal(reg.get('x'), a);
  assert.ok(reg.has('x'));
  assert.throws(() => reg.register(fakeAdapter('x', {})));
  assert.throws(() => reg.get('y'));
});

test('flags unknown runner', () => {
  const reg = new AdapterRegistry();
  const problems = validateWorkflowRunners(workflow('ghost', 'headless', true), reg);
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes('ghost'));
});

test('interactive requires resume-injection pair or transcript sharing', () => {
  const reg = new AdapterRegistry();
  reg.register(fakeAdapter('bare', { toolDenial: true }));
  reg.register(fakeAdapter('resumer', { sessionIdInjection: true, sessionResume: true, toolDenial: true }));
  reg.register(fakeAdapter('sharer', { shareTranscript: true, toolDenial: true }));
  assert.equal(validateWorkflowRunners(workflow('bare', 'interactive'), reg).length, 1);
  assert.equal(validateWorkflowRunners(workflow('resumer', 'interactive'), reg).length, 0);
  assert.equal(validateWorkflowRunners(workflow('sharer', 'interactive'), reg).length, 0);
});

test('writes:false requires toolDenial', () => {
  const reg = new AdapterRegistry();
  reg.register(fakeAdapter('nodeny', {}));
  const problems = validateWorkflowRunners(workflow('nodeny', 'headless', false), reg);
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes('toolDenial') || problems[0].includes('read-only'));
});
