import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate, buildPrompt, TemplateError } from './template.ts';
import type { AgentStep, RunCtx } from './types.ts';

import type { TemplateScope } from './template.ts';

/** The minimum a template needs: inputs plus the run's own identity. */
const scope = (over: Partial<TemplateScope> = {}): TemplateScope =>
  ({ inputs: {}, runId: '20260101-000000-aaaa', runSlug: '20260101-000000-aaaa', ...over });

test('replaces input placeholders, whitespace-tolerant', () => {
  const s = scope({ inputs: { feature: 'oauth' } });
  assert.equal(renderTemplate('build {{ inputs.feature }} now', s), 'build oauth now');
  assert.equal(renderTemplate('build {{inputs.feature}}', s), 'build oauth');
});

test('throws on unknown input key', () => {
  assert.throws(() => renderTemplate('{{ inputs.missing }}', scope()), TemplateError);
});

test('leaves non-placeholder braces alone', () => {
  assert.equal(renderTemplate('code { x: 1 }', scope()), 'code { x: 1 }');
});

test('run.* resolves the run name, slug and id', () => {
  const s = scope({ runName: 'OAuth support', runSlug: 'oauth-support' });
  assert.equal(renderTemplate('{{ run.name }}', s), 'OAuth support');
  assert.equal(renderTemplate('{{run.slug}}', s), 'oauth-support');
  assert.equal(renderTemplate('{{ run.id }}', s), '20260101-000000-aaaa');
});

test('an unnamed run reads as its id, and its slug is that id', () => {
  const s = scope();
  assert.equal(renderTemplate('{{ run.name }}/{{ run.slug }}', s),
    '20260101-000000-aaaa/20260101-000000-aaaa');
});

test('run.* is available outside a loop, unlike loop.*', () => {
  assert.equal(renderTemplate('{{ run.id }}', scope()), '20260101-000000-aaaa');
  assert.throws(() => renderTemplate('{{ loop.iteration }}', scope()), TemplateError);
});

test('an unknown run.* reference is left alone rather than throwing', () => {
  assert.equal(renderTemplate('{{ run.nope }}', scope()), '{{ run.nope }}');
});

const ctx: RunCtx = {
  workdir: '/w', runId: 'r1', runDir: '/w/.whiphand/runs/r1', runSlug: 'r1',
  sessionIds: {}, artifacts: { plan: '/w/.whiphand/runs/r1/plan.md' }, attempts: {}, verdicts: {},
  inputs: { feature: 'oauth' },
};

test('buildPrompt appends artifact section for steps with inputs', () => {
  const step: AgentStep = { kind: 'agent',
    id: 'execute', runner: 'copilot', mode: 'headless', writes: true,
    prompt: 'Implement {{ inputs.feature }}.', inputs: ['plan'], output: 'report.md',
  };
  const p = buildPrompt(step, ctx);
  assert.ok(p.startsWith('Implement oauth.'));
  assert.ok(p.includes('## Input artifacts'));
  assert.ok(p.includes('- plan: /w/.whiphand/runs/r1/plan.md'));
});

test('buildPrompt omits artifact section when step has no inputs', () => {
  const step: AgentStep = { kind: 'agent',
    id: 'plan', runner: 'claude', mode: 'interactive', writes: false,
    prompt: 'Plan it.', output: 'plan.md',
  };
  assert.equal(buildPrompt(step, ctx), 'Plan it.');
});

test('buildPrompt expands attachments to one line per attached file', () => {
  const step: AgentStep = { kind: 'agent',
    id: 'plan', runner: 'claude', mode: 'headless', writes: false,
    prompt: 'Plan it.', inputs: ['attachments'], output: 'plan.md',
  };
  const withFiles: RunCtx = {
    ...ctx,
    attachments: ['/w/.whiphand/runs/r1/attachments/bug.png', '/w/.whiphand/runs/r1/attachments/server.log'],
  };
  assert.equal(buildPrompt(step, withFiles), 'Plan it.\n\n## Input artifacts (read these files first)\n'
    + '- attachments/bug.png: /w/.whiphand/runs/r1/attachments/bug.png\n'
    + '- attachments/server.log: /w/.whiphand/runs/r1/attachments/server.log');
});

test('buildPrompt labels an input artifact with its verdict, pass or fail', () => {
  const step: AgentStep = { kind: 'agent',
    id: 'execute', runner: 'claude', mode: 'headless', writes: true,
    prompt: 'Fix it.', inputs: ['plan', 'tests'], output: 'report.md',
  };
  const failing: RunCtx = {
    ...ctx,
    artifacts: { ...ctx.artifacts, tests: '/w/.whiphand/runs/r1/tests.log' },
    verdicts: { tests: 'fail' },
  };
  assert.equal(buildPrompt(step, failing), 'Fix it.\n\n## Input artifacts (read these files first)\n'
    + '- plan: /w/.whiphand/runs/r1/plan.md\n'
    + '- tests: /w/.whiphand/runs/r1/tests.log (VERDICT: FAIL)');

  const passing: RunCtx = { ...failing, verdicts: { tests: 'pass' } };
  assert.equal(buildPrompt(step, passing), 'Fix it.\n\n## Input artifacts (read these files first)\n'
    + '- plan: /w/.whiphand/runs/r1/plan.md\n'
    + '- tests: /w/.whiphand/runs/r1/tests.log (VERDICT: PASS)');
});

test('buildPrompt leaves attachments unlabelled even when a verdict is recorded under that name', () => {
  const step: AgentStep = { kind: 'agent',
    id: 'plan', runner: 'claude', mode: 'headless', writes: false,
    prompt: 'Plan it.', inputs: ['attachments'], output: 'plan.md',
  };
  const withFiles: RunCtx = {
    ...ctx,
    attachments: ['/w/.whiphand/runs/r1/attachments/bug.png'],
    verdicts: { 'attachments/bug.png': 'fail' },
  };
  assert.equal(buildPrompt(step, withFiles), 'Plan it.\n\n## Input artifacts (read these files first)\n'
    + '- attachments/bug.png: /w/.whiphand/runs/r1/attachments/bug.png');
});

test('buildPrompt lists nothing for attachments when the run has none', () => {
  const step: AgentStep = { kind: 'agent',
    id: 'execute', runner: 'claude', mode: 'headless', writes: true,
    prompt: 'Do it.', inputs: ['attachments', 'plan'], output: 'report.md',
  };
  assert.equal(buildPrompt(step, ctx),
    'Do it.\n\n## Input artifacts (read these files first)\n- plan: /w/.whiphand/runs/r1/plan.md');
  assert.equal(buildPrompt({ ...step, inputs: ['attachments'] }, ctx), 'Do it.');
});
