#!/usr/bin/env node
import { migrateLegacyStateDirs } from '@whiphand/core';
import { buildProgram } from './program.ts';

// Deliberately not top-level await: this file is bundled to CommonJS for the
// standalone binary (Node rejects an ESM main for a single executable
// application), and CommonJS has no top-level await. The catch replaces what
// the unhandled-rejection path did for free.
//
// `process.argv` needs no adjustment inside a single executable: Node supplies
// [execPath, argv0, ...args] there, the same two leading entries commander's
// default `from: 'node'` expects. Verified against a real SEA build.
// The CLI reaches global config without going through the agent, so it carries
// its own copy of the pre-rebrand state move. Two stat calls once the move has
// happened, and it never rejects, so chaining it ahead of the parse costs
// nothing measurable even on `whiphand --version`.
migrateLegacyStateDirs()
  .then(() => buildProgram().parseAsync(process.argv))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
