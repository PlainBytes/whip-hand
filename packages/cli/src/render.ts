/**
 * Renders core's event stream to the terminal.
 *
 * A factory, not a bare function: a headless step's progress arrives as many
 * small events and has to be summarised when the step ends, so the renderer
 * needs to hold state across calls. The sinks and clock are injectable so
 * the output can be asserted directly.
 *
 * Deliberately no cursor control: `whiphand run` output is routinely piped to a
 * file or read by CI, and an in-place spinner would corrupt both.
 */
import { basename, join } from 'node:path';
import {
  ATTACHMENTS_DIR, degradationLine, formatBytes, formatElapsed, mergeUsage, nestedPrefix, progressActionText, usageParts,
} from '@whiphand/core';
import type { UsageCounters, WhiphandEvent } from '@whiphand/core';

export interface RenderSinks {
  out: (line: string) => void;
  err: (line: string) => void;
  now: () => number;
}

export interface RenderOptions {
  /**
   * Set for a dry run: where a run's directory is. A dry run copies no
   * attachments, so this is how it still says where each one would have gone.
   */
  runDirOf?: (runId: string) => string;
  /**
   * Set for a dry run: print each prompt file's content under the spawn line.
   * Prompts travel in files now (stdin or an argv pointer), so without this a
   * dry run — whose whole point is to show what would be sent — would show a
   * pointer and nothing else.
   */
  showPrompts?: boolean;
}

/** What a headless step has told us so far, cleared when it finishes. */
interface StepTally extends UsageCounters {
  startedMs: number;
}

/** Loop bodies are indented so a cycle reads as a cycle, not a flat replay. */
function stepLine(event: Extract<WhiphandEvent, { type: 'step:start' }>): string {
  const indent = event.loopId === undefined ? '' : '  ';
  const detail = event.kind === 'agent'
    ? `${event.runner}${event.model ? ' · ' + event.model : ''}, ${event.mode}`
    : event.kind;
  return `${indent}→ step ${event.stepId} (${detail})`;
}

/**
 * Elapsed time is always known because we measure it ourselves; everything
 * else depends on what the runner chose to report, so an absent counter is
 * omitted rather than printed as a zero.
 */
function summary(tally: StepTally, nowMs: number): string {
  const parts = usageParts(tally, usd => `$${usd.toFixed(2)}`);
  // Elapsed sits right after turns (first when there are none): how long and
  // how many rounds read together, spend after them.
  parts.splice(tally.turns === undefined ? 0 : 1, 0, formatElapsed(nowMs - tally.startedMs));
  return `  ${parts.join(' · ')}`;
}

