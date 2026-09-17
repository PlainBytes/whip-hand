import { describe, expect, it } from 'vitest';
import {
  actorOf, dataFlow, endsLoop, loopRule, ordinals, purposeOf, stagesRule,
} from './step-describe.ts';
import type {
  AgentStep, CommandStep, LoopStep, ManualStep, StagesStep, Step,
} from '../../../../packages/core/src/types.ts';

function agent(id: string, overrides: Partial<AgentStep> = {}): AgentStep {
  return {
    kind: 'agent', id, runner: 'claude', mode: 'headless', writes: false, prompt: 'Do the thing.', output: `${id}.md`, ...overrides,
  };
}
function command(id: string, overrides: Partial<CommandStep> = {}): CommandStep {
  return { kind: 'command', id, run: `echo ${id}`, ...overrides };
}
function manual(id: string, kind: 'manual' | 'approval' = 'approval', overrides: Partial<ManualStep> = {}): ManualStep {
  return {
    kind, id, title: `Title for ${id}`, instructions: 'Look at this.', ...overrides,
  };
}
function loop(id: string, steps: Step[], overrides: Partial<LoopStep> = {}): LoopStep {
  return {
    kind: 'loop', id, until: steps[0]?.id ?? '', steps, ...overrides,
  };
}

describe('actorOf', () => {
  it('an interactive agent is chat', () => {
    expect(actorOf(agent('plan', { mode: 'interactive' }))).toBe('chat');
  });
  it('a headless agent is auto', () => {
    expect(actorOf(agent('execute', { mode: 'headless' }))).toBe('auto');
  });
  it('an approval step is decide', () => {
    expect(actorOf(manual('sign', 'approval'))).toBe('decide');
  });
  it('a manual step is decide', () => {
    expect(actorOf(manual('note', 'manual'))).toBe('decide');
  });
  it('a command step is shell', () => {
    expect(actorOf(command('build'))).toBe('shell');
  });
});

describe('purposeOf', () => {
  it('an approval/manual step is its title', () => {
    expect(purposeOf(manual('sign', 'approval', { title: 'Ship it?' }))).toBe('Ship it?');
  });

  it('an agent step is the first sentence of its prompt', () => {
    expect(purposeOf(agent('review', { prompt: 'Review the implementation against the attached plan.' })))
      .toBe('Review the implementation against the attached plan.');
  });

  it('folds a multi-line prompt to one line and stops at the first sentence', () => {
    const prompt = 'We are planning: {{ inputs.feature }}. Work with me on a plan.\n\nDo not modify files.';
    expect(purposeOf(agent('plan', { prompt }))).toBe('We are planning: {{ inputs.feature }}.');
  });

  it('leaves {{ }} templates written as-is', () => {
    const prompt = 'Implement {{ inputs.feature }} on top of {{ inputs.base }}.';
    expect(purposeOf(agent('execute', { prompt }))).toBe('Implement {{ inputs.feature }} on top of {{ inputs.base }}.');
  });

  it('falls back to the whole collapsed prompt when there is no sentence terminator', () => {
    expect(purposeOf(agent('go', { prompt: 'Just go\n\nfast' }))).toBe('Just go fast');
  });

  it('a command step is its run: line', () => {
    expect(purposeOf(command('stage', { run: 'git add -A' }))).toBe('git add -A');
  });
});

describe('loopRule', () => {
  it('reads "passes" for a verdict step target', () => {
    const review = agent('review', { verdict: true });
    const fix = loop('fix', [agent('execute'), review], { until: 'review', max_iterations: 3 });
    expect(loopRule(fix, [fix])).toEqual({ until: 'review', verb: 'passes', max: 3 });
  });

  it('reads "approves" for an approval/manual target', () => {
    const signOff = manual('sign-off', 'approval');
    const humanReview = loop('human-review', [agent('execute'), signOff], { until: 'sign-off' });
    expect(loopRule(humanReview, [humanReview])).toEqual({ until: 'sign-off', verb: 'approves' });
  });

  it('omits max when max_iterations is unset', () => {
    const review = agent('review', { verdict: true });
    const fix = loop('fix', [review], { until: 'review', max_iterations: undefined });
    expect(loopRule(fix, [fix]).max).toBeUndefined();
  });
});

describe('ordinals', () => {
  it('numbers top-level steps in order', () => {
    const steps = [agent('a'), agent('b'), agent('c')];
    const map = ordinals(steps);
    expect(map.get('a')).toBe('1');
    expect(map.get('b')).toBe('2');
    expect(map.get('c')).toBe('3');
  });

  it("feature-development's doubly nested loop numbers 4, 4.1, 4.1.1, 4.1.2, 4.2, 5", () => {
    const execute = agent('execute');
    const review = agent('review', { verdict: true });
    const doReview = loop('do-review', [execute, review], { until: 'review', max_iterations: 10 });
    const signOff = manual('sign-off', 'approval');
    const humanReview = loop('human-review', [doReview, signOff], { until: 'sign-off', max_iterations: 5 });
    const steps = [
      command('sync-base'), command('branch'), agent('plan', { mode: 'interactive' }),
      humanReview, command('stage'),
    ];
    const map = ordinals(steps);
    expect(map.get('sync-base')).toBe('1');
    expect(map.get('branch')).toBe('2');
    expect(map.get('plan')).toBe('3');
    expect(map.get('human-review')).toBe('4');
    expect(map.get('do-review')).toBe('4.1');
    expect(map.get('execute')).toBe('4.1.1');
    expect(map.get('review')).toBe('4.1.2');
    expect(map.get('sign-off')).toBe('4.2');
    expect(map.get('stage')).toBe('5');
  });
});

