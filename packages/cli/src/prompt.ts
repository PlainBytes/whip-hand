/**
 * The CLI's half of the "ask a human" seam.
 *
 * Core builds the question (`ManualRequest`) and never touches a terminal;
 * this is the terminal. Everything here writes to **stderr**, not stdout, so
 * `whiphand run --json` keeps emitting nothing but NDJSON on stdout even while a
 * step is waiting on somebody.
 */
import { createInterface } from 'node:readline/promises';
import type { ManualRequest, ManualResponse, Workflow } from '@whiphand/core';

export interface PromptOptions {
  /** `whiphand run --yes`: resolve manual steps to their default instead of asking. */
  yes: boolean;
  /** Overridable for tests; production reads the real terminal. */
  isTty?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

const AUTO_NOTE = '(auto-approved by --yes; no note provided)';

function out(opts: PromptOptions): NodeJS.WritableStream {
  return opts.output ?? process.stderr;
}

function isTty(opts: PromptOptions): boolean {
  return opts.isTty ?? Boolean(process.stdin.isTTY);
}

type Ask = (question: string) => Promise<string>;

/**
 * One readline interface per prompting session, not per question: a fresh
 * interface for every question loses whatever the previous one had buffered
 * from the same stream. It is closed as soon as the session ends, so it never
 * holds stdin while an interactive step wants the real terminal.
 */
async function withReadline<T>(opts: PromptOptions, body: (ask: Ask) => Promise<T>): Promise<T> {
  const rl = createInterface({
    input: opts.input ?? process.stdin,
    output: out(opts),
    terminal: false,
  });
  try {
    return await body(async question => {
      out(opts).write(question);
      try {
        return (await rl.question('')).trim();
      } catch (e) {
        // stdin ran out mid-question (a piped run that was expected to be
        // interactive). Say that, rather than surfacing ERR_USE_AFTER_CLOSE.
        if ((e as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') {
          throw new Error('input ended while waiting for an answer');
        }
        throw e;
      }
    });
  } finally {
    rl.close();
  }
}

function renderRequest(request: ManualRequest, write: (s: string) => void): void {
  write(`\n── ${request.kind === 'approval' ? 'Decision' : 'Manual step'}: ${request.title}\n`);
  if (request.stage) {
    const { index, total, title, stagesId, attempt } = request.stage;
    write(`   stage ${index}/${total} '${title}' of '${stagesId}'${attempt > 1 ? ` (attempt ${attempt})` : ''}\n`);
  } else if (request.loop) {
    write(`   iteration ${request.loop.iteration}/${request.loop.maxIterations} of '${request.loop.id}'\n`);
  }
  write(`\n${request.instructions.trimEnd()}\n`);
  if (request.context.artifacts.length > 0) {
    write('\nArtifacts to read first:\n');
    for (const a of request.context.artifacts) write(`  - ${a.id}: ${a.path}\n`);
  }
  if (request.context.diff) {
    write(`\nWorking tree diff:\n${request.context.diff.trimEnd()}\n`);
  }
}

const CHOICE_LABEL: Record<string, string> = {
  continue: 'continue', retry: 'retry', abort: 'abort',
};

/** Builds the `Frontend.runManual` the CLI hands to core. */
export function createManualPrompt(
  opts: PromptOptions,
): (request: ManualRequest) => Promise<ManualResponse> {
  return async function runManual(request: ManualRequest): Promise<ManualResponse> {
    const write = (s: string) => { out(opts).write(s); };

    if (!isTty(opts)) {
      if (!opts.yes) {
        throw new Error(
          `manual step '${request.stepId}' needs a human — run it on a terminal, or pass --yes ` +
          `to take its default ('${request.defaultChoice}')`);
      }
      write(`⚠ auto-resolving ${request.kind} step '${request.stepId}' as ` +
        `'${request.defaultChoice}' (--yes)\n`);
      return {
        choice: request.defaultChoice,
        ...(request.capture?.requiredFor.includes(request.defaultChoice) ? { note: AUTO_NOTE } : {}),
      };
    }

    renderRequest(request, write);

    const keys = new Map<string, ManualResponse['choice']>();
    for (const choice of request.choices) keys.set(choice[0], choice);
    const menu = request.choices
      .map(c => `[${c[0]}]${CHOICE_LABEL[c].slice(1)}`)
      .join(' / ');

    return withReadline(opts, async ask => {
      let choice: ManualResponse['choice'] | undefined;
      while (choice === undefined) {
        const answer = await ask(`\n${menu} (default: ${request.defaultChoice}) > `);
        if (answer.length === 0) { choice = request.defaultChoice; break; }
        choice = keys.get(answer[0].toLowerCase());
        if (choice === undefined) write(`  not one of: ${request.choices.join(', ')}\n`);
      }

      if (choice !== 'abort' && request.capture) {
        const { label, requiredFor } = request.capture;
        const required = requiredFor.includes(choice);
        let note = '';
        while (note.length === 0) {
          note = await ask(`${label}: `);
          if (note.length === 0 && !required) break;
          if (note.length === 0) write('  a note is required for this step\n');
        }
        return { choice, note };
      }
      return { choice };
    });
  };
}

/**
 * Prompts for any missing required workflow input, using the same `prompt:`
 * text the desktop renders as a form field.
 */
export async function promptMissingInputs(
  workflow: Workflow, given: Record<string, string>, opts: PromptOptions,
): Promise<Record<string, string>> {
  const resolved = { ...given };
  if (!isTty(opts)) return resolved;
  const missing = Object.entries(workflow.inputs ?? {}).filter(
    ([key, def]) => resolved[key] === undefined && def.default === undefined && def.required);
  if (missing.length === 0) return resolved;

  return withReadline(opts, async ask => {
    for (const [key, def] of missing) {
      const label = def.prompt ?? `input '${key}'`;
      let value = '';
      while (value.length === 0) {
        value = await ask(`${label} > `);
        if (value.length === 0) out(opts).write(`  '${key}' is required\n`);
      }
      resolved[key] = value;
    }
    return resolved;
  });
}