export function createRenderer(
  sinks: Partial<RenderSinks> = {}, opts: RenderOptions = {},
): (event: WhiphandEvent) => void {
  const out = sinks.out ?? ((line: string) => console.log(line));
  // Both warnings and errors go to stderr.
  const err = sinks.err ?? ((line: string) => console.error(line));
  const now = sinks.now ?? Date.now;

  // Only headless agent steps get an entry: they run silently otherwise. A
  // command step streams its own output as it goes.
  const tallies = new Map<string, StepTally>();

  // Keyed by the stages step's own id, holding its current stage's index/total — see 'stages:accepted' below.
  const stagePositions = new Map<string, { index: number; total: number }>();

  const degraded: Array<Extract<WhiphandEvent, { type: 'run:degraded' }>> = [];
  let runEnded = false;

  /** The run's label, when it has one. The id stays: `--resume` takes that. */
  const named = (name: string | undefined): string => (name === undefined ? '' : ` "${name}"`);

  return function render(event: WhiphandEvent): void {
    switch (event.type) {
      case 'run:start': {
        // Silent for the common (project) case; a global resolution is worth
        // a mention but not a separate warning line on every single run.
        out(`whiphand run ${event.runId}${named(event.name)} — workflow '${event.workflow}'`
          + (event.source === 'global' ? ' (global)' : ''));
        const attached = event.attachments ?? [];
        if (attached.length === 0) return;
        // The final names, which may differ from what was typed: sanitized,
        // and suffixed when two files would otherwise collide.
        out(`📎 ${attached.map(a => `${a.name} ${formatBytes(a.size)}`).join(' · ')}`);
        const runDir = opts.runDirOf?.(event.runId);
        if (runDir === undefined) return;
        for (const a of attached) out(`  → ${join(runDir, ATTACHMENTS_DIR, a.name)}`);
        return;
      }
      case 'run:resume':
        return out(`whiphand resume ${event.runId}${named(event.name)} — workflow '${event.workflow}'`
          + (event.from === undefined ? '' : `, from step '${event.from}'`)
          + (event.iteration === undefined ? '' : ` (iteration ${event.iteration})`));
      case 'step:skipped':
        // Reported rather than silent: a resumed run that printed nothing for
        // its first three steps would look like it had lost them.
        return out(`${event.loopId === undefined ? '' : '  '}↷ step ${event.stepId} (reused)`);
      case 'step:start':
        if (event.mode === 'headless') tallies.set(event.stepId, { startedMs: now() });
        return out(stepLine(event));
      case 'step:spawn': {
        out(`  $ ${event.spec.argv.map(a => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`);
        if (opts.showPrompts === true) {
          for (const file of event.spec.files ?? []) {
            if (!/\.(?:harvest-)?prompt$/.test(file.path)) continue;
            out(`  ┆ ${basename(file.path)}:`);
            for (const line of file.content.split('\n')) out(`  ┆   ${line}`);
          }
        }
        return;
      }
      case 'step:artifact': return out(`  ✔ artifact ${event.path}`);
      case 'step:verdict': return out(`  verdict: ${event.verdict.toUpperCase()}`);
      case 'step:progress': {
        const { progress } = event;
        if (progress.kind === 'tool') {
          return out(`  ${progressActionText(progress)}`);
        }
        if (progress.kind === 'usage') {
          const tally = tallies.get(event.stepId);
          if (tally === undefined) return;
          tallies.set(event.stepId, mergeUsage(tally, progress));
        }
        // Prose is deliberately dropped: it would drown the terminal.
        return;
      }
      case 'step:done': {
        const tally = tallies.get(event.stepId);
        if (tally === undefined) return;
        tallies.delete(event.stepId);
        return out(summary(tally, now()));
      }
      case 'step:manual': return; // the prompt itself is the rendering, on stderr
      case 'step:manual-resolved': return out(`  ↳ ${event.choice}`);
      case 'loop:start': {
        const label = nestedPrefix(
          event.loopId, event.parentLoopId, event.parentIteration, event.outerLoops, event.parentStage);
        return out(`↻ loop ${label} (up to ${event.maxIterations} iterations)`);
      }
      case 'loop:iteration': {
        const label = nestedPrefix(
          event.loopId, event.parentLoopId, event.parentIteration, event.outerLoops, event.parentStage);
        return out(`↻ ${label} — iteration ${event.iteration}/${event.maxIterations}`);
      }
      case 'loop:done': {
        const label = nestedPrefix(
          event.loopId, event.parentLoopId, event.parentIteration, event.outerLoops, event.parentStage);
        return out(event.passed
          ? `↻ ${label} passed after ${event.iterations} iteration(s)`
          : `↻ ${label} exhausted after ${event.iterations} iteration(s)`);
      }
      case 'stages:start':
        return out(`▤ stages ${event.id} (${event.total} stages)`);
      case 'stages:item':
        // Position tracked so 'stages:accepted' (which carries only a
        // stageId, not the index/total) can still say "stage 3/7 accepted"
        // rather than repeating the raw stage id.
        stagePositions.set(event.id, { index: event.index, total: event.total });
        return out(`▤ ${event.id} — stage ${event.index}/${event.total}: ${event.title}`
          + (event.attempt > 1 ? ` (attempt ${event.attempt})` : ''));
      case 'stages:accepted': {
        const pos = stagePositions.get(event.id);
        return out(`▤ ${event.id} — stage ${pos ? `${pos.index}/${pos.total}` : event.stageId} accepted`);
      }
      case 'stages:exhausted':
        return out(`▤ ${event.id} — stage '${event.stageId}' rejected after ${event.attempts} attempt(s), `
          + 'handed to a human');
      case 'stages:done':
        return out(`▤ ${event.id} finished ${event.completed} stages`);
      case 'guard:warning': return err(`  ⚠ ${event.message}`);
      // Invariant 7: a capability that degraded is *shown*, not just logged. Held
      // until the run ends so they read as a summary rather than as noise between
      // steps; one that arrives after the end (a failed prune, at teardown) is
      // printed as it comes, since nothing later will.
      case 'run:degraded': {
        if (runEnded) return err(`  ⚠ degraded: ${degradationLine(event)}`);
        degraded.push(event);
        return;
      }
      case 'run:error': return err(`✘ ${event.message}`);
      case 'run:cancelled': return out('✖ run cancelled');
      case 'run:done': {
        runEnded = true;
        out(event.ok ? '✔ run complete' : '✘ run failed');
        for (const d of degraded) err(`  ⚠ degraded: ${degradationLine(d)}`);
        return;
      }
    }
  };
}