describe('dataFlow', () => {
  it('records sources and dependents from inputs, excluding attachments', () => {
    const plan = agent('plan', { inputs: ['attachments'] });
    const execute = agent('execute', { inputs: ['plan'] });
    const steps = [plan, execute];
    const map = dataFlow(steps);
    expect(map.get('plan')?.sources).toEqual([]);
    expect(map.get('execute')?.sources).toEqual(['plan']);
    expect(map.get('plan')?.dependents).toEqual(['execute']);
  });

  it('ignores a dangling reference to a step that does not exist', () => {
    const execute = agent('execute', { inputs: ['ghost'] });
    const map = dataFlow([execute]);
    expect(map.get('execute')?.sources).toEqual([]);
  });

  it('flags a read of a later sibling in the same loop body as a previous-iteration read', () => {
    const execute = agent('execute', { inputs: ['review'] });
    const review = agent('review', { inputs: ['execute'], verdict: true });
    const fix = loop('fix', [execute, review], { until: 'review' });
    const map = dataFlow([fix]);
    expect(map.get('execute')?.previousIteration).toEqual(['review']);
    // review reads execute, which comes *before* it in the same body — not previous-iteration.
    expect(map.get('review')?.previousIteration).toEqual([]);
  });

  it("flags a read across nesting levels, using feature-development's shape", () => {
    const execute = agent('execute', { inputs: ['plan', 'review', 'sign-off'] });
    const review = agent('review', { inputs: ['execute'], verdict: true });
    const doReview = loop('do-review', [execute, review], { until: 'review', max_iterations: 10 });
    const signOff = manual('sign-off', 'approval');
    const humanReview = loop('human-review', [doReview, signOff], { until: 'sign-off', max_iterations: 5 });
    const commitMessage = agent('commit-message', { inputs: ['review'] });
    const map = dataFlow([humanReview, commitMessage]);
    // execute reads sign-off, its outer loop's later sibling — previous iteration.
    expect(map.get('execute')?.previousIteration).toContain('sign-off');
    // execute also reads review, later in the same immediate body — previous iteration.
    expect(map.get('execute')?.previousIteration).toContain('review');
    // commit-message is outside every loop, so it shares no loop with review.
    expect(map.get('commit-message')?.previousIteration).toEqual([]);
  });

  it('does not flag a read across different loop bodies, or from outside a loop', () => {
    const plan = agent('plan');
    const a1 = agent('a1', { inputs: ['plan'] });
    const loopA = loop('loop-a', [a1], { until: 'a1' });
    const b1 = agent('b1', { inputs: ['a1'] });
    const loopB = loop('loop-b', [b1], { until: 'b1' });
    const map = dataFlow([plan, loopA, loopB]);
    expect(map.get('a1')?.previousIteration).toEqual([]);
    expect(map.get('b1')?.previousIteration).toEqual([]);
  });
});

describe('endsLoop', () => {
  it('is true for the step named by the enclosing loop\'s until:', () => {
    const review = agent('review', { verdict: true });
    const fix = loop('fix', [agent('execute'), review], { until: 'review' });
    expect(endsLoop(review, fix)).toBe(true);
    expect(endsLoop(agent('execute'), fix)).toBe(false);
  });

  it('is false with no enclosing loop', () => {
    expect(endsLoop(agent('review'), undefined)).toBe(false);
  });
});

describe('a stages step', () => {
  const stages = (id: string, steps: Step[], overrides: Partial<StagesStep> = {}): StagesStep => ({
    kind: 'stages', id, items: 'docs/plan/*.md', steps, ...overrides,
  });

  it('stagesRule reads "once per stage file", with the glob and any retry budget', () => {
    expect(stagesRule(stages('build', [agent('impl')], { max_retries: 3 })))
      .toEqual({ phrase: 'once per stage file', items: 'docs/plan/*.md', maxRetries: 3 });
    expect(stagesRule(stages('build', [agent('impl')])).maxRetries).toBeUndefined();
  });

  it('numbers its body underneath it, like a loop', () => {
    const map = ordinals([agent('plan'), stages('build', [agent('impl'), loop('fix', [agent('review')])]), agent('done')]);
    expect(map.get('build')).toBe('2');
    expect(map.get('impl')).toBe('2.1');
    expect(map.get('fix')).toBe('2.2');
    expect(map.get('review')).toBe('2.2.1');
    expect(map.get('done')).toBe('3');
  });

  it('links reads inside its body, and never calls a later body step a previous iteration', () => {
    const impl = agent('impl', { inputs: ['plan', 'check'] });
    const check = agent('check', { inputs: ['impl'] });
    const map = dataFlow([agent('plan'), stages('build', [impl, check])]);
    expect(map.get('impl')?.sources).toEqual(['plan', 'check']);
    expect(map.get('plan')?.dependents).toEqual(['impl']);
    expect(map.get('impl')?.previousIteration).toEqual([]);
    expect(map.has('build')).toBe(false);
  });
});
