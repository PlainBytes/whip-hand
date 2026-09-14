import type { Workflow, RunnerAdapter, Step } from './types.ts';
import { flattenSteps, isAgentStep, isManualStep } from './steps.ts';
import { claudeAdapter } from './adapters/claude.ts';
import { copilotAdapter } from './adapters/copilot.ts';
import { opencodeAdapter } from './adapters/opencode.ts';

export class AdapterRegistry {
  #adapters = new Map<string, RunnerAdapter>();

  register(adapter: RunnerAdapter): void {
    if (this.#adapters.has(adapter.id)) throw new Error(`adapter '${adapter.id}' already registered`);
    this.#adapters.set(adapter.id, adapter);
  }
  get(id: string): RunnerAdapter {
    const a = this.#adapters.get(id);
    if (!a) throw new Error(`unknown runner '${id}'`);
    return a;
  }
  has(id: string): boolean { return this.#adapters.has(id); }
  list(): RunnerAdapter[] { return [...this.#adapters.values()]; }
}

export function defaultRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(claudeAdapter);
  registry.register(copilotAdapter);
  registry.register(opencodeAdapter);
  return registry;
}

/**
 * Pre-flight capability gate. Only agent steps name a runner — a command or a
 * manual step has nothing to check here, since asking the registry about
 * their absent `runner` would throw before the run even started.
 */
export function validateWorkflowRunners(workflow: Workflow, registry: AdapterRegistry): string[] {
  const problems: string[] = [];
  for (const step of allSteps(workflow)) {
    if (!isAgentStep(step)) continue;
    if (!registry.has(step.runner)) {
      problems.push(`step '${step.id}': unknown runner '${step.runner}'`);
      continue;
    }
    const caps = registry.get(step.runner).capabilities;
    if (step.mode === 'interactive') {
      const viaResume = (caps.sessionIdInjection || caps.sessionIdCapture) && caps.sessionResume;
      if (!viaResume && !caps.shareTranscript) {
        problems.push(
          `step '${step.id}': runner '${step.runner}' cannot harvest an interactive session ` +
          `(needs (sessionIdInjection or sessionIdCapture)+sessionResume or shareTranscript)`);
      }
    }
    if (!step.writes && !caps.toolDenial) {
      problems.push(`step '${step.id}': runner '${step.runner}' lacks toolDenial, cannot enforce read-only`);
    }
  }
  return problems;
}

function allSteps(workflow: Workflow): Step[] {
  return flattenSteps(workflow.steps).map(f => f.step);
}

/**
 * A workflow that stops to ask a human can only run on a frontend that can ask.
 * Checked up front, like every other capability mismatch, so the run never
 * gets half way through and then discovers it has nobody to talk to.
 */
export function validateWorkflowFrontend(
  workflow: Workflow, frontend: { runManual?: unknown },
): string[] {
  if (frontend.runManual !== undefined) return [];
  return allSteps(workflow)
    .filter(isManualStep)
    .map(step => `step '${step.id}': this frontend cannot run ${step.kind} steps (no runManual)`);
}
